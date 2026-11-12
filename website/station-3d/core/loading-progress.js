// Duration weights are an estimate for diagnostics and the existing campaign
// watchdog. They cannot predict the fraction of time left in a streamed build.
// The player-facing view below uses reported stage progress instead.

function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}

export function worldLoadFraction(components, weights, { fallbackWeight = 800 } = {}) {
    const list = Array.isArray(components) ? components : [];
    let total = 0;
    let finished = 0;
    let doneCount = 0;
    let activeKey = null;
    for (const component of list) {
        const weight = Number(weights?.[component?.key]);
        const share = Number.isFinite(weight) && weight > 0 ? weight : fallbackWeight;
        total += share;
        if (component?.done) {
            finished += share;
            doneCount += 1;
            continue;
        }
        if (activeKey === null && component?.active) activeKey = component.key;
        if (Number.isFinite(component?.progress)) finished += share * clamp01(component.progress);
    }
    return Object.freeze({
        fraction: total > 0 ? clamp01(finished / total) : 0,
        activeKey,
        doneCount,
        count: list.length,
    });
}

// There is no fixed denominator for the entire world: queues can discover more
// work. Keep concurrent tasks visible and never turn a completed byte counter
// into "100% loaded" while its stage still awaits publication.
export function worldLoadStages(components) {
    const list = Array.isArray(components) ? components : [];
    return {
        doneCount: list.filter(component => component?.done).length,
        finishing: list.length > 0 && list.every(component => component?.done),
        active: list.filter(component => component?.active && !component.done).map(component => ({
            key: component.key,
            fraction: Number.isFinite(component.progress) && component.progress >= 0 && component.progress < 1
                ? component.progress : null,
            finishing: Number.isFinite(component.progress) && component.progress >= 1,
        })),
    };
}

export function formatLoadElapsed(elapsedMs) {
    const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
