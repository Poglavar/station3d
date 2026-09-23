// Lawson edge flipping: turns any valid planar triangulation into the
// constrained Delaunay triangulation of the same points and boundary. Points
// never move and are never added, and edges used by one triangle (the polygon
// boundary) are never flipped. Earcut spans long road polygons with needle fans,
// and midpoint refinement preserves shape, so every needle became a fan of
// slivers: 41 % of rendered road triangles in the dense Zagreb walk view were
// under 0.05 m² (2026-09-23). Flipping first makes refinement split well-shaped
// triangles instead.

function orient(a, b, c) {
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

// > 0 when d is strictly inside the circumcircle of a, b, c (any winding), scaled
// so the tolerance is relative to the local size of the quad.
function inCircle(a, b, c, d) {
    const adx = a.x - d.x, adz = a.z - d.z;
    const bdx = b.x - d.x, bdz = b.z - d.z;
    const cdx = c.x - d.x, cdz = c.z - d.z;
    const ad = adx * adx + adz * adz, bd = bdx * bdx + bdz * bdz, cd = cdx * cdx + cdz * cdz;
    const det = adx * (bdz * cd - bd * cdz) - adz * (bdx * cd - bd * cdx) + ad * (bdx * cdz - bdz * cdx);
    return Math.sign(orient(a, b, c)) * det;
}

// Flips `triangles` (arrays of three point indices) in place and yields every
// `flipsPerYield` flips for cooperative callers. Returns the number of flips.
export function* delaunayFlipSteps(points, triangles, { flipsPerYield = 256 } = {}) {
    const n = points.length;
    const edgeKey = (i, j) => (i < j ? i * n + j : j * n + i);
    const edgeTriangles = new Map(); // edge → [triangle index, triangle index?]
    const link = (key, t) => {
        const list = edgeTriangles.get(key);
        if (list) list.push(t); else edgeTriangles.set(key, [t]);
    };
    const unlink = (key, t) => {
        const list = edgeTriangles.get(key);
        if (!list) return;
        const at = list.indexOf(t);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) edgeTriangles.delete(key);
    };
    triangles.forEach(([a, b, c], t) => { link(edgeKey(a, b), t); link(edgeKey(b, c), t); link(edgeKey(c, a), t); });

    const pending = [...edgeTriangles.keys()];
    const queued = new Set(pending);
    // Lawson flipping terminates; the cap only guards against a malformed input.
    const maxFlips = Math.max(64, triangles.length * 32);
    let flips = 0;
    while (pending.length && flips < maxFlips) {
        const key = pending.pop();
        queued.delete(key);
        const shared = edgeTriangles.get(key);
        if (!shared || shared.length !== 2) continue;
        const [t1, t2] = shared;
        const i = Math.floor(key / n), j = key % n;
        const c = triangles[t1].find(v => v !== i && v !== j);
        const d = triangles[t2].find(v => v !== i && v !== j);
        if (c === undefined || d === undefined || c === d) continue;
        const pi = points[i], pj = points[j], pc = points[c], pd = points[d];
        const scale = Math.max(Math.abs(pi.x - pj.x), Math.abs(pi.z - pj.z), Math.abs(pc.x - pd.x), Math.abs(pc.z - pd.z)) || 1;
        // Tolerance for doubled triangle areas: road rings arrive as Float32, so
        // near-collinear points carry millimetre noise at kilometre offsets.
        const tolerance = 1e-6 * scale * scale;
        const oc = orient(pi, pj, pc), od = orient(pi, pj, pd);
        // Both on one side of i–j means the input already folds here; leave it.
        if (oc * od > 0) continue;
        // A (near-)collinear triangle has an unbounded circumcircle: always flip it when convex.
        const degenerate = Math.abs(oc) <= tolerance || Math.abs(od) <= tolerance;
        if (!degenerate && !(inCircle(pi, pj, pc, pd) > 1e-9 * scale ** 4)) continue;
        // The new diagonal c–d must separate i and j clearly, both new triangles must
        // be non-degenerate, and together they must cover exactly the old pair: a
        // flip across a non-convex quad would overlap and cover more.
        const si = orient(pc, pd, pi), sj = orient(pc, pd, pj);
        if (!(si * sj < 0) || Math.abs(si) <= tolerance || Math.abs(sj) <= tolerance) continue;
        if (Math.abs((Math.abs(si) + Math.abs(sj)) - (Math.abs(oc) + Math.abs(od))) > tolerance) continue;
        // The winding of the non-degenerate triangle of the pair is the mesh's.
        const windingOf = t => Math.sign(orient(points[triangles[t][0]], points[triangles[t][1]], points[triangles[t][2]]));
        const winding = windingOf(t1) || windingOf(t2) || 1;
        const oriented = (a, b, e) => (Math.sign(orient(points[a], points[b], points[e])) === winding ? [a, b, e] : [a, e, b]);
        for (const t of [t1, t2]) {
            const [a, b, e] = triangles[t];
            unlink(edgeKey(a, b), t); unlink(edgeKey(b, e), t); unlink(edgeKey(e, a), t);
        }
        triangles[t1] = oriented(c, d, i);
        triangles[t2] = oriented(c, d, j);
        for (const t of [t1, t2]) {
            const [a, b, e] = triangles[t];
            link(edgeKey(a, b), t); link(edgeKey(b, e), t); link(edgeKey(e, a), t);
        }
        for (const next of [edgeKey(c, i), edgeKey(i, d), edgeKey(d, j), edgeKey(j, c)]) {
            if (!queued.has(next)) { queued.add(next); pending.push(next); }
        }
        flips += 1;
        if (flips % flipsPerYield === 0) yield { phase: 'surface-delaunay-flip', flips };
    }
    return flips;
}

export function delaunayFlip(points, triangles, options) {
    const steps = delaunayFlipSteps(points, triangles, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}
