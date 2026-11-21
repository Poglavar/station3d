// Frame admission between sibling queues of one work class. Lives in its own
// module instance: the scheduler registry is global, and leftover queues from
// other tests would change the class shares this test reasons about.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
    FRAME_CHUNK_WAIT_ITEM,
    getFrameChunkSchedulerSnapshot,
    noteFrameChunkObserver,
    noteFrameChunkSceneWork,
    resetFrameChunkObserver,
    setFrameChunkSchedulerMode,
} from '../core/frame-chunk-queue.js';

test('a queue that only probes a dependency never takes first admission from a runnable sibling', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    const runFrame = () => {
        noteFrameChunkObserver(0, 0);
        // A loaded test host can stretch a frame past the 25 ms ceiling, which
        // would collapse the whole budget to the starvation allowance and turn
        // this into a headroom test. Report an idle render loop instead.
        noteFrameChunkSceneWork(0);
        const due = callbacks.splice(0, callbacks.length);
        for (const callback of due) callback();
    };
    const entry = label => getFrameChunkSchedulerSnapshot().queues.find(candidate => candidate.label === label);
    const generation = createFrameChunkQueue({ label: 'overrunning-generation', frameBudgetMs: 6,
        preferAnimationFrame: true, workClass: 'near' });
    const probe = createFrameChunkQueue({ label: 'dependency-probe', frameBudgetMs: 5,
        preferAnimationFrame: true, workClass: 'near' });
    let generationJob = null, probeJob = null;
    try {
        setFrameChunkSchedulerMode('adaptive');
        resetFrameChunkObserver();
        noteFrameChunkObserver(0, 0);
        // The generation registers first, so its callback runs first each frame,
        // and every item overruns the class budget as a real compiler step can.
        generationJob = generation.enqueue(['compile'], () => {
            const startedAt = performance.now();
            while (performance.now() - startedAt < 7) { /* indivisible work */ }
            return FRAME_CHUNK_REPEAT_ITEM;
        });
        probeJob = probe.enqueue(['ground-check'], () => FRAME_CHUNK_WAIT_ITEM);
        assert.equal(getFrameChunkSchedulerSnapshot().classBudgets.near, 6);
        runFrame();
        // Frame A: the generation overran; the never-stepped probe looked runnable
        // and was refused, so it legitimately owns the next frame's first turn.
        runFrame();
        assert.equal(entry('overrunning-generation').processedItems, 1, 'frame B went to the refused runnable sibling');
        assert.equal(entry('dependency-probe').processedItems, 1, 'the probe stepped once and now waits on its dependency');
        runFrame();
        assert.equal(entry('overrunning-generation').processedItems, 2, 'frame C is the generation\'s again');
        runFrame();
        assert.equal(entry('overrunning-generation').processedItems, 3,
            'a waiting probe refused after the overrun must not take frame D from the generation');
        assert.equal(entry('overrunning-generation').starvedFlushes, 1, 'only frame B was refused');
    } finally {
        if (generationJob) generation.cancel(generationJob);
        if (probeJob) probe.cancel(probeJob);
        generation.dispose();
        probe.dispose();
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
});
