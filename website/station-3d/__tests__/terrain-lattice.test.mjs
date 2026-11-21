// Lattice selection must preserve each tile's triangle planes without an
// unbounded scan when a physics footprint crosses a resolution boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commonTerrainLatticeStep, terrainLatticeStepForBounds } from '../core/terrain-lattice.js';

test('common subdivisions divide all source steps, including non-nested resolutions', () => {
    for (const [steps, expected] of [[[20, 4], 4], [[8, 20], 4], [[1, 20, 4], 1], [[7.5, 20], 2.5], [[40 / 3, 20], 20 / 3]]) {
        assert.ok(Math.abs(commonTerrainLatticeStep(steps) - expected) < 1e-8);
        assert.ok(Math.abs(commonTerrainLatticeStep([...steps].reverse()) - expected) < 1e-8);
    }
    assert.equal(commonTerrainLatticeStep([]), null);
    for (const value of [null, 0, -1, NaN, Infinity]) assert.throws(() => commonTerrainLatticeStep([20, value]));
});

test('the whole footprint selects its subdivision and rejects oversized scans before querying', () => {
    const visits = [];
    const sample = (x, z) => { visits.push([x, z]); return x < 0 ? 20 : x === 0 ? 8 : null; };
    assert.equal(terrainLatticeStepForBounds({ minX: -5, maxX: 5, minZ: 1, maxZ: 2 }, 400, sample), 4);
    assert.deepEqual(visits, [[-1, 0], [0, 0]]);
    assert.equal(terrainLatticeStepForBounds({ minX: 1, maxX: 399, minZ: 1, maxZ: 2 }, 400, sample), 8);
    assert.equal(terrainLatticeStepForBounds({ minX: 800, maxX: 810, minZ: 1, maxZ: 2 }, 400, sample), null);
    visits.length = 0;
    assert.throws(() => terrainLatticeStepForBounds({ minX: 0, maxX: 400 * 256, minZ: 0, maxZ: 1 }, 400, sample), /work limit/);
    assert.throws(() => terrainLatticeStepForBounds({ minX: 1e30, maxX: 1e30, minZ: 0, maxZ: 1 }, 400, sample), /precision/);
    assert.equal(visits.length, 0);
});
