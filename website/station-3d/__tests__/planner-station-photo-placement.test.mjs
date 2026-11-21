// Verifies planner station placement shares photo rails' tangent frame and
// keeps semantic station levels independent of the ASL session datum.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    plannerFeatureUsesPhotoFrame,
    plannerScenePoint,
    resolvePhotoStationVerticalPlacement,
} from '../core/planner-station-photo-placement.js';

const frame = {
    toScene(lon, lat, height) {
        return {
            x: lon * 1000 + height * 0.001,
            y: height - 20,
            z: -lat * 1000,
        };
    },
};

test('only authored ASL features use the photo tangent frame', () => {
    assert.equal(plannerFeatureUsesPhotoFrame({ elevationDatum: 'asl' }, frame), true);
    assert.equal(plannerFeatureUsesPhotoFrame({ elevationDatum: 'EVRF2000' }, frame), false);
    assert.equal(plannerFeatureUsesPhotoFrame({ elevationDatum: 'asl' }, null), false);
});

test('authored photo coordinates pass lon, lat and profile height through unchanged', () => {
    const point = plannerScenePoint({
        lon: 16,
        lat: 45,
        elevationM: 7.5,
        anchorLon: 15,
        anchorLat: 44,
        photoTrackFrame: frame,
        usePhotoFrame: true,
    });
    assert.deepEqual(point, { x: 16000.0075, y: -12.5, z: -45000 });
});

test('legacy coordinates keep flat projection and raw relative elevation', () => {
    const point = plannerScenePoint({
        lon: 16,
        lat: 45,
        elevationM: -10,
        anchorLon: 16,
        anchorLat: 45,
        photoTrackFrame: frame,
        usePhotoFrame: false,
    });
    assert.equal(point.x, 0);
    assert.equal(point.y, -10);
    assert.equal(Math.abs(point.z), 0);
});

test('underground semantic level seats access at ground while hall stays on authored rail', () => {
    const placement = resolvePhotoStationVerticalPlacement({
        photoTrackFrame: frame,
        lon: 16,
        lat: 45,
        trackRelativeHeightM: 5,
        trackSceneY: -15,
        semanticLevel: -1,
        levelHeightM: 10,
    });
    assert.deepEqual(placement, {
        groundSceneY: -5,
        trackLocalY: -10,
        groundOffsetM: -10,
    });
    assert.equal(placement.groundSceneY + placement.trackLocalY, -15);
});

test('authored DGU ground offset overrides the coarse station level fallback', () => {
    const placement = resolvePhotoStationVerticalPlacement({
        photoTrackFrame: frame,
        lon: 16,
        lat: 45,
        trackRelativeHeightM: 5,
        trackSceneY: -15,
        authoredGroundOffsetM: -13.5,
        semanticLevel: -1,
        levelHeightM: 10,
    });
    assert.equal(placement.groundOffsetM, -13.5);
    assert.equal(placement.groundSceneY, -1.5);
    assert.equal(placement.trackLocalY, -13.5);
    assert.equal(placement.groundSceneY + placement.trackLocalY, -15);
});
