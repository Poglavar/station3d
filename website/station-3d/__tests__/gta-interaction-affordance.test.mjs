// Locks the shared desktop/mobile affordance used for nearby enterable cars.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
const controlsSource = await readFile(new URL('../ui/walk-controls.js', import.meta.url), 'utf8');
const hudSource = await readFile(new URL('../ui/hud.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../ui/shell.css', import.meta.url), 'utf8');

test('nearby enterable vehicle lights both E affordances and clears safely', () => {
    assert.match(cabSource, /gtaInteraction\?\.vehicleId/);
    assert.match(cabSource, /setGtaInteractionAvailable\(status\.gtaInteractionEnterable\s*[,)]/);
    assert.match(controlsSource, /classList\.toggle\('station-3d-gta-interact-ready', ready\)/);
    assert.match(controlsSource, /setGtaInteractionAvailable\(false\)/);
    assert.match(hudSource, /station-3d-status-interaction-ready/);
    assert.match(cssSource, /@keyframes station3d-interaction-ready-pulse/);
    assert.match(cssSource, /prefers-reduced-motion: reduce/);
});
