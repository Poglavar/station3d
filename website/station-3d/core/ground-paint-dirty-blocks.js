// Accumulates paint damage as bounded page-local blocks. The result contains
// only immutable plain arrays so callers cannot mutate shared paint state.
export const GROUND_PAINT_DIRTY_BLOCKS = 'station3d-ground-paint-dirty-blocks-v1';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validBounds = bounds => bounds && ['minX', 'minZ', 'maxX', 'maxZ'].every(key => finite(bounds[key]))
    && bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ;
const validPositiveInteger = value => Number.isSafeInteger(value) && value > 0;

function addPixelRectBlocks(blocks, { x0, y0, x1, y1 }, size, blockSize, columns, rows, maxBlocks) {
    // Rectangles are half-open. Clipping before division keeps outside-page
    // edits from producing negative or out-of-range page block indices.
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(size, x1); y1 = Math.min(size, y1);
    if (x0 >= x1 || y0 >= y1) return;
    const firstColumn = Math.max(0, Math.floor(x0 / blockSize));
    const lastColumn = Math.min(columns - 1, Math.ceil(x1 / blockSize) - 1);
    const firstRow = Math.max(0, Math.floor(y0 / blockSize));
    const lastRow = Math.min(rows - 1, Math.ceil(y1 / blockSize) - 1);
    for (let row = firstRow; row <= lastRow; row++) {
        for (let column = firstColumn; column <= lastColumn; column++) {
            const index = row * columns + column;
            if (!blocks.has(index) && blocks.size >= maxBlocks) {
                throw new RangeError('Ground paint dirty-block budget exceeded');
            }
            blocks.add(index);
        }
    }
}

function sameScale(a, b) {
    const close = (left, right) => Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
    return close(a.maxX - a.minX, b.maxX - b.minX) && close(a.maxZ - a.minZ, b.maxZ - b.minZ);
}

/**
 * Return the page blocks that must be repainted after world-space edits.
 * Previous blocks are carried by their world rectangles, so a moved page keeps
 * stale texels covered without adding another rasterization halo each frame.
 */
export function planGroundPaintDirtyBlocks({ bounds, size, blockSize = 256, maxBlocks = 256,
    dirtyBounds = [], previous = null }) {
    if (!validBounds(bounds) || !validPositiveInteger(size) || !validPositiveInteger(blockSize)
        || !validPositiveInteger(maxBlocks)) {
        throw new TypeError('Invalid ground paint dirty-block dimensions');
    }
    if (!Array.isArray(dirtyBounds) || dirtyBounds.length > 8193) {
        throw new RangeError('Ground paint dirty-region budget exceeded');
    }
    if (!dirtyBounds.every(validBounds)) throw new TypeError('Invalid ground paint dirty bounds');

    const columns = Math.ceil(size / blockSize), rows = columns;
    if (!Number.isSafeInteger(columns * rows)) throw new RangeError('Ground paint block index overflow');
    if (columns * rows > maxBlocks) throw new RangeError('Ground paint block budget exceeded');
    const blocks = new Set();
    const stepX = (bounds.maxX - bounds.minX) / size;
    const stepZ = (bounds.maxZ - bounds.minZ) / size;

    if (previous !== null) {
        const priorBlockCount = previous && validPositiveInteger(previous.size)
            && validPositiveInteger(previous.blockSize)
            ? Math.ceil(previous.size / previous.blockSize) ** 2 : NaN;
        if (!previous || previous.contract !== GROUND_PAINT_DIRTY_BLOCKS || !validBounds(previous.bounds)
            || previous.size !== size || previous.blockSize !== blockSize || !sameScale(bounds, previous.bounds)
            || !Array.isArray(previous.blocks) || previous.blocks.length > maxBlocks
            || !Number.isSafeInteger(priorBlockCount)
            || !previous.blocks.every(index => Number.isSafeInteger(index) && index >= 0 && index < priorBlockCount)) {
            throw new TypeError('Incompatible previous ground paint dirty blocks');
        }
        const oldColumns = Math.ceil(size / blockSize);
        const oldStepX = (previous.bounds.maxX - previous.bounds.minX) / size;
        const oldStepZ = (previous.bounds.maxZ - previous.bounds.minZ) / size;
        for (const index of previous.blocks) {
            const row = Math.floor(index / oldColumns), column = index % oldColumns;
            const oldX0 = column * blockSize, oldY0 = row * blockSize;
            const oldX1 = Math.min(size, oldX0 + blockSize), oldY1 = Math.min(size, oldY0 + blockSize);
            // Reproject the exact old block footprint. There is deliberately
            // no halo here: the source block already includes its edit halo.
            addPixelRectBlocks(blocks, {
                x0: (previous.bounds.minX + oldX0 * oldStepX - bounds.minX) / stepX,
                y0: (previous.bounds.minZ + oldY0 * oldStepZ - bounds.minZ) / stepZ,
                x1: (previous.bounds.minX + oldX1 * oldStepX - bounds.minX) / stepX,
                y1: (previous.bounds.minZ + oldY1 * oldStepZ - bounds.minZ) / stepZ,
            }, size, blockSize, columns, rows, maxBlocks);
        }
    }

    for (const rect of dirtyBounds) {
        // Match ground-paint-update's raster/filter safety margin exactly:
        // floor(min)-1 through ceil(max)+1, represented as a half-open rect.
        const minX = (rect.minX - bounds.minX) / stepX;
        const minY = (rect.minZ - bounds.minZ) / stepZ;
        const maxX = (rect.maxX - bounds.minX) / stepX;
        const maxY = (rect.maxZ - bounds.minZ) / stepZ;
        addPixelRectBlocks(blocks, {
            x0: Math.floor(minX) - 1,
            y0: Math.floor(minY) - 1,
            x1: Math.ceil(maxX) + 1,
            y1: Math.ceil(maxY) + 1,
        }, size, blockSize, columns, rows, maxBlocks);
    }

    const sorted = [...blocks].sort((a, b) => a - b);
    return Object.freeze({ contract: GROUND_PAINT_DIRTY_BLOCKS, bounds: Object.freeze({ ...bounds }),
        size, blockSize, blocks: Object.freeze(sorted) });
}
