// Keeps rendered asphalt and vehicle tyre-contact roots on one semantic stack.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GROUND_SURFACE_LEVELS,
    roadSurfaceSceneOffset,
} from '../world/ground-surface-levels.js';

test('road surface offsets preserve the renderer hierarchy used by vehicle roots', () => {
    assert.equal(
        roadSurfaceSceneOffset('residential'),
        GROUND_SURFACE_LEVELS.ordinaryRoadBase
            + 2 * GROUND_SURFACE_LEVELS.ordinaryRoadStep,
    );
    assert.ok(roadSurfaceSceneOffset('primary') > roadSurfaceSceneOffset('residential'));
    assert.equal(
        roadSurfaceSceneOffset('cycleway'),
        GROUND_SURFACE_LEVELS.cycleway,
    );
    assert.equal(
        roadSurfaceSceneOffset('secondary', 'tram'),
        GROUND_SURFACE_LEVELS.tramCorridor,
    );
});
