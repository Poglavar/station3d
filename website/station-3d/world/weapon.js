// Machine gun for game mode, in two mountings.
//
// In a tram or train cab it is a first-person gun: the mesh tracks the camera
// so it stays at the bottom-front of the view, and it fires along the camera's
// world-forward.
//
// On a road vehicle it is a ROOF TURRET instead. The mesh rides the car, stays
// visible from every camera angle including the chase view, swings to where the
// player is looking within its pitch limits, and fires along its own barrel —
// so what you see it pointing at is what it hits. Call setWeaponMount() to put
// it on a vehicle and setWeaponMount(null) to hand it back to the camera.
//
// Effects:
//   * Tracer bullets — bright yellow spheres travelling at high speed.
//   * Muzzle flash    — short emissive pulse at the barrel tip on each shot.
//   * Impact sparks   — burst of small orange particles at the bullet's end.
//   * Wreck blasts    — fireball, shockwave, debris, flash, and camera kick.
//   * Sound           — synthesized "pop" via Web Audio per shot.
//
// API:
//   attachWeapon()           — mount gun + bullet/spark containers
//   detachWeapon()           — clean up on cab exit
//   setWeaponFiring(bool)    — held-key state (spacebar from cab.js)
//   tickWeapon(dt)           — per-frame: spawn at fire rate, advance bullets/flash/sparks

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import { buildMachineGunMesh, GUN_X, GUN_Y } from '../models/objects/machine-gun.js';
import {
    createUnlockedAudioContext,
    getAudioDestination,
    resumeUnlockedAudioContext,
} from '../core/audio-unlock.js';
import { scene, camera } from '../scene/setup.js';
import { mountedWeaponAim } from '../core/mounted-weapon-aim.js';
import { tryCarHit, addBulletHole, recordCarHit, spawnFireFlashAt } from './cars.js';
import {
    tryMachineGunNestHit, addMachineGunNestBulletHole, recordMachineGunNestHit,
} from './machine-gun-nests.js';
import { tryTramHit, recordTramHit, getOtherTramsGroup } from '../vehicles/tram.js';
import { getBuildingsGroup } from './buildings.js';
import { tryStampHole, clearFifoHoles } from './bullet-marks.js';

// Bullet ↔ car collision uses a generous bounding sphere around each car.
// Bigger = easier to hit, smaller = needs better aim.
const BULLET_HIT_RADIUS_M = 2.5;
const NEST_HIT_RADIUS_M = 1.45;

// Wreck explosion parameters. The explosion is layered so it reads at both
// cab distance and bird's-eye distance: a bright flash, a soft fireball
// billboard, a ground shockwave ring, metal debris, sparks, sound, and a
// short camera kick.
const EXPLOSION_SPARK_COUNT = 52;
const EXPLOSION_SPARK_SPEED_MPS = 11;
const EXPLOSION_FLASH_LIFETIME_S = 0.38;
const EXPLOSION_FLASH_RADIUS_M = 2.1;
const EXPLOSION_FIREBALL_LIFETIME_S = 0.68;
const EXPLOSION_FIREBALL_START_SCALE_M = 2.3;
const EXPLOSION_FIREBALL_END_SCALE_M = 7.0;
const EXPLOSION_SHOCKWAVE_LIFETIME_S = 0.55;
const EXPLOSION_SHOCKWAVE_START_RADIUS_M = 1.3;
const EXPLOSION_SHOCKWAVE_END_RADIUS_M = 9.0;
const EXPLOSION_DEBRIS_COUNT = 16;
const EXPLOSION_DEBRIS_LIFETIME_S = 1.25;
const EXPLOSION_DEBRIS_SPEED_MPS = 9.5;
const EXPLOSION_DEBRIS_GRAVITY_MPS2 = 12;
const EXPLOSION_CAMERA_SHAKE_LIFETIME_S = 0.45;
const EXPLOSION_CAMERA_SHAKE_RADIUS_M = 90;
const EXPLOSION_CAMERA_SHAKE_MAX_M = 0.34;

// Ammo: starts at STARTING_AMMO at the start of a cab session, drops by
// 1 per shot, can't go below 0. Refilled by addAmmo() (the cab calls it
// when the tram stops at a station).
const STARTING_AMMO = 1000;
let ammo = STARTING_AMMO;

const FIRE_INTERVAL_MS = 95;          // ~10.5 rounds/sec
const BULLET_SPEED_MPS = 120;
const BULLET_LIFETIME_S = 1.8;        // ~215 m range
const BULLET_RADIUS_M = 0.10;         // bigger so tracers read clearly
const MUZZLE_FLASH_LIFETIME_S = 0.06;
const MUZZLE_FLASH_BASE_SCALE = 0.55;
const SPARK_COUNT_PER_HIT = 7;
const SPARK_LIFETIME_S = 0.45;
const SPARK_GRAVITY_MPS2 = 9.8;
const SPARK_INITIAL_SPEED_MPS = 4;
const METAL_IMPACT_AUDIBLE_M = 170;

// Camera near plane is 0.5; place gun well past it so it isn't clipped,
// and oversize it so it reads as a chunky weapon at this distance.
// The mount point is the vehicle's roof, so this is only the clearance the gun
// body needs to sit ON it rather than in it. MOUNT_SCALE is how much smaller it
// reads bolted to a car than filling a first-person view.
// Measured against the campaign sedan: its reported height stops a little short
// of where the roof actually renders, and the gun has to stand clear of the
// panel rather than skim it — at 0.17 m proud it was technically on the car and
// invisible from the chase camera. It keeps its full size up there; shrinking it
// only made it harder to see.
const MOUNT_CLEARANCE_M = 0.62;
const MOUNT_SCALE = 1;
// Pintle: the post that visibly bolts the gun to the roof. Without it the gun
// reads as hovering rather than mounted.
const MOUNT_POST_RADIUS_M = 0.075;

// Returns { x, y, z } for the vehicle carrying the gun, or null for the
// first-person camera mounting. See setWeaponMount.
let weaponMountFn = null;
const _mountAim = new THREE.Vector3();
const _aimDir = new THREE.Vector3(0, 0, -1);


let weaponGroup = null;
// The meshes, kept in their own group inside weaponGroup so the mounted
// turret can recentre and rescale them without disturbing the pivot that
// carries the aim.
let gunRig = null;
// The pintle. Yaw-only, so it stays upright while the gun elevates on it.
let mountPost = null;
let muzzleAnchor = null;
let muzzleFlashMesh = null;
let muzzleFlashTtl = 0;

let bulletsGroup = null;
let bulletGeometry = null;
let bulletMaterial = null;
const liveBullets = [];

let sparksGroup = null;
let sparkGeometry = null;
let sparkMaterial = null;
const liveSparks = [];

let explosionFlashGeo = null;
let explosionFlashMatTemplate = null;
const liveFlashes = [];
let fireballTexture = null;
let shockwaveGeometry = null;
let shockwaveMatTemplate = null;
let debrisGeometry = null;
let debrisMaterial = null;
const liveFireballs = [];
const liveShockwaves = [];
const liveDebris = [];
let cameraShakeTtl = 0;
let cameraShakeAmp = 0;

let isFiring = false;
let lastFireMs = 0;

let metalMat = null;
let muzzleMat = null;

// ─── Shared materials / geometries ─────────────────────────────────────────

function getMetalMat() {
    if (!metalMat) {
        metalMat = new THREE.MeshStandardMaterial({
            color: 0x14181c, roughness: 0.40, metalness: 0.80,
        });
        registerShared(metalMat);
    }
    return metalMat;
}
function getMuzzleMat() {
    if (!muzzleMat) {
        muzzleMat = new THREE.MeshStandardMaterial({
            color: 0xfff0a0,
            emissive: 0xffa040,
            emissiveIntensity: 4.0,
            transparent: true,
            opacity: 0.95,
        });
        registerShared(muzzleMat);
    }
    return muzzleMat;
}
function getBulletGeometry() {
    if (!bulletGeometry) {
        bulletGeometry = new THREE.SphereGeometry(BULLET_RADIUS_M, 8, 6);
        registerShared(bulletGeometry);
    }
    return bulletGeometry;
}
function getBulletMaterial() {
    if (!bulletMaterial) {
        bulletMaterial = new THREE.MeshStandardMaterial({
            color: 0xfff5b0,
            emissive: 0xffd060,
            emissiveIntensity: 3.0,
            roughness: 0.35,
        });
        registerShared(bulletMaterial);
    }
    return bulletMaterial;
}
function getSparkGeometry() {
    if (!sparkGeometry) {
        sparkGeometry = new THREE.SphereGeometry(0.07, 6, 4);
        registerShared(sparkGeometry);
    }
    return sparkGeometry;
}
function getSparkMaterial() {
    if (!sparkMaterial) {
        sparkMaterial = new THREE.MeshStandardMaterial({
            color: 0xffb060,
            emissive: 0xff6020,
            emissiveIntensity: 3.5,
        });
        registerShared(sparkMaterial);
    }
    return sparkMaterial;
}

function getExplosionFlashGeo() {
    if (!explosionFlashGeo) {
        explosionFlashGeo = new THREE.SphereGeometry(EXPLOSION_FLASH_RADIUS_M, 14, 10);
        registerShared(explosionFlashGeo);
    }
    return explosionFlashGeo;
}
function getExplosionFlashMatTemplate() {
    if (!explosionFlashMatTemplate) {
        // Template — we clone it per-flash so each can fade its opacity
        // and emissive independently without disturbing the other live
        // flashes. Cloned material is disposed when its flash ends.
        explosionFlashMatTemplate = new THREE.MeshStandardMaterial({
            color: 0xffe0a0,
            emissive: 0xff7020,
            emissiveIntensity: 5.0,
            transparent: true,
            opacity: 1.0,
        });
        registerShared(explosionFlashMatTemplate);
    }
    return explosionFlashMatTemplate;
}

function getFireballTexture() {
    if (fireballTexture) return fireballTexture;
    const size = 192;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(
        size * 0.46, size * 0.42, size * 0.04,
        size * 0.50, size * 0.50, size * 0.50,
    );
    g.addColorStop(0.00, 'rgba(255,255,235,1.00)');
    g.addColorStop(0.18, 'rgba(255,222,112,0.96)');
    g.addColorStop(0.42, 'rgba(255,104,28,0.78)');
    g.addColorStop(0.68, 'rgba(116,38,20,0.38)');
    g.addColorStop(1.00, 'rgba(0,0,0,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    // Dark smoke scallops around the edge so the sprite doesn't read as
    // a perfect disc.
    for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = size * (0.26 + Math.random() * 0.18);
        const x = size / 2 + Math.cos(a) * r;
        const y = size / 2 + Math.sin(a) * r;
        const rr = size * (0.10 + Math.random() * 0.10);
        const sg = ctx.createRadialGradient(x, y, 0, x, y, rr);
        sg.addColorStop(0, 'rgba(36,24,20,0.34)');
        sg.addColorStop(1, 'rgba(36,24,20,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, size, size);
    }

    fireballTexture = new THREE.CanvasTexture(canvas);
    fireballTexture.needsUpdate = true;
    registerShared(fireballTexture);
    return fireballTexture;
}

function getShockwaveGeometry() {
    if (!shockwaveGeometry) {
        shockwaveGeometry = new THREE.RingGeometry(0.78, 1.0, 72);
        shockwaveGeometry.rotateX(-Math.PI / 2);
        registerShared(shockwaveGeometry);
    }
    return shockwaveGeometry;
}

function getShockwaveMatTemplate() {
    if (!shockwaveMatTemplate) {
        shockwaveMatTemplate = new THREE.MeshBasicMaterial({
            color: 0xffd38a,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        registerShared(shockwaveMatTemplate);
    }
    return shockwaveMatTemplate;
}

function getDebrisGeometry() {
    if (!debrisGeometry) {
        debrisGeometry = new THREE.BoxGeometry(0.22, 0.10, 0.42);
        registerShared(debrisGeometry);
    }
    return debrisGeometry;
}

function getDebrisMaterial() {
    if (!debrisMaterial) {
        debrisMaterial = new THREE.MeshStandardMaterial({
            color: 0x2a2522,
            roughness: 0.78,
            metalness: 0.55,
            emissive: 0x331000,
            emissiveIntensity: 0.5,
        });
        registerShared(debrisMaterial);
    }
    return debrisMaterial;
}

// ─── Sound (Web Audio synthesized pop) ─────────────────────────────────────

let audioCtx = null;
function ensureAudio() {
    if (audioCtx) return audioCtx;
    audioCtx = createUnlockedAudioContext();
    return audioCtx;
}
function playGunshotSound() {
    const ctx = ensureAudio();
    if (!ctx) return;
    resumeUnlockedAudioContext(ctx);

    const now = ctx.currentTime;
    // Short noise burst → "tk!" attack
    const bufferLen = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.012));
        data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.30, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    noise.connect(noiseGain).connect(getAudioDestination(ctx));
    noise.start(now);

    // Low thump for body
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.05);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.18, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    osc.connect(oscGain).connect(getAudioDestination(ctx));
    osc.start(now);
    osc.stop(now + 0.08);
}

function playMetalImpactSound(worldX, worldY, worldZ) {
    const ctx = ensureAudio();
    if (!ctx || !camera) return;
    resumeUnlockedAudioContext(ctx);

    const dx = worldX - camera.position.x;
    const dy = worldY - camera.position.y;
    const dz = worldZ - camera.position.z;
    const distM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const attenuation = Math.max(0, 1 - distM / METAL_IMPACT_AUDIBLE_M);
    if (attenuation <= 0.02) return;

    const now = ctx.currentTime;
    const dur = 0.055;
    const bufferLen = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.010));
        data[i] = (Math.random() * 2 - 1) * env;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500 + Math.random() * 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.20 * attenuation, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(hp).connect(gain).connect(getAudioDestination(ctx));
    noise.start(now);

    const ping = ctx.createOscillator();
    ping.type = 'triangle';
    ping.frequency.setValueAtTime(620 + Math.random() * 260, now);
    ping.frequency.exponentialRampToValueAtTime(260, now + 0.08);
    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(0.08 * attenuation, now);
    pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    ping.connect(pingGain).connect(getAudioDestination(ctx));
    ping.start(now);
    ping.stop(now + 0.10);
}

function playExplosionSound() {
    const ctx = ensureAudio();
    if (!ctx) return;
    resumeUnlockedAudioContext(ctx);

    const now = ctx.currentTime;
    // Long noise burst, low-pass-filtered into a boom.
    const dur = 0.6;
    const bufferLen = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.18));
        data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420, now);
    filter.frequency.exponentialRampToValueAtTime(80, now + 0.4);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.55, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(filter).connect(noiseGain).connect(getAudioDestination(ctx));
    noise.start(now);

    // Sub-bass thump for body
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(85, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.25);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.50, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(oscGain).connect(getAudioDestination(ctx));
    osc.start(now);
    osc.stop(now + 0.32);
}

// "Charging handle" sound played once when the player attaches the gun.
// Two metallic clacks — bolt back, bolt forward — separated by a brief
// spring-tension scrape. All synthesised: a short noise burst through a
// high-pass filter for each clack, plus a band-pass-filtered noise for
// the in-between motion.
function playWeaponArmSound() {
    const ctx = ensureAudio();
    if (!ctx) return;
    resumeUnlockedAudioContext(ctx);

    const t0 = ctx.currentTime;

    // Helper: short metallic clack at offset `at` seconds, peak `gain`.
    const clack = (at, gain) => {
        const dur = 0.06;
        const bufLen = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            const env = Math.exp(-i / (ctx.sampleRate * 0.008));
            data[i] = (Math.random() * 2 - 1) * env;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1800;
        const g = ctx.createGain();
        g.gain.setValueAtTime(gain, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
        noise.connect(hp).connect(g).connect(getAudioDestination(ctx));
        noise.start(t0 + at);
    };

    // Two clacks: pulled back (lighter), then closed (heavier).
    clack(0.00, 0.32);
    clack(0.18, 0.45);

    // Spring scrape between them — band-pass-filtered noise lasting
    // through the gap, low gain, sweeping slightly upward.
    const scrapeDur = 0.16;
    const scrapeBufLen = Math.floor(ctx.sampleRate * scrapeDur);
    const scrapeBuf = ctx.createBuffer(1, scrapeBufLen, ctx.sampleRate);
    const scrapeData = scrapeBuf.getChannelData(0);
    for (let i = 0; i < scrapeBufLen; i++) {
        const k = i / scrapeBufLen;
        // Soft swell-decay envelope.
        const env = Math.min(k / 0.15, 1) * (1 - k);
        scrapeData[i] = (Math.random() * 2 - 1) * env;
    }
    const scrapeSrc = ctx.createBufferSource();
    scrapeSrc.buffer = scrapeBuf;
    const scrapeBp = ctx.createBiquadFilter();
    scrapeBp.type = 'bandpass';
    scrapeBp.Q.value = 4.0;
    scrapeBp.frequency.setValueAtTime(2200, t0 + 0.04);
    scrapeBp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.04 + scrapeDur);
    const scrapeGain = ctx.createGain();
    scrapeGain.gain.setValueAtTime(0.10, t0 + 0.04);
    scrapeGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.04 + scrapeDur);
    scrapeSrc.connect(scrapeBp).connect(scrapeGain).connect(getAudioDestination(ctx));
    scrapeSrc.start(t0 + 0.04);
}

// ─── Mesh construction ─────────────────────────────────────────────────────

function buildGunMesh() {
    return buildMachineGunMesh({ metalMaterial: getMetalMat(), muzzleMaterial: getMuzzleMat(), register: registerShared });
}

// ─── Spawn / per-frame ─────────────────────────────────────────────────────

const _muzzleWorld = new THREE.Vector3();
const _camForward = new THREE.Vector3();

function spawnBullet() {
    if (!muzzleAnchor || !bulletsGroup) return;
    if (ammo <= 0) return;       // dry-fire: gun stays silent
    ammo--;
    muzzleAnchor.getWorldPosition(_muzzleWorld);
    // The direction tickWeapon settled on: the camera's forward for the
    // first-person gun, the clamped barrel direction for the roof turret.
    _camForward.copy(_aimDir);

    const mesh = new THREE.Mesh(getBulletGeometry(), getBulletMaterial());
    mesh.position.copy(_muzzleWorld);
    bulletsGroup.add(mesh);

    liveBullets.push({
        mesh,
        prevX: _muzzleWorld.x,
        prevY: _muzzleWorld.y,
        prevZ: _muzzleWorld.z,
        vx: _camForward.x * BULLET_SPEED_MPS,
        vy: _camForward.y * BULLET_SPEED_MPS,
        vz: _camForward.z * BULLET_SPEED_MPS,
        ttl: BULLET_LIFETIME_S,
    });

    // Pulse the muzzle flash and play sound for this shot.
    if (muzzleFlashMesh) {
        muzzleFlashMesh.visible = true;
        // Random rotation each shot so the flash doesn't look identical
        muzzleFlashMesh.rotation.set(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
        );
        muzzleFlashMesh.scale.setScalar(MUZZLE_FLASH_BASE_SCALE);
        muzzleFlashTtl = MUZZLE_FLASH_LIFETIME_S;
    }
    playGunshotSound();
}

function spawnSparksAt(x, y, z) {
    if (!sparksGroup) return;
    for (let i = 0; i < SPARK_COUNT_PER_HIT; i++) {
        const mesh = new THREE.Mesh(getSparkGeometry(), getSparkMaterial());
        mesh.position.set(x, y, z);
        sparksGroup.add(mesh);
        // Random direction with mild upward bias
        const theta = Math.random() * Math.PI * 2;
        const phi = (Math.random() - 0.2) * Math.PI / 2;
        const speed = SPARK_INITIAL_SPEED_MPS * (0.5 + Math.random());
        const cosPhi = Math.cos(phi);
        liveSparks.push({
            mesh,
            vx: Math.cos(theta) * cosPhi * speed,
            vy: Math.sin(phi) * speed + 1.5,
            vz: Math.sin(theta) * cosPhi * speed,
            ttl: SPARK_LIFETIME_S,
        });
    }
}

function spawnFireballAt(x, y, z) {
    if (!sparksGroup) return;
    const material = new THREE.SpriteMaterial({
        map: getFireballTexture(),
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    material.rotation = Math.random() * Math.PI * 2;
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y + 0.35, z);
    sprite.scale.setScalar(EXPLOSION_FIREBALL_START_SCALE_M);
    sprite.renderOrder = 30;
    sparksGroup.add(sprite);
    liveFireballs.push({
        sprite,
        ttl: EXPLOSION_FIREBALL_LIFETIME_S,
        spin: (Math.random() - 0.5) * 1.6,
        riseMps: 1.0 + Math.random() * 0.7,
    });
}

function spawnShockwaveAt(x, y, z) {
    if (!sparksGroup) return;
    const material = getShockwaveMatTemplate().clone();
    const ring = new THREE.Mesh(getShockwaveGeometry(), material);
    ring.position.set(x, Math.max(0.05, y - 0.65), z);
    ring.scale.setScalar(EXPLOSION_SHOCKWAVE_START_RADIUS_M);
    ring.renderOrder = 22;
    sparksGroup.add(ring);
    liveShockwaves.push({ mesh: ring, ttl: EXPLOSION_SHOCKWAVE_LIFETIME_S });
}

function spawnDebrisAt(x, y, z) {
    if (!sparksGroup) return;
    for (let i = 0; i < EXPLOSION_DEBRIS_COUNT; i++) {
        const mesh = new THREE.Mesh(getDebrisGeometry(), getDebrisMaterial());
        mesh.position.set(
            x + (Math.random() - 0.5) * 0.9,
            y + 0.2 + Math.random() * 0.35,
            z + (Math.random() - 0.5) * 0.9,
        );
        mesh.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI,
        );
        const scale = 0.55 + Math.random() * 1.25;
        mesh.scale.set(scale, scale * (0.8 + Math.random() * 0.5), scale);
        mesh.castShadow = true;
        sparksGroup.add(mesh);

        const theta = Math.random() * Math.PI * 2;
        const speed = EXPLOSION_DEBRIS_SPEED_MPS * (0.45 + Math.random() * 0.95);
        liveDebris.push({
            mesh,
            vx: Math.cos(theta) * speed,
            vy: 3.0 + Math.random() * 7.5,
            vz: Math.sin(theta) * speed,
            wx: (Math.random() - 0.5) * 9,
            wy: (Math.random() - 0.5) * 11,
            wz: (Math.random() - 0.5) * 9,
            ttl: EXPLOSION_DEBRIS_LIFETIME_S * (0.7 + Math.random() * 0.5),
            bounced: false,
        });
    }
}

function triggerCameraShakeAt(x, y, z) {
    if (!camera) return;
    const dx = camera.position.x - x;
    const dy = camera.position.y - y;
    const dz = camera.position.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const attenuation = Math.max(0, 1 - dist / EXPLOSION_CAMERA_SHAKE_RADIUS_M);
    if (attenuation <= 0.02) return;
    cameraShakeAmp = Math.max(cameraShakeAmp, EXPLOSION_CAMERA_SHAKE_MAX_M * attenuation);
    cameraShakeTtl = Math.max(cameraShakeTtl, EXPLOSION_CAMERA_SHAKE_LIFETIME_S);
}

function spawnExplosionAt(x, y, z) {
    if (!sparksGroup) return;
    spawnFireballAt(x, y, z);
    spawnShockwaveAt(x, y, z);
    spawnDebrisAt(x, y, z);
    triggerCameraShakeAt(x, y, z);

    // Bigger spark burst — denser, faster, with stronger upward bias.
    for (let i = 0; i < EXPLOSION_SPARK_COUNT; i++) {
        const mesh = new THREE.Mesh(getSparkGeometry(), getSparkMaterial());
        mesh.position.set(x, y, z);
        sparksGroup.add(mesh);
        const theta = Math.random() * Math.PI * 2;
        const phi = (Math.random() - 0.05) * Math.PI / 2;
        const speed = EXPLOSION_SPARK_SPEED_MPS * (0.5 + Math.random());
        const cosPhi = Math.cos(phi);
        liveSparks.push({
            mesh,
            vx: Math.cos(theta) * cosPhi * speed,
            vy: Math.sin(phi) * speed + 4,
            vz: Math.sin(theta) * cosPhi * speed,
            ttl: SPARK_LIFETIME_S * 1.8,
        });
    }
    // Bright expanding flash sphere — per-instance cloned material so we
    // can fade opacity / emissive without affecting concurrent flashes.
    const flashMat = getExplosionFlashMatTemplate().clone();
    const flash = new THREE.Mesh(getExplosionFlashGeo(), flashMat);
    flash.position.set(x, y, z);
    flash.scale.setScalar(0.3);
    sparksGroup.add(flash);
    liveFlashes.push({ mesh: flash, ttl: EXPLOSION_FLASH_LIFETIME_S });

    playExplosionSound();
}

function updateCameraShake(dt) {
    if (cameraShakeTtl <= 0 || cameraShakeAmp <= 0 || !camera) return;
    cameraShakeTtl -= dt;
    const k = Math.max(0, cameraShakeTtl / EXPLOSION_CAMERA_SHAKE_LIFETIME_S);
    const amp = cameraShakeAmp * k * k;
    camera.position.x += (Math.random() - 0.5) * amp;
    camera.position.y += (Math.random() - 0.5) * amp * 0.42;
    camera.position.z += (Math.random() - 0.5) * amp;
    if (cameraShakeTtl <= 0) {
        cameraShakeTtl = 0;
        cameraShakeAmp = 0;
    }
}

function updateFlashes(dt) {
    if (liveFlashes.length === 0) return;
    for (let i = liveFlashes.length - 1; i >= 0; i--) {
        const f = liveFlashes[i];
        f.ttl -= dt;
        if (f.ttl <= 0) {
            if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
            if (f.mesh.material) f.mesh.material.dispose();
            liveFlashes.splice(i, 1);
            continue;
        }
        const k = f.ttl / EXPLOSION_FLASH_LIFETIME_S;
        f.mesh.scale.setScalar(0.3 + (1 - k) * 1.5);     // expand outward
        f.mesh.material.opacity = k;
        f.mesh.material.emissiveIntensity = 5.0 * k;
    }
}

function updateFireballs(dt) {
    if (liveFireballs.length === 0) return;
    for (let i = liveFireballs.length - 1; i >= 0; i--) {
        const f = liveFireballs[i];
        f.ttl -= dt;
        if (f.ttl <= 0) {
            if (f.sprite.parent) f.sprite.parent.remove(f.sprite);
            if (f.sprite.material) f.sprite.material.dispose();
            liveFireballs.splice(i, 1);
            continue;
        }
        const age = 1 - f.ttl / EXPLOSION_FIREBALL_LIFETIME_S;
        const scale = EXPLOSION_FIREBALL_START_SCALE_M +
            (EXPLOSION_FIREBALL_END_SCALE_M - EXPLOSION_FIREBALL_START_SCALE_M) * age;
        f.sprite.scale.setScalar(scale);
        f.sprite.position.y += f.riseMps * dt;
        f.sprite.material.opacity = Math.max(0, (1 - age) * (1 - age * 0.35));
        f.sprite.material.rotation += f.spin * dt;
    }
}

function updateShockwaves(dt) {
    if (liveShockwaves.length === 0) return;
    for (let i = liveShockwaves.length - 1; i >= 0; i--) {
        const s = liveShockwaves[i];
        s.ttl -= dt;
        if (s.ttl <= 0) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            if (s.mesh.material) s.mesh.material.dispose();
            liveShockwaves.splice(i, 1);
            continue;
        }
        const age = 1 - s.ttl / EXPLOSION_SHOCKWAVE_LIFETIME_S;
        const radius = EXPLOSION_SHOCKWAVE_START_RADIUS_M +
            (EXPLOSION_SHOCKWAVE_END_RADIUS_M - EXPLOSION_SHOCKWAVE_START_RADIUS_M) * age;
        s.mesh.scale.set(radius, radius, 1);
        s.mesh.material.opacity = 0.85 * (1 - age) * (1 - age);
    }
}

function updateBullets(dt) {
    if (liveBullets.length === 0) return;
    for (let i = liveBullets.length - 1; i >= 0; i--) {
        const b = liveBullets[i];
        b.ttl -= dt;
        if (b.ttl <= 0) {
            // End of life with no hit → small spark burst (visual "miss"
            // marker at max range) and despawn.
            spawnSparksAt(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }
        b.prevX = b.mesh.position.x;
        b.prevY = b.mesh.position.y;
        b.prevZ = b.mesh.position.z;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;

        const x = b.mesh.position.x, y = b.mesh.position.y, z = b.mesh.position.z;

        // Collision priority starts with facades so nobody can shoot
        // through building walls to hit vehicles hidden behind them.
        const buildingHitPt = tryStampHole(getBuildingsGroup(),
            x, y, z, b.vx, b.vy, b.vz, { fifoCap: true });
        if (buildingHitPt) {
            spawnSparksAt(buildingHitPt.x, buildingHitPt.y, buildingHitPt.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }

        const hitNest = tryMachineGunNestHit(x, y, z, NEST_HIT_RADIUS_M);
        if (hitNest) {
            const alreadyDestroyed = !!hitNest.destroyed;
            spawnSparksAt(x, y, z);
            addMachineGunNestBulletHole(hitNest, x, y, z, b.vx, b.vy, b.vz);
            if (alreadyDestroyed) playMetalImpactSound(x, y, z);
            const justDestroyed = recordMachineGunNestHit(hitNest);
            if (justDestroyed) {
                spawnExplosionAt(hitNest.x, hitNest.y + 0.7, hitNest.z);
            }
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }

        // Vehicles use cheap body tests first, then surface stamping for
        // trams/building facades where the mesh can provide the exact hit.
        const hitCar = tryCarHit(x, y, z, BULLET_HIT_RADIUS_M);
        if (hitCar) {
            const alreadyWrecked = !!hitCar.wrecked;
            spawnSparksAt(x, y, z);
            addBulletHole(hitCar, x, y, z, b.vx, b.vy, b.vz);
            if (alreadyWrecked) playMetalImpactSound(x, y, z);
            const justWrecked = recordCarHit(hitCar);
            if (justWrecked) {
                spawnExplosionAt(
                    hitCar.mesh.position.x,
                    hitCar.mesh.position.y + 0.7,
                    hitCar.mesh.position.z);
            }
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }

        const hitTram = tryTramHit(x, y, z, BULLET_HIT_RADIUS_M);
        if (hitTram) {
            const alreadyWrecked = !!(hitTram.userData && hitTram.userData.wreckedTram);
            const tramHitPt = tryStampHole(getOtherTramsGroup(),
                x, y, z, b.vx, b.vy, b.vz);
            const fx = tramHitPt ? tramHitPt.x : x;
            const fy = tramHitPt ? tramHitPt.y : y;
            const fz = tramHitPt ? tramHitPt.z : z;
            spawnSparksAt(fx, fy, fz);
            // Bright orange flash + smoke puffs at every tram hit; the
            // flash is brief enough to read as an impact rather than a
            // sustained fire, and the trailing smoke lingers a few
            // seconds for damage feedback.
            spawnFireFlashAt(fx, fy, fz);
            if (alreadyWrecked) {
                playMetalImpactSound(fx, fy, fz);
            }
            const justWrecked = recordTramHit(hitTram);
            if (justWrecked) {
                spawnExplosionAt(
                    hitTram.position.x,
                    hitTram.position.y + 1.6,
                    hitTram.position.z);
            }
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }

    }
}

function updateSparks(dt) {
    if (liveSparks.length === 0) return;
    for (let i = liveSparks.length - 1; i >= 0; i--) {
        const s = liveSparks[i];
        s.ttl -= dt;
        if (s.ttl <= 0) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            liveSparks.splice(i, 1);
            continue;
        }
        s.vy -= SPARK_GRAVITY_MPS2 * dt;
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        // Fade by shrinking — material is shared, so per-mesh scale only.
        const k = Math.max(0, s.ttl / SPARK_LIFETIME_S);
        s.mesh.scale.setScalar(0.5 + k * 1.0);
    }
}

function updateDebris(dt) {
    if (liveDebris.length === 0) return;
    for (let i = liveDebris.length - 1; i >= 0; i--) {
        const d = liveDebris[i];
        d.ttl -= dt;
        if (d.ttl <= 0) {
            if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
            liveDebris.splice(i, 1);
            continue;
        }
        d.vy -= EXPLOSION_DEBRIS_GRAVITY_MPS2 * dt;
        d.mesh.position.x += d.vx * dt;
        d.mesh.position.y += d.vy * dt;
        d.mesh.position.z += d.vz * dt;
        d.mesh.rotation.x += d.wx * dt;
        d.mesh.rotation.y += d.wy * dt;
        d.mesh.rotation.z += d.wz * dt;

        if (d.mesh.position.y < 0.05) {
            d.mesh.position.y = 0.05;
            if (!d.bounced) {
                d.bounced = true;
                d.vy = Math.abs(d.vy) * 0.28;
                d.vx *= 0.55;
                d.vz *= 0.55;
                d.wx *= 0.55;
                d.wy *= 0.55;
                d.wz *= 0.55;
            } else {
                d.vy = 0;
                d.vx *= (1 - Math.min(0.95, 4 * dt));
                d.vz *= (1 - Math.min(0.95, 4 * dt));
            }
        }

        const k = Math.max(0.25, Math.min(1, d.ttl / EXPLOSION_DEBRIS_LIFETIME_S));
        d.mesh.scale.multiplyScalar(k < 0.35 ? 0.98 : 1);
    }
}

function updateMuzzleFlash(dt) {
    if (!muzzleFlashMesh || !muzzleFlashMesh.visible) return;
    muzzleFlashTtl -= dt;
    if (muzzleFlashTtl <= 0) {
        muzzleFlashMesh.visible = false;
        return;
    }
    const k = muzzleFlashTtl / MUZZLE_FLASH_LIFETIME_S;
    muzzleFlashMesh.scale.setScalar(MUZZLE_FLASH_BASE_SCALE * (0.5 + k * 1.2));
}

// ─── Public API ────────────────────────────────────────────────────────────

export function setWeaponFiring(on) {
    isFiring = !!on;
}

// Bolt the gun to a vehicle, or pass null to hand it back to the camera. The
// callback is polled every frame so the turret follows the car without this
// module knowing anything about vehicles.
// The post is built once and parked out of sight rather than rebuilt per frame.
function syncMountPost(mount, yaw) {
    if (!mountPost) {
        const geometry = new THREE.CylinderGeometry(
            MOUNT_POST_RADIUS_M,
            MOUNT_POST_RADIUS_M * 1.35,
            MOUNT_CLEARANCE_M,
            10,
        );
        registerShared(geometry);
        mountPost = new THREE.Mesh(geometry, getMetalMat());
        mountPost.name = 'PlayerWeaponMount';
        scene.add(mountPost);
    }
    mountPost.visible = true;
    // Sits between the roof and the gun, so half its length below the pivot.
    mountPost.position.set(
        Number(mount.x) || 0,
        (Number(mount.y) || 0) + MOUNT_CLEARANCE_M * 0.5,
        Number(mount.z) || 0,
    );
    mountPost.rotation.set(0, yaw, 0);
}

function hideMountPost() {
    if (mountPost) mountPost.visible = false;
}

function disposeMountPost() {
    if (!mountPost) return;
    if (mountPost.parent) mountPost.parent.remove(mountPost);
    mountPost = null;
}

export function setWeaponMount(mountFn) {
    weaponMountFn = typeof mountFn === 'function' ? mountFn : null;
    if (!weaponMountFn) hideMountPost();
    if (!weaponMountFn && gunRig) {
        gunRig.position.set(0, 0, 0);
        gunRig.scale.setScalar(1);
    }
}

// Whether the gun is on a vehicle RIGHT NOW, not merely whether a mount was
// offered: the callback returns null while the player is between vehicles, and
// callers use this to decide visibility and aim behaviour at that instant.
export function isWeaponMounted() {
    return !!(weaponMountFn && weaponMountFn());
}

export function isWeaponAttached() {
    return weaponGroup !== null;
}

export function setWeaponVisible(visible) {
    if (weaponGroup) weaponGroup.visible = !!visible;
    if (!visible) isFiring = false;
}

// ─── Ammo (gamification) ──────────────────────────────────────────────────

export function getAmmo() {
    return ammo;
}

// Reset back to STARTING_AMMO at the beginning of a cab session.
export function resetAmmo() {
    ammo = STARTING_AMMO;
}

// Add `n` rounds (used by cab.js when the tram stops at a station).
export function addAmmo(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    ammo += Math.floor(n);
}

export function attachWeapon() {
    if (weaponGroup) return;
    const built = buildGunMesh();
    gunRig = built.group;
    weaponGroup = new THREE.Group();
    weaponGroup.name = 'PlayerWeapon';
    weaponGroup.add(gunRig);
    muzzleAnchor = built.muzzle;
    muzzleFlashMesh = built.flash;
    // The camera is NOT in the scene graph (renderer uses it as the
    // viewpoint without it being a child), so attaching the gun as a
    // child of the camera would never render. Instead we put the gun
    // straight in the scene and sync its position/rotation to the camera
    // each frame — visually identical to camera-parenting.
    scene.add(weaponGroup);

    if (!bulletsGroup) {
        bulletsGroup = new THREE.Group();
        scene.add(bulletsGroup);
    }
    if (!sparksGroup) {
        sparksGroup = new THREE.Group();
        scene.add(sparksGroup);
    }
    isFiring = false;
    lastFireMs = 0;
    muzzleFlashTtl = 0;
    // Charging-handle clack — plays whenever the gun comes into view (G
    // press on desktop, long-press on mobile).
    playWeaponArmSound();
}

export function detachWeapon() {
    if (weaponGroup) {
        if (weaponGroup.parent) weaponGroup.parent.remove(weaponGroup);
        weaponGroup = null;
        gunRig = null;
        disposeMountPost();
        muzzleAnchor = null;
        muzzleFlashMesh = null;
    }
    if (bulletsGroup) {
        for (const b of liveBullets) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        }
        liveBullets.length = 0;
        if (bulletsGroup.parent) bulletsGroup.parent.remove(bulletsGroup);
        bulletsGroup = null;
    }
    if (sparksGroup) {
        for (const s of liveSparks) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        }
        liveSparks.length = 0;
        for (const f of liveFlashes) {
            if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
            if (f.mesh.material) f.mesh.material.dispose();
        }
        liveFlashes.length = 0;
        for (const f of liveFireballs) {
            if (f.sprite.parent) f.sprite.parent.remove(f.sprite);
            if (f.sprite.material) f.sprite.material.dispose();
        }
        liveFireballs.length = 0;
        for (const s of liveShockwaves) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            if (s.mesh.material) s.mesh.material.dispose();
        }
        liveShockwaves.length = 0;
        for (const d of liveDebris) {
            if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
        }
        liveDebris.length = 0;
        if (sparksGroup.parent) sparksGroup.parent.remove(sparksGroup);
        sparksGroup = null;
    }
    // Drop FIFO-tracked facade holes too — the only ones not auto-evicted
    // by their parent (buildings live longer than weapon sessions).
    clearFifoHoles();
    isFiring = false;
    cameraShakeTtl = 0;
    cameraShakeAmp = 0;
}

export function tickWeapon(dt) {
    updateCameraShake(dt);
    if (weaponGroup) {
        const mount = weaponMountFn ? weaponMountFn() : null;
        if (mount) {
            // Roof turret: ride the vehicle, swing to the look direction within
            // the barrel's limits, and remember the direction it settled on so
            // the bullets leave along the barrel rather than along the camera.
            camera.getWorldDirection(_mountAim);
            const aim = mountedWeaponAim(_mountAim);
            weaponGroup.position.set(
                Number(mount.x) || 0,
                (Number(mount.y) || 0) + MOUNT_CLEARANCE_M,
                Number(mount.z) || 0,
            );
            weaponGroup.rotation.set(aim.pitch, aim.yaw, 0, 'YXZ');
            syncMountPost(mount, aim.yaw);
            _aimDir.set(aim.dir.x, aim.dir.y, aim.dir.z);
            // Centre the gun over its mount instead of hanging at the corner of
            // a first-person view.
            gunRig.position.set(-GUN_X, -GUN_Y, 0);
            gunRig.scale.setScalar(MOUNT_SCALE);
        } else {
            // Mirror the camera's world transform so the gun behaves as if
            // it were a camera child, but actually rendered via the scene.
            weaponGroup.position.copy(camera.position);
            weaponGroup.quaternion.copy(camera.quaternion);
            camera.getWorldDirection(_aimDir);
            hideMountPost();
        }
    }
    if (isFiring && weaponGroup) {
        const now = performance.now();
        if (now - lastFireMs >= FIRE_INTERVAL_MS) {
            spawnBullet();
            lastFireMs = now;
        }
    }
    updateMuzzleFlash(dt);
    updateBullets(dt);
    updateSparks(dt);
    updateDebris(dt);
    updateFlashes(dt);
    updateFireballs(dt);
    updateShockwaves(dt);
}
