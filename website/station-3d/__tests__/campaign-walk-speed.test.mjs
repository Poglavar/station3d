// Walk mode is a survey camera at 25 m/s, which is the wrong instrument for an
// authored scene: a 2.5 s keypress at the Vis spawn covered 62 m, passed
// through the harbour zone and completed "walk to the harbour" before the
// player had spoken to the handler. Campaign scenes get a person's pace, and
// free roam must get its survey speed back the moment the session closes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    FREE_ROAM_WALK_SPEED_MPS,
    STORY_WALK_SPEED_MPS,
    clearWalkKeys,
    createWalkState,
    getWalkSpeed,
    onKeyDown,
    onKeyUp,
    isWalkSpeedBoostOn,
    setWalkSpeed,
    setWalkSpeedBoost,
    stepWalk,
    walkStepSpeedMps,
} from '../modes/walk.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// Metres of horizontal travel over one second of held forward input.
function metresPerSecond() {
    const state = createWalkState(45.8, 15.98, { initialGroundY: 0 });
    let travelled = 0;
    for (let step = 0; step < 20; step += 1) {
        travelled += stepWalk(state, 0.05, 0, () => 0, () => ({ x: 0, z: 0 })).horizontalDistM;
    }
    return travelled;
}

test('a story pace is a person walking, not a survey flight', () => {
    assert.ok(STORY_WALK_SPEED_MPS > 1 && STORY_WALK_SPEED_MPS < 3,
        `${STORY_WALK_SPEED_MPS} m/s is not a walking pace`);
    assert.equal(FREE_ROAM_WALK_SPEED_MPS, 25);
    // At the story pace a 6 m interaction radius takes over three seconds to
    // cross; at the free-roam speed it is gone inside a quarter of a second.
    assert.ok(6 / STORY_WALK_SPEED_MPS > 3);
});

test('the base speed drives the actual step', () => {
    clearWalkKeys();
    setWalkSpeedBoost(false);
    onKeyDown('w');
    try {
        setWalkSpeed(STORY_WALK_SPEED_MPS);
        const story = metresPerSecond();
        assert.ok(Math.abs(story - STORY_WALK_SPEED_MPS) < 0.05, `walked ${story} m`);

        setWalkSpeed(FREE_ROAM_WALK_SPEED_MPS);
        const survey = metresPerSecond();
        assert.ok(Math.abs(survey - FREE_ROAM_WALK_SPEED_MPS) < 0.5, `walked ${survey} m`);
    } finally {
        clearWalkKeys();
        setWalkSpeed(FREE_ROAM_WALK_SPEED_MPS);
    }
});

test('boost still multiplies whatever pace is set, and junk resets to free roam', () => {
    assert.equal(walkStepSpeedMps(STORY_WALK_SPEED_MPS, false), STORY_WALK_SPEED_MPS);
    assert.equal(walkStepSpeedMps(STORY_WALK_SPEED_MPS, true), STORY_WALK_SPEED_MPS * 3);
    for (const bad of [0, -4, Number.NaN, null, undefined, 'fast']) {
        setWalkSpeed(bad);
        assert.equal(getWalkSpeed(), FREE_ROAM_WALK_SPEED_MPS, String(bad));
    }
    assert.equal(walkStepSpeedMps(Number.NaN, false), FREE_ROAM_WALK_SPEED_MPS);
});

// The coupling below is invisible: walk speed is module state, so a campaign
// that forgot to release it would leave every later free-roam session crawling
// and nothing would fail.
test('cab sessions apply the story pace and closeCab releases it', () => {
    const source = read('../modes/cab.js');
    assert.match(source, /function syncWalkSpeedForCampaign\(cabState\) \{/);
    assert.match(
        source,
        /setWalkSpeed\(cabState\?\.campaignScene \? STORY_WALK_SPEED_MPS : FREE_ROAM_WALK_SPEED_MPS\)/,
    );
    // Fresh sessions AND the two in-place campaign transitions, which build a
    // new scene on a world the previous scene already streamed.
    const applications = source.match(/syncWalkSpeedForCampaign\(cabState\);/g) || [];
    assert.ok(applications.length >= 3,
        `every session that claims a campaign scene must apply the pace, found ${applications.length}`);
    // The fresh-session one has to run before the state goes live, or the first
    // frames of a story scene are walked at survey speed.
    const openCab = source.slice(source.indexOf('export function openCab('));
    const applied = openCab.indexOf('syncWalkSpeedForCampaign(cabState);');
    const live = openCab.indexOf('setCabState(cabState);');
    assert.ok(applied > -1 && live > -1 && applied < live,
        'openCab must set the pace before the session goes live');
    const closeCab = source.slice(source.indexOf('export function closeCab()'));
    assert.match(closeCab.slice(0, 800), /setWalkSpeed\(FREE_ROAM_WALK_SPEED_MPS\)/);
});

test('holding Shift boosts real walking, releases normally and clears on blur', () => {
    clearWalkKeys(); setWalkSpeedBoost(false); setWalkSpeed(STORY_WALK_SPEED_MPS);
    try {
        onKeyDown('w'); onKeyDown('shift');
        assert.ok(Math.abs(metresPerSecond() - STORY_WALK_SPEED_MPS * 3) < .1);
        onKeyUp('shift');
        assert.ok(Math.abs(metresPerSecond() - STORY_WALK_SPEED_MPS) < .05);
        onKeyDown('shift'); clearWalkKeys();
        assert.equal(isWalkSpeedBoostOn(), false);
        setWalkSpeedBoost(true); onKeyDown('shift'); onKeyUp('shift');
        assert.equal(isWalkSpeedBoostOn(), true, 'the touch toggle survives releasing Shift');
    } finally { clearWalkKeys(); setWalkSpeedBoost(false); setWalkSpeed(FREE_ROAM_WALK_SPEED_MPS); }
});
