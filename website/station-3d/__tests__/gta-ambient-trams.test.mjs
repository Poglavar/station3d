import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HEAVY_RAILWAYS,
    advanceGtaAmbientTramPath,
    buildGtaAmbientTramPathSteps,
    buildGtaAmbientTramPaths,
    chainAmbientRailPaths,
    gtaTramPhysicsHeadingFromSceneYaw,
    isAmbientTrainFeature,
    railwayType,
    reconcileGtaAmbientTramFleet,
    sampleGtaAmbientTramPath,
    stepGtaAmbientTramFleet,
} from '../core/gta-ambient-trams.js';

const features = [
    {
        type: 'Feature',
        properties: { osm_id: 12, railway_type: 'tram', tags: { oneway: 'yes' } },
        geometry: { type: 'LineString', coordinates: [[15, 45], [15.006, 45]] },
    },
    {
        type: 'Feature',
        properties: { osm_id: 13, railway_type: 'rail' },
        geometry: { type: 'LineString', coordinates: [[15, 45], [15.003, 45]] },
    },
    {
        type: 'Feature',
        properties: {
            osm_id: 14,
            railway_type: 'tram',
            tags: { oneway: 'yes', service: 'yard' },
        },
        geometry: { type: 'LineString', coordinates: [[15, 45], [15.008, 45]] },
    },
];

test('ambient GTA trams use revenue tram centrelines and reject heavy rail and yards', () => {
    const paths = buildGtaAmbientTramPaths(features, {
        toLocal: (lon, lat) => ({ x: (lon - 15) * 100000, z: (45 - lat) * 100000 }),
    });
    assert.equal(paths.length, 1);
    assert.equal(paths[0].id, 'osm:12');
    assert.ok(paths[0].lengthM > 590);
    assert.equal(paths[0].travelDirection, 1);
});

test('ambient GTA path compilation yields cooperatively and stays byte-for-byte deterministic', () => {
    const options = {
        toLocal: (lon, lat) => ({ x: (lon - 15) * 100000, z: (45 - lat) * 100000 }),
        coordinateChunk: 1,
        featureChunk: 1,
    };
    const expected = buildGtaAmbientTramPaths(features, options);
    const steps = buildGtaAmbientTramPathSteps(features, options);
    let yields = 0;
    while (true) {
        const step = steps.next();
        if (step.done) {
            assert.deepEqual(step.value, expected);
            break;
        }
        yields += 1;
        assert.match(step.value.phase, /^(coordinates|features)$/);
    }
    assert.ok(yields >= features.length);
});

test('one-way fleet motion follows OSM direction and wraps without running wrong-way', () => {
    const paths = buildGtaAmbientTramPaths(features, {
        toLocal: (lon, lat) => ({ x: (lon - 15) * 100000, z: (45 - lat) * 100000 }),
    });
    const middle = sampleGtaAmbientTramPath(paths[0], paths[0].lengthM * 0.5);
    assert.ok(Math.abs(middle.x - 300) < 0.01);
    assert.ok(Math.abs(middle.headingDeg - 90) < 0.01);
    const fleet = reconcileGtaAmbientTramFleet(paths, [], { maxTrams: 1 });
    assert.equal(fleet[0].direction, 1);
    fleet[0].distanceM = paths[0].lengthM - 0.01;
    fleet[0].direction = 1;
    const poses = stepGtaAmbientTramFleet(paths, fleet, 0.1);
    assert.equal(fleet[0].direction, 1);
    assert.ok(fleet[0].distanceM < 2);
    assert.equal(poses.length, 1);
    assert.ok(Math.abs(poses[0].headingDeg - 90) < 0.01);
});

test('a genuinely two-way single track may reverse at its endpoint', () => {
    const path = {
        points: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
        cumulativeM: [0, 100],
        lengthM: 100,
        travelDirection: 0,
    };
    const advanced = advanceGtaAmbientTramPath(
        path,
        { distanceM: 99, direction: 1 },
        3,
    );
    assert.equal(advanced.direction, -1);
    assert.equal(advanced.distanceM, 98);
});

test('the Rapier tram box keeps the rendered yaw on an oblique track', () => {
    const path = {
        points: [{ x: 0, z: 0 }, { x: 3, z: 4 }],
        cumulativeM: [0, 5],
        lengthM: 5,
    };
    const pose = sampleGtaAmbientTramPath(path, 2.5);
    const sceneYaw = -pose.headingDeg * Math.PI / 180;
    const physicsYaw = gtaTramPhysicsHeadingFromSceneYaw(sceneYaw);
    const colliderAxis = { x: Math.sin(physicsYaw), z: Math.cos(physicsYaw) };
    const pathAxis = { x: 3 / 5, z: 4 / 5 };
    const alignment = Math.abs(
        colliderAxis.x * pathAxis.x + colliderAxis.z * pathAxis.z,
    );
    assert.ok(alignment > 0.999999,
        `tram collider axis must be parallel to its path, got dot ${alignment}`);
    assert.equal(gtaTramPhysicsHeadingFromSceneYaw(Number.NaN), 0);
});

const toLocal = (lon, lat) => ({ x: (lon - 15) * 100000, z: (45 - lat) * 100000 });
const rail = (osmId, coordinates, properties = {}) => ({
    type: 'Feature',
    properties: { osm_id: osmId, railway_type: 'rail', ...properties },
    geometry: { type: 'LineString', coordinates },
});
const solved = (key, coordinates) => ({
    type: 'Feature',
    properties: { source: 'reference-project', trackType: 'g1435', elevationMode: 'absolute', elevationDatum: 'EVRF2000', referenceSegmentKey: key },
    geometry: { type: 'LineString', coordinates: coordinates.map(([lon, lat]) => [lon, lat, 120]) },
});

test('the train fleet takes heavy rail and revenue track only, reading a solved span by its gauge', () => {
    assert.equal(railwayType(rail(1, [])), 'rail');
    assert.equal(railwayType(solved('k', [])), 'rail');
    assert.equal(railwayType({ properties: { trackType: 'g1000' } }), 'tram');
    assert.equal(railwayType({ properties: {} }), '');
    assert.equal(isAmbientTrainFeature(rail(1, [])), true);
    assert.equal(isAmbientTrainFeature(rail(1, [], { tags: { service: 'siding' } })), false);
    assert.equal(isAmbientTrainFeature(rail(1, [], { driverTrackOnly: true })), false, 'the derived driving track is not a second line');
    assert.equal(isAmbientTrainFeature(features[0]), false, 'a tram line carries no train');
    assert.equal(isAmbientTrainFeature(rail(1, []), { solvedOnly: true }), false, 'OSM rail is not drivable in solved mode');
    assert.equal(isAmbientTrainFeature(solved('k', [[15, 45], [15.01, 45]]), { solvedOnly: true }), true);
    const paths = buildGtaAmbientTramPaths(features, { toLocal, railways: HEAVY_RAILWAYS, minLengthM: 100 });
    assert.deepEqual(paths.map(path => path.id), ['osm:13']);
    assert.deepEqual(paths[0].osmIds, [13]);
    assert.ok(paths[0].points.every(point => point.osmId === 13), 'every point knows its way');
    const solvedPaths = buildGtaAmbientTramPaths([solved('rail:m202:a', [[15, 45], [15.02, 45]])], { toLocal, railways: HEAVY_RAILWAYS, minLengthM: 100 });
    assert.equal(solvedPaths[0].id, 'osm:rail:m202:a', 'a stable identity, not a streaming index');
    assert.deepEqual(solvedPaths[0].osmIds, [], 'no OSM way to ask trackbed support for');
    assert.equal(solvedPaths[0].osmId, null, 'so support falls back to the highest trackbed, not to terrain');
    assert.equal(sampleGtaAmbientTramPath(solvedPaths[0], 100).osmId, null);
});

test('chaining joins ways end to end into one run, stops at junctions, and keeps each point on its own way', () => {
    // a: west→east, b continues east but is digitised east→west, c continues.
    const ways = [
        rail(1, [[15.000, 45], [15.005, 45]]),
        rail(2, [[15.010, 45], [15.005, 45]]),
        rail(3, [[15.010, 45], [15.015, 45]]),
        // A junction at the far end of c: two ways leave it, so the chain ends there.
        rail(4, [[15.015, 45], [15.020, 45]]),
        rail(5, [[15.015, 45], [15.020, 45.003]]),
        // A far-away short stub.
        rail(6, [[15.100, 45.1], [15.1002, 45.1]]),
    ];
    const chained = buildGtaAmbientTramPaths(ways, { toLocal, railways: HEAVY_RAILWAYS, chain: true, minLengthM: 600 });
    assert.equal(chained.length, 1, `runs: ${chained.map(path => path.id).join(', ')}`);
    const [run] = chained;
    assert.equal(run.id, 'osm:1+2+3');
    assert.deepEqual(run.osmIds, [1, 2, 3]);
    assert.ok(Math.abs(run.lengthM - 1500) < 1, `${run.lengthM.toFixed(0)} m`);
    assert.equal(run.travelDirection, 0);
    let previousX = -Infinity;
    for (const point of run.points) { assert.ok(point.x >= previousX, 'monotonic along the run'); previousX = point.x; }
    assert.equal(sampleGtaAmbientTramPath(run, 200).osmId, 1);
    assert.equal(sampleGtaAmbientTramPath(run, 700).osmId, 2);
    assert.equal(sampleGtaAmbientTramPath(run, 1300).osmId, 3);
    // Without chaining every way is its own short path and none reaches 600 m.
    assert.equal(buildGtaAmbientTramPaths(ways, { toLocal, railways: HEAVY_RAILWAYS, minLengthM: 600 }).length, 0);
    // The pure chain step on prepared paths is deterministic and keeps unrelated paths apart.
    const loose = buildGtaAmbientTramPaths(ways, { toLocal, railways: HEAVY_RAILWAYS, minLengthM: 0 });
    const again = chainAmbientRailPaths(loose);
    assert.deepEqual(again.map(path => path.id).sort(), ['osm:1+2+3', 'osm:4', 'osm:5', 'osm:6'].sort(), 'the two branches leaving the junction never join each other through it');
    assert.deepEqual(chainAmbientRailPaths(loose), again);
    // A sharp reversal at a shared endpoint is a switch, not a continuation.
    const hairpin = buildGtaAmbientTramPaths([
        rail(7, [[15.000, 45], [15.005, 45]]),
        rail(8, [[15.005, 45], [15.000, 45.0005]]),
    ], { toLocal, railways: HEAVY_RAILWAYS, chain: true, minLengthM: 0 });
    assert.deepEqual(hairpin.map(path => path.id).sort(), ['osm:7', 'osm:8']);
    // A gentle bend is.
    const bend = buildGtaAmbientTramPaths([
        rail(7, [[15.000, 45], [15.005, 45]]),
        rail(8, [[15.005, 45], [15.010, 45.001]]),
    ], { toLocal, railways: HEAVY_RAILWAYS, chain: true, minLengthM: 0 });
    assert.deepEqual(bend.map(path => path.id), ['osm:7+8']);
});

test('a train fleet gets its own ids and a main-line pace', () => {
    const paths = buildGtaAmbientTramPaths([rail(9, [[15, 45], [15.03, 45]])], { toLocal, railways: HEAVY_RAILWAYS, minLengthM: 100 });
    const [train] = reconcileGtaAmbientTramFleet(paths, [], { idPrefix: 'gta-train', cruiseMinMps: 18, cruiseStepMps: 0.2 });
    assert.equal(train.id, 'gta-train:osm:9');
    assert.ok(train.speedMps >= 18 && train.speedMps <= 24, `${train.speedMps} m/s`);
    const [tram] = reconcileGtaAmbientTramFleet(paths, []);
    assert.equal(tram.id, 'gta-tram:osm:9');
    assert.ok(tram.speedMps >= 8.5 && tram.speedMps <= 11.5, 'the tram pace is unchanged');
    const [pose] = stepGtaAmbientTramFleet(paths, [train], 0.05);
    assert.equal(pose.osmId, 9);
});
