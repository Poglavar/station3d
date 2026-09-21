// Pure progress clocks for authored campaign beats that depend on active
// movement. They advance from live pose samples, stop while paused or
// ineligible, and emit each timer exactly once per scene session.

const MAX_SAMPLE_STEP_MS = 1000;

export function createCampaignMotionTimerState() {
    return {
        previousNowMs: null,
        elapsedById: new Map(),
        firedIds: new Set(),
    };
}

function timerEligible(timer, snapshot, run) {
    if (!timer || !snapshot || snapshot.paused === true) return false;
    if (timer.unlessFlag && run?.flags?.[timer.unlessFlag]) return false;
    if (timer.requiresFlag && !run?.flags?.[timer.requiresFlag]) return false;
    if (timer.requiresController && snapshot.controllerId !== timer.requiresController) return false;
    if (timer.requiresVehicleId && snapshot.vehicleId !== timer.requiresVehicleId) return false;
    if (timer.requiresControlling === true && snapshot.occupantState !== 'controlling') return false;
    const minimumSpeed = Number(timer.minSpeedMps);
    if (Number.isFinite(minimumSpeed)
        && Math.abs(Number(snapshot.speedMps) || 0) < minimumSpeed) return false;
    return true;
}

export function advanceCampaignMotionTimers(state, timers, {
    nowMs,
    snapshot,
    run,
} = {}) {
    if (!state) return [];
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return [];
    const previous = state.previousNowMs == null
        ? null
        : Number(state.previousNowMs);
    state.previousNowMs = now;
    const deltaMs = Number.isFinite(previous)
        ? Math.max(0, Math.min(MAX_SAMPLE_STEP_MS, now - previous))
        : 0;
    const events = [];
    for (const timer of timers || []) {
        const id = String(timer?.id || '').trim();
        if (!id || state.firedIds.has(id)) continue;
        if (!timerEligible(timer, snapshot, run)) continue;
        const elapsedMs = (state.elapsedById.get(id) || 0) + deltaMs;
        state.elapsedById.set(id, elapsedMs);
        const durationMs = Math.max(0, Number(timer.durationMs) || 0);
        if (elapsedMs < durationMs) continue;
        state.firedIds.add(id);
        events.push({ type: 'timer:elapsed', timerId: id, elapsedMs });
    }
    return events;
}
