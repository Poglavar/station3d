// Stale tiles are evicted in a bounded slice, not all at once.
//
// Deferring eviction during motion is deliberate — tearing meshes down at every
// tile boundary at boost speed is a hitch you can see. But the deferral had no
// ceiling: a long ride accumulated hundreds of stale tiles and the first settled
// frame tore down ALL of them in one go. Measured on prod, four minutes into
// project 77: ensureAround cost 562 ms of a 620 ms frame, and this was the loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    __resetEvictionBudgetForTests,
    createSharedTileSession,
} from '../core/shared-tile-session.js';
import {
    noteFrameChunkObserver,
    resetFrameChunkObserver,
} from '../core/frame-chunk-queue.js';

// A session with `count` loaded tiles laid out far apart, so every one of them
// is outside any keep-ring and therefore evictable.
function makeSource(options) {
    // The eviction budget is shared across sources and frames, so a previous
    // test's spend would otherwise bleed into this one.
    __resetEvictionBudgetForTests();
    return makeSourceWithoutReset(options);
}

function makeSourceWithoutReset({ onEvict = () => {} } = {}) {
    // The eviction policy lives on a SOURCE, which is only reachable through a
    // session — SharedTileSource itself is not exported.
    const session = createSharedTileSession({
        anchorLat: 45.8, anchorLon: 15.98,
        fetchController: new AbortController(),
    });
    const source = session.getSource({
        key: `evict-test-${Math.floor(performance.now() * 1000)}`,
        label: 'evict-test',
        url: () => 'http://localhost/never-fetched',
        tileM: 100, ring: 1, keepRing: 1,
    });
    source.subscribers.add({ onEvict });
    return source;
}

// A teardown that costs something. Real ones dispose geometry and notify every
// subscriber; a no-op teardown would let 400 tiles fit in the slice and the test
// would pass while proving nothing.
function costlyEvict(record) {
    return (tileKey) => {
        const until = performance.now() + 0.08;
        while (performance.now() < until) { /* stand in for disposing a tile */ }
        record.push(tileKey);
    };
}

function sourceWithStaleTiles(count, options) {
    const source = makeSource(options);
    for (let i = 0; i < count; i += 1) {
        source.tiles.set(`${1000 + i}_${1000 + i}`, { features: [] });
    }
    return source;
}

test('a huge backlog is not evicted in one call', () => {
    const evicted = [];
    const source = sourceWithStaleTiles(400, { onEvict: costlyEvict(evicted) });
    source.evictOutsideRing(0, 0);
    assert.ok(evicted.length > 0, 'it must make progress');
    assert.ok(evicted.length < 400,
        `one call tore down ${evicted.length}/400 — the 562 ms frame is back`);
    assert.ok(source.pendingEvictionCenter,
        'the remainder stays pending so the next frame resumes it');
});

test('a moving observer still drains stale tiles within the frame slice', () => {
    const evicted = [];
    const source = sourceWithStaleTiles(80, { onEvict: costlyEvict(evicted) });
    resetFrameChunkObserver();
    noteFrameChunkObserver(0, 0, { pauseWhileMoving: true });
    noteFrameChunkObserver(12, 0, { pauseWhileMoving: true });

    source.evictOutsideRing(0, 0);

    assert.ok(evicted.length > 0, 'continuous travel must reclaim memory');
    assert.ok(evicted.length < 80, 'motion must not bypass the shared frame budget');
    assert.ok(source.pendingEvictionCenter, 'remaining stale tiles stay queued');
    resetFrameChunkObserver();
});

test('repeated calls drain the backlog completely', () => {
    const evicted = [];
    const source = sourceWithStaleTiles(400, { onEvict: costlyEvict(evicted) });
    for (let frame = 0; frame < 500 && source.tiles.size > 0; frame += 1) {
        source.evictOutsideRing(0, 0);
    }
    assert.equal(source.tiles.size, 0, 'every stale tile is eventually dropped');
    assert.equal(evicted.length, 400, 'each was evicted exactly once');
    assert.equal(source.pendingEvictionCenter, null, 'nothing left pending');
});

test('a small backlog finishes in one call and leaves nothing pending', () => {
    // The common case must not become multi-frame: that would delay reclaiming
    // memory for no reason.
    const evicted = [];
    const source = sourceWithStaleTiles(3, { onEvict: (k) => evicted.push(k) });
    source.evictOutsideRing(0, 0);
    assert.equal(evicted.length, 3);
    assert.equal(source.pendingEvictionCenter, null);
});

test('one slow teardown still makes progress instead of stalling forever', () => {
    // If a single subscriber blows the whole slice, the loop must still drop a
    // tile per call — otherwise eviction never advances and the backlog this
    // exists to drain grows instead.
    const evicted = [];
    const source = sourceWithStaleTiles(5, {
        onEvict: (k) => {
            const until = Date.now() + 5;          // exceeds the slice on its own
            while (Date.now() < until) { /* burn */ }
            evicted.push(k);
        },
    });
    source.evictOutsideRing(0, 0);
    assert.equal(evicted.length, 1, 'exactly one, but never zero');
    assert.ok(source.pendingEvictionCenter, 'the rest is deferred, not lost');
});

test('tiles inside the keep ring are never evicted', () => {
    // The bound must not turn into "evict things we still need".
    const evicted = [];
    const source = makeSource({ onEvict: (k) => evicted.push(k) });
    for (const key of ['0_0', '1_0', '0_1', '-1_-1']) source.tiles.set(key, { features: [] });
    source.tiles.set('50_50', { features: [] });        // the only stale one
    source.evictOutsideRing(0, 0);
    assert.deepEqual(evicted, ['50_50']);
    assert.equal(source.tiles.size, 4, 'the keep ring survives');
});

test('ahead grace expires on stationary ensureAround without a second full scan', (t) => {
    let now = 1000, evicted = [];
    t.mock.method(performance, 'now', () => now);
    {
        const source = makeSource({ onEvict: key => evicted.push(key) });
        source.lastTx = 0; source.lastTz = 0;
        source.tiles.set('50_50', { status: 'loaded', features: [] });
        source.aheadLeftAtMs.set('50_50', now);
        source.evictOutsideRing(0, 0);
        assert.ok(source.tiles.has('50_50'), 'loaded ahead tile remains during grace');
        let scans = 0;
        const evict = source.evictOutsideRing.bind(source);
        source.evictOutsideRing = (...args) => { scans += 1; return evict(...args); };
        now += 14999; source.ensureAround(0, 0);
        assert.equal(scans, 0, 'stationary ensure does not rescan before expiry');
        now += 2;
        source.ensureAround(0, 0);
        assert.equal(source.tiles.has('50_50'), false, 'stationary ensure evicts after grace');
        assert.equal(scans, 1, 'expiry triggers one eviction scan');
        source.ensureAround(0, 0); assert.deepEqual(evicted, ['50_50']);
    }
});

test('dependency retention overrides expired ahead grace until released', (t) => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const evicted = [], source = makeSource({ onEvict: key => evicted.push(key) });
    source.lastTx = 0; source.lastTz = 0;
    source.tiles.set('50_50', { status: 'loaded', features: [] });
    source.aheadLeftAtMs.set('50_50', now);
    const hold = source.retainTiles(['50_50'], { maxTiles: 1 });
    source.evictOutsideRing(0, 0);
    assert.equal(source.tiles.has('50_50'), true);
    now += 20000; source.ensureAround(0, 0);
    assert.equal(source.tiles.has('50_50'), true); assert.deepEqual(evicted, []);
    hold.release(); source.ensureAround(0, 0); source.ensureAround(0, 0);
    assert.equal(source.tiles.has('50_50'), false); assert.deepEqual(evicted, ['50_50']);
});

test('released outside dependency is evicted on the next stationary ensure without an initial scan', (t) => {
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const evicted = [];
    const source = makeSource({ onEvict: key => evicted.push(key) });
    source.lastTx = 0; source.lastTz = 0;
    source.tiles.set('50_50', { status: 'loaded', features: [] });
    const first = source.retainTiles(['50_50'], { maxTiles: 1 });
    const second = source.retainTiles(['50_50'], { maxTiles: 1 });
    now += 20000;
    first.release();
    source.ensureAround(0, 0);
    assert.equal(source.tiles.has('50_50'), true, 'one remaining owner retains the tile');
    assert.deepEqual(evicted, []);
    second.release();
    source.ensureAround(0, 0);
    assert.equal(source.tiles.has('50_50'), false);
    assert.deepEqual(evicted, ['50_50']);
    source.ensureAround(0, 0);
    assert.deepEqual(evicted, ['50_50'], 'release evicts exactly once');
});

test('sibling sources share one frame budget instead of each getting their own', () => {
    // The flaw in the first version of this fix. A per-source slice looks
    // bounded and is not: roads-surface, roads-centreline, curbs, buildings and
    // far-buildings all evict in the same frame, so N sources x the slice landed
    // as 50 ms frames. One 620 ms hitch became a burst of twenty 50 ms ones.
    __resetEvictionBudgetForTests();
    const evicted = [];
    const sources = [];
    for (let i = 0; i < 6; i += 1) {
        const source = makeSourceWithoutReset({ onEvict: costlyEvict(evicted) });
        for (let t = 0; t < 200; t += 1) {
            source.tiles.set(`${5000 + i}_${t}`, { features: [] });
        }
        sources.push(source);
    }
    for (const source of sources) source.evictOutsideRing(0, 0);

    // Count evictions, NOT wall-clock. A time assertion here fails whenever the
    // machine is busy — it flaked repeatedly before this — and a test that goes
    // red because something else was compiling is worse than no test: it trains
    // you to re-run until green. Six sources sharing one budget can only get
    // through a fraction of what six independent budgets would.
    assert.ok(evicted.length >= 6,
        `only ${evicted.length} evicted — each source must still get its guaranteed one`);
    assert.ok(evicted.length < 150,
        `six sources evicted ${evicted.length} tiles in one frame; a shared 2ms budget at `
        + '~0.08ms per teardown cannot reach that — the budget is per-source again');
});
