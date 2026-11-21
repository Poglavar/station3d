// Locks the bounded unindexed-buffer ranges used for rail dressing uploads.

import assert from 'node:assert/strict';
import test from 'node:test';

import { trianglePositionChunkRanges } from '../core/triangle-geometry-chunks.js';

test('triangle upload ranges are bounded, contiguous, and preserve UV alignment', () => {
    const ranges = trianglePositionChunkRanges(9 * 11 + 4, { maxVertices: 9 });
    assert.equal(ranges.length, 4);
    assert.deepEqual(ranges[0], {
        positionStart: 0,
        positionEnd: 27,
        uvStart: 0,
        uvEnd: 18,
    });
    assert.equal(ranges.at(-1).positionEnd, 9 * 11,
        'an incomplete trailing position must never become a partial triangle');
    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index];
        assert.ok((range.positionEnd - range.positionStart) / 3 <= 9);
        assert.equal(range.positionStart % 9, 0);
        assert.equal(range.positionEnd % 9, 0);
        assert.equal(range.uvStart, range.positionStart / 3 * 2);
        assert.equal(range.uvEnd, range.positionEnd / 3 * 2);
        if (index > 0) assert.equal(ranges[index - 1].positionEnd, range.positionStart);
    }
});

test('empty and invalid triangle buffers produce no upload ranges', () => {
    assert.deepEqual(trianglePositionChunkRanges(0), []);
    assert.deepEqual(trianglePositionChunkRanges(8), []);
    assert.deepEqual(trianglePositionChunkRanges(null), []);
});
