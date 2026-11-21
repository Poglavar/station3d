// The permanent controls button must name the CURRENT controller's hint. A
// player who claimed an aircraft and pressed it used to be told about the car.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { controlsHintAvailableFor, controlsHintKeyFor } from '../core/controls-hint.js';

// i18n.js keeps its dictionary private, so — as the campaign UI tests do — the
// coverage check reads the source and counts one definition per language.
const i18nSource = readFileSync(
    fileURLToPath(new URL('../core/i18n.js', import.meta.url)),
    'utf8',
);

function definitionCount(key) {
    return (i18nSource.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
}

test('each controller recalls its own hint', () => {
    assert.equal(controlsHintKeyFor('aircraft'), 'gta.enteredAirplane');
    assert.equal(controlsHintKeyFor('boat'), 'gta.enteredBoat');
    assert.equal(controlsHintKeyFor('road'), 'gta.enteredCar');
    assert.equal(controlsHintKeyFor('rail'), 'gta.tramEntered');
    assert.equal(controlsHintKeyFor('foot'), 'gta.controlsHint');
});

test('an unknown or absent controller falls back to the on-foot hint', () => {
    assert.equal(controlsHintKeyFor(''), 'gta.controlsHint');
    assert.equal(controlsHintKeyFor(null), 'gta.controlsHint');
    assert.equal(controlsHintKeyFor('jetpack'), 'gta.controlsHint');
});

test('the button is available while driving and walking', () => {
    assert.equal(controlsHintAvailableFor('gta'), true);
    assert.equal(controlsHintAvailableFor('GTA'), true);
    assert.equal(controlsHintAvailableFor('walk'), true);
    assert.equal(controlsHintAvailableFor(null), false);
});

test('every hint the button can show is translated in both languages', () => {
    const keys = ['aircraft', 'boat', 'road', 'rail', 'foot'].map(controlsHintKeyFor);
    for (const key of [...keys, 'gta.controlsButton', 'walk.controlsHint', 'rail.controlsHint']) {
        assert.equal(definitionCount(key), 2, `${key} needs an en and an hr string`);
    }
});

test('rail doors and ambient tram exits name their actual E action', () => {
    assert.equal(controlsHintKeyFor('rail', { railDoors: true }), 'rail.controlsHint');
    assert.equal(controlsHintKeyFor('rail', { railDoors: false }), 'gta.tramEntered');
    assert.equal(controlsHintKeyFor('foot', { enterable: false }), 'walk.controlsHint');
});


test('controller hint is present before the pose snapshot reaches the campaign HUD', async () => {
    const { readFile } = await import('node:fs/promises');
    const cab = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
    const frame = cab.slice(cab.indexOf('function cabStep()'));
    const hint = frame.indexOf('status.controlsHintKey = controlsHintKeyFor(');
    const publish = frame.indexOf('cabState.lastRenderedPose = snapshotCabPose(pose)');
    assert.ok(hint > 0 && hint < publish, 'the published snapshot must contain the current action hint');
});

test('generic boat coaching is silenced inside a campaign, actionable prompts survive', async () => {
    const { vehicleInteractionKeyForSession } = await import('../core/controls-hint.js');
    const campaignBoat = { inCampaign: true, vehicleKind: 'boat' };
    assert.equal(vehicleInteractionKeyForSession('gta.boatMoveCloserPrompt', campaignBoat), '');
    assert.equal(vehicleInteractionKeyForSession('gta.stopToExitPrompt', campaignBoat), '');
    assert.equal(vehicleInteractionKeyForSession('gta.boatExitPrompt', campaignBoat), 'gta.boatExitPrompt', 'an exit that exists is shown');
    assert.equal(vehicleInteractionKeyForSession('gta.boatBerthPrompt', campaignBoat), 'gta.boatBerthPrompt', 'the authored berth is shown');
    assert.equal(vehicleInteractionKeyForSession('gta.boatMoveCloserPrompt', { inCampaign: false, vehicleKind: 'boat' }), 'gta.boatMoveCloserPrompt', 'free roam keeps its coaching');
    assert.equal(vehicleInteractionKeyForSession('gta.stopToExitPrompt', { inCampaign: true, vehicleKind: 'road' }), 'gta.stopToExitPrompt', 'a car keeps its stop hint');
    assert.equal(vehicleInteractionKeyForSession('', campaignBoat), '');
});

test('a flagged-down train shows the train cab hint, while doors still win for a scheduled train', () => {
    assert.equal(controlsHintKeyFor('rail', { railDoors: false, train: true }), 'gta.trainEntered');
    assert.equal(controlsHintKeyFor('rail', { railDoors: false, train: false }), 'gta.tramEntered');
    assert.equal(controlsHintKeyFor('rail', { railDoors: true, train: true }), 'rail.controlsHint');
    assert.equal(controlsHintKeyFor('foot', { train: true }), 'gta.controlsHint');
});
