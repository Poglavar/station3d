// Renders REAL detected windows/doors on buildings that have them, instead of
// the procedural window grid. Data comes from the SAM3 facade pipeline
// (zagreb-zgrade-datiranje): per object_id, the street wall's two ground corners
// A,B (lon/lat) plus windows as (u_m along A→B, sill_m above ground, w_m, h_m).
// We map A,B into the cab's local metre frame, clip each opening against its
// exact supporting wall triangles, and draw the resulting coplanar fragments
// with material depth bias. Buildings present here get blank plaster walls
// (procedural windows suppressed) so only the real openings show.

import * as THREE from 'three';
import { geoToLocal } from '../core/math.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { getApiBase } from '../core/api.js';
import {
    buildLogicalFacadeSurfaces,
    rectangleFullyCoveredByTriangles,
} from './facade-surfaces.js';

// Effective openings (manual-overrides-auto) come from the DB via the cadastre
// API now — no more static JSON. One fetch caches the whole set keyed by
// object_id; small enough today, and ?bbox= is supported for area loads later.
const DATA_URL = `${getApiBase()}/facade-openings`;
// The optional rectified-photo experiment still uses the cadastral A/B plane;
// keep that whole photo clear of the surveyed mesh. Individual windows and
// doors instead conform to their exact source-wall triangles below.
const FACADE_PHOTO_PROUD_M = 0.25;
const OPENING_EDGE_MARGIN_M = 0.12;
const WALL_PLANE_OFFSET_TOLERANCE_M = 1.0;
const WALL_DIRECTION_DOT = 0.99;
const WALL_TARGET_DEPTH_TOLERANCE_M = 0.08;

let dataMap = null;        // object_id(string) → { a_lonlat, b_lonlat, windows, doors }
let loadPromise = null;
let _glassMat = null;
let _doorMat = null;

export function ensureFacadeWindowData() {
    if (dataMap) return Promise.resolve(dataMap);
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL)
        .then((r) => (r.ok ? r.json() : { buildings: {} }))
        .then((j) => { dataMap = j.buildings || {}; return dataMap; })
        .catch((err) => { console.warn('[facade-windows] load failed:', err); dataMap = {}; return dataMap; });
    return loadPromise;
}

export function facadeWindowDataReady() { return dataMap != null; }

export function hasFacadeWindows(objectId) {
    return !!(dataMap && objectId != null && dataMap[String(objectId)]);
}

// Raw facade-openings entry (wall corners A/B, width_m, facade_height_m, …) for
// other facade layers that anchor to the same street wall (facade-spec.js).
export function getFacadeEntry(objectId) {
    return (dataMap && objectId != null && dataMap[String(objectId)]) || null;
}

// The exact Street View pano + heading a building's windows were detected from
// (null if this building has no detection data). Lets the Street View link open
// the precise frame instead of guessing a viewpoint.
export function getFacadePano(objectId) {
    const e = dataMap && objectId != null && dataMap[String(objectId)];
    return e && e.pano_id ? { pano_id: e.pano_id, heading: e.heading } : null;
}

// A single window image — stone frame + reflective glass + cross mullion +
// sill — painted once and mapped across every clipped opening patch, so each
// detected rectangle reads as a real framed window.
let _winTex = null;
function windowTexture() {
    if (_winTex) return _winTex;
    const S = 2, W = 64 * S, H = 96 * S, fw = 6 * S;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#d9d3c5'; x.fillRect(0, 0, W, H);                 // stone frame
    const g = x.createLinearGradient(0, fw, 0, H - fw);             // glass
    g.addColorStop(0, '#b3c4cf'); g.addColorStop(0.5, '#8aa1b0'); g.addColorStop(1, '#5f7686');
    x.fillStyle = g; x.fillRect(fw, fw, W - 2 * fw, H - 2 * fw);
    x.save(); x.beginPath(); x.rect(fw, fw, W - 2 * fw, H - 2 * fw); x.clip();  // diagonal sheen
    x.globalAlpha = 0.18; x.fillStyle = '#ffffff';
    x.beginPath(); x.moveTo(W * 0.18, fw); x.lineTo(W * 0.42, fw);
    x.lineTo(W * 0.12, H - fw); x.lineTo(-W * 0.12, H - fw); x.closePath(); x.fill();
    x.restore();
    x.fillStyle = '#e6e0d2';                                        // cross mullion
    x.fillRect(W / 2 - 1.5 * S, fw, 3 * S, H - 2 * fw);
    x.fillRect(fw, H * 0.52 - 1.5 * S, W - 2 * fw, 3 * S);
    x.fillStyle = '#b7af9d'; x.fillRect(0, H - 5 * S, W, 5 * S);    // sill ledge
    _winTex = new THREE.CanvasTexture(c);
    _winTex.colorSpace = THREE.SRGBColorSpace; _winTex.anisotropy = 4;
    registerShared(_winTex);
    return _winTex;
}

let _doorTex = null;
function doorTexture() {
    if (_doorTex) return _doorTex;
    const S = 2, W = 48 * S, H = 96 * S, fw = 5 * S;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#5a4634'; x.fillRect(0, 0, W, H);                 // door frame
    x.fillStyle = '#3a2c22'; x.fillRect(fw, fw, W - 2 * fw, H - 2 * fw);  // dark wood leaf
    x.strokeStyle = 'rgba(20,14,10,0.7)'; x.lineWidth = 2 * S;      // two recessed panels
    x.strokeRect(W * 0.22, H * 0.10, W * 0.56, H * 0.34);
    x.strokeRect(W * 0.22, H * 0.52, W * 0.56, H * 0.36);
    x.fillStyle = '#caa84a'; x.fillRect(W * 0.78, H * 0.5 - 4 * S, 3 * S, 8 * S);  // handle
    _doorTex = new THREE.CanvasTexture(c);
    _doorTex.colorSpace = THREE.SRGBColorSpace;
    registerShared(_doorTex);
    return _doorTex;
}

function glassMaterial() {
    if (_glassMat) return _glassMat;
    _glassMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: windowTexture(), roughness: 0.45, metalness: 0.0,
        emissive: 0x1a242c, emissiveIntensity: 0.18, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    registerShared(_glassMat);
    return _glassMat;
}

function doorMaterial() {
    if (_doorMat) return _doorMat;
    _doorMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: doorTexture(), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    registerShared(_doorMat);
    return _doorMat;
}

function openingRect(opening) {
    return {
        minU: opening.u_m,
        maxU: opening.u_m + opening.w_m,
        minV: opening.sill_m,
        maxV: opening.sill_m + opening.h_m,
    };
}

function findSupportingSurface(opening, supportSurfaces) {
    const rect = openingRect(opening);
    return (supportSurfaces || []).find((surface) =>
        rectangleFullyCoveredByTriangles(rect, surface.triangles || surface)) || null;
}

function interpolateVertex(a, b, t) {
    return {
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
    };
}

// Sutherland-Hodgman clipping in facade (u,v) space, while interpolating the
// exact 3D source position carried by each vertex. The resulting polygon stays
// on the surveyed wall even when that wall is tilted or slightly warped.
function clipPolygonAt(polygon, axis, boundary, keepGreater) {
    if (polygon.length === 0) return polygon;
    const result = [];
    const inside = (point) => keepGreater
        ? point[axis] >= boundary - 1e-9
        : point[axis] <= boundary + 1e-9;
    let previous = polygon[polygon.length - 1];
    let previousInside = inside(previous);
    for (const current of polygon) {
        const currentInside = inside(current);
        if (currentInside !== previousInside) {
            const denominator = current[axis] - previous[axis];
            const t = Math.abs(denominator) > 1e-12
                ? Math.max(0, Math.min(1, (boundary - previous[axis]) / denominator))
                : 0;
            result.push(interpolateVertex(previous, current, t));
        }
        if (currentInside) result.push(current);
        previous = current;
        previousInside = currentInside;
    }
    return result;
}

function clipTriangleToOpening(triangle, opening) {
    const rect = openingRect(opening);
    let polygon = triangle;
    polygon = clipPolygonAt(polygon, 'u', rect.minU, true);
    polygon = clipPolygonAt(polygon, 'u', rect.maxU, false);
    polygon = clipPolygonAt(polygon, 'v', rect.minV, true);
    polygon = clipPolygonAt(polygon, 'v', rect.maxV, false);
    return polygon;
}

export function buildFacadeOpeningGeometry(openings, supportSurfaces) {
    const positions = [], uv = [];
    for (const opening of openings || []) {
        const support = findSupportingSurface(opening, supportSurfaces);
        if (!support) continue;
        for (const triangle of support.triangles || []) {
            const clipped = clipTriangleToOpening(triangle, opening);
            for (let i = 1; i < clipped.length - 1; i++) {
                const vertices = [clipped[0], clipped[i], clipped[i + 1]];
                const projectedArea = Math.abs(
                    (vertices[1].u - vertices[0].u) * (vertices[2].v - vertices[0].v) -
                    (vertices[1].v - vertices[0].v) * (vertices[2].u - vertices[0].u)
                );
                if (projectedArea <= 1e-9) continue;
                for (const vertex of vertices) {
                    positions.push(vertex.x, vertex.y, vertex.z);
                    uv.push(
                        (vertex.u - opening.u_m) / opening.w_m,
                        (vertex.v - opening.sill_m) / opening.h_m,
                    );
                }
            }
        }
    }
    return { positions, uv };
}

function buildMesh(openings, supportSurfaces, mat) {
    const { positions: pos, uv } = buildFacadeOpeningGeometry(openings, supportSurfaces);
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
}

export function buildFacadeWallSupport(wallTriangles, A, dx, dz, nx, nz) {
    const surfaces = [];
    for (const surface of buildLogicalFacadeSurfaces(wallTriangles)) {
        // The cadastral A→B anchor can be offset from the surveyed mesh, but it
        // may never flatten multiple nearby setbacks into one support polygon.
        // Keep each tightly-coplanar connected surface as an independent item.
        if (Math.abs(surface.nx * nx + surface.nz * nz) < WALL_DIRECTION_DOT) continue;
        let offsetSum = 0, vertexCount = 0;
        const triangles = surface.worldTriangles.map((triangle) => triangle.map((point) => {
            const relX = point[0] - A.x;
            const relZ = point[2] - A.z;
            offsetSum += relX * nx + relZ * nz;
            vertexCount++;
            return {
                u: relX * dx + relZ * dz,
                v: point[1],
                x: point[0],
                y: point[1],
                z: point[2],
            };
        }));
        const meanOffset = vertexCount > 0 ? offsetSum / vertexCount : Infinity;
        if (Math.abs(meanOffset) > WALL_PLANE_OFFSET_TOLERANCE_M) continue;
        surfaces.push({ triangles, planeOffset: meanOffset });
    }
    if (surfaces.length === 0) return surfaces;
    // A/B names one facade plane. Its survey line may be displaced from the
    // rendered mesh, so first find the nearest depth, then retain only logical
    // components on that depth. A complete rear wall must not validate an
    // opening that will actually be drawn on the front wall.
    const target = surfaces.reduce((nearest, surface) =>
        Math.abs(surface.planeOffset) < Math.abs(nearest.planeOffset) ? surface : nearest);
    return surfaces.filter((surface) =>
        Math.abs(surface.planeOffset - target.planeOffset) <= WALL_TARGET_DEPTH_TOLERANCE_M);
}

function openingFullySupported(opening, supportSurfaces) {
    return !!findSupportingSurface(opening, supportSurfaces);
}

export function isFacadeOpeningFullyContained(opening, frontageWidthM, facadeHeightM, supportTriangles) {
    return Number.isFinite(opening.u_m) && Number.isFinite(opening.w_m) &&
        Number.isFinite(opening.sill_m) && Number.isFinite(opening.h_m) &&
        opening.w_m >= 0.2 && opening.h_m >= 0.2 &&
        opening.u_m >= OPENING_EDGE_MARGIN_M &&
        opening.u_m + opening.w_m <= frontageWidthM - OPENING_EDGE_MARGIN_M &&
        opening.sill_m >= -0.15 &&
        opening.sill_m + opening.h_m <= facadeHeightM - OPENING_EDGE_MARGIN_M &&
        openingFullySupported(opening, supportTriangles);
}

// Returns an array of meshes (windows, doors) for this building, in the local
// metre frame anchored at (anchorLat, anchorLon). centroidX/Z (local) orient the
// wall's outward normal. Caller tags them with tileKey/objectId and adds them to
// the buildings group so they evict with the tile.
export function buildFacadeWindowMeshes(
    objectId,
    anchorLat,
    anchorLon,
    centroidX,
    centroidZ,
    simWallHeight,
    wallTriangles = [],
) {
    const entry = dataMap && dataMap[String(objectId)];
    if (!entry) return [];
    const A = geoToLocal(entry.a_lonlat[0], entry.a_lonlat[1], anchorLon, anchorLat);
    const B = geoToLocal(entry.b_lonlat[0], entry.b_lonlat[1], anchorLon, anchorLat);
    const dirx = B.x - A.x, dirz = B.z - A.z;
    const L = Math.hypot(dirx, dirz);
    if (L < 0.5) return [];
    const dx = dirx / L, dz = dirz / L;
    // outward normal = the wall-perpendicular pointing away from the footprint centroid
    let nx = dz, nz = -dx;
    const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
    if ((mx - centroidX) * nx + (mz - centroidZ) * nz < 0) { nx = -nx; nz = -nz; }

    // Window metres come straight from the rectifier. Correct horizontal scale
    // (|A-B| vs measured facade width), then keep an opening only if its ENTIRE
    // rectangle fits both the measured frontage/eaves and the rendered wall
    // silhouette. Never shorten a bad opening: a clipped window is worse than
    // omitting an uncertain detection.
    const sx = entry.width_m > 0.1 ? (L / entry.width_m) : 1;
    const fh = entry.facade_height_m > 2 ? entry.facade_height_m : 0;
    const cap = fh || (simWallHeight > 2 ? simWallHeight : 0) || Infinity;
    const supportTriangles = buildFacadeWallSupport(wallTriangles, A, dx, dz, nx, nz);
    const scale = (arr) => (arr || [])
        .map((o) => ({
            u_m: Number(o.u_m) * sx,
            w_m: Number(o.w_m) * sx,
            sill_m: Number(o.sill_m),
            h_m: Number(o.h_m),
        }))
        .filter((o) => isFacadeOpeningFullyContained(o, L, cap, supportTriangles));

    const meshes = [];
    const win = buildMesh(scale(entry.windows), supportTriangles, glassMaterial());
    if (win) meshes.push(win);
    const door = buildMesh(scale(entry.doors), supportTriangles, doorMaterial());
    if (door) meshes.push(door);
    return meshes;
}

// EXPERIMENT: instead of synthesised glass quads, glue the actual rectified
// Street View facade photo onto the wall as one quad spanning the frontage
// (A→B) from ground to the eaves. Only sensible now that the rectification scale
// matches the LOD2 mesh (footprint-driven). Black warp-padding is keyed out so
// only the real building shows. Returns one mesh or null.
export function buildFacadePhotoMesh(objectId, anchorLat, anchorLon, centroidX, centroidZ) {
    const entry = dataMap && dataMap[String(objectId)];
    if (!entry || entry.facade_id == null) return null;
    const A = geoToLocal(entry.a_lonlat[0], entry.a_lonlat[1], anchorLon, anchorLat);
    const B = geoToLocal(entry.b_lonlat[0], entry.b_lonlat[1], anchorLon, anchorLat);
    const dirx = B.x - A.x, dirz = B.z - A.z;
    const L = Math.hypot(dirx, dirz);
    if (L < 0.5) return null;
    const dx = dirx / L, dz = dirz / L;
    let nx = dz, nz = -dx;
    const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
    if ((mx - centroidX) * nx + (mz - centroidZ) * nz < 0) { nx = -nx; nz = -nz; }
    const H = entry.facade_height_m > 2 ? entry.facade_height_m : 9;

    const px = nx * (FACADE_PHOTO_PROUD_M + 0.04);
    const pz = nz * (FACADE_PHOTO_PROUD_M + 0.04);
    const blx = A.x + px, blz = A.z + pz;
    const brx = A.x + dx * L + px, brz = A.z + dz * L + pz;
    const pos = [
        blx, 0, blz,  brx, 0, brz,  brx, H, brz,
        blx, 0, blz,  brx, H, brz,  blx, H, blz,
    ];
    const uv = [0, 0, 1, 0, 1, 1,  0, 0, 1, 1, 0, 1];   // ground=v0, eaves=v1 (texture flipY)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
        transparent: true, alphaTest: 0.05,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = false;
    loadFacadePhotoTexture(entry.facade_id).then((tex) => {
        if (tex) { mat.map = tex; mat.needsUpdate = true; }
    });
    return mesh;
}

// Load the facade image (prefer the SAM3-masked PNG → only the facade plane is
// opaque). If the server falls back to the plain JPG (no mask yet), key out the
// near-black warp-padding ourselves. Either way, sky/road/neighbours don't glue.
const _photoTexCache = new Map();
let _photoTextureGeneration = 0;

export function clearFacadePhotoTextureCache() {
    _photoTextureGeneration += 1;
    for (const texture of _photoTexCache.values()) {
        unregisterShared(texture);
        texture.dispose();
    }
    _photoTexCache.clear();
}

function loadFacadePhotoTexture(facadeId) {
    if (_photoTexCache.has(facadeId)) return Promise.resolve(_photoTexCache.get(facadeId));
    const requestGeneration = _photoTextureGeneration;
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0);
            let crop = null;   // {ox,oy,rx,ry} to stretch the facade bbox across the quad
            try {
                const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
                const W = c.width, H = c.height;
                // Does the image already carry a mask (transparent pixels)?
                let hasAlpha = false;
                for (let i = 3; i < p.length; i += 4) { if (p[i] < 250) { hasAlpha = true; break; } }
                if (!hasAlpha) {                                  // JPG fallback → key the black padding
                    for (let i = 0; i < p.length; i += 4) {
                        if (p[i] + p[i + 1] + p[i + 2] < 10) p[i + 3] = 0;
                    }
                    x.putImageData(d, 0, 0);
                }
                // The masked facade covers only part of the frame (the mask drops
                // sky/road/neighbours), so without this it lands as a small patch.
                // Find the opaque bounding box and remap it to fill the whole quad
                // in BOTH dimensions. Rows/cols need a few % opaque to count, so a
                // stray kept neighbour/foreground speck doesn't blow the box out.
                const colN = new Int32Array(W), rowN = new Int32Array(H);
                for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
                    if (p[(y * W + xx) * 4 + 3] > 128) { colN[xx]++; rowN[y]++; }
                }
                const cThr = H * 0.04, rThr = W * 0.04;
                let x0 = 0; while (x0 < W && colN[x0] < cThr) x0++;
                let x1 = W - 1; while (x1 > x0 && colN[x1] < cThr) x1--;
                let y0 = 0; while (y0 < H && rowN[y0] < rThr) y0++;
                let y1 = H - 1; while (y1 > y0 && rowN[y1] < rThr) y1--;
                if (x1 > x0 + 8 && y1 > y0 + 8) {
                    crop = { ox: x0 / W, rx: (x1 - x0) / W, oy: (H - 1 - y1) / H, ry: (y1 - y0) / H };
                }
            } catch (_) { /* tainted canvas (CORS) → use as-is */ }
            const tex = new THREE.CanvasTexture(c);
            if (crop) { tex.offset.set(crop.ox, crop.oy); tex.repeat.set(crop.rx, crop.ry); }  // flipY: oy uses bbox bottom
            tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
            if (requestGeneration !== _photoTextureGeneration) {
                tex.dispose();
                resolve(null);
                return;
            }
            registerShared(tex);
            _photoTexCache.set(facadeId, tex);
            resolve(tex);
        };
        img.onerror = () => resolve(null);
        img.src = `${getApiBase()}/building-facade/${facadeId}?masked=1&t=${Date.now()}`;
    });
}
