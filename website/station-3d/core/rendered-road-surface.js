// Exact CPU-side authority for the road polygons that world/roads.js publishes.
//
// RoadFormationModel intentionally owns only engineered carriageways. The road
// renderer also publishes pedestrian/shared streets and terrain-draped access
// surfaces, though, and those used to have no corresponding GTA/walk support.
// Keep the generated top triangles here so rendering, wheels and feet consume
// one surface instead of trying to reconstruct it from a different data set.

const DEFAULT_CELL_SIZE_M = 50;
const POINT_EPSILON = 1e-7;
// Small road parts are cheaper to scan directly than to give their handful of
// triangles another Map and typed array. Long OSM ways are the pathological
// case: their bounds touch the walker cell while nearly all triangles may be
// hundreds of metres away.
const TRIANGLE_INDEX_MIN_COUNT = 32;
const TRIANGLE_QUERY_LEAF_SIZE = 8;

function finiteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundsForPositions(positions) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
        const x = finiteNumberOrNull(positions[offset]);
        const z = finiteNumberOrNull(positions[offset + 2]);
        if (x === null || z === null) continue;
        minX = Math.min(minX, x);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxZ = Math.max(maxZ, z);
    }
    return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

function boundsContainPoint(bounds, x, z) {
    return !!bounds
        && x >= bounds.minX - POINT_EPSILON
        && x <= bounds.maxX + POINT_EPSILON
        && z >= bounds.minZ - POINT_EPSILON
        && z <= bounds.maxZ + POINT_EPSILON;
}

function triangleYAtPoint(positions, ia, ib, ic, x, z, maxY) {
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)
        || !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)
        || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return null;
    if (x < Math.min(ax, bx, cx) - POINT_EPSILON
        || x > Math.max(ax, bx, cx) + POINT_EPSILON
        || z < Math.min(az, bz, cz) - POINT_EPSILON
        || z > Math.max(az, bz, cz) + POINT_EPSILON) return null;
    const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(denominator) < 1e-9) return null;
    const aWeight = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz))
        / denominator;
    const bWeight = ((cz - az) * (x - cx) + (ax - cx) * (z - cz))
        / denominator;
    const cWeight = 1 - aWeight - bWeight;
    if (aWeight < -POINT_EPSILON || bWeight < -POINT_EPSILON
        || cWeight < -POINT_EPSILON) return null;
    const y = aWeight * ay + bWeight * by + cWeight * cy;
    return Number.isFinite(y) && y <= maxY + POINT_EPSILON ? y : null;
}

function surfaceSupportY(part, x, z, maxY, triangleIndex = null) {
    if (!boundsContainPoint(part?.bounds, x, z)) return null;
    const positions = part.positions;
    const indices = part.indices;
    if (!positions || positions.length < 9) return null;
    const count = indices?.length ?? positions.length / 3;
    let bestY = null;
    const { offsets = null, tree = null, leafCount = 0 } = triangleIndex || {};
    const candidateCount = offsets?.length ?? Math.floor(count / 3);
    const stack = tree ? [1] : null;
    do {
        let start = 0, end = candidateCount;
        if (tree) {
            const node = stack.pop(), b = node * 4;
            // Point queries include edges and the exact triangle predicate's
            // tolerance. Rectangle/detail queries use strict overlap instead.
            if (x < tree[b] - POINT_EPSILON || x > tree[b + 2] + POINT_EPSILON
                || z < tree[b + 1] - POINT_EPSILON || z > tree[b + 3] + POINT_EPSILON) continue;
            if (node < leafCount) { stack.push(node * 2 + 1, node * 2); continue; }
            start = (node - leafCount) * TRIANGLE_QUERY_LEAF_SIZE;
            end = Math.min(candidateCount, start + TRIANGLE_QUERY_LEAF_SIZE);
        }
        for (let candidate = start; candidate < end; candidate += 1) {
            const offset = offsets ? offsets[candidate] : candidate * 3;
            const ia = indices ? indices[offset] : offset;
            const ib = indices ? indices[offset + 1] : offset + 1;
            const ic = indices ? indices[offset + 2] : offset + 2;
            const y = triangleYAtPoint(positions, ia, ib, ic, x, z, maxY);
            if (y !== null && (bestY === null || y > bestY)) bestY = y;
        }
    } while (stack?.length);
    return bestY;
}

// Dense 50 m cells can contain thousands of draped faces. Detail footprints
// are often only centimetres wide: the owner/cell index alone is too coarse.
// Both feet/tyre support and detail rectangles reuse this compact bounds tree.
// Bounds stay Float64, just like the source authority.
function triangleCellIndex(values, triangleBounds) {
    const offsets = Uint32Array.from(values);
    if (offsets.length <= TRIANGLE_INDEX_MIN_COUNT) return { offsets, tree: null };
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const offset of offsets) {
        const b = offset / 3 * 4;
        minX = Math.min(minX, triangleBounds[b]); minZ = Math.min(minZ, triangleBounds[b + 1]);
        maxX = Math.max(maxX, triangleBounds[b + 2]); maxZ = Math.max(maxZ, triangleBounds[b + 3]);
    }
    const axis = maxX - minX >= maxZ - minZ ? 0 : 1;
    offsets.sort((a, b) => {
        const ai = a / 3 * 4 + axis, bi = b / 3 * 4 + axis;
        return (triangleBounds[ai] + triangleBounds[ai + 2])
            - (triangleBounds[bi] + triangleBounds[bi + 2]) || a - b;
    });
    const leafCount = 2 ** Math.ceil(Math.log2(Math.ceil(offsets.length / TRIANGLE_QUERY_LEAF_SIZE)));
    // At most 16 additional bytes per cell-triangle entry; no position copies.
    const tree = new Float64Array(leafCount * 8);
    for (let leaf = 0; leaf < leafCount; leaf++) {
        const node = (leafCount + leaf) * 4;
        tree[node] = tree[node + 1] = Infinity;
        tree[node + 2] = tree[node + 3] = -Infinity;
        const end = Math.min(offsets.length, (leaf + 1) * TRIANGLE_QUERY_LEAF_SIZE);
        for (let i = leaf * TRIANGLE_QUERY_LEAF_SIZE; i < end; i++) {
            const b = offsets[i] / 3 * 4;
            tree[node] = Math.min(tree[node], triangleBounds[b]);
            tree[node + 1] = Math.min(tree[node + 1], triangleBounds[b + 1]);
            tree[node + 2] = Math.max(tree[node + 2], triangleBounds[b + 2]);
            tree[node + 3] = Math.max(tree[node + 3], triangleBounds[b + 3]);
        }
    }
    for (let node = leafCount - 1; node > 0; node--) {
        const b = node * 4, left = node * 8, right = left + 4;
        tree[b] = Math.min(tree[left], tree[right]); tree[b + 1] = Math.min(tree[left + 1], tree[right + 1]);
        tree[b + 2] = Math.max(tree[left + 2], tree[right + 2]); tree[b + 3] = Math.max(tree[left + 3], tree[right + 3]);
    }
    return { offsets, tree, leafCount };
}

function* triangleCellOffsetsInBounds(index, bounds) {
    if (!index.tree) { yield* index.offsets; return; }
    const { offsets, tree, leafCount } = index, stack = [1];
    while (stack.length) {
        const node = stack.pop(), b = node * 4;
        // Tree traversal is bounded/cooperative even for an empty result.
        yield null;
        if (tree[b] >= bounds.maxX || tree[b + 2] <= bounds.minX
            || tree[b + 1] >= bounds.maxZ || tree[b + 3] <= bounds.minZ) continue;
        if (node < leafCount) { stack.push(node * 2 + 1, node * 2); continue; }
        const start = (node - leafCount) * TRIANGLE_QUERY_LEAF_SIZE;
        for (let i = start; i < Math.min(offsets.length, start + TRIANGLE_QUERY_LEAF_SIZE); i++) yield offsets[i];
    }
}

function triangleIndexByCell(part, cellSize, keyForCell) {
    const positions = part.positions;
    const indices = part.indices;
    const indexCount = indices?.length ?? positions.length / 3;
    const triangleCount = Math.floor(indexCount / 3);
    if (triangleCount <= TRIANGLE_INDEX_MIN_COUNT) return null;
    const mutable = new Map();
    const triangleBounds = new Float64Array(triangleCount * 4);
    for (let offset = 0; offset + 2 < indexCount; offset += 3) {
        const ia = indices ? indices[offset] : offset;
        const ib = indices ? indices[offset + 1] : offset + 1;
        const ic = indices ? indices[offset + 2] : offset + 2;
        const ax = positions[ia * 3];
        const az = positions[ia * 3 + 2];
        const bx = positions[ib * 3];
        const bz = positions[ib * 3 + 2];
        const cx = positions[ic * 3];
        const cz = positions[ic * 3 + 2];
        if (![ax, az, bx, bz, cx, cz].every(Number.isFinite)) continue;
        const minCellX = Math.floor(Math.min(ax, bx, cx) / cellSize);
        const maxCellX = Math.floor(Math.max(ax, bx, cx) / cellSize);
        const minCellZ = Math.floor(Math.min(az, bz, cz) / cellSize);
        const maxCellZ = Math.floor(Math.max(az, bz, cz) / cellSize);
        const b = offset / 3 * 4;
        triangleBounds[b] = Math.min(ax, bx, cx); triangleBounds[b + 1] = Math.min(az, bz, cz);
        triangleBounds[b + 2] = Math.max(ax, bx, cx); triangleBounds[b + 3] = Math.max(az, bz, cz);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                const key = keyForCell(cellX, cellZ);
                let offsets = mutable.get(key);
                if (!offsets) {
                    offsets = [];
                    mutable.set(key, offsets);
                }
                offsets.push(offset);
            }
        }
    }
    const compact = new Map();
    for (const [key, offsets] of mutable) {
        compact.set(key, triangleCellIndex(offsets, triangleBounds));
    }
    return compact;
}

function normalizedPart(ownerId, part, index) {
    const positions = part?.positions;
    if (!positions || positions.length < 9) return null;
    const bounds = part.bounds || boundsForPositions(positions);
    if (!bounds) return null;
    return {
        id: String(part.id || `${ownerId}:${index}`),
        ownerId,
        osmId: part.osmId == null ? null : String(part.osmId),
        surfaceType: String(part.surfaceType || 'default'),
        drivable: part.drivable === true,
        surfaceClaim: part.surfaceClaim || null,
        positions,
        indices: part.indices || null,
        bounds,
    };
}

export function createRenderedRoadSurfaceRegistry({
    cellSizeM = DEFAULT_CELL_SIZE_M,
} = {}) {
    const cellSize = Math.max(10, finiteNumberOrNull(cellSizeM) ?? DEFAULT_CELL_SIZE_M);
    const owners = new Map();
    const cells = new Map();
    const cellRevisions = new Map();
    let revision = 0;
    let epoch = 0;
    let pendingPublication = null;
    const readSnapshots = new Set();

    // A moving consumer chooses its query window AFTER the world geometry is
    // prepared. Copy only that bounded window, merging private replacement
    // cells with still-published neighbours. A rejected window releases its
    // references without invalidating or recompiling the world candidate.
    function* captureReadSnapshotSteps(bounds, { maxCells, maxCellParts,
        isCurrent = () => true } = {}, replacementCells = null, ownerCurrent = () => true) {
        if (!bounds || !['minX', 'maxX', 'minZ', 'maxZ'].every(key => Number.isFinite(bounds[key]))
            || bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ
            || ![maxCells, maxCellParts].every(value => Number.isSafeInteger(value) && value > 0)
            || typeof isCurrent !== 'function') throw new TypeError('Invalid road read coverage or limits');
        if (readSnapshots.size >= 8) throw Object.assign(new Error('Road read snapshot capacity exceeded'),
            { code: 'ground-generation-capacity' });
        const coverage = Object.freeze({ ...bounds });
        const x0 = Math.floor(bounds.minX / cellSize), x1 = Math.floor(bounds.maxX / cellSize);
        const z0 = Math.floor(bounds.minZ / cellSize), z1 = Math.floor(bounds.maxZ / cellSize);
        if (![x0, x1, z0, z1].every(Number.isSafeInteger)
            || (x1 - x0 + 1) * (z1 - z0 + 1) > maxCells) throw Object.assign(
            new Error('Road read cell capacity exceeded'), { code: 'ground-generation-capacity' });
        const capturedEpoch = epoch, captured = new Map(), sourceCells = new Map();
        let active = true, handedOff = false, cellParts = 0;
        const release = () => {
            if (!active) return false;
            active = false; captured.clear(); sourceCells.clear(); readSnapshots.delete(release); return true;
        };
        readSnapshots.add(release);
        const current = () => {
            if (!active || capturedEpoch !== epoch || !ownerCurrent() || !isCurrent()) return false;
            for (const [key, value] of captured) if (cellRevisions.get(key) !== value) return false;
            return true;
        };
        const assertRead = (x, z, radius = 0) => {
            if (!active) throw new Error('Road read snapshot was released');
            if (![x, z, radius].every(Number.isFinite) || radius < 0
                || x - radius < coverage.minX || x + radius > coverage.maxX
                || z - radius < coverage.minZ || z + radius > coverage.maxZ) {
                throw new Error('Road support query exceeds captured coverage');
            }
        };
        try {
            for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
                if (!current()) return null;
                const key = cellKey(x, z), values = new Set();
                captured.set(key, cellRevisions.get(key));
                sourceCells.set(key, values);
                const parts = replacementCells?.has(key) ? replacementCells.get(key) : cells.get(key);
                for (const part of parts || []) {
                    if (++cellParts > maxCellParts) throw Object.assign(new Error('Road read cell-part capacity exceeded'),
                        { code: 'ground-generation-capacity' });
                    values.add(part); yield { phase: 'support-read-part' };
                    if (!current()) return null;
                }
                yield { phase: 'support-read-cell' };
            }
            if (!current()) return null;
            handedOff = true;
            return Object.freeze({ bounds: coverage, isCurrent: current, release,
                usage: Object.freeze({ cells: sourceCells.size, cellParts }),
                partsNear(x, z, radius = 0, options) {
                    assertRead(x, z, radius); return partsNearIn(sourceCells, x, z, radius, options);
                },
                supportYAt(x, z, options) { assertRead(x, z); return supportYAtIn(sourceCells, x, z, options); },
                trianglesInBounds(bounds, options) {
                    assertRead(bounds.minX, bounds.minZ); assertRead(bounds.maxX, bounds.maxZ);
                    return trianglesInBounds(sourceCells, bounds, options);
                },
            });
        } finally { if (!handedOff) release(); }
    }

    const cellKey = (cellX, cellZ) => `${cellX}_${cellZ}`;
    function partsNearIn(sourceCells, x, z, radiusM = 0, { drivableOnly = false } = {}) {
        const localX = finiteNumberOrNull(x);
        const localZ = finiteNumberOrNull(z);
        const radius = Math.max(0, finiteNumberOrNull(radiusM) ?? 0);
        if (localX === null || localZ === null) return [];
        const minCellX = Math.floor((localX - radius) / cellSize), maxCellX = Math.floor((localX + radius) / cellSize);
        const minCellZ = Math.floor((localZ - radius) / cellSize), maxCellZ = Math.floor((localZ + radius) / cellSize);
        const radiusSquared = radius * radius, found = new Set();
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            for (const part of sourceCells.get(cellKey(cellX, cellZ)) || []) {
                if (drivableOnly && !part.drivable) continue;
                const dx = localX < part.bounds.minX ? part.bounds.minX - localX : localX > part.bounds.maxX ? localX - part.bounds.maxX : 0;
                const dz = localZ < part.bounds.minZ ? part.bounds.minZ - localZ : localZ > part.bounds.maxZ ? localZ - part.bounds.maxZ : 0;
                if (dx * dx + dz * dz <= radiusSquared) found.add(part);
            }
        }
        return Array.from(found);
    }
    function supportYAtIn(sourceCells, x, z, { maxY = Infinity, drivableOnly = false, acceptPart = null } = {}) {
        const localX = finiteNumberOrNull(x), localZ = finiteNumberOrNull(z);
        const ceilingY = finiteNumberOrNull(maxY) ?? Infinity;
        if (localX === null || localZ === null) return null;
        const queryCellKey = cellKey(Math.floor(localX / cellSize), Math.floor(localZ / cellSize));
        let bestY = null;
        for (const part of sourceCells.get(queryCellKey) || []) {
            if (drivableOnly && !part.drivable) continue;
            if (part.surfaceClaim?.capabilities?.support === false) continue;
            if (acceptPart && !acceptPart(part)) continue;
            const triangleIndex = part.triangleIndexByCell?.get(queryCellKey);
            if (part.triangleIndexByCell && !triangleIndex) continue;
            const y = surfaceSupportY(part, localX, localZ, ceilingY, triangleIndex);
            if (y !== null && (bestY === null || y > bestY)) bestY = y;
        }
        return bestY;
    }
    // Reuse the published cell/triangle index for exact detail projection. A
    // null item is a cooperative checkpoint even when a bucket has no eligible
    // faces. Each retained face is emitted once across cell boundaries.
    function* trianglesInBounds(sourceCells, bounds, { acceptPart = null,
        maxCells = 64, maxCellParts = 4096, maxTriangles = 32768 } = {}) {
        if (!['minX', 'minZ', 'maxX', 'maxZ'].every(k => Number.isFinite(bounds?.[k]))
            || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ
            || ![maxCells, maxCellParts, maxTriangles].every(v => Number.isSafeInteger(v) && v > 0)) {
            throw new TypeError('Road detail requires finite bounds and capacities');
        }
        const x0 = Math.floor(bounds.minX / cellSize), x1 = Math.floor(bounds.maxX / cellSize);
        const z0 = Math.floor(bounds.minZ / cellSize), z1 = Math.floor(bounds.maxZ / cellSize);
        const capacity = () => { throw Object.assign(new RangeError('Road detail query capacity exceeded'),
            { code: 'ground-detail-capacity' }); };
        if (![x0, x1, z0, z1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (z1 - z0 + 1) > maxCells) capacity();
        const seen = new Map();
        let cellParts = 0, triangleCount = 0;
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
            const key = cellKey(x, z);
            for (const part of sourceCells.get(key) || []) {
                if (++cellParts > maxCellParts) capacity();
                yield null;
                if (acceptPart && !acceptPart(part)) continue;
                if (part.bounds.minX >= bounds.maxX || part.bounds.maxX <= bounds.minX
                    || part.bounds.minZ >= bounds.maxZ || part.bounds.maxZ <= bounds.minZ) continue;
                let offsetsSeen = seen.get(part);
                if (!offsetsSeen) { offsetsSeen = new Set(); seen.set(part, offsetsSeen); }
                const index = part.triangleIndexByCell?.get(key);
                const count = (part.indices?.length ?? part.positions.length / 3) / 3;
                const offsets = index ? triangleCellOffsetsInBounds(index, bounds)
                    : (function* () { for (let i = 0; i < count; i++) yield i * 3; })();
                for (const offset of offsets) {
                    if (offset === null) {
                        if (++triangleCount > maxTriangles) capacity();
                        yield null; continue;
                    }
                    if (offsetsSeen.has(offset)) continue;
                    if (++triangleCount > maxTriangles) capacity();
                    offsetsSeen.add(offset);
                    const p = part.positions, indices = part.indices;
                    const a = (indices ? indices[offset] : offset) * 3;
                    const b = (indices ? indices[offset + 1] : offset + 1) * 3;
                    const c = (indices ? indices[offset + 2] : offset + 2) * 3;
                    if (Math.min(p[a], p[b], p[c]) >= bounds.maxX || Math.max(p[a], p[b], p[c]) <= bounds.minX
                        || Math.min(p[a + 2], p[b + 2], p[c + 2]) >= bounds.maxZ
                        || Math.max(p[a + 2], p[b + 2], p[c + 2]) <= bounds.minZ) { yield null; continue; }
                    yield { positions: p, a, b, c };
                }
            }
            yield null;
        }
    }
    const cellsForBounds = bounds => {
        const keys = [];
        const minCellX = Math.floor(bounds.minX / cellSize);
        const maxCellX = Math.floor(bounds.maxX / cellSize);
        const minCellZ = Math.floor(bounds.minZ / cellSize);
        const maxCellZ = Math.floor(bounds.maxZ / cellSize);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                keys.push(cellKey(cellX, cellZ));
            }
        }
        return keys;
    };
    const unregister = ownerId => {
        const previous = owners.get(ownerId);
        if (!previous) return null;
        const touched = new Set();
        for (const part of previous) {
            for (const key of part.cellKeys) {
                touched.add(key);
                const bucket = cells.get(key);
                if (!bucket) continue;
                bucket.delete(part);
                if (bucket.size === 0) cells.delete(key);
            }
        }
        owners.delete(ownerId);
        return touched;
    };

    // Triangle-cell indexing is the expensive part of publishing analytic
    // support. Road meshes are assembled off-scene, so prepare the matching
    // support off-authority as well and make the visible-root commit perform
    // only the bounded cell registration. A prepared value is deliberately
    // tied to this registry and owner; it cannot be committed under another
    // surface generation by accident.
    const prepare = (owner, parts = []) => {
        const ownerId = String(owner);
        const normalized = (Array.isArray(parts) ? parts : [])
            .map((part, index) => normalizedPart(ownerId, part, index))
            .filter(Boolean);
        for (const part of normalized) {
            part.triangleIndexByCell = triangleIndexByCell(
                part,
                cellSize,
                cellKey,
            );
            // Indexed meshes only need cells containing a triangle. Keeping
            // the whole part AABB here registers large empty gaps (especially
            // for sparse or diagonal road meshes) and can exhaust the bounded
            // publication cell budget. Small meshes intentionally skip the
            // index and retain conservative bounds-cell registration.
            part.cellKeys = part.triangleIndexByCell
                ? [...part.triangleIndexByCell.keys()]
                : cellsForBounds(part.bounds);
        }
        return Object.freeze({
            contract: 'station3d-rendered-road-support-v1',
            registry: api,
            ownerId,
            parts: normalized,
        });
    };

    const requirePrepared = (ownerId, prepared) => {
        if (prepared?.contract !== 'station3d-rendered-road-support-v1'
            || prepared.registry !== api
            || prepared.ownerId !== ownerId
            || !Array.isArray(prepared.parts)) {
            throw new TypeError('Prepared road support belongs to another owner or registry');
        }
    };
    const replacePrepared = (owner, prepared) => {
        const ownerId = String(owner);
        requirePrepared(ownerId, prepared);
        const touched = unregister(ownerId) || new Set();
        for (const part of prepared.parts) {
            for (const key of part.cellKeys) {
                touched.add(key);
                let bucket = cells.get(key);
                if (!bucket) {
                    bucket = new Set();
                    cells.set(key, bucket);
                }
                bucket.add(part);
            }
        }
        if (prepared.parts.length > 0) owners.set(ownerId, prepared.parts);
        if (touched.size > 0) {
            revision += 1;
            for (const key of touched) cellRevisions.set(key, revision);
        }
        return prepared.parts.length;
    };

    // Stage sparse cell/owner tables, including any requested physics query
    // window, before a render batch publishes. No triangle indexing, cell-set
    // copying or geometry allocation belongs in the final reversible swap.
    function* preparePublicationSteps(preparedValues, { maxOwners, maxCells, maxCellParts, queryBounds = null } = {}) {
        for (const [name, value] of Object.entries({ maxOwners, maxCells, maxCellParts })) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid road support limit ${name}`);
        }
        if (pendingPublication) throw new Error('Road support publication already pending');
        if (!Array.isArray(preparedValues) || (preparedValues.length === 0 && !queryBounds) || preparedValues.length > maxOwners) {
            throw new Error('Road support owner capacity exceeded');
        }
        if (queryBounds && (!['minX', 'maxX', 'minZ', 'maxZ'].every(key => Number.isFinite(queryBounds[key]))
            || queryBounds.minX > queryBounds.maxX || queryBounds.minZ > queryBounds.maxZ)) {
            throw new TypeError('Invalid road support query bounds');
        }
        const bounds = queryBounds ? Object.freeze({ ...queryBounds }) : null;
        const token = {}; pendingPublication = token;
        const capturedEpoch = epoch, previousOwners = new Map(), nextOwners = new Map();
        const previousCells = new Map(), nextCells = new Map(), capturedRevisions = new Map(), writeCells = new Set();
        const queryCells = new Set();
        const candidateReads = new Set();
        let changesQueryWindow = false;
        let changesDrivableQueryWindow = false;
        let phase = 'preparing', handedOff = false, priorRevision = null, cellParts = 0;
        const trackCell = key => {
            if (capturedRevisions.has(key)) return;
            if (capturedRevisions.size >= maxCells) throw new Error('Road support cell capacity exceeded');
            capturedRevisions.set(key, cellRevisions.get(key)); previousCells.set(key, cells.get(key) || null);
        };
        const current = () => {
            if (pendingPublication !== token || epoch !== capturedEpoch) return false;
            for (const [ownerId, parts] of previousOwners) if ((owners.get(ownerId) || null) !== parts) return false;
            for (const [key, captured] of capturedRevisions) if (cellRevisions.get(key) !== captured) return false;
            return true;
        };
        const release = () => {
            for (const read of candidateReads) read.release();
            candidateReads.clear();
            previousOwners.clear(); nextOwners.clear(); previousCells.clear(); nextCells.clear();
            capturedRevisions.clear(); writeCells.clear(); queryCells.clear(); preparedValues = null;
            if (pendingPublication === token) pendingPublication = null;
        };
        const assertRead = (x, z, radius = 0) => {
            if (!['prepared', 'committed'].includes(phase)) throw new Error('Road support candidate read was released');
            if (!bounds) throw new Error('Road support candidate has no captured query window');
            if (![x, z, radius].every(Number.isFinite) || radius < 0 || x - radius < bounds.minX
                || x + radius > bounds.maxX || z - radius < bounds.minZ || z + radius > bounds.maxZ) {
                throw new Error('Road support query exceeds captured coverage');
            }
        };
        try {
            if (bounds) {
                const x0 = Math.floor(bounds.minX / cellSize), x1 = Math.floor(bounds.maxX / cellSize);
                const z0 = Math.floor(bounds.minZ / cellSize), z1 = Math.floor(bounds.maxZ / cellSize);
                if (![x0, x1, z0, z1].every(Number.isSafeInteger)) throw new TypeError('Invalid road support query cell coordinates');
                if ((x1 - x0 + 1) * (z1 - z0 + 1) > maxCells) throw new Error('Road support query cell capacity exceeded');
                for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
                    const key = cellKey(x, z);
                    queryCells.add(key); trackCell(key); yield { phase: 'support-query-cell' };
                }
            }
            for (const prepared of preparedValues) {
                const ownerId = prepared?.ownerId;
                requirePrepared(ownerId, prepared);
                if (previousOwners.has(ownerId)) throw new Error('Duplicate road support publication owner');
                const previous = owners.get(ownerId) || null;
                previousOwners.set(ownerId, previous);
                if (previous === prepared.parts || (!previous && prepared.parts.length === 0)) continue;
                nextOwners.set(ownerId, prepared.parts.length ? prepared.parts : null);
                for (const parts of [previous || [], prepared.parts]) for (const part of parts) {
                    for (const key of part.cellKeys) {
                        trackCell(key); writeCells.add(key);
                        if (queryCells.has(key)) {
                            changesQueryWindow = true;
                            if (part.drivable) changesDrivableQueryWindow = true;
                        }
                        yield { phase: 'support-write-cell' };
                    }
                }
            }
            for (const [key, previous] of previousCells) {
                const next = new Set();
                for (const part of previous || []) {
                    if (!nextOwners.has(part.ownerId)) {
                        if (++cellParts > maxCellParts) throw new Error('Road support cell-part capacity exceeded');
                        next.add(part);
                    }
                    yield { phase: 'support-retain-part' };
                }
                nextCells.set(key, next);
            }
            for (const parts of nextOwners.values()) for (const part of parts || []) {
                for (const key of part.cellKeys) {
                    if (++cellParts > maxCellParts) throw new Error('Road support cell-part capacity exceeded');
                    nextCells.get(key).add(part); yield { phase: 'support-replacement-part' };
                }
            }
            if (!current()) throw new Error('Road support publication inputs became stale');
            phase = 'prepared'; handedOff = true;
            return {
                get state() { return phase; },
                changesQueryWindow,
                changesDrivableQueryWindow,
                usage: Object.freeze({ owners: nextOwners.size, cells: nextCells.size, writeCells: writeCells.size, cellParts }),
                isCurrent: () => phase === 'prepared' && current(),
                *captureReadSnapshotSteps(bounds, limits) {
                    const read = yield* captureReadSnapshotSteps(bounds, limits, nextCells,
                        () => phase === 'prepared' && current());
                    if (!read) return null;
                    const owned = Object.freeze({ ...read, release() {
                        candidateReads.delete(owned); return read.release();
                    } });
                    candidateReads.add(owned);
                    return owned;
                },
                read: Object.freeze({
                    partsNear(x, z, radius = 0, options) { assertRead(x, z, radius); return partsNearIn(nextCells, x, z, radius, options); },
                    supportYAt(x, z, options) { assertRead(x, z); return supportYAtIn(nextCells, x, z, options); },
                }),
                commit() {
                    if (phase !== 'prepared' || !current()) return false;
                    priorRevision = revision;
                    if (writeCells.size) revision++;
                    for (const [ownerId, parts] of nextOwners) {
                        if (parts) owners.set(ownerId, parts); else owners.delete(ownerId);
                    }
                    for (const key of writeCells) {
                        const next = nextCells.get(key);
                        if (next.size) cells.set(key, next); else cells.delete(key);
                        cellRevisions.set(key, revision);
                    }
                    phase = 'committed'; return true;
                },
                rollback() {
                    if (phase !== 'committed') return false;
                    for (const [ownerId, parts] of previousOwners) {
                        if (parts) owners.set(ownerId, parts); else owners.delete(ownerId);
                    }
                    for (const key of writeCells) {
                        const previous = previousCells.get(key), captured = capturedRevisions.get(key);
                        if (previous) cells.set(key, previous); else cells.delete(key);
                        if (captured === undefined) cellRevisions.delete(key); else cellRevisions.set(key, captured);
                    }
                    revision = priorRevision; phase = 'prepared'; return true;
                },
                discard() {
                    if (phase === 'committed') throw new Error('Rollback road support before discarding');
                    if (phase !== 'prepared') return false;
                    phase = 'discarded'; release(); return true;
                },
                finalize() {
                    if (phase !== 'committed') return false;
                    phase = 'finalized'; release(); return true;
                },
            };
        } finally {
            if (!handedOff) { phase = 'discarded'; release(); }
        }
    }

    const api = {
        get revision() {
            return revision;
        },

        prepare,

        replacePrepared,
        preparePublicationSteps,
        captureReadSnapshotSteps,

        replace(owner, parts = []) {
            return replacePrepared(owner, prepare(owner, parts));
        },

        remove(owner) {
            const touched = unregister(String(owner));
            if (!touched) return false;
            revision += 1;
            for (const key of touched) cellRevisions.set(key, revision);
            return true;
        },

        clear() {
            for (const release of [...readSnapshots]) release();
            epoch++; pendingPublication = null;
            if (owners.size === 0) return false;
            const touched = new Set(cells.keys());
            owners.clear();
            cells.clear();
            revision += 1;
            for (const key of touched) cellRevisions.set(key, revision);
            return true;
        },

        revisionNear(x, z, radiusM = 0) {
            const localX = finiteNumberOrNull(x);
            const localZ = finiteNumberOrNull(z);
            const radius = Math.max(0, finiteNumberOrNull(radiusM) ?? 0);
            if (localX === null || localZ === null) return revision;
            const minCellX = Math.floor((localX - radius) / cellSize);
            const maxCellX = Math.floor((localX + radius) / cellSize);
            const minCellZ = Math.floor((localZ - radius) / cellSize);
            const maxCellZ = Math.floor((localZ + radius) / cellSize);
            let nearbyRevision = 0;
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                    nearbyRevision = Math.max(
                        nearbyRevision,
                        cellRevisions.get(cellKey(cellX, cellZ)) || 0,
                    );
                }
            }
            return nearbyRevision;
        },

        partsNear(x, z, radiusM = 0, options = {}) { return partsNearIn(cells, x, z, radiusM, options); },

        supportYAt(x, z, options = {}) { return supportYAtIn(cells, x, z, options); },

        trianglesInBounds(bounds, options) { return trianglesInBounds(cells, bounds, options); },

        debugState() {
            let partCount = 0;
            for (const parts of owners.values()) partCount += parts.length;
            return {
                revision,
                ownerCount: owners.size,
                partCount,
                cellCount: cells.size,
                readSnapshots: readSnapshots.size,
            };
        },
    };
    return api;
}
