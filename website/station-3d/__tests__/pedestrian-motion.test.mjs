// Verifies deterministic pedestrian stepping, pair spacing, and road-guided
// waypoint selection without needing a browser or Three.js scene.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    advanceTowards,
    chooseRoadWaypoint,
    sideBySideOffsets,
} from '../core/pedestrian-motion.js';

test('pedestrian advances at walking speed and faces its destination', () => {
    const walker = { x: 0, z: 0, speed: 1.25, stride: 0, heading: 0 };
    const result = advanceTowards(walker, { x: 3, z: 4 }, 2);

    assert.equal(result.arrived, false);
    assert.ok(Math.abs(result.movedM - 2.5) < 1e-9);
    assert.ok(Math.abs(walker.x - 1.5) < 1e-9);
    assert.ok(Math.abs(walker.z - 2) < 1e-9);
    assert.ok(Math.abs(walker.heading - Math.atan2(3, 4)) < 1e-9);
});

test('pedestrian reaches collision detour waypoints instead of cutting corners early', () => {
    const walker = { x: 0, z: 0, speed: 1, stride: 0, heading: 0 };
    const first = advanceTowards(walker, { x: 0.3, z: 0 }, 0.1);

    assert.equal(first.arrived, false);
    assert.ok(Math.abs(walker.x - 0.1) < 1e-9);

    const second = advanceTowards(walker, { x: 0.3, z: 0 }, 0.2);
    assert.equal(second.arrived, true);
    assert.ok(Math.abs(walker.x - 0.3) < 1e-9);
});

test('pair offsets remain centered with human-scale separation', () => {
    assert.deepEqual(sideBySideOffsets(1), [0]);
    const [left, right] = sideBySideOffsets(2);
    // Centred on the walker, so widening the pair never moves the group.
    assert.equal(left + right, 0);
    // Wide enough that two ~0.47 m figures read as two people rather than one
    // doubled silhouette, and still close enough to read as company.
    assert.ok(right - left >= 0.85 && right - left <= 1.2, `separation ${right - left}`);
});

test('road waypoint follows a nearby segment and stays on one pavement side', () => {
    const waypoint = chooseRoadWaypoint({
        x: 1,
        z: 0,
        side: 1,
        segments: [{ ax: 0, az: 0, bx: 30, bz: 0 }],
        random: () => 0.99,
    });

    assert.deepEqual(waypoint, { x: 30, z: 2.4 });
});

test('road waypoint avoids an immediate U-turn when another continuation exists', () => {
    const waypoint = chooseRoadWaypoint({
        x: 30,
        z: 0,
        side: -1,
        previous: { x: 0, z: 0 },
        segments: [
            { ax: 0, az: 0, bx: 30, bz: 0 },
            { ax: 30, az: 0, bx: 60, bz: 0 },
        ],
        random: () => 0,
    });

    assert.deepEqual(waypoint, { x: 60, z: -2.4 });
});
