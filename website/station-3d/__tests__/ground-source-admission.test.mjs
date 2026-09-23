import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSharedTileSession, __resetEvictionBudgetForTests } from '../core/shared-tile-session.js';
import { createGroundSourceAdmission } from '../core/ground-source-admission.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { createPublishedGroundReadSlot } from '../core/published-ground-read.js';
import { initialWorldSupportTileKeys } from '../core/initial-world-support.js';
import { createHeldDeliveryWake } from '../core/held-delivery-wake.js';
import { beginWorldBuild, isWorldBuilding, noteWorldPhase, noteWorldQueueActive,
    noteWorldQueueIdle, _resetWorldReady } from '../core/world-ready.js';

async function until(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('source admission did not progress');
}

test('admission drains expired source membership before holding the next generation', (t) => {
    let now = 1000, captures = 0;
    t.mock.method(performance, 'now', () => now);
    __resetEvictionBudgetForTests();
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const keys = ['0_0', '50_50', '51_51', '52_52'];
    const liveCurbs = new Set(keys), liveMasks = new Set(keys);
    const sources = [liveCurbs, liveMasks].map((live, index) => {
        const source = session.getSource({ key: index ? 'roads' : 'curbs', ring: 0, keepRing: 0 });
        source.lastTx = 0; source.lastTz = 0;
        for (const key of keys) source.tiles.set(key, { status: 'loaded', features: [{ id: key }] });
        source.subscribers.add({ onEvict(key) { live.delete(key); now += 3; } });
        return source;
    });
    let admission, lease;
    try {
        // One expensive teardown consumes the slice; the old window still has
        // pending evictions when the next ground generation is requested.
        sources[0].evictOutsideRing(0, 0);
        assert.equal(liveCurbs.size, 3);
        admission = createGroundSourceAdmission({ session, sourceKeys: ['curbs', 'roads'], firstSources: ['curbs'],
            drainRequested: true, maxDependencyTiles: 8, layersReady: () => true,
            captureDependencies() {
                captures++;
                assert.deepEqual([...liveCurbs], ['0_0'], 'expired curbs cannot request their roads again');
                return [{ sourceKey: 'roads', tileKeys: [...liveCurbs],
                    isReady: () => [...liveCurbs].every(key => liveMasks.has(key)) }];
            },
        });
        assert.equal(admission.poll(), null, 'bounded cleanup defers admission');
        assert.equal(captures, 0);
        assert.equal(sources[0].sourceHolds, 0, 'an early hold must not pin the remaining eviction backlog');
        for (let frame = 0; frame < 8 && !lease; frame++) {
            now += 20;
            lease = admission.poll();
        }
        assert.ok(lease?.isCurrent(), 'finite eviction work eventually admits the new window');
        assert.equal(captures, 1);
        assert.deepEqual([...liveMasks], ['0_0']);
    } finally { admission?.release(); controller.abort(); session.abort(); }
});

test('road and curb ownership transfers their old startup gates while shared publication still holds reveal', () => {
    const runtime = vm.createContext({
        groundCoordinator: null, groundManaged: false,
        initialNearRoadTileKeys: new Set(['0_0']), initialNearCurbTileKeys: new Set(['0_0']),
        roadFormationModel: { managePublications() {} }, roadVerticalAlignmentModel: { managePublications() {} },
        noteWorldQueueIdle,
    });
    const methods = [['roads', 'prepareAlignmentSourcesGroundSteps'], ['curbs', 'groundSourceDependencies']]
        .map(([file, next]) => {
            const source = readFileSync(new URL(`../world/${file}.js`, import.meta.url), 'utf8');
            const start = source.indexOf('    manageGroundPublications(');
            return vm.runInContext(`({${source.slice(start, source.indexOf(`    ${next}`, start))}})`, runtime);
        });
    try {
        _resetWorldReady(); beginWorldBuild();
        for (const queue of ['world-data', 'roads', 'curbs']) noteWorldQueueActive(queue);
        noteWorldPhase('deferred-built');
        for (const layer of methods) {
            layer.manageGroundPublications({});
            assert.equal(isWorldBuilding(), true, 'ownership transfer cannot reveal an unpublished world');
        }
        noteWorldQueueIdle('world-data');
        assert.equal(isWorldBuilding(), false, 'old tile gates cannot strand a completed shared publication');
    } finally { _resetWorldReady(); }
});

test('a sealed curb batch admits its later road masks without admitting later curbs or waiting for publication', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const curbs = session.getSource({ key: 'curbs', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const roads = session.getSource({ key: 'roads', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const curbKeys = new Set(), masks = new Set();
    let publish, captures = 0, inputReady = true;
    const publication = new Promise(resolve => { publish = resolve; });
    curbs.subscribe({ onFetch: (_features, key) => { curbKeys.add(key); } });
    roads.subscribe({ onFetch: () => publication, deliveryLabel: 'road-geometry' });
    roads.subscribe({ onFetch: (_features, key) => { masks.add(key); }, onEvict: key => masks.delete(key) });
    const initial = session.holdSources(['curbs']);
    let admission, lease;
    try {
        curbs.fetchTile(0, 0); curbs.pumpFetchQueue();
        await until(() => curbs.pendingCallbacks.size === 1);
        admission = createGroundSourceAdmission({ session, sourceKeys: ['curbs', 'roads'], firstSources: ['curbs'],
            maxDependencyTiles: 4, layersReady: () => inputReady,
            captureDependencies() {
                captures++; assert.deepEqual([...curbKeys], ['0_0']);
                return [{ sourceKey: 'roads', tileKeys: [...curbKeys], isReady: () => masks.has('0_0') }];
            } });
        initial.release();
        await until(() => curbKeys.has('0_0'));
        assert.equal(masks.has('0_0'), false);
        assert.equal(admission.poll(), null);
        // Movement may evict unrelated roads; the requested mask is retained.
        roads.ensureAround(8000, 0);
        curbs.fetchTile(1, 0); curbs.pumpFetchQueue();
        inputReady = false;
        await until(() => { admission.poll(); return masks.has('0_0'); });
        assert.equal(admission.poll(), null, 'asynchronous source registration is still required');
        assert.equal(roads.tiles.get('0_0').status, 'building', 'geometry awaits the eventual publication');
        inputReady = true;
        await until(() => { lease = admission.poll(); return !!lease; });
        assert.equal(lease.isCurrent(), true); assert.equal(captures, 1);
        assert.deepEqual([...curbKeys], ['0_0']);
        assert.equal(roads.dependencyTileKeys.size, 1);
        lease.release(); publish();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(curbKeys.has('1_0'), false,
            'publication release preserves the delivery boundary until successor admission');
        assert.equal(roads.dependencyTileKeys.size, 0);
        assert.equal(curbs.sourceHolds, 0); assert.equal(roads.sourceHolds, 0);
    } finally { publish(); initial.release(); admission?.release(); controller.abort(); session.abort(); }
});

test('an empty successor curb batch still admits retained road-mask dependencies', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller });
    const curbs = session.getSource({ key: 'curbs', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const roads = session.getSource({ key: 'roads', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const curbKeys = new Set(), masks = new Set();
    curbs.subscribe({ onFetch: (_features, key) => curbKeys.add(key) });
    roads.subscribe({ onFetch: (_features, key) => masks.add(key) });
    let admission, lease;
    try {
        curbs.fetchTile(0, 0); curbs.pumpFetchQueue();
        await until(() => curbKeys.has('0_0'));
        admission = createGroundSourceAdmission({
            session,
            sourceKeys: ['curbs', 'roads'],
            firstSources: ['curbs'],
            drainRequested: true,
            requestedTileKeys: [],
            maxDependencyTiles: 4,
            layersReady: () => true,
            captureDependencies: () => [{
                sourceKey: 'roads',
                tileKeys: [...curbKeys],
                isReady: () => masks.has('0_0'),
            }],
        });
        await until(() => { lease = admission.poll(); return !!lease; });
        assert.equal(masks.has('0_0'), true,
            'the retained curb model must not wait forever for a road mask behind an empty hold');
        assert.equal(lease.isCurrent(), true);
    } finally { admission?.release(); controller.abort(); session.abort(); }
});

test('a priority curb subset still admits the complete retained road-mask closure', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller });
    const curbs = session.getSource({ key: 'curbs', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const roads = session.getSource({ key: 'roads', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const curbKeys = new Set(), masks = new Set();
    curbs.subscribe({ onFetch: (_features, key) => curbKeys.add(key) });
    roads.subscribe({ onFetch: (_features, key) => masks.add(key) });
    let admission, lease;
    try {
        curbs.fetchTile(0, 0); curbs.fetchTile(1, 0); curbs.pumpFetchQueue();
        await until(() => curbKeys.size === 2);
        admission = createGroundSourceAdmission({
            session,
            sourceKeys: ['curbs', 'roads'],
            firstSources: ['curbs'],
            drainRequested: true,
            requestedTileKeys: ['0_0'],
            maxDependencyTiles: 4,
            layersReady: () => true,
            captureDependencies: () => [{
                sourceKey: 'roads',
                tileKeys: [...curbKeys],
                isReady: () => [...curbKeys].every(key => masks.has(key)),
            }],
        });
        await until(() => { lease = admission.poll(); return !!lease; });
        assert.deepEqual([...masks].sort(), ['0_0', '1_0'],
            'dependency tiles outside the priority curb subset must cross the remaining-source hold');
        assert.equal(lease.isCurrent(), true);
    } finally { admission?.release(); controller.abort(); session.abort(); }
});

test('dependency capacity rejection and cancellation release every admission hold', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const curbs = session.getSource({ key: 'curbs' }), roads = session.getSource({ key: 'roads' });
    try {
        const create = tileKeys => createGroundSourceAdmission({ session,
            sourceKeys: ['curbs', 'roads'], firstSources: ['curbs'], maxDependencyTiles: 1, layersReady: () => true,
            captureDependencies: () => [{ sourceKey: 'roads', tileKeys, isReady: () => false }] });
        const excessive = create(['0_0', '1_0']);
        assert.throws(() => excessive.poll(), { code: 'ground-generation-capacity' });
        assert.equal(curbs.sourceHolds, 0); assert.equal(roads.sourceHolds, 0);
        const cancelled = create(['0_0']); assert.equal(cancelled.poll(), null);
        assert.equal(curbs.sourceHolds, 1); assert.equal(roads.dependencyTileKeys.size, 1);
        assert.equal(cancelled.release(), true); assert.equal(cancelled.release(), false);
        assert.equal(curbs.sourceHolds, 0); assert.equal(roads.dependencyTileKeys.size, 0);
    } finally { controller.abort(); session.abort(); }
});

test('the production world admission requests missing curb masks before handing a sealed source lease to the compiler', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const tileFeatures = new Map(), maskTileFeatures = new Map();
    let releaseSupportRoad;
    const supportRoad = new Promise(resolve => { releaseSupportRoad = resolve; });
    for (const key of ['roads:curbs', 'roads:cab', 'roads:graph', 'roads:vertical-alignments']) {
        session.getSource({ key, loadPayload: async ({ tileKey }) => {
            if (key === 'roads:cab' && tileKey === '-1_0') await supportRoad;
            return { features: [{ id: tileKey }] };
        } });
    }
    const curbs = session.getSource({ key: 'roads:curbs' });
    const roads = session.getSource({ key: 'roads:cab' });
    roads.subscribe({ onFetch: (rows, key) => maskTileFeatures.set(key, rows) });
    curbs.subscribe({ onFetch: (rows, key) => tileFeatures.set(key, rows) });
    const curbSource = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');
    const dependencyMethod = curbSource.slice(curbSource.indexOf('    groundSourceDependencies('),
        curbSource.indexOf('    *groundTileKeysSteps('));
    const worldSource = readFileSync(new URL('../world/ground-generations.js', import.meta.url), 'utf8');
    let lease = null, admissions = 0, buildersReady = false, managed = 0;
    const realm = vm.createContext({ tileFeatures, maskTileFeatures, createGroundSourceAdmission,
        createPublishedGroundReadSlot, initialWorldSupportTileKeys, createHeldDeliveryWake,
        isWorldBuilding: () => true,
        GROUND_ROAD_SOURCE_KEYS: ['roads:cab', 'roads:graph', 'roads:vertical-alignments', 'roads:curbs'],
        GROUND_GENERATION_LIMITS, FRAME_CHUNK_REPEAT_ITEM: Symbol(), FRAME_CHUNK_DEFER_ITEM: Symbol(),
        FRAME_CHUNK_WAIT_ITEM: Symbol(),
        createFrameChunkQueue: () => ({ dispose() {} }), registerBackgroundActivityReader: () => () => {},
        createGroundGenerationCoordinator({ admit }) { return {
            invalidate() {}, close() { lease?.release(); }, snapshot: () => ({ pending: 1 }), isSettled: () => false,
            onFrame() { if (!lease) { lease = admit(); if (lease) admissions++; } },
        }; } });
    const dependencies = vm.runInContext(`({${dependencyMethod}})`, realm);
    vm.runInContext(worldSource.slice(worldSource.indexOf('export function createWorldGroundGenerations('))
        .replace('export function ', 'function '), realm);
    const layer = () => ({ groundReady: () => buildersReady, manageGroundPublications() { managed++; } });
    const world = realm.createWorldGroundGenerations({ ctx: { terrainSource: {}, publishedTerrain: {}, sharedTileSession: session },
        layers: { curbs: { ...layer(), ...dependencies }, terrain: { ...layer(), connectGroundCoordinator() {} },
            roads: layer(), rails: layer(), structures: layer() }, isCurrent: () => true });
    try {
        curbs.fetchTile(0, 0); curbs.pumpFetchQueue();
        await until(() => tileFeatures.has('0_0'));
        assert.equal(maskTileFeatures.has('0_0'), false);
        // This is an observer-support road tile which reproduced the empty first
        // publication: it is already requested, but has no callback sequence
        // yet because its response is still in flight.
        roads.fetchTile(-1, 0); roads.pumpFetchQueue();
        await until(() => roads.tiles.get('-1_0')?.status === 'fetching');
        world.onFrame({ x: 0, z: 0 });
        assert.equal(admissions, 0, 'a candidate started before its missing mask was requested');
        await until(() => { world.onFrame({ x: 0, z: 0 }); return maskTileFeatures.has('0_0'); });
        assert.equal(admissions, 0, 'an in-flight requested road cannot fall outside bootstrap admission');
        releaseSupportRoad();
        await until(() => { world.onFrame({ x: 0, z: 0 }); return maskTileFeatures.has('-1_0'); });
        assert.equal(admissions, 0, 'existing builders must finish before their ownership changes');
        assert.equal(managed, 0);
        assert.equal(curbs.sourceHolds, 1, 'input delivery must seal before waiting for those builders');
        curbs.fetchTile(1, 0); curbs.pumpFetchQueue();
        await until(() => curbs.pendingCallbacks.size === 1);
        assert.equal(tileFeatures.has('1_0'), false, 'later arrivals cannot extend the initial legacy build');
        buildersReady = true;
        await until(() => { world.onFrame({ x: 0, z: 0 }); return admissions === 1; });
        assert.equal(maskTileFeatures.has('0_0'), true);
        assert.equal(lease.isCurrent(), true);
        assert.equal(managed, 5);
    } finally { releaseSupportRoad(); world.close(); controller.abort(); session.abort(); }
});
