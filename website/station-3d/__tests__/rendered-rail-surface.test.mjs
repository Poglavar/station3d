import test from 'node:test';
import assert from 'node:assert/strict';

import {
    activateRenderedRailTerrainCutoutRegions,
    activateViaductTerrainCutoutRegions,
    buildRenderedRailSurfaceRegions,
    buildViaductTerrainCutoutRegions,
    createRenderedRailSurfaceMaskModel,
    createRenderedRailSurfaceMaskModelFromRegions,
    createRenderedRailSurfaceMaskModelFromRegionsSteps,
    renderedRailSegmentKeepsTerrainRoof,
    renderedRailSegmentOwnsCivilGround,
    renderedRailTerrainCutoutRegionsSignature,
    renderedRailSurfaceRegionCutsTerrain,
} from '../core/rendered-rail-surface.js';
import { SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';

function segment(overrides = {}) {
    return {
        x1: 0,
        z1: 0,
        x2: 10,
        z2: 0,
        yStart: 2,
        yEnd: 2,
        startJoinX: 0,
        startJoinZ: -1,
        endJoinX: 0,
        endJoinZ: -1,
        startTrackbedHalfWidthM: 2,
        endTrackbedHalfWidthM: 2,
        startTrackbedInnerEdgeM: 0.6,
        endTrackbedInnerEdgeM: 0.6,
        startKey: 'a',
        endKey: 'b',
        sortKey: 'a>b',
        properties: { railway: 'tram' },
        ...overrides,
    };
}

test('rendered tram cutouts match the two visible strips and preserve an island gap', () => {
    const regions = buildRenderedRailSurfaceRegions([segment()]);
    assert.equal(regions.length, 2);
    assert.ok(regions.every(region => region.kind === 'trackbed-strip'));
    assert.ok(regions.every(region => !(
        region.bounds.minZ < 0 && region.bounds.maxZ > 0
    )), 'neither strip spans the unrendered centre gap');
});

test('terrain is removed only when it physically intrudes above the rendered bed', () => {
    const [region] = buildRenderedRailSurfaceRegions([segment()], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    assert.equal(renderedRailSurfaceRegionCutsTerrain(region, () => 2.07), false,
        'the shared 8 cm tolerance keeps a flush/fill backstop');
    assert.equal(renderedRailSurfaceRegionCutsTerrain(region, () => 2.5), true,
        'a half-metre terrain lid above the visible trackbed is cut');
});

test('a terrain intrusion on one side cuts only that exact trackbed strip', () => {
    const regions = buildRenderedRailSurfaceRegions([segment()], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    const cutsBySide = regions.map(region => ({
        centerZ: (region.bounds.minZ + region.bounds.maxZ) * 0.5,
        cuts: renderedRailSurfaceRegionCutsTerrain(
            region,
            (_x, z) => z < 0 ? 2.5 : 1.5,
        ),
    }));
    assert.equal(cutsBySide.find(entry => entry.centerZ < 0)?.cuts, true);
    assert.equal(cutsBySide.find(entry => entry.centerZ > 0)?.cuts, false);
});

test('published heavy-rail terrain cutouts remain exact and revision-stable', () => {
    const source = buildRenderedRailSurfaceRegions([segment({
        properties: { railway: 'rail' },
    })], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    const active = activateRenderedRailTerrainCutoutRegions(source, (_x, z) => (
        z < 0 ? 2.5 : 1.5
    ));
    assert.equal(active.length, 1);
    assert.equal(
        renderedRailTerrainCutoutRegionsSignature(active),
        renderedRailTerrainCutoutRegionsSignature(structuredClone(active)),
        'content identity does not depend on render-cell object identity',
    );
    const model = createRenderedRailSurfaceMaskModelFromRegions(source, {
        revision: 8,
        terrainCutoutRegions: active,
        terrainCutoutRevision: 4,
    });
    assert.equal(model.terrainCutoutRevision, 4);
    assert.deepEqual(model.getTerrainCutoutRegions(), active);
    assert.deepEqual(model.terrainCutoutRegionsNear(5, -1, 3), active);
    assert.ok(model.terrainCutoutAtLocal(5, -1));
    assert.equal(model.terrainCutoutAtLocal(5, 1), null,
        'the uncut side remains terrain-backed');
});

test('tunnel trackbed never turns its intentionally retained hill into a surface cut', () => {
    const tunnel = segment({
        structureStart: 'tunnel',
        structureEnd: 'tunnel',
    });
    assert.equal(renderedRailSegmentKeepsTerrainRoof(tunnel), true);
    assert.deepEqual(buildRenderedRailSurfaceRegions([tunnel]), []);
});

test('ordinary street-running tram owns the exact road and sidewalk overlap', () => {
    const ordinary = segment();
    assert.equal(renderedRailSegmentOwnsCivilGround(ordinary), true);
    const model = createRenderedRailSurfaceMaskModel([ordinary], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    assert.equal(model.getTerrainSurfaceRegions().length, 2);
    assert.equal(model.getCivilGroundSurfaceRegions().length, 2);
    assert.deepEqual(
        model.civilGroundSurfaceRegionsNear(5, 0, 8),
        model.getCivilGroundSurfaceRegions(),
    );
    assert.ok(model.civilGroundSurfaceAtLocal(5, 1));
    assert.equal(model.civilGroundSurfaceAtLocal(5, 1).sceneY, 2);
    assert.equal(model.civilGroundSurfaceAtLocal(5, 0), null,
        'the analytic query preserves the unrendered island gap');
});

test('structural tram never plan-masks a road at another elevation', () => {
    const bridge = segment({
        properties: { railway: 'tram', bridge: 'yes', layer: 1 },
        structureStart: 'viaduct',
        structureEnd: 'viaduct',
    });
    assert.equal(renderedRailSegmentOwnsCivilGround(bridge), false);
    const model = createRenderedRailSurfaceMaskModel([bridge], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    assert.equal(model.getTerrainSurfaceRegions().length, 2,
        'terrain intrusion remains a separate depth-aware question');
    assert.deepEqual(model.getCivilGroundSurfaceRegions(), [],
        'a plan-only exclusion must not punch through the lower road');
    assert.equal(model.civilGroundSurfaceAtLocal(5, 1), null);
});

test('viaduct terrain ownership covers the full opaque deck cross-section', () => {
    const run = {
        alignment: { halfWidthM: 2 },
        samples: [
            { station: 0, x: 0, z: 0, railY: 2 },
            { station: 10, x: 10, z: 0, railY: 2 },
        ],
    };
    const regions = buildViaductTerrainCutoutRegions([run]);
    assert.equal(regions.length, 3, 'the two 1.5 m endpoint overlaps share the deck footprint');
    const center = regions[1];
    assert.equal(center.kind, 'viaduct-deck-terrain-cutout');
    assert.ok(Math.abs(center.bounds.minZ + 3.35) < 1e-9);
    assert.ok(Math.abs(center.bounds.maxZ - 3.35) < 1e-9,
        'trackbed + two-sided walkway + slab margin share one edge');
    assert.ok(center.ring.every(point => Math.abs(point.y - 2.06) < 1e-9),
        'the ownership surface is the concrete deck top, not the terrain or rail bar');

    assert.deepEqual(activateViaductTerrainCutoutRegions(regions, () => 2.10), [],
        'a flush four-centimetre discrepancy stays below the shared excavation tolerance');
    const active = activateViaductTerrainCutoutRegions(regions, () => 2.44);
    assert.equal(active.length, 3, 'a terrain lid above the slab activates the opaque replacement');
    assert.ok(active.every(region => region.terrainCutoutActive === true));
});

test('published viaduct replacement is queryable at deck height without owning civil ground', () => {
    const run = {
        alignment: { halfWidthM: 2 },
        samples: [
            { station: 0, x: 0, z: 0, railY: 4 },
            { station: 10, x: 10, z: 0, railY: 5 },
        ],
    };
    const active = activateViaductTerrainCutoutRegions(
        buildViaductTerrainCutoutRegions([run]),
        () => 8,
    );
    const model = createRenderedRailSurfaceMaskModelFromRegions([], {
        revision: 7,
        viaductTerrainCutoutRegions: active,
        viaductTerrainCutoutRevision: 3,
    });
    assert.equal(model.getViaductTerrainCutoutRegions().length, 3);
    assert.equal(model.getCivilGroundSurfaceRegions().length, 0,
        'a bridge opening never becomes plan-only ground ownership');
    const hit = model.viaductTerrainCutoutAtLocal(5, 0);
    assert.ok(hit);
    assert.ok(Math.abs(hit.sceneY - 4.56) < 1e-9,
        'walk support interpolates the same one-metre deck grade');
    assert.equal(model.viaductTerrainCutoutAtLocal(5, 4), null);
});

test('planned rail geometry cannot suppress the visible ground before publication', () => {
    const [plannedRegion] = buildRenderedRailSurfaceRegions([segment()]);
    assert.equal(
        renderedRailSurfaceRegionCutsTerrain(plannedRegion, () => 99),
        false,
        'even a large terrain intrusion retains its backstop until geometry is visible',
    );
    const model = createRenderedRailSurfaceMaskModel([segment()]);
    assert.deepEqual(model.getTerrainSurfaceRegions(), []);
    assert.deepEqual(model.getCivilGroundSurfaceRegions(), []);
});

test('a published surface model acknowledges its ownership mask only once', () => {
    const published = buildRenderedRailSurfaceRegions([segment()], {
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    });
    const revisions = [];
    const model = createRenderedRailSurfaceMaskModel([segment()], {
        revision: 12,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        onPublished: revision => revisions.push(revision),
    });
    assert.equal(model.getTerrainSurfaceRegions().length, published.length);
    model.onGroundMaskPublished();
    model.onGroundMaskPublished();
    assert.deepEqual(revisions, [12]);
});


test('prepared rail coverage owns immutable coordinates and notifies only after explicit mask publication', () => {
    const source = buildRenderedRailSurfaceRegions([segment()], { coverageState: SURFACE_COVERAGE_STATE.PUBLISHED });
    const active = activateRenderedRailTerrainCutoutRegions(source, () => 10);
    let time = 0, notified = 0, yields = 0;
    const steps = createRenderedRailSurfaceMaskModelFromRegionsSteps(source, { revision: 7,
        terrainCutoutRegions: active, terrainCutoutRevision: 3, now: () => time++, onPublished: () => notified++ });
    let next; do { next = steps.next(); if (!next.done) yields++; assert.equal(notified, 0); } while (!next.done);
    const model = next.value;
    assert.ok(yields > 10); assert.equal(Object.isFrozen(model), true);
    assert.equal(model.civilGroundSurfaceAtLocal(5, 1).sceneY, 2);
    assert.equal(model.civilGroundSurfaceAtLocal(5, 0), null, 'the gap between rail strips stays open');
    assert.equal(model.terrainCutoutAtLocal(5, 1).sceneY, 2);
    for (const region of source) {
        region.bounds.minX = 1000;
        for (const point of region.ring) { point.x += 1000; point.y = 80; }
    }
    source.length = 0; active.length = 0;
    assert.equal(model.civilGroundSurfaceAtLocal(5, 1).sceneY, 2);
    assert.equal(model.terrainCutoutAtLocal(5, 1).sceneY, 2);
    assert.equal(model.getTerrainSurfaceRegions().length, 2);
    assert.throws(() => model.getTerrainSurfaceRegions().push({}), TypeError);
    assert.throws(() => { model.getTerrainSurfaceRegions()[0].ring[0].y = 50; }, TypeError);
    model.onGroundMaskPublished(); model.onGroundMaskPublished(); assert.equal(notified, 1);
});

test('rail coverage preparation cancels without publishing, including filtered regions', () => {
    for (const coverageState of [SURFACE_COVERAGE_STATE.PUBLISHED, SURFACE_COVERAGE_STATE.PLANNED]) {
        let time = 0, current = true, notified = 0;
        const source = buildRenderedRailSurfaceRegions([segment()], { coverageState });
        const steps = createRenderedRailSurfaceMaskModelFromRegionsSteps(source, {
            now: () => time++, isCurrent: () => current, onPublished: () => notified++ });
        assert.equal(steps.next().done, false); current = false;
        assert.deepEqual(steps.next(), { done: true, value: null }); assert.equal(notified, 0);
    }
});
