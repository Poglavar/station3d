import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleStripGeometry,
    createStripGeometryCache,
} from '../core/strip-geometry-cache.js';

test('strip cache retains and assembles receiver-projected triangle entries', () => {
    const cache = createStripGeometryCache();
    const points = [{ x: 0, z: 0 }, { x: 1, z: 1 }];
    cache.beginPass('receiver');
    const entry = cache.store('marking:receiver1', points, {
        positions: [0, 0.002, 0, 1, 1.002, 0, 0, 0.002, 1],
        uvs: [0, 0, 1, 0, 0, 1],
        indices: [0, 2, 1],
    });
    assert.equal(cache.retain('marking:receiver1', points), entry);

    const assembled = assembleStripGeometry([entry]);
    assert.equal(assembled.positions.length, 9);
    assert.ok(Math.abs(assembled.positions[1] - 0.002) < 1e-6);
    assert.ok(Math.abs(assembled.positions[4] - 1.002) < 1e-6);
    assert.deepEqual([...assembled.uvs], [0, 0, 1, 0, 0, 1]);
    assert.deepEqual([...assembled.indices], [0, 2, 1]);
    assert.equal(assembled.vertexCount, 3);
});

test('legacy quad entries still receive generated indices', () => {
    const cache = createStripGeometryCache();
    const points = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    cache.beginPass('legacy');
    const entry = cache.store('legacy', points, {
        positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        quads: 1,
    });
    assert.deepEqual([...assembleStripGeometry([entry]).indices], [0, 1, 2, 0, 2, 3]);
});
