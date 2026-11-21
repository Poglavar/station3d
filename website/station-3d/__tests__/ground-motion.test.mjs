// Locks the distinction between what a vehicle's engine reports and what it is
// actually doing. A car wedged against a building was measured reporting
// 128 km/h with a static position for 70 seconds, which kept "stop to exit"
// on screen for good.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    createGroundMotionTracker,
    isVehicleStuck,
    vehicleExitSpeedMps,
    STUCK_HOLD_SECONDS,
} from '../core/ground-motion.js';

// Feeds the tracker a straight run at a constant speed.
function driveStraight(tracker, { speedMps, seconds, engineSpeedMps, stepMs = 20 }) {
    let ms = 0;
    let x = 0;
    for (; ms <= seconds * 1000; ms += stepMs) {
        tracker.record({ x, z: 0, nowMs: ms, engineSpeedMps });
        x += speedMps * (stepMs / 1000);
    }
    return tracker;
}

test('ground speed follows real displacement, not the engine', () => {
    const moving = driveStraight(createGroundMotionTracker(), {
        speedMps: 12,
        seconds: 2,
        engineSpeedMps: 12,
    });
    assert.ok(Math.abs(moving.speedMps() - 12) < 0.5, `got ${moving.speedMps()}`);

    const wedged = createGroundMotionTracker();
    for (let ms = 0; ms <= 2000; ms += 20) {
        wedged.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 35.5 });
    }
    assert.equal(wedged.speedMps(), 0);
});

test('a wedged vehicle accumulates stuck time and a parked one never does', () => {
    const wedged = createGroundMotionTracker();
    for (let ms = 0; ms <= 10_000; ms += 20) {
        wedged.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 35.5 });
    }
    assert.ok(wedged.stuckSeconds() > STUCK_HOLD_SECONDS, `got ${wedged.stuckSeconds()}`);
    assert.equal(isVehicleStuck({
        groundSpeedMps: wedged.speedMps(),
        engineSpeedMps: 35.5,
        heldSeconds: wedged.stuckSeconds(),
    }), true);

    // Idling in a lay-by is the same standstill with an honest engine reading.
    const parked = createGroundMotionTracker();
    for (let ms = 0; ms <= 10_000; ms += 20) {
        parked.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 0 });
    }
    assert.equal(parked.stuckSeconds(), 0);
    assert.equal(isVehicleStuck({
        groundSpeedMps: 0,
        engineSpeedMps: 0,
        heldSeconds: 10,
    }), false);
});

test('stuck time resets the moment the vehicle actually moves', () => {
    const tracker = createGroundMotionTracker();
    for (let ms = 0; ms <= 8000; ms += 20) {
        tracker.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 30 });
    }
    assert.ok(tracker.stuckSeconds() > STUCK_HOLD_SECONDS);
    driveStraight(tracker, { speedMps: 8, seconds: 1, engineSpeedMps: 30 });
    assert.equal(tracker.stuckSeconds(), 0);
});

test('a clock that jumps backwards starts a fresh window', () => {
    const tracker = createGroundMotionTracker();
    for (let ms = 0; ms <= 8000; ms += 20) {
        tracker.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 30 });
    }
    assert.ok(tracker.stuckSeconds() > 0);
    tracker.record({ x: 0, z: 0, nowMs: 5, engineSpeedMps: 30 });
    assert.equal(tracker.stuckSeconds(), 0);
    assert.equal(tracker.speedMps(), null);
});

test('an unobserved frame gap cannot manufacture a stuck failure', () => {
    const tracker = createGroundMotionTracker();
    for (let ms = 0; ms <= 3000; ms += 20) {
        tracker.record({ x: 0, z: 0, nowMs: ms, engineSpeedMps: 30 });
    }
    assert.ok(tracker.stuckSeconds() > 0);

    // Nothing was sampled during this hitch. Counting all of it as wedged
    // time used to fail a recovered campaign car on the first frame back.
    tracker.record({ x: 0, z: 0, nowMs: 10_000, engineSpeedMps: 30 });
    assert.equal(tracker.stuckSeconds(), 0);
    assert.equal(tracker.speedMps(), null);
});

test('the exit gate believes the ground, and falls back to the engine', () => {
    // The bug: 35.5 m/s of chassis velocity kept the door shut on a car that
    // had not moved in over a minute.
    assert.equal(vehicleExitSpeedMps(35.5, 0), 0);
    assert.equal(vehicleExitSpeedMps(-12, 11.4), 11.4);
    // No settled ground reading yet — the engine is all there is.
    assert.equal(vehicleExitSpeedMps(4, null), 4);
    assert.equal(vehicleExitSpeedMps(null, null), 0);
});

// The wiring below cannot be exercised without a browser, and getting it wrong
// is silent: the gate would go back to trusting the engine and the player would
// be locked in again with every unit test still green.
test('the GTA exit gate and prompt both read the ground speed', () => {
    const source = readFileSync(new URL('../modes/gta.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ createGroundMotionTracker, vehicleExitSpeedMps \}/);
    assert.match(source, /function exitSpeedMps\(pose\) \{\n\s*return vehicleExitSpeedMps\(pose\?\.speedMps, groundSpeedMps\(\)\);/);
    // Both the door and the prompt that describes it.
    assert.match(source, /beginExit\(occupant, \{\n\s*speedMps: exitSpeedMps\(pose\),/);
    assert.match(source, /const pose = currentVehiclePose\(\);\s*const speedMps = exitSpeedMps\(pose\);/);
    assert.doesNotMatch(
        source,
        /const speedMps = Math\.abs\(Number\(currentVehiclePose\(\)\?\.speedMps\)/,
        'the prompt is reading engine speed again',
    );
    // Both physics paths must feed the tracker or boats report nothing.
    assert.ok((source.match(/recordGroundMotion\(pose\);/g) || []).length >= 2);
    // A streamed-support hold is a real standstill. It must clear the stale
    // chassis velocity and restart the displacement tracker before returning.
    assert.match(source, /function holdRoadVehicleForSurface\(pose\)[\s\S]{0,900}groundMotion\.reset\(\);[\s\S]{0,160}recordGroundMotion\(heldPose\);/);
    assert.match(source, /if \(!Number\.isFinite\(physicsSupportY\([\s\S]{0,180}return holdRoadVehicleForSurface\(beforeStep\);/);
    assert.match(source, /if \(!groundCoverageAllowsStep\(beforeStep\)\)[\s\S]{0,260}return holdRoadVehicleForSurface\(beforeStep\);/);
});


test('an unsettled ground reading never reports stuck', () => {
    const tracker = createGroundMotionTracker();
    tracker.record({ x: 0, z: 0, nowMs: 0, engineSpeedMps: 30 });
    tracker.record({ x: 0, z: 0, nowMs: 20, engineSpeedMps: 30 });
    assert.equal(tracker.speedMps(), null);
    assert.equal(tracker.stuckSeconds(), 0);
    assert.equal(isVehicleStuck({
        groundSpeedMps: null,
        engineSpeedMps: 30,
        heldSeconds: 99,
    }), false);
});
