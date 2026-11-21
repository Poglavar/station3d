// Verifies that the chapter cue schedules a bounded three-note chime through
// the destination supplied by the app-level audio manager.

import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleCampaignChapterChime } from '../ui/campaign-transition-sfx.js';

function audioParam() {
    return {
        events: [],
        setValueAtTime(value, time) { this.events.push(['set', value, time]); },
        exponentialRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); },
    };
}

function fakeContext() {
    const oscillators = [];
    const gains = [];
    return {
        currentTime: 4,
        oscillators,
        gains,
        createOscillator() {
            const oscillator = {
                frequency: audioParam(),
                connectedTo: null,
                starts: [],
                stops: [],
                connect(target) { this.connectedTo = target; return target; },
                start(time) { this.starts.push(time); },
                stop(time) { this.stops.push(time); },
            };
            oscillators.push(oscillator);
            return oscillator;
        },
        createGain() {
            const gain = {
                gain: audioParam(),
                connectedTo: null,
                connect(target) { this.connectedTo = target; return target; },
            };
            gains.push(gain);
            return gain;
        },
    };
}

test('chapter transition chime schedules three rising notes on the managed destination', () => {
    const ctx = fakeContext();
    const destination = { id: 'master-output' };

    assert.equal(scheduleCampaignChapterChime(ctx, destination, 4), 3);
    assert.equal(ctx.oscillators.length, 3);
    assert.deepEqual(
        ctx.oscillators.map(oscillator => oscillator.frequency.events[0][1]),
        [392, 523.25, 659.25],
    );
    assert.ok(ctx.oscillators.every(oscillator => oscillator.starts.length === 1));
    assert.ok(ctx.oscillators.every(oscillator => oscillator.stops[0] > oscillator.starts[0]));
    assert.ok(ctx.gains.every(gain => gain.connectedTo === destination));
});
