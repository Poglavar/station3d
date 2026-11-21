// Guards the fireworks clip set (real MP3s with a CC0 provenance trail) and
// the playback graph: delayed start, clamped gain/rate/pan, managed output.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FIREWORKS_SFX_FILES, fireworksClipCount, scheduleFireworkClip } from '../ui/fireworks-sfx.js';

const audioDirectory = new URL('../audio/sfx/fireworks/', import.meta.url);

function isMp3(bytes) {
    if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

test('every referenced fireworks clip exists as MP3 and is listed in SOURCES.md as CC0', async () => {
    const sources = await readFile(new URL('SOURCES.md', audioDirectory), 'utf8');
    assert.match(sources, /CC0/);
    assert.match(sources, /opengameart\.org\/content\/25-cc0-bang-firework-sfx/);
    assert.match(sources, /freesound\.org\/s\/140728/);
    const files = Object.values(FIREWORKS_SFX_FILES).flat();
    assert.ok(files.length >= 9);
    for (const url of files) {
        const name = url.split('/').pop();
        const bytes = await readFile(new URL(name, audioDirectory));
        assert.ok(isMp3(bytes), `${name} is not an MP3`);
        assert.ok(bytes.length > 5_000 && bytes.length < 200_000, `${name} bytes=${bytes.length}`);
        assert.ok(sources.includes(`| ${name} |`), `${name} has no SOURCES.md row`);
    }
    assert.equal(fireworksClipCount('burst'), FIREWORKS_SFX_FILES.burst.length);
    assert.equal(fireworksClipCount('missing'), 0);
});

function fakeContext({ withPanner = true } = {}) {
    const nodes = [];
    const ctx = {
        currentTime: 12.5,
        nodes,
        createBufferSource() {
            const node = {
                kind: 'source', buffer: null, playbackRate: { value: 1 }, startedAt: null,
                connect(target) { this.target = target; return target; },
                start(at) { this.startedAt = at; },
            };
            nodes.push(node);
            return node;
        },
        createGain() {
            const node = { kind: 'gain', gain: { value: 1 }, connect(target) { this.target = target; return target; } };
            nodes.push(node);
            return node;
        },
    };
    if (withPanner) {
        ctx.createStereoPanner = () => {
            const node = { kind: 'panner', pan: { value: 0 }, connect(target) { this.target = target; return target; } };
            nodes.push(node);
            return node;
        };
    }
    return ctx;
}

test('a clip starts after its distance delay with clamped gain, rate and pan, into the managed output', () => {
    const ctx = fakeContext();
    const destination = { kind: 'destination' };
    const buffer = { duration: 1.2 };
    const result = scheduleFireworkClip(ctx, destination, buffer, { delayS: 0.7, gain: 1.8, playbackRate: 3, pan: -4 });
    assert.ok(result);
    const source = ctx.nodes.find(node => node.kind === 'source');
    const gain = ctx.nodes.find(node => node.kind === 'gain');
    const panner = ctx.nodes.find(node => node.kind === 'panner');
    assert.equal(source.buffer, buffer);
    assert.ok(Math.abs(source.startedAt - 13.2) < 1e-9, 'start = currentTime + delay');
    assert.equal(result.startAt, source.startedAt);
    assert.equal(source.playbackRate.value, 1.6);
    assert.equal(gain.gain.value, 1);
    assert.equal(panner.pan.value, -1);
    assert.equal(source.target, gain);
    assert.equal(gain.target, panner);
    assert.equal(panner.target, destination);

    const late = scheduleFireworkClip(ctx, destination, buffer, { delayS: 40 });
    assert.ok(Math.abs(late.startAt - (12.5 + 4)) < 1e-9, 'delays are capped so a stray cue cannot fire a minute later');
    const negative = scheduleFireworkClip(ctx, destination, buffer, { delayS: -3, gain: -1 });
    assert.equal(negative.startAt, 12.5);
    assert.equal(ctx.nodes.filter(node => node.kind === 'gain').at(-1).gain.value, 0);
});

test('without a stereo panner the clip is centred and still reaches the destination', () => {
    const ctx = fakeContext({ withPanner: false });
    const destination = { kind: 'destination' };
    assert.ok(scheduleFireworkClip(ctx, destination, { duration: 1 }, { pan: 0.9 }));
    const gain = ctx.nodes.find(node => node.kind === 'gain');
    assert.equal(gain.target, destination);
    assert.equal(scheduleFireworkClip(ctx, destination, null), null);
    assert.equal(scheduleFireworkClip(null, destination, { duration: 1 }), null);
});
