// `cabState.walkMode` holds the walk STATE OBJECT and stays truthy for a whole
// free-roam session — including while the player is driving a car. It answers
// "is this a walk-based session", not "is the player on foot". The weapon guard
// asked it as though it meant the latter, so in every GTA session the toggle
// bailed out, the header button rendered disabled, and the "Press (G) for guns"
// hint named a key that was being refused — including during the campaign chase,
// where campaign.md offers the vehicle weapon as the optional way through.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

test('the on-foot question has one definition, and it is not the session flag', () => {
    assert.match(source, /function isPlayerOnFoot\(cabState\) \{\s*\n\s*return !!cabState\?\.walkMode && !isDrivingGtaVehicle\(cabState\);/);
    assert.match(source, /const GTA_VEHICLE_CONTROLLER_IDS = new Set\(\['road', 'boat', 'aircraft'\]\);/);
    // The frame loop derives its own flag from the same set rather than a
    // second inline list that can drift.
    assert.match(source, /const gtaDriving = GTA_VEHICLE_CONTROLLER_IDS\.has\(activeControllerId\);/);
    // Camera profiles carry their own kinds that happen to share these names
    // (cab.js:3521); that is a different concept and may diverge. What must not
    // come back is a second inline list asked of a CONTROLLER id.
    assert.doesNotMatch(
        source,
        /\['road', 'boat', 'aircraft'\]\.includes\(\w*[Cc]ontrollerId\)/,
        'a second inline copy of the vehicle-controller list has appeared',
    );
});

test('the weapon toggle refuses only when the player is actually on foot', () => {
    // The pure policy asks the on-foot question (never the session flag) and
    // lets a campaign sidearm through; without one, on foot still refuses.
    assert.match(
        source,
        /const intent = weaponToggleIntent\(\{\s*onFoot: isPlayerOnFoot\(cabState\),\s*sidearmAvailable: cabState\.campaignSidearmAvailable === true,\s*weaponAttached: isWeaponAttached\(\),\s*underground: !!cabState\.isUndergroundSession,\s*\}\);\s*if \(!intent\) return;/,
    );
    // Scoped to toggleWeapon: the same shape is CORRECT in
    // enterWalkModeFromCab, which really is asking a session-level question.
    const toggle = source.slice(
        source.indexOf('function toggleWeapon()'),
        source.indexOf('function isGameMode()'),
    );
    assert.doesNotMatch(
        toggle,
        /cabState\.walkMode/,
        'toggleWeapon is asking the session flag again',
    );
});

test('the keyboard handler stops at the walker only when on foot', () => {
    // This branch ends with a bare `return`, so asking the session flag here
    // swallowed every key defined after it — g and v among them — for the whole
    // of a free-roam session, driving included. Keys the vehicle controller
    // wanted are consumed in the block above it.
    assert.match(source, /if \(isPlayerOnFoot\(cabState\)\) \{\s*\n\s*if \(k === 'c'\) \{/);
    // And the keys it used to swallow are still defined after it.
    const walkerBranch = source.indexOf("if (isPlayerOnFoot(cabState)) {\n            if (k === 'c') {");
    assert.ok(walkerBranch > -1);
    assert.ok(source.indexOf("if (k === 'g') {", walkerBranch) > walkerBranch);
});

test('walk and weapon buttons no longer share one enabled flag', () => {
    const sync = source.slice(
        source.indexOf('function syncHeaderActionButtons(cabState)'),
        source.indexOf('function getAllowedCameraModes'),
    );
    // "Start walk mode" stays spent for the session; the weapon comes back the
    // moment the player is riding something.
    assert.match(sync, /const enableWalk = showWalk && !cabState\.walkMode;/);
    // A campaign sidearm is the one thing that enables the weapon button on foot.
    assert.match(sync, /const enableWeapon = weaponToggleEnabled\(\{\s*showWalk,\s*onFoot: isPlayerOnFoot\(cabState\),\s*sidearmAvailable: cabState\?\.campaignSidearmAvailable === true,/);
    assert.match(sync, /setWalkModeButtonEnabled\(enableWalk\);/);
    assert.match(sync, /setWeaponToggleButtonEnabled\(enableWeapon\);/);
});

test('entering or leaving a vehicle re-syncs the header', () => {
    // Nothing else fires on that transition, so without this the button keeps
    // whatever state it had when the session opened.
    assert.match(source, /if \(headerSyncedOnFoot !== status\.walkMode\) \{\s*\n\s*headerSyncedOnFoot = status\.walkMode;/);
    // Stepping out of a vehicle stows the turret that belonged to it.
    assert.match(source, /if \(status\.walkMode && isWeaponAttached\(\)\) \{\s*\n\s*setCabGameMode\(cabState, 'simulation'\);/);
    // And a new session must not inherit the last one's answer.
    const openCab = source.slice(source.indexOf('export function openCab('));
    assert.match(openCab.slice(0, 3000), /headerSyncedOnFoot = null;/);
    const closeCab = source.slice(source.indexOf('export function closeCab()'));
    assert.match(closeCab.slice(0, 900), /headerSyncedOnFoot = null;/);
});

test('the gun hint only promises a key that will be accepted', () => {
    assert.match(
        source,
        /isGameMode\(\) && !isWeaponAttached\(\) && !isPlayerOnFoot\(cabState\),/,
    );
});
