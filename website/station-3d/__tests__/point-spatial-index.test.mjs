// Verifies the allocation-stable point broad phase used by moving traffic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointSpatialIndex } from '../core/point-spatial-index.js';

test('queries positive and negative cells without returning distant points', () => {
    const index = createPointSpatialIndex(10);
    index.add('near-a', -0.1, 0.1);
    index.add('near-b', 9.9, 9.9);
    index.add('far', 100, 100);
    const found = [];

    index.forEachInBounds(-1, -1, 10, 10, item => {
        found.push(item);
        return false;
    });

    assert.deepEqual(found.sort(), ['near-a', 'near-b']);
});

test('clear permits a complete rebuild and bounded queries can stop early', () => {
    const index = createPointSpatialIndex(10);
    index.add('old', 0, 0);
    index.clear();
    index.add('new-a', 0, 0);
    index.add('new-b', 1, 1);
    const found = [];

    const stopped = index.forEachInBounds(-2, -2, 2, 2, item => {
        found.push(item);
        return true;
    });

    assert.equal(stopped, true);
    assert.equal(found.length, 1);
    assert.notEqual(found[0], 'old');
});
