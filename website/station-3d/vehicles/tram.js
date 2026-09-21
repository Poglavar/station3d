// Ambient tram lifecycle, placement, interactions, and combat use shared vehicle models.
// Tram-car mesh factory and the per-frame updater for the "other trams" layer
// (every live tram except the one the cab camera is attached to).
//
// Body geometry + non-paint materials are cached once and cloned per instance;
// only the line-number canvas/texture/material is per-instance, and those are
// tracked on group.userData.disposables[] so the shared dispose helper can
// free them when the tram leaves the scene.
// TMK 2400 proportions and appearance reference (CC BY-SA 4.0 photograph):
// https://commons.wikimedia.org/wiki/File:Kon%C4%8Dar_TMK_2400,_left_front,_Borongaj,_2025.jpg

import * as THREE from 'three';
import { finiteOrNull, geoToLocal } from '../core/math.js';
import { disposeGroup } from '../core/dispose.js';
import {
    buildGtaAmbientTramPathSteps,
    isAmbientTrainFeature,
} from '../core/gta-ambient-trams.js';
import {
    AMBIENT_TRAIN_CRUISE,
    AMBIENT_TRAIN_POLICY,
    AMBIENT_TRAM_STATES,
    createAmbientTramProvider,
} from '../core/ambient-tram-provider.js';
import { ambientTrainStationServiceForAnchor } from '../core/ambient-train-station-services.js';
import { ROLLING_STOCK_HZ_7022, selectRollingStock } from '../core/rolling-stock.js';
import {
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { createHz7022Mesh } from '../models/vehicles/hz-7022.js';
import { scene, camera } from '../scene/setup.js';
import { spawnSmokeAt, spawnFireFlashAt } from '../world/cars.js';
import {
    playEnemyShotSound, playBulletWhizForSegment, playPlayerBulletHitSound,
} from '../ui/combat-sfx.js';
import { getEnemyMusicTrackCount, queueEnemyMusicSpeaker } from '../ui/enemy-music.js';
import * as cabVoice from '../ui/cab-voice.js';
import { getBuildingsGroup } from '../world/buildings.js';
import {
    getActiveRailTrafficSource,
    tramTrackbedSupportYAtLocal,
} from '../world/rails.js';
import { tryStampHole, hasLineOfSight } from '../world/bullet-marks.js';

// Session state
import {
    createTramMesh, setTramDoorsOpen, updateTramRenderLod, disposeTramSessionCaches,
    getEnemyTramBulletGeometry, getEnemyTramBulletMaterial,
    getEnemyTramImpactGeometry, getEnemyTramImpactMaterial,
    TRAM_MAX_HEALTH, TRAM_HALF_LENGTH_M, TRAM_HALF_WIDTH_M,
    TRAM_FRONT_EXTENT_M, TRAM_REAR_EXTENT_M, TRAM_COLLISION_HALF_WIDTH_M,
    ENEMY_TRAM_FRONT_EXTENT_M, ENEMY_TRAM_REAR_EXTENT_M,
} from '../models/vehicles/tram.js';

let otherTramsGroup = null;
let otherTrainsFn = null;
let anchorLat = 0, anchorLon = 0;
let terrainReference = null;
let instances = new Map();   // trainId → THREE.Group
let tramHealthById = new Map();
let onPlayerTramDamage = null;
let destroyedTramIds = new Set();
const wreckedTrams = [];
let ambientHostilesFn = () => false;
let isTrainSession = false;
let gtaAmbientTramsEnabled = false;
let gtaAmbientRailRevision = -1;
let gtaAmbientPaths = [];
let gtaAmbientProvider = null;
let gtaAmbientPathBuild = null;
// The heavy-rail fleet: HŽ trains on the streamed main lines, hailed and
// boarded through the same provider contract as the trams.
let gtaAmbientTrainProvider = null;
let gtaAmbientTrainRailRevision = -1;
let gtaAmbientTrainPaths = [];
let gtaAmbientTrainPathBuild = null;
let gtaRoadFormation = null;
let otherTramUpdatePhase = 0;
let otherTramSeenCycle = new Set();

// Four small tram units inside the 1.4 km render bubble reads like a busy
// central service without filling every OSM way with a vehicle. Revenue paths
// also enforce a minimum useful run length in gta-ambient-trams.js.
const GTA_AMBIENT_TRAM_LIMIT = 4;
const GTA_AMBIENT_TRAIN_LIMIT = 2;
// A train needs a run, not a way: chained ways shorter than this are skipped.
const GTA_AMBIENT_TRAIN_MIN_RUN_M = 1200;
const GTA_AMBIENT_TRAM_COLOR = '#1560a8';
const OTHER_TRAM_UPDATE_PHASES = 2;
// Streamed rail publication can advance several times while the observer moves.
// Rebuilding every GTA path synchronously on each revision produced measured
// 109-239 ms otherTrams hooks. Keep the last complete fleet authoritative and
// advance a stale-safe replacement in small chunks instead.
const GTA_AMBIENT_PATH_BUILD_BUDGET_MS = 1;
const GTA_AMBIENT_PATH_BUILD_STEPS_PER_FRAME = 32;

const ENEMY_TRAM_COLOR = '#c01822';
const ENEMY_TRAM_DENOM = 4;
const ENEMY_TRAM_FIRE_RANGE_M = 240;
const ENEMY_TRAM_MIN_RANGE_M = 28;
const ENEMY_TRAM_BURST_MIN = 2;
const ENEMY_TRAM_BURST_MAX = 4;
const ENEMY_TRAM_BURST_CADENCE_S = 0.22;
const ENEMY_TRAM_BURST_COOLDOWN_MIN_S = 1.8;
const ENEMY_TRAM_BURST_COOLDOWN_MAX_S = 3.2;
const ENEMY_TRAM_BULLET_SPEED_MPS = 105;
const ENEMY_TRAM_BULLET_LIFETIME_S = 2.4;
const ENEMY_TRAM_BULLET_DAMAGE = 5;
const ENEMY_TRAM_AIM_SPREAD_BASE_M = 2.0;
const ENEMY_TRAM_AIM_SPREAD_PER_M = 0.010;
const ENEMY_TRAM_MUZZLE_FLASH_LIFETIME_S = 0.08;
const ENEMY_TRAM_IMPACT_SPARKS = 7;
const ENEMY_TRAM_IMPACT_LIFETIME_S = 0.36;
const ENEMY_TRAM_IMPACT_SPEED_MPS = 4.0;
const TRAM_BULLET_DAMAGE = 10;
const TRAM_HEALTH_BAR_CANVAS_W = 160;
const TRAM_HEALTH_BAR_CANVAS_H = 24;
const TRAM_HEALTH_BAR_WIDTH_M = 4.2;
const TRAM_HEALTH_BAR_HEIGHT_M = 0.42;
const TRAM_HEALTH_BAR_VISIBLE_RADIUS_M = 320;

let enemyTramProjectilesGroup = null;
const liveEnemyTramBullets = [];
const liveEnemyTramImpacts = [];

function drawTramHealthBar(mesh) {
    const bar = mesh && mesh.userData && mesh.userData.healthBar;
    if (!bar) return;
    const maxHealth = mesh.userData.tramMaxHealth || TRAM_MAX_HEALTH;
    const health = mesh.userData.tramHealth == null ? maxHealth : mesh.userData.tramHealth;
    const ratio = Math.max(0, Math.min(1, health / maxHealth));

    bar.ctx.clearRect(0, 0, TRAM_HEALTH_BAR_CANVAS_W, TRAM_HEALTH_BAR_CANVAS_H);
    bar.ctx.fillStyle = 'rgba(15,23,42,0.84)';
    bar.ctx.fillRect(0, 0, TRAM_HEALTH_BAR_CANVAS_W, TRAM_HEALTH_BAR_CANVAS_H);
    bar.ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    bar.ctx.lineWidth = 2;
    bar.ctx.strokeRect(1, 1, TRAM_HEALTH_BAR_CANVAS_W - 2, TRAM_HEALTH_BAR_CANVAS_H - 2);
    bar.ctx.fillStyle = ratio <= 0.25 ? '#ef4444' : ratio <= 0.55 ? '#f59e0b' : '#22c55e';
    bar.ctx.fillRect(4, 4, Math.max(0, (TRAM_HEALTH_BAR_CANVAS_W - 8) * ratio), TRAM_HEALTH_BAR_CANVAS_H - 8);
    bar.texture.needsUpdate = true;
}

function ensureTramHealthBar(mesh) {
    if (!mesh || mesh.userData.healthBar) return;
    const canvas = document.createElement('canvas');
    canvas.width = TRAM_HEALTH_BAR_CANVAS_W;
    canvas.height = TRAM_HEALTH_BAR_CANVAS_H;
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, 5.1, 0);
    sprite.scale.set(TRAM_HEALTH_BAR_WIDTH_M, TRAM_HEALTH_BAR_HEIGHT_M, 1);
    sprite.renderOrder = 24;
    sprite.raycast = () => {};
    mesh.add(sprite);
    mesh.userData.healthBar = {
        canvas,
        ctx: canvas.getContext('2d'),
        texture,
        material,
        sprite,
    };
}

function disposeTramHealthBar(mesh) {
    const bar = mesh && mesh.userData && mesh.userData.healthBar;
    if (!bar) return;
    if (bar.sprite && bar.sprite.parent) bar.sprite.parent.remove(bar.sprite);
    if (bar.material) bar.material.dispose();
    if (bar.texture) bar.texture.dispose();
    mesh.userData.healthBar = null;
}

function updateTramHealthBarVisibility(mesh) {
    const bar = mesh && mesh.userData && mesh.userData.healthBar;
    if (!bar || !camera) return;
    const distanceM = tramDistanceToCamera(mesh);
    const visibleR2 = TRAM_HEALTH_BAR_VISIBLE_RADIUS_M * TRAM_HEALTH_BAR_VISIBLE_RADIUS_M;
    bar.sprite.visible = Number.isFinite(distanceM) && distanceM * distanceM <= visibleR2;
}

function tramDistanceToCamera(mesh) {
    if (!mesh || !camera) return null;
    const dx = mesh.position.x - camera.position.x;
    const dy = mesh.position.y - camera.position.y;
    const dz = mesh.position.z - camera.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function updateTramHealthBar(mesh) {
    if (!mesh || mesh.userData.wreckedTram) {
        disposeTramHealthBar(mesh);
        return;
    }
    const maxHealth = mesh.userData.tramMaxHealth || TRAM_MAX_HEALTH;
    const health = mesh.userData.tramHealth == null ? maxHealth : mesh.userData.tramHealth;
    if (health >= maxHealth) {
        disposeTramHealthBar(mesh);
        return;
    }
    ensureTramHealthBar(mesh);
    drawTramHealthBar(mesh);
    updateTramHealthBarVisibility(mesh);
}

function addWreckDetails(mesh) {
    const disposables = mesh.userData.disposables || (mesh.userData.disposables = []);
    const scorchMat = new THREE.MeshStandardMaterial({
        color: 0x15100e,
        roughness: 0.95,
        metalness: 0.15,
        transparent: true,
        opacity: 0.82,
    });
    const emberMat = new THREE.MeshStandardMaterial({
        color: 0x2a1408,
        emissive: 0xff3b10,
        emissiveIntensity: 0.7,
        roughness: 0.8,
    });
    const tornMat = new THREE.MeshStandardMaterial({
        color: 0x2f3438,
        roughness: 0.75,
        metalness: 0.65,
    });
    disposables.push(scorchMat, emberMat, tornMat);

    const sideScorchGeom = new THREE.BoxGeometry(0.08, 1.6, 5.8);
    const roofScorchGeom = new THREE.BoxGeometry(1.75, 0.08, 6.5);
    const tornBeamGeom = new THREE.BoxGeometry(0.16, 0.16, 3.4);
    const emberGeom = new THREE.SphereGeometry(0.18, 8, 6);
    disposables.push(sideScorchGeom, roofScorchGeom, tornBeamGeom, emberGeom);

    for (const side of [-1, 1]) {
        const scorch = new THREE.Mesh(sideScorchGeom, scorchMat);
        scorch.position.set(side * 1.25, 1.85, -1.5 + side * 1.4);
        scorch.rotation.set(0.12, side * 0.08, side * 0.04);
        mesh.add(scorch);
    }

    const roofScorch = new THREE.Mesh(roofScorchGeom, scorchMat);
    roofScorch.position.set(0.18, 3.58, -1.1);
    roofScorch.rotation.set(0.03, 0.05, -0.12);
    mesh.add(roofScorch);

    for (let i = 0; i < 5; i++) {
        const beam = new THREE.Mesh(tornBeamGeom, tornMat);
        beam.position.set((Math.random() - 0.5) * 1.4, 3.8 + Math.random() * 0.6, -3.6 + i * 1.4);
        beam.rotation.set(
            (Math.random() - 0.5) * 0.7,
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 1.4,
        );
        mesh.add(beam);
    }

    for (let i = 0; i < 7; i++) {
        const ember = new THREE.Mesh(emberGeom, emberMat);
        ember.position.set((Math.random() - 0.5) * 1.7, 0.65 + Math.random() * 1.8, -5 + Math.random() * 9.5);
        ember.scale.setScalar(0.45 + Math.random() * 0.8);
        mesh.add(ember);
    }
}

function wreckTram(mesh) {
    if (!mesh || mesh.userData.wreckedTram) return;
    mesh.userData.wreckedTram = true;
    mesh.userData.enemyTram = false;
    mesh.userData.enemyTramWeapon = null;
    disposeTramHealthBar(mesh);
    mesh.scale.set(1.06, 0.78, 1.0);
    mesh.rotation.z = (Math.random() < 0.5 ? -1 : 1) * (0.10 + Math.random() * 0.08);
    mesh.position.y = 0.05;
    addWreckDetails(mesh);
    wreckedTrams.push(mesh);
}

// Meshes within HIDE_RADIUS_M of the cab camera are hidden — at a shared stop
// or junction, an overlapping tram body would otherwise envelop the camera
// and block the entire view.
const HIDE_RADIUS_M = 15;
// Fog fully hides geometry after 1,200 m. Avoid constructing the complete tram
// hierarchy until it is close enough to become visible, then retain it through
// a small outer band so trams near the boundary do not churn every frame.
const OTHER_TRAM_CREATE_RADIUS_M = 1400;
const OTHER_TRAM_RETAIN_RADIUS_M = 1500;
const OTHER_TRAM_CREATE_RADIUS_M_2 = OTHER_TRAM_CREATE_RADIUS_M * OTHER_TRAM_CREATE_RADIUS_M;
const OTHER_TRAM_RETAIN_RADIUS_M_2 = OTHER_TRAM_RETAIN_RADIUS_M * OTHER_TRAM_RETAIN_RADIUS_M;

function hashEnemyTramId(value) {
    const s = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function isEnemyEligiblePose(pose) {
    return !!pose && pose.lineNumber != null;
}

function buildEnemyTramIdSet(poses) {
    if (!ambientHostilesFn()) return new Set();
    const ids = new Set();
    let bestFallback = null;
    for (const pose of poses) {
        if (!isEnemyEligiblePose(pose)) continue;
        const id = String(pose.id);
        const hash = hashEnemyTramId(id);
        if (hash % ENEMY_TRAM_DENOM === 0) {
            ids.add(id);
        }
        if (!bestFallback || hash < bestFallback.hash) {
            bestFallback = { id, hash };
        }
    }
    if (ids.size === 0 && bestFallback) {
        ids.add(bestFallback.id);
    }
    return ids;
}

function ensureEnemyTramProjectilesGroup() {
    if (!enemyTramProjectilesGroup) {
        enemyTramProjectilesGroup = new THREE.Group();
        scene.add(enemyTramProjectilesGroup);
    }
}

const _enemyTramMuzzleWorld = new THREE.Vector3();
const _enemyTramBulletDir = new THREE.Vector3();
const _enemyTramBulletUp = new THREE.Vector3(0, 1, 0);

function enemyTramHasLineOfSight(mesh, target) {
    const weapon = mesh && mesh.userData && mesh.userData.enemyTramWeapon;
    if (!weapon || !weapon.muzzle || !target) return false;
    weapon.muzzle.getWorldPosition(_enemyTramMuzzleWorld);
    const buildingsClear = hasLineOfSight(
        getBuildingsGroup(),
        _enemyTramMuzzleWorld.x, _enemyTramMuzzleWorld.y, _enemyTramMuzzleWorld.z,
        target.x, target.y, target.z,
        { targetPad: 0.4 },
    );
    if (!buildingsClear) return false;
    // Block the AI from "seeing" through other trams the same way we
    // block its bullets. Exclude the firing tram itself so its own body
    // never blocks its own line of sight.
    return !segmentBlockedByOtherTram(
        _enemyTramMuzzleWorld.x, _enemyTramMuzzleWorld.y, _enemyTramMuzzleWorld.z,
        target.x, target.y, target.z,
        mesh,
    );
}

function getPlayerTramTarget(pose, local) {
    if (local && Number.isFinite(local.x) && Number.isFinite(local.z)) {
        return {
            x: local.x,
            y: 1.75,
            z: local.z,
        };
    }
    if (!camera) return null;
    return {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
    };
}

function getPlayerTramBox(pose, local) {
    if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.z) || !pose) return null;
    const headingRad = (Number(pose.headingDeg) || 0) * Math.PI / 180;
    return {
        x: local.x,
        z: local.z,
        sin: Math.sin(headingRad),
        cos: Math.cos(headingRad),
        halfL: TRAM_HALF_LENGTH_M,
        halfW: TRAM_HALF_WIDTH_M,
    };
}

function segmentHitsAxis(min, max, p0, p1, hit) {
    const d = p1 - p0;
    if (Math.abs(d) < 0.00001) {
        return p0 >= min && p0 <= max;
    }
    let t0 = (min - p0) / d;
    let t1 = (max - p0) / d;
    if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
    }
    hit.min = Math.max(hit.min, t0);
    hit.max = Math.min(hit.max, t1);
    return hit.min <= hit.max;
}

function segmentHitsSphere(x0, y0, z0, x1, y1, z1, cx, cy, cz, radius) {
    const sx = x1 - x0;
    const sy = y1 - y0;
    const sz = z1 - z0;
    const len2 = sx * sx + sy * sy + sz * sz;
    const t = len2 > 0
        ? Math.max(0, Math.min(1, ((cx - x0) * sx + (cy - y0) * sy + (cz - z0) * sz) / len2))
        : 0;
    const px = x0 + sx * t;
    const py = y0 + sy * t;
    const pz = z0 + sz * t;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
}

function segmentHitsPlayerTramBox(bullet, box) {
    const x0 = bullet.prevX - box.x;
    const z0 = bullet.prevZ - box.z;
    const x1 = bullet.mesh.position.x - box.x;
    const z1 = bullet.mesh.position.z - box.z;
    const p0x = x0 * box.cos + z0 * box.sin;
    const p0z = -x0 * box.sin + z0 * box.cos;
    const p1x = x1 * box.cos + z1 * box.sin;
    const p1z = -x1 * box.sin + z1 * box.cos;
    const hit = { min: 0, max: 1 };
    return segmentHitsAxis(-box.halfW - 0.85, box.halfW + 0.85, p0x, p1x, hit) &&
        segmentHitsAxis(0.25, 4.0, bullet.prevY, bullet.mesh.position.y, hit) &&
        segmentHitsAxis(-box.halfL - 0.85, box.halfL + 0.85, p0z, p1z, hit);
}

function updateEnemyTramAim(mesh, target) {
    const weapon = mesh.userData && mesh.userData.enemyTramWeapon;
    if (!weapon || !target) return;
    const dx = target.x - mesh.position.x;
    const dz = target.z - mesh.position.z;
    const worldYaw = Math.atan2(dx, dz);
    weapon.yawGroup.rotation.y = worldYaw - mesh.rotation.y;
}

function updateEnemyTramMuzzleFlash(mesh, dt) {
    const weapon = mesh.userData && mesh.userData.enemyTramWeapon;
    if (!weapon || !weapon.flash) return;
    weapon.flashTtl = Math.max(0, (weapon.flashTtl || 0) - dt);
    if (weapon.flashTtl <= 0) {
        weapon.flash.visible = false;
        return;
    }
    const k = weapon.flashTtl / ENEMY_TRAM_MUZZLE_FLASH_LIFETIME_S;
    weapon.flash.visible = true;
    weapon.flash.scale.setScalar(0.50 + k * 1.25);
}

function spawnEnemyTramBullet(mesh, target) {
    const weapon = mesh.userData && mesh.userData.enemyTramWeapon;
    if (!weapon || !weapon.muzzle || !target) return;
    ensureEnemyTramProjectilesGroup();

    weapon.muzzle.getWorldPosition(_enemyTramMuzzleWorld);
    const dx = target.x - _enemyTramMuzzleWorld.x;
    const dy = target.y - _enemyTramMuzzleWorld.y;
    const dz = target.z - _enemyTramMuzzleWorld.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const spread = ENEMY_TRAM_AIM_SPREAD_BASE_M + dist * ENEMY_TRAM_AIM_SPREAD_PER_M;
    const targetX = target.x + (Math.random() - 0.5) * spread;
    const targetY = target.y + (Math.random() - 0.5) * spread * 0.42;
    const targetZ = target.z + (Math.random() - 0.5) * spread;
    _enemyTramBulletDir.set(
        targetX - _enemyTramMuzzleWorld.x,
        targetY - _enemyTramMuzzleWorld.y,
        targetZ - _enemyTramMuzzleWorld.z,
    ).normalize();

    const bullet = new THREE.Mesh(getEnemyTramBulletGeometry(), getEnemyTramBulletMaterial());
    bullet.position.copy(_enemyTramMuzzleWorld);
    bullet.quaternion.setFromUnitVectors(_enemyTramBulletUp, _enemyTramBulletDir);
    enemyTramProjectilesGroup.add(bullet);
    liveEnemyTramBullets.push({
        mesh: bullet,
        // ownerMesh keeps the firing tram's own body from blocking its
        // outgoing shot — the muzzle sits just outside the body, but a
        // bullet's first step could clip back into it numerically.
        ownerMesh: mesh,
        prevX: _enemyTramMuzzleWorld.x,
        prevY: _enemyTramMuzzleWorld.y,
        prevZ: _enemyTramMuzzleWorld.z,
        vx: _enemyTramBulletDir.x * ENEMY_TRAM_BULLET_SPEED_MPS,
        vy: _enemyTramBulletDir.y * ENEMY_TRAM_BULLET_SPEED_MPS,
        vz: _enemyTramBulletDir.z * ENEMY_TRAM_BULLET_SPEED_MPS,
        ttl: ENEMY_TRAM_BULLET_LIFETIME_S,
    });
    playEnemyShotSound(_enemyTramMuzzleWorld.x, _enemyTramMuzzleWorld.y, _enemyTramMuzzleWorld.z, { heavy: true });

    if (weapon.flash) {
        weapon.flash.visible = true;
        weapon.flash.rotation.set(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
        );
        weapon.flashTtl = ENEMY_TRAM_MUZZLE_FLASH_LIFETIME_S;
    }
}

function spawnEnemyTramImpactAt(x, y, z) {
    ensureEnemyTramProjectilesGroup();
    for (let i = 0; i < ENEMY_TRAM_IMPACT_SPARKS; i++) {
        const spark = new THREE.Mesh(getEnemyTramImpactGeometry(), getEnemyTramImpactMaterial());
        spark.position.set(x, y, z);
        enemyTramProjectilesGroup.add(spark);
        const theta = Math.random() * Math.PI * 2;
        const speed = ENEMY_TRAM_IMPACT_SPEED_MPS * (0.45 + Math.random());
        liveEnemyTramImpacts.push({
            mesh: spark,
            vx: Math.cos(theta) * speed,
            vy: 1.0 + Math.random() * 2.5,
            vz: Math.sin(theta) * speed,
            ttl: ENEMY_TRAM_IMPACT_LIFETIME_S,
        });
    }
}

function enemyTramBulletHitsPlayer(bullet, playerBox, target) {
    if (playerBox) return segmentHitsPlayerTramBox(bullet, playerBox);
    if (!target) return false;
    return segmentHitsSphere(
        bullet.prevX, bullet.prevY, bullet.prevZ,
        bullet.mesh.position.x, bullet.mesh.position.y, bullet.mesh.position.z,
        target.x, target.y, target.z,
        6.0,
    );
}

function updateEnemyTramBullets(dt, playerBox, target) {
    if (liveEnemyTramBullets.length === 0) return;
    for (let i = liveEnemyTramBullets.length - 1; i >= 0; i--) {
        const b = liveEnemyTramBullets[i];
        b.ttl -= dt;
        if (b.ttl <= 0) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyTramBullets.splice(i, 1);
            continue;
        }
        b.prevX = b.mesh.position.x;
        b.prevY = b.mesh.position.y;
        b.prevZ = b.mesh.position.z;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;
        if (!b.whizPlayed) {
            b.whizPlayed = playBulletWhizForSegment(
                b.prevX, b.prevY, b.prevZ,
                b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            );
        }
        const buildingHitPt = tryStampHole(getBuildingsGroup(),
            b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            b.vx, b.vy, b.vz, { fifoCap: true });
        if (buildingHitPt) {
            spawnEnemyTramImpactAt(buildingHitPt.x, buildingHitPt.y, buildingHitPt.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyTramBullets.splice(i, 1);
            continue;
        }
        // Other trams (friendly, wreck, or another enemy) act as solid
        // cover. Test before the player check so a tram between this
        // bullet and the player tram absorbs the round.
        const tramBlock = segmentBlockedByOtherTram(
            b.prevX, b.prevY, b.prevZ,
            b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            b.ownerMesh,
        );
        if (tramBlock) {
            spawnEnemyTramImpactAt(tramBlock.x, tramBlock.y, tramBlock.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyTramBullets.splice(i, 1);
            continue;
        }
        if (enemyTramBulletHitsPlayer(b, playerBox, target)) {
            if (typeof onPlayerTramDamage === 'function') {
                onPlayerTramDamage(ENEMY_TRAM_BULLET_DAMAGE, {
                    source: 'enemy-tram',
                    vehicleType: 'tram',
                });
            }
            playPlayerBulletHitSound(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z, { heavy: true });
            spawnEnemyTramImpactAt(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveEnemyTramBullets.splice(i, 1);
        }
    }
}

function updateEnemyTramImpacts(dt) {
    if (liveEnemyTramImpacts.length === 0) return;
    for (let i = liveEnemyTramImpacts.length - 1; i >= 0; i--) {
        const s = liveEnemyTramImpacts[i];
        s.ttl -= dt;
        if (s.ttl <= 0) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            liveEnemyTramImpacts.splice(i, 1);
            continue;
        }
        s.vy -= 9.8 * dt;
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        const k = Math.max(0, s.ttl / ENEMY_TRAM_IMPACT_LIFETIME_S);
        s.mesh.scale.setScalar(0.60 + k * 0.90);
    }
}

function updateEnemyTramWeapons(pose, local, dt) {
    if (!ambientHostilesFn()) return;
    const target = getPlayerTramTarget(pose, local);
    const playerBox = getPlayerTramBox(pose, local);
    const nowS = performance.now() / 1000;
    for (const mesh of instances.values()) {
        if (!mesh.userData.enemyTram || mesh.visible === false) continue;
        queueEnemyMusicSpeaker(
            mesh.position.x,
            mesh.position.y + 3.3,
            mesh.position.z,
            1.15,
            mesh.userData.enemyMusicTrackIndex,
        );
        const weapon = mesh.userData.enemyTramWeapon;
        if (!weapon) continue;
        updateEnemyTramMuzzleFlash(mesh, dt);
        if (!target) continue;
        updateEnemyTramAim(mesh, target);

        const dx = target.x - mesh.position.x;
        const dy = target.y - (mesh.position.y + 1.7);
        const dz = target.z - mesh.position.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > ENEMY_TRAM_FIRE_RANGE_M || dist < ENEMY_TRAM_MIN_RANGE_M) continue;

        if (!Number.isFinite(weapon.nextShotAt)) {
            weapon.nextShotAt = nowS + Math.random() * 1.8;
            weapon.burstRemaining = 0;
        }
        if (nowS < weapon.nextShotAt) continue;
        if (!enemyTramHasLineOfSight(mesh, target)) {
            weapon.burstRemaining = 0;
            continue;
        }

        if (!weapon.burstRemaining || weapon.burstRemaining <= 0) {
            weapon.burstRemaining = ENEMY_TRAM_BURST_MIN +
                Math.floor(Math.random() * (ENEMY_TRAM_BURST_MAX - ENEMY_TRAM_BURST_MIN + 1));
            cabVoice.playEnemyShootLine?.();
        }

        spawnEnemyTramBullet(mesh, target);
        weapon.burstRemaining -= 1;
        weapon.nextShotAt = weapon.burstRemaining > 0
            ? nowS + ENEMY_TRAM_BURST_CADENCE_S
            : nowS + ENEMY_TRAM_BURST_COOLDOWN_MIN_S +
                Math.random() * (ENEMY_TRAM_BURST_COOLDOWN_MAX_S - ENEMY_TRAM_BURST_COOLDOWN_MIN_S);
    }
    updateEnemyTramBullets(dt, playerBox, target);
    updateEnemyTramImpacts(dt);
}

// Damage-state smoke + occasional fire flare-ups. Live (un-wrecked) trams
// emit smoke once damaged, scaling with how low health is; wrecked trams
// emit constantly and flash fire every few seconds. Matches the same
// mechanic cars.js uses for wreck smoke, but exposed here so the per-frame
// tram loop can drive it without duplicating tram bookkeeping in cars.js.
const TRAM_SMOKE_VISIBLE_RADIUS_M = 280;
const TRAM_SMOKE_VISIBLE_RADIUS_M_2 = TRAM_SMOKE_VISIBLE_RADIUS_M * TRAM_SMOKE_VISIBLE_RADIUS_M;
const TRAM_SMOKE_BASE_INTERVAL_S = 0.8;     // damaged-but-alive tram interval
const TRAM_WRECK_SMOKE_INTERVAL_S = 0.35;   // wrecked tram interval
const TRAM_WRECK_FIRE_INTERVAL_MIN_S = 3.0; // random fire flash on wrecks
const TRAM_WRECK_FIRE_INTERVAL_MAX_S = 6.5;
const TRAM_DAMAGE_SMOKE_THRESHOLD = 0.7;    // start emitting below this ratio

function emitTramDamageSmoke(mesh, dt, camX, camZ) {
    const dx = mesh.position.x - camX;
    const dz = mesh.position.z - camZ;
    if (dx * dx + dz * dz > TRAM_SMOKE_VISIBLE_RADIUS_M_2) return;

    const wrecked = !!mesh.userData.wreckedTram;
    let interval, fireDue = false;
    if (wrecked) {
        interval = TRAM_WRECK_SMOKE_INTERVAL_S;
        // Stagger occasional fire flashes per-tram. Initialised lazily.
        if (mesh.userData.fireFlashAt == null) {
            mesh.userData.fireFlashAt = TRAM_WRECK_FIRE_INTERVAL_MIN_S +
                Math.random() * (TRAM_WRECK_FIRE_INTERVAL_MAX_S - TRAM_WRECK_FIRE_INTERVAL_MIN_S);
            mesh.userData.fireFlashElapsed = 0;
        }
        mesh.userData.fireFlashElapsed += dt;
        if (mesh.userData.fireFlashElapsed >= mesh.userData.fireFlashAt) {
            mesh.userData.fireFlashElapsed = 0;
            mesh.userData.fireFlashAt = TRAM_WRECK_FIRE_INTERVAL_MIN_S +
                Math.random() * (TRAM_WRECK_FIRE_INTERVAL_MAX_S - TRAM_WRECK_FIRE_INTERVAL_MIN_S);
            fireDue = true;
        }
    } else {
        const maxHealth = mesh.userData.tramMaxHealth || TRAM_MAX_HEALTH;
        const ratio = (mesh.userData.tramHealth == null ? maxHealth : mesh.userData.tramHealth) / maxHealth;
        if (ratio >= TRAM_DAMAGE_SMOKE_THRESHOLD) return;
        // 0..1 intensity ramps from threshold down to 0; emission interval
        // halves at full damage (≈ 0.4 s) for a heavier plume.
        const intensity = (TRAM_DAMAGE_SMOKE_THRESHOLD - ratio) / TRAM_DAMAGE_SMOKE_THRESHOLD;
        interval = TRAM_SMOKE_BASE_INTERVAL_S / (1.0 + intensity);
    }

    mesh.userData.smokeAccum = (mesh.userData.smokeAccum || 0) + dt;
    let emitted = false;
    if (mesh.userData.smokeAccum >= interval) {
        mesh.userData.smokeAccum = 0;
        emitted = true;
    }
    if (!emitted && !fireDue) return;

    // Smoke origin: somewhere along the tram body's roof. mesh forward
    // (local +Z) maps to world (-sin h, 0, -cos h) since rotation.y =
    // -heading. Keep it close to centre so the plume reads as one column.
    const headingRad = -mesh.rotation.y;
    const along = (Math.random() - 0.5) * (TRAM_HALF_LENGTH_M * 0.6);
    const sx = mesh.position.x + Math.sin(headingRad) * along;
    const sz = mesh.position.z + Math.cos(headingRad) * along;
    const sy = mesh.position.y + 3.1;
    if (emitted) spawnSmokeAt(sx, sy, sz);
    if (fireDue) spawnFireFlashAt(sx, sy + 0.1, sz);
}

function gtaAmbientTramSupport(pose) {
    // A plan crossing does not connect its vertical levels. Ask for this tram's
    // own rendered trackbed; the old unqualified "highest rail wins" query made
    // Savska trams jump onto the heavy-rail bridge passing above them.
    const structuralY = tramTrackbedSupportYAtLocal(
        pose.x,
        pose.z,
        { osmId: pose.osmId },
    );
    if (Number.isFinite(structuralY)) {
        return { absoluteSceneY: structuralY, terrainRelative: false };
    }
    const roadY = gtaRoadFormation?.sceneYAtLocal?.(
        pose.x,
        pose.z,
        {
            requireSurface: true,
            // This render-hook query must not synchronously finish a streamed
            // road-formation rebuild. The roads layer prepares and atomically
            // publishes the next index; until then the previous complete
            // generation remains valid support for the still-visible road.
            allowStale: true,
        },
    );
    if (Number.isFinite(roadY)) {
        return { absoluteSceneY: roadY, terrainRelative: false };
    }
    if (!terrainReference) return { absoluteSceneY: 0, terrainRelative: false };
    const terrainY = terrainReference.evidenceSceneYAt?.(pose.lon, pose.lat);
    return {
        absoluteSceneY: finiteOrNull(terrainY),
        terrainRelative: true,
    };
}

// Rebuilds one fleet's paths cooperatively when the streamed rail source
// changes, then republishes the fleet around the observer. `fleet` holds the
// build state for either the trams or the trains.
function advanceAmbientFleetPaths(fleet, source, observerLocal) {
    if (source.revision !== fleet.revision
        && (!fleet.build || source.revision !== fleet.build.revision)) {
        fleet.build?.steps?.return?.();
        fleet.build = {
            revision: source.revision,
            steps: buildGtaAmbientTramPathSteps(source.features, {
                toLocal: (lon, lat) => geoToLocal(lon, lat, anchorLon, anchorLat),
                ...fleet.pathOptions(source),
            }),
        };
    }
    if (!fleet.build) return;
    const startedMs = performance.now();
    for (let index = 0; index < GTA_AMBIENT_PATH_BUILD_STEPS_PER_FRAME; index += 1) {
        const result = fleet.build.steps.next();
        if (result.done) {
            if (source.revision === fleet.build.revision) {
                fleet.revision = fleet.build.revision;
                fleet.paths = result.value;
                fleet.provider.replacePaths(fleet.paths, {
                    centerX: Number(observerLocal?.x) || 0,
                    centerZ: Number(observerLocal?.z) || 0,
                    maxTrams: fleet.limit,
                });
            }
            fleet.build = null;
            break;
        }
        if (performance.now() - startedMs >= GTA_AMBIENT_PATH_BUILD_BUDGET_MS) break;
    }
}

const tramFleet = {
    get provider() { return gtaAmbientProvider; },
    get revision() { return gtaAmbientRailRevision; },
    set revision(value) { gtaAmbientRailRevision = value; },
    get paths() { return gtaAmbientPaths; },
    set paths(value) { gtaAmbientPaths = value; },
    get build() { return gtaAmbientPathBuild; },
    set build(value) { gtaAmbientPathBuild = value; },
    limit: GTA_AMBIENT_TRAM_LIMIT,
    trackType: 'tram',
    pathOptions: () => ({}),
};
const trainFleet = {
    get provider() { return gtaAmbientTrainProvider; },
    get revision() { return gtaAmbientTrainRailRevision; },
    set revision(value) { gtaAmbientTrainRailRevision = value; },
    get paths() { return gtaAmbientTrainPaths; },
    set paths(value) { gtaAmbientTrainPaths = value; },
    get build() { return gtaAmbientTrainPathBuild; },
    set build(value) { gtaAmbientTrainPathBuild = value; },
    limit: GTA_AMBIENT_TRAIN_LIMIT,
    trackType: 'rail',
    pathOptions: source => ({
        accept: feature => isAmbientTrainFeature(feature, { solvedOnly: source?.mode === 'solved' }),
        chain: true,
        minLengthM: GTA_AMBIENT_TRAIN_MIN_RUN_M,
    }),
};

function ambientProviderFor(id) {
    return String(id || '').startsWith('gta-train:') ? gtaAmbientTrainProvider : gtaAmbientProvider;
}

if (typeof window !== 'undefined') {
    window.__s3dAmbientRail = () => {
        const source = getActiveRailTrafficSource();
        const railway = feature => String(feature?.properties?.railway_type ?? feature?.properties?.railway ?? feature?.properties?.trackType ?? '');
        return {
            trams: gtaAmbientProvider?.snapshot() || [],
            trains: gtaAmbientTrainProvider?.snapshot() || [],
            trainPaths: gtaAmbientTrainPaths.map(path => ({ id: path.id, lengthM: Math.round(path.lengthM), ways: path.sourceIds?.length || 1 })),
            trainRevision: gtaAmbientTrainRailRevision,
            trainBuilding: !!gtaAmbientTrainPathBuild,
            source: {
                revision: source.revision,
                mode: source.mode,
                features: source.features.length,
                trainCandidates: source.features.filter(feature => isAmbientTrainFeature(feature, { solvedOnly: source.mode === 'solved' })).length,
                heavy: source.features.filter(feature => isAmbientTrainFeature(feature)).length,
                byRailway: Object.fromEntries([...new Set(source.features.map(railway))].map(kind => [kind, source.features.filter(feature => railway(feature) === kind).length])),
                sampleSolved: source.features.filter(feature => feature?.properties?.source === 'reference-project').slice(0, 2).map(feature => ({
                    keys: Object.keys(feature.properties).filter(key => /elevation|source|trackType|railway|driverTrackOnly|railProfile/.test(key)).map(key => `${key}=${String(feature.properties[key]).slice(0, 24)}`),
                    points: feature.geometry?.coordinates?.length, z: feature.geometry?.coordinates?.[0]?.[2],
                })),
            },
        };
    };
}

function gtaAmbientTramPoses(dt, observerLocal) {
    if (!gtaAmbientTramsEnabled || !gtaAmbientProvider) return [];
    const source = getActiveRailTrafficSource();
    const poses = [];
    for (const fleet of [tramFleet, trainFleet]) {
        if (!fleet.provider) continue;
        advanceAmbientFleetPaths(fleet, source, observerLocal);
        for (const pose of fleet.provider.step(dt, observerLocal)) {
            poses.push({
                ...pose,
                ...gtaAmbientTramSupport(pose),
                color: GTA_AMBIENT_TRAM_COLOR,
                lineNumber: null,
                trackType: fleet.trackType,
            });
        }
    }
    return poses;
}

function resetGtaAmbientPathBuild() {
    gtaAmbientPathBuild?.steps?.return?.();
    gtaAmbientPathBuild = null;
    gtaAmbientTrainPathBuild?.steps?.return?.();
    gtaAmbientTrainPathBuild = null;
}

function updateOtherTrams(pose, local, dt) {
    if (!otherTramsGroup) return;
    const scheduledPoses = typeof otherTrainsFn === 'function'
        ? otherTrainsFn() : [];
    const poses = [
        ...(Array.isArray(scheduledPoses) ? scheduledPoses : []),
        ...gtaAmbientTramPoses(dt, local),
    ];
    const enemyIds = buildEnemyTramIdSet(poses);

    const updatePhase = otherTramUpdatePhase;
    let createdThisFrame = false;
    const camX = camera.position.x;
    const camZ = camera.position.z;

    for (const pose of poses) {
        if (destroyedTramIds.has(pose.id)) continue;
        if ((hashEnemyTramId(pose.id) % OTHER_TRAM_UPDATE_PHASES) !== updatePhase) continue;
        const local = geoToLocal(pose.lon, pose.lat, anchorLon, anchorLat);
        const dx = local.x - camX;
        const dz = local.z - camZ;
        const distanceSq = dx * dx + dz * dz;
        const existingMesh = instances.get(pose.id);
        const cullRadiusSq = existingMesh
            ? OTHER_TRAM_RETAIN_RADIUS_M_2
            : OTHER_TRAM_CREATE_RADIUS_M_2;
        if (distanceSq > cullRadiusSq) continue;
        otherTramSeenCycle.add(pose.id);

        const absoluteSceneY = finiteOrNull(pose.absoluteSceneY);
        const terrainRelative = pose.terrainRelative === true || absoluteSceneY === null;
        const groundY = absoluteSceneY !== null
            ? absoluteSceneY
            : terrainReference
                ? finiteOrNull(terrainReference.evidenceSceneYAt?.(pose.lon, pose.lat))
                : 0;
        const terrainPitchDeg = terrainRelative && terrainReference
            ? finiteOrNull(terrainReference.evidenceSlopeAlongHeadingDeg?.(
                pose.lon,
                pose.lat,
                pose.headingDeg,
            ))
            : 0;
        if (groundY === null || terrainPitchDeg === null) {
            if (existingMesh) {
                existingMesh.visible = false;
                existingMesh.userData.terrainReady = false;
                updateTramHealthBarVisibility(existingMesh);
            }
            continue;
        }

        const enemy = enemyIds.has(String(pose.id));
        const rollingStock = selectRollingStock({
            isTrainSession,
            trackType: pose.trackType,
        });
        let mesh = existingMesh;
        if (mesh && (
            !!mesh.userData.enemyTram !== enemy
            || mesh.userData.rollingStock !== rollingStock
        )) {
            disposeGroup(mesh);
            instances.delete(pose.id);
            mesh = null;
        }
        if (!mesh) {
            // Mesh construction is cached/batched but still initializes a
            // complete animated vehicle hierarchy. Admit at most one new tram
            // per render frame; the next update cycle will pick up the rest.
            if (createdThisFrame) continue;
            mesh = rollingStock === ROLLING_STOCK_HZ_7022
                ? createHz7022Mesh()
                : createTramMesh(enemy ? ENEMY_TRAM_COLOR : pose.color, pose.lineNumber, { enemy, enemyMusicTrackCount: getEnemyMusicTrackCount() });
            createdThisFrame = true;
            mesh.userData.tramId = pose.id;
            mesh.userData.rollingStock = rollingStock;
            const savedHealth = tramHealthById.get(pose.id);
            if (savedHealth) {
                mesh.userData.tramMaxHealth = savedHealth.maxHealth;
                mesh.userData.tramHealth = savedHealth.health;
                updateTramHealthBar(mesh);
            }
            otherTramsGroup.add(mesh);
            instances.set(pose.id, mesh);
        }
        // Stash the autopilot trip on the mesh so cars.js can reach
        // back into `trip._physicsWall` and toggle obstacle-stall when
        // a car / wreck blocks this tram's forward cone.
        if (pose.tripRef) mesh.userData.tripRef = pose.tripRef;
        mesh.userData.terrainReady = true;
        mesh.userData.speedMps = Math.max(0, Number(pose.speedMps) || 0);
        if (pose.ownershipState) {
            mesh.userData.ambientOwnershipState = pose.ownershipState;
            mesh.userData.controlledTram = pose.ownershipState === AMBIENT_TRAM_STATES.CONTROLLING;
            setTramDoorsOpen(mesh, Number(pose.doorRatio) || 0);
        }

        const headingRad = pose.headingDeg * Math.PI / 180;
        // pose.y carries the planner track elevation (viaduct/tunnel level)
        mesh.position.set(
            local.x,
            groundY + (absoluteSceneY !== null
                ? 0
                : Number.isFinite(pose.y) ? pose.y : 0),
            local.z,
        );
        // headingDeg: 0=N, 90=E. Scene has -Z=north, so heading maps to -heading radians.
        mesh.rotation.order = 'YXZ';
        mesh.rotation.y = -headingRad;
        mesh.rotation.x = (terrainPitchDeg + (Number.isFinite(pose.pitchDeg) ? pose.pitchDeg : 0)) * Math.PI / 180;

        const hideRadiusM = rollingStock === ROLLING_STOCK_HZ_7022
            ? mesh.userData.collisionHalfLengthM + 2
            : HIDE_RADIUS_M;
        mesh.visible = pose.ownershipState === AMBIENT_TRAM_STATES.CONTROLLING
            ? pose.controlledVisible === true
            : gtaAmbientTramsEnabled
            || (dx * dx + dz * dz) > (hideRadiusM * hideRadiusM);
        updateTramRenderLod(
            mesh,
            distanceSq,
            enemy || pose.ownershipState === AMBIENT_TRAM_STATES.CONTROLLING,
        );
        updateTramHealthBarVisibility(mesh);
    }

    const cycleComplete = updatePhase === OTHER_TRAM_UPDATE_PHASES - 1;
    if (cycleComplete) {
        const toRemove = [];
        for (const [id] of instances) {
            if (!otherTramSeenCycle.has(id)) toRemove.push(id);
        }
        for (const id of toRemove) {
            const record = ambientProviderFor(id)?.get(id);
            if (record && record.state !== AMBIENT_TRAM_STATES.AUTONOMOUS) continue;
            disposeGroup(instances.get(id));
            instances.delete(id);
        }
        otherTramSeenCycle.clear();
    }
    otherTramUpdatePhase = (updatePhase + 1) % OTHER_TRAM_UPDATE_PHASES;
    if (dt && dt > 0) {
        updateEnemyTramWeapons(pose, local, dt);
        // Damage smoke for every live tram whose health has dropped
        // below the threshold, plus continuous smoke for every wreck.
        for (const mesh of instances.values()) {
            if (!mesh) continue;
            const maxHealth = mesh.userData.tramMaxHealth || TRAM_MAX_HEALTH;
            const health = mesh.userData.tramHealth == null ? maxHealth : mesh.userData.tramHealth;
            if (health < maxHealth) {
                emitTramDamageSmoke(mesh, dt, camX, camZ);
            }
        }
        for (const mesh of wreckedTrams) {
            emitTramDamageSmoke(mesh, dt, camX, camZ);
        }
    }
}

// Bullet hit-test: returns the nearest other-tram MESH whose body OBB
// contains the world point, or null. Earlier this used a single 9.5 m
// sphere centred on the tram which made bullets passing several metres
// past the tram still register as hits — a 2.4 m wide tram body was
// catching shots from a 12 m corona around it. We now test against the
// tram's actual oriented bounding box (length × width × height) inflated
// by hitRadius so bullets only register when they actually pass through
// the body. Caller still follows up with a raycast via
// bullet-marks.tryStampHole(getOtherTramsGroup(), ...) to stamp the hole
// at the actual surface impact point.
const TRAM_BODY_HALF_HEIGHT_M = 1.5;     // body centre at mesh.y+1.5, ±1.5 m
export function tryTramHit(worldX, worldY, worldZ, hitRadius) {
    if (!instances || instances.size === 0) return null;
    const halfL = TRAM_HALF_LENGTH_M + hitRadius;
    const halfW = TRAM_HALF_WIDTH_M + hitRadius;
    const halfH = TRAM_BODY_HALF_HEIGHT_M + hitRadius;
    const broad2 = halfL * halfL;        // 2D circumscribed-circle reject
    let best = null;
    let bestD2 = Infinity;
    for (const mesh of instances.values()) {
        if (!mesh.visible) continue;
        const dx = worldX - mesh.position.x;
        const dz = worldZ - mesh.position.z;
        const dy = worldY - (mesh.position.y + TRAM_BODY_HALF_HEIGHT_M);
        if (Math.abs(dy) > halfH) continue;
        const horiz2 = dx * dx + dz * dz;
        if (horiz2 > broad2) continue;
        // Rotate world-relative XZ into mesh-local XZ. Tram has
        // mesh.rotation.y = α (currently set to -headingRad), so the
        // inverse rotation is by -α: lx = dx·cosα − dz·sinα,
        // lz = dx·sinα + dz·cosα.
        const cosA = Math.cos(mesh.rotation.y);
        const sinA = Math.sin(mesh.rotation.y);
        const lx = dx * cosA - dz * sinA;
        const lz = dx * sinA + dz * cosA;
        if (Math.abs(lx) > halfW) continue;
        if (Math.abs(lz) > halfL) continue;
        const d2 = horiz2 + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = mesh; }
    }
    return best;
}

// Test a ray segment (typically one bullet's per-frame step, or a nest
// muzzle → player line) against every other-tram OBB (live + wrecked).
// Returns the closest hit as { mesh, t, x, y, z } where t ∈ [0, 1] along
// the segment, or null. The OBB body extents match the targeting box
// used for the player tram (length × width plus 0.85 m bullet padding,
// height 0.25–4.0 m above the mesh origin) so the test is symmetric for
// any tram. `ignoreMesh` skips a specific tram — pass the firing tram so
// it never blocks its own outgoing shot. The player tram lives outside
// the `instances` map (it's the cab), so it's naturally excluded; the
// player's own OBB is handled separately by segmentHitsPlayerTramBox.
export function segmentBlockedByOtherTram(x0, y0, z0, x1, y1, z1, ignoreMesh = null) {
    if (!instances && wreckedTrams.length === 0) return null;
    const halfW = TRAM_HALF_WIDTH_M + 0.85;
    const halfL = TRAM_HALF_LENGTH_M + 0.85;
    let bestMesh = null;
    let bestT = Infinity;

    const testOne = (mesh) => {
        if (!mesh || mesh === ignoreMesh) return;
        if (mesh.visible === false) return;
        const cx = mesh.position.x;
        const cz = mesh.position.z;
        const cosA = Math.cos(mesh.rotation.y);
        const sinA = Math.sin(mesh.rotation.y);
        // Same convention as tryTramHit: rotate world XZ into mesh-local
        // by -mesh.rotation.y, i.e. lx = dx·cosα − dz·sinα,
        // lz = dx·sinα + dz·cosα.
        const lx0 = (x0 - cx) * cosA - (z0 - cz) * sinA;
        const lz0 = (x0 - cx) * sinA + (z0 - cz) * cosA;
        const lx1 = (x1 - cx) * cosA - (z1 - cz) * sinA;
        const lz1 = (x1 - cx) * sinA + (z1 - cz) * cosA;
        const yMin = mesh.position.y + 0.25;
        const yMax = mesh.position.y + 4.0;
        const hit = { min: 0, max: 1 };
        if (!segmentHitsAxis(-halfW, halfW, lx0, lx1, hit)) return;
        if (!segmentHitsAxis(-halfL, halfL, lz0, lz1, hit)) return;
        if (!segmentHitsAxis(yMin, yMax, y0, y1, hit)) return;
        const tEntry = Math.max(0, hit.min);
        if (tEntry < bestT) {
            bestT = tEntry;
            bestMesh = mesh;
        }
    };

    if (instances) for (const m of instances.values()) testOne(m);
    for (const m of wreckedTrams) testOne(m);

    if (!bestMesh) return null;
    return {
        mesh: bestMesh,
        t: bestT,
        x: x0 + (x1 - x0) * bestT,
        y: y0 + (y1 - y0) * bestT,
        z: z0 + (z1 - z0) * bestT,
    };
}

export function recordTramHit(mesh) {
    if (!mesh || mesh.userData.wreckedTram) return false;
    const wasEnemy = !!mesh.userData.enemyTram;
    const maxHealth = mesh.userData.tramMaxHealth || TRAM_MAX_HEALTH;
    const before = mesh.userData.tramHealth == null ? maxHealth : mesh.userData.tramHealth;
    const after = Math.max(0, before - TRAM_BULLET_DAMAGE);
    mesh.userData.tramMaxHealth = maxHealth;
    mesh.userData.tramHealth = after;
    const id = mesh.userData.tramId;
    if (id != null) tramHealthById.set(id, { health: after, maxHealth });
    if (!wasEnemy) {
        cabVoice.playFriendlyFireLine?.();
    }

    if (after <= 0) {
        if (id != null) {
            tramHealthById.delete(id);
            destroyedTramIds.add(id);
            instances.delete(id);
            ambientProviderFor(id)?.destroy(id);
        }
        wreckTram(mesh);
        if (wasEnemy) {
            cabVoice.playEnemyWreckLine?.();
        }
        return true;
    }
    if (wasEnemy) {
        cabVoice.playEnemyHitLine?.(tramDistanceToCamera(mesh));
    }

    updateTramHealthBar(mesh);
    return false;
}

export function getOtherTramsGroup() {
    return otherTramsGroup;
}

// Generic vehicle-provider facade used by the unified Station3D session. The
// providers own motion/occupancy state (trams and trains each their own, told
// apart by the id prefix); this module continues to own the one exterior
// mesh associated with each stable ambient vehicle id.
export function getGtaAmbientTramProvider() {
    return {
        id: 'ambient-trams',
        findNearest(local) {
            let best = null;
            for (const provider of [gtaAmbientProvider, gtaAmbientTrainProvider]) {
                const candidate = provider?.findNearest(local) || null;
                if (candidate && (!best || candidate.distanceM < best.distanceM)) best = candidate;
            }
            return best;
        },
        findById(id, local) {
            return ambientProviderFor(id)?.findById(id, local) || null;
        },
        requestBoarding(id, local) {
            return ambientProviderFor(id)?.requestBoarding(id, local) || false;
        },
        claim(id, local) {
            const mesh = instances.get(id);
            const provider = ambientProviderFor(id);
            if (!mesh || !provider) return null;
            const record = provider.claim(id, local);
            if (!record) return null;
            mesh.userData.controlledTram = true;
            mesh.userData.ambientOwnershipState = AMBIENT_TRAM_STATES.CONTROLLING;
            return { ...record, mesh };
        },
        sync(id, pose) {
            return ambientProviderFor(id)?.sync(id, pose) || false;
        },
        release(id, pose, policy) {
            const released = ambientProviderFor(id)?.release(id, pose, policy) || false;
            if (released) {
                const mesh = instances.get(id);
                if (mesh) {
                    mesh.userData.controlledTram = false;
                    mesh.userData.ambientOwnershipState = AMBIENT_TRAM_STATES.EXITING;
                    mesh.visible = true;
                }
            }
            return released;
        },
        cancelReservation(id) {
            return ambientProviderFor(id)?.cancelReservation(id) || false;
        },
        get(id) {
            return ambientProviderFor(id)?.get(id) || null;
        },
        getMesh(id) {
            return instances.get(id) || null;
        },
    };
}

// Iterates the live other-tram meshes for cross-module collision checks
// (cars treating trams as obstacles, trams plowing through cars). Each
// mesh has `position` and `rotation.y = -headingRad`, so callers can
// recover heading via `-mesh.rotation.y`.
export function* iterOtherTramMeshes(includeHidden = false) {
    if (!instances) return;
    for (const mesh of instances.values()) {
        if (mesh && (includeHidden || mesh.visible !== false)) yield mesh;
    }
    for (const mesh of wreckedTrams) {
        if (mesh && (includeHidden || mesh.visible !== false)) yield mesh;
    }
}

// Tram body half-extents in mesh-local coords (X = right/left, Z = long
// axis). Exposed so collision callers don't have to hard-code 18×2.4.
export const otherTramsLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        otherTrainsFn: fn,
        onPlayerTramDamage: damageFn,
        isAmbientHostileMode,
        isTrainSession: trainSession,
        sessionCapabilities,
        roadFormation,
        terrain,
    }) {
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        otherTrainsFn = fn || null;
        onPlayerTramDamage = typeof damageFn === 'function' ? damageFn : null;
        ambientHostilesFn = typeof isAmbientHostileMode === 'function' ? isAmbientHostileMode : (() => false);
        isTrainSession = !!trainSession;
        gtaAmbientTramsEnabled = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.AMBIENT_TRAMS,
        );
        gtaAmbientRailRevision = -1;
        gtaAmbientPaths = [];
        resetGtaAmbientPathBuild();
        gtaAmbientProvider = gtaAmbientTramsEnabled
            ? createAmbientTramProvider()
            : null;
        gtaAmbientTrainRailRevision = -1;
        gtaAmbientTrainPaths = [];
        gtaAmbientTrainProvider = gtaAmbientTramsEnabled
            ? createAmbientTramProvider({
                id: 'trains',
                kind: 'train',
                idPrefix: 'gta-train',
                policy: AMBIENT_TRAIN_POLICY,
                stationService: ambientTrainStationServiceForAnchor(lat, lon),
                ...AMBIENT_TRAIN_CRUISE,
            })
            : null;
        gtaRoadFormation = roadFormation || null;
        otherTramsGroup = new THREE.Group();
        otherTramsGroup.name = 'OtherTrams';
        scene.add(otherTramsGroup);
        instances = new Map();
        tramHealthById = new Map();
        destroyedTramIds = new Set();
        wreckedTrams.length = 0;
        otherTramUpdatePhase = 0;
        otherTramSeenCycle.clear();
    },
    onFrame(pose, local, dt) {
        updateOtherTrams(pose, local, dt);
    },
    endSession() {
        for (const mesh of instances.values()) disposeGroup(mesh);
        instances.clear();
        for (const mesh of wreckedTrams) disposeGroup(mesh);
        wreckedTrams.length = 0;
        tramHealthById.clear();
        destroyedTramIds.clear();
        for (const b of liveEnemyTramBullets) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        }
        liveEnemyTramBullets.length = 0;
        for (const s of liveEnemyTramImpacts) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        }
        liveEnemyTramImpacts.length = 0;
        if (enemyTramProjectilesGroup) {
            if (enemyTramProjectilesGroup.parent) enemyTramProjectilesGroup.parent.remove(enemyTramProjectilesGroup);
            enemyTramProjectilesGroup = null;
        }
        if (otherTramsGroup) {
            if (otherTramsGroup.parent) otherTramsGroup.parent.remove(otherTramsGroup);
            otherTramsGroup = null;
        }
        otherTrainsFn = null;
        terrainReference = null;
        onPlayerTramDamage = null;
        ambientHostilesFn = () => false;
        isTrainSession = false;
        gtaAmbientTramsEnabled = false;
        gtaAmbientRailRevision = -1;
        gtaAmbientPaths = [];
        resetGtaAmbientPathBuild();
        gtaAmbientProvider?.dispose();
        gtaAmbientProvider = null;
        gtaAmbientTrainProvider?.dispose();
        gtaAmbientTrainProvider = null;
        gtaAmbientTrainRailRevision = -1;
        gtaAmbientTrainPaths = [];
        gtaRoadFormation = null;
        otherTramUpdatePhase = 0;
        otherTramSeenCycle.clear();
        disposeTramSessionCaches();
    },
};
