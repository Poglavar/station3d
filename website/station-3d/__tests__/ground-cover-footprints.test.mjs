// Footprint ownership is observable independently of a canvas: preparation,
// failed batches and height-only rebuilds must not add catch-all paving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundCoverFootprints } from '../core/ground-cover-footprints.js';

const ring = (x = 0) => [{ x, z: 0 }, { x: x + 2, z: 0 }, { x, z: 2 }];
const drain = (steps, inspect = () => {}) => {
    for (;;) { const next = steps.next(); inspect(); if (next.done) return next.value; }
};
const publish = candidate => { assert.equal(candidate.commit(), true); assert.equal(candidate.finalize(), true); };

test('only published buckets contribute, and replacement/rollback/clear retain exact owners', () => {
    let redraws = 0;
    const store = createGroundCoverFootprints({ onChanged: () => redraws++ });
    const first = drain(store.prepareBucketSteps('a', [['road', [ring()]]]), () => assert.equal([...store.rings()].length, 0));
    publish(first); assert.equal(redraws, 1);
    const old = [...store.rings()][0];
    const next = drain(store.prepareBucketSteps('a', [['road', [ring(10)]]]), () => assert.equal([...store.rings()][0], old));
    assert.equal(next.commit(), true);
    assert.equal([...store.rings()][0][0], 10);
    assert.equal(redraws, 1, 'an unfinalized batch cannot schedule a texture update');
    next.rollback(); next.discard();
    assert.equal([...store.rings()][0], old); assert.equal(redraws, 1);
    publish(drain(store.prepareBucketSteps('b', [['other-road', [ring(20)]]])));
    publish(drain(store.prepareBucketSteps('a', [])));
    assert.deepEqual([...store.rings()], [[20, 0, 22, 0, 20, 2]]);
    assert.deepEqual(store.debugState(), { buckets: 1, owners: 1, rings: 1, points: 3 });
    store.clear(); assert.deepEqual([...store.rings()], []);
});

test('equivalent footprints reuse retained coordinates and avoid repainting on height-only rebuilds', () => {
    let redraws = 0;
    const store = createGroundCoverFootprints({ onChanged: () => redraws++ });
    publish(drain(store.prepareBucketSteps('a', [['road', [ring()]]])));
    const original = [...store.rings()][0];
    for (let height = 1; height <= 30; height++) {
        const input = ring().map(point => ({ ...point, y: height }));
        const candidate = drain(store.prepareBucketSteps('a', [['road', [input]]]));
        input[0].x = 99;
        publish(candidate);
        assert.equal([...store.rings()][0], original);
    }
    assert.equal(redraws, 1);
    assert.deepEqual(store.debugState(), { buckets: 1, owners: 1, rings: 1, points: 3 });
});

test('cancellation, stale sources and session reset cannot install detached footprints', () => {
    const store = createGroundCoverFootprints();
    let current = true;
    const cancelled = store.prepareBucketSteps('a', [['road', [ring()]]]);
    cancelled.next(); cancelled.return();
    assert.equal([...store.rings()].length, 0);
    const stale = store.prepareBucketSteps('a', [['road', [ring()]]], { isCurrent: () => current });
    stale.next(); current = false;
    assert.equal(drain(stale), null);
    const ready = drain(store.prepareBucketSteps('a', [['road', [ring()]]]));
    store.clear(); assert.equal(ready.commit(), false); ready.discard();
    assert.equal([...store.rings()].length, 0);
    publish(drain(store.prepareBucketSteps('a', [['road', [ring(5)]]])));
    assert.equal([...store.rings()][0][0], 5);
});

test('invalid evidence and admitted preparation limits fail without changing published coverage', () => {
    const store = createGroundCoverFootprints();
    publish(drain(store.prepareBucketSteps('a', [['road', [ring()]]])));
    const old = [...store.rings()][0];
    const missing = ring(); missing[1].x = null;
    assert.throws(() => drain(store.prepareBucketSteps('a', [['road', [missing]]])), /Invalid ground-cover footprint point/);
    assert.throws(() => drain(store.prepareBucketSteps('a', [['road', [ring()]]], { maxPoints: 2 })), /point capacity/);
    assert.throws(() => drain(store.prepareBucketSteps('a', [['road', [ring()]], ['b', [ring()]]], { maxOwners: 1 })), /owner capacity/);
    assert.equal([...store.rings()][0], old);
});
