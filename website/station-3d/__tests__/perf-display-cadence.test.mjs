// Regression coverage for detecting compositor/display throttling before a run.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_PERF_DISPLAY_HZ,
    summarizePerfDisplayCadence,
} from '../core/perf-display-cadence.js';

test('active 120 Hz and 60 Hz displays are valid timing environments', () => {
    const fast = summarizePerfDisplayCadence(Array(60).fill(8.33));
    const laptop = summarizePerfDisplayCadence(Array(60).fill(16.67));

    assert.equal(fast.valid, true);
    assert.ok(fast.medianHz > 119);
    assert.equal(laptop.valid, true);
    assert.ok(laptop.medianHz > MIN_PERF_DISPLAY_HZ);
});

test('a sleeping or compositor-throttled 30 Hz browser is rejected', () => {
    const cadence = summarizePerfDisplayCadence(Array(60).fill(33.3));

    assert.equal(cadence.valid, false);
    assert.ok(Math.abs(cadence.medianHz - 30.03) < 0.1);
});

test('jitter is summarized without letting malformed intervals certify a run', () => {
    const cadence = summarizePerfDisplayCadence([
        16.4, 16.7, 16.8, 17.0, null, NaN, -2, '16.7',
    ]);

    assert.equal(cadence.valid, true);
    assert.equal(cadence.samples, 4);
    assert.ok(cadence.p95IntervalMs > cadence.medianIntervalMs);
    assert.equal(summarizePerfDisplayCadence([null, NaN, 0]).valid, false);
});
