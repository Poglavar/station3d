// Splits one authored campaign level into bake segments. A segment is a band of
// the level's bounds, the chunk cells that band owns, and the slice of the
// authored drive corridor a bake of that band must wait for.
//
// Why: the Zagreb chase baked as a single unit. Its reveal gate covers a
// corridor 1.9 km long and 900 m wide and the capture writes every chunk in one
// pass, so a bake was one 30-minute browser run that produced a 178 MB archive
// or nothing at all — three times in one night it produced nothing. Segments are
// bounded, restartable pieces: each one waits only for its own stretch of
// corridor and writes its own part file.
//
// Merging is safe because chunk keys are a fixed grid measured from the pack
// anchor (core/campaign-pack-capture-three.js buckets a primitive by the centre
// of its world bounds), so a cell belongs to exactly one segment and two
// segments can never emit the same key. Pure: no DOM, no THREE.

import { finiteOrNull, geoToLocal, localToGeo } from './math.js';

// Each band is captured a little past its seam so a primitive centred in an
// owned cell is never clipped by the band edge; cells outside the band are
// dropped after bucketing, so the overlap cannot duplicate a chunk.
export const SEGMENT_OVERLAP_M = 150;
export const SEGMENT_CORRIDOR_STEP_M = 25;

// "2/5" (1-based) or { index, count }. Absent means "one segment, the whole
// level", which is the historic behaviour.
export function parseCampaignPackSegment(value) {
    if (value === null || value === undefined || value === '') return null;
    let index = null;
    let count = null;
    if (typeof value === 'object') {
        index = finiteOrNull(value.index);
        count = finiteOrNull(value.count);
    } else {
        const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value).trim());
        if (!match) return null;
        index = Number(match[1]);
        count = Number(match[2]);
    }
    if (!Number.isInteger(index) || !Number.isInteger(count)) return null;
    if (count < 1 || index < 1 || index > count) return null;
    return { index, count };
}

function localCorners(bounds, anchorLat, anchorLon) {
    const corners = [
        [bounds.west, bounds.south], [bounds.east, bounds.south],
        [bounds.west, bounds.north], [bounds.east, bounds.north],
    ].map(([lon, lat]) => geoToLocal(lon, lat, anchorLon, anchorLat));
    return {
        minX: Math.min(...corners.map(point => point.x)),
        maxX: Math.max(...corners.map(point => point.x)),
        minZ: Math.min(...corners.map(point => point.z)),
        maxZ: Math.max(...corners.map(point => point.z)),
    };
}

// Contiguous, non-overlapping runs of cell indices, largest remainder first so
// the bands differ by at most one cell.
function cellRuns(minCell, maxCell, count) {
    const total = maxCell - minCell + 1;
    const base = Math.floor(total / count);
    const extra = total % count;
    const runs = [];
    let cursor = minCell;
    for (let i = 0; i < count; i++) {
        const size = Math.max(1, base + (i < extra ? 1 : 0));
        const min = cursor;
        const max = Math.min(maxCell, cursor + size - 1);
        runs.push({ min, max });
        cursor = max + 1;
        if (cursor > maxCell) {
            // Fewer cells than segments: the remaining segments are empty and
            // the caller is told to bake fewer of them.
            for (let j = runs.length; j < count; j++) runs.push(null);
            break;
        }
    }
    return runs.slice(0, count);
}

function resamplePath(path, anchorLat, anchorLon, stepM) {
    const local = path
        .map(point => ({ lat: finiteOrNull(point?.lat), lon: finiteOrNull(point?.lon) }))
        .filter(point => point.lat !== null && point.lon !== null)
        .map(point => ({ ...geoToLocal(point.lon, point.lat, anchorLon, anchorLat) }));
    const points = [];
    for (let i = 1; i < local.length; i++) {
        const from = local[i - 1];
        const to = local[i];
        const distance = Math.hypot(to.x - from.x, to.z - from.z);
        const steps = Math.max(1, Math.ceil(distance / stepM));
        for (let step = i === 1 ? 0 : 1; step <= steps; step++) {
            points.push({
                x: from.x + (to.x - from.x) * step / steps,
                z: from.z + (to.z - from.z) * step / steps,
            });
        }
    }
    return points;
}

/**
 * One segment of a level bake: the cells it owns, the geographic rectangle its
 * capture may include, and the corridor its world build waits for.
 */
export function campaignPackSegmentPlan({
    bounds,
    packAnchor,
    chunkSizeM,
    index,
    count,
    corridorPath = null,
    overlapM = SEGMENT_OVERLAP_M,
} = {}) {
    const anchorLat = finiteOrNull(packAnchor?.lat);
    const anchorLon = finiteOrNull(packAnchor?.lon);
    const cellSize = finiteOrNull(chunkSizeM);
    if (anchorLat === null || anchorLon === null || !bounds || !(cellSize > 0)) return null;
    const parsed = parseCampaignPackSegment({ index, count });
    if (!parsed) return null;
    const rect = localCorners(bounds, anchorLat, anchorLon);
    const axis = (rect.maxX - rect.minX) >= (rect.maxZ - rect.minZ) ? 'x' : 'z';
    const min = axis === 'x' ? rect.minX : rect.minZ;
    const max = axis === 'x' ? rect.maxX : rect.maxZ;
    const runs = cellRuns(Math.floor(min / cellSize), Math.floor(max / cellSize), parsed.count);
    const run = runs[parsed.index - 1];
    if (!run) return null;
    const bandMin = run.min * cellSize;
    const bandMax = (run.max + 1) * cellSize;
    const captureMin = bandMin - overlapM;
    const captureMax = bandMax + overlapM;
    const acrossMin = (axis === 'x' ? rect.minZ : rect.minX) - overlapM;
    const acrossMax = (axis === 'x' ? rect.maxZ : rect.maxX) + overlapM;
    const corner = (along, across) => localToGeo(
        axis === 'x' ? along : across,
        axis === 'x' ? across : along,
        anchorLon,
        anchorLat,
    );
    const a = corner(captureMin, acrossMin);
    const b = corner(captureMax, acrossMax);
    const captureBounds = {
        west: Math.min(a.lon, b.lon),
        east: Math.max(a.lon, b.lon),
        south: Math.min(a.lat, b.lat),
        north: Math.max(a.lat, b.lat),
    };
    let segmentCorridor = null;
    if (Array.isArray(corridorPath) && corridorPath.length >= 2) {
        const kept = resamplePath(corridorPath, anchorLat, anchorLon, SEGMENT_CORRIDOR_STEP_M)
            .filter((point) => {
                const along = axis === 'x' ? point.x : point.z;
                return along >= captureMin && along <= captureMax;
            });
        if (kept.length >= 2) {
            const ends = [kept[0], kept[kept.length - 1]]
                .map(point => localToGeo(point.x, point.z, anchorLon, anchorLat))
                .map(point => ({ lat: point.lat, lon: point.lon }));
            segmentCorridor = ends;
        }
    }
    return Object.freeze({
        index: parsed.index,
        count: parsed.count,
        axis,
        ownedCells: Object.freeze({ axis, min: run.min, max: run.max }),
        captureBounds: Object.freeze(captureBounds),
        corridorPath: segmentCorridor ? Object.freeze(segmentCorridor) : null,
    });
}

// Does a chunk key produced by a capture belong to this segment? Keys are
// `${group}-x${cell}-z${cell}`, where a cell is `p<n>` at or above zero and
// `n<n>` below it (safeCell in core/campaign-pack-capture-three.js).
export function campaignPackSegmentOwnsChunkKey(plan, key) {
    if (!plan?.ownedCells) return true;
    const match = /-x([pn])(\d+)-z([pn])(\d+)$/.exec(String(key || ''));
    if (!match) return false;
    const cell = (sign, digits) => (sign === 'n' ? -Number(digits) : Number(digits));
    const along = plan.ownedCells.axis === 'x'
        ? cell(match[1], match[2])
        : cell(match[3], match[4]);
    return along >= plan.ownedCells.min && along <= plan.ownedCells.max;
}

/**
 * The plan for one band of an authored level, resolved from the authored pack
 * itself. Both bake seams call this so the corridor a segment waits for and the
 * chunk cells it keeps can never disagree: the scene-open override slices
 * `bakeDriveSurfacePreload`, and the capture keeps only the cells named here.
 * Without a segment spec it returns null, which means "the whole level", the
 * behaviour every bake had before segments existed.
 */
export function campaignPackBakeSegmentPlan(campaignWorldPack, segment) {
    const parsed = parseCampaignPackSegment(segment);
    if (!parsed || parsed.count === 1) return null;
    const bake = campaignWorldPack?.bake;
    if (!bake?.visualBounds || !bake?.anchor) return null;
    return campaignPackSegmentPlan({
        bounds: bake.visualBounds,
        packAnchor: bake.anchor,
        chunkSizeM: bake.chunkSizeM,
        index: parsed.index,
        count: parsed.count,
        corridorPath: campaignWorldPack?.bakeDriveSurfacePreload?.path || null,
    });
}

// The corridor a segment's world build waits for: the authored preload with its
// path cut down to this band. A band whose corridor never enters it waits for
// nothing, which is correct — its geometry still streams from the observer.
export function campaignPackSegmentDrivePreload(campaignWorldPack, plan) {
    const authored = campaignWorldPack?.bakeDriveSurfacePreload || null;
    if (!authored || !plan) return authored;
    if (!plan.corridorPath) return null;
    return { ...authored, path: [...plan.corridorPath] };
}
