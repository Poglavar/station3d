import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createStaticBatchedMesh } from '../core/static-batched-mesh.js';

test('static parts become one bounded batch and staging geometries are released', () => {
    const material = new THREE.MeshBasicMaterial();
    const first = new THREE.BoxGeometry(1, 2, 3);
    const second = new THREE.CylinderGeometry(1, 1.2, 0.5, 8);
    let disposed = 0;
    first.addEventListener('dispose', () => { disposed += 1; });
    second.addEventListener('dispose', () => { disposed += 1; });
    const firstMatrix = new THREE.Matrix4().makeTranslation(10, 2, -4);
    const secondMatrix = new THREE.Matrix4().makeTranslation(-3, 1, 8);

    const batch = createStaticBatchedMesh([
        { geometry: first, matrix: firstMatrix },
        { geometry: second, matrix: secondMatrix },
    ], {
        material,
        name: 'ExactStaticProps',
        castShadow: true,
        receiveShadow: true,
    });

    assert.ok(batch?.isBatchedMesh);
    assert.equal(batch.name, 'ExactStaticProps');
    assert.equal(batch._instanceInfo.length, 2);
    assert.equal(batch.castShadow, true);
    assert.equal(batch.receiveShadow, true);
    assert.equal(batch.sortObjects, false);
    assert.equal(batch.perObjectFrustumCulled, true);
    assert.ok(batch.boundingBox);
    assert.ok(batch.boundingSphere);
    assert.equal(disposed, 2, 'all staging geometry is copied and then disposed');

    const actual = new THREE.Matrix4();
    batch.getMatrixAt(0, actual);
    assert.deepEqual(actual.elements, firstMatrix.elements);
    batch.getMatrixAt(1, actual);
    assert.deepEqual(actual.elements, secondMatrix.elements);
    batch.dispose();
    material.dispose();
});

test('an empty batch is a no-op', () => {
    const material = new THREE.MeshBasicMaterial();
    assert.equal(createStaticBatchedMesh([], { material }), null);
    material.dispose();
});
