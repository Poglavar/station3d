// Locks the aircraft gauge contract: height above the ground it is over, climb
// rate, and engine power — the three things the rail chainage/grade pair could
// never say about a flying aircraft.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    aircraftInstruments,
    formatAircraftAgl,
    formatAircraftInstruments,
    formatAircraftThrottle,
    formatAircraftVerticalSpeed,
} from '../core/aircraft-readout.js';
import {
    createGtaSpecialVehicleState,
    gtaSpecialVehiclePose,
    specialVehicleVerticalSpeedMps,
} from '../core/gta-special-vehicle.js';

test('height above ground is the aircraft over its own terrain, not the terrain alone', () => {
    const climbing = aircraftInstruments({
        sceneY: 1420,
        groundSceneY: 106,
        verticalSpeedMps: 12.5,
        throttle: 1,
        grounded: false,
    });
    assert.equal(climbing.aglM, 1314);
    assert.equal(climbing.verticalSpeedMps, 12.5);
    assert.equal(climbing.throttlePercent, 100);
});

test('a missing ground reading yields no gauge rather than a plausible zero', () => {
    const instruments = aircraftInstruments({ sceneY: 900, groundSceneY: null });
    assert.equal(instruments.aglM, null);
    assert.equal(formatAircraftAgl(instruments.aglM), '');
});

test('an aircraft below its own ground reads negative instead of being hidden', () => {
    assert.equal(aircraftInstruments({ sceneY: 100, groundSceneY: 130 }).aglM, -30);
});

test('a grounded aircraft never reports a climb rate', () => {
    const instruments = aircraftInstruments({
        verticalSpeedMps: 9,
        grounded: true,
        throttle: 0.42,
    });
    assert.equal(instruments.verticalSpeedMps, 0);
    assert.equal(instruments.throttlePercent, 42);
});

test('vertical speed is the height the solver actually integrates', () => {
    const state = createGtaSpecialVehicleState({ kind: 'airplane' });
    state.grounded = false;
    state.speedMps = 60;
    state.pitch = 10 * Math.PI / 180;
    const expected = Math.sin(state.pitch) * state.speedMps;
    assert.ok(Math.abs(specialVehicleVerticalSpeedMps(state) - expected) < 1e-9);
    assert.ok(Math.abs(gtaSpecialVehiclePose(state).verticalSpeedMps - expected) < 1e-9);
    state.grounded = true;
    assert.equal(specialVehicleVerticalSpeedMps(state), 0);
});

test('a boat has no climb rate at any speed', () => {
    const boat = createGtaSpecialVehicleState({ kind: 'boat' });
    boat.speedMps = 16;
    boat.pitch = 0.2;
    assert.equal(gtaSpecialVehiclePose(boat).verticalSpeedMps, 0);
});

test('gauges format compactly and mark a held throttle', () => {
    assert.equal(formatAircraftAgl(1314.4), 'AGL 1314 m');
    assert.equal(formatAircraftVerticalSpeed(12.53), '↑ 12.5 m/s');
    assert.equal(formatAircraftVerticalSpeed(-3.2), '↓ 3.2 m/s');
    assert.equal(formatAircraftVerticalSpeed(0.01), '→ 0.0 m/s');
    assert.equal(formatAircraftThrottle(75), 'THR 75%');
    assert.equal(formatAircraftThrottle(75, true), 'THR 75% 🔒');
    assert.equal(formatAircraftThrottle(null), '');
});

test('formatting a whole instrument set survives missing values', () => {
    assert.equal(formatAircraftInstruments(null), null);
    const values = formatAircraftInstruments(aircraftInstruments({}));
    assert.deepEqual(values, { agl: '', vertical: '', throttle: '' });
});
