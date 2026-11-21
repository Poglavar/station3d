// Verifies bounded, transactional metadata derivation for streamed road tiles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoadTileRegistrationTask } from '../core/road-tile-registration.js';

const feature = (osmId, highwayType, coordinates, extra = {}) => ({
    properties: {
        osm_id: osmId,
        highway_type: highwayType,
        ...extra,
    },
    geometry: {
        type: 'Polygon',
        coordinates: [coordinates],
    },
});

function finish(task) {
    let steps = 0;
    while (task.step() === 'more') steps += 1;
    return { steps: steps + 1, result: task.result() };
}

test('derives engineered ids and pedestrian bounds without partial results', () => {
    const task = createRoadTileRegistrationTask([
        feature(10, 'primary', [[16, 45], [16.001, 45], [16, 45.001], [16, 45]]),
        feature(11, 'service', [[16, 45], [16.001, 45], [16, 45.001], [16, 45]], {
            tags: { service: 'parking_aisle' },
        }),
        feature(12, 'pedestrian', [[16, 45], [16.001, 45], [16.001, 45.001], [16, 45]]),
    ], {
        anchorLat: 45,
        anchorLon: 16,
        pedestrianMinAreaM2: 1,
        workUnitsPerStep: 2,
    });

    assert.throws(() => task.result(), /not complete/);
    const { steps, result } = finish(task);
    assert.ok(steps > 1, 'small work slices must resume rather than finish inline');
    assert.deepEqual([...result.engineeredOsmIds], ['10']);
    assert.equal(result.pedestrianEntries.length, 1);
    assert.equal(result.pedestrianEntries[0].osmId, 12);
    assert.equal(result.pedestrianEntries[0].pts.length, 3);
    assert.ok(result.pedestrianEntries[0].maxX > result.pedestrianEntries[0].minX);
    assert.ok(result.pedestrianEntries[0].maxZ > result.pedestrianEntries[0].minZ);
});

test('bounds one large pedestrian ring by coordinate work units', () => {
    const ring = [];
    for (let index = 0; index < 1000; index += 1) {
        const angle = index / 1000 * Math.PI * 2;
        ring.push([16 + Math.cos(angle) * 0.001, 45 + Math.sin(angle) * 0.001]);
    }
    ring.push(ring[0]);
    const task = createRoadTileRegistrationTask([
        feature(20, 'pedestrian', ring),
    ], {
        anchorLat: 45,
        anchorLon: 16,
        pedestrianMinAreaM2: 1,
        workUnitsPerStep: 64,
    });

    const { steps, result } = finish(task);
    assert.ok(steps >= 16, `expected at least 16 bounded steps, got ${steps}`);
    assert.equal(result.pedestrianEntries[0].pts.length, 1000);
});
