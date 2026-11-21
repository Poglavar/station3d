// The overlay's answer to "is this the code, or is this machine busy?"
//
// Two slowdowns in one session were investigated as code regressions and turned
// out to be background load on the laptop. Everything here exists so the next
// one announces itself instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BUSY_RATIO,
    createHostLoadState,
    describeHostBlame,
    describeHostLoad,
    hostLoadVerdict,
    MIN_SAMPLES_FOR_VERDICT,
    OVERLOADED_RATIO,
    recordProbeSample,
    runContentionProbe,
} from '../core/host-load.js';

const feed = (samples) => samples.reduce(recordProbeSample, createHostLoadState());

test('says nothing until the baseline has settled', () => {
    // A verdict from one sample is a verdict against itself: ratio 1.0, always
    // "clean", which would quietly certify a contended machine as fine.
    assert.equal(hostLoadVerdict(createHostLoadState()).level, 'unknown');
    assert.equal(hostLoadVerdict(feed([1.0])).level, 'unknown');
    assert.equal(hostLoadVerdict(feed([1.0, 5.0])).level, 'unknown');
    assert.equal(feed([1.0, 5.0]).samples, 2);
    assert.equal(hostLoadVerdict(feed([1.0, 1.0, 1.0])).level, 'clean');
});

test('the baseline is the best ever seen, and contention cannot poison it', () => {
    // A rolling average would drift upward under sustained load until a busy
    // machine looked normal again — which is precisely when you need the flag.
    const state = feed([1.0, 0.8, 4.0, 5.0, 6.0]);
    assert.equal(state.bestMs, 0.8, 'best is kept, not averaged away');
    assert.equal(state.lastMs, 6.0);
    const verdict = hostLoadVerdict(state);
    assert.equal(verdict.level, 'overloaded');
    assert.ok(Math.abs(verdict.ratio - 7.5) < 1e-9);
});

test('the three levels sit either side of their thresholds', () => {
    const at = (ratio) => hostLoadVerdict(feed([1, 1, 1, ratio])).level;
    assert.equal(at(1.0), 'clean');
    assert.equal(at(BUSY_RATIO - 0.01), 'clean');
    assert.equal(at(BUSY_RATIO), 'busy');
    assert.equal(at(OVERLOADED_RATIO - 0.01), 'busy');
    assert.equal(at(OVERLOADED_RATIO), 'overloaded');
});

test('contended is exactly "not clean", because that is what gates a reading', () => {
    assert.equal(hostLoadVerdict(feed([1, 1, 1, 1.0])).contended, false);
    assert.equal(hostLoadVerdict(feed([1, 1, 1, 2.0])).contended, true);
    assert.equal(hostLoadVerdict(feed([1, 1, 1, 9.0])).contended, true);
    // Unknown must not read as contended — that would flag every session start.
    assert.equal(hostLoadVerdict(createHostLoadState()).contended, false);
});

test('garbage samples cannot move the baseline', () => {
    const state = feed([1.0, 1.0, 1.0]);
    for (const bad of [null, undefined, NaN, -1, 0, 'busy', Infinity]) {
        assert.deepEqual(recordProbeSample(state, bad), state, `rejected: ${String(bad)}`);
    }
});

test('the readout says what the number means, not just what it is', () => {
    // "×2.4" alone reads as a CPU percentage to anyone who did not write this.
    assert.match(describeHostLoad(hostLoadVerdict(feed([1, 1, 1, 3.0]))).text, /OVERLOADED/);
    assert.equal(describeHostLoad(hostLoadVerdict(feed([1, 1, 1, 3.0]))).tone, 'severe');
    assert.match(describeHostLoad(hostLoadVerdict(feed([1, 1, 1, 2.0]))).text, /busy/);
    assert.equal(describeHostLoad(hostLoadVerdict(feed([1, 1, 1, 2.0]))).tone, 'warn');
    assert.match(describeHostLoad(hostLoadVerdict(feed([1, 1, 1, 1.0]))).text, /clean/);
    assert.equal(describeHostLoad(hostLoadVerdict(createHostLoadState())).text, 'calibrating…');
});

test('the probe actually does measurable work and is not optimised away', () => {
    // A probe the JIT elides would report ~0 ms forever, making every machine
    // look permanently clean — a green light that can never turn red.
    const a = runContentionProbe();
    const b = runContentionProbe(1);
    assert.ok(Number.isFinite(a.elapsedMs) && a.elapsedMs >= 0);
    assert.equal(typeof a.checksum, 'number');
    assert.notEqual(a.checksum, b.checksum, 'iteration count must change the result');
    // Deterministic: the same input gives the same checksum, so a differing
    // reading is time, never the work itself varying.
    assert.equal(runContentionProbe(1000).checksum, runContentionProbe(1000).checksum);
});

test('the int32 probe preserves the original workload checksum including overflow', () => {
    function originalChecksum(iterations) {
        let acc = 1;
        for (let i = 1; i <= iterations; i++) {
            acc = (acc * 31 + i) | 0;
            acc ^= acc >>> 7;
        }
        return acc;
    }
    for (const iterations of [0, 1, 10, 1000, 100000, 2000000]) {
        assert.equal(runContentionProbe(iterations).checksum, originalChecksum(iterations));
    }
});

test('MIN_SAMPLES_FOR_VERDICT is honoured as configured, not hardcoded', () => {
    assert.ok(MIN_SAMPLES_FOR_VERDICT >= 2);
    const state = feed([1.0, 3.0]);
    assert.equal(hostLoadVerdict(state, { minSamples: 2 }).level, 'overloaded');
    assert.equal(hostLoadVerdict(state, { minSamples: 5 }).level, 'unknown');
});

// ── Naming the culprit (energy-manager's /load.json) ─────────────────────────

test('the blame line reads as a fraction of the machine, not a raw percentage', () => {
    // busyPct is summed %cpu across all processes, so on 8 cores it runs to ~800.
    // Printing it raw would read as "365% busy", which is meaningless.
    const text = describeHostBlame({
        busyPct: 365.9, cores: 8,
        top: [{ cpu: 85.6, name: 'Chrome GPU' }, { cpu: 75.2, name: 'Chrome tab' }],
    });
    assert.match(text, /46% of 8 cores/);
    assert.match(text, /Chrome GPU 86%/);
    assert.match(text, /Chrome tab 75%/);
});

test('a missing or unreachable energy-manager degrades to nothing, never to a lie', () => {
    // The endpoint is optional. Anything unusable must yield null so the overlay
    // shows the contention ratio alone rather than an empty or invented name.
    assert.equal(describeHostBlame(null), null);
    assert.equal(describeHostBlame({}), null);
    assert.equal(describeHostBlame({ top: [] }), null);
    assert.equal(describeHostBlame({ top: [{ name: 'x' }] }), null, 'no cpu figure is not a reading');
    assert.equal(describeHostBlame({ top: [{ cpu: 5 }] }), null, 'no name is not a culprit');
    // Cores missing: still name names, just without the machine fraction.
    const partial = describeHostBlame({ top: [{ cpu: 40, name: 'ffmpeg' }] });
    assert.equal(partial, 'ffmpeg 40%');
});
