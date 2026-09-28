import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUND_PAINT_DIRTY_BLOCKS, planGroundPaintDirtyBlocks } from '../core/ground-paint-dirty-blocks.js';
import { planGroundPaintUpdate } from '../core/ground-paint-update.js';

const page = { minX: 0, minZ: 0, maxX: 512, maxZ: 512 };
const receiver = { key: 'ground', verticalBand: 'ground', coverageRevision: 'r1' };
const testUpdate = (bounds, extra = {}) => planGroundPaintUpdate({ receiver, bounds, size: 64,
  blockSize: 8, maxBlocks: 64, ...extra });
const repaintIndices = update => update.repaints.map(rect => (rect.y / 8) * 8 + rect.x / 8).sort((a, b) => a - b);

test('accumulates more than 256 sparse edits without dirtying the clean middle', () => {
  const dirtyBounds = Array.from({ length: 300 }, (_, index) => {
    const x = (index % 32) * 8 + 3, z = Math.floor(index / 32) * 8 + 3;
    return { minX: x, minZ: z, maxX: x + 1, maxZ: z + 1 };
  });
  const sparsePage = { minX: 0, minZ: 0, maxX: 256, maxZ: 256 };
  const result = planGroundPaintDirtyBlocks({ bounds: sparsePage, size: 256, blockSize: 8,
    maxBlocks: 1024, dirtyBounds });
  assert.equal(result.blocks.length, 300);
  assert.equal(result.blocks.includes(16 * 32 + 16), false);
  assert.deepEqual(result.blocks, [...result.blocks].sort((a, b) => a - b));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.bounds), true);
  assert.equal(Object.isFrozen(result.blocks), true);
});

test('unions prior dirty blocks with new edits', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 4096, maxZ: 4096 };
  const first = planGroundPaintDirtyBlocks({ bounds, size: 4096, blockSize: 256,
    dirtyBounds: [{ minX: 10, minZ: 10, maxX: 12, maxZ: 12 }] });
  const next = planGroundPaintDirtyBlocks({ bounds, size: 4096, blockSize: 256, previous: first,
    dirtyBounds: [{ minX: 3000, minZ: 3000, maxX: 3001, maxZ: 3001 }] });
  assert.deepEqual(next.blocks, [0, 11 * 16 + 11]);
});

test('carried blocks do not grow another rasterization halo', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const first = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 16,
    dirtyBounds: [{ minX: 17, minZ: 17, maxX: 18, maxZ: 18 }] });
  assert.deepEqual(first.blocks, [5]);
  const repeated = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 16, previous: first });
  assert.deepEqual(repeated.blocks, [5]);
});

test('reprojects previous page blocks by world footprint after a page shift', () => {
  const oldBounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const movedBounds = { minX: 16, minZ: 0, maxX: 80, maxZ: 64 };
  const first = planGroundPaintDirtyBlocks({ bounds: oldBounds, size: 64, blockSize: 16,
    dirtyBounds: [{ minX: 33, minZ: 17, maxX: 34, maxZ: 18 }] });
  assert.deepEqual(first.blocks, [6]);
  const moved = planGroundPaintDirtyBlocks({ bounds: movedBounds, size: 64, blockSize: 16, previous: first });
  assert.deepEqual(moved.blocks, [5]);
});

test('one-texel halo conserves a narrow diagonal edge crossing block seams', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const result = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 16,
    dirtyBounds: [{ minX: 15.2, minZ: 31.2, maxX: 15.4, maxZ: 31.4 }] });
  assert.deepEqual(result.blocks, [4, 5, 8, 9]);
});

test('edits outside the page are clipped and cannot mark distant blocks', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const result = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 16,
    dirtyBounds: [{ minX: 100, minZ: 100, maxX: 110, maxZ: 110 }] });
  assert.deepEqual(result.blocks, []);
});

test('rejects invalid geometry, incompatible pages, excessive input and block overflow', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 0 }), TypeError);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64,
    dirtyBounds: [{ minX: 2, minZ: 2, maxX: 2, maxZ: 3 }] }), TypeError);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64,
    dirtyBounds: Array.from({ length: 8194 }, () => bounds) }), RangeError);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 8, maxBlocks: 1,
    dirtyBounds: [{ minX: 1, minZ: 1, maxX: 60, maxZ: 60 }] }), RangeError);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 8, maxBlocks: 63 }), /block budget/);
  const previous = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 16 });
  assert.equal(previous.contract, GROUND_PAINT_DIRTY_BLOCKS);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 8, previous }), TypeError);
  assert.throws(() => planGroundPaintDirtyBlocks({ bounds: { ...bounds, maxX: 65 }, size: 64,
    blockSize: 16, previous }), TypeError);
});

test('randomized dirty bounds and integer layout shifts match direct planner repaints', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const randomRects = (count, pageBounds) => Array.from({ length: count }, () => {
    const x = -2 + random() * 68, z = -2 + random() * 68;
    const width = 0.1 + random() * 5, height = 0.1 + random() * 5;
    return { minX: pageBounds.minX + x, minZ: pageBounds.minZ + z,
      maxX: pageBounds.minX + x + width, maxZ: pageBounds.minZ + z + height };
  });
  const oldBounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const initialEdits = randomRects(48, oldBounds);
  const initialBlocks = planGroundPaintDirtyBlocks({ bounds: oldBounds, size: 64, blockSize: 8,
    maxBlocks: 64, dirtyBounds: initialEdits });
  assert.deepEqual(repaintIndices(testUpdate(oldBounds, { dirtyBounds: initialEdits })),
    repaintIndices(testUpdate(oldBounds, { dirtyBlocks: initialBlocks })));

  // Encode the previous block footprints as inset rectangles. The planner's
  // one-texel halo restores each exact footprint after this page shifts.
  const movedBounds = { minX: 3, minZ: 5, maxX: 67, maxZ: 69 };
  const priorBlockBounds = initialBlocks.blocks.map(index => {
    const row = Math.floor(index / 8), column = index % 8;
    return { minX: column * 8 + 1, minZ: row * 8 + 1,
      maxX: Math.min(64, (column + 1) * 8) - 1, maxZ: Math.min(64, (row + 1) * 8) - 1 };
  });
  const movedEdits = randomRects(52, movedBounds);
  const movedBlocks = planGroundPaintDirtyBlocks({ bounds: movedBounds, size: 64, blockSize: 8,
    maxBlocks: 64, previous: initialBlocks, dirtyBounds: movedEdits });
  const previousPage = { receiver, bounds: oldBounds, size: 64, disposed: false };
  const movedReference = testUpdate(movedBounds, { previous: previousPage,
    dirtyBounds: [...priorBlockBounds, ...movedEdits] });
  const movedAccumulated = testUpdate(movedBounds, { previous: previousPage, dirtyBlocks: movedBlocks });
  assert.deepEqual(repaintIndices(movedAccumulated), repaintIndices(movedReference));
  // Explicit pixel oracle: every moved old damaged block footprint and every
  // current edit's raster halo is wholly inside a repainted destination block.
  const repainted = new Set(repaintIndices(movedAccumulated));
  const assertPixelCovered = (x, z) => {
    const pixelX = (x - movedBounds.minX), pixelZ = (z - movedBounds.minZ);
    if (pixelX < 0 || pixelZ < 0 || pixelX >= 64 || pixelZ >= 64) return;
    assert.ok(repainted.has(Math.floor(pixelZ / 8) * 8 + Math.floor(pixelX / 8)));
  };
  for (const rect of priorBlockBounds) {
    for (let z = rect.minZ - 1; z < rect.maxZ + 1; z++) for (let x = rect.minX - 1; x < rect.maxX + 1; x++) assertPixelCovered(x, z);
  }
  for (const rect of movedEdits) {
    const x0 = Math.floor(rect.minX - movedBounds.minX) - 1;
    const y0 = Math.floor(rect.minZ - movedBounds.minZ) - 1;
    const x1 = Math.ceil(rect.maxX - movedBounds.minX) + 1;
    const y1 = Math.ceil(rect.maxZ - movedBounds.minZ) + 1;
    for (let z = y0; z < y1; z++) for (let x = x0; x < x1; x++) assertPixelCovered(movedBounds.minX + x, movedBounds.minZ + z);
  }
});

test('same-layout accumulation plus source updates keeps repaint blocks stable', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 64, maxZ: 64 };
  const edits = [
    [{ minX: 9, minZ: 9, maxX: 10, maxZ: 10 }],
    [{ minX: 41, minZ: 41, maxX: 42, maxZ: 42 }],
    [],
  ];
  let damage = null;
  let pageState = { receiver, bounds, size: 64, disposed: false };
  const observed = [];
  for (const dirtyBounds of edits) {
    damage = planGroundPaintDirtyBlocks({ bounds, size: 64, blockSize: 8, maxBlocks: 64,
      previous: damage, dirtyBounds });
    const update = testUpdate(bounds, { previous: pageState, dirtyBlocks: damage });
    observed.push(repaintIndices(update));
    pageState = update;
  }
  assert.deepEqual(observed, [[9], [9, 45], [9, 45]]);
});
