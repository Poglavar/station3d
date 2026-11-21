// Run the production warmup generator through the real frame queue, including
// delayed shader completion, first-use bindings, cancellation and failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createQueuedShaderWarmup } from '../core/queued-shader-warmup.js';
import { resetFrameChunkObserver, setFrameChunkSchedulerMode } from '../core/frame-chunk-queue.js';
import { getBackgroundActivitySnapshot } from '../core/background-activity.js';

function fixture({ hold = false, failBindings = false, patched = false } = {}) {
    const original = Object.fromEntries(['performance', 'requestAnimationFrame', 'cancelAnimationFrame']
        .map(key => [key, globalThis[key]]));
    const frames = new Map(), events = [], properties = new WeakMap(), programs = new Map();
    let now = 0, nextId = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.performance = { now: () => now };
    globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    setFrameChunkSchedulerMode('legacy'); resetFrameChunkObserver();
    const root = new THREE.Group(), material = new THREE.MeshStandardMaterial();
    if (patched) {
        const liveUniforms = {}; liveUniforms.owner = liveUniforms;
        material.userData = { programFamily: 'fixture-patched-v1', liveShaders: [liveUniforms] };
        material.onBeforeCompile = function (shader) { shader.__fixturePatch = this.userData.programFamily; };
        material.customProgramCacheKey = function () { return this.userData.programFamily; };
    }
    const ordinary = new THREE.BoxGeometry(), morph = ordinary.clone();
    morph.morphAttributes.position = [morph.attributes.position.clone()];
    root.add(new THREE.Mesh(ordinary, material), new THREE.Mesh(morph, material));
    material.addEventListener('dispose', () => events.push('original-disposed'));
    const renderer = {
        properties: { get: material => properties.get(material) },
        async compileAsync(root) {
            root.traverse(object => {
                if (!object.material) return;
                assert.notEqual(object.material, material, 'compiler must own its material through teardown');
                if (patched) {
                    const shader = {};
                    object.material.onBeforeCompile?.(shader, renderer);
                    assert.equal(shader.__fixturePatch, 'fixture-patched-v1');
                    assert.equal(object.material.customProgramCacheKey?.(), 'fixture-patched-v1');
                    assert.notEqual(object.material.userData, material.userData);
                    assert.equal(object.material.userData.liveShaders, material.userData.liveShaders,
                        'live renderer state is borrowed, never serialized into another material');
                }
                let state = properties.get(object.material);
                if (!state) {
                    state = { programs: new Map() }; properties.set(object.material, state);
                    object.material.addEventListener('dispose', () => events.push('clone-disposed'));
                }
                const key = object.geometry.morphAttributes.position ? 'morph' : 'ordinary';
                let program = programs.get(key);
                if (!program) {
                    program = { linked: false,
                        isReady() { return this.linked; },
                        getUniforms() {
                            assert.equal(this.linked, true, 'never initialize bindings before async completion');
                            if (failBindings) throw new Error('binding fixture failed');
                            events.push('uniforms:' + key);
                        },
                        getAttributes() { events.push('attributes:' + key); },
                    };
                    programs.set(key, program);
                }
                state.programs.set(key, program);
                events.push('compile:' + key);
            });
            if (hold) await gate;
            for (const program of programs.values()) program.linked = true;
        },
    };
    const state = createQueuedShaderWarmup(root, {
        renderer, camera: new THREE.PerspectiveCamera(), targetScene: new THREE.Scene(), label: 'warmup-fixture',
    });
    return { state, root, events, material, release,
        async frame() {
            const callbacks = [...frames.values()]; frames.clear();
            const before = events.length;
            for (const callback of callbacks) callback();
            now += 1000 / 60;
            await Promise.resolve(); await Promise.resolve();
            return events.slice(before);
        },
        async close() {
            release(); await state.dispose();
            ordinary.dispose(); morph.dispose(); material.dispose();
            resetFrameChunkObserver(); setFrameChunkSchedulerMode(null);
            for (const [key, value] of Object.entries(original)) {
                if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
            }
        },
    };
}

test('owned clones preserve shader patch hooks and cache identity through disposal fence', async () => {
    const f = fixture({ hold: true, patched: true });
    try {
        await f.frame();
        f.material.dispose();
        assert.equal(f.events.includes('original-disposed'), true);
        assert.equal(f.state.ready, false);
        f.release();
        for (let frame = 0; frame < 12 && !f.state.ready; frame++) await f.frame();
        assert.equal(f.state.ready, true);
        assert.equal(f.state.error, null);
    } finally { await f.close(); }
});

test('warmup includes morph and ordinary bindings, one program per frame, and keeps their leases', async () => {
    const f = fixture();
    try {
        for (let frame = 0; frame < 20 && !f.state.ready; frame++) {
            const events = await f.frame();
            assert.ok(events.filter(event => event.startsWith('compile:')).length <= 1);
            assert.ok(events.filter(event => event.startsWith('uniforms:')).length <= 1);
        }
        assert.equal(f.state.ready, true);
        assert.equal(await f.state.completion, f.state);
        assert.equal(getBackgroundActivitySnapshot().some(entry => entry.label === 'warmup-fixture'), false);
        assert.deepEqual(f.events.filter(event => event.startsWith('uniforms:')), ['uniforms:ordinary', 'uniforms:morph']);
        assert.deepEqual(f.events.filter(event => event.startsWith('attributes:')), ['attributes:ordinary', 'attributes:morph']);
        assert.equal(f.root.children.length, 0);
        assert.equal(f.events.includes('clone-disposed'), false, 'rare shader variants stay retained until session stop');
        await f.state.dispose(); await f.state.dispose();
        assert.equal(f.events.filter(event => event === 'clone-disposed').length, 1, 'one clone for the shared material');
        assert.equal(f.events.includes('original-disposed'), false, 'the warmup does not own live actor materials');
    } finally { await f.close(); }
});

test('an unfinished shader blocks readiness and cancellation fences cloned-material disposal', async () => {
    const f = fixture({ hold: true });
    try {
        await f.frame(); await f.frame();
        assert.equal(f.state.ready, false);
        assert.equal(getBackgroundActivitySnapshot().find(entry => entry.label === 'warmup-fixture')?.pending, 1);
        const stopped = f.state.dispose();
        assert.equal((await f.state.completion).closed, true);
        assert.equal(getBackgroundActivitySnapshot().some(entry => entry.label === 'warmup-fixture'), false);
        f.material.dispose(); // real session teardown can safely release its original assets now
        assert.equal(f.events.includes('clone-disposed'), false);
        assert.equal(f.events.some(event => event.startsWith('uniforms:')), false);
        f.release(); await stopped;
        assert.equal(f.events.filter(event => event === 'clone-disposed').length, 1);
        assert.equal(f.state.ready, false, 'a late fence cannot revive a stopped session');
        assert.equal(f.root.children.length, 0);
    } finally { await f.close(); }
});

test('a first-use binding failure stays observable and never admits an unprepared population', async () => {
    const f = fixture({ failBindings: true }), errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    try {
        for (let frame = 0; frame < 20 && !f.state.error; frame++) await f.frame();
        assert.match(f.state.error?.message || '', /binding fixture failed/);
        assert.equal((await f.state.completion).error, f.state.error);
        assert.equal(f.state.ready, false);
        assert.equal(getBackgroundActivitySnapshot().find(entry => entry.label === 'warmup-fixture')?.buildFailed, 1,
            'a failed warmup must poison world-readiness validation, not disappear as an empty queue');
        assert.ok(errors.some(error => error.includes('binding fixture failed')));
    } finally { console.error = originalError; await f.close(); }
});
