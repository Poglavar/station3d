// Bounded GTA-only boats and aircraft. This layer moors a few boats along the
// loaded shoreline near the player (sea, lakes and rivers alike, each tied to
// its bank with a rope) and parks aircraft on loaded OSM runways, then
// exposes claim/sync operations to the possession controller without owning
// input or physics.

import { nearestNavigableBoatPose } from '../core/boat-navigation.js';
import { BOAT_HULL_DIMENSIONS } from '../models/vehicles/boat-airplane-geometry.js';
import * as THREE from 'three';

import { disposeGroup } from '../core/dispose.js';
import { createQueuedShaderWarmup } from '../core/queued-shader-warmup.js';
import { createLayerStartupCoordinator } from '../core/layer-startup.js';
import {
    findNearestWaterSpawn,
    mappedBoatSpawnCandidates,
    runwayParkingSpots,
    runwaySide,
} from '../core/gta-special-vehicle-spawns.js';
import { shorelineMoorings } from '../core/boat-moorings.js';
import { DEG_TO_RAD, geoToLocal } from '../core/math.js';
import {
    createGtaSpecialVehicleState,
    failAircraftEngine,
    gtaSpecialVehiclePose,
    stepGtaSpecialVehicle,
} from '../core/gta-special-vehicle.js';
import {
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { scene, camera, renderer } from '../scene/setup.js';
import { WATER_LEVELS } from './ground-surface-levels.js';
import {
    GREENERY_RADIUS_M,
    decorWaterShorelineRings,
    getRunwaySpawnCandidatesNear,
    isPointInDecorWater,
    isPointInLoadedRunway,
} from './decor.js';
import { isPointInMappedSea, mappedSeaSurfaceSceneY, mappedShorelineRings } from './water.js';
import { createBoatMesh, createAirplaneMesh } from '../models/vehicles/boat-airplane.js';
import { createAircraftMesh, preloadAircraftModels } from '../models/vehicles/aircraft-models.js';
import { animatePersonSit, createPersonMesh } from './person-mesh.js';
import { PLAYER_PERSON_LOOK } from './player-walker-avatar.js';
import { createAirplaneBreakupController } from '../models/vehicles/airplane-breakup.js';
import { playAircraftCrashSfx } from '../ui/aircraft-crash-sfx.js';
import { createAircraftCrashLifecycle } from '../core/aircraft-crash-lifecycle.js';

const SPAWN_CHECK_SECONDS = 0.75;
const RETIRE_DISTANCE_M = 2200;
const BOAT_SEARCH_RADIUS_M = 350;
const NAMED_BOAT_SEARCH_RADIUS_M = 1900;
// Runways are known only as far as the greenery layer has loaded them.
const AIRCRAFT_SEARCH_RADIUS_M = GREENERY_RADIUS_M;
const MAX_BOATS = 5;
// Where the mooring rope leaves the hull: the bow cleat, in model metres.
const BOAT_BOW_CLEAT = Object.freeze({ y: 1.05, z: 4.0 });
const MAX_AIRCRAFT = 4;
// A row of light aircraft on the apron side of each runway.
const AIRCRAFT_PER_RUNWAY = 3;
// Seated in the authored cabin: sized so the head sits under the roof and the
// eyes in the windshield.
const AIRPLANE_PILOT_SCALE = 0.6;
// A held simulation (a cinematic lease) freezes the solver's propeller angle;
// the prop idles on render time meanwhile, at a running or a windmilling rate.
const PROPELLER_RENDER_RAD_S = Object.freeze({ running: 38, windmilling: 3 });

// Stable Zagreb moorings, verified inside the current OSM water polygons on
// 2026-08-13. Jarun uses relation 2149852; the city Sava uses way 793815179.
// Runtime water gating remains authoritative if either source is later edited.
const ZAGREB_BOAT_ANCHORS = Object.freeze([
    { id: 'jarun-west', lat: 45.782640, lon: 15.913360, heading: Math.PI * 0.5 },
    { id: 'jarun-centre', lat: 45.781320, lon: 15.917360, heading: Math.PI * 0.5 },
    { id: 'jarun-east', lat: 45.781920, lon: 15.922320, heading: Math.PI * 0.5 },
    { id: 'sava-savski-west', lat: 45.781150, lon: 15.948000, heading: Math.PI * 0.5 },
    { id: 'sava-savski-east', lat: 45.786640, lon: 15.960880, heading: Math.PI * 0.5 },
    { id: 'sava-liberty-west', lat: 45.789220, lon: 15.974360, heading: Math.PI * 0.5 },
    { id: 'sava-liberty-east', lat: 45.789070, lon: 15.985360, heading: Math.PI * 0.5 },
    { id: 'sava-youth-east', lat: 45.782800, lon: 16.007040, heading: Math.PI * 0.5 },
]);

let specialVehiclesGroup = null;
let enabled = false;
let boatsEnabled = false;
let aircraftEnabled = false;
let terrainReference = null;
let terrainUnsubscribe = null;
let anchorLat = 0;
let anchorLon = 0;
let boatSpawnAnchors = [];
let aircraftSpawnAnchors = [];
let nextSpawnCheckMs = 0;
let lastRenderNowMs = 0;
let sessionGeneration = 0;
let mooringShaderStartup = null;
let mooringShaderWarmup = null;
const vehicles = new Map();
const activeAircraftCrashVehicles = new Set();
// Authored vehicles the story has retired; the spawn scan must not republish them.
const retiredVehicleIds = new Set();

const specialVehicleEnvironment = Object.freeze({
    isWaterAt: (x, z) => waterAt(x, z),
    waterYAt: (x, z) => waterYAt(x, z),
    isRunwayAt: (x, z) => isPointInLoadedRunway(x, z),
    groundYAt: (x, z) => terrainYAtLocal(x, z),
});


function terrainYAtLocal(x, z) {
    if (!terrainReference) return 0;
    const y = terrainReference.evidenceSceneYAtLocal?.(x, z);
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
}

function waterAt(x, z) {
    return isPointInMappedSea(x, z) || isPointInDecorWater(x, z);
}

function waterYAt(x, z) {
    if (isPointInMappedSea(x, z)) return mappedSeaSurfaceSceneY() + 0.08;
    // Decor lakes and rivers are draped on the authoritative terrain at this
    // same semantic offset (world/decor.js); boats must follow that surface.
    const terrainY = terrainYAtLocal(x, z);
    return terrainY === null
        ? null
        : terrainY + WATER_LEVELS.naturalBankTop + 0.002;
}

function setVehicleMeshPose(vehicle) {
    const mesh = vehicle?.mesh;
    if (!mesh) return;
    mesh.position.set(vehicle.x, vehicle.y, vehicle.z);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Number(vehicle.heading) || 0;
    mesh.rotation.x = -(Number(vehicle.pitch) || 0);
    mesh.rotation.z = -(Number(vehicle.roll) || 0);
    if (mesh.userData.propeller) {
        mesh.userData.propeller.rotation.z = Number(vehicle.propellerAngle) || 0;
    }
    const wake = mesh.userData.wake;
    if (wake) {
        const speedRatio = THREE.MathUtils.clamp(Math.abs(Number(vehicle.speedMps) || 0) / 18, 0, 1);
        wake.visible = speedRatio > 0.025;
        wake.scale.set(0.76 + speedRatio * 0.34, 1, 0.4 + speedRatio * 0.5);
        wake.userData.foamMaterial.opacity = speedRatio * 0.24;
        wake.userData.sprayMaterial.opacity = speedRatio * 0.62;
        wake.userData.sprayMaterial.size = 0.08 + speedRatio * 0.13;
        const phase = Number(vehicle.wakePhase) || 0;
        const positions = wake.userData.sprayPositions;
        for (let index = 0; index < 8; index += 1) {
            const side = index % 2 === 0 ? -1 : 1;
            const lane = Math.floor(index / 2);
            const pulse = (phase + lane * 1.37) % (Math.PI * 2);
            positions[index * 3] = side * (0.58 + lane * 0.13 + Math.sin(pulse) * 0.11);
            positions[index * 3 + 1] = speedRatio * (0.08 + (Math.sin(pulse) + 1) * 0.16);
            positions[index * 3 + 2] = -0.25 - lane * 0.72 - Math.cos(pulse) * 0.18;
        }
        wake.userData.sprayAttribute.needsUpdate = true;
    }
}

function clearAircraftCrash(vehicle) {
    vehicle?.crashLifecycle?.reset?.();
    activeAircraftCrashVehicles.delete(vehicle);
}

function settleAircraftWreck(vehicle) {
    if (vehicle.kind !== 'airplane') return;
    vehicle.crashLifecycle?.settle();
}

function syncAircraftCrash(vehicle) {
    if (vehicle.crashLifecycle?.sync(vehicle.wrecked)) activeAircraftCrashVehicles.add(vehicle);
    if (!vehicle.crashLifecycle?.active) activeAircraftCrashVehicles.delete(vehicle);
}

function advanceAircraftCrashEffects() {
    if (activeAircraftCrashVehicles.size === 0) return;
    for (const vehicle of activeAircraftCrashVehicles) {
        // Render-time, not simulation-time: campaign failure UI may pause dt
        // while this finite visual settles, but aircraft physics stays frozen.
        if (vehicle.crashLifecycle?.advance()) continue;
        activeAircraftCrashVehicles.delete(vehicle);
    }
}

function syncVehicle(id, pose) {
    const vehicle = vehicles.get(id);
    if (!vehicle || !pose) return false;
    for (const key of [
        'x', 'y', 'z', 'heading', 'pitch', 'roll', 'speedMps', 'grounded',
        'throttle', 'propellerAngle', 'wakePhase', 'engineFailed', 'wrecked', 'surface',
    ]) {
        if (pose[key] !== undefined) vehicle[key] = pose[key];
    }
    if (vehicle.kind === 'airplane') {
        vehicle.airborne = pose.airborne !== undefined ? !!pose.airborne : !vehicle.grounded;
        // A hull afloat or a wreck is no longer seated on terrain, and nobody
        // boards it again.
        if (vehicle.surface === 'water' || vehicle.wrecked) {
            vehicle.terrainRelative = false;
            vehicle.available = false;
        }
    }
    setVehicleMeshPose(vehicle);
    if (vehicle.kind === 'airplane') {
        // addVehicle seeds the initial wreck state, so the first actual
        // false -> true pose transition is audible even on its first sync.
        syncAircraftCrash(vehicle);
    }
    return true;
}

// An authored flight already under way: the aircraft hangs at its altitude
// above the sea datum, engine running (or already dead when a checkpoint says
// so), waiting for the initial claim. It is never retired for distance.
function ensureAuthoredAircraft() {
    for (const anchor of aircraftSpawnAnchors) {
        const id = `gta-airplane:${anchor?.id || ''}`;
        if (!anchor?.id || vehicles.has(id) || retiredVehicleIds.has(id)) continue;
        const lat = Number(anchor.lat);
        const lon = Number(anchor.lon);
        const altitudeM = Number(anchor.altitudeM);
        if (![lat, lon, altitudeM].every(Number.isFinite)) continue;
        const local = geoToLocal(lon, lat, anchorLon, anchorLat);
        const heading = Number.isFinite(anchor.headingDeg)
            ? Math.PI - anchor.headingDeg * DEG_TO_RAD
            : Number(anchor.heading) || 0;
        const y = mappedSeaSurfaceSceneY() + altitudeM;
        const mesh = createAircraftMesh({ model: anchor.model, interior: anchor.interior || null });
        // The pilot is the player: seated in the authored cabin with the
        // player's own look, shown while someone is at the controls.
        if (anchor.pilot === 'player' && mesh.userData.pilotSeat) {
            const pilot = createPersonMesh({ ...PLAYER_PERSON_LOOK });
            pilot.name = 'GtaAirplanePilot';
            pilot.scale.setScalar(AIRPLANE_PILOT_SCALE);
            animatePersonSit(pilot, 1);
            mesh.userData.pilotSeat.add(pilot);
            mesh.userData.pilot = pilot;
        }
        addVehicle({
            id,
            kind: 'airplane',
            x: local.x,
            y,
            z: local.z,
            heading,
            pitch: 0,
            roll: 0,
            speedMps: Number(anchor.speedMps) || 0,
            grounded: false,
            airborne: true,
            engineFailed: anchor.engineFailed === true,
            width: mesh.userData.dimensions?.width ?? 8.6,
            length: mesh.userData.dimensions?.length ?? 7.7,
            height: mesh.userData.dimensions?.height ?? 3.2,
            enterDistanceM: 8,
            available: true,
            parked: true,
            destroyed: false,
            claimed: false,
            terrainRelative: false,
            persistent: true,
            spawn: {
                x: local.x,
                y,
                z: local.z,
                heading,
                airborne: true,
                speedMps: Number(anchor.speedMps) || 0,
                engineFailed: anchor.engineFailed === true,
            },
            mesh,
        });
    }
}

// A glider the pilot bailed out of flies on by itself until it meets the sea
// or the ground; it then stays where it came down as a wreck or a hull.
function stepAutonomousAircraft(dt) {
    const seconds = Math.max(0, Number(dt) || 0);
    if (seconds <= 0) return;
    for (const vehicle of vehicles.values()) {
        const state = vehicle.autonomous;
        if (!state) continue;
        stepGtaSpecialVehicle(state, {}, seconds, specialVehicleEnvironment);
        syncVehicle(vehicle.id, gtaSpecialVehiclePose(state));
        if (state.grounded) {
            vehicle.autonomous = null;
            vehicle.available = false;
        }
    }
}

// Only while the simulation is held: the solver's own angle takes the prop
// back on the first stepped frame. A grounded hull or a wreck stays still.
function spinIdleAircraftPropellers(renderDt) {
    if (!(renderDt > 0)) return;
    for (const vehicle of vehicles.values()) {
        const propeller = vehicle.kind === 'airplane' ? vehicle.mesh?.userData?.propeller : null;
        if (!propeller || vehicle.grounded || vehicle.wrecked) continue;
        propeller.rotation.z += renderDt * (vehicle.engineFailed
            ? PROPELLER_RENDER_RAD_S.windmilling
            : PROPELLER_RENDER_RAD_S.running);
    }
}

function addVehicle(vehicle) {
    if (!specialVehiclesGroup || vehicles.has(vehicle.id)) return null;
    vehicle.wrecked = vehicle.wrecked === true;
    if (vehicle.kind === 'airplane') {
        vehicle.crashLifecycle = createAircraftCrashLifecycle({
            wrecked: vehicle.wrecked,
            createVisual: () => createAirplaneBreakupController(vehicle.mesh),
            playSound: playAircraftCrashSfx,
        });
    }
    specialVehiclesGroup.add(vehicle.mesh);
    vehicles.set(vehicle.id, vehicle);
    setVehicleMeshPose(vehicle);
    if (vehicle.kind === 'airplane' && vehicle.wrecked) settleAircraftWreck(vehicle);
    return vehicle;
}

// A moored boat's rope runs from the bow cleat to the bank it is tied to; it
// goes with the first claim, since a boat under way tows nothing.
function setRopePose(vehicle) {
    const rope = vehicle?.rope;
    if (!rope || !vehicle.mooring) return;
    const scale = vehicle.hullScale || 1;
    const bowX = vehicle.x + Math.sin(vehicle.heading) * BOAT_BOW_CLEAT.z * scale;
    const bowZ = vehicle.z + Math.cos(vehicle.heading) * BOAT_BOW_CLEAT.z * scale;
    const bankY = terrainYAtLocal(vehicle.mooring.x, vehicle.mooring.z);
    const shoreY = Math.max(vehicle.y + 0.35, bankY === null ? -Infinity : bankY + 0.25);
    const positions = rope.geometry.attributes.position;
    positions.setXYZ(0, bowX, vehicle.y + BOAT_BOW_CLEAT.y * scale, bowZ);
    positions.setXYZ(1, vehicle.mooring.x, shoreY, vehicle.mooring.z);
    positions.needsUpdate = true;
    rope.geometry.computeBoundingSphere();
}

function removeRope(vehicle) {
    const rope = vehicle?.rope;
    if (!rope) return;
    if (rope.parent) rope.parent.remove(rope);
    rope.geometry.dispose();
    rope.material.dispose();
    vehicle.rope = null;
}

function createMooringRope() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const rope = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x4a3524 }));
    rope.name = 'GtaBoatMooringRope';
    rope.frustumCulled = false;
    return rope;
}

function startMooringShaderWarmup(generation) {
    const entry = { warmup: null };
    mooringShaderStartup = createLayerStartupCoordinator({
        isCurrent: () => generation === sessionGeneration && boatsEnabled,
        async begin(entry) {
            entry.warmup?.dispose();
            const root = new THREE.Group();
            const rope = createMooringRope();
            const originalMaterial = rope.material;
            root.add(rope);
            try {
                // Keep the same real line schema as the eventual rope. The
                // warmup owns a material clone, retaining its program even if
                // no shoreline/boat exists at initial world completion.
                const warmup = entry.warmup = mooringShaderWarmup = createQueuedShaderWarmup(root, {
                    renderer, camera, targetScene: scene, label: 'mooring-shader-warmup',
                });
                const result = await warmup.completion;
                if (result.closed) await warmup.dispose();
                if (result.error) throw result.error;
            } finally {
                originalMaterial.dispose();
                rope.geometry.dispose();
            }
        },
        cleanup(entry) {
            if (generation !== sessionGeneration) return entry.warmup?.dispose();
        },
        onFailure(_entry, error, state) {
            console.error(`[SpecialVehicles] Mooring shader attempt ${state.attempts} failed; retry scheduled:`, error);
        },
    });
    void mooringShaderStartup.start(entry);
}

function addBoat(spawn, id) {
    const label = spawn?.label || null;
    const hullScale = Number.isFinite(spawn?.hullScale) && spawn.hullScale > 0 ? spawn.hullScale : 1;
    spawn = nearestNavigableBoatPose({ ...spawn, hullScale }, waterAt);
    if (!spawn) return null;
    const y = waterYAt(spawn.x, spawn.z);
    if (y === null) return null;
    const mesh = createBoatMesh(spawn.lettering || {});
    mesh.scale.setScalar(hullScale);
    const vehicle = addVehicle({
        id,
        label,
        kind: 'boat',
        x: spawn.x,
        y,
        z: spawn.z,
        heading: spawn.heading,
        pitch: 0,
        roll: 0,
        speedMps: 0,
        width: BOAT_HULL_DIMENSIONS.width * hullScale,
        length: BOAT_HULL_DIMENSIONS.length * hullScale,
        height: BOAT_HULL_DIMENSIONS.height * hullScale,
        hullScale,
        enterDistanceM: 14,
        available: true,
        parked: true,
        destroyed: false,
        claimed: false,
        terrainRelative: !isPointInMappedSea(spawn.x, spawn.z),
        mooring: spawn.rope ? { x: spawn.rope.x, z: spawn.rope.z } : null,
        rope: null,
        spawn: { ...spawn, y },
        mesh,
    });
    if (vehicle?.mooring) {
        const rope = createMooringRope();
        specialVehiclesGroup.add(rope);
        vehicle.rope = rope;
        setRopePose(vehicle);
    }
    return vehicle;
}

function ensureBoats(local) {
    let boatCount = [...vehicles.values()].filter(vehicle => vehicle.kind === 'boat').length;
    if (boatCount >= MAX_BOATS) return;

    const named = mappedBoatSpawnCandidates([
        ...boatSpawnAnchors,
        ...ZAGREB_BOAT_ANCHORS,
    ], {
        x: Number(local?.x),
        z: Number(local?.z),
        toLocal: (lon, lat) => geoToLocal(lon, lat, anchorLon, anchorLat),
        isWaterAt: waterAt,
        maxDistanceM: NAMED_BOAT_SEARCH_RADIUS_M,
    });
    for (const spawn of named) {
        if (boatCount >= MAX_BOATS) break;
        const id = `gta-boat:${spawn.id}`;
        if (vehicles.has(id)) continue;
        if (addBoat(spawn, id)) boatCount += 1;
    }
    if (boatCount >= MAX_BOATS) return;

    // Boats tied along whatever bank is loaded nearby: the sea's coastline and
    // the decor lakes and rivers, nearest mooring first.
    const moorings = shorelineMoorings({
        rings: [...mappedShorelineRings(), ...decorWaterShorelineRings()],
        x: Number(local?.x),
        z: Number(local?.z),
        isWaterAt: waterAt,
        radiusM: BOAT_SEARCH_RADIUS_M,
    });
    for (const mooring of moorings) {
        if (boatCount >= MAX_BOATS) break;
        const id = `gta-boat:${mooring.id}`;
        if (vehicles.has(id)) continue;
        if (addBoat(mooring, id)) boatCount += 1;
    }
    if (boatCount > 0) return;

    // Preserve the national fallback: mapped water with no usable bank nearby
    // still gets one enterable boat.
    const spawn = findNearestWaterSpawn({
        x: Number(local?.x),
        z: Number(local?.z),
        isWaterAt: waterAt,
        minRadiusM: 8,
        maxRadiusM: BOAT_SEARCH_RADIUS_M,
        radiusStepM: 8,
        directionCount: 40,
    });
    if (!spawn) return;
    addBoat(spawn, `gta-boat:${Math.round(spawn.x / 10)}:${Math.round(spawn.z / 10)}`);
}

function ensureAircraft(local) {
    const aircraftCount = [...vehicles.values()]
        .filter(vehicle => vehicle.kind === 'airplane').length;
    if (aircraftCount >= MAX_AIRCRAFT) return;
    let remainingSlots = MAX_AIRCRAFT - aircraftCount;
    const candidates = getRunwaySpawnCandidatesNear(
        Number(local?.x),
        Number(local?.z),
        AIRCRAFT_SEARCH_RADIUS_M,
    );
    if (candidates.length === 0) return;
    // Parked beside the runway on the side the player is on, nose along it;
    // never on the strip itself, in water, or where the ground is unknown.
    for (const candidate of candidates
        .sort((left, right) => (
            Math.hypot(left.x - local.x, left.z - local.z)
                - Math.hypot(right.x - local.x, right.z - local.z)
        ))) {
        if (remainingSlots <= 0) break;
        const side = runwaySide(candidate, local.x, local.z);
        for (const spot of runwayParkingSpots(candidate, { count: AIRCRAFT_PER_RUNWAY, side })) {
        if (remainingSlots <= 0) break;
        const id = `gta-airplane:${spot.id}`;
        if (vehicles.has(id) || retiredVehicleIds.has(id)) continue;
        if (waterAt(spot.x, spot.z) || isPointInLoadedRunway(spot.x, spot.z)) continue;
        const terrainY = terrainYAtLocal(spot.x, spot.z);
        if (terrainY === null) continue;
        const y = terrainY + 0.45;
        const added = addVehicle({
            id,
            kind: 'airplane',
            x: spot.x,
            y,
            z: spot.z,
            heading: spot.heading,
            pitch: 0,
            roll: 0,
            speedMps: 0,
            grounded: true,
            width: 8.6,
            length: 7.7,
            height: 3.2,
            enterDistanceM: 8,
            available: true,
            parked: true,
            destroyed: false,
            claimed: false,
            terrainRelative: true,
            runwayRing: candidate.ring,
            spawn: { x: spot.x, y, z: spot.z, heading: spot.heading },
            mesh: createAirplaneMesh(),
        });
        if (added) remainingSlots -= 1;
        }
    }
}

function retireDistantVehicles(local) {
    for (const [id, vehicle] of vehicles) {
        if (vehicle.claimed || vehicle.persistent) continue;
        if (Math.hypot(vehicle.x - local.x, vehicle.z - local.z) <= RETIRE_DISTANCE_M) continue;
        clearAircraftCrash(vehicle);
        removeRope(vehicle);
        if (vehicle.mesh?.parent) vehicle.mesh.parent.remove(vehicle.mesh);
        disposeGroup(vehicle.mesh);
        vehicles.delete(id);
    }
}

function refreshUnclaimedTerrainPlacements() {
    for (const vehicle of vehicles.values()) {
        if (vehicle.claimed || !vehicle.terrainRelative) continue;
        const supportY = vehicle.kind === 'boat'
            ? waterYAt(vehicle.x, vehicle.z)
            : terrainYAtLocal(vehicle.x, vehicle.z);
        if (supportY === null) {
            vehicle.mesh.visible = false;
            continue;
        }
        vehicle.y = vehicle.kind === 'airplane' ? supportY + 0.45 : supportY;
        vehicle.mesh.visible = true;
        setVehicleMeshPose(vehicle);
        setRopePose(vehicle);
    }
}

export const gtaSpecialVehicleProvider = Object.freeze({
    findNearest(x, z, { kinds = null } = {}) {
        const allowedKinds = Array.isArray(kinds) ? new Set(kinds) : null;
        let best = null;
        for (const vehicle of vehicles.values()) {
            if (!vehicle.available || vehicle.claimed || vehicle.destroyed
                || vehicle.mesh?.visible === false) continue;
            if (allowedKinds && !allowedKinds.has(vehicle.kind)) continue;
            const distanceM = Math.hypot(vehicle.x - x, vehicle.z - z);
            if (distanceM > vehicle.enterDistanceM || (best && distanceM >= best.distanceM)) continue;
            best = { ...vehicle, distanceM, reachable: true };
        }
        return best;
    },
    claim(id) {
        const vehicle = vehicles.get(id);
        if (!vehicle || !vehicle.available || vehicle.claimed || vehicle.destroyed) return null;
        vehicle.available = false;
        vehicle.claimed = true;
        // Cast off: the mooring rope is gone for good once someone takes the helm.
        removeRope(vehicle);
        vehicle.mooring = null;
        if (vehicle.mesh?.userData?.pilot) vehicle.mesh.userData.pilot.visible = true;
        return { ...vehicle };
    },
    sync(id, pose) {
        return syncVehicle(id, pose);
    },
    release(id, pose, { autonomous = null } = {}) {
        const vehicle = vehicles.get(id);
        if (!vehicle) return false;
        syncVehicle(id, pose);
        vehicle.claimed = false;
        // Nobody is at the controls any more: the seat empties.
        if (vehicle.mesh?.userData?.pilot) vehicle.mesh.userData.pilot.visible = false;
        vehicle.available = !(vehicle.surface === 'water' || vehicle.wrecked);
        // A bailed-out aircraft keeps its live motion state and glides on.
        vehicle.autonomous = autonomous && vehicle.kind === 'airplane' && !vehicle.grounded
            ? autonomous
            : null;
        if (vehicle.autonomous) vehicle.available = false;
        return true;
    },
    resetPose(id) {
        const vehicle = vehicles.get(id);
        if (vehicle?.kind === 'airplane') clearAircraftCrash(vehicle);
        return vehicle?.spawn ? { ...vehicle.spawn } : null;
    },
    // The authored engine failure for an aircraft nobody is flying: an
    // abandoned glider, or one waiting to be claimed from a checkpoint.
    failEngine(id) {
        const vehicle = vehicles.get(id);
        if (!vehicle || vehicle.kind !== 'airplane') return false;
        vehicle.engineFailed = true;
        if (vehicle.spawn) vehicle.spawn.engineFailed = true;
        if (vehicle.autonomous) failAircraftEngine(vehicle.autonomous);
        return true;
    },
    // The story is done with a named vehicle nobody is flying (the hull the
    // splashdown film sank): it leaves the world and never respawns this session.
    // A set piece filming its own stand-in for a vehicle kind (the Adriatic
    // crossing hero boat) hides the real ones for those frames, so neither the
    // courier's moored boat nor an ambient one lingers in the exterior shots.
    setKindHiddenByFilm(kind, hidden) {
        for (const vehicle of vehicles.values()) {
            if (vehicle.kind !== kind || !vehicle.mesh || vehicle.hiddenByFilm === !!hidden) continue;
            vehicle.hiddenByFilm = !!hidden;
            vehicle.mesh.visible = !hidden;
        }
    },
    retire(id) {
        const vehicle = vehicles.get(id);
        // Already sunk, disposed by an earlier retire, or never spawned in this
        // session (a direct checkpoint): the postcondition holds.
        if (!vehicle) return true;
        if (vehicle.claimed) return false;
        clearAircraftCrash(vehicle);
        removeRope(vehicle);
        vehicle.autonomous = null;
        if (vehicle.mesh?.parent) vehicle.mesh.parent.remove(vehicle.mesh);
        disposeGroup(vehicle.mesh);
        vehicles.delete(id);
        retiredVehicleIds.add(id);
        return true;
    },
    isWaterAt: waterAt,
    waterYAt,
    isRunwayAt: isPointInLoadedRunway,
    groundYAt: terrainYAtLocal,
    debugState() {
        const all = [...vehicles.values()];
        return {
            total: vehicles.size,
            boats: all.filter(vehicle => vehicle.kind === 'boat').length,
            moored: all.filter(vehicle => vehicle.kind === 'boat' && vehicle.mooring).length,
            aircraft: all.filter(vehicle => vehicle.kind === 'airplane').length,
            claimed: all.filter(vehicle => vehicle.claimed).length,
            vehicleIds: [...vehicles.keys()],
            boatsDetail: all.filter(vehicle => vehicle.kind === 'boat').map(vehicle => ({
                id: vehicle.id, x: Math.round(vehicle.x), z: Math.round(vehicle.z), hullScale: vehicle.hullScale,
                rope: !!vehicle.rope, claimed: vehicle.claimed, label: vehicle.label,
            })),
        };
    },
});

if (typeof window !== 'undefined') {
    window.__s3dSpecialVehicles = () => gtaSpecialVehicleProvider.debugState();
}

export const gtaSpecialVehiclesLayer = {
    async beginSession({
        sessionCapabilities,
        terrain,
        anchorLat: sessionLat,
        anchorLon: sessionLon,
        boatSpawnAnchors: sessionBoatSpawnAnchors,
        aircraftSpawnAnchors: sessionAircraftSpawnAnchors,
    }) {
        const generation = ++sessionGeneration;
        mooringShaderStartup?.dispose();
        mooringShaderStartup = null;
        mooringShaderWarmup?.dispose();
        mooringShaderWarmup = null;
        if (sessionCapabilityEnabled(sessionCapabilities, SESSION_CAPABILITY.AIRCRAFT)) {
            await preloadAircraftModels(sessionAircraftSpawnAnchors || []);
        }
        if (generation !== sessionGeneration) return;
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        boatsEnabled = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.BOATS,
        );
        aircraftEnabled = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.AIRCRAFT,
        );
        enabled = boatsEnabled || aircraftEnabled;
        terrainReference = terrain || null;
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            refreshUnclaimedTerrainPlacements();
            nextSpawnCheckMs = 0;
        }) || null;
        anchorLat = Number(sessionLat) || 0;
        anchorLon = Number(sessionLon) || 0;
        boatSpawnAnchors = Array.isArray(sessionBoatSpawnAnchors)
            ? sessionBoatSpawnAnchors
            : [];
        aircraftSpawnAnchors = Array.isArray(sessionAircraftSpawnAnchors) && aircraftEnabled
            ? sessionAircraftSpawnAnchors
            : [];
        nextSpawnCheckMs = 0;
        lastRenderNowMs = 0;
        vehicles.clear();
        activeAircraftCrashVehicles.clear();
        retiredVehicleIds.clear();
        if (!enabled) return;
        specialVehiclesGroup = new THREE.Group();
        specialVehiclesGroup.name = 'GtaSpecialVehicles';
        scene.add(specialVehiclesGroup);
        if (boatsEnabled) startMooringShaderWarmup(generation);
        // The authored flight must exist before the first frame's initial
        // claim looks for it; it does not wait for the spawn scan cadence.
        ensureAuthoredAircraft();
    },
    onFrame(_pose, local, dt) {
        if (!enabled || !specialVehiclesGroup || !local) return;
        mooringShaderStartup?.tick();
        const nowMs = performance.now();
        const renderDt = lastRenderNowMs > 0 ? Math.min(0.1, (nowMs - lastRenderNowMs) / 1000) : 0;
        lastRenderNowMs = nowMs;
        // Simulation dt: an abandoned glider freezes with everything else
        // while paused, and never advances on a render-only frame.
        stepAutonomousAircraft(dt);
        advanceAircraftCrashEffects();
        if (!(Number(dt) > 0)) spinIdleAircraftPropellers(renderDt);
        // World publication must progress while loading or pause holds
        // simulation dt at zero, including water arriving after the first scan.
        if (nowMs < nextSpawnCheckMs) return;
        nextSpawnCheckMs = nowMs + SPAWN_CHECK_SECONDS * 1000;
        retireDistantVehicles(local);
        refreshUnclaimedTerrainPlacements();
        if (boatsEnabled && mooringShaderWarmup?.ready) ensureBoats(local);
        if (aircraftEnabled) {
            ensureAuthoredAircraft();
            ensureAircraft(local);
        }
    },
    endSession() {
        sessionGeneration += 1;
        mooringShaderStartup?.dispose();
        mooringShaderStartup = null;
        mooringShaderWarmup?.dispose();
        mooringShaderWarmup = null;
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        for (const vehicle of vehicles.values()) {
            removeRope(vehicle);
            clearAircraftCrash(vehicle);
            disposeGroup(vehicle.mesh);
        }
        vehicles.clear();
        if (specialVehiclesGroup?.parent) specialVehiclesGroup.parent.remove(specialVehiclesGroup);
        specialVehiclesGroup = null;
        terrainReference = null;
        anchorLat = 0;
        anchorLon = 0;
        boatSpawnAnchors = [];
        aircraftSpawnAnchors = [];
        enabled = false;
        boatsEnabled = false;
        aircraftEnabled = false;
        nextSpawnCheckMs = 0;
    },
};
