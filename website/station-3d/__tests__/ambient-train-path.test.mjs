// Verifies ambient trains follow graded paths and use opposite sides by direction.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROJECT_TRACK_SOURCES,
    ROAMING_TRACK_SOURCES,
    legacyTrainRailPoint,
    nearestPointOnAmbientTrainPath,
    offsetAmbientTrainPoseRight,
    prepareAmbientTrainPath,
    projectTrackRailPoint,
    sampleAmbientTrainPathPose,
    selectAmbientTrainTrackFeatures,
} from '../core/ambient-train-path.js';

test('legacy train height belongs to its own path at a grade-separated crossing', () => {
    // terrain + yOff + deckTop. The deckTop term used to be absent, which put the
    // train DECK_TOP_Y below its own rails.
    assert.deepEqual(
        legacyTrainRailPoint({ x: 2, z: 3, yOff: 0.4 }, 1.6, 7.5),
        { x: 2, z: 3, yOff: 0.4, railY: 9.5 },
    );
    const authored = { x: 2, z: 3, railY: -1.5 };
    assert.equal(legacyTrainRailPoint(authored, 12, 7.5), authored);
});

// The three cases the stylized viaduct actually produces. Getting any of them
// wrong parks the train off its track by metres, and only the flat/full-height one
// is visibly wrong — the others bury it, which is why this went unnoticed.
test('legacy train rides the rail head in every viaduct configuration', () => {
    const DECK_TOP_M = 7.5;
    const GROUND_BED_TOP_M = 0.45;
    const groundDrop = -(DECK_TOP_M - GROUND_BED_TOP_M);   // the ground-gate / draped offset

    // Flat world, full-height viaduct: yOff 0, no terrain.
    assert.equal(
        legacyTrainRailPoint({ x: 0, z: 0, yOff: 0 }, 0, DECK_TOP_M).railY,
        DECK_TOP_M,
        'flat full-height viaduct: train must be on the deck, not on the ground',
    );
    // Flat world, south of the ground gate: the deck has come down to a bed.
    assert.ok(Math.abs(
        legacyTrainRailPoint({ x: 0, z: 0, yOff: groundDrop }, 0, DECK_TOP_M).railY
        - GROUND_BED_TOP_M,
    ) < 1e-9, 'ground-gated viaduct: train must ride the lowered bed');
    // Elevation world: same negative offset, but lifted onto the DGU terrain.
    const terrainY = 112.3;
    assert.ok(Math.abs(
        legacyTrainRailPoint({ x: 0, z: 0, yOff: groundDrop }, terrainY, DECK_TOP_M).railY
        - (terrainY + GROUND_BED_TOP_M),
    ) < 1e-9, 'draped line must ride the bed on top of the terrain');
});

test('prepares a clean cumulative path and finds the nearest chainage', () => {
    const path = prepareAmbientTrainPath([
        { x: 0, z: 100, railY: 2 },
        { x: 0, z: 100, railY: 2 },
        { x: 0, z: 40, railY: 5 },
        { x: 80, z: 40, railY: 9 },
    ], {
        kind: 'project',
        minimumLengthM: 100,
    });

    assert.ok(path);
    assert.equal(path.kind, 'project');
    assert.equal(path.points.length, 3);
    assert.equal(path.totalLength, 140);
    assert.deepEqual(path.cumulative, [0, 60, 140]);
    assert.deepEqual(
        nearestPointOnAmbientTrainPath(path, 30, 35),
        { distanceM: 5, s: 90 },
    );
    assert.equal(
        prepareAmbientTrainPath(path.points, { minimumLengthM: 141 }),
        null,
    );
});

test('samples rail height and grade in both travel directions', () => {
    const path = prepareAmbientTrainPath([
        { x: 0, z: 100, railY: 2 },
        { x: 0, z: 0, railY: 7 },
    ]);
    const forward = sampleAmbientTrainPathPose(path, 40, 1);
    const backward = sampleAmbientTrainPathPose(path, 40, -1);

    assert.equal(forward.x, 0);
    assert.equal(forward.z, 60);
    assert.equal(forward.railY, 4);
    assert.ok(Math.abs(forward.heading) < 1e-12);
    assert.ok(forward.pitch > 0);
    assert.ok(Math.abs(Math.abs(backward.heading) - Math.PI) < 1e-12);
    assert.equal(backward.pitch, -forward.pitch);
});

test('right-of-travel offset puts opposing trains on opposite tracks', () => {
    const path = prepareAmbientTrainPath([
        { x: 0, z: 100, railY: 0 },
        { x: 0, z: 0, railY: 0 },
    ]);
    const forward = offsetAmbientTrainPoseRight(
        sampleAmbientTrainPathPose(path, 50, 1),
        1.7,
    );
    const backward = offsetAmbientTrainPoseRight(
        sampleAmbientTrainPathPose(path, 50, -1),
        1.7,
    );

    assert.ok(Math.abs(forward.x - 1.7) < 1e-12);
    assert.ok(Math.abs(backward.x + 1.7) < 1e-12);
    assert.ok(Math.abs(forward.z - backward.z) < 1e-12);
});

test('legacy endpoint extrapolation keeps the guideway deck offset pinned', () => {
    const path = prepareAmbientTrainPath([
        { x: 0, z: 100, yOff: -7 },
        { x: 0, z: 0, yOff: 0 },
    ], { kind: 'legacy' });

    assert.equal(sampleAmbientTrainPathPose(path, -20, 1).yOff, -7);
    assert.equal(sampleAmbientTrainPathPose(path, 120, 1).yOff, 0);
});

test('proposal tracks roam, planner tracks run services — and nothing else rides', () => {
    const line = coordinates => ({ type: 'LineString', coordinates });
    const features = [
        { properties: { source: 'cb-proposal' }, geometry: line([[15.85, 43.75], [15.86, 43.76]]) },
        { properties: { source: 'user' }, geometry: line([[16.0, 45.8], [16.01, 45.81]]) },
        { properties: { source: 'cb-proposal' }, geometry: { type: 'Polygon', coordinates: [] } },
        { properties: {}, geometry: line([[16.0, 45.8], [16.01, 45.81]]) },
        null,
    ];
    const roaming = selectAmbientTrainTrackFeatures(features, ROAMING_TRACK_SOURCES);
    const services = selectAmbientTrainTrackFeatures(features, PROJECT_TRACK_SOURCES);
    assert.equal(roaming.length, 1);
    assert.equal(roaming[0].properties.source, 'cb-proposal');
    assert.equal(services.length, 1);
    assert.equal(services[0].properties.source, 'user');
});

test('the formation seats the roaming train — the bay bridge, not the sea under it', () => {
    // Mid-crossing: terrain is the sea (0 m) while the formation carries the
    // authored deck. The train must ride the deck.
    assert.deepEqual(
        projectTrackRailPoint({ x: 10, z: -20, elevationM: 27.4, elevationMode: 'absolute', formationRailY: 27.45, terrainY: 0 }),
        { x: 10, z: -20, railY: 27.45 },
    );
});

test('absolute heights without a formation are refused, not guessed', () => {
    // Treating EVRF2000 metres as a local lift would hang the train ~2 m or
    // ~100 m above the scene depending on the datum — dropping the point is
    // the only honest answer while the formation model is unavailable.
    assert.equal(
        projectTrackRailPoint({ x: 10, z: -20, elevationM: 27.4, elevationMode: 'absolute', formationRailY: null, terrainY: 0 }),
        null,
    );
});

test('ground-relative and bare coordinates ride terrain plus their own lift', () => {
    assert.deepEqual(
        projectTrackRailPoint({ x: 1, z: 2, elevationM: 6.24, elevationMode: 'ground-relative', terrainY: 15.4 }),
        { x: 1, z: 2, railY: 21.64 },
    );
    assert.deepEqual(
        projectTrackRailPoint({ x: 1, z: 2, terrainY: 15.4 }),
        { x: 1, z: 2, railY: 15.4 },
    );
    assert.equal(
        projectTrackRailPoint({ x: 1, z: 2, elevationM: 6.24, elevationMode: 'ground-relative', terrainY: null }),
        null,
        'a relative train path cannot substitute visual fallback for terrain evidence',
    );
    assert.equal(projectTrackRailPoint({ x: 1, z: 2, terrainY: null }), null);
    assert.equal(projectTrackRailPoint({ x: Number.NaN, z: 2 }), null);
});
