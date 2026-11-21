import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findTrafficSignalPolePlacement,
    pointTouchesTrafficRoadbed,
    trafficSignalLampFacePositions,
} from '../core/traffic-signal-placement.js';

function rectangle(minX, minZ, maxX, maxZ) {
    return {
        outerRing: [
            { x: minX, z: minZ },
            { x: maxX, z: minZ },
            { x: maxX, z: maxZ },
            { x: minX, z: maxZ },
        ],
        holeRings: [],
    };
}

test('traffic-light pole clears the actual wide carriageway instead of using a fixed offset', () => {
    const roads = [rectangle(-10, -40, 10, 40)];
    const placement = findTrafficSignalPolePlacement({
        x: 0,
        z: 0,
        bearingDeg: 0,
        roadPolygons: roads,
    });
    assert.ok(placement);
    assert.ok(Math.abs(placement.x) > 10.3, `pole x ${placement.x} clears road edge`);
    assert.equal(pointTouchesTrafficRoadbed(
        placement.x,
        placement.z,
        roads,
        0.4,
    ), false);
});

test('intersection placement finds a dry corner outside both roadbeds', () => {
    const roads = [
        rectangle(-4, -30, 4, 30),
        rectangle(-30, -4, 30, 4),
    ];
    const placement = findTrafficSignalPolePlacement({
        x: 0,
        z: 0,
        bearingDeg: 0,
        roadPolygons: roads,
    });
    assert.ok(placement);
    assert.equal(pointTouchesTrafficRoadbed(
        placement.x,
        placement.z,
        roads,
        0.4,
    ), false);
    assert.ok(Math.abs(placement.x) > 4.3);
    assert.ok(Math.abs(placement.z) > 4.3);
});

test('traffic-light placement fails closed until road geometry is available', () => {
    assert.equal(findTrafficSignalPolePlacement({
        x: 0,
        z: 0,
        bearingDeg: 0,
        roadPolygons: [],
    }), null);
});

test('lamp faces sit on opposite road-facing sides of one housing', () => {
    const faces = trafficSignalLampFacePositions({
        poleX: 5,
        poleZ: 8,
        roadX: 0,
        roadZ: -1,
    }, 0.18);
    assert.deepEqual(faces, [
        { x: 5, z: 7.82 },
        { x: 5, z: 8.18 },
    ]);
});
