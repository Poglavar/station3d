// Measures how fast a vehicle is ACTUALLY travelling through the world, and
// notices when it has stopped moving while its engine still says otherwise.
//
// Physics speed and ground speed are not the same number. A car wedged against
// a building keeps reporting a large chassis velocity — 128 km/h was measured
// while its position did not change for 70 seconds — because the solver pushes
// it into the wall every step and the wall pushes back. Gating "stop to exit"
// on that number locked the player inside a vehicle that could neither move nor
// be left. Anything asking "is this vehicle moving?" wants the ground reading.

import { finiteOrNull } from './math.js';

export const GROUND_SPEED_WINDOW_MS = 400;
// Below this the vehicle is not travelling in any meaningful sense.
export const STUCK_GROUND_SPEED_MPS = 0.4;
// ...while the engine claims at least this much. A parked car reports zero on
// both, so idling in a lay-by can never be mistaken for being stuck.
export const STUCK_ENGINE_SPEED_MPS = 2;
export const STUCK_HOLD_SECONDS = 6;

// Ground speed when it is known, engine speed when it is not. The engine
// figure is the fallback rather than the authority: it is the one that lies.
export function vehicleExitSpeedMps(engineSpeedMps, groundSpeedMps) {
    const ground = finiteOrNull(groundSpeedMps);
    if (ground != null) return Math.abs(ground);
    return Math.abs(finiteOrNull(engineSpeedMps) ?? 0);
}

// A vehicle is stuck when the world says it is not moving, the engine says it
// is, and that disagreement has lasted long enough not to be a stall or a kerb.
export function isVehicleStuck({
    groundSpeedMps,
    engineSpeedMps,
    heldSeconds,
    holdSeconds = STUCK_HOLD_SECONDS,
} = {}) {
    const ground = finiteOrNull(groundSpeedMps);
    const engine = finiteOrNull(engineSpeedMps);
    const held = finiteOrNull(heldSeconds);
    if (ground == null || engine == null || held == null) return false;
    return ground <= STUCK_GROUND_SPEED_MPS
        && Math.abs(engine) >= STUCK_ENGINE_SPEED_MPS
        && held >= holdSeconds;
}

// Rolling-window tracker. Speed is net displacement across the window, so a
// vehicle jittering in place against a wall reads as stopped rather than fast.
export function createGroundMotionTracker({
    windowMs = GROUND_SPEED_WINDOW_MS,
    stuckGroundSpeedMps = STUCK_GROUND_SPEED_MPS,
    stuckEngineSpeedMps = STUCK_ENGINE_SPEED_MPS,
    maxObservationGapMs = windowMs * 2,
} = {}) {
    let samples = [];
    let stuckSeconds = 0;
    let lastMs = null;

    function reset() {
        samples = [];
        stuckSeconds = 0;
        lastMs = null;
    }

    function speedMps() {
        if (samples.length < 2) return null;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const spanS = (last.ms - first.ms) / 1000;
        // Half a window is the shortest baseline worth dividing by; below that
        // the reading is quantisation, not motion.
        if (spanS < windowMs / 2000) return null;
        return Math.hypot(last.x - first.x, last.z - first.z) / spanS;
    }

    function record({ x, z, nowMs, engineSpeedMps = null } = {}) {
        const ms = finiteOrNull(nowMs);
        const px = finiteOrNull(x);
        const pz = finiteOrNull(z);
        if (ms == null || px == null || pz == null) return;
        // A clock that went backwards means a new session, not a fast reverse.
        // A long gap is unobserved time too: a backgrounded tab or a streaming
        // hitch must not turn one stationary sample into six seconds of proof
        // that the vehicle is wedged. Start a fresh evidence window instead.
        if (lastMs != null
            && (ms < lastMs || ms - lastMs > maxObservationGapMs)) reset();
        const dt = lastMs == null ? 0 : (ms - lastMs) / 1000;
        lastMs = ms;
        samples.push({ ms, x: px, z: pz });
        while (samples.length > 2 && ms - samples[0].ms > windowMs) samples.shift();

        const ground = speedMps();
        const engine = finiteOrNull(engineSpeedMps);
        const disagreeing = ground != null
            && engine != null
            && ground <= stuckGroundSpeedMps
            && Math.abs(engine) >= stuckEngineSpeedMps;
        stuckSeconds = disagreeing ? stuckSeconds + dt : 0;
    }

    return {
        record,
        reset,
        speedMps,
        stuckSeconds: () => stuckSeconds,
    };
}
