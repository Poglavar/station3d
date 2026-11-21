// Verifies ambient routes cannot jump across narrow forbidden water surfaces.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    routeCrossesForbiddenSurface,
    segmentCrossesForbiddenSurface,
} from '../core/pedestrian-surface-routing.js';

const waterStrip = (x) => x >= 4.4 && x <= 5.6;

test('segment sampling catches water between dry endpoints', () => {
    assert.equal(segmentCrossesForbiddenSurface(
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        waterStrip,
        { sampleSpacingM: 0.5 },
    ), true);
    assert.equal(segmentCrossesForbiddenSurface(
        { x: 0, z: 2 },
        { x: 4, z: 2 },
        waterStrip,
        { sampleSpacingM: 0.5 },
    ), false);
});

test('multi-leg route rejects any leg that crosses water', () => {
    assert.equal(routeCrossesForbiddenSurface(
        { x: 0, z: 0 },
        [{ x: 3, z: 0 }, { x: 8, z: 0 }],
        waterStrip,
        { sampleSpacingM: 0.5 },
    ), true);
});
