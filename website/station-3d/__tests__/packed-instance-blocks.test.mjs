// Packed instance blocks: the drawn range holds only occupied instances, and removal compacts
// later blocks without disturbing their contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackedInstanceBlocks } from '../core/packed-instance-blocks.js';

function fill(array, block, stride, value) {
    for (let i = 0; i < block.length; i++) array.fill(value + i, (block.offset + i) * stride, (block.offset + i + 1) * stride);
}

test('blocks pack contiguously and removal slides later blocks down with their contents', () => {
    const stride = 2;
    const blocks = createPackedInstanceBlocks({ capacity: 10, stride });
    const array = new Float32Array(10 * stride);
    const a = blocks.append('a', 2), b = blocks.append('b', 3), c = blocks.append('c', 1);
    fill(array, a, stride, 10); fill(array, b, stride, 20); fill(array, c, stride, 30);
    assert.deepEqual([a.offset, b.offset, c.offset, blocks.used], [0, 2, 5, 6]);

    assert.equal(blocks.remove('a', [array]), true);
    assert.deepEqual([b.offset, c.offset, blocks.used, blocks.size], [0, 3, 4, 2]);
    assert.deepEqual([...array.slice(0, 4 * stride)], [20, 20, 21, 21, 22, 22, 30, 30]);
    assert.ok(array.slice(4 * stride, 6 * stride).every(v => v === 0), 'the freed tail is zeroed');

    const d = blocks.append('d', 2);
    assert.equal(d.offset, 4, 'new blocks append after the packed range');
    assert.equal(blocks.remove('missing', [array]), false);
});

test('capacity and duplicate keys are enforced', () => {
    const blocks = createPackedInstanceBlocks({ capacity: 4 });
    blocks.append('a', 4);
    assert.throws(() => blocks.append('b', 1), RangeError);
    assert.throws(() => blocks.append('a', 0), /already exists/);
    blocks.remove('a', []);
    assert.equal(blocks.append('b', 4).offset, 0);
});
