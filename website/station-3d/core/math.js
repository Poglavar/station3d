// Pure geo + angle math. No THREE, no DOM, no module state.
// Scene axis convention for projected local metres: +X = East, -Z = North, +Y = up.

export const DEG_TO_RAD = Math.PI / 180;

// A number, or null when the value is absent or not finite.
//
// The `== null` test BEFORE the cast is the entire point. `Number(null)` is 0
// and `Number.isFinite(0)` is true, so the natural-looking guard
// `Number.isFinite(Number(x))` accepts null as a valid ZERO reading. That single
// coercion is how a missing terrain sample became "the ground is at sea level",
// which grew a phantom viaduct across Split out of a hole in the DEM
// (rail-formation.js). Anything that can be absent — a terrain height, an
// elevation, a measured depth — goes through here rather than through Number().
export function finiteOrNull(value) {
    // Typed, not coerced. `Number([])` is 0 and `Number(true)` is 1, so an
    // `== null` test alone still lets an empty array through as a sea-level
    // reading. Only a real number, or a string that spells one, is a measurement.
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}

export const EARTH_RADIUS_M = 6371000;

// Equirectangular projection: lon/lat → metres from (centerLon, centerLat).
export function geoToLocal(lon, lat, centerLon, centerLat) {
    const cosLat = Math.cos(centerLat * DEG_TO_RAD);
    const dx = (lon - centerLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
    const dz = -(lat - centerLat) * DEG_TO_RAD * EARTH_RADIUS_M;
    return { x: dx, z: dz };
}

// Inverse of geoToLocal: local scene metres back to lon/lat about the anchor.
export function localToGeo(x, z, centerLon, centerLat) {
    const cosLat = Math.cos(centerLat * DEG_TO_RAD);
    const lon = centerLon + x / (DEG_TO_RAD * EARTH_RADIUS_M * cosLat);
    const lat = centerLat - z / (DEG_TO_RAD * EARTH_RADIUS_M);
    return { lon, lat };
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLng = (lng2 - lng1) * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingDeg(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * DEG_TO_RAD;
    const y = Math.sin(dLng) * Math.cos(lat2 * DEG_TO_RAD);
    const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
        Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Signed bearing delta a − b ∈ (−180, 180].
export function signedAngleDiffDeg(a, b) {
    return ((a - b + 540) % 360) - 180;
}

// Short-way lerp for angles in radians.
export function lerpAngle(current, target, t) {
    const TAU = Math.PI * 2;
    const delta = ((target - current + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return current + delta * t;
}

// Approximates a radius-m circle around (lat, lon) as a closed lon/lat ring.
export function makeCircleRing(lat, lon, radiusM, segments) {
    const cosLat = Math.cos(lat * DEG_TO_RAD);
    const ring = [];
    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const dx = Math.cos(theta) * radiusM;
        const dy = Math.sin(theta) * radiusM;
        const dLon = (dx / (EARTH_RADIUS_M * cosLat)) / DEG_TO_RAD;
        const dLat = (dy / EARTH_RADIUS_M) / DEG_TO_RAD;
        ring.push([lon + dLon, lat + dLat]);
    }
    return ring;
}

export function cssColorToHex(css) {
    const n = parseInt((css || '#888888').replace('#', ''), 16);
    return isNaN(n) ? 0x888888 : n;
}
