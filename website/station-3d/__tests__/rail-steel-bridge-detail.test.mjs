// Locks bounded, evenly phased placement of box-girder stiffeners and bolts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planSteelBridgeDetailStations } from '../core/rail-steel-bridge-detail.js';

test('steel bridge details are interpolated at stable world stations', () => {
    const placements = planSteelBridgeDetailStations([
        { station: 1, x: 0, z: 0, railY: 5 },
        { station: 6, x: 0, z: 5, railY: 5.5 },
        { station: 11, x: 0, z: 10, railY: 6 },
    ], { spacingM: 2, endMarginM: 0.5 });
    assert.deepEqual(placements.map(item => item.station), [2, 4, 6, 8, 10]);
    assert.deepEqual(placements.map(item => item.z), [1, 3, 5, 7, 9]);
    assert.ok(Math.abs(placements[2].railY - 5.5) < 1e-9);
});

test('a short steel bridge still gets one central detail frame', () => {
    const [placement] = planSteelBridgeDetailStations([
        { station: 0.1, x: 0, z: 0, railY: 3 },
        { station: 0.4, x: 0.3, z: 0, railY: 3 },
    ]);
    assert.ok(placement);
    assert.ok(Math.abs(placement.x - 0.15) < 1e-9);
});
