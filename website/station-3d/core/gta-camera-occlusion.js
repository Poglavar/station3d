// Keeps an external vehicle camera on the visible side of physical terrain
// and buildings. This module has no Three.js dependency so the ray/placement
// contract is covered with fast tests.

import { finiteOrNull } from './math.js';

export function cameraLineOfSightRay(target, desired) {
    const start = {
        x: finiteOrNull(target?.x) ?? 0,
        y: finiteOrNull(target?.y) ?? 0,
        z: finiteOrNull(target?.z) ?? 0,
    };
    const end = {
        x: finiteOrNull(desired?.x) ?? start.x,
        y: finiteOrNull(desired?.y) ?? start.y,
        z: finiteOrNull(desired?.z) ?? start.z,
    };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const distanceM = Math.hypot(dx, dy, dz);
    const inverse = distanceM > 1e-9 ? 1 / distanceM : 0;
    return {
        origin: start,
        direction: {
            x: dx * inverse,
            y: dy * inverse,
            z: dz * inverse,
        },
        distanceM,
    };
}

export function resolveCameraRayHit({
    target,
    desired,
    hitDistanceM = null,
    paddingM = 0.45,
} = {}) {
    const ray = cameraLineOfSightRay(target, desired);
    const hit = finiteOrNull(hitDistanceM);
    if (ray.distanceM <= 1e-9 || hit === null || hit < 0 || hit >= ray.distanceM) {
        return {
            x: finiteOrNull(desired?.x) ?? ray.origin.x,
            y: finiteOrNull(desired?.y) ?? ray.origin.y,
            z: finiteOrNull(desired?.z) ?? ray.origin.z,
            occluded: false,
            desiredDistanceM: ray.distanceM,
            resolvedDistanceM: ray.distanceM,
        };
    }
    // Never step through a blocker to honour a cosmetic minimum camera
    // distance. If a wall is directly behind the car, close framing is the
    // only placement that can preserve line of sight.
    const resolvedDistanceM = Math.max(
        0.05,
        Math.min(ray.distanceM, hit - Math.max(0, finiteOrNull(paddingM) ?? 0)),
    );
    return {
        x: ray.origin.x + ray.direction.x * resolvedDistanceM,
        y: ray.origin.y + ray.direction.y * resolvedDistanceM,
        z: ray.origin.z + ray.direction.z * resolvedDistanceM,
        occluded: true,
        desiredDistanceM: ray.distanceM,
        resolvedDistanceM,
    };
}

export function resolvePhysicsCameraLineOfSight({
    RAPIER,
    world,
    target,
    desired,
    physicsOrigin = null,
    collisionGroups,
    filterPredicate,
    paddingM = 0.45,
} = {}) {
    const ray = cameraLineOfSightRay(target, desired);
    if (!RAPIER?.Ray || typeof world?.castRay !== 'function' || ray.distanceM <= 1e-9) {
        return resolveCameraRayHit({ target, desired });
    }
    const offsetX = finiteOrNull(physicsOrigin?.x) ?? 0;
    const offsetZ = finiteOrNull(physicsOrigin?.z) ?? 0;
    const physicsRay = new RAPIER.Ray(
        {
            x: ray.origin.x - offsetX,
            y: ray.origin.y,
            z: ray.origin.z - offsetZ,
        },
        ray.direction,
    );
    const hit = world.castRay(
        physicsRay,
        ray.distanceM,
        true,
        undefined,
        collisionGroups,
        undefined,
        undefined,
        filterPredicate,
    );
    return {
        ...resolveCameraRayHit({
            target,
            desired,
            hitDistanceM: hit?.timeOfImpact,
            paddingM,
        }),
        collider: hit?.collider || null,
    };
}
