// Rare fish jumping out of the sea near the viewer, in every model-world
// session with mapped (or authored open) sea, films included. Timing, site,
// size and arc come from core/fish-jumps.js; this layer draws the fish, a spray
// of droplets and a ripple ring, and plays the splash when it is near enough to
// hear. Idle, it costs one clock comparison per frame; a jump is a small fish,
// one points draw and up to two ripples for about a second.

import * as THREE from 'three';
import {
    FISH_JUMP_DEFAULTS,
    fishJumpsAllowed,
    fishSplashCue,
    nextFishJumpDelayS,
    pickFishJumpSite,
    planFishJump,
    sampleFishJump,
} from '../core/fish-jumps.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { camera, scene } from '../scene/setup.js';
import { playFishSplash, preloadFishSplashSfx } from '../ui/fish-splash-sfx.js';
import { hasMappedSeaCoverage, isPointInMappedSea, mappedSeaSurfaceSceneY } from './water.js';

const GRAVITY_MPS2 = 9.81;
const DROPLET_CAPACITY = 96;
const RIPPLE_POOL_SIZE = 4;
const RIPPLE_LIFE_S = 1.6;
// Just above the sea plane, so the ring never fights it.
const RIPPLE_LIFT_M = 0.03;

let session = null;

const forward = new THREE.Vector3();
const right = new THREE.Vector3();

const nowSeconds = () => performance.now() / 1000;

// A 1 m fish along +Z: a slim body, dark on the back and silver underneath,
// and a tail fin on its own pivot so it can flick.
function createFishGeometry() {
    const body = new THREE.SphereGeometry(0.5, 14, 10);
    body.scale(0.15, 0.21, 1);
    const positions = body.getAttribute('position');
    const colors = new Float32Array(positions.count * 3);
    const back = new THREE.Color(0x344c5a);
    const belly = new THREE.Color(0xd3dbe0);
    const mixed = new THREE.Color();
    for (let index = 0; index < positions.count; index++) {
        const up = THREE.MathUtils.clamp(positions.getY(index) / 0.105 * 0.5 + 0.5, 0, 1);
        mixed.copy(belly).lerp(back, THREE.MathUtils.smoothstep(up, 0.35, 0.8));
        mixed.toArray(colors, index * 3);
    }
    body.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const tail = new THREE.BufferGeometry();
    tail.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, 0, 0.17, -0.22, 0, -0.17, -0.22,
    ], 3));
    tail.setAttribute('color', new THREE.Float32BufferAttribute([
        0.26, 0.36, 0.42, 0.26, 0.36, 0.42, 0.26, 0.36, 0.42,
    ], 3));
    tail.computeVertexNormals();
    return { body, tail };
}

function createFish(shared) {
    const fish = new THREE.Group();
    fish.name = 'AmbientFish';
    fish.rotation.order = 'YXZ';
    const body = new THREE.Mesh(shared.geometry.body, shared.material);
    body.castShadow = false;
    fish.add(body);
    const tailPivot = new THREE.Group();
    tailPivot.position.z = -0.46;
    tailPivot.add(new THREE.Mesh(shared.geometry.tail, shared.material));
    fish.add(tailPivot);
    fish.userData.tailPivot = tailPivot;
    fish.visible = false;
    return fish;
}

function softDotTexture() {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// Droplets fly ballistically on the CPU: a hundred points at most, and only
// while a splash is in the air.
function createDroplets() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(DROPLET_CAPACITY * 3);
    const colors = new Float32Array(DROPLET_CAPACITY * 4);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const texture = softDotTexture();
    const material = new THREE.PointsMaterial({
        size: 0.09,
        map: texture,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'AmbientFishDroplets';
    points.frustumCulled = false;
    points.visible = false;
    const state = Array.from({ length: DROPLET_CAPACITY }, () => ({
        alive: false, bornS: 0, lifeS: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, floorY: 0,
    }));
    return { points, geometry, material, texture, positions, colors, state, cursor: 0, live: 0 };
}

function createRipple() {
    const material = new THREE.MeshBasicMaterial({
        color: 0xe8f2f5,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40), material);
    mesh.name = 'AmbientFishRipple';
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.userData.bornS = 0;
    mesh.userData.maxRadiusM = 1;
    return mesh;
}

function emitDroplets(droplets, x, y, z, count, strength, now) {
    for (let emitted = 0; emitted < count; emitted++) {
        const droplet = droplets.state[droplets.cursor];
        droplets.cursor = (droplets.cursor + 1) % DROPLET_CAPACITY;
        if (!droplet.alive) droplets.live += 1;
        const angle = Math.random() * Math.PI * 2;
        const outward = (0.5 + Math.random() * 1.3) * strength;
        droplet.alive = true;
        droplet.bornS = now;
        droplet.lifeS = 0.45 + Math.random() * 0.45;
        droplet.x = x;
        droplet.y = y;
        droplet.z = z;
        droplet.vx = Math.sin(angle) * outward;
        droplet.vz = Math.cos(angle) * outward;
        droplet.vy = (1.4 + Math.random() * 1.9) * strength;
        droplet.floorY = y;
    }
    droplets.points.visible = true;
}

function updateDroplets(droplets, now) {
    if (droplets.live === 0) return;
    const { positions, colors, state } = droplets;
    for (let index = 0; index < DROPLET_CAPACITY; index++) {
        const droplet = state[index];
        if (!droplet.alive) {
            colors[index * 4 + 3] = 0;
            continue;
        }
        const age = now - droplet.bornS;
        const y = droplet.y + droplet.vy * age - 0.5 * GRAVITY_MPS2 * age * age;
        if (age >= droplet.lifeS || (age > 0.05 && y < droplet.floorY)) {
            droplet.alive = false;
            droplets.live -= 1;
            colors[index * 4 + 3] = 0;
            continue;
        }
        positions[index * 3] = droplet.x + droplet.vx * age;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = droplet.z + droplet.vz * age;
        colors[index * 4] = 0.9;
        colors[index * 4 + 1] = 0.95;
        colors[index * 4 + 2] = 1;
        colors[index * 4 + 3] = 0.85 * (1 - age / droplet.lifeS);
    }
    droplets.geometry.getAttribute('position').needsUpdate = true;
    droplets.geometry.getAttribute('color').needsUpdate = true;
    if (droplets.live === 0) droplets.points.visible = false;
}

function startRipple(ripples, x, y, z, radiusM, now) {
    const ripple = ripples.find(item => !item.visible)
        || ripples.reduce((oldest, item) => (item.userData.bornS < oldest.userData.bornS ? item : oldest));
    ripple.position.set(x, y + RIPPLE_LIFT_M, z);
    ripple.userData.bornS = now;
    ripple.userData.maxRadiusM = radiusM;
    ripple.visible = true;
}

function updateRipples(ripples, now) {
    for (const ripple of ripples) {
        if (!ripple.visible) continue;
        const age = (now - ripple.userData.bornS) / RIPPLE_LIFE_S;
        if (age >= 1) {
            ripple.visible = false;
            continue;
        }
        const radius = ripple.userData.maxRadiusM * (0.15 + 0.85 * Math.sqrt(age));
        ripple.scale.setScalar(radius);
        ripple.material.opacity = 0.42 * (1 - age);
    }
}

function listenerNow() {
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z, right: { x: right.x, z: right.z } };
}

function splash(current, plan, where, now) {
    const strength = 0.55 + plan.lengthM * 1.1;
    const sign = where === 'out' ? -0.5 : 0.5;
    const x = plan.x + Math.sin(plan.headingRad) * plan.spanM * sign;
    const z = plan.z + Math.cos(plan.headingRad) * plan.spanM * sign;
    emitDroplets(current.droplets, x, plan.seaY, z, where === 'out' ? 7 : 16, where === 'out' ? strength * 0.7 : strength, now);
    startRipple(current.ripples, x, plan.seaY, z, where === 'out' ? 0.6 + plan.lengthM : 1 + plan.lengthM * 2.2, now);
    const cue = fishSplashCue({ plan, listener: listenerNow(), where });
    if (cue) {
        const soundStartedAt = performance.now();
        if (playFishSplash(cue)) current.stats.splashesHeard += 1;
        recordLayerFrameMs('fishJumps:sound', performance.now() - soundStartedAt);
    }
}

function startJump(current, plan, now) {
    const fish = current.fishPool.find(item => !item.visible);
    if (!fish) return false;
    fish.scale.setScalar(plan.lengthM);
    fish.visible = true;
    current.jumps.push({ plan, fish, startedS: now });
    current.stats.jumps += 1;
    current.stats.lastJump = { x: plan.x, z: plan.z, lengthM: plan.lengthM, atS: now };
    splash(current, plan, 'out', now);
    return true;
}

function updateJumps(current, now) {
    for (let index = current.jumps.length - 1; index >= 0; index--) {
        const jump = current.jumps[index];
        const sample = sampleFishJump(jump.plan, now - jump.startedS);
        if (!sample) {
            jump.fish.visible = false;
            current.jumps.splice(index, 1);
            splash(current, jump.plan, 'in', now);
            continue;
        }
        jump.fish.position.set(sample.x, sample.y, sample.z);
        jump.fish.rotation.y = sample.yawRad;
        jump.fish.rotation.x = -sample.pitchRad;
        jump.fish.userData.tailPivot.rotation.y = sample.tailRad;
    }
}

// The sea test walks coastline rings, so a jump looks for its place a couple of
// tries per frame across a few frames rather than a whole search in one.
const SITE_TRIES_PER_FRAME = 1;
const HEADING_TRIES_PER_FRAME = 1;

// One step of the search: the reason it did not happen, or 'jumped'.
function tryJumpStep(current, now) {
    if (current.jumps.length >= FISH_JUMP_DEFAULTS.maxConcurrent) return 'busy';
    if (!current.openSea && !hasMappedSeaCoverage()) return 'no-sea';
    const seaY = mappedSeaSurfaceSceneY();
    if (!fishJumpsAllowed({ viewerY: camera.position.y, seaY })) return 'too-high';
    const isSea = current.openSea ? () => true : isPointInMappedSea;
    camera.getWorldDirection(forward);
    const site = pickFishJumpSite({
        random: Math.random,
        viewer: camera.position,
        forward,
        isSea,
        config: { ...FISH_JUMP_DEFAULTS, siteAttempts: SITE_TRIES_PER_FRAME },
    });
    if (!site) return 'no-site';
    const plan = planFishJump({ random: Math.random, site, seaY, isSea, headingAttempts: HEADING_TRIES_PER_FRAME });
    if (!plan) return 'no-site';
    return startJump(current, plan, now) ? 'jumped' : 'busy';
}

// The debug hook jumps now: the whole search inside one frame, or — for a
// verification shot — a fish of a given size straight ahead at a given range.
function tryJumpNow(current, now, { distanceM = null, lengthM = null } = {}) {
    if (Number.isFinite(distanceM)) {
        const seaY = mappedSeaSurfaceSceneY();
        const isSea = current.openSea ? () => true : isPointInMappedSea;
        camera.getWorldDirection(forward);
        const heading = Math.atan2(forward.x, forward.z);
        const site = {
            x: camera.position.x + Math.sin(heading) * distanceM,
            z: camera.position.z + Math.cos(heading) * distanceM,
        };
        if (!isSea(site.x, site.z)) return 'no-site';
        const plan = planFishJump({ random: Math.random, site, seaY, isSea, forcedLengthM: lengthM });
        if (!plan) return 'no-site';
        return startJump(current, plan, now) ? 'jumped' : 'busy';
    }
    let outcome = 'no-site';
    for (let attempt = 0; attempt < FISH_JUMP_DEFAULTS.siteAttempts && outcome === 'no-site'; attempt++) {
        outcome = tryJumpStep(current, now);
    }
    return outcome;
}

function disposeSession() {
    const current = session;
    session = null;
    if (!current) return;
    current.group.removeFromParent();
    current.shared.geometry.body.dispose();
    current.shared.geometry.tail.dispose();
    current.shared.material.dispose();
    current.droplets.geometry.dispose();
    current.droplets.material.dispose();
    current.droplets.texture.dispose();
    for (const ripple of current.ripples) {
        ripple.geometry.dispose();
        ripple.material.dispose();
    }
}

export function fishJumpsSnapshot() {
    if (!session) return null;
    const round = value => Math.round(value * 100) / 100;
    return {
        openSea: session.openSea,
        nextJumpInS: Math.max(0, session.nextJumpAtS - nowSeconds()),
        active: session.jumps.length,
        droplets: session.droplets.live,
        // Where the fish in the air are, against the camera that should see them.
        airborne: session.jumps.map((jump) => {
            // Where it lands on screen, so automation looks at the right pixels.
            const ndc = jump.fish.position.clone().project(camera);
            return {
                lengthM: round(jump.plan.lengthM),
                visible: jump.fish.visible,
                position: jump.fish.position.toArray().map(round),
                aheadM: round(jump.fish.position.distanceTo(camera.position)),
                onScreen: ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1,
                screen: [round((ndc.x * 0.5 + 0.5) * 100), round((0.5 - ndc.y * 0.5) * 100)],
            };
        }),
        camera: [camera.position.x, camera.position.y, camera.position.z].map(round),
        seaY: round(mappedSeaSurfaceSceneY()),
        ...session.stats,
    };
}

export const fishJumpsLayer = {
    beginSession(ctx) {
        disposeSession();
        const beganAt = performance.now();
        const group = new THREE.Group();
        group.name = 'AmbientFishJumps';
        const shared = {
            geometry: createFishGeometry(),
            material: new THREE.MeshStandardMaterial({
                vertexColors: true, roughness: 0.38, metalness: 0.45, side: THREE.DoubleSide,
            }),
        };
        const fishPool = Array.from({ length: FISH_JUMP_DEFAULTS.maxConcurrent }, () => createFish(shared));
        const droplets = createDroplets();
        const ripples = Array.from({ length: RIPPLE_POOL_SIZE }, createRipple);
        for (const fish of fishPool) group.add(fish);
        group.add(droplets.points);
        for (const ripple of ripples) group.add(ripple);
        scene.add(group);
        session = {
            // Open-sea scenes have no coastline mask: everything around is water.
            openSea: ctx?.campaignScene?.authored?.environment?.openSea === true,
            nextJumpAtS: nowSeconds() + nextFishJumpDelayS(Math.random),
            searchFrames: 0,
            jumps: [],
            group,
            shared,
            fishPool,
            droplets,
            ripples,
            stats: { jumps: 0, splashesHeard: 0, lastSkip: null, lastJump: null },
        };
        // The splash decode, and the audio context it opens, wait for idle
        // time instead of taking part of a frame at the session start.
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => preloadFishSplashSfx(), { timeout: 4000 });
        } else {
            preloadFishSplashSfx();
        }
        recordLayerFrameMs('fishJumps:begin', performance.now() - beganAt);
        if (typeof window !== 'undefined') {
            window.__s3dFishJumps = {
                snapshot: fishJumpsSnapshot,
                // Verification only: one jump near the camera now.
                jumpNow: (options = {}) => (session ? tryJumpNow(session, nowSeconds(), options) : 'no-session'),
            };
        }
    },

    onFrame() {
        const current = session;
        if (!current) return;
        const now = nowSeconds();
        if (current.jumps.length) updateJumps(current, now);
        updateDroplets(current.droplets, now);
        updateRipples(current.ripples, now);
        if (now < current.nextJumpAtS) return;
        const attemptStartedAt = performance.now();
        const outcome = tryJumpStep(current, now);
        recordLayerFrameMs('fishJumps:attempt', performance.now() - attemptStartedAt);
        current.searchFrames += 1;
        if (outcome === 'jumped' || current.searchFrames >= FISH_JUMP_DEFAULTS.siteAttempts) {
            current.searchFrames = 0;
            current.nextJumpAtS = now + nextFishJumpDelayS(Math.random);
        }
        if (outcome !== 'jumped') current.stats.lastSkip = outcome;
    },

    endSession() {
        disposeSession();
        if (typeof window !== 'undefined') delete window.__s3dFishJumps;
    },
};
