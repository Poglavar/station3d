// Verifies that tile invalidation bursts cannot repeatedly cancel active work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileBuildGenerationController } from '../core/tile-build-generation.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test('coalesces an invalidation burst into one active and one follow-up build', async () => {
    const builds = [];
    const controller = createTileBuildGenerationController({
        startBuild: (tileKey, generation) => {
            const work = deferred();
            builds.push({ tileKey, generation, ...work });
            return work;
        },
    });
    const first = controller.request('0_0');
    const second = controller.request('0_0');
    const third = controller.request('0_0');
    assert.equal(builds.length, 1);
    assert.deepEqual(controller.snapshot(), [{
        tileKey: '0_0',
        desiredGeneration: 3,
        runningGeneration: 1,
        running: true,
        followUpPending: true,
        waitingRequests: 3,
    }]);

    builds[0].resolve();
    await first;
    await Promise.resolve();
    assert.equal(builds.length, 2);
    assert.equal(builds[1].generation, 3);
    builds[1].resolve();
    await Promise.all([second, third]);
    assert.deepEqual(controller.snapshot(), []);
});

test('cancellation stops active work and resolves every waiter as cancelled', async () => {
    const work = deferred();
    let cancelled = 0;
    const controller = createTileBuildGenerationController({
        startBuild: () => ({ promise: work.promise, cancel: () => { cancelled += 1; } }),
    });
    const first = controller.request('1_2');
    const second = controller.request('1_2');
    controller.cancel('1_2');
    assert.equal(cancelled, 1);
    assert.equal((await first).cancelled, true);
    assert.equal((await second).cancelled, true);
    assert.deepEqual(controller.snapshot(), []);
});

test('a failed generation rejects its waiters without stalling a newer request', async () => {
    const builds = [];
    const controller = createTileBuildGenerationController({
        startBuild: (_tileKey, generation) => {
            const work = deferred();
            builds.push({ generation, ...work });
            return work;
        },
    });
    const first = controller.request('3_4');
    const second = controller.request('3_4');
    builds[0].reject(new Error('failed generation'));
    await assert.rejects(first, /failed generation/);
    await Promise.resolve();
    assert.equal(builds[1].generation, 2);
    builds[1].resolve();
    await second;
    assert.deepEqual(controller.snapshot(), []);
});
