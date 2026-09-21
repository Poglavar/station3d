// Bounded position-only welding, smooth normals and bounds. Renderer adapters
// attach these completed arrays without running whole-mesh post-processing.
// The position quantization and face accumulation preserve the existing Three
// geometry output; integer keys do not wrap at 32-bit world coordinates.
export function* prepareIndexedSurfaceGeometrySteps({ positions, indices, weldTolerance = null,
    maxVertices, maxTriangles, budget }) {
    const array = value => (Array.isArray(value) || ArrayBuffer.isView(value)) && Number.isSafeInteger(value.length);
    if (!array(positions) || !array(indices) || positions.length % 3 || indices.length % 3
        || ![maxVertices, maxTriangles].every(value => Number.isSafeInteger(value) && value > 0)
        || !budget?.step || !budget?.check
        || weldTolerance !== null && (!Number.isFinite(weldTolerance) || weldTolerance <= 0)) {
        throw new TypeError('Indexed surface geometry requires bounded positions and triangle indices');
    }
    if (positions.length / 3 > maxVertices || indices.length / 3 > maxTriangles) {
        throw Object.assign(new Error('Indexed surface geometry exceeds admitted capacity'), { code: 'ground-generation-capacity' });
    }
    const source = new Float32Array(positions.length), vertexCount = positions.length / 3;
    for (let i = 0; i < positions.length; i += 3) {
        yield* budget.step('ground-geometry-position');
        for (let axis = 0; axis < 3; axis++) {
            const value = positions[i + axis]; source[i + axis] = value;
            if (typeof value !== 'number' || !Number.isFinite(source[i + axis])) throw new TypeError('Surface vertex is not finite');
        }
    }
    const mapped = new Uint32Array(indices.length);
    const packed = weldTolerance === null ? source : new Float32Array(source.length);
    const keys = weldTolerance === null ? null : new Map();
    const tolerance = Math.max(weldTolerance || 1, Number.EPSILON), multiplier = Math.pow(10, Math.log10(1 / tolerance));
    const additive = tolerance * .5 * multiplier;
    let count = keys ? 0 : vertexCount, maximumIndex = 0;
    for (let i = 0; i < indices.length; i++) {
        yield* budget.step('ground-geometry-weld');
        const index = indices[i];
        if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) throw new TypeError('Surface triangle index is outside its vertices');
        let target = index;
        if (keys) {
            const offset = index * 3;
            const key = `${Math.trunc(source[offset] * multiplier + additive)},${Math.trunc(source[offset + 1] * multiplier + additive)},${Math.trunc(source[offset + 2] * multiplier + additive)},`;
            target = keys.get(key);
            if (target === undefined) {
                target = count++; keys.set(key, target);
                for (let axis = 0; axis < 3; axis++) packed[target * 3 + axis] = source[offset + axis];
            }
        }
        mapped[i] = target; maximumIndex = Math.max(maximumIndex, target);
    }
    const outputPositions = keys ? packed.slice(0, count * 3) : packed;
    const outputIndices = maximumIndex >= 65535 ? mapped : new Uint16Array(mapped.length);
    if (outputIndices !== mapped) for (let i = 0; i < mapped.length; i++) {
        yield* budget.step('ground-geometry-index'); outputIndices[i] = mapped[i];
    }
    const normals = new Float32Array(outputPositions.length);
    for (let i = 0; i < mapped.length; i += 3) {
        yield* budget.step('ground-geometry-face-normal');
        const a = mapped[i] * 3, b = mapped[i + 1] * 3, c = mapped[i + 2] * 3;
        const cbx = outputPositions[c] - outputPositions[b], cby = outputPositions[c + 1] - outputPositions[b + 1],
            cbz = outputPositions[c + 2] - outputPositions[b + 2];
        const abx = outputPositions[a] - outputPositions[b], aby = outputPositions[a + 1] - outputPositions[b + 1],
            abz = outputPositions[a + 2] - outputPositions[b + 2];
        const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
        for (const offset of [a, b, c]) { normals[offset] += nx; normals[offset + 1] += ny; normals[offset + 2] += nz; }
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < outputPositions.length; i += 3) {
        yield* budget.step('ground-geometry-vertex-normal');
        const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
        if (![nx, ny, nz].every(Number.isFinite)) throw new TypeError('Surface normal exceeds finite storage');
        const inverseLength = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        normals[i] *= inverseLength; normals[i + 1] *= inverseLength; normals[i + 2] *= inverseLength;
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], outputPositions[i + axis]); max[axis] = Math.max(max[axis], outputPositions[i + axis]);
        }
    }
    const center = count ? min.map((value, axis) => (value + max[axis]) * .5) : [0, 0, 0];
    let radiusSq = 0;
    for (let i = 0; i < outputPositions.length; i += 3) {
        yield* budget.step('ground-geometry-bounds');
        const x = outputPositions[i] - center[0], y = outputPositions[i + 1] - center[1], z = outputPositions[i + 2] - center[2];
        radiusSq = Math.max(radiusSq, x * x + y * y + z * z);
    }
    budget.check();
    return Object.freeze({ positions: outputPositions, indices: outputIndices, normals,
        bounds: Object.freeze({ min: count ? min : [0, 0, 0], max: count ? max : [0, 0, 0] }),
        sphere: Object.freeze({ center, radius: Math.sqrt(radiusSq) }) });
}
