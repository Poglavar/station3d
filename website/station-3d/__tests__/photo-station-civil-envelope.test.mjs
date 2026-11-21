// Verifies photo stations own one classified route envelope, mask and structure.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyPhotoStationCivilOwnership,
    buildPhotoStationCivilEnvelopes,
    buildPhotoStationMaskQuads,
    measurePhotoStationRouteAlignment,
    PHOTO_COVERED_STATION_ROOF_OFFSET_M,
    photoStationHasRigidCover,
    photoStationRuntimeStructure,
    photoStationSourceOwnershipAt,
    photoStationSupportsRigidStructure,
    resolvePhotoStationStructures,
} from '../core/photo-station-civil-envelope.js';
import { prepareStationTrackRoutes } from '../core/planner-station-track-anchor.js';

function routes() {
    return prepareStationTrackRoutes([{
        routeRunId: 'main',
        trackId: 54,
        usesPhotoFrame: true,
        properties: { trackId: 54, trackCount: 2, trackType: 'g1435' },
        points: [
            { x: -150, y: 20, z: 0, relativeHeightM: 90 },
            { x: 150, y: 20, z: 0, relativeHeightM: 90 },
        ],
    }]);
}

function stationEnvelope() {
    return buildPhotoStationCivilEnvelopes({
        stops: [{ stopId: 's', trackId: 54, level: 0 }],
        routes: routes(),
        locateStop: () => ({ x: 0, z: 0 }),
    })[0];
}

function chunk(x0, x1, structure, trackId = 54, routeRunId = 'main') {
    return {
        x0, z0: 0, ty0: 20,
        x1, z1: 0, ty1: 20,
        mx: (x0 + x1) * 0.5,
        mz: 0,
        ty: 20,
        ux: 1, uz: 0, px: 0, pz: 1,
        spanLen: x1 - x0,
        trackId,
        routeRunId,
        structure,
        surfaceL0: 42, surfaceL: 42, surfaceL1: 42,
        surfaceR0: 42, surfaceR: 42, surfaceR1: 42,
        groundL: 40, groundR: 40, groundC: 40,
        dguGroundY: 40,
    };
}

test('stored level zero adopts the runtime tunnel regime at its canonical anchor', () => {
    const envelope = stationEnvelope();
    const resolved = resolvePhotoStationStructures([
        chunk(-12, 0, 'tunnel'),
        chunk(0, 12, 'tunnel'),
    ], [envelope]);
    assert.deepEqual(resolved.get('id:s'), {
        structure: 'tunnel',
        terrainStructure: 'tunnel',
        openCutFallback: false,
        compactCovered: false,
        stationForm: 'underground-full',
        groundY: 40,
    });
});

test('a straight station with insufficient earth over its source roof uses the covered form', () => {
    const envelope = stationEnvelope();
    assert.equal(photoStationHasRigidCover(envelope, 30.79), false);
    assert.equal(photoStationHasRigidCover(envelope, 30.8), true);

    const shallow = chunk(-12, 12, 'tunnel');
    shallow.groundC = 30.67;
    shallow.dguGroundY = 30.2;
    const resolved = resolvePhotoStationStructures([shallow], [envelope]);
    assert.deepEqual(resolved.get('id:s'), {
        structure: 'formation',
        terrainStructure: 'tunnel',
        openCutFallback: true,
        compactCovered: true,
        stationForm: 'compact-covered',
        groundY: 30.67,
    });
    applyPhotoStationCivilOwnership([shallow], [envelope], resolved);
    assert.equal(envelope.openCutFallback, true);
    assert.equal(photoStationSupportsRigidStructure(envelope, 'tunnel'), false);
});

test('a station too shallow for the compact roof becomes an open cut', () => {
    const envelope = stationEnvelope();
    const shallow = chunk(-12, 12, 'tunnel');
    shallow.groundC = 28.5;
    shallow.dguGroundY = 28.5;
    const decision = resolvePhotoStationStructures([shallow], [envelope]).get('id:s');
    assert.equal(decision.stationForm, 'open-cut');
    assert.equal(decision.compactCovered, false);
    assert.equal(decision.openCutFallback, true);
    assert.equal(photoStationRuntimeStructure(decision, decision.structure), 'formation');
});

test('station hall exactly replaces generic tunnel pieces and keeps portals outside', () => {
    const envelope = stationEnvelope();
    const chunks = [
        chunk(-120, -60, 'tunnel'),
        chunk(-60, 60, 'tunnel'),
        chunk(60, 120, 'tunnel'),
    ];
    const resolved = new Map([['id:s', { structure: 'tunnel', groundY: 40 }]]);
    const owned = applyPhotoStationCivilOwnership(chunks, [envelope], resolved);
    const station = owned.filter(piece => piece.structure === 'station-underground');
    assert.equal(station[0].x0, -85.5);
    assert.equal(station.at(-1).x1, 85.5);
    assert.ok(owned.filter(piece => piece.structure === 'tunnel')
        .every(piece => piece.x1 <= -85.5 || piece.x0 >= 85.5));
});

test('elevated station mask reaches its side lift and widens its deck under platform', () => {
    const envelope = stationEnvelope();
    const resolved = new Map([['id:s', { structure: 'viaduct', groundY: 0 }]]);
    const [owned] = applyPhotoStationCivilOwnership(
        [chunk(-10, 10, 'viaduct')],
        [envelope],
        resolved,
    );
    assert.equal(owned.structure, 'station-viaduct');
    assert.ok(owned.stationOwner.maskRightMaxM > 13);
    assert.ok(owned.stationOwner.deckRightMaxM > 5.5);
    assert.equal(owned.stationOwner.deckRightMinM, -4);

    const mask = buildPhotoStationMaskQuads([envelope], { encodeFloor: y => y / 100 });
    const zs = mask.ownership.positions.filter((_, index) => index % 3 === 2);
    assert.ok(Math.max(...zs) > 13);
    assert.equal(mask.openings.positions.length, 0);
});

test('underground hall is green source ownership with red stair openings', () => {
    const envelope = stationEnvelope();
    envelope.effectiveStructure = 'tunnel';
    envelope.groundY = 40;
    const mask = buildPhotoStationMaskQuads([envelope], {
        encodeFloor: y => y / 100,
        tunnelSourceRoofOffsetM: 7.45,
    });
    assert.equal(mask.ownership.positions.length, 18);
    assert.equal(mask.openings.positions.length, 36);
    assert.ok(mask.ownership.colors.filter((_, index) => index % 3 === 1)
        .every(value => value === 1));
    assert.ok(mask.openings.colors.filter((_, index) => index % 3 === 1)
        .every(value => value === 0));

    assert.equal(photoStationSourceOwnershipAt([envelope], 0, 0).mode, 'station-core');
    const stair = photoStationSourceOwnershipAt([envelope], 22, 10.8);
    assert.equal(stair.mode, 'open');
    assert.equal(stair.floorY, 20);
});

test('nearby crossing with another segment owner cannot borrow station ownership', () => {
    const envelope = stationEnvelope();
    const resolved = new Map([['id:s', { structure: 'viaduct', groundY: 0 }]]);
    const owned = applyPhotoStationCivilOwnership([
        chunk(-6, 6, 'viaduct', 99, 'main'),
    ], [envelope], resolved);
    assert.ok(owned.every(piece => piece.stationOwner == null));
    assert.ok(owned.every(piece => piece.structure === 'viaduct'));
});

test('curved tunnel stop gets a compact covered route instead of a terrain-height cut', () => {
    const curvedRoutes = prepareStationTrackRoutes([{
        routeRunId: 'curve',
        trackId: 54,
        usesPhotoFrame: true,
        properties: { trackId: 54, trackCount: 2, trackType: 'g1435' },
        points: [
            { x: -120, y: 20, z: 0 },
            { x: 0, y: 20, z: 0 },
            { x: 0, y: 20, z: 120 },
        ],
    }]);
    const envelope = buildPhotoStationCivilEnvelopes({
        stops: [{ stopId: 'curve-stop', name: 'Stanica Krivina', trackId: 54, level: 0 }],
        routes: curvedRoutes,
        locateStop: () => ({ x: 0, z: 0 }),
    })[0];
    assert.ok(envelope.tunnelAlignment.driftM > 0.5);
    assert.ok(envelope.tunnelAlignment.tangentErrorDeg > 1);
    assert.equal(envelope.tunnelAlignment.coverageOk, true);
    assert.equal(envelope.tunnelAlignment.ok, false);

    const horizontalArm = chunk(-30, 0, 'tunnel', 54, 'curve');
    const verticalArm = {
        ...chunk(0, 30, 'tunnel', 54, 'curve'),
        x0: 0,
        z0: 0,
        x1: 0,
        z1: 30,
        mx: 0,
        mz: 15,
        ux: 0,
        uz: 1,
        px: -1,
        pz: 0,
        spanLen: 30,
    };
    const resolved = resolvePhotoStationStructures([horizontalArm, verticalArm], [envelope]);
    assert.deepEqual(resolved.get('id:curve-stop'), {
        structure: 'formation',
        terrainStructure: 'tunnel',
        openCutFallback: true,
        compactCovered: true,
        stationForm: 'compact-covered',
        groundY: 40,
    });
    const owned = applyPhotoStationCivilOwnership(
        [horizontalArm, verticalArm],
        [envelope],
        resolved,
    );
    assert.ok(owned.every(piece => piece.structure === 'station-covered'));
    assert.ok(owned.every(piece => piece.stationOwner?.openCutFallback === true));
    assert.ok(owned.every(piece => piece.stationOwner?.alongHalfM >= 30));
    assert.ok(owned.every(piece => piece.stationOwner?.captureHalfWidthM > 30));
    assert.ok(envelope.coveredStationSweep?.platform);
    assert.ok(envelope.coveredStationSweep?.identity);
    assert.equal(envelope.coveredStationSweep.platformLayout.sideM, envelope.platformSideM);
    assert.equal(envelope.coveredStationSweep.platformLayout.widthM, 3);
    assert.equal(envelope.coveredStationSweep.platformLayout.heightM, 0.55);
    assert.equal(envelope.coveredStationSweep.platformLayout.lengthM, 52);
    assert.equal(envelope.coveredStationSweep.nameBoard.label, 'Stanica Krivina');
    assert.equal(photoStationRuntimeStructure(envelope, 'formation'), 'tunnel');
    assert.equal(photoStationSupportsRigidStructure(envelope, 'tunnel'), false);
    const mask = buildPhotoStationMaskQuads([envelope], {
        encodeFloor: y => y / 100,
        tunnelSourceRoofOffsetM: 7.45,
    });
    assert.ok(mask.ownership.positions.length > 18);
    assert.ok(mask.ownership.colors.filter((_, index) => index % 3 === 1)
        .every(value => value === 1), 'Google remains above the compact roof');
    const expectedPayload = (20 + PHOTO_COVERED_STATION_ROOF_OFFSET_M - 7.45) / 100;
    const roofPayloads = mask.ownership.colors.filter((_, index) => index % 3 === 2);
    assert.ok(roofPayloads.some(value => Math.abs(value - 0.2) < 1e-9),
        'adapter endpoint exactly matches the running tunnel roof threshold');
    assert.ok(roofPayloads.some(value => Math.abs(value - expectedPayload) < 1e-9),
        'the station core keeps its rail +8.25 m roof');
    assert.ok(roofPayloads.every(value => value >= 0.2 - 1e-9
        && value <= expectedPayload + 1e-9));
    for (const [x, z] of [[0, 0], [-20, 0], [0, 20]]) {
        const source = photoStationSourceOwnershipAt([envelope], x, z);
        assert.equal(source.mode, 'station-core');
        assert.equal(source.floorY, 20);
        assert.equal(source.roofY, 20 + PHOTO_COVERED_STATION_ROOF_OFFSET_M);
    }
    assert.equal(
        photoStationSourceOwnershipAt([envelope], -20, 20),
        null,
        'ownership follows the authored curve instead of opening its huge tangent OBB',
    );
});

test('ordinary station runtime structures pass through unchanged', () => {
    for (const structure of ['formation', 'viaduct', 'tunnel']) {
        assert.equal(photoStationRuntimeStructure({ openCutFallback: false }, structure), structure);
    }
});

test('rigid tunnel eligibility rejects grade inside the hall envelope', () => {
    const gradedRoute = prepareStationTrackRoutes([{
        routeRunId: 'grade',
        trackId: 54,
        usesPhotoFrame: true,
        points: [
            { x: -100, y: 19, z: 0 },
            { x: 0, y: 20, z: 0 },
            { x: 100, y: 21, z: 0 },
        ],
    }])[0];
    const alignment = measurePhotoStationRouteAlignment({
        route: gradedRoute,
        chainageM: 100,
        x: 0,
        y: 20,
        z: 0,
        rightX: 0,
        rightZ: 1,
    });
    assert.equal(alignment.driftM, 0);
    assert.ok(alignment.levelErrorM > 0.25);
    assert.equal(alignment.coverageOk, true);
    assert.equal(alignment.ok, false);
});

test('rigid tunnel eligibility requires the complete hall and throat extent', () => {
    const shortRoute = prepareStationTrackRoutes([{
        routeRunId: 'short',
        trackId: 54,
        usesPhotoFrame: true,
        points: [
            { x: -60, y: 20, z: 0 },
            { x: 60, y: 20, z: 0 },
        ],
    }]);
    const envelope = buildPhotoStationCivilEnvelopes({
        stops: [{ stopId: 'short-stop', trackId: 54, level: 0 }],
        routes: shortRoute,
        locateStop: () => ({ x: 0, z: 0 }),
    })[0];
    assert.equal(envelope.tunnelAlignment.driftM, 0);
    assert.equal(envelope.tunnelAlignment.levelErrorM, 0);
    assert.equal(envelope.tunnelAlignment.coverageOk, false);
    assert.equal(envelope.tunnelAlignment.ok, false);
});
