// Decides which streamed road polygons the shared RoadFormationModel may own
// terrain for. A surface in the formation publishes cut/fill and a terrain
// cutout, and the ground generation demands a rendered road receiver behind
// every cutout, so the formation must not hold a road the scene will not draw.

// features: one road tile's GeoJSON surface features.
// alignment: the vertical-alignment model, or null. A solved alignment that
//   replaces the ordinary surface owns that ground itself unless it explicitly
//   retains the ordinary formation.
// isFeatureMasked: the proposal footprint test that also drops the feature's
//   rendered receiver (roads.js prepareRoadFeature), or null.
export function roadFormationSurfaceFeatures(features, { alignment = null, isFeatureMasked = null } = {}) {
    const list = Array.isArray(features) ? features : [];
    return list.filter((feature) => {
        const osmId = feature?.properties?.osm_id;
        if (alignment
            && alignment.replacesRoadSurfaceForOsmId(osmId)
            && !alignment.retainsRoadFormationForOsmId(osmId)) return false;
        // A proposal replaces the road under its footprint. roads.js renders no
        // receiver for it, so an orphan cut here would make the ground
        // generation fail with ground-backstop-unavailable.
        return !(isFeatureMasked && isFeatureMasked(feature));
    });
}
