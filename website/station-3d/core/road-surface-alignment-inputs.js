// Retains committed per-tile alignment inputs in the original first-wins order.
// Terrain/civil refreshes reuse this set; geometry solving still spans all tiles.

export function roadSurfaceAlignmentFeatureKey(feature) {
    const properties = feature?.properties || {};
    return properties.osm_id != null
        ? [
            String(properties.osm_id),
            String(properties.highway_type || ''),
            String(properties.railway_type || ''),
        ].join(':')
        : JSON.stringify(properties.centerline_geometry || null);
}

export function createRoadSurfaceAlignmentInputs() {
    const tiles = new Map();
    let features = null;
    return {
        // Entries are prepared inside the existing cooperative registration
        // task. Publishing a completed tile is a constant-time ownership swap.
        setTileEntries(tileKey, entries) {
            tiles.set(String(tileKey), entries);
            features = null;
        },
        removeTile(tileKey) {
            if (tiles.delete(String(tileKey))) features = null;
        },
        clear() {
            tiles.clear();
            features = null;
        },
        getFeatures() {
            if (features) return features;
            const unique = new Map();
            for (const entries of tiles.values()) {
                for (const [key, feature] of entries) {
                    if (!unique.has(key)) unique.set(key, feature);
                }
            }
            features = Array.from(unique.values());
            return features;
        },
    };
}
