// Pure pieces of the proposal-overlay terrain drape. The overlay's ground
// fabric (roads, strips, junctions, parks, squares, flowerbeds) used to be
// built FLAT on the session anchor plane — a flat-world-era assumption that
// put a coastal path 5–10 m in the air wherever the shore dropped below the
// walk's spawn elevation. The browser layer (world/proposals.js) now refines
// each polygon and samples terrain per vertex; the policy, the ring
// statistics and the wall geometry live here so they are provable under node.

// How fine to tessellate a draped polygon. The step comes from the terrain
// itself (TerrainReference.sampleStepMAtLocal) — NOT a constant: today's DGU
// DTM is 20 m, the detail windows are already 1 m, and finer sources are
// coming. Edges below the sample step only interpolate between the same
// samples (pure cost, no shape), so the step is the floor; the fallback
// covers references that predate the getter and flat test doubles.
export function drapeEdgeMForStep(stepM, fallbackM = 20) {
    const step = Number(stepM);
    if (Number.isFinite(step) && step > 0) return Math.max(1, step);
    return fallbackM;
}

// Resolve the finest rendered-terrain step touched by a flat triangulation.
// Sampling only the polygon centroid misses long strips and polygons crossing
// the moving fine/coarse boundary; sampling vertices alone misses a large seed
// triangle whose interior enters the fine window. Vertices plus triangle
// centroids keep the check linear in the already-built seed geometry and let
// the caller retain one bounded refinement budget for the complete polygon.
export function drapeEdgeMForTriangulation(
    points,
    triangles,
    sampleStepMAtLocal,
    fallbackM = 20,
) {
    let edgeM = drapeEdgeMForStep(null, fallbackM);
    if (typeof sampleStepMAtLocal !== 'function') return edgeM;
    const sample = (x, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        edgeM = Math.min(
            edgeM,
            drapeEdgeMForStep(sampleStepMAtLocal(x, z), fallbackM),
        );
    };
    for (const point of Array.isArray(points) ? points : []) {
        sample(Number(point?.x ?? point?.[0]), Number(point?.z ?? point?.[1]));
    }
    for (const triangle of Array.isArray(triangles) ? triangles : []) {
        if (!Array.isArray(triangle) || triangle.length < 3) continue;
        const a = points?.[triangle[0]];
        const b = points?.[triangle[1]];
        const c = points?.[triangle[2]];
        if (!a || !b || !c) continue;
        const ax = Number(a.x ?? a[0]);
        const az = Number(a.z ?? a[1]);
        const bx = Number(b.x ?? b[0]);
        const bz = Number(b.z ?? b[1]);
        const cx = Number(c.x ?? c[0]);
        const cz = Number(c.z ?? c[1]);
        sample((ax + bx + cx) / 3, (az + bz + cz) / 3);
    }
    return edgeM;
}

// Min/max sampled ground over a set of local points. Water surfaces stay
// LEVEL: the surface sits at min + its recess so it never floats above its
// own banks, and the bank collar rises to max so it always reaches the
// draped surroundings. Non-finite samples are SKIPPED, never coerced —
// Number(null) is 0, and 0 is sea level, which is exactly the wrong default
// for a pond in the karst. Returns null when nothing finite was sampled.
export function sampleGroundRange(points, groundAt) {
    if (!Array.isArray(points) || typeof groundAt !== 'function') return null;
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
        const x = Number(point && (point.x ?? point[0]));
        const z = Number(point && (point.z ?? point[1]));
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        // Absent BEFORE coercion: Number(null) is 0, 0 is finite, and the
        // skip below would never fire — the very trap this function guards.
        const raw = groundAt(x, z);
        if (raw === null || raw === undefined) continue;
        const y = Number(raw);
        if (!Number.isFinite(y)) continue;
        if (y < min) min = y;
        if (y > max) max = y;
    }
    return min <= max ? { min, max } : null;
}

/**
 * Vertical wall positions along a local-space ring, with the bottom and top
 * edges following the sampled ground (curbs between road strips, water-bank
 * collars). `bottomLift`/`topLift` are offsets ABOVE the ground sample at each
 * vertex — the old flat builder took absolute plane heights, which is the same
 * thing when groundAt is constant zero.
 *
 * Returns a flat triangle-list position array (two triangles per segment), or
 * null when the ring is degenerate.
 */
export function drapedRingWallPositions(localRing, groundAt, bottomLift, topLift) {
    if (!Array.isArray(localRing) || localRing.length < 3) return null;
    if (!(Number(topLift) > Number(bottomLift))) return null;
    const ground = typeof groundAt === 'function' ? groundAt : () => 0;
    const first = localRing[0];
    const last = localRing[localRing.length - 1];
    const closed = localRing.length > 1
        && Number(first.x ?? first[0]) === Number(last.x ?? last[0])
        && Number(first.z ?? first[1]) === Number(last.z ?? last[1]);
    const count = closed ? localRing.length - 1 : localRing.length;
    const positions = [];
    for (let index = 0; index < count; index++) {
        const next = (index + 1) % count;
        const a = localRing[index];
        const b = localRing[next];
        const ax = Number(a.x ?? a[0]);
        const az = Number(a.z ?? a[1]);
        const bx = Number(b.x ?? b[0]);
        const bz = Number(b.z ?? b[1]);
        if (![ax, az, bx, bz].every(Number.isFinite)) continue;
        // sceneYAtLocal is total (NoData already falls back inside the
        // reference), so a non-finite sample means a broken test double —
        // pin it to the plane EXPLICITLY rather than via `|| 0`, which would
        // also silently rewrite a legitimate -0/NaN mix.
        const aGroundRaw = Number(ground(ax, az));
        const bGroundRaw = Number(ground(bx, bz));
        const aGround = Number.isFinite(aGroundRaw) ? aGroundRaw : 0;
        const bGround = Number.isFinite(bGroundRaw) ? bGroundRaw : 0;
        const aBottom = aGround + bottomLift;
        const aTop = aGround + topLift;
        const bBottom = bGround + bottomLift;
        const bTop = bGround + topLift;
        positions.push(
            ax, aBottom, az, bx, bBottom, bz, bx, bTop, bz,
            ax, aBottom, az, bx, bTop, bz, ax, aTop, az,
        );
    }
    return positions.length > 0 ? positions : null;
}
