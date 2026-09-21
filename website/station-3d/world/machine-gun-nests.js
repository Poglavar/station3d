// Red-faction machine-gun nests for cab game mode. Nests are placed
// deterministically on a sparse subset of streamed building roofs and road
// corners, then shoot at the player tram using the same lightweight projectile
// style as enemy technicals.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { disposeGroup } from '../core/dispose.js';
import { createMachineGunNestModel, disposeSharedAssets, stableHash, seededUnit, getBulletGeo, getBulletMat, getImpactGeo, getImpactMat, getBulletHoleGeo, getBulletHoleMat } from '../models/objects/machine-gun-nest.js';
import { getApiBase } from '../core/api.js';
import { buildingTileSourceForLocation } from '../core/locations.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import {
    DETAILED_BUILDING_STREAM_OPTIONS,
    NEAR_ROAD_STREAM_OPTIONS,
} from '../core/tile-stream.js';
import { scene, camera } from '../scene/setup.js';
import {
    playEnemyShotSound, playBulletWhizForSegment, playPlayerBulletHitSound,
} from '../ui/combat-sfx.js';
import { getBuildingsGroup } from './buildings.js';
import { findImpactPoint, resolveCachedLineOfSight } from './bullet-marks.js';
import { spawnFireFlashAt, spawnSmokeAt } from './cars.js';
import { segmentBlockedByOtherTram } from '../vehicles/tram.js';

// Rooftop nests retired entirely — they read as cheating from a tram
// driver's perspective (you can't shoot back at something perched 20 m
// up). Cap stays at 0 and the spawn loop short-circuits before it even
// looks at building geometry.
const ROOFTOP_SPAWN_DENOM = 28;
const STREET_SPAWN_DENOM = 70;
const MAX_ROOFTOP_NESTS = 0;
const MAX_STREET_NESTS = 3;
const MIN_ROOF_HEIGHT_M = 7.0;
const MIN_ROOF_SPAN_M = 7.0;

const NEST_MAX_HEALTH = 85;
const NEST_DAMAGE = 10;
const NEST_HIT_CENTER_Y = 0.72;
const NEST_HIT_RADIUS_M = 1.45;

const FIRE_RANGE_M = 215;
const FIRE_MIN_RANGE_M = 24;
const BURST_MIN = 4;
const BURST_MAX = 7;
const BURST_CADENCE_S = 0.11;
const BURST_COOLDOWN_MIN_S = 1.4;
const BURST_COOLDOWN_MAX_S = 2.8;
const BULLET_SPEED_MPS = 105;
const BULLET_LIFETIME_S = 2.35;
const BULLET_DAMAGE = 4;
const AIM_SPREAD_BASE_M = 1.2;
const AIM_SPREAD_PER_M = 0.010;
const LOS_CACHE_MAX_AGE_S = 0.16;
const LOS_CACHE_SHOOTER_MOVE_M = 0.05;
const LOS_CACHE_TARGET_MOVE_M = 1.2;
const MUZZLE_FLASH_LIFETIME_S = 0.065;
const IMPACT_SPARKS = 5;
const IMPACT_LIFETIME_S = 0.34;
const IMPACT_SPEED_MPS = 3.2;
const OWN_ROOF_IGNORE_S = 0.10;

const HEALTH_BAR_CANVAS_W = 128;
const HEALTH_BAR_CANVAS_H = 24;
const HEALTH_BAR_WIDTH_M = 2.6;
const HEALTH_BAR_HEIGHT_M = 0.32;
const HEALTH_BAR_VISIBLE_RADIUS_M = 260;

const DRIVABLE_HIGHWAYS = new Set([
    'motorway', 'motorway_link',
    'trunk', 'trunk_link',
    'primary', 'primary_link',
    'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
    'residential', 'unclassified',
]);

let anchorLat = 0;
let anchorLon = 0;
let fetchController = null;
let ambientHostilesFn = () => false;
let onPlayerTramDamage = null;
let sharedTileSession = null;
let terrainReference = null;
let lastTerrainRevision = -1;
let lastRoadFormationRevision = -1;

let nestsGroup = null;
let roofTileSource = null;
let streetTileSource = null;
let roofSubscription = null;
let streetSubscription = null;
const activeNests = new Map();
const spawnedIds = new Set();
const tileNestIds = new Map();
const liveBullets = [];
const liveImpacts = [];

const _muzzleWorld = new THREE.Vector3();
const _bulletDir = new THREE.Vector3();
const _bulletUp = new THREE.Vector3(0, 1, 0);
const _holeRay = new THREE.Raycaster();
const _holeStart = new THREE.Vector3();
const _holeDir = new THREE.Vector3();
const _holePointLocal = new THREE.Vector3();

function ensureGroup() {
    if (!nestsGroup) {
        nestsGroup = new THREE.Group();
        nestsGroup.name = 'MachineGunNests';
        scene.add(nestsGroup);
    }
}

function localFromLonLat(lon, lat) {
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    return {
        x: (lon - anchorLon) * scaleLon,
        z: -(lat - anchorLat) * scaleLat,
    };
}

function drawHealthBar(nest) {
    if (!nest.healthBar) return;
    const ratio = Math.max(0, Math.min(1, nest.health / nest.maxHealth));
    const ctx = nest.healthBar.ctx;
    ctx.clearRect(0, 0, HEALTH_BAR_CANVAS_W, HEALTH_BAR_CANVAS_H);
    ctx.fillStyle = 'rgba(15,23,42,0.86)';
    ctx.fillRect(0, 0, HEALTH_BAR_CANVAS_W, HEALTH_BAR_CANVAS_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, HEALTH_BAR_CANVAS_W - 2, HEALTH_BAR_CANVAS_H - 2);
    ctx.fillStyle = ratio <= 0.25 ? '#ef4444' : ratio <= 0.55 ? '#f59e0b' : '#22c55e';
    ctx.fillRect(4, 4, Math.max(0, (HEALTH_BAR_CANVAS_W - 8) * ratio), HEALTH_BAR_CANVAS_H - 8);
    nest.healthBar.texture.needsUpdate = true;
}

function ensureHealthBar(nest) {
    if (!nest || nest.healthBar) return;
    const canvas = document.createElement('canvas');
    canvas.width = HEALTH_BAR_CANVAS_W;
    canvas.height = HEALTH_BAR_CANVAS_H;
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, 1.92, 0);
    sprite.scale.set(HEALTH_BAR_WIDTH_M, HEALTH_BAR_HEIGHT_M, 1);
    sprite.renderOrder = 22;
    sprite.raycast = () => {};
    nest.group.add(sprite);
    nest.healthBar = {
        sprite,
        material,
        texture,
        canvas,
        ctx: canvas.getContext('2d'),
    };
}

function updateHealthBar(nest) {
    if (!nest || nest.destroyed || nest.health >= nest.maxHealth) {
        disposeHealthBar(nest);
        return;
    }
    ensureHealthBar(nest);
    drawHealthBar(nest);
    updateHealthBarVisibility(nest);
}

function updateHealthBarVisibility(nest) {
    if (!nest || !nest.healthBar || !camera) return;
    const dx = nest.x - camera.position.x;
    const dy = nest.y + 1.0 - camera.position.y;
    const dz = nest.z - camera.position.z;
    nest.healthBar.sprite.visible =
        (dx * dx + dy * dy + dz * dz) <= HEALTH_BAR_VISIBLE_RADIUS_M * HEALTH_BAR_VISIBLE_RADIUS_M;
}

function disposeHealthBar(nest) {
    if (!nest || !nest.healthBar) return;
    const { sprite, material, texture } = nest.healthBar;
    if (sprite && sprite.parent) sprite.parent.remove(sprite);
    if (material) material.dispose();
    if (texture) texture.dispose();
    nest.healthBar = null;
}

function recordTileNest(tileKey, id) {
    if (!tileKey) return;
    let ids = tileNestIds.get(tileKey);
    if (!ids) {
        ids = new Set();
        tileNestIds.set(tileKey, ids);
    }
    ids.add(id);
}

function countNests(kind) {
    let count = 0;
    for (const nest of activeNests.values()) {
        if (nest.kind === kind) count++;
    }
    return count;
}

function streetNestSupportYAt(x, z) {
    return evidencePlacementBaseSceneY(
        terrainReference,
        x,
        z,
        { preferRoadSurface: true },
    );
}

function seatStreetNest(nest) {
    if (!nest || nest.kind !== 'street') return false;
    const supportY = streetNestSupportYAt(nest.x, nest.z);
    if (supportY === null) return false;
    const nextY = supportY + (Number(nest.supportOffsetY) || 0);
    nest.supportY = supportY;
    nest.y = nextY;
    if (nest.group) nest.group.position.y = nextY;
    return true;
}

function reseatStreetNestsForGroundRevision({ force = false } = {}) {
    const terrainRevision = Number(terrainReference?.revision) || 0;
    const roadFormationRevision = Number(terrainReference?.roadFormation?.revision) || 0;
    if (!force
        && terrainRevision === lastTerrainRevision
        && roadFormationRevision === lastRoadFormationRevision) return false;
    lastTerrainRevision = terrainRevision;
    lastRoadFormationRevision = roadFormationRevision;
    for (const nest of activeNests.values()) seatStreetNest(nest);
    return true;
}

function spawnNest({ id, kind, x, y, z, rotationY, tileKey, seed }) {
    if (spawnedIds.has(id)) return null;
    if (kind === 'roof' && countNests('roof') >= MAX_ROOFTOP_NESTS) return null;
    if (kind === 'street' && countNests('street') >= MAX_STREET_NESTS) return null;
    ensureGroup();
    const nest = {
        id,
        kind,
        x,
        y,
        z,
        rotationY,
        tileKey,
        seed,
        maxHealth: NEST_MAX_HEALTH,
        health: NEST_MAX_HEALTH,
        destroyed: false,
        nextShotAt: performance.now() / 1000 + seededUnit(seed, 91) * 2.0,
        burstRemaining: 0,
        losCache: {},
        healthBar: null,
        smokeAccum: 0,
        supportOffsetY: 0,
    };
    const model = createMachineGunNestModel(nest.seed);
    nest.group = model.group;
    nest.turret = model.turret;
    nest.group.position.set(nest.x, nest.y, nest.z);
    nest.group.rotation.y = nest.rotationY;
    nest.group.userData.machineGunNestId = nest.id;
    nestsGroup.add(nest.group);
    activeNests.set(id, nest);
    spawnedIds.add(id);
    recordTileNest(tileKey, id);
    return nest;
}

function roofSampleForFeature(feature) {
    const objectId = feature.properties && feature.properties.object_id;
    const geom = feature.geometry;
    if (!geom || geom.type !== 'MultiPolygon') return null;
    const zMin = (feature.properties && feature.properties.z_min) || 0;
    const verts = [];
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;

    for (const polygonCoords of geom.coordinates) {
        const ring = polygonCoords[0];
        if (!ring || ring.length < 4) continue;
        const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] &&
            ring[0][1] === ring[ring.length - 1][1]
            ? ring.slice(0, -1)
            : ring;
        if (pts.length < 3) continue;
        const local = pts.map(([lon, lat, z]) => [
            (lon - anchorLon) * scaleLon,
            (z != null ? z : zMin) - zMin,
            -(lat - anchorLat) * scaleLat,
        ]);
        const v0 = local[0];
        for (let i = 1; i < local.length - 1; i++) {
            const v1 = local[i], v2 = local[i + 1];
            const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
            const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
            const cnx = e1y * e2z - e1z * e2y;
            const cny = e1z * e2x - e1x * e2z;
            const cnz = e1x * e2y - e1y * e2x;
            const cnLen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
            if (cnLen > 1e-6 && Math.abs(cny) / cnLen > 0.5) {
                verts.push(v0, v1, v2);
            }
        }
    }
    if (verts.length < 3) return null;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let sumX = 0, sumZ = 0, maxY = 0;
    for (const v of verts) {
        minX = Math.min(minX, v[0]);
        maxX = Math.max(maxX, v[0]);
        minZ = Math.min(minZ, v[2]);
        maxZ = Math.max(maxZ, v[2]);
        maxY = Math.max(maxY, v[1]);
        sumX += v[0];
        sumZ += v[2];
    }
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    if (maxY < MIN_ROOF_HEIGHT_M || Math.min(spanX, spanZ) < MIN_ROOF_SPAN_M) return null;

    return {
        objectId,
        x: sumX / verts.length,
        z: sumZ / verts.length,
        y: maxY + 0.10,
        spanX,
        spanZ,
    };
}

function handleRoofFeatures(features, tileKey) {
    // Hard kill-switch: with MAX_ROOFTOP_NESTS = 0 the rooftop spawn is
    // disabled entirely. Skip the feature loop and the roof-sampling
    // arithmetic instead of running it just to discard everything.
    if (MAX_ROOFTOP_NESTS <= 0) return;
    for (const feature of features || []) {
        if (countNests('roof') >= MAX_ROOFTOP_NESTS) return;
        const sample = roofSampleForFeature(feature);
        if (!sample || sample.objectId == null) continue;
        const id = `roof:${sample.objectId}`;
        if (spawnedIds.has(id)) continue;
        const seed = stableHash(id);
        if (seed % ROOFTOP_SPAWN_DENOM !== 0) continue;
        const maxJitter = Math.max(0.5, Math.min(sample.spanX, sample.spanZ) * 0.18);
        const jx = (seededUnit(seed, 11) - 0.5) * maxJitter;
        const jz = (seededUnit(seed, 12) - 0.5) * maxJitter;
        spawnNest({
            id,
            kind: 'roof',
            x: sample.x + jx,
            y: sample.y,
            z: sample.z + jz,
            rotationY: seededUnit(seed, 13) * Math.PI * 2,
            tileKey,
            seed,
        });
    }
}

function roadNodeKey(x, z) {
    return `${Math.round(x / 3)},${Math.round(z / 3)}`;
}

function pushNode(map, x, z, vx, vz) {
    const key = roadNodeKey(x, z);
    let node = map.get(key);
    if (!node) {
        node = { x: 0, z: 0, n: 0, vectors: [] };
        map.set(key, node);
    }
    node.x += x;
    node.z += z;
    node.n += 1;
    const len = Math.sqrt(vx * vx + vz * vz);
    if (len > 0.01) node.vectors.push({ x: vx / len, z: vz / len });
}

function roadCornerScore(node) {
    const vectors = node.vectors || [];
    if (vectors.length >= 3) return 2.0;
    if (vectors.length < 2) return 0;
    let sharpest = 0;
    for (let i = 0; i < vectors.length; i++) {
        for (let j = i + 1; j < vectors.length; j++) {
            const dot = Math.max(-1, Math.min(1, vectors[i].x * vectors[j].x + vectors[i].z * vectors[j].z));
            const angle = Math.acos(dot);
            const corner = Math.min(angle, Math.PI - angle);
            sharpest = Math.max(sharpest, corner);
        }
    }
    return sharpest > 0.55 ? sharpest : 0;
}

function handleStreetFeatures(features, tileKey) {
    if (countNests('street') >= MAX_STREET_NESTS) return;
    const nodes = new Map();
    for (const feature of features || []) {
        const props = feature.properties || {};
        const geom = feature.geometry;
        if (!geom || geom.type !== 'LineString') continue;
        if (!DRIVABLE_HIGHWAYS.has(props.highway || 'unclassified')) continue;
        const coords = geom.coordinates || [];
        if (coords.length < 2) continue;
        const pts = coords.map(([lon, lat]) => localFromLonLat(lon, lat));
        for (let i = 0; i < pts.length; i++) {
            if (i > 0) {
                pushNode(nodes, pts[i].x, pts[i].z, pts[i - 1].x - pts[i].x, pts[i - 1].z - pts[i].z);
            }
            if (i < pts.length - 1) {
                pushNode(nodes, pts[i].x, pts[i].z, pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
            }
        }
    }

    for (const [key, node] of nodes) {
        if (countNests('street') >= MAX_STREET_NESTS) return;
        const score = roadCornerScore(node);
        if (score <= 0) continue;
        const id = `street:${key}`;
        if (spawnedIds.has(id)) continue;
        const seed = stableHash(id);
        if (seed % STREET_SPAWN_DENOM !== 0) continue;
        const x = node.x / node.n;
        const z = node.z / node.n;
        const a = seededUnit(seed, 21) * Math.PI * 2;
        const offset = 3.1 + seededUnit(seed, 22) * 2.0;
        const nestX = x + Math.cos(a) * offset;
        const nestZ = z + Math.sin(a) * offset;
        const supportY = streetNestSupportYAt(nestX, nestZ);
        if (supportY === null) continue;
        spawnNest({
            id,
            kind: 'street',
            x: nestX,
            y: supportY,
            z: nestZ,
            rotationY: seededUnit(seed, 23) * Math.PI * 2,
            tileKey,
            seed,
        });
    }
}

function removeNest(id) {
    const nest = activeNests.get(id);
    if (!nest) return;
    disposeHealthBar(nest);
    if (nest.group) {
        if (nest.group.parent) nest.group.parent.remove(nest.group);
        disposeGroup(nest.group);
    }
    activeNests.delete(id);
}

function removeTile(tileKey) {
    const ids = tileNestIds.get(tileKey);
    if (!ids) return;
    for (const id of ids) {
        removeNest(id);
        spawnedIds.delete(id);
    }
    tileNestIds.delete(tileKey);
}

function clearNests({ forgetSpawned = false } = {}) {
    for (const id of Array.from(activeNests.keys())) {
        removeNest(id);
    }
    activeNests.clear();
    tileNestIds.clear();
    if (forgetSpawned) spawnedIds.clear();
}

function getPlayerTarget(pose, local) {
    if (!pose || !local) {
        if (!camera) return null;
        return {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z,
            box: null,
        };
    }
    const heading = (Number(pose.headingDeg) || 0) * Math.PI / 180;
    return {
        x: local.x,
        y: 1.75,
        z: local.z,
        box: {
            x: local.x,
            z: local.z,
            sin: Math.sin(heading),
            cos: Math.cos(heading),
            halfL: 9.0,
            halfW: 1.2,
        },
    };
}

function updateTurretAim(nest, target) {
    const turret = nest && nest.turret;
    if (!turret || !target) return;
    const dx = target.x - nest.x;
    const dz = target.z - nest.z;
    const worldYaw = Math.atan2(dx, dz);
    turret.yawGroup.rotation.y = worldYaw - nest.group.rotation.y;
}

function updateMuzzleFlash(nest, dt) {
    const turret = nest && nest.turret;
    if (!turret || !turret.flash) return;
    turret.flashTtl = Math.max(0, (turret.flashTtl || 0) - dt);
    if (turret.flashTtl <= 0) {
        turret.flash.visible = false;
        return;
    }
    const k = turret.flashTtl / MUZZLE_FLASH_LIFETIME_S;
    turret.flash.visible = true;
    turret.flash.scale.setScalar(0.45 + k * 1.15);
}

function ensureEnemyProjectilesGroup() {
    ensureGroup();
}

function spawnNestBullet(nest, target) {
    if (!nest || !target || !nest.turret || !nest.turret.muzzle) return;
    ensureEnemyProjectilesGroup();
    nest.turret.muzzle.getWorldPosition(_muzzleWorld);
    const dx = target.x - _muzzleWorld.x;
    const dy = target.y - _muzzleWorld.y;
    const dz = target.z - _muzzleWorld.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const spread = AIM_SPREAD_BASE_M + dist * AIM_SPREAD_PER_M;
    _bulletDir.set(
        target.x + (seededUnit(nest.seed, Math.floor(performance.now())) - 0.5) * spread - _muzzleWorld.x,
        target.y + (Math.random() - 0.5) * spread * 0.45 - _muzzleWorld.y,
        target.z + (Math.random() - 0.5) * spread - _muzzleWorld.z,
    ).normalize();

    const mesh = new THREE.Mesh(getBulletGeo(), getBulletMat());
    mesh.position.copy(_muzzleWorld);
    mesh.quaternion.setFromUnitVectors(_bulletUp, _bulletDir);
    nestsGroup.add(mesh);
    liveBullets.push({
        mesh,
        prevX: _muzzleWorld.x,
        prevY: _muzzleWorld.y,
        prevZ: _muzzleWorld.z,
        vx: _bulletDir.x * BULLET_SPEED_MPS,
        vy: _bulletDir.y * BULLET_SPEED_MPS,
        vz: _bulletDir.z * BULLET_SPEED_MPS,
        ttl: BULLET_LIFETIME_S,
        age: 0,
        owner: nest,
    });

    playEnemyShotSound(_muzzleWorld.x, _muzzleWorld.y, _muzzleWorld.z);
    if (nest.turret.flash) {
        nest.turret.flash.visible = true;
        nest.turret.flash.rotation.set(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
        );
        nest.turret.flashTtl = MUZZLE_FLASH_LIFETIME_S;
    }
}

function nestHasLineOfSight(nest, target, nowS) {
    if (!nest || !target || !nest.turret || !nest.turret.muzzle) return false;
    nest.turret.muzzle.getWorldPosition(_muzzleWorld);
    nest.losCache = nest.losCache || {};
    const buildingsClear = resolveCachedLineOfSight(
        getBuildingsGroup(),
        nest.losCache,
        nowS,
        _muzzleWorld.x, _muzzleWorld.y, _muzzleWorld.z,
        target.x, target.y, target.z,
        {
            targetPad: 0.4,
            cacheMaxAgeS: LOS_CACHE_MAX_AGE_S,
            cacheStartMoveM: LOS_CACHE_SHOOTER_MOVE_M,
            cacheEndMoveM: LOS_CACHE_TARGET_MOVE_M,
        },
    );
    if (!buildingsClear) return false;
    // Trams move continuously, so this can't share the building cache.
    // Cheap: one OBB slab pass per active tram, only runs when buildings
    // are already clear. The target tram (player) is naturally excluded
    // — it lives in the cab, not in the other-tram registry.
    return !segmentBlockedByOtherTram(
        _muzzleWorld.x, _muzzleWorld.y, _muzzleWorld.z,
        target.x, target.y, target.z,
    );
}

function segmentHitsAxis(min, max, p0, p1, hit) {
    const d = p1 - p0;
    if (Math.abs(d) < 0.00001) return p0 >= min && p0 <= max;
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

function segmentHitsTramBox(bullet, box) {
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

function segmentHitsSphere(bullet, cx, cy, cz, radius) {
    const sx = bullet.mesh.position.x - bullet.prevX;
    const sy = bullet.mesh.position.y - bullet.prevY;
    const sz = bullet.mesh.position.z - bullet.prevZ;
    const len2 = sx * sx + sy * sy + sz * sz;
    const t = len2 > 0
        ? Math.max(0, Math.min(1, ((cx - bullet.prevX) * sx + (cy - bullet.prevY) * sy + (cz - bullet.prevZ) * sz) / len2))
        : 0;
    const px = bullet.prevX + sx * t;
    const py = bullet.prevY + sy * t;
    const pz = bullet.prevZ + sz * t;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    return (dx * dx + dy * dy + dz * dz) <= radius * radius;
}

function bulletHitsPlayer(bullet, target) {
    if (target && target.box) return segmentHitsTramBox(bullet, target.box);
    if (!camera) return false;
    return segmentHitsSphere(bullet, camera.position.x, camera.position.y, camera.position.z, 2.5);
}

function spawnImpactAt(x, y, z) {
    ensureGroup();
    for (let i = 0; i < IMPACT_SPARKS; i++) {
        const mesh = new THREE.Mesh(getImpactGeo(), getImpactMat());
        mesh.position.set(x, y, z);
        nestsGroup.add(mesh);
        const theta = Math.random() * Math.PI * 2;
        const speed = IMPACT_SPEED_MPS * (0.45 + Math.random());
        liveImpacts.push({
            mesh,
            vx: Math.cos(theta) * speed,
            vy: 0.8 + Math.random() * 2.2,
            vz: Math.sin(theta) * speed,
            ttl: IMPACT_LIFETIME_S,
        });
    }
}

function updateNestBullets(dt, target) {
    for (let i = liveBullets.length - 1; i >= 0; i--) {
        const b = liveBullets[i];
        b.ttl -= dt;
        b.age += dt;
        if (b.ttl <= 0) {
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
        if (!b.whizPlayed) {
            b.whizPlayed = playBulletWhizForSegment(
                b.prevX, b.prevY, b.prevZ,
                b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
            );
        }
        if (b.age > OWN_ROOF_IGNORE_S) {
            const buildingHitPt = findImpactPoint(getBuildingsGroup(),
                b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
                b.vx, b.vy, b.vz);
            if (buildingHitPt) {
                spawnImpactAt(buildingHitPt.x, buildingHitPt.y, buildingHitPt.z);
                if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
                liveBullets.splice(i, 1);
                continue;
            }
        }
        // Other trams are solid cover. Test before the player check so a
        // tram between the nest and the player tram absorbs the round.
        const tramBlock = segmentBlockedByOtherTram(
            b.prevX, b.prevY, b.prevZ,
            b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
        );
        if (tramBlock) {
            spawnImpactAt(tramBlock.x, tramBlock.y, tramBlock.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
            continue;
        }
        if (bulletHitsPlayer(b, target)) {
            if (typeof onPlayerTramDamage === 'function') {
                onPlayerTramDamage(BULLET_DAMAGE, {
                    source: 'enemy-machine-gun-nest',
                    vehicleType: b.owner && b.owner.kind === 'roof' ? 'rooftop-nest' : 'street-nest',
                });
            }
            playPlayerBulletHitSound(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            spawnImpactAt(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z);
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
            liveBullets.splice(i, 1);
        }
    }
}

function updateImpacts(dt) {
    for (let i = liveImpacts.length - 1; i >= 0; i--) {
        const s = liveImpacts[i];
        s.ttl -= dt;
        if (s.ttl <= 0) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
            liveImpacts.splice(i, 1);
            continue;
        }
        s.vy -= 9.8 * dt;
        s.mesh.position.x += s.vx * dt;
        s.mesh.position.y += s.vy * dt;
        s.mesh.position.z += s.vz * dt;
        const k = Math.max(0, s.ttl / IMPACT_LIFETIME_S);
        s.mesh.scale.setScalar(0.55 + k * 0.85);
    }
}

function maybeEmitDestroyedSmoke(nest, dt, local) {
    if (!nest.destroyed || !local) return;
    const dx = nest.x - local.x;
    const dz = nest.z - local.z;
    if (dx * dx + dz * dz > 300 * 300) return;
    nest.smokeAccum = (nest.smokeAccum || 0) + dt;
    if (nest.smokeAccum < 0.55) return;
    nest.smokeAccum = 0;
    spawnSmokeAt(nest.x, nest.y + 0.65, nest.z);
}

function updateNests(dt, target, local) {
    const nowS = performance.now() / 1000;
    for (const nest of activeNests.values()) {
        updateHealthBarVisibility(nest);
        updateMuzzleFlash(nest, dt);
        if (nest.destroyed) {
            maybeEmitDestroyedSmoke(nest, dt, local);
            continue;
        }
        if (!target) continue;
        updateTurretAim(nest, target);
        const dx = target.x - nest.x;
        const dy = target.y - (nest.y + 0.9);
        const dz = target.z - nest.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > FIRE_RANGE_M || dist < FIRE_MIN_RANGE_M) continue;
        if (nowS < nest.nextShotAt) continue;
        if (!nestHasLineOfSight(nest, target, nowS)) {
            nest.burstRemaining = 0;
            continue;
        }
        if (!nest.burstRemaining || nest.burstRemaining <= 0) {
            nest.burstRemaining = BURST_MIN + Math.floor(Math.random() * (BURST_MAX - BURST_MIN + 1));
        }
        spawnNestBullet(nest, target);
        nest.burstRemaining -= 1;
        nest.nextShotAt = nest.burstRemaining > 0
            ? nowS + BURST_CADENCE_S
            : nowS + BURST_COOLDOWN_MIN_S + Math.random() * (BURST_COOLDOWN_MAX_S - BURST_COOLDOWN_MIN_S);
    }
}

function createStreams() {
    if (!sharedTileSession || !fetchController) return;
    if (!roofTileSource) {
        const buildingSource = buildingTileSourceForLocation();
        roofTileSource = sharedTileSession.getSource({
            key: buildingSource.key,
            label: 'machine-gun-roofs',
            url: (bb) => `${getApiBase()}/${buildingSource.endpoint}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}${buildingSource.querySuffix}`,
            ...DETAILED_BUILDING_STREAM_OPTIONS,
        });
        roofSubscription = roofTileSource.subscribe({
            onFetch: handleRoofFeatures,
            onEvict: removeTile,
        });
    }
    if (!streetTileSource) {
        streetTileSource = sharedTileSession.getSource({
            // Combat candidates only need the moving near ring. Do not inherit
            // the civil road layer's long speculative formation corridor.
            key: 'roads:combat-streets',
            label: 'machine-gun-streets',
            url: (bb) => `${getApiBase()}/roads?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        streetSubscription = streetTileSource.subscribe({
            deliveryLabel: 'machine-gun-nests:road-graph',
            onFetch: handleStreetFeatures,
            onEvict: removeTile,
        });
    }
}

// Drops the streams and everything they built. Called when the ambient-hostile
// scope closes — an authored campaign encounter starting, or the player
// stowing the gun — so free-roam emplacements do not linger as dead geometry
// in a scene that is no longer allowed to have them.
function releaseStreams() {
    if (!roofTileSource && !streetTileSource && activeNests.size === 0) return;
    if (roofSubscription) roofSubscription();
    if (streetSubscription) streetSubscription();
    roofSubscription = null;
    streetSubscription = null;
    roofTileSource = null;
    streetTileSource = null;
    clearNests({ forgetSpawned: true });
}

export function tryMachineGunNestHit(worldX, worldY, worldZ, hitRadius = NEST_HIT_RADIUS_M) {
    const r2 = hitRadius * hitRadius;
    let best = null;
    let bestD2 = r2;
    for (const nest of activeNests.values()) {
        const dx = nest.x - worldX;
        const dy = (nest.y + NEST_HIT_CENTER_Y) - worldY;
        const dz = nest.z - worldZ;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = nest;
        }
    }
    return best;
}

export function addMachineGunNestBulletHole(nest, worldX, worldY, worldZ, vx, vy, vz) {
    if (!nest || !nest.group) return;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed < 1e-3) return;
    const ux = vx / speed, uy = vy / speed, uz = vz / speed;
    _holeStart.set(worldX - ux * 5, worldY - uy * 5, worldZ - uz * 5);
    _holeDir.set(ux, uy, uz);
    _holeRay.set(_holeStart, _holeDir);
    _holeRay.far = 12;
    const hits = _holeRay.intersectObject(nest.group, true).filter(hit => hit.face);
    if (hits.length === 0) return;
    const hit = hits[0];
    const parentMesh = hit.object;
    parentMesh.updateMatrixWorld();
    _holePointLocal.copy(hit.point);
    parentMesh.worldToLocal(_holePointLocal);

    const hole = new THREE.Mesh(getBulletHoleGeo(), getBulletHoleMat());
    hole.position.copy(_holePointLocal);
    hole.lookAt(
        _holePointLocal.x + hit.face.normal.x,
        _holePointLocal.y + hit.face.normal.y,
        _holePointLocal.z + hit.face.normal.z,
    );
    parentMesh.add(hole);
}

export function recordMachineGunNestHit(nest, damage = NEST_DAMAGE) {
    if (!nest || nest.destroyed) return false;
    const hitDamage = Number.isFinite(damage) && damage > 0 ? damage : NEST_DAMAGE;
    nest.health = Math.max(0, nest.health - hitDamage);
    updateHealthBar(nest);
    if (nest.health > 0) return false;

    nest.destroyed = true;
    nest.burstRemaining = 0;
    nest.nextShotAt = Infinity;
    disposeHealthBar(nest);
    if (nest.turret && nest.turret.flash) {
        nest.turret.flash.visible = false;
        nest.turret.flashTtl = 0;
    }
    nest.group.rotation.z = nest.kind === 'roof' ? 0.10 : -0.20;
    nest.supportOffsetY = -0.04;
    if (nest.kind === 'street') seatStreetNest(nest);
    else {
        nest.y -= 0.04;
        nest.group.position.y = nest.y;
    }
    spawnFireFlashAt(nest.x, nest.y + 0.66, nest.z);
    spawnSmokeAt(nest.x + 0.25, nest.y + 0.75, nest.z - 0.15);
    return true;
}

export const machineGunNestsLayer = {
    // Nests are free-roam furniture, so they follow the ambient-hostile scope
    // rather than plain game mode: an authored campaign encounter arms the
    // player without also populating the map with hostile emplacements.
    beginSession({ anchorLat: lat, anchorLon: lon, terrain, fetchController: controller, onPlayerTramDamage: damageFn, isAmbientHostileMode, sharedTileSession: tileSession }) {
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        lastTerrainRevision = -1;
        lastRoadFormationRevision = -1;
        fetchController = controller || null;
        sharedTileSession = tileSession || null;
        onPlayerTramDamage = typeof damageFn === 'function' ? damageFn : null;
        ambientHostilesFn = typeof isAmbientHostileMode === 'function' ? isAmbientHostileMode : (() => false);
        clearNests({ forgetSpawned: true });
        // Streams are opened by the first frame that is actually allowed to
        // have nests. Subscribing here instead built emplacements into every
        // model session whatever the mode — 126 nest meshes were counted in a
        // campaign scene with no encounter running. They never fired, because
        // firing sits behind the gate below, but they were streamed, built and
        // drawn for nothing.
    },
    onFrame(pose, local, dt) {
        if (!ambientHostilesFn || !ambientHostilesFn()) {
            releaseStreams();
            return;
        }
        createStreams();
        ensureGroup();
        // The DGU detail window and the streamed road formation can both
        // refine after a nest is created. Re-seat the bounded street set on
        // those revisions, including stationary/zero-dt frames, so no old
        // session datum can leave a nest hovering tens of metres in the air.
        reseatStreetNestsForGroundRevision();
        if (roofTileSource) roofTileSource.ensureAround(local.x, local.z);
        if (streetTileSource) streetTileSource.ensureAround(local.x, local.z);
        if (!dt || dt <= 0) return;
        const target = getPlayerTarget(pose, local);
        updateNests(dt, target, local);
        updateNestBullets(dt, target);
        updateImpacts(dt);
    },
    endSession() {
        if (roofSubscription) roofSubscription();
        if (streetSubscription) streetSubscription();
        roofSubscription = null;
        streetSubscription = null;
        roofTileSource = null;
        streetTileSource = null;
        for (const b of liveBullets) {
            if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        }
        liveBullets.length = 0;
        for (const s of liveImpacts) {
            if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        }
        liveImpacts.length = 0;
        clearNests({ forgetSpawned: true });
        if (nestsGroup) {
            if (nestsGroup.parent) nestsGroup.parent.remove(nestsGroup);
            disposeGroup(nestsGroup);
            nestsGroup = null;
        }
        disposeSharedAssets();
        fetchController = null;
        sharedTileSession = null;
        terrainReference = null;
        lastTerrainRevision = -1;
        lastRoadFormationRevision = -1;
        ambientHostilesFn = () => false;
        onPlayerTramDamage = null;
    },
};
