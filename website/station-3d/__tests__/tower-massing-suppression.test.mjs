// Custom landmarks are ordinary backend-resolved building meshes. These source checks keep
// the production renderer from regaining a tower-spec dependency for precedence decisions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('detailed and far building streams do not fetch tower recipes', () => {
    for (const path of ['../world/buildings.js', '../world/buildings-far.js']) {
        const source = read(path);
        assert.doesNotMatch(source, /tower-spec|ensureTowerSpecData|isTowerPart/,
            `${path} must accept the backend's winning source without tower metadata`);
    }
});

test('the renderer fetches only lightweight survey-material overrides', () => {
    const buildings = read('../world/buildings.js');
    const overrides = read('../world/massing-overrides.js');
    assert.match(buildings, /ensureMassingOverrideData\(\)/);
    assert.match(overrides, /buildings\/massing-overrides/);
    assert.doesNotMatch(overrides, /buildings\/towers/);
});

test('the local blocklist no longer contains custom-model precedence', () => {
    const source = read('../world/buildings.js');
    const predicate = source.slice(
        source.indexOf('export function isBlockedBuildingObjectId'),
        source.indexOf('\n}', source.indexOf('export function isBlockedBuildingObjectId')) + 2,
    );
    assert.doesNotMatch(predicate, /isTowerPart|tower-spec|ensureTowerSpecData/);
    assert.match(predicate, /isStaticallyBlockedBuildingObjectId/,
        'source defects remain an explicit, shared renderer concern');
});
