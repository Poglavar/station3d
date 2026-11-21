// The live formation adapter must restore model/query/provider state if any
// later ground member fails, and retire old owners only after group success.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function prepareRailFormationPublication('), source.indexOf('// terrainChangedBounds:'));
function model(revision, y) {
    let disposals = 0;
    return { revision, civilGroundMutationRevision: 0, get disposals() { return disposals; },
        sceneYAtLocal() { assert.equal(disposals, 0); return y; },
        dispose() { disposals++; assert.equal(disposals, 1); } };
}
function fixture() {
    const old = model(4, 1), snapshot = Object.freeze({ signature: 'old' }), events = [];
    const pending = { iterator: { return() { events.push('civil-cancel'); } } };
    const c = vm.createContext({ lastRailFormation: old, railFormationRevision: 4, railSessionToken: 1,
        lastTerrain: { railFormation: old, setRailFormation(value) { this.railFormation = value; } },
        streamedRailSessionContext: { railFormation: old }, publishedRailCivilGroundSnapshot: snapshot,
        publishedRailCivilGroundSnapshotModel: old, publishedRailCivilGroundSnapshotRevision: 4,
        publishedRailCivilGroundSnapshotMutation: 0, pendingPublishedRailCivilGroundSnapshot: pending,
        pendingRailVisualRefresh: {}, pendingRailStructuresRefresh: {}, pendingCrossingFormationRefresh: {},
        pendingEmbeddedTramMeshRefresh: {},
        EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT: Object.freeze({ signature: '', entries: [], bounds: [] }),
        ensurePillarClearanceForFormation() { events.push('clearance'); }, recordLayerFrameMs() {},
    });
    for (const name of ['discardPendingRailVisualRefresh', 'discardPendingRailStructuresRefresh',
        'discardPendingCrossingFormationRefresh', 'discardPendingEmbeddedTramMeshRefresh']) {
        c[name] = () => { assert.equal(old.disposals, 0); events.push(name); };
    }
    vm.runInContext(code, c);
    return { c, old, snapshot, pending, events };
}

test('a later dependency failure restores the old rail model, civil snapshot and both provider attachments', () => {
    const f = fixture(), c = f.c, next = model(1, 2), registry = createSurfacePublicationRegistry();
    const publication = c.prepareRailFormationPublication(next, [], { civilGroundSnapshot: { signature: 'next' } });
    assert.equal(next.revision, 5); assert.equal(c.lastRailFormation, f.old); assert.deepEqual(f.events, []);
    const batch = registry.prepareBatch([{ ...publication.entry,
        ticket: registry.begin({ key: 'rail:formation', generation: 5 }) }], { commit() {
        assert.equal(c.lastRailFormation, next); assert.equal(c.lastTerrain.railFormation, next);
        assert.equal(c.streamedRailSessionContext.railFormation, next);
        assert.equal(c.publishedRailCivilGroundSnapshot.signature, 'next');
        assert.equal(f.old.sceneYAtLocal(), 1); assert.equal(f.old.disposals, 0);
        assert.deepEqual(f.events, []); throw new Error('mask candidate failed');
    } });
    assert.throws(() => batch.publish(), /mask candidate failed/);
    assert.equal(c.lastRailFormation, f.old); assert.equal(c.lastTerrain.railFormation, f.old);
    assert.equal(c.streamedRailSessionContext.railFormation, f.old);
    assert.equal(c.publishedRailCivilGroundSnapshot, f.snapshot);
    assert.equal(c.pendingPublishedRailCivilGroundSnapshot, f.pending);
    assert.equal(c.publishedRailCivilGroundSnapshotRevision, 4); assert.equal(f.old.disposals, 0);
    assert.equal(next.disposals, 1); assert.deepEqual(f.events, []); assert.equal(publication.finalize(), false);
    publication.discard(); assert.equal(next.disposals, 1); registry.close();
});

test('successful rail promotion retires only captured old producers after publication succeeds', () => {
    const f = fixture(), c = f.c, next = model(1, 2), registry = createSurfacePublicationRegistry();
    const publication = c.prepareRailFormationPublication(next, [], { civilGroundSnapshot: { signature: 'next' } });
    const replacementVisual = {}; c.pendingRailVisualRefresh = replacementVisual;
    const batch = registry.prepareBatch([{ ...publication.entry,
        ticket: registry.begin({ key: 'rail:formation', generation: 5 }) }]);
    assert.equal(publication.finalize(), false); assert.equal(batch.publish().status, 'published');
    assert.equal(f.old.disposals, 0); assert.deepEqual(f.events, []);
    assert.equal(publication.finalize(), true); assert.equal(publication.finalize(), false);
    assert.equal(f.old.disposals, 1); assert.equal(next.disposals, 0);
    assert.equal(c.pendingRailVisualRefresh, replacementVisual);
    assert.equal(f.events.includes('discardPendingRailVisualRefresh'), false);
    assert.equal(f.events.length, 5); assert.equal(c.publishedRailCivilGroundSnapshotRevision, 5);
    publication.discard(); assert.equal(next.disposals, 0); registry.close(); next.dispose();
});

test('candidate crossing mutation and session replacement reject a staged rail authority', () => {
    for (const change of [c => c.next.civilGroundMutationRevision++, c => c.railSessionToken++]) {
        const f = fixture(), c = f.c, registry = createSurfacePublicationRegistry(); c.next = model(1, 2);
        const publication = c.prepareRailFormationPublication(c.next, [], { civilGroundSnapshot: { signature: 'next' } });
        const batch = registry.prepareBatch([{ ...publication.entry,
            ticket: registry.begin({ key: 'rail:formation', generation: 5 }) }]);
        change(c); assert.equal(batch.publish().status, 'dependency-revised');
        assert.equal(c.lastRailFormation, f.old); assert.equal(f.old.disposals, 0);
        assert.equal(c.next.disposals, 1); assert.deepEqual(f.events, []); registry.close();
    }
});

test('an explicit empty rail publication can roll back without disposing the old model', () => {
    const f = fixture(), c = f.c;
    const publication = c.prepareRailFormationPublication(null, []);
    assert.equal(publication.entry.commit(), true); assert.equal(c.lastRailFormation, null);
    assert.equal(c.lastTerrain.railFormation, null); assert.equal(c.publishedRailCivilGroundSnapshot.signature, '');
    publication.entry.rollback(); publication.discard();
    assert.equal(c.lastRailFormation, f.old); assert.equal(c.pendingPublishedRailCivilGroundSnapshot, f.pending);
    assert.equal(f.old.disposals, 0); assert.deepEqual(f.events, []);
});
