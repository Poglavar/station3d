// Verifies generic scenario discovery and the localhost-only deep-link guard.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveScenarioWorldSearch,
    scenarioCatalog,
    scenarioRequest,
} from '../core/scenario-catalog.js';

test('scenario catalog exposes boat and heavy-rail checkpoints', () => {
    const catalog = scenarioCatalog();
    assert.deepEqual(catalog.map(item => item.id), ['boat-crossing', 'heavy-rail']);
    assert.ok(catalog[0].checkpointIds.includes('vis-departure'));
    assert.ok(catalog[1].checkpointIds.includes('lika-inspection'));
    assert.equal(catalog[0].world.mode, 'model');
    assert.equal(catalog[1].world.terrain, 'required');
});

test('scenario links are localhost-only and checkpoint-explicit', () => {
    const search = '?st3d=scenario&id=boat-crossing&checkpoint=vis-departure';
    const local = scenarioRequest(search, 'localhost');
    assert.equal(local.ok, true);
    assert.equal(local.kind, 'boat');
    assert.equal(local.checkpointId, 'vis-departure');
    assert.deepEqual(
        scenarioRequest(search, 'example.com'),
        { ok: false, reason: 'localhost-only' },
    );
    assert.equal(
        scenarioRequest('?st3d=scenario&id=heavy-rail&checkpoint=nope', 'localhost').reason,
        'unknown-checkpoint',
    );
});

test('scenario world requirements canonicalize the launch before Station3D opens', () => {
    const bare = scenarioRequest(
        '?st3d=scenario&id=heavy-rail&checkpoint=split-departure',
        'localhost',
    );
    assert.equal(bare.ok, true);
    assert.equal(bare.worldSearchChanged, true);
    const params = new URLSearchParams(bare.canonicalSearch);
    assert.equal(params.get('elevation'), '1');

    const canonical = resolveScenarioWorldSearch(bare.canonicalSearch, bare.world);
    assert.equal(canonical.ok, true);
    assert.equal(canonical.changed, false);
    assert.equal(
        scenarioRequest(
            '?st3d=scenario&id=heavy-rail&checkpoint=split-departure&photo=1',
            'localhost',
        ).reason,
        'photo-world-conflict',
    );
    assert.equal(
        scenarioRequest(
            '?st3d=scenario&id=heavy-rail&checkpoint=split-departure&elevation=0',
            'localhost',
        ).reason,
        'terrain-disabled',
    );
});
