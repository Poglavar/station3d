// The campaign readiness watchdog fails a scene only when it stops reporting
// progress, or at the absolute cap — never at a fixed deadline while a slow
// host is still building the level.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CAMPAIGN_READY_CAP_MS,
    CAMPAIGN_READY_STALL_MS,
    campaignReadyProgressValue,
    createCampaignReadyWatchdog,
    planCampaignReadyDeadline,
} from '../core/campaign-ready-watchdog.js';

test('progress values are monotonic across the world bar and both pack phases', () => {
    assert.equal(campaignReadyProgressValue('station3d:world-load-progress', { fraction: 0.71 }), 0.71);
    assert.equal(campaignReadyProgressValue('station3d:world-load-progress', { fraction: 'x' }), null);
    assert.equal(campaignReadyProgressValue('station3d:campaign-pack-progress', { loadedBytes: 50, totalBytes: 200 }), 0.25);
    assert.equal(campaignReadyProgressValue('station3d:campaign-pack-progress', { loadedChunks: 3, totalChunks: 4 }), 0.75);
    const build = campaignReadyProgressValue('station3d:campaign-pack-progress', { phase: 'build', uploadedPackets: 10, totalPackets: 40 });
    assert.equal(build, 1.25);
    assert.ok(build > campaignReadyProgressValue('station3d:campaign-pack-progress', { loadedBytes: 200, totalBytes: 200 }));
    assert.equal(campaignReadyProgressValue('station3d:campaign-pack-progress', { phase: 'build' }), null);
    assert.equal(campaignReadyProgressValue('station3d:pose', { fraction: 1 }), null);
});

test('the deadline waits while progress keeps arriving, stalls after the stall window, caps regardless', () => {
    const start = 1_000;
    const alive = planCampaignReadyDeadline({ startedAtMs: start, lastProgressAtMs: start + 124_000, nowMs: start + 125_000 });
    assert.equal(alive.expired, false);
    assert.equal(alive.nextCheckMs, CAMPAIGN_READY_STALL_MS - 1_000);

    const stalled = planCampaignReadyDeadline({ startedAtMs: start, lastProgressAtMs: start + 10_000, nowMs: start + 10_000 + CAMPAIGN_READY_STALL_MS });
    assert.equal(stalled.expired, true);
    assert.equal(stalled.reason, 'stall');

    const capped = planCampaignReadyDeadline({ startedAtMs: start, lastProgressAtMs: start + CAMPAIGN_READY_CAP_MS - 1, nowMs: start + CAMPAIGN_READY_CAP_MS });
    assert.equal(capped.expired, true);
    assert.equal(capped.reason, 'cap');

    // The next check lands on whichever limit comes first.
    const nearCap = planCampaignReadyDeadline({ startedAtMs: start, lastProgressAtMs: start + CAMPAIGN_READY_CAP_MS - 5_000, nowMs: start + CAMPAIGN_READY_CAP_MS - 5_000 });
    assert.equal(nearCap.nextCheckMs, 5_000);
});

function fakeTimers() {
    let clock = 0;
    const timers = new Map();
    let nextId = 1;
    return {
        now: () => clock,
        setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
        clearTimer: id => { timers.delete(id); },
        advance(ms) {
            const target = clock + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                clock = due[1].at;
                timers.delete(due[0]);
                due[1].fn();
            }
            clock = target;
        },
        pending: () => timers.size,
    };
}

test('a scene that keeps progressing outlives the old fixed deadline; one that stops fails on the stall', () => {
    const timers = fakeTimers();
    const expired = [];
    const watchdog = createCampaignReadyWatchdog({
        stallMs: 60_000,
        capMs: 300_000,
        now: timers.now,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        onExpire: (reason, elapsedMs) => expired.push({ reason, elapsedMs }),
    });
    // 144 corridor points arriving one every 20 s for 200 s: the old 125 s
    // deadline would have cut this off; the watchdog keeps waiting.
    for (let step = 1; step <= 10; step += 1) {
        timers.advance(20_000);
        assert.equal(watchdog.progress('bar', step / 144), true);
    }
    assert.deepEqual(expired, []);
    assert.equal(timers.now(), 200_000);
    // Then nothing for 60 s.
    timers.advance(60_000);
    assert.deepEqual(expired, [{ reason: 'stall', elapsedMs: 260_000 }]);
    assert.equal(watchdog.expired, true);
    assert.equal(timers.pending(), 0);
    // Late progress after expiry is ignored, so onExpire fires once.
    assert.equal(watchdog.progress('bar', 1), false);
    timers.advance(100_000);
    assert.equal(expired.length, 1);
});

test('equal or lower values are not progress, and the cap ends a trickle', () => {
    const timers = fakeTimers();
    const expired = [];
    const watchdog = createCampaignReadyWatchdog({
        stallMs: 60_000, capMs: 300_000,
        now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onExpire: reason => expired.push(reason),
    });
    assert.equal(watchdog.progress('bar', 0.5), true);
    timers.advance(30_000);
    assert.equal(watchdog.progress('bar', 0.5), false);
    assert.equal(watchdog.progress('bar', 0.4), false);
    assert.equal(watchdog.progress('bar', 'nope'), false);
    // A different stream keeps its own high-water mark: a pack value below the bar's still counts.
    assert.equal(watchdog.progress('pack', 0.1), true);
    timers.advance(30_000);
    timers.advance(30_000);
    assert.deepEqual(expired, ['stall']);

    const trickle = fakeTimers();
    const capped = [];
    const slow = createCampaignReadyWatchdog({
        stallMs: 60_000, capMs: 300_000,
        now: trickle.now, setTimer: trickle.setTimer, clearTimer: trickle.clearTimer,
        onExpire: reason => capped.push(reason),
    });
    for (let step = 1; step <= 12; step += 1) { trickle.advance(30_000); slow.progress('bar', step); }
    assert.deepEqual(capped, ['cap']);
});

test('dispose stops the watchdog without firing', () => {
    const timers = fakeTimers();
    let fired = 0;
    const watchdog = createCampaignReadyWatchdog({
        stallMs: 1_000, capMs: 5_000,
        now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onExpire: () => { fired += 1; },
    });
    watchdog.dispose();
    timers.advance(10_000);
    assert.equal(fired, 0);
    assert.equal(timers.pending(), 0);
});

test('a polled activity counter keeps a scene alive through a long queue drain the bar does not show', () => {
    const timers = fakeTimers();
    const expired = [];
    let serial = 0;
    const watchdog = createCampaignReadyWatchdog({
        stallMs: 60_000, capMs: 300_000, pollMs: 2_000,
        poll: () => serial,
        now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onExpire: reason => expired.push(reason),
    });
    // 150 s of a queue working every frame with the chapter bar frozen.
    for (let t = 0; t < 150_000; t += 2_000) { serial += 1; timers.advance(2_000); }
    assert.deepEqual(expired, []);
    watchdog.dispose();
    // The engine goes quiet: the stall fires 60 s later, and a throwing poll is just no progress.
    let throwing = false;
    const quiet = createCampaignReadyWatchdog({
        stallMs: 60_000, capMs: 300_000, pollMs: 2_000,
        poll: () => { if (throwing) throw new Error('gone'); return 7; },
        now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onExpire: reason => expired.push(reason),
    });
    throwing = true;
    timers.advance(59_000);
    assert.deepEqual(expired, []);
    timers.advance(2_000);
    assert.deepEqual(expired, ['stall']);
    quiet.dispose();
});
