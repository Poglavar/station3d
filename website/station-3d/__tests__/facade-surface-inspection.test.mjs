// Keeps the former building-only Shift+click face-bucket diagnostics intact
// after they moved into the general scene inspector panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { analyzeFacadeSurfaceGeometry } from '../core/facade-surface-inspection.js';

function diagnosticGeometry() {
    const triangles = [
        // Hit face and its coplanar sibling.
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 1, 1, 0, 0, 1, 0,
        // Same-facing near plane in a neighbouring quantized bucket.
        0, 0, 0.12, 1, 0, 0.12, 0, 1, 0.12,
        // Opposite-facing near plane (thick-wall front/back candidate).
        0, 0, 0.3, 0, 1, 0.3, 1, 0, 0.3,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    return geometry;
}

test('facade inspection recovers the face and diagnoses nearby parallel planes', () => {
    const result = analyzeFacadeSurfaceGeometry(diagnosticGeometry(), 0);

    assert.equal(result.status, 'analysed');
    assert.equal(result.meshTriangleCount, 4);
    assert.equal(result.recoveredFaceTriangleCount, 2);
    assert.deepEqual(result.sameBucketTriangleIndices, [1]);
    assert.equal(result.nearCoplanarCount, 2);
    assert.equal(result.probableThickWallPairs, 1);
    assert.equal(result.probableBucketFragmentation, 1);
    assert.equal(result.highlightTriangles.length, 2);
});

test('facade inspection respects an owning range in merged geometry', () => {
    const result = analyzeFacadeSurfaceGeometry(diagnosticGeometry(), 0, {
        range: { start: 0, count: 6 },
    });

    assert.equal(result.status, 'analysed');
    assert.equal(result.scannedTriangleCount, 2);
    assert.equal(result.recoveredFaceTriangleCount, 2);
    assert.equal(result.nearCoplanarCount, 0);
});

test('facade inspection rejects a hit outside its entity range', () => {
    const result = analyzeFacadeSurfaceGeometry(diagnosticGeometry(), 3, {
        range: { start: 0, count: 6 },
    });

    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /owning entity range/);
});
