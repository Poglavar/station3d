import test from 'node:test';
import assert from 'node:assert/strict';

import { initialGroundSupportReady } from '../core/initial-world-support.js';

test('initial ground readiness accepts worlds without a ground coordinator', () => {
    assert.equal(initialGroundSupportReady(null), true);
});

test('initial ground readiness rejects an obsolete published predecessor', () => {
    const groundGenerations = {
        isSettled: () => false,
        snapshot: () => ({ published: 1, pending: 3 }),
    };

    assert.equal(initialGroundSupportReady(groundGenerations), false);
});

test('initial ground readiness accepts the current settled generation', () => {
    const groundGenerations = {
        isSettled: () => true,
        snapshot: () => ({ published: 2, pending: 0 }),
    };

    assert.equal(initialGroundSupportReady(groundGenerations), true);
});
