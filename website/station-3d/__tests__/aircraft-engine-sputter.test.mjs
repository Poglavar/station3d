// The engine-failure cue: two coughs and a wheeze, scheduled once against a
// fake AudioContext, and the engine loop that stutters and winds down under
// it exactly once per failure, never on a checkpoint resumed engine-out.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SPUTTER_DURATION_S,
    SPUTTER_POP_TIMES_S,
    SPUTTER_PUFFS,
    playAircraftEngineSputterSfx,
    scheduleAircraftEngineSputterSfx,
} from '../ui/aircraft-engine-sputter-sfx.js';
import { applyPose, setAircraftEngineFilmMix } from '../ui/gta-special-vehicle-audio.js';

function fakeParam(initial = 1) {
    const calls = [];
    return {
        value: initial,
        calls,
        setValueAtTime(value, at) { calls.push(['set', value, at]); },
        exponentialRampToValueAtTime(value, at) { calls.push(['exp', value, at]); },
        setTargetAtTime(value, at, constant) { calls.push(['target', value, at, constant]); },
        setValueCurveAtTime(values, at, duration) { calls.push(['curve', Array.from(values), at, duration]); },
        cancelScheduledValues(at) { calls.push(['cancel', at]); },
    };
}

function fakeContext({ currentTime = 10, state = 'running' } = {}) {
    const nodes = [];
    const node = (kind, extra = {}) => {
        const created = {
            kind,
            connections: [],
            disconnected: false,
            started: null,
            stopped: null,
            connect(target) { this.connections.push(target); },
            disconnect() { this.disconnected = true; },
            start(at) { this.started = at; },
            stop(at) { this.stopped = at; },
            ...extra,
        };
        nodes.push(created);
        return created;
    };
    return {
        currentTime,
        state,
        sampleRate: 48000,
        nodes,
        createGain: () => node('gain', { gain: fakeParam(1) }),
        createOscillator: () => node('oscillator', { frequency: fakeParam(440), type: 'sine' }),
        createBiquadFilter: () => node('filter', { frequency: fakeParam(350), Q: fakeParam(1), type: 'lowpass' }),
        createBuffer: (channels, length, sampleRate) => ({
            channels, length, sampleRate,
            data: new Float32Array(length),
            getChannelData() { return this.data; },
        }),
        createBufferSource: () => node('buffer', { buffer: null, loop: false, onended: null }),
    };
}

test('the sputter schedules its pops and puffs up front through the managed output and cleans up after itself', () => {
    const ctx = fakeContext({ currentTime: 10 });
    const destination = { name: 'managed-output' };
    const cue = scheduleAircraftEngineSputterSfx(ctx, destination);
    assert.equal(cue.durationS, SPUTTER_DURATION_S);
    const output = ctx.nodes.find(node => node.kind === 'gain' && node.connections.includes(destination));
    assert.ok(output, 'one output gain into the managed destination');
    assert.ok(output.gain.value > 0 && output.gain.value <= 0.34);
    const pops = ctx.nodes.filter(node => node.kind === 'oscillator');
    assert.equal(pops.length, SPUTTER_POP_TIMES_S.length);
    assert.deepEqual(pops.map(pop => pop.started), SPUTTER_POP_TIMES_S.map(atS => 10 + atS));
    assert.ok(pops.every(pop => pop.type === 'triangle' && pop.stopped > pop.started && pop.stopped - pop.started < 0.2));
    // Each pop falls in pitch: a misfire, not a tone.
    for (const pop of pops) {
        const [set, ramp] = pop.frequency.calls;
        assert.equal(set[0], 'set');
        assert.equal(ramp[0], 'exp');
        assert.ok(ramp[1] < set[1]);
    }
    const puffs = ctx.nodes.filter(node => node.kind === 'buffer');
    assert.equal(puffs.length, SPUTTER_PUFFS.length);
    assert.ok(puffs.every(puff => puff.buffer?.length === Math.floor(48000 * 0.6)), 'one shared noise buffer');
    assert.ok(puffs.every(puff => !puff.loop));
    const filters = ctx.nodes.filter(node => node.kind === 'filter');
    assert.deepEqual(filters.map(filter => filter.type), SPUTTER_PUFFS.map(puff => puff.type));
    assert.ok(filters.at(-1).frequency.calls.some(call => call[0] === 'exp'), 'the last wheeze sweeps down');
    const latest = Math.max(...pops.map(pop => pop.stopped), ...puffs.map(puff => puff.stopped));
    assert.ok(latest <= 10 + SPUTTER_DURATION_S + 0.05, `the cue is bounded (${latest})`);
    // Everything hangs off the output; the graph releases itself when the last puff ends.
    for (const node of ctx.nodes) {
        if (node === output) continue;
        assert.ok(node.connections.length === 1, `${node.kind} routed once`);
    }
    assert.equal(typeof puffs.at(-1).onended, 'function');
    puffs.at(-1).onended();
    assert.ok(ctx.nodes.every(node => node.disconnected), 'all nodes disconnected after the cue');
    // A second cleanup is harmless, and an early stop silences immediately.
    cue.stop();
    const again = scheduleAircraftEngineSputterSfx(fakeContext(), destination);
    again.stop();
});

test('the sputter refuses to schedule without an unlocked, running context', () => {
    const unlocked = fakeContext({ state: 'running' });
    const muted = playAircraftEngineSputterSfx({ createContext: () => unlocked, destinationFor: () => ({}), muted: () => true });
    assert.equal(muted, null);
    assert.equal(unlocked.nodes.length, 0);
    // The player caches one context; a suspended one stays silent until it is
    // closed and replaced (browsers resume asynchronously, never in this call).
    const suspended = fakeContext({ state: 'suspended' });
    assert.equal(playAircraftEngineSputterSfx({ createContext: () => suspended, destinationFor: () => ({}), muted: () => false }), null);
    assert.equal(suspended.nodes.length, 0);
    suspended.state = 'closed';
    const live = fakeContext({ state: 'running' });
    const cue = playAircraftEngineSputterSfx({ createContext: () => live, destinationFor: () => ({ live: true }), muted: () => false });
    assert.ok(cue);
    assert.ok(live.nodes.length > 0);
    assert.equal(scheduleAircraftEngineSputterSfx(null, {}), null);
    assert.equal(scheduleAircraftEngineSputterSfx({ createGain() {} }, {}), null, 'a context without the whole node set schedules nothing');
});

function fakeEngineGraph({ currentTime = 4 } = {}) {
    const ctx = fakeContext({ currentTime });
    return {
        ctx,
        kind: 'airplane',
        output: ctx.createGain(),
        voices: { engine: { source: ctx.createBufferSource(), gain: ctx.createGain() } },
        sampleState: 'ready',
        lastEngineFailed: null,
        engineFailure: null,
    };
}

test('a running engine that quits coughs once with a stuttering loop; a resumed dead engine only fades', () => {
    const graph = fakeEngineGraph();
    graph.voices.engine.source.playbackRate = fakeParam(1);
    const nodesBefore = graph.ctx.nodes.length;
    applyPose(graph, { throttle: 0.5, speedMps: 62, engineFailed: false });
    assert.equal(graph.lastEngineFailed, false);
    assert.equal(graph.engineFailure, null);
    assert.equal(graph.ctx.nodes.length, nodesBefore, 'a running engine schedules no cue');

    applyPose(graph, { throttle: 0, speedMps: 60, engineFailed: true });
    assert.ok(graph.engineFailure?.sputter, 'the failure cue is scheduled');
    assert.ok(graph.ctx.nodes.length > nodesBefore);
    const rate = graph.voices.engine.source.playbackRate.calls;
    const curve = rate.find(call => call[0] === 'curve');
    assert.ok(curve, 'the loop stutters on a value curve');
    assert.ok(curve[1][0] > 1 && curve[1].at(-1) < 0.3, 'catching first, windmilling last');
    assert.equal(curve[3], 2.4);
    const fade = graph.voices.engine.gain.gain.calls.find(call => call[0] === 'target' && call[1] === 0);
    assert.ok(fade && fade[2] > graph.ctx.currentTime + 1, 'the loop only fades once the coughing is over');

    const nodesAfterFailure = graph.ctx.nodes.length;
    const callsAfterFailure = rate.length;
    applyPose(graph, { throttle: 0, speedMps: 50, engineFailed: true });
    applyPose(graph, { throttle: 0, speedMps: 40, engineFailed: true });
    assert.equal(graph.ctx.nodes.length, nodesAfterFailure, 'the cue plays once per failure');
    assert.equal(rate.length, callsAfterFailure, 'later dead-engine poses leave the automation alone');

    const resumed = fakeEngineGraph();
    resumed.voices.engine.source.playbackRate = fakeParam(1);
    const resumedNodes = resumed.ctx.nodes.length;
    applyPose(resumed, { throttle: 0, speedMps: 36, engineFailed: true });
    assert.equal(resumed.engineFailure?.sputter, undefined, 'an engine that was already dead never coughs');
    assert.equal(resumed.ctx.nodes.length, resumedNodes);
    assert.ok(resumed.voices.engine.gain.gain.calls.some(call => call[0] === 'target' && call[1] === 0));
});

test('a film scales the running engine and hands it back untouched', () => {
    const graph = fakeEngineGraph();
    graph.voices.engine.source.playbackRate = fakeParam(1);
    const pose = { throttle: 0.5, speedMps: 62, engineFailed: false };
    const lastTarget = param => param.calls.filter(call => call[0] === 'target').at(-1)[1];
    applyPose(graph, pose);
    const flownGain = lastTarget(graph.voices.engine.gain.gain);
    const flownRate = lastTarget(graph.voices.engine.source.playbackRate);
    setAircraftEngineFilmMix({ gainScale: 0.3, rateScale: 1.2 });
    try {
        applyPose(graph, pose);
        assert.ok(Math.abs(lastTarget(graph.voices.engine.gain.gain) - flownGain * 0.3) < 1e-9, 'held under the narration');
        assert.ok(Math.abs(lastTarget(graph.voices.engine.source.playbackRate) - flownRate * 1.2) < 1e-9, 'pitched by the flyby');
    } finally {
        setAircraftEngineFilmMix(null);
    }
    applyPose(graph, pose);
    assert.ok(Math.abs(lastTarget(graph.voices.engine.gain.gain) - flownGain) < 1e-9, 'the flown level again after the film');
});
