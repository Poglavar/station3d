// Locks the pure bench approach, transition, and dwell contracts used by
// ambient pedestrians without requiring a rendered browser scene.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    benchDwellSeconds,
    benchSeatFrame,
    benchTransitionRatio,
} from '../core/pedestrian-bench-behavior.js';

test('bench frame uses the same +Z-facing convention as the decor instance', () => {
    const north = benchSeatFrame({ id: 7, x: 10, z: 20, seatY: 3, yaw: 0 });
    assert.deepEqual(north, {
        id: '7',
        surfaceId: null,
        x: 10,
        z: 20.12,
        seatY: 3,
        yaw: 0,
        frontX: 0,
        frontZ: 1,
        approachX: 10,
        approachZ: 21.05,
    });

    const east = benchSeatFrame({ id: 'east', x: 1, z: 2, seatY: 4, yaw: Math.PI / 2 }, 2);
    assert.ok(Math.abs(east.x - 1.12) < 1e-9);
    assert.ok(Math.abs(east.approachX - 3) < 1e-9);
    assert.ok(Math.abs(east.approachZ - 2) < 1e-9);

    const roof = benchSeatFrame({
        id: 'roof', x: 0, z: 0, seatY: 20.5, yaw: 0, surfaceId: 'flat-roof:1',
    });
    assert.equal(roof.surfaceId, 'flat-roof:1');
});

test('bench transitions ease at both ends and dwell for a visible interval', () => {
    assert.equal(benchTransitionRatio(0, 1), 0);
    assert.equal(benchTransitionRatio(0.5, 1), 0.5);
    assert.equal(benchTransitionRatio(1, 1), 1);
    assert.equal(benchTransitionRatio(2, 1), 1);
    assert.equal(benchDwellSeconds(0), 8);
    assert.equal(benchDwellSeconds(1), 22);
});
