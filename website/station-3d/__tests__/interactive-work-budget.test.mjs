// Exercise the real queues and loading gate with deterministic clocks. These
// are admission/liveness contracts, not fake-clock performance measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFrameChunkQueue, FRAME_CHUNK_DEFER_ITEM, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_WAIT_ITEM,
    getFrameChunkSchedulerSnapshot, noteFrameChunkObserver, noteFrameChunkSceneWork,
    resetFrameChunkObserver, setFrameChunkSchedulerMode,
} from '../core/frame-chunk-queue.js';
import { beginWorldBuild, forceWorldReady, _resetWorldReady } from '../core/world-ready.js';

function frames(run) {
    const original = {
        performance: globalThis.performance,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    let clock = 0;
    let id = 0;
    const callbacks = new Map();
    const queues = [];
    globalThis.performance = { now: () => clock };
    globalThis.requestAnimationFrame = cb => { callbacks.set(++id, cb); return id; };
    globalThis.cancelAnimationFrame = handle => callbacks.delete(handle);
    _resetWorldReady();
    resetFrameChunkObserver();
    setFrameChunkSchedulerMode('adaptive');
    noteFrameChunkObserver(0, 0);
    function flushCallbacks(reverse = false) {
        const batch = [...callbacks.values()];
        callbacks.clear();
        if (reverse) batch.reverse();
        batch.forEach(cb => cb());
        return getFrameChunkSchedulerSnapshot();
    }
    const env = {
        spend(ms) { clock += ms; },
        queue(label, workClass = 'near', costMs = 1, count = 30, frameBudgetMs = 4,
            workTier = 'default', workWeight = 1, criticalPath = false) {
            const queue = createFrameChunkQueue({
                label, workClass, workTier, workWeight, criticalPath,
                preferAnimationFrame: true, frameBudgetMs,
            });
            queues.push(queue);
            queue.enqueue(Array.from({ length: count }, (_, i) => i), () => { clock += costMs; });
            return queue;
        },
        repeat: flushCallbacks,
        next(ms = 40, reverse = false) {
            clock += ms;
            noteFrameChunkObserver(0, 0);
            return flushCallbacks(reverse);
        },
    };
    try { run(env); } finally {
        queues.forEach(queue => queue.dispose());
        _resetWorldReady();
        resetFrameChunkObserver();
        setFrameChunkSchedulerMode(null);
        Object.assign(globalThis, original);
    }
}

test('an interactive stop charges the whole indivisible overrun and runs no sibling afterwards', () => frames(env => {
    env.queue('long-road', 'near', 20);
    env.queue('building', 'near', 1);
    env.queue('curb', 'near', 1);
    const first = env.next();
    assert.equal(first.phase, 'interactive');
    assert.equal(first.totalBudgetMs, 0.5);
    assert.equal(first.spentTotalMs, 20);
    assert.equal(first.chargedTotalMs, first.spentTotalMs);
    assert.deepEqual(first.queues.map(q => q.processedItems), [1, 0, 0]);
    // A long first queue must not consume every following frame's small slice.
    env.next();
    const third = env.next();
    assert.ok(third.queues.every(q => q.processedItems > 0));
}));

test('small interactive slices make progress across classes without stacking reservations', () => frames(env => {
    env.queue('delivery', 'delivery', 1);
    env.queue('road', 'near', 1);
    env.queue('building', 'near', 1);
    env.queue('actors', 'simulation', 1);
    env.queue('orientation', 'orientation', 1);
    for (let frame = 0; frame < 10; frame++) {
        const snapshot = env.next();
        assert.equal(snapshot.spentTotalMs, 1, 'one indivisible item uses up this frame');
        assert.equal(snapshot.chargedTotalMs, 1);
    }
    assert.ok(getFrameChunkSchedulerSnapshot().queues.every(q => q.processedItems >= 2));
}));

test('moving surface construction keeps three quarters of near work in either callback order', () => {
    for (const reverse of [false, true]) frames(env => {
        env.queue('ground', 'near', 0.5, 20, 6, 'surface');
        env.queue('buildings', 'near', 0.5, 20, 6);
        const snapshot = env.next(0, reverse);
        assert.equal(snapshot.classBudgets.near, 6);
        assert.equal(snapshot.spentByClass.near, 6);
        const ground = snapshot.queues.find(queue => queue.label === 'ground');
        const buildings = snapshot.queues.find(queue => queue.label === 'buildings');
        assert.equal(ground.workTier, 'surface');
        assert.equal(ground.processedItems, 9);
        assert.equal(buildings.processedItems, 3);
    });
});

test('interactive queues divide one tier by declared work weight in either callback order', () => {
    for (const reverse of [false, true]) frames(env => {
        env.queue('ground-generation', 'near', 0.25, 100, 6, 'surface', 12);
        env.queue('road-sources', 'near', 0.25, 100, 6, 'surface', 1);
        const snapshot = env.next(0, reverse);
        const ground = snapshot.queues.find(queue => queue.label === 'ground-generation');
        const roads = snapshot.queues.find(queue => queue.label === 'road-sources');
        assert.equal(ground.workWeight, 12);
        assert.equal(roads.workWeight, 1);
        assert.ok(ground.processedItems >= 21, 'critical ground publication receives most of the 6 ms tier');
        assert.ok(roads.processedItems >= 1, 'the source queue retains a bounded live share');
        assert.ok(snapshot.spentByClass.near <= 6.25, 'weighted shares preserve the class ceiling');
    });
});

test('runnable critical ground owns near work, then releases it while dependency-waiting', () => {
    for (const reverse of [false, true]) frames(env => {
        let waiting = false;
        const ground = env.queue('ground-generation', 'near', 0, 0, 6, 'surface', 12, true);
        const roads = env.queue('road-sources', 'near', 0.25, 100, 6, 'surface');
        const buildings = env.queue('buildings', 'near', 0.25, 100, 6);
        ground.enqueue([1], () => {
            env.spend(0.25);
            return waiting ? FRAME_CHUNK_WAIT_ITEM : FRAME_CHUNK_REPEAT_ITEM;
        });
        let snapshot = env.next(0, reverse);
        const critical = snapshot.queues.find(queue => queue.label === 'ground-generation');
        assert.equal(critical.criticalPath, true);
        assert.ok(critical.processedItems >= 24, 'critical publication receives the complete near allowance');
        assert.equal(snapshot.queues.find(queue => queue.label === 'road-sources').processedItems, 0);
        assert.equal(snapshot.queues.find(queue => queue.label === 'buildings').processedItems, 0);

        waiting = true;
        snapshot = env.next(0, reverse);
        const waitingProcessed = snapshot.queues.find(queue => queue.label === 'ground-generation').processedItems;
        snapshot = env.next(0, reverse);
        assert.ok(snapshot.queues.find(queue => queue.label === 'ground-generation').processedItems
            <= waitingProcessed + 1, 'an explicit dependency wait retains only its bounded readiness probe');
        assert.ok(snapshot.queues.find(queue => queue.label === 'road-sources').processedItems > 0);
    });
});

test('ordinary near work borrows the whole allowance when surface construction is idle', () => frames(env => {
    env.queue('buildings', 'near', 1, 20, 6);
    const snapshot = env.next(0);
    assert.equal(snapshot.spentByClass.near, 6);
    assert.equal(snapshot.queues[0].processedItems, 6);
}));

test('the real loading gate retains catch-up, then protects the very next interactive flush', () => frames(env => {
    beginWorldBuild();
    env.queue('loading-road', 'near', 1, 100);
    let snapshot = env.next();
    assert.equal(snapshot.phase, 'loading');
    assert.equal(snapshot.totalBudgetMs, 59);
    assert.equal(snapshot.spentByClass.near, 48);
    forceWorldReady();
    snapshot = env.next();
    assert.equal(snapshot.phase, 'interactive');
    assert.equal(snapshot.totalBudgetMs, 0.5);
    assert.equal(snapshot.spentTotalMs, 1);
}));

test('loading overruns are real costs too, not a reason to run all other queues', () => frames(env => {
    beginWorldBuild();
    env.queue('loading-road', 'near', 70);
    env.queue('loading-building', 'near', 5);
    const snapshot = env.next();
    assert.equal(snapshot.spentTotalMs, 70);
    assert.equal(snapshot.chargedTotalMs, 70);
    assert.deepEqual(snapshot.queues.map(q => q.processedItems), [1, 0]);
}));

test('far liveness cannot run after a near overrun, but gets a turn in a fresh frame', () => frames(env => {
    env.queue('near', 'near', 20);
    env.queue('far', 'far', 3);
    for (let frame = 0; frame < 20; frame++) {
        const snapshot = env.next();
        assert.ok(snapshot.spentTotalMs === 20 || snapshot.spentTotalMs === 3,
            'far must not append work to an already-overdrawn frame');
        assert.equal(snapshot.chargedTotalMs, snapshot.spentTotalMs);
    }
    assert.ok(getFrameChunkSchedulerSnapshot().queues.find(q => q.label === 'far').processedItems > 0,
        'a shared deadline must not regress skyline liveness');
}));

test('deferred waiter does not deny its runnable ground owner on later frames', () => frames(env => {
    let groundSteps = 0;
    // Registration and browser callback order can differ in a running world.
    const buildings = env.queue('buildings', 'near', 0, 0, 6);
    const ground = env.queue('ground', 'near', 0, 0, 6);
    ground.enqueue([1], () => { env.spend(0.1); groundSteps++; return FRAME_CHUNK_REPEAT_ITEM; });
    buildings.enqueue([1], () => { env.spend(0.01); return FRAME_CHUNK_DEFER_ITEM; });
    for (let frame = 0; frame < 10; frame++) {
        const before = groundSteps;
        env.spend(25);
        noteFrameChunkSceneWork(12);
        const snapshot = env.next(0);
        assert.ok(groundSteps > before, `ground must progress on frame ${frame + 1}`);
        assert.equal(snapshot.totalBudgetMs, 10);
        assert.ok(snapshot.spentByClass.near <= 6.11, 'retain the class cap plus one indivisible item');
        assert.ok(snapshot.spentTotalMs <= 10.11, 'retain the aggregate cap plus one indivisible item');
    }
}));

test('an all-waiting sibling lends its unused budget and resumes when the dependency resolves', () => {
    for (const waiterFirst of [true, false]) frames(env => {
        let released = false;
        let ownerSteps = 0;
        let waiterSteps = 0;
        const waiter = () => {
            env.spend(.01);
            if (!released) return FRAME_CHUNK_WAIT_ITEM;
            waiterSteps++;
            return FRAME_CHUNK_REPEAT_ITEM;
        };
        const owner = () => { env.spend(.1); ownerSteps++; return FRAME_CHUNK_REPEAT_ITEM; };
        const waiterQueue = env.queue('dependency-waiter', 'near', 0, 0, 6);
        const ownerQueue = env.queue('ground-owner', 'near', 0, 0, 6);
        const enqueueWaiter = () => waiterQueue.enqueue([1], waiter);
        const enqueueOwner = () => ownerQueue.enqueue([1], owner);
        if (waiterFirst) { enqueueWaiter(); enqueueOwner(); } else { enqueueOwner(); enqueueWaiter(); }
        const advance = () => {
            env.spend(25); noteFrameChunkSceneWork(12);
            const snapshot = env.next(0);
            assert.equal(snapshot.classBudgets.near, 6);
            assert.ok(snapshot.spentTotalMs <= snapshot.totalBudgetMs + .11,
                'deferred sibling must not breach aggregate budget');
            assert.ok(snapshot.spentByClass.near <= snapshot.classBudgets.near + .11,
                'deferred sibling must not breach near class budget');
        };
        advance(); // First probe discovers the dependency wait.
        for (let frame = 0; frame < 5; frame++) {
            const before = ownerSteps;
            advance();
            assert.ok(ownerSteps - before >= 55,
                `owner uses available near budget, order ${waiterFirst}, frame ${frame + 1}`);
        }
        released = true;
        const before = ownerSteps;
        for (let frame = 0; frame < 4; frame++) advance();
        assert.ok(waiterSteps > 20, 'the resumed sibling receives runnable work budget');
        assert.ok(ownerSteps > before + 20, 'the owner remains live after its sibling resumes');
    });
});

test('a next-frame yield retains its work share instead of becoming a dependency probe', () => frames(env => {
    let ownerSteps = 0, yieldSteps = 0;
    const yielding = env.queue('next-frame-stage', 'near', 0, 0, 6);
    const owner = env.queue('other-owner', 'near', 0, 0, 6);
    yielding.enqueue([1], () => { env.spend(.01); yieldSteps++; return FRAME_CHUNK_DEFER_ITEM; });
    owner.enqueue([1], () => { env.spend(.1); ownerSteps++; return FRAME_CHUNK_REPEAT_ITEM; });
    for (let frame = 0; frame < 5; frame++) {
        env.spend(25); noteFrameChunkSceneWork(12);
        const before = ownerSteps;
        const snapshot = env.next(0);
        assert.equal(yieldSteps, frame + 1, 'retry the frame stage exactly once per frame');
        assert.ok(ownerSteps - before >= 29 && ownerSteps - before <= 31,
            'the other owner keeps its half share while the paced producer remains runnable');
        assert.ok(snapshot.spentByClass.near <= 6.11);
    }
}));

test('a defer to repeat transition clears defer summaries while remaining pending', () => frames(env => {
    let calls = 0;
    const queue = env.queue('buildings-transition', 'near', 0, 0);
    queue.enqueue([1], () => {
        env.spend(0.1);
        return ++calls === 1 ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
    });
    const first = env.next().queues.find(item => item.label === 'buildings-transition');
    assert.equal(first.deferring.length, 1);
    assert.equal(first.deferring[0].count, 1);
    const next = env.next().queues.find(item => item.label === 'buildings-transition');
    assert.ok(calls > 1, 'the same semantic item resumed CPU work');
    assert.equal(next.pendingItems, 1);
    assert.deepEqual(next.deferring, []);
}));

test('runnable queues use their whole class allowance in either callback order', () => {
    for (const reverse of [false, true]) frames(env => {
        env.queue('near-a', 'near', 1, 20, 6);
        env.queue('near-b', 'near', 1, 20, 6);
        const snapshot = env.next(0, reverse);
        assert.equal(snapshot.spentByClass.near, 6);
        assert.equal(snapshot.chargedByClass.near, 6);
        assert.deepEqual(snapshot.queues.map(queue => queue.processedItems), [3, 3]);
    });
});

test('a low-cap sibling lends its unused reservation in either callback order', () => {
    for (const reverse of [false, true]) frames(env => {
        env.queue('near-low', 'near', 1, 20, 1);
        env.queue('near-main', 'near', 1, 20, 6);
        const snapshot = env.next(0, reverse);
        assert.equal(snapshot.spentByClass.near, 6);
        assert.deepEqual(snapshot.queues.map(queue => queue.processedItems), [1, 5]);
    });
});

test('a repeated callback cannot reclaim its spent per-frame allowance', () => frames(env => {
    env.queue('near', 'near', 1, 20, 2);
    const first = env.next(0);
    assert.equal(first.spentByClass.near, 2);
    assert.equal(first.queues[0].processedItems, 2);
    const repeated = env.repeat();
    assert.equal(repeated.spentByClass.near, 2);
    assert.equal(repeated.queues[0].processedItems, 2);
    const next = env.next(10);
    assert.equal(next.spentByClass.near, 2);
    assert.equal(next.queues[0].processedItems, 4);
}));
