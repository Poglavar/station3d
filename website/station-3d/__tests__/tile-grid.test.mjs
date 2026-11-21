// Headless unit tests for the per-source tile grid (tile-stream.js). Proves the
// default 200 m grid is byte-for-byte unchanged after parametrization, and that a
// coarse grid (the far LOD1 building layer's 800 m tiles) indexes and covers as
// expected. Run: node --test website/station-3d/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CURB_AHEAD,
    DETAILED_BUILDING_STREAM_OPTIONS,
    DETAILED_BUILDING_RING,
    DETAILED_BUILDING_TILE_M,
    NEAR_ROAD_MAX_CONCURRENT_REQUESTS,
    NEAR_ROAD_STREAM_OPTIONS,
    TILE_M,
    boundsIntersectWithPadding,
    tileBbox,
    tileDistanceSqToPoint,
    tileIndex,
} from '../core/tile-stream.js';

test('default tileIndex (200 m) is unchanged', () => {
    assert.equal(TILE_M, 200);
    assert.equal(tileIndex(0), 0);
    assert.equal(tileIndex(199.9), 0);
    assert.equal(tileIndex(200), 1);
    assert.equal(tileIndex(-1), -1);        // floor, not truncate
    assert.equal(tileIndex(-200), -1);
    assert.equal(tileIndex(-201), -2);
});

test('near road sources cap in-flight work before their ahead corridor', () => {
    assert.equal(NEAR_ROAD_MAX_CONCURRENT_REQUESTS, 4);
    assert.deepEqual(NEAR_ROAD_STREAM_OPTIONS, {
        maxConcurrentRequests: 4,
        startupPriority: 2,
        prioritizeByView: true,
    });
});

// The reach itself is asserted in view-corridor-reach.test.mjs, against the fog
// distance and the road corridor rather than against a literal. A deepEqual on
// {distanceM: 600} lived here and passed for any number someone typed — which is
// how the corridor lost 800 m with only a slow browser spec noticing.
test('the curb corridor is as wide as the road corridor it edges', () => {
    assert.equal(CURB_AHEAD.halfWidthM, 120);
});

test('spatial invalidation padding reaches only nearby tile bounds', () => {
    const tile = { minX: 0, minZ: 0, maxX: 200, maxZ: 200 };
    assert.equal(boundsIntersectWithPadding(
        tile,
        { minX: 210, minZ: 20, maxX: 220, maxZ: 30 },
        15,
    ), true);
    assert.equal(boundsIntersectWithPadding(
        tile,
        { minX: 216, minZ: 20, maxX: 220, maxZ: 30 },
        15,
    ), false);
});

test('coarse tileIndex (800 m) partitions on its own pitch', () => {
    assert.equal(tileIndex(0, 800), 0);
    assert.equal(tileIndex(799, 800), 0);
    assert.equal(tileIndex(800, 800), 1);
    assert.equal(tileIndex(-1, 800), -1);
});

test('tileBbox default spans 200 m; passing tileM omitted matches passing 200', () => {
    const lat = 45.8131, lon = 15.9772;
    const a = tileBbox(0, 0, lat, lon);
    const b = tileBbox(0, 0, lat, lon, 200);
    assert.deepEqual(a, b);
    // north is at zMin=0 (anchor), south one tile further; span ~200 m in latitude.
    const spanLatM = (a.north - a.south) * 111320;
    assert.ok(Math.abs(spanLatM - 200) < 0.5, `expected ~200 m, got ${spanLatM}`);
});

test('coarse tileBbox spans its own tileM', () => {
    const lat = 45.8131, lon = 15.9772;
    const bb = tileBbox(0, 0, lat, lon, 800);
    const spanLatM = (bb.north - bb.south) * 111320;
    assert.ok(Math.abs(spanLatM - 800) < 1, `expected ~800 m, got ${spanLatM}`);
});

test('an 800 m ring-1 grid guarantees >=800 m of reach in every direction', () => {
    // A ring of `ring` cells around the camera's cell covers the half-open
    // interval [(c-ring)*tileM, (c+ring+1)*tileM). The guaranteed reach beyond
    // the camera is the smaller of the two gaps to that interval's edges; its
    // worst case over all positions is exactly tileM (camera at a cell edge).
    const tileM = 800, ring = 1;
    let worstReach = Infinity;
    for (let pos = -2000; pos <= 2000; pos += 7.3) {   // sweep, hitting edges and interiors
        const c = tileIndex(pos, tileM);
        const lo = (c - ring) * tileM;
        const hi = (c + ring + 1) * tileM;
        worstReach = Math.min(worstReach, hi - pos, pos - lo);
    }
    assert.ok(worstReach >= tileM - 8, `guaranteed reach ${worstReach} fell below ${tileM}`);
    assert.ok(worstReach <= tileM + 8, `guaranteed reach ${worstReach} implausibly high`);
});

test('detailed buildings use smaller tiles while preserving the near-field reach', () => {
    assert.equal(DETAILED_BUILDING_TILE_M, 100);
    assert.equal(DETAILED_BUILDING_RING, 2);
    assert.equal(
        DETAILED_BUILDING_TILE_M * DETAILED_BUILDING_RING,
        TILE_M,
        'the guaranteed reach remains the established 200 m',
    );
});

test('every detailed-building consumer inherits canonical view priority', () => {
    assert.equal(DETAILED_BUILDING_STREAM_OPTIONS.prioritizeByView, true);
    assert.equal(
        typeof DETAILED_BUILDING_STREAM_OPTIONS.createTextDecodeTask,
        'function',
        'detailed building tiles must not return to one atomic JSON.parse',
    );
});

test('all four tiles touching a grid-corner observer have zero fetch distance', () => {
    const touching = [[0, 0], [-1, 0], [0, -1], [-1, -1]];
    for (const [tx, tz] of touching) {
        assert.equal(
            tileDistanceSqToPoint(tx, tz, 0, 0, DETAILED_BUILDING_TILE_M),
            0,
            `${tx}_${tz} touches the observer`,
        );
    }
    assert.equal(
        tileDistanceSqToPoint(1, 0, 0, 0, DETAILED_BUILDING_TILE_M),
        DETAILED_BUILDING_TILE_M ** 2,
    );
});
