// Pure camera-to-page layout planning for ground-paint cascades. This module
// owns no scheduler, renderer, texture, or device-tier policy.

function finite(value, name) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
    return value;
}

function positive(value, name) {
    finite(value, name);
    if (value <= 0) throw new RangeError(`${name} must be positive`);
    return value;
}

function integer(value, name) {
    positive(value, name);
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer`);
    return value;
}

function immutableBounds(minX, minZ, widthM) {
    return Object.freeze({ minX, minZ, maxX: minX + widthM, maxZ: minZ + widthM });
}

function validPrevious(previous, widthM, size, blockSize) {
    if (!previous || previous.disposed === true) return null;
    if (previous.widthM !== widthM || previous.size !== size || previous.blockSize !== blockSize) return null;
    const b = previous.bounds;
    if (!b || ![b.minX, b.minZ, b.maxX, b.maxZ].every(Number.isFinite)) return null;
    if (b.maxX - b.minX !== widthM || b.maxZ - b.minZ !== widthM
        || b.minX + widthM !== b.maxX || b.minZ + widthM !== b.maxZ) return null;
    return previous;
}

export function planGroundPaintCascadeLayout({
    cameraX,
    cameraZ,
    widthM,
    size,
    blockSize,
    previous = null,
} = {}) {
    const x = finite(cameraX, 'cameraX');
    const z = finite(cameraZ, 'cameraZ');
    const width = positive(widthM, 'widthM');
    const pixels = integer(size, 'size');
    const block = integer(blockSize, 'blockSize');
    if (pixels % block !== 0) throw new RangeError('size must be divisible by blockSize');
    if (block > pixels / 4) throw new RangeError('blockSize is too coarse for hysteresis');
    const texelM = width / pixels;
    const snapM = block * texelM;
    if (!Number.isFinite(snapM) || !(texelM > 0)
        || Math.max(Math.abs(x/texelM), Math.abs(z/texelM)) + pixels > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('cascade layout exceeds safe texel coordinates');
    }
    const desiredMinX = Math.round((x - width / 2) / snapM) * snapM;
    const desiredMinZ = Math.round((z - width / 2) / snapM) * snapM;
    const prior = validPrevious(previous, width, pixels, block);
    const priorCenterX = prior ? prior.bounds.minX + width / 2 : 0;
    const priorCenterZ = prior ? prior.bounds.minZ + width / 2 : 0;
    const withinHysteresis = prior
        && Math.abs(x - priorCenterX) <= width / 8
        && Math.abs(z - priorCenterZ) <= width / 8;
    const minX = withinHysteresis ? prior.bounds.minX : desiredMinX;
    const minZ = withinHysteresis ? prior.bounds.minZ : desiredMinZ;
    if (!(minX + width > minX) || !(minZ + width > minZ)
        || ![minX, minZ, minX + width, minZ + width].every(Number.isFinite)
        || Math.max(Math.abs(minX), Math.abs(minZ), Math.abs(minX + width), Math.abs(minZ + width)) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('cascade layout exceeds safe coordinate range');
    }
    const same = !!prior && minX === prior.bounds.minX && minZ === prior.bounds.minZ;
    return Object.freeze({
        bounds: immutableBounds(minX, minZ, width),
        widthM: width,
        size: pixels,
        blockSize: block,
        texelM,
        changed: !same,
        same,
    });
}
