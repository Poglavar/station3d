// Locks the Grič lever and stone-panel reveal to one bounded deterministic
// presentation clock rather than an untestable timer or frame count.

import assert from 'node:assert/strict';
import test from 'node:test';

import { stepCampaignSecretDoor } from '../core/campaign-secret-door.js';

test('the lever moves before the concealed panel finishes sliding', () => {
    const state = stepCampaignSecretDoor({ elapsed: 0, duration: 1.65 }, 0.1);
    assert.ok(state.leverProgress > state.doorProgress);
    assert.equal(state.complete, false);
});

test('the secret-door clock clamps long frames and lands on one canonical open state', () => {
    let state = { elapsed: 0, duration: 0.3 };
    state = stepCampaignSecretDoor(state, 3);
    assert.equal(state.elapsed, 0.1, 'one stalled frame cannot skip the reveal');
    state = stepCampaignSecretDoor(state, 0.1);
    state = stepCampaignSecretDoor(state, 0.1);
    assert.equal(state.doorProgress, 1);
    assert.equal(state.leverProgress, 1);
    assert.equal(state.complete, true);
});
