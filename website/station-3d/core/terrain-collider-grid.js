// Compile the evidenced terrain lattice without holding an entire moving
// physics bubble in one queue item. The caller owns the captured read/query.
import { triangleInsideTerrainCutout } from './formation-terrain-cutout-query.js';

const nowMs = () => performance.now();
const SLICE_MS = 0.5;

// A streamed miss is temporary; a bounded, fully published terrain can end
// inside the physics bubble. Never invent triangles across that boundary.
export function* sampleTerrainColliderGridSteps({ columns, rows, startX, startZ, step, sample, bounded = false,
    now = nowMs, isCurrent = () => true }) {
    const heights = new Float64Array((columns + 1) * (rows + 1));
    let index = 0;
    let known = 0;
    if (!isCurrent()) return null;
    let deadline = now() + SLICE_MS;
    for (let row = 0; row <= rows; row++) {
        for (let column = 0; column <= columns; column++) {
            const y = sample(startX + column * step, startZ + row * step);
            if (!Number.isFinite(y) && !bounded) return null;
            heights[index++] = Number.isFinite(y) ? y : NaN;
            if (Number.isFinite(y)) known++;
            // Check every sample: a count-only batch is not a time budget.
            if (now() >= deadline) {
                yield { phase: 'ground-terrain-sample' };
                if (!isCurrent()) return null;
                deadline = now() + SLICE_MS;
            }
        }
    }
    return known && isCurrent() ? heights : null;
}

export function sampleTerrainColliderGrid(options) {
    const steps = sampleTerrainColliderGridSteps(options);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function terrainColliderTriangleHasEvidence(heights, a, b, c) {
    return Number.isFinite(heights[a]) && Number.isFinite(heights[b]) && Number.isFinite(heights[c]);
}

// The same b-c diagonal as the displayed terrain. Sampling raw DTM here would
// invent a different surface, even if all four corner heights happened to agree.
export function* buildTerrainColliderMeshSteps({ columns, rows, startX, startZ, step, heights,
    cutoutQuery, originX = 0, originZ = 0, now = nowMs, isCurrent = () => true }) {
    if (!heights || !isCurrent()) return null;
    const sideX = columns + 1, sideZ = rows + 1;
    const vertices = new Float32Array(sideX * sideZ * 3);
    const indices = new Uint32Array(columns * rows * 6);
    let deadline = now() + SLICE_MS, offset = 0, heightIndex = 0;
    for (let row = 0; row < sideZ; row++) for (let column = 0; column < sideX; column++) {
        vertices[offset++] = startX + column * step - originX;
        const height = heights[heightIndex++];
        // Missing vertices are never referenced by an active triangle.
        vertices[offset++] = Number.isFinite(height) ? height : 0;
        vertices[offset++] = startZ + row * step - originZ;
        if (now() >= deadline) {
            yield { phase: 'ground-terrain-vertices' };
            if (!isCurrent()) return null;
            deadline = now() + SLICE_MS;
        }
    }
    offset = 0;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const a = row * sideX + column, b = a + 1, c = a + sideX, d = c + 1;
        const minX = startX + column * step, minZ = startZ + row * step;
        const topLeft = { x: minX, z: minZ }, topRight = { x: minX + step, z: minZ };
        const bottomLeft = { x: minX, z: minZ + step }, bottomRight = { x: minX + step, z: minZ + step };
        if (terrainColliderTriangleHasEvidence(heights, a, c, b)
            && !triangleInsideTerrainCutout(cutoutQuery, topLeft, bottomLeft, topRight)) {
            indices[offset++] = a; indices[offset++] = c; indices[offset++] = b;
        }
        if (terrainColliderTriangleHasEvidence(heights, b, c, d)
            && !triangleInsideTerrainCutout(cutoutQuery, topRight, bottomLeft, bottomRight)) {
            indices[offset++] = b; indices[offset++] = c; indices[offset++] = d;
        }
        if (now() >= deadline) {
            yield { phase: 'ground-terrain-triangles' };
            if (!isCurrent()) return null;
            deadline = now() + SLICE_MS;
        }
    }
    if (!offset || !isCurrent()) return null;
    // A view avoids copying the whole index buffer in the final queue item.
    return { vertices, indices: offset === indices.length ? indices : indices.subarray(0, offset) };
}
