// Pure endpoint overlap for rail-viaduct deck geometry, keeping the structure
// buried under its adjoining formation without extending render-window slices.

function extrapolate(a, b, distanceM) {
    const spanM = Math.hypot(b.x - a.x, b.z - a.z);
    if (spanM <= 1e-6) return null;
    const scale = distanceM / spanM;
    return {
        station: a.station - (b.station - a.station) * scale,
        x: a.x - (b.x - a.x) * scale,
        z: a.z - (b.z - a.z) * scale,
        railY: a.railY - (b.railY - a.railY) * scale,
    };
}

export function extendViaductDeckSamples(samples, run, overlapM = 1.5) {
    const steps = extendViaductDeckSamplesSteps(samples, run, overlapM);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* extendViaductDeckSamplesSteps(samples, run, overlapM = 1.5, {
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    if (!isCurrent()) return null;
    if (!Array.isArray(samples) || samples.length < 2) return samples || [];
    const extended = [], runSamples = run?.samples || [];
    const overlap = Math.max(0, Number(overlapM) || 0);
    if (overlap > 0 && samples[0] === runSamples[0]) {
        const before = extrapolate(samples[0], samples[1], overlap);
        if (before) extended.push(before);
    }
    let started = now();
    for (const sample of samples) {
        if (now() - started >= .5) {
            yield { phase: 'viaduct-deck-samples' }; started = now();
            if (!isCurrent()) return null;
        }
        extended.push(sample);
    }
    const count = samples.length;
    if (overlap > 0 && samples[count - 1] === runSamples[runSamples.length - 1]) {
        const after = extrapolate(samples[count - 1], samples[count - 2], overlap);
        if (after) extended.push(after);
    }
    return isCurrent() ? extended : null;
}
