// Coordinates the level-of-detail handoff between the near detailed building
// layer (buildings.js) and the far LOD1 layer (buildings-far.js) so exactly one
// representation of a given GDI object_id ever draws. The near layer reports each
// building it has built in full detail; the far layer hides its cheap extruded
// box for those object_ids and shows it again when the detailed tile is evicted.
// Keyed on object_id, which both layers carry, so the swap is exact — no radius
// line, no z-fighting, no double geometry in the overlap band.
//
// Pure, DOM-free, three.js-free: the arbitration is unit-testable headless.

import { tileIndex } from '../core/tile-stream.js';

const detailedIds = new Set();
const listeners = new Set();   // (objectId: number, isDetailed: boolean) => void

function notify(objectId, isDetailed) {
    for (const fn of listeners) {
        try {
            fn(objectId, isDetailed);
        } catch (err) {
            console.warn('[building-lod-registry] listener failed:', err);
        }
    }
}

// Report that the detailed layer has built (true) or dropped (false) object_id.
// A no-op — and no notification — when the state is already what is claimed, so
// the far layer is never toggled redundantly.
export function setDetailed(objectId, isDetailed) {
    if (objectId == null) return;
    const had = detailedIds.has(objectId);
    if (isDetailed === had) return;
    if (isDetailed) detailedIds.add(objectId);
    else detailedIds.delete(objectId);
    notify(objectId, isDetailed);
}

export function isDetailed(objectId) {
    return detailedIds.has(objectId);
}

// Subscribe to detailed on/off transitions. Returns an unsubscribe function.
export function onDetailedChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// ── Region tracking ─────────────────────────────────────────────────────────
// Tile keys (the detailed layer's 200 m grid) whose detailed build has FULLY
// completed. Inside such a tile the far layer hides every prism — including
// buildings that have no detailed model at all: a lone LOD1 box between
// detailed neighbours reads as broken, while an empty lot reads as "not
// modelled". Keyed on build COMPLETION, never on tile fetch, so there is no
// blink where an area briefly has neither representation.
const detailedTiles = new Set();
const tileListeners = new Set();   // (tileKey: string, isBuilt: boolean) => void

function notifyTile(tileKey, isBuilt) {
    for (const fn of tileListeners) {
        try {
            fn(tileKey, isBuilt);
        } catch (err) {
            console.warn('[building-lod-registry] tile listener failed:', err);
        }
    }
}

export function setDetailedTile(tileKey, isBuilt) {
    if (tileKey == null) return;
    const had = detailedTiles.has(tileKey);
    if (isBuilt === had) return;
    if (isBuilt) detailedTiles.add(tileKey);
    else detailedTiles.delete(tileKey);
    notifyTile(tileKey, isBuilt);
}

// Publish one complete detailed-tile generation. Membership is committed in
// full BEFORE any listener runs, so a far-layer callback can never observe the
// half-transition where one object has hidden its prism but the tile's detailed
// geometry is not yet authoritative. `replacedObjectIds` are the previous
// generation retained on screen while the replacement was being constructed.
export function publishDetailedTile(
    tileKey,
    objectIds = [],
    replacedObjectIds = [],
) {
    if (tileKey == null) return;
    const key = String(tileKey);
    const nextIds = new Set(
        Array.from(objectIds || []).filter(objectId => objectId != null),
    );
    const previousIds = new Set(
        Array.from(replacedObjectIds || []).filter(objectId => objectId != null),
    );
    const added = [];
    const removed = [];

    for (const objectId of nextIds) {
        if (detailedIds.has(objectId)) continue;
        detailedIds.add(objectId);
        added.push(objectId);
    }
    const tileChanged = !detailedTiles.has(key);
    detailedTiles.add(key);
    for (const objectId of previousIds) {
        if (nextIds.has(objectId) || !detailedIds.delete(objectId)) continue;
        removed.push(objectId);
    }

    // All callbacks now read the final state. Additions first are useful to
    // exact-id listeners; the tile event then covers far-only prisms; removals
    // last cannot re-show anything inside the now-detailed tile.
    for (const objectId of added) notify(objectId, true);
    if (tileChanged) notifyTile(key, true);
    for (const objectId of removed) notify(objectId, false);
}

export function isDetailedTile(tileKey) {
    return detailedTiles.has(tileKey);
}

export function isDetailedTileAtLocal(localX, localZ, tileM) {
    const x = Number(localX);
    const z = Number(localZ);
    const sizeM = Number(tileM);
    if (!Number.isFinite(x) || !Number.isFinite(z)
        || !Number.isFinite(sizeM) || sizeM <= 0) return false;
    return isDetailedTile(`${tileIndex(x, sizeM)}_${tileIndex(z, sizeM)}`);
}

// Subscribe to detailed-tile built/dropped transitions. Returns unsubscribe.
export function onDetailedTileChange(fn) {
    tileListeners.add(fn);
    return () => tileListeners.delete(fn);
}

// The detailed layer cleared everything (session teardown / clearBuildings):
// every building is no longer detailed, so re-show them all in the far layer.
export function resetDetailed() {
    if (detailedIds.size > 0) {
        const cleared = [...detailedIds];
        detailedIds.clear();
        for (const objectId of cleared) notify(objectId, false);
    }
    if (detailedTiles.size > 0) {
        const clearedTiles = [...detailedTiles];
        detailedTiles.clear();
        for (const tileKey of clearedTiles) notifyTile(tileKey, false);
    }
}

// Test-only: drop all listeners and state so cases start from a clean slate.
export function _resetForTest() {
    detailedIds.clear();
    listeners.clear();
    detailedTiles.clear();
    tileListeners.clear();
}
