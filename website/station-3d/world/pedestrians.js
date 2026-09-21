// Stop-seeded ambient pedestrians for cab and walk sessions. Small groups
// follow nearby street segments, sometimes travel in pairs, and occasionally
// disappear through a streamed building entrance before emerging again.

import * as THREE from 'three';
import { shouldAttachAmbientDog } from '../core/ambient-dog-walkers.js';
import {
    DOG_BARK_MAX_DISTANCE_M,
    dogBarkSpatial,
    nextDogBarkDelayS,
} from '../core/ambient-dog-sounds.js';
import { createPedestrianConversationController } from '../core/pedestrian-conversation-controller.js';
import { pedestrianConversationCity } from '../core/pedestrian-conversations.js';
import { getLang } from '../core/i18n.js';
import { getLocation } from '../core/locations.js';
import { pedestrianConversationMembers } from './pedestrian-conversation-pair.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import {
    getAmbientBenchSeat,
    visitAmbientBenchSeatsNear,
} from '../core/ambient-bench-seats.js';
import {
    DEG_TO_RAD,
    EARTH_RADIUS_M,
    finiteOrNull,
    geoToLocal,
} from '../core/math.js';
import { ensureRoadIndex, nearbyRoadSegments } from '../core/road-index.js';
import {
    advanceTowards,
    chooseRoadWaypoint,
    sideBySideOffsets,
    walkPhaseOffsets,
} from '../core/pedestrian-motion.js';
import {
    benchDwellSeconds,
    benchSeatFrame,
    benchTransitionRatio,
} from '../core/pedestrian-bench-behavior.js';
import {
    movementCrossesBuildingFootprints,
    planFootprintAwareRoute,
    pointInBuildingFootprint,
    routeCrossesBuildingFootprints,
} from '../core/pedestrian-routing.js';
import {
    advanceOnePendingRoadTargetSearch,
    advanceRoadTargetSearchState,
    createRoadTargetSearchState,
} from '../core/pedestrian-road-target-search.js';
import { routeCrossesForbiddenSurface } from '../core/pedestrian-surface-routing.js';
import {
    roofActivityFigureCapacity,
    roofActivityPointIsSafe,
    roofActivitySegmentIsSafe,
    sampleRoofActivityPoint,
    roofActivityTargetSearchSteps,
} from '../core/pedestrian-roof-activity.js';
import { holdSlidingDoorOpen, stepSlidingDoor } from '../core/sliding-door-motion.js';
import { createStaggeredSpatialCache } from '../core/staggered-spatial-cache.js';
import { createQueuedShaderWarmup } from '../core/queued-shader-warmup.js';
import { createLayerStartupCoordinator } from '../core/layer-startup.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import { scene, camera, renderer } from '../scene/setup.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { getBuildingEntrancesNear, getBuildingFootprintsNear } from './buildings.js';
import { isPointInDecorWater } from './decor.js';
import { animateLeashedDog, createLeashedDog, prepareDogMeshAssets, setDogHappyPose } from './dog-mesh.js';
import {
    animatePersonSit,
    animatePersonWalk,
    createPersonMesh,
    createRandomPersonMesh,
    prepareAmbientPersonMeshAssets,
} from './person-mesh.js';
import {
    dogClipCount,
    playDogBark,
    preloadDogSfx,
    stopDogSfx,
    playDogPant,
} from '../ui/dog-sfx.js';
import {
    playPedestrianConversationLine,
    preloadPedestrianConversations,
    stopPedestrianConversations,
    updatePedestrianConversationSpatial,
} from '../ui/pedestrian-conversation-sfx.js';
import {
    findPlannerSurfaceCutStationAccessPlan,
    plannerSurfaceCutStationSurfaceAtLocal,
    plannerSurfaceCutStationSurfaceSupportedByTerrain,
} from './planner-station-layout.js';
import { getTerrainReference } from './terrain.js';
import { isPointInMappedSea } from './water.js';
import {
    getRoofActivitySurface,
    roofActivitySurfacesNear,
} from './roof-activity-registry.js';

const MAX_FIGURES = 32;
const MAX_ROOF_FIGURES = 6;
const PAIR_CHANCE = 0.28;
const WALK_SPEED_MIN = 1.05;
const WALK_SPEED_MAX = 1.42;
const POPULATION_RADIUS_M = 210;
const CULL_RADIUS_M = 265;
const BUILDING_CHANCE_PER_WAYPOINT = 0.14;
const BUILDING_SEARCH_RADIUS_M = 48;
const BUILDING_MIN_DISTANCE_M = 6;
const INSIDE_SECONDS_MIN = 5;
const INSIDE_SECONDS_MAX = 18;
const BUILDING_REENTRY_COOLDOWN_S = 18;
const FEET_OFFSET_M = 0.055;
const DOOR_TRIGGER_RADIUS_M = 4.2;
const DOOR_APPROACH_HOLD_S = 0.9;
const DOOR_CROSSING_HOLD_S = 1.15;
const DOOR_EXIT_LEAD_S = 0.7;
const DOOR_IDLE_REMOVE_S = 0.8;
const ROUTE_FOOTPRINT_MARGIN_M = 14;
const ROUTE_RECHECK_MIN_S = 0.35;
const ROUTE_RECHECK_JITTER_S = 0.25;
const BENCH_CHANCE_PER_WAYPOINT = 0.16;
const BENCH_SEEDED_SEATED_CHANCE = 0.22;
const BENCH_SEARCH_RADIUS_M = 55;
const BENCH_SEED_SEARCH_RADIUS_M = 38;
const MAX_BENCH_USERS = 5;
const BENCH_SIT_SECONDS = 0.68;
const BENCH_STAND_SECONDS = 0.82;
const FEET_GROUND_CACHE_QUANT_M = 0.2;
// Never expire every walker's support in the same frame. The former global
// 500 ms clear made the whole crowd miss together and turned otherwise cheap
// rendered-road probes into a recurring 70–200 ms pedestrian hook. Per-cell
// deterministic jitter keeps the same 500 ms maximum staleness while spreading
// refreshes across a quarter-second window.
const FEET_GROUND_CACHE_MIN_LIFETIME_MS = 250;
const FEET_GROUND_CACHE_JITTER_MS = 250;
const FEET_GROUND_CACHE_MAX_ENTRIES = 4096;
const TERRAIN_REFRESH_SPREAD_MS = 240;
const POPULATION_FILL_INTERVAL_S = 0.05;
// Actor support/routing probes are much more expensive than their low-poly
// animation. Advance one stable quarter of the ambient crowd per render frame
// and accumulate elapsed time on the others. At 60 Hz each walker still
// updates at 15 Hz (under 10 cm per step), while a terrain revision cannot make
// all 32 actors miss their support caches in one frame.
const PEDESTRIAN_UPDATE_PHASES = 4;
const ROOF_TARGET_MIN_DISTANCE_M = 2.5;
const ROOF_TARGET_MAX_DISTANCE_M = 28;
// A roof target can fan out into candidate sampling, chord sampling and every
// edge of every ring. Share one strict probe budget across the crowd instead
// of allowing one walker to monopolize an animation frame.
const ROOF_TARGET_PROBES_PER_FRAME = 96;
const ROOF_TARGET_PROBES_PER_WALKER = 16;

let anchorLat = 0;
let anchorLon = 0;
let terrain = null;
let terrainChangeSubscription = null;
let renderedGroundYAt = null;
let railFormation = null;
let stationAccessPlans = [];
let group = null;
let pedestrianMaterialWarmup = null;
let pedestrianShaderStartup = null;
let stopPoints = [];
let walkers = [];
let roadReady = false;
let populationTimer = 0;
let dogBarkTimer = 0;
let conversationController = null;
let conversationListener = null;
let sessionGeneration = 0;
let spawnCursor = 0;
let populationSpawnSerial = 0;
let isWalkSession = false;
let conversationsEnabled = false;
let enabled = true;
let pedestrianUpdatePhase = 0;
let pedestrianUpdateSerial = 0;
let roadTargetSearchCursor = 0;
let roofTargetSearchCursor = 0;
let doorAnimations = new Map();
let benchReservations = new Map();
const createFeetGroundCache = () => createStaggeredSpatialCache({
    quantM: FEET_GROUND_CACHE_QUANT_M,
    minLifetimeMs: FEET_GROUND_CACHE_MIN_LIFETIME_MS,
    jitterMs: FEET_GROUND_CACHE_JITTER_MS,
    maxEntries: FEET_GROUND_CACHE_MAX_ENTRIES,
});
let feetGroundCache = createFeetGroundCache();
let doorPlaneGeo = null;
let doorBoxGeo = null;
let doorRecessMat = null;
let doorPanelMat = null;
let doorFrameMat = null;
const dogCameraRight = new THREE.Vector3();
const conversationCameraRight = new THREE.Vector3();

function ensureDoorAssets() {
    if (!doorPlaneGeo) {
        doorPlaneGeo = new THREE.PlaneGeometry(1, 1);
        registerShared(doorPlaneGeo);
    }
    if (!doorBoxGeo) {
        doorBoxGeo = new THREE.BoxGeometry(1, 1, 1);
        registerShared(doorBoxGeo);
    }
    if (!doorRecessMat) {
        doorRecessMat = new THREE.MeshStandardMaterial({
            color: 0x111820,
            roughness: 0.92,
            metalness: 0.04,
            side: THREE.DoubleSide,
        });
        registerShared(doorRecessMat);
    }
    if (!doorPanelMat) {
        doorPanelMat = new THREE.MeshStandardMaterial({
            color: 0x83a5b3,
            roughness: 0.2,
            metalness: 0.24,
            transparent: true,
            opacity: 0.88,
        });
        registerShared(doorPanelMat);
    }
    if (!doorFrameMat) {
        doorFrameMat = new THREE.MeshStandardMaterial({
            color: 0x30373d,
            roughness: 0.42,
            metalness: 0.65,
        });
        registerShared(doorFrameMat);
    }
}

function addDoorBox(root, x, y, z, width, height, depth, material) {
    const mesh = new THREE.Mesh(doorBoxGeo, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    root.add(mesh);
    return mesh;
}

function createSlidingDoorAnimation(entrance) {
    ensureDoorAssets();
    const width = Math.max(0.9, Number(entrance.doorWidthM) || 1.25);
    const height = Math.max(2.2, Number(entrance.doorHeightM) || 2.6);
    const normalX = Number.isFinite(entrance.normalX) ? entrance.normalX : 0;
    const normalZ = Number.isFinite(entrance.normalZ) ? entrance.normalZ : 1;
    const root = new THREE.Group();
    root.name = `ambient-sliding-door:${entrance.objectId}`;
    root.position.set(
        (Number.isFinite(entrance.wallX) ? entrance.wallX : entrance.x) + normalX * 0.035,
        (Number(entrance.y) || 0) + height * 0.5,
        (Number.isFinite(entrance.wallZ) ? entrance.wallZ : entrance.z) + normalZ * 0.035,
    );
    root.rotation.y = Math.atan2(normalX, normalZ);

    const recess = new THREE.Mesh(doorPlaneGeo, doorRecessMat);
    recess.scale.set(width * 0.96, height * 0.97, 1);
    root.add(recess);

    const frameW = Math.max(0.045, width * 0.045);
    const frameD = 0.06;
    addDoorBox(root, -width * 0.5, 0, 0.035, frameW, height, frameD, doorFrameMat);
    addDoorBox(root, width * 0.5, 0, 0.035, frameW, height, frameD, doorFrameMat);
    addDoorBox(root, 0, height * 0.5, 0.035, width + frameW, frameW, frameD, doorFrameMat);

    const leafWidth = width * 0.48;
    const leafHeight = height * 0.94;
    const closedOffset = width * 0.245;
    const slideM = width * 0.44;
    const panels = [-1, 1].map((dir) => {
        const mesh = addDoorBox(
            root,
            dir * closedOffset,
            -height * 0.015,
            0.065,
            leafWidth,
            leafHeight,
            0.035,
            doorPanelMat,
        );
        return { mesh, dir, closedX: dir * closedOffset };
    });

    group.add(root);
    return {
        objectId: entrance.objectId,
        root,
        panels,
        slideM,
        ratio: 0,
        holdSeconds: 0,
        idleSeconds: 0,
    };
}

function applySlidingDoorRatio(door) {
    for (const panel of door.panels) {
        panel.mesh.position.x = panel.closedX + panel.dir * door.slideM * door.ratio;
    }
}

export function requestPedestrianDoorOpen(entrance, holdSeconds = DOOR_CROSSING_HOLD_S) {
    if (!enabled || !group || !entrance || entrance.objectId == null) return false;
    const key = String(entrance.objectId);
    let door = doorAnimations.get(key);
    if (!door) {
        door = createSlidingDoorAnimation(entrance);
        doorAnimations.set(key, door);
    }
    holdSlidingDoorOpen(door, holdSeconds);
    door.idleSeconds = 0;
    return true;
}

export function getPedestrianDoorAnimationState() {
    return Array.from(doorAnimations.values(), (door) => ({
        objectId: door.objectId,
        ratio: door.ratio,
        holdSeconds: door.holdSeconds,
        panelGapM: door.slideM * door.ratio * 2,
    }));
}

function tickSlidingDoors(dt) {
    for (const [key, door] of doorAnimations) {
        stepSlidingDoor(door, dt);
        applySlidingDoorRatio(door);
        if (door.ratio > 0 || door.holdSeconds > 0) {
            door.idleSeconds = 0;
            continue;
        }
        door.idleSeconds += dt;
        if (door.idleSeconds < DOOR_IDLE_REMOVE_S) continue;
        if (door.root.parent) door.root.parent.remove(door.root);
        doorAnimations.delete(key);
    }
}

function clearSlidingDoors() {
    for (const door of doorAnimations.values()) {
        if (door.root.parent) door.root.parent.remove(door.root);
    }
    doorAnimations.clear();
}

function localToGeo(x, z) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        lon: anchorLon + x / (DEG_TO_RAD * EARTH_RADIUS_M * cosLat),
        lat: anchorLat - z / (DEG_TO_RAD * EARTH_RADIUS_M),
    };
}

function localRoadSegments(x, z) {
    if (!roadReady) return [];
    const geo = localToGeo(x, z);
    return nearbyRoadSegments(geo.lon, geo.lat).map(([aLon, aLat, bLon, bLat]) => {
        const a = geoToLocal(aLon, aLat, anchorLon, anchorLat);
        const b = geoToLocal(bLon, bLat, anchorLon, anchorLat);
        return { ax: a.x, az: a.z, bx: b.x, bz: b.z };
    });
}

function fallbackWaypoint(walker) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 14 + Math.random() * 22;
    return {
        x: walker.x + Math.sin(angle) * distance,
        z: walker.z + Math.cos(angle) * distance,
    };
}

function footprintsForLeg(start, end) {
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    return getBuildingFootprintsNear(
        (start.x + end.x) * 0.5,
        (start.z + end.z) * 0.5,
        distance * 0.5 + ROUTE_FOOTPRINT_MARGIN_M,
    );
}

function isAmbientWaterAt(x, z) {
    return isPointInMappedSea(x, z) || isPointInDecorWater(x, z);
}

function setWalkerDestination(walker, destination, destinationKind) {
    const start = { x: walker.x, z: walker.z };
    if (walker.roofSurfaceId) {
        const surface = liveRoofSurface(walker);
        if (!surface
            || !roofActivityPointIsSafe(surface, destination.x, destination.z)
            || !roofActivitySegmentIsSafe(surface, start, destination)) return false;
        cancelRoadTargetSearch(walker);
        cancelRoofTargetSearch(walker);
        walker.destination = { x: destination.x, z: destination.z };
        walker.destinationKind = destinationKind;
        walker.route = [];
        walker.routeFootprints = [];
        walker.target = { ...walker.destination };
        walker.targetKind = destinationKind;
        walker.routeCheckSeconds = ROUTE_RECHECK_MIN_S + Math.random() * ROUTE_RECHECK_JITTER_S;
        return true;
    }
    const footprints = footprintsForLeg(start, destination);
    const route = planFootprintAwareRoute(
        start,
        destination,
        footprints,
    );
    if (!route || route.length === 0) return false;
    if (routeCrossesForbiddenSurface(start, route, isAmbientWaterAt)) return false;
    cancelRoadTargetSearch(walker);
    cancelRoofTargetSearch(walker);
    walker.destination = { x: destination.x, z: destination.z };
    walker.destinationKind = destinationKind;
    walker.route = route;
    walker.routeFootprints = footprints;
    walker.target = walker.route.shift();
    walker.targetKind = walker.route.length === 0 ? destinationKind : 'detour';
    walker.routeCheckSeconds = ROUTE_RECHECK_MIN_S + Math.random() * ROUTE_RECHECK_JITTER_S;
    return true;
}

function advanceDestinationRoute(walker) {
    if (!walker.route || walker.route.length === 0) return false;
    walker.target = walker.route.shift();
    walker.targetKind = walker.route.length === 0 ? walker.destinationKind : 'detour';
    return true;
}

function cancelRoadTargetSearch(walker) {
    if (!walker?.roadTargetSearch) return false;
    walker.roadTargetSearch = null;
    return true;
}

function holdWalkerForRoadSearch(walker, targetKind = 'road-search') {
    walker.destination = null;
    walker.destinationKind = null;
    walker.route = [];
    walker.routeFootprints = [];
    walker.target = { x: walker.x, z: walker.z };
    walker.targetKind = targetKind;
}

function waitAfterRoadTargetSearch(walker) {
    cancelRoadTargetSearch(walker);
    holdWalkerForRoadSearch(walker, 'wait');
    walker.waitSeconds = 0.8;
}

function assignRoadTarget(walker) {
    cancelRoadTargetSearch(walker);
    cancelRoofTargetSearch(walker);
    holdWalkerForRoadSearch(walker);
    walker.roadTargetSearch = {
        ...createRoadTargetSearchState(),
        segments: null,
    };
    return true;
}

function advanceWalkerRoadTargetSearch(walker) {
    const search = walker.roadTargetSearch;
    if (!search) return false;
    if (walker.roofSurfaceId) {
        cancelRoadTargetSearch(walker);
        return false;
    }
    if (!search.segments) search.segments = localRoadSegments(walker.x, walker.z);
    const outcome = advanceRoadTargetSearchState(search, () => {
        const target = chooseRoadWaypoint({
            x: walker.x,
            z: walker.z,
            segments: search.segments,
            side: walker.side,
            previous: walker.legStart,
        }) || fallbackWaypoint(walker);
        return setWalkerDestination(walker, target, 'road') ? target : null;
    });
    if (outcome.status === 'success') {
        walker.legStart = { x: walker.x, z: walker.z };
    } else if (outcome.status === 'failed') {
        waitAfterRoadTargetSearch(walker);
    }
    return outcome.attempted;
}

function advanceRoadTargetSearches() {
    const outcome = advanceOnePendingRoadTargetSearch(
        walkers,
        roadTargetSearchCursor,
        advanceWalkerRoadTargetSearch,
    );
    roadTargetSearchCursor = outcome.cursor;
    return outcome.attempts;
}

function cancelRoofTargetSearch(walker) {
    if (!walker?.roofTargetSearch) return false;
    walker.roofTargetSearch.iterator?.return?.();
    walker.roofTargetSearch = null;
    return true;
}

function holdWalkerForRoofSearch(walker, targetKind = 'roof-search') {
    walker.destination = null;
    walker.destinationKind = null;
    walker.route = [];
    walker.routeFootprints = [];
    walker.target = { x: walker.x, z: walker.z };
    walker.targetKind = targetKind;
}

function waitAfterRoofTargetSearch(walker) {
    holdWalkerForRoofSearch(walker, 'wait');
    walker.waitSeconds = 0.8;
}

function assignRoofTarget(walker) {
    cancelRoadTargetSearch(walker);
    cancelRoofTargetSearch(walker);
    const surface = liveRoofSurface(walker);
    if (!surface) {
        waitAfterRoofTargetSearch(walker);
        return false;
    }
    holdWalkerForRoofSearch(walker);
    walker.roofTargetSearch = {
        surface,
        iterator: roofActivityTargetSearchSteps(surface, { x: walker.x, z: walker.z }, {
            minDistanceM: ROOF_TARGET_MIN_DISTANCE_M,
            maxDistanceM: ROOF_TARGET_MAX_DISTANCE_M,
        }),
    };
    return true;
}

function advanceWalkerRoofTargetSearch(walker, maxProbes) {
    const search = walker.roofTargetSearch;
    if (!search) return 0;
    if (liveRoofSurface(walker) !== search.surface) {
        cancelRoofTargetSearch(walker);
        return 0;
    }
    let probes = 0;
    while (probes < maxProbes) {
        const result = search.iterator.next();
        probes += 1;
        if (!result.done) continue;
        walker.roofTargetSearch = null;
        if (!result.value || liveRoofSurface(walker) !== search.surface) {
            waitAfterRoofTargetSearch(walker);
            break;
        }
        // Publish the route atomically only after every point/edge probe has
        // completed against the same live surface.
        walker.destination = { ...result.value };
        walker.destinationKind = 'roof';
        walker.route = [];
        walker.routeFootprints = [];
        walker.target = { ...result.value };
        walker.targetKind = 'roof';
        walker.routeCheckSeconds = ROUTE_RECHECK_MIN_S + Math.random() * ROUTE_RECHECK_JITTER_S;
        walker.legStart = { x: walker.x, z: walker.z };
        break;
    }
    return probes;
}

function advanceRoofTargetSearches(maxProbes = ROOF_TARGET_PROBES_PER_FRAME) {
    if (walkers.length === 0) return 0;
    let remaining = maxProbes;
    const start = roofTargetSearchCursor % walkers.length;
    for (let offset = 0; offset < walkers.length && remaining > 0; offset++) {
        const walker = walkers[(start + offset) % walkers.length];
        if (!walker?.roofTargetSearch) continue;
        const used = advanceWalkerRoofTargetSearch(
            walker,
            Math.min(ROOF_TARGET_PROBES_PER_WALKER, remaining),
        );
        remaining -= used;
    }
    roofTargetSearchCursor = (start + 1) % Math.max(1, walkers.length);
    return maxProbes - remaining;
}

function assignWalkerTarget(walker) {
    return walker.roofSurfaceId ? assignRoofTarget(walker) : assignRoadTarget(walker);
}

function buildWalkerMesh(size, { allowDog = true } = {}) {
    const holder = new THREE.Group();
    const people = [];
    const offsets = sideBySideOffsets(size);
    // Each member carries its own place in the gait cycle for life, so a pair
    // never swings the same leg on the same frame. Without this they animate
    // from one shared stride and read as one doubled person, not two.
    const phases = walkPhaseOffsets(size);
    for (const [index, offset] of offsets.entries()) {
        const person = createRandomPersonMesh();
        person.position.x = offset;
        person.userData.walkPhaseOffset = phases[index] || 0;
        holder.add(person);
        people.push(person);
    }
    holder.userData.people = people;
    const currentDogWalkers = walkers.reduce(
        (total, walker) => total + (walker.mesh.userData.dog ? 1 : 0),
        0,
    );
    if (allowDog && shouldAttachAmbientDog({
        groupSize: size,
        currentDogWalkers,
        randomValue: Math.random(),
    })) {
        const handlerX = offsets[0] || 0;
        const side = handlerX === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(handlerX);
        const dog = createLeashedDog({ handlerX, side });
        holder.add(dog);
        holder.userData.dog = dog;
    }
    return holder;
}

function cutStationSurfaceAt(x, z) {
    for (const plan of stationAccessPlans) {
        const surface = plannerSurfaceCutStationSurfaceAtLocal(plan, x, z);
        if (surface) return surface;
    }
    return null;
}

function activeTerrainReference() {
    // A moving terrain window may replace the session reference while deferred
    // ambient layers keep running. The terrain module owns the live datum; the
    // captured context remains the fallback for tests and custom layer hosts.
    return getTerrainReference() || terrain;
}

function walkableCutStationSurfaceAt(x, z, terrainY = null) {
    const surface = cutStationSurfaceAt(x, z);
    if (!surface) return null;
    const rawTerrainY = Number.isFinite(terrainY)
        ? terrainY
        : evidencePlacementBaseSceneY(activeTerrainReference(), x, z);
    if (rawTerrainY === null) return null;
    return plannerSurfaceCutStationSurfaceSupportedByTerrain(surface, rawTerrainY)
        ? surface
        : null;
}

function unsafeExcavatedGroundAt(x, z) {
    if (walkableCutStationSurfaceAt(x, z)) return false;
    return !!railFormation?.isOpenCutAtLocal?.(x, z, 0.5);
}

function feetY(x, z) {
    return feetGroundCache.getOrCompute(x, z, () => {
        const placementY = evidencePlacementBaseSceneY(activeTerrainReference(), x, z);
        if (placementY === null) return null;
        const accessSurface = walkableCutStationSurfaceAt(x, z, placementY);
        if (accessSurface) return accessSurface.floorY + FEET_OFFSET_M;
        // The rendered-surface registry below is the visible road authority and
        // already enforces the walker's step-up limit. Asking the analytical
        // formation model first can synchronously rebuild every streamed road
        // after a tile revision, charging that city-scale work to one walker.
        // A missing rendered-road support is `null`. Number(null) is zero,
        // which used to pin off-road walkers to the session datum instead of
        // the live terrain (visibly several metres in the air at Zrinjevac).
        const renderedY = typeof renderedGroundYAt === 'function'
            ? finiteOrNull(renderedGroundYAt(x, z, placementY))
            : null;
        return (renderedY ?? placementY) + FEET_OFFSET_M;
    });
}

function liveRoofSurface(walker) {
    if (!walker?.roofSurfaceId) return null;
    return getRoofActivitySurface(walker.roofSurfaceId);
}

function walkerSupportY(walker, x, z) {
    if (!walker?.roofSurfaceId) return feetY(x, z);
    const surface = liveRoofSurface(walker);
    if (!surface || !roofActivityPointIsSafe(surface, x, z)) return null;
    return surface.floorY + FEET_OFFSET_M;
}

function releaseWalkerBench(walker) {
    if (!walker?.benchId) return;
    if (benchReservations.get(walker.benchId) === walker) {
        benchReservations.delete(walker.benchId);
    }
    walker.benchId = null;
}

function availableBenchNear(walker, radiusM) {
    if (walker.size !== 1 || walker.mesh?.userData?.dog) return null;
    if (benchReservations.size >= MAX_BENCH_USERS) return null;
    let best = null;
    let bestDistanceSq = Infinity;
    visitAmbientBenchSeatsNear(walker.x, walker.z, radiusM, (bench) => {
        const benchSurfaceId = bench.surfaceId == null ? null : String(bench.surfaceId);
        if (walker.roofSurfaceId
            ? benchSurfaceId !== walker.roofSurfaceId
            : benchSurfaceId !== null) return;
        const id = String(bench.id);
        if (benchReservations.has(id)) return;
        const dx = bench.x - walker.x;
        const dz = bench.z - walker.z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq >= bestDistanceSq) return;
        const frame = benchSeatFrame(bench);
        if (!frame) return;
        if (walker.roofSurfaceId) {
            const surface = liveRoofSurface(walker);
            if (!surface
                || !roofActivityPointIsSafe(surface, frame.x, frame.z)
                || !roofActivityPointIsSafe(surface, frame.approachX, frame.approachZ)
                || !roofActivitySegmentIsSafe(surface, frame, {
                    x: frame.approachX,
                    z: frame.approachZ,
                })) return;
        } else if (isAmbientWaterAt(frame.approachX, frame.approachZ)) return;
        best = frame;
        bestDistanceSq = distanceSq;
    });
    return best;
}

function reserveBenchForWalker(walker, frame) {
    if (!frame || benchReservations.has(frame.id)) return false;
    benchReservations.set(frame.id, walker);
    walker.benchId = frame.id;
    return true;
}

function walkerSeatRootY(walker, frame) {
    const dims = walker.mesh?.userData?.people?.[0]?.userData?.personDimensions;
    return frame.seatY - (Number(dims?.legH) || 0.68);
}

function applyWalkerSitPose(walker, frame, ratio, {
    x = frame.x,
    z = frame.z,
    y = walkerSeatRootY(walker, frame),
} = {}) {
    walker.x = x;
    walker.z = z;
    walker.heading = frame.yaw;
    walker.mesh.position.set(x, y, z);
    walker.mesh.rotation.y = frame.yaw;
    for (const person of walker.mesh.userData.people || []) animatePersonSit(person, ratio);
}

function sendWalkerToBench(walker, radiusM = BENCH_SEARCH_RADIUS_M) {
    const frame = availableBenchNear(walker, radiusM);
    if (!frame) return false;
    if (!setWalkerDestination(walker, {
        x: frame.approachX,
        z: frame.approachZ,
    }, 'bench-approach')) return false;
    if (!reserveBenchForWalker(walker, frame)) {
        assignWalkerTarget(walker);
        return false;
    }
    walker.legStart = { x: walker.x, z: walker.z };
    return true;
}

function seedWalkerOnBench(walker) {
    const frame = availableBenchNear(walker, BENCH_SEED_SEARCH_RADIUS_M);
    if (!frame || !reserveBenchForWalker(walker, frame)) return false;
    cancelRoadTargetSearch(walker);
    cancelRoofTargetSearch(walker);
    walker.target = null;
    walker.targetKind = 'bench-seated';
    walker.destination = null;
    walker.destinationKind = null;
    walker.route = [];
    walker.routeFootprints = [];
    walker.benchDwellSeconds = benchDwellSeconds(Math.random());
    applyWalkerSitPose(walker, frame, 1);
    return true;
}

function liveBenchFrame(walker) {
    const frame = benchSeatFrame(getAmbientBenchSeat(walker.benchId));
    if (!frame) return null;
    const frameSurfaceId = frame.surfaceId == null ? null : String(frame.surfaceId);
    if (walker.roofSurfaceId) {
        const surface = liveRoofSurface(walker);
        if (!surface
            || frameSurfaceId !== walker.roofSurfaceId
            || !roofActivityPointIsSafe(surface, frame.x, frame.z)
            || !roofActivityPointIsSafe(surface, frame.approachX, frame.approachZ)) return null;
    } else if (frameSurfaceId !== null) return null;
    return frame;
}

function abandonBench(walker) {
    const frame = liveBenchFrame(walker);
    for (const person of walker.mesh.userData.people || []) animatePersonSit(person, 0);
    releaseWalkerBench(walker);
    if (frame) {
        walker.x = frame.approachX;
        walker.z = frame.approachZ;
        const supportY = walkerSupportY(walker, walker.x, walker.z);
        if (supportY === null) walker.mesh.visible = false;
        else walker.mesh.position.set(walker.x, supportY, walker.z);
    } else {
        const supportY = walkerSupportY(walker, walker.x, walker.z);
        if (supportY === null) walker.mesh.visible = false;
        else walker.mesh.position.y = supportY;
    }
    walker.targetKind = null;
    assignWalkerTarget(walker);
}

function updateWalkerBenchActivity(walker, dt) {
    const frame = liveBenchFrame(walker);
    if (!frame) {
        abandonBench(walker);
        return true;
    }

    if (walker.targetKind === 'bench-sitting') {
        walker.benchTransitionSeconds += dt;
        const ratio = benchTransitionRatio(walker.benchTransitionSeconds, BENCH_SIT_SECONDS);
        const seatedY = walkerSeatRootY(walker, frame);
        applyWalkerSitPose(walker, frame, ratio, {
            y: THREE.MathUtils.lerp(walker.benchStandingY, seatedY, ratio),
        });
        if (walker.benchTransitionSeconds >= BENCH_SIT_SECONDS) {
            walker.targetKind = 'bench-seated';
            walker.benchDwellSeconds = benchDwellSeconds(Math.random());
        }
        return true;
    }

    if (walker.targetKind === 'bench-seated') {
        walker.benchDwellSeconds -= dt;
        applyWalkerSitPose(walker, frame, 1);
        if (walker.benchDwellSeconds <= 0) {
            const standingY = walkerSupportY(walker, frame.approachX, frame.approachZ);
            if (standingY === null) return true;
            walker.targetKind = 'bench-standing';
            walker.benchTransitionSeconds = 0;
            walker.benchStandingY = standingY;
        }
        return true;
    }

    walker.benchTransitionSeconds += dt;
    const ratio = benchTransitionRatio(walker.benchTransitionSeconds, BENCH_STAND_SECONDS);
    const x = THREE.MathUtils.lerp(frame.x, frame.approachX, ratio);
    const z = THREE.MathUtils.lerp(frame.z, frame.approachZ, ratio);
    const y = THREE.MathUtils.lerp(walkerSeatRootY(walker, frame), walker.benchStandingY, ratio);
    applyWalkerSitPose(walker, frame, 1 - ratio, { x, z, y });
    if (walker.benchTransitionSeconds >= BENCH_STAND_SECONDS) {
        releaseWalkerBench(walker);
        walker.targetKind = null;
        assignWalkerTarget(walker);
    }
    return true;
}

function pointInsideRenderedBuilding(x, z) {
    const point = { x, z };
    return getBuildingFootprintsNear(x, z, 1.5)
        .some(footprint => pointInBuildingFootprint(point, footprint));
}

function createWalker(x, z, size = 1, {
    exitingEntrance = null,
    roofSurfaceId = null,
} = {}) {
    let phaseStartedMs = performance.now();
    const normalizedRoofSurfaceId = roofSurfaceId == null ? null : String(roofSurfaceId);
    const roofSurface = normalizedRoofSurfaceId
        ? getRoofActivitySurface(normalizedRoofSurfaceId)
        : null;
    if (normalizedRoofSurfaceId && (!roofSurface || !roofActivityPointIsSafe(roofSurface, x, z))) {
        return null;
    }
    if (!normalizedRoofSurfaceId && isAmbientWaterAt(x, z)) return null;
    const initialY = roofSurface ? roofSurface.floorY + FEET_OFFSET_M : feetY(x, z);
    if (initialY === null) return null;
    recordLayerFrameMs('pedestrians:population:support', performance.now() - phaseStartedMs);
    phaseStartedMs = performance.now();
    const mesh = buildWalkerMesh(size, { allowDog: !normalizedRoofSurfaceId });
    recordLayerFrameMs('pedestrians:population:mesh', performance.now() - phaseStartedMs);
    const walker = {
        mesh,
        size,
        roofSurfaceId: normalizedRoofSurfaceId,
        x,
        z,
        speed: WALK_SPEED_MIN + Math.random() * (WALK_SPEED_MAX - WALK_SPEED_MIN),
        stride: Math.random() * Math.PI * 2,
        heading: Math.random() * Math.PI * 2,
        side: Math.random() < 0.5 ? -1 : 1,
        target: null,
        targetKind: null,
        destination: null,
        destinationKind: null,
        route: [],
        routeFootprints: [],
        routeCheckSeconds: Math.random() * ROUTE_RECHECK_MIN_S,
        waitSeconds: 0,
        legStart: null,
        insideSeconds: 0,
        entrance: exitingEntrance,
        lastBuildingId: exitingEntrance && exitingEntrance.objectId,
        entryCooldown: exitingEntrance ? BUILDING_REENTRY_COOLDOWN_S : Math.random() * 8,
        benchId: null,
        benchDwellSeconds: 0,
        benchTransitionSeconds: 0,
        benchStandingY: 0,
        updatePhase: pedestrianUpdateSerial++ % PEDESTRIAN_UPDATE_PHASES,
        pendingDt: 0,
        roadTargetSearch: null,
        roofTargetSearch: null,
    };
    phaseStartedMs = performance.now();
    assignWalkerTarget(walker);
    recordLayerFrameMs('pedestrians:population:target', performance.now() - phaseStartedMs);
    mesh.position.set(x, initialY, z);
    mesh.rotation.y = walker.heading;
    mesh.userData.ambientPedestrian = true;
    mesh.userData.roofSurfaceId = normalizedRoofSurfaceId;
    group.add(mesh);
    walkers.push(walker);
    if (size === 1 && Math.random() < BENCH_SEEDED_SEATED_CHANCE) {
        seedWalkerOnBench(walker);
    }
    return walker;
}

function figureCount() {
    return walkers.reduce((total, walker) => total + walker.size, 0);
}

function roofFigureCount() {
    return walkers.reduce(
        (total, walker) => total + (walker.roofSurfaceId ? walker.size : 0),
        0,
    );
}

function groundFigureCount() {
    return walkers.reduce(
        (total, walker) => total + (walker.roofSurfaceId ? 0 : walker.size),
        0,
    );
}

function clearWalkers() {
    for (let index = walkers.length - 1; index >= 0; index--) removeWalker(index);
}

function removeWalker(index) {
    const walker = walkers[index];
    conversationController?.removePair(walker);
    cancelRoadTargetSearch(walker);
    cancelRoofTargetSearch(walker);
    releaseWalkerBench(walker);
    if (walker.mesh.parent) walker.mesh.parent.remove(walker.mesh);
    walkers.splice(index, 1);
}

function chooseBuildingEntrance(walker) {
    const options = getBuildingEntrancesNear(walker.x, walker.z, BUILDING_SEARCH_RADIUS_M)
        .filter((entrance) => entrance.objectId !== walker.lastBuildingId)
        .filter((entrance) => Math.hypot(entrance.x - walker.x, entrance.z - walker.z) >= BUILDING_MIN_DISTANCE_M);
    if (options.length === 0) return null;
    return options[Math.floor(Math.random() * options.length)];
}

function arriveAtWaypoint(walker) {
    if (walker.targetKind === 'detour') {
        advanceDestinationRoute(walker);
        return;
    }
    if (walker.targetKind === 'building') {
        requestPedestrianDoorOpen(walker.entrance, DOOR_CROSSING_HOLD_S);
        walker.x = walker.entrance.x;
        walker.z = walker.entrance.z;
        walker.mesh.visible = false;
        walker.insideSeconds = INSIDE_SECONDS_MIN
            + Math.random() * (INSIDE_SECONDS_MAX - INSIDE_SECONDS_MIN);
        walker.target = null;
        walker.targetKind = 'inside';
        walker.destination = null;
        walker.destinationKind = null;
        walker.route = [];
        walker.routeFootprints = [];
        return;
    }

    if (walker.targetKind === 'bench-approach') {
        const frame = liveBenchFrame(walker);
        if (!frame) {
            abandonBench(walker);
            return;
        }
        walker.target = { x: frame.x, z: frame.z };
        walker.targetKind = 'bench-seat';
        walker.destination = null;
        walker.destinationKind = null;
        walker.route = [];
        walker.routeFootprints = [];
        return;
    }

    if (walker.targetKind === 'bench-seat') {
        const frame = liveBenchFrame(walker);
        if (!frame) {
            abandonBench(walker);
            return;
        }
        const standingY = walkerSupportY(walker, frame.x, frame.z);
        if (standingY === null) return;
        walker.target = null;
        walker.targetKind = 'bench-sitting';
        walker.benchTransitionSeconds = 0;
        walker.benchStandingY = standingY;
        applyWalkerSitPose(walker, frame, 0, { y: walker.benchStandingY });
        return;
    }

    if ((walker.targetKind === 'road' || walker.targetKind === 'roof')
        && Math.random() < BENCH_CHANCE_PER_WAYPOINT
        && sendWalkerToBench(walker)) return;

    if (!walker.roofSurfaceId
        && walker.entryCooldown <= 0
        && Math.random() < BUILDING_CHANCE_PER_WAYPOINT) {
        const entrance = chooseBuildingEntrance(walker);
        if (entrance) {
            if (setWalkerDestination(walker, { x: entrance.x, z: entrance.z }, 'building')) {
                walker.entrance = entrance;
                walker.legStart = { x: walker.x, z: walker.z };
                return;
            }
        }
    }
    assignWalkerTarget(walker);
}

function updateWalker(walker, dt) {
    // Coastline/decor water can arrive after the crowd. Cull any ambient
    // person whose formerly dry point is reclassified; player water movement
    // is intentionally owned elsewhere and remains unaffected.
    if (walker.roofSurfaceId && !liveRoofSurface(walker)) return false;
    if (!walker.roofSurfaceId && isAmbientWaterAt(walker.x, walker.z)) return false;
    walker.entryCooldown = Math.max(0, walker.entryCooldown - dt);
    if (walker.targetKind === 'inside') {
        walker.insideSeconds -= dt;
        if (walker.insideSeconds <= DOOR_EXIT_LEAD_S) {
            requestPedestrianDoorOpen(walker.entrance, DOOR_CROSSING_HOLD_S);
        }
        if (walker.insideSeconds > 0) return true;
        const exitY = feetY(walker.entrance.x, walker.entrance.z);
        if (exitY === null) return true;
        walker.x = walker.entrance.x;
        walker.z = walker.entrance.z;
        walker.lastBuildingId = walker.entrance.objectId;
        walker.entryCooldown = BUILDING_REENTRY_COOLDOWN_S;
        walker.mesh.position.set(walker.x, exitY, walker.z);
        walker.mesh.visible = true;
        assignWalkerTarget(walker);
    }

    const currentY = walkerSupportY(walker, walker.x, walker.z);
    if (currentY === null) {
        walker.mesh.visible = false;
        return true;
    }
    walker.mesh.visible = true;
    // Default every visible update to a planted stance. The movement branch
    // below immediately replaces it with a stride after a successful step;
    // every early return (wait, temporarily missing support, reroute, blocked
    // footprint) now leaves a standing person instead of preserving whichever
    // airborne gait pose happened to be sampled on the preceding frame.
    applyWalkerGait(walker, 0);

    if (walker.targetKind === 'wait') {
        if (!walker.roofSurfaceId && pointInsideRenderedBuilding(walker.x, walker.z)) return false;
        // Waiting walkers do not advance through the movement branch below,
        // but their ground datum can still change under a moving DGU window.
        walker.mesh.position.y = currentY;
        walker.waitSeconds -= dt;
        if (walker.waitSeconds <= 0) assignWalkerTarget(walker);
        return true;
    }

    if (walker.targetKind === 'road-search' || walker.targetKind === 'roof-search') {
        walker.mesh.position.y = currentY;
        return true;
    }

    if (walker.targetKind === 'bench-sitting'
        || walker.targetKind === 'bench-seated'
        || walker.targetKind === 'bench-standing') {
        return updateWalkerBenchActivity(walker, dt);
    }

    walker.routeCheckSeconds -= dt;
    if (!walker.roofSurfaceId && walker.routeCheckSeconds <= 0 && walker.destination) {
        walker.routeCheckSeconds = ROUTE_RECHECK_MIN_S + Math.random() * ROUTE_RECHECK_JITTER_S;
        if (pointInsideRenderedBuilding(walker.x, walker.z)) return false;
        const footprints = footprintsForLeg(walker, walker.destination);
        const remainingRoute = [walker.target, ...(walker.route || [])];
        if (routeCrossesBuildingFootprints(walker, remainingRoute, footprints)) {
            if (!setWalkerDestination(walker, walker.destination, walker.destinationKind)) return false;
        } else {
            walker.routeFootprints = footprints;
        }
    }

    if (walker.targetKind === 'building') {
        const doorDistance = Math.hypot(
            walker.target.x - walker.x,
            walker.target.z - walker.z,
        );
        if (doorDistance <= DOOR_TRIGGER_RADIUS_M) {
            requestPedestrianDoorOpen(walker.entrance, DOOR_APPROACH_HOLD_S);
        }
    }

    const proposed = {
        x: walker.x,
        z: walker.z,
        speed: walker.speed,
        stride: walker.stride,
        heading: walker.heading,
    };
    const result = advanceTowards(proposed, walker.target, dt);
    if (walker.roofSurfaceId) {
        const surface = liveRoofSurface(walker);
        if (!surface || !roofActivitySegmentIsSafe(surface, walker, proposed)) {
            assignRoofTarget(walker);
            return !!surface;
        }
    }
    // A bare-terrain height above a carved cutting is not a floor. Remove the
    // route rather than drawing a person suspended in the removed soil (the
    // characteristic "only a head above the wall" failure). Analytic station
    // slabs, treads and landings are explicitly allowed above.
    if (!walker.roofSurfaceId && unsafeExcavatedGroundAt(proposed.x, proposed.z)) return false;
    if (!walker.roofSurfaceId && isAmbientWaterAt(proposed.x, proposed.z)) return false;
    if (!walker.roofSurfaceId
        && movementCrossesBuildingFootprints(walker, proposed, walker.routeFootprints)) {
        if (!walker.destination
            || !setWalkerDestination(walker, walker.destination, walker.destinationKind)) return false;
        return true;
    }
    const proposedY = walkerSupportY(walker, proposed.x, proposed.z);
    if (proposedY === null) return true;
    walker.x = proposed.x;
    walker.z = proposed.z;
    walker.heading = proposed.heading;
    walker.stride = proposed.stride;
    walker.mesh.position.set(walker.x, proposedY, walker.z);
    walker.mesh.rotation.y = walker.heading;
    applyWalkerGait(walker, result.movedM > 0 ? 1 : 0);
    if (result.arrived) arriveAtWaypoint(walker);
    return true;
}

function applyWalkerGait(walker, amount) {
    for (const person of walker.mesh.userData.people) {
        animatePersonWalk(
            person,
            walker.stride + (person.userData.walkPhaseOffset || 0),
            amount,
        );
    }
    animateLeashedDog(
        walker.mesh.userData.dog,
        walker.stride,
        amount,
    );
}

function stopPoint(stop) {
    // Waiting passengers already belong to the platform layer. The roaming
    // street crowd must not be seeded at the track centre of a deep cut, where
    // its first road target would send it through the retaining wall.
    if (findPlannerSurfaceCutStationAccessPlan(stationAccessPlans, stop)) return null;
    const lat = Number(stop && (stop.lat ?? stop.latlng?.[0]));
    const lon = Number(stop && (stop.lng ?? stop.lon ?? stop.latlng?.[1]));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    return { x: local.x, z: local.z };
}

function maintainPopulation() {
    if (!enabled || !group || !camera) return false;
    let phaseStartedMs = performance.now();
    const radiusSq = POPULATION_RADIUS_M * POPULATION_RADIUS_M;
    const nearbyStops = stopPoints.filter((stop) => {
        const dx = stop.x - camera.position.x;
        const dz = stop.z - camera.position.z;
        return dx * dx + dz * dz <= radiusSq;
    });
    // Direct walk links intentionally carry no planner/tram stop inventory.
    // Keep those scenes alive with a local crowd that follows the player;
    // stop-backed cab sessions retain their established station spawning.
    const useLocalWalkCrowd = isWalkSession && nearbyStops.length === 0;
    const spawnPoints = useLocalWalkCrowd
        ? [{ x: camera.position.x, z: camera.position.z }]
        : nearbyStops;
    const baseDesiredFigures = useLocalWalkCrowd
        ? Math.min(MAX_FIGURES, 12)
        : Math.min(MAX_FIGURES, nearbyStops.length * 3);
    const roofSurfaces = roofActivitySurfacesNear(
        camera.position.x,
        camera.position.z,
        POPULATION_RADIUS_M,
    );
    const roofCapacity = roofSurfaces.reduce(
        (total, surface) => total + roofActivityFigureCapacity(surface),
        0,
    );
    recordLayerFrameMs('pedestrians:population:query', performance.now() - phaseStartedMs);
    // Roof figures replace part of the established crowd budget, so enabling
    // bounded roof activity does not add draw calls or actors to a full scene.
    // A roof-only cab scene may still show people when it has no stop seed.
    const desiredRoofFigures = Math.min(
        MAX_ROOF_FIGURES,
        roofCapacity,
        baseDesiredFigures > 0 ? baseDesiredFigures : MAX_ROOF_FIGURES,
    );
    const desiredGroundFigures = Math.max(0, baseDesiredFigures - desiredRoofFigures);
    const currentRoofFigures = roofFigureCount();
    const currentGroundFigures = groundFigureCount();

    // Rebalance one hierarchy at a time, using the same staggered fill cadence
    // as construction. This lets newly streamed roofs acquire people without
    // briefly exceeding the historical MAX_FIGURES budget.
    if (currentGroundFigures > desiredGroundFigures) {
        const index = walkers.findLastIndex(walker => !walker.roofSurfaceId);
        if (index >= 0) removeWalker(index);
        return true;
    }
    if (currentRoofFigures > desiredRoofFigures) {
        const nearbyIds = new Set(roofSurfaces.map(surface => surface.id));
        let index = walkers.findLastIndex(
            walker => walker.roofSurfaceId && !nearbyIds.has(walker.roofSurfaceId),
        );
        if (index < 0) index = walkers.findLastIndex(walker => walker.roofSurfaceId);
        if (index >= 0) removeWalker(index);
        return true;
    }

    const needsRoof = currentRoofFigures < desiredRoofFigures;
    const needsGround = currentGroundFigures < desiredGroundFigures;
    if (!needsRoof && !needsGround) return false;

    // Construct at most one person/pair per tick. A person is a hierarchy of
    // low-poly parts, and filling a 32-person stop crowd synchronously used to
    // make one 40 ms hook even though subsequent animation was inexpensive.
    const preferRoof = needsRoof && (!needsGround || populationSpawnSerial % 2 === 0);
    populationSpawnSerial += 1;
    if (preferRoof) {
        const figuresBySurface = new Map();
        for (const walker of walkers) {
            if (!walker.roofSurfaceId) continue;
            figuresBySurface.set(
                walker.roofSurfaceId,
                (figuresBySurface.get(walker.roofSurfaceId) || 0) + walker.size,
            );
        }
        const availableSurfaces = roofSurfaces.filter(surface => (
            (figuresBySurface.get(surface.id) || 0) < roofActivityFigureCapacity(surface)
        ));
        if (availableSurfaces.length > 0) {
            const surface = availableSurfaces[spawnCursor++ % availableSurfaces.length];
            // Spawning only needs one safe point; cap random probes because a
            // deterministic seed is already available as the safe fallback.
            const spawn = sampleRoofActivityPoint(surface, Math.random, 8);
            if (spawn) createWalker(spawn.x, spawn.z, 1, { roofSurfaceId: surface.id });
        }
    } else if (needsGround && spawnPoints.length > 0) {
        const remaining = desiredGroundFigures - currentGroundFigures;
        const size = remaining >= 2 && Math.random() < PAIR_CHANCE ? 2 : 1;
        const stop = spawnPoints[spawnCursor++ % spawnPoints.length];
        let spawn = null;
        for (let attempt = 0; attempt < 8; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = useLocalWalkCrowd
                ? 10 + Math.random() * 28
                : 0.7 + Math.random() * 2.2;
            const candidate = {
                x: stop.x + Math.sin(angle) * radius,
                z: stop.z + Math.cos(angle) * radius,
            };
            if (pointInsideRenderedBuilding(candidate.x, candidate.z)) continue;
            if (unsafeExcavatedGroundAt(candidate.x, candidate.z)) continue;
            if (isAmbientWaterAt(candidate.x, candidate.z)) continue;
            spawn = candidate;
            break;
        }
        if (spawn) createWalker(spawn.x, spawn.z, size);
    }
    return roofFigureCount() < desiredRoofFigures
        || groundFigureCount() < desiredGroundFigures;
}

function soundNearbyDog() {
    const candidates = walkers.filter((walker) => {
        if (!walker.mesh.userData.dog || !walker.mesh.visible || walker.mesh.userData.petUntil > performance.now()) return false;
        return Math.hypot(walker.x - camera.position.x, walker.z - camera.position.z)
            <= DOG_BARK_MAX_DISTANCE_M;
    });
    if (candidates.length === 0) return false;
    const walker = candidates[Math.floor(Math.random() * candidates.length)];
    camera.updateMatrixWorld();
    dogCameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const spatial = dogBarkSpatial({
        dogX: walker.x,
        dogZ: walker.z,
        cameraX: camera.position.x,
        cameraZ: camera.position.z,
        cameraRightX: dogCameraRight.x,
        cameraRightZ: dogCameraRight.z,
        dogY: walker.mesh?.position?.y ?? null,
        cameraY: camera.position.y,
    });
    if (!spatial) return false;
    playDogBark({
        clipIndex: Math.floor(Math.random() * dogClipCount()),
        gain: spatial.gain,
        pan: spatial.pan,
        playbackRate: 0.92 + Math.random() * 0.16,
    });
    return true;
}

function dogWorld(walker) {
    const dog = walker.mesh?.userData?.dog;
    if (!dog) return null;
    walker.mesh.updateWorldMatrix(true, true);
    const p = new THREE.Vector3(); (dog.userData.dogMesh || dog).getWorldPosition(p); return p;
}

export function getNearbyDog(x, z, y = 0, radius = 3) {
    let best = null; let bestD = radius;
    for (const walker of walkers) {
        if (!walker.mesh?.userData?.dog || !walker.mesh.visible) continue;
        const p = dogWorld(walker); if (!p) continue;
        const d = Math.hypot(p.x - x, p.z - z); const dy = Math.abs(p.y - y);
        if (d <= bestD && dy <= 2) { bestD = d; best = { id: `dog-${walker.mesh.uuid}`, x: p.x, y: p.y, z: p.z }; }
    }
    return best;
}

export function holdDogInteraction(id, held) {
    const walker = walkers.find(w => `dog-${w.mesh.uuid}` === id && w.mesh.userData.dog);
    if (!walker) return false;
    walker.mesh.userData.petInteractionHeld = held === true;
    return true;
}

export function petNearbyDog(id, kind = 'pat') {
    const walker = walkers.find(w => w.mesh?.userData?.dog && `dog-${w.mesh.uuid}` === id);
    if (!walker || !['pat', 'scratch'].includes(kind)) return false;
    walker.mesh.userData.petStarted = performance.now(); walker.mesh.userData.petUntil = walker.mesh.userData.petStarted + 3700; walker.mesh.userData.petKind = kind;
    setDogHappyPose(walker.mesh.userData.dog);
    playDogPant({ gain: 0.5 }); return true;
}

export function setPedestrianFreeRoamEnabled(nextEnabled) { conversationsEnabled = !!nextEnabled; setPedestriansEnabled(nextEnabled); return conversationsEnabled; }

function tick(dt) {
    const step = Math.min(0.12, Math.max(0, dt));
    let phaseStartedMs = performance.now();
    // Run before population maintenance so a newly constructed actor can never
    // pay its first route plan in the same frame as its mesh construction.
    advanceRoadTargetSearches();
    recordLayerFrameMs('pedestrians:roadTargets', performance.now() - phaseStartedMs);
    phaseStartedMs = performance.now();
    tickSlidingDoors(step);
    const now = performance.now();
    for (const walker of walkers) {
        const until = walker.mesh?.userData?.petUntil;
        if (!until) continue;
        const elapsed = now - (walker.mesh.userData.petStarted || now);
        const progress = Math.max(0, Math.min(1, elapsed / 3700));
        const amount = progress < .18 ? progress / .18 : progress > .82 ? (1 - progress) / .18 : 1;
        const p = dogWorld(walker);
        if (p) {
            const dog = walker.mesh.userData.dog;
            const target = dog.worldToLocal(camera.position.clone());
            const head = dog.userData.head.position;
            const dx = target.x - head.x, dz = target.z - head.z;
            setDogHappyPose(dog, { amount, lookYaw: Math.atan2(dx, dz),
                lookPitch: -Math.atan2(target.y - head.y, Math.hypot(dx, dz)), timeS: elapsed / 1000 });
        }
        if (now >= until) { delete walker.mesh.userData.petUntil; delete walker.mesh.userData.petStarted; }
    }
    recordLayerFrameMs('pedestrians:doors', performance.now() - phaseStartedMs);
    populationTimer -= step;
    if (populationTimer <= 0) {
        phaseStartedMs = performance.now();
        populationTimer = maintainPopulation() ? POPULATION_FILL_INTERVAL_S : 0.8;
        recordLayerFrameMs('pedestrians:population', performance.now() - phaseStartedMs);
    }
    phaseStartedMs = performance.now();
    dogBarkTimer -= step;
    if (dogBarkTimer <= 0) {
        const foundDog = soundNearbyDog();
        dogBarkTimer = nextDogBarkDelayS({ foundDog, randomValue: Math.random() });
    }
    conversationController?.tick(step, conversationListener);
    recordLayerFrameMs('pedestrians:audio', performance.now() - phaseStartedMs);

    phaseStartedMs = performance.now();
    advanceRoofTargetSearches();
    recordLayerFrameMs('pedestrians:roofTargets', performance.now() - phaseStartedMs);

    phaseStartedMs = performance.now();
    const cullRadiusSq = CULL_RADIUS_M * CULL_RADIUS_M;
    for (let index = walkers.length - 1; index >= 0; index--) {
        const walker = walkers[index];
        const dx = walker.x - camera.position.x;
        const dz = walker.z - camera.position.z;
        if (dx * dx + dz * dz > cullRadiusSq) {
            removeWalker(index);
            continue;
        }
        walker.pendingDt = Math.min(0.12, (walker.pendingDt || 0) + step);
        if (walker.updatePhase !== pedestrianUpdatePhase) continue;
        const walkerStep = walker.pendingDt;
        walker.pendingDt = 0;
        if (walker.mesh?.userData?.petInteractionHeld || walker.mesh?.userData?.petUntil > performance.now()) continue;
        if (!updateWalker(walker, walkerStep)) removeWalker(index);
    }
    pedestrianUpdatePhase = (pedestrianUpdatePhase + 1) % PEDESTRIAN_UPDATE_PHASES;
    recordLayerFrameMs('pedestrians:walkers', performance.now() - phaseStartedMs);
}

export function setPedestriansEnabled(nextEnabled) {
    enabled = !!nextEnabled;
    populationTimer = 0;
    if (group) group.visible = enabled;
    if (!enabled) {
        conversationController?.stop();
        clearWalkers();
        clearSlidingDoors();
    }
    return enabled;
}

export function arePedestriansEnabled() {
    return enabled;
}

export function getPedestrianActivityDiagnostics() {
    return {
        enabled,
        conversation: conversationController?.snapshot() ?? null,
        figures: figureCount(),
        groundFigures: groundFigureCount(),
        roofFigures: roofFigureCount(),
        walkers: walkers.map(walker => {
            const firstPerson = walker.mesh?.userData?.people?.[0];
            const firstLeg = firstPerson?.userData?.walkLimbs?.legs?.[0]?.mesh;
            return {
                size: walker.size,
                x: walker.x,
                y: walker.mesh?.position?.y ?? null,
                z: walker.z,
                heading: walker.heading,
                meshYaw: walker.mesh?.rotation?.y ?? null,
                seatedLegMorph: firstLeg?.morphTargetInfluences?.[0] ?? null,
                targetKind: walker.targetKind,
                roofSurfaceId: walker.roofSurfaceId,
                benchId: walker.benchId,
            };
        }),
        dogs: walkers.flatMap(walker => {
            const p = dogWorld(walker); return p ? [{ id: `dog-${walker.mesh.uuid}`, x: p.x, y: p.y, z: p.z, petting: walker.mesh.userData.petUntil > performance.now() }] : [];
        }),
    };
}

export const pedestriansLayer = {
    getDiagnostics() { return getPedestrianActivityDiagnostics(); },
    beginSession(ctx) {
        anchorLat = ctx.anchorLat;
        anchorLon = ctx.anchorLon;
        terrain = ctx.terrain || null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = activeTerrainReference()?.onChange?.(() => {
            // Preserve the last valid support briefly while refreshes fan out.
            // Clearing and immediately resampling the entire crowd made every
            // expensive rendered-road probe land in the same animation frame.
            feetGroundCache.invalidateStaggered({
                minDelayMs: 16,
                spreadMs: TERRAIN_REFRESH_SPREAD_MS,
            });
        }) || null;
        renderedGroundYAt = typeof ctx.actorGroundYAt === 'function'
            ? ctx.actorGroundYAt
            : null;
        railFormation = ctx.railFormation || null;
        stationAccessPlans = railFormation?.getSurfaceStationAccessPlans?.() || [];
        stopPoints = (ctx.allStops || []).map(stopPoint).filter(Boolean);
        walkers = [];
        doorAnimations = new Map();
        benchReservations = new Map();
        feetGroundCache = createFeetGroundCache();
        populationTimer = 0;
        dogBarkTimer = nextDogBarkDelayS({ first: true, randomValue: Math.random() });
        conversationController?.stop();
        conversationController = null;
        conversationListener = null;
        spawnCursor = 0;
        populationSpawnSerial = 0;
        pedestrianUpdatePhase = 0;
        pedestrianUpdateSerial = 0;
        roadTargetSearchCursor = 0;
        roofTargetSearchCursor = 0;
        roadReady = false;
        isWalkSession = !!(ctx.isWalkMode && ctx.isWalkMode());
        conversationsEnabled = !!(ctx.isGtaSession && ctx.isGtaSession());
        enabled = ctx.arePedestriansEnabled
            ? !!ctx.arePedestriansEnabled()
            : !isWalkSession;
        group = new THREE.Group();
        group.name = 'ambient-pedestrians';
        group.visible = enabled;
        scene.add(group);
        prepareAmbientPersonMeshAssets();
        prepareDogMeshAssets();
        // dt is zero during loading/paused tram starts, so no walker is drawn
        // then. Warm all three real leg schemas and the rare leash explicitly;
        // these detached actors never enter the visible population.
        const generation = ++sessionGeneration;
        const shaderEntry = { warmup: null };
        pedestrianShaderStartup = createLayerStartupCoordinator({
            isCurrent: () => generation === sessionGeneration && !!group,
            async begin(entry) {
                entry.warmup?.dispose();
                const shaderRoot = new THREE.Group();
                for (const kind of ['kid', 'female', 'male']) shaderRoot.add(createPersonMesh({ kind }));
                shaderRoot.add(createLeashedDog({ random: () => 0 }));
                entry.warmup = pedestrianMaterialWarmup = createQueuedShaderWarmup(shaderRoot, {
                    renderer, camera, targetScene: scene, label: 'pedestrian-shader-warmup',
                });
                const result = await entry.warmup.completion;
                if (result.error) throw result.error;
            },
            cleanup(entry) {
                // Keep the failed queue's readiness error visible until retry.
                // Late completion owns only its old job, never a newer session.
                if (generation !== sessionGeneration) return entry.warmup?.dispose();
            },
            onFailure(entry, error, state) {
                console.error(`[${new Date().toISOString()}] [Pedestrians] Shader warmup attempt ${state.attempts} failed; retry scheduled:`, error);
            },
        });
        void pedestrianShaderStartup.start(shaderEntry);
        preloadDogSfx();
        if (conversationsEnabled) {
            preloadPedestrianConversations();
            conversationController = createPedestrianConversationController({
                getPairs: () => walkers,
                getMembers: walker => pedestrianConversationMembers(walker, scene),
                getLanguage: getLang,
                getCityId: () => pedestrianConversationCity(getLocation()),
                playLine: playPedestrianConversationLine,
                updateLine: updatePedestrianConversationSpatial,
                stopLine: stopPedestrianConversations,
            });
        }

        ensureRoadIndex().then(() => {
            if (group && generation === sessionGeneration) roadReady = true;
        });
    },
    onFrame(pose, local, dt) {
        pedestrianShaderStartup?.tick();
        // Layer poses follow the player/vehicle, whereas the chase camera can
        // sit many metres behind them. Only its orientation controls panning.
        if (conversationController) {
            camera.updateMatrixWorld();
            conversationCameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
            conversationListener = Number.isFinite(local?.x) && Number.isFinite(local?.z)
                && Number.isFinite(pose?.y) ? {
                    x: local.x, y: pose.y + 1.55, z: local.z,
                    rightX: conversationCameraRight.x, rightZ: conversationCameraRight.z,
                } : null;
        }
        if (enabled && group && pedestrianMaterialWarmup?.ready && dt > 0) tick(dt);
        else conversationController?.tick(0, conversationListener);
    },
    endSession() {
        sessionGeneration += 1;
        pedestrianShaderStartup?.dispose();
        pedestrianShaderStartup = null;
        pedestrianMaterialWarmup?.dispose();
        pedestrianMaterialWarmup = null;
        clearSlidingDoors();
        for (const walker of walkers) {
            cancelRoadTargetSearch(walker);
            cancelRoofTargetSearch(walker);
        }
        walkers.length = 0;
        stopPoints = [];
        roadReady = false;
        terrain = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        renderedGroundYAt = null;
        railFormation = null;
        stationAccessPlans = [];
        isWalkSession = false;
        conversationsEnabled = false;
        enabled = true;
        benchReservations.clear();
        feetGroundCache.clear();
        stopDogSfx();
        conversationController?.stop();
        conversationController = null;
        conversationListener = null;
        stopPedestrianConversations();
        populationSpawnSerial = 0;
        roadTargetSearchCursor = 0;
        roofTargetSearchCursor = 0;
        if (group && group.parent) group.parent.remove(group);
        group = null;
        for (const resource of [
            doorPlaneGeo,
            doorBoxGeo,
            doorRecessMat,
            doorPanelMat,
            doorFrameMat,
        ]) {
            if (!resource) continue;
            unregisterShared(resource);
            resource.dispose();
        }
        doorPlaneGeo = doorBoxGeo = null;
        doorRecessMat = doorPanelMat = doorFrameMat = null;
    },
};
