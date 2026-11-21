import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

function functionBody(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next < 0 ? source.length : next);
}

test('cab-to-walk handoff preserves the published world generation', () => {
    const entry = functionBody('enterWalkModeFromCab');
    const transition = functionBody('transitionRailCabToWalk');

    assert.match(entry, /transitionRailCabToWalk\(cabState/);
    assert.doesNotMatch(entry, /openWalk\(/,
        'walking away from a train must not restart Station3D');
    assert.match(transition, /controllerRouter\?\.activate\('foot'/);
    assert.match(transition, /cabState\.layerCtx\.sessionCapabilities = walkPreset\.capabilities/);
    assert.match(transition, /void enterFreeRoam\(\)\.catch/,
        'the retained world must become full free roam with enterable vehicles and pedestrians');
    assert.doesNotMatch(transition, /beginWorldBuild|startSessionLayers|closeCab\(/,
        'the controller handoff must retain rail, terrain and tunnel publications');
});
