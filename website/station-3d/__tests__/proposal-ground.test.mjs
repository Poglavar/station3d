// The pure pieces of the proposal-overlay terrain drape: the edge policy that
// tracks the terrain's own resolution (never hardcoded — 1 m sources are
// coming), the level-water ring statistics, and the ground-following walls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    drapeEdgeMForStep,
    drapeEdgeMForTriangulation,
    drapedRingWallPositions,
    sampleGroundRange,
} from '../core/proposal-ground.js';
import { TerrainReference } from '../core/terrain-grid.js';

test('drape edge tracks the terrain step, floored at 1 m, falling back when unknown', () => {
    assert.equal(drapeEdgeMForStep(20), 20);
    assert.equal(drapeEdgeMForStep(4), 4);
    assert.equal(drapeEdgeMForStep(1), 1);
    // A 1 m source must not explode into sub-metre edges.
    assert.equal(drapeEdgeMForStep(0.5), 1);
    assert.equal(drapeEdgeMForStep(null), 20);
    assert.equal(drapeEdgeMForStep(Number.NaN), 20);
    assert.equal(drapeEdgeMForStep(0), 20);
    assert.equal(drapeEdgeMForStep(undefined, 12), 12);
});

test('drape triangulation detects fine terrain at a vertex or inside a seed triangle', () => {
    const points = [
        { x: 0, z: 0 },
        { x: 30, z: 0 },
        { x: 0, z: 30 },
    ];
    const triangles = [[0, 1, 2]];
    const fineAtVertex = (x, z) => (x === 30 && z === 0 ? 4 : 20);
    assert.equal(drapeEdgeMForTriangulation(
        points,
        triangles,
        fineAtVertex,
    ), 4);
    const fineAtInterior = (x, z) => (
        Math.abs(x - 10) < 1e-9 && Math.abs(z - 10) < 1e-9 ? 2 : 20
    );
    assert.equal(drapeEdgeMForTriangulation(
        points,
        triangles,
        fineAtInterior,
    ), 2);
    assert.equal(drapeEdgeMForTriangulation(points, triangles, null, 12), 12);
});

test('TerrainReference reports its sample step: fine inside the window, coarse outside, null flat', () => {
    const grid = { sampleHeight: () => 100 };
    const fine = new TerrainReference(grid, 15.87, 43.75, {
        surfaceStepM: 20,
        detail: { stepM: 1, tileM: 400, rects: [{ minX: -400, maxX: 400, minZ: -400, maxZ: 400 }] },
    });
    assert.equal(fine.sampleStepMAtLocal(0, 0), 1);
    assert.equal(fine.sampleStepMAtLocal(5000, 5000), 20);
    const coarse = new TerrainReference(grid, 15.87, 43.75, { surfaceStepM: 20 });
    assert.equal(coarse.sampleStepMAtLocal(0, 0), 20);
    const surfaceless = new TerrainReference(grid, 15.87, 43.75, {});
    assert.equal(surfaceless.sampleStepMAtLocal(0, 0), null);
});

test('ground range: min/max over finite samples, null-samples skipped rather than read as 0', () => {
    const slope = (x) => x / 10;
    const range = sampleGroundRange([{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 50, z: 0 }], slope);
    assert.deepEqual(range, { min: 0, max: 10 });
    // The Number(null)-is-0 trap: a missing sample must not drag min to 0.
    const holey = sampleGroundRange(
        [{ x: 40, z: 0 }, { x: 80, z: 0 }],
        (x) => (x === 40 ? null : 7),
    );
    assert.deepEqual(holey, { min: 7, max: 7 });
    assert.equal(sampleGroundRange([{ x: 1, z: 1 }], () => Number.NaN), null);
    assert.equal(sampleGroundRange([], slope), null);
    assert.equal(sampleGroundRange(null, slope), null);
});

test('draped walls follow the ground per vertex and keep the lift heights', () => {
    const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    const slope = (x) => x;   // ground rises 1 m per metre east
    const positions = drapedRingWallPositions(ring, slope, 0.1, 0.25);
    assert.ok(Array.isArray(positions) && positions.length % 18 === 0);
    // First segment: (0,0)→(10,0). Vertex ys: bottom(a)=0.1, bottom(b)=10.1, top(b)=10.25 …
    assert.equal(positions[1], 0.1);
    assert.equal(positions[4], 10.1);
    assert.equal(positions[7], 10.25);
    // Flat sampler reproduces the old plane behaviour exactly.
    const flat = drapedRingWallPositions(ring, () => 0, 0.108, 0.25);
    assert.equal(flat[1], 0.108);
    assert.equal(flat[7], 0.25);
});

test('walls refuse degenerate input instead of guessing', () => {
    assert.equal(drapedRingWallPositions([{ x: 0, z: 0 }], () => 0, 0, 1), null);
    assert.equal(drapedRingWallPositions([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], () => 0, 0.3, 0.1), null);
    // A closed ring (last point repeats the first) emits one wall per EDGE, not
    // a zero-length extra for the duplicate.
    const closed = drapedRingWallPositions(
        [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 0 }],
        () => 0, 0, 1,
    );
    assert.equal(closed.length, 3 * 18);
});
