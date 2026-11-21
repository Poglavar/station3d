// Separate active decor work from frame waits, including cancellation at the yield.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { groundPaintOwnerReplacementsSteps } from '../core/ground-paint-owner-set.js';

function fixture({ workMs = .75, cancelOnFrame = false } = {}) {
    const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');
    const names = ['nowMs', 'nextAnimationFrame', 'resetBuildYieldState', 'createBuildYieldState',
        'resetBuildStepClockBeforeContinuation', 'maybeYieldBuild', 'prepareGreeneryPaint'];
    const functions = names.map(name => {
        const pattern = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
        const start = source.search(pattern);
        assert.ok(start >= 0, `production ${name} exists`);
        return source.slice(start, source.indexOf('\n}', start) + 2);
    }).join('\n');
    let now = 0, frames = 0, current = true, finalized = false;
    const reports = [], max = new Map(), paint = {};
    const context = {
        performance: { now: () => now }, queueMicrotask,
        requestAnimationFrame(callback) {
            frames++;
            now += 100; // wait wall time; no construction CPU work
            if (cancelOnFrame) current = false;
            queueMicrotask(callback);
        },
        DECOR_BUILD_BUDGET_MS: 2, DECOR_BUILD_YIELD_EVERY: 1,
        frameChunkWorkShouldPauseForMovement: () => false,
        reportOutOfLoopWork: (label, ms) => reports.push({ label, ms }),
        decorStepMax: max, groundPaintOwnerReplacementsSteps,
        EMPTY_GROUND_PAINT_OWNERS: Object.freeze([]),
    };
    runInNewContext(functions + '\nglobalThis.prepare = prepareGreeneryPaint;', context);
    const group = { userData: { groundPaintOwners: Object.freeze([{ bucketKey: 'fixture', owner: 'one' }]) } };
    const owner = {
        *prepareReplacementsSteps() {
            try {
                now += workMs;
                yield { phase: 'gpu-start', deferFrame: true };
                now += .5;
                yield { phase: 'cpu-resume' };
                return paint;
            } finally { finalized = true; }
        },
    };
    return { reports, max, paint, prepare: () => context.prepare(group, owner, null, () => current),
        frames: () => frames, finalized: () => finalized };
}

test('a required paint frame wait is excluded from CPU cost and does not force a second wait', async () => {
    const f = fixture();
    assert.equal((await f.prepare()).paint, f.paint);
    assert.equal(f.frames(), 1, 'one GPU frame deferral must not consume two frames');
    assert.equal(f.max.get('greenery:paint-publication'), .75);
    assert.equal(f.reports.reduce((total, row) => total + row.ms, 0), .75);
    assert.equal(f.finalized(), true);
});

test('an expensive paint step is still reported before its forced frame yield', async () => {
    const f = fixture({ workMs: 8 });
    await f.prepare();
    assert.equal(f.frames(), 1);
    assert.equal(f.max.get('greenery:paint-publication'), 8);
    assert.equal(f.reports.reduce((total, row) => total + row.ms, 0), 8);
});

test('cancellation during a paint frame wait closes its detached generator', async () => {
    const f = fixture({ cancelOnFrame: true });
    assert.equal(await f.prepare(), null);
    assert.equal(f.frames(), 1);
    assert.equal(f.finalized(), true);
});
