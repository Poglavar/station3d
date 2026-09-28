/**
 * Add cooperative CPU-only yields around a private immutable-read iterator.
 * This helper must never own publication, GPU work, or asynchronous waits.
 */
export function* prepareGroundPaintReadSteps(
    steps,
    isCurrent,
    { now = () => performance.now(), budgetMs = 0.5, maxSteps = 256, stats } = {},
) {
    if (!steps || typeof steps.next !== 'function') {
        throw new TypeError('steps must be an iterator');
    }
    if (typeof isCurrent !== 'function') {
        throw new TypeError('isCurrent must be a function');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new TypeError('budgetMs must be a finite non-negative number');
    }
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
        throw new TypeError('maxSteps must be a positive safe integer');
    }
    if (stats !== undefined && (!stats || typeof stats !== 'object')) {
        throw new TypeError('stats must be an object');
    }
    if (stats) {
        for (const key of ['slices', 'checks', 'operations', 'maxSliceMs']) {
            if (!Number.isFinite(stats[key]) || stats[key] < 0) {
                throw new TypeError(`stats.${key} must be a finite non-negative number`);
            }
        }
    }
    try {
        for (;;) {
            if (stats) stats.checks++;
            if (!isCurrent()) return null;
            const sliceStart = now();
            let count = 0;
            const operations = Object.create(null);
            const finishSlice = () => {
                const elapsed = Math.max(0, now() - sliceStart);
                if (stats) {
                    stats.slices++;
                    stats.operations += count;
                    stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
                }
                return { phase: 'paint-cpu', operations: { ...operations } };
            };
            for (;;) {
                const item = steps.next();
                if (item.done) {
                    // Even small subtasks yield, so chaining many regions cannot
                    // silently turn one bounded read into a whole-world visit.
                    if (count) {
                        yield finishSlice();
                        if (stats) stats.checks++;
                        if (!isCurrent()) return null;
                    }
                    return item.value;
                }
                if (!item.value || typeof item.value !== 'object') {
                    throw new TypeError('read preparation steps must yield operation records');
                }
                const { phase } = item.value;
                if (item.value.ready != null || item.value.deferFrame === true
                    || item.value.waitingForDependency === true) {
                    throw new TypeError('read preparation cannot yield readiness or wait records');
                }
                if (typeof phase !== 'string' || phase.length === 0) {
                    throw new TypeError('read preparation steps require a phase');
                }
                operations[phase] = (operations[phase] || 0) + 1;
                count++;
                // Read the clock after every operation, including an expensive
                // single polygon; the count cap also covers coarse clocks.
                if (now() - sliceStart >= budgetMs || count >= maxSteps) {
                    yield finishSlice();
                    break;
                }
            }
        }
    } finally {
        steps.return?.();
    }
}
