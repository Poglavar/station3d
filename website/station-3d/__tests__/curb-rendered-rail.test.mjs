import test from 'node:test';
import assert from 'node:assert/strict';

import { curbTouchesRenderedRailSurfaceAtLocal } from '../core/curb-rendered-rail.js';

function surfaceAtLocal(x, z) {
    if (x < 0.2 || x > 0.6 || z < -1 || z > 1) return null;
    return { sceneY: 2.08 };
}

test('published trackbed removes a same-level curb across its stone profile', () => {
    assert.equal(curbTouchesRenderedRailSurfaceAtLocal({
        x: 0,
        z: 0,
        normalX: 1,
        crossSectionOffsetsM: [0, 0.15, 0.3],
        curbSceneYAtLocal: () => 2,
        renderedRailSurface: { civilGroundSurfaceAtLocal: surfaceAtLocal },
    }), true);
});

test('plan overlap at another elevation cannot erase a carried curb', () => {
    assert.equal(curbTouchesRenderedRailSurfaceAtLocal({
        x: 0,
        z: 0,
        normalX: 1,
        crossSectionOffsetsM: [0, 0.15, 0.3],
        curbSceneYAtLocal: () => 7,
        renderedRailSurface: { civilGroundSurfaceAtLocal: surfaceAtLocal },
    }), false);
});

test('an unpublished or non-overlapping trackbed leaves the curb alone', () => {
    assert.equal(curbTouchesRenderedRailSurfaceAtLocal({
        x: 0,
        z: 0,
        normalX: 1,
        crossSectionOffsetsM: [0, 0.1],
        curbSceneYAtLocal: () => 2,
        renderedRailSurface: null,
    }), false);
    assert.equal(curbTouchesRenderedRailSurfaceAtLocal({
        x: -2,
        z: 0,
        normalX: 1,
        crossSectionOffsetsM: [0, 0.1],
        curbSceneYAtLocal: () => 2,
        renderedRailSurface: { civilGroundSurfaceAtLocal: surfaceAtLocal },
    }), false);
});
