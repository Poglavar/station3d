// Contract for the pure foundation-skirt geometry: flat ground emits nothing,
// a slope produces a band whose top edge is the flat base and whose bottom edge
// follows the terrain sampler per footprint corner, wound outward.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFoundationSkirtPositions,
    buildFoundationSkirtPositionsCooperative,
    composeFoundationGroundSampler,
    FOUNDATION_SKIRT_BUFFER_VALUES_PER_STAGE,
    FOUNDATION_SKIRT_PIECES_PER_STAGE,
    FOUNDATION_SKIRT_SEGMENT_UNITS_PER_STAGE,
    foundationSegmentsForMeshFeature,
    foundationSegmentsForMeshFeatureCooperative,
    foundationSegmentsFromFootprint,
    foundationSegmentsFromWallFaces,
    prepareFoundationSkirtBuffersCooperative,
    SKIRT_FLAT_EPSILON_M,
} from '../core/foundation-skirt.js';

// Closed unit square footprint (0,0)->(10,0)->(10,10)->(0,10)->(0,0) as four
// segments, with outward normals for a clockwise (in XZ) ring.
function squareSegments() {
    return [
        { ax: 0, az: 0, bx: 10, bz: 0, normalX: 0, normalZ: -1 },
        { ax: 10, az: 0, bx: 10, bz: 10, normalX: 1, normalZ: 0 },
        { ax: 10, az: 10, bx: 0, bz: 10, normalX: 0, normalZ: 1 },
        { ax: 0, az: 10, bx: 0, bz: 0, normalX: -1, normalZ: 0 },
    ];
}

function allFinite(values) {
    return values.every((value) => Number.isFinite(value));
}

test('survey wall faces recover one deduplicated foundation outline', () => {
    const faces = [
        { nx: 0, nz: 1, d: 0, uMin: 0, uMax: 10 },
        { nx: 1, nz: 0, d: 10, uMin: -10, uMax: 0 },
        { nx: 0, nz: 1, d: 10, uMin: 0, uMax: 10 },
        { nx: 1, nz: 0, d: 0, uMin: -10, uMax: 0 },
        // Reversed duplicate of the first surveyed wall.
        { nx: 0, nz: -1, d: 0, uMin: -10, uMax: 0 },
    ];
    const segments = foundationSegmentsFromWallFaces(faces, { x: 5, z: 5 });
    assert.equal(segments.length, 4);
    assert.ok(segments.every(segment => [
        segment.ax,
        segment.az,
        segment.bx,
        segment.bz,
        segment.normalX,
        segment.normalZ,
    ].every(Number.isFinite)));
    for (const segment of segments) {
        const midX = (segment.ax + segment.bx) * 0.5;
        const midZ = (segment.az + segment.bz) * 0.5;
        assert.ok(
            segment.normalX * (midX - 5) + segment.normalZ * (midZ - 5) > 0,
            'the recovered normal must point away from the building centre',
        );
    }
});

test('the served closed footprint supplies every foundation side', () => {
    const footprint = {
        type: 'Polygon',
        coordinates: [[
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
        ]],
    };
    const segments = foundationSegmentsFromFootprint(
        footprint,
        (lon, lat) => ({ x: lon, z: lat }),
    );
    assert.equal(segments.length, 4);
    const endpoints = new Map();
    for (const segment of segments) {
        for (const [x, z] of [[segment.ax, segment.az], [segment.bx, segment.bz]]) {
            const key = `${x}:${z}`;
            endpoints.set(key, (endpoints.get(key) || 0) + 1);
        }
        const midX = (segment.ax + segment.bx) * 0.5;
        const midZ = (segment.az + segment.bz) * 0.5;
        assert.ok(segment.normalX * (midX - 5) + segment.normalZ * (midZ - 5) > 0,
            'each exact footprint side faces away from the building interior');
    }
    assert.ok([...endpoints.values()].every(degree => degree === 2),
        'the exact footprint is a sealed loop with no dangling foundation panels');
});

test('courtyard foundation sides face into the void', () => {
    const footprint = {
        type: 'Polygon',
        coordinates: [
            [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
            [[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]],
        ],
    };
    const segments = foundationSegmentsFromFootprint(
        footprint,
        (lon, lat) => ({ x: lon, z: lat }),
    );
    assert.equal(segments.length, 8);
    for (const segment of segments.slice(4)) {
        const midX = (segment.ax + segment.bx) * 0.5;
        const midZ = (segment.az + segment.bz) * 0.5;
        assert.ok(segment.normalX * (10 - midX) + segment.normalZ * (10 - midZ) > 0,
            'an inner ring must face toward the courtyard, away from the building solid');
    }
});

test('mesh foundations prefer the served footprint over incomplete wall recovery', () => {
    const feature = {
        properties: {
            footprint: {
                type: 'Polygon',
                coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
            },
        },
    };
    const onlyThreeSurveyWalls = [
        { nx: 0, nz: 1, d: 0, uMin: 0, uMax: 10 },
        { nx: 1, nz: 0, d: 10, uMin: -10, uMax: 0 },
        { nx: 0, nz: 1, d: 10, uMin: 0, uMax: 10 },
    ];
    const project = (lon, lat) => ({ x: lon, z: lat });
    const exact = foundationSegmentsForMeshFeature(
        feature,
        project,
        onlyThreeSurveyWalls,
        { x: 5, z: 5 },
    );
    assert.equal(exact.length, 4, 'the missing fourth wall cannot open the foundation');

    const legacy = foundationSegmentsForMeshFeature(
        { properties: {} },
        project,
        onlyThreeSurveyWalls,
        { x: 5, z: 5 },
    );
    assert.equal(legacy.length, 3, 'older payloads retain wall-face recovery');
});

test('multipart mesh foundation perimeter extraction is bounded and byte-identical', () => {
    const polygons = Array.from({ length: 160 }, (_, index) => {
        const x = index * 2;
        return [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]];
    });
    const feature = {
        properties: {
            footprint: { type: 'MultiPolygon', coordinates: polygons },
        },
    };
    const project = (lon, lat) => ({ x: lon, z: lat });
    const expected = foundationSegmentsForMeshFeature(feature, project, [], { x: 0, z: 0 });
    let projectionCalls = 0;
    const iterator = foundationSegmentsForMeshFeatureCooperative(
        feature,
        (lon, lat) => {
            projectionCalls += 1;
            return project(lon, lat);
        },
        [],
        { x: 0, z: 0 },
    );
    let outcome = iterator.next();
    let previousProjectionCalls = 0;
    let yieldedStages = 0;
    while (!outcome.done) {
        const callsThisStage = projectionCalls - previousProjectionCalls;
        previousProjectionCalls = projectionCalls;
        assert.ok(
            callsThisStage <= FOUNDATION_SKIRT_SEGMENT_UNITS_PER_STAGE,
            `one perimeter stage projected ${callsThisStage} coordinates`,
        );
        assert.equal(outcome.value.phase, 'foundation-skirt-segments');
        yieldedStages += 1;
        outcome = iterator.next();
    }
    assert.ok(yieldedStages >= 10, 'the multipart perimeter must span queue visits');
    assert.deepEqual(outcome.value, expected);
});

test('runtime skirt sampling can yield after every terrain piece', () => {
    let sampleCalls = 0;
    const iterator = buildFoundationSkirtPositionsCooperative(
        [{ ax: 0, az: 0, bx: 24, bz: 0, normalX: 0, normalZ: -1 }],
        0,
        () => {
            sampleCalls += 1;
            return -1;
        },
        { maxSegmentM: 6, piecesPerStage: 1 },
    );
    let outcome = iterator.next();
    let previousCalls = 0;
    let yieldedStages = 0;
    while (!outcome.done) {
        assert.ok(sampleCalls - previousCalls <= 2, 'one stage samples at most one piece');
        previousCalls = sampleCalls;
        assert.equal(outcome.value.phase, 'foundation-skirt-geometry');
        yieldedStages += 1;
        outcome = iterator.next();
    }
    assert.equal(yieldedStages, 3);
    assert.equal(outcome.value.triangleCount, 8);
});

test('missing footprint coordinates stay absent instead of becoming zero', () => {
    const segments = foundationSegmentsFromFootprint({
        type: 'Polygon',
        coordinates: [[[null, 0], [10, 0], [10, 10], [null, 0]]],
    }, (lon, lat) => ({ x: lon, z: lat }));
    assert.equal(segments.length, 0);
});

test('flat ground at the base emits no skirt', () => {
    const result = buildFoundationSkirtPositions(squareSegments(), 0, () => 0);
    assert.equal(result.triangleCount, 0);
    assert.equal(result.positions.length, 0);
});

test('terrain within the flat epsilon of the base emits no skirt', () => {
    const justBelow = -(SKIRT_FLAT_EPSILON_M * 0.5);
    const result = buildFoundationSkirtPositions(squareSegments(), 0, () => justBelow);
    assert.equal(result.triangleCount, 0);
});

test('terrain a clear step below the base skirts every edge', () => {
    // 0.5 m below the base on all four corners → beyond the flat epsilon.
    const result = buildFoundationSkirtPositions(squareSegments(), 0, () => -0.5);
    // 4 edges × 2 triangles.
    assert.equal(result.triangleCount, 8);
    assert.equal(result.positions.length, 8 * 9);
    assert.ok(allFinite(result.positions));
});

test('a linear slope keeps the top edge flat and drops the bottom edge per corner', () => {
    // Terrain falls 0.1 m per metre of +x: max over the footprint is at x=0.
    const sampler = (x) => -x * 0.1;
    const topSceneY = 0;
    const result = buildFoundationSkirtPositions(squareSegments(), topSceneY, sampler);

    // The (0,10)->(0,0) edge sits entirely at the base (both corners x=0), so it
    // is skipped; the other three edges each emit two triangles.
    assert.equal(result.triangleCount, 6);
    assert.ok(allFinite(result.positions));

    // Every vertex is either on the flat top (y == topSceneY) or on the terrain
    // the sampler reports for that XZ corner — never above the top.
    for (let i = 0; i < result.positions.length; i += 3) {
        const x = result.positions[i];
        const y = result.positions[i + 1];
        assert.ok(y <= topSceneY + 1e-9, `vertex y ${y} must not exceed the base`);
        const onTop = Math.abs(y - topSceneY) < 1e-9;
        const onTerrain = Math.abs(y - sampler(x)) < 1e-9;
        assert.ok(onTop || onTerrain, `vertex y ${y} at x ${x} is neither base nor terrain`);
    }

    // The tallest part of the band is under the downhill corner (x=10 → -1 m).
    let lowest = Infinity;
    for (let i = 1; i < result.positions.length; i += 3) lowest = Math.min(lowest, result.positions[i]);
    assert.ok(Math.abs(lowest - (-1)) < 1e-9);
});

test('winds each band outward using the segment normal', () => {
    const geometricNormal = (positions) => {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(0, 9);
        const e1 = [bx - ax, by - ay, bz - az];
        const e2 = [cx - ax, cy - ay, cz - az];
        return [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
    };
    const sampler = () => -1;

    const outwardMinusZ = buildFoundationSkirtPositions(
        [{ ax: 0, az: 0, bx: 10, bz: 0, normalX: 0, normalZ: -1 }],
        0,
        sampler,
    );
    const n1 = geometricNormal(outwardMinusZ.positions);
    assert.ok(n1[2] < 0, 'first triangle must face -z as the normal asks');
    assert.equal(n1[1], 0, 'a vertical band has no vertical facing');

    // Same edge, opposite outward normal → the winding flips so it still faces
    // the way the normal points.
    const outwardPlusZ = buildFoundationSkirtPositions(
        [{ ax: 0, az: 0, bx: 10, bz: 0, normalX: 0, normalZ: 1 }],
        0,
        sampler,
    );
    const n2 = geometricNormal(outwardPlusZ.positions);
    assert.ok(n2[2] > 0, 'flipped winding must face +z');

    // Emitted per-vertex normals are the outward horizontal direction.
    for (let i = 0; i < outwardMinusZ.normals.length; i += 3) {
        assert.equal(outwardMinusZ.normals[i], 0);
        assert.equal(outwardMinusZ.normals[i + 1], 0);
        assert.equal(outwardMinusZ.normals[i + 2], -1);
    }
});

test('returns empty results for degenerate input instead of throwing', () => {
    assert.equal(buildFoundationSkirtPositions(null, 0, () => 0).triangleCount, 0);
    assert.equal(buildFoundationSkirtPositions(squareSegments(), NaN, () => 0).triangleCount, 0);
    assert.equal(buildFoundationSkirtPositions(squareSegments(), 0, null).triangleCount, 0);
});

test('a long wall across a mid-edge dip emits a band once subdivided', () => {
    // One 60 m edge, both corners flush with the base, terrain dipping 4 m at
    // the middle — the endpoint-only contract emits nothing (the historical
    // see-through hole), subdivision samples the dip and closes it.
    const segments = [{ ax: 0, az: 0, bx: 60, bz: 0, normalX: 0, normalZ: -1 }];
    const dip = (x) => -4 * Math.max(0, 1 - Math.abs(x - 30) / 20);
    const legacy = buildFoundationSkirtPositions(segments, 0, (x) => dip(x));
    assert.equal(legacy.triangleCount, 0, 'endpoint-only sampling misses the dip');
    const subdivided = buildFoundationSkirtPositions(segments, 0, (x) => dip(x), { maxSegmentM: 6 });
    assert.ok(subdivided.triangleCount >= 10, `dip must be banded, got ${subdivided.triangleCount}`);
    // Band bottoms follow the dip: the lowest emitted Y reaches the dip floor.
    let minY = Infinity;
    for (let i = 1; i < subdivided.positions.length; i += 3) {
        minY = Math.min(minY, subdivided.positions[i]);
    }
    assert.ok(minY <= -3.5, `band bottom must reach the dip, got ${minY}`);
});

test('cooperative skirt sampling is bounded and byte-identical to the synchronous result', () => {
    const segments = [{ ax: 0, az: 0, bx: 96, bz: 0, normalX: 0, normalZ: -1 }];
    const sample = (x) => -1 - Math.sin(x / 8);
    const options = { maxSegmentM: 1, plungeM: 0.5 };
    const expected = buildFoundationSkirtPositions(segments, 0, sample, options);

    let sampleCalls = 0;
    const iterator = buildFoundationSkirtPositionsCooperative(
        segments,
        0,
        (x, z) => {
            sampleCalls += 1;
            return sample(x, z);
        },
        options,
    );
    let outcome;
    let previousCalls = 0;
    let yieldedStages = 0;
    do {
        outcome = iterator.next();
        const callsThisStage = sampleCalls - previousCalls;
        previousCalls = sampleCalls;
        assert.ok(
            callsThisStage <= FOUNDATION_SKIRT_PIECES_PER_STAGE * 2,
            `one stage sampled ${callsThisStage} endpoints`,
        );
        if (!outcome.done) {
            yieldedStages += 1;
            assert.equal(outcome.value.phase, 'foundation-skirt-geometry');
        }
    } while (!outcome.done);

    assert.ok(yieldedStages >= 2, 'the dense edge must span several queue visits');
    assert.deepEqual(outcome.value, expected);
});

test('foundation buffer conversion is cooperative and applies the publish offset once', () => {
    const segments = [{ ax: 0, az: 0, bx: 2048, bz: 0, normalX: 0, normalZ: -1 }];
    const geometryData = buildFoundationSkirtPositions(
        segments,
        12,
        () => 8,
        { maxSegmentM: 1 },
    );
    const iterator = prepareFoundationSkirtBuffersCooperative(
        geometryData,
        { positionYOffsetY: -12 },
    );
    let outcome = iterator.next();
    let yieldedStages = 0;
    while (!outcome.done) {
        yieldedStages += 1;
        assert.equal(outcome.value.phase, 'foundation-skirt-buffer');
        outcome = iterator.next();
    }

    const expectedPositions = Float32Array.from(
        geometryData.positions,
        (value, index) => value + (index % 3 === 1 ? -12 : 0),
    );
    assert.deepEqual(outcome.value.positions, expectedPositions);
    assert.deepEqual(outcome.value.normals, Float32Array.from(geometryData.normals));
    assert.deepEqual(outcome.value.uvs, Float32Array.from(geometryData.uvs));
    assert.equal(outcome.value.triangleCount, geometryData.triangleCount);
    const totalValues = geometryData.positions.length
        + geometryData.normals.length
        + geometryData.uvs.length;
    assert.ok(
        yieldedStages >= Math.floor(totalValues / FOUNDATION_SKIRT_BUFFER_VALUES_PER_STAGE),
        'a dense immutable buffer must span several bounded queue visits',
    );
});

test('runtime buffer conversion can release each staged source representation', () => {
    const geometryData = buildFoundationSkirtPositions(
        [{ ax: 0, az: 0, bx: 24, bz: 0, normalX: 0, normalZ: -1 }],
        4,
        () => 1,
        { maxSegmentM: 1 },
    );
    const expectedPositionCount = geometryData.positions.length;
    const expectedNormalCount = geometryData.normals.length;
    const expectedUvCount = geometryData.uvs.length;
    const iterator = prepareFoundationSkirtBuffersCooperative(
        geometryData,
        { consumeSource: true },
    );
    let outcome = iterator.next();
    while (!outcome.done) outcome = iterator.next();

    assert.equal(geometryData.positions, null);
    assert.equal(geometryData.normals, null);
    assert.equal(geometryData.uvs, null);
    assert.equal(outcome.value.positions.length, expectedPositionCount);
    assert.equal(outcome.value.normals.length, expectedNormalCount);
    assert.equal(outcome.value.uvs.length, expectedUvCount);
});

test('plunge tucks band bottoms below the sample but never below flat ground', () => {
    const segments = squareSegments();
    // Sloped: one side 2 m down. With plunge, bottoms sink an extra metre.
    const slope = (x) => (x >= 5 ? -2 : 0);
    const plunged = buildFoundationSkirtPositions(segments, 0, (x) => slope(x), { plungeM: 1 });
    assert.ok(plunged.triangleCount > 0);
    let minY = Infinity;
    for (let i = 1; i < plunged.positions.length; i += 3) minY = Math.min(minY, plunged.positions[i]);
    assert.ok(Math.abs(minY - -3) < 1e-9, `expected -3 (sample -2 - plunge 1), got ${minY}`);
    // Flat ground still emits nothing — the skip is judged before the plunge.
    const flat = buildFoundationSkirtPositions(segments, 0, () => 0, { plungeM: 1 });
    assert.equal(flat.triangleCount, 0);
});

test('a structural floor clamps blind burial without removing the visible skirt', () => {
    const segments = [{ ax: 0, az: 0, bx: 10, bz: 0, normalX: 0, normalZ: -1 }];
    const result = buildFoundationSkirtPositions(
        segments,
        5,
        () => 3,
        {
            plungeM: 3,
            minimumBottomYAtLocal: (x) => (x >= 5 ? 2 : NaN),
        },
    );
    assert.equal(result.triangleCount, 2);
    const bottomAtA = [];
    const bottomAtB = [];
    for (let index = 0; index < result.positions.length; index += 3) {
        const x = result.positions[index];
        const y = result.positions[index + 1];
        if (y >= 5 - 1e-9) continue;
        (x < 5 ? bottomAtA : bottomAtB).push(y);
    }
    assert.ok(bottomAtA.every(y => Math.abs(y - 0) < 1e-9),
        'ordinary soil keeps the complete three-metre burial');
    assert.ok(bottomAtB.every(y => Math.abs(y - 2) < 1e-9),
        'the tunnel-side endpoint stops at the structural roof');
});

test('the composed sampler drops to a benched street only near the skip zone', () => {
    // Raw terrain flush with the base along a street edge (the historical
    // skip), engineered street 2 m below. The composed sampler must return the
    // street there — and must NOT pay the formation query where the raw band
    // is already clearly emitted (downhill side).
    let formationQueries = 0;
    const sampler = composeFoundationGroundSampler({
        terrainAt: (x) => (x < 0 ? -5 : 0),        // downhill west, flush east
        formationAts: [(x) => { formationQueries += 1; return x >= 0 ? -2 : null; }],
        topSceneY: 0,
    });
    assert.equal(sampler(-10, 0), -5, 'clearly-banded side keeps raw terrain');
    assert.equal(formationQueries, 0, 'no formation query where the band is already deep');
    assert.equal(sampler(10, 0), -2, 'flush side drops to the benched street');
    // Null from a formation is ABSENT, never 0.
    const nullSafe = composeFoundationGroundSampler({
        terrainAt: () => 0,
        formationAts: [() => null],
        topSceneY: 0,
    });
    assert.equal(nullSafe(0, 0), 0);
});

test('an engineered surface on a different LEVEL never drags the skirt down', () => {
    // Formation queries are 2D: a building on the hill over a bored tunnel is
    // within the query radius of the alignment while the trackbed runs 15 m
    // below inside the hill. Draping to it hung a concrete band across the
    // bore interior — the refinement only ever means "the street beside me is
    // benched a little below the grid", so a deep answer must be ignored...
    const overBore = composeFoundationGroundSampler({
        terrainAt: () => 0,
        formationAts: [() => -15],   // trackbed of the bore under the hill
        topSceneY: 0,
    });
    assert.equal(overBore(0, 0), 0, 'the bore under the hill is not this ground');
    // ...while a genuinely benched street (a couple of metres) still wins.
    const benched = composeFoundationGroundSampler({
        terrainAt: () => 0,
        formationAts: [() => -2],
        topSceneY: 0,
    });
    assert.equal(benched(0, 0), -2, 'a benched street stays the visible ground');
});
