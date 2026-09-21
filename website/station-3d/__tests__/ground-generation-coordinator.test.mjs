import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundGenerationCoordinator, preparationPhaseKey } from '../core/ground-generation-coordinator.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';

function harness(t, behavior = {}) {
    const jobs = [], errors = [], registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    t.after(() => { for (const job of jobs) job.cancelled = true; boundary.close(); registry.close({ retireActive: true }); });
    const queue = { enqueue(items, fn, options) { const job = { items, fn, options, cancelled: false }; jobs.push(job); return job; }, cancel(job) { if (job) { job.cancelled = true; job.options.onCancel?.(); } } };
    const repeat = Symbol('repeat'), defer = Symbol('defer'), wait = Symbol('wait');
    const coordinator = createGroundGenerationCoordinator({ queue, repeat, defer, wait, registry, boundary,
        ...(behavior.admit ? { admit: behavior.admit } : {}),
        ...(behavior.windowMoveM === undefined ? {} : { windowMoveM: behavior.windowMoveM }),
        ...(behavior.priorityFamilies === undefined ? {} : { priorityFamilies: behavior.priorityFamilies }),
        ...(behavior.preemptForPriority === undefined ? {} : { preemptForPriority: behavior.preemptForPriority }),
        ...(behavior.deferNonPriority === undefined ? {} : { deferNonPriority: behavior.deferNonPriority }),
        ...(behavior.onPublished === undefined ? {} : { onPublished: behavior.onPublished }),
        prepareSteps: behavior.prepareSteps || function* ({ generation }) {
            yield { phase: 'yielded' };
            const ticket = registry.begin({ key: `family:${generation}`, generation });
            return { entries: [{ ticket, clear: true, commit: () => true, rollback: () => {}, discard: () => {} }],
                isCurrent: () => true, finalize: () => true, discard: () => {} };
        }, now: behavior.now || (() => 1000), onError: behavior.onError || (error => errors.push(error)) });
    const pump = () => { const job = jobs.find(item => !item.cancelled); if (!job) return; try { const result = job.fn(job.items[0]); if (result === undefined) job.cancelled = true; return result; } catch (error) { job.cancelled = true; job.options.onError?.(error); } };
    return { coordinator, jobs, boundary, registry, pump, errors, repeat, defer, wait };
}

test('reports the committed ground publication once with its exact generation metadata', async t => {
    const publications = [];
    const h = harness(t, { onPublished: publication => publications.push(publication) });
    h.coordinator.invalidate('bootstrap');
    h.coordinator.onFrame({ x: 0, z: 0 });
    h.pump(); h.pump(); h.boundary.publishReady();
    await Promise.resolve();
    assert.equal(publications.length, 1);
    assert.equal(publications[0], h.coordinator.snapshot().lastPublication);
    assert.deepEqual(publications[0].families, ['bootstrap']);
});

test('incoming invalidation is retained for the next generation while current preparation publishes', async t => {
    const h = harness(t); h.coordinator.invalidate('terrain', { bounds: [{ minX: 0, minZ: 0, maxX: 1, maxZ: 1 }] }); h.coordinator.onFrame({ x: 0, z: 0 });
    h.pump(); h.coordinator.invalidate('roads', { keys: ['tile-2'] }); h.pump(); h.pump(); h.boundary.publishReady(); h.pump(); h.boundary.publishReady();
    await Promise.resolve(); assert.equal(h.coordinator.snapshot().published, 1); assert.ok(h.coordinator.snapshot().pending >= 1);
    assert.equal(h.coordinator.isSettled(), false, 'a published predecessor does not complete pending startup work');
    assert.equal(h.coordinator.snapshot().lastPublication.generation, 1);
    assert.deepEqual(h.coordinator.snapshot().lastPublication.families, ['terrain']);
});

test('capacity failures stay latched at one center but a moved ground window coalesces a retry', t => {
    for (const failure of [
        Object.assign(new Error('capacity'), { code: 'ground-generation-capacity' }),
        Object.assign(new Error('compiler capacity'), { code: 'compiler-failed', details: { code: 'ground-topology-capacity' } }),
        Object.assign(new Error('Terrain storage boundary did not stabilize'), { code: 'compiler-failed', details: { code: 'ground-topology-precision' } }),
    ]) {
        let clock = 1000, attempts = 0;
        const h = harness(t, { windowMoveM: 400, now: () => clock, prepareSteps: function* () {
            attempts++; throw failure;
        } });
        h.coordinator.invalidate('ground-window'); h.coordinator.onFrame({ x: 0, z: 0 }); h.pump();
        clock += 501; h.coordinator.onFrame({ x: 0, z: 0 }); assert.equal(attempts, 1);
        h.coordinator.onFrame({ x: 399, z: 0 }); assert.equal(attempts, 1);
        h.coordinator.onFrame({ x: 400, z: 0 }); h.pump(); assert.equal(attempts, 2);
        h.coordinator.onFrame({ x: 400, z: 0 }); assert.equal(attempts, 2);
        h.coordinator.onFrame({ x: 800, z: 0 }); h.pump(); assert.equal(attempts, 3);
    }
});

test('camera moves coalesce behind active preparation without cancelling it', async t => {
    let visits = 0, h, captured = [];
    h = harness(t, { windowMoveM: 400, prepareSteps: function* ({ changes, local }) {
        visits++; captured.push({ changes, local }); yield { phase: 'held' };
        const ticket = h.registry.begin({ key: `camera:${visits}`, generation: visits });
        return { entries: [{ ticket, clear: true, commit: () => {}, discard: () => {} }], isCurrent: () => true, finalize: () => true, discard: () => {} };
    } });
    h.coordinator.onFrame({ x: 0, z: 0 }); h.coordinator.invalidate('ground-window'); h.coordinator.onFrame({ x: 0, z: 0 }); h.pump();
    h.coordinator.onFrame({ x: 400, z: 0 }); h.coordinator.onFrame({ x: 800, z: 0 });
    assert.equal(h.jobs[0].cancelled, false, 'the captured job remains runnable');
    h.pump(); h.boundary.publishReady();
    await Promise.resolve();
    assert.equal(visits, 1); assert.equal(h.coordinator.snapshot().published, 1);
    h.coordinator.onFrame({ x: 800, z: 0 }); h.pump(); h.pump();
    assert.equal(visits, 2); assert.equal(captured[0].local.x, 0); assert.equal(captured[1].local.x, 800);
    assert.deepEqual(captured[1].changes.map(change => change.family), ['ground-window']);
    assert.equal(h.coordinator.snapshot().waitingPublication, 1);
    h.boundary.publishReady(); await Promise.resolve();
    h.coordinator.onFrame({ x: 800, z: 0 });
    assert.equal(h.coordinator.snapshot().generation, 2);
    assert.equal(h.coordinator.snapshot().rejected, 0);
    assert.equal(h.coordinator.isSettled(), true);
});

test('a residency obligation preempts private mixed work and publishes before the restored source change', async t => {
    let h;
    const captured = [];
    h = harness(t, {
        priorityFamilies: ['terrain-window', 'ground-window'],
        preemptForPriority: true,
        prepareSteps: function* ({ changes, generation }) {
            captured.push(changes.map(change => change.family));
            yield { phase: 'held' };
            const ticket = h.registry.begin({ key: `priority:${generation}`, generation });
            return { entries: [{ ticket, clear: true, commit() {}, rollback() {}, discard() {} }],
                isCurrent: () => true, finalize: () => true, discard() {} };
        },
    });
    h.coordinator.invalidate('bootstrap'); h.coordinator.onFrame({}); h.pump(); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    h.coordinator.invalidate('roads', { keys: ['4_2'] }); h.coordinator.onFrame({}); h.pump();
    h.coordinator.invalidate('terrain-window', { keys: ['8_3'] }); h.coordinator.onFrame({});
    assert.equal(h.coordinator.snapshot().preempted, 1);
    assert.equal(h.coordinator.snapshot().preparing, 1);
    h.pump(); h.pump(); h.boundary.publishReady(); await Promise.resolve();
    assert.deepEqual(captured, [['bootstrap'], ['roads'], ['terrain-window']]);
    assert.equal(h.coordinator.snapshot().pending, 1, 'the preempted road obligation remains pending');
    assert.deepEqual(h.coordinator.snapshot().lastPublication.families, ['terrain-window']);
    assert.equal(h.coordinator.snapshot().rejected, 0, 'expected preemption is not a rejected generation');
});

test('a priority terrain revision is coalesced with its residency window', async t => {
    let h;
    const captured = [];
    h = harness(t, {
        priorityFamilies: ['terrain-window', 'ground-window', 'terrain'],
        prepareSteps: function* ({ changes, generation }) {
            captured.push(changes.map(change => change.family));
            const ticket = h.registry.begin({ key: `terrain-window:${generation}`, generation });
            return { entries: [{ ticket, clear: true, commit() {}, rollback() {}, discard() {} }],
                isCurrent: () => true, finalize: () => true, discard() {} };
        },
    });
    h.coordinator.invalidate('bootstrap'); h.coordinator.onFrame({}); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    h.coordinator.invalidate('roads', { keys: ['4_2'] });
    h.coordinator.invalidate('terrain-window', { keys: ['8_3'] });
    h.coordinator.invalidate('terrain', { keys: ['8_3'] });
    h.coordinator.onFrame({}); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    assert.deepEqual(captured, [['bootstrap'], ['terrain-window', 'terrain']]);
    assert.equal(h.coordinator.snapshot().pending, 1, 'unrelated road work remains a successor');
    assert.deepEqual(h.coordinator.snapshot().lastPublication.families, ['terrain-window', 'terrain']);
});

test('high-speed policy defers physical source work but still admits priority residency', async t => {
    let h;
    const captured = [];
    h = harness(t, {
        priorityFamilies: ['terrain-window', 'ground-window'],
        deferNonPriority: position => position?.highSpeed === true,
        prepareSteps: function* ({ changes, generation }) {
            captured.push(changes.map(change => change.family));
            const ticket = h.registry.begin({ key: `defer:${generation}`, generation });
            return { entries: [{ ticket, clear: true, commit() {}, rollback() {}, discard() {} }],
                isCurrent: () => true, finalize: () => true, discard() {} };
        },
    });
    h.coordinator.invalidate('bootstrap'); h.coordinator.onFrame({}); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    h.coordinator.invalidate('roads', { keys: ['5_2'] });
    h.coordinator.onFrame({ highSpeed: true });
    assert.equal(h.coordinator.snapshot().preparing, 0);
    h.coordinator.invalidate('ground-window'); h.coordinator.onFrame({ highSpeed: true }); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    assert.deepEqual(captured, [['bootstrap'], ['ground-window']]);
    assert.equal(h.coordinator.snapshot().pending, 1);
    h.coordinator.onFrame({ highSpeed: false }); h.pump();
    assert.deepEqual(captured, [['bootstrap'], ['ground-window'], ['roads']]);
});

test('initial readiness includes admission and controller-boundary waits and rejects closed sessions', async t => {
    let admitted = false;
    const h = harness(t, { admit: () => admitted ? {} : null });
    assert.equal(h.coordinator.isSettled(), false, 'an unbuilt world is not ready');
    h.coordinator.invalidate('bootstrap'); h.coordinator.onFrame({});
    assert.equal(h.jobs.length, 0);
    assert.equal(h.coordinator.isSettled(), false, 'admission has no queued compiler job yet');
    admitted = true; h.coordinator.onFrame({}); h.pump(); h.pump();
    assert.equal(h.boundary.snapshot().pending, 1);
    assert.equal(h.coordinator.isSettled(), false, 'prepared geometry still needs its shared publication');
    h.boundary.publishReady(); await Promise.resolve();
    assert.equal(h.coordinator.isSettled(), true);
    h.coordinator.close();
    assert.equal(h.coordinator.isSettled(), false);
});

test('queued source callbacks join one sealed admission and later changes remain a successor', async t => {
    let ready = false, releases = 0, h;
    const inputs = [];
    const lease = { release() { releases++; } };
    h = harness(t, { admit: () => ready ? lease : null,
        prepareSteps: function* ({ admission, changes, generation }) {
            assert.equal(admission, lease);
            inputs.push(changes);
            yield { phase: 'captured' };
            return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
                commit() {}, discard() {} }], isCurrent: () => true, finalize: () => true, discard() {} };
        } });
    h.coordinator.invalidate('roads', { keys: ['first'] }); h.coordinator.onFrame({});
    h.coordinator.invalidate('roads', { keys: ['already-queued'] }); h.coordinator.onFrame({});
    assert.equal(h.jobs.length, 0); assert.equal(h.coordinator.snapshot().generation, 0);
    ready = true; h.coordinator.onFrame({}); h.pump();
    h.coordinator.invalidate('roads', { keys: ['later'] });
    h.pump(); h.boundary.publishReady(); await Promise.resolve();
    assert.deepEqual(inputs[0][0].keys, ['first', 'already-queued']);
    assert.equal(releases, 1); assert.equal(h.coordinator.snapshot().pending, 1);
    h.coordinator.onFrame({}); h.pump();
    assert.deepEqual(inputs[1][0].keys, ['later']);
    h.coordinator.close(); assert.equal(releases, 2);
});

test('closing before the first compiler visit releases source admission', t => {
    let releases = 0;
    const h = harness(t, { admit: () => ({ release() { releases++; } }),
        prepareSteps: function* () { assert.fail('the compiler must not run after close'); } });
    h.coordinator.invalidate('terrain'); h.coordinator.onFrame({});
    assert.equal(h.jobs.length, 1); h.coordinator.close();
    assert.equal(releases, 1); assert.equal(h.coordinator.snapshot().pending, 0);
});

test('preparation timings separate compiler CPU from readiness and frame-budget waits', async t => {
    let clock = 0, ready, h;
    const pending = new Promise(resolve => { ready = resolve; });
    h = harness(t, { now: () => clock, prepareSteps: function* ({ generation }) {
        clock += 2; yield { phase: 'receiver-capture 1/100' };
        clock += 1; yield { phase: 'gpu-compile', ready: pending };
        clock += 3;
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
            commit() {}, discard() {} }], isCurrent: () => true, finalize: () => true, discard() {} };
    } });
    h.coordinator.invalidate('terrain'); h.coordinator.onFrame({}); h.pump(); h.pump();
    clock += 5000; h.pump();
    assert.equal(h.coordinator.snapshot().preparationCpuMs, 3);
    ready(); await Promise.resolve(); clock += 20; h.pump();
    clock += 5; h.boundary.publishReady(); await Promise.resolve();
    const result = h.coordinator.snapshot().lastPublication;
    assert.equal(result.preparationMs, 5026); assert.equal(result.preparation.cpuMs, 6);
    assert.equal(result.preparation.readinessWaitMs, 5000);
    assert.equal(result.preparation.schedulerWaitMs, 20);
    assert.equal(result.publicationWaitMs, 5);
    assert.equal(result.preparation.steps, 3);
    assert.deepEqual(result.preparation.phases.map(row => [row.phase, row.cpuMs]),
        [['candidate-ready', 3], ['receiver-capture', 2], ['gpu-compile', 1]]);
    assert.deepEqual(result.preparation.phases.map(row => [row.phase, row.waitMs, row.schedulerMs]),
        [['candidate-ready', 0, 0], ['receiver-capture', 0, 0], ['gpu-compile', 5000, 20]],
        'each readiness wait and each wait for a turn is charged to the phase that yielded it');
});

test('readiness promises release the runnable queue share until they settle', async t => {
    let ready;
    const pending = new Promise(resolve => { ready = resolve; });
    const h = harness(t, { prepareSteps: function* ({ generation }) {
        yield { phase: 'gpu-ready', ready: pending };
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
            commit() {}, discard() {} }], isCurrent: () => true, finalize: () => true, discard() {} };
    } });
    h.coordinator.invalidate('terrain'); h.coordinator.onFrame({});
    assert.equal(h.pump(), h.wait, 'the yield enters dependency-wait state');
    assert.equal(h.pump(), h.wait, 'probes retain dependency-wait state');
    ready(); await Promise.resolve();
    assert.equal(h.pump(), undefined, 'the settled dependency resumes preparation');
    assert.equal(h.coordinator.snapshot().waitingPublication, 1);
});

test('polled producer dependencies release the runnable queue share without a promise', t => {
    let blocked = true;
    const h = harness(t, { prepareSteps: function* ({ generation }) {
        while (blocked) yield { phase: 'producer-slot', deferFrame: true, waitingForDependency: true };
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
            commit() {}, discard() {} }], isCurrent: () => true, finalize: () => true, discard() {} };
    } });
    h.coordinator.invalidate('terrain'); h.coordinator.onFrame({});
    assert.equal(h.pump(), h.wait);
    assert.equal(h.pump(), h.wait);
    blocked = false;
    assert.equal(h.pump(), undefined);
    assert.equal(h.coordinator.snapshot().waitingPublication, 1);
});

test('preparation failure restores obligation and capacity failure waits for new invalidation', async t => {
    let attempts = 0; const h = harness(t, { prepareSteps: function* () { yield { phase: 'yielded' }; attempts++; throw Object.assign(new Error('budget'), { code: 'ground-generation-capacity' }); } });
    h.coordinator.invalidate('terrain', { keys: ['a'] }); h.coordinator.onFrame({}); h.pump(); h.pump();
    await Promise.resolve(); assert.equal(h.coordinator.snapshot().failed, 1); assert.equal(h.coordinator.snapshot().capacityBlocked, true);
    h.coordinator.onFrame({}); assert.equal(attempts, 1); h.coordinator.invalidate('terrain', { keys: ['b'] }); h.coordinator.onFrame({}); h.pump(); h.pump(); assert.equal(attempts, 2);
});

test('close cancels active preparation and clears pending state', t => {
    const h = harness(t); h.coordinator.invalidate('terrain', { keys: ['a'] }); h.coordinator.onFrame({}); h.coordinator.close();
    assert.equal(h.coordinator.snapshot().closed, true); assert.equal(h.coordinator.snapshot().pending, 0); assert.equal(h.coordinator.snapshot().preparing, 0);
});

test('complete candidate validity is rechecked inside a new scope at the controller boundary', async t => {
    let valid = true, scopeDepth = 0, scopes = 0, commits = 0, discards = 0, h;
    h = harness(t, { prepareSteps: function* ({ generation }) {
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
            isCurrent: () => true, commit: () => { commits++; }, discard() {} }],
        isCurrent: () => valid,
        withValidationScope(check) { scopes++; scopeDepth++; try { return check(); } finally { scopeDepth--; } },
        finalize() { assert.fail('an expired complete candidate cannot publish'); }, discard() { discards++; } };
    } });
    h.coordinator.invalidate('terrain', { keys: ['changed'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(h.boundary.snapshot().pending, 1); assert.equal(scopes, 1); assert.equal(scopeDepth, 0);
    valid = false;
    h.boundary.publishReady(); await Promise.resolve();
    assert.equal(scopes, 2); assert.equal(scopeDepth, 0); assert.equal(commits, 0);
    assert.equal(discards, 1); assert.equal(h.coordinator.snapshot().published, 0);
    assert.equal(h.coordinator.snapshot().pending, 1, 'the source obligation survives a late group-level change');
    assert.equal(h.coordinator.snapshot().lastRejection.reason, 'boundary-dependency-revised');
    assert.deepEqual(h.coordinator.snapshot().lastRejection.families, ['terrain']);
});

test('failed multi-key publication rolls back and retries newer obligations atomically', async t => {
    let clock = 1000;
    let firstAttempt = true;
    const sourceKeys = [];
    const state = { a: 'old', b: 'old' };
    let discards = 0;
    let h;
    h = harness(t, {
        now: () => clock,
        prepareSteps: function* ({ changes, generation }) {
            sourceKeys.push(changes.flatMap(change => change.keys));
            yield { phase: 'preparing' };
            const entry = (key, field) => {
                const ticket = h.registry.begin({ key, generation });
                return { ticket, clear: true,
                    commit: () => {
                        if (field === 'b' && firstAttempt) throw new Error('second commit');
                        state[field] = 'new';
                    },
                    rollback: () => { state[field] = 'old'; },
                    discard: () => { discards += 1; } };
            };
            return { entries: [entry('family:a', 'a'), entry('family:b', 'b')],
                isCurrent: () => true, finalize: () => true, discard: () => {} };
        },
    });
    h.coordinator.invalidate('curbs', { keys: ['old-a'] });
    h.coordinator.onFrame({}); h.pump();
    h.coordinator.invalidate('curbs', { keys: ['newer'] });
    h.pump(); h.pump(); h.boundary.publishReady();
    await Promise.resolve();
    assert.deepEqual(state, { a: 'old', b: 'old' });
    assert.equal(h.coordinator.snapshot().lastPublication, null);
    assert.equal(discards, 2);
    assert.deepEqual(h.coordinator.snapshot().pending, 1);
    assert.deepEqual(sourceKeys[0], ['old-a']);
    clock += 501;
    firstAttempt = false;
    h.coordinator.onFrame({}); h.pump(); h.pump(); h.boundary.publishReady();
    await Promise.resolve();
    assert.deepEqual(state, { a: 'new', b: 'new' });
    assert.deepEqual(sourceKeys[1].sort(), ['newer', 'old-a'].sort());
    assert.equal(h.coordinator.snapshot().pending, 0);
    assert.equal(h.coordinator.snapshot().published, 1);
});

test('source-unavailable preparation stays blocked until a new invalidation arrives', t => {
    let clock = 1000, attempts = 0;
    const h = harness(t, { now: () => clock, prepareSteps: function* () {
        attempts += 1;
        throw Object.assign(new Error('missing source'), { code: 'evidence-unavailable' });
    } });
    h.coordinator.invalidate('roads', { keys: ['source-a'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(attempts, 1); assert.equal(h.coordinator.snapshot().sourceBlocked, true);
    clock += 501; h.coordinator.onFrame({}); assert.equal(attempts, 1);
    h.coordinator.invalidate('roads', { keys: ['source-b'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(attempts, 2); assert.equal(h.coordinator.snapshot().sourceBlocked, true);
});

test('a still-streaming source blocks until the next revision without counting or reporting a failure', t => {
    let clock = 1000, attempts = 0;
    const h = harness(t, { now: () => clock, prepareSteps: function* () {
        attempts += 1;
        throw Object.assign(new Error('Road alignment osm-469508851 lacks terrain evidence'), { code: 'road-alignment-terrain-incomplete' });
    } });
    h.coordinator.invalidate('roads', { keys: ['source-a'] }); h.coordinator.onFrame({}); h.pump();
    const snap = h.coordinator.snapshot();
    assert.equal(attempts, 1); assert.equal(snap.sourceBlocked, true); assert.equal(snap.failed, 0);
    assert.equal(snap.lastError.code, 'road-alignment-terrain-incomplete', 'the wait is still visible in the snapshot');
    assert.deepEqual(h.errors, [], 'nothing is reported: the terrain revision is on its way');
    clock += 501; h.coordinator.onFrame({}); assert.equal(attempts, 1, 'no timed retry either');
    h.coordinator.invalidate('terrain', { keys: ['cell-b'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(attempts, 2);
});

test('a queued terrain revision supersedes an active streaming-incomplete generation', t => {
    let attempts = 0, clock = 1000, h;
    h = harness(t, { now: () => clock, prepareSteps: function* ({ generation }) {
        attempts += 1;
        if (generation === 1) {
            yield { phase: 'road-generation:surface' };
            throw Object.assign(new Error('captured road point is outside immutable terrain'), {
                code: 'road-surface-terrain-incomplete',
            });
        }
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true,
            commit() {}, discard() {} }], isCurrent: () => true, finalize: () => true, discard() {} };
    } });
    h.coordinator.invalidate('roads', { keys: ['road-a'] });
    h.coordinator.onFrame({});
    assert.equal(h.pump(), h.repeat);
    h.coordinator.invalidate('terrain-window');
    h.pump();
    assert.equal(h.coordinator.snapshot().sourceBlocked, false,
        'the newer revision keeps restored work eligible instead of latching the old snapshot');
    clock += 501;
    h.coordinator.onFrame({});
    h.pump();
    assert.equal(attempts, 2);
    assert.equal(h.coordinator.snapshot().waitingPublication, 1);
});

test('publication finalization failure remains published and records the failure', async t => {
    for (const mode of ['false', 'throw']) {
        let finalized = 0;
        const h = harness(t, { prepareSteps: function* ({ generation }) {
            yield { phase: 'prepare' };
            const ticket = h.registry.begin({ key: `finalize:${mode}`, generation });
            return { entries: [{ ticket, clear: true, commit: () => true, rollback: () => {}, discard: () => {} }],
                isCurrent: () => true, finalize: () => { finalized += 1; if (mode === 'throw') throw new Error('finalizer'); return false; },
                discard: () => {} };
        } });
        h.coordinator.invalidate('terrain', { keys: [mode] }); h.coordinator.onFrame({}); h.pump(); h.pump(); h.boundary.publishReady();
        await Promise.resolve();
        const snapshot = h.coordinator.snapshot();
        assert.equal(finalized, 1); assert.equal(snapshot.published, 1); assert.equal(snapshot.pending, 0);
        assert.equal(snapshot.failed, 1); assert.equal(snapshot.lastError.code, 'ground-generation-finalization');
    }
});

test('nested compiler capacity is capacity-blocked and deterministic errors latch until invalidated', t => {
    let clock = 1000, attempts = 0, deterministic = true;
    const h = harness(t, { now: () => clock, prepareSteps: function* () {
        attempts += 1;
        if (deterministic) throw Object.assign(new Error('compiler'), { code: 'compiler-failed', details: { code: 'ground-topology-capacity' } });
        throw Object.assign(new Error('programming'), { code: 'geometry-invalid' });
    } });
    h.coordinator.invalidate('roads', { keys: ['a'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(h.coordinator.snapshot().capacityBlocked, true);
    clock += 501; h.coordinator.onFrame({}); assert.equal(attempts, 1);
    deterministic = false; h.coordinator.invalidate('roads', { keys: ['b'] }); h.coordinator.onFrame({}); h.pump();
    assert.equal(attempts, 2); assert.equal(h.coordinator.snapshot().failureBlocked, true);
    clock += 501; h.coordinator.onFrame({}); assert.equal(attempts, 2);
});

test('busy and stale failures remain retryable after the retry window', t => {
    let clock = 1000, attempts = 0;
    const h = harness(t, { now: () => clock, prepareSteps: function* () {
        attempts += 1;
        throw Object.assign(new Error('busy'), { code: 'ground-dependency-busy' });
    } });
    h.coordinator.invalidate('roads', { keys: ['busy'] }); h.coordinator.onFrame({}); h.pump();
    clock += 501; h.coordinator.onFrame({}); h.pump();
    assert.equal(attempts, 2); assert.equal(h.coordinator.snapshot().failureBlocked, false);
});

test('nested missing sources block and nested stale inputs retry without losing captured changes', t => {
    for (const code of ['terrain-evidence-unavailable', 'ground-generation-stale']) {
        let clock = 0, attempts = 0;
        const h = harness(t, { now: () => clock, prepareSteps: function* ({ changes }) {
            attempts++; assert.deepEqual(changes[0].keys, ['tile-a']);
            throw Object.assign(new Error('wrapped'), { code: 'compiler-failed', details: { code } });
        } });
        h.coordinator.invalidate('terrain', { keys: ['tile-a'] }); h.coordinator.onFrame({}); h.pump();
        assert.equal(h.coordinator.snapshot().lastError.code, code);
        clock = 1000; h.coordinator.onFrame({}); h.pump();
        assert.equal(attempts, code.endsWith('stale') ? 2 : 1);
        assert.equal(h.coordinator.snapshot().pending, 1);
    }
});

test('throwing preparation cleanup and error observers preserve the obligation and cannot prevent close', t => {
    let finalized = 0;
    const h = harness(t, { onError() { throw new Error('observer failed'); }, prepareSteps: function* () {
        try { yield { phase: 'held' }; }
        finally { finalized++; throw new Error('release failed'); }
    } });
    h.coordinator.invalidate('terrain', { keys: ['tile-a'] }); h.coordinator.onFrame({}); h.pump();
    h.jobs[0].cancelled = true; h.jobs[0].options.onCancel();
    assert.equal(finalized, 1); assert.equal(h.coordinator.snapshot().pending, 1);
    assert.equal(h.coordinator.snapshot().preparing, 0); assert.equal(h.coordinator.snapshot().failureBlocked, true);
    assert.equal(h.coordinator.snapshot().lastError.code, 'ground-generation-cleanup');
    assert.equal(h.coordinator.snapshot().lastError.reportingError, 'observer failed');
    h.coordinator.close(); assert.equal(h.coordinator.snapshot().pending, 0);
});

test('failed publication attempts all candidate cleanup and retains the original source obligation', async t => {
    let entryDiscarded = 0, candidateDiscarded = 0, h;
    h = harness(t, { prepareSteps: function* ({ generation }) {
        const ticket = h.registry.begin({ key: 'faulty', generation });
        return { isCurrent: () => true, entries: [{ ticket, clear: true,
            commit() { throw new Error('commit failed'); }, rollback() {},
            discard() { entryDiscarded++; throw new Error('entry cleanup'); } }],
            finalize() { assert.fail('failed publication cannot finalize'); },
            discard() { candidateDiscarded++; throw new Error('candidate cleanup'); } };
    } });
    h.coordinator.invalidate('terrain', { keys: ['tile-a'] }); h.coordinator.onFrame({}); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    assert.equal(entryDiscarded, 1); assert.equal(candidateDiscarded, 1);
    assert.equal(h.coordinator.snapshot().pending, 1); assert.equal(h.coordinator.snapshot().preparing, 0);
    assert.equal(h.coordinator.snapshot().failureBlocked, true);
    assert.equal(h.coordinator.snapshot().lastError.code, 'ground-generation-cleanup');
});

test('a real failure remains diagnosable after a busy retry and a successful replacement', async t => {
    let mode = 'failure', clock = 1000, h;
    h = harness(t, { now: () => clock, prepareSteps: function* ({ generation }) {
        yield { phase: 'owner-admission' };
        if (mode === 'failure') throw Object.assign(new Error('2088 owners exceed 2048'), { code: 'ground-generation-capacity' });
        if (mode === 'busy') throw Object.assign(new Error('source delivering'), { code: 'ground-dependency-busy' });
        return { entries: [{ ticket: h.registry.begin({ key: 'receiver', generation }), clear: true }],
            isCurrent: () => true, finalize: () => true, discard() {} };
    } });
    h.coordinator.invalidate('roads'); h.coordinator.onFrame({}); h.pump();
    assert.doesNotThrow(() => h.jobs[0].fn(h.jobs[0].items[0]));
    // The fixture's manual call does not retire its mock scheduler job.
    h.jobs[0].cancelled = true;
    const failure = h.coordinator.snapshot().lastFailure;
    assert.equal(failure.code, 'ground-generation-capacity'); assert.equal(failure.phase, 'owner-admission');
    assert.equal(failure.generation, 1); assert.deepEqual(failure.families, ['roads']);
    mode = 'busy'; h.coordinator.invalidate('terrain'); h.coordinator.onFrame({}); h.pump(); h.pump();
    assert.equal(h.coordinator.snapshot().lastError.code, 'ground-dependency-busy');
    assert.equal(h.coordinator.snapshot().lastFailure, failure); assert.equal(h.errors.length, 1);
    mode = 'ready'; clock += 501; h.coordinator.onFrame({}); h.pump(); h.pump();
    h.boundary.publishReady(); await Promise.resolve();
    assert.equal(h.coordinator.snapshot().published, 1); assert.equal(h.coordinator.snapshot().lastError, null);
    assert.equal(h.coordinator.snapshot().lastFailure, failure); assert.equal(h.errors.length, 1);
});

test('preparation phase keys drop counters, tile keys and ids so the timing table cannot overflow into other', () => {
    for (const [label, key] of [
        ['road-generation:surface:sample 12/300', 'road-generation:surface'],
        ['road-generation:controlled-cross-section', 'road-generation:controlled-cross-section'],
        ['curb-generation:tile -1_3 4/9', 'curb-generation:tile'],
        ['curb-generation:-1_3', 'curb-generation'],
        ['rail-construction:cell 3_-2', 'rail-construction:cell'],
        ['rail-construction:wholeSet:portalOpenings', 'rail-construction:wholeSet'],
        ['road-receiver-support-owners', 'road-receiver-support-owners'],
        ['terrain-receiver-compile:0_1', 'terrain-receiver-compile'],
        ['roads:structure:osm-29704919', 'roads:structure'],
        ['water-coast-osm:way:126354021', 'water-coast-osm:way'],
        ['formation surface-profiles 176/337 points', 'formation'],
        ['ground-topology-storage-noding', 'ground-topology-storage-noding'],
        ['', 'prepare'],
        [null, 'prepare'],
    ]) assert.equal(preparationPhaseKey(label), key, JSON.stringify(label));
});
