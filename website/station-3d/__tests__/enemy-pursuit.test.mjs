// The Zagreb chase spawned four armed cars and then let them drive away as
// ordinary traffic: the player walked the whole 1.5 km escape route unmolested
// and the encounter cars were retired without ever engaging. A pursuer has to
// choose the exit that closes on the player.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { choosePursuitExit, pursuitTopUp } from '../core/enemy-pursuit.js';

test('a pursuer takes the junction exit that closes on the target', () => {
    const target = { x: 100, z: 0 };
    const exits = [
        { id: 'away', x: -80, z: 0 },
        { id: 'toward', x: 60, z: 0 },
        { id: 'sideways', x: 0, z: 70 },
    ];
    assert.equal(choosePursuitExit(exits, target).id, 'toward');
    // Behind the player is still the closing choice when it is the only one.
    assert.equal(choosePursuitExit([{ id: 'only', x: -5, z: -5 }], target).id, 'only');
});

test('the spread lets a wave fan out across streets that all close on the target', () => {
    const target = { x: 0, z: 0 };
    // Two near-equal approaches and one clearly worse.
    const exits = [
        { id: 'a', x: 50, z: 0 },
        { id: 'b', x: 0, z: 55 },
        { id: 'far', x: 400, z: 400 },
    ];
    const picks = new Set();
    for (let i = 0; i < 40; i += 1) {
        picks.add(choosePursuitExit(exits, target, { spread: 45, random: () => i / 40 }).id);
    }
    assert.deepEqual([...picks].sort(), ['a', 'b'], 'never the far exit, but both close ones');
    // With no spread the choice is deterministic.
    assert.equal(choosePursuitExit(exits, target, { spread: 0 }).id, 'a');
});

test('a pursuer with nothing to aim at falls back to ordinary traffic', () => {
    assert.equal(choosePursuitExit([{ id: 'a', x: 1, z: 1 }], null), null);
    assert.equal(choosePursuitExit([{ id: 'a', x: 1, z: 1 }], { x: NaN, z: 0 }), null);
    assert.equal(choosePursuitExit([], { x: 0, z: 0 }), null);
    assert.equal(choosePursuitExit([{ id: 'a', x: NaN, z: 1 }], { x: 0, z: 0 }), null);
});

test('only an authored encounter\'s cars hunt, and they hunt through the road graph', () => {
    const cars = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8');
    // Free-roam hostiles must keep their ambient wander.
    assert.match(cars, /car\.enemy && car\.encounterId \? getPlayerTramTarget\(\) : null/);
    // The choice runs at the junction, on the same outgoing candidates traffic uses.
    assert.match(cars, /choosePursuitExit\(exits, pursuitTarget/);
});

test('an authored wave regroups back to strength instead of dissolving', () => {
    // At strength: nothing to do.
    assert.equal(pursuitTopUp({ desired: 4, live: 4, nowS: 100 }), 0);
    assert.equal(pursuitTopUp({ desired: 4, live: 9, nowS: 100 }), 0);
    // Losses are replaced, but never the whole wave at once.
    assert.equal(pursuitTopUp({ desired: 4, live: 3, nowS: 100 }), 1);
    assert.equal(pursuitTopUp({ desired: 4, live: 0, nowS: 100 }), 2);
    // A replacement wave waits, so losses read as regrouping rather than cars
    // blinking into existence beside the player.
    assert.equal(pursuitTopUp({ desired: 4, live: 1, nowS: 102, lastSpawnS: 100 }), 0);
    assert.equal(pursuitTopUp({ desired: 4, live: 1, nowS: 107, lastSpawnS: 100 }), 2);
});

test('no authored encounter means no reinforcement at all', () => {
    assert.equal(pursuitTopUp({ desired: 0, live: 0, nowS: 100 }), 0);
    assert.equal(pursuitTopUp({ desired: 4, live: 0, nowS: NaN }), 0);
    assert.equal(pursuitTopUp(), 0);
});

test('the chase is declared when it starts and withdrawn when it stops', () => {
    const cars = readFileSync(new URL('../world/cars.js', import.meta.url), 'utf8');
    const cab = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');
    // Only a declared encounter hunts and reinforces.
    assert.match(cars, /let activePursuit = null;/);
    assert.match(cars, /export function beginEncounterPursuit/);
    assert.match(cars, /export function endEncounterPursuit/);
    // Reinforcement runs after the cull, which is what was emptying the street.
    assert.match(cars, /for \(const c of survivors\) globalCars\.push\(c\);[\s\S]{0,700}pursuitTopUp\(/);
    // Started with the encounter, and withdrawn before its id is cleared so the
    // wave cannot keep topping itself up into free roam.
    assert.match(cab, /beginEncounterPursuit\(\{ encounterId: cabState\.campaignEncounterId/);
    assert.match(cab, /endEncounterPursuit\(\);\s*\n\s*stopCampaignEnemyEncounter/);
});
