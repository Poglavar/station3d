import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTerrainColliderGrid, terrainColliderTriangleHasEvidence } from '../core/terrain-collider-grid.js';

const grid = { columns: 2, rows: 1, startX: 0, startZ: 0, step: 10,
    sample: (x, z) => x === 20 ? null : x + z };

test('a bounded level edge preserves evidenced road triangles inside the vehicle bubble', () => {
    const heights = sampleTerrainColliderGrid({ ...grid, bounded: true });
    assert.equal(terrainColliderTriangleHasEvidence(heights, 0, 3, 1), true);
    assert.equal(terrainColliderTriangleHasEvidence(heights, 1, 3, 4), true);
    assert.equal(terrainColliderTriangleHasEvidence(heights, 1, 4, 2), false);
    assert.equal(terrainColliderTriangleHasEvidence(heights, 2, 4, 5), false);
    assert.equal(heights[4], 20, 'height comes from terrain even above the car');
});

test('streamed terrain still holds until every sample is published', () => {
    assert.equal(sampleTerrainColliderGrid(grid), null);
    assert.equal(sampleTerrainColliderGrid({ ...grid, bounded: true, sample: () => null }), null);
    assert.ok(sampleTerrainColliderGrid({ ...grid, sample: () => 0 }));
});
