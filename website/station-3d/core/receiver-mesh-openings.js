// Clip detached civil meshes before publication. Local transforms and material
// attributes survive; affected instance batches remain one draw, with exact faces.
import * as THREE from 'three';
import { clipReceiverOpeningsSteps } from './receiver-opening-geometry.js';
import { createGeometryBatcher } from './geometry-batch.js';

const ATTRIBUTES = Object.freeze({ position: ['positions', 3], normal: ['normals', 3],
    uv: ['uvs', 2], color: ['colors', 3] });
const fail = message => { throw Object.assign(new Error(message), { code: 'ground-generation-capacity' }); };

export function* clipReceiverMeshOpeningsSteps({ mesh, worldMatrix, openingRead,
    maxObjects, maxVertices, maxTriangles, maxGeometryBytes,
    now = () => performance.now(), isCurrent = () => true }) {
    if (!mesh?.isMesh || !worldMatrix?.isMatrix4 || !openingRead
        || ![maxObjects, maxVertices, maxTriangles, maxGeometryBytes].every(n => Number.isSafeInteger(n) && n > 0)) {
        throw new TypeError('Mesh clipping requires a complete detached receiver and capacities');
    }
    const check = () => {
        if (!isCurrent() || !openingRead.isCurrent()) throw Object.assign(new Error('Receiver mesh opening expired'),
            { code: 'ground-generation-stale' });
    };
    check();
    if (openingRead.empty) return mesh;
    if (mesh.isSkinnedMesh || mesh.isBatchedMesh || Array.isArray(mesh.material) || mesh.instanceColor
        || Object.keys(mesh.geometry.morphAttributes).length) {
        throw new TypeError('Civil opening compiler requires static meshes with one material');
    }
    const source = {};
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        const layout = ATTRIBUTES[name];
        if (!layout || attribute.itemSize !== layout[1] || attribute.isInterleavedBufferAttribute || attribute.normalized) {
            throw new TypeError(`Unsupported civil receiver attribute ${name}`);
        }
        source[layout[0]] = attribute.array;
    }
    if (!source.positions) throw new TypeError('Civil receiver lacks positions');
    source.indices = mesh.geometry.index?.array ?? null;
    const count = source.indices?.length ?? source.positions.length / 3;
    if (mesh.geometry.drawRange.start !== 0 || mesh.geometry.drawRange.count < count) {
        throw new TypeError('Civil receiver requires its complete source draw range');
    }
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    if (!Number.isSafeInteger(instances) || instances < 0 || instances > maxObjects) fail('Civil instance capacity exceeded');
    const pieces = [];
    let changed = false, vertices = 0, triangles = 0, bytes = 0;
    for (let index = 0; index < instances; index++) {
        check();
        const instance = new THREE.Matrix4();
        if (mesh.isInstancedMesh) mesh.getMatrixAt(index, instance);
        const transform = new THREE.Matrix4().multiplyMatrices(worldMatrix, instance);
        if (!Number.isFinite(transform.determinant()) || transform.determinant() === 0) {
            throw new TypeError('Civil receiver transform is singular');
        }
        const clipped = yield* clipReceiverOpeningsSteps({ geometry: source, openingRead,
            claim: mesh.userData.surfaceClaim ?? mesh.material.userData.surfaceClaim,
            worldMatrix: transform.elements, maxVertices, maxTriangles, now, isCurrent });
        changed ||= (clipped.topology?.changedTriangles ?? 0) > 0;
        vertices += clipped.positions.length / 3;
        triangles += (clipped.indices?.length ?? clipped.positions.length / 3) / 3;
        for (const [name] of Object.values(ATTRIBUTES)) bytes += clipped[name]?.byteLength ?? 0;
        bytes += clipped.indices?.byteLength ?? 0;
        if (vertices > maxVertices || triangles > maxTriangles || bytes > maxGeometryBytes) fail('Clipped civil receiver capacity exceeded');
        pieces.push({ geometry: clipped, instance });
        yield { phase: 'receiver-mesh-opening-instance' }; check();
    }
    if (!changed) return mesh;
    let output = pieces[0]?.geometry;
    if (mesh.isInstancedMesh) {
        const batch = createGeometryBatcher();
        let assembly = null;
        try {
            for (const { geometry, instance } of pieces) {
                const attributes = {}, normalMatrix = new THREE.Matrix3().getNormalMatrix(instance);
                let deadline = now() + .5;
                for (const [name, [key, size]] of Object.entries(ATTRIBUTES)) if (geometry[key]) {
                    if (name !== 'position' && name !== 'normal') { attributes[name] = geometry[key]; continue; }
                    const input = geometry[key], values = new Float32Array(input.length), point = new THREE.Vector3();
                    for (let offset = 0; offset < input.length; offset += size) {
                        if (now() >= deadline) { yield { phase: 'receiver-mesh-opening-transform' }; check(); deadline = now() + .5; }
                        point.fromArray(input, offset);
                        if (name === 'position') point.applyMatrix4(instance); else point.applyNormalMatrix(normalMatrix);
                        point.toArray(values, offset);
                        if (name === 'position' && Math.max(Math.abs(values[offset] - point.x), Math.abs(values[offset + 1] - point.y),
                            Math.abs(values[offset + 2] - point.z)) > .001) {
                            throw Object.assign(new Error('Civil instance storage exceeds one millimetre'), { code: 'ground-receiver-precision' });
                        }
                    }
                    attributes[name] = values;
                }
                let index = geometry.indices;
                if (instance.determinant() < 0) {
                    index = new Uint32Array(index ?? attributes.position.length / 3);
                    for (let offset = 0; offset < index.length; offset += 3) {
                        if (now() >= deadline) { yield { phase: 'receiver-mesh-opening-indices' }; check(); deadline = now() + .5; }
                        index[offset] = geometry.indices?.[offset] ?? offset;
                        index[offset + 1] = geometry.indices?.[offset + 2] ?? offset + 2;
                        index[offset + 2] = geometry.indices?.[offset + 1] ?? offset + 1;
                    }
                }
                batch.addPart('receiver', 'instances', { attributes, ...(index ? { index } : {}) });
            }
            assembly = batch.beginAssembly('receiver', { now, valuesPerStage: 4096, partsPerStage: 1,
                admitBytes(total) { if (total > maxGeometryBytes) fail('Civil instance assembly capacity exceeded'); return true; } });
            while (!assembly.step(.5)) { yield { phase: 'receiver-mesh-opening-merge' }; check(); }
            const merged = assembly.result();
            output = { indices: merged.index };
            for (const [name, [key]] of Object.entries(ATTRIBUTES)) if (merged.attributes[name]) output[key] = merged.attributes[name];
        } finally { assembly?.cancel(); batch.clear(); }
    }
    check();
    const geometry = new THREE.BufferGeometry();
    for (const [name, [key, size]] of Object.entries(ATTRIBUTES)) if (output[key]) {
        geometry.setAttribute(name, new THREE.BufferAttribute(output[key], size));
    }
    if (output.indices) geometry.setIndex(new THREE.BufferAttribute(output.indices, 1));
    const bounds = new THREE.Box3(), point = new THREE.Vector3();
    let deadline = now() + .5;
    for (let offset = 0; offset < output.positions.length; offset += 3) {
        if (now() >= deadline) { yield { phase: 'receiver-mesh-opening-bounds' }; check(); deadline = now() + .5; }
        bounds.expandByPoint(point.fromArray(output.positions, offset));
    }
    geometry.boundingBox = bounds;
    geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    const result = new THREE.Mesh().copy(mesh, false);
    result.geometry = geometry;
    // Old explicit boxes cannot describe a cut mesh. Its captured triangles
    // supply physical support; callers must migrate that family atomically.
    delete result.userData.walkColliderBoxes;
    return result;
}
