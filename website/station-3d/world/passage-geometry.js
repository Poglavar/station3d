// Pure helpers for courtyard-passage geometry: point-in-ring tests,
// line/polygon intersections, the flush wall-span computation, and the
// vertical bands that tie a passage to the building it is cut through. No
// three.js/DOM imports so the logic stays headlessly unit-testable.

// Tallest cut a courtyard-passage road OBB can make (and the arch height cap).
// Shared between the passage builder and the facade painter: openings must
// stay clear of the full potential cut, because the live cut height follows
// the minimum arch on the road and can GROW up to this when tiles evict.
export const PASSAGE_HEIGHT_M = 5.0;

// How far past the centre-line facade crossing a wall span may extend to
// meet an angled facade before we clamp it (stops walls from running down
// a building wing that happens to lie parallel to the road). Two tiers:
// a trusted outer footprint ring gives exact facade crossings, so a service
// road meeting the facade at a steep angle may legitimately skew the wall
// ends by metres; hull-fallback rings misplace crossings, so they stay on
// the tight clamp where every metre of allowance becomes a slab floating
// outside the real facade.
export const MAX_FACADE_SKEW_M = 1.2;
export const TRUSTED_RING_MAX_SKEW_M = 6.0;

// Wall spans are pulled this far back from the facade crossing on each end.
// A span ending exactly on the facade plane leaves the box side coplanar
// with (or, with any ring inaccuracy, poking through) the facade — visible
// as a thin vertical stripe on the wall. A few centimetres of recess reads
// as a normal door reveal and kills the z-fight.
export const WALL_END_INSET_M = 0.06;

// Stated-material meshes are finished authored geometry, not raw building
// masses for the generic courtyard-arch reconstruction. Treating one material
// bucket as a complete building mixes its lowest and highest disconnected
// surfaces: at Split Airport the silver-roof bucket began on the pedestrian
// bridge roof but also contained the terminal roof above it, so two service
// roads underneath spawned free-standing passage shells on top of the bridge.
// Material ownership is the data contract; the survey/source name deliberately
// stays irrelevant so this also protects authored meshes from future sources.
export function supportsGeneratedCourtyardPassages(feature) {
    const properties = feature?.properties;
    if (!properties) return false;
    return properties.material == null;
}

// Every height the passage builder derives from a building's face soup is
// LOCAL: the tile subtracts the surveyed z_min off, so a footprint's own base
// is y = 0 and its top is its height. buildings.js then lifts each mesh onto
// the DGU terrain by absoluteToSceneY(z_min), so in a terrain world the scene
// floor of that building is nowhere near 0 — at Divulje the anchor plane sits
// ~22 m above the ground, which is exactly how far the passage walls, lintels
// and shader cut volumes floated above the buildings they belong to.
//
// These two helpers are the whole conversion. Both collapse to today's
// behaviour when every base is 0 (the flat model world), so a location without
// terrain renders bit-for-bit as before.

// Number(null) is 0 and Number(undefined) is NaN, so a plain Number(x) +
// isFinite() pair silently turns a MISSING height into a real sea-level one.
// Both helpers below decide where geometry stands, so an absent input has to
// stay absent rather than become a plausible 0 m.
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Vertical band one road's shader cut volume must open, over every passage
// registered on that road. Each requirement carries the scene-Y floor of the
// building it was measured in plus its own arch height, because two buildings
// sharing a service road need not share a floor on sloped ground.
//
// The floor drops to the LOWEST base so the opening still reaches the ground
// in the building that sits deepest; the ceiling follows the LOWEST arch top,
// which preserves the rule this band has always enforced — a fixed 5 m cut
// through a low wing would slice its roof open, so the shortest arch on the
// road governs. Returns the fallback band when nothing is registered.
export function passageCutBand(requirements, fallbackHeightM = PASSAGE_HEIGHT_M) {
    let bottomY = Infinity;
    let topY = Infinity;
    for (const requirement of requirements || []) {
        const baseY = finiteNumber(requirement?.baseY);
        const archHeight = finiteNumber(requirement?.archHeight);
        if (baseY === null || archHeight === null) continue;
        if (baseY < bottomY) bottomY = baseY;
        if (baseY + archHeight < topY) topY = baseY + archHeight;
    }
    if (!Number.isFinite(bottomY)) return { bottomY: 0, topY: fallbackHeightM };
    // A deeper building's floor can sit below the shortest arch's own floor,
    // so the band is never empty: the shortest top is at least one arch
    // height above ITS base, which is at or above the lowest base.
    return { bottomY, topY: Math.max(topY, bottomY + 0.05) };
}

// Vertical overlap between a track cut volume (scene-Y) and one building
// (scene-Y floor plus a top measured from that floor). Returns null when the
// cut passes entirely above or below the building, so no face is exposed and
// no patch is owed. `minHeightM` rejects slivers the caller would not build.
export function trackCutPatchBand(
    buildingBaseSceneY,
    buildingTopLocalY,
    cutBaseSceneY,
    cutTopSceneY,
    minHeightM = 0,
) {
    const baseSceneY = finiteNumber(buildingBaseSceneY);
    const topLocalY = finiteNumber(buildingTopLocalY);
    const cutBaseY = finiteNumber(cutBaseSceneY);
    const cutTopY = finiteNumber(cutTopSceneY);
    if ([baseSceneY, topLocalY, cutBaseY, cutTopY].some((value) => value === null)) return null;
    const buildingTopSceneY = baseSceneY + topLocalY;
    if (cutTopY <= baseSceneY + 0.05 || cutBaseY >= buildingTopSceneY - 0.05) return null;
    const baseY = Math.max(baseSceneY, cutBaseY);
    const topY = Math.min(cutTopY, buildingTopSceneY);
    const height = topY - baseY;
    if (!(height >= minHeightM) || height <= 0) return null;
    return { baseY, topY, height };
}

export function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x, zi = ring[i].z;
        const xj = ring[j].x, zj = ring[j].z;
        const crosses = ((zi > z) !== (zj > z)) &&
            (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi);
        if (crosses) inside = !inside;
    }
    return inside;
}

export function linePolygonIntersections(origin, dirX, dirZ, ring) {
    const hits = [];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const denom = dirX * ez - dirZ * ex;
        if (Math.abs(denom) < 1e-6) continue;
        const apx = a.x - origin.x;
        const apz = a.z - origin.z;
        const t = (apx * ez - apz * ex) / denom;
        const u = (apx * dirZ - apz * dirX) / denom;
        if (u < -1e-6 || u > 1 + 1e-6) continue;
        let duplicate = false;
        for (const prev of hits) {
            if (Math.abs(prev - t) < 1e-4) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) hits.push(t);
    }
    return hits;
}

export function intersectLongitudinalIntervals(a, b) {
    const intersections = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const start = Math.max(a[i].start, b[j].start);
        const end = Math.min(a[i].end, b[j].end);
        if (end - start > 0.05) intersections.push({ start, end });
        if (a[i].end < b[j].end) i += 1;
        else j += 1;
    }
    return intersections;
}

// Pairs the two side walls' spans into ceiling slabs. When the facade meets
// the road at an angle the two walls legitimately start/end at DIFFERENT
// along-positions; the roof of such a passage is a parallelogram spanning
// each wall's own extent, not the rectangular overlap of the two (which
// would leave an open wedge at the facade). One slab per overlapping pair of
// wall spans; slabs whose walls never overlap (opposite wings of a split
// courtyard) are not emitted.
export function pairCeilingSpans(leftIntervals, rightIntervals) {
    const cores = intersectLongitudinalIntervals(leftIntervals, rightIntervals);
    const slabs = [];
    const used = new Set();
    for (const core of cores) {
        const mid = (core.start + core.end) * 0.5;
        const left = leftIntervals.find((i) => i.start <= mid && mid <= i.end);
        const right = rightIntervals.find((i) => i.start <= mid && mid <= i.end);
        if (!left || !right) continue;
        const key = `${left.start}:${left.end}|${right.start}:${right.end}`;
        if (used.has(key)) continue;
        used.add(key);
        slabs.push({
            leftStart: left.start,
            leftEnd: left.end,
            rightStart: right.start,
            rightEnd: right.end,
        });
    }
    return slabs;
}

// Along-axis span(s) of one passage side wall: where the wall's own centre
// line runs inside the building ring, so each wall starts and ends flush at
// the facade it crosses instead of overhanging past it. Also splits the wall
// where the line leaves the footprint (an open courtyard between two wings).
// `axis` carries the road's unit vectors {alongX, alongZ, rightX, rightZ};
// `origin` and the [minT, maxT] centre-line facade span come from the caller
// so all t values share one coordinate along the road axis.
export function passageWallIntervals(ring, origin, axis, rightOffset, minT, maxT, maxSkewM = MAX_FACADE_SKEW_M) {
    const lineOrigin = {
        x: origin.x + axis.rightX * rightOffset,
        z: origin.z + axis.rightZ * rightOffset,
    };
    const hits = linePolygonIntersections(lineOrigin, axis.alongX, axis.alongZ, ring)
        .sort((a, b) => a - b);
    const intervals = [];
    for (let i = 0; i < hits.length - 1; i++) {
        const start = hits[i];
        const end = hits[i + 1];
        if (end - start < 0.05) continue;
        const mid = (start + end) * 0.5;
        const x = lineOrigin.x + axis.alongX * mid;
        const z = lineOrigin.z + axis.alongZ * mid;
        if (!pointInRing(x, z, ring)) continue;
        // Keep only spans that belong to this passage; an offset line can
        // re-enter a distant wing of an L-shaped building.
        if (end < minT - 0.05 || start > maxT + 0.05) continue;
        const spanStart = Math.max(start, minT - maxSkewM) + WALL_END_INSET_M;
        const spanEnd = Math.min(end, maxT + maxSkewM) - WALL_END_INSET_M;
        if (spanEnd - spanStart < 0.15) continue;
        intervals.push({ start: spanStart, end: spanEnd });
    }
    // Wall line misses the footprint entirely (road wider than the wing it
    // clips) — fall back to the centre-line facade span.
    if (intervals.length === 0) {
        intervals.push({ start: minT + WALL_END_INSET_M, end: maxT - WALL_END_INSET_M });
    }
    return intervals;
}
