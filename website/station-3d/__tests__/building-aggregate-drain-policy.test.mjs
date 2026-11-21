// Verifies that merged-building uploads favor smooth motion and fast stationary catch-up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildingAggregateDrainPolicy } from '../core/building-aggregate-drain-policy.js';

const SOURCE = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');

test('moving frames keep aggregate work below the motion budget', () => {
    for (const state of ['slow', 'transit', 'fast']) {
        assert.deepEqual(buildingAggregateDrainPolicy(state), {
            frameBudgetMs: 2,
            maxUploads: 1,
        });
    }
});

test('stationary frames also admit one bounded fresh GPU upload', () => {
    assert.deepEqual(buildingAggregateDrainPolicy('stationary'), {
        frameBudgetMs: 3,
        maxUploads: 1,
    });
});

test('building drain uses a deduplicated queue without per-frame backlog copies', () => {
    const assemble = SOURCE.slice(
        SOURCE.indexOf('function assembleOvertureBuckets'),
        SOURCE.indexOf('// One assemble per completed tile'),
    );
    assert.match(SOURCE, /buildingAggregateDrainPolicy\(getFrameChunkWorkMotionState\(\)\)/);
    assert.match(assemble, /pendingOvertureBucketHead \+= 1/);
    assert.doesNotMatch(assemble, /new Set\(pendingOvertureBuckets\)/);
    assert.doesNotMatch(assemble, /queued\.slice/);
    assert.match(assemble, /overtureBatcher\.beginAssembly\(bucketKey/);
    assert.match(assemble, /const taskComplete = task\.step\(remainingMs\)/);
    assert.match(assemble, /if \(!taskComplete\) break/);
    assert.match(assemble, /if \(!task\.isCurrent\(\)\)/);
    assert.doesNotMatch(assemble, /overtureBatcher\.assemble\(bucketKey\)/);
    assert.match(assemble, /buildOvertureAggregateMesh\(/);
    assert.match(assemble, /prewarmDetachedObject\(mesh/);
    assert.match(assemble, /asyncShaders: frameBudgetMs !== Infinity/);
    assert.match(assemble, /uploadGeometry: false/);
    assert.match(assemble, /prewarmShaders: true/);
    assert.match(SOURCE, /import \{[\s\S]*?camera,[\s\S]*?\} from '\.\.\/scene\/setup\.js'/);
});

test('static radius load finalizes contact AO cooperatively before completion', () => {
    const staticLoad = SOURCE.slice(
        SOURCE.indexOf('export function loadBuildingsRadius'),
        SOURCE.indexOf('export function loadCatchmentStats'),
    );
    assert.match(staticLoad, /createStaticContactAoFinalizationWorkItem\(buildContext\)/);
    assert.doesNotMatch(staticLoad, /addContactAoBatch\(/);
    assert.match(
        SOURCE,
        /function createStaticContactAoFinalizationWorkItem[\s\S]*?const outcome = task\.step\(\)[\s\S]*?return done \? 'done' : 'repeat'/,
    );
});

test('synchronous aggregate drain never waits on asynchronous shader completion', () => {
    const assemble = SOURCE.slice(
        SOURCE.indexOf('function assembleOvertureBuckets'),
        SOURCE.indexOf('// One assemble per completed tile'),
    );
    assert.match(assemble, /asyncShaders: frameBudgetMs !== Infinity/);
    assert.match(SOURCE, /assembleOvertureBuckets\(\)/);
});
