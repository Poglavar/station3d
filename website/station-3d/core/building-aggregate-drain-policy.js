// Pure motion-aware limits for merged-building assembly and subsequent GPU uploads.

const STATIONARY_POLICY = Object.freeze({
    frameBudgetMs: 3,
    maxUploads: 1,
});

const MOVING_POLICY = Object.freeze({
    frameBudgetMs: 2,
    maxUploads: 1,
});

export function buildingAggregateDrainPolicy(motionState) {
    return motionState === 'stationary' ? STATIONARY_POLICY : MOVING_POLICY;
}
