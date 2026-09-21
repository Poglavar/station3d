import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import {
    WATER_CUTOUT_RENDER_ORDER,
    WATER_LEVELS,
} from './ground-surface-levels.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    asSurfaceClaim,
    compileSurfaceClaim,
    requireSurfaceBackstopCutClaim,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';

// One texture still supplies the colour and one the surface normal, but the
// world repeat is broad enough that the pattern no longer reads as a 12 m
// carpet. Fine ripples are carried inside this larger seamless field.
export const WATER_TILE_M = 48.0;
export const WATER_UV_PER_M = 1 / WATER_TILE_M;
export const WATER_SHORE_WIDTH_M = 3.8;

export const WATER_MATERIAL_PROFILES = Object.freeze({
    sea: Object.freeze({
        color: 0x347fa3,
        normalScale: 0.30,
        roughness: 0.24,
        metalness: 0.02,
        emissive: 0x071820,
        emissiveIntensity: 0.035,
        envMapIntensity: 0.90,
    }),
    sheltered: Object.freeze({
        color: 0x3e8794,
        normalScale: 0.17,
        roughness: 0.31,
        metalness: 0.015,
        emissive: 0x071b20,
        emissiveIntensity: 0.04,
        envMapIntensity: 0.72,
    }),
    fountain: Object.freeze({
        color: 0x58a9c2,
        normalScale: 0.38,
        roughness: 0.17,
        metalness: 0.02,
        emissive: 0x0a2530,
        emissiveIntensity: 0.07,
        envMapIntensity: 0.98,
    }),
});

let waterTexture = null;
let waterNormalTexture = null;
let waterShoreTexture = null;
let waterGroundCutoutMaterial = null;
const WATER_GROUND_CUTOUT_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.WATER_CUTOUT,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ownerId: 'water-ground-cutout',
    sourceId: 'world/water-material.js',
    replacementBackstopReady: true,
    paintsColor: false,
    cutsBackstop: true,
});
const WATER_CUTOUT_TARGET_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    supportReady: true,
});

function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

const TAU = Math.PI * 2;

function fract(v) {
    return v - Math.floor(v);
}

function smoothstep01(v) {
    return v * v * (3 - 2 * v);
}

function mix(a, b, t) {
    return a + (b - a) * t;
}

// Integer-period value noise gives the generated canvas a genuinely seamless
// boundary. The previous fractional sine frequencies disagreed at the edges,
// producing a faint grid even before the short repeat became noticeable.
function periodicLatticeValue(x, y, cells, seed) {
    const xx = ((x % cells) + cells) % cells;
    const yy = ((y % cells) + cells) % cells;
    let h = Math.imul(xx + 0x6d2b79f5, 0x1b873593);
    h ^= Math.imul(yy + seed * 1013, 0x85ebca6b);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function periodicValueNoise(u, v, cells, seed) {
    const x = fract(u) * cells;
    const y = fract(v) * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smoothstep01(x - x0);
    const ty = smoothstep01(y - y0);
    const a = periodicLatticeValue(x0, y0, cells, seed);
    const b = periodicLatticeValue(x0 + 1, y0, cells, seed);
    const c = periodicLatticeValue(x0, y0 + 1, cells, seed);
    const d = periodicLatticeValue(x0 + 1, y0 + 1, cells, seed);
    return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

export function sampleWaterSurfacePattern(u, v) {
    const uu = fract(u);
    const vv = fract(v);
    const broad = periodicValueNoise(uu, vv, 3, 17) * 0.52
        + periodicValueNoise(uu, vv, 7, 43) * 0.31
        + periodicValueNoise(uu, vv, 13, 89) * 0.17;
    const warpedU = uu + periodicValueNoise(uu, vv, 4, 29) * 0.020;
    const warpedV = vv + periodicValueNoise(uu, vv, 5, 61) * 0.020;
    const brokenSwell = Math.sin(TAU * (
        11 * warpedU + 3 * warpedV
        + periodicValueNoise(uu, vv, 7, 151) * 0.20
    ) + 0.4);
    const height = (
        periodicValueNoise(warpedU, warpedV, 12, 71) * 0.38
        + periodicValueNoise(warpedU, warpedV, 23, 107) * 0.30
        + periodicValueNoise(warpedU, warpedV, 41, 137) * 0.20
        + brokenSwell * 0.12
    );
    return { tint: broad, height };
}

function paintWaterPattern(ctx, size, asHeight) {
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size;
            const v = y / size;
            const sample = sampleWaterSurfacePattern(u, v);
            const i = (y * size + x) * 4;
            if (asHeight) {
                const h = clampByte(128 + sample.height * 46);
                data[i + 0] = h;
                data[i + 1] = h;
                data[i + 2] = h;
            } else {
                // Keep the map close to neutral: material colour and scene
                // lighting now create the water colour and highlights. The map
                // contributes only broad, low-contrast depth variation.
                const t = Math.max(0, Math.min(1, sample.tint * 0.5 + 0.5));
                data[i + 0] = clampByte(210 + t * 24);
                data[i + 1] = clampByte(220 + t * 22);
                data[i + 2] = clampByte(224 + t * 24);
            }
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}

function heightCanvasToNormalCanvas(heightCanvas, size) {
    const heightData = heightCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
    const sample = (x, y) => {
        const xx = ((x % size) + size) % size;
        const yy = ((y % size) + size) % size;
        return heightData[(yy * size + xx) * 4] / 255;
    };
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = size;
    normalCanvas.height = size;
    const nctx = normalCanvas.getContext('2d');
    const out = nctx.createImageData(size, size);
    const od = out.data;
    const strength = 4.6;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
            const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
            const len = Math.sqrt(dx * dx + dy * dy + 1);
            const nx = -dx / len;
            const ny = -dy / len;
            const nz = 1 / len;
            const i = (y * size + x) * 4;
            od[i + 0] = Math.round((nx * 0.5 + 0.5) * 255);
            od[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            od[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            od[i + 3] = 255;
        }
    }
    nctx.putImageData(out, 0, 0);
    return normalCanvas;
}

// Water textures are deliberately procedural, but generating the colour,
// height and normal fields synchronously costs a full frame on first use.
// Streaming builders can prepare the shared textures cooperatively and leave
// createWaterMaterial() synchronous for all subsequent callers.
export async function prepareWaterMaterialResourcesCooperatively(options = {}) {
    if (waterTexture && waterNormalTexture) return true;
    const size = 256;
    const rowsPerChunk = Math.max(1, Math.min(
        size,
        Math.floor(Number(options.rowsPerChunk) || 8),
    ));
    const onChunk = typeof options.onChunk === 'function'
        ? options.onChunk
        : null;
    const continueAfterChunk = async (phase) => (
        !onChunk || (await onChunk(phase)) !== false
    );

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = colorCanvas.height = size;
    const colorContext = colorCanvas.getContext('2d');
    const colorImage = colorContext.createImageData(size, size);
    const colorData = colorImage.data;
    const heightData = new Uint8ClampedArray(size * size);
    for (let startY = 0; startY < size; startY += rowsPerChunk) {
        const endY = Math.min(size, startY + rowsPerChunk);
        for (let y = startY; y < endY; y++) {
            for (let x = 0; x < size; x++) {
                const sample = sampleWaterSurfacePattern(x / size, y / size);
                const pixel = y * size + x;
                const offset = pixel * 4;
                const tint = Math.max(0, Math.min(1, sample.tint * 0.5 + 0.5));
                colorData[offset + 0] = clampByte(210 + tint * 24);
                colorData[offset + 1] = clampByte(220 + tint * 22);
                colorData[offset + 2] = clampByte(224 + tint * 24);
                colorData[offset + 3] = 255;
                heightData[pixel] = clampByte(128 + sample.height * 46);
            }
        }
        if (!(await continueAfterChunk('pattern'))) return false;
        // Another first-use path may have completed while this cooperative
        // builder yielded. Do not replace shared resources in that case.
        if (waterTexture && waterNormalTexture) return true;
    }
    colorContext.putImageData(colorImage, 0, 0);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = size;
    const normalContext = normalCanvas.getContext('2d');
    const normalImage = normalContext.createImageData(size, size);
    const normalData = normalImage.data;
    const sampleHeight = (x, y) => {
        const xx = ((x % size) + size) % size;
        const yy = ((y % size) + size) % size;
        return heightData[yy * size + xx] / 255;
    };
    const strength = 4.6;
    for (let startY = 0; startY < size; startY += rowsPerChunk) {
        const endY = Math.min(size, startY + rowsPerChunk);
        for (let y = startY; y < endY; y++) {
            for (let x = 0; x < size; x++) {
                const dx = (sampleHeight(x + 1, y) - sampleHeight(x - 1, y)) * strength;
                const dy = (sampleHeight(x, y + 1) - sampleHeight(x, y - 1)) * strength;
                const length = Math.sqrt(dx * dx + dy * dy + 1);
                const offset = (y * size + x) * 4;
                normalData[offset + 0] = Math.round((-dx / length * 0.5 + 0.5) * 255);
                normalData[offset + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255);
                normalData[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
                normalData[offset + 3] = 255;
            }
        }
        if (!(await continueAfterChunk('normal'))) return false;
        if (waterTexture && waterNormalTexture) return true;
    }
    normalContext.putImageData(normalImage, 0, 0);

    if (!waterTexture) {
        waterTexture = new THREE.CanvasTexture(colorCanvas);
        waterTexture.wrapS = THREE.RepeatWrapping;
        waterTexture.wrapT = THREE.RepeatWrapping;
        waterTexture.colorSpace = THREE.SRGBColorSpace;
        waterTexture.anisotropy = 4;
        waterTexture.minFilter = THREE.LinearMipmapLinearFilter;
        waterTexture.magFilter = THREE.LinearFilter;
        waterTexture.generateMipmaps = true;
        registerShared(waterTexture);
    }
    if (!waterNormalTexture) {
        waterNormalTexture = new THREE.CanvasTexture(normalCanvas);
        waterNormalTexture.wrapS = THREE.RepeatWrapping;
        waterNormalTexture.wrapT = THREE.RepeatWrapping;
        waterNormalTexture.colorSpace = THREE.LinearSRGBColorSpace;
        waterNormalTexture.anisotropy = 4;
        waterNormalTexture.minFilter = THREE.LinearMipmapLinearFilter;
        waterNormalTexture.magFilter = THREE.LinearFilter;
        waterNormalTexture.generateMipmaps = true;
        registerShared(waterNormalTexture);
    }
    return true;
}

function getWaterTexture() {
    if (waterTexture) return waterTexture;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    paintWaterPattern(canvas.getContext('2d', { willReadFrequently: true }), size, false);
    waterTexture = new THREE.CanvasTexture(canvas);
    waterTexture.wrapS = THREE.RepeatWrapping;
    waterTexture.wrapT = THREE.RepeatWrapping;
    waterTexture.colorSpace = THREE.SRGBColorSpace;
    waterTexture.anisotropy = 4;
    waterTexture.minFilter = THREE.LinearMipmapLinearFilter;
    waterTexture.magFilter = THREE.LinearFilter;
    waterTexture.generateMipmaps = true;
    registerShared(waterTexture);
    return waterTexture;
}

function getWaterNormalTexture() {
    if (waterNormalTexture) return waterNormalTexture;
    const size = 256;
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = heightCanvas.height = size;
    paintWaterPattern(heightCanvas.getContext('2d', { willReadFrequently: true }), size, true);
    const normalCanvas = heightCanvasToNormalCanvas(heightCanvas, size);
    waterNormalTexture = new THREE.CanvasTexture(normalCanvas);
    waterNormalTexture.wrapS = THREE.RepeatWrapping;
    waterNormalTexture.wrapT = THREE.RepeatWrapping;
    waterNormalTexture.colorSpace = THREE.LinearSRGBColorSpace;
    waterNormalTexture.anisotropy = 4;
    waterNormalTexture.minFilter = THREE.LinearMipmapLinearFilter;
    waterNormalTexture.magFilter = THREE.LinearFilter;
    waterNormalTexture.generateMipmaps = true;
    registerShared(waterNormalTexture);
    return waterNormalTexture;
}

function getWaterShoreTexture() {
    if (waterShoreTexture) return waterShoreTexture;
    const width = 32;
    const height = 256;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0.00, 'rgba(232, 255, 247, 0.70)');
    grad.addColorStop(0.08, 'rgba(212, 248, 239, 0.42)');
    grad.addColorStop(0.18, 'rgba(180, 236, 228, 0.22)');
    grad.addColorStop(0.45, 'rgba(120, 188, 205, 0.08)');
    grad.addColorStop(1.00, 'rgba(120, 188, 205, 0.00)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.36)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 2.5);
    ctx.lineTo(width, 2.5);
    ctx.stroke();
    waterShoreTexture = new THREE.CanvasTexture(canvas);
    waterShoreTexture.wrapS = THREE.RepeatWrapping;
    waterShoreTexture.wrapT = THREE.ClampToEdgeWrapping;
    waterShoreTexture.colorSpace = THREE.SRGBColorSpace;
    waterShoreTexture.anisotropy = 4;
    waterShoreTexture.minFilter = THREE.LinearMipmapLinearFilter;
    waterShoreTexture.magFilter = THREE.LinearFilter;
    waterShoreTexture.generateMipmaps = true;
    registerShared(waterShoreTexture);
    return waterShoreTexture;
}

function signedRingAreaXZ(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j];
        const b = ring[i];
        area += a.x * b.z - b.x * a.z;
    }
    return area * 0.5;
}

function computeRingInset(ring, width, intoPolygon) {
    const count = ring.length;
    if (count < 3) return null;
    const area = signedRingAreaXZ(ring);
    const side = (area >= 0 ? 1 : -1) * (intoPolygon ? 1 : -1);
    const edgeNormals = new Array(count);
    for (let i = 0; i < count; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % count];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1e-4) {
            edgeNormals[i] = { x: 0, z: 0 };
            continue;
        }
        edgeNormals[i] = {
            x: (-dz / len) * side,
            z: (dx / len) * side,
        };
    }
    const inner = new Array(count);
    for (let i = 0; i < count; i++) {
        const prev = edgeNormals[(i - 1 + count) % count];
        const next = edgeNormals[i];
        let nx = prev.x + next.x;
        let nz = prev.z + next.z;
        let nLen = Math.sqrt(nx * nx + nz * nz);
        if (nLen < 1e-4) {
            nx = next.x;
            nz = next.z;
            nLen = Math.sqrt(nx * nx + nz * nz) || 1;
        }
        nx /= nLen;
        nz /= nLen;
        const denom = Math.max(0.45, nx * next.x + nz * next.z);
        const miter = Math.min(width * 2.2, width / denom);
        inner[i] = {
            x: ring[i].x + nx * miter,
            z: ring[i].z + nz * miter,
        };
    }
    return inner;
}

function appendRingShore(ring, y, width, intoPolygon, positions, uvs) {
    const inner = computeRingInset(ring, width, intoPolygon);
    if (!inner) return;
    const count = ring.length;
    let u = 0;
    for (let i = 0; i < count; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % count];
        const ai = inner[i];
        const bi = inner[(i + 1) % count];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.05) continue;
        const uNext = u + len / 6;
        positions.push(
            a.x, y, a.z,
            b.x, y, b.z,
            bi.x, y, bi.z,
            a.x, y, a.z,
            bi.x, y, bi.z,
            ai.x, y, ai.z,
        );
        uvs.push(
            u, 0,
            uNext, 0,
            uNext, 1,
            u, 0,
            uNext, 1,
            u, 1,
        );
        u = uNext;
    }
}

export function applyWorldXZWaterUvs(geometry, uvPerM = WATER_UV_PER_M, { originX = 0, originZ = 0 } = {}) {
    const pos = geometry && geometry.getAttribute('position');
    if (!pos) return;
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
        uvs[i * 2 + 0] = (pos.getX(i) + originX) * uvPerM;
        uvs[i * 2 + 1] = (pos.getZ(i) + originZ) * uvPerM;
    }
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
}

export function createWaterMaterial(options = {}) {
    const {
        profile = 'sea',
        normalScale: requestedNormalScale,
        ...rest
    } = options;
    const defaults = WATER_MATERIAL_PROFILES[profile] || WATER_MATERIAL_PROFILES.sea;
    const normalScale = requestedNormalScale ?? defaults.normalScale;
    const material = new THREE.MeshStandardMaterial({
        ...defaults,
        map: getWaterTexture(),
        normalMap: getWaterNormalTexture(),
        normalScale: normalScale?.isVector2
            ? normalScale.clone()
            : new THREE.Vector2(normalScale, normalScale),
        ...rest,
    });
    material.userData.waterProfile = WATER_MATERIAL_PROFILES[profile] ? profile : 'sea';
    return material;
}

export function createWaterShoreMaterial(options = {}) {
    const { color = 0x8fe0d3, opacity = 0.72, ...rest } = options;
    return new THREE.MeshBasicMaterial({
        color,
        map: getWaterShoreTexture(),
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        ...rest,
    });
}

export function createWaterBankMaterial(options = {}) {
    const { color = 0xffffff, roughness = 0.98, ...rest } = options;
    return new THREE.MeshStandardMaterial({
        color,
        roughness,
        vertexColors: true,
        side: THREE.DoubleSide,
        ...rest,
    });
}

function getWaterGroundCutoutMaterial() {
    if (waterGroundCutoutMaterial) return waterGroundCutoutMaterial;
    waterGroundCutoutMaterial = applySurfaceStencil(new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        toneMapped: false,
    }), WATER_GROUND_CUTOUT_CLAIM);
    registerShared(waterGroundCutoutMaterial);
    return waterGroundCutoutMaterial;
}

// Clone a triangulated water surface at catch-all-ground height. It renders
// before the ground and writes only the shared surface-ownership stencil bit,
// so arbitrary lakes/rivers can reveal water below y=0 without maintaining a
// second world-anchored raster mask.
export function createWaterGroundCutoutMesh(surfaceGeometry, options = {}) {
    if (!surfaceGeometry || typeof surfaceGeometry.clone !== 'function') return null;
    const replacementClaim = asSurfaceClaim(options.replacementClaim);
    if (replacementClaim.surfaceClass !== SURFACE_CLASS.WATER) {
        throw new Error('Water ground cutout requires its published water replacement claim');
    }
    requireSurfaceBackstopCutClaim(replacementClaim, WATER_CUTOUT_TARGET_CLAIM, {
        operation: 'water ground cutout publication',
    });
    const geometry = surfaceGeometry.clone();
    const position = geometry.getAttribute('position');
    if (!position) {
        geometry.dispose();
        return null;
    }
    const y = Number.isFinite(options.y) ? options.y : WATER_LEVELS.cutout;
    for (let i = 0; i < position.count; i++) position.setY(i, y);
    position.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, getWaterGroundCutoutMaterial());
    mesh.name = options.name || 'WaterGroundCutout';
    mesh.renderOrder = WATER_CUTOUT_RENDER_ORDER;
    mesh.userData.waterGroundCutout = true;
    markSurfaceClaim(mesh, reviseSurfaceClaim(WATER_GROUND_CUTOUT_CLAIM, {
        ownerId: options.ownerId || replacementClaim.ownerId || 'water-ground-cutout',
        replacementKey: replacementClaim.replacementKey,
        generation: replacementClaim.generation,
        replacementBackstopReady: true,
    }));
    return mesh;
}

function effectiveRingLength(ring) {
    if (!Array.isArray(ring)) return 0;
    const count = ring.length;
    if (count < 2) return count;
    const first = ring[0];
    const last = ring[count - 1];
    return Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.z - last.z) < 1e-6
        ? count - 1
        : count;
}

function appendRingBank(ring, waterY, topY, positions, colors) {
    const count = effectiveRingLength(ring);
    if (count < 3) return;
    const topColor = new THREE.Color(0x796f5a);
    const bottomColor = new THREE.Color(0x39484a);
    const pushTopColor = () => colors.push(topColor.r, topColor.g, topColor.b);
    const pushBottomColor = () => colors.push(bottomColor.r, bottomColor.g, bottomColor.b);
    for (let i = 0; i < count; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % count];
        if (Math.hypot(b.x - a.x, b.z - a.z) < 0.02) continue;
        positions.push(
            a.x, topY, a.z,
            b.x, topY, b.z,
            b.x, waterY, b.z,
            a.x, topY, a.z,
            b.x, waterY, b.z,
            a.x, waterY, a.z,
        );
        pushTopColor();
        pushTopColor();
        pushBottomColor();
        pushTopColor();
        pushBottomColor();
        pushBottomColor();
    }
}

// Vertical natural bank faces close the otherwise visible gap between the
// zero-thickness ground plane and a recessed water surface. Hole rings get
// banks too, so islands remain solid instead of exposing their underside.
export function buildWaterBankGeometry(
    outerRing,
    holeRings = [],
    waterY = WATER_LEVELS.inland,
    topY = WATER_LEVELS.naturalBankTop,
    { computeNormals = true } = {},
) {
    if (!(topY > waterY)) return null;
    const positions = [];
    const colors = [];
    appendRingBank(outerRing, waterY, topY, positions, colors);
    for (const hole of holeRings || []) appendRingBank(hole, waterY, topY, positions, colors);
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 3));
    if (computeNormals) geometry.computeVertexNormals();
    return geometry;
}

export function buildWaterShoreGeometry(
    outerRing,
    holeRings = [],
    y = 0,
    width = WATER_SHORE_WIDTH_M,
    lift = 0.004,
    { computeNormals = true } = {},
) {
    const positions = [];
    const uvs = [];
    if (Array.isArray(outerRing) && outerRing.length >= 3) {
        appendRingShore(outerRing, y + lift, width, true, positions, uvs);
    }
    for (const hole of holeRings || []) {
        if (!Array.isArray(hole) || hole.length < 3) continue;
        appendRingShore(hole, y + lift, width, false, positions, uvs);
    }
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(uvs), 2));
    if (computeNormals) geometry.computeVertexNormals();
    return geometry;
}

export function animateWaterMaterials(materials, timeSec) {
    const animatedMaps = new Set();
    const animatedNormals = new Set();
    for (const mat of materials) {
        if (!mat) continue;
        if (mat.map && !animatedMaps.has(mat.map)) {
            animatedMaps.add(mat.map);
            mat.map.offset.x = timeSec * 0.0025;
            mat.map.offset.y = -timeSec * 0.0015;
        }
        if (mat.normalMap && !animatedNormals.has(mat.normalMap)) {
            animatedNormals.add(mat.normalMap);
            mat.normalMap.offset.x = -timeSec * 0.0040;
            mat.normalMap.offset.y = timeSec * 0.00275;
        }
    }
}
