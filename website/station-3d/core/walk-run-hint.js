// When to remind a walking player that they can run. Counts only time spent
// actually moving on foot without the boost; a player who has run for a few
// seconds has learned the control and is never nagged again.

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

export const RUN_HINT_FIRST_AFTER_S = 6;
export const RUN_HINT_EVERY_S = 30;
export const RUN_HINT_LEARNED_AFTER_S = 4;

export function createRunHintState() {
    return { walkedS: 0, boostedS: 0, shown: 0, learned: false };
}

// Returns true on the step the hint should be shown.
export function advanceRunHint(state, { dt = 0, moving = false, boosted = false } = {}) {
    if (!state || state.learned) return false;
    const step = isFiniteNumber(dt) && dt > 0 ? dt : 0;
    if (!moving) return false;
    if (boosted) {
        state.boostedS += step;
        if (state.boostedS >= RUN_HINT_LEARNED_AFTER_S) state.learned = true;
        return false;
    }
    state.walkedS += step;
    const threshold = state.shown === 0 ? RUN_HINT_FIRST_AFTER_S : RUN_HINT_EVERY_S;
    if (state.walkedS < threshold) return false;
    state.walkedS = 0;
    state.shown += 1;
    return true;
}
