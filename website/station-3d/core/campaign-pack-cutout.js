// Bounded XZ openings cut into an immutable campaign pack. Authored entrances
// use these to replace a small patch of baked terrain/civil geometry without
// disabling the surrounding city or mutating the pack artifact itself.

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function boundedSize(value, fallback) {
    return Math.max(0.5, Math.min(200, finite(value) ?? fallback));
}

export function resolveCampaignPackCutout(input, {
    originX = 0,
    originZ = 0,
} = {}) {
    if (!input || typeof input !== 'object') return null;
    if (input.contract === 'station3d-campaign-pack-cutout-v1'
        && [input.minX, input.maxX, input.minZ, input.maxZ].every(Number.isFinite)) {
        return input;
    }
    const widthM = boundedSize(input.widthM, 8);
    const depthM = boundedSize(input.depthM, 8);
    const centerX = (finite(originX) ?? 0) + (finite(input.offsetX) ?? 0);
    const centerZ = (finite(originZ) ?? 0) + (finite(input.offsetZ) ?? 0);
    return Object.freeze({
        contract: 'station3d-campaign-pack-cutout-v1',
        centerX,
        centerZ,
        widthM,
        depthM,
        minX: centerX - widthM * 0.5,
        maxX: centerX + widthM * 0.5,
        minZ: centerZ - depthM * 0.5,
        maxZ: centerZ + depthM * 0.5,
    });
}

export function campaignPackCutoutPlaneSpecs(cutout) {
    if (!cutout) return Object.freeze([]);
    // Three's local clipping discards the intersection of the negative sides
    // when material.clipIntersection is true. These four planes therefore
    // remove only the inside of this rectangle, not the world around it.
    return Object.freeze([
        Object.freeze({ normal: Object.freeze([-1, 0, 0]), constant: cutout.minX }),
        Object.freeze({ normal: Object.freeze([1, 0, 0]), constant: -cutout.maxX }),
        Object.freeze({ normal: Object.freeze([0, 0, -1]), constant: cutout.minZ }),
        Object.freeze({ normal: Object.freeze([0, 0, 1]), constant: -cutout.maxZ }),
    ]);
}

export function campaignPackCutoutContains(cutout, xValue, zValue) {
    const x = finite(xValue);
    const z = finite(zValue);
    return !!cutout && x !== null && z !== null
        && x >= cutout.minX && x <= cutout.maxX
        && z >= cutout.minZ && z <= cutout.maxZ;
}
