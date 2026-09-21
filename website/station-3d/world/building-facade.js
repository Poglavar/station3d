// Procedural windows + doors for GDI buildings. Recovers rectangular wall
// faces from the wall triangle stream that addBuildingFeatureGdi already
// produces, lays out openings per floor, and emits two merged meshes per
// building (frame/sill/lintel/mullion + glass) plus an optional door mesh.
// Everything is tagged with the building's tileKey so eviction matches.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

// Approximate centre of Zagreb (Trg bana Jelačića). Distance from here grades
// floor-height and window-pitch from "centre" (tall ceilings, wide spacing)
// to "periphery" (standard residential proportions).
const CITY_CENTRE_LAT = 45.8131;
const CITY_CENTRE_LON = 15.9772;
const CENTRE_FALLOFF_M = 1500;

const FLOOR_H_CENTRE = 3.6;
const FLOOR_H_PERI   = 2.9;
const PITCH_CENTRE   = 3.0;
const PITCH_PERI     = 2.7;

// Window dimensions
const WIN_W = 1.15;
const WIN_H = 1.65;
const WIN_SILL_FROM_FLOOR = 0.95;

// Door dimensions
const DOOR_W = 1.10;
const DOOR_H = 2.20;
const DOOR_DEPTH_OUT = 0.04;

// Trim element thicknesses (all extruded out from the facade so we never
// sit "inside" the solid wall, which would otherwise be hidden by the
// wall triangles in front).
//
// Frame = 4 thin strips (top/bottom/left/right) outlining the glass — this
// is what makes a window read as a rectangular opening rather than as a
// cross or I-shape. Mullion splits the glass vertically. Sill protrudes
// further out below the frame. No separate lintel; the top frame strip
// covers that role.
const FRAME_THICK = 0.05;
const FRAME_DEPTH_OUT = 0.04;
const SILL_THICK = 0.05;
const SILL_DEPTH_OUT = 0.10;
const SILL_OVERHANG = 0.05;
const MULLION_W = 0.04;
const MULLION_DEPTH_OUT = 0.04;
// Slight forward bias to keep box back-faces clear of the wall plane.
// PolygonOffset on the wall mostly prevents z-fighting, but at oblique
// angles or far depth ranges it isn't enough — pushing detail forward by
// half a cm is reliable.
const DETAIL_FORWARD = 0.005;
// Glass sits in front of the wall surface so polygonOffset on the wall
// material reliably puts our pane on top instead of Z-fighting with it.
// We don't actually cut the wall — the frame around the pane creates the
// impression of depth without expensive geometry surgery.
const GLASS_FORWARD = 0.014;

// Plane bucketing: round normal coords + plane offset so triangles that
// belong to the same wall plane (despite minor floating-point jitter)
// land in the same bucket.
const NORMAL_QUANT = 0.05;
const PLANE_D_QUANT = 0.10;

// Faces below these dims aren't worth decorating — too small for a
// window to fit cleanly, and visually we'd just be adding noise.
const MIN_FACE_W = 2.0;
const MIN_FACE_H = 2.6;
const MIN_SLOT = 1.7;

// ─── Shared materials ──────────────────────────────────────────────────────
let _frameMat = null;
let _glassMat = null;
let _doorMat = null;

function getFrameMat() {
    if (_frameMat) return _frameMat;
    _frameMat = new THREE.MeshStandardMaterial({
        color: 0xeae0c8,
        roughness: 0.7,
    });
    registerShared(_frameMat);
    return _frameMat;
}

function getGlassMat() {
    if (_glassMat) return _glassMat;
    _glassMat = new THREE.MeshStandardMaterial({
        color: 0x5f8fa8,
        emissive: 0x0b2230,
        emissiveIntensity: 0.22,
        roughness: 0.10,
        metalness: 0.18,
        side: THREE.DoubleSide,
    });
    registerShared(_glassMat);
    return _glassMat;
}

function getDoorMat() {
    if (_doorMat) return _doorMat;
    _doorMat = new THREE.MeshStandardMaterial({
        color: 0x3a2418,
        roughness: 0.55,
    });
    registerShared(_doorMat);
    return _doorMat;
}

// ─── ID hash (matches buildings.js style) ──────────────────────────────────
function hashStr(s) {
    let h = 2166136261;
    s = String(s);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// ─── Triangle accumulator ──────────────────────────────────────────────────
// Caller streams wall triangles into push(); we group them by quantised
// plane signature so we can recover face rectangles per wall plane.
export function makeFaceAccumulator() {
    const faces = new Map();
    return {
        push(v0, v1, v2) {
            const e1x = v1[0]-v0[0], e1y = v1[1]-v0[1], e1z = v1[2]-v0[2];
            const e2x = v2[0]-v0[0], e2y = v2[1]-v0[1], e2z = v2[2]-v0[2];
            const cnx = e1y*e2z - e1z*e2y;
            const cny = e1z*e2x - e1x*e2z;
            const cnz = e1x*e2y - e1y*e2x;
            const len = Math.sqrt(cnx*cnx + cny*cny + cnz*cnz);
            if (len < 1e-6) return;
            const nx = cnx/len, ny = cny/len, nz = cnz/len;
            const d  = nx*v0[0] + ny*v0[1] + nz*v0[2];
            const qx = Math.round(nx / NORMAL_QUANT) * NORMAL_QUANT;
            const qy = Math.round(ny / NORMAL_QUANT) * NORMAL_QUANT;
            const qz = Math.round(nz / NORMAL_QUANT) * NORMAL_QUANT;
            const qd = Math.round(d  / PLANE_D_QUANT) * PLANE_D_QUANT;
            const key = `${qx.toFixed(2)}|${qy.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(1)}`;
            let f = faces.get(key);
            if (!f) {
                f = { nx, ny, nz, tris: [] };
                faces.set(key, f);
            }
            f.tris.push([v0, v1, v2]);
        },
        faces() { return faces; },
    };
}

// ─── Footprint outer-ring extraction (street-facing classifier) ──────────
// Each LOD2 wall face contributes one bottom edge in (x, z). Stitched at
// shared endpoints, those bottom edges form one or more closed loops:
// the OUTER loop is the building's street-facing perimeter, INNER loops
// are courtyard cutouts. A face is street-facing iff its bottom edge
// belongs to the outer loop.
//
// This is the upgrade from the previous convex-hull probe: it handles
// L-shaped notches, U-shaped block courtyards, and O-shaped donut blocks
// without any tunable thresholds. The only assumption is that walls form
// a closed footprint at ground level — true for clean LOD2 GDI buildings.

function signedArea(verts) {
    let a = 0;
    for (let i = 0; i < verts.length; i++) {
        const p = verts[i], q = verts[(i + 1) % verts.length];
        a += (p.x * q.z - q.x * p.z);
    }
    return a / 2;
}

export function extractOuterFootprintRing(faces) {
    // 1cm quantisation collapses floating-point jitter at shared corners.
    const QUANT = 100;
    const qk = (x, z) => `${Math.round(x * QUANT)}|${Math.round(z * QUANT)}`;

    // Only ground-level faces participate; balconies/setbacks aren't part
    // of the outline. vMin tracks the lowest world-Y of each recovered face.
    const groundFaces = faces.filter((f) => f.vMin < 0.5);
    if (groundFaces.length < 3) return null;

    // Each face → one bottom edge as a directed segment in XZ.
    const edges = groundFaces.map((f) => {
        const ax = f.origin[0], az = f.origin[2];
        const bx = ax + f.width * f.uTangent[0];
        const bz = az + f.width * f.uTangent[2];
        return { face: f, ax, az, bx, bz, ka: qk(ax, az), kb: qk(bx, bz) };
    });

    // Adjacency: each node key → list of incident edges. For clean LOD2
    // data every node has degree 2 (two walls meet at every footprint
    // corner), so loop walking is unambiguous.
    const adj = new Map();
    for (const e of edges) {
        if (!adj.has(e.ka)) adj.set(e.ka, []);
        if (!adj.has(e.kb)) adj.set(e.kb, []);
        adj.get(e.ka).push(e);
        adj.get(e.kb).push(e);
    }

    const used = new Set();
    const rings = [];
    for (const start of edges) {
        if (used.has(start)) continue;
        const ringEdges = new Set();
        const verts = [];
        let cur = start;
        let prevKey = cur.ka;          // we entered cur at ka, will exit at kb
        const startKey = cur.ka;
        let safety = 5000;
        while (safety-- > 0) {
            if (used.has(cur)) break;
            used.add(cur);
            ringEdges.add(cur);
            const fromKa = (prevKey === cur.ka);
            verts.push({ x: fromKa ? cur.ax : cur.bx, z: fromKa ? cur.az : cur.bz });
            const nextKey = fromKa ? cur.kb : cur.ka;
            if (nextKey === startKey && verts.length >= 3) break;
            const candidates = (adj.get(nextKey) || []).filter((e) => !used.has(e));
            if (candidates.length === 0) break;
            cur = candidates[0];
            prevKey = nextKey;
        }
        if (verts.length >= 3) rings.push({ edges: ringEdges, verts });
    }
    if (rings.length === 0) return null;

    // Outer ring = largest |area|. Inner rings (courtyards) are smaller.
    let outer = rings[0];
    let outerArea = Math.abs(signedArea(outer.verts));
    for (let i = 1; i < rings.length; i++) {
        const a = Math.abs(signedArea(rings[i].verts));
        if (a > outerArea) { outer = rings[i]; outerArea = a; }
    }
    return outer;
}

// ─── Coplanar-duplicate dedupe ─────────────────────────────────────────────
// Group faces by quantised outward-normal direction (ignoring plane offset).
// Within a group, keep the OUTERMOST face (highest d along its own normal),
// then accept further faces only if they are at least DEDUPE_GAP_M inwards
// from any already-kept face. Catches both "thick wall = front + back face
// polygons offset by a few cm" and "two coplanar wall polygons that ended
// up in different buckets due to floating-point noise".
const DEDUPE_GAP_M = 0.5;

function dedupeNearCoplanar(faces) {
    const groups = new Map();
    for (const f of faces) {
        const key = `${Math.round(f.normal[0] * 20) / 20}|${Math.round(f.normal[2] * 20) / 20}`;
        const d = f.normal[0] * f.centroid[0] + f.normal[2] * f.centroid[2];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ face: f, d });
    }
    const out = [];
    for (const group of groups.values()) {
        group.sort((a, b) => b.d - a.d);
        const kept = [];
        for (const g of group) {
            if (kept.some((k) => Math.abs(k.d - g.d) < DEDUPE_GAP_M)) continue;
            kept.push(g);
            out.push(g.face);
        }
    }
    return out;
}

// ─── Face recovery ─────────────────────────────────────────────────────────
// Each face → an oriented rectangle in (u, v) where u is the horizontal
// tangent along the wall and v is world-Y. We assume vertical walls; a
// sloped wall still gets a usable AABB but openings might land slightly
// off the actual face. Real buildings in the centre are vertical.
export function recoverFaces(faceMap) {
    const out = [];
    for (const f of faceMap.values()) {
        if (Math.abs(f.ny) > 0.5) continue;        // skip horizontal-ish (defensive — caller passes only walls)
        let tx = f.nz, tz = -f.nx;
        const tlen = Math.sqrt(tx*tx + tz*tz);
        if (tlen < 1e-6) continue;
        tx /= tlen; tz /= tlen;

        const ref = f.tris[0][0];
        let uMin = Infinity, uMax = -Infinity;
        let vMin = Infinity, vMax = -Infinity;
        let cx = 0, cz = 0, n = 0;
        for (const tri of f.tris) {
            for (const v of tri) {
                const u = (v[0] - ref[0]) * tx + (v[2] - ref[2]) * tz;
                if (u < uMin) uMin = u;
                if (u > uMax) uMax = u;
                if (v[1] < vMin) vMin = v[1];
                if (v[1] > vMax) vMax = v[1];
                cx += v[0]; cz += v[2]; n++;
            }
        }
        // Shift origin so face-local u runs [0, width]
        const origin = [ref[0] + uMin * tx, 0, ref[2] + uMin * tz];
        out.push({
            normal: [f.nx, f.ny, f.nz],
            uTangent: [tx, 0, tz],
            origin,
            width: uMax - uMin,
            height: vMax - vMin,
            vMin, vMax,
            centroid: [cx/n, 0, cz/n],
        });
    }
    return out;
}

// ─── Geometry primitives ──────────────────────────────────────────────────
// Both helpers append non-indexed triangle positions to `out`. Winding is
// CCW from outside the volume so computeVertexNormals produces outward
// normals automatically (and gives flat shading because vertices aren't
// shared between faces).
//
// Face-local axes:
//   u = horizontal wall tangent (uTangent)
//   v = world Y
//   w = outward face normal
// World transform: world = origin + u*uTangent + (0, v, 0) + w*normal

const BOX_TRIS = [
    // back  (-w)
    [0,3,2], [0,2,1],
    // front (+w)
    [4,5,6], [4,6,7],
    // bottom (-v)
    [0,1,5], [0,5,4],
    // top    (+v)
    [3,7,6], [3,6,2],
    // left   (-u)
    [0,4,7], [0,7,3],
    // right  (+u)
    [1,2,6], [1,6,5],
];

function pushBox(out, face, uC, vC, wC, du, dv, dw) {
    const { uTangent, normal, origin } = face;
    const hu = du/2, hv = dv/2, hw = dw/2;
    const local = [
        [uC-hu, vC-hv, wC-hw],
        [uC+hu, vC-hv, wC-hw],
        [uC+hu, vC+hv, wC-hw],
        [uC-hu, vC+hv, wC-hw],
        [uC-hu, vC-hv, wC+hw],
        [uC+hu, vC-hv, wC+hw],
        [uC+hu, vC+hv, wC+hw],
        [uC-hu, vC+hv, wC+hw],
    ];
    const world = local.map(([u,v,w]) => [
        origin[0] + u*uTangent[0] + w*normal[0],
        v + w*normal[1],
        origin[2] + u*uTangent[2] + w*normal[2],
    ]);
    for (const [a,b,c] of BOX_TRIS) {
        out.push(world[a][0], world[a][1], world[a][2]);
        out.push(world[b][0], world[b][1], world[b][2]);
        out.push(world[c][0], world[c][1], world[c][2]);
    }
}

function pushPlane(out, face, uC, vC, wOff, du, dv) {
    const { uTangent, normal, origin } = face;
    const hu = du/2, hv = dv/2;
    const local = [
        [uC-hu, vC-hv],
        [uC+hu, vC-hv],
        [uC+hu, vC+hv],
        [uC-hu, vC+hv],
    ];
    const world = local.map(([u,v]) => [
        origin[0] + u*uTangent[0] + wOff*normal[0],
        v + wOff*normal[1],
        origin[2] + u*uTangent[2] + wOff*normal[2],
    ]);
    out.push(world[0][0],world[0][1],world[0][2], world[1][0],world[1][1],world[1][2], world[2][0],world[2][1],world[2][2]);
    out.push(world[0][0],world[0][1],world[0][2], world[2][0],world[2][1],world[2][2], world[3][0],world[3][1],world[3][2]);
}

// ─── Layout ───────────────────────────────────────────────────────────────
function lerp01(a, b, t) {
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return a + (b - a) * t;
}

function distFromCentre(localX, localZ, anchorLat, anchorLon) {
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const cx = (CITY_CENTRE_LON - anchorLon) * SCALE_LON;
    const cz = -(CITY_CENTRE_LAT - anchorLat) * SCALE_LAT;
    const dx = localX - cx, dz = localZ - cz;
    return Math.sqrt(dx*dx + dz*dz);
}

function emitWindow(face, centerU, floorBaseV, framePos, glassPos) {
    // Need lateral room for the frame strips on each side
    if (centerU - WIN_W/2 - FRAME_THICK < 0) return;
    if (centerU + WIN_W/2 + FRAME_THICK > face.width) return;
    const sillTopV = floorBaseV + WIN_SILL_FROM_FLOOR;
    if (sillTopV + WIN_H + FRAME_THICK > face.vMax + 0.01) return;
    const winCenterV = sillTopV + WIN_H/2;

    const wCFrame = FRAME_DEPTH_OUT/2 + DETAIL_FORWARD;

    // Glass — flat plane in front of the wall surface
    pushPlane(glassPos, face, centerU, winCenterV, GLASS_FORWARD, WIN_W, WIN_H);

    // Frame: 4 thin strips outlining the glass.
    //   top   — above glass
    pushBox(framePos, face,
        centerU, sillTopV + WIN_H + FRAME_THICK/2, wCFrame,
        WIN_W + FRAME_THICK*2, FRAME_THICK, FRAME_DEPTH_OUT);
    //   bottom — directly below glass
    pushBox(framePos, face,
        centerU, sillTopV - FRAME_THICK/2, wCFrame,
        WIN_W + FRAME_THICK*2, FRAME_THICK, FRAME_DEPTH_OUT);
    //   left
    pushBox(framePos, face,
        centerU - WIN_W/2 - FRAME_THICK/2, winCenterV, wCFrame,
        FRAME_THICK, WIN_H, FRAME_DEPTH_OUT);
    //   right
    pushBox(framePos, face,
        centerU + WIN_W/2 + FRAME_THICK/2, winCenterV, wCFrame,
        FRAME_THICK, WIN_H, FRAME_DEPTH_OUT);

    // Mullion — vertical bar splitting the pane
    pushBox(framePos, face,
        centerU, winCenterV, MULLION_DEPTH_OUT/2 + DETAIL_FORWARD,
        MULLION_W, WIN_H, MULLION_DEPTH_OUT);

    // Sill — protruding below the frame's bottom strip
    pushBox(framePos, face,
        centerU,
        (sillTopV - FRAME_THICK) - SILL_THICK/2,
        SILL_DEPTH_OUT/2 + DETAIL_FORWARD,
        WIN_W + (FRAME_THICK + SILL_OVERHANG)*2, SILL_THICK, SILL_DEPTH_OUT);
}

function emitDoor(face, centerU, floorBaseV, framePos, doorPos) {
    if (centerU - DOOR_W/2 - FRAME_THICK < 0) return;
    if (centerU + DOOR_W/2 + FRAME_THICK > face.width) return;
    if (floorBaseV + DOOR_H + FRAME_THICK > face.vMax + 0.01) return;

    const wCFrame = FRAME_DEPTH_OUT/2 + DETAIL_FORWARD;

    // Door slab — biased forward off the wall plane to avoid z-fighting
    pushBox(doorPos, face,
        centerU, floorBaseV + DOOR_H/2,
        DOOR_DEPTH_OUT/2 + DETAIL_FORWARD,
        DOOR_W, DOOR_H, DOOR_DEPTH_OUT);

    // Door frame — top + sides (no bottom; that's the ground)
    pushBox(framePos, face,
        centerU, floorBaseV + DOOR_H + FRAME_THICK/2, wCFrame,
        DOOR_W + FRAME_THICK*2, FRAME_THICK, FRAME_DEPTH_OUT);
    pushBox(framePos, face,
        centerU - DOOR_W/2 - FRAME_THICK/2, floorBaseV + DOOR_H/2, wCFrame,
        FRAME_THICK, DOOR_H, FRAME_DEPTH_OUT);
    pushBox(framePos, face,
        centerU + DOOR_W/2 + FRAME_THICK/2, floorBaseV + DOOR_H/2, wCFrame,
        FRAME_THICK, DOOR_H, FRAME_DEPTH_OUT);
}

// ─── Public entry point ───────────────────────────────────────────────────
export function emitFacadeDetail({
    faceMap,
    objectId,
    anchorLat,
    anchorLon,
    buildingsGroup,
    tileKey,
}) {
    const allFaces = recoverFaces(faceMap);
    if (allFaces.length === 0) return;

    // Footprint outer-ring filter. Stitch each ground-level face's bottom
    // edge into closed loops, identify the outer loop by area, and keep
    // only faces whose bottom edge belongs to it. Courtyard / inner-ring
    // faces drop out cleanly — works for L, U, O, and weirder footprints.
    const outerRing = extractOuterFootprintRing(allFaces);
    let exteriorFaces;
    if (outerRing) {
        const outerFaceSet = new Set();
        for (const e of outerRing.edges) outerFaceSet.add(e.face);
        exteriorFaces = allFaces.filter((f) => outerFaceSet.has(f));
    } else {
        // Footprint stitching failed (degenerate / non-closed walls).
        // Pass everything through; dedupe + slot filtering will handle
        // most of the visual fallout.
        exteriorFaces = allFaces;
    }
    if (exteriorFaces.length === 0) return;

    // Drop near-coplanar duplicates (datasets with both inner+outer face
    // polygons, or stepped facades that bucket as two distinct planes).
    const faces = dedupeNearCoplanar(exteriorFaces);
    if (faces.length === 0) return;

    // Use the first face's centroid as a stand-in for the building's
    // centroid — close enough for grading floor-height by distance.
    const c0 = faces[0].centroid;
    const dCentre = distFromCentre(c0[0], c0[2], anchorLat, anchorLon);
    const t = dCentre / CENTRE_FALLOFF_M;
    const floorH = lerp01(FLOOR_H_CENTRE, FLOOR_H_PERI, t);
    const pitch  = lerp01(PITCH_CENTRE,   PITCH_PERI,   t);

    const idHash = hashStr(objectId != null ? objectId : `${c0[0].toFixed(1)}|${c0[2].toFixed(1)}`);

    // One door per building, on the longest ground-touching exterior face.
    let frontIdx = -1, frontW = 0;
    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        if (f.vMin > 0.4) continue;
        if (f.width > frontW) { frontW = f.width; frontIdx = i; }
    }

    const framePos = [];
    const glassPos = [];
    const doorPos  = [];

    for (let fi = 0; fi < faces.length; fi++) {
        const face = faces[fi];
        if (face.width < MIN_FACE_W || face.height < MIN_FACE_H) continue;

        const floors = Math.max(1, Math.round(face.height / floorH));
        const actualFloorH = face.height / floors;
        if (actualFloorH < 2.4) continue;
        const n = Math.max(1, Math.round(face.width / pitch));
        const slot = face.width / n;
        if (slot < MIN_SLOT) continue;

        // Door slot = middle-ish of the front face, hash-jittered ±1
        const doorSlot = (fi === frontIdx)
            ? Math.max(0, Math.min(n - 1, Math.floor(n / 2) + ((idHash >> 8) % 3) - 1))
            : -1;

        for (let f = 0; f < floors; f++) {
            const floorBaseV = face.vMin + f * actualFloorH;
            for (let i = 0; i < n; i++) {
                const centerU = (i + 0.5) * slot;
                if (f === 0 && i === doorSlot) {
                    emitDoor(face, centerU, floorBaseV, framePos, doorPos);
                } else {
                    emitWindow(face, centerU, floorBaseV, framePos, glassPos);
                }
            }
        }
    }

    pushMesh(buildingsGroup, framePos, getFrameMat(), tileKey);
    pushMesh(buildingsGroup, glassPos, getGlassMat(), tileKey);
    pushMesh(buildingsGroup, doorPos,  getDoorMat(),  tileKey);
}

function pushMesh(group, positions, mat, tileKey) {
    if (positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    group.add(mesh);
}
