// Shared dimensions and orientation helpers for planner stations. The surface
// cutout and visible platform/stair geometry use the same footprint constants.

import { finiteOrNull, geoToLocal } from '../core/math.js';
import { cutBenchReachMeters } from '../core/road-formation.js';
import {
    UNDERGROUND_STATION_INTERIOR_HALF_WIDTH_M,
    UNDERGROUND_STATION_PLATFORM_HEIGHT_M,
} from '../core/station-contract.js';
import {
    getTrackbedHalfWidthMeters,
    PLANNER_UNDERGROUND_STATION_FLARE_LENGTH_M,
    PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M,
} from './tram-trackbed-dimensions.js';

export const PLANNER_LEVEL_HEIGHT_M = 10;
// The planner renders one shared double-track tunnel, unlike the legacy
// metro scene's two separate bores. The tunnel shell and station portals must
// consume this same cross-section or their junction opens visible seams.
export const PLANNER_TUNNEL_WALL_CENTER_OFFSET_M = 3.4;
export const PLANNER_TUNNEL_WALL_THICKNESS_M = 0.5;
export const PLANNER_TUNNEL_CLEARANCE_M = 5.5;
export const PLANNER_TUNNEL_FLOOR_WIDTH_M = PLANNER_TUNNEL_WALL_CENTER_OFFSET_M * 2;
export const PLANNER_TUNNEL_INNER_WIDTH_M = (
    PLANNER_TUNNEL_WALL_CENTER_OFFSET_M - PLANNER_TUNNEL_WALL_THICKNESS_M * 0.5
) * 2;
export const PLATFORM_WIDTH_M = 3;
export const PLATFORM_SIDE_OFFSET_M = 3.2;
const PLATFORM_TRACKBED_GAP_M = 0.55;
export const SURFACE_PLATFORM_LENGTH_M = 14;
// An at-grade station can still sit several metres below bare earth. In that
// case the ordinary track-width cutting is not a platform: it leaves the
// shelter and waiting crowd inside the retained hillside. These dimensions
// describe one compact, open-air station bay and a straight stair to grade.
// The rail earthworks, visible stair/slab and pedestrian support all consume
// the same plan produced below.
export const SURFACE_CUT_STATION_MIN_DEPTH_M = 0.6;
export const SURFACE_CUT_STATION_PLATFORM_PAD_M = 0.45;
export const SURFACE_CUT_STATION_WIDTH_TAPER_M = 5;
export const SURFACE_CUT_STAIR_WIDTH_M = 2.4;
export const SURFACE_CUT_STAIR_SIDE_CLEARANCE_M = 0.35;
export const SURFACE_CUT_STAIR_TREAD_M = 0.29;
export const SURFACE_CUT_STAIR_TARGET_RISER_M = 0.17;
export const SURFACE_CUT_STAIR_LANDING_M = 1.8;
export const SURFACE_CUT_STAIR_PLATFORM_OVERLAP_M = 0.12;
export const SURFACE_CUT_STAIR_WIDTH_TAPER_M = 3;
export const SURFACE_CUT_STAIR_TOP_CLEARANCE_M = 0.45;
export const SURFACE_CUT_STATION_FLOOR_SEAM_OVERLAP_M = 0.16;
// The terrain mask changes ownership halfway across its two-metre collar. A
// top landing that stopped at the nominal retained-face toe therefore left a
// narrow floorless slot before untouched ground began. Carry the concrete
// apron beneath that mask seam; the overlap is hidden once terrain is kept.
export const SURFACE_CUT_STAIR_PORTAL_APRON_M = 1.5;
const SURFACE_CUT_TERRAIN_COLLAR_REACH_M = 2;
export const ELEVATED_PLATFORM_LENGTH_M = 22;
export const UNDERGROUND_STATION_LENGTH_M = 60;
export const UNDERGROUND_STATION_THROAT_LENGTH_M =
    PLANNER_UNDERGROUND_STATION_FLARE_LENGTH_M;
export const UNDERGROUND_STATION_TOTAL_LENGTH_M = UNDERGROUND_STATION_LENGTH_M
    + UNDERGROUND_STATION_THROAT_LENGTH_M * 2;
export const UNDERGROUND_PLATFORM_LENGTH_M = UNDERGROUND_STATION_LENGTH_M - 8;
// The island carries the stair core down its centre, the lift beside it and a
// walkable mezzanine over both. A 6.4 m platform left ~2 m walkways that the
// stairs, their railings and the lift all fought over.
export const UNDERGROUND_ISLAND_PLATFORM_WIDTH_M = 10;
export const UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M =
    UNDERGROUND_STATION_PLATFORM_HEIGHT_M;
// Compatibility export for geometry consumers. The value itself belongs to
// the station contract, so model and photo shells cannot drift apart again.
export const UNDERGROUND_STATION_HALL_HALF_WIDTH_M =
    UNDERGROUND_STATION_INTERIOR_HALF_WIDTH_M;
export const UNDERGROUND_STATION_HALL_WIDTH_M = UNDERGROUND_STATION_HALL_HALF_WIDTH_M * 2;
// The platform hall is one level below the street. Its upper 3.4 m is the
// enclosed distribution mezzanine; the 6.2 m floor height below it clears the
// complete train envelope and lighting zone.
export const UNDERGROUND_STATION_HALL_HEIGHT_M = 9.6;
export const UNDERGROUND_STATION_TRACK_CENTER_SPACING_M =
    PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M;
// Two independent stair cores leave the island in opposite directions. Each
// rises parallel to the tracks, crosses above one track at mezzanine level,
// then continues in a side shaft to a separate street entrance.
export const UNDERGROUND_ACCESS_CORE_ALONG_M = 16;
export const UNDERGROUND_ACCESS_STAIR_RUN_M = 9;
export const UNDERGROUND_ACCESS_TOP_ALONG_M =
    UNDERGROUND_ACCESS_CORE_ALONG_M + UNDERGROUND_ACCESS_STAIR_RUN_M;
export const UNDERGROUND_ACCESS_STAIR_WIDTH_M = 2.2;
export const UNDERGROUND_ACCESS_PASSAGE_WIDTH_M = 2.6;
export const UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M = 0.16;
export const UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M = UNDERGROUND_ACCESS_STAIR_WIDTH_M * 0.5
    + UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M;
// The exit flight leaves the mezzanine passage through an opening in the
// passage's outer wall. That wall face is where the stair well begins: from
// there to the street entrance the well is open to the sky.
export const UNDERGROUND_STAIR_WELL_START_ALONG_M = UNDERGROUND_ACCESS_CORE_ALONG_M
    + UNDERGROUND_ACCESS_PASSAGE_WIDTH_M * 0.5;
// The flight from the platform stops at the near face of the passage instead
// of running on under its floor slab, where its top treads used to surface
// through the mezzanine walkway.
export const UNDERGROUND_LOWER_STAIR_TOP_ALONG_M = UNDERGROUND_ACCESS_CORE_ALONG_M
    - UNDERGROUND_ACCESS_PASSAGE_WIDTH_M * 0.5;
export const UNDERGROUND_STREET_LANDING_DEPTH_M = 1.8;
// The street surface is only cut open over ground the stair itself floors.
// Keeping the hole narrower than the flight guarantees every point inside it
// has a tread or the landing beneath, so nobody drops into the hall below.
export const UNDERGROUND_ENTRANCE_CUT_WIDTH_M = UNDERGROUND_ACCESS_STAIR_WIDTH_M - 0.1;
export const UNDERGROUND_MEZZANINE_HEIGHT_M = 6.2;
export const UNDERGROUND_MEZZANINE_RAIL_HEIGHT_M = 1.05;
export const UNDERGROUND_MEZZANINE_RAIL_THICKNESS_M = 0.12;
// Clear of the 9 m hall wall, with the street lift outboard of the stair well.
export const UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M = 10.8;
export const UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M = 13.6;
export const UNDERGROUND_LIFT_SIZE_M = 2.2;
// The platform lift stands against the mezzanine's outer edge, beside the
// stair core rather than squarely in front of both flights.
export const UNDERGROUND_PLATFORM_LIFT_CENTER_RIGHT_M = 3.7;
export const UNDERGROUND_PLATFORM_LIFT_ALONG_M = 0;
// The established legacy metro scene still uses two bores 8.4 m apart. New
// planner stations use the island dimensions above instead.
export const UNDERGROUND_PARALLEL_BORE_OFFSET_M = 8.4;
export const PLATFORM_TOP_OFFSET_M = 0.12;
export const ELEVATED_WALKWAY_RISE_M = 0.10;
export const ELEVATED_PLATFORM_SURFACE_CLEARANCE_M = 0.025;
export const PLATFORM_SLAB_THICKNESS_M = 0.35;
export const STATION_STAIR_RUN_M = 16;
export const STATION_STAIR_WIDTH_M = 2.4;
// A ten-metre level change needs ordinary ~16-17 cm risers. The former 20
// steps produced half-metre ledges that looked like a stepped wall.
export const STATION_STAIR_STEP_COUNT = 60;
// Elevated access uses two half-height flights parallel to the alignment.
// Keeping the complete switchback inside the 22 m platform length avoids the
// former perpendicular concrete stair projecting far into the city block.
export const ELEVATED_STAIR_FLIGHT_RUN_M = 8.4;
export const ELEVATED_STAIR_FLIGHT_WIDTH_M = 2.0;
export const ELEVATED_STAIR_FLIGHT_GAP_M = 0.35;
export const ELEVATED_STAIR_LANDING_DEPTH_M = 1.8;
export const ELEVATED_STAIR_PLATFORM_GAP_M = 0.25;
export const ELEVATED_LIFT_SIZE_M = 2.4;
export const ELEVATED_LIFT_GAP_M = 0.6;
// The entrance encloses the whole stair well rather than roofing its last few
// metres and leaving an open trench behind it: side walls and a roof run from
// the well head to the far edge of the street landing, open only at the front.
export const METRO_ENTRANCE_WALL_THICKNESS_M = 0.26;
export const METRO_ENTRANCE_HALF_WIDTH_M = UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M
    + METRO_ENTRANCE_WALL_THICKNESS_M;
export const METRO_ENTRANCE_START_ALONG_M = UNDERGROUND_STAIR_WELL_START_ALONG_M;
export const METRO_ENTRANCE_END_ALONG_M = UNDERGROUND_ACCESS_TOP_ALONG_M
    + UNDERGROUND_STREET_LANDING_DEPTH_M * 0.5;
export const METRO_ENTRANCE_DEPTH_M = METRO_ENTRANCE_END_ALONG_M - METRO_ENTRANCE_START_ALONG_M;
export const METRO_ENTRANCE_WIDTH_M = METRO_ENTRANCE_HALF_WIDTH_M * 2;
export const METRO_ENTRANCE_HEIGHT_M = 2.8;

export function getPlannerPlatformSideOffsetM(properties = {}) {
    return getTrackbedHalfWidthMeters(properties)
        + PLATFORM_TRACKBED_GAP_M
        + PLATFORM_WIDTH_M * 0.5;
}

export function getElevatedAccessLayout() {
    const platformOuter = PLATFORM_WIDTH_M * 0.5;
    const innerFlightCenterRight = platformOuter
        + ELEVATED_STAIR_PLATFORM_GAP_M
        + ELEVATED_STAIR_FLIGHT_WIDTH_M * 0.5;
    const outerFlightCenterRight = innerFlightCenterRight
        + ELEVATED_STAIR_FLIGHT_WIDTH_M
        + ELEVATED_STAIR_FLIGHT_GAP_M;
    const stairsOuter = outerFlightCenterRight + ELEVATED_STAIR_FLIGHT_WIDTH_M * 0.5;
    const liftCenterRight = stairsOuter + ELEVATED_LIFT_GAP_M + ELEVATED_LIFT_SIZE_M * 0.5;
    return {
        platformOuter,
        innerFlightCenterRight,
        outerFlightCenterRight,
        stairsOuter,
        liftCenterRight,
        accessOuter: liftCenterRight + ELEVATED_LIFT_SIZE_M * 0.5,
        topLandingAlong: -(ELEVATED_STAIR_FLIGHT_RUN_M + ELEVATED_STAIR_LANDING_DEPTH_M) * 0.5,
        middleLandingAlong: (ELEVATED_STAIR_FLIGHT_RUN_M + ELEVATED_STAIR_LANDING_DEPTH_M) * 0.5,
    };
}

// Vertical contract shared by the switchback stairs and lift. Most sessions
// place the station group origin on the ground, but absolute EVRF2000 model
// sessions keep the origin at the elevation datum and therefore have a
// non-zero local ground. Every access component must use that same base.
export function resolveElevatedStationAccessHeights(platformTopY, groundLocalY = 0) {
    const platformY = Number(platformTopY);
    const localGroundY = Number(groundLocalY);
    const platform = Number.isFinite(platformY) ? platformY : 0;
    const liftBaseY = Number.isFinite(localGroundY) ? localGroundY : 0;
    const groundY = liftBaseY + 0.06;
    const liftTopY = platform + 2.5;
    return {
        platformY: platform,
        groundY,
        middleY: (groundY + platform) * 0.5,
        liftBaseY,
        liftTopY,
        liftShaftHeight: liftTopY - liftBaseY,
        liftShaftCenterY: (liftBaseY + liftTopY) * 0.5,
    };
}

export function getPlannerStopLevel(stop) {
    const rawLevel = stop && stop.level;
    if (rawLevel !== null && rawLevel !== undefined && rawLevel !== '') {
        const explicitLevel = Number(rawLevel);
        if (Number.isInteger(explicitLevel) && explicitLevel >= -1 && explicitLevel <= 1) {
            return explicitLevel;
        }
    }
    const elevM = Number(stop && stop.elevM);
    if (!Number.isFinite(elevM)) return 0;
    if (elevM <= -PLANNER_LEVEL_HEIGHT_M * 0.5) return -1;
    if (elevM >= PLANNER_LEVEL_HEIGHT_M * 0.5) return 1;
    return 0;
}

// Track forward is (sin(angle), cos(angle)); right of travel is forward × up.
export function getTrackRightVector(angleY) {
    return { x: -Math.cos(angleY), z: Math.sin(angleY) };
}

function plannerTrackSegments(features, anchorLat, anchorLon) {
    const segments = [];
    for (const feature of features || []) {
        const geometry = feature?.geometry;
        if (!geometry) continue;
        const lines = geometry.type === 'LineString'
            ? [geometry.coordinates || []]
            : geometry.type === 'MultiLineString'
                ? geometry.coordinates || []
                : [];
        const properties = feature?.properties || {};
        const trackIds = Array.isArray(properties.trackIds)
            ? properties.trackIds.map(String)
            : [];
        for (const coordinates of lines) {
            for (let i = 0; i < coordinates.length - 1; i++) {
                const a = coordinates[i];
                const b = coordinates[i + 1];
                if (!Array.isArray(a) || !Array.isArray(b)) continue;
                const lonA = Number(a[0]);
                const latA = Number(a[1]);
                const lonB = Number(b[0]);
                const latB = Number(b[1]);
                if (![lonA, latA, lonB, latB].every(Number.isFinite)) continue;
                const start = geoToLocal(lonA, latA, anchorLon, anchorLat);
                const end = geoToLocal(lonB, latB, anchorLon, anchorLat);
                const dx = end.x - start.x;
                const dz = end.z - start.z;
                const length = Math.hypot(dx, dz);
                if (length < 0.5) continue;
                segments.push({
                    start,
                    end,
                    dx,
                    dz,
                    length,
                    alongX: dx / length,
                    alongZ: dz / length,
                    rightX: -dz / length,
                    rightZ: dx / length,
                    e1: Number.isFinite(Number(a[2])) ? Number(a[2]) : 0,
                    e2: Number.isFinite(Number(b[2])) ? Number(b[2]) : 0,
                    trackId: properties.trackId ?? null,
                    trackIds,
                    properties,
                });
            }
        }
    }
    return segments;
}

function segmentMatchesTrack(segment, trackId) {
    if (trackId == null) return true;
    const key = String(trackId);
    return (segment.trackId != null && String(segment.trackId) === key)
        || segment.trackIds.includes(key);
}

function projectOntoSegment(x, z, segment) {
    const lengthSq = segment.length * segment.length;
    const t = Math.max(0, Math.min(1,
        ((x - segment.start.x) * segment.dx + (z - segment.start.z) * segment.dz) / lengthSq,
    ));
    const projectedX = segment.start.x + segment.dx * t;
    const projectedZ = segment.start.z + segment.dz * t;
    return {
        x: projectedX,
        z: projectedZ,
        t,
        distanceSq: (x - projectedX) ** 2 + (z - projectedZ) ** 2,
    };
}

function plannerStopKey(stop) {
    const id = stop?.stopId ?? stop?.id;
    if (id != null) return `id:${String(id)}`;
    const lng = Number(stop?.lng ?? stop?.lon ?? stop?.latlng?.[1]);
    const lat = Number(stop?.lat ?? stop?.latlng?.[0]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return `geo:${lat.toFixed(7)},${lng.toFixed(7)}:${String(stop?.trackId ?? '')}`;
}

function alignmentMatchesTrack(alignment, trackId) {
    if (trackId == null) return true;
    const properties = alignment?.feature?.properties || {};
    const key = String(trackId);
    if (properties.trackId != null && String(properties.trackId) === key) return true;
    return (properties.trackIds || []).some(candidate => String(candidate) === key);
}

function projectOntoAlignment(local, alignment) {
    let best = null;
    for (const segment of alignment?.segments || []) {
        const dx = segment.x2 - segment.x1;
        const dz = segment.z2 - segment.z1;
        const lengthSquared = dx * dx + dz * dz;
        if (lengthSquared < 1e-9) continue;
        const t = Math.max(0, Math.min(1,
            ((local.x - segment.x1) * dx + (local.z - segment.z1) * dz) / lengthSquared,
        ));
        const x = segment.x1 + dx * t;
        const z = segment.z1 + dz * t;
        const distanceSq = (local.x - x) ** 2 + (local.z - z) ** 2;
        if (best && distanceSq >= best.distanceSq) continue;
        const startStationM = alignment.samples?.[segment.startSampleIndex]?.station;
        const endStationM = alignment.samples?.[segment.endSampleIndex]?.station;
        if (!Number.isFinite(startStationM) || !Number.isFinite(endStationM)) continue;
        best = {
            segment,
            t,
            x,
            z,
            distanceSq,
            stationM: startStationM + (endStationM - startStationM) * t,
            railY: segment.y1 + (segment.y2 - segment.y1) * t,
        };
    }
    return best;
}

function interpolateAlignmentTerrainY(alignment, stationM) {
    const samples = alignment?.samples || [];
    if (samples.length === 0) return null;
    if (stationM <= samples[0].station) {
        return finiteOrNull(samples[0].terrainY);
    }
    for (let index = 1; index < samples.length; index++) {
        const before = samples[index - 1];
        const after = samples[index];
        if (stationM > after.station) continue;
        const a = finiteOrNull(before.terrainY);
        const b = finiteOrNull(after.terrainY);
        if (a === null && b === null) return null;
        if (a === null) return b;
        if (b === null) return a;
        const span = after.station - before.station;
        const t = span > 1e-9 ? (stationM - before.station) / span : 0;
        return a + (b - a) * t;
    }
    return finiteOrNull(samples.at(-1)?.terrainY);
}

function sampleGround(baseSceneYAtLocal, x, z, fallback = null) {
    const value = typeof baseSceneYAtLocal === 'function'
        ? finiteOrNull(baseSceneYAtLocal(x, z))
        : null;
    return value === null ? finiteOrNull(fallback) : value;
}

// Produces the one civil/access contract for planner stations in an open cut.
// It deliberately needs the already-classified alignment: a stored `cut` tag
// cannot punch a surface bay into a segment that the live terrain proved to be
// a bored tunnel or a viaduct.
export function buildPlannerSurfaceCutStationAccessPlans({
    stops = [],
    alignment,
    anchorLat,
    anchorLon,
    baseSceneYAtLocal,
} = {}) {
    if (!alignment?.segments?.length || !alignment?.samples?.length) return [];
    const plans = [];
    const seen = new Set();
    const properties = alignment.feature?.properties || {};
    const formationHalfWidthM = getTrackbedHalfWidthMeters(properties);
    const platformSideM = getPlannerPlatformSideOffsetM(properties);
    const platformInnerRightM = platformSideM - PLATFORM_WIDTH_M * 0.5;
    const platformOuterRightM = platformSideM + PLATFORM_WIDTH_M * 0.5;
    for (const stop of stops || []) {
        if (stop?.trackId == null || getPlannerStopLevel(stop) !== 0) continue;
        if (!alignmentMatchesTrack(alignment, stop.trackId)) continue;
        const key = plannerStopKey(stop);
        if (!key || seen.has(key)) continue;
        const lng = Number(stop.lng ?? stop.lon ?? stop.latlng?.[1]);
        const lat = Number(stop.lat ?? stop.latlng?.[0]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const projected = projectOntoAlignment(
            geoToLocal(lng, lat, anchorLon, anchorLat),
            alignment,
        );
        if (!projected || projected.distanceSq > 12 * 12) continue;
        // A level-0 station is allowed in an open formation only. This keeps a
        // stale saved tag from opening the roof over an actual bored run.
        if (projected.segment.structure !== 'formation') continue;

        const alongX = projected.segment.ux;
        const alongZ = projected.segment.uz;
        const rightX = -alongZ;
        const rightZ = alongX;
        const fallbackGroundY = interpolateAlignmentTerrainY(alignment, projected.stationM);
        const platformCarveRightM = platformOuterRightM
            + SURFACE_CUT_STATION_PLATFORM_PAD_M;
        let topLandingGroundSampleRightM = platformOuterRightM
            + SURFACE_CUT_STAIR_LANDING_M;
        let groundY = sampleGround(
            baseSceneYAtLocal,
            projected.x + rightX * topLandingGroundSampleRightM,
            projected.z + rightZ * topLandingGroundSampleRightM,
            fallbackGroundY,
        );
        let depthM = groundY === null ? null : groundY - projected.railY;
        const storedKind = String(stop.structureKind || '').trim().toLowerCase();
        const explicitlyCut = storedKind === 'cut';
        const explicitlyNotCut = storedKind && storedKind !== 'cut';
        // A saved cut station gets a bay even when only a few decimetres of
        // shoulder cover it — that is still enough to bury people's feet. Old
        // saves with no form tag are inferred only past the stronger threshold.
        if (explicitlyNotCut
            || !(depthM > 0.08)
            || (!explicitlyCut && depthM < SURFACE_CUT_STATION_MIN_DEPTH_M)) continue;

        // The landing point moves as the stair run changes, so resample bare
        // earth there a few times. For ordinary slopes this converges in one or
        // two passes and makes the final tread meet the actual cut shoulder.
        let stepCount = 0;
        let stairRunM = 0;
        for (let pass = 0; pass < 6; pass++) {
            stepCount = Math.max(3, Math.ceil(depthM / SURFACE_CUT_STAIR_TARGET_RISER_M));
            stairRunM = stepCount * SURFACE_CUT_STAIR_TREAD_M;
            const stairEndRightM = platformOuterRightM
                - SURFACE_CUT_STAIR_PLATFORM_OVERLAP_M
                + stairRunM;
            const ordinaryBenchConnectionRightM = platformCarveRightM
                + cutBenchReachMeters(depthM)
                + SURFACE_CUT_TERRAIN_COLLAR_REACH_M;
            topLandingGroundSampleRightM = Math.max(
                stairEndRightM
                + SURFACE_CUT_STAIR_LANDING_M
                + SURFACE_CUT_STAIR_TOP_CLEARANCE_M,
                ordinaryBenchConnectionRightM,
            );
            const sampled = sampleGround(
                baseSceneYAtLocal,
                projected.x + rightX * topLandingGroundSampleRightM,
                projected.z + rightZ * topLandingGroundSampleRightM,
                groundY,
            );
            const nextDepthM = sampled === null ? null : sampled - projected.railY;
            groundY = sampled;
            if (nextDepthM === null) break;
            if (Math.abs(nextDepthM - depthM) < 0.03) {
                depthM = nextDepthM;
                break;
            }
            depthM = Math.max(0.08, nextDepthM);
        }
        stepCount = Math.max(3, Math.ceil(depthM / SURFACE_CUT_STAIR_TARGET_RISER_M));
        stairRunM = stepCount * SURFACE_CUT_STAIR_TREAD_M;
        const stairStartRightM = platformOuterRightM
            - SURFACE_CUT_STAIR_PLATFORM_OVERLAP_M;
        const stairEndRightM = stairStartRightM + stairRunM;
        const landingEndRightM = Math.max(
            stairEndRightM
                + SURFACE_CUT_STAIR_LANDING_M
                + SURFACE_CUT_STAIR_TOP_CLEARANCE_M,
            platformCarveRightM
                + cutBenchReachMeters(depthM)
                + SURFACE_CUT_TERRAIN_COLLAR_REACH_M,
        );
        const landingLengthM = landingEndRightM - stairEndRightM;
        const portalEndRightM = landingEndRightM + SURFACE_CUT_STAIR_PORTAL_APRON_M;
        // The station bay ends beside the platform. Across the narrow stair
        // opening, its retained batter is deliberately lengthened to carry the
        // steps and landing up to untouched terrain (see requiredBenchReachM),
        // rather than moving a full-height vertical wall to the landing's end.
        const stairCarveRightM = platformCarveRightM;
        const platformPlateauHalfM = SURFACE_PLATFORM_LENGTH_M * 0.5
            + SURFACE_CUT_STATION_PLATFORM_PAD_M;
        const stairPlateauHalfM = SURFACE_CUT_STAIR_WIDTH_M * 0.5
            + SURFACE_CUT_STAIR_SIDE_CLEARANCE_M;
        const sections = [
            {
                kind: 'platform-bay',
                centerStationM: projected.stationM,
                plateauHalfM: platformPlateauHalfM,
                taperM: SURFACE_CUT_STATION_WIDTH_TAPER_M,
                rightHalfWidthM: platformCarveRightM,
            },
            {
                kind: 'stair-well',
                centerStationM: projected.stationM,
                plateauHalfM: stairPlateauHalfM,
                taperM: SURFACE_CUT_STAIR_WIDTH_TAPER_M,
                rightHalfWidthM: stairCarveRightM,
            },
        ];
        plans.push({
            key,
            stopId: stop.stopId ?? stop.id ?? null,
            trackId: stop.trackId,
            stationName: String(stop.name || 'Station'),
            alignment,
            stationM: projected.stationM,
            routeStationM: Number(alignment.routeStartStationM || 0) + projected.stationM,
            centerX: projected.x,
            centerZ: projected.z,
            alongX,
            alongZ,
            rightX,
            rightZ,
            angleY: Math.atan2(alongX, alongZ),
            railY: projected.railY,
            groundY,
            depthM,
            formationHalfWidthM,
            platformSideM,
            platformInnerRightM,
            platformOuterRightM,
            platformAlongHalfM: SURFACE_PLATFORM_LENGTH_M * 0.5,
            sections,
            stair: {
                centerAlongM: 0,
                widthM: SURFACE_CUT_STAIR_WIDTH_M,
                startRightM: stairStartRightM,
                endRightM: stairEndRightM,
                runM: stairRunM,
                stepCount,
                landingEndRightM,
                landingLengthM,
                portalEndRightM,
                // Put the retained face at the OUTER end of the landing. The
                // previous collar-width subtraction left the upper treads under
                // the terrain collar: the stair existed, but there was no open
                // portal through which a walker could reach grade. The 40 cm
                // allowance covers the bench march's sampling quantum.
                requiredBenchReachM: Math.max(
                    0,
                    landingEndRightM
                        - stairCarveRightM
                        + 0.4,
                ),
            },
        });
        seen.add(key);
    }
    return plans;
}

// A thin concrete floor runs underneath the exact tapered station carve. Its
// rectangular ends deliberately continue into kept terrain, where they are
// hidden, so every rasterised/mitered edge of the visible bay lands on concrete
// instead of exposing the world underlay as a purple void. The same small seam
// overlap tucks it under the ordinary trackbed and retained face.
export function plannerSurfaceCutStationFloorBox(plan) {
    const section = (plan?.sections || []).find(item => item?.kind === 'platform-bay');
    const formationHalfWidthM = finiteOrNull(plan?.formationHalfWidthM);
    const outerRightM = finiteOrNull(section?.rightHalfWidthM);
    const plateauHalfM = finiteOrNull(section?.plateauHalfM);
    const taperM = finiteOrNull(section?.taperM);
    if (formationHalfWidthM === null
        || outerRightM === null
        || plateauHalfM === null
        || taperM === null
        || outerRightM <= formationHalfWidthM) return null;
    const innerRightM = formationHalfWidthM - SURFACE_CUT_STATION_FLOOR_SEAM_OVERLAP_M;
    const coveredOuterRightM = outerRightM + SURFACE_CUT_STATION_FLOOR_SEAM_OVERLAP_M;
    const halfAlongM = plateauHalfM
        + Math.max(0, taperM)
        + SURFACE_CUT_STATION_FLOOR_SEAM_OVERLAP_M;
    return {
        centerRightM: (innerRightM + coveredOuterRightM) * 0.5,
        innerRightM,
        outerRightM: coveredOuterRightM,
        widthM: coveredOuterRightM - innerRightM,
        halfAlongM,
        lengthM: halfAlongM * 2,
    };
}

// Surface stations in deep cuts need the same pixel-exact hole through every
// ground-level material as underground entrances. The rail-formation polygon
// removes terrain at network-mask resolution, but a narrow stair can still be
// roofed by road surfaces or their terrain collars. Use the already solved
// access plan and inset the capsule endpoints by its radius: every discarded
// pixel then has a tread or the portal apron directly beneath it.
export function plannerSurfaceCutStationEntranceCutout(plan) {
    const stair = plan?.stair;
    const startRightM = finiteOrNull(stair?.startRightM);
    const portalEndRightM = finiteOrNull(stair?.portalEndRightM)
        ?? finiteOrNull(stair?.landingEndRightM);
    const stairWidthM = finiteOrNull(stair?.widthM);
    if (startRightM === null || portalEndRightM === null || stairWidthM === null
        || !(portalEndRightM > startRightM) || !(stairWidthM > 0.2)) return null;
    // Keep four centimetres of concrete under each long edge so raster and
    // antialiasing cannot reveal a hairline void beside the stair boxes.
    const widthM = stairWidthM - 0.08;
    const radiusM = widthM * 0.5;
    const fromRightM = startRightM + radiusM;
    const toRightM = portalEndRightM - radiusM;
    if (!(toRightM > fromRightM)) return null;
    return {
        kind: 'station-entrance',
        stationEntranceKind: 'surface-cut-stairs',
        stopId: plan.stopId ?? null,
        x1: plan.centerX + plan.rightX * fromRightM,
        z1: plan.centerZ + plan.rightZ * fromRightM,
        x2: plan.centerX + plan.rightX * toRightM,
        z2: plan.centerZ + plan.rightZ * toRightM,
        widthM,
    };
}

export function plannerSurfaceCutStationEntranceCutouts(railFormation) {
    return (railFormation?.getSurfaceStationAccessPlans?.() || [])
        .map(plannerSurfaceCutStationEntranceCutout)
        .filter(Boolean);
}

// Exact analytic opening for one dynamically sized underground stair. The
// platform renderer supplies the top landing produced by its rise-aware stair
// planner, so a deep station opens only the well that its current geometry
// actually floors instead of the former fixed-length approximation.
export function undergroundStationEntranceCutout({
    stopId = null,
    centerX,
    centerZ,
    angleY,
    direction,
    topAlongM,
} = {}) {
    const cx = finiteOrNull(centerX);
    const cz = finiteOrNull(centerZ);
    const angle = finiteOrNull(angleY);
    const topAlong = finiteOrNull(topAlongM);
    const side = Number(direction) < 0 ? -1 : Number(direction) > 0 ? 1 : 0;
    if (cx === null || cz === null || angle === null || topAlong === null || side === 0) {
        return null;
    }
    const radiusM = UNDERGROUND_ENTRANCE_CUT_WIDTH_M * 0.5;
    const fromAlongM = side * (UNDERGROUND_STAIR_WELL_START_ALONG_M + radiusM);
    const toAlongM = topAlong
        + side * (UNDERGROUND_STREET_LANDING_DEPTH_M * 0.5 - radiusM);
    if (side * (toAlongM - fromAlongM) <= 0) return null;
    const right = getTrackRightVector(angle);
    const forward = { x: Math.sin(angle), z: Math.cos(angle) };
    const centerRightM = side * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M;
    return {
        kind: 'station-entrance',
        stationEntranceKind: 'underground-stairs',
        stopId,
        x1: cx + right.x * centerRightM + forward.x * fromAlongM,
        z1: cz + right.z * centerRightM + forward.z * fromAlongM,
        x2: cx + right.x * centerRightM + forward.x * toAlongM,
        z2: cz + right.z * centerRightM + forward.z * toAlongM,
        widthM: UNDERGROUND_ENTRANCE_CUT_WIDTH_M,
    };
}

export function findPlannerSurfaceCutStationAccessPlan(plans, stop) {
    const key = plannerStopKey(stop);
    return key ? (plans || []).find(plan => plan?.key === key) || null : null;
}

// Height of an actual walkable surface owned by a cut station, or null. This
// is intentionally analytic and shared with ambient pedestrians: bare terrain
// above a carved trench is never a valid fallback floor.
export function plannerSurfaceCutStationSurfaceAtLocal(plan, x, z) {
    if (!plan) return null;
    const dx = Number(x) - plan.centerX;
    const dz = Number(z) - plan.centerZ;
    const alongM = dx * plan.alongX + dz * plan.alongZ;
    const rightM = dx * plan.rightX + dz * plan.rightZ;
    if (Math.abs(alongM) <= plan.platformAlongHalfM
        && rightM >= plan.platformInnerRightM
        && rightM <= plan.platformOuterRightM) {
        return { kind: 'platform', floorY: plan.railY + 0.06, plan };
    }
    const stair = plan.stair;
    if (!stair || Math.abs(alongM - stair.centerAlongM) > stair.widthM * 0.5) return null;
    const portalEndRightM = finiteOrNull(stair.portalEndRightM)
        ?? finiteOrNull(stair.landingEndRightM);
    if (portalEndRightM === null
        || rightM < stair.startRightM
        || rightM > portalEndRightM) return null;
    if (rightM >= stair.endRightM) {
        return { kind: 'landing', floorY: plan.groundY + 0.03, plan };
    }
    const t = Math.max(0, Math.min(1,
        (rightM - stair.startRightM) / Math.max(0.01, stair.runM),
    ));
    const step = Math.min(stair.stepCount, Math.max(1, Math.ceil(t * stair.stepCount)));
    const platformFloorY = plan.railY + 0.06;
    const landingFloorY = plan.groundY + 0.03;
    return {
        kind: 'stairs',
        floorY: platformFloorY
            + (landingFloorY - platformFloorY) * (step / stair.stepCount),
        plan,
    };
}

// A cut surface can only be a pedestrian floor while the immutable terrain is
// at or above it. This is normally guaranteed by the access-plan solver, but a
// moving DGU window can make a previously solved plan stale for a few frames.
// Rejecting a floor suspended above the new terrain is safer than pinning an
// entire stop crowd to the old datum. One riser of tolerance keeps stair treads
// valid where the stepped concrete sits just above the smooth raw slope.
export function plannerSurfaceCutStationSurfaceSupportedByTerrain(
    surface,
    terrainY,
    toleranceM = SURFACE_CUT_STAIR_TARGET_RISER_M + 0.03,
) {
    const floorY = finiteOrNull(surface?.floorY);
    const groundY = finiteOrNull(terrainY);
    if (floorY === null || groundY === null) return false;
    const tolerance = Math.max(0, finiteOrNull(toleranceM) ?? 0);
    return groundY >= floorY - tolerance;
}

function makeStationClearanceVolume(
    segment,
    projected,
    rightMin,
    rightMax,
    halfDepth,
    stopId,
    kind,
    centerAlong = 0,
) {
    const centerRight = (rightMin + rightMax) * 0.5;
    return {
        centerX: projected.x
            + segment.rightX * centerRight
            + segment.alongX * centerAlong,
        centerY: 120,
        centerZ: projected.z
            + segment.rightZ * centerRight
            + segment.alongZ * centerAlong,
        alongX: segment.alongX,
        alongZ: segment.alongZ,
        rightX: segment.rightX,
        rightZ: segment.rightZ,
        halfWidth: (rightMax - rightMin) * 0.5,
        halfHeight: 120,
        halfDepth,
        ownerTrackId: segment.trackId,
        ownerTrackIds: segment.trackIds,
        source: 'planner-station',
        stopId,
        stationClearanceKind: kind,
    };
}

// User stations reserve their complete above-ground footprint. These OBBs are
// consumed by the building cut shader and its exposed-wall patch builder; the
// underground station reserves only its two stair heads and lift so the city
// remains intact above the buried hall and distribution mezzanine.
export function buildPlannerStationClearanceVolumes(stops, features, anchorLat, anchorLon) {
    const segments = plannerTrackSegments(features, anchorLat, anchorLon);
    if (segments.length === 0) return [];
    const volumes = [];
    for (const stop of stops || []) {
        // Real OSM stops do not belong to a planner track. Limit destructive
        // clearance to stations the user actually placed on a proposal.
        if (stop?.trackId == null) continue;
        const lng = Number(stop.lng ?? stop.lon);
        const lat = Number(stop.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const local = geoToLocal(lng, lat, anchorLon, anchorLat);
        const level = getPlannerStopLevel(stop);
        const targetElevation = Number.isFinite(Number(stop.elevM))
            ? Number(stop.elevM)
            : level * PLANNER_LEVEL_HEIGHT_M;
        let best = null;
        let bestFullLevel = null;
        for (const segment of segments) {
            if (!segmentMatchesTrack(segment, stop.trackId)) continue;
            const projected = projectOntoSegment(local.x, local.z, segment);
            if (!best || projected.distanceSq < best.projected.distanceSq) {
                best = { segment, projected };
            }
            const isFullLevel = Math.abs(segment.e1 - targetElevation) <= 0.75
                && Math.abs(segment.e2 - targetElevation) <= 0.75;
            if (isFullLevel && (!bestFullLevel
                || projected.distanceSq < bestFullLevel.projected.distanceSq)) {
                bestFullLevel = { segment, projected };
            }
        }
        if (bestFullLevel && (!best
            || bestFullLevel.projected.distanceSq <= best.projected.distanceSq + 1)) {
            best = bestFullLevel;
        }
        if (!best || best.projected.distanceSq > 12 * 12) continue;

        const stopId = stop.stopId ?? stop.id ?? null;
        if (level === 0) {
            const padding = 0.45;
            const platformSideOffset = getPlannerPlatformSideOffsetM(best.segment.properties);
            volumes.push(makeStationClearanceVolume(
                best.segment,
                best.projected,
                platformSideOffset - PLATFORM_WIDTH_M * 0.5 - padding,
                platformSideOffset + PLATFORM_WIDTH_M * 0.5 + padding,
                SURFACE_PLATFORM_LENGTH_M * 0.5 + padding,
                stopId,
                'surface-platform',
            ));
            continue;
        }

        if (level > 0) {
            const padding = 0.5;
            const access = getElevatedAccessLayout();
            const platformSideOffset = getPlannerPlatformSideOffsetM(best.segment.properties);
            volumes.push(makeStationClearanceVolume(
                best.segment,
                best.projected,
                platformSideOffset - PLATFORM_WIDTH_M * 0.5 - padding,
                platformSideOffset + access.accessOuter + padding,
                ELEVATED_PLATFORM_LENGTH_M * 0.5 + padding,
                stopId,
                'elevated-platform-stairs-and-lift',
            ));
            continue;
        }

        const entranceHalfWidth = METRO_ENTRANCE_HALF_WIDTH_M + 0.6;
        const entranceCenterAlong = (
            METRO_ENTRANCE_START_ALONG_M + METRO_ENTRANCE_END_ALONG_M
        ) * 0.5;
        const entranceHalfDepth = METRO_ENTRANCE_DEPTH_M * 0.5 + 0.6;
        for (const direction of [-1, 1]) {
            const centerRight = direction * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M;
            volumes.push(makeStationClearanceVolume(
                best.segment,
                best.projected,
                centerRight - entranceHalfWidth,
                centerRight + entranceHalfWidth,
                entranceHalfDepth,
                stopId,
                'underground-stair-entrance',
                direction * entranceCenterAlong,
            ));
        }
        const liftPadding = 0.6;
        const liftHalfSize = UNDERGROUND_LIFT_SIZE_M * 0.5 + liftPadding;
        volumes.push(makeStationClearanceVolume(
            best.segment,
            best.projected,
            UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M - liftHalfSize,
            UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M + liftHalfSize,
            liftHalfSize,
            stopId,
            'underground-lift-entrance',
            UNDERGROUND_ACCESS_CORE_ALONG_M,
        ));
    }
    return volumes;
}
