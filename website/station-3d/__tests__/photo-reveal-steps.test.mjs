// The photo world's loading-screen steps follow photoreal.js's sequential reveal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHOTO_REVEAL_STEP_KEYS, photoRevealSteps } from '../core/photo-reveal-steps.js';

test('nothing loaded: the first step is current and none are counted', () => {
    const state = photoRevealSteps({});
    assert.equal(state.current, 'photoTiles');
    assert.equal(state.doneCount, 0);
    assert.equal(state.total, PHOTO_REVEAL_STEP_KEYS.length);
});

test('steps finish in order and name the one being waited on', () => {
    assert.equal(photoRevealSteps({ streaming: true }).current, 'photoGround');
    const seated = photoRevealSteps({ streaming: true, grounded: true });
    assert.deepEqual([seated.current, seated.doneCount], ['photoCorridor', 2]);
    const walls = photoRevealSteps({ streaming: true, grounded: true, maskReady: true, wallsBuilt: true });
    assert.deepEqual([walls.current, walls.doneCount], ['photoRefine', 4]);
    const shown = photoRevealSteps({ streaming: true, grounded: true, maskReady: true, wallsBuilt: true, revealed: true });
    assert.deepEqual([shown.current, shown.doneCount], [null, 5]);
});

test('a later flag never counts past an unfinished earlier step', () => {
    // A corridor mask left from the previous position while the world re-seats.
    const state = photoRevealSteps({ streaming: true, grounded: false, maskReady: true, wallsBuilt: true });
    assert.deepEqual([state.current, state.doneCount], ['photoGround', 1]);
});

test('without carving, the corridor and civil steps are not waited on', () => {
    const state = photoRevealSteps({ streaming: true, grounded: true, carve: false });
    assert.deepEqual([state.current, state.doneCount], ['photoRefine', 4]);
});

test('a revealed world counts every step, whatever the other flags say', () => {
    assert.equal(photoRevealSteps({ revealed: true }).doneCount, PHOTO_REVEAL_STEP_KEYS.length);
});
