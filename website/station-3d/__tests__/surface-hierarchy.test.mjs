// One semantic contract for render order, civil composition and safe streaming
// replacement. This stays pure so every world mode can consume it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    CIVIL_GROUND_AUTHORITY_ORDER,
    GROUND_REMOVAL_CHANNELS,
    GROUND_STENCIL_READER_RENDER_ORDER,
    ROAD_STENCIL_RENDER_ORDER,
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLICIES,
    SURFACE_PLANNER_CUTOUT_MODE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_CONTRACTS,
    SURFACE_RENDER_ORDER,
    SURFACE_STENCIL_MODE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    compileSurfaceRenderContract,
    resolveSurfaceClaimDecisions,
    resolveSurfaceOverlap,
    surfaceClaimMayCutBackstop,
    surfaceClaimMayPaintOver,
    surfaceClaimMayProvideSupport,
    surfaceClaimsVerticalRelation,
    surfaceGroundRemovalChannelsForClaim,
    surfaceMaySuppress,
    surfacePolicy,
    surfaceStencilContract,
} from '../core/surface-hierarchy.js';

function publishedSameLevel(...surfaceClasses) {
    return {
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        coverageStateByClass: Object.fromEntries(surfaceClasses.map(surfaceClass => (
            [surfaceClass, SURFACE_COVERAGE_STATE.PUBLISHED]
        ))),
    };
}

test('every declared surface class has exactly one canonical semantic and render policy', () => {
    assert.deepEqual(
        new Set(Object.keys(SURFACE_POLICIES)),
        new Set(Object.values(SURFACE_CLASS)),
    );
    assert.deepEqual(
        new Set(Object.keys(SURFACE_RENDER_CONTRACTS)),
        new Set(Object.values(SURFACE_CLASS)),
    );
    for (const surfaceClass of Object.values(SURFACE_CLASS)) {
        assert.equal(surfacePolicy(surfaceClass), SURFACE_POLICIES[surfaceClass]);
        assert.equal(
            SURFACE_RENDER_CONTRACTS[surfaceClass]?.stencilMode != null,
            true,
            surfaceClass,
        );
    }
});

test('claims compile canonical draw order and polygon bias, including the rail prepass', () => {
    const road = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    });
    assert.equal(road.technical.renderOrder, SURFACE_RENDER_ORDER.ROAD);
    assert.equal(road.technical.polygonOffset, SURFACE_POLYGON_OFFSET.ROAD);

    const prepass = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        paintsColor: false,
        cutsBackstop: true,
    });
    assert.equal(prepass.technical.renderOrder, SURFACE_RENDER_ORDER.RAIL_SAME_LEVEL_PREPASS);
    assert.equal(prepass.technical.polygonOffset, null);

    const crossingApron = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.LEVEL_CROSSING_APRON,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    });
    assert.equal(
        crossingApron.technical.renderOrder,
        SURFACE_RENDER_ORDER.LEVEL_CROSSING_APRON,
    );
    assert.equal(
        crossingApron.technical.polygonOffset,
        SURFACE_POLYGON_OFFSET.LEVEL_CROSSING_APRON,
    );

    const crossingDressing = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    });
    assert.equal(
        crossingDressing.technical.polygonOffset,
        SURFACE_POLYGON_OFFSET.ROAD_MARKING,
    );

    const curbRamp = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.CURB_RAMP,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    });
    assert.equal(curbRamp.technical.renderOrder, SURFACE_RENDER_ORDER.CURB_RAMP);
});

test('the render compiler grants destructive behavior only to published same-level claims', () => {
    const publishedRoad = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        supportReady: true,
        cutsBackstop: true,
    });
    const roadRender = compileSurfaceRenderContract(publishedRoad);
    assert.equal(roadRender.stencilMode, SURFACE_STENCIL_MODE.ROAD_CARRIAGEWAY_WRITER);
    assert.equal(surfaceStencilContract(publishedRoad).enabled, true);
    assert.deepEqual(
        surfaceGroundRemovalChannelsForClaim(publishedRoad),
        GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
    );
    assert.equal(roadRender.plannerCutoutMode, SURFACE_PLANNER_CUTOUT_MODE.ALL);

    for (const overrides of [
        { coverageState: SURFACE_COVERAGE_STATE.BUILDING },
        { verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN },
        { verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED },
    ]) {
        const rejected = compileSurfaceRenderContract(compileSurfaceClaim({
            ...publishedRoad,
            supportReady: true,
            cutsBackstop: true,
            ...overrides,
        }));
        assert.equal(rejected.stencilMode, SURFACE_STENCIL_MODE.NONE);
        assert.deepEqual(rejected.groundRemovalChannels, GROUND_REMOVAL_CHANNELS.NONE);
        assert.equal(rejected.plannerCutoutMode, SURFACE_PLANNER_CUTOUT_MODE.NONE);
        assert.ok(rejected.disabledReason);
    }
});

test('a non-colour water cutout cannot open terrain without its water backstop', () => {
    const input = {
        surfaceClass: SURFACE_CLASS.WATER_CUTOUT,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        paintsColor: false,
        cutsBackstop: true,
    };
    const unsafe = compileSurfaceRenderContract(compileSurfaceClaim(input));
    assert.equal(unsafe.stencilMode, SURFACE_STENCIL_MODE.NONE);
    assert.equal(unsafe.disabledReason, 'replacement-backstop-not-ready');

    const safe = compileSurfaceRenderContract(compileSurfaceClaim({
        ...input,
        replacementBackstopReady: true,
    }));
    assert.equal(safe.stencilMode, SURFACE_STENCIL_MODE.WATER_GROUND_CUTOUT_WRITER);
});

test('terrain is the immutable visible fallback and always beats void', () => {
    assert.equal(
        resolveSurfaceOverlap(SURFACE_CLASS.TERRAIN, SURFACE_CLASS.VOID).winner,
        SURFACE_CLASS.TERRAIN,
    );
    assert.equal(
        surfaceMaySuppress(SURFACE_CLASS.VOID, SURFACE_CLASS.TERRAIN),
        false,
    );
});

test('planned or partially built geometry cannot erase a lower visible surface', () => {
    for (const coverageState of [
        SURFACE_COVERAGE_STATE.PLANNED,
        SURFACE_COVERAGE_STATE.BUILDING,
        SURFACE_COVERAGE_STATE.RETIRING,
    ]) {
        assert.equal(surfaceMaySuppress(
            SURFACE_CLASS.RAIL_TRACKBED,
            SURFACE_CLASS.TERRAIN,
            {
                coverageState,
                verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            },
        ), false, coverageState);
        assert.equal(surfaceMaySuppress(
            SURFACE_CLASS.RAIL_TRACKBED,
            SURFACE_CLASS.ROAD_CARRIAGEWAY,
            {
                coverageState,
                verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            },
        ), false, coverageState);
    }
    assert.equal(surfaceMaySuppress(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.TERRAIN,
        {
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        },
    ), true);
});

test('missing coverage or vertical evidence fails closed', () => {
    assert.equal(surfaceMaySuppress(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.TERRAIN,
    ), false);
    assert.equal(surfaceMaySuppress(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.TERRAIN,
        { coverageState: SURFACE_COVERAGE_STATE.PUBLISHED },
    ), false);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.TERRAIN,
    ).mode, 'preserve-both');
});

test('intentional openings require a published structural/interior backstop', () => {
    assert.equal(surfaceMaySuppress(
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        SURFACE_CLASS.TERRAIN,
        {
            coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        },
    ), false);
    assert.equal(surfaceMaySuppress(
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        SURFACE_CLASS.TERRAIN,
        {
            coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            replacementBackstopReady: true,
        },
    ), true);
});

test('same-level transport order is explicit, including the sidewalk-buffer exception', () => {
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.BUFFERED_SIDEWALK,
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        publishedSameLevel(
            SURFACE_CLASS.BUFFERED_SIDEWALK,
            SURFACE_CLASS.ROAD_CARRIAGEWAY,
        ),
    ).winner, SURFACE_CLASS.ROAD_CARRIAGEWAY);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.SIDEWALK,
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        publishedSameLevel(SURFACE_CLASS.SIDEWALK, SURFACE_CLASS.ROAD_CARRIAGEWAY),
    ).winner, SURFACE_CLASS.SIDEWALK);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.SIDEWALK,
        publishedSameLevel(SURFACE_CLASS.RAIL_TRACKBED, SURFACE_CLASS.SIDEWALK),
    ).winner, SURFACE_CLASS.RAIL_TRACKBED);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        publishedSameLevel(
            SURFACE_CLASS.RAIL_TRACKBED,
            SURFACE_CLASS.ROAD_CARRIAGEWAY,
        ),
    ).winner, SURFACE_CLASS.RAIL_TRACKBED);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.ROAD_MARKING,
        SURFACE_CLASS.RAIL_TRACKBED,
        publishedSameLevel(SURFACE_CLASS.ROAD_MARKING, SURFACE_CLASS.RAIL_TRACKBED),
    ).winner, SURFACE_CLASS.RAIL_TRACKBED);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.LEVEL_CROSSING_APRON,
        SURFACE_CLASS.RAIL_TRACKBED,
        publishedSameLevel(
            SURFACE_CLASS.LEVEL_CROSSING_APRON,
            SURFACE_CLASS.RAIL_TRACKBED,
        ),
    ).winner, SURFACE_CLASS.RAIL_TRACKBED);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
        SURFACE_CLASS.RAIL_TRACKBED,
        publishedSameLevel(
            SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
            SURFACE_CLASS.RAIL_TRACKBED,
        ),
    ).winner, SURFACE_CLASS.LEVEL_CROSSING_DRESSING);
    assert.equal(resolveSurfaceOverlap(
        SURFACE_CLASS.RAIL_STEEL,
        SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
        publishedSameLevel(
            SURFACE_CLASS.RAIL_STEEL,
            SURFACE_CLASS.LEVEL_CROSSING_DRESSING,
        ),
    ).winner, SURFACE_CLASS.RAIL_STEEL);
});

test('compiled claims keep colour, support, and backstop removal independent', () => {
    const terrain = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
        supportReady: true,
    });
    const road = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
        supportReady: true,
        cutsBackstop: true,
    });
    const marking = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_MARKING,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
        supportReady: true,
        cutsBackstop: true,
    });

    assert.equal(surfaceClaimMayPaintOver(marking, road), true);
    assert.equal(surfaceClaimMayProvideSupport(marking), false);
    assert.equal(surfaceClaimMayCutBackstop(marking, terrain), false);
    assert.equal(surfaceClaimMayProvideSupport(road), true);
    assert.equal(surfaceClaimMayCutBackstop(road, terrain), true);

    const decisions = resolveSurfaceClaimDecisions(marking, road);
    assert.equal(decisions.color.winner.surfaceClass, SURFACE_CLASS.ROAD_MARKING);
    assert.deepEqual(
        decisions.support.map(claim => claim.surfaceClass),
        [SURFACE_CLASS.ROAD_CARRIAGEWAY],
    );
    assert.equal(decisions.backstopCut.firstCutsSecond, false);
});

test('compiled claims require explicit publication and capability readiness', () => {
    const defaultRail = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.RAIL_TRACKBED });
    assert.equal(defaultRail.coverageState, SURFACE_COVERAGE_STATE.PLANNED);
    assert.equal(defaultRail.verticalRelation, SURFACE_VERTICAL_RELATION.UNKNOWN);
    assert.equal(surfaceClaimMayProvideSupport(defaultRail), false);
    assert.equal(surfaceClaimMayCutBackstop(defaultRail, {
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    }), false);

    const publishedUnknownBand = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        supportReady: true,
    });
    assert.equal(surfaceClaimMayProvideSupport(publishedUnknownBand), true);
    assert.equal(surfaceClaimMayProvideSupport(
        publishedUnknownBand,
        { verticalBand: 'ground' },
    ), false);

    assert.throws(
        () => compileSurfaceClaim({ surfaceClass: 'invented-layer' }),
        /Unknown surface class/,
    );
    assert.throws(
        () => compileSurfaceClaim({
            surfaceClass: SURFACE_CLASS.TERRAIN,
            coverageState: 'probably-ready',
        }),
        /Unknown surface coverage state/,
    );
});

test('known vertical bands compare; unknown and grade-separated claims are preserved', () => {
    const road = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
    });
    const groundRail = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
    });
    const bridgeRail = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'bridge:rail-1',
    });
    const unknownRail = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_TRACKBED,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });

    assert.equal(
        surfaceClaimsVerticalRelation(groundRail, road),
        SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    );
    assert.equal(surfaceClaimMayPaintOver(groundRail, road), true);
    assert.equal(
        surfaceClaimsVerticalRelation(bridgeRail, road),
        SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
    );
    assert.equal(surfaceClaimMayPaintOver(bridgeRail, road), false);
    assert.equal(
        surfaceClaimsVerticalRelation(unknownRail, road),
        SURFACE_VERTICAL_RELATION.UNKNOWN,
    );
    assert.equal(surfaceClaimMayPaintOver(unknownRail, road), false);
});

test('intentional backstop cuts require their replacement support to be ready', () => {
    const terrain = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalBand: 'ground',
        supportReady: true,
    });
    const opening = {
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
        // Openings deliberately connect levels; replacement publication, not
        // a false same-level claim, is what makes the terrain cut safe.
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        cutsBackstop: true,
    };
    assert.equal(surfaceClaimMayCutBackstop(opening, terrain), false);
    assert.equal(surfaceClaimMayCutBackstop({
        ...opening,
        replacementBackstopReady: true,
    }, terrain), true);
});

test('grade-separated surfaces preserve both and leave visibility to geometry/depth', () => {
    const result = resolveSurfaceOverlap(
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        { verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED },
    );
    assert.equal(result.mode, 'preserve-both');
    assert.deepEqual(result.preserved, [
        SURFACE_CLASS.RAIL_TRACKBED,
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
    ]);
});

test('civil dependency order and final visible order remain distinct contracts', () => {
    assert.deepEqual(CIVIL_GROUND_AUTHORITY_ORDER, [
        'terrain', 'rail', 'road', 'sidewalk', 'path', 'building',
    ]);
    assert.ok(
        surfacePolicy(SURFACE_CLASS.RAIL_TRACKBED).rank
            > surfacePolicy(SURFACE_CLASS.ROAD_CARRIAGEWAY).rank,
        'road consumes rail civil height, while published trackbed wins the final surface',
    );
    assert.equal(ROAD_STENCIL_RENDER_ORDER, SURFACE_RENDER_ORDER.ROAD);
    assert.equal(
        GROUND_STENCIL_READER_RENDER_ORDER,
        SURFACE_RENDER_ORDER.TERRAIN_BACKSTOP,
    );
});

test('render layers compile policy from the canonical module', async () => {
    const [levelsSource, civilSource, terrainSource, railsSource, roadsSource,
        curbsSource, decorSource, markingsSource, crossingsSource,
        structuresSource, waterSource, buildingsSource, setupSource,
        packetAdapterSource] = await Promise.all([
        readFile(new URL('../world/ground-surface-levels.js', import.meta.url), 'utf8'),
        readFile(new URL('../core/civil-ground-composition.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/rails.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/roads.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/curbs.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/decor.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/lane-markings.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/level-crossings.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/road-grade-separations.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/water.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/buildings.js', import.meta.url), 'utf8'),
        readFile(new URL('../scene/setup.js', import.meta.url), 'utf8'),
        readFile(new URL('../core/render-packet-three.js', import.meta.url), 'utf8'),
    ]);
    assert.match(levelsSource, /from '\.\.\/core\/surface-hierarchy\.js'/);
    assert.match(civilSource, /from '\.\/surface-hierarchy\.js'/);
    assert.match(terrainSource, /surfaceGroundOwnershipMaskFill/);
    assert.match(terrainSource, /surfaceGroundRemovalChannelsForClaim/);
    assert.match(railsSource, /SURFACE_COVERAGE_STATE\.PUBLISHED/);
    for (const source of [railsSource, roadsSource, curbsSource, decorSource,
        markingsSource, crossingsSource]) {
        assert.match(source, /surface-hierarchy\.js/);
        assert.doesNotMatch(source, /ROAD_STENCIL_RENDER_ORDER\s*\+/);
        assert.doesNotMatch(source, /TRACKBED_RENDER_ORDER\s*-/);
    }
    for (const source of [railsSource, roadsSource, decorSource,
        markingsSource, crossingsSource, structuresSource, waterSource,
        buildingsSource, setupSource]) {
        assert.match(source, /markSurfaceClaim/);
    }
    assert.match(packetAdapterSource, /markSurfaceClaim/,
        'Worker terrain packets receive their canonical claim at the main-thread landing boundary');
});

test('rail stencil, formation and structural terrain-cutout consumers remain separate', async () => {
    const [railsSource, terrainSource] = await Promise.all([
        readFile(new URL('../world/rails.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
    ]);
    // Atomic cell/coverage/physics promotion is exercised behaviorally by
    // gta-ground-publication.test.mjs using the actual production generator.
    assert.match(railsSource, /SURFACE_RENDER_ORDER\.RAIL_SAME_LEVEL_PREPASS/);
    const activeRenderMaskModels = terrainSource.slice(
        terrainSource.indexOf('function activeFormationModels'),
        terrainSource.indexOf('function groundOwnershipMaskRevision'),
    );
    assert.doesNotMatch(activeRenderMaskModels, /reference\?\.renderedRailSurface/,
        'exact trackbed never masquerades as a broad formation model');
    assert.match(terrainSource, /terrainCutoutRegionsNear/,
        'depth-proven heavy-rail intrusions use a bounded ownership supplement');
    assert.match(terrainSource, /viaductTerrainCutoutRegionsNear/,
        'opaque viaduct slabs use a separate bounded ownership supplement');
});
