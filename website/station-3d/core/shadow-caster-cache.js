// Pure helpers for the directional shadow map: an order-sensitive signature of
// everything the shadow pass would draw, and the light stepping that keeps that
// signature stable while the observer moves a little or sim time advances.

// Combine per-caster signatures, the light signature and the shadow type. Any
// change (a caster moved, appeared or vanished, the light stepped) changes it.
export function combineShadowSignatures(casterSignatures, lightSignature, shadowType = 0) {
    let hash = (Math.imul(lightSignature | 0, 31) + (shadowType | 0)) | 0;
    hash = (Math.imul(hash, 31) + (casterSignatures?.length | 0)) | 0;
    for (const value of casterSignatures || []) hash = (Math.imul(hash, 16777619) ^ (value | 0)) | 0;
    return hash;
}

// Shadow cameras follow the observer; snap their anchor to a world grid so the
// light only changes when the observer crosses a cell.
export function snapShadowAnchor(value, stepM) {
    const step = Number(stepM);
    const number = Number(value);
    if (!Number.isFinite(number) || !(step > 0)) return number;
    return Math.round(number / step) * step;
}

// Quantize a unit direction so slow solar motion changes the light in visible steps only.
export function quantizeDirection(direction, stepRad) {
    const x = Number(direction?.x), y = Number(direction?.y), z = Number(direction?.z);
    if (![x, y, z].every(Number.isFinite) || !(stepRad > 0)) return { x, y, z };
    const azimuth = Math.round(Math.atan2(z, x) / stepRad) * stepRad;
    const elevation = Math.round(Math.asin(Math.max(-1, Math.min(1, y / (Math.hypot(x, y, z) || 1)))) / stepRad) * stepRad;
    const horizontal = Math.cos(elevation);
    return { x: Math.cos(azimuth) * horizontal, y: Math.sin(elevation), z: Math.sin(azimuth) * horizontal };
}
