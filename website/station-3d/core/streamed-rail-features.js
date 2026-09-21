// The country-scale road tiles already carry the original OSM railway
// centreline beside each buffered surface polygon. GTA consumes those tiles
// continuously, so reuse that canonical geometry for rails instead of loading
// Zagreb's static tram GeoJSON or issuing a second country-scale request.

const RENDERED_RAILWAY_TYPES = new Set([
    'rail',
    'narrow_gauge',
    'tram',
    'light_rail',
]);

function railwayTypeFor(properties = {}) {
    return String(
        properties.railway_type
        ?? properties.railway
        ?? properties.tags?.railway
        ?? '',
    ).trim().toLowerCase();
}

function validLineString(geometry) {
    return geometry?.type === 'LineString'
        && Array.isArray(geometry.coordinates)
        && geometry.coordinates.length >= 2;
}

export function streamedRailFeatureIdentity(feature) {
    const properties = feature?.properties || {};
    if (properties.railProfileFragment) return String(properties.railProfileFragment);
    const osmId = properties.osm_id ?? properties.osmId;
    if (osmId != null && String(osmId) !== '') return `osm:${String(osmId)}`;
    const railway = railwayTypeFor(properties) || 'rail';
    const coordinates = feature?.geometry?.coordinates || [];
    return `${railway}:${JSON.stringify(coordinates)}`;
}

export function railFeatureFromRoadSurface(feature) {
    const properties = feature?.properties || {};
    const railwayType = railwayTypeFor(properties);
    if (!RENDERED_RAILWAY_TYPES.has(railwayType)) return null;

    // /roads/cab returns a Polygon/MultiPolygon for the paved/ballast footprint
    // and preserves the source LineString here. The rail sweep must follow the
    // centreline; using a polygon ring would draw rails around the bed perimeter.
    const geometry = properties.centerline_geometry;
    if (!validLineString(geometry)) return null;

    const {
        centerline_geometry: _centerlineGeometry,
        ...surfaceProperties
    } = properties;
    const osmId = properties.osm_id ?? properties.osmId ?? null;
    return {
        type: 'Feature',
        geometry,
        properties: {
            ...surfaceProperties,
            railway_type: railwayType,
            ...(osmId == null ? {} : { osm_id: osmId, osmId }),
            tags: {
                ...(properties.tags || {}),
                railway: railwayType,
            },
        },
    };
}

export function railFeaturesFromRoadSurfaces(features) {
    const rails = [];
    for (const feature of features || []) {
        const rail = railFeatureFromRoadSurface(feature);
        if (rail) rails.push(rail);
    }
    return rails;
}

export function mergeStreamedRailFeatureTiles(tileFeatures) {
    const byIdentity = new Map();
    for (const features of tileFeatures?.values?.() || []) {
        for (const feature of features || []) {
            const identity = streamedRailFeatureIdentity(feature);
            if (!byIdentity.has(identity)) byIdentity.set(identity, feature);
        }
    }
    return [...byIdentity.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, feature]) => feature);
}

// OSM content is immutable for one browser session, so identities are enough
// to detect whether a tile arrival/eviction changed the rendered set. Geometry
// still participates in the fallback identity for sources without an OSM id.
export function streamedRailFeatureSetSignature(features) {
    return [...new Set((features || []).map(streamedRailFeatureIdentity))]
        .sort()
        .join('|');
}
