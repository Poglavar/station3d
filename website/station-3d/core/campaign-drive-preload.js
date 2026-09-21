// Builds a bounded, tile-friendly surface corridor for authored vehicle scenes.
// The corridor is loaded behind the chapter curtain so gameplay never has to
// trade vehicle speed for streaming readiness.

import { finiteOrNull, geoToLocal, localToGeo } from './math.js';
import {
    terrainGridTileDescriptor,
    terrainGridTileIndex,
} from './terrain-grid-tiles.js';

export const CAMPAIGN_DRIVE_PRELOAD = Object.freeze({
    halfWidthM: 450,
    sampleStepM: 75,
    maximumHalfWidthM: 800,
    minimumSampleStepM: 40,
    maximumSampleStepM: 150,
});

function geoPointToLocal(point, anchorLat, anchorLon) {
    const lat = finiteOrNull(point?.lat);
    const lon = finiteOrNull(point?.lon);
    if (lat === null || lon === null) return null;
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    return { lat, lon, x: local.x, z: local.z };
}

function corridorSamplePoints(path, halfWidthM, sampleStepM) {
    const points = [];
    const seen = new Set();
    const add = (x, z) => {
        // One-metre identity removes overlaps between adjacent path segments
        // without weakening the much coarser tile-coverage sampling contract.
        const key = `${Math.round(x)}:${Math.round(z)}`;
        if (seen.has(key)) return;
        seen.add(key);
        points.push({ x, z });
    };
    for (let segmentIndex = 1; segmentIndex < path.length; segmentIndex += 1) {
        const from = path[segmentIndex - 1];
        const to = path[segmentIndex];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const distanceM = Math.hypot(dx, dz);
        if (!(distanceM > 0)) continue;
        const forwardX = dx / distanceM;
        const forwardZ = dz / distanceM;
        const rightX = -forwardZ;
        const rightZ = forwardX;
        const forwardSteps = Math.max(1, Math.ceil(distanceM / sampleStepM));
        const lateralSteps = Math.max(1, Math.ceil((halfWidthM * 2) / sampleStepM));
        for (let forwardIndex = 0; forwardIndex <= forwardSteps; forwardIndex += 1) {
            const forwardM = distanceM * forwardIndex / forwardSteps;
            for (let lateralIndex = 0; lateralIndex <= lateralSteps; lateralIndex += 1) {
                const lateralM = -halfWidthM
                    + halfWidthM * 2 * lateralIndex / lateralSteps;
                add(
                    from.x + forwardX * forwardM + rightX * lateralM,
                    from.z + forwardZ * forwardM + rightZ * lateralM,
                );
            }
        }
    }
    return points;
}

export function resolveCampaignDrivePreload({
    spec,
    anchorLat,
    anchorLon,
    tuning = CAMPAIGN_DRIVE_PRELOAD,
} = {}) {
    const latitude = finiteOrNull(anchorLat);
    const longitude = finiteOrNull(anchorLon);
    if (latitude === null || longitude === null || !Array.isArray(spec?.path)) return null;
    const path = spec.path
        .map(point => geoPointToLocal(point, latitude, longitude))
        .filter(Boolean);
    if (path.length < 2) return null;
    const halfWidthM = Math.min(
        Math.max(0, finiteOrNull(spec.halfWidthM) ?? tuning.halfWidthM),
        Math.max(0, finiteOrNull(tuning.maximumHalfWidthM) ?? 800),
    );
    const sampleStepM = Math.min(
        Math.max(
            finiteOrNull(tuning.minimumSampleStepM) ?? 40,
            finiteOrNull(spec.sampleStepM) ?? tuning.sampleStepM,
        ),
        Math.max(40, finiteOrNull(tuning.maximumSampleStepM) ?? 150),
    );
    const points = corridorSamplePoints(path, halfWidthM, sampleStepM);
    if (points.length === 0) return null;
    const first = path[0];
    const second = path[1];
    const headingDeg = Math.atan2(second.x - first.x, -(second.z - first.z))
        * 180 / Math.PI;
    const signature = [
        path.map(point => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`).join(';'),
        Math.round(halfWidthM),
        Math.round(sampleStepM),
    ].join('|');
    return {
        signature,
        path,
        points,
        halfWidthM,
        sampleStepM,
        requireDetailedBuildings: spec.requireDetailedBuildings === true,
        priority: { x: first.x, z: first.z, headingDeg },
    };
}

export function campaignDrivePreloadReadiness(plan, readiness, { satisfied = null } = {}) {
    if (!plan || !Array.isArray(plan.points) || plan.points.length === 0
        || typeof readiness !== 'function') {
        return {
            ready: true,
            readyCount: 0,
            totalCount: 0,
            missingTerrainCount: 0,
            missingRoadCount: 0,
            firstMissing: null,
        };
    }
    let readyCount = 0;
    let missingTerrainCount = 0;
    let missingRoadCount = 0;
    let missingDetailedBuildingCount = 0;
    let firstMissing = null;
    const requireDetailedBuildings = plan.requireDetailedBuildings === true;
    let index = -1;
    for (const point of plan.points) {
        index += 1;
        // Monotonic within one build: a corridor point whose tile has published
        // once stays satisfied. Readiness is live, and ordinary churn re-marks a
        // neighbouring tile pending for a few frames, so requiring every point to
        // be ready in the SAME instant never converged on a corridor this size:
        // measured at the Zagreb chase start, the count oscillated between 162
        // and 298 of 389 for 35 minutes and the scene was failed by its
        // watchdog. Settling still needs quiescence — the caller holds the
        // corridor stable for DRIVE_SURFACE_STABLE_MS and requires every startup
        // queue idle in the same turn — so this cannot reveal a half-built world.
        if (satisfied?.has(index)) {
            readyCount += 1;
            continue;
        }
        const result = readiness(point.x, point.z) || {};
        const terrainReady = result.terrainReady === true;
        const roadReady = result.roadReady === true;
        const buildingReady = !requireDetailedBuildings || result.buildingReady === true;
        if (terrainReady && roadReady && buildingReady) {
            readyCount += 1;
            satisfied?.add(index);
            continue;
        }
        if (!terrainReady) missingTerrainCount += 1;
        if (!roadReady) missingRoadCount += 1;
        if (!buildingReady) missingDetailedBuildingCount += 1;
        if (!firstMissing) {
            firstMissing = {
                ...point,
                terrainReady,
                roadReady,
                ...(requireDetailedBuildings ? { buildingReady } : {}),
            };
        }
    }
    return {
        ready: readyCount === plan.points.length,
        readyCount,
        totalCount: plan.points.length,
        missingTerrainCount,
        missingRoadCount,
        ...(requireDetailedBuildings ? { missingDetailedBuildingCount } : {}),
        firstMissing,
    };
}

// Terrain is a level asset for a bounded campaign drive, not scenery that may
// revise itself under the player. These two projections let the terrain layer
// fetch and retain the exact fixed-grid cells beneath the whole authored area,
// and request a native-detail band along its intended route, without exposing
// a car corridor as a rail corridor to unrelated world layers.
export function campaignDriveTerrainCorridor(plan) {
    const coordinates = (plan?.path || []).map(point => [
        finiteOrNull(point?.lon),
        finiteOrNull(point?.lat),
    ]).filter(([lon, lat]) => lon !== null && lat !== null);
    if (coordinates.length < 2) return null;
    return {
        type: 'Feature',
        properties: { kind: 'campaign-drive-surface' },
        geometry: { type: 'LineString', coordinates },
    };
}

export function campaignDriveTerrainGridDescriptors(plan, {
    anchorLat,
    anchorLon,
    source = 'dgu-dtm-20m',
} = {}) {
    const latitude = finiteOrNull(anchorLat);
    const longitude = finiteOrNull(anchorLon);
    if (latitude === null || longitude === null || !Array.isArray(plan?.points)) return [];
    const descriptors = new Map();
    for (const point of plan.points) {
        const x = finiteOrNull(point?.x);
        const z = finiteOrNull(point?.z);
        if (x === null || z === null) continue;
        const geo = localToGeo(x, z, longitude, latitude);
        const tile = terrainGridTileIndex(geo.lon, geo.lat);
        const descriptor = terrainGridTileDescriptor(tile.tx, tile.ty, { source });
        descriptors.set(descriptor.key, descriptor);
    }
    return [...descriptors.values()];
}
