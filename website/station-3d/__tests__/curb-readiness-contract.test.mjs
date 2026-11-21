// Curbs are browser-bound, so pin their startup publication contract at the
// source boundary: the loading segment must represent the four published
// observer tiles, not a temporarily empty build queue waiting on dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTileBuildGenerationController } from '../core/tile-build-generation.js';
import { createSurfaceRebuildLedger, commitSurfaceRebuild } from '../core/surface-rebuild-ledger.js';

const CURBS = readFileSync(new URL('../world/curbs.js', import.meta.url), 'utf8');

test('curb readiness is explicit and cannot be completed by a dependency abort', () => {
    assert.match(CURBS, /createFrameChunkQueue\(\{[\s\S]{0,360}trackWorldReady:\s*false/);
    assert.match(CURBS, /function beginInitialNearCurbGate\(\)[\s\S]{0,420}noteWorldQueueActive\('curbs'\)/);
    assert.match(CURBS, /function noteInitialNearCurbTileReady\(tileKey\)[\s\S]{0,300}noteWorldQueueIdle\('curbs'\)/);
    assert.match(CURBS, /initialNearCurbTileKeys\s*=\s*initialWorldSupportTileKeys\(\)/);
});

test('initial curb publication waits for asphalt, masks and the parking/green index', () => {
    assert.match(
        CURBS,
        /function curbTileDependenciesReady\(tileKey\)[\s\S]{0,420}parkingIndexReady[\s\S]{0,420}maskTileFeatures\.has\(tileKey\)[\s\S]{0,420}roadSurfaceTiles\.isReady\(tileKey\)/,
    );
    assert.match(CURBS, /function enqueueTileBuildIfReady\(tileKey\)/);
    assert.match(CURBS, /roadSurfaceTiles\.whenReady\(tileKey,/,
        'a curb tile wakes when its corresponding asphalt aggregate publishes');
    const readyCalls = CURBS.match(/enqueueTileBuildIfReady\(tileKey\)/g) || [];
    assert.ok(readyCalls.length >= 4, 'curb, mask and parking arrivals share one dependency gate');
});

test('superseded curb generation retains old publication until the latest candidate commits', async () => {
    const ledger = createSurfaceRebuildLedger();
    const completions = [];
    let active = 'previous-complete';
    const controller = createTileBuildGenerationController({ startBuild: (tileKey, generation, isCurrent) => {
        const revision = ledger.pendingRevision(tileKey);
        return new Promise(resolve => completions.push(() => {
            commitSurfaceRebuild({ ledger, tileKey, revision, isCurrent,
                publish: acknowledge => { active = generation; acknowledge(); } });
            resolve();
        }));
    } });
    ledger.mark('0_0', 1);
    const first = controller.request('0_0');
    ledger.mark('0_0', 2);
    const second = controller.request('0_0');
    completions.shift()(); await first;
    assert.equal(active, 'previous-complete');
    assert.equal(ledger.pendingRevision('0_0'), 2);
    completions.shift()(); await second;
    assert.equal(active, 2);
    assert.equal(ledger.isPending('0_0'), false);
});

test('cooperative curb stages consume the time budget instead of one stage per frame', () => {
    const buildStart = CURBS.indexOf('function startTileBuild(');
    assert.notEqual(buildStart, -1);
    const buildSource = CURBS.slice(buildStart, buildStart + 4200);
    assert.doesNotMatch(buildSource, /maxItemsPerFrame:\s*1/,
        'FRAME_CHUNK_REPEAT_ITEM already yields at the queue deadline');
    assert.match(buildSource, /FRAME_CHUNK_REPEAT_ITEM/);
});
