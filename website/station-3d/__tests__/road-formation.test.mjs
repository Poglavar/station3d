// Verifies engineered road grades independently of Three.js and browser APIs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFormationSurfaceProfile,
    buildFormationSurfaceProfileSteps,
    buildFormationSurfaceApronGeometryData,
    buildFormationTerrainCollarGeometryData,
    buildFormationTerrainCollarPositions,
    buildRetainingWallPositions,
    buildWallFaceUvsForPositions,
    buildWorldXZUvsForPositions,
    buildRoadSurfaceTerrainIntrusionRegions,
    cutBenchReachMeters,
    formationDressingSurfaceYAtLocal,
    formationTerrainCutoutMaskRegions,
    formationTerrainCutoutMaskRings,
    refineRingByRelief,
    refineTriangulatedSurface,
    refineTriangulatedSurfaceSteps,
    roadSurfaceUsesEngineeredFormation,
    RoadFormationModel,
    suppressDuplicateSharedRetainingWallSegments,
} from '../core/road-formation.js';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { pointInRing } from '../core/mask-query.js';

const ANCHOR_LAT = 43.5;
const ANCHOR_LON = 16.4;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

test('resumable formation profiles yield expensive sampling and equal the synchronous API', () => {
    const innerRing = [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: 8 },
        { x: 0, z: 8 },
    ];
    let terrainCalls = 0;
    const iterator = buildFormationSurfaceProfileSteps({
        innerRing,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: () => {
            if (terrainCalls++ === 0) {
                const deadline = performance.now() + 2;
                while (performance.now() < deadline) { /* force one budget boundary */ }
            }
            return 0;
        },
    });
    const phases = [];
    let outcome = iterator.next();
    while (!outcome.done) {
        phases.push(outcome.value?.phase);
        outcome = iterator.next();
    }
    assert.ok(phases.includes('relief'));
    assert.deepEqual(outcome.value, buildFormationSurfaceProfile({
        innerRing,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: () => 0,
    }));
});

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function centerline(osmId, points, highway = 'residential') {
    return {
        type: 'Feature',
        properties: { osm_id: osmId, highway },
        geometry: { type: 'LineString', coordinates: points.map(([x, z]) => lonLat(x, z)) },
    };
}

function surface(osmId, points, highwayType = 'residential') {
    const coordinates = points.map(([x, z]) => lonLat(x, z));
    coordinates.push(coordinates[0]);
    return {
        type: 'Feature',
        properties: { osm_id: osmId, highway_type: highwayType, railway_type: null },
        geometry: { type: 'Polygon', coordinates: [coordinates] },
    };
}

function multiSurface(osmId, polygons, highwayType = 'residential') {
    return {
        type: 'Feature',
        properties: { osm_id: osmId, highway_type: highwayType, railway_type: null },
        geometry: {
            type: 'MultiPolygon',
            coordinates: polygons.map((points) => {
                const coordinates = points.map(([x, z]) => lonLat(x, z));
                coordinates.push(coordinates[0]);
                return [coordinates];
            }),
        },
    };
}

function modelWith(features, baseSceneYAtLocal = (x, z) => x * 0.1 + z * 0.5) {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal,
    });
    model.setCenterlineTile('0_0', features.centerlines);
    model.setSurfaceTile('0_0', features.surfaces);
    return model;
}

function triangleArea(points, triangle) {
    const [a, b, c] = triangle.map((index) => points[index]);
    return Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) * 0.5;
}

test('road civil ground exposes ordinary formation tops but not carried structures', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadStructureAtLocal: x => (x < 0 ? { kind: 'overpass' } : null),
    });
    model.setCenterlineTile('0_0', [
        centerline(1, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('0_0', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    assert.equal(model.civilGroundSceneYAtLocal(-10, 0, {
        surfaceOffsetYAtProfile: () => 0.025,
    }), null, 'a bridge deck is a structure, not ground for the next authority');
    assert.ok(Math.abs(model.civilGroundSceneYAtLocal(10, 0, {
        surfaceOffsetYAtProfile: () => 0.025,
    }) - 0.025) < 1e-9);
    assert.equal(model.civilGroundSceneYAtLocal(0, 100), null,
        'outside the authored road envelope, the earlier ground owner remains in force');
});

test('a later civil work can sample the visible surface of an earlier formation', () => {
    const point = (innerX, innerZ, outerX, outerZ) => ({
        innerX,
        innerZ,
        roadY: 4,
        outerX,
        outerZ,
        terrainY: 0,
        wallTerrainY: -0.1,
        cutoutX: outerX + Math.sign(outerX || 1) * 0.25,
        cutoutZ: outerZ,
        cutoutTerrainY: 0,
        overlapX: outerX + Math.sign(outerX || 1) * 0.5,
        overlapZ: outerZ,
        overlapTerrainY: 0,
    });
    const profile = {
        points: [
            point(-1, -10, -3, -10),
            point(1, -10, 3, -10),
            point(1, 10, 3, 10),
            point(-1, 10, -3, 10),
        ],
        internalSegments: [false, false, false, false],
        collarInternalSegments: [false, false, false, false],
        roadOpeningSegmentRanges: [[], [], [], []],
    };

    assert.ok(Math.abs(formationDressingSurfaceYAtLocal(profile, 2, 0) - 2) < 1e-9,
        'the midpoint of the 4 m batter must be 2 m high');
    assert.equal(formationDressingSurfaceYAtLocal(profile, 8, 0), null);
    profile.wallTopUnderlapM = 0.2;
    assert.ok(Math.abs(
        formationDressingSurfaceYAtLocal(profile, 2, 0) - 2,
    ) < 1e-9, 'the hidden flange must not move the visible wall/civil plane');
    const underlappedWall = buildRetainingWallPositions(profile);
    assert.ok(underlappedWall.some((value, index) => (
        index % 3 === 0
        && Math.abs(value - 0.8) < 1e-9
        && Math.abs(underlappedWall[index + 1] - 4) < 1e-9
    )), 'the retained face must extend 20 cm underneath its owning top surface');
    for (const point of profile.points) point.surfaceApronWidthM = 0.8;
    const apron = buildFormationSurfaceApronGeometryData(profile, 0.075);
    assert.equal(apron.positions.length, profile.points.length * 18);
    assert.equal(apron.uvs.length, profile.points.length * 12);
    assert.ok(apron.positions
        .filter((_value, index) => index % 3 === 1)
        .every(value => Math.abs(value - 4.075) < 1e-9),
    'the apron must be the level opaque top between its surface and formation edge');
    profile.internalSegments[1] = true;
    assert.equal(
        buildFormationSurfaceApronGeometryData(profile, 0.075).positions.length,
        (profile.points.length - 1) * 18,
        'an intentional formation opening must remove its apron as well as its wall',
    );
    assert.equal(formationDressingSurfaceYAtLocal(profile, 2, 0), null,
        'a surface suppressed by an explicit ownership opening is not consumable');
});

test('refines long road triangles with shared vertices and preserves their area', () => {
    const sourcePoints = [
        { x: 0, z: 0 },
        { x: 120, z: 0 },
        { x: 120, z: 8 },
        { x: 0, z: 8 },
    ];
    const refined = refineTriangulatedSurface(
        sourcePoints,
        [[0, 1, 2], [0, 2, 3]],
        6,
    );
    assert.ok(refined.points.length > sourcePoints.length);
    assert.ok(refined.triangles.length > 2);
    let area = 0;
    for (const triangle of refined.triangles) {
        area += triangleArea(refined.points, triangle);
        for (let edge = 0; edge < 3; edge++) {
            const a = refined.points[triangle[edge]];
            const b = refined.points[triangle[(edge + 1) % 3]];
            assert.ok(Math.hypot(b.x - a.x, b.z - a.z) <= 6 + 1e-6);
        }
    }
    assert.ok(Math.abs(area - 120 * 8) < 1e-6);
    assert.deepEqual(refined.points.slice(0, 4), sourcePoints);
});

test('stops only at a complete refinement pass when a triangle budget is reached', () => {
    const sourcePoints = [
        { x: 0, z: 0 },
        { x: 200, z: 0 },
        { x: 200, z: 200 },
        { x: 0, z: 200 },
    ];
    const refined = refineTriangulatedSurface(
        sourcePoints,
        [[0, 1, 2], [0, 2, 3]],
        1,
        64,
    );
    assert.ok(refined.triangles.length <= 64);
    const area = refined.triangles.reduce(
        (sum, triangle) => sum + triangleArea(refined.points, triangle),
        0,
    );
    assert.ok(Math.abs(area - 40_000) < 1e-6, `budgeted surface lost area: ${area}`);
});

test('resumable surface refinement yields bounded work and equals the synchronous API', () => {
    const sourcePoints = [
        { x: 0, z: 0 },
        { x: 200, z: 0 },
        { x: 200, z: 200 },
        { x: 0, z: 200 },
    ];
    const sourceTriangles = [[0, 1, 2], [0, 2, 3]];
    const steps = refineTriangulatedSurfaceSteps(
        sourcePoints,
        sourceTriangles,
        1,
        64,
        { trianglesPerYield: 1 },
    );
    const phases = [];
    let outcome = steps.next();
    while (!outcome.done) {
        phases.push(outcome.value?.phase);
        outcome = steps.next();
    }

    assert.ok(phases.length > 1, 'a dense refinement must expose multiple resumable slices');
    assert.ok(phases.every((phase) => phase === 'surface-refinement'));
    assert.deepEqual(
        outcome.value,
        refineTriangulatedSurface(sourcePoints, sourceTriangles, 1, 64),
    );
});

test('keeps a road cross-section level while its centerline follows terrain longitudinally', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });

    assert.ok(Math.abs(model.sceneYAtLocal(5, -3, { osmId: 1 }) - 0.5) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(5, 3, { osmId: 1 }) - 0.5) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(-10, 0, { osmId: 1 }) + 1) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(10, 0, { osmId: 1 }) - 1) < 1e-6);
});

test('terrain invalidation clears every terrain-derived formation cache', () => {
    let terrainOffset = 0;
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, () => terrainOffset);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6);
    // Populate both the longitudinal grade and surface-profile caches.
    assert.equal(model.getSurfaceProfilesForOsmId(1).length, 1);
    const revision = model.revision;

    terrainOffset = 12;
    model.invalidateTerrain([{ minX: -25, minZ: -8, maxX: 25, maxZ: 8 }]);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 12) < 1e-6);
    assert.ok(model.getSurfaceProfilesForOsmId(1).every(profile => (
        profile.points.every(point => Math.abs(point.terrainY - 12) < 1e-6)
    )));
    assert.deepEqual(model.getChangesSince(revision), {
        revision: revision + 1,
        full: false,
        bounds: [{ minX: -25, minZ: -8, maxX: 25, maxZ: 8 }],
    });
});

test('formation consumers can retain a complete generation while a rebuild is pending', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });
    assert.equal(model.hasPendingBuild(), true);
    assert.equal(model.getSurfaceProfiles().length, 1);
    assert.equal(model.hasPendingBuild(), false);
    model.invalidateTerrain([{ minX: -25, minZ: -8, maxX: 25, maxZ: 8 }]);
    assert.equal(model.hasPendingBuild(), true);
});

test('published surface queries retain the complete generation without consuming a pending build', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });
    assert.equal(model.surfaceAtLocal(0, 0)?.osmId, '1');

    model.setCenterlineTile('far', [centerline(2, [[180, 0], [220, 0]])]);
    model.setSurfaceTile('far', [
        surface(2, [[180, -4], [220, -4], [220, 4], [180, 4]]),
    ]);
    assert.equal(model.hasPendingBuild(), true);
    assert.equal(model.publishedSurfaceAtLocal(0, 0)?.osmId, '1');
    assert.equal(model.publishedSurfaceAtLocal(200, 0), null);
    assert.equal(model.hasPendingBuild(), true,
        'a published query must not synchronously consume the pending generation');

    assert.equal(model.surfaceAtLocal(200, 0)?.osmId, '2');
    assert.equal(model.hasPendingBuild(), false);
});

test('pending formation preparation yields by road without publishing a partial generation', () => {
    let sampledRoadsThisStep = new Set();
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, (x) => {
        sampledRoadsThisStep.add(x < 100 ? 1 : x < 300 ? 2 : 3);
        return x * 0.01;
    });
    assert.equal(model.getSurfaceProfilesForOsmId(1).length, 1);

    model.setCenterlineTile('far', [
        centerline(2, [[180, 0], [220, 0]]),
        centerline(3, [[380, 0], [420, 0]]),
    ]);
    model.setSurfaceTile('far', [
        surface(2, [[180, -4], [220, -4], [220, 4], [180, 4]]),
        surface(3, [[380, -4], [420, -4], [420, 4], [380, 4]]),
    ]);
    assert.equal(model.hasPendingBuild(), true);
    assert.deepEqual(
        model.surfaceProfilesNear(200, 0, 30, { allowStale: true }),
        [],
        'the last complete generation stays published while caches prepare off-scene',
    );

    let status = 'more';
    let visits = 0;
    while (status === 'more') {
        sampledRoadsThisStep = new Set();
        status = model.stepPendingBuildPreparation();
        visits += 1;
        assert.ok(sampledRoadsThisStep.size <= 1,
            'one cooperative preparation visit sampled more than one road');
        assert.ok(visits < 500, 'bounded preparation must terminate');
        if (status === 'more') {
            assert.equal(model.hasPendingBuild(), true);
            assert.deepEqual(
                model.surfaceProfilesNear(200, 0, 30, { allowStale: true }),
                [],
                'no partial spatial index may leak between cooperative visits',
            );
        }
    }
    assert.equal(status, 'done');
    assert.ok(visits > 3, 'the next generation must be split across several visits');
    assert.equal(model.hasPendingBuild(), false);
    assert.equal(model.getSurfaceProfilesForOsmId(2).length, 1);
    assert.equal(model.getSurfaceProfilesForOsmId(3).length, 1);
});

test('pending formation preparation resumes inside one complex surface profile', () => {
    const ring = Array.from({ length: 360 }, (_, index) => {
        const angle = index / 360 * Math.PI * 2;
        return [Math.cos(angle) * 40, Math.sin(angle) * 40];
    });
    let terrainSamples = 0;
    const model = modelWith({
        centerlines: [centerline(91, [[-35, 0], [35, 0]])],
        surfaces: [surface(91, ring)],
    }, () => {
        terrainSamples += 1;
        // Force several profile-generator budget boundaries without making the
        // whole test slow. The production regression was one 149 ms road ring.
        if (terrainSamples % 180 === 1) {
            const deadline = performance.now() + 1.2;
            while (performance.now() < deadline) { /* exercise the slice */ }
        }
        return 0;
    });

    const profilePhases = [];
    let status = 'more';
    let visits = 0;
    while (status === 'more') {
        status = model.stepPendingBuildPreparation();
        profilePhases.push(model.pendingBuildPreparationPhase());
        visits += 1;
        assert.ok(visits < 5000, 'complex cooperative preparation did not finish');
    }

    assert.ok(
        profilePhases.some(phase => /surface-profiles .* (relief|points|finalize)/.test(phase)),
        'the outer formation task drained a complex profile instead of resuming its generator',
    );
    assert.equal(model.getSurfaceProfilesForOsmId(91).length, 1);
});

test('bounded terrain invalidation resamples only intersecting road profiles', () => {
    let nearGroundY = 0;
    const samples = { near: 0, far: 0 };
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]]),
            centerline(2, [[480, 0], [520, 0]]),
        ],
        surfaces: [
            surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
            surface(2, [[480, -4], [520, -4], [520, 4], [480, 4]]),
        ],
    }, (x) => {
        if (x < 100) {
            samples.near += 1;
            return nearGroundY;
        }
        samples.far += 1;
        return 20;
    });
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(500, 0, { osmId: 2 }) - 20) < 1e-6);
    const farProfile = model.getSurfaceProfilesForOsmId(2)[0];
    samples.near = 0;
    samples.far = 0;

    nearGroundY = 8;
    const affected = model.invalidateTerrain([
        { minX: -30, minZ: -10, maxX: 30, maxZ: 10 },
    ]);
    assert.deepEqual([...affected], ['1']);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 8) < 1e-6);
    assert.ok(samples.near > 0, 'the intersecting way must consume the new terrain');
    assert.equal(samples.far, 0, 'an unrelated way must not resample terrain');
    assert.equal(model.getSurfaceProfilesForOsmId(2)[0], farProfile,
        'the unrelated civil profile must remain cached by identity');
});

test('terrain-evidence invalidation re-solves the grade without changing raw terrain', () => {
    let evidenceY = 0;
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 30,
        terrainEvidenceSceneYAtLocal: () => evidenceY,
    });
    model.setCenterlineTile('roads', [centerline(1, [[-40, 0], [40, 0]])]);
    model.setSurfaceTile('roads', [
        surface(1, [[-40, -4], [40, -4], [40, 4], [-40, 4]]),
    ]);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6);

    evidenceY = 7;
    model.invalidateTerrainEvidence([{ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }]);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 7) < 1e-6);
    assert.equal(model.sceneYAtLocal(0, 100), 30, 'bare ground retains the real terrain');
});

test('cooperative grade rebuild keeps the published segment generation unchanged', () => {
    let evidenceY = 0;
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 30,
        terrainEvidenceSceneYAtLocal: () => evidenceY,
    });
    model.setCenterlineTile('roads', [centerline(1, [[-40, 0], [40, 0]])]);
    model.setSurfaceTile('roads', [
        surface(1, [[-40, -4], [40, -4], [40, 4], [-40, 4]]),
    ]);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6);

    evidenceY = 7;
    model.invalidateTerrainEvidence([{ minX: -10, minZ: -10, maxX: 10, maxZ: 10 }]);
    let status = 'more';
    let visits = 0;
    while (status === 'more') {
        status = model.stepPendingBuildPreparation();
        visits += 1;
        if (status === 'more') {
            assert.ok(Math.abs(model.sceneYAtLocal(0, 0, {
                osmId: 1,
                allowStale: true,
            })) < 1e-6, 'the unpublished grade leaked through cached segment identity');
        }
        assert.ok(visits < 500, 'bounded grade rebuild must terminate');
    }
    assert.equal(status, 'done');
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 7) < 1e-6);
});

test('composed-ground invalidation rebuilds only intersecting road profiles', () => {
    let nearGroundY = 0;
    const samples = { near: 0, far: 0 };
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]]),
            centerline(2, [[480, 0], [520, 0]]),
        ],
        surfaces: [
            surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
            surface(2, [[480, -4], [520, -4], [520, 4], [480, 4]]),
        ],
    }, (x) => {
        if (x < 100) {
            samples.near += 1;
            return nearGroundY;
        }
        samples.far += 1;
        return 20;
    });
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 })) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(500, 0, { osmId: 2 }) - 20) < 1e-6);
    const farProfile = model.getSurfaceProfilesForOsmId(2)[0];
    samples.near = 0;
    samples.far = 0;

    nearGroundY = 8;
    const affected = model.invalidateComposedGround([
        { minX: -30, minZ: -10, maxX: 30, maxZ: 10 },
    ]);
    assert.deepEqual([...affected], ['1']);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 0, { osmId: 1 }) - 8) < 1e-6);
    assert.ok(samples.near > 0, 'the intersecting way must consume the new ground');
    assert.equal(samples.far, 0, 'an unrelated way must not resample composed ground');
    assert.equal(model.getSurfaceProfilesForOsmId(2)[0], farProfile,
        'the unrelated civil profile must remain cached by identity');
});

test('composed-ground discovery is resumable and commits one atomic revision', () => {
    const centerlines = [];
    const surfaces = [];
    for (let index = 0; index < 150; index++) {
        const x = index * 20;
        centerlines.push(centerline(index + 1, [[x, 0], [x + 10, 0]]));
        surfaces.push(surface(index + 1, [[x, -4], [x + 10, -4], [x + 10, 4], [x, 4]]));
    }
    const model = modelWith({ centerlines, surfaces }, () => 0);
    model.getSurfaceProfiles();
    const revisionBefore = model.revision;
    const task = model.invalidateComposedGroundSteps([
        { minX: -10, minZ: -10, maxX: 4000, maxZ: 10 },
    ], { scanPerStep: 10 });
    let outcome = task.next();
    let steps = 0;
    while (!outcome.done) {
        steps += 1;
        assert.equal(model.revision, revisionBefore,
            'read-only discovery must not leak a partial invalidation');
        outcome = task.next();
    }
    assert.ok(steps >= 30, 'large centerline/profile scans were not split');
    assert.equal(outcome.value.size, 150);
    assert.equal(model.revision, revisionBefore + 1);
});

test('missing upper-deck evidence is interpolated from street grade on both sides', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: x => (Math.abs(x) < 12 ? 15 : (x < 0 ? 0 : 2)),
        terrainEvidenceSceneYAtLocal: x => (
            Math.abs(x) < 12 ? null : (x < 0 ? 0 : 2)
        ),
    });
    model.setCenterlineTile('roads', [centerline(1, [[-60, 0], [60, 0]])]);
    model.setSurfaceTile('roads', [
        surface(1, [[-60, -4], [60, -4], [60, 4], [-60, 4]]),
    ]);

    const crossingY = model.sceneYAtLocal(0, 0, { osmId: 1 });
    assert.ok(crossingY > 0 && crossingY < 2);
    assert.ok(crossingY < 5, `upper rail deck leaked into lower road grade: ${crossingY}`);
});

test('smooths a short terrain spike out of the longitudinal road grade', () => {
    const terrain = (x) => x * 0.02 + (Math.abs(x) < 1 ? 4 : 0);
    const model = modelWith({
        centerlines: [centerline(1, [[-60, 0], [60, 0]])],
        surfaces: [surface(1, [[-60, -4], [60, -4], [60, 4], [-60, 4]])],
    }, terrain);

    const roadY = model.sceneYAtLocal(0, 0, { osmId: 1 });
    // The spike is 4 m; the smoothed grade through x=0 is 0.02 * 0, i.e. exactly
    // zero. Bounding this as `roadY > 0` assumed the smoothing would land a hair
    // above zero, so a correct result arrived as -1.04e-16 and failed. What the
    // test is actually for is that the spike does not reach the road, so bound
    // the DISTANCE from the smoothed grade: leak the 4 m through and this fails.
    assert.ok(Math.abs(roadY) < 1,
        `short 4 m terrain spike should become cut/fill, not road grade (got ${roadY})`);
});

test('requires the buffered surface for a walk floor and falls back to bare terrain outside it', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });

    assert.ok(Math.abs(model.sceneYAtLocal(5, 3, { requireSurface: true }) - 0.5) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(5, 10, { requireSurface: true }) - 5.5) < 1e-6);
});

test('a stale-safe frame query keeps the published road generation until builders refresh it', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadYOverrideAtLocal: (_x, _z, osmId, baseY) => (
            String(osmId) === '1' ? 3 : String(osmId) === '2' ? 12 : baseY
        ),
    });
    model.setCenterlineTile('0_0', [centerline(1, [[-20, 0], [20, 0]])]);
    model.setSurfaceTile('0_0', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);
    assert.equal(model.sceneYAtLocal(0, 0, { requireSurface: true }), 3);

    model.setCenterlineTile('1_0', [centerline(2, [[80, 0], [120, 0]])]);
    model.setSurfaceTile('1_0', [
        surface(2, [[80, -4], [120, -4], [120, 4], [80, 4]]),
    ]);

    assert.equal(model.sceneYAtLocal(0, 0, {
        requireSurface: true,
        allowStale: true,
    }), 3, 'the previous generation stays queryable while the next one is dirty');
    assert.equal(model.sceneYAtLocal(100, 0, {
        requireSurface: true,
        allowStale: true,
    }), 0, 'a stale-safe query must not synchronously compile the newly arrived tile');
    assert.equal(model.civilGroundSceneYAtLocal(0, 0, {
        allowStale: true,
    }), 3, 'curb/derived geometry can still consume the published civil surface');
    assert.equal(model.civilGroundSceneYAtLocal(100, 0, {
        allowStale: true,
    }), null, 'the unpublished civil surface does not leak through the stale-safe query');
    assert.equal(model.hasPendingBuild(), true,
        'a raised-side landing query must not synchronously finish the dirty generation');
    assert.equal(model.sceneYAtLocal(100, 0, { requireSurface: true }), 12,
        'the ordinary builder query still publishes the current generation');
});

test('an at-grade road does not manufacture a grey batter apron on either side', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, () => 0);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.equal(profile.formationDressingDisabled, true);
    assert.equal(profile.terrainCutoutDisabled, true);
    assert.equal(buildRetainingWallPositions(profile, 0.02).length, 0);
    assert.equal(buildFormationTerrainCollarPositions(profile).length, 0);
    assert.equal(model.hasDressedSurfaceBoundaryAtLocal(0, 4.8, { osmIds: [1] }), false);
});

test('a parking aisle drapes on its lot instead of cutting a civil formation hole', () => {
    const parkingAisle = surface(
        1,
        [[-20, -8], [20, -8], [20, 8], [-20, 8]],
        'service',
    );
    parkingAisle.properties.tags = { service: 'parking_aisle' };
    const ordinaryService = surface(
        2,
        [[-20, 16], [20, 16], [20, 24], [-20, 24]],
        'service',
    );

    assert.equal(roadSurfaceUsesEngineeredFormation(parkingAisle), false);
    assert.equal(roadSurfaceUsesEngineeredFormation(ordinaryService), true);

    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]], 'service'),
            centerline(2, [[-20, 20], [20, 20]], 'service'),
        ],
        surfaces: [parkingAisle, ordinaryService],
    });
    assert.deepEqual(model.getSurfaceProfilesForOsmId(1), []);
    assert.equal(model.getSurfaceProfilesForOsmId(2).length, 1);
});

test('a genuinely raised road keeps its civil face and collar without deleting terrain below', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadYOverrideAtLocal: () => 1.2,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.equal(profile.formationDressingDisabled, false);
    assert.equal(profile.terrainCutoutDisabled, false);
    assert.deepEqual(profile.terrainExcavationRegions, []);
    assert.deepEqual(
        formationTerrainCutoutMaskRegions(profile),
        [],
        'a fill is additive civil work over the supplied terrain',
    );
    assert.ok(buildRetainingWallPositions(profile, 0.02).length > 0);
    assert.ok(buildRetainingWallPositions(profile, 0.02, { faceKind: 'fill' }).length > 0);
    assert.equal(buildRetainingWallPositions(profile, 0.02, { faceKind: 'cut' }).length, 0);
    assert.ok(buildRetainingWallPositions(profile, 0.02, { faceKind: 'earth' }).length > 0);
    assert.equal(buildRetainingWallPositions(profile, 0.02, { faceKind: 'retaining' }).length, 0);
    assert.ok(buildFormationTerrainCollarPositions(profile).length > 0);
    assert.equal(model.hasDressedSurfaceBoundaryAtLocal(0, 4.8, { osmIds: [1] }), true);
    assert.equal(model.hasDressedSurfaceBoundaryAtLocal(0, 8, { osmIds: [1] }), false);
    assert.equal(model.hasDressedSurfaceBoundaryAtLocal(0, 4.8, { osmIds: [2] }), false);
});

test('an opaque terrain replacement closes a fill toe without a duplicate collar flap', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        baseTerrainReplacementAtLocal: () => true,
        roadYOverrideAtLocal: () => 1.2,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainReplacementBackstopSegments.every(Boolean));
    assert.equal(buildFormationTerrainCollarPositions(profile).length, 0);
    assert.ok(buildRetainingWallPositions(profile, 0.02, { faceKind: 'fill' }).length > 0,
        'the road still keeps the earth face that meets the replacement surface');
});

test('a terrain replacement does not suppress the collar required by a real cut', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 4,
        baseTerrainReplacementAtLocal: () => true,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainReplacementBackstopSegments.every(value => !value));
    assert.ok(buildFormationTerrainCollarPositions(profile).length > 0);
});

test('terrain collar and earth face have one compatible textured batch schema', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadYOverrideAtLocal: () => 1.2,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    const collar = buildFormationTerrainCollarGeometryData(profile);
    const earthPositions = buildRetainingWallPositions(profile, 0.02, { faceKind: 'earth' });
    const uvPerM = 1 / 3;
    const earthUvs = buildWorldXZUvsForPositions(earthPositions, uvPerM);
    const collarUvs = Float32Array.from(collar.uvs, value => value * uvPerM);
    const normalsFor = positions => new Float32Array(positions.length);
    const batcher = createGeometryBatcher();

    batcher.addPart('terrain-collar', 'road:1', {
        attributes: {
            position: Float32Array.from(collar.positions),
            normal: normalsFor(collar.positions),
            uv: collarUvs,
        },
    });
    assert.doesNotThrow(() => batcher.addPart('terrain-collar', 'road:1', {
        attributes: {
            position: Float32Array.from(earthPositions),
            normal: normalsFor(earthPositions),
            uv: earthUvs,
        },
    }));

    const merged = batcher.assemble('terrain-collar');
    assert.equal(
        merged.vertexCount,
        collar.positions.length / 3 + earthPositions.length / 3,
    );
    assert.equal(merged.attributes.uv.length, merged.vertexCount * 2);
    for (let vertex = 0; vertex < earthPositions.length / 3; vertex++) {
        assert.ok(Math.abs(earthUvs[vertex * 2] - earthPositions[vertex * 3] * uvPerM) < 1e-6);
        assert.ok(Math.abs(earthUvs[vertex * 2 + 1]
            - earthPositions[vertex * 3 + 2] * uvPerM) < 1e-6);
    }
});

test('retaining-wall UVs follow the wall tangent and absolute height in metres', () => {
    const positions = [
        4, 1, -3,
        4, 4, -3,
        4, 1, 2,
    ];
    const uvs = buildWallFaceUvsForPositions(positions);
    assert.equal(uvs.length, 6);
    assert.deepEqual(
        [uvs[1], uvs[3], uvs[5]],
        [1, 4, 1],
        'V must stay locked to world height',
    );
    assert.ok(Math.abs(Math.abs(uvs[4] - uvs[0]) - 5) < 1e-6,
        'U must carry the full five-metre Z-running wall length');
});

test('a sustained road cut removes terrain only along the measured run', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 4,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainExcavationRegions.length > 0);
    const regions = formationTerrainCutoutMaskRegions(profile);
    assert.ok(regions.length > 0);
    assert.ok(regions.every(region => region.clipRings.length > 0));
    assert.ok(buildRetainingWallPositions(profile, 0, { faceKind: 'cut' }).length > 0);
    assert.equal(buildRetainingWallPositions(profile, 0, { faceKind: 'fill' }).length, 0);
    assert.ok(buildRetainingWallPositions(profile, 0, { faceKind: 'retaining' }).length > 0);
    assert.equal(buildRetainingWallPositions(profile, 0, { faceKind: 'earth' }).length, 0);
});

test('a curb-scale shallow cut remains a terrain shoulder, not a concrete wall', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.25,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.equal(profile.formationDressingDisabled, false);
    assert.ok(buildRetainingWallPositions(profile, 0, { faceKind: 'earth' }).length > 0);
    assert.equal(buildRetainingWallPositions(profile, 0, { faceKind: 'retaining' }).length, 0);
});

test('shallow DGU intrusion is measured but cannot open terrain below zero-thickness asphalt', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.12,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainExcavationRegions.length > 0);
    const regions = formationTerrainCutoutMaskRegions(profile);
    assert.deepEqual(regions, [],
        'a colour-only paved top cannot replace the terrain backstop at grazing angles');
    assert.ok(profile.terrainExcavationRegions.every(region => (
        region.replacementBackstopReady === false
    )), 'the measured intrusion remains explicitly non-destructive evidence');
});

test('DGU relief above the asphalt lift still retains the terrain backstop', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.04,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainExcavationRegions.length > 0);
    assert.equal(profile.terrainCutoutDisabled, true);
    assert.deepEqual(formationTerrainCutoutMaskRegions(profile), []);
});

test('a 36 cm source-terrain intrusion cuts only after civil dressing closes it', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.36,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    const regions = formationTerrainCutoutMaskRegions(profile);
    assert.ok(regions.some(region => pointInRing(0, 0, region.ring)),
        'the rendered retaining face and collar make the terrain cut safe');
    assert.ok(profile.terrainExcavationRegions.some(region => (
        pointInRing(0, 0, region.ring)
        && region.replacementBackstopReady === true
    )), 'the publication records its opaque replacement evidence');
});

test('a flush road does not expand a terrain correction beyond bare asphalt', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.04,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.equal(profile.formationDressingDisabled, true);
    assert.equal(profile.terrainCutoutDisabled, true);
    assert.deepEqual(formationTerrainCutoutMaskRegions(profile), [],
        'without a civil face, the mask may not create a void below asphalt');
});

test('sub-centimetre DGU noise does not open terrain below a road', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0.01,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.deepEqual(profile.terrainExcavationRegions, []);
    assert.deepEqual(formationTerrainCutoutMaskRegions(profile), []);
});

test('a neighboring rail owner cannot authorize a road terrain cut', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: (_x, z) => z < -3 ? 2 : 0,
        sourceTerrainInputSceneYAtLocal: (_x, z) => (z >= -3 ? 0 : null),
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.deepEqual(profile.terrainExcavationRegions, []);
    assert.deepEqual(
        formationTerrainCutoutMaskRegions(profile),
        [],
        'the supplied embankment remains sealed beside the road',
    );
});

test('a one-sided source intrusion cuts only the uphill half of a level road', () => {
    const centerlineProfile = {
        points: [{ x: -6, z: 0 }, { x: 0, z: 0 }, { x: 6, z: 0 }],
    };
    const surfaceRing = [
        { x: -8, z: -5 }, { x: 8, z: -5 },
        { x: 8, z: 5 }, { x: -8, z: 5 },
    ];
    const regions = buildRoadSurfaceTerrainIntrusionRegions({
        centerlineProfile,
        surfaceRing,
        roadSceneYAtLocal: () => 0,
        sourceTerrainInputSceneYAtLocal: (_x, z) => (z < -3 ? 2 : 0),
    });
    assert.ok(regions.length > 0);
    assert.ok(regions.some(region => pointInRing(0, -4, region.ring)),
        'the proved uphill intrusion must remain available as diagnostic evidence');
    assert.equal(regions.some(region => pointInRing(0, 0, region.ring)), false,
        'the downhill/level half remains an opaque terrain backstop');
    assert.equal(regions.some(region => pointInRing(0, 4, region.ring)), false,
        'the fill side must never inherit the opposite flank cut');
    assert.ok(regions.every(region => region.replacementBackstopReady === false),
        'surface-only evidence cannot authorize terrain removal');
});

test('an isolated paved intrusion near a junction cannot survive as terrain noise', () => {
    const centerlineProfile = {
        points: [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 12, z: 0 }],
    };
    const surfaceRing = [
        { x: -1, z: -4 }, { x: 13, z: -4 },
        { x: 13, z: 4 }, { x: -1, z: 4 },
    ];
    const regions = buildRoadSurfaceTerrainIntrusionRegions({
        centerlineProfile,
        surfaceRing,
        roadSceneYAtLocal: () => 0,
        // Mirrors the reported branch mouth: raw DGU is 15.8 cm above the
        // engineered datum and 6.8 cm above the rendered asphalt, but only at
        // the first interior profile station after the shared junction node.
        sourceTerrainInputSceneYAtLocal: x => (
            Math.abs(x - 6) < 0.25 ? 0.158 : 0
        ),
    });

    assert.ok(regions.some(region => pointInRing(6, 0, region.ring)),
        'the isolated DGU high spot remains measured for render diagnostics');
    assert.ok(regions.every(region => region.clipToPavedSurface === true),
        'the measurement must remain clipped to rendered asphalt');
    assert.ok(regions.every(region => region.replacementBackstopReady === false),
        'zero-thickness asphalt cannot publish a backstop cut');
});

test('a replacement underpass never reopens its terrain roof as an asphalt correction', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 2,
        sourceTerrainInputSceneYAtLocal: () => 2,
        roadYOverrideAtLocal: () => 0,
        roadReplacementAtLocal: () => true,
    });
    model.setCenterlineTile('roads', [
        centerline(1, [[-30, 0], [30, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(1, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile.terrainExcavationRegions.length > 0, 'the broad civil cut remains');
    assert.ok(profile.terrainExcavationRegions.every(region => (
        region.clipToPavedSurface !== true
    )), 'the replaced lower road must not publish an upper-asphalt correction');
    assert.ok(formationTerrainCutoutMaskRegions(profile).every(region => (
        region.reapplyAfterReplacementClear !== true
    )));
});

test('builds an exact-toe road wall with its collar overlapping intact terrain', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });
    const [profile] = model.getSurfaceProfilesForOsmId(1);
    assert.ok(profile);
    assert.equal(profile.innerRing.length, profile.outerRing.length);
    assert.equal(profile.outerRing.length, profile.overlapRing.length);
    assert.equal(profile.terrainCutoutRing.length, profile.outerRing.length);
    for (let index = 0; index < profile.outerRing.length; index++) {
        const outer = profile.outerRing[index];
        const cutout = profile.terrainCutoutRing[index];
        assert.ok(Math.abs(cutout.x - outer.x) < 1e-9);
        assert.ok(Math.abs(cutout.z - outer.z) < 1e-9);
    }
    assert.ok(profile.points.some((point) => (
        Math.hypot(point.outerX - point.innerX, point.outerZ - point.innerZ) >= 0.79
    )));
    assert.ok(profile.points.some((point) => Math.abs(point.terrainY - point.roadY) > 1));
    assert.ok(profile.points.some((point) => point.terrainY > point.roadY));
    assert.ok(profile.points.some((point) => point.terrainY < point.roadY));
    for (const point of profile.points) {
        assert.ok(point.wallTerrainY < point.terrainY);
        assert.ok(Math.abs(point.wallTerrainY - (point.terrainY - 0.4)) < 1e-9);
    }

    const positions = buildRetainingWallPositions(profile, 0.03);
    assert.equal(positions.length, profile.points.length * 36);
    assert.ok(positions.every(Number.isFinite));
    assert.equal(positions[7], profile.points[0].terrainY);
    assert.equal(positions[13], profile.points[1].terrainY);
    assert.equal(positions[25], profile.points[0].wallTerrainY);
    // The coincident outer->cutout row is omitted; the one visible collar row
    // overlaps intact terrain from the toe to the overlap boundary.
    const collarPositions = buildFormationTerrainCollarPositions(profile);
    assert.equal(collarPositions.length, profile.points.length * 18);
    assert.equal(collarPositions[1], profile.points[0].cutoutTerrainY);
    assert.equal(collarPositions[4], profile.points[1].cutoutTerrainY);
    assert.equal(collarPositions[7], profile.points[0].overlapTerrainY);
    for (const point of profile.points) {
        assert.ok(Number.isFinite(point.cutoutTerrainY), 'cutout line is sampled');
    }
});

// ── Seam registration on sharp relief ──────────────────────────────────────
// A 6 m-tall terrain step crossing the ring: flat at 0 west of x=8, flat at 6
// east of x=10, linear in between. The lattice kink that tore seams vertically.
const STEP_TERRAIN = (x) => (x <= 8 ? 0 : x >= 10 ? 6 : (x - 8) * 3);

test('refineRingByRelief splits only the segments that cross sharp relief', () => {
    const ring = [
        { x: 0, z: 0 }, { x: 4, z: 0 }, { x: 8, z: 0 }, { x: 12, z: 0 }, { x: 16, z: 0 },
        { x: 16, z: 6 }, { x: 12, z: 6 }, { x: 8, z: 6 }, { x: 4, z: 6 }, { x: 0, z: 6 },
    ];
    const tags = ring.map(() => null);
    tags[2] = 'end';   // the 8→12 segment that crosses the step carries a tag
    const flat = refineRingByRelief(ring, tags, () => 5);
    assert.equal(flat.ring.length, ring.length, 'flat ground stays untouched');
    const refined = refineRingByRelief(ring, tags, (x) => STEP_TERRAIN(x));
    assert.ok(refined.ring.length > ring.length, 'the step earns extra vertices');
    // Every inserted vertex lies on a step-crossing segment, and after
    // refinement no >2 m-plan segment jumps more than the threshold.
    for (let i = 0; i < refined.ring.length; i++) {
        const a = refined.ring[i];
        const b = refined.ring[(i + 1) % refined.ring.length];
        const plan = Math.hypot(b.x - a.x, b.z - a.z);
        if (plan >= 2) {
            assert.ok(
                Math.abs(STEP_TERRAIN(b.x) - STEP_TERRAIN(a.x)) <= 1.2 + 1e-9,
                `unsplit segment still jumps: ${a.x}->${b.x}`,
            );
        }
    }
    assert.equal(refined.segmentTags.length, refined.ring.length, 'tags stay aligned');
    // The inserted vertices inherited the split segment's tag.
    const tagged = refined.segmentTags.filter((tag) => tag === 'end').length;
    assert.ok(tagged > 1, 'inserted vertices carry their segment tag');
});

test('the collar row on the mask line is pinned to the terrain across a step', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: (x) => STEP_TERRAIN(x),
    });
    assert.ok(profile);
    // The step crossing earned ring refinement…
    const flatProfile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: () => 0,
    });
    assert.ok(profile.points.length > flatProfile.points.length, 'relief refines the ring');
    // …and every collar vertex on the cutout line sits exactly ON the sampled
    // terrain there — the mask boundary can never open a vertical wedge.
    for (const point of profile.points) {
        assert.ok(
            Math.abs(point.cutoutTerrainY - STEP_TERRAIN(point.cutoutX)) < 1e-9,
            `cutout row off the terrain at x=${point.cutoutX}`,
        );
    }
});

test('collar UVs equal the world-XZ projection on flat ground (camouflage)', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: () => 0.6,   // gentle everywhere: batter spans stay near-flat
    });
    const { positions, uvs } = buildFormationTerrainCollarGeometryData(profile);
    assert.equal(uvs.length / 2, positions.length / 3);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
        assert.ok(
            Math.abs(uvs[vertex * 2] - positions[vertex * 3]) < 1e-9
            && Math.abs(uvs[vertex * 2 + 1] - positions[vertex * 3 + 2]) < 1e-9,
            `flat collar must keep the terrain-continuing projection (vertex ${vertex})`,
        );
    }
});

test('a near-vertical collar span carries its true metres instead of smearing', () => {
    // A cliff: the span from the wall toe out across the collar drops ~12 m
    // over ~1 m of plan. Plan-projected UVs pinned that to one texel row.
    const CLIFF = (x, z) => (z <= 3.2 ? 0 : -12);
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING,
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: CLIFF,
    });
    const { positions, uvs } = buildFormationTerrainCollarGeometryData(profile);
    // Find the steepest emitted triangle edge (a->c of some quad) and check its
    // UV length is within 2x of its 3D length — not collapsed to its plan length.
    let checked = 0;
    for (let tri = 0; tri < positions.length / 9; tri++) {
        const o = tri * 9;
        const dy = Math.abs(positions[o + 7] - positions[o + 1]);
        if (dy < 8) continue;   // not a cliff-spanning triangle
        const d3 = Math.hypot(
            positions[o + 6] - positions[o + 0],
            positions[o + 7] - positions[o + 1],
            positions[o + 8] - positions[o + 2],
        );
        const du = Math.hypot(
            uvs[tri * 6 + 4] - uvs[tri * 6 + 0],
            uvs[tri * 6 + 5] - uvs[tri * 6 + 1],
        );
        assert.ok(
            du > d3 * 0.5,
            `cliff span smeared: uv ${du.toFixed(2)} m over ${d3.toFixed(2)} m`,
        );
        checked += 1;
    }
    assert.ok(checked > 0, 'the cliff produced at least one steep collar span');
});

// Cross-slope bench cut (rail beds opt in via crossSlopeBench). The reach is
// earned by the depth at the TRACKBED EDGE — a true cut buries the bed edge —
// so the deep case needs a slope steep enough to bury the +z edge (z*3 → 9 m
// at z=3) while the −z flank stays a fill. A merely cross-sloped hillside
// (z*0.8 → 2.4 m at the edge) is scenery beside an at-grade line and keeps
// the 2.5 m floor bench it always had.
const CROSS_SLOPE = (x, z) => z * 3;
const HILLSIDE_HUG = (x, z) => z * 0.8;
// A gentle cross-slope whose cut flank is shallower than the 2.5 m floor.
const GENTLE_SLOPE = (x, z) => z * 0.2;
const LEVEL_TOP = () => 0;
const BENCH_RING = [{ x: -20, z: -3 }, { x: 20, z: -3 }, { x: 20, z: 3 }, { x: -20, z: 3 }];
const setbackOf = (p) => Math.hypot(p.outerX - p.innerX, p.outerZ - p.innerZ);

test('the cut-face reach grows with depth, from a 2.5 m floor to a 12 m cap', () => {
    assert.equal(cutBenchReachMeters(0.4), 2.5, 'a shallow cut keeps the tuned floor');
    assert.equal(cutBenchReachMeters(2.5), 2.5, 'the floor holds until 1:1 overtakes it');
    assert.equal(cutBenchReachMeters(8), 8, 'a deep cut daylights ~1 m out per metre down');
    assert.equal(cutBenchReachMeters(40), 12, 'and a mountainside is never carved away');
    assert.equal(cutBenchReachMeters(null), 2.5, 'unknown depth falls back to the floor');
});

test('carves a proportional bench on the cut flank of a cross-slope when enabled', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING, surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: CROSS_SLOPE, crossSlopeBench: true,
    });
    assert.ok(profile);
    const cutPoints = profile.points.filter((p) => p.terrainY - p.roadY > 0.5);
    const fillPoints = profile.points.filter((p) => p.roadY - p.terrainY > 0.5);
    assert.ok(cutPoints.length > 0 && fillPoints.length > 0, 'cross-slope has a cut and a fill flank');
    // The cut flank is benched past the near-vertical batter cap (1.5 m), so the
    // terrain cutout reaches past the buried uphill edge...
    const maxCutSetback = Math.max(...cutPoints.map(setbackOf));
    assert.ok(maxCutSetback > 1.6, `cut bench should exceed the batter cap: ${maxCutSetback}`);
    // ...and with the bed edge buried 9 m it earns far more than the 2.5 m
    // floor a flat cap used to allow — that flat cap is what left an 8 m
    // cutting as a slot with its hillside still standing over the track.
    assert.ok(maxCutSetback > 2.5, `deep cut must out-reach the floor: ${maxCutSetback}`);
    // ...but stays capped — a proportional face, never a carved-away slope.
    assert.ok(maxCutSetback <= 12 + 1e-6, `bench must stay capped: ${maxCutSetback}`);
    // The fill flank keeps the ordinary batter (benching is cut-side only).
    // Straight-edge points only: corner miters legitimately stretch the batter
    // by up to MAX_MITER_SCALE, bench or no bench.
    const straightFill = fillPoints.filter((p) => Math.abs(p.innerX) < 19);
    assert.ok(Math.max(...straightFill.map(setbackOf)) <= 1.6, 'fill flank is not benched');
    // The cutout ring follows the widened bench edge exactly; only the visible
    // collar extends farther, over terrain that remains intact.
    for (const point of cutPoints) {
        const idx = profile.points.indexOf(point);
        const cutout = profile.terrainCutoutRing[idx];
        assert.ok(Math.abs(
            Math.hypot(cutout.x - point.innerX, cutout.z - point.innerZ) - setbackOf(point)
        ) < 1e-9);
    }
});

test('an at-grade line hugging a hillside keeps the floor bench, not a carving', () => {
    // The bed edge sits ~2.4 m into the slope — the hill beside the line rises
    // on, but that is scenery: keying the reach on the marched FLANK depth
    // carved a 12 m collar band along entire quay-side cliffs.
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING, surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: HILLSIDE_HUG, crossSlopeBench: true,
    });
    const cutPoints = profile.points.filter((p) => p.terrainY - p.roadY > 0.5);
    assert.ok(cutPoints.length > 0, 'the hug still has a cut flank');
    assert.ok(
        Math.max(...cutPoints.map(setbackOf)) <= 2.5 + 0.36,
        `hillside hug must keep the floor bench: ${Math.max(...cutPoints.map(setbackOf))}`,
    );
});

test('the bench eases to its floor at an open (tunnel-abutting) cap', () => {
    // 80 m run on a steep cross-slope, END cap open toward a bore. The mouth's
    // width flare is a contract with the stone tunnel wall, so the depth-earned
    // bench must fade out approaching it and be at the plain floor ON it.
    const ring = [{ x: -40, z: -3 }, { x: 40, z: -3 }, { x: 40, z: 3 }, { x: -40, z: 3 }];
    ring[1].capEdge = 'end';    // edge L_end -> R_end sits at the run end
    const profile = buildFormationSurfaceProfile({
        innerRing: ring, surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: CROSS_SLOPE, crossSlopeBench: true,
        openCapEnd: true, capBenchTaperM: 24,
    });
    assert.ok(profile);
    const cutPoints = profile.points.filter((p) => p.terrainY - p.roadY > 0.5);
    const nearCap = cutPoints.filter((p) => p.innerX > 40 - 6);
    const midRun = cutPoints.filter((p) => Math.abs(p.innerX) < 10);
    assert.ok(nearCap.length > 0 && midRun.length > 0, 'both zones sampled');
    // Half a metre of slack: march quantisation plus the smoothstep's first
    // sample — the guarantee is "the floor, not the 9 m the depth would earn".
    assert.ok(
        Math.max(...nearCap.map(setbackOf)) <= 3.0,
        `bench must sit at the floor beside the open cap: ${Math.max(...nearCap.map(setbackOf))}`,
    );
    assert.ok(
        Math.max(...midRun.map(setbackOf)) > 2.5,
        `mid-run keeps the depth-earned reach: ${Math.max(...midRun.map(setbackOf))}`,
    );
    // A CLOSED cap (viaduct/at-grade abutment) is not a tunnel mouth — the full
    // bench applies right up to it.
    const closed = buildFormationSurfaceProfile({
        innerRing: ring.map((p) => ({ ...p })), surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: CROSS_SLOPE, crossSlopeBench: true,
        capBenchTaperM: 24,
    });
    const closedNearCap = closed.points.filter(
        (p) => p.terrainY - p.roadY > 0.5 && p.innerX > 40 - 6,
    );
    assert.ok(
        Math.max(...closedNearCap.map(setbackOf)) > 2.5,
        'no easing without an open cap',
    );
});

test('a shallow cross-slope keeps exactly the bench it had before', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING, surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: GENTLE_SLOPE, crossSlopeBench: true,
    });
    const cutPoints = profile.points.filter((p) => p.terrainY - p.roadY > 0.5);
    assert.ok(cutPoints.length > 0, 'the gentle slope still has a cut flank');
    assert.ok(
        Math.max(...cutPoints.map(setbackOf)) <= 2.5 + 1e-6,
        'a shallow cut must not widen: the 2.5 m floor is the whole reach it earns',
    );
});

test('leaves the cross-section untouched when the bench is disabled (roads keep the batter)', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING, surfaceSceneYAtLocal: LEVEL_TOP,
        baseSceneYAtLocal: CROSS_SLOPE, crossSlopeBench: false,
    });
    assert.ok(
        profile.points.filter((p) => Math.abs(p.innerX) < 19).every((p) => setbackOf(p) <= 1.6),
        'no bench without opt-in',
    );
});

test('a level cross-section gets no bench even with the bench enabled', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: BENCH_RING, surfaceSceneYAtLocal: () => 5,
        baseSceneYAtLocal: () => 5, crossSlopeBench: true,
    });
    assert.ok(profile.points.every((p) => setbackOf(p) <= 1.6), 'no bench carved on level ground');
});

test('suppresses retaining walls inside overlapping road junctions', () => {
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]]),
            centerline(2, [[0, -20], [0, 20]], 'tertiary'),
        ],
        surfaces: [
            surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
            surface(2, [[-4, -20], [4, -20], [4, 20], [-4, 20]], 'tertiary'),
        ],
    }, () => 0);
    const profiles = model.getSurfaceProfiles();
    assert.equal(profiles.length, 2);
    assert.ok(profiles.some((profile) => profile.internalSegments.some(Boolean)));
    for (const profile of profiles) {
        assert.ok(
            buildRetainingWallPositions(profile).length < profile.points.length * 36,
        );
        assert.ok(
            buildFormationTerrainCollarPositions(profile).length < profile.points.length * 36,
        );
        // Where BOTH edges of a vertex are junction-suppressed, the mask must
        // not discard terrain either — nothing is dressed there, and on sharp
        // relief the neighbour road's surface no longer hides the hole. The
        // cutout ring is pulled back to the road edge at those vertices.
        for (let index = 0; index < profile.points.length; index++) {
            const previous = (index - 1 + profile.points.length) % profile.points.length;
            if (!profile.internalSegments[index] || !profile.internalSegments[previous]) continue;
            const point = profile.points[index];
            assert.ok(
                Math.abs(profile.terrainCutoutRing[index].x - point.innerX) < 1e-9
                && Math.abs(profile.terrainCutoutRing[index].z - point.innerZ) < 1e-9,
                `suppressed vertex ${index} must not out-carve the road edge`,
            );
        }
    }

});

test('terrain-cut mask contains only bounded rendered runs at a relief junction', () => {
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]]),
            centerline(2, [[0, -20], [0, 20]], 'tertiary'),
        ],
        surfaces: [
            surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
            surface(2, [[-4, -20], [4, -20], [4, 20], [-4, 20]], 'tertiary'),
        ],
    }, (_x, z) => z * 0.3);
    const profiles = model.getSurfaceProfiles()
        .filter((profile) => !profile.terrainCutoutDisabled);
    assert.ok(profiles.length > 0, 'cross-slope relief activates formation cuts');

    for (const profile of profiles) {
        const maskRings = formationTerrainCutoutMaskRings(profile);
        const hasSuppressedBoundary = profile.internalSegments.some(Boolean)
            || profile.collarInternalSegments.some(Boolean);
        assert.equal(
            maskRings[0],
            hasSuppressedBoundary ? profile.innerRing : profile.terrainCutoutRing,
            'an uninterrupted shell stays one ring; a junction starts with its paved top',
        );
        assert.ok(
            maskRings.length <= 9,
            `junction mask exploded into ${maskRings.length} per-segment paths`,
        );
        const suppressedIndex = profile.internalSegments.findIndex(Boolean);
        if (suppressedIndex < 0) continue;
        const a = profile.points[suppressedIndex];
        const b = profile.points[(suppressedIndex + 1) % profile.points.length];
        const x = (a.innerX + b.innerX + a.cutoutX + b.cutoutX) * 0.25;
        const z = (a.innerZ + b.innerZ + a.cutoutZ + b.cutoutZ) * 0.25;
        assert.equal(
            maskRings.some((ring) => pointInRing(x, z, ring)),
            false,
            'a suppressed wall/collar band must retain terrain instead of opening a void',
        );
    }
});

test('an at-grade paved top does not request an unnecessary terrain cut', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, () => 0);
    const [profile] = model.getSurfaceProfiles();
    assert.equal(profile.terrainCutoutDisabled, true);
    assert.deepEqual(
        formationTerrainCutoutMaskRings(profile),
        [],
        'stencil and the terrain-following surface already cover the at-grade road',
    );
});

test('nearby surface lookup returns only road polygons touching the physics bubble', () => {
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]]),
            centerline(2, [[280, 0], [320, 0]]),
        ],
        surfaces: [
            surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
            surface(2, [[280, -4], [320, -4], [320, 4], [280, 4]]),
        ],
    }, () => 0);
    assert.deepEqual(
        model.surfaceProfilesNear(0, 0, 30).map(profile => String(profile.osmId)),
        ['1'],
    );
    assert.deepEqual(
        model.surfaceProfilesNear(300, 0, 30).map(profile => String(profile.osmId)),
        ['2'],
    );
});

test('removing a centerline tile removes its engineered formation', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    });
    assert.equal(model.getSurfaceProfiles().length, 1);
    model.removeCenterlineTile('0_0');
    assert.equal(model.getSurfaceProfiles().length, 0);
    assert.ok(Math.abs(model.sceneYAtLocal(5, 3, { osmId: 1 }) - 2) < 1e-6);
});

test('applies an authored road height only to its matching centerline', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 2,
        roadYOverrideAtLocal: (_x, _z, osmId) => (
            String(osmId) === '17' ? 9 : null
        ),
    });
    model.setCenterlineTile('roads', [
        centerline(17, [[-20, 0], [20, 0]]),
        centerline(18, [[-20, 20], [20, 20]]),
    ]);

    assert.ok(Math.abs(model.sceneYAtLocal(0, 1, { osmId: 17 }) - 9) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 19, { osmId: 18 }) - 2) < 1e-6);
});

test('resolves vertical road height once after finding the nearest segment', () => {
    let heightLookups = 0;
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 2,
        roadYOverrideAtLocal: () => {
            heightLookups += 1;
            return 9;
        },
    });
    model.setCenterlineTile('roads', [
        centerline(17, [
            [-50, 0],
            [-40, 0],
            [-30, 0],
            [-20, 0],
            [-10, 0],
            [0, 0],
            [10, 0],
            [20, 0],
            [30, 0],
            [40, 0],
            [50, 0],
        ]),
    ]);

    assert.equal(model.sceneYAtLocal(49, 1, { osmId: 17 }), 9);
    assert.equal(heightLookups, 1);
});

test('keeps vertically separated curb owners distinct at the same x/z crossing', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadYOverrideAtLocal: (_x, _z, osmId) => (
            String(osmId) === '17' ? 6.5 : 0
        ),
    });
    model.setCenterlineTile('roads', [
        centerline(17, [[-20, 0], [20, 0]]),
        centerline(18, [[0, -20], [0, 20]], 'tertiary'),
    ]);
    model.setSurfaceTile('roads', [
        surface(17, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
        surface(18, [[-4, -20], [4, -20], [4, 20], [-4, 20]], 'tertiary'),
    ]);

    assert.equal(model.sceneYAtLocal(0, 3, { osmIds: [17] }), 6.5);
    assert.equal(model.sceneYAtLocal(0, 3, { osmIds: [18] }), 0);
    assert.ok(
        model.getSurfaceProfiles().every(profile => profile.internalSegments.every(value => !value)),
        'a 6.5 m crossing must not be suppressed as an at-grade junction',
    );
    assert.equal(
        model.surfaceAtLocal(0, 0, new Set(['17']))?.osmId,
        '18',
        'excluding every bridge member must still expose the crossed road',
    );
    assert.equal(
        model.surfaceAtLocal(0, 0, new Set(['17', '18'])),
        null,
    );
});

test('sibling polygons of one OSM road suppress their internal formation seam', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 5,
        roadYOverrideAtLocal: () => 0,
    });
    model.setCenterlineTile('roads', [
        centerline(151298873, [[-20, 0], [20, 0]], 'primary'),
    ]);
    model.setSurfaceTile('roads', [
        multiSurface(151298873, [
            [[-20, -4], [0, -4], [0, 4], [-20, 4]],
            [[0, -4], [20, -4], [20, 4], [0, 4]],
        ], 'primary'),
    ]);

    const profiles = model.getSurfaceProfilesForOsmId(151298873);
    assert.equal(profiles.length, 2, 'both MultiPolygon members remain rendered road tops');
    for (const profile of profiles) {
        const seamSegments = profile.points
            .map((point, index) => ({
                index,
                next: profile.points[(index + 1) % profile.points.length],
                point,
            }))
            .filter(({ point, next }) => (
                Math.abs(point.innerX) < 1e-6
                && Math.abs(next.innerX) < 1e-6
                && Math.abs((point.innerZ + next.innerZ) * 0.5) < 4
            ));
        assert.ok(seamSegments.length > 0, 'the shared polygon-member edge is present');
        assert.ok(seamSegments.every(({ index }) => profile.internalSegments[index]),
            'no retaining wall may be erected inside sibling asphalt');
        assert.ok(seamSegments.every(({ index }) => profile.collarInternalSegments[index]),
            'no terrain collar may rise through sibling asphalt');
    }

    assert.equal(model.surfaceAtLocal(10, 0, 151298873), null,
        'the public whole-feature exclusion contract remains unchanged');
});

test('a bridge deck suppresses formation curtains and leaves terrain below intact', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        roadYOverrideAtLocal: (_x, _z, osmId) => (
            String(osmId) === '17' ? 6.5 : null
        ),
        roadStructureAtLocal: (_x, _z, osmId) => (
            String(osmId) === '17' ? { kind: 'overpass' } : null
        ),
    });
    model.setCenterlineTile('roads', [
        centerline(17, [[-20, 0], [20, 0]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(17, [[-20, -4], [20, -4], [20, 4], [-20, 4]]),
    ]);

    const [profile] = model.getSurfaceProfilesForOsmId(17);
    assert.equal(profile.terrainCutoutDisabled, true);
    assert.ok(profile.internalSegments.every(Boolean));
    assert.equal(buildRetainingWallPositions(profile).length, 0);
    assert.equal(buildFormationTerrainCollarPositions(profile).length, 0);
    assert.equal(model.sceneYAtLocal(0, 0, { osmId: 17 }), 6.5);
});

test('an alignment-owned cut suppresses source buffer walls only inside its corridor', () => {
    const replacementRegion = {
        clearRing: [
            { x: -8, z: -8 },
            { x: 8, z: -8 },
            { x: 8, z: 8 },
            { x: -8, z: 8 },
        ],
    };
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 8,
        roadYOverrideAtLocal: () => 0,
        roadReplacementAtLocal: (x, _z, osmId) => (
            String(osmId) === '17' && Math.abs(x) <= 8
        ),
        replacementTerrainCutoutRegions: () => [replacementRegion],
    });
    model.setCenterlineTile('roads', [
        centerline(17, [[-30, 0], [30, 0]]),
        centerline(18, [[-30, 20], [30, 20]]),
    ]);
    model.setSurfaceTile('roads', [
        surface(17, [[-30, -4], [30, -4], [30, 4], [-30, 4]]),
        surface(18, [[-30, 16], [30, 16], [30, 24], [-30, 24]]),
    ]);

    const [replacementProfile] = model.getSurfaceProfilesForOsmId(17);
    const [ordinaryProfile] = model.getSurfaceProfilesForOsmId(18);
    assert.ok(replacementProfile.internalSegments.some(Boolean));
    assert.ok(replacementProfile.internalSegments.some(value => !value));
    assert.ok(
        buildRetainingWallPositions(replacementProfile).length
            < replacementProfile.points.length * 36,
    );
    assert.ok(ordinaryProfile.internalSegments.every(value => !value));
    assert.deepEqual(model.getReplacementTerrainCutoutRegions(), [replacementRegion]);
});

test('overlapping duplicate tiles do not churn the active road index', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
    });
    const roadCenterline = centerline(1, [[-20, 0], [20, 0]]);
    const roadSurface = surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]]);

    model.setCenterlineTile('a', [roadCenterline]);
    model.setSurfaceTile('a', [roadSurface]);
    assert.equal(model.getSurfaceProfiles().length, 1);
    const firstRevision = model.revision;

    model.setCenterlineTile('b', [roadCenterline]);
    model.setSurfaceTile('b', [roadSurface]);
    assert.equal(model.revision, firstRevision);

    model.removeCenterlineTile('a');
    model.removeSurfaceTile('a');
    assert.equal(model.revision, firstRevision);
    assert.equal(model.getSurfaceProfiles().length, 1);

    model.removeCenterlineTile('b');
    model.removeSurfaceTile('b');
    assert.equal(model.revision, firstRevision + 2);
    assert.equal(model.getSurfaceProfiles().length, 0);
});

test('reports spatial formation changes without duplicate-tile churn', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
    });
    const road = centerline(7, [[100, 200], [140, 200]]);
    model.setCenterlineTile('a', [road]);
    const addedRevision = model.revision;
    const added = model.getChangesSince(0);
    assert.equal(added.full, false);
    assert.equal(added.revision, addedRevision);
    assert.equal(added.bounds.length, 1);
    assert.ok(added.bounds[0].minX > 99 && added.bounds[0].maxX < 141);
    assert.ok(added.bounds[0].minZ > 199 && added.bounds[0].maxZ < 201);

    model.setCenterlineTile('b', [road]);
    model.removeCenterlineTile('a');
    assert.equal(model.revision, addedRevision);
    assert.deepEqual(model.getChangesSince(addedRevision), {
        revision: addedRevision,
        full: false,
        bounds: [],
    });

    model.removeCenterlineTile('b');
    const removed = model.getChangesSince(addedRevision);
    assert.equal(removed.full, false);
    assert.equal(removed.bounds.length, 1);
    assert.ok(removed.bounds[0].minX > 99 && removed.bounds[0].maxX < 141);
});

test('falls back to full invalidation when formation change history is exhausted', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
    });
    for (let index = 0; index < 130; index++) {
        model.setCenterlineTile(`tile-${index}`, [
            centerline(index + 1, [[index, 0], [index + 0.5, 0]]),
        ]);
    }
    assert.equal(model.getChangesSince(0).full, true);
    const recent = model.getChangesSince(model.revision - 1);
    assert.equal(recent.full, false);
    assert.equal(recent.bounds.length, 1);
});

test('updates cached junction suppression when a crossing road appears and disappears', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, () => 0);
    const [originalProfile] = model.getSurfaceProfiles();
    assert.ok(originalProfile.internalSegments.every((value) => !value));

    model.setCenterlineTile('crossing', [
        centerline(2, [[0, -20], [0, 20]], 'tertiary'),
    ]);
    model.setSurfaceTile('crossing', [
        surface(2, [[-4, -20], [4, -20], [4, 20], [-4, 20]], 'tertiary'),
    ]);
    const profilesWithCrossing = model.getSurfaceProfiles();
    assert.notEqual(profilesWithCrossing[0], originalProfile);
    assert.ok(originalProfile.internalSegments.every((value) => !value));
    assert.ok(profilesWithCrossing[0].internalSegments.some(Boolean));

    model.removeCenterlineTile('crossing');
    model.removeSurfaceTile('crossing');
    const [remainingProfile] = model.getSurfaceProfiles();
    assert.notEqual(remainingProfile, profilesWithCrossing[0]);
    assert.ok(remainingProfile.internalSegments.every((value) => !value));
    assert.ok(originalProfile.internalSegments.every((value) => !value));
});

test('removing an overlapping neighbour restores the original cutout boundary', () => {
    const model = modelWith({
        centerlines: [centerline(1, [[-20, 0], [20, 0]])],
        surfaces: [surface(1, [[-20, -4], [20, -4], [20, 4], [-20, 4]])],
    }, () => 5);
    const boundary = profile => profile.points.map(point => [point.cutoutX, point.cutoutZ, point.cutoutTerrainY]);
    const original = model.getSurfaceProfiles()[0];
    const base = boundary(original);
    model.setCenterlineTile('crossing', [centerline(2, [[0, -20], [0, 20]], 'tertiary')]);
    model.setSurfaceTile('crossing', [surface(2, [[-4, -20], [4, -20], [4, 20], [-4, 20]], 'tertiary')]);
    const contracted = model.getSurfaceProfilesForOsmId(1)[0];
    assert.notDeepEqual(boundary(contracted), base, 'the neighbour actually contracts the cutout');
    assert.deepEqual(boundary(original), base, 'the original published generation remains immutable');
    model.removeCenterlineTile('crossing');
    model.removeSurfaceTile('crossing');
    const restored = boundary(model.getSurfaceProfilesForOsmId(1)[0]);
    assert.deepEqual(restored, base);
});

// ── Missing terrain must stay missing ──────────────────────────────────────
// Same defect as rail-formation's floating viaduct, different symptom: roads
// build no structures, so an absent ground sample laid the batter and collar at
// sea level instead. buildFormationSurfaceProfile ALREADY had the right
// fallback ("if the ground is unknown, assume it meets the road") — the
// `Number()` cast defeated it, because Number(null) is 0 and 0 is finite, so
// the fallback never ran. See no-null-as-zero.test.mjs.
test('an unknown ground sample falls back to the road, not to sea level', () => {
    const ring = [
        { x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 8 }, { x: 0, z: 8 },
    ];
    const profile = buildFormationSurfaceProfile({
        innerRing: ring,
        surfaceSceneYAtLocal: () => 30,      // carriageway 30 m up, as in Split
        baseSceneYAtLocal: () => null,       // terrain not loaded / not served
    });
    assert.ok(profile, 'an unknown ground must still produce a profile');
    for (const point of profile.points) {
        assert.ok(Math.abs(point.terrainY - 30) < 1e-6,
            `terrain should default to the road at 30 m, got ${point.terrainY}`);
        assert.ok(point.terrainY > 1,
            'a terrainY at the datum means null was read as sea level again');
    }
});

test('a known ground is still used, including a genuine zero', () => {
    // The mirror: finiteOrNull must not confuse "measured 0 m" with "unknown".
    const ring = [
        { x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 8 }, { x: 0, z: 8 },
    ];
    const profile = buildFormationSurfaceProfile({
        innerRing: ring,
        surfaceSceneYAtLocal: () => 30,
        baseSceneYAtLocal: () => 0,          // genuinely at the datum
    });
    assert.ok(profile.points.every(point => Math.abs(point.terrainY) < 1e-6),
        'a measured sea-level reading must be honoured, not treated as absent');
});

// The dressing must face the air side regardless of ring march direction:
// one ring side always marched opposite the other, and a fixed vertex order
// lit half of every formation from behind (navy panels at night, over-bright
// collar aprons under the walker lamp).
function syntheticRingPoints(reversed = false) {
    // Square cut ring: bed at y 0, terrain at y 5, outward = away from centre.
    const corners = [
        [-5, -5], [5, -5], [5, 5], [-5, 5],
    ];
    const points = corners.map(([x, z]) => {
        const len = Math.hypot(x, z);
        const ox = x / len;
        const oz = z / len;
        return {
            innerX: x,
            innerZ: z,
            roadY: 0,
            outerX: x + ox * 2,
            outerZ: z + oz * 2,
            terrainY: 5,
            wallTerrainY: 4.6,
            cutoutX: x + ox * 2.75,
            cutoutZ: z + oz * 2.75,
            cutoutTerrainY: 5,
            overlapX: x + ox * 3.5,
            overlapZ: z + oz * 3.5,
            overlapTerrainY: 5,
        };
    });
    return reversed ? points.slice().reverse() : points;
}

function triangleNormals(positions) {
    const normals = [];
    for (let offset = 0; offset + 8 < positions.length; offset += 9) {
        const ux = positions[offset + 3] - positions[offset];
        const uy = positions[offset + 4] - positions[offset + 1];
        const uz = positions[offset + 5] - positions[offset + 2];
        const vx = positions[offset + 6] - positions[offset];
        const vy = positions[offset + 7] - positions[offset + 1];
        const vz = positions[offset + 8] - positions[offset + 2];
        normals.push({
            x: uy * vz - uz * vy,
            y: uz * vx - ux * vz,
            z: ux * vy - uy * vx,
            cx: (positions[offset] + positions[offset + 3] + positions[offset + 6]) / 3,
            cz: (positions[offset + 2] + positions[offset + 5] + positions[offset + 8]) / 3,
        });
    }
    return normals;
}

test('cut retaining-wall triangles face the trench for both ring directions', () => {
    for (const reversed of [false, true]) {
        const profile = { points: syntheticRingPoints(reversed), internalSegments: null };
        const positions = buildRetainingWallPositions(profile, 0);
        assert.equal(positions.length, profile.points.length * 36);
        for (const normal of triangleNormals(positions)) {
            // Inward = from the triangle toward the ring centre (origin).
            const dot = normal.x * -normal.cx + normal.z * -normal.cz;
            assert.ok(
                dot > 0,
                `wall triangle faces away from the trench (reversed=${reversed})`,
            );
        }
    }
});

test('collar triangles on lying ground face up for both ring directions', () => {
    for (const reversed of [false, true]) {
        const profile = { points: syntheticRingPoints(reversed), internalSegments: null };
        const { positions, uvs } = buildFormationTerrainCollarGeometryData(profile);
        assert.equal(positions.length, profile.points.length * 36);
        assert.equal(uvs.length / 2, positions.length / 3);
        for (const normal of triangleNormals(positions)) {
            assert.ok(normal.y > 0, `collar triangle faces down (reversed=${reversed})`);
        }
        // The uv row still carries the world-XZ camouflage on flat ground:
        // every vertex uv equals its position's (x, z) exactly.
        for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex++) {
            assert.ok(Math.abs(uvs[vertexIndex * 2] - positions[vertexIndex * 3]) < 1e-9);
            assert.ok(Math.abs(uvs[vertexIndex * 2 + 1] - positions[vertexIndex * 3 + 2]) < 1e-9);
        }
    }
});

// The Rijeka hillside grooves: on a cross-slope, a road's terrain-pinned collar
// band can cross a lower neighbouring carriageway whose own stencil already
// discards the ground there. The wall-band overlap test never sees it (the
// collar reaches TERRAIN_SEAM_OVERLAP_M further out), so the collar rode ~1 m
// above the neighbour's level surface as a rock-textured ridge. The collar must
// be suppressed there while the wall — a legitimate retaining edge — stays.
test('a collar crossing a lower neighbouring carriageway is suppressed, its wall kept', () => {
    // Terrain rises with z: road B (centreline z=0) sits low, road A
    // (centreline z=10) sits ~3 m higher. Their polygons leave a 1.5 m gap, so
    // A's wall band stays outside B while A's collar band reaches into it.
    const crossSlope = (x, z) => z * 0.3;
    const model = modelWith({
        centerlines: [
            centerline(1, [[0, 0], [60, 0]]),
            centerline(2, [[0, 10], [60, 10]]),
        ],
        surfaces: [
            surface(1, [[0, -3], [60, -3], [60, 3], [0, 3]]),
            surface(2, [[0, 4.5], [60, 4.5], [60, 15.5], [0, 15.5]]),
        ],
    }, crossSlope);
    const upper = model.getSurfaceProfilesForOsmId(2)[0];
    assert.ok(upper, 'upper road builds a formation profile');

    const collarOnly = upper.points.filter((point, index) => (
        upper.collarInternalSegments[index] && !upper.internalSegments[index]
    ));
    assert.ok(collarOnly.length > 0,
        'boundary segments suppress the collar without suppressing the wall');

    // No emitted collar vertex may stand above the lower road's surface
    // inside its carriageway.
    const lower = model.getSurfaceProfilesForOsmId(1)[0];
    const inLower = (x, z) => {
        let inside = false;
        const ring = lower.innerRing;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x; const zi = ring[i].z;
            const xj = ring[j].x; const zj = ring[j].z;
            if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    };
    const { positions } = buildFormationTerrainCollarGeometryData(upper);
    let intrusions = 0;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]; const y = positions[i + 1]; const z = positions[i + 2];
        if (!inLower(x, z)) continue;
        const lowerY = model.sceneYAtLocal(x, z, { osmId: 1 });
        if (y > lowerY + 0.25) intrusions += 1;
    }
    assert.equal(intrusions, 0, 'no collar vertex rides above the lower carriageway');

    // The retaining wall along that same boundary still builds.
    const wallPositions = buildRetainingWallPositions(upper);
    assert.ok(wallPositions.length > 0, 'upper road keeps its retaining wall');
});

test('a late road outside the inner polygon still invalidates its neighbour collar', () => {
    const upperLine = centerline(2, [[0, 10], [60, 10]]);
    const upperSurface = surface(2, [[0, 4.5], [60, 4.5], [60, 15.5], [0, 15.5]]);
    const lowerLine = centerline(1, [[0, 0], [60, 0]]);
    const lowerSurface = surface(1, [[0, -3], [60, -3], [60, 3], [0, 3]]);
    const ground = (_x, z) => z * .3;
    const expected = modelWith({ centerlines: [upperLine, lowerLine], surfaces: [upperSurface, lowerSurface] }, ground);
    const wanted = expected.getSurfaceProfilesForOsmId(2)[0];
    const subject = modelWith({ centerlines: [upperLine], surfaces: [upperSurface] }, ground);
    const old = subject.getSurfaceProfilesForOsmId(2)[0];
    const oldFlags = [...old.collarInternalSegments];
    const oldGeneration = subject.getSurfaceGeometryGeneration(2);
    assert.notDeepEqual(oldFlags, wanted.collarInternalSegments, 'late road changes actual collar coverage');
    subject.setCenterlineTile('late', [lowerLine]);
    subject.setSurfaceTile('late', [lowerSurface]);
    const actual = subject.getSurfaceProfilesForOsmId(2)[0];
    assert.ok(actual.bounds.minZ > expected.getSurfaceProfilesForOsmId(1)[0].bounds.maxZ, 'inner polygons do not overlap');
    assert.deepEqual(actual.collarInternalSegments, wanted.collarInternalSegments);
    assert.deepEqual(buildFormationTerrainCollarPositions(actual), buildFormationTerrainCollarPositions(wanted));
    assert.ok(subject.getSurfaceGeometryGeneration(2) > oldGeneration);
    assert.deepEqual(old.collarInternalSegments, oldFlags);
});

test('a road collar stops at an earlier civil-ground owner while its retaining wall stays', () => {
    const crossSlope = (_x, z) => z * 0.3;
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: crossSlope,
        sourceTerrainInputSceneYAtLocal: crossSlope,
        // Rail owns the low side of this road. The later road may retain
        // against it, but may not paint a second terrain collar over it.
        sourceTerrainOwnsInputAtLocal: (_x, z) => z > 3,
    });
    model.setCenterlineTile('0_0', [
        centerline(1, [[0, 10], [60, 10]]),
    ]);
    model.setSurfaceTile('0_0', [
        surface(1, [[0, 4.5], [60, 4.5], [60, 15.5], [0, 15.5]]),
    ]);

    const profile = model.getSurfaceProfilesForOsmId(1)[0];
    assert.ok(profile);
    assert.ok(profile.collarInternalSegments.some((hidden, index) => (
        hidden && !profile.internalSegments[index]
    )), 'only the terrain collar should yield at the prior civil surface');
    assert.ok(buildRetainingWallPositions(profile).length > 0,
        'the road still retains from its paved edge down to the earlier surface');
});

// Martićeva's perpendicular service roads start just inside the through-road
// polygon. Interior-only overlap samples removed most of each junction collar,
// but left the mitred endpoint triangle poking into the asphalt like a narrow
// terrain-coloured scratch.
test('a driveway collar corner cannot leak into its through carriageway', () => {
    const model = modelWith({
        centerlines: [
            centerline(1, [[-20, 0], [20, 0]], 'tertiary'),
            centerline(2, [[0, -1], [0, 20]], 'service'),
        ],
        surfaces: [
            surface(1, [[-20, -3], [20, -3], [20, 3], [-20, 3]], 'tertiary'),
            surface(2, [[-2, -1], [2, -1], [2, 20], [-2, 20]], 'service'),
        ],
    }, () => 0);
    const throughRoad = model.getSurfaceProfilesForOsmId(1)[0];
    const driveway = model.getSurfaceProfilesForOsmId(2)[0];
    assert.ok(throughRoad && driveway);

    const insideThroughRoad = (x, z) => {
        let inside = false;
        const ring = throughRoad.innerRing;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i];
            const b = ring[j];
            if ((a.z > z) !== (b.z > z)
                && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
                inside = !inside;
            }
        }
        return inside;
    };
    const { positions } = buildFormationTerrainCollarGeometryData(driveway);
    let intrudingVertices = 0;
    for (let index = 0; index < positions.length; index += 3) {
        if (insideThroughRoad(positions[index], positions[index + 2])) {
            intrudingVertices += 1;
        }
    }
    assert.equal(intrudingVertices, 0,
        'no terrain-collar corner may be emitted inside the through carriageway');
});

// A real OSM junction is a coordinate shared by its incident ways. It owns one
// terrain-based elevation; each road then keeps its independent longitudinal
// profile outside the node instead of being radius-blended with nearby ways.
test('incident ways share their topology-node elevation without radius blending', () => {
    const slope = (x, z) => z * 0.08;
    const model = modelWith({
        centerlines: [
            centerline(1, [[-60, 0], [0, 0], [60, 0]]),
            centerline(2, [[0, 0], [0, 60]]),
        ],
        surfaces: [
            surface(1, [[-60, -3.5], [60, -3.5], [60, 3.5], [-60, 3.5]]),
            surface(2, [[-3.5, -3.5], [3.5, -3.5], [3.5, 60], [-3.5, 60]]),
        ],
    }, slope);
    // The same junction point queried through either way must agree exactly.
    const throughRoad = model.sceneYAtLocal(0, 0, { osmId: 1 });
    const sideRoad = model.sceneYAtLocal(0, 0, { osmId: 2 });
    assert.ok(Math.abs(throughRoad - sideRoad) < 1e-9,
        `junction surface must be way-independent (got ${throughRoad} vs ${sideRoad})`);
    assert.ok(Math.abs(throughRoad) < 1e-9);
    // Outside the shared node each way keeps its own grade; proximity alone
    // cannot pull a valley or hump into either surface.
    assert.ok(Math.abs(model.sceneYAtLocal(-50, 0, { osmId: 1 }) - 0) < 1e-6);
    assert.ok(Math.abs(model.sceneYAtLocal(0, 20, { osmId: 2 }) - 1.6) < 1e-6);
});

// The Rijeka groove generator: a junction-merged primary polygon seeds earcut
// with thousands of ring-edge triangles PLUS a few giant interior fan shards.
// One full base-threshold pass exceeded the triangle budget, the old code
// abandoned refinement wholesale, and the 25–75 m shards shipped — their flat
// interiors bridging the curved drape field by ±0.85 m. The budget must be
// spent on the LONGEST edges first instead.
test('a tight triangle budget still splits the giant shards first', () => {
    // Forty ~6 m triangles (a full 4 m pass would quadruple them past the
    // budget) plus one 80 m sliver pair.
    const points = [];
    const triangles = [];
    for (let i = 0; i < 20; i++) {
        const x = i * 6;
        points.push({ x, z: 20 }, { x: x + 6, z: 20 }, { x: x + 6, z: 26 }, { x, z: 26 });
        const base = i * 4;
        triangles.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
    }
    const shardBase = points.length;
    points.push({ x: 0, z: 0 }, { x: 80, z: 0 }, { x: 80, z: 8 }, { x: 0, z: 8 });
    triangles.push([shardBase, shardBase + 1, shardBase + 2], [shardBase, shardBase + 2, shardBase + 3]);

    const refined = refineTriangulatedSurface(points, triangles, 4, 100);
    assert.ok(refined.triangles.length <= 100, 'budget respected');
    let maxEdge = 0;
    for (const triangle of refined.triangles) {
        for (let edge = 0; edge < 3; edge++) {
            const a = refined.points[triangle[edge]];
            const b = refined.points[triangle[(edge + 1) % 3]];
            maxEdge = Math.max(maxEdge, Math.hypot(b.x - a.x, b.z - a.z));
        }
    }
    assert.ok(maxEdge <= 22,
        `the 80 m shard must be split down (max edge ${maxEdge.toFixed(1)} m)`);
});

// Roadside footways belong to the complete road corridor: carriageway, curb and
// sidewalk share one cross-section. Only surfaces outside that corridor ease
// back to terrain.
test('roadside ground shares the road profile before easing back to terrain', () => {
    const crossSlope = (x, z) => z * 0.3;
    const model = modelWith({
        centerlines: [centerline(1, [[0, 0], [60, 0]])],
        surfaces: [surface(1, [[0, -3.5], [60, -3.5], [60, 3.5], [0, 3.5]])],
    }, crossSlope);
    // At the sidewalk line raw terrain is 1.5 m above the road, but the complete
    // corridor remains level with the carriageway.
    const besideRoad = model.groundSceneYAtLocal(30, 5);
    assert.ok(Math.abs(besideRoad) < 1e-9,
        `sidewalk line must share the road grade (got ${besideRoad}, terrain 1.50)`);
    // Halfway through the 12–20 m transition, smoothstep mixes road and terrain
    // equally: raw terrain at z=16 is 4.8 m, hence a 2.4 m transition height.
    assert.ok(Math.abs(model.groundSceneYAtLocal(30, 16) - 2.4) < 1e-9);
    // Far from any road the field is raw terrain again.
    const farField = model.groundSceneYAtLocal(30, 200);
    assert.ok(Math.abs(farField - crossSlope(30, 200)) < 1e-9);
});

test('roadside ground follows the parallel carriageway instead of a closer cross street', () => {
    const model = modelWith({
        centerlines: [
            centerline(1, [[-60, 0], [60, 0]]),
            centerline(2, [[0, 4], [0, 60]]),
        ],
        surfaces: [
            surface(1, [[-60, -3.5], [60, -3.5], [60, 3.5], [-60, 3.5]]),
            surface(2, [[-3.5, 4], [3.5, 4], [3.5, 60], [-3.5, 60]]),
        ],
    }, (_x, z) => (z < 2 ? 0 : 10));
    const nearestRoadY = model.groundSceneYAtLocal(0, 5);
    const parallelY = model.groundSceneYAtLocal(0, 5, {
        tangentX: 1,
        tangentZ: 0,
    });
    assert.ok(nearestRoadY > 8,
        `legacy nearest-road sampling should choose the high cross street (got ${nearestRoadY})`);
    assert.ok(parallelY < 2,
        `a horizontal sidewalk must stay on the low horizontal-road profile (got ${parallelY})`);
    assert.ok(nearestRoadY - parallelY > 6,
        'directional association must prevent the cross-street elevation jump');
});

test('a vertical retained formation replaces the rural batter with a level bench and wall', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: [
            { x: -10, z: -2, minimumCutBenchReachM: 6 },
            { x: 10, z: -2, minimumCutBenchReachM: 6 },
            { x: 10, z: 2, minimumCutBenchReachM: 6 },
            { x: -10, z: 2, minimumCutBenchReachM: 6 },
        ],
        surfaceSceneYAtLocal: () => 0,
        baseSceneYAtLocal: () => 3,
        verticalRetainedWalls: true,
    });
    assert.equal(profile.verticalRetainedWalls, true);
    const a = profile.points[0];
    const b = profile.points[1];
    assert.ok(Math.abs(Math.hypot(a.outerX - a.innerX, a.outerZ - a.innerZ) - 6) < 1e-9,
        'a reviewed retained-wall plane overrides the default rural batter reach');
    const benchX = (
        (a.innerX + b.innerX) * 0.5
        + (a.outerX + b.outerX) * 0.5
    ) * 0.5;
    const benchZ = (
        (a.innerZ + b.innerZ) * 0.5
        + (a.outerZ + b.outerZ) * 0.5
    ) * 0.5;
    assert.ok(Math.abs(formationDressingSurfaceYAtLocal(profile, benchX, benchZ)) < 1e-9,
        'the civil ground remains at formation level until the wall plane');

    const wall = buildRetainingWallPositions(profile);
    assert.ok(buildRetainingWallPositions(profile, 0, { faceKind: 'retaining' }).length > 0,
        'an authored vertical wall uses the structural retaining material');
    assert.equal(buildRetainingWallPositions(profile, 0, { faceKind: 'earth' }).length, 0,
        'an authored vertical wall is never rendered as a soil embankment');
    const vertices = [];
    for (let index = 0; index < wall.length; index += 3) {
        vertices.push({ x: wall[index], y: wall[index + 1], z: wall[index + 2] });
    }
    assert.ok(vertices.some(vertex => (
        Math.abs(vertex.x - a.outerX) < 1e-9
        && Math.abs(vertex.z - a.outerZ) < 1e-9
        && Math.abs(vertex.y) < 1e-9
    )), 'the wall has a foot at the engineered floor');
    assert.ok(vertices.some(vertex => (
        Math.abs(vertex.x - a.outerX) < 1e-9
        && Math.abs(vertex.z - a.outerZ) < 1e-9
        && Math.abs(vertex.y - 3) < 1e-9
    )), 'the wall rises on the same x/z plane to retained ground');
});

test('a semantic rail interface can select the retained road cross-section by OSM id', () => {
    const model = new RoadFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        baseSceneYAtLocal: () => 0,
        formationStyleForOsmId: osmId => (
            String(osmId) === '912809760' ? 'vertical-retained' : null
        ),
    });
    model.setCenterlineTile('0_0', [
        centerline('912809760', [[0, 0], [60, 0]]),
        centerline('2', [[0, 20], [60, 20]]),
    ]);
    model.setSurfaceTile('0_0', [
        surface('912809760', [[0, -4], [60, -4], [60, 4], [0, 4]]),
        surface('2', [[0, 16], [60, 16], [60, 24], [0, 24]]),
    ]);

    assert.equal(model.getSurfaceProfilesForOsmId('912809760')[0]?.verticalRetainedWalls, true);
    assert.equal(model.getSurfaceProfilesForOsmId('912809760')[0]?.formationStyle,
        'vertical-retained');
    assert.equal(model.getSurfaceProfilesForOsmId('2')[0]?.verticalRetainedWalls, false,
        'ordinary roads keep the default terrain batter');
});

test('a shared retained road wall stops its terrain collar at the rail cess', () => {
    const profile = buildFormationSurfaceProfile({
        innerRing: [
            { x: 0, z: 0 },
            { x: 20, z: 0 },
            { x: 20, z: 8 },
            { x: 0, z: 8 },
        ],
        surfaceSceneYAtLocal: () => 4,
        baseSceneYAtLocal: () => 7,
        verticalRetainedWalls: true,
        maxSegmentM: 100,
        retainedWallBoundaryAtLocal: (x, z) => ({
            x,
            z,
            retainedBaseY: 1,
            sharedRailRetainingBoundary: true,
            railFormationId: 'rail-approach',
            railBoundarySide: 'positive-normal',
        }),
    });

    assert.ok(profile);
    assert.ok(profile.points.every(point => point.terrainY === 1),
        'the shared wall foot follows the rail floor instead of the tunnel roof');
    assert.ok(profile.sharedRailBoundarySegments.every(Boolean));
    assert.ok(profile.collarInternalSegments.every(Boolean),
        'the road collar does not slope across the lower rail-owned cess');
    assert.ok(buildRetainingWallPositions(profile).length > 0,
        'the road still owns and renders the vertical wall face');
    assert.equal(buildFormationTerrainCollarPositions(profile).length, 0,
        'no second terrain face competes beyond the shared wall');
});

test('adjoining retained road ways yield a fully covered wall fragment', () => {
    const point = (x, z) => ({
        innerX: x + 2,
        innerZ: z,
        roadY: 4,
        outerX: x,
        outerZ: z,
        terrainY: 0,
        wallTerrainY: -0.4,
        sharedRailRetainingBoundary: true,
        railFormationId: 'rail-approach',
        railBoundarySide: 'positive-normal',
    });
    const profile = (osmId, a, b) => ({
        osmId,
        verticalRetainedWalls: true,
        points: [point(...a), point(...b)],
        internalSegments: [false, false],
        sharedRailBoundarySegments: [true, false],
        sharedRetainingWallSegments: [false, false],
        roadOpeningSegmentRanges: [[], []],
    });
    const long = profile('long', [0, 0], [0, 10]);
    const short = profile('short', [0.03, 8], [0.03, 10]);

    assert.equal(suppressDuplicateSharedRetainingWallSegments([long, short]), 1);
    assert.equal(long.sharedRetainingWallSegments[0], false);
    assert.equal(short.sharedRetainingWallSegments[0], true,
        'the continuous long wall owns the coplanar endpoint overlap');
    assert.equal(suppressDuplicateSharedRetainingWallSegments([long, short]), 0,
        'ownership arbitration is idempotent');
});
