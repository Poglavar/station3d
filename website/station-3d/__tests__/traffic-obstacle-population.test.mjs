// Locks the traffic-braking population so authored/player-controlled parked
// vehicles cannot again become invisible to ambient cars.

import assert from 'node:assert/strict';
import test from 'node:test';

import { trafficObstaclePopulation } from '../core/traffic-obstacle-population.js';

test('traffic braking includes authored and controlled parked cars', () => {
    const moving = { id: 'moving' };
    const authored = { id: 'campaign-car', authored: true, controlled: true };
    const destroyed = { id: 'destroyed', destroyed: true };
    const unseated = { id: 'unseated', terrainReady: false };

    assert.deepEqual(
        trafficObstaclePopulation({
            moving: [moving],
            wrecked: [destroyed],
            parked: new Set([authored, unseated]),
        }).map(car => car.id),
        ['moving', 'campaign-car'],
    );
});
