// The road receiver bucket ceiling, driven through the production batcher.
//
// A ground generation carries terrain, paving, water and the coast collar in
// one all-or-nothing candidate, and the collar is prepared last. Split's
// waterfront reached 257 distinct geometry buckets against a ceiling of 256,
// so the whole candidate was rejected and the city kept a raw sea plane
// against raw paving with no shore between them (2026-09-16).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';

const { roadReceivers, paintSources } = GROUND_GENERATION_LIMITS;

// Distinct buckets, one owner each — the shape a camera crossing a dense
// waterfront produces once every re-bucketed road charges both the bucket it
// leaves and the one it joins.
function replacements(count) {
    return Array.from({ length: count }, (_, index) => ({
        bucketKey: `bucket:${index}`,
        ownerKey: `owner:${index}`,
        parts: [],
    }));
}

function admit(batcher, count, limits) {
    const steps = batcher.prepareReplacementSteps(replacements(count), limits);
    try {
        for (;;) {
            const next = steps.next();
            if (next.done) return next.value;
        }
    } finally {
        steps.return?.();
    }
}

const limitsFor = maxBuckets => ({
    maxBuckets,
    maxOwners: roadReceivers.maxOwners,
    maxParts: 65536,
    maxOutputBytes: roadReceivers.maxGeometryBytes,
});

test('a dense waterfront pass fits inside the road receiver bucket ceiling', () => {
    const batcher = createGeometryBatcher();
    assert.doesNotThrow(() => admit(batcher, 257, limitsFor(roadReceivers.maxBuckets)),
        'the measured Split waterfront count must be admitted, not rejected');
});

test('the ceiling still bounds a generation', () => {
    const batcher = createGeometryBatcher();
    assert.throws(() => admit(batcher, roadReceivers.maxBuckets + 1, limitsFor(roadReceivers.maxBuckets)),
        /bucket capacity exceeded/, 'an unbounded bucket set is not the fix');
});

test('road receivers own their ceiling; paint keeps its separate, smaller one', () => {
    // Sharing one constant meant a road-side sizing change would silently move
    // the paint admission limits too. They are different populations: paint
    // counts regions, road receivers count merged draw groups.
    assert.ok(roadReceivers.maxBuckets > 257,
        `road receiver ceiling ${roadReceivers.maxBuckets} leaves no headroom over the observed 257`);
    assert.ok(roadReceivers.maxBuckets > paintSources.maxRegions,
        'the road ceiling must not be pinned to the paint region limit');
    assert.equal(paintSources.maxRegions, 256, 'paint region limit changed unintentionally');
    assert.equal(paintSources.maxChangedRegions, 512, 'paint changed-region limit changed unintentionally');
});
