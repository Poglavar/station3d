// An osm_id formation query used to scan EVERY segment of that road at an
// infinite radius. Its callers query per vertex of geometry draped on that same
// road, so draping one long road cost O(segments²) — measured 2026-07-30 as the
// bulk of a 124 ms lane-marking rebuild running two to three times a second.
//
// These pin both halves of the fix: the answer must not change, and the cost
// must stop growing with road length.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel } from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 45.8;
const ANCHOR_LON = 15.98;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

const lonLat = (x, z) => [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];

function centerline(osmId, points, highway = 'primary') {
    return {
        type: 'Feature',
        properties: { osm_id: osmId, highway },
        geometry: { type: 'LineString', coordinates: points.map(([x, z]) => lonLat(x, z)) },
    };
}

// A long road as a gentle S so segments are not collinear and the nearest one
// is a genuine search rather than "the closest by index".
function longRoad(osmId, segmentCount, spacingM = 10) {
    const points = [];
    for (let index = 0; index <= segmentCount; index++) {
        const x = index * spacingM;
        points.push([x, Math.sin(index / 6) * 25]);
    }
    return centerline(osmId, points);
}

function modelWith(features, baseY = () => 0) {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: baseY,
    });
    model.setCenterlineTile('0_0', features);
    return model;
}

// The unindexed answer, computed directly from the road's own segment list.
// Segment lists are keyed by the model's string id form, not the raw number.
function fullScanFormation(model, x, z, osmId) {
    const segments = model._segmentsByOsmId.get(String(osmId));
    assert.ok(segments && segments.length > 0, `no segments held for road ${osmId}`);
    return model._nearestOnSegments(x, z, segments, Infinity);
}

test('the indexed answer equals the full scan everywhere along a long road', () => {
    const osmId = 4242;
    const model = modelWith([longRoad(osmId, 200)]);
    model.formationAtLocal(0, 0, { osmId });   // force _ensureBuilt

    let compared = 0;
    for (let x = -60; x <= 2060; x += 7) {
        for (const z of [-40, -3, 0, 2.5, 41]) {
            const indexed = model.formationAtLocal(x, z, { osmId });
            const scanned = fullScanFormation(model, x, z, osmId);
            assert.equal(!!indexed, !!scanned, `presence differs at ${x},${z}`);
            if (!indexed) continue;
            assert.ok(
                Math.abs(indexed.distanceSquared - scanned.distanceSquared) < 1e-9,
                `distance differs at ${x},${z}: ${indexed.distanceSquared} vs ${scanned.distanceSquared}`,
            );
            assert.equal(indexed.roadY, scanned.roadY, `roadY differs at ${x},${z}`);
            assert.equal(indexed.osmId, scanned.osmId);
            compared += 1;
        }
    }
    assert.ok(compared > 500, `expected a broad sweep, compared ${compared}`);
});

test('a point far from its own road still finds it, at the same answer', () => {
    // This is the case the infinite radius exists for, and the one the index
    // cannot answer — it must fall through to the full scan rather than miss.
    const osmId = 7;
    const model = modelWith([centerline(osmId, [[0, 0], [50, 0]])]);
    const indexed = model.formationAtLocal(900, 900, { osmId });
    const scanned = fullScanFormation(model, 900, 900, osmId);
    assert.ok(indexed, 'a far point must still resolve to its own road');
    assert.equal(indexed.distanceSquared, scanned.distanceSquared);
    assert.equal(indexed.roadY, scanned.roadY);
});

test('query cost stops growing with road length', () => {
    // Same query, same local geometry, on roads that differ only in how far they
    // continue past the query point. Before the index, the second road cost four
    // times the first for an identical answer.
    const shortModel = modelWith([longRoad(11, 50)]);
    const longModel = modelWith([longRoad(11, 400)]);
    shortModel.formationAtLocal(0, 0, { osmId: 11 });
    longModel.formationAtLocal(0, 0, { osmId: 11 });

    shortModel.resetSegmentProjectionCount();
    longModel.resetSegmentProjectionCount();
    for (let x = 0; x <= 200; x += 2) {
        shortModel.formationAtLocal(x, 1, { osmId: 11 });
        longModel.formationAtLocal(x, 1, { osmId: 11 });
    }
    const shortCost = shortModel.getSegmentProjectionCount();
    const longCost = longModel.getSegmentProjectionCount();

    assert.equal(
        longCost,
        shortCost,
        `a road 8× longer must not cost more per query (${shortCost} vs ${longCost})`,
    );
    // And the absolute cost must be local, not the whole road: 100 queries over
    // a 400-segment road would be 40 000 projections unindexed.
    assert.ok(longCost < 4000, `expected a local search, got ${longCost} projections`);
});

test('the index is rebuilt when tiles stream in and out', () => {
    // A road's own geometry is immutable for a session (segments are cached by
    // osm_id on purpose), so what actually varies is WHICH roads are loaded. The
    // index must follow that, or an evicted road keeps answering queries.
    const model = modelWith([longRoad(1, 40)]);
    assert.ok(model.formationAtLocal(200, 2, { osmId: 1 }), 'loaded road resolves');

    model.setCenterlineTile('1_0', [longRoad(2, 40)]);
    const second = model.formationAtLocal(200, 2, { osmId: 2 });
    assert.ok(second, 'a newly streamed road resolves');
    assert.equal(second.distanceSquared, fullScanFormation(model, 200, 2, 2).distanceSquared);

    model.removeCenterlineTile('0_0');
    assert.equal(
        model.formationAtLocal(200, 2, { osmId: 1 }),
        null,
        'an evicted road must stop answering, not serve a stale index',
    );
    // The survivor is unaffected by its neighbour's eviction.
    assert.equal(
        model.formationAtLocal(200, 2, { osmId: 2 }).distanceSquared,
        second.distanceSquared,
    );
});
