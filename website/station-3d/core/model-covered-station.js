// Plans the model world's route-following covered station fallback. It reuses
// the proven swept shell while matching the model running-tunnel cross-section.

import {
    samplePreparedStationTrackRoute,
} from './planner-station-track-anchor.js';
import { railBoreHalfWidthM } from './rail-formation.js';
import {
    buildPhotoCoveredStationSweep,
    PHOTO_COVERED_STATION_SECTION,
} from './photo-covered-station-shell.js';
import { measurePhotoStationRouteAlignment } from './photo-station-civil-envelope.js';
import {
    PLATFORM_WIDTH_M,
    PLANNER_TUNNEL_CLEARANCE_M,
    PLANNER_TUNNEL_FLOOR_WIDTH_M,
    PLANNER_TUNNEL_WALL_THICKNESS_M,
    UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
    UNDERGROUND_PLATFORM_LENGTH_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
} from '../world/planner-station-layout.js';
import { getTrackbedHalfWidthMeters } from '../world/tram-trackbed-dimensions.js';

const EPS = 1e-7;
const MODEL_TUNNEL_CEILING_HEIGHT_M = 6.2;
const MODEL_TUNNEL_FLOOR_DROP_M = 0.5;
// rails.js places the paved bed at +0.075 m and references the tunnel shell
// 15 mm below it. Keeping the same datum makes the swept fallback's endpoint
// floor and ceiling meet the ordinary bore without a vertical lip.
const MODEL_TUNNEL_BED_REFERENCE_M = 0.075 - 0.015;
const MODEL_TUNNEL_ROOF_THICKNESS_M = 0.4;
const MODEL_TUNNEL_FLOOR_THICKNESS_M = 0.3;
export const MODEL_COVERED_STATION_OVERLAP_M = 4;

export function buildModelRunningTunnelSection(properties = {}) {
    const boreHalfWidthM = railBoreHalfWidthM(getTrackbedHalfWidthMeters(properties));
    const floorTopOffsetM = MODEL_TUNNEL_BED_REFERENCE_M - MODEL_TUNNEL_FLOOR_DROP_M;
    const roofBottomOffsetM = MODEL_TUNNEL_BED_REFERENCE_M + MODEL_TUNNEL_CEILING_HEIGHT_M;
    return {
        // The running bore is an infinitely thin interior face at ±boreHalfWidth.
        // Put the fallback wall's inner face there and overlap its slab outside
        // the bore so no turn or floating-point seam can expose the sky.
        wallCenterM: boreHalfWidthM + PLANNER_TUNNEL_WALL_THICKNESS_M * 0.5,
        wallThicknessM: PLANNER_TUNNEL_WALL_THICKNESS_M,
        wallBottomOffsetM: floorTopOffsetM - MODEL_TUNNEL_FLOOR_THICKNESS_M,
        wallTopOffsetM: roofBottomOffsetM + MODEL_TUNNEL_ROOF_THICKNESS_M,
        roofHalfWidthM: boreHalfWidthM + PLANNER_TUNNEL_WALL_THICKNESS_M,
        roofBottomOffsetM,
        roofTopOffsetM: roofBottomOffsetM + MODEL_TUNNEL_ROOF_THICKNESS_M,
        sourceRoofOffsetM: roofBottomOffsetM,
        floorHalfWidthM: boreHalfWidthM + PLANNER_TUNNEL_WALL_THICKNESS_M,
        floorBottomOffsetM: floorTopOffsetM - MODEL_TUNNEL_FLOOR_THICKNESS_M,
        floorTopOffsetM,
    };
}

export const MODEL_RUNNING_TUNNEL_SECTION = Object.freeze(buildModelRunningTunnelSection());

export function getModelStationPortalAdapter(properties = {}) {
    const section = buildModelRunningTunnelSection(properties);
    return {
        boreHalfWidthM: section.wallCenterM - section.wallThicknessM * 0.5,
        boreRoofY: section.roofBottomOffsetM,
        capBottomY: section.floorTopOffsetM,
        openingHalfWidthM: PLANNER_TUNNEL_FLOOR_WIDTH_M * 0.5,
        openingTopY: PLANNER_TUNNEL_CLEARANCE_M,
    };
}

export function getModelCoveredStationRouteRange(anchor) {
    const route = anchor?.route;
    if (!route || !Number.isFinite(anchor?.chainageM)) return null;
    const halfOwnedM = UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5
        + MODEL_COVERED_STATION_OVERLAP_M;
    const startM = Math.max(0, anchor.chainageM - halfOwnedM);
    const endM = Math.min(route.lengthM, anchor.chainageM + halfOwnedM);
    return endM - startM > EPS ? { startM, endM } : null;
}

function routeSamplesBetween(route, startM, endM, stepM = 2) {
    if (!route || endM - startM <= EPS) return [];
    const chainages = new Set([startM, endM]);
    for (const chainageM of route.chainagesM || []) {
        if (chainageM > startM + EPS && chainageM < endM - EPS) {
            chainages.add(chainageM);
        }
    }
    for (let chainageM = startM; chainageM < endM; chainageM += stepM) {
        chainages.add(Math.min(endM, chainageM));
    }
    return [...chainages]
        .sort((left, right) => left - right)
        .map(chainageM => samplePreparedStationTrackRoute(route, chainageM))
        .filter(Boolean);
}

export function modelStationNeedsCoveredRoute(anchor) {
    const alignment = measurePhotoStationRouteAlignment(anchor);
    return !!alignment?.coverageOk && alignment.ok !== true;
}

export function buildModelCoveredStationPlan(anchor, {
    platformSideM,
    platformWidthM = PLATFORM_WIDTH_M,
    platformHeightM = UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
    platformLengthM = UNDERGROUND_PLATFORM_LENGTH_M,
    stationName = '',
    stationId = null,
    trackProperties = {},
} = {}) {
    const alignment = measurePhotoStationRouteAlignment(anchor);
    if (!alignment?.coverageOk || alignment.ok === true) return null;
    const route = anchor?.route;
    if (!route) return null;

    const range = getModelCoveredStationRouteRange(anchor);
    if (!range) return null;
    const { startM, endM } = range;
    const samples = routeSamplesBetween(route, startM, endM);
    if (samples.length < 2) return null;
    const contextM = 2;
    const startContext = startM > EPS
        ? samplePreparedStationTrackRoute(route, startM - contextM)
        : null;
    const endContext = endM < route.lengthM - EPS
        ? samplePreparedStationTrackRoute(route, endM + contextM)
        : null;
    const sweep = buildPhotoCoveredStationSweep(samples, {
        tunnelSection: buildModelRunningTunnelSection(trackProperties),
        stationSection: PHOTO_COVERED_STATION_SECTION,
        startContext,
        endContext,
        platform: {
            sideM: platformSideM,
            widthM: platformWidthM,
            heightM: platformHeightM,
            lengthM: platformLengthM,
            center: { x: anchor.x, z: anchor.z },
            label: stationName,
        },
    });
    return sweep ? {
        alignment,
        startM,
        endM,
        stationId,
        stationName,
        sweep,
    } : null;
}
