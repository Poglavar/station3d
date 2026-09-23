// The perf probe's verdicts must reject paging windows and never read a missing counter as quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    displayPeriodMs, hostWindowVerdict, parseProcVmstat, parseVmStat, summarizeGpuMs, summarizeIntervals,
} from '../../../tools/lib/perf-probe-summary.mjs';

test('interval summary counts hitches at their thresholds and ignores non-numbers', () => {
    const s = summarizeIntervals([8, 8, 9, 50, 100, 250, NaN, null, 8.3]);
    assert.equal(s.n, 7);
    assert.equal(s.over50, 3); assert.equal(s.over100, 2); assert.equal(s.over250, 1);
    assert.equal(s.maxMs, 250); assert.equal(s.p50Ms, 9);
    assert.equal(summarizeIntervals([]).meanMs, null);
    assert.equal(displayPeriodMs([8.3, 8.4, 8.3, 40, 8.3]), 8.3);
});

test('vm_stat and /proc/vmstat parse to the same counters; missing ones stay null', () => {
    const mac = 'Pages free: 1.\nPageins:                                   364097968.\nSwapins:                                   112424908.\nSwapouts:                                  124753953.\n';
    assert.deepEqual(parseVmStat(mac), { pageins: 364097968, swapins: 112424908, swapouts: 124753953 });
    assert.deepEqual(parseProcVmstat('pgpgin 10\npswpin 3\npswpout 4\n'), { pageins: 10, swapins: 3, swapouts: 4 });
    assert.deepEqual(parseVmStat(''), { pageins: null, swapins: null, swapouts: null });
});

test('a window is rejected for paging, for load, and when the counter could not be read', () => {
    const quiet = hostWindowVerdict({ before: { swapins: 100 }, after: { swapins: 120 }, seconds: 10, loadAvg: 3, cpus: 8 });
    assert.equal(quiet.clean, true); assert.equal(quiet.swapinsPerSecond, 2);
    const paging = hostWindowVerdict({ before: { swapins: 0 }, after: { swapins: 16000 }, seconds: 10 });
    assert.equal(paging.clean, false); assert.match(paging.reasons[0], /paging: 1600/);
    const loaded = hostWindowVerdict({ before: { swapins: 0 }, after: { swapins: 0 }, seconds: 10, loadAvg: 18, cpus: 8 });
    assert.equal(loaded.clean, false); assert.match(loaded.reasons[0], /load 18.0 on 8/);
    const unknown = hostWindowVerdict({ before: { swapins: null }, after: { swapins: 5 }, seconds: 10 });
    assert.equal(unknown.clean, false, 'an unreadable counter is not evidence of a quiet host');
});

test('GPU samples summarise, and an unavailable timer is null rather than zero', () => {
    assert.equal(summarizeGpuMs(null), null);
    assert.equal(summarizeGpuMs([]), null);
    assert.equal(summarizeGpuMs([9, 9.5, 21]).maxMs, 21);
});
