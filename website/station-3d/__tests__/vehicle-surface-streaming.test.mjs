import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    ROUTED_VEHICLE_SURFACE_STREAMING,
    VEHICLE_SURFACE_STREAMING,
    routedVehicleSurfaceStreamingFocus,
    vehicleSurfaceGenerationCenter,
    vehicleSurfaceLeadM,
    vehicleSurfaceStreamingGeoTarget,
    vehicleSurfaceStreamingFocus,
} from '../core/vehicle-surface-streaming.js';
import { createSharedTileSession } from '../core/shared-tile-session.js';

function close(actual, expected, tolerance = 1e-6) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`,
    );
}

test('stationary vehicles keep the predictive surface focus at current support', () => {
    const focus = vehicleSurfaceStreamingFocus({
        local: { x: 12, z: -8 },
        vehiclePose: { speedMps: 0, headingDeg: 270 },
    });
    assert.deepEqual(focus, {
        x: 12,
        z: -8,
        headingDeg: 270,
        leadM: 0,
        speedMps: 0,
    });
});

test('measured velocity projects terrain and road work down the travel corridor', () => {
    const focus = vehicleSurfaceStreamingFocus({
        local: { x: 10, z: 20 },
        headingDeg: 90,
        vehiclePose: {
            speedMps: 20,
            velocityX: 0,
            velocityZ: -20,
        },
    });
    const brakingDistanceM = 20 * 20
        / (2 * VEHICLE_SURFACE_STREAMING.brakingDecelerationMps2);
    const expectedLeadM = 20 * VEHICLE_SURFACE_STREAMING.lookAheadSeconds
        + VEHICLE_SURFACE_STREAMING.baseLeadM
        + brakingDistanceM * VEHICLE_SURFACE_STREAMING.brakingDistanceShare;
    close(focus.x, 10);
    close(focus.z, 20 - expectedLeadM);
    close(focus.leadM, expectedLeadM);
    close(focus.headingDeg, 0);
});

test('measured sideways motion wins over bonnet heading and high speed is capped', () => {
    const focus = vehicleSurfaceStreamingFocus({
        local: { x: 0, z: 0 },
        headingDeg: 0,
        vehiclePose: {
            speedMps: 100,
            velocityX: 100,
            velocityZ: 0,
        },
    });
    close(focus.x, VEHICLE_SURFACE_STREAMING.maximumLeadM);
    close(focus.z, 0);
    close(focus.headingDeg, 90);
    close(focus.leadM, VEHICLE_SURFACE_STREAMING.maximumLeadM);
});

test('reverse motion projects behind the vehicle when no velocity vector is available', () => {
    const focus = vehicleSurfaceStreamingFocus({
        local: { x: 0, z: 0 },
        headingDeg: 0,
        vehiclePose: { speedMps: -10 },
    });
    close(focus.x, 0);
    assert.ok(focus.z > 0);
    close(focus.headingDeg, 180);
});

test('a routed vehicle uses a longer bounded construction lead and follows the route', () => {
    const speedMps = 70 / 3.6;
    const sampledOffsets = [];
    const focus = routedVehicleSurfaceStreamingFocus({
        local: { x: 10, z: 20 },
        speedMps,
        headingDeg: 0,
        sampleRouteLocal(offsetM) {
            sampledOffsets.push(offsetM);
            // Model a bend: the exact route point is east of the train even
            // though its current heading points north.
            return { x: 510, z: -30, headingDeg: 90 };
        },
    });
    const expectedLeadM = vehicleSurfaceLeadM(
        speedMps,
        ROUTED_VEHICLE_SURFACE_STREAMING,
    );
    close(sampledOffsets[0], expectedLeadM);
    assert.ok(expectedLeadM > 780 && expectedLeadM < 820,
        `70 km/h route lead should be about 800 metres, got ${expectedLeadM}`);
    assert.ok(expectedLeadM / speedMps > 40,
        `70 km/h route lead should cover more than 40 seconds, got ${expectedLeadM / speedMps}`);
    assert.deepEqual(focus, {
        x: 510,
        z: -30,
        headingDeg: 90,
        leadM: expectedLeadM,
        speedMps,
    });
});

test('routed reverse travel samples behind and turns the streaming heading around', () => {
    let sampledOffset = 0;
    const focus = routedVehicleSurfaceStreamingFocus({
        local: { x: 0, z: 0 },
        speedMps: -5,
        headingDeg: 30,
        sampleRouteLocal(offsetM) {
            sampledOffset = offsetM;
            return { x: -20, z: 5, headingDeg: 40 };
        },
    });
    assert.ok(sampledOffset < 0);
    assert.equal(focus.headingDeg, 220);
});

test('the atomic generation centre spans current support and the predictive focus', () => {
    assert.deepEqual(vehicleSurfaceGenerationCenter(
        { x: 100, z: -50 },
        { x: 900, z: 350, leadM: 800 },
    ), { x: 500, z: 150 });
    assert.deepEqual(vehicleSurfaceGenerationCenter({ x: 12, z: -8 }, null), { x: 12, z: -8 });
});

test('geographic surface sources follow the shared route-ahead focus', () => {
    const current = vehicleSurfaceStreamingGeoTarget({
        pose: { lat: 43.5, lon: 16.4 },
        anchorLat: 43.5,
        anchorLon: 16.4,
    });
    assert.deepEqual(current, { lat: 43.5, lon: 16.4 });

    const ahead = vehicleSurfaceStreamingGeoTarget({
        pose: {
            lat: 43.5,
            lon: 16.4,
            surfaceStreamingFocus: { x: 800, z: -400 },
        },
        anchorLat: 43.5,
        anchorLon: 16.4,
    });
    assert.ok(ahead.lon > current.lon);
    assert.ok(ahead.lat > current.lat);
});

test('shared tile sources retain current support while prioritizing the projected point', () => {
    const controller = new AbortController();
    const session = createSharedTileSession({
        anchorLat: 45.81,
        anchorLon: 15.98,
        fetchController: controller,
    });
    try {
        const source = session.getSource({
            key: 'roads:dual-anchor-test',
            url: () => '/never',
            ring: 0,
            keepRing: 3,
            prioritizeByView: true,
            maxConcurrentRequests: 1,
        });
        source.ensureAround(10, 10);
        source.ensureAhead(450, 10, 90, { distanceM: 0 });
        // A later shared-source sibling (passages/rails/decor) updates the
        // current support ring but must not erase the ahead owner's focus.
        source.ensureAround(10, 10, { headingDeg: 180 });

        assert.equal(source.tileViewPriority({ tx: 0, tz: 0 }).tier, 'support');
        assert.equal(source.tileViewPriority({ tx: 2, tz: 0 }).tier, 'support');
        const debug = source.getDebugState();
        assert.deepEqual(debug.supportFocus, { x: 10, z: 10 });
        assert.deepEqual(debug.priorityFocus, { x: 450, z: 10 });
    } finally {
        controller.abort();
        session.abort();
    }
});

test('cab and every ground layer share prediction plus authored corridor preload', async () => {
    const [cab, gta, terrain, roads, curbs, markings, water] = await Promise.all([
        readFile(new URL('../modes/cab.js', import.meta.url), 'utf8'),
        readFile(new URL('../modes/gta.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/terrain.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/roads.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/curbs.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/lane-markings.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/water.js', import.meta.url), 'utf8'),
    ]);
    assert.match(cab, /vehicleSurfaceStreamingFocus/);
    assert.match(cab, /routedVehicleSurfaceStreamingFocus/);
    assert.match(cab, /sampleDriverStateAtOffset/);
    assert.match(cab, /vehicleSurfaceGenerationCenter\(local, surfaceStreamingFocus\)/,
        'the bounded atomic ground compositor spans current support and its route-ahead focus');
    assert.match(cab, /noteWorldQueueActive\('drive-surface'\)/);
    assert.match(cab, /campaignDrivePreloadReadiness/);
    assert.doesNotMatch(gta, /vehicleSurfaceRunway|speedLimitMps/);
    assert.match(terrain, /pose\?\.surfaceStreamingFocus/);
    assert.match(terrain, /pose\?\.surfaceStreamingPreload/);
    assert.match(roads, /const streamingFocus = pose\?\.surfaceStreamingFocus \|\| local/);
    assert.match(roads, /ensurePinnedSurfaceCorridor/);
    assert.match(curbs, /const streamingFocus = pose\?\.surfaceStreamingFocus \|\| local/);
    assert.match(curbs, /ensurePinnedPoints/);
    assert.match(markings, /const streamingFocus = pose\?\.surfaceStreamingFocus \|\| local/);
    assert.match(markings, /ensurePinnedPoints/);
    assert.match(water, /vehicleSurfaceStreamingGeoTarget/,
        'mapped coastline fetches should begin at the shared route-ahead focus');
});
