// Classifies OSM road-surface features that represent a real opening in the
// curb line, keeping parallel paved paths and sidewalks physically separated.

import { pointInAnyMask, pointTouchesAnyMask } from './mask-query.js';

// The /roads/curbs outline is the union of highway and broad tram routing
// buffers. The latter are intentionally wider than the trackbed rendered by
// rails.js, so proximity to one is not by itself authority to delete a real
// highway curb. A short probe toward the lower/asphalt side distinguishes the
// two cases: a highway-backed edge is the real road/sidewalk interface, while
// an unsupported edge belongs only to the synthetic tram proxy.
export const CURB_ROADBED_SUPPORT_INSET_M = 0.12;

function normalizedTag(value) {
    return value == null ? '' : String(value).trim().toLowerCase();
}

export function curbOpeningMaskReason(feature) {
    const properties = feature?.properties || {};
    const highwayType = normalizedTag(properties.highway_type);
    const tags = properties.tags || {};
    if (highwayType === 'pedestrian') return 'pedestrian-area';

    const crossing = normalizedTag(tags.crossing);
    const taggedCrossing = normalizedTag(tags.footway) === 'crossing'
        || normalizedTag(tags.cycleway) === 'crossing'
        || (crossing !== '' && crossing !== 'no');
    return taggedCrossing ? 'crossing' : null;
}

// Parking and greenery polygons are sourced independently and their shared
// boundary can differ by a few decimetres. The greenery layer already builds
// exact flat edging around its own polygon, so a parking curb whose raised side
// enters that polygon is duplicate ownership and must be omitted.
export function curbRaisedSideTouchesMask(
    midpointX,
    midpointZ,
    normalX,
    normalZ,
    contains,
    sampleDistancesM,
) {
    if (typeof contains !== 'function' || !Array.isArray(sampleDistancesM)) return false;
    return sampleDistancesM.some((distanceM) => (
        Number.isFinite(distanceM)
        && distanceM >= 0
        && contains(
            midpointX + normalX * distanceM,
            midpointZ + normalZ * distanceM,
        )
    ));
}

export function curbTramProxySuppressesBoundary(
    midpointX,
    midpointZ,
    normalX,
    normalZ,
    tramProxyMasks,
    roadbedMasks,
    roadbedInsetM = CURB_ROADBED_SUPPORT_INSET_M,
) {
    if (!pointTouchesAnyMask(
        midpointX,
        midpointZ,
        normalX,
        normalZ,
        tramProxyMasks,
    )) return false;
    const inset = Number.isFinite(roadbedInsetM)
        ? Math.max(0, roadbedInsetM)
        : CURB_ROADBED_SUPPORT_INSET_M;
    // Curb rings are normalised with the raised side on the left, so the
    // negative normal is the lower roadbed side for both outer rings and
    // holes. Sampling that side prevents a sidewalk on the raised side from
    // falsely legitimising a tram-only union edge.
    return !pointInAnyMask(
        midpointX - normalX * inset,
        midpointZ - normalZ * inset,
        roadbedMasks,
    );
}
