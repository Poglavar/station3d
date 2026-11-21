// Verifies fixed terrain requests stay small, stable, padded, and near-first.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    terrainGridTileDescriptor,
    terrainGridTileIndex,
    terrainGridTileRingDistance,
    terrainGridTilesAround,
} from '../core/terrain-grid-tiles.js';

test('snaps Zagreb positions to stable cacheable terrain tiles', () => {
    const index = terrainGridTileIndex(15.974125, 45.8049118);
    assert.deepEqual(index, { tx: 798, ty: 2290 });
    const tile = terrainGridTileDescriptor(index.tx, index.ty);
    assert.equal(tile.key, '798_2290');
    assert.deepEqual(tile.coreBounds, {
        west: 15.96,
        south: 45.800000000000004,
        east: 15.98,
        north: 45.82,
    });
    assert.deepEqual(tile.bbox.map(value => value.toFixed(4)), [
        '15.9596',
        '45.7996',
        '15.9804',
        '45.8204',
    ]);
    assert.equal(tile.cacheTile, true);
    assert.ok(tile.estimatedCells < 12000, `${tile.estimatedCells} cells`);
});

test('plans a bounded 3 by 3 terrain window from the camera tile outward', () => {
    const tiles = terrainGridTilesAround(15.974125, 45.8049118, { ring: 1 });
    assert.equal(tiles.length, 9);
    assert.equal(tiles[0].key, '798_2290');
    const center = terrainGridTileIndex(15.974125, 45.8049118);
    assert.deepEqual(
        tiles.map(tile => terrainGridTileRingDistance(tile, center)),
        [0, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    assert.equal(new Set(tiles.map(tile => tile.key)).size, 9);
    assert.ok(
        tiles.reduce((sum, tile) => sum + tile.estimatedCells, 0) < 100000,
        'the startup window is orders of magnitude smaller than the old 16 km grid',
    );
});
