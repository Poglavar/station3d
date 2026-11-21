// Locks the hair follow-through: it lags the stride, is bounded, damps to
// rest when the actor stops, and trails a body turn before catching up.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    HAIR_SWING_LIMIT_RAD,
    createHairSwingState,
    isHairSwingSettled,
    stepHairSwing,
} from '../core/hair-swing.js';

const DT = 1 / 120;
const PHASE_RATE = 8; // rad/s, as campaign-actors advances the walk phase

function walkSeries(seconds, { walking = 1, heading = 0 } = {}) {
    const state = createHairSwingState();
    const samples = [];
    for (let step = 1; step * DT <= seconds; step++) {
        const t = step * DT;
        assert.equal(stepHairSwing(state, { phase: t * PHASE_RATE, walking, heading, dt: DT }), state);
        samples.push({ t, pitch: state.pitch, roll: state.roll, yaw: state.yaw, driver: Math.sin(2 * t * PHASE_RATE) });
    }
    return { state, samples };
}

function localMaxAfter(samples, key, from, until) {
    let best = null;
    for (const sample of samples) {
        if (sample.t < from || sample.t > until) continue;
        if (!best || sample[key] > best[key]) best = sample;
    }
    return best;
}

test('while walking the hair swings with real amplitude and lags the stride', () => {
    const { samples } = walkSeries(4);
    const period = Math.PI / PHASE_RATE; // the bob repeats twice a stride
    const driverPeakT = (Math.PI / 4 + 12 * Math.PI) / (2 * PHASE_RATE);
    const driverPeak = localMaxAfter(samples, 'driver', driverPeakT - 0.01, driverPeakT + 0.01);
    const response = localMaxAfter(samples, 'pitch', driverPeak.t, driverPeak.t + period);
    const lag = response.t - driverPeak.t;
    assert.ok(lag > 0.02 && lag < period / 2, `hair must peak after the stride, lag ${lag.toFixed(3)} s`);
    assert.ok(response.pitch > 0.03, `swing must be visible, peak ${response.pitch.toFixed(3)} rad`);
    const rollPeak = Math.max(...samples.map(sample => Math.abs(sample.roll)));
    assert.ok(rollPeak > 0.015 && rollPeak < HAIR_SWING_LIMIT_RAD, `side sway ${rollPeak.toFixed(3)}`);
    assert.ok(samples.every(sample => Math.abs(sample.pitch) <= HAIR_SWING_LIMIT_RAD));
});

test('stopping damps the swing to rest instead of cutting it', () => {
    const state = createHairSwingState();
    let t = 0;
    for (; t < 3; t += DT) stepHairSwing(state, { phase: t * PHASE_RATE, walking: 1, dt: DT });
    assert.equal(isHairSwingSettled(state), false);
    const envelope = [];
    for (let window = 0; window < 4; window++) {
        let peak = 0;
        for (let step = 0; step < 0.4 / DT; step++) {
            t += DT;
            stepHairSwing(state, { phase: t * PHASE_RATE, walking: 0, dt: DT });
            peak = Math.max(peak, Math.abs(state.pitch), Math.abs(state.roll));
        }
        envelope.push(peak);
    }
    assert.ok(envelope[0] > 0.005, 'the first window after stopping still swings');
    for (let index = 1; index < envelope.length; index++) {
        assert.ok(envelope[index] < envelope[index - 1] * 0.5, `envelope must decay: ${envelope.map(v => v.toFixed(4)).join(' → ')}`);
    }
    for (let step = 0; step < 2 / DT; step++) {
        t += DT;
        stepHairSwing(state, { phase: t * PHASE_RATE, walking: 0, dt: DT });
    }
    assert.equal(isHairSwingSettled(state), true);
    assert.equal(isHairSwingSettled(createHairSwingState()), true);
});

test('a body turn leaves the hair behind, then it overshoots and settles', () => {
    const state = createHairSwingState();
    stepHairSwing(state, { phase: 0, heading: 0, dt: DT });
    stepHairSwing(state, { phase: 0, heading: Math.PI / 2, dt: DT });
    assert.ok(state.yaw < -0.3, `hair must trail a quarter turn, yaw ${state.yaw.toFixed(3)}`);
    assert.ok(state.yaw >= -HAIR_SWING_LIMIT_RAD);
    let overshoot = 0;
    for (let step = 0; step < 2 / DT; step++) {
        stepHairSwing(state, { phase: 0, heading: Math.PI / 2, dt: DT });
        overshoot = Math.max(overshoot, state.yaw);
    }
    assert.ok(overshoot > 0.01, 'under-damped: one visible overshoot past centre');
    assert.equal(isHairSwingSettled(state), true);

    // A heading wrap across ±π is a small turn, not a full revolution.
    const wrapped = createHairSwingState();
    stepHairSwing(wrapped, { phase: 0, heading: Math.PI - 0.04, dt: DT });
    stepHairSwing(wrapped, { phase: 0, heading: -Math.PI + 0.04, dt: DT });
    assert.ok(Math.abs(wrapped.yaw) < 0.06, `wrap must not spin the hair, yaw ${wrapped.yaw.toFixed(3)}`);
});

test('inputs are validated loudly and a hitch is integrated as one bounded step', () => {
    const state = createHairSwingState();
    assert.throws(() => stepHairSwing(state, { phase: 0, dt: NaN }), TypeError);
    assert.throws(() => stepHairSwing(state, { phase: null, dt: DT }), TypeError);
    assert.throws(() => stepHairSwing(state, { phase: 0, walking: 'yes', dt: DT }), TypeError);
    for (let step = 0; step < 50; step++) stepHairSwing(state, { phase: step * 0.7, walking: 1, dt: 1.5 });
    assert.ok(Number.isFinite(state.pitch) && Math.abs(state.pitch) <= HAIR_SWING_LIMIT_RAD);
    assert.ok(Number.isFinite(state.pitchVel), 'a huge dt never blows the integrator up');
});
