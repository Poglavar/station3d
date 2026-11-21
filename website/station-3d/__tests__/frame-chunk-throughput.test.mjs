// An offline compile (the campaign pack bake) has no frame to protect: the
// scheduler's job there is to drain every queue as fast as the CPU allows, not
// to keep a player's camera smooth. Throughput mode is that one switch — the
// same policy object shape, with budgets that would be absurd for play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adaptiveFrameWorkBudget, FRAME_WORK_CLASSES } from '../core/frame-work-policy.js';
import {
    frameChunkWorkShouldPauseForMovement,
    getFrameChunkSchedulerSnapshot,
    noteFrameChunkObserver,
    resetFrameChunkObserver,
    setFrameChunkSchedulerMode,
    setFrameChunkSchedulerThroughput,
} from '../core/frame-chunk-queue.js';

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('the offline-compile policy gives every class a large budget and ignores the previous frame', () => {
    const policy = adaptiveFrameWorkBudget({ offlineCompile: true, previousFrameMs: 900, motionState: 'fast', viewMoving: true });
    assert.equal(policy.phase, 'throughput');
    // EVERY class, not a hand-picked three: a class with no budget is a queue
    // that never runs, and a delivery that never runs pins its network slot.
    // Four starved orientation deliveries once held four of six slots and
    // every remaining fetch of a bake queued behind them for twenty minutes.
    assert.ok(FRAME_WORK_CLASSES.includes('orientation') && FRAME_WORK_CLASSES.includes('simulation'));
    for (const workClass of FRAME_WORK_CLASSES) {
        assert.ok(policy.classBudgets[workClass] >= 100, `${workClass} budget ${policy.classBudgets[workClass]}`);
    }
    assert.ok(policy.totalBudgetMs >= 300, `total ${policy.totalBudgetMs}`);
    assert.equal(policy.motionState, 'stationary', 'motion never throttles an offline compile');
    // The switch is explicit: nothing else in the input can turn it on.
    assert.equal(adaptiveFrameWorkBudget({ loading: true }).phase, 'loading');
    assert.equal(adaptiveFrameWorkBudget({}).phase, 'interactive');
    assert.equal(adaptiveFrameWorkBudget({ offlineCompile: 'yes' }).phase, 'interactive', 'only a boolean true switches it');
});

test('the scheduler exposes throughput mode as its phase, never pauses for movement in it, and returns to normal when cleared', () => {
    setFrameChunkSchedulerMode('adaptive');
    resetFrameChunkObserver();
    try {
        setFrameChunkSchedulerThroughput(true);
        const on = getFrameChunkSchedulerSnapshot();
        assert.equal(on.phase, 'throughput');
        assert.ok(on.totalBudgetMs >= 300);
        assert.ok(on.classBudgets.far >= 100, 'far is not starved while near has work');
        // A moving observer would pause near work in play; not here.
        noteFrameChunkObserver(0, 0, { nowMs: 1000 });
        noteFrameChunkObserver(50, 0, { nowMs: 1016 });
        assert.equal(frameChunkWorkShouldPauseForMovement(), false);
        setFrameChunkSchedulerThroughput(false);
        assert.notEqual(getFrameChunkSchedulerSnapshot().phase, 'throughput');
    } finally {
        setFrameChunkSchedulerThroughput(false);
        setFrameChunkSchedulerMode('legacy');
        resetFrameChunkObserver();
    }
});

test('a bake session switches throughput on at open and off at close', () => {
    const cab = read('../modes/cab.js');
    // Full throttle only once the corridor has built: from session start it
    // starved delivery (measured 60 MB flat for minutes), so the switch lives
    // in the world-ready callback, after the loading-phase budgets did their job.
    assert.match(cab, /onWorldReady\(\(reason\) => \{[\s\S]*?updateCampaignBakeStatus\(cabState, 'ready'\);[\s\S]{0,600}?setFrameChunkSchedulerThroughput\(true\);/);
    const openBlock = cab.slice(cab.indexOf('if (ctx.campaignPackBake) beginCampaignBakeStatus(cabState);'), cab.indexOf('onWorldReady((reason) => {'));
    assert.doesNotMatch(openBlock, /setFrameChunkSchedulerThroughput\(true\)/, 'never before the build');
    assert.match(cab, /export function closeCab\(\) \{[\s\S]*setFrameChunkSchedulerThroughput\(false\);/);
});
