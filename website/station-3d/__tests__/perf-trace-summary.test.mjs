// Pins the trace harness's attribution rules so a short named phase can never
// again inherit an entire render- or stall-dominated frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isolatePerfTraceMeasurement,
    parseTimedTokens,
    summarizePerfSamples,
    summarizePerfTrace,
} from '../core/perf-trace-summary.js';

const stat = (summary, table, name) => summary[table].find(entry => entry.name === name);

test('parses the duration after the final colon without losing nested phase names', () => {
    assert.deepEqual(
        parseTimedTokens('rails:terrainRefresh:1275 q:roads:30 invalid nope:x'),
        [
            { name: 'rails:terrainRefresh', ms: 1275 },
            { name: 'q:roads', ms: 30 },
        ],
    );
});

test('attributes a render spike to render while preserving the true road duration', () => {
    const summary = summarizePerfTrace({
        stutterTotal: 1,
        stutters: [{
            atMs: 14_488,
            frameMs: 741.7,
            hooksMs: 14.9,
            renderMs: 711.7,
            stallMs: 15.1,
            layers: 'roads:14',
            outside: 'q:buildings:2',
            renderBaselineMs: 22.5,
            hostBusy: false,
            stationary: false,
        }],
    });

    assert.equal(stat(summary, 'owners', 'render').totalMs, 711.7);
    assert.equal(stat(summary, 'causes', 'render').totalMs, 711.7);
    assert.equal(stat(summary, 'phases', 'roads').totalMs, 14);
    assert.equal(stat(summary, 'outsideWork', 'q:buildings').totalMs, 2);
    assert.equal(summary.worstFrames[0].cause, 'render:712');
    assert.equal(summary.movingStutters, 1);
});

test('aggregates actual phase durations and reports host-contended stutters separately', () => {
    const summary = summarizePerfTrace({
        stutterTotal: 3,
        stutters: [
            {
                frameMs: 100,
                hooksMs: 80,
                renderMs: 10,
                stallMs: 10,
                layers: 'controller:foot:70 roads:10',
                hostBusy: true,
            },
            {
                frameMs: 90,
                hooksMs: 75,
                renderMs: 5,
                stallMs: 10,
                layers: 'controller:foot:60 roads:15',
                background: 'startup:1',
            },
            {
                frameMs: 80,
                hooksMs: 1,
                renderMs: 2,
                stallMs: 77,
            },
        ],
    });

    assert.deepEqual(
        stat(summary, 'phases', 'controller:foot'),
        {
            name: 'controller:foot',
            count: 2,
            totalMs: 130,
            worstMs: 70,
            worstFrameMs: 100,
            over50ms: 2,
        },
    );
    assert.equal(summary.hostBusyStutters, 1);
    assert.equal(summary.startupStutters, 1);
    assert.equal(stat(summary, 'owners', 'stall').totalMs, 77);
});

test('summarizes the whole movement run instead of only its final one-second window', () => {
    const summary = summarizePerfSamples([
        { frameAvgMs: 10, fps: 100, hooksMs: 2, host: { level: 'clean' }, motionState: 'slow', speedMps: 2 },
        { frameAvgMs: 20, fps: 50, hooksMs: 12, host: { level: 'clean' }, motionState: 'transit', speedMps: 20 },
        { frameAvgMs: 30, fps: 33, hooksMs: 22, host: { level: 'busy', contended: true }, motionState: 'stationary', speedMps: 0 },
    ]);

    assert.equal(summary.windows, 3);
    assert.equal(summary.cleanWindows, 2);
    assert.equal(summary.busyWindows, 1);
    assert.equal(summary.movingWindows, 2);
    assert.equal(summary.metrics.frameAvgMs.median, 20);
    assert.equal(summary.metrics.frameAvgMs.p95, 29);
    assert.equal(summary.metrics.fps.p05, 34.7);
    assert.equal(summary.metrics.renderMs.median, null, 'missing data stays missing');
});

test('timestamp-isolates movement stutters for a legacy runtime without a native reset', () => {
    const snapshot = {
        stutterTotal: 3,
        stutters: [
            { atMs: 900, frameMs: 200, background: 'startup:terrain' },
            { atMs: 1_000, frameMs: 80, stationary: false },
            { atMs: 1_400, frameMs: 70, stationary: false },
        ],
    };
    const isolated = isolatePerfTraceMeasurement(snapshot, 1_000);

    assert.deepEqual(isolated.stutters.map(entry => entry.atMs), [1_000, 1_400]);
    assert.equal(isolated.stutterTotal, 2);
    assert.equal(isolated.measurementStartedAtMs, 1_000);
    assert.equal(snapshot.stutters.length, 3, 'the source snapshot is not mutated');
});
