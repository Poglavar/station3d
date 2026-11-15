// Keep complete polygon operands, but send only those intersecting each tile
// to its Worker. Exact canonical coordinates make unchanged cuts a no-op;
// a lossy hash cannot silently preserve an obsolete opening.
//
// A tile's signature covers only what its cut can depend on: each operand ring
// clipped to the tile grown by CUT_SIGNATURE_MARGIN_M. A road whose profile
// moves 300 m away no longer recompiles every receiver its polygon's bounding
// box touches (2026-11-15: half of the cut-driven receiver rebuilds on a ride).
// Clipping is exact, so any change inside the box still changes the signature.
import { createBoundsGridSteps } from './bounds-grid.js';

export const CUT_SIGNATURE_MARGIN_M = 16;

// Sutherland-Hodgman against an axis-aligned box, then rotated to start at the
// least vertex so an unchanged inside does not depend on where the ring starts.
export function clippedRingSignature(ring, box) {
    let points = ring.map(point => [point.x, point.z]);
    const clip = (inside, cross) => {
        const out = [];
        for (let index = 0; index < points.length; index++) {
            const current = points[index];
            const previous = points[(index + points.length - 1) % points.length];
            const currentIn = inside(current), previousIn = inside(previous);
            if (currentIn !== previousIn) out.push(cross(previous, current));
            if (currentIn) out.push(current);
        }
        points = out;
    };
    const at = (axis, value) => (a, b) => {
        const t = (value - a[axis]) / (b[axis] - a[axis]);
        const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        point[axis] = value;
        return point;
    };
    clip(p => p[0] >= box.minX, at(0, box.minX));
    if (points.length) clip(p => p[0] <= box.maxX, at(0, box.maxX));
    if (points.length) clip(p => p[1] >= box.minZ, at(1, box.minZ));
    if (points.length) clip(p => p[1] <= box.maxZ, at(1, box.maxZ));
    const unique = points.filter((point, index) => {
        const previous = points[(index + points.length - 1) % points.length];
        return points.length === 1 || point[0] !== previous[0] || point[1] !== previous[1];
    });
    if (unique.length < 3) return '';
    let first = 0;
    for (let index = 1; index < unique.length; index++) {
        const [x, z] = unique[index], [bestX, bestZ] = unique[first];
        if (x < bestX || (x === bestX && z < bestZ)) first = index;
    }
    let key = '';
    for (let index = 0; index < unique.length; index++) {
        const [x, z] = unique[(first + index) % unique.length];
        key += `${x},${z};`;
    }
    return key;
}

export function* prepareTerrainCutoutTilesSteps(layers, rows, { tileM, maxRegions, maxVertices,
    maxRingReferences = maxVertices, now = () => performance.now() }) {
    if (!Array.isArray(layers) || !Array.isArray(rows) || !Number.isFinite(tileM) || tileM <= 0
        || !Number.isSafeInteger(maxRegions) || maxRegions < 1 || !Number.isSafeInteger(maxVertices) || maxVertices < 1
        || !Number.isSafeInteger(maxRingReferences) || maxRingReferences < 1) {
        throw new TypeError('Terrain cut tiles require explicit bounded operands');
    }
    const indexed = [], keys = new WeakMap(), ringKeys = new WeakMap();
    let count = 0, vertices = 0, references = 0, deadline = now() + .5;
    const check = function* () {
        if (now() >= deadline) { yield { phase: 'terrain-cut-tile-index' }; deadline = now() + .5; }
    };
    function capacity(message, kind, observed, limit) {
        throw Object.assign(new Error(message), { code: 'ground-generation-capacity',
            details: { terrainCutout: { kind, observed, limit, sourceVertices: vertices,
                ringReferences: references, regionCount: count } } });
    }
    function* ringKey(ring) {
        if (++references > maxRingReferences) capacity('Terrain cut ring-reference capacity exceeded', 'ring-references', references, maxRingReferences);
        if (ringKeys.has(ring)) return ringKeys.get(ring);
        if (vertices + ring.length > maxVertices) capacity('Terrain cut vertex capacity exceeded', 'source-vertices', vertices + ring.length, maxVertices);
        vertices += ring.length;
        const parts = [];
        for (const point of ring) {
            parts.push(`${point.x},${point.z};`);
            yield* check();
        }
        const key = parts.join('');
        ringKeys.set(ring, key);
        return key;
    }
    function* regionKey(region) {
        if (keys.has(region)) return keys.get(region);
        const rings = [];
        for (const sources of [[region.ring], region.holeRings || [], region.clipRings || []]) {
            const group = [];
            for (const ring of sources) group.push(yield* ringKey(ring));
            rings.push(group);
        }
        // Vertical-only edits must invalidate receivers too. Preserve explicit
        // unbounded values as text; JSON would collapse Infinity into null.
        let vertical = `Y:${region.minY??''},${region.maxY??''},${region.maxYExclusive===true?'exclusive':'inclusive'}`;
        if (region.minPlane) vertical += `P:${['x','y','z','slopeX','slopeZ'].map(key=>region.minPlane[key]).join(',')}`;
        const key = { rings, vertical };
        keys.set(region, key);
        return key;
    }
    for (const layer of layers) {
        for (const region of layer.regions) {
            if (++count > maxRegions) capacity('Terrain cut region capacity exceeded', 'regions', count, maxRegions);
            yield* check();
        }
        indexed.push({ operation: layer.operation, index: yield* createBoundsGridSteps(layer.regions, { cellM: tileM, now }) });
    }
    const result = new Map();
    for (const row of rows) {
        const { minX, minZ, maxX, maxZ } = row.bounds || { minX: row.tileX * tileM, minZ: row.tileZ * tileM,
            maxX: (row.tileX + 1) * tileM, maxZ: (row.tileZ + 1) * tileM };
        if (![minX, minZ, maxX, maxZ].every(Number.isFinite) || minX > maxX || minZ > maxZ) {
            throw new TypeError('Terrain cut receiver requires finite ordered bounds');
        }
        const selected = [], records = [], uniqueRings = new Set();
        const box = { minX: minX - CUT_SIGNATURE_MARGIN_M, minZ: minZ - CUT_SIGNATURE_MARGIN_M,
            maxX: maxX + CUT_SIGNATURE_MARGIN_M, maxZ: maxZ + CUT_SIGNATURE_MARGIN_M };
        const clipped = new Map();
        const clippedKey = ring => {
            if (!clipped.has(ring)) clipped.set(ring, clippedRingSignature(ring, box));
            return clipped.get(ring);
        };
        for (const layer of indexed) {
            const regions = [], regionKeys = [];
            for (const region of layer.index.candidatesInBox(minX, minZ, maxX, maxZ)) {
                const b = region.bounds;
                if (!b || b.minX <= maxX && b.maxX >= minX && b.minZ <= maxZ && b.maxZ >= minZ) {
                    regions.push(region);
                    // Distant operands consume no vertex/signature storage.
                    // Shared clipping rings are read and budgeted once, as in
                    // the topology compiler that consumes these same objects.
                    const key = yield* regionKey(region);
                    const outer = clippedKey(region.ring);
                    // A region that misses the box shapes nothing here.
                    if (outer) {
                        const rings = [[outer], (region.holeRings || []).map(clippedKey),
                            (region.clipRings || []).map(clippedKey)];
                        regionKeys.push({ rings, vertical: key.vertical });
                        for (const group of rings) for (const ring of group) uniqueRings.add(ring);
                    }
                }
                yield* check();
            }
            if (!regions.length) continue;
            selected.push(Object.freeze({ operation: layer.operation, regions: Object.freeze(regions) }));
            // Contributors within one Boolean operation form a set. Stream
            // arrival order must not invalidate an unchanged terrain cut;
            // the order between subtract/restore layers remains significant.
            if (regionKeys.length) records.push({ operation: layer.operation, regions: regionKeys });
        }
        // An exact per-tile dictionary stores a shared ring once instead of
        // expanding its coordinates into every referencing region's signature.
        // Sorted content makes IDs independent of stream arrival or identity.
        const dictionary = [...uniqueRings].sort();
        const ids = new Map(dictionary.map((ring, index) => [ring, index]));
        const signature = records.length ? JSON.stringify([dictionary, records.map(layer => [layer.operation,
            layer.regions.map(key => JSON.stringify([key.rings.map(group => group.map(ring => ids.get(ring))), key.vertical])).sort(),
        ])]) : '';
        result.set(row.key, Object.freeze({ layers: Object.freeze(selected), signature }));
        yield { phase: 'terrain-cut-tile', key: row.key };
    }
    return result;
}
