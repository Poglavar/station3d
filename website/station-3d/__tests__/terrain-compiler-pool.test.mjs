// How many dedicated terrain receiver compilers a session starts for a given core count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainCompilerWorkerCount } from '../core/render-compiler-client.js';

test('small machines share the primary compiler; larger ones get two, then three', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 8, 16, undefined, 'x'].map(terrainCompilerWorkerCount), [0, 0, 0, 2, 2, 3, 3, 3, 0, 0]);
});
