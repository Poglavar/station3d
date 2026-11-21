import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIndexedSurfaceGeometrySteps } from '../core/indexed-surface-geometry.js';
import { createPlannerGeometryBudget } from '../core/planner-geometry-budget.js';

function compile(options) {
    const steps = prepareIndexedSurfaceGeometrySteps({ maxVertices: 65536, maxTriangles: 100,
        budget: createPlannerGeometryBudget(), ...options });
    try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
    finally { steps.return(); }
}

test('geometry welding preserves separate large coordinates and smooth normals, bounds and index width', () => {
    const wide = compile({ positions: [0, 0, 0, 4294967296, 0, 0, 0, 0, 1], indices: [0, 2, 1], weldTolerance: 1 });
    assert.equal(wide.positions.length, 9, 'large coordinate quantization must not wrap into the origin');
    assert.deepEqual([...wide.indices], [0, 1, 2]);
    assert.deepEqual([...wide.normals], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
    assert.deepEqual(wide.bounds, { min: [0, 0, 0], max: [4294967296, 0, 1] });
    assert.equal(wide.sphere.radius, Math.sqrt(2147483648 ** 2 + .25));
    const positions = new Float32Array(65536 * 3); positions[3] = 1; positions[65535 * 3 + 2] = 1;
    const highIndex = compile({ positions, indices: [0, 65535, 1] });
    assert.ok(highIndex.indices instanceof Uint32Array);
    assert.deepEqual([...highIndex.indices], [0, 65535, 1]);
    for (const index of [0, 1, 65535]) assert.deepEqual([...highIndex.normals.slice(index * 3, index * 3 + 3)], [0, 1, 0]);
});

test('malformed, oversized and superseded geometry cannot return a partial packet', () => {
    const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 2, 1] };
    assert.throws(() => compile({ ...triangle, maxVertices: 2 }), { code: 'ground-generation-capacity' });
    assert.throws(() => compile({ ...triangle, indices: [0, 2, 4] }), /outside/);
    assert.throws(() => compile({ ...triangle, positions: [0, 0, NaN] }), /finite/);
    assert.throws(() => compile({ ...triangle, positions: new DataView(new ArrayBuffer(36)) }), TypeError);
    assert.throws(() => compile({ positions: [0, 0, 0, 1e25, 0, 0, 0, 0, 1e25], indices: [0, 2, 1] }), /finite storage/);
    assert.throws(() => compile({ ...triangle, weldTolerance: -1 }), TypeError);
    let valid = true, clock = 0;
    const steps = prepareIndexedSurfaceGeometrySteps({ ...triangle, maxVertices: 3, maxTriangles: 1,
        budget: createPlannerGeometryBudget({ now: () => ++clock, isCurrent: () => valid }) });
    assert.equal(steps.next().done, false); valid = false;
    assert.throws(() => steps.next(), { code: 'ground-generation-stale' });
});
