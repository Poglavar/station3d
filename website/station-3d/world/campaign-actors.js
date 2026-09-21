// Renders bounded authored campaign NPCs with stable entity IDs, guiding,
// patrol and desk-work behavior, separate from anonymous ambient pedestrians.

import * as THREE from 'three';

import {
    CAMPAIGN_FISHING_ROD_BUTT_M,
    CAMPAIGN_FISHING_ROD_LENGTH_M,
    campaignFishingGripAnchor,
    campaignSeatedActorOffsetY,
    sampleCampaignFishingPose,
    sampleCampaignTypewriterPose,
    stepCampaignActorPatrol,
} from '../core/campaign-actor-activity.js';
import { stepCampaignActorGuide } from '../core/campaign-actor-guide.js';
import { campaignActorTracksPlayer } from '../core/campaign-actor-attention.js';
import {
    campaignRoomElevationOffsetM,
    campaignRoomOwnsFloor,
} from '../core/campaign-room.js';
import { disposeGroup } from '../core/dispose.js';
import { registerEntityObject, unregisterEntityTree } from '../core/entity-interaction.js';
import { DEG_TO_RAD, finiteOrNull, geoToLocal, localToGeo } from '../core/math.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import { scene } from '../scene/setup.js';
import { campaignVehicleAttachmentPose } from './cars.js';
import { campaignWorldPackSpawnYAtLocal } from './campaign-world-pack.js';
import { subscribeUrbanCoastFormationChanges } from './water.js';
import {
    animatePersonHair,
    animatePersonSit,
    animatePersonWalk,
    createPersonMesh,
} from './person-mesh.js';
import { animatePersonFace, setPersonFaceExpression } from './person-face.js';
import {
    CAMPAIGN_ACTOR_SPEAKING_EVENT,
    CAMPAIGN_ACTOR_ATTENTION_EVENT,
    campaignPresentationDeltaSeconds,
} from '../core/campaign-speaking.js';

const FOLLOW_DISTANCE_M = 3.2;
const FOLLOW_SPEED_MPS = 1.25;
const ACTOR_GROUND_CLEARANCE_M = 0.005;
const SUPPORT_REFRESH_SECONDS = 0.5;
const SUPPORT_REFRESH_COUNT = 8;

let root = null;
let actors = [];
let terrain = null;
let sessionAnchorLat = null;
let sessionAnchorLon = null;
let campaignRoomFloorY = null;
let campaignRoomGroundPending = false;
let actorGroundYAt = null;
let activeCampaignScene = null;
let terrainUnsubscribe = null;
let urbanCoastUnsubscribe = null;
let terrainRefreshPending = false;

// Blink clocks start staggered so a row of actors never blinks in step.
const FACE_CLOCK_STAGGER_S = 1.7;

function onActorSpeaking(event) {
    const detail = event.detail || {};
    const record = actors.find(item => item.actor.id === detail.actorId);
    if (!record) return;
    record.dialogueFocused = true;
    record.talkSeconds = Number.isFinite(detail.seconds) ? Math.max(0, detail.seconds) : 0;
    if (detail.mood) setPersonFaceExpression(record.mesh, detail.mood);
}

function onActorAttention(event) {
    const record = actors.find(item => item.actor.id === event.detail?.actorId);
    const target = event.detail?.pose;
    if (!record || !Number.isFinite(target?.lat) || !Number.isFinite(target?.lon)) return;
    const local = geoToLocal(target.lon, target.lat, sessionAnchorLon, sessionAnchorLat);
    record.dialogueHeading = Math.atan2(local.x - record.mesh.position.x, local.z - record.mesh.position.z);
    record.mesh.rotation.y = record.dialogueHeading;
}

function onOverlayClosed() {
    for (const record of actors) {
        record.talkSeconds = 0;
        record.dialogueFocused = false;
        record.dialogueHeading = null;
    }
}

// The dialogue UI announces how long a beat is mouthed; the presentation clock
// counts it down here so no timer can outlive the scene, even while paused.
function animateActorFace(record, dt, nowMs) {
    if (!record.mesh.userData.face) return;
    const presentationDt = campaignPresentationDeltaSeconds({
        simulationDt: dt,
        nowMs,
        previousNowMs: record.lastFaceNowMs,
    });
    record.lastFaceNowMs = nowMs;
    record.faceTime += presentationDt;
    if (record.talkSeconds > 0) {
        record.talkSeconds = Math.max(0, record.talkSeconds - presentationDt);
    }
    animatePersonFace(record.mesh, record.faceTime, { talk: record.talkSeconds > 0 ? 1 : 0 });
}

function onActorEffect(event) {
    const effect = event.detail || {};
    const record = actors.find(item => item.actor.id === effect.actorId);
    if (!record) return;
    if (effect.type === 'actor.attach') {
        record.attachment = {
            vehicleId: effect.vehicleId,
            offset: effect.offset || {},
            pose: {},
        };
        record.mesh.scale.y = 0.72;
    } else if (effect.type === 'actor.despawn') {
        record.wantsVisible = false;
        record.mesh.visible = false;
    } else if (effect.type === 'actor.spawn') {
        record.wantsVisible = true;
        record.mesh.visible = record.terrainReady;
    }
}

function actorDefinition(definition, actorId) {
    return (definition?.actors || []).find(actor => actor.id === actorId) || null;
}

function appearanceFor(actor) {
    return {
        kind: actor?.kind || 'male',
        ...(actor?.appearance || {}),
    };
}

// Shared with the on-foot pursuers, who carry the same rifle and never fire it.
export function addCampaignActorRifle(mesh) {
    const rifle = new THREE.Group();
    rifle.name = 'CampaignActorRifle';
    const wood = new THREE.MeshStandardMaterial({ color: 0x5b3824, roughness: 0.88 });
    const metal = new THREE.MeshStandardMaterial({
        color: 0x25282a,
        roughness: 0.48,
        metalness: 0.62,
    });
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.12), wood);
    stock.name = 'CampaignActorRifleStock';
    stock.position.y = -0.2;
    stock.castShadow = true;
    rifle.add(stock);
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.34, 0.13), metal);
    receiver.name = 'CampaignActorRifleReceiver';
    receiver.position.y = 0.28;
    receiver.castShadow = true;
    rifle.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.78, 8), metal);
    barrel.name = 'CampaignActorRifleBarrel';
    barrel.position.y = 0.82;
    barrel.castShadow = true;
    rifle.add(barrel);
    rifle.position.set(0.24, 1.02, 0.17);
    rifle.rotation.set(0.12, 0.06, -0.58);
    // The rifle is presentation geometry on the actor, not a separate world
    // obstacle that can snag the train or a player walking past the patrol.
    rifle.userData.walkColliderBoxes = [];
    mesh.add(rifle);
}

// Rod, line and float for `activity: { type: 'fishing' }`: three draw calls that
// never rebuild. Only the rod pivot's rotation, the float's position and the two
// line vertices move, all from the pure sample.
function addAuthoredFishingRig(mesh, activity) {
    const dimensions = mesh.userData.personDimensions;
    const rig = new THREE.Group();
    rig.name = 'CampaignActorFishingRig';
    // Presentation geometry on the actor, never a world obstacle.
    rig.userData.walkColliderBoxes = [];

    const rodPivot = new THREE.Group();
    rodPivot.name = 'CampaignActorFishingRodPivot';
    // Yaw outside pitch, so a sway swings the rod instead of rolling it.
    rodPivot.rotation.order = 'YXZ';
    const anchor = campaignFishingGripAnchor(dimensions || {});
    rodPivot.position.set(anchor.x, anchor.y, anchor.z);
    const rodMaterial = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.82 });
    const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.017, CAMPAIGN_FISHING_ROD_LENGTH_M, 5),
        rodMaterial,
    );
    rod.name = 'CampaignActorFishingRod';
    rod.position.y = CAMPAIGN_FISHING_ROD_LENGTH_M * 0.5 - CAMPAIGN_FISHING_ROD_BUTT_M;
    rodPivot.add(rod);
    rig.add(rodPivot);

    const float = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 6, 4),
        new THREE.MeshStandardMaterial({ color: 0xd7443a, roughness: 0.6 }),
    );
    float.name = 'CampaignActorFishingFloat';
    rig.add(float);

    const linePositions = new THREE.BufferAttribute(new Float32Array(6), 3);
    linePositions.setUsage(THREE.DynamicDrawUsage);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', linePositions);
    const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({
        color: 0xe6edf3,
        transparent: true,
        opacity: 0.5,
    }));
    line.name = 'CampaignActorFishingLine';
    // Its two vertices move every frame and its bounds are never recomputed.
    line.frustumCulled = false;
    rig.add(line);

    mesh.add(rig);
    mesh.userData.campaignFishingRig = { rodPivot, float, linePositions };
    applyFishingPose(mesh, sampleCampaignFishingPose({
        tS: 0,
        dimensions,
        seatHeightM: activity?.seatHeightM,
        castDistanceM: activity?.castDistanceM,
        waterDropM: activity?.waterDropM,
        rodPitchDeg: activity?.rodPitchDeg,
        phaseOffsetSeconds: activity?.phaseOffsetSeconds,
    }));
}

function applyFishingPose(mesh, pose) {
    const rig = mesh.userData.campaignFishingRig;
    if (!rig) return;
    rig.rodPivot.rotation.set(Math.PI * 0.5 - pose.rodPitch, pose.rodYaw, 0);
    rig.float.position.set(pose.floatX, pose.floatY, pose.floatZ);
    rig.linePositions.setXYZ(0, pose.tipX, pose.tipY, pose.tipZ);
    rig.linePositions.setXYZ(1, pose.floatX, pose.floatY, pose.floatZ);
    rig.linePositions.needsUpdate = true;
}

function seatActor(
    record,
    localX = record.mesh.position.x,
    localZ = record.mesh.position.z,
) {
    if (campaignRoomGroundPending) {
        record.terrainReady = false;
        record.mesh.visible = false;
        return false;
    }
    const placementY = evidencePlacementBaseSceneY(
        terrain,
        localX,
        localZ,
        {
            preferRoadSurface: true,
            // Actor animation is a presentation frame hook. A streamed road
            // revision is built cooperatively elsewhere; seating Granny must
            // never force that whole dirty formation to rebuild synchronously.
            preferPublishedRoadSurface: true,
        },
    );
    const visibleGroundY = !Number.isFinite(campaignRoomFloorY)
        && typeof actorGroundYAt === 'function'
        ? finiteOrNull(actorGroundYAt(
            localX,
            localZ,
            placementY,
            record.authored,
        ))
        : null;
    if (!Number.isFinite(campaignRoomFloorY)
        && visibleGroundY === null
        && placementY === null) {
        record.terrainReady = false;
        record.mesh.visible = false;
        return false;
    }
    const supportY = Number.isFinite(campaignRoomFloorY)
        ? campaignRoomFloorY
        : visibleGroundY ?? placementY;
    const authoredGroundOffsetM = finiteOrNull(record.authored.groundOffsetM) ?? 0;
    const activity = record.authored.activity;
    const dimensions = record.mesh.userData.personDimensions;
    const seatedOffsetY = campaignSeatedActorOffsetY({
        activityType: activity?.type,
        seatHeightM: activity?.seatHeightM,
        legHeightM: dimensions?.legH,
    });
    record.mesh.position.set(
        localX,
        supportY + authoredGroundOffsetM + ACTOR_GROUND_CLEARANCE_M + seatedOffsetY,
        localZ,
    );
    record.terrainReady = true;
    record.mesh.visible = record.wantsVisible;
    return true;
}

function roomFloorStateForScene(campaignScene) {
    const environment = campaignScene?.authored?.environment;
    if (!campaignRoomOwnsFloor(environment)) return { required: false, y: null };
    const groundReference = environment.groundReference || environment.center;
    const centerLat = finiteOrNull(groundReference?.lat) ?? sessionAnchorLat;
    const centerLon = finiteOrNull(groundReference?.lon) ?? sessionAnchorLon;
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
        return { required: true, y: null };
    }
    const local = geoToLocal(centerLon, centerLat, sessionAnchorLon, sessionAnchorLat);
    const terrainY = evidencePlacementBaseSceneY(terrain, local.x, local.z)
        ?? campaignWorldPackSpawnYAtLocal(local.x, local.z);
    return {
        required: true,
        y: terrainY === null
            ? null
            : terrainY + campaignRoomElevationOffsetM(environment),
    };
}

function createActorRecord(authored, definition, anchorLat, anchorLon) {
    const actor = actorDefinition(definition, authored.actorId);
    if (!actor) return null;
    const lon = finiteOrNull(authored.lon);
    const lat = finiteOrNull(authored.lat);
    if (lon == null || lat == null) return null;
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    const mesh = createPersonMesh(appearanceFor(actor));
    mesh.name = `CampaignActor:${actor.id}`;
    mesh.position.set(local.x, 0, local.z);
    const headingDeg = Number(authored.headingDeg);
    mesh.rotation.y = Number.isFinite(headingDeg)
        ? Math.PI - headingDeg * DEG_TO_RAD
        : 0;
    mesh.userData.campaignActorId = actor.id;
    mesh.userData.campaignActorActivity = authored.activity?.type || null;
    if (authored.armed === true) addCampaignActorRifle(mesh);
    if (authored.activity?.type === 'fishing') addAuthoredFishingRig(mesh, authored.activity);
    mesh.visible = false;
    mesh.traverse((part) => {
        if (!part?.isMesh) return;
        registerEntityObject(part, `campaign-actor:${actor.id}`, {
            kind: 'campaign-actor',
            actorId: actor.id,
            label: actor.label || null,
        });
    });
    root.add(mesh);
    const record = {
        actor,
        authored,
        mesh,
        phase: 0,
        guideTargets: (authored.leadPath || [])
            .map((point) => {
                const pointLon = finiteOrNull(point?.lon);
                const pointLat = finiteOrNull(point?.lat);
                return pointLon == null || pointLat == null
                    ? null
                    : geoToLocal(pointLon, pointLat, anchorLon, anchorLat);
            })
            .filter(Boolean),
        activityTargets: (authored.activity?.path || [])
            .map((point) => {
                const pointLon = finiteOrNull(point?.lon);
                const pointLat = finiteOrNull(point?.lat);
                return pointLon == null || pointLat == null
                    ? null
                    : geoToLocal(pointLon, pointLat, anchorLon, anchorLat);
            })
            .filter(Boolean),
        activityTargetIndex: 0,
        activityPauseSeconds: authored.activity?.type === 'patrol'
            ? Math.max(0, finiteOrNull(authored.activity.phaseOffsetSeconds) ?? 0)
            : 0,
        activityElapsedSeconds: 0,
        bodyMesh: mesh.getObjectByName('PersonBody') || null,
        guideTargetIndex: 0,
        leading: false,
        leadDelaySeconds: Math.max(0, finiteOrNull(authored.leadDelaySeconds) ?? 0),
        gestureElapsedSeconds: 0,
        supportRefreshSeconds: SUPPORT_REFRESH_SECONDS,
        supportRefreshesRemaining: SUPPORT_REFRESH_COUNT,
        wantsVisible: authored.preloaded !== true,
        terrainReady: false,
        faceTime: 0,
        talkSeconds: 0,
        dialogueFocused: false,
        lastFaceNowMs: null,
        lastActivityNowMs: null,
    };
    seatActor(record);
    return record;
}

function animateAmbientPatrol(record, dt) {
    const activity = record.authored.activity;
    const target = record.activityTargets[record.activityTargetIndex] || null;
    if (activity?.type !== 'patrol' || !target) return 0;
    const seconds = Math.max(0, Number(dt) || 0);
    if (record.activityPauseSeconds > 0) {
        record.activityPauseSeconds = Math.max(0, record.activityPauseSeconds - seconds);
        return 0;
    }
    const step = stepCampaignActorPatrol({
        actorX: record.mesh.position.x,
        actorZ: record.mesh.position.z,
        targetX: target.x,
        targetZ: target.z,
        speedMps: activity.speedMps,
        dt: seconds,
    });
    if (step.walking && !seatActor(record, step.x, step.z)) return 0;
    if (step.walking) record.mesh.rotation.y = step.heading;
    if (step.arrived) {
        record.activityTargetIndex = (record.activityTargetIndex + 1)
            % record.activityTargets.length;
        record.activityPauseSeconds = Math.max(
            0,
            finiteOrNull(activity.pauseSeconds) ?? 0.8,
        );
    }
    return step.walking ? 1 : 0;
}

function animateTypewriterActivity(record, dt) {
    const activity = record.authored.activity;
    if (activity?.type !== 'typewriter') return false;
    record.activityElapsedSeconds += Math.max(0, Number(dt) || 0);
    animatePersonSit(record.mesh, 1);
    const pose = sampleCampaignTypewriterPose(
        record.activityElapsedSeconds,
        activity.phaseOffsetSeconds,
    );
    const limbs = record.mesh.userData.walkLimbs;
    for (const { mesh, side } of limbs?.arms || []) {
        mesh.rotation.x = side < 0 ? pose.leftArmPitch : pose.rightArmPitch;
        mesh.rotation.z = side < 0 ? pose.leftArmRoll : pose.rightArmRoll;
    }
    if (record.bodyMesh) record.bodyMesh.rotation.x = pose.torsoPitch;
    return true;
}

// The fisherman idles on the presentation clock, like the faces do, so the rod
// keeps bobbing while a conversation holds simulation time at zero.
function animateFishingActivity(record, dt, nowMs) {
    const activity = record.authored.activity;
    if (activity?.type !== 'fishing') return false;
    record.activityElapsedSeconds += campaignPresentationDeltaSeconds({
        simulationDt: dt,
        nowMs,
        previousNowMs: record.lastActivityNowMs,
    });
    record.lastActivityNowMs = nowMs;
    animatePersonSit(record.mesh, 1);
    const pose = sampleCampaignFishingPose({
        tS: record.activityElapsedSeconds,
        dimensions: record.mesh.userData.personDimensions,
        seatHeightM: activity.seatHeightM,
        castDistanceM: activity.castDistanceM,
        waterDropM: activity.waterDropM,
        rodPitchDeg: activity.rodPitchDeg,
        phaseOffsetSeconds: activity.phaseOffsetSeconds,
    });
    applyFishingPose(record.mesh, pose);
    if (record.bodyMesh) record.bodyMesh.rotation.x = pose.torsoPitch;
    return true;
}

function clearActorGroup() {
    if (root) unregisterEntityTree(root);
    if (root) disposeGroup(root);
    root = null;
    actors = [];
}

function authoredActorsForScene(campaignScene) {
    const byId = new Map();
    for (const authored of [
        ...(campaignScene?.authored?.actors || []),
        ...(campaignScene?.authored?.preloadedActors || []),
    ]) {
        if (!authored?.actorId || authored.environmentOwned || byId.has(authored.actorId)) continue;
        byId.set(authored.actorId, authored);
    }
    return [...byId.values()].slice(0, 12);
}

export function replaceCampaignActorsScene({ campaignScene, campaignDefinition } = {}) {
    if (!Number.isFinite(sessionAnchorLat) || !Number.isFinite(sessionAnchorLon)) return false;
    clearActorGroup();
    activeCampaignScene = campaignScene || null;
    const roomFloor = roomFloorStateForScene(campaignScene);
    campaignRoomFloorY = roomFloor.y;
    campaignRoomGroundPending = roomFloor.required && roomFloor.y === null;
    const authoredActors = authoredActorsForScene(campaignScene);
    if (authoredActors.length === 0 || !campaignDefinition) return true;
    root = new THREE.Group();
    root.name = 'CampaignActors';
    actors = authoredActors
        .map(authored => createActorRecord(
            authored,
            campaignDefinition,
            sessionAnchorLat,
            sessionAnchorLon,
        ))
        .filter(Boolean);
    actors.forEach((record, index) => {
        record.faceTime = index * FACE_CLOCK_STAGGER_S;
    });
    scene.add(root);
    return true;
}

export function getCampaignActorsSnapshot() {
    return actors.map(record => ({
        actorId: record.actor.id,
        ...localToGeo(record.mesh.position.x, record.mesh.position.z, sessionAnchorLon, sessionAnchorLat),
        rotationY: record.mesh.rotation.y,
        wantsVisible: record.wantsVisible,
        attachment: record.attachment ? structuredClone(record.attachment) : null,
        leading: record.leading,
        ...Object.fromEntries(['guideTargetIndex', 'leadDelaySeconds', 'gestureElapsedSeconds',
            'activityTargetIndex', 'activityPauseSeconds', 'activityElapsedSeconds', 'phase']
            .map(key => [key, record[key]])),
    }));
}

export function restoreCampaignActorsSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return false;
    for (const saved of snapshot) {
        const record = actors.find(actor => actor.actor.id === saved.actorId);
        if (!record || !Number.isFinite(saved.lat) || !Number.isFinite(saved.lon)) continue;
        const local = geoToLocal(saved.lon, saved.lat, sessionAnchorLon, sessionAnchorLat);
        record.wantsVisible = saved.wantsVisible === true;
        record.attachment = saved.attachment ? structuredClone(saved.attachment) : null;
        record.leading = saved.leading === true;
        for (const key of ['guideTargetIndex', 'leadDelaySeconds', 'gestureElapsedSeconds',
            'activityTargetIndex', 'activityPauseSeconds', 'activityElapsedSeconds', 'phase']) {
            if (Number.isFinite(saved[key])) record[key] = saved[key];
        }
        seatActor(record, local.x, local.z);
        if (Number.isFinite(saved.rotationY)) record.mesh.rotation.y = saved.rotationY;
        record.mesh.visible = record.wantsVisible && record.terrainReady;
    }
    return true;
}

export function getCampaignActorsGroup() {
    return root;
}

function animateAuthoredGesture(record, dt) {
    if (record.authored.gesture !== 'pull-lever') return;
    const duration = Math.max(0.2, finiteOrNull(record.authored.gestureDurationSeconds) ?? 1.45);
    record.gestureElapsedSeconds = Math.min(
        duration,
        record.gestureElapsedSeconds + Math.max(0, Number(dt) || 0),
    );
    const t = record.gestureElapsedSeconds / duration;
    const limbs = record.mesh.userData.walkLimbs;
    if (!limbs) return;
    if (record.gestureElapsedSeconds >= duration && record.leadDelaySeconds <= 0) {
        for (const { mesh } of limbs.arms) mesh.rotation.z = 0;
        return;
    }
    const reach = Math.sin(Math.min(1, t * 1.55) * Math.PI * 0.5);
    for (const { mesh, side } of limbs.arms) {
        mesh.rotation.x = -reach * (side > 0 ? 1.35 : 0.72);
        mesh.rotation.z = side > 0 ? -reach * 0.18 : reach * 0.1;
    }
}

export const campaignActorsLayer = {
    beginSession({
        anchorLat,
        anchorLon,
        terrain: terrainReference,
        actorGroundYAt: actorGroundYAtReference,
        campaignScene,
        campaignDefinition,
    }) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        urbanCoastUnsubscribe?.();
        urbanCoastUnsubscribe = null;
        terrainRefreshPending = false;
        terrain = terrainReference || null;
        actorGroundYAt = typeof actorGroundYAtReference === 'function'
            ? actorGroundYAtReference
            : null;
        sessionAnchorLat = Number(anchorLat);
        sessionAnchorLon = Number(anchorLon);
        terrainUnsubscribe = terrain?.onChange?.(() => {
            terrainRefreshPending = true;
        }) || null;
        urbanCoastUnsubscribe = subscribeUrbanCoastFormationChanges(() => {
            terrainRefreshPending = true;
        });
        replaceCampaignActorsScene({ campaignScene, campaignDefinition });
        window.addEventListener('station3d:campaign-actor-effect', onActorEffect);
        window.addEventListener(CAMPAIGN_ACTOR_SPEAKING_EVENT, onActorSpeaking);
        window.addEventListener(CAMPAIGN_ACTOR_ATTENTION_EVENT, onActorAttention);
        window.addEventListener('station3d:campaign-overlay-closed', onOverlayClosed);
    },

    onFrame(_pose, playerLocal, dt) {
        if (!root || !playerLocal) return;
        const faceNowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (terrainRefreshPending) {
            terrainRefreshPending = false;
            const roomFloor = roomFloorStateForScene(activeCampaignScene);
            campaignRoomFloorY = roomFloor.y;
            campaignRoomGroundPending = roomFloor.required && roomFloor.y === null;
            for (const record of actors) {
                record.supportRefreshesRemaining = SUPPORT_REFRESH_COUNT;
                seatActor(record);
            }
        }
        for (const record of actors) {
            if (record.attachment) {
                const attached = campaignVehicleAttachmentPose(
                    record.attachment.vehicleId,
                    record.attachment.offset,
                    record.attachment.pose,
                );
                if (attached) {
                    record.mesh.position.set(attached.x, attached.y, attached.z);
                    record.mesh.rotation.y = attached.heading;
                    record.terrainReady = true;
                    record.mesh.visible = record.wantsVisible;
                    animatePersonHair(record.mesh, { phase: record.phase, walking: 0, dt });
                    animateActorFace(record, dt, faceNowMs);
                    continue;
                }
            }
            if (!record.terrainReady && !seatActor(record)) continue;
            if (record.supportRefreshesRemaining > 0) {
                record.supportRefreshSeconds -= dt;
                if (record.supportRefreshSeconds <= 0) {
                    if (!seatActor(record)) continue;
                    record.supportRefreshSeconds = SUPPORT_REFRESH_SECONDS;
                    record.supportRefreshesRemaining -= 1;
                }
            }
            const dx = playerLocal.x - record.mesh.position.x;
            const dz = playerLocal.z - record.mesh.position.z;
            const distance = Math.hypot(dx, dz);
            let walking = 0;
            const guideTarget = record.guideTargets[record.guideTargetIndex] || null;
            if (guideTarget && record.leadDelaySeconds > 0) {
                record.leadDelaySeconds = Math.max(0, record.leadDelaySeconds - dt);
                record.leading = false;
            } else if (guideTarget) {
                let step = stepCampaignActorGuide({
                    actorX: record.mesh.position.x,
                    actorZ: record.mesh.position.z,
                    targetX: guideTarget.x,
                    targetZ: guideTarget.z,
                    playerX: playerLocal.x,
                    playerZ: playerLocal.z,
                    dt,
                    leading: record.leading,
                    ...record.authored.guide,
                });
                if (step.arrived && record.guideTargetIndex < record.guideTargets.length - 1) {
                    record.guideTargetIndex += 1;
                    const nextTarget = record.guideTargets[record.guideTargetIndex];
                    step = stepCampaignActorGuide({
                        actorX: step.x,
                        actorZ: step.z,
                        targetX: nextTarget.x,
                        targetZ: nextTarget.z,
                        playerX: playerLocal.x,
                        playerZ: playerLocal.z,
                        dt: 0,
                        leading: step.leading,
                        ...record.authored.guide,
                    });
                }
                record.leading = step.leading;
                if (step.walking && !seatActor(record, step.x, step.z)) continue;
                record.mesh.rotation.y = step.heading;
                if (step.walking) {
                    walking = 1;
                }
            } else if (record.authored.followPlayer && distance > FOLLOW_DISTANCE_M && distance > 0.001) {
                const step = Math.min(distance - FOLLOW_DISTANCE_M, FOLLOW_SPEED_MPS * dt);
                const nextX = record.mesh.position.x + dx / distance * step;
                const nextZ = record.mesh.position.z + dz / distance * step;
                if (!seatActor(record, nextX, nextZ)) continue;
                walking = 1;
                record.mesh.rotation.y = Math.atan2(dx, dz);
            } else if (record.authored.activity?.type === 'patrol') {
                walking = animateAmbientPatrol(record, dt);
            } else if (distance > 0.001 && campaignActorTracksPlayer({
                dialogueFocused: record.dialogueFocused,
                lookAtPlayer: record.authored.lookAtPlayer,
                activityType: record.authored.activity?.type,
            })) {
                record.mesh.rotation.y = Math.atan2(dx, dz);
            }
            record.phase += dt * 8;
            if (!animateTypewriterActivity(record, dt)
                && !animateFishingActivity(record, dt, faceNowMs)) {
                animatePersonWalk(record.mesh, record.phase, walking);
                if (record.bodyMesh) record.bodyMesh.rotation.x = 0;
            }
            if (record.dialogueFocused && Number.isFinite(record.dialogueHeading)) {
                record.mesh.rotation.y = record.dialogueHeading;
            }
            animateAuthoredGesture(record, dt);
            animatePersonHair(record.mesh, { phase: record.phase, walking, dt });
            animateActorFace(record, dt, faceNowMs);
        }
    },

    endSession() {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        urbanCoastUnsubscribe?.();
        urbanCoastUnsubscribe = null;
        terrainRefreshPending = false;
        window.removeEventListener('station3d:campaign-actor-effect', onActorEffect);
        window.removeEventListener(CAMPAIGN_ACTOR_SPEAKING_EVENT, onActorSpeaking);
        window.removeEventListener(CAMPAIGN_ACTOR_ATTENTION_EVENT, onActorAttention);
        window.removeEventListener('station3d:campaign-overlay-closed', onOverlayClosed);
        clearActorGroup();
        terrain = null;
        sessionAnchorLat = null;
        sessionAnchorLon = null;
        campaignRoomFloorY = null;
        campaignRoomGroundPending = false;
        activeCampaignScene = null;
        actorGroundYAt = null;
    },
};
