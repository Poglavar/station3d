import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficGraphOwnership } from '../core/traffic-graph-ownership.js';

test('a source shared by two tiles retires only after its last owner leaves', () => {
    const retired = [];
    const ownership = createTrafficGraphOwnership({ onRetire: id => retired.push(id) });
    assert.equal(ownership.claim('0_0', 42), true);
    assert.equal(ownership.claim('1_0', 42), false);
    ownership.releaseTile('0_0');
    assert.deepEqual(retired, []);
    ownership.releaseTile('1_0');
    assert.deepEqual(retired, [42]);
});

test('a live car defers retirement until its graph reference is released', () => {
    const retained = new Set([7]);
    const retired = [];
    const ownership = createTrafficGraphOwnership({
        isRetained: id => retained.has(id),
        onRetire: id => retired.push(id),
    });
    ownership.claim('0_0', 7);
    ownership.releaseTile('0_0');
    assert.equal(ownership.snapshot().pendingRetirement, 1);
    retained.delete(7);
    assert.equal(ownership.flush(), 1);
    assert.deepEqual(retired, [7]);
});
