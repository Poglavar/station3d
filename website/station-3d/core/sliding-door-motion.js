// Pure timing helpers for automatic pedestrian doors. Keeping the state
// machine independent of Three.js makes open/hold/close behavior testable.

export function holdSlidingDoorOpen(state, seconds) {
    state.holdSeconds = Math.max(
        Number(state.holdSeconds) || 0,
        Math.max(0, Number(seconds) || 0),
    );
    return state;
}

export function stepSlidingDoor(state, dt, {
    openRate = 3.2,
    closeRate = 2.4,
} = {}) {
    const seconds = Math.max(0, Number(dt) || 0);
    state.holdSeconds = Math.max(0, (Number(state.holdSeconds) || 0) - seconds);
    const target = state.holdSeconds > 0 ? 1 : 0;
    const ratio = Math.max(0, Math.min(1, Number(state.ratio) || 0));
    const rate = target > ratio ? openRate : closeRate;
    const delta = Math.max(0, Number(rate) || 0) * seconds;
    state.ratio = target > ratio
        ? Math.min(target, ratio + delta)
        : Math.max(target, ratio - delta);
    return state;
}
