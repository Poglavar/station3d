// These are engine work/storage bounds, independent of camera and display.
// Capacity exhaustion rejects the complete candidate; it never truncates a
// route or publishes an opening without the rest of its civil geometry.
export const PLANNER_GEOMETRY_LIMITS = Object.freeze({
    maxSegments: 4096, maxStops: 1024, maxRouteMeters: 250000,
    maxBoxes: 65536, maxMarkers: 8192, maxWalkIndexEntries: 1048576,
    maxInputSegments: 262144, maxFeatures: 4096, maxCoordinates: 262144,
    maxCuts: 8192, maxStopSegmentVisits: 4194304, maxWalkCellCandidates: 4096,
});

export function createPlannerGeometryBudget({ limits = PLANNER_GEOMETRY_LIMITS,
    now = () => performance.now(), isCurrent = () => true } = {}) {
    if (typeof now !== 'function' || typeof isCurrent !== 'function'
        || !Object.keys(PLANNER_GEOMETRY_LIMITS).every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)) {
        throw new TypeError('Planner geometry requires finite work and storage limits');
    }
    let deadline = now() + .5, visits = 0;
    const capacity = Object.freeze(Object.fromEntries(Object.keys(PLANNER_GEOMETRY_LIMITS).map(key => [key, limits[key]])));
    const counts = Object.create(null);
    function check() {
        if (!isCurrent()) throw Object.assign(new Error('Planner geometry inputs were superseded'), { code: 'ground-generation-stale' });
    }
    return Object.freeze({
        check, limits: capacity,
        take(key, count = 1) {
            if (!Object.hasOwn(capacity, key) || !Number.isFinite(count) || count < 0) throw new TypeError('Invalid planner work reservation');
            const next = (counts[key] || 0) + count;
            if (next > capacity[key]) throw Object.assign(new Error(`Planner geometry exceeds ${key}`), { code: 'ground-generation-capacity' });
            counts[key] = next;
        },
        *step(phase) {
            check();
            if (++visits >= 128 || now() >= deadline) {
                yield { phase }; check(); visits = 0; deadline = now() + .5;
            }
        },
    });
}
