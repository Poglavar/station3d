// Headless unit tests for the far LOD1 geometry helpers — the projection and
// height rules that must match the detailed layer so a building doesn't jump when
// it swaps LOD. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pickFarHeight, pickFarHeightForFeature, projectRing, outerRings,
    FAR_MIN_HEIGHT_M, FAR_FALLBACK_HEIGHT_M,
} from '../world/lod1-geometry.js';
import { geoToLocal } from '../core/math.js';
import { estimateOvertureBuildingHeight } from '../core/overture-building-shape.js';

test('pickFarHeight uses eave, clamps to a floor, falls back when unknown', () => {
    assert.equal(pickFarHeight(10), 10);
    assert.equal(pickFarHeight(FAR_MIN_HEIGHT_M - 0.5), FAR_MIN_HEIGHT_M);   // clamp up
    assert.equal(pickFarHeight(null), FAR_FALLBACK_HEIGHT_M);
    assert.equal(pickFarHeight(undefined), FAR_FALLBACK_HEIGHT_M);
    assert.equal(pickFarHeight(0), FAR_FALLBACK_HEIGHT_M);
    assert.equal(pickFarHeight(-3), FAR_FALLBACK_HEIGHT_M);
    assert.equal(pickFarHeight('2.4'), 2.4);   // string from JSON coerces
});

test('pickFarHeightForFeature mirrors the detailed layer at the LOD swap', () => {
    const anchorLat = 43.5081;   // Split
    const footprint = {
        type: 'Polygon',
        coordinates: [[[16.44, 43.51], [16.441, 43.51], [16.441, 43.511], [16.44, 43.511], [16.44, 43.51]]],
    };

    // A real eave height always wins (GDI surveyed; Overture height/floors).
    assert.equal(pickFarHeightForFeature(
        { source: 'overture', object_id: 'ob1', eave_height_m: 14 }, footprint, anchorLat), 14);
    assert.equal(pickFarHeightForFeature(
        { object_id: 338194, eave_height_m: 6.3 }, footprint, anchorLat), 6.3);

    // Height-poor Overture (≈95% of Split): the far prism must run the SAME
    // area+seed estimate the detailed layer will, not the flat 6 m fallback —
    // otherwise nearly every building pops at the ~300 m hand-off.
    const estimated = estimateOvertureBuildingHeight(footprint, 'ob1', anchorLat);
    assert.equal(
        pickFarHeightForFeature({ source: 'overture', object_id: 'ob1', eave_height_m: null }, footprint, anchorLat),
        Math.max(estimated, FAR_MIN_HEIGHT_M));
    assert.notEqual(estimated, FAR_FALLBACK_HEIGHT_M);   // the test footprint must exercise the fix

    // Non-Overture without a height keeps the flat fallback.
    assert.equal(pickFarHeightForFeature(
        { object_id: 338194, eave_height_m: null }, footprint, anchorLat), FAR_FALLBACK_HEIGHT_M);
    assert.equal(pickFarHeightForFeature(null, footprint, anchorLat), FAR_FALLBACK_HEIGHT_M);
});

test('/buildings-render tier 3 estimates like the detailed layer, tier 2 uses the measurement', () => {
    const anchorLat = 43.5081;   // Split
    const footprint = {
        type: 'Polygon',
        coordinates: [[[16.44, 43.51], [16.441, 43.51], [16.441, 43.511], [16.44, 43.511], [16.44, 43.51]]],
    };

    // Tier 2: a measured height is a real number and is used as-is.
    assert.equal(pickFarHeightForFeature(
        { object_id: '4341825', eave_height_m: 15.6234, height_source: 'lidar_laz' },
        footprint, anchorLat), 15.6234);

    // Tier 3: the resolver says outright that there is no height
    // (height_source 'none'), and these features carry no `source: 'overture'`
    // marker. Before this branch they took the flat fallback out here while the
    // detailed layer ran the area+seed estimate — so every tier-3 building
    // changed size at the hand-off.
    const estimated = estimateOvertureBuildingHeight(footprint, '4343357', anchorLat);
    assert.notEqual(estimated, FAR_FALLBACK_HEIGHT_M);   // footprint must exercise the fix
    assert.equal(
        pickFarHeightForFeature(
            { object_id: '4343357', eave_height_m: null, height_source: 'none' },
            footprint, anchorLat),
        Math.max(estimated, FAR_MIN_HEIGHT_M));
});

test('projectRing matches geoToLocal exactly (far/near alignment)', () => {
    const anchorLon = 15.9772, anchorLat = 45.8131;
    const ring = [[15.9772, 45.8131], [15.9782, 45.8131], [15.9782, 45.8141]];
    const got = projectRing(ring, anchorLon, anchorLat);
    assert.equal(got.length, 3);
    // Anchor point projects to the origin.
    assert.ok(Math.hypot(got[0].x, got[0].z) < 1e-6);
    // Every vertex equals the shared projection the detailed layer uses.
    for (let i = 0; i < ring.length; i++) {
        const exp = geoToLocal(ring[i][0], ring[i][1], anchorLon, anchorLat);
        assert.ok(Math.abs(got[i].x - exp.x) < 1e-9);
        assert.ok(Math.abs(got[i].z - exp.z) < 1e-9);
    }
    // +lon → +x (east), +lat → -z (north is -z in this basis).
    assert.ok(got[1].x > 0);
    assert.ok(got[2].z < 0);
});

test('outerRings extracts outer ring(s), drops holes and junk', () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const hole = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]];

    assert.deepEqual(outerRings({ type: 'Polygon', coordinates: [square, hole] }), [square]);

    const multi = outerRings({ type: 'MultiPolygon', coordinates: [[square, hole], [square]] });
    assert.equal(multi.length, 2);
    assert.deepEqual(multi[0], square);

    assert.deepEqual(outerRings(null), []);
    assert.deepEqual(outerRings({ type: 'Point', coordinates: [0, 0] }), []);
    assert.deepEqual(outerRings({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }), []); // <4 pts
});

// --- far build budget -------------------------------------------------------
//
// The horizon ring is the cheapest geometry in the world and exists to give
// context EARLY. Running it at the steady trickle from cold inverts that: the
// first ring is ~9 tiles x 600 prisms, which at 2 ms a frame is tens of seconds
// of empty distance.
test('the far ring takes a real slice until its first horizon is built', async () => {
    const { farFrameBudgetMs, FAR_PRIME_BUDGET_MS, FAR_STEADY_BUDGET_MS } =
        await import('../world/lod1-geometry.js');
    const ring = { primeTiles: 9 };

    // Cold: burst, so the horizon appears rather than trickling in.
    assert.equal(farFrameBudgetMs(0, ring), FAR_PRIME_BUDGET_MS);
    assert.equal(farFrameBudgetMs(8, ring), FAR_PRIME_BUDGET_MS);

    // First ring up: back to the trickle, which is what keeps far work from
    // stealing frames from the buildings you are walking past.
    assert.equal(farFrameBudgetMs(9, ring), FAR_STEADY_BUDGET_MS);
    assert.equal(farFrameBudgetMs(400, ring), FAR_STEADY_BUDGET_MS);

    // The burst must actually be a burst, or this is decoration.
    assert.ok(FAR_PRIME_BUDGET_MS > FAR_STEADY_BUDGET_MS);

    // Nonsense input falls back to the steady budget rather than bursting forever.
    assert.equal(farFrameBudgetMs(NaN, ring), FAR_STEADY_BUDGET_MS);
    assert.equal(farFrameBudgetMs(0, {}), FAR_STEADY_BUDGET_MS);
});
