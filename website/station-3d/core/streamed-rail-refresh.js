export const DEFAULT_STREAMED_RAIL_REFRESH_POLICY = Object.freeze({
    quietMs: 250,
    minIntervalMs: 1_000,
    firstPreviewMs: 350,
    maxDeferredMs: 5_000,
});

function observerTileKey(localX, localZ, tileM) {
    const safeTileM = Math.max(1, Number(tileM) || 200);
    return {
        tx: Math.floor((Number(localX) || 0) / safeTileM),
        tz: Math.floor((Number(localZ) || 0) / safeTileM),
    };
}

function observerRingContains(tileKey, localX, localZ, { tileM = 200, ring = 1 } = {}) {
    const match = /^(-?\d+)_(-?\d+)$/.exec(String(tileKey || ''));
    if (!match) return false;
    const { tx, tz } = observerTileKey(localX, localZ, tileM);
    const safeRing = Math.max(0, Math.floor(Number(ring) || 0));
    return Math.abs(Number(match[1]) - tx) <= safeRing
        && Math.abs(Number(match[2]) - tz) <= safeRing;
}

// Rail publication is governed by the observer's immediate support ring, not
// by the shared road source's country-scale look-ahead corridor. An empty tile
// still counts as delivered: knowing that it contains no rail is just as
// important as receiving a tile that does.
export function streamedRailObserverTilesSettled(
    deliveredTileKeys,
    localX,
    localZ,
    { tileM = 200, ring = 1 } = {},
) {
    const delivered = deliveredTileKeys instanceof Set
        ? deliveredTileKeys
        : new Set(deliveredTileKeys || []);
    const { tx, tz } = observerTileKey(localX, localZ, tileM);
    const safeRing = Math.max(0, Math.floor(Number(ring) || 0));
    for (let dz = -safeRing; dz <= safeRing; dz += 1) {
        for (let dx = -safeRing; dx <= safeRing; dx += 1) {
            if (!delivered.has(`${tx + dx}_${tz + dz}`)) return false;
        }
    }
    return true;
}

export function streamedRailChangedNearObserver(
    changedTileKeys,
    localX,
    localZ,
    options = {},
) {
    for (const tileKey of changedTileKeys || []) {
        if (observerRingContains(tileKey, localX, localZ, options)) return true;
    }
    return false;
}

// Tile payloads arrive in short bursts and the same long OSM railway is often
// repeated by several adjacent road tiles. Rebuilding a country-scale sweep on
// every individual delivery adds no visible information; refresh after the
// burst becomes quiet, while retaining a hard ceiling for a continuously
// moving observer.
export function streamedRailRefreshDue({
    nowMs,
    lastChangeMs,
    dirtySinceMs,
    lastAppliedMs,
    hasRenderedFeatures,
    settledForObserver = true,
    sourceSettled = false,
    initialPreviewReady = false,
    observerMovedEnough = false,
    policy = DEFAULT_STREAMED_RAIL_REFRESH_POLICY,
}) {
    const now = Number(nowMs);
    if (!Number.isFinite(now)) return false;

    const lastChange = Number(lastChangeMs);
    const dirtySince = Number(dirtySinceMs);
    const lastApplied = Number(lastAppliedMs);
    if (!Number.isFinite(lastChange) || !Number.isFinite(dirtySince)) return false;

    const quietMs = Math.max(0, Number(policy?.quietMs) || 0);
    const minIntervalMs = Math.max(0, Number(policy?.minIntervalMs) || 0);
    const firstPreviewMs = Math.max(
        quietMs,
        Number(policy?.firstPreviewMs) || quietMs,
    );
    const maxDeferredMs = Math.max(quietMs, Number(policy?.maxDeferredMs) || 0);
    const quiet = now - lastChange >= quietMs;
    const intervalElapsed = !Number.isFinite(lastApplied)
        || now - lastApplied >= minIntervalMs;
    const hitHardCeiling = now - dirtySince >= maxDeferredMs;
    // A retained source window can end inside the observer ring. Once every
    // requested tile has arrived, unrequested ring tiles cannot hold its final
    // generation pending forever.
    const deliverySettled = settledForObserver || sourceSettled;
    // Do not make the observer wait for all nine support tiles before seeing
    // any rail. Once the observer's own tile is delivered, publish a bounded
    // preview; complete-ring delivery replaces it in the normal coalesced
    // refresh. OSM payloads carry whole ways, so this normally already gives a
    // continuous local track while keeping the old hard ceiling for a failed
    // centre request.
    if (!hasRenderedFeatures) {
        return deliverySettled
            || (initialPreviewReady && now - dirtySince >= firstPreviewMs)
            || hitHardCeiling;
    }
    // After the first visible snapshot, a stationary observer gains nothing
    // from rebuilding the whole rail network for every tile in the road
    // source's long look-ahead corridor. Wait for the relevant delivery scope
    // to settle. A moving observer may still publish an intermediate snapshot,
    // but only after crossing a distance gate supplied by the renderer.
    const mayPublishSnapshot = deliverySettled || observerMovedEnough;
    return mayPublishSnapshot
        && ((quiet && intervalElapsed) || (observerMovedEnough && hitHardCeiling));
}
