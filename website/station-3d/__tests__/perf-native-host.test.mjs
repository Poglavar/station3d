import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeNativeHostWindow } from '../../../tools/lib/perf-native-host.mjs';

const sample = (overrides = {}) => ({
    at: 1000, platform: 'linux', cpus: 8, load1: 4, pageSizeBytes: 4096,
    swapins: 100, swapouts: 50, error: null, ...overrides,
});
const pair = (first = {}, second = {}) => [sample(first), sample({ at: 2000, ...second })];

test('zero swap across a quiet window is accepted and retains interval measurements', () => {
    const result = summarizeNativeHostWindow(pair());
    assert.equal(result.clean, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.samples, 2);
    assert.equal(result.elapsedMs, 1000);
    assert.equal(result.swapInBytes, 0);
    assert.equal(result.swapOutBytes, 0);
    assert.equal(result.peakSwapMiBPerSecond, 0);
    assert.deepEqual(result.intervals, [{ elapsedMs: 1000, swapInBytes: 0, swapOutBytes: 0, swapMiBPerSecond: 0 }]);
});

test('unknown and reset counters fail closed and keep the interval with null deltas', () => {
    const unknown = summarizeNativeHostWindow(pair({}, { swapins: null }));
    assert.equal(unknown.clean, false);
    assert.equal(unknown.swapInBytes, null);
    assert.equal(unknown.intervals.length, 1);
    assert.equal(unknown.intervals[0].swapInBytes, null);

    const reset = summarizeNativeHostWindow(pair({}, { swapins: 10 }));
    assert.equal(reset.clean, false);
    assert.ok(reset.reasons.some(reason => /counter reset or decreased/.test(reason)));
    assert.equal(reset.intervals[0].swapMiBPerSecond, null);
});

test('rejects long sample gaps while preserving their measurable swap deltas', () => {
    const samples = [sample(), sample({ at: 9000, swapins: 101 })];
    const result = summarizeNativeHostWindow(samples);
    assert.equal(result.clean, false);
    assert.ok(result.reasons.some(reason => /sample gap 8000ms exceeds 7500ms/.test(reason)));
    assert.equal(result.intervals[0].swapInBytes, 4096);
    assert.equal(result.intervals[0].swapMiBPerSecond, 4096 / 1024 / 1024 / 8);
});

test('rejects inconsistent page sizes or CPU counts', () => {
    const pageSize = summarizeNativeHostWindow(pair({}, { pageSizeBytes: 16384 }));
    assert.equal(pageSize.clean, false);
    assert.ok(pageSize.reasons.includes('host samples use inconsistent page sizes'));
    assert.equal(pageSize.intervals[0].swapInBytes, null);

    const cpus = summarizeNativeHostWindow(pair({}, { cpus: 4 }));
    assert.equal(cpus.clean, false);
    assert.ok(cpus.reasons.includes('host samples use inconsistent CPU counts'));
});

test('rejects high per-CPU load and combined swap-in plus swap-out rate', () => {
    const loaded = summarizeNativeHostWindow(pair({}, { load1: 16 }));
    assert.equal(loaded.clean, false);
    assert.ok(loaded.reasons.some(reason => /host load per CPU/.test(reason)));

    const swapping = summarizeNativeHostWindow(pair({}, { swapins: 101, swapouts: 51 }), { maxSwapMiBPerSecond: 0.005 });
    assert.equal(swapping.clean, false);
    assert.equal(swapping.intervals[0].swapInBytes, 4096);
    assert.equal(swapping.intervals[0].swapOutBytes, 4096);
    assert.ok(swapping.reasons.some(reason => /host swap rate/.test(reason)));
});

test('missing timestamps, load, CPU and error-bearing samples fail closed', () => {
    const samples = pair();
    samples[1].at = NaN;
    samples[0].load1 = null;
    samples[0].cpus = null;
    samples[1].error = 'vm_stat unavailable';
    const result = summarizeNativeHostWindow(samples);
    assert.equal(result.clean, false);
    assert.ok(result.reasons.some(reason => /timestamp is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /load average is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /CPU count is missing or invalid/.test(reason)));
    assert.ok(result.reasons.some(reason => /native sampling error/.test(reason)));
    assert.equal(result.intervals.length, 1);
    assert.equal(result.intervals[0].swapMiBPerSecond, null);
});

test('requires at least two samples and does not invent missing aggregate counters', () => {
    const one = summarizeNativeHostWindow([sample()]);
    assert.equal(one.clean, false);
    assert.equal(one.swapInBytes, null);
    assert.ok(one.reasons.includes('at least two host samples are required'));

    const invalid = summarizeNativeHostWindow([sample(), null]);
    assert.equal(invalid.clean, false);
    assert.equal(invalid.intervals.length, 1);
    assert.deepEqual(invalid.intervals[0], { elapsedMs: null, swapInBytes: null, swapOutBytes: null, swapMiBPerSecond: null });
});
