import assert from 'node:assert/strict';
import test from 'node:test';

import { stepCampaignActorGuide } from '../core/campaign-actor-guide.js';

test('a nearby player makes the guide lead toward the route, not follow the player', () => {
    const next = stepCampaignActorGuide({
        actorX: 0,
        actorZ: 0,
        targetX: 20,
        targetZ: 0,
        playerX: -4,
        playerZ: 0,
        dt: 1,
    });
    assert.equal(next.leading, true);
    assert.equal(next.walking, true);
    assert.ok(next.x > 0, 'the guide must move east toward the route target');
    assert.equal(next.z, 0);
});

test('a paused dialogue keeps the guide facing the player until play resumes', () => {
    const paused = stepCampaignActorGuide({
        actorX: 0,
        actorZ: 0,
        targetX: 20,
        targetZ: 0,
        playerX: -4,
        playerZ: 0,
        dt: 0,
    });
    assert.equal(paused.leading, false);
    assert.equal(paused.walking, false);
    assert.equal(paused.x, 0);
    assert.equal(paused.heading, -Math.PI / 2);

    const resumed = stepCampaignActorGuide({
        actorX: paused.x,
        actorZ: paused.z,
        targetX: 20,
        targetZ: 0,
        playerX: -4,
        playerZ: 0,
        dt: 1,
        leading: paused.leading,
    });
    assert.equal(resumed.leading, true);
    assert.ok(resumed.x > paused.x);
});

test('the guide waits for a lagging player and resumes once they catch up', () => {
    const waiting = stepCampaignActorGuide({
        actorX: 5,
        actorZ: 0,
        targetX: 20,
        targetZ: 0,
        playerX: -20,
        playerZ: 0,
        dt: 1,
        leading: true,
    });
    assert.equal(waiting.leading, false);
    assert.equal(waiting.walking, false);
    assert.equal(waiting.x, 5);

    const resumed = stepCampaignActorGuide({
        actorX: waiting.x,
        actorZ: waiting.z,
        targetX: 20,
        targetZ: 0,
        playerX: 1,
        playerZ: 0,
        dt: 1,
        leading: waiting.leading,
    });
    assert.equal(resumed.leading, true);
    assert.ok(resumed.x > waiting.x);
});

test('the guide stops at the authored waypoint instead of overshooting it', () => {
    const next = stepCampaignActorGuide({
        actorX: 0,
        actorZ: 0,
        targetX: 1,
        targetZ: 0,
        playerX: 0,
        playerZ: 0,
        dt: 10,
        stopDistanceM: 0.2,
    });
    assert.ok(Math.abs(next.x - 0.8) < 1e-9);
    assert.equal(next.arrived, true);
});

// The player walks 1.8 m/s in a story scene. A guide slower than that is
// overtaken in the first few metres and trails for the rest of the tunnel,
// which is what made her look like she teleported at every scene change.
test('the guide outpaces a walking player and lengthens her stride when the player is on her heels', () => {
    const base = {
        actorX: 0, actorZ: 0, targetX: 40, targetZ: 0, playerZ: 0, dt: 1, leading: true,
    };
    const ahead = stepCampaignActorGuide({ ...base, playerX: -12 });
    assert.ok(ahead.walking);
    assert.ok(ahead.x >= 1.9, `cruising pace ${ahead.x} m/s beats a 1.8 m/s walk`);

    // Player right behind her: she hurries so the gap she leads by survives.
    const hurried = stepCampaignActorGuide({ ...base, playerX: -2 });
    assert.ok(hurried.x > ahead.x, `hurry ${hurried.x} > cruise ${ahead.x}`);
    assert.ok(hurried.x <= 2.6 + 1e-9);

    // Over ten seconds of the player pushing, she keeps her lead rather than
    // being overtaken, which is the whole point of "follow me".
    let actorX = 0;
    let playerX = 0;
    for (let i = 0; i < 10; i += 1) {
        const step = stepCampaignActorGuide({ ...base, actorX, playerX, dt: 0.5 });
        actorX = step.x;
        playerX = Math.min(actorX, playerX + 1.8 * 0.5);
    }
    assert.ok(actorX - playerX > 1, `guide keeps a ${(actorX - playerX).toFixed(1)} m lead`);

    // She still stops short of the target and waits when the player falls far behind.
    const waited = stepCampaignActorGuide({ ...base, playerX: -30, leading: true });
    assert.equal(waited.walking, false);
    assert.equal(waited.leading, false);
});
