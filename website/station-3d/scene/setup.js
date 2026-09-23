// Three.js bootstrap. Creates the scene, camera, renderer, orbit controls and a
// small set of always-present scene objects (ground, station marker for static
// mode, radius ring, north arrow). Exported symbols are live ES-module bindings
// — importers must not read them before initScene() has run.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { registerShared } from '../core/dispose.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { createCachedShadowMap } from '../core/cached-shadow-map.js';
import { createProgramGroupedOpaqueSort, rendererProgramLookup } from '../core/opaque-sort.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { applyStreetLampSurfaceLighting } from '../world/streetlamp-lighting.js';
import { applyPlannerSurfaceCutout } from '../world/planner-surface-cutout.js';
import { GROUND_STENCIL_READER_RENDER_ORDER } from '../world/ground-surface-levels.js';
import { applySurfaceStencil } from '../world/surface-material-authority.js';
import {
    createAutoDprGovernor,
    normalizeQualityMode,
    probeQualityProfile,
    resolveQualityProfile,
} from '../core/quality-profile.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    asSurfaceClaim,
    compileSurfaceClaim,
    requireSurfaceBackstopCutClaim,
    surfaceClaimMayReceiveGroundHole,
} from '../core/surface-hierarchy.js';

export const BUILDING_RADIUS_M = 100;
export const GROUND_SIZE = 2000;

export let scene;
export let camera;
export let renderer;
export let controls;
export let groundMesh;

// ─── Ground hole mask ───────────────────────────────────────────────────────
// World-anchored coastline ownership mask. Red removes the original terrain;
// green reveals mapped water. The channels coincide over OSM water but red
// also covers the generated land-side transition, allowing that replacement
// to own the coast without making the sea itself render inland. Uniform-driven
// so toggling never recompiles; the 1×1 black fallback keeps sampling valid.
const groundHoleFallbackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
groundHoleFallbackTex.needsUpdate = true;
const groundHoleUniforms = {
    uGroundHoleMask: { value: groundHoleFallbackTex },
    uGroundHoleCenter: { value: new THREE.Vector2(0, 0) },
    uGroundHoleHalfSize: { value: 1 },
    uGroundHoleEnabled: { value: 0 },
};
const GROUND_HOLE_TARGET_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    supportReady: true,
});

// texture covers world XZ square [centerX ± halfSizeM] × [centerZ ± halfSizeM];
// texel row 0 = north edge (z = centerZ − halfSizeM), so build it with
// flipY = false and py growing southward.
export function setGroundHoleMask(texture, centerX, centerZ, halfSizeM, sourceClaim) {
    requireSurfaceBackstopCutClaim(sourceClaim, GROUND_HOLE_TARGET_CLAIM, {
        operation: 'ground-hole mask publication',
    });
    groundHoleUniforms.uGroundHoleMask.value = texture || groundHoleFallbackTex;
    groundHoleUniforms.uGroundHoleCenter.value.set(centerX, centerZ);
    groundHoleUniforms.uGroundHoleHalfSize.value = Math.max(1, halfSizeM);
    groundHoleUniforms.uGroundHoleEnabled.value = texture ? 1 : 0;
}

export function clearGroundHoleMask() {
    groundHoleUniforms.uGroundHoleMask.value = groundHoleFallbackTex;
    groundHoleUniforms.uGroundHoleEnabled.value = 0;
}

// Adds the sea's world-space hole mask to any catch-all ground material. The
// hook composes with the planner/streetlamp shader hooks, so the streamed DTM
// surface and the historical sliding plane obey the exact same coastline cut.
export function applyGroundHoleMask(material, targetClaim) {
    if (!material) return material;
    const claim = asSurfaceClaim(targetClaim);
    if (!surfaceClaimMayReceiveGroundHole(claim)) {
        material.userData ||= {};
        material.userData.groundHoleMaskRejected = true;
        return material;
    }
    if (material.userData.groundHoleMask) return material;
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, groundHoleUniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vGroundHoleWorldPos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundHoleWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vGroundHoleWorldPos;',
                'uniform sampler2D uGroundHoleMask;',
                'uniform vec2 uGroundHoleCenter;',
                'uniform float uGroundHoleHalfSize;',
                'uniform float uGroundHoleEnabled;',
            ].join('\n'))
            .replace('#include <clipping_planes_fragment>', [
                '#ifndef ST3D_PLANNER_GEOMETRY_CUTOUTS',
                'if (uGroundHoleEnabled > 0.5) {',
                '    vec2 groundHoleAbsoluteXZ = vGroundHoleWorldPos.xz + uRenderOriginXZ;',
                '    vec2 holeUv = (groundHoleAbsoluteXZ - uGroundHoleCenter) / (2.0 * uGroundHoleHalfSize) + 0.5;',
                '    if (holeUv.x >= 0.0 && holeUv.x <= 1.0 && holeUv.y >= 0.0 && holeUv.y <= 1.0) {',
                '        if (texture2D(uGroundHoleMask, holeUv).r > 0.5) discard;',
                '    }',
                '}',
                '#endif',
                '#include <clipping_planes_fragment>',
            ].join('\n'));
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|ground-hole-mask-v3`;
    };
    material.userData.groundHoleMask = true;
    material.needsUpdate = true;
    return material;
}

// Inverse companion for the sea surface itself. The old sea was a catch-all
// plane beneath the entire city and depended on opaque terrain to hide its
// inland pixels; any civil-engineering cut therefore exposed a fake blue
// canal. Sampling the same ownership mask here makes water render only where
// the ground was intentionally opened for mapped water.
export function applyGroundWaterMask(material, waterClaim) {
    if (!material) return material;
    const claim = asSurfaceClaim(waterClaim);
    if (claim.surfaceClass !== SURFACE_CLASS.WATER
        || claim.coverageState !== SURFACE_COVERAGE_STATE.PUBLISHED) {
        throw new Error('Ground-water mask requires a published water surface claim');
    }
    material.userData ||= {};
    material.userData.surfaceClaim = claim;
    if (material.userData.groundWaterMask) return material;
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, groundHoleUniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWaterWorldPos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundWaterWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vGroundWaterWorldPos;',
                'uniform sampler2D uGroundHoleMask;',
                'uniform vec2 uGroundHoleCenter;',
                'uniform float uGroundHoleHalfSize;',
                'uniform float uGroundHoleEnabled;',
            ].join('\n'))
            .replace('#include <clipping_planes_fragment>', [
                'if (uGroundHoleEnabled < 0.5) discard;',
                'vec2 groundWaterAbsoluteXZ = vGroundWaterWorldPos.xz + uRenderOriginXZ;',
                'vec2 waterUv = (groundWaterAbsoluteXZ - uGroundHoleCenter)',
                '    / (2.0 * uGroundHoleHalfSize) + 0.5;',
                'if (waterUv.x < 0.0 || waterUv.x > 1.0 || waterUv.y < 0.0 || waterUv.y > 1.0) discard;',
                'if (texture2D(uGroundHoleMask, waterUv).g <= 0.5) discard;',
                '#include <clipping_planes_fragment>',
            ].join('\n'));
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|ground-water-mask-v3`;
    };
    material.userData.groundWaterMask = true;
    material.needsUpdate = true;
    return material;
}
export let ringMesh;
export let northArrowMesh;
export let stationMarker;
export let sun;              // DirectionalLight at a fixed east-south-high angle, matching r128 prod
let shadowCache = null;      // static/dynamic cached sun shadow map (core/cached-shadow-map.js)
export let fill;             // DirectionalLight from opposite of sun — adds detail to shaded walls; no shadow
export let ambient;          // AmbientLight, fixed intensity, matching r128 prod
// Default building material used when a DGU type code has no specific colour.
// Shared across all buildings so it's registered as shared and never disposed.
export let buildingMaterial;

let resizeHandler = null;
let resizeBound = false;
let containerEl = null;
let qualitySelection = resolveQualityProfile('auto');
let qualityGovernor = null;
let rendererAntialias = null;

function browserDevicePixelRatio() {
    return Math.max(0.5, Number(
        (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    ) || 1);
}

function qualityTargetDpr() {
    const cap = qualitySelection.auto
        ? qualityGovernor?.snapshot?.().dpr ?? qualitySelection.profile.dprCap
        : qualitySelection.profile.dprCap;
    return Math.min(browserDevicePixelRatio(), cap);
}

export function getShadowCacheSnapshot() {
    return shadowCache?.snapshot() || null;
}

export function setShadowCacheEnabled(enabled) {
    shadowCache?.setEnabled(enabled);
}

export function probeWebGlQualityCapabilities() {
    if (typeof document === 'undefined') return {};
    let gl = null;
    try {
        const canvas = document.createElement('canvas');
        // Match the real renderer's hard requirements. Three r184 no longer
        // supports WebGL 1, and Station3D's surface ownership needs stencil.
        gl = canvas.getContext('webgl2', {
            antialias: false,
            depth: true,
            stencil: true,
            preserveDrawingBuffer: false,
        });
        return {
            webglAvailable: !!gl,
            maxTextureSize: Number(gl?.getParameter?.(gl.MAX_TEXTURE_SIZE)) || 0,
            maxSamples: gl?.MAX_SAMPLES
                ? Number(gl.getParameter(gl.MAX_SAMPLES)) || 0
                : 0,
            maxRenderbufferSize: Number(gl?.getParameter?.(gl.MAX_RENDERBUFFER_SIZE)) || 0,
            stencilBits: gl ? Number(gl.getParameter(gl.STENCIL_BITS)) || 0 : null,
            deviceMemoryGb: Number(globalThis.navigator?.deviceMemory) || 0,
            hardwareConcurrency: Number(globalThis.navigator?.hardwareConcurrency) || 0,
            mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(
                String(globalThis.navigator?.userAgent || ''),
            ),
            webgl2: !!gl,
        };
    } catch (_error) {
        return {
            webglAvailable: false,
            webgl2: false,
            deviceMemoryGb: Number(globalThis.navigator?.deviceMemory) || 0,
            hardwareConcurrency: Number(globalThis.navigator?.hardwareConcurrency) || 0,
        };
    } finally {
        gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    }
}

function createQualityGovernor(selection) {
    if (!selection.auto) return null;
    return createAutoDprGovernor({
        initialDpr: Math.min(browserDevicePixelRatio(), selection.profile.dprCap),
        minDpr: selection.profile.minAutoDpr,
        maxDpr: selection.profile.dprCap,
    });
}

function applyShadowQuality() {
    if (!sun) return;
    const profile = qualitySelection.profile;
    const distance = profile.shadowCasterDistanceM;
    sun.shadow.camera.top = distance;
    sun.shadow.camera.bottom = -distance;
    sun.shadow.camera.left = -distance;
    sun.shadow.camera.right = distance;
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    sun.shadow.map?.dispose?.();
    sun.shadow.map = null;
    sun.shadow.camera.updateProjectionMatrix?.();
    sun.shadow.needsUpdate = true;
}

export function resizeScene() {
    if (!renderer || !camera || !containerEl) return false;
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    if (width <= 0 || height <= 0) return false;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(qualityTargetDpr());
    renderer.setSize(width, height);
    return true;
}

function applyQualityToLiveRenderer() {
    if (!renderer) return;
    applyShadowQuality();
    resizeScene();
}

export function configureRenderQuality(modeValue, capabilities = null) {
    const mode = normalizeQualityMode(modeValue, null);
    if (!mode) return false;
    qualitySelection = resolveQualityProfile(
        mode,
        capabilities || probeWebGlQualityCapabilities(),
    );
    qualityGovernor = createQualityGovernor(qualitySelection);
    applyQualityToLiveRenderer();
    return getRenderQualityContext();
}

export function observeRenderQualitySample(sample) {
    if (!qualitySelection.auto || !qualityGovernor || !renderer) {
        return { changed: false, dpr: qualityTargetDpr(), reason: 'fixed-profile' };
    }
    const result = qualityGovernor.observe(sample);
    if (result.changed) resizeScene();
    return result;
}

export function getThinFeatureDistanceM() {
    return qualitySelection.profile.thinFeatureDistanceM;
}

export function getRenderQualityContext() {
    const profile = qualitySelection.profile;
    const actualAntialias = rendererAntialias == null
        ? profile.antialias
        : rendererAntialias;
    return {
        requestedMode: qualitySelection.requestedMode,
        profileId: qualitySelection.profileId,
        auto: qualitySelection.auto,
        dpr: renderer?.getPixelRatio?.() || qualityTargetDpr(),
        dprCap: profile.dprCap,
        antialias: actualAntialias,
        requestedAntialias: profile.antialias,
        reloadRequired: rendererAntialias != null && actualAntialias !== profile.antialias,
        shadowMapSize: profile.shadowMapSize,
        shadowCasterDistanceM: profile.shadowCasterDistanceM,
        thinFeatureDistanceM: profile.thinFeatureDistanceM,
        capabilityProfileId: probeQualityProfile(qualitySelection.capabilities),
        capabilities: { ...qualitySelection.capabilities },
        compatibility: qualitySelection.compatibility,
        autoGovernor: qualityGovernor?.snapshot?.() || null,
    };
}

export function bindSceneResize() {
    if (resizeBound || !resizeHandler || typeof window === 'undefined') return false;
    window.addEventListener('resize', resizeHandler);
    resizeBound = true;
    return true;
}

export function unbindSceneResize() {
    if (!resizeBound || !resizeHandler || typeof window === 'undefined') return false;
    window.removeEventListener('resize', resizeHandler);
    resizeBound = false;
    return true;
}

// ─── Render grades ─────────────────────────────────────────────────────────
// 'aces'    — filmic look: ACES tone mapping + explicit sRGB output. Highlights
//             roll off instead of clipping per-channel; the whole scene reads
//             more photographic. Default.
// 'classic' — the historical r128-matched look: raw linear values written to
//             the framebuffer (monitor implicitly gamma-decodes them, which
//             made hex colours appear richer / more saturated than the hex
//             would suggest) and no tone mapping, so bright values clip
//             per-channel. Kept as a live A/B reference.
// Both grades share the same light intensities; only renderer output settings
// and exposure differ. Toggle at runtime via window.Station3D.setGrade().
const RENDER_GRADES = {
    aces: {
        toneMapping: THREE.ACESFilmicToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
        // Tuned visually against the Zrinjevac / centre street scene: 1.0
        // blows out pavement whites, 0.72 loses the sunny feel.
        exposure: 0.85,
    },
    classic: {
        toneMapping: THREE.NoToneMapping,
        outputColorSpace: THREE.LinearSRGBColorSpace,
        exposure: 1.0,
    },
};

export let renderGrade = 'aces';

// Applies a grade's renderer settings. Callable before initScene() — then it
// only selects the grade the renderer will be created with. Note: switching
// to/from 'classic' at runtime is an approximate A/B (ColorManagement is a
// load-time flag set in index.js); reload with ?grade3d=classic for the exact
// legacy look.
export function applyRenderGrade(name, exposureOverride) {
    const grade = RENDER_GRADES[name];
    if (!grade) return false;
    renderGrade = name;
    if (!renderer) return true;
    renderer.toneMapping = grade.toneMapping;
    renderer.outputColorSpace = grade.outputColorSpace;
    renderer.toneMappingExposure = exposureOverride != null ? exposureOverride : grade.exposure;
    return true;
}

function createRenderer(options) {
    // Test hook: browser ES module imports cannot be replaced through window.THREE.
    const override = typeof window !== 'undefined' && window.__Station3DWebGLRenderer;
    return typeof override === 'function'
        ? new override(options)
        : new THREE.WebGLRenderer(options);
}

function getRendererPixelRatio() {
    return qualityTargetDpr();
}

export function getContainer() {
    return containerEl;
}

export function getResizeHandler() {
    return resizeHandler;
}

// One-tile size for the procedural concrete texture. Same scale as the
// asphalt UVs (16 m per repeat) so surface noise reads at a comparable grain
// across road and non-road areas, and the tile is big enough to carry
// macro wear (cracks, stains, tonal patches) without visible repetition.
export const SIDEWALK_TILE_M = 16.0;
export const SIDEWALK_UV_PER_M = 1 / SIDEWALK_TILE_M;

// Wear tuning for the sidewalk/concrete tile — counts per 16×16 m tile.
// Clearly worn, but still a notch lighter than the roadbed (no repair
// patches or potholes here).
const SIDEWALK_WEAR = {
    tonePatches: 9,
    cracks: 8,
    stains: 9,
};

let _sidewalkTexture = null;

// Procedurally-generated concrete-paver "sidewalk" texture used for the
// catch-all ground mesh and OSM `paving` landuse polygons. Warm beige
// base + per-pixel jitter + scattered darker stains and lighter wear
// patches. The colour is intentionally warm (R>G>B) rather than neutral
// grey so it stays visually distinct from cool asphalt grey even when
// shadowed by buildings — pure-grey sidewalk in shadow collapses to the
// same achromatic value as sunlit asphalt and the two surfaces blur
// together. Repeat-wrapped; consumers feed world-XZ-derived UVs at
// SIDEWALK_UV_PER_M so the pattern stays anchored.
export function getSidewalkTexture() {
    if (_sidewalkTexture) return _sidewalkTexture;
    const SIZE = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    // Warm, light concrete base. The larger luminance and chroma separation
    // from road asphalt is intentional: both materials still receive the
    // same sun/night/lamp treatment, but can no longer collapse to the same
    // grey under a street lamp or deep building shadow.
    for (let i = 0; i < SIZE * SIZE; i++) {
        const j = Math.floor((Math.random() - 0.5) * 20);
        data[i * 4 + 0] = 180 + j;
        data[i * 4 + 1] = 171 + j;
        data[i * 4 + 2] = 158 + j;
        data[i * 4 + 3] = 255;
    }
    // ~2% darker stain dots (oil, mud, dirt) — keep the slight warm cast.
    const stainCount = Math.floor(SIZE * SIZE * 0.02);
    for (let n = 0; n < stainCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const j = Math.floor(Math.random() * 25);
        data[i + 0] = 92 + j;
        data[i + 1] = 88 + j;
        data[i + 2] = 84 + j;
    }
    // ~1% lighter wear / chipped patches — bleached, still slightly warm.
    const wearCount = Math.floor(SIZE * SIZE * 0.01);
    for (let n = 0; n < wearCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const j = Math.floor(Math.random() * 30);
        data[i + 0] = 198 + j;
        data[i + 1] = 194 + j;
        data[i + 2] = 188 + j;
    }
    ctx.putImageData(img, 0, 0);

    // Macro wear over the grain: soft tonal drift, hairline cracks, and
    // faint dirt smudges so long pavement runs stop looking pristine.
    for (let n = 0; n < SIDEWALK_WEAR.tonePatches; n++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = 100 + Math.random() * 240;
        const lighter = Math.random() < 0.45;
        const tone = lighter ? '212,208,200' : '110,106,100';
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${tone},${(0.07 + Math.random() * 0.07).toFixed(2)})`);
        g.addColorStop(1, `rgba(${tone},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let n = 0; n < SIDEWALK_WEAR.cracks; n++) {
        let cx = Math.random() * SIZE, cy = Math.random() * SIZE;
        let cd = Math.random() * Math.PI * 2;
        const steps = 10 + Math.floor(Math.random() * 18);
        for (const [width, alpha] of [[2.6, 0.10], [1.1, 0.40]]) {
            let px = cx, py = cy, pd = cd;
            ctx.strokeStyle = `rgba(80,76,70,${alpha})`;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(px, py);
            for (let s2 = 0; s2 < steps; s2++) {
                pd += (Math.random() - 0.5) * 1.2;
                px += Math.cos(pd) * (5 + Math.random() * 10);
                py += Math.sin(pd) * (5 + Math.random() * 10);
                ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
    }
    for (let n = 0; n < SIDEWALK_WEAR.stains; n++) {
        ctx.save();
        ctx.translate(Math.random() * SIZE, Math.random() * SIZE);
        ctx.rotate(Math.random() * Math.PI);
        const w = 90 + Math.random() * 200, h = 10 + Math.random() * 26;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
        g.addColorStop(0, `rgba(96,90,82,${(0.08 + Math.random() * 0.07).toFixed(2)})`);
        g.addColorStop(1, 'rgba(96,90,82,0)');
        ctx.fillStyle = g;
        ctx.scale(1, h / w);
        ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
    _sidewalkTexture = new THREE.CanvasTexture(canvas);
    _sidewalkTexture.wrapS = THREE.RepeatWrapping;
    _sidewalkTexture.wrapT = THREE.RepeatWrapping;
    _sidewalkTexture.colorSpace = THREE.SRGBColorSpace;
    _sidewalkTexture.anisotropy = 4;
    _sidewalkTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _sidewalkTexture.magFilter = THREE.LinearFilter;
    _sidewalkTexture.generateMipmaps = true;
    // Texture .repeat stays at (1,1) — both consumers feed world-XZ
    // UVs in tile units (metres / SIDEWALK_TILE_M).
    registerShared(_sidewalkTexture);
    return _sidewalkTexture;
}

export const GRAVEL_TILE_M = 2.0;
export const GRAVEL_UV_PER_M = 1 / GRAVEL_TILE_M;

let _gravelTexture = null;

// Procedural dirt/gravel texture. Brown earth base with scattered pebbles
// in lighter and darker greys/browns; used for OSM `landuse=construction`
// polygons (active roadworks/sites) so they read as torn-up ground rather
// than a flat orange wash.
export function getGravelTexture() {
    if (_gravelTexture) return _gravelTexture;
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    // Base earthy brown + per-pixel jitter for soil grain.
    for (let i = 0; i < SIZE * SIZE; i++) {
        const r = 110 + Math.floor((Math.random() - 0.5) * 24);
        const g = 78  + Math.floor((Math.random() - 0.5) * 22);
        const b = 52  + Math.floor((Math.random() - 0.5) * 18);
        data[i * 4 + 0] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
    }
    // Pebble dabs: small clusters of lighter grey-brown.
    const pebbleCount = Math.floor(SIZE * SIZE * 0.06);
    for (let n = 0; n < pebbleCount; n++) {
        const cx = Math.floor(Math.random() * SIZE);
        const cy = Math.floor(Math.random() * SIZE);
        const radius = 1 + Math.floor(Math.random() * 2);
        const tone = Math.random();
        let pr, pg, pb;
        if (tone < 0.55) {
            const v = 150 + Math.floor(Math.random() * 40); // pale grey pebble
            pr = v; pg = v - 8; pb = v - 18;
        } else {
            const v = 60 + Math.floor(Math.random() * 25);  // dark wet stone
            pr = v + 6; pg = v; pb = v - 6;
        }
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy > radius * radius) continue;
                const x = (cx + dx + SIZE) % SIZE;
                const y = (cy + dy + SIZE) % SIZE;
                const i = (y * SIZE + x) * 4;
                data[i + 0] = pr;
                data[i + 1] = pg;
                data[i + 2] = pb;
            }
        }
    }
    ctx.putImageData(img, 0, 0);
    _gravelTexture = new THREE.CanvasTexture(canvas);
    _gravelTexture.wrapS = THREE.RepeatWrapping;
    _gravelTexture.wrapT = THREE.RepeatWrapping;
    _gravelTexture.colorSpace = THREE.SRGBColorSpace;
    _gravelTexture.anisotropy = 4;
    _gravelTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _gravelTexture.magFilter = THREE.LinearFilter;
    _gravelTexture.generateMipmaps = true;
    registerShared(_gravelTexture);
    return _gravelTexture;
}

export function initScene(container) {
    containerEl = container;

    const w = containerEl.clientWidth || window.innerWidth;
    const h = containerEl.clientHeight || window.innerHeight;

    scene = new THREE.Scene();
    // Dev-only scene handle for console inspection in ANY world (photo mode
    // has __photorealDebug; the model world had nothing). Read-only.
    if (typeof window !== 'undefined') window.__station3dScene = () => scene;
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 250, 1200);

    camera = new THREE.PerspectiveCamera(60, w / h, 0.5, 2000);
    // Same dev-only handle as __station3dScene, for reading where a film or a
    // follow camera actually is from the console or a probe. Read-only.
    if (typeof window !== 'undefined') window.__station3dCamera = () => camera;
    camera.position.set(0, 110, 130);
    camera.lookAt(0, 0, 0);

    // The 0.5-2,000 m camera range retains ample precision with the normal
    // depth buffer. Avoiding logarithmic depth also preserves early fragment
    // testing, which measurably lowers render time in the full tram scene.
    // Ground ownership uses one stencil bit: road fragments mark their exact
    // screen footprint before passive landuse draws, so imprecise overlapping
    // OSM grass can never beat asphalt at long-distance depth precision.
    renderer = createRenderer({ antialias: qualitySelection.profile.antialias, stencil: true });
    rendererAntialias = renderer.getContextAttributes?.().antialias
        ?? qualitySelection.profile.antialias;
    renderer.setPixelRatio(getRendererPixelRatio());
    renderer.setSize(w, h);
    // Adjacent draws of one compiled program skip program re-binding.
    renderer.setOpaqueSort(createProgramGroupedOpaqueSort(rendererProgramLookup(renderer)));
    renderer.shadowMap.enabled = true;
    applyRenderGrade(renderGrade);
    containerEl.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);

    // r184 PBR divides BOTH AmbientLight AND DirectionalLight irradiance by
    // π (verified via direct pixel readback test), hence the π scaling.
    // Ratios are tuned for the default 'aces' grade: sRGB output brightens
    // midtones relative to the old linear-output look, so ambient/fill sit
    // lower than the historical r128-matched values (0.50 / 0.24) to keep
    // shadow-side contrast. sky.js captures these as its day/night baseline
    // on first updateLights() — retune here, never there.
    ambient = new THREE.AmbientLight(0xffffff, 0.38 * Math.PI);
    scene.add(ambient);
    sun = new THREE.DirectionalLight(0xffffff, 0.95 * Math.PI);
    sun.position.set(120, 160, 80);   // lower angle helps facade setbacks/protrusions read
    sun.castShadow = true;
    // Shadow frustum bounds are in the light's local frame, so they rotate
    // with the sun and keep the same coverage regardless of angle.
    // TEMP DIAGNOSTIC: tightened from ±200 (400 m wide) to ±100 (200 m
    // wide). At 200 m the cab driver almost never notices distant shadows
    // anyway, and the smaller frustum cuts the shadow-pass caster set
    // roughly in half — direct draw-call savings for cabStep frames.
    // Shadow map texels also become 4× sharper for the area that DOES
    // matter (the streetscape near the cab) since 2048² now covers
    // 200×200 m instead of 400×400 m. Restore to ±200 if shadow popping
    // / frustum-edge hard cuts become noticeable.
    const shadowDistanceM = qualitySelection.profile.shadowCasterDistanceM;
    sun.shadow.camera.top = shadowDistanceM;
    sun.shadow.camera.bottom = -shadowDistanceM;
    sun.shadow.camera.left = -shadowDistanceM;
    sun.shadow.camera.right = shadowDistanceM;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 1600;
    sun.shadow.mapSize.width = qualitySelection.profile.shadowMapSize;
    sun.shadow.mapSize.height = qualitySelection.profile.shadowMapSize;
    sun.shadow.bias = -0.002;
    sun.shadow.normalBias = 0.05;
    scene.add(sun);
    // DirectionalLight's target must be in the scene graph for its world
    // matrix to update; the light shines from its position toward target.
    scene.add(sun.target);
    // Reuse the shadow map while the (grid-snapped) light and every caster are
    // unchanged; otherwise three renders it as usual.
    shadowCache?.dispose();
    shadowCache = createCachedShadowMap({ renderer, scene, light: sun });

    // Fill light, opposite the sun's azimuth, same elevation. Lights walls
    // facing W/N (which the main sun leaves in shadow) so their protrusions,
    // recesses, and edges still show brightness gradient — without it the
    // shaded side of every building reads as one flat blob. Intensity is
    // ~33% of the sun, no shadow casting (a "second sun" shadow would just
    // confuse the eye).
    fill = new THREE.DirectionalLight(0xffffff, 0.20 * Math.PI);
    fill.position.set(-120, 160, -80);
    fill.castShadow = false;
    scene.add(fill);
    scene.add(fill.target);

    const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    // Override the plane's default 0..1 UVs with geometry-local coords
    // scaled by SIDEWALK_UV_PER_M, so the concrete texture tiles at one
    // repeat per SIDEWALK_TILE_M metres. The mesh rotateX(-π/2) below
    // maps local Y → world -Z, so we negate Y here to keep the U/V
    // axes aligned with world X/Z (the per-frame offset compensation
    // in cab.js relies on this alignment to keep the texture stationary
    // in world space as the ground slides under the camera).
    {
        const pos = groundGeo.getAttribute('position');
        const uv  = groundGeo.getAttribute('uv');
        for (let i = 0; i < pos.count; i++) {
            uv.setXY(i,
                 pos.getX(i) * SIDEWALK_UV_PER_M,
                -pos.getY(i) * SIDEWALK_UV_PER_M);
        }
        uv.needsUpdate = true;
    }
    // Catch-all surface is textured grey concrete. Explicit OSM greenery
    // polygons are rendered above it, so green appears only where the data
    // marks grass, meadow, park, forest, pitch, etc. We use a CLONE so we
    // can drive its `.offset` per-frame (in cab.js) without dragging
    // the OSM paving-polygon material along with us — those use the base
    // texture with offset = (0,0) and stay anchored in world.
    const groundTex = getSidewalkTexture().clone();
    groundTex.needsUpdate = true;
    registerShared(groundTex);
    const groundClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.DEFAULT_GROUND_COVER,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'catch-all-ground',
        sourceId: 'scene/setup.js',
        supportReady: true,
    });
    const groundMat = applySurfaceStencil(new THREE.MeshStandardMaterial({
        map: groundTex,
        side: THREE.DoubleSide,
        // The catch-all ground is just a backdrop under every explicit
        // landuse / proposal surface. Push it slightly away in depth so
        // shallow water, grass, and paving polygons reliably win instead of
        // flickering to the raw grey slab at glancing angles.
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
    }), groundClaim);
    // Hole mask (see setGroundHoleMask below): the sea layer punches
    // world-anchored holes in the sliding catch-all plane so water surfaces
    // can sit BELOW ground level. Compiled in permanently, gated by a
    // uniform, so enabling/disabling never recompiles the shader.
    applyGroundHoleMask(groundMat, groundClaim);
    applyStreetLampSurfaceLighting(groundMat);
    applyPlannerSurfaceCutout(groundMat, groundClaim);
    groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.name = 'CatchAllGround';
    markSurfaceClaim(groundMesh, groundClaim);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    groundMesh.renderOrder = GROUND_STENCIL_READER_RENDER_ORDER;
    markInspectionLayer(groundMesh, {
        id: 'ground-catchall',
        label: 'Catch-all ground',
        category: 'Ground',
        source: 'scene/setup.js · sliding concrete fallback plane',
        order: 20,
    });
    scene.add(groundMesh);
    registerShared(groundGeo, groundMat);

    const ringGeo = new THREE.RingGeometry(BUILDING_RADIUS_M - 0.4, BUILDING_RADIUS_M, 96);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x1d4ed8, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.name = 'StationRadiusGuide';
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.05;
    markInspectionLayer(ringMesh, {
        id: 'debug-guides',
        label: 'Scene guides',
        category: 'Diagnostics',
        source: 'scene/setup.js · radius and orientation guides',
        order: 9500,
    });
    scene.add(ringMesh);
    registerShared(ringGeo, ringMat);

    northArrowMesh = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(0, 0.2, 0),
        BUILDING_RADIUS_M * 0.35,
        0xff0000,
        BUILDING_RADIUS_M * 0.06,
        BUILDING_RADIUS_M * 0.04,
    );
    markInspectionLayer(northArrowMesh, {
        id: 'debug-guides',
        label: 'Scene guides',
        category: 'Diagnostics',
        source: 'scene/setup.js · radius and orientation guides',
        order: 9500,
    });
    scene.add(northArrowMesh);

    stationMarker = createStationMarker();
    markInspectionLayer(stationMarker, {
        id: 'station-marker',
        label: 'Station marker',
        category: 'Diagnostics',
        source: 'scene/setup.js · symbolic static-mode marker',
        order: 9501,
    });
    scene.add(stationMarker);

    buildingMaterial = new THREE.MeshStandardMaterial({
        color: 0xddccb0,
        roughness: 0.82,
        envMapIntensity: 0.35,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
    });
    registerShared(buildingMaterial);

    resizeHandler = resizeScene;

    return true;
}

// Symbolic Zagreb Metro entrance: small boxy structure with a "ZM" sign on two faces.
// Used in static mode as a visible anchor at the selected station's lat/lon.
function createStationMarker() {
    const group = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe11d48 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1f2937 });
    registerShared(wallMat, roofMat);

    const w = 6, d = 4, h = 4;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.4, d + 0.6), roofMat);
    roof.position.y = h + 0.2;
    roof.castShadow = true;
    group.add(roof);

    const signGeo = new THREE.PlaneGeometry(w * 0.7, h * 0.35);
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256;
    signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#e11d48';
    ctx.font = 'bold 96px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ZM', 128, 70);
    const signTex = new THREE.CanvasTexture(signCanvas);
    const signTexMat = new THREE.MeshBasicMaterial({ map: signTex });
    registerShared(signGeo, signTex, signTexMat);

    const sign = new THREE.Mesh(signGeo, signTexMat);
    sign.position.set(0, h * 0.62, d / 2 + 0.02);
    group.add(sign);
    const signBack = new THREE.Mesh(signGeo, signTexMat);
    signBack.position.set(0, h * 0.62, -d / 2 - 0.02);
    signBack.rotation.y = Math.PI;
    group.add(signBack);

    return group;
}
