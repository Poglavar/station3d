// Pins the benchmark observer modes and prevents incompatible trace artifacts
// from silently becoming an A/B comparison.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PERF_PROFILER_MODE,
    drawCallAttributionEnabled,
    perfRunCompatibilityMismatches,
    resolvePerfProfilerMode,
} from '../core/perf-run-contract.js';

const q = search => new URLSearchParams(search);

function run(overrides = {}) {
    return {
        harness: {
            headless: false,
            route: {
                pathname: '/transit.html',
                params: { line: '6', perfAttribution: '0', stats: '1', st3d: 'tram' },
                walk: [],
                autonomousSeconds: 45,
                settleSeconds: 0,
                viewport: { width: 1600, height: 1000 },
            },
            runtimeContext: {
                profilerMode: 'timing',
                terrainActive: false,
                terrainPolicy: 'opt-in',
                sourceProfile: { locationId: 'croatia', regionalLocationId: 'zagreb' },
                dpr: 2,
                activeLayers: ['roads', 'terrain'],
                worldMode: 'model',
                renderGrade: 'aces',
                sessionPresetId: 'cab',
            },
            ...overrides,
        },
    };
}

test('draw-call attribution is an explicit diagnostic mode, not implied by stats', () => {
    assert.equal(resolvePerfProfilerMode(q('?stats=1')), PERF_PROFILER_MODE.TIMING);
    assert.equal(drawCallAttributionEnabled(q('?stats=1')), false);
    assert.equal(
        resolvePerfProfilerMode(q('?stats=1&perfAttribution=1')),
        PERF_PROFILER_MODE.DRAW_ATTRIBUTION,
    );
});

test('equivalent runs tolerate source-object key and active-layer order', () => {
    const baseline = run();
    const candidate = run({
        runtimeContext: {
            ...baseline.harness.runtimeContext,
            sourceProfile: { regionalLocationId: 'zagreb', locationId: 'croatia' },
            activeLayers: ['terrain', 'roads'],
        },
    });
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate), []);
});

test('terrain, source, profiler, DPR, and active-layer differences reject an A/B pair', () => {
    const baseline = run();
    const candidate = run({
        runtimeContext: {
            ...baseline.harness.runtimeContext,
            profilerMode: 'draw-attribution',
            terrainActive: true,
            sourceProfile: { locationId: 'croatia', regionalLocationId: 'split' },
            dpr: 1,
            activeLayers: ['terrain', 'roads', 'rails'],
        },
    });
    const fields = perfRunCompatibilityMismatches(baseline, candidate)
        .map(mismatch => mismatch.field);
    assert.ok(fields.includes('runtime.profilerMode'));
    assert.ok(fields.includes('runtime.terrainActive'));
    assert.ok(fields.includes('runtime.sourceProfile.regionalLocationId'));
    assert.ok(fields.includes('runtime.dpr'));
    assert.ok(fields.includes('runtime.activeLayers'));
});

test('scenario and viewport differences also reject an A/B pair', () => {
    const baseline = run();
    const candidate = run({
        route: {
            ...baseline.harness.route,
            params: { ...baseline.harness.route.params, line: '11' },
            viewport: { width: 1280, height: 720 },
        },
    });
    const fields = perfRunCompatibilityMismatches(baseline, candidate)
        .map(mismatch => mismatch.field);
    assert.ok(fields.includes('route.params.line'));
    assert.ok(fields.includes('route.viewport.height'));
    assert.ok(fields.includes('route.viewport.width'));
});

test('authored driving and settled ground use distinct measurement contracts', () => {
    const baseline = run();
    const candidate = run({ route: { ...baseline.harness.route, driveVehicle: 'car', groundSettledStart: true } });
    const fields = perfRunCompatibilityMismatches(baseline, candidate).map(item => item.field);
    assert.ok(fields.includes('route.driveVehicle'));
    assert.ok(fields.includes('route.groundSettledStart'));
});

test('identical tram URLs cannot hide a different resolved route or compiled path', () => {
    const baseline = run();
    baseline.harness.route.tramRoute = { plan: { protocol: 'first-shared-tram-template-v1' },
        observed: { stops: [{ stopId: 'a', lat: 45, lng: 16 }],
            segments: [{ totalDist: 100, pathDists: [{ lat: 45, lng: 16, d: 0 }] }] }, count: 1 };
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, structuredClone(baseline)), []);
    for (const change of ['missing', 'stop', 'path']) {
        const candidate = structuredClone(baseline);
        if (change === 'missing') candidate.harness.route.tramRoute = null;
        else if (change === 'stop') candidate.harness.route.tramRoute.observed.stops[0].stopId = 'different';
        else candidate.harness.route.tramRoute.observed.segments[0].pathDists[0].lng += .001;
        assert.ok(perfRunCompatibilityMismatches(baseline, candidate).some(item => item.field.startsWith('route.tramRoute')));
    }
});

test('CPU/timeline/heap instrumentation and transport overrides cannot masquerade as ordinary timing runs', () => {
    for (const field of ['chromeTimeline', 'cpuProfile', 'heapProfile', 'disableQuic', 'renderStalls']) {
        const differences = perfRunCompatibilityMismatches(run(), run({ observer: { [field]: true } }));
        assert.deepEqual(differences.map(d => d.field), field === 'chromeTimeline'
            ? ['observer.chromeTimeline', 'observer.chromeTimelineMode'] : [`observer.${field}`]);
    }
});

test('frame cadence observers cannot be paired with older window-average-only captures', () => {
    const observed = run({ observer: { frameCadence: 'station3d-frame-cadence-v1' } });
    assert.deepEqual(perfRunCompatibilityMismatches(run(), observed).map(row => row.field), ['observer.frameCadence']);
    assert.deepEqual(perfRunCompatibilityMismatches(observed, structuredClone(observed)), []);
});

test('light and full timelines are different observers, while earlier timelines mean full', () => {
    const full = run({ observer: { chromeTimeline: true } });
    const explicit = run({ observer: { chromeTimeline: true, chromeTimelineMode: 'full' } });
    const light = run({ observer: { chromeTimeline: true, chromeTimelineMode: 'main-thread' } });
    assert.deepEqual(perfRunCompatibilityMismatches(full, explicit), []);
    assert.deepEqual(perfRunCompatibilityMismatches(full, light).map(d => d.field), ['observer.chromeTimelineMode']);
});

test('equal DPR does not make different shadow or quality budgets comparable', () => {
    const baseline = run();
    baseline.harness.runtimeContext.quality = { requestedMode: 'high', shadowMapSize: 2048 };
    const candidate = run({ runtimeContext: {
        ...baseline.harness.runtimeContext,
        quality: { requestedMode: 'low', shadowMapSize: 1024 },
    } });
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate).map(d => d.field), [
        'runtime.quality.requestedMode', 'runtime.quality.shadowMapSize',
    ]);
});

test('a player-ready start cannot be compared with a fully built initial scene', () => {
    const baseline = run(), candidate = run({ route: { ...baseline.harness.route, startPolicy: 'fully-built' } });
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate).map(d => d.field), ['route.startPolicy']);
    baseline.harness.route.startPolicy = 'fully-built';
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate), []);
    candidate.harness.route.startPolicy = 'paused-fully-built';
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate).map(d => d.field), ['route.startPolicy']);
    baseline.harness.route.startPolicy = 'paused-fully-built';
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate), []);
});

test('paired performance requires the same frozen source fixture contract', () => {
    const baseline = run(), candidate = run();
    baseline.harness.sourceFixtures = { schema: 'station3d-audit-source-fixtures-v2', manifestHash: 'a'.repeat(64), replay: true, directory: '/baseline' };
    candidate.harness.sourceFixtures = { ...baseline.harness.sourceFixtures, directory: '/candidate' };
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate), []);
    candidate.harness.sourceFixtures.manifestHash = 'b'.repeat(64);
    assert.deepEqual(perfRunCompatibilityMismatches(baseline, candidate).map(d => d.field), ['sourceFixtures.manifestHash']);
    delete candidate.harness.sourceFixtures;
    assert.ok(perfRunCompatibilityMismatches(baseline, candidate).length > 0);
});
