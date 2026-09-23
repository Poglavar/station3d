import { createVehicleExitPreview } from '../core/vehicle-exit-preview.js';
import * as THREE from 'three';

import { finiteOrNull, geoToLocal, localToGeo } from '../core/math.js';
import { setWorldBuildBlocker } from '../core/world-ready.js';
import { boatExitAllowedAt } from '../core/campaign-vehicle-policy.js';
import { createGroundMotionTracker, vehicleExitSpeedMps } from '../core/ground-motion.js';
import { worldProviderContains } from '../core/api.js';

// Used only when a vehicle record carries no height of its own.
const GTA_DEFAULT_VEHICLE_HEIGHT_M = 1.55;
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { createFixedStepAccumulator } from '../core/fixed-step.js';
import {
    beginExit,
    selectSafeExitCandidate,
    cancelOccupantTransition,
    completeBoarding,
    completeExit,
    createOccupantState,
    OCCUPANT_STATES,
    requestBoarding,
    forceOccupantOnFoot,
    placeWalkerAtVehicleExit,
} from '../core/occupant.js';
import {
    GTA_IMPACT,
    GTA_OBSTACLE_POLICY,
    GTA_PHYSICS,
    GTA_TRAFFIC_TUNING,
    GTA_VEHICLE_TUNING,
    driveCommandForKeys,
    gtaSceneYawToHeadingDeg,
    impactBandForForce,
    shouldApplyStoppedVehicleHold,
    shouldReleaseLatchedStopOnKeyDown,
    steeringInputForKeys,
    steeringLimitAtSpeed,
    vehicleDamageForImpact,
    repairedVehicleHealth,
} from '../core/gta-config.js';
import { GTA_COLLISION_GROUPS } from '../core/gta-collision-groups.js';
import { prepareFixedSurfacePublicationSteps } from '../core/fixed-surface-publication.js';
import { partitionRoadSurfaceMeshesSteps } from '../core/gta-road-surface-chunks.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM, FRAME_CHUNK_DEFER_ITEM } from '../core/frame-chunk-queue.js';
import { sampleTerrainColliderGrid, sampleTerrainColliderGridSteps, buildTerrainColliderMeshSteps } from '../core/terrain-collider-grid.js';
import { buildTerrainReceiverSupportSteps } from '../core/terrain-receiver-support.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { resolvePhysicsCameraLineOfSight } from '../core/gta-camera-occlusion.js';
import { buildCurbSurfaceTrimeshDataSteps } from '../core/gta-curb-surface.js';
import { buildRailTrackbedTrimeshData } from '../core/gta-rail-surface.js';
import {
    gtaRoadVehicleChassisShape,
    gtaRoadVehicleTuning,
} from '../core/gta-road-vehicle-profile.js';
import { trafficVehicleWheelbaseM } from '../core/traffic-vehicle-profile.js';
import { gtaTireEffectTargets } from '../core/gta-tire-effects.js';
import {
    applyAirplaneThrottleKeyDown,
    createGtaSpecialVehicleState,
    failAircraftEngine,
    gtaSpecialVehiclePose,
    resetGtaSpecialVehicleState,
    specialVehicleInputForKeys,
    stepGtaSpecialVehicle,
} from '../core/gta-special-vehicle.js';
import { beginWalkParachute } from './walk.js';
import {
    buildFormationTerrainCutoutQuerySteps,
} from '../core/formation-terrain-cutout-query.js';
import {
    recoverVehicleBodyFromSurfaces,
    shouldRecoverBlockedVehicleExit,
    shouldRecoverOverturnedVehicleExit,
    shouldProbeTrafficSurface,
    shouldRestoreVehicleCheckpoint,
    shouldUseVehicleFootprintProbes,
    vehicleUprightY,
    vehicleSurfaceProbePoints,
} from '../core/gta-surface-recovery.js';
import {
    buildRoadFormationDressingTrimeshData,
    buildRenderedRoadSurfaceTrimeshDataSteps,
    buildRoadSurfaceTrimeshData,
    roadFormationDressingSupportYAtPoint,
} from '../core/gta-road-surface.js';
import {
    buildingWallColliderSpecs,
    colliderBubbleNeedsRefresh,
    colliderCoverageContains,
    colliderBubbleTouchesChanges,
    fixedSurfaceRetryReady,
    colliderSpecOverlapsVehicle,
    collisionInvolvesHandle,
    entryPathCrossesColliderBoxes,
    entryPathCrossesFootprints,
    entryPathCrossesObstacles,
    isVehicleExitSupportHeightSafe,
    resolvePhysicsRebase,
    shouldDeferColliderBuild,
    vehicleExitCandidates,
} from '../core/gta-collider-bubble.js';
import {
    planTrafficPhysicsBubble,
    trafficGuidanceCommand,
} from '../core/gta-traffic-promotion.js';
import { scene } from '../scene/setup.js';
import * as cabVoice from '../ui/cab-voice.js';
import { getBuildingFootprintsNear } from '../world/buildings.js';
import {
    getCurbCollisionRevision,
    getCurbCollisionSurfacesNear,
} from '../world/curbs.js';
import {
    claimParkedCar,
    claimTrafficCarForPhysics,
    findEnterableParkedCar,
    findNearestTrafficRoadPose,
    getPromotedTrafficTarget,
    getTrafficObstaclesNear,
    releaseTrafficCarFromPhysics,
    releaseControlledParkedCar,
    syncPromotedTrafficCar,
    syncControlledParkedCar,
} from '../world/cars.js';
import { destroyDecorProp, getDecorObstaclesNear } from '../world/decor.js';
import {
    destroyStreetFurniture,
    getBreakableStreetFurnitureNear,
} from '../world/streetlamps.js';
import { getWalkColliderBoxesNear } from '../world/walk-collision.js';
import { GROUND_SURFACE_LEVELS } from '../world/ground-surface-levels.js';
import { getSampledRailTrackbedSegments } from '../world/rails.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { createGtaSkidMarks } from '../world/gta-skid-marks.js';
import { createGtaEngineAudio } from '../ui/gta-engine-audio.js';
import { createGtaSpecialVehicleAudio } from '../ui/gta-special-vehicle-audio.js';
import { createGtaTireAudio } from '../ui/gta-tire-audio.js';

// Ordinary car meshes are rooted at wheel contact level. With their configured
// wheel radius, suspension and connection, the body settles about 0.98 m above
// that root; heavy profiles compute a taller collision shell and centre.
const CHASSIS_VISUAL_CENTER_Y_M = 0.98;
const WHEEL_RADIUS_M = 0.34;
const PHYSICS_REBASE_M = 2000;
const TERRAIN_COLLIDER_SIZE_M = GTA_PHYSICS.colliderRetireRadiusM * 2.05;
const GTA_CAMERA_HEIGHT_M = 4.2;
const GTA_CAMERA_BACK_M = 9.5;
const GTA_CAMERA_LOOK_AHEAD_M = 7;
const GTA_CAMERA_MODES = Object.freeze(['chase', 'close', 'overhead']);
const GTA_CAMERA_OCCLUDER_KINDS = new Set([
    'terrain',
    'road-surface',
    'formation-dressing',
    'authored-surface',
    'rail-trackbed',
    'rail-formation-dressing',
    'building',
    'civil',
]);
const ENTRY_PROBE_INTERVAL_MS = 250;
const GTA_VEHICLE_PROVIDER_ID = 'gta-vehicles';
const GROUND_COLLIDER_KEYS = new Set([
    'terrain', 'road-surfaces', 'formation-dressings',
    'rail-trackbed', 'rail-formation-dressings', 'curb-surfaces', 'authored-surfaces',
]);

function rapierModuleLoader() {
    return import('@dimforge/rapier3d-compat').then(module => module.default || module);
}

function yawQuaternion(yaw) {
    const half = yaw * 0.5;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function yawFromQuaternion(rotation) {
    if (!rotation) return 0;
    return Math.atan2(
        2 * (rotation.w * rotation.y + rotation.x * rotation.z),
        1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
    );
}

function rotateVectorByQuaternion(vector, quaternion) {
    const qx = quaternion.x;
    const qy = quaternion.y;
    const qz = quaternion.z;
    const qw = quaternion.w;
    const tx = 2 * (qy * vector.z - qz * vector.y);
    const ty = 2 * (qz * vector.x - qx * vector.z);
    const tz = 2 * (qx * vector.y - qy * vector.x);
    return {
        x: vector.x + qw * tx + (qy * tz - qz * ty),
        y: vector.y + qw * ty + (qz * tx - qx * tz),
        z: vector.z + qw * tz + (qx * ty - qy * tx),
    };
}

function setIf(controller, method, ...args) {
    if (typeof controller?.[method] === 'function') controller[method](...args);
}

function monotonicNowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createGtaSession({
    anchorLat,
    anchorLon,
    terrain: terrainGetter = () => null,
    roadFormation: roadFormationGetter = () => null,
    roadVerticalAlignments: roadVerticalAlignmentsGetter = () => null,
    renderedRoadSurfacePartsNear = null,
    renderedRoadSurfaceRevision = null,
    authoredSurfaceRead: authoredSurfaceGetter = () => EMPTY_RECEIVER_SUPPORT_READ,
    surfacePublications,
    groundPublications,
    buildingFootprintsNear = getBuildingFootprintsNear,
    buildingColliderSpecsNear = null,
    groundYAt = () => 0,
    physicsGroundYAt = null,
    specialVehicles = null,
    enabledControllerKinds = ['road', 'boat', 'aircraft'],
    enterableRoadVehicleIds = null,
    // `{ x, z, radiusM }` in scene metres, or null: the only place this scene
    // lets a boat be left (core/campaign-vehicle-policy.js).
    boatExitBerth = null,
    occupant: sharedOccupant = null,
    toast = () => {},
    onAutomaticExit = () => {},
    rapierLoader = rapierModuleLoader,
} = {}) {
    cabVoice.preloadCabVoice?.();
    const authoredSurfaceReference = () => authoredSurfaceGetter() ?? EMPTY_RECEIVER_SUPPORT_READ;
    const enabledControllers = new Set(
        (Array.isArray(enabledControllerKinds) ? enabledControllerKinds : [])
            .filter(kind => ['road', 'boat', 'aircraft'].includes(kind)),
    );
    let allowedRoadVehicleIds = Array.isArray(enterableRoadVehicleIds)
        && enterableRoadVehicleIds.length > 0
        ? new Set(enterableRoadVehicleIds.map(id => String(id)))
        : null;
    const controllerKindForVehicle = kind => (
        kind === 'airplane' ? 'aircraft' : kind === 'boat' ? 'boat' : 'road'
    );
    const vehicleKindEnabled = kind => enabledControllers.has(controllerKindForVehicle(kind));
    const occupant = sharedOccupant || createOccupantState();
    const buildingFootprintsProvider = typeof buildingFootprintsNear === 'function'
        ? buildingFootprintsNear
        : getBuildingFootprintsNear;
    const fixedStep = createFixedStepAccumulator({
        stepSeconds: 1 / GTA_PHYSICS.stepHz,
        maxSubsteps: GTA_PHYSICS.maxSubsteps,
    });
    const controls = new Set();
    const fixedBodies = new Map();
    const trafficBodies = new Map();
    const colliderMetadata = new Map();
    const lastImpactById = new Map();
    const debris = [];
    const debrisGroup = new THREE.Group();
    debrisGroup.name = 'GtaBreakableDebris';
    scene.add(debrisGroup);
    const debrisPools = new Map([
        ['spark', []],
        ['bench', []],
        ['metal', []],
    ]);
    const debrisResources = {
        sparkGeometry: new THREE.BoxGeometry(1, 1, 1),
        propGeometry: new THREE.BoxGeometry(1, 1, 1),
        sparkMaterial: new THREE.MeshBasicMaterial({ color: 0xffbd55 }),
        benchMaterial: new THREE.MeshStandardMaterial({
            color: 0x76502f,
            roughness: 0.85,
        }),
        metalMaterial: new THREE.MeshStandardMaterial({
            color: 0x43484d,
            roughness: 0.85,
        }),
    };

    let RAPIER = null;
    let world = null;
    let eventQueue = null;
    let vehicleController = null;
    let controlled = null;
    let specialVehicleState = null;
    let chassisBody = null;
    let chassisCollider = null;
    let colliderCenter = null;
    let fixedColliderResourceCount = 0;
    let pendingFixedSurfaces = null;
    let groundPublicationLease = null;
    let fixedBuildQueue = [];
    let fixedRetireQueue = [];
    let fixedRetireIds = new Set();
    let colliderContentRefreshElapsed = 0;
    let failedSurfaceRequest = null;
    let pendingBubbleBuild = null, bubbleGeneration = 0, supportPublicationGeneration = 0;
    const bubbleQueue = createFrameChunkQueue({ label: 'gta:ground', frameBudgetMs: 2,
        pauseDuringMovement: false, preferAnimationFrame: true, workClass: 'near', trackWorldReady: true });
    let lastTerrainRevision = -1;
    let lastTerrainReference = null;
    let lastRoadFormationRevision = -1;
    let lastRoadFormationReference = null;
    let lastRoadVerticalAlignmentRevision = -1;
    let lastRoadVerticalAlignmentReference = null;
    let lastRenderedRoadSurfaceRevision = -1;
    let lastRailFormationRevision = -1;
    let lastRailFormationReference = null;
    let lastRailTrackbedRevision = -1;
    let lastCurbCollisionRevision = -1;
    let lastAuthoredSurfaceRevision = -1;
    let lastAuthoredSurfaceRevisionReference = null;
    let authoredSurfaceStats = { triangleCount: 0, truncated: false };
    let roadSurfaceStats = {
        profileCount: 0,
        triangleCount: 0,
        colliderCount: 0,
        structuralColliderCount: 0,
        truncated: false,
    };
    let formationDressingStats = {
        profileCount: 0,
        triangleCount: 0,
        truncated: false,
    };
    let railTrackbedStats = {
        revision: -1,
        segmentCount: 0,
        junctionCount: 0,
        triangleCount: 0,
        truncated: false,
    };
    let railFormationDressingStats = {
        profileCount: 0,
        triangleCount: 0,
        truncated: false,
    };
    let curbSurfaceStats = { triangleCount: 0, truncated: false };
    let physicsOrigin = { x: 0, z: 0 };
    let disposed = false;
    let ready = false;
    let initializationError = null;
    let steering = 0;
    let stopRequested = false;
    let pendingExitWalkState = null;
    let lastPose = null;
    // Ground truth for "is this vehicle moving?", kept separately from the
    // chassis/engine speed because a wedged vehicle reports the two very
    // differently. See core/ground-motion.js.
    const groundMotion = createGroundMotionTracker();
    let audioContext = null;
    let droppedPhysicsSeconds = 0;
    let bubbleRevision = 0;
    let lastBoundaryToastMs = -Infinity;
    let cameraModeIndex = 0;
    let cameraOcclusionCount = 0;
    let lastCameraOcclusion = null;
    let entryProbe = null;
    const exitPreview = createVehicleExitPreview();
    let entrySafetyZone = null;
    let vehicleHealth = 100;
    // Seconds since the last damaging impact, for the self-repair grace.
    let secondsSinceVehicleDamage = Infinity;
    let lastPlayerImpact = null;
    let playerImpactHistory = [];
    let impactShake = 0;
    let lastImpactSoundAt = -Infinity;
    let contactEventCount = 0;
    let impactEventCount = 0;
    let physicsStepCount = 0;
    let lastPhysicsStepMs = 0;
    let maxPhysicsStepMs = 0;
    let fixedCapacityHits = 0;
    let trafficCapacityHits = 0;
    let debrisCapacityHits = 0;
    let lastBubblePlanMs = 0;
    let maxBubblePlanMs = 0;
    let lastBubblePlanBreakdown = {};
    let maxBubblePlanBreakdown = {};
    let lastBubbleDrainMs = 0;
    let maxBubbleDrainMs = 0;
    let surfaceRecoveryCount = 0;
    let surfaceRecoveryLiftM = 0;
    let lastSurfaceRecovery = null;
    let trafficSurfaceRecoveryCount = 0;
    let trafficSurfaceRecoveryLiftM = 0;
    let lastTrafficSurfaceRecovery = null;
    let supportedCheckpoint = null;
    let escapeRecoveryCount = 0;
    let lastEscapeRecovery = null;
    let lastTireTargets = gtaTireEffectTargets();
    const engineAudio = createGtaEngineAudio({ ensureContext: ensureGtaAudioContext });
    const specialVehicleAudio = createGtaSpecialVehicleAudio({ ensureContext: ensureGtaAudioContext });
    // Automation reads the flown or sailed engine's level, pitch and film mix.
    if (typeof window !== 'undefined') window.__s3dVehicleAudio = () => specialVehicleAudio.debugState();
    const tireAudio = createGtaTireAudio({ ensureContext: ensureGtaAudioContext });
    const skidMarks = createGtaSkidMarks({
        parent: scene,
        maxSegments: GTA_PHYSICS.maxSkidMarkSegments,
    });

    function isGtaControlling() {
        return occupant.state === OCCUPANT_STATES.CONTROLLING && !!controlled;
    }

    function ensureGtaAudioContext() {
        if (!audioContext) audioContext = createUnlockedAudioContext();
        if (!audioContext || !resumeUnlockedAudioContext(audioContext)) return null;
        return audioContext;
    }

    function acquireDebrisMesh(kind) {
        const key = kind === 'spark' ? 'spark' : kind === 'bench' ? 'bench' : 'metal';
        const pool = debrisPools.get(key);
        const material = key === 'spark'
            ? debrisResources.sparkMaterial
            : key === 'bench'
                ? debrisResources.benchMaterial
                : debrisResources.metalMaterial;
        const mesh = pool.pop() || new THREE.Mesh(
            key === 'spark' ? debrisResources.sparkGeometry : debrisResources.propGeometry,
            material,
        );
        mesh.visible = true;
        mesh.rotation.set(0, 0, 0);
        mesh.scale.set(1, 1, 1);
        return { mesh, poolKey: key };
    }

    function releaseDebrisItem(item) {
        if (!item?.mesh) return;
        if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
        item.mesh.visible = false;
        const pool = debrisPools.get(item.poolKey);
        if (pool && pool.length < GTA_PHYSICS.maxDebris) pool.push(item.mesh);
    }

    function disposeDebrisResources() {
        debrisResources.sparkGeometry.dispose();
        debrisResources.propGeometry.dispose();
        debrisResources.sparkMaterial.dispose();
        debrisResources.benchMaterial.dispose();
        debrisResources.metalMaterial.dispose();
        for (const pool of debrisPools.values()) pool.length = 0;
    }

    const initializePromise = Promise.resolve()
        .then(() => rapierLoader())
        .then(async module => {
            RAPIER = module;
            if (typeof RAPIER.init === 'function') await RAPIER.init();
            if (disposed) return;
            world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
            world.timestep = 1 / GTA_PHYSICS.stepHz;
            eventQueue = new RAPIER.EventQueue(true);
            ready = true;
        })
        .catch(error => {
            initializationError = error;
            console.error('[gta] Rapier initialization failed', error);
            toast('gta.physicsFailed');
        });

    function terrainReference() {
        return typeof terrainGetter === 'function' ? terrainGetter() : terrainGetter;
    }

    function roadFormationReference() {
        return typeof roadFormationGetter === 'function'
            ? roadFormationGetter() : roadFormationGetter;
    }

    function roadVerticalAlignmentReference() {
        return typeof roadVerticalAlignmentsGetter === 'function'
            ? roadVerticalAlignmentsGetter() : roadVerticalAlignmentsGetter;
    }

    function supportY(x, z, hintY = 0) {
        const sampled = finiteOrNull(groundYAt(x, z, hintY));
        if (sampled !== null) return sampled;
        return finiteOrNull(terrainReference()?.evidenceSceneYAtLocal?.(x, z));
    }

    // Bulk collider construction must never call the walking support query:
    // that path raycasts every authored surface and is appropriate for one
    // person's feet, not a 33×33 terrain grid plus thousands of wall ends.
    // The caller supplies an analytic road/terrain sampler; raw DGU terrain is
    // the safe fallback, and the full support query is used only when neither
    // lightweight authority exists.
    function physicsSupportY(x, z, hintY = 0) {
        const sampled = finiteOrNull(typeof physicsGroundYAt === 'function'
            ? physicsGroundYAt(x, z, hintY)
            : null);
        if (sampled !== null) return sampled;
        return supportY(x, z, hintY);
    }

    function toPhysics(x, z) {
        return { x: x - physicsOrigin.x, z: z - physicsOrigin.z };
    }

    function removeRigidBody(body) {
        if (!world || !body) return;
        try { world.removeRigidBody(body); } catch (_error) { /* already removed */ }
    }

    function trafficBodyPose(entry) {
        if (!entry?.body) return null;
        const translation = entry.body.translation();
        const rotation = entry.body.rotation();
        const velocity = entry.body.linvel();
        const heading = yawFromQuaternion(rotation);
        const forwardX = Math.sin(heading);
        const forwardZ = Math.cos(heading);
        const rootOffset = rotateVectorByQuaternion(
            { x: 0, y: -entry.halfY, z: 0 },
            rotation,
        );
        return {
            x: translation.x + physicsOrigin.x,
            y: translation.y - entry.halfY,
            z: translation.z + physicsOrigin.z,
            heading,
            speedMps: Math.max(0, velocity.x * forwardX + velocity.z * forwardZ),
            quaternion: rotation,
            meshX: translation.x + physicsOrigin.x + rootOffset.x,
            meshY: translation.y + rootOffset.y,
            meshZ: translation.z + physicsOrigin.z + rootOffset.z,
        };
    }

    function removeTrafficEntry(entry, { release = true } = {}) {
        if (!entry) return;
        if (release && entry.mode === 'dynamic' && entry.claimed) {
            releaseTrafficCarFromPhysics(entry.obstacle.id, trafficBodyPose(entry) || {});
            entry.claimed = false;
        }
        if (entry.collider) colliderMetadata.delete(entry.collider.handle);
        removeRigidBody(entry.body);
    }

    function entryColliders(entry) {
        if (Array.isArray(entry?.colliders)) return entry.colliders.filter(Boolean);
        return entry?.collider ? [entry.collider] : [];
    }

    function clearFixedBodies() {
        groundPublicationLease?.release();
        bubbleGeneration++;
        if (pendingBubbleBuild) bubbleQueue.cancel(pendingBubbleBuild.job);
        pendingBubbleBuild = null;
        pendingFixedSurfaces?.rollback();
        pendingFixedSurfaces?.discard();
        for (const entry of fixedBodies.values()) {
            for (const collider of entryColliders(entry)) {
                colliderMetadata.delete(collider.handle);
            }
            const { body } = entry;
            removeRigidBody(body);
        }
        fixedBodies.clear();
        fixedColliderResourceCount = 0;
        fixedBuildQueue = [];
        fixedRetireQueue = [];
        fixedRetireIds = new Set();
        colliderCenter = null;
        lastTerrainReference = null;
        lastTerrainRevision = -1;
        lastRoadFormationReference = null;
        lastRoadFormationRevision = -1;
        lastRoadVerticalAlignmentReference = null;
        lastRoadVerticalAlignmentRevision = -1;
        lastRenderedRoadSurfaceRevision = -1;
        lastRailFormationReference = null;
        lastRailFormationRevision = -1;
        lastRailTrackbedRevision = -1;
        lastCurbCollisionRevision = -1;
        lastAuthoredSurfaceRevision = -1;
        lastAuthoredSurfaceRevisionReference = null;
        authoredSurfaceStats = { triangleCount: 0, truncated: false };
        failedSurfaceRequest = null;
        roadSurfaceStats = {
            profileCount: 0,
            triangleCount: 0,
            colliderCount: 0,
            structuralColliderCount: 0,
            truncated: false,
        };
        formationDressingStats = {
            profileCount: 0,
            triangleCount: 0,
            truncated: false,
        };
        railTrackbedStats = {
            revision: -1,
            segmentCount: 0,
            junctionCount: 0,
            triangleCount: 0,
            truncated: false,
        };
        railFormationDressingStats = {
            profileCount: 0,
            triangleCount: 0,
            truncated: false,
        };
        curbSurfaceStats = { triangleCount: 0, truncated: false };
    }

    function removeFixedBody(id) {
        const entry = fixedBodies.get(id);
        if (!entry) return false;
        const colliders = entryColliders(entry);
        for (const collider of colliders) colliderMetadata.delete(collider.handle);
        fixedColliderResourceCount = Math.max(0, fixedColliderResourceCount - colliders.length);
        removeRigidBody(entry.body);
        fixedBodies.delete(id);
        return true;
    }

    function createFixedCuboid(spec) {
        if (!world) return null;
        if (fixedColliderResourceCount >= GTA_PHYSICS.maxFixedColliders) {
            fixedCapacityHits += 1;
            return null;
        }
        const point = toPhysics(spec.x, spec.z);
        let bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(point.x, spec.y, point.z);
        if (spec.yaw) bodyDesc = bodyDesc.setRotation(yawQuaternion(spec.yaw));
        const body = world.createRigidBody(bodyDesc);
        let colliderDesc = RAPIER.ColliderDesc.cuboid(spec.halfX, spec.halfY, spec.halfZ)
            .setFriction(0.8)
            .setRestitution(spec.destructive ? 0.08 : 0.02)
            .setCollisionGroups(GTA_COLLISION_GROUPS.obstacle);
        if (spec.kind !== 'terrain' && RAPIER.ActiveEvents) {
            colliderDesc = colliderDesc
                .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
                .setContactForceEventThreshold(
                    spec.destructive
                        ? Math.min(spec.forceThresholdN, GTA_IMPACT.lowForceN)
                        : GTA_IMPACT.lowForceN,
                );
        }
        const collider = world.createCollider(colliderDesc, body);
        fixedBodies.set(spec.id, { body, collider, spec });
        fixedColliderResourceCount += 1;
        colliderMetadata.set(collider.handle, spec);
        return collider;
    }

    function buildTerrainCollider(centerX, centerZ, referenceY, candidate = null) {
        // Vehicle entry needs support before allocating its chassis. Drain the
        // same compiler; moving refreshes use its cooperative steps below.
        const steps = buildTerrainColliderSteps(centerX, centerZ, referenceY, candidate);
        let next;
        do { next = steps.next(); } while (!next.done);
        return next.value;
    }

    function* buildTerrainColliderSteps(centerX, centerZ, referenceY, candidate = null) {
        const terrain = candidate?.terrainSource ?? terrainReference();
        const revision = Number(candidate?.terrain?.revision ?? terrain?.revision) || 0;
        const pendingDetailWindow = terrain?.pendingDetailWindow;
        const originX = physicsOrigin.x, originZ = physicsOrigin.z;
        const modelSources = () => [terrain?.roadFormation, terrain?.railFormation,
            terrain?.renderedRailSurface, roadFormationReference()];
        const models = candidate ? [] : modelSources();
        const versionKeys = ['revision', 'surfaceGeometryRevision', 'surfacePublicationRevision', 'civilGroundMutationRevision'];
        const versions = models.map(model => versionKeys.map(key => Number(model?.[key]) || 0));
        const current = () => physicsOrigin.x === originX && physicsOrigin.z === originZ && (candidate
            ? candidate.isCurrent()
            : terrainReference() === terrain && (Number(terrain?.revision) || 0) === revision
                && terrain?.pendingDetailWindow === pendingDetailWindow
                && modelSources().every((model, index) => model === models[index]
                    && versionKeys.every((key, k) => (Number(model?.[key]) || 0) === versions[index][k])));
        if (candidate && (!candidate.terrain || !Object.isFrozen(candidate.terrain)
            || typeof candidate.terrain.evidenceSceneYAtLocal !== 'function'
            || (typeof candidate.terrain.receiverTilesForBounds !== 'function' && typeof candidate.cutoutQuery?.contains !== 'function')
            || typeof candidate.isCurrent !== 'function')) {
            throw new TypeError('Candidate terrain support requires captured receivers or an explicit lattice cut query, and validity');
        }
        const read = candidate ? retainReadSnapshot(candidate.terrain, 'gta-terrain-collider')
            : terrain ? captureGroundReadSnapshot(terrain, 'gta-terrain-collider') : null;
        // Closing this wrapper also closes a nested query capture. Neither a
        // cancelled queue job nor a rejected revision may retain a tile read.
        function* prepare(steps) {
            try {
                while (current()) {
                    const next = steps.next();
                    if (next.done) return next.value;
                    yield next.value;
                }
                return null;
            } finally { steps.return(); }
        }
        try {
            if (!current()) return false;
            const size = TERRAIN_COLLIDER_SIZE_M;
            // Use the rendered terrain's globally aligned lattice. The previous
            // private 32x32 grid sampled raw DTM values at arbitrary ~10 m points,
            // so Rapier drove and walked on a different surface from the visible
            // 4 m/20 m piecewise-planar mesh. The subdivision must divide EVERY
            // covered tile's spacing: taking min(8, 20), for example, is not enough.
            const sampleBounds = { minX: centerX - size * 0.5, maxX: centerX + size * 0.5,
                minZ: centerZ - size * 0.5, maxZ: centerZ + size * 0.5 };
            if (typeof read?.receiverTilesForBounds === 'function') {
                if (typeof read.sourceEvidenceSceneYAtLocal !== 'function') {
                    throw new TypeError('Published terrain support requires its captured source evidence');
                }
                const tiles = read.receiverTilesForBounds(sampleBounds);
                if (!tiles) return false;
                const support = yield* prepare(buildTerrainReceiverSupportSteps({
                    tiles, bounds: sampleBounds, originX, originZ,
                    evidenceSceneYAtLocal: read.sourceEvidenceSceneYAtLocal, now: monotonicNowMs, isCurrent: current,
                    limits: { maxTiles: 4, maxSourceCells: GTA_PHYSICS.maxTerrainColliderVertices,
                        maxTriangles: GTA_PHYSICS.maxTerrainSupportTriangles,
                        maxTrianglesPerMesh: GTA_PHYSICS.maxTerrainColliderTriangles,
                        maxMeshes: Math.ceil(GTA_PHYSICS.maxTerrainSupportTriangles / GTA_PHYSICS.maxTerrainColliderTriangles) },
                }));
                if (!support || !current()) return false;
                return {
                    key: 'terrain',
                    spec: { id: 'terrain', kind: 'terrain', coverage: { centerX, centerZ, radiusM: size * .5 } },
                    isCurrent: current,
                    meshes: support.meshes.map(mesh => ({ ...mesh, friction: 1.15, collisionGroups: GTA_COLLISION_GROUPS.support })),
                    onPublished: () => {
                        colliderCenter = { x: centerX, z: centerZ };
                        lastTerrainReference = terrain; lastTerrainRevision = revision;
                    },
                };
            }
            const step = read ? read.sampleStepMForBounds(sampleBounds) : size / 32;
            if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return false;
            const startX = Math.floor(sampleBounds.minX / step) * step;
            const startZ = Math.floor(sampleBounds.minZ / step) * step;
            const endX = Math.ceil(sampleBounds.maxX / step) * step;
            const endZ = Math.ceil(sampleBounds.maxZ / step) * step;
            const columns = Math.max(1, Math.round((endX - startX) / step));
            const rows = Math.max(1, Math.round((endZ - startZ) / step));
            const vertexCount = (columns + 1) * (rows + 1);
            if (!Number.isSafeInteger(vertexCount) || vertexCount > GTA_PHYSICS.maxTerrainColliderVertices) return false;
            // Preflight the complete collider lattice before allocating or replacing
            // any Rapier geometry. A visual fallback terrain exists solely to keep
            // the framebuffer opaque; it is never valid physics evidence.
            const sampling = { columns, rows, startX, startZ, step, now: monotonicNowMs, isCurrent: current,
                bounded: read?.bounded === true,
                sample: (x, z) => read ? read.evidenceSceneYAtLocal(x, z) : physicsSupportY(x, z, referenceY) };
            // The explicit flat-mode callback has no snapshot API yet. Capture
            // its fixed 33x33 heights in one turn instead of sampling mutable
            // callbacks across yields. Terrain-enabled sessions use the read above.
            const heights = read ? yield* prepare(sampleTerrainColliderGridSteps(sampling))
                : sampleTerrainColliderGrid(sampling);
            if (!heights) return false;
            const cutoutQuery = candidate?.cutoutQuery || (yield* prepare(buildFormationTerrainCutoutQuerySteps({
                models: Array.from(new Set(models.filter(Boolean))), centerX, centerZ,
                radiusM: size * Math.SQRT2 * 0.5 + step,
                // Road formation preparation is already frame-budgeted by the
                // roads layer. A physics refresh may consume its last complete
                // generation but must never drain the replacement synchronously.
                allowStale: true, now: monotonicNowMs,
                terrainSceneYAtLocal: (x, z) => read?.evidenceSceneYAtLocal(x, z),
            })));
            if (!cutoutQuery) return false;
            const mesh = yield* prepare(buildTerrainColliderMeshSteps({ columns, rows, startX, startZ, step, heights,
                cutoutQuery, originX, originZ, now: monotonicNowMs, isCurrent: current }));
            if (!mesh || !current()) return false;
            return {
                key: 'terrain',
                spec: { id: 'terrain', kind: 'terrain', coverage: { centerX, centerZ, radiusM: size * 0.5 } },
                isCurrent: current,
                meshes: [{ ...mesh, friction: 1.15, collisionGroups: GTA_COLLISION_GROUPS.support }],
                onPublished: () => {
                    colliderCenter = { x: centerX, z: centerZ };
                    lastTerrainReference = terrain;
                    lastTerrainRevision = revision;
                },
            };
        } finally { read?.release?.(); }
    }

    function* buildRoadSurfaceColliderSteps(centerX, centerZ, candidate = null) {
        const formation = candidate?.ground ? candidate.ground.roadFormation : roadFormationReference();
        const verticalAlignments = candidate?.ground ? candidate.ground.verticalAlignments : roadVerticalAlignmentReference();
        const formationRevision = Number(candidate?.ground
            ? candidate.formationSourceRevision ?? formation?.surfaceGeometrySourceRevision ?? formation?.revision
            : formation?.revision) || 0;
        const alignmentRevision = Number(verticalAlignments?.revision) || 0;
        const nextRenderedRevision = candidate ? 0 : Number(
            typeof renderedRoadSurfaceRevision === 'function'
                ? renderedRoadSurfaceRevision(centerX, centerZ, GTA_PHYSICS.roadSurfaceColliderRadiusM) : 0,
        ) || 0;
        const onPublished = stats => {
            // A pending formation revision is not yet a published source.
            if (formation?.hasPendingBuild?.() !== true) {
                lastRoadFormationReference = candidate?.formationSource ?? formation ?? null;
                lastRoadFormationRevision = formationRevision;
            }
            lastRoadVerticalAlignmentReference = candidate?.alignmentSource ?? verticalAlignments ?? null;
            lastRoadVerticalAlignmentRevision = alignmentRevision;
            // A staged read becomes the live index in the same ground batch.
            // Acknowledge it after that swap, before the next physics step.
            lastRenderedRoadSurfaceRevision = candidate
                ? Number(renderedRoadSurfaceRevision?.(centerX, centerZ,
                    GTA_PHYSICS.roadSurfaceColliderRadiusM)) || 0
                : nextRenderedRevision;
            roadSurfaceStats = stats;
        };
        const partsNear = candidate?.partsNear || renderedRoadSurfacePartsNear;
        const renderedParts = typeof partsNear === 'function'
            ? partsNear(
                centerX,
                centerZ,
                GTA_PHYSICS.roadSurfaceColliderRadiusM,
                { drivableOnly: true },
            )
            : [];
        let data = yield* buildRenderedRoadSurfaceTrimeshDataSteps({
            parts: renderedParts,
            centerX,
            centerZ,
            radiusM: GTA_PHYSICS.roadSurfaceColliderRadiusM,
            toPhysics: (x, z) => toPhysics(x, z),
            maxParts: GTA_PHYSICS.maxRoadSurfaceProfiles,
            maxTriangles: GTA_PHYSICS.maxRoadSurfaceTriangles,
            includeMerged: false,
        });
        let source = 'rendered';
        // An authoritative empty rendered publication is a removal. It must
        // never recreate the retired surface from an analytic profile.
        // Integrations without a rendered provider use engineered profiles.
        if (typeof partsNear !== 'function' && typeof formation?.sceneYAtLocal === 'function') {
            const profiles = typeof formation.surfaceProfilesNear === 'function'
                ? formation.surfaceProfilesNear(
                    centerX,
                    centerZ,
                    GTA_PHYSICS.roadSurfaceColliderRadiusM,
                    { allowStale: true },
                )
                : formation.getSurfaceProfiles?.() || [];
            data = buildRoadSurfaceTrimeshData({
                profiles,
                centerX,
                centerZ,
                radiusM: GTA_PHYSICS.roadSurfaceColliderRadiusM,
                heightAt: (x, z, profile) => formation.sceneYAtLocal(
                    x,
                    z,
                    { osmId: profile.osmId, allowStale: true },
                ),
                toPhysics: (x, z) => toPhysics(x, z),
                maxProfiles: GTA_PHYSICS.maxRoadSurfaceProfiles,
                maxTriangles: GTA_PHYSICS.maxRoadSurfaceTriangles,
                maxEdgeM: GTA_PHYSICS.roadSurfaceMaxEdgeM,
                surfaceOffsetM: GTA_PHYSICS.roadSurfaceOffsetM,
            });
            source = 'formation-fallback';
        }
        if (data.truncated) {
            const error = new Error('Road collider exceeds its complete coverage budget');
            error.code = 'surface-collider-coverage-capacity';
            throw error;
        }
        const ordinarySurfaces = [];
        const structuralSurfaces = new Map();
        for (const surface of data.surfaces) {
            const alignment = verticalAlignments?.getAlignmentForOsmId?.(surface.osmId);
            if (!alignment) {
                ordinarySurfaces.push(surface);
                continue;
            }
            const key = String(alignment.id || surface.osmId);
            let group = structuralSurfaces.get(key);
            if (!group) {
                group = {
                    alignmentId: key,
                    kind: alignment.kind || 'aligned',
                    osmIds: new Set(),
                    surfaces: [],
                };
                structuralSurfaces.set(key, group);
            }
            if (surface.osmId != null) group.osmIds.add(surface.osmId);
            group.surfaces.push(surface);
        }
        const colliderMeshes = [];
        const partition = surfaces => partitionRoadSurfaceMeshesSteps(surfaces, {
            maxTrianglesPerMesh: GTA_PHYSICS.maxRoadColliderTriangles,
            maxTriangles: GTA_PHYSICS.maxRoadSurfaceTriangles,
            maxMeshes: GTA_PHYSICS.maxRoadSurfaceProfiles,
        });
        const ordinaryMeshes = yield* partition(ordinarySurfaces);
        for (const [index, mesh] of ordinaryMeshes.entries()) colliderMeshes.push({
            mesh, spec: { id: `road-surfaces:ground:${index}`, kind: 'road-surface',
                stackKind: 'ground', osmIds: [] },
        });
        for (const group of structuralSurfaces.values()) {
            const meshes = yield* partition(group.surfaces);
            for (const [index, mesh] of meshes.entries()) colliderMeshes.push({
                mesh, spec: { id: `road-surfaces:${group.alignmentId}:${index}`, kind: 'road-surface',
                    stackKind: group.kind, alignmentId: group.alignmentId, osmIds: [...group.osmIds],
                    minY: mesh.minY, maxY: mesh.maxY },
            });
        }
        if (colliderMeshes.length > GTA_PHYSICS.maxRoadSurfaceProfiles) {
            const error = new Error('Road collider exceeds its complete coverage mesh budget');
            error.code = 'surface-collider-coverage-capacity';
            throw error;
        }
        return {
            key: 'road-surfaces',
            spec: { id: 'road-surfaces', kind: 'road-surface-set', centerX, centerZ,
                coverage: { centerX, centerZ, radiusM: GTA_PHYSICS.roadSurfaceColliderRadiusM } },
            isCurrent: () => candidate?.ground ? candidate.isCurrent() : roadFormationReference() === formation
                && (Number(formation?.revision) || 0) === formationRevision
                && roadVerticalAlignmentReference() === verticalAlignments
                && (Number(verticalAlignments?.revision) || 0) === alignmentRevision
                && (candidate ? candidate.isCurrent()
                    : (Number(renderedRoadSurfaceRevision?.(centerX, centerZ,
                        GTA_PHYSICS.roadSurfaceColliderRadiusM)) || 0) === nextRenderedRevision),
            meshes: colliderMeshes.map(({ mesh, spec }) => ({
                vertices: mesh.vertices, indices: mesh.indices, spec, friction: 1.3,
                collisionGroups: GTA_COLLISION_GROUPS.support,
            })),
            onPublished: () => onPublished({
                profileCount: data.profileCount,
                triangleCount: data.triangleCount,
                colliderCount: colliderMeshes.length,
                structuralColliderCount: colliderMeshes.length - ordinaryMeshes.length,
                truncated: data.truncated,
                source,
            }),
        };
    }

    function buildRoadSurfaceCollider(centerX, centerZ) {
        const steps = buildRoadSurfaceColliderSteps(centerX, centerZ);
        let next;
        do { next = steps.next(); } while (!next.done);
        return next.value;
    }

    function surfaceColliderReplacement(key, kind, data, friction, onPublished, isCurrent, coverage) {
        if (data.truncated) {
            const needed = Number.isFinite(data.requiredTriangles) ? ` (${data.requiredTriangles} triangles)` : '';
            const error = new Error(`${key} collider exceeds its complete coverage budget${needed}`);
            error.code = 'surface-collider-coverage-capacity';
            error.details = { code: error.code, key, coverage,
                requiredTriangles: data.requiredTriangles ?? null, storedTriangles: data.triangleCount,
                candidateProfiles: data.candidateProfiles ?? null };
            throw error;
        }
        return {
            key, spec: { id: key, kind, coverage }, isCurrent,
            meshes: data.triangleCount ? [{
                vertices: data.vertices, indices: data.indices, friction,
                collisionGroups: GTA_COLLISION_GROUPS.support,
            }] : [],
            onPublished,
        };
    }

    function buildFormationDressingCollider(centerX, centerZ, candidate = null) {
        const formation = candidate ? candidate.formation : roadFormationReference();
        const revision = Number(formation?.revision) || 0;
        const profiles = typeof formation?.dressingProfilesNear === 'function'
            ? formation.dressingProfilesNear(
                centerX, centerZ, GTA_PHYSICS.formationDressingColliderRadiusM, { allowStale: true },
            ) : formation?.getSurfaceProfiles?.() || [];
        const data = buildRoadFormationDressingTrimeshData({
            profiles, centerX, centerZ,
            radiusM: GTA_PHYSICS.formationDressingColliderRadiusM,
            toPhysics: (x, z) => toPhysics(x, z),
            maxTriangles: GTA_PHYSICS.maxFormationDressingTriangles,
            surfaceOffsetM: GTA_PHYSICS.roadSurfaceOffsetM,
        });
        return surfaceColliderReplacement('formation-dressings', 'formation-dressing', data, 1.15, () => {
            formationDressingStats = {
                profileCount: data.profileCount, triangleCount: data.triangleCount, truncated: data.truncated,
            };
        }, () => candidate ? candidate.isCurrent()
            : roadFormationReference() === formation && (Number(formation?.revision) || 0) === revision,
        { centerX, centerZ, radiusM: GTA_PHYSICS.formationDressingColliderRadiusM });
    }

    function buildRailTrackbedCollider(centerX, centerZ, candidate = null) {
        const snapshot = candidate ? candidate.snapshot : getSampledRailTrackbedSegments();
        const revision = Number(snapshot?.revision) || 0;
        const data = buildRailTrackbedTrimeshData({
            segments: snapshot?.segments, centerX, centerZ,
            radiusM: GTA_PHYSICS.railTrackbedColliderRadiusM,
            surfaceOffsetM: GROUND_SURFACE_LEVELS.tramBed,
            toPhysics: (x, z) => toPhysics(x, z),
            maxTriangles: GTA_PHYSICS.maxRailTrackbedTriangles,
        });
        return surfaceColliderReplacement('rail-trackbed', 'rail-trackbed', data, 1.3, () => {
            lastRailTrackbedRevision = revision;
            railTrackbedStats = {
                revision, segmentCount: data.segmentCount, junctionCount: data.junctionCount,
                triangleCount: data.triangleCount, truncated: data.truncated,
            };
        }, () => candidate ? candidate.isCurrent()
            : (Number(getSampledRailTrackbedSegments()?.revision) || 0) === revision,
        { centerX, centerZ, radiusM: GTA_PHYSICS.railTrackbedColliderRadiusM });
    }

    function buildRailFormationDressingCollider(centerX, centerZ, candidate = null) {
        const formation = candidate ? candidate.formation : terrainReference()?.railFormation || null;
        const revision = Number(formation?.revision) || 0;
        // Same bounded query as roads: selecting every rail profile and filtering
        // afterwards generated whole corridors for one 112 m bubble.
        const profiles = typeof formation?.dressingProfilesNear === 'function'
            ? formation.dressingProfilesNear(
                centerX, centerZ, GTA_PHYSICS.railFormationDressingColliderRadiusM,
            ) : formation?.getSurfaceProfiles?.() || [];
        const data = buildRoadFormationDressingTrimeshData({
            profiles, centerX, centerZ,
            radiusM: GTA_PHYSICS.railFormationDressingColliderRadiusM,
            toPhysics: (x, z) => toPhysics(x, z),
            maxTriangles: GTA_PHYSICS.maxRailFormationDressingTriangles,
            surfaceOffsetM: GROUND_SURFACE_LEVELS.tramBed,
        });
        return surfaceColliderReplacement('rail-formation-dressings', 'rail-formation-dressing', data, 1.15, () => {
            lastRailFormationReference = candidate?.formationSource ?? formation;
            lastRailFormationRevision = candidate?.sourceRevision ?? revision;
            railFormationDressingStats = {
                profileCount: data.profileCount, triangleCount: data.triangleCount, truncated: data.truncated,
            };
        }, () => candidate ? candidate.isCurrent() : (terrainReference()?.railFormation || null) === formation
            && (Number(formation?.revision) || 0) === revision,
        { centerX, centerZ, radiusM: GTA_PHYSICS.railFormationDressingColliderRadiusM });
    }

    function buildCurbSurfaceCollider(centerX, centerZ) {
        const steps = buildCurbSurfaceColliderSteps(centerX, centerZ);
        let next;
        do { next = steps.next(); } while (!next.done);
        return next.value;
    }

    function* buildCurbSurfaceColliderSteps(centerX, centerZ, candidate = null) {
        const revision = candidate ? candidate.revision : getCurbCollisionRevision();
        const origin = { ...physicsOrigin };
        const current = () => physicsOrigin.x === origin.x && physicsOrigin.z === origin.z
            && (candidate ? candidate.isCurrent() : getCurbCollisionRevision() === revision);
        const data = yield* buildCurbSurfaceTrimeshDataSteps({
            surfaces: candidate ? candidate.surfacesNear(centerX, centerZ, GTA_PHYSICS.curbSurfaceColliderRadiusM)
                : getCurbCollisionSurfacesNear(centerX, centerZ, GTA_PHYSICS.curbSurfaceColliderRadiusM),
            centerX, centerZ, radiusM: GTA_PHYSICS.curbSurfaceColliderRadiusM,
            physicsOrigin: origin, maxTriangles: GTA_PHYSICS.maxCurbSurfaceTriangles,
            now: monotonicNowMs, isCurrent: current,
        });
        if (!data || !current()) return null;
        return surfaceColliderReplacement('curb-surfaces', 'curb-surface', data, 1.05, () => {
            lastCurbCollisionRevision = revision;
            curbSurfaceStats = { triangleCount: data.triangleCount, truncated: data.truncated };
        }, current,
        { centerX, centerZ, radiusM: GTA_PHYSICS.curbSurfaceColliderRadiusM });
    }

    // The same adapter serves today's immediate collider refresh and a shared
    // ground batch. It keeps resource counts reversible until the whole batch
    // succeeds; source acknowledgements and retirement belong after success.
    function* prepareFixedSurfacesSteps(plans, measure = (_label, callback) => callback()) {
        if (pendingFixedSurfaces || plans.length === 0
            || plans.some(plan => !plan || plan.isCurrent?.() === false)) return null;
        const preparedWorld = world;
        const previousCount = fixedColliderResourceCount;
        const originX = physicsOrigin.x, originZ = physicsOrigin.z;
        const ownStateCurrent = () => world === preparedWorld && fixedColliderResourceCount === previousCount
            && physicsOrigin.x === originX && physicsOrigin.z === originZ;
        const inputsCurrent = () => ownStateCurrent() && plans.every(plan => plan.isCurrent?.() !== false);
        const replacements = [...plans];
        let nextCount = fixedColliderResourceCount;
        for (const plan of plans) {
            nextCount += plan.meshes.length - entryColliders(fixedBodies.get(plan.key)).length;
        }
        const retiredObstacleIds = [], migratedObstacleIds = new Set();
        const migratedFamilies = new Set(plans.map(plan => plan.replacesCivilFamily).filter(Boolean));
        for (const [key, entry] of fixedBodies) if (migratedFamilies.has(entry.spec.groundColliderFamily)) {
            migratedObstacleIds.add(key); nextCount -= entryColliders(entry).length;
            replacements.push({ key, spec: entry.spec, meshes: [] });
        }
        if (nextCount > GTA_PHYSICS.maxFixedColliders) {
            const removable = [...fixedBodies.entries()]
                .filter(([id]) => !GROUND_COLLIDER_KEYS.has(id) && !migratedObstacleIds.has(id))
                .sort(([, left], [, right]) => (Number(right.spec?.distanceSq) || 0)
                    - (Number(left.spec?.distanceSq) || 0));
            for (const [key, entry] of removable) {
                if (nextCount <= GTA_PHYSICS.maxFixedColliders) break;
                nextCount -= entryColliders(entry).length;
                retiredObstacleIds.push(key);
                replacements.push({ key, spec: entry.spec, meshes: [] });
            }
        }
        let publication, allocationSteps, cancelled = false;
        const reservation = {
            rollback() {},
            discard() {
                cancelled = true;
                allocationSteps?.return();
                publication?.dispose();
                if (pendingFixedSurfaces === reservation) pendingFixedSurfaces = null;
            },
        };
        pendingFixedSurfaces = reservation;
        try {
            allocationSteps = prepareFixedSurfacePublicationSteps({
                RAPIER, world, active: fixedBodies, metadata: colliderMetadata, replacements,
                activeColliderCount: fixedColliderResourceCount,
                maxColliders: GTA_PHYSICS.maxFixedColliders,
                maxStagedColliders: GTA_PHYSICS.maxStagedSurfaceColliders,
            });
            for (;;) {
                if (cancelled || !inputsCurrent()) return null;
                let next;
                measure('supportPrepare', () => {
                    // Retain ownership inside the reporting wrapper: it can
                    // itself throw after an allocation or completed iterator.
                    next = allocationSteps.next();
                    if (next.done) publication = next.value;
                    return next;
                });
                if (next.done) break;
                yield next.value;
            }
            if (!inputsCurrent()) {
                publication.dispose();
                publication = null;
                return null;
            }
        } catch (error) {
            publication?.dispose();
            publication = null;
            if (error.code === 'surface-collider-capacity') fixedCapacityHits += 1;
            else console.error('[gta] Ground collider preparation failed; previous support retained', error);
            return null;
        } finally {
            allocationSteps?.return();
            if (!publication && pendingFixedSurfaces === reservation) pendingFixedSurfaces = null;
        }
        let committed = false, settled = false;
        const entry = {
            clear: true,
            isCurrent: () => pendingFixedSurfaces === entry && !settled && !committed && inputsCurrent(),
            commit() {
                // The registry prevalidates every member's input generation.
                // An earlier member may now have installed that generation;
                // guard our own world/resources here, not upstream pointers.
                if (pendingFixedSurfaces !== entry || settled || committed || !ownStateCurrent()
                    || !measure('supportCommit', () => publication.promote())) return false;
                committed = true;
                fixedColliderResourceCount = publication.nextColliderCount;
                for (const key of retiredObstacleIds) fixedBodies.delete(key);
                for (const key of migratedObstacleIds) fixedBodies.delete(key);
                fixedCapacityHits += retiredObstacleIds.length;
                return true;
            },
            rollback() {
                if (!committed || settled) return;
                publication.rollback();
                fixedColliderResourceCount = previousCount;
                fixedCapacityHits -= retiredObstacleIds.length;
                committed = false;
            },
            discard() {
                if (settled) return;
                if (committed) throw new Error('Roll back GTA ground support before discarding');
                publication.dispose();
                settled = true;
                if (pendingFixedSurfaces === entry) pendingFixedSurfaces = null;
            },
        };
        pendingFixedSurfaces = entry;
        return {
            entry,
            finalize() {
                if (settled || !committed) return false;
                settled = true;
                if (pendingFixedSurfaces === entry) pendingFixedSurfaces = null;
                // These callbacks only acknowledge the captured inputs/stats.
                // The coordinator finalizes before the next physics step.
                for (const plan of plans) plan.onPublished?.();
                for (const error of measure('supportRetire', () => publication.retire())) {
                    console.error('[gta] Collider retirement failed', error);
                }
                return true;
            },
        };
    }

    function prepareFixedSurfaces(plans, measure) {
        const steps = prepareFixedSurfacesSteps(plans, measure);
        let next;
        do { next = steps.next(); } while (!next.done);
        return next.value;
    }

    function publishFixedSurfaces(plans, measure = (_label, callback) => callback()) {
        if (plans.length === 0) return true;
        const prepared = prepareFixedSurfaces(plans, measure);
        if (!prepared) return false;
        try {
            if (!prepared.entry.isCurrent() || !prepared.entry.commit()) {
                prepared.entry.discard();
                return false;
            }
        } catch (error) {
            prepared.entry.rollback(); prepared.entry.discard();
            console.error('[gta] Ground collider publication failed; previous support retained', error);
            return false;
        }
        prepared.finalize();
        return true;
    }

    // Capture each affected family's existing physics coverage. One prepared
    // replacement owns the shared Rapier table/capacity reservation for the
    // entire ground group; independently reserved family entries cannot join.
    function captureGroundPublicationRegion(families) {
        if (!Array.isArray(families) || !families.length || new Set(families).size !== families.length
            || families.some(key => !GROUND_COLLIDER_KEYS.has(key))) {
            throw new TypeError('Ground publication requires unique supported collider families');
        }
        if (!world) return null;
        const rows = families.map(key => ({ key, active: fixedBodies.get(key) }));
        if (rows.some(row => !row.active)) return null;
        const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const row of rows) {
            const coverage = row.active.spec.coverage;
            if (![coverage?.centerX, coverage?.centerZ, coverage?.radiusM].every(Number.isFinite)
                || coverage.radiusM <= 0) throw new Error('Published ground colliders have no finite coverage');
            row.coverage = Object.freeze({ ...coverage });
            bounds.minX = Math.min(bounds.minX, coverage.centerX - coverage.radiusM);
            bounds.maxX = Math.max(bounds.maxX, coverage.centerX + coverage.radiusM);
            bounds.minZ = Math.min(bounds.minZ, coverage.centerZ - coverage.radiusM);
            bounds.maxZ = Math.max(bounds.maxZ, coverage.centerZ + coverage.radiusM);
        }
        const capturedWorld = world, originX = physicsOrigin.x, originZ = physicsOrigin.z;
        const isCurrent = () => world === capturedWorld
            && rows.every(row => fixedBodies.get(row.key) === row.active)
            && physicsOrigin.x === originX && physicsOrigin.z === originZ;
        return Object.freeze({
            bounds: Object.freeze(bounds),
            coverage: Object.freeze(Object.fromEntries(rows.map(row => [row.key, row.coverage]))),
            isCurrent,
            *prepareSteps(reads, sourceCurrent, measure) {
                if (!reads || typeof sourceCurrent !== 'function' || rows.some(row => !reads[row.key])) {
                    throw new TypeError('Staged ground support requires an explicit read for every affected family');
                }
                for (const { key } of rows) {
                    const read = reads[key];
                    if ((key === 'road-surfaces' && typeof read.partsNear !== 'function')
                    || (key === 'curb-surfaces' && (typeof read.surfacesNear !== 'function'
                            || !Number.isSafeInteger(read.revision)))
                        || (key === 'authored-surfaces' && typeof read.surfacesNear !== 'function')
                        || (key === 'rail-trackbed' && (!Array.isArray(read.snapshot?.segments)
                            || !Number.isSafeInteger(read.snapshot?.revision)))
                        || (['formation-dressings', 'rail-formation-dressings'].includes(key)
                            && !Object.hasOwn(read, 'formation'))) {
                        throw new TypeError(`Incomplete candidate read for ${key}`);
                    }
                }
                const current = () => isCurrent() && sourceCurrent();
                const plans = [];
                for (const { key, coverage: { centerX, centerZ } } of rows) {
                    const candidate = { ...reads[key], isCurrent: current };
                    let steps;
                    if (key === 'terrain') steps = buildTerrainColliderSteps(centerX, centerZ, 0, candidate);
                    else if (key === 'road-surfaces') steps = buildRoadSurfaceColliderSteps(centerX, centerZ, candidate);
                    else if (key === 'curb-surfaces') steps = buildCurbSurfaceColliderSteps(centerX, centerZ, candidate);
                    else if (key === 'authored-surfaces') steps = buildAuthoredSurfaceColliderSteps(centerX, centerZ, candidate);
                    else {
                        const build = key === 'rail-trackbed' ? buildRailTrackbedCollider
                            : key === 'formation-dressings' ? buildFormationDressingCollider : buildRailFormationDressingCollider;
                        const plan = build(centerX, centerZ, candidate);
                        if (!plan || !current()) return null;
                        plans.push(plan);
                        yield { phase: 'ground-collider-' + key };
                        continue;
                    }
                    let plan;
                    try {
                        while (current()) {
                            const next = steps.next();
                            if (next.done) { plan = next.value; break; }
                            yield next.value;
                        }
                    } finally { steps.return(); }
                    if (!plan || !current() || !plan.isCurrent()) return null;
                    plans.push(plan);
                }
                while (pendingFixedSurfaces && current()) yield { phase: 'ground-collider-lease', deferFrame: true };
                if (!current()) return null;
                const prepared = yield* prepareFixedSurfacesSteps(plans, measure);
                if (!prepared && current()) throw new Error('Staged ground collider allocation failed');
                return prepared;
            },
        });
    }

    function* buildAuthoredSurfaceColliderSteps(centerX, centerZ, candidate = null) {
        const source = candidate || authoredSurfaceReference();
        const revision = source.revision;
        const origin = { ...physicsOrigin };
        const current = () => physicsOrigin.x === origin.x && physicsOrigin.z === origin.z
            && (candidate ? candidate.isCurrent() : authoredSurfaceReference() === source);
        const data = yield* buildCurbSurfaceTrimeshDataSteps({
            surfaces: source.surfacesNear(centerX, centerZ, GTA_PHYSICS.authoredSurfaceColliderRadiusM),
            centerX, centerZ, radiusM: GTA_PHYSICS.authoredSurfaceColliderRadiusM,
            physicsOrigin: origin, maxTriangles: GTA_PHYSICS.maxAuthoredSurfaceTriangles,
            now: monotonicNowMs, isCurrent: current,
        });
        if (!data || !current()) return null;
        const replacement = surfaceColliderReplacement('authored-surfaces', 'authored-surface', data, 1.05, () => {
            lastAuthoredSurfaceRevision = revision;
            lastAuthoredSurfaceRevisionReference = candidate ? authoredSurfaceReference() : source;
            authoredSurfaceStats = { triangleCount: data.triangleCount, truncated: data.truncated };
        }, current, { centerX, centerZ, radiusM: GTA_PHYSICS.authoredSurfaceColliderRadiusM });
        return { ...replacement, replacesCivilFamily: revision > 0 ? 'authored-surfaces' : null };
    }

    // Join physics only after the world candidate is prepared. During the
    // civil solve, ordinary recentering still consumes the published world.
    // This short lease covers consumer preparation and the common boundary.
    function admitGroundPublicationRegion(families, { allowEmpty = false } = {}) {
        if (groundPublicationLease || pendingBubbleBuild || pendingFixedSurfaces) return null;
        const read = captureGroundPublicationRegion(families)
            || (allowEmpty ? captureEmptyGroundPublicationRegion() : null);
        if (!read) return null;
        const lease = {
            release() {
                if (groundPublicationLease !== lease) return false;
                groundPublicationLease = null;
                return true;
            },
        };
        groundPublicationLease = lease;
        const current = () => groundPublicationLease === lease && read.isCurrent();
        return Object.freeze({ ...read, isCurrent: current, release: lease.release,
            *prepareSteps(reads, sourceCurrent, measure) {
                return yield* read.prepareSteps(reads, () => current() && sourceCurrent(), measure);
            },
        });
    }

    // GTA exists in walking sessions before it has ever built a vehicle
    // collision bubble. This explicit empty read can join a ground generation;
    // starting a bubble invalidates it before either side can publish.
    function captureEmptyGroundPublicationRegion() {
        const capturedWorld = world;
        const empty = () => world === capturedWorld && !pendingBubbleBuild && !pendingFixedSurfaces
            && [...GROUND_COLLIDER_KEYS].every(key => !fixedBodies.has(key));
        return empty() ? Object.freeze({ empty: true, isCurrent: empty }) : null;
    }

    function groundCoverageAllowsStep(pose) {
        const velocity = chassisBody.linvel();
        // The enclosing footprint covers every heading. Allow current-speed
        // travel for the maximum physics interval, plus 1 m for acceleration
        // and contact correction; rebuilding begins well inside this edge.
        const paddingM = Math.hypot(controlled.halfWidthM, controlled.halfLengthM)
            + Math.hypot(velocity.x, velocity.z) * GTA_PHYSICS.maxSubsteps / GTA_PHYSICS.stepHz + 1;
        for (const key of GROUND_COLLIDER_KEYS) {
            if (!colliderCoverageContains(fixedBodies.get(key)?.spec?.coverage, pose, paddingM)) return false;
        }
        return true;
    }

    function obstacleSpec(obstacle) {
        const policy = GTA_OBSTACLE_POLICY[obstacle.kind] || GTA_OBSTACLE_POLICY.concrete_barrier;
        const height = Math.max(0.5, Number(obstacle.heightM) || 1);
        const radius = Math.max(0.12, Number(obstacle.radiusM) || 0.35);
        return {
            ...obstacle,
            halfX: obstacle.kind === 'bench' ? 0.72 : radius,
            halfY: height * 0.5,
            halfZ: obstacle.kind === 'bench' ? 0.24 : radius,
            y: (Number(obstacle.y) || 0) + height * 0.5,
            yaw: Number(obstacle.yaw) || 0,
            destructive: !!policy.destructive,
            forceThresholdN: Number(policy.forceThresholdN) || Infinity,
        };
    }

    function colliderSpecChanged(previous, next) {
        if (!previous) return true;
        return ['x', 'y', 'z', 'halfX', 'halfY', 'halfZ', 'yaw'].some(key => (
            Math.abs((Number(previous[key]) || 0) - (Number(next[key]) || 0)) > 0.05
        )) || previous.destructive !== next.destructive;
    }

    function scheduleFixedBubble(x, z, referenceY, options = {}, inputs = []) {
        if (!world || pendingBubbleBuild || groundPublicationLease) return false;
        if (!surfacePublications?.prepareBatch || !groundPublications?.enqueue) {
            throw new Error('GTA ground support requires the shared publication boundary');
        }
        const generation = bubbleGeneration;
        const request = { inputs, phase: 'prepare', steps: null, job: null, result: false };
        const current = () => !disposed && generation === bubbleGeneration && pendingBubbleBuild === request;
        request.steps = buildFixedBubbleSteps(x, z, referenceY, options, current);
        pendingBubbleBuild = request;
        const finish = error => {
            request.steps.return();
            if (pendingBubbleBuild !== request) return;
            pendingBubbleBuild = null;
            if (request.result === true) {
                failedSurfaceRequest = null;
                setWorldBuildBlocker('gta-ground-support', null);
                return;
            }
            const previous = failedSurfaceRequest;
            const same = previous && inputs.length === previous.inputs.length
                && inputs.every((value, index) => Object.is(value, previous.inputs[index]));
            failedSurfaceRequest = { inputs, atMs: monotonicNowMs(),
                attempts: same ? previous.attempts + 1 : 1,
                error: error ? String(error.message || error) : 'Ground support inputs changed during preparation' };
            if (error) console.error('[gta] Ground bubble preparation failed; previous support retained', error);
            // Loading cannot see this private support queue; name the failure so a
            // curtain released by timeout reports why rather than an anonymous stall.
            if (error) setWorldBuildBlocker('gta-ground-support', { code: error.code || 'gta-ground-support-failed',
                message: failedSurfaceRequest.error });
        };
        request.job = bubbleQueue.enqueue([request], () => {
            if (!current()) return;
            const next = request.steps.next();
            if (next.done) { request.result = next.value; return; }
            request.phase = next.value?.phase || 'prepare';
            return next.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
        }, { maxItemsPerFrame: 16, maxItemsPerSettledFrame: 32,
            onComplete: () => finish(), onError: finish,
            onCancel: () => { request.steps.return(); if (pendingBubbleBuild === request) pendingBubbleBuild = null; },
            describeItem: () => request.phase });
        return false;
    }

    function* buildFixedBubbleSteps(x, z, referenceY, {
        rebuildTerrain = false,
        rebuildRoadSurfaces = false,
        rebuildRailTrackbed = false,
        rebuildRailFormationDressings = false,
        rebuildCurbs = false,
        rebuildAuthoredSurfaces = false,
    } = {}, isCurrent = () => true) {
        while (pendingFixedSurfaces && isCurrent()) yield { phase: 'ground-collider-lease', deferFrame: true };
        if (!world || !isCurrent()) return false;
        const planBreakdown = {};
        const measurePlanStage = (label, callback) => {
            const startedAt = monotonicNowMs();
            const result = callback();
            planBreakdown[label] = (planBreakdown[label] || 0) + monotonicNowMs() - startedAt;
            return result;
        };
        const measurePlanSteps = function* (label, steps) {
            try {
                while (isCurrent()) {
                    const next = measurePlanStage(label, () => steps.next());
                    if (next.done) return next.value;
                    yield next.value;
                }
                return null;
            } finally { steps.return(); }
        };
        const replacements = [];
        if (rebuildTerrain || !fixedBodies.has('terrain')) {
            const terrain = yield* measurePlanSteps('terrain', buildTerrainColliderSteps(x, z, referenceY));
            if (!terrain) return false;
            replacements.push(terrain);
            yield { phase: 'ground-terrain-ready' };
        }
        if (rebuildRoadSurfaces || !fixedBodies.has('road-surfaces')) {
            const roads = yield* measurePlanSteps('roadSurfaces', buildRoadSurfaceColliderSteps(x, z));
            if (!roads) return false;
            replacements.push(roads);
        }
        if (rebuildRoadSurfaces || !fixedBodies.has('formation-dressings')) {
            replacements.push(measurePlanStage('formationDressings', () => buildFormationDressingCollider(x, z)));
            yield { phase: 'ground-road-dressing-ready' };
        }
        if (rebuildRailTrackbed || !fixedBodies.has('rail-trackbed')) {
            replacements.push(measurePlanStage('railTrackbed', () => buildRailTrackbedCollider(x, z)));
            yield { phase: 'ground-rail-ready' };
        }
        if (rebuildRailFormationDressings || !fixedBodies.has('rail-formation-dressings')) {
            replacements.push(measurePlanStage('railFormationDressings', () => buildRailFormationDressingCollider(x, z)));
            yield { phase: 'ground-rail-dressing-ready' };
        }
        if (rebuildCurbs || lastCurbCollisionRevision < 0) {
            const curbs = yield* measurePlanSteps('curbs', buildCurbSurfaceColliderSteps(x, z));
            if (!curbs) return false;
            replacements.push(curbs);
        }
        if (rebuildAuthoredSurfaces || !fixedBodies.has('authored-surfaces')) {
            const authored = yield* measurePlanSteps('authoredSurfaces', buildAuthoredSurfaceColliderSteps(x, z));
            if (!authored) return false;
            replacements.push(authored);
        }
        if (!isCurrent()) return false;
        if (replacements.length) {
            let prepared, ticket, batch;
            try {
                prepared = yield* prepareFixedSurfacesSteps(replacements, measurePlanStage);
                if (!prepared || !isCurrent()) return false;
                batch = surfacePublications.prepareBatch([{ ...prepared.entry,
                    ticket: surfacePublications.begin({ key: 'gta:ground-support', generation: ++supportPublicationGeneration }) }]);
                while (isCurrent()) {
                    ticket = groundPublications.enqueue(batch, { onPublished: prepared.finalize });
                    if (ticket) break;
                    yield { phase: 'ground-support-boundary-slot', deferFrame: true };
                }
                if (!ticket) return false;
                let result = null, failure = null;
                ticket.promise.then(value => { result = value; }, error => { failure = error; });
                while (!result && !failure && isCurrent()) yield { phase: 'ground-support-boundary', deferFrame: true };
                if (failure) throw failure;
                if (!isCurrent() || !result?.status.startsWith('published')) return false;
            } finally {
                ticket?.cancel('ground-bubble-cancelled');
                if (batch?.state === 'staged') batch.discard('ground-bubble-cancelled');
                prepared?.entry.discard();
            }
        }
        const supportColliderCount = entryColliders(fixedBodies.get('terrain')).length
            + entryColliders(fixedBodies.get('road-surfaces')).length
            + entryColliders(fixedBodies.get('formation-dressings')).length
            + entryColliders(fixedBodies.get('rail-trackbed')).length
            + entryColliders(fixedBodies.get('rail-formation-dressings')).length
            + entryColliders(fixedBodies.get('curb-surfaces')).length
            + entryColliders(fixedBodies.get('authored-surfaces')).length;
        const maxWorldColliders = Math.max(
            0,
            GTA_PHYSICS.maxFixedColliders - supportColliderCount,
        );
        const maxWalls = Math.max(0, Math.min(
            GTA_PHYSICS.maxBuildingColliders,
            maxWorldColliders,
        ));
        const directBuildingColliders = typeof buildingColliderSpecsNear === 'function';
        const footprints = measurePlanStage('buildingFootprints', () => (
            directBuildingColliders
                ? []
                : buildingFootprintsProvider(
                    x,
                    z,
                    GTA_PHYSICS.colliderRetireRadiusM,
                )
        ));
        const walls = measurePlanStage('buildingWalls', () => (
            directBuildingColliders
                ? buildingColliderSpecsNear(
                    x,
                    z,
                    GTA_PHYSICS.colliderEnterRadiusM,
                    maxWalls,
                    {
                        minY: Number.isFinite(referenceY) ? referenceY - 3 : null,
                        maxY: Number.isFinite(referenceY) ? referenceY + 4 : null,
                    },
                )
                : buildingWallColliderSpecs(footprints, {
                    centerX: x,
                    centerZ: z,
                    radiusM: GTA_PHYSICS.colliderEnterRadiusM,
                    maxColliders: maxWalls,
                    heightAt: (wallX, wallZ) => physicsSupportY(
                        wallX,
                        wallZ,
                        referenceY,
                    ),
                })
        ));
        const civil = measurePlanStage('civil', () => getWalkColliderBoxesNear(
            x,
            z,
            GTA_PHYSICS.colliderEnterRadiusM,
            GTA_PHYSICS.maxCivilColliders,
            { excludeGroundSurfaces: true },
        ).map(box => ({
            id: `civil:${box.key}`,
            kind: 'civil',
            groundColliderFamily: box.groundColliderFamily || null,
            x: box.cx,
            y: (box.minY + box.maxY) * 0.5,
            z: box.cz,
            halfX: box.hx,
            halfY: Math.max(0.05, (box.maxY - box.minY) * 0.5),
            halfZ: box.hz,
            yaw: Math.atan2(box.sin, box.cos),
            distanceSq: box.distanceSq,
            destructive: false,
        })));
        const furniture = measurePlanStage('furniture', () => ([
            ...getBreakableStreetFurnitureNear(x, z, GTA_PHYSICS.colliderEnterRadiusM),
            ...getDecorObstaclesNear(x, z, GTA_PHYSICS.colliderEnterRadiusM),
        ].map(obstacle => {
            const spec = obstacleSpec(obstacle);
            spec.distanceSq = (spec.x - x) ** 2 + (spec.z - z) ** 2;
            return spec;
        }).sort((a, b) => a.distanceSq - b.distanceSq || a.id.localeCompare(b.id))
            .slice(0, GTA_PHYSICS.maxFurnitureColliders)));
        const diffStartedAt = monotonicNowMs();
        if (entrySafetyZone) {
            const pose = currentVehiclePose();
            if (pose && Math.hypot(
                pose.x - entrySafetyZone.x,
                pose.z - entrySafetyZone.z,
            ) >= GTA_PHYSICS.entrySafetyReleaseDistanceM) entrySafetyZone = null;
        }
        const desired = [...walls, ...civil, ...furniture]
            .filter(spec => !entrySafetyZone || !colliderSpecOverlapsVehicle(
                spec,
                entrySafetyZone,
                GTA_PHYSICS.entrySafetyClearanceM,
            ))
            .sort((a, b) => a.distanceSq - b.distanceSq || a.id.localeCompare(b.id))
            .slice(0, maxWorldColliders);
        const desiredById = new Map(desired.map(spec => [spec.id, spec]));
        fixedRetireQueue = [];
        fixedRetireIds = new Set();
        for (const [id, entry] of fixedBodies) {
            if (['terrain', 'road-surfaces', 'formation-dressings', 'rail-trackbed',
                'rail-formation-dressings', 'curb-surfaces', 'authored-surfaces']
                .includes(id)) continue;
            const next = desiredById.get(id);
            if (next && !colliderSpecChanged(entry.spec, next)) continue;
            fixedRetireQueue.push(id);
            fixedRetireIds.add(id);
        }
        fixedBuildQueue = desired.filter(spec => {
            const existing = fixedBodies.get(spec.id);
            return !existing || colliderSpecChanged(existing.spec, spec);
        });
        planBreakdown.diff = monotonicNowMs() - diffStartedAt;
        colliderContentRefreshElapsed = 0;
        bubbleRevision += 1;
        // Report actual work, excluding the frames spent waiting for the
        // scheduler or the shared pre-controller publication boundary.
        lastBubblePlanMs = Object.values(planBreakdown).reduce((sum, ms) => sum + ms, 0);
        lastBubblePlanBreakdown = { ...planBreakdown, total: lastBubblePlanMs };
        if (lastBubblePlanMs > maxBubblePlanMs) {
            maxBubblePlanMs = lastBubblePlanMs;
            maxBubblePlanBreakdown = { ...lastBubblePlanBreakdown };
        }
        return true;
    }

    function drainFixedBubbleWork(
        maxOps = GTA_PHYSICS.colliderOpsPerFrame,
        maxMs = GTA_PHYSICS.colliderWorkBudgetMs,
    ) {
        if (pendingFixedSurfaces) return;
        const drainStartedAt = monotonicNowMs();
        const workBudgetMs = Math.max(0.1, Number(maxMs) || 0.1);
        let remaining = Math.max(0, Math.trunc(Number(maxOps) || 0));
        const protectedVehicles = [];
        const needsVehicleProtection = fixedBuildQueue.length > 0;
        if (needsVehicleProtection && chassisBody && controlled && !specialVehicleState) {
            const translation = chassisBody.translation();
            const rotation = chassisBody.rotation();
            const halfWidthM = Math.max(0, Number(controlled.halfWidthM) || 0);
            const halfHeightM = Math.max(0, Number(controlled.chassisHalfHeightM) || 0);
            const halfLengthM = Math.max(0, Number(controlled.halfLengthM) || 0);
            const right = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, rotation);
            const up = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, rotation);
            const forward = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, rotation);
            protectedVehicles.push({
                x: translation.x + physicsOrigin.x,
                centerY: translation.y,
                z: translation.z + physicsOrigin.z,
                heading: yawFromQuaternion(rotation),
                halfWidthM,
                // Exact vertical projection of the rotated chassis box. The
                // horizontal SAT below is deliberately conservative for pitch
                // and roll, so a tipped vehicle remains protected too.
                halfHeightM: Math.abs(right.y) * halfWidthM
                    + Math.abs(up.y) * halfHeightM
                    + Math.abs(forward.y) * halfLengthM,
                halfLengthM,
            });
        }
        for (const entry of needsVehicleProtection ? trafficBodies.values() : []) {
            if (entry.mode !== 'dynamic') continue;
            const translation = entry.body.translation();
            protectedVehicles.push({
                x: translation.x + physicsOrigin.x,
                centerY: translation.y,
                z: translation.z + physicsOrigin.z,
                heading: yawFromQuaternion(entry.body.rotation()),
                halfWidthM: Math.max(0, Number(entry.obstacle.widthM) || 0) * 0.5,
                halfHeightM: entry.halfY,
                halfLengthM: Math.max(0, Number(entry.obstacle.lengthM) || 0) * 0.5,
            });
        }
        while (remaining > 0
            && monotonicNowMs() - drainStartedAt < workBudgetMs
            && (fixedRetireQueue.length > 0 || fixedBuildQueue.length > 0)) {
            if (fixedRetireQueue.length > 0 && remaining > 0) {
                const id = fixedRetireQueue.shift();
                fixedRetireIds.delete(id);
                removeFixedBody(id);
                remaining -= 1;
            }
            if (fixedBuildQueue.length > 0 && remaining > 0
                && fixedColliderResourceCount < GTA_PHYSICS.maxFixedColliders) {
                let attempts = fixedBuildQueue.length;
                let built = false;
                while (attempts > 0 && fixedBuildQueue.length > 0) {
                    attempts -= 1;
                    const spec = fixedBuildQueue.shift();
                    if (fixedBodies.has(spec.id)) {
                        if (fixedRetireIds.has(spec.id)) fixedBuildQueue.push(spec);
                        continue;
                    }
                    if (shouldDeferColliderBuild(
                        spec,
                        protectedVehicles,
                        GTA_PHYSICS.colliderSpawnClearanceM,
                    )) {
                        fixedBuildQueue.push(spec);
                        continue;
                    }
                    createFixedCuboid(spec);
                    remaining -= 1;
                    built = true;
                    break;
                }
                if (!built && fixedRetireQueue.length === 0) break;
            } else if (fixedRetireQueue.length === 0) {
                if (fixedBuildQueue.length > 0
                    && fixedColliderResourceCount >= GTA_PHYSICS.maxFixedColliders) {
                    fixedCapacityHits += 1;
                }
                break;
            }
        }
        lastBubbleDrainMs = monotonicNowMs() - drainStartedAt;
        maxBubbleDrainMs = Math.max(maxBubbleDrainMs, lastBubbleDrainMs);
    }

    function maybeRebase(worldX, worldZ) {
        const rebase = resolvePhysicsRebase(physicsOrigin, { x: worldX, z: worldZ }, PHYSICS_REBASE_M);
        if (!rebase || !chassisBody) return;
        const shiftBody = body => {
            if (!body) return;
            const translation = body.translation();
            body.setTranslation({
                x: translation.x - rebase.dx,
                y: translation.y,
                z: translation.z - rebase.dz,
            }, true);
        };
        // Shift every Rapier resource before publishing the new origin. Specs,
        // routes and tile IDs remain absolute, so this transaction causes no
        // refetch and no temporary mismatch inside the physics world.
        shiftBody(chassisBody);
        for (const entry of trafficBodies.values()) shiftBody(entry.body);
        for (const entry of fixedBodies.values()) shiftBody(entry.body);
        physicsOrigin = { x: rebase.x, z: rebase.z };
    }

    function makeTrafficBody(obstacle, mode) {
        const claimed = mode === 'dynamic' ? claimTrafficCarForPhysics(obstacle.id) : null;
        if (mode === 'dynamic' && !claimed) return null;
        const source = claimed || obstacle;
        const point = toPhysics(source.x, source.z);
        const halfY = source.heightM * 0.5;
        let bodyDesc = mode === 'dynamic'
            ? RAPIER.RigidBodyDesc.dynamic()
                .setLinearDamping(GTA_TRAFFIC_TUNING.linearDamping)
                .setAngularDamping(GTA_TRAFFIC_TUNING.angularDamping)
                .setCcdEnabled(true)
            : RAPIER.RigidBodyDesc.kinematicPositionBased();
        bodyDesc = bodyDesc
            .setTranslation(point.x, source.y + halfY, point.z)
            .setRotation(yawQuaternion(source.heading));
        if (mode === 'dynamic') {
            bodyDesc = bodyDesc
                // Ambient traffic uses a simple cuboid rather than the
                // player's ray-cast suspension. Let crashes push and yaw it,
                // but do not let a traffic pile-up balance every car on its
                // doors and cascade down the street.
                .enabledRotations(false, true, false)
                .setLinvel(
                    Math.sin(source.heading) * source.speedMps,
                    0,
                    Math.cos(source.heading) * source.speedMps,
                );
        }
        const body = world.createRigidBody(bodyDesc);
        let colliderDesc = RAPIER.ColliderDesc.cuboid(
            source.widthM * 0.5,
            halfY,
            source.lengthM * 0.5,
        )
                .setFriction(0.9)
                .setRestitution(0.05)
                .setCollisionGroups(mode === 'dynamic'
                    ? GTA_COLLISION_GROUPS.trafficMoving
                    : GTA_COLLISION_GROUPS.trafficStatic);
        if (mode === 'dynamic') {
            colliderDesc = colliderDesc.setDensity(GTA_TRAFFIC_TUNING.bodyDensityKgM3);
        }
        if (RAPIER.ActiveEvents) {
            colliderDesc = colliderDesc
                .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
                .setContactForceEventThreshold(GTA_IMPACT.lowForceN);
        }
        const collider = world.createCollider(colliderDesc, body);
        const spec = {
            id: obstacle.id,
            kind: 'vehicle',
            x: obstacle.x,
            y: obstacle.y,
            z: obstacle.z,
            destructive: false,
        };
        colliderMetadata.set(collider.handle, spec);
        return {
            body,
            collider,
            obstacle,
            spec,
            halfY,
            mode,
            claimed: mode === 'dynamic',
            lastContactStep: -Infinity,
        };
    }

    function syncTraffic(x, z) {
        const queried = getTrafficObstaclesNear(
            x,
            z,
            GTA_PHYSICS.trafficRetireRadiusM,
            controlled?.id,
        );
        const byId = new Map(queried.map(obstacle => [obstacle.id, obstacle]));
        const contactingIds = [];
        for (const [id, entry] of trafficBodies) {
            if (physicsStepCount - entry.lastContactStep <= GTA_TRAFFIC_TUNING.contactPrioritySteps) {
                contactingIds.push(id);
            }
            if (byId.has(id)) continue;
            const pose = entry.mode === 'dynamic' ? trafficBodyPose(entry) : null;
            if (pose) byId.set(id, { ...entry.obstacle, ...pose });
        }
        const plan = planTrafficPhysicsBubble({
            obstacles: [...byId.values()],
            existingIds: trafficBodies.keys(),
            contactingIds,
            centerX: x,
            centerZ: z,
            enterRadiusM: GTA_PHYSICS.trafficEnterRadiusM,
            retireRadiusM: GTA_PHYSICS.trafficRetireRadiusM,
            maxBodies: GTA_PHYSICS.maxDynamicTraffic,
        });
        if (plan.capacityHit) trafficCapacityHits += 1;
        for (const id of plan.retireIds) {
            const entry = trafficBodies.get(id);
            removeTrafficEntry(entry);
            trafficBodies.delete(id);
        }
        for (const candidate of plan.selected) {
            const obstacle = candidate.obstacle;
            let entry = trafficBodies.get(obstacle.id);
            if (!entry) {
                entry = makeTrafficBody(obstacle, candidate.mode);
                if (!entry) continue;
                trafficBodies.set(obstacle.id, entry);
            }
            if (entry.mode === 'kinematic') {
                const point = toPhysics(obstacle.x, obstacle.z);
                entry.body.setNextKinematicTranslation({
                    x: point.x,
                    y: obstacle.y + entry.halfY,
                    z: point.z,
                });
                entry.body.setNextKinematicRotation(yawQuaternion(obstacle.heading));
            }
            entry.obstacle = obstacle;
            Object.assign(entry.spec, {
                x: obstacle.x,
                y: obstacle.y,
                z: obstacle.z,
            });
        }
    }

    function applyDynamicTrafficGuidance(dt) {
        for (const entry of trafficBodies.values()) {
            if (entry.mode !== 'dynamic') continue;
            const target = getPromotedTrafficTarget(entry.obstacle.id);
            if (!target) continue;
            // Let an impact play out before the route follower starts pulling
            // the ambient car back toward its lane.
            if (physicsStepCount - entry.lastContactStep
                <= GTA_TRAFFIC_TUNING.collisionReleaseSteps) continue;
            const translation = entry.body.translation();
            const velocity = entry.body.linvel();
            const targetPoint = toPhysics(target.x, target.z);
            const currentYaw = yawFromQuaternion(entry.body.rotation());
            const angularVelocity = entry.body.angvel();
            const command = trafficGuidanceCommand({
                translation,
                velocity,
                yaw: currentYaw,
                angularVelocity,
                target: { ...target, ...targetPoint },
                dt,
                tuning: GTA_TRAFFIC_TUNING,
            });
            entry.body.setLinvel(command.linearVelocity, true);
            entry.body.setAngvel(command.angularVelocity, true);
        }
    }

    function syncDynamicTrafficMeshes() {
        for (const entry of trafficBodies.values()) {
            if (entry.mode !== 'dynamic') continue;
            const pose = trafficBodyPose(entry);
            if (!pose) continue;
            syncPromotedTrafficCar(entry.obstacle.id, pose);
            Object.assign(entry.spec, { x: pose.x, y: pose.y, z: pose.z });
        }
    }

    function supportSurfaceColliders() {
        return [
            ...entryColliders(fixedBodies.get('road-surfaces')),
            ...entryColliders(fixedBodies.get('formation-dressings')),
            ...entryColliders(fixedBodies.get('rail-trackbed')),
            ...entryColliders(fixedBodies.get('rail-formation-dressings')),
            ...entryColliders(fixedBodies.get('curb-surfaces')),
            ...entryColliders(fixedBodies.get('authored-surfaces')),
            ...entryColliders(fixedBodies.get('terrain')),
        ].filter(Boolean);
    }

    function recoverDynamicTrafficFromSurfaces() {
        const surfaceColliders = supportSurfaceColliders();
        if (surfaceColliders.length === 0) return 0;
        let recoveredCount = 0;
        for (const entry of trafficBodies.values()) {
            if (entry.mode !== 'dynamic') continue;
            // Preserve the short collision play-out. Once route guidance owns
            // the car again, its own road target is a cheap, stack-aware gate:
            // only a body visibly below that road pays for exact collider rays.
            const pose = trafficBodyPose(entry);
            const target = getPromotedTrafficTarget(entry.obstacle.id);
            const targetY = finiteOrNull(target?.y);
            if (!pose || targetY === null) continue;
            const visualRootY = finiteOrNull(pose.meshY) ?? finiteOrNull(pose.y);
            if (!shouldProbeTrafficSurface({
                visualRootY,
                routeSupportY: targetY,
                stepsSinceContact: physicsStepCount - entry.lastContactStep,
                collisionReleaseSteps: GTA_TRAFFIC_TUNING.collisionReleaseSteps,
            })) continue;
            const physicsPoint = toPhysics(pose.meshX, pose.meshZ);
            const result = recoverVehicleBodyFromSurfaces({
                RAPIER,
                surfaceColliders,
                chassisBody: entry.body,
                // Traffic's mesh pose is its physical cuboid bottom; it has
                // no suspension offset between the model and collider roots.
                supportProbes: [{
                    name: 'center', physicsX: physicsPoint.x,
                    physicsZ: physicsPoint.z, physicsY: visualRootY,
                }],
            });
            lastTrafficSurfaceRecovery = {
                id: entry.obstacle.id,
                recovered: result.recovered,
                liftM: result.liftM,
                colliderSupportY: result.supportY,
                routeSupportY: targetY,
            };
            if (!result.recovered) continue;
            recoveredCount += 1;
            trafficSurfaceRecoveryCount += 1;
            trafficSurfaceRecoveryLiftM += result.liftM;
        }
        return recoveredCount;
    }

    function configureWheel(index, front, tuning) {
        setIf(vehicleController, 'setWheelSuspensionStiffness', index, tuning.suspensionStiffness);
        setIf(vehicleController, 'setWheelSuspensionCompression', index, tuning.suspensionCompression);
        setIf(vehicleController, 'setWheelSuspensionRelaxation', index, tuning.suspensionRelaxation);
        setIf(vehicleController, 'setWheelMaxSuspensionTravel', index, tuning.suspensionMaxTravelM);
        setIf(vehicleController, 'setWheelMaxSuspensionForce', index, tuning.suspensionMaxForceN);
        setIf(vehicleController, 'setWheelFrictionSlip', index, tuning.wheelFrictionSlip);
        setIf(vehicleController, 'setWheelSideFrictionStiffness', index, tuning.wheelSideFrictionStiffness);
        if (!front) setIf(vehicleController, 'setWheelSteering', index, 0);
    }

    function createControlledVehicle(car) {
        specialVehicleState = null;
        const tuning = gtaRoadVehicleTuning(car.type);
        const chassisShape = gtaRoadVehicleChassisShape(car.type, tuning);
        const chassisHalfHeight = chassisShape.halfHeightM;
        const visualCenterY = chassisShape.visualCenterY;
        const width = Math.max(1.4, Number(car.type?.width) || 1.8);
        const length = Math.max(3.2, Number(car.type?.length) || 4.5);
        const halfWidth = width * chassisShape.halfWidthScale;
        const halfLength = length * chassisShape.halfLengthScale;
        const roundingRadius = Math.min(
            chassisShape.roundingRadiusM,
            halfWidth * 0.45,
            chassisHalfHeight * 0.45,
            halfLength * 0.20,
        );
        const formation = roadFormationReference();
        const osmId = String(car.id || '').match(/^osm:([^:]+)/)?.[1] ?? null;
        const ownProfiles = osmId != null
            ? formation?.getSurfaceProfilesForOsmId?.(
                osmId,
                { allowStale: true },
            ) || []
            : [];
        const entryX = car.x;
        const entryZ = car.z;
        const dressingY = roadFormationDressingSupportYAtPoint({
            profiles: ownProfiles,
            x: entryX,
            z: entryZ,
            surfaceOffsetM: GTA_PHYSICS.roadSurfaceOffsetM,
        });
        const ground = Number.isFinite(dressingY)
            ? dressingY
            : Number(car.mesh?.position.y);
        const baseY = Number.isFinite(ground)
            ? ground
            : supportY(entryX, entryZ, 500);
        if (!Number.isFinite(baseY)) return false;
        physicsOrigin = { x: entryX, z: entryZ };
        // Do not allocate the controllable body until its entire local physics
        // floor has genuine terrain evidence. Knowing the height under the
        // parked car is insufficient: a partially sampled collider would let
        // the first metres of driving fall into an ungenerated void.
        const terrainReplacement = buildTerrainCollider(entryX, entryZ, baseY);
        if (!terrainReplacement || !publishFixedSurfaces([terrainReplacement])) return false;
        colliderCenter = { x: entryX, z: entryZ };
        lastTerrainReference = terrainReference();
        lastTerrainRevision = Number(lastTerrainReference?.revision) || 0;
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, baseY + visualCenterY, 0)
            .setRotation(yawQuaternion(car.heading))
            .setAdditionalMassProperties(
                tuning.chassisMassKg,
                { x: 0, y: tuning.chassisCenterOfMassY, z: 0 },
                tuning.chassisPrincipalInertia,
                { x: 0, y: 0, z: 0, w: 1 },
            )
            .setLinearDamping(tuning.chassisLinearDamping)
            .setAngularDamping(tuning.chassisAngularDamping)
            .setCcdEnabled(true);
        chassisBody = world.createRigidBody(bodyDesc);
        chassisCollider = world.createCollider(
            RAPIER.ColliderDesc.roundCuboid(
                halfWidth - roundingRadius,
                chassisHalfHeight - roundingRadius,
                halfLength - roundingRadius,
                roundingRadius,
            )
                // Explicit rigid-body mass properties own weight and centre of
                // mass; the collision shell must not add a second mass above it.
                .setDensity(0)
                .setFriction(0.72)
                .setRestitution(0.02)
                .setCollisionGroups(GTA_COLLISION_GROUPS.chassis),
            chassisBody,
        );
        vehicleController = world.createVehicleController(chassisBody);
        // Rapier defaults to local +X as the vehicle's forward axis. Station3D
        // car meshes and heading math use local +Z, so make the controller use
        // the same convention before adding wheels or applying engine force.
        vehicleController.setIndexForwardAxis = 2;
        const wheelX = Math.max(0.5, halfWidth * 0.92);
        const wheelZ = Math.max(
            1,
            Math.min(halfLength * 0.88, trafficVehicleWheelbaseM(car.type) * 0.5),
        );
        const connectionY = -chassisHalfHeight * 0.76;
        const connections = [
            { x: -wheelX, y: connectionY, z: wheelZ, front: true },
            { x: wheelX, y: connectionY, z: wheelZ, front: true },
            { x: -wheelX, y: connectionY, z: -wheelZ, front: false },
            { x: wheelX, y: connectionY, z: -wheelZ, front: false },
        ];
        for (const connection of connections) {
            vehicleController.addWheel(
                { x: connection.x, y: connection.y, z: connection.z },
                { x: 0, y: -1, z: 0 },
                { x: 1, y: 0, z: 0 },
                tuning.suspensionRestLengthM,
                WHEEL_RADIUS_M,
            );
            configureWheel(connections.indexOf(connection), connection.front, tuning);
        }
        controlled = {
            ...car,
            x: entryX,
            z: entryZ,
            halfWidthM: halfWidth,
            halfLengthM: halfLength,
            chassisHalfHeightM: chassisHalfHeight,
            roundingRadiusM: roundingRadius,
            visualCenterY,
            wheelX,
            wheelZ,
            tuning,
        };
        // A procedural parked vehicle must still be parked when the player
        // gets in, including on a crowned/sloped formation shoulder. Hold the
        // service brake until the first real W/S press; handleKeyDown already
        // releases this latch on a non-repeat throttle command.
        stopRequested = true;
        entrySafetyZone = {
            x: entryX,
            centerY: baseY + visualCenterY,
            z: entryZ,
            heading: car.heading,
            halfWidthM: halfWidth,
            halfHeightM: chassisHalfHeight,
            halfLengthM: halfLength,
        };
        vehicleHealth = 100;
        secondsSinceVehicleDamage = Infinity;
        lastPlayerImpact = null;
        playerImpactHistory = [];
        impactShake = 0;
        surfaceRecoveryCount = 0;
        surfaceRecoveryLiftM = 0;
        lastSurfaceRecovery = null;
        trafficSurfaceRecoveryCount = 0;
        trafficSurfaceRecoveryLiftM = 0;
        lastTrafficSurfaceRecovery = null;
        supportedCheckpoint = checkpointFromBody(currentVehiclePose());
        escapeRecoveryCount = 0;
        lastEscapeRecovery = null;
        lastTireTargets = gtaTireEffectTargets();
        skidMarks.breakAll();
        lastImpactById.clear();
        scheduleFixedBubble(entryX, entryZ, baseY, {
            rebuildTerrain: false,
            rebuildRoadSurfaces: true,
            rebuildRailTrackbed: true,
            rebuildRailFormationDressings: true,
            rebuildCurbs: true,
            rebuildAuthoredSurfaces: true,
        });
        drainFixedBubbleWork();
        syncTraffic(entryX, entryZ);
        engineAudio.start();
        tireAudio.start();
        return true;
    }

    function createControlledSpecialVehicle(vehicle) {
        removeControlledPhysics();
        const width = Math.max(1, Number(vehicle.width) || 2);
        const length = Math.max(2, Number(vehicle.length) || 5);
        controlled = {
            ...vehicle,
            halfWidthM: width * 0.5,
            halfLengthM: length * 0.5,
        };
        specialVehicleState = createGtaSpecialVehicleState(vehicle);
        physicsOrigin = { x: specialVehicleState.x, z: specialVehicleState.z };
        vehicleHealth = 100;
        secondsSinceVehicleDamage = Infinity;
        lastPlayerImpact = null;
        playerImpactHistory = [];
        impactShake = 0;
        supportedCheckpoint = null;
        escapeRecoveryCount = 0;
        lastEscapeRecovery = null;
        lastPose = currentVehiclePose();
        specialVehicles?.sync?.(controlled.id, lastPose);
        specialVehicleAudio.start(controlled.kind);
        specialVehicleAudio.update(lastPose);
    }

    function removeControlledPhysics() {
        if (world && vehicleController) {
            try { world.removeVehicleController(vehicleController); } catch (_error) { /* no-op */ }
        }
        vehicleController = null;
        chassisCollider = null;
        removeRigidBody(chassisBody);
        chassisBody = null;
        clearFixedBodies();
        for (const entry of trafficBodies.values()) removeTrafficEntry(entry);
        trafficBodies.clear();
        fixedStep.reset();
        steering = 0;
        stopRequested = false;
        pendingExitWalkState = null;
        entrySafetyZone = null;
        supportedCheckpoint = null;
        engineAudio.stop();
        specialVehicleAudio.stop();
        tireAudio.stop();
        skidMarks.breakAll();
    }

    function currentVehiclePose() {
        if (specialVehicleState) {
            const pose = gtaSpecialVehiclePose(specialVehicleState);
            if (!pose) return null;
            const geo = localToGeo(pose.x, pose.z, anchorLon, anchorLat);
            // The SAME ground lookup the arcade solver flies against, so the
            // height-above-ground gauge can never disagree with the surface the
            // aircraft will actually land on.
            const groundY = specialVehicles?.groundYAt?.(pose.x, pose.z);
            return {
                ...pose,
                lon: geo.lon,
                lat: geo.lat,
                groundY: Number.isFinite(groundY) ? groundY : null,
            };
        }
        if (!chassisBody || !controlled) return null;
        const translation = chassisBody.translation();
        const rotation = chassisBody.rotation();
        const velocity = chassisBody.linvel();
        // The rendered car is rooted at its wheel-contact plane. Rotate that
        // local offset with the chassis so a pitched/rolled car remains aligned
        // with its collider instead of being pushed half a metre into asphalt.
        const rootOffset = rotateVectorByQuaternion(
            { x: 0, y: -(controlled.visualCenterY || CHASSIS_VISUAL_CENTER_Y_M), z: 0 },
            rotation,
        );
        const x = translation.x + physicsOrigin.x + rootOffset.x;
        const z = translation.z + physicsOrigin.z + rootOffset.z;
        const y = translation.y + rootOffset.y;
        const heading = yawFromQuaternion(rotation);
        const forwardX = Math.sin(heading);
        const forwardZ = Math.cos(heading);
        const speedMps = velocity.x * forwardX + velocity.z * forwardZ;
        const geo = localToGeo(x, z, anchorLon, anchorLat);
        return {
            id: controlled.id,
            x,
            y,
            z,
            heading,
            headingDeg: gtaSceneYawToHeadingDeg(heading),
            lon: geo.lon,
            lat: geo.lat,
            speedMps,
            speedKmh: Math.abs(speedMps) * 3.6,
            velocityX: velocity.x,
            velocityZ: velocity.z,
            planarSpeedMps: Math.hypot(velocity.x, velocity.z),
            health: vehicleHealth,
            quaternion: rotation,
        };
    }

    // Feeds the tracker from whichever physics path produced this pose, so the
    // exit gate and the stuck watch see one consistent ground reading for cars,
    // boats and aircraft alike.
    function recordGroundMotion(pose) {
        if (!pose) return;
        groundMotion.record({
            x: pose.x,
            z: pose.z,
            nowMs: performance.now(),
            engineSpeedMps: pose.speedMps,
        });
    }

    // What the world says the vehicle is doing, not what its engine claims.
    function groundSpeedMps() {
        return isGtaControlling() ? groundMotion.speedMps() : null;
    }

    function exitSpeedMps(pose) {
        return vehicleExitSpeedMps(pose?.speedMps, groundSpeedMps());
    }

    // A streamed-support miss is an authoritative standstill, not merely a
    // skipped physics frame. Clear the velocity the player can no longer
    // express and restart the displacement window at the held pose; otherwise
    // the exit gate can preserve the last driving speed forever while the car
    // is visibly frozen at the edge of the collider bubble.
    function holdRoadVehicleForSurface(pose) {
        if (!chassisBody || !controlled || !pose) return pose || null;
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        fixedStep.reset();
        skidMarks.breakAll();
        const heldPose = currentVehiclePose() || pose;
        lastPose = heldPose;
        groundMotion.reset();
        recordGroundMotion(heldPose);
        syncControlledParkedCar(controlled.id, heldPose);
        updateEngineAudio();
        return completePendingExitIfStopped(heldPose) ? null : heldPose;
    }

    function recoverControlledVehicleFromSurface() {
        if (!chassisBody) return null;
        const pose = currentVehiclePose();
        if (!pose) return null;
        const surfaceColliders = supportSurfaceColliders();
        const rotation = chassisBody.rotation();
        const wheelContacts = currentWheelContactCount();
        const supportProbes = vehicleSurfaceProbePoints({
            translation: chassisBody.translation(),
            rotation,
            chassisHalfHeightM: controlled?.chassisHalfHeightM,
            halfWidthM: controlled?.halfWidthM,
            halfLengthM: controlled?.halfLengthM,
            roundingRadiusM: controlled?.roundingRadiusM,
            includeCorners: shouldUseVehicleFootprintProbes({ rotation, wheelContacts }),
        });
        const result = surfaceColliders.length > 0
            ? recoverVehicleBodyFromSurfaces({
                RAPIER,
                surfaceColliders,
                chassisBody,
                supportProbes,
            })
            : { recovered: false, supportY: null, liftM: 0 };
        const measuredProbe = result.recoveryPoint || supportProbes[0];
        lastSurfaceRecovery = {
            recovered: result.recovered,
            liftM: result.liftM,
            colliderSupportY: result.supportY,
            recoverySupportY: result.recoverySupportY ?? null,
            // Compare the selected collider with the exact chassis probe,
            // including tilted-corner recoveries away from the vehicle centre.
            probeX: measuredProbe.physicsX + physicsOrigin.x,
            probeZ: measuredProbe.physicsZ + physicsOrigin.z,
            probeY: measuredProbe.physicsY,
            visualRootY: pose.y,
            wheelContacts,
            recoveryProbe: result.recoveryProbe || null,
            probeCount: supportProbes.length,
        };
        if (result.recovered) {
            surfaceRecoveryCount += 1;
            surfaceRecoveryLiftM += result.liftM;
        }
        return result;
    }

    function currentWheelContactCount() {
        if (typeof vehicleController?.numWheels !== 'function'
            || typeof vehicleController?.wheelIsInContact !== 'function') return 0;
        let contacts = 0;
        for (let index = 0; index < vehicleController.numWheels(); index += 1) {
            if (vehicleController.wheelIsInContact(index)) contacts += 1;
        }
        return contacts;
    }

    function checkpointFromBody(pose) {
        if (!chassisBody || !pose) return null;
        const translation = chassisBody.translation();
        const rotation = chassisBody.rotation();
        return {
            worldX: translation.x + physicsOrigin.x,
            centerY: translation.y,
            worldZ: translation.z + physicsOrigin.z,
            rootY: pose.y,
            rotation: { ...rotation },
            physicsStep: physicsStepCount,
        };
    }

    function captureSupportedCheckpoint(pose, recovery) {
        if (!chassisBody || !pose || !Number.isFinite(recovery?.supportY)) return false;
        const wheelContacts = currentWheelContactCount();
        if (wheelContacts < 2) return false;
        const rotation = chassisBody.rotation();
        const uprightY = 1 - 2 * (rotation.x ** 2 + rotation.z ** 2);
        if (uprightY < GTA_VEHICLE_TUNING.checkpointMinUprightY) return false;
        if (Math.abs(pose.y - recovery.supportY)
            > GTA_VEHICLE_TUNING.checkpointMaxSurfaceGapM) return false;
        supportedCheckpoint = checkpointFromBody(pose);
        return !!supportedCheckpoint;
    }

    function restoreUnsupportedVehicleEscape(pose, recovery) {
        if (!chassisBody || !pose || !supportedCheckpoint) return false;
        const velocity = chassisBody.linvel();
        if (!shouldRestoreVehicleCheckpoint({
            hasCheckpoint: true,
            wheelContacts: currentWheelContactCount(),
            supportY: recovery?.supportY,
            visualRootY: pose.y,
            checkpointRootY: supportedCheckpoint.rootY,
            verticalVelocity: velocity.y,
        })) return false;
        const escapedPose = { x: pose.x, y: pose.y, z: pose.z };
        const checkpoint = supportedCheckpoint;
        const point = toPhysics(checkpoint.worldX, checkpoint.worldZ);
        chassisBody.setTranslation({
            x: point.x,
            y: checkpoint.centerY,
            z: point.z,
        }, true);
        chassisBody.setRotation(checkpoint.rotation, true);
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        controls.clear();
        stopRequested = true;
        steering = 0;
        for (let index = 0; index < (vehicleController?.numWheels?.() || 0); index += 1) {
            setIf(vehicleController, 'setWheelEngineForce', index, 0);
            setIf(vehicleController, 'setWheelSteering', index, 0);
        }
        skidMarks.breakAll();
        escapeRecoveryCount += 1;
        lastEscapeRecovery = {
            from: escapedPose,
            to: {
                x: checkpoint.worldX,
                y: checkpoint.rootY,
                z: checkpoint.worldZ,
            },
            dropM: checkpoint.rootY - pose.y,
            physicsStep: physicsStepCount,
        };
        return true;
    }

    function wheelSupportColliderAllowed(collider, pose) {
        const spec = colliderMetadata.get(collider?.handle);
        if (!spec || spec.kind !== 'road-surface' || spec.stackKind === 'ground') return true;
        const roadY = roadVerticalAlignmentReference()?.roadYForOsmIdsAtLocal?.(
            pose.x,
            pose.z,
            spec.osmIds,
        );
        if (!Number.isFinite(roadY)) return true;
        return roadY <= pose.y + GTA_PHYSICS.wheelOverheadClearanceM;
    }

    function applyVehicleControls(dt) {
        if (!vehicleController || !chassisBody) return null;
        const tuning = controlled?.tuning || GTA_VEHICLE_TUNING;
        const pose = currentVehiclePose();
        const speed = pose?.speedMps || 0;
        const left = controls.has('a') || controls.has('arrowleft');
        const right = controls.has('d') || controls.has('arrowright');
        const steerTarget = steeringInputForKeys({ left, right });
        const steeringLimit = steeringLimitAtSpeed(speed, tuning);
        steering += (steerTarget * steeringLimit - steering) * Math.min(1, dt * 7.5);
        setIf(vehicleController, 'setWheelSteering', 0, steering);
        setIf(vehicleController, 'setWheelSteering', 1, steering);

        const forward = controls.has('w') || controls.has('arrowup');
        const reverse = controls.has('s') || controls.has('arrowdown');
        const handbrake = controls.has(' ');
        const command = driveCommandForKeys({
            forward,
            reverse,
            handbrake,
            stop: stopRequested,
            speedMps: speed,
        }, tuning);
        const engine = command.engineForceN
            * (0.55 + 0.45 * Math.max(0, vehicleHealth) / 100);
        for (let index = 0; index < 4; index += 1) {
            const front = index < 2;
            const serviceBrake = command.serviceBrakeImpulseNs
                * (front
                    ? tuning.frontBrakeBias
                    : tuning.rearBrakeBias);
            const handbrakeImpulse = front ? 0 : command.handbrakeImpulseNs;
            // A conventional rear-wheel-drive layout avoids multiplying engine
            // force across all four contact patches and keeps steering composed.
            setIf(vehicleController, 'setWheelEngineForce', index, front ? 0 : engine);
            setIf(
                vehicleController,
                'setWheelBrake',
                index,
                Math.max(serviceBrake, handbrakeImpulse),
            );
        }
        vehicleController.updateVehicle(
            dt,
            undefined,
            GTA_COLLISION_GROUPS.wheelQuery,
            collider => wheelSupportColliderAllowed(collider, pose),
        );
        return {
            command: {
                ...command,
                engineForceN: engine,
            },
            pose,
        };
    }

    function updateTireEffects(command, pose) {
        if (!vehicleController || !command || !pose) {
            lastTireTargets = gtaTireEffectTargets();
            skidMarks.breakAll();
            return;
        }
        const samples = [];
        let contactCount = 0;
        let maxForwardImpulseNs = 0;
        let maxSideImpulseNs = 0;
        const wheelCount = typeof vehicleController.numWheels === 'function'
            ? vehicleController.numWheels() : 0;
        for (let index = 0; index < wheelCount; index += 1) {
            const inContact = vehicleController.wheelIsInContact?.(index) === true;
            if (inContact) contactCount += 1;
            maxForwardImpulseNs = Math.max(
                maxForwardImpulseNs,
                Math.abs(Number(vehicleController.wheelForwardImpulse?.(index)) || 0),
            );
            maxSideImpulseNs = Math.max(
                maxSideImpulseNs,
                Math.abs(Number(vehicleController.wheelSideImpulse?.(index)) || 0),
            );
            const point = inContact ? vehicleController.wheelContactPoint?.(index) : null;
            const ground = inContact ? vehicleController.wheelGroundObject?.(index) : null;
            const groundSpec = colliderMetadata.get(ground?.handle);
            const surfaceKind = groundSpec?.kind === 'road-surface'
                ? 'asphalt'
                : groundSpec?.kind === 'terrain'
                    ? 'terrain'
                    : null;
            samples.push({
                wheelIndex: index,
                surfaceKind,
                point: point ? {
                    x: Number(point.x) + physicsOrigin.x,
                    y: Number(point.y),
                    z: Number(point.z) + physicsOrigin.z,
                } : null,
                intensity: 0,
            });
        }
        const serviceBraking = command.serviceBrakeImpulseNs > 0;
        const handbrake = command.handbrakeImpulseNs > 0;
        lastTireTargets = gtaTireEffectTargets({
            speedMps: pose.speedMps,
            serviceBraking,
            handbrake,
            maxForwardImpulseNs,
            maxSideImpulseNs,
            contactCount,
        });
        for (const sample of samples) {
            const brakeWheel = serviceBraking || (handbrake && sample.wheelIndex >= 2);
            sample.intensity = Math.max(
                lastTireTargets.cornering,
                brakeWheel ? lastTireTargets.braking : 0,
            );
        }
        skidMarks.update(samples);
    }

    function updateEngineAudio() {
        const pose = currentVehiclePose();
        if (!pose) return;
        const command = driveCommandForKeys({
            forward: controls.has('w') || controls.has('arrowup'),
            reverse: controls.has('s') || controls.has('arrowdown'),
            handbrake: controls.has(' '),
            stop: stopRequested,
            speedMps: pose.speedMps,
        });
        engineAudio.update({
            speedMps: pose.speedMps,
            throttle: command.engineForceN !== 0,
            reverse: command.engineForceN > 0,
            braking: command.serviceBrakeImpulseNs > 0 || command.handbrakeImpulseNs > 0,
            health: vehicleHealth,
        });
        tireAudio.update(lastTireTargets);
    }

    function playBreakSound() {
        try {
            const ctx = ensureGtaAudioContext();
            if (!ctx) return;
            const destination = getAudioDestination(ctx);
            if (!destination) return;
            const duration = 0.16;
            const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
            const channel = buffer.getChannelData(0);
            for (let index = 0; index < channel.length; index += 1) {
                channel[index] = (Math.random() * 2 - 1) * (1 - index / channel.length);
            }
            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            gain.gain.value = 0.14;
            source.buffer = buffer;
            source.connect(gain).connect(destination);
            source.start();
        } catch (_error) { /* sound is best-effort */ }
    }

    function playImpactSound(force, kind) {
        try {
            const ctx = ensureGtaAudioContext();
            if (!ctx) return;
            const destination = getAudioDestination(ctx);
            if (!destination) return;
            const gain = ctx.createGain();
            const oscillator = ctx.createOscillator();
            const severity = Math.max(0, Math.min(1, force / GTA_IMPACT.severeForceN));
            oscillator.type = kind === 'vehicle' ? 'sawtooth' : 'triangle';
            oscillator.frequency.setValueAtTime(95 + severity * 55, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.13);
            gain.gain.setValueAtTime(0.02 + severity * 0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
            oscillator.connect(gain).connect(destination);
            oscillator.start();
            oscillator.stop(ctx.currentTime + 0.17);
        } catch (_error) { /* collision feedback is best-effort */ }
    }

    function spawnImpactSparks(spec, force) {
        const count = impactBandForForce(force) === 'severe' ? 5 : 3;
        while (debris.length + count > GTA_PHYSICS.maxDebris && debris.length > 0) {
            debrisCapacityHits += 1;
            releaseDebrisItem(debris.shift());
        }
        for (let index = 0; index < count; index += 1) {
            const { mesh, poolKey } = acquireDebrisMesh('spark');
            mesh.scale.set(0.035, 0.035, 0.16);
            const pose = currentVehiclePose();
            mesh.position.set(
                pose?.x ?? spec.x,
                (pose?.y ?? spec.y) + 0.5,
                pose?.z ?? spec.z,
            );
            debrisGroup.add(mesh);
            debris.push({
                mesh,
                poolKey,
                age: 0,
                ttl: 0.55 + Math.random() * 0.35,
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 8,
                    2 + Math.random() * 4,
                    (Math.random() - 0.5) * 8,
                ),
            });
        }
    }

    function registerImpact(spec, force, { sound = true } = {}) {
        const band = impactBandForForce(force);
        if (band === 'none') return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        lastPlayerImpact = {
            id: spec.id,
            kind: spec.kind,
            forceN: force,
            atMs: now,
            x: finiteOrNull(spec.x),
            y: finiteOrNull(spec.y),
            z: finiteOrNull(spec.z),
        };
        const lastForObstacle = lastImpactById.get(spec.id) ?? -Infinity;
        if (now - lastForObstacle < GTA_IMPACT.perObstacleCooldownMs) return;
        playerImpactHistory.push({ ...lastPlayerImpact });
        if (playerImpactHistory.length > 16) playerImpactHistory.shift();
        lastImpactById.delete(spec.id);
        lastImpactById.set(spec.id, now);
        while (lastImpactById.size > 256) {
            lastImpactById.delete(lastImpactById.keys().next().value);
        }
        if (sound && now - lastImpactSoundAt >= GTA_IMPACT.soundCooldownMs) {
            lastImpactSoundAt = now;
            playImpactSound(force, spec.kind);
        }
        impactShake = Math.max(
            impactShake,
            band === 'severe' ? 0.32 : band === 'medium' ? 0.2 : 0.08,
        );
        if (band === 'medium' || band === 'severe') {
            const damage = vehicleDamageForImpact(force);
            if (damage > 0) secondsSinceVehicleDamage = 0;
            vehicleHealth = Math.max(0, vehicleHealth - damage);
            spawnImpactSparks(spec, force);
            if (spec.kind === 'vehicle') cabVoice.playGtaCollisionLine?.(band);
        }
    }

    function spawnDebris(spec) {
        const spawnCount = 4;
        while (debris.length + spawnCount > GTA_PHYSICS.maxDebris && debris.length > 0) {
            debrisCapacityHits += 1;
            releaseDebrisItem(debris.shift());
        }
        for (let index = 0; index < spawnCount; index += 1) {
            const { mesh, poolKey } = acquireDebrisMesh(spec.kind);
            mesh.scale.set(
                0.12 + Math.random() * 0.16,
                0.12 + Math.random() * 0.25,
                0.12 + Math.random() * 0.16,
            );
            mesh.position.set(spec.x, spec.y, spec.z);
            debrisGroup.add(mesh);
            debris.push({
                mesh,
                poolKey,
                age: 0,
                ttl: GTA_PHYSICS.debrisTtlSeconds,
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 7,
                    3 + Math.random() * 5,
                    (Math.random() - 0.5) * 7,
                ),
            });
        }
        playBreakSound();
    }

    function destroyBreakable(spec) {
        const destroyed = spec.kind === 'lamp'
            ? destroyStreetFurniture(spec.id)
            : destroyDecorProp(spec.id);
        if (!destroyed) return;
        removeFixedBody(spec.id);
        fixedBuildQueue = fixedBuildQueue.filter(candidate => candidate.id !== spec.id);
        fixedRetireQueue = fixedRetireQueue.filter(id => id !== spec.id);
        fixedRetireIds.delete(spec.id);
        spawnDebris(spec);
    }

    function drainContactEvents() {
        if (!eventQueue || !RAPIER) return false;
        let playerContact = false;
        eventQueue.drainContactForceEvents(event => {
            contactEventCount += 1;
            const force = Number(event.totalForceMagnitude?.()) || 0;
            const firstHandle = event.collider1?.();
            const secondHandle = event.collider2?.();
            const first = colliderMetadata.get(firstHandle);
            const second = colliderMetadata.get(secondHandle);
            const playerInvolved = collisionInvolvesHandle(
                firstHandle,
                secondHandle,
                chassisCollider?.handle,
            );
            if (playerInvolved) playerContact = true;
            const handled = new Set();
            for (const spec of [first, second]) {
                if (!spec || handled.has(spec.id)) continue;
                handled.add(spec.id);
                const trafficEntry = trafficBodies.get(spec.id);
                if (trafficEntry) trafficEntry.lastContactStep = physicsStepCount;
                impactEventCount += 1;
                if (spec.destructive && force >= spec.forceThresholdN) {
                    if (playerInvolved) registerImpact(spec, force, { sound: false });
                    destroyBreakable(spec);
                } else if (playerInvolved) {
                    registerImpact(spec, force);
                }
            }
        });
        return playerContact;
    }

    function fixedPhysicsStep(dt) {
        if (!currentVehiclePose()) return;
        const stepStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const controlState = applyVehicleControls(dt);
        applyDynamicTrafficGuidance(dt);
        const validTranslation = { ...chassisBody.translation() };
        const validRotation = { ...chassisBody.rotation() };
        world.timestep = dt;
        world.step(eventQueue);
        recoverDynamicTrafficFromSurfaces();
        const surfaceRecovery = recoverControlledVehicleFromSurface();
        let steppedPose = currentVehiclePose();
        if (restoreUnsupportedVehicleEscape(steppedPose, surfaceRecovery)) {
            steppedPose = currentVehiclePose();
        } else {
            captureSupportedCheckpoint(steppedPose, surfaceRecovery);
        }
        updateTireEffects(controlState?.command, steppedPose);
        const insideWorld = typeof window === 'undefined'
            || worldProviderContains(steppedPose?.lat, steppedPose?.lon);
        if (!insideWorld) {
            chassisBody.setTranslation(validTranslation, true);
            chassisBody.setRotation(validRotation, true);
            chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
            const now = performance.now();
            if (now - lastBoundaryToastMs > 2200) {
                lastBoundaryToastMs = now;
                toast('gta.countryBoundary');
            }
        }
        syncDynamicTrafficMeshes();
        const playerContact = drainContactEvents();
        const velocity = chassisBody.linvel();
        if (shouldApplyStoppedVehicleHold({
            stop: stopRequested,
            playerContact,
            planarSpeedMps: Math.hypot(velocity.x, velocity.z),
        }, controlled?.tuning || GTA_VEHICLE_TUNING)) {
            chassisBody.setLinvel({ x: 0, y: velocity.y, z: 0 }, true);
            chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        lastPhysicsStepMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - stepStartedAt;
        maxPhysicsStepMs = Math.max(maxPhysicsStepMs, lastPhysicsStepMs);
        physicsStepCount += 1;
    }

    function updateDebris(dt) {
        impactShake = Math.max(0, impactShake - dt * 1.8);
        for (let index = debris.length - 1; index >= 0; index -= 1) {
            const item = debris[index];
            item.age += dt;
            item.velocity.y -= 9.81 * dt;
            item.mesh.position.addScaledVector(item.velocity, dt);
            item.mesh.rotation.x += dt * 4;
            item.mesh.rotation.z += dt * 3;
            if (item.age >= (item.ttl || GTA_PHYSICS.debrisTtlSeconds)) {
                debris.splice(index, 1);
                releaseDebrisItem(item);
            }
        }
    }

    function blockedExitCandidate(candidate, candidateFeetY = null) {
        const feetY = finiteOrNull(candidateFeetY)
            ?? supportY(candidate.x, candidate.z, currentVehiclePose()?.y ?? 0);
        if (!Number.isFinite(feetY)) return true;
        const footprints = buildingFootprintsProvider(candidate.x, candidate.z, 5, {
            minY: feetY + 0.15,
            maxY: feetY + 1.8,
        });
        if (entryPathCrossesFootprints(candidate, candidate, footprints, 0.55)) return true;
        const civil = getWalkColliderBoxesNear(candidate.x, candidate.z, 0.6, 16);
        if (civil.some(box => box.distanceSq <= 0.55 ** 2
            && box.maxY > feetY + 0.15
            && box.minY < feetY + 1.8)) return true;
        const traffic = getTrafficObstaclesNear(candidate.x, candidate.z, 3.5, controlled?.id);
        if (traffic.some(vehicle => Math.hypot(vehicle.x - candidate.x, vehicle.z - candidate.z) < 2.4)) return true;
        const furniture = [
            ...getBreakableStreetFurnitureNear(candidate.x, candidate.z, 2),
            ...getDecorObstaclesNear(candidate.x, candidate.z, 2),
        ];
        return furniture.some(obstacle => Math.hypot(obstacle.x - candidate.x, obstacle.z - candidate.z) < obstacle.radiusM + 0.5);
    }

    function resolveEntryCandidate(local, { cached = false } = {}) {
        const x = Number(local?.x);
        const z = Number(local?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
        const probeNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (cached && entryProbe
            && probeNow - entryProbe.at < ENTRY_PROBE_INTERVAL_MS
            && Math.hypot(x - entryProbe.x, z - entryProbe.z) < 0.35) {
            return entryProbe.candidate;
        }
        const carCandidate = enabledControllers.has('road')
            ? findEnterableParkedCar(x, z, GTA_PHYSICS.enterDistanceM, {
                allowedIds: allowedRoadVehicleIds,
            })
            : null;
        const specialCandidate = specialVehicles?.findNearest?.(x, z, {
            kinds: [
                ...(enabledControllers.has('boat') ? ['boat'] : []),
                ...(enabledControllers.has('aircraft') ? ['airplane'] : []),
            ],
        }) || null;
        const candidate = [carCandidate, specialCandidate]
            .filter(candidate => candidate && vehicleKindEnabled(candidate.kind))
            .sort((left, right) => (
                (finiteOrNull(left.distanceM) ?? Infinity)
                    - (finiteOrNull(right.distanceM) ?? Infinity)
            ))[0] || null;
        if (!candidate) {
            entryProbe = { x, z, at: probeNow, candidate: null };
            return null;
        }
        const middleX = (x + candidate.x) * 0.5;
        const middleZ = (z + candidate.z) * 0.5;
        const queryRadius = GTA_PHYSICS.enterDistanceM + 2;
        const feetY = finiteOrNull(local?.y) ?? supportY(x, z, 0);
        if (!Number.isFinite(feetY)) {
            const unresolved = { ...candidate, reachable: false };
            entryProbe = { x, z, at: probeNow, candidate: unresolved };
            return unresolved;
        }
        const footprints = buildingFootprintsProvider(middleX, middleZ, queryRadius, {
            minY: feetY + 0.15,
            maxY: feetY + 1.8,
        });
        const obstacles = [
            ...getTrafficObstaclesNear(middleX, middleZ, queryRadius, candidate.id),
            ...getBreakableStreetFurnitureNear(middleX, middleZ, queryRadius),
            ...getDecorObstaclesNear(middleX, middleZ, queryRadius),
        ];
        const civil = getWalkColliderBoxesNear(middleX, middleZ, queryRadius, 48)
            .filter(box => box.maxY > feetY + 0.15 && box.minY < feetY + 1.8);
        const reachable = !entryPathCrossesFootprints(
            { x, z },
            candidate,
            footprints,
        ) && !entryPathCrossesColliderBoxes(
            { x, z },
            candidate,
            civil,
        ) && !entryPathCrossesObstacles(
            { x, z },
            candidate,
            obstacles,
        );
        const resolved = { ...candidate, reachable };
        entryProbe = { x, z, at: probeNow, candidate: resolved };
        return resolved;
    }

    function requestEntryCandidate(local, expectedId = null, { allowUnreachable = false } = {}) {
        if (!ready) {
            toast(initializationError ? 'gta.physicsFailed' : 'gta.physicsLoading');
            return null;
        }
        const candidate = resolveEntryCandidate(local);
        if (!candidate || (expectedId != null && String(candidate.id) !== String(expectedId))) {
            toast('gta.noCarNearby');
            return null;
        }
        const controllerId = controllerKindForVehicle(candidate.kind);
        if (!enabledControllers.has(controllerId)) return null;
        if (!candidate.parked || !requestBoarding(occupant, {
            ...candidate,
            reachable: allowUnreachable ? true : candidate.reachable,
            providerId: GTA_VEHICLE_PROVIDER_ID,
            controllerId,
        })) {
            toast(candidate.reachable === false ? 'gta.carBlocked' : 'gta.carUnavailable');
            return null;
        }
        return { ...candidate, controllerId };
    }

    function claimEntryCandidate(candidate) {
        if (!candidate || occupant.state !== OCCUPANT_STATES.BOARDING_REQUESTED
            || occupant.providerId !== GTA_VEHICLE_PROVIDER_ID
            || occupant.vehicleId !== String(candidate.id)) return null;
        const controllerId = candidate.controllerId || controllerKindForVehicle(candidate.kind);
        if (!enabledControllers.has(controllerId)) {
            cancelOccupantTransition(occupant);
            return false;
        }
        const isSpecial = candidate.kind === 'boat' || candidate.kind === 'airplane';
        const vehicle = isSpecial
            ? specialVehicles?.claim?.(candidate.id)
            : claimParkedCar(candidate.id);
        if (!vehicle) {
            cancelOccupantTransition(occupant);
            toast('gta.carUnavailable');
            return false;
        }
        try {
            const created = isSpecial
                ? createControlledSpecialVehicle(vehicle)
                : createControlledVehicle(vehicle);
            if (created === false) throw new Error('terrain support is not ready');
        } catch (error) {
            console.error('[gta] vehicle creation failed', error);
            removeControlledPhysics();
            controlled = null;
            specialVehicleState = null;
            if (isSpecial) specialVehicles?.release?.(vehicle.id);
            else releaseControlledParkedCar(vehicle.id);
            cancelOccupantTransition(occupant);
            toast('gta.physicsFailed');
            return null;
        }
        completeBoarding(occupant, {
            id: candidate.id,
            providerId: GTA_VEHICLE_PROVIDER_ID,
            controllerId,
        });
        controls.clear();
        // Nothing about the previous vehicle's travel applies to this one.
        groundMotion.reset();
        pendingExitWalkState = null;
        // Ordinary parked cars enter with their parking/service hold latched;
        // a fresh W/S press releases it. Boats and aircraft have their own
        // zero-input dynamics and must not inherit the road-car Stop latch.
        stopRequested = !isSpecial;
        entryProbe = null;
        exitPreview.reset();
        toast(controlled?.kind === 'airplane' ? 'gta.enteredAirplane'
            : controlled?.kind === 'boat' ? 'gta.enteredBoat'
                : 'gta.enteredCar');
        return { id: candidate.id, controllerId, kind: candidate.kind || 'road' };
    }

    function tryEnter(local) {
        const candidate = requestEntryCandidate(local);
        return !!claimEntryCandidate(candidate);
    }

    function requestStop() {
        if (!isGtaControlling()) return false;
        // Keep this latched until a fresh throttle/reverse press. A held key
        // may continue producing browser repeat events, so the input handler
        // only releases the latch when that key was not already held.
        stopRequested = true;
        toast('gta.stopping');
        return true;
    }

    function* evaluatedExitCandidates(pose, { expanded = false } = {}) {
        // A car has doors, so its three door/rear points are the only honest
        // places to step out. A boat does not: you step onto the quay from
        // whichever part of the hull is nearest the stone. Restricting a boat
        // to beam and stern left a silent dead zone at the Split berth, where
        // the quay sits exactly at the beam offset and any approach that was
        // not square to it offered no exit and no reason why.
        const perimeter = expanded || controlled?.kind === 'boat';
        for (const candidate of vehicleExitCandidates({
            x: pose.x,
            z: pose.z,
            heading: pose.heading,
            halfWidthM: controlled.halfWidthM,
            halfLengthM: controlled.halfLengthM,
            expanded: perimeter,
        })) {
            // Open water cannot be a landing. Skip its support and obstacle
            // queries, including while previewing an offshore boat in the HUD.
            // A ditched aircraft is a hull on the water for the same reason.
            if ((controlled.kind === 'boat' || controlled.kind === 'airplane')
                && specialVehicles?.isWaterAt?.(candidate.x, candidate.z)) {
                yield { ...candidate, supported: false, blocked: true };
                continue;
            }
            const y = supportY(candidate.x, candidate.z, pose.y + 3);
            const safeSupport = isVehicleExitSupportHeightSafe(
                pose.y,
                y,
                GTA_PHYSICS.exitMaxSupportDeltaM,
            );
            yield {
                ...candidate,
                y,
                supported: safeSupport,
                blocked: blockedExitCandidate(candidate, y),
                headroom: true,
            };
        }
    }

    // A boat outside the scene's berth has no exit at all, whatever the quay
    // beside it looks like; the preview and E agree on that.
    function boatOutsideBerth(pose) {
        return controlled?.kind === 'boat' && !!pose
            && !boatExitAllowedAt(pose.x, pose.z, boatExitBerth);
    }

    function safeBoatExitTarget(pose = currentVehiclePose()) {
        if (!isGtaControlling() || controlled?.kind !== 'boat' || !pose
            || exitSpeedMps(pose) > GTA_PHYSICS.exitMaxSpeedMps
            || boatOutsideBerth(pose)) return null;
        const exit = selectSafeExitCandidate(evaluatedExitCandidates(pose));
        return exit ? { ...localToGeo(exit.x, exit.z, anchorLon, anchorLat), y: exit.y } : null;
    }

    function beginVehicleExit(pose, { expanded = false } = {}) {
        return beginExit(occupant, {
            speedMps: exitSpeedMps(pose),
            maxSpeedMps: GTA_PHYSICS.exitMaxSpeedMps,
            candidates: boatOutsideBerth(pose) ? [] : evaluatedExitCandidates(pose, { expanded }),
        });
    }

    function resetRoadVehiclePose(pose = currentVehiclePose()) {
        if (!pose || !chassisBody || specialVehicleState || !controlled) return null;
        const road = findNearestTrafficRoadPose(pose.x, pose.z, 180);
        const target = road || {
            x: pose.x,
            // A building roof is valid walking support but never the fallback
            // for uprighting a road vehicle embedded beside that building.
            y: physicsSupportY(pose.x, pose.z, pose.y + 3),
            z: pose.z,
            heading: pose.heading,
        };
        const point = toPhysics(target.x, target.z);
        const targetGround = finiteOrNull(target.y);
        const ground = targetGround ?? physicsSupportY(target.x, target.z, pose.y + 3);
        if (!Number.isFinite(ground)) return null;
        chassisBody.setTranslation({
            x: point.x,
            y: ground + (controlled.visualCenterY || CHASSIS_VISUAL_CENTER_Y_M),
            z: point.z,
        }, true);
        chassisBody.setRotation(yawQuaternion(target.heading), true);
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        fixedStep.reset();
        steering = 0;
        controls.clear();
        stopRequested = false;
        pendingExitWalkState = null;
        lastPose = currentVehiclePose();
        supportedCheckpoint = checkpointFromBody(lastPose);
        if (lastPose) syncControlledParkedCar(controlled.id, lastPose);
        return {
            pose: lastPose,
            toastKey: road ? 'gta.resetToRoad' : 'gta.resetUpright',
        };
    }

    // Leaving an aircraft in flight is a parachute jump: the walker drops out
    // at the aircraft's height under a canopy and the aircraft glides on by
    // itself, engine dead, until it comes down somewhere.
    // `target` (lat/lon/y/yaw in the walker's frame) puts the canopy where the
    // story says instead of where the aircraft is: the Vis arrival cuts from
    // the jump to a descent over the harbour.
    function bailOut(walkState, pose, target = null) {
        if (!walkState) {
            toast('gta.noSafeExit');
            return false;
        }
        const abandoned = specialVehicleState;
        failAircraftEngine(abandoned);
        specialVehicles?.release?.(controlled.id, gtaSpecialVehiclePose(abandoned), {
            autonomous: abandoned,
        });
        removeControlledPhysics();
        groundMotion.reset();
        controlled = null;
        specialVehicleState = null;
        beginWalkParachute(walkState, target ? {
            lat: target.lat,
            lon: target.lon,
            y: target.y,
            yaw: target.yaw,
            initialVerticalVelocity: -2,
        } : {
            lat: pose.lat,
            lon: pose.lon,
            y: pose.y - 1.4,
            yaw: Math.PI - pose.heading,
            initialVerticalVelocity: Math.min(-2, Number(pose.verticalSpeedMps) || 0),
        });
        lastPose = null;
        forceOccupantOnFoot(occupant);
        controls.clear();
        stopRequested = false;
        pendingExitWalkState = null;
        entryProbe = null;
        exitPreview.reset();
        toast('gta.bailedOut');
        return true;
    }

    function tryExit(walkState) {
        let pose = currentVehiclePose();
        if (!pose || !controlled) return false;
        if (controlled.kind === 'airplane' && pose.grounded === false) {
            return bailOut(walkState, pose);
        }
        const overturned = controlled.kind === 'road'
            && vehicleUprightY(pose.quaternion) < GTA_VEHICLE_TUNING.checkpointMinUprightY;
        let recoveredForExit = false;
        if (shouldRecoverOverturnedVehicleExit({
            rotation: pose.quaternion,
            speedMps: exitSpeedMps(pose),
            maximumSpeedMps: GTA_PHYSICS.exitMaxSpeedMps,
            vehicleKind: controlled.kind,
        })) {
            const recovery = resetRoadVehiclePose(pose);
            if (recovery?.pose) {
                pose = recovery.pose;
                recoveredForExit = true;
            }
        }
        let exit = beginVehicleExit(pose, {
            expanded: overturned || recoveredForExit,
        });
        if (!exit && shouldRecoverBlockedVehicleExit({
            failure: occupant.lastFailure,
            speedMps: exitSpeedMps(pose),
            maximumSpeedMps: GTA_PHYSICS.exitMaxSpeedMps,
            vehicleKind: controlled.kind,
        })) {
            const recovery = resetRoadVehiclePose(pose);
            if (recovery?.pose) {
                pose = recovery.pose;
                recoveredForExit = true;
                exit = beginVehicleExit(pose, { expanded: true });
            }
        }
        if (!exit) {
            if (occupant.lastFailure === 'vehicle-moving') {
                pendingExitWalkState = walkState || null;
                requestStop();
                toast('gta.stoppingToExit');
                return true;
            }
        }
        if (!exit) {
            toast(boatOutsideBerth(pose) ? 'gta.boatBerthPrompt' : 'gta.noSafeExit');
            return false;
        }
        const wasSpecial = controlled.kind === 'boat' || controlled.kind === 'airplane';
        if (wasSpecial) specialVehicles?.release?.(controlled.id, pose);
        else releaseControlledParkedCar(controlled.id, pose);
        removeControlledPhysics();
        groundMotion.reset();
        controlled = null;
        specialVehicleState = null;
        if (walkState) placeWalkerAtVehicleExit(walkState, {
            ...localToGeo(exit.x, exit.z, anchorLon, anchorLat),
            y: exit.y, heading: pose.heading,
        });
        lastPose = null;
        completeExit(occupant);
        controls.clear();
        stopRequested = false;
        pendingExitWalkState = null;
        entryProbe = null;
        exitPreview.reset();
        // The generic "on foot" coaching is redundant while the boarding
        // prompt for the vehicle just left is already on screen.
        if (recoveredForExit) toast('gta.recoveredExit');
        else if (!resolveEntryCandidate({ x: exit.x, z: exit.z }, { cached: true })?.reachable) toast('gta.exitedCar');
        return true;
    }

    // Recovery in the live world uses the same supported, unobstructed exit
    // candidates as an ordinary exit. A checkpoint relocation omits walkState
    // because its caller supplies the new supported pose immediately after.
    function abandonVehicle(walkState = null) {
        if (!controlled) return false;
        const pose = currentVehiclePose();
        const exit = walkState && pose
            ? selectSafeExitCandidate(evaluatedExitCandidates(pose, { expanded: true }))
            : null;
        if (walkState && !exit) return false;
        if (walkState) placeWalkerAtVehicleExit(walkState, {
            ...localToGeo(exit.x, exit.z, anchorLon, anchorLat),
            y: exit.y, heading: pose.heading,
        });
        const wasSpecial = controlled.kind === 'boat' || controlled.kind === 'airplane';
        if (wasSpecial) specialVehicles?.release?.(controlled.id, pose || undefined);
        else releaseControlledParkedCar(controlled.id, pose || {});
        removeControlledPhysics();
        groundMotion.reset();
        controlled = null;
        specialVehicleState = null;
        // The normal exit's completion step only acts on an occupant that
        // beginExit() put into the exiting state; this path skips that step.
        lastPose = null;
        forceOccupantOnFoot(occupant);
        controls.clear();
        stopRequested = false;
        pendingExitWalkState = null;
        entryProbe = null;
        exitPreview.reset();
        return true;
    }

    function completePendingExitIfStopped(pose) {
        if (!pendingExitWalkState || !pose) return false;
        if (exitSpeedMps(pose) > GTA_PHYSICS.exitMaxSpeedMps) return false;
        const walkState = pendingExitWalkState;
        pendingExitWalkState = null;
        const exited = tryExit(walkState);
        if (!exited || isGtaControlling()) return false;
        try {
            onAutomaticExit();
        } catch (error) {
            console.warn('[gta] automatic exit callback failed', error);
        }
        return true;
    }

    function resetVehicleToRoad() {
        const pose = currentVehiclePose();
        if (!pose) return false;
        if (specialVehicleState && controlled) {
            const providerSpawn = specialVehicles?.resetPose?.(controlled.id);
            if (providerSpawn) specialVehicleState.spawn = { ...providerSpawn };
            resetGtaSpecialVehicleState(specialVehicleState);
            controls.clear();
            stopRequested = false;
            pendingExitWalkState = null;
            lastPose = currentVehiclePose();
            specialVehicles?.sync?.(controlled.id, lastPose);
            toast('gta.resetUpright');
            return true;
        }
        const recovery = resetRoadVehiclePose(pose);
        if (!recovery) return false;
        toast(recovery.toastKey);
        return true;
    }

    function cycleCamera() {
        if (!isGtaControlling()) return false;
        cameraModeIndex = (cameraModeIndex + 1) % GTA_CAMERA_MODES.length;
        toast(`gta.view.${GTA_CAMERA_MODES[cameraModeIndex]}`);
        return true;
    }

    const vehicleProvider = {
        id: GTA_VEHICLE_PROVIDER_ID,
        findNearest(local) {
            if (!ready || isGtaControlling()) return null;
            const candidate = resolveEntryCandidate(local, { cached: true });
            if (!candidate) return null;
            return {
                ...candidate,
                providerId: GTA_VEHICLE_PROVIDER_ID,
                controllerId: controllerKindForVehicle(candidate.kind),
                available: !!candidate.parked,
            };
        },
        requestBoarding(id, local, policy = {}) {
            return !!requestEntryCandidate(local, id, policy);
        },
        claim(id) {
            if (occupant.vehicleId !== String(id)) return null;
            const candidate = resolveEntryCandidate(entryProbe, { cached: true });
            const pending = candidate && String(candidate.id) === String(id)
                ? {
                    ...candidate,
                    controllerId: occupant.controllerId,
                }
                : null;
            return claimEntryCandidate(pending);
        },
        sync(id) {
            return isGtaControlling() && String(controlled?.id) === String(id);
        },
        release(id, _pose, policy = {}) {
            if (!isGtaControlling() || String(controlled?.id) !== String(id)) return false;
            return tryExit(policy.walkState);
        },
        cancelReservation(id) {
            if (occupant.state !== OCCUPANT_STATES.BOARDING_REQUESTED
                || occupant.providerId !== GTA_VEHICLE_PROVIDER_ID
                || occupant.vehicleId !== String(id)) return false;
            return cancelOccupantTransition(occupant);
        },
    };

    return {
        initializePromise,
        occupant,
        vehicleProvider,
        isReady: () => ready,
        isDriving: isGtaControlling,
        captureGroundPublicationRegion,
        admitGroundPublicationRegion,
        captureEmptyGroundPublicationRegion,
        getVehicleResumeState: () => {
            const current = currentVehiclePose();
            return current ? { ...current, special: specialVehicleState ? { ...specialVehicleState } : null,
                velocity: chassisBody ? { ...chassisBody.linvel() } : null,
                angularVelocity: chassisBody ? { ...chassisBody.angvel() } : null, cameraModeIndex } : null;
        },
        restoreVehicleMotion(snapshot) {
            if (!snapshot || snapshot.id !== controlled?.id) return false;
            if (Number.isFinite(snapshot.health)) vehicleHealth = snapshot.health;
            if (specialVehicleState && snapshot.special) {
                Object.assign(specialVehicleState, snapshot.special);
                // Coordinates belong to the newly opened session anchor.
                const local = geoToLocal(snapshot.lon, snapshot.lat, anchorLon, anchorLat);
                specialVehicleState.x = local.x; specialVehicleState.z = local.z;
            }
            if (chassisBody && snapshot.quaternion) {
                const local = geoToLocal(snapshot.lon, snapshot.lat, anchorLon, anchorLat);
                const offset = rotateVectorByQuaternion(
                    { x: 0, y: -(controlled.visualCenterY || CHASSIS_VISUAL_CENTER_Y_M), z: 0 },
                    snapshot.quaternion,
                );
                const point = toPhysics(local.x - offset.x, local.z - offset.z);
                chassisBody.setTranslation({ x: point.x, y: snapshot.y - offset.y, z: point.z }, true);
                chassisBody.setRotation(snapshot.quaternion, true);
            }
            if (chassisBody && snapshot.velocity) chassisBody.setLinvel(snapshot.velocity, true);
            if (chassisBody && snapshot.angularVelocity) chassisBody.setAngvel(snapshot.angularVelocity, true);
            if (Number.isInteger(snapshot.cameraModeIndex)) cameraModeIndex = snapshot.cameraModeIndex;
            lastPose = currentVehiclePose();
            if (specialVehicleState) specialVehicles?.sync?.(controlled.id, lastPose);
            else if (lastPose) syncControlledParkedCar(controlled.id, lastPose);
            return true;
        },
        getControllerKind: () => controlled
            ? controllerKindForVehicle(controlled.kind)
            : null,
        clearControls() {
            controls.clear();
            steering = 0;
        },
        handleKeyDown(key, { repeat = false } = {}) {
            const airplaneThrottleKey = controlled?.kind === 'airplane'
                && specialVehicleState
                && applyAirplaneThrottleKeyDown(specialVehicleState, key, { repeat });
            if (airplaneThrottleKey && key === 'q') {
                return isGtaControlling();
            }
            if (['w', 'a', 's', 'd', 'b', 'x', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright', ' '].includes(key)) {
                // A physical non-repeat throttle press is authoritative even
                // if the preceding key-up was lost and `controls` went stale.
                // Auto-repeat must not defeat a Stop pressed while W is held.
                if (shouldReleaseLatchedStopOnKeyDown(key, { repeat })) {
                    stopRequested = false;
                    pendingExitWalkState = null;
                }
                controls.add(key);
                return isGtaControlling();
            }
            return false;
        },
        handleKeyUp(key) {
            controls.delete(key);
            return isGtaControlling();
        },
        requestStop,
        toggleVehicle({ local, walkState } = {}) {
            return isGtaControlling()
                ? tryExit(walkState)
                : tryEnter(local);
        },
        resetVehicle: resetVehicleToRoad,
        abandonVehicle,
        // The story's own jump: leave the flown aircraft for a canopy opening
        // at an authored spot (the Vis arrival). False when nothing is flown.
        bailOutAt(walkState, target) {
            const pose = currentVehiclePose();
            if (!pose || !controlled || controlled.kind !== 'airplane') return false;
            return bailOut(walkState, pose, target);
        },
        // An authored mechanical failure. The flown aircraft loses its engine
        // in place; any other named aircraft is marked by the world layer.
        failVehicle({ vehicleId = null, failure = 'engine' } = {}) {
            if (failure !== 'engine') return false;
            const id = vehicleId == null ? null : String(vehicleId);
            if (specialVehicleState && controlled && (id === null || id === String(controlled.id))) {
                if (!failAircraftEngine(specialVehicleState)) return false;
                lastPose = currentVehiclePose();
                specialVehicles?.sync?.(controlled.id, lastPose);
                specialVehicleAudio.update(lastPose);
                toast('gta.engineFailure');
                return true;
            }
            return id !== null && specialVehicles?.failEngine?.(id) === true;
        },
        // The story is done with a named aircraft nobody is flying (the hull
        // the film just sank): the world layer removes it for good.
        retireVehicle({ vehicleId = null } = {}) {
            const id = vehicleId == null ? null : String(vehicleId);
            if (id === null) return false;
            if (controlled && String(controlled.id) === id) return false;
            return specialVehicles?.retire?.(id) === true;
        },
        cycleCamera,
        getInteractionState(local) {
            if (isGtaControlling()) {
                const pose = currentVehiclePose();
                const speedMps = exitSpeedMps(pose);
                if (controlled.kind === 'boat' && boatOutsideBerth(pose)
                    && speedMps <= GTA_PHYSICS.exitMaxSpeedMps) {
                    return { key: 'gta.boatBerthPrompt', available: false, exitTarget: null };
                }
                if (controlled.kind === 'boat') return exitPreview.read({
                    vehicleId: controlled.id, pose, speedMps,
                    maxSpeedMps: GTA_PHYSICS.exitMaxSpeedMps,
                    nowMs: performance.now(), resolve: () => safeBoatExitTarget(pose),
                });
                // In the air, E is the parachute, whatever the speed.
                if (controlled.kind === 'airplane' && pose?.grounded === false) {
                    return { key: 'gta.bailOutPrompt', available: true };
                }
                return {
                    key: speedMps <= GTA_PHYSICS.exitMaxSpeedMps
                        ? 'gta.exitPrompt'
                        : 'gta.stopToExitPrompt',
                    available: speedMps <= GTA_PHYSICS.exitMaxSpeedMps,
                };
            }
            if (!ready) return null;
            const candidate = resolveEntryCandidate(local, { cached: true });
            if (!candidate) return null;
            return {
                key: candidate.reachable ? 'gta.enterPrompt' : 'gta.entryBlockedPrompt',
                available: candidate.reachable,
                vehicleId: candidate.id,
                vehicleKind: candidate.kind || 'road',
                distanceM: candidate.distanceM,
                label: candidate.label || null,
            };
        },
        backgroundStep(dt) {
            if (!isGtaControlling()) updateDebris(Math.max(0, Number(dt) || 0));
        },
        step(dt) {
            const frameDt = Math.max(0, Number(dt) || 0);
            updateDebris(frameDt);
            secondsSinceVehicleDamage += frameDt;
            vehicleHealth = repairedVehicleHealth(
                vehicleHealth,
                secondsSinceVehicleDamage,
                frameDt,
            );
            if (!ready || !isGtaControlling()) return null;
            // A held frame (pause, streaming hold) advances nothing. Restart
            // the displacement window so a vehicle frozen by the world is not
            // mistaken for one wedged against it: six held seconds of an
            // unchanged pose used to read as a stuck vehicle.
            if (frameDt <= 0) groundMotion.reset();
            if (specialVehicleState && controlled) {
                const previous = { ...specialVehicleState };
                const input = specialVehicleInputForKeys(controls, {
                    stop: stopRequested,
                    kind: controlled.kind,
                });
                stepGtaSpecialVehicle(specialVehicleState, input, frameDt, {
                    isWaterAt: specialVehicles?.isWaterAt,
                    waterYAt: specialVehicles?.waterYAt,
                    isRunwayAt: specialVehicles?.isRunwayAt,
                    groundYAt: specialVehicles?.groundYAt,
                });
                let pose = currentVehiclePose();
                const insideWorld = typeof window === 'undefined'
                    || worldProviderContains(pose?.lat, pose?.lon);
                if (!insideWorld) {
                    Object.assign(specialVehicleState, previous, { speedMps: 0 });
                    pose = currentVehiclePose();
                    const now = performance.now();
                    if (now - lastBoundaryToastMs > 2200) {
                        lastBoundaryToastMs = now;
                        toast('gta.countryBoundary');
                    }
                }
                lastPose = pose;
                recordGroundMotion(pose);
                specialVehicles?.sync?.(controlled.id, pose);
                specialVehicleAudio.update(pose);
                return completePendingExitIfStopped(pose) ? null : pose;
            }
            if (!chassisBody) return null;
            const beforeStep = currentVehiclePose();
            if (!beforeStep) return null;
            // Keep the complete prior pose while the terrain window catches up.
            // Structural/rendered road support may satisfy this independently;
            // ordinary ground never advances on the visual fallback datum.
            if (!Number.isFinite(physicsSupportY(
                beforeStep.x,
                beforeStep.z,
                beforeStep.y + 3,
            ))) return holdRoadVehicleForSurface(beforeStep);
            maybeRebase(beforeStep.x, beforeStep.z);
            colliderContentRefreshElapsed += frameDt;
            const terrainNow = terrainReference();
            const terrainRevision = Number(terrainNow?.revision) || 0;
            const terrainChanged = terrainNow !== lastTerrainReference
                || terrainRevision !== lastTerrainRevision;
            const roadFormationNow = roadFormationReference();
            const roadFormationRevision = Number(roadFormationNow?.revision) || 0;
            const roadFormationReferenceChanged = roadFormationNow
                !== lastRoadFormationReference;
            const roadFormationRevisionChanged = roadFormationRevision
                !== lastRoadFormationRevision;
            const roadFormationPending = roadFormationNow?.hasPendingBuild?.() === true;
            let roadFormationChanged = (roadFormationReferenceChanged
                || roadFormationRevisionChanged) && !roadFormationPending;
            if (roadFormationChanged && !roadFormationReferenceChanged
                && typeof roadFormationNow?.getChangesSince === 'function') {
                roadFormationChanged = colliderBubbleTouchesChanges(
                    roadFormationNow.getChangesSince(lastRoadFormationRevision),
                    beforeStep,
                    GTA_PHYSICS.colliderRetireRadiusM,
                );
                // A remote publication cannot affect the current bubble. Mark
                // it observed; movement still rebuilds the complete bubble
                // before the car can reach that tile.
                if (!roadFormationChanged) {
                    lastRoadFormationReference = roadFormationNow;
                    lastRoadFormationRevision = roadFormationRevision;
                }
            }
            const roadVerticalAlignmentNow = roadVerticalAlignmentReference();
            const roadVerticalAlignmentRevision = Number(
                roadVerticalAlignmentNow?.revision,
            ) || 0;
            const roadVerticalAlignmentReferenceChanged = roadVerticalAlignmentNow
                !== lastRoadVerticalAlignmentReference;
            let roadVerticalAlignmentChanged = roadVerticalAlignmentReferenceChanged
                || roadVerticalAlignmentRevision !== lastRoadVerticalAlignmentRevision;
            if (roadVerticalAlignmentChanged && !roadVerticalAlignmentReferenceChanged
                && typeof roadVerticalAlignmentNow?.getChangesSince === 'function') {
                roadVerticalAlignmentChanged = colliderBubbleTouchesChanges(
                    roadVerticalAlignmentNow.getChangesSince(
                        lastRoadVerticalAlignmentRevision,
                    ),
                    beforeStep,
                    GTA_PHYSICS.colliderRetireRadiusM,
                );
                if (!roadVerticalAlignmentChanged) {
                    lastRoadVerticalAlignmentReference = roadVerticalAlignmentNow;
                    lastRoadVerticalAlignmentRevision = roadVerticalAlignmentRevision;
                }
            }
            const renderedRoadSurfaceRevisionNow = Number(
                typeof renderedRoadSurfaceRevision === 'function'
                    ? renderedRoadSurfaceRevision(
                        beforeStep.x,
                        beforeStep.z,
                        GTA_PHYSICS.roadSurfaceColliderRadiusM,
                    ) : 0,
            ) || 0;
            const renderedRoadSurfaceChanged = renderedRoadSurfaceRevisionNow
                !== lastRenderedRoadSurfaceRevision;
            const railFormationNow = terrainNow?.railFormation || null;
            const railFormationRevision = Number(railFormationNow?.revision) || 0;
            const railFormationChanged = railFormationNow !== lastRailFormationReference
                || railFormationRevision !== lastRailFormationRevision;
            const railTrackbedRevision = Number(
                getSampledRailTrackbedSegments()?.revision,
            ) || 0;
            const railTrackbedChanged = railTrackbedRevision
                !== lastRailTrackbedRevision;
            const curbCollisionRevision = getCurbCollisionRevision();
            const curbCollisionChanged = curbCollisionRevision
                !== lastCurbCollisionRevision;
            const authoredSurfaceNow = authoredSurfaceReference();
            const authoredSurfaceRevision = authoredSurfaceNow.revision;
            const authoredSurfaceChanged = authoredSurfaceNow !== lastAuthoredSurfaceRevisionReference
                || authoredSurfaceRevision !== lastAuthoredSurfaceRevision;
            const moved = colliderBubbleNeedsRefresh(
                colliderCenter,
                beforeStep,
                GTA_PHYSICS.colliderRefreshMoveM,
            );
            // Recentring takes precedence before the vehicle can leave its
            // old coverage. Only consumer preparation retries at the new
            // position; the private civil/receiver generation is retained.
            if (moved) groundPublicationLease?.release();
            const contentDue = colliderContentRefreshElapsed
                >= GTA_PHYSICS.colliderContentRefreshSeconds
                && fixedBuildQueue.length === 0
                && fixedRetireQueue.length === 0;
            // Surface tiles arrive in bursts. Rebuilding the Rapier road set
            // for every individual feature was itself a frame-time bug;
            // coalesce stationary publication changes into the existing two
            // second content refresh. Movement and formation changes still
            // rebuild immediately and consume the latest exact triangles.
            const renderedRoadSurfaceRefreshDue = renderedRoadSurfaceChanged
                && contentDue;
            if (!pendingBubbleBuild && (moved || terrainChanged || roadFormationChanged
                || roadVerticalAlignmentChanged || renderedRoadSurfaceRefreshDue
                || railFormationChanged
                || railTrackbedChanged || contentDue || failedSurfaceRequest)) {
                // Sub-metre driving cannot turn a failed request into a new
                // retry every frame. New source evidence or another refresh
                // cell permits a new attempt; the old complete bubble stays.
                // A coordinated publication may acknowledge those sources
                // after superseding this request. Its remaining obligation
                // still needs the bounded wall-clock retry while dt is zero.
                const inputs = [Math.floor(beforeStep.x / GTA_PHYSICS.colliderRefreshMoveM),
                    Math.floor(beforeStep.z / GTA_PHYSICS.colliderRefreshMoveM), terrainNow, terrainRevision,
                    roadFormationNow, roadFormationRevision, roadVerticalAlignmentNow,
                    roadVerticalAlignmentRevision, renderedRoadSurfaceRevisionNow,
                    railFormationNow, railFormationRevision, railTrackbedRevision, curbCollisionRevision,
                    authoredSurfaceNow, authoredSurfaceRevision];
                const atMs = monotonicNowMs();
                if (fixedSurfaceRetryReady(failedSurfaceRequest, inputs, atMs,
                    GTA_PHYSICS.colliderContentRefreshSeconds * 1000)) scheduleFixedBubble(
                    beforeStep.x,
                    beforeStep.z,
                    beforeStep.y,
                    {
                        rebuildTerrain: moved || terrainChanged || roadFormationChanged
                            || roadVerticalAlignmentChanged || railFormationChanged,
                        rebuildRoadSurfaces: moved || roadFormationChanged
                            || roadVerticalAlignmentChanged
                            || renderedRoadSurfaceRefreshDue,
                        rebuildRailTrackbed: moved || railTrackbedChanged,
                        rebuildRailFormationDressings: moved || railFormationChanged,
                        rebuildCurbs: moved || (curbCollisionChanged && contentDue),
                        rebuildAuthoredSurfaces: moved || authoredSurfaceChanged,
                    },
                    inputs,
                );
            }
            if (!groundCoverageAllowsStep(beforeStep)) {
                // Private preparation does not stop supported motion. Hold
                // only when the next step would leave committed coverage.
                return holdRoadVehicleForSurface(beforeStep);
            }
            drainFixedBubbleWork();
            syncTraffic(beforeStep.x, beforeStep.z);
            const result = fixedStep.advance(frameDt, fixedPhysicsStep);
            droppedPhysicsSeconds += result.discardedSeconds;
            updateEngineAudio();
            const pose = currentVehiclePose();
            if (!pose) return null;
            lastPose = pose;
            recordGroundMotion(pose);
            syncControlledParkedCar(controlled.id, pose);
            return completePendingExitIfStopped(pose) ? null : pose;
        },
        getPhysicsOrigin: () => ({ ...physicsOrigin }),
        getPose: () => lastPose || currentVehiclePose(),
        // Where a mounted gun sits: the top of whatever is being driven. The
        // vehicle's own dimensions decide it, so a van carries the turret higher
        // than a sedan instead of burying it in the bodywork.
        getWeaponMountPoint() {
            if (!isGtaControlling()) return null;
            const pose = lastPose || currentVehiclePose();
            if (!pose) return null;
            const heightM = finiteOrNull(controlled?.heightM);
            return {
                x: pose.x,
                y: pose.y + (heightM != null && heightM > 0
                    ? heightM
                    : GTA_DEFAULT_VEHICLE_HEIGHT_M),
                z: pose.z,
            };
        },
        getSafeExitTarget: safeBoatExitTarget,
        getGroundSpeedMps: () => groundSpeedMps(),
        getStuckSeconds: () => (isGtaControlling() ? groundMotion.stuckSeconds() : 0),
        getCameraPose() {
            const pose = lastPose || currentVehiclePose();
            if (!pose) return null;
            const forwardX = Math.sin(pose.heading);
            const forwardZ = Math.cos(pose.heading);
            const mode = GTA_CAMERA_MODES[cameraModeIndex];
            let cameraPose;
            if (mode === 'close') {
                cameraPose = {
                    x: pose.x - forwardX * 4.8,
                    y: pose.y + 2.35,
                    z: pose.z - forwardZ * 4.8,
                    lookX: pose.x + forwardX * 10,
                    lookY: pose.y + 1,
                    lookZ: pose.z + forwardZ * 10,
                };
            } else if (mode === 'overhead') {
                cameraPose = {
                    x: pose.x - forwardX * 2,
                    y: pose.y + 15,
                    z: pose.z - forwardZ * 2,
                    lookX: pose.x + forwardX * 7,
                    lookY: pose.y,
                    lookZ: pose.z + forwardZ * 7,
                };
            } else {
                cameraPose = {
                    x: pose.x - forwardX * GTA_CAMERA_BACK_M,
                    y: pose.y + GTA_CAMERA_HEIGHT_M,
                    z: pose.z - forwardZ * GTA_CAMERA_BACK_M,
                    lookX: pose.x + forwardX * GTA_CAMERA_LOOK_AHEAD_M,
                    lookY: pose.y + 1.1,
                    lookZ: pose.z + forwardZ * GTA_CAMERA_LOOK_AHEAD_M,
                };
            }
            if (impactShake > 0) {
                const phase = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.04;
                cameraPose.x += Math.sin(phase * 1.7) * impactShake;
                cameraPose.y += Math.sin(phase * 2.3) * impactShake * 0.55;
                cameraPose.z += Math.cos(phase * 1.9) * impactShake;
            }
            const resolved = resolvePhysicsCameraLineOfSight({
                RAPIER,
                world,
                target: {
                    x: pose.x,
                    y: pose.y + 1.1,
                    z: pose.z,
                },
                desired: cameraPose,
                physicsOrigin,
                collisionGroups: GTA_COLLISION_GROUPS.cameraQuery,
                filterPredicate: (collider) => GTA_CAMERA_OCCLUDER_KINDS.has(
                    colliderMetadata.get(collider.handle)?.kind,
                ),
            });
            cameraPose.x = resolved.x;
            cameraPose.y = resolved.y;
            cameraPose.z = resolved.z;
            if (resolved.occluded) {
                cameraOcclusionCount += 1;
                lastCameraOcclusion = {
                    kind: colliderMetadata.get(resolved.collider?.handle)?.kind || 'world',
                    desiredDistanceM: resolved.desiredDistanceM,
                    resolvedDistanceM: resolved.resolvedDistanceM,
                };
            } else {
                lastCameraOcclusion = null;
            }
            return cameraPose;
        },
        groundPublicationState() {
            return { pending: pendingBubbleBuild || pendingFixedSurfaces ? 1 : 0,
                failed: failedSurfaceRequest ? 1 : 0,
                phase: pendingBubbleBuild?.phase || (pendingFixedSurfaces ? 'source-support' : null),
                attempts: failedSurfaceRequest?.attempts || 0,
                error: failedSurfaceRequest?.error || null };
        },
        debugState() {
            return {
                ready,
                initializationError: initializationError?.message || '',
                occupant: { ...occupant },
                vehicleKind: controlled?.kind || controlled?.type?.name || null,
                specialVehicles: specialVehicles?.debugState?.() || null,
                fixedBodies: fixedColliderResourceCount,
                fixedRigidBodies: fixedBodies.size,
                pendingFixedBuilds: fixedBuildQueue.length,
                pendingFixedRetirements: fixedRetireQueue.length,
                groundPreparation: pendingBubbleBuild ? { phase: pendingBubbleBuild.phase } : null,
                groundPreparationFailure: failedSurfaceRequest ? {
                    attempts: failedSurfaceRequest.attempts, error: failedSurfaceRequest.error,
                } : null,
                trafficBodies: trafficBodies.size,
                promotedTrafficBodies: [...trafficBodies.values()]
                    .filter(entry => entry.mode === 'dynamic').length,
                kinematicTrafficBodies: [...trafficBodies.values()]
                    .filter(entry => entry.mode === 'kinematic').length,
                debris: debris.length,
                debrisPool: [...debrisPools.values()]
                    .reduce((total, pool) => total + pool.length, 0),
                bubbleRevision,
                cameraMode: GTA_CAMERA_MODES[cameraModeIndex],
                cameraOcclusion: {
                    count: cameraOcclusionCount,
                    active: lastCameraOcclusion ? { ...lastCameraOcclusion } : null,
                },
                engineAudio: engineAudio.debugState(),
                specialVehicleAudio: specialVehicleAudio.debugState(),
                tireAudio: tireAudio.debugState(),
                tireEffects: { ...lastTireTargets },
                skidMarks: skidMarks.debugState(),
                vehicleHealth,
                pose: currentVehiclePose(),
                lastPlayerImpact: lastPlayerImpact ? { ...lastPlayerImpact } : null,
                playerImpactHistory: playerImpactHistory.map(impact => ({ ...impact })),
                controls: [...controls],
                stopRequested,
                pendingExit: !!pendingExitWalkState,
                impactShake,
                contactEventCount,
                impactEventCount,
                physicsStepCount,
                lastPhysicsStepMs,
                maxPhysicsStepMs,
                colliderPlanMs: lastBubblePlanMs,
                maxColliderPlanMs: maxBubblePlanMs,
                colliderPlanBreakdown: { ...lastBubblePlanBreakdown },
                maxColliderPlanBreakdown: { ...maxBubblePlanBreakdown },
                colliderDrainMs: lastBubbleDrainMs,
                maxColliderDrainMs: maxBubbleDrainMs,
                entrySafetyActive: !!entrySafetyZone,
                wheelContacts: currentWheelContactCount(),
                surfaceRecovery: {
                    count: surfaceRecoveryCount,
                    totalLiftM: surfaceRecoveryLiftM,
                    last: lastSurfaceRecovery ? { ...lastSurfaceRecovery } : null,
                },
                trafficSurfaceRecovery: {
                    count: trafficSurfaceRecoveryCount,
                    totalLiftM: trafficSurfaceRecoveryLiftM,
                    last: lastTrafficSurfaceRecovery
                        ? { ...lastTrafficSurfaceRecovery } : null,
                },
                escapeRecovery: {
                    count: escapeRecoveryCount,
                    checkpoint: supportedCheckpoint ? {
                        x: supportedCheckpoint.worldX,
                        y: supportedCheckpoint.rootY,
                        z: supportedCheckpoint.worldZ,
                        physicsStep: supportedCheckpoint.physicsStep,
                    } : null,
                    last: lastEscapeRecovery ? { ...lastEscapeRecovery } : null,
                },
                roadSurfaces: { ...roadSurfaceStats },
                formationDressings: { ...formationDressingStats },
                railTrackbed: { ...railTrackbedStats },
                railFormationDressings: { ...railFormationDressingStats },
                curbSurfaces: { ...curbSurfaceStats },
                authoredSurfaces: { ...authoredSurfaceStats },
                capacityHits: {
                    fixed: fixedCapacityHits,
                    traffic: trafficCapacityHits,
                    debris: debrisCapacityHits,
                },
                physicsOrigin: { ...physicsOrigin },
                droppedPhysicsSeconds,
                fixedStep: fixedStep.snapshot(),
            };
        },
        releaseCampaignRestrictions() { allowedRoadVehicleIds = null; },
        dispose() {
            disposed = true;
            controls.clear();
            stopRequested = false;
            pendingExitWalkState = null;
            const pose = currentVehiclePose();
            if (controlled && pose) {
                if (controlled.kind === 'boat' || controlled.kind === 'airplane') {
                    specialVehicles?.release?.(controlled.id, pose);
                } else {
                    releaseControlledParkedCar(controlled.id, pose);
                }
            }
            controlled = null;
            specialVehicleState = null;
            removeControlledPhysics();
            bubbleQueue.dispose();
            if (eventQueue?.free) eventQueue.free();
            eventQueue = null;
            if (world?.free) world.free();
            world = null;
            for (const item of debris.splice(0)) releaseDebrisItem(item);
            if (debrisGroup.parent) debrisGroup.parent.remove(debrisGroup);
            disposeDebrisResources();
            engineAudio.dispose();
            specialVehicleAudio.dispose();
            tireAudio.dispose();
            skidMarks.dispose();
            cabVoice.stopCabVoice?.();
            if (audioContext?.close) void audioContext.close();
            audioContext = null;
        },
    };
}
