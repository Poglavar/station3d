// Verifies platform-facing doors follow the real waiting crowd on either side
// of a train, including after its direction reverses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPlatformSideSign } from '../core/boarding-platform-side.js';

test('detects crowds on the right and left side of a northbound train', () => {
    const train = { x: 0, z: 0, headingDeg: 0 };
    assert.equal(inferPlatformSideSign(train, [{ x: 4, z: 2 }]), 1);
    assert.equal(inferPlatformSideSign(train, [{ x: -4, z: 2 }]), -1);
});

test('the same physical platform changes vehicle side after reversal', () => {
    const people = [{ x: 4, z: 0 }, { x: 5, z: 2 }];
    assert.equal(inferPlatformSideSign({ x: 0, z: 0, headingDeg: 0 }, people), 1);
    assert.equal(inferPlatformSideSign({ x: 0, z: 0, headingDeg: 180 }, people), -1);
});
