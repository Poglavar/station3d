// Locks deterministic weighted traffic selection, including the low-frequency
// van/truck tail and exclusion of special zero-weight vehicles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseWeighted } from '../core/weighted-choice.js';

const types = [
    { name: 'car', weight: 5 },
    { name: 'van', weight: 2 },
    { name: 'truck', weight: 1 },
    { name: 'special', weight: 0 },
];

test('weighted choice reaches vans and trucks without selecting zero-weight types', () => {
    assert.equal(chooseWeighted(types, 0).name, 'car');
    assert.equal(chooseWeighted(types, 0.7).name, 'van');
    assert.equal(chooseWeighted(types, 0.99).name, 'truck');
    assert.notEqual(chooseWeighted(types, 1).name, 'special');
});

test('weighted choice returns null for an empty effective population', () => {
    assert.equal(chooseWeighted([{ name: 'off', weight: 0 }], 0.5), null);
});
