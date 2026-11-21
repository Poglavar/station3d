import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CAMPAIGN_RAIL_DERAIL_DURATION_MS,
    campaignRailDerailFrame,
} from '../core/campaign-rail-derail.js';

test('campaign derail leaves the alignment, rolls, and settles deterministically', () => {
    const start = campaignRailDerailFrame(0);
    const middle = campaignRailDerailFrame(CAMPAIGN_RAIL_DERAIL_DURATION_MS / 2);
    const end = campaignRailDerailFrame(CAMPAIGN_RAIL_DERAIL_DURATION_MS);

    assert.deepEqual(start, {
        progress: 0,
        forwardM: 0,
        lateralM: 0,
        dropM: 0,
        rollRad: 0,
        complete: false,
    });
    assert.ok(middle.lateralM > 2);
    assert.ok(middle.dropM > 0);
    assert.ok(middle.rollRad > 0.5);
    assert.equal(end.lateralM, 4.6);
    assert.equal(end.dropM, 1.15);
    assert.ok(Math.abs(end.rollRad - 76 * Math.PI / 180) < 1e-12);
    assert.equal(end.complete, true);
});

test('campaign derail can roll to the opposite side and clamps past its duration', () => {
    const frame = campaignRailDerailFrame(99_000, {
        durationMs: 1200,
        side: -1,
        forwardM: 24,
        lateralM: 3,
        dropM: 0.8,
        rollDeg: 60,
    });
    assert.equal(frame.progress, 1);
    assert.equal(frame.forwardM, 24);
    assert.equal(frame.lateralM, -3);
    assert.equal(frame.dropM, 0.8);
    assert.ok(frame.rollRad < 0);
    assert.equal(frame.complete, true);
});

test('campaign derail can hold for the cab-view blast before moving into the gap', () => {
    const held = campaignRailDerailFrame(1499, {
        startDelayMs: 1500,
        durationMs: 5000,
        forwardM: 55,
    });
    const moving = campaignRailDerailFrame(3000, {
        startDelayMs: 1500,
        durationMs: 5000,
        forwardM: 55,
    });
    assert.deepEqual(held, {
        progress: 0,
        forwardM: 0,
        lateralM: 0,
        dropM: 0,
        rollRad: 0,
        complete: false,
    });
    assert.ok(moving.forwardM > 0 && moving.forwardM < 55);
    assert.ok(moving.lateralM > 0);
});
