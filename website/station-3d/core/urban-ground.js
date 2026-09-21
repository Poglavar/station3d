// Normalises per-location urban-ground tuning, projects streamed building
// outlines, and stages the injected-canvas raster pass used by terrain.

function finiteOr(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeUrbanGroundConfig(config) {
    if (!config) return null;
    return {
        coreRadiusM: Math.max(0, finiteOr(config.coreRadiusM, 14)),
        blendRadiusM: Math.max(1, finiteOr(config.blendRadiusM, 18)),
        maskHalfSizeM: Math.max(100, finiteOr(config.maskHalfSizeM, 320)),
        maskSizePx: Math.max(64, Math.min(2048, Math.round(finiteOr(config.maskSizePx, 512)))),
        refreshMoveM: Math.max(20, finiteOr(config.refreshMoveM, 80)),
    };
}

// The building outlines the ground mask rasterises, in local metres.
//
// A feature's `geometry` is NOT usable for this when it is a LOD2 mesh: a mesh's
// MultiPolygon parts are FACES — walls and roof — so walking them yields ~168
// near-degenerate wall slivers per building instead of one outline. That is both
// wrong (it paints wall quads, not the building's plan) and ruinous: on one
// dense 800 m tile it turned 2,311 buildings into 388,008 rings, and filling and
// stroking those into the 512 px mask cost 82 ms PER FRAME in the terrain hook —
// 60 fps down to 7, while drawing FEWER triangles than before.
//
// So the SERVER sends the ground outline as properties.footprint (one polygon
// per building, from the survey's own 2D column) and it is preferred whenever
// present. Nothing is derived here: a footprint endpoint's `geometry` already IS
// the outline, which is why the fallback stays correct for those.
const DEFAULT_PROJECTION_WORK_CHUNK = 256;
const DEFAULT_PATH_WORK_CHUNK = 256;

function positiveIntegerOr(value, fallback) {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Projection is immutable session work: once a streamed building tile arrives,
// its OSM/GDI coordinates cannot change. Keep bounds beside each projected ring
// so every later moving-window mask can reject off-screen footprints without
// walking their coordinates again. The generator yields by generic work count,
// never by feature identity or geometry size.
export function* collectProjectedBuildingOuterRingRecordsCooperative(
    features,
    projectLonLat,
    { workChunkSize = DEFAULT_PROJECTION_WORK_CHUNK } = {},
) {
    if (typeof projectLonLat !== 'function') return [];
    const chunkSize = positiveIntegerOr(workChunkSize, DEFAULT_PROJECTION_WORK_CHUNK);
    const projectedRings = [];
    let workSinceYield = 0;
    for (const feature of features || []) {
        workSinceYield += 1;
        if (workSinceYield >= chunkSize) {
            workSinceYield = 0;
            yield { phase: 'project' };
        }
        const geometry = feature?.properties?.footprint || feature?.geometry;
        const polygons = geometry?.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon'
                ? geometry.coordinates
                : [];
        for (const polygon of polygons) {
            workSinceYield += 1;
            if (workSinceYield >= chunkSize) {
                workSinceYield = 0;
                yield { phase: 'project' };
            }
            const outer = Array.isArray(polygon) ? polygon[0] : null;
            if (!Array.isArray(outer) || outer.length < 3) continue;
            const points = [];
            const bounds = {
                minX: Infinity,
                minZ: Infinity,
                maxX: -Infinity,
                maxZ: -Infinity,
            };
            for (const coordinate of outer) {
                workSinceYield += 1;
                if (workSinceYield >= chunkSize) {
                    workSinceYield = 0;
                    yield { phase: 'project' };
                }
                const lon = Number(coordinate?.[0]);
                const lat = Number(coordinate?.[1]);
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
                const projected = projectLonLat(lon, lat);
                const x = Number(projected?.x);
                const z = Number(projected?.z);
                if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
                points.push({ x, z });
                bounds.minX = Math.min(bounds.minX, x);
                bounds.minZ = Math.min(bounds.minZ, z);
                bounds.maxX = Math.max(bounds.maxX, x);
                bounds.maxZ = Math.max(bounds.maxZ, z);
            }
            if (points.length >= 3) projectedRings.push({ points, bounds });
        }
    }
    return projectedRings;
}

export function* collectProjectedBuildingOuterRingsCooperative(
    features,
    projectLonLat,
    options,
) {
    const iterator = collectProjectedBuildingOuterRingRecordsCooperative(
        features,
        projectLonLat,
        options,
    );
    let next = iterator.next();
    while (!next.done) {
        yield next.value;
        next = iterator.next();
    }
    return next.value.map(record => record.points);
}

export function collectProjectedBuildingOuterRings(features, projectLonLat) {
    const iterator = collectProjectedBuildingOuterRingsCooperative(features, projectLonLat);
    let next = iterator.next();
    while (!next.done) next = iterator.next();
    return next.value;
}

// A cache owns the one cooperative projection pass for one immutable source
// tile. Abandoning a stale raster generation does not throw that work away: a
// replacement generation resumes this same cache and all later masks reuse it.
export function createProjectedBuildingRingCache(features, projectLonLat, options) {
    let iterator = collectProjectedBuildingOuterRingRecordsCooperative(
        Array.isArray(features) ? features : [],
        projectLonLat,
        options,
    );
    let complete = false;
    let records;
    return {
        step() {
            if (complete) return true;
            const next = iterator.next();
            if (!next.done) return false;
            records = next.value;
            complete = true;
            iterator = null;
            return true;
        },
        get complete() {
            return complete;
        },
        result() {
            return complete ? records : undefined;
        },
    };
}

// Builds into private canvases. Callers keep the previous published texture
// alive until `result()` becomes available and they have verified that this
// task's source revision and centre are still current.
export function createUrbanGroundMaskBuildTask({
    tileCaches = [],
    config,
    centerX = 0,
    centerZ = 0,
    sourceRevision = 0,
    createCanvas = () => document.createElement('canvas'),
    createPath = () => new Path2D(),
    now = defaultNow,
    onPhase = null,
    pathWorkChunkSize = DEFAULT_PATH_WORK_CHUNK,
} = {}) {
    const resolvedConfig = normalizeUrbanGroundConfig(config);
    const caches = Array.from(tileCaches || []);
    const pathChunkSize = positiveIntegerOr(pathWorkChunkSize, DEFAULT_PATH_WORK_CHUNK);
    let complete = false;
    let canvas;

    function* buildSteps() {
        if (!resolvedConfig) return null;
        const ringRecordSets = [];
        for (const cache of caches) {
            if (!cache || typeof cache.step !== 'function') continue;
            while (!cache.step()) yield { phase: 'project' };
            const records = cache.result?.();
            if (Array.isArray(records) && records.length > 0) ringRecordSets.push(records);
            yield { phase: 'collect' };
        }

        const {
            coreRadiusM,
            blendRadiusM,
            maskHalfSizeM,
            maskSizePx,
        } = resolvedConfig;
        const pixelsPerM = maskSizePx / (2 * maskHalfSizeM);
        const reachM = coreRadiusM + blendRadiusM + 4;
        const minMaskX = centerX - maskHalfSizeM - reachM;
        const maxMaskX = centerX + maskHalfSizeM + reachM;
        const minMaskZ = centerZ - maskHalfSizeM - reachM;
        const maxMaskZ = centerZ + maskHalfSizeM + reachM;
        const source = createCanvas();
        source.width = maskSizePx;
        source.height = maskSizePx;
        const sourceContext = source.getContext('2d');
        sourceContext.fillStyle = '#000';
        sourceContext.fillRect(0, 0, maskSizePx, maskSizePx);
        sourceContext.fillStyle = '#fff';
        sourceContext.strokeStyle = '#fff';
        sourceContext.lineJoin = 'round';
        sourceContext.lineCap = 'round';
        sourceContext.lineWidth = coreRadiusM * 2 * pixelsPerM;
        yield { phase: 'source-init' };

        const toPixelX = x => (x - centerX + maskHalfSizeM) * pixelsPerM;
        const toPixelZ = z => (z - centerZ + maskHalfSizeM) * pixelsPerM;
        let drawn = 0;
        let recordsSinceYield = 0;
        for (const ringRecords of ringRecordSets) {
            for (const record of ringRecords) {
                recordsSinceYield += 1;
                if (recordsSinceYield >= pathChunkSize) {
                    recordsSinceYield = 0;
                    yield { phase: 'cull' };
                }
                const points = record?.points;
                const bounds = record?.bounds;
                if (!Array.isArray(points) || points.length < 3 || !bounds) continue;
                if (bounds.maxX < minMaskX
                    || bounds.minX > maxMaskX
                    || bounds.maxZ < minMaskZ
                    || bounds.minZ > maxMaskZ) continue;
                const path = createPath();
                path.moveTo(toPixelX(points[0].x), toPixelZ(points[0].z));
                let pathWork = 1;
                for (let index = 1; index < points.length; index++) {
                    path.lineTo(toPixelX(points[index].x), toPixelZ(points[index].z));
                    pathWork += 1;
                    if (pathWork >= pathChunkSize) {
                        pathWork = 0;
                        yield { phase: 'path' };
                    }
                }
                path.closePath();
                sourceContext.fill(path);
                yield { phase: 'fill' };
                if (coreRadiusM > 0) {
                    sourceContext.stroke(path);
                    yield { phase: 'stroke' };
                }
                drawn += 1;
            }
            if (recordsSinceYield > 0) {
                recordsSinceYield = 0;
                yield { phase: 'cull' };
            }
        }
        if (drawn === 0) return null;

        canvas = createCanvas();
        canvas.width = maskSizePx;
        canvas.height = maskSizePx;
        const context = canvas.getContext('2d');
        context.fillStyle = '#000';
        context.fillRect(0, 0, maskSizePx, maskSizePx);
        context.filter = `blur(${Math.max(1, blendRadiusM * pixelsPerM).toFixed(2)}px)`;
        context.drawImage(source, 0, 0);
        context.filter = 'none';
        yield { phase: 'blur' };
        return canvas;
    }

    const iterator = buildSteps();
    return {
        sourceRevision,
        centerX,
        centerZ,
        step(budgetMs = 2) {
            if (complete) return true;
            const deadline = Number(now()) + Math.max(0.1, Number(budgetMs) || 0);
            do {
                const startedAtMs = Number(now());
                const next = iterator.next();
                const elapsedMs = Math.max(0, Number(now()) - startedAtMs);
                if (typeof onPhase === 'function') {
                    onPhase({
                        phase: next.done ? 'complete' : String(next.value?.phase || 'build'),
                        ms: elapsedMs,
                    });
                }
                if (next.done) {
                    canvas = next.value;
                    complete = true;
                    return true;
                }
            } while (Number(now()) < deadline);
            return false;
        },
        result() {
            return complete ? canvas : undefined;
        },
    };
}

export function urbanGroundMaskBuildIsCurrent(
    task,
    sourceRevision,
    centerX,
    centerZ,
    refreshMoveM,
) {
    if (!task || task.sourceRevision !== sourceRevision) return false;
    return Math.hypot(centerX - task.centerX, centerZ - task.centerZ)
        < Math.max(0, Number(refreshMoveM) || 0);
}
