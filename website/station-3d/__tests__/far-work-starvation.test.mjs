// Far work yields to the near world — but "lowest priority" must not mean
// "never". Every perf trace taken tonight showed the same line:
//
//     far 0/0(761 waiting!)
//
// Zero budget, zero spent, a backlog that only ever grew, and the horizon
// buildings it feeds never appeared. The cause was an ABSOLUTE yield: far got a
// zero allowance whenever `delivery` or `near` had anything pending, and while
// the world is streaming one of those is essentially always pending.
//
// These pin both halves — far still yields, and far eventually runs anyway.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFrameChunkQueue,
    getFrameChunkSchedulerSnapshot,
    noteFrameChunkObserver,
    resetFrameChunkObserver,
    setFrameChunkSchedulerMode,
} from '../core/frame-chunk-queue.js';

// Drives the real scheduler with a fake rAF and a fake clock, the same way
// frame-chunk-queue.test.mjs does, so this exercises the shipped code path
// rather than a reimplementation of it.
function withFakeFrames(run) {
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    const realPerformance = globalThis.performance;
    const callbacks = [];
    const clock = { ms: 0 };
    globalThis.performance = { now: () => clock.ms };
    globalThis.requestAnimationFrame = (cb) => { callbacks.push(cb); return callbacks.length; };
    globalThis.cancelAnimationFrame = () => {};
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        return run({ callbacks, clock });
    } finally {
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = realRaf;
        globalThis.cancelAnimationFrame = realCancel;
        globalThis.performance = realPerformance;
    }
}

// A near queue that never drains (its item defers forever) plus a far queue with
// one item — exactly the shape that starved far in the traces.
function contendedQueues(processed) {
    const near = createFrameChunkQueue({
        label: 'near-starve-test', preferAnimationFrame: true, workClass: 'near',
    });
    const far = createFrameChunkQueue({
        label: 'far-starve-test', preferAnimationFrame: true, workClass: 'far',
    });
    near.enqueue(['near-a', 'near-b', 'near-c'], (item) => { processed.push(item); });
    far.enqueue(['far-a'], (item) => { processed.push(item); });
    return { near, far };
}

test('far yields while near work is pending', () => {
    withFakeFrames(({ callbacks }) => {
        const processed = [];
        const { near, far } = contendedQueues(processed);
        // Pump only the far queue's frame: near still has items queued.
        callbacks.at(-1)();
        assert.deepEqual(processed, [], 'far must not barge in on the near world');
        near.dispose();
        far.dispose();
    });
});

test('far still runs once it has been starved long enough', () => {
    withFakeFrames(({ callbacks, clock }) => {
        const processed = [];
        const { near, far } = contendedQueues(processed);
        callbacks.at(-1)();                       // starts the starvation clock
        assert.deepEqual(processed, [], 'still yielding');

        // Half a second of continuous contention. Before the fix this changed
        // nothing and the backlog grew forever.
        clock.ms += 600;
        noteFrameChunkObserver(0, 0);
        callbacks.at(-1)();
        assert.ok(processed.includes('far-a'),
            'far never ran despite being starved — the 761-item backlog is back');
        near.dispose();
        far.dispose();
    });
});

test('the escape hatch is ONE item, not a slice of the frame', () => {
    withFakeFrames(({ callbacks, clock }) => {
        const processed = [];
        const near = createFrameChunkQueue({
            label: 'near-one-test', preferAnimationFrame: true, workClass: 'near',
        });
        const far = createFrameChunkQueue({
            label: 'far-one-test', preferAnimationFrame: true, workClass: 'far',
        });
        near.enqueue(['n1', 'n2'], (item) => processed.push(item));
        far.enqueue(['f1', 'f2', 'f3', 'f4'], (item) => processed.push(item));

        callbacks.at(-1)();
        clock.ms += 600;
        noteFrameChunkObserver(0, 0);
        callbacks.at(-1)();
        const farDone = processed.filter((p) => p.startsWith('f'));
        assert.equal(farDone.length, 1,
            `one starved frame let ${farDone.length} far items through; the point is a trickle`);
        near.dispose();
        far.dispose();
    });
});

test('with nothing contending, far is not restricted to the trickle', () => {
    // The yield exists for contention. An idle world should let far work
    // properly, or the horizon would fill in at one item per half second.
    withFakeFrames(({ callbacks }) => {
        const processed = [];
        const far = createFrameChunkQueue({
            label: 'far-alone-test', preferAnimationFrame: true, workClass: 'far',
        });
        far.enqueue(['a', 'b', 'c', 'd'], (item) => processed.push(item));
        callbacks.at(-1)();
        assert.ok(processed.length > 1,
            `far alone processed ${processed.length} — it should not trickle when unopposed`);
        far.dispose();
    });
});

test('far-only backlog still makes bounded progress during continuous motion', () => {
    withFakeFrames(({ callbacks, clock }) => {
        // Reach the real fast-motion policy, where far deliberately has no
        // normal class budget. No delivery or near queue exists in this case.
        for (let frame = 1; frame <= 20; frame++) {
            clock.ms = frame * 50;
            noteFrameChunkObserver(75 * clock.ms / 1000, 0);
        }
        assert.equal(getFrameChunkSchedulerSnapshot().motionState, 'fast');
        assert.equal(getFrameChunkSchedulerSnapshot().classBudgets.far, 0);

        const processed = [];
        const far = createFrameChunkQueue({
            label: 'far-only-moving-test', preferAnimationFrame: true, workClass: 'far',
        });
        far.enqueue(['f1', 'f2', 'f3'], (item) => processed.push(item));

        callbacks.shift()();                    // starts the liveness clock
        assert.deepEqual(processed, [], 'far still respects the zero movement budget');

        clock.ms += 499;
        noteFrameChunkObserver(75 * clock.ms / 1000, 0);
        callbacks.shift()();
        assert.deepEqual(processed, [], 'the liveness interval has not elapsed');

        clock.ms += 1;
        noteFrameChunkObserver(75 * clock.ms / 1000, 0);
        callbacks.shift()();
        assert.deepEqual(processed, ['f1'], 'exactly one far item makes progress');
        far.dispose();
    });
});

// --- borrowing an idle frame ------------------------------------------------
//
// The absolute yield was fixed by a liveness drip: one far item per 500 ms while
// near/delivery are pending. That guarantees far RUNS, but it does not make it
// finish. Measured walking Split with the horizon empty:
//
//     WORK  near 99/728   far 0/112      QUEUES far-buildings 708 items
//
// The frame had 629 ms of unclaimed budget and far still got zero, draining at
// ~1.7 items/sec — about six minutes to fill the horizon. Far may now borrow
// what the PREVIOUS frame demonstrably left unused: near keeps first call, and
// far only takes time that was going idle.
test('far borrows a busy-but-not-full frame, and nothing from a full one', async () => {
    const { farBorrowableMs } = await import('../core/frame-chunk-queue.js');

    // The measured case: 728 ms budget, 99 ms used. Far gets half the slack.
    assert.equal(farBorrowableMs(99, 728), (728 - 99) * 0.5);

    // A frame that used its budget lends nothing — the yield still holds.
    assert.equal(farBorrowableMs(728, 728), 0);
    assert.equal(farBorrowableMs(900, 728), 0);

    // Nor does a frame with only a sliver spare, or far would thrash on scraps.
    assert.equal(farBorrowableMs(726, 728), 0);

    // Never more than half, so near always keeps room to grow back.
    assert.ok(farBorrowableMs(1, 100) <= 50);

    // A frame that did NOTHING lends nothing: charged 0 also means "no frame has
    // run yet", and borrowing on that would let far take the budget before near
    // ever asked — the very inversion this branch prevents.
    assert.equal(farBorrowableMs(0, 728), 0);

    // Garbage in must not become an unbounded budget.
    assert.equal(farBorrowableMs(NaN, 728), 0);
    assert.equal(farBorrowableMs(10, 0), 0);
    assert.equal(farBorrowableMs(10, NaN), 0);
});
