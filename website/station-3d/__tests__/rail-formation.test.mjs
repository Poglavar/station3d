// Verifies engineered rail grades and cut/fill seams without Three.js or a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTunnelPortalTerrainOpening,
    buildTunnelPortalRoofCapFootprint,
    classifyTunnelSegments,
    classifyViaductSegments,
    dedupeRailTunnelPortalMouths,
    designRailVerticalProfile,
    interpolateUnknownTerrain,
    isEngineeredRailFeature,
    knownExtreme,
    isReconstructedRailFeature,
    OSM_CUT_AVOIDANCE_RATIO,
    RECONSTRUCTION_STRUCTURE_MIN_RUN_M,
    RECONSTRUCTION_TERRAIN_SMOOTHING_M,
    smoothedSegmentExtremes,
    railBoreHalfWidthM,
    railTunnelSectionForFeature,
    railMaxGradeForFeature,
    RailFormationModel,
    RENDERED_TUNNEL_BED_ABOVE_RAIL_M,
    suppressRailFormationDressingAtTunnelPortals,
    TUNNEL_PORTAL_ROOF_CAP_BURY_M,
    TUNNEL_PORTAL_ROOF_CAP_LATERAL_OVERLAP_M,
    TUNNEL_PORTAL_TERRAIN_OPENING_MARGIN_M,
    TRAIN_MAX_GRADE,
    TRAM_MAX_GRADE,
} from '../core/rail-formation.js';
import {
    buildFormationSurfaceApronGeometryData,
    buildFormationTerrainCollarPositions,
    buildRetainingWallPositions,
} from '../core/road-formation.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import {
    formatRailChainage,
    formatSignedGradePercent,
} from '../core/rail-readout.js';

const ANCHOR_LAT = 43.52;
const ANCHOR_LON = 16.4;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function track(points, properties = {}) {
    return {
        type: 'Feature',
        properties: { source: 'cb-proposal', proposalId: '5', ...properties },
        geometry: {
            type: 'LineString',
            coordinates: points.map(([x, z, elevationM]) => {
                const coordinate = lonLat(x, z);
                if (Number.isFinite(elevationM)) coordinate.push(elevationM);
                return coordinate;
            }),
        },
    };
}

test('publishes cut/fill as effective ground for the next civil-work layer', () => {
    const feature = track(
        [[0, 0, 2], [100, 0, 2]],
        { elevationMode: 'absolute', elevationDatum: 'EVRF2000' },
    );
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2,
    });
    const [profile] = model.getSurfaceProfiles();
    assert.ok(profile, 'ordinary rail fill should publish a surface profile');
    assert.ok(Math.abs(model.civilGroundSceneYAtLocal(50, 0, {
        surfaceOffsetY: 0.075,
    }) - 2.075) < 1e-6, 'the protected trackbed is the first civil ground owner');

    const sideA = profile.points.find(point => Math.abs(point.innerZ) > 1.5);
    assert.ok(sideA);
    const flankX = (sideA.innerX + sideA.outerX) * 0.5;
    const flankZ = (sideA.innerZ + sideA.outerZ) * 0.5;
    const flankY = model.civilGroundSceneYAtLocal(flankX, flankZ, {
        surfaceOffsetY: 0.075,
    });
    assert.ok(flankY > 0 && flankY < 2.075,
        `the consumable rail batter must interpolate to terrain (got ${flankY})`);
    assert.equal(model.civilGroundSceneYAtLocal(50, 50), null,
        'outside the rail envelope the caller must retain the DGU terrain');
});

test('a declared road interface resolves onto the reviewed rail-side wall plane', () => {
    const feature = track([[0, 0, 0], [30, 0, 0]], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railSourceChainagesM: [1000, 1030],
        railFormationSections: [{
            sourceStartM: 1000,
            sourceEndM: 1030,
            style: 'vertical-retained',
        }],
        railRoadInterfaces: [{
            osmWayId: 'road-1',
            style: 'vertical-retained',
            railBoundarySide: 'positive-normal',
            boundaryContinuationM: 6,
            boundarySnapDistanceM: 3,
        }],
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 3,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2,
    });
    const profile = model.getSurfaceProfiles()[0];
    const index = profile.boundarySegmentTags.indexOf('positive-normal');
    assert.ok(index >= 0, 'densification preserves the reviewed rail side');
    const point = profile.points[index];
    const resolved = model.retainedBoundaryForRoadInterfaceAtLocal(
        'road-1',
        point.outerX + 0.4,
        point.outerZ,
    );
    assert.ok(resolved?.sharedRailRetainingBoundary);
    assert.equal(resolved.railBoundarySide, 'positive-normal');
    assert.ok(Math.hypot(
        resolved.x - point.outerX,
        resolved.z - point.outerZ,
    ) < 1e-6);
    const sameRoadVertexA = model.retainedBoundaryForRoadInterfaceAtLocal(
        'road-1',
        point.outerX + 0.2,
        point.outerZ - 0.7,
        { innerX: point.innerX, innerZ: point.innerZ },
    );
    const sameRoadVertexB = model.retainedBoundaryForRoadInterfaceAtLocal(
        'road-1',
        point.outerX - 0.6,
        point.outerZ + 0.5,
        { innerX: point.innerX, innerZ: point.innerZ },
    );
    assert.deepEqual(
        [sameRoadVertexA.x, sameRoadVertexA.z],
        [sameRoadVertexB.x, sameRoadVertexB.z],
        'two adjoining road polygons resolve their shared vertex to one wall point',
    );
    const terminalIndex = profile.boundarySegmentTags.findIndex((tag, candidateIndex) => {
        if (tag !== 'positive-normal') return false;
        const previousIndex = (
            candidateIndex - 1 + profile.boundarySegmentTags.length
        ) % profile.boundarySegmentTags.length;
        const nextIndex = (candidateIndex + 1) % profile.boundarySegmentTags.length;
        return ['start', 'end'].includes(profile.boundarySegmentTags[previousIndex])
            || ['start', 'end'].includes(profile.boundarySegmentTags[nextIndex]);
    });
    assert.ok(terminalIndex >= 0);
    const previousIndex = (
        terminalIndex - 1 + profile.boundarySegmentTags.length
    ) % profile.boundarySegmentTags.length;
    const nextIndex = (terminalIndex + 1) % profile.boundarySegmentTags.length;
    const extendsFromStart = ['start', 'end'].includes(
        profile.boundarySegmentTags[previousIndex],
    );
    const capIndex = extendsFromStart ? previousIndex : nextIndex;
    profile.internalSegments[capIndex] = true;
    const a = profile.points[terminalIndex];
    const b = profile.points[(terminalIndex + 1) % profile.points.length];
    const dx = b.outerX - a.outerX;
    const dz = b.outerZ - a.outerZ;
    const length = Math.hypot(dx, dz);
    const tangentX = dx / length;
    const tangentZ = dz / length;
    const terminal = extendsFromStart ? a : b;
    const direction = extendsFromStart ? -1 : 1;
    const extended = model.retainedBoundaryForRoadInterfaceAtLocal(
        'road-1',
        terminal.outerX + tangentX * direction * 4,
        terminal.outerZ + tangentZ * direction * 4,
    );
    assert.ok(extended?.railBoundaryContinuation,
        'an open portal cap carries the reviewed wall plane through its throat');
    assert.ok(Number.isFinite(extended.retainedBaseY),
        'the continued wall carries the rail-floor elevation as well as x/z');
    assert.equal(model.retainedBoundaryForRoadInterfaceAtLocal(
        'road-1',
        terminal.outerX + tangentX * direction * 10,
        terminal.outerZ + tangentZ * direction * 10,
    ), null, 'the portal-wall continuation is bounded by the declaration');
    assert.equal(model.retainedBoundaryForRoadInterfaceAtLocal(
        'unreviewed-road',
        point.outerX,
        point.outerZ,
    ), null);
});

test('civil-ground lookup ignores profiles whose broad AABB contains the query', () => {
    const features = Array.from({ length: 8 }, (_, index) => track(
        [[-200, -200, 2], [-200, 200, 2], [200, 200, 2]],
        {
            proposalId: `spatial-${index}`,
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
        },
    ));
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features,
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2,
    });
    assert.equal(model.getSurfaceProfiles().length, features.length);

    model.resetCivilGroundProfileCheckCount();
    assert.equal(model.civilGroundSceneYAtLocal(0, 0), null);
    assert.equal(model.getCivilGroundProfileCheckCount(), 0,
        'a query inside only the rectangular AABBs must not inspect their narrow corridors');
});

test('rejects a narrow DTM spike and enforces the railway maximum grade', () => {
    const samples = [];
    for (let station = 0; station <= 1000; station += 20) {
        samples.push({
            station,
            terrainY: station * 0.01 + (station === 500 ? 100 : 0),
        });
    }
    const designed = designRailVerticalProfile(samples, {
        denoiseRadiusM: 40,
        smoothingRadiusM: 240,
        maxGrade: 0.025,
    });
    assert.equal(designed[0], samples[0].terrainY);
    assert.equal(designed.at(-1), samples.at(-1).terrainY);
    assert.ok(designed[25] < 10, `spike leaked into rail profile: ${designed[25]}`);
    for (let index = 1; index < designed.length; index++) {
        const grade = Math.abs(designed[index] - designed[index - 1]) / 20;
        assert.ok(grade <= 0.025 + 1e-9, `grade ${grade} exceeds limit`);
    }
});

test('OSM cut avoidance biases a smoothed profile toward fill instead of excavation', () => {
    const samples = [];
    for (let station = 0; station <= 1000; station += 20) {
        samples.push({
            station,
            terrainY: station >= 300 && station <= 700 ? 8 : 0,
        });
    }
    const neutral = designRailVerticalProfile(samples, { cutAvoidanceRatio: 0 });
    const inferred = designRailVerticalProfile(samples, {
        cutAvoidanceRatio: OSM_CUT_AVOIDANCE_RATIO,
    });
    assert.ok(inferred[25] > neutral[25],
        `expected less cut at the broad rise, got ${inferred[25]} versus ${neutral[25]}`);
    assert.equal(inferred[0], neutral[0]);
    assert.equal(inferred.at(-1), neutral.at(-1));
});

test('ground-relative authored elevations seat as terrain + offset, never re-designed', () => {
    // The transit-project import shape: coordinate[2] is metres above the
    // ground at that point (levels × 10). A +10 m span over flat "water" must
    // come out exactly 10 m up — a grade solve would have flattened it into
    // the terrain, which is precisely the bay-bridge bug this mode fixes.
    const feature = track(
        [[-400, 0, 0], [-100, 0, 10], [100, 0, 10], [400, 0, 0]],
        { elevationMode: 'ground-relative' },
    );
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => -2,   // sea surface sits below the datum
        halfWidthForFeature: () => 2,
    });
    const midDeck = model.formationAtLocal(0, 0, { requireSurface: true });
    assert.ok(midDeck, 'no formation over the crossing');
    assert.ok(Math.abs(midDeck.railY - 8) < 0.75,
        `deck should ride ~terrain(-2) + 10 = 8, got ${midDeck.railY}`);
    const approach = model.formationAtLocal(-400, 0, { requireSurface: true });
    assert.ok(approach, 'no formation at the approach');
    assert.ok(Math.abs(approach.railY - (-2)) < 0.75,
        `grade end should sit on the terrain, got ${approach.railY}`);
});

test('ground-relative mode demands an offset on every point', () => {
    const feature = track(
        [[-400, 0, 0], [0, 0], [400, 0, 0]],
        { elevationMode: 'ground-relative' },
    );
    assert.throws(() => new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
        halfWidthForFeature: () => 2,
    }), /ground-relative/);
});

test('keeps the rail bed level across the slope and builds a sealed retaining seam', () => {
    const feature = track([[-500, 0], [500, 0]]);
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x, z) => x * 0.01 + z * 0.7,
        halfWidthForFeature: () => 2,
        surfaceHalfWidthForFeature: () => 1,
    });
    const left = model.formationAtLocal(120, -1.8, { requireSurface: true });
    const right = model.formationAtLocal(120, 1.8, { requireSurface: true });
    assert.ok(left && right);
    assert.ok(Math.abs(left.railY - right.railY) < 1e-9);
    assert.equal(model.formationAtLocal(120, 2.2, { requireSurface: true }), null);

    const [profile] = model.getSurfaceProfiles();
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
    assert.ok(profile.overlapBounds.minX <= profile.outerBounds.minX);
    assert.ok(profile.overlapBounds.maxX >= profile.outerBounds.maxX);
    assert.ok(profile.points.some((point) => Math.abs(point.terrainY - point.roadY) > 1));
    assert.ok(profile.points.some((point) => point.terrainY > point.roadY));
    assert.ok(profile.points.some((point) => point.terrainY < point.roadY));
    for (const point of profile.points) {
        assert.ok(point.wallTerrainY < point.terrainY);
        assert.ok(Math.abs(point.wallTerrainY - (point.terrainY - 0.4)) < 1e-9);
        assert.ok(Math.abs(point.surfaceApronWidthM - 1) < 1e-9);
    }
    assert.equal(profile.alignment.surfaceHalfWidthM, 1);
    const wallPositions = buildRetainingWallPositions(profile, 0.075);
    assert.ok(wallPositions.length > 0);
    assert.equal(wallPositions.length, profile.points.length * 54);
    assert.ok(wallPositions.every(Number.isFinite));
    // Vertex order is winding-dependent (each triangle faces the air side), so
    // assert the seam by content: segment 0's face quad must carry both wall
    // tops and both terrain toes, and its skirt both buried toes.
    const segment0Ys = wallPositions.slice(0, 54).filter((_, index) => index % 3 === 1);
    const countNear = (list, value) => list.filter((v) => Math.abs(v - value) < 1e-9).length;
    assert.ok(countNear(segment0Ys, profile.points[0].roadY + 0.075) >= 1);
    assert.ok(countNear(segment0Ys, profile.points[1].roadY + 0.075) >= 1);
    assert.ok(countNear(segment0Ys, profile.points[0].terrainY) >= 2);
    assert.ok(countNear(segment0Ys, profile.points[1].terrainY) >= 2);
    assert.ok(countNear(segment0Ys, profile.points[0].wallTerrainY) >= 1);
    assert.ok(countNear(segment0Ys, profile.points[1].wallTerrainY) >= 1);
    assert.equal(profile.wallTopUnderlapM, 0.2);
    const wallTopCoordinates = profile.points.map((point) => {
        const dx = point.innerX - point.outerX;
        const dz = point.innerZ - point.outerZ;
        const length = Math.hypot(dx, dz);
        return {
            x: point.innerX + dx / length * profile.wallTopUnderlapM,
            z: point.innerZ + dz / length * profile.wallTopUnderlapM,
        };
    });
    for (let index = 0; index < profile.points.length; index++) {
        assert.ok(Math.abs(Math.hypot(
            wallTopCoordinates[index].x - profile.points[index].innerX,
            wallTopCoordinates[index].z - profile.points[index].innerZ,
        ) - 0.2) < 1e-9, 'the wall top must overlap beneath the trackbed curb');
    }
    const seamCoordinates = new Set(profile.points.flatMap((point, index) => [
        `${wallTopCoordinates[index].x},${wallTopCoordinates[index].z}`,
        `${point.innerX},${point.innerZ}`,
        `${point.outerX},${point.outerZ}`,
    ]));
    for (let index = 0; index < wallPositions.length; index += 3) {
        assert.ok(seamCoordinates.has(`${wallPositions[index]},${wallPositions[index + 2]}`));
    }
    const apron = buildFormationSurfaceApronGeometryData(profile, 0.075);
    assert.equal(apron.positions.length, profile.points.length * 18);
    assert.equal(apron.uvs.length, profile.points.length * 12);
    assert.ok(apron.positions.every(Number.isFinite));
    assert.ok(apron.uvs.every(Number.isFinite));
    const apronYs = apron.positions.filter((_value, index) => index % 3 === 1);
    assert.ok(apronYs.every((value, index) => {
        const segmentIndex = Math.floor(index / 6);
        const a = profile.points[segmentIndex];
        const b = profile.points[(segmentIndex + 1) % profile.points.length];
        return Math.abs(value - (a.roadY + 0.075)) < 1e-9
            || Math.abs(value - (b.roadY + 0.075)) < 1e-9;
    }), 'the formation apron must share the rendered trackbed datum');
    // The mask now stops at the toe, so the coincident outer→cutout row is
    // omitted and one visible row overlaps intact terrain out to overlapRing.
    // Vertex order is winding-dependent, so assert the row content.
    const collarPositions = buildFormationTerrainCollarPositions(profile);
    assert.equal(collarPositions.length, profile.points.length * 18);
    const collarRowYs = collarPositions.slice(0, 18).filter((_, index) => index % 3 === 1);
    assert.ok(countNear(collarRowYs, profile.points[0].cutoutTerrainY) >= 1);
    assert.ok(countNear(collarRowYs, profile.points[1].cutoutTerrainY) >= 1);
    assert.ok(countNear(collarRowYs, profile.points[0].overlapTerrainY) >= 1);
});

test('an uphill flank is excavated even when the rail centerline is at grade', () => {
    const feature = track([[-120, 0, 0], [120, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        // Center z=0 is exactly at rail level. Only the +z formation edge is
        // buried — the Split failure that center-only excavation missed.
        baseSceneYAtLocal: (_x, z) => (z > 1 ? 5 : 0),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const [profile] = model.getSurfaceProfiles();
    assert.ok(profile, 'formation profile missing');
    assert.ok(profile.points.some(point => point.innerTerrainY > point.roadY + 4));
    assert.equal(profile.excavationRegions.length, 1, 'civil surfaces/buildings must clear');
    assert.equal(profile.terrainExcavationRegions.length, 1, 'bare terrain must clear');
});

test('model-terrain OSM rail daylights its uphill cut instead of letting terrain pierce the wall', () => {
    const feature = track([[-120, 0], [120, 0]], {
        source: 'osm',
        proposalId: 'inferred-cut',
        railway_type: 'rail',
        railMode: 'train',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
    });
    const options = {
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (_x, z) => z,
        halfWidthForFeature: () => 2,
    };
    const narrow = new RailFormationModel(options).getSurfaceProfiles()[0];
    const benched = new RailFormationModel({
        ...options,
        crossSlopeBenchForInferred: true,
    }).getSurfaceProfiles()[0];
    const cutReach = profile => Math.max(...profile.points
        .filter(point => point.innerTerrainY > point.roadY + 0.5)
        .map(point => Math.hypot(
            point.outerX - point.innerX,
            point.outerZ - point.innerZ,
        )));
    assert.ok(cutReach(benched) >= 2,
        'the model-world cut should reach its depth-earned daylight bench');
    assert.ok(cutReach(benched) > cutReach(narrow) + 1,
        'the explicit model-world policy must widen only inferred cut dressing');
});

test('connected OSM ways do not build false retaining caps across one physical track', () => {
    const properties = {
        source: 'osm',
        railway_type: 'rail',
        railMode: 'train',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
    };
    const before = track([[-120, 0], [0, 0]], { ...properties, proposalId: 'before' });
    const after = track([[0, 0], [120, 0]], { ...properties, proposalId: 'after' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [before, after],
        baseSceneYAtLocal: () => 0,
        halfWidthForFeature: () => 2,
    });
    const beforeProfile = model.getSurfaceProfiles()
        .find(profile => profile.alignment.feature === before);
    const afterProfile = model.getSurfaceProfiles()
        .find(profile => profile.alignment.feature === after);
    assert.ok(beforeProfile && afterProfile);
    const tagged = (profile, side) => profile.boundarySegmentTags
        .map((tag, index) => ({ tag, index }))
        .filter(item => item.tag === side);
    assert.ok(tagged(beforeProfile, 'end').length > 0);
    assert.ok(tagged(afterProfile, 'start').length > 0);
    assert.ok(tagged(beforeProfile, 'end').every(({ index }) => (
        beforeProfile.internalSegments[index]
        && beforeProfile.collarInternalSegments[index]
    )), 'the split-node end cap must be open');
    assert.ok(tagged(afterProfile, 'start').every(({ index }) => (
        afterProfile.internalSegments[index]
        && afterProfile.collarInternalSegments[index]
    )), 'the continuation start cap must be open');
    assert.ok(tagged(beforeProfile, 'start').some(({ index }) => (
        !beforeProfile.internalSegments[index]
    )), 'the real outer route end keeps its cap');
    assert.ok(tagged(afterProfile, 'end').some(({ index }) => (
        !afterProfile.internalSegments[index]
    )), 'the real outer route end keeps its cap');
});

test('parallel at-grade rail profiles yield only fully covered collars to neighbouring trackbeds', () => {
    const properties = {
        source: 'osm',
        railway_type: 'rail',
        railMode: 'train',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
    };
    const left = track([[-100, 0], [100, 0]], { ...properties, proposalId: 'left' });
    const right = track([[-100, 4.5], [100, 4.5]], { ...properties, proposalId: 'right' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [left, right],
        baseSceneYAtLocal: () => 0,
        halfWidthForFeature: () => 2,
    });
    const profiles = model.getSurfaceProfiles();
    assert.equal(profiles.length, 2);
    assert.ok(profiles.every(profile => profile.collarInternalSegments.some(
        (hidden, index) => hidden && !profile.internalSegments[index],
    )), 'each track keeps its wall but removes collar triangles wholly covered by the other bed');
});

test('a partial neighbouring trackbed cannot remove a complete embankment collar segment', () => {
    const properties = {
        source: 'osm',
        railway_type: 'rail',
        railMode: 'train',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
    };
    const left = track([[-100, 0], [100, 0]], { ...properties, proposalId: 'left' });
    const right = track([[-100, 5.5], [100, 5.5]], { ...properties, proposalId: 'right' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [left, right],
        baseSceneYAtLocal: () => 0,
        halfWidthForFeature: () => 2,
    });
    const profiles = model.getSurfaceProfiles();
    assert.equal(profiles.length, 2);
    assert.ok(profiles.every(profile => profile.collarInternalSegments.every(hidden => !hidden)),
        'partial overlap must retain the whole collar instead of opening a see-through slot');
});

test('uses the designed longitudinal grade instead of the raw terrain height', () => {
    const feature = track([[-300, 0], [300, 0]]);
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.abs(x) < 12 ? 80 : 0,
        halfWidthForFeature: () => 1.5,
    });
    const formation = model.formationAtLocal(0, 0);
    assert.ok(formation);
    assert.ok(formation.railY < 10, `rail still drapes over DTM spike: ${formation.railY}`);
    assert.ok(Math.abs(model.slopeAlongHeadingDegAtLocal(0, 0, 90)) < 1);
});

test('reports signed grade in the vehicle direction and chainage from proposal start', () => {
    const first = track([[-100, 0, 100], [0, 0, 102]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const second = track([[0, 0, 102], [100, 0, 104]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [first, second],
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: (heightM) => heightM,
    });
    const formation = model.formationAtLocal(50, 0);
    assert.ok(formation);
    assert.ok(Math.abs(formation.stationM - 150) < 0.05, `station=${formation.stationM}`);
    assert.ok(Math.abs(model.gradeAlongHeadingAtLocal(50, 0, 90) - 0.02) < 1e-6);
    assert.ok(Math.abs(model.gradeAlongHeadingAtLocal(50, 0, 270) + 0.02) < 1e-6);
    assert.equal(formatRailChainage(12449.6), 'km 12+450');
    assert.equal(formatSignedGradePercent(1.26), '+1.3%');
    assert.equal(formatSignedGradePercent(-0.84), '−0.8%');
    assert.equal(formatSignedGradePercent(0.01), '0.0%');
    // A vehicle with no chainage must read as nothing, not as km 0+000 on the
    // level. Number(null) is 0, so this is the difference between an absent
    // measurement and a confident wrong one.
    for (const absent of [null, undefined, '', NaN, Infinity]) {
        assert.equal(formatRailChainage(absent), '', `chainage ${String(absent)}`);
        assert.equal(formatSignedGradePercent(absent), '', `grade ${String(absent)}`);
    }
    assert.equal(formatRailChainage('12449.6'), '', 'a numeric string is not a measurement');
});

test('does not engineer ordinary OSM rails implicitly', () => {
    const feature = track([[-100, 0], [100, 0]], { source: 'osm', terrainFormation: null });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
    });
    assert.equal(model.revision, 0);
    assert.equal(model.getSurfaceProfiles().length, 0);
});

test('ordinary prepared OSM tram produces no embankment or retaining profile', () => {
    const feature = track([[-100, 0], [100, 0]], {
        source: 'osm',
        railway_type: 'tram',
        railMode: 'tram',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: x => x < 0 ? 0 : 3,
    });
    assert.equal(model.revision, 0);
    assert.equal(model.getSurfaceProfiles().length, 0);
    assert.equal(model.getViaductRuns().length, 0);
});

test('uses different default grading constraints for train and tram proposals', () => {
    assert.equal(railMaxGradeForFeature(track([], { railMode: 'train', trackType: 'g1435' })), TRAIN_MAX_GRADE);
    assert.equal(railMaxGradeForFeature(track([], { railMode: 'tram', trackType: 'g1000' })), TRAM_MAX_GRADE);
    assert.ok(TRAM_MAX_GRADE > TRAIN_MAX_GRADE);
});

test('renders complete EVRF2000 proposal elevations exactly in scene coordinates', () => {
    const feature = track([
        [0, 0, 112],
        [100, 0, 116],
        [200, 0, 120],
    ], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
        railMode: 'train',
        trackType: 'g1435',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => -20,
        absoluteSceneYAtHeight: (heightM) => heightM - 100,
        halfWidthForFeature: () => 2,
    });
    assert.ok(Math.abs(model.formationAtLocal(0, 0).railY - 12) < 1e-6);
    assert.ok(Math.abs(model.formationAtLocal(100, 0).railY - 16) < 1e-6);
    assert.ok(Math.abs(model.formationAtLocal(200, 0).railY - 20) < 1e-6);
});

test('rejects incomplete authored elevation features instead of silently terrain-grading them', () => {
    const feature = track([[0, 0, 112], [100, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    assert.throws(() => new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: (heightM) => heightM,
    }), /invalid absolute elevations/);
});

test('bridges short terrain crests and removes isolated short viaduct fragments', () => {
    const segments = [
        { length: 35, maxFillM: 6 },
        { length: 20, maxFillM: 1 },
        { length: 35, maxFillM: 6 },
        { length: 10, maxFillM: 6 },
        { length: 80, maxFillM: 0 },
        { length: 10, maxFillM: 6 },
    ];
    assert.deepEqual(classifyViaductSegments(segments), [true, true, true, true, false, false]);
});

test('excludes viaduct spans from terrain cutout profiles', () => {
    const feature = track([[0, 0, 10], [200, 0, 10]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    assert.equal(model.getViaductRuns().length, 1);
    assert.equal(model.getSurfaceProfiles().length, 0);
    assert.ok(model.getViaductRuns()[0].lengthM > 190);
});

test('bridges brief exposed gaps and drops isolated short tunnel fragments', () => {
    const segments = [
        { length: 45, maxCoverM: 22 },
        { length: 20, maxCoverM: 4 },
        { length: 45, maxCoverM: 22 },
        { length: 10, maxCoverM: 22 },
        { length: 80, maxCoverM: 0 },
        { length: 10, maxCoverM: 22 },
    ];
    assert.deepEqual(classifyTunnelSegments(segments), [true, true, true, true, false, false]);
});

test('a tunnel covering a clipped feature stays entirely bored with no invented end cuts', () => {
    // Rail authored dead level at 0 m; terrain buries it by 30 m everywhere, so
    // the whole route is a tunnel.
    const feature = track([[0, 0, 0], [300, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 30,
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    assert.equal(model.getTunnelRuns().length, 1);
    assert.equal(model.getViaductRuns().length, 0);
    const run = model.getTunnelRuns()[0];
    assert.ok(run.lengthM > 290, `tunnel run too short: ${run.lengthM}`);
    assert.ok(run.samples.every((s) => s.minCoverM >= 15));
    assert.deepEqual(model.getSurfaceProfiles(), []);
});

test('a deep-middle hill tunnels only where cover tops the threshold, cutting the approaches', () => {
    // Flat rail at 0; terrain is a ridge peaking 40 m over the middle, falling
    // to grade at the ends → tunnel in the middle, open cut on the approaches.
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    assert.equal(model.getTunnelRuns().length, 1);
    assert.ok(model.getSurfaceProfiles().length >= 1, 'expected open-cut approaches');
    const run = model.getTunnelRuns()[0];
    // cover ≥ 7.75 (8 m rule − tolerance) where 40 − 0.2|x| ≥ 7.75 → |x| ≤ 161,
    // ~322 m of bore, leaving ~39 m of open cut on each approach.
    assert.ok(run.lengthM > 280 && run.lengthM < 360, `tunnel span ${run.lengthM}`);
});

test('published civil runs override terrain classification at exact chainages', () => {
    // The terrain would classify this entire 400 m line as tunnel. The solved
    // profile says ordinary formation → 150 m tunnel → ordinary formation, on
    // the source project's 1000..1400 m axis. Boundaries fall between the raw
    // geometry endpoints and must be inserted exactly, not rounded to 20 m.
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railSourceChainagesM: [1000, 1400],
        railCivilRuns: [
            { startM: 1000, endM: 1125, regime: 'cut' },
            { startM: 1125, endM: 1275, regime: 'tunnel' },
            { startM: 1275, endM: 1400, regime: 'fill' },
        ],
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 30,
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const [run] = model.getTunnelRuns();
    assert.ok(run, 'published tunnel was lost');
    assert.ok(Math.abs(run.startStation - 125) < 1e-6, `start=${run.startStation}`);
    assert.ok(Math.abs(run.endStation - 275) < 1e-6, `end=${run.endStation}`);
    assert.ok(Math.abs(run.lengthM - 150) < 1e-6, `length=${run.lengthM}`);
    assert.equal(run.portalStartMouthIndex, 0);
    assert.equal(run.portalEndMouthIndex, run.samples.length - 1);
    const structures = model.alignments[0].segments.map(segment => segment.structure);
    assert.equal(structures[0], 'formation');
    assert.equal(structures.at(-1), 'formation');
    assert.ok(structures.includes('tunnel'));
    assert.equal(model.getSurfaceProfiles().length, 2, 'two neat approaches surround the bore');
});

test('opens the cross-cap where an open cut abuts a bored tunnel, not at the route end', () => {
    // Same deep-middle ridge: two open-cut approaches each meet the tunnel on
    // their inner end and the route end on their outer end. Only the
    // tunnel-facing cap must be dropped, or the tram drives into a grey slab at
    // the tunnel mouth (the reported bug); the route-end abutment must remain.
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const profiles = model.getSurfaceProfiles();
    assert.ok(profiles.length >= 2, `expected two open-cut approaches, got ${profiles.length}`);
    let profilesWithOpenCap = 0;
    for (const profile of profiles) {
        const suppressed = profile.internalSegments
            .map((flag, index) => (flag ? index : -1))
            .filter((index) => index >= 0);
        // Both builders skip suppressed segments, so their vertex counts drop by
        // exactly the opened cap. This is the contract that removes the slab.
        assert.equal(
            buildRetainingWallPositions(profile).length,
            (profile.points.length - suppressed.length) * 54,
        );
        assert.equal(
            buildFormationTerrainCollarPositions(profile).length,
            (profile.points.length - suppressed.length) * 18,
        );
        assert.ok(
            buildFormationSurfaceApronGeometryData(profile).positions.length > 0,
            'a tunnel-facing width flare must floor the aperture out to its retaining walls',
        );
        if (suppressed.length === 0) continue;
        profilesWithOpenCap += 1;
        // Only a short cross-cap is opened; the longitudinal retaining walls stay.
        assert.ok(suppressed.length < profile.points.length, 'longitudinal walls must remain');
        assert.ok(suppressed.length <= 4, `open cap should be one short edge, got ${suppressed.length}`);
        const innerX = profile.points.map((point) => point.innerX);
        const minX = Math.min(...innerX);
        const maxX = Math.max(...innerX);
        // The tunnel mouth is the run end nearest the ridge centre (x = 0); the
        // route end is the far extreme. The opened cap must sit at the mouth.
        const mouthX = Math.abs(minX) < Math.abs(maxX) ? minX : maxX;
        for (const index of suppressed) {
            assert.ok(
                Math.abs(profile.points[index].innerX - mouthX) < 3,
                `open cap must sit at the tunnel mouth (x≈${mouthX}), got ${profile.points[index].innerX}`,
            );
        }
    }
    assert.equal(profilesWithOpenCap, 2, 'both approaches open their tunnel-facing cap');
});

test('portal faces stay on the tunnel run exact endpoints', () => {
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const [run] = model.getTunnelRuns();
    assert.ok(run, 'expected a tunnel run');
    const startIndex = run.portalStartMouthIndex;
    const endIndex = run.portalEndMouthIndex;
    assert.ok(Number.isInteger(startIndex) && Number.isInteger(endIndex), 'portal faces set');
    assert.equal(startIndex, 0);
    assert.equal(endIndex, run.samples.length - 1);
    assert.equal(run.samples[startIndex].station, run.startStation);
    assert.equal(run.samples[endIndex].station, run.endStation);
});

test('open approaches overlap the tunnel mouth with a short bore-sized terrain aperture', () => {
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const [run] = model.getTunnelRuns();
    const openings = model.getTunnelPortalTerrainOpenings();
    assert.equal(openings.length, 2, 'both in-range open approaches own a portal aperture');
    for (const opening of openings) {
        assert.equal(opening.ring.length, 4);
        assert.ok(opening.bounds.minX <= opening.mouth.x
            && opening.bounds.maxX >= opening.mouth.x
            && opening.bounds.minZ <= opening.mouth.z
            && opening.bounds.maxZ >= opening.mouth.z,
        'the exact portal plane must lie inside the terrain aperture');
        assert.ok(opening.insideM < 2,
            'the aperture must not turn the bored tunnel roof into a long open trench');
        assert.ok(opening.boreHalfWidthM >= run.boreHalfWidthM - 1e-9);
    }

    const fullyBuried = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track([[0, 0, 0], [300, 0, 0]], {
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
            terrainFormation: 'authored-elevation',
        })],
        baseSceneYAtLocal: () => 30,
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    assert.equal(fullyBuried.getTunnelPortalTerrainOpenings().length, 0,
        'clipped tunnel route ends are not invented surface portals');
});

test('a tunnel portal opening suppresses a neighbouring rail formation end cap', () => {
    const opening = buildTunnelPortalTerrainOpening({
        mouth: { x: 0, z: 0 },
        interior: { x: -10, z: 0 },
        boreHalfWidthM: 5,
        insideM: 4.5,
    });
    const boundaryPoint = (innerZ, outerZ, x) => ({
        innerX: x,
        innerZ,
        roadY: 0,
        outerX: x,
        outerZ,
        terrainY: 5,
        wallTerrainY: 5.2,
        cutoutX: x,
        cutoutZ: outerZ,
        cutoutTerrainY: 5,
        overlapX: x,
        overlapZ: outerZ,
        overlapTerrainY: 5,
    });
    const profile = {
        points: [
            boundaryPoint(3, 6, 0),
            boundaryPoint(-3, -6, 0),
            boundaryPoint(-3, -6, 20),
            boundaryPoint(3, 6, 20),
        ],
        boundarySegmentTags: ['end', 'negative-normal', 'start', 'positive-normal'],
        internalSegments: [false, false, false, false],
        collarInternalSegments: [false, false, false, false],
    };

    assert.ok(opening, 'portal opening is valid');
    assert.equal(suppressRailFormationDressingAtTunnelPortals([profile], [opening]), 3,
        'the cap and the short adjoining wall pieces yield to the aperture');
    assert.deepEqual(profile.roadOpeningSegmentRanges[0], [[0, 1]],
        'the complete cross-cap inside the physical bore is removed');
    assert.deepEqual(profile.roadOpeningSegmentRanges[2], [],
        'the formation cap away from the portal remains');
});

test('the formation model clears an offset station-yard cap from a shared tunnel mouth', () => {
    const authority = track([[-100, 0, 0], [0, 0, 0], [100, 0, 0]], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railSourceChainagesM: [0, 100, 200],
        railCivilRuns: [
            { startM: 0, endM: 100, regime: 'tunnel' },
            { startM: 100, endM: 200, regime: 'fill' },
        ],
        railTunnelSections: [{
            sourceStartM: 0,
            sourceEndM: 100,
            physicalId: 'shared-bore',
            boreHalfWidthM: 5,
            portalTerrainOpeningInsideM: 4.5,
        }],
        railContextGroupId: 'station-mouth',
        railContextRole: 'solved-authority',
    });
    const siding = track([[80, 4, 0], [0, 4, 0]], {
        source: 'osm-solved-context',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'solved-context',
        railFormationParticipation: 'surface',
        railContextGroupId: 'neighbouring-yard',
        railContextRole: 'station-yard',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [authority, siding],
        baseSceneYAtLocal: () => 8,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 1,
        surfaceHalfWidthForFeature: () => 1,
    });
    const sidingProfile = model.alignmentByFeature.get(siding)?.profiles?.[0];
    const endCapIndex = sidingProfile?.boundarySegmentTags?.indexOf('end') ?? -1;
    const startCapIndex = sidingProfile?.boundarySegmentTags?.indexOf('start') ?? -1;

    assert.equal(model.getTunnelPortalTerrainOpenings().length, 1);
    assert.ok(endCapIndex >= 0 && startCapIndex >= 0, 'siding exposes both real endpoint caps');
    const [portalClip] = sidingProfile.roadOpeningSegmentRanges[endCapIndex];
    assert.ok(portalClip?.[0] === 0 && portalClip[1] > 0.5 && portalClip[1] < 1,
        'the laterally offset cap yields exactly where it crosses the portal aperture');
    assert.deepEqual(sidingProfile.roadOpeningSegmentRanges[startCapIndex], [],
        'the siding endpoint away from the tunnel remains closed');
});

test('the portal roof cap covers the complete inside aperture and never the open approach', () => {
    const footprint = buildTunnelPortalRoofCapFootprint({
        mouth: { x: 0, z: 0 },
        interior: { x: 10, z: 0 },
        boreHalfWidthM: 4.6,
        terrainOpeningInsideM: 4.5,
        physicalId: 'split-tunnel',
        side: 'start',
    });
    assert.ok(footprint);
    assert.ok(footprint.ring.every(point => point.x >= -1e-9),
        'the cap starts at the portal plane and never roofs the open approach');
    assert.ok(Math.abs(
        footprint.insideM - (4.5 + TUNNEL_PORTAL_ROOF_CAP_BURY_M)
    ) < 1e-9, 'the cap lands underneath kept terrain beyond the aperture');
    const halfWidth = 4.6
        + TUNNEL_PORTAL_TERRAIN_OPENING_MARGIN_M
        + TUNNEL_PORTAL_ROOF_CAP_LATERAL_OVERLAP_M;
    assert.ok(Math.abs(footprint.bounds.minZ + halfWidth) < 1e-9);
    assert.ok(Math.abs(footprint.bounds.maxZ - halfWidth) < 1e-9,
        'both cutout edges are buried beneath the civil roof cap');

    const retainedSideFootprint = buildTunnelPortalRoofCapFootprint({
        mouth: { x: 0, z: 0 },
        interior: { x: 10, z: 0 },
        boreHalfWidthM: 4.6,
        terrainOpeningInsideM: 4.5,
        negativeHalfWidthM: 10.6,
        positiveHalfWidthM: 6.2,
    });
    assert.ok(Math.abs(retainedSideFootprint.bounds.maxZ - 10.6) < 1e-9);
    assert.ok(Math.abs(retainedSideFootprint.bounds.minZ + 6.2) < 1e-9,
        'a reviewed asymmetric headwall has no uncovered side annulus');
});

test('tunnelRoofInfoAt keeps the bore roof intact through the exact portal boundary', () => {
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => 2,
    });
    const [run] = model.getTunnelRuns();
    assert.ok(run, 'expected a tunnel run');
    // The ridge centre is deep inside the bore: the hill above is REAL.
    const middle = model.tunnelRoofInfoAt(0, 0);
    assert.ok(middle, 'over the bore centre');
    assert.equal(middle.over, 'intact-roof');
    assert.ok(Math.abs(middle.floorY - 0) < 1.5, `tube floor ≈ rail: ${middle.floorY}`);
    // A point just inside the mapped endpoint is still bored tunnel, not an
    // invented 24 m open-cut mouth.
    const mouthSample = run.samples[1];
    const mouth = model.tunnelRoofInfoAt(mouthSample.x, mouthSample.z);
    assert.ok(mouth, 'over the mouth');
    assert.equal(mouth.over, 'intact-roof');
    // Far off the corridor laterally: no bore below.
    assert.equal(model.tunnelRoofInfoAt(0, 60), null);
    // Beyond the run along the route (open approach): no bore below.
    assert.equal(model.tunnelRoofInfoAt(190, 0), null);
});

test('railBoreHalfWidthM is the shared bore half-width (min floor + margin)', () => {
    assert.equal(railBoreHalfWidthM(2), 5.5);        // 2 + 3.5 margin
    assert.equal(railBoreHalfWidthM(1.15), 5.0);     // min floor wins over 4.65
    assert.equal(railBoreHalfWidthM(0), 5.0);
});

test('a declared double-track tunnel section is scoped to its source chainage', () => {
    const feature = track([[0, 0, 5], [300, 0, 5]], {
        railTunnelSections: [{
            sourceStartM: 100,
            sourceEndM: 220,
            physicalId: 'split-tunnel',
            trackCount: 2,
            trackSpacingM: 4.08,
            centerOffsetM: -2.04,
            boreHalfWidthM: 4.6,
            clearHeightM: 5.2,
            portalCrownM: 0.65,
            portalTerrainOpeningInsideM: 4.5,
        }],
    });
    const inside = railTunnelSectionForFeature(feature, 2.5, 120, 200);
    assert.equal(inside.physicalId, 'split-tunnel');
    assert.equal(inside.trackCount, 2);
    assert.equal(inside.centerOffsetM, -2.04);
    assert.equal(inside.halfWidthM, 4.6);
    assert.equal(inside.clearHeightM, 5.2);
    assert.equal(inside.portalTerrainOpeningInsideM, 4.5);
    const outside = railTunnelSectionForFeature(feature, 2.5, 0, 80);
    assert.equal(outside.physicalId, null);
    assert.equal(outside.trackCount, 1);
    assert.equal(outside.centerOffsetM, 0);
    assert.equal(outside.halfWidthM, railBoreHalfWidthM(2.5));
    assert.equal(outside.portalTerrainOpeningInsideM, null);
});

test('RailFormationModel centres one physical bore between the solved and companion tracks', () => {
    const feature = track([[0, 0, 5], [200, 0, 5]], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railSourceChainagesM: [1000, 1200],
        railCivilRuns: [{ startM: 1000, endM: 1200, regime: 'tunnel' }],
        railTunnelSections: [{
            sourceStartM: 1000,
            sourceEndM: 1200,
            physicalId: 'split-tunnel',
            trackCount: 2,
            trackSpacingM: 4,
            centerOffsetM: -2,
            boreHalfWidthM: 4.6,
            clearHeightM: 5.2,
            portalCrownM: 0.65,
            portalTerrainOpeningInsideM: 4.5,
        }],
        railFormationSections: [{
            sourceStartM: 1000,
            sourceEndM: 1050,
            style: 'vertical-retained',
            negativeNormalRetainedBenchM: 6,
        }],
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 25,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2.5,
    });
    const [run] = model.getTunnelRuns();
    assert.ok(run);
    assert.equal(run.tunnelPhysicalId, 'split-tunnel');
    assert.equal(run.tunnelTrackCount, 2);
    assert.equal(run.boreHalfWidthM, 4.6);
    assert.equal(run.tunnelClearHeightM, 5.2);
    assert.equal(run.tunnelPortalTerrainOpeningInsideM, 4.5);
    assert.ok(run.boreSamples.every(sample => Math.abs(sample.z - 2) < 1e-6),
        'the civil axis shifts two metres toward the companion while rail samples stay put');
    assert.ok(run.samples.every(sample => Math.abs(sample.z) < 1e-6));
    const roof = model.tunnelRoofInfoAt(100, 2);
    assert.equal(roof?.over, 'intact-roof');
    assert.equal(roof?.clearHeightM, 5.2);
    assert.ok(Math.abs(
        roof.ceilingY - roof.railY - RENDERED_TUNNEL_BED_ABOVE_RAIL_M - 5.2
    ) < 1e-9, 'building supports and the renderer share the physical ceiling datum');
    assert.deepEqual(run.portalStartRetainedBenchM, {
        negativeNormalM: 6,
        positiveNormalM: 0,
    });
    assert.deepEqual(run.portalEndRetainedBenchM, {
        negativeNormalM: 0,
        positiveNormalM: 0,
    }, 'an approach-side portal extension never leaks to the remote mouth');
});

test('duplicate portal mouths collapse only for the same physical tunnel', () => {
    const mouths = dedupeRailTunnelPortalMouths([
        { x: 0, z: 0, physicalId: 'split-tunnel', id: 'first' },
        { x: 0.8, z: 0.2, physicalId: 'split-tunnel', id: 'duplicate fragment' },
        { x: 0.8, z: 0.2, physicalId: 'parallel-bore', id: 'separate bore' },
        { x: 100, z: 0, physicalId: 'split-tunnel', id: 'other end' },
    ]);
    assert.deepEqual(mouths.map(mouth => mouth.id), [
        'first',
        'separate bore',
        'other end',
    ]);
});

test('flares the open cut out to the bore half-width at a tunnel mouth, normal width at the far end', () => {
    // Deep ridge: each open-cut approach abuts the bore on its inner end (the
    // mouth) and the route end on its outer end. The cut retaining wall must
    // widen to the bore half-width at the mouth so it meets the stone tunnel wall
    // flush, while staying at the normal cut width at the route end.
    const halfWidth = 2;
    const boreHalf = railBoreHalfWidthM(halfWidth); // 5.5
    const feature = track([[-200, 0, 0], [200, 0, 0]], {
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'authored-elevation',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: (x) => Math.max(0, 40 - Math.abs(x) * 0.2),
        absoluteSceneYAtHeight: (heightM) => heightM,
        halfWidthForFeature: () => halfWidth,
    });
    const profiles = model.getSurfaceProfiles();
    assert.ok(profiles.length >= 2, `expected two open-cut approaches, got ${profiles.length}`);
    for (const profile of profiles) {
        // Track runs along x at z=0, so a point's perpendicular half-offset is |innerZ|.
        const innerX = profile.points.map((point) => point.innerX);
        const minX = Math.min(...innerX);
        const maxX = Math.max(...innerX);
        const mouthX = Math.abs(minX) < Math.abs(maxX) ? minX : maxX; // extreme nearest the ridge
        const farX = mouthX === minX ? maxX : minX;
        const halfOffsetNear = (targetX) => Math.max(...profile.points
            .filter((point) => Math.abs(point.innerX - targetX) < 6)
            .map((point) => Math.abs(point.innerZ)));
        assert.ok(
            Math.abs(halfOffsetNear(mouthX) - boreHalf) < 0.4,
            `cut must flare to the bore half-width (${boreHalf}) at the mouth, got ${halfOffsetNear(mouthX)}`,
        );
        assert.ok(
            Math.abs(halfOffsetNear(farX) - halfWidth) < 0.4,
            `cut must keep its normal width (${halfWidth}) at the route end, got ${halfOffsetNear(farX)}`,
        );
        const apronWidthNear = (targetX) => Math.max(...profile.points
            .filter((point) => Math.abs(point.innerX - targetX) < 6)
            .map((point) => point.surfaceApronWidthM || 0));
        assert.ok(
            Math.abs(apronWidthNear(mouthX) - (boreHalf - halfWidth)) < 0.4,
            'the portal floor must share the widened wall cross-section',
        );
        const farApronWidth = Math.max(...profile.points
            .filter((point) => Math.abs(point.innerX - farX) < 0.5)
            .map((point) => point.surfaceApronWidthM || 0));
        assert.ok(
            farApronWidth < 1e-9,
            'ordinary track away from the mouth must not acquire a synthetic apron',
        );
    }
});

// ── Reconstructions of existing railways ──────────────────────────────────────
// A reconstruction's rail is solved and grade-capped (smooth); the ground under
// it is a 20 m DGU grid sampled every half metre. The difference ripples across
// the ±3.5 m / −8 m civil rules many times per kilometre, which turned
// Gračac–Knin into 31 tunnels and 72 viaducts in 59 km — a cab ride popping
// between bore, deck and open ground. Classification therefore low-passes the
// terrain to the grid's own resolution and asks for a longer run, but ONLY for
// reconstructions.

test('a reconstruction is distinguished from an authored alignment', () => {
    // The reference layer's spans and the planner's cab track for a fixed
    // project are reconstructions...
    assert.equal(isReconstructedRailFeature({ properties: { source: 'reference-project' } }), true);
    assert.equal(
        isReconstructedRailFeature({ properties: { alignmentSource: 'reference-project' } }),
        true,
    );
    // ...while a proposal and an ordinary planner ride in absolute mode are NOT,
    // even though both are engineered. Their short structures are deliberate,
    // and the planner already refuses spans under 50 m.
    assert.equal(isReconstructedRailFeature({ properties: { source: 'cb-proposal' } }), false);
    assert.equal(
        isReconstructedRailFeature({
            properties: { source: 'user-line', elevationMode: 'absolute', elevationDatum: 'EVRF2000' },
        }),
        false,
    );
    assert.equal(isReconstructedRailFeature(null), false);
});

test('smoothing flattens a one-sample terrain spike but keeps a real structure', () => {
    // 5 m segments: a single deep sample surrounded by ground-level track is
    // grid noise; a sustained run is a real crossing.
    const spike = [
        { length: 5, maxCoverM: 0, maxFillM: 0 },
        { length: 5, maxCoverM: 0, maxFillM: 0 },
        { length: 5, maxCoverM: 12, maxFillM: 0 },   // <- the ripple
        { length: 5, maxCoverM: 0, maxFillM: 0 },
        { length: 5, maxCoverM: 0, maxFillM: 0 },
    ];
    const smoothedSpike = smoothedSegmentExtremes(spike, RECONSTRUCTION_TERRAIN_SMOOTHING_M);
    assert.ok(
        smoothedSpike[2].maxCoverM < 8,
        `a lone 12 m sample must not survive as tunnel cover, got ${smoothedSpike[2].maxCoverM}`,
    );

    const sustained = Array.from({ length: 40 }, () => ({ length: 5, maxCoverM: 12, maxFillM: 0 }));
    const smoothedSustained = smoothedSegmentExtremes(sustained, RECONSTRUCTION_TERRAIN_SMOOTHING_M);
    assert.ok(
        smoothedSustained[20].maxCoverM > 11.9,
        '200 m of consistent 12 m cover is a tunnel and must stay one',
    );

    // The originals are untouched: the portal headwall and the deck still have
    // to be built to the ground that is actually there.
    assert.equal(spike[2].maxCoverM, 12);
});

test('a reconstruction needs a longer run before it earns a structure', () => {
    // 60 m of fill: a viaduct for an authored alignment, terrain ripple for a
    // 400 km reconstruction.
    const segments = [
        { length: 200, maxFillM: 0 },
        { length: 60, maxFillM: 6 },
        { length: 200, maxFillM: 0 },
    ];
    assert.deepEqual(classifyViaductSegments(segments), [false, true, false]);
    assert.deepEqual(
        classifyViaductSegments(segments, { minRunM: RECONSTRUCTION_STRUCTURE_MIN_RUN_M }),
        [false, false, false],
    );

    // A genuine long structure survives either way.
    const long = [
        { length: 200, maxFillM: 0 },
        { length: 400, maxFillM: 6 },
        { length: 200, maxFillM: 0 },
    ];
    assert.deepEqual(
        classifyViaductSegments(long, { minRunM: RECONSTRUCTION_STRUCTURE_MIN_RUN_M }),
        [false, true, false],
    );
});

// The reported/gazed grade must span a baseline the elevation data supports, and
// must be continuous. It used to be the SEGMENT grade — dy over one densified
// step — and densifyLocalLine only subdivides, so a source polyline with nodes
// closer than sampleStepM kept its short segments. On a reconstruction that is
// around 8 m, where centimetre-quantised heights are a couple of per mille of
// pure quantisation, and being per-segment the value STEPPED at every vertex:
// the cab readout flicked between -1% and 0% inside ten metres and the gaze
// pitch bobbed with it, about twice a second at line speed.
test('the reported grade is continuous and immune to per-node elevation noise', () => {
    // A dead-level track whose nodes are 8 m apart — the reconstruction spacing.
    // Its true height is 120.005 m, so rounding to the centimetre — all the data
    // carries — lands alternately on 120.00 and 120.01. That 1 cm over 8 m is
    // 1.25 permille of pure quantisation per segment, which is exactly what the
    // old per-segment grade reported as a real gradient.
    const points = [];
    let index = 0;
    for (let x = -400; x <= 400; x += 8) {
        points.push([x, 0, index++ % 2 === 0 ? 120.00 : 120.01]);
    }
    const feature = track(points, { elevationMode: 'absolute', elevationDatum: 'EVRF2000' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
    });

    const grades = [];
    for (let x = -300; x <= 300; x += 2) {
        const formation = model.formationAtLocal(x, 0);
        if (!formation) continue;
        const grade = model.gradeAlongHeadingForFormation(formation, 90);
        assert.ok(Number.isFinite(grade), `no grade at x=${x}`);
        grades.push(grade);
    }
    assert.ok(grades.length > 100, `only sampled ${grades.length} points`);

    // Level track must read level, not per-mille quantisation noise.
    for (const grade of grades) {
        assert.ok(Math.abs(grade) < 0.0005,
            `level track reported a grade of ${(grade * 1000).toFixed(2)} permille`);
    }

    // And it must not jump between neighbouring positions: the old step function
    // changed by the full segment-to-segment difference at each vertex.
    for (let i = 1; i < grades.length; i++) {
        assert.ok(Math.abs(grades[i] - grades[i - 1]) < 0.0005,
            `grade jumped ${((grades[i] - grades[i - 1]) * 1000).toFixed(2)} permille between samples`);
    }
});

test('a real gradient is still reported at its true value', () => {
    // 10 permille climb, again on 8 m nodes with centimetre rounding.
    const points = [];
    for (let x = -400; x <= 400; x += 8) {
        // Centimetre rounding again, so the per-segment value alternates around
        // the true 10 permille while the chord reads it straight.
        points.push([x, 0, Math.round((120 + (x + 400) * 0.010) * 100) / 100]);
    }
    const feature = track(points, { elevationMode: 'absolute', elevationDatum: 'EVRF2000' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
    });
    const formation = model.formationAtLocal(0, 0);
    assert.ok(formation, 'expected a formation at mid-track');
    // Heading 90 runs +x here, so the climb reads positive; the reverse heading
    // reports the same magnitude with the opposite sign.
    const forward = model.gradeAlongHeadingForFormation(formation, 90);
    const backward = model.gradeAlongHeadingForFormation(formation, 270);
    assert.ok(Math.abs(Math.abs(forward) - 0.010) < 0.0015,
        `expected about 10 permille, got ${(forward * 1000).toFixed(2)}`);
    assert.ok(Math.abs(forward + backward) < 1e-9, 'reversing heading must flip the sign');
});

// ── Missing terrain must stay missing ──────────────────────────────────────
// Traced 2026-07-27 from a floating viaduct across Split (project 64,
// ?elevation=1). `_baseY` substituted 0 for an unsampled point, so
// `maxFillM = railY - 0` reported the rail's whole height above sea level as
// fill. Split sits ~30 m ASL and DEFAULT_VIADUCT_FILL_THRESHOLD_M is 3.5, so
// every sample over a hole in the DEM classified as viaduct, and bridgeGapM
// welded them into one continuous deck on pillars. Because the fill is a
// Math.max, an absent sample could only ever push TOWARD a structure.

// Ground at 30 m everywhere, except a 60 m stretch the terrain source cannot
// answer for. Nothing here is elevated, so nothing may be built on pillars.
function splitLikeModel({ holeFromX = 200, holeToX = 260, groundM = 30 } = {}) {
    return new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track([[0, 0], [600, 0]])],
        baseSceneYAtLocal: x => (x >= holeFromX && x <= holeToX ? null : groundM),
        halfWidthForFeature: () => 2,
    });
}

test('a hole in the terrain does not grow a viaduct out of nothing', () => {
    const model = splitLikeModel();
    const runs = model.getViaductRuns();
    assert.deepEqual(runs, [],
        `flat ground at 30 m with an unsampled gap must build no viaduct, got ${runs.length}`
        + ` spanning ${runs.map(r => r.lengthM.toFixed(0)).join('+')} m`);
    // And the rail itself stays on the ground across the gap rather than
    // sagging to the datum and climbing back out.
    for (const x of [180, 210, 230, 250, 280]) {
        const formation = model.formationAtLocal(x, 0);
        assert.ok(Math.abs(formation.railY - 30) < 1.5,
            `rail at x=${x} should hold ~30 m, got ${formation.railY.toFixed(2)}`);
    }
});

test('a real fill of the same size still builds a viaduct', () => {
    // The mirror of the test above: identical geometry, but the ground genuinely
    // falls away to 0 instead of being unknown. If the fix suppressed viaducts
    // generally rather than only unmeasured ones, this goes red.
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track([[0, 0], [600, 0]])],
        baseSceneYAtLocal: x => (x >= 200 && x <= 380 ? 0 : 30),
        halfWidthForFeature: () => 2,
    });
    const runs = model.getViaductRuns();
    assert.ok(runs.length >= 1, 'a genuine ravine must still be spanned');
    assert.ok(runs.some(run => run.lengthM >= 30),
        `expected a run of real length, got ${runs.map(r => r.lengthM.toFixed(0)).join('+')}`);
});

test('a short OSM bridge keeps the approach level over a missing DGU deck', () => {
    const feature = track([[-10, 0], [10, 0]], {
        source: 'osm',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
        railStructure: 'viaduct',
        railMode: 'train',
    });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        // The bridge itself is absent from the DGU surface (road at 0 m), while
        // both rail approaches sit on the 5 m embankment.
        baseSceneYAtLocal: x => (Math.abs(x) <= 15 ? 0 : 5),
        halfWidthForFeature: () => 2,
    });
    const middle = model.formationAtLocal(0, 0);
    assert.ok(middle);
    assert.ok(middle.railY > 4, `bridge collapsed to ${middle.railY.toFixed(2)} m`);
    assert.equal(model.getViaductRuns().length, 1);
    assert.ok(model.getViaductRuns()[0].lengthM < 30,
        'explicit OSM bridge must bypass the generic 30 m inferred-structure minimum');
});

test('OSM bridge endpoints own the shared level of adjoining embankment ways', () => {
    const osmProperties = {
        source: 'osm',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'osm-inferred',
        railMode: 'train',
    };
    const west = track([[-300, 0], [0, 0]], { ...osmProperties, osmId: 'west' });
    const bridge = track([[0, 0], [20, 0]], {
        ...osmProperties,
        osmId: 'bridge',
        railStructure: 'viaduct',
    });
    const east = track([[20, 0], [320, 0]], { ...osmProperties, osmId: 'east' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [west, bridge, east],
        // DGU contains the six-metre embankment but not the short bridge deck.
        baseSceneYAtLocal: x => (x > -5 && x < 25 ? 0 : 6),
        halfWidthForFeature: () => 2,
    });
    const byId = Object.fromEntries(model.alignments.map(alignment => [
        alignment.feature.properties.osmId,
        alignment,
    ]));

    assert.ok(byId.bridge.samples.every(sample => sample.railY > 5),
        'the mapped bridge spans from the embankment level, not the road below');
    assert.ok(Math.abs(byId.west.samples.at(-1).railY - byId.bridge.samples[0].railY) < 1e-9,
        'west rail meets the bridge without a vertical seam');
    assert.ok(Math.abs(byId.east.samples[0].railY - byId.bridge.samples.at(-1).railY) < 1e-9,
        'east rail meets the bridge without a vertical seam');
    assert.ok(byId.west.samples.at(-2).railY > 4.5,
        'the approach remains on its embankment instead of ramping down at the bridge edge');
    assert.ok(byId.east.samples[1].railY > 4.5);
});

test('unknown is contagious across a segment, not averaged away', () => {
    assert.equal(knownExtreme(4, 9), 9);
    assert.equal(knownExtreme(null, 9), null, 'one unknown end makes the segment unknown');
    assert.equal(knownExtreme(9, undefined), null);
    assert.equal(knownExtreme(null, null), null);
});

test('a segment with unknown fill is not a viaduct, and unknown cover is not a tunnel', () => {
    // Number(null) is 0, so before the explicit guard this answered correctly
    // only by arithmetic accident — and the next edit could have undone it
    // without any test noticing.
    const flags = classifyViaductSegments([
        { length: 100, maxFillM: null },
        { length: 100, maxFillM: undefined },
        { length: 100, maxFillM: 40 },
    ]);
    assert.deepEqual(flags.slice(0, 2), [false, false]);
    assert.equal(flags[2], true, 'a measured 40 m fill is still a viaduct');
    const tunnelFlags = classifyTunnelSegments([
        { length: 100, maxCoverM: null },
        { length: 100, maxCoverM: 40 },
    ]);
    assert.deepEqual(tunnelFlags, [false, true]);
});

test('smoothing excludes unknown segments instead of counting them as zero metres', () => {
    // Averaging a hole in as 0 drags a genuine viaduct below the threshold — the
    // mirror failure of inventing one. Three 40 m fills with an unknown between
    // them must still read as ~40, not be diluted toward 0.
    const smoothed = smoothedSegmentExtremes([
        { length: 10, maxFillM: 40 },
        { length: 10, maxFillM: null },
        { length: 10, maxFillM: 40 },
    ], 100);
    for (const segment of smoothed) {
        assert.ok(Math.abs(segment.maxFillM - 40) < 1e-9,
            `expected ~40, got ${segment.maxFillM}`);
    }
    // Nothing known in the window stays unknown rather than becoming 0.
    const blank = smoothedSegmentExtremes([{ length: 10, maxFillM: null }], 100);
    assert.equal(blank[0].maxFillM, null);
});

test('terrain gaps are bridged from the ground either side, and total absence is refused', () => {
    const filled = interpolateUnknownTerrain([
        { station: 0, terrainY: 10 },
        { station: 10, terrainY: null },
        { station: 20, terrainY: 30 },
    ]);
    assert.equal(filled[1].terrainY, 20, 'interpolated along station, not dropped to 0');
    // Beyond the known span, hold the nearest measurement rather than
    // extrapolating a trend off the end of the data.
    const held = interpolateUnknownTerrain([
        { station: 0, terrainY: null },
        { station: 10, terrainY: 25 },
        { station: 20, terrainY: null },
    ]);
    assert.equal(held[0].terrainY, 25);
    assert.equal(held[2].terrainY, 25);
    assert.equal(interpolateUnknownTerrain([{ station: 0, terrainY: null }]), null,
        'no ground anywhere cannot be designed');
    assert.equal(designRailVerticalProfile([
        { station: 0, terrainY: null }, { station: 50, terrainY: null },
    ]), null, 'and the profile designer refuses it rather than laying track at the datum');
});

test('a visual-only companion rail reuses one solved tunnel instead of building a second bore', () => {
    const solvedTunnel = track([[0, 0, 5], [120, 0, 5]], {
        source: 'reference-project',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railStructure: 'tunnel',
        railContextGroupId: 'split-station',
        railContextRole: 'solved-authority',
    });
    const companion = track([[0, 4, 5], [120, 4, 5]], {
        source: 'osm-solved-context',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        railStructure: 'tunnel',
        railProfileSource: 'solved-context',
        railFormationParticipation: 'visual-only',
        railContextGroupId: 'split-station',
        railContextRole: 'tunnel-companion',
    });
    assert.equal(isEngineeredRailFeature(companion), false);
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [solvedTunnel, companion],
        baseSceneYAtLocal: () => 25,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2.5,
    });
    assert.equal(model.alignments.length, 1, 'the companion owns no second civil alignment');
    assert.equal(model.getTunnelRuns().length, 1, 'the physical double-track bore has one shell');
    assert.equal(model.alignmentByFeature.has(companion), false);
});

test('parallel solved-context yard tracks form one ordinary level formation', () => {
    const contextProperties = {
        source: 'osm-solved-context',
        elevationMode: 'absolute',
        elevationDatum: 'EVRF2000',
        terrainFormation: 'smooth-grade',
        railProfileSource: 'solved-context',
        railFormationParticipation: 'surface',
        railContextGroupId: 'split-station',
        railContextRole: 'station-yard',
        // Even misleading structure evidence must not turn an individual
        // station siding into a separate tunnel.
        railStructure: 'tunnel',
    };
    const left = track([[0, 0, 5], [120, 0, 5]], contextProperties);
    const right = track([[0, 4, 5], [120, 4, 5]], contextProperties);
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [left, right],
        baseSceneYAtLocal: () => 25,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 3.2675,
    });
    assert.equal(model.getTunnelRuns().length, 0);
    assert.equal(model.getViaductRuns().length, 0);
    const profiles = model.getSurfaceProfiles();
    assert.equal(profiles.length, 2);
    assert.ok(profiles.every(profile => profile.railContextApron === true));
    assert.ok(profiles.every(profile => profile.internalSegments.some(Boolean)),
        'overlapping inner yard boundaries should be hidden');
    assert.ok(profiles.every(profile => profile.internalSegments.some(value => !value)),
        'the shared yard must retain its exterior perimeter');
});

test('a self-crossing loop resolves each pass by STATION, not plan-nearest', () => {
    // A "P"-shaped route whose tail crosses its own first leg at local (0, 0):
    // pass 1 reaches the point at station 200, pass 2 at station 900. Authored
    // absolute elevations climb linearly, so the two passes sit ~14 m apart —
    // exactly the spiral case where the plan-nearest lookup is ambiguous and
    // seated deck chords on the wrong pass (the vertical-curtain bug).
    const points = [[-200, 0, 96], [200, 0, 104], [200, -150, 107], [0, -150, 111], [0, 150, 117]];
    const feature = track(points, { elevationMode: 'absolute', elevationDatum: 'EVRF2000' });
    const model = new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [feature],
        baseSceneYAtLocal: () => 0,
        absoluteSceneYAtHeight: (heightM) => heightM - 100,
        halfWidthForFeature: () => 2,
    });
    const lower = model.formationAtFeatureStation(feature, 200);
    const upper = model.formationAtFeatureStation(feature, 900);
    assert.ok(lower && upper, 'both passes must resolve');
    // Linear profile: station 200 → 100 asl → sceneY 0; station 900 → 114 asl.
    assert.ok(Math.abs(lower.railY - 0) < 0.6, `lower pass railY ${lower.railY}`);
    assert.ok(Math.abs(upper.railY - 14) < 0.6, `upper pass railY ${upper.railY}`);
    assert.ok(upper.railY - lower.railY > 10, 'passes must not collapse to one level');
    // The plan-nearest query at the shared point answers with ONE pass — both
    // probes collapse to the same railY, which is exactly why deck chords must
    // never be resolved that way on a loop.
    const planA = model.formationAtLocal(0, 0.05, { feature, maxDistanceM: Infinity });
    const planB = model.formationAtLocal(0, -0.05, { feature, maxDistanceM: Infinity });
    assert.ok(planA && planB);
    assert.ok(Math.abs(planA.railY - planB.railY) < 1.5,
        'plan-nearest is expected to collapse the crossing to one pass');
    // Out-of-range stations clamp to the route ends; unknown features are null.
    assert.ok(Math.abs(model.formationAtFeatureStation(feature, 1e9).railY - 17) < 0.6);
    assert.equal(model.formationAtFeatureStation({ properties: {} }, 100), null);
});

test('a knoll dip between tall viaduct spans bridges at the planner gap width', () => {
    // 200 m viaduct, 100 m knoll dip under the fill threshold, 200 m viaduct.
    const segments = [];
    const pushRun = (lengthM, fillM) => {
        for (let step = 0; step < lengthM; step += 20) segments.push({ length: 20, maxFillM: fillM });
    };
    pushRun(200, 20); pushRun(100, 2); pushRun(200, 20);
    const defaults = classifyViaductSegments(segments);
    assert.ok(defaults.some((flag) => !flag), '100 m gap must survive the 40 m default');
    const planner = classifyViaductSegments(segments, { bridgeGapM: 160 });
    assert.ok(planner.every(Boolean), 'planner gap width must bridge the knoll');
});
