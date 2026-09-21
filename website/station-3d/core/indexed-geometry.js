// Pure typed-array geometry helpers for Worker compilers. No renderer or DOM.

export function computeIndexedVertexNormals(positions, indices) {
    if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
        throw new TypeError('positions must be a Float32Array of xyz vertices');
    }
    if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
        throw new TypeError('indices must be a Uint16Array or Uint32Array');
    }
    if (indices.length % 3 !== 0) throw new Error('indices must contain triangles');
    const normals = new Float32Array(positions.length);
    for (let offset = 0; offset < indices.length; offset += 3) {
        const ia = indices[offset] * 3;
        const ib = indices[offset + 1] * 3;
        const ic = indices[offset + 2] * 3;
        const abx = positions[ib] - positions[ia];
        const aby = positions[ib + 1] - positions[ia + 1];
        const abz = positions[ib + 2] - positions[ia + 2];
        const acx = positions[ic] - positions[ia];
        const acy = positions[ic + 1] - positions[ia + 1];
        const acz = positions[ic + 2] - positions[ia + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        for (const vertexOffset of [ia, ib, ic]) {
            normals[vertexOffset] += nx;
            normals[vertexOffset + 1] += ny;
            normals[vertexOffset + 2] += nz;
        }
    }
    for (let offset = 0; offset < normals.length; offset += 3) {
        const length = Math.hypot(
            normals[offset],
            normals[offset + 1],
            normals[offset + 2],
        ) || 1;
        normals[offset] /= length;
        normals[offset + 1] /= length;
        normals[offset + 2] /= length;
    }
    return normals;
}

export function emptyUvs(vertexCount) {
    const count = Math.max(0, Math.trunc(Number(vertexCount) || 0));
    return new Float32Array(count * 2);
}

export function localizeXZ(positions, originX, originZ) {
    if (!(positions instanceof Float32Array)) {
        throw new TypeError('positions must be a Float32Array');
    }
    const x0 = Number(originX) || 0;
    const z0 = Number(originZ) || 0;
    for (let offset = 0; offset < positions.length; offset += 3) {
        positions[offset] -= x0;
        positions[offset + 2] -= z0;
    }
    return positions;
}

export function boundsForPositions(positions) {
    if (!(positions instanceof Float32Array) || positions.length < 3 || positions.length % 3 !== 0) {
        throw new TypeError('positions must contain xyz vertices');
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let offset = 0; offset < positions.length; offset += 3) {
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}
