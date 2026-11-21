// The campaign hands the player a getaway car with "the dark car is ours if you
// need it". Entry reach was a flat 3.2 m from the vehicle CENTRE, which on a
// 4.5 m sedan runs out about a metre past the bumper — standing beside it at a
// natural 3.6 m produced no prompt, so the car read as scenery. Reach is now
// measured from the body, the way the boat's larger enterDistanceM already was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GTA_PHYSICS } from '../core/gta-config.js';
import { ROAD_TRAFFIC_VEHICLE_TYPES } from '../models/vehicles/traffic-vehicle-catalog.js';

const bodyReach = type => Math.hypot(type.length, type.width) / 2;

test('a car can be entered from beside its body, not only from its centre', () => {
    const sedan = ROAD_TRAFFIC_VEHICLE_TYPES.find(type => type.name === 'sedan');
    assert.ok(sedan, 'the catalog still has a sedan');
    const reach = GTA_PHYSICS.enterDistanceM + bodyReach(sedan);
    // The distance that used to fail on the Zagreb getaway car.
    assert.ok(reach > 3.6, `walking up to 3.6 m must prompt (reach ${reach.toFixed(2)} m)`);
    // Still a walk-up, not a whole street.
    assert.ok(reach < 8, `reach stays local (${reach.toFixed(2)} m)`);
});

test('a longer vehicle is not harder to walk up to than a short one', () => {
    const clearances = ROAD_TRAFFIC_VEHICLE_TYPES.map(type => ({
        name: type.name,
        // How far clear of the body the prompt still appears.
        clearance: GTA_PHYSICS.enterDistanceM + bodyReach(type) - type.length / 2,
    }));
    for (const { name, clearance } of clearances) {
        assert.ok(clearance >= GTA_PHYSICS.enterDistanceM * 0.75,
            `${name} keeps a usable clearance (${clearance.toFixed(2)} m)`);
    }
    // A truck must not be meaningfully worse than a compact.
    const spread = Math.max(...clearances.map(c => c.clearance))
        - Math.min(...clearances.map(c => c.clearance));
    assert.ok(spread < 1.2, `clearance is size-independent within ${spread.toFixed(2)} m`);
});

test('the lookup adds the body reach rather than comparing against a bare radius', () => {
    const cars = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8');
    assert.match(cars, /function parkedCarBodyReachM\(car\)/);
    assert.match(cars, /const reach = radiusM \+ parkedCarBodyReachM\(car\);/);
    // The nearest enterable car must still win, not merely the first in range.
    assert.match(cars, /distanceSq >= bestDistanceSq/);
});
