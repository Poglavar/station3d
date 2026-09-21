// Selects streamed road-layer surfaces whose published geometry directly or
// indirectly follows supplied terrain and must be replaced after a terrain revision.

import { roadSurfaceUsesEngineeredFormation } from './road-formation.js';
import { isTunnelPathSurface } from './unmodelled-tunnel-path.js';

function normalized(value) {
    return String(value ?? '').trim().toLowerCase();
}

function renderedByRoadSurfaceLayer(feature) {
    const properties = feature?.properties || {};
    const highway = normalized(properties.highway_type);
    const railway = normalized(properties.railway_type);
    if (railway === 'rail') return false;
    return railway !== 'tram' || highway !== '';
}

export function terrainRevisionRoadOsmIds(features, {
    hasVerticalAlignmentForOsmId = () => false,
} = {}) {
    const osmIds = new Set();
    for (const feature of features || []) {
        const osmId = feature?.properties?.osm_id;
        if (osmId == null
            || !renderedByRoadSurfaceLayer(feature)
            || roadSurfaceUsesEngineeredFormation(feature)) {
            continue;
        }
        // An aligned surface takes its heights from the alignment, not the
        // terrain — except a tunnel path, whose right to show at all is judged
        // against the visible ground and must be re-judged when that ground
        // changes (the LiDAR detail arriving under a coarse first pass).
        if (hasVerticalAlignmentForOsmId(osmId)
            && !isTunnelPathSurface({
                properties: feature.properties,
                type: normalized(feature.properties?.highway_type),
            })) {
            continue;
        }
        osmIds.add(String(osmId));
    }
    return osmIds;
}
