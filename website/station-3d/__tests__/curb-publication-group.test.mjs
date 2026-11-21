// Exercise combined support-table capture independently of the browser queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCurbPublicationGroupSteps, curbCollisionSurfacesNear } from '../core/curb-publication-group.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
const run = steps => { let next; do { next = steps.next(); } while (!next.done); return next.value; };
const surface = (key, y, x = 0) => ({ tileKey: key, bounds: { minX: x, maxX: x + 1, minZ: 0, maxZ: 1 },
    positions: new Float32Array([x, y, 0, x, y, 1, x + 1, y, 0]) });

test('a multi-tile curb group captures unchanged support and clears only its explicit empty rows', () => {
    const registry = createSurfacePublicationRegistry();
    const oldA = surface('a', 1), oldB = surface('b', 2), oldC = surface('c', 3, 5), nextA = surface('a', 4);
    const active = new Map([['a', oldA], ['b', oldB], ['c', oldC]]);
    let revision = 10, finalized = 0, discarded = 0;
    function member(key, candidate) {
        const previous = active.get(key); let before = null, committed = false;
        return { tileKey: key, collisionSurface: candidate,
            entry: { ticket: registry.begin({ key, generation: 1 }), clear: true,
                isCurrent: () => active.get(key) === previous,
                commit() { before = revision; candidate ? active.set(key, candidate) : active.delete(key); revision++; committed = true; },
                rollback() { active.set(key, previous); revision = before; committed = false; } },
            finalize() { assert.equal(committed, true); finalized++; }, discard() { discarded++; },
        };
    }
    let preparations = 0, physicsCommits = 0, physicsFinalized = 0, captured;
    const physics = { captureGroundPublicationRegion(families) {
        assert.deepEqual(families, ['curb-surfaces']);
        return { isCurrent: () => true, *prepareSteps(reads, current) {
            preparations++; captured = reads['curb-surfaces'];
            assert.equal(current(), true); yield;
            return { entry: { isCurrent: current, commit() { physicsCommits++; return true; }, rollback() {}, discard() {} },
                finalize() { physicsFinalized++; } };
        } };
    } };
    const group = run(prepareCurbPublicationGroupSteps({ members: [member('a', nextA), member('b', null)],
        activeSurfaces: active, revision, getRevision: () => revision, isCurrent: () => true,
        getPhysics: () => physics, registry, generation: 1 }));
    assert.equal(preparations, 1); assert.equal(captured.revision, 12);
    assert.deepEqual(captured.surfacesNear(0, 0, 10), [oldC, nextA]);
    assert.deepEqual([...active.values()], [oldA, oldB, oldC]);
    assert.equal(physicsCommits, 0); assert.equal(group.finalize(), false);
    assert.equal(registry.prepareBatch(group.entries).publish().status, 'published');
    assert.deepEqual([...active.values()], [nextA, oldC]); assert.equal(revision, 12);
    assert.equal(physicsCommits, 1); assert.equal(group.finalize(), true);
    assert.equal(physicsFinalized, 1); assert.equal(finalized, 2); group.discard(); assert.equal(discarded, 0);
    registry.close();
});

test('an unrelated published curb change invalidates an in-flight combined query without clearing it', () => {
    const registry = createSurfacePublicationRegistry(); const old = surface('a', 1);
    const active = new Map([['a', old]]); let revision = 1, disposed = 0, time = 0;
    const candidate = { tileKey: 'a', collisionSurface: surface('a', 2),
        entry: { ticket: registry.begin({ key: 'a', generation: 1 }), clear: true, isCurrent: () => true },
        discard() { disposed++; }, finalize() {} };
    const steps = prepareCurbPublicationGroupSteps({ members: [candidate], activeSurfaces: active,
        revision, getRevision: () => revision, isCurrent: () => true, registry, generation: 1, now: () => time++ });
    assert.equal(steps.next().done, false);
    const unrelated = surface('b', 3); active.set('b', unrelated); revision++;
    assert.equal(steps.next().value, null); assert.equal(disposed, 1);
    assert.deepEqual([...active.values()], [old, unrelated]); registry.close();
});

test('curb bounds queries reject absent coordinates and use a true circular radius', () => {
    const a = surface('a', 1), far = surface('b', 2, 10), map = new Map([['a', a], ['b', far]]);
    assert.deepEqual(curbCollisionSurfacesNear(map, 0, 0, 2), [a]);
    assert.deepEqual(curbCollisionSurfacesNear(map, null, 0, 2), []);
    assert.deepEqual(curbCollisionSurfacesNear(map, 0, 0, 0), []);
});
