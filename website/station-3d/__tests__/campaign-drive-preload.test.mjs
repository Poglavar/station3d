// Verifies authored drive corridors cover a broad route and gate reveal on
// actual terrain plus rendered-road publication, never on vehicle speed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignDrivePreloadReadiness,
    campaignDriveTerrainCorridor,
    campaignDriveTerrainGridDescriptors,
    resolveCampaignDrivePreload,
} from '../core/campaign-drive-preload.js';
import { localToGeo } from '../core/math.js';
import { terrainGridTileIndex } from '../core/terrain-grid-tiles.js';

const SPEC = {
    path: [
        { lat: 45.805620, lon: 15.9793955 },
        { lat: 45.814120, lon: 15.971250 },
    ],
    halfWidthM: 450,
    sampleStepM: 75,
};

test('an authored escape path expands into a broad, tile-friendly corridor', () => {
    const plan = resolveCampaignDrivePreload({
        spec: SPEC,
        anchorLat: 45.8035551,
        anchorLon: 15.9695197,
    });

    assert.ok(plan);
    assert.equal(plan.path.length, 2);
    assert.equal(plan.halfWidthM, 450);
    assert.equal(plan.sampleStepM, 75);
    assert.ok(plan.points.length > 200);
    assert.equal(plan.priority.x, plan.path[0].x);
    assert.equal(plan.priority.z, plan.path[0].z);
    assert.ok(Number.isFinite(plan.priority.headingDeg));

    const terrainTileKeys = new Set(plan.points.map(point => (
        `${Math.floor(point.x / 400)}_${Math.floor(point.z / 400)}`
    )));
    const roadTileKeys = new Set(plan.points.map(point => (
        `${Math.floor(point.x / 200)}_${Math.floor(point.z / 200)}`
    )));
    assert.ok(terrainTileKeys.size >= 12);
    assert.ok(roadTileKeys.size >= 36);
});

test('invalid authored paths opt out instead of creating a false loading gate', () => {
    assert.equal(resolveCampaignDrivePreload({ spec: null }), null);
    assert.equal(resolveCampaignDrivePreload({
        spec: { path: [{ lat: 45.8, lon: 15.9 }] },
        anchorLat: 45.8,
        anchorLon: 15.9,
    }), null);
});

test('a scene can require detailed buildings throughout its reveal corridor', () => {
    const plan = resolveCampaignDrivePreload({
        spec: { ...SPEC, requireDetailedBuildings: true },
        anchorLat: 45.8035551,
        anchorLon: 15.9695197,
    });
    assert.equal(plan.requireDetailedBuildings, true);

    const partial = campaignDrivePreloadReadiness(plan, (x) => ({
        terrainReady: true,
        roadReady: true,
        buildingReady: x <= plan.points[0].x,
    }));
    assert.equal(partial.ready, false);
    assert.ok(partial.missingDetailedBuildingCount > 0);
    assert.equal(partial.firstMissing.buildingReady, false);

    const ready = campaignDrivePreloadReadiness(plan, () => ({
        terrainReady: true,
        roadReady: true,
        buildingReady: true,
    }));
    assert.equal(ready.ready, true);
    assert.equal(ready.missingDetailedBuildingCount, 0);
});

test('the campaign terrain load owns every fixed data cell beneath the corridor', () => {
    const anchorLat = 45.8035551;
    const anchorLon = 15.9695197;
    const plan = resolveCampaignDrivePreload({ spec: SPEC, anchorLat, anchorLon });
    const corridor = campaignDriveTerrainCorridor(plan);
    assert.deepEqual(corridor.geometry.coordinates, plan.path.map(point => [
        point.lon,
        point.lat,
    ]));

    const descriptors = campaignDriveTerrainGridDescriptors(plan, {
        anchorLat,
        anchorLon,
        source: 'dgu-dtm-20m',
    });
    const keys = new Set(descriptors.map(descriptor => descriptor.key));
    assert.equal(keys.size, descriptors.length, 'fixed terrain cells are deduplicated');
    assert.ok(keys.size > 0);
    for (const point of plan.points) {
        const geo = localToGeo(point.x, point.z, anchorLon, anchorLat);
        const tile = terrainGridTileIndex(geo.lon, geo.lat);
        assert.ok(keys.has(`${tile.tx}_${tile.ty}`), 'every drive sample has pinned source data');
    }
});

test('corridor readiness requires both published ground and final road tiles', () => {
    const plan = { points: [{ x: 0, z: 0 }, { x: 200, z: -200 }] };
    const partial = campaignDrivePreloadReadiness(plan, (x) => ({
        terrainReady: true,
        roadReady: x === 0,
    }));
    assert.deepEqual(partial, {
        ready: false,
        readyCount: 1,
        totalCount: 2,
        missingTerrainCount: 0,
        missingRoadCount: 1,
        firstMissing: { x: 200, z: -200, terrainReady: true, roadReady: false },
    });

    const ready = campaignDrivePreloadReadiness(plan, () => ({
        terrainReady: true,
        roadReady: true,
    }));
    assert.equal(ready.ready, true);
    assert.equal(ready.readyCount, 2);
});

// The gate is live, but a corridor point that has already published must not be
// taken back by ordinary tile churn: on a 389-point corridor that oscillation
// meant the chase level never reached a single instant with every point ready.
test('a corridor point that has been ready once is not taken back by churn', () => {
    const plan = resolveCampaignDrivePreload({
        spec: SPEC,
        anchorLat: 45.8035551,
        anchorLon: 15.9695197,
    });
    const satisfied = new Set();
    let readyEverywhere = true;

    const first = campaignDrivePreloadReadiness(plan, () => ({
        terrainReady: true,
        roadReady: readyEverywhere,
    }), { satisfied });
    assert.equal(first.ready, true);
    assert.equal(first.readyCount, plan.points.length);

    // Every tile goes pending again; without the per-build memory this reopens
    // the gate and the world can never be revealed.
    readyEverywhere = false;
    const afterChurn = campaignDrivePreloadReadiness(plan, () => ({
        terrainReady: true,
        roadReady: false,
    }), { satisfied });
    assert.equal(afterChurn.ready, true);
    assert.equal(afterChurn.readyCount, plan.points.length);
    assert.equal(afterChurn.missingRoadCount, 0);

    // A fresh build starts from nothing, so a new world still waits for its own
    // corridor to publish.
    const freshBuild = campaignDrivePreloadReadiness(plan, () => ({
        terrainReady: true,
        roadReady: false,
    }), { satisfied: new Set() });
    assert.equal(freshBuild.ready, false);
    assert.equal(freshBuild.readyCount, 0);
    assert.equal(freshBuild.missingRoadCount, plan.points.length);
});
