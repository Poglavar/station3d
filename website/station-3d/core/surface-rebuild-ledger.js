// Durable bounded scheduling for invalidated tile surfaces. Only a committed
// matching revision clears work; cancellation and readiness waits preserve it.
export function createSurfaceRebuildLedger() {
    const pending = new Map();
    function mark(tileKey, revision) {
        if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid surface revision');
        const key = String(tileKey);
        const previous = pending.get(key);
        if (previous && previous.revision >= revision) return false;
        pending.set(key, { revision, requested: previous?.requested ?? null, failed: null });
        return true;
    }
    function publish(tileKey, revision) {
        const key = String(tileKey);
        if (pending.get(key)?.revision !== revision) return false;
        pending.delete(key);
        return true;
    }
    return {
        mark, publish,
        pendingRevision(tileKey) { return pending.get(String(tileKey))?.revision ?? null; },
        isPending(tileKey) { return pending.has(String(tileKey)); },
        consume(tileKey) {
            const revision = pending.get(String(tileKey))?.revision;
            return revision == null ? null : { tileKey: String(tileKey), revision };
        },
        shouldRequest(tileKey) {
            const entry = pending.get(String(tileKey));
            return !!entry && entry.requested !== entry.revision && entry.failed !== entry.revision;
        },
        requested(tileKey) {
            const entry = pending.get(String(tileKey));
            if (!entry) return null;
            entry.requested = entry.revision;
            return entry.revision;
        },
        settled(tileKey, revision, { failed = false } = {}) {
            const entry = pending.get(String(tileKey));
            if (!entry || entry.requested !== revision) return;
            entry.requested = null;
            if (failed && entry.revision === revision) entry.failed = revision;
        },
        // One visited tile per caller frame, including unready/failed entries.
        // Rotating the map avoids an O(n) snapshot and a blocked first tile.
        nextTile() {
            const first = pending.entries().next();
            if (first.done) return null;
            const [key, entry] = first.value;
            pending.delete(key);
            pending.set(key, entry);
            return key;
        },
        forget(tileKey) { pending.delete(String(tileKey)); },
        entries() { return [...pending].map(([tileKey, entry]) => ({ tileKey, ...entry })); },
        clear() { pending.clear(); },
        get size() { return pending.size; },
    };
}

// TerrainReference emits normalized local rectangles. Accept a raw rectangle
// too so fixture/import callers use the same bounded invalidation contract.
export function surfaceChangesFromTerrainEvent(change) {
    const rectangles = Array.isArray(change?.bounds) ? change.bounds : [change?.bounds];
    const bounds = rectangles.filter(rectangle => rectangle
        && ['minX', 'maxX', 'minZ', 'maxZ'].every(key => (
            typeof rectangle[key] === 'number' && Number.isFinite(rectangle[key])
        )) && rectangle.minX < rectangle.maxX && rectangle.minZ < rectangle.maxZ);
    return bounds.length ? { full: false, bounds: bounds.map(rectangle => ({ ...rectangle })) }
        : { full: true, bounds: [] };
}

// Publication adapters acknowledge only after the complete publication succeeds.
// An individual row's commit can still be rolled back by a later dependency.
// A prepared candidate cannot settle an obligation or replace the active mesh.
export function commitSurfaceRebuild({ ledger, tileKey, revision, cancelled, isCurrent, publish }) {
    const pending = ledger.pendingRevision(tileKey);
    if (cancelled || isCurrent?.() === false || (pending !== null && pending !== revision)) return false;
    let committed = false;
    publish(() => {
        committed = true;
        if (revision !== null) ledger.publish(tileKey, revision);
    });
    return committed;
}
