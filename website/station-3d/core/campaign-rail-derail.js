// Pure presentation curve for a scripted campaign derailment. The rail
// controller keeps advancing on its authoritative alignment while the rendered
// vehicle leaves the rails, rolls, and drops; the campaign director owns the
// delayed failure/retry overlay.

export const CAMPAIGN_RAIL_DERAIL_DURATION_MS = 2800;

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value) {
    const t = clamp(Number(value) || 0, 0, 1);
    return t * t * (3 - 2 * t);
}

export function campaignRailDerailFrame(elapsedMs, {
    durationMs = CAMPAIGN_RAIL_DERAIL_DURATION_MS,
    startDelayMs = 0,
    side = 1,
    forwardM = 0,
    lateralM = 4.6,
    dropM = 1.15,
    rollDeg = 76,
} = {}) {
    const duration = Math.max(1, Number(durationMs) || CAMPAIGN_RAIL_DERAIL_DURATION_MS);
    const delay = Math.max(0, Number(startDelayMs) || 0);
    const activeElapsedMs = Math.max(0, (Number(elapsedMs) || 0) - delay);
    const progress = clamp(activeElapsedMs / duration, 0, 1);
    const departure = smoothstep(progress);
    const fall = smoothstep((progress - 0.18) / 0.82);
    const direction = Number(side) < 0 ? -1 : 1;
    return Object.freeze({
        progress,
        forwardM: Math.max(0, Number(forwardM) || 0) * departure,
        lateralM: direction * Math.max(0, Number(lateralM) || 0) * departure,
        dropM: Math.max(0, Number(dropM) || 0) * fall,
        rollRad: direction * Math.max(0, Number(rollDeg) || 0) * Math.PI / 180 * departure,
        complete: progress >= 1,
    });
}
