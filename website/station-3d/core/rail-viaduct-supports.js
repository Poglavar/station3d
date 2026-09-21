// Resolves nominal viaduct supports around protected road/track envelopes;
// a blocked crossing gets the first clear support on both sides of the road.

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// DGU is bare-earth evidence and intentionally has NoData over the sea. A
// mapped-sea polygon is separate, positive evidence that a bridge support may
// continue below its rendered water surface. Unknown non-water terrain stays
// unknown; it must never be coerced to scene y=0.
export function resolveViaductPierFootingY({
    terrainY,
    mappedSea = false,
    seaSurfaceY,
    waterEmbedDepthM = 3,
} = {}) {
    const measuredTerrainY = finiteNumber(terrainY);
    if (measuredTerrainY !== null) return measuredTerrainY;
    const waterY = finiteNumber(seaSurfaceY);
    if (mappedSea !== true || waterY === null) return null;
    const embedM = Math.max(0.5, finiteNumber(waterEmbedDepthM) ?? 3);
    return waterY - embedM;
}

export function resolveViaductSupportCandidates({
    nominalStation,
    startStation,
    endStation,
    sampleAt,
    clearanceAt,
    stepM = 1,
    maxOffsetM = 24,
    endInsetM = 0.5,
} = {}) {
    if (typeof sampleAt !== 'function') return [];
    const nominal = sampleAt(nominalStation);
    if (!nominal || typeof clearanceAt !== 'function') return nominal ? [nominal] : [];
    if (clearanceAt(nominal) >= 0) return [nominal];
    const resolved = [];
    const found = new Set();
    const step = Math.max(0.25, Number(stepM) || 1);
    const limit = Math.max(step, Number(maxOffsetM) || 24);
    for (let offset = step; offset <= limit + 1e-6; offset += step) {
        for (const sign of [-1, 1]) {
            if (found.has(sign)) continue;
            const station = Number(nominalStation) + sign * offset;
            if (station <= Number(startStation) + endInsetM
                || station >= Number(endStation) - endInsetM) continue;
            const candidate = sampleAt(station);
            if (candidate && clearanceAt(candidate) >= 0) {
                resolved.push(candidate);
                found.add(sign);
            }
        }
        if (found.size === 2) break;
    }
    return resolved.sort((a, b) => a.station - b.station);
}
