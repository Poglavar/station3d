// Verifies elevation-mode layer selection without importing THREE or the scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { includeSurfaceLayerInElevationMode } from '../core/session-layer-policy.js';

test('elevation mode retains the ordinary project and ambient layers', () => {
    assert.equal(includeSurfaceLayerInElevationMode('referenceRail'), true);
    assert.equal(includeSurfaceLayerInElevationMode('ambientTrains'), true);
    assert.equal(includeSurfaceLayerInElevationMode('rails'), true);
});
