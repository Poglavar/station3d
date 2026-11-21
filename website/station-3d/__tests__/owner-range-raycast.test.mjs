import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { createOwnerRangeRaycast } from '../core/owner-range-raycast.js';

function scene({ indexed = true, count = 5 } = {}) {
    const batcher = createGeometryBatcher();
    for (let i = 0; i < count; i++) {
        const part = new THREE.BoxGeometry(2, 2 + i % 3, 2);
        part.translate((i - Math.floor(count / 2)) * 4 + 2, i % 2, 0);
        const geometry = indexed ? part : part.toNonIndexed();
        batcher.addPart('buildings', `building:${i}`, {
            attributes: Object.fromEntries(['position', 'normal', 'uv'].map(name =>
                [name, geometry.getAttribute(name).array])),
            ...(geometry.index ? { index: geometry.index.array } : {}),
        });
    }
    const task = batcher.beginAssembly('buildings', { includeBounds: true, includeOwnerBounds: true });
    while (!task.step(Infinity)) { /* complete cooperative fixture assembly */ }
    const assembled = task.result(), geometry = new THREE.BufferGeometry();
    for (const [name, values] of Object.entries(assembled.attributes)) {
        geometry.setAttribute(name, new THREE.BufferAttribute(values, name === 'uv' ? 2 : 3));
    }
    if (assembled.index) geometry.setIndex(new THREE.BufferAttribute(assembled.index, 1));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    return { mesh, ranges: assembled.ranges };
}

function sample(mesh, ray, accelerated) {
    const hits = [];
    accelerated.call(mesh, ray, hits);
    return hits.sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex).map(hit => {
        assert.equal(hit.object, mesh, 'picking still reports the real rendered mesh');
        return {
            distance: hit.distance, point: hit.point.toArray(), faceIndex: hit.faceIndex,
            materialIndex: hit.face.materialIndex,
            uv: hit.uv?.toArray(), normal: hit.normal?.toArray(),
        };
    });
}

for (const indexed of [true, false]) test(`owner bounds preserve native hits (${indexed ? 'indexed' : 'nonindexed'})`, () => {
    const { mesh, ranges } = scene({ indexed });
    const accelerated = createOwnerRangeRaycast(ranges);
    for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
        mesh.material.side = side;
        for (let x = -9; x <= 11; x += 0.5) for (const z of [-1, 0.25, 1]) {
            for (const direction of [-1, 1]) {
                const ray = new THREE.Raycaster(new THREE.Vector3(x, -10 * direction, z),
                    new THREE.Vector3(0, direction, 0), 0.1, 25);
                assert.deepEqual(sample(mesh, ray, accelerated), sample(mesh, ray, THREE.Mesh.prototype.raycast));
            }
        }
    }
    assert.deepEqual(mesh.geometry.drawRange, { start: 0, count: Infinity });
});

test('transformed meshes, material groups, limited draw ranges and ray distances retain native results', () => {
    const { mesh, ranges } = scene();
    mesh.position.set(12, 5, -8); mesh.rotation.set(0.2, 0.5, -0.15); mesh.scale.set(2, 0.7, 1.2);
    mesh.updateMatrixWorld(true);
    mesh.material = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })];
    ranges.forEach((range, i) => mesh.geometry.addGroup(range.start, range.count, i % 2));
    const accelerated = createOwnerRangeRaycast(ranges);
    for (const [start, count] of [[0, Infinity], [ranges[1].start, ranges[1].count], [3, 60], [0, 0]]) {
        mesh.geometry.setDrawRange(start, count);
        for (let x = -9; x < 12; x += 0.5) for (const [near, far] of [[0, 100], [1, 5], [10, 15]]) {
            const origin = new THREE.Vector3(x, 10, 0).applyMatrix4(mesh.matrixWorld);
            const direction = new THREE.Vector3(0, -1, 0).transformDirection(mesh.matrixWorld);
            const ray = new THREE.Raycaster(origin, direction, near, far);
            assert.deepEqual(sample(mesh, ray, accelerated), sample(mesh, ray, THREE.Mesh.prototype.raycast));
            assert.deepEqual(mesh.geometry.drawRange, { start, count });
        }
    }
});

test('native triangle work excludes disjoint buildings over an empty street', () => {
    const { mesh, ranges } = scene({ count: 200 });
    let vertices = 0;
    const readVertex = mesh.getVertexPosition;
    mesh.getVertexPosition = function (...args) { vertices++; return readVertex.apply(this, args); };
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    assert.deepEqual(sample(mesh, ray, THREE.Mesh.prototype.raycast), []);
    assert.equal(vertices, 200 * 12 * 3, 'the ordinary merged-mesh query tests every triangle');
    vertices = 0;
    assert.deepEqual(sample(mesh, ray, createOwnerRangeRaycast(ranges)), []);
    assert.equal(vertices, 0, 'the empty street needs no building triangle intersections');
});

test('a native raycast failure cannot change the subsequent render range', () => {
    const { mesh, ranges } = scene();
    mesh.getVertexPosition = () => { throw new Error('intersection failed'); };
    const range = { start: 0, count: 120 };
    mesh.geometry.setDrawRange(range.start, range.count);
    const ray = new THREE.Raycaster(new THREE.Vector3(-6, 10, 0), new THREE.Vector3(0, -1, 0));
    assert.throws(() => createOwnerRangeRaycast(ranges).call(mesh, ray, []), /intersection failed/);
    assert.deepEqual(mesh.geometry.drawRange, range);
});
