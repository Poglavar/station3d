import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { changedCivilGroundDependencyBounds } from '../core/civil-ground-composition.js';
import {
    buildFormationTerrainCollarPositions,
    buildRetainingWallPositions,
} from '../core/road-formation.js';
import {
    createEmbeddedTramRoadEndpointResolver,
    flagRailFormationBoundarySegmentsForRoadOpenings,
    flagRailFormationBoundarySegmentsForRetainedRoadInterfaces,
    flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps,
    flagRailFormationBoundarySegmentsForRoadOpeningsSteps,
    formationBoundarySegmentIntersectsRoadOpening,
    formationBoundarySegmentRoadOpeningInterval,
    isPotentialRoadCarriedTramFeature,
    roadCarriedTramDeckSignature,
    roadDeckForCarriedTramAtLocal,
    roadEmbeddedTramSurfaceSignature,
    resampleEmbeddedTramRoadSegmentHeights,
    resampleEmbeddedTramRoadSegmentHeightsSteps,
    roadProfileTerrainEvidenceYAtLocal,
    roadSurfaceForEmbeddedTramAtLocal,
    railViaductPillarClearanceAtLocal,
    railViaductTerrainEvidenceBounds,
    railCivilGroundDependencyBounds,
    railCivilGroundDependencySignature,
    noteRailCivilGroundMutation,
    peekRailCivilGroundDependencySnapshot,
    railCivilGroundDependencySnapshot,
    railCivilGroundDependencySnapshotSteps,
    ROAD_UNDER_RAIL_SIDE_OVERLAP_M,
    roadUnderRailFormationOpenings,
} from '../core/rail-road-grade-separation.js';
import { TUNNEL_WALL_M } from '../core/road-grade-separation-spec.js';
import { RoadVerticalAlignmentModel } from '../core/road-vertical-alignment.js';
import {
    GROUND_REMOVAL_CHANNELS,
    ROAD_CARRIAGEWAY_STENCIL_REF,
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_STENCIL_COMPARE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    surfaceGroundRemovalChannelsForClaim,
    surfaceStencilContract,
} from '../core/surface-hierarchy.js';

const railsSource = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
const roadsSource = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');

function functionBody(name, source = railsSource) {
    const start = Math.max(source.indexOf(`function ${name}(`), source.indexOf(`function* ${name}(`));
    assert.notEqual(start, -1, `${name} not found`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(bodyStart + 1, index);
    }
    assert.fail(`${name} has no closing brace`);
}

const ANCHOR_LAT = 45.73;
const ANCHOR_LON = 16.03;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z = 0) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function boundaryPoint(x, z) {
    return {
        innerX: x,
        innerZ: z,
        outerX: x,
        outerZ: z,
    };
}

function crossing(overrides = {}) {
    return {
        coordinate: lonLat(50),
        stationM: 50,
        clearStartM: 45,
        clearEndM: 55,
        angleDeg: 90,
        upperComposition: {
            mode: 'rail',
            formationWidthM: 6,
        },
        lowerComposition: {
            mode: 'road',
            formationWidthM: 10,
        },
        ...overrides,
    };
}

function tramFeature(tags = {}, properties = {}) {
    return {
        type: 'Feature',
        properties: {
            railway_type: 'tram',
            tags,
            ...properties,
        },
        geometry: {
            type: 'LineString',
            coordinates: [lonLat(0), lonLat(100)],
        },
    };
}

test('seats a structurally tagged longitudinal tram on the parallel road deck', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 0,
        definitions: [{
            id: 'road-bridge',
            kind: 'overpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road-1'],
            profile: { type: 'terrain-offset', offsetM: 6.5 },
            crossSection: {
                carriagewayHalfWidthM: 5,
                formationHalfWidthM: 6,
            },
        }],
    });
    const bridgeTram = tramFeature({ bridge: 'yes', layer: '1' });
    const approachTram = tramFeature({ embankment: 'yes' });

    assert.equal(isPotentialRoadCarriedTramFeature(bridgeTram), true);
    assert.equal(isPotentialRoadCarriedTramFeature(approachTram), true);
    assert.equal(
        roadDeckForCarriedTramAtLocal(
            model,
            bridgeTram,
            50,
            12,
            { x: 1, z: 0 },
        ).roadY,
        6.5,
        'a central-reservation tram inherits the same solved deck as the carriageways',
    );
    assert.equal(
        roadDeckForCarriedTramAtLocal(
            model,
            approachTram,
            25,
            8,
            { x: 1, z: 0 },
        ).roadY,
        6.5,
        'the short mapped embankment seam must meet the bridge at deck height',
    );
});

test('cooperative retained flagger preserves exact flags and bounds scans that find no matches', () => {
    const make = () => ({ verticalRetainedWalls: true, formationId: 'f',
        points: [{ outerX: 0, outerZ: 0 }, { outerX: 10, outerZ: 0 }],
        boundarySegmentTags: ['negative-normal', 'negative-normal'], sharedRetainingWallSegments: [false, false] });
    const road = { getSurfaceProfiles: () => [{ verticalRetainedWalls: true,
        points: make().points.map(point => ({ ...point, sharedRailRetainingBoundary: true,
            railBoundarySide: 'negative-normal', railFormationId: 'f' })) }] };
    const expected = make(), actual = make();
    assert.equal(flagRailFormationBoundarySegmentsForRetainedRoadInterfaces([expected], road), 2);
    let clock = 0, next, yields = 0;
    const steps = flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps([actual], road, { now: () => clock++ });
    do { next = steps.next(); yields += !next.done; } while (!next.done);
    assert.equal(next.value, 2); assert.ok(yields > 2); assert.deepEqual(actual, expected);
    let reads = 0, current = true;
    const points = Array.from({ length: 1000 }, () => ({ get sharedRailRetainingBoundary() { reads++; return false; } }));
    const noMatch = flagRailFormationBoundarySegmentsForRetainedRoadInterfacesSteps([make()],
        { getSurfaceProfiles: () => [{ verticalRetainedWalls: true, points }] },
        { now: () => clock++, isCurrent: () => current });
    for (let i = 0; i < 20; i++) { const before = reads; assert.equal(noMatch.next().done, false); assert.ok(reads - before <= 1); }
    const before = reads; current = false;
    assert.deepEqual(noMatch.next(), { value: null, done: true }); assert.equal(reads, before);
});

test('cooperative opening flagger preserves clipped intervals and aborts immediately after an inner yield', () => {
    const make = () => ({ points: [{ innerX: -10, innerZ: 0, outerX: -10, outerZ: 0 },
        { innerX: 10, innerZ: 0, outerX: 10, outerZ: 0 }], internalSegments: [false, false] });
    const opening = { x: 0, z: 0, tangentX: 1, tangentZ: 0, beforeM: 2, afterM: 2, halfWidthM: 2 };
    const expected = make(), actual = make();
    assert.equal(flagRailFormationBoundarySegmentsForRoadOpenings([expected], [opening]), 2);
    let clock = 0, current = true, next;
    const options = { now: () => clock++, isCurrent: () => current };
    const steps = flagRailFormationBoundarySegmentsForRoadOpeningsSteps([actual], [opening], options);
    do { next = steps.next(); } while (!next.done);
    assert.equal(next.value, 2); assert.deepEqual(actual, expected);
    const cancelled = make(), stale = flagRailFormationBoundarySegmentsForRoadOpeningsSteps([cancelled], [opening], options);
    do { next = stale.next(); assert.equal(next.done, false); } while (next.value.phase !== 'opening');
    current = false; assert.deepEqual(stale.next(), { value: null, done: true });
    assert.deepEqual(cancelled.roadOpeningSegmentRanges, [[], []]);
});

test('does not lift transverse, ground-level, or planner tram tracks onto a nearby road bridge', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 0,
        definitions: [{
            id: 'road-bridge',
            kind: 'overpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road-1'],
            profile: { type: 'terrain-offset', offsetM: 6.5 },
        }],
    });
    const bridgeTram = tramFeature({ bridge: 'yes', layer: '1' });
    const groundTram = tramFeature({});
    const plannerTram = tramFeature(
        { bridge: 'yes', layer: '1' },
        { source: 'user' },
    );

    assert.equal(
        roadDeckForCarriedTramAtLocal(
            model,
            bridgeTram,
            50,
            0,
            { x: 0, z: 1 },
        ),
        null,
        'a transverse track is a crossing counterpart, not a deck passenger',
    );
    assert.equal(
        roadDeckForCarriedTramAtLocal(
            model,
            groundTram,
            50,
            0,
            { x: 1, z: 0 },
        ),
        null,
    );
    assert.equal(
        roadDeckForCarriedTramAtLocal(
            model,
            plannerTram,
            50,
            0,
            { x: 1, z: 0 },
        ),
        null,
        'authored planner elevation remains immutable',
    );
});

test('upper rail viaduct is excluded only from lower-road terrain evidence', () => {
    const railFormation = {
        formationAtLocal: x => ({
            structure: x < 10 ? 'viaduct' : 'grade',
            distanceSquared: 1,
            alignment: { halfWidthM: 3 },
        }),
    };
    const terrain = () => 8;
    assert.equal(roadProfileTerrainEvidenceYAtLocal({
        railFormation,
        groundEvidenceSceneYAtLocal: terrain,
        x: 0,
        z: 0,
    }), null);
    assert.equal(roadProfileTerrainEvidenceYAtLocal({
        railFormation,
        groundEvidenceSceneYAtLocal: terrain,
        x: 20,
        z: 0,
    }), 8);
});

test('ordinary longitudinal tram inherits a firm road profile but crossings do not', () => {
    const roadFormation = {
        surfaceAtLocal: () => ({ osmId: 17 }),
        formationAtLocal: () => ({
            osmId: 17,
            roadY: 2.5,
            distanceSquared: 0.25,
            tangentX: 10,
            tangentZ: 0,
        }),
    };
    const ordinary = tramFeature({});
    const embedded = roadSurfaceForEmbeddedTramAtLocal(
        roadFormation,
        ordinary,
        5,
        0,
        { x: 1, z: 0 },
    );
    assert.equal(embedded.roadY, 2.5);
    assert.equal(
        roadSurfaceForEmbeddedTramAtLocal(
            roadFormation,
            ordinary,
            5,
            0,
            { x: 0, z: 1 },
        ),
        null,
    );
    assert.equal(
        roadSurfaceForEmbeddedTramAtLocal(
            roadFormation,
            tramFeature({ bridge: 'yes' }),
            5,
            0,
            { x: 1, z: 0 },
        ),
        null,
        'structural tram ownership remains with the road-deck/rail solver',
    );
    const segment = { feature: ordinary, x1: 0, z1: 0, x2: 10, z2: 0 };
    assert.match(roadEmbeddedTramSurfaceSignature(roadFormation, [segment]), /2\.50:2\.50/);
});

test('embedded-tram signature reuses only endpoint supports from the current road revision', () => {
    let queryCount = 0;
    const roadFormation = {
        revision: 7,
        surfaceAtLocal: () => {
            queryCount += 1;
            return { osmId: 17 };
        },
        formationAtLocal: () => ({
            roadY: 2.5,
            distanceSquared: 0,
            tangentX: 1,
            tangentZ: 0,
        }),
    };
    const feature = tramFeature({});
    const segment = {
        feature,
        x1: 0,
        z1: 0,
        x2: 10,
        z2: 0,
        _embeddedRoadSupport: {
            formation: roadFormation,
            revision: 7,
            start: { roadY: 2.5, osmId: 17, distanceSquared: 0 },
            end: { roadY: 2.5, osmId: 17, distanceSquared: 0 },
        },
    };

    const cached = roadEmbeddedTramSurfaceSignature(
        roadFormation,
        [segment],
        { useResolved: true },
    );
    assert.match(cached, /2\.50:2\.50/);
    assert.equal(queryCount, 0, 'post-build signing must not repeat spatial queries');

    roadFormation.revision = 8;
    const refreshed = roadEmbeddedTramSurfaceSignature(
        roadFormation,
        [segment],
        { useResolved: true },
    );
    assert.equal(refreshed, cached);
    assert.equal(queryCount, 2, 'a later road revision must ignore cached endpoint support');
});

test('embedded-tram road revisions resample only height and reuse signature lookups', () => {
    let queryCount = 0;
    let roadY = 3.25;
    let ownsSurface = true;
    const roadFormation = {
        revision: 12,
        surfaceAtLocal: () => {
            queryCount += 1;
            return ownsSurface ? { osmId: 17 } : null;
        },
        formationAtLocal: () => ({
            roadY,
            distanceSquared: 0,
            tangentX: 1,
            tangentZ: 0,
        }),
    };
    const segment = {
        feature: tramFeature({}),
        x1: 0,
        z1: 0,
        x2: 10,
        z2: 0,
        yStart: 2,
        yEnd: 2,
        sortKey: 'preserved-horizontal-solve',
        _embeddedRoadFallbackYStart: 1.1,
        _embeddedRoadFallbackYEnd: 1.2,
        _embeddedRoadEligibleStart: true,
        _embeddedRoadEligibleEnd: true,
    };

    roadEmbeddedTramSurfaceSignature(
        roadFormation,
        [segment],
        { cacheResolved: true },
    );
    assert.equal(queryCount, 2);
    const [raised] = resampleEmbeddedTramRoadSegmentHeights(
        roadFormation,
        [segment],
    );
    assert.equal(queryCount, 2, 'resampling reuses the signature pass endpoint answers');
    assert.notEqual(raised, segment, 'the published solved chord remains immutable');
    assert.equal(raised.sortKey, segment.sortKey);
    assert.equal(raised.yStart, roadY);
    assert.equal(raised.yEnd, roadY);

    roadFormation.revision += 1;
    ownsSurface = false;
    roadEmbeddedTramSurfaceSignature(
        roadFormation,
        [raised],
        { cacheResolved: true },
    );
    const queriesAfterSignature = queryCount;
    const [returnedToTerrain] = resampleEmbeddedTramRoadSegmentHeights(
        roadFormation,
        [raised],
    );
    assert.equal(queryCount, queriesAfterSignature);
    assert.equal(returnedToTerrain.yStart, 1.1);
    assert.equal(returnedToTerrain.yEnd, 1.2);
});

test('bounded embedded-tram refresh preserves immutable junction offsets', () => {
    let roadY = 3.25;
    const roadFormation = {
        revision: 12,
        surfaceAtLocal: () => ({ osmId: 17 }),
        formationAtLocal: () => ({
            roadY,
            distanceSquared: 0,
            tangentX: 1,
            tangentZ: 0,
        }),
    };
    const segment = {
        feature: tramFeature({}),
        x1: 0,
        z1: 0,
        x2: 10,
        z2: 0,
        yStart: 3.35,
        yEnd: 3.05,
        _embeddedRoadFallbackYStart: 1.1,
        _embeddedRoadFallbackYEnd: 1.2,
        _embeddedRoadEligibleStart: true,
        _embeddedRoadEligibleEnd: true,
        _embeddedRoadSupport: {
            formation: roadFormation,
            revision: 11,
            start: { roadY: 3.25, osmId: 17, distanceSquared: 0 },
            end: { roadY: 3.25, osmId: 17, distanceSquared: 0 },
        },
    };
    roadY = 4;
    const [resampled] = resampleEmbeddedTramRoadSegmentHeights(
        roadFormation,
        [segment],
        { preserveEndpointOffsets: true },
    );
    assert.ok(Math.abs(resampled.yStart - 4.1) < 1e-9);
    assert.ok(Math.abs(resampled.yEnd - 3.8) < 1e-9);
});

test('embedded-tram height resampling yields chunks with synchronous parity', () => {
    const roadFormation = {
        revision: 7,
        surfaceAtLocal: () => ({ osmId: 17 }),
        formationAtLocal: (_x, _z) => ({
            roadY: 2.75,
            distanceSquared: 0,
            tangentX: 1,
            tangentZ: 0,
        }),
    };
    const segments = Array.from({ length: 5 }, (_unused, index) => ({
        feature: tramFeature({}),
        x1: index * 10,
        z1: 0,
        x2: index * 10 + 8,
        z2: 0,
        yStart: 1,
        yEnd: 1,
        sortKey: `segment:${index}`,
        _embeddedRoadEligibleStart: true,
        _embeddedRoadEligibleEnd: true,
    }));
    const iterator = resampleEmbeddedTramRoadSegmentHeightsSteps(
        roadFormation,
        segments,
        { preserveEndpointOffsets: true, segmentsPerYield: 2 },
    );
    const phases = [];
    let outcome = iterator.next();
    while (!outcome.done) {
        phases.push(outcome.value?.phase);
        outcome = iterator.next();
    }
    assert.deepEqual(phases, ['resample', 'resample']);
    assert.deepEqual(
        outcome.value,
        resampleEmbeddedTramRoadSegmentHeights(
            roadFormation,
            segments,
            { preserveEndpointOffsets: true },
        ),
    );
});

test('embedded-tram endpoint resolver queries a shared vertex once but gates each direction', () => {
    let surfaceQueries = 0;
    let formationQueries = 0;
    const roadFormation = {
        surfaceAtLocal: () => {
            surfaceQueries += 1;
            return { osmId: 17 };
        },
        formationAtLocal: () => {
            formationQueries += 1;
            return {
                roadY: 2.5,
                distanceSquared: 0,
                tangentX: 1,
                tangentZ: 0,
            };
        },
    };
    const resolveEndpoint = createEmbeddedTramRoadEndpointResolver({
        roadFormation,
        feature: tramFeature({}),
        points: [{ x: 5, z: 0 }],
    });

    assert.equal(resolveEndpoint(0, { x: 1, z: 0 }).roadY, 2.5);
    assert.equal(resolveEndpoint(0, { x: 0, z: 1 }), null);
    assert.equal(surfaceQueries, 1);
    assert.equal(formationQueries, 1);
    assert.equal(resolveEndpoint(99, { x: 1, z: 0 }), null);
});

test('rail pier clearance rejects the whole road surface and forwards own-track ignore', () => {
    let forwarded = null;
    const base = (_x, _z, options) => {
        forwarded = options;
        return 4;
    };
    assert.equal(railViaductPillarClearanceAtLocal(
        base,
        { surfaceAtLocal: () => ({ osmId: 17 }) },
        0,
        0,
        { ignoreTrackFeature: 'rail' },
    ), -1);
    assert.equal(railViaductPillarClearanceAtLocal(
        base,
        { surfaceAtLocal: () => null },
        10,
        10,
        { ignoreTrackFeature: 'rail' },
    ), 4);
    assert.deepEqual(forwarded, { ignoreTrackFeature: 'rail' });
});

test('rail viaduct terrain evidence invalidation is bounded to its sampled run', () => {
    const bounds = railViaductTerrainEvidenceBounds({
        getViaductRuns: () => [{
            alignment: { halfWidthM: 3 },
            samples: [{ x: 10, z: 20 }, { x: 30, z: 40 }],
        }],
    }, 2);
    assert.deepEqual(bounds, [{ minX: 5, maxX: 35, minZ: 15, maxZ: 45 }]);
});

test('rail dependency bounds include both formation ground and viaduct evidence', () => {
    const bounds = railCivilGroundDependencyBounds({
        getSurfaceProfiles: () => [{
            overlapBounds: { minX: 10, maxX: 20, minZ: 30, maxZ: 40 },
        }],
        getViaductRuns: () => [{
            alignment: { halfWidthM: 2 },
            samples: [{ x: 100, z: 200 }, { x: 120, z: 220 }],
        }],
    }, 3);
    assert.deepEqual(bounds, [
        { minX: 7, maxX: 23, minZ: 27, maxZ: 43 },
        { minX: 95, maxX: 125, minZ: 195, maxZ: 225 },
    ]);
});

test('rail dependency signature ignores revisions but tracks civil-ground height', () => {
    const profile = {
        startStation: 0,
        endStation: 20,
        overlapBounds: { minX: 0, minZ: -6, maxX: 20, maxZ: 6 },
        points: [{
            innerX: 0,
            innerZ: -2,
            roadY: 3,
            outerX: 0,
            outerZ: -4,
            terrainY: 1,
            cutoutX: 0,
            cutoutZ: -5,
            cutoutTerrainY: 1,
            overlapX: 0,
            overlapZ: -6,
            overlapTerrainY: 1,
        }],
        internalSegments: [false],
        collarInternalSegments: [false],
        roadOpeningSegmentRanges: [[]],
    };
    const formation = (revision, surfaceProfile = profile) => ({
        revision,
        getSurfaceProfiles: () => [surfaceProfile],
        getViaductRuns: () => [],
    });
    const baseline = railCivilGroundDependencySignature(formation(1));
    assert.equal(
        railCivilGroundDependencySignature(formation(99)),
        baseline,
        'a broad streamed-model revision is not a ground change',
    );
    assert.notEqual(
        railCivilGroundDependencySignature(formation(2, {
            ...profile,
            points: [{ ...profile.points[0], roadY: 3.25 }],
        })),
        baseline,
        'a changed civil height inside identical bounds must invalidate roads',
    );
});

test('civil-ground dependency diff returns only added and removed rail footprints', () => {
    const profile = (x, roadY) => ({
        startStation: x,
        endStation: x + 20,
        overlapBounds: { minX: x, minZ: 0, maxX: x + 20, maxZ: 10 },
        points: [{
            innerX: x,
            innerZ: 2,
            roadY,
            outerX: x,
            outerZ: 4,
            terrainY: 0,
            cutoutX: x,
            cutoutZ: 5,
            cutoutTerrainY: 0,
            overlapX: x,
            overlapZ: 6,
            overlapTerrainY: 0,
        }],
        internalSegments: [false],
        collarInternalSegments: [false],
        roadOpeningSegmentRanges: [[]],
    });
    const snapshot = profiles => railCivilGroundDependencySnapshot({
        getSurfaceProfiles: () => profiles,
        getViaductRuns: () => [],
    }, 0);
    const previous = snapshot([profile(0, 2), profile(100, 4)]);
    const next = snapshot([profile(0, 2), profile(200, 6)]);

    assert.deepEqual(changedCivilGroundDependencyBounds(
        previous.entries,
        next.entries,
    ), [
        { minX: 100, minZ: 0, maxX: 120, maxZ: 10 },
        { minX: 200, minZ: 0, maxX: 220, maxZ: 10 },
    ]);
});

test('semantic-ground streaming replays only affected roads and pedestrian consumers', () => {
    const refresh = functionBody('refreshCivilGroundDependencies', roadsSource);
    const worker = functionBody('enqueueCivilGroundDependencyRefresh', roadsSource);
    assert.match(refresh, /dependencySnapshotBefore/);
    assert.match(refresh, /enqueueCivilGroundDependencyRefresh\(changedBounds\)/);
    assert.match(worker, /invalidateComposedGroundSteps\(changedBounds\)/);
    assert.match(worker, /FRAME_CHUNK_REPEAT_ITEM/,
        'large invalidation discovery must yield between bounded steps');
    assert.doesNotMatch(worker, /\.invalidateTerrain\(/);
    assert.doesNotMatch(worker, /updateSurfaceFormationTile\(/);
    assert.match(worker, /forceRebuildOsmIds\.has\(String\(osmId\)\)/,
        'exact affected OSM roads should enter the replay queue');
    assert.match(worker, /civilGroundPedestrianOsmIds\(features\)/);
    assert.match(worker, /forceRebuildOsmIds\.add\(osmId\)/,
        'pedestrian surfaces in the changed civil-ground tile must not retain stale DTM');
});

test('roads re-solve crossings through the bounded civil-ground dependency', () => {
    const refresh = functionBody('refreshCivilGroundDependencies', roadsSource);
    const worker = functionBody('enqueueCivilGroundDependencyRefresh', roadsSource);
    assert.match(refresh, /changedCivilGroundDependencyBounds/);
    assert.match(worker, /roadTileIntersectsGroundChange/);
    assert.match(worker, /scheduleSurfaceAlignmentRefresh\(/);
    assert.doesNotMatch(
        refresh,
        /railFormationProvider\?\.\(\)\?\.revision/,
        'irrelevant streamed rail revisions must remain downstream no-ops',
    );
    const frameStart = roadsSource.indexOf('    onFrame(pose, local) {');
    const frameEnd = roadsSource.indexOf('    endSession() {', frameStart);
    assert.match(
        roadsSource.slice(frameStart, frameEnd),
        /refreshCivilGroundDependencies\(\)/,
    );
});

test('rail and road use named semantic authorities instead of layer arrival order', () => {
    assert.match(railsSource, /setGroundAuthority\([\s\S]*CIVIL_GROUND_AUTHORITY\.RAIL/);
    assert.match(roadsSource, /inputSceneYAtLocal\([\s\S]*CIVIL_GROUND_AUTHORITY\.ROAD/);
    assert.match(roadsSource, /setGroundAuthority\([\s\S]*CIVIL_GROUND_AUTHORITY\.ROAD/);
    assert.doesNotMatch(roadsSource, /roadGroundAfterRailFormationYAtLocal/);
});

test('road-carried tram signature ignores unrelated road revisions', () => {
    const bridge = {
        id: 'road-bridge',
        kind: 'overpass',
        definition: {},
        points: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
        nearest(x, z) {
            return { segmentIndex: 0, s: x, distanceSquared: z * z };
        },
        profileYAtS: () => 6.5,
    };
    const unrelated = {
        ...bridge,
        id: 'unrelated-road',
        points: [{ x: 0, z: 100 }, { x: 100, z: 100 }],
        nearest(x, z) {
            return { segmentIndex: 0, s: x, distanceSquared: (z - 100) ** 2 };
        },
    };
    const segment = {
        feature: tramFeature({ bridge: 'yes', layer: '1' }),
        x1: 0,
        z1: 8,
        x2: 100,
        z2: 8,
    };
    const model = alignments => ({ getAlignments: () => alignments });

    const baseline = roadCarriedTramDeckSignature(model([bridge]), [segment]);
    assert.equal(
        roadCarriedTramDeckSignature(model([bridge, unrelated]), [segment]),
        baseline,
        'an unrelated streamed overpass must not invalidate the complete rail mesh',
    );
    assert.equal(
        roadCarriedTramDeckSignature(model([{ ...bridge, id: 'replacement-owner' }]), [segment]),
        baseline,
        'a same-height carriageway ownership swap does not change rendered rail geometry',
    );
    assert.notEqual(
        roadCarriedTramDeckSignature(model([{ ...bridge, profileYAtS: () => 6.75 }]), [segment]),
        baseline,
        'a material change to the deck consumed by the tram must still invalidate rails',
    );
});

test('compiles a road-under-rail crossing into one oriented opening frame', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 0,
        definitions: [{
            id: 'under-rail',
            kind: 'underpass',
            axis: [lonLat(0), lonLat(100)],
            memberOsmIds: ['road-1'],
            profile: { type: 'terrain-offset', offsetM: -6 },
            crossSection: {
                carriagewayHalfWidthM: 3.25,
                formationHalfWidthM: 4,
            },
            crossings: [crossing()],
        }],
    });

    const [opening] = roadUnderRailFormationOpenings(model.getAlignments());

    assert.ok(Math.abs(opening.x - 50) < 1e-5);
    assert.ok(Math.abs(opening.z) < 1e-5);
    assert.ok(Math.abs(opening.tangentX - 1) < 1e-9);
    assert.ok(Math.abs(opening.tangentZ) < 1e-9);
    assert.equal(opening.beforeM, 5.75);
    assert.equal(opening.afterM, 5.75);
    assert.equal(
        opening.halfWidthM,
        4 + TUNNEL_WALL_M + ROAD_UNDER_RAIL_SIDE_OVERLAP_M,
        'the rail seam must open to the rendered tunnel shell, not the wider crossing-analysis envelope',
    );
    assert.equal(opening.leftM, opening.halfWidthM);
    assert.equal(opening.rightM, opening.halfWidthM);
    assert.equal(opening.roadAlignmentId, 'under-rail');
});

test('keeps an asymmetric companion-path side on the rendered tunnel boundary', () => {
    const model = new RoadVerticalAlignmentModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        terrainSceneYAtLocal: () => 0,
        definitions: [
            {
                id: 'under-rail',
                kind: 'underpass',
                axis: [lonLat(0), lonLat(100)],
                memberOsmIds: ['road-1'],
                profile: { type: 'terrain-offset', offsetM: -6 },
                crossSection: {
                    carriagewayHalfWidthM: 3.25,
                    formationHalfWidthM: 4,
                },
                crossings: [crossing()],
            },
            {
                id: 'right-path',
                kind: 'underpass',
                axis: [lonLat(0, -5), lonLat(100, -5)],
                memberOsmIds: ['path-1'],
                profile: { type: 'terrain-offset', offsetM: -6 },
                widthM: 2,
                renderStructure: false,
            },
        ],
    });

    const [opening] = roadUnderRailFormationOpenings(model.getAlignments());

    assert.ok(Math.abs(opening.leftM - 4.63) < 1e-6);
    assert.ok(
        Math.abs(opening.rightM - 7.13) < 1e-6,
        'the opening must follow the companion-expanded structure only on its owning side',
    );
});

test('collects only structural road-under-existing-rail ownership', () => {
    const range = {
        startM: 45,
        endM: 55,
        crossingStationM: 50,
        crossingPoint: { x: 50, z: 0 },
        roadTangent: { x: 1, z: 0 },
        crossing: crossing(),
    };
    const alignments = [
        { id: 'wanted', kind: 'underpass', definition: {}, crossingClearRanges: [range] },
        { id: 'over', kind: 'overpass', definition: {}, crossingClearRanges: [range] },
        {
            id: 'companion',
            kind: 'underpass',
            definition: { renderStructure: false },
            crossingClearRanges: [range],
        },
        {
            id: 'road-road',
            kind: 'underpass',
            definition: {},
            crossingClearRanges: [{
                ...range,
                crossing: crossing({
                    upperComposition: { mode: 'road', formationWidthM: 8 },
                }),
            }],
        },
    ];

    assert.deepEqual(
        roadUnderRailFormationOpenings(alignments).map(entry => entry.roadAlignmentId),
        ['wanted'],
    );
});

test('analytically catches a sparse boundary segment crossing the opening', () => {
    const opening = {
        x: 0,
        z: 0,
        tangentX: 1,
        tangentZ: 0,
        beforeM: 5,
        afterM: 5,
        halfWidthM: 3,
    };

    assert.equal(formationBoundarySegmentIntersectsRoadOpening(
        boundaryPoint(0, -10),
        boundaryPoint(0, 10),
        opening,
    ), true, 'both vertices can be outside while the segment crosses the road void');
    assert.deepEqual(
        formationBoundarySegmentRoadOpeningInterval(
            boundaryPoint(0, -10),
            boundaryPoint(0, 10),
            opening,
        ),
        [0.35, 0.65],
        'the opening must be clipped at exact in-segment stations',
    );
    assert.equal(formationBoundarySegmentIntersectsRoadOpening(
        boundaryPoint(8, -10),
        boundaryPoint(8, 10),
        opening,
    ), false);

    const diagonal = Math.SQRT1_2;
    assert.equal(formationBoundarySegmentIntersectsRoadOpening(
        boundaryPoint(-10, 10),
        boundaryPoint(10, -10),
        {
            ...opening,
            tangentX: diagonal,
            tangentZ: diagonal,
        },
    ), true, 'the same ownership rectangle works at a skew crossing');
});

test('suppresses both rail side walls and their collars, idempotently', () => {
    const profile = {
        points: [
            boundaryPoint(-2, -10),
            boundaryPoint(-2, 10),
            boundaryPoint(2, 10),
            boundaryPoint(2, -10),
        ],
        internalSegments: [false, false, false, false],
    };
    const opening = {
        x: 0,
        z: 0,
        tangentX: 1,
        tangentZ: 0,
        beforeM: 5,
        afterM: 5,
        halfWidthM: 5,
    };

    assert.equal(flagRailFormationBoundarySegmentsForRoadOpenings(
        [profile],
        [opening],
    ), 2);
    assert.deepEqual(profile.internalSegments, [false, false, false, false]);
    assert.deepEqual(profile.roadOpeningSegmentRanges, [
        [[0.25, 0.75]],
        [],
        [[0.25, 0.75]],
        [],
    ]);
    assert.equal(flagRailFormationBoundarySegmentsForRoadOpenings(
        [profile],
        [opening],
    ), 0);
});

test('one snapped parallel road owns the shared vertical face while rail keeps its bench', () => {
    const point = (innerX, outerX, z) => ({
        innerX,
        innerZ: z,
        roadY: 0,
        outerX,
        outerZ: z,
        terrainY: 3,
        wallTerrainY: -0.1,
        cutoutX: outerX + 0.5,
        cutoutZ: z,
        cutoutTerrainY: 3,
        overlapX: outerX + 1,
        overlapZ: z,
        overlapTerrainY: 3,
    });
    const railProfile = {
        formationId: 'approach',
        verticalRetainedWalls: true,
        points: [
            point(-2, 0, -5),
            point(-2, 0, 5),
            point(-4, -4, 5),
            point(-4, -4, -5),
        ],
        boundarySegmentTags: ['positive-normal', 'end', 'negative-normal', 'start'],
        internalSegments: [false, true, true, true],
        collarInternalSegments: [false, true, true, true],
        roadOpeningSegmentRanges: [[], [], [], []],
        sharedRetainingWallSegments: [false, false, false, false],
    };
    const roadProfile = {
        formationStyle: 'vertical-retained',
        verticalRetainedWalls: true,
        points: [
            {
                ...point(2, 0, -5),
                sharedRailRetainingBoundary: true,
                railFormationId: 'approach',
                railBoundarySide: 'positive-normal',
            },
            {
                ...point(2, 0, 5),
                sharedRailRetainingBoundary: true,
                railFormationId: 'approach',
                railBoundarySide: 'positive-normal',
            },
            point(4, 4, 5),
            point(4, 4, -5),
        ],
    };
    const roadFormation = { getSurfaceProfiles: () => [roadProfile] };

    assert.equal(flagRailFormationBoundarySegmentsForRetainedRoadInterfaces(
        [railProfile],
        roadFormation,
    ), 1);
    assert.deepEqual(railProfile.sharedRetainingWallSegments,
        [true, false, false, false]);
    assert.equal(flagRailFormationBoundarySegmentsForRetainedRoadInterfaces(
        [railProfile],
        roadFormation,
    ), 0, 'ownership transfer is idempotent across streamed refreshes');

    const positions = buildRetainingWallPositions(railProfile);
    assert.equal(positions.length, 18,
        'two level-bench triangles remain, but the four duplicate wall/skirt triangles do not');
    assert.equal(buildFormationTerrainCollarPositions(railProfile).length, 0,
        'the road owns the terrain-side collar beyond the shared wall');
});

test('walls and collars stop at the exact road shell instead of scalloping to segment ends', () => {
    const point = (x, z) => ({
        innerX: x,
        innerZ: z,
        roadY: 2,
        outerX: x,
        outerZ: z,
        terrainY: 0,
        wallTerrainY: -0.1,
        cutoutX: x,
        cutoutZ: z,
        cutoutTerrainY: 0,
        overlapX: x + Math.sign(x),
        overlapZ: z + Math.sign(z),
        overlapTerrainY: 0,
    });
    const profile = {
        points: [
            point(-2, -10),
            point(-2, 10),
            point(2, 10),
            point(2, -10),
        ],
        internalSegments: [false, false, false, false],
    };
    const opening = {
        x: 0,
        z: 0,
        tangentX: 1,
        tangentZ: 0,
        beforeM: 5,
        afterM: 5,
        halfWidthM: 5,
    };
    flagRailFormationBoundarySegmentsForRoadOpenings([profile], [opening]);

    const wallPositions = buildRetainingWallPositions(profile);
    const collarPositions = buildFormationTerrainCollarPositions(profile);
    const wallZ = wallPositions.filter((_value, index) => index % 3 === 2);
    const collarZ = collarPositions.filter((_value, index) => index % 3 === 2);
    assert.ok(
        wallZ.every(z => Math.abs(z) >= 5 - 1e-9),
        'retaining-wall remnants must end on the shared opening boundary',
    );
    assert.ok(
        collarZ.every(z => Math.abs(z) >= 5 - 1e-9),
        'terrain-collar remnants must use the same clipped boundary',
    );
    assert.ok(wallZ.some(z => Math.abs(Math.abs(z) - 5) < 1e-9));
    assert.ok(collarZ.some(z => Math.abs(Math.abs(z) - 5) < 1e-9));
});

test('rail lifecycle scopes road deck and structure refreshes to their owned meshes', () => {
    const refreshDeck = functionBody('refreshRoadCarriedTramGeometry');
    const refreshEmbedded = functionBody('refreshEmbeddedTramRoadGeometry');
    const partialRebuild = functionBody('stepCrossingSuppressedFormationMeshes');
    const partialDeckRebuild = functionBody('prepareRoadCarriedTramMeshSteps');
    const partialEmbeddedRebuild = functionBody('rebuildEmbeddedTramMeshes');
    const queueStructureRefresh = functionBody('scheduleRailStructuresRefresh');
    const validateStructureRefresh = functionBody('railStructuresRefreshIsCurrent');
    const stepStructureRefresh = functionBody('stepPendingRailStructuresRefresh');
    const prepareStructures = functionBody('stepRailStructuresPreparation');
    const discardStructureRefresh = functionBody('discardPendingRailStructuresRefresh');
    const partialPillarRebuild = functionBody('scheduleRailStructuresForRoadSurface');
    const mappedSeaStructureRebuild = functionBody('scheduleRailStructuresForMappedSea');
    const terrainCollars = functionBody('addRailFormationTerrainCollarsSteps');

    // Crossing preparation/publication is exercised behaviorally in the ground and lifetime tests.
    assert.doesNotMatch(
        terrainCollars,
        /positions\.push\(\.\.\.visible\.positions\)/,
        'large streamed collar revisions must not expand every vertex into call arguments',
    );
    assert.match(terrainCollars, /applyGroundOwnership\(material, RAIL_EARTHWORK_CLAIM\)/);
    assert.match(terrainCollars, /applySurfaceStencil\(material, RAIL_EARTHWORK_CLAIM\)/);
    const railEarthworkClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.RAIL_EARTHWORK,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        supportReady: true,
        cutsBackstop: true,
    });
    assert.deepEqual(
        surfaceGroundRemovalChannelsForClaim(railEarthworkClaim),
        GROUND_REMOVAL_CHANNELS.NONE,
        'a height-blind road mask must not punch a slot through a rail embankment face',
    );
    const railEarthworkStencil = surfaceStencilContract(railEarthworkClaim);
    assert.equal(railEarthworkStencil.ref, ROAD_CARRIAGEWAY_STENCIL_REF);
    assert.equal(railEarthworkStencil.funcMask, ROAD_CARRIAGEWAY_STENCIL_REF);
    assert.equal(railEarthworkStencil.compare, SURFACE_STENCIL_COMPARE.NOT_EQUAL);
    assert.equal(railEarthworkStencil.writeMask, 0);
    assert.doesNotMatch(partialRebuild, /rebuildVisibleRails/);
    assert.match(refreshDeck, /lastRoadVerticalAlignments\.revision/);
    assert.match(refreshDeck, /isPotentialRoadCarriedTramFeature/);
    assert.match(refreshDeck, /roadCarriedTramDeckSignature/);
    assert.match(refreshDeck, /nextSignature === lastRoadCarriedTramDeckSignature/);
    assert.match(
        railsSource,
        /if \(refreshRoadCarriedTramGeometry\(\)\) \{[\s\S]*rebuildRoadCarriedTramMeshes\(x, z\)/,
        'a settled road-deck revision must replace only the carried-tram rail batch',
    );
    assert.match(partialDeckRebuild, /lastFeatures\.filter\(isPotentialRoadCarriedTramFeature\)/);
    assert.match(partialDeckRebuild, /StructuralTramTrackGeometry/);
    assert.match(partialDeckRebuild, /publishRailCandidateSteps\(/);
    assert.doesNotMatch(partialDeckRebuild, /rebuildVisibleRails/);
    assert.match(partialEmbeddedRebuild, /resampleEmbeddedTramRoadSegmentHeightsSteps\(/);
    assert.match(partialEmbeddedRebuild, /segmentsPerYield: 8/,
        'road-supported tram chords are re-sampled in bounded immutable slices');
    assert.match(partialEmbeddedRebuild, /preserveEndpointOffsets: true/,
        'immutable OSM junction separation is reused instead of globally re-solved');
    assert.match(partialEmbeddedRebuild, /railSegmentsIntersectingBounds\(/,
        'only chords near the immutable road-tile delta are re-sampled');
    assert.match(partialEmbeddedRebuild,
        /previous\.yStart === segment\.yStart[\s\S]*previous\.yEnd === segment\.yEnd[\s\S]*supportUpdates\.push\(\[previous, segment\._embeddedRoadSupport\]\)/,
        'unchanged solved chords retain identity and stage derived support metadata');
    assert.doesNotMatch(partialEmbeddedRebuild, /computeRailTrackbedSegments\(/,
        'a road-only height refresh must retain the solved horizontal chords');
    assert.match(partialEmbeddedRebuild, /nextCellSegments/);
    assert.match(partialEmbeddedRebuild, /changedRailSegmentRenderCellKeys\(/);
    assert.match(partialEmbeddedRebuild, /publishRailCandidateSteps\(/);
    assert.doesNotMatch(partialEmbeddedRebuild, /addRenderedTrackSegmentMeshes/);
    assert.doesNotMatch(partialEmbeddedRebuild, /rebuildVisibleRails/);
    assert.match(railsSource,
        /embeddedTramRefresh === 'structures'[\s\S]{0,180}scheduleRailStructuresForRoadSurface\(\)/,
        'changed pier occupancy must replace only the persistent structure batch');
    assert.match(railsSource,
        /scheduleEmbeddedTramMeshRefresh\(x, z, embeddedTramRefresh\.changedBounds\)/,
        'ordinary embedded-tram height changes must replace only their bounded cells');
    assert.match(railsSource,
        /if \(pendingEmbeddedTramMeshRefresh[\s\S]{0,100}stepPendingEmbeddedTramMeshRefresh\(\)\) return/,
        'one embedded-tram replacement stage advances per frame');
    const stepEmbedded = functionBody('stepPendingEmbeddedTramMeshRefresh');
    assert.match(stepEmbedded, /!pending\.captureInputsCurrent\(\)/,
        'changed captured inputs cancel unpublished rail work');
    assert.match(stepEmbedded, /sourceSegments === lastSampledTrackbedSegments/);
    assert.match(stepEmbedded, /captureRailVisualGroundSteps\(pending, 'rail-embedded-tram'\)/);
    const restartEmbedded = functionBody('restartEmbeddedTramMeshRefresh');
    assert.match(restartEmbedded, /getChangesSince\?\.\(pending\.roadRevision\)/,
        'a restart retains original bounds and intervening road changes');
    assert.match(stepEmbedded, /pending\.iterator\.next\(\)/);
    assert.match(stepEmbedded, /recordLayerFrameMs\(`rails:embeddedRoad:/);
    assert.match(queueStructureRefresh, /pendingRailStructuresRefresh\s*=\s*\{/);
    assert.match(queueStructureRefresh, /structuresGroup,/);
    assert.match(queueStructureRefresh, /sessionToken:\s*railSessionToken/);
    assert.match(queueStructureRefresh, /terrainRevision:\s*Number\(lastTerrain\?\.revision\)/);
    assert.match(validateStructureRefresh, /refresh\.sessionToken !== railSessionToken/);
    assert.match(validateStructureRefresh, /refresh\.mappedSeaRevision !== mappedSeaStructuresRevision/);
    assert.match(discardStructureRefresh, /cancelRailGpuUploadStage\(/);
    assert.match(discardStructureRefresh, /enqueueRailRetirement\(refresh\.structuresGroup\)/);
    assert.match(stepStructureRefresh, /stepRailStructuresPreparation\(refresh\)/);
    assert.match(prepareStructures, /captureRailVisualGroundSteps\(refresh, 'rail-structures'\)/);
    assert.match(prepareStructures, /addRailViaducts\([\s\S]*refresh\.ground\.roadFormation/);
    assert.match(prepareStructures, /addRailTunnels\([\s\S]*refresh\.ground\.railFormation/);
    assert.match(prepareStructures, /createRailGpuPrewarm\(/);
    assert.match(prepareStructures, /enqueueRailGpuUploadStage\(/);
    assert.match(stepStructureRefresh,
        /refresh\.parent\.add\(refresh\.structuresGroup\)[\s\S]*previousStructures\.parent\.remove/,
        'the complete detached structures batch publishes before its predecessor retires');
    assert.match(stepStructureRefresh, /enqueueRailRetirement\(previousStructures\)/,
        'retirement remains cooperative after the atomic swap');
    assert.match(partialPillarRebuild, /scheduleRailStructuresRefresh\('pillarRoad'\)/);
    assert.match(mappedSeaStructureRebuild, /scheduleRailStructuresRefresh\('mappedSea'\)/);
    assert.doesNotMatch(queueStructureRefresh, /rebuildVisibleRails\(/);
    assert.doesNotMatch(partialPillarRebuild, /rebuildVisibleRails\(/);
    assert.match(refreshEmbedded, /lastRoadFormation\.getChangesSince\(previousRevision\)/);
    assert.match(refreshEmbedded, /boundsIntersectAnyRailSegment\([\s\S]*roadChanges\.bounds/);
    assert.match(
        railsSource,
        /roadDeckForCarriedTramAtLocal\([\s\S]*carriedRoadDeckStart\.roadY/,
        'track vertices must prefer their explicitly matched road deck over terrain',
    );
    assert.match(railsSource, /lastRoadVerticalAlignments\s*=\s*null/);
    assert.match(railsSource, /roadUnderRailOpeningAccum\s*=\s*new Map\(\)/);
});

test('rail frame reconciliation waits for the road formation authority to publish', () => {
    const frameStart = railsSource.indexOf('onFrame(pose, local) {');
    const frameEnd = railsSource.indexOf('    endSession() {', frameStart);
    assert.notEqual(frameStart, -1, 'rails onFrame not found');
    assert.notEqual(frameEnd, -1, 'rails endSession not found');
    const frame = railsSource.slice(frameStart, frameEnd);
    const readinessGate = frame.indexOf(
        'lastRoadFormation?.hasPendingBuild?.() === true',
    );

    assert.notEqual(readinessGate, -1, 'rail reconciliation needs a road readiness gate');
    assert.ok(
        frame.indexOf('streamedRailSource.ensureAround') < readinessGate,
        'rail streaming must keep requesting tiles while derived rendering waits',
    );
    for (const downstreamWork of [
        'if (streamedRailRefreshAllowed({ streamedRailDirty, terrainRevisionDirty }))',
        'refreshRoadCarriedTramGeometry()',
        'refreshEmbeddedTramRoadGeometry()',
        'scheduleRailBoundaryRefresh(x, z)',
        'if (terrainRevisionDirty)',
        'rebuildVisibleRails(x, z);',
    ]) {
        assert.ok(
            readinessGate < frame.indexOf(downstreamWork),
            `${downstreamWork} must not force a dirty road formation build`,
        );
    }
});

// Group support, unchanged-cell retention, GPU staging, failure rollback and
// source cancellation are exercised by the production compiler with real
// Three/Rapier in gta-ground-publication.test.mjs; they are not source patterns.

test('terrain refresh stages immutable OSM topology, dressing, and visual publication', () => {
    const resample = functionBody('resampleRailTrackbedSegmentsForTerrain');
    const preparation = functionBody('stepRailVisualPreparation');
    // prepareVisibleRails has a destructured options parameter, so the simple
    // functionBody helper would stop at that parameter's closing brace. Slice
    // the complete declaration explicitly for publication-order assertions.
    const prepareStart = railsSource.indexOf('function prepareVisibleRails(');
    const prepareEnd = railsSource.indexOf('\nfunction ', prepareStart + 1);
    const prepare = railsSource.slice(prepareStart, prepareEnd);
    const publishStart = railsSource.indexOf('function* prepareRailCandidatePublicationSteps(');
    const publish = railsSource.slice(publishStart, railsSource.indexOf('function enqueueRailPublicationPreparation(', publishStart));
    const dressing = functionBody('createRailFormationDressingSteps');
    // The pending-build disposition opens the terrain reconciliation tail of
    // the frame: build completion, resampling, then the terrain refresh itself.
    const frameStart = railsSource.indexOf('const disposition = pendingRailFormationBuildDisposition({');
    const frameEnd = railsSource.indexOf(
        'if (Math.hypot(x - lastRenderCenterX',
        frameStart,
    );
    const terrainRefresh = railsSource.slice(frameStart, frameEnd);

    assert.match(resample, /terrain\.evidenceSceneYAtLocal\?\.\(/);
    assert.match(resample, /const terrainStart = terrain[\s\S]{0,180}: 0;/,
        'an absent terrain authority remains the intentional flat-world datum');
    assert.match(resample, /railFormation\?\.formationAtFeatureStation\?\.\(/);
    assert.match(resample, /roadDeckForCarriedTramAtLocal\(/);
    assert.match(resample, /resampleEmbeddedTramRoadSegmentHeights\(/);
    assert.match(resample, /applyJunctionEndpointLifts\(/);
    assert.match(terrainRefresh, /streamedRailProfileMode === 'osm'/);
    assert.match(terrainRefresh, /stepPendingRailVisualPreparation\(\)/);
    assert.match(preparation, /resampleRailTrackbedSegmentsForTerrain\(/);
    assert.match(terrainRefresh, /centerX: canResampleSolvedChords \? lastRenderCenterX : x/,
        'a height-only refresh must not reset movement-window ownership');
    assert.match(terrainRefresh, /pendingRailVisualRefresh = \{/,
        'the completed formation remains a private candidate during visual preparation');
    assert.match(preparation, /enqueueRailDressingPreparation\(refresh/,
        'CPU dressing must pass through the bounded preparation queue');
    assert.match(preparation, /if \(!refresh\.formationDressingGpuReady\)/,
        'GPU prewarm must remain gated after CPU dressing');
    assert.match(preparation,
        /refresh\.candidate = prepareVisibleRails\([\s\S]*return false;[\s\S]*refresh\.candidatePrewarm = createRailGpuPrewarm\([\s\S]*enqueueRailGpuUploadStage\(refresh[\s\S]*return false;/,
        'detached candidate construction and bounded GPU uploads must finish before publication');
    assert.match(terrainRefresh,
        /if \(!stepPendingRailVisualPreparation\(\)\) return;[\s\S]*refresh\.candidate\?\.committed === true/);
    assert.match(dressing, /addRailFormationTerrainCollarsSteps/);
    assert.match(dressing, /addRailFormationRetainingWallsSteps/);
    assert.match(prepare, /precomputedSegments/);
    assert.match(prepare, /precomputedFormationDressing/);
    assert.ok(
        prepare.indexOf('nextSegments.terrainEvidenceIncomplete')
            < prepare.indexOf('const candidate = build('),
        'incomplete terrain ownership must be resolved before the detached candidate is built',
    );
    assert.ok(
        publish.indexOf('scene.add(candidate.root)')
            < publish.indexOf('enqueueRailRetirement(parent)'),
        'the complete candidate must publish before bounded retirement begins',
    );
    assert.match(railsSource,
        /precomputedFormationDressing:\s*refresh\.formationDressingGroup/,
        'the unpublished dressing must be transferred into the next visual generation');
    assert.match(railsSource,
        /Math\.hypot\(x - lastRenderCenterX, z - lastRenderCenterZ\)[\s\S]*pendingRailVisualRefresh = \{[\s\S]*reason: 'movement'/,
        'movement-window rebuilds must use the same off-scene staged publication');
    assert.match(railsSource,
        /const segments = Array\.isArray\(precomputedSegments\)[\s\S]*computeRailTrackbedSegments/,
        'non-OSM and topology-changing builds retain the complete solver');
});

// ─── Per-frame snapshot memoization ─────────────────────────────────────────
// Roads consult railCivilGroundDependencySnapshot once per FRAME, and computing
// it walks every profile point and viaduct sample (measured 6.4–15 ms/frame in
// terrain worlds). It is now cached per formation. These pin the cache's whole
// contract: reuse while nothing changed, and invalidation on every input that
// the SIGNATURE actually depends on — including the in-place flag edits that do
// not build a new model.
function memoProfile(overrides = {}) {
    return {
        startStation: 0,
        endStation: 20,
        overlapBounds: { minX: 0, minZ: -6, maxX: 20, maxZ: 6 },
        points: [{
            innerX: 0, innerZ: -2, roadY: 3,
            outerX: 0, outerZ: -4, terrainY: 1,
            cutoutX: 0, cutoutZ: -5, cutoutTerrainY: 1,
            overlapX: 0, overlapZ: -6, overlapTerrainY: 1,
        }],
        internalSegments: [false],
        collarInternalSegments: [false],
        roadOpeningSegmentRanges: [[]],
        ...overrides,
    };
}

function memoFormation(profile, revision = 1) {
    return {
        revision,
        getSurfaceProfiles: () => [profile],
        getViaductRuns: () => [],
    };
}

test('a new rail civil-ground snapshot is built in bounded stages before caching', () => {
    const points = Array.from({ length: 96 }, (_, index) => ({
        innerX: index, innerZ: -2, roadY: 3,
        outerX: index, outerZ: -4, terrainY: 1,
        cutoutX: index, cutoutZ: -5, cutoutTerrainY: 1,
        overlapX: index, overlapZ: -6, overlapTerrainY: 1,
    }));
    const samples = Array.from({ length: points.length }, (_, index) => ({ station: index }));
    const segments = Array.from({ length: points.length - 1 }, (_, index) => ({
        startSampleIndex: index,
        endSampleIndex: index + 1,
        x1: index,
        z1: 0,
        x2: index + 1,
        z2: 0,
    }));
    const profile = memoProfile({
        endStation: points.length - 1,
        points,
        internalSegments: new Array(points.length).fill(false),
        collarInternalSegments: new Array(points.length).fill(false),
        roadOpeningSegmentRanges: Array.from({ length: points.length }, () => []),
        alignment: { samples, segments },
        _civilGroundEnvelopeRadiusM: 6,
    });
    const expected = railCivilGroundDependencySnapshot(memoFormation(profile), 15);
    const formation = memoFormation(profile);
    const iterator = railCivilGroundDependencySnapshotSteps(
        formation,
        15,
        { workPerStep: 32 },
    );
    let steps = 0;
    let outcome = iterator.next();
    while (!outcome.done) {
        steps += 1;
        outcome = iterator.next();
    }
    assert.ok(steps > 20, 'large profiles must span many cooperative visits');
    assert.deepEqual(outcome.value, expected);
    assert.equal(
        peekRailCivilGroundDependencySnapshot(formation, 15),
        outcome.value,
        'only the complete staged snapshot becomes visible to frame consumers',
    );
});

test('an unchanged formation is answered from cache, by identity', () => {
    const formation = memoFormation(memoProfile());
    const first = railCivilGroundDependencySnapshot(formation);
    assert.equal(railCivilGroundDependencySnapshot(formation), first,
        'a settled frame must not recompute the snapshot');
    // A different padding is a different question and must be recomputed. Only
    // the latest question is kept (the frame path always asks with the default),
    // so returning to the original padding recomputes rather than resurrecting.
    const padded = railCivilGroundDependencySnapshot(formation, 30);
    assert.notEqual(padded, first);
    assert.ok(padded.entries[0].bounds.maxX > first.entries[0].bounds.maxX);
    const backToDefault = railCivilGroundDependencySnapshot(formation);
    assert.notEqual(backToDefault, padded);
    assert.equal(backToDefault.signature, first.signature);
    assert.equal(railCivilGroundDependencySnapshot(formation), backToDefault,
        'and it is cached again from there');
});

test('a rebuilt model recomputes, and an unchanged ground stays a no-op downstream', () => {
    const profile = memoProfile();
    const before = railCivilGroundDependencySnapshot(memoFormation(profile, 1));
    const after = railCivilGroundDependencySnapshot(memoFormation(profile, 2));
    assert.notEqual(after, before, 'a new model is a new object, so it recomputes');
    assert.equal(after.signature, before.signature,
        'but identical ground must still produce an equal signature');
});

// THE failure this cache could have introduced: the level-crossing and
// road-opening flaggers edit hashed flags on a LIVE formation without building
// a new model or bumping its revision. Serving the pre-flag signature would
// silently keep stale rail ground under the roads exactly when a crossing
// resolves mid-ride — invisible in a settled scene.
test('an in-place flag edit invalidates the cache once it is noted', () => {
    const profile = memoProfile();
    const formation = memoFormation(profile);
    const before = railCivilGroundDependencySnapshot(formation).signature;

    profile.internalSegments[0] = true;          // what flagRetainingWallsForCrossings does
    noteRailCivilGroundMutation(formation);
    const after = railCivilGroundDependencySnapshot(formation).signature;
    assert.notEqual(after, before, 'a crossing wall suppression must reach roads');

    profile.collarInternalSegments[0] = true;
    noteRailCivilGroundMutation(formation);
    assert.notEqual(railCivilGroundDependencySnapshot(formation).signature, after);
});

// The flaggers must mark their own mutation — a caller cannot be relied on to.
// Uses the same fixture shape as the suppression tests above, so the flagger
// really does change hashed ranges (it returns 2); a version of this that
// suppressed nothing would pass while proving nothing.
test('the road-opening flagger invalidates the snapshot whose ground it changed', () => {
    const profile = {
        ...memoProfile(),
        points: [
            boundaryPoint(-2, -10), boundaryPoint(-2, 10),
            boundaryPoint(2, 10), boundaryPoint(2, -10),
        ],
        internalSegments: [false, false, false, false],
        collarInternalSegments: [false, false, false, false],
        roadOpeningSegmentRanges: [[], [], [], []],
        overlapBounds: { minX: -2, minZ: -10, maxX: 2, maxZ: 10 },
    };
    const formation = memoFormation(profile);
    const before = railCivilGroundDependencySnapshot(formation).signature;

    const suppressed = flagRailFormationBoundarySegmentsForRoadOpenings(formation, [{
        x: 0, z: 0, tangentX: 1, tangentZ: 0, beforeM: 5, afterM: 5, halfWidthM: 5,
    }]);
    assert.equal(suppressed, 2, 'the fixture must actually suppress, or this proves nothing');
    assert.notEqual(
        railCivilGroundDependencySnapshot(formation).signature,
        before,
        'the flagger changed hashed ranges, so it must have marked the cache stale',
    );

    // Idempotent: a second identical call changes nothing and needs no bump.
    const settled = railCivilGroundDependencySnapshot(formation);
    assert.equal(flagRailFormationBoundarySegmentsForRoadOpenings(formation, [{
        x: 0, z: 0, tangentX: 1, tangentZ: 0, beforeM: 5, afterM: 5, halfWidthM: 5,
    }]), 0);
    assert.equal(railCivilGroundDependencySnapshot(formation), settled,
        'no change means no recomputation');
});

test('formations do not share cache entries with one another', () => {
    const shared = memoProfile();
    const a = memoFormation(shared);
    const b = memoFormation(memoProfile({ startStation: 5 }));
    const snapshotA = railCivilGroundDependencySnapshot(a);
    const snapshotB = railCivilGroundDependencySnapshot(b);
    assert.notEqual(snapshotA, snapshotB);
    assert.notEqual(snapshotA.signature, snapshotB.signature);
    assert.equal(railCivilGroundDependencySnapshot(a), snapshotA);
});

// Guard: every in-place writer of a HASHED profile field must mark the formation
// stale. If a new hashed field or a new flagger appears, this forces the author
// to revisit invalidation instead of silently reintroducing the stale read.
test('every in-place writer of a hashed profile field notes the mutation', () => {
    const separationSource = readFileSync(
        new URL('../core/rail-road-grade-separation.js', import.meta.url), 'utf8');
    const railsSource = readFileSync(
        new URL('../world/rails.js', import.meta.url), 'utf8');
    // The fields railCivilProfileSignature hashes, pinned so that adding one
    // without considering invalidation fails here.
    const hashedArrays = ['internalSegments', 'collarInternalSegments', 'roadOpeningSegmentRanges'];
    const signatureBody = separationSource.slice(
        separationSource.indexOf('function railCivilProfileSignature'),
        separationSource.indexOf('function railViaductRunGroundSignature'),
    );
    for (const field of hashedArrays) {
        assert.ok(signatureBody.includes(field), `${field} is expected to be hashed`);
    }
    for (const [name, source] of [['rail-road-grade-separation.js', separationSource],
        ['rails.js', railsSource]]) {
        const writesHashedField = hashedArrays.some((field) => (
            new RegExp(`${field}\\[[^\\]]*\\]\\s*=[^=]`).test(source)
        )) || /\bflags\[[^\]]*\]\s*=[^=]/.test(source);
        if (!writesHashedField) continue;
        assert.match(source, /noteRailCivilGroundMutation\(/,
            `${name} edits a hashed profile field in place and must note the mutation`);
    }
});

// The retained-road-interface flagger deliberately does NOT mark the cache
// stale, which is correct only because sharedRetainingWallSegments is not
// hashed. That is an invisible coupling across two files: the day someone hashes
// it — plausible, since it decides which walls render — that flagger silently
// reintroduces the stale read. This goes red exactly then.
test('hashing sharedRetainingWallSegments would require its flagger to note mutations', () => {
    const source = readFileSync(
        new URL('../core/rail-road-grade-separation.js', import.meta.url), 'utf8');
    const signatureBody = source.slice(
        source.indexOf('function railCivilProfileSignature'),
        source.indexOf('function railViaductRunGroundSignature'),
    );
    assert.ok(
        !signatureBody.includes('sharedRetainingWallSegments'),
        'railCivilProfileSignature now hashes sharedRetainingWallSegments — '
        + 'flagRailFormationBoundarySegmentsForRetainedRoadInterfaces mutates it in place '
        + 'on a live formation, so it must now call noteRailCivilGroundMutation()',
    );
});

// Retained read facades have their own identity and use geometry revisions.
// Memoized endpoint answers belong to their source's compiled generation.
test('captured embedded-tram queries reuse support across handles and invalidate geometry or publication changes', () => {
    let queries = 0;
    const live = { revision: 100, surfaceGeometryRevision: 3, surfacePublicationRevision: 8,
        surfaceAtLocal: () => { queries++; return { osmId: 17 }; },
        formationAtLocal: () => ({ roadY: 2.5, distanceSquared: 0, tangentX: 1, tangentZ: 0 }),
    };
    const captured = { ...live, revision: 3 };
    const segment = { feature: tramFeature({}), x1: 0, z1: 0, x2: 10, z2: 0, yStart: 0, yEnd: 0 };
    const sampled = resampleEmbeddedTramRoadSegmentHeights(captured, [segment], { supportCacheSource: live });
    assert.equal(queries, 2);
    assert.equal(sampled[0]._embeddedRoadSupport.formation, live);
    assert.equal(sampled[0].yStart, 2.5);
    roadEmbeddedTramSurfaceSignature(live, sampled, { useResolved: true });
    assert.equal(queries, 2, 'publishing a retained view does not repeat its endpoint queries');
    live.revision++;
    roadEmbeddedTramSurfaceSignature(live, sampled, { useResolved: true });
    assert.equal(queries, 2, 'new source input alone does not change already compiled query geometry');
    live.surfaceGeometryRevision++;
    roadEmbeddedTramSurfaceSignature(live, sampled, { useResolved: true });
    assert.equal(queries, 4);
    live.surfaceGeometryRevision--;
    live.surfacePublicationRevision++;
    roadEmbeddedTramSurfaceSignature(live, sampled, { useResolved: true });
    assert.equal(queries, 6, 'terrain ownership readiness is a query input even with identical geometry');
});
