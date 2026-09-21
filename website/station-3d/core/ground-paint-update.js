// Pixel work for one private successor page. This is a plan, not a scheduler:
// the existing frame queue advances each copy/clear/draw and publishes only the
// complete page. Blocks are disjoint; every destination texel is written once
// by a copy or a clear before any paint ranks are replayed.
export const GROUND_PAINT_UPDATE = 'station3d-ground-paint-update-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sameReceiver = (a, b) => a?.key === b?.key && a?.verticalBand === b?.verticalBand
    && a?.coverageRevision === b?.coverageRevision;
const validBounds = b => b && ['minX', 'minZ', 'maxX', 'maxZ'].every(key => finite(b[key]))
    && b.maxX > b.minX && b.maxZ > b.minZ;
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;

export function planGroundPaintUpdate({ receiver, bounds, size, previous = null, dirtyBounds = [],
    blockSize = 256, maxBlocks = 256, maxDirtyBounds = 256 }) {
    if (!receiver?.key || !receiver?.verticalBand || !receiver?.coverageRevision || !validBounds(bounds)
        || ![size, blockSize, maxBlocks, maxDirtyBounds].every(n => Number.isSafeInteger(n) && n > 0)) {
        throw new TypeError('Invalid ground paint update dimensions or receiver');
    }
    if (Math.ceil(size / blockSize) ** 2 > maxBlocks) throw new RangeError('Ground paint block budget exceeded');
    if (!Array.isArray(dirtyBounds) || dirtyBounds.length > maxDirtyBounds) throw new RangeError('Ground paint dirty-region budget exceeded');
    if (!dirtyBounds.every(validBounds)) throw new TypeError('Invalid ground paint dirty bounds');
    const stepX = (bounds.maxX - bounds.minX) / size, stepZ = (bounds.maxZ - bounds.minZ) / size;
    let offsetX = 0, offsetY = 0, reusable = false;
    if (previous && !previous.disposed && sameReceiver(receiver, previous.receiver)
        && previous.size === size && validBounds(previous.bounds)) {
        const old = previous.bounds;
        offsetX = (bounds.minX - old.minX) / stepX;
        offsetY = (bounds.minZ - old.minZ) / stepZ;
        const nearInteger = value => Math.abs(value - Math.round(value)) < 1e-6;
        // A different scale or fractional-texel shift needs resampling/repaint;
        // a raw copy would move source details to the wrong world coordinates.
        reusable = Math.abs((old.maxX - old.minX) / stepX - size) < 1e-6
            && Math.abs((old.maxZ - old.minZ) / stepZ - size) < 1e-6
            && nearInteger(offsetX) && nearInteger(offsetY);
        offsetX = Math.round(offsetX); offsetY = Math.round(offsetY);
    }
    // Expand edits by one texel for rasterization/filter boundary conservatism.
    // The neighbouring blocks then replay all contributors, including survivors
    // uncovered by a removal. Material IDs are never interpolated during copies.
    const dirty = dirtyBounds.map(b => ({
        x: Math.floor((b.minX - bounds.minX) / stepX) - 1,
        y: Math.floor((b.minZ - bounds.minZ) / stepZ) - 1,
        width: Math.ceil((b.maxX - bounds.minX) / stepX) - Math.floor((b.minX - bounds.minX) / stepX) + 2,
        height: Math.ceil((b.maxZ - bounds.minZ) / stepZ) - Math.floor((b.minZ - bounds.minZ) / stepZ) + 2,
    }));
    const copies = [], repaints = [];
    let copiedPixels = 0, repaintedPixels = 0;
    for (let y = 0; y < size; y += blockSize) for (let x = 0; x < size; x += blockSize) {
        const rect = { x, y, width: Math.min(blockSize, size - x), height: Math.min(blockSize, size - y) };
        const sourceX = x + offsetX, sourceY = y + offsetY;
        if (reusable && sourceX >= 0 && sourceY >= 0 && sourceX + rect.width <= size
            && sourceY + rect.height <= size && !dirty.some(b => intersects(rect, b))) {
            copies.push(Object.freeze({ ...rect, sourceX, sourceY }));
            copiedPixels += rect.width * rect.height;
        } else {
            repaints.push(Object.freeze({ ...rect, bounds: Object.freeze({
                minX: bounds.minX + x * stepX, minZ: bounds.minZ + y * stepZ,
                maxX: bounds.minX + (x + rect.width) * stepX,
                maxZ: bounds.minZ + (y + rect.height) * stepZ,
            }) }));
            repaintedPixels += rect.width * rect.height;
        }
    }
    return Object.freeze({ contract: GROUND_PAINT_UPDATE, size,
        source: copies.length ? previous : null,
        bounds: Object.freeze({ ...bounds }), receiver: Object.freeze({ key: receiver.key,
            verticalBand: receiver.verticalBand, coverageRevision: receiver.coverageRevision }),
        copies: Object.freeze(copies), repaints: Object.freeze(repaints),
        stats: Object.freeze({ blocks: copies.length + repaints.length, copiedPixels, repaintedPixels,
            maxPixelsPerItem: Math.min(size, blockSize) ** 2,
            // R8 ownership copies count reads AND writes. Clear/draw traffic
            // is reported by the GPU task separately.
            copyBytes: copiedPixels * 2 }),
    });
}
