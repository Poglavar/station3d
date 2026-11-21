// Resource retirement must follow the last real borrower, including queued paints
// and old/new mesh generations, rather than a tile-count or session-only cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Mesh } from 'three';
import { createOwnedResourceCache, createMeshResourceBindings } from '../core/owned-resource-cache.js';

function setup(maxIdleBytes = 0) {
    const cache = createOwnedResourceCache({ maxIdleBytes });
    const disposed = [];
    const get = (key, cpuBytes = 12, gpuBytes = 16) => cache.getOrCreate(key, () => ({
        value: { key }, cpuBytes, gpuBytes, dispose: () => disposed.push(key),
    }));
    return { cache, disposed, get };
}

test('an atlas paint still pins the source after its construction owner releases it', () => {
    const { cache, get, disposed } = setup();
    const source = get('facade');
    const construction = cache.retain(source, 'construction');
    const paint = cache.retain(source, 'atlas-paint');
    construction();
    assert.equal(cache.trim(), 0);
    assert.deepEqual(cache.snapshot().owners, { 'atlas-paint': 1 });
    paint();
    assert.equal(cache.trim(), 1);
    assert.deepEqual(disposed, ['facade']);
    assert.equal(cache.snapshot().estimatedBytes, 0);
});

test('old, new and pending aggregate owners cannot evict one another', () => {
    const { cache, get } = setup();
    const source = get('shared');
    const releases = ['old-mesh', 'replacement', 'bucket', 'upload'].map(owner => cache.retain(source, owner));
    for (const release of releases.slice(0, -1)) { release(); assert.equal(cache.trim(), 0); }
    releases.at(-1)();
    assert.equal(cache.trim(), 1);
});

test('the idle-byte budget uses both canvas and GPU estimates, and eviction work is bounded', () => {
    const { cache, get, disposed } = setup(28);
    get('old'); get('middle'); get('recent');
    assert.equal(cache.snapshot().evictionPendingBytes, 56);
    assert.equal(cache.trim(1), 1);
    assert.deepEqual(disposed, ['old']);
    assert.equal(cache.trim(1), 1);
    assert.equal(cache.trim(1), 0);
    assert.deepEqual(disposed, ['old', 'middle']);
    assert.equal(cache.snapshot().idleBytes, 28);
});

test('burst retirement catches up with unused textures while preserving live borrowers', () => {
    const MiB = 1024 * 1024;
    function run(maxEntries, timeBudgetMs) {
        let clock = 0;
        const disposed = [];
        const cache = createOwnedResourceCache({ maxIdleBytes: 2 * MiB, now: () => clock });
        const get = key => cache.getOrCreate(key, () => ({ value: { key }, cpuBytes: MiB, gpuBytes: 0,
            dispose() { disposed.push(key); clock += .01; } }));
        const live = get('live'); cache.retain(live, 'visible-mesh');
        for (let frame = 0; frame < 10; frame++) {
            for (let item = 0; item < 4; item++) {
                const value = get(`${frame}:${item}`);
                const release = cache.retain(value, 'atlas-paint'); release();
            }
            cache.trim(maxEntries, timeBudgetMs);
        }
        assert.equal(disposed.includes('live'), false);
        assert.equal(cache.snapshot().pinnedBytes, MiB);
        return cache.snapshot();
    }
    const previous = run(1, Infinity), bounded = run(32, .25);
    assert.ok(previous.evictionPendingBytes > 20 * MiB, 'one eviction per frame accumulates a burst backlog');
    assert.equal(bounded.evictionPendingBytes, 0);
    assert.equal(bounded.peakEstimatedBytes, 7 * MiB, 'the peak is limited to the live set, idle allowance and this frame\'s arrivals');
    assert.equal(bounded.peakPinnedBytes, 2 * MiB);
    assert.equal(bounded.peakIdleBytes, 6 * MiB);
});

test('retirement stops at its time or count boundary without interrupting one disposer', () => {
    let clock = 0;
    const cache = createOwnedResourceCache({ maxIdleBytes: 0, now: () => clock });
    for (let i = 0; i < 10; i++) cache.getOrCreate(i, () => ({ value: {}, cpuBytes: 1, gpuBytes: 1,
        dispose() { clock += .1; } }));
    assert.equal(cache.trim(32, 0), 0);
    assert.equal(cache.trim(32, .25), 3, 'only the final indivisible disposer may cross the deadline');
    assert.equal(cache.trim(2, 10), 2, 'a generous deadline still honors the item ceiling');
    assert.equal(cache.snapshot().entries, 5);
    for (const budget of [-1, NaN, '1', null]) assert.throws(() => cache.trim(1, budget), /time budget/);
});

test('reuse refreshes idle LRU and a live entry is never counted as disposable headroom', () => {
    const { cache, get, disposed } = setup(28);
    const pinned = get('pinned');
    const release = cache.retain(pinned, 'mesh');
    get('hot'); get('cold'); get('hot');
    cache.trim();
    assert.deepEqual(disposed, ['cold']);
    assert.equal(cache.snapshot().pinnedBytes, 28);
    assert.equal(cache.snapshot().idleBytes, 28);
    release();
    cache.clear();
    assert.equal(cache.snapshot().estimatedBytes, 0);
});

test('release is idempotent; an evicted key creates a fresh resource without stale ownership', () => {
    const { cache, get } = setup();
    const old = get('facade');
    const release = cache.retain(old, 'mesh');
    release(); release(); cache.trim();
    const current = get('facade');
    assert.notEqual(current, old);
    release();
    assert.equal(cache.snapshot().references, 0);
    assert.equal(cache.snapshot().entries, 1);
    assert.equal(cache.retain(old, 'stale'), null);
});

test('teardown reports a leaked borrower instead of disposing a texture still in use', () => {
    const { cache, get, disposed } = setup();
    const release = cache.retain(get('facade'), 'pending');
    assert.throws(() => cache.clear(), /1 owners/);
    assert.deepEqual(disposed, []);
    release(); cache.clear(); cache.clear();
    assert.deepEqual(disposed, ['facade']);
});

test('mesh binding survives repeated passage refreshes and releases on actual geometry disposal', () => {
    const { cache, get } = setup();
    const bind = createMeshResourceBindings(cache);
    const material = get('facade');
    const mesh = new Mesh(new BufferGeometry());
    bind(mesh, material); bind(mesh, material);
    assert.equal(cache.snapshot().references, 1);
    mesh.removeFromParent();
    assert.equal(cache.trim(), 0, 'detachment alone is not retirement');
    mesh.geometry.dispose(); mesh.geometry.dispose();
    assert.equal(cache.snapshot().references, 0);
    assert.equal(cache.trim(), 1);
});

test('rebinding a mesh acquires the new source and releases only its previous source', () => {
    const { cache, get, disposed } = setup();
    const bind = createMeshResourceBindings(cache);
    const mesh = new Mesh(new BufferGeometry());
    bind(mesh, get('old')); bind(mesh, get('new'));
    cache.trim();
    assert.deepEqual(disposed, ['old']);
    bind(mesh, {});
    cache.trim();
    assert.deepEqual(disposed, ['old', 'new']);
    assert.equal(cache.snapshot().references, 0);
});

test('invalid byte estimates and work limits cannot fabricate a successful budget', () => {
    assert.throws(() => setup(null), /byte budget/);
    const { cache, get } = setup();
    for (const invalid of [null, NaN, -1, Infinity]) assert.throws(() => get('invalid', invalid), /byte estimate/);
    assert.throws(() => cache.trim(-1), /work limit/);
});

test('optional entry diagnostics identify exact borrowers without exposing mutable state', () => {
    const { cache, get } = setup();
    const a = get('a'); const b = get('b');
    const mesh = cache.retain(a, 'mesh');
    const secondMesh = cache.retain(a, 'mesh');
    const bucket = cache.retain(a, 'bucket');
    const staged = cache.retain(b, 'staged-part');
    assert.equal(cache.snapshot().entryDetails, undefined, 'hot snapshots remain constant-sized');
    const details = cache.snapshot({ includeEntries: true }).entryDetails;
    assert.deepEqual(details.map(entry => [entry.key, entry.references, entry.owners]), [
        ['a', 3, { mesh: 2, bucket: 1 }], ['b', 1, { 'staged-part': 1 }],
    ]);
    details[0].owners.mesh = 900;
    mesh(); mesh();
    assert.deepEqual(cache.snapshot({ includeEntries: true }).entryDetails[0].owners,
        { mesh: 1, bucket: 1 });
    secondMesh(); bucket();
    const idle = cache.snapshot({ includeEntries: true }).entryDetails[0];
    assert.equal(idle.idle, true);
    assert.deepEqual(idle.owners, {});
    cache.trim();
    assert.deepEqual(cache.snapshot({ includeEntries: true }).entryDetails.map(entry => entry.key), ['b']);
    staged(); cache.clear();
    assert.deepEqual(cache.snapshot({ includeEntries: true }).entryDetails, []);
});
