// Verifies deterministic water search and runway-derived aircraft placement.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    runwayParkingSpots,
    runwaySide,
    findNearestWaterSpawn,
    mappedBoatSpawnCandidates,
    nearestRunwayCandidate,
    pointInLocalRing,
    runwaySpawnCandidates,
} from '../core/gta-special-vehicle-spawns.js';

test('water spawn searches outward and stays in mapped water', () => {
    const spawn = findNearestWaterSpawn({
        x: 0,
        z: 0,
        isWaterAt: (x) => x >= 24,
        minRadiusM: 8,
        maxRadiusM: 40,
        radiusStepM: 8,
        directionCount: 8,
    });
    assert.ok(spawn);
    assert.ok(spawn.x >= 24);
    assert.equal(spawn.distanceM, 24);
});

test('mapped boat candidates are water-gated, bounded, stable, and nearest-first', () => {
    const candidates = mappedBoatSpawnCandidates([
        { id: 'far', lat: 0, lon: 18, heading: 1.2 },
        { id: 'dry', lat: 0, lon: 4 },
        { id: 'near', lat: 0, lon: 6, heading: 0.4 },
        { id: 'too-far', lat: 0, lon: 50 },
    ], {
        x: 0,
        z: 0,
        toLocal: (lon, lat) => ({ x: lon, z: lat }),
        isWaterAt: (x) => x >= 5,
        maxDistanceM: 20,
    });
    assert.deepEqual(candidates.map(candidate => candidate.id), ['near', 'far']);
    assert.deepEqual(candidates.map(candidate => candidate.heading), [0.4, 1.2]);
});

test('runway candidate keeps the buffered polygon and its long-axis heading', () => {
    const entries = [{
        aeroway: 'runway',
        sourceId: 'way-7',
        rings: [[
            [0, 0], [100, 0], [100, 20], [0, 20], [0, 0],
        ]],
    }];
    const candidates = runwaySpawnCandidates(entries, {
        toLocal: (lon, lat) => ({ x: lon, z: lat }),
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'runway:way-7');
    assert.ok(Math.abs(Math.abs(candidates[0].heading) - Math.PI / 2) < 1e-6);
    assert.equal(pointInLocalRing(50, 10, candidates[0].ring), true);
    assert.equal(pointInLocalRing(50, 30, candidates[0].ring), false);
    assert.equal(nearestRunwayCandidate(candidates, 55, 10, 20)?.id, 'runway:way-7');
});

test('an authored boat name reaches the spawn candidate, an unnamed one adds nothing', () => {
    const candidates = mappedBoatSpawnCandidates([
        { id: 'named', lat: 0, lon: 6, heading: 0.4, label: { en: 'Courier boat', hr: 'Kurirski brod' } },
        { id: 'plain', lat: 0, lon: 8 },
    ], { x: 0, z: 0, toLocal: (lon, lat) => ({ x: lon, z: lat }), isWaterAt: () => true, maxDistanceM: 20 });
    assert.deepEqual(candidates[0].label, { en: 'Courier boat', hr: 'Kurirski brod' });
    assert.equal('label' in candidates[1], false);
});

test('parking spots line up beside the runway on the asked side, off the strip, noses along it', () => {
    const [runway] = runwaySpawnCandidates([{
        aeroway: 'runway', sourceId: 'way-7',
        rings: [[[0, 0], [100, 0], [100, 20], [0, 20], [0, 0]]],
    }], { toLocal: (lon, lat) => ({ x: lon, z: lat }) });
    for (const side of [1, -1]) {
        const spots = runwayParkingSpots(runway, { side });
        assert.equal(spots.length, 3);
        assert.deepEqual(spots.map(spot => spot.id), [0, 1, 2].map(i => `runway:way-7:park:${side > 0 ? 'r' : 'l'}:${i}`));
        for (const spot of spots) {
            assert.equal(spot.heading, runway.heading);
            assert.equal(pointInLocalRing(spot.x, spot.z, runway.ring), false, 'off the strip');
            assert.ok(Math.abs(Math.abs(spot.z - 10) - 20) < 1e-6, `half width 10 + clearance 10, got ${(spot.z - 10).toFixed(1)}`);
            assert.ok(spot.x > 0 && spot.x < 100, 'within the runway length');
        }
        assert.ok(Math.abs(Math.abs(spots[0].x - spots[1].x) - 12) < 1e-6, '12 m apart');
        assert.equal(new Set(spots.map(spot => Math.sign(spot.z - 10))).size, 1, 'all on one side');
    }
    assert.notEqual(Math.sign(runwayParkingSpots(runway, { side: 1 })[0].z - 10), Math.sign(runwayParkingSpots(runway, { side: -1 })[0].z - 10));
    // The player's side decides which row appears.
    const towards = runwayParkingSpots(runway, { side: runwaySide(runway, 50, 40) })[0];
    assert.ok(Math.abs(towards.z - 40) < Math.abs(towards.z + 20), 'the row is on the side the player stands');
    const away = runwayParkingSpots(runway, { side: runwaySide(runway, 50, -30) })[0];
    assert.ok(Math.abs(away.z + 30) < Math.abs(away.z - 40));
    assert.deepEqual(runwayParkingSpots({ id: 'x', heading: 0, ring: [] }), []);
    assert.equal(runwayParkingSpots(runway, { count: 0 }).length, 0);
});
