// Verifies long authored corridors receive one bounded DGU terrain request
// instead of falling back to the legacy eight-kilometre boarding box.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDynamicTerrainGridRequest } from '../core/terrain-grid-request.js';

test('DGU request covers the whole Zaprešić–Dugo Selo corridor', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.8131,
        anchorLat: 45.8444,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [15.8131, 45.8444, 129.7],
                    [16.2347, 45.8014, 102.4],
                ],
            },
        }],
    });
    assert.equal(request.source, 'dgu-dtm-20m');
    assert.equal(request.scope, 'authored-corridor');
    assert.ok(request.bbox[0] < 15.8131);
    assert.ok(request.bbox[2] > 16.2347);
    assert.ok(request.bbox[1] < 45.8014);
    assert.ok(request.bbox[3] > 45.8444);
    assert.ok(request.estimatedCells <= 2_400_000);
});

test('ordinary sessions retain the anchor-centred DGU request', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.98,
        anchorLat: 45.81,
        customTrackCorridors: [],
    });
    assert.equal(request.source, 'dgu-dtm-20m');
    assert.equal(request.scope, 'session-anchor');
    assert.ok(request.bbox[0] < 15.98 && request.bbox[2] > 15.98);
    assert.ok(request.bbox[1] < 45.81 && request.bbox[3] > 45.81);
});

// A grid sampled coarser than its own source is a different surface from the one
// /terrain/profile hands the planner, and the model world classifies cut / fill /
// tunnel against it. Never ask the DGU DTM for less than its 20 m cells.
test('the DGU grid is requested at the source resolution, not half of it', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 14.459223,
        anchorLat: 45.323115,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [[14.4696, 45.3182, 61.8], [14.4471, 45.3238, 45.7]],
            },
        }],
    });
    assert.equal(request.resolutionDeg, 0.0002);
    assert.ok(request.estimatedCells <= 2_400_000);
});

test('a corridor too long to hold at source resolution still backs off to the cap', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.98,
        anchorLat: 45.81,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                // Zagreb → Split: 400 km of corridor cannot be held at 20 m.
                coordinates: [[15.98, 45.81, 120], [16.44, 43.51, 5]],
            },
        }],
    });
    assert.ok(request.resolutionDeg > 0.0002, 'the cap, not the floor, sets a huge corridor');
    assert.ok(request.estimatedCells <= 2_400_000);
});

// The Šibenik regression: a walk spawned ~40 km from the open project's line
// inherited the project's bbox, which backed the grid off below the 20 m source
// (phantom viaducts) and parked the grid edge — a sea-level escarpment — 2 km
// from the spawn. A corridor beyond walk reach must not shape the request.
test('a walk far from the authored corridor detaches it and keeps native resolution', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.932817,
        anchorLat: 43.701532,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                // Gračac – Knin reconstruction, nearest point ~40 km north.
                coordinates: [[15.8223, 44.3003, 560], [16.1936, 44.0545, 220]],
            },
        }],
    });
    assert.equal(request.scope, 'session-anchor');
    assert.equal(request.droppedCorridorCount, 1);
    assert.equal(request.resolutionDeg, 0.0002);
    assert.ok(request.bbox[3] < 44.0, 'the far corridor must not stretch the box');
    // The full 8 km walk neighbourhood surrounds the spawn on every side.
    assert.ok(request.bbox[1] < 43.701532 - 0.07);
    assert.ok(request.bbox[3] > 43.701532 + 0.07);
});

test('the walk neighbourhood stays covered even when a corridor sets the box', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.8131,
        anchorLat: 45.8444,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [[15.8131, 45.8444, 129.7], [16.2347, 45.8014, 102.4]],
            },
        }],
    });
    assert.equal(request.scope, 'authored-corridor');
    assert.equal(request.droppedCorridorCount, 0);
    // Anchor sits at the corridor's west end: 8 km of neighbourhood must lie
    // beyond it, not just the 2 km corridor margin.
    assert.ok(request.bbox[0] < 15.8131 - 0.1);
    assert.ok(request.bbox[3] > 45.8444 + 0.07);
});

test('corridor reach is measured to segments, not vertices', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 16.09,
        anchorLat: 45.81,
        customTrackCorridors: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                // Two vertices ~20 km apart; the anchor faces the midpoint,
                // ~10 km from either vertex but on the line itself.
                coordinates: [[15.96, 45.81, 120], [16.22, 45.81, 110]],
            },
        }],
    });
    assert.equal(request.scope, 'authored-corridor');
    assert.equal(request.droppedCorridorCount, 0);
});

test('only corridors beyond walk reach are dropped, near ones stay whole', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.98,
        anchorLat: 45.81,
        customTrackCorridors: [
            {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [[15.97, 45.80, 120], [16.05, 45.83, 115]],
                },
            },
            {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    // Split-area track, hundreds of kilometres away.
                    coordinates: [[16.40, 43.50, 5], [16.48, 43.53, 8]],
                },
            },
        ],
    });
    assert.equal(request.scope, 'authored-corridor');
    assert.equal(request.droppedCorridorCount, 1);
    assert.ok(request.bbox[1] > 45.0, 'the Split track must not stretch the box');
    assert.ok(request.bbox[2] > 16.05, 'the near corridor is still covered whole');
    assert.equal(request.resolutionDeg, 0.0002);
});

test('Zagreb can request priority-composed LiDAR with the same bounded contract', () => {
    const request = resolveDynamicTerrainGridRequest({
        anchorLon: 15.975,
        anchorLat: 45.807,
        customTrackCorridors: [],
    }, {
        fallbackRadiusM: 500,
        elevationSource: 'best-available',
    });
    assert.equal(request.source, 'best-available');
    assert.equal(request.scope, 'session-anchor');
    assert.ok(request.resolutionDeg < 0.00002);
    assert.ok(request.estimatedCells <= 2_400_000);
});
