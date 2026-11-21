// Verifies that spatial cache misses are staggered and remain memory-bounded.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createStaggeredSpatialCache,
    staggeredExpiryMs,
} from '../core/staggered-spatial-cache.js';

test('nearby cells do not expire as one synchronized cache flush', () => {
    let now = 1_000;
    const calls = new Map();
    const cache = createStaggeredSpatialCache({
        quantM: 1,
        minLifetimeMs: 100,
        jitterMs: 100,
        nowMs: () => now,
    });
    const sample = (x) => cache.getOrCompute(x, 0, () => {
        calls.set(x, (calls.get(x) || 0) + 1);
        return x * 10;
    });

    sample(0);
    sample(1);
    const expiry0 = staggeredExpiryMs('0|0', now, 100, 100);
    const expiry1 = staggeredExpiryMs('1|0', now, 100, 100);
    assert.notEqual(expiry0, expiry1);

    now = Math.min(expiry0, expiry1);
    sample(0);
    sample(1);
    assert.deepEqual([...calls.entries()].sort(), [
        [0, expiry0 === now ? 2 : 1],
        [1, expiry1 === now ? 2 : 1],
    ]);
});

test('the oldest spatial entry is evicted at the configured bound', () => {
    let calls = 0;
    const cache = createStaggeredSpatialCache({
        quantM: 1,
        minLifetimeMs: 1_000,
        jitterMs: 0,
        maxEntries: 2,
        nowMs: () => 0,
    });
    const sample = x => cache.getOrCompute(x, 0, () => ++calls);

    assert.equal(sample(0), 1);
    assert.equal(sample(1), 2);
    assert.equal(sample(2), 3);
    assert.equal(cache.size, 2);
    assert.equal(sample(0), 4, 'the oldest cell was evicted and recomputed');
});

test('revision invalidation spreads refreshes without discarding the last values', () => {
    let now = 2_000;
    const calls = new Map();
    const cache = createStaggeredSpatialCache({
        quantM: 1,
        minLifetimeMs: 10_000,
        jitterMs: 0,
        nowMs: () => now,
    });
    const sample = x => cache.getOrCompute(x, 0, () => {
        calls.set(x, (calls.get(x) || 0) + 1);
        return `value-${x}-${calls.get(x)}`;
    });

    const original = [sample(0), sample(1), sample(2)];
    cache.invalidateStaggered({ minDelayMs: 10, spreadMs: 100 });

    now += 9;
    assert.deepEqual([sample(0), sample(1), sample(2)], original);

    const expiries = [0, 1, 2].map(x => staggeredExpiryMs(`${x}|0`, 2_000, 10, 100));
    assert.ok(new Set(expiries).size > 1, 'cells receive different revision refresh deadlines');
    now = Math.min(...expiries);
    sample(0);
    sample(1);
    sample(2);
    assert.equal(
        [...calls.values()].filter(count => count === 2).length,
        expiries.filter(expiry => expiry === now).length,
        'only cells whose staggered deadline elapsed refresh',
    );
});
