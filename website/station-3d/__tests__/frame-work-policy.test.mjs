// Verifies motion classification and adaptive budgets without browser timing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    adaptiveFrameWorkBudget,
    createObserverMotionTracker,
    resolveFrameWorkSchedulerMode,
} from '../core/frame-work-policy.js';

function sampleSpeed(speedMps, fps, seconds = 1) {
    let clock = 0;
    const tracker = createObserverMotionTracker({ now: () => clock });
    tracker.note(0, 0);
    const frames = Math.round(fps * seconds);
    for (let frame = 1; frame <= frames; frame++) {
        clock = frame * 1000 / fps;
        tracker.note(speedMps * clock / 1000, 0);
    }
    return { tracker, clock };
}

test('classifies the same speeds independently of render frequency', () => {
    for (const fps of [15, 30, 60, 120]) {
        assert.equal(sampleSpeed(1.8, fps).tracker.snapshot().state, 'slow', `${fps} fps walk`);
        assert.equal(sampleSpeed(14, fps).tracker.snapshot().state, 'transit', `${fps} fps tram`);
        assert.equal(sampleSpeed(25, fps).tracker.snapshot().state, 'transit', `${fps} fps fast walk`);
        assert.equal(sampleSpeed(75, fps).tracker.snapshot().state, 'fast', `${fps} fps boost`);
    }
});

test('settles to stationary within 500 ms after movement stops', () => {
    const { tracker, clock: movingUntil } = sampleSpeed(25, 60);
    let clock = movingUntil;
    const stoppedX = tracker.snapshot().x;
    for (let frame = 1; frame <= 30; frame++) {
        clock = movingUntil + frame * 1000 / 60;
        tracker.note(stoppedX, 0, { atMs: clock });
    }
    assert.equal(tracker.snapshot().state, 'stationary');
    assert.equal(tracker.snapshot().speedMps, 0);
});

test('stops and camera turns both retain interactive headroom protection', () => {
    const active = adaptiveFrameWorkBudget({ motionState: 'stationary', viewMoving: true, previousFrameMs: 40 });
    assert.equal(active.motionState, 'slow');
    assert.equal(active.totalBudgetMs, 0.5);
    assert.equal(active.classBudgets.near, 6);
    assert.equal(adaptiveFrameWorkBudget({ motionState: 'stationary', previousFrameMs: 40 }).totalBudgetMs, 0.5);
    assert.deepEqual(
        adaptiveFrameWorkBudget({ motionState: 'transit', viewMoving: true }),
        adaptiveFrameWorkBudget({ motionState: 'transit' }),
    );
});

test('treats teleports, long pauses, and invalid samples as resets', () => {
    const tracker = createObserverMotionTracker();
    tracker.note(0, 0, { atMs: 0 });
    tracker.note(10, 0, { atMs: 100 });
    assert.notEqual(tracker.snapshot().state, 'stationary');

    tracker.note(500, 0, { atMs: 200 });
    assert.equal(tracker.snapshot().state, 'stationary');
    assert.equal(tracker.snapshot().speedMps, 0);

    tracker.note(510, 0, { atMs: 1500 });
    assert.equal(tracker.snapshot().state, 'stationary');

    tracker.note(Number.NaN, 0, { atMs: 1600 });
    assert.equal(tracker.snapshot().state, 'stationary');
    assert.equal(Number.isNaN(tracker.snapshot().x), true);
});

test('assigns interactive budgets and preserves bounded progress under load', () => {
    assert.deepEqual(
        adaptiveFrameWorkBudget({ motionState: 'stationary', previousFrameMs: 10 }),
        {
            phase: 'interactive',
            motionState: 'stationary',
            classBudgets: {
                delivery: 1,
                near: 6,
                simulation: 0.5,
                far: 2,
                orientation: 0.5,
            },
            configuredTotalMs: 10,
            totalBudgetMs: 10,
            frameCeilingMs: 25,
        },
    );
    const transit = adaptiveFrameWorkBudget({
        motionState: 'transit',
        previousFrameMs: 24.9,
    });
    assert.equal(transit.classBudgets.near, 4);
    assert.equal(transit.classBudgets.far, 0);
    assert.equal(transit.totalBudgetMs, 0.25);
    assert.equal(transit.frameCeilingMs, 25);

    const overloadedStationary = adaptiveFrameWorkBudget({
        motionState: 'stationary',
        previousFrameMs: 40,
    });
    assert.equal(
        overloadedStationary.totalBudgetMs,
        0.5,
        'a tram stop is interactive, not an unconditional catch-up window',
    );

    const fast = adaptiveFrameWorkBudget({ motionState: 'fast' });
    assert.equal(fast.classBudgets.near, 4);
    assert.equal(fast.classBudgets.delivery, 0.5);
    assert.equal(fast.totalBudgetMs, 5.25);

    const overloadedFast = adaptiveFrameWorkBudget({
        motionState: 'fast',
        previousFrameMs: 40,
    });
    assert.equal(overloadedFast.totalBudgetMs, 2.5);
    assert.ok(overloadedFast.classBudgets.near > 0);
});

test('only an explicit opaque loading hold gets the larger catch-up allowance', () => {
    for (const motionState of ['stationary', 'slow', 'transit', 'fast']) {
        const budget = adaptiveFrameWorkBudget({
            loading: true, motionState, viewMoving: true, previousFrameMs: 60,
        });
        assert.equal(budget.phase, 'loading');
        assert.equal(budget.totalBudgetMs, 40);
        assert.equal(budget.classBudgets.near, 48);
    }
    assert.equal(adaptiveFrameWorkBudget({ previousFrameMs: 60 }).phase, 'interactive');
    assert.equal(adaptiveFrameWorkBudget({ motionState: 'slow' }).classBudgets.near, 6,
        'the curtain allowance must not increase the gameplay budget');
});

test('scene CPU load produces the same allowance across render frequencies', () => {
    const budgets = [30, 40, 60, 120].map((fps) => adaptiveFrameWorkBudget({
        motionState: 'stationary', previousFrameMs: 1000 / fps, sceneWorkMs: 12,
    }));
    assert.equal(new Set(budgets.map((budget) => budget.totalBudgetMs)).size, 1);
});

test('actual scene load preserves minimum progress and loading headroom', () => {
    assert.equal(adaptiveFrameWorkBudget({ motionState: 'stationary', previousFrameMs: 40, sceneWorkMs: 12 }).totalBudgetMs, 10);
    assert.equal(adaptiveFrameWorkBudget({ motionState: 'stationary', previousFrameMs: 40, sceneWorkMs: 40 }).totalBudgetMs, 0.5);
    assert.ok(adaptiveFrameWorkBudget({ loading: true, sceneWorkMs: 40 }).totalBudgetMs >= 40);
    for (const sceneWorkMs of [null, -1, Number.NaN]) {
        const budget = adaptiveFrameWorkBudget({ motionState: 'stationary', previousFrameMs: 40, sceneWorkMs });
        assert.equal(budget.totalBudgetMs, 0.5);
    }
});

test('uses adaptive by default and accepts only the explicit legacy override', () => {
    assert.equal(resolveFrameWorkSchedulerMode(''), 'adaptive');
    assert.equal(resolveFrameWorkSchedulerMode('?streamScheduler=adaptive'), 'adaptive');
    assert.equal(resolveFrameWorkSchedulerMode('?streamScheduler=legacy'), 'legacy');
    assert.equal(resolveFrameWorkSchedulerMode('?streamScheduler=unknown'), 'adaptive');
});
