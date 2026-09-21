// Recovers physical chassis penetration against the published Rapier ground.
// Suspension compression and the visual tyre-level origin are not penetration.

import {
    GTA_PHYSICS,
    GTA_VEHICLE_TUNING,
    vehicleSurfaceRecovery,
} from './gta-config.js';

function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function vehicleUprightY(rotation) {
    const qx = finiteNumberOrNull(rotation?.x) ?? 0;
    const qz = finiteNumberOrNull(rotation?.z) ?? 0;
    return 1 - 2 * (qx * qx + qz * qz);
}

// A stopped road vehicle resting on its side or roof is recovered before its
// door-side probes run. Otherwise a probe beside a wall can mistake the roof
// for ground and leave both the car and the player embedded in the building.
export function shouldRecoverOverturnedVehicleExit({
    rotation,
    speedMps = Infinity,
    maximumSpeedMps = GTA_PHYSICS.exitMaxSpeedMps,
    vehicleKind = 'road',
    minimumUprightY = GTA_VEHICLE_TUNING.checkpointMinUprightY,
} = {}) {
    if (String(vehicleKind || 'road') !== 'road') return false;
    const speed = Math.abs(finiteNumberOrNull(speedMps) ?? Infinity);
    const maximumSpeed = Math.max(0, finiteNumberOrNull(maximumSpeedMps) ?? 0);
    if (speed > maximumSpeed) return false;
    const threshold = Math.max(-1, Math.min(1, Number(minimumUprightY) || 0));
    return vehicleUprightY(rotation) < threshold;
}

// A stopped road car must never become a prison because both authored door
// probes landed on a kerb, traffic island, wall, or temporarily unavailable
// surface. Re-seat it on the nearest mapped road and probe again. Boats and
// aircraft keep their stricter environment-specific exit rules.
export function shouldRecoverBlockedVehicleExit({
    failure = '',
    speedMps = Infinity,
    maximumSpeedMps = GTA_PHYSICS.exitMaxSpeedMps,
    vehicleKind = 'road',
} = {}) {
    if (String(vehicleKind || 'road') !== 'road') return false;
    if (String(failure || '') !== 'no-safe-exit') return false;
    const speed = Math.abs(finiteNumberOrNull(speedMps) ?? Infinity);
    const maximumSpeed = Math.max(0, finiteNumberOrNull(maximumSpeedMps) ?? 0);
    return speed <= maximumSpeed;
}

function rotateVectorByQuaternion(vector, quaternion) {
    const qx = finiteNumberOrNull(quaternion?.x) ?? 0;
    const qy = finiteNumberOrNull(quaternion?.y) ?? 0;
    const qz = finiteNumberOrNull(quaternion?.z) ?? 0;
    const qw = finiteNumberOrNull(quaternion?.w) ?? 1;
    const tx = 2 * (qy * vector.z - qz * vector.y);
    const ty = 2 * (qz * vector.x - qx * vector.z);
    const tz = 2 * (qx * vector.y - qy * vector.x);
    return {
        x: vector.x + qw * tx + (qy * tz - qz * ty),
        y: vector.y + qw * ty + (qz * tx - qx * tz),
        z: vector.z + qw * tz + (qx * ty - qy * tx),
    };
}

export function shouldUseVehicleFootprintProbes({
    rotation,
    wheelContacts = 4,
    minimumUprightY = 0.992,
} = {}) {
    const uprightY = vehicleUprightY(rotation);
    return Math.max(0, Number(wheelContacts) || 0) < 3
        || uprightY < Math.max(0, Math.min(1, Number(minimumUprightY) || 0));
}

// World-space points on the physical underside, including its centre. A
// centre-only probe misses exactly the dangerous case: a long
// vehicle can pitch its nose through asphalt while its centre remains above
// the road. The corners are only needed while contact/tilt looks unsafe.
// On a rounded cuboid they lie on the flat bottom face, inside the rounded
// edge. Nominal tyre contacts are not chassis points: a curb between the
// wheels or compressed suspension can cross them without any penetration.
export function vehicleSurfaceProbePoints({
    translation,
    rotation,
    chassisHalfHeightM,
    halfWidthM,
    halfLengthM,
    roundingRadiusM = 0,
    includeCorners = true,
} = {}) {
    const center = {
        x: finiteNumberOrNull(translation?.x),
        y: finiteNumberOrNull(translation?.y),
        z: finiteNumberOrNull(translation?.z),
    };
    const chassisHalfHeight = finiteNumberOrNull(chassisHalfHeightM);
    const halfWidth = finiteNumberOrNull(halfWidthM);
    const halfLength = finiteNumberOrNull(halfLengthM);
    const radius = finiteNumberOrNull(roundingRadiusM);
    if (Object.values(center).some(value => value === null)
        || !(chassisHalfHeight > 0 && halfWidth > 0 && halfLength > 0)
        || radius === null || radius < 0
        || radius >= Math.min(chassisHalfHeight, halfWidth, halfLength)) {
        throw new RangeError('Vehicle recovery requires the physical chassis pose and dimensions');
    }
    const undersideX = halfWidth - radius;
    const undersideZ = halfLength - radius;
    const locals = [{ name: 'center', x: 0, y: -chassisHalfHeight, z: 0 }];
    if (includeCorners) for (const [name, x, z] of [
        ['chassis-front-left', -undersideX, undersideZ],
        ['chassis-front-right', undersideX, undersideZ],
        ['chassis-rear-left', -undersideX, -undersideZ],
        ['chassis-rear-right', undersideX, -undersideZ],
    ]) locals.push({ name, x, y: -chassisHalfHeight, z });
    return locals.map((local) => {
        const offset = rotateVectorByQuaternion(local, rotation);
        return {
            name: local.name,
            physicsX: center.x + offset.x,
            physicsZ: center.z + offset.z,
            physicsY: center.y + offset.y,
        };
    });
}

export function shouldProbeTrafficSurface({
    visualRootY,
    routeSupportY,
    stepsSinceContact = Infinity,
    collisionReleaseSteps = 0,
    toleranceM = GTA_VEHICLE_TUNING.surfacePenetrationToleranceM,
} = {}) {
    const rootY = finiteNumberOrNull(visualRootY);
    const supportY = finiteNumberOrNull(routeSupportY);
    if (rootY === null || supportY === null) return false;
    if ((Number(stepsSinceContact) || 0) <= Math.max(0, Number(collisionReleaseSteps) || 0)) {
        return false;
    }
    return supportY - rootY > Math.max(0, finiteNumberOrNull(toleranceM) ?? 0);
}

export function shouldRestoreVehicleCheckpoint({
    hasCheckpoint = false,
    wheelContacts = 0,
    supportY = null,
    visualRootY = null,
    checkpointRootY = null,
    verticalVelocity = 0,
    minimumDropM = GTA_VEHICLE_TUNING.unsupportedEscapeMinDropM,
    minimumDownwardSpeedMps = GTA_VEHICLE_TUNING.unsupportedEscapeMinDownSpeedMps,
} = {}) {
    if (!hasCheckpoint || Math.max(0, Number(wheelContacts) || 0) > 0) return false;
    // A real lower deck, terrain slope or valley floor is a valid place to
    // fall toward. Restore only when Rapier can find no support at all.
    if (finiteNumberOrNull(supportY) !== null) return false;
    const rootY = finiteNumberOrNull(visualRootY);
    const safeY = finiteNumberOrNull(checkpointRootY);
    const downSpeed = finiteNumberOrNull(verticalVelocity) ?? 0;
    if (rootY === null || safeY === null) return false;
    const drop = Math.max(0, finiteNumberOrNull(minimumDropM) ?? 2.5);
    const speed = Math.max(0, finiteNumberOrNull(minimumDownwardSpeedMps) ?? 0.75);
    return safeY - rootY >= drop && downSpeed <= -speed;
}

export function physicsSurfaceSupportY({
    RAPIER,
    surfaceColliders = [],
    physicsX,
    physicsZ,
    supportProbeY,
    maxCastDistanceM = 80,
    maxSupportRiseM = GTA_VEHICLE_TUNING.surfaceRecoveryMaxRiseM,
} = {}) {
    const x = finiteNumberOrNull(physicsX);
    const z = finiteNumberOrNull(physicsZ);
    const probeY = finiteNumberOrNull(supportProbeY);
    const colliders = (Array.isArray(surfaceColliders) ? surfaceColliders : [surfaceColliders])
        .filter(collider => typeof collider?.castRay === 'function');
    if (!RAPIER?.Ray || colliders.length === 0
        || x === null || z === null || probeY === null) return null;

    const maxRise = Math.max(0, finiteNumberOrNull(maxSupportRiseM) ?? 1.25);
    // Bound the ray BEFORE querying the collider. Casting from above a bridge
    // and rejecting that first hit afterwards loses the lower floor when both
    // levels share a single trimesh. No analytic height can raise this ceiling.
    const originY = probeY + maxRise;
    const maxDistance = Math.max(maxRise, finiteNumberOrNull(maxCastDistanceM) ?? 80);
    const ray = new RAPIER.Ray(
        { x, y: originY, z },
        { x: 0, y: -1, z: 0 },
    );
    let supportY = null;
    for (const collider of colliders) {
        const timeOfImpact = collider.castRay(ray, maxDistance, true);
        if (typeof timeOfImpact !== 'number' || !Number.isFinite(timeOfImpact)
            || timeOfImpact <= 0 || timeOfImpact > maxDistance) continue;
        // A zero hit may be a ray starting inside a solid deck. It does not
        // identify a supporting boundary within the allowed recovery height.
        const candidateY = originY - timeOfImpact;
        if (supportY === null || candidateY > supportY) supportY = candidateY;
    }
    return supportY;
}

export function recoverVehicleBodyFromSurfaces({
    RAPIER,
    surfaceColliders = [],
    chassisBody,
    supportProbes = [],
    toleranceM = GTA_VEHICLE_TUNING.surfacePenetrationToleranceM,
} = {}) {
    if (typeof chassisBody?.translation !== 'function'
        || typeof chassisBody?.linvel !== 'function') {
        return { recovered: false, supportY: null, liftM: 0 };
    }
    const velocity = chassisBody.linvel();
    let supportY = null, recovery = null, recoveryProbe = null, recoverySupportY = null;
    let recoveryPoint = null;
    const probes = Array.isArray(supportProbes) ? supportProbes : [];
    for (const [index, probe] of probes.entries()) {
        const probeSupportY = physicsSurfaceSupportY({
            RAPIER,
            surfaceColliders,
            physicsX: probe?.physicsX,
            physicsZ: probe?.physicsZ,
            supportProbeY: probe?.physicsY,
        });
        if (index === 0) supportY = probeSupportY;
        const candidate = vehicleSurfaceRecovery({
            supportProbeY: probe?.physicsY,
            supportY: probeSupportY,
            verticalVelocity: velocity.y,
            toleranceM,
        });
        if (!candidate || (recovery && candidate.liftM <= recovery.liftM)) continue;
        recovery = candidate;
        recoveryProbe = String(probe?.name || 'footprint');
        recoverySupportY = probeSupportY;
        recoveryPoint = probe;
    }
    if (!recovery) return { recovered: false, supportY, liftM: 0, probeCount: probes.length };

    const translation = chassisBody.translation();
    chassisBody.setTranslation({
        x: translation.x,
        y: translation.y + recovery.liftM,
        z: translation.z,
    }, true);
    chassisBody.setLinvel({
        x: velocity.x,
        y: recovery.verticalVelocity,
        z: velocity.z,
    }, true);
    return {
        recovered: true,
        supportY,
        liftM: recovery.liftM,
        recoveryProbe,
        recoverySupportY,
        recoveryPoint,
        probeCount: probes.length,
    };
}
