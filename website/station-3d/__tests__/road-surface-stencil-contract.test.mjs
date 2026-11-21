// Locks the canonical fragment-level surface authority. Producers declare a
// SurfaceClaim; only surface-hierarchy.js and its THREE adapter may translate
// that identity into stencil bits, ownership channels, or destructive masks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    GROUND_REMOVAL_CHANNELS,
    GROUND_STENCIL_READER_RENDER_ORDER,
    PEDESTRIAN_GROUND_STENCIL_REF,
    WATER_GROUND_CUTOUT_STENCIL_REF,
    RAIL_SAME_LEVEL_STENCIL_REF,
    ROAD_CARRIAGEWAY_STENCIL_REF,
    ROAD_STENCIL_REF,
    ROAD_STENCIL_RENDER_ORDER,
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_PLANNER_CUTOUT_MODE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_ORDER,
    SURFACE_STENCIL_COMPARE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    compileSurfaceRenderContract,
    surfaceGroundRemovalChannelsForClaim,
    surfaceStencilContract,
} from '../core/surface-hierarchy.js';
import {
    applySurfaceDrawContract,
    applySurfaceStencil,
} from '../world/surface-material-authority.js';

function publishedClaim(surfaceClass, options = {}) {
    const verticalRelation = options.verticalRelation
        || SURFACE_VERTICAL_RELATION.SAME_LEVEL;
    return compileSurfaceClaim({
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation,
        verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ? 'ground'
            : null,
        ownerId: `test:${surfaceClass}`,
        paintsColor: options.paintsColor !== false,
        supportReady: options.supportReady === true,
        cutsBackstop: options.cutsBackstop === true,
    });
}

test('surface ownership stencil bits are independent', () => {
    assert.equal(ROAD_STENCIL_REF, 1);
    assert.equal(ROAD_CARRIAGEWAY_STENCIL_REF, 2);
    assert.equal(ROAD_STENCIL_REF & ROAD_CARRIAGEWAY_STENCIL_REF, 0);
    assert.equal(
        (ROAD_STENCIL_REF | ROAD_CARRIAGEWAY_STENCIL_REF)
            & RAIL_SAME_LEVEL_STENCIL_REF,
        0,
    );
    assert.equal(
        (ROAD_STENCIL_REF | RAIL_SAME_LEVEL_STENCIL_REF)
            & PEDESTRIAN_GROUND_STENCIL_REF,
        0,
    );
});

test('published at-grade pedestrian paving owns an exact terrain-backstop bit', () => {
    const claim = publishedClaim(SURFACE_CLASS.SIDEWALK, {
        supportReady: true,
        cutsBackstop: true,
    });
    const stencil = surfaceStencilContract(claim);
    assert.equal(stencil.enabled, true);
    assert.equal(stencil.compare, SURFACE_STENCIL_COMPARE.NOT_EQUAL);
    assert.equal(stencil.writeMask, ROAD_STENCIL_REF | PEDESTRIAN_GROUND_STENCIL_REF);
    assert.equal(stencil.funcMask, RAIL_SAME_LEVEL_STENCIL_REF);

    const bridge = publishedClaim(SURFACE_CLASS.SIDEWALK, {
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        supportReady: true,
        cutsBackstop: true,
    });
    assert.equal(surfaceStencilContract(bridge).enabled, false);
});

test('asphalt owns carriageway while a derived sidewalk yields inside it', () => {
    const asphalt = surfaceStencilContract(publishedClaim(
        SURFACE_CLASS.ROAD_CARRIAGEWAY,
        { supportReady: true, cutsBackstop: true },
    ));
    assert.equal(asphalt.compare, SURFACE_STENCIL_COMPARE.NOT_EQUAL);
    assert.equal(asphalt.funcMask, RAIL_SAME_LEVEL_STENCIL_REF);
    assert.equal(
        asphalt.writeMask,
        ROAD_STENCIL_REF | ROAD_CARRIAGEWAY_STENCIL_REF,
    );

    const bufferedSidewalk = surfaceStencilContract(publishedClaim(
        SURFACE_CLASS.BUFFERED_SIDEWALK,
        { supportReady: true, cutsBackstop: true },
    ));
    assert.equal(bufferedSidewalk.compare, SURFACE_STENCIL_COMPARE.EQUAL);
    assert.equal(
        bufferedSidewalk.funcMask,
        ROAD_CARRIAGEWAY_STENCIL_REF | RAIL_SAME_LEVEL_STENCIL_REF,
    );
    assert.equal(bufferedSidewalk.writeMask, ROAD_STENCIL_REF);
});

test('terrain honors only the depth-independent water cutout, never plan-only paving bits', () => {
    const terrain = publishedClaim(SURFACE_CLASS.TERRAIN, { supportReady: true });
    const stencil = surfaceStencilContract(terrain);
    assert.equal(stencil.enabled, true);
    assert.equal(stencil.compare, SURFACE_STENCIL_COMPARE.EQUAL);
    // Same-level writer bits are plan-only, screen-space facts. Reading them
    // on the real 3D ground let a far-side street stencil a see-through slit
    // into the rail embankment standing in front of it (Branimirova). Terrain
    // yields to at-grade paving by depth/polygon offsets and to genuine civil
    // cuts through the formation ownership mask; the only stencil fact it may
    // honor is the deliberately depth-independent water opening.
    assert.equal(stencil.funcMask, WATER_GROUND_CUTOUT_STENCIL_REF);
    assert.equal(stencil.writeMask, 0);
});

test('the water cutout still reaches the terrain read on its private bit', () => {
    // Water previously shared the generic road bit; moving it to a private bit
    // must not sever the one stencil coupling terrain deliberately keeps: a
    // depth-independent water body opening the ground above it.
    const waterCutout = surfaceStencilContract(compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.WATER_CUTOUT,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'test:water-ground-cutout',
        replacementBackstopReady: true,
        paintsColor: false,
        cutsBackstop: true,
    }));
    const terrain = surfaceStencilContract(
        publishedClaim(SURFACE_CLASS.TERRAIN, { supportReady: true }),
    );
    assert.equal(waterCutout.writeMask, WATER_GROUND_CUTOUT_STENCIL_REF);
    assert.equal(waterCutout.ref, WATER_GROUND_CUTOUT_STENCIL_REF);
    assert.equal(
        terrain.funcMask & waterCutout.writeMask,
        WATER_GROUND_CUTOUT_STENCIL_REF,
        'terrain no longer honors the water ground cutout',
    );
});

test('no same-level paving writer bit can reach the terrain stencil read', () => {
    // The regression lock for the embankment slit: if any at-grade writer's
    // stencil output lands in the terrain read mask again, a street standing
    // BEHIND a hill re-gains the power to erase the hill in screen space.
    const terrain = surfaceStencilContract(
        publishedClaim(SURFACE_CLASS.TERRAIN, { supportReady: true }),
    );
    const writers = [
        [SURFACE_CLASS.ROAD_CARRIAGEWAY, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.SIDEWALK, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.CYCLEWAY, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.TRAM_CORRIDOR, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.PARKING, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.BUFFERED_SIDEWALK, { supportReady: true, cutsBackstop: true }],
        [SURFACE_CLASS.RAIL_TRACKBED, { supportReady: true, cutsBackstop: true }],
    ];
    for (const [surfaceClass, options] of writers) {
        const writer = surfaceStencilContract(publishedClaim(surfaceClass, options));
        assert.equal(
            terrain.funcMask & writer.writeMask,
            0,
            `${surfaceClass} writes into the terrain stencil read mask`,
        );
    }
});

test('parking owns road cover but only yields to a proved rail excavation', () => {
    const parking = publishedClaim(SURFACE_CLASS.PARKING, {
        supportReady: true,
        cutsBackstop: true,
    });
    assert.equal(surfaceStencilContract(parking).writeMask, ROAD_STENCIL_REF);
    assert.deepEqual(
        surfaceGroundRemovalChannelsForClaim(parking),
        GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
    );

    const passive = publishedClaim(SURFACE_CLASS.PASSIVE_LANDUSE);
    assert.equal(
        surfaceStencilContract(passive).funcMask,
        ROAD_STENCIL_REF
            | RAIL_SAME_LEVEL_STENCIL_REF
            | WATER_GROUND_CUTOUT_STENCIL_REF,
    );
    assert.deepEqual(
        surfaceGroundRemovalChannelsForClaim(passive),
        GROUND_REMOVAL_CHANNELS.GENERIC_REPLACEMENT,
    );
});

test('buildings survive ordinary formations but yield to a deep rail excavation', () => {
    const building = publishedClaim(SURFACE_CLASS.BUILDING, {
        verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
    });
    const contract = compileSurfaceRenderContract(building);
    assert.deepEqual(
        contract.groundRemovalChannels,
        GROUND_REMOVAL_CHANNELS.RAIL_FINAL_SURFACE,
    );
    assert.equal(contract.plannerCutoutMode, SURFACE_PLANNER_CUTOUT_MODE.ALL);
    assert.equal(contract.stencilMode, 'none');
});

test('synthetic curb ramps are readers and cannot become new surface owners', () => {
    const ramp = publishedClaim(SURFACE_CLASS.CURB_RAMP);
    const stencil = surfaceStencilContract(ramp);
    assert.equal(stencil.compare, SURFACE_STENCIL_COMPARE.EQUAL);
    assert.equal(stencil.writeMask, 0);
    assert.equal(
        stencil.funcMask,
        ROAD_STENCIL_REF
            | RAIL_SAME_LEVEL_STENCIL_REF
            | PEDESTRIAN_GROUND_STENCIL_REF
            | WATER_GROUND_CUTOUT_STENCIL_REF,
    );
});

test('only an explicit backstop-cut capability may write a winner bit', () => {
    const unsafeRoad = publishedClaim(SURFACE_CLASS.ROAD_CARRIAGEWAY, {
        supportReady: true,
    });
    assert.equal(surfaceStencilContract(unsafeRoad).enabled, false);

    const paintOnlyCycleway = publishedClaim(SURFACE_CLASS.CYCLEWAY, {
        paintsColor: true,
    });
    const stencil = surfaceStencilContract(paintOnlyCycleway);
    assert.equal(stencil.enabled, true);
    assert.equal(stencil.writeMask, 0);
    assert.equal(stencil.funcMask, RAIL_SAME_LEVEL_STENCIL_REF);
});

test('same-level rail prepass and visible trackbed share ownership but not colour output', () => {
    const visible = publishedClaim(SURFACE_CLASS.RAIL_TRACKBED, {
        supportReady: true,
        cutsBackstop: true,
    });
    const prepass = publishedClaim(SURFACE_CLASS.RAIL_TRACKBED, {
        paintsColor: false,
        cutsBackstop: true,
    });
    const visibleStencil = surfaceStencilContract(visible);
    const prepassStencil = surfaceStencilContract(prepass);
    assert.equal(visibleStencil.enabled, true);
    assert.equal(visibleStencil.colorWrite, undefined);
    assert.equal(prepassStencil.colorWrite, false);
    assert.equal(
        prepassStencil.writeMask,
        ROAD_STENCIL_REF | RAIL_SAME_LEVEL_STENCIL_REF,
    );

    const marking = surfaceStencilContract(publishedClaim(SURFACE_CLASS.ROAD_MARKING));
    assert.equal(marking.writeMask, 0);
    assert.equal(marking.funcMask, RAIL_SAME_LEVEL_STENCIL_REF);
});

test('revising a material claim restores colour and depth after a mask prepass', () => {
    const material = {
        userData: {},
        colorWrite: true,
        depthTest: true,
        depthWrite: true,
    };
    const prepass = publishedClaim(SURFACE_CLASS.RAIL_TRACKBED, {
        paintsColor: false,
        cutsBackstop: true,
    });
    applySurfaceStencil(material, prepass);
    assert.equal(material.colorWrite, false);

    const visible = publishedClaim(SURFACE_CLASS.RAIL_TRACKBED, {
        supportReady: true,
        cutsBackstop: true,
    });
    applySurfaceStencil(material, visible);
    assert.equal(material.colorWrite, true);
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, true);
    assert.equal(material.stencilWrite, true);
});

test('the THREE adapter applies draw order and polygon bias from the claim', () => {
    const material = { userData: {} };
    const mesh = { userData: {}, material, renderOrder: 0 };
    const road = publishedClaim(SURFACE_CLASS.ROAD_CARRIAGEWAY, {
        supportReady: true,
        cutsBackstop: true,
    });

    applySurfaceDrawContract(mesh, road);

    assert.equal(mesh.renderOrder, SURFACE_RENDER_ORDER.ROAD);
    assert.equal(material.polygonOffset, true);
    assert.equal(material.polygonOffsetFactor, SURFACE_POLYGON_OFFSET.ROAD.factor);
    assert.equal(material.polygonOffsetUnits, SURFACE_POLYGON_OFFSET.ROAD.units);
    assert.equal(material.userData.surfaceDrawContract, road.technical);
});

test('unknown or grade-separated surfaces fail closed on every coarse destructive path', () => {
    for (const verticalRelation of [
        SURFACE_VERTICAL_RELATION.UNKNOWN,
        SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
    ]) {
        const claim = publishedClaim(SURFACE_CLASS.ROAD_CARRIAGEWAY, {
            verticalRelation,
            supportReady: true,
            cutsBackstop: true,
        });
        const contract = compileSurfaceRenderContract(claim);
        assert.equal(surfaceStencilContract(claim).enabled, false, verticalRelation);
        assert.deepEqual(contract.groundRemovalChannels, GROUND_REMOVAL_CHANNELS.NONE);
        assert.equal(contract.plannerCutoutMode, SURFACE_PLANNER_CUTOUT_MODE.NONE);
    }
});

test('surface producers contain no private stencil programs', async () => {
    const producerUrls = [
        '../scene/setup.js',
        '../world/terrain.js',
        '../world/roads.js',
        '../world/rails.js',
        '../world/decor.js',
        '../world/curbs.js',
        '../world/lane-markings.js',
        '../world/buildings.js',
        '../world/water.js',
        '../world/water-material.js',
        '../world/road-grade-separations.js',
        '../world/proposals.js',
    ];
    const sources = await Promise.all(producerUrls.map(url => (
        readFile(new URL(url, import.meta.url), 'utf8')
    )));
    for (const [index, source] of sources.entries()) {
        assert.match(source, /applySurfaceStencil/, producerUrls[index]);
        assert.doesNotMatch(
            source,
            /\bstencil(?:Write|Ref|Func|FuncMask|WriteMask|Fail|ZFail|ZPass)\s*:/,
            producerUrls[index],
        );
    }
    const adapter = await readFile(
        new URL('../world/surface-material-authority.js', import.meta.url),
        'utf8',
    );
    assert.match(adapter, /material\.stencilWrite = stencil\.enabled/);
    assert.match(adapter, /surfaceStencilContract/);
});

test('asphalt retains a non-glowing albedo floor in deep structure shadows', async () => {
    const source = await readFile(new URL('../world/roads.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function getAsphaltMaterial');
    const asphalt = start >= 0 ? source.slice(start, start + 1_600) : '';
    assert.match(asphalt, /emissive:\s*0x151719/);
    assert.match(asphalt, /emissiveIntensity:\s*0\.32/);
});

test('DGU terrain closes fallback curbs with composed ground instead of an exposed rear face', async () => {
    const source = await readFile(new URL('../world/curbs.js', import.meta.url), 'utf8');
    assert.match(
        source,
        /const backProfile = !terrainReference[\s\S]{0,240}\? 'terrain-seam'[\s\S]{0,80}: 'vertical'/,
    );
    assert.match(
        source,
        /surfaceClass:\s*SURFACE_CLASS\.ROAD_EARTHWORK[\s\S]{0,360}ownerId:\s*'curb-terrain-seam'/,
    );
    assert.match(
        source,
        /urbanGroundUpwardOnly:\s*true/,
        'urban seams become pavement while natural roadside seams retain landuse',
    );
});

test('ground and terrain render after every same-level roadbed writer', async () => {
    assert.equal(GROUND_STENCIL_READER_RENDER_ORDER, ROAD_STENCIL_RENDER_ORDER + 4);
    const [terrainSource, setupSource] = await Promise.all([
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
        readFile(new URL('../scene/setup.js', import.meta.url), 'utf8'),
    ]);
    assert.match(terrainSource, /mesh\.renderOrder = GROUND_STENCIL_READER_RENDER_ORDER/);
    assert.match(setupSource, /groundMesh\.renderOrder = GROUND_STENCIL_READER_RENDER_ORDER/);
});

test('boxed-underpass restoration cannot overwrite an asphalt correction', async () => {
    const source = await readFile(new URL('../world/terrain.js', import.meta.url), 'utf8');
    const clearIndex = source.indexOf("drawRing(region.clearRing || [], region.clearBounds, '#000')");
    const correctionIndex = source.indexOf('for (const correction of surfaceCorrections)');
    const openingIndex = source.indexOf('region.cutoutRing || []', correctionIndex);
    assert.ok(clearIndex >= 0 && correctionIndex > clearIndex);
    assert.ok(openingIndex > correctionIndex);
});

test('ordinary trackbed owns same-level paint while grade-separated trackbed preserves both', () => {
    assert.ok(
        SURFACE_RENDER_ORDER.ROAD_MARKING < SURFACE_RENDER_ORDER.RAIL_TRACKBED,
    );
    const bridgeTrack = publishedClaim(SURFACE_CLASS.RAIL_TRACKBED, {
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        supportReady: true,
        cutsBackstop: true,
    });
    assert.equal(surfaceStencilContract(bridgeTrack).enabled, false);
});
