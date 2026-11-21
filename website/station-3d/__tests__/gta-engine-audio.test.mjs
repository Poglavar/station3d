// Locks the GTA engine's gear/RPM response and continuous recorded-loop mix.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    gtaEngineAudioTargets,
    gtaEngineGear,
    gtaEngineSampleMix,
} from '../core/gta-engine-audio-model.js';

test('the stopped car has a persistent combustion idle', () => {
    const idle = gtaEngineAudioTargets({ speedMps: 0, throttle: false });
    assert.equal(idle.gear, 1);
    assert.equal(idle.rpm, 850);
    assert.ok(idle.firingHz > 25);
    assert.ok(idle.masterGain > 0);
});

test('throttle raises RPM and intake load before the car starts moving', () => {
    const idle = gtaEngineAudioTargets({ speedMps: 0, throttle: false });
    const rev = gtaEngineAudioTargets({ speedMps: 0, throttle: true });
    assert.ok(rev.rpm > idle.rpm * 2);
    assert.ok(rev.masterGain > idle.masterGain);
    assert.ok(rev.intakeGain > idle.intakeGain);
});

test('road speed selects deterministic forward gears and reverse stays distinct', () => {
    assert.equal(gtaEngineGear(10), 1);
    assert.equal(gtaEngineGear(35), 2);
    assert.equal(gtaEngineGear(70), 3);
    assert.equal(gtaEngineGear(90, true), -1);
    assert.equal(gtaEngineAudioTargets({ speedMps: -5, reverse: true }).gear, -1);
});

test('damage adds bounded engine roughness without silencing it', () => {
    const healthy = gtaEngineAudioTargets({ speedMps: 15, throttle: true, health: 100 });
    const damaged = gtaEngineAudioTargets({ speedMps: 15, throttle: true, health: 0 });
    assert.equal(healthy.detuneCents, 0);
    assert.ok(damaged.detuneCents < 0);
    assert.ok(damaged.masterGain > 0);
    assert.ok(damaged.filterHz >= 500 && damaged.filterHz <= 3800);
});

test('recorded RPM layers crossfade continuously from idle to redline', () => {
    const idle = gtaEngineSampleMix(850);
    const middle = gtaEngineSampleMix((850 + 5200) * 0.5);
    const redline = gtaEngineSampleMix(5200);
    assert.deepEqual(idle.gains, [1, 0, 0, 0, 0, 0]);
    assert.deepEqual(redline.gains, [0, 0, 0, 0, 0, 1]);
    assert.equal(middle.gains.filter(gain => gain > 0).length, 2);
    assert.ok(Math.abs(middle.gains.reduce((sum, gain) => sum + gain ** 2, 0) - 1) < 1e-9);
    assert.ok(idle.playbackRate < middle.playbackRate);
    assert.ok(middle.playbackRate < redline.playbackRate);
});
