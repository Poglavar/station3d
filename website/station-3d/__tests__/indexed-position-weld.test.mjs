import test from 'node:test';
import assert from 'node:assert/strict';

import { weldIndexedPositions } from '../core/indexed-position-weld.js';

test('welds repeated indexed positions once and remaps every triangle reference', () => {
    const positions = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 0, 0,
        1, 1, 0,
        0, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);

    const welded = weldIndexedPositions(positions, indices);

    assert.equal(welded.sourceVertexCount, 6);
    assert.equal(welded.weldedVertexCount, 4);
    assert.deepEqual([...welded.positions], [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 1, 0,
    ]);
    assert.deepEqual([...welded.indices], [0, 1, 2, 1, 3, 2]);
    assert.ok(welded.indices instanceof Uint16Array);
});

test('uses the requested tolerance while preserving the source buffers', () => {
    const positions = new Float32Array([
        0, 0, 0,
        1.00001, 2, 3,
        1.00004, 2, 3,
    ]);
    const indices = new Uint16Array([0, 1, 2]);
    const originalPositions = positions.slice();
    const originalIndices = indices.slice();

    const welded = weldIndexedPositions(positions, indices, 1e-4);

    assert.equal(welded.weldedVertexCount, 2);
    assert.deepEqual([...welded.indices], [0, 1, 1]);
    assert.deepEqual(positions, originalPositions);
    assert.deepEqual(indices, originalIndices);
});

test('rejects malformed buffers and out-of-range indices', () => {
    assert.throws(
        () => weldIndexedPositions(new Float32Array([0, 1]), new Uint16Array()),
        /complete xyz triples/,
    );
    assert.throws(
        () => weldIndexedPositions(
            new Float32Array([0, 0, 0]),
            new Uint16Array([1]),
        ),
        /outside the position buffer/,
    );
});
