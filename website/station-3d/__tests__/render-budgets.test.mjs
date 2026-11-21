// Verifies procedural geometry budgets and moving render-window filtering
// without constructing Three.js objects or driving a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    boundsIntersectRenderWindow,
    clipRingToWindow,
    filterTrianglePositionsByRenderWindow,
    isPointWithinRenderWindow,
    sampleSpacingForBudget,
    surfaceRefinementEdgeForArea,
} from '../core/render-budgets.js';

test('large surfaces increase refinement spacing while small surfaces retain native detail', () => {
    assert.equal(surfaceRefinementEdgeForArea(500, { baseEdgeM: 8 }), 8);
    const edge = surfaceRefinementEdgeForArea(9_000_000, {
        baseEdgeM: 8,
        maxTriangles: 20_000,
    });
    assert.ok(edge > 30 && edge < 40, `unexpected adaptive edge ${edge}`);
    assert.equal(surfaceRefinementEdgeForArea(1e12, { baseEdgeM: 8, maxEdgeM: 64 }), 64);
});

test('procedural point spacing respects an expected instance budget', () => {
    const area = 9_000_000;
    const chance = 0.72;
    const maxPoints = 6_000;
    const spacing = sampleSpacingForBudget(area, {
        baseSpacingM: 9.5,
        acceptanceChance: chance,
        maxPoints,
    });
    assert.ok(spacing > 30, `spacing ${spacing} did not adapt`);
    assert.ok(area * chance / (spacing * spacing) <= maxPoints + 1e-6);
    assert.equal(sampleSpacingForBudget(100, { baseSpacingM: 9.5, maxPoints }), 9.5);
});

test('render windows are centred on the moving vehicle, not the session anchor', () => {
    assert.equal(isPointWithinRenderWindow(1_050, 0, 1_000, 0, 100), true);
    assert.equal(isPointWithinRenderWindow(0, 0, 1_000, 0, 100), false);
    assert.equal(boundsIntersectRenderWindow({ minX: 1_080, maxX: 1_120, minZ: -5, maxZ: 5 }, 1_000, 0, 100), true);
    assert.equal(boundsIntersectRenderWindow({ minX: 1_200, maxX: 1_300, minZ: -5, maxZ: 5 }, 1_000, 0, 100), false);
});

test('triangle filtering keeps only retaining faces in the visible window', () => {
    const near = [990, 0, 0, 1_000, 1, 0, 1_010, 0, 0];
    const far = [0, 0, 0, 5, 1, 0, 10, 0, 0];
    assert.deepEqual(
        filterTrianglePositionsByRenderWindow([...far, ...near], 1_000, 0, 100),
        near,
    );
});

test('clipRingToWindow keeps inside rings, trims crossing ones, drops outside ones', () => {
    const square = (cx, cz, half) => [
        { x: cx - half, z: cz - half }, { x: cx + half, z: cz - half },
        { x: cx + half, z: cz + half }, { x: cx - half, z: cz + half },
    ];
    // Fully inside → unchanged points (same vertices, same order).
    assert.deepEqual(clipRingToWindow(square(0, 0, 10), 0, 0, 100), square(0, 0, 10));
    // Fully outside → empty.
    assert.deepEqual(clipRingToWindow(square(500, 500, 10), 0, 0, 100), []);
    // A giant ring around the window clips to exactly the window square —
    // the mountain-park case: 9 km² polygon, ~5 km² window share.
    const clipped = clipRingToWindow(square(0, 0, 5000), 0, 0, 100);
    assert.equal(clipped.length, 4);
    for (const point of clipped) {
        assert.equal(Math.abs(point.x), 100);
        assert.equal(Math.abs(point.z), 100);
    }
    // A ring crossing one edge is trimmed at that edge and stays a ring.
    const crossing = clipRingToWindow(
        [{ x: -50, z: -10 }, { x: 150, z: -10 }, { x: 150, z: 10 }, { x: -50, z: 10 }],
        0, 0, 100,
    );
    assert.ok(crossing.length >= 4);
    assert.ok(crossing.every((point) => point.x <= 100 + 1e-9));
    assert.ok(crossing.some((point) => point.x === 100), 'must cut at the window edge');
    // Degenerate input → empty, never a throw.
    assert.deepEqual(clipRingToWindow([{ x: 0, z: 0 }], 0, 0, 100), []);
    assert.deepEqual(clipRingToWindow(null, 0, 0, 100), []);
});
