import assert from 'node:assert/strict';
import test from 'node:test';

import {
    advanceCampaignMotionTimers,
    createCampaignMotionTimerState,
} from '../core/campaign-motion-timers.js';

const timer = {
    id: 'split-driving-minute',
    durationMs: 60_000,
    requiresController: 'rail',
    requiresVehicleId: 'split-waiting-hz-7022',
    requiresControlling: true,
    minSpeedMps: 0.4,
    unlessFlag: 'split-route-chosen',
};

function snapshot(overrides = {}) {
    return {
        paused: false,
        controllerId: 'rail',
        vehicleId: 'split-waiting-hz-7022',
        occupantState: 'controlling',
        speedMps: 8,
        ...overrides,
    };
}

test('the Split prompt fires once after sixty seconds of active driving', () => {
    const state = createCampaignMotionTimerState();
    let events = [];
    for (let second = 0; second <= 60; second += 1) {
        events.push(...advanceCampaignMotionTimers(state, [timer], {
            nowMs: second * 1000,
            snapshot: snapshot(),
            run: { flags: {} },
        }));
    }
    assert.deepEqual(events, [{
        type: 'timer:elapsed',
        timerId: 'split-driving-minute',
        elapsedMs: 60_000,
    }]);
    assert.deepEqual(advanceCampaignMotionTimers(state, [timer], {
        nowMs: 61_000,
        snapshot: snapshot(),
        run: { flags: {} },
    }), []);
});

test('stops, pauses, walking and an answered prompt do not advance it', () => {
    const state = createCampaignMotionTimerState();
    advanceCampaignMotionTimers(state, [timer], {
        nowMs: 0,
        snapshot: snapshot(),
        run: { flags: {} },
    });
    for (const [nowMs, nextSnapshot, flags] of [
        [10_000, snapshot({ speedMps: 0 }), {}],
        [20_000, snapshot({ paused: true }), {}],
        [30_000, snapshot({ controllerId: 'foot', occupantState: 'on-foot' }), {}],
        [40_000, snapshot(), { 'split-route-chosen': true }],
    ]) {
        assert.deepEqual(advanceCampaignMotionTimers(state, [timer], {
            nowMs,
            snapshot: nextSnapshot,
            run: { flags },
        }), []);
    }
    assert.equal(state.elapsedById.get(timer.id) || 0, 0);
});
