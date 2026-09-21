// The authored campaign crowd: a plaza full of people who mill about, face
// the landmark, and now and then raise a bulky press camera and fire a flash.
// core/campaign-crowd.js owns every rule; this layer only seats people on the
// published ground and draws them. The whole crowd is five instanced draws
// (heads, bodies, arms, legs, cameras) plus a pooled sprite per live flash,
// so two hundred people cost what one authored actor's articulated mesh does.

import * as THREE from 'three';
import { scene } from '../scene/setup.js';
import {
    beginCrowdPhoto,
    campaignCrowdLayoutFromAuthored,
    createCampaignCrowd,
    crowdArmPose,
    crowdCameraPlacement,
    crowdPointBlocked,
    stepCampaignCrowd,
} from '../core/campaign-crowd.js';
import { campaignPresentationDeltaSeconds } from '../core/campaign-speaking.js';
import { personHeadProfile } from '../core/person-appearance.js';
import { pointInBuildingFootprint } from '../core/pedestrian-routing.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { getBuildingFootprintsNear } from './buildings.js';
import { createSoftParticleTexture } from './public-empty-authored-world.js';
import { createInstancedPersonHeadGeometry, getPersonHeadMaterial } from './person-head.js';
import {
    PERSON_BODY_COLORS, PERSON_LEG_COLORS, PERSON_SKIN_COLORS, personDims,
} from './person-mesh.js';
import {
    FIELD_CAMERA_FLASH_ORIGIN, createFieldCameraGeometry, createFieldCameraMaterial,
} from '../models/objects/field-camera.js';

// Seating and footprint checks are spread over frames; a full sweep of a
// 200-person plaza takes well under a second either way.
const SEAT_PER_FRAME = 24;
const VALIDATE_PER_FRAME = 12;
const FLASH_LIFE_S = 0.18;
const FLASH_POOL = 8;
const FLASH_AUDIBLE_M = 45;
const SIDES = Object.freeze([-1, 1]);

let context = null;
let root = null;
let crowd = null;
let figures = [];
let meshes = null;
let ownedGeometries = [];
let flashTexture = null;
let flashes = [];
let lastNowMs = null;
let seatCursor = 0;
let validateCursor = 0;
let terrainUnsubscribe = null;
let audioCtx = null;
let activeAuthoredCrowd = null;
let lastPlayer = null;
let lastViewHeadingDeg = null;

const scratch = {
    base: new THREE.Matrix4(),
    part: new THREE.Matrix4(),
    local: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    euler: new THREE.Euler(),
    unit: new THREE.Vector3(1, 1, 1),
    zero: new THREE.Matrix4().makeScale(0, 0, 0),
    colour: new THREE.Color(),
};

function localBlocked(x, z) {
    const point = { x, z };
    return getBuildingFootprintsNear(x, z, 1)
        .some(footprint => pointInBuildingFootprint(point, footprint));
}

function groundYAt(x, z, hintY) {
    const owned = typeof context?.actorGroundYAt === 'function'
        ? context.actorGroundYAt(x, z, Number.isFinite(hintY) ? hintY : null)
        : null;
    if (Number.isFinite(owned)) return owned;
    const terrainY = evidencePlacementBaseSceneY(context?.terrain, x, z, {
        preferRoadSurface: true,
        preferPublishedRoadSurface: true,
    });
    return Number.isFinite(terrainY) ? terrainY : null;
}

function offsetScale(offsetY, sx, sy, sz) {
    const matrix = new THREE.Matrix4().makeScale(sx, sy, sz);
    matrix.setPosition(0, offsetY, 0);
    return matrix;
}

function buildFigure(person) {
    const dims = personDims(person.kind);
    const profile = personHeadProfile(person.look.faceSeed, person.kind);
    const headY = dims.legH + dims.bodyH + dims.headR * 1.05;
    return {
        person,
        dims,
        profile,
        shoulderY: dims.legH + dims.bodyH * 0.95,
        head: offsetScale(headY, dims.headR * profile.width, dims.headR * 1.08 * profile.height, dims.headR * profile.depth),
        body: offsetScale(dims.legH + dims.bodyH / 2, dims.bodyR, dims.bodyH, dims.bodyR),
        arm: offsetScale(-dims.armH / 2, dims.armR, dims.armH, dims.armR),
        leg: offsetScale(-dims.legH / 2, dims.legR, dims.legH, dims.legR),
        cameraSlot: -1,
        stale: true,
        seatedX: NaN,
        seatedZ: NaN,
    };
}

function createInstances(geometry, material, count, { castShadow = false } = {}) {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < count; index += 1) mesh.setMatrixAt(index, scratch.zero);
    return mesh;
}

function tint(mesh, index, hex) {
    mesh.setColorAt(index, scratch.colour.setHex(hex));
}

function buildCrowd(authored) {
    const layout = campaignCrowdLayoutFromAuthored(authored, context);
    if (!layout) return false;
    crowd = createCampaignCrowd({ ...layout, isBlocked: localBlocked });
    figures = crowd.people.map(buildFigure);
    const count = figures.length;
    root = new THREE.Group();
    root.name = 'CampaignCrowd';
    if (count === 0) {
        scene.add(root);
        return true;
    }
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8);
    const headGeometry = createInstancedPersonHeadGeometry(figures.map(figure => figure.profile.variant));
    const cameraGeometry = createFieldCameraGeometry();
    ownedGeometries = [cylinder, headGeometry, cameraGeometry];
    const limbMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
    const cameraCarriers = figures.filter(figure => figure.person.camera);
    cameraCarriers.forEach((figure, slot) => { figure.cameraSlot = slot; });
    meshes = {
        // The head material is the shared crowd-face atlas material; white so
        // the per-instance colour carries the skin tone.
        heads: createInstances(headGeometry, getPersonHeadMaterial(0xffffff), count, { castShadow: true }),
        bodies: createInstances(cylinder, limbMaterial, count, { castShadow: true }),
        arms: createInstances(cylinder, limbMaterial, count * 2),
        legs: createInstances(cylinder, limbMaterial, count * 2),
        cameras: cameraCarriers.length > 0
            ? createInstances(cameraGeometry, createFieldCameraMaterial(), cameraCarriers.length)
            : null,
    };
    figures.forEach((figure, index) => {
        const { look } = figure.person;
        tint(meshes.heads, index, PERSON_SKIN_COLORS[look.skinIndex]);
        tint(meshes.bodies, index, PERSON_BODY_COLORS[look.bodyIndex]);
        tint(meshes.arms, index * 2, PERSON_SKIN_COLORS[look.skinIndex]);
        tint(meshes.arms, index * 2 + 1, PERSON_SKIN_COLORS[look.skinIndex]);
        tint(meshes.legs, index * 2, PERSON_LEG_COLORS[look.legIndex]);
        tint(meshes.legs, index * 2 + 1, PERSON_LEG_COLORS[look.legIndex]);
    });
    for (const [key, mesh] of Object.entries(meshes)) {
        if (!mesh) continue;
        mesh.name = `CampaignCrowd:${key}`;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        root.add(mesh);
    }
    scene.add(root);
    seatCursor = 0;
    validateCursor = 0;
    return true;
}

function disposeCrowd() {
    for (const flash of flashes) flash.sprite.material.dispose();
    flashes = [];
    if (root) scene.remove(root);
    for (const mesh of Object.values(meshes || {})) mesh?.dispose();
    for (const geometry of ownedGeometries) geometry.dispose();
    ownedGeometries = [];
    // The limb and camera materials are ours; the crowd-head material is the
    // shared atlas material every pedestrian head uses and stays registered.
    meshes?.bodies?.material?.dispose();
    meshes?.cameras?.material?.dispose();
    root = null;
    meshes = null;
    crowd = null;
    figures = [];
}

function seatFigure(figure) {
    const { person } = figure;
    const y = groundYAt(person.x, person.z, person.y);
    if (!Number.isFinite(y)) return false;
    person.y = y;
    figure.stale = false;
    figure.seatedX = person.x;
    figure.seatedZ = person.z;
    return true;
}

// Buildings stream in after the crowd is laid out. Anyone who turns out to be
// standing inside one is moved to a fresh spot in their gathering.
function relocateIfBlocked(figure) {
    const { person } = figure;
    if (!crowd.isBlocked(person.x, person.z)) return;
    const gathering = crowd.gatherings[person.gathering];
    for (let attempt = 0; attempt < 24; attempt += 1) {
        const angle = crowd.random() * Math.PI * 2;
        const radius = Math.sqrt(crowd.random()) * gathering.radiusM;
        const x = gathering.x + Math.sin(angle) * radius;
        const z = gathering.z + Math.cos(angle) * radius;
        if (crowdPointBlocked(crowd, x, z)) continue;
        person.x = x;
        person.z = z;
        person.y = null;
        person.target = null;
        person.state = 'stand';
        person.stateS = 0;
        return;
    }
}

function sweepSeating() {
    if (figures.length === 0) return;
    for (let step = 0; step < SEAT_PER_FRAME; step += 1) {
        const figure = figures[seatCursor % figures.length];
        seatCursor += 1;
        const { person } = figure;
        const moved = figure.stale || !Number.isFinite(person.y)
            || Math.hypot(person.x - figure.seatedX, person.z - figure.seatedZ) > 0.6;
        if (moved) seatFigure(figure);
    }
    for (let step = 0; step < VALIDATE_PER_FRAME; step += 1) {
        relocateIfBlocked(figures[validateCursor % figures.length]);
        validateCursor += 1;
    }
}

function writePart(mesh, index, localMatrix) {
    scratch.part.multiplyMatrices(scratch.base, localMatrix);
    mesh.setMatrixAt(index, scratch.part);
}

function writeLimb(mesh, index, pivotX, pivotY, pitch, roll, offsetScaleMatrix) {
    scratch.euler.set(pitch, 0, roll);
    scratch.quaternion.setFromEuler(scratch.euler);
    scratch.position.set(pivotX, pivotY, 0);
    scratch.local.compose(scratch.position, scratch.quaternion, scratch.unit).multiply(offsetScaleMatrix);
    writePart(mesh, index, scratch.local);
}

function writeFigure(figure, index) {
    const { person, dims } = figure;
    if (!Number.isFinite(person.y)) {
        meshes.heads.setMatrixAt(index, scratch.zero);
        meshes.bodies.setMatrixAt(index, scratch.zero);
        for (const side of [0, 1]) {
            meshes.arms.setMatrixAt(index * 2 + side, scratch.zero);
            meshes.legs.setMatrixAt(index * 2 + side, scratch.zero);
        }
        if (figure.cameraSlot >= 0) meshes.cameras.setMatrixAt(figure.cameraSlot, scratch.zero);
        return;
    }
    scratch.base.makeRotationY(person.heading);
    scratch.base.setPosition(person.x, person.y, person.z);
    writePart(meshes.heads, index, figure.head);
    writePart(meshes.bodies, index, figure.body);
    const swing = Math.sin(person.gaitPhase) * 0.55 * person.gaitAmount;
    const raise = person.camera ? person.raise : 0;
    for (let slot = 0; slot < 2; slot += 1) {
        const side = SIDES[slot];
        const arm = crowdArmPose(side, swing, raise);
        writeLimb(meshes.arms, index * 2 + slot, side * dims.armX, figure.shoulderY, arm.x, arm.z, figure.arm);
        writeLimb(meshes.legs, index * 2 + slot, side * dims.legX, dims.legH, swing * side, 0, figure.leg);
    }
    if (figure.cameraSlot >= 0) {
        const placement = crowdCameraPlacement(dims, raise);
        scratch.euler.set(placement.pitch, 0, 0);
        scratch.quaternion.setFromEuler(scratch.euler);
        scratch.position.set(placement.x, placement.y, placement.z);
        scratch.local.compose(scratch.position, scratch.quaternion, scratch.unit);
        writePart(meshes.cameras, figure.cameraSlot, scratch.local);
    }
}

function flashWorldPosition(figure, out) {
    const placement = crowdCameraPlacement(figure.dims, figure.person.raise);
    scratch.euler.set(placement.pitch, 0, 0);
    scratch.quaternion.setFromEuler(scratch.euler);
    scratch.position.set(placement.x, placement.y, placement.z);
    scratch.local.compose(scratch.position, scratch.quaternion, scratch.unit);
    scratch.base.makeRotationY(figure.person.heading);
    scratch.base.setPosition(figure.person.x, figure.person.y, figure.person.z);
    scratch.part.multiplyMatrices(scratch.base, scratch.local);
    out.set(FIELD_CAMERA_FLASH_ORIGIN.x, FIELD_CAMERA_FLASH_ORIGIN.y, FIELD_CAMERA_FLASH_ORIGIN.z);
    return out.applyMatrix4(scratch.part);
}

function getFlashSprite() {
    let flash = flashes.find(candidate => !candidate.active);
    if (flash) return flash;
    if (flashes.length >= FLASH_POOL) return null;
    if (!flashTexture) flashTexture = createSoftParticleTexture('CampaignCrowdFlash');
    const material = new THREE.SpriteMaterial({
        map: flashTexture,
        color: 0xfff1cf,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = 'CampaignCrowdFlash';
    sprite.visible = false;
    root.add(sprite);
    flash = { sprite, active: false, t: 0 };
    flashes.push(flash);
    return flash;
}

function fireFlash(figure, playerLocal) {
    const flash = getFlashSprite();
    if (!flash) return;
    flashWorldPosition(figure, flash.sprite.position);
    flash.active = true;
    flash.t = 0;
    flash.sprite.visible = true;
    flash.sprite.scale.setScalar(0.8);
    flash.sprite.material.opacity = 1;
    playShutterClick(flash.sprite.position, playerLocal);
}

function animateFlashes(dt) {
    for (const flash of flashes) {
        if (!flash.active) continue;
        flash.t += dt / FLASH_LIFE_S;
        if (flash.t >= 1) {
            flash.active = false;
            flash.sprite.visible = false;
            continue;
        }
        const fade = 1 - flash.t;
        flash.sprite.scale.setScalar(0.8 + 2.2 * flash.t);
        flash.sprite.material.opacity = fade * fade;
    }
}

// A press camera's "ka-chik": two short high-passed noise ticks, the second
// a touch lower as the shutter closes. Attenuated by distance to the player.
function playShutterClick(position, playerLocal) {
    if (!playerLocal) return;
    const distance = Math.hypot(
        position.x - Number(playerLocal.x),
        position.y - Number(playerLocal.y ?? position.y),
        position.z - Number(playerLocal.z),
    );
    const attenuation = Math.max(0, 1 - distance / FLASH_AUDIBLE_M);
    if (attenuation <= 0.02) return;
    if (!audioCtx) audioCtx = createUnlockedAudioContext();
    const ctx = audioCtx;
    if (!ctx) return;
    resumeUnlockedAudioContext(ctx);
    const now = ctx.currentTime;
    for (const [offsetS, durationS, cutoffHz, gainScale] of [[0, 0.018, 2600, 1], [0.045, 0.03, 1700, 0.8]]) {
        const length = Math.floor(ctx.sampleRate * durationS);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < length; index += 1) {
            data[index] = (Math.random() * 2 - 1) * Math.exp(-index / (ctx.sampleRate * durationS * 0.35));
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = cutoffHz;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.14 * attenuation * gainScale, now + offsetS);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offsetS + durationS);
        source.connect(filter).connect(gain).connect(getAudioDestination(ctx));
        source.start(now + offsetS);
    }
}

function authoredCrowdFor(campaignScene) {
    return campaignScene?.authored?.crowd || null;
}

function sameAuthoredCrowd(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

// Called on an in-place scene transition (a reused world): the crowd stays
// when the next scene authors the same one, and is rebuilt otherwise.
export function replaceCampaignCrowdScene({ campaignScene } = {}) {
    if (!context) return false;
    const authored = authoredCrowdFor(campaignScene);
    if (sameAuthoredCrowd(authored, activeAuthoredCrowd) && (!!root === !!authored)) return true;
    disposeCrowd();
    activeAuthoredCrowd = authored;
    return authored ? buildCrowd(authored) : true;
}

export function getCampaignCrowdSnapshot() {
    if (!crowd) return null;
    return {
        people: crowd.people.length,
        seated: crowd.people.filter(person => Number.isFinite(person.y)).length,
        cameras: crowd.people.filter(person => person.camera).length,
        walking: crowd.people.filter(person => person.state === 'walk').length,
        photographing: crowd.people.filter(person => person.state === 'photo').length,
        flashesLive: flashes.filter(flash => flash.active).length,
        elapsedS: crowd.elapsedS,
        player: lastPlayer,
        viewHeadingDeg: lastViewHeadingDeg,
        photographers: crowd.people
            .filter(person => person.state === 'photo')
            .map(person => ({
                id: person.id,
                x: Number(person.x.toFixed(1)),
                z: Number(person.z.toFixed(1)),
                heading: Number(person.heading.toFixed(2)),
                phase: person.photo?.phase,
                raise: Number(person.raise.toFixed(2)),
                distanceM: lastPlayer ? Number(Math.hypot(person.x - lastPlayer.x, person.z - lastPlayer.z).toFixed(1)) : null,
            })),
    };
}

export const campaignCrowdLayer = {
    beginSession(ctx) {
        context = ctx;
        lastNowMs = null;
        activeAuthoredCrowd = authoredCrowdFor(ctx?.campaignScene);
        terrainUnsubscribe?.();
        // A terrain revision re-seats everyone, but keeps the old height
        // until the new one is sampled so nobody blinks out of the plaza.
        terrainUnsubscribe = ctx?.terrain?.onChange?.(() => {
            for (const figure of figures) figure.stale = true;
        }) || null;
        if (activeAuthoredCrowd) buildCrowd(activeAuthoredCrowd);
        if (typeof window !== 'undefined') {
            window.__s3dCampaignCrowd = getCampaignCrowdSnapshot;
            // Stages a photo on the nearest camera carrier (or a given id) so a
            // flash can be checked on screen without waiting for one.
            window.__s3dCampaignCrowdPhoto = (id = null) => {
                if (!crowd) return null;
                const carriers = crowd.people.filter(person => person.camera && person.state !== 'photo');
                let person = id != null ? carriers.find(candidate => candidate.id === id) : null;
                if (person == null && lastPlayer && Number.isFinite(lastViewHeadingDeg)) {
                    // The nearest carrier standing in the player's view cone.
                    const heading = lastViewHeadingDeg * Math.PI / 180;
                    const inView = carriers.map(candidate => {
                        const dx = candidate.x - lastPlayer.x;
                        const dz = candidate.z - lastPlayer.z;
                        const distance = Math.hypot(dx, dz);
                        const bearing = Math.atan2(dx, -dz);
                        let delta = bearing - heading;
                        while (delta > Math.PI) delta -= Math.PI * 2;
                        while (delta < -Math.PI) delta += Math.PI * 2;
                        return { candidate, distance, delta };
                    }).filter(entry => entry.distance > 5 && entry.distance < 25 && Math.abs(entry.delta) < 0.4)
                        .sort((a, b) => a.distance - b.distance);
                    person = inView[0]?.candidate || null;
                }
                return person && beginCrowdPhoto(crowd, person) ? person.id : null;
            };
        }
    },

    onFrame(_pose, playerLocal, dt) {
        // Simulation time stops while Viktorija talks; the crowd keeps
        // living on the renderer clock like the fireworks above it.
        const nowMs = performance.now();
        const stepS = campaignPresentationDeltaSeconds({ simulationDt: dt, nowMs, previousNowMs: lastNowMs });
        lastNowMs = nowMs;
        if (!crowd || !meshes || figures.length === 0) return;
        sweepSeating();
        const player = playerLocal ? { x: Number(playerLocal.x), z: Number(playerLocal.z) } : null;
        lastPlayer = player;
        lastViewHeadingDeg = Number(_pose?.viewHeadingDeg ?? _pose?.headingDeg);
        const { flashes: fired } = stepCampaignCrowd(crowd, { dt: stepS, player });
        figures.forEach(writeFigure);
        for (const mesh of Object.values(meshes)) if (mesh) mesh.instanceMatrix.needsUpdate = true;
        for (const person of fired) fireFlash(figures[person.id], playerLocal);
        animateFlashes(stepS);
    },

    endSession() {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        disposeCrowd();
        flashTexture?.dispose();
        flashTexture = null;
        activeAuthoredCrowd = null;
        context = null;
    },
};
