// Verifies that decor and other lightweight props sit on DGU terrain and use
// an engineered road formation only when their point is inside a road surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    drapePositionArray,
    evidencePlacementBaseSceneY,
    evidencePlacementSceneY,
    placementBaseSceneY,
    placementSceneY,
} from '../core/terrain-placement.js';

const roadFormation = {
    surfaceAtLocal: (x, z) => (Math.abs(x) <= 5 && Math.abs(z) <= 3 ? { osmId: 'road-1' } : null),
    sceneYAtLocal: (x) => 20 + x,
};
const terrain = {
    roadFormation,
    sceneYAtLocal: (x, z) => x * 0.5 + z * 2,
};

test('uses bare terrain by default and adds a placement offset', () => {
    assert.equal(placementBaseSceneY(terrain, 2, 3), 7);
    assert.equal(placementSceneY(terrain, 2, 3, 0.014), 7.014);
});

test('uses a road formation only for points inside its surface polygon', () => {
    assert.equal(placementBaseSceneY(terrain, 2, 1, { preferRoadSurface: true }), 22);
    assert.equal(placementBaseSceneY(terrain, 8, 1, { preferRoadSurface: true }), 6);
});

test('drapes every non-indexed vertex while preserving its local offset', () => {
    assert.deepEqual(
        Array.from(drapePositionArray([
            0, 0.02, 0,
            2, 0.03, 1,
        ], terrain)).map((value) => Number(value.toFixed(3))),
        [0, 0.02, 0, 2, 3.03, 1],
    );
});

test('static placement distinguishes genuine evidence from visual fallback', () => {
    const evidenceTerrain = {
        sceneYAtLocal: () => 99,
        evidenceSceneYAtLocal: (x) => (x < 5 ? 7 : null),
    };
    assert.equal(evidencePlacementBaseSceneY(null, 10, 10), 0,
        'an intentional terrain-free world has an explicit scene-zero datum');
    assert.equal(evidencePlacementBaseSceneY(evidenceTerrain, 2, 3), 7);
    assert.equal(evidencePlacementSceneY(evidenceTerrain, 2, 3, 0.25), 7.25);
    assert.equal(evidencePlacementBaseSceneY(evidenceTerrain, 8, 3), null,
        'visible fallback must not become a static placement height');
});

test('static road placement still requires terrain evidence', () => {
    const evidenceTerrain = {
        evidenceSceneYAtLocal: (x) => (x < 5 ? 4 : null),
        roadFormation: {
            surfaceAtLocal: () => ({ osmId: 'road-1' }),
            sceneYAtLocal: () => 12,
        },
    };
    assert.equal(evidencePlacementBaseSceneY(
        evidenceTerrain,
        2,
        3,
        { preferRoadSurface: true },
    ), 12);
    assert.equal(evidencePlacementBaseSceneY(
        evidenceTerrain,
        8,
        3,
        { preferRoadSurface: true },
    ), null);
});

test('presentation placement can use the published road generation without forcing a rebuild', () => {
    let synchronousQueries = 0;
    let publishedQueries = 0;
    const evidenceTerrain = {
        evidenceSceneYAtLocal: () => 4,
        roadFormation: {
            surfaceAtLocal: () => {
                synchronousQueries += 1;
                return { osmId: 'dirty-road' };
            },
            publishedSurfaceAtLocal: () => {
                publishedQueries += 1;
                return { osmId: 'published-road' };
            },
            sceneYAtLocal: (_x, _z, options) => (
                options?.osmId === 'published-road' ? 12 : 99
            ),
        },
    };
    assert.equal(evidencePlacementBaseSceneY(
        evidenceTerrain,
        2,
        3,
        {
            preferRoadSurface: true,
            preferPublishedRoadSurface: true,
        },
    ), 12);
    assert.equal(publishedQueries, 1);
    assert.equal(synchronousQueries, 0,
        'a presentation frame may not synchronously build a dirty road formation');
});
