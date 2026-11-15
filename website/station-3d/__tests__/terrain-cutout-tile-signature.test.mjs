// A terrain receiver's cut signature covers only the cut it can see: operand rings
// clipped to the tile plus a margin. Edits elsewhere on a long road leave it alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTerrainCutoutTilesSteps, clippedRingSignature, CUT_SIGNATURE_MARGIN_M } from '../core/terrain-cutout-tiles.js';

const run = (generator) => { let step = generator.next(); while (!step.done) step = generator.next(); return step.value; };
const row = { key: '0_0', tileX: 0, tileZ: 0 };
const options = { tileM: 400, maxRegions: 64, maxVertices: 4096, now: () => 0 };
// A long road cut crossing tile 0_0 (x 0..400) and running on to x = 1200.
const road = (farZ = 30, nearZ = 30, extra = {}) => ({
    ring: [{ x: -100, z: 10 }, { x: 1200, z: 10 }, { x: 1200, z: farZ }, { x: 600, z: farZ }, { x: 500, z: 30 }, { x: 200, z: nearZ }, { x: -100, z: 30 }],
    bounds: { minX: -100, minZ: 10, maxX: 1200, maxZ: Math.max(30, farZ, nearZ) },
    minY: null, maxY: 2,
    ...extra,
});
const signature = region => run(prepareTerrainCutoutTilesSteps([{ operation: 'subtract', regions: [region] }], [row], options)).get('0_0').signature;

test('moving the road beyond the tile and its margin keeps the tile signature', () => {
    assert.equal(signature(road(80)), signature(road(30)));
});

test('a change inside the tile, or to the cut depth, changes the signature', () => {
    assert.notEqual(signature(road(30, 40)), signature(road(30, 30)));
    assert.notEqual(signature(road(30, 30, { maxY: 3 })), signature(road(30, 30)));
});

test('a region whose box overlaps but whose shape misses the tile adds nothing', () => {
    const lShape = { ring: [{ x: 500, z: -500 }, { x: 900, z: -500 }, { x: 900, z: 700 }, { x: 500, z: 700 }],
        bounds: { minX: -200, minZ: -500, maxX: 900, maxZ: 700 }, minY: null, maxY: 2 };
    assert.equal(run(prepareTerrainCutoutTilesSteps([{ operation: 'subtract', regions: [lShape] }], [row], options)).get('0_0').signature, '');
});

test('clipping is exact and independent of where the ring starts', () => {
    const box = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const square = [{ x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }];
    assert.equal(clippedRingSignature(square, box), '0,0;5,0;5,5;0,5;');
    assert.equal(clippedRingSignature([...square.slice(2), ...square.slice(0, 2)], box), clippedRingSignature(square, box));
    assert.equal(clippedRingSignature([{ x: 20, z: 20 }, { x: 30, z: 20 }, { x: 30, z: 30 }], box), '');
    assert.equal(CUT_SIGNATURE_MARGIN_M > 0, true);
});
