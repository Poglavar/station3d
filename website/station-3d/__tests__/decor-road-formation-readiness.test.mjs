// Decor is an async derived layer. It must never turn a dirty authoritative
// road model into a synchronous 200 ms placement step; the old group can remain
// visible while the roads layer publishes its next atomic generation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
    fileURLToPath(new URL('../world/decor.js', import.meta.url)),
    'utf8',
);

test('parking greenery waits for a published road formation', () => {
    const wait = SRC.slice(
        SRC.indexOf('async function waitForPublishedRoadFormation'),
        SRC.indexOf('// Worst SINGLE step per label'),
    );
    assert.match(wait, /formation\?\.hasPendingBuild\?\.\(\) === true/);
    assert.match(wait, /await nextAnimationFrame\(\)/,
        'waiting yields a frame instead of polling or forcing the build');
    assert.match(wait, /if \(shouldCancel\(\)\) return false/,
        'a superseding decor request can still cancel the wait');

    const greenery = SRC.slice(
        SRC.indexOf('async function buildGreeneryGroup'),
        SRC.indexOf('// ─── Pedestrian crossings'),
    );
    assert.match(greenery, /surfaceType === 'parking'[\s\S]*?await waitForPublishedRoadFormation\([\s\S]*?parkingRoadFormation/,
        'only the road-owned parking surface waits on this dependency');
    assert.ok(
        greenery.indexOf('await waitForPublishedRoadFormation')
            < greenery.indexOf('currentParkingFormationProfiles()'),
        'the readiness check precedes every profile query');
    const finalMarkingDrape = greenery.indexOf(
        'parkingFormationMarkingVertices = await drapeParkingMarkings',
    );
    const finalReadinessCheck = greenery.lastIndexOf('await waitForPublishedRoadFormation', finalMarkingDrape);
    assert.ok(finalReadinessCheck >= 0 && finalReadinessCheck < finalMarkingDrape,
        'the delayed road-height marking pass rechecks readiness');

    const markingDrape = greenery.slice(
        greenery.indexOf('const drapeParkingMarkings = async'),
        greenery.indexOf('parkingMarkingVertices = await drapeParkingMarkings'),
    );
    const readiness = markingDrape.indexOf('await waitForPublishedRoadFormation');
    for (const sampling of ['terrainPlacedY(']) {
        const position = markingDrape.indexOf(sampling);
        assert.ok(readiness >= 0 && position > readiness,
            'every resumed road-owned chunk checks readiness before ' + sampling);
    }
    assert.match(
        markingDrape,
        /currentRevision !== sampledFormationRevision[\s\S]*sampledFormationRevision = currentRevision;[\s\S]*draped\.length = 0;[\s\S]*start = 0;/,
        'a changed formation restarts the detached marking result',
    );
    assert.match(markingDrape, /const draped = \[\]/,
        'restarts must not mutate and then resample already-draped source heights');
});

test('road-placed decor waits at each authoritative height boundary', () => {
    const crossings = SRC.slice(
        SRC.indexOf('async function buildCrossingsGroup'),
        SRC.indexOf('// Fringe colour'),
    );
    assert.ok(
        crossings.indexOf('await waitForPublishedRoadFormation')
            < crossings.indexOf('const groundY = terrainPlacedY'),
        'crossings wait before their synchronous placement loop');

    const benches = SRC.slice(
        SRC.indexOf('async function buildBenchesGroup'),
        SRC.indexOf('const TRAFFIC_LIGHT_RADIUS_M'),
    );
    assert.ok(
        benches.indexOf('await waitForPublishedRoadFormation')
            < benches.indexOf('const groundY = terrainBaseY(local.x, local.z, true)'),
        'benches gate every per-candidate road-height sample');

    const trafficLights = SRC.slice(
        SRC.indexOf('async function buildTrafficLightsGroup'),
        SRC.indexOf('function createTrafficSignalCell'),
    );
    assert.ok(
        trafficLights.indexOf('await waitForPublishedRoadFormation')
            < trafficLights.indexOf('const groundY = terrainBaseY(poleX, poleZ, true)'),
        'traffic lights gate every per-candidate road-height sample');
});
