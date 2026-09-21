// Pure, resumable compiler for the mapped-coast land collar and quay wall.
//
// The water layer used to resample the whole shoreline, allocate both meshes,
// and run THREE.BufferGeometry.computeVertexNormals() from its onFrame hook.
// Terrain-detail publications can arrive several times while the observer is
// moving, turning each revision into one uninterruptible 20-30 ms item. This
// task keeps every visit bounded and returns typed arrays only; Three.js
// resource creation, GPU preparation, and atomic publication remain on the
// main thread in world/water.js.

const DEFAULT_ITEMS_PER_STEP = 24;
const DEFAULT_TRIANGLES_PER_STEP = 256;

function positiveInteger(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
        ? Math.max(1, Math.floor(numeric))
        : fallback;
}

function pointKey(point) {
    return `${point?.[0]}:${point?.[1]}`;
}

function finitePoint(point) {
    return Array.isArray(point)
        && Number.isFinite(point[0])
        && Number.isFinite(point[1]);
}

function computeFlatNormalsRange(positions, normals, startTriangle, endTriangle) {
    for (let triangle = startTriangle; triangle < endTriangle; triangle++) {
        const offset = triangle * 9;
        const ax = positions[offset];
        const ay = positions[offset + 1];
        const az = positions[offset + 2];
        const bx = positions[offset + 3];
        const by = positions[offset + 4];
        const bz = positions[offset + 5];
        const cx = positions[offset + 6];
        const cy = positions[offset + 7];
        const cz = positions[offset + 8];
        const cbx = cx - bx;
        const cby = cy - by;
        const cbz = cz - bz;
        const abx = ax - bx;
        const aby = ay - by;
        const abz = az - bz;
        let nx = cby * abz - cbz * aby;
        let ny = cbz * abx - cbx * abz;
        let nz = cbx * aby - cby * abx;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length > 0) {
            nx /= length;
            ny /= length;
            nz /= length;
        }
        normals[offset] = nx;
        normals[offset + 1] = ny;
        normals[offset + 2] = nz;
        normals[offset + 3] = nx;
        normals[offset + 4] = ny;
        normals[offset + 5] = nz;
        normals[offset + 6] = nx;
        normals[offset + 7] = ny;
        normals[offset + 8] = nz;
    }
}

export function createCoastDressingBuildTask({
    collar,
    seaY,
    sampleTerrainY,
    terrainAware = true,
    fallbackTopY = 0.02,
    wallBottomY = -2.4,
    uvPerM = 1,
    originX = 0,
    originZ = 0,
    itemsPerStep = DEFAULT_ITEMS_PER_STEP,
    trianglesPerStep = DEFAULT_TRIANGLES_PER_STEP,
} = {}) {
    if (![originX, originZ].every(Number.isFinite)) throw new TypeError('Coast geometry requires a finite storage origin');
    const quads = Array.isArray(collar?.quads) ? collar.quads : [];
    const joins = Array.isArray(collar?.joins) ? collar.joins : [];
    const safeItemsPerStep = positiveInteger(itemsPerStep, DEFAULT_ITEMS_PER_STEP);
    const safeTrianglesPerStep = positiveInteger(
        trianglesPerStep,
        DEFAULT_TRIANGLES_PER_STEP,
    );
    const safeFallbackTopY = Number.isFinite(fallbackTopY) ? fallbackTopY : 0.02;
    const safeWallBottomY = Number.isFinite(wallBottomY) ? wallBottomY : -2.4;
    const safeSeaY = Number.isFinite(seaY) ? seaY : 0;
    const safeUvPerM = Number.isFinite(uvPerM) ? uvPerM : 1;
    const terrainSampler = typeof sampleTerrainY === 'function'
        ? sampleTerrainY
        : () => null;

    const landTopIndex = new Map();
    const shoreTopIndex = new Map();
    let phase = 'sample-quads';
    let cursor = 0;
    let outcome = null;
    let collarPositions = null;
    let collarNormals = null;
    let collarUvs = null;
    let wallPositions = null;
    let wallNormals = null;
    let collarPositionOffset = 0;
    let collarUvOffset = 0;
    let wallPositionOffset = 0;

    const failUnavailable = () => {
        phase = 'done';
        outcome = {
            status: 'unavailable',
            collarPositions: new Float32Array(0),
            collarNormals: new Float32Array(0),
            collarUvs: new Float32Array(0),
            wallPositions: new Float32Array(0),
            wallNormals: new Float32Array(0),
        };
        return 'done';
    };

    const samplePoint = (point) => {
        if (!finitePoint(point)) return null;
        if (!terrainAware) return safeFallbackTopY;
        const key = pointKey(point);
        if (landTopIndex.has(key)) return landTopIndex.get(key);
        const sampled = terrainSampler(point);
        if (!Number.isFinite(sampled)) return null;
        landTopIndex.set(key, sampled);
        return sampled;
    };

    const rememberShoreTop = (shore, landY) => {
        if (!finitePoint(shore) || !Number.isFinite(landY)) return false;
        const key = pointKey(shore);
        const previous = shoreTopIndex.get(key);
        shoreTopIndex.set(
            key,
            Number.isFinite(previous) ? Math.max(previous, landY) : landY,
        );
        return true;
    };

    const landY = point => (
        terrainAware ? landTopIndex.get(pointKey(point)) : safeFallbackTopY
    );
    const shoreY = shore => (
        terrainAware ? shoreTopIndex.get(pointKey(shore)) : safeFallbackTopY
    );
    const resolvedLandY = (point, explicitY) => (
        Number.isFinite(explicitY) ? explicitY : landY(point)
    );
    const resolvedShoreY = (shore, explicitY) => (
        Number.isFinite(explicitY) ? explicitY : shoreY(shore)
    );

    const writeCollarVertex = (point, y) => {
        collarPositions[collarPositionOffset++] = point[0] - originX;
        collarPositions[collarPositionOffset++] = y;
        collarPositions[collarPositionOffset++] = point[1] - originZ;
        collarUvs[collarUvOffset++] = point[0] * safeUvPerM;
        collarUvs[collarUvOffset++] = point[1] * safeUvPerM;
    };

    const writeCollarTriangle = (a, ay, b, by, c, cy) => {
        const area = (b[0] - a[0]) * (c[1] - a[1])
            - (c[0] - a[0]) * (b[1] - a[1]);
        if (area > 0) {
            [b, c] = [c, b];
            [by, cy] = [cy, by];
        }
        writeCollarVertex(a, ay);
        writeCollarVertex(b, by);
        writeCollarVertex(c, cy);
    };

    const writeWallVertex = (point, y) => {
        wallPositions[wallPositionOffset++] = point[0] - originX;
        wallPositions[wallPositionOffset++] = y;
        wallPositions[wallPositionOffset++] = point[1] - originZ;
    };

    function step() {
        if (phase === 'done') return 'done';

        if (phase === 'sample-quads') {
            const end = Math.min(quads.length, cursor + safeItemsPerStep);
            for (; cursor < end; cursor++) {
                const {
                    shoreA, shoreB, landA, landB,
                    shoreAY, shoreBY,
                    landAY: explicitLandAY,
                    landBY: explicitLandBY,
                } = quads[cursor] || {};
                const landAY = Number.isFinite(explicitLandAY)
                    ? explicitLandAY
                    : samplePoint(landA);
                const landBY = Number.isFinite(explicitLandBY)
                    ? explicitLandBY
                    : samplePoint(landB);
                if (Number.isFinite(explicitLandAY)) {
                    landTopIndex.set(pointKey(landA), explicitLandAY);
                }
                if (Number.isFinite(explicitLandBY)) {
                    landTopIndex.set(pointKey(landB), explicitLandBY);
                }
                if (landAY === null || landBY === null
                    || !rememberShoreTop(
                        shoreA,
                        Number.isFinite(shoreAY) ? shoreAY : landAY,
                    )
                    || !rememberShoreTop(
                        shoreB,
                        Number.isFinite(shoreBY) ? shoreBY : landBY,
                    )) return failUnavailable();
            }
            if (cursor >= quads.length) {
                phase = 'sample-joins';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'sample-joins') {
            const end = Math.min(joins.length, cursor + safeItemsPerStep);
            for (; cursor < end; cursor++) {
                const {
                    shore,
                    landPrevious,
                    landNext,
                    shoreY: explicitShoreY,
                    landPreviousY,
                    landNextY,
                } = joins[cursor] || {};
                const previousY = Number.isFinite(landPreviousY)
                    ? landPreviousY
                    : samplePoint(landPrevious);
                const nextY = Number.isFinite(landNextY)
                    ? landNextY
                    : samplePoint(landNext);
                if (Number.isFinite(landPreviousY)) {
                    landTopIndex.set(pointKey(landPrevious), landPreviousY);
                }
                if (Number.isFinite(landNextY)) {
                    landTopIndex.set(pointKey(landNext), landNextY);
                }
                if (!finitePoint(shore)
                    || previousY === null
                    || nextY === null
                    || (Number.isFinite(explicitShoreY)
                        && !rememberShoreTop(shore, explicitShoreY))) {
                    return failUnavailable();
                }
            }
            if (cursor >= joins.length) {
                phase = 'allocate';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'allocate') {
            const collarTriangles = quads.length * 2 + joins.length;
            const wallTriangles = quads.length * 2;
            collarPositions = new Float32Array(collarTriangles * 9);
            collarNormals = new Float32Array(collarTriangles * 9);
            collarUvs = new Float32Array(collarTriangles * 6);
            wallPositions = new Float32Array(wallTriangles * 9);
            wallNormals = new Float32Array(wallTriangles * 9);
            phase = 'collar-quads';
            return 'more';
        }

        if (phase === 'collar-quads') {
            const end = Math.min(quads.length, cursor + safeItemsPerStep);
            for (; cursor < end; cursor++) {
                const quad = quads[cursor];
                const { shoreA, shoreB, landA, landB } = quad;
                const shoreAY = resolvedShoreY(shoreA, quad.shoreAY);
                const shoreBY = resolvedShoreY(shoreB, quad.shoreBY);
                const landAY = resolvedLandY(landA, quad.landAY);
                const landBY = resolvedLandY(landB, quad.landBY);
                if (![shoreAY, shoreBY, landAY, landBY].every(Number.isFinite)) {
                    return failUnavailable();
                }
                writeCollarTriangle(shoreA, shoreAY, landA, landAY, shoreB, shoreBY);
                writeCollarTriangle(shoreB, shoreBY, landA, landAY, landB, landBY);
            }
            if (cursor >= quads.length) {
                phase = 'collar-joins';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'collar-joins') {
            const end = Math.min(joins.length, cursor + safeItemsPerStep);
            for (; cursor < end; cursor++) {
                const join = joins[cursor];
                const { shore, landPrevious, landNext } = join;
                const topY = resolvedShoreY(shore, join.shoreY);
                const previousY = resolvedLandY(landPrevious, join.landPreviousY);
                const nextY = resolvedLandY(landNext, join.landNextY);
                if (![topY, previousY, nextY].every(Number.isFinite)) {
                    return failUnavailable();
                }
                writeCollarTriangle(
                    shore,
                    topY,
                    landPrevious,
                    previousY,
                    landNext,
                    nextY,
                );
            }
            if (cursor >= joins.length) {
                phase = 'wall-quads';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'wall-quads') {
            const end = Math.min(quads.length, cursor + safeItemsPerStep);
            for (; cursor < end; cursor++) {
                const quad = quads[cursor];
                const { shoreA, shoreB } = quad;
                const topA = resolvedShoreY(shoreA, quad.shoreAY);
                const topB = resolvedShoreY(shoreB, quad.shoreBY);
                if (![topA, topB].every(Number.isFinite)) return failUnavailable();
                writeWallVertex(shoreA, topA);
                writeWallVertex(shoreB, topB);
                writeWallVertex(shoreA, terrainAware ? safeSeaY - 0.8 : safeWallBottomY);
                writeWallVertex(shoreB, topB);
                writeWallVertex(shoreB, terrainAware ? safeSeaY - 0.8 : safeWallBottomY);
                writeWallVertex(shoreA, terrainAware ? safeSeaY - 0.8 : safeWallBottomY);
            }
            if (cursor >= quads.length) {
                phase = 'collar-normals';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'collar-normals') {
            const total = Math.floor(collarPositions.length / 9);
            const end = Math.min(total, cursor + safeTrianglesPerStep);
            computeFlatNormalsRange(collarPositions, collarNormals, cursor, end);
            cursor = end;
            if (cursor >= total) {
                phase = 'wall-normals';
                cursor = 0;
            }
            return 'more';
        }

        if (phase === 'wall-normals') {
            const total = Math.floor(wallPositions.length / 9);
            const end = Math.min(total, cursor + safeTrianglesPerStep);
            computeFlatNormalsRange(wallPositions, wallNormals, cursor, end);
            cursor = end;
            if (cursor >= total) {
                phase = 'done';
                outcome = {
                    status: 'ready',
                    originX, originZ,
                    collarPositions,
                    collarNormals,
                    collarUvs,
                    wallPositions,
                    wallNormals,
                };
                return 'done';
            }
            return 'more';
        }

        throw new Error(`Unknown coast-dressing phase: ${phase}`);
    }

    return {
        step,
        phaseLabel: () => phase,
        result: () => outcome,
        cancel() {
            if (phase === 'done') return;
            phase = 'done';
            outcome = { status: 'cancelled' };
            collarPositions = null;
            collarNormals = null;
            collarUvs = null;
            wallPositions = null;
            wallNormals = null;
        },
    };
}
