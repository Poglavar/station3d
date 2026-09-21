// Bake-time terrain carve for campaign world packs. The live terrain hides the
// ground under a rail formation or a road cut with a fragment discard driven by
// the ground-ownership mask; a pack copies raw triangles and loses that shader,
// so baked grass covered the sleepers on the Zagreb approach (2026-09-09
// audit). This removes those triangles from the captured geometry instead:
// triangles wholly inside the cut are dropped, triangles that straddle its
// edge are subdivided until the edge is resolved to `maxEdgeM`, and everything
// else is copied through. The predicate is the same CPU cutout query physics
// uses (core/formation-terrain-cutout-query.js), so the baked ground opens
// exactly where the live ground does. Pure, indexed-triangle in, indexed
// triangle out.

const DEFAULT_MAX_EDGE_M = 1.5;
const DEFAULT_MAX_DEPTH = 4;

function longestEdgeSq(positions, a, b, c) {
    const edge = (p, q) => {
        const dx = positions[p * 3] - positions[q * 3];
        const dz = positions[p * 3 + 2] - positions[q * 3 + 2];
        return dx * dx + dz * dz;
    };
    return Math.max(edge(a, b), edge(b, c), edge(c, a));
}

export function carveTerrainPrimitive(primitive, insideCut, {
    maxEdgeM = DEFAULT_MAX_EDGE_M,
    maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
    if (typeof insideCut !== 'function' || !primitive?.positions || !primitive?.indices) return primitive;
    const source = {
        positions: Array.from(primitive.positions),
        normals: primitive.normals ? Array.from(primitive.normals) : null,
        uvs: primitive.uvs ? Array.from(primitive.uvs) : null,
        colors: primitive.colors ? Array.from(primitive.colors) : null,
    };
    const out = { positions: [], normals: source.normals ? [] : null, uvs: source.uvs ? [] : null, colors: source.colors ? [] : null };
    const indices = [];
    const maxEdgeSq = maxEdgeM * maxEdgeM;
    const midpoints = new Map();
    let dropped = 0;
    let split = 0;

    const cutAt = (index) => insideCut(source.positions[index * 3], source.positions[index * 3 + 2]) === true;
    const midpoint = (p, q) => {
        const key = p < q ? `${p}:${q}` : `${q}:${p}`;
        const cached = midpoints.get(key);
        if (cached !== undefined) return cached;
        const index = source.positions.length / 3;
        for (let k = 0; k < 3; k++) source.positions.push((source.positions[p * 3 + k] + source.positions[q * 3 + k]) * 0.5);
        if (source.normals) {
            for (let k = 0; k < 3; k++) source.normals.push((source.normals[p * 3 + k] + source.normals[q * 3 + k]) * 0.5);
        }
        if (source.uvs) {
            for (let k = 0; k < 2; k++) source.uvs.push((source.uvs[p * 2 + k] + source.uvs[q * 2 + k]) * 0.5);
        }
        if (source.colors) {
            for (let k = 0; k < 3; k++) source.colors.push((source.colors[p * 3 + k] + source.colors[q * 3 + k]) * 0.5);
        }
        midpoints.set(key, index);
        return index;
    };
    const centroidCut = (a, b, c) => insideCut(
        (source.positions[a * 3] + source.positions[b * 3] + source.positions[c * 3]) / 3,
        (source.positions[a * 3 + 2] + source.positions[b * 3 + 2] + source.positions[c * 3 + 2]) / 3,
    ) === true;
    // Edge midpoints too: a corridor narrower than the triangle would slip
    // between its corners and centroid otherwise.
    const edgeCut = (p, q) => insideCut(
        (source.positions[p * 3] + source.positions[q * 3]) * 0.5,
        (source.positions[p * 3 + 2] + source.positions[q * 3 + 2]) * 0.5,
    ) === true;

    const emit = (a, b, c) => { indices.push(a, b, c); };
    const visit = (a, b, c, depth) => {
        const samples = [cutAt(a), cutAt(b), cutAt(c), edgeCut(a, b), edgeCut(b, c), edgeCut(c, a)];
        const inside = samples.filter(Boolean).length;
        const centre = centroidCut(a, b, c);
        if (inside === 0 && !centre) { emit(a, b, c); return; }
        if (inside === samples.length && centre) { dropped += 1; return; }
        if (depth >= maxDepth || longestEdgeSq(source.positions, a, b, c) <= maxEdgeSq) {
            // Resolved as far as asked: the centroid decides, like a texel.
            if (centre) dropped += 1;
            else emit(a, b, c);
            return;
        }
        split += 1;
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        visit(a, ab, ca, depth + 1);
        visit(ab, b, bc, depth + 1);
        visit(ca, bc, c, depth + 1);
        visit(ab, bc, ca, depth + 1);
    };
    for (let i = 0; i + 2 < primitive.indices.length; i += 3) {
        visit(primitive.indices[i], primitive.indices[i + 1], primitive.indices[i + 2], 0);
    }
    if (dropped === 0 && split === 0) return primitive;

    // Compact: only vertices still referenced survive.
    const remap = new Map();
    const compacted = [];
    for (const index of indices) {
        let next = remap.get(index);
        if (next === undefined) {
            next = remap.size;
            remap.set(index, next);
            for (let k = 0; k < 3; k++) out.positions.push(source.positions[index * 3 + k]);
            if (out.normals) for (let k = 0; k < 3; k++) out.normals.push(source.normals[index * 3 + k]);
            if (out.uvs) for (let k = 0; k < 2; k++) out.uvs.push(source.uvs[index * 2 + k]);
            if (out.colors) for (let k = 0; k < 3; k++) out.colors.push(source.colors[index * 3 + k]);
        }
        compacted.push(next);
    }
    return {
        ...primitive,
        positions: out.positions,
        ...(out.normals ? { normals: out.normals } : {}),
        ...(out.uvs ? { uvs: out.uvs } : {}),
        ...(out.colors ? { colors: out.colors } : {}),
        indices: compacted,
        carve: { dropped, split, triangles: compacted.length / 3 },
    };
}
