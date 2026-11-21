// The walker's canopy descent after bailing out of an aircraft: a steady sink,
// steerable drift at a fixed pace, no jetpack, and a canopy spent on landing.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PARACHUTE_DESCENT_VY,
    PARACHUTE_DRIFT_MPS,
    beginWalkParachute,
    clearWalkKeys,
    createWalkState,
    onKeyDown,
    setWalkSpeed,
    stepWalk,
} from '../modes/walk.js';
import { haversineMeters } from '../core/math.js';

const localXZ = (lat, lon) => ({ x: lon * 1000, z: -lat * 1000 });

function descend(ws, seconds, getGroundY, dt = 1 / 60) {
    let last = null;
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
        last = stepWalk(ws, dt, 0, getGroundY, localXZ, null);
    }
    return last;
}

test('bailing out hands the walker a canopy that settles onto a steady descent', (t) => {
    t.after(clearWalkKeys);
    const ws = createWalkState(43.07, 16.19, { initialY: 0, initialGroundY: 0 });
    assert.equal(beginWalkParachute(ws, { lat: 43.07, lon: 16.19, y: 300, yaw: 1 }), true);
    assert.equal(ws.airborne, true);
    assert.equal(ws.parachute, true);
    // Nothing under the sea yet: a parachutist must keep descending instead of
    // hanging on the missing-floor guard.
    const noGround = () => null;
    const result = descend(ws, 4, noGround);
    assert.ok(Math.abs(ws.vy - PARACHUTE_DESCENT_VY) < 1e-6, `settled at ${ws.vy} m/s`);
    assert.ok(ws.y < 300 - 15, `kept descending, y=${ws.y}`);
    assert.equal(result.parachute, true);
    assert.equal(result.airborne, true);
    assert.ok(result.verticalSpeedMps < 0);
    assert.equal(result.jetpackHeld, false);
});

test('a canopy drifts at its own pace and ignores the jetpack', (t) => {
    t.after(() => { clearWalkKeys(); setWalkSpeed(25); });
    setWalkSpeed(1.8);   // story pace: far too slow to steer a descent with
    const ws = createWalkState(43.07, 16.19, { initialY: 0, initialGroundY: 0 });
    beginWalkParachute(ws, { lat: 43.07, lon: 16.19, y: 200, yaw: 0 });
    onKeyDown('w');
    onKeyDown(' ');
    const startLat = ws.lat;
    const startLon = ws.lon;
    const result = descend(ws, 2, () => null);
    const driftM = haversineMeters(startLat, startLon, ws.lat, ws.lon);
    assert.ok(Math.abs(driftM - PARACHUTE_DRIFT_MPS * 2) < 0.5, `drifted ${driftM} m in 2 s`);
    assert.equal(result.jetpackHeld, false, 'Space does not fire the jetpack under a canopy');
    assert.ok(ws.vy < 0, 'still descending');
});

test('touching the surface spends the canopy and reports the landing', (t) => {
    t.after(clearWalkKeys);
    const ws = createWalkState(43.07, 16.19, { initialY: 0, initialGroundY: 0 });
    beginWalkParachute(ws, { lat: 43.07, lon: 16.19, y: 12, yaw: 0 });
    let landing = null;
    for (let elapsed = 0; elapsed < 6 && !landing; elapsed += 1 / 60) {
        const result = stepWalk(ws, 1 / 60, 0, () => 0.08, localXZ, null);
        if (result.landed) landing = result;
    }
    assert.ok(landing, 'landed within six seconds');
    assert.ok(Math.abs(landing.impactSpeedMps - Math.abs(PARACHUTE_DESCENT_VY)) < 0.2);
    assert.equal(ws.parachute, false);
    assert.equal(ws.airborne, false);
    assert.equal(landing.parachute, false);
    assert.equal(landing.verticalSpeedMps, 0);
    // Walking on afterwards uses the ordinary pace again.
    onKeyDown('w');
    const before = { lat: ws.lat, lon: ws.lon };
    stepWalk(ws, 1, 0, () => 0.08, localXZ, null);
    const stepM = haversineMeters(before.lat, before.lon, ws.lat, ws.lon);
    assert.ok(stepM > PARACHUTE_DRIFT_MPS + 1, `free-roam pace resumed (${stepM} m/s)`);
});
