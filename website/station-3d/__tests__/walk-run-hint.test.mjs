import assert from 'node:assert/strict';
import test from 'node:test';

import {
    RUN_HINT_EVERY_S,
    RUN_HINT_FIRST_AFTER_S,
    RUN_HINT_LEARNED_AFTER_S,
    advanceRunHint,
    createRunHintState,
} from '../core/walk-run-hint.js';

function walk(state, seconds, { boosted = false, moving = true, dt = 0.1 } = {}) {
    const shownAt = [];
    for (let t = 0; t < seconds; t += dt) {
        if (advanceRunHint(state, { dt, moving, boosted })) shownAt.push(Number((t + dt).toFixed(1)));
    }
    return shownAt;
}

test('the first hint comes after a few seconds of walking, then every half minute', () => {
    const state = createRunHintState();
    const shownAt = walk(state, 70);
    assert.equal(shownAt.length, 3);
    assert.ok(Math.abs(shownAt[0] - RUN_HINT_FIRST_AFTER_S) < 0.2);
    assert.ok(Math.abs(shownAt[1] - shownAt[0] - RUN_HINT_EVERY_S) < 0.2);
});

test('standing still counts for nothing', () => {
    const state = createRunHintState();
    assert.deepEqual(walk(state, 60, { moving: false }), []);
    assert.equal(state.walkedS, 0);
});

test('running for a few seconds ends the hints for good', () => {
    const state = createRunHintState();
    walk(state, 3);
    assert.deepEqual(walk(state, RUN_HINT_LEARNED_AFTER_S + 0.5, { boosted: true }), []);
    assert.equal(state.learned, true);
    assert.deepEqual(walk(state, 120), []);
});

test('a short burst of running does not reset the walking clock', () => {
    const state = createRunHintState();
    walk(state, 4);
    walk(state, 1, { boosted: true });
    const shownAt = walk(state, 3);
    assert.equal(shownAt.length, 1);
});
