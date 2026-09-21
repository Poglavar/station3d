// Priority bands for detailed-building construction. View-relative scores are
// useful within a class, but they must not let speculative corridor work starve
// the four tiles that gate the initial reveal.

const VIEW_SCORE_LIMIT = 1e13;
const INITIAL_NEAR_BAND = 1e14;
const IN_PROGRESS_BAND = 1e15;

function boundedViewScore(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return 0;
    return Math.max(-VIEW_SCORE_LIMIT, Math.min(VIEW_SCORE_LIMIT, value));
}

export function buildingTileBuildPriority(viewScore, {
    initialNear = false,
    inProgress = false,
} = {}) {
    return boundedViewScore(viewScore)
        + (initialNear ? INITIAL_NEAR_BAND : 0)
        + (inProgress ? IN_PROGRESS_BAND : 0);
}
