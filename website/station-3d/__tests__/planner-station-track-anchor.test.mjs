// Verifies each planner station receives one rendered-route centre, tangent
// and elevation sample, including at rounded corners and nearby crossings.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MIN_STATION_TRACK_CHORD_M,
    prepareStationTrackRoutes,
    prepareStationTrackRoutesFromSegments,
    resolvePlannerStationTrackAnchor,
    splitStationTrackRouteBySegmentOwners,
    stationTrackRouteMatches,
} from '../core/planner-station-track-anchor.js';

function route(overrides = {}) {
    return {
        trackId: 7,
        usesPhotoFrame: true,
        points: [
            { x: 0, y: 20, z: 0, relativeHeightM: 100, lon: 16, lat: 43 },
            { x: 10, y: 30, z: 0, relativeHeightM: 110, lon: 16.001, lat: 43.001 },
        ],
        ...overrides,
    };
}

test('one projected sample owns station position, tangent and elevation', () => {
    const routes = prepareStationTrackRoutes([route()]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 4,
        stopZ: 3,
        stopTrackId: 7,
        usePhotoFrame: true,
        routes,
    });
    assert.equal(anchor.x, 4);
    assert.equal(anchor.z, 0);
    assert.equal(anchor.y, 24);
    assert.equal(anchor.relativeHeightM, 104);
    assert.equal(anchor.lon, 16.0004);
    assert.equal(anchor.lat, 43.0004);
    assert.equal(anchor.alongX, 1);
    assert.equal(anchor.alongZ, 0);
    assert.equal(Math.abs(anchor.rightX), 0);
    assert.equal(anchor.rightZ, 1);
    assert.equal(anchor.distanceM, 3);
});

test('an explicit station track cannot borrow a nearer crossing route', () => {
    const routes = prepareStationTrackRoutes([
        route({
            trackId: null,
            trackIds: ['other'],
            points: [{ x: 5, y: 90, z: -5 }, { x: 5, y: 90, z: 5 }],
        }),
        route(),
    ]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 5,
        stopZ: 0.1,
        stopTrackId: 7,
        routes,
    });
    assert.equal(anchor.route.trackId, 7);
    assert.equal(anchor.y, 25);
    assert.equal(anchor.alongX, 1);
});

test('saved tangent-intersection station snaps even beyond the old 12 metre gate', () => {
    const routes = prepareStationTrackRoutes([route({
        points: [{ x: 0, z: 0 }, { x: 50, z: 0 }],
    })]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 25,
        stopZ: 18,
        stopTrackId: 7,
        routes,
    });
    assert.equal(anchor.x, 25);
    assert.equal(anchor.z, 0);
    assert.equal(anchor.distanceM, 18);
});

test('a centred route tangent is stable when the nearest chord is a tiny turn', () => {
    const routes = prepareStationTrackRoutes([route({
        points: [
            { x: 0, z: 0 },
            { x: 9.9, z: 0 },
            { x: 10, z: 0.1 },
            { x: 10.1, z: 10 },
        ],
    })]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 10,
        stopZ: 0.1,
        stopTrackId: 7,
        routes,
        tangentHalfSpanM: 5,
    });
    assert.ok(anchor.alongX > 0.6, `alongX=${anchor.alongX}`);
    assert.ok(anchor.alongZ > 0.6, `alongZ=${anchor.alongZ}`);
});

test('reversing the route preserves the rigid station axis modulo 180 degrees', () => {
    const points = [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
    ];
    const forward = resolvePlannerStationTrackAnchor({
        stopX: 10,
        stopZ: 0,
        stopTrackId: 7,
        routes: prepareStationTrackRoutes([route({ points })]),
        tangentHalfSpanM: 6,
    });
    const reverse = resolvePlannerStationTrackAnchor({
        stopX: 10,
        stopZ: 0,
        stopTrackId: 7,
        routes: prepareStationTrackRoutes([route({ points: [...points].reverse() })]),
        tangentHalfSpanM: 6,
    });
    const axisDot = forward.alongX * reverse.alongX + forward.alongZ * reverse.alongZ;
    assert.ok(Math.abs(axisDot) > 0.999999, `axis dot=${axisDot}`);
});

test('legacy proximity gates remain available for stations without ownership', () => {
    const routes = prepareStationTrackRoutes([route({ trackId: null, trackIds: [] })]);
    assert.equal(stationTrackRouteMatches(routes[0], 7), false);
    assert.equal(resolvePlannerStationTrackAnchor({
        stopX: 5,
        stopZ: 3,
        routes,
        maxSnapDistanceM: 2,
    }), null);
});

test('segment ownership prevents a combined feature from lending a perpendicular branch', () => {
    const pieces = splitStationTrackRouteBySegmentOwners(route({
        trackId: null,
        trackIds: [7, 8],
        segmentTrackIds: [7, 8],
        points: [
            { x: 0, z: 0 },
            { x: 10, z: 0 },
            { x: 10, z: 10 },
        ],
    }));
    const routes = prepareStationTrackRoutes(pieces);
    const firstTrack = resolvePlannerStationTrackAnchor({
        stopX: 10,
        stopZ: 1,
        stopTrackId: 7,
        routes,
    });
    assert.equal(firstTrack.route.trackId, '7');
    assert.equal(firstTrack.alongX, 1);
    assert.equal(firstTrack.alongZ, 0);
});

test('sub-0.75 metre fillet chords preserve the sampled curve anchor', () => {
    const radiusM = 10;
    const points = Array.from({ length: 21 }, (_, index) => {
        const theta = -0.6 + index * 0.06;
        return {
            x: radiusM * Math.cos(theta),
            y: 20,
            z: radiusM * Math.sin(theta),
            relativeHeightM: 90,
        };
    });
    const segments = points.slice(0, -1).map((start, routeOrder) => {
        const end = points[routeOrder + 1];
        return {
            routeKey: 'sampled-curve',
            routeOrder,
            trackId: 7,
            properties: { trackId: 7 },
            usesPhotoTrackFrame: true,
            start,
            end,
            length: Math.hypot(end.x - start.x, end.z - start.z),
        };
    });
    assert.ok(segments.every(segment => segment.length < 0.75));
    assert.ok(segments.every(segment => segment.length > MIN_STATION_TRACK_CHORD_M));

    const routes = prepareStationTrackRoutesFromSegments(segments);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].points.length, points.length);
    const stationPoint = points[15]; // theta = 0.3 rad
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: stationPoint.x,
        stopZ: stationPoint.z,
        stopTrackId: 7,
        usePhotoFrame: true,
        routes,
        tangentHalfSpanM: 1.5,
    });
    const expectedX = -Math.sin(0.3);
    const expectedZ = Math.cos(0.3);
    const tangentDot = anchor.alongX * expectedX + anchor.alongZ * expectedZ;
    assert.ok(tangentDot > 0.999, `tangent dot=${tangentDot}`);
});
