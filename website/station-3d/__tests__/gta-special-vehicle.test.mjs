// Covers the pure boat/aircraft controls without loading Three.js or a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyAirplaneThrottleKeyDown,
    createGtaSpecialVehicleState,
    gtaSpecialVehiclePose,
    resetGtaSpecialVehicleState,
    specialVehicleInputForKeys,
    stepGtaSpecialVehicle,
} from '../core/gta-special-vehicle.js';

test('boat accelerates, turns, and cannot drive onto land', () => {
    const state = createGtaSpecialVehicleState({
        id: 'boat:1', kind: 'boat', x: 0, y: -0.2, z: 0, heading: 0,
    });
    for (let index = 0; index < 20; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true, left: true }, 0.1, {
            isWaterAt: () => true,
            waterYAt: () => -0.2,
        });
    }
    assert.ok(state.speedMps > 0);
    assert.ok(state.throttle > 0);
    assert.ok(state.heading > 0);
    const shorelineZ = state.z + 0.8;
    for (let index = 0; index < 20; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true }, 0.1, {
            isWaterAt: (_x, z) => z < shorelineZ,
            waterYAt: () => -0.2,
        });
    }
    assert.ok(state.z < shorelineZ + 0.1);
});

test('a beached boat can steer itself off the shore under power', () => {
    // Touching land zeroes speed, and steering authority used to scale from
    // speed alone — so a boat nosed into the quay could neither move nor turn.
    // One measured beaching took 10 s of reverse to gain 2.3 m and ended the
    // Adriatic chapter with no recovery.
    const state = createGtaSpecialVehicleState({
        id: 'boat:beached', kind: 'boat', x: 0, y: -0.2, z: 0, heading: 0,
    });
    const shorelineZ = 0.05;
    const water = { isWaterAt: (_x, z) => z < shorelineZ, waterYAt: () => -0.2 };

    for (let index = 0; index < 10; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true }, 0.1, water);
    }
    assert.ok(Math.abs(state.speedMps) < 0.5, `pinned boat kept speed ${state.speedMps}`);

    // Holding the helm over swings the bow away from the shore — about six
    // seconds to come round past the beam, which is a recovery a player can
    // discover rather than a dead end.
    const headingWhilePinned = state.heading;
    for (let index = 0; index < 60; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true, left: true }, 0.1, water);
    }
    assert.ok(
        Math.abs(state.heading - headingWhilePinned) > 1.6,
        `beached boat only turned ${state.heading - headingWhilePinned} rad`,
    );

    // Now pointed back at open water it leaves under its own power.
    const strandedZ = state.z;
    for (let index = 0; index < 20; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true }, 0.1, water);
    }
    assert.ok(state.speedMps > 1, `boat did not get under way (${state.speedMps})`);
    assert.ok(state.z < strandedZ - 1, `boat stayed on the beach (${state.z} vs ${strandedZ})`);
});

test('a drifting boat with no throttle keeps needing way on to steer', () => {
    const state = createGtaSpecialVehicleState({
        id: 'boat:drifting', kind: 'boat', x: 0, y: -0.2, z: 0, heading: 0,
    });
    const heading = state.heading;
    for (let index = 0; index < 20; index += 1) {
        stepGtaSpecialVehicle(state, { left: true }, 0.1, {
            isWaterAt: () => true,
            waterYAt: () => -0.2,
        });
    }
    assert.equal(state.heading, heading);
});

test('terrain-relative special vehicles freeze while support evidence is unavailable', () => {
    const boat = createGtaSpecialVehicleState({
        id: 'boat:waiting', kind: 'boat', x: 3, y: -0.2, z: 4, heading: 0,
    });
    const beforeBoat = gtaSpecialVehiclePose(boat);
    stepGtaSpecialVehicle(boat, { forward: true, left: true }, 0.5, {
        isWaterAt: () => true,
        waterYAt: () => null,
    });
    assert.deepEqual(gtaSpecialVehiclePose(boat), beforeBoat);

    const airplane = createGtaSpecialVehicleState({
        id: 'airplane:waiting', kind: 'airplane', x: 8, y: 0.45, z: 9, heading: 0,
    });
    const beforeAirplane = gtaSpecialVehiclePose(airplane);
    stepGtaSpecialVehicle(airplane, { forward: true }, 0.5, {
        isRunwayAt: () => true,
        groundYAt: () => null,
    });
    assert.deepEqual(gtaSpecialVehiclePose(airplane), beforeAirplane);
});

test('airplane taxis on runway, takes off, banks, and climbs', () => {
    const state = createGtaSpecialVehicleState({
        id: 'airplane:1', kind: 'airplane', x: 0, y: 0.45, z: 0, heading: 0,
    });
    for (let index = 0; index < 60; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true, pitchUp: index > 45 }, 0.1, {
            isRunwayAt: () => true,
            groundYAt: () => 0,
        });
    }
    assert.equal(state.grounded, false);
    const takeoffY = state.y;
    for (let index = 0; index < 20; index += 1) {
        stepGtaSpecialVehicle(state, { forward: true, pitchUp: true, left: true }, 0.1, {
            groundYAt: () => 0,
        });
    }
    assert.ok(state.y > takeoffY);
    assert.ok(state.roll > 0);
    assert.ok(state.heading > 0);
});

test('airplane W/S pitch while Space throttles and B brakes', () => {
    const input = specialVehicleInputForKeys(new Set(['w', ' ']), { kind: 'airplane' });
    assert.equal(input.forward, true);
    assert.equal(input.reverse, false);
    assert.equal(input.pitchUp, false);
    assert.equal(input.pitchDown, true);
    assert.equal(input.throttleDown, false);
    assert.equal(input.brake, false);
    const pullUp = specialVehicleInputForKeys(new Set(['s', 'b', 'x']), { kind: 'airplane' });
    assert.equal(pullUp.forward, false);
    assert.equal(pullUp.pitchUp, true);
    assert.equal(pullUp.pitchDown, false);
    assert.equal(pullUp.throttleDown, true);
    assert.equal(pullUp.brake, true);
});

test('Q holds airplane power until a fresh Space press releases it', () => {
    const state = createGtaSpecialVehicleState({ kind: 'airplane' });
    state.throttle = 0.72;
    assert.equal(applyAirplaneThrottleKeyDown(state, 'q'), true);
    assert.equal(state.throttleLocked, true);
    stepGtaSpecialVehicle(state, {}, 0.1, { groundYAt: () => 0 });
    assert.equal(state.throttle, 0.72);
    assert.equal(applyAirplaneThrottleKeyDown(state, ' ', { repeat: false }), true);
    assert.equal(state.throttleLocked, false);
    stepGtaSpecialVehicle(state, {}, 0.1, { groundYAt: () => 0 });
    assert.ok(state.throttle < 0.72, 'unlatched power decays when Space is released');
    const decayed = state.throttle;
    stepGtaSpecialVehicle(state, { forward: true }, 0.1, { groundYAt: () => 0 });
    assert.ok(state.throttle > decayed, 'holding Space increases power');
});

test('X reduces held airplane throttle and B cuts thrust while stopping on the ground', () => {
    const state = createGtaSpecialVehicleState({ kind: 'airplane' });
    Object.assign(state, {
        throttle: 0.8,
        throttleLocked: true,
        speedMps: 22,
        grounded: true,
    });
    stepGtaSpecialVehicle(state, { throttleDown: true }, 0.1, { groundYAt: () => 0 });
    assert.ok(state.throttle < 0.8, 'X lowers even a Q-held throttle setting');
    const reduced = state.throttle;
    stepGtaSpecialVehicle(state, {}, 0.1, { groundYAt: () => 0 });
    assert.equal(state.throttle, reduced, 'Q holds the newly reduced setting after X is released');
    for (let index = 0; index < 30; index += 1) {
        stepGtaSpecialVehicle(state, { brake: true }, 0.1, { groundYAt: () => 0 });
    }
    assert.equal(state.throttle, 0);
    assert.equal(state.speedMps, 0);
});

test('airplane leaves the runway end instead of sticking at flying speed', () => {
    const state = createGtaSpecialVehicleState({
        id: 'airplane:edge', kind: 'airplane', x: 0, y: 0.45, z: 0, heading: 0,
    });
    Object.assign(state, { speedMps: 35, throttle: 1 });
    stepGtaSpecialVehicle(state, { forward: true }, 0.1, {
        isRunwayAt: (_x, z) => z < 1,
        groundYAt: () => 0,
    });
    assert.equal(state.grounded, false);
    assert.ok(state.z > 1);
    assert.ok(state.pitch > 0);
});

test('special controls and reset keep the spawn contract', () => {
    const input = specialVehicleInputForKeys(new Set(['w', 'a', 'arrowup']), { stop: true });
    assert.deepEqual(input, {
        forward: true,
        reverse: false,
        left: true,
        right: false,
        pitchUp: true,
        pitchDown: false,
        throttleDown: false,
        brake: true,
    });
    const state = createGtaSpecialVehicleState({
        id: 'boat:2', kind: 'boat', x: 4, y: -0.2, z: 8, heading: 1,
    });
    Object.assign(state, { x: 50, z: 60, speedMps: 12 });
    resetGtaSpecialVehicleState(state);
    assert.deepEqual(
        { x: state.x, y: state.y, z: state.z, heading: state.heading, speedMps: state.speedMps },
        { x: 4, y: -0.2, z: 8, heading: 1, speedMps: 0 },
    );
    assert.equal(gtaSpecialVehiclePose(state).kind, 'boat');
    assert.equal(gtaSpecialVehiclePose(state).wakePhase, 0);
});
