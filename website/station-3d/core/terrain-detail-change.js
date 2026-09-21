// Plans moving detail-window changes on the same whole-tile grid used by the
// terrain mesh, so overlapping old/new windows do not invalidate each other.

import { finiteOrNull } from './math.js';

function finiteRect(rect) {
    const normalized = {
        minX: Number(rect?.minX),
        maxX: Number(rect?.maxX),
        minZ: Number(rect?.minZ),
        maxZ: Number(rect?.maxZ),
    };
    return [normalized.minX, normalized.maxX, normalized.minZ, normalized.maxZ]
        .every(Number.isFinite)
        && normalized.maxX > normalized.minX
        && normalized.maxZ > normalized.minZ
        ? normalized
        : null;
}

function finitePoint(point) {
    const x = point?.x;
    const z = point?.z;
    return typeof x === 'number' && Number.isFinite(x)
        && typeof z === 'number' && Number.isFinite(z)
        ? { x, z }
        : null;
}

// Decides whether a camera-centred fine-terrain request is still useful. The
// request itself can take many seconds, so its target—not only the last
// published target—must move with the camera or obsolete work can publish
// after the user has stopped and reopen every terrain-dependent build queue.
export function planTerrainDetailRefresh(state, local, {
    force = false,
    refreshDistanceM = 420,
} = {}) {
    const target = finitePoint(local);
    if (!target) return { action: 'none', distanceM: Infinity };
    const inFlight = !!state?.inFlight;
    const center = finitePoint(inFlight ? state?.inFlightCenter : state?.publishedCenter);
    const distanceM = center
        ? Math.hypot(target.x - center.x, target.z - center.z)
        : Infinity;
    const thresholdM = Math.max(0, Number(refreshDistanceM) || 0);
    if (!force && distanceM < thresholdM) return { action: 'keep', distanceM };
    return {
        action: inFlight ? 'replace' : 'start',
        distanceM,
    };
}

// Whether a moving 1 m window may withhold the 20 m base as evidence inside its
// bounds, and for how long. Where LiDAR exists the base must not be published
// on and re-solved seconds later, but a window that cannot land in time (a fast
// car supersedes it every refreshDistanceM; a failing API never lands one) must
// not leave the road ahead undrawn either. So: a fresh request arms the gate,
// a superseding request never re-arms it, a failure disarms it until the next
// window lands, and every gate expires after maxMs. Pure so the rule is testable.
export const DETAIL_EVIDENCE_GATE_MAX_MS = 8000;

// The allowance shrinks with speed: standing or walking, eight seconds is a
// wait nobody notices; at city driving speed a window seldom lands in time, so
// the gate would only hide the road under the car; at highway speed it is not
// armed at all and the world degrades to publish-then-refine.
export const DETAIL_EVIDENCE_GATE_ALLOWANCE_MS = Object.freeze({
    stationary: DETAIL_EVIDENCE_GATE_MAX_MS,
    slow: DETAIL_EVIDENCE_GATE_MAX_MS,
    transit: 2500,
    fast: 0,
});

export function detailEvidenceGateAllowanceMs(motionState) {
    const value = DETAIL_EVIDENCE_GATE_ALLOWANCE_MS[String(motionState || '')];
    return Number.isFinite(value) ? value : DETAIL_EVIDENCE_GATE_MAX_MS;
}

export function planDetailEvidenceGate({
    action = 'none',
    armed = true,
    pendingSinceMs = null,
    nowMs = 0,
    maxMs = DETAIL_EVIDENCE_GATE_MAX_MS,
} = {}) {
    // null is "no gate", never a timestamp of zero.
    const since = finiteOrNull(pendingSinceMs);
    const now = finiteOrNull(nowMs);
    const allowanceMs = Math.max(0, finiteOrNull(maxMs) ?? DETAIL_EVIDENCE_GATE_MAX_MS);
    const pending = since !== null;
    if (pending && now !== null && now - since >= allowanceMs) {
        return { gate: 'release', reason: 'detail-window-timeout', disarm: true };
    }
    if (action === 'start' && armed !== false && !pending && allowanceMs > 0) return { gate: 'set' };
    return { gate: pending ? 'keep' : 'none' };
}

function tileKey(tileX, tileZ) {
    return `${tileX}_${tileZ}`;
}

export function parseTerrainTileKey(key) {
    const match = /^(-?\d+)_(-?\d+)$/.exec(String(key || ''));
    if (!match) return null;
    return { tileX: Number(match[1]), tileZ: Number(match[2]) };
}

function tileMFor(detail, fallback) {
    const value = Number(detail?.tileM ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function terrainDetailTileKeys(detail, { tileM = null } = {}) {
    const resolvedTileM = tileMFor(detail, tileM);
    if (!resolvedTileM) return new Set();
    const rects = (Array.isArray(detail?.rects) ? detail.rects : [])
        .map(finiteRect)
        .filter(Boolean);
    const keys = new Set();
    const epsilon = 1e-9;
    for (const rect of rects) {
        // Match TerrainReference.isFineTile: a whole tile must fit inside one
        // rect. Overlapping rects contribute a union, never a bounding box.
        const minTileX = Math.ceil(rect.minX / resolvedTileM - epsilon);
        const maxTileX = Math.floor(rect.maxX / resolvedTileM + epsilon) - 1;
        const minTileZ = Math.ceil(rect.minZ / resolvedTileM - epsilon);
        const maxTileZ = Math.floor(rect.maxZ / resolvedTileM + epsilon) - 1;
        for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ++) {
            for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
                keys.add(tileKey(tileX, tileZ));
            }
        }
    }
    return keys;
}

export function terrainDetailTileSurfaceSignature(detail, key, { tileM = null } = {}) {
    const resolvedTileM = tileMFor(detail, tileM);
    if (!resolvedTileM) return 'coarse';
    const fineKeys = terrainDetailTileKeys(detail, { tileM: resolvedTileM });
    if (!fineKeys.has(String(key))) return 'coarse';
    const stepM = Number(detail?.stepM);
    return `fine:${Number.isFinite(stepM) ? stepM : 'unknown'}:${resolvedTileM}`;
}

// A bounded fingerprint of the rendered piecewise-planar surface, not of the
// response envelope. This catches a changed source payload inside an otherwise
// unchanged fine-tile footprint without hashing multi-megabyte grid buffers.
export function sampledTerrainTileSurfaceSignature(reference, key, {
    tileM = 400,
    samplesPerAxis = 9,
    precisionM = 0.01,
} = {}) {
    const tile = parseTerrainTileKey(key);
    const size = Number(tileM);
    const count = Math.max(2, Math.min(33, Math.trunc(Number(samplesPerAxis) || 9)));
    const precision = Math.max(0.001, Number(precisionM) || 0.01);
    if (!tile || !Number.isFinite(size) || size <= 0
        || typeof reference?.sceneYAtLocal !== 'function') return null;
    let hash = 2166136261;
    for (let row = 0; row < count; row++) {
        const z = (tile.tileZ + row / (count - 1)) * size;
        for (let column = 0; column < count; column++) {
            const x = (tile.tileX + column / (count - 1)) * size;
            const y = Number(reference.sceneYAtLocal(x, z));
            const quantized = Number.isFinite(y) ? Math.round(y / precision) : 0x7fffffff;
            hash ^= quantized;
            hash = Math.imul(hash, 16777619) >>> 0;
        }
    }
    return `${count}:${precision}:${hash.toString(16).padStart(8, '0')}`;
}

export function terrainTileBoundsForKeys(keys, tileM) {
    const size = Number(tileM);
    if (!Number.isFinite(size) || size <= 0) return [];
    return [...new Set(keys || [])].map(parseTerrainTileKey).filter(Boolean).map(({ tileX, tileZ }) => ({
        minX: tileX * size,
        minZ: tileZ * size,
        maxX: (tileX + 1) * size,
        maxZ: (tileZ + 1) * size,
    }));
}

export function planTerrainDetailChange(previousDetail, nextDetail, {
    tileM = null,
    previousSurfaceSignature = null,
    nextSurfaceSignature = null,
} = {}) {
    const resolvedTileM = tileMFor(nextDetail, tileMFor(previousDetail, tileM));
    if (!resolvedTileM) {
        return {
            changedTileKeys: [],
            changedBounds: [],
            previousFineTileCount: 0,
            nextFineTileCount: 0,
            noOp: true,
        };
    }
    const previousKeys = terrainDetailTileKeys(previousDetail, { tileM: resolvedTileM });
    const nextKeys = terrainDetailTileKeys(nextDetail, { tileM: resolvedTileM });
    const candidates = new Set([...previousKeys, ...nextKeys]);
    const changedTileKeys = [...candidates].filter((key) => {
        const previousTopology = terrainDetailTileSurfaceSignature(
            previousDetail,
            key,
            { tileM: resolvedTileM },
        );
        const nextTopology = terrainDetailTileSurfaceSignature(
            nextDetail,
            key,
            { tileM: resolvedTileM },
        );
        if (previousTopology !== nextTopology) return true;
        if (previousTopology === 'coarse'
            || typeof previousSurfaceSignature !== 'function'
            || typeof nextSurfaceSignature !== 'function') return false;
        return previousSurfaceSignature(key) !== nextSurfaceSignature(key);
    }).sort((left, right) => {
        const a = parseTerrainTileKey(left);
        const b = parseTerrainTileKey(right);
        return a.tileZ - b.tileZ || a.tileX - b.tileX;
    });
    return {
        changedTileKeys,
        changedBounds: terrainTileBoundsForKeys(changedTileKeys, resolvedTileM),
        previousFineTileCount: previousKeys.size,
        nextFineTileCount: nextKeys.size,
        noOp: changedTileKeys.length === 0,
    };
}

// Which earlier detail windows stay composed beside a newly published one.
// Dropping the window behind the player put every tile it covered back on the
// coarse base and rebuilt them, with the roads, kerbs and buildings on them,
// on every 420 m of travel — the sweeping 1 m/20 m seam. Kept windows are the
// most recent ones whose centre is still within maxDistanceM of the new
// centre, newest first, at most maxRetained; memory is bounded by that count
// (about 4.5 MB of heights and provenance per window). Pure so the policy is
// testable without a grid.
export function retainTrailingDetailWindows(candidates, {
    nextCenter,
    maxRetained = 2,
    maxDistanceM = Infinity,
} = {}) {
    const center = finitePoint(nextCenter);
    const keep = Math.max(0, Math.trunc(Number(maxRetained) || 0));
    const reach = Number(maxDistanceM);
    if (!center || keep === 0) return [];
    return (Array.isArray(candidates) ? candidates : [])
        .filter(entry => {
            const at = finitePoint({ x: entry?.centerX, z: entry?.centerZ });
            if (!at || !entry?.preparedDetail) return false;
            const distanceM = Math.hypot(at.x - center.x, at.z - center.z);
            return distanceM > 0 && (!Number.isFinite(reach) || distanceM <= reach);
        })
        .sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0))
        .slice(0, keep);
}

// One prepared detail for the composite: the new window's grids and rects
// first, then every retained window's, each grid keeping the provenance index
// it was prepared with (a Map entry per grid, null when the window had no
// source boundary), because CompositeTerrainGrid requires one per grid.
export function mergePreparedDetails(current, retained = []) {
    if (!current?.grids?.length || !current.detail) return current || null;
    const grids = [...current.grids];
    const rects = [...(current.detail.rects || [])];
    const sourceBoundaries = new Map(current.sourceBoundaries || []);
    for (const previous of Array.isArray(retained) ? retained : []) {
        for (const grid of previous?.grids || []) {
            if (grids.includes(grid)) continue;
            grids.push(grid);
            sourceBoundaries.set(grid, previous.sourceBoundaries?.get?.(grid) ?? null);
        }
        rects.push(...(previous?.detail?.rects || []));
    }
    return { grids, sourceBoundaries, detail: { ...current.detail, rects } };
}
