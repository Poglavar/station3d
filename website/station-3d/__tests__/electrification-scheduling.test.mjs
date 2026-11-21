// Exercise the live layer's orchestration with the real frame queue and pure
// span tasks, so display-frame caps and per-frame movement resets cannot hide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPillarClearanceEvaluatorSteps } from '../core/pillar-clearance.js';
import {
    createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM,
    setFrameChunkSchedulerMode, resetFrameChunkObserver,
} from '../core/frame-chunk-queue.js';
import {
    createOwnedElectrificationSpansTask, createChangedElectrificationCellKeysTask,
    electrificationCellSignature,
} from '../core/electrification-cells.js';

const source = readFileSync(new URL('../world/electrification.js', import.meta.url), 'utf8');
function install(context, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing production function ${name}`);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
}

function refreshFixture({ chords = 1000, chordMs = 0.01 } = {}) {
    const original = Object.fromEntries(['performance', 'requestAnimationFrame', 'cancelAnimationFrame']
        .map(key => [key, globalThis[key]]));
    let now = 0, nextId = 0, visited = 0, published = 0, trailing = 0, revision = 1;
    const publishedRevisions = [];
    const frames = new Map();
    globalThis.performance = { now: () => now };
    globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    setFrameChunkSchedulerMode('legacy');
    resetFrameChunkObserver();
    const queue = createFrameChunkQueue({ label: 'electrification-fixture', frameBudgetMs: 2,
        pauseDuringMovement: false, preferAnimationFrame: true, trackWorldReady: false });
    const segments = Array.from({ length: chords }, (_, i) => ({ len: 20, uStart: i * 20,
        x1: i % 10, x2: i % 10 + 20, z1: 0, z2: 0, yStart: 0, yEnd: 0,
        startJoinX: 0, endJoinX: 0, startJoinZ: 1, endJoinZ: 1,
        angle: 0, properties: { osm_id: i } }));
    const context = vm.createContext({
        buildQueue: queue, FRAME_CHUNK_REPEAT_ITEM, sampledRevision: -1,
        pendingSampledRevision: -1, sampledAlignmentJob: null, supportLocationId: 'zagreb',
        cellSignatures: new Map(), getSampledRailTrackbedSegments: () => ({ revision, segments }),
        __trackElectrification: { resolveAtDistance() { visited++; now += chordMs; return { status: 'overhead' }; } },
        createOwnedElectrificationSpansTask, createChangedElectrificationCellKeysTask,
        electrificationCellSignature,
        applySampledAlignmentRefresh(refresh) {
            published++; publishedRevisions.push(refresh.revision);
            context.sampledRevision = refresh.revision; context.pendingSampledRevision = -1;
        },
    });
    install(context, 'createSampledAlignmentRefresh');
    install(context, 'refreshSampledAlignment');
    context.refreshSampledAlignment();
    queue.enqueue(Array.from({ length: 100 }, (_, i) => i), () => { trailing++; now += 0.01; });
    return {
        context, stats: () => ({ visited, published, trailing, publishedRevisions }),
        tick(ms) { now += ms; },
        revise() { revision++; context.refreshSampledAlignment(); },
        frame() {
            const callbacks = [...frames.values()]; frames.clear();
            const before = now;
            for (const callback of callbacks) callback();
            const spent = now - before; now += 1000 / 60;
            return spent;
        },
        close() {
            queue.dispose(); resetFrameChunkObserver(); setFrameChunkSchedulerMode(null);
            for (const [key, value] of Object.entries(original)) {
                if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
            }
        },
    };
}

test('alignment refresh consumes its time slice and leaves cell work able to drain', () => {
    const f = refreshFixture();
    try {
        for (let frame = 0; frame < 10; frame++) f.frame();
        assert.equal(f.stats().published, 1, 'cheap ownership must not take one display frame per chunk');
        assert.equal(f.stats().visited, 1000);
        assert.equal(f.stats().trailing, 100, 'high-priority refresh must release the queue to cell spans');
        assert.equal(f.context.refreshSampledAlignment(), false, 'the same published revision is a no-op');
    } finally { f.close(); }
});

test('alignment refresh checks its budget after each rail chord', () => {
    const f = refreshFixture({ chordMs: 1 });
    try {
        assert.ok(f.frame() <= 2.01, '32 chord visits must not overrun the 2 ms queue slice');
        assert.equal(f.stats().visited, 2);
        assert.equal(f.stats().published, 0, 'partial ownership cannot publish');
    } finally { f.close(); }
});

test('a newer alignment cancels the partial scan and publishes only the current revision', () => {
    const f = refreshFixture();
    try {
        f.frame();
        assert.equal(f.stats().published, 0);
        f.revise();
        for (let frame = 0; frame < 10; frame++) f.frame();
        assert.deepEqual(f.stats().publishedRevisions, [2]);
        assert.equal(f.stats().trailing, 100, 'replacement ownership still releases the queued cell work');
        assert.equal(f.context.pendingSampledRevision, -1);
    } finally { f.close(); }
});

test('streaming distance accumulates across normal small movement frames', () => {
    const selectedAt = [];
    const context = vm.createContext({
        enabled: true, observer: { x: 0, z: 0 }, streamingObserver: { x: 0, z: 0 },
        performance: { now: () => 0 }, recordLayerFrameMs() {},
        invalidateCellsForRoadFormationChanges: () => false, refreshSampledAlignment: () => false,
        cellGroups: new Map(), cellJobs: new Map(), spansByCell: new Map(), pendingCellRebuilds: new Set(),
        selectQualityBoundedStreamingCells() {
            selectedAt.push(context.observer.x);
            return { preload: [], retain: new Set(), active: new Set() };
        },
    });
    install(context, 'refreshStreaming');
    const start = source.indexOf('export const electrificationLayer =');
    vm.runInContext(source.slice(start).replace('export const electrificationLayer =', 'globalThis.layer ='), context);
    for (let x = 1; x <= 50; x++) context.layer.onFrame(null, { x, z: 0 });
    assert.deepEqual(selectedAt, [20, 40], 'a 20 m threshold is measured since the last streaming update');
    assert.equal(context.observer.x, 50, 'live priorities still follow every frame');
    context.layer.onFrame(null, { x: 120, z: 0 });
    assert.deepEqual(selectedAt, [20, 40, 120], 'a larger movement refreshes immediately');
});

function supportFixture() {
    const f = refreshFixture({ chords: 0 }), c = f.context;
    let publications = 0, closed = 0;
    Object.assign(c, {
        enabled: true, supportSessionToken: 1, supportClearanceJob: null,
        supportClearance: () => -Infinity, supportRoadbedReady: false, supportRoadFormation: null,
        supportRoadRevision: -1, supportRoadSettleGate: {},
        CATENARY_ROAD_CENTER_CLEARANCE_M: 4.75, CATENARY_TRACK_CENTER_CLEARANCE_M: 1.4,
        publishedRoadRevision: () => 1, markSettleGateApplied() {},
        rebuildCellsForSupportClearance() { publications++; },
        createPillarClearanceEvaluatorSteps: function* (lat, lon, features, options) {
            try {
                return yield* createPillarClearanceEvaluatorSteps(lat, lon, features, {
                    ...options, roadSegmentsAt: () => [],
                    now() { f.tick(.01); return performance.now(); },
                });
            } finally { closed++; }
        },
    });
    install(c, 'queueSupportClearance');
    const features = [{ geometry: { type: 'LineString', coordinates:
        Array.from({ length: 2000 }, (_, i) => [16 + i * .000002, 45.8, 120]) } }];
    return { ...f, start() { c.queueSupportClearance(45.8, 16, features, c.supportSessionToken); },
        supportStats: () => ({ publications, closed }) };
}

test('catenary clearance construction yields through the real queue and publishes only its completed index', () => {
    const f = supportFixture();
    try {
        f.start();
        assert.equal(f.context.supportRoadbedReady, false);
        assert.equal(f.context.supportClearance(0, 0), -Infinity);
        assert.ok(f.frame() < 2.65, 'a dense reference source cannot drain synchronously');
        assert.equal(f.supportStats().publications, 0);
        for (let i = 0; i < 100 && !f.context.supportRoadbedReady; i++) f.frame();
        assert.equal(f.supportStats().publications, 1);
        assert.equal(f.context.supportRoadbedReady, true);
        assert.ok(Math.abs(f.context.supportClearance(0, 0) + 1.4) < 1e-8);
        assert.equal(f.context.supportClearanceJob, null);
    } finally { f.close(); }
});

test('ending a session closes its partial clearance index without publishing it', () => {
    const f = supportFixture();
    try {
        f.start(); f.frame();
        f.context.enabled = false; f.context.supportSessionToken++;
        f.context.buildQueue.clear(); f.frame();
        assert.deepEqual(f.supportStats(), { publications: 0, closed: 1 });
        assert.equal(f.context.supportClearanceJob, null);
        assert.equal(f.context.supportRoadbedReady, false);
    } finally { f.close(); }
});
