// Verifies OSM lane-width interpretation and continuous marking transitions
// without requiring Three.js, a DOM, or the Station3D renderer.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLaneMarkingPaths,
    buildLaneMarkingPathsResumable,
    buildOffsetPath,
    getCarriagewayWidthM,
    getLaneBoundaryOffsetsForProperties,
    getLaneMarkingOffsetsForProperties,
    mergeLaneMarkingTileFeatures,
} from '../core/lane-marking-geometry.js';

const localPoint = ([x, z]) => ({ x, z });

function road(id, coordinates, lanes, extraProperties = {}) {
    return {
        type: 'Feature',
        properties: {
            osm_id: id,
            highway: 'primary',
            name: 'Test road',
            lanes,
            ...extraProperties,
        },
        geometry: { type: 'LineString', coordinates },
    };
}

function roundedPoint(point) {
    return [Number(point.x.toFixed(6)), Number(point.z.toFixed(6))];
}

function endpointSet(entry, side) {
    const index = side === 'start' ? 0 : -1;
    return entry.paths
        .map((path) => roundedPoint(path.points.at(index)))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

test('the cooperative path solve is byte-for-byte equivalent to the synchronous API', () => {
    const features = [
        road(1, [[-50, 0], [0, 0]], 3, { name: 'Main road' }),
        road(2, [[0, 0], [50, 0]], 4, { name: 'Main road' }),
        road(3, [[0, -40], [0, 0]], 2, { name: 'Cross road' }),
        road(4, [[0, 0], [0, 40]], 2, { name: 'Cross road' }),
    ];
    const expected = buildLaneMarkingPaths(features, localPoint);
    const build = buildLaneMarkingPathsResumable(features, localPoint);
    let yields = 0;
    let outcome = build.next();
    while (!outcome.done) {
        yields += 1;
        outcome = build.next();
    }

    assert.ok(yields > features.length,
        'the iterator yields through topology stages, not only feature conversion');
    assert.deepEqual(outcome.value, expected);
});

test('estimated carriageway width matches the importer lane bays plus edge allowance', () => {
    assert.equal(getCarriagewayWidthM({ lanes: 3 }), 9.5);
    assert.deepEqual(getLaneMarkingOffsetsForProperties({ lanes: 3 }), [-1.5, 1.5]);
    assert.deepEqual(
        getLaneBoundaryOffsetsForProperties({ lanes: 3 }),
        [-4.5, -1.5, 1.5, 4.5],
    );
});

test('explicit OSM width is divided across the mapped lane count', () => {
    assert.equal(getCarriagewayWidthM({ lanes: 3, width_meters: 12 }), 12);
    assert.deepEqual(
        getLaneMarkingOffsetsForProperties({ lanes: 3, width_meters: 12 }),
        [-2, 2],
    );
});

test('directional lane tags can supply a missing total lane count', () => {
    assert.deepEqual(
        getLaneMarkingOffsetsForProperties({
            tags: { 'lanes:forward': '2', 'lanes:backward': '1' },
        }),
        [-1.5, 1.5],
    );
});

test('offset line uses one mitered station at a bend instead of disconnected segments', () => {
    const path = buildOffsetPath([
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
    ], 2);
    const bendPoints = path.filter((point) => (
        Math.abs(point.x - 12) < 1e-6 && Math.abs(point.z + 2) < 1e-6
    ));
    assert.equal(bendPoints.length, 1);
});

test('a one-lane expansion inherits a curb so existing lanes remain continuous', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [40, 0]], 2),
        road(2, [[40, 0], [100, 0]], 3),
    ], localPoint);
    const twoLane = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const threeLane = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(twoLane, 'end'), [[40, 0]]);
    assert.deepEqual(endpointSet(threeLane, 'start'), [[40, 0], [40, 3]]);
    assert.deepEqual(endpointSet(threeLane, 'end'), [[100, -1.5], [100, 1.5]]);
    assert.deepEqual(
        threeLane.endpointTargets.start.map((target) => target.targetKind),
        ['edge', 'marking'],
    );
    assert.ok(threeLane.paths.every((path) => path.points[0].arc === 0));
});

test('a two-lane expansion on both sides keeps the middle corridors straight', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [40, 0]], 2),
        road(2, [[40, 0], [100, 0]], 4),
    ], localPoint);
    const twoLane = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const fourLane = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(twoLane, 'end'), [[40, 0]]);
    assert.deepEqual(endpointSet(fourLane, 'start'), [
        [40, -3],
        [40, 0],
        [40, 3],
    ]);
    assert.deepEqual(
        fourLane.endpointTargets.start.map((target) => target.targetKind),
        ['edge', 'marking', 'edge'],
    );
    assert.deepEqual(fourLane.endpointBranches.start, [null, null, null]);
});

test('two incoming markings and both curbs continue into a five-lane cross-section', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [40, 0]], 3),
        road(2, [[40, 0], [100, 0]], 5),
    ], localPoint);
    const threeLane = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const fiveLane = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(threeLane, 'end'), [[40, -1.5], [40, 1.5]]);
    assert.deepEqual(endpointSet(fiveLane, 'start'), [
        [40, -4.5],
        [40, -1.5],
        [40, 1.5],
        [40, 4.5],
    ]);
    assert.deepEqual(endpointSet(fiveLane, 'end'), [
        [100, -4.5],
        [100, -1.5],
        [100, 1.5],
        [100, 4.5],
    ]);
    assert.deepEqual(
        fiveLane.endpointTargets.start.map((target) => target.targetKind),
        ['edge', 'marking', 'marking', 'edge'],
    );
    assert.deepEqual(fiveLane.endpointBranches.start, [null, null, null, null]);
    assert.ok(fiveLane.paths.every((path) => path.points[0].arc === 0));
});

test('a lane-count reduction merges every incoming marking without shortening it', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [60, 0]], 3),
        road(2, [[60, 0], [100, 0]], 2),
    ], localPoint);
    const threeLane = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const twoLane = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(threeLane, 'end'), [[60, 0], [60, 3]]);
    assert.deepEqual(endpointSet(twoLane, 'start'), [[60, 0]]);
    assert.ok(threeLane.paths.every((path) => path.points.at(-1).arc === 60));
});

test('duplicate tile features produce one lineage connected at both transitions', () => {
    const narrowerBefore = road(1, [[0, 0], [40, 0]], 4);
    const wider = road(2, [[40, 0], [120, 0]], 5);
    const narrowerAfter = road(3, [[120, 0], [180, 0]], 4);
    const features = mergeLaneMarkingTileFeatures([
        [narrowerBefore, wider],
        [{ ...wider, properties: { ...wider.properties } }, narrowerAfter],
    ]);
    const entries = buildLaneMarkingPaths(features, localPoint);
    const beforeEntry = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const widerEntry = entries.find((entry) => entry.feature.properties.osm_id === 2);
    const afterEntry = entries.find((entry) => entry.feature.properties.osm_id === 3);
    const beforeEndpoints = endpointSet(beforeEntry, 'end').map(JSON.stringify);
    const afterEndpoints = endpointSet(afterEntry, 'start').map(JSON.stringify);
    const widerStarts = endpointSet(widerEntry, 'start').map(JSON.stringify);
    const widerEnds = endpointSet(widerEntry, 'end').map(JSON.stringify);
    const beforeBoundaries = beforeEntry.boundaryPaths
        .map((path) => JSON.stringify(roundedPoint(path.points.at(-1))));
    const afterBoundaries = afterEntry.boundaryPaths
        .map((path) => JSON.stringify(roundedPoint(path.points[0])));

    assert.equal(features.length, 3);
    assert.equal(widerEntry.paths.length, 4);
    assert.ok(widerStarts.every((endpoint) => beforeBoundaries.includes(endpoint)));
    assert.ok(beforeEndpoints.every((endpoint) => widerStarts.includes(endpoint)));
    assert.ok(widerEnds.every((endpoint) => afterBoundaries.includes(endpoint)));
    assert.ok(afterEndpoints.every((endpoint) => widerEnds.includes(endpoint)));
    assert.deepEqual(
        widerEntry.endpointTargets.start.map((target) => target.targetOffsetM),
        widerEntry.endpointTargets.end.map((target) => target.targetOffsetM),
    );
});

test('an unsplit main road keeps its markings through a T junction', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[-50, 0], [0, 0], [50, 0]], 3, { name: 'Main road' }),
        road(2, [[0, -40], [0, 0]], 2, { name: 'Side road' }),
    ], localPoint);
    const main = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const side = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.equal(main.paths.length, 2);
    assert.equal(side.paths.length, 1);
    assert.ok(main.paths.every((path) => path.points.some((point) => point.x === 0)));
    assert.ok(side.paths.every((path) => path.points.every((point) => point.z <= -7.75)));
});

test('an unmarked side road does not erase through markings on the main road', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[-50, 0], [0, 0], [50, 0]], 3, { name: 'Main road' }),
        road(2, [[0, -40], [0, 0]], 1, { name: 'Side road' }),
    ], localPoint);
    const main = entries.find((entry) => entry.feature.properties.osm_id === 1);

    assert.equal(entries.length, 1);
    assert.equal(main.paths.length, 2);
    assert.ok(main.paths.every((path) => path.points.some((point) => point.x === 0)));
});

test('lane-count changes keep the inferred main-road continuation through a junction', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[-50, 0], [0, 0]], 2, { name: 'Main road' }),
        road(2, [[0, 0], [50, 0]], 3, { name: 'Main road' }),
        road(3, [[0, -40], [0, 0]], 2, { name: 'Side road' }),
    ], localPoint);
    const widerApproach = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(widerApproach, 'start'), [[0, 0], [0, 3]]);
});

test('split OSM ways infer both straight-through corridors at a crossroads', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[-50, 0], [0, 0]], 3, { name: 'Main road' }),
        road(2, [[0, 0], [50, 0]], 3, { name: 'Main road' }),
        road(3, [[0, -40], [0, 0]], 2, { name: 'Cross road' }),
        road(4, [[0, 0], [0, 40]], 2, { name: 'Cross road' }),
    ], localPoint);
    const mainBefore = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const mainAfter = entries.find((entry) => entry.feature.properties.osm_id === 2);
    const crossBefore = entries.find((entry) => entry.feature.properties.osm_id === 3);
    const crossAfter = entries.find((entry) => entry.feature.properties.osm_id === 4);

    assert.deepEqual(endpointSet(mainBefore, 'end'), endpointSet(mainAfter, 'start'));
    assert.deepEqual(endpointSet(crossBefore, 'end'), endpointSet(crossAfter, 'start'));
    assert.ok(mainBefore.paths.every((path) => path.points.at(-1).x === 0));
    assert.ok(crossBefore.paths.every((path) => path.points.at(-1).z === 0));
});

test('equal-count markings meet exactly when continuing OSM ways curve at their split', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [40, 0]], 3),
        road(2, [[40, 0], [80, 30]], 3),
    ], localPoint);
    const first = entries.find((entry) => entry.feature.properties.osm_id === 1);
    const second = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(second, 'start'), endpointSet(first, 'end'));
});

test('different named roads do not taper their markings into each other', () => {
    const entries = buildLaneMarkingPaths([
        road(1, [[0, 0], [40, 0]], 2, { name: 'First road' }),
        road(2, [[40, 0], [80, 0]], 3, { name: 'Second road' }),
    ], localPoint);
    const threeLane = entries.find((entry) => entry.feature.properties.osm_id === 2);

    assert.deepEqual(endpointSet(threeLane, 'start'), [[40, -1.5], [40, 1.5]]);
});
