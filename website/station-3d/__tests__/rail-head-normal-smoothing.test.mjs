import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

import { weldIndexedPositions } from '../core/indexed-position-weld.js';
import { smoothRailHeadNormalsSteps } from '../core/rail-head-normal-smoothing.js';

const railsSource = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');

function stripGeometry(positions) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 3, 0, 3, 1]), 1));
    geometry.computeVertexNormals();
    return geometry;
}

function wholeWeldedReference(geometries) {
    const positions = [];
    const indices = [];
    let vertexOffset = 0;
    for (const geometry of geometries) {
        positions.push(...geometry.getAttribute('position').array);
        for (const index of geometry.getIndex().array) indices.push(index + vertexOffset);
        vertexOffset += geometry.getAttribute('position').count;
    }
    const welded = weldIndexedPositions(
        new Float32Array(positions),
        new Uint32Array(indices),
        1e-4,
    );
    const reference = new THREE.BufferGeometry();
    reference.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    reference.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    reference.computeVertexNormals();
    return { reference, welded };
}

function referenceNormalAt(reference, x, y, z) {
    const positions = reference.getAttribute('position');
    const normals = reference.getAttribute('normal');
    for (let index = 0; index < positions.count; index++) {
        if (Math.abs(positions.getX(index) - x) < 1e-6
            && Math.abs(positions.getY(index) - y) < 1e-6
            && Math.abs(positions.getZ(index) - z) < 1e-6) {
            return [normals.getX(index), normals.getY(index), normals.getZ(index)];
        }
    }
    assert.fail(`reference has no vertex at ${x},${y},${z}`);
}

function assertVectorClose(actual, expected, message) {
    for (let axis = 0; axis < 3; axis++) {
        assert.ok(
            Math.abs(actual[axis] - expected[axis]) < 1e-6,
            `${message} axis ${axis}: ${actual[axis]} != ${expected[axis]}`,
        );
    }
}

test('split curved rail heads match one whole-cell welded normal solve', () => {
    const first = stripGeometry([
        0, 0, -0.5,
        0, 0, 0.5,
        1, 0, -0.5,
        1, 0, 0.5,
    ]);
    const second = stripGeometry([
        // Deliberate batch-local duplicates of the first strip's endpoint.
        1, 0, -0.5,
        1, 0, 0.5,
        3, 1.2, -0.1,
        2.6, 1.2, 1.1,
    ]);
    const beforeA = first.getAttribute('normal');
    const beforeB = second.getAttribute('normal');
    assert.ok(
        Math.abs(beforeA.getY(2) - beforeB.getY(0)) > 0.1,
        'the independent batch normals must expose the seam before smoothing',
    );
    // Cell batches intentionally skip their local normal solve; cover the
    // production path where the cooperative pass creates the attributes.
    first.deleteAttribute('normal');
    second.deleteAttribute('normal');

    const { reference, welded } = wholeWeldedReference([first, second]);
    assert.equal(welded.sourceVertexCount, 8);
    assert.equal(welded.weldedVertexCount, 6, 'the whole-cell reference welds both joint copies');

    const iterator = smoothRailHeadNormalsSteps([first, second], { operationsPerStep: 2 });
    let outcome = iterator.next();
    let yields = 0;
    while (!outcome.done) {
        yields += 1;
        outcome = iterator.next();
    }
    assert.ok(yields > 3, 'the normal solve yields through indexing, faces, and application');

    for (const geometry of [first, second]) {
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        for (let index = 0; index < positions.count; index++) {
            const expected = referenceNormalAt(
                reference,
                positions.getX(index),
                positions.getY(index),
                positions.getZ(index),
            );
            assertVectorClose(
                [normals.getX(index), normals.getY(index), normals.getZ(index)],
                expected,
                `normal ${index}`,
            );
        }
    }
    assertVectorClose(
        [first.getAttribute('normal').getX(2), first.getAttribute('normal').getY(2), first.getAttribute('normal').getZ(2)],
        [second.getAttribute('normal').getX(0), second.getAttribute('normal').getY(0), second.getAttribute('normal').getZ(0)],
        'duplicate joint vertices share one smoothed normal',
    );
});

// The production cell compiler's normal-stage ordering and cancellation are
// covered by rail-build-reporting and gta-ground-publication behavioral tests.
