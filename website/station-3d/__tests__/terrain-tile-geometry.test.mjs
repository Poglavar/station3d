// Verifies cooperative terrain mesh construction independently of Three.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainTileGeometryTask } from '../core/terrain-tile-geometry.js';

test('terrain geometry construction stops cleanly between rows', () => {
    const task = createTerrainTileGeometryTask({
        tileX: 1,
        tileZ: -1,
        tileM: 4,
        segments: 2,
        uvPerM: 0.25,
        sceneYAtLocal: (x, z) => x + z * 2,
        normalAtLocal: () => ({ x: 0, y: 1, z: 0 }),
    });

    assert.equal(task.step(1), false);
    assert.deepEqual(task.progress(), {
        vertexRows: 1,
        vertexRowCount: 3,
        indexRows: 0,
        indexRowCount: 2,
    });
    assert.throws(() => task.result(), /not complete/);
    assert.equal(task.step(2), false, 'vertex completion remains a safe yield point');
    assert.deepEqual(task.progress(), {
        vertexRows: 3,
        vertexRowCount: 3,
        indexRows: 0,
        indexRowCount: 2,
    });
    assert.equal(task.step(1), false);
    assert.equal(task.step(1), true);

    const geometry = task.result();
    assert.deepEqual([...geometry.positions], [
        4, -4, -4, 6, -2, -4, 8, 0, -4,
        4, 0, -2, 6, 2, -2, 8, 4, -2,
        4, 4, 0, 6, 6, 0, 8, 8, 0,
    ]);
    assert.deepEqual([...geometry.uvs], [
        1, -1, 1.5, -1, 2, -1,
        1, -0.5, 1.5, -0.5, 2, -0.5,
        1, 0, 1.5, 0, 2, 0,
    ]);
    assert.deepEqual([...geometry.indices], [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5,
        3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
    assert.deepEqual(geometry.bounds, {
        minX: 4,
        minY: -4,
        minZ: -4,
        maxX: 8,
        maxY: 8,
        maxZ: 0,
    });
});

test('an unlimited step preserves the synchronous loading-gate path', () => {
    const task = createTerrainTileGeometryTask({
        tileX: 0,
        tileZ: 0,
        tileM: 20,
        segments: 1,
        uvPerM: 1,
        sceneYAtLocal: () => 3,
        normalAtLocal: () => ({ x: 0, y: 1, z: 0 }),
    });
    assert.equal(task.step(Infinity), true);
    assert.equal(task.result().positions.length, 12);
});
