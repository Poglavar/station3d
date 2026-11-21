// Passage walls and lintels share one immutable transform/material. Keep the
// source contract that turns them into one color/shadow draw per passage.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../world/courtyard-passages.js', import.meta.url), 'utf8');

test('courtyard passage shells merge their repeated wall and lintel primitives', () => {
    assert.match(source, /import \{ mergeGeometries \}/);
    assert.match(source, /function mergePassageShell\(group\)/);
    assert.match(source, /geometry\.applyMatrix4\(mesh\.matrix\)/);
    assert.match(source, /geometry\.deleteAttribute\('uv'\)/);
    assert.match(source, /mergeGeometries\(transformed, false\)/);
    assert.match(source, /shell\.castShadow = true/);
    assert.ok(
        source.indexOf('mergePassageShell(group)')
            < source.indexOf('ensurePassagesGroup().add(group)', source.indexOf('function spawnPassageMesh')),
        'the shell is merged before atomic publication',
    );
});
