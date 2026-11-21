// A baked world pack's building triangles become walk walls: vertical faces merge into physical walls, roofs and
// low relief do not, and a doorway's piers and lintel stay separate walls so the opening stays open.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCampaignPackBuildingCollisionIndex } from '../core/campaign-pack-building-collision.js';
import { buildingWallColliderSpecs } from '../core/gta-collider-bubble.js';

function primitive(surfaceClass, positions, indices, ownerId = 'owner') {
    return {
        positions: new Float32Array(positions),
        indices: new Uint16Array(indices),
        surfaceClaims: [{ surfaceClass, ownerId }],
    };
}

test('baked vertical building triangles become one translated physical wall', () => {
    const wall = primitive('building', [
        0, 2, 0,
        10, 2, 0,
        0, 10, 0,
        10, 10, 0,
    ], [0, 1, 2, 1, 3, 2], 'building:12');
    const roof = primitive('building', [
        0, 10, 0,
        10, 10, 0,
        0, 10, 10,
    ], [0, 1, 2], 'building:12');
    const index = createCampaignPackBuildingCollisionIndex([
        { primitives: [wall, roof] },
    ], { offsetX: 20, offsetZ: -30 });

    assert.deepEqual(index.snapshot(), {
        contract: 'station3d-campaign-pack-building-collision-v1',
        cellSizeM: 64,
        buildingTriangleCount: 3,
        wallCount: 1,
        bucketCount: 1,
    });
    assert.equal(index.footprintsNear(25, -30, 2).length, 1);
    assert.equal(index.footprintsNear(25, -20, 2).length, 0);
    assert.equal(index.footprintsNear(25, -30, 2, { minY: 10.5, maxY: 12 }).length, 0);
    assert.equal(index.footprintsNear(25, -30, 2, { minY: 3, maxY: 4 }).length, 1);
});

test('derived walls retain their baked vertical extent in GTA collision', () => {
    const wall = primitive('building', [
        0, -3, 0,
        8, -3, 0,
        0, 5, 0,
    ], [0, 1, 2]);
    const index = createCampaignPackBuildingCollisionIndex([{ primitives: [wall] }]);
    const specs = buildingWallColliderSpecs(index.footprintsNear(4, 1, 10), {
        centerX: 4,
        centerZ: 1,
        radiusM: 10,
        maxColliders: 4,
        heightAt: () => 99,
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].halfY, 4);
    assert.equal(specs[0].y, 1);

    const direct = index.colliderSpecsNear(4, 1, 10, 4);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].halfY, 4);
    assert.equal(direct[0].y, 1);
    assert.equal(direct[0].kind, 'building');
    assert.equal(index.colliderSpecsNear(4, 1, 10, 4, {
        minY: 5.5,
        maxY: 8,
    }).length, 0);
    assert.equal(index.colliderSpecsNear(4, 1, 10, 4, {
        minY: -1,
        maxY: 2,
    }).length, 1);
});

test('coplanar facade fragments collapse into one continuous physical wall', () => {
    const lowerLeft = primitive('building', [
        0, 0, 0,
        4, 0, 0,
        0, 8, 0,
        4, 8, 0,
    ], [0, 1, 2, 1, 3, 2], 'detail:a');
    const lowerRight = primitive('building', [
        4.1, 0, 0.04,
        10, 0, 0.04,
        4.1, 8, 0.04,
        10, 8, 0.04,
    ], [0, 1, 2, 1, 3, 2], 'detail:b');
    const index = createCampaignPackBuildingCollisionIndex([
        { primitives: [lowerLeft, lowerRight] },
    ]);

    assert.equal(index.snapshot().buildingTriangleCount, 4);
    assert.equal(index.snapshot().wallCount, 1);
    const [wall] = index.colliderSpecsNear(5, 1, 10, 10);
    assert.ok(wall.halfX * 2 > 9.9);
    assert.equal(wall.halfY, 4);
});

test('non-building and horizontal triangles never become phantom walls', () => {
    const roadWall = primitive('road-carriageway', [
        0, 0, 0,
        10, 0, 0,
        0, 8, 0,
    ], [0, 1, 2]);
    const buildingRoof = primitive('building', [
        0, 8, 0,
        10, 8, 0,
        0, 8, 10,
    ], [0, 1, 2]);
    const index = createCampaignPackBuildingCollisionIndex([
        { primitives: [roadWall, buildingRoof] },
    ]);
    assert.equal(index.snapshot().wallCount, 0);
    assert.deepEqual(index.footprintsNear(0, 0, 100), []);
});

test('coplanar lintels do not become invisible full-height walls across openings', () => {
    const doorway = primitive('building', [
        // Left pier, ground to lintel.
        0, 0, 0, 1, 0, 0, 0, 3, 0,
        1, 0, 0, 1, 3, 0, 0, 3, 0,
        // Right pier.
        4, 0, 0, 5, 0, 0, 4, 3, 0,
        5, 0, 0, 5, 3, 0, 4, 3, 0,
        // Lintel across the opening, 3 m above the ground.
        0, 3, 0, 5, 3, 0, 0, 5, 0,
        5, 3, 0, 5, 5, 0, 0, 5, 0,
    ], Array.from({ length: 18 }, (_, index) => index), 'doorway');
    const index = createCampaignPackBuildingCollisionIndex([{ primitives: [doorway] }]);

    const groundWalls = index.footprintsNear(2.5, 0, 10, { minY: 0.5, maxY: 2.5 });
    assert.equal(groundWalls.length, 2, 'only the two visible piers occupy the doorway at ground level');
    assert.ok(groundWalls.every(footprint => (
        footprint.segments[0].bx <= 1.01 || footprint.segments[0].ax >= 3.99
    )));

    const upperWalls = index.footprintsNear(2.5, 0, 10, { minY: 3.2, maxY: 4.8 });
    assert.equal(upperWalls.length, 1, 'the visible lintel still collides above the opening');
    assert.ok(upperWalls[0].segments[0].bx - upperWalls[0].segments[0].ax > 4.9);
});
