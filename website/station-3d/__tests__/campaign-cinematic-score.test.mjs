// Verifies that the cinematic pad is bounded, muted through the supplied app
// destination, and can fade out early without leaving live oscillator nodes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleCampaignCinematicScore } from '../ui/campaign-cinematic-score.js';

function audioParam(initialValue = 0) {
    return {
        value: initialValue,
        events: [],
        setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); },
        exponentialRampToValueAtTime(value, time) {
            this.value = value;
            this.events.push(['ramp', value, time]);
        },
        setTargetAtTime(value, time, constant) {
            this.value = value;
            this.events.push(['target', value, time, constant]);
        },
        cancelScheduledValues(time) { this.events.push(['cancel', time]); },
    };
}

function connectable() {
    return {
        connectedTo: null,
        disconnected: false,
        connect(target) { this.connectedTo = target; return target; },
        disconnect() { this.disconnected = true; },
    };
}

function fakeContext() {
    const gains = [];
    const oscillators = [];
    const filters = [];
    return {
        currentTime: 3,
        gains,
        oscillators,
        filters,
        createGain() {
            const gain = { ...connectable(), gain: audioParam() };
            gains.push(gain);
            return gain;
        },
        createOscillator() {
            const oscillator = {
                ...connectable(),
                frequency: audioParam(),
                starts: [],
                stops: [],
                start(time) { this.starts.push(time); },
                stop(time) { this.stops.push(time); },
                onended: null,
            };
            oscillators.push(oscillator);
            return oscillator;
        },
        createBiquadFilter() {
            const filter = {
                ...connectable(),
                frequency: audioParam(),
                Q: audioParam(),
            };
            filters.push(filter);
            return filter;
        },
    };
}

test('cinematic score schedules one quiet three-voice pad and stops it cleanly', () => {
    const ctx = fakeContext();
    const destination = { id: 'managed-master' };
    const score = scheduleCampaignCinematicScore(ctx, destination, {
        id: 'tower-construction',
        durationMs: 36_000,
    }, 3);

    assert.equal(score.oscillatorCount, 3);
    assert.equal(ctx.oscillators.length, 3);
    assert.equal(ctx.filters.length, 1);
    assert.equal(ctx.filters[0].connectedTo, destination);
    assert.ok(ctx.gains[0].gain.events.some(event => event[0] === 'ramp' && event[1] === 0.036));
    assert.ok(ctx.oscillators.every(oscillator => oscillator.starts[0] === 3));
    assert.ok(ctx.oscillators.every(oscillator => oscillator.stops[0] > 39));
    assert.ok(ctx.oscillators.every(oscillator => (
        oscillator.frequency.events.filter(event => event[0] === 'target').length === 3
    )));

    ctx.currentTime = 9;
    assert.equal(score.stop({ fadeSeconds: 0.5 }), true);
    assert.equal(score.stop(), false, 'the same score cannot leave a second stop schedule');
    assert.ok(ctx.gains[0].gain.events.some(event => event[0] === 'cancel' && event[1] === 9));
    assert.ok(ctx.oscillators.every(oscillator => oscillator.stops.at(-1) === 9.54));
});
