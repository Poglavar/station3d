// Regression coverage for observer-height-aware photo-source suspension.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSuspendPhotoSource } from '../core/photo-source-suspension.js';

test('an underground cab suspends the exterior source', () => {
    assert.equal(shouldSuspendPhotoSource({
        insideTunnelCore: true,
        tunnelFloorY: 0,
        observerY: 2,
        sourceRoofOffsetM: 7.45,
    }), true);
});

test('a walker flying above the same tunnel keeps the exterior source active', () => {
    assert.equal(shouldSuspendPhotoSource({
        insideTunnelCore: true,
        tunnelFloorY: 0,
        observerY: 12,
        sourceRoofOffsetM: 7.45,
    }), false);
});

test('invalid or non-core observations never suspend the source', () => {
    assert.equal(shouldSuspendPhotoSource({
        insideTunnelCore: false,
        tunnelFloorY: 0,
        observerY: 2,
        sourceRoofOffsetM: 7.45,
    }), false);
    assert.equal(shouldSuspendPhotoSource({
        insideTunnelCore: true,
        tunnelFloorY: 0,
        observerY: null,
        sourceRoofOffsetM: 7.45,
    }), false);
});
