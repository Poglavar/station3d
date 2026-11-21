// Verifies render-clock failure-card delay, cancellation, and frame-owner safety.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFailurePresentationDelay } from '../core/campaign-failure-presentation.js';

test('failure presentation delay reveals on bounded render time and cancels its frame owner', () => {
    let frame = null;
    let revealed = 0;
    const owner = handler => { frame = handler; return true; };
    const delay = createFailurePresentationDelay({ delayMs: 1800, setFrameHandler: owner, reveal: () => { revealed++; }, now: () => 0 });
    assert.ok(delay);
    for (let nowMs = 50; nowMs <= 1000; nowMs += 50) frame({ nowMs });
    assert.equal(revealed, 0);
    for (let nowMs = 1050; nowMs <= 1800; nowMs += 50) frame({ nowMs });
    assert.equal(revealed, 1);
    assert.equal(frame, null, 'frame owner is released after reveal');
});

test('failure presentation delay cancels on replacement and reveals immediately without a frame owner', () => {
    let frame = null;
    let revealed = 0;
    const delay = createFailurePresentationDelay({ delayMs: 3000, setFrameHandler: handler => { frame = handler; return true; }, reveal: () => { revealed++; }, now: () => 0 });
    const cancelledFrame = frame;
    delay.cancel();
    assert.equal(frame, null);
    frame = () => 'newer-owner';
    cancelledFrame({ nowMs: 3000 });
    assert.equal(frame(), 'newer-owner', 'late cancelled callback cannot clear a replacement owner');
    assert.equal(revealed, 0);
    let fallbackFrame = null;
    let installedFallback = null;
    const immediate = createFailurePresentationDelay({
        delayMs: 99999,
        setFrameHandler: handler => {
            fallbackFrame = handler;
            if (handler) installedFallback = handler;
            return false;
        },
        reveal: () => { revealed++; },
        now: () => 0,
    });
    assert.equal(immediate, null);
    assert.equal(revealed, 1, 'unavailable frame owner never leaves an invisible failure card');
    frame = () => 'newer-owner-after-fallback';
    assert.equal(fallbackFrame, null, 'fallback clears a partially installed handler');
    installedFallback({ nowMs: 3000 });
    assert.equal(frame(), 'newer-owner-after-fallback', 'late fallback callback cannot reveal or clear a newer owner');
});
