// Shared shader mask for planner ramps plus exact station-access stairwells.
// White mask texels discard ordinary ground-level surfaces while civil works,
// sloped trackbed, rails, and station geometry remain visible through the hole.
//
// The bitmap spans the whole network, so its texel is metres wide on a
// multi-kilometre project. That is fine for the metre-wide ramp trenches, but
// it cannot represent a 2.1 m stair well: a canvas stroke thinner than a texel
// still paints a texel, and the discarded band grew wider than the entrance
// house standing on it, opening holes in the pavement beside every entrance.
// Stair wells are therefore cut analytically from a small capsule list, which
// is exact at any project size. The platform publication owns that list; rail
// planner generations own only the bitmap and cannot clear live station holes.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { captureSurfaceEntranceCuts, captureAuthoredOpeningBoxes } from '../core/surface-opening-shapes.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_PLANNER_CUTOUT_MODE,
    SURFACE_VERTICAL_RELATION,
    asSurfaceClaim,
    compileSurfaceClaim,
    requireSurfaceBackstopCutClaim,
    surfacePlannerCutoutModeForClaim,
} from '../core/surface-hierarchy.js';

const fallbackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
fallbackTexture.needsUpdate = true;

// A detached, geometrically clipped receiver gets its own shader variant.
// Mutating the source material would change the still-active generation even
// if this candidate is cancelled. Maps/uniform inputs stay shared; no texture
// allocation or per-draw callback is added. The producer owns retirement.
export function createPlannerGeometryMaterialCache({ maxMaterials = 256 } = {}) {
    if (!Number.isSafeInteger(maxMaterials) || maxMaterials < 1) throw new TypeError('Invalid planner material capacity');
    const variants = new Map();
    return Object.freeze({
        get(source) {
            if (!source?.userData?.plannerSurfaceCutout || source.defines?.ST3D_PLANNER_GEOMETRY_CUTOUTS === 1) return source;
            if (variants.has(source)) return variants.get(source);
            if (variants.size >= maxMaterials) throw Object.assign(new RangeError('Planner receiver material capacity exceeded'),
                { code: 'ground-generation-capacity' });
            const material = source.clone();
            // Three intentionally leaves shader callbacks out of clone().
            material.onBeforeCompile = source.onBeforeCompile;
            material.customProgramCacheKey = source.customProgramCacheKey;
            material.defines = { ...source.defines, ST3D_PLANNER_GEOMETRY_CUTOUTS: 1 };
            material.userData.plannerGeometryCutouts = true;
            variants.set(source, material); registerShared(material); return material;
        },
        take() { const materials = [...variants.values()]; variants.clear(); return materials; },
    });
}

export const PLANNER_ENTRANCE_CUT_MAX = 16;
export const AUTHORED_SURFACE_OPENING_MAX = 8;

// One shared set, merged into both material variants: a stair well must open
// the ground under every surface, including those that preserve surface track.
const entranceUniforms = {
    uPlannerEntranceCuts: {
        value: Array.from({ length: PLANNER_ENTRANCE_CUT_MAX }, () => new THREE.Vector4()),
    },
    uPlannerEntranceCutRadii: {
        value: new Float32Array(PLANNER_ENTRANCE_CUT_MAX),
    },
    uPlannerEntranceCutCount: { value: 0 },
};
let publishedEntranceCuts = Object.freeze([]);

// Permanent civil landmarks use bounded 3D openings rather than the planner's
// flat-world y<1 gate. Their visible shell is published first, then these exact
// XZ/Y bounds remove any streamed ground, road, decor or building fragments
// occupying the replacement volume.
const authoredOpeningUniforms = {
    uAuthoredSurfaceOpeningBounds: {
        value: Array.from(
            { length: AUTHORED_SURFACE_OPENING_MAX },
            () => new THREE.Vector4(),
        ),
    },
    uAuthoredSurfaceOpeningY: {
        value: Array.from(
            { length: AUTHORED_SURFACE_OPENING_MAX },
            () => new THREE.Vector2(),
        ),
    },
    uAuthoredSurfaceOpeningCount: { value: 0 },
};
let publishedAuthoredOpenings = Object.freeze([]);

const uniforms = {
    uPlannerSurfaceCutoutMask: { value: fallbackTexture },
    uPlannerSurfaceCutoutCenter: { value: new THREE.Vector2() },
    uPlannerSurfaceCutoutHalfSize: { value: 1 },
    uPlannerSurfaceCutoutEnabled: { value: 0 },
};
const structuralUniforms = {
    uPlannerSurfaceCutoutMask: { value: fallbackTexture },
    uPlannerSurfaceCutoutCenter: { value: new THREE.Vector2() },
    uPlannerSurfaceCutoutHalfSize: { value: 1 },
    uPlannerSurfaceCutoutEnabled: { value: 0 },
};

const PLANNER_CUT_TARGET = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.TERRAIN,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    supportReady: true,
});

function requirePlannerOpeningClaim(sourceClaim, operation) {
    return requireSurfaceBackstopCutClaim(sourceClaim, PLANNER_CUT_TARGET, { operation });
}

// Each cut is a capsule: the segment (x1,z1)-(x2,z2) with a radius.
export function setPlannerEntranceCuts(cuts, sourceClaim) {
    requirePlannerOpeningClaim(sourceClaim, 'planner entrance cut publication');
    const list = captureSurfaceEntranceCuts(cuts, PLANNER_ENTRANCE_CUT_MAX);
    for (let i = 0; i < list.length; i++) {
        entranceUniforms.uPlannerEntranceCuts.value[i].set(
            list[i].x1,
            list[i].z1,
            list[i].x2,
            list[i].z2,
        );
        entranceUniforms.uPlannerEntranceCutRadii.value[i] = list[i].widthM * 0.5;
    }
    entranceUniforms.uPlannerEntranceCutCount.value = list.length;
    publishedEntranceCuts = list;
}

export function clearPlannerEntranceCuts() {
    entranceUniforms.uPlannerEntranceCutCount.value = 0;
    publishedEntranceCuts = Object.freeze([]);
}

export function getPublishedPlannerEntranceCuts() {
    return publishedEntranceCuts;
}

export function getPlannerEntranceCutState() {
    return {
        count: entranceUniforms.uPlannerEntranceCutCount.value,
        radii: [...entranceUniforms.uPlannerEntranceCutRadii.value],
        cuts: entranceUniforms.uPlannerEntranceCuts.value.map(v => ({
            x1: v.x, z1: v.y, x2: v.z, z2: v.w,
        })),
    };
}

// Openings are published per owner, read from the claim (a world landmark, a
// campaign set piece): a publication replaces only its owner's entries, and
// the shader receives every owner's at once.
const authoredOpeningsByOwner = new Map();

function authoredOpeningOwnerId(sourceClaim, operation) {
    const ownerId = requirePlannerOpeningClaim(sourceClaim, operation).ownerId;
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new Error(`${operation} rejected: the claim names no ownerId`);
    }
    return ownerId;
}

function writeAuthoredOpeningUniforms() {
    const list = Object.freeze([...authoredOpeningsByOwner.values()].flat());
    for (let i = 0; i < list.length; i++) {
        authoredOpeningUniforms.uAuthoredSurfaceOpeningBounds.value[i].set(
            list[i].minX,
            list[i].minZ,
            list[i].maxX,
            list[i].maxZ,
        );
        authoredOpeningUniforms.uAuthoredSurfaceOpeningY.value[i].set(
            list[i].minY,
            list[i].maxY,
        );
    }
    authoredOpeningUniforms.uAuthoredSurfaceOpeningCount.value = list.length;
    publishedAuthoredOpenings = list;
}

export function setAuthoredSurfaceOpeningCuts(cuts, sourceClaim) {
    const ownerId = authoredOpeningOwnerId(sourceClaim, 'authored surface opening publication');
    let otherCount = 0;
    for (const [key, values] of authoredOpeningsByOwner) if (key !== ownerId) otherCount += values.length;
    // Check the complete multi-owner capacity before changing any map or
    // uniform. A rejected replacement preserves every active owner's hole.
    const list = captureAuthoredOpeningBoxes(cuts, AUTHORED_SURFACE_OPENING_MAX - otherCount);
    if (list.length > 0) authoredOpeningsByOwner.set(ownerId, list);
    else authoredOpeningsByOwner.delete(ownerId);
    writeAuthoredOpeningUniforms();
}

export function clearAuthoredSurfaceOpeningCuts(sourceClaim) {
    authoredOpeningsByOwner.delete(authoredOpeningOwnerId(sourceClaim, 'authored surface opening removal'));
    writeAuthoredOpeningUniforms();
}

export function getPublishedAuthoredSurfaceOpeningCuts() {
    return publishedAuthoredOpenings;
}

export function setPlannerSurfaceCutoutMask(
    texture,
    centerX,
    centerZ,
    halfSizeM,
    sourceClaim,
) {
    requirePlannerOpeningClaim(sourceClaim, 'planner surface cutout publication');
    uniforms.uPlannerSurfaceCutoutMask.value = texture || fallbackTexture;
    uniforms.uPlannerSurfaceCutoutCenter.value.set(centerX, centerZ);
    uniforms.uPlannerSurfaceCutoutHalfSize.value = Math.max(1, Number(halfSizeM) || 1);
    uniforms.uPlannerSurfaceCutoutEnabled.value = texture ? 1 : 0;
}

export function setPlannerStructuralSurfaceCutoutMask(
    texture,
    centerX,
    centerZ,
    halfSizeM,
    sourceClaim,
) {
    requirePlannerOpeningClaim(sourceClaim, 'planner structural cutout publication');
    structuralUniforms.uPlannerSurfaceCutoutMask.value = texture || fallbackTexture;
    structuralUniforms.uPlannerSurfaceCutoutCenter.value.set(centerX, centerZ);
    structuralUniforms.uPlannerSurfaceCutoutHalfSize.value = Math.max(1, Number(halfSizeM) || 1);
    structuralUniforms.uPlannerSurfaceCutoutEnabled.value = texture ? 1 : 0;
}

export function clearPlannerSurfaceCutoutMask() {
    uniforms.uPlannerSurfaceCutoutMask.value = fallbackTexture;
    uniforms.uPlannerSurfaceCutoutEnabled.value = 0;
    structuralUniforms.uPlannerSurfaceCutoutMask.value = fallbackTexture;
    structuralUniforms.uPlannerSurfaceCutoutEnabled.value = 0;
}

export function getPlannerSurfaceCutoutState() {
    return {
        enabled: uniforms.uPlannerSurfaceCutoutEnabled.value > 0,
        centerX: uniforms.uPlannerSurfaceCutoutCenter.value.x,
        centerZ: uniforms.uPlannerSurfaceCutoutCenter.value.y,
        halfSizeM: uniforms.uPlannerSurfaceCutoutHalfSize.value,
        texture: uniforms.uPlannerSurfaceCutoutMask.value,
    };
}

export function applyPlannerSurfaceCutout(material, targetClaim) {
    if (!material) return material;
    const claim = asSurfaceClaim(targetClaim);
    const mode = surfacePlannerCutoutModeForClaim(claim);
    material.userData ||= {};
    material.userData.surfaceClaim = claim;
    material.userData.plannerSurfaceCutoutMode = mode;
    // Grade-separated surfaces correctly ignore planner excavation, but they
    // must still yield when a permanent authored landmark replaces the same
    // bounded world volume.
    if (mode === SURFACE_PLANNER_CUTOUT_MODE.NONE) {
        return applyAuthoredSurfaceOpeningCutout(material);
    }
    if (material.userData.plannerSurfaceCutout) return material;
    const preserveSurfaceTrack = mode === SURFACE_PLANNER_CUTOUT_MODE.STRUCTURAL_ONLY;
    const materialUniforms = preserveSurfaceTrack ? structuralUniforms : uniforms;
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(
            shader.uniforms,
            materialUniforms,
            entranceUniforms,
            authoredOpeningUniforms,
        );
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vPlannerSurfaceCutoutWorldPos;',
            )
            .replace(
                '#include <displacementmap_vertex>',
                `#include <displacementmap_vertex>
vec4 plannerSurfaceCutoutPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
    plannerSurfaceCutoutPosition = batchingMatrix * plannerSurfaceCutoutPosition;
#endif
#ifdef USE_INSTANCING
    plannerSurfaceCutoutPosition = instanceMatrix * plannerSurfaceCutoutPosition;
#endif
vPlannerSurfaceCutoutWorldPos = (modelMatrix * plannerSurfaceCutoutPosition).xyz;`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
#define PLANNER_ENTRANCE_CUT_MAX ${PLANNER_ENTRANCE_CUT_MAX}
#define AUTHORED_SURFACE_OPENING_MAX ${AUTHORED_SURFACE_OPENING_MAX}
varying vec3 vPlannerSurfaceCutoutWorldPos;
uniform sampler2D uPlannerSurfaceCutoutMask;
uniform vec2 uPlannerSurfaceCutoutCenter;
uniform float uPlannerSurfaceCutoutHalfSize;
uniform float uPlannerSurfaceCutoutEnabled;
uniform vec4 uPlannerEntranceCuts[PLANNER_ENTRANCE_CUT_MAX];
uniform float uPlannerEntranceCutRadii[PLANNER_ENTRANCE_CUT_MAX];
uniform int uPlannerEntranceCutCount;
uniform vec4 uAuthoredSurfaceOpeningBounds[AUTHORED_SURFACE_OPENING_MAX];
uniform vec2 uAuthoredSurfaceOpeningY[AUTHORED_SURFACE_OPENING_MAX];
uniform int uAuthoredSurfaceOpeningCount;`,
            )
            .replace(
                '#include <clipping_planes_fragment>',
                `vec3 plannerSurfaceCutoutAbsoluteWorldPos = vPlannerSurfaceCutoutWorldPos;
plannerSurfaceCutoutAbsoluteWorldPos.xz += uRenderOriginXZ;
#ifndef ST3D_PLANNER_GEOMETRY_CUTOUTS
if (plannerSurfaceCutoutAbsoluteWorldPos.y < 1.0) {
    if (uPlannerSurfaceCutoutEnabled > 0.5) {
        vec2 plannerCutoutUv = (plannerSurfaceCutoutAbsoluteWorldPos.xz - uPlannerSurfaceCutoutCenter) / (2.0 * uPlannerSurfaceCutoutHalfSize) + 0.5;
        if (plannerCutoutUv.x >= 0.0 && plannerCutoutUv.x <= 1.0 && plannerCutoutUv.y >= 0.0 && plannerCutoutUv.y <= 1.0) {
            if (texture2D(uPlannerSurfaceCutoutMask, plannerCutoutUv).r > 0.5) discard;
        }
    }
    // Stair wells: exact capsules, independent of the bitmap's texel size.
    for (int i = 0; i < PLANNER_ENTRANCE_CUT_MAX; i++) {
        if (i >= uPlannerEntranceCutCount) break;
        vec4 plannerEntranceCut = uPlannerEntranceCuts[i];
        vec2 plannerEntranceAxis = plannerEntranceCut.zw - plannerEntranceCut.xy;
        float plannerEntranceLenSq = max(dot(plannerEntranceAxis, plannerEntranceAxis), 1e-6);
        float plannerEntranceT = clamp(
            dot(plannerSurfaceCutoutAbsoluteWorldPos.xz - plannerEntranceCut.xy, plannerEntranceAxis) / plannerEntranceLenSq,
            0.0,
            1.0
        );
        vec2 plannerEntranceNearest = plannerEntranceCut.xy + plannerEntranceAxis * plannerEntranceT;
        if (distance(plannerSurfaceCutoutAbsoluteWorldPos.xz, plannerEntranceNearest) <= uPlannerEntranceCutRadii[i]) discard;
    }
}
for (int i = 0; i < AUTHORED_SURFACE_OPENING_MAX; i++) {
    if (i >= uAuthoredSurfaceOpeningCount) break;
    vec4 authoredBounds = uAuthoredSurfaceOpeningBounds[i];
    vec2 authoredY = uAuthoredSurfaceOpeningY[i];
    if (plannerSurfaceCutoutAbsoluteWorldPos.x >= authoredBounds.x &&
        plannerSurfaceCutoutAbsoluteWorldPos.z >= authoredBounds.y &&
        plannerSurfaceCutoutAbsoluteWorldPos.x <= authoredBounds.z &&
        plannerSurfaceCutoutAbsoluteWorldPos.z <= authoredBounds.w &&
        plannerSurfaceCutoutAbsoluteWorldPos.y >= authoredY.x &&
        plannerSurfaceCutoutAbsoluteWorldPos.y <= authoredY.y) discard;
}
#endif
#include <clipping_planes_fragment>`,
            );
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|planner-surface-cutout-v8|${preserveSurfaceTrack ? 'structural' : 'all'}`;
    };
    material.userData.plannerSurfaceCutout = true;
    material.userData.plannerSurfaceTrackPreserved = preserveSurfaceTrack;
    material.needsUpdate = true;
    return material;
}

// Grade-separated civil meshes normally ignore the planner's ground mask — a
// bridge or tunnel must survive a rail-planner cut. A published landmark is a
// different contract: its bounded replacement volume must also remove an old
// generic tunnel box occupying the same real-world space. This hook installs
// only that 3D landmark cut, leaving every planner mask and station capsule
// deliberately out of the material.
export function applyAuthoredSurfaceOpeningCutout(material) {
    if (!material) return material;
    material.userData ||= {};
    if (material.userData.plannerSurfaceCutout
        || material.userData.authoredSurfaceOpeningCutout) return material;
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, authoredOpeningUniforms);
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vAuthoredSurfaceOpeningWorldPos;',
            )
            .replace(
                '#include <displacementmap_vertex>',
                `#include <displacementmap_vertex>
vec4 authoredSurfaceOpeningPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
    authoredSurfaceOpeningPosition = batchingMatrix * authoredSurfaceOpeningPosition;
#endif
#ifdef USE_INSTANCING
    authoredSurfaceOpeningPosition = instanceMatrix * authoredSurfaceOpeningPosition;
#endif
vAuthoredSurfaceOpeningWorldPos = (modelMatrix * authoredSurfaceOpeningPosition).xyz;`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
#define AUTHORED_SURFACE_OPENING_MAX ${AUTHORED_SURFACE_OPENING_MAX}
varying vec3 vAuthoredSurfaceOpeningWorldPos;
uniform vec4 uAuthoredSurfaceOpeningBounds[AUTHORED_SURFACE_OPENING_MAX];
uniform vec2 uAuthoredSurfaceOpeningY[AUTHORED_SURFACE_OPENING_MAX];
uniform int uAuthoredSurfaceOpeningCount;`,
            )
            .replace(
                '#include <clipping_planes_fragment>',
                `vec3 authoredSurfaceOpeningAbsoluteWorldPos = vAuthoredSurfaceOpeningWorldPos;
authoredSurfaceOpeningAbsoluteWorldPos.xz += uRenderOriginXZ;
for (int i = 0; i < AUTHORED_SURFACE_OPENING_MAX; i++) {
    if (i >= uAuthoredSurfaceOpeningCount) break;
    vec4 authoredBounds = uAuthoredSurfaceOpeningBounds[i];
    vec2 authoredY = uAuthoredSurfaceOpeningY[i];
    if (authoredSurfaceOpeningAbsoluteWorldPos.x >= authoredBounds.x &&
        authoredSurfaceOpeningAbsoluteWorldPos.z >= authoredBounds.y &&
        authoredSurfaceOpeningAbsoluteWorldPos.x <= authoredBounds.z &&
        authoredSurfaceOpeningAbsoluteWorldPos.z <= authoredBounds.w &&
        authoredSurfaceOpeningAbsoluteWorldPos.y >= authoredY.x &&
        authoredSurfaceOpeningAbsoluteWorldPos.y <= authoredY.y) discard;
}
#include <clipping_planes_fragment>`,
            );
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|authored-surface-opening-v1`;
    };
    material.userData.authoredSurfaceOpeningCutout = true;
    material.needsUpdate = true;
    return material;
}
