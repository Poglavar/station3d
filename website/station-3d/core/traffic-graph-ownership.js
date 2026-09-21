export function createTrafficGraphOwnership({ isRetained = () => false, onRetire = () => {} } = {}) {
    const tileSources = new Map();
    const sourceOwners = new Map();
    const pendingRetirement = new Set();

    function claim(tileKey, sourceId) {
        if (tileKey == null || sourceId == null) return false;
        let tileSet = tileSources.get(tileKey);
        if (!tileSet) {
            tileSet = new Set();
            tileSources.set(tileKey, tileSet);
        }
        if (tileSet.has(sourceId)) return false;
        tileSet.add(sourceId);
        let owners = sourceOwners.get(sourceId);
        const firstOwner = !owners || owners.size === 0;
        if (!owners) {
            owners = new Set();
            sourceOwners.set(sourceId, owners);
        }
        owners.add(tileKey);
        pendingRetirement.delete(sourceId);
        return firstOwner;
    }

    function tryRetire(sourceId) {
        const owners = sourceOwners.get(sourceId);
        if (owners && owners.size > 0) return false;
        if (isRetained(sourceId)) {
            pendingRetirement.add(sourceId);
            return false;
        }
        pendingRetirement.delete(sourceId);
        sourceOwners.delete(sourceId);
        onRetire(sourceId);
        return true;
    }

    function releaseTile(tileKey) {
        const sources = tileSources.get(tileKey);
        if (!sources) return 0;
        tileSources.delete(tileKey);
        let retired = 0;
        for (const sourceId of sources) {
            const owners = sourceOwners.get(sourceId);
            owners?.delete(tileKey);
            if (tryRetire(sourceId)) retired += 1;
        }
        return retired;
    }

    function flush() {
        let retired = 0;
        for (const sourceId of [...pendingRetirement]) {
            if (tryRetire(sourceId)) retired += 1;
        }
        return retired;
    }

    return {
        claim,
        releaseTile,
        flush,
        reset() {
            tileSources.clear();
            sourceOwners.clear();
            pendingRetirement.clear();
        },
        snapshot() {
            return {
                tiles: tileSources.size,
                sources: sourceOwners.size,
                pendingRetirement: pendingRetirement.size,
                ownerReferences: [...sourceOwners.values()].reduce((sum, owners) => sum + owners.size, 0),
            };
        },
    };
}
