// Exercise the live ownership-mask adapter with Three textures and the shared registry/boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { formationMaskTaskNeedsRestart } from '../core/ground-ownership-mask-task.js';

const source = readFileSync(new URL('../world/terrain.js', import.meta.url), 'utf8');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert(a >= 0 && b > a);
    return source.slice(a, b);
}
const publicationCode = section('function clearRoadFormationMask()', 'function activeFormationModels()');
const queueCode = section('function terrainGridPrepAbortError(', 'function resetTerrainGridPrepQueue(')
    + section('function resolveTerrainGridPrepPriority(', 'function decodeTerrainGridPayloadQueued(');
const syncCode = section('function syncRoadFormationMask(', 'function markUrbanMaskDirty(');
const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function fixture() {
    const registry = createSurfacePublicationRegistry(), boundary = createGroundPublicationBoundary();
    const old = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    const fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    const disposed = [], uploaded = [], errors = [], jobs = [], samples = [];
    old.addEventListener('dispose', () => disposed.push(old));
    const oldModel = { revision: 1 }, nextModel = { revision: 2 };
    const frame = {}, repeat = Symbol('repeat');
    const queue = {
        enqueue(items, visit, options) {
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            const job = { items, visit, options, promise, resolve, reject, done: false };
            jobs.push(job); return job;
        },
        cancel(job) {
            if (job.done) return;
            job.done = true; job.options.onCancel?.(); job.resolve({ cancelled: true });
        },
    };
    const runtime = vm.createContext({ logStamp: () => '[test]', THREE, AbortController, performance,
        console: { error: (...args) => errors.push(args) },
        renderer: { initTexture(texture) { uploaded.push(texture); } },
        recordLayerFrameMs: (name, ms) => samples.push({ name, ms }),
        surfacePublications: registry, groundPublications: boundary,
        terrainPublicationGeneration: 0, terrainGridPrepQueue: queue, FRAME_CHUNK_REPEAT_ITEM: repeat,
        generation: 1, reference: frame, desiredModels: [nextModel], current: true,
        roadMaskTexture: old, roadMaskModels: [oldModel], roadMaskRevision: '1',
        roadMaskCenterX: 12, roadMaskCenterZ: 24, roadMaskRevisionPendingSince: 123,
        roadMaskObservedModels: [oldModel], roadMaskObservedRevision: '1',
        roadMaskRevisionChangedAt: 0, roadMaskBuildTask: null, roadMaskPublication: null,
        roadMaskFallbackTexture: fallback, ROAD_MASK_HALF_SIZE_M: 1200,
        ROAD_MASK_REFRESH_MOVE_M: 400, ROAD_MASK_REVISION_SETTLE_MS: 0,
        ROAD_MASK_MAX_DEFER_MS: 1000, ROAD_MASK_BUILD_SLICE_MS: 3,
        formationMaskTaskNeedsRestart,
        roadMaskUniforms: {
            uRoadFormationMask: { value: old }, uRoadFormationCenter: { value: new THREE.Vector2(12, 24) },
            uRoadFormationHalfSize: { value: 1200 }, uRoadFormationEnabled: { value: 1 },
        },
    });
    runtime.activeFormationModels = () => runtime.desiredModels;
    runtime.groundOwnershipMaskRevision = models => models.map(m => m.revision).join('|');
    vm.runInContext(queueCode + publicationCode + syncCode, runtime);
    function task({ clear = false } = {}) {
        const texture = clear ? null : new THREE.DataTexture(new Uint8Array([0, 255, 0, 255]), 1, 1);
        texture?.addEventListener('dispose', () => disposed.push(texture));
        return { models: clear ? [] : runtime.desiredModels.slice(), revision: clear ? '' : '2',
            centerX: 40, centerZ: 80, step: () => true, result: () => texture, texture };
    }
    const prepare = candidate => runtime.prepareRoadFormationMaskPublication(candidate,
        () => runtime.current && runtime.generation === 1 && runtime.reference === frame);
    const bindings = () => ({ texture: runtime.roadMaskTexture, models: runtime.roadMaskModels,
        revision: runtime.roadMaskRevision, x: runtime.roadMaskCenterX, z: runtime.roadMaskCenterZ,
        pending: runtime.roadMaskRevisionPendingSince,
        uniform: runtime.roadMaskUniforms.uRoadFormationMask.value,
        center: runtime.roadMaskUniforms.uRoadFormationCenter.value.toArray(),
        enabled: runtime.roadMaskUniforms.uRoadFormationEnabled.value,
        halfSize: runtime.roadMaskUniforms.uRoadFormationHalfSize.value });
    function advance(job = jobs.at(-1)) {
        if (job.done) return;
        try {
            if (job.visit(job.items[0]) !== repeat) { job.done = true; job.resolve({ cancelled: false }); }
        } catch (error) { job.done = true; job.reject(error); }
    }
    async function finish(job = jobs.at(-1)) {
        for (let i = 0; i < 10 && !job.done; i++) advance(job);
        assert.equal(job.done, true); await microtasks();
    }
    function warm(prepared) { const steps = prepared.prewarmSteps(); for (;;) { if (steps.next().done) return; } }
    return { runtime, registry, boundary, old, fallback, task, prepare, bindings, advance, finish, warm,
        disposed, uploaded, errors, jobs, samples };
}

test('a prepared mask keeps every published binding until its GPU upload and the shared boundary', async () => {
    const f = fixture(), before = f.bindings(), task = f.task(), prepared = f.prepare(task);
    assert.equal(prepared.entry.isCurrent(), false, 'an unuploaded replacement cannot publish');
    assert.deepEqual(f.bindings(), before);
    f.warm(prepared);
    assert.deepEqual(f.uploaded, [task.texture]);
    assert.deepEqual(f.bindings(), before);
    const queued = f.boundary.enqueue(f.registry.prepareBatch([prepared.entry]), { onPublished: prepared.finalize });
    assert.deepEqual(f.bindings(), before);
    f.boundary.publishReady();
    assert.equal(f.runtime.roadMaskUniforms.uRoadFormationMask.value, task.texture);
    assert.deepEqual(f.runtime.roadMaskUniforms.uRoadFormationCenter.value.toArray(), [40, 80]);
    assert.equal(f.runtime.roadMaskRevision, '2');
    assert.deepEqual(f.disposed, [f.old], 'old texture retires only after the whole batch succeeds');
    assert.equal((await queued.promise).status, 'published');
    assert.equal(prepared.finalize(), false);
});

test('a later support failure rolls back mask bytes, enable state, center and publication metadata', async () => {
    for (const clear of [false, true]) {
        const f = fixture(), before = f.bindings(), task = f.task({ clear }), prepared = f.prepare(task);
        f.warm(prepared);
        const failure = f.registry.begin({ key: 'support', generation: 1 });
        const queued = f.boundary.enqueue(f.registry.prepareBatch([prepared.entry, { ticket: failure, clear: true,
            commit() {
                assert.equal(f.runtime.roadMaskUniforms.uRoadFormationEnabled.value, clear ? 0 : 1);
                throw new Error('support refused');
            } }]), { onPublished: prepared.finalize });
        const rejected = assert.rejects(queued.promise, /support refused/);
        f.boundary.publishReady(); await rejected;
        assert.deepEqual(f.bindings(), before);
        assert.deepEqual(f.disposed, clear ? [] : [task.texture]);
        assert.equal(prepared.state, 'discarded');
    }
});

test('a partial mask commit exception is reversible too', async () => {
    const f = fixture(), before = f.bindings(), task = f.task(), prepared = f.prepare(task);
    f.warm(prepared);
    const vector = f.runtime.roadMaskUniforms.uRoadFormationCenter.value, set = vector.set;
    let fail = true;
    vector.set = function (...args) { if (fail) { fail = false; throw new Error('uniform refused'); } return set.apply(this, args); };
    const queued = f.boundary.enqueue(f.registry.prepareBatch([prepared.entry]));
    const rejected = assert.rejects(queued.promise, /uniform refused/);
    f.boundary.publishReady(); await rejected;
    assert.deepEqual(f.bindings(), before); assert.deepEqual(f.disposed, [task.texture]);
});

test('mask commit accepts earlier members of its own prepared dependency group', () => {
    const f = fixture(), task = f.task(), prepared = f.prepare(task);
    f.warm(prepared);
    const batch = f.registry.prepareBatch([{
        ticket: f.registry.begin({ key: 'prepared-model', generation: 1 }), clear: true,
        commit() { f.runtime.current = false; return true; },
        rollback() { f.runtime.current = true; },
    }, prepared.entry]);
    assert.equal(batch.publish().status, 'published');
    assert.equal(prepared.finalize(), true);
    assert.equal(f.bindings().texture, task.texture);
    f.registry.close(); task.texture.dispose(); f.fallback.dispose();
});

test('the live mask driver uploads through the existing queue and waits behind another complete ground batch', async () => {
    const f = fixture(), before = f.bindings(), task = f.task();
    f.runtime.createRoadFormationMaskTask = () => task;
    const occupied = f.registry.begin({ key: 'other-ground', generation: 1 });
    const first = f.boundary.enqueue(f.registry.prepareBatch([{ ticket: occupied, clear: true }]));
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    assert.equal(f.jobs.length, 1); assert.deepEqual(f.uploaded, []);
    // Observing new source work updates its pending-age diagnostic; all
    // published bindings and generation metadata must remain unchanged.
    before.pending = f.runtime.roadMaskRevisionPendingSince;
    assert.deepEqual(f.bindings(), before);
    assert.equal(f.jobs[0].options.maxItemsPerFrame, 1);
    await f.finish();
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    assert.equal(f.runtime.roadMaskPublication.boundaryTicket, null);
    assert.deepEqual(f.bindings(), before);
    f.boundary.publishReady(); await first.promise;
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    const pending = f.runtime.roadMaskPublication.boundaryTicket;
    assert.deepEqual(f.bindings(), before);
    f.boundary.publishReady(); await pending.promise;
    assert.equal(f.runtime.roadMaskTexture, task.texture);
    assert.equal(f.runtime.roadMaskPublication, null);
    assert.deepEqual(f.disposed, [f.old]);
    assert.equal(f.samples.filter(s => s.name === 'terrain:ownershipMask:upload').length, 1);
});

test('cancel before upload, between upload and handoff, and while queued releases only the private texture once', async () => {
    for (const phase of ['before-upload', 'after-upload', 'queued']) {
        const f = fixture(), before = f.bindings(), task = f.task();
        f.runtime.startRoadFormationMaskPublication(task);
        if (phase === 'after-upload') f.advance();
        if (phase === 'queued') { await f.finish(); f.runtime.enqueueRoadFormationMaskPublication(); }
        f.runtime.cancelRoadFormationMaskPublication('replaced');
        f.runtime.cancelRoadFormationMaskPublication('replaced-again');
        await microtasks();
        f.boundary.publishReady();
        assert.deepEqual(f.bindings(), before);
        assert.deepEqual(f.disposed, [task.texture]);
        assert.equal(f.runtime.roadMaskPublication, null);
        assert.deepEqual(f.errors, []);
        assert.equal(f.uploaded.length, phase === 'before-upload' ? 0 : 1);
    }
});

test('stale session and changed authority reject a queued mask without retiring the old texture', async () => {
    for (const change of [r => r.generation++, r => { r.reference = {}; }, r => { r.desiredModels = [{}]; }]) {
        const f = fixture(), before = f.bindings(), task = f.task();
        f.runtime.startRoadFormationMaskPublication(task); await f.finish();
        f.runtime.enqueueRoadFormationMaskPublication();
        const queued = f.runtime.roadMaskPublication.boundaryTicket;
        change(f.runtime); f.boundary.publishReady();
        assert.equal((await queued.promise).status, 'dependency-revised');
        await microtasks();
        assert.deepEqual(f.bindings(), before); assert.deepEqual(f.disposed, [task.texture]);
        assert.equal(f.runtime.roadMaskPublication, null);
    }
});

test('an upload failure retains the old mask and records one failed obligation until inputs change', async () => {
    const f = fixture(), before = f.bindings(), task = f.task();
    f.runtime.renderer.initTexture = () => { throw new Error('upload refused'); };
    f.runtime.startRoadFormationMaskPublication(task); await f.finish();
    assert.match(f.runtime.roadMaskPublication.error.message, /upload refused/);
    for (let i = 0; i < 5; i++) f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    assert.equal(f.jobs.length, 1); assert.equal(f.errors.length, 1);
    assert.deepEqual(f.bindings(), before); assert.deepEqual(f.disposed, [task.texture]);
    f.runtime.desiredModels[0].revision++;
    const next = f.task(); next.revision = '3';
    f.runtime.renderer.initTexture = texture => f.uploaded.push(texture);
    f.runtime.createRoadFormationMaskTask = () => next;
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    assert.equal(f.jobs.length, 2); await f.finish();
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    f.boundary.publishReady(); await microtasks();
    assert.equal(f.runtime.roadMaskTexture, next.texture);
    assert.deepEqual(f.disposed, [task.texture, f.old]);
});

test('removing every authority publishes a disabled mask at the boundary and teardown cancels private work', async () => {
    const f = fixture(), before = f.bindings();
    f.runtime.desiredModels = [];
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    assert.deepEqual(f.bindings(), before); await f.finish();
    f.runtime.syncRoadFormationMask({ x: 40, z: 80 });
    const queued = f.runtime.roadMaskPublication.boundaryTicket;
    assert.deepEqual(f.bindings(), before); f.boundary.publishReady(); await queued.promise;
    assert.equal(f.runtime.roadMaskTexture, null);
    assert.equal(f.runtime.roadMaskUniforms.uRoadFormationEnabled.value, 0);
    assert.equal(f.runtime.roadMaskUniforms.uRoadFormationMask.value, f.fallback);
    assert.deepEqual(f.uploaded, []); assert.deepEqual(f.disposed, [f.old]);
    const task = f.task(); f.runtime.startRoadFormationMaskPublication(task);
    f.runtime.clearRoadFormationMask(); await microtasks();
    assert.equal(f.runtime.roadMaskPublication, null); assert.deepEqual(f.disposed, [f.old, task.texture]);
});

test('closing the registry releases a staged rootless mask even before it acquires the boundary slot', () => {
    const f = fixture(), before = f.bindings(), task = f.task(), prepared = f.prepare(task);
    f.warm(prepared);
    const batch = f.registry.prepareBatch([prepared.entry]);
    f.registry.close();
    assert.deepEqual(f.bindings(), before);
    assert.deepEqual(f.disposed, [task.texture], 'staged ownership belongs to the registry even without a Three root');
    assert.equal(prepared.state, 'discarded');
    batch.discard('owner-closed'); prepared.discard(); f.registry.close();
    assert.deepEqual(f.disposed, [task.texture], 'later owner/boundary cleanup is idempotent');
});
