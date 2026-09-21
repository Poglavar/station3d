// Tracks when every aggregate bucket needed by a streamed tile has actually
// published. Dependent layers can wait on tile visibility rather than merely
// on source-data arrival, which prevents readers from outrunning stencil
// writers assembled on a later frame.

export function createTilePublicationTracker() {
    const readyTiles = new Set();
    // First-ready is intentionally sticky for dependent visual layers, but a
    // campaign loading gate needs the stronger answer: no newer generation is
    // queued or waiting for an aggregate upload. Track that independently.
    const currentTiles = new Set();
    const pendingBucketsByTile = new Map();
    const tilesByPendingBucket = new Map();
    const listenersByTile = new Map();

    function removePendingTile(tileKey) {
        const pending = pendingBucketsByTile.get(tileKey);
        if (!pending) return;
        for (const bucketKey of pending) {
            const tiles = tilesByPendingBucket.get(bucketKey);
            if (!tiles) continue;
            tiles.delete(tileKey);
            if (tiles.size === 0) tilesByPendingBucket.delete(bucketKey);
        }
        pendingBucketsByTile.delete(tileKey);
    }

    function markTileReady(tileKey) {
        const key = String(tileKey);
        removePendingTile(key);
        currentTiles.add(key);
        if (readyTiles.has(key)) return;
        readyTiles.add(key);
        const listeners = listenersByTile.get(key);
        listenersByTile.delete(key);
        for (const listener of listeners || []) listener(key);
    }

    function awaitBuckets(tileKey, bucketKeys) {
        const key = String(tileKey);
        currentTiles.delete(key);
        removePendingTile(key);
        const pending = new Set(
            Array.from(bucketKeys || [], bucketKey => String(bucketKey)),
        );
        if (pending.size === 0) {
            markTileReady(key);
            return;
        }
        pendingBucketsByTile.set(key, pending);
        for (const bucketKey of pending) {
            let tiles = tilesByPendingBucket.get(bucketKey);
            if (!tiles) {
                tiles = new Set();
                tilesByPendingBucket.set(bucketKey, tiles);
            }
            tiles.add(key);
        }
    }

    function markPending(tileKey) {
        currentTiles.delete(String(tileKey));
    }

    function markBucketReady(bucketKey) {
        const bucket = String(bucketKey);
        const tileKeys = [...(tilesByPendingBucket.get(bucket) || [])];
        tilesByPendingBucket.delete(bucket);
        for (const tileKey of tileKeys) {
            const pending = pendingBucketsByTile.get(tileKey);
            if (!pending) continue;
            pending.delete(bucket);
            if (pending.size === 0) markTileReady(tileKey);
        }
    }

    function whenReady(tileKey, listener) {
        const key = String(tileKey);
        if (readyTiles.has(key)) {
            listener(key);
            return () => {};
        }
        let listeners = listenersByTile.get(key);
        if (!listeners) {
            listeners = new Set();
            listenersByTile.set(key, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = listenersByTile.get(key);
            if (!current) return;
            current.delete(listener);
            if (current.size === 0) listenersByTile.delete(key);
        };
    }

    function forget(tileKey) {
        const key = String(tileKey);
        readyTiles.delete(key);
        currentTiles.delete(key);
        removePendingTile(key);
        listenersByTile.delete(key);
    }

    function clear() {
        readyTiles.clear();
        currentTiles.clear();
        pendingBucketsByTile.clear();
        tilesByPendingBucket.clear();
        listenersByTile.clear();
    }

    return {
        awaitBuckets,
        clear,
        forget,
        isCurrent: tileKey => currentTiles.has(String(tileKey)),
        isReady: tileKey => readyTiles.has(String(tileKey)),
        markPending,
        markBucketReady,
        whenReady,
    };
}
