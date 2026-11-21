import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroundConsumerSteps } from '../core/ground-consumer-preparation.js';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundGenerationCoordinator } from '../core/ground-generation-coordinator.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM,
    resetFrameChunkObserver, setFrameChunkSchedulerMode } from '../core/frame-chunk-queue.js';

function drain(steps) { for (let i = 0; i < 10000; i++) { const next = steps.next(); if (next.done) return next.value; } assert.fail('unbounded preparation'); }
const limits = { maxOwners: 8, maxCells: 32, maxCellParts: 128 };
const bounds = x => ({ minX: x - 5, maxX: x + 5, minZ: -5, maxZ: 5 });
const part = (x, y) => ({ drivable: true, positions: new Float32Array([
    x - 2, y, -2, x + 2, y, -2, x, y, 2,
]) });

test('consumer recapture preserves the private world through movement, busy admission, rollback and retry', () => {
    const roads = createRenderedRoadSurfaceRegistry(), registry = createSurfacePublicationRegistry();
    roads.replace('changed', [part(0, 1), part(500, 1)]);
    let worldPreparations = 0, center = 0, admitted = false, leases = 0, allocations = 0;
    let livePhysics = { center: 0, y: 1 }, consumerRevision = 0, busy = true;
    const world = drain((function* () {
        worldPreparations++;
        return yield* roads.preparePublicationSteps([roads.prepare('changed', [part(0, 3), part(500, 3)])], limits);
    })());
    const make = () => prepareGroundConsumerSteps({ isCurrent: world.isCurrent,
        capture() {
            if (busy) return null;
            assert.equal(admitted, false); admitted = true; leases++;
            const revision = consumerRevision, capturedCenter = center;
            let held = true;
            return { bounds: bounds(center), isCurrent: () => held && consumerRevision === revision,
                release() { if (!held) return; held = false; admitted = false; leases--; },
                *prepareSteps(reads, isCurrent) {
                    const y = reads.road.supportYAt(capturedCenter, 0), previous = livePhysics;
                    allocations++;
                    yield { phase: 'private-collider' };
                    let settled = false, committed = false;
                    return { entry: { clear: true, isCurrent,
                        commit() { livePhysics = { center: capturedCenter, y }; committed = true; return true; },
                        rollback() { livePhysics = previous; committed = false; },
                        discard() { assert.equal(committed, false); if (!settled) { settled = true; allocations--; } },
                    }, finalize() { assert.equal(committed, true); settled = true; allocations--; return true; } };
                },
            };
        },
        *prepareReadSteps(region, isCurrent) {
            const read = yield* world.captureReadSnapshotSteps(region.bounds, { ...limits, isCurrent });
            return read && { reads: { road: read }, isCurrent: read.isCurrent, release: read.release };
        },
    });
    const steps = make();
    assert.equal(steps.next().value.deferFrame, true, 'ordinary moving physics can finish before admission');
    busy = false;
    for (let i = 0; i < 1000; i++) {
        const next = steps.next(); assert.equal(next.done, false);
        assert.equal(roads.supportYAt(0, 0), 1); assert.equal(livePhysics.y, 1);
        if (next.value?.phase === 'private-collider') break;
    }
    assert.equal(allocations, 1);
    center = 500; consumerRevision++;
    assert.equal(steps.next().value.phase, 'ground-consumer-recapture');
    assert.equal(allocations, 0); assert.equal(leases, 0); assert.equal(roads.debugState().readSnapshots, 0);
    assert.equal(world.isCurrent(), true, 'movement did not discard world preparation');
    const consumer = drain(steps);
    assert.equal(worldPreparations, 1); assert.equal(consumer.isCurrent(), true);
    assert.equal(leases, 1); assert.equal(allocations, 1);
    let observations = 0;
    registry.subscribe(() => observations++);
    const entries = [
        { ticket: registry.begin({ key: 'road', generation: 1 }), clear: true,
            isCurrent: world.isCurrent, commit: world.commit, rollback: world.rollback },
        { ...consumer.entry, ticket: registry.begin({ key: 'physics', generation: 1 }) },
    ];
    assert.throws(() => registry.prepareBatch(entries, { commit() { throw Error('later member failed'); } }).publish(), /later member/);
    consumer.discard();
    assert.equal(world.isCurrent(), true); assert.equal(roads.supportYAt(500, 0), 1);
    assert.deepEqual(livePhysics, { center: 0, y: 1 }); assert.equal(observations, 0);
    assert.equal(leases, 0); assert.equal(allocations, 0);
    const retry = drain(make());
    const batch = registry.prepareBatch([
        { ...entries[0], ticket: registry.begin({ key: 'road', generation: 2 }) },
        { ...retry.entry, ticket: registry.begin({ key: 'physics', generation: 2 }) },
    ], { isCurrent: retry.isCurrent });
    assert.equal(batch.publish().status, 'published');
    assert.equal(retry.finalize(), true); assert.equal(world.finalize(), true);
    assert.equal(roads.supportYAt(500, 0), 3); assert.deepEqual(livePhysics, { center: 500, y: 3 });
    assert.equal(worldPreparations, 1); assert.equal(leases, 0); assert.equal(allocations, 0);
    assert.equal(roads.debugState().readSnapshots, 0); registry.close(); roads.clear();
});

test('consumer cancellation and empty admission release their window without creating support', () => {
    let held = 0, active = true;
    const steps = prepareGroundConsumerSteps({ isCurrent: () => active,
        capture: () => ({ isCurrent: () => true, release() { held--; } }),
        *prepareReadSteps() { held++; yield { phase: 'reading' }; assert.fail('cancelled'); },
    });
    assert.equal(steps.next().done, false); steps.return(); assert.equal(held, 0);
    const empty = drain(prepareGroundConsumerSteps({ isCurrent: () => active,
        capture: () => ({ empty: true, isCurrent: () => active }),
        *prepareReadSteps() { assert.fail('an absent consumer needs no geometry'); },
    }));
    assert.equal(empty.entry, null); assert.equal(empty.isCurrent(), true);
    active = false; assert.equal(empty.isCurrent(), false); empty.discard();
});

test('ground preparation spends its bounded time slice on cheap compiler steps instead of a frame-count throttle', async () => {
    const previousPerformance = globalThis.performance, previousRaf = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame, callbacks = [];
    let now = 0, visits = 0;
    globalThis.performance = { now: () => now };
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    globalThis.cancelAnimationFrame = () => {};
    setFrameChunkSchedulerMode('legacy'); resetFrameChunkObserver();
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const queue = createFrameChunkQueue({ frameBudgetMs: 2, pauseDuringMovement: false,
        preferAnimationFrame: true, trackWorldReady: false });
    const coordinator = createGroundGenerationCoordinator({ queue, repeat: FRAME_CHUNK_REPEAT_ITEM,
        defer: FRAME_CHUNK_DEFER_ITEM, registry, boundary, now: () => now,
        *prepareSteps({ generation }) {
            for (let i = 0; i < 4096; i++) { visits++; now += .005; yield; }
            return { entries: [{ ticket: registry.begin({ key: 'world', generation }), clear: true }],
                isCurrent: () => true, finalize: () => true, discard() {} };
        },
    });
    try {
        coordinator.invalidate('terrain'); coordinator.onFrame({});
        callbacks.shift()();
        assert.ok(visits > 64, `only ${visits} cheap visits were admitted`);
        assert.ok(now <= 2.006, `time slice exceeded the deadline: ${now}`);
        let frames = 1;
        while (callbacks.length && frames < 16) { now += 16; callbacks.shift()(); frames++; }
        assert.equal(visits, 4096); assert.ok(frames <= 12);
        boundary.publishReady(); await Promise.resolve();
        assert.equal(coordinator.snapshot().published, 1);
    } finally {
        coordinator.close(); queue.dispose(); boundary.close(); registry.close(); resetFrameChunkObserver();
        globalThis.performance = previousPerformance; globalThis.requestAnimationFrame = previousRaf;
        globalThis.cancelAnimationFrame = previousCancel;
    }
});
