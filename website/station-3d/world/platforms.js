// Tram platforms + canopies + name signs, plus the tiny "waiting people"
// crowd seeded deterministically off each stop. Rebuilt whenever the tram has
// moved more than STATION_REBUILD_M from where the group was last centred.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { personFaceSeed, personHeadProfile } from '../core/person-appearance.js';
import { createInstancedPersonHeadGeometry, getPersonHeadMaterial } from './person-head.js';
import {
    registerShared,
    unregisterShared,
    isShared,
    disposeGroup,
} from '../core/dispose.js';
import { finiteOrNull, DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { captureStationGroundOpeningsSteps } from '../core/station-ground-openings.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import {
    PLATFORM_SURFACE_PUBLICATION_KEY,
    platformOpeningClaimInput,
    platformSurfaceClaimInput,
    platformSurfacePublicationCommitted,
} from '../core/platform-surface-publication.js';
import {
    plannerFeatureUsesPhotoFrame,
    plannerFeatureUsesAbsoluteElevation,
    plannerScenePoint,
    resolvePhotoStationVerticalPlacement,
} from '../core/planner-station-photo-placement.js';
import {
    prepareStationTrackRoutes,
    resolvePlannerStationTrackAnchor,
    splitStationTrackRouteBySegmentOwners,
    stationTrackRouteMatches,
} from '../core/planner-station-track-anchor.js';
import { camera, renderer, scene } from '../scene/setup.js';
import {
    canBuildPhotorealRigidStation,
    getPhotorealStationStructure,
    getPhotorealStationStructureRevision,
    isPhotorealRevealed,
    samplePhotorealBareEarthAt,
} from './photoreal.js';
import {
    ELEVATED_LIFT_SIZE_M,
    ELEVATED_PLATFORM_LENGTH_M,
    ELEVATED_STAIR_FLIGHT_RUN_M,
    ELEVATED_STAIR_FLIGHT_WIDTH_M,
    ELEVATED_STAIR_LANDING_DEPTH_M,
    ELEVATED_PLATFORM_SURFACE_CLEARANCE_M,
    ELEVATED_WALKWAY_RISE_M,
    findPlannerSurfaceCutStationAccessPlan,
    getElevatedAccessLayout,
    getPlannerPlatformSideOffsetM,
    getPlannerStopLevel,
    getTrackRightVector,
    plannerSurfaceCutStationEntranceCutout,
    plannerSurfaceCutStationFloorBox,
    resolveElevatedStationAccessHeights,
    METRO_ENTRANCE_END_ALONG_M,
    METRO_ENTRANCE_HALF_WIDTH_M,
    METRO_ENTRANCE_HEIGHT_M,
    METRO_ENTRANCE_START_ALONG_M,
    METRO_ENTRANCE_WALL_THICKNESS_M,
    PLATFORM_SLAB_THICKNESS_M,
    PLATFORM_WIDTH_M,
    PLANNER_LEVEL_HEIGHT_M,
    STATION_STAIR_STEP_COUNT,
    SURFACE_CUT_STAIR_TARGET_RISER_M,
    SURFACE_PLATFORM_LENGTH_M,
    UNDERGROUND_ACCESS_CORE_ALONG_M,
    UNDERGROUND_ACCESS_PASSAGE_WIDTH_M,
    UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M,
    UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M,
    UNDERGROUND_ACCESS_STAIR_WIDTH_M,
    UNDERGROUND_ACCESS_TOP_ALONG_M,   // fallback only — the climb sizes itself now
    UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M,
    UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M,
    UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M,
    UNDERGROUND_ISLAND_PLATFORM_WIDTH_M,
    UNDERGROUND_LIFT_SIZE_M,
    UNDERGROUND_LOWER_STAIR_TOP_ALONG_M,
    UNDERGROUND_MEZZANINE_HEIGHT_M,
    UNDERGROUND_MEZZANINE_RAIL_HEIGHT_M,
    UNDERGROUND_MEZZANINE_RAIL_THICKNESS_M,
    UNDERGROUND_PLATFORM_LENGTH_M,
    UNDERGROUND_PLATFORM_LIFT_ALONG_M,
    UNDERGROUND_PLATFORM_LIFT_CENTER_RIGHT_M,
    UNDERGROUND_STAIR_WELL_START_ALONG_M,
    UNDERGROUND_STATION_HALL_HEIGHT_M,
    UNDERGROUND_STREET_LANDING_DEPTH_M,
    undergroundStationEntranceCutout,
} from './planner-station-layout.js';
import { planUndergroundAccessStairs } from '../core/underground-station-access.js';
import { resolvePrimaryPlatformExtent } from '../core/platform-extents.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { createCooperativeBuildTask } from '../core/cooperative-build-task.js';
import {
    clearPlannerEntranceCuts,
    setPlannerEntranceCuts,
    PLANNER_ENTRANCE_CUT_MAX,
} from './planner-surface-cutout.js';
import { applySurfacePublicationDrawContracts } from './surface-material-authority.js';
import { freezeStaticTransforms } from '../core/static-transforms.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { noteWorldQueueActive, noteWorldQueueIdle } from '../core/world-ready.js';
import { platformPeopleInTargetFrame } from '../core/platform-people-frame.js';

const STATION_REBUILD_M = 300;
const PLATFORM_RADIUS_M = 1500;

const PERSON_BODY_COLORS = [
    0x2563eb, 0xdc2626, 0x16a34a, 0xf59e0b,
    0x7c3aed, 0x0ea5e9, 0xec4899, 0x84cc16,
];
const PERSON_SKIN_COLORS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const PERSON_LEG_COLORS = [0x38bdf8, 0x60a5fa, 0x22c55e, 0xfb7185, 0xa78bfa, 0xf97316];

// Per-stop-name sign textures. Registered as shared so disposeGroup skips them
// when the platform group is rebuilt; the cache itself is cleared at session end.
const signTextureCache = new Map();

// Shared per-name sign texture (dark plate, white text) — used by the surface
// canopy name signs here and by the underground station wall plates.
export function getStopNameSignTexture(name) {
    const label = (name || '').slice(0, 28);
    let tex = signTextureCache.get(label);
    if (!tex) {
        const signCanvas = document.createElement('canvas');
        signCanvas.width = 512; signCanvas.height = 96;
        const sctx = signCanvas.getContext('2d');
        sctx.fillStyle = '#1f2937';
        sctx.fillRect(0, 0, 512, 96);
        sctx.fillStyle = '#ffffff';
        sctx.font = 'bold 56px sans-serif';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        sctx.fillText(label, 256, 52);
        tex = new THREE.CanvasTexture(signCanvas);
        signTextureCache.set(label, tex);
        registerShared(tex);
    }
    return tex;
}

// ─── Session state ─────────────────────────────────────────────────────────

let anchorLat = 0, anchorLon = 0;
let stops = [];
let sessionTrackRoutes = [];
let sessionTrackSegments = [];
let sessionTrackRoutesByOwner = new Map();
let sessionTrackSegmentsByOwner = new Map();
let platformMaterials = null;
let group = null;
let pendingBuildTask = null;
let pendingBuildLat = null;
let pendingBuildLon = null;
let pendingBuildStationRevision = 0;
let pendingBuildPhotoGroundReveal = false;
let pendingBuildRailFormationRevision = 0;
let lastBuildLat = null;
let lastBuildLon = null;
let terrainReference = null;
let terrainChangeSubscription = null;
let terrainRevisionDirty = false;
let railFormationReference = null;
let sessionContextReference = null;
let railFormationRevisionSeen = 0;
let photoTrackFrame = null;
let photoGroundOffsetAt = null;
let photoGroundRevealRebuilt = false;
let photoStationStructureRevision = 0;
let surfacePublications = null;
let publicationGeneration = 0;
let activePlatformState = null;
let groundCoordinator = null;
let requestedGroundCenter = null;
const stationTemplateCache = new Map();
const STATION_CLONE_CHUNK_SIZE = 16;
const STATION_CLONE_BUDGET_MS = 4;
const INITIAL_PLATFORM_BUILD_BUDGET_MS = 8;

// Walk mode raycasts the visible platform and stair solids so underground
// stations can be exited on foot rather than relying on a fixed-height floor.
export function getPlatformsGroup() {
    return group;
}

function currentRailFormationReference() {
    return sessionContextReference?.railFormation
        || terrainReference?.railFormation
        || railFormationReference
        || null;
}

// ─── Pedestrian crowd generation (seeded per stop) ─────────────────────────

function stableHash(value) {
    const text = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function seededUnit(seed, salt) {
    const x = Math.sin((seed + 1) * (salt + 17) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

export function platformStopKey(stop) {
    const lng = stop.lng ?? stop.lon;
    const id = stop.stopId || stop.id || '';
    const lat = Number.isFinite(stop.lat) ? stop.lat.toFixed(6) : '';
    const lon = Number.isFinite(lng) ? lng.toFixed(6) : '';
    return `${id}|${stop.name || ''}|${lat}|${lon}`;
}

function pushPlatformPeople(people, stopKey, cx, cz, angleY, platformW, platformL, platformTopY) {
    const seed = stableHash(stopKey);
    const count = 2 + (seed % 5);
    const cosA = Math.cos(angleY);
    const sinA = Math.sin(angleY);
    const usableL = platformL * 0.68;

    for (let i = 0; i < count; i++) {
        const kindRoll = seededUnit(seed, i * 11 + 1);
        const kind = kindRoll < 0.20 ? 'kid' : (kindRoll < 0.58 ? 'female' : 'male');
        const lane = i % 2 === 0 ? -1 : 1;
        const localX = lane * platformW * 0.18 + (seededUnit(seed, i * 11 + 2) - 0.5) * platformW * 0.18;
        const localZ = -usableL / 2 + ((i + 0.5) / count) * usableL + (seededUnit(seed, i * 11 + 3) - 0.5) * 0.55;
        const x = cx + localX * cosA + localZ * sinA;
        const z = cz - localX * sinA + localZ * cosA;

        people.push({
            stopKey,
            faceSeed: personFaceSeed(stopKey + '|person|' + i),
            x, z, y: platformTopY,
            yaw: angleY + (seededUnit(seed, i * 11 + 4) - 0.5) * 0.7,
            kind,
            bodyColor: PERSON_BODY_COLORS[Math.floor(seededUnit(seed, i * 11 + 5) * PERSON_BODY_COLORS.length)],
            skinColor: PERSON_SKIN_COLORS[Math.floor(seededUnit(seed, i * 11 + 6) * PERSON_SKIN_COLORS.length)],
            legColor:  PERSON_LEG_COLORS [Math.floor(seededUnit(seed, i * 11 + 7) * PERSON_LEG_COLORS.length)],
        });
    }
}

function pushPersonParts(person, parts) {
    const headProfile = personHeadProfile(person.faceSeed, person.kind);
    const dims = person.kind === 'kid'
        ? { headR: 0.13, bodyH: 0.48, bodyR: 0.13, legH: 0.44, legR: 0.035, legX: 0.055, armH: 0.38, armR: 0.03, armX: 0.15 }
        : person.kind === 'female'
            ? { headR: 0.145, bodyH: 0.70, bodyR: 0.17, legH: 0.64, legR: 0.04, legX: 0.065, armH: 0.55, armR: 0.032, armX: 0.19 }
            : { headR: 0.15, bodyH: 0.76, bodyR: 0.17, legH: 0.72, legR: 0.045, legX: 0.07, armH: 0.60, armR: 0.035, armX: 0.20 };

    const bodyY = person.y + dims.legH + dims.bodyH / 2;
    const headY = person.y + dims.legH + dims.bodyH + dims.headR * 1.05;
    const legY  = person.y + dims.legH / 2;
    const armY  = person.y + dims.legH + dims.bodyH * 0.52;

    parts.heads.push({
        x: person.x, y: headY, z: person.z, yaw: person.yaw,
        sx: dims.headR * headProfile.width,
        sy: dims.headR * 1.08 * headProfile.height,
        sz: dims.headR * headProfile.depth,
        faceVariant: headProfile.variant,
        color: person.skinColor, stopKey: person.stopKey,
    });
    const body = {
        x: person.x, y: bodyY, z: person.z, yaw: person.yaw,
        sx: dims.bodyR, sy: dims.bodyH, sz: dims.bodyR,
        color: person.bodyColor, stopKey: person.stopKey,
    };
    if (person.kind === 'female') parts.dressBodies.push(body);
    else parts.straightBodies.push(body);

    const cosY = Math.cos(person.yaw);
    const sinY = Math.sin(person.yaw);
    const offset = (lx, lz = 0) => ({
        x: person.x + lx * cosY + lz * sinY,
        z: person.z - lx * sinY + lz * cosY,
    });

    for (const lx of [-dims.legX, dims.legX]) {
        const p = offset(lx);
        parts.legs.push({
            x: p.x, y: legY, z: p.z, yaw: person.yaw,
            sx: dims.legR, sy: dims.legH, sz: dims.legR,
            color: person.legColor, stopKey: person.stopKey,
        });
    }
    for (const lx of [-dims.armX, dims.armX]) {
        const p = offset(lx);
        parts.arms.push({
            x: p.x, y: armY, z: p.z, yaw: person.yaw,
            sx: dims.armR, sy: dims.armH, sz: dims.armR,
            color: person.skinColor, stopKey: person.stopKey,
        });
    }
}

const hiddenPlatformPeopleStopKeys = new Set();
let platformPeopleGloballyVisible = true;

function applyPlatformPeopleMeshVisibility(mesh) {
    const sourceMatrices = mesh?.userData?.platformPeopleMatrices;
    const stopKeys = mesh?.userData?.platformPeopleStopKeys;
    if (!Array.isArray(sourceMatrices) || !Array.isArray(stopKeys)) return;
    const hidden = new THREE.Matrix4();
    for (let index = 0; index < sourceMatrices.length; index++) {
        const source = sourceMatrices[index];
        if (!platformPeopleGloballyVisible || hiddenPlatformPeopleStopKeys.has(stopKeys[index])) {
            hidden.makeScale(0, 0, 0);
            hidden.setPosition(
                source.elements[12],
                source.elements[13],
                source.elements[14],
            );
            mesh.setMatrixAt(index, hidden);
        } else {
            mesh.setMatrixAt(index, source);
        }
    }
    mesh.instanceMatrix.needsUpdate = true;
}

function buildColoredInstancedMesh(geometry, instances, suppliedMaterial = null) {
    if (instances.length === 0) {
        geometry.dispose();
        return null;
    }

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    // Instance colour is a built-in Three.js attribute. Keeping one white
    // material per body-part family avoids turning eight shirt colours (and
    // every skin/leg colour) into separate draw calls.
    const material = suppliedMaterial || new THREE.MeshBasicMaterial({ color: 0xffffff });
    // Test hook: browser ES module imports cannot be replaced through window.THREE.
    const InstancedMesh = typeof window !== 'undefined' && window.__Station3DInstancedMesh
        ? window.__Station3DInstancedMesh
        : THREE.InstancedMesh;
    const mesh = new InstancedMesh(geometry, material, instances.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const color = new THREE.Color();
    const sourceMatrices = [];
    const stopKeys = [];
    for (let i = 0; i < instances.length; i++) {
        const p = instances[i];
        position.set(p.x, p.y, p.z);
        quaternion.setFromAxisAngle(yAxis, p.yaw || 0);
        scale.set(p.sx, p.sy, p.sz);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
        sourceMatrices.push(matrix.clone());
        stopKeys.push(p.stopKey || null);
        mesh.setColorAt(i, color.set(p.color || 0xffffff));
    }
    mesh.userData.platformPeopleMatrices = sourceMatrices;
    mesh.userData.platformPeopleStopKeys = stopKeys;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    applyPlatformPeopleMeshVisibility(mesh);
    return mesh;
}

function buildWaitingPeopleGroup(people) {
    const g = new THREE.Group();
    g.name = 'PlatformWaitingPeople';
    g.userData.perfRenderGroup = 'platforms:people';
    if (!people || people.length === 0) return g;

    const parts = { heads: [], straightBodies: [], dressBodies: [], legs: [], arms: [] };
    for (const person of people) pushPersonParts(person, parts);

    const headMesh  = buildColoredInstancedMesh(
        createInstancedPersonHeadGeometry(parts.heads.map(head => head.faceVariant)),
        parts.heads,
        getPersonHeadMaterial(0xffffff, { unlit: true }),
    );
    const bodyMesh  = buildColoredInstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), parts.straightBodies);
    const dressMesh = buildColoredInstancedMesh(new THREE.CylinderGeometry(0.62, 1.0, 1, 8), parts.dressBodies);
    const legMesh   = buildColoredInstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), parts.legs);
    const armMesh   = buildColoredInstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), parts.arms);

    for (const mesh of [legMesh, bodyMesh, dressMesh, armMesh, headMesh]) {
        if (mesh) g.add(mesh);
    }
    g.userData.peopleCount = people.length;
    g.userData.people = people.map((person) => ({ ...person }));
    const stopKeys = new Set(people.map(person => person.stopKey).filter(Boolean));
    g.userData.stopKey = stopKeys.size === 1 ? stopKeys.values().next().value : null;
    return g;
}

function consolidateWaitingPeopleGroups(root) {
    const groups = [];
    root?.traverse?.((object) => {
        if (object.name === 'PlatformWaitingPeople') groups.push(object);
    });
    if (groups.length <= 1) return groups[0] || null;
    // Each source group inherits its station's terrain-height transform. The
    // consolidated group is instead a direct child of root, so bake the full
    // source-to-root transform before removing the station-local groups.
    root.updateMatrixWorld(true);
    const people = groups.flatMap((object) => platformPeopleInTargetFrame(
        object.userData?.people || [],
        object.matrixWorld,
        root.matrixWorld,
    ));
    for (const peopleGroup of groups) disposeGroup(peopleGroup);
    const consolidated = buildWaitingPeopleGroup(people);
    if (consolidated.children.length > 0) root.add(consolidated);
    return consolidated;
}

export function getPlatformWaitingPeople(stop) {
    const stopKey = platformStopKey(stop);
    const waitingPeople = [];
    group?.traverse?.((object) => {
        if (object.name !== 'PlatformWaitingPeople') return;
        waitingPeople.push(...(object.userData.people || [])
            .filter(person => person.stopKey === stopKey)
            .map((person) => ({ ...person })));
    });
    return waitingPeople;
}

export function setPlatformWaitingPeopleVisible(visible, stop = null) {
    const stopKey = stop ? platformStopKey(stop) : null;
    if (stopKey) {
        if (visible) hiddenPlatformPeopleStopKeys.delete(stopKey);
        else hiddenPlatformPeopleStopKeys.add(stopKey);
    } else {
        platformPeopleGloballyVisible = !!visible;
        if (visible) hiddenPlatformPeopleStopKeys.clear();
    }
    group?.traverse?.((object) => {
        if (object.name !== 'PlatformWaitingPeople') return;
        for (const child of object.children) applyPlatformPeopleMeshVisibility(child);
    });
}

export function buildSeededPlatformPeopleGroup(stopKey, cx, cz, angleY, platformW, platformL, platformTopY) {
    const people = [];
    pushPlatformPeople(people, stopKey, cx, cz, angleY, platformW, platformL, platformTopY);
    return buildWaitingPeopleGroup(people);
}

// ─── Ground marking geometry ───────────────────────────────────────────────

// Builds the flat, upward-facing paint marking for one stop in its local frame
// (X = width, Z = length, origin centred, y = 0). One merged BufferGeometry of
// thin quads: a rectangular outline band framing the w×l footprint plus a short
// dashed safety strip along the track-side long edge. Placed/rotated per stop
// exactly where the old raised slab used to sit.
function buildStopMarkingGeometry(w, l) {
    const positions = [];
    const normals = [];
    // Push an axis-aligned upward-facing quad spanning (x0,z0)-(x1,z1) at y=0.
    const quad = (x0, z0, x1, z1) => {
        const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
        const za = Math.min(z0, z1), zb = Math.max(z0, z1);
        positions.push(
            xa, 0, za,  xa, 0, zb,  xb, 0, zb,
            xa, 0, za,  xb, 0, zb,  xb, 0, za,
        );
        for (let i = 0; i < 6; i++) normals.push(0, 1, 0);
    };

    const b = 0.12;                 // outline band width
    const hw = w / 2, hl = l / 2;
    // Outline band: two short edges (along X) + two long edges (along Z), inset
    // so the corners don't double up.
    quad(-hw, hl - b, hw, hl);              // far short edge
    quad(-hw, -hl, hw, -hl + b);            // near short edge
    quad(hw - b, -hl + b, hw, hl - b);      // long edge (+X side)
    quad(-hw, -hl + b, -hw + b, hl - b);    // long edge (-X side)

    // Dashed safety strip just inside the track-side long edge.
    const dashX = -hw + 0.15;
    const dashHalfW = 0.04;
    const nDash = 4;
    const usable = l * 0.8;
    const period = usable / nDash;
    const dashHalfL = 0.8;
    for (let i = 0; i < nDash; i++) {
        const zc = -usable / 2 + (i + 0.5) * period;
        quad(dashX - dashHalfW, zc - dashHalfL, dashX + dashHalfW, zc + dashHalfL);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geom;
}

// ─── Platform group builder ────────────────────────────────────────────────

function addOrientedBox(target, material, sizeX, sizeY, sizeZ, x, y, z, angleY, name = '') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sizeX, sizeY, sizeZ), material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = angleY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name) mesh.name = name;
    target.add(mesh);
    return mesh;
}

// One instanced draw owns the platform slab, every tread/riser and the top
// landing. The rail formation owns the surrounding retaining walls and broad
// excavation; this published mesh atomically owns the narrow stairwell opening.
function addSurfaceCutStationAccess(target, plan, platformTopY, groupOriginY, material) {
    const stair = plan?.stair;
    const groundTopY = Number(plan?.groundY) - Number(groupOriginY || 0) + 0.03;
    const riseM = groundTopY - platformTopY;
    if (!stair || !(riseM >= 0.05)) return null;
    const stepCount = Math.max(
        3,
        Number(stair.stepCount) || Math.ceil(riseM / SURFACE_CUT_STAIR_TARGET_RISER_M),
    );
    const floor = plannerSurfaceCutStationFloorBox(plan);
    if (!floor) return null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const instanceCount = stepCount + 2;
    const access = new THREE.InstancedMesh(geometry, material, instanceCount);
    access.name = 'SurfaceCutStationAccess';
    access.userData.walkableSurface = true;
    access.userData.stopId = plan.stopId;
    access.userData.stepCount = stepCount;
    access.userData.batchedDrawCalls = 1;
    access.castShadow = true;
    access.receiveShadow = true;

    const stationQuaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        plan.angleY,
    );
    // Rotating a quarter turn makes local Z run across the cut and local X run
    // along the track — the stair flight's natural frame.
    const stairQuaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        plan.angleY + Math.PI * 0.5,
    );
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    let instance = 0;
    const setBox = (x, y, z, sx, sy, sz, quaternion) => {
        position.set(x, y, z);
        scale.set(sx, sy, sz);
        matrix.compose(position, quaternion, scale);
        access.setMatrixAt(instance++, matrix);
    };

    const platformCenterX = plan.centerX + plan.rightX * floor.centerRightM;
    const platformCenterZ = plan.centerZ + plan.rightZ * floor.centerRightM;
    setBox(
        platformCenterX,
        platformTopY - 0.09,
        platformCenterZ,
        floor.widthM,
        0.18,
        floor.lengthM,
        stationQuaternion,
    );

    const treadDepthM = stair.runM / stepCount;
    const stairBaseY = platformTopY - 0.09;
    for (let index = 0; index < stepCount; index++) {
        const treadRightM = stair.startRightM + treadDepthM * (index + 0.5);
        const treadTopY = platformTopY + riseM * ((index + 1) / stepCount);
        // Each tread is a solid concrete block down to the platform datum.
        // Thin tread/riser plates left the whole flight hollow, exposing the
        // purple world underlay as a triangular "floor gap" from the side.
        const blockHeightM = treadTopY - stairBaseY;
        setBox(
            plan.centerX + plan.rightX * treadRightM,
            stairBaseY + blockHeightM * 0.5,
            plan.centerZ + plan.rightZ * treadRightM,
            stair.widthM,
            blockHeightM,
            treadDepthM + 0.04,
            stairQuaternion,
        );
    }
    const landingEndRightM = Number.isFinite(Number(stair.portalEndRightM))
        ? Number(stair.portalEndRightM)
        : stair.landingEndRightM;
    const landingCenterRightM = (stair.endRightM + landingEndRightM) * 0.5;
    setBox(
        plan.centerX + plan.rightX * landingCenterRightM,
        groundTopY - 0.06,
        plan.centerZ + plan.rightZ * landingCenterRightM,
        stair.widthM,
        0.12,
        landingEndRightM - stair.endRightM,
        stairQuaternion,
    );
    access.instanceMatrix.needsUpdate = true;
    target.add(access);
    return access;
}

function pointInStationFrame(cx, cz, right, forward, rightM, alongM, y) {
    return new THREE.Vector3(
        cx + right.x * rightM + forward.x * alongM,
        y,
        cz + right.z * rightM + forward.z * alongM,
    );
}

function addBeamBetween(target, material, start, end, thickness = 0.08, name = '') {
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length < 0.01) return null;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(length, thickness, thickness), material);
    beam.position.copy(start).add(end).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), delta.normalize());
    beam.castShadow = true;
    beam.receiveShadow = true;
    if (name) beam.name = name;
    target.add(beam);
    return beam;
}

function addUndergroundFlightRailings(
    target,
    material,
    cx,
    cz,
    angleY,
    centerRight,
    startAlong,
    endAlong,
    startY,
    endY,
) {
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const railHeight = 1.05;
    const postCount = Math.max(2, Math.ceil(Math.abs(endAlong - startAlong) / 1.5));
    for (const side of [-1, 1]) {
        const edgeRight = centerRight
            + side * (UNDERGROUND_ACCESS_STAIR_WIDTH_M * 0.5 - 0.04);
        addBeamBetween(
            target,
            material,
            pointInStationFrame(cx, cz, right, forward, edgeRight, startAlong, startY + railHeight),
            pointInStationFrame(cx, cz, right, forward, edgeRight, endAlong, endY + railHeight),
            0.065,
        );
        for (let i = 0; i <= postCount; i++) {
            const t = i / postCount;
            const along = startAlong + (endAlong - startAlong) * t;
            const y = startY + (endY - startY) * t;
            const post = addOrientedBox(
                target,
                material,
                0.07,
                railHeight,
                0.07,
                cx + right.x * edgeRight + forward.x * along,
                y + railHeight * 0.5,
                cz + right.z * edgeRight + forward.z * along,
                angleY,
            );
            post.userData.guard = true;
        }
    }
}

function addUndergroundStairFlight(
    target,
    cx,
    cz,
    angleY,
    centerRight,
    startAlong,
    endAlong,
    startY,
    endY,
    treadMaterial,
    frameMaterial,
    name,
) {
    const riseM = Math.abs(endY - startY);
    const stepCount = Math.max(2, Math.ceil(riseM / 0.17));
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const stepDepth = Math.abs(endAlong - startAlong) / stepCount;
    const treadThickness = 0.09;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const steps = new THREE.InstancedMesh(geometry, treadMaterial, stepCount);
    steps.name = `${name}Treads`;
    steps.userData.walkableSurface = true;
    steps.castShadow = true;
    steps.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        angleY,
    );
    const scale = new THREE.Vector3();
    for (let i = 0; i < stepCount; i++) {
        const positionT = (i + 0.5) / stepCount;
        const heightT = (i + 1) / stepCount;
        const along = startAlong + (endAlong - startAlong) * positionT;
        const treadY = startY + (endY - startY) * heightT;
        position.set(
            cx + right.x * centerRight + forward.x * along,
            treadY - treadThickness * 0.5,
            cz + right.z * centerRight + forward.z * along,
        );
        scale.set(UNDERGROUND_ACCESS_STAIR_WIDTH_M, treadThickness, stepDepth + 0.04);
        matrix.compose(position, quaternion, scale);
        steps.setMatrixAt(i, matrix);
    }
    steps.instanceMatrix.needsUpdate = true;
    // Closed risers. Open treads let you see straight through the flight into
    // the soil behind it, and made the stair read as floating slabs.
    const riserHeight = riseM / stepCount;
    const risers = new THREE.InstancedMesh(geometry, treadMaterial, stepCount);
    risers.name = `${name}Risers`;
    risers.castShadow = true;
    risers.receiveShadow = true;
    for (let i = 0; i < stepCount; i++) {
        const along = startAlong + (endAlong - startAlong) * (i / stepCount);
        const riserTopY = startY + (endY - startY) * ((i + 1) / stepCount);
        position.set(
            cx + right.x * centerRight + forward.x * along,
            riserTopY - riserHeight * 0.5,
            cz + right.z * centerRight + forward.z * along,
        );
        scale.set(UNDERGROUND_ACCESS_STAIR_WIDTH_M, riserHeight + 0.02, 0.08);
        matrix.compose(position, quaternion, scale);
        risers.setMatrixAt(i, matrix);
    }
    risers.instanceMatrix.needsUpdate = true;
    const flight = new THREE.Group();
    flight.name = name;
    flight.userData.stepCount = stepCount;
    flight.add(steps);
    flight.add(risers);
    addUndergroundFlightRailings(
        flight,
        frameMaterial,
        cx,
        cz,
        angleY,
        centerRight,
        startAlong,
        endAlong,
        startY,
        endY,
    );
    target.add(flight);
}

function addUndergroundLiftShaft(
    target,
    cx,
    cz,
    angleY,
    centerRight,
    along,
    bottomY,
    topY,
    frameMaterial,
    name,
    { extendAboveTopM = 0 } = {},
) {
    const lift = new THREE.Group();
    lift.name = name;
    lift.userData.accessible = true;
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const half = UNDERGROUND_LIFT_SIZE_M * 0.5;
    const visibleTopY = topY + extendAboveTopM;
    const height = visibleTopY - bottomY;
    const center = pointInStationFrame(cx, cz, right, forward, centerRight, along, 0);
    const glassMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x92bdc9,
        transparent: true,
        opacity: 0.28,
        roughness: 0.16,
        metalness: 0.05,
        // NO `transmission`. In three.js any object with transmission > 0 makes
        // the renderer draw the ENTIRE SCENE again into a transmission render
        // target, with a mipmap chain, EVERY FRAME — a second full render that
        // never appears in the draw-call count. Measured 2026-07-27 on a Split
        // ride: 271 draw calls and 326k triangles, yet renderer.render averaged
        // 254 ms with spikes past 5 s, and the overlay named `platforms` as the
        // worst frame. `transparent` + `opacity` already gives see-through
        // glass; transmission only added refraction, at the cost of the frame.
        side: THREE.DoubleSide,
    });
    const doorMaterial = new THREE.MeshStandardMaterial({
        color: 0x5f6973,
        metalness: 0.72,
        roughness: 0.34,
    });
    for (const lateral of [-half, half]) {
        for (const longitudinal of [-half, half]) {
            addOrientedBox(
                lift,
                frameMaterial,
                0.11,
                height,
                0.11,
                center.x + right.x * lateral + forward.x * longitudinal,
                bottomY + height * 0.5,
                center.z + right.z * lateral + forward.z * longitudinal,
                angleY,
            );
        }
    }
    for (const longitudinal of [-half, half]) {
        addOrientedBox(
            lift,
            glassMaterial,
            UNDERGROUND_LIFT_SIZE_M - 0.16,
            height - 0.16,
            0.045,
            center.x + forward.x * longitudinal,
            bottomY + height * 0.5,
            center.z + forward.z * longitudinal,
            angleY,
        );
    }
    // The shaft is glazed on three sides; only the door face is open. Leaving
    // the far side out made the shaft a hole in the wall it sits against.
    addOrientedBox(
        lift,
        glassMaterial,
        0.045,
        height - 0.16,
        UNDERGROUND_LIFT_SIZE_M - 0.16,
        center.x + right.x * half,
        bottomY + height * 0.5,
        center.z + right.z * half,
        angleY,
    );
    for (const servedY of [bottomY, topY]) {
        addOrientedBox(
            lift,
            doorMaterial,
            0.055,
            2.1,
            UNDERGROUND_LIFT_SIZE_M * 0.72,
            center.x - right.x * half,
            servedY + 1.05,
            center.z - right.z * half,
            angleY,
            `${name}Door`,
        );
    }
    addOrientedBox(
        lift,
        frameMaterial,
        UNDERGROUND_LIFT_SIZE_M + 0.14,
        0.18,
        UNDERGROUND_LIFT_SIZE_M + 0.14,
        center.x,
        visibleTopY + 0.09,
        center.z,
        angleY,
        `${name}Roof`,
    );
    target.add(lift);
}

function* addUndergroundIslandAccess(
    target,
    cx,
    cz,
    angleY,
    baseY,
    treadMaterial,
    frameMaterial,
    lightMaterial,
    groundLocalY = 0,
    { stopId = null, entranceCuts = null } = {},
) {
    const access = new THREE.Group();
    const entranceTopAlongByDirection = {};
    access.name = 'UndergroundIslandStationAccess';
    access.userData.layout = 'sealed-island-mezzanine-two-exits-and-two-stage-lift';
    access.userData.exitCount = 2;
    access.userData.accessible = true;
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const platformY = baseY + UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M;
    const mezzanineY = baseY + UNDERGROUND_MEZZANINE_HEIGHT_M;
    // Ground in the station group's frame, not the group origin — see groundLocalY.
    const surfaceY = groundLocalY + 0.06;
    const passageThickness = 0.16;
    const mezzanineRoofY = baseY + UNDERGROUND_STATION_HALL_HEIGHT_M - 0.18;
    const passageHeight = mezzanineRoofY - mezzanineY;
    const centralMezzanineWidth = UNDERGROUND_ISLAND_PLATFORM_WIDTH_M - 0.4;
    const centralMezzanineLength = UNDERGROUND_ACCESS_CORE_ALONG_M * 2
        + UNDERGROUND_ACCESS_PASSAGE_WIDTH_M;

    // ── Mezzanine deck ────────────────────────────────────────────────────
    // One open deck over the platform with the stair well down its centre,
    // instead of two narrow ledges the stairs and their railings overhung.
    // Every edge that drops to the platform gets a guard rail.
    const deckHalfWidth = centralMezzanineWidth * 0.5;
    const deckHalfLength = centralMezzanineLength * 0.5;
    const slotHalfWidth = UNDERGROUND_ACCESS_STAIR_WIDTH_M * 0.5;
    const slotEndAlong = UNDERGROUND_LOWER_STAIR_TOP_ALONG_M;
    const platformLiftRight = UNDERGROUND_PLATFORM_LIFT_CENTER_RIGHT_M;
    const platformLiftAlong = UNDERGROUND_PLATFORM_LIFT_ALONG_M;
    const streetLiftRight = UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M;
    const liftHalf = UNDERGROUND_LIFT_SIZE_M * 0.5;
    const railHeight = UNDERGROUND_MEZZANINE_RAIL_HEIGHT_M;
    const railThickness = UNDERGROUND_MEZZANINE_RAIL_THICKNESS_M;

    const addSlab = (lowRight, highRight, lowAlong, highAlong, y, thickness, material, name, walkable) => {
        const width = highRight - lowRight;
        const depth = highAlong - lowAlong;
        if (width <= 0.05 || depth <= 0.05) return;
        const slabRight = (lowRight + highRight) * 0.5;
        const slabAlong = (lowAlong + highAlong) * 0.5;
        const slab = addOrientedBox(
            access,
            material,
            width,
            thickness,
            depth,
            cx + right.x * slabRight + forward.x * slabAlong,
            y - thickness * 0.5,
            cz + right.z * slabRight + forward.z * slabAlong,
            angleY,
            name,
        );
        if (walkable) slab.userData.walkableSurface = true;
    };
    // A lift shaft rising through a slab needs a well in it, not a slab drawn
    // straight across the shaft.
    const addSlabAroundShaft = (lowRight, highRight, lowAlong, highAlong, shaft, ...rest) => {
        if (!shaft) {
            addSlab(lowRight, highRight, lowAlong, highAlong, ...rest);
            return;
        }
        addSlab(lowRight, shaft.lowRight, lowAlong, highAlong, ...rest);
        addSlab(shaft.highRight, highRight, lowAlong, highAlong, ...rest);
        addSlab(shaft.lowRight, shaft.highRight, lowAlong, shaft.lowAlong, ...rest);
        addSlab(shaft.lowRight, shaft.highRight, shaft.highAlong, highAlong, ...rest);
    };
    const addGuardRail = (centerRight, centerAlong, width, depth, name) => {
        const rail = addOrientedBox(
            access,
            frameMaterial,
            Math.max(width, railThickness),
            railHeight,
            Math.max(depth, railThickness),
            cx + right.x * centerRight + forward.x * centerAlong,
            mezzanineY + railHeight * 0.5,
            cz + right.z * centerRight + forward.z * centerAlong,
            angleY,
            name || 'UndergroundMezzanineGuardRail',
        );
        // Guards block the walker even though they are low enough to step onto.
        rail.userData.guard = true;
        return rail;
    };

    const platformLiftWell = {
        lowRight: platformLiftRight - liftHalf,
        highRight: platformLiftRight + liftHalf,
        lowAlong: platformLiftAlong - liftHalf,
        highAlong: platformLiftAlong + liftHalf,
    };
    addSlabAroundShaft(
        slotHalfWidth,
        deckHalfWidth,
        -deckHalfLength,
        deckHalfLength,
        platformLiftWell,
        mezzanineY,
        passageThickness,
        treadMaterial,
        'UndergroundDistributionMezzanineFloor',
        true,
    );
    addSlab(
        -deckHalfWidth,
        -slotHalfWidth,
        -deckHalfLength,
        deckHalfLength,
        mezzanineY,
        passageThickness,
        treadMaterial,
        'UndergroundDistributionMezzanineFloor',
        true,
    );
    // Both ends of the well are decked — that is where each flight lands.
    for (const direction of [-1, 1]) {
        addSlab(
            -slotHalfWidth,
            slotHalfWidth,
            Math.min(direction * slotEndAlong, direction * deckHalfLength),
            Math.max(direction * slotEndAlong, direction * deckHalfLength),
            mezzanineY,
            passageThickness,
            treadMaterial,
            'UndergroundMezzanineStairLanding',
            true,
        );
    }
    addOrientedBox(
        access,
        frameMaterial,
        centralMezzanineWidth,
        0.18,
        centralMezzanineLength,
        cx,
        mezzanineRoofY,
        cz,
        angleY,
        'UndergroundDistributionMezzanineCeiling',
    );
    // Guards: both sides of the stair well, both outer deck edges (broken only
    // where a cross-passage leaves), and both deck ends.
    for (const side of [-1, 1]) {
        addGuardRail(side * slotHalfWidth, 0, railThickness, slotEndAlong * 2);
        // The passage on this side leaves through the outer edge; rail the rest.
        const railFromAlong = side > 0 ? -deckHalfLength : -slotEndAlong;
        const railToAlong = side > 0 ? slotEndAlong : deckHalfLength;
        addGuardRail(
            side * deckHalfWidth,
            (railFromAlong + railToAlong) * 0.5,
            railThickness,
            railToAlong - railFromAlong,
        );
        addGuardRail(0, side * deckHalfLength, centralMezzanineWidth, railThickness);
    }
    // Mezzanine lighting. Every fixture used to hang below this deck, leaving
    // the concourse, the passages and both exit stairs pitch black.
    for (let along = -15; along <= 15; along += 6) {
        for (const side of [-1, 1]) {
            addOrientedBox(
                access,
                lightMaterial,
                1.2,
                0.12,
                0.6,
                cx + right.x * (side * 3.2) + forward.x * along,
                mezzanineRoofY - 0.18,
                cz + right.z * (side * 3.2) + forward.z * along,
                angleY,
                'UndergroundMezzanineLight',
            );
        }
    }
    yield { phase: 'station-access-mezzanine', stop: stopId };

    // ── Cross-passages, stair wells and lifts ─────────────────────────────
    const addPassage = (along, innerRight, outerRight, options = {}) => {
        const { stairOpening = null, roofShaft = null } = options;
        const lowRight = Math.min(innerRight, outerRight);
        const highRight = Math.max(innerRight, outerRight);
        const lowAlong = along - UNDERGROUND_ACCESS_PASSAGE_WIDTH_M * 0.5;
        const highAlong = along + UNDERGROUND_ACCESS_PASSAGE_WIDTH_M * 0.5;
        addSlab(
            lowRight,
            highRight,
            lowAlong,
            highAlong,
            mezzanineY,
            passageThickness,
            treadMaterial,
            'UndergroundMezzanineCrossPassageFloor',
            true,
        );
        addSlabAroundShaft(
            lowRight,
            highRight,
            lowAlong,
            highAlong,
            roofShaft,
            mezzanineRoofY + 0.09,
            0.18,
            frameMaterial,
            'UndergroundMezzanineCrossPassageRoof',
            false,
        );
        // Fore and aft walls. The flight climbs out through an opening in the
        // one on its own side; without it that wall is a slab across the stair.
        for (const side of [-1, 1]) {
            const wallAlong = along + side * UNDERGROUND_ACCESS_PASSAGE_WIDTH_M * 0.5;
            const wallSpans = stairOpening && side === stairOpening.alongSide
                ? [
                    [lowRight, Math.min(highRight, stairOpening.lowRight)],
                    [Math.max(lowRight, stairOpening.highRight), highRight],
                ]
                : [[lowRight, highRight]];
            for (const [fromRight, toRight] of wallSpans) {
                const wallWidth = toRight - fromRight;
                if (wallWidth <= 0.05) continue;
                const wallRight = (fromRight + toRight) * 0.5;
                addOrientedBox(
                    access,
                    frameMaterial,
                    wallWidth,
                    passageHeight,
                    0.10,
                    cx + right.x * wallRight + forward.x * wallAlong,
                    mezzanineY + passageHeight * 0.5,
                    cz + right.z * wallRight + forward.z * wallAlong,
                    angleY,
                    'UndergroundMezzanineCrossPassageWall',
                );
            }
        }
        // Seal the far end. It used to open straight into unmodelled soil.
        addOrientedBox(
            access,
            frameMaterial,
            0.12,
            passageHeight,
            UNDERGROUND_ACCESS_PASSAGE_WIDTH_M,
            cx + right.x * outerRight + forward.x * along,
            mezzanineY + passageHeight * 0.5,
            cz + right.z * outerRight + forward.z * along,
            angleY,
            'UndergroundMezzanineCrossPassageEndWall',
        );
        const lightCount = Math.max(1, Math.round(Math.abs(outerRight - innerRight) / 4));
        for (let i = 0; i < lightCount; i++) {
            const lightRight = innerRight
                + (outerRight - innerRight) * ((i + 0.5) / lightCount);
            addOrientedBox(
                access,
                lightMaterial,
                1.2,
                0.12,
                0.6,
                cx + right.x * lightRight + forward.x * along,
                mezzanineRoofY - 0.18,
                cz + right.z * lightRight + forward.z * along,
                angleY,
                'UndergroundMezzanineLight',
            );
        }
    };

    for (const direction of [-1, 1]) {
        yield {
            phase: direction < 0 ? 'station-access-north' : 'station-access-south',
            stop: stopId,
        };
        const passageAlong = direction * UNDERGROUND_ACCESS_CORE_ALONG_M;
        const externalStairRight = direction * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M;
        const wellStartAlong = direction * UNDERGROUND_STAIR_WELL_START_ALONG_M;
        // The climb to the street is laid out from the RISE, at a fixed stair
        // pitch with landings — so a deep station gets a longer inclined shaft
        // instead of the same fixed run turned into a ladder. Everything above
        // (well, shaft walls, entrance head) sizes itself from where that climb
        // actually ends rather than from a constant top-of-stair offset.
        const accessPlan = planUndergroundAccessStairs(mezzanineY, surfaceY, {
            startAlongM: wellStartAlong,
            direction,
        });
        const topAlong = accessPlan.segments.length > 0
            ? accessPlan.topAlongM
            : direction * UNDERGROUND_ACCESS_TOP_ALONG_M;
        entranceTopAlongByDirection[direction] = topAlong;
        if (accessPlan.segments.length > 0 && Array.isArray(entranceCuts)) {
            const entranceCut = undergroundStationEntranceCutout({
                stopId,
                centerX: cx,
                centerZ: cz,
                angleY,
                direction,
                topAlongM: topAlong,
            });
            if (entranceCut) entranceCuts.push(entranceCut);
        }
        // The flight from the platform stops at the deck it lands on, instead
        // of running its last treads under the passage floor slab.
        addUndergroundStairFlight(
            access,
            cx,
            cz,
            angleY,
            0,
            direction * 2,
            direction * slotEndAlong,
            platformY,
            mezzanineY,
            treadMaterial,
            frameMaterial,
            direction < 0 ? 'UndergroundIslandNorthLowerFlight' : 'UndergroundIslandSouthLowerFlight',
        );
        const wellLowRight = Math.min(
            externalStairRight - UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M,
            externalStairRight + UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M,
        );
        const wellHighRight = Math.max(
            externalStairRight - UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M,
            externalStairRight + UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M,
        );
        // The passage starts at the deck edge and bridges over the track. Only
        // the street-lift side runs past the well, to reach the lift.
        const passageOuterRight = direction > 0
            ? streetLiftRight + liftHalf
            : externalStairRight - UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M;
        addPassage(passageAlong, direction * deckHalfWidth, passageOuterRight, {
            stairOpening: {
                alongSide: direction,
                lowRight: wellLowRight,
                highRight: wellHighRight,
            },
            roofShaft: direction > 0
                ? {
                    lowRight: streetLiftRight - liftHalf,
                    highRight: streetLiftRight + liftHalf,
                    lowAlong: passageAlong - liftHalf,
                    highAlong: passageAlong + liftHalf,
                }
                : null,
        });
        // The exit climb lives entirely in the well, starting at the passage
        // wall it climbs through. One flight when the mezzanine is barely below
        // the street, several with landings when the station is deep.
        const flightPrefix = direction < 0
            ? 'UndergroundIslandNorthUpper' : 'UndergroundIslandSouthUpper';
        accessPlan.segments.forEach((segment, index) => {
            if (segment.kind === 'flight') {
                addUndergroundStairFlight(
                    access,
                    cx,
                    cz,
                    angleY,
                    externalStairRight,
                    segment.fromAlongM,
                    segment.toAlongM,
                    segment.fromY,
                    segment.toY,
                    treadMaterial,
                    frameMaterial,
                    `${flightPrefix}Flight${index}`,
                );
                return;
            }
            // Landing slab — walkable, same width as the flights it joins.
            const landingLength = Math.abs(segment.toAlongM - segment.fromAlongM);
            const landingAlong = (segment.fromAlongM + segment.toAlongM) * 0.5;
            const landing = new THREE.Mesh(
                new THREE.BoxGeometry(UNDERGROUND_ACCESS_STAIR_WIDTH_M, 0.12, landingLength),
                treadMaterial,
            );
            landing.name = `${flightPrefix}Landing${index}`;
            landing.userData.walkableSurface = true;
            landing.castShadow = true;
            landing.receiveShadow = true;
            landing.rotation.y = angleY;
            landing.position.set(
                cx + right.x * externalStairRight + forward.x * landingAlong,
                segment.toY - 0.06,
                cz + right.z * externalStairRight + forward.z * landingAlong,
            );
            access.add(landing);
        });
        const shaftHeight = surfaceY - mezzanineY;
        const wellEndAlong = topAlong + direction * 0.175;
        const shaftCenterAlong = (wellStartAlong + wellEndAlong) * 0.5;
        const shaftWallLength = Math.abs(wellEndAlong - wellStartAlong);
        for (const lateralSide of [-1, 1]) {
            const shaftWallRight = externalStairRight
                + lateralSide * (UNDERGROUND_ACCESS_STAIR_WIDTH_M * 0.5
                    + UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M * 0.5);
            addOrientedBox(
                access,
                frameMaterial,
                UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M,
                shaftHeight,
                shaftWallLength,
                cx + right.x * shaftWallRight + forward.x * shaftCenterAlong,
                mezzanineY + shaftHeight * 0.5,
                cz + right.z * shaftWallRight + forward.z * shaftCenterAlong,
                angleY,
                'UndergroundUpperStairShaftWall',
            );
        }
        // Head of the well, from the passage roof up to the entrance roof.
        const headBottomY = mezzanineRoofY + 0.18;
        const headHeight = surfaceY + METRO_ENTRANCE_HEIGHT_M - headBottomY;
        addOrientedBox(
            access,
            frameMaterial,
            UNDERGROUND_ACCESS_SHAFT_HALF_WIDTH_M * 2,
            headHeight,
            UNDERGROUND_ACCESS_SHAFT_WALL_THICKNESS_M,
            cx + right.x * externalStairRight + forward.x * wellStartAlong,
            headBottomY + headHeight * 0.5,
            cz + right.z * externalStairRight + forward.z * wellStartAlong,
            angleY,
            'UndergroundStairWellHeadWall',
        );
        const landing = addOrientedBox(
            access,
            treadMaterial,
            UNDERGROUND_ACCESS_STAIR_WIDTH_M + 0.35,
            0.14,
            UNDERGROUND_STREET_LANDING_DEPTH_M,
            cx + right.x * externalStairRight + forward.x * topAlong,
            surfaceY - 0.07,
            cz + right.z * externalStairRight + forward.z * topAlong,
            angleY,
            'UndergroundStreetLanding',
        );
        landing.userData.walkableSurface = true;
        // One fixture in each well, under the entrance roof.
        addOrientedBox(
            access,
            lightMaterial,
            1.4,
            0.12,
            0.7,
            cx + right.x * externalStairRight + forward.x * (topAlong - direction * 3),
            surfaceY + METRO_ENTRANCE_HEIGHT_M - 0.25,
            cz + right.z * externalStairRight + forward.z * (topAlong - direction * 3),
            angleY,
            'UndergroundStairWellLight',
        );
    }
    yield { phase: 'station-access-lifts', stop: stopId };
    addUndergroundLiftShaft(
        access,
        cx,
        cz,
        angleY,
        platformLiftRight,
        platformLiftAlong,
        platformY,
        mezzanineY,
        frameMaterial,
        'UndergroundPlatformLift',
    );
    addUndergroundLiftShaft(
        access,
        cx,
        cz,
        angleY,
        streetLiftRight,
        UNDERGROUND_ACCESS_CORE_ALONG_M,
        mezzanineY,
        surfaceY,
        frameMaterial,
        'UndergroundStreetLift',
        { extendAboveTopM: 2.55 },
    );
    target.add(access);
    return { entranceTopAlongByDirection };
}

function addFlightRailings(
    target,
    material,
    cx,
    cz,
    angleY,
    centerRight,
    startAlong,
    endAlong,
    startY,
    endY,
) {
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const railHeight = 1.08;
    const postSpacing = 1.45;
    const postCount = Math.max(2, Math.ceil(ELEVATED_STAIR_FLIGHT_RUN_M / postSpacing));

    for (const side of [-1, 1]) {
        const edgeRight = centerRight + side * (ELEVATED_STAIR_FLIGHT_WIDTH_M * 0.5 - 0.04);
        for (const heightOffset of [railHeight * 0.55, railHeight]) {
            addBeamBetween(
                target,
                material,
                pointInStationFrame(cx, cz, right, forward, edgeRight, startAlong, startY + heightOffset),
                pointInStationFrame(cx, cz, right, forward, edgeRight, endAlong, endY + heightOffset),
                0.065,
            );
        }
        for (let i = 0; i <= postCount; i++) {
            const t = i / postCount;
            const along = startAlong + (endAlong - startAlong) * t;
            const treadY = startY + (endY - startY) * t;
            addOrientedBox(
                target,
                material,
                0.07,
                railHeight,
                0.07,
                cx + right.x * edgeRight + forward.x * along,
                treadY + railHeight * 0.5,
                cz + right.z * edgeRight + forward.z * along,
                angleY,
            );
        }
    }
}

function addElevatedStairFlight(
    target,
    cx,
    cz,
    angleY,
    centerRight,
    startAlong,
    endAlong,
    startY,
    endY,
    stepCount,
    treadMaterial,
    frameMaterial,
    name,
) {
    const flight = new THREE.Group();
    flight.name = name;
    flight.userData.stepCount = stepCount;
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const stepDepth = ELEVATED_STAIR_FLIGHT_RUN_M / stepCount;
    const treadThickness = 0.075;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const steps = new THREE.InstancedMesh(geometry, treadMaterial, stepCount);
    steps.name = `${name}Treads`;
    steps.userData.walkableSurface = true;
    steps.castShadow = true;
    steps.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angleY);
    const scale = new THREE.Vector3();

    for (let i = 0; i < stepCount; i++) {
        const t = i / stepCount;
        const along = startAlong + (endAlong - startAlong) * ((i + 0.5) / stepCount);
        const treadY = startY + (endY - startY) * t;
        position.set(
            cx + right.x * centerRight + forward.x * along,
            treadY - treadThickness * 0.5,
            cz + right.z * centerRight + forward.z * along,
        );
        scale.set(ELEVATED_STAIR_FLIGHT_WIDTH_M, treadThickness, stepDepth + 0.035);
        matrix.compose(position, quaternion, scale);
        steps.setMatrixAt(i, matrix);
    }
    steps.instanceMatrix.needsUpdate = true;
    flight.add(steps);

    // Two shallow steel stringers carry the treads without creating the old
    // solid concrete wedge beneath the staircase.
    for (const lateral of [-0.58, 0.58]) {
        addBeamBetween(
            flight,
            frameMaterial,
            pointInStationFrame(
                cx,
                cz,
                right,
                forward,
                centerRight + lateral,
                startAlong,
                startY - 0.20,
            ),
            pointInStationFrame(
                cx,
                cz,
                right,
                forward,
                centerRight + lateral,
                endAlong,
                endY - 0.20,
            ),
            0.13,
        );
    }
    addFlightRailings(
        flight,
        frameMaterial,
        cx,
        cz,
        angleY,
        centerRight,
        startAlong,
        endAlong,
        startY,
        endY,
    );
    target.add(flight);
}

function addLandingRailing(
    target,
    material,
    cx,
    cz,
    angleY,
    centerRight,
    width,
    along,
    y,
    side,
) {
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const railHeight = 1.08;
    const edgeAlong = along + side * ELEVATED_STAIR_LANDING_DEPTH_M * 0.5;
    const left = centerRight - width * 0.5;
    const rightEdge = centerRight + width * 0.5;
    addBeamBetween(
        target,
        material,
        pointInStationFrame(cx, cz, right, forward, left, edgeAlong, y + railHeight),
        pointInStationFrame(cx, cz, right, forward, rightEdge, edgeAlong, y + railHeight),
        0.07,
    );
    for (const edgeRight of [left, centerRight, rightEdge]) {
        addOrientedBox(
            target,
            material,
            0.07,
            railHeight,
            0.07,
            cx + right.x * edgeRight + forward.x * edgeAlong,
            y + railHeight * 0.5,
            cz + right.z * edgeRight + forward.z * edgeAlong,
            angleY,
        );
    }
}

function createLiftSignMaterial() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#155eaa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 64px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♿  ↕', canvas.width * 0.5, canvas.height * 0.52);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
}

function addElevatedLift(
    target,
    cx,
    cz,
    angleY,
    platformTopY,
    centerRight,
    along,
    frameMaterial,
    groundLocalY = 0,
) {
    const lift = new THREE.Group();
    lift.name = 'ElevatedStationLift';
    lift.userData.accessible = true;
    lift.userData.servedLevels = [0, 1];
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const {
        liftBaseY,
        liftTopY,
        liftShaftHeight: shaftHeight,
        liftShaftCenterY: shaftCenterY,
    } = resolveElevatedStationAccessHeights(platformTopY, groundLocalY);
    const half = ELEVATED_LIFT_SIZE_M * 0.5;
    const center = pointInStationFrame(cx, cz, right, forward, centerRight, along, 0);
    const glassMaterial = new THREE.MeshPhysicalMaterial({
        color: 0x9fc8d6,
        transparent: true,
        opacity: 0.30,
        roughness: 0.15,
        metalness: 0.05,
        // See the glass note above: transmission costs a whole extra scene
        // render per frame and buys only refraction.
        side: THREE.DoubleSide,
    });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x68737d, metalness: 0.75, roughness: 0.3 });

    for (const lateral of [-half, half]) {
        for (const longitudinal of [-half, half]) {
            addOrientedBox(
                lift,
                frameMaterial,
                0.12,
                shaftHeight,
                0.12,
                center.x + right.x * lateral + forward.x * longitudinal,
                shaftCenterY,
                center.z + right.z * lateral + forward.z * longitudinal,
                angleY,
            );
        }
    }
    for (const longitudinal of [-half, half]) {
        addOrientedBox(
            lift,
            glassMaterial,
            ELEVATED_LIFT_SIZE_M - 0.18,
            shaftHeight - 0.25,
            0.045,
            center.x + forward.x * longitudinal,
            shaftCenterY,
            center.z + forward.z * longitudinal,
            angleY,
        );
    }
    addOrientedBox(
        lift,
        glassMaterial,
        0.045,
        shaftHeight - 0.25,
        ELEVATED_LIFT_SIZE_M - 0.18,
        center.x + right.x * half,
        shaftCenterY,
        center.z + right.z * half,
        angleY,
    );
    // Two clearly articulated landings/doors make the shaft read as a lift,
    // even though vertical travel is not animated yet.
    for (const [floorY, doorName] of [
        [liftBaseY, 'ElevatedLiftGroundDoor'],
        [platformTopY, 'ElevatedLiftPlatformDoor'],
    ]) {
        addOrientedBox(
            lift,
            doorMaterial,
            0.06,
            2.15,
            ELEVATED_LIFT_SIZE_M * 0.72,
            center.x - right.x * half,
            floorY + 1.075,
            center.z - right.z * half,
            angleY,
            doorName,
        );
    }
    addOrientedBox(
        lift,
        frameMaterial,
        ELEVATED_LIFT_SIZE_M + 0.12,
        0.18,
        ELEVATED_LIFT_SIZE_M + 0.12,
        center.x,
        liftTopY + 0.09,
        center.z,
        angleY,
        'ElevatedLiftRoof',
    );
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.68), createLiftSignMaterial());
    sign.name = 'ElevatedLiftAccessibleSign';
    sign.position.set(
        center.x - right.x * (half + 0.04),
        platformTopY + 1.65,
        center.z - right.z * (half + 0.04),
    );
    sign.rotation.y = angleY + Math.PI / 2;
    lift.add(sign);
    target.add(lift);
}

function* addElevatedStationAccess(target, cx, cz, angleY, platformTopY, treadMaterial, frameMaterial, groundLocalY = 0, stopId = null) {
    const access = new THREE.Group();
    access.name = 'ElevatedStationStairs';
    access.userData.layout = 'switchback';
    access.userData.flightCount = 2;
    access.userData.stepCount = STATION_STAIR_STEP_COUNT;
    const layout = getElevatedAccessLayout();
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const halfRun = ELEVATED_STAIR_FLIGHT_RUN_M * 0.5;
    const halfSteps = STATION_STAIR_STEP_COUNT / 2;
    const { middleY, groundY } = resolveElevatedStationAccessHeights(platformTopY, groundLocalY);
    const landingThickness = 0.12;
    const topLandingInner = layout.platformOuter;
    const topLandingOuter = layout.liftCenterRight - ELEVATED_LIFT_SIZE_M * 0.5;
    const topLandingWidth = topLandingOuter - topLandingInner;
    const stairLandingInner = layout.innerFlightCenterRight - ELEVATED_STAIR_FLIGHT_WIDTH_M * 0.5;
    const stairLandingOuter = layout.outerFlightCenterRight + ELEVATED_STAIR_FLIGHT_WIDTH_M * 0.5;
    const stairLandingWidth = stairLandingOuter - stairLandingInner;

    addElevatedStairFlight(
        access,
        cx,
        cz,
        angleY,
        layout.innerFlightCenterRight,
        -halfRun,
        halfRun,
        platformTopY,
        middleY,
        halfSteps,
        treadMaterial,
        frameMaterial,
        'ElevatedStationUpperFlight',
    );
    yield { phase: 'station-access-upper-flight', stop: stopId };
    addElevatedStairFlight(
        access,
        cx,
        cz,
        angleY,
        layout.outerFlightCenterRight,
        halfRun,
        -halfRun,
        middleY,
        groundY,
        halfSteps,
        treadMaterial,
        frameMaterial,
        'ElevatedStationLowerFlight',
    );
    yield { phase: 'station-access-lower-flight', stop: stopId };

    const addLanding = (name, centerRight, width, along, y) => {
        const landing = addOrientedBox(
            access,
            treadMaterial,
            width,
            landingThickness,
            ELEVATED_STAIR_LANDING_DEPTH_M,
            cx + right.x * centerRight + forward.x * along,
            y - landingThickness * 0.5,
            cz + right.z * centerRight + forward.z * along,
            angleY,
            name,
        );
        landing.userData.walkableSurface = true;
        return landing;
    };
    addLanding(
        'ElevatedStationTopLanding',
        (topLandingInner + topLandingOuter) * 0.5,
        topLandingWidth,
        layout.topLandingAlong,
        platformTopY,
    );
    addLanding(
        'ElevatedStationMidLanding',
        (stairLandingInner + stairLandingOuter) * 0.5,
        stairLandingWidth,
        layout.middleLandingAlong,
        middleY,
    );
    addLanding(
        'ElevatedStationGroundLanding',
        layout.outerFlightCenterRight,
        ELEVATED_STAIR_FLIGHT_WIDTH_M,
        layout.topLandingAlong,
        groundY,
    );
    addLandingRailing(
        access,
        frameMaterial,
        cx,
        cz,
        angleY,
        (stairLandingInner + stairLandingOuter) * 0.5,
        stairLandingWidth,
        layout.middleLandingAlong,
        middleY,
        1,
    );
    addLandingRailing(
        access,
        frameMaterial,
        cx,
        cz,
        angleY,
        layout.outerFlightCenterRight,
        ELEVATED_STAIR_FLIGHT_WIDTH_M,
        layout.topLandingAlong,
        groundY,
        -1,
    );
    target.add(access);
    yield { phase: 'station-access-landings', stop: stopId };
    addElevatedLift(
        target,
        cx,
        cz,
        angleY,
        platformTopY,
        layout.liftCenterRight,
        layout.topLandingAlong,
        frameMaterial,
        groundLocalY,
    );
}

function addElevatedPlatformRailing(target, cx, cz, angleY, platformTopY, platformLength, material) {
    const railing = new THREE.Group();
    railing.name = 'ElevatedStationRailing';
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const outerOffset = PLATFORM_WIDTH_M * 0.5 - 0.10;
    const access = getElevatedAccessLayout();
    const openingPadding = 0.14;
    const openingStart = access.topLandingAlong
        - ELEVATED_STAIR_LANDING_DEPTH_M * 0.5
        - openingPadding;
    const openingEnd = access.topLandingAlong
        + ELEVATED_STAIR_LANDING_DEPTH_M * 0.5
        + openingPadding;
    const segments = [
        [-platformLength * 0.5, Math.max(-platformLength * 0.5, openingStart)],
        [Math.min(platformLength * 0.5, openingEnd), platformLength * 0.5],
    ].filter(([start, end]) => end - start > 0.2);
    const railHeight = 1.15;
    const railThickness = 0.075;
    const postSpacing = 2.5;

    for (const [segmentStart, segmentEnd] of segments) {
        const sideLength = segmentEnd - segmentStart;
        const segmentCenterAlong = (segmentStart + segmentEnd) * 0.5;
        const segmentX = cx + right.x * outerOffset + forward.x * segmentCenterAlong;
        const segmentZ = cz + right.z * outerOffset + forward.z * segmentCenterAlong;
        for (const y of [railHeight * 0.52, railHeight]) {
            addOrientedBox(
                railing,
                material,
                railThickness,
                railThickness,
                sideLength,
                segmentX,
                platformTopY + y,
                segmentZ,
                angleY,
            );
        }
        const postCount = Math.max(1, Math.ceil(sideLength / postSpacing));
        for (let i = 0; i <= postCount; i++) {
            const along = segmentStart + sideLength * (i / postCount);
            addOrientedBox(
                railing,
                material,
                0.08,
                railHeight,
                0.08,
                cx + right.x * outerOffset + forward.x * along,
                platformTopY + railHeight * 0.5,
                cz + right.z * outerOffset + forward.z * along,
                angleY,
            );
        }
    }
    target.add(railing);
}

function createMetroSignMaterial() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1257a6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 96px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('(M)', canvas.width / 2, canvas.height / 2 + 4);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
}

// The sun's shadow map does not know the ground is above you. The terrain
// receives shadows but never CASTS them, so nothing occludes the light between a
// car driving overhead and a station floor 8 m below it — the car's silhouette
// lands on the platform. Enclosed tunnel interiors already dodge this by being
// MeshBasicMaterial (unlit, so unshadowable); station interiors are Standard and
// Lambert, so they have to opt out explicitly.
//
// Skips the surface entrance, which is above ground and should be shadowed like
// any other street furniture. Making the terrain a caster would fix this at the
// source, but it would add the whole streamed ground to the shadow pass every
// frame and invite self-shadow acne across it.
const ABOVE_GROUND_STATION_GROUPS = new Set(['MetroIslandStationEntrances']);
function dropSunShadowReceiptBelowGround(root) {
    root.traverse((object) => {
        if (!object.isMesh) return;
        for (let node = object; node && node !== root; node = node.parent) {
            if (ABOVE_GROUND_STATION_GROUPS.has(node.name)) return;
        }
        object.receiveShadow = false;
    });
}

function addMetroEntrance(
    target,
    cx,
    cz,
    angleY,
    material,
    groundLocalY = 0,
    entranceTopAlongByDirection = null,
) {
    // Sits ON the ground, which is groundLocalY in the station group's frame — not
    // necessarily the group origin. See the groundLocalY comment at the call site.
    const entrance = new THREE.Group();
    entrance.position.y = groundLocalY;
    entrance.name = 'MetroIslandStationEntrances';
    entrance.userData.exitCount = 2;
    entrance.userData.layout = 'two-end-stair-entrances-plus-lift';
    const right = getTrackRightVector(angleY);
    const forward = { x: Math.sin(angleY), z: Math.cos(angleY) };
    const wallHeight = METRO_ENTRANCE_HEIGHT_M;
    for (const direction of [-1, 1]) {
        const startAlong = direction * METRO_ENTRANCE_START_ALONG_M;
        const stairTopAlong = finiteOrNull(entranceTopAlongByDirection?.[direction]);
        const frontAlong = stairTopAlong === null
            ? direction * METRO_ENTRANCE_END_ALONG_M
            : stairTopAlong + direction * UNDERGROUND_STREET_LANDING_DEPTH_M * 0.5;
        const centerAlong = (startAlong + frontAlong) * 0.5;
        const entranceDepthM = Math.abs(frontAlong - startAlong);
        const centerRight = direction * UNDERGROUND_EXTERNAL_STAIR_CENTER_RIGHT_M;
        // The house covers the whole stair well, not just its last few metres:
        // roofing the mouth and leaving the rest of the well open behind it
        // read as an unfinished trench in the pavement.
        for (const lateralSide of [-1, 1]) {
            const lateral = centerRight
                + lateralSide * (METRO_ENTRANCE_HALF_WIDTH_M - METRO_ENTRANCE_WALL_THICKNESS_M * 0.5);
            addOrientedBox(
                entrance,
                material,
                METRO_ENTRANCE_WALL_THICKNESS_M,
                wallHeight,
                entranceDepthM,
                cx + right.x * lateral + forward.x * centerAlong,
                wallHeight * 0.5,
                cz + right.z * lateral + forward.z * centerAlong,
                angleY,
                'MetroEntranceWall',
            );
        }
        // No transverse "back" wall at the front: ascending passengers emerge
        // through the open front. The well head behind them is walled by
        // UndergroundStairWellHeadWall.
        addOrientedBox(
            entrance,
            material,
            METRO_ENTRANCE_HALF_WIDTH_M * 2 + 0.35,
            0.3,
            entranceDepthM + 0.35,
            cx + right.x * centerRight + forward.x * centerAlong,
            wallHeight + 0.15,
            cz + right.z * centerRight + forward.z * centerAlong,
            angleY,
            'MetroEntranceRoof',
        );
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), createMetroSignMaterial());
        sign.name = 'MetroEntranceSign';
        sign.position.set(
            cx + right.x * centerRight + forward.x * (frontAlong + direction * 0.08),
            2.45,
            cz + right.z * centerRight + forward.z * (frontAlong + direction * 0.08),
        );
        sign.rotation.y = angleY + (direction < 0 ? Math.PI : 0);
        entrance.add(sign);
    }
    const liftSign = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.85), createMetroSignMaterial());
    liftSign.name = 'MetroLiftEntranceSign';
    liftSign.position.set(
        cx
            + right.x * (UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M + UNDERGROUND_LIFT_SIZE_M * 0.5 + 0.05)
            + forward.x * UNDERGROUND_ACCESS_CORE_ALONG_M,
        2.15,
        cz
            + right.z * (UNDERGROUND_EXTERNAL_LIFT_CENTER_RIGHT_M + UNDERGROUND_LIFT_SIZE_M * 0.5 + 0.05)
            + forward.z * UNDERGROUND_ACCESS_CORE_ALONG_M,
    );
    liftSign.rotation.y = angleY + Math.PI / 2;
    entrance.add(liftSign);
    entrance.userData.openSide = 'two-opposite-outward-along-track';
    target.add(entrance);
}

function createPlatformMaterials() {
    const materials = {
        markMat: new THREE.MeshStandardMaterial({ color: 0xc9b458, roughness: 0.9 }),
        // No transmission: it forces a second full-scene render for refraction
        // that is not perceptible on a thin canopy.
        canopyMat: new THREE.MeshPhysicalMaterial({
            color: 0x7ec8e3,
            transparent: true,
            opacity: 0.72,
            roughness: 0.05,
            metalness: 0.1,
        }),
        postMat: new THREE.MeshStandardMaterial({
            color: 0x374151,
            metalness: 0.4,
            roughness: 0.5,
        }),
        platformMat: new THREE.MeshStandardMaterial({ color: 0x8e969e, roughness: 0.92 }),
        stairMat: new THREE.MeshStandardMaterial({
            color: 0x9aa4ad,
            metalness: 0.72,
            roughness: 0.42,
        }),
        entranceMat: new THREE.MeshStandardMaterial({ color: 0x6f7780, roughness: 0.9 }),
        undergroundLightMat: new THREE.MeshStandardMaterial({
            color: 0xf4e8bf,
            emissive: 0xe0c47d,
            emissiveIntensity: 1.6,
            roughness: 0.35,
            metalness: 0.1,
        }),
    };
    for (const material of Object.values(materials)) registerShared(material);
    return materials;
}

function disposePlatformMaterials() {
    if (!platformMaterials) return;
    for (const material of Object.values(platformMaterials)) {
        unregisterShared(material);
        material.dispose();
    }
    platformMaterials = null;
}

// Track geometry, ownership and anchor projection are immutable for a session.
// Preparing them inside build() repeated the same whole-route work every 300 m
// while the tram moved; keep the moving-window rebuild focused on the nearby
// station meshes it actually changes.
function prepareSessionTrackGeometry(tracks) {
    const rawTrackRoutes = [];
    for (let featureIndex = 0; featureIndex < tracks.length; featureIndex++) {
        const feature = tracks[featureIndex];
        const coords = feature.geometry && feature.geometry.coordinates;
        if (!coords || feature.geometry.type !== 'LineString') continue;
        const trackId = feature?.properties?.trackId ?? null;
        const trackIds = Array.isArray(feature?.properties?.trackIds)
            ? feature.properties.trackIds.map(String)
            : [];
        const properties = feature?.properties || {};
        const usesPhotoTrackFrame = plannerFeatureUsesPhotoFrame(properties, photoTrackFrame);
        rawTrackRoutes.push(...splitStationTrackRouteBySegmentOwners({
            routeKey: featureIndex,
            trackId,
            trackIds,
            segmentTrackIds: Array.isArray(properties.segmentTrackIds)
                ? properties.segmentTrackIds
                : null,
            properties,
            usesPhotoFrame: usesPhotoTrackFrame,
            points: coords.map((coord) => {
                const rawElevation = Number(coord[2]);
                const relativeHeightM = Number.isFinite(rawElevation) ? rawElevation : 0;
                const point = plannerScenePoint({
                    lon: coord[0],
                    lat: coord[1],
                    elevationM: relativeHeightM,
                    anchorLon,
                    anchorLat,
                    photoTrackFrame,
                    usePhotoFrame: usesPhotoTrackFrame,
                });
                return {
                    ...point,
                    lon: coord[0],
                    lat: coord[1],
                    relativeHeightM,
                };
            }),
        }));
    }
    const routes = prepareStationTrackRoutes(rawTrackRoutes);
    const segments = routes.flatMap(route => route.points.slice(0, -1).map((point, index) => {
        const next = route.points[index + 1];
        return {
            trackId: route.trackId,
            trackIds: route.trackIds || [],
            properties: route.properties || {},
            usesPhotoTrackFrame: !!route.usesPhotoFrame,
            x1: point.x,
            z1: point.z,
            dx: next.x - point.x,
            dz: next.z - point.z,
            e1: point.y,
            e2: next.y,
            relativeE1: point.relativeHeightM,
            relativeE2: next.relativeHeightM,
        };
    }));
    return { routes, segments };
}

function trackOwnerKey(value) {
    return value == null ? null : String(value);
}

function addTrackOwnerCandidate(index, key, value) {
    let candidates = index.get(key);
    if (!candidates) {
        candidates = [];
        index.set(key, candidates);
    }
    candidates.push(value);
}

// Station placement used to rescan every route chord for every stop after each
// 300 m observer-window move. Index immutable session geometry by both owner
// and coordinate frame once, so a stop only examines its own track run.
function indexSessionTrackCandidates(values, photoFrameFor) {
    const index = new Map();
    for (const value of values) {
        const frame = photoFrameFor(value) ? 'photo' : 'model';
        addTrackOwnerCandidate(index, `${frame}|*`, value);
        const direct = trackOwnerKey(value?.trackId);
        const owners = direct !== null
            ? [direct]
            : [...new Set((value?.trackIds || [])
                .map(trackOwnerKey)
                .filter(owner => owner !== null))];
        for (const owner of owners) {
            addTrackOwnerCandidate(index, `${frame}|${owner}`, value);
        }
    }
    return index;
}

function sessionTrackCandidates(index, stopTrackId, usesPhotoTrackFrame) {
    const frame = usesPhotoTrackFrame ? 'photo' : 'model';
    const owner = trackOwnerKey(stopTrackId);
    return index.get(`${frame}|${owner ?? '*'}`) || [];
}

function createPlatformGroup() {
    const g = new THREE.Group();
    g.name = 'TramPlatforms';
    g.userData.entranceCuts = [];
    markInspectionLayer(g, {
        id: 'platforms-stations',
        label: 'Platforms, canopies, and station access',
        category: 'Transport',
        source: 'world/platforms.js · stop/platform/station geometry',
        order: 170,
    });
    return g;
}

const MERGED_STATION_CHUNK_SIZE = 48;
const MERGEABLE_STATION_USER_DATA = new Set([
    'walkableSurface',
    'guard',
    'viaductSurfaceClearanceM',
]);

function stationPerfGroup(level) {
    if (level < 0) return 'platforms:underground';
    if (level > 0) return 'platforms:elevated';
    return 'platforms:surface';
}

function mergeableStationMesh(mesh) {
    if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isBatchedMesh) return false;
    if (!mesh.geometry || !mesh.material || Array.isArray(mesh.material)) return false;
    if (mesh.children.length > 0 || mesh.name === 'StationPlatformMarking') return false;
    if (mesh.material.transparent || mesh.material.map) return false;
    if (mesh.morphTargetInfluences || mesh.skeleton) return false;
    if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender
        || mesh.onAfterRender !== THREE.Object3D.prototype.onAfterRender
        || mesh.onBeforeShadow !== THREE.Object3D.prototype.onBeforeShadow
        || mesh.onAfterShadow !== THREE.Object3D.prototype.onAfterShadow) return false;
    return Object.keys(mesh.userData || {}).every(key => MERGEABLE_STATION_USER_DATA.has(key));
}

function stationMergeKey(mesh) {
    const data = mesh.userData || {};
    return [
        mesh.material.uuid,
        mesh.name || '',
        mesh.castShadow ? 1 : 0,
        mesh.receiveShadow ? 1 : 0,
        mesh.renderOrder || 0,
        data.walkableSurface === true ? 1 : 0,
        data.guard === true ? 1 : 0,
        Number(data.viaductSurfaceClearanceM) || 0,
    ].join('|');
}

// Merge only semantically identical static primitives, in bounded chunks. The
// station remains detached until every chunk is complete, so cancellation can
// never expose a half-built generation. Markings, mapped signs, instancing,
// walking/guard semantics, and surface-claim inputs remain intact.
function* mergeStationPrimitives(stationGroup, stopKey) {
    stationGroup.updateMatrixWorld(true);
    const rootInverse = stationGroup.matrixWorld.clone().invert();
    const buckets = new Map();
    stationGroup.traverse((object) => {
        if (!mergeableStationMesh(object)) return;
        const key = stationMergeKey(object);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(object);
    });

    for (const meshes of buckets.values()) {
        if (meshes.length < 2) continue;
        for (let start = 0; start < meshes.length; start += MERGED_STATION_CHUNK_SIZE) {
            const chunk = meshes.slice(start, start + MERGED_STATION_CHUNK_SIZE);
            if (chunk.length < 2) continue;
            yield { phase: 'station-merge', stop: stopKey, count: chunk.length };
            const transformed = chunk.map((mesh) => {
                const geometry = mesh.geometry.clone();
                geometry.applyMatrix4(rootInverse.clone().multiply(mesh.matrixWorld));
                return geometry;
            });
            const geometry = mergeGeometries(transformed, false);
            for (const item of transformed) item.dispose();
            if (!geometry) continue;
            const first = chunk[0];
            const merged = new THREE.Mesh(geometry, first.material);
            merged.name = first.name;
            merged.castShadow = first.castShadow;
            merged.receiveShadow = first.receiveShadow;
            merged.renderOrder = first.renderOrder;
            merged.userData = { ...first.userData };
            stationGroup.add(merged);

            const sourceGeometries = new Set();
            for (const mesh of chunk) {
                sourceGeometries.add(mesh.geometry);
                mesh.parent?.remove(mesh);
            }
            for (const sourceGeometry of sourceGeometries) {
                if (!isShared(sourceGeometry)) sourceGeometry.dispose();
            }
        }
    }
}

function stationTemplateKey({
    stop,
    level,
    cx,
    cz,
    angleY,
    baseY,
    stationTerrainY,
    groundLocalY,
    platformLength,
    platformWidth,
    surfaceCutAccessPlan,
}) {
    const compact = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const surfaceCutSignature = surfaceCutAccessPlan ? {
        centerX: compact(surfaceCutAccessPlan.centerX),
        centerZ: compact(surfaceCutAccessPlan.centerZ),
        rightX: compact(surfaceCutAccessPlan.rightX),
        rightZ: compact(surfaceCutAccessPlan.rightZ),
        angleY: compact(surfaceCutAccessPlan.angleY),
        railY: compact(surfaceCutAccessPlan.railY),
        groundY: compact(surfaceCutAccessPlan.groundY),
        formationHalfWidthM: compact(surfaceCutAccessPlan.formationHalfWidthM),
        platformSideM: compact(surfaceCutAccessPlan.platformSideM),
        sections: (surfaceCutAccessPlan.sections || []).map(section => ({
            kind: section.kind,
            plateauHalfM: compact(section.plateauHalfM),
            taperM: compact(section.taperM),
            rightHalfWidthM: compact(section.rightHalfWidthM),
        })),
        stair: surfaceCutAccessPlan.stair ? {
            widthM: compact(surfaceCutAccessPlan.stair.widthM),
            startRightM: compact(surfaceCutAccessPlan.stair.startRightM),
            endRightM: compact(surfaceCutAccessPlan.stair.endRightM),
            runM: compact(surfaceCutAccessPlan.stair.runM),
            stepCount: Number(surfaceCutAccessPlan.stair.stepCount) || 0,
            landingEndRightM: compact(surfaceCutAccessPlan.stair.landingEndRightM),
            portalEndRightM: compact(surfaceCutAccessPlan.stair.portalEndRightM),
        } : null,
    } : null;
    return JSON.stringify({
        stop: platformStopKey(stop),
        level,
        center: [compact(cx), compact(cz)],
        angleY: compact(angleY),
        baseY: compact(baseY),
        stationTerrainY: compact(stationTerrainY),
        groundLocalY: compact(groundLocalY),
        platformLength: compact(platformLength),
        platformWidth: compact(platformWidth),
        // The resolved geometry inputs above already encode whether this
        // station changed. Global terrain/rail revision counters would evict
        // every otherwise-identical template when one distant tile changed.
        photoGroundRevealed: !!photoTrackFrame && isPhotorealRevealed(),
        // Do not stringify plan.alignment: it is the full immutable rail
        // profile (thousands of samples) and used to cost ~40 ms on cache hits.
        surfaceCutAccessPlan: surfaceCutSignature,
    });
}

function cloneClockMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Three's Object3D.copy() JSON-clones userData. Station templates deliberately
// contain immutable instance matrices and per-person records, so that generic
// deep copy turned one cached-station clone into a 67 ms main-thread task. The
// template and every published clone treat nested metadata as read-only; copy
// only the userData container while retaining Three's exact subclass clone for
// geometry, materials, instance buffers, transforms, layers and callbacks.
function cloneStationObjectShallow(source) {
    const userData = source.userData;
    let clone;
    try {
        // JavaScript cannot observe this temporary value between the two
        // synchronous statements, and finally restores it if a custom clone
        // implementation throws.
        source.userData = {};
        clone = source.clone(false);
    } finally {
        source.userData = userData;
    }
    clone.userData = { ...(userData || {}) };
    return clone;
}

// Object3D.clone(true) recursively copies a large underground station in one
// uninterruptible call. Shallow-copy the same tree in small time-bounded
// batches; geometry/material resources remain shared exactly as with Three's
// native clone implementation.
function* cloneStationTreeCooperative(source, phase, stopKey, onObject = null) {
    const root = cloneStationObjectShallow(source);
    onObject?.(root);
    const pending = [{ source, clone: root }];
    let cursor = 0;
    let copied = 0;
    let sliceStartedAt = cloneClockMs();
    while (cursor < pending.length) {
        const entry = pending[cursor++];
        for (const child of entry.source.children) {
            const childClone = cloneStationObjectShallow(child);
            entry.clone.add(childClone);
            pending.push({ source: child, clone: childClone });
            onObject?.(childClone);
            copied += 1;
            if (copied % STATION_CLONE_CHUNK_SIZE === 0
                || cloneClockMs() - sliceStartedAt >= STATION_CLONE_BUDGET_MS) {
                yield { phase, stop: stopKey, count: copied };
                sliceStartedAt = cloneClockMs();
            }
        }
    }
    return root;
}

function noteTemplateResources(object, resources) {
    const candidates = [
        object.geometry,
        ...(Array.isArray(object.material)
            ? object.material
            : object.material ? [object.material] : []),
    ];
    for (const resource of candidates) {
        if (!resource || isShared(resource) || resources.has(resource)) continue;
        resources.add(resource);
    }
}

function* cacheStationTemplate(key, stationGroup, entranceCuts, stopKey) {
    if (stationTemplateCache.has(key)) return;
    const resources = new Set();
    const template = yield* cloneStationTreeCooperative(
        stationGroup,
        'station-cache-store',
        stopKey,
        object => noteTemplateResources(object, resources),
    );
    for (const resource of resources) registerShared(resource);
    stationTemplateCache.set(key, {
        template,
        resources,
        entranceCuts: entranceCuts.map(cut => structuredClone(cut)),
    });
}

function* cloneCachedStation(key, stopKey) {
    const cached = stationTemplateCache.get(key);
    if (!cached) return null;
    return {
        stationGroup: yield* cloneStationTreeCooperative(
            cached.template,
            'station-cache-clone',
            stopKey,
        ),
        entranceCuts: cached.entranceCuts.map(cut => structuredClone(cut)),
    };
}

function clearStationTemplateCache() {
    for (const cached of stationTemplateCache.values()) {
        for (const resource of cached.resources) unregisterShared(resource);
        disposeGroup(cached.template);
    }
    stationTemplateCache.clear();
}

function* build(
    g,
    centerLat,
    centerLon,
    railFormation,
    stationRevision = 0,
    { asyncGpuPrewarm = true, terrain = terrainReference, prewarm = true } = {},
) {
    if (!stops || stops.length === 0) return g;

    // Stops now sit at sidewalk level — no raised concrete slab. CANOPY_Y keeps
    // the canopy centre at the same absolute height it had when it rode a 0.4 m
    // slab (old PLATFORM_H 0.4 + CANOPY_H 2.6 = 3.0).
    const CANOPY_Y    = 3.0;
    const CANOPY_THICK = 0.18;
    const POST_R      = 0.08;
    const POST_H      = CANOPY_Y - CANOPY_THICK / 2;   // posts run ground → canopy underside
    const MARK_Y      = 0.036;                          // painted stop marking, just above the sidewalk

    const flatCenterLocal = plannerScenePoint({
        lon: centerLon,
        lat: centerLat,
        anchorLon,
        anchorLat,
    });
    const photoCenterLocal = photoTrackFrame
        ? plannerScenePoint({
            lon: centerLon,
            lat: centerLat,
            anchorLon,
            anchorLat,
            photoTrackFrame,
            usePhotoFrame: true,
        })
        : flatCenterLocal;
    const r2 = PLATFORM_RADIUS_M * PLATFORM_RADIUS_M;

    const {
        markMat,
        canopyMat,
        postMat,
        platformMat,
        stairMat,
        entranceMat,
        undergroundLightMat,
    } = platformMaterials;

    // Surface/elevated planner stops are shifted to the right-side platform.
    // Underground access retains the route centre because its platform is the
    // island between the two tracks; its street shafts branch right later.
    const ON_TRACK_EPS_M = 2.0;
    // The first cooperative stages always belong to the observer's nearest
    // stations. A superseded moving-window task can then be cancelled without
    // having spent its budget on distant stops first.
    const stopDistanceM = (stop) => {
        const lat = Number(stop?.lat);
        const lon = Number(stop?.lng ?? stop?.lon);
        return Number.isFinite(lat) && Number.isFinite(lon)
            ? distM(centerLat, centerLon, lat, lon)
            : Infinity;
    };
    const orderedStops = stops
        .map((stop, sourceIndex) => ({
            stop,
            sourceIndex,
            distanceM: stopDistanceM(stop),
        }))
        .sort((a, b) => a.distanceM - b.distanceM || a.sourceIndex - b.sourceIndex)
        .map(entry => entry.stop);
    for (const stop of orderedStops) {
        const lng = stop.lng ?? stop.lon;
        const stopTrackId = stop?.trackId ?? null;
        const photoTrackRoutes = sessionTrackCandidates(
            sessionTrackRoutesByOwner,
            stopTrackId,
            true,
        );
        const usesPhotoTrackFrame = !!photoTrackFrame && photoTrackRoutes.length > 0;
        const trackRoutes = usesPhotoTrackFrame
            ? photoTrackRoutes
            : sessionTrackCandidates(sessionTrackRoutesByOwner, stopTrackId, false);
        const trackSegs = sessionTrackCandidates(
            sessionTrackSegmentsByOwner,
            stopTrackId,
            usesPhotoTrackFrame,
        );
        const surfaceCutAccessPlan = usesPhotoTrackFrame
            ? null
            : findPlannerSurfaceCutStationAccessPlan(
                railFormation?.getSurfaceStationAccessPlans?.(),
                stop,
            );
        const photoStructure = usesPhotoTrackFrame && stopTrackId != null
            ? getPhotorealStationStructure(stop)
            : null;
        // Saved station levels describe the editor state, while photo-mode form
        // belongs to the same Google-terrain classification as the track. Until
        // that evidence exists, draw nothing rather than a wrong surface canopy.
        if (usesPhotoTrackFrame && stopTrackId != null && !photoStructure) continue;
        if (photoStructure === 'tunnel' && !canBuildPhotorealRigidStation(stop)) continue;
        const level = photoStructure === 'tunnel'
            ? -1
            : photoStructure === 'viaduct'
                ? 1
                : photoStructure === 'formation'
                    ? 0
                    : getPlannerStopLevel(stop);
        const stopElevationM = Number(stop.elevM);
        const stopRelativeHeightM = Number.isFinite(stopElevationM)
            ? stopElevationM
            : level * PLANNER_LEVEL_HEIGHT_M;
        const local = plannerScenePoint({
            lon: lng,
            lat: stop.lat,
            elevationM: stopRelativeHeightM,
            anchorLon,
            anchorLat,
            photoTrackFrame,
            usePhotoFrame: usesPhotoTrackFrame,
        });
        const authoredPlatform = !usesPhotoTrackFrame
            ? resolvePrimaryPlatformExtent(stop, { anchorLat, anchorLon })
            : null;
        const centerLocal = usesPhotoTrackFrame ? photoCenterLocal : flatCenterLocal;
        const dx = local.x - centerLocal.x, dz = local.z - centerLocal.z;
        if (dx * dx + dz * dz > r2) continue;
        if (terrain
            && !usesPhotoTrackFrame
            && finiteOrNull(
                terrain?.evidenceSceneYAtLocal?.(local.x, local.z),
            ) === null) {
            // Do not even enter the resumable station build while its local
            // terrain window is absent. The final, snapped platform position
            // is checked again below because a long authored extent may move
            // the structure away from the stop point.
            g.userData.terrainEvidenceIncomplete = true;
            (g.userData.terrainEvidenceGaps ||= []).push({
                stop: stop.stopId ?? stop.id ?? stop.name ?? null, x: local.x, z: local.z });
            continue;
        }
        // Planning/placement is its own bounded stage. The previous complete
        // generation remains live until all later station stages finish.
        yield { phase: 'station-position', stop: platformStopKey(stop) };
        let baseY = stopRelativeHeightM;
        const platformLength = authoredPlatform?.lengthM || (level < 0
            ? UNDERGROUND_PLATFORM_LENGTH_M
            : level > 0 ? ELEVATED_PLATFORM_LENGTH_M : SURFACE_PLATFORM_LENGTH_M);
        const platformWidth = authoredPlatform?.widthM || PLATFORM_WIDTH_M;
        const canonicalAnchor = resolvePlannerStationTrackAnchor({
            stopX: local.x,
            stopZ: local.z,
            stopTrackId,
            usePhotoFrame: usesPhotoTrackFrame,
            routes: trackRoutes,
            tangentHalfSpanM: Math.min(12, platformLength * 0.25),
            // An owned planner stop is saved on the editable tangent/control
            // polyline, not necessarily on its rounded rendered arc. Ownership
            // is sufficient to snap it; the old 12 m gate stranded stations at
            // exactly the sharper bends where the correction matters most.
            maxSnapDistanceM: stopTrackId == null ? ON_TRACK_EPS_M : Infinity,
        });

        // True point-to-segment distance (midpoint distance breaks on the
        // long straight segments of drawn routes).
        let angleY = 0, bestD2 = Infinity, bestProjX = local.x, bestProjZ = local.z, bestSeg = null;
        let bestTrackSceneY = null;
        let bestTrackRelativeHeightM = null;
        let bestFullLevel = null;
        for (const seg of trackSegs) {
            if (seg.usesPhotoTrackFrame !== usesPhotoTrackFrame) continue;
            if (!stationTrackRouteMatches(seg, stopTrackId)) continue;
            const len2 = seg.dx * seg.dx + seg.dz * seg.dz;
            if (len2 < 1e-9) continue;
            let t = ((local.x - seg.x1) * seg.dx + (local.z - seg.z1) * seg.dz) / len2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const px = seg.x1 + t * seg.dx, pz = seg.z1 + t * seg.dz;
            const d2 = (local.x - px) ** 2 + (local.z - pz) ** 2;
            const elevM = seg.e1 + (seg.e2 - seg.e1) * t;
            const relativeElevationM = seg.relativeE1
                + (seg.relativeE2 - seg.relativeE1) * t;
            if (d2 < bestD2) {
                bestD2 = d2;
                angleY = Math.atan2(seg.dx, seg.dz);
                bestProjX = px; bestProjZ = pz;
                bestSeg = seg;
                bestTrackSceneY = elevM;
                bestTrackRelativeHeightM = relativeElevationM;
            }
            const isFullLevel = !seg.usesPhotoTrackFrame
                && Math.abs(seg.e1 - baseY) <= 0.5
                && Math.abs(seg.e2 - baseY) <= 0.5;
            if (isFullLevel && (!bestFullLevel || d2 < bestFullLevel.d2)) {
                bestFullLevel = { seg, d2, px, pz, elevM, relativeElevationM };
            }
        }
        if (bestFullLevel && bestFullLevel.d2 <= bestD2 + 1) {
            bestSeg = bestFullLevel.seg;
            bestD2 = bestFullLevel.d2;
            bestProjX = bestFullLevel.px;
            bestProjZ = bestFullLevel.pz;
            // The platform, canopy, stairs and railings share the exact deck
            // height sampled from their own viaduct feature. If planner level
            // heights are tuned later, the whole station follows the deck.
            baseY = bestFullLevel.elevM;
            bestTrackSceneY = bestFullLevel.elevM;
            bestTrackRelativeHeightM = bestFullLevel.relativeElevationM;
            angleY = Math.atan2(bestSeg.dx, bestSeg.dz);
        } else if (bestSeg?.usesPhotoTrackFrame && Number.isFinite(bestTrackSceneY)) {
            // Same interpolation as rails.js: station track level is the fixed
            // authored tangent-frame profile, never the datum-relative c[2].
            baseY = bestTrackSceneY;
        }
        if (canonicalAnchor) {
            bestSeg = {
                trackId: canonicalAnchor.route.trackId,
                trackIds: canonicalAnchor.route.trackIds || [],
                properties: canonicalAnchor.route.properties || {},
                usesPhotoTrackFrame: !!canonicalAnchor.route.usesPhotoFrame,
                dx: canonicalAnchor.alongX,
                dz: canonicalAnchor.alongZ,
            };
            bestD2 = canonicalAnchor.distanceM ** 2;
            bestProjX = canonicalAnchor.x;
            bestProjZ = canonicalAnchor.z;
            bestTrackSceneY = canonicalAnchor.y;
            bestTrackRelativeHeightM = canonicalAnchor.relativeHeightM;
            baseY = canonicalAnchor.y;
            angleY = canonicalAnchor.angleY;
        }

        let cx = local.x, cz = local.z;
        const stationSnapRadiusM = stopTrackId != null ? 12 : ON_TRACK_EPS_M;
        if (bestSeg && (canonicalAnchor || bestD2 < stationSnapRadiusM * stationSnapRadiusM)) {
            // Right of travel = dir × up in this y-up frame: (-dz, dx).
            const len = Math.sqrt(bestSeg.dx * bestSeg.dx + bestSeg.dz * bestSeg.dz);
            const sideOffsetM = level < 0
                ? 0
                : getPlannerPlatformSideOffsetM(bestSeg.properties);
            cx = bestProjX + (-bestSeg.dz / len) * sideOffsetM;
            cz = bestProjZ + ( bestSeg.dx / len) * sideOffsetM;
        }
        if (surfaceCutAccessPlan) {
            angleY = surfaceCutAccessPlan.angleY;
            cx = surfaceCutAccessPlan.centerX
                + surfaceCutAccessPlan.rightX * surfaceCutAccessPlan.platformSideM;
            cz = surfaceCutAccessPlan.centerZ
                + surfaceCutAccessPlan.rightZ * surfaceCutAccessPlan.platformSideM;
        } else if (authoredPlatform) {
            // Authored endpoints describe the platform itself, not a point on
            // the rail centreline. Preserve its measured centre and bearing.
            cx = authoredPlatform.centerX;
            cz = authoredPlatform.centerZ;
            angleY = authoredPlatform.angleY;
        }

        const stationTerrainEvidenceY = usesPhotoTrackFrame
            ? null
            : terrain
                ? terrain.evidenceSceneYAtLocal?.(cx, cz)
                : 0;
        if (terrain
            && !usesPhotoTrackFrame
            && finiteOrNull(stationTerrainEvidenceY) === null) {
            // A platform, canopy, or access core without local ground evidence
            // is not a partial station. Leave the previous generation visible;
            // the terrain subscription below retries after the tile arrives.
            g.userData.terrainEvidenceIncomplete = true;
            (g.userData.terrainEvidenceGaps ||= []).push({
                stop: stop.stopId ?? stop.id ?? stop.name ?? null, x: cx, z: cz });
            continue;
        }

        const stationGroup = new THREE.Group();
        stationGroup.name = level < 0
            ? 'UndergroundPlannerStation'
            : level > 0 ? 'ElevatedPlannerStation' : 'SurfacePlannerStation';
        stationGroup.userData.stopId = stop.stopId ?? stop.id ?? null;
        stationGroup.userData.level = level;
        stationGroup.userData.surfaceCutStation = !!surfaceCutAccessPlan;
        stationGroup.userData.platformLengthM = platformLength;
        stationGroup.userData.platformWidthM = platformWidth;
        stationGroup.userData.platformExtentId = authoredPlatform?.id || null;
        stationGroup.userData.perfRenderGroup = stationPerfGroup(level);
        let stationTerrainY;
        // Where the GROUND is, which is not always where the group origin is: the
        // absolute-elevation branch below deliberately seats the origin on the datum
        // so the platform meets the authored rail, and a surface entrance placed at
        // origin+0.06 then floats by however far the terrain sits from the datum
        // (~4 m at Novi Terminal — the exits hanging in the air, and the fall-through,
        // since the ground cutout still opens at the real terrain height).
        let stationGroundSceneY;
        if (bestSeg?.usesPhotoTrackFrame) {
            const anchorLon = canonicalAnchor?.lon ?? lng;
            const anchorLat = canonicalAnchor?.lat ?? stop.lat;
            const groundTrackId = stopTrackId
                ?? bestSeg.trackId
                ?? (bestSeg.trackIds.length === 1 ? bestSeg.trackIds[0] : null);
            const authoredGroundOffsetM = typeof photoGroundOffsetAt === 'function'
                ? photoGroundOffsetAt(anchorLat, anchorLon, groundTrackId)
                : null;
            const placement = resolvePhotoStationVerticalPlacement({
                photoTrackFrame,
                lon: anchorLon,
                lat: anchorLat,
                trackRelativeHeightM: bestTrackRelativeHeightM ?? stopRelativeHeightM,
                trackSceneY: baseY,
                authoredGroundOffsetM,
                semanticLevel: level,
                levelHeightM: PLANNER_LEVEL_HEIGHT_M,
            });
            const trackSceneY = baseY;
            const dguGroundSceneY = placement?.groundSceneY ?? 0;
            const googleGroundSceneY = samplePhotorealBareEarthAt(cx, cz, {
                expectedGroundY: dguGroundSceneY,
                alongX: bestSeg.dx / Math.max(1e-9, Math.hypot(bestSeg.dx, bestSeg.dz)),
                alongZ: bestSeg.dz / Math.max(1e-9, Math.hypot(bestSeg.dx, bestSeg.dz)),
                acrossX: -bestSeg.dz / Math.max(1e-9, Math.hypot(bestSeg.dx, bestSeg.dz)),
                acrossZ: bestSeg.dx / Math.max(1e-9, Math.hypot(bestSeg.dx, bestSeg.dz)),
            });
            stationTerrainY = Number.isFinite(googleGroundSceneY)
                ? googleGroundSceneY
                : dguGroundSceneY;
            // Re-seat only the station group's ground origin. Its local track
            // offset changes by the opposite amount, leaving every platform
            // surface exactly on the immutable authored rail profile.
            baseY = trackSceneY - stationTerrainY;
            stationGroup.userData.photoTrackFrame = true;
            stationGroup.userData.authoredGroundOffsetM = placement?.groundOffsetM ?? null;
            stationGroup.userData.groundSource = Number.isFinite(googleGroundSceneY)
                ? 'google-bare-earth'
                : 'dgu-fallback';
            // Origin already IS the ground here (Google bare earth or DGU fallback).
            stationGroundSceneY = stationTerrainY;
        } else if (
            bestSeg
            && plannerFeatureUsesAbsoluteElevation(bestSeg.properties)
            && terrain
        ) {
            // c[2] is absolute EVRF2000 a.s.l. — convert to scene-Y the same way
            // the rail formation does (absoluteToSceneY = a.s.l. − anchorHeight)
            // and seat the group origin at 0, so the station sits ON the rail
            // instead of being stacked on the terrain drape and floating tens of
            // metres up (the reported hovering/upside-down shelters).
            baseY = terrain.absoluteToSceneY(baseY);
            stationTerrainY = 0;
            // Origin is the datum, so the ground is wherever the terrain actually is.
            stationGroundSceneY = stationTerrainEvidenceY;
        } else {
            stationTerrainY = stationTerrainEvidenceY;
            stationGroundSceneY = stationTerrainY;
        }
        if (surfaceCutAccessPlan) {
            // The access plan is already expressed in scene coordinates by the
            // rail formation. Seat this group on the same datum in every model
            // elevation regime; otherwise a legacy relative station adds bare
            // terrain to its rail height and lifts the whole bay back into soil.
            baseY = surfaceCutAccessPlan.railY;
            stationTerrainY = 0;
            stationGroundSceneY = surfaceCutAccessPlan.groundY;
        }
        stationGroup.position.y = stationTerrainY;
        // Ground height in the group's own frame: 0 everywhere except the
        // absolute-elevation branch, so no other station moves.
        const groundLocalY = Number.isFinite(stationGroundSceneY)
            ? stationGroundSceneY - stationTerrainY
            : 0;
        stationGroup.userData.groundLocalY = groundLocalY;
        const heavyRailSurface = level === 0 && stop.stationType === 'heavy-rail';
        const platformTopY = level === 0
            ? baseY + (heavyRailSurface ? 0.55 : 0.06)
            : baseY + (level > 0
                ? ELEVATED_WALKWAY_RISE_M + ELEVATED_PLATFORM_SURFACE_CLEARANCE_M
                : UNDERGROUND_ISLAND_PLATFORM_HEIGHT_M);

        const railFormationRevision = Number(railFormation?.revision) || 0;
        const templateKey = stationTemplateKey({
            stop,
            level,
            cx,
            cz,
            angleY,
            baseY,
            stationTerrainY,
            groundLocalY,
            platformLength,
            platformWidth,
            stationRevision,
            railFormationRevision,
            surfaceCutAccessPlan,
        });
        const stopKey = platformStopKey(stop);
        const cachedStation = yield* cloneCachedStation(templateKey, stopKey);
        if (cachedStation) {
            g.userData.entranceCuts.push(...cachedStation.entranceCuts);
            g.add(cachedStation.stationGroup);
            yield { phase: 'station-cache-hit', stop: stopKey };
            continue;
        }
        const entranceCutStart = g.userData.entranceCuts.length;
        yield { phase: 'station-shell', stop: platformStopKey(stop) };

        if (level === 0 && surfaceCutAccessPlan) {
            const surfaceCutAccess = addSurfaceCutStationAccess(
                stationGroup,
                surfaceCutAccessPlan,
                platformTopY,
                stationTerrainY,
                platformMat,
            );
            if (surfaceCutAccess) {
                const entranceCut = plannerSurfaceCutStationEntranceCutout(
                    surfaceCutAccessPlan,
                );
                if (entranceCut) g.userData.entranceCuts.push(entranceCut);
            }
        }

        if (level > 0) {
            const platformSlab = addOrientedBox(
                stationGroup,
                platformMat,
                platformWidth,
                PLATFORM_SLAB_THICKNESS_M,
                platformLength,
                cx,
                platformTopY - PLATFORM_SLAB_THICKNESS_M * 0.5,
                cz,
                angleY,
                'StationPlatformSlab',
            );
            platformSlab.userData.walkableSurface = true;
            platformSlab.userData.viaductSurfaceClearanceM = ELEVATED_PLATFORM_SURFACE_CLEARANCE_M;
            yield* addElevatedStationAccess(
                stationGroup,
                cx,
                cz,
                angleY,
                platformTopY,
                stairMat,
                postMat,
                groundLocalY,
                stationGroup.userData.stopId,
            );
            addElevatedPlatformRailing(
                stationGroup,
                cx,
                cz,
                angleY,
                platformTopY,
                platformLength,
                postMat,
            );
        }
        if (heavyRailSurface) {
            const platformSlab = addOrientedBox(
                stationGroup,
                platformMat,
                platformWidth,
                0.55,
                platformLength,
                cx,
                platformTopY - 0.275,
                cz,
                angleY,
                'HeavyRailStationPlatformSlab',
            );
            platformSlab.userData.walkableSurface = true;
        }
        if (level < 0) {
            // underground.js owns the island/hall shell. This layer adds two
            // independent stair routes, the mezzanine passages, lifts, and
            // the street entrances at the same route-centre reference point.
            const undergroundAccess = yield* addUndergroundIslandAccess(
                stationGroup,
                cx,
                cz,
                angleY,
                baseY,
                stairMat,
                postMat,
                undergroundLightMat,
                groundLocalY,
                {
                    stopId: stationGroup.userData.stopId,
                    entranceCuts: g.userData.entranceCuts,
                },
            );
            addMetroEntrance(
                stationGroup,
                cx,
                cz,
                angleY,
                entranceMat,
                groundLocalY,
                undergroundAccess?.entranceTopAlongByDirection,
            );
            dropSunShadowReceiptBelowGround(stationGroup);
        }

        yield { phase: 'station-signs', stop: platformStopKey(stop) };

        // Ground marking painted flat on the sidewalk in place of the old raised
        // slab: an outline band framing the stop footprint plus a dashed safety
        // strip along the track-side edge, all merged into one mesh per stop.
        if (level >= 0) {
            const markGeom = buildStopMarkingGeometry(platformWidth, platformLength);
            const marking = new THREE.Mesh(markGeom, markMat);
            marking.name = 'StationPlatformMarking';
            marking.position.set(cx, platformTopY + MARK_Y, cz);
            marking.rotation.y = angleY;
            marking.receiveShadow = true;
            stationGroup.add(marking);
        }

        const ux = Math.sin(angleY), uz = Math.cos(angleY);
        if (level >= 0) {
            const canopyGeom = new THREE.BoxGeometry(platformWidth + 0.6, CANOPY_THICK, platformLength + 0.4);
            const canopy = new THREE.Mesh(canopyGeom, canopyMat);
            canopy.position.set(cx, platformTopY + CANOPY_Y, cz);
            canopy.rotation.y = angleY;
            canopy.castShadow = true;
            stationGroup.add(canopy);

            const postGeom = new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 6);
            for (const s of [-1, 1]) {
                const post = new THREE.Mesh(postGeom, postMat);
                post.position.set(cx + ux * platformLength * 0.3 * s,
                                  platformTopY + POST_H / 2,
                                  cz + uz * platformLength * 0.3 * s);
                stationGroup.add(post);
            }
        }

        if (level >= 0) {
            const stopSignTex = getStopNameSignTexture(stop.name);
            const signMat = new THREE.MeshBasicMaterial({ map: stopSignTex, side: THREE.DoubleSide });
            const signGeo = new THREE.PlaneGeometry(platformLength * 0.7, 1.0);
            const nameSign = new THREE.Mesh(signGeo, signMat);
            nameSign.userData.perfRenderGroup = 'platforms:signs';
            nameSign.position.set(cx, platformTopY + CANOPY_Y - 0.6, cz);
            nameSign.rotation.y = angleY + Math.PI / 2;
            stationGroup.add(nameSign);
        }

        if (level >= 0) {
            yield { phase: 'station-people', stop: platformStopKey(stop) };
            const platformPeople = [];
            pushPlatformPeople(
                platformPeople,
                platformStopKey(stop),
                cx, cz, angleY,
                platformWidth, platformLength,
                // People are children of stationGroup, just like the platform.
                // stationGroup.position.y already supplies stationTerrainY;
                // adding it here again made photo-mode crowds float above stops.
                platformTopY,
            );
            const peopleGroup = buildWaitingPeopleGroup(platformPeople);
            if (peopleGroup.children.length > 0) stationGroup.add(peopleGroup);
        }

        yield* mergeStationPrimitives(stationGroup, stopKey);
        freezeStaticTransforms(stationGroup);
        for (let i = entranceCutStart; i < g.userData.entranceCuts.length; i++) {
            g.userData.entranceCuts[i].maxY = stationGroundSceneY + 1;
        }
        yield* cacheStationTemplate(
            templateKey,
            stationGroup,
            g.userData.entranceCuts.slice(entranceCutStart),
            stopKey,
        );
        g.add(stationGroup);
    }
    yield { phase: 'station-people-merge' };
    consolidateWaitingPeopleGroups(g);
    yield { phase: 'station-people-merge-complete' };
    if (prewarm) yield* prewarmDetachedObject(g, {
        renderer,
        camera,
        targetScene: scene,
        asyncShaders: asyncGpuPrewarm,
        label: 'station-gpu-prewarm',
        uploadBatch: asyncGpuPrewarm ? 1 : 4,
    });
    return g;
}

// Construction resolves station access before road/rail receiver clipping.
// The detached station, backed openings and support join that same boundary.
function* preparePlatformOpeningGroundSteps({ terrain, railFormation, registry, generation,
    centerX, centerZ, isCurrent, now = () => performance.now() }) {
    const ctx = sessionContextReference, previousState = activePlatformState, previousRoot = group;
    if (!ctx || pendingBuildTask || photoTrackFrame) throw Object.assign(new Error('Station sources are unavailable'), { code: 'ground-dependency-busy' });
    const sourceStops = stops, inputs = railFormation?.constructionInputs;
    const current = () => sessionContextReference === ctx && stops === sourceStops
        && group === previousRoot && activePlatformState === previousState && isCurrent();
    const check = () => { if (!current()) throw Object.assign(new Error('Station preparation expired'), { code: 'ground-generation-stale' }); };
    const centerLat = anchorLat - centerZ / (DEG_TO_RAD * EARTH_RADIUS_M);
    const centerLon = anchorLon + centerX / (DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD));
    const previousInputs = previousState?.constructionInputs;
    const unchanged = previousState?.managed === true && previousState.terrainRevision === terrain.revision
        && inputs && previousInputs
        && ['session', 'inputRevision', 'stopsSignature', 'photoFrame'].every(key => inputs[key] === previousInputs[key])
        && distM(centerLat, centerLon, previousState.centerLat, previousState.centerLon) <= STATION_REBUILD_M;
    if (unchanged) return Object.freeze({ entries: [], entrances: previousState.entrances,
        supportRead: previousState.supportRead, changedBounds: [], isCurrent: current, discard() {}, finalize: () => true });
    let root = createPlatformGroup(), ticket = null, gpuFence = null;
    let handedOff = false, committed = false, finalized = false, discarded = false;
    const discard = () => {
        if (discarded || finalized) return;
        discarded = true;
        if (ticket?.state === 'pending') ticket.discard();
        if (root) {
            const retiring = root;
            if (gpuFence) Promise.resolve(gpuFence).then(() => disposeGroup(retiring), () => disposeGroup(retiring));
            else disposeGroup(retiring);
        }
    };
    try {
        check();
        const building = build(root, centerLat, centerLon, railFormation, 0, { terrain, prewarm: false });
        try { for (;;) {
            check(); const next = building.next(); if (next.done) break;
            yield next.value;
        } } finally { building.return(); }
        check();
        if (root.userData.terrainEvidenceIncomplete) {
            // Name the stop and point: a silent busy retry is indistinguishable
            // from a world that stopped gaining ground (Split, 2026-09-16).
            const gaps = root.userData.terrainEvidenceGaps || [];
            const first = gaps[0];
            throw Object.assign(new Error('Station terrain evidence is incomplete'
                + (first ? ` at ${first.x.toFixed(1)},${first.z.toFixed(1)} (stop ${first.stop ?? '?'})` : '')
                + (gaps.length > 1 ? ` (+${gaps.length - 1})` : '')),
            { code: 'ground-dependency-busy', details: { gaps: gaps.slice(0, 8), gapCount: gaps.length } });
        }
        if (!root.children.length) { disposeGroup(root); root = null; }
        let supportRead = EMPTY_RECEIVER_SUPPORT_READ;
        if (root) {
            annotatePlatformSurfacePublication(root, generation);
            const colliderState = { published: false };
            root.userData.groundColliderState = colliderState;
            const pending = [root], geometries = new Set();
            let objects = 0, geometryBytes = 0, deadline = now() + .5;
            while (pending.length) {
                check();
                if (now() >= deadline) { yield { phase: 'station-resource-admission' }; deadline = now() + .5; }
                const object = pending.pop();
                if (++objects + pending.length + object.children.length > GROUND_GENERATION_LIMITS.openingSupport.maxObjects) {
                    throw Object.assign(new Error('Station objects exceed capacity'), { code: 'ground-generation-capacity' });
                }
                pending.push(...object.children);
                if (object.userData.surfaceClaim?.capabilities.support) {
                    object.userData.groundColliderFamily = 'authored-surfaces';
                    object.userData.groundColliderState = colliderState;
                }
                const geometry = object.geometry;
                if (!geometry || geometries.has(geometry)) continue;
                geometries.add(geometry);
                for (const attribute of [geometry.index, ...Object.values(geometry.attributes)]) {
                    geometryBytes += (attribute?.data || attribute)?.array?.byteLength || 0;
                }
                if (geometryBytes > GROUND_GENERATION_LIMITS.stations.maxGeometryBytes) {
                    throw Object.assign(new Error('Station geometry exceeds capacity'), { code: 'ground-generation-capacity' });
                }
            }
            supportRead = yield* captureReceiverMeshReadSteps({ root,
                include: mesh => mesh.userData.groundColliderFamily === 'authored-surfaces',
                revision: generation, ...GROUND_GENERATION_LIMITS.openingSupport, now, isCurrent: current });
        }
        const entrances = yield* captureStationGroundOpeningsSteps({ cuts: root?.userData.entranceCuts || [],
            supportRead, replacementKey: PLATFORM_SURFACE_PUBLICATION_KEY,
            maxCuts: PLANNER_ENTRANCE_CUT_MAX, limits: GROUND_GENERATION_LIMITS.openings, now, isCurrent: current });
        const state = { ...createPlatformState({ generation, root, centerLat, centerLon,
            stationRevision: 0, railFormationRevision: railFormation.revision }),
            managed: true, terrainRevision: terrain.revision, constructionInputs: inputs, supportRead, entrances };
        const changedBounds = [...(previousState?.entranceCuts || []), ...state.entranceCuts].map(cut => ({
            minX: Math.min(cut.x1, cut.x2) - cut.widthM * .5, maxX: Math.max(cut.x1, cut.x2) + cut.widthM * .5,
            minZ: Math.min(cut.z1, cut.z2) - cut.widthM * .5, maxZ: Math.max(cut.z1, cut.z2) + cut.widthM * .5,
        }));
        if (root) {
            freezeStaticTransforms(root);
            const upload = prewarmDetachedObject(root, { renderer, camera, targetScene: scene,
                asyncShaders: true, label: 'station:ground-upload', uploadBatch: 8, maxUploadBytes: 256 * 1024, sliceMs: 2 });
            try { for (;;) {
                check(); const next = upload.next(); if (next.done) break;
                gpuFence = next.value?.ready || null;
                yield next.value;
            } } finally { upload.return(); }
        }
        ticket = registry.begin({ key: PLATFORM_SURFACE_PUBLICATION_KEY, generation,
            parent: scene, retire: (_context, retiring) => disposeGroup(retiring) });
        const entry = { ticket, ...(root ? { root } : { clear: true }), isCurrent: current,
            commit() {
                if (group !== previousRoot || activePlatformState !== previousState) return false;
                committed = true;
                if (root) root.userData.groundColliderState.published = true;
                applyPlatformState(state, root); return true;
            },
            rollback() {
                if (!committed) return;
                if (root) root.userData.groundColliderState.published = false;
                applyPlatformState(previousState, previousRoot); committed = false;
            }, discard };
        handedOff = true;
        return Object.freeze({ entries: [entry], entrances, supportRead, changedBounds, isCurrent: current, discard,
            finalize() {
                if (!committed || finalized) return false;
                finalized = true; terrainRevisionDirty = false;
                noteWorldQueueIdle('platforms'); return true;
            } });
    } finally { if (!handedOff) discard(); }
}

function annotatePlatformSurfacePublication(root, generation) {
    const walk = (object, stationContext = null) => {
        let context = stationContext;
        const objectLevel = finiteOrNull(object?.userData?.level);
        if (objectLevel !== null) {
            context = {
                stationLevel: objectLevel,
                surfaceCutStation: object.userData.surfaceCutStation === true,
                stopId: object.userData.stopId ?? null,
            };
        }
        if (object?.isMesh) {
            markSurfaceClaim(object, platformSurfaceClaimInput({
                name: object.name,
                walkableSurface: object.userData?.walkableSurface === true,
                stationLevel: context?.stationLevel ?? 0,
                surfaceCutStation: context?.surfaceCutStation === true,
                stopId: context?.stopId ?? object.userData?.stopId ?? null,
            }, generation));
        }
        for (const child of object?.children || []) walk(child, context);
    };
    walk(root);
}

function emptyPlatformState(generation = 0) {
    return {
        generation,
        centerLat: null,
        centerLon: null,
        entranceCuts: [],
        openingClaim: null,
        photoGroundRevealRebuilt: false,
        photoStationStructureRevision: 0,
        railFormationRevision: 0,
    };
}

function createPlatformState({
    generation,
    root,
    centerLat,
    centerLon,
    stationRevision,
    railFormationRevision,
}) {
    const entranceCuts = [...(root?.userData?.entranceCuts || [])];
    return {
        generation,
        centerLat,
        centerLon,
        entranceCuts,
        openingClaim: entranceCuts.length > 0
            ? platformOpeningClaimInput(generation)
            : null,
        photoGroundRevealRebuilt: !!photoTrackFrame && isPhotorealRevealed(),
        photoStationStructureRevision: stationRevision,
        railFormationRevision,
    };
}

function applyPlatformState(state, nextGroup) {
    const next = state || emptyPlatformState();
    // The visible access solids and the exact holes they floor are one
    // synchronous publication. Planner mask rebuilds no longer own this list.
    clearPlannerEntranceCuts();
    if (next.openingClaim && next.entranceCuts.length > 0) {
        setPlannerEntranceCuts(next.entranceCuts, next.openingClaim);
    }
    group = nextGroup || null;
    lastBuildLat = next.centerLat;
    lastBuildLon = next.centerLon;
    photoGroundRevealRebuilt = next.photoGroundRevealRebuilt;
    photoStationStructureRevision = next.photoStationStructureRevision;
    activePlatformState = next;
}

function publishPlatformGeneration(candidate) {
    const previousGroup = group;
    const previousState = activePlatformState || emptyPlatformState();
    const commit = () => applyPlatformState(candidate.state, candidate.root);
    const rollback = () => applyPlatformState(previousState, previousGroup);
    const publicationTicket = surfacePublications?.begin?.({
        key: PLATFORM_SURFACE_PUBLICATION_KEY,
        generation: candidate.generation,
        parent: scene,
        retire: (_context, root) => disposeGroup(root),
    }) || null;

    if (publicationTicket) {
        const result = candidate.root
            ? publicationTicket.publish(candidate.root, { commit, rollback })
            : publicationTicket.clear({ commit, rollback });
        return platformSurfacePublicationCommitted(result.status);
    }

    try {
        if (candidate.root) {
            applySurfacePublicationDrawContracts(candidate.root);
            scene.add(candidate.root);
        }
        commit();
        if (previousGroup && previousGroup !== candidate.root) disposeGroup(previousGroup);
        return true;
    } catch (error) {
        rollback();
        if (candidate.root) disposeGroup(candidate.root);
        throw error;
    }
}

function createPlatformBuildTask(centerLat, centerLon, stationRevision) {
    noteWorldQueueActive('platforms');
    const stagedGroup = createPlatformGroup();
    // Cold-start shaders are the most expensive ones. Keep the first platform
    // generation detached until parallel compilation finishes as well; making
    // only replacements async left a measured 326 ms startup geometry step.
    const asyncGpuPrewarm = true;
    const generation = ++publicationGeneration;
    const railFormation = currentRailFormationReference();
    const railFormationRevision = Number(railFormation?.revision) || 0;
    railFormationRevisionSeen = railFormationRevision;
    return createCooperativeBuildTask({
        iterator: () => build(
            stagedGroup,
            centerLat,
            centerLon,
            railFormation,
            stationRevision,
            { asyncGpuPrewarm },
        ),
        publish: builtGroup => {
            if (builtGroup.userData.terrainEvidenceIncomplete === true) {
                // A station window is one publication generation. Never swap
                // in a group that merely omitted whichever stops lacked local
                // evidence; keep the previous complete station set instead.
                disposeGroup(builtGroup);
                // Avoid rebuilding the same known-unready window every frame.
                // A terrain revision or a real observer-window move reopens it.
                lastBuildLat = centerLat;
                lastBuildLon = centerLon;
                noteWorldQueueIdle('platforms');
                return group;
            }
            const root = builtGroup.children.length > 0 ? builtGroup : null;
            if (root) {
                annotatePlatformSurfacePublication(root, generation);
                freezeStaticTransforms(root);
            }
            else disposeGroup(builtGroup);
            const state = createPlatformState({
                generation,
                root,
                centerLat,
                centerLon,
                stationRevision,
                railFormationRevision,
            });
            publishPlatformGeneration({ generation, root, state });
            noteWorldQueueIdle('platforms');
            return group;
        },
        discard: () => disposeGroup(stagedGroup),
        // Attribute the exact semantic stage that consumed this frame. The
        // outer hook still reports `platforms`, while this label separates a
        // geometry stage from the atomic publication/upload boundary.
        onPhase: ({ phase, ms }) => {
            recordLayerFrameMs(`platforms:build:${phase}`, ms);
        },
    });
}

function clearPendingPlatformBuildMetadata() {
    pendingBuildLat = null;
    pendingBuildLon = null;
    pendingBuildStationRevision = 0;
    pendingBuildPhotoGroundReveal = false;
    pendingBuildRailFormationRevision = 0;
}

function stepPlatformBuild(task) {
    let outcome = task.step();
    if (group || outcome.done) return outcome;
    const startedAtMs = performance.now();
    while (!outcome.done
        && outcome.phase !== 'station-gpu-prewarm:shader-wait'
        && performance.now() - startedAtMs < INITIAL_PLATFORM_BUILD_BUDGET_MS) {
        outcome = task.step();
    }
    return outcome;
}

// Haversine copy — importing from core/math.js to avoid bundling a whole
// trig-heavy helper for one call.
function distM(lat1, lng1, lat2, lng2) {
    const DEG = Math.PI / 180;
    const dLat = (lat2 - lat1) * DEG;
    const dLng = (lng2 - lng1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const platformsLayer = {
    beginSession(sessionContext) {
        const {
            anchorLat: lat,
            anchorLon: lon,
            allStops,
            otherTracks: tracks,
            terrain,
            railFormation,
            photoTrackFrame: trackFrame,
            photoGroundOffsetAt: groundOffsetAt,
            surfacePublications: publicationRegistry,
        } = sessionContext;
        if (pendingBuildTask) {
            pendingBuildTask.cancel('session-restarted');
            pendingBuildTask = null;
        }
        clearPendingPlatformBuildMetadata();
        disposePlatformMaterials();
        platformMaterials = createPlatformMaterials();
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(() => {
            terrainRevisionDirty = true;
        }) || null;
        terrainRevisionDirty = true;
        railFormationReference = railFormation || null;
        sessionContextReference = sessionContext;
        railFormationRevisionSeen = 0;
        photoTrackFrame = trackFrame || null;
        photoGroundOffsetAt = typeof groundOffsetAt === 'function' ? groundOffsetAt : null;
        photoGroundRevealRebuilt = false;
        photoStationStructureRevision = getPhotorealStationStructureRevision();
        surfacePublications = publicationRegistry || null;
        publicationGeneration = 0;
        activePlatformState = null;
        groundCoordinator = null;
        requestedGroundCenter = null;
        platformPeopleGloballyVisible = true;
        hiddenPlatformPeopleStopKeys.clear();
        clearPlannerEntranceCuts();
        stops = allStops || [];
        const trackGeometry = prepareSessionTrackGeometry(tracks || []);
        sessionTrackRoutes = trackGeometry.routes;
        sessionTrackSegments = trackGeometry.segments;
        sessionTrackRoutesByOwner = indexSessionTrackCandidates(
            sessionTrackRoutes,
            route => route.usesPhotoFrame,
        );
        sessionTrackSegmentsByOwner = indexSessionTrackCandidates(
            sessionTrackSegments,
            segment => segment.usesPhotoTrackFrame,
        );
        lastBuildLat = null;
        lastBuildLon = null;
        noteWorldQueueActive('platforms');
        // Initial build happens on the first onFrame call (when we have a pose).
    },
    onFrame(pose) {
        if (!pose) return;
        const coordinator = groundCoordinator || sessionContextReference?.groundCoordinator;
        if (coordinator) {
            if ((lastBuildLat == null || distM(pose.lat, pose.lon, lastBuildLat, lastBuildLon) > STATION_REBUILD_M)
                && (!requestedGroundCenter || distM(pose.lat, pose.lon, requestedGroundCenter.lat, requestedGroundCenter.lon) > STATION_REBUILD_M)) {
                requestedGroundCenter = { lat: pose.lat, lon: pose.lon };
                coordinator.invalidate('stations');
            }
            return;
        }
        const nextStationRevision = getPhotorealStationStructureRevision();
        const photoGroundRevealed = !!photoTrackFrame && isPhotorealRevealed();
        const nextRailFormationRevision = Number(currentRailFormationReference()?.revision) || 0;
        if (pendingBuildTask) {
            const pendingWindowMoved = pendingBuildLat == null
                || distM(pose.lat, pose.lon, pendingBuildLat, pendingBuildLon) > STATION_REBUILD_M;
            const pendingGenerationStale = terrainRevisionDirty
                || (!!photoTrackFrame
                    && nextStationRevision !== pendingBuildStationRevision)
                || nextRailFormationRevision !== pendingBuildRailFormationRevision
                || photoGroundRevealed !== pendingBuildPhotoGroundReveal;
            if (pendingWindowMoved || pendingGenerationStale) {
                pendingBuildTask.cancel('observer-window-superseded');
                pendingBuildTask = null;
                clearPendingPlatformBuildMetadata();
            } else {
                const outcome = stepPlatformBuild(pendingBuildTask);
                if (outcome.done) {
                    pendingBuildTask = null;
                    clearPendingPlatformBuildMetadata();
                }
                return;
            }
        }
        const movedFar = lastBuildLat == null ||
            distM(pose.lat, pose.lon, lastBuildLat, lastBuildLon) > STATION_REBUILD_M;
        const needsGoogleGroundRebuild = photoGroundRevealed && !photoGroundRevealRebuilt;
        const needsStationStructureRebuild = !!photoTrackFrame
            && isPhotorealRevealed()
            && nextStationRevision !== photoStationStructureRevision;
        const needsRailFormationRebuild = nextRailFormationRevision
            !== railFormationRevisionSeen;
        if (!movedFar
            && !terrainRevisionDirty
            && !needsGoogleGroundRebuild
            && !needsStationStructureRebuild
            && !needsRailFormationRebuild) return;
        terrainRevisionDirty = false;
        const task = createPlatformBuildTask(pose.lat, pose.lon, nextStationRevision);
        pendingBuildTask = task;
        pendingBuildLat = pose.lat;
        pendingBuildLon = pose.lon;
        pendingBuildStationRevision = nextStationRevision;
        pendingBuildPhotoGroundReveal = photoGroundRevealed;
        pendingBuildRailFormationRevision = nextRailFormationRevision;
        const outcome = stepPlatformBuild(pendingBuildTask);
        if (outcome.done) {
            pendingBuildTask = null;
            clearPendingPlatformBuildMetadata();
        }
    },
    groundReady: () => !!sessionContextReference && !pendingBuildTask,
    manageGroundPublications(coordinator) { groundCoordinator = coordinator; },
    prepareConstructionOpeningGroundSteps: preparePlatformOpeningGroundSteps,
    endSession() {
        groundCoordinator = null;
        requestedGroundCenter = null;
        if (pendingBuildTask) {
            pendingBuildTask.cancel('session-ended');
            pendingBuildTask = null;
        }
        clearPendingPlatformBuildMetadata();
        const retiringGroup = group;
        clearPlannerEntranceCuts();
        group = null;
        activePlatformState = null;
        if (retiringGroup && !surfacePublications?.retire?.(
            PLATFORM_SURFACE_PUBLICATION_KEY,
            { root: retiringGroup, reason: 'platforms-session-ended' },
        )) {
            disposeGroup(retiringGroup);
        }
        stops = [];
        sessionTrackRoutes = [];
        sessionTrackSegments = [];
        sessionTrackRoutesByOwner.clear();
        sessionTrackSegmentsByOwner.clear();
        sessionTrackRoutesByOwner = new Map();
        sessionTrackSegmentsByOwner = new Map();
        lastBuildLat = null;
        lastBuildLon = null;
        terrainReference = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        terrainRevisionDirty = false;
        railFormationReference = null;
        sessionContextReference = null;
        railFormationRevisionSeen = 0;
        photoTrackFrame = null;
        photoGroundOffsetAt = null;
        photoGroundRevealRebuilt = false;
        photoStationStructureRevision = 0;
        surfacePublications = null;
        publicationGeneration = 0;
        platformPeopleGloballyVisible = true;
        hiddenPlatformPeopleStopKeys.clear();
        clearStationTemplateCache();
        disposePlatformMaterials();
        noteWorldQueueIdle('platforms');
        for (const tex of signTextureCache.values()) {
            unregisterShared(tex);
            tex.dispose();
        }
        signTextureCache.clear();
    },
};
