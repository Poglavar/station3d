import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { selectTerrainGroundScopeSteps } from '../core/terrain-ground-scope.js';

const run = options => {
    const steps = selectTerrainGroundScopeSteps(options);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
};
const base = extra => ({
    residentKeys: [], pendingJobs: [], pinnedKeys: new Set(),
    centerTileX: 0, centerTileZ: 0, keepRing: 1, maxChangedTiles: 20, ...extra,
});

test('prunes far pending resident but retains nearby and pinned work', () => {
    const result = run(base({
        residentKeys: ['3_0', '0_1', '5_5'],
        pendingJobs: [{ key: '3_0', id: 'old' }, { key: '0_1', id: 'near' }, { key: '5_5', id: 'pin' }],
        pinnedKeys: new Set(['5_5']),
    }));
    assert.deepEqual(new Set(result.tileKeys), new Set(['0_1', '5_5']));
    assert.deepEqual(result.removeKeys, ['3_0']);
    assert.deepEqual(result.pendingJobs.map(job => job.id), ['near', 'pin']);
});

test('drops outside pending without resident and deduplicates retained jobs', () => {
    const result = run(base({ pendingJobs: [
        { key: '9_9', id: 'drop' }, { key: '0_0', id: 'a' }, { key: '0_0', id: 'b' },
    ] }));
    assert.deepEqual(result.tileKeys, ['0_0']);
    assert.deepEqual(result.removeKeys, []);
    assert.deepEqual(result.pendingJobs.map(job => job.id), ['a']);
});

test('capacity is evaluated after expiry pruning and rejects real excess', () => {
    const result = run(base({ residentKeys: ['9_9', '8_8', '0_0'], pendingJobs: [{ key: '9_9' }], maxChangedTiles: 3 }));
    assert.deepEqual(new Set(result.tileKeys), new Set(['0_0']));
    assert.deepEqual(result.removeKeys, ['9_9', '8_8']);
    assert.throws(() => run(base({ residentKeys: ['0_0', '0_1'], maxChangedTiles: 1 })), /capacity/);
});

test('failed moved window keeps only latest valid pending in new scope', () => {
    const old = run(base({ residentKeys: ['0_0', '1_0'], pendingJobs: [{ key: '0_0', id: 'old' }] }));
    const moved = run(base({ residentKeys: old.tileKeys, pendingJobs: [...old.pendingJobs, { key: '4_4', id: 'new' }], centerTileX: 4, centerTileZ: 4, keepRing: 0 }));
    assert.deepEqual(moved.tileKeys, ['4_4']);
    assert.deepEqual(moved.removeKeys, ['0_0', '1_0']);
    assert.deepEqual(moved.pendingJobs.map(job => job.id), ['new']);
});

test('invalid keys and limits reject', () => {
    assert.throws(() => run(base({ residentKeys: ['bad'] })), /Invalid terrain scope tile/);
    assert.throws(() => run(base({ pendingJobs: [{ key: 'x_1' }] })), /Invalid terrain scope tile/);
    assert.throws(() => run(base({ keepRing: -1 })), /bounded/);
    assert.throws(() => run(base({ maxChangedTiles: 0 })), /bounded/);
});

test('terrainLayer groundScopeSteps prunes stale pending work without finalize', () => {
    const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const start = source.indexOf('*groundScopeSteps({');
    const end = source.indexOf('prepareOwnershipGroundSteps:', start);
    const method = source.slice(start, end).replace(/^\s*\*groundScopeSteps/, 'function* groundScopeSteps').replace(/,\s*$/, '');
    const context = vm.createContext({
        selectTerrainGroundScopeSteps,
        Map, Set, tiles: new Map([['5_0', {}], ['0_0', {}]]),
        pendingTileBuilds: [{ key: '5_0', id: 'stale' }, { key: '0_1', id: 'near' }],
        terrainPinnedTileKeys: new Set(), lastTileX: 0, lastTileZ: 0, KEEP_RING: 1,
    });
    vm.runInContext(method + '; globalThis.scope = groundScopeSteps;', context);
    const steps = context.scope({ maxChangedTiles: 10 }); let next = steps.next(); while (!next.done) next = steps.next(); const result = next.value;
    assert.deepEqual(result.tileKeys, ['0_0', '0_1']);
    assert.deepEqual(result.removeKeys, ['5_0']);
    assert.deepEqual(context.pendingTileBuilds.map(job => job.id), ['near']);
});

test('terrain scope cancellation preserves replacement queue identity', () => {
    const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const start = source.indexOf('*groundScopeSteps({');
    const end = source.indexOf('prepareOwnershipGroundSteps:', start);
    const method = source.slice(start, end).replace(/^\s*\*groundScopeSteps/, 'function* groundScopeSteps').replace(/,\s*$/, '');
    const queue = [{ key: '0_0', id: 'old' }];
    const context = vm.createContext({ selectTerrainGroundScopeSteps, Map, Set, tiles: new Map([['0_0', {}]]), pendingTileBuilds: queue, terrainPinnedTileKeys: new Set(), lastTileX: 0, lastTileZ: 0, KEEP_RING: 1 });
    vm.runInContext(method + '; globalThis.scope = groundScopeSteps;', context);
    const steps = context.scope({ maxChangedTiles: 10 });
    assert.equal(steps.next().done, false);
    const replacement = [{ key: '1_1', id: 'new' }];
    context.pendingTileBuilds = replacement;
    assert.throws(() => { for (;;) { const next = steps.next(); if (next.done) break; } }, { code: 'ground-generation-stale' });
    assert.equal(context.pendingTileBuilds, replacement);
});
