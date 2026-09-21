// Point support comes from the published Float32 triangles, including their
// exact openings. The source-face index bounds a query to nearby lattice cells.
export const MAX_TERRAIN_RECEIVER_TRIANGLES_PER_CELL = 256;

// The same source-face index also serves footprint detail. Emit references to
// the exact cut receiver, never a reconstructed grid across its openings.
export function* terrainReceiverTrianglesInBounds(tile, bounds) {
    if (!tile) return;
    const { tileX, tileZ, tileM, segments, receiver } = tile;
    const originX = tileX * tileM, originZ = tileZ * tileM;
    const cell = value => Math.max(0, Math.min(segments - 1, Math.floor(value / tileM * segments)));
    const x0 = cell(bounds.minX - originX - .001), x1 = cell(bounds.maxX - originX + .001);
    const z0 = cell(bounds.minZ - originZ - .001), z1 = cell(bounds.maxZ - originZ + .001);
    const { positions, indices, sourceTriangleOffsets: offsets } = receiver;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const face = (z * segments + x) * 2;
        const start = offsets ? offsets[face] : face * 3;
        const end = offsets ? offsets[face + 2] : (face + 2) * 3;
        if (end - start > MAX_TERRAIN_RECEIVER_TRIANGLES_PER_CELL * 3) {
            throw new RangeError('Published terrain cell exceeds its detail-query capacity');
        }
        for (let index = start; index < end; index += 3) {
            yield { positions, a: indices[index] * 3, b: indices[index + 1] * 3,
                c: indices[index + 2] * 3, originX, originZ };
        }
        // Empty cut cells still give a cooperative consumer a chance to yield.
        yield null;
    }
}

export function terrainReceiverSceneYAtLocal(tile, x, z) {
    if (!tile || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const { tileX, tileZ, tileM, segments, receiver } = tile;
    x -= tileX * tileM; z -= tileZ * tileM;
    if (x < 0 || z < 0 || x > tileM || z > tileM) return null;
    const { positions: p, indices, sourceTriangleOffsets: offsets } = receiver;
    const cell = value => Math.max(0, Math.min(segments - 1, Math.floor(value / tileM * segments)));
    // Published vertices may differ from mathematical lattice knots by up
    // to the validated 1 mm storage tolerance. Include the neighbouring cell
    // at such an edge; triangle containment still uses the actual geometry.
    const minColumn = cell(x - .001), maxColumn = cell(x + .001);
    const minRow = cell(z - .001), maxRow = cell(z + .001);
    for (let row = minRow; row <= maxRow; row++) for (let column = minColumn; column <= maxColumn; column++) {
        const face = (row * segments + column) * 2;
        const start = offsets ? offsets[face] : face * 3;
        const end = offsets ? offsets[face + 2] : (face + 2) * 3;
        if (end - start > MAX_TERRAIN_RECEIVER_TRIANGLES_PER_CELL * 3) {
            throw new RangeError('Published terrain cell exceeds its point-query capacity');
        }
        for (let index = start; index < end; index += 3) {
            const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
            const ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2];
            const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
            const wa = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / area;
            const wb = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / area;
            const wc = 1 - wa - wb;
            if (wa >= -1e-10 && wb >= -1e-10 && wc >= -1e-10) return p[a + 1] + wb * (p[b + 1] - p[a + 1]) + wc * (p[c + 1] - p[a + 1]);
        }
    }
    return null;
}
