// The sea compositor and the terrain-relative inland-water renderer consume
// overlapping source families near a river mouth. Decide ownership per water
// polygon: the presence of sea anywhere in a 3 km fetch window says nothing
// about a river several hundred metres inland.

const MAX_EDGE_SAMPLES = 32;
const SEA_COVERAGE_THRESHOLD = 0.9;

export function mappedSeaCoversDecorWaterPolygon(
    outerRing,
    isSeaAtLocal,
    { maximumSamples = MAX_EDGE_SAMPLES, coverageThreshold = SEA_COVERAGE_THRESHOLD } = {},
) {
    if (!Array.isArray(outerRing) || outerRing.length < 3
        || typeof isSeaAtLocal !== 'function') return false;
    const sampleCount = Math.max(3, Math.min(
        outerRing.length,
        Math.floor(Number(maximumSamples) || MAX_EDGE_SAMPLES),
    ));
    let seaSamples = 0;
    let validSamples = 0;
    for (let sample = 0; sample < sampleCount; sample++) {
        const index = Math.floor(sample * outerRing.length / sampleCount);
        const point = outerRing[index];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
        validSamples += 1;
        if (isSeaAtLocal(point.x, point.z)) seaSamples += 1;
    }
    return validSamples >= 3 && seaSamples / validSamples >= coverageThreshold;
}
