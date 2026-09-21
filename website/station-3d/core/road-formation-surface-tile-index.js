// Reverse index from engineered road OSM ids to their loaded surface tiles.
// It keeps graph-tile delivery proportional to affected roads instead of all loaded surfaces.

import { roadSurfaceUsesEngineeredFormation } from './road-formation.js';

export function createRoadFormationSurfaceTileIndex() {
    const osmIdsByTileKey = new Map();
    const tileKeysByOsmId = new Map();

    function removeTile(tileKey) {
        const key = String(tileKey);
        const osmIds = osmIdsByTileKey.get(key);
        if (!osmIds) return;
        osmIdsByTileKey.delete(key);
        for (const osmId of osmIds) {
            const tileKeys = tileKeysByOsmId.get(osmId);
            if (!tileKeys) continue;
            tileKeys.delete(key);
            if (tileKeys.size === 0) tileKeysByOsmId.delete(osmId);
        }
    }

    function setTileOsmIds(tileKey, osmIds) {
        const key = String(tileKey);
        removeTile(key);
        const normalizedOsmIds = new Set();
        for (const osmId of osmIds || []) {
            if (osmId != null) normalizedOsmIds.add(String(osmId));
        }
        if (normalizedOsmIds.size === 0) return;
        osmIdsByTileKey.set(key, normalizedOsmIds);
        for (const osmId of normalizedOsmIds) {
            let tileKeys = tileKeysByOsmId.get(osmId);
            if (!tileKeys) {
                tileKeys = new Set();
                tileKeysByOsmId.set(osmId, tileKeys);
            }
            tileKeys.add(key);
        }
    }

    return {
        setTileOsmIds,

        setTile(tileKey, features) {
            const osmIds = new Set();
            for (const feature of Array.isArray(features) ? features : []) {
                const osmId = feature?.properties?.osm_id;
                if (osmId == null || !roadSurfaceUsesEngineeredFormation(feature)) continue;
                osmIds.add(String(osmId));
            }
            setTileOsmIds(tileKey, osmIds);
        },

        removeTile,

        tileKeysForOsmIds(osmIds) {
            const matchingTileKeys = new Set();
            if (!osmIds || typeof osmIds[Symbol.iterator] !== 'function') {
                return matchingTileKeys;
            }
            for (const osmId of osmIds) {
                if (osmId == null) continue;
                for (const tileKey of tileKeysByOsmId.get(String(osmId)) || []) {
                    matchingTileKeys.add(tileKey);
                }
            }
            return matchingTileKeys;
        },

        clear() {
            osmIdsByTileKey.clear();
            tileKeysByOsmId.clear();
        },
    };
}
