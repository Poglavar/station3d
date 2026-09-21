// Pure close-facade LOD policy. Rendering stays in world/buildings.js; keeping
// distance selection and texture sizing here makes the switching contract
// headless-testable without a DOM, canvas, or three.js renderer.

import { createMutableBoundsGrid } from './bounds-grid.js';

export const CLOSE_FACADE_ENTER_M = 28;
export const CLOSE_FACADE_EXIT_M = 40;
// The ordinary atlas overlay remains visible under this optional high-resolution
// copy. A late Zagreb tram window filled the old 24-owner cap and spent 24
// additional colour draws on facades inside a 28 m circle; the eight nearest
// owners cover every facade a street-level camera can inspect at once while
// leaving enough draw headroom for streamed civil geometry.
export const CLOSE_FACADE_MAX_OWNERS = 8;
export const CLOSE_FACADE_TARGET_SCALE = 2;
// Canvas allocation/rasterization is indivisible on the main thread. A former
// 2 MP limit (per diffuse/emissive map) produced a measured 111 ms moving hook
// and up to 16 MB of raw RGBA for one close facade. The base overlay remains
// visible underneath, so cap this optional enhancement to a frame-sized upload.
export const CLOSE_FACADE_MAX_TEXTURE_DIMENSION_PX = 2048;
export const CLOSE_FACADE_MAX_TEXTURE_PIXELS = 256_000;

export function distanceSqToFacadeBounds(bounds, x, z) {
    if (!bounds || !Number.isFinite(x) || !Number.isFinite(z)) return Infinity;
    const dx = x < bounds.minX ? bounds.minX - x
        : x > bounds.maxX ? x - bounds.maxX
        : 0;
    const dz = z < bounds.minZ ? bounds.minZ - z
        : z > bounds.maxZ ? z - bounds.maxZ
        : 0;
    return dx * dx + dz * dz;
}

function closeFacadeSelectionRadii(options = {}) {
    const enterM = Number(options.enterM) || CLOSE_FACADE_ENTER_M;
    return {
        enterM,
        exitM: Math.max(enterM, Number(options.exitM) || CLOSE_FACADE_EXIT_M),
    };
}

// `records` is any iterable of [key, { bounds }]. Active records use the wider
// exit radius, which prevents rapid add/remove churn around the threshold.
export function selectCloseFacadeRecords(records, activeKeys, x, z, options = {}) {
    const { enterM, exitM } = closeFacadeSelectionRadii(options);
    const maxOwners = Number.isFinite(options.maxOwners)
        ? Math.max(0, Math.floor(options.maxOwners)) : CLOSE_FACADE_MAX_OWNERS;
    if (maxOwners === 0) return [];
    const selected = [];
    for (const [key, record] of records || []) {
        const active = !!activeKeys?.has(key);
        const limit = active ? exitM : enterM;
        const distanceSq = distanceSqToFacadeBounds(record?.bounds, x, z);
        if (distanceSq <= limit * limit) selected.push({ key, record, distanceSq });
    }
    selected.sort((a, b) => a.distanceSq - b.distanceSq || String(a.key).localeCompare(String(b.key)));
    return selected.slice(0, maxOwners);
}

// Streamed facade records are immutable after publication but arrive and leave
// with building tiles. Keep their authoritative Map and spatial membership in
// one object so a close-LOD query visits only the exit-radius neighborhood,
// while passage repaint can still iterate every currently loaded record.
export function createCloseFacadeRecordIndex({ cellM = CLOSE_FACADE_EXIT_M } = {}) {
    const records = new Map();
    const spatial = createMutableBoundsGrid({
        cellM,
        boundsOf: entry => entry?.record?.bounds,
    });
    let lastCandidateCount = 0;
    const api = {
        set(key, record) {
            records.set(key, record);
            spatial.set(key, { key, record });
            return api;
        },
        get: key => records.get(key),
        has: key => records.has(key),
        delete(key) {
            const removed = records.delete(key);
            spatial.delete(key);
            return removed;
        },
        clear() {
            records.clear();
            spatial.clear();
            lastCandidateCount = 0;
        },
        values: () => records.values(),
        entries: () => records.entries(),
        [Symbol.iterator]: () => records[Symbol.iterator](),
        select(activeKeys, x, z, options = {}) {
            if (!Number.isFinite(x) || !Number.isFinite(z)) {
                lastCandidateCount = 0;
                return [];
            }
            const { exitM } = closeFacadeSelectionRadii(options);
            const candidates = spatial.candidatesInBox(
                x - exitM,
                z - exitM,
                x + exitM,
                z + exitM,
            );
            lastCandidateCount = candidates.length;
            return selectCloseFacadeRecords(
                candidates.map(entry => [entry.key, entry.record]),
                activeKeys,
                x,
                z,
                options,
            );
        },
        stats() {
            return {
                records: records.size,
                candidates: lastCandidateCount,
                ...spatial.stats(),
            };
        },
    };
    return api;
}

// Two-axis 2x is the target, but very tall/wide facades are constrained both
// by common mobile max-texture sizes and by a per-map texel budget.
export function closeFacadeTextureScale(widthPx, heightPx, options = {}) {
    const width = Number(widthPx);
    const height = Number(heightPx);
    if (!(width > 0) || !(height > 0)) return 1;
    const target = Math.max(1, Number(options.targetScale) || CLOSE_FACADE_TARGET_SCALE);
    const maxDimension = Math.max(1, Number(options.maxDimensionPx)
        || CLOSE_FACADE_MAX_TEXTURE_DIMENSION_PX);
    const maxPixels = Math.max(1, Number(options.maxPixels)
        || CLOSE_FACADE_MAX_TEXTURE_PIXELS);
    return Math.max(1, Math.min(
        target,
        maxDimension / width,
        maxDimension / height,
        Math.sqrt(maxPixels / (width * height)),
    ));
}
