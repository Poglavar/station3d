// Locks controller-specific keyboard normalisation into semantic actions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { semanticActionForKey, SESSION_ACTIONS } from '../core/semantic-actions.js';

test('the same physical keys route through controller-specific actions', () => {
    assert.equal(semanticActionForKey('w', 'foot'), 'move-forward');
    assert.equal(semanticActionForKey('w', 'road'), 'throttle');
    assert.equal(semanticActionForKey('a', 'rail'), 'rail-turn-left');
    assert.equal(semanticActionForKey('w', 'aircraft'), 'aircraft-pitch-down');
    assert.equal(semanticActionForKey(' ', 'aircraft'), 'aircraft-throttle-up');
    assert.equal(semanticActionForKey('e', 'boat'), 'interact');
});


test('Space requests the existing boat Stop action without changing road or flight controls', () => {
    assert.equal(semanticActionForKey(' ', 'boat'), SESSION_ACTIONS.STOP);
    assert.equal(semanticActionForKey('b', 'boat'), SESSION_ACTIONS.STOP);
    assert.equal(semanticActionForKey(' ', 'road'), null);
    assert.notEqual(semanticActionForKey(' ', 'aircraft'), SESSION_ACTIONS.STOP);
});
