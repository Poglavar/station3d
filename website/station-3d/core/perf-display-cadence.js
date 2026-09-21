// Summarize a blank-page requestAnimationFrame probe so real-GPU timing runs
// cannot silently compare an active 120 Hz display with a sleeping 30 Hz one.

export const MIN_PERF_DISPLAY_HZ = 55;

function quantile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarizePerfDisplayCadence(intervals = [], {
    minHz = MIN_PERF_DISPLAY_HZ,
} = {}) {
    const values = (intervals || []).filter((value) => (
        typeof value === 'number' && Number.isFinite(value) && value > 0
    ));
    const medianIntervalMs = quantile(values, 0.5);
    const p95IntervalMs = quantile(values, 0.95);
    const medianHz = medianIntervalMs === null ? null : 1000 / medianIntervalMs;
    const requiredHz = Number.isFinite(minHz) && minHz > 0 ? minHz : MIN_PERF_DISPLAY_HZ;
    return {
        valid: medianHz !== null && medianHz >= requiredHz,
        samples: values.length,
        medianIntervalMs,
        p95IntervalMs,
        medianHz,
        minHz: requiredHz,
    };
}
