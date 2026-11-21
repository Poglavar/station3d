// Verifies independent Station3D layers survive sibling failures and recover in place.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLayerStartupCoordinator } from '../core/layer-startup.js';

test('one failed layer does not block later layers and retries to recovery', async () => {
    const fragile = { name: 'fragile' };
    const healthy = { name: 'healthy' };
    let now = 0;
    let fragileAttempts = 0;
    const active = [];
    const failures = [];
    const recoveries = [];
    const cleanups = [];
    const coordinator = createLayerStartupCoordinator({
        now: () => now,
        retryBaseMs: 100,
        retryMaxMs: 100,
        begin: async (entry) => {
            if (entry === fragile && ++fragileAttempts === 1) {
                throw new Error('terrain unavailable');
            }
        },
        cleanup: async (entry, error) => {
            cleanups.push({ entry, error });
        },
        onActive: entry => active.push(entry),
        onFailure: (entry, error) => failures.push({ entry, error }),
        onRecovery: entry => recoveries.push(entry),
    });

    const [fragileStarted, healthyStarted] = await Promise.all([
        coordinator.start(fragile),
        coordinator.start(healthy),
    ]);
    assert.equal(fragileStarted, false);
    assert.equal(healthyStarted, true);
    assert.deepEqual(active, [healthy]);
    assert.equal(failures.length, 1);
    assert.equal(cleanups.length, 1);
    assert.deepEqual(coordinator.getSnapshot(), {
        loaded: 1,
        pending: 0,
        retrying: 1,
        failed: 1,
    });

    now = 99;
    coordinator.tick();
    await Promise.resolve();
    assert.equal(fragileAttempts, 1);

    now = 100;
    coordinator.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fragileAttempts, 2);
    assert.deepEqual(recoveries, [fragile]);
    assert.deepEqual(active, [healthy, fragile]);
    assert.deepEqual(coordinator.getSnapshot(), {
        loaded: 2,
        pending: 0,
        retrying: 0,
        failed: 0,
    });

    coordinator.dispose();
});

test('a layer that finishes after disposal is cleaned up instead of activated', async () => {
    const entry = { name: 'late' };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const active = [];
    const cleanups = [];
    const coordinator = createLayerStartupCoordinator({
        begin: async () => gate,
        cleanup: async layer => cleanups.push(layer),
        onActive: layer => active.push(layer),
    });

    const start = coordinator.start(entry);
    coordinator.dispose();
    release();
    assert.equal(await start, false);
    assert.deepEqual(active, []);
    assert.deepEqual(cleanups, [entry]);
});
