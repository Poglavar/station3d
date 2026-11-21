import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGroundPublicationBoundary } from '../core/ground-publication-boundary.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';

function scene() { return new THREE.Scene(); }
function root(name, replacementKey = 'ground', generation = 1) {
    const group = new THREE.Group(); group.name = name;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    markSurfaceClaim(mesh, { surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL, verticalBand: 'ground',
        ownerId: name, replacementKey, generation, supportReady: true, cutsBackstop: true });
    group.add(mesh); return group;
}
function staged(registry, parent, key, generation, candidate, hooks = {}) {
    const ticket = registry.begin({ key, generation, parent, ...hooks });
    return registry.prepareBatch([{ ticket, root: candidate }], {
        isCurrent: hooks.isCurrent,
    });
}

test('a staged Three root stays detached until the boundary publishes it', async () => {
    const parent = scene(); const registry = createSurfacePublicationRegistry();
    const candidate = root('candidate');
    const batch = staged(registry, parent, 'ground', 1, candidate);
    assert.equal(candidate.parent, null);
    const boundary = createGroundPublicationBoundary({ now: () => 12 });
    const handle = boundary.enqueue(batch);
    assert.equal(boundary.snapshot().pending, 1);
    boundary.publishReady();
    assert.equal((await handle.promise).status, 'published');
    assert.equal(candidate.parent, parent);
    assert.equal(boundary.snapshot().published, 1);
});

test('publication finalization finishes before controller entry and cannot turn a published group into a rejection', async t => {
    const registry = createSurfacePublicationRegistry(), parent = scene();
    const boundary = createGroundPublicationBoundary();
    let finalized = false;
    const candidate = root('candidate');
    const handle = boundary.enqueue(staged(registry, parent, 'ground', 1, candidate), {
        onPublished() { finalized = true; assert.equal(candidate.parent, parent); },
    });
    boundary.publishReady();
    assert.equal(finalized, true, 'same-frame controller can observe consumed support revisions');
    assert.equal((await handle.promise).status, 'published');
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const next = root('next', 'ground', 2);
    const failing = boundary.enqueue(staged(registry, parent, 'ground', 2, next), {
        onPublished() { throw new Error('retirement failed'); },
    });
    boundary.publishReady();
    const result = await failing.promise;
    assert.equal(result.status, 'published-with-finalization-error');
    assert.match(result.finalizationError, /retirement failed/);
    assert.equal(next.parent, parent); assert.equal(candidate.parent, null);
    assert.equal(boundary.snapshot().published, 2); assert.equal(boundary.snapshot().failed, 1);
    assert.equal(errors.length, 1);
    registry.close({ retireActive: true }); boundary.close();
});

test('one slot refuses a second batch without disposing its caller-owned candidate', () => {
    const boundary = createGroundPublicationBoundary();
    const events = [];
    const a = { state: 'staged', publish: () => ({ status: 'published' }), discard: r => events.push(`a:${r}`) };
    const b = { state: 'staged', publish: () => ({ status: 'published' }), discard: r => events.push(`b:${r}`) };
    assert.ok(boundary.enqueue(a));
    assert.equal(boundary.enqueue(b), null);
    assert.deepEqual(events, []);
    boundary.publishReady();
    assert.deepEqual(events, []);
});

test('successful flush records one commit duration and does not recurse observer work', async () => {
    let clock = 10, nested;
    const boundary = createGroundPublicationBoundary({ now: () => clock });
    let publishes = 0;
    const batch = { state: 'staged', publish: () => {
        publishes++; nested = boundary.enqueue({ state: 'staged', publish() { return { status: 'published' }; }, discard() {} });
        clock = 17; return { status: 'published' };
    }, discard() {} };
    const handle = boundary.enqueue(batch); boundary.publishReady();
    assert.equal((await handle.promise).status, 'published');
    assert.equal(publishes, 1); assert.equal(nested, null);
    assert.deepEqual(boundary.snapshot(), { pending: 0, publishing: false, closed: false,
        published: 1, failed: 0, cancelled: 0, lastCommitMs: 7, maxCommitMs: 7, lastError: null });
});

test('a later commit failure restores the old root and leaves the registry reusable', async () => {
    const parent = scene(); const events = [];
    const registry = createSurfacePublicationRegistry();
    const old = root('old'); const oldTicket = registry.begin({ key: 'ground', generation: 1, parent,
        retire: (_c, r) => { events.push(`retire:${r.name}`); r.removeFromParent(); } });
    registry.prepareBatch([{ ticket: oldTicket, root: old }]).publish();
    const candidate = root('new', 'ground', 2); const ticket = registry.begin({ key: 'ground', generation: 2, parent });
    const batch = registry.prepareBatch([{ ticket, root: candidate,
        commit: () => false, discard: (_c, r) => { events.push(`discard:${r.name}`); r.removeFromParent(); },
        rollback: () => events.push('rollback') }]);
    const boundary = createGroundPublicationBoundary();
    const handle = boundary.enqueue(batch);
    const failure = assert.rejects(handle.promise, { code: 'rejected-publication-commit' });
    boundary.publishReady();
    await failure;
    assert.equal(old.parent, parent); assert.equal(candidate.parent, null);
    assert.deepEqual(events, ['rollback', 'discard:new']);
    assert.equal(boundary.snapshot().failed, 1);
    assert.equal(boundary.snapshot().pending, 0);
    const retry = registry.begin({ key: 'ground', generation: 3, parent });
    const retryBatch = registry.prepareBatch([{ ticket: retry, root: root('retry', 'ground', 3) }]);
    const retryHandle = boundary.enqueue(retryBatch); boundary.publishReady();
    assert.equal((await retryHandle.promise).status, 'published');
});

test('cancel and close dispose staged candidates exactly once; stale validity retains the old root', async () => {
    const parent = scene(); const registry = createSurfacePublicationRegistry();
    const boundary = createGroundPublicationBoundary(); let disposed = 0;
    const candidate = root('cancel', 'cancel'); const ticket = registry.begin({ key: 'cancel', generation: 1, parent,
        discard: (_c, r) => { disposed++; r.removeFromParent(); } });
    const batch = registry.prepareBatch([{ ticket, root: candidate }]);
    const handle = boundary.enqueue(batch); assert.equal(handle.cancel('superseded'), true);
    assert.equal(handle.cancel('superseded'), false);
    assert.equal((await handle.promise).status, 'superseded'); assert.equal(disposed, 1);
    const closedCandidate = root('closed', 'close');
    const closeTicket = registry.begin({ key: 'close', generation: 1, parent,
        discard: (_c, r) => { disposed++; r.removeFromParent(); } });
    const closeBatch = registry.prepareBatch([{ ticket: closeTicket, root: closedCandidate }]);
    const closeHandle = boundary.enqueue(closeBatch); boundary.close();
    boundary.close();
    assert.equal(closeHandle.cancel(), false);
    assert.equal((await closeHandle.promise).status, 'ground-session-closed');
    assert.equal(disposed, 2);
    const old = root('old-stale', 'stale');
    registry.begin({ key: 'stale', generation: 1, parent }).publish(old);
    const stale = root('stale', 'stale', 2); let current = true;
    const staleTicket = registry.begin({ key: 'stale', generation: 2, parent, isCurrent: () => current,
        discard: (_c, r) => { disposed++; r.removeFromParent(); } });
    const staleBatch = registry.prepareBatch([{ ticket: staleTicket, root: stale }]);
    const staleBoundary = createGroundPublicationBoundary(); const staleHandle = staleBoundary.enqueue(staleBatch);
    current = false; staleBoundary.publishReady(); assert.equal((await staleHandle.promise).status, 'dependency-revised');
    assert.equal(stale.parent, null);
    assert.equal(registry.getActive('stale').root, old);
    assert.equal(old.parent, parent);
    assert.equal(disposed, 3);
});
