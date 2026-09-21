// Universal default-ground rule: the weathered-sidewalk "catch-all city
// ground" appears only within BUILDING_PAD_M of a building footprint or
// ROAD_PAD_M beyond a road's edge; everywhere else the catch-all reads as
// grassland. Dense city blocks union into continuous pavement on their own
// (canvas compositing IS the union), while semi-rural areas — Velika Gorica,
// the airport fields — stay green instead of looking paved over.
//
// One world-anchored canvas mask feeds the existing urban-ground-surface
// shader patch (sidewalk blended over the base map where mask=1). Building
// and road tiles stream in over time, so the mask redraws on a throttle and
// recentres with the camera on long rides. Road shapes follow the published
// aggregate's lifetime; a redraw is a full repaint from the retained data.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import { createGroundCoverFootprints } from '../core/ground-cover-footprints.js';
import { groundMesh, SIDEWALK_TILE_M } from '../scene/setup.js';
import { getGrassTexture } from './decor.js';
import {
    applyUrbanGroundSurface,
    clearUrbanGroundSurfaceMask,
    setUrbanGroundSurfaceMask,
} from './urban-ground-surface.js';

const BUILDING_PAD_M = 15;   // paved pad around each house (box)
const ROAD_PAD_M = 5;        // paved verge beyond a road's edge
const MASK_RES = 2048;
const HALF_SIZE_M = 3072;    // 3 m/px window — plenty for 30 m+ features
const RECENTER_AT_FRACTION = 0.35;
// 1.2 s: each repaint re-uploads a 2048² texture — during heavy tile
// streaming the old 0.7 s cadence contributed to frame hitching.
const REDRAW_THROTTLE_MS = 1200;
const GRASS_TILE_ON_GROUND_M = 3.0;  // grass pattern density on the big plane

let active = false;
let canvas = null;
let ctx = null;
let texture = null;
let centerX = 0;
let centerZ = 0;
let rects = [];     // building pads: { minX, minZ, maxX, maxZ } (local metres)
const roadFootprints = createGroundCoverFootprints({ onChanged: scheduleRedraw });
let redrawTimer = 0;
let sidewalkMap = null;   // the plane's original base map, restored when off
let grassMap = null;

function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.width = MASK_RES;
    canvas.height = MASK_RES;
    ctx = canvas.getContext('2d');
    texture = new THREE.CanvasTexture(canvas);
    texture.name = 'GroundCoverMask';
    texture.flipY = false;   // straight row↔z mapping, same as terrain's feeder
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    registerShared(texture);
}

function redraw() {
    if (!active || !ctx) return;
    const scale = MASK_RES / (HALF_SIZE_M * 2);
    const toX = (x) => (x - centerX + HALF_SIZE_M) * scale;
    // flipY=false ⇒ straight row↔z mapping — the exact convention terrain's
    // mask feeder uses for this same shader slot.
    const toZ = (z) => (z - centerZ + HALF_SIZE_M) * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MASK_RES, MASK_RES);
    ctx.fillStyle = '#fff';
    for (const r of rects) {
        ctx.fillRect(
            toX(r.minX - BUILDING_PAD_M),
            toZ(r.minZ - BUILDING_PAD_M),
            (r.maxX - r.minX + BUILDING_PAD_M * 2) * scale,
            (r.maxZ - r.minZ + BUILDING_PAD_M * 2) * scale,
        );
    }
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, ROAD_PAD_M * 2 * scale);
    for (const pts of roadFootprints.rings()) {
        ctx.beginPath();
        ctx.moveTo(toX(pts[0]), toZ(pts[1]));
        for (let i = 2; i < pts.length; i += 2) {
            ctx.lineTo(toX(pts[i]), toZ(pts[i + 1]));
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    texture.needsUpdate = true;
    setUrbanGroundSurfaceMask(texture, centerX, centerZ, HALF_SIZE_M);
}

function scheduleRedraw() {
    if (!active) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(redraw, REDRAW_THROTTLE_MS);
}

export function groundCoverNoteBuildingRect(minX, minZ, maxX, maxZ) {
    if (!active
        || ![minX, minZ, maxX, maxZ].every(Number.isFinite)
        || maxX <= minX || maxZ <= minZ) return;
    rects.push({ minX, minZ, maxX, maxZ });
    scheduleRedraw();
}

// Roads arrive as already-buffered surface POLYGONS: fill the ring and
// stroke it 2×ROAD_PAD_M with round joins — an exact dilation of the paved
// surface by the verge width. Preparation is private; only a successful road
// aggregate publication schedules the existing throttled texture repaint.
export function* prepareGroundCoverRoadBucketSteps(bucketKey, owners, options) {
    if (!active) return null;
    return yield* roadFootprints.prepareBucketSteps(bucketKey, owners, options);
}

export function clearGroundCoverRoads() {
    roadFootprints.clear();
}

// Called from the cab/walk frame loop: recentre the mask window when the
// camera nears its edge (long rides). Only committed road footprints feed
// the repaint, including while a successor is being built.
export function groundCoverFrame(x, z) {
    if (!active) return;
    if (Math.abs(x - centerX) > HALF_SIZE_M * RECENTER_AT_FRACTION
        || Math.abs(z - centerZ) > HALF_SIZE_M * RECENTER_AT_FRACTION) {
        centerX = x;
        centerZ = z;
        redraw();
    }
}

// enabled: flat model sessions, plus terrain sessions whose location has no
// terrain urban-ground mask of its own (Zagreb). The photo world has no
// catch-all plane; a terrain location that builds its own mask (Split) keeps
// driving the shared shader slot itself, so this stays off there. In terrain
// mode groundMesh is hidden — the swapped grass base is harmless, and only the
// world-anchored mask (fed to the shared slot) is consumed by the terrain material.
export function beginGroundCover({ enabled = false } = {}) {
    active = !!enabled && !!groundMesh && !!groundMesh.material;
    rects = [];
    roadFootprints.clear();
    centerX = 0;
    centerZ = 0;
    clearTimeout(redrawTimer);
    const material = groundMesh && groundMesh.material;
    if (!material) return;
    if (!sidewalkMap) sidewalkMap = material.map;
    if (active) {
        if (!grassMap) {
            grassMap = getGrassTexture().clone();
            // The plane's UVs are baked at one unit per SIDEWALK_TILE_M;
            // repeat re-tiles the grass to its own natural density. The
            // cab's world-anchoring offset multiplies by repeat to match.
            grassMap.repeat.set(
                SIDEWALK_TILE_M / GRASS_TILE_ON_GROUND_M,
                SIDEWALK_TILE_M / GRASS_TILE_ON_GROUND_M,
            );
            grassMap.needsUpdate = true;
            registerShared(grassMap);
        }
        material.map = grassMap;
        // Flat world's ground cover — same farmland quilt as the streamed terrain, so
        // the two worlds read alike.
        applyUrbanGroundSurface(
            material,
            material.userData.surfaceClaim,
            { fieldPatchwork: true },
        );
        ensureCanvas();
        redraw();   // empty mask → all grass until the first data lands
    } else {
        if (sidewalkMap) material.map = sidewalkMap;
        clearUrbanGroundSurfaceMask();
    }
    material.needsUpdate = true;
}
