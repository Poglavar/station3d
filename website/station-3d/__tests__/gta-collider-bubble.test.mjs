import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildingWallColliderSpecs,
    colliderSpecOverlapsVehicle,
    colliderBubbleNeedsRefresh,
    colliderBubbleTouchesChanges,
    collisionInvolvesHandle,
    entryPathCrossesColliderBoxes,
    entryPathCrossesFootprints,
    entryPathCrossesObstacles,
    isVehicleExitSupportHeightSafe,
    resolvePhysicsRebase,
    shouldDeferColliderBuild,
    vehicleExitCandidates,
} from '../core/gta-collider-bubble.js';

test('only contacts containing the player chassis count as player impacts', () => {
    assert.equal(collisionInvolvesHandle(12, 19, 12), true);
    assert.equal(collisionInvolvesHandle(12, 19, 19), true);
    assert.equal(collisionInvolvesHandle(12, 19, 7), false);
    assert.equal(collisionInvolvesHandle(12, 19, null), false);
});

test('entry safety detects rotated fixed geometry intersecting the parked car', () => {
    const vehicle = {
        x: 0,
        centerY: 1,
        z: 0,
        heading: Math.PI / 2,
        halfWidthM: 0.8,
        halfHeightM: 0.48,
        halfLengthM: 1.9,
    };
    assert.equal(colliderSpecOverlapsVehicle({
        x: 0,
        y: 1,
        z: 1.8,
        halfX: 2,
        halfY: 2,
        halfZ: 0.1,
        yaw: Math.PI / 2,
    }, vehicle, 0.15), true);
    assert.equal(colliderSpecOverlapsVehicle({
        x: 0,
        y: 1,
        z: 4,
        halfX: 0.5,
        halfY: 2,
        halfZ: 0.1,
        yaw: 0,
    }, vehicle, 0.15), false);
    assert.equal(colliderSpecOverlapsVehicle({
        x: 0,
        y: 8,
        z: 0,
        halfX: 4,
        halfY: 0.2,
        halfZ: 4,
        yaw: 0,
    }, vehicle, 0.15), false);
});

test('streamed fixed geometry waits until every live chassis has cleared it', () => {
    const wall = {
        x: 0,
        y: 2,
        z: 0,
        halfX: 4,
        halfY: 2,
        halfZ: 0.1,
        yaw: 0,
    };
    const player = {
        x: 0,
        centerY: 1,
        z: 0.5,
        heading: 0,
        halfWidthM: 0.8,
        halfHeightM: 0.48,
        halfLengthM: 1.9,
    };
    assert.equal(shouldDeferColliderBuild(wall, [player], 0.18), true);
    assert.equal(shouldDeferColliderBuild(wall, [{ ...player, z: 4 }], 0.18), false);
    assert.equal(shouldDeferColliderBuild(wall, [null, { ...player, z: 4 }, player]), true);
});

test('collider bubble refresh is movement gated', () => {
    assert.equal(colliderBubbleNeedsRefresh(null, { x: 0, z: 0 }, 40), true);
    assert.equal(colliderBubbleNeedsRefresh({ x: 0, z: 0 }, { x: 39, z: 0 }, 40), false);
    assert.equal(colliderBubbleNeedsRefresh({ x: 0, z: 0 }, { x: 40, z: 0 }, 40), true);
});

test('collider bubble ignores bounded streamed changes outside its radius', () => {
    const changes = {
        revision: 9,
        full: false,
        bounds: [{ minX: 300, minZ: -20, maxX: 340, maxZ: 20 }],
    };
    assert.equal(colliderBubbleTouchesChanges(changes, { x: 0, z: 0 }, 155), false);
    assert.equal(colliderBubbleTouchesChanges(changes, { x: 150, z: 0 }, 155), true);
});

test('collider bubble rebuilds for full or malformed change histories', () => {
    assert.equal(colliderBubbleTouchesChanges(
        { full: true, bounds: [] },
        { x: 0, z: 0 },
        155,
    ), true);
    assert.equal(colliderBubbleTouchesChanges(
        { full: false, bounds: [{ minX: 'bad' }] },
        { x: 0, z: 0 },
        155,
    ), true);
});

test('physics rebase only occurs outside the precision window', () => {
    assert.equal(resolvePhysicsRebase({ x: 0, z: 0 }, { x: 1999, z: 0 }, 2000), null);
    assert.deepEqual(resolvePhysicsRebase({ x: 0, z: 0 }, { x: 2100, z: -50 }, 2000), {
        x: 2100,
        z: -50,
        dx: 2100,
        dz: -50,
    });
});

test('building walls are nearest-first and capped', () => {
    let heightQueries = 0;
    const specs = buildingWallColliderSpecs([{
        objectId: 'house',
        segments: [
            { ax: 10, az: 0, bx: 20, bz: 0 },
            { ax: 2, az: 0, bx: 4, bz: 0 },
        ],
    }], {
        centerX: 0,
        centerZ: 0,
        radiusM: 100,
        maxColliders: 1,
        heightAt: () => {
            heightQueries += 1;
            return 5;
        },
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].x, 3);
    assert.equal(specs[0].y, 17);
    assert.equal(specs[0].destructive, false);
    assert.equal(heightQueries, 1, 'walls beyond the cap must not sample support');
});

test('a surveyed building base bypasses fallback ground sampling', () => {
    const specs = buildingWallColliderSpecs([{
        objectId: 'surveyed',
        baseY: 8,
        segments: [{ ax: 0, az: 0, bx: 8, bz: 0 }],
    }], {
        centerX: 0,
        centerZ: 0,
        radiusM: 100,
        maxColliders: 20,
        heightAt: () => assert.fail('surveyed base is already authoritative'),
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].y, 20);
});

test('building walls are not published without ground evidence', () => {
    const specs = buildingWallColliderSpecs([{
        objectId: 'waiting',
        segments: [{ ax: 0, az: 0, bx: 8, bz: 0 }],
    }], {
        centerX: 0,
        centerZ: 0,
        radiusM: 100,
        maxColliders: 20,
        heightAt: () => null,
    });
    assert.deepEqual(specs, []);
});

test('coincident detailed and outline walls produce one collider', () => {
    const segment = { ax: 0, az: 0, bx: 8, bz: 0 };
    const specs = buildingWallColliderSpecs([
        { objectId: 'house', source: 'mesh-walls', segments: [segment] },
        { objectId: 'house', source: 'authoritative', segments: [{ ...segment }] },
    ], {
        centerX: 0,
        centerZ: 0,
        radiusM: 100,
        maxColliders: 20,
    });
    assert.equal(specs.length, 1);
    assert.match(specs[0].id, /^building:mesh-walls:house:/);
});

test('separate rings of one multipolygon building keep distinct wall IDs', () => {
    const specs = buildingWallColliderSpecs([
        { objectId: 'complex', segments: [{ ax: 0, az: 0, bx: 4, bz: 0 }] },
        { objectId: 'complex', segments: [{ ax: 10, az: 0, bx: 14, bz: 0 }] },
    ], {
        centerX: 0,
        centerZ: 0,
        radiusM: 100,
        maxColliders: 20,
    });
    assert.equal(specs.length, 2);
    assert.notEqual(specs[0].id, specs[1].id);
});

test('a long wall crossing the bubble is retained even when its midpoint is far away', () => {
    const specs = buildingWallColliderSpecs([{
        objectId: 'warehouse',
        segments: [{ ax: 0, az: 2, bx: 1000, bz: 2 }],
    }], {
        centerX: 1,
        centerZ: 0,
        radiusM: 5,
        maxColliders: 10,
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].distanceSq, 4);
});

test('vehicle exit candidates appear on both sides and behind', () => {
    const candidates = vehicleExitCandidates({ x: 10, z: 20, heading: 0, halfWidthM: 1, halfLengthM: 2 });
    assert.deepEqual(candidates.map(candidate => candidate.side), ['left', 'right', 'rear']);
    assert.ok(candidates[0].x < 10);
    assert.ok(candidates[1].x > 10);
    assert.ok(candidates[2].z < 20);
});

test('an overturned vehicle checks its complete perimeter before recovery', () => {
    const candidates = vehicleExitCandidates({
        x: 10,
        z: 20,
        heading: 0,
        halfWidthM: 1,
        halfLengthM: 2,
        expanded: true,
    });
    assert.deepEqual(candidates.map(candidate => candidate.side), [
        'left',
        'right',
        'rear',
        'front',
        'rear-left',
        'rear-right',
        'front-left',
        'front-right',
    ]);
    assert.equal(new Set(candidates.map(candidate => `${candidate.x}:${candidate.z}`)).size, 8);
});

test('vehicle exits reject a building roof masquerading as nearby ground', () => {
    assert.equal(isVehicleExitSupportHeightSafe(0.2, 0.7, 1.25), true);
    assert.equal(isVehicleExitSupportHeightSafe(0.2, 12, 1.25), false);
    assert.equal(isVehicleExitSupportHeightSafe(null, 0, 1.25), false);
});

test('entry reachability rejects a building wall between walker and car', () => {
    const wall = [{ segments: [
        { ax: 2, az: -2, bx: 2, bz: 2 },
        { ax: 2, az: 2, bx: 4, bz: 2 },
        { ax: 4, az: 2, bx: 4, bz: -2 },
        { ax: 4, az: -2, bx: 2, bz: -2 },
    ] }];
    assert.equal(entryPathCrossesFootprints({ x: 0, z: 0 }, { x: 3, z: 0 }, wall), true);
    assert.equal(entryPathCrossesFootprints({ x: 0, z: 4 }, { x: 3, z: 4 }, wall), false);
});

test('entry reachability leaves body clearance beside a building wall', () => {
    const wall = [{ segments: [{ ax: 0, az: 0, bx: 5, bz: 0 }] }];
    assert.equal(entryPathCrossesFootprints(
        { x: 1, z: 0.2 },
        { x: 4, z: 0.2 },
        wall,
        0.35,
    ), true);
    assert.equal(entryPathCrossesFootprints(
        { x: 1, z: 0.6 },
        { x: 4, z: 0.6 },
        wall,
        0.35,
    ), false);
});

test('entry reachability applies obstacle clearance to the short approach', () => {
    const lamp = [{ x: 1.5, z: 0.6, radiusM: 0.15 }];
    assert.equal(entryPathCrossesObstacles(
        { x: 0, z: 0 },
        { x: 3, z: 0 },
        lamp,
        0.5,
    ), true);
    assert.equal(entryPathCrossesObstacles(
        { x: 0, z: 0 },
        { x: 3, z: 0 },
        lamp,
        0.2,
    ), false);
});

test('entry reachability rejects an authoritative rotated civil wall', () => {
    const wall = [{ cx: 2, cz: 0, hx: 1.5, hz: 0.1, sin: 0, cos: 1 }];
    assert.equal(entryPathCrossesColliderBoxes(
        { x: 0, z: 0.6 },
        { x: 4, z: 0.6 },
        wall,
        0.55,
    ), true);
    assert.equal(entryPathCrossesColliderBoxes(
        { x: 0, z: 0.8 },
        { x: 4, z: 0.8 },
        wall,
        0.55,
    ), false);
    const rotated = [{ cx: 2, cz: 0, hx: 1.5, hz: 0.1, sin: 1, cos: 0 }];
    assert.equal(entryPathCrossesColliderBoxes(
        { x: 2.4, z: -2 },
        { x: 2.4, z: 2 },
        rotated,
        0.35,
    ), true);
});

test('failed support preparation retries at the content rate or immediately for changed input', async () => {
    const { fixedSurfaceRetryReady } = await import('../core/gta-collider-bubble.js');
    const owner = {}, inputs = [10, 20, owner, 3];
    const failed = { inputs, atMs: 1000 };
    for (let ms = 1001; ms < 3000; ms += 16) {
        assert.equal(fixedSurfaceRetryReady(failed, [...inputs], ms, 2000), false);
    }
    assert.equal(fixedSurfaceRetryReady(failed, [...inputs], 3000, 2000), true);
    assert.equal(fixedSurfaceRetryReady(failed, [10, 20, owner, 4], 1001, 2000), true);
    assert.equal(fixedSurfaceRetryReady(failed, [10, 20, {}, 3], 1001, 2000), true);
    assert.equal(fixedSurfaceRetryReady(failed, [11, 20, owner, 3], 1001, 2000), true);
    assert.equal(fixedSurfaceRetryReady(null, inputs, 1001, 2000), true);
    assert.equal(fixedSurfaceRetryReady({ ...failed, attempts: 3 }, inputs, 1e9, 2000), false);
    assert.equal(fixedSurfaceRetryReady({ ...failed, attempts: 3 }, [10, 20, owner, 4], 1001, 2000), true);
});
