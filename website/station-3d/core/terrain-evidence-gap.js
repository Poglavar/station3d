// One definition of "this terrain sample will never arrive", shared by every
// layer that refuses to invent a height.
//
// A missing DTM sample means one of two things, and they need opposite
// handling. Terrain that is still streaming must reject the candidate — that
// rejection is what makes the next generation carry the evidence. Terrain the
// DGU model does not cover must not, because no number of retries will help:
// the grid stops at the natural coastline, so roads, kerbs and structures on
// harbour moles, piers and reclaimed quays sit over open water in the model
// however solid they are in life.
//
// Told apart wrongly, the second case rejects the shared ground generation on
// every pass. Because terrain, paving and the coast collar publish inside that
// one all-or-nothing candidate, Split kept a raw sea plane against raw paving
// with no shore between them until this distinction existed (2026-09-16).
//
// Two authorities can prove a gap permanent. The vector sea mask is the same
// polygon set the coast collar is cut from, so "inside the sea" here means
// exactly what it means to the water layer. The terrain mosaic is the other:
// once the core cell owning a point is loaded and no detail window is still
// pending there, its NoData is authoritative (core/terrain-grid.js says so in
// hasCoreCoverage), so a port apron the 20 m DTM never sampled stops
// rejecting the world's ground on every pass. Split, 2026-09-16 again: a kerb
// 11.5 m outside the sea polygon at local (-150.8, 705.5) held every layer's
// generation at revision 1. A later terrain revision that brings LiDAR into
// that window re-runs the layer and the kerb appears. Anything short of one
// authority saying yes leaves the gap retryable, which is the safe direction.

export const TERRAIN_EVIDENCE_GAP = 'terrain-evidence-gap';

// `ground` is any read snapshot carrying the water layer's mappedWater and/or
// a terrain read (either nested as `terrain` or the terrain read itself).
function terrainReadOf(ground) {
    const nested = ground?.terrain;
    return typeof nested?.evidenceSceneYAtLocal === 'function' ? nested : ground;
}

function terrainSaysAbsent(terrain, x, z) {
    return typeof terrain?.hasLoadedCoreCoverageAtLocal === 'function'
        && typeof terrain?.evidenceWithheldAtLocal === 'function'
        && typeof terrain?.evidenceSceneYAtLocal === 'function'
        && terrain.hasLoadedCoreCoverageAtLocal(x, z) === true
        && terrain.evidenceWithheldAtLocal(x, z) === false
        && terrain.evidenceSceneYAtLocal(x, z) === null;
}

export function isPermanentTerrainGap(ground, x, z) {
    if (ground?.mappedWater?.contains?.(x, z) === true) return true;
    return terrainSaysAbsent(terrainReadOf(ground), x, z);
}

// Bind the predicate to one generation's ground so call sites can pass a plain
// (x, z) test down into pure helpers that know nothing about read snapshots.
export function permanentTerrainGapTest(ground) {
    const terrain = terrainReadOf(ground);
    const hasTerrain = typeof terrain?.hasLoadedCoreCoverageAtLocal === 'function'
        && typeof terrain?.evidenceWithheldAtLocal === 'function'
        && typeof terrain?.evidenceSceneYAtLocal === 'function';
    if (!ground?.mappedWater?.contains && !hasTerrain) return null;
    return (x, z) => isPermanentTerrainGap(ground, x, z);
}
