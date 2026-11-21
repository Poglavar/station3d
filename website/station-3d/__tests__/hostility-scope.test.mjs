// The campaign chase arms the player by switching the cab into game mode, and
// game mode used to mean the whole free-roam hostile sandbox as well. Starting
// the chase therefore populated Zagreb with 42 machine-gun nests that took the
// required story car from 100 to 0 health in about sixteen seconds while it was
// standing still, failing the chapter. Authored pursuers must still fight; the
// world must not add hostiles of its own around them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ambientHostilesEnabled } from '../core/hostility-scope.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('free roam keeps its hostile sandbox', () => {
    assert.equal(ambientHostilesEnabled({ gameMode: 'game' }), true);
    assert.equal(ambientHostilesEnabled({
        gameMode: 'game',
        campaignEncounterActive: false,
    }), true);
});

test('an authored encounter holds the sandbox back', () => {
    assert.equal(ambientHostilesEnabled({
        gameMode: 'game',
        campaignEncounterActive: true,
    }), false);
});

test('peace mode stays peaceful either way', () => {
    for (const campaignEncounterActive of [false, true]) {
        assert.equal(ambientHostilesEnabled({
            gameMode: 'simulation',
            campaignEncounterActive,
        }), false);
    }
    assert.equal(ambientHostilesEnabled(), false);
    assert.equal(ambientHostilesEnabled({}), false);
});

// Everything below is invisible coupling: each layer reads a predicate handed
// to it once at beginSession, so a layer left on the old `isGameMode` would go
// on spawning hostiles through a campaign scene with nothing failing.
test('every ambient-hostile layer is wired to the scoped predicate', () => {
    for (const path of [
        '../world/machine-gun-nests.js',
        '../world/flags.js',
        '../vehicles/tram.js',
    ]) {
        const source = read(path);
        assert.match(source, /isAmbientHostileMode/, path);
        assert.doesNotMatch(
            source,
            /\bisGameMode\b/,
            `${path} still reads plain game mode`,
        );
    }
});

test('cars keep authored pursuers fighting while refusing to invent new ones', () => {
    const source = read('../world/cars.js');
    // Behaviour of enemies already in the world — including the campaign's own
    // spawned wave — stays on game mode.
    assert.match(source, /function updateEnemyVehicles\(dt\) \{\n\s*if \(!isGameModeFn\(\)\) return;/);
    assert.match(source, /export function spawnEnemyWaveNear[\s\S]*?if \(!isGameModeFn \|\| !isGameModeFn\(\)\) return finish\(0, 'game-mode-inactive'\);/);
    // Random spawning is what the encounter suppresses.
    assert.match(source, /const spawnAmbientEnemies = ambientHostilesFn\(\);/);
    assert.match(source, /const isEnemy = spawnAmbientEnemies &&/);
});

test('the cab supplies the scoped predicate and claims the encounter first', () => {
    const source = read('../modes/cab.js');
    assert.match(source, /isAmbientHostileMode: \(\) => state\.cabState === cabState/);
    assert.match(source, /ambientHostilesEnabled\(\{\s*gameMode: cabState\.gameMode,\s*campaignEncounterActive: !!cabState\.campaignEncounterId,\s*campaignSession: !!cabState\.campaignScene,\s*\}\)/);

    // Ordering is load-bearing: a frame of game mode before the encounter is
    // claimed is a frame in which the world may seed nests and enemy cars.
    const encounter = source.slice(source.indexOf('export async function startCabCampaignEncounter'));
    const claim = encounter.indexOf('cabState.campaignEncounterId =');
    const arm = encounter.indexOf("setCabGameMode(cabState, 'game')");
    assert.ok(claim > -1 && arm > -1);
    assert.ok(claim < arm, 'the encounter must be claimed before game mode is armed');
});
