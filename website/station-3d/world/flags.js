// Decorative blue/red wartime flags for cab game mode. Rebuilt around nearby
// stops as the tram moves, then animated per-frame with a cheap procedural
// cloth ripple instead of full physics.

import * as THREE from 'three';
import { geoToLocal, haversineMeters } from '../core/math.js';
import { disposeGroup } from '../core/dispose.js';
import { evidencePlacementBaseSceneY } from '../core/terrain-placement.js';
import { scene } from '../scene/setup.js';

const FLAG_REBUILD_M = 450;
const FLAG_BUILD_RADIUS_M = 2200;
const FLAG_MIN_SPACING_M = 120;
const MAX_FLAGS = 12;

const FLAG_WIDTH_M = 2.5;
const FLAG_HEIGHT_M = 1.45;
const FLAG_POLE_HEIGHT_M = 5.8;
const FLAG_POLE_RADIUS_M = 0.065;
const FLAG_SEGMENTS_X = 12;
const FLAG_SEGMENTS_Y = 6;
const FLAG_ATTACH_X_M = 0.04;
const FLAG_ATTACH_Y_M = FLAG_POLE_HEIGHT_M - 1.0;

const PLATFORM_SIDE_OFFSET_M = 4.3;
const PLATFORM_LONG_OFFSET_M = 6.0;
const WIND_YAW_RAD = -0.55;

let anchorLat = 0;
let anchorLon = 0;
let stops = [];
let otherTracks = [];
let ambientHostilesFn = null;
let terrainReference = null;
let terrainUnsubscribe = null;
let terrainRefreshPending = false;

let group = null;
let liveFlags = [];
let lastBuildLat = null;
let lastBuildLon = null;

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
    const x = Math.sin((seed + 1) * (salt + 19) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

function flagStopKey(stop) {
    const lng = stop.lng ?? stop.lon;
    const id = stop.stopId || stop.id || '';
    const lat = Number.isFinite(stop.lat) ? stop.lat.toFixed(6) : '';
    const lon = Number.isFinite(lng) ? lng.toFixed(6) : '';
    return `${id}|${stop.name || ''}|${lat}|${lon}`;
}

function buildTrackSegments() {
    const segs = [];
    for (const feature of otherTracks || []) {
        const coords = feature.geometry && feature.geometry.coordinates;
        if (!coords || feature.geometry.type !== 'LineString') continue;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = geoToLocal(coords[i][0], coords[i][1], anchorLon, anchorLat);
            const b = geoToLocal(coords[i + 1][0], coords[i + 1][1], anchorLon, anchorLat);
            segs.push({
                mx: (a.x + b.x) * 0.5,
                mz: (a.z + b.z) * 0.5,
                dx: b.x - a.x,
                dz: b.z - a.z,
            });
        }
    }
    return segs;
}

function nearestTrackYaw(local, segs) {
    let angleY = 0;
    let bestD2 = Infinity;
    for (const seg of segs) {
        const d2 = (local.x - seg.mx) ** 2 + (local.z - seg.mz) ** 2;
        if (d2 < bestD2) {
            bestD2 = d2;
            angleY = Math.atan2(seg.dx, seg.dz);
        }
    }
    return angleY;
}

function buildFlagTexture(faction) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');

    if (faction === 'red') {
        ctx.fillStyle = '#9f1d22';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f0c419';
        ctx.beginPath();
        const cx = 86;
        const cy = 80;
        const outer = 30;
        const inner = 13;
        for (let i = 0; i < 10; i++) {
            const angle = -Math.PI / 2 + i * Math.PI / 5;
            const r = i % 2 === 0 ? outer : inner;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.fillStyle = '#1d4ed8';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 52, canvas.width, 56);
        ctx.fillStyle = '#1d4ed8';
        ctx.beginPath();
        ctx.arc(78, 80, 24, 0, Math.PI * 2);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function createFlagCloth(material, seed) {
    const geometry = new THREE.PlaneGeometry(
        FLAG_WIDTH_M,
        FLAG_HEIGHT_M,
        FLAG_SEGMENTS_X,
        FLAG_SEGMENTS_Y,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(FLAG_ATTACH_X_M + FLAG_WIDTH_M * 0.5, FLAG_ATTACH_Y_M, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const base = Float32Array.from(geometry.getAttribute('position').array);
    return {
        mesh,
        geometry,
        positionAttr: geometry.getAttribute('position'),
        base,
        phase: seededUnit(seed, 1) * Math.PI * 2,
        speed: 0.85 + seededUnit(seed, 2) * 0.45,
        amp: 0.85 + seededUnit(seed, 3) * 0.50,
        gustPhase: seededUnit(seed, 4) * Math.PI * 2,
    };
}

function createFlagInstance(x, groundY, z, faction, seed, assets) {
    const holder = new THREE.Group();
    holder.position.set(x, groundY + 0.02, z);
    holder.rotation.y = WIND_YAW_RAD;

    const pole = new THREE.Mesh(assets.poleGeometry, assets.poleMaterial);
    pole.position.set(0, FLAG_POLE_HEIGHT_M * 0.5, 0);
    pole.castShadow = true;
    pole.receiveShadow = true;
    holder.add(pole);

    const finial = new THREE.Mesh(assets.finialGeometry, assets.finialMaterial);
    finial.position.set(0, FLAG_POLE_HEIGHT_M + 0.09, 0);
    finial.castShadow = true;
    holder.add(finial);

    const cloth = createFlagCloth(assets.clothMaterials[faction], seed);
    holder.add(cloth.mesh);

    return {
        group: holder,
        ...cloth,
    };
}

function chooseFlagStops(centerLat, centerLon) {
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const trackSegs = buildTrackSegments();
    const r2 = FLAG_BUILD_RADIUS_M * FLAG_BUILD_RADIUS_M;

    const candidates = [];
    for (const stop of stops || []) {
        const lng = stop.lng ?? stop.lon;
        if (!Number.isFinite(stop.lat) || !Number.isFinite(lng)) continue;
        const local = geoToLocal(lng, stop.lat, anchorLon, anchorLat);
        const dx = local.x - centerLocal.x;
        const dz = local.z - centerLocal.z;
        if (dx * dx + dz * dz > r2) continue;
        const key = flagStopKey(stop);
        const seed = stableHash(key);
        const trackYaw = nearestTrackYaw(local, trackSegs);
        const side = seed % 2 === 0 ? -1 : 1;
        const localX = side * PLATFORM_SIDE_OFFSET_M;
        const localZ = (seededUnit(seed, 7) - 0.5) * PLATFORM_LONG_OFFSET_M * 2;
        const cosA = Math.cos(trackYaw);
        const sinA = Math.sin(trackYaw);
        candidates.push({
            seed,
            x: local.x + localX * cosA + localZ * sinA,
            z: local.z - localX * sinA + localZ * cosA,
            faction: seed % 3 === 0 ? 'red' : 'blue',
        });
    }

    candidates.sort((a, b) => a.seed - b.seed);

    const picked = [];
    const minSpacing2 = FLAG_MIN_SPACING_M * FLAG_MIN_SPACING_M;
    for (const candidate of candidates) {
        let tooClose = false;
        for (const pickedFlag of picked) {
            const dx = pickedFlag.x - candidate.x;
            const dz = pickedFlag.z - candidate.z;
            if (dx * dx + dz * dz < minSpacing2) {
                tooClose = true;
                break;
            }
        }
        if (tooClose) continue;
        picked.push(candidate);
        if (picked.length >= MAX_FLAGS) break;
    }
    return picked;
}

function build(centerLat, centerLon) {
    const selected = chooseFlagStops(centerLat, centerLon);
    const builtFlags = [];
    if (selected.length === 0) {
        return { group: new THREE.Group(), flags: builtFlags };
    }

    const seated = [];
    for (const flag of selected) {
        const groundY = evidencePlacementBaseSceneY(
            terrainReference,
            flag.x,
            flag.z,
        );
        if (groundY === null) return false;
        seated.push({ ...flag, groundY });
    }
    const g = new THREE.Group();

    const blueTexture = buildFlagTexture('blue');
    const redTexture = buildFlagTexture('red');
    const assets = {
        poleGeometry: new THREE.CylinderGeometry(FLAG_POLE_RADIUS_M, FLAG_POLE_RADIUS_M, FLAG_POLE_HEIGHT_M, 8),
        finialGeometry: new THREE.SphereGeometry(0.12, 10, 8),
        poleMaterial: new THREE.MeshStandardMaterial({ color: 0x6b7280, metalness: 0.55, roughness: 0.45 }),
        finialMaterial: new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.72, roughness: 0.28 }),
        clothMaterials: {
            blue: new THREE.MeshStandardMaterial({
                map: blueTexture,
                side: THREE.DoubleSide,
                roughness: 0.88,
                metalness: 0.02,
            }),
            red: new THREE.MeshStandardMaterial({
                map: redTexture,
                side: THREE.DoubleSide,
                roughness: 0.88,
                metalness: 0.02,
            }),
        },
    };

    for (const flag of seated) {
        const instance = createFlagInstance(
            flag.x,
            flag.groundY,
            flag.z,
            flag.faction,
            flag.seed,
            assets,
        );
        builtFlags.push(instance);
        g.add(instance.group);
    }
    return { group: g, flags: builtFlags };
}

function animateFlags(nowS) {
    const halfW = FLAG_WIDTH_M * 0.5;
    for (const flag of liveFlags) {
        const arr = flag.positionAttr.array;
        const base = flag.base;
        const gust = 0.78 + 0.22 * Math.sin(nowS * 0.33 + flag.gustPhase);
        for (let i = 0; i < arr.length; i += 3) {
            const bx = base[i];
            const by = base[i + 1];
            const u = (bx + halfW) / FLAG_WIDTH_M;
            const edge = u * u * (3 - 2 * u);
            const wave1 = Math.sin(nowS * (2.1 * flag.speed) + u * 5.2 + flag.phase);
            const wave2 = Math.sin(nowS * (4.4 * flag.speed) - u * 9.6 - by * 1.6 + flag.phase * 1.7);
            const flutter = Math.sin(nowS * 8.4 + u * 18.0 + flag.phase * 2.4);
            arr[i] = bx + edge * gust * (0.04 * wave1 + 0.015 * wave2) * flag.amp;
            arr[i + 1] = by + edge * gust * (0.06 * wave2 + 0.015 * flutter) * flag.amp;
            arr[i + 2] = edge * gust * (0.22 * wave1 + 0.09 * wave2 + 0.03 * flutter) * flag.amp;
        }
        flag.positionAttr.needsUpdate = true;
    }
}

function rebuild(centerLat, centerLon) {
    lastBuildLat = centerLat;
    lastBuildLon = centerLon;
    const built = build(centerLat, centerLon);
    if (built === false) return false;
    const previous = group;
    group = built.group;
    liveFlags = built.flags;
    scene.add(group);
    if (previous) disposeGroup(previous);
    return true;
}

function clearFlags() {
    if (group) {
        disposeGroup(group);
        group = null;
    }
    liveFlags = [];
    lastBuildLat = null;
    lastBuildLon = null;
}

export const flagsLayer = {
    // Capture flags are free-roam furniture: they follow the ambient-hostile
    // scope, not plain game mode, so an authored campaign encounter does not
    // scatter them through a story scene.
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        allStops,
        otherTracks: tracks,
        initialPose,
        isAmbientHostileMode,
        terrain,
    }) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        terrainRefreshPending = false;
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            terrainRefreshPending = true;
        }) || null;
        stops = allStops || [];
        otherTracks = tracks || [];
        ambientHostilesFn = typeof isAmbientHostileMode === 'function' ? isAmbientHostileMode : null;
        liveFlags = [];
        lastBuildLat = null;
        lastBuildLon = null;
        if (initialPose && ambientHostilesFn && ambientHostilesFn()) {
            rebuild(initialPose.lat, initialPose.lon);
        }
    },
    onFrame(pose) {
        const inGame = !!(ambientHostilesFn && ambientHostilesFn());
        if (!inGame) {
            clearFlags();
            return;
        }
        if (!pose) return;
        if (terrainRefreshPending) {
            terrainRefreshPending = false;
            rebuild(pose.lat, pose.lon);
        }
        if (lastBuildLat == null || haversineMeters(pose.lat, pose.lon, lastBuildLat, lastBuildLon) > FLAG_REBUILD_M) {
            rebuild(pose.lat, pose.lon);
        }
        if (liveFlags.length > 0) {
            animateFlags(performance.now() / 1000);
        }
    },
    endSession() {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        terrainReference = null;
        terrainRefreshPending = false;
        clearFlags();
        stops = [];
        otherTracks = [];
        ambientHostilesFn = null;
    },
};
