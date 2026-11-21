// Verifies the semantic civil-ground stack without Three.js, streaming, or DOM state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    changedCivilGroundDependencyBounds,
    changedCivilGroundDependencyBoundsSteps,
    CIVIL_GROUND_AUTHORITY,
    CIVIL_GROUND_AUTHORITY_ORDER,
    CivilGroundComposition,
    civilGroundAuthoritiesBefore,
} from '../core/civil-ground-composition.js';

const cabSource = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

function composition(terrainSceneY = 1) {
    return new CivilGroundComposition({
        terrainSceneYAtLocal: () => terrainSceneY,
    });
}

test('semantic authority order is fixed independently of registration order', () => {
    const ground = composition();
    const calls = [];
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, {
        id: 'road-formation',
        sampleSceneYAtLocal: (_x, _z, { inputSceneY }) => {
            calls.push(`road:${inputSceneY}`);
            return inputSceneY + 3;
        },
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: (_x, _z, { inputSceneY }) => {
            calls.push(`rail:${inputSceneY}`);
            return inputSceneY + 2;
        },
    });

    assert.equal(ground.sceneYAtLocal(0, 0, {
        throughAuthority: CIVIL_GROUND_AUTHORITY.ROAD,
    }), 6);
    assert.deepEqual(calls, ['rail:1', 'road:3']);
    assert.deepEqual(CIVIL_GROUND_AUTHORITY_ORDER, [
        'terrain', 'rail', 'road', 'sidewalk', 'path', 'building',
    ]);
});

test('an owner consumes only earlier work and null leaves that input untouched', () => {
    const ground = composition(0.25);
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: x => (x < 10 ? 2.075 : null),
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, {
        id: 'road-formation',
        sampleSceneYAtLocal: () => 99,
    });

    assert.equal(
        ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 5, 0),
        2.075,
    );
    assert.equal(
        ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 20, 0),
        0.25,
    );
    assert.equal(
        ground.inputOwnerAuthorityAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 5, 0),
        CIVIL_GROUND_AUTHORITY.RAIL,
    );
    assert.equal(
        ground.inputOwnerAuthorityAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 20, 0),
        CIVIL_GROUND_AUTHORITY.TERRAIN,
    );
    assert.equal(
        ground.inputSceneYOwnedByAtLocal(
            CIVIL_GROUND_AUTHORITY.ROAD,
            CIVIL_GROUND_AUTHORITY.RAIL,
            5,
            0,
        ),
        2.075,
    );
    assert.equal(
        ground.inputSceneYOwnedByAtLocal(
            CIVIL_GROUND_AUTHORITY.ROAD,
            CIVIL_GROUND_AUTHORITY.TERRAIN,
            5,
            0,
        ),
        null,
    );
    assert.equal(
        ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.SIDEWALK, 5, 0),
        99,
        'a sidewalk consumes road, while a road never consumes itself',
    );
    ground.resolveAtLocal = () => assert.fail('hot sampling must not build an inspector trace');
    assert.equal(
        ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 5, 0),
        2.075,
    );
    assert.equal(
        ground.inputOwnerAuthorityAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 5, 0),
        CIVIL_GROUND_AUTHORITY.RAIL,
    );
    assert.equal(
        ground.inputSceneYOwnedByAtLocal(
            CIVIL_GROUND_AUTHORITY.ROAD,
            CIVIL_GROUND_AUTHORITY.RAIL,
            5,
            0,
        ),
        2.075,
    );
});

test('resolution reports which semantic owner claimed the visible ground', () => {
    const ground = composition(4);
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => null,
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, {
        id: 'road-formation',
        sampleSceneYAtLocal: () => 5,
    });

    const resolved = ground.resolveAtLocal(2, 3, {
        throughAuthority: CIVIL_GROUND_AUTHORITY.ROAD,
    });
    assert.equal(resolved.sceneY, 5);
    assert.equal(resolved.ownerAuthority, CIVIL_GROUND_AUTHORITY.ROAD);
    assert.equal(resolved.ownerId, 'road-formation');
    assert.deepEqual(
        resolved.stages.map(stage => [stage.authority, stage.claimed]),
        [['terrain', true], ['rail', false], ['road', true]],
    );
});

test('visual fallback never enters the civil evidence stack', () => {
    const ground = new CivilGroundComposition({
        terrainSceneYAtLocal: () => 7,
        terrainEvidenceSceneYAtLocal: () => null,
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => 9,
    });

    assert.equal(ground.sceneYAtLocal(0, 0), 9,
        'the visual stack remains total enough to cover void');
    assert.equal(ground.evidenceSceneYAtLocal(0, 0), null,
        'neither fallback terrain nor a visual-only provider is evidence');
    assert.equal(
        ground.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 0, 0),
        null,
    );

    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => 9,
        sampleEvidenceSceneYAtLocal: () => 0,
    });
    assert.equal(ground.evidenceSceneYAtLocal(0, 0), 0,
        'a genuine measured zero remains valid evidence');
});

test('a bounded terrain replacement becomes the shared baseline for later civil work', () => {
    const ground = new CivilGroundComposition({
        terrainSceneYAtLocal: () => 6,
        terrainEvidenceSceneYAtLocal: () => 6,
    });
    ground.setTerrainReplacement({
        id: 'mapped-coast-terrain-infill',
        sampleSceneYAtLocal: x => (x < 5 ? -1 : null),
        sampleEvidenceSceneYAtLocal: x => (x < 5 ? -1 : null),
    });

    assert.equal(ground.terrainReplacementOwnsAtLocal(2, 0), true);
    assert.equal(ground.terrainReplacementOwnsAtLocal(8, 0), false);
    assert.equal(
        ground.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.RAIL, 2, 0),
        -1,
    );
    assert.equal(
        ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 8, 0),
        6,
        'raw DGU remains the terrain baseline outside the replacement footprint',
    );
    const resolved = ground.resolveAtLocal(2, 0, {
        throughAuthority: CIVIL_GROUND_AUTHORITY.TERRAIN,
    });
    assert.equal(resolved.ownerAuthority, CIVIL_GROUND_AUTHORITY.TERRAIN);
    assert.equal(resolved.ownerId, 'mapped-coast-terrain-infill');
    assert.equal(resolved.sceneY, -1);
});

test('terrain replacement revisions publish bounded dependency changes and release safely', () => {
    const ground = composition(4);
    const bounds = { minX: 0, minZ: 0, maxX: 20, maxZ: 10 };
    const firstSnapshot = { entries: [{ signature: 'generation-1', bounds }] };
    const releaseOld = ground.setTerrainReplacement({
        id: 'mapped-coast-terrain-infill',
        sampleSceneYAtLocal: () => 1,
        dependencySnapshot: () => firstSnapshot,
    });
    assert.deepEqual(
        ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.RAIL)
            .entries.map(entry => entry.signature),
        ['terrain:mapped-coast-terrain-infill:generation-1'],
    );

    const releaseNew = ground.setTerrainReplacement({
        id: 'mapped-coast-terrain-infill',
        sampleSceneYAtLocal: () => 2,
        dependencySnapshot: () => ({
            entries: [{ signature: 'generation-2', bounds }],
        }),
    });
    assert.equal(releaseOld(), false);
    assert.equal(ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.RAIL, 0, 0), 2);
    assert.match(
        ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.RAIL).signature,
        /generation-2/,
    );
    assert.equal(releaseNew(), true);
    assert.equal(ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.RAIL, 0, 0), 4);
    assert.deepEqual(
        ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.RAIL).entries,
        [],
    );
});

test('one named authority cannot be claimed by competing subsystems', () => {
    const ground = composition();
    const releaseOld = ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => 2,
    });
    assert.throws(() => ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'road-formation',
        sampleSceneYAtLocal: () => 3,
    }), /already owned/);

    const releaseNew = ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => 4,
    });
    assert.equal(releaseOld(), false, 'an old lifecycle cleanup cannot remove a replacement');
    assert.equal(ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 0, 0), 4);
    assert.equal(releaseNew(), true);
    assert.equal(ground.inputSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, 0, 0), 1);
});

test('dependency snapshots follow semantic order and namespace owner tokens', () => {
    const ground = composition();
    const entry = (signature, x) => ({
        signature,
        bounds: { minX: x, minZ: 0, maxX: x + 10, maxZ: 10 },
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, {
        id: 'road-formation',
        sampleSceneYAtLocal: () => null,
        dependencySnapshot: () => ({ entries: [entry('road-a', 20)] }),
    });
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => null,
        dependencySnapshot: () => ({ entries: [entry('rail-a', 0)] }),
    });

    const roadInput = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD);
    assert.deepEqual(roadInput.entries.map(item => item.signature), [
        'rail:rail-formation:rail-a',
    ]);
    const sidewalkInput = ground.dependencySnapshotBefore(
        CIVIL_GROUND_AUTHORITY.SIDEWALK,
    );
    assert.deepEqual(sidewalkInput.entries.map(item => item.signature), [
        'rail:rail-formation:rail-a',
        'road:road-formation:road-a',
    ]);
    assert.deepEqual(civilGroundAuthoritiesBefore(CIVIL_GROUND_AUTHORITY.PATH), [
        'terrain', 'rail', 'road', 'sidewalk',
    ]);
});

test('dependency diff is order-independent and returns only changed bounds', () => {
    const entry = (signature, x) => ({
        signature,
        bounds: { minX: x, minZ: 0, maxX: x + 10, maxZ: 10 },
    });
    const previous = [entry('same', 0), entry('removed', 20)];
    const next = [entry('added', 40), entry('same', 0)];
    assert.deepEqual(changedCivilGroundDependencyBounds(previous, next), [
        { minX: 20, minZ: 0, maxX: 30, maxZ: 10 },
        { minX: 40, minZ: 0, maxX: 50, maxZ: 10 },
    ]);
});

test('cooperative dependency closure preserves multiplicity, old/new regions and explicit limits', () => {
    const bounds = x => ({ minX: x, minZ: 0, maxX: x + 1, maxZ: 1 });
    const same = { signature: 'same', bounds: bounds(0) };
    const old = { signature: 'old', changeBounds: [bounds(20), bounds(1000)] };
    const added = { signature: 'new', bounds: bounds(2000) };
    const before = [same, same, old], after = [added, same];
    let clock = 0, current = true, reads = 0;
    const counted = entry => ({ ...entry, get signature() { reads++; return entry.signature; } });
    const options = { maxEntries: 8, maxBounds: 8, now: () => clock += .3, isCurrent: () => current };
    const steps = changedCivilGroundDependencyBoundsSteps(before.map(counted), after.map(counted), options);
    let next, yields = 0;
    do {
        const previousReads = reads; next = steps.next(); yields++;
        assert.ok(reads - previousReads <= 2, 'one visit cannot scan the whole dependency table');
    } while (!next.done);
    assert.ok(yields > 2);
    assert.deepEqual(next.value, [bounds(0), bounds(20), bounds(1000), bounds(2000)]);
    const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
    assert.deepEqual(drain(changedCivilGroundDependencyBoundsSteps([...before].reverse(), [...after].reverse(), options))
        .sort((a, b) => a.minX - b.minX), next.value);
    for (const limit of [{ maxEntries: 4 }, { maxBounds: 3 }]) {
        assert.throws(() => drain(changedCivilGroundDependencyBoundsSteps(before, after, { ...options, ...limit })),
            { code: 'ground-dependency-capacity' });
    }
    const stale = changedCivilGroundDependencyBoundsSteps(before, after, options);
    assert.equal(stale.next().done, false); current = false;
    assert.throws(() => drain(stale), { code: 'ground-dependency-stale' });
});

test('the session creates one shared composition before world layers start', () => {
    const compositionIndex = cabSource.indexOf('ctx.civilGround = new CivilGroundComposition');
    const layerStartIndex = cabSource.indexOf('cabState.layerStartup = createLayerStartupCoordinator');
    assert.ok(compositionIndex >= 0);
    assert.ok(layerStartIndex > compositionIndex);
});

// Roads ask for this once per FRAME, so composition reuses its last result when
// every provider handed back the same snapshot object. These pin both halves of
// that: the reuse itself, and every way the inputs can legitimately change.
test('composition reuses its result only while the provider snapshots are identical', () => {
    const entry = (signature, x) => ({
        signature,
        bounds: { minX: x, minZ: 0, maxX: x + 10, maxZ: 10 },
    });
    const ground = new CivilGroundComposition({ terrainSceneYAtLocal: () => 0 });
    let railSnapshot = { entries: [entry('rail-a', 0)] };
    let calls = 0;
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => null,
        dependencySnapshot: () => { calls += 1; return railSnapshot; },
    });

    const first = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD);
    const second = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD);
    assert.equal(second, first, 'an unchanged frame must not recompose');
    assert.equal(calls, 2, 'providers are still consulted every frame');

    // A different authority sees a different prefix and must not read the
    // ROAD cache entry.
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.ROAD, {
        id: 'road-formation',
        sampleSceneYAtLocal: () => null,
        dependencySnapshot: () => ({ entries: [entry('road-a', 20)] }),
    });
    const sidewalk = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.SIDEWALK);
    assert.deepEqual(sidewalk.entries.map(item => item.signature), [
        'rail:rail-formation:rail-a',
        'road:road-formation:road-a',
    ]);

    // A genuinely new snapshot object recomposes, even with equal content.
    railSnapshot = { entries: [entry('rail-a', 0)] };
    const afterRebuild = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD);
    assert.notEqual(afterRebuild, first, 'a rebuilt snapshot must recompose');
    assert.equal(afterRebuild.signature, first.signature,
        'an unchanged ground still yields an equal signature (a downstream no-op)');

    // Changed content reaches the consumer rather than being served from cache.
    railSnapshot = { entries: [entry('rail-b', 40)] };
    const changed = ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD);
    assert.deepEqual(changed.entries.map(item => item.signature), [
        'rail:rail-formation:rail-b',
    ]);
});

test('a provider publishing an unbounded dependency throws every frame, never once', () => {
    const ground = new CivilGroundComposition({ terrainSceneYAtLocal: () => 0 });
    const bad = { entries: [{ signature: 'rail-a', bounds: { minX: 0, minZ: 0, maxX: NaN, maxZ: 10 } }] };
    ground.setGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL, {
        id: 'rail-formation',
        sampleSceneYAtLocal: () => null,
        dependencySnapshot: () => bad,
    });
    for (let frame = 0; frame < 2; frame += 1) {
        assert.throws(
            () => ground.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD),
            /unbounded dependency/,
            `frame ${frame}`,
        );
    }
});
