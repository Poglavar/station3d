import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointSkipAllowed, resolveCheckpointStart } from '../core/campaign-checkpoint-access.js';

const ORDER = ['a', 'b', 'c', 'd'];

test('a checkpoint link only reopens what the run has already reached', () => {
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'b', order: ORDER, savedCheckpointId: 'c' }), { action: 'checkpoint', reason: 'reached' });
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'c', order: ORDER, savedCheckpointId: 'c' }), { action: 'checkpoint', reason: 'reached' });
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'd', order: ORDER, savedCheckpointId: 'c' }), { action: 'continue', reason: 'not-reached' });
});

test('without a run only the beginning is linkable; a finished run may revisit anything', () => {
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'a', order: ORDER }), { action: 'checkpoint', reason: 'beginning' });
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'c', order: ORDER }), { action: 'start', reason: 'not-reached' });
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'd', order: ORDER, savedCheckpointId: 'a', savedCompleted: true }), { action: 'checkpoint', reason: 'completed' });
});

test('skipping ahead is a debugging act: local host or an explicit flag', () => {
    assert.equal(checkpointSkipAllowed({ hostname: 'localhost' }), true);
    assert.equal(checkpointSkipAllowed({ hostname: '127.0.0.1' }), true);
    assert.equal(checkpointSkipAllowed({ hostname: 'zagreb.lol' }), false);
    assert.equal(checkpointSkipAllowed({ hostname: 'zagreb.lol', search: '?lang=hr&campaignDebug=1' }), true);
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'd', order: ORDER, savedCheckpointId: 'a', allowSkip: true }), { action: 'checkpoint', reason: 'debug' });
    // An id outside the story order is not this module's to judge.
    assert.deepEqual(resolveCheckpointStart({ requestedId: 'zzz', order: ORDER, savedCheckpointId: 'a' }), { action: 'checkpoint', reason: 'unknown-order' });
});
