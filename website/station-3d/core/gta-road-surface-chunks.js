// Partition already-built road triangles into bounded, independent meshes.

const DEFAULTS = {
    maxTrianglesPerMesh: 4096,
    trianglesPerStep: 128,
    maxTriangles: 65536,
    maxMeshes: 96,
    maxSurfaces: 96,
};

function limit(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function checkSurface(surface, number) {
    const vertices = surface?.vertices;
    const indices = surface?.indices;
    if (!(vertices instanceof Float32Array)) throw new TypeError(`surface ${number} vertices must be Float32Array`);
    if (!(indices instanceof Uint8Array || indices instanceof Uint16Array || indices instanceof Uint32Array)) {
        throw new TypeError(`surface ${number} indices must be Uint8Array, Uint16Array, or Uint32Array`);
    }
    if (vertices.length % 3 !== 0 || indices.length % 3 !== 0) throw new RangeError(`surface ${number} has incomplete coordinates or triangle`);
    if (surface.minY !== undefined && !Number.isFinite(surface.minY)) throw new RangeError(`surface ${number} minY must be finite`);
    if (surface.maxY !== undefined && !Number.isFinite(surface.maxY)) throw new RangeError(`surface ${number} maxY must be finite`);
    return indices.length / 3;
}

export function* partitionRoadSurfaceMeshesSteps(surfaces, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const perMesh = limit(config.maxTrianglesPerMesh, 'maxTrianglesPerMesh');
    const perStep = limit(config.trianglesPerStep, 'trianglesPerStep');
    const totalLimit = limit(config.maxTriangles, 'maxTriangles');
    const meshLimit = limit(config.maxMeshes, 'maxMeshes');
    const surfaceLimit = limit(config.maxSurfaces, 'maxSurfaces');
    if (!Array.isArray(surfaces)) throw new TypeError('surfaces must be an array');
    if (surfaces.length > surfaceLimit) throw new RangeError(`road surface count exceeded (${surfaces.length} > ${surfaceLimit})`);

    let total = 0;
    let examined = 0;
    for (let i = 0; i < surfaces.length; i++) {
        const count = checkSurface(surfaces[i], i);
        total += count;
        if (total > totalLimit) throw new RangeError(`road surface triangle budget exceeded (${total} > ${totalLimit})`);
        if (Math.ceil(total / perMesh) > meshLimit) throw new RangeError('road surface mesh budget exceeded');
    }
    for (let i = 0; i < surfaces.length; i++) {
        const { vertices, indices } = surfaces[i];
        for (let offset = 0; offset < indices.length; offset += 3) {
            for (const index of [indices[offset], indices[offset + 1], indices[offset + 2]]) {
                if (!Number.isSafeInteger(index) || index < 0 || index >= vertices.length / 3) {
                    throw new RangeError(`surface ${i} contains an invalid index`);
                }
                const p = index * 3;
                if (!Number.isFinite(vertices[p]) || !Number.isFinite(vertices[p + 1]) || !Number.isFinite(vertices[p + 2])) {
                    throw new RangeError(`surface ${i} contains non-finite coordinates`);
                }
            }
            examined++;
            if (examined % perStep === 0) yield { phase: 'road-surface-validation', examinedTriangles: examined };
        }
    }
    const meshes = [];
    let meshVertices = [], meshIndices = [], minY = Infinity, maxY = -Infinity;
    let copied = 0;
    const flush = () => {
        if (!meshIndices.length) return;
        meshes.push({ vertices: new Float32Array(meshVertices), indices: new Uint32Array(meshIndices), triangleCount: meshIndices.length / 3,
            minY: Number.isFinite(minY) ? minY : null, maxY: Number.isFinite(maxY) ? maxY : null });
        meshVertices = []; meshIndices = []; minY = Infinity; maxY = -Infinity;
    };
    for (const surface of surfaces) {
        const { vertices, indices } = surface;
        for (let offset = 0; offset < indices.length; offset += 3) {
            const base = meshVertices.length / 3;
            for (const index of [indices[offset], indices[offset + 1], indices[offset + 2]]) {
                const p = index * 3;
                meshVertices.push(vertices[p], vertices[p + 1], vertices[p + 2]);
                minY = Math.min(minY, vertices[p + 1]); maxY = Math.max(maxY, vertices[p + 1]);
            }
            meshIndices.push(base, base + 1, base + 2);
            copied++;
            if (meshIndices.length / 3 === perMesh) flush();
            if (copied % perStep === 0) yield { phase: 'road-surface-copy', copiedTriangles: copied };
        }
    }
    flush();
    return meshes;
}
