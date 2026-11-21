import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

import {
    cameraLineOfSightRay,
    resolveCameraRayHit,
    resolvePhysicsCameraLineOfSight,
} from '../core/gta-camera-occlusion.js';
import { GTA_COLLISION_GROUPS } from '../core/gta-collision-groups.js';

await RAPIER.init();

function close(actual, expected, tolerance = 1e-5) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`,
    );
}

test('camera ray points from the followed object toward the desired chase position', () => {
    const ray = cameraLineOfSightRay(
        { x: 1, y: 2, z: 3 },
        { x: 1, y: 2, z: 13 },
    );
    assert.deepEqual(ray.origin, { x: 1, y: 2, z: 3 });
    assert.deepEqual(ray.direction, { x: 0, y: 0, z: 1 });
    assert.equal(ray.distanceM, 10);
});

test('an occluder pulls the camera to the visible side without crossing it', () => {
    const resolved = resolveCameraRayHit({
        target: { x: 0, y: 1, z: 0 },
        desired: { x: 0, y: 1, z: 10 },
        hitDistanceM: 5,
        paddingM: 0.45,
    });
    assert.equal(resolved.occluded, true);
    close(resolved.z, 4.55);
    assert.ok(resolved.resolvedDistanceM < 5);
});

test('a blocker immediately behind the vehicle never gets crossed for minimum distance', () => {
    const resolved = resolveCameraRayHit({
        target: { x: 0, y: 1, z: 0 },
        desired: { x: 0, y: 1, z: 10 },
        hitDistanceM: 0.2,
        paddingM: 0.45,
    });
    assert.equal(resolved.occluded, true);
    close(resolved.z, 0.05);
    assert.ok(resolved.z < 0.2);
});

test('Rapier terrain/building hits resolve in absolute coordinates after a physics rebase', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1, 5),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(2, 2, 1)
            .setCollisionGroups(GTA_COLLISION_GROUPS.obstacle),
        body,
    );
    world.step();
    const resolved = resolvePhysicsCameraLineOfSight({
        RAPIER,
        world,
        target: { x: 100, y: 1, z: 200 },
        desired: { x: 100, y: 1, z: 210 },
        physicsOrigin: { x: 100, z: 200 },
        collisionGroups: GTA_COLLISION_GROUPS.cameraQuery,
        filterPredicate: () => true,
    });
    assert.equal(resolved.occluded, true);
    close(resolved.z, 203.55);
    world.free();
});

test('an unobstructed desired camera position remains unchanged', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const desired = { x: 4, y: 5, z: 6 };
    const resolved = resolvePhysicsCameraLineOfSight({
        RAPIER,
        world,
        target: { x: 0, y: 1, z: 0 },
        desired,
        collisionGroups: GTA_COLLISION_GROUPS.cameraQuery,
        filterPredicate: () => true,
    });
    assert.equal(resolved.occluded, false);
    close(resolved.x, desired.x);
    close(resolved.y, desired.y);
    close(resolved.z, desired.z);
    world.free();
});
