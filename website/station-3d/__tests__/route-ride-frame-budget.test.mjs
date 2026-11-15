// A train ride gets a larger near slice and some far work at transit and fast speed, so
// its surroundings keep up; car driving, stops, loading and bakes keep their own budgets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveFrameWorkBudget } from '../core/frame-work-policy.js';

const budget = (options) => adaptiveFrameWorkBudget({ sceneWorkMs: 5, ...options }).classBudgets;

test('a moving train ride builds near and far more than a car at the same speed', () => {
    for (const motionState of ['transit', 'fast']) {
        const ride = budget({ motionState, routeRide: true });
        const car = budget({ motionState });
        assert.equal(ride.near, 8);
        assert.equal(ride.far, 1);
        assert.equal(car.near, 4);
        assert.equal(car.far, 0);
        assert.equal(ride.delivery, car.delivery);
    }
});

test('a train at a stop, loading, or a bake is unaffected by the ride flag', () => {
    for (const motionState of ['stationary', 'slow']) {
        assert.deepEqual(budget({ motionState, routeRide: true }), budget({ motionState }));
    }
    assert.deepEqual(budget({ motionState: 'transit', routeRide: true, loading: true }), budget({ motionState: 'transit', loading: true }));
    assert.deepEqual(budget({ motionState: 'transit', routeRide: true, offlineCompile: true }),
        budget({ motionState: 'transit', offlineCompile: true }));
});

test('the frame ceiling still bounds the ride budget', () => {
    const tight = adaptiveFrameWorkBudget({ motionState: 'transit', routeRide: true, sceneWorkMs: 22 });
    assert.ok(tight.totalBudgetMs <= 25 - 22 + 1e-9);
});
