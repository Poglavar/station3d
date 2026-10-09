// Exercise real audio consumers against present and absent compiled package assets.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const ROOT = new URL('../', import.meta.url);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.__station3dAudioTest;
});

const sharedState = `globalThis.__station3dAudioTest ||= {
    paths: [], fetches: [], binds: 0, creates: 0, resumes: 0, unlockWaits: 0,
    sources: 0, oscillators: 0, buffers: 0,
    context: null,
};`;

function makeContextStub() {
    const param = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {},
        linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
    const node = () => ({ connect() { return this; }, disconnect() {}, start() {}, stop() {},
        gain: param(), frequency: param(), Q: param(), pan: param(), playbackRate: param() });
    return {
        currentTime: 0, sampleRate: 1000, destination: {},
        createGain: node,
        createOscillator() { globalThis.__station3dAudioTest.oscillators++; return node(); },
        createBufferSource() { globalThis.__station3dAudioTest.sources++; return node(); },
        createBiquadFilter: node,
        createStereoPanner: node,
        createBuffer(_channels, length) {
            globalThis.__station3dAudioTest.buffers++;
            return { duration: length / 1000, getChannelData: () => new Float32Array(length) };
        },
        decodeAudioData: async () => ({ duration: 1 }),
    };
}

async function loadAudioModule(moduleName, { assetsPresent = false, withContext = false } = {}) {
    globalThis.__station3dAudioTest = {
        paths: [], fetches: [], binds: 0, creates: 0, resumes: 0, unlockWaits: 0,
        sources: 0, oscillators: 0, buffers: 0,
        context: withContext ? makeContextStub() : null,
    };
    const packagedAssets = assetsPresent ? [
        'audio/enemy-music/bella-ciao.mp3',
        'audio/enemy-music/soviet-anthem.mp3',
        'audio/enemy-music/internationale.mp3',
        'audio/sfx/honk/1.mp3', 'audio/sfx/honk/2.mp3', 'audio/sfx/honk/3.mp3',
        'audio/sfx/honk/4.mp3', 'audio/sfx/honk/5.mp3',
        'audio/sfx/siren/police.mp3', 'audio/sfx/siren/ambulance.mp3',
        'audio/sfx/water-wade/deep-mud-loop.mp3', 'audio/sfx/water-wade/entry-splash.mp3',
    ] : [];
    globalThis.window = { __station3DAssetConfig: {
        rootUrl: 'https://assets.test/', baseUrl: 'https://assets.test/',
    } };
    const entry = new URL(`ui/${moduleName}.js`, ROOT).pathname;
    const result = await build({
        entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node',
        define: { __STATION3D_PACKAGED_ASSETS__: JSON.stringify(packagedAssets),
            'import.meta.url': JSON.stringify(new URL('../core/asset-url.js', import.meta.url).href) },
        plugins: [{
            name: 'audio-test-stubs',
            setup(buildApi) {
                buildApi.onResolve({ filter: /core\/audio-unlock\.js$/ }, () => ({
                    path: 'audio-unlock-stub', namespace: 'audio-test',
                }));
                buildApi.onResolve({ filter: /^three$/ }, () => ({
                    path: 'three-stub', namespace: 'audio-test',
                }));
                buildApi.onResolve({ filter: /scene\/setup\.js$/ }, () => ({
                    path: 'scene-stub', namespace: 'audio-test',
                }));
                buildApi.onLoad({ filter: /.*/, namespace: 'audio-test' }, args => {
                    const contents = {
                        'audio-unlock-stub': `${sharedState}
                            export function bindGlobalAudioUnlock() { globalThis.__station3dAudioTest.binds++; }
                            export function createUnlockedAudioContext() {
                                globalThis.__station3dAudioTest.creates++;
                                return globalThis.__station3dAudioTest.context;
                            }
                            export function getAudioDestination(ctx) { return ctx.destination; }
                            export function resumeUnlockedAudioContext() { globalThis.__station3dAudioTest.resumes++; }
                            export function whenAudioUnlocked(callback) {
                                globalThis.__station3dAudioTest.unlockWaits++;
                                return () => {};
                            }`,
                        'three-stub': `export class Vector3 {
                            set() { return this; } setFromMatrixColumn() { return this; }
                            normalize() { return this; } dot() { return 0; }
                        }`,
                        'scene-stub': 'export const camera = null;',
                    }[args.path];
                    return { contents, loader: 'js' };
                });
            },
        }],
    });
    const source = result.outputFiles[0].text;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return import(moduleUrl);
}

function installFetchStub() {
    globalThis.fetch = async url => {
        globalThis.__station3dAudioTest.fetches.push(String(url));
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
}

test('absent optional music, horn, and siren assets trigger no audio setup or fetch', async t => {
    installFetchStub();
    for (const moduleName of ['enemy-music', 'honk-sfx', 'siren-sfx']) {
        await t.test(moduleName, async () => {
            const audio = await loadAudioModule(moduleName);
            if (moduleName === 'enemy-music') {
                assert.equal(audio.getEnemyMusicTrackCount(), 0);
                audio.bindEnemyMusicUnlock();
                audio.queueEnemyMusicSpeaker(1, 2, 3);
                audio.tickEnemyMusic(0.1);
            } else if (moduleName === 'honk-sfx') {
                audio.preloadHonkSfx();
                audio.playHonk();
            } else {
                audio.preloadSirens();
                audio.updateSirens([]);
            }
            assert.equal(globalThis.__station3dAudioTest.fetches.length, 0);
            assert.equal(globalThis.__station3dAudioTest.creates, 0);
            assert.equal(globalThis.__station3dAudioTest.binds, 0);
            assert.equal(globalThis.__station3dAudioTest.unlockWaits, 0);
        });
    }
});

test('present optional honk and siren assets retain their preload fetches', async t => {
    installFetchStub();
    for (const [moduleName, preload, expectedCount] of [
        ['enemy-music', 'bindEnemyMusicUnlock', 3],
        ['honk-sfx', 'preloadHonkSfx', 5],
        ['siren-sfx', 'preloadSirens', 2],
    ]) {
        await t.test(moduleName, async () => {
            const audio = await loadAudioModule(moduleName, { assetsPresent: true, withContext: true });
            audio[preload]();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(globalThis.__station3dAudioTest.fetches.length, expectedCount);
            assert.ok(globalThis.__station3dAudioTest.fetches.every(url => url.startsWith('https://assets.test/')));
        });
    }
});

test('present water clips retain their fetches alongside procedural walk sounds', async () => {
    const audio = await loadAudioModule('walk-audio', { assetsPresent: true, withContext: true });
    installFetchStub();
    audio.startFootsteps();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(globalThis.__station3dAudioTest.fetches.sort(), [
        'https://assets.test/audio/sfx/water-wade/deep-mud-loop.mp3',
        'https://assets.test/audio/sfx/water-wade/entry-splash.mp3',
    ]);
    audio.stopFootsteps();
});

test('missing water clips do not disable synthesized footsteps or jetpack audio', async () => {
    const audio = await loadAudioModule('walk-audio', { withContext: true });
    installFetchStub();
    audio.startFootsteps();
    audio.updateFootsteps(2, 1, false);
    audio.startJetpack();
    audio.updateJetpack(true, 0.1);
    assert.equal(globalThis.__station3dAudioTest.fetches.length, 0);
    assert.ok(globalThis.__station3dAudioTest.oscillators > 0, 'procedural step transient should remain active');
    assert.ok(globalThis.__station3dAudioTest.sources > 0, 'procedural noise and jetpack sources should remain active');
    assert.equal(globalThis.__station3dAudioTest.buffers, 2, 'footstep and jetpack noise buffers remain procedural');
    audio.stopWalkAudio();
});
