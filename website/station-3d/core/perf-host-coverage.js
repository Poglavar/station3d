// Decide whether a performance capture had enough clean host windows to be
// useful without pretending that an occasional in-browser probe spike erases
// the other 98% of a run. Metrics still retain every captured frame.

export const MIN_CLEAN_HOST_WINDOW_FRACTION = 0.9;

export function assessPerfHostCoverage(samples = [], {
    minCleanFraction = MIN_CLEAN_HOST_WINDOW_FRACTION,
} = {}) {
    const required = Number.isFinite(minCleanFraction)
        ? Math.min(1, Math.max(0, minCleanFraction))
        : MIN_CLEAN_HOST_WINDOW_FRACTION;
    const known = (samples || []).filter((sample) => (
        sample?.host?.level && sample.host.level !== 'unknown'
    ));
    const busy = known.filter((sample) => (
        sample.host?.contended === true || sample.host?.level !== 'clean'
    ));
    const clean = known.length - busy.length;
    const cleanFraction = known.length > 0 ? clean / known.length : null;
    return {
        valid: cleanFraction !== null && cleanFraction + Number.EPSILON >= required,
        knownHostSamples: known.length,
        cleanHostSamples: clean,
        busyHostSamples: busy.length,
        cleanFraction,
        minCleanFraction: required,
    };
}
