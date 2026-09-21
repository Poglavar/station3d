// A deliberately narrow weld for generated indexed meshes that carry only a
// position attribute. Three's general-purpose mergeVertices walks every INDEX
// and every possible attribute/morph target. Rail sweeps reference each emitted
// vertex three times on average, so that generic path hashes and copies the same
// position repeatedly during every streamed refresh.

function indexArrayFor(maxIndex, length) {
    return maxIndex >= 65_535 ? new Uint32Array(length) : new Uint16Array(length);
}

export function weldIndexedPositions(sourcePositions, sourceIndices, tolerance = 1e-4) {
    if (!(sourcePositions instanceof Float32Array)) {
        throw new TypeError('sourcePositions must be a Float32Array');
    }
    if (!ArrayBuffer.isView(sourceIndices)) {
        throw new TypeError('sourceIndices must be a typed array');
    }
    if (sourcePositions.length % 3 !== 0) {
        throw new RangeError('sourcePositions must contain complete xyz triples');
    }

    const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
    const multiplier = 1 / safeTolerance;
    const additive = safeTolerance * 0.5 * multiplier;
    const sourceVertexCount = sourcePositions.length / 3;
    const remap = new Uint32Array(sourceVertexCount);
    const weldedPositions = new Float32Array(sourcePositions.length);
    const hashToIndex = Object.create(null);
    let weldedVertexCount = 0;

    // Generated rail vertices are all referenced, so visit each vertex exactly
    // once, then remap the triangle indices in one cheap typed-array pass.
    // Math.trunc matches mergeVertices' tolerance quantisation without its
    // 32-bit `~~` overflow for future country-scale/floating-origin ranges.
    for (let sourceIndex = 0; sourceIndex < sourceVertexCount; sourceIndex++) {
        const offset = sourceIndex * 3;
        const x = sourcePositions[offset];
        const y = sourcePositions[offset + 1];
        const z = sourcePositions[offset + 2];
        const hash = `${Math.trunc(x * multiplier + additive)},`
            + `${Math.trunc(y * multiplier + additive)},`
            + `${Math.trunc(z * multiplier + additive)}`;
        const existing = hashToIndex[hash];
        if (existing !== undefined) {
            remap[sourceIndex] = existing;
            continue;
        }

        const targetIndex = weldedVertexCount++;
        hashToIndex[hash] = targetIndex;
        remap[sourceIndex] = targetIndex;
        const targetOffset = targetIndex * 3;
        weldedPositions[targetOffset] = x;
        weldedPositions[targetOffset + 1] = y;
        weldedPositions[targetOffset + 2] = z;
    }

    const weldedIndices = indexArrayFor(weldedVertexCount - 1, sourceIndices.length);
    for (let index = 0; index < sourceIndices.length; index++) {
        const sourceIndex = sourceIndices[index];
        if (sourceIndex >= sourceVertexCount) {
            throw new RangeError(`source index ${sourceIndex} is outside the position buffer`);
        }
        weldedIndices[index] = remap[sourceIndex];
    }

    return {
        positions: weldedPositions.slice(0, weldedVertexCount * 3),
        indices: weldedIndices,
        sourceVertexCount,
        weldedVertexCount,
    };
}
