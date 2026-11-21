// Verifies that moving terrain windows invalidate only changed whole tiles and
// suppress a refresh whose rendered surface signature is unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mergePreparedDetails,
    planTerrainDetailChange,
    retainTrailingDetailWindows,
    sampledTerrainTileSurfaceSignature,
    terrainDetailTileKeys,
    terrainDetailTileSurfaceSignature,
    terrainTileBoundsForKeys,
} from '../core/terrain-detail-change.js';

const detail = rects => ({ stepM: 4, tileM: 400, rects });

test('a shifted detail window invalidates only its symmetric-difference tiles', () => {
    const previous = detail([{ minX: 0, maxX: 800, minZ: 0, maxZ: 400 }]);
    const next = detail([{ minX: 400, maxX: 1200, minZ: 0, maxZ: 400 }]);
    const plan = planTerrainDetailChange(previous, next);
    assert.deepEqual([...terrainDetailTileKeys(previous)], ['0_0', '1_0']);
    assert.deepEqual([...terrainDetailTileKeys(next)], ['1_0', '2_0']);
    assert.deepEqual(plan.changedTileKeys, ['0_0', '2_0']);
    assert.equal(plan.noOp, false);
});

test('rect movement that preserves the whole-tile surface is a no-op', () => {
    const previous = detail([{ minX: -20, maxX: 820, minZ: -20, maxZ: 420 }]);
    const next = detail([{ minX: -80, maxX: 880, minZ: -50, maxZ: 470 }]);
    const plan = planTerrainDetailChange(previous, next);
    assert.deepEqual(plan.changedTileKeys, []);
    assert.equal(plan.noOp, true);
    assert.equal(plan.previousFineTileCount, 2);
    assert.equal(plan.nextFineTileCount, 2);
});

test('overlapping rects remain a union rather than invalidating their envelope', () => {
    const windows = detail([
        { minX: 0, maxX: 800, minZ: 0, maxZ: 400 },
        { minX: 400, maxX: 1200, minZ: 0, maxZ: 400 },
    ]);
    assert.deepEqual([...terrainDetailTileKeys(windows)], ['0_0', '1_0', '2_0']);
});

test('a surface-resolution change invalidates every retained fine tile', () => {
    const previous = detail([{ minX: 0, maxX: 800, minZ: 0, maxZ: 400 }]);
    const next = { ...previous, stepM: 2 };
    const plan = planTerrainDetailChange(previous, next);
    assert.deepEqual(plan.changedTileKeys, ['0_0', '1_0']);
    assert.equal(terrainDetailTileSurfaceSignature(previous, '0_0'), 'fine:4:400');
    assert.equal(terrainDetailTileSurfaceSignature(next, '0_0'), 'fine:2:400');
});

test('same-window source changes are caught by bounded surface fingerprints', () => {
    const windows = detail([{ minX: 0, maxX: 800, minZ: 0, maxZ: 400 }]);
    const previousReference = { sceneYAtLocal: (x, z) => x * 0.01 + z * 0.02 };
    const nextReference = {
        sceneYAtLocal: (x, z) => x * 0.01 + z * 0.02 + (x >= 400 ? 0.2 : 0),
    };
    const signature = reference => key => sampledTerrainTileSurfaceSignature(
        reference,
        key,
        { tileM: 400 },
    );
    const plan = planTerrainDetailChange(windows, windows, {
        previousSurfaceSignature: signature(previousReference),
        nextSurfaceSignature: signature(nextReference),
    });
    assert.deepEqual(plan.changedTileKeys, ['0_0', '1_0']);
    assert.equal(plan.noOp, false);
});

test('sub-centimetre resampling noise does not reopen an unchanged tile', () => {
    const windows = detail([{ minX: 0, maxX: 400, minZ: 0, maxZ: 400 }]);
    const signature = offset => key => sampledTerrainTileSurfaceSignature({
        sceneYAtLocal: (x, z) => x * 0.01 + z * 0.02 + offset,
    }, key, { tileM: 400 });
    const plan = planTerrainDetailChange(windows, windows, {
        previousSurfaceSignature: signature(0),
        nextSurfaceSignature: signature(0.003),
    });
    assert.deepEqual(plan.changedTileKeys, []);
    assert.equal(plan.noOp, true);
});

test('changed tile keys publish exact local bounds, including negative tiles', () => {
    assert.deepEqual(terrainTileBoundsForKeys(['-1_2', '0_0'], 400), [
        { minX: -400, minZ: 800, maxX: 0, maxZ: 1200 },
        { minX: 0, minZ: 0, maxX: 400, maxZ: 400 },
    ]);
});

test('the windows just left behind are kept, newest first, within reach and bounded in count', () => {
    const window = (x, z, at) => ({ centerX: x, centerZ: z, publishedAt: at, preparedDetail: { grids: [{}] } });
    const a = window(0, 0, 1), b = window(420, 0, 2), c = window(840, 0, 3), far = window(-3000, 0, 4);
    const kept = retainTrailingDetailWindows([a, b, c, far], { nextCenter: { x: 1260, z: 0 }, maxRetained: 2, maxDistanceM: 1520 });
    assert.deepEqual(kept.map(w => w.publishedAt), [3, 2], 'newest first, the third and the far one dropped');
    assert.deepEqual(retainTrailingDetailWindows([a, b], { nextCenter: { x: 420, z: 0 }, maxRetained: 2 }).map(w => w.publishedAt), [1],
        'a window at the new centre is the new window, not a trailing one');
    assert.deepEqual(retainTrailingDetailWindows([a, b], { nextCenter: { x: 900, z: 0 }, maxRetained: 0 }), []);
    assert.deepEqual(retainTrailingDetailWindows([{ centerX: NaN, centerZ: 0, publishedAt: 9, preparedDetail: {} }, a],
        { nextCenter: { x: 500, z: 0 } }).map(w => w.publishedAt), [1], 'an entry without a centre is not kept');
    assert.deepEqual(retainTrailingDetailWindows([a], { nextCenter: null }), []);
});

test('merging prepared details keeps every grid with the provenance it was prepared with', () => {
    const g1 = { id: 'new' }, g2 = { id: 'old' }, g3 = { id: 'older' };
    const current = { grids: [g1], sourceBoundaries: new Map([[g1, { primaryIndex: 0 }]]),
        detail: { stepM: 4, tileM: 400, rects: [{ minX: 0, maxX: 800, minZ: 0, maxZ: 800 }] } };
    const older = { grids: [g2, g3], sourceBoundaries: new Map([[g2, { primaryIndex: 0 }]]),
        detail: { stepM: 4, tileM: 400, rects: [{ minX: -800, maxX: 0, minZ: 0, maxZ: 800 }, { minX: -1600, maxX: -800, minZ: 0, maxZ: 800 }] } };
    const merged = mergePreparedDetails(current, [older, { grids: [g2], sourceBoundaries: new Map(), detail: { rects: [] } }]);
    assert.deepEqual(merged.grids, [g1, g2, g3], 'the new window first, each retained grid once');
    assert.equal(merged.sourceBoundaries.get(g1).primaryIndex, 0);
    assert.equal(merged.sourceBoundaries.get(g2).primaryIndex, 0);
    assert.equal(merged.sourceBoundaries.has(g3), true, 'a grid without a boundary index still has its Map entry');
    assert.equal(merged.sourceBoundaries.get(g3), null);
    assert.equal(merged.detail.rects.length, 3);
    assert.equal(merged.detail.stepM, 4);
    assert.equal(mergePreparedDetails(current, []).grids.length, 1);
    assert.equal(mergePreparedDetails(null, [older]), null, 'no new window: nothing to compose');
});
