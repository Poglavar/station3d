// Regression coverage for consolidating station-local crowds under one root.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { platformPeopleInTargetFrame } from '../core/platform-people-frame.js';

function assertNear(actual, expected, label) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `${label}: expected ${expected}, got ${actual}`,
    );
}

test('platform crowd consolidation retains the station terrain offset', () => {
    const targetWorld = new THREE.Matrix4().makeTranslation(100, 7, -30);
    const stationInTarget = new THREE.Matrix4().makeTranslation(20, -9, 4);
    const sourceWorld = targetWorld.clone().multiply(stationInTarget);
    const source = [{
        stopKey: 'surface-stop',
        x: 1,
        y: 0.06,
        z: 2,
        yaw: 0.25,
        kind: 'male',
    }];

    const [person] = platformPeopleInTargetFrame(source, sourceWorld, targetWorld);

    assertNear(person.x, 21, 'x');
    assertNear(person.y, -8.94, 'y');
    assertNear(person.z, 6, 'z');
    assertNear(person.yaw, 0.25, 'yaw');
    assert.equal(person.stopKey, 'surface-stop');
    assert.equal(person.kind, 'male');
    assert.notEqual(person, source[0], 'the immutable source record is not reused');
    assert.equal(source[0].y, 0.06, 'the source record is not mutated');
});

test('platform crowd consolidation retains a station yaw relative to its root', () => {
    const targetWorld = new THREE.Matrix4()
        .makeRotationY(-0.4)
        .setPosition(13, 2, -8);
    const stationInTarget = new THREE.Matrix4()
        .makeRotationY(Math.PI / 2)
        .setPosition(4, 3, 5);
    const sourceWorld = targetWorld.clone().multiply(stationInTarget);

    const [person] = platformPeopleInTargetFrame(
        [{ x: 0, y: 0, z: 0, yaw: 0.2 }],
        sourceWorld,
        targetWorld,
    );

    assertNear(person.x, 4, 'x');
    assertNear(person.y, 3, 'y');
    assertNear(person.z, 5, 'z');
    assertNear(person.yaw, 0.2 + Math.PI / 2, 'yaw');
});

test('an empty platform crowd stays empty', () => {
    const identity = new THREE.Matrix4();
    assert.deepEqual(platformPeopleInTargetFrame([], identity, identity), []);
});
