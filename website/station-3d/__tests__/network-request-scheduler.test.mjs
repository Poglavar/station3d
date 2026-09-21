// Verifies the Station3D network arbiter enforces one global cap while
// retaining source caps, live camera reprioritization, and queued cancellation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createNetworkRequestScheduler,
    NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT,
} from '../core/network-request-scheduler.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function nextTurn() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

test('the default cap matches the HTTP/1.1 per-origin transport ceiling', () => {
    const scheduler = createNetworkRequestScheduler();
    assert.equal(NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT, 6);
    assert.equal(scheduler.getDebugState().maxConcurrentRequests, 6);
    scheduler.dispose();
});

test('chooses the highest camera priority registered in the startup fan-out', async () => {
    const scheduler = createNetworkRequestScheduler({ maxConcurrentRequests: 1 });
    const order = [];
    const hidden = scheduler.schedule({
        label: 'hidden',
        priority: { tier: 'hidden', score: 1e12 },
        run: () => { order.push('hidden'); },
    });
    const support = scheduler.schedule({
        label: 'support',
        priority: { tier: 'support', score: 4e12 },
        run: () => { order.push('support'); },
    });

    await Promise.all([hidden, support]);
    assert.deepEqual(order, ['support', 'hidden']);
    scheduler.dispose();
});

test('enforces one global limit and a narrower per-source limit', async () => {
    const scheduler = createNetworkRequestScheduler({ maxConcurrentRequests: 3 });
    const gates = Array.from({ length: 6 }, deferred);
    let active = 0;
    let maximumActive = 0;
    let sourceAActive = 0;
    let maximumSourceAActive = 0;
    const jobs = gates.map((gate, index) => scheduler.schedule({
        label: `job-${index}`,
        groupKey: index < 4 ? 'source-a' : 'source-b',
        groupLimit: index < 4 ? 1 : 3,
        priority: { tier: 'visible', score: 3e12 - index },
        run: async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (index < 4) {
                sourceAActive += 1;
                maximumSourceAActive = Math.max(maximumSourceAActive, sourceAActive);
            }
            await gate.promise;
            if (index < 4) sourceAActive -= 1;
            active -= 1;
        },
    }));

    await nextTurn();
    assert.equal(scheduler.getDebugState().active, 3);
    gates.forEach(gate => gate.resolve());
    await Promise.all(jobs);
    assert.equal(maximumActive, 3);
    assert.equal(maximumSourceAActive, 1);
    scheduler.dispose();
});

test('admits exactly one support request beyond a saturated global cap', async () => {
    const scheduler = createNetworkRequestScheduler({ maxConcurrentRequests: 1 });
    const blocker = deferred();
    const firstSupportGate = deferred();
    const order = [];
    const running = scheduler.schedule({
        label: 'terrain-dependent-build',
        run: () => blocker.promise,
    });
    const firstSupport = scheduler.schedule({
        label: 'terrain-support-1',
        supportLane: true,
        run: async () => {
            order.push('support-1');
            await firstSupportGate.promise;
        },
    });
    const secondSupport = scheduler.schedule({
        label: 'terrain-support-2',
        supportLane: true,
        run: () => { order.push('support-2'); },
    });

    await nextTurn();
    assert.deepEqual(order, ['support-1']);
    assert.equal(scheduler.getDebugState().active, 2);
    assert.equal(scheduler.getDebugState().supportOverflowActive, 1);

    firstSupportGate.resolve();
    await firstSupport;
    await nextTurn();
    assert.deepEqual(order, ['support-1', 'support-2']);
    await secondSupport;
    blocker.resolve();
    await running;
    await nextTurn();
    assert.equal(scheduler.getDebugState().active, 0);
    scheduler.dispose();
});

test('re-evaluates queued priorities after the camera view changes', async () => {
    const scheduler = createNetworkRequestScheduler({ maxConcurrentRequests: 1 });
    const blocker = deferred();
    const order = [];
    let firstScore = 10;
    let secondScore = 20;
    const running = scheduler.schedule({
        label: 'blocker',
        priority: { tier: 'critical', score: 5e12 },
        run: () => blocker.promise,
    });
    const first = scheduler.schedule({
        label: 'first',
        priority: () => ({ tier: 'visible', score: firstScore }),
        run: () => { order.push('first'); },
    });
    const second = scheduler.schedule({
        label: 'second',
        priority: () => ({ tier: 'visible', score: secondScore }),
        run: () => { order.push('second'); },
    });

    await nextTurn();
    firstScore = 100;
    secondScore = 0;
    blocker.resolve();
    await Promise.all([running, first, second]);
    assert.deepEqual(order, ['first', 'second']);
    scheduler.dispose();
});

test('removes an aborted request before it consumes a slot', async () => {
    const scheduler = createNetworkRequestScheduler({ maxConcurrentRequests: 1 });
    const blocker = deferred();
    const controller = new AbortController();
    let cancelledRan = false;
    const running = scheduler.schedule({
        priority: { tier: 'critical', score: 5e12 },
        run: () => blocker.promise,
    });
    const cancelled = scheduler.schedule({
        signal: controller.signal,
        priority: { tier: 'support', score: 4e12 },
        run: () => { cancelledRan = true; },
    });
    controller.abort();
    await assert.rejects(cancelled, error => error?.name === 'AbortError');
    blocker.resolve();
    await running;
    assert.equal(cancelledRan, false);
    assert.equal(scheduler.getDebugState().queued, 0);
    scheduler.dispose();
});
