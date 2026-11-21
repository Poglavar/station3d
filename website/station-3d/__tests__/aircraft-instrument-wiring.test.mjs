// Locks the seam that makes the aircraft instruments correct rather than merely
// present. Every assertion here corresponds to a defect seen in the live world
// on 2026-09-07: an altimeter stuck on the terrain below, "km 0+000 · 0.0%"
// hanging over an airfield, and a car badge on the aircraft.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { finiteOrNull } from '../core/math.js';

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
const gtaSource = await readFile(new URL('../modes/gta.js', import.meta.url), 'utf8');
const hudSource = await readFile(new URL('../ui/hud.js', import.meta.url), 'utf8');
const modalSource = await readFile(new URL('../ui/modal.js', import.meta.url), 'utf8');

test('a GTA vehicle never takes its ground or chainage from the rail formation', () => {
    assert.match(cabSource, /const railFormationAtPose = !cabState\.walkMode && !gtaDriving/);
    assert.match(cabSource, /if \(cabState\.walkMode \|\| gtaDriving\) \{/);
});

test('the altimeter reads the vehicle\'s own scene Y, not the ground under it', () => {
    assert.match(cabSource, /const readoutSceneY = gtaDriving\s*\n\s*\? \(finiteOrNull\(pose\.y\) \?\? vehicleGroundY\)\s*\n\s*: poseY;/);
    assert.match(cabSource, /: readoutSceneY\)/);
});

test('cab publishes aircraft instruments only for the aircraft controller', () => {
    assert.match(cabSource, /if \(activeControllerId === 'aircraft' && gtaPose\) \{/);
    assert.match(cabSource, /status\.aircraft = aircraftInstruments\(\{/);
    assert.match(cabSource, /groundSceneY: finiteOrNull\(gtaPose\.groundY\) \?\? vehicleGroundY/);
});

test('the aircraft ground reading comes from the solver\'s own lookup', () => {
    assert.match(gtaSource, /const groundY = specialVehicles\?\.groundYAt\?\.\(pose\.x, pose\.z\)/);
    assert.match(gtaSource, /groundY: Number\.isFinite\(groundY\) \? groundY : null/);
});

test('the HUD prints the aircraft gauges and names the vehicle it is in', () => {
    assert.match(hudSource, /formatAircraftInstruments\(status\.aircraft\)/);
    assert.match(hudSource, /aircraft\.agl, aircraft\.vertical, aircraft\.throttle/);
    assert.match(hudSource, /status\.vehicleKind === 'aircraft' \? '✈️'/);
    assert.match(cabSource, /vehicleKind: kind,/);
});

test('the controls hint is a permanent button, not only an entry toast', () => {
    assert.match(modalSource, /export function setControlsHintHandler/);
    assert.match(modalSource, /export function setControlsHintButtonVisible/);
    assert.match(modalSource, /ensureControlsHintButton\(\);/);
    // A campaign keeps the control list in its objective line, so the header
// icon is gated on there being no campaign scene.
    assert.match(cabSource, /setControlsHintButtonVisible\(controlsHintAvailable && !cabState\.campaignScene\)/);
    assert.match(cabSource, /controlsHintKeyFor\(\s*cabState\.controllerRouter\?\.activeId \|\| 'foot',\s*\{ railDoors: !cabState\.ambientTramClaim,\s*train: cabState\.ambientTramClaim\?\.kind === 'train', enterable: hasEnterableVehicleCapability\(cabState\.sessionCapabilities\) \}/);
});


test('walking on an upper deck reads the walker altitude while a piloted aircraft retains its own height', () => {
    const start = cabSource.indexOf('const readoutSceneY = gtaDriving');
    const body = cabSource.slice(start, cabSource.indexOf('altitudeAbsolute = false;', start));
    const readAltitude = new Function('cabState', 'pose', 'gtaDriving', 'poseY', 'vehicleGroundY', 'finiteOrNull',
        `let altitudeM; ${body} return altitudeM;`);
    const cab = { walkMode: {}, terrain: { anchorHeightM: 113.3 }, trackBaseY: 0 };
    assert.ok(Math.abs(readAltitude(cab, { y: 185.6 }, false, 185.6, 0.6, finiteOrNull) - 298.9) < 1e-9);
    assert.ok(Math.abs(readAltitude(cab, { y: 2000 }, true, 100, 0.6, finiteOrNull) - 2113.3) < 1e-9);
});
