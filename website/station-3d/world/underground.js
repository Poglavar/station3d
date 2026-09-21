import * as THREE from 'three';
import { disposeGroup } from '../core/dispose.js';
import {
    plannerFeatureUsesAbsoluteElevation,
    plannerFeatureUsesPhotoFrame,
    plannerScenePoint,
} from '../core/planner-station-photo-placement.js';
import {
    MIN_STATION_TRACK_CHORD_M,
    prepareStationTrackRoutesFromSegments,
    resolvePlannerStationTrackAnchor,
} from '../core/planner-station-track-anchor.js';
import {
    buildModelCoveredStationPlan,
    getModelStationPortalAdapter,
} from '../core/model-covered-station.js';
import { plannerSegmentOwnerProperties } from '../core/planner-station-flare.js';
import {
    PHOTO_CORRIDOR_HALF_WIDTH_M,
    PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
} from '../core/photo-corridor-ownership.js';
import { scene } from '../scene/setup.js';
import { buildSeededPlatformPeopleGroup, getStopNameSignTexture } from './platforms.js';
import {
    canBuildPhotorealRigidStation,
    getPhotorealStationStructure,
    getPhotorealStationStructureRevision,
    isPhotorealRevealed,
} from './photoreal.js';
import {
    getPlannerStopLevel,
    getPlannerPlatformSideOffsetM,
    PLANNER_LEVEL_HEIGHT_M,
    PLANNER_TUNNEL_CLEARANCE_M,
    PLANNER_TUNNEL_FLOOR_WIDTH_M,
    PLANNER_TUNNEL_INNER_WIDTH_M,
    PLANNER_TUNNEL_WALL_CENTER_OFFSET_M,
    PLANNER_TUNNEL_WALL_THICKNESS_M,
    STATION_STAIR_WIDTH_M,
    UNDERGROUND_ACCESS_CORE_ALONG_M,
    UNDERGROUND_ACCESS_PASSAGE_WIDTH_M,
    UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
    UNDERGROUND_ISLAND_PLATFORM_WIDTH_M,
    UNDERGROUND_MEZZANINE_HEIGHT_M,
    UNDERGROUND_PARALLEL_BORE_OFFSET_M,
    UNDERGROUND_PLATFORM_LENGTH_M,
    UNDERGROUND_STATION_HALL_HALF_WIDTH_M,
    UNDERGROUND_STATION_HALL_HEIGHT_M,
    UNDERGROUND_STATION_LENGTH_M,
    UNDERGROUND_STATION_THROAT_LENGTH_M,
    UNDERGROUND_STATION_TOTAL_LENGTH_M,
    UNDERGROUND_STATION_TRACK_CENTER_SPACING_M,
} from './planner-station-layout.js';
import {
    getTrackCenterSpacingMeters,
    getTrackGaugeMeters,
} from './tram-trackbed-dimensions.js';

const TUNNEL_HALF_WIDTH_M = 3.6;
const TUNNEL_HEIGHT_M = 6.2;
const TUNNEL_SHELL_THICKNESS_M = 0.28;
const PARALLEL_BORE_OFFSET_M = UNDERGROUND_PARALLEL_BORE_OFFSET_M;
const RAIL_WIDTH_M = 0.12;
const RAIL_HEIGHT_M = 0.12;
const SLEEPER_WIDTH_M = 2.5;
const SLEEPER_HEIGHT_M = 0.16;
const SLEEPER_DEPTH_M = 0.2;
const SLEEPER_SPACING_M = 0.92;
const SLEEPER_JITTER_M = 0.12;
const LIGHT_FIXTURE_WIDTH_M = 0.72;
const LIGHT_FIXTURE_HEIGHT_M = 0.16;
const LIGHT_FIXTURE_DEPTH_M = 1.8;
const LIGHT_FIXTURE_SPACING_M = 10.0;
const WALL_JOINT_WIDTH_M = 0.08;
const WALL_JOINT_HEIGHT_M = TUNNEL_HEIGHT_M - 0.5;
const WALL_JOINT_DEPTH_M = 0.16;
const WALL_JOINT_SPACING_M = 6.0;
const WALL_PATTERN_DEPTH_M = 0.06;
const WALL_PATTERN_BAND_HEIGHT_M = 0.14;
const WALL_PATTERN_PANEL_HEIGHT_M = 1.15;
const WALL_PATTERN_PANEL_LENGTH_M = 2.6;
const WALL_PATTERN_PANEL_SPACING_M = 8.0;
const STATION_LENGTH_M = UNDERGROUND_STATION_LENGTH_M;
const STATION_WIDTH_M = 42;
const STATION_HEIGHT_M = 24;
const STATION_MEZZANINE_Y_M = 12;
const PLATFORM_HEIGHT_M = 0.9;
const PLATFORM_WIDTH_M = 5.2;
const STATION_CLEAR_RADIUS_M = STATION_LENGTH_M * 0.5;
const STATION_PORTAL_DEPTH_M = 0.72;
const STATION_PORTAL_OPENING_WIDTH_M = TUNNEL_HALF_WIDTH_M * 2 + 0.9;
const STATION_PORTAL_OPENING_HEIGHT_M = TUNNEL_HEIGHT_M + 0.4;
const PLANNER_STATION_PORTAL_THROAT_DEPTH_M = 2.5;
const PLANNER_STATION_PORTAL_THROAT_OVERLAP_M = 0.25;
const STATION_LIGHT_SPACING_M = 9.0;

let group = null;
let plannerSession = null;
let photoStationStructureRevision = 0;

// Exposes the hall/platform shell to walk-mode ground detection.
export function getUndergroundGroup() {
    return group;
}

function collectRouteLines(features, { surfaceWorld = false } = {}) {
    const lines = [];
    for (const feature of features || []) {
        const geometry = feature && feature.geometry;
        if (!geometry) continue;
        const properties = feature?.properties || {};
        const trackId = properties.trackId ?? null;
        const rawLines = geometry.type === 'LineString'
            ? [geometry.coordinates || []]
            : geometry.type === 'MultiLineString'
                ? geometry.coordinates || []
                : [];
        for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
            const line = rawLines[lineIndex];
            const segmentTrackIds = geometry.type === 'MultiLineString'
                && Array.isArray(properties.segmentTrackIds?.[lineIndex])
                ? properties.segmentTrackIds[lineIndex]
                : (Array.isArray(properties.segmentTrackIds)
                    ? properties.segmentTrackIds
                    : null);
            const coords = [];
            for (const coord of line || []) {
                if (!Array.isArray(coord) || coord.length < 2) continue;
                const lon = Number(coord[0]);
                const lat = Number(coord[1]);
                if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
                const elevation = Number(coord[2]);
                const last = coords[coords.length - 1];
                if (last && Math.abs(last[0] - lon) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) continue;
                coords.push([lon, lat, Number.isFinite(elevation) ? elevation : 0]);
            }
            if (coords.length >= 2) lines.push({ coords, trackId, segmentTrackIds, properties });
        }
    }
    return lines;
}

function buildRouteSegments(
    features,
    anchorLat,
    anchorLon,
    { surfaceWorld = false, photoTrackFrame = null, absoluteToSceneY = null } = {},
) {
    const segments = [];
    const routeLines = collectRouteLines(features, { surfaceWorld });
    for (let routeIndex = 0; routeIndex < routeLines.length; routeIndex++) {
        const routeLine = routeLines[routeIndex];
        const { coords, trackId, segmentTrackIds, properties } = routeLine;
        const usesPhotoTrackFrame = plannerFeatureUsesPhotoFrame(properties, photoTrackFrame);
        const usesAbsoluteElevation = plannerFeatureUsesAbsoluteElevation(properties);
        // c[2] on an absolute-mode feature is EVRF2000 a.s.l. — ~+110 in Zagreb.
        // The scene is not in that frame (rails and the terrain drape both sit
        // at scene 0 and carry their height in their vertices), so it has to be
        // converted exactly the way the rail formation does. Skipping this put
        // the whole station box 100 m above the city.
        const toSceneY = (elevationM) => (
            usesAbsoluteElevation && typeof absoluteToSceneY === 'function'
                ? absoluteToSceneY(elevationM)
                : elevationM
        );
        let ownerRun = 0;
        let previousOwner = null;
        for (let i = 0; i < coords.length - 1; i++) {
            const segmentTrackId = segmentTrackIds?.[i] ?? trackId;
            const ownerKey = segmentTrackId == null ? null : String(segmentTrackId);
            if (i > 0 && ownerKey !== previousOwner) ownerRun += 1;
            previousOwner = ownerKey;
            const segmentProperties = plannerSegmentOwnerProperties(
                segmentTrackIds ? { ...properties, segmentTrackIds } : properties,
                i,
            );
            const [lonA, latA, elevA] = coords[i];
            const [lonB, latB, elevB] = coords[i + 1];
            // Legacy c[2] encodes planner level, so it remains a useful tunnel
            // gate. Photo c[2] is authored ASL minus an arbitrary session datum,
            // and MODEL-mode c[2] on a terrain world is authored absolute
            // EVRF2000 — in Zagreb that is ~+110 everywhere, so this gate read
            // every underground segment as "above ground" and skipped it. No
            // route segment survived, so no station box was ever built and
            // "Vidi" had nothing underground to arrive in. Neither frame's SIGN
            // says anything about being underground; both are gated semantically
            // by the stop's own level below.
            if (surfaceWorld && !usesPhotoTrackFrame && !usesAbsoluteElevation
                && Math.max(elevA, elevB) > -PLANNER_LEVEL_HEIGHT_M * 0.5) continue;
            const start = plannerScenePoint({
                lon: lonA,
                lat: latA,
                elevationM: toSceneY(elevA),
                anchorLon,
                anchorLat,
                photoTrackFrame,
                usePhotoFrame: usesPhotoTrackFrame,
            });
            const end = plannerScenePoint({
                lon: lonB,
                lat: latB,
                elevationM: toSceneY(elevB),
                anchorLon,
                anchorLat,
                photoTrackFrame,
                usePhotoFrame: usesPhotoTrackFrame,
            });
            const dx = end.x - start.x;
            const dz = end.z - start.z;
            const len = Math.hypot(dx, dz);
            // Smoothed planner curves are sampled at 0.75 m arc intervals, so
            // their chords are deliberately a little shorter than 0.75 m.
            // Reject only numerical slivers; dropping those valid chords made
            // the station-route assembler bridge a whole curve with one false
            // straight line and could rotate the hall onto that shortcut.
            if (len < MIN_STATION_TRACK_CHORD_M) continue;
            const alongX = dx / len;
            const alongZ = dz / len;
            const rightX = -alongZ;
            const rightZ = alongX;
            segments.push({
                index: segments.length,
                routeKey: `${routeIndex}:${ownerRun}`,
                routeOrder: i,
                trackId: segmentTrackId,
                properties: segmentProperties,
                usesPhotoTrackFrame,
                usesAbsoluteElevation,
                start,
                end,
                // Already in SCENE Y (absolute-mode elevations were converted
                // above), so a stop matched against these must be converted too.
                e1: start.y,
                e2: end.y,
                centerX: (start.x + end.x) * 0.5,
                centerZ: (start.z + end.z) * 0.5,
                length: len,
                alongX,
                alongZ,
                rightX,
                rightZ,
                angle: Math.atan2(dx, dz),
            });
        }
    }
    return segments;
}

function projectPointOntoSegment(px, pz, segment) {
    const segDx = segment.end.x - segment.start.x;
    const segDz = segment.end.z - segment.start.z;
    const segLenSq = segDx * segDx + segDz * segDz;
    if (segLenSq <= 1e-6) return null;
    let t = ((px - segment.start.x) * segDx + (pz - segment.start.z) * segDz) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const x = segment.start.x + segDx * t;
    const z = segment.start.z + segDz * t;
    const dx = px - x;
    const dz = pz - z;
    return { x, z, t, d2: dx * dx + dz * dz };
}

function segmentMatchesStopTrack(segment, stopTrackId) {
    if (stopTrackId == null) return true;
    const stopTrackKey = String(stopTrackId);
    if (segment.trackId != null) return String(segment.trackId) === stopTrackKey;
    const trackIds = Array.isArray(segment.properties?.trackIds)
        ? segment.properties.trackIds.map(String)
        : [];
    return trackIds.length === 0 || trackIds.includes(stopTrackKey);
}

function stationAnchorRoutesFromSegments(segments) {
    return prepareStationTrackRoutesFromSegments(segments);
}

// Chord direction across the station's full length. A ~60 m hall anchored to
// the single nearest polyline chord (often a short smoothing chord) lets a
// bend twist the box against the running tunnel, so the bores met the portal
// walls off-axis. The chord between the two points where the track crosses
// the portal planes puts both tube mouths in their openings; any residual
// mid-station bow hides inside the hall.
function stationRunChordDirection(segments, seedSegment, seedT, halfSpanM) {
    const run = segments
        .filter(segment => segment.routeKey === seedSegment.routeKey)
        .sort((a, b) => a.routeOrder - b.routeOrder);
    if (run.length === 0) return null;
    // Cumulative chainage over the run; sub-minimum chords were dropped at
    // collection, so bridge any gap between consecutive segments as straight
    // distance.
    const chainages = [];
    let total = 0;
    for (let i = 0; i < run.length; i++) {
        if (i > 0) {
            total += Math.hypot(
                run[i].start.x - run[i - 1].end.x,
                run[i].start.z - run[i - 1].end.z,
            );
        }
        chainages.push(total);
        total += run[i].length;
    }
    const seedIndex = run.indexOf(seedSegment);
    if (seedIndex < 0) return null;
    const seedChainage = chainages[seedIndex] + seedSegment.length * seedT;
    const sampleAt = (targetChainage) => {
        const clamped = Math.max(0, Math.min(total, targetChainage));
        for (let i = 0; i < run.length; i++) {
            const local = clamped - chainages[i];
            if (local <= run[i].length + 1e-6) {
                const t = Math.max(0, Math.min(1, local / run[i].length));
                return {
                    x: run[i].start.x + (run[i].end.x - run[i].start.x) * t,
                    z: run[i].start.z + (run[i].end.z - run[i].start.z) * t,
                };
            }
        }
        const last = run[run.length - 1];
        return { x: last.end.x, z: last.end.z };
    };
    const before = sampleAt(seedChainage - halfSpanM);
    const after = sampleAt(seedChainage + halfSpanM);
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const lengthM = Math.hypot(dx, dz);
    if (lengthM < 1) return null;
    return {
        alongX: dx / lengthM,
        alongZ: dz / lengthM,
        rightX: -dz / lengthM,
        rightZ: dx / lengthM,
    };
}

function buildStationDescriptors(
    stops,
    segments,
    anchorLat,
    anchorLon,
    {
        surfaceWorld = false,
        photoTrackFrame = null,
        stopLevel = getPlannerStopLevel,
        absoluteToSceneY = null,
    } = {},
) {
    const stations = [];
    const seen = new Set();
    const stationAnchorRoutes = stationAnchorRoutesFromSegments(segments);
    for (const stop of stops || []) {
        const effectiveLevel = stopLevel(stop);
        if (surfaceWorld && effectiveLevel !== -1) continue;
        const lon = Number(stop && stop.lng);
        const lat = Number(stop && stop.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const key = stop.stopId != null ? String(stop.stopId) : `${stop.name || ''}:${lat.toFixed(6)}:${lon.toFixed(6)}`;
        if (seen.has(key)) continue;
        const stopTrackId = stop?.trackId ?? null;
        // A stop on an absolute-mode track carries EVRF2000 a.s.l., the same as
        // that track's coordinates. Convert it into scene Y exactly as the
        // segments were, or the station box floats by the whole ground
        // elevation (~100 m over Zagreb) while its own route sits correctly.
        const stopUsesAbsolute = typeof absoluteToSceneY === 'function' && segments.some(
            (segment) => segment.usesAbsoluteElevation
                && segmentMatchesStopTrack(segment, stopTrackId),
        );
        const rawTargetElevM = surfaceWorld
            ? (Number.isFinite(Number(stop.elevM))
                ? Number(stop.elevM)
                : effectiveLevel * PLANNER_LEVEL_HEIGHT_M)
            : 0;
        const targetElevM = stopUsesAbsolute && surfaceWorld
            ? absoluteToSceneY(rawTargetElevM)
            : rawTargetElevM;
        const usesPhotoTrackFrame = !!photoTrackFrame && segments.some(segment => (
            segment.usesPhotoTrackFrame && segmentMatchesStopTrack(segment, stopTrackId)
        ));
        const local = plannerScenePoint({
            lon,
            lat,
            elevationM: targetElevM,
            anchorLon,
            anchorLat,
            photoTrackFrame,
            usePhotoFrame: usesPhotoTrackFrame,
        });
        let best = null;
        for (const segment of segments) {
            if (segment.usesPhotoTrackFrame !== usesPhotoTrackFrame) continue;
            if (surfaceWorld && !segmentMatchesStopTrack(segment, stopTrackId)) continue;
            if (surfaceWorld && !segment.usesPhotoTrackFrame && (
                Math.abs(segment.e1 - targetElevM) > 0.75
                || Math.abs(segment.e2 - targetElevM) > 0.75
            )) continue;
            const projected = projectPointOntoSegment(local.x, local.z, segment);
            if (!projected) continue;
            if (!best || projected.d2 < best.projected.d2) {
                best = { segment, projected };
            }
        }
        const canonicalAnchor = resolvePlannerStationTrackAnchor({
            stopX: local.x,
            stopZ: local.z,
            stopTrackId,
            usePhotoFrame: usesPhotoTrackFrame,
            routes: stationAnchorRoutes,
            tangentHalfSpanM: 12,
            maxSnapDistanceM: stopTrackId == null ? 80 : Infinity,
        });
        if (canonicalAnchor) {
            const sourceSegment = canonicalAnchor.route.segments?.[canonicalAnchor.segmentIndex]
                || best?.segment;
            if (sourceSegment) {
                best = {
                    segment: sourceSegment,
                    projected: {
                        x: canonicalAnchor.x,
                        z: canonicalAnchor.z,
                        t: canonicalAnchor.t,
                        d2: canonicalAnchor.distanceM ** 2,
                    },
                };
            }
        }
        if (!best || best.projected.d2 > 80 * 80) continue;
        seen.add(key);
        const baseY = canonicalAnchor
            ? canonicalAnchor.y
            : best.segment.usesPhotoTrackFrame
                ? best.segment.e1
                    + (best.segment.e2 - best.segment.e1) * best.projected.t
            : targetElevM;
        const runChord = canonicalAnchor ? null : stationRunChordDirection(
            segments, best.segment, best.projected.t, STATION_LENGTH_M * 0.5,
        );
        const alongX = canonicalAnchor?.alongX ?? runChord?.alongX ?? best.segment.alongX;
        const alongZ = canonicalAnchor?.alongZ ?? runChord?.alongZ ?? best.segment.alongZ;
        const rightX = canonicalAnchor?.rightX ?? runChord?.rightX ?? best.segment.rightX;
        const rightZ = canonicalAnchor?.rightZ ?? runChord?.rightZ ?? best.segment.rightZ;
        stations.push({
            stop,
            stopId: stop.stopId ?? stop.id ?? null,
            name: stop.name || '',
            segmentIndex: best.segment.index,
            segmentAlong: (best.projected.t - 0.5) * best.segment.length,
            routeCenterX: best.projected.x,
            routeCenterZ: best.projected.z,
            centerX: best.projected.x + best.segment.rightX * (surfaceWorld
                ? 0
                : PARALLEL_BORE_OFFSET_M * 0.5),
            centerZ: best.projected.z + best.segment.rightZ * (surfaceWorld
                ? 0
                : PARALLEL_BORE_OFFSET_M * 0.5),
            baseY,
            routeAnchor: canonicalAnchor,
            alongX,
            alongZ,
            rightX,
            rightZ,
            properties: best.segment.properties,
        });
    }
    return stations;
}

function createSegmentSpan(segment, startAlong, endAlong) {
    const clampedStart = Math.max(-segment.length * 0.5, Math.min(segment.length * 0.5, startAlong));
    const clampedEnd = Math.max(-segment.length * 0.5, Math.min(segment.length * 0.5, endAlong));
    const spanLength = clampedEnd - clampedStart;
    if (spanLength <= 0.5) return null;
    const spanMid = (clampedStart + clampedEnd) * 0.5;
    return {
        ...segment,
        centerX: segment.centerX + segment.alongX * spanMid,
        centerZ: segment.centerZ + segment.alongZ * spanMid,
        length: spanLength,
    };
}

function buildTunnelSpansForSegment(segment, stations) {
    const blockedRanges = [];
    for (const station of stations) {
        const projected = projectPointOntoSegment(station.routeCenterX, station.routeCenterZ, segment);
        if (!projected || projected.d2 > STATION_CLEAR_RADIUS_M * STATION_CLEAR_RADIUS_M) continue;
        const segmentAlong = (projected.t - 0.5) * segment.length;
        const alongHalfSpan = Math.sqrt(Math.max(0, (STATION_CLEAR_RADIUS_M * STATION_CLEAR_RADIUS_M) - projected.d2));
        const startAlong = segmentAlong - alongHalfSpan;
        const endAlong = segmentAlong + alongHalfSpan;
        if (endAlong <= -segment.length * 0.5 || startAlong >= segment.length * 0.5) continue;
        blockedRanges.push([
            Math.max(-segment.length * 0.5, startAlong),
            Math.min(segment.length * 0.5, endAlong),
        ]);
    }
    if (blockedRanges.length === 0) return [segment];

    blockedRanges.sort((a, b) => a[0] - b[0]);
    const mergedBlockedRanges = [];
    for (const range of blockedRanges) {
        const last = mergedBlockedRanges[mergedBlockedRanges.length - 1];
        if (!last || range[0] > last[1] + 0.1) {
            mergedBlockedRanges.push([...range]);
        } else {
            last[1] = Math.max(last[1], range[1]);
        }
    }

    const spans = [];
    let cursor = -segment.length * 0.5;
    for (const [blockedStart, blockedEnd] of mergedBlockedRanges) {
        const span = createSegmentSpan(segment, cursor, blockedStart);
        if (span) spans.push(span);
        cursor = Math.max(cursor, blockedEnd);
    }
    const finalSpan = createSegmentSpan(segment, cursor, segment.length * 0.5);
    if (finalSpan) spans.push(finalSpan);
    return spans;
}

function pushBox(instances, segment, boreOffset, lateralOffset, y, sx, sy, sz) {
    instances.push({
        x: segment.centerX + segment.rightX * (boreOffset + lateralOffset),
        y,
        z: segment.centerZ + segment.rightZ * (boreOffset + lateralOffset),
        angle: segment.angle,
        sx,
        sy,
        sz,
    });
}

function pushRepeatedAlongSegment(instances, segment, boreOffset, lateralOffset, y, sx, sy, sz, spacing, endInset = 0, jitter = 0) {
    const startAlong = -segment.length * 0.5 + endInset;
    const endAlong = segment.length * 0.5 - endInset;
    if (!(endAlong >= startAlong)) {
        if (segment.length >= sz) pushBox(instances, segment, boreOffset, lateralOffset, y, sx, sy, sz);
        return;
    }
    let count = 0;
    for (let along = startAlong; along <= endAlong + 1e-6; along += spacing) {
        const jitteredAlong = Math.max(startAlong, Math.min(endAlong, along + (((count % 3) - 1) * jitter)));
        instances.push({
            x: segment.centerX + segment.alongX * jitteredAlong + segment.rightX * (boreOffset + lateralOffset),
            y,
            z: segment.centerZ + segment.alongZ * jitteredAlong + segment.rightZ * (boreOffset + lateralOffset),
            angle: segment.angle,
            sx,
            sy,
            sz,
        });
        count++;
    }
    if (count === 0) {
        pushBox(instances, segment, boreOffset, lateralOffset, y, sx, sy, sz);
    }
}

function getWallPatternOffset(wallOffset) {
    return wallOffset - Math.sign(wallOffset) * ((TUNNEL_SHELL_THICKNESS_M - WALL_PATTERN_DEPTH_M) * 0.5 + 0.01);
}

function buildInstancedBoxes(instances, materialOptions) {
    if (!instances || instances.length === 0) return null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial(materialOptions);
    const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
    mesh.castShadow = false;
    // Sealed underground volume: never sample the sun's shadow map — surface
    // objects (cars, trees) otherwise project shadows through the ground
    // plane onto hall floors and walls.
    mesh.receiveShadow = false;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < instances.length; i++) {
        const entry = instances[i];
        position.set(entry.x, entry.y, entry.z);
        quaternion.setFromAxisAngle(yAxis, entry.angle);
        scale.set(entry.sx, entry.sy, entry.sz);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}

// Metro-style wall name plates: the station name repeated along a side wall,
// readable from the platforms and from an arriving train. wallX is the inner
// wall face; plates face the hall centre. Heights follow the group's vertical
// squash the same way addBox does (position scaled, plate size legible as-is).
function addStationNamePlates(groupRef, name, { wallX, y, zs, verticalScale = 1 }) {
    const label = (name || '').trim();
    if (!label) return;
    const mat = new THREE.MeshBasicMaterial({ map: getStopNameSignTexture(label) });
    const geo = new THREE.PlaneGeometry(4.8, 0.9);
    for (const z of zs) {
        const plate = new THREE.Mesh(geo, mat);
        plate.position.set(wallX, y * verticalScale, z);
        plate.rotation.y = wallX >= 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
        plate.name = 'StationWallNamePlate';
        groupRef.add(plate);
    }
}

function addBox(
    groupRef,
    material,
    sx,
    sy,
    sz,
    px,
    py,
    pz,
    rx = 0,
    ry = 0,
    rz = 0,
    verticalScaleOverride = null,
) {
    const verticalScale = Number.isFinite(verticalScaleOverride)
        ? verticalScaleOverride
        : Number(groupRef?.userData?.verticalScale) || 1;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy * verticalScale, sz), material);
    mesh.position.set(px, py * verticalScale, pz);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    // Sealed underground volume: never sample the sun's shadow map — surface
    // objects (cars, trees) otherwise project shadows through the ground
    // plane onto hall floors and walls.
    mesh.receiveShadow = false;
    groupRef.add(mesh);
    return mesh;
}

function getStationPortalOpenings(surfaceWorld, trackOffsets) {
    if (surfaceWorld) {
        return [{
            centerX: 0,
            width: PLANNER_TUNNEL_INNER_WIDTH_M,
            height: PLANNER_TUNNEL_CLEARANCE_M,
        }];
    }
    return [...trackOffsets]
        .sort((a, b) => a - b)
        .map(centerX => ({
            centerX,
            width: STATION_PORTAL_OPENING_WIDTH_M,
            height: STATION_PORTAL_OPENING_HEIGHT_M,
        }));
}

function addStationPortalWall(groupRef, material, z, portalOpenings) {
    const inheritedVerticalScale = Number(groupRef?.userData?.verticalScale) || 1;
    const isCompressedHall = inheritedVerticalScale < 0.99;
    const effectiveStationHeight = isCompressedHall
        ? STATION_HEIGHT_M * inheritedVerticalScale
        : STATION_HEIGHT_M;
    const portalVerticalScale = isCompressedHall ? 1 : null;
    const halfWidth = STATION_WIDTH_M * 0.5;
    const wallY = effectiveStationHeight * 0.5 - 0.25;
    const sortedOpenings = [...portalOpenings]
        .map(opening => ({
            ...opening,
            startX: Math.max(-halfWidth, opening.centerX - opening.width * 0.5),
            endX: Math.min(halfWidth, opening.centerX + opening.width * 0.5),
        }))
        .sort((a, b) => a.startX - b.startX);
    const spans = [];
    let cursorX = -halfWidth;
    for (const opening of sortedOpenings) {
        if (opening.startX > cursorX) spans.push([cursorX, opening.startX]);
        cursorX = Math.max(cursorX, opening.endX);
    }
    if (cursorX < halfWidth) spans.push([cursorX, halfWidth]);
    for (const [fromX, toX] of spans) {
        const width = toX - fromX;
        if (width <= 0.25) continue;
        addBox(groupRef, material, width, effectiveStationHeight, STATION_PORTAL_DEPTH_M, (fromX + toX) * 0.5, wallY, z, 0, 0, 0, portalVerticalScale);
    }
    for (const opening of sortedOpenings) {
        const topHeight = Math.max(0.8, effectiveStationHeight - opening.height);
        const topY = opening.height + topHeight * 0.5 - 0.25;
        addBox(groupRef, material, opening.endX - opening.startX, topHeight, STATION_PORTAL_DEPTH_M, (opening.startX + opening.endX) * 0.5, topY, z, 0, 0, 0, portalVerticalScale);
    }
}

function addPlannerStationPortalThroats(groupRef, material, portalOpenings) {
    const opening = portalOpenings[0];
    if (!opening) return null;
    const throats = new THREE.Group();
    throats.name = 'PlannerMetroStationPortalThroats';
    throats.userData.verticalScale = 1;
    throats.userData.sealedTransition = true;
    throats.userData.depthM = PLANNER_STATION_PORTAL_THROAT_DEPTH_M;
    throats.userData.innerWidthM = opening.width;
    const wallBottomY = -0.25;
    const wallTopY = PLANNER_LEVEL_HEIGHT_M + 0.3;
    const wallHeight = wallTopY - wallBottomY;
    const wallCenterY = (wallTopY + wallBottomY) * 0.5;
    const ceilingThicknessM = 0.4;

    for (const direction of [-1, 1]) {
        const z = direction * (
            STATION_LENGTH_M * 0.5
            + PLANNER_STATION_PORTAL_THROAT_DEPTH_M * 0.5
            - PLANNER_STATION_PORTAL_THROAT_OVERLAP_M
        );
        const floor = addBox(
            throats,
            material,
            PLANNER_TUNNEL_FLOOR_WIDTH_M,
            0.3,
            PLANNER_STATION_PORTAL_THROAT_DEPTH_M,
            0,
            -0.15,
            z,
            0,
            0,
            0,
            1,
        );
        floor.name = 'PlannerMetroStationPortalThroatFloor';
        floor.userData.walkableSurface = true;
        for (const side of [-1, 1]) {
            const wall = addBox(
                throats,
                material,
                PLANNER_TUNNEL_WALL_THICKNESS_M,
                wallHeight,
                PLANNER_STATION_PORTAL_THROAT_DEPTH_M,
                side * PLANNER_TUNNEL_WALL_CENTER_OFFSET_M,
                wallCenterY,
                z,
                0,
                0,
                0,
                1,
            );
            wall.name = 'PlannerMetroStationPortalThroatWall';
        }
        const ceiling = addBox(
            throats,
            material,
            PLANNER_TUNNEL_FLOOR_WIDTH_M + PLANNER_TUNNEL_WALL_THICKNESS_M,
            ceilingThicknessM,
            PLANNER_STATION_PORTAL_THROAT_DEPTH_M,
            0,
            PLANNER_TUNNEL_CLEARANCE_M + ceilingThicknessM * 0.5,
            z,
            0,
            0,
            0,
            1,
        );
        ceiling.name = 'PlannerMetroStationPortalThroatCeiling';
    }
    groupRef.add(throats);
    return throats;
}

function addLongWallWithCentralOpening(groupRef, material, sx, sy, totalDepth, px, py, openingWidth) {
    const sideDepth = (totalDepth - openingWidth) * 0.5;
    if (sideDepth <= 0.1) return;
    const offsetZ = openingWidth * 0.5 + sideDepth * 0.5;
    addBox(groupRef, material, sx, sy, sideDepth, px, py, -offsetZ);
    addBox(groupRef, material, sx, sy, sideDepth, px, py, offsetZ);
}

function addLongWallWithBoundedOpening(groupRef, material, x, height, depth, opening) {
    const halfDepth = depth * 0.5;
    const wallBottom = -0.25;
    const start = Math.max(-halfDepth, opening.center - opening.width * 0.5);
    const end = Math.min(halfDepth, opening.center + opening.width * 0.5);
    const bottom = Math.max(0, opening.bottom);
    const top = Math.min(height, bottom + opening.height);
    const addWallPart = (sy, sz, py, pz) => {
        if (sy <= 0.05 || sz <= 0.05) return;
        addBox(
            groupRef,
            material,
            PLANNER_TUNNEL_WALL_THICKNESS_M,
            sy,
            sz,
            x,
            py,
            pz,
            0,
            0,
            0,
            1,
        );
    };
    addWallPart(bottom - wallBottom, depth, (wallBottom + bottom) * 0.5, 0);
    addWallPart(height - top, depth, top + (height - top) * 0.5, 0);
    addWallPart(top - bottom, start + halfDepth, bottom + (top - bottom) * 0.5,
        (-halfDepth + start) * 0.5);
    addWallPart(top - bottom, halfDepth - end, bottom + (top - bottom) * 0.5,
        (end + halfDepth) * 0.5);
}

function addTaperedPrism(groupRef, material, zA, halfWidthA, zB, halfWidthB, yBottom, yTop, name) {
    const vertices = [
        [-halfWidthA, yBottom, zA], [-halfWidthA, yTop, zA],
        [halfWidthA, yBottom, zA], [halfWidthA, yTop, zA],
        [-halfWidthB, yBottom, zB], [-halfWidthB, yTop, zB],
        [halfWidthB, yBottom, zB], [halfWidthB, yTop, zB],
    ];
    const positions = vertices.flat();
    const indices = [
        1, 7, 5, 1, 3, 7,
        0, 6, 2, 0, 4, 6,
        0, 5, 4, 0, 1, 5,
        2, 7, 3, 2, 6, 7,
        0, 3, 1, 0, 2, 3,
        4, 7, 6, 4, 5, 7,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    // Sealed underground volume: never sample the sun's shadow map — surface
    // objects (cars, trees) otherwise project shadows through the ground
    // plane onto hall floors and walls.
    mesh.receiveShadow = false;
    groupRef.add(mesh);
    return mesh;
}

function addTaperedThroatWall(groupRef, material, side, zA, halfWidthA, zB, halfWidthB) {
    const xA = side * halfWidthA;
    const xB = side * halfWidthB;
    const dx = xB - xA;
    const dz = zB - zA;
    const length = Math.hypot(dx, dz) + 0.35;
    const wallBottomY = -0.25;
    const wallHeight = PLANNER_TUNNEL_CLEARANCE_M + 0.5;
    const wall = addBox(
        groupRef,
        material,
        PLANNER_TUNNEL_WALL_THICKNESS_M,
        wallHeight,
        length,
        (xA + xB) * 0.5,
        wallBottomY + wallHeight * 0.5,
        (zA + zB) * 0.5,
        0,
        Math.atan2(dx, dz),
        0,
        1,
    );
    wall.name = 'PlannerMetroStationTaperedThroatWall';
}

function addPlannerIslandStationThroats(groupRef, material) {
    const throats = new THREE.Group();
    throats.name = 'PlannerMetroStationTaperedThroats';
    throats.userData.sealedTransition = true;
    throats.userData.depthM = UNDERGROUND_STATION_THROAT_LENGTH_M;
    const hallHalfLength = UNDERGROUND_STATION_LENGTH_M * 0.5;
    const tunnelHalfWidth = PLANNER_TUNNEL_FLOOR_WIDTH_M * 0.5;
    const hallHalfWidth = UNDERGROUND_STATION_HALL_HALF_WIDTH_M;
    for (const direction of [-1, 1]) {
        const zA = direction * hallHalfLength;
        const zB = direction * (hallHalfLength + UNDERGROUND_STATION_THROAT_LENGTH_M);
        const floor = addTaperedPrism(
            throats,
            material,
            zA,
            hallHalfWidth,
            zB,
            tunnelHalfWidth,
            -0.5,
            0,
            'PlannerMetroStationTaperedThroatFloor',
        );
        floor.userData.walkableSurface = true;
        addTaperedPrism(
            throats,
            material,
            zA,
            hallHalfWidth + PLANNER_TUNNEL_WALL_THICKNESS_M * 0.5,
            zB,
            tunnelHalfWidth + PLANNER_TUNNEL_WALL_THICKNESS_M * 0.5,
            PLANNER_TUNNEL_CLEARANCE_M,
            PLANNER_TUNNEL_CLEARANCE_M + 0.45,
            'PlannerMetroStationTaperedThroatCeiling',
        );
        for (const side of [-1, 1]) {
            addTaperedThroatWall(
                throats,
                material,
                side,
                zA,
                hallHalfWidth,
                zB,
                PLANNER_TUNNEL_WALL_CENTER_OFFSET_M,
            );
        }
        const lintelHeight = UNDERGROUND_STATION_HALL_HEIGHT_M - PLANNER_TUNNEL_CLEARANCE_M;
        addBox(
            throats,
            material,
            UNDERGROUND_STATION_HALL_HALF_WIDTH_M * 2,
            lintelHeight,
            0.5,
            0,
            PLANNER_TUNNEL_CLEARANCE_M + lintelHeight * 0.5,
            zA,
            0,
            0,
            0,
            1,
        ).name = 'PlannerMetroStationThroatLintel';
    }
    groupRef.add(throats);
    return throats;
}

// The station throat ends at a compact opening while both streamed worlds use
// wider running bores. Close the annulus with a portal adapter rather than
// leaving the source world visible around the station box.
function addTunnelPortalCap(groupRef, material, z, {
    openingHalfWidthM,
    openingTopY,
    boreHalfWidthM,
    boreRoofY,
    capBottomY,
    name = 'PlannerTunnelPortalAdapter',
}) {
    const capDepthM = 0.5;
    // Two side slabs: from the throat opening out to the tunnel wall, full height.
    const sideWidthM = boreHalfWidthM - openingHalfWidthM;
    if (sideWidthM > 0.1) {
        const sideHeightM = boreRoofY - capBottomY;
        for (const side of [-1, 1]) {
            const slab = addBox(
                groupRef,
                material,
                sideWidthM,
                sideHeightM,
                capDepthM,
                side * (openingHalfWidthM + sideWidthM * 0.5),
                capBottomY + sideHeightM * 0.5,
                z,
                0,
                0,
                0,
                1,
            );
            slab.name = `${name}Side`;
        }
    }
    // Top slab: above the opening, from the opening top up to the tunnel roof.
    const topHeightM = boreRoofY - openingTopY;
    if (topHeightM > 0.1) {
        const lintel = addBox(
            groupRef,
            material,
            openingHalfWidthM * 2,
            topHeightM,
            capDepthM,
            0,
            openingTopY + topHeightM * 0.5,
            z,
            0,
            0,
            0,
            1,
        );
        lintel.name = `${name}Lintel`;
    }
}

function addPhotoTunnelPortalCap(groupRef, material, z) {
    addTunnelPortalCap(groupRef, material, z, {
        openingHalfWidthM: PLANNER_TUNNEL_FLOOR_WIDTH_M * 0.5,
        openingTopY: PLANNER_TUNNEL_CLEARANCE_M,
        boreHalfWidthM: PHOTO_CORRIDOR_HALF_WIDTH_M,
        boreRoofY: PHOTO_TUNNEL_SOURCE_ROOF_OFFSET_M,
        capBottomY: -0.5,
        name: 'PlannerPhotoTunnelPortalAdapter',
    });
}

function addModelTunnelPortalCap(groupRef, material, z, properties) {
    addTunnelPortalCap(groupRef, material, z, {
        ...getModelStationPortalAdapter(properties),
        name: 'PlannerModelTunnelPortalAdapter',
    });
}

function addPlannerIslandPortalWall(groupRef, material, z) {
    const hallWidth = PLANNER_TUNNEL_FLOOR_WIDTH_M + PLANNER_TUNNEL_WALL_THICKNESS_M;
    const openingWidth = PLANNER_TUNNEL_INNER_WIDTH_M;
    const sideWidth = Math.max(0.1, (hallWidth - openingWidth) * 0.5);
    const sideOffset = openingWidth * 0.5 + sideWidth * 0.5;
    const wallBottom = -0.25;
    const sideHeight = UNDERGROUND_STATION_HALL_HEIGHT_M - wallBottom;
    for (const side of [-1, 1]) {
        addBox(
            groupRef,
            material,
            sideWidth,
            sideHeight,
            STATION_PORTAL_DEPTH_M,
            side * sideOffset,
            (wallBottom + UNDERGROUND_STATION_HALL_HEIGHT_M) * 0.5,
            z,
            0,
            0,
            0,
            1,
        );
    }
    const lintelHeight = UNDERGROUND_STATION_HALL_HEIGHT_M - PLANNER_TUNNEL_CLEARANCE_M;
    addBox(
        groupRef,
        material,
        openingWidth,
        lintelHeight,
        STATION_PORTAL_DEPTH_M,
        0,
        PLANNER_TUNNEL_CLEARANCE_M + lintelHeight * 0.5,
        z,
        0,
        0,
        0,
        1,
    );
}

function buildPlannerIslandStationGroup(stations, { photo = false } = {}) {
    if (!stations || stations.length === 0) return null;
    const stationGroup = new THREE.Group();
    stationGroup.name = 'PlannerIslandMetroStations';
    const shellMat = new THREE.MeshStandardMaterial({
        color: 0x343b44,
        roughness: 0.94,
        metalness: 0.03,
        side: THREE.DoubleSide,
    });
    const platformMat = new THREE.MeshStandardMaterial({ color: 0x858d94, roughness: 0.9, metalness: 0.03 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xd2b64c, roughness: 0.82, metalness: 0.02 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xb8c3cf, roughness: 0.7, metalness: 0.08 });
    const lightMat = new THREE.MeshStandardMaterial({
        color: 0xfff2ca,
        emissive: 0xe4c979,
        emissiveIntensity: 1.55,
        roughness: 0.3,
        metalness: 0.08,
    });
    const portalMat = new THREE.MeshStandardMaterial({ color: 0xc6d0db, roughness: 0.52, metalness: 0.12 });
    const portalZ = UNDERGROUND_STATION_TOTAL_LENGTH_M * 0.5
        - STATION_PORTAL_DEPTH_M * 0.5;

    for (const station of stations) {
        const g = new THREE.Group();
        g.name = 'PlannerMetroIslandStationHall';
        g.userData.stopId = station.stopId;
        g.userData.level = -1;
        g.userData.platformLayout = 'island';
        g.userData.platformWidthM = UNDERGROUND_ISLAND_PLATFORM_WIDTH_M;
        g.userData.platformLengthM = UNDERGROUND_PLATFORM_LENGTH_M;
        g.userData.totalExcavatedLengthM = UNDERGROUND_STATION_TOTAL_LENGTH_M;
        g.userData.trackCenterSpacingM = UNDERGROUND_STATION_TRACK_CENTER_SPACING_M;
        g.userData.portalLayout = 'shared-double-track';
        g.userData.portalOpeningCount = 1;
        g.userData.portalOpeningWidthM = PLANNER_TUNNEL_INNER_WIDTH_M;
        g.userData.exitCount = 2;
        g.userData.stepFreeRoute = 'two-stage-lift';
        g.userData.verticalScale = 1;
        g.position.set(station.centerX, station.baseY || 0, station.centerZ);
        g.rotation.y = Math.atan2(station.alongX, station.alongZ);

        const floor = addBox(
            g,
            shellMat,
            UNDERGROUND_STATION_HALL_HALF_WIDTH_M * 2,
            0.5,
            UNDERGROUND_STATION_LENGTH_M,
            0,
            -0.25,
            0,
            0,
            0,
            0,
            1,
        );
        floor.name = 'PlannerIslandStationFloor';
        floor.userData.walkableSurface = true;
        addBox(
            g,
            shellMat,
            UNDERGROUND_STATION_HALL_HALF_WIDTH_M * 2
                + PLANNER_TUNNEL_WALL_THICKNESS_M,
            0.4,
            UNDERGROUND_STATION_LENGTH_M,
            0,
            UNDERGROUND_STATION_HALL_HEIGHT_M + 0.2,
            0,
            0,
            0,
            0,
            1,
        ).name = 'PlannerIslandStationCeiling';
        // The hall's local +X points to travel-left (local +Z is forward),
        // while access geometry expresses lateral offsets as travel-right.
        // Pair +along/right with local -X and -along/left with local +X so
        // each cross-passage actually terminates in its own bounded opening.
        const mezzanineOpenings = [
            {
                sideM: -UNDERGROUND_STATION_HALL_HALF_WIDTH_M,
                alongM: UNDERGROUND_ACCESS_CORE_ALONG_M,
            },
            {
                sideM: UNDERGROUND_STATION_HALL_HALF_WIDTH_M,
                alongM: -UNDERGROUND_ACCESS_CORE_ALONG_M,
            },
        ];
        g.userData.mezzanineOpenings = mezzanineOpenings.map(opening => ({ ...opening }));
        for (const opening of mezzanineOpenings) {
            addLongWallWithBoundedOpening(
                g,
                shellMat,
                opening.sideM,
                UNDERGROUND_STATION_HALL_HEIGHT_M,
                UNDERGROUND_STATION_LENGTH_M,
                {
                    center: opening.alongM,
                    width: UNDERGROUND_ACCESS_PASSAGE_WIDTH_M,
                    bottom: UNDERGROUND_MEZZANINE_HEIGHT_M - 0.12,
                    height: UNDERGROUND_STATION_HALL_HEIGHT_M
                        - UNDERGROUND_MEZZANINE_HEIGHT_M + 0.02,
                },
            );
        }
        addPlannerIslandPortalWall(g, shellMat, -portalZ);
        addPlannerIslandPortalWall(g, shellMat, portalZ);
        addPlannerIslandStationThroats(g, shellMat);
        // The throat's tunnel end sits at ±(hall half-length + throat length)
        // from the station centre. Both photo and model running bores are wider
        // than that compact mouth, though their exact sections differ.
        const throatEndZ = UNDERGROUND_STATION_LENGTH_M * 0.5
            + UNDERGROUND_STATION_THROAT_LENGTH_M;
        if (photo) {
            addPhotoTunnelPortalCap(g, shellMat, -throatEndZ);
            addPhotoTunnelPortalCap(g, shellMat, throatEndZ);
        } else {
            addModelTunnelPortalCap(g, shellMat, -throatEndZ, station.properties);
            addModelTunnelPortalCap(g, shellMat, throatEndZ, station.properties);
        }
        for (const side of [-1, 1]) {
            addStationNamePlates(g, station.name, {
                wallX: side * (UNDERGROUND_STATION_HALL_HALF_WIDTH_M - 0.28),
                y: 3.2,
                zs: [-17, 0, 17],
            });
        }

        const platform = addBox(
            g,
            platformMat,
            UNDERGROUND_ISLAND_PLATFORM_WIDTH_M,
            UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
            UNDERGROUND_PLATFORM_LENGTH_M,
            0,
            UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M * 0.5,
            0,
            0,
            0,
            0,
            1,
        );
        platform.name = 'PlannerIslandPlatform';
        platform.userData.walkableSurface = true;
        platform.userData.servesBothTracks = true;
        const tactileCenter = UNDERGROUND_ISLAND_PLATFORM_WIDTH_M * 0.5 - 0.22;
        for (const side of [-1, 1]) {
            addBox(
                g,
                edgeMat,
                0.36,
                0.045,
                UNDERGROUND_PLATFORM_LENGTH_M - 1,
                side * tactileCenter,
                UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M + 0.025,
                0,
                0,
                0,
                0,
                1,
            ).name = 'PlannerIslandPlatformTactileEdge';
        }
        const people = buildSeededPlatformPeopleGroup(
            `${station.name || 'station'}|${station.segmentIndex}|island`,
            0,
            0,
            0,
            UNDERGROUND_ISLAND_PLATFORM_WIDTH_M,
            UNDERGROUND_PLATFORM_LENGTH_M,
            UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M + 0.06,
        );
        if (people.children.length > 0) g.add(people);

        // Columns carry the roof, so they run platform-to-ceiling. Stopping
        // them at 5.6 m left them holding up nothing in a 9.6 m hall.
        const columnHeight = UNDERGROUND_STATION_HALL_HEIGHT_M
            - UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M;
        for (const z of [-22, 22]) {
            addBox(
                g,
                accentMat,
                0.34,
                columnHeight,
                0.34,
                0,
                UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M + columnHeight * 0.5,
                z,
                0,
                0,
                0,
                1,
            ).name = 'PlannerIslandPlatformColumn';
        }
        // Platform lighting hangs under the mezzanine walkways. A centre row
        // would hang inside the stair well that runs down the platform axis.
        for (let z = -24; z <= 24; z += 8) {
            for (const side of [-1, 1]) {
                addBox(g, lightMat, 1.4, 0.14, 1.0, side * 3.5, 5.75, z, 0, 0, 0, 1);
            }
            for (const trackOffset of [
                -UNDERGROUND_STATION_TRACK_CENTER_SPACING_M * 0.5,
                UNDERGROUND_STATION_TRACK_CENTER_SPACING_M * 0.5,
            ]) {
                addBox(g, lightMat, 0.8, 0.14, 1.5, trackOffset, 5.55, z, 0, 0, 0, 1);
            }
        }
        for (const z of [-portalZ, portalZ]) {
            addBox(
                g,
                portalMat,
                PLANNER_TUNNEL_INNER_WIDTH_M + 0.55,
                0.32,
                0.5,
                0,
                PLANNER_TUNNEL_CLEARANCE_M + 0.18,
                z,
                0,
                0,
                0,
                1,
            );
        }
        stationGroup.add(g);
    }
    return stationGroup;
}

function buildStationGroup(stations, { surfaceWorld = false } = {}) {
    if (!stations || stations.length === 0) return null;
    const stationGroup = new THREE.Group();
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x323943, roughness: 0.94, metalness: 0.03 });
    const platformMat = new THREE.MeshStandardMaterial({ color: 0x69737d, roughness: 0.88, metalness: 0.05 });
    const mezzanineMat = surfaceWorld
        ? null
        : new THREE.MeshStandardMaterial({ color: 0x4c5660, roughness: 0.86, metalness: 0.05 });
    const lightMat = new THREE.MeshStandardMaterial({
        color: 0xf4e8bf,
        emissive: 0xe0c47d,
        emissiveIntensity: 1.7,
        roughness: 0.35,
        metalness: 0.1,
    });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x6d7680, roughness: 0.58, metalness: 0.45 });
    const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x78644f, roughness: 0.95, metalness: 0.02 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xaab5c2, roughness: 0.68, metalness: 0.08 });
    const portalFrameMat = new THREE.MeshStandardMaterial({ color: 0xc7d0dc, roughness: 0.5, metalness: 0.12 });

    for (const station of stations) {
        const g = new THREE.Group();
        g.name = surfaceWorld ? 'PlannerMetroStationHall' : 'MetroStationHall';
        g.userData.stopId = station.stopId;
        g.userData.level = surfaceWorld ? -1 : 0;
        g.position.set(station.centerX, station.baseY || 0, station.centerZ);
        g.rotation.y = Math.atan2(station.alongX, station.alongZ);
        const verticalScale = surfaceWorld ? PLANNER_LEVEL_HEIGHT_M / STATION_HEIGHT_M : 1;
        g.userData.verticalScale = verticalScale;

        const trackSpacingM = surfaceWorld
            ? getTrackCenterSpacingMeters(station.properties)
            : PARALLEL_BORE_OFFSET_M;
        const trackGaugeM = getTrackGaugeMeters(station.properties);
        const playerTrackOffset = -trackSpacingM * 0.5;
        const oppositeTrackOffset = trackSpacingM * 0.5;
        const platformOffset = 3.9;
        const leftPlatformX = playerTrackOffset - platformOffset;
        const rightPlatformX = oppositeTrackOffset + platformOffset;
        const trackOffsets = [playerTrackOffset, oppositeTrackOffset];
        const platformLength = STATION_LENGTH_M - 8;
        const portalZ = STATION_LENGTH_M * 0.5 - STATION_PORTAL_DEPTH_M * 0.5;
        const mezzanineDepth = 18;
        const leftPlatformInnerEdgeX = leftPlatformX + PLATFORM_WIDTH_M * 0.5 - 0.22;
        const rightPlatformInnerEdgeX = rightPlatformX - PLATFORM_WIDTH_M * 0.5 + 0.22;
        const leftPlatformOuterWallX = leftPlatformX - PLATFORM_WIDTH_M * 0.5 - 0.45;
        const rightPlatformOuterWallX = rightPlatformX + PLATFORM_WIDTH_M * 0.5 + 0.45;
        const portalOpenings = getStationPortalOpenings(surfaceWorld, trackOffsets);
        g.userData.portalLayout = surfaceWorld ? 'shared-double-track' : 'parallel-bores';
        g.userData.portalOpeningCount = portalOpenings.length;
        g.userData.portalOpeningWidthM = portalOpenings[0]?.width || 0;

        const stationFloor = addBox(
            g,
            shellMat,
            STATION_WIDTH_M,
            0.5,
            STATION_LENGTH_M,
            0,
            -0.25,
            0,
        );
        stationFloor.userData.walkableSurface = true;
        addBox(g, shellMat, STATION_WIDTH_M, 0.5, STATION_LENGTH_M, 0, STATION_HEIGHT_M - 0.25, 0);
        if (surfaceWorld) {
            addLongWallWithCentralOpening(
                g,
                shellMat,
                0.5,
                STATION_HEIGHT_M,
                STATION_LENGTH_M,
                -STATION_WIDTH_M * 0.5,
                STATION_HEIGHT_M * 0.5 - 0.25,
                STATION_STAIR_WIDTH_M + 1,
            );
            addBox(g, shellMat, 0.5, STATION_HEIGHT_M, STATION_LENGTH_M, STATION_WIDTH_M * 0.5, STATION_HEIGHT_M * 0.5 - 0.25, 0);
        } else {
            addBox(g, shellMat, 0.5, STATION_HEIGHT_M, STATION_LENGTH_M, -STATION_WIDTH_M * 0.5, STATION_HEIGHT_M * 0.5 - 0.25, 0);
            addBox(g, shellMat, 0.5, STATION_HEIGHT_M, STATION_LENGTH_M, STATION_WIDTH_M * 0.5, STATION_HEIGHT_M * 0.5 - 0.25, 0);
        }
        addStationPortalWall(g, shellMat, -portalZ, portalOpenings);
        addStationPortalWall(g, shellMat, portalZ, portalOpenings);
        if (surfaceWorld) addPlannerStationPortalThroats(g, shellMat, portalOpenings);
        for (const side of [-1, 1]) {
            // The planner hall's -X wall has a full-height central stair
            // opening — no plate can hang over that gap.
            const zsForWall = (surfaceWorld && side < 0) ? [-17, 17] : [-17, 0, 17];
            addStationNamePlates(g, station.name, {
                // y is in FINAL metres (not pre-squash): eye-level plates in
                // both the 24 m legacy hall and the squashed planner hall.
                wallX: side * (STATION_WIDTH_M * 0.5 - 0.28),
                y: 2.7,
                zs: zsForWall,
            });
        }

        const leftPlatform = addBox(g, platformMat, PLATFORM_WIDTH_M, PLATFORM_HEIGHT_M, platformLength, leftPlatformX, PLATFORM_HEIGHT_M * 0.5, 0);
        const rightPlatform = addBox(g, platformMat, PLATFORM_WIDTH_M, PLATFORM_HEIGHT_M, platformLength, rightPlatformX, PLATFORM_HEIGHT_M * 0.5, 0);
        leftPlatform.userData.walkableSurface = true;
        rightPlatform.userData.walkableSurface = true;
        const leftPeopleGroup = buildSeededPlatformPeopleGroup(
            `${station.name || 'station'}|${station.segmentIndex}|left`,
            leftPlatformX,
            0,
            0,
            PLATFORM_WIDTH_M,
            platformLength,
            PLATFORM_HEIGHT_M * verticalScale + 0.06,
        );
        if (leftPeopleGroup.children.length > 0) g.add(leftPeopleGroup);
        const rightPeopleGroup = buildSeededPlatformPeopleGroup(
            `${station.name || 'station'}|${station.segmentIndex}|right`,
            rightPlatformX,
            0,
            0,
            PLATFORM_WIDTH_M,
            platformLength,
            PLATFORM_HEIGHT_M * verticalScale + 0.06,
        );
        if (rightPeopleGroup.children.length > 0) g.add(rightPeopleGroup);
        addBox(g, accentMat, 0.42, 1.35, platformLength - 1.5, leftPlatformInnerEdgeX, 0.7, 0);
        addBox(g, accentMat, 0.42, 1.35, platformLength - 1.5, rightPlatformInnerEdgeX, 0.7, 0);
        addBox(g, lightMat, 0.16, 0.14, platformLength - 1.5, leftPlatformInnerEdgeX - 0.16, PLATFORM_HEIGHT_M + 0.12, 0);
        addBox(g, lightMat, 0.16, 0.14, platformLength - 1.5, rightPlatformInnerEdgeX + 0.16, PLATFORM_HEIGHT_M + 0.12, 0);
        if (surfaceWorld) {
            addLongWallWithCentralOpening(
                g,
                shellMat,
                0.9,
                4.6,
                platformLength,
                leftPlatformOuterWallX,
                2.3,
                STATION_STAIR_WIDTH_M + 0.8,
            );
            addBox(g, shellMat, 0.9, 4.6, platformLength, rightPlatformOuterWallX, 2.3, 0);
        } else {
            addBox(g, shellMat, 0.9, 4.6, platformLength, leftPlatformOuterWallX, 2.3, 0);
            addBox(g, shellMat, 0.9, 4.6, platformLength, rightPlatformOuterWallX, 2.3, 0);
        }
        // The legacy hall is 24 m tall and has a mid-height mezzanine. A
        // planner -1 hall is compressed to 10 m, where that slab lands
        // directly through the street staircase; keep it only in the original
        // full-height underground scene.
        if (!surfaceWorld) {
            addBox(g, mezzanineMat, STATION_WIDTH_M - 8, 0.55, 3.8, 0, STATION_MEZZANINE_Y_M, -8);
            addBox(g, mezzanineMat, STATION_WIDTH_M - 8, 0.55, 3.8, 0, STATION_MEZZANINE_Y_M, 8);
            addBox(g, mezzanineMat, STATION_WIDTH_M - 10, 0.45, mezzanineDepth, 0, STATION_MEZZANINE_Y_M, 0);
            addBox(g, shellMat, 0.7, 6.2, mezzanineDepth + 2, -5.4, STATION_MEZZANINE_Y_M + 2.9, 0);
            addBox(g, shellMat, 0.7, 6.2, mezzanineDepth + 2, 5.4, STATION_MEZZANINE_Y_M + 2.9, 0);
            addBox(g, lightMat, STATION_WIDTH_M - 12, 0.14, 0.9, 0, STATION_MEZZANINE_Y_M + 2.7, -8);
            addBox(g, lightMat, STATION_WIDTH_M - 12, 0.14, 0.9, 0, STATION_MEZZANINE_Y_M + 2.7, 8);
        }

        for (const opening of portalOpenings) {
            for (const z of [-portalZ, portalZ]) {
                const openingHeight = opening.height;
                const verticalScaleOverride = surfaceWorld ? 1 : null;
                const columnHeight = surfaceWorld ? openingHeight + 0.45 : openingHeight + 1.8;
                const columnY = openingHeight * 0.5 - 0.1;
                const lintelY = surfaceWorld ? openingHeight + 0.18 : openingHeight + 0.7;
                const portalLightY = surfaceWorld ? openingHeight - 0.18 : openingHeight + 0.5;
                addBox(g, portalFrameMat, 0.42, columnHeight, 0.55, opening.centerX - opening.width * 0.5 - 0.28, columnY, z, 0, 0, 0, verticalScaleOverride);
                addBox(g, portalFrameMat, 0.42, columnHeight, 0.55, opening.centerX + opening.width * 0.5 + 0.28, columnY, z, 0, 0, 0, verticalScaleOverride);
                addBox(g, portalFrameMat, opening.width + 1.1, 0.42, 0.55, opening.centerX, lintelY, z, 0, 0, 0, verticalScaleOverride);
                addBox(g, lightMat, opening.width + 0.5, 0.14, 0.38, opening.centerX, portalLightY, z, 0, 0, 0, verticalScaleOverride);
            }
        }

        for (let z = -STATION_LENGTH_M * 0.5 + 8; z <= STATION_LENGTH_M * 0.5 - 8 + 1e-6; z += STATION_LIGHT_SPACING_M) {
            addBox(g, lightMat, STATION_WIDTH_M - 12, 0.16, 0.82, 0, STATION_HEIGHT_M - 1.4, z);
            addBox(g, lightMat, 1.0, 0.16, 2.2, playerTrackOffset, STATION_HEIGHT_M - 1.9, z);
            addBox(g, lightMat, 1.0, 0.16, 2.2, oppositeTrackOffset, STATION_HEIGHT_M - 1.9, z);
        }
        if (surfaceWorld) {
            addLongWallWithCentralOpening(
                g,
                lightMat,
                0.18,
                0.18,
                platformLength - 2,
                leftPlatformOuterWallX + 0.18,
                5.2,
                STATION_STAIR_WIDTH_M + 0.8,
            );
        } else {
            addBox(g, lightMat, 0.18, 0.18, platformLength - 2, leftPlatformOuterWallX + 0.18, 5.2, 0);
        }
        addBox(g, lightMat, 0.18, 0.18, platformLength - 2, rightPlatformOuterWallX - 0.18, 5.2, 0);

        for (let z = -STATION_LENGTH_M * 0.5 + 6; z <= STATION_LENGTH_M * 0.5 - 6 + 1e-6; z += 6) {
            const insideStairOpening = surfaceWorld
                && Math.abs(z) <= (STATION_STAIR_WIDTH_M + 1) * 0.5;
            if (!insideStairOpening) {
                addBox(g, accentMat, 0.08, STATION_HEIGHT_M - 1.8, 0.18, -STATION_WIDTH_M * 0.5 + 0.22, STATION_HEIGHT_M * 0.5 - 0.4, z);
            }
            addBox(g, accentMat, 0.08, STATION_HEIGHT_M - 1.8, 0.18, STATION_WIDTH_M * 0.5 - 0.22, STATION_HEIGHT_M * 0.5 - 0.4, z);
        }

        const stationRailLength = STATION_LENGTH_M - 1.2;
        // In planner coordinates local -X is the route's geographic right:
        // this is the parallel return bore that the generic rails layer does
        // not draw. Local +X is the supplied route itself and is omitted in
        // surface-world mode to avoid drawing those rails twice.
        if (!surfaceWorld) {
            addBox(g, railMat, RAIL_WIDTH_M, RAIL_HEIGHT_M, stationRailLength, playerTrackOffset - trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, 0);
            addBox(g, railMat, RAIL_WIDTH_M, RAIL_HEIGHT_M, stationRailLength, playerTrackOffset + trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, 0);
            addBox(g, railMat, RAIL_WIDTH_M, RAIL_HEIGHT_M, stationRailLength, oppositeTrackOffset - trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, 0);
            addBox(g, railMat, RAIL_WIDTH_M, RAIL_HEIGHT_M, stationRailLength, oppositeTrackOffset + trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, 0);
            for (let z = -stationRailLength * 0.5 + 1.3; z <= stationRailLength * 0.5 - 1.3 + 1e-6; z += SLEEPER_SPACING_M) {
                addBox(g, sleeperMat, SLEEPER_WIDTH_M, SLEEPER_HEIGHT_M, SLEEPER_DEPTH_M, playerTrackOffset, SLEEPER_HEIGHT_M * 0.5 - 0.01, z);
                addBox(g, sleeperMat, SLEEPER_WIDTH_M, SLEEPER_HEIGHT_M, SLEEPER_DEPTH_M, oppositeTrackOffset, SLEEPER_HEIGHT_M * 0.5 - 0.01, z);
            }
        }

        stationGroup.add(g);
    }
    return stationGroup;
}

function buildUndergroundScene(features, stops, anchorLat, anchorLon) {
    const routeSegments = buildRouteSegments(features, anchorLat, anchorLon);
    if (routeSegments.length === 0) return null;
    const stations = buildStationDescriptors(stops, routeSegments, anchorLat, anchorLon);

    const floorBoxes = [];
    const ceilingBoxes = [];
    const wallBoxes = [];
    const lightBoxes = [];
    const railBoxes = [];
    const sleeperBoxes = [];
    const wallJointBoxes = [];
    const wallPatternBoxes = [];
    const boreOffsets = [0, PARALLEL_BORE_OFFSET_M];
    const wallOffsets = [
        -(TUNNEL_HALF_WIDTH_M + TUNNEL_SHELL_THICKNESS_M * 0.5),
        TUNNEL_HALF_WIDTH_M + TUNNEL_SHELL_THICKNESS_M * 0.5,
    ];

    for (const segment of routeSegments) {
        for (const tunnelSpan of buildTunnelSpansForSegment(segment, stations)) {
            const shellDepth = tunnelSpan.length + 0.5;
            const railDepth = tunnelSpan.length + 0.2;
            const trackGaugeM = getTrackGaugeMeters(tunnelSpan.properties);
            for (const boreOffset of boreOffsets) {
                pushBox(floorBoxes, tunnelSpan, boreOffset, 0, -0.20, TUNNEL_HALF_WIDTH_M * 2, 0.4, shellDepth);
                pushBox(ceilingBoxes, tunnelSpan, boreOffset, 0, TUNNEL_HEIGHT_M - 0.20, TUNNEL_HALF_WIDTH_M * 2, 0.4, shellDepth);
                pushBox(wallBoxes, tunnelSpan, boreOffset, wallOffsets[0], TUNNEL_HEIGHT_M * 0.5 - 0.20, TUNNEL_SHELL_THICKNESS_M, TUNNEL_HEIGHT_M, shellDepth);
                pushBox(wallBoxes, tunnelSpan, boreOffset, wallOffsets[1], TUNNEL_HEIGHT_M * 0.5 - 0.20, TUNNEL_SHELL_THICKNESS_M, TUNNEL_HEIGHT_M, shellDepth);
                pushBox(railBoxes, tunnelSpan, boreOffset, -trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, RAIL_WIDTH_M, RAIL_HEIGHT_M, railDepth);
                pushBox(railBoxes, tunnelSpan, boreOffset, trackGaugeM * 0.5, RAIL_HEIGHT_M * 0.5, RAIL_WIDTH_M, RAIL_HEIGHT_M, railDepth);
                pushRepeatedAlongSegment(
                    sleeperBoxes,
                    tunnelSpan,
                    boreOffset,
                    0,
                    SLEEPER_HEIGHT_M * 0.5 - 0.01,
                    SLEEPER_WIDTH_M,
                    SLEEPER_HEIGHT_M,
                    SLEEPER_DEPTH_M,
                    SLEEPER_SPACING_M,
                    1.1,
                    SLEEPER_JITTER_M,
                );
                pushRepeatedAlongSegment(
                    lightBoxes,
                    tunnelSpan,
                    boreOffset,
                    0,
                    TUNNEL_HEIGHT_M - 0.72,
                    LIGHT_FIXTURE_WIDTH_M,
                    LIGHT_FIXTURE_HEIGHT_M,
                    LIGHT_FIXTURE_DEPTH_M,
                    LIGHT_FIXTURE_SPACING_M,
                    1.5,
                );
                for (const wallOffset of wallOffsets) {
                    const patternOffset = getWallPatternOffset(wallOffset);
                    pushBox(
                        wallPatternBoxes,
                        tunnelSpan,
                        boreOffset,
                        patternOffset,
                        1.5,
                        WALL_PATTERN_DEPTH_M,
                        WALL_PATTERN_BAND_HEIGHT_M,
                        tunnelSpan.length,
                    );
                    pushBox(
                        wallPatternBoxes,
                        tunnelSpan,
                        boreOffset,
                        patternOffset,
                        4.25,
                        WALL_PATTERN_DEPTH_M,
                        WALL_PATTERN_BAND_HEIGHT_M,
                        tunnelSpan.length,
                    );
                    pushRepeatedAlongSegment(
                        wallPatternBoxes,
                        tunnelSpan,
                        boreOffset,
                        patternOffset,
                        2.35,
                        WALL_PATTERN_DEPTH_M,
                        WALL_PATTERN_PANEL_HEIGHT_M,
                        WALL_PATTERN_PANEL_LENGTH_M,
                        WALL_PATTERN_PANEL_SPACING_M,
                        1.6,
                    );
                    pushRepeatedAlongSegment(
                        wallPatternBoxes,
                        tunnelSpan,
                        boreOffset,
                        patternOffset,
                        3.85,
                        WALL_PATTERN_DEPTH_M,
                        WALL_PATTERN_PANEL_HEIGHT_M * 0.78,
                        WALL_PATTERN_PANEL_LENGTH_M * 0.72,
                        WALL_PATTERN_PANEL_SPACING_M,
                        4.6,
                    );
                    pushRepeatedAlongSegment(
                        wallJointBoxes,
                        tunnelSpan,
                        boreOffset,
                        wallOffset,
                        TUNNEL_HEIGHT_M * 0.5 - 0.05,
                        WALL_JOINT_WIDTH_M,
                        WALL_JOINT_HEIGHT_M,
                        WALL_JOINT_DEPTH_M,
                        WALL_JOINT_SPACING_M,
                        1.2,
                    );
                }
            }
        }
    }

    const sceneGroup = new THREE.Group();
    sceneGroup.name = 'UndergroundLineScene';

    const floorMesh = buildInstancedBoxes(floorBoxes, { color: 0x16191d, roughness: 0.98, metalness: 0.02 });
    const ceilingMesh = buildInstancedBoxes(ceilingBoxes, { color: 0x1f2429, roughness: 0.96, metalness: 0.03 });
    const wallMesh = buildInstancedBoxes(wallBoxes, { color: 0x22272d, roughness: 0.96, metalness: 0.02 });
    const wallJointMesh = buildInstancedBoxes(wallJointBoxes, { color: 0x353c44, roughness: 0.92, metalness: 0.03 });
    const wallPatternMesh = buildInstancedBoxes(wallPatternBoxes, { color: 0x434b55, roughness: 0.9, metalness: 0.04 });
    const lightMesh = buildInstancedBoxes(lightBoxes, {
        color: 0xf0dcab,
        emissive: 0xd7b661,
        emissiveIntensity: 1.25,
        roughness: 0.35,
        metalness: 0.08,
    });
    const railMesh = buildInstancedBoxes(railBoxes, { color: 0x6d7680, roughness: 0.58, metalness: 0.45 });
    const sleeperMesh = buildInstancedBoxes(sleeperBoxes, { color: 0x78644f, roughness: 0.95, metalness: 0.02 });

    if (floorMesh) {
        floorMesh.userData.walkableSurface = true;
        sceneGroup.add(floorMesh);
    }
    if (ceilingMesh) sceneGroup.add(ceilingMesh);
    if (wallMesh) sceneGroup.add(wallMesh);
    if (wallJointMesh) sceneGroup.add(wallJointMesh);
    if (wallPatternMesh) sceneGroup.add(wallPatternMesh);
    if (lightMesh) sceneGroup.add(lightMesh);
    if (railMesh) sceneGroup.add(railMesh);
    if (sleeperMesh) sceneGroup.add(sleeperMesh);

    const stationsGroup = buildStationGroup(stations);
    if (stationsGroup) sceneGroup.add(stationsGroup);

    return sceneGroup;
}

function combinePlannerCoveredStationGeometry(plans, fieldNames) {
    const fields = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
    const combined = {
        positions: [],
        colors: [],
        indices: [],
        wallColliders: [],
    };
    for (const plan of plans || []) {
        for (const fieldName of fields) {
            const data = plan?.sweep?.[fieldName];
            if (!data?.positions?.length || !data?.indices?.length) continue;
            const vertexOffset = combined.positions.length / 3;
            combined.positions.push(...data.positions);
            if (data.colors?.length) combined.colors.push(...data.colors);
            combined.indices.push(...data.indices.map(index => index + vertexOffset));
        }
        if (fields.includes('shell')) {
            combined.wallColliders.push(...(plan?.sweep?.wallColliders || []));
        }
    }
    return combined;
}

function buildPlannerCoveredMesh(data, material, {
    name,
    vertexColors = false,
    walkableSurface = false,
    wallColliders = null,
} = {}) {
    if (!data?.positions?.length || !data?.indices?.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    if (vertexColors && data.colors?.length === data.positions.length) {
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
    }
    geometry.setIndex(data.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    if (walkableSurface) mesh.userData.walkableSurface = true;
    if (wallColliders?.length) mesh.userData.walkColliderBoxes = wallColliders;
    return mesh;
}

// Curved or graded model stations cannot be represented by the legacy rigid
// island box. Render the same route-owned sweep used by the photo fallback,
// but with a gauge-derived endpoint section that exactly meets the model bore.
function buildPlannerCoveredStationGroup(plans) {
    if (!plans?.length) return null;
    const stationGroup = new THREE.Group();
    stationGroup.name = 'PlannerRouteCoveredStations';
    stationGroup.userData.coveredStationCount = plans.length;
    stationGroup.userData.stopIds = plans
        .map(plan => plan.stationId)
        .filter(stopId => stopId != null);

    const shell = combinePlannerCoveredStationGeometry(plans, 'shell');
    if (shell.positions.length > 0) {
        const shellMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.94,
            metalness: 0.02,
            flatShading: true,
            side: THREE.DoubleSide,
        });
        const shellMesh = buildPlannerCoveredMesh(shell, shellMaterial, {
            name: 'PlannerRouteCoveredStationShell',
            vertexColors: true,
            wallColliders: shell.wallColliders,
        });
        if (shellMesh) stationGroup.add(shellMesh);
    }

    const lights = combinePlannerCoveredStationGeometry(plans, 'light');
    if (lights.positions.length > 0) {
        const lightMaterial = new THREE.MeshBasicMaterial({
            color: 0xffe9b8,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const lightMesh = buildPlannerCoveredMesh(lights, lightMaterial, {
            name: 'PlannerRouteCoveredStationLights',
        });
        if (lightMesh) stationGroup.add(lightMesh);
    }

    const platform = combinePlannerCoveredStationGeometry(plans, ['platform', 'identity']);
    if (platform.positions.length > 0) {
        const platformMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.9,
            metalness: 0.02,
            flatShading: true,
            side: THREE.DoubleSide,
        });
        const platformMesh = buildPlannerCoveredMesh(platform, platformMaterial, {
            name: 'PlannerRouteCoveredStationPlatform',
            vertexColors: true,
            walkableSurface: true,
        });
        if (platformMesh) stationGroup.add(platformMesh);
    }

    for (const plan of plans) {
        const board = plan?.sweep?.nameBoard;
        if (!board?.positions?.length || !board?.indices?.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(board.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(board.uvs, 2));
        geometry.setIndex(board.indices);
        geometry.computeBoundingSphere();
        const material = new THREE.MeshBasicMaterial({
            map: getStopNameSignTexture(board.label),
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'PlannerRouteCoveredStationNameBoard';
        mesh.userData.stopId = plan.stationId;
        mesh.frustumCulled = false;
        stationGroup.add(mesh);
    }
    return stationGroup.children.length > 0 ? stationGroup : null;
}

function buildPlannerUndergroundStations(
    features,
    stops,
    anchorLat,
    anchorLon,
    photoTrackFrame = null,
    terrainReference = null,
) {
    // Model-mode tracks on a terrain world author their heights as absolute
    // EVRF2000; the scene is not in that frame. This is the same conversion the
    // rail formation rides (absoluteSceneYAtHeight), so the station box lands on
    // its own rails instead of a hundred metres above them.
    const absoluteToSceneY = terrainReference
        && typeof terrainReference.absoluteToSceneY === 'function'
        ? (heightM) => terrainReference.absoluteToSceneY(heightM)
        : null;
    const routeSegments = buildRouteSegments(features, anchorLat, anchorLon, {
        surfaceWorld: true,
        photoTrackFrame,
        absoluteToSceneY,
    });
    if (routeSegments.length === 0) return null;
    const stations = buildStationDescriptors(
        stops,
        routeSegments,
        anchorLat,
        anchorLon,
        {
            surfaceWorld: true,
            photoTrackFrame,
            absoluteToSceneY,
            stopLevel: (stop) => {
                if (!photoTrackFrame || stop?.trackId == null) return getPlannerStopLevel(stop);
                const structure = getPhotorealStationStructure(stop);
                if (structure === 'tunnel') {
                    return canBuildPhotorealRigidStation(stop) ? -1 : null;
                }
                if (structure === 'viaduct') return 1;
                if (structure === 'formation') return 0;
                return null;
            },
        },
    );
    if (stations.length === 0) return null;
    const sceneGroup = new THREE.Group();
    sceneGroup.name = 'PlannerUndergroundStations';
    const coveredPlans = photoTrackFrame
        ? new Map()
        : new Map(stations.map((station) => [
            station,
            buildModelCoveredStationPlan(station.routeAnchor, {
                platformSideM: getPlannerPlatformSideOffsetM(station.properties),
                stationName: station.name,
                stationId: station.stopId,
                trackProperties: station.properties,
            }),
        ]).filter(([, plan]) => !!plan));
    const rigidStations = stations.filter(station => !coveredPlans.has(station));
    const stationsGroup = buildPlannerIslandStationGroup(
        rigidStations,
        { photo: !!photoTrackFrame },
    );
    if (stationsGroup) sceneGroup.add(stationsGroup);
    const coveredGroup = buildPlannerCoveredStationGroup([...coveredPlans.values()]);
    if (coveredGroup) sceneGroup.add(coveredGroup);
    return sceneGroup;
}

export const undergroundLayer = {
    beginSession({
        anchorLat,
        anchorLon,
        otherTracks,
        allStops,
        isUndergroundSession,
        photoTrackFrame,
        terrain,
    }) {
        plannerSession = !isUndergroundSession ? {
            features: otherTracks || [],
            stops: allStops || [],
            anchorLat,
            anchorLon,
            photoTrackFrame: photoTrackFrame || null,
            terrain: terrain || null,
        } : null;
        photoStationStructureRevision = getPhotorealStationStructureRevision();
        group = isUndergroundSession
            ? buildUndergroundScene(otherTracks || [], allStops || [], anchorLat, anchorLon)
            : buildPlannerUndergroundStations(
                otherTracks || [],
                allStops || [],
                anchorLat,
                anchorLon,
                photoTrackFrame || null,
                terrain || null,
            );
        if (group) scene.add(group);
    },
    onFrame() {
        if (!plannerSession?.photoTrackFrame || !isPhotorealRevealed()) return;
        const revision = getPhotorealStationStructureRevision();
        if (revision === photoStationStructureRevision) return;
        photoStationStructureRevision = revision;
        if (group) {
            disposeGroup(group);
            group = null;
        }
        group = buildPlannerUndergroundStations(
            plannerSession.features,
            plannerSession.stops,
            plannerSession.anchorLat,
            plannerSession.anchorLon,
            plannerSession.photoTrackFrame,
            plannerSession.terrain,
        );
        if (group) scene.add(group);
    },
    endSession() {
        plannerSession = null;
        photoStationStructureRevision = 0;
        if (group) {
            disposeGroup(group);
            group = null;
        }
    },
};
