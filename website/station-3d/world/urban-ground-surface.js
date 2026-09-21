// Blends the active terrain surface into the established default city ground
// through one world-space mask shared by terrain and civil seam collars.

import * as THREE from 'three';
import { getSidewalkTexture, SIDEWALK_UV_PER_M } from '../scene/setup.js';
import { getLocation } from '../core/locations.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import {
    createFieldPatchworkRaster,
    FIELD_PATCHWORK_DEFAULTS,
} from '../core/field-patchwork-texture.js';
import {
    groundSurfaceMaterialClassifications,
} from '../core/ground-surface-inspection.js';
import {
    asSurfaceClaim,
    surfaceClaimMayUseUrbanGround,
} from '../core/surface-hierarchy.js';

const fallbackMask = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
fallbackMask.needsUpdate = true;

// How strongly the farmland patchwork tints the default ground. Kept well under 1
// so the quilt reads as crop variation in grassland, never as coloured tiles.
const FIELD_PATCHWORK_STRENGTH = 0.72;

const uniforms = {
    uUrbanGroundMap: { value: null },
    uUrbanGroundMask: { value: fallbackMask },
    uUrbanGroundCenter: { value: new THREE.Vector2(0, 0) },
    uUrbanGroundHalfSize: { value: 1 },
    uUrbanGroundUvPerM: { value: SIDEWALK_UV_PER_M },
    uUrbanGroundEnabled: { value: 0 },
    uFieldMap: { value: fallbackMask },
    uFieldUvPerM: { value: FIELD_PATCHWORK_DEFAULTS.uvPerM || 1 / FIELD_PATCHWORK_DEFAULTS.tileM },
    uFieldStrength: { value: 0 },
};

let fieldTexture = null;

// The patchwork is farmland, so it only belongs on the grassland ground style —
// Split's karst must stay as authored. One decision per session/location.
function ensureFieldPatchwork() {
    if (fieldTexture) return fieldTexture;
    const raster = createFieldPatchworkRaster();
    fieldTexture = new THREE.DataTexture(raster.color, raster.size, raster.size, THREE.RGBAFormat);
    fieldTexture.wrapS = THREE.RepeatWrapping;
    fieldTexture.wrapT = THREE.RepeatWrapping;
    fieldTexture.minFilter = THREE.LinearMipmapLinearFilter;
    fieldTexture.magFilter = THREE.LinearFilter;
    fieldTexture.generateMipmaps = true;
    fieldTexture.anisotropy = 4;
    fieldTexture.needsUpdate = true;
    uniforms.uFieldMap.value = fieldTexture;
    uniforms.uFieldUvPerM.value = raster.uvPerM;
    return fieldTexture;
}

function fieldPatchworkWanted() {
    let style = null;
    try {
        style = getLocation().terrain?.surfaceStyle || null;
    } catch (_e) {
        return false;   // non-browser context (unit tests)
    }
    return style === 'grass';
}

export function setUrbanGroundSurfaceMask(texture, centerX, centerZ, halfSizeM) {
    uniforms.uUrbanGroundMask.value = texture || fallbackMask;
    uniforms.uUrbanGroundCenter.value.set(Number(centerX) || 0, Number(centerZ) || 0);
    uniforms.uUrbanGroundHalfSize.value = Math.max(1, Number(halfSizeM) || 1);
    uniforms.uUrbanGroundEnabled.value = texture ? 1 : 0;
}

export function clearUrbanGroundSurfaceMask() {
    uniforms.uUrbanGroundMask.value = fallbackMask;
    uniforms.uUrbanGroundEnabled.value = 0;
}

// Sample the generic urban mask for CPU inspection. Explicit land-use paint is
// owned and reported by the shared ground compositor.
function sampleMaskAtLocal(texture, center, halfSizeM, localX, localZ) {
    const image = texture?.image;
    const width = Number(image?.width);
    const height = Number(image?.height);
    const half = Number(halfSizeM);
    if (!image || !Number.isFinite(width) || width < 1
        || !Number.isFinite(height) || height < 1
        || !Number.isFinite(half) || half <= 0) return null;
    const u = (Number(localX) - Number(center?.x) + half) / (half * 2);
    const v = (Number(localZ) - Number(center?.y) + half) / (half * 2);
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) {
        return null;
    }
    const x = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    try {
        if (typeof image.getContext === 'function') {
            const pixel = image.getContext('2d')?.getImageData(x, y, 1, 1)?.data;
            return pixel ? { pixel, u, v } : null;
        }
        if (ArrayBuffer.isView(image.data)) {
            const channels = Math.max(1, Math.round(image.data.length / (width * height)));
            const offset = (y * width + x) * channels;
            return {
                pixel: [
                    image.data[offset] ?? 0,
                    image.data[offset + 1] ?? 0,
                    image.data[offset + 2] ?? 0,
                    image.data[offset + 3] ?? 255,
                ],
                u,
                v,
            };
        }
    } catch (_error) {
        // A tainted/missing canvas cannot compromise the rest of diagnostics.
    }
    return null;
}

// CPU diagnostic twin of the generic urban material mask used below.
export function inspectGroundSurfaceMaterialAtLocal(localX, localZ) {
    let urbanSample = null;
    if (uniforms.uUrbanGroundEnabled.value > 0.5) {
        urbanSample = sampleMaskAtLocal(
            uniforms.uUrbanGroundMask.value,
            uniforms.uUrbanGroundCenter.value,
            uniforms.uUrbanGroundHalfSize.value,
            localX,
            localZ,
        );
    }
    let style = null;
    try {
        style = getLocation()?.terrain?.surfaceStyle || null;
    } catch (_error) {
        // Unit tests and non-browser consumers may not have a current location.
    }
    return groundSurfaceMaterialClassifications({
        urbanPixel: urbanSample?.pixel || null,
        urbanUv: urbanSample ? { u: urbanSample.u, v: urbanSample.v } : null,
        baseStyle: style,
    });
}

// `fieldPatchwork: true` opts a material into the farmland quilt. Off by default so
// it lands on ground surfaces (terrain, ground cover, formation collars) and never on
// things that merely share this shader, like the tram bed.
//
// `urbanGround: false` keeps the supplied base material but skips the
// broad building/road-derived sidewalk catch-all. Civil earth faces use this: an
// embankment beside an urban road is still grass. Without the opt-out its whole overlap collar becomes a pale
// sidewalk strip simply because it is necessarily close to the road it supports.
export function applyUrbanGroundSurface(
    material,
    targetClaim,
    {
        fieldPatchwork = false,
        urbanGround = true,
        urbanGroundUpwardOnly = false,
    } = {},
) {
    if (!material) return material;
    const claim = asSurfaceClaim(targetClaim);
    if (!surfaceClaimMayUseUrbanGround(claim)) {
        material.userData ||= {};
        material.userData.urbanGroundSurfaceRejected = true;
        return material;
    }
    material.userData ||= {};
    material.userData.surfaceClaim = claim;
    if (material.userData.urbanGroundSurface) return material;
    uniforms.uUrbanGroundMap.value = getSidewalkTexture();
    const fields = fieldPatchwork && fieldPatchworkWanted();
    const usesUrbanGround = urbanGround !== false;
    // Formation collars and their cut/fill faces intentionally share one
    // material/batch. The broad city-ground mask belongs on the upward-facing
    // seam that continues the pavement, but not down the exposed earth face.
    // Compile that distinction into the material so the renderer preserves
    // batching instead of splitting every streamed road region in two.
    const limitsUrbanGroundToUpwardFaces = usesUrbanGround
        && urbanGroundUpwardOnly === true;
    if (fields) {
        ensureFieldPatchwork();
        uniforms.uFieldStrength.value = FIELD_PATCHWORK_STRENGTH;
    }
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vUrbanGroundWorldPos;',
                ...(limitsUrbanGroundToUpwardFaces
                    ? ['varying float vUrbanGroundUpness;'] : []),
            ].join('\n'))
            .replace('#include <begin_vertex>', [
                '#include <begin_vertex>',
                'vUrbanGroundWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
                ...(limitsUrbanGroundToUpwardFaces ? [
                    'vUrbanGroundUpness = abs(normalize(mat3(modelMatrix) * normal).y);',
                ] : []),
            ].join('\n'));
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vUrbanGroundWorldPos;',
                ...(limitsUrbanGroundToUpwardFaces
                    ? ['varying float vUrbanGroundUpness;'] : []),
                'uniform sampler2D uUrbanGroundMap;',
                'uniform sampler2D uUrbanGroundMask;',
                'uniform vec2 uUrbanGroundCenter;',
                'uniform float uUrbanGroundHalfSize;',
                'uniform float uUrbanGroundUvPerM;',
                'uniform float uUrbanGroundEnabled;',
                // Field uniforms are declared only for materials that opted in: the
                // uniforms object is shared by every material using this shader, so a
                // runtime `if` would tint the tram bed too. Compile-time it is.
                ...(fields ? [
                    'uniform sampler2D uFieldMap;',
                    'uniform float uFieldUvPerM;',
                    'uniform float uFieldStrength;',
                ] : []),
            ].join('\n'))
            .replace('#include <map_fragment>', [
                '#include <map_fragment>',
                'vec2 urbanGroundAbsoluteXZ = vUrbanGroundWorldPos.xz + uRenderOriginXZ;',
                // urbanMix is hoisted out of the mask-window test so the farmland
                // tint below can still apply where there is no mask at all — open
                // country is exactly where the patchwork matters most.
                'float urbanMix = 0.0;',
                'float roadSeam = 1.0;',
                ...(usesUrbanGround ? [
                'if (uUrbanGroundEnabled > 0.5) {',
                '    vec2 urbanMaskUv = (urbanGroundAbsoluteXZ - uUrbanGroundCenter)',
                '        / (2.0 * uUrbanGroundHalfSize) + 0.5;',
                '    if (urbanMaskUv.x >= 0.0 && urbanMaskUv.x <= 1.0',
                '        && urbanMaskUv.y >= 0.0 && urbanMaskUv.y <= 1.0) {',
                '        float urbanMask = texture2D(uUrbanGroundMask, urbanMaskUv).r;',
                '        float edgeDistance = min(min(urbanMaskUv.x, 1.0 - urbanMaskUv.x),',
                '            min(urbanMaskUv.y, 1.0 - urbanMaskUv.y));',
                '        urbanMask *= smoothstep(0.0, 0.06, edgeDistance);',
                '        urbanMix = smoothstep(0.06, 0.84, urbanMask);',
                // A mapped lawn/forest explicitly restores the terrain's grass
                // material even when it lies inside a building-derived paved
                // neighbourhood mask.
                ...(limitsUrbanGroundToUpwardFaces ? [
                // Sidewalk-like cover may follow ordinary street grades, but
                // stops before a battered cut/fill face. At 20 degrees the
                // surface is still fully paved; a 40-degree earth slope is not.
                '        urbanMix *= smoothstep(0.78, 0.94, vUrbanGroundUpness);',
                ] : []),
                // A field stops at a road. The mask cannot give connected-region
                // ids, but its rising edge IS the road boundary, so a dark band
                // there reads as the hedgerow/verge where one field ends.
                '        roadSeam = 1.0 - 0.38 * smoothstep(0.03, 0.17, urbanMask)',
                '            * (1.0 - smoothstep(0.17, 0.46, urbanMask));',
                '        vec4 urbanTexel = texture2D(',
                '            uUrbanGroundMap, urbanGroundAbsoluteXZ * uUrbanGroundUvPerM',
                '        );',
                '        diffuseColor.rgb = mix(diffuseColor.rgb, urbanTexel.rgb, urbanMix);',
                '    }',
                '}',
                ] : []),
                ...(fields ? [
                    'if (uFieldStrength > 0.001) {',
                    // Bytes encode a 0..2 multiplier with 1.0 at mid-grey, hence the x2.
                    '    vec3 fieldMult = texture2D(',
                    '        uFieldMap, urbanGroundAbsoluteXZ * uFieldUvPerM',
                    '    ).rgb * 2.0;',
                    // Fade the quilt out as the ground turns urban, so pavement and
                    // building surrounds are never tinted like a crop.
                    '    float fieldAmount = uFieldStrength * (1.0 - urbanMix);',
                    '    diffuseColor.rgb *= mix(vec3(1.0), fieldMult * roadSeam, fieldAmount);',
                    '}',
                ] : []),
            ].join('\n'));
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|urban-ground-surface-v7${fields ? '-fields' : ''}`
            + `${usesUrbanGround ? '' : '-no-urban'}`
            + `${limitsUrbanGroundToUpwardFaces ? '-upward-only' : ''}`;
    };
    material.userData.urbanGroundSurface = true;
    material.userData.urbanGroundSurfaceMode = !usesUrbanGround
        ? 'base-only'
        : limitsUrbanGroundToUpwardFaces ? 'upward-only' : 'all-faces';
    material.needsUpdate = true;
    return material;
}
