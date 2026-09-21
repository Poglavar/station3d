// Animated passengers boarding/alighting trams when a tram is detected at
// a platform. Per-frame: scans tram poses, finds each tram's closest stop,
// and on a "just arrived at stop" transition spawns a few walking people:
//   * boarding people start at random platform positions and walk to the
//     tram's right-side door, target is recomputed each frame so they
//     follow a slowly-moving tram and "get on" when they arrive.
//   * alighting people start at the tram door and walk to a random spot
//     off the platform, then despawn.
// Only trams within VISIBILITY_RADIUS_M of the camera get processed, and
// total walking people is hard-capped to keep render cost flat.

import * as THREE from 'three';
import {
    boardingPlatformFeetY,
    platformFeetSceneY,
    boardingPointToScene,
    boardingPoseToScene,
    shouldSuppressPhotoStationBoarding,
} from '../core/photo-boarding-placement.js';
import { inferPlatformSideSign } from '../core/boarding-platform-side.js';
import { scene, camera } from '../scene/setup.js';
import { animatePersonWalk, createPersonMesh, createRandomPersonMesh } from './person-mesh.js';
import {
    getPlannerStopLevel,
    PLATFORM_TOP_OFFSET_M,
    PLANNER_LEVEL_HEIGHT_M,
} from './planner-station-layout.js';
import {
    canBuildPhotorealRigidStation,
    getPhotorealStationStructure,
} from './photoreal.js';
import { getTerrainReference } from './terrain.js';
import { createPointSpatialIndex } from '../core/point-spatial-index.js';

// ─── Constants ─────────────────────────────────────────────────────────────

// Tram dimensions — must match world/vehicles/tram.js BODY_W and DOOR_OFFSETS_Z.
const TRAM_BODY_W = 2.4;
const TRAM_DOOR_OFFSETS_Z = [-3.96, +3.96];   // BODY_L * 0.22 with BODY_L = 18
// Where boarders aim — just outside the door so they don't slip inside the
// tram body before "getting on".
const DOOR_APPROACH_OFFSET = 0.4;

// Person walking + spawn parameters.
const PERSON_SPEED = 1.25;            // m/s, brisk walk
const STOP_PROXIMITY_M = 9;
const VISIBILITY_RADIUS_M = 200;
const ARRIVAL_RADIUS_M = 0.4;
const SURFACE_PLATFORM_FEET_Y = 0.06;
const MAX_ANIM_PEOPLE = 36;
const BOARD_PROB_PER_DOOR = 0.55;
const ALIGHT_PROB_PER_DOOR = 0.55;
const PLATFORM_SPAWN_RADIUS = 4;
const ALIGHT_TARGET_RADIUS = 7;
const STOP_SPATIAL_CELL_M = 32;

function getStopTrackHeight(stop) {
    const level = getPlannerStopLevel(stop);
    return Number.isFinite(stop?.elevM)
        ? stop.elevM
        : level * PLANNER_LEVEL_HEIGHT_M;
}

function stopScenePoint(stop) {
    return boardingPointToScene({
        lon: stop?.lng ?? stop?.lon,
        lat: stop?.lat,
        relativeHeightM: getStopTrackHeight(stop),
        anchorLon,
        anchorLat,
        photoTrackFrame,
    });
}

function getPlatformFeetState(stop) {
    const level = getPlannerStopLevel(stop);
    const platformOffsetM = level === 0 ? SURFACE_PLATFORM_FEET_Y : PLATFORM_TOP_OFFSET_M;
    const feetY = boardingPlatformFeetY({
        lon: stop?.lng ?? stop?.lon,
        lat: stop?.lat,
        trackRelativeHeightM: getStopTrackHeight(stop),
        platformOffsetM,
        anchorLon,
        anchorLat,
        photoTrackFrame,
    });
    // In the DGU terrain world, lift the crowd onto the terrain at the stop
    // (0 when flat). The photo world already grounds via photoTrackFrame, so
    // skip the DGU add there to avoid double-counting.
    if (photoTrackFrame) return { y: feetY, terrainRelative: false };
    // stop.elevM is ABSOLUTE EVRF2000 a.s.l., not a height above the ground.
    // Adding the terrain's scene-Y on top of it counts the ground twice and puts
    // the crowd tens of metres in the air: a level-0 surface stop in Split
    // measured elevM 41.12 + terrain 1.02 = a platform at 42.20. This is the
    // same failure platforms.js already fixes for station shelters ("floating
    // tens of metres up") — convert once, the way the rail formation does.
    //
    // It only became reachable when the planner cab started passing absolute
    // elevations at all; before that every stop carried level x LEVEL_HEIGHT,
    // which genuinely IS relative to the ground, and the add below was right.
    const reference = getTerrainReference();
    if (Number.isFinite(stop?.elevM)
        && typeof reference?.absoluteToSceneY === 'function') {
        const absoluteY = reference.absoluteToSceneY(stop.elevM);
        if (typeof absoluteY === 'number' && Number.isFinite(absoluteY)) {
            return { y: absoluteY + platformOffsetM, terrainRelative: false };
        }
    }
    const sp = stopScenePoint(stop);
    const terrainY = reference
        ? reference.evidenceSceneYAtLocal?.(sp.x, sp.z)
        : 0;
    if (typeof terrainY !== 'number' || !Number.isFinite(terrainY)) {
        return { y: null, terrainRelative: true };
    }
    return {
        y: platformFeetSceneY({
            platformOffsetM,
            relativeFeetY: feetY,
            terrainSceneY: terrainY,
        }),
        terrainRelative: true,
    };
}

function terrainEvidenceReadyAt(x, z) {
    const reference = getTerrainReference();
    if (!reference) return true;
    const y = reference.evidenceSceneYAtLocal?.(x, z);
    return typeof y === 'number' && Number.isFinite(y);
}

function suppressCoveredStationActors(stop) {
    if (!photoTrackFrame || stop?.trackId == null) return false;
    return shouldSuppressPhotoStationBoarding({
        hasPhotoFrame: true,
        stopTrackId: stop?.trackId,
        runtimeStructure: getPhotorealStationStructure(stop),
        rigidStructure: canBuildPhotorealRigidStation(stop),
    });
}

// ─── Session state ─────────────────────────────────────────────────────────

let anchorLat = 0, anchorLon = 0;
let stops = [];
let otherTrainsFn = null;
let group = null;
let photoTrackFrame = null;
const stopSpatialIndex = createPointSpatialIndex(STOP_SPATIAL_CELL_M);

// tramId → stop reference (or null when the tram has left the stop area)
const tramAtStopState = new Map();
// Active walking people; updated/despawned each frame.
const animPeople = [];

// ─── Tram door world position ──────────────────────────────────────────────

// Tram local coords (right side door): x = +TRAM_BODY_W/2 + offset, z = ±DOOR_Z.
// Tram mesh has rotation.y = -headingRad. Map local door to world.
function tramDoorWorldXZ(tramPose, doorIdx, layout = null) {
    const local = boardingPoseToScene({
        lon: tramPose.lon,
        lat: tramPose.lat,
        relativeHeightM: tramPose.y,
        headingDeg: tramPose.headingDeg,
        anchorLon,
        anchorLat,
        photoTrackFrame,
    });
    const theta = -local.headingDeg * Math.PI / 180;
    const c = Math.cos(theta), s = Math.sin(theta);
    const bodyWidthM = Number(layout?.bodyWidthM) || TRAM_BODY_W;
    const doorOffsets = Array.isArray(layout?.doorOffsetsZ) && layout.doorOffsetsZ.length
        ? layout.doorOffsetsZ
        : TRAM_DOOR_OFFSETS_Z;
    const sideSign = Number(layout?.sideSign) < 0 ? -1 : 1;
    const lx = sideSign * (bodyWidthM / 2 + DOOR_APPROACH_OFFSET);
    const lz = doorOffsets[doorIdx % doorOffsets.length];
    return {
        x: local.x + lx * c + lz * s,
        z: local.z - lx * s + lz * c,
    };
}

// ─── Spawn / despawn ───────────────────────────────────────────────────────

function spawnAnim({
    x,
    z,
    y,
    target,
    trackTramId,
    trackDoorIdx,
    role,
    appearance,
    terrainRelative = false,
}) {
    if (animPeople.length >= MAX_ANIM_PEOPLE) return;
    const mesh = appearance ? createPersonMesh(appearance) : createRandomPersonMesh();
    mesh.position.set(x, y, z);
    group.add(mesh);
    animPeople.push({
        mesh, x, y, z, target,
        trackTramId: trackTramId || null,
        trackDoorIdx: trackDoorIdx != null ? trackDoorIdx : 0,
        speed: PERSON_SPEED,
        stride: Math.random() * Math.PI * 2,
        role,
        terrainRelative,
    });
}

function despawnAnim(p) {
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    // Geometry + material are shared (registered via registerShared) so we
    // don't dispose them here — only the per-person Group is removed.
}

function removeBoardingForTram(tramId) {
    for (let i = animPeople.length - 1; i >= 0; i--) {
        const p = animPeople[i];
        if (p.role === 'boarding' && p.trackTramId === tramId) {
            despawnAnim(p);
            animPeople.splice(i, 1);
        }
    }
}

function spawnBoardingAlighting(tramPose, stop) {
    if (suppressCoveredStationActors(stop)) return { boarded: 0, alighted: 0 };
    const stopLocal = stopScenePoint(stop);
    let boarded = 0;
    let alighted = 0;
    const platformFeet = getPlatformFeetState(stop);
    if (platformFeet.y === null) return { boarded: 0, alighted: 0 };
    const platformFeetY = platformFeet.y;

    for (let doorIdx = 0; doorIdx < TRAM_DOOR_OFFSETS_Z.length; doorIdx++) {
        const door = tramDoorWorldXZ(tramPose, doorIdx);

        if (Math.random() < BOARD_PROB_PER_DOOR) {
            spawnAnim({
                x: stopLocal.x + (Math.random() - 0.5) * PLATFORM_SPAWN_RADIUS * 2,
                z: stopLocal.z + (Math.random() - 0.5) * PLATFORM_SPAWN_RADIUS * 2,
                y: platformFeetY,
                target: door,
                trackTramId: tramPose.id,
                trackDoorIdx: doorIdx,
                role: 'boarding',
                terrainRelative: platformFeet.terrainRelative,
            });
            boarded += 1;
        }

        if (Math.random() < ALIGHT_PROB_PER_DOOR) {
            spawnAnim({
                x: door.x, z: door.z, y: platformFeetY,
                target: {
                    x: stopLocal.x + (Math.random() - 0.5) * ALIGHT_TARGET_RADIUS * 2,
                    z: stopLocal.z + (Math.random() - 0.5) * ALIGHT_TARGET_RADIUS * 2,
                },
                role: 'alighting',
                terrainRelative: platformFeet.terrainRelative,
            });
            alighted += 1;
        }
    }
    return { boarded, alighted };
}

export function triggerBoardingBurst(tramPose, stop, options = {}) {
    if (!group || !tramPose || !stop) return { boarded: 0, alighted: 0 };
    if (suppressCoveredStationActors(stop)) return { boarded: 0, alighted: 0 };
    const stopLocal = stopScenePoint(stop);
    const boardingOrigins = Array.isArray(options.boardingOrigins)
        ? options.boardingOrigins.filter((person) => (
            Number.isFinite(person?.x) && Number.isFinite(person?.z)
        ))
        : [];
    const boardCount = boardingOrigins.length || Math.max(0, Math.round(options.boardCount || 0));
    const alightCount = Math.max(0, Math.round(options.alightCount || 0));
    const tramLocal = boardingPoseToScene({
        lon: tramPose.lon,
        lat: tramPose.lat,
        headingDeg: tramPose.headingDeg,
        anchorLon,
        anchorLat,
        photoTrackFrame,
    });
    const sideSign = inferPlatformSideSign(tramLocal, boardingOrigins);
    const doorLayout = {
        bodyWidthM: options.bodyWidthM,
        doorOffsetsZ: options.doorOffsetsZ,
        sideSign,
    };
    const carPoses = Array.isArray(options.carPoses)
        ? options.carPoses.filter((pose) => pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon))
        : [];
    const offsetsPerCar = Array.isArray(options.doorOffsetsZ) && options.doorOffsetsZ.length
        ? options.doorOffsetsZ
        : TRAM_DOOR_OFFSETS_Z;
    const doorCount = carPoses.length
        ? carPoses.length * offsetsPerCar.length
        : (Array.isArray(options.doorOffsetsZ) && options.doorOffsetsZ.length
            ? options.doorOffsetsZ.length
            : TRAM_DOOR_OFFSETS_Z.length);
    const doorAt = (doorIdx) => {
        if (!carPoses.length) return tramDoorWorldXZ(tramPose, doorIdx, doorLayout);
        const carPose = carPoses[Math.floor(doorIdx / offsetsPerCar.length)];
        return tramDoorWorldXZ(
            carPose,
            doorIdx % offsetsPerCar.length,
            { ...doorLayout, doorOffsetsZ: offsetsPerCar },
        );
    };
    const platformFeet = getPlatformFeetState(stop);
    if (platformFeet.y === null) return { boarded: 0, alighted: 0 };
    const platformFeetY = platformFeet.y;

    for (let i = 0; i < boardCount; i++) {
        const origin = boardingOrigins[i];
        const doorIdx = Math.floor(Math.random() * doorCount);
        const door = doorAt(doorIdx);
        spawnAnim({
            x: origin?.x ?? stopLocal.x + (Math.random() - 0.5) * PLATFORM_SPAWN_RADIUS * 2,
            z: origin?.z ?? stopLocal.z + (Math.random() - 0.5) * PLATFORM_SPAWN_RADIUS * 2,
            y: origin?.y ?? platformFeetY,
            target: door,
            role: 'boarding',
            appearance: origin,
            terrainRelative: platformFeet.terrainRelative,
        });
    }
    for (let i = 0; i < alightCount; i++) {
        const doorIdx = Math.floor(Math.random() * doorCount);
        const door = doorAt(doorIdx);
        const platformTarget = boardingOrigins[i % Math.max(1, boardingOrigins.length)];
        const headingRad = (Number(tramPose.headingDeg) || 0) * Math.PI / 180;
        const alongOffset = (Math.random() - 0.5) * 5;
        spawnAnim({
            x: door.x,
            z: door.z,
            y: platformFeetY,
            target: platformTarget
                ? {
                    x: platformTarget.x + Math.sin(headingRad) * alongOffset,
                    z: platformTarget.z - Math.cos(headingRad) * alongOffset,
                }
                : {
                    x: stopLocal.x + sideSign * Math.cos(headingRad) * ALIGHT_TARGET_RADIUS,
                    z: stopLocal.z + sideSign * Math.sin(headingRad) * ALIGHT_TARGET_RADIUS,
            },
            role: 'alighting',
            terrainRelative: platformFeet.terrainRelative,
        });
    }
    return { boarded: boardCount, alighted: alightCount };
}

// ─── Per-frame tick ────────────────────────────────────────────────────────

function updateAnimPeople(dt, posesById) {
    const camX = camera.position.x;
    const camZ = camera.position.z;
    const visRadiusSq = VISIBILITY_RADIUS_M * VISIBILITY_RADIUS_M;

    for (let i = animPeople.length - 1; i >= 0; i--) {
        const p = animPeople[i];

        if (p.terrainRelative && !terrainEvidenceReadyAt(p.x, p.z)) {
            p.mesh.visible = false;
            continue;
        }
        p.mesh.visible = true;

        // Boarders chase the (slowly-moving) tram door, recompute target
        // from the current pose every frame.
        if (p.role === 'boarding' && p.trackTramId != null) {
            const tramPose = posesById.get(p.trackTramId);
            if (tramPose) {
                p.target = tramDoorWorldXZ(tramPose, p.trackDoorIdx);
            }
        }

        const dx = p.target.x - p.x;
        const dz = p.target.z - p.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < ARRIVAL_RADIUS_M) {
            despawnAnim(p);
            animPeople.splice(i, 1);
            continue;
        }
        const move = Math.min(dist, p.speed * dt);
        p.x += (dx / dist) * move;
        p.z += (dz / dist) * move;
        p.mesh.position.set(p.x, p.y, p.z);
        p.mesh.rotation.y = Math.atan2(dx, dz);
        p.stride += move * 5.2;
        animatePersonWalk(p.mesh, p.stride);

        // Cull anyone who's wandered out of visible range — saves work and
        // matches the user's "only animate visible ones" intent.
        const cdx = p.x - camX, cdz = p.z - camZ;
        if (cdx * cdx + cdz * cdz > visRadiusSq) {
            despawnAnim(p);
            animPeople.splice(i, 1);
        }
    }
}

function tick(dt) {
    if (!otherTrainsFn || !group) return;
    const poses = otherTrainsFn();
    if (!poses) return;

    const posesById = new Map();
    for (const p of poses) posesById.set(p.id, p);

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const visRadiusSq = VISIBILITY_RADIUS_M * VISIBILITY_RADIUS_M;
    const stopRadiusSq = STOP_PROXIMITY_M * STOP_PROXIMITY_M;
    const seenTramIds = new Set();

    for (const tramPose of poses) {
        seenTramIds.add(tramPose.id);
        const local = boardingPointToScene({
            lon: tramPose.lon,
            lat: tramPose.lat,
            relativeHeightM: tramPose.y,
            anchorLon,
            anchorLat,
            photoTrackFrame,
        });
        const cdx = local.x - camX, cdz = local.z - camZ;
        if (cdx * cdx + cdz * cdz > visRadiusSq) continue;

        let closestStop = null, bestD2 = stopRadiusSq;
        stopSpatialIndex.forEachInBounds(
            local.x - STOP_PROXIMITY_M,
            local.z - STOP_PROXIMITY_M,
            local.x + STOP_PROXIMITY_M,
            local.z + STOP_PROXIMITY_M,
            (entry) => {
                const sd2 = (local.x - entry.x) ** 2 + (local.z - entry.z) ** 2;
                if (sd2 >= bestD2 || suppressCoveredStationActors(entry.stop)) return false;
                bestD2 = sd2;
                closestStop = entry.stop;
                return false;
            },
        );

        const prev = tramAtStopState.get(tramPose.id) || null;
        if (closestStop !== prev) {
            // Tram left a stop — clear unfinished boarders for this tram.
            if (prev != null) removeBoardingForTram(tramPose.id);
            // Tram just arrived at a stop — spawn a board+alight burst.
            if (closestStop != null) spawnBoardingAlighting(tramPose, closestStop);
            tramAtStopState.set(tramPose.id, closestStop);
        }
    }

    // Drop state for trams that disappeared (e.g. departed the area, or
    // schedule moved them off our list). Also kill their boarders.
    for (const tramId of Array.from(tramAtStopState.keys())) {
        if (!seenTramIds.has(tramId)) {
            removeBoardingForTram(tramId);
            tramAtStopState.delete(tramId);
        }
    }

    updateAnimPeople(dt, posesById);
}

// ─── Layer protocol ────────────────────────────────────────────────────────

export const boardingLayer = {
    beginSession(ctx) {
        anchorLat = ctx.anchorLat;
        anchorLon = ctx.anchorLon;
        stops = ctx.allStops || [];
        otherTrainsFn = ctx.otherTrainsFn || null;
        photoTrackFrame = ctx.photoTrackFrame || null;
        stopSpatialIndex.clear();
        for (const stop of stops) {
            const point = stopScenePoint(stop);
            stopSpatialIndex.add({ stop, x: point.x, z: point.z }, point.x, point.z);
        }
        group = new THREE.Group();
        group.name = 'StopPassengers';
        scene.add(group);
        tramAtStopState.clear();
        animPeople.length = 0;
    },
    onFrame(pose, local, dt) {
        if (!dt || dt <= 0) return;
        tick(dt);
    },
    endSession() {
        for (const p of animPeople) despawnAnim(p);
        animPeople.length = 0;
        tramAtStopState.clear();
        if (group) {
            if (group.parent) group.parent.remove(group);
            group = null;
        }
        otherTrainsFn = null;
        photoTrackFrame = null;
        stops = [];
        stopSpatialIndex.clear();
    },
};
