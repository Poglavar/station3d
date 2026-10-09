import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { acceptanceObserverSource } from '../../../tools/lib/perf-acceptance-browser.mjs';

const nativePose = { lat: 45.1, lon: 15.2, headingDeg: 80 };
const pinnedPose = { lat: 45.8, lon: 15.9, headingDeg: 10 };
const plain = value => JSON.parse(JSON.stringify(value));

function makeDrainState() {
    return {
        groundGenerations: { snapshot: () => ({ closed: false, generation: 1, published: 1, pending: 0,
            preparing: 0, waitingPublication: 0, phase: 'idle', failed: 0, lastError: null,
            capacityBlocked: false, sourceBlocked: false, failureBlocked: false,
            preparationCpuMs: 0, preparationSteps: 0, lastPublication: { generation: 1 } }) },
        layerCtx: {
            sharedTileSession: { getNetworkDebugState: () => ({ active: 0, queued: 0 }), getDebugState: () => [] },
            getDecorReadiness: () => ({ expected: 4, published: 4, empty: 0, initialized: true, pending: 0, failed: 0 }),
        },
        groundPaint: { snapshot: () => ({ pending: null, failures: 0, closed: false }) },
    };
}

function createObserver({ mode = 'walk', initialPose = null, corridorM = 1 } = {}) {
    let now = 0;
    let wallNow = 10000;
    const raf = [];
    const events = [];
    const modal = { dataset: { worldBuildReason: 'ready', worldBuildBlockers: '[]' } };
    const cabState = { ...makeDrainState(), simPaused: mode === 'rail', controllerRouter: { activeId: 'native' } };
    const buildingState = {
        loadedBuildingCount: 10, reservedBuildingCount: 0, activeTileBuildCount: 0,
        activeVisualReplacementTiles: 0, pendingTerrainRebuildTiles: 0, pendingRegionalRebuildTiles: 0,
        staticBuildActive: false,
        aggregatePipeline: { activeBucket: null, pendingBuckets: 0, waitingTiles: 0 },
    };
    const renderer = {
        getPixelRatio: () => 1.5,
        domElement: { width: 1440, height: 900 },
        getContext: () => ({ getContextAttributes: () => ({ antialias: true }) }),
        shadowMap: { enabled: true }, info: { render: { calls: 20, triangles: 100 }, memory: { geometries: 3, textures: 2 }, programs: [] },
    };
    let pose = { lat: 45, lon: 15, headingDeg: 0 };
    const window = {
        __st3dDebug: { state: { cabState }, renderer },
        __s3dStreamingReport: () => ({ scheduler: { phase: 'idle', queues: [] } }),
        __s3dBuildingBuildState: () => buildingState,
        addEventListener() {},
        dispatchEvent(event) {
            events.push({ type: event.type, key: event.key, at: now });
            if (event.type === 'keydown' && event.key.toLowerCase() === 'p') cabState.simPaused = !cabState.simPaused;
            return true;
        },
    };
    const document = { visibilityState: 'visible', getElementById: id => id === 'station3DModal' ? modal : null };
    class FakeKeyboardEvent {
        constructor(type, options) { this.type = type; Object.assign(this, options); }
    }
    class FakePerformanceObserver { observe() {} }
    const context = vm.createContext({
        window, document, performance: { now: () => now }, Date: { now: () => wallNow },
        requestAnimationFrame: callback => { raf.push(callback); return raf.length; },
        KeyboardEvent: FakeKeyboardEvent, PerformanceObserver: FakePerformanceObserver,
        console: { error() {} },
    });
    vm.runInContext(acceptanceObserverSource({ mode, initialPose, headingDeg: 0, corridorM, quality: 'high' }), context);
    const capture = window.__station3dAcceptance;
    const api = {
        calls: [], closeCalls: 0,
        getPose: () => pose,
        getPerformanceContext: () => ({ quality: { profileId: 'high' }, terrainActive: true }),
        openCab(first, second, provider) {
            window.__st3dDebug.state.cabState = cabState;
            this.calls.push({ first, second, provider });
            const sessionPose = provider({ route: this.calls.length });
            pose = sessionPose;
            return sessionPose;
        },
        openWalk(first, second, provider) {
            this.calls.push({ first, second, provider });
            return provider?.({ route: this.calls.length });
        },
        openGta() { this.calls.push({ gta: true }); },
        close() { this.closeCalls++; window.__st3dDebug.state.cabState = null; },
    };
    const originalOpenCab = api.openCab;
    window.Station3D = api;
    function step(at) {
        now = at;
        wallNow = 10000 + at;
        const callback = raf.shift();
        assert.ok(callback, 'observer scheduled a frame');
        callback(at);
    }
    return { window, document, api, originalOpenCab, capture, cabState, buildingState, events, step,
        setPose(value) { pose = value; }, setNow(value) { now = value; }, modal };
}

test('first rail provider pose is pinned while later provider calls retain native behavior', () => {
    const env = createObserver({ mode: 'rail', initialPose: pinnedPose });
    assert.notEqual(env.api.openCab, env.originalOpenCab, 'observer wraps the real public method');
    const provider = options => {
        if (options?.paused === true) env.cabState.simPaused = true;
        return { ...nativePose, route: options?.route ?? null };
    };
    const opened = env.api.openCab('line', 'shape', provider);
    assert.equal(env.api.calls.length, 1);
    assert.deepEqual(plain(env.capture.origin.native), { ...nativePose, route: 1 });
    assert.deepEqual(plain(opened), { ...env.capture.origin.native, ...pinnedPose });
    assert.equal(env.cabState.simPaused, true);

    const later = env.api.calls[0].provider({ route: 'later' });
    assert.deepEqual(plain(later), { ...nativePose, route: 'later' });
});

test('rail reopen pins each fresh controller once and rejects reuse of an advanced callback', () => {
    const env = createObserver({ mode: 'rail', initialPose: pinnedPose });
    const providerCalls = [];
    const provider = options => {
        providerCalls.push(options);
        if (options?.paused) env.cabState.simPaused = true;
        return { ...nativePose, opened: env.api.calls.length };
    };
    env.api.openCab('line', 'shape', provider);
    const firstWrapped = env.api.calls[0].provider;
    assert.equal(firstWrapped({ route: 'after-open' }).opened, 1);
    env.capture.close();
    assert.equal(env.api.closeCalls, 1, 'observer closes through the real public method');
    assert.equal(env.window.__st3dDebug.state.cabState, null);
    assert.throws(() => env.capture.reopen(), /fresh native controller/);
    env.window.__station3dAcceptanceReopen = () => env.api.openCab('line', 'shape', provider);
    assert.throws(() => env.capture.reopen(), /pose callback was reused/);
    const reopenedPose = { lat: 45.7, lon: 15.6, headingDeg: 40 };
    env.window.__station3dAcceptanceReopen = () => env.api.openCab('line', 'shape', () => reopenedPose);
    env.capture.reopen();
    assert.equal(env.api.calls.length, 2);
    assert.deepEqual(plain(providerCalls[0]), { route: 1, paused: true });
    assert.deepEqual(plain(env.api.getPose()), pinnedPose);
    assert.deepEqual(plain(env.api.calls[1].provider({ route: 'later' })), reopenedPose);
    assert.deepEqual(plain(env.capture.origin.fixed), { ...nativePose, opened: 1, ...pinnedPose });
    assert.equal(env.capture.origins.length, 2);
    assert.deepEqual(plain(env.capture.origins[1]), { native: reopenedPose, fixed: pinnedPose });
    assert.equal(env.capture.hold, true);
    assert.notEqual(env.api.calls[0].provider, env.api.calls[1].provider);
});

test('walk movement releases the held key on the exact phase-end frame', () => {
    const env = createObserver({ mode: 'walk', corridorM: 1 });
    env.capture.start('movement', 1000);
    env.setPose({ lat: 45 + 0.5 / 111320, lon: 15, headingDeg: 0 });
    env.step(999);
    assert.deepEqual(plain(env.capture.held), ['w']);
    assert.equal(env.capture.phases.movement.done, false);
    assert.deepEqual(env.events.filter(event => event.key === 'w').map(event => event.type), ['keydown']);

    env.step(1000);
    assert.equal(env.capture.phases.movement.done, true);
    assert.equal(env.capture.phases.movement.durationMs, 1000);
    assert.deepEqual(plain(env.capture.held), []);
    assert.deepEqual(env.events.filter(event => event.key === 'w').map(event => [event.type, event.at]), [['keydown', 999], ['keyup', 1000]]);
    const route = plain(env.capture.phases.movement.route);
    assert.equal(route.length, 2, 'sub-two-metre endpoint is retained even without a periodic waypoint');
    assert.equal(route[0].distanceM, 0);
    assert.equal(route[1].lat, 45 + 0.5 / 111320);
    assert.equal(route[1].distanceM, env.capture.phases.movement.distanceM);
});

test('movement records absolute travelled distance through turns, including the final partial segment', () => {
    const env = createObserver({ mode: 'walk', corridorM: 100 });
    env.capture.start('movement', 1000);
    env.setPose({ lat: 45 + 3 / 111320, lon: 15, headingDeg: 0 });
    env.step(400);
    env.setPose({ lat: 45, lon: 15, headingDeg: 180 });
    env.step(800);
    env.setPose({ lat: 45 + 0.5 / 111320, lon: 15, headingDeg: 0 });
    env.step(1000);
    const phase = env.capture.phases.movement, route = plain(phase.route);
    assert.equal(route.length, 4);
    assert.ok(Math.abs(route[1].distanceM - 3) < 0.001);
    assert.ok(Math.abs(route[2].distanceM - 6) < 0.001);
    assert.ok(Math.abs(route[3].distanceM - 6.5) < 0.001);
    assert.equal(route[2].lat, route[0].lat, 'returning to the origin does not erase travelled distance');
    assert.equal(route.at(-1).distanceM, phase.distanceM);
});

test('rail movement unpauses at start and pauses exactly at phase end', () => {
    const env = createObserver({ mode: 'rail', initialPose: pinnedPose });
    env.api.openCab('line', 'shape', options => {
        env.cabState.simPaused = Boolean(options?.paused);
        return nativePose;
    });
    assert.equal(env.cabState.simPaused, true);
    env.capture.start('movement', 1000);
    assert.equal(env.cabState.simPaused, false);
    assert.deepEqual(env.events.filter(event => event.key === 'p').map(event => [event.type, event.at]), [['keydown', 0], ['keyup', 0]]);

    env.step(999);
    assert.equal(env.cabState.simPaused, false);
    assert.equal(env.capture.phases.movement.done, false);
    env.step(1000);
    assert.equal(env.cabState.simPaused, true);
    assert.equal(env.capture.phases.movement.done, true);
    assert.deepEqual(env.events.filter(event => event.key === 'p').map(event => [event.type, event.at]), [
        ['keydown', 0], ['keyup', 0], ['keydown', 1000], ['keyup', 1000],
    ]);
});

test('missing, failed and incomplete building-pipeline drain evidence never reports drained', () => {
    const env = createObserver({ mode: 'walk' });
    assert.equal(env.capture.read().current.drainState, 'drained');

    env.cabState.groundGenerations.snapshot = () => null;
    assert.equal(env.capture.read().current.drainState, 'unavailable');

    env.cabState.groundGenerations.snapshot = () => ({ closed: false, generation: 2, published: 1,
        pending: 0, preparing: 0, waitingPublication: 0, failed: 1, capacityBlocked: false,
        sourceBlocked: false, failureBlocked: false });
    assert.equal(env.capture.read().current.drainState, 'failed');

    env.cabState.groundGenerations.snapshot = makeDrainState().groundGenerations.snapshot;
    env.buildingState.aggregatePipeline = { activeBucket: null, pendingBuckets: 0 };
    assert.equal(env.capture.read().current.drainState, 'unavailable');
    env.buildingState.aggregatePipeline.waitingTiles = 1;
    assert.equal(env.capture.read().current.drainState, 'pending');
});

test('absent failure and pending flags cannot look like a drained world', () => {
    const env = createObserver();
    for (const [source, fields] of [
        ['groundGenerations', ['closed', 'failed', 'capacityBlocked', 'sourceBlocked', 'failureBlocked']],
        ['groundPaint', ['closed', 'failures', 'pending']],
    ]) {
        for (const field of fields) {
            const snapshot = makeDrainState()[source].snapshot();
            delete snapshot[field];
            env.cabState[source].snapshot = () => snapshot;
            assert.equal(env.capture.sample().drainState, 'unavailable', `${source}.${field}`);
            env.cabState[source].snapshot = makeDrainState()[source].snapshot;
        }
    }
    assert.equal(env.capture.sample().drainState, 'drained');
    env.cabState.groundPaint.snapshot = () => ({ pending: { index: 0, phase: 'raster', revision: 1 }, failures: 0, closed: false });
    assert.equal(env.capture.sample().drainState, 'pending');
});

test('held tile callbacks cannot look drained when networking and frame queues are idle', () => {
    const env = createObserver();
    const source = { pendingTiles: 0, pendingCallbacks: 1 };
    env.cabState.layerCtx.sharedTileSession.getDebugState = () => [source];
    assert.equal(env.capture.sample().drainState, 'pending');
    source.pendingCallbacks = 0;
    assert.equal(env.capture.sample().drainState, 'drained');
    source.pendingTiles = 1;
    assert.equal(env.capture.sample().drainState, 'pending');
    delete source.pendingCallbacks;
    assert.equal(env.capture.sample().drainState, 'unavailable');
    delete env.cabState.layerCtx.sharedTileSession.getDebugState;
    assert.equal(env.capture.sample().drainState, 'unavailable');
});
