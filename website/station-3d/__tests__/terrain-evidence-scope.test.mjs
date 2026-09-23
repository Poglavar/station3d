// A ground generation may only require base terrain that is loaded or requested.
// Split city flight (2026-09-22/23): a road reaching local (2382, 239) waited
// forever on a tile outside the ring-1 base mosaic while the loading hold froze the pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainEvidenceScope } from '../core/terrain-evidence-scope.js';
import { terrainGridTilesAround } from '../core/terrain-grid-tiles.js';

const anchorLon = 16.47115, anchorLat = 43.515575;
const ring1 = terrainGridTilesAround(anchorLon, anchorLat, { ring: 1 }).map(tile => tile.key);
const box = (x, z, r = 1) => ({ minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r });

test('the recorded Split failure point is outside the ring-1 base mosaic; nearby road is inside', () => {
    const scope = createTerrainEvidenceScope({ anchorLon, anchorLat, tileKeys: ring1 });
    assert.equal(scope.tileCount, 9);
    assert.equal(scope.contains(box(2382.25, 239.04)), false);
    assert.equal(scope.contains(box(0, 0, 50)), true);
    assert.equal(scope.contains(box(2000, 0)), true);
    // A road spanning from inside to outside needs every touched tile.
    assert.equal(scope.contains({ minX: 1500, minZ: 200, maxX: 2400, maxZ: 260 }), false);
});

test('an in-flight (requested) tile counts as scope, so its evidence arrival can wake the generation', () => {
    const east = terrainGridTilesAround(anchorLon + 0.04, anchorLat, { ring: 0 }).map(tile => tile.key);
    const scope = createTerrainEvidenceScope({ anchorLon, anchorLat, tileKeys: [...ring1, ...east] });
    assert.equal(scope.contains(box(2382.25, 239.04)), true);
});

test('malformed bounds are never inside, and the scope needs an anchor', () => {
    const scope = createTerrainEvidenceScope({ anchorLon, anchorLat, tileKeys: ring1 });
    assert.equal(scope.contains({ minX: NaN, minZ: 0, maxX: 1, maxZ: 1 }), false);
    assert.equal(scope.contains(null), false);
    assert.throws(() => createTerrainEvidenceScope({ tileKeys: ring1 }), TypeError);
    assert.equal(createTerrainEvidenceScope({ anchorLon, anchorLat, tileKeys: [] }).contains(box(0, 0)), false);
});
