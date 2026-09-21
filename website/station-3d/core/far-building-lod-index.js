// A whole footprint can occur in several coarse tiles. Every published copy
// must follow detailed ownership, including while two generations overlap.
export function createFarBuildingLodIndex({ isDetailed, isDetailedTile }) {
    const byObject = new Map(), byTile = new Map();
    const visible = ref => !(ref.objectId != null && isDetailed(ref.objectId))
        && !(ref.nearKey != null && isDetailedTile(ref.nearKey));
    const sync = ref => ref.batch.setVisibleAt(ref.instanceId, visible(ref));
    function add(index, key, ref) {
        if (key == null) return;
        let refs = index.get(key);
        if (!refs) { refs = new Set(); index.set(key, refs); }
        refs.add(ref);
    }
    function remove(index, key, ref) {
        const refs = index.get(key);
        refs?.delete(ref);
        if (refs?.size === 0) index.delete(key);
    }
    return {
        visible,
        register(ref) {
            // Ownership may have changed during detached compilation/prewarm.
            sync(ref);
            add(byObject, ref.objectId, ref);
            add(byTile, ref.nearKey, ref);
        },
        unregister(ref) {
            // Retiring a predecessor must not remove its successor or neighbor.
            remove(byObject, ref.objectId, ref);
            remove(byTile, ref.nearKey, ref);
        },
        syncObject(objectId) { for (const ref of byObject.get(objectId) || []) sync(ref); },
        syncTile(tileKey) { for (const ref of byTile.get(tileKey) || []) sync(ref); },
        clear() { byObject.clear(); byTile.clear(); },
    };
}
