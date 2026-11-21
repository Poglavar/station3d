// Locks Project 77's portal adapter and the model world's curved-station fallback.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import {
    buildModelCoveredStationPlan,
    buildModelRunningTunnelSection,
    getModelStationPortalAdapter,
    MODEL_COVERED_STATION_OVERLAP_M,
    modelStationNeedsCoveredRoute,
} from '../core/model-covered-station.js';
import {
    prepareStationTrackRoutes,
    resolvePlannerStationTrackAnchor,
} from '../core/planner-station-track-anchor.js';
import {
    PLANNER_TUNNEL_CLEARANCE_M,
    PLANNER_TUNNEL_FLOOR_WIDTH_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
} from '../world/planner-station-layout.js';

const STARI_TERMINAL = {
    lat: 45.73222997152455,
    lon: 16.06086236674093,
};

// Production Project 77 route vertices around Stari terminal, in route order.
const PROJECT_77_ROUTE = [
    [45.72707904721534, 16.05488777160645],
    [45.729101189986935, 16.05658292770386],
    [45.730299462270715, 16.057741641998295],
    [45.73119814961333, 16.05935096740723],
    [45.731857177807655, 16.06031656265259],
    [45.73310826286486, 16.062148265570674],
    [45.73414873804048, 16.0641360282898],
    [45.734807731417966, 16.06561660766602],
    [45.73516717907353, 16.066431999206547],
    [45.73557155492053, 16.066925525665287],
    [45.73650011059822, 16.06711864471436],
];

function project77Anchor() {
    const anchorLat = STARI_TERMINAL.lat;
    const anchorLon = STARI_TERMINAL.lon;
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = metersPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const properties = {
        trackId: 77,
        trackType: 'g1435',
        trackCount: 2,
    };
    const points = PROJECT_77_ROUTE.map(([lat, lon]) => ({
        x: (lon - anchorLon) * scaleLon,
        y: 0,
        z: -(lat - anchorLat) * metersPerDegree,
        lon,
        lat,
        relativeHeightM: 0,
    }));
    const routes = prepareStationTrackRoutes([{
        routeKey: 'project-77',
        trackId: 77,
        trackIds: [77],
        properties,
        usesPhotoFrame: false,
        points,
    }]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 0,
        stopZ: 0,
        stopTrackId: 77,
        usePhotoFrame: false,
        routes,
        tangentHalfSpanM: 12,
    });
    return { anchor, properties };
}

test('Project 77 rigid station receives a gauge-derived model portal adapter', () => {
    const { anchor, properties } = project77Anchor();
    assert.ok(anchor);
    assert.equal(modelStationNeedsCoveredRoute(anchor), false);
    const adapter = getModelStationPortalAdapter(properties);
    assert.equal(adapter.openingHalfWidthM, PLANNER_TUNNEL_FLOOR_WIDTH_M * 0.5);
    assert.equal(adapter.openingTopY, PLANNER_TUNNEL_CLEARANCE_M);
    assert.ok(
        adapter.boreHalfWidthM - adapter.openingHalfWidthM > 3,
        'adapter must close the wide side annulus visible in Project 77',
    );
    assert.ok(
        adapter.boreRoofY - adapter.openingTopY > 0.7,
        'adapter must close the lintel gap above the compact throat',
    );
});

test('a genuinely curved model station receives a sealed route-following hall', () => {
    const properties = { trackId: 77, trackType: 'g1435', trackCount: 2 };
    const routes = prepareStationTrackRoutes([{
        routeKey: 'curved-model-station',
        trackId: 77,
        trackIds: [77],
        properties,
        usesPhotoFrame: false,
        points: [
            { x: -140, y: 0, z: -35 },
            { x: -55, y: 0, z: -30 },
            { x: 0, y: 0, z: 0 },
            { x: 55, y: 0, z: 30 },
            { x: 140, y: 0, z: 35 },
        ],
    }]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 0,
        stopZ: 0,
        stopTrackId: 77,
        usePhotoFrame: false,
        routes,
        tangentHalfSpanM: 12,
    });
    assert.equal(modelStationNeedsCoveredRoute(anchor), true);
    const plan = buildModelCoveredStationPlan(anchor, {
        platformSideM: 5.02,
        stationName: 'Curved station',
        stationId: 'curved-station',
        trackProperties: properties,
    });
    assert.ok(plan);
    assert.equal(plan.stationId, 'curved-station');
    assert.ok(plan.alignment.driftM > 0.5, `drift=${plan.alignment.driftM}`);
    assert.ok(plan.alignment.tangentErrorDeg > 1, `tangent=${plan.alignment.tangentErrorDeg}`);
    assert.ok(
        plan.endM - plan.startM
            >= UNDERGROUND_STATION_TOTAL_LENGTH_M + MODEL_COVERED_STATION_OVERLAP_M * 2 - 0.01,
    );
    assert.ok(plan.sweep.shell.positions.length > 0);
    assert.ok(plan.sweep.shell.indices.length > 0);
    assert.ok(plan.sweep.platform.positions.length > 0);
    assert.equal(plan.sweep.nameBoard.label, 'Curved station');
    assert.ok(plan.sweep.wallColliders.length > 0);

    const endpoint = buildModelRunningTunnelSection(properties);
    const firstSection = plan.sweep.rings[0].section;
    const lastSection = plan.sweep.rings.at(-1).section;
    for (const key of [
        'wallCenterM',
        'wallThicknessM',
        'roofBottomOffsetM',
        'floorTopOffsetM',
    ]) {
        assert.ok(Math.abs(firstSection[key] - endpoint[key]) < 1e-9, key);
        assert.ok(Math.abs(lastSection[key] - endpoint[key]) < 1e-9, key);
    }
    assert.ok(
        endpoint.wallCenterM - endpoint.wallThicknessM * 0.5 > 6,
        'g1435 double-track endpoint must meet the wide running bore',
    );
});

test('a straight level station keeps the established rigid island hall', () => {
    const properties = { trackId: 1, trackType: 'g1435', trackCount: 2 };
    const routes = prepareStationTrackRoutes([{
        trackId: 1,
        trackIds: [1],
        properties,
        usesPhotoFrame: false,
        points: [
            { x: -200, y: 0, z: 0 },
            { x: 200, y: 0, z: 0 },
        ],
    }]);
    const anchor = resolvePlannerStationTrackAnchor({
        stopX: 0,
        stopZ: 0,
        stopTrackId: 1,
        usePhotoFrame: false,
        routes,
    });
    assert.equal(modelStationNeedsCoveredRoute(anchor), false);
    assert.equal(buildModelCoveredStationPlan(anchor, {
        platformSideM: 5,
        trackProperties: properties,
    }), null);
});
