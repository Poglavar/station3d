import * as THREE from 'three';

// Far massing is intentionally subtler than the detailed facade palette: at
// skyline distance it should break up same-use blocks without reading as noise
// or changing the categorical use colours. The hash and 64-bucket coordinates
// mirror the detailed-building colour grammar, so a building keeps the same
// direction of variation when its LOD changes.
const FAR_TINT_BUCKETS = 64;
export const FAR_TINT_HSL_HALF_RANGE = Object.freeze({
    h: 0.004,
    s: 0.03,
    l: 0.04,
});

function hashObjectId(objectId) {
    let hash = 2166136261;
    const text = String(objectId);
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function applyFarBuildingTint(target, baseHex, objectId) {
    const color = target instanceof THREE.Color ? target : new THREE.Color();
    color.setHex(baseHex);
    if (objectId == null) return color;

    const bucket = hashObjectId(objectId) % FAR_TINT_BUCKETS;
    const hueUnit = bucket / FAR_TINT_BUCKETS - 0.5;
    const saturationUnit = ((bucket * 7) % FAR_TINT_BUCKETS) / FAR_TINT_BUCKETS - 0.5;
    const lightnessUnit = ((bucket * 13) % FAR_TINT_BUCKETS) / FAR_TINT_BUCKETS - 0.5;
    return color.offsetHSL(
        hueUnit * FAR_TINT_HSL_HALF_RANGE.h * 2,
        saturationUnit * FAR_TINT_HSL_HALF_RANGE.s * 2,
        lightnessUnit * FAR_TINT_HSL_HALF_RANGE.l * 2,
    );
}
