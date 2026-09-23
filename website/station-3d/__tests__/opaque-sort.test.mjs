// Program-grouped opaque ordering must never cross renderOrder (ground stencil
// ownership) and must put draws of one program next to each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgramGroupedOpaqueSort, rendererProgramLookup } from '../core/opaque-sort.js';

const program = new Map();
const mat = (id, prog) => { const m = { id }; program.set(m, prog); return m; };
const sort = createProgramGroupedOpaqueSort(m => program.get(m) ?? null);
const item = (id, material, { renderOrder = 0, groupOrder = 0, z = 0 } = {}) =>
    ({ id, material, renderOrder, groupOrder, materialVariant: 0, z });

test('render order and group order dominate; programs group within them', () => {
    const a = mat(1, 7), b = mat(2, 3), c = mat(3, 7), d = mat(4, null);
    const items = [item(1, a), item(2, b), item(3, c), item(4, d), item(5, a, { renderOrder: -1 }), item(6, b, { groupOrder: 1 })];
    const order = items.slice().sort(sort).map(i => i.id);
    assert.deepEqual(order, [5, 2, 1, 3, 4, 6]);
});

test('within one program, material then front-to-back depth decides', () => {
    const a = mat(10, 1), b = mat(11, 1);
    const order = [item(1, b, { z: 1 }), item(2, a, { z: 9 }), item(3, a, { z: 2 })].sort(sort).map(i => i.id);
    assert.deepEqual(order, [3, 2, 1]);
});

test('the renderer lookup reads the compiled program and tolerates uncompiled materials', () => {
    const properties = new WeakMap(), compiled = {}, fresh = {};
    properties.set(compiled, { currentProgram: { id: 42 } });
    const lookup = rendererProgramLookup({ properties: { get: m => properties.get(m) } });
    assert.equal(lookup(compiled), 42);
    assert.equal(lookup(fresh), null);
    assert.throws(() => createProgramGroupedOpaqueSort(null), TypeError);
});
