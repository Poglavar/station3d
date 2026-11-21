// Platform windows publish canonical surface claims and exact entrance holes
// as one generation, including dynamically lengthened deep-station stairs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PLATFORM_SURFACE_PUBLICATION_KEY,
    platformOpeningClaimInput,
    platformSurfaceClaimInput,
    platformSurfacePublicationCommitted,
} from '../core/platform-surface-publication.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    compileSurfaceRenderContract,
} from '../core/surface-hierarchy.js';
import {
    UNDERGROUND_ENTRANCE_CUT_WIDTH_M,
    UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M,
    UNDERGROUND_STAIR_WELL_START_ALONG_M,
    UNDERGROUND_STREET_LANDING_DEPTH_M,
    undergroundStationEntranceCutout,
} from '../world/planner-station-layout.js';
import {
    applyAuthoredSurfaceOpeningCutout,
    clearAuthoredSurfaceOpeningCuts,
    clearPlannerEntranceCuts,
    clearPlannerSurfaceCutoutMask,
    getPublishedAuthoredSurfaceOpeningCuts,
    getPlannerEntranceCutState,
    getPublishedPlannerEntranceCuts,
    setAuthoredSurfaceOpeningCuts,
    applyPlannerSurfaceCutout,
    setPlannerEntranceCuts,
    PLANNER_ENTRANCE_CUT_MAX,
    AUTHORED_SURFACE_OPENING_MAX,
} from '../world/planner-surface-cutout.js';
import * as THREE from 'three';

test('ordinary station paint is the only same-level platform claimant', () => {
    const claim = compileSurfaceClaim(platformSurfaceClaimInput({
        name: 'StationPlatformMarking',
        stationLevel: 0,
        stopId: 'stop-7',
    }, 4));
    assert.equal(claim.surfaceClass, SURFACE_CLASS.SIDEWALK);
    assert.equal(claim.verticalRelation, SURFACE_VERTICAL_RELATION.SAME_LEVEL);
    assert.equal(claim.verticalBand, 'ground');
    assert.equal(claim.capabilities.support, false);
    assert.equal(claim.capabilities.backstopCut, false);
    assert.equal(claim.replacementKey, PLATFORM_SURFACE_PUBLICATION_KEY);
    assert.equal(claim.generation, 4);
    assert.equal(claim.featureId, 'stop-7');
});

test('platform solids preserve stacked levels while publishing walk support', () => {
    for (const [stationLevel, surfaceCutStation, expectedBand] of [
        [1, false, 'elevated'],
        [-1, false, 'subsurface'],
        [0, true, 'open-cut'],
    ]) {
        const claim = compileSurfaceClaim(platformSurfaceClaimInput({
            name: 'StationPlatformSlab',
            walkableSurface: true,
            stationLevel,
            surfaceCutStation,
        }, 9));
        assert.equal(claim.surfaceClass, SURFACE_CLASS.STRUCTURE);
        assert.equal(claim.verticalRelation, SURFACE_VERTICAL_RELATION.GRADE_SEPARATED);
        assert.equal(claim.verticalBand, expectedBand);
        assert.equal(claim.capabilities.support, true);
        assert.equal(claim.capabilities.backstopCut, true);
        assert.equal(
            compileSurfaceRenderContract(claim).disabledReason,
            'grade-separated-depth-owned',
        );
    }

    const canopy = compileSurfaceClaim(platformSurfaceClaimInput({
        name: 'StationCanopy',
        stationLevel: 1,
    }, 9));
    assert.equal(canopy.capabilities.support, false);
    assert.equal(canopy.capabilities.backstopCut, false);
});

test('station opening authority shares the visible platform generation', () => {
    const opening = compileSurfaceClaim(platformOpeningClaimInput(13));
    assert.equal(opening.coverageState, SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING);
    assert.equal(opening.verticalRelation, SURFACE_VERTICAL_RELATION.GRADE_SEPARATED);
    assert.equal(opening.replacementKey, PLATFORM_SURFACE_PUBLICATION_KEY);
    assert.equal(opening.generation, 13);
    assert.equal(opening.replacementBackstopReady, true);
    assert.equal(opening.capabilities.color, false);
    assert.equal(opening.capabilities.support, true);
    assert.equal(opening.capabilities.backstopCut, true);

    for (const status of [
        'published',
        'published-with-retirement-error',
        'cleared',
        'cleared-with-retirement-error',
    ]) {
        assert.equal(platformSurfacePublicationCommitted(status), true, status);
    }
    for (const status of ['already-active', 'stale-rejected', 'conflict-rejected', 'failed']) {
        assert.equal(platformSurfacePublicationCommitted(status), false, status);
    }
});

test('planner rail-mask refresh cannot clear a published platform entrance', () => {
    setPlannerEntranceCuts([
        { x1: 1, z1: 2, x2: 3, z2: 4, widthM: 2 },
    ], platformOpeningClaimInput(1));
    clearPlannerSurfaceCutoutMask();
    assert.equal(getPlannerEntranceCutState().count, 1);
    assert.deepEqual(getPublishedPlannerEntranceCuts().map(cut => cut.widthM), [2]);
    assert.equal(Object.isFrozen(getPublishedPlannerEntranceCuts()), true);
    assert.equal(Object.isFrozen(getPublishedPlannerEntranceCuts()[0]), true);
    clearPlannerEntranceCuts();
    assert.deepEqual(getPublishedPlannerEntranceCuts(), []);
});

test('a world landmark opening is bounded in 3D and independent of planner resets', () => {
    setAuthoredSurfaceOpeningCuts([
        { minX: -2, minZ: -1, maxX: 4, maxZ: 1, minY: 8, maxY: 14 },
    ], platformOpeningClaimInput(2));
    assert.deepEqual(getPublishedAuthoredSurfaceOpeningCuts(), [{
        minX: -2,
        minZ: -1,
        maxX: 4,
        maxZ: 1,
        minY: 8,
        maxY: 14,
    }]);
    clearPlannerEntranceCuts();
    clearPlannerSurfaceCutoutMask();
    assert.equal(getPublishedAuthoredSurfaceOpeningCuts().length, 1);
    clearAuthoredSurfaceOpeningCuts(platformOpeningClaimInput(2));
    assert.deepEqual(getPublishedAuthoredSurfaceOpeningCuts(), []);
});

test('authored openings from different owners coexist and clear independently', () => {
    const landmark = { ...platformOpeningClaimInput(3), ownerId: 'landmark:test-opening' };
    const setPiece = { ...platformOpeningClaimInput(3), ownerId: 'campaign-set:test-opening' };
    setAuthoredSurfaceOpeningCuts([{ minX: 0, minZ: 0, maxX: 2, maxZ: 2, minY: 0, maxY: 1 }], landmark);
    setAuthoredSurfaceOpeningCuts([{ minX: 10, minZ: 10, maxX: 12, maxZ: 12, minY: -8, maxY: 2 }], setPiece);
    assert.equal(getPublishedAuthoredSurfaceOpeningCuts().length, 2, 'a second owner must not replace the first');
    setAuthoredSurfaceOpeningCuts([{ minX: 0, minZ: 0, maxX: 3, maxZ: 3, minY: 0, maxY: 1 }], landmark);
    assert.deepEqual(
        getPublishedAuthoredSurfaceOpeningCuts().map(cut => cut.maxX).sort((a, b) => a - b),
        [3, 12],
        'a republication replaces only its own owner',
    );
    clearAuthoredSurfaceOpeningCuts(landmark);
    assert.deepEqual(getPublishedAuthoredSurfaceOpeningCuts().map(cut => cut.minX), [10]);
    clearAuthoredSurfaceOpeningCuts(setPiece);
    assert.deepEqual(getPublishedAuthoredSurfaceOpeningCuts(), []);
    assert.throws(
        () => setAuthoredSurfaceOpeningCuts([], { ...platformOpeningClaimInput(3), ownerId: undefined }),
        /ownerId/,
    );
});

test('malformed or over-capacity entrances preserve the complete published cut set and uniforms', () => {
    const claim = platformOpeningClaimInput(4), cut = { x1: 1, z1: 2, x2: 4, z2: 5, widthM: 2 };
    setPlannerEntranceCuts([cut], claim);
    const published = getPublishedPlannerEntranceCuts(), uniforms = getPlannerEntranceCutState();
    try {
        for (const value of [null, undefined, '0', NaN, Infinity]) {
            assert.throws(() => setPlannerEntranceCuts([cut, { ...cut, x1: value }], claim),
                { code: 'ground-opening-coordinate' });
            assert.equal(getPublishedPlannerEntranceCuts(), published);
            assert.deepEqual(getPlannerEntranceCutState(), uniforms);
        }
        assert.throws(() => setPlannerEntranceCuts(Array(PLANNER_ENTRANCE_CUT_MAX + 1).fill(cut), claim),
            { code: 'ground-opening-capacity' });
        assert.equal(getPublishedPlannerEntranceCuts(), published);
        assert.deepEqual(getPlannerEntranceCutState(), uniforms);
        cut.x1 = 999;
        assert.equal(published[0].x1, 1, 'captured geometry is independent of input mutation');
    } finally { clearPlannerEntranceCuts(); }
});

test('authored opening capacity is shared across owners and never silently drops another owner', () => {
    const a = { ...platformOpeningClaimInput(5), ownerId: 'capacity:a' };
    const b = { ...platformOpeningClaimInput(5), ownerId: 'capacity:b' };
    const box = { minX: 0, minZ: 0, maxX: 2, maxZ: 2, minY: -4, maxY: 1 };
    setAuthoredSurfaceOpeningCuts(Array(AUTHORED_SURFACE_OPENING_MAX - 1).fill(box), a);
    setAuthoredSurfaceOpeningCuts([{ ...box, minX: 3, maxX: 4 }], b);
    const published = getPublishedAuthoredSurfaceOpeningCuts();
    try {
        assert.equal(published.length, AUTHORED_SURFACE_OPENING_MAX);
        assert.throws(() => setAuthoredSurfaceOpeningCuts([box, box], b), { code: 'ground-opening-capacity' });
        assert.equal(getPublishedAuthoredSurfaceOpeningCuts(), published);
        for (const invalid of [{ ...box, minY: null }, { ...box, maxX: '4' }, { ...box, maxY: box.minY }]) {
            assert.throws(() => setAuthoredSurfaceOpeningCuts([invalid], b), { code: 'ground-opening-coordinate' });
            assert.equal(getPublishedAuthoredSurfaceOpeningCuts(), published);
        }
        setAuthoredSurfaceOpeningCuts([{ ...box, minX: 5, maxX: 6 }], b);
        assert.equal(getPublishedAuthoredSurfaceOpeningCuts().length, AUTHORED_SURFACE_OPENING_MAX);
        assert.equal(getPublishedAuthoredSurfaceOpeningCuts().at(-1).minX, 5);
    } finally { clearAuthoredSurfaceOpeningCuts(a); clearAuthoredSurfaceOpeningCuts(b); }
});

test('authored openings can clip generic civil structures without planner masks', () => {
    const material = applyAuthoredSurfaceOpeningCutout(new THREE.MeshStandardMaterial());
    const shader = {
        uniforms: {},
        vertexShader: '#include <common>\n#include <displacementmap_vertex>',
        fragmentShader: '#include <common>\n#include <clipping_planes_fragment>',
    };
    material.onBeforeCompile(shader, {});
    assert.match(shader.vertexShader, /vAuthoredSurfaceOpeningWorldPos/);
    assert.match(shader.fragmentShader, /uAuthoredSurfaceOpeningBounds/);
    assert.match(shader.fragmentShader, /uRenderOriginXZ/);
    assert.doesNotMatch(shader.fragmentShader, /uPlannerSurfaceCutoutMask/);
    assert.equal(material.userData.authoredSurfaceOpeningCutout, true);
    assert.match(material.customProgramCacheKey(), /authored-surface-opening-v1/);
    material.dispose();
});

test('a grade-separated surface skips planner masks but still yields to landmarks', () => {
    const claim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        ownerId: 'generic-tunnel',
        sourceId: 'test',
        supportReady: true,
    });
    const material = applyPlannerSurfaceCutout(new THREE.MeshStandardMaterial(), claim);
    assert.equal(material.userData.plannerSurfaceCutoutMode, 'none');
    assert.equal(material.userData.plannerSurfaceCutout, undefined);
    assert.equal(material.userData.authoredSurfaceOpeningCutout, true);
    const shader = {
        uniforms: {},
        vertexShader: '#include <common>\n#include <displacementmap_vertex>',
        fragmentShader: '#include <common>\n#include <clipping_planes_fragment>',
    };
    material.onBeforeCompile(shader, {});
    assert.match(shader.fragmentShader, /uAuthoredSurfaceOpeningBounds/);
    assert.doesNotMatch(shader.fragmentShader, /uPlannerSurfaceCutoutMask/);
    material.dispose();
});

test('an underground opening follows the actual dynamic stair top', () => {
    const cut = undergroundStationEntranceCutout({
        stopId: 'deep-stop',
        centerX: 100,
        centerZ: 200,
        angleY: 0,
        direction: 1,
        topAlongM: 44,
    });
    const radiusM = UNDERGROUND_ENTRANCE_CUT_WIDTH_M * 0.5;
    assert.equal(cut.stopId, 'deep-stop');
    assert.equal(cut.stationEntranceKind, 'underground-stairs');
    assert.equal(cut.widthM, UNDERGROUND_ENTRANCE_CUT_WIDTH_M);
    // At angle zero, forward is +Z and right is -X.
    assert.ok(Math.abs(
        cut.x1 - (100 - UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M)
    ) < 1e-9);
    assert.ok(Math.abs(cut.x2 - cut.x1) < 1e-9);
    assert.ok(Math.abs(
        cut.z1 - (200 + UNDERGROUND_STAIR_WELL_START_ALONG_M + radiusM)
    ) < 1e-9);
    assert.ok(Math.abs(
        cut.z2 - (200 + 44 + UNDERGROUND_STREET_LANDING_DEPTH_M * 0.5 - radiusM)
    ) < 1e-9);

    const mirrored = undergroundStationEntranceCutout({
        centerX: 100,
        centerZ: 200,
        angleY: 0,
        direction: -1,
        topAlongM: -44,
    });
    assert.ok(Math.abs(
        mirrored.x1 - (100 + UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M)
    ) < 1e-9);
    assert.ok(mirrored.z2 < mirrored.z1);
    assert.equal(undergroundStationEntranceCutout({ direction: 0 }), null);
});

test('the live platform build owns both dynamic entrance geometry and its cut', () => {
    const platforms = readFileSync(new URL('../world/platforms.js', import.meta.url), 'utf8');
    const planner = readFileSync(new URL('../world/planner-elevation.js', import.meta.url), 'utf8');
    const undergroundAccess = platforms.slice(
        platforms.indexOf('function* addUndergroundIslandAccess'),
        platforms.indexOf('function addFlightRailings'),
    );
    assert.match(undergroundAccess, /undergroundStationEntranceCutout\(\{/);
    assert.match(undergroundAccess, /topAlongM: topAlong/);
    assert.match(undergroundAccess, /return \{ entranceTopAlongByDirection \}/);
    assert.match(platforms, /undergroundAccess\?\.entranceTopAlongByDirection/);
    assert.doesNotMatch(
        planner,
        /undergroundStationEntranceCutout|plannerSurfaceCutStationEntranceCutout|setPlannerEntranceCuts/,
        'planner elevation must not recreate a station opening independently');
});
