// Verifies cross-layer request sharing without coupling each layer's tile
// window, subscriptions, or eviction policy.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSharedTileSession,
    onTileStreamHealth,
} from '../core/shared-tile-session.js';
import {
    createFeatureCollectionJsonParseTask,
} from '../core/cooperative-feature-collection-json.js';
import {
    _resetWorldReady,
    beginWorldBuild,
    forceWorldReady,
} from '../core/world-ready.js';

async function waitFor(predicate, message = 'condition did not become true') {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

test('held sources defer queued delivery until every overlapping hold releases', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    try {
        const source = session.getSource({ key: 'held-source', ring: 0, keepRing: 0,
            loadPayload: async () => ({ features: [{ id: 'held' }] }) });
        let deliveries = 0;
        source.subscribe({ onFetch: () => { deliveries += 1; } });
        const first = session.holdSources(['held-source']);
        const second = session.holdSources(['held-source']);
        source.ensureAround(0, 0);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(deliveries, 0);
        assert.equal(first.release(), true);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(deliveries, 0);
        assert.equal(second.release(), true);
        await waitFor(() => deliveries === 1, 'held delivery did not resume after release');
        assert.equal(second.release(), false);
    } finally { controller.abort(); session.abort(); }
});

test('a source hold retains eviction membership without blocking independent delivery, and abort clears it', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const delivered = [], evicted = [];
    const source = session.getSource({ key: 'ground', ring: 0, keepRing: 0,
        loadPayload: async () => ({ features: [{ id: 'ground' }] }) });
    const other = session.getSource({ key: 'independent', ring: 0, keepRing: 0,
        loadPayload: async () => ({ features: [{ id: 'other' }] }) });
    source.subscribe({ onFetch: (_features, key) => delivered.push(key), onEvict: key => evicted.push(key) });
    let otherDeliveries = 0;
    other.subscribe({ onFetch: () => { otherDeliveries++; } });
    try {
        source.fetchTile(0, 0); source.pumpFetchQueue();
        await waitFor(() => source.tiles.get('0_0')?.status === 'loaded');
        const previous = source.tiles.get('0_0'), hold = session.holdSources(['ground']);
        source.ensureAround(10000, 0);
        other.fetchTile(0, 0); other.pumpFetchQueue();
        await waitFor(() => otherDeliveries === 1, 'held ground blocked the independent source');
        assert.equal(source.tiles.get('0_0'), previous);
        assert.deepEqual(evicted, []);
        assert.deepEqual(delivered, ['0_0']);
        assert.deepEqual([...session.sourceKeys()], ['ground', 'independent']);
        assert.equal(hold.release(), true);
        assert.deepEqual(evicted, [], 'release must not synchronously flush layer callbacks');
        source.ensureAround(10000, 0);
        await waitFor(() => evicted.includes('0_0'));
        assert.equal(evicted.filter(key => key === '0_0').length, 1);
        assert.equal(source.tiles.has('0_0'), false);
        const pending = session.holdSources(['ground']);
        source.fetchTile(70, 0); source.pumpFetchQueue();
        await waitFor(() => source.tiles.get('70_0')?.status === 'building');
        const count = delivered.length;
        session.abort(); controller.abort();
        assert.equal(source.sourceHolds, 0); assert.deepEqual([...session.sourceKeys()], []);
        assert.equal(pending.release(), true); assert.equal(pending.release(), false);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(delivered.length, count); assert.equal(source.failed.size, 0);
        assert.equal(source.tiles.size, 0);
    } finally { controller.abort(); session.abort(); }
});

test('draining holds seal the queued callback set without waiting for downstream publication promises', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'admission', maxConcurrentRequests: 2,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    let publish;
    const publication = new Promise(resolve => { publish = resolve; });
    const delivered = [];
    source.subscribe({ onFetch: (_features, key) => { delivered.push(key); return publication; } });
    const initial = session.holdSources(['admission']);
    let admission;
    try {
        source.fetchTile(0, 0); source.fetchTile(1, 0); source.pumpFetchQueue();
        await waitFor(() => source.pendingCallbacks.size === 2);
        admission = session.holdSources(['admission'], { drainQueued: true });
        assert.equal(admission.isReady(), false);
        initial.release();
        await waitFor(() => admission.isReady());
        assert.deepEqual(delivered.toSorted(), ['0_0', '1_0']);
        assert.equal(source.pendingTileCount, 2, 'the downstream publications have not completed');
        assert.equal(source.tiles.get('0_0').status, 'building');
        publish();
        await waitFor(() => source.pendingTileCount === 0);
        source.fetchTile(2, 0); source.fetchTile(3, 0); source.pumpFetchQueue();
        await waitFor(() => source.pendingCallbacks.size === 2);
        assert.equal(admission.isReady(), true, 'later input cannot move the sealed watermark');
        assert.deepEqual(delivered.toSorted(), ['0_0', '1_0'], 'later callbacks remain held until this generation publishes');
        admission.release();
        await waitFor(() => source.pendingTileCount === 0);
        assert.deepEqual(delivered.toSorted(), ['0_0', '1_0', '2_0', '3_0']);
        assert.equal(source.sourceHolds, 0); assert.equal(source.pendingCallbacks.size, 0);
    } finally { publish(); initial.release(); admission?.release(); controller.abort(); session.abort(); }
});

test('a source hold retains its captured membership but allows later unadmitted requests to evict', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'moving', ring: 0, keepRing: 0,
        loadPayload: async () => ({ features: [] }) });
    source.subscribe({ onFetch() {} });
    try {
        source.fetchTile(0, 0); source.pumpFetchQueue();
        await waitFor(() => source.tiles.get('0_0')?.status === 'loaded');
        const hold = session.holdSources(['moving']);
        for (let x = 10; x <= 20; x++) {
            source.ensureAround(x * 200, 0);
            assert.ok(source.tiles.has('0_0'));
            assert.ok(source.tiles.size <= 2, 'unadmitted movement requests accumulate behind the hold');
        }
        hold.release(); source.ensureAround(4000, 0);
        assert.equal(source.tiles.has('0_0'), false);
    } finally { controller.abort(); session.abort(); }
});

test('a bounded delivery hold retains previously admitted membership until publication', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'bounded-membership', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const delivered = [];
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    let hold;
    try {
        source.fetchTile(0, 0); source.pumpFetchQueue();
        await waitFor(() => source.tiles.get('0_0')?.status === 'loaded');
        source.fetchTile(1, 0); source.pumpFetchQueue();
        await waitFor(() => source.tiles.get('1_0')?.status === 'loaded');
        hold = session.holdSources(['bounded-membership'], {
            drainQueued: true,
            drainRequested: true,
            requestedTileKeys: ['1_0'],
            maxTiles: 1,
        });
        await waitFor(() => hold.isReady());
        source.ensureAround(4000, 0);
        assert.equal(source.tiles.has('0_0'), true,
            'an existing unselected model input was evicted during the bounded publication');
        assert.equal(source.tiles.has('1_0'), true);
        hold.release();
        source.ensureAround(4000, 0);
        assert.equal(source.tiles.has('0_0'), false);
        assert.equal(source.tiles.has('1_0'), false);
        assert.deepEqual(delivered.toSorted(), ['0_0', '1_0']);
    } finally { hold?.release(); controller.abort(); session.abort(); }
});

test('bounded dependency leases request and retain only named tiles across movement and overlapping owners', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'masks', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const delivered = [];
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    try {
        for (const keys of [['1_0', '2_0'], ['1_0', '1_0'], ['01_0']]) {
            assert.throws(() => session.retainSourceTiles('masks', keys, { maxTiles: 1 }));
            assert.equal(source.dependencyTileKeys.size, 0);
        }
        const first = session.retainSourceTiles('masks', ['-8_12'], { maxTiles: 1 });
        const second = session.retainSourceTiles('masks', ['-8_12'], { maxTiles: 1 });
        await waitFor(() => delivered.includes('-8_12'));
        assert.equal(delivered.filter(key => key === '-8_12').length, 1);
        source.ensureAround(8000, 0);
        assert.equal(source.tiles.has('-8_12'), true);
        first.release(); source.ensureAround(8200, 0);
        assert.equal(source.tiles.has('-8_12'), true);
        assert.equal(second.release(), true); assert.equal(second.release(), false);
        source.ensureAround(8400, 0);
        assert.equal(source.tiles.has('-8_12'), false);
        assert.equal(source.dependencyTileKeys.size, 0);
        session.abort(); assert.throws(() => source.retainTiles(['0_0'], { maxTiles: 1 }), /closed/);
    } finally { controller.abort(); session.abort(); }
});

test('unsubscribe and abort settle captured callback obligations without replay or retained holds', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'cancel-admission',
        loadPayload: async () => ({ features: [{ id: 'cancelled' }] }) });
    let calls = 0;
    const unsubscribe = source.subscribe({ onFetch: () => calls++ });
    const blocked = session.holdSources(['cancel-admission']);
    let admission;
    try {
        source.fetchTile(0, 0); source.pumpFetchQueue();
        await waitFor(() => source.pendingCallbacks.size === 1);
        admission = session.holdSources(['cancel-admission'], { drainQueued: true });
        assert.equal(admission.isReady(), false);
        unsubscribe();
        assert.equal(admission.isReady(), true); assert.equal(source.pendingCallbacks.size, 0);
        source.subscribe({ onFetch: () => calls++ });
        const aborted = session.holdSources(['cancel-admission'], { drainQueued: true });
        assert.equal(aborted.isReady(), false);
        session.abort(); controller.abort();
        assert.equal(aborted.isReady(), true); assert.equal(aborted.isCurrent(), false);
        assert.equal(source.sourceHolds, 0); assert.equal(source.pendingCallbacks.size, 0);
        aborted.release(); blocked.release(); admission.release();
        await waitFor(() => source.pendingTileCount === 0);
        assert.equal(calls, 0);
    } finally { blocked.release(); admission?.release(); controller.abort(); session.abort(); }
});

test('precompiled payload adapters use ordinary source delivery and bypass live HTTP only explicitly', async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0, intercepted = 0;
    globalThis.fetch = async () => { fetches++; return { ok: true, json: async () => ({ features: [{ id: 'live' }] }) }; };
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    try {
        for (const useBaked of [true, false]) {
            const source = session.getSource({ key: `payload:${useBaked}`, url: () => '/api/far', ring: 0, keepRing: 0,
                loadPayload: async ({ bbox, tileKey, signal, loadLive }) => {
                    intercepted++; assert.equal(tileKey, '0_0'); assert.ok(bbox.east > bbox.west); assert.equal(signal.aborted, false);
                    return useBaked ? { features: [{ id: 'baked' }] } : loadLive();
                } });
            let receive;
            const received = new Promise(resolve => { receive = resolve; });
            source.subscribe({ onFetch: receive }); source.ensureAround(0, 0);
            assert.deepEqual(await received, [{ id: useBaked ? 'baked' : 'live' }]);
            assert.equal(fetches, useBaked ? 0 : 1);
        }
        assert.equal(intercepted, 2);
    } finally { controller.abort(); session.abort(); globalThis.fetch = originalFetch; }
});

test('startup fetches the finite initial view before reveal without a second ring expansion', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
        urls.push(url);
        signal.addEventListener('abort', () => reject(
            signal.reason || new DOMException('Aborted', 'AbortError'),
        ), { once: true });
    });
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.505,
        anchorLon: 16.443,
        fetchController: controller,
    });
    try {
        _resetWorldReady();
        beginWorldBuild();
        const source = session.getSource({
            key: 'buildings:startup-support-test',
            label: 'buildings-startup-support-test',
            url: bbox => `/api/buildings?west=${bbox.west}&south=${bbox.south}`,
            tileM: 100,
            ring: 2,
            keepRing: 3,
        });
        source.ensureAround(0, 0);
        source.ensureAhead(0, 0, 0, { distanceM: 900, halfWidthM: 125 });
        await waitFor(() => urls.length > 0, 'initial source requests did not start');
        const initialKeys = [...source.tiles.keys()].sort();
        assert.ok(initialKeys.length > 25 && initialKeys.length < 100, 'one bounded ring and view corridor');
        assert.ok(source.tiles.has('0_-9'), 'the initial 900 m view is requested behind the curtain');
        assert.equal(session.getInitialLoadState().ready, false);

        forceWorldReady();
        source.ensureAround(0, 0);
        source.ensureAhead(0, 0, 0, { distanceM: 900, halfWidthM: 125 });
        assert.deepEqual([...source.tiles.keys()].sort(), initialKeys,
            'revealing an unchanged view does not start another data window');
    } finally {
        controller.abort();
        session.abort();
        _resetWorldReady();
        globalThis.fetch = originalFetch;
    }
});

test('route-ahead source work does not extend initial data readiness beyond observer tiles', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.505,
        anchorLon: 16.443,
        fetchController: controller,
    });
    const tiles = session.getSource({
        key: 'buildings:startup-data-boundary',
        label: 'buildings',
        tileM: 100,
        ring: 2,
        keepRing: 3,
        loadPayload: async () => ({ features: [] }),
    });
    try {
        for (const tileKey of ['0_0', '-1_0', '0_-1', '-1_-1']) {
            tiles.tiles.set(tileKey, { status: 'loaded' });
        }
        tiles.tiles.set('0_-9', { status: 'fetching' });
        assert.equal(session.getInitialLoadState().ready, true);
        assert.ok(tiles.getDebugCounts().pending > 0,
            'the larger ring and route corridor keep streaming after startup data is ready');
        tiles.tiles.get('-1_-1').status = 'building';
        assert.equal(session.getInitialLoadState().ready, false,
            'subscriber publication on an observer tile remains blocking');
    } finally {
        controller.abort();
        session.abort();
    }
});

test('loading prefetches a bounded successor behind held delivery and restores ordinary backpressure on reveal', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    let downloaded = 0, delivered = 0;
    const source = session.getSource({ key: 'buffered-ground', ring: 3, keepRing: 4, maxConcurrentRequests: 2,
        loadPayload: async () => { downloaded++; return { features: [] }; } });
    source.subscribe({ onFetch() { delivered++; } });
    const hold = session.holdSources(['buffered-ground']);
    try {
        _resetWorldReady(); beginWorldBuild(); source.ensureAround(0, 0);
        await waitFor(() => downloaded === 32 && session.getNetworkDebugState().active === 0);
        assert.equal(delivered, 0);
        assert.equal(source.pendingTileCount, 32);
        assert.ok(session.getNetworkDebugState().queued > 0, 'prefetch cannot consume the entire larger ring');
        forceWorldReady();
        source.fetchTile(4, 0); source.pumpFetchQueue();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(downloaded, 32, 'revealing does not grow an over-budget retained buffer');
        assert.equal(source.maxPendingTiles, 2, 'the ordinary source limit remains unchanged');
        hold.release();
        await waitFor(() => delivered === 50 && source.pendingTileCount === 0);
        assert.equal(session.getNetworkDebugState().queued, 0);
    } finally { hold.release(); controller.abort(); session.abort(); _resetWorldReady(); }
});

test('a heavy source can use a smaller startup successor buffer', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    let downloaded = 0;
    const source = session.getSource({
        key: 'bounded-buildings',
        ring: 3,
        keepRing: 4,
        maxConcurrentRequests: 2,
        startupPendingTileLimit: 6,
        loadPayload: async () => { downloaded++; return { features: [] }; },
    });
    source.subscribe({ onFetch() {} });
    const hold = session.holdSources(['bounded-buildings']);
    try {
        _resetWorldReady(); beginWorldBuild(); source.ensureAround(0, 0);
        await waitFor(() => downloaded === 6 && session.getNetworkDebugState().active === 0);
        assert.equal(source.pendingTileCount, 6);
        assert.ok(session.getNetworkDebugState().queued > 0);
    } finally { hold.release(); controller.abort(); session.abort(); _resetWorldReady(); }
});

test('startup source priority promotes ground inputs above scenery at equal view priority', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    try {
        const roads = session.getSource({
            key: 'priority-roads', startupPriority: 2, prioritizeByView: true,
        });
        const buildings = session.getSource({
            key: 'priority-buildings', startupPriority: -1, prioritizeByView: true,
        });
        _resetWorldReady(); beginWorldBuild();
        roads.notePriorityView(0, 0, { headingDeg: 0, fovDeg: 90 });
        buildings.notePriorityView(0, 0, { headingDeg: 0, fovDeg: 90 });
        const entry = { tx: 0, tz: 0 };
        const roadPriority = roads.tileViewPriority(entry);
        const buildingPriority = buildings.tileViewPriority(entry);
        assert.ok(
            roadPriority.tierRank > buildingPriority.tierRank,
            'roads should own the shared startup slot before an equally close building tile',
        );
        assert.ok(roadPriority.score > buildingPriority.score,
            'the scheduler score must carry the source startup priority');
        assert.equal(session.getDebugState()[0].startupPriority, 2);
        assert.equal(session.getDebugState()[1].startupPendingTileLimit, 32);
    } finally { controller.abort(); session.abort(); _resetWorldReady(); }
});

test('initial readiness waits for subscriber publication while the far horizon stays optional', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    let publish, finishHorizon;
    const publication = new Promise(resolve => { publish = resolve; });
    const horizon = new Promise(resolve => { finishHorizon = resolve; });
    const source = session.getSource({ key: 'near', label: 'roads', ring: 0, keepRing: 0,
        loadPayload: async () => ({ features: [{ id: 'near' }] }) });
    const far = session.getSource({ key: 'horizon', label: 'far-buildings', ring: 0, keepRing: 0,
        loadPayload: () => horizon });
    let delivered = false;
    source.subscribe({ onFetch() { delivered = true; return publication; } });
    try {
        source.ensureAround(0, 0); far.ensureAround(0, 0);
        await waitFor(() => delivered && far.getDebugCounts().fetching === 1);
        assert.deepEqual(session.getInitialLoadState(), {
            ready: false,
            pending: 1,
            failed: 0,
            sourceCount: 1,
            pendingSources: [{ key: 'near', label: 'roads', pending: 1, failed: 0 }],
        }, 'downloaded data is still pending until the subscriber finishes');
        publish();
        await waitFor(() => session.getInitialLoadState().ready);
        assert.equal(source.tiles.get('0_0').status, 'loaded');
        assert.equal(far.getDebugCounts().fetching, 1, 'the optional horizon is still downloading');
    } finally {
        publish(); finishHorizon({ features: [] }); controller.abort(); session.abort();
    }
});

test('independent sources share a simultaneous identical tile request', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return responseGate;
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.55,
        anchorLon: 16.38,
        fetchController: controller,
    });
    try {
        const sourceA = session.getSource({
            key: 'roads:graph',
            url: () => '/api/roads?bbox=same',
            ring: 0,
            keepRing: 0,
        });
        const sourceB = session.getSource({
            key: 'roads:lane-markings',
            url: () => '/api/roads?bbox=same',
            ring: 0,
            keepRing: 0,
        });
        let resolveA;
        let resolveB;
        const receivedA = new Promise((resolve) => { resolveA = resolve; });
        const receivedB = new Promise((resolve) => { resolveB = resolve; });
        sourceA.subscribe({ onFetch: resolveA });
        sourceB.subscribe({ onFetch: resolveB });
        sourceA.ensureAround(0, 0);
        sourceB.ensureAround(0, 0);
        await waitFor(() => fetchCalls === 1, 'the shared request did not start');
        assert.equal(fetchCalls, 1);

        releaseResponse({
            ok: true,
            json: async () => ({ features: [{ id: 1 }] }),
        });
        const [featuresA, featuresB] = await Promise.all([receivedA, receivedB]);
        assert.deepEqual(featuresA, [{ id: 1 }]);
        assert.equal(featuresA, featuresB, 'parsed response should be shared, not parsed twice');
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('a source can decode large JSON through a resumable frame task', async () => {
    const originalFetch = globalThis.fetch;
    let taskCreations = 0;
    let taskSteps = 0;
    const payload = JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: 12 }, (_, id) => ({
            type: 'Feature',
            properties: { id, label: `building-${id}` },
            geometry: null,
        })),
    });
    globalThis.fetch = async () => ({
        ok: true,
        text: async () => payload,
    });
    const createTextDecodeTask = (serialized) => {
        taskCreations += 1;
        const task = createFeatureCollectionJsonParseTask(serialized, {
            scanCharactersPerStep: 24,
            featuresPerStep: 1,
        });
        return {
            step() {
                taskSteps += 1;
                return task.step();
            },
        };
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.81,
        anchorLon: 15.98,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'buildings:cooperative-json-test',
            label: 'buildings',
            url: () => '/api/buildings-mesh?bbox=cooperative',
            ring: 0,
            keepRing: 0,
            createTextDecodeTask,
        });
        let resolveFeatures;
        const delivered = new Promise(resolve => { resolveFeatures = resolve; });
        source.subscribe({ onFetch: resolveFeatures });
        source.ensureAround(0, 0);

        const features = await delivered;
        assert.equal(taskCreations, 1);
        assert.ok(taskSteps > 12, 'the payload should be resumed across frame slices');
        assert.equal(features.length, 12);
        assert.equal(features[11].properties.label, 'building-11');
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('a shared source budgets each subscriber as an independent delivery item', async () => {
    const originalFetch = globalThis.fetch;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frame = 0;
    let nextFrameId = 1;
    const frameTimers = new Map();
    globalThis.requestAnimationFrame = (callback) => {
        const id = nextFrameId++;
        const timer = setTimeout(() => {
            frameTimers.delete(id);
            frame += 1;
            callback(performance.now());
        }, 0);
        frameTimers.set(id, timer);
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
        const timer = frameTimers.get(id);
        if (timer) clearTimeout(timer);
        frameTimers.delete(id);
    };
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ features: [{ id: 'shared-road' }] }),
    });

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.55,
        anchorLon: 16.38,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'roads:graph:subscriber-budget',
            label: 'road-graph',
            url: () => '/api/roads?bbox=subscriber-budget',
            ring: 0,
            keepRing: 0,
        });
        const deliveryFrames = [];
        source.subscribe({
            deliveryLabel: 'slow-road-consumer',
            onFetch: () => {
                deliveryFrames.push({ consumer: 'slow', frame });
                const deadline = performance.now() + 20;
                while (performance.now() < deadline) {
                    // Deliberately exhaust this delivery frame's budget.
                }
            },
        });
        source.subscribe({
            deliveryLabel: 'fast-road-consumer',
            onFetch: () => deliveryFrames.push({ consumer: 'fast', frame }),
        });

        source.ensureAround(0, 0);
        await waitFor(() => deliveryFrames.length === 2, 'both subscribers were not delivered');
        assert.deepEqual(deliveryFrames.map(entry => entry.consumer), ['slow', 'fast']);
        assert.notEqual(
            deliveryFrames[0].frame,
            deliveryFrames[1].frame,
            'one slow subscriber must not pull its siblings into the same frame',
        );
    } finally {
        controller.abort();
        session.abort();
        for (const timer of frameTimers.values()) clearTimeout(timer);
        if (originalRequestAnimationFrame === undefined) {
            delete globalThis.requestAnimationFrame;
        } else {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        }
        if (originalCancelAnimationFrame === undefined) {
            delete globalThis.cancelAnimationFrame;
        } else {
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        }
        globalThis.fetch = originalFetch;
    }
});

test('a pending geometry consumer retains source capacity but releases the network for other sources', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ features: [{ id: 'terrain-dependent-road' }] }),
    });

    let releaseBuild;
    const buildGate = new Promise(resolve => { releaseBuild = resolve; });
    let buildStarted = false;
    let supportStarted = false;
    let ordinaryStarted = false;
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.55,
        anchorLon: 16.38,
        fetchController: controller,
        maxConcurrentRequests: 1,
    });
    try {
        const source = session.getSource({
            key: 'roads:dependency-cycle',
            label: 'roads-dependency-cycle',
            url: () => '/api/roads/dependency-cycle',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({
            onFetch: async () => {
                buildStarted = true;
                await buildGate;
            },
        });
        source.ensureAround(0, 0);
        await waitFor(() => buildStarted, 'the terrain-dependent build did not start');

        const support = session.scheduleNetworkRequest({
            label: 'terrain-support-cell',
            supportLane: true,
            priority: { tier: 'support', score: 4e12 },
            run: () => { supportStarted = true; },
        });
        const ordinary = session.scheduleNetworkRequest({
            label: 'ordinary-tile',
            run: () => { ordinaryStarted = true; },
        });
        await waitFor(
            () => supportStarted,
            'terrain support could not bypass the occupied pipeline slot',
        );
        await support;
        await ordinary;
        assert.equal(ordinaryStarted, true, 'completed body consumption must release the socket slot');
        assert.equal(source.getDebugState().activeRequests, 0);
        assert.equal(source.getDebugState().pendingTiles, 1);
        assert.equal(source.tiles.get('0_0').status, 'building');

        releaseBuild();
        await waitFor(() => ordinaryStarted, 'ordinary work did not resume after publication');
        await ordinary;
        await waitFor(() => source.getDebugState().pendingTiles === 0);
    } finally {
        releaseBuild?.();
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('held decoded inputs are bounded per source while independent downloads and delivery continue', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller, maxConcurrentRequests: 1 });
    const loaded = [], delivered = [];
    const source = session.getSource({ key: 'held-buffer', maxConcurrentRequests: 2,
        loadPayload: async ({ tileKey }) => { loaded.push(tileKey); return { features: [{ id: tileKey }] }; } });
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    const hold = session.holdSources(['held-buffer']);
    try {
        for (let i = 0; i < 8; i++) source.fetchTile(i, 0);
        source.pumpFetchQueue();
        await waitFor(() => loaded.length === 2 && source.activeRequestCount === 0);
        let independentDelivered;
        const done = new Promise(resolve => { independentDelivered = resolve; });
        const independent = session.getSource({ key: 'independent-buffer',
            loadPayload: async () => ({ features: [{ id: 'independent' }] }) });
        independent.subscribe({ onFetch: independentDelivered });
        independent.fetchTile(0, 0); independent.pumpFetchQueue();
        await done;
        assert.deepEqual(loaded, ['0_0', '1_0']);
        assert.deepEqual(delivered, []);
        assert.equal(source.getDebugState().pendingTiles, 2);
        assert.equal(source.getDebugState().maxPendingTiles, 2);
        hold.release();
        await waitFor(() => delivered.length === 8, 'the bounded source did not resume after its hold');
        await waitFor(() => source.pendingTileCount === 0);
        assert.equal(new Set(delivered).size, 8);
        assert.equal(source.failed.size, 0);
    } finally { hold.release(); controller.abort(); session.abort(); }
});

test('a bounded successor can fetch through an older full decoded buffer', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller, maxConcurrentRequests: 1 });
    const downloaded = [], delivered = [];
    const source = session.getSource({
        key: 'successor-through-buffer',
        maxConcurrentRequests: 1,
        loadPayload: async ({ tileKey }) => {
            downloaded.push(tileKey);
            return { features: [{ id: tileKey }] };
        },
    });
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    const first = session.holdSources(['successor-through-buffer'], { handoffDelivery: true });
    let successor;
    try {
        source.fetchTile(0, 0); source.pumpFetchQueue();
        await waitFor(() => source.pendingTileCount === 1);
        first.armHandoff(); first.release();
        successor = session.holdSources(['successor-through-buffer'], {
            drainRequested: true,
            requestedTileKeys: ['1_0'],
            handoffDelivery: true,
            maxTiles: 1,
        });
        successor.request();
        await waitFor(() => delivered.includes('1_0'),
            'the admitted successor stayed behind the full decoded buffer');
        assert.deepEqual(downloaded, ['0_0', '1_0']);
        assert.deepEqual(delivered, ['1_0']);
        assert.equal(successor.isReady(), true);
    } finally {
        successor?.release(); first.release(); controller.abort(); session.abort();
    }
});

test('a bounded source starts the four tiles touching the observer before farther tiles', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = (url, { signal }) => {
        urls.push(url);
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(signal.reason || new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    };

    const anchorLat = 45.8131;
    const anchorLon = 15.9775;
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat,
        anchorLon,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'buildings:priority',
            label: 'buildings-priority',
            url: (bbox) => `/api/buildings?west=${bbox.west}&south=${bbox.south}`
                + `&east=${bbox.east}&north=${bbox.north}`,
            tileM: 100,
            ring: 1,
            keepRing: 1,
            maxConcurrentRequests: 4,
        });
        source.ensureAround(0, 0);

        await waitFor(() => urls.length === 4, 'the bounded near requests did not start');
        assert.equal(urls.length, 4);
        for (const rawUrl of urls) {
            const url = new URL(rawUrl, 'http://station3d.test');
            const west = Number(url.searchParams.get('west'));
            const east = Number(url.searchParams.get('east'));
            const south = Number(url.searchParams.get('south'));
            const north = Number(url.searchParams.get('north'));
            assert.ok(
                west === anchorLon || east === anchorLon,
                `${rawUrl} must touch the observer longitude`,
            );
            assert.ok(
                south === anchorLat || north === anchorLat,
                `${rawUrl} must touch the observer latitude`,
            );
        }
        const debug = session.getDebugState()[0];
        assert.equal(debug.fetching, 4);
        assert.equal(debug.queued, 5);
        assert.equal(debug.activeRequests, 4);
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('a view-prioritized source turns queued fetches toward the current camera', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    const releases = [];
    globalThis.fetch = (url, { signal }) => {
        urls.push(url);
        return new Promise((resolve, reject) => {
            releases.push(() => resolve({
                ok: true,
                json: async () => ({ features: [] }),
            }));
            signal.addEventListener('abort', () => {
                reject(signal.reason || new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    };

    const anchorLat = 45.8131;
    const anchorLon = 15.9775;
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat,
        anchorLon,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'buildings:view-priority',
            label: 'buildings-view-priority',
            url: (bbox) => `/api/buildings?west=${bbox.west}&south=${bbox.south}`,
            tileM: 100,
            ring: 1,
            keepRing: 1,
            maxConcurrentRequests: 1,
            prioritizeByView: true,
        });
        source.ensureAround(50, 50, { headingDeg: 0, fovDeg: 60 });
        await waitFor(() => urls.length === 1, 'the first view-prioritized request did not start');
        assert.equal(urls.length, 1, 'the observer-containing tile starts first');

        // Turn east while the first request is still in flight. It is not
        // cancelled, but the next free slot must use the latest camera.
        source.ensureAround(50, 50, { headingDeg: 90, fovDeg: 60 });
        releases.shift()();
        await waitFor(() => urls.length >= 2, 'the second view-prioritized request did not start');

        const second = new URL(urls[1], 'http://station3d.test');
        assert.ok(
            Number(second.searchParams.get('west')) > anchorLon,
            `${urls[1]} should be the tile east of the observer`,
        );
        const debug = session.getDebugState()[0];
        assert.equal(debug.prioritizeByView, true);
        assert.equal(
            Object.values(debug.queuedByVisibility).reduce((sum, count) => sum + count, 0),
            debug.queued,
            'every queued tile is classified for the diagnostics',
        );
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('stationary heading changes settle before replacing the ahead corridor', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    let now = 1_000;
    let fetchCalls = 0;
    Date.now = () => now;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
            ok: true,
            json: async () => ({ features: [] }),
        };
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.55,
        anchorLon: 16.38,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'roads:cab',
            url: (bbox) => `/api/roads?west=${bbox.west}&north=${bbox.north}`,
            ring: 0,
            keepRing: 10,
        });
        source.ensureAhead(0, 0, 0, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        await waitFor(() => fetchCalls > 0, 'the initial ahead corridor did not start');
        await new Promise(resolve => setTimeout(resolve, 0));
        const initialFetchCalls = fetchCalls;
        assert.ok(initialFetchCalls > 0);

        now += 100;
        source.ensureAhead(0, 0, 10, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        now += 100;
        source.ensureAhead(0, 0, 20, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        assert.equal(fetchCalls, initialFetchCalls);

        now += 299;
        source.ensureAhead(0, 0, 20, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        assert.equal(fetchCalls, initialFetchCalls);

        now += 1;
        source.ensureAhead(0, 0, 20, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        await waitFor(
            () => fetchCalls > initialFetchCalls,
            'the settled heading did not start its new corridor',
        );
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
    }
});

test('tiles that leave the view corridor are cancelled before they ever publish', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const urls = [];
    const releases = [];
    let now = 2_000;
    Date.now = () => now;
    globalThis.fetch = (url) => {
        urls.push(String(url));
        return new Promise((resolve) => {
            releases.push(() => resolve({
                ok: true,
                json: async () => ({ features: [] }),
            }));
        });
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.8131,
        anchorLon: 15.9775,
        fetchController: controller,
    });
    try {
        const evicted = [];
        const source = session.getSource({
            key: 'roads:view-cancel',
            url: (bbox) => `/api/roads?west=${bbox.west}&north=${bbox.north}`,
            ring: 0,
            keepRing: 0,
            maxConcurrentRequests: 1,
            prioritizeByView: true,
        });
        source.subscribe({ onEvict: tileKey => evicted.push(tileKey) });
        source.ensureAround(50, 50, { headingDeg: 0 });
        source.ensureAhead(50, 50, 0, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        await waitFor(() => urls.length === 1, 'the support request did not start');
        assert.equal(urls.length, 1, 'one support request owns the only network slot');

        now += 1;
        source.ensureAhead(50, 50, 90, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        now += 300;
        source.ensureAhead(50, 50, 90, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        assert.ok(evicted.includes('0_-1'), 'unseen old-heading work bypasses geometry grace');

        releases.shift()();
        await waitFor(() => urls.length >= 2, 'the new visible corridor did not take the freed slot');
        const second = new URL(urls[1], 'http://station3d.test');
        assert.ok(
            Number(second.searchParams.get('west')) > 15.9775,
            `${urls[1]} should be east in the new view, not stale north work`,
        );
        releases.shift()?.();
    } finally {
        while (releases.length > 0) releases.shift()?.();
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
    }
});

test('an active unseen corridor request is aborted so the new view gets its slot', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const started = [];
    const aborted = [];
    let now = 3_000;
    Date.now = () => now;
    globalThis.fetch = (url, { signal }) => {
        const requestUrl = String(url);
        started.push(requestUrl);
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                aborted.push(requestUrl);
                reject(signal.reason || new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    };

    const anchorLon = 15.9775;
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.8131,
        anchorLon,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'roads:active-view-cancel',
            url: (bbox) => `/api/roads?west=${bbox.west}&north=${bbox.north}`,
            ring: 0,
            keepRing: 0,
            maxConcurrentRequests: 2,
            prioritizeByView: true,
        });
        source.ensureAhead(50, 50, 0, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        await waitFor(() => started.length === 2, 'the initial two requests did not start');
        assert.equal(started.length, 2, 'support plus one north request consume both slots');
        const staleNorthUrl = started[1];

        now += 1;
        source.ensureAhead(50, 50, 90, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });
        now += 300;
        source.ensureAhead(50, 50, 90, {
            distanceM: 600,
            halfWidthM: 0,
            stepM: 100,
        });

        await waitFor(
            () => aborted.includes(staleNorthUrl),
            'the active request from the old hidden corridor was not aborted',
        );
        await waitFor(
            () => started.length >= 3,
            'cancelling the stale request did not free a slot for the new view',
        );
        const replacement = new URL(started[2], 'http://station3d.test');
        assert.ok(
            Number(replacement.searchParams.get('west')) > anchorLon,
            `${started[2]} should immediately refill the slot east of the observer`,
        );
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
    }
});

test('a hung tile request times out and remains retryable without camera movement', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (_url, { signal }) => {
        fetchCalls += 1;
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(signal.reason || new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        });
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.73,
        anchorLon: 16.06,
        fetchController: controller,
        requestTimeoutMs: 15,
        retryBaseMs: 1,
        retryMaxMs: 1,
    });
    try {
        const source = session.getSource({
            key: 'roads:timeout',
            label: 'roads-timeout',
            url: () => '/api/roads/hung',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({ onFetch: () => {} });
        source.ensureAround(0, 0);
        await waitFor(
            () => session.getDebugState()[0]?.fetchFailed === 1,
            'hung request was not classified as a fetch failure',
        );
        const debug = session.getDebugState()[0];
        assert.equal(debug.retrying, 1);
        assert.match(debug.failures[0].message, /timed out/i);

        await new Promise(resolve => setTimeout(resolve, 5));
        source.ensureAround(0, 0);
        await waitFor(() => fetchCalls >= 2, 'stationary retry did not start');
        assert.ok(fetchCalls >= 2, 'stationary ensureAround should start the due retry');
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});

test('HTTP and payload failures retry in place and recover to loaded state', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    let now = 10_000;
    let fetchCalls = 0;
    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return { ok: false, status: 503 };
        if (fetchCalls === 2) {
            return {
                ok: true,
                json: async () => ({ features: 'not-an-array' }),
            };
        }
        return {
            ok: true,
            json: async () => ({ features: [{ id: 'recovered-road' }] }),
        };
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.73,
        anchorLon: 16.06,
        fetchController: controller,
        retryBaseMs: 10,
        retryMaxMs: 10,
    });
    try {
        const source = session.getSource({
            key: 'roads:recovery',
            label: 'roads-recovery',
            url: () => '/api/roads/recovery',
            ring: 0,
            keepRing: 0,
        });
        let received = null;
        source.subscribe({ onFetch: features => { received = features; } });
        source.ensureAround(0, 0);
        await waitFor(() => session.getDebugState()[0]?.fetchFailed === 1);

        now += 20;
        source.ensureAround(0, 0);
        await waitFor(
            () => session.getDebugState()[0]?.failures[0]?.attempts === 2,
            'invalid JSON shape was not retried as a fetch-stage failure',
        );

        now += 20;
        source.ensureAround(0, 0);
        await waitFor(() => received?.[0]?.id === 'recovered-road');
        assert.equal(fetchCalls, 3);
        assert.equal(session.getDebugState()[0].loaded, 1);
        assert.equal(session.getDebugState()[0].retrying, 0);
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
        Math.random = originalMathRandom;
    }
});

test('build failures retain fetched data and retry only the failed subscriber', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    let now = 20_000;
    let fetchCalls = 0;
    let flakyBuildCalls = 0;
    let stableBuildCalls = 0;
    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
            ok: true,
            json: async () => ({ features: [{ id: 'one-road' }] }),
        };
    };

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.73,
        anchorLon: 16.06,
        fetchController: controller,
        retryBaseMs: 10,
        retryMaxMs: 10,
    });
    try {
        const source = session.getSource({
            key: 'roads:build-recovery',
            label: 'roads-build-recovery',
            url: () => '/api/roads/build-recovery',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({
            onFetch: async () => {
                flakyBuildCalls += 1;
                if (flakyBuildCalls === 1) throw new Error('GPU allocation failed');
            },
        });
        source.subscribe({
            onFetch: async () => {
                stableBuildCalls += 1;
            },
        });
        source.ensureAround(0, 0);
        await waitFor(
            () => session.getDebugState()[0]?.buildFailed === 1,
            'subscriber failure was not classified as a build failure',
        );
        assert.equal(fetchCalls, 1);
        assert.equal(flakyBuildCalls, 1);
        assert.equal(stableBuildCalls, 1);

        now += 20;
        source.ensureAround(0, 0);
        await waitFor(() => session.getDebugState()[0]?.loaded === 1);
        assert.equal(fetchCalls, 1, 'build retry must reuse the retained payload');
        assert.equal(flakyBuildCalls, 2);
        assert.equal(stableBuildCalls, 1, 'successful sibling must not rebuild');
        assert.equal(session.getDebugState()[0].buildFailed, 0);
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
        Math.random = originalMathRandom;
    }
});

test('repeated client build failures never report the data source as unreachable', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    let now = 30_000;
    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ features: [{ id: 'valid-building' }] }),
    });

    const healthHistory = [];
    const unsubscribeHealth = onTileStreamHealth(labels => healthHistory.push([...labels]));
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.50,
        anchorLon: 16.44,
        fetchController: controller,
        retryBaseMs: 10,
        retryMaxMs: 10,
    });
    try {
        const source = session.getSource({
            key: 'buildings:client-failure',
            label: 'buildings-client-failure',
            url: () => '/api/buildings/valid',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({
            onFetch: () => { throw new Error('GPU geometry build failed'); },
        });
        source.ensureAround(0, 0);
        for (let attempts = 1; attempts <= 3; attempts++) {
            await waitFor(
                () => session.getDebugState()[0]?.failures[0]?.attempts === attempts,
                `build attempt ${attempts} was not recorded`,
            );
            if (attempts < 3) {
                now += 20;
                source.ensureAround(0, 0);
            }
        }
        const debug = session.getDebugState()[0];
        assert.equal(debug.buildFailed, 1);
        assert.equal(debug.fetchFailureStreak, 0);
        assert.equal(
            healthHistory.some(labels => labels.includes('buildings-client-failure')),
            false,
        );
    } finally {
        unsubscribeHealth();
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
        Math.random = originalMathRandom;
    }
});

test('subscriber-declared generation cancellation is a successful delivery, not a retry', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    let fetchCalls = 0;
    let buildCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return {
            ok: true,
            json: async () => ({ features: [{ id: 'retained-generation' }] }),
        };
    };
    console.warn = (...args) => warnings.push(args);

    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.50,
        anchorLon: 16.44,
        fetchController: controller,
        retryBaseMs: 10,
        retryMaxMs: 10,
    });
    try {
        const source = session.getSource({
            key: 'buildings:expected-cancellation',
            label: 'far-buildings',
            url: () => '/api/buildings/retained-generation',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({
            onFetch: async () => {
                buildCalls += 1;
                const error = new Error('far-building-tile-cancelled');
                error.code = 'cancelled';
                throw error;
            },
            isExpectedBuildCancellation: error => error?.code === 'cancelled',
        });
        source.ensureAround(0, 0);
        await waitFor(() => session.getDebugState()[0]?.loaded === 1);

        assert.equal(fetchCalls, 1);
        assert.equal(buildCalls, 1);
        assert.equal(session.getDebugState()[0].buildFailed, 0);
        assert.equal(warnings.length, 0, 'expected cancellation must stay out of the console');

        await new Promise(resolve => setTimeout(resolve, 25));
        source.ensureAround(0, 0);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(buildCalls, 1, 'the retained successor owns replacement; do not retry it');
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        console.warn = originalWarn;
    }
});

test('consecutive fetch failures report an outage and valid data clears it', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    let now = 40_000;
    let available = false;
    Date.now = () => now;
    Math.random = () => 0;
    globalThis.fetch = async () => available
        ? { ok: true, json: async () => ({ features: [] }) }
        : { ok: false, status: 503 };

    const healthHistory = [];
    const unsubscribeHealth = onTileStreamHealth(labels => healthHistory.push([...labels]));
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 43.50,
        anchorLon: 16.44,
        fetchController: controller,
        retryBaseMs: 10,
        retryMaxMs: 10,
    });
    try {
        const source = session.getSource({
            key: 'roads:server-health',
            label: 'roads-server-health',
            url: () => '/api/roads/health',
            ring: 0,
            keepRing: 0,
        });
        source.subscribe({ onFetch: () => {} });
        source.ensureAround(0, 0);
        for (let attempts = 1; attempts <= 3; attempts++) {
            await waitFor(
                () => session.getDebugState()[0]?.failures[0]?.attempts === attempts,
                `fetch attempt ${attempts} was not recorded`,
            );
            if (attempts < 3) {
                now += 20;
                source.ensureAround(0, 0);
            }
        }
        assert.deepEqual(healthHistory.at(-1), ['roads-server-health']);
        assert.equal(session.getDebugState()[0].fetchFailureStreak, 3);

        available = true;
        now += 20;
        source.ensureAround(0, 0);
        await waitFor(() => session.getDebugState()[0]?.loaded === 1);
        assert.deepEqual(healthHistory.at(-1), []);
        assert.equal(session.getDebugState()[0].fetchFailureStreak, 0);
    } finally {
        unsubscribeHealth();
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
        Date.now = originalDateNow;
        Math.random = originalMathRandom;
    }
});

// --- corridor-departure grace -----------------------------------------------
//
// Retention beyond keepRing is corridor-shaped, so turning on the spot sweeps
// tiles out of it. Before this, they were torn down the instant they left and
// rebuilt the moment you turned back — the worst case being standing still and
// looking round, which paid twice for geometry that was already built.
test('a tile that just left the view corridor is kept, briefly and boundedly', async () => {
    const { withinAheadGrace } = await import('../core/shared-tile-session.js');
    const grace = { graceMs: 15000, heldCount: 3, maxHeld: 64 };

    // Just swept out of the corridor: keep it, so turning back is free.
    assert.equal(withinAheadGrace(1_000, 1_500, grace), true);
    assert.equal(withinAheadGrace(1_000, 15_999, grace), true);

    // Long gone: let it go, or a session accumulates every tile it ever faced.
    assert.equal(withinAheadGrace(1_000, 16_001, grace), false);

    // Never in the corridor at all — no stamp, no grace. This is the ordinary
    // out-of-keepRing tile, whose eviction must be unchanged.
    assert.equal(withinAheadGrace(undefined, 5_000, grace), false);
    assert.equal(withinAheadGrace(NaN, 5_000, grace), false);

    // Over the cap nothing gets grace, so a full 360-degree sweep cannot pin
    // every tile in the annulus. Detailed buildings are the heaviest payload
    // streamed; this bound is what keeps the fix from becoming a leak.
    assert.equal(withinAheadGrace(1_000, 1_500, { ...grace, heldCount: 65 }), false);

    // A disabled/absent grace behaves exactly as before the change.
    assert.equal(withinAheadGrace(1_000, 1_500, { ...grace, graceMs: 0 }), false);
    assert.equal(withinAheadGrace(1_000, 1_500, {}), false);
});

test('authored corridor tiles remain resident outside the moving keep ring', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ features: [] }),
    });
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.81,
        anchorLon: 15.98,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'roads:pinned-campaign-test',
            label: 'roads-pinned-campaign-test',
            url: () => '/api/roads/pinned-campaign-test',
            tileM: 100,
            ring: 0,
            keepRing: 0,
        });
        const evicted = [];
        source.subscribe({ onFetch: () => {}, onEvict: key => evicted.push(key) });
        source.ensurePinnedPoints([{ x: 250, z: 50 }], {
            signature: 'campaign-corridor-v1',
            priorityX: 250,
            priorityZ: 50,
        });
        assert.equal(source.isLoadedAtLocal(250, 50), false);
        await waitFor(() => session.getDebugState()[0]?.loaded === 1);
        assert.equal(source.isLoadedAtLocal(250, 50), true);
        assert.equal(source.isLoadedAtLocal(1050, 50), false);
        assert.equal(session.getDebugState()[0].pinnedTiles, 1);

        source.ensureAround(1050, 50);
        await waitFor(() => session.getDebugState()[0]?.loaded === 2);
        assert.equal(source.isLoadedAtLocal(1050, 50), true);
        assert.equal(evicted.includes('2_0'), false);
        assert.equal(session.getDebugState()[0].pinnedTiles, 1);
    } finally {
        controller.abort();
        session.abort();
        globalThis.fetch = originalFetch;
    }
});
