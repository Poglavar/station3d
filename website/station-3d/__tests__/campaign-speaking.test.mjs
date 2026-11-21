// Locks the speaking contract between the dialogue UI and the actor layer.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_SPEAKING_S,
    campaignPresentationDeltaSeconds,
    speakingEventDetail,
    speakingSeconds,
} from '../core/campaign-speaking.js';

test('a text-only beat is mouthed for a length-based, bounded time', () => {
    assert.equal(speakingSeconds(''), 0);
    assert.equal(speakingSeconds(null), 0);
    assert.equal(speakingSeconds('Da.'), 1.5);
    assert.equal(speakingSeconds('x'.repeat(140)), 10);
    assert.equal(speakingSeconds('x'.repeat(1000)), 12);
});

test('actor presentation keeps moving while campaign simulation is paused', () => {
    assert.equal(campaignPresentationDeltaSeconds({
        simulationDt: 0.016,
        nowMs: 500,
        previousNowMs: 100,
    }), 0.016);
    assert.equal(campaignPresentationDeltaSeconds({
        simulationDt: 0,
        nowMs: 116,
        previousNowMs: 100,
    }), 0.016);
    assert.equal(campaignPresentationDeltaSeconds({
        simulationDt: 0,
        nowMs: 5000,
        previousNowMs: 100,
    }), 0.05);
    assert.equal(campaignPresentationDeltaSeconds({ simulationDt: 0, nowMs: 100 }), 0);
});

test('the event detail names an actor and bounds the duration', () => {
    assert.equal(speakingEventDetail({ actorId: '', seconds: 3 }), null);
    assert.equal(speakingEventDetail({ seconds: 3 }), null);
    assert.deepEqual(
        speakingEventDetail({ actorId: 'vis-fisherman', seconds: 99, mood: 'stern' }),
        { actorId: 'vis-fisherman', seconds: MAX_SPEAKING_S, mood: 'stern' },
    );
    assert.deepEqual(
        speakingEventDetail({ actorId: 'vis-fisherman', seconds: NaN }),
        { actorId: 'vis-fisherman', seconds: 0, mood: null },
    );
});
