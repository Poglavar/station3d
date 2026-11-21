// Guards the `outside: true` flags on cab.js's layer table. Getting these wrong is
// invisible in code review and catastrophic in the sim: flag the tunnel itself and
// the tube stops being built around you mid-ride; forget to flag a heavy surface
// layer and the suspension quietly saves nothing.
//
// cab.js cannot be imported headless (THREE, DOM), so this reads the table as text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cabSource = await readFile(resolve(here, '../modes/cab.js'), 'utf8');

// Every `{ name: 'x', … }` entry in the surface layer table, with its flags.
function layerEntries() {
    const entries = new Map();
    const re = /\{\s*name:\s*'([a-zA-Z]+)'\s*,\s*layer:[^}]*\}/g;
    let match;
    while ((match = re.exec(cabSource)) !== null) {
        entries.set(match[1], /outside:\s*true/.test(match[0]));
    }
    return entries;
}

// Things you can see from inside a sealed tube. Suspending any of these would
// stop the world you are actually looking at.
const VISIBLE_INSIDE_TUNNEL = [
    'plannerElevation',    // the tunnel itself
    'rails',
    'terrain',             // the tube is seated on its reference
    'undergroundStations',
    'platforms',
    'ambientTrains',       // other trains share the tunnel
    'otherTrams',
    'proposals',
    'photoreal',
];

// The expensive surface work the suspension exists to stop.
const MUST_BE_SUSPENDED = [
    'roads', 'curbs', 'laneMarkings', 'buildings', 'farBuildings', 'decor',
    'cars', 'streetLamps', 'pedestrians', 'streetNames',
];

test('nothing visible from inside a tunnel is flagged outside', () => {
    const entries = layerEntries();
    assert.ok(entries.size > 15, `only parsed ${entries.size} layer entries — did the table change shape?`);
    for (const name of VISIBLE_INSIDE_TUNNEL) {
        assert.ok(entries.has(name), `layer '${name}' is gone from the table — update this test`);
        assert.equal(entries.get(name), false, `'${name}' is visible in a tunnel and must not be suspended`);
    }
});

test('the heavy surface layers are all flagged outside', () => {
    const entries = layerEntries();
    for (const name of MUST_BE_SUSPENDED) {
        assert.ok(entries.has(name), `layer '${name}' is gone from the table — update this test`);
        assert.equal(entries.get(name), true, `'${name}' streams surface content and should be suspended`);
    }
});

test('the frame loop actually honours the flag', () => {
    // A flag nobody reads is decoration.
    assert.match(cabSource, /outsideSuspended\s*&&\s*entry\.outside/);
});
