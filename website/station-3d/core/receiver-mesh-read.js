// Capture physical faces from actual receiver meshes in local metres plus an
// explicit scene origin. A private
// root transform lets a rigid structure prepare support without moving its live
// mesh. Rendering and physics retain the same source faces and winding.
import * as THREE from 'three';
import { createReceiverSupportQuerySteps } from './receiver-support-read.js';

export function* captureReceiverMeshReadSteps({ root, rootTransform = null, include,
    revision, maxObjects, maxVertices, maxTriangles, now = () => performance.now(), isCurrent = () => true }) {
    if (!root?.isObject3D || typeof include !== 'function' || !Number.isSafeInteger(revision)
        || ![maxObjects, maxVertices, maxTriangles].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Receiver support requires a root, physical selector and finite capacities');
    }
    const check = () => { if (!isCurrent()) throw Object.assign(new Error('Receiver mesh read expired'), { code: 'ground-generation-stale' }); };
    const fail = () => { throw Object.assign(new Error('Receiver support exceeds its complete geometry capacity'), { code: 'ground-generation-capacity' }); };
    let objects = 0, vertices = 0, triangles = 0, deadline = now() + .5;
    const localMatrix = object => object.matrixAutoUpdate
        ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix;
    const parentMatrix = new THREE.Matrix4(), ancestors = [];
    if (!rootTransform) {
        for (let object = root.parent; object; object = object.parent) {
            check();
            if (now() >= deadline) { yield { phase: 'receiver-support-ancestors' }; check(); deadline = now() + .5; }
            if (++objects > maxObjects) fail();
            ancestors.push(object);
        }
        for (let i = ancestors.length - 1; i >= 0; i--) {
            check();
            if (now() >= deadline) { yield { phase: 'receiver-support-ancestors' }; check(); deadline = now() + .5; }
            parentMatrix.multiply(localMatrix(ancestors[i]));
        }
    }
    const stack = [{ object: root, parent: parentMatrix }], surfaces = [];
    while (stack.length) {
        check();
        if (now() >= deadline) { yield { phase: 'receiver-support-object' }; deadline = now() + .5; }
        const { object, parent } = stack.pop();
        if (++objects > maxObjects) fail();
        const local = object === root && rootTransform ? rootTransform : localMatrix(object);
        const matrix = new THREE.Matrix4().multiplyMatrices(parent, local);
        if (stack.length + object.children.length + objects > maxObjects) fail();
        for (const child of object.children) stack.push({ object: child, parent: matrix });
        if (!object.isMesh || !include(object)) continue;
        if (object.isBatchedMesh || object.isSkinnedMesh) {
            throw new TypeError('Physical batched or skinned receivers require their compiled face read');
        }
        const position = object.geometry?.getAttribute('position'), sourceIndex = object.geometry?.index;
        const sourceIndices = sourceIndex?.array || null;
        if (!position || position.itemSize !== 3 || position.isInterleavedBufferAttribute) throw new TypeError('Receiver requires ordinary xyz positions');
        if (sourceIndex && (sourceIndex.itemSize !== 1 || sourceIndex.isInterleavedBufferAttribute
            || !ArrayBuffer.isView(sourceIndices))) throw new TypeError('Receiver requires ordinary vertex indices');
        const instanceCount = object.isInstancedMesh ? object.count : 1;
        if (!Number.isSafeInteger(instanceCount) || instanceCount < 0
            || object.isInstancedMesh && objects + instanceCount > maxObjects) fail();
        for (let instance = 0; instance < instanceCount; instance++) {
        if (object.isInstancedMesh) objects++;
        const faceMatrix = object.isInstancedMesh ? new THREE.Matrix4() : matrix;
        if (object.isInstancedMesh) {
            object.getMatrixAt(instance, faceMatrix); faceMatrix.premultiply(matrix);
        }
        const determinant = faceMatrix.determinant();
        if (!Number.isFinite(determinant) || determinant === 0) {
            throw Object.assign(new Error('Physical receiver transform is singular'), { code: 'ground-backstop-unavailable' });
        }
        vertices += position.count; triangles += (sourceIndices?.length ?? position.count) / 3;
        if (vertices > maxVertices || triangles > maxTriangles || !Number.isInteger(triangles)) fail();
        // Do not round a translated coast/structure back into scene-space
        // Float32 here. Queries add the origin in double precision; physics
        // rebases directly into its existing local simulation bubble.
        const originX = faceMatrix.elements[12], originZ = faceMatrix.elements[14];
        const storageMatrix = faceMatrix.clone();
        storageMatrix.elements[12] = 0; storageMatrix.elements[14] = 0;
        const positions = new Float32Array(position.count * 3), point = new THREE.Vector3();
        const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (let i = 0; i < position.count; i++) {
            if (now() >= deadline) { yield { phase: 'receiver-support-vertices' }; check(); deadline = now() + .5; }
            point.fromBufferAttribute(position, i).applyMatrix4(storageMatrix);
            if (![point.x, point.y, point.z].every(Number.isFinite)) throw new TypeError('Receiver support contains a nonfinite position');
            positions[i * 3] = point.x; positions[i * 3 + 1] = point.y; positions[i * 3 + 2] = point.z;
            if (Math.max(Math.abs(positions[i * 3] - point.x), Math.abs(positions[i * 3 + 1] - point.y),
                Math.abs(positions[i * 3 + 2] - point.z)) > .001) {
                throw Object.assign(new Error('Receiver transform exceeds one millimetre of storage error'), { code: 'ground-receiver-precision' });
            }
            bounds.minX = Math.min(bounds.minX, positions[i * 3] + originX); bounds.maxX = Math.max(bounds.maxX, positions[i * 3] + originX);
            bounds.minZ = Math.min(bounds.minZ, positions[i * 3 + 2] + originZ); bounds.maxZ = Math.max(bounds.maxZ, positions[i * 3 + 2] + originZ);
        }
        const indexCount = sourceIndices?.length ?? position.count;
        const indices = sourceIndices || determinant < 0 ? new Uint32Array(indexCount) : null;
        let hasPhysicalFace = false;
        for (let i = 0; i < indexCount; i += 3) {
            if (now() >= deadline) { yield { phase: 'receiver-support-indices' }; check(); deadline = now() + .5; }
            const a = sourceIndices?.[i] ?? i, b = sourceIndices?.[i + 1] ?? i + 1, c = sourceIndices?.[i + 2] ?? i + 2;
            if (!Number.isSafeInteger(a) || a < 0 || a >= position.count
                || !Number.isSafeInteger(b) || b < 0 || b >= position.count
                || !Number.isSafeInteger(c) || c < 0 || c >= position.count) {
                throw new TypeError('Invalid physical receiver vertex index');
            }
            if (indices) {
                indices[i] = a; indices[i + 1] = determinant < 0 ? c : b; indices[i + 2] = determinant < 0 ? b : c;
            }
            if (!hasPhysicalFace) {
                const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1];
                const uz = positions[b * 3 + 2] - positions[a * 3 + 2], vx = positions[c * 3] - positions[a * 3];
                const vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
                hasPhysicalFace = uy * vz - uz * vy !== 0 || uz * vx - ux * vz !== 0 || ux * vy - uy * vx !== 0;
            }
        }
        if (hasPhysicalFace) surfaces.push(Object.freeze({ positions, indices, originX, originZ, bounds: Object.freeze(bounds) }));
        }
    }
    check();
    const supportYAt = yield* createReceiverSupportQuerySteps(surfaces, { now, isCurrent });
    return Object.freeze({ revision, surfaces: Object.freeze(surfaces), supportYAt,
        surfacesNear(x, z, radiusM) {
            if (![x, z, radiusM].every(Number.isFinite) || radiusM <= 0) return [];
            return surfaces.filter(({ bounds }) => Math.max(bounds.minX - x, 0, x - bounds.maxX) ** 2
                + Math.max(bounds.minZ - z, 0, z - bounds.maxZ) ** 2 <= radiusM ** 2);
        } });
}
