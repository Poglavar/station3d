// A surface station in an open cut owns a real excavation, platform floor and
// route to grade. None of those may diverge or the crowd ends up inside soil.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { captureStationGroundOpeningsSteps } from '../core/station-ground-openings.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { SURFACE_CLASS, SURFACE_VERTICAL_RELATION, SURFACE_COVERAGE_STATE } from '../core/surface-hierarchy.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import {
    RailFormationModel,
    railSurfaceAccessRetainingOpenings,
} from '../core/rail-formation.js';
import {
    buildFormationTerrainCollarGeometryData,
    buildRetainingWallPositions,
    visibleFormationBoundaryPieces,
} from '../core/road-formation.js';
import {
    buildPlannerSurfaceCutStationAccessPlans,
    plannerSurfaceCutStationFloorBox,
    plannerSurfaceCutStationEntranceCutouts,
    plannerSurfaceCutStationSurfaceAtLocal,
    plannerSurfaceCutStationSurfaceSupportedByTerrain,
    SURFACE_CUT_STAIR_TARGET_RISER_M,
} from '../world/planner-station-layout.js';
import { getTrackbedHalfWidthMeters } from '../world/tram-trackbed-dimensions.js';

const ANCHOR_LAT = 43.7324;
const ANCHOR_LON = 15.8950;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);

function lonLat(x, z) {
    return [ANCHOR_LON + x / M_PER_LON, ANCHOR_LAT - z / M_PER_LAT];
}

function feature() {
    return {
        type: 'Feature',
        properties: {
            source: 'user',
            trackId: 'track-1',
            trackType: 'g1435',
            trackCount: 2,
            trackArrangement: 'together',
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
        },
        geometry: {
            type: 'LineString',
            coordinates: [
                [...lonLat(-250, 0), 0],
                [...lonLat(250, 0), 0],
            ],
        },
    };
}

function stop(structureKind = 'cut') {
    const [lng, lat] = lonLat(0, 0);
    return {
        stopId: 'stankovacka',
        trackId: 'track-1',
        lat,
        lng,
        elevM: 0,
        level: 0,
        structureKind,
        name: 'Stankovačka ulica',
    };
}

function modelFor({ groundY = 7.18, station = stop() } = {}) {
    const track = feature();
    const stops = [station];
    const baseSceneYAtLocal = typeof groundY === 'function' ? groundY : () => groundY;
    return new RailFormationModel({
        anchorLat: ANCHOR_LAT,
        anchorLon: ANCHOR_LON,
        features: [track],
        baseSceneYAtLocal,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: item => getTrackbedHalfWidthMeters(item.properties),
        stationAccessPlanner: ({ alignment, anchorLat, anchorLon, baseSceneYAtLocal: sampleGround }) => (
            buildPlannerSurfaceCutStationAccessPlans({
                stops,
                alignment,
                anchorLat,
                anchorLon,
                baseSceneYAtLocal: sampleGround,
            })
        ),
    });
}

test('opens an asymmetric retained bay and a stair well for a Stankovačka-depth cut', () => {
    const model = modelFor();
    const [plan] = model.getSurfaceStationAccessPlans();
    assert.ok(plan, 'the cut station must own an access plan');
    assert.ok(Math.abs(plan.depthM - 7.18) < 0.01);
    assert.equal(plan.stair.stepCount, 43, 'the real 7.18 m rise needs 43 ordinary risers');
    assert.ok(
        plan.depthM / plan.stair.stepCount <= SURFACE_CUT_STAIR_TARGET_RISER_M + 1e-9,
        'the stair riser stays at or below the 17 cm target',
    );

    const [profile] = model.getSurfaceProfiles();
    assert.ok(profile, 'open formation keeps its terrain carve and retaining wall profile');
    const baselineProfile = modelFor({ station: stop('surface') }).getSurfaceProfiles()[0];
    assert.ok(
        profile.points.length <= baselineProfile.points.length + 96,
        `the local bay must not globally resample the railway (${baselineProfile.points.length} -> ${profile.points.length})`,
    );
    assert.equal(
        model.getSurfaceProfiles().length,
        1,
        'the widened bay remains in the existing combined wall/collar profile',
    );
    const centreBoundary = profile.points.filter(point => Math.abs(point.innerX) < 0.15);
    const platformRight = Math.max(...centreBoundary.map(point => point.innerZ));
    const terrainToeRight = Math.max(...centreBoundary.map(point => point.outerZ));
    const terrainCutoutRight = Math.max(...centreBoundary.map(point => point.cutoutZ));
    const terrainOverlapRight = Math.max(...centreBoundary.map(point => point.overlapZ));
    const oppositeSide = Math.min(...centreBoundary.map(point => point.innerZ));
    const platformCarveRight = plan.sections
        .find(section => section.kind === 'platform-bay').rightHalfWidthM;
    assert.ok(
        Math.abs(platformRight - platformCarveRight) < 0.15,
        'the level station bay widens only far enough to clear the platform',
    );
    assert.ok(
        terrainToeRight >= plan.stair.landingEndRightM - 0.4,
        'the retaining face reaches the outer landing edge instead of roofing the upper stairs',
    );
    assert.ok(
        terrainCutoutRight >= plan.stair.landingEndRightM,
        'the terrain mask leaves an open portal above the complete stair and landing',
    );
    assert.ok(
        plan.stair.portalEndRightM > terrainCutoutRight,
        'the concrete portal apron runs under the kept-ground seam instead of ending over a void',
    );
    assert.ok(
        terrainOverlapRight >= plan.stair.landingEndRightM - 0.4,
        'the top landing reaches the terrain collar/kept ground',
    );
    assert.ok(
        Math.abs(oppositeSide + getTrackbedHalfWidthMeters(feature().properties)) < 0.15,
        'only the platform side widens; the opposite cut wall stays on the running formation',
    );

    const floor = plannerSurfaceCutStationFloorBox(plan);
    const platformBay = plan.sections.find(section => section.kind === 'platform-bay');
    assert.ok(floor, 'the visible station excavation owns a concrete floor');
    assert.ok(
        floor.innerRightM < plan.formationHalfWidthM,
        'the floor tucks under the ordinary trackbed instead of leaving an inner seam',
    );
    assert.ok(
        floor.outerRightM > platformBay.rightHalfWidthM,
        'the floor tucks under the retained face instead of leaving an outer seam',
    );
    assert.ok(
        floor.halfAlongM > platformBay.plateauHalfM + platformBay.taperM,
        'the floor continues under both tapered bay ends, where kept terrain hides it',
    );

    const platform = plannerSurfaceCutStationSurfaceAtLocal(
        plan,
        plan.centerX + plan.rightX * plan.platformSideM,
        plan.centerZ + plan.rightZ * plan.platformSideM,
    );
    assert.equal(platform?.kind, 'platform');
    assert.ok(Math.abs(platform.floorY - 0.06) < 1e-9);
    assert.equal(
        plannerSurfaceCutStationSurfaceSupportedByTerrain(platform, platform.floorY - 0.1),
        true,
        'a tread may sit one small riser above the smooth raw slope',
    );
    assert.equal(
        plannerSurfaceCutStationSurfaceSupportedByTerrain(platform, platform.floorY - 1),
        false,
        'a stale station floor suspended above new terrain is not walkable support',
    );

    const stairMiddleRight = (plan.stair.startRightM + plan.stair.endRightM) * 0.5;
    const stairs = plannerSurfaceCutStationSurfaceAtLocal(
        plan,
        plan.centerX + plan.rightX * stairMiddleRight,
        plan.centerZ + plan.rightZ * stairMiddleRight,
    );
    assert.equal(stairs?.kind, 'stairs');
    assert.ok(stairs.floorY > plan.railY && stairs.floorY < plan.groundY);

    const landingRight = (plan.stair.endRightM + plan.stair.landingEndRightM) * 0.5;
    const landing = plannerSurfaceCutStationSurfaceAtLocal(
        plan,
        plan.centerX + plan.rightX * landingRight,
        plan.centerZ + plan.rightZ * landingRight,
    );
    assert.equal(landing?.kind, 'landing');
    assert.ok(Math.abs(landing.floorY - (plan.groundY + 0.03)) < 1e-9);

    const portalApronRight = (
        plan.stair.landingEndRightM + plan.stair.portalEndRightM
    ) * 0.5;
    const portalApron = plannerSurfaceCutStationSurfaceAtLocal(
        plan,
        plan.centerX + plan.rightX * portalApronRight,
        plan.centerZ + plan.rightZ * portalApronRight,
    );
    assert.equal(portalApron?.kind, 'landing');

    const [opening] = railSurfaceAccessRetainingOpenings([plan]);
    assert.ok(opening, 'the stair owns an explicit opening through the retained face');
    assert.equal(opening.source, 'surface-cut-station-stairs');
    const [entranceCut] = plannerSurfaceCutStationEntranceCutouts(model);
    assert.equal(entranceCut?.stationEntranceKind, 'surface-cut-stairs');
    const entranceRadiusM = entranceCut.widthM * 0.5;
    const entranceStartRightM = (
        (entranceCut.x1 - plan.centerX) * plan.rightX
        + (entranceCut.z1 - plan.centerZ) * plan.rightZ
        - entranceRadiusM
    );
    const entranceEndRightM = (
        (entranceCut.x2 - plan.centerX) * plan.rightX
        + (entranceCut.z2 - plan.centerZ) * plan.rightZ
        + entranceRadiusM
    );
    assert.ok(
        Math.abs(entranceStartRightM - plan.stair.startRightM) < 1e-9,
        'the analytic surface hole starts exactly over the first supported tread',
    );
    assert.ok(
        Math.abs(entranceEndRightM - plan.stair.portalEndRightM) < 1e-9,
        'the analytic surface hole ends exactly over the concrete portal apron',
    );
    const openedSegments = profile.roadOpeningSegmentRanges
        .map((ranges, index) => ({ ranges, index }))
        .filter(item => item.ranges.length > 0);
    assert.ok(openedSegments.length > 0, 'wall/collar geometry is clipped across the stair mouth');
    assert.ok(openedSegments.some(({ index }) => (
        visibleFormationBoundaryPieces(
            profile,
            index,
            profile.points[index],
            profile.points[(index + 1) % profile.points.length],
        ).length >= 1
    )), 'the opening clips only its exact width instead of deleting the whole retaining segment');
    assert.ok(buildRetainingWallPositions(profile).length > 0);
    assert.ok(buildFormationTerrainCollarGeometryData(profile).positions.length > 0);

    const unsupportedAlongM = plan.stair.widthM * 0.5 + 0.15;
    const unsupportedX = plan.centerX
        + plan.alongX * unsupportedAlongM
        + plan.rightX * stairMiddleRight;
    const unsupportedZ = plan.centerZ
        + plan.alongZ * unsupportedAlongM
        + plan.rightZ * stairMiddleRight;
    assert.equal(plannerSurfaceCutStationSurfaceAtLocal(plan, unsupportedX, unsupportedZ), null);
    assert.equal(
        model.isOpenCutAtLocal(unsupportedX, unsupportedZ),
        true,
        'removed ground beside the stair is not a pedestrian floor',
    );

    assert.equal(
        model.isOpenCutAtLocal(
            plan.centerX + plan.rightX * plan.platformSideM,
            plan.centerZ + plan.rightZ * plan.platformSideM,
        ),
        true,
        'removed bare earth above the platform is classified as an unsafe cut, not a floor',
    );
});

test('a stored surface station does not widen an open formation by accident', () => {
    const model = modelFor({ station: stop('surface') });
    assert.deepEqual(model.getSurfaceStationAccessPlans(), []);
    const [profile] = model.getSurfaceProfiles();
    const halfWidth = getTrackbedHalfWidthMeters(feature().properties);
    const maxRight = Math.max(...profile.innerRing.map(point => point.z));
    const minLeft = Math.min(...profile.innerRing.map(point => point.z));
    assert.ok(Math.abs(maxRight - halfWidth) < 0.05);
    assert.ok(Math.abs(minLeft + halfWidth) < 0.05);
});

test('a saved shallow cut still clears the platform instead of burying feet', () => {
    const model = modelFor({ groundY: 0.3 });
    const [plan] = model.getSurfaceStationAccessPlans();
    assert.ok(plan);
    assert.ok(Math.abs(plan.depthM - 0.3) < 1e-9);
    assert.equal(plan.stair.stepCount, 3);
    const surface = plannerSurfaceCutStationSurfaceAtLocal(
        plan,
        plan.centerX + plan.rightX * plan.platformSideM,
        plan.centerZ + plan.rightZ * plan.platformSideM,
    );
    assert.equal(surface?.kind, 'platform');
});

test('a stale cut tag cannot punch a surface station through a bored tunnel', () => {
    const model = modelFor({ groundY: 12 });
    assert.deepEqual(model.getSurfaceStationAccessPlans(), []);
    assert.equal(model.formationAtLocal(0, 0)?.structure, 'tunnel');
});

test('unknown terrain does not become a zero-height stair landing', () => {
    const model = modelFor({ groundY: () => null });
    assert.deepEqual(model.getSurfaceStationAccessPlans(), []);
});

test('cut-station concrete is one instanced draw rather than meshes per stair tread', () => {
    const source = readFileSync(new URL('../world/platforms.js', import.meta.url), 'utf8');
    const builder = source.slice(
        source.indexOf('function addSurfaceCutStationAccess'),
        source.indexOf('function pointInStationFrame'),
    );
    assert.match(builder, /new THREE\.InstancedMesh\(geometry, material, instanceCount\)/);
    assert.match(builder, /const instanceCount = stepCount \+ 2/);
    assert.match(builder, /const blockHeightM = treadTopY - stairBaseY/);
    assert.match(builder, /access\.userData\.batchedDrawCalls = 1/);
    assert.doesNotMatch(builder, /new THREE\.Mesh\(/);
});

test('production cut-station instances provide the exact floors used by their new ground openings', () => {
    const source = readFileSync(new URL('../world/platforms.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('function addSurfaceCutStationAccess'), source.indexOf('function pointInStationFrame'));
    const build = Function('THREE', 'plannerSurfaceCutStationFloorBox', 'SURFACE_CUT_STAIR_TARGET_RISER_M',
        `${code}; return addSurfaceCutStationAccess;`)(THREE, plannerSurfaceCutStationFloorBox, SURFACE_CUT_STAIR_TARGET_RISER_M);
    const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
    const claim = { surfaceClass: SURFACE_CLASS.TERRAIN, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL };
    for (const groundY of [.3, 7.18]) {
        const model = modelFor({ groundY }), [plan] = model.getSurfaceStationAccessPlans();
        const root = new THREE.Group(), material = new THREE.MeshBasicMaterial();
        const access = build(root, plan, plan.railY + .06, 0, material);
        try {
            const supportRead = drain(captureReceiverMeshReadSteps({ root, include: mesh => mesh.userData.walkableSurface === true,
                revision: 1, ...GROUND_GENERATION_LIMITS.openingSupport }));
            const cuts = plannerSurfaceCutStationEntranceCutouts(model).map(cut => ({ ...cut, maxY: groundY + 1 }));
            const entrances = drain(captureStationGroundOpeningsSteps({ cuts, supportRead,
                replacementKey: 'station:test', maxCuts: 16, limits: GROUND_GENERATION_LIMITS.openings }));
            const read = drain(createSurfaceOpeningReadSteps({ entrances, limits: GROUND_GENERATION_LIMITS.openings }));
            assert.equal(access.isInstancedMesh, true);
            for (let step = 0; step < access.userData.stepCount; step++) {
                const along = plan.stair.startRightM + plan.stair.runM * (step + .5) / access.userData.stepCount;
                const x = plan.centerX + plan.rightX * along, z = plan.centerZ + plan.rightZ * along;
                const floorY = supportRead.supportYAt(x, z, Infinity);
                assert.ok(Number.isFinite(floorY), `missing actual tread ${step}`);
                assert.equal(read.contains(x, floorY + .01, z, claim), true, `soil above tread ${step}`);
                assert.equal(read.contains(x, plan.railY - 1, z, claim), false, `ground below concrete ${step}`);
            }
        } finally { access.geometry.dispose(); material.dispose(); model.dispose(); }
    }
});
