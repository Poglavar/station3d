// Classifies whole logical facades as exposed or party walls by finding
// meaningfully overlapping ground-boundary segments from other buildings
// whose interiors lie on opposite sides of the shared boundary.
//
// FALLBACK PATH. The facade painter now takes its verdict from the shared street-facing
// data (world/street-facing.js, public.facade_street), which knows about streets and about
// how much of a wall's AREA a neighbour actually covers. This local geometry only answers
// for the buildings that table has no row for yet.

const DEFAULT_GRID_CELL_M = 16;
const DEFAULT_BORDER_GAP_M = 0.35;
const DEFAULT_MIN_SHARED_LENGTH_M = 1.0;
const DEFAULT_PARALLEL_DOT = 0.995;
const GEOMETRY_EPSILON_M = 1e-6;

function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function objectKey(value) {
    return value == null ? null : String(value);
}

function normalizedSide(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < GEOMETRY_EPSILON_M) return null;
    return numeric < 0 ? -1 : 1;
}

function gridKey(x, z) {
    return `${x}:${z}`;
}

function segmentFromWallPlane(wall, explicitObjectId) {
    if (!wall) return null;
    let nx = finiteNumber(wall.nx);
    let nz = finiteNumber(wall.nz);
    let d = finiteNumber(wall.d);
    let minU = finiteNumber(wall.minU ?? wall.uMin);
    let maxU = finiteNumber(wall.maxU ?? wall.uMax);
    if (nx == null || nz == null || d == null || minU == null || maxU == null) return null;

    const normalLength = Math.hypot(nx, nz);
    if (normalLength < GEOMETRY_EPSILON_M) return null;
    nx /= normalLength;
    nz /= normalLength;
    d /= normalLength;
    if (maxU < minU) [minU, maxU] = [maxU, minU];
    const length = maxU - minU;
    if (length < GEOMETRY_EPSILON_M) return null;

    const tx = nz;
    const tz = -nx;
    const ax = d * nx + minU * tx;
    const az = d * nz + minU * tz;
    const bx = d * nx + maxU * tx;
    const bz = d * nz + maxU * tz;
    return {
        objectKey: objectKey(explicitObjectId ?? wall.objectId),
        interiorSide: normalizedSide(wall.interiorSide),
        ax,
        az,
        bx,
        bz,
        tx,
        tz,
        length,
        minX: Math.min(ax, bx),
        maxX: Math.max(ax, bx),
        minZ: Math.min(az, bz),
        maxZ: Math.max(az, bz),
    };
}

function addSegmentToGrid(grid, segment, index, cellM, expansionM) {
    const minCellX = Math.floor((segment.minX - expansionM) / cellM);
    const maxCellX = Math.floor((segment.maxX + expansionM) / cellM);
    const minCellZ = Math.floor((segment.minZ - expansionM) / cellM);
    const maxCellZ = Math.floor((segment.maxZ + expansionM) / cellM);
    for (let x = minCellX; x <= maxCellX; x++) {
        for (let z = minCellZ; z <= maxCellZ; z++) {
            const key = gridKey(x, z);
            const entries = grid.get(key) || [];
            entries.push(index);
            grid.set(key, entries);
        }
    }
}

function candidateIndexesNearSegment(index, segment) {
    const gapM = index.borderGapM;
    const minCellX = Math.floor((segment.minX - gapM) / index.gridCellM);
    const maxCellX = Math.floor((segment.maxX + gapM) / index.gridCellM);
    const minCellZ = Math.floor((segment.minZ - gapM) / index.gridCellM);
    const maxCellZ = Math.floor((segment.maxZ + gapM) / index.gridCellM);
    const candidateIndexes = new Set();
    for (let x = minCellX; x <= maxCellX; x++) {
        for (let z = minCellZ; z <= maxCellZ; z++) {
            for (const candidateIndex of index.grid.get(gridKey(x, z)) || []) {
                candidateIndexes.add(candidateIndex);
            }
        }
    }
    return candidateIndexes;
}

function segmentsMayMeet(query, candidate, gapM) {
    return !(candidate.maxX < query.minX - gapM || candidate.minX > query.maxX + gapM ||
        candidate.maxZ < query.minZ - gapM || candidate.minZ > query.maxZ + gapM);
}

// GDI occasionally splits one physical building into multiple overlapping
// object IDs. A meaningful shared boundary whose two interiors lie on the
// same side proves those IDs overlap rather than adjoin. Union them once while
// building the tile index, so an opposite-wound fragment elsewhere cannot
// reintroduce a fake party wall and cover a windowed face with blank plaster.
function buildLogicalObjectGroups(index) {
    const parent = new Map();
    const find = (key) => {
        let root = key;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(key) !== key) {
            const next = parent.get(key);
            parent.set(key, root);
            key = next;
        }
        return root;
    };
    const join = (a, b) => {
        const rootA = find(a), rootB = find(b);
        if (rootA !== rootB) parent.set(rootB, rootA);
    };

    for (const segment of index.segments) parent.set(segment.objectKey, segment.objectKey);
    for (let queryIndex = 0; queryIndex < index.segments.length; queryIndex++) {
        const query = index.segments[queryIndex];
        if (!query || query.interiorSide == null) continue;
        for (const candidateIndex of candidateIndexesNearSegment(index, query)) {
            if (candidateIndex <= queryIndex) continue;
            const candidate = index.segments[candidateIndex];
            if (!candidate || candidate.objectKey === query.objectKey ||
                candidate.interiorSide !== query.interiorSide ||
                !segmentsMayMeet(query, candidate, index.borderGapM)) continue;
            if (segmentsShareBoundaryGeometry(query, candidate, index)) {
                join(query.objectKey, candidate.objectKey);
            }
        }
    }

    const groups = new Map();
    for (const key of parent.keys()) groups.set(key, find(key));
    return groups;
}

/**
 * Builds a reusable neighbor index from ground-boundary wall planes.
 * Each entry must provide objectId, nx/nz/d, uMin/uMax (or minU/maxU), and
 * interiorSide: -1/+1 for the occupied half-plane of the canonical wall.
 */
export function buildFacadeExposureIndex(walls, options = {}) {
    const gridCellM = Math.max(1, options.gridCellM ?? DEFAULT_GRID_CELL_M);
    const borderGapM = Math.max(0, options.borderGapM ?? DEFAULT_BORDER_GAP_M);
    const minSharedLengthM = Math.max(0, options.minSharedLengthM ?? DEFAULT_MIN_SHARED_LENGTH_M);
    const parallelDot = Math.max(0, Math.min(1, options.parallelDot ?? DEFAULT_PARALLEL_DOT));
    const segments = [];
    const grid = new Map();

    for (const wall of walls || []) {
        const segment = segmentFromWallPlane(wall);
        if (!segment || segment.objectKey == null) continue;
        const index = segments.length;
        segments.push(segment);
        addSegmentToGrid(grid, segment, index, gridCellM, borderGapM);
    }

    const index = {
        grid,
        segments,
        gridCellM,
        borderGapM,
        minSharedLengthM,
        parallelDot,
    };
    index.objectGroups = buildLogicalObjectGroups(index);
    return index;
}

function projectedOverlap(query, candidate) {
    const candidateA = (candidate.ax - query.ax) * query.tx +
        (candidate.az - query.az) * query.tz;
    const candidateB = (candidate.bx - query.ax) * query.tx +
        (candidate.bz - query.az) * query.tz;
    const start = Math.max(0, Math.min(candidateA, candidateB));
    const end = Math.min(query.length, Math.max(candidateA, candidateB));
    return { start, end, length: Math.max(0, end - start) };
}

function pointOnSegmentLine(segment, distanceM) {
    return {
        x: segment.ax + segment.tx * distanceM,
        z: segment.az + segment.tz * distanceM,
    };
}

function pointFitsCandidateLine(point, candidate, gapM) {
    const dx = point.x - candidate.ax;
    const dz = point.z - candidate.az;
    const along = dx * candidate.tx + dz * candidate.tz;
    if (along < -gapM || along > candidate.length + gapM) return false;
    const perpendicular = Math.abs(dx * candidate.tz - dz * candidate.tx);
    return perpendicular <= gapM + GEOMETRY_EPSILON_M;
}

function segmentsShareBoundaryGeometry(query, candidate, options) {
    const alignment = Math.abs(query.tx * candidate.tx + query.tz * candidate.tz);
    if (alignment < options.parallelDot) return false;
    const overlap = projectedOverlap(query, candidate);
    if (overlap.length + GEOMETRY_EPSILON_M < options.minSharedLengthM) return false;

    // Requiring both ends of the shared interval to stay close rejects walls
    // which merely cross or converge at a corner despite looking parallel.
    return pointFitsCandidateLine(pointOnSegmentLine(query, overlap.start), candidate, options.borderGapM) &&
        pointFitsCandidateLine(pointOnSegmentLine(query, overlap.end), candidate, options.borderGapM);
}

function segmentsSharePartyWall(query, candidate, options) {
    // A shared line is only a party wall when the two solids occupy opposite
    // half-planes. Same-side shells are grouped as one logical building when
    // the index is built and cannot suppress one another on another fragment.
    if (query.interiorSide == null || candidate.interiorSide == null ||
        query.interiorSide === candidate.interiorSide) return false;
    return segmentsShareBoundaryGeometry(query, candidate, options);
}

/**
 * Returns true when this entire logical facade should be treated as a party wall.
 *
 * Height is ignored because a footprint cannot recover it: one meaningful shared edge blanks
 * the whole facade, even where a low neighbour really covers only its bottom storeys, and a
 * courtyard wall is indistinguishable from a street frontage. Both compromises are why this is
 * now only the fallback — party_wall_area_frac and street_facing_fraction answer properly.
 */
export function logicalFacadeBordersBuilding(index, objectId, facade) {
    if (!index || !index.grid || !index.segments) return false;
    const query = segmentFromWallPlane(facade, objectId);
    if (!query) return false;

    const gapM = index.borderGapM;
    const queryGroup = index.objectGroups?.get(query.objectKey) ?? query.objectKey;
    const candidateIndexes = candidateIndexesNearSegment(index, query);

    for (const candidateIndex of candidateIndexes) {
        const candidate = index.segments[candidateIndex];
        const candidateGroup = candidate
            ? (index.objectGroups?.get(candidate.objectKey) ?? candidate.objectKey)
            : null;
        if (!candidate || candidateGroup === queryGroup) continue;
        if (!segmentsMayMeet(query, candidate, gapM)) continue;
        if (segmentsSharePartyWall(query, candidate, index)) return true;
    }
    return false;
}
