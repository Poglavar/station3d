// Cooperative area-weighted normals across several indexed rail-bar meshes.
//
// Render cells are assembled in bounded segment batches, but polished rail
// heads must shade exactly as if the complete cell had been welded first. This
// pass uses the same position quantisation as indexed-position-weld.js, sums
// Three's unnormalised face cross products by shared position, then writes the
// normalized shared sum back to every batch-local copy.

import * as THREE from 'three';

const DEFAULT_POSITION_TOLERANCE = 1e-4;
const DEFAULT_OPERATIONS_PER_STEP = 512;

function positiveInteger(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
        ? Math.max(1, Math.floor(numeric))
        : fallback;
}

function positionKey(x, y, z, tolerance) {
    const multiplier = 1 / tolerance;
    const additive = tolerance * 0.5 * multiplier;
    // Keep this byte-for-byte aligned with weldIndexedPositions' quantisation.
    return `${Math.trunc(x * multiplier + additive)},`
        + `${Math.trunc(y * multiplier + additive)},`
        + `${Math.trunc(z * multiplier + additive)}`;
}

function geometryBuffers(geometry) {
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.getIndex?.();
    if (!position || position.itemSize !== 3 || !ArrayBuffer.isView(position.array)) {
        throw new TypeError('rail geometry must have a typed xyz position attribute');
    }
    if (!index || !ArrayBuffer.isView(index.array) || index.count % 3 !== 0) {
        throw new TypeError('rail geometry must have a complete typed triangle index');
    }
    return { geometry, position, index };
}

export function* smoothRailHeadNormalsSteps(geometries, {
    tolerance = DEFAULT_POSITION_TOLERANCE,
    operationsPerStep = DEFAULT_OPERATIONS_PER_STEP,
} = {}) {
    const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
    const stepLimit = positiveInteger(operationsPerStep, DEFAULT_OPERATIONS_PER_STEP);
    const descriptors = [];
    const sharedByKey = new Map();
    const sharedVertices = [];
    let operations = 0;
    let triangleCount = 0;

    for (const geometry of geometries || []) {
        const descriptor = geometryBuffers(geometry);
        descriptor.sharedIndices = new Uint32Array(descriptor.position.count);
        descriptors.push(descriptor);
        const positions = descriptor.position.array;
        for (let vertexIndex = 0; vertexIndex < descriptor.position.count; vertexIndex++) {
            const offset = vertexIndex * 3;
            const x = positions[offset];
            const y = positions[offset + 1];
            const z = positions[offset + 2];
            const key = positionKey(x, y, z, safeTolerance);
            let shared = sharedByKey.get(key);
            if (!shared) {
                shared = {
                    index: sharedVertices.length,
                    x,
                    y,
                    z,
                    nx: 0,
                    ny: 0,
                    nz: 0,
                };
                sharedByKey.set(key, shared);
                sharedVertices.push(shared);
            }
            descriptor.sharedIndices[vertexIndex] = shared.index;
            operations += 1;
            if (operations >= stepLimit) {
                operations = 0;
                yield { phase: 'index', sharedVertexCount: sharedVertices.length };
            }
        }
    }

    for (const descriptor of descriptors) {
        const indices = descriptor.index.array;
        for (let offset = 0; offset < descriptor.index.count; offset += 3) {
            const sourceA = indices[offset];
            const sourceB = indices[offset + 1];
            const sourceC = indices[offset + 2];
            if (sourceA >= descriptor.position.count
                || sourceB >= descriptor.position.count
                || sourceC >= descriptor.position.count) {
                throw new RangeError('rail triangle index is outside the position buffer');
            }
            const a = sharedVertices[descriptor.sharedIndices[sourceA]];
            const b = sharedVertices[descriptor.sharedIndices[sourceB]];
            const c = sharedVertices[descriptor.sharedIndices[sourceC]];
            // Three.BufferGeometry.computeVertexNormals():
            // cb = C - B, ab = A - B, face normal = cb x ab.
            const cbx = c.x - b.x;
            const cby = c.y - b.y;
            const cbz = c.z - b.z;
            const abx = a.x - b.x;
            const aby = a.y - b.y;
            const abz = a.z - b.z;
            const nx = cby * abz - cbz * aby;
            const ny = cbz * abx - cbx * abz;
            const nz = cbx * aby - cby * abx;
            // The reference normal attribute is Float32, so round each face
            // accumulation rather than only the final normalized result.
            a.nx = Math.fround(a.nx + nx);
            a.ny = Math.fround(a.ny + ny);
            a.nz = Math.fround(a.nz + nz);
            b.nx = Math.fround(b.nx + nx);
            b.ny = Math.fround(b.ny + ny);
            b.nz = Math.fround(b.nz + nz);
            c.nx = Math.fround(c.nx + nx);
            c.ny = Math.fround(c.ny + ny);
            c.nz = Math.fround(c.nz + nz);
            triangleCount += 1;
            operations += 1;
            if (operations >= stepLimit) {
                operations = 0;
                yield { phase: 'faces', triangleCount };
            }
        }
    }

    for (const descriptor of descriptors) {
        let normal = descriptor.geometry.getAttribute('normal');
        if (!normal || normal.itemSize !== 3 || normal.count !== descriptor.position.count) {
            normal = new THREE.BufferAttribute(
                new Float32Array(descriptor.position.count * 3),
                3,
            );
            descriptor.geometry.setAttribute('normal', normal);
        }
        const normals = normal.array;
        for (let vertexIndex = 0; vertexIndex < descriptor.position.count; vertexIndex++) {
            const shared = sharedVertices[descriptor.sharedIndices[vertexIndex]];
            const length = Math.sqrt(
                shared.nx * shared.nx + shared.ny * shared.ny + shared.nz * shared.nz,
            ) || 1;
            const offset = vertexIndex * 3;
            normals[offset] = shared.nx / length;
            normals[offset + 1] = shared.ny / length;
            normals[offset + 2] = shared.nz / length;
            operations += 1;
            if (operations >= stepLimit) {
                operations = 0;
                yield { phase: 'apply', sharedVertexCount: sharedVertices.length };
            }
        }
        normal.needsUpdate = true;
    }

    return {
        geometryCount: descriptors.length,
        sharedVertexCount: sharedVertices.length,
        triangleCount,
    };
}
