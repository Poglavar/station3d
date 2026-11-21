// Walk-mode recovery rules keep accidental terrain seam misses safe while
// preserving intentional underground spaces and structural openings.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearWalkKeys,
    createWalkState,
    isWalkSupportOverhead,
    onKeyDown,
    reachableWalkSupportY,
    resolveRailFormationWalkSupport,
    resolveRoadReplacementWalkSupport,
    resolveViaductTerrainWalkSupport,
    selectWalkBaselineSupportY,
    setWalkSpeedBoost,
    resolveWalkSupportContext,
    shouldRecoverTerrainFloor,
    shouldUseBuildingRoofBump,
    shouldAcceptRoofSupport,
    seaSurfaceSupportY,
    stepWalk,
} from '../modes/walk.js';

// A roof is landing support only from above: an airborne walker whose feet
// are well below the roof hit is inside the block and must not be teleported
// up onto it when the jetpack releases. A grounded walker is still lifted out.
test('a roof supports an airborne walker only from above it', () => {
    assert.equal(shouldAcceptRoofSupport(41, 40, { airborne: true }), true, 'hovering just over the roof');
    assert.equal(shouldAcceptRoofSupport(39, 40, { airborne: true }), true, 'a step below the roof line still lands');
    assert.equal(shouldAcceptRoofSupport(20, 40, { airborne: true }), false, 'inside the block mid-air');
    assert.equal(shouldAcceptRoofSupport(20, 40, { airborne: false }), true, 'a grounded walker inside a block is lifted out');
    assert.equal(shouldAcceptRoofSupport(20, null, { airborne: false }), false, 'no roof, no support');
});

// ── Support context over/inside bored tunnels (terrain worlds) ─────────────
// The flat world classified "underground" by absolute scene Y (< -0.5), which
// can never fire on a hillside where a bore's interior sits at +2..+12. These
// lock the terrain-world rules that replaced it.

test('inside a bore: the tube floor is the support and recovery is off', () => {
    const context = resolveWalkSupportContext({
        walkerY: 9.7,               // in the Brajdica bore
        terrainY: 24.0,             // the hill overhead
        corridorFloorY: 9.6,
        insideCutPolygon: true,     // the photo-carve polygons claim it is open
        insideCutPolygonStructural: true,
        tunnelRoof: 'intact-roof',
        hasTerrainWorld: true,
    });
    assert.equal(context.subsurface, true, 'tube floor is the support');
    assert.equal(context.structuralCutout, false, 'the roof overhead is real');
    assert.equal(context.suppressRecovery, true, 'never teleport up through the hill');
});

test('bumping the bore wall (floor query miss) must not recover to the surface', () => {
    const context = resolveWalkSupportContext({
        walkerY: 9.7,
        terrainY: 24.0,
        corridorFloorY: null,       // probe pushed just outside the corridor
        tunnelFloorY: 9.6,          // the formation still knows its tube floor
        insideCutPolygon: true,
        insideCutPolygonStructural: true,
        tunnelRoof: 'intact-roof',
        hasTerrainWorld: true,
    });
    assert.equal(context.subsurface, false);
    assert.equal(context.suppressRecovery, true, 'still under the hill beside the bore');
});

test('standing on intact ground above the bore keeps the surface, not the tube', () => {
    const context = resolveWalkSupportContext({
        walkerY: 24.0,              // on the hill, directly over the bore
        terrainY: 24.0,
        corridorFloorY: 9.6,        // the tube runs beneath
        insideCutPolygon: true,     // photo-carve polygons still claim "open"
        insideCutPolygonStructural: true,
        tunnelRoof: 'intact-roof',
        hasTerrainWorld: true,
    });
    assert.equal(context.subsurface, false, 'no fall-through into the tunnel');
    assert.equal(context.structuralCutout, false, 'terrain stays a valid floor');
    assert.equal(context.suppressRecovery, false);
});

test('the baseline picks the highest support within a step, not "rail first"', () => {
    // On the hill over a bored tunnel the rail query answers with the tube
    // segment far below; the walker standing on terrain must get the terrain.
    assert.equal(selectWalkBaselineSupportY({
        railY: 13.7, terrainY: 48.4, walkerY: 47.2,
    }), 48.4);
    // Inside the bore the terrain is out of reach overhead; the bed is the floor.
    assert.equal(selectWalkBaselineSupportY({
        railY: 13.7, terrainY: 48.4, walkerY: 14.5,
    }), 13.7);
    // Standing in a shallow street cut: the lowered bed wins over the terrain lip.
    assert.equal(selectWalkBaselineSupportY({
        railY: -1.4, roadY: -1.2, terrainY: 0, walkerY: -1.2,
    }), -1.2);
    // No height context (rooftop probes): the legacy priority is preserved.
    assert.equal(selectWalkBaselineSupportY({ railY: 5, terrainY: 9 }), 5);
});

test('falling through the hill far above the tube recovers to the surface', () => {
    // A walker who dipped below the terrain 30 m ABOVE the bore is a seam
    // fall, not a tunnel visitor: the tube floor must not be offered, and the
    // ordinary terrain recovery must stay armed.
    const context = resolveWalkSupportContext({
        walkerY: 40.0,
        terrainY: 47.6,
        corridorFloorY: 14.5,
        insideCutPolygon: true,
        insideCutPolygonStructural: true,
        tunnelRoof: 'intact-roof',
        hasTerrainWorld: true,
    });
    assert.equal(context.subsurface, false, 'no tube floor for a hill-fall');
    assert.equal(context.suppressRecovery, false, 'terrain recovery stays armed');
});

test('portal carve zones and flat worlds keep the legacy classification', () => {
    const carve = resolveWalkSupportContext({
        walkerY: 6.0,
        terrainY: 12.0,
        corridorFloorY: 5.9,
        insideCutPolygon: true,
        insideCutPolygonStructural: true,
        tunnelRoof: 'portal-carve',  // genuinely open mouth
        hasTerrainWorld: true,
    });
    assert.equal(carve.structuralCutout, true, 'the mouth IS open');
    assert.equal(carve.subsurface, true);
    const flat = resolveWalkSupportContext({
        walkerY: -8.2,               // flat-world underground station
        terrainY: null,
        corridorFloorY: -8.3,
        insideCutPolygon: false,
        insideCutPolygonStructural: false,
        tunnelRoof: null,
        hasTerrainWorld: false,
    });
    assert.equal(flat.subsurface, true, 'flat-world negative-Y rule still works');
    assert.equal(flat.suppressRecovery, false);
});

test('an unreachable viaduct deck is overhead, not walk support', () => {
    assert.equal(isWalkSupportOverhead(0, 7.4), true);
    assert.equal(isWalkSupportOverhead(0, 1.75), false);
    assert.equal(isWalkSupportOverhead(6.5, 7.4), false);
});

test('a road bridge is firm only when its deck is within walking reach', () => {
    assert.equal(reachableWalkSupportY(0, 6.5), null);
    assert.equal(reachableWalkSupportY(6.4, 6.5), 6.5);
    assert.equal(reachableWalkSupportY(6.5, 6.5), 6.5);
    assert.equal(reachableWalkSupportY(6.5, null), null);
});

test('visible pedestrian paving stays firm over a lower road tunnel', () => {
    const onPromenade = resolveRoadReplacementWalkSupport({
        walkerY: 36.4,
        terrainY: 36.46,
        renderedSurfaceY: 36.5,
        insideOpening: true,
        insideCorridor: true,
    });
    assert.equal(onPromenade.firmRenderedSurfaceY, 36.5);
    assert.equal(
        onPromenade.insideReplacementCorridor,
        false,
        'the exact visible paving triangle owns feet at surface level',
    );

    const insideTunnel = resolveRoadReplacementWalkSupport({
        walkerY: 33.81,
        terrainY: 36.46,
        renderedSurfaceY: 36.5,
        insideOpening: true,
        insideCorridor: true,
    });
    assert.equal(insideTunnel.firmRenderedSurfaceY, null, 'the paving is overhead');
    assert.equal(
        insideTunnel.insideReplacementCorridor,
        true,
        'the lower solved floor remains authoritative inside the tunnel',
    );
});

test('an open replacement trench still suppresses unsupported terrain', () => {
    const support = resolveRoadReplacementWalkSupport({
        walkerY: 5.9,
        terrainY: 12,
        renderedSurfaceY: null,
        insideOpening: true,
        insideCorridor: true,
    });
    assert.equal(support.firmRenderedSurfaceY, null);
    assert.equal(support.insideReplacementCorridor, true);
});

test('a rendered rail cut replaces the invisible DGU floor with civil ground', () => {
    const portalApproach = resolveRailFormationWalkSupport({
        walkerY: 0,
        civilGroundY: -6.99,
        insideOpenCut: true,
    });
    assert.equal(portalApproach.ownsCut, true);
    assert.equal(portalApproach.firmGroundY, -6.99,
        'the walker must drop onto the visible rail formation');

    const ordinaryTerrain = resolveRailFormationWalkSupport({
        walkerY: 0,
        civilGroundY: -6.99,
        insideOpenCut: false,
    });
    assert.equal(ordinaryTerrain.ownsCut, false);
    assert.equal(ordinaryTerrain.firmGroundY, null,
        'a nearby lower rail profile must not capture intact terrain');
});

test('a viaduct deck replaces intrusive terrain only at the reachable level', () => {
    const onDeck = resolveViaductTerrainWalkSupport({
        walkerY: 20.3,
        deckY: 20.334,
        terrainCutoutActive: true,
    });
    assert.equal(onDeck.ownsTerrain, true);
    assert.equal(onDeck.firmDeckY, 20.334,
        'the concrete deck is the firm replacement for the removed DGU lid');

    const beneathDeck = resolveViaductTerrainWalkSupport({
        walkerY: 10,
        deckY: 20.334,
        terrainCutoutActive: true,
    });
    assert.equal(beneathDeck.ownsTerrain, false,
        'the same bridge remains overhead for somebody beneath it');
    assert.equal(beneathDeck.firmDeckY, null);
});

test('recovers a walker stranded beneath ordinary terrain', () => {
    assert.equal(shouldRecoverTerrainFloor(-5, 10), true);
    const state = createWalkState(43.5, 16.4, { initialY: -5 });
    const pose = stepWalk(
        state,
        1 / 60,
        0,
        () => 10,
        () => ({ x: 0, z: 0 }),
    );
    assert.equal(pose.y, 10);
    assert.equal(pose.airborne, false);
});

test('does not recover through an intentional underground opening', () => {
    assert.equal(shouldRecoverTerrainFloor(-5, 10, { insideSurfaceCutout: true }), false);
    assert.equal(shouldRecoverTerrainFloor(-5, 10, { insideStructuralCutout: true }), false);
    assert.equal(shouldRecoverTerrainFloor(-5, 10, { insideSubsurfaceCorridor: true }), false);
});

test('does not recover a walker who is standing on a real support', () => {
    // Portal-approach bench: the walker stands on engineered dressing at 3.4
    // while the raw hilltop reads 19.4. A support within a body height below
    // the walker means they are NOT falling through anything — recovery must
    // never out-rank that floor (it teleported them 16 m up onto the hill).
    assert.equal(shouldRecoverTerrainFloor(3.44, 19.4, { nearestSupportY: 3.44 }), false);
    assert.equal(shouldRecoverTerrainFloor(3.44, 19.4, { nearestSupportY: 2.5 }), false);
    // The support itself far beneath the walker (only the tube floor answers
    // inside a hill) is a true fall-through: recovery still fires.
    assert.equal(shouldRecoverTerrainFloor(3.44, 19.4, { nearestSupportY: -8 }), true);
    assert.equal(shouldRecoverTerrainFloor(3.44, 19.4, { nearestSupportY: null }), true);
    assert.equal(shouldRecoverTerrainFloor(3.44, 19.4, {}), true);
});

test('building roof bump uses ground-relative height in Zagreb and Split', () => {
    assert.equal(shouldUseBuildingRoofBump(0, 0), true, 'flat Zagreb street');
    assert.equal(shouldUseBuildingRoofBump(-36, -36), true, 'Split coast below its session anchor');
    assert.equal(shouldUseBuildingRoofBump(-36, 0), false, 'walker genuinely below the surface');
    assert.equal(shouldUseBuildingRoofBump(-36, null), false, 'missing support is not street level');
});

test('building roof bump preserves intentional openings', () => {
    assert.equal(shouldUseBuildingRoofBump(0, 0, { insideSurfaceCutout: true }), false);
    assert.equal(shouldUseBuildingRoofBump(0, 0, { insideStructuralCutout: true }), false);
    assert.equal(shouldUseBuildingRoofBump(0, 0, { insideSubsurfaceCorridor: true }), false);
    assert.equal(shouldUseBuildingRoofBump(0, 0, { insideBuildingPassage: true }), false);
});

test('photo mode has no hidden scene-zero or model-terrain baseline', () => {
    assert.equal(selectWalkBaselineSupportY({ photoWorld: true }), null);
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: true,
        railY: 0,
        roadY: 12,
        terrainY: 26,
    }), null);
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false,
        terrainY: -36,
    }), -36, 'negative local terrain remains a valid model-world baseline');
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false,
        railY: -8,
        roadY: -10,
        terrainY: -12,
    }), -8, 'visible engineered support keeps model-world precedence');
});

test('a deck overhead is passed under, never climbed onto', () => {
    // Walker at street level beneath a +6.5 m overpass deck: the deck must not
    // become the baseline (that is what bumped walkers up onto overpasses).
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false, walkerY: 0, roadY: 6.5, terrainY: 0.2,
    }), 0.2);
    // Same under a rail bridge: its deck yields to the road at walker level.
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false, walkerY: 0, railY: 7.4, roadY: 0.1, terrainY: 0.2,
    }), 0.1);
    // A depressed underpass carriageway below the walker stays the floor.
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false, walkerY: -3, roadY: -5.5, terrainY: 0.2,
    }), -5.5);
    // Terrain overhead is NOT filtered: seam recovery depends on seeing it.
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false, walkerY: -9, terrainY: 0,
    }), 0);
    // Without a walker height nothing is judged overhead (spawn-time probes).
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false, railY: 6.5, terrainY: 0.2,
    }), 6.5);
});

test('an unavailable photo stream restores the abstract fallback support', () => {
    // cab.js passes photoWorld=true only while getPhotorealGroundGroup() is
    // active. If Google fails, the revealed fallback world keeps its baseline.
    assert.equal(selectWalkBaselineSupportY({ photoWorld: false }), 0);
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false,
        requireEvidence: true,
    }), null);
    assert.equal(selectWalkBaselineSupportY({
        photoWorld: false,
        terrainY: -14,
    }), -14);
});

test('a terrain-ray miss never restores the cab handoff height as an invisible floor', () => {
    // Scene y=0 is about 26 m a.s.l. in the reported Split session. Google
    // ground below it is a perfectly valid negative scene height.
    const state = createWalkState(43.5, 16.4, {
        initialY: 0,
        initialGroundY: 0,
    });
    const local = () => ({ x: 0, z: 0 });

    const first = stepWalk(state, 0.1, 0, () => -6, local);
    assert.ok(first.y < 0, 'the walker starts descending to the sampled Google ground');
    assert.equal(first.supportReady, true);
    assert.equal(state.initialGroundY, null, 'a real local sample retires the spawn fallback');

    const missed = stepWalk(state, 0.1, 0, () => null, local);
    assert.equal(missed.supportReady, false);
    assert.ok(missed.y < first.y, 'a later ray miss continues the fall');
    assert.notEqual(missed.y, 0, 'the stale scene-zero handoff is not reinstated');
});

test('invalid support does not block descent and a later local negative support catches the walker', () => {
    const state = createWalkState(43.5, 16.4, {
        initialY: 3,
        initialGroundY: 0,
    });
    const local = () => ({ x: 0, z: 0 });

    stepWalk(state, 0.1, 0, () => -8, local);
    let invalidPose = null;
    for (let index = 0; index < 12; index++) {
        invalidPose = stepWalk(state, 0.1, 0, () => Number.NaN, local);
        const pose = invalidPose;
        assert.ok(pose.y < 3, 'invalid support cannot clamp to the old handoff plane');
    }
    assert.ok(invalidPose.y < 0, 'negative scene Y remains reachable through an invalid sample');

    let pose = null;
    for (let index = 0; index < 30; index++) {
        pose = stepWalk(state, 0.05, 0, () => -8, local);
    }
    assert.equal(pose.y, -8);
    assert.equal(pose.airborne, false);
});

test('spawn support is local and is discarded after walking away before terrain resolves', () => {
    clearWalkKeys();
    onKeyDown('w');
    try {
        const state = createWalkState(43.5, 16.4, {
            initialY: 0,
            initialGroundY: 0,
        });
        const pose = stepWalk(
            state,
            0.1,
            0,
            () => null,
            () => ({ x: 0, z: 0 }),
        );
        assert.ok(pose.horizontalDistM > 0.75);
        assert.equal(state.initialGroundY, null);
        assert.ok(pose.y < 0, 'the spawn support does not travel as an invisible floor');
    } finally {
        clearWalkKeys();
    }
});

test('speed booster triples horizontal walk distance', () => {
    clearWalkKeys();
    onKeyDown('w');
    try {
        setWalkSpeedBoost(false);
        const normal = stepWalk(createWalkState(43.5, 16.4, { initialY: 0 }), 0.1, 0);

        setWalkSpeedBoost(true);
        const boosted = stepWalk(createWalkState(43.5, 16.4, { initialY: 0 }), 0.1, 0);

        assert.ok(normal.horizontalDistM > 0);
        assert.ok(Math.abs(boosted.horizontalDistM - normal.horizontalDistM * 3) < 0.001);
    } finally {
        setWalkSpeedBoost(false);
        clearWalkKeys();
    }
});

test('an enclosed campaign walk ignores jetpack input', () => {
    clearWalkKeys();
    onKeyDown(' ');
    try {
        const state = createWalkState(45.8, 15.98, {
            initialY: 80,
            initialGroundY: 80,
            jetpackAllowed: false,
        });
        const pose = stepWalk(
            state,
            0.5,
            0,
            () => 80,
            () => ({ x: 0, z: 0 }),
        );
        assert.equal(state.jetpackAllowed, false);
        assert.equal(pose.jetpackHeld, false);
        assert.equal(pose.y, 80);
        assert.equal(state.vy, 0);
    } finally {
        clearWalkKeys();
    }
});

test('a spawn hint outlives a floor that has not been built yet', async () => {
    const { acceptsDetectedGroundAtSpawn, WALK_SPAWN_HINT_TOLERANCE_M } =
        await import('../modes/walk.js');

    // Vidi drops the walker on an underground platform at -9.93. World layers
    // stream in, so the first steps can sample before the station's floor
    // exists — and the model world's fallback baseline is the street at 0.
    // Believing that lifted the walker out and cleared the hint, so the real
    // floor arriving later changed nothing.
    assert.equal(acceptsDetectedGroundAtSpawn(0, -9.93), false, 'street ≠ station floor');

    // The real floor, when it arrives, is believed.
    assert.equal(acceptsDetectedGroundAtSpawn(-9.93, -9.93), true);
    assert.equal(acceptsDetectedGroundAtSpawn(-9.98, -9.93), true, 'slightly below');
    // So is a step-height difference — a walker spawned on a platform edge may
    // legitimately find the platform top just above the hint.
    assert.equal(
        acceptsDetectedGroundAtSpawn(-9.93 + WALK_SPAWN_HINT_TOLERANCE_M - 0.01, -9.93),
        true,
    );
    assert.equal(
        acceptsDetectedGroundAtSpawn(-9.93 + WALK_SPAWN_HINT_TOLERANCE_M + 0.01, -9.93),
        false,
    );

    // No hint (an ordinary surface walk): every detection is believed, so this
    // cannot change existing behaviour anywhere a spawn height was not given.
    assert.equal(acceptsDetectedGroundAtSpawn(0, null), true);
    assert.equal(acceptsDetectedGroundAtSpawn(123, undefined), true);
    // Nothing detected is still nothing.
    assert.equal(acceptsDetectedGroundAtSpawn(null, -9.93), false);
    assert.equal(acceptsDetectedGroundAtSpawn(NaN, -9.93), false);
});

test('the mapped sea supports a walker on its surface however they arrived', () => {
    assert.equal(seaSurfaceSupportY(null, -1), -1, 'no floor under the basin: the surface');
    assert.equal(seaSurfaceSupportY(-5.5, -1), -1, 'a sea-floor sample below the surface: the surface');
    assert.equal(seaSurfaceSupportY(0.7, -1), 0.7, 'a quay deck above the water keeps winning');
    assert.equal(seaSurfaceSupportY(-5.5, null), -5.5, 'no sea level yet: the sample stands');
    assert.equal(seaSurfaceSupportY(null, null), null);
});

test('a jump into the mapped sea ends on the water, not on the 6 m floor guard under it', (t) => {
    t.after(clearWalkKeys);
    const localXZ = (lat, lon) => ({ x: lon, z: -lat });
    const quayY = 0.5, seaY = -1;
    // Mid-air over the basin after hopping off the Riva: the quay was the last support.
    const jumper = () => Object.assign(createWalkState(43.5, 16.44, { initialY: 3 }),
        { initialGroundY: null, lastDetectedGroundY: quayY, airborne: true, vy: 0 });
    const fall = (ws, getGroundY) => {
        for (let i = 0; i < 60 * 6; i++) stepWalk(ws, 1 / 60, 0, getGroundY, localXZ, null);
        return ws;
    };
    // The basin has no floor sample of its own: without the sea, the walker
    // parks 6 m under the last support — 5.5 m below the water (16 Sep).
    const guarded = fall(jumper(), () => null);
    assert.ok(Math.abs(guarded.y - (quayY - 6)) < 1e-9, `floor guard, y=${guarded.y}`);
    assert.equal(guarded.floorGuardActive, true);
    const afloat = fall(jumper(), () => seaSurfaceSupportY(null, seaY));
    assert.ok(Math.abs(afloat.y - seaY) < 1e-9, `on the surface, y=${afloat.y}`);
    assert.equal(afloat.airborne, false);
    assert.equal(afloat.floorGuardActive, false);
});
