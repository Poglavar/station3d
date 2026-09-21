// Where an engineered formation is genuinely DUG IN, as distinct from merely
// owning the ground it runs across.
//
// Bare earth and a second civil work need different answers. Supplied terrain
// remains beneath fill and disappears only where depth proves excavation. A
// road and its dressing may sit across a rail formation quite legitimately
// (that is a level crossing), and must not be deleted; what it may never do is
// roof a deep open cut, which is exactly what the car park over the Stankovačka
// ulica station bay was doing.
//
// So the discriminating fact is DEPTH, not ownership alone. These helpers turn
// a formation's per-sample cut depth into closed rings covering only the
// excavated stretches. A shallow threshold controls bare-earth removal; the
// conservative deep threshold controls removal of other civil surfaces.
//
// Pure: arrays of {x, z} in local metres and plain numbers, no THREE, no DOM.

// A road can only cross a rail line at grade where the cut is shallow, so a
// stretch this deep can never legitimately carry a crossing surface over it.
// The threshold is deliberately biased HIGH: too low would punch a hole through
// a road at a level crossing (very visible, and a regression), while too high
// merely leaves a shallow cut roofed exactly as it is today.
export const OPEN_CUT_LID_MIN_DEPTH_M = 1.5;

// Bare earth must stop covering a designed rail top as soon as the difference
// exceeds the trackbed's small physical/render offset. This is intentionally
// much shallower than OPEN_CUT_LID_MIN_DEPTH_M: the latter decides when some
// OTHER civil surface is certainly an impossible roof over a trench, while
// this value only decides whether the terrain itself was excavated.
export const TERRAIN_EXCAVATION_MIN_DEPTH_M = 0.08;

// Natural ground minus designed formation top, per sample. A missing terrain
// sample is NOT zero depth dressed up as a measurement — it is unknown, and
// unknown ground can never establish that something was excavated.
//
// Tested with `typeof`, never `Number(x)`: `Number(null)` is 0, which would
// turn "nobody measured the ground here" into "the ground is exactly at the
// designed top" — a real-looking reading that reads as at-grade and would leave
// an unmeasured cut roofed.
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formationCutDepths(samples, baseYAtLocal) {
    if (!Array.isArray(samples) || typeof baseYAtLocal !== 'function') return [];
    return samples.map((sample) => {
        const designY = finiteNumber(sample?.railY ?? sample?.roadY);
        if (designY === null) return null;
        // A caller that already sampled the complete cross-section may attach
        // its conservative ground evidence to the station. Rail supplies its
        // centre terrain sample; roads use the highest of centre and both
        // carriageway edges so an uphill flank is still recognised as cut.
        const suppliedGroundY = finiteNumber(sample?.terrainY);
        const groundY = suppliedGroundY === null
            ? finiteNumber(baseYAtLocal(sample.x, sample.z))
            : suppliedGroundY;
        if (groundY === null) return null;
        return groundY - designY;
    });
}

// Maximal runs of consecutive samples whose cut depth clears the threshold,
// as inclusive [start, end] index pairs. A single-sample run is dropped: it
// cannot make a polygon, and one deep sample between two shallow ones is
// terrain noise rather than a trench.
export function excavationRuns(depthsM, { minDepthM = OPEN_CUT_LID_MIN_DEPTH_M } = {}) {
    const runs = [];
    let start = -1;
    const deep = (value) => Number.isFinite(value) && value >= minDepthM;
    for (let index = 0; index <= (depthsM?.length || 0); index++) {
        if (index < depthsM.length && deep(depthsM[index])) {
            if (start < 0) start = index;
            continue;
        }
        if (start >= 0 && index - 1 > start) runs.push([start, index - 1]);
        start = -1;
    }
    return runs;
}

// One closed ring per run, from the formation's own paired boundary points:
// down the left edge and back up the right. `left[k]` and `right[k]` are the
// two edges of the same cross-section, which is what makes the pairing exact —
// deriving it later from a densified ring would have to re-project every vertex
// back onto the alignment and guess which side it came from.
export function excavationRings(left, right, runs) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [];
    const rings = [];
    for (const [start, end] of runs || []) {
        if (!(end > start) || end >= left.length || end >= right.length) continue;
        const ring = [];
        for (let k = start; k <= end; k++) ring.push({ x: left[k].x, z: left[k].z });
        for (let k = end; k >= start; k--) ring.push({ x: right[k].x, z: right[k].z });
        if (ring.length >= 4) rings.push(ring);
    }
    return rings;
}

export function ringBoundsXZ(ring) {
    if (!Array.isArray(ring) || ring.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of ring) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.z < minZ) minZ = point.z;
        if (point.z > maxZ) maxZ = point.z;
    }
    return { minX, maxX, minZ, maxZ };
}

// The whole job in one call, for a formation run that already has its paired
// boundary edges: rings (with bounds) over the stretches deep enough that
// nothing but the formation itself belongs above them.
export function buildFormationExcavationRegions({
    samples,
    left,
    right,
    baseYAtLocal,
    minDepthM = OPEN_CUT_LID_MIN_DEPTH_M,
} = {}) {
    const depths = formationCutDepths(samples, baseYAtLocal);
    const runs = excavationRuns(depths, { minDepthM });
    return excavationRings(left, right, runs)
        .map((ring) => ({ ring, bounds: ringBoundsXZ(ring) }));
}
