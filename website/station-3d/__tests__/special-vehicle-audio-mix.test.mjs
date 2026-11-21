// Locks the recorded-loop levels for player-driven boats and aircraft. The
// boat's diesel was mixed near silence (idle 0.025, peak 0.175 against the
// car's ~0.92) and the user heard nothing; these assertions fail if anyone
// puts it back there, and hold the aircraft exactly where it was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { specialVehicleAudioMix, specialVehicleSpeedRatio } from '../core/special-vehicle-audio-mix.js';

// What the boat used to be, kept here as the regression guard.
const OLD_BOAT_IDLE_GAIN = 0.025;
const OLD_BOAT_PEAK_GAIN = 0.175; // 0.025 + 0.115 + 0.035
const OLD_BOAT_PEAK_WAKE_GAIN = 0.17;
// ui/gta-engine-audio.js plays the car's recorded loops at mix.gains * 0.92.
const CAR_PEAK_GAIN = 0.92;

const boat = (speedMps, throttle) => specialVehicleAudioMix({ kind: 'boat', speedMps, throttle });
const airplane = (speedMps, throttle) => specialVehicleAudioMix({ kind: 'airplane', speedMps, throttle });

test('the boat diesel idles audibly and is loud at full throttle, still under the car', () => {
    const idle = boat(0, 0);
    assert.ok(
        idle.engineGain >= 0.10 && idle.engineGain <= 0.13,
        `idle engine gain ${idle.engineGain} is outside the intended 0.10-0.13 band`,
    );
    const full = boat(18, 1);
    assert.equal(full.speedRatio, 1);
    assert.ok(
        full.engineGain >= 0.55 && full.engineGain <= 0.65,
        `full-throttle engine gain ${full.engineGain} is outside the intended 0.55-0.65 band`,
    );
    assert.ok(full.engineGain < CAR_PEAK_GAIN, 'the boat must stay under the car');
});

test('the boat is decisively louder than the near-silent mix it replaced', () => {
    const idle = boat(0, 0).engineGain;
    const peak = boat(18, 1).engineGain;
    assert.ok(idle > OLD_BOAT_IDLE_GAIN * 3, `idle ${idle} is not clearly above the old ${OLD_BOAT_IDLE_GAIN}`);
    assert.ok(peak > OLD_BOAT_PEAK_GAIN * 3, `peak ${peak} is not clearly above the old ${OLD_BOAT_PEAK_GAIN}`);
    // Even shut down and drifting, the engine must beat the OLD flat-out level,
    // which is what "I hear nothing" meant.
    assert.ok(boat(9, 0).engineGain > OLD_BOAT_PEAK_GAIN);
});

test('gain rises with throttle and speed, and the wake follows the engine up without covering it', () => {
    assert.ok(boat(0, 0).engineGain < boat(0, 0.5).engineGain);
    assert.ok(boat(0, 1).engineGain < boat(18, 1).engineGain);
    const peakWake = boat(18, 1).wakeGain;
    assert.ok(peakWake > OLD_BOAT_PEAK_WAKE_GAIN, `wake ${peakWake} did not rise with the engine`);
    assert.equal(boat(0, 0).wakeGain, 0);
    for (let speedMps = 0; speedMps <= 24; speedMps += 0.5) {
        for (const throttle of [0, 0.25, 0.5, 1]) {
            const levels = boat(speedMps, throttle);
            assert.ok(
                levels.wakeGain < levels.engineGain,
                `wake ${levels.wakeGain} >= engine ${levels.engineGain} at ${speedMps} m/s, throttle ${throttle}`,
            );
        }
    }
});

test('the boat playback rates are unchanged', () => {
    assert.equal(boat(0, 0).engineRate, 0.82);
    assert.equal(boat(18, 1).engineRate, 0.82 + 0.28 + 0.12);
    assert.equal(boat(9, 0.5).engineRate, 0.82 + 0.5 * 0.28 + 0.5 * 0.12);
    assert.equal(boat(0, 0).wakeRate, 0.86);
    assert.equal(boat(18, 1).wakeRate, 0.86 + 0.32);
});

test('the aircraft mix is exactly what it was', () => {
    for (const [speedMps, throttle] of [[0, 0], [46, 0.5], [92, 1], [200, 1], [12, 0.2]]) {
        const speedRatio = Math.min(1, Math.abs(speedMps) / 92);
        const levels = airplane(speedMps, throttle);
        assert.equal(levels.speedRatio, speedRatio);
        assert.equal(levels.engineGain, 0.035 + throttle * 0.15 + speedRatio * 0.035);
        assert.equal(levels.engineRate, 0.82 + throttle * 0.42 + speedRatio * 0.12);
        assert.equal(levels.wakeGain, 0, 'the aircraft has no wake voice');
    }
    // The aircraft speed reference stays 92 m/s, the boat's 18 m/s.
    assert.equal(specialVehicleSpeedRatio('airplane', 46), 0.5);
    assert.equal(specialVehicleSpeedRatio('boat', 9), 0.5);
});

test('junk poses stay finite and clamped instead of screaming or inverting', () => {
    const junk = [
        { kind: 'boat', speedMps: NaN, throttle: NaN },
        { kind: 'boat', speedMps: null, throttle: null },
        { kind: 'boat', speedMps: undefined, throttle: undefined },
        { kind: 'boat', speedMps: -12, throttle: -3 },
        { kind: 'boat', speedMps: 1e9, throttle: 40 },
        { kind: 'boat', speedMps: 'fast', throttle: 'open' },
        { kind: 'airplane', speedMps: -Infinity, throttle: Infinity },
        { kind: 'submarine', speedMps: 5, throttle: 0.5 },
        {},
    ];
    for (const pose of junk) {
        const levels = specialVehicleAudioMix(pose);
        for (const [key, value] of Object.entries(levels)) {
            if (key === 'kind') continue;
            assert.ok(Number.isFinite(value), `${key} is not finite for ${JSON.stringify(pose)}`);
        }
        assert.ok(levels.speedRatio >= 0 && levels.speedRatio <= 1);
        assert.ok(levels.engineGain > 0 && levels.engineGain < CAR_PEAK_GAIN);
        assert.ok(levels.wakeGain >= 0 && levels.wakeGain < CAR_PEAK_GAIN);
        assert.ok(levels.engineRate > 0 && levels.engineRate < 2);
        assert.ok(levels.wakeRate > 0 && levels.wakeRate < 2);
    }
    // A negative speed is a boat in reverse, not a silent one.
    assert.deepEqual(specialVehicleAudioMix({ kind: 'boat', speedMps: -9, throttle: 0.5 }), boat(9, 0.5));
    // An unknown kind is mixed as a boat, matching the audio session's own
    // normalization in ui/gta-special-vehicle-audio.js.
    assert.deepEqual(specialVehicleAudioMix({ kind: 'submarine', speedMps: 9, throttle: 0.5 }), boat(9, 0.5));
});
