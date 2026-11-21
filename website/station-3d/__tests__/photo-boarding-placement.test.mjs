// Verifies boarding actors, stops and door targets share authored photo-track
// position/orientation while the legacy model projection remains unchanged.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    boardingPlatformFeetY,
    boardingPointToScene,
    boardingPoseToScene,
    shouldSuppressPhotoStationBoarding,
} from '../core/photo-boarding-placement.js';

const frame = {
    toScene(lon, lat, height) {
        return { x: lon * 100 + height / 1000, y: height - 30, z: -lat * 100 };
    },
    orientationAt({ headingDeg }) {
        return { headingDeg: headingDeg + 7, pitchDeg: -1 };
    },
};

test('photo boarding point preserves the authored profile height in the shared frame', () => {
    assert.deepEqual(boardingPointToScene({
        lon: 16,
        lat: 45,
        relativeHeightM: 12,
        photoTrackFrame: frame,
    }), { x: 1600.012, y: -18, z: -4500 });
});

test('photo tram pose uses tangent-frame heading for door offsets', () => {
    assert.deepEqual(boardingPoseToScene({
        lon: 16,
        lat: 45,
        relativeHeightM: 12,
        headingDeg: 90,
        photoTrackFrame: frame,
    }), { x: 1600.012, y: -18, z: -4500, headingDeg: 97 });
});

test('platform feet add their existing offset above the transformed track profile', () => {
    assert.equal(boardingPlatformFeetY({
        lon: 16,
        lat: 45,
        trackRelativeHeightM: 12,
        platformOffsetM: 0.12,
        photoTrackFrame: frame,
    }), -17.88);
});

test('legacy/model boarding keeps flat local coordinates, raw Y and map heading', () => {
    const pose = boardingPoseToScene({
        lon: 16,
        lat: 45,
        relativeHeightM: -10,
        headingDeg: 180,
        anchorLon: 16,
        anchorLat: 45,
    });
    assert.equal(pose.x, 0);
    assert.equal(Math.abs(pose.z), 0);
    assert.equal(pose.y, -10);
    assert.equal(pose.headingDeg, 180);
});

test('compact covered photo station suppresses actors that would intersect its raised platform', () => {
    assert.equal(shouldSuppressPhotoStationBoarding({
        hasPhotoFrame: true,
        stopTrackId: 54,
        runtimeStructure: 'tunnel',
        rigidStructure: false,
    }), true);
    assert.equal(shouldSuppressPhotoStationBoarding({
        hasPhotoFrame: true,
        stopTrackId: 54,
        runtimeStructure: 'tunnel',
        rigidStructure: true,
    }), false, 'the canonical rigid underground station keeps its own actors');
    assert.equal(shouldSuppressPhotoStationBoarding({
        hasPhotoFrame: false,
        stopTrackId: 54,
        runtimeStructure: 'tunnel',
        rigidStructure: false,
    }), false, 'model mode is unchanged');
});
