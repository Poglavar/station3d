import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createGtaSkidMarks } from '../world/gta-skid-marks.js';

test('skid marks overwrite a fixed GPU buffer instead of growing scene objects', () => {
    const parent = new THREE.Group();
    const marks = createGtaSkidMarks({ parent, maxSegments: 3 });
    for (let index = 0; index < 8; index += 1) {
        marks.update([{
            wheelIndex: 2,
            surfaceKind: 'asphalt',
            intensity: 1,
            point: { x: 0, y: 0, z: index * 0.25 },
        }]);
    }
    assert.equal(parent.children.length, 1);
    assert.deepEqual(marks.debugState(), {
        segmentCount: 3,
        capacity: 3,
        totalWritten: 7,
    });
    marks.dispose();
    assert.equal(parent.children.length, 0);
});

test('leaving a markable surface breaks the strip instead of bridging a gap', () => {
    const marks = createGtaSkidMarks({ parent: new THREE.Group(), maxSegments: 8 });
    marks.update([{
        wheelIndex: 0,
        surfaceKind: 'asphalt',
        intensity: 1,
        point: { x: 0, y: 0, z: 0 },
    }]);
    marks.update([{
        wheelIndex: 0,
        surfaceKind: null,
        intensity: 1,
        point: { x: 0, y: 0, z: 1 },
    }]);
    marks.update([{
        wheelIndex: 0,
        surfaceKind: 'terrain',
        intensity: 1,
        point: { x: 0, y: 0, z: 2 },
    }]);
    assert.equal(marks.debugState().segmentCount, 0);
    marks.dispose();
});
