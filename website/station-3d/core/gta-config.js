export const GTA_PHYSICS = Object.freeze({
    stepHz: 60,
    maxSubsteps: 4,
    colliderEnterRadiusM: 105,
    colliderRetireRadiusM: 155,
    colliderRefreshMoveM: 30,
    trafficEnterRadiusM: 80,
    trafficRetireRadiusM: 120,
    maxFixedColliders: 1200,
    // At most 96 road mesh chunks plus the other ground families stage together.
    // Active resources retain the existing cap; this bounds replacement peak.
    maxStagedSurfaceColliders: 102,
    // Geometry admission, separate from body count. A common subdivision may
    // be finer than either source grid; reject before allocating its buffers.
    maxTerrainColliderVertices: 131072,
    // Exact cut receivers retain source faces instead of inventing a common
    // subdivision across fine/coarse tiles. Chunk the native allocations at
    // the same triangle allowance used by road support; the shared 102-body
    // staging limit still applies to the complete combined ground group.
    maxTerrainSupportTriangles: 262144,
    maxTerrainColliderTriangles: 4096,
    maxBuildingColliders: 950,
    maxCivilColliders: 160,
    maxFurnitureColliders: 89,
    colliderOpsPerFrame: 16,
    colliderWorkBudgetMs: 2,
    colliderContentRefreshSeconds: 2,
    roadSurfaceColliderRadiusM: 110,
    maxRoadSurfaceProfiles: 96,
    // Observed complete 110 m city bubbles contain 16k–24k triangles. Admit
    // the complete geometry separately from one bounded native allocation;
    // 65,536 expanded triangles use 3 MiB of vertex/index buffers per copy.
    maxRoadSurfaceTriangles: 65536,
    maxRoadColliderTriangles: 4096,
    roadSurfaceMaxEdgeM: 8,
    roadSurfaceOffsetM: 0.025,
    formationDressingColliderRadiusM: 110,
    maxFormationDressingTriangles: 8000,
    railTrackbedColliderRadiusM: 112,
    maxRailTrackbedTriangles: 6000,
    railFormationDressingColliderRadiusM: 112,
    maxRailFormationDressingTriangles: 8000,
    curbSurfaceColliderRadiusM: 108,
    maxCurbSurfaceTriangles: 8000,
    authoredSurfaceColliderRadiusM: 108,
    maxAuthoredSurfaceTriangles: 12000,
    // A support farther above the wheel-contact plane is an overhead bridge
    // or tunnel roof, not ground the vehicle may snap or raycast onto.
    wheelOverheadClearanceM: 1.25,
    entrySafetyClearanceM: 0.18,
    entrySafetyReleaseDistanceM: 4,
    // Streamed walls and street furniture can arrive after a moving vehicle.
    // Never instantiate one already touching a live chassis: Rapier would
    // resolve the fresh penetration as a crash and can launch or roll the car.
    colliderSpawnClearanceM: 0.18,
    maxDynamicTraffic: 32,
    maxDebris: 48,
    maxSkidMarkSegments: 640,
    debrisTtlSeconds: 24,
    wreckTtlSeconds: 90,
    enterDistanceM: 3.2,
    exitMaxSpeedMps: 0.8,
    // A door-side probe must remain on the same local surface as the vehicle.
    // In particular, a nearby building roof is not a valid street-level exit.
    exitMaxSupportDeltaM: 1.25,
});

export const GTA_VEHICLE_TUNING = Object.freeze({
    chassisMassKg: 1250,
    chassisCenterOfMassY: -0.3,
    chassisPrincipalInertia: Object.freeze({ x: 1600, y: 1770, z: 365 }),
    chassisLinearDamping: 0.06,
    chassisAngularDamping: 0.7,
    engineForceN: 2400,
    reverseForceN: 1600,
    // Rapier expresses wheel braking as a maximum impulse per simulation
    // step, not a force. These values produce roughly 0.75 g service braking
    // at 60 Hz on the configured 1,250 kg chassis without the old nose-over.
    serviceBrakeImpulseNs: 42,
    handbrakeImpulseNs: 32,
    frontBrakeBias: 1.15,
    rearBrakeBias: 0.85,
    directionChangeThresholdMps: 0.65,
    parkingHoldMaxPlanarSpeedMps: 0.25,
    maxSteerLowSpeedRad: 0.5,
    maxSteerHighSpeedRad: 0.09,
    steerFadeStartMps: 4,
    steerFadeEndMps: 30,
    maxLateralAccelerationMps2: 5.5,
    referenceWheelbaseM: 2.5,
    surfacePenetrationToleranceM: 0.06,
    surfaceRecoveryMaxRiseM: 1.25,
    unsupportedEscapeMinDropM: 2.5,
    unsupportedEscapeMinDownSpeedMps: 0.75,
    checkpointMinUprightY: 0.55,
    checkpointMaxSurfaceGapM: 0.75,
    suspensionRestLengthM: 0.34,
    suspensionStiffness: 32,
    suspensionCompression: 4.4,
    suspensionRelaxation: 5.2,
    suspensionMaxForceN: 7200,
    suspensionMaxTravelM: 0.28,
    wheelFrictionSlip: 3.2,
    wheelSideFrictionStiffness: 1.35,
});

export const GTA_TRAFFIC_TUNING = Object.freeze({
    bodyDensityKgM3: 95,
    linearDamping: 0.35,
    angularDamping: 1.4,
    maxRecoveryAccelerationMps2: 5.5,
    positionRecoveryGain: 0.65,
    maxPositionRecoveryMps: 5,
    headingRecoveryGain: 2.2,
    maxYawRateRadS: 1.25,
    // The kinematic route shadow may lead the physical body just far enough to
    // guide it, but must stop advancing when a collision holds the body back.
    // Otherwise its segment/heading can run several streets ahead and every
    // blocked car in the physics bubble turns toward a future junction at once.
    routeTargetBaseLeadM: 1.5,
    routeTargetLeadTimeS: 0.35,
    routeTargetMaxLeadM: 5,
    collisionReleaseSteps: 15,
    contactPrioritySteps: 30,
});

export const GTA_IMPACT = Object.freeze({
    lowForceN: 900,
    mediumForceN: 3200,
    severeForceN: 7000,
    soundCooldownMs: 260,
    perObstacleCooldownMs: 700,
    // Damage has its own, higher threshold than the feedback bands. A scrape
    // that deserves a sound and a spark does not deserve a dent: sharing one
    // threshold meant kerbs, bollards and the car in front chewed through a
    // vehicle that has no other way to recover, and the campaign chase treats
    // reaching zero as a failed chapter.
    damageForceN: 5200,
    baseDamage: 1.5,
    damageSlope: 5,
    maxDamagePerContact: 12,
});

// A vehicle nobody is hitting any more tidies itself up. Without this, damage
// is a one-way ratchet across a whole session — every bump you ever took is
// still on the clock an hour later.
export const GTA_VEHICLE_REPAIR = Object.freeze({
    maxHealth: 100,
    // Long enough that it never repairs mid-crash or mid-firefight.
    delayS: 6,
    perSecond: 4,
    // A wreck stays a wreck. Repair is for shrugging off a bad drive, not for
    // undoing a destroyed car — the campaign's failure screen must still mean
    // something.
    minRepairableHealth: 1,
});

export const GTA_OBSTACLE_POLICY = Object.freeze({
    building: Object.freeze({ class: 'immutable-structure', destructive: false }),
    civil: Object.freeze({ class: 'immutable-structure', destructive: false }),
    tree: Object.freeze({ class: 'immutable-object', destructive: false }),
    fountain: Object.freeze({ class: 'immutable-object', destructive: false }),
    concrete_barrier: Object.freeze({ class: 'immutable-object', destructive: false }),
    lamp: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 4200 }),
    traffic_light: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 4600 }),
    sign: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 2500 }),
    bollard: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 2200 }),
    bench: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 3600 }),
    bin: Object.freeze({ class: 'breakaway-object', destructive: true, forceThresholdN: 1800 }),
    person: Object.freeze({ class: 'non-interactive-person', destructive: false, collision: false }),
});

// Rapier/Three vehicle yaw uses local +Z as 0°, while every published
// Station3D pose uses compass headings (local -Z / north is 0°). Keeping the
// conversion at the pose boundary is essential: road, curb and building
// corridors all consume headingDeg to decide which side of the observer to
// stream. Publishing the raw scene yaw sent those corridors behind a
// north/south-moving vehicle.
export function gtaSceneYawToHeadingDeg(yawRad) {
    const yaw = Number(yawRad);
    if (!Number.isFinite(yaw)) return 0;
    const heading = (Math.PI - yaw) * 180 / Math.PI;
    return ((heading % 360) + 360) % 360;
}

export function impactBandForForce(forceN, impact = GTA_IMPACT) {
    const force = Math.max(0, Number(forceN) || 0);
    if (force >= impact.severeForceN) return 'severe';
    if (force >= impact.mediumForceN) return 'medium';
    if (force >= impact.lowForceN) return 'low';
    return 'none';
}

export function vehicleDamageForImpact(forceN, impact = GTA_IMPACT) {
    const force = Math.max(0, Number(forceN) || 0);
    const threshold = impact.damageForceN;
    if (force < threshold) return 0;
    const scaled = (force - threshold) / Math.max(1, threshold);
    return Math.min(
        impact.maxDamagePerContact,
        impact.baseDamage + scaled * impact.damageSlope,
    );
}

// Health after `dt` seconds of not being hit. Returns the input unchanged while
// the vehicle is still inside the grace period, already full, or wrecked.
export function repairedVehicleHealth(
    health,
    secondsSinceDamage,
    dt,
    policy = GTA_VEHICLE_REPAIR,
) {
    const current = Number(health);
    if (!Number.isFinite(current)) return 0;
    if (current < policy.minRepairableHealth) return current;
    if (current >= policy.maxHealth) return policy.maxHealth;
    const idleS = Number(secondsSinceDamage);
    if (!Number.isFinite(idleS) || idleS < policy.delayS) return current;
    const step = policy.perSecond * Math.max(0, Number(dt) || 0);
    return Math.min(policy.maxHealth, current + step);
}

export function steeringLimitAtSpeed(speedMps, tuning = GTA_VEHICLE_TUNING) {
    const speed = Math.abs(Number(speedMps) || 0);
    const span = Math.max(0.001, tuning.steerFadeEndMps - tuning.steerFadeStartMps);
    const t = Math.max(0, Math.min(1, (speed - tuning.steerFadeStartMps) / span));
    const comfortLimit = tuning.maxSteerLowSpeedRad
        + (tuning.maxSteerHighSpeedRad - tuning.maxSteerLowSpeedRad) * t;
    if (speed <= tuning.steerFadeStartMps) return comfortLimit;
    // A fixed steering angle becomes violently unstable as speed rises because
    // lateral acceleration grows with v². Bound it to a plausible road-car
    // cornering envelope; at 80 km/h this is about 1.6°, not the old ~20°.
    const dynamicLimit = Math.atan(
        tuning.maxLateralAccelerationMps2 * tuning.referenceWheelbaseM
        / Math.max(1, speed * speed),
    );
    return Math.min(comfortLimit, dynamicLimit);
}

export function steeringInputForKeys({ left = false, right = false } = {}) {
    // The +Z Station3D chassis turns left for positive Rapier steering. Keep
    // the conventional game contract: A/left turns left, D/right turns right.
    return (left ? 1 : 0) - (right ? 1 : 0);
}

export function shouldReleaseLatchedStopOnKeyDown(key, { repeat = false } = {}) {
    if (repeat) return false;
    return ['w', 's', 'arrowup', 'arrowdown'].includes(String(key || '').toLowerCase());
}

export function shouldApplyStoppedVehicleHold({
    stop = false,
    playerContact = false,
    planarSpeedMps = Infinity,
} = {}, tuning = GTA_VEHICLE_TUNING) {
    const speed = Math.max(0, Number(planarSpeedMps));
    // `stop` is a latch. A still-held or stale throttle key must not make a
    // car creep down a slope after E/Stop has explicitly taken authority; a
    // fresh physical throttle press releases the latch before this is called.
    return !!stop && !playerContact && Number.isFinite(speed)
        && speed <= Math.max(0, Number(tuning.parkingHoldMaxPlanarSpeedMps) || 0);
}

export function shouldHandleVehicleResetKeyDown(key, event = {}) {
    if (String(key || '').toLowerCase() !== 'r' || event.repeat) return false;
    return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function driveCommandForKeys({
    forward = false,
    reverse = false,
    handbrake = false,
    stop = false,
    speedMps = 0,
} = {}, tuning = GTA_VEHICLE_TUNING) {
    const speed = Number(speedMps) || 0;
    const threshold = Math.max(0, Number(tuning.directionChangeThresholdMps) || 0);
    let engineForceN = 0;
    let serviceBrakeImpulseNs = 0;
    if (stop) serviceBrakeImpulseNs = tuning.serviceBrakeImpulseNs;
    else if (forward && reverse) serviceBrakeImpulseNs = tuning.serviceBrakeImpulseNs;
    else if (forward && speed < -threshold) serviceBrakeImpulseNs = tuning.serviceBrakeImpulseNs;
    else if (reverse && speed > threshold) serviceBrakeImpulseNs = tuning.serviceBrakeImpulseNs;
    // Rapier's ray-cast vehicle treats the negative direction of the selected
    // axis as forward. The controller is configured for axis Z, while visual
    // car heading 0 points toward +Z, hence the deliberate force inversion.
    else if (forward) engineForceN = -tuning.engineForceN;
    else if (reverse) engineForceN = tuning.reverseForceN;
    return {
        engineForceN,
        serviceBrakeImpulseNs,
        handbrakeImpulseNs: !stop && handbrake ? tuning.handbrakeImpulseNs : 0,
    };
}

export function vehicleSurfaceRecovery({
    supportProbeY,
    supportY,
    verticalVelocity = 0,
    toleranceM = GTA_VEHICLE_TUNING.surfacePenetrationToleranceM,
} = {}) {
    const probe = typeof supportProbeY === 'number' && Number.isFinite(supportProbeY)
        ? supportProbeY : null;
    const support = typeof supportY === 'number' && Number.isFinite(supportY)
        ? supportY : null;
    if (probe === null || support === null) return null;
    const penetrationM = support - probe;
    const tolerance = typeof toleranceM === 'number' && Number.isFinite(toleranceM)
        ? Math.max(0, toleranceM) : 0;
    if (penetrationM <= tolerance) return null;
    return {
        liftM: penetrationM,
        verticalVelocity: Math.max(
            0,
            typeof verticalVelocity === 'number' && Number.isFinite(verticalVelocity)
                ? verticalVelocity : 0,
        ),
    };
}
