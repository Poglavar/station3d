// Engine-out glide, water touchdown verdicts and airborne spawns of the arcade
// aircraft: the pure contract behind the campaign's bail-out-or-ditch opening.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GTA_SPECIAL_VEHICLE_TUNING,
    classifyAircraftTouchdown,
    createGtaSpecialVehicleState,
    failAircraftEngine,
    gtaSpecialVehiclePose,
    resetGtaSpecialVehicleState,
    specialVehicleVerticalSpeedMps,
    stepGtaSpecialVehicle,
} from '../core/gta-special-vehicle.js';

const SEA_Y = 0.08;
const sea = {
    isWaterAt: () => true,
    waterYAt: () => SEA_Y,
    // The DGU terrain under the sea reads sea level: that sample must never
    // become a landing above the water.
    groundYAt: () => 0,
    isRunwayAt: () => false,
};
const land = (groundY = 10) => ({
    isWaterAt: () => false,
    waterYAt: () => null,
    groundYAt: () => groundY,
    isRunwayAt: () => false,
});

function airborneAircraft(overrides = {}) {
    return createGtaSpecialVehicleState({
        id: 'gta-airplane:test',
        kind: 'airplane',
        x: 0,
        y: 300,
        z: 0,
        heading: 0,
        airborne: true,
        speedMps: 62,
        ...overrides,
    });
}

function run(state, input, seconds, environment, dt = 1 / 60) {
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
        stepGtaSpecialVehicle(state, input, dt, environment);
    }
    return state;
}

test('an airborne spawn cruises hands-off instead of starting on its wheels', () => {
    const state = airborneAircraft();
    assert.equal(state.grounded, false);
    assert.equal(state.speedMps, 62);
    assert.equal(state.throttle, GTA_SPECIAL_VEHICLE_TUNING.airplane.cruiseThrottle);
    assert.equal(state.throttleLocked, true);
    assert.equal(state.engineFailed, false);
    run(state, {}, 3, sea);
    assert.equal(state.grounded, false);
    assert.ok(Math.abs(state.y - 300) < 0.01, `level flight held ${state.y}`);
    assert.ok(state.speedMps > 62, 'held power keeps the aircraft flying');
    assert.ok(state.z > 150, 'the aircraft covers ground along its heading');
    const pose = gtaSpecialVehiclePose(state);
    assert.equal(pose.airborne, true);
    assert.equal(pose.engineFailed, false);
    assert.equal(pose.touchdown, null);
});

test('a dead engine turns the aircraft into a glider it cannot climb out of', () => {
    const state = airborneAircraft();
    assert.equal(failAircraftEngine(state), true);
    assert.equal(failAircraftEngine(state), false, 'a repeated failure effect is idempotent');
    assert.equal(state.throttleLocked, false);
    run(state, {}, 2, sea);
    assert.equal(state.throttle, 0, 'the throttle dies');
    const levelSink = specialVehicleVerticalSpeedMps(state);
    assert.ok(levelSink < -4.5 && levelSink > -5.5, `level glide sinks ${levelSink} m/s`);
    assert.ok(Math.abs(levelSink) < GTA_SPECIAL_VEHICLE_TUNING.touchdown.ditchMaxVerticalSpeedMps,
        'a level glide arrives slow enough to ditch');
    run(state, {}, 30, sea);
    assert.ok(Math.abs(state.speedMps - GTA_SPECIAL_VEHICLE_TUNING.airplane.glideSpeedMps) < 0.5,
        `speed settles on the glide speed, got ${state.speedMps}`);
    // A full flare only softens the descent.
    run(state, { pitchUp: true }, 4, sea);
    assert.ok(state.pitch <= GTA_SPECIAL_VEHICLE_TUNING.airplane.glideMaxPitchUpRad + 1e-9);
    assert.ok(specialVehicleVerticalSpeedMps(state) < 0, 'no climb without an engine');
    // Space does nothing any more.
    const before = state.speedMps;
    run(state, { forward: true }, 3, sea);
    assert.equal(state.throttle, 0);
    assert.ok(state.speedMps <= before + 0.01);
    assert.equal(gtaSpecialVehiclePose(state).engineFailed, true);
});

test('a slow level arrival on water is a ditching that stops the aircraft afloat', () => {
    const state = airborneAircraft({ y: 40 });
    failAircraftEngine(state);
    run(state, {}, 25, sea);
    assert.equal(state.grounded, true);
    assert.equal(state.surface, 'water');
    assert.equal(state.touchdown?.outcome, 'ditched');
    assert.equal(state.wrecked, false);
    assert.equal(state.engineFailed, true);
    assert.ok(Math.abs(state.y - (SEA_Y - GTA_SPECIAL_VEHICLE_TUNING.touchdown.ditchSettleDepthM)) < 1e-9,
        `settles into the water, y=${state.y}`);
    const pose = gtaSpecialVehiclePose(state);
    assert.equal(pose.airborne, false);
    assert.equal(pose.touchdown.surface, 'water');
    // Throttle is dead: the hull only skids to a stop.
    run(state, { forward: true }, 15, sea);
    assert.equal(state.speedMps, 0);
    assert.equal(state.throttle, 0);
    assert.equal(specialVehicleVerticalSpeedMps(state), 0);
});

test('sea-level terrain under the water never lands the aircraft above the sea', () => {
    const state = airborneAircraft({ y: 5 });
    run(state, { pitchDown: true }, 1, sea);
    assert.equal(state.grounded, true);
    assert.equal(state.surface, 'water', 'water takes precedence over the terrain sample');
    assert.ok(state.y < SEA_Y, 'rests in the water, not on wheels above it');
});

test('a dive into the water or a steep hillside arrival is a wreck', () => {
    const dive = airborneAircraft({ y: 60 });
    run(dive, { pitchDown: true, forward: true }, 6, sea);
    assert.equal(dive.grounded, true);
    assert.equal(dive.touchdown?.outcome, 'crashed');
    assert.equal(dive.wrecked, true);
    assert.equal(dive.engineFailed, true);
    const headingAtImpact = dive.heading;
    run(dive, { forward: true, left: true }, 20, sea);
    assert.equal(dive.speedMps, 0, 'a wreck only skids to a stop');
    assert.equal(dive.throttle, 0, 'a wreck takes no throttle');
    assert.equal(dive.heading, headingAtImpact, 'a wreck does not steer');

    const hillside = airborneAircraft({ y: 60 });
    run(hillside, { pitchDown: true }, 6, land(0));
    assert.equal(hillside.grounded, true);
    assert.equal(hillside.surface, 'land');
    assert.equal(hillside.touchdown?.outcome, 'crashed');
    assert.equal(gtaSpecialVehiclePose(hillside).wrecked, true);
});

test('a gentle field landing keeps the aircraft usable and lifting off forgets it', () => {
    const state = airborneAircraft({ y: 12, speedMps: 40 });
    // Level flight holds altitude with a live engine: hold a shallow six-degree
    // descent until the wheels touch.
    for (let seconds = 0; !state.grounded && seconds < 30; seconds += 1 / 60) {
        stepGtaSpecialVehicle(state, { pitchDown: state.pitch > -0.105 }, 1 / 60, land(0));
    }
    assert.equal(state.grounded, true);
    assert.equal(state.surface, 'land');
    assert.equal(state.touchdown?.outcome, 'landed');
    assert.equal(state.wrecked, false);
    assert.equal(state.engineFailed, false);
    run(state, { forward: true }, 12, { ...land(0), isRunwayAt: () => true });
    run(state, { forward: true, pitchUp: true }, 1, { ...land(0), isRunwayAt: () => true });
    assert.equal(state.grounded, false, 'took off again');
    assert.equal(state.surface, null);
    assert.equal(state.touchdown, null);
});

test('an abandoned glider lands itself on the water without any input', () => {
    const state = airborneAircraft({ y: 300 });
    failAircraftEngine(state);
    let seconds = 0;
    while (!state.grounded && seconds < 180) {
        stepGtaSpecialVehicle(state, {}, 1 / 30, sea);
        seconds += 1 / 30;
    }
    assert.equal(state.grounded, true, 'came down within three minutes');
    assert.equal(state.touchdown?.outcome, 'ditched');
    assert.ok(seconds > 50 && seconds < 90, `glide lasted ${seconds.toFixed(0)} s`);
});

test('reset restores the airborne spawn with a live engine', () => {
    const state = airborneAircraft({ y: 120 });
    failAircraftEngine(state);
    run(state, {}, 60, sea);
    assert.equal(state.grounded, true);
    resetGtaSpecialVehicleState(state);
    assert.equal(state.grounded, false);
    assert.equal(state.y, 120);
    assert.equal(state.speedMps, 62);
    assert.equal(state.engineFailed, false);
    assert.equal(state.throttleLocked, true);
    assert.equal(state.touchdown, null);
    assert.equal(state.surface, null);
    assert.equal(state.wrecked, false);
});

test('an engine-out spawn resumes the emergency exactly as saved', () => {
    const state = airborneAircraft({ y: 250, engineFailed: true });
    assert.equal(state.engineFailed, true);
    assert.equal(state.throttle, 0);
    assert.equal(state.throttleLocked, false);
    run(state, {}, 1, sea);
    assert.ok(state.y < 250, 'already sinking');
});

test('touchdown verdicts share one threshold set', () => {
    const rules = GTA_SPECIAL_VEHICLE_TUNING.touchdown;
    assert.equal(classifyAircraftTouchdown({ surface: 'water', speedMps: 36, verticalSpeedMps: -4 }), 'ditched');
    assert.equal(classifyAircraftTouchdown({ surface: 'water', speedMps: rules.ditchMaxSpeedMps + 1, verticalSpeedMps: -1 }), 'crashed');
    assert.equal(classifyAircraftTouchdown({ surface: 'water', speedMps: 30, verticalSpeedMps: -(rules.ditchMaxVerticalSpeedMps + 0.1) }), 'crashed');
    assert.equal(classifyAircraftTouchdown({ surface: 'land', speedMps: 80, verticalSpeedMps: -2 }), 'landed');
    assert.equal(classifyAircraftTouchdown({ surface: 'land', speedMps: 30, verticalSpeedMps: -12 }), 'crashed');
    assert.equal(classifyAircraftTouchdown({ surface: 'land', speedMps: null, verticalSpeedMps: null }), 'landed');
});
