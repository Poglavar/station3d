import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    planTrafficPhysicsBubble,
    promotedTrafficRouteMayAdvance,
    trafficGuidanceCommand,
    trafficPhysicsMode,
    trafficSpawnHasClearance,
} from '../core/gta-traffic-promotion.js';
import { GTA_TRAFFIC_TUNING } from '../core/gta-config.js';

const carsSource = await readFile(new URL('../world/cars.js', import.meta.url), 'utf8');
const gtaSource = await readFile(new URL('../modes/gta.js', import.meta.url), 'utf8');

test('traffic physics uses enter/retire hysteresis without duplicating identities', () => {
    const plan = planTrafficPhysicsBubble({
        obstacles: [
            { id: 'new-near', state: 'moving', x: 70, z: 0 },
            { id: 'new-between', state: 'moving', x: 90, z: 0 },
            { id: 'existing-between', state: 'moving', x: 100, z: 0 },
            { id: 'existing-far', state: 'moving', x: 130, z: 0 },
            { id: 'new-near', state: 'moving', x: 75, z: 0 },
        ],
        existingIds: ['existing-between', 'existing-far'],
        enterRadiusM: 80,
        retireRadiusM: 120,
        maxBodies: 8,
    });
    assert.deepEqual(plan.selected.map(candidate => candidate.id), [
        'existing-between',
        'new-near',
    ]);
    assert.deepEqual(plan.retireIds, ['existing-far']);
});

test('contacting and already-promoted cars win a hard capacity decision', () => {
    const plan = planTrafficPhysicsBubble({
        obstacles: [
            { id: 'nearest-new', state: 'moving', x: 1, z: 0 },
            { id: 'existing', state: 'moving', x: 40, z: 0 },
            { id: 'contacting', state: 'moving', x: 140, z: 0 },
        ],
        existingIds: ['existing', 'contacting'],
        contactingIds: ['contacting'],
        enterRadiusM: 80,
        retireRadiusM: 120,
        maxBodies: 2,
    });
    assert.deepEqual(plan.selected.map(candidate => candidate.id), ['contacting', 'existing']);
    assert.equal(plan.capacityHit, true);
    assert.deepEqual(plan.retireIds, []);
});

test('moving cars are dynamic while parked and wrecked obstacles stay kinematic', () => {
    assert.equal(trafficPhysicsMode({ state: 'moving' }), 'dynamic');
    assert.equal(trafficPhysicsMode({ state: 'parked' }), 'kinematic');
    assert.equal(trafficPhysicsMode({ state: 'wrecked' }), 'kinematic');
});

test('traffic bubble rejects malformed candidates and returns deterministic IDs', () => {
    const plan = planTrafficPhysicsBubble({
        obstacles: [
            { id: 'b', state: 'moving', x: 10, z: 0 },
            { id: '', state: 'moving', x: 0, z: 0 },
            { id: 'bad', state: 'moving', x: Number.NaN, z: 0 },
            { id: 'a', state: 'moving', x: -10, z: 0 },
        ],
        maxBodies: 8,
    });
    assert.deepEqual(plan.selected.map(candidate => candidate.id), ['a', 'b']);
});

test('dynamic route guidance is acceleration-capped and preserves vertical velocity', () => {
    const command = trafficGuidanceCommand({
        translation: { x: 0, z: 0 },
        velocity: { x: 0, y: -2, z: 0 },
        yaw: 0,
        angularVelocity: { x: 0.2, y: 0, z: -0.1 },
        target: { x: 100, z: 0, heading: Math.PI / 2, speedMps: 20 },
        dt: 1 / 60,
        tuning: GTA_TRAFFIC_TUNING,
    });
    assert.ok(
        Math.hypot(command.linearVelocity.x, command.linearVelocity.z)
            <= GTA_TRAFFIC_TUNING.maxRecoveryAccelerationMps2 / 60 + 1e-9,
    );
    assert.equal(command.linearVelocity.y, -2);
    assert.equal(command.angularVelocity.x, 0.2);
    assert.equal(command.angularVelocity.z, -0.1);
    assert.equal(command.angularVelocity.y, GTA_TRAFFIC_TUNING.maxYawRateRadS);
});

test('dynamic route guidance turns across the short side of the angle wrap', () => {
    const command = trafficGuidanceCommand({
        translation: { x: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: Math.PI - 0.05,
        angularVelocity: { x: 0, y: 0, z: 0 },
        target: { x: 0, z: 0, heading: -Math.PI + 0.05, speedMps: 0 },
        dt: 1 / 60,
        tuning: GTA_TRAFFIC_TUNING,
    });
    assert.ok(command.angularVelocity.y > 0);
    assert.ok(command.angularVelocity.y < 0.3);
});

test('a promoted route shadow pauses before it can escape a blocked physical car', () => {
    assert.equal(promotedTrafficRouteMayAdvance({
        actual: { x: 0, z: 0, speedMps: 0 },
        target: { x: 1.49, z: 0 },
        tuning: GTA_TRAFFIC_TUNING,
    }), true);
    assert.equal(promotedTrafficRouteMayAdvance({
        actual: { x: 0, z: 0, speedMps: 0 },
        target: { x: 1.51, z: 0 },
        tuning: GTA_TRAFFIC_TUNING,
    }), false);
    assert.equal(promotedTrafficRouteMayAdvance({
        actual: { x: 0, z: 0, speedMps: 10 },
        target: { x: 4.99, z: 0 },
        tuning: GTA_TRAFFIC_TUNING,
    }), true, 'a moving body may use the bounded speed-scaled lead');
    assert.equal(promotedTrafficRouteMayAdvance({
        actual: { x: 0, z: 0, speedMps: 10 },
        target: { x: 5.01, z: 0 },
        tuning: GTA_TRAFFIC_TUNING,
    }), false, 'the configured hard cap always wins');
});

test('a promoted route shadow freezes on malformed poses', () => {
    assert.equal(promotedTrafficRouteMayAdvance({
        actual: { x: null, z: 0, speedMps: 0 },
        target: { x: 0, z: 0 },
        tuning: GTA_TRAFFIC_TUNING,
    }), false);
});

test('the route leash and upright-only traffic rotation are wired into GTA', () => {
    const promotedRoute = carsSource.slice(
        carsSource.indexOf('function updatePromotedTrafficRoute'),
        carsSource.indexOf('// Per-frame across the global car pool'),
    );
    const trafficBody = gtaSource.slice(
        gtaSource.indexOf('function makeTrafficBody'),
        gtaSource.indexOf('function syncTraffic'),
    );
    assert.match(promotedRoute, /promotedTrafficRouteMayAdvance\(\{/,
        'the tested route policy must gate the live shadow simulation');
    assert.match(trafficBody, /\.enabledRotations\(false, true, false\)/,
        'simple traffic cuboids may yaw but must not roll onto their doors');
});

test('traffic spawning rejects overlapping bodies but permits adjacent lanes', () => {
    const candidate = {
        x: 0,
        z: 0,
        heading: 0,
        widthM: 1.8,
        lengthM: 4.5,
    };
    assert.equal(trafficSpawnHasClearance(candidate, [{
        x: 0,
        z: 3,
        heading: 0,
        widthM: 1.8,
        lengthM: 4.5,
    }]), false, 'a short same-lane headway would begin in penetration');
    assert.equal(trafficSpawnHasClearance(candidate, [{
        x: 3.5,
        z: 0,
        heading: Math.PI,
        widthM: 1.8,
        lengthM: 4.5,
    }]), true, 'the opposing lane must remain available');
    assert.equal(trafficSpawnHasClearance(candidate, [{
        x: 0,
        z: 0,
        heading: Math.PI / 2,
        widthM: 1.8,
        lengthM: 4.5,
    }]), false, 'crossing physical footprints also overlap');
});

test('traffic spawning refuses malformed candidates instead of inventing zero coordinates', () => {
    assert.equal(trafficSpawnHasClearance({
        x: null,
        z: 0,
        widthM: 1.8,
        lengthM: 4.5,
    }), false);
});
