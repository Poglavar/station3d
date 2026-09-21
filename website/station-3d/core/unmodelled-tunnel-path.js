// A pedestrian path tagged as a tunnel is underground by definition. Until the
// alignment solver has given it a bore of its own, it has no surface to show:
// draping its asphalt on the composed civil ground publishes a GRADE_SEPARATED
// claim (exempt from rank arbitration) on top of whatever really owns that
// ground. The Tomićeva passage through the funicular viaduct came out as an
// asphalt strip floating 3 m above the deck it runs under. Pure: no THREE, no
// browser state.

const OSM_FALSE_VALUES = new Set(['', 'no', 'false', '0']);
const TUNNEL_PATH_HIGHWAYS = new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway']);

function taggedTunnel(properties = {}) {
    const value = properties.tunnel ?? properties.osm_tunnel ?? properties.tags?.tunnel;
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    // A passage through a building is at ground level; only a real bore counts.
    return !OSM_FALSE_VALUES.has(normalized) && normalized !== 'building_passage';
}

/** True for a sidewalk-level way tagged as a real tunnel, whatever modelled it. */
export function isTunnelPathSurface({ properties = {}, type = null } = {}) {
    return TUNNEL_PATH_HIGHWAYS.has(String(type || '')) && taggedTunnel(properties);
}

// A portal approach may sit a little proud of the evidence where the LiDAR
// already sees the ramp; a vehicle clearance (5.5 m) never should.
export const TUNNEL_PATH_ABOVE_GROUND_TOLERANCE_M = 1.0;

/**
 * True when a solved alignment would place a tunnel path's surface above the
 * terrain evidence by more than the tolerance. Unknown terrain is not a verdict.
 */
export function tunnelPathSurfaceAboveGround(alignmentY, terrainY,
                                             toleranceM = TUNNEL_PATH_ABOVE_GROUND_TOLERANCE_M) {
    if (!Number.isFinite(alignmentY) || !Number.isFinite(terrainY)) return false;
    return alignmentY - terrainY > toleranceM;
}

/**
 * True when a sidewalk-level way is a tagged tunnel that nothing has modelled:
 * no engineered formation and no compiled vertical alignment to follow. Such a
 * way must not publish a surface at all.
 */
export function isUnmodelledTunnelPathSurface({
    properties = {},
    type = null,
    engineered = false,
    followsVerticalAlignment = false,
} = {}) {
    if (engineered || followsVerticalAlignment) return false;
    if (!TUNNEL_PATH_HIGHWAYS.has(String(type || ''))) return false;
    return taggedTunnel(properties);
}
