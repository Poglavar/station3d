import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FOOT_PURSUIT_DEFAULTS,
    advanceFootPursuit,
    createFootPursuitState,
    footPursuerPose,
    footPursuitTrailPoint,
} from '../core/foot-pursuit.js';

const STORY_WALK_MPS = 1.8;
const STORY_RUN_MPS = 5.4;

// Walks the player straight up +z at `speed`, facing forward, until `untilS`.
function simulate(state, { speedMps, seconds, dt = 0.1, from = null, onFoot = true, log = null }) {
    let player = from || { x: 0, y: 12, z: 0, headingRad: 0, onFoot, airborne: false };
    let t = 0;
    let last = null;
    while (t < seconds) {
        player = { ...player, z: player.z + speedMps * dt, onFoot };
        last = advanceFootPursuit(state, { dt, player });
        log?.(t, last, player);
        t += dt;
        if (last.caught) break;
    }
    return { player, result: last, t };
}

test('a walking player is caught by a group that appears behind them and marches at walking pace', () => {
    const state = createFootPursuitState({});
    let spawnedAt = null;
    const run = simulate(state, {
        speedMps: STORY_WALK_MPS,
        seconds: 90,
        log: (t, result) => { if (result.spawned && spawnedAt === null) spawnedAt = t; },
    });
    assert.ok(spawnedAt !== null, 'the group spawned');
    assert.ok(spawnedAt > 8 && spawnedAt < 10, `spawned once the trail was 16 m long (${spawnedAt.toFixed(1)} s)`);
    assert.equal(run.result.caught, true);
    assert.ok(run.t > 30 && run.t < 50, `caught after ${run.t.toFixed(1)} s of walking`);
    assert.equal(state.groups, 1);
});

test('a running player is never caught; the group gives up and a fresh one forms further on', () => {
    const state = createFootPursuitState({});
    let lostAt = null;
    let spawns = 0;
    const run = simulate(state, {
        speedMps: STORY_RUN_MPS,
        seconds: 60,
        log: (t, result) => {
            if (result.lost && lostAt === null) lostAt = t;
            if (result.spawned) spawns += 1;
        },
    });
    assert.equal(run.result.caught, false);
    assert.ok(lostAt !== null && lostAt < 35, `the first group was lost at ${lostAt} s`);
    assert.ok(spawns >= 2, `a second group formed (${spawns} spawns)`);
    assert.equal(state.caught, false);
});

test('standing still lets the group walk right up to the player', () => {
    const state = createFootPursuitState({});
    const walked = simulate(state, { speedMps: STORY_WALK_MPS, seconds: 12 });
    assert.ok(state.pursuers.length > 0);
    assert.equal(walked.result.caught, false);
    const standing = simulate(state, { speedMps: 0, seconds: 20, from: walked.player });
    assert.equal(standing.result.caught, true);
    assert.ok(standing.t < 12, `caught within ${standing.t.toFixed(1)} s of stopping`);
});

test('boarding a vehicle clears the trail and the group; nobody is caught in a car', () => {
    const state = createFootPursuitState({});
    const walked = simulate(state, { speedMps: STORY_WALK_MPS, seconds: 12 });
    assert.ok(state.pursuers.length > 0);
    const driven = simulate(state, { speedMps: 0.5, seconds: 30, from: walked.player, onFoot: false });
    assert.equal(driven.result.caught, false);
    assert.equal(state.pursuers.length, 0);
    assert.equal(state.trail.length, 0);
    // On foot again the trail starts fresh and needs its length back first.
    const again = simulate(state, { speedMps: STORY_WALK_MPS, seconds: 5, from: { ...driven.player, onFoot: true } });
    assert.equal(again.result.spawned, 0);
    assert.equal(state.pursuers.length, 0);
});

test('the group waits while its spawn point is in front of the player', () => {
    const state = createFootPursuitState({});
    // Walk 20 m up +z, then turn round to face the way back (-z).
    const walked = simulate(state, { speedMps: STORY_WALK_MPS, seconds: 10, from: { x: 0, y: 0, z: 0, headingRad: Math.PI, onFoot: true, airborne: false } });
    assert.ok(state.trailLengthM > 16);
    assert.equal(state.pursuers.length, 0, 'no spawn in view');
    const turned = advanceFootPursuit(state, { dt: 0.1, player: { ...walked.player, headingRad: 0 } });
    assert.equal(turned.spawned, FOOT_PURSUIT_DEFAULTS.count);
});

test('a teleport or a flight leaves no trail to follow', () => {
    const state = createFootPursuitState({});
    simulate(state, { speedMps: STORY_WALK_MPS, seconds: 12 });
    assert.ok(state.pursuers.length > 0);
    const jumped = advanceFootPursuit(state, { dt: 0.1, player: { x: 40, y: 12, z: 40, headingRad: 0, onFoot: true, airborne: false } });
    assert.equal(jumped.caught, false);
    assert.equal(state.pursuers.length, 0);
    assert.equal(state.trailLengthM, 0);
    // Airborne samples are not recorded at all.
    advanceFootPursuit(state, { dt: 0.1, player: { x: 40, y: 30, z: 45, headingRad: 0, onFoot: true, airborne: true } });
    assert.equal(state.trail.length, 1);
});

test('pursuer poses interpolate along the trail with alternating lanes and face along it', () => {
    const state = createFootPursuitState({ count: 2, spawnBehindM: 4, spacingM: 1 });
    simulate(state, { speedMps: STORY_WALK_MPS, seconds: 4 });
    assert.equal(state.pursuers.length, 2);
    const [lead, second] = state.pursuers;
    const leadPose = footPursuerPose(state, lead);
    const secondPose = footPursuerPose(state, second);
    assert.ok(leadPose.z > secondPose.z, 'the lead is further along +z');
    assert.ok(Math.abs(leadPose.headingRad) < 1e-6, 'facing +z');
    assert.ok(Math.abs(leadPose.x - secondPose.x) > 0.5, 'different lanes');
    const mid = footPursuitTrailPoint(state, state.trailLengthM / 2);
    assert.ok(Math.abs(mid.z - state.trailLengthM / 2) < 0.6);
    assert.equal(mid.y, 12);
});

test('the authored spec only overrides finite positive numbers', () => {
    const state = createFootPursuitState({ count: 20, speedMps: null, spawnBehindM: -3, catchRadiusM: 2 });
    assert.equal(state.options.count, 8);
    assert.equal(state.options.speedMps, FOOT_PURSUIT_DEFAULTS.speedMps);
    assert.equal(state.options.spawnBehindM, FOOT_PURSUIT_DEFAULTS.spawnBehindM);
    assert.equal(state.options.catchRadiusM, 2);
});

test('a stopped player is faced by a file of pursuers, not four men on one spot', () => {
    const state = createFootPursuitState({});
    const walked = simulate(state, { speedMps: STORY_WALK_MPS, seconds: 12 });
    simulate(state, { speedMps: 0, seconds: 30, from: walked.player });
    assert.equal(state.caught, true);
    const along = state.pursuers.map(p => p.s).sort((a, b) => b - a);
    for (let i = 1; i < along.length; i++) {
        assert.ok(along[i - 1] - along[i] >= FOOT_PURSUIT_DEFAULTS.spacingM - 1e-9, `pursuer ${i} keeps its distance`);
    }
});
