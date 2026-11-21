import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTileSession } from '../core/shared-tile-session.js';
import { createGroundSourceAdmission } from '../core/ground-source-admission.js';

async function until(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('requested source admission did not progress');
}

test('managed admission hands buffered callbacks directly to the next bounded corridor', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller, maxConcurrentRequests: 2 });
    let releaseFirst;
    const firstPayload = new Promise(resolve => { releaseFirst = resolve; });
    const curbsSeen = new Set(), masks = new Set();
    let peakPending = 0, firstStarted = false, captures = 0, admission, lease;
    const curbs = session.getSource({ key: 'curbs', ring: 0, keepRing: 0, maxConcurrentRequests: 2,
        loadPayload: async ({ tileKey }) => {
            peakPending = Math.max(peakPending, curbs.pendingTileCount);
            if (tileKey === '0_0') { firstStarted = true; await firstPayload; }
            return { features: [{ id: tileKey }] };
        } });
    const roads = session.getSource({ key: 'roads', maxConcurrentRequests: 2,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    curbs.subscribe({ onFetch: (_features, key) => curbsSeen.add(key) });
    roads.subscribe({ onFetch: (_features, key) => masks.add(key) });
    const expected = Array.from({ length: 6 }, (_, i) => `${i}_0`);
    try {
        for (let i = 0; i < 6; i++) curbs.fetchTile(i, 0);
        curbs.pumpFetchQueue();
        admission = createGroundSourceAdmission({ session,
            sourceKeys: ['curbs', 'roads'], firstSources: ['curbs'], drainRequested: true,
            maxDependencyTiles: 8, layersReady: () => true,
            captureDependencies() {
                captures++;
                assert.deepEqual([...curbsSeen].sort(), expected, 'all requested inputs precede dependency capture');
                return [{ sourceKey: 'roads', tileKeys: [...curbsSeen],
                    isReady: () => expected.every(key => masks.has(key)) }];
            } });
        assert.equal(admission.poll(), null, 'an empty callback queue is not a completed requested batch');
        await until(() => firstStarted);
        curbs.ensureAround(8000, 0);
        releaseFirst();
        await until(() => { lease = admission.poll(); return !!lease; });
        assert.deepEqual([...curbsSeen].sort(), expected);
        assert.deepEqual([...masks].sort(), expected);
        assert.equal(captures, 1, 'capture dependencies after the complete finite curb input set');
        assert.ok(peakPending <= 2, 'the ordinary decoded-input limit remains in force');
        assert.ok(expected.every(key => curbs.tiles.has(key)), 'movement retains admitted input membership');
        assert.equal(lease.isCurrent(), true);
        lease.release();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(curbsSeen.has('40_0'), false,
            'publication release cannot expose buffered callbacks before successor admission');
        const successor = createGroundSourceAdmission({ session,
            sourceKeys: ['curbs', 'roads'], firstSources: ['curbs'], drainRequested: true,
            requestedTileKeys: ['40_0'], maxDependencyTiles: 8, layersReady: () => true,
            captureDependencies: () => [{ sourceKey: 'roads', tileKeys: ['40_0'],
                isReady: () => masks.has('40_0') }],
        });
        let successorLease;
        await until(() => { successorLease = successor.poll(); return !!successorLease; });
        assert.equal(curbsSeen.has('40_0'), true);
        successorLease.release();
        assert.equal(roads.dependencyTileKeys.size, 0);
    } finally { releaseFirst(); admission?.release(); controller.abort(); session.abort(); }
});

test('bootstrap admission drains named support tiles without waiting for the wider requested corridor', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller, maxConcurrentRequests: 2 });
    let releaseSupport, releaseAhead;
    const supportPayload = new Promise(resolve => { releaseSupport = resolve; });
    const aheadPayload = new Promise(resolve => { releaseAhead = resolve; });
    const delivered = [];
    const source = session.getSource({ key: 'roads', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => {
            if (tileKey === '0_0') await supportPayload;
            if (tileKey === '5_0') await aheadPayload;
            return { features: [{ id: tileKey }] };
        } });
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    let hold;
    try {
        source.fetchTile(0, 0); source.fetchTile(5, 0); source.pumpFetchQueue();
        await until(() => source.tiles.get('0_0')?.status === 'fetching'
            && source.tiles.get('5_0')?.status === 'fetching');
        hold = session.holdSources(['roads'], { drainRequested: true,
            requestedTileKeys: ['0_0'], maxTiles: 4 });
        assert.equal(hold.isReady(), false);
        releaseSupport();
        await until(() => hold.isReady());
        assert.deepEqual(delivered, ['0_0']);
        assert.equal(source.tiles.get('5_0')?.status, 'fetching');
        hold.release();
        releaseAhead();
        await until(() => delivered.includes('5_0'));
    } finally { releaseSupport(); releaseAhead(); hold?.release(); controller.abort(); session.abort(); }
});

test('an explicit requested batch does not absorb older callbacks for other tiles', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97,
        fetchController: controller, maxConcurrentRequests: 2 });
    const delivered = [];
    const source = session.getSource({ key: 'roads', ring: 0, keepRing: 0,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    source.subscribe({ onFetch: (_features, key) => delivered.push(key) });
    const blocker = session.holdSources(['roads'], { drainQueued: true, maxTiles: 2 });
    let bounded;
    try {
        source.fetchTile(0, 0); source.fetchTile(1, 0); source.pumpFetchQueue();
        await until(() => source.tiles.get('0_0')?.status === 'building'
            && source.tiles.get('1_0')?.status === 'building');
        bounded = session.holdSources(['roads'], { drainQueued: true, drainRequested: true,
            requestedTileKeys: ['0_0'], maxTiles: 1 });
        blocker.release(); bounded.request();
        await until(() => bounded.isReady());
        assert.deepEqual(delivered, ['0_0']);
        bounded.release();
        await until(() => delivered.includes('1_0'));
    } finally { blocker.release(); bounded?.release(); controller.abort(); session.abort(); }
});

test('priority capture keeps required support and bounds the nearest pending source tiles', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'roads', ring: 0, keepRing: 0, prioritizeByView: true });
    try {
        source.notePriorityView(1000, 0, { headingDeg: 90, fovDeg: 90 });
        for (const tx of [0, 3, 4, 5, 6]) source.fetchTile(tx, 0);
        const keys = session.capturePrioritySourceTileKeys('roads', {
            maxTiles: 3, includeTileKeys: ['0_0'],
        });
        assert.equal(keys[0], '0_0');
        assert.equal(keys.length, 3);
        assert.ok(keys.includes('5_0'), 'the tile containing the route-ahead focus is selected');
    } finally { controller.abort(); session.abort(); }
});

test('requested source capacity rejection releases holds already acquired from siblings', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const first = session.getSource({ key: 'first' }), second = session.getSource({ key: 'second' });
    try {
        first.fetchTile(0, 0);
        second.fetchTile(0, 0); second.fetchTile(1, 0);
        assert.throws(() => session.holdSources(['first', 'second'], { drainRequested: true, maxTiles: 1 }),
            error => error.code === 'ground-generation-capacity');
        assert.equal(first.sourceHolds, 0);
        assert.equal(second.sourceHolds, 0);
    } finally { controller.abort(); session.abort(); }
});

test('a captured request failure keeps admission pending and retries through the existing source backoff', async () => {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    let attempts = 0, delivered = false;
    const source = session.getSource({ key: 'retry', loadPayload: async () => {
        if (++attempts === 1) throw new Error('transient source failure');
        return { features: [{ id: 'recovered' }] };
    } });
    source.subscribe({ onFetch: () => { delivered = true; } });
    source.fetchTile(0, 0);
    const hold = session.holdSources(['retry'], { drainRequested: true, maxTiles: 1 });
    try {
        hold.request();
        await until(() => source.failed.has('0_0'));
        assert.equal(hold.isReady(), false);
        hold.request();
        assert.equal(attempts, 1, 'admission does not bypass source retry backoff');
        source.failed.get('0_0').nextTryAt = 0;
        hold.request();
        await until(() => delivered && hold.isReady());
        assert.equal(attempts, 2);
        assert.equal(source.failed.size, 0);
    } finally { hold.release(); controller.abort(); session.abort(); }
});
