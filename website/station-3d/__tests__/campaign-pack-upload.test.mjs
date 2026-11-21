import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMPAIGN_PACK_UPLOAD_SLICE_MS, uploadCampaignPackPackets } from '../core/campaign-pack-upload.js';
import { getFrameChunkSchedulerSnapshot } from '../core/frame-chunk-queue.js';

// A fake clock and frame source: `spend` advances time inside a step, `frame`
// releases one pending yield, `frames` counts how many yields happened.
function harness() {
    let time = 0;
    const waiters = [];
    return {
        spend: ms => { time += ms; },
        now: () => time,
        yieldFrame: () => new Promise(resolve => waiters.push(resolve)),
        frame: () => { const next = waiters.shift(); assert.ok(next, 'unfinished work must wait for a frame'); next(); },
        pending: () => waiters.length,
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const entriesOf = n => Array.from({ length: n }, (_, packetIndex) => ({ chunkKey: 'c', packetIndex }));

test('the level builds in large slices, not one primitive per display frame', async () => {
    const clock = harness();
    let steps = 0;
    const published = [];
    const promise = uploadCampaignPackPackets(entriesOf(1), {
        createTask: () => ({
            step: count => { assert.equal(count, 1); steps += 1; clock.spend(2); return steps === 100; },
            result: () => 'packet',
            dispose() {},
        }),
        publish: value => published.push(value),
        now: clock.now,
        yieldFrame: clock.yieldFrame,
    });
    await settle();
    // 100 primitives at 2 ms each = 200 ms of work: five 40 ms slices, not a
    // hundred frames. The first slice runs synchronously before any yield.
    assert.equal(steps, CAMPAIGN_PACK_UPLOAD_SLICE_MS / 2, 'a slice holds the thread for the whole allowance');
    assert.deepEqual(published, [], 'a half-built packet is never published');
    let frames = 0;
    while (steps < 100) { clock.frame(); frames += 1; await settle(); }
    assert.equal(frames, 4);
    clock.frame();   // the final yield before the caller publishes the world
    await promise;
    assert.deepEqual(published, ['packet']);
    assert.equal(clock.pending(), 0);
    assert.equal(getFrameChunkSchedulerSnapshot().queues.some(q => q.label === 'campaign-pack-upload'), false,
        'the level build does not sit in the interactive streaming scheduler');
});

test('progress reports every published packet against the total', async () => {
    const clock = harness();
    const progress = [];
    const promise = uploadCampaignPackPackets(entriesOf(3), {
        createTask: entry => ({ step: () => true, result: () => entry.packetIndex, dispose() {} }),
        publish() {},
        onProgress: report => progress.push({ ...report }),
        now: clock.now,
        yieldFrame: clock.yieldFrame,
    });
    await settle();
    clock.frame();
    await promise;
    assert.deepEqual(progress, [{ uploaded: 1, total: 3 }, { uploaded: 2, total: 3 }, { uploaded: 3, total: 3 }]);
});

test('leaving during a level build cancels further work and disposes its unfinished task', async () => {
    const clock = harness();
    const controller = new AbortController();
    let disposed = 0;
    let published = 0;
    const promise = uploadCampaignPackPackets(entriesOf(2), {
        signal: controller.signal,
        createTask: () => ({ step: () => { clock.spend(50); return false; }, dispose: () => { disposed += 1; } }),
        publish: () => { published += 1; },
        now: clock.now,
        yieldFrame: clock.yieldFrame,
    });
    await settle();
    controller.abort();
    clock.frame();
    await assert.rejects(promise, error => error.name === 'AbortError');
    assert.equal(disposed, 1);
    assert.equal(published, 0);
    assert.equal(clock.pending(), 0);
});

test('an abort after the last upload still prevents the caller from publishing the world', async () => {
    const clock = harness();
    const controller = new AbortController();
    const promise = uploadCampaignPackPackets(entriesOf(1), {
        signal: controller.signal,
        createTask: () => ({ step: () => true, result: () => 'packet', dispose() {} }),
        publish() {},
        now: clock.now,
        yieldFrame: clock.yieldFrame,
    });
    await settle();
    controller.abort();
    clock.frame();
    await assert.rejects(promise, error => error.name === 'AbortError');
    assert.equal(clock.pending(), 0);
});

test('a starved animation frame does not stall the build', async () => {
    const original = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
    globalThis.requestAnimationFrame = () => 1;      // never fires: hidden tab
    globalThis.cancelAnimationFrame = () => {};
    try {
        const { yieldCampaignPackUploadFrame } = await import('../core/campaign-pack-upload.js');
        const started = Date.now();
        await yieldCampaignPackUploadFrame();
        assert.ok(Date.now() - started < 2000, 'the timer fallback releases the yield');
    } finally {
        globalThis.requestAnimationFrame = original.raf;
        globalThis.cancelAnimationFrame = original.caf;
    }
});
