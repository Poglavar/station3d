// Stationary-delivery liveness: tiles parked behind a published generation's
// delivery barrier must reach their layer without the observer moving.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTileSession } from '../core/shared-tile-session.js';
import { createHeldDeliveryWake } from '../core/held-delivery-wake.js';

async function waitFor(predicate, message = 'condition did not become true') {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// One handoff generation, as ground-source-admission runs it: drain the queue,
// arm the barrier handoff, publish, release.
async function runGeneration(session, key) {
    const hold = session.holdSources([key], { drainQueued: true, handoffDelivery: true });
    await waitFor(() => hold.isReady(), 'generation admission did not seal');
    hold.armHandoff();
    hold.release();
}

function createFixture() {
    const controller = new AbortController();
    const session = createSharedTileSession({ anchorLat: 45.81, anchorLon: 15.97, fetchController: controller });
    const source = session.getSource({ key: 'roads:curbs', ring: 0, keepRing: 4,
        loadPayload: async ({ tileKey }) => ({ features: [{ id: tileKey }] }) });
    const delivered = [];
    source.subscribe({ onFetch: (_features, key) => { delivered.push(key); } });
    const close = () => { controller.abort(); session.abort(); };
    return { session, source, delivered, close };
}

test('a published handoff parks later callbacks behind a barrier the session reports', async () => {
    const { session, source, delivered, close } = createFixture();
    try {
        await runGeneration(session, 'roads:curbs');
        assert.equal(source.admissionBarrier != null, true);
        source.fetchTile(1, 0); source.pumpFetchQueue();
        await waitFor(() => source.pendingCallbacks.size === 1, 'callback was not queued');
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.deepEqual(delivered, [], 'the barrier admits nothing on its own');
        assert.equal(session.heldSourceDeliveries(['roads:curbs', 'missing']), 1);
        await runGeneration(session, 'roads:curbs');
        await waitFor(() => delivered.includes('1_0'), 'the next admission did not deliver the held tile');
        assert.equal(session.heldSourceDeliveries(['roads:curbs']), 0);
    } finally { close(); }
});

test('without a wake a stationary session never delivers held tiles; with it they drain', async () => {
    for (const withWake of [false, true]) {
        const { session, source, delivered, close } = createFixture();
        try {
            await runGeneration(session, 'roads:curbs');
            source.fetchTile(2, 0); source.fetchTile(3, 0); source.pumpFetchQueue();
            await waitFor(() => source.pendingCallbacks.size === 2);
            let pendingChange = false, published = 1;
            const wake = createHeldDeliveryWake({
                countHeld: () => session.heldSourceDeliveries(['roads:curbs']),
                isIdle: () => !pendingChange,
                publishedCount: () => published,
                wake: () => { pendingChange = true; },
            });
            for (let frame = 0; frame < 30; frame++) {
                if (withWake) wake.onFrame();
                if (pendingChange) {
                    await runGeneration(session, 'roads:curbs');
                    published += 1; pendingChange = false;
                }
                await tick();
            }
            if (withWake) {
                await waitFor(() => delivered.length === 2, 'woken generation did not deliver');
                assert.equal(session.heldSourceDeliveries(['roads:curbs']), 0);
                assert.equal(wake.snapshot().stalled, false);
            } else {
                assert.deepEqual(delivered, [], 'the deadlock this wake exists to break');
                assert.equal(session.heldSourceDeliveries(['roads:curbs']), 2);
            }
        } finally { close(); }
    }
});

test('the wake only fires when idle and stops on a publication that makes no progress', () => {
    let idle = false, held = 3, published = 5, wakes = 0;
    const wake = createHeldDeliveryWake({ countHeld: () => held, isIdle: () => idle,
        publishedCount: () => published, wake: () => { wakes += 1; idle = false; } });
    assert.equal(wake.onFrame(), false, 'busy coordinator is left alone');
    idle = true;
    assert.equal(wake.onFrame(), true); assert.equal(wakes, 1);
    assert.equal(wake.onFrame(), false, 'no second wake while the woken generation runs');
    // Its generation publishes but the held count did not drop: a stall, not a loop.
    idle = true; published = 6;
    assert.equal(wake.onFrame(), false);
    assert.equal(wake.snapshot().stalled, true);
    assert.equal(wake.onFrame(), false); assert.equal(wakes, 1);
    // Some other generation publishes: one more attempt is allowed.
    published = 7;
    assert.equal(wake.onFrame(), true); assert.equal(wakes, 2);
    // Progress keeps it going; draining resets it.
    idle = true; published = 8; held = 1;
    assert.equal(wake.onFrame(), true); assert.equal(wakes, 3);
    idle = true; held = 0;
    assert.equal(wake.onFrame(), false);
    assert.deepEqual(wake.snapshot(), { wakes: 3, stalled: false, lastWakeHeld: null });
});

test('a woken generation that fails is reported as stalled and not hammered', () => {
    let idle = true, wakes = 0;
    const wake = createHeldDeliveryWake({ countHeld: () => 2, isIdle: () => idle,
        publishedCount: () => 4, wake: () => { wakes += 1; } });
    assert.equal(wake.onFrame(), true);
    assert.equal(wake.onFrame(), false);
    assert.equal(wake.snapshot().stalled, true);
    assert.equal(wakes, 1);
    assert.throws(() => createHeldDeliveryWake({ countHeld: () => 0 }), TypeError);
});
