// Boats use the complete visible hull when spawning, stopping and turning beside a quay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boatPoseIsNavigable, nearestNavigableBoatPose } from '../core/boat-navigation.js';
import { BOAT_HULL_DIMENSIONS } from '../models/vehicles/boat-airplane-geometry.js';
import { buildLeutGeometryData } from '../models/vehicles/leut-geometry.js';
import { createGtaSpecialVehicleState, stepGtaSpecialVehicle } from '../core/gta-special-vehicle.js';

test('a water-covered centre is insufficient when the bow crosses the quay', () => {
    const water = (_x, z) => z < 0;
    assert.equal(boatPoseIsNavigable({ x: 0, z: -1, heading: 0 }, water), false);
    const safe = nearestNavigableBoatPose({ x: 0, z: -1, heading: 0 }, water);
    assert.ok(safe.z < -4.5); assert.equal(boatPoseIsNavigable(safe, water), true);
});

test('a bow approaching land stops with its complete hull in water and can turn away', () => {
    const water = (_x, z) => z < 0;
    const state = createGtaSpecialVehicleState({ kind: 'boat', x: 0, z: -8, heading: 0 });
    for (let i = 0; i < 100; i++) {
        stepGtaSpecialVehicle(state, { forward: true, left: i > 55 }, .05, { isWaterAt: water, waterYAt: () => -.2 });
        assert.equal(boatPoseIsNavigable(state, water), true, `step ${i}`);
    }
    assert.ok(state.heading > .5);
});

test('no boat is placed where the water body cannot fit it', () => {
    const water = (x, z) => Math.hypot(x, z) < 1;
    assert.equal(nearestNavigableBoatPose({ x: 0, z: 0, heading: 0 }, water), null);
});

test('shared interaction dimensions enclose every visible hull vertex', () => {
    const hull = buildLeutGeometryData().groups.filter(group => group.family === 'hull');
    assert.ok(hull.length > 0);
    for (const { positions } of hull) {
        for (let i = 0; i < positions.length; i += 3) {
            assert.ok(Math.abs(positions[i]) <= BOAT_HULL_DIMENSIONS.width / 2);
            assert.ok(Math.abs(positions[i + 2]) <= BOAT_HULL_DIMENSIONS.length / 2);
        }
    }
});

test('a scaled hull tests scaled probes: a small leut fits a channel the full hull cannot', () => {
    const channel = (x, z) => Math.abs(x) < 1.3 && z < 0;
    assert.equal(boatPoseIsNavigable({ x: 0, z: -20, heading: 0 }, channel), false);
    assert.equal(boatPoseIsNavigable({ x: 0, z: -20, heading: 0, hullScale: 0.78 }, channel), true);
    assert.equal(boatPoseIsNavigable({ x: 0, z: -20, heading: 0, hullScale: 'big' }, channel), false, 'junk scale reads as the full hull');
    const small = nearestNavigableBoatPose({ x: 0, z: -1, heading: 0, hullScale: 0.78 }, channel);
    assert.equal(small.hullScale, 0.78, 'the scale rides along with the pose');
    assert.ok(small.z < -3.5 && small.z > -4.5, 'a shorter hull stops closer to the quay');
    const state = createGtaSpecialVehicleState({ kind: 'boat', x: 0, z: -8, heading: 0, hullScale: 0.78 });
    assert.equal(state.hullScale, 0.78);
    assert.equal(createGtaSpecialVehicleState({ kind: 'boat', x: 0, z: -8 }).hullScale, 1);
    assert.equal(createGtaSpecialVehicleState({ kind: 'boat', x: 0, z: -8, hullScale: -2 }).hullScale, 1);
    for (let i = 0; i < 60; i++) {
        stepGtaSpecialVehicle(state, { forward: true }, .05, { isWaterAt: channel, waterYAt: () => -.2 });
        assert.equal(boatPoseIsNavigable(state, channel), true, `step ${i}`);
    }
    assert.ok(state.z > -4.6, 'the small hull nosed up to the quay');
});
