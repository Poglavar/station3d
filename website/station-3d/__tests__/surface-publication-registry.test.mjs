import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createSurfacePublicationRegistry,
    SurfacePublicationError,
    surfacePublicationClaimCoverage,
    surfacePublicationIdentityForObject,
} from '../core/surface-publication-registry.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
} from '../core/surface-hierarchy.js';

function parent(events = []) {
    return {
        children: [],
        add(root) {
            events.push(`add:${root.name}`);
            root.parent = this;
            this.children.push(root);
        },
        remove(root) {
            events.push(`remove:${root.name}`);
            root.parent = null;
            this.children = this.children.filter(child => child !== root);
        },
    };
}

function claimedRoot(name, key, generation, {
    surfaceClass = SURFACE_CLASS.ROAD_CARRIAGEWAY,
    verticalBand = 'ground',
} = {}) {
    const mesh = {
        name: `${name}:mesh`,
        isMesh: true,
        userData: {},
        children: [],
        parent: null,
    };
    markSurfaceClaim(mesh, {
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: verticalBand === 'ground'
            ? SURFACE_VERTICAL_RELATION.SAME_LEVEL
            : SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        verticalBand,
        ownerId: name,
        replacementKey: key,
        generation,
        supportReady: true,
        cutsBackstop: true,
    });
    const root = {
        name,
        userData: {},
        children: [mesh],
        parent: null,
    };
    mesh.parent = root;
    return root;
}

function lifecycle(sceneParent, events) {
    return {
        parent: sceneParent,
        retire(_context, root) {
            events.push(`retire:${root.name}`);
            root.parent?.remove(root);
        },
    };
}

function surfaceClaim(ownerId) {
    return {
        surfaceClass: SURFACE_CLASS.PASSIVE_LANDUSE,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId,
        supportReady: false,
        cutsBackstop: false,
    };
}

test('claim coverage partitions mixed surface and prop subtrees by canonical rules', () => {
    const inheritedMesh = {
        name: 'inherited-surface',
        isMesh: true,
        userData: {},
        children: [],
        parent: null,
    };
    const inheritedGroup = {
        name: 'claimed-group',
        userData: {},
        children: [inheritedMesh],
        parent: null,
    };
    inheritedMesh.parent = inheritedGroup;
    markSurfaceClaim(inheritedGroup, surfaceClaim('inherited-owner'));

    const claimedMaterial = { userData: {} };
    markSurfaceClaim(claimedMaterial, surfaceClaim('material-owner'));
    const materialMesh = {
        name: 'material-surface',
        isMesh: true,
        userData: {},
        material: claimedMaterial,
        children: [],
        parent: null,
    };
    const propMesh = {
        name: 'forest-prop',
        isMesh: true,
        userData: {},
        children: [],
        parent: null,
    };
    const mixedRoot = {
        name: 'mixed-root',
        userData: {},
        children: [inheritedGroup, materialMesh, propMesh],
        parent: null,
    };
    inheritedGroup.parent = mixedRoot;
    materialMesh.parent = mixedRoot;
    propMesh.parent = mixedRoot;

    assert.deepEqual(surfacePublicationClaimCoverage(inheritedGroup), {
        meshCount: 1,
        claimedMeshCount: 1,
        missingMeshCount: 0,
        complete: true,
        missingObjects: [],
    });
    assert.deepEqual(surfacePublicationClaimCoverage(mixedRoot), {
        meshCount: 3,
        claimedMeshCount: 2,
        missingMeshCount: 1,
        complete: false,
        missingObjects: ['forest-prop'],
    });
    assert.equal(surfacePublicationClaimCoverage({ children: [] }).complete, false);
});

test('publishes add then active ownership then commit then retirement', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry({
        prepare: root => events.push(`prepare:${root.name}`),
    });
    const sceneParent = parent(events);
    const first = claimedRoot('first', 'roads:tile', 1);
    registry.begin({
        key: 'roads:tile',
        generation: 1,
        ...lifecycle(sceneParent, events),
    }).publish(first, {
        commit: () => {
            assert.equal(registry.getActive('roads:tile').root, first);
            events.push('commit:first');
        },
    });

    events.length = 0;
    const second = claimedRoot('second', 'roads:tile', 2);
    const result = registry.begin({
        key: 'roads:tile',
        generation: 2,
        ...lifecycle(sceneParent, events),
    }).publish(second, {
        commit: () => {
            assert.equal(registry.getActive('roads:tile').root, second);
            events.push('commit:second');
        },
    });

    assert.equal(result.status, 'published');
    assert.deepEqual(events, [
        'prepare:second',
        'add:second',
        'commit:second',
        'retire:first',
        'remove:first',
    ]);
    assert.deepEqual(sceneParent.children, [second]);
    assert.deepEqual(surfacePublicationIdentityForObject(second.children[0]), {
        contract: 'station3d-surface-publication-v1',
        key: 'roads:tile',
        generation: 2,
    });
});

test('subscribers observe committed publication ownership changes', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent();
    const unsubscribe = registry.subscribe(event => events.push({
        type: event.type,
        key: event.key,
        generation: event.generation,
        root: event.root?.name || null,
        previous: event.previous?.root?.name || null,
    }));
    const first = claimedRoot('first', 'roads:structure:lower', 1);
    registry.begin({
        key: 'roads:structure:lower',
        generation: 1,
        ...lifecycle(sceneParent, []),
    }).publish(first);
    registry.begin({
        key: 'roads:structure:lower',
        generation: 2,
        ...lifecycle(sceneParent, []),
    }).clear();
    unsubscribe();
    const ignored = claimedRoot('ignored', 'roads:structure:lower', 3);
    registry.begin({
        key: 'roads:structure:lower',
        generation: 3,
        ...lifecycle(sceneParent, []),
    }).publish(ignored);

    assert.deepEqual(events, [
        {
            type: 'published',
            key: 'roads:structure:lower',
            generation: 1,
            root: 'first',
            previous: null,
        },
        {
            type: 'cleared',
            key: 'roads:structure:lower',
            generation: 2,
            root: null,
            previous: 'first',
        },
    ]);
});

test('a newer requested generation rejects an older detached candidate', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent(events);
    const staleTicket = registry.begin({
        key: 'terrain:0:0',
        generation: 4,
        ...lifecycle(sceneParent, events),
    });
    registry.begin({
        key: 'terrain:0:0',
        generation: 5,
        ...lifecycle(sceneParent, events),
    });
    const stale = claimedRoot('stale', 'terrain:0:0', 4, {
        surfaceClass: SURFACE_CLASS.TERRAIN,
    });

    const result = staleTicket.publish(stale);

    assert.equal(result.status, 'stale-rejected');
    assert.equal(sceneParent.children.length, 0);
    assert.deepEqual(events, ['retire:stale']);
    assert.equal(registry.snapshot().counters.staleRejected, 1);
});

test('missing semantic claims fail before scene mutation and are diagnosed', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent(events);
    const root = {
        name: 'unclaimed',
        parent: null,
        children: [{
            name: 'unclaimed:mesh',
            isMesh: true,
            userData: {},
            children: [],
            parent: null,
        }],
    };
    root.children[0].parent = root;
    const ticket = registry.begin({
        key: 'bad:surface',
        generation: 1,
        ...lifecycle(sceneParent, events),
    });

    assert.throws(
        () => ticket.publish(root),
        error => error instanceof SurfacePublicationError
            && error.code === 'missing-surface-claim',
    );
    assert.equal(sceneParent.children.length, 0);
    assert.equal(registry.snapshot().counters.missingClaims, 1);
});

test('different keys and vertical bands coexist instead of flattening grade separation', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent(events);
    const road = claimedRoot('lower-road', 'road:underpass', 1, {
        surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        verticalBand: 'underpass',
    });
    const rail = claimedRoot('upper-rail', 'rail:bridge', 1, {
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        verticalBand: 'bridge-deck',
    });

    registry.begin({
        key: 'road:underpass',
        generation: 1,
        ...lifecycle(sceneParent, events),
    }).publish(road);
    registry.begin({
        key: 'rail:bridge',
        generation: 1,
        ...lifecycle(sceneParent, events),
    }).publish(rail);

    assert.deepEqual(sceneParent.children, [road, rail]);
    assert.equal(registry.snapshot().activeCount, 2);
});

test('Miramarska lower road coexists with road, rail, and pedestrian overpasses', () => {
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent();
    const surfaces = [
        claimedRoot(
            'miramarska-lower-road',
            'roads:structure:osm-207567941-split-lower-846828121',
            12,
            {
                surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
                verticalBand: 'underpass',
            },
        ),
        claimedRoot('miramarska-road-overpass', 'roads:structure:road-overpass', 12, {
            surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
            verticalBand: 'road-bridge-deck',
        }),
        claimedRoot('miramarska-rail-overpass', 'rails:cell:miramarska', 12, {
            surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
            verticalBand: 'rail-bridge-deck',
        }),
        claimedRoot('miramarska-footbridge', 'roads:structure:pedestrian-overpass', 12, {
            surfaceClass: SURFACE_CLASS.SIDEWALK,
            verticalBand: 'pedestrian-bridge-deck',
        }),
    ];

    for (const surface of surfaces) {
        const claim = surface.children[0].userData.surfaceClaim;
        registry.begin({
            key: claim.replacementKey,
            generation: claim.generation,
            ...lifecycle(sceneParent, []),
        }).publish(surface);
    }

    assert.deepEqual(sceneParent.children, surfaces);
    assert.equal(registry.snapshot().activeCount, 4);
});

test('a failed add or commit leaves the previous generation active', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent(events);
    const first = claimedRoot('first', 'roads:tile', 1);
    registry.begin({
        key: 'roads:tile',
        generation: 1,
        ...lifecycle(sceneParent, events),
    }).publish(first);

    const failed = claimedRoot('failed', 'roads:tile', 2);
    const ticket = registry.begin({
        key: 'roads:tile',
        generation: 2,
        ...lifecycle(sceneParent, events),
    });
    assert.throws(() => ticket.publish(failed, {
        commit: () => { throw new Error('mask failed'); },
    }), /mask failed/);

    assert.equal(registry.getActive('roads:tile').root, first);
    assert.deepEqual(sceneParent.children, [first]);
    assert.equal(registry.snapshot().counters.failed, 1);
});

test('clear restores a backstop before retiring the active surface', () => {
    const events = [];
    const registry = createSurfacePublicationRegistry();
    const sceneParent = parent(events);
    const sea = claimedRoot('sea', 'mapped-sea', 1, {
        surfaceClass: SURFACE_CLASS.WATER,
    });
    registry.begin({
        key: 'mapped-sea',
        generation: 1,
        ...lifecycle(sceneParent, events),
    }).publish(sea);
    events.length = 0;

    registry.begin({
        key: 'mapped-sea',
        generation: 2,
        ...lifecycle(sceneParent, events),
    }).clear({ commit: () => events.push('restore:terrain') });

    assert.deepEqual(events, ['restore:terrain', 'retire:sea', 'remove:sea']);
    assert.equal(registry.getActive('mapped-sea'), null);
});

function terrainCurbBatchFixture() {
    const events = [], registry = createSurfacePublicationRegistry();
    const scene = parent(events), support = { terrain: 1, curb: 1 };
    const old = {}, next = {}, entries = [];
    for (const key of ['terrain', 'curb']) {
        old[key] = claimedRoot(`${key}:old`, key, 1);
        next[key] = claimedRoot(`${key}:next`, key, 2);
        registry.begin({ key, generation: 1, ...lifecycle(scene, events) }).publish(old[key]);
        entries.push({ ticket: registry.begin({ key, generation: 2, ...lifecycle(scene, events) }),
            root: next[key], prepare: () => events.push(`prepare:${key}`),
            commit: () => { support[key] = 2; events.push(`commit:${key}`); },
            rollback: () => { support[key] = 1; events.push(`rollback:${key}`); } });
    }
    events.length = 0;
    return { registry, scene, support, old, next, entries, events };
}

test('a staged terrain/curb batch retains all old roots and support until one publication', () => {
    const { registry, scene, support, old, next, entries, events } = terrainCurbBatchFixture();
    const observations = [];
    registry.subscribe(() => observations.push({ ...support,
        roots: ['terrain', 'curb'].map(key => registry.getActive(key).root) }));
    let physics = 1;
    const batch = registry.prepareBatch(entries, { commit: () => {
        assert.deepEqual(support, { terrain: 2, curb: 2 });
        physics = 2;
    } });
    assert.equal(batch.state, 'staged');
    assert.deepEqual(scene.children, [old.terrain, old.curb]);
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    assert.equal(physics, 1);
    assert.deepEqual(events, ['prepare:terrain', 'prepare:curb']);
    assert.throws(() => entries[0].ticket.publish(next.terrain), /staged/);
    assert.equal(batch.publish().status, 'published');
    assert.equal(physics, 2);
    assert.deepEqual(scene.children, [next.terrain, next.curb]);
    assert.equal(observations.length, 2);
    for (const observation of observations) assert.deepEqual(observation, {
        terrain: 2, curb: 2, roots: [next.terrain, next.curb],
    });
    assert.ok(events.indexOf('commit:curb') < events.indexOf('retire:terrain:old'));
    assert.equal(registry.snapshot().pendingCount, 0);
});

test('a failed dependent commit restores the entire previous batch without notifying observers', () => {
    const { registry, scene, support, old, entries } = terrainCurbBatchFixture();
    let notifications = 0;
    registry.subscribe(() => notifications++);
    entries[1].commit = () => { support.curb = 2; throw new Error('support installation failed'); };
    const batch = registry.prepareBatch(entries);
    assert.throws(() => batch.publish(), /support installation failed/);
    assert.equal(batch.state, 'failed');
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    assert.deepEqual(scene.children, [old.terrain, old.curb]);
    for (const key of ['terrain', 'curb']) assert.equal(registry.getActive(key).root, old[key]);
    assert.equal(notifications, 0);
    assert.equal(registry.snapshot().pendingCount, 0);
});

test('a failed group physics swap rolls back after every receiver commit', () => {
    const { registry, scene, support, old, entries } = terrainCurbBatchFixture();
    let physics = 1;
    const batch = registry.prepareBatch(entries, {
        commit: () => { physics = 2; throw new Error('physics swap failed'); },
        rollback: () => { physics = 1; },
    });
    assert.throws(() => batch.publish(), /physics swap failed/);
    assert.equal(physics, 1);
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    assert.deepEqual(scene.children, [old.terrain, old.curb]);
});

test('one superseded member rejects the whole prepared group and releases every candidate once', () => {
    const { registry, scene, support, old, entries, events } = terrainCurbBatchFixture();
    const batch = registry.prepareBatch(entries);
    const newest = registry.begin({ key: 'curb', generation: 3, ...lifecycle(scene, events) });
    assert.equal(batch.publish().status, 'stale-rejected');
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    assert.deepEqual(scene.children, [old.terrain, old.curb]);
    for (const key of ['terrain', 'curb']) assert.equal(events.filter(event => event === `retire:${key}:next`).length, 1);
    assert.equal(registry.snapshot().pendingCount, 1);
    newest.discard();
});

test('preparation validates all members before any candidate can be attached', () => {
    const { registry, scene, support, old, entries, events } = terrainCurbBatchFixture();
    entries[1].root.children[0].userData = {};
    assert.throws(() => registry.prepareBatch(entries), /unclaimed/);
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    assert.deepEqual(scene.children, [old.terrain, old.curb]);
    assert.ok(!events.some(event => event.startsWith('prepare:')));
    assert.equal(registry.snapshot().pendingCount, 0);
});

test('session close releases off-scene staged roots without allowing a later batch to revive them', () => {
    const { registry, entries, events } = terrainCurbBatchFixture();
    const batch = registry.prepareBatch(entries);
    registry.close({ retireActive: true });
    assert.equal(batch.publish().status, 'registry-closed');
    for (const key of ['terrain', 'curb']) assert.equal(events.filter(event => event === `retire:${key}:next`).length, 1);
    assert.equal(registry.snapshot().activeCount, 0);
    assert.equal(registry.snapshot().pendingCount, 0);
});

test('explicit batch cancellation and partial scene-add failure retain old generations', () => {
    for (const failure of ['cancel', 'add']) {
        const { registry, scene, support, old, next, entries } = terrainCurbBatchFixture();
        if (failure === 'add') entries[1].add = (_context, root) => {
            scene.add(root); throw new Error('partial add failed');
        };
        const batch = registry.prepareBatch(entries);
        if (failure === 'cancel') assert.equal(batch.discard().status, 'discarded');
        else assert.throws(() => batch.publish(), /partial add failed/);
        assert.deepEqual(scene.children, [old.terrain, old.curb]);
        assert.equal(next.terrain.parent, null);
        assert.equal(next.curb.parent, null);
        assert.deepEqual(support, { terrain: 1, curb: 1 });
        assert.equal(registry.snapshot().pendingCount, 0);
    }
});

test('throwing retirement remains a failure but cannot leave the superseded root drawing', () => {
    const registry = createSurfacePublicationRegistry(), scene = parent();
    const old = claimedRoot('old', 'terrain', 1), next = claimedRoot('next', 'terrain', 2);
    registry.begin({ key: 'terrain', generation: 1, parent: scene,
        retire: () => { throw new Error('disposal failed'); } }).publish(old);
    const result = registry.begin({ key: 'terrain', generation: 2, parent: scene }).publish(next);
    assert.equal(result.status, 'published-with-retirement-error');
    assert.deepEqual(scene.children, [next]);
    assert.equal(registry.getActive('terrain').root, next);
    assert.equal(registry.snapshot().counters.failed, 1);
    assert.equal(registry.snapshot().recentProblems.at(-1).type, 'retire-failed');
});

test('one batch restores ground and removes its superseded curb, with notification after both', () => {
    const registry = createSurfacePublicationRegistry(), scene = parent();
    const oldGround = claimedRoot('old-ground', 'terrain', 1), oldCurb = claimedRoot('old-curb', 'curb', 1);
    registry.begin({ key: 'terrain', generation: 1, parent: scene }).publish(oldGround);
    registry.begin({ key: 'curb', generation: 1, parent: scene }).publish(oldCurb);
    const nextGround = claimedRoot('next-ground', 'terrain', 2);
    const support = { terrain: 1, curb: 1 }, notices = [];
    registry.subscribe(event => {
        notices.push(event.type);
        assert.equal(registry.getActive('terrain').root, nextGround);
        assert.equal(registry.getActive('curb'), null);
        assert.deepEqual(support, { terrain: 2, curb: null });
        assert.deepEqual(scene.children, [nextGround]);
    });
    const clear = registry.begin({ key: 'curb', generation: 2, parent: scene });
    const batch = registry.prepareBatch([
        { ticket: registry.begin({ key: 'terrain', generation: 2, parent: scene }), root: nextGround,
            commit: () => { support.terrain = 2; } },
        { ticket: clear, clear: true, commit: () => { support.curb = null; } },
    ]);
    assert.deepEqual(scene.children, [oldGround, oldCurb]);
    assert.deepEqual(support, { terrain: 1, curb: 1 });
    const result = batch.publish();
    assert.equal(result.status, 'published');
    assert.deepEqual(result.results.map(row => row.status), ['published', 'cleared']);
    assert.deepEqual(notices, ['published', 'cleared']);
    assert.equal(clear.state, 'cleared');
    assert.equal(registry.snapshot().counters.cleared, 1);
});

test('failed or superseded mixed clear/replace batches keep old roots, support and ownership', () => {
    for (const failure of ['commit', 'stale', 'cancel']) {
        const registry = createSurfacePublicationRegistry(), scene = parent();
        const oldGround = claimedRoot('old-ground', 'terrain', 1), oldCurb = claimedRoot('old-curb', 'curb', 1);
        registry.begin({ key: 'terrain', generation: 1, parent: scene }).publish(oldGround);
        registry.begin({ key: 'curb', generation: 1, parent: scene }).publish(oldCurb);
        const nextGround = claimedRoot('next-ground', 'terrain', 2);
        const support = { terrain: 1, curb: 1 }, notices = [];
        registry.subscribe(event => notices.push(event));
        const batch = registry.prepareBatch([
            { ticket: registry.begin({ key: 'terrain', generation: 2, parent: scene }), root: nextGround,
                commit: () => { support.terrain = 2; }, rollback: () => { support.terrain = 1; } },
            { ticket: registry.begin({ key: 'curb', generation: 2 }), clear: true,
                commit: () => { support.curb = null; }, rollback: () => { support.curb = 1; } },
        ], { commit: () => { if (failure === 'commit') throw new Error('support swap failed'); } });
        if (failure === 'stale') {
            registry.begin({ key: 'curb', generation: 3 });
            assert.equal(batch.publish().status, 'stale-rejected');
        } else if (failure === 'cancel') batch.discard();
        else assert.throws(() => batch.publish(), /support swap failed/);
        assert.deepEqual(support, { terrain: 1, curb: 1 });
        assert.deepEqual(scene.children, [oldGround, oldCurb]);
        assert.equal(registry.getActive('terrain').root, oldGround);
        assert.equal(registry.getActive('curb').root, oldCurb);
        assert.equal(nextGround.parent, null);
        assert.equal(notices.length, 0);
    }
});

test('rootless clear entries release staged resources once on cancel, stale rejection and sibling failure', () => {
    for (const failure of ['cancel', 'stale', 'commit']) {
        const registry = createSurfacePublicationRegistry();
        const scene = parent();
        const oldGround = claimedRoot('old-ground', 'terrain', 1);
        const oldCurb = claimedRoot('old-curb', 'curb', 1);
        registry.begin({ key: 'terrain', generation: 1, parent: scene }).publish(oldGround);
        registry.begin({ key: 'curb', generation: 1, parent: scene }).publish(oldCurb);
        const nextGround = claimedRoot('next-ground', 'terrain', 2);
        let released = 0;
        const clear = registry.begin({ key: 'curb', generation: 2,
            discard: () => { released += 1; } });
        const batch = registry.prepareBatch([
            { ticket: registry.begin({ key: 'terrain', generation: 2, parent: scene }), root: nextGround },
            { ticket: clear, clear: true, commit: () => { if (failure === 'commit') throw new Error('sibling failed'); } },
        ], { commit: () => { if (failure === 'commit') throw new Error('group failed'); } });
        if (failure === 'cancel') batch.discard();
        else if (failure === 'stale') {
            registry.begin({ key: 'curb', generation: 3 });
            assert.equal(batch.publish().status, 'stale-rejected');
        } else assert.throws(() => batch.publish(), /sibling failed|group failed/);
        assert.equal(released, 1);
        assert.deepEqual(scene.children, [oldGround, oldCurb]);
        assert.equal(registry.getActive('terrain').root, oldGround);
        assert.equal(registry.getActive('curb').root, oldCurb);
        assert.equal(nextGround.parent, null);
    }
});

test('false row or group commits roll back prior swaps and discard candidates exactly once', () => {
    for (const mode of ['row', 'group']) {
        const registry = createSurfacePublicationRegistry();
        const scene = parent();
        const oldGround = claimedRoot('old-ground', 'terrain', 1);
        const oldCurb = claimedRoot('old-curb', 'curb', 1);
        registry.begin({ key: 'terrain', generation: 1, parent: scene }).publish(oldGround);
        registry.begin({ key: 'curb', generation: 1, parent: scene }).publish(oldCurb);
        const nextGround = claimedRoot('next-ground', 'terrain', 2);
        const support = { terrain: 1, curb: 1 };
        let discarded = 0;
        const ticket = registry.begin({ key: 'curb', generation: 2, discard: () => { discarded += 1; } });
        const batch = registry.prepareBatch([
            { ticket: registry.begin({ key: 'terrain', generation: 2, parent: scene }), root: nextGround,
                commit: () => { support.terrain = 2; }, rollback: () => { support.terrain = 1; } },
            { ticket, clear: true, commit: () => { support.curb = null; return mode === 'row' ? false : undefined; },
                rollback: () => { support.curb = 1; } },
        ], { commit: context => { support.terrain = 3; return mode === 'group' ? false : undefined; },
            rollback: () => { support.terrain = 1; } });
        assert.throws(() => batch.publish(), { code: 'rejected-publication-commit' });
        assert.equal(discarded, 1);
        assert.deepEqual(support, { terrain: 1, curb: 1 });
        assert.deepEqual(scene.children, [oldGround, oldCurb]);
        assert.equal(registry.getActive('terrain').root, oldGround);
        assert.equal(registry.getActive('curb').root, oldCurb);
        assert.equal(registry.snapshot().counters.published, 2);
    }
});

test('a missing root never silently becomes a clear operation', () => {
    const registry = createSurfacePublicationRegistry();
    const ticket = registry.begin({ key: 'terrain', generation: 1 });
    assert.throws(() => registry.prepareBatch([{ ticket }]), { code: 'invalid-publication-batch' });
    assert.throws(() => registry.prepareBatch([{ ticket, root: claimedRoot('ground', 'terrain', 1), clear: true }]),
        { code: 'invalid-publication-batch' });
    assert.equal(ticket.state, 'pending');
});

test('captured input validity is checked at preparation and again before any scene or support swap', () => {
    for (const when of ['prepare', 'publish', 'throw']) {
        const { registry, scene, support, old, next, entries } = terrainCurbBatchFixture();
        let current = when !== 'prepare', groupChecks = 0;
        entries[0].isCurrent = () => {
            if (when === 'throw' && !current) throw new Error('source query unavailable');
            return current;
        };
        const batch = registry.prepareBatch(entries, { isCurrent: () => { groupChecks++; return true; } });
        if (when === 'prepare') assert.equal(batch.status, 'dependency-revised');
        else {
            current = false;
            assert.equal(batch.publish().status, when === 'throw' ? 'dependency-check-failed' : 'dependency-revised');
            assert.equal(groupChecks, 1);
        }
        assert.deepEqual(scene.children, [old.terrain, old.curb]);
        assert.deepEqual(support, { terrain: 1, curb: 1 });
        assert.equal(next.terrain.parent, null);
        assert.equal(next.curb.parent, null);
        assert.equal(registry.snapshot().pendingCount, 0);
        if (when === 'throw') assert.equal(registry.snapshot().recentProblems.at(-1).type, 'dependency-check-failed');
    }
});

test('validation scope runs each complete freshness check once while row validity remains per entry', () => {
    const registry = createSurfacePublicationRegistry();
    const entries = [];
    let rowCalls = 0, scopeCalls = 0;
    for (const key of ['a', 'b', 'c']) {
        const ticket = registry.begin({ key, generation: 1 });
        entries.push({ ticket, clear: true, isCurrent: () => { rowCalls++; return true; } });
    }
    const batch = registry.prepareBatch(entries, {
        withValidationScope(check) { scopeCalls++; return check(); },
        isCurrent: () => true,
    });
    assert.equal(scopeCalls, 1); assert.equal(rowCalls, 3);
    batch.publish();
    assert.equal(scopeCalls, 2); assert.equal(rowCalls, 6);
});

test('validation scopes end before resource preparation, commit and notification, while stale batches reject', () => {
    const registry = createSurfacePublicationRegistry();
    const events = [], scene = parent(events);
    let scopeOpen = false, committed = false, notifications = 0;
    registry.subscribe(() => { assert.equal(scopeOpen, false); notifications++; });
    const ticket = registry.begin({ key: 'scoped', generation: 1, ...lifecycle(scene, events) });
    const batch = registry.prepareBatch([{ ticket, root: claimedRoot('scoped', 'scoped', 1),
        prepare: () => assert.equal(scopeOpen, false),
        commit: () => { assert.equal(scopeOpen, false); committed = true; } }], {
        withValidationScope(check) { scopeOpen = true; const result = check(); scopeOpen = false; return result; },
    });
    assert.equal(batch.publish().status, 'published');
    assert.equal(committed, true); assert.equal(notifications, 1);
    let current = true;
    const staleTicket = registry.begin({ key: 'stale-scoped', generation: 1 });
    const stale = registry.prepareBatch([{ ticket: staleTicket, clear: true }], {
        isCurrent: () => current,
        withValidationScope(check) { return check(); },
    });
    current = false;
    assert.equal(stale.publish().status, 'dependency-revised');
});

test('broken validation scopes cannot bypass checks or use them asynchronously', async () => {
    for (const [withValidationScope, expectedCalls] of [
        [check => { check(); throw new Error('scope failure'); }, 1],
        [check => (check(), check()), 2],
        [check => { queueMicrotask(check); return null; }, 0],
        [check => { check(); return Promise.resolve(null); }, 1],
        [() => true, 0],
    ]) {
        const registry = createSurfacePublicationRegistry();
        const ticket = registry.begin({ key: 'broken', generation: 1 });
        const batch = registry.prepareBatch([{ ticket, clear: true }], { withValidationScope });
        assert.equal(batch.status, 'dependency-check-failed');
        assert.equal(ticket.state, 'dependency-check-failed');
        await new Promise(resolve => queueMicrotask(resolve));
    }
});
