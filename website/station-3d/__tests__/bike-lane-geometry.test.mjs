// Tests OSM cycling-tag interpretation and red-strip placement without THREE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    bikePaintSceneY,
    buildBikeLaneQuads,
    buildCenteredBikeLaneQuads,
    PATH_BIKE_PAINT_LIFT_M,
    resolveBikeLaneBands,
} from '../core/bike-lane-geometry.js';
import { buildChainsFromSegments } from '../world/footpath-geometry.js';

test('side-specific OSM lane tags produce only their respective strips', () => {
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'residential',
            tags: { 'cycleway:right': 'lane' },
        }),
        [{ side: 'right', widthM: 1.65, placement: 'lane' }],
    );
});

test('generic cycleway lane uses the right edge of both directions on a two-way road', () => {
    assert.deepEqual(
        resolveBikeLaneBands({ highway_type: 'secondary', tags: { cycleway: 'lane' } })
            .map((band) => band.side),
        ['left', 'right'],
    );
});

test('generic cycleway lane follows the traffic-right edge on forward and reversed one-ways', () => {
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'secondary',
            oneway: 'yes',
            tags: { cycleway: 'lane' },
        }).map((band) => band.side),
        ['right'],
    );
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'secondary',
            oneway: '-1',
            tags: { cycleway: 'lane' },
        }).map((band) => band.side),
        ['left'],
    );
});

test('designated bicycle use paints a centered strip on shared paths', () => {
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'footway',
            tags: { bicycle: 'designated' },
        }).map((band) => band.side),
        ['center'],
    );
});

test('an explicit side lane wins over generic bicycle access on pedestrian paving', () => {
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'pedestrian',
            tags: { bicycle: 'yes', 'cycleway:right': 'shared_lane' },
        }).map((band) => band.side),
        ['right'],
    );
});

test('standalone cycleway becomes the same centered paint ribbon as other bike infrastructure', () => {
    assert.deepEqual(
        resolveBikeLaneBands({
            highway_type: 'cycleway',
            width_meters: 2.4,
            tags: { bicycle: 'designated' },
        }),
        [{ side: 'center', widthM: 2.4, placement: 'standalone' }],
    );
});

test('right-side strip lies on the right of OSM way direction and inside road edge', () => {
    const [quad] = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 10, z: 0 }],
        [{ side: 'right', widthM: 1.65 }],
        8,
    );
    assert.ok(quad.every((point) => point.z > 0));
    assert.ok(Math.max(...quad.map((point) => point.z)) < 4);
});

test('a wide multi-lane carriageway keeps bike paint beyond the rightmost motor lane', () => {
    const [quad] = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 20, z: 0 }],
        [{ side: 'right', widthM: 1.65, placement: 'lane' }],
        14,
    );
    const centerZ = quad.reduce((sum, point) => sum + point.z, 0) / quad.length;
    assert.ok(centerZ > 5.5, `bike-lane centre z=${centerZ}`);
    assert.ok(Math.max(...quad.map((point) => point.z)) < 7);
});

test('a mapped track is painted beyond the carriageway edge on the curb side', () => {
    const [quad] = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 10, z: 0 }],
        [{ side: 'right', widthM: 1.65, placement: 'track' }],
        8,
    );
    assert.ok(quad.every((point) => point.z >= 4));
});

test('bike strips smooth a sharp road bend into a continuous curved ribbon', () => {
    const quads = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
        [{ side: 'center', widthM: 1.65 }],
        8,
    );

    assert.ok(quads.length > 2);
    for (let index = 0; index + 1 < quads.length; index++) {
        assert.deepEqual(quads[index][1], quads[index + 1][0]);
        assert.deepEqual(quads[index][2], quads[index + 1][3]);
    }

    const headings = quads.map((quad) => Math.atan2(
        quad[1].z - quad[0].z,
        quad[1].x - quad[0].x,
    ));
    assert.ok(new Set(headings.map((heading) => heading.toFixed(3))).size > 2);
});

test('smoothed bike-strip joints stay capped instead of producing corner spikes', () => {
    const quads = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }],
        [{ side: 'right', widthM: 1.65 }],
        8,
    );
    const points = quads.flat();

    assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
    assert.ok(points.every((point) => point.x > -1 && point.x < 9 && point.z > -5 && point.z < 6));
});

test('curb offset does not inflate the painted width into an arrowhead at a bend', () => {
    const quads = buildBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }],
        [{ side: 'right', widthM: 1.65 }],
        12,
    );
    const crossWidths = quads.flatMap((quad) => [
        Math.hypot(quad[0].x - quad[3].x, quad[0].z - quad[3].z),
        Math.hypot(quad[1].x - quad[2].x, quad[1].z - quad[2].z),
    ]);

    assert.ok(Math.max(...crossWidths) < 2.2, `max painted width=${Math.max(...crossWidths)}`);
});

test('split cycleway and bicycle-footway fragments become one smoothed paint chain', () => {
    const [chain] = buildChainsFromSegments([
        { x1: 0, z1: 0, x2: 5, z2: 0, width: 1.65 },
        { x1: 5, z1: 0, x2: 6, z2: 1, width: 1.65 },
        { x1: 6, z1: 1, x2: 6, z2: 6, width: 1.65 },
    ]);
    const quads = buildCenteredBikeLaneQuads(chain.points, chain.widths);

    assert.equal(chain.points.length, 4);
    assert.ok(quads.length > 3, 'joined chain receives curve subdivision');
    for (let index = 0; index + 1 < quads.length; index++) {
        assert.deepEqual(quads[index][1], quads[index + 1][0]);
        assert.deepEqual(quads[index][2], quads[index + 1][3]);
    }
});

test('a two-node bridge cycleway is subdivided before sampling its vertical profile', () => {
    const quads = buildCenteredBikeLaneQuads(
        [{ x: 0, z: 0 }, { x: 100, z: 0 }],
        [1.65, 1.65],
        { maxSegmentM: 8 },
    );

    assert.ok(quads.length >= 48, `profiled quads=${quads.length}`);
    assert.ok(
        quads.every((quad) => (
            Math.hypot(quad[1].x - quad[0].x, quad[1].z - quad[0].z) <= 8
        )),
        'no paint chord may span the bridge crest',
    );
});

test('path-owned bike paint clears coplanar path triangles without bypassing depth testing', () => {
    assert.equal(bikePaintSceneY(10, 0.049), 10.049);
    assert.equal(
        bikePaintSceneY(10, 0.049, { pathOwned: true }),
        10.049 + PATH_BIKE_PAINT_LIFT_M,
    );
    assert.ok(PATH_BIKE_PAINT_LIFT_M > 0);
    assert.ok(PATH_BIKE_PAINT_LIFT_M <= 0.01);
});
