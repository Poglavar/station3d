import assert from 'node:assert/strict';
// Verify browser CPU deltas and explicit unknowns for incomplete process evidence.
import test from 'node:test';
import { readBrowserCpuSnapshot, summarizeBrowserCpuWindow } from '../../../tools/lib/perf-acceptance-cpu.mjs';

const snap = (at, processes, error = null) => ({ at, processes, error });

test('summarizes asymmetric per-process scheduled CPU deltas and normalized metrics', () => {
    const start = snap(1000, [
        { id: 10, type: 'browser', cpuTime: 2 },
        { id: 11, type: 'renderer', cpuTime: 1 },
        { id: 12, type: 'renderer', cpuTime: 4 },
        { id: 13, type: 'gpu', cpuTime: 0.5 },
    ]);
    const end = snap(61000, [
        { id: 10, type: 'browser', cpuTime: 2.25 },
        { id: 11, type: 'renderer', cpuTime: 1.75 },
        { id: 12, type: 'renderer', cpuTime: 4.5 },
        { id: 13, type: 'gpu', cpuTime: 0.625 },
    ]);
    assert.deepEqual(summarizeBrowserCpuWindow(start, end, { frameCount: 1200, distanceM: 600 }), {
        valid: true,
        reasons: [],
        elapsedMs: 60000,
        totalCpuSeconds: 1.625,
        perType: Object.assign(Object.create(null), { browser: 0.25, renderer: 1.25, gpu: 0.125 }),
        millisecondsPerFrame: 1.3541666666666667,
        secondsPerMeter: 1.625 / 600,
    });
});

test('keeps valid elapsed CPU totals when no optional normalization is supplied', () => {
    const result = summarizeBrowserCpuWindow(
        snap(200, [{ id: 'renderer-1', type: 'renderer', cpuTime: 0 }]),
        snap(1200, [{ id: 'renderer-1', type: 'renderer', cpuTime: 0.2 }]),
    );
    assert.equal(result.valid, true);
    assert.equal(result.totalCpuSeconds, 0.2);
    assert.deepEqual(result.perType, Object.assign(Object.create(null), { renderer: 0.2 }));
    assert.equal(result.millisecondsPerFrame, null);
    assert.equal(result.secondsPerMeter, null);
});

test('rejects empty process lists and invalid numeric IDs instead of inferring zero CPU', () => {
    const empty = summarizeBrowserCpuWindow(snap(100, []), snap(200, []));
    assert.equal(empty.valid, false);
    assert.equal(empty.totalCpuSeconds, null);
    assert.ok(empty.reasons.includes('start process list is empty'));
    assert.ok(empty.reasons.includes('end process list is empty'));

    for (const id of [NaN, Infinity, -1]) {
        const invalidId = summarizeBrowserCpuWindow(
            snap(100, [{ id: 1, type: 'renderer', cpuTime: 0 }]),
            snap(200, [{ id, type: 'renderer', cpuTime: 1 }]),
        );
        assert.equal(invalidId.valid, false);
        assert.equal(invalidId.totalCpuSeconds, null);
        assert.ok(invalidId.reasons.includes('end process 0 is malformed'));
    }
});

test('protects per-type aggregation keys and fails closed on normalized overflow', () => {
    const protoKey = summarizeBrowserCpuWindow(
        snap(100, [{ id: 1, type: '__proto__', cpuTime: 0 }]),
        snap(200, [{ id: 1, type: '__proto__', cpuTime: 0.5 }]),
    );
    assert.equal(protoKey.valid, true);
    assert.equal(Object.getPrototypeOf(protoKey.perType), null);
    assert.equal(protoKey.perType.__proto__, 0.5);

    const cpuOverflow = summarizeBrowserCpuWindow(
        snap(100, [{ id: 1, type: 'renderer', cpuTime: 0 }]),
        snap(200, [{ id: 1, type: 'renderer', cpuTime: 1e308 }]),
        { frameCount: 1 },
    );
    assert.equal(cpuOverflow.valid, false);
    assert.equal(cpuOverflow.totalCpuSeconds, null);
    assert.ok(cpuOverflow.reasons.includes('browser CPU normalized metric overflowed'));

    const distanceOverflow = summarizeBrowserCpuWindow(
        snap(100, [{ id: 1, type: 'renderer', cpuTime: 0 }]),
        snap(200, [{ id: 1, type: 'renderer', cpuTime: 1 }]),
        { distanceM: Number.MIN_VALUE },
    );
    assert.equal(distanceOverflow.valid, false);
    assert.equal(distanceOverflow.totalCpuSeconds, null);
    assert.ok(distanceOverflow.reasons.includes('browser CPU normalized metric overflowed'));
});

test('fails closed when a process exits or appears so its CPU cannot be undercounted', () => {
    const start = snap(100, [{ id: 1, type: 'browser', cpuTime: 0 }, { id: 2, type: 'renderer', cpuTime: 0 }]);
    const end = snap(200, [{ id: 1, type: 'browser', cpuTime: 1 }]);
    const exited = summarizeBrowserCpuWindow(start, end);
    assert.equal(exited.valid, false);
    assert.equal(exited.totalCpuSeconds, null);
    assert.ok(exited.reasons.includes('browser process membership changed during the CPU window'));

    const appeared = summarizeBrowserCpuWindow(start, snap(200, [
        ...start.processes, { id: 3, type: 'renderer', cpuTime: 0 },
    ]));
    assert.equal(appeared.totalCpuSeconds, null);
    assert.ok(appeared.reasons.includes('browser process membership changed during the CPU window'));
});

test('rejects process type changes, duplicate IDs, malformed counters and counter resets', () => {
    const one = snap(100, [{ id: 1, type: 'renderer', cpuTime: 3 }]);
    const typeChange = summarizeBrowserCpuWindow(one, snap(200, [{ id: 1, type: 'gpu', cpuTime: 4 }]));
    assert.equal(typeChange.valid, false);
    assert.ok(typeChange.reasons.includes('browser process type changed during the CPU window'));

    const duplicate = summarizeBrowserCpuWindow(one, snap(200, [
        { id: 1, type: 'renderer', cpuTime: 4 }, { id: 1, type: 'renderer', cpuTime: 5 },
    ]));
    assert.equal(duplicate.totalCpuSeconds, null);
    assert.ok(duplicate.reasons.includes('end process IDs are duplicated'));

    for (const cpuTime of [-1, NaN, Infinity, null]) {
        const malformed = summarizeBrowserCpuWindow(one, snap(200, [{ id: 1, type: 'renderer', cpuTime }]));
        assert.equal(malformed.valid, false);
        assert.equal(malformed.totalCpuSeconds, null);
        assert.ok(malformed.reasons.includes('end process 0 is malformed'));
    }

    const reset = summarizeBrowserCpuWindow(one, snap(200, [{ id: 1, type: 'renderer', cpuTime: 2 }]));
    assert.equal(reset.valid, false);
    assert.equal(reset.totalCpuSeconds, null);
    assert.ok(reset.reasons.includes('browser process CPU counter reset or decreased'));
});

test('rejects unusable timestamps, collection errors and invalid denominators without throwing', () => {
    const valid = snap(100, [{ id: 1, type: 'renderer', cpuTime: 0 }]);
    for (const [start, end] of [
        [snap(NaN, valid.processes), snap(200, valid.processes)],
        [valid, snap(100, valid.processes)],
        [valid, snap(200, null, 'CDP unavailable')],
        [null, valid],
    ]) {
        assert.doesNotThrow(() => summarizeBrowserCpuWindow(start, end));
        const result = summarizeBrowserCpuWindow(start, end);
        assert.equal(result.valid, false);
        assert.equal(result.totalCpuSeconds, null);
    }

    const badNormalization = summarizeBrowserCpuWindow(valid, snap(200, valid.processes), { frameCount: 0, distanceM: -1 });
    assert.equal(badNormalization.valid, false);
    assert.ok(badNormalization.reasons.includes('frameCount must be finite and positive'));
    assert.ok(badNormalization.reasons.includes('distanceM must be finite and positive'));

    const badOptions = summarizeBrowserCpuWindow(valid, snap(200, valid.processes), null);
    assert.equal(badOptions.valid, false);
    assert.equal(badOptions.totalCpuSeconds, null);
    assert.ok(badOptions.reasons.includes('CPU window options are invalid'));
});

test('reads the Chromium process-info payload and reports protocol failures explicitly', async () => {
    const seen = [];
    const snapshot = await readBrowserCpuSnapshot({ send: async method => {
        seen.push(method);
        return { processInfo: [{ id: 4, type: 'renderer', cpuTime: 0.75 }] };
    } });
    assert.deepEqual(seen, ['SystemInfo.getProcessInfo']);
    assert.equal(typeof snapshot.at, 'number');
    assert.deepEqual(snapshot.processes, [{ id: 4, type: 'renderer', cpuTime: 0.75 }]);
    assert.equal(snapshot.error, null);

    const failed = await readBrowserCpuSnapshot({ send: async () => { throw new Error('detached'); } });
    assert.equal(typeof failed.at, 'number');
    assert.equal(failed.processes, null);
    assert.equal(failed.error, 'detached');

    const malformed = await readBrowserCpuSnapshot({ send: async () => ({}) });
    assert.equal(malformed.processes, null);
    assert.match(malformed.error, /no processInfo array/);
});
