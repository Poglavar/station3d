// Pure follow-through for authored hair: the fall, locks or ponytail lag the
// walk bob and body turns through a damped spring per axis, so they swing
// while the actor moves and settle once the actor stops. No three.js and no
// per-step allocation; the person mesh applies the angles to its hair pivot.

const STIFFNESS = 70;     // rad/s² per rad of displacement
const DAMPING = 9;        // rad/s² per rad/s: under-damped, ζ ≈ 0.54, one visible overshoot
const MAX_STEP_S = 0.05;  // a hitch integrates one bounded step, never a wild one
const PITCH_AMP = 0.14;   // forward/back swing target driven by the stride bob (2× stride)
const ROLL_AMP = 0.08;    // side sway target driven by the weight shift (1× stride)
const TURN_FOLLOW = 0.55; // fraction of a heading change the hair is left behind by
export const HAIR_SWING_LIMIT_RAD = 0.6;

export function createHairSwingState() {
    return { pitch: 0, pitchVel: 0, roll: 0, rollVel: 0, yaw: 0, yawVel: 0, heading: null };
}

function wrapAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function bounded(value) {
    return Math.max(-HAIR_SWING_LIMIT_RAD, Math.min(HAIR_SWING_LIMIT_RAD, value));
}

function requireFinite(name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Hair swing ${name} must be a finite number, got ${value}.`);
    }
    return value;
}

/**
 * Advances `state` by `dt` seconds and returns the same object. `phase` is the
 * walk phase fed to animatePersonWalk, `walking` its 0..1 amount, `heading`
 * the body yaw in radians. Afterwards `pitch` (forward/back), `roll` (side)
 * and `yaw` (turn lag) are the hair pivot rotation in radians, each bounded
 * by HAIR_SWING_LIMIT_RAD.
 */
export function stepHairSwing(state, { phase, walking = 0, heading = 0, dt }) {
    requireFinite('phase', phase);
    requireFinite('heading', heading);
    requireFinite('dt', dt);
    const amount = Math.max(0, Math.min(1, requireFinite('walking', walking)));
    const step = Math.max(0, Math.min(MAX_STEP_S, dt));
    if (state.heading !== null) {
        // The hair stays where it was for a moment when the body turns under it.
        state.yaw = bounded(state.yaw - wrapAngle(heading - state.heading) * TURN_FOLLOW);
    }
    state.heading = heading;

    const pitchTarget = PITCH_AMP * amount * Math.sin(2 * phase);
    const rollTarget = ROLL_AMP * amount * Math.sin(phase);
    // Semi-implicit Euler on a damped spring per axis; stable for dt·√k < 2.
    state.pitchVel += (STIFFNESS * (pitchTarget - state.pitch) - DAMPING * state.pitchVel) * step;
    state.pitch = bounded(state.pitch + state.pitchVel * step);
    state.rollVel += (STIFFNESS * (rollTarget - state.roll) - DAMPING * state.rollVel) * step;
    state.roll = bounded(state.roll + state.rollVel * step);
    state.yawVel += (-STIFFNESS * state.yaw - DAMPING * state.yawVel) * step;
    state.yaw = bounded(state.yaw + state.yawVel * step);
    return state;
}

/** True once every axis is within `epsilon` of rest in both angle and rate. */
export function isHairSwingSettled(state, epsilon = 1e-3) {
    return Math.abs(state.pitch) < epsilon && Math.abs(state.pitchVel) < epsilon
        && Math.abs(state.roll) < epsilon && Math.abs(state.rollVel) < epsilon
        && Math.abs(state.yaw) < epsilon && Math.abs(state.yawVel) < epsilon;
}
