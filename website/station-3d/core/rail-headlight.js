// Computes the driven heavy-rail headlight pose without Three.js so placement
// and daylight gating remain cheap to unit-test outside the browser.

export const RAIL_HEADLIGHT_DEFAULT_HALF_LENGTH_M = 35;
export const RAIL_HEADLIGHT_NOSE_OVERHANG_M = 0.5;
export const RAIL_HEADLIGHT_HEIGHT_M = 1.15;
export const RAIL_HEADLIGHT_AIM_AHEAD_M = 90;
export const RAIL_HEADLIGHT_AIM_DROP_M = 2.2;

export function resolveRailHeadlightFrame({
    x,
    railY,
    z,
    forwardX,
    forwardZ,
    halfLengthM = RAIL_HEADLIGHT_DEFAULT_HALF_LENGTH_M,
    on = false,
} = {}) {
    if (!on || ![x, railY, z, forwardX, forwardZ].every(Number.isFinite)) return null;
    const forwardLength = Math.hypot(forwardX, forwardZ);
    if (forwardLength < 1e-6) return null;
    const fx = forwardX / forwardLength;
    const fz = forwardZ / forwardLength;
    const safeHalfLengthM = Number.isFinite(halfLengthM)
        ? Math.max(0, halfLengthM)
        : RAIL_HEADLIGHT_DEFAULT_HALF_LENGTH_M;
    const noseDistanceM = safeHalfLengthM + RAIL_HEADLIGHT_NOSE_OVERHANG_M;
    const position = {
        x: x + fx * noseDistanceM,
        y: railY + RAIL_HEADLIGHT_HEIGHT_M,
        z: z + fz * noseDistanceM,
    };
    return {
        position,
        target: {
            x: position.x + fx * RAIL_HEADLIGHT_AIM_AHEAD_M,
            y: position.y - RAIL_HEADLIGHT_AIM_DROP_M,
            z: position.z + fz * RAIL_HEADLIGHT_AIM_AHEAD_M,
        },
    };
}
