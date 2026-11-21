import test from 'node:test';
import assert from 'node:assert/strict';

import {
    driveCommandForKeys,
    GTA_IMPACT,
    GTA_VEHICLE_REPAIR,
    gtaSceneYawToHeadingDeg,
    impactBandForForce,
    repairedVehicleHealth,
    shouldApplyStoppedVehicleHold,
    shouldHandleVehicleResetKeyDown,
    shouldReleaseLatchedStopOnKeyDown,
    steeringLimitAtSpeed,
    steeringInputForKeys,
    vehicleSurfaceRecovery,
    vehicleDamageForImpact,
} from '../core/gta-config.js';

test('vehicle scene yaw publishes the compass heading used by stream corridors', () => {
    assert.equal(gtaSceneYawToHeadingDeg(Math.PI), 0);
    assert.equal(gtaSceneYawToHeadingDeg(Math.PI / 2), 90);
    assert.equal(gtaSceneYawToHeadingDeg(0), 180);
    assert.equal(gtaSceneYawToHeadingDeg(-Math.PI / 2), 270);
});

test('vehicle reset belongs only to an unmodified physical R press', () => {
    assert.equal(shouldHandleVehicleResetKeyDown('r'), true);
    assert.equal(shouldHandleVehicleResetKeyDown('r', { ctrlKey: true }), false);
    assert.equal(shouldHandleVehicleResetKeyDown('r', { metaKey: true }), false);
    assert.equal(shouldHandleVehicleResetKeyDown('r', { altKey: true }), false);
    assert.equal(shouldHandleVehicleResetKeyDown('r', { shiftKey: true }), false);
    assert.equal(shouldHandleVehicleResetKeyDown('r', { repeat: true }), false);
    assert.equal(shouldHandleVehicleResetKeyDown('w'), false);
});

test('a real new W/S press releases Stop even if the held-key set went stale', () => {
    assert.equal(shouldReleaseLatchedStopOnKeyDown('w', { repeat: false }), true);
    assert.equal(shouldReleaseLatchedStopOnKeyDown('arrowup', { repeat: false }), true);
    assert.equal(shouldReleaseLatchedStopOnKeyDown('s', { repeat: false }), true);
    assert.equal(shouldReleaseLatchedStopOnKeyDown('arrowdown', { repeat: false }), true);
    assert.equal(shouldReleaseLatchedStopOnKeyDown('w', { repeat: true }), false);
    assert.equal(shouldReleaseLatchedStopOnKeyDown('a', { repeat: false }), false);
});

test('forward and reverse use Rapier axis signs that match the visible +Z car', () => {
    assert.ok(driveCommandForKeys({ forward: true }).engineForceN < 0);
    assert.ok(driveCommandForKeys({ reverse: true }).engineForceN > 0);
});

test('opposite-direction input brakes before changing direction', () => {
    const forwardWhileReversing = driveCommandForKeys({ forward: true, speedMps: -4 });
    const reverseWhileForward = driveCommandForKeys({ reverse: true, speedMps: 4 });
    assert.equal(forwardWhileReversing.engineForceN, 0);
    assert.ok(forwardWhileReversing.serviceBrakeImpulseNs > 0);
    assert.equal(reverseWhileForward.engineForceN, 0);
    assert.ok(reverseWhileForward.serviceBrakeImpulseNs > 0);
    assert.equal(
        driveCommandForKeys({ reverse: true, speedMps: 0.2 }).serviceBrakeImpulseNs,
        0,
    );
    assert.ok(driveCommandForKeys({ reverse: true, speedMps: 0.2 }).engineForceN > 0);
});

test('A/left and D/right follow the conventional driving direction', () => {
    assert.equal(steeringInputForKeys({ left: true }), 1);
    assert.equal(steeringInputForKeys({ right: true }), -1);
    assert.equal(steeringInputForKeys({ left: true, right: true }), 0);
});

test('high-speed steering is limited by a plausible lateral-acceleration envelope', () => {
    assert.ok(steeringLimitAtSpeed(2) > 0.4);
    assert.ok(steeringLimitAtSpeed(80 / 3.6) < 0.035);
    assert.ok(steeringLimitAtSpeed(80 / 3.6) > 0.015);
});

test('holding both pedals requests service braking and never engine force', () => {
    const command = driveCommandForKeys({ forward: true, reverse: true, speedMps: 10 });
    assert.equal(command.engineForceN, 0);
    assert.ok(command.serviceBrakeImpulseNs > 0);
});

test('latched stop applies the full service brake without throttle or handbrake', () => {
    const command = driveCommandForKeys({ stop: true, speedMps: 10 });
    assert.equal(command.engineForceN, 0);
    assert.ok(command.serviceBrakeImpulseNs > 0);
    assert.equal(command.handbrakeImpulseNs, 0);
});

test('latched stop holds slope drift and stale throttle but never cancels a collision impulse', () => {
    assert.equal(shouldApplyStoppedVehicleHold({ stop: true, planarSpeedMps: 0.08 }), true);
    assert.equal(shouldApplyStoppedVehicleHold({
        stop: true,
        planarSpeedMps: 0.08,
        throttle: true,
    }), true);
    assert.equal(shouldApplyStoppedVehicleHold({
        stop: true,
        planarSpeedMps: 0.08,
        playerContact: true,
    }), false);
    assert.equal(shouldApplyStoppedVehicleHold({ stop: true, planarSpeedMps: 3 }), false);
    assert.equal(shouldApplyStoppedVehicleHold({ stop: false, planarSpeedMps: 0 }), false);
});

test('surface recovery only lifts a chassis that penetrated its support', () => {
    assert.equal(vehicleSurfaceRecovery({ supportProbeY: null, supportY: 1 }), null);
    assert.equal(vehicleSurfaceRecovery({ supportProbeY: 0, supportY: null }), null);
    assert.equal(vehicleSurfaceRecovery({ supportProbeY: 1, supportY: 1.03 }), null);
    assert.deepEqual(
        vehicleSurfaceRecovery({ supportProbeY: 0.4, supportY: 1, verticalVelocity: -7 }),
        { liftM: 0.6, verticalVelocity: 0 },
    );
    assert.deepEqual(
        vehicleSurfaceRecovery({ supportProbeY: 0.4, supportY: 1, verticalVelocity: 2 }),
        { liftM: 0.6, verticalVelocity: 2 },
    );
});

test('impact policy separates harmless contact, feedback and damaging crashes', () => {
    assert.equal(impactBandForForce(400), 'none');
    assert.equal(impactBandForForce(1200), 'low');
    assert.equal(impactBandForForce(4000), 'medium');
    assert.equal(impactBandForForce(8000), 'severe');
    // Damage deliberately starts ABOVE the feedback bands. A kerb, a bollard or
    // the car in front should sound and spark without denting a vehicle that has
    // no other way to recover — and whose reaching zero fails a campaign chapter.
    assert.equal(vehicleDamageForImpact(1200), 0);
    assert.equal(vehicleDamageForImpact(5000), 0, 'a medium-band scrape is not a dent');
    assert.ok(vehicleDamageForImpact(GTA_IMPACT.damageForceN * 1.5) > 0);
    assert.ok(vehicleDamageForImpact(100000) <= GTA_IMPACT.maxDamagePerContact);
    assert.ok(GTA_IMPACT.damageForceN > GTA_IMPACT.mediumForceN,
        'damage must not share the feedback threshold again');
});

test('a vehicle nobody is hitting repairs itself, but a wreck stays wrecked', () => {
    const { delayS, perSecond, maxHealth } = GTA_VEHICLE_REPAIR;
    // Inside the grace period nothing happens, however long the frame.
    assert.equal(repairedVehicleHealth(50, delayS - 0.1, 1), 50);
    // After it, health climbs at the configured rate.
    assert.equal(repairedVehicleHealth(50, delayS, 1), 50 + perSecond);
    // It stops at full and never overshoots.
    assert.equal(repairedVehicleHealth(maxHealth, 999, 10), maxHealth);
    assert.equal(repairedVehicleHealth(maxHealth - 1, 999, 10), maxHealth);
    // A destroyed vehicle is not quietly undone — the failure screen must mean
    // something.
    assert.equal(repairedVehicleHealth(0, 999, 10), 0);
    // Junk in, no NaN out.
    assert.equal(repairedVehicleHealth(Number.NaN, 999, 1), 0);
    assert.equal(repairedVehicleHealth(40, Number.NaN, 1), 40);
    assert.equal(repairedVehicleHealth(40, 999, Number.NaN), 40);
});
