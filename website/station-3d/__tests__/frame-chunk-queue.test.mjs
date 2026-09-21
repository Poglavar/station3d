// Verifies background scene construction yields to browser movement/rendering.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
    frameChunkObserverIsMoving,
    frameChunkObserverIsSettled,
    frameChunkWorkShouldPauseForMovement,
    getFrameChunkSchedulerSnapshot,
    getFrameChunkWorkMotionState,
    noteFrameChunkObserver,
    noteFrameChunkSceneWork,
    resetFrameChunkObserver,
    resetFrameChunkSessionStatistics,
    setFrameChunkSchedulerMode,
} from '../core/frame-chunk-queue.js';
import { beginWorldBuild, _resetWorldReady } from '../core/world-ready.js';

setFrameChunkSchedulerMode('legacy');
resetFrameChunkObserver();

test('session statistics reset without disposing live queues', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    const queue = createFrameChunkQueue({ label: 'session-reset-test' });
    try {
        queue.enqueue(['first'], () => {});
        callbacks.shift()({ timeRemaining: () => 10 });
        const before = getFrameChunkSchedulerSnapshot();
        assert.equal(before.queues.find(entry => entry.label === 'session-reset-test')?.processedItems, 1);

        resetFrameChunkSessionStatistics();
        const after = getFrameChunkSchedulerSnapshot();
        assert.equal(after.lifetimeSpentTotalMs, 0);
        assert.equal(after.lifetimeFrames, 0);
        assert.equal(after.queues.find(entry => entry.label === 'session-reset-test')?.processedItems, 0);
    } finally {
        queue.dispose();
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('uses idle callbacks and waits when the browser has no spare time', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    let queue = null;

    try {
        const processed = [];
        queue = createFrameChunkQueue({ frameBudgetMs: 4 });
        queue.enqueue([1, 2], item => processed.push(item));

        assert.equal(callbacks.length, 1);
        callbacks.shift()({ timeRemaining: () => 0.5 });
        assert.deepEqual(processed, []);
        assert.equal(callbacks.length, 1);

        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2]);
    } finally {
        queue?.dispose();
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('a timed-out idle request makes time-bounded progress through cheap items', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    const options = [];
    globalThis.requestIdleCallback = (callback, requestOptions) => {
        callbacks.push(callback);
        options.push(requestOptions);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    let queue = null;

    try {
        const processed = [];
        queue = createFrameChunkQueue({ frameBudgetMs: 4 });
        queue.enqueue([1, 2], item => processed.push(item));

        assert.equal(options[0]?.timeout, 250);
        callbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
        assert.ok(processed.length >= 1, 'the timeout guarantees bounded progress');
    } finally {
        queue?.dispose();
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('urgent stationary work can use a bounded animation-frame slice', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const idleCallbacks = [];
    const frameCallbacks = [];
    globalThis.requestIdleCallback = callback => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    globalThis.requestAnimationFrame = callback => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        const processed = [];
        const queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            preferAnimationFrame: true,
        });
        queue.enqueue(['near-building'], item => processed.push(item));

        assert.equal(idleCallbacks.length, 0);
        assert.equal(frameCallbacks.length, 1);
        frameCallbacks.shift()();
        assert.deepEqual(processed, ['near-building']);
        queue.dispose();
    } finally {
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
});

test('equal-priority tile jobs rotate instead of one tile monopolizing every flush', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        const processed = [];
        const queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        queue.enqueue(['a1', 'a2'], item => processed.push(item), {
            maxItemsPerFrame: 1,
            priority: 0,
        });
        queue.enqueue(['b1', 'b2'], item => processed.push(item), {
            maxItemsPerFrame: 1,
            priority: 0,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, ['a1', 'b1']);
        queue.dispose();
    } finally {
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('a cooperative item repeats without advancing until its final stage', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const stages = [];
        let stage = 0;
        const queue = createFrameChunkQueue({
            label: 'cooperative-repeat-test',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const job = queue.enqueue(['building'], item => {
            stages.push(`${item}:${stage}`);
            stage += 1;
            return stage < 3 ? FRAME_CHUNK_REPEAT_ITEM : undefined;
        }, {
            maxItemsPerFrame: 1,
        });

        callbacks.shift()();
        assert.deepEqual(stages, ['building:0']);
        assert.equal(getFrameChunkSchedulerSnapshot().queues
            .find(entry => entry.label === 'cooperative-repeat-test')?.pendingItems, 1);
        callbacks.shift()();
        assert.deepEqual(stages, ['building:0', 'building:1']);
        callbacks.shift()();
        await job.promise;
        assert.deepEqual(stages, ['building:0', 'building:1', 'building:2']);
        queue.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
});

test('dynamic item priority selects visible work before earlier queued work', async () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        const processed = [];
        const priorities = new Map([
            ['behind', 1],
            ['visible', 10],
        ]);
        const queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        const job = queue.enqueue(['behind', 'visible'], item => processed.push(item), {
            itemPriority: item => priorities.get(item),
            reorderBetweenItems: true,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        await job.promise;
        assert.deepEqual(processed, ['visible', 'behind']);
        queue.dispose();
    } finally {
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('dynamic priority never preempts a cooperative item already in progress', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const priorities = new Map([
            ['started', 10],
            ['newly-visible', 1],
        ]);
        const processed = [];
        let startedStages = 0;
        const queue = createFrameChunkQueue({
            label: 'dynamic-item-atomic-test',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const job = queue.enqueue(['started', 'newly-visible'], item => {
            processed.push(item);
            if (item === 'started' && startedStages++ === 0) {
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            return undefined;
        }, {
            maxItemsPerFrame: 1,
            itemPriority: item => priorities.get(item),
            reorderBetweenItems: true,
        });

        callbacks.shift()();
        priorities.set('newly-visible', 100);
        callbacks.shift()();
        callbacks.shift()();
        await job.promise;
        assert.deepEqual(processed, ['started', 'started', 'newly-visible']);
        queue.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
});

test('a dependency wait defers without spinning or starving its owner', async () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        const processed = [];
        let dependencyReady = false;
        const queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        const waiter = queue.enqueue(['waiter'], item => {
            processed.push(dependencyReady ? 'waiter-ready' : 'waiter-deferred');
            return dependencyReady ? undefined : FRAME_CHUNK_DEFER_ITEM;
        }, {
            priority: 2,
        });
        const owner = queue.enqueue(['owner'], item => {
            processed.push(item);
            dependencyReady = true;
        }, {
            priority: 1,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        await Promise.all([waiter.promise, owner.promise]);
        assert.deepEqual(processed, ['waiter-deferred', 'owner', 'waiter-ready']);
        queue.dispose();
    } finally {
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('pauses construction while moving and reprioritizes after stopping', async () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        const processed = [];
        let nearPriority = 0;
        const queue = createFrameChunkQueue({ frameBudgetMs: 4 });
        queue.enqueue(['old'], item => processed.push(item), { priority: 1 });
        queue.enqueue(['near'], item => processed.push(item), {
            priority: () => nearPriority,
        });
        noteFrameChunkObserver(0, 0);
        noteFrameChunkObserver(10, 0);

        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, []);

        nearPriority = 2;
        await new Promise(resolve => setTimeout(resolve, 475));
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, ['near', 'old']);
    } finally {
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('cab motion can opt out of the walker movement gate', () => {
    noteFrameChunkObserver(0, 0);
    noteFrameChunkObserver(10, 0);
    assert.equal(frameChunkWorkShouldPauseForMovement(), true);

    noteFrameChunkObserver(20, 0, { pauseWhileMoving: false });
    assert.equal(frameChunkWorkShouldPauseForMovement(), false);
    // The opt-out lifts the PAUSE, not the fact. Eviction deferral and the
    // orientation-road hints read the fact and must still see motion.
    assert.equal(frameChunkObserverIsMoving(), true);
});

test('camera rotation keeps a stationary observer active until the view settles', () => {
    const originalPerformance = globalThis.performance;
    let clock = 0;
    globalThis.performance = { now: () => clock };
    try {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 359.9 });
        assert.equal(frameChunkObserverIsSettled(), true);

        clock = 16;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0.3 });
        assert.equal(frameChunkObserverIsMoving(), false, 'turning does not invent translation');
        assert.equal(frameChunkObserverIsSettled(), false, 'wrap-around rotation remains active');

        clock += 451;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0.3 });
        assert.equal(frameChunkObserverIsSettled(), true);
    } finally {
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
    }
});

test('adaptive rotation shares active-frame budget while preserving translation diagnostics', () => {
    const originalPerformance = globalThis.performance;
    let clock = 0;
    globalThis.performance = { now: () => clock };
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 359.9 });
        clock = 40;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0.3 });
        const active = getFrameChunkSchedulerSnapshot();
        assert.equal(active.motionState, 'stationary');
        assert.equal(active.speedMps, 0);
        assert.equal(active.observerViewMoving, true);
        assert.equal(active.workMotionState, 'slow');
        assert.equal(getFrameChunkWorkMotionState(), 'slow');
        assert.equal(active.totalBudgetMs, 0.5);
        assert.equal(frameChunkObserverIsMoving(), false);
        clock += 451;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0.3 });
        assert.equal(getFrameChunkWorkMotionState(), 'stationary');
        assert.equal(getFrameChunkSchedulerSnapshot().totalBudgetMs, 0.5);
    } finally {
        resetFrameChunkObserver();
        setFrameChunkSchedulerMode('legacy');
        globalThis.performance = originalPerformance;
    }
});

test('a queue lifts its cheap-item cap only after position and view settle', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    let queue = null;
    globalThis.performance = { now: () => clock };
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0 });
        clock = 10;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 1 });
        const processed = [];
        queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        queue.enqueue([1, 2, 3, 4, 5], item => processed.push(item), {
            maxItemsPerFrame: 2,
            maxItemsPerSettledFrame: Infinity,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2], 'active view retains the visit cap');

        clock += 451;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 1 });
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3, 4, 5], 'settled view catches up within its time slice');
    } finally {
        queue?.dispose();
        resetFrameChunkObserver();
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
        globalThis.performance = originalPerformance;
    }
});

test('an opted-in cheap-item cap preserves throughput at 30 Hz', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    let queue = null;
    globalThis.performance = { now: () => clock };
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 0 });
        clock = 1000 / 30;
        noteFrameChunkObserver(0, 0, { viewHeadingDeg: 1 });
        const processed = [];
        queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        queue.enqueue(Array.from({ length: 10 }, (_, index) => index), item => {
            processed.push(item);
        }, {
            maxItemsPerFrame: 2,
            maxItemsPerSettledFrame: Infinity,
            scaleMaxItemsWithFrameTime: true,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
        queue?.dispose();
        resetFrameChunkObserver();
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
        globalThis.performance = originalPerformance;
    }
});

// The opt-out has to hold under the ADAPTIVE scheduler, which is the default.
// It did not: the adaptive branch of frameChunkObserverIsMoving() ignored
// pauseWhileMoving entirely, so a cab ride paused background construction after
// all. world/decor.js awaits frames in a `while (frameChunkObserverIsMoving())`
// loop, which meant decor only ever built while the sim was paused.
//
// The test above cannot catch this: with every note in the same millisecond the
// adaptive motion estimate stays 'stationary', so it returns false for the wrong
// reason. This one drives 25 m/s across real frame times to reach 'transit'.
test('the cab opt-out holds under the adaptive scheduler, not just legacy', () => {
    const originalPerformance = globalThis.performance;
    let clock = 0;
    globalThis.performance = { now: () => clock };
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();

        // A walker (gate on) moving at 25 m/s is genuinely moving.
        noteFrameChunkObserver(0, 0);
        for (let frame = 1; frame <= 60; frame++) {
            clock = frame * 1000 / 60;
            noteFrameChunkObserver(25 * clock / 1000, 0);
        }
        assert.equal(getFrameChunkSchedulerSnapshot().motionState, 'transit');
        assert.equal(frameChunkWorkShouldPauseForMovement(), true, 'walker mode still pauses while moving');

        // The same motion in a cab, which opts out, must not PAUSE work —
        // otherwise decor and the other movement-gated builders never run.
        clock += 1000 / 60;
        noteFrameChunkObserver(25 * clock / 1000, 0, { pauseWhileMoving: false });
        assert.equal(frameChunkWorkShouldPauseForMovement(), false, 'a cab ride must not pause background work');
        // ...while the fact stays true, so shared-tile-session keeps deferring
        // eviction (synchronous GPU teardown hitches at every tile boundary).
        assert.equal(frameChunkObserverIsMoving(), true, 'a moving cab is still moving');
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
    }
});

test('adaptive mode uses time-normalized motion and keeps transit work progressing', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        const processed = [];
        const queue = createFrameChunkQueue({
            label: 'adaptive-near-test',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        noteFrameChunkObserver(0, 0);
        for (let frame = 1; frame <= 60; frame++) {
            clock = frame * 1000 / 60;
            noteFrameChunkObserver(25 * clock / 1000, 0);
        }
        queue.enqueue(['near'], item => processed.push(item));
        callbacks.shift()();

        assert.deepEqual(processed, ['near']);
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.mode, 'adaptive');
        assert.equal(snapshot.motionState, 'transit');
        assert.equal(snapshot.classBudgets.near, 4);
        queue.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('adaptive far work yields while near work is pending', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const processed = [];
        const near = createFrameChunkQueue({
            label: 'near-yield-test',
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const far = createFrameChunkQueue({
            label: 'far-yield-test',
            preferAnimationFrame: true,
            workClass: 'far',
        });
        near.enqueue(['near'], item => processed.push(item));
        far.enqueue(['far'], item => processed.push(item));

        callbacks[1]();
        assert.deepEqual(processed, [], 'far waits while near is queued');
        callbacks[0]();
        assert.deepEqual(processed, ['near']);
        callbacks.at(-1)();
        assert.deepEqual(processed, ['near', 'far']);
        near.dispose();
        far.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
});

test('bounded packet deliveries progress while near-world work remains pending', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    const queues = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const near = createFrameChunkQueue({
            label: 'packet-throughput-near', preferAnimationFrame: true, workClass: 'near',
        });
        const delivery = createFrameChunkQueue({
            label: 'packet-throughput-delivery', preferAnimationFrame: true,
            workClass: 'delivery', frameBudgetMs: 1,
        });
        queues.push(near, delivery);
        near.enqueue(['pending-near'], () => {});
        const copied = [];
        delivery.enqueue(Array.from({ length: 100 }, (_, index) => index), item => {
            copied.push(item);
            clock += 0.01;
        }, { maxItemsPerFrame: 24 });
        callbacks[1]();
        assert.equal(copied.length, 24, 'copies progress up to their cap without draining near first');
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.queues.find(q => q.label === 'packet-throughput-near').pendingItems, 1);
        assert.equal(snapshot.queues.find(q => q.label === 'packet-throughput-delivery').pendingItems, 76);
        assert.ok(snapshot.spentByClass.delivery <= 1, 'the delivery time slice is still bounded');
    } finally {
        queues.forEach(queue => queue.dispose());
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('loading queues share one aggregate near-world budget', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        beginWorldBuild();
        const legacyNearSlices = [4, 5, 4];
        const queues = ['roads', 'buildings', 'curbs'].map((label, index) => (
            createFrameChunkQueue({
                label: `aggregate-${label}`,
                frameBudgetMs: legacyNearSlices[index],
                preferAnimationFrame: true,
                workClass: 'near',
            })
        ));
        const processed = [];
        for (let index = 0; index < queues.length; index++) {
            queues[index].enqueue(Array.from({ length: 20 }, (_, item) => item), item => {
                processed.push(`${index}:${item}`);
                clock += 1;
            });
        }
        callbacks.splice(0, 3).forEach(callback => callback());
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.classBudgets.near, 48);
        assert.equal(snapshot.spentByClass.near, 48);
        assert.equal(snapshot.spentTotalMs, snapshot.spentByClass.near);
        assert.deepEqual(
            queues.map((_, index) => processed.filter(value => value.startsWith(`${index}:`)).length),
            [20, 20, 8],
            'opaque loading consumes available construction time within one aggregate allowance',
        );
        queues.forEach(queue => queue.dispose());
    } finally {
        _resetWorldReady();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('a loading near queue borrows reservations from idle siblings', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const queue = createFrameChunkQueue({
            label: 'loading-borrow-test',
            frameBudgetMs: 5,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const processed = [];
        queue.enqueue(Array.from({ length: 100 }, (_, item) => item), item => {
            processed.push(item);
            clock += 1;
        });

        beginWorldBuild();
        callbacks.shift()();
        assert.equal(processed.length, 48);
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.classBudgets.near, 48);
        assert.equal(snapshot.spentByClass.near, 48);
        assert.equal(snapshot.chargedByClass.near, 48);
        queue.dispose();
    } finally {
        _resetWorldReady();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('visible loading work can claim a larger bounded reservation', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        beginWorldBuild();
        const processed = [];
        const buildings = createFrameChunkQueue({
            label: 'visible-reservation-buildings',
            frameBudgetMs: 5,
            stationaryReservationMs: () => 8,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const roads = createFrameChunkQueue({
            label: 'visible-reservation-roads',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const curbs = createFrameChunkQueue({
            label: 'visible-reservation-curbs',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        for (const [label, queue] of [
            ['building', buildings],
            ['road', roads],
            ['curb', curbs],
        ]) {
            queue.enqueue(Array.from({ length: 100 }, (_, index) => index), () => {
                processed.push(label);
                clock += 1;
            });
        }

        callbacks.splice(0, 3).forEach(callback => callback());
        assert.equal(processed.filter(label => label === 'building').length, 40);
        assert.equal(processed.filter(label => label === 'road').length, 4);
        assert.equal(processed.filter(label => label === 'curb').length, 4);
        assert.equal(getFrameChunkSchedulerSnapshot().spentByClass.near, 48);
        buildings.dispose();
        roads.dispose();
        curbs.dispose();
    } finally {
        _resetWorldReady();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('a stationary item overrun uses up the shared frame instead of stacking sibling reservations', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        const processed = [];
        const roads = createFrameChunkQueue({
            label: 'overrun-roads',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const buildings = createFrameChunkQueue({
            label: 'overrun-buildings',
            frameBudgetMs: 5,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        const curbs = createFrameChunkQueue({
            label: 'overrun-curbs',
            frameBudgetMs: 4,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        roads.enqueue(['road'], item => {
            processed.push(item);
            clock += 20;
        });
        buildings.enqueue(['building'], item => {
            processed.push(item);
            clock += 5;
        });
        curbs.enqueue(['curb'], item => {
            processed.push(item);
            clock += 4;
        });

        callbacks.splice(0, 3).forEach(callback => callback());
        assert.deepEqual(processed, ['road']);
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.spentByClass.near, 20);
        assert.equal(snapshot.chargedByClass.near, 20);
        roads.dispose();
        buildings.dispose();
        curbs.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('fast motion continuously advances near surface work', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const originalPerformance = globalThis.performance;
    const callbacks = [];
    let clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        for (let frame = 1; frame <= 20; frame++) {
            clock = frame * 50;
            noteFrameChunkObserver(75 * clock / 1000, 0);
        }
        assert.equal(getFrameChunkSchedulerSnapshot().motionState, 'fast');

        const processed = [];
        const queue = createFrameChunkQueue({
            label: 'fast-near-liveness-test',
            frameBudgetMs: 5,
            preferAnimationFrame: true,
            workClass: 'near',
        });
        queue.enqueue([1, 2, 3, 4], item => {
            processed.push(item);
            clock += 2;
        });

        callbacks.shift()();
        assert.deepEqual(processed, [1, 2]);

        clock += 50;
        noteFrameChunkObserver(75 * clock / 1000, 0);
        callbacks.shift()();
        assert.deepEqual(processed, [1, 2, 3, 4]);
        queue.dispose();
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        globalThis.performance = originalPerformance;
    }
});

test('a tiny orientation queue may consume genuine idle time while walking', () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};

    try {
        const processed = [];
        const queue = createFrameChunkQueue({
            frameBudgetMs: 0.5,
            pauseDuringMovement: false,
        });
        noteFrameChunkObserver(20, 0);
        noteFrameChunkObserver(30, 0);
        queue.enqueue(['street-name'], item => processed.push(item), {
            maxItemsPerFrame: 1,
        });

        callbacks.shift()({ timeRemaining: () => 2 });
        assert.deepEqual(processed, ['street-name']);
    } finally {
        noteFrameChunkObserver(30, 0, { pauseWhileMoving: false });
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('an item failure rejects its job, reports context, and does not stall later jobs', { timeout: 5000 }, async () => {
    const originalPerformance = globalThis.performance;
    let clock = 0;
    globalThis.performance = { now: () => clock };
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const originalConsoleError = console.error;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    console.error = () => {};
    let queue;

    try {
        const processed = [];
        let failure = null;
        queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        const failedJob = queue.enqueue(['bad'], () => {
            clock += 6; // a failure can consume the remainder of this 4 ms slice
            throw new Error('mesh build failed');
        }, {
            onError: (error, item, index) => {
                failure = { error, item, index };
            },
            priority: 2,
        });
        const laterJob = queue.enqueue(['good'], item => processed.push(item), {
            priority: 1,
        });

        callbacks.shift()({ timeRemaining: () => 10 });
        await assert.rejects(failedJob.promise, /mesh build failed/);
        assert.deepEqual(processed, [], 'later work waits for a fresh frame after the overrun');
        assert.equal(callbacks.length, 1, 'failure must schedule the unserved job');
        clock = 16;
        callbacks.shift()({ timeRemaining: () => 10 });
        await laterJob.promise;
        assert.deepEqual(processed, ['good']);
        assert.equal(failure.item, 'bad');
        assert.equal(failure.index, 0);
        assert.match(failure.error.message, /mesh build failed/);
    } finally {
        queue?.dispose();
        globalThis.performance = originalPerformance;
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
        console.error = originalConsoleError;
    }
});

test('a completion callback failure rejects the acknowledged job', { timeout: 5000 }, async () => {
    const originalPerformance = globalThis.performance;
    globalThis.performance = { now: () => 0 };
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const originalConsoleError = console.error;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    console.error = () => {};
    let queue;

    try {
        let reported = null;
        queue = createFrameChunkQueue({
            frameBudgetMs: 4,
            pauseDuringMovement: false,
        });
        const job = queue.enqueue(['item'], () => {}, {
            onComplete: () => {
                throw new Error('publish failed');
            },
            onError: error => { reported = error; },
        });
        callbacks.shift()({ timeRemaining: () => 10 });
        await assert.rejects(job.promise, /publish failed/);
        assert.match(reported.message, /publish failed/);
    } finally {
        queue?.dispose();
        globalThis.performance = originalPerformance;
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
        console.error = originalConsoleError;
    }
});

test('scene work samples expire and invalid samples retain the interval allowance', () => {
    const originalPerformance = globalThis.performance;
    let clock = 0;
    globalThis.performance = { now: () => clock };
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        clock = 40;
        noteFrameChunkObserver(0, 0);
        noteFrameChunkSceneWork(12);
        assert.equal(getFrameChunkSchedulerSnapshot().sceneWorkMs, 12);
        assert.equal(getFrameChunkSchedulerSnapshot().totalBudgetMs, 10);
        noteFrameChunkSceneWork(40);
        assert.equal(getFrameChunkSchedulerSnapshot().totalBudgetMs, 0.5);
        for (const invalid of [null, -1, NaN, Infinity, '0']) {
            noteFrameChunkSceneWork(invalid);
            assert.equal(getFrameChunkSchedulerSnapshot().sceneWorkMs, null);
            assert.equal(getFrameChunkSchedulerSnapshot().totalBudgetMs, 0.5);
        }
        noteFrameChunkSceneWork(12);
        for (clock = 80; clock <= 1080; clock += 40) noteFrameChunkObserver(0, 0);
        assert.equal(getFrameChunkSchedulerSnapshot().sceneWorkMs, null);
        assert.equal(getFrameChunkSchedulerSnapshot().totalBudgetMs, 0.5);
        noteFrameChunkSceneWork(12);
        resetFrameChunkObserver();
        assert.equal(getFrameChunkSchedulerSnapshot().sceneWorkMs, null);
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
    }
});

test('a scene-work update preserves both the charged total and class allowance', () => {
    const originalPerformance = globalThis.performance;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    let clock = 0, built = 0, delivered = 0;
    const callbacks = [];
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = callback => callbacks.push(callback);
    globalThis.cancelAnimationFrame = () => {};
    let near, delivery;
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        noteFrameChunkSceneWork(12);
        near = createFrameChunkQueue({ frameBudgetMs: 6, workClass: 'near', preferAnimationFrame: true });
        near.enqueue([1, 2, 3], () => { built++; clock += 3; });
        callbacks.shift()();
        assert.equal(built, 2);
        noteFrameChunkSceneWork(12);
        callbacks.shift()();
        assert.equal(built, 2, 'the near class already spent its 6 ms');
        delivery = createFrameChunkQueue({ frameBudgetMs: 1, workClass: 'delivery', preferAnimationFrame: true });
        delivery.enqueue([1], () => { delivered++; clock += 1; });
        noteFrameChunkSceneWork(20);
        const snapshot = getFrameChunkSchedulerSnapshot();
        assert.equal(snapshot.totalBudgetMs, 5);
        assert.equal(snapshot.chargedTotalMs, 6);
        assert.equal(snapshot.chargedByClass.near, 6);
        callbacks.splice(0).forEach(callback => callback());
        assert.equal(delivered, 0, 'the existing charge also exhausts the reduced aggregate budget');
        assert.equal(built, 2);
    } finally {
        near?.dispose();
        delivery?.dispose();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
    }
});

test('re-evaluates a callback item cap for a long-lived job on every frame', () => {
    const originalPerformance = globalThis.performance;
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    const processed = [];
    let clock = 0, cap = 1;
    let queue = null;
    globalThis.performance = { now: () => clock };
    globalThis.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
    globalThis.cancelIdleCallback = () => {};
    try {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        queue = createFrameChunkQueue({ frameBudgetMs: 4, pauseDuringMovement: false });
        queue.enqueue(Array.from({ length: 11 }, (_, index) => index + 1), item => {
            processed.push(item);
            clock += 1;
        }, {
            maxItemsPerFrame: () => cap,
        });
        clock = 16;
        noteFrameChunkObserver(1, 0);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1]);
        cap = 4;
        clock = 32;
        noteFrameChunkObserver(2, 0);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3, 4, 5]);
        cap = 1;
        clock = 48;
        noteFrameChunkObserver(3, 0);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3, 4, 5, 6]);
        cap = Infinity;
        clock = 1000;
        noteFrameChunkObserver(3, 0);
        assert.equal(frameChunkObserverIsSettled(), true);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.equal(processed.length, 10, 'the inherited settled callback still respects the 4 ms time budget');
    } finally {
        queue?.dispose();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('settled callback cap is reevaluated independently and does not leak across motion modes', () => {
    const originalPerformance = globalThis.performance;
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    const processed = [];
    let clock = 0, settledCap = 1;
    let queue = null;
    globalThis.performance = { now: () => clock };
    globalThis.requestIdleCallback = callback => { callbacks.push(callback); return callbacks.length; };
    globalThis.cancelIdleCallback = () => {};
    try {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        queue = createFrameChunkQueue({ frameBudgetMs: 4, pauseDuringMovement: false });
        queue.enqueue([1, 2, 3, 4, 5, 6, 7], item => processed.push(item), {
            maxItemsPerFrame: 3,
            maxItemsPerSettledFrame: () => settledCap,
        });
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1]);
        settledCap = 2;
        clock = 16;
        noteFrameChunkObserver(0, 0);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3]);
        clock = 32;
        noteFrameChunkObserver(1, 0);
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3, 4, 5, 6], 'movement uses the independent numeric cap of three');
        clock = 1000;
        noteFrameChunkObserver(1, 0);
        settledCap = 1;
        callbacks.shift()({ timeRemaining: () => 10 });
        assert.deepEqual(processed, [1, 2, 3, 4, 5, 6, 7]);
    } finally {
        queue?.dispose();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.performance = originalPerformance;
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});

test('the snapshot counts admissions: flushes, refused turns and granted allowance', () => {
    setFrameChunkSchedulerMode('legacy');
    resetFrameChunkObserver();
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const callbacks = [];
    globalThis.requestIdleCallback = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelIdleCallback = () => {};
    const queue = createFrameChunkQueue({ label: 'admission-counters' });
    let job = null;
    try {
        job = queue.enqueue(['a', 'b'], () => FRAME_CHUNK_DEFER_ITEM);
        callbacks.shift()({ timeRemaining: () => 0.5 });
        callbacks.shift()({ timeRemaining: () => 10 });
        const entry = getFrameChunkSchedulerSnapshot().queues.find(candidate => candidate.label === 'admission-counters');
        assert.equal(entry.flushes, 2, 'both idle callbacks asked for a turn');
        assert.equal(entry.starvedFlushes, 1, 'the half-millisecond callback was refused');
        assert.equal(entry.grantedMs, 4, 'the second was granted the queue budget, not the idle remainder');
    } finally {
        if (job) queue.cancel(job);
        globalThis.requestIdleCallback = originalRequestIdleCallback;
        globalThis.cancelIdleCallback = originalCancelIdleCallback;
    }
});
