// Shared tile/build leases for one road content record. A staged successor holds
// its retained owners until publication, so either tile may evict safely.
export function retireRoadFeatureIfUnused(featureKey, entry, { entries, retire }) {
    if (!entry || entry.tileRefs.size > 0 || entry.pendingRefs > 0) return false;
    if (entries.get(featureKey) !== entry) return false;
    retire(entry);
    entries.delete(featureKey);
    return true;
}

export function releaseRoadTileReferences(tileKey, { entries, tiles, retire }) {
    const keys = tiles.get(tileKey);
    if (!keys) return;
    for (const featureKey of keys) {
        const entry = entries.get(featureKey);
        if (!entry) continue;
        entry.tileRefs.delete(tileKey);
        retireRoadFeatureIfUnused(featureKey, entry, { entries, retire });
    }
    tiles.delete(tileKey);
}

export function holdRoadFeatureForBuild(entry) {
    entry.pendingRefs += 1;
}
export function releaseRoadFeatureBuildHold(entry) {
    if (entry.pendingRefs < 1) throw new Error('Road build hold released twice');
    entry.pendingRefs -= 1;
}
