// Pure scheduling state for ambient ground-pedestrian destinations. Route
// planning itself stays in the world layer because it depends on live road,
// building and water registries; this module makes the retry/frame contract
// independently testable.

export const ROAD_TARGET_MAX_ATTEMPTS = 6;

export function createRoadTargetSearchState(maxAttempts = ROAD_TARGET_MAX_ATTEMPTS) {
    const attempts = Math.max(1, Math.round(Number(maxAttempts) || ROAD_TARGET_MAX_ATTEMPTS));
    return { attemptsRemaining: attempts };
}

export function advanceRoadTargetSearchState(search, attemptTarget) {
    if (!search || search.attemptsRemaining <= 0 || typeof attemptTarget !== 'function') {
        return { attempted: false, status: 'failed', value: null };
    }
    const value = attemptTarget(search);
    search.attemptsRemaining -= 1;
    if (value !== null && value !== undefined) {
        search.attemptsRemaining = 0;
        return { attempted: true, status: 'success', value };
    }
    return {
        attempted: true,
        status: search.attemptsRemaining > 0 ? 'pending' : 'failed',
        value: null,
    };
}

export function advanceOnePendingRoadTargetSearch(walkers, cursor, advanceWalker) {
    const count = Array.isArray(walkers) ? walkers.length : 0;
    if (count === 0 || typeof advanceWalker !== 'function') {
        return { attempts: 0, cursor: 0 };
    }
    const rawCursor = Math.trunc(Number(cursor) || 0);
    const start = ((rawCursor % count) + count) % count;
    for (let offset = 0; offset < count; offset++) {
        const index = (start + offset) % count;
        const walker = walkers[index];
        if (!walker?.roadTargetSearch || walker.roadTargetSearch.attemptsRemaining <= 0) continue;
        advanceWalker(walker);
        return { attempts: 1, cursor: (index + 1) % count };
    }
    return { attempts: 0, cursor: (start + 1) % count };
}
