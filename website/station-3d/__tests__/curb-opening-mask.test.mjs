// Verifies that curb openings follow crossing semantics instead of deleting
// curbs beside every separately mapped sidewalk, path, or cycleway.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    curbOpeningMaskReason,
    curbRaisedSideTouchesMask,
    curbTramProxySuppressesBoundary,
} from '../core/curb-opening-mask.js';

function feature(highwayType, tags = {}) {
    return { properties: { highway_type: highwayType, tags } };
}

test('parallel paved paths and sidewalks retain the curb between them and the road', () => {
    assert.equal(curbOpeningMaskReason(feature('path', {
        foot: 'designated',
        bicycle: 'designated',
        surface: 'asphalt',
    })), null);
    assert.equal(curbOpeningMaskReason(feature('footway', {
        footway: 'sidewalk',
        surface: 'asphalt',
    })), null);
    assert.equal(curbOpeningMaskReason(feature('cycleway', {
        surface: 'asphalt',
    })), null);
});

test('only a tagged crossing mouth or pedestrian precinct opens the curb', () => {
    assert.equal(curbOpeningMaskReason(feature('footway', {
        footway: 'crossing',
        crossing: 'uncontrolled',
    })), 'crossing');
    assert.equal(curbOpeningMaskReason(feature('path', {
        crossing: 'marked',
    })), 'crossing');
    assert.equal(curbOpeningMaskReason(feature('pedestrian')), 'pedestrian-area');
});

test('greenery owns a parking boundary only on the curb raised side', () => {
    const green = (x, z) => x >= 0.35 && x <= 1.2 && Math.abs(z) < 0.5;
    assert.equal(curbRaisedSideTouchesMask(
        0,
        0,
        1,
        0,
        green,
        [0.4, 1.1],
    ), true);
    assert.equal(curbRaisedSideTouchesMask(
        0,
        0,
        -1,
        0,
        green,
        [0.4, 1.1],
    ), false);
});

function rectangularMask(minX, minZ, maxX, maxZ) {
    return {
        bounds: { minX, minZ, maxX, maxZ },
        polygons: [{
            outerRing: [
                { x: minX, z: minZ },
                { x: maxX, z: minZ },
                { x: maxX, z: maxZ },
                { x: minX, z: maxZ },
            ],
            holeRings: [],
        }],
    };
}

test('a broad tram proxy cannot delete a highway-backed curb', () => {
    const tramProxyMasks = [rectangularMask(2.151, -20, 7.174, 20)];
    const roadbedMasks = [rectangularMask(-2.162, -20, 7.405, 20)];
    assert.equal(curbTramProxySuppressesBoundary(
        7.406,
        0,
        1,
        0,
        tramProxyMasks,
        roadbedMasks,
    ), false, 'Frankopanska road edge remains the visible road/sidewalk interface');
});

test('a tram-only union perimeter remains suppressed', () => {
    const tramProxyMasks = [rectangularMask(-2.5, -20, 2.5, 20)];
    const roadbedMasks = [rectangularMask(-1, -20, 1, 20)];
    assert.equal(curbTramProxySuppressesBoundary(
        2.5,
        0,
        1,
        0,
        tramProxyMasks,
        roadbedMasks,
    ), true, 'the coarse routing buffer must not grow its own raised curb');
});

test('roadbed on the raised side does not preserve a tram-only edge', () => {
    const tramProxyMasks = [rectangularMask(-2.5, -20, 2.5, 20)];
    const roadbedMasks = [rectangularMask(2.55, -20, 5, 20)];
    assert.equal(curbTramProxySuppressesBoundary(
        2.5,
        0,
        1,
        0,
        tramProxyMasks,
        roadbedMasks,
    ), true);
});
