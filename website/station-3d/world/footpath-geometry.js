// Pure geometry for OSM footpath ribbons: joining the raw segment soup into
// polyline chains, Chaikin-smoothing them, and computing mitered ribbon
// stations. No three.js/DOM imports so the logic stays headlessly testable.

// Two endpoints closer than this (metres, on a rounding grid) are the same
// node — OSM ways are split arbitrarily and float noise creeps in.
export const CHAIN_JOIN_EPS_M = 0.25;

// Miter length is capped so a hairpin doesn't shoot a spike; the junction
// disc covers whatever the capped miter leaves open.
export const MITER_LIMIT = 2.5;

function nodeKey(x, z) {
    const g = CHAIN_JOIN_EPS_M;
    return `${Math.round(x / g)}_${Math.round(z / g)}`;
}

// segments: [{x1, z1, x2, z2, width}] → chains:
//   { points: [{x, z}], widths: [w], startsAtJunction, endsAtJunction }
// A chain runs until it hits a node of degree ≠ 2 (dead end or junction) or
// closes a loop. Junction flags let the caller place cover discs only where
// several chains actually meet.
export function buildChainsFromSegments(segments) {
    const nodes = new Map();   // key → { x, z, ends: [{segIndex, end}] }
    const addEnd = (x, z, segIndex, end) => {
        const key = nodeKey(x, z);
        let node = nodes.get(key);
        if (!node) {
            node = { x, z, ends: [] };
            nodes.set(key, node);
        }
        node.ends.push({ segIndex, end });
        return node;
    };
    const segNodes = segments.map((s, i) => ({
        a: addEnd(s.x1, s.z1, i, 'a'),
        b: addEnd(s.x2, s.z2, i, 'b'),
    }));

    const used = new Array(segments.length).fill(false);
    const chains = [];
    const isThrough = (node) => node.ends.length === 2;

    const walk = (segIndex, fromNode) => {
        // Walk from a chain-terminal node through degree-2 nodes.
        const points = [{ x: fromNode.x, z: fromNode.z }];
        const widths = [];
        let node = fromNode;
        let seg = segIndex;
        while (seg != null && !used[seg]) {
            used[seg] = true;
            const s = segments[seg];
            widths.push(s.width);
            const other = segNodes[seg].a === node ? segNodes[seg].b : segNodes[seg].a;
            points.push({ x: other.x, z: other.z });
            node = other;
            if (!isThrough(node)) break;
            const next = node.ends.find((e) => !used[e.segIndex]);
            seg = next ? next.segIndex : null;
        }
        return { points, widths, endNode: node };
    };

    const emitFrom = (i, start) => {
        const chain = walk(i, start);
        if (chain.points.length < 2) return;
        // Per-point width: average of the adjacent segment widths.
        const pointWidths = chain.points.map((_, pi) => {
            const before = chain.widths[pi - 1];
            const after = chain.widths[pi];
            if (before == null) return after;
            if (after == null) return before;
            return (before + after) * 0.5;
        });
        chains.push({
            points: chain.points,
            widths: pointWidths,
            startsAtJunction: start.ends.length > 2,
            endsAtJunction: chain.endNode.ends.length > 2,
        });
    };
    // Seed chains at terminal nodes first, so every chain spans its full
    // dead-end/junction-to-junction run (a mid-chain seed would walk only one
    // direction and split the chain). Whatever remains is a pure loop and can
    // be seeded anywhere — the walk goes all the way around.
    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const { a, b } = segNodes[i];
        if (!isThrough(a)) emitFrom(i, a);
        else if (!isThrough(b)) emitFrom(i, b);
    }
    for (let i = 0; i < segments.length; i++) {
        if (!used[i]) emitFrom(i, segNodes[i].a);
    }
    return chains;
}

// One round of Chaikin corner cutting; endpoints stay fixed so chains still
// meet exactly at their shared junction nodes. `values` (e.g. widths) is
// subdivided with the same weights so it stays aligned with the points.
function chaikinOnce(points, values) {
    if (points.length < 3) return { points: points.slice(), values: values.slice() };
    const outP = [points[0]];
    const outV = [values[0]];
    for (let i = 0; i < points.length - 1; i++) {
        const p = points[i], q = points[i + 1];
        const vp = values[i], vq = values[i + 1];
        outP.push({ x: p.x * 0.75 + q.x * 0.25, z: p.z * 0.75 + q.z * 0.25 });
        outV.push(vp * 0.75 + vq * 0.25);
        outP.push({ x: p.x * 0.25 + q.x * 0.75, z: p.z * 0.25 + q.z * 0.75 });
        outV.push(vp * 0.25 + vq * 0.75);
    }
    outP.push(points[points.length - 1]);
    outV.push(values[values.length - 1]);
    return { points: outP, values: outV };
}

export function smoothChain(points, widths, iterations = 2) {
    let p = points, v = widths;
    for (let i = 0; i < iterations; i++) {
        const r = chaikinOnce(p, v);
        p = r.points;
        v = r.values;
    }
    return { points: p, widths: v };
}

// Add enough longitudinal stations that a terrain-draped ribbon cannot span
// several DGU cells as one chord. Width is interpolated with position so the
// later smoothing and miter stages keep the same cross-section semantics.
export function densifyChain(points, widths, maxSegmentM = 10) {
    if (!Array.isArray(points) || points.length < 2) {
        return { points: (points || []).slice(), widths: (widths || []).slice() };
    }
    const maxStep = Math.max(1, Number(maxSegmentM) || 10);
    const densePoints = [];
    const denseWidths = [];
    for (let index = 0; index < points.length - 1; index++) {
        const from = points[index];
        const to = points[index + 1];
        const fromWidth = Number(widths?.[index]) || 1.2;
        const toWidth = Number(widths?.[index + 1]) || fromWidth;
        const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / maxStep));
        for (let step = 0; step < steps; step++) {
            const t = step / steps;
            densePoints.push({
                x: from.x + (to.x - from.x) * t,
                z: from.z + (to.z - from.z) * t,
            });
            denseWidths.push(fromWidth + (toWidth - fromWidth) * t);
        }
    }
    densePoints.push({ ...points[points.length - 1] });
    denseWidths.push(Number(widths?.[widths.length - 1]) || denseWidths[denseWidths.length - 1] || 1.2);
    return { points: densePoints, widths: denseWidths };
}

// Ribbon stations: per smoothed point, the mitered lateral direction and the
// half-width to extrude. Consecutive stations connect into a continuous
// strip — no gaps and no overlaps at interior joints.
export function computeRibbonStations(points, widths) {
    const n = points.length;
    if (n < 2) return [];
    const dirs = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = points[i + 1].x - points[i].x;
        const dz = points[i + 1].z - points[i].z;
        const len = Math.hypot(dx, dz) || 1e-9;
        dirs.push({ x: dx / len, z: dz / len });
    }
    const stations = [];
    let arc = 0;
    for (let i = 0; i < n; i++) {
        const before = dirs[Math.max(0, i - 1)];
        const after = dirs[Math.min(dirs.length - 1, i)];
        if (i > 0) {
            arc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        }
        // Average direction at the joint; the miter scale keeps the ribbon
        // width constant through the bend (capped for hairpins).
        let mx = before.x + after.x;
        let mz = before.z + after.z;
        const mlen = Math.hypot(mx, mz);
        let scale = 1;
        if (mlen < 1e-6) {
            mx = after.x; mz = after.z;
        } else {
            mx /= mlen; mz /= mlen;
            const cosHalf = mx * after.x + mz * after.z;
            scale = Math.min(MITER_LIMIT, 1 / Math.max(0.05, Math.abs(cosHalf)));
        }
        // Lateral = normal of the miter direction.
        stations.push({
            x: points[i].x,
            z: points[i].z,
            nx: mz,
            nz: -mx,
            halfWidth: Math.max(0.35, (widths[i] || 1.2) * 0.5) * scale,
            arc,
        });
    }
    return stations;
}
