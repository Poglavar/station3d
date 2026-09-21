// Boundaries of the receiver's own indexed topology. Float32 storage can fold
// a thin refined face without changing its connectivity. Keep that connectivity
// and reject folds beyond the shared 1 mm geometry precision contract.
import { createBoundsGridSteps } from './bounds-grid.js';
import { pointInRingNonZero } from './mask-query.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'receiver-footprint-topology' }); };

export function* createReceiverFootprintSteps({ positions, indices = null, topologyVertexIds = null, maxTriangles,
    now = () => performance.now(), isCurrent = () => true } = {}) {
    if (!ArrayBuffer.isView(positions) || positions.length % 3
        || (indices !== null && (!ArrayBuffer.isView(indices) || indices.length % 3))
        || !Number.isSafeInteger(maxTriangles) || maxTriangles < 1) {
        throw new TypeError('Receiver boundaries require triangle buffers and an explicit capacity');
    }
    if (topologyVertexIds !== null && (!(topologyVertexIds instanceof Uint32Array)
        || topologyVertexIds.length !== positions.length / 3)) throw new TypeError('Invalid receiver topology vertex table');
    const count = indices?.length ?? positions.length / 3;
    if (count % 3 || count / 3 > maxTriangles) {
        throw Object.assign(new Error('Receiver footprint capacity exceeded'), { code: 'ground-generation-capacity' });
    }
    const vertices = new Map(), heights = new Map(), edges = new Map(), faces = [];
    let deadline = now() + .5, triangleArea = 0, maxHeightDifferenceM = 0;
    const check = function* () {
        if (!isCurrent()) throw Object.assign(new Error('Receiver footprint superseded'), { code: 'ground-generation-stale' });
        if (now() >= deadline) { yield { phase: 'receiver-footprint' }; deadline = now() + .5; }
    };
    function vertex(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index * 3 >= positions.length) fail('Invalid receiver vertex');
        if (topologyVertexIds) {
            const mapped = topologyVertexIds[index];
            if (mapped * 3 >= positions.length || [0, 1, 2].some(i => positions[mapped * 3 + i] !== positions[index * 3 + i])) {
                fail('Receiver connectivity joins different geometric positions');
            }
            index = mapped;
        }
        const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2];
        if (![x, y, z].every(finite)) fail('Receiver boundary lacks a finite coordinate');
        const xz = `${x},${z}`, previousHeight = heights.get(xz);
        if (previousHeight !== undefined) {
            maxHeightDifferenceM = Math.max(maxHeightDifferenceM, Math.abs(previousHeight-y));
            if (maxHeightDifferenceM > .001) fail('A heightfield receiver has two heights at one coordinate');
        } else heights.set(xz, y);
        // Indexed vertices encode connectivity even when Float32 rounds two
        // adjacent refined points to the same XZ. Welding those would invent
        // branches. Nonindexed faces can only share exactly identical vertices.
        const key = indices ? index : `${xz},${y}`;
        let value = vertices.get(key);
        if (!value) { value = { x, y, z, id: vertices.size }; vertices.set(key, value); }
        return value;
    }
    function edge(a, b) {
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        const old = edges.get(key);
        if (!old) edges.set(key, { a, b, count: 1 });
        else {
            if (old.count !== 1 || old.a !== b || old.b !== a) fail('Receiver triangles do not form a consistently joined surface');
            old.count++;
        }
    }
    for (let offset = 0; offset < count; offset += 3) {
        yield* check();
        const [a, b, c] = [0, 1, 2].map(i => vertex(indices ? indices[offset + i] : offset + i));
        // A zero-length source edge can connect separate shading vertices.
        // Its geometric connector disappears after those identities join.
        if (topologyVertexIds && (a === b || b === c || c === a)) continue;
        const area = (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
        if (!finite(area)) fail('Receiver footprint contains a nonfinite face');
        triangleArea += area * .5;
        faces.push({ area, longestEdge: Math.max(Math.hypot(b.x-a.x,b.z-a.z),
            Math.hypot(c.x-b.x,c.z-b.z),Math.hypot(a.x-c.x,a.z-c.z)) });
        edge(a, b); edge(b, c); edge(c, a);
    }
    const winding = Math.sign(triangleArea);
    let maxFoldWidthM = 0, collapsedFaces = 0;
    for (const { area, longestEdge } of faces) {
        yield* check();
        if (area === 0) { collapsedFaces++; continue; }
        if (Math.sign(area) === winding) continue;
        maxFoldWidthM = Math.max(maxFoldWidthM, Math.abs(area) / longestEdge);
        if (maxFoldWidthM > .001) fail('Receiver face folds beyond the 1 mm storage tolerance');
    }
    const outgoing = new Map(), boundary = new Set();
    for (const value of edges.values()) {
        yield* check();
        if (value.count !== 1) continue;
        if (outgoing.has(value.a)) fail('Receiver boundary branches at a shared vertex');
        outgoing.set(value.a, value); boundary.add(value);
    }
    const outer = [], holes = [];
    let boundaryArea = 0, boundaryVertices = 0;
    while (boundary.size) {
        const start = boundary.values().next().value;
        const ring = [], bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
        let current = start, area = 0;
        do {
            yield* check();
            if (!current || !boundary.delete(current)) fail('Receiver boundary is open or repeats an edge');
            const { a, b } = current;
            ring.push(Object.freeze({ x: a.x, z: a.z }));
            bounds.minX = Math.min(bounds.minX, a.x); bounds.maxX = Math.max(bounds.maxX, a.x);
            bounds.minZ = Math.min(bounds.minZ, a.z); bounds.maxZ = Math.max(bounds.maxZ, a.z);
            // Translate for stable area at large session coordinates.
            area += (a.x-start.a.x)*(b.z-start.a.z)-(b.x-start.a.x)*(a.z-start.a.z);
            current = outgoing.get(b);
        } while (current !== start);
        if (ring.length < 3 || !finite(area)) fail('Receiver boundary has no finite area');
        area *= .5; boundaryArea += area; boundaryVertices += ring.length;
        if (area === 0) continue;
        area *= winding;
        const loop = { ring: Object.freeze(ring), bounds: Object.freeze(bounds), area, holeRings: [] };
        (area > 0 ? outer : holes).push(loop);
    }
    if (Math.abs(boundaryArea-triangleArea) > Math.max(1e-8, Math.abs(triangleArea) * 1e-10)) {
        fail('Receiver boundary does not account for every source face');
    }
    const grid = yield* createBoundsGridSteps(outer, { now });
    for (const hole of holes) {
        const point = hole.ring[0]; let owner = null;
        for (const candidate of grid.candidatesAt(point.x, point.z)) {
            yield* check();
            if ((!owner || candidate.area < owner.area) && pointInRingNonZero(point.x, point.z, candidate.ring)) owner = candidate;
        }
        if (!owner) fail('Receiver hole has no containing outer boundary');
        owner.holeRings.push(hole.ring);
    }
    const regions = [];
    for (const value of outer) {
        yield* check();
        regions.push(Object.freeze({ ring: value.ring, holeRings: Object.freeze(value.holeRings), bounds: value.bounds }));
    }
    return Object.freeze({ regions: Object.freeze(regions), triangles: count / 3,
        boundaryVertices, area: Math.abs(triangleArea), maxFoldWidthM, collapsedFaces, maxHeightDifferenceM });
}
