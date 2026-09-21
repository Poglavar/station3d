// Civil structures for planner tracks that leave the ground: viaduct decks +
// pillars under elevated runs (+10 m level) and retaining walls / tunnel tube
// (floor, ceiling, wall lights) along runs below ground (−10 m level).
// Driven purely by the third coordinate ([lng, lat, elevationM]) of the
// planner's otherTracks LineStrings; 2D OSM features are ignored.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { disposeGroup, registerShared } from '../core/dispose.js';
import { ensureRoadIndex, captureRoadIndexRead } from '../core/road-index.js';
import { scene, renderer, camera } from '../scene/setup.js';
import { capturePlannerTrackSegmentsSteps } from '../core/planner-track-segments.js';
import { createPlannerGeometryBudget } from '../core/planner-geometry-budget.js';
import { plannerSegmentWalkHalfWidthM as segmentWalkHalfWidthM, collectSubsurfaceRampCutoutsSteps,
    PLANNER_RAMP_CUTOUT_WIDTH_M,
} from '../core/planner-ground-state.js';
import { prepareIndexedSurfaceGeometrySteps } from '../core/indexed-surface-geometry.js';
import { captureBackedOpeningTrianglesSteps } from '../core/backed-opening-triangles.js';
import { buildEnclosedSpanIndex } from '../core/tunnel-occlusion.js';
import { planTunnelDistanceMarkers } from '../core/tunnel-distance-markers.js';
import { buildTunnelMarkerPlates } from './tunnel-marker-plates.js';
import { createPillarClearanceEvaluatorSteps } from '../core/pillar-clearance.js';
import { createGroundGenerationCoordinator } from '../core/ground-generation-coordinator.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM } from '../core/frame-chunk-queue.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { createSurfaceOpeningReadSteps } from '../core/surface-opening-read.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { preparePlannerCutoutMaskSteps } from './planner-cutout-mask.js';
import { describeStation, UNDERGROUND_STATION_TYPE_ID } from '../core/station-contract.js';
import { compileSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    PLANNER_ELEVATION_PUBLICATION_KEY,
    plannerElevationOpeningClaimInput,
    plannerElevationSurfaceClaimInput,
} from '../core/planner-elevation-publication.js';
import { getTrackCenterSpacingMeters } from './tram-trackbed-dimensions.js';
import {
    clearPlannerSurfaceCutoutMask,
    getPublishedPlannerEntranceCuts,
    setPlannerStructuralSurfaceCutoutMask,
    setPlannerSurfaceCutoutMask,
} from './planner-surface-cutout.js';
import {
    ELEVATED_PLATFORM_LENGTH_M,
    ELEVATED_WALKWAY_RISE_M,
    getPlannerStopLevel,
    getTrackRightVector,
    PLANNER_LEVEL_HEIGHT_M,
    PLANNER_TUNNEL_CLEARANCE_M,
    PLANNER_TUNNEL_FLOOR_WIDTH_M,
    PLANNER_TUNNEL_WALL_CENTER_OFFSET_M,
    PLANNER_TUNNEL_WALL_THICKNESS_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
} from './planner-station-layout.js';
import {
    ELEVATED_EMERGENCY_WALKWAY_WIDTH_M,
    ELEVATED_GUIDEWAY_DECK_THICKNESS_M,
    ELEVATED_GUIDEWAY_RIGHT_EXTENSION_M,
    ELEVATED_WALKWAY_CURB_WIDTH_M,
} from './track-corridors.js';
import {
    getTrackbedHalfWidthMeters,
    TRAM_TRACKBED_SHOULDER_M,
} from './tram-trackbed-dimensions.js';
import { markInspectionLayer } from '../core/scene-inspection.js';

const TRACK_DECK_EDGE_MARGIN_M = 0.3;
const WALKWAY_W = ELEVATED_EMERGENCY_WALKWAY_WIDTH_M;
const WALKWAY_CURB_W = ELEVATED_WALKWAY_CURB_WIDTH_M;
const DECK_RIGHT_EXTENSION_M = ELEVATED_GUIDEWAY_RIGHT_EXTENSION_M;
const WALKWAY_RISE_M = ELEVATED_WALKWAY_RISE_M;
const WALKWAY_SURFACE_T = WALKWAY_RISE_M;
const WALKWAY_CURB_H = WALKWAY_RISE_M + 0.02;
const WALKWAY_CURB_STONE_M = 1.2;
const WALKWAY_CURB_JOINT_GAP_M = 0.025;
const DECK_T = ELEVATED_GUIDEWAY_DECK_THICKNESS_M; // deck top sits at track elevation
const LOW_RAMP_FREE_CLEARANCE_M = 3;
const LOW_RAMP_MAX_TRACK_ELEV_M = DECK_T + LOW_RAMP_FREE_CLEARANCE_M;
// A modern precast/prestressed urban guideway normally carries materially
// longer spans than the former 16 m rhythm. Match the established heavy-rail
// layer's plausible 30 m module and give the shaft a credible pier cap rather
// than terminating a 0.9 m stick directly against the deck soffit.
const PILLAR_W = 1.4;
const PILLAR_DEPTH_M = 1.6;
const PILLAR_SPACING_M = 30;
const PILLAR_CAP_HEIGHT_M = 0.55;
const PILLAR_CAP_DEPTH_M = 1.8;
const PILLAR_MIN_HEIGHT_M = 1.0;
const PILLAR_SLIDE_MAX_M = 20;
const PILLAR_SLIDE_STEP_M = 2;
const RAILING_H = 1.15;
const RAILING_RAIL_T = 0.075;
const RAILING_POST_W = 0.08;
const RAILING_POST_SPACING_M = 2.5;
const STATION_RAIL_GAP_PAD_M = 0.6;
const WALL_OFFSET_M = PLANNER_TUNNEL_WALL_CENTER_OFFSET_M;
const WALL_T = PLANNER_TUNNEL_WALL_THICKNESS_M;
const WALL_TOP_Y = 0.3;        // retaining walls poke just above the street
const TUNNEL_CLEARANCE_M = PLANNER_TUNNEL_CLEARANCE_M;
const CEILING_T = 0.4;
const FLOOR_W = PLANNER_TUNNEL_FLOOR_WIDTH_M;
const FLOOR_T = 0.3;
const TUNNEL_CEILING_BELOW_M = -6; // deeper than this → enclosed tube w/ ceiling
const CHUNK_LEN_M = 15;        // ramps are built from short vertical-walled chunks
const ELEV_EPS = 0.5;
// A run only counts as LEVEL (tunnel roof + portal headwall placement) when it
// is genuinely flat. The old ≤ELEV_EPS test let gentle ramps (≤3.3% over a
// 15 m chunk) qualify once below −6 m, growing an inclined roof that chased
// the ramp almost to the surface with nothing above it.
const LEVEL_RUN_EPS_M = 0.02;
// Distance-marker plates ("345 ▶") ride on the tube walls at this height above
// the walkway floor — at the driver's eye, clear of the trackbed.
const TUNNEL_MARKER_CENTRE_ABOVE_FLOOR_M = 1.9;
// Retaining walls + floor start at the first real depression, not at −0.5 m —
// the ramp's surface cut begins at grade, and the stretch before the old
// threshold was an open hole with neither walls nor floor (raw black void).
const TRENCH_MIN_DEPTH_M = 0.05;
const PLANNER_GROUND_QUERY_CLAIM = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL });
const EMPTY_PLANNER_ARRAY = Object.freeze([]);

let group = null;
let activeSurfaceCutouts = [];
let activeSubsurfaceWalkSegments = [];
let activePlannerState = null;
let surfacePublications = null;
let sessionToken = 0;
let terrainChangeSubscription = null;
let activeSessionArgs = null;
let terrainRevisionDirty = false;
let groundCoordinator = null;
let localGroundCoordinator = null;
let localGroundQueue = null;
let pillarSources = null;

function getElevatedCrossSection(properties = {}) {
    const trackDeckWidth = getTrackbedHalfWidthMeters(properties) * 2
        + TRACK_DECK_EDGE_MARGIN_M * 2;
    return {
        trackDeckWidth,
        walkwayCurbCenterRight: trackDeckWidth * 0.5 + WALKWAY_CURB_W * 0.5,
        railingOuterRight: trackDeckWidth * 0.5 + WALKWAY_CURB_W + WALKWAY_W - 0.10,
    };
}

function pointInsideSurfaceCutoutList(
    cuts,
    localX,
    localZ,
    padding,
    includeSurfaceTrack,
) {
    for (const cut of cuts) {
        if (!includeSurfaceTrack && cut.kind === 'surface-track') continue;
        const dx = cut.x2 - cut.x1;
        const dz = cut.z2 - cut.z1;
        const lengthSq = dx * dx + dz * dz;
        const t = lengthSq > 1e-8
            ? Math.max(0, Math.min(1,
                ((localX - cut.x1) * dx + (localZ - cut.z1) * dz) / lengthSq,
            ))
            : 0;
        const nearestX = cut.x1 + dx * t;
        const nearestZ = cut.z1 + dz * t;
        const radius = cut.widthM * 0.5 + padding;
        if ((localX - nearestX) ** 2 + (localZ - nearestZ) ** 2 <= radius * radius) {
            return true;
        }
    }
    return false;
}

export function isPointInsidePlannerSurfaceCutout(
    localX,
    localZ,
    paddingM = 0,
    { includeSurfaceTrack = true } = {},
) {
    const padding = Number.isFinite(paddingM) ? Math.max(0, paddingM) : 0;
    return (activePlannerState?.openingRead?.contains(localX, 0, localZ, PLANNER_GROUND_QUERY_CLAIM) || false)
        || pointInsideSurfaceCutoutList(
        getPublishedPlannerEntranceCuts(),
        localX,
        localZ,
        padding,
        includeSurfaceTrack,
    );
}

// Lane paint is allowed to continue across a surface tram bed, but it must be
// removed over ramps and station stairwells along with the road beneath it.
// Return the live geometry as read-only-by-convention data so the lane layer
// can also clip its thin meshes on the CPU; the shader mask remains the final
// pixel-accurate edge for every other ground material.
export function getPlannerStructuralSurfaceCutouts() {
    return [...activeSurfaceCutouts, ...getPublishedPlannerEntranceCuts()]
        .filter(cut => cut.kind !== 'surface-track');
}

// Point support reads the same captured physical faces published with the
// planner root. A centreline corridor must not create an invisible floor across
// station gaps, beyond the floor edge, or above a sloping concrete triangle.
const SUPPORT_STEP_UP_M = 1.75;
export function getPlannerSubsurfaceWalkFloorY(localX, localZ, walkerY = null) {
    return activePlannerState?.supportRead?.supportYAt(localX, localZ, {
        maxY: Number.isFinite(walkerY) ? walkerY + SUPPORT_STEP_UP_M : Infinity,
    }) ?? null;
}

function segmentChunks(seg) {
    // Split a segment into manageable pieces for retaining walls and lights.
    // Every floor/ceiling piece is pitched through its endpoint elevations;
    // chunking must never turn the ramp bed into a staircase.
    const n = Math.max(1, Math.ceil(seg.len / CHUNK_LEN_M));
    const chunks = [];
    const ax = Math.sin(seg.angle), az = Math.cos(seg.angle);
    const x1 = seg.cx - ax * seg.len * 0.5;
    const z1 = seg.cz - az * seg.len * 0.5;
    for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const e1 = seg.e1 + (seg.e2 - seg.e1) * t0;
        const e2 = seg.e1 + (seg.e2 - seg.e1) * t1;
        const tm = (t0 + t1) * 0.5;
        chunks.push({
            cx: x1 + ax * seg.len * tm,
            cz: z1 + az * seg.len * tm,
            angle: seg.angle,
            len: seg.len / n,
            e1, e2,
            eMid: (e1 + e2) * 0.5,
        });
    }
    return chunks;
}

function segmentMatchesStopTrack(seg, stopTrackId) {
    if (stopTrackId == null) return true;
    const key = String(stopTrackId);
    return (seg.trackId != null && String(seg.trackId) === key)
        || (seg.trackIds || []).includes(key);
}

function closestPointOnSegment2D(x, z, seg) {
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq > 1e-9
        ? Math.max(0, Math.min(1, ((x - seg.x1) * dx + (z - seg.z1) * dz) / lenSq))
        : 0;
    const px = seg.x1 + dx * t;
    const pz = seg.z1 + dz * t;
    return { x: px, z: pz, distanceSq: (x - px) ** 2 + (z - pz) ** 2 };
}

function mergeIntervals(intervals, minValue, maxValue) {
    const normalized = (intervals || [])
        .map(interval => ({
            start: Math.max(minValue, Math.min(maxValue, interval.start)),
            end: Math.max(minValue, Math.min(maxValue, interval.end)),
        }))
        .filter(interval => interval.end > interval.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of normalized) {
        const previous = merged[merged.length - 1];
        if (previous && interval.start <= previous.end + 0.05) {
            previous.end = Math.max(previous.end, interval.end);
        } else {
            merged.push({ ...interval });
        }
    }
    return merged;
}

function* collectElevatedStationRailGaps(stops, segments, anchorLat, anchorLon, budget) {
    const gapsBySegment = new Map();
    const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
    const SCALE_LON = M_PER_DEG * Math.cos(anchorLat * DEG_TO_RAD);
    for (const stop of stops || []) {
        yield* budget.step('planner-station-gap-stop');
        if (getPlannerStopLevel(stop) !== 1) continue;
        const lng = Number(stop.lng ?? stop.lon);
        const lat = Number(stop.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const x = (lng - anchorLon) * SCALE_LON;
        const z = -(lat - anchorLat) * M_PER_DEG;
        const targetElevM = Number.isFinite(stop.elevM)
            ? stop.elevM
            : PLANNER_LEVEL_HEIGHT_M;
        const stopTrackId = stop?.trackId ?? null;
        const halfGap = ELEVATED_PLATFORM_LENGTH_M * 0.5 + STATION_RAIL_GAP_PAD_M;
        for (const seg of segments) {
            yield* budget.step('planner-station-gap-segment');
            if (!segmentMatchesStopTrack(seg, stopTrackId)) continue;
            if (Math.abs(seg.e1 - targetElevM) > ELEV_EPS ||
                Math.abs(seg.e2 - targetElevM) > ELEV_EPS) continue;
            const dx = seg.x2 - seg.x1;
            const dz = seg.z2 - seg.z1;
            const localLen = Math.hypot(dx, dz);
            if (localLen < 0.1) continue;
            const alongX = dx / localLen;
            const alongZ = dz / localLen;
            const fromStartX = x - seg.x1;
            const fromStartZ = z - seg.z1;
            const projected = fromStartX * alongX + fromStartZ * alongZ;
            const perpendicularSq = Math.max(
                0,
                fromStartX * fromStartX + fromStartZ * fromStartZ - projected * projected,
            );
            if (perpendicularSq >= halfGap * halfGap) continue;
            const reach = Math.sqrt(halfGap * halfGap - perpendicularSq);
            const start = projected - reach;
            const end = projected + reach;
            if (end <= 0 || start >= seg.len) continue;
            let gaps = gapsBySegment.get(seg);
            if (!gaps) {
                gaps = [];
                gapsBySegment.set(seg, gaps);
            }
            gaps.push({ start, end });
        }
    }
    for (const [seg, gaps] of gapsBySegment) {
        yield* budget.step('planner-station-gap-merge');
        gapsBySegment.set(seg, mergeIntervals(gaps, 0, seg.len));
    }
    return gapsBySegment;
}

// The stretch of a segment that stays within one step of a given elevation,
// as distances from the segment's start. Elevation is linear along a segment,
// so this is one interval; a segment that never reaches the level returns null.
function levelSpanAlongSegment(seg, elevationM) {
    const rise = seg.e2 - seg.e1;
    if (Math.abs(rise) < 1e-6) {
        return Math.abs(seg.e1 - elevationM) <= ELEV_EPS
            ? { start: 0, end: seg.len }
            : null;
    }
    const tA = (elevationM - ELEV_EPS - seg.e1) / rise;
    const tB = (elevationM + ELEV_EPS - seg.e1) / rise;
    const tLow = Math.max(0, Math.min(tA, tB));
    const tHigh = Math.min(1, Math.max(tA, tB));
    if (tHigh <= tLow) return null;
    return { start: tLow * seg.len, end: tHigh * seg.len };
}

// The generic planner tunnel is useful between stations, but its narrow walls
// would otherwise run straight through the much wider established metro hall.
// Cut a station-length opening out of the nearby underground track and the
// first metres of its ramps; underground.js fills it with the station shell.
function* collectUndergroundStationStructureGaps(stops, segments, anchorLat, anchorLon, budget) {
    const gapsBySegment = new Map();
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = metersPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    // Leave a deliberate 25 cm overlap between the generic tunnel and the
    // station throat. A positive gap pad previously created the exact open
    // seam through which a walker could fall at the structure boundary.
    const halfGap = UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5 - 0.25;
    for (const stop of stops || []) {
        yield* budget.step('planner-station-gap-stop');
        if (getPlannerStopLevel(stop) !== -1) continue;
        const lng = Number(stop.lng ?? stop.lon);
        const lat = Number(stop.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const x = (lng - anchorLon) * scaleLon;
        const z = -(lat - anchorLat) * metersPerDegree;
        const stopTrackId = stop?.trackId ?? null;
        // Number(null) is 0 and Number.isFinite(0) is true, so the old cast let a
        // station with NO elevation through as a measured 0 m — sea level — and
        // the -PLANNER_LEVEL_HEIGHT_M fallback below it never ran.
        const stationElevM = finiteOrNull(stop.elevM) ?? -PLANNER_LEVEL_HEIGHT_M;
        for (const seg of segments) {
            yield* budget.step('planner-station-gap-segment');
            if (!segmentMatchesStopTrack(seg, stopTrackId)) continue;
            const dx = seg.x2 - seg.x1;
            const dz = seg.z2 - seg.z1;
            const localLen = Math.hypot(dx, dz);
            if (localLen < 0.1) continue;
            const alongX = dx / localLen;
            const alongZ = dz / localLen;
            const fromStartX = x - seg.x1;
            const fromStartZ = z - seg.z1;
            const projected = fromStartX * alongX + fromStartZ * alongZ;
            const perpendicularSq = Math.max(
                0,
                fromStartX * fromStartX + fromStartZ * fromStartZ - projected * projected,
            );
            if (perpendicularSq >= halfGap * halfGap) continue;
            const reach = Math.sqrt(halfGap * halfGap - perpendicularSq);
            // The 170 m shell that fills this gap is built straight and level
            // at the station's own elevation. Anywhere the route climbs away
            // from that — a ramp starting inside the gap radius — nothing
            // replaces the tunnel, so its walls and floor must stay.
            const level = levelSpanAlongSegment(seg, stationElevM);
            if (!level) continue;
            const start = Math.max(projected - reach, level.start);
            const end = Math.min(projected + reach, level.end);
            if (end - start <= 0.05) continue;
            if (end <= 0 || start >= seg.len) continue;
            let gaps = gapsBySegment.get(seg);
            if (!gaps) {
                gaps = [];
                gapsBySegment.set(seg, gaps);
            }
            gaps.push({ start, end });
        }
    }
    for (const [seg, gaps] of gapsBySegment) {
        yield* budget.step('planner-station-gap-merge');
        gapsBySegment.set(seg, mergeIntervals(gaps, 0, seg.len));
    }
    return gapsBySegment;
}

function spansOutsideGaps(length, gaps) {
    const spans = [];
    let cursor = 0;
    for (const gap of gaps || []) {
        if (gap.start > cursor + 0.05) spans.push({ start: cursor, end: gap.start });
        cursor = Math.max(cursor, gap.end);
    }
    if (cursor < length - 0.05) spans.push({ start: cursor, end: length });
    return spans;
}

function segmentSubspan(seg, startDistance, endDistance) {
    const start = Math.max(0, Math.min(seg.len, startDistance));
    const end = Math.max(start, Math.min(seg.len, endDistance));
    const length = end - start;
    if (length <= 0.05) return null;
    const t0 = start / seg.len;
    const t1 = end / seg.len;
    const x1 = seg.x1 + (seg.x2 - seg.x1) * t0;
    const z1 = seg.z1 + (seg.z2 - seg.z1) * t0;
    const x2 = seg.x1 + (seg.x2 - seg.x1) * t1;
    const z2 = seg.z1 + (seg.z2 - seg.z1) * t1;
    const e1 = seg.e1 + (seg.e2 - seg.e1) * t0;
    const e2 = seg.e1 + (seg.e2 - seg.e1) * t1;
    return {
        ...seg,
        x1,
        z1,
        x2,
        z2,
        e1,
        e2,
        len: length,
        cx: (x1 + x2) * 0.5,
        cz: (z1 + z2) * 0.5,
        startJoinX: seg.startJoinX + (seg.endJoinX - seg.startJoinX) * t0,
        startJoinZ: seg.startJoinZ + (seg.endJoinZ - seg.startJoinZ) * t0,
        endJoinX: seg.startJoinX + (seg.endJoinX - seg.startJoinX) * t1,
        endJoinZ: seg.startJoinZ + (seg.endJoinZ - seg.startJoinZ) * t1,
    };
}

function tunnelFloorSpan(seg) {
    if (Math.min(seg.e1, seg.e2) >= 0) return null;
    if (Math.max(seg.e1, seg.e2) <= 0) return seg;
    const crossing = -seg.e1 / (seg.e2 - seg.e1) * seg.len;
    return segmentSubspan(seg, seg.e1 < 0 ? 0 : crossing, seg.e1 < 0 ? crossing : seg.len);
}

function distanceInsideGap(distance, gaps) {
    return (gaps || []).some(gap => distance > gap.start + 0.04 && distance < gap.end - 0.04);
}

function* collectTunnelPortalHeadwalls(segments, budget) {
    const headwalls = [];
    const seen = new Set();
    const endpointMatches = (x, z, candidate) =>
        Math.min(
            Math.hypot(x - candidate.x1, z - candidate.z1),
            Math.hypot(x - candidate.x2, z - candidate.z2),
        ) <= 0.08;
    for (const flat of segments) {
        yield* budget.step('planner-portal-flat');
        // Same LEVEL test as the roof: the headwall must stand exactly where
        // the roof begins. The old ≤ELEV_EPS pair missed gentle ramps entirely
        // (no slab at the portal) while roofing parts of them.
        const isFullUnderground = Math.abs(flat.e2 - flat.e1) <= LEVEL_RUN_EPS_M
            && Math.max(flat.e1, flat.e2) < TUNNEL_CEILING_BELOW_M;
        if (!isFullUnderground) continue;
        for (const endpoint of [
            { x: flat.x1, z: flat.z1, elevation: flat.e1 },
            { x: flat.x2, z: flat.z2, elevation: flat.e2 },
        ]) {
            let meetsRamp = false;
            for (const candidate of segments) {
                yield* budget.step('planner-portal-neighbour');
                if (candidate !== flat && Math.abs(candidate.e2 - candidate.e1) > LEVEL_RUN_EPS_M
                    && Math.min(candidate.e1, candidate.e2) < -ELEV_EPS
                    && endpointMatches(endpoint.x, endpoint.z, candidate)) { meetsRamp = true; break; }
            }
            if (!meetsRamp) continue;
            const key = `${Math.round(endpoint.x * 10)},${Math.round(endpoint.z * 10)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            headwalls.push({ ...endpoint, angle: flat.angle });
        }
    }
    return headwalls;
}

function* makeInstancedBoxes(matrices, material, { castShadow = true, name = '', shadeJitter = 0 } = {}, budget) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
    let handedOff = false;
    try {
    for (let i = 0; i < matrices.length; i++) {
        yield* budget.step('planner-instance-matrix'); mesh.setMatrixAt(i, matrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // A deterministic per-instance lightness jitter makes concrete chunks read
    // like separate pour lots instead of one endless extrusion.
    if (shadeJitter > 0) {
        const color = new THREE.Color();
        for (let i = 0; i < matrices.length; i++) {
            yield* budget.step('planner-instance-colour');
            const hash = Math.sin(i * 12.9898) * 43758.5453;
            const t = hash - Math.floor(hash);
            color.setScalar(1 - shadeJitter * 0.5 + shadeJitter * t);
            mesh.setColorAt(i, color);
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    handedOff = true; return mesh;
    } finally { if (!handedOff) { mesh.dispose(); geo.dispose(); } }
}

// Seeded mottle + speckle canvas shared by every civil-works rebuild in the
// session (registered shared so disposeGroup leaves it alone). Deliberately
// directionless: instanced boxes stretch UVs per face, and any seam/panel
// pattern would visibly change scale between a 15 m straight chunk and a 2 m
// bend chord — noise tolerates that, formwork lines do not.
let concreteTexture = null;
function getConcreteTexture() {
    if (concreteTexture) return concreteTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    let seed = 1337;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    ctx.fillStyle = '#9a9792';
    ctx.fillRect(0, 0, size, size);
    // Broad damp-looking blotches, alternating slightly darker and lighter.
    for (let i = 0; i < 46; i++) {
        const x = rand() * size, y = rand() * size;
        const r = 14 + rand() * 52;
        const dark = i % 2 === 0;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        const tone = dark ? '85, 83, 79' : '181, 178, 172';
        gradient.addColorStop(0, `rgba(${tone}, ${0.05 + rand() * 0.05})`);
        gradient.addColorStop(1, `rgba(${tone}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Fine aggregate speckle and pinholes.
    for (let i = 0; i < 1500; i++) {
        const dark = rand() < 0.6;
        ctx.fillStyle = dark
            ? `rgba(70, 68, 64, ${0.05 + rand() * 0.08})`
            : `rgba(196, 193, 187, ${0.04 + rand() * 0.06})`;
        ctx.fillRect(rand() * size, rand() * size, 1 + rand(), 1 + rand());
    }
    for (let i = 0; i < 220; i++) {
        ctx.fillStyle = `rgba(52, 50, 47, ${0.14 + rand() * 0.1})`;
        ctx.fillRect(rand() * size, rand() * size, 1, 1);
    }
    concreteTexture = new THREE.CanvasTexture(canvas);
    concreteTexture.colorSpace = THREE.SRGBColorSpace;
    registerShared(concreteTexture);
    return concreteTexture;
}

function* resolvePlannerPillarDistance(seg, distance, clearance, budget) {
    if (typeof clearance !== 'function') return distance;
    const ax = Math.sin(seg.angle);
    const az = Math.cos(seg.angle);
    const startX = seg.cx - ax * seg.len * 0.5;
    const startZ = seg.cz - az * seg.len * 0.5;
    const scoreAt = (d) => clearance(startX + ax * d, startZ + az * d);
    if (scoreAt(distance) >= 0) return distance;
    for (let offset = PILLAR_SLIDE_STEP_M; offset <= PILLAR_SLIDE_MAX_M;
        offset += PILLAR_SLIDE_STEP_M) {
        for (const sign of [1, -1]) {
            yield* budget.step('planner-pillar-placement');
            const candidate = distance + offset * sign;
            if (candidate <= 0.25 || candidate >= seg.len - 0.25) continue;
            if (scoreAt(candidate) >= 0) return candidate;
        }
    }
    // The continuous slab can bridge the blocked location; omitting one
    // support is preferable to putting it in a traffic/rail corridor.
    return null;
}

function composeBox(cx, cy, cz, angle, pitch, sx, sy, sz) {
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    if (pitch) {
        quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
    }
    return new THREE.Matrix4().compose(
        new THREE.Vector3(cx, cy, cz),
        quat,
        new THREE.Vector3(sx, sy, sz),
    );
}

function* preparePlannerIndexedGeometry(positions, indices, budget, weldTolerance = null) {
    const packet = yield* prepareIndexedSurfaceGeometrySteps({ positions, indices, weldTolerance, budget,
        maxVertices: budget.limits.maxSegments * 8, maxTriangles: budget.limits.maxSegments * 12 });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(packet.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(packet.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(packet.indices, 1));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...packet.bounds.min), new THREE.Vector3(...packet.bounds.max));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...packet.sphere.center), packet.sphere.radius);
    return geometry;
}

function* buildSweptPrismMesh(segments, material, name, crossSectionForSegment, budget) {
    const positions = [];
    const indices = [];
    const openingFaceOffsets = [];
    for (const seg of segments) {
        yield* budget.step('planner-prism-vertices');
        const crossSection = crossSectionForSegment(seg);
        if (!crossSection) continue;
        const {
            leftOffset,
            rightOffset,
            topOffset = 0,
            thickness,
        } = crossSection;
        if (!(rightOffset > leftOffset) || !(thickness > 0)) continue;
        const startJoin = { x: seg.startJoinX, z: seg.startJoinZ };
        const endJoin = { x: seg.endJoinX, z: seg.endJoinZ };
        const point = (x, z, join, offset, y) => [
            x + join.x * offset,
            y,
            z + join.z * offset,
        ];
        const startTopY = seg.e1 + topOffset;
        const endTopY = seg.e2 + topOffset;
        const vertices = [
            point(seg.x1, seg.z1, startJoin, leftOffset, startTopY - thickness),
            point(seg.x1, seg.z1, startJoin, leftOffset, startTopY),
            point(seg.x1, seg.z1, startJoin, rightOffset, startTopY - thickness),
            point(seg.x1, seg.z1, startJoin, rightOffset, startTopY),
            point(seg.x2, seg.z2, endJoin, leftOffset, endTopY - thickness),
            point(seg.x2, seg.z2, endJoin, leftOffset, endTopY),
            point(seg.x2, seg.z2, endJoin, rightOffset, endTopY - thickness),
            point(seg.x2, seg.z2, endJoin, rightOffset, endTopY),
        ];
        const base = positions.length / 3;
        for (const vertex of vertices) positions.push(...vertex);
        if (crossSection.opensGround) openingFaceOffsets.push(indices.length, indices.length + 3);
        indices.push(
            // top, underside, and both continuous side faces
            base + 1, base + 7, base + 5, base + 1, base + 3, base + 7,
            base + 0, base + 6, base + 2, base + 0, base + 4, base + 6,
            base + 0, base + 5, base + 4, base + 0, base + 1, base + 5,
            base + 2, base + 7, base + 3, base + 2, base + 6, base + 7,
            // end caps keep line ends and station cut boundaries solid
            base + 0, base + 3, base + 1, base + 0, base + 2, base + 3,
            base + 4, base + 7, base + 6, base + 4, base + 5, base + 7,
        );
    }
    if (positions.length === 0) return null;
    const geometry = yield* preparePlannerIndexedGeometry(positions, indices, budget, 1e-4);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.continuousAcrossNodes = true;
    mesh.userData.openingFaceOffsets = openingFaceOffsets;
    return mesh;
}

function lowElevatedRampSpan(seg) {
    const delta = seg.e2 - seg.e1;
    if (Math.abs(delta) <= ELEV_EPS || Math.max(seg.e1, seg.e2) <= 0) return null;
    const crossingSurface = (0 - seg.e1) / delta;
    const crossingClear = (LOW_RAMP_MAX_TRACK_ELEV_M - seg.e1) / delta;
    const tStart = Math.max(0, Math.min(1, Math.min(crossingSurface, crossingClear)));
    const tEnd = Math.max(0, Math.min(1, Math.max(crossingSurface, crossingClear)));
    if ((tEnd - tStart) * seg.len < 0.2) return null;
    return { tStart, tEnd };
}

function* buildLowRampFillMesh(segments, material, budget) {
    const positions = [];
    const indices = [];
    for (const seg of segments) {
        yield* budget.step('planner-fill-vertices');
        const span = lowElevatedRampSpan(seg);
        if (!span) continue;
        const pointAt = (t) => ({
            x: seg.x1 + (seg.x2 - seg.x1) * t,
            z: seg.z1 + (seg.z2 - seg.z1) * t,
            elevation: seg.e1 + (seg.e2 - seg.e1) * t,
        });
        const a = pointAt(span.tStart);
        const b = pointAt(span.tEnd);
        const right = getTrackRightVector(seg.angle);
        const crossSection = getElevatedCrossSection(seg.properties);
        const leftOffset = -crossSection.trackDeckWidth * 0.5;
        const rightOffset = crossSection.trackDeckWidth * 0.5 + DECK_RIGHT_EXTENSION_M;
        const corner = (point, offset, y) => [
            point.x + right.x * offset,
            y,
            point.z + right.z * offset,
        ];
        const aTop = Math.max(0, a.elevation - DECK_T);
        const bTop = Math.max(0, b.elevation - DECK_T);
        if (Math.max(aTop, bTop) < 0.02) continue;
        const vertices = [
            corner(a, leftOffset, 0),
            corner(a, rightOffset, 0),
            corner(b, rightOffset, 0),
            corner(b, leftOffset, 0),
            corner(a, leftOffset, aTop),
            corner(a, rightOffset, aTop),
            corner(b, rightOffset, bTop),
            corner(b, leftOffset, bTop),
        ];
        const base = positions.length / 3;
        for (const vertex of vertices) positions.push(...vertex);
        indices.push(
            base + 0, base + 2, base + 1, base + 0, base + 3, base + 2,
            base + 4, base + 5, base + 6, base + 4, base + 6, base + 7,
            base + 0, base + 1, base + 5, base + 0, base + 5, base + 4,
            base + 3, base + 7, base + 6, base + 3, base + 6, base + 2,
            base + 0, base + 4, base + 7, base + 0, base + 7, base + 3,
            base + 1, base + 2, base + 6, base + 1, base + 6, base + 5,
        );
    }
    if (positions.length === 0) return null;
    const geometry = yield* preparePlannerIndexedGeometry(positions, indices, budget);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'PlannerLowRampFill';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function* buildPlannerGeometrySteps(features, anchorLat, anchorLon, preparedSegments = null, stops = [], options = {}) {
    const budget = createPlannerGeometryBudget(options.preparation);
    budget.take('maxStops', stops.length);
    const materials = new Set();
    const ownMaterial = material => { materials.add(material); return material; };
    const box = (...args) => { budget.take('maxBoxes'); return composeBox(...args); };
    const g = new THREE.Group();
    let handedOff = false;
    try {
    g.name = 'PlannerElevationStructures';
    g.userData.enclosedTunnelSpans = [];
    g.userData.plannerOpeningRegions = [];
    const allSegments = preparedSegments || (yield* capturePlannerTrackSegmentsSteps(features, anchorLat, anchorLon, options.preparation));
    // Visible structures only where this layer owns them. A terrain world's
    // authored-grade track gets its cut/fill/tunnel/viaduct from
    // RailFormationModel; its segments are still carried (converted) for the
    // walk-support lookups, but building them here would double the civil works.
    const segments = [];
    for (const seg of allSegments) {
        yield* budget.step('planner-owned-segments');
        if (seg.structuresBuiltElsewhere) continue;
        budget.take('maxSegments'); budget.take('maxRouteMeters', seg.len); segments.push(seg);
    }
    if (segments.length === 0) { handedOff = true; return g; }
    const elevatedStationRailGaps = yield* collectElevatedStationRailGaps(
        stops,
        segments,
        anchorLat,
        anchorLon, budget,
    );
    const undergroundStationStructureGaps = yield* collectUndergroundStationStructureGaps(
        stops,
        segments,
        anchorLat,
        anchorLon, budget,
    );
    const includePillars = options.includePillars !== false;
    const pillarClearance = options.pillarClearance || null;
    const pillarDedupe = new Set();

    const walkwayCurbMatrices = [];
    const railingRailMatrices = [];
    const railingPostMatrices = [];
    const pillarMatrices = [];
    const pillarCapMatrices = [];
    const wallMatrices = [];
    const tunnelWallMatrices = [];   // roofed-run walls: self-lit material (no sun)
    // Enclosed (roofed) chunks, in route order, so the cab can tell when the
    // observer is sealed inside a tube and how far the portal is — see
    // core/tunnel-occlusion.js. Rebuilt with the geometry it describes.
    const enclosedChunkRecords = [];
    let enclosedChainageM = 0;
    const ceilingMatrices = [];
    const floorSegments = [];
    const tunnelFloorSegments = [];  // roofed-run floors: self-lit material
    const lightMatrices = [];
    const portalHeadwallMatrices = [];

    for (const portal of yield* collectTunnelPortalHeadwalls(segments, budget)) {
        yield* budget.step('planner-portal-box');
        const ceilingTopY = portal.elevation + TUNNEL_CLEARANCE_M + CEILING_T;
        const height = WALL_TOP_Y - ceilingTopY;
        if (height <= 0.2) continue;
        portalHeadwallMatrices.push(box(
            portal.x,
            ceilingTopY + height * 0.5,
            portal.z,
            portal.angle,
            0,
            FLOOR_W + WALL_T * 2,
            height,
            WALL_T + 0.15,
        ));
    }

    for (const seg of segments) {
        yield* budget.step('planner-segment');
        const pitch = -Math.atan2(seg.e2 - seg.e1, seg.len);
        const crossSection = getElevatedCrossSection(seg.properties);

        // ── The deck and walkway are built below as welded swept prisms.
        // Their common mitered node sections eliminate triangular light leaks
        // and the per-box shading seams that used to mark every planner node.
        if (Math.max(seg.e1, seg.e2) > ELEV_EPS) {
            const right = getTrackRightVector(seg.angle);

            const ax = Math.sin(seg.angle), az = Math.cos(seg.angle);
            const x1 = seg.cx - ax * seg.len * 0.5;
            const z1 = seg.cz - az * seg.len * 0.5;
            const railGaps = elevatedStationRailGaps.get(seg) || [];
            for (const span of spansOutsideGaps(seg.len, railGaps)) {
                const spanLen = span.end - span.start;
                const midD = (span.start + span.end) * 0.5;
                const tStart = span.start / seg.len;
                const tEnd = span.end / seg.len;
                const spanE1 = seg.e1 + (seg.e2 - seg.e1) * tStart;
                const spanE2 = seg.e1 + (seg.e2 - seg.e1) * tEnd;
                const spanEMid = (spanE1 + spanE2) * 0.5;
                const spanSlopeLen = Math.hypot(spanLen, spanE2 - spanE1);
                // Separate curb stones, with real gaps at the joints, read
                // like the standard road curb without sharing a coplanar top
                // face with the walkway (the old full-length overlay fought).
                for (let stoneStart = span.start; stoneStart < span.end - 0.01;
                    stoneStart += WALKWAY_CURB_STONE_M) {
                    yield* budget.step('planner-walkway-curb');
                    const stoneEnd = Math.min(span.end, stoneStart + WALKWAY_CURB_STONE_M);
                    const renderStart = stoneStart + WALKWAY_CURB_JOINT_GAP_M * 0.5;
                    const renderEnd = stoneEnd - WALKWAY_CURB_JOINT_GAP_M * 0.5;
                    if (renderEnd <= renderStart + 0.02) continue;
                    const stoneMidD = (renderStart + renderEnd) * 0.5;
                    const stoneTStart = renderStart / seg.len;
                    const stoneTEnd = renderEnd / seg.len;
                    const stoneE1 = seg.e1 + (seg.e2 - seg.e1) * stoneTStart;
                    const stoneE2 = seg.e1 + (seg.e2 - seg.e1) * stoneTEnd;
                    const stoneEMid = (stoneE1 + stoneE2) * 0.5;
                    const stoneSlopeLen = Math.hypot(renderEnd - renderStart, stoneE2 - stoneE1);
                    walkwayCurbMatrices.push(box(
                        x1 + ax * stoneMidD + right.x * crossSection.walkwayCurbCenterRight,
                        stoneEMid + WALKWAY_CURB_H * 0.5,
                        z1 + az * stoneMidD + right.z * crossSection.walkwayCurbCenterRight,
                        seg.angle, pitch,
                        WALKWAY_CURB_W, WALKWAY_CURB_H, stoneSlopeLen,
                    ));
                }
                for (const railY of [RAILING_H * 0.52, RAILING_H]) {
                    railingRailMatrices.push(box(
                        x1 + ax * midD + right.x * crossSection.railingOuterRight,
                        spanEMid + WALKWAY_RISE_M + railY,
                        z1 + az * midD + right.z * crossSection.railingOuterRight,
                        seg.angle, pitch,
                        RAILING_RAIL_T, RAILING_RAIL_T, spanSlopeLen + 0.28,
                    ));
                }
            }

            const postDistances = [0, seg.len];
            for (let d = RAILING_POST_SPACING_M; d < seg.len; d += RAILING_POST_SPACING_M) {
                yield* budget.step('planner-post-distance');
                postDistances.push(d);
            }
            for (const gap of railGaps) postDistances.push(gap.start, gap.end);
            postDistances.sort((a, b) => a - b);
            let previousPostD = -Infinity;
            for (const d of postDistances) {
                yield* budget.step('planner-railing-post');
                if (d - previousPostD < 0.04 || distanceInsideGap(d, railGaps)) continue;
                previousPostD = d;
                const t = seg.len > 0 ? d / seg.len : 0;
                const e = seg.e1 + (seg.e2 - seg.e1) * t;
                railingPostMatrices.push(box(
                    x1 + ax * d + right.x * crossSection.railingOuterRight,
                    e + WALKWAY_RISE_M + RAILING_H * 0.5,
                    z1 + az * d + right.z * crossSection.railingOuterRight,
                    seg.angle, 0,
                    RAILING_POST_W, RAILING_H, RAILING_POST_W,
                ));
            }
        }

        const undergroundGaps = undergroundStationStructureGaps.get(seg) || [];
        for (const span of spansOutsideGaps(seg.len, undergroundGaps)) {
            const structureSpan = segmentSubspan(seg, span.start, span.end);
            if (!structureSpan) continue;
            const floorSpan = tunnelFloorSpan(structureSpan);
            if (floorSpan) {
                const roofed = Math.abs(floorSpan.e2 - floorSpan.e1) <= LEVEL_RUN_EPS_M
                    && (floorSpan.e1 + floorSpan.e2) * .5 < TUNNEL_CEILING_BELOW_M;
                (roofed ? tunnelFloorSegments : floorSegments).push(floorSpan);
            }
            for (const chunk of segmentChunks(structureSpan)) {
                yield* budget.step('planner-tunnel-chunk');
                // Route-order chainage, accumulated over EVERY chunk (not just the
                // enclosed ones) so a surfaced stretch between two tubes shows up as
                // a chainage gap and the two are not merged into one span.
                const chunkChainageM = enclosedChainageM + chunk.len / 2;
                enclosedChainageM += chunk.len;
                // ── Trench / tunnel below ground
                if (chunk.eMid < -TRENCH_MIN_DEPTH_M) {
                    const chunkPitch = -Math.atan2(chunk.e2 - chunk.e1, chunk.len);
                    const chunkSlopeLen = Math.hypot(chunk.len, chunk.e2 - chunk.e1);
                    // The complete descending/ascending ramp is an open cut,
                    // even once it is deep. A roof begins only on genuinely
                    // LEVEL runs below the enclosure depth (the -1 plateau).
                    const isRoofedRun = Math.abs(chunk.e2 - chunk.e1) <= LEVEL_RUN_EPS_M
                        && chunk.eMid < TUNNEL_CEILING_BELOW_M;
                    // Open trenches carry their coping 0.3 m above the street;
                    // roofed runs must stop at the roof slab, or the wall tops
                    // draw two parallel lines on the untouched surface above.
                    const wallTopY = isRoofedRun
                        ? chunk.eMid + TUNNEL_CLEARANCE_M + CEILING_T
                        : WALL_TOP_Y;
                    const wallBottom = chunk.eMid - FLOOR_T;
                    const wallHeight = wallTopY - wallBottom;
                    const px = Math.cos(chunk.angle);
                    const pz = -Math.sin(chunk.angle);
                    // Enclosed interiors go to the self-lit material set: the
                    // scene sun lit whichever wall faced it (shadow coverage
                    // varies), painting one tunnel wall light and the other
                    // near-black inside a symmetric tube.
                    if (isRoofedRun) {
                        enclosedChunkRecords.push({
                            x: chunk.cx,
                            z: chunk.cz,
                            chainageM: chunkChainageM,
                            lengthM: chunk.len,
                        });
                    }
                    const wallSink = isRoofedRun ? tunnelWallMatrices : wallMatrices;
                    for (const side of [-1, 1]) {
                        wallSink.push(box(
                            chunk.cx + px * WALL_OFFSET_M * side,
                            wallBottom + wallHeight / 2,
                            chunk.cz + pz * WALL_OFFSET_M * side,
                            chunk.angle, 0,
                            WALL_T, wallHeight, chunk.len + 0.3,
                        ));
                    }
                    // The floor foundation follows the same joined polygon
                    // as the opening, including beneath the retaining walls.
                    // Pitched chord boxes left the cut's outer 5 cm unbacked
                    // and did not meet at a bend's civil miter.
                    if (isRoofedRun) {
                        const ceilingY = chunk.eMid + TUNNEL_CLEARANCE_M;
                        // The slab overhangs the wall OUTER faces: flush edges
                        // (old width = exactly the wall outline) left a
                        // coplanar seam the sun's shadow map sliced through at
                        // grazing angles — a lit band near the top of one wall
                        // inside an otherwise symmetric tube. The lip is
                        // underground and invisible from above.
                        ceilingMatrices.push(box(
                            chunk.cx, ceilingY + CEILING_T / 2, chunk.cz,
                            chunk.angle, chunkPitch,
                            FLOOR_W + WALL_T * 2 + 0.6, CEILING_T, chunkSlopeLen + 0.3,
                        ));
                        // Ceiling lights are placed in a separate route-rhythm
                        // pass below — one per chunk turned bends (many short
                        // smoothing chords) into a continuous strip.
                    }
                }
            }
        }

    }

    const segmentsByFeature = new Map();
    for (const seg of segments) {
        yield* budget.step('planner-segment');
        const list = segmentsByFeature.get(seg.featureIndex) || [];
        list.push(seg);
        segmentsByFeature.set(seg.featureIndex, list);
    }

    // Tunnel ceiling lights: discrete fixtures on one continuous route rhythm
    // per feature, exactly like the pillar rhythm below. Emitting one per
    // geometry chunk made bends — many short smoothing chords — read as an
    // unbroken light strip while straights kept discrete 15 m fixtures.
    const LIGHT_SPACING_M = 15;
    for (const featureSegments of segmentsByFeature.values()) {
        yield* budget.step('planner-feature');
        featureSegments.sort((a, b) => a.routeStartM - b.routeStartM);
        const totalLength = Math.max(...featureSegments.map(seg => seg.routeStartM + seg.len));
        for (let routeDistance = LIGHT_SPACING_M * 0.5;
            routeDistance < totalLength;
            routeDistance += LIGHT_SPACING_M) {
            yield* budget.step('planner-tunnel-light');
            const seg = featureSegments.find(candidate =>
                routeDistance >= candidate.routeStartM - 1e-6
                && routeDistance <= candidate.routeStartM + candidate.len + 1e-6);
            if (!seg || seg.len <= 0) continue;
            const segDistance = Math.max(0, Math.min(seg.len, routeDistance - seg.routeStartM));
            if (distanceInsideGap(segDistance, undergroundStationStructureGaps.get(seg) || [])) continue;
            // A fixture needs a roof over it: replicate the chunk loop's
            // ceiling predicate (genuinely level and below the enclosure depth).
            const chunkLen = seg.len / Math.ceil(seg.len / CHUNK_LEN_M);
            if (Math.abs(seg.e2 - seg.e1) * (chunkLen / seg.len) > LEVEL_RUN_EPS_M) continue;
            const t = segDistance / seg.len;
            const elevation = seg.e1 + (seg.e2 - seg.e1) * t;
            if (elevation >= TUNNEL_CEILING_BELOW_M) continue;
            const ax = Math.sin(seg.angle), az = Math.cos(seg.angle);
            lightMatrices.push(box(
                seg.cx + ax * (segDistance - seg.len * 0.5),
                elevation + TUNNEL_CLEARANCE_M - 0.08,
                seg.cz + az * (segDistance - seg.len * 0.5),
                seg.angle, 0,
                0.3, 0.1, 1.4,
            ));
        }
    }

    // ── Tunnel distance markers ────────────────────────────────────────────
    // Plates on the tube walls showing the remaining metres to the portal the
    // countdown runs toward: right wall (direction of increasing chainage)
    // counts down to the far portal, left wall to the near one. Placed on the
    // same fixed 50 m route grid as the lights, so a 395 m tube reads
    // 345, 295, 245, ... — the planner picks the values, this pass only finds
    // WHERE the tube walls are. Station interiors are skipped: the hall owns
    // its walls there (same exclusion as the ceiling fixtures).
    for (const featureSegments of segmentsByFeature.values()) {
        yield* budget.step('planner-feature');
        featureSegments.sort((a, b) => a.routeStartM - b.routeStartM);
        const totalLength = Math.max(...featureSegments.map(seg => seg.routeStartM + seg.len));
        const segAt = (routeDistance) => featureSegments.find(candidate =>
            routeDistance >= candidate.routeStartM - 1e-6
            && routeDistance <= candidate.routeStartM + candidate.len + 1e-6);
        // An enclosed position = genuinely level and below the enclosure depth
        // — the ceiling-fixture predicate, sampled finely enough that spans end
        // within a couple of metres of the real portals.
        const enclosedAt = (routeDistance) => {
            const seg = segAt(routeDistance);
            if (!seg || seg.len <= 0) return false;
            const chunkLen = seg.len / Math.ceil(seg.len / CHUNK_LEN_M);
            if (Math.abs(seg.e2 - seg.e1) * (chunkLen / seg.len) > LEVEL_RUN_EPS_M) return false;
            const segDistance = Math.max(0, Math.min(seg.len, routeDistance - seg.routeStartM));
            const t = segDistance / seg.len;
            const elevation = seg.e1 + (seg.e2 - seg.e1) * t;
            return elevation < TUNNEL_CEILING_BELOW_M;
        };
        const SAMPLE_M = 2.5;
        const spans = [];
        let spanStart = null;
        for (let d = 0; d <= totalLength + SAMPLE_M * 0.5; d += SAMPLE_M) {
            yield* budget.step('planner-tunnel-span');
            const enclosed = d <= totalLength && enclosedAt(d);
            if (enclosed && spanStart == null) spanStart = d;
            if (!enclosed && spanStart != null) {
                spans.push({ startM: spanStart, endM: d });
                spanStart = null;
            }
        }
        if (spans.length === 0) continue;
        const markers = [];
        for (const plan of planTunnelDistanceMarkers(spans)) {
            yield* budget.step('planner-tunnel-marker');
            if (!enclosedAt(plan.chainageM)) continue;   // sampling edge — skip
            const seg = segAt(plan.chainageM);
            if (!seg || seg.len <= 0) continue;
            const segDistance = Math.max(0, Math.min(seg.len, plan.chainageM - seg.routeStartM));
            if (distanceInsideGap(segDistance, undergroundStationStructureGaps.get(seg) || [])) continue;
            const t = segDistance / seg.len;
            const elevation = seg.e1 + (seg.e2 - seg.e1) * t;
            const ax = Math.sin(seg.angle), az = Math.cos(seg.angle);
            const x = seg.cx + ax * (segDistance - seg.len * 0.5);
            const z = seg.cz + az * (segDistance - seg.len * 0.5);
            // (px,pz)=(cos,−sin) is the LEFT of travel in this basis; the
            // driver's right wall is the negative side. Inset 3 cm off the
            // wall's inner face so the plate never z-fights the wall boxes.
            // Text runs toward the reader's right (plate U); the chevron at
            // its −U end points along the countdown — see tunnel-marker-plates.
            const rx = -Math.cos(seg.angle), rz = Math.sin(seg.angle);
            const faceOffset = WALL_OFFSET_M - WALL_T / 2 - 0.03;
            const floorY = elevation - 0.05;
            const y = floorY + TUNNEL_MARKER_CENTRE_ABOVE_FLOOR_M;
            if (plan.rightM != null) {
                markers.push({
                    x: x + rx * faceOffset, y, z: z + rz * faceOffset,
                    dirX: -ax, dirZ: -az,                    // right wall: text runs −chainage
                    text: plan.rightM,
                });
            }
            if (plan.leftM != null) {
                markers.push({
                    x: x - rx * faceOffset, y, z: z - rz * faceOffset,
                    dirX: ax, dirZ: az,                      // left wall: text runs +chainage
                    text: plan.leftM,
                });
            }
        }
        budget.take('maxMarkers', markers.length);
        for (let start = 0; start < markers.length; start += 32) {
            yield { phase: 'planner-marker-atlas' }; budget.check();
            for (const mesh of buildTunnelMarkerPlates(markers.slice(start, start + 32))) g.add(mesh);
        }
    }

    // Sample one continuous 30 m support rhythm per planner feature. Sampling
    // each tiny smoothing chord independently either produced a forest of
    // columns or none at all when the chord was shorter than the spacing.
    if (includePillars) {
        for (const featureSegments of segmentsByFeature.values()) {
        yield* budget.step('planner-feature');
            featureSegments.sort((a, b) => a.routeStartM - b.routeStartM);
            const totalLength = Math.max(...featureSegments.map(seg => seg.routeStartM + seg.len));
            for (let routeDistance = PILLAR_SPACING_M * 0.5;
                routeDistance < totalLength;
                routeDistance += PILLAR_SPACING_M) {
                yield* budget.step('planner-pillar');
                const seg = featureSegments.find(candidate =>
                    routeDistance >= candidate.routeStartM - 1e-6
                    && routeDistance <= candidate.routeStartM + candidate.len + 1e-6);
                if (!seg || Math.max(seg.e1, seg.e2) <= ELEV_EPS) continue;
                const requestedDistance = Math.max(0, Math.min(seg.len, routeDistance - seg.routeStartM));
                const resolvedDistance = yield* resolvePlannerPillarDistance(
                    seg,
                    requestedDistance,
                    pillarClearance, budget,
                );
                if (resolvedDistance == null) continue;
                const t = seg.len > 0 ? resolvedDistance / seg.len : 0;
                const elevation = seg.e1 + (seg.e2 - seg.e1) * t;
                const availableHeight = elevation - DECK_T;
                if (availableHeight < PILLAR_MIN_HEIGHT_M
                    || availableHeight <= LOW_RAMP_FREE_CLEARANCE_M) continue;
                const shaftHeight = availableHeight - PILLAR_CAP_HEIGHT_M;
                if (shaftHeight <= 0.25) continue;
                const ax = Math.sin(seg.angle);
                const az = Math.cos(seg.angle);
                const startX = seg.cx - ax * seg.len * 0.5;
                const startZ = seg.cz - az * seg.len * 0.5;
                const pillarX = startX + ax * resolvedDistance;
                const pillarZ = startZ + az * resolvedDistance;
                const pillarKey = `${Math.round(pillarX * 2)},${Math.round(pillarZ * 2)}`;
                if (pillarDedupe.has(pillarKey)) continue;
                pillarDedupe.add(pillarKey);
                pillarMatrices.push(box(
                    pillarX,
                    shaftHeight * 0.5,
                    pillarZ,
                    seg.angle,
                    0,
                    PILLAR_W,
                    shaftHeight,
                    PILLAR_DEPTH_M,
                ));
                const crossSection = getElevatedCrossSection(seg.properties);
                const capWidth = Math.max(
                    PILLAR_W + 0.4,
                    Math.min(crossSection.trackDeckWidth - 0.4, 5.8),
                );
                pillarCapMatrices.push(box(
                    pillarX,
                    elevation - DECK_T - PILLAR_CAP_HEIGHT_M * 0.5,
                    pillarZ,
                    seg.angle,
                    0,
                    capWidth,
                    PILLAR_CAP_HEIGHT_M,
                    PILLAR_CAP_DEPTH_M,
                ));
            }
        }
    }

    const deckMat = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85 }));
    const walkwayMat = ownMaterial(new THREE.MeshStandardMaterial({ color: 0xc4c7c9, roughness: 0.94 }));
    const walkwayCurbMat = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x9b9992, roughness: 0.96 }));
    const lowRampFillMat = ownMaterial(new THREE.MeshStandardMaterial({
        color: 0x858a90,
        roughness: 0.96,
        side: THREE.DoubleSide,
    }));
    const railingMat = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x626a73, roughness: 0.58, metalness: 0.35 }));
    const pillarMat = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x8d939a, roughness: 0.9 }));
    // Retaining-wall coping and tunnel floor were reading like blue puddles
    // under grazing street lights. Dry concrete has no sharp specular lobe;
    // Lambert materials preserve scene shading without the wet highlight.
    // The mottle map + per-instance shade jitter give the flat boxes a raw
    // in-situ concrete read; colors are retuned so map × color lands on the
    // previous tones.
    const wallMat = ownMaterial(new THREE.MeshLambertMaterial({
        color: 0xa19e99, map: getConcreteTexture(), side: THREE.DoubleSide,
    }));
    const shellMat = ownMaterial(new THREE.MeshLambertMaterial({
        color: 0x797976, map: getConcreteTexture(), side: THREE.DoubleSide,
    }));
    // Enclosed tunnel interiors must not respond to the sun at all — the
    // directional light lit whichever wall faced it (shadow-map coverage
    // varies along the route), painting one wall light grey and the other
    // near-black inside a symmetric tube. MeshBasic renders a constant dim
    // self-lit tone; the concrete map and per-chunk shade jitter still apply.
    const tunnelWallMat = ownMaterial(new THREE.MeshBasicMaterial({
        color: 0x6a6660, map: getConcreteTexture(), side: THREE.DoubleSide,
    }));
    const tunnelShellMat = ownMaterial(new THREE.MeshBasicMaterial({
        color: 0x565553, map: getConcreteTexture(), side: THREE.DoubleSide,
    }));
    const lightMat = ownMaterial(new THREE.MeshStandardMaterial({
        color: 0xfff7d6,
        emissive: 0xfff2c4,
        emissiveIntensity: 1.4,
    }));

    const elevatedSegments = segments.filter(seg => Math.max(seg.e1, seg.e2) > ELEV_EPS);
    const lowRampFillMesh = yield* buildLowRampFillMesh(segments, lowRampFillMat, budget);
    if (lowRampFillMesh) g.add(lowRampFillMesh);
    const deckMesh = yield* buildSweptPrismMesh(
        elevatedSegments,
        deckMat,
        'PlannerViaductDeck',
        seg => {
            const crossSection = getElevatedCrossSection(seg.properties);
            return {
                leftOffset: -crossSection.trackDeckWidth * 0.5,
                rightOffset: crossSection.trackDeckWidth * 0.5 + DECK_RIGHT_EXTENSION_M,
                topOffset: 0,
                thickness: DECK_T,
            };
        }, budget,
    );
    if (deckMesh) g.add(deckMesh);
    const walkwayMesh = yield* buildSweptPrismMesh(
        elevatedSegments,
        walkwayMat,
        'PlannerEmergencyWalkway',
        seg => {
            const crossSection = getElevatedCrossSection(seg.properties);
            return {
                leftOffset: crossSection.trackDeckWidth * 0.5 + WALKWAY_CURB_W,
                rightOffset: crossSection.trackDeckWidth * 0.5 + WALKWAY_CURB_W + WALKWAY_W,
                topOffset: WALKWAY_RISE_M,
                thickness: WALKWAY_SURFACE_T,
            };
        }, budget,
    );
    if (walkwayMesh) g.add(walkwayMesh);
    if (walkwayCurbMatrices.length) g.add(yield* makeInstancedBoxes(walkwayCurbMatrices, walkwayCurbMat, { name: 'PlannerWalkwayCurbs' }, budget));
    if (railingRailMatrices.length) g.add(yield* makeInstancedBoxes(railingRailMatrices, railingMat, { name: 'PlannerWalkwayRails' }, budget));
    if (railingPostMatrices.length) g.add(yield* makeInstancedBoxes(railingPostMatrices, railingMat, { name: 'PlannerWalkwayRailPosts' }, budget));
    if (pillarMatrices.length) g.add(yield* makeInstancedBoxes(pillarMatrices, pillarMat, { name: 'PlannerViaductPillars' }, budget));
    if (pillarCapMatrices.length) g.add(yield* makeInstancedBoxes(pillarCapMatrices, pillarMat, { name: 'PlannerViaductPierCaps' }, budget));
    if (wallMatrices.length) g.add(yield* makeInstancedBoxes(wallMatrices, wallMat, { castShadow: false, name: 'PlannerTrenchWalls', shadeJitter: 0.1 }, budget));
    if (tunnelWallMatrices.length) g.add(yield* makeInstancedBoxes(tunnelWallMatrices, tunnelWallMat, { castShadow: false, name: 'PlannerTunnelInteriorWalls', shadeJitter: 0.1 }, budget));
    // A closed tunnel roof has to occlude the sun shadow map as well as the
    // colour pass. Otherwise surface cars remain invisible but project their
    // shadows through the roof onto the underground trackbed. (castShadow
    // stays on even though the slab itself is self-lit.)
    if (ceilingMatrices.length) g.add(yield* makeInstancedBoxes(ceilingMatrices, tunnelShellMat, { name: 'PlannerTunnelCeilings', shadeJitter: 0.08 }, budget));
    for (const [parts, sourceMaterial, name] of [[floorSegments, shellMat, 'PlannerTunnelFloors'],
        [tunnelFloorSegments, tunnelShellMat, 'PlannerTunnelInteriorFloors']]) {
        if (!parts.length) continue;
        const material = ownMaterial(sourceMaterial.clone());
        // Keep the shared wall bitmap unchanged. A floor's own sampler tiles
        // it in world metres instead of stretching it along the entire route.
        if (sourceMaterial.map) {
            material.map = sourceMaterial.map.clone();
            material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping;
            material.map.needsUpdate = true;
            g.userData.disposables ||= []; g.userData.disposables.push(material.map);
        }
        const floor = yield* buildSweptPrismMesh(parts, material, name, seg => ({
            leftOffset: -PLANNER_RAMP_CUTOUT_WIDTH_M * .5,
            rightOffset: PLANNER_RAMP_CUTOUT_WIDTH_M * .5,
            topOffset: -.05, thickness: FLOOR_T,
            // Level tubes retain their surface roof. Only the actual open
            // ramp floor supplies this producer's excavation boundary.
            opensGround: Math.abs(seg.e2 - seg.e1) > LEVEL_RUN_EPS_M,
        }), budget);
        if (!floor) continue;
        g.add(floor); floor.castShadow = false;
        const positions = floor.geometry.getAttribute('position'), uv = new Float32Array(positions.count * 2);
        for (let i = 0; i < positions.count; i++) {
            yield* budget.step('planner-floor-uv');
            uv[i * 2] = positions.getX(i) / 15; uv[i * 2 + 1] = positions.getZ(i) / 15;
        }
        floor.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        const openings = yield* captureBackedOpeningTrianglesSteps({ positions: positions.array,
            indices: floor.geometry.index.array, faceOffsets: floor.userData.openingFaceOffsets,
            kind: 'ramp', replacementKey: PLANNER_ELEVATION_PUBLICATION_KEY, maxY: 1, budget });
        for (const region of openings) {
            yield* budget.step('planner-opening-collect'); g.userData.plannerOpeningRegions.push(region);
        }
    }
    if (portalHeadwallMatrices.length) g.add(yield* makeInstancedBoxes(portalHeadwallMatrices, wallMat, { name: 'PlannerTunnelPortalHeadwalls', shadeJitter: 0.1 }, budget));
    if (lightMatrices.length) g.add(yield* makeInstancedBoxes(lightMatrices, lightMat, { castShadow: false, name: 'PlannerTunnelLights' }, budget));

    // Keep CPU tunnel state on the detached candidate. It becomes live only in
    // the same publication commit as the geometry it describes.
    g.userData.enclosedTunnelSpans = buildEnclosedSpanIndex(enclosedChunkRecords);
    g.userData.plannerOpeningRegions = Object.freeze(g.userData.plannerOpeningRegions);

    handedOff = true; return g;
    } finally {
        const used = new Set();
        const instances = [];
        g.traverse(object => { for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material) used.add(material);
        } if (object.isInstancedMesh) instances.push(object); });
        // Three owns instance attributes on the object, outside its geometry.
        // Retiring the root must release those attributes as well.
        g.userData.disposables = [...(g.userData.disposables || []), ...instances];
        if (!handedOff) disposeGroup(g);
        for (const material of materials) if (!used.has(material)) material.dispose();
    }
}

function annotatePlannerElevationPublication(root, { generation, cuts = [] } = {}) {
    root.userData.surfaceCutoutCount = cuts.length;
    root.userData.surfaceCutoutKinds = cuts.map(cut => cut.kind);
    markInspectionLayer(root, {
        id: 'planner-elevation-container',
        label: 'Planner civil renderer',
        category: 'Civil works',
        source: 'world/planner-elevation.js',
        order: 160,
        containerOnly: true,
    });
    root.traverse((object) => {
        if (!object?.isMesh) return;
        const name = String(object.name || 'Planner structure');
        const spec = /LowRampFill|earth|slope|collar/i.test(name)
            ? ['planner-earthworks', 'Planner rail earthworks', 161]
            : /Viaduct|Deck|Pillar|Parapet/i.test(name)
                ? ['planner-viaducts', 'Planner viaduct structures', 162]
                : /Tunnel|Retaining|Wall|Floor|Ceiling|Portal/i.test(name)
                    ? ['planner-tunnels', 'Planner tunnels and retaining walls', 163]
                    : /Walkway|Curb/i.test(name)
                        ? ['planner-walkways', 'Planner emergency walkways', 164]
                        : ['planner-structures-other', 'Other planner structures', 165];
        markInspectionLayer(object, {
            id: spec[0],
            label: spec[1],
            category: 'Civil works',
            source: `world/planner-elevation.js · ${name}`,
            order: spec[2],
        });
        markSurfaceClaim(object, plannerElevationSurfaceClaimInput(name, generation));
    });
}

// Walk mode raycasts this group so the player can land on viaduct decks.
// Enclosed-tunnel spans from the most recent build, for the surface-suspension
// decision. Empty until plannerElevationLayer has built (and empty in the photo
// world, which suspends its own source instead).
let enclosedTunnelSpans = [];
export function getEnclosedTunnelSpans() {
    return enclosedTunnelSpans;
}

export function getPlannerElevationGroup() {
    return group;
}

function emptyPlannerState(generation = 0) {
    return {
        generation,
        surfaceCutouts: [],
        walkSegments: [],
        enclosedSpans: [],
        openingClaim: null,
        surfaceMask: null,
        structuralMask: null,
    };
}

function plannerStateTextures(state) {
    return new Set([
        state?.surfaceMask?.texture,
        state?.structuralMask?.texture,
    ].filter(Boolean));
}

function disposePlannerStateResources(state, retainedState = null) {
    const retained = plannerStateTextures(retainedState);
    for (const texture of plannerStateTextures(state)) {
        if (!retained.has(texture)) texture.dispose?.();
    }
}

function applyPlannerState(state, nextGroup) {
    const next = state || emptyPlannerState();
    // Shader masks and their CPU/collision answers are one publication. A
    // render cannot occur in the middle of this synchronous commit.
    clearPlannerSurfaceCutoutMask();
    if (next.openingClaim) {
        if (next.surfaceMask) {
            setPlannerSurfaceCutoutMask(
                next.surfaceMask.texture,
                next.surfaceMask.centerX,
                next.surfaceMask.centerZ,
                next.surfaceMask.halfSizeM,
                next.openingClaim,
            );
        }
        if (next.structuralMask) {
            setPlannerStructuralSurfaceCutoutMask(
                next.structuralMask.texture,
                next.structuralMask.centerX,
                next.structuralMask.centerZ,
                next.structuralMask.halfSizeM,
                next.openingClaim,
            );
        }
    }
    activeSurfaceCutouts = next.surfaceCutouts;
    activeSubsurfaceWalkSegments = next.walkSegments;
    enclosedTunnelSpans = next.enclosedSpans;
    activePlannerState = next;
    group = nextGroup || null;
}

// Both terrain and explicit flat sessions use this compiler and the shared
// pre-controller publication boundary. Promise callbacks capture new inputs;
// they never rebuild or publish civil geometry themselves.
function requestPlannerPillarInputs(ctx, token) {
    const tram = typeof window !== 'undefined' ? window.tramSim : null;
    const ready = typeof tram?.whenLightReady === 'function' ? tram.whenLightReady() : Promise.resolve();
    Promise.all([ensureRoadIndex(), ready]).then(() => {
        if (activeSessionArgs !== ctx || sessionToken !== token) return;
        pillarSources = Object.freeze({ roads: captureRoadIndexRead(),
            tracks: tram?.getOsmTrackFeatures?.() || [] });
        groundCoordinator?.invalidate('planner', { reason: 'planner-pillar-inputs' });
    }).catch(error => {
        if (activeSessionArgs === ctx && sessionToken === token) console.error('Planner pillar inputs failed', error);
    });
}

function* preparePlannerOpeningGroundSteps({ terrain, registry, generation, isCurrent,
    now = () => performance.now() }) {
    const ctx = activeSessionArgs, token = sessionToken;
    if (!ctx) throw Object.assign(new Error('Planner session is unavailable'), { code: 'ground-dependency-busy' });
    const previousState = activePlannerState, previousRoot = group, sources = pillarSources;
    const current = () => activeSessionArgs === ctx && sessionToken === token
        && activePlannerState === previousState && group === previousRoot && isCurrent();
    const preparation = { now, isCurrent: current }, budget = createPlannerGeometryBudget(preparation);
    const features = ctx.otherTracks || EMPTY_PLANNER_ARRAY, stops = ctx.allStops || EMPTY_PLANNER_ARRAY;
    let root = null, state = null, ticket = null, committed = false, finalized = false, discarded = false, handedOff = false;
    let gpuFence = null;
    let reusedRoot = false;
    const discard = () => {
        if (discarded || finalized) return;
        discarded = true;
        if (ticket?.state === 'pending') ticket.discard();
        if (root && !reusedRoot) {
            // compileAsync continues polling material state after cancellation.
            // Keep this private root alive through that fence, then release it.
            const retired = root;
            if (gpuFence) Promise.resolve(gpuFence).then(() => disposeGroup(retired));
            else disposeGroup(retired);
        }
        disposePlannerStateResources(state, previousState);
    };
    try {
        budget.check();
        // Local-level structures do not depend on terrain evidence. Retain
        // their completed geometry across unrelated streamed ground changes.
        reusedRoot = !!previousState && previousState.features === features
            && previousState.stops === stops && previousState.pillarSources === sources;
        const segments = yield* capturePlannerTrackSegmentsSteps(features, ctx.anchorLat, ctx.anchorLon, {
            ...preparation,
            absoluteToSceneY: terrain?.absoluteToSceneY ? y => terrain.absoluteToSceneY(y) : null,
            groundSceneYAtLocal: terrain?.evidenceSceneYAtLocal ? (x,z) => terrain.evidenceSceneYAtLocal(x,z) : null,
        });
        if (segments.terrainEvidenceIncomplete) throw Object.assign(new Error('Planner terrain evidence is incomplete'),
            { code: 'ground-dependency-busy' });
        let supportRead;
        if (reusedRoot) {
            root = previousRoot; supportRead = previousState.supportRead;
        } else {
            let clearance = null;
            if (sources && segments.some(seg => !seg.structuresBuiltElsewhere && Math.max(seg.e1,seg.e2) > ELEV_EPS)) {
                clearance = yield* createPillarClearanceEvaluatorSteps(ctx.anchorLat, ctx.anchorLon,
                    [...sources.tracks, ...features], { ...preparation, roadSegmentsAt: sources.roads, groundTracksOnly: true });
            }
            root = yield* buildPlannerGeometrySteps(features, ctx.anchorLat, ctx.anchorLon, segments, stops,
                { preparation, includePillars: !!clearance, pillarClearance: clearance });
            if (!root.children.length) { disposeGroup(root); root = null; }
            if (root) {
                annotatePlannerElevationPublication(root, { generation, cuts: root.userData.plannerOpeningRegions });
                const colliderState = { published: false };
                root.userData.groundColliderState = colliderState;
                root.traverse(mesh => {
                    if (!mesh.isMesh || /Light|Marker/.test(mesh.name)) return;
                    mesh.userData.groundColliderFamily = 'authored-surfaces';
                    mesh.userData.groundColliderState = colliderState;
                });
                supportRead = yield* captureReceiverMeshReadSteps({ root,
                    include: mesh => mesh.userData.groundColliderFamily === 'authored-surfaces',
                    revision: generation, ...GROUND_GENERATION_LIMITS.openingSupport, ...preparation });
            } else supportRead = EMPTY_RECEIVER_SUPPORT_READ;
        }
        const planner = root?.userData.plannerOpeningRegions || Object.freeze([]);
        state = { ...emptyPlannerState(generation), features, stops, pillarSources: sources, supportRead,
            walkSegments: segments,
            enclosedSpans: root?.userData.enclosedTunnelSpans || [], planner,
            // Retained temporarily for the lane-marking interval consumer.
            // Ground point queries and receiver clipping use the actual faces.
            surfaceCutouts: yield* collectSubsurfaceRampCutoutsSteps(segments.filter(seg => !seg.structuresBuiltElsewhere), budget),
        };
        state.openingRead = yield* createSurfaceOpeningReadSteps({ planner, limits: GROUND_GENERATION_LIMITS.openings,
            now, isCurrent: () => committed ? activePlannerState === state : current() });
        if (planner.length) {
            state.openingClaim = compileSurfaceClaim(plannerElevationOpeningClaimInput(generation));
            state.surfaceMask = reusedRoot ? previousState.surfaceMask
                : yield* preparePlannerCutoutMaskSteps(planner, { budget });
            // There is one planner ramp channel. At-grade replacement belongs
            // to the shared rail receiver; it no longer gets a second cut here.
            state.structuralMask = state.surfaceMask;
        }
        const changedBounds = [];
        if (!reusedRoot) for (const read of [previousState?.supportRead, supportRead]) {
            if (!read?.surfaces.length) continue;
            const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
            for (const surface of read.surfaces) {
                yield* budget.step('planner-changed-bounds');
                bounds.minX = Math.min(bounds.minX,surface.bounds.minX); bounds.minZ = Math.min(bounds.minZ,surface.bounds.minZ);
                bounds.maxX = Math.max(bounds.maxX,surface.bounds.maxX); bounds.maxZ = Math.max(bounds.maxZ,surface.bounds.maxZ);
            }
            if (bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ) changedBounds.push(Object.freeze(bounds));
        }
        if (root && !reusedRoot) {
            const prewarm = prewarmDetachedObject(root, { renderer, camera, targetScene: scene,
                asyncShaders: true, label: 'planner:ground-upload', uploadBatch: 1, sliceMs: 2 });
            try { for (;;) {
                budget.check(); const next = prewarm.next(); if (next.done) break;
                gpuFence = next.value?.ready || null;
                yield next.value;
            } } finally { prewarm.return(); }
        }
        ticket = registry.begin({ key: reusedRoot ? 'ground:planner-state' : PLANNER_ELEVATION_PUBLICATION_KEY,
            generation, parent: scene, retire: (_context, retired) => disposeGroup(retired) });
        const entry = { ticket, ...(!reusedRoot && root ? { root } : { clear: true }), isCurrent: current,
            commit() {
                // The batch validated every source before its first mutation.
                // Commit checks this slot, not already-promoted sibling inputs.
                if (activePlannerState !== previousState || group !== previousRoot) return false;
                committed = true;
                if (root?.userData.groundColliderState) root.userData.groundColliderState.published = true;
                applyPlannerState(state, root); return true;
            },
            rollback() {
                if (!committed) return;
                if (root && !reusedRoot) root.userData.groundColliderState.published = false;
                applyPlannerState(previousState, previousRoot); committed = false;
            }, discard,
        };
        budget.check(); handedOff = true;
        return Object.freeze({ entries: [entry], planner, supportRead, changedBounds, isCurrent: current, discard,
            finalize() {
                if (finalized || !committed) return false;
                finalized = true; disposePlannerStateResources(previousState, state); return true;
            } });
    } finally { if (!handedOff) discard(); }
}

export const plannerElevationLayer = {
    beginSession(ctx) {
        terrainChangeSubscription?.();
        surfacePublications = ctx.surfacePublications;
        if (!surfacePublications || !ctx.groundPublications) throw new TypeError('Planner requires shared surface and ground publication boundaries');
        activeSessionArgs = ctx; terrainRevisionDirty = false; pillarSources = null;
        const token = ++sessionToken;
        groundCoordinator = ctx.groundCoordinator || null;
        if (!groundCoordinator) {
            localGroundQueue = createFrameChunkQueue({ label: 'planner-ground', frameBudgetMs: 2, stationaryReservationMs: 2,
                pauseDuringMovement: false, preferAnimationFrame: true, trackWorldReady: true,
                workClass: 'near', workTier: 'surface' });
            localGroundCoordinator = createGroundGenerationCoordinator({ queue: localGroundQueue,
                repeat: FRAME_CHUNK_REPEAT_ITEM, defer: FRAME_CHUNK_DEFER_ITEM,
                registry: surfacePublications, boundary: ctx.groundPublications,
                isCurrent: () => activeSessionArgs === ctx && sessionToken === token,
                prepareSteps: ({ generation, isCurrent }) => preparePlannerOpeningGroundSteps({ terrain: ctx.terrain,
                    registry: surfacePublications, generation, isCurrent }) });
            groundCoordinator = localGroundCoordinator;
        }
        terrainChangeSubscription = ctx.terrain?.onChange?.(() => {
            if (!ctx.groundCoordinator) terrainRevisionDirty = true;
        }) || null;
        groundCoordinator.invalidate('planner');
        if (ctx.otherTracks?.length) requestPlannerPillarInputs(ctx, token);
    },
    groundReady: () => !!activeSessionArgs,
    manageGroundPublications(coordinator) { groundCoordinator = coordinator; },
    prepareOpeningGroundSteps: preparePlannerOpeningGroundSteps,
    onFrame(_pose, local) {
        if (terrainRevisionDirty) { terrainRevisionDirty = false; groundCoordinator?.invalidate('planner'); }
        localGroundCoordinator?.onFrame(local);
    },
    endSession() {
        terrainChangeSubscription?.(); terrainChangeSubscription = null;
        localGroundCoordinator?.close(); localGroundCoordinator = null;
        localGroundQueue?.dispose(); localGroundQueue = null;
        groundCoordinator = null; activeSessionArgs = null; pillarSources = null;
        terrainRevisionDirty = false; sessionToken += 1;
        const retiringGroup = group, retiringState = activePlannerState;
        applyPlannerState(emptyPlannerState(), null); disposePlannerStateResources(retiringState); activePlannerState = null;
        if (retiringGroup && !surfacePublications?.retire?.(PLANNER_ELEVATION_PUBLICATION_KEY,
            { root: retiringGroup, reason: 'planner-elevation-session-ended' })) disposeGroup(retiringGroup);
        surfacePublications = null;
    },
};

// Why is the walker not underground? That question cost several rounds of
// guessing, because every input to it is invisible from outside: whether this
// layer kept the track's segments at all, what floor it reports beneath a given
// point, and whether that point counts as a surface cutout. Answer it in one
// world load instead. Mirrors __photorealDebug's role for the photo world.
//
//   __plannerWalkDebug.summary()          → segment/index counts
//   __plannerWalkDebug.floorAt(x, z, y)   → the corridor floor walk physics sees
if (typeof window !== 'undefined') {
    window.__plannerWalkDebug = {
        summary() {
            const owned = activeSubsurfaceWalkSegments.filter(
                (seg) => !seg.structuresBuiltElsewhere,
            ).length;
            const elevations = activeSubsurfaceWalkSegments
                .map((seg) => seg.e1)
                .filter(Number.isFinite)
                .sort((a, b) => a - b);
            return {
                walkSegments: activeSubsurfaceWalkSegments.length,
                // Segments whose visible civil works this layer builds itself;
                // the rest are authored-grade and owned by RailFormationModel.
                ownedSegments: owned,
                carriedSegments: activeSubsurfaceWalkSegments.length - owned,
                supportIndexCells: activePlannerState?.supportRead?.supportYAt.usage?.cells || 0,
                surfaceCutouts: activeSurfaceCutouts.length
                    + getPublishedPlannerEntranceCuts().length,
                elevationRange: elevations.length
                    ? [elevations[0], elevations[elevations.length - 1]]
                    : null,
            };
        },
        floorAt: (x, z, walkerY = null) => getPlannerSubsurfaceWalkFloorY(x, z, walkerY),
        cutoutAt: (x, z) => isPointInsidePlannerSurfaceCutout(x, z),
        // One call, no arguments to get wrong: reads the live walker position
        // and reports not just the answer but WHY. If corridorFloorY is null,
        // nearestSegment tells you whether it is because there are no segments
        // at all or because the walker is outside their reach.
        here() {
            const cam = globalThis.__photorealDebug?.camera?.();
            if (!cam) return 'no 3D session open — start a walk first';
            const { x, y, z } = cam.position;
            let nearest = null;
            for (const seg of activeSubsurfaceWalkSegments) {
                const dx = seg.x2 - seg.x1;
                const dz = seg.z2 - seg.z1;
                const lengthSq = dx * dx + dz * dz;
                const t = lengthSq > 1e-8
                    ? Math.max(0, Math.min(1, ((x - seg.x1) * dx + (z - seg.z1) * dz) / lengthSq))
                    : 0;
                const distM = Math.hypot(x - (seg.x1 + dx * t), z - (seg.z1 + dz * t));
                if (!nearest || distM < nearest.distM) {
                    nearest = {
                        distM: +distM.toFixed(2),
                        reachM: +segmentWalkHalfWidthM(seg).toFixed(2),
                        segmentY: +(seg.e1 + (seg.e2 - seg.e1) * t).toFixed(2),
                    };
                }
            }
            const floorY = getPlannerSubsurfaceWalkFloorY(x, z, y);
            return {
                walkerY: +y.toFixed(2),
                corridorFloorY: Number.isFinite(floorY) ? +floorY.toFixed(2) : null,
                insideCorridor: Number.isFinite(floorY) && y < -0.5 && floorY < -0.5,
                insideCutout: isPointInsidePlannerSurfaceCutout(x, z),
                nearestSegment: nearest,
                withinReach: nearest ? nearest.distM <= nearest.reachM : false,
                ...this.summary(),
            };
        },
    };
}
