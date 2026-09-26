// Walls and floors for a walker in a modelled landmark, taken from the model's
// own faces.
//
// A landmark streams as one part per material (every seat, every roof plate,
// all of the paving), so a part's plan outline is the convex hull of things
// scattered over the whole site: as a wall it sealed a stadium's forecourt and
// corners with invisible barriers (Maksimir, 2026-09-26). And the generic
// building roof ray lifts a walker onto the HIGHEST surface above them, which
// under a stadium roof is the roof 35 m up. The faces answer both honestly:
//   • floors — upward faces no steeper than a walkable slope — carry the walker
//     at the highest one within a step of their feet, so a forecourt, a
//     concourse or a tier supports them and a roof overhead never does;
//   • walls — every other face that rises — block only where they cross the
//     walker's body, so a column or glass wall blocks exactly where it stands,
//     an inclined slab at the line where it meets the body, and a slab above
//     the head not at all. A wall is solid from both sides: the collision
//     resolver already lets a walker who starts embedded in one walk out.
// Floor-ness needs the face's up direction, so it trusts the winding; a
// landmark with flipped winding loses support on its sloped floors (as every
// landmark had none before), never gains a wall across open ground.
// Pure, so the geometry is unit-tested without a renderer.

export const LANDMARK_WALK_CELL_M = 4;
// Faces that rise less than this cannot block a body.
const MIN_FACE_RISE_M = 0.05;
// Cross-sections shorter than this are edge grazes, not obstacles.
const MIN_SLICE_M = 0.05;
// Upward faces at least this level (normal y ≥ cos 50°) are floors.
const WALKABLE_NORMAL_Y = 0.64;

// A far-LOD render row whose outline is a landmark part's hull is not a
// pedestrian outline; the near model supplies that landmark's walls.
export function farOutlineIsWalkerWall(properties) {
    return properties?.footprint_source !== 'landmark';
}

// Numeric keys: string keys made indexing the stadium's 164 m lattice bars
// (dozens of cells each) the bulk of a part's load cost.
const CELL_SPAN = 1 << 20;
function cellKey(i, j) {
    return (i + CELL_SPAN / 2) * CELL_SPAN + (j + CELL_SPAN / 2);
}

function createBucket(capacity) {
    return { tris: new Float32Array(capacity * 9), yRange: new Float32Array(capacity * 2), cells: new Map(), count: 0 };
}

// x-range of the triangle's plan inside the strip z0..z1, or null.
function stripSpan(px, pz, z0, z1) {
    let lo = Infinity, hi = -Infinity;
    for (let e = 0; e < 3; e++) {
        const ax = px[e], az = pz[e], bx = px[(e + 1) % 3], bz = pz[(e + 1) % 3];
        if (az >= z0 && az <= z1) { lo = Math.min(lo, ax); hi = Math.max(hi, ax); }
        for (const z of (az === bz ? [] : [z0, z1])) {
            const t = (z - az) / (bz - az);
            if (t <= 0 || t >= 1) continue;
            const x = ax + (bx - ax) * t;
            lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
    }
    return lo <= hi ? [lo, hi] : null;
}

// Files the triangle in every grid cell its plan crosses, one row of cells at
// a time. Its axis-aligned box would do for small faces, but a stadium's 164 m
// lattice bars run at 17.6 degrees to the grid, and their boxes filed each thin
// triangle in some 500 cells.
function addToBucket(bucket, values, lo, hi, cellM) {
    const k = bucket.count++;
    bucket.tris.set(values, k * 9);
    bucket.yRange[k * 2] = lo;
    bucket.yRange[k * 2 + 1] = hi;
    const px = [values[0], values[3], values[6]];
    const pz = [values[2], values[5], values[8]];
    const j0 = Math.floor(Math.min(...pz) / cellM), j1 = Math.floor(Math.max(...pz) / cellM);
    for (let j = j0; j <= j1; j++) {
        const span = stripSpan(px, pz, j * cellM, (j + 1) * cellM);
        if (!span) continue;
        for (let i = Math.floor(span[0] / cellM); i <= Math.floor(span[1] / cellM); i++) {
            const key = cellKey(i, j);
            let list = bucket.cells.get(key);
            if (!list) bucket.cells.set(key, list = []);
            list.push(k);
        }
    }
}

// Copies to exact size (a subarray would keep both full-size scratch buffers
// alive) and packs every cell's triangle list into one array: cell key ->
// start in `entries`, with `ends` closing each run. Thousands of small arrays
// cost more than the triangles themselves.
function finishBucket(bucket) {
    const cells = new Map();
    const ends = new Uint32Array(bucket.cells.size);
    let total = 0;
    for (const list of bucket.cells.values()) total += list.length;
    const entries = new Uint32Array(total);
    let offset = 0, cell = 0;
    for (const [key, list] of bucket.cells) {
        cells.set(key, cell);
        entries.set(list, offset);
        offset += list.length;
        ends[cell++] = offset;
    }
    return {
        tris: bucket.tris.slice(0, bucket.count * 9),
        yRange: bucket.yRange.slice(0, bucket.count * 2),
        cells,
        ends,
        entries,
        count: bucket.count,
        stamp: new Uint32Array(bucket.count),
        query: 0,
    };
}

// positions: flat [x, y, z, ...] triangle soup in scene metres (Y up).
export function buildLandmarkWalkIndex(positions, { cellM = LANDMARK_WALK_CELL_M } = {}) {
    const count = Math.floor((positions?.length || 0) / 9);
    const walls = createBucket(count);
    const floors = createBucket(count);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const values = new Array(9);
    for (let t = 0; t < count; t++) {
        for (let v = 0; v < 9; v++) values[v] = positions[t * 9 + v];
        if (!values.every(Number.isFinite)) continue;
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = values;
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (length < 1e-9) continue;
        const lo = Math.min(ay, by, cy);
        const hi = Math.max(ay, by, cy);
        if (ny / length >= WALKABLE_NORMAL_Y) addToBucket(floors, values, lo, hi, cellM);
        else if (hi - lo >= MIN_FACE_RISE_M) addToBucket(walls, values, lo, hi, cellM);
        else continue;
        minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
        minZ = Math.min(minZ, az, bz, cz); maxZ = Math.max(maxZ, az, bz, cz);
    }
    return {
        cellM,
        walls: finishBucket(walls),
        floors: finishBucket(floors),
        minX, maxX, minZ, maxZ,
    };
}

// Distinct triangle ids of a bucket whose cells meet the square around (x, z).
function* candidates(bucket, cellM, x, z, radius) {
    bucket.query = (bucket.query + 1) >>> 0 || 1;
    const query = bucket.query;
    for (let i = Math.floor((x - radius) / cellM); i <= Math.floor((x + radius) / cellM); i++) {
        for (let j = Math.floor((z - radius) / cellM); j <= Math.floor((z + radius) / cellM); j++) {
            const cell = bucket.cells.get(cellKey(i, j));
            if (cell === undefined) continue;
            for (let e = cell ? bucket.ends[cell - 1] : 0; e < bucket.ends[cell]; e++) {
                const t = bucket.entries[e];
                if (bucket.stamp[t] === query) continue;
                bucket.stamp[t] = query;
                yield t;
            }
        }
    }
}

function outside(index, x, z, radius) {
    return !index || x + radius < index.minX || x - radius > index.maxX
        || z + radius < index.minZ || z - radius > index.maxZ;
}

// Where one triangle crosses the horizontal plane at y, or null.
function sliceTriangle(tris, o, y) {
    const points = [];
    for (let e = 0; e < 3; e++) {
        const p = o + e * 3;
        const q = o + ((e + 1) % 3) * 3;
        const py = tris[p + 1] - y;
        const qy = tris[q + 1] - y;
        if (py === 0) points.push(tris[p], tris[p + 2]);
        if ((py < 0 && qy > 0) || (py > 0 && qy < 0)) {
            const t = py / (py - qy);
            points.push(tris[p] + (tris[q] - tris[p]) * t, tris[p + 2] + (tris[q + 2] - tris[p + 2]) * t);
        }
    }
    if (points.length < 4) return null;
    const [ax, az, bx, bz] = points;
    return Math.hypot(bx - ax, bz - az) < MIN_SLICE_M ? null : { ax, az, bx, bz };
}

// Walls around (x, z) as they stand at height y: the segments where they
// cross that plane, each carrying its face's own vertical extent so the
// walker's step-up and body-height rules apply unchanged.
export function landmarkWallSegments(index, x, z, radius, y) {
    if (![x, z, radius, y].every(Number.isFinite) || outside(index, x, z, radius)) return [];
    const { tris, yRange } = index.walls;
    const segments = [];
    for (const t of candidates(index.walls, index.cellM, x, z, radius)) {
        const lo = yRange[t * 2];
        const hi = yRange[t * 2 + 1];
        if (y <= lo || y >= hi) continue;
        const slice = sliceTriangle(tris, t * 9, y);
        if (slice) segments.push({ ...slice, baseY: lo, topY: hi });
    }
    return segments;
}

// Height of the highest floor under (x, z) that is no higher than maxY, or null.
export function landmarkSupportY(index, x, z, maxY) {
    if (![x, z, maxY].every(Number.isFinite) || outside(index, x, z, 0)) return null;
    const { tris, yRange } = index.floors;
    let best = null;
    for (const t of candidates(index.floors, index.cellM, x, z, 0)) {
        if (yRange[t * 2] > maxY + 0.01 || (best !== null && yRange[t * 2 + 1] <= best)) continue;
        const o = t * 9;
        const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
        const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
        const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
        const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(det) < 1e-12) continue;
        const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
        const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const y = w0 * ay + w1 * by + w2 * cy;
        if (y <= maxY + 0.01 && (best === null || y > best)) best = y;
    }
    return best;
}

// The walker-facing view of a registered landmark part: its walls cut at the
// middle of the caller's body band. Without a band there is no height to cut
// at, so the part offers no walls (and it is never a closed outline, so no
// point is "inside" it).
export function landmarkWallFootprint(footprint, x, z, radius, verticalRange) {
    const minY = verticalRange?.minY;
    const maxY = verticalRange?.maxY;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
    const segments = landmarkWallSegments(footprint.landmarkWalk, x, z, radius, (minY + maxY) / 2);
    return segments.length ? { ...footprint, closed: false, segments } : null;
}
