// Consumers may help an unmanaged road build, but a coordinated publication
// owns its compiler exclusively. Retrying a held build within the same frame
// consumes the consumer's whole slice without advancing either dependency.
export function advanceRoadFormationDependency(formation) {
    if (formation?.hasPendingBuild?.() !== true) return 'ready';
    if (typeof formation.stepPendingBuildPreparation !== 'function') return 'defer';
    return formation.stepPendingBuildPreparation() === 'held' ? 'defer' : 'repeat';
}

function boundsTouch(a, b, marginM) {
    return a.minX - marginM <= b.maxX && a.maxX + marginM >= b.minX
        && a.minZ - marginM <= b.maxZ && a.maxZ + marginM >= b.minZ;
}

function finiteBounds(bounds) {
    return bounds && [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)
        ? bounds : null;
}

// Whether a pending road-formation build can move the ground inside `bounds`
// (plus `marginM`, the sampler's reach beside a facade). A coordinated
// publication holds the whole build until its generation publishes, and a
// move triggers a chain of them; waiting for every one froze every building
// tile for the length of the chain (Split Riva, 2026-09-17: 658 buildings
// stood still for 142 s, then 1,335 twenty seconds after the chain ended).
// The published indexes stay readable and consistent while a managed build
// is pending, and a building whose ground did change is re-checked once the
// formation publishes, so only a building the pending change actually
// touches has to wait. A change without bounds (a full invalidation) or a
// model that cannot report its changes keeps the wait: the safe direction.
// A building waits for a pending road change under it, but not for ever:
// past `allowanceMs` (the terrain evidence gate's motion-dependent allowance)
// it builds on the published generation and the ground check refines it once
// the formation publishes. Unbounded, the wait was the whole generation chain
// after a move: at Split four tile builds retried 4,500 times over 110 s while
// the streets stood empty (2026-09-17).
// How long a building may wait for that publication, by motion state. Shorter
// than the terrain evidence gate on purpose: a ground generation takes 18 s at
// the least here, so a long wait almost never meets a publication and only
// empties the street; a double build after the publication is the cheaper
// outcome. Zero at speed, where the tile is soon behind the player anyway.
export const FOUNDATION_FORMATION_WAIT_MS = Object.freeze({
    stationary: 2000,
    slow: 2000,
    transit: 1000,
    fast: 0,
});

export function foundationFormationWaitAllowanceMs(motionState) {
    const value = FOUNDATION_FORMATION_WAIT_MS[String(motionState || '')];
    return Number.isFinite(value) ? value : FOUNDATION_FORMATION_WAIT_MS.stationary;
}

export function roadFormationWaitExpired(startedAtMs, nowMs, allowanceMs) {
    const started = Number(startedAtMs);
    const now = Number(nowMs);
    if (!Number.isFinite(started) || !Number.isFinite(now)) return false;
    return now - started >= Math.max(0, Number(allowanceMs) || 0);
}

export function pendingRoadFormationChangeTouches(formation, bounds, marginM = 0) {
    if (formation?.hasPendingBuild?.() !== true) return false;
    const footprint = finiteBounds(bounds);
    const published = Number(formation.surfaceGeometrySourceRevision);
    if (!footprint || typeof formation.getChangesSince !== 'function'
        || !Number.isInteger(published)) return true;
    const changes = formation.getChangesSince(published);
    if (!changes || changes.full !== false || !Array.isArray(changes.bounds)) return true;
    const margin = Math.max(0, Number(marginM) || 0);
    return changes.bounds.some(change => {
        const rect = finiteBounds(change);
        return !rect || boundsTouch(rect, footprint, margin);
    });
}
