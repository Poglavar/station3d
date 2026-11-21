import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CITY_CENTRE_POINTER_PATH,
    cityCentreGuideTopPx,
    routeOverlayTopPx,
    cityCentreGuidance,
    formatGuidanceDistance,
    minimapMarkerPlacement,
    minimapPointToScreen,
    minimapViewportNeedsRecenter,
    minimapViewportTransform,
    minimapFollowSpan,
    MINIMAP_FOLLOW_SPANS_M,
    navigationWaypointsFor,
    skipRecedingWaypoint,
} from '../core/navigation-guidance.js';

test('walking minimap keeps a six-kilometre player-centred window', () => {
    const transform = minimapViewportTransform({
        centerX: 1200,
        centerZ: -800,
        halfSpanM: 3000,
        size: 148,
        padding: 10,
    });
    assert.deepEqual(minimapPointToScreen(transform, 1200, -800), { sx: 74, sy: 74 });
    assert.deepEqual(minimapPointToScreen(transform, -1800, -800), { sx: 10, sy: 74 });
    assert.deepEqual(minimapPointToScreen(transform, 4200, -800), { sx: 138, sy: 74 });
    assert.equal(minimapViewportNeedsRecenter({
        centerX: 1200,
        centerZ: -800,
        playerX: 1319,
        playerZ: -800,
        thresholdM: 120,
    }), false);
    assert.equal(minimapViewportNeedsRecenter({
        centerX: 1200,
        centerZ: -800,
        playerX: 1320,
        playerZ: -800,
        thresholdM: 120,
    }), true);
});

test('minimap marker keeps the live heading while it is inside the route extent', () => {
    assert.deepEqual(minimapMarkerPlacement({
        sx: 40,
        sy: 50,
        headingDeg: 123,
        size: 148,
        padding: 10,
    }), {
        sx: 40,
        sy: 50,
        rotationDeg: 123,
        offMap: false,
    });
});

test('off-map marker is clamped to the correct edge and points toward the player', () => {
    const east = minimapMarkerPlacement({
        sx: 300,
        sy: 74,
        headingDeg: 0,
        size: 148,
        padding: 10,
    });
    assert.equal(east.sx, 138);
    assert.equal(east.sy, 74);
    assert.equal(east.rotationDeg, 90);
    assert.equal(east.offMap, true);

    const northwest = minimapMarkerPlacement({
        sx: -126,
        sy: -26,
        size: 148,
        padding: 10,
    });
    assert.equal(northwest.sx, 10);
    assert.ok(northwest.sy > 10 && northwest.sy < 74);
    assert.ok(northwest.rotationDeg < 0);
});

test('city-centre arrow is relative to the viewer heading', () => {
    const north = cityCentreGuidance({
        x: 0,
        z: 100,
        headingDeg: 0,
        targetX: 0,
        targetZ: 0,
    });
    assert.equal(north.bearingDeg, 0);
    assert.equal(north.relativeBearingDeg, 0);
    assert.equal(north.distanceM, 100);

    const centreToRight = cityCentreGuidance({
        x: 0,
        z: 100,
        headingDeg: 270,
        targetX: 0,
        targetZ: 0,
    });
    assert.equal(centreToRight.relativeBearingDeg, 90);
});

test('guidance distance stays compact', () => {
    assert.equal(formatGuidanceDistance(324), '320 m');
    assert.equal(formatGuidanceDistance(1825), '1.8 km');
    assert.equal(formatGuidanceDistance(12825), '13 km');
});

test('walk guidance stacks below the complete speed and altitude row', () => {
    assert.equal(cityCentreGuideTopPx({ walkMode: false }), 12);
    assert.equal(cityCentreGuideTopPx({
        walkMode: true,
        routeTopPx: 14,
        routeHeightPx: 40,
        gapPx: 8,
    }), 62);
    assert.equal(cityCentreGuideTopPx({
        walkMode: true,
        routeTopPx: 14,
        routeHeightPx: 88,
        gapPx: 8,
    }), 110, 'a wrapped route row must push the guide down with it');
});

test('city-centre guide uses a directional pointer with a long shaft', () => {
    assert.equal(CITY_CENTRE_POINTER_PATH, 'M10 1 L18 10 H13 V23 H7 V10 H2 Z');
});

// Boarding a vehicle drops walkMode, but the route overlay then carries the
// vehicle line, and the bearing pill used to jump onto it.
test('the guide pill stacks under a visible route overlay in a vehicle, not only on foot', () => {
    assert.equal(cityCentreGuideTopPx({ walkMode: false, routeVisible: true, routeTopPx: 14, routeHeightPx: 64 }), 86);
    assert.equal(cityCentreGuideTopPx({ walkMode: false, routeVisible: false }), 12);
    assert.equal(cityCentreGuideTopPx({ walkMode: true, routeVisible: false, routeTopPx: 14, routeHeightPx: 40 }), 62);
});

// The three centred pills are one column: vehicle status, readouts, bearing.
test('the readouts stack under the vehicle status pill and the bearing under them', () => {
    assert.equal(routeOverlayTopPx({ statusVisible: false }), 14);
    assert.equal(routeOverlayTopPx({ statusVisible: true, statusTopPx: 12, statusHeightPx: 32 }), 52);
    // A taller prompt pushes the column down rather than colliding with it.
    assert.equal(routeOverlayTopPx({ statusVisible: true, statusTopPx: 22, statusHeightPx: 48 }), 78);
    assert.equal(routeOverlayTopPx({ statusVisible: true, statusTopPx: Number.NaN, statusHeightPx: undefined }), 52);
    // A phone stacks the readouts under a reserved status band: the same top
    // with and without a prompt, whatever the prompt's height.
    assert.equal(routeOverlayTopPx({ statusVisible: false, statusTopPx: 22, stackedBandPx: 38 }), 60);
    assert.equal(routeOverlayTopPx({ statusVisible: true, statusTopPx: 22, statusHeightPx: 48, stackedBandPx: 38 }), 60);
    assert.equal(routeOverlayTopPx({ statusVisible: true, statusTopPx: 12, statusHeightPx: 32, stackedBandPx: 0 }), 52);
    const routeTop = routeOverlayTopPx({ statusVisible: true, statusTopPx: 12, statusHeightPx: 32 });
    assert.ok(cityCentreGuideTopPx({ routeVisible: true, routeTopPx: routeTop, routeHeightPx: 40 }) > routeTop + 40);
});


test('nearby guidance shows individual metres instead of a false zero', () => {
    assert.equal(formatGuidanceDistance(4.1), '5 m');
    assert.equal(formatGuidanceDistance(3.6), '4 m');
    assert.equal(formatGuidanceDistance(0.3), '1 m');
    assert.equal(formatGuidanceDistance(0), '1 m');
    assert.equal(formatGuidanceDistance(19), '19 m');
});

test('the follow minimap widens to coastline scale in an aircraft and re-centres in steps that scale with the window', () => {
    const walk = minimapFollowSpan({ vehicleKind: 'road' });
    assert.deepEqual(walk, { halfSpanM: 250, recenterM: 60 });
    const air = minimapFollowSpan({ vehicleKind: 'aircraft' });
    assert.equal(air.halfSpanM, MINIMAP_FOLLOW_SPANS_M.aircraft);
    assert.ok(air.halfSpanM >= 1000, 'a plane at 77 m/s needs a kilometre-scale window');
    assert.equal(air.recenterM, 180, 'twelve percent of the window: a re-centre every two seconds, not every 60 m');
    // Docking and leaving a vehicle still zoom in, whatever the vehicle was.
    assert.equal(minimapFollowSpan({ vehicleKind: 'aircraft', vehicleExitTarget: true }).halfSpanM, 24);
    assert.equal(minimapFollowSpan({ vehicleKind: 'boat', nearBoatDestination: true }).halfSpanM, 60);
});

test('a cue the walker has left behind is abandoned for the nearest one ahead', () => {
    // Forecourt 38 m south of the spawn, then a line that runs north.
    const waypoints = [
        { x: 0, z: 38, radiusM: 8 },     // ISPRED KOLODVORA, behind a player walking north
        { x: -20, z: -250, radiusM: 14 },
        { x: -40, z: -600, radiusM: 14 },
    ];
    // Standing still or within four radii: nothing changes.
    assert.equal(skipRecedingWaypoint(waypoints, 0, { x: 0, z: 0 }, { x: 0, z: 0 }), 0);
    assert.equal(skipRecedingWaypoint(waypoints, 0, { x: 0, z: -20 }, { x: 0, z: -10 }), 0, 'still within reach of the cue');
    // Walking north, 80 m past it and still nearer to it than to any later cue: keep it.
    assert.equal(skipRecedingWaypoint(waypoints, 0, { x: 0, z: -40 }, { x: 0, z: -30 }), 0);
    // Once a later cue is nearer, the pill jumps forward, never back.
    assert.equal(skipRecedingWaypoint(waypoints, 0, { x: -10, z: -150 }, { x: -8, z: -140 }), 1);
    assert.equal(skipRecedingWaypoint(waypoints, 1, { x: -30, z: -500 }, { x: -28, z: -480 }), 2);
    assert.equal(skipRecedingWaypoint(waypoints, 2, { x: 0, z: 0 }, { x: 0, z: -10 }), 2, 'approaching is not receding');
});

test('the pedestrian cue line is used on foot and the driving line in a vehicle', () => {
    const target = { waypoints: [{ x: 1 }], walkWaypoints: [{ x: 2 }] };
    assert.deepEqual(navigationWaypointsFor(target, { driving: true }), [{ x: 1 }]);
    assert.deepEqual(navigationWaypointsFor(target, { driving: false }), [{ x: 2 }]);
    assert.deepEqual(navigationWaypointsFor({ waypoints: [{ x: 1 }] }, { driving: false }), [{ x: 1 }], 'no walk line: the driving line serves both');
    assert.deepEqual(navigationWaypointsFor(null), []);
});
