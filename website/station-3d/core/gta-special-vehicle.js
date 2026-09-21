// Pure arcade motion for GTA boats and aircraft. World modules own spawning
// and meshes; this module only advances bounded, testable vehicle state.

import { gtaSceneYawToHeadingDeg } from './gta-config.js';
import { resolveBoatMovement } from './boat-navigation.js';

const TAU = Math.PI * 2;

export const GTA_SPECIAL_VEHICLE_TUNING = Object.freeze({
    boat: Object.freeze({
        accelerationMps2: 4.0,
        reverseAccelerationMps2: 2.0,
        dragMps2: 0.75,
        maxForwardMps: 18,
        maxReverseMps: 5,
        maxTurnRateRadS: 0.72,
    }),
    airplane: Object.freeze({
        accelerationMps2: 8.5,
        brakingMps2: 12,
        rollingDragMps2: 0.45,
        airDragMps2: 0.12,
        minAirSpeedMps: 30,
        takeoffSpeedMps: 34,
        maxSpeedMps: 92,
        taxiTurnRateRadS: 0.55,
        airTurnRateRadS: 0.48,
        pitchRateRadS: 0.42,
        maxPitchRad: 22 * Math.PI / 180,
        maxBankRad: 38 * Math.PI / 180,
        groundClearanceM: 0.45,
        // Engine-out glide. The solver has no lift model, so a dead engine is
        // a constant sink the pilot can soften with a shallow flare but never
        // climb out of, while the speed bleeds down to a glide.
        glideSpeedMps: 36,
        glideDecelerationMps2: 1.4,
        // 5 m/s from 300 m on the 2.4 km approach ring puts a hands-off glide
        // down inside Viška luka; a shallower glide overshoots onto the town.
        glideSinkMps: 5,
        glideMaxPitchUpRad: 5 * Math.PI / 180,
        windmillRadS: 3,
        cruiseThrottle: 0.5,
    }),
    // What a touchdown becomes. Water is survivable only when the aircraft
    // arrives slow and nearly level; a steep arrival is a wreck on any surface.
    touchdown: Object.freeze({
        // Above the engine-out sink with a couple of degrees of nose-down to
        // spare, so a level or gently dived glide survives the water.
        ditchMaxVerticalSpeedMps: 7,
        ditchMaxSpeedMps: 58,
        landMaxVerticalSpeedMps: 7,
        waterClearanceM: 0.3,
        ditchSettleDepthM: 0.35,
        wreckSettleDepthM: 0.9,
        waterDecelerationMps2: 6,
        wreckDecelerationMps2: 14,
    }),
});

// Pure verdict on an aircraft meeting a surface. Exported so the campaign's
// bail-out/ditch scene and the free-roam wreck rule share one threshold set.
export function classifyAircraftTouchdown({
    surface = 'land',
    speedMps = 0,
    verticalSpeedMps = 0,
} = {}) {
    const rules = GTA_SPECIAL_VEHICLE_TUNING.touchdown;
    const sink = Math.abs(finite(verticalSpeedMps) ?? 0);
    const speed = Math.abs(finite(speedMps) ?? 0);
    if (surface === 'water') {
        return sink <= rules.ditchMaxVerticalSpeedMps && speed <= rules.ditchMaxSpeedMps
            ? 'ditched'
            : 'crashed';
    }
    return sink <= rules.landMaxVerticalSpeedMps ? 'landed' : 'crashed';
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function approach(value, target, maxDelta) {
    if (value < target) return Math.min(target, value + maxDelta);
    if (value > target) return Math.max(target, value - maxDelta);
    return value;
}

function wrapAngle(value) {
    let angle = Number(value) || 0;
    while (angle > Math.PI) angle -= TAU;
    while (angle < -Math.PI) angle += TAU;
    return angle;
}

// The motion fields a spawn record dictates. An airborne aircraft spawn (an
// authored flight already under way) starts at cruise with the power held so
// it flies itself until the pilot touches a control.
function spawnMotion(kind, spawn) {
    const airplane = kind === 'airplane';
    const airborne = airplane && spawn.airborne === true;
    const engineFailed = airplane && spawn.engineFailed === true;
    return {
        pitch: 0,
        roll: 0,
        speedMps: airborne ? spawn.speedMps : 0,
        throttle: airborne && !engineFailed
            ? GTA_SPECIAL_VEHICLE_TUNING.airplane.cruiseThrottle
            : 0,
        throttleLocked: airborne && !engineFailed,
        propellerAngle: 0,
        wakePhase: 0,
        grounded: airplane && !airborne,
        engineFailed,
        wrecked: false,
        surface: null,
        touchdown: null,
    };
}

export function createGtaSpecialVehicleState(vehicle) {
    const kind = vehicle?.kind === 'airplane' ? 'airplane' : 'boat';
    const spawn = {
        x: Number(vehicle?.x) || 0,
        y: Number(vehicle?.y) || 0,
        z: Number(vehicle?.z) || 0,
        heading: Number(vehicle?.heading) || 0,
        airborne: kind === 'airplane' && vehicle?.airborne === true,
        speedMps: Math.max(0, finite(vehicle?.speedMps) ?? 0),
        engineFailed: kind === 'airplane' && vehicle?.engineFailed === true,
    };
    const hullScale = finite(vehicle?.hullScale);
    return {
        id: String(vehicle?.id || `${kind}:controlled`),
        kind,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        heading: spawn.heading,
        // A smaller hull tests smaller clearance probes (core/boat-navigation.js).
        hullScale: hullScale !== null && hullScale > 0 ? hullScale : 1,
        ...spawnMotion(kind, spawn),
        spawn,
    };
}

export function resetGtaSpecialVehicleState(state) {
    if (!state?.spawn) return state;
    const { x, y, z, heading } = state.spawn;
    Object.assign(state, { x, y, z, heading }, spawnMotion(state.kind, state.spawn));
    return state;
}

// Cuts the engine for good: the throttle dies, the power hold releases and
// the aircraft becomes a glider until it is reset. Returns whether anything
// changed so a repeated authored effect stays idempotent.
export function failAircraftEngine(state) {
    if (state?.kind !== 'airplane' || state.engineFailed) return false;
    state.engineFailed = true;
    state.throttleLocked = false;
    return true;
}

export function specialVehicleInputForKeys(keys, { stop = false, kind = null } = {}) {
    const held = keys instanceof Set ? keys : new Set(keys || []);
    const airplane = kind === 'airplane';
    return {
        forward: airplane ? held.has(' ') : held.has('w'),
        reverse: !airplane && held.has('s'),
        left: held.has('a') || held.has('arrowleft'),
        right: held.has('d') || held.has('arrowright'),
        pitchUp: airplane
            ? held.has('s') || held.has('arrowdown')
            : held.has('arrowup'),
        pitchDown: airplane
            ? held.has('w') || held.has('arrowup')
            : held.has('arrowdown'),
        throttleDown: airplane && held.has('x'),
        brake: stop || (airplane ? held.has('b') : held.has(' ')),
    };
}

export function applyAirplaneThrottleKeyDown(state, key, { repeat = false } = {}) {
    if (state?.kind !== 'airplane') return false;
    if (key === 'q') {
        if (!repeat) state.throttleLocked = true;
        return true;
    }
    if (key === ' ') {
        if (!repeat) state.throttleLocked = false;
        return true;
    }
    return false;
}

// Steering authority a boat keeps while its throttle is open, whatever its
// speed over ground. See the comment at its use in stepBoat.
export const BOAT_THRUST_STEER_AUTHORITY = 0.45;

function stepBoat(state, input, dt, { isWaterAt, waterYAt } = {}) {
    const tuning = GTA_SPECIAL_VEHICLE_TUNING.boat;
    const currentWaterY = typeof waterYAt === 'function'
        ? finite(waterYAt(state.x, state.z))
        : null;
    if (typeof waterYAt === 'function' && currentWaterY === null) return false;
    const drive = input.brake ? 0 : input.forward ? 1 : input.reverse ? -1 : 0;
    state.throttle = approach(state.throttle, Math.abs(drive), dt * 2.5);
    if (drive > 0) state.speedMps += tuning.accelerationMps2 * dt;
    else if (drive < 0) state.speedMps -= tuning.reverseAccelerationMps2 * dt;
    else state.speedMps = approach(state.speedMps, 0, tuning.dragMps2 * dt);
    if (input.brake) state.speedMps = approach(state.speedMps, 0, 7 * dt);
    state.speedMps = clamp(state.speedMps, -tuning.maxReverseMps, tuning.maxForwardMps);

    const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    // A boat under power swings its bow from rest — an outboard vectors thrust
    // and does not need way on the way a rudder does. Without that floor a boat
    // that has nosed into the shore is trapped for good: touching land zeroes
    // its speed, and zero speed used to mean zero steering authority, so
    // neither helm nor throttle could recover it. Ten seconds of reverse moved
    // one beached boat 2.3 m, which ended the Adriatic chapter.
    const steerAuthority = Math.max(
        drive !== 0 ? BOAT_THRUST_STEER_AUTHORITY : 0,
        Math.min(1, Math.abs(state.speedMps) / 4),
    );
    const travelDirection = state.speedMps < 0 ? -1 : 1;
    const previous = { x: state.x, z: state.z, heading: state.heading, hullScale: state.hullScale };
    state.heading = wrapAngle(
        state.heading + steer * travelDirection * tuning.maxTurnRateRadS * steerAuthority * dt,
    );
    const previousX = state.x;
    const previousZ = state.z;
    const nextX = state.x + Math.sin(state.heading) * state.speedMps * dt;
    const nextZ = state.z + Math.cos(state.heading) * state.speedMps * dt;
    const requested = { x: nextX, z: nextZ, heading: state.heading, hullScale: state.hullScale };
    const resolved = resolveBoatMovement(previous, requested, isWaterAt);
    state.x = resolved.x;
    state.z = resolved.z;
    state.heading = resolved.heading;
    if (resolved !== requested) {
        const advance = ((state.x - previousX) * Math.sin(state.heading)
            + (state.z - previousZ) * Math.cos(state.heading)) * travelDirection;
        state.speedMps = travelDirection * Math.min(Math.abs(state.speedMps), Math.max(0, advance / Math.max(dt, .001)));
    }
    const waterY = typeof waterYAt === 'function'
        ? finite(waterYAt(state.x, state.z))
        : null;
    if (waterY !== null) state.y = waterY;
    else if (currentWaterY !== null) {
        state.x = previousX;
        state.z = previousZ;
        state.speedMps = 0;
        state.y = currentWaterY;
    }
    state.roll = approach(state.roll, -steer * steerAuthority * 0.12, 1.5 * dt);
    state.pitch = approach(state.pitch, -clamp(state.speedMps / 80, -0.05, 0.12), 0.5 * dt);
    return true;
}

// Settles an aircraft onto the surface it just met and records the verdict.
// Water always drowns the engine; a wreck on either surface is finished until
// the aircraft is reset.
function touchDownAircraft(state, { surface, restY }) {
    const rules = GTA_SPECIAL_VEHICLE_TUNING.touchdown;
    const verticalSpeedMps = specialVehicleVerticalSpeedMps(state);
    const outcome = classifyAircraftTouchdown({
        surface,
        speedMps: state.speedMps,
        verticalSpeedMps,
    });
    state.touchdown = {
        surface,
        outcome,
        speedMps: state.speedMps,
        verticalSpeedMps,
        x: state.x,
        z: state.z,
    };
    state.grounded = true;
    state.surface = surface;
    state.wrecked = outcome === 'crashed';
    state.roll = 0;
    if (surface === 'water') {
        state.engineFailed = true;
        state.throttle = 0;
        state.throttleLocked = false;
        state.y = restY - (state.wrecked ? rules.wreckSettleDepthM : rules.ditchSettleDepthM);
        state.pitch = (state.wrecked ? -14 : -2) * Math.PI / 180;
        return;
    }
    state.y = restY;
    state.pitch = 0;
    if (state.wrecked) {
        state.engineFailed = true;
        state.throttle = 0;
        state.throttleLocked = false;
    }
}

// Leaving the ground forgets the last touchdown; the next one is a fresh verdict.
function liftOff(state, pitch) {
    state.grounded = false;
    state.surface = null;
    state.touchdown = null;
    state.pitch = pitch;
}

// A ditched or wrecked aircraft only skids to a stop along its heading.
function stepDisabledAircraft(state, dt, decelerationMps2, restY) {
    state.throttle = 0;
    state.throttleLocked = false;
    state.speedMps = approach(Math.max(0, state.speedMps), 0, decelerationMps2 * dt);
    state.x += Math.sin(state.heading) * state.speedMps * dt;
    state.z += Math.cos(state.heading) * state.speedMps * dt;
    if (restY !== null) state.y = restY;
    state.roll = approach(state.roll, 0, 0.6 * dt);
    return true;
}

function stepAirplane(state, input, dt, { isRunwayAt, groundYAt, isWaterAt, waterYAt } = {}) {
    const tuning = GTA_SPECIAL_VEHICLE_TUNING.airplane;
    const rules = GTA_SPECIAL_VEHICLE_TUNING.touchdown;
    if (state.grounded && state.surface === 'water') {
        const waterY = typeof waterYAt === 'function' ? finite(waterYAt(state.x, state.z)) : null;
        return stepDisabledAircraft(
            state,
            dt,
            rules.waterDecelerationMps2,
            waterY === null
                ? null
                : waterY - (state.wrecked ? rules.wreckSettleDepthM : rules.ditchSettleDepthM),
        );
    }
    const groundY = typeof groundYAt === 'function'
        ? finite(groundYAt(state.x, state.z))
        : 0;
    // A grounded aircraft is terrain-relative. Freeze the complete state --
    // including throttle and propeller animation -- until its local support is
    // genuine evidence. Airborne aircraft remain independent of terrain until
    // evidence becomes available for collision/landing again.
    if (state.grounded && groundY === null) return false;
    const supportY = (groundY ?? 0) + tuning.groundClearanceM;
    if (state.grounded && state.wrecked) {
        return stepDisabledAircraft(state, dt, rules.wreckDecelerationMps2, supportY);
    }

    let throttleTarget = 0;
    if (!state.engineFailed && !input.brake && !input.throttleDown) {
        if (input.forward) throttleTarget = 1;
        else if (state.throttleLocked) throttleTarget = state.throttle;
    }
    const throttleRate = state.engineFailed
        ? 1.5
        : input.brake
            ? 2.5
            : input.throttleDown
                ? 0.85
                : throttleTarget > state.throttle ? 0.65 : 0.28;
    state.throttle = approach(state.throttle, throttleTarget, dt * throttleRate);
    if (state.engineFailed) state.throttleLocked = false;

    if (state.grounded) {
        // Wheel braking cuts thrust immediately. Letting the residual throttle
        // keep accelerating while B was held made a high-power taxi take far
        // too long to stop even though the UI called it a brake.
        state.speedMps += (input.brake ? 0 : state.throttle)
            * tuning.accelerationMps2 * dt;
        state.speedMps = approach(
            state.speedMps,
            0,
            (input.brake ? tuning.brakingMps2 : tuning.rollingDragMps2) * dt,
        );
        state.speedMps = clamp(state.speedMps, 0, tuning.maxSpeedMps);
        const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
        const taxiAuthority = clamp(1 - state.speedMps / 55, 0.2, 1);
        state.heading = wrapAngle(state.heading + steer * tuning.taxiTurnRateRadS * taxiAuthority * dt);
        const nextX = state.x + Math.sin(state.heading) * state.speedMps * dt;
        const nextZ = state.z + Math.cos(state.heading) * state.speedMps * dt;
        const supportedByRunway = typeof isRunwayAt !== 'function' || isRunwayAt(nextX, nextZ);
        if (supportedByRunway) {
            state.x = nextX;
            state.z = nextZ;
        } else if (state.speedMps < tuning.takeoffSpeedMps) {
            state.speedMps = Math.max(0, state.speedMps - tuning.brakingMps2 * dt);
        } else {
            // Crossing the mapped runway end at flying speed must not create a
            // dead stop. Rotate gently and carry the aircraft into the air.
            state.x = nextX;
            state.z = nextZ;
            liftOff(state, Math.max(state.pitch, 4 * Math.PI / 180));
        }
        state.y = supportY;
        const wantsTakeoff = state.grounded
            && input.pitchUp
            && state.speedMps >= tuning.takeoffSpeedMps;
        if (wantsTakeoff) liftOff(state, 5 * Math.PI / 180);
        state.roll = approach(state.roll, 0, 1.8 * dt);
        return true;
    }

    if (state.engineFailed) {
        // Gliding: no thrust, speed settles onto the glide speed from either
        // side, and the pilot may flare only a few degrees.
        state.speedMps = approach(state.speedMps, tuning.glideSpeedMps, tuning.glideDecelerationMps2 * dt);
    } else {
        state.speedMps += state.throttle * tuning.accelerationMps2 * dt;
        state.speedMps = approach(state.speedMps, tuning.minAirSpeedMps, tuning.airDragMps2 * dt);
        if (input.brake) state.speedMps = approach(state.speedMps, tuning.minAirSpeedMps, 4 * dt);
    }
    state.speedMps = clamp(state.speedMps, tuning.minAirSpeedMps, tuning.maxSpeedMps);
    const bank = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const targetRoll = bank * tuning.maxBankRad;
    state.roll = approach(state.roll, targetRoll, 1.15 * dt);
    state.heading = wrapAngle(state.heading + Math.sin(state.roll) * tuning.airTurnRateRadS * dt);
    const pitchInput = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    const maxPitchUp = state.engineFailed ? tuning.glideMaxPitchUpRad : tuning.maxPitchRad;
    state.pitch = clamp(
        state.pitch + pitchInput * tuning.pitchRateRadS * dt,
        -tuning.maxPitchRad,
        Math.max(maxPitchUp, Math.min(state.pitch, tuning.maxPitchRad)),
    );
    // A nose held above the glide limit when the engine quit drops to it at
    // the ordinary pitch rate instead of snapping.
    if (state.pitch > maxPitchUp) {
        state.pitch = approach(state.pitch, maxPitchUp, tuning.pitchRateRadS * dt);
    }
    if (!pitchInput) state.pitch = approach(state.pitch, 0, 0.08 * dt);
    const horizontalSpeed = Math.cos(state.pitch) * state.speedMps;
    state.x += Math.sin(state.heading) * horizontalSpeed * dt;
    state.z += Math.cos(state.heading) * horizontalSpeed * dt;
    state.y += specialVehicleVerticalSpeedMps(state) * dt;

    // Water under the aircraft takes precedence over the terrain sample beneath
    // it: the sea floor sits below the surface, and a sea-level terrain cell
    // plus the wheel clearance would otherwise "land" the aircraft above the
    // water it is about to hit.
    const overWater = typeof isWaterAt === 'function' && isWaterAt(state.x, state.z);
    const waterY = overWater && typeof waterYAt === 'function'
        ? finite(waterYAt(state.x, state.z))
        : null;
    if (waterY !== null) {
        if (state.y <= waterY + rules.waterClearanceM) {
            touchDownAircraft(state, { surface: 'water', restY: waterY });
        }
        return true;
    }
    const nextGround = typeof groundYAt === 'function'
        ? finite(groundYAt(state.x, state.z))
        : 0;
    const nextSupportY = nextGround === null
        ? null
        : nextGround + tuning.groundClearanceM;
    if (nextSupportY !== null && state.y <= nextSupportY) {
        touchDownAircraft(state, { surface: 'land', restY: nextSupportY });
    }
    return true;
}

export function stepGtaSpecialVehicle(state, input = {}, dt = 0, environment = {}) {
    if (!state) return null;
    const seconds = clamp(Number(dt) || 0, 0, 0.1);
    if (seconds <= 0) return state;
    const advanced = state.kind === 'airplane'
        ? stepAirplane(state, input, seconds, environment)
        : stepBoat(state, input, seconds, environment);
    if (advanced === false) return state;
    if (state.kind === 'airplane') {
        // A dead engine windmills with the airflow and stops with the aircraft.
        const propellerRadS = state.engineFailed
            ? (state.grounded ? 0 : GTA_SPECIAL_VEHICLE_TUNING.airplane.windmillRadS + Math.abs(state.speedMps) * 0.05)
            : 8 + state.throttle * 42 + Math.abs(state.speedMps) * 0.18;
        state.propellerAngle = (state.propellerAngle + propellerRadS * seconds) % TAU;
    } else {
        state.wakePhase = (state.wakePhase + Math.abs(state.speedMps) * seconds * 0.85) % TAU;
    }
    return state;
}

// Climb rate the solver is actually applying, so the instrument cannot drift
// away from the motion: stepAirplane integrates y by exactly this per second.
export function specialVehicleVerticalSpeedMps(state) {
    if (state?.kind !== 'airplane' || state.grounded) return 0;
    const speed = Number(state.speedMps);
    const pitch = Number(state.pitch);
    if (!Number.isFinite(speed) || !Number.isFinite(pitch)) return 0;
    const sink = state.engineFailed ? GTA_SPECIAL_VEHICLE_TUNING.airplane.glideSinkMps : 0;
    return Math.sin(pitch) * speed - sink;
}

export function gtaSpecialVehiclePose(state) {
    if (!state) return null;
    return {
        id: state.id,
        kind: state.kind,
        x: state.x,
        y: state.y,
        z: state.z,
        verticalSpeedMps: specialVehicleVerticalSpeedMps(state),
        heading: state.heading,
        headingDeg: gtaSceneYawToHeadingDeg(state.heading),
        pitch: state.pitch,
        roll: state.roll,
        speedMps: state.speedMps,
        speedKmh: Math.abs(state.speedMps) * 3.6,
        throttle: state.throttle,
        throttleLocked: !!state.throttleLocked,
        propellerAngle: state.propellerAngle,
        wakePhase: state.wakePhase,
        grounded: state.kind !== 'airplane' || state.grounded,
        airborne: state.kind === 'airplane' && !state.grounded,
        engineFailed: state.kind === 'airplane' && !!state.engineFailed,
        wrecked: !!state.wrecked,
        surface: state.surface || null,
        touchdown: state.touchdown ? { ...state.touchdown } : null,
        health: 100,
    };
}
