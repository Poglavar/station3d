// Pure admission policy for the GTA traffic-physics bubble. Keeping this out
// of the Three/Rapier integration makes hysteresis, cap priority and identity
// behavior deterministic and headless-testable.

import { colliderSpecOverlapsVehicle } from './gta-collider-bubble.js';
import { finiteOrNull } from './math.js';

export function trafficPhysicsMode(obstacle) {
    return obstacle?.state === 'moving' ? 'dynamic' : 'kinematic';
}

// A promoted car has two poses: the Rapier body that can be held up by real
// collisions and a route shadow that owns graph progress. Keep the shadow only
// a short, speed-scaled distance ahead. This preserves a useful steering target
// without allowing a blocked body's route state and heading to escape down the
// road while the visible car remains in the traffic queue.
export function promotedTrafficRouteMayAdvance({ actual, target, tuning } = {}) {
    const actualX = finiteOrNull(actual?.x);
    const actualZ = finiteOrNull(actual?.z);
    const targetX = finiteOrNull(target?.x);
    const targetZ = finiteOrNull(target?.z);
    if (actualX === null || actualZ === null || targetX === null || targetZ === null) {
        return false;
    }
    const speedMps = Math.max(
        0,
        finiteOrNull(actual?.speedMps ?? actual?.speed) ?? 0,
    );
    const baseLeadM = Math.max(0, finiteOrNull(tuning?.routeTargetBaseLeadM) ?? 0);
    const leadTimeS = Math.max(0, finiteOrNull(tuning?.routeTargetLeadTimeS) ?? 0);
    const configuredMaxLeadM = finiteOrNull(tuning?.routeTargetMaxLeadM);
    const maxLeadM = Math.max(
        baseLeadM,
        configuredMaxLeadM === null ? baseLeadM : configuredMaxLeadM,
    );
    const allowedLeadM = Math.min(maxLeadM, baseLeadM + speedMps * leadTimeS);
    return Math.hypot(targetX - actualX, targetZ - actualZ) <= allowedLeadM;
}

// Reject a streamed traffic spawn whose physical footprint would begin inside
// an existing moving car, parked car, wreck or controlled car. Rapier must not
// be asked to depenetrate an overlap the traffic scheduler created itself.
export function trafficSpawnHasClearance(candidate, occupants = [], paddingM = 0.8) {
    const x = finiteOrNull(candidate?.x);
    const z = finiteOrNull(candidate?.z);
    const widthM = finiteOrNull(candidate?.widthM);
    const lengthM = finiteOrNull(candidate?.lengthM);
    if (x === null || z === null || widthM === null || lengthM === null
        || widthM <= 0 || lengthM <= 0) return false;
    const vehicle = {
        x,
        z,
        heading: finiteOrNull(candidate?.heading) ?? 0,
        halfWidthM: widthM * 0.5,
        halfLengthM: lengthM * 0.5,
    };
    for (const occupant of occupants || []) {
        const occupantX = finiteOrNull(occupant?.x);
        const occupantZ = finiteOrNull(occupant?.z);
        const occupantWidthM = finiteOrNull(occupant?.widthM);
        const occupantLengthM = finiteOrNull(occupant?.lengthM);
        if (occupantX === null || occupantZ === null
            || occupantWidthM === null || occupantLengthM === null
            || occupantWidthM <= 0 || occupantLengthM <= 0) continue;
        if (colliderSpecOverlapsVehicle({
            x: occupantX,
            z: occupantZ,
            yaw: finiteOrNull(occupant?.heading) ?? 0,
            halfX: occupantWidthM * 0.5,
            halfZ: occupantLengthM * 0.5,
        }, vehicle, paddingM)) return false;
    }
    return true;
}

function signedAngleDelta(target, current) {
    const tau = Math.PI * 2;
    return ((target - current + Math.PI) % tau + tau) % tau - Math.PI;
}

export function trafficGuidanceCommand({
    translation,
    velocity,
    yaw = 0,
    angularVelocity,
    target,
    dt = 0,
    tuning,
} = {}) {
    const step = Math.max(0, Number(dt) || 0);
    const targetX = Number(target?.x) || 0;
    const targetZ = Number(target?.z) || 0;
    const targetHeading = Number(target?.heading) || 0;
    const targetSpeed = Math.max(0, Number(target?.speedMps) || 0);
    let recoveryX = (targetX - (Number(translation?.x) || 0))
        * tuning.positionRecoveryGain;
    let recoveryZ = (targetZ - (Number(translation?.z) || 0))
        * tuning.positionRecoveryGain;
    const recoveryMagnitude = Math.hypot(recoveryX, recoveryZ);
    if (recoveryMagnitude > tuning.maxPositionRecoveryMps) {
        const scale = tuning.maxPositionRecoveryMps / recoveryMagnitude;
        recoveryX *= scale;
        recoveryZ *= scale;
    }
    const desiredX = Math.sin(targetHeading) * targetSpeed + recoveryX;
    const desiredZ = Math.cos(targetHeading) * targetSpeed + recoveryZ;
    const currentX = Number(velocity?.x) || 0;
    const currentZ = Number(velocity?.z) || 0;
    let deltaX = desiredX - currentX;
    let deltaZ = desiredZ - currentZ;
    const maxDeltaV = tuning.maxRecoveryAccelerationMps2 * step;
    const deltaMagnitude = Math.hypot(deltaX, deltaZ);
    if (deltaMagnitude > maxDeltaV && deltaMagnitude > 0) {
        const scale = maxDeltaV / deltaMagnitude;
        deltaX *= scale;
        deltaZ *= scale;
    }
    const yawRate = Math.max(
        -tuning.maxYawRateRadS,
        Math.min(
            tuning.maxYawRateRadS,
            signedAngleDelta(targetHeading, Number(yaw) || 0) * tuning.headingRecoveryGain,
        ),
    );
    return {
        linearVelocity: {
            x: currentX + deltaX,
            y: Number(velocity?.y) || 0,
            z: currentZ + deltaZ,
        },
        angularVelocity: {
            x: Number(angularVelocity?.x) || 0,
            y: yawRate,
            z: Number(angularVelocity?.z) || 0,
        },
    };
}

export function planTrafficPhysicsBubble({
    obstacles = [],
    existingIds = [],
    contactingIds = [],
    centerX = 0,
    centerZ = 0,
    enterRadiusM = 80,
    retireRadiusM = 120,
    maxBodies = 32,
} = {}) {
    const existing = new Set(existingIds || []);
    const contacting = new Set(contactingIds || []);
    const enterSq = Math.max(0, Number(enterRadiusM) || 0) ** 2;
    const retireSq = Math.max(0, Number(retireRadiusM) || 0) ** 2;
    const byId = new Map();

    for (const obstacle of obstacles || []) {
        const id = String(obstacle?.id || '');
        const x = Number(obstacle?.x);
        const z = Number(obstacle?.z);
        if (!id || !Number.isFinite(x) || !Number.isFinite(z)) continue;
        const distanceSq = (x - centerX) ** 2 + (z - centerZ) ** 2;
        const wasExisting = existing.has(id);
        const hasContact = contacting.has(id);
        if (!hasContact && distanceSq > (wasExisting ? retireSq : enterSq)) continue;
        const candidate = {
            id,
            obstacle,
            distanceSq,
            existing: wasExisting,
            contacting: hasContact,
            mode: trafficPhysicsMode(obstacle),
        };
        const previous = byId.get(id);
        if (!previous || candidate.distanceSq < previous.distanceSq) byId.set(id, candidate);
    }

    const eligible = [...byId.values()].sort((a, b) => (
        Number(b.contacting) - Number(a.contacting)
        || Number(b.existing) - Number(a.existing)
        || a.distanceSq - b.distanceSq
        || a.id.localeCompare(b.id)
    ));
    const limit = Math.max(0, Math.trunc(Number(maxBodies) || 0));
    const selected = eligible.slice(0, limit);
    const selectedIds = new Set(selected.map(candidate => candidate.id));
    const retireIds = [...existing].filter(id => !selectedIds.has(id)).sort();
    return {
        selected,
        retireIds,
        capacityHit: eligible.length > limit,
        eligibleCount: eligible.length,
    };
}
