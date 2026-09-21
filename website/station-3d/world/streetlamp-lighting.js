// Shared conformal street-lamp illumination for ground-facing materials.
// Streetlamp positions are selected once per frame and reused by every road,
// pavement, trackbed, curb, and curb-ramp shader without a floating glow mesh.

import * as THREE from 'three';
import { bindRenderOriginShader } from '../core/render-origin.js';

const STREET_LAMP_COUNT = 8;
const STREET_LAMP_MOVE_REFRESH_M = 4;
const DEFAULT_RADIUS_M = 7;
const DEFAULT_STRENGTH = 0.2;

const streetLampUniforms = {
    positions: { value: Array.from({ length: STREET_LAMP_COUNT }, () => new THREE.Vector3()) },
    count: { value: 0 },
    radius: { value: DEFAULT_RADIUS_M },
    enabled: { value: 0 },
};

let lastX = Infinity;
let lastZ = Infinity;
let lastRevision = -1;

export function applyStreetLampSurfaceLighting(material, strength = DEFAULT_STRENGTH) {
    if (!material || material.userData.streetLampSurfaceLighting) return material;

    const lampStrength = Number.isFinite(strength) && strength >= 0 ? strength : DEFAULT_STRENGTH;
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        shader.uniforms.streetLampPositions = streetLampUniforms.positions;
        shader.uniforms.streetLampCount = streetLampUniforms.count;
        shader.uniforms.streetLampRadius = streetLampUniforms.radius;
        shader.uniforms.streetLampEnabled = streetLampUniforms.enabled;
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vStreetLampSurfaceWorldPosition;',
            )
            .replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nvStreetLampSurfaceWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
varying vec3 vStreetLampSurfaceWorldPosition;
uniform vec3 streetLampPositions[${STREET_LAMP_COUNT}];
uniform int streetLampCount;
uniform float streetLampRadius;
uniform float streetLampEnabled;`,
            )
            .replace(
                '#include <tonemapping_fragment>',
                `float streetLampSurfaceFalloff = 0.0;
for (int streetLampIndex = 0; streetLampIndex < ${STREET_LAMP_COUNT}; streetLampIndex++) {
    if (streetLampIndex >= streetLampCount) break;
    vec2 streetLampSurfaceAbsoluteXZ = vStreetLampSurfaceWorldPosition.xz + uRenderOriginXZ;
    float streetLampDistance = distance(streetLampSurfaceAbsoluteXZ, streetLampPositions[streetLampIndex].xz);
    float streetLampFalloff = clamp(1.0 - streetLampDistance / streetLampRadius, 0.0, 1.0);
    streetLampFalloff = streetLampFalloff * streetLampFalloff * (3.0 - 2.0 * streetLampFalloff);
    // XZ-only falloff painted the glow disc onto ANY surface stacked above or
    // below the lamp — a viaduct deck 7.5 m over a street lamp caught a full
    // light spot. The vertical band keeps the glow on the level the lamp
    // actually serves (its own ground plane, ± a curb's worth).
    float streetLampVerticalM = abs(vStreetLampSurfaceWorldPosition.y - streetLampPositions[streetLampIndex].y);
    streetLampFalloff *= 1.0 - smoothstep(2.5, 5.0, streetLampVerticalM);
    streetLampSurfaceFalloff = max(streetLampSurfaceFalloff, streetLampFalloff);
}
gl_FragColor.rgb += vec3(1.0, 0.70, 0.38) * streetLampSurfaceFalloff * streetLampEnabled * ${lampStrength.toFixed(4)};
#include <tonemapping_fragment>`,
            );
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|streetlamp-surface-v3`;
    };
    material.userData.streetLampSurfaceLighting = true;
    material.userData.streetLampSurfaceLightingStrength = lampStrength;
    material.needsUpdate = true;
    return material;
}

export function updateStreetLampSurfaceLighting(positions, localX, localZ, radius, revision = 0) {
    const moved = Math.hypot(localX - lastX, localZ - lastZ);
    if (revision === lastRevision && moved < STREET_LAMP_MOVE_REFRESH_M) return;
    lastX = localX;
    lastZ = localZ;
    lastRevision = revision;

    const nearest = [];
    for (const position of positions || []) {
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
        const dx = position.x - localX;
        const dz = position.z - localZ;
        const distanceSq = dx * dx + dz * dz;
        if (nearest.length < STREET_LAMP_COUNT) {
            nearest.push({ position, distanceSq });
            nearest.sort((a, b) => b.distanceSq - a.distanceSq);
        } else if (distanceSq < nearest[0].distanceSq) {
            nearest[0] = { position, distanceSq };
            nearest.sort((a, b) => b.distanceSq - a.distanceSq);
        }
    }
    nearest.sort((a, b) => a.distanceSq - b.distanceSq);
    for (let i = 0; i < STREET_LAMP_COUNT; i++) {
        const source = nearest[i] && nearest[i].position;
        streetLampUniforms.positions.value[i].set(
            source ? source.x : 0,
            source && Number.isFinite(source.y) ? source.y : 0,
            source ? source.z : 0,
        );
    }
    streetLampUniforms.count.value = nearest.length;
    streetLampUniforms.radius.value = Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_RADIUS_M;
}

export function setStreetLampSurfaceNightMode(night) {
    streetLampUniforms.enabled.value = night ? 1 : 0;
}

export function resetStreetLampSurfaceLighting() {
    lastX = Infinity;
    lastZ = Infinity;
    lastRevision = -1;
    streetLampUniforms.count.value = 0;
    streetLampUniforms.enabled.value = 0;
}

export function getStreetLampSurfaceLightingState() {
    return {
        count: streetLampUniforms.count.value,
        radius: streetLampUniforms.radius.value,
        enabled: streetLampUniforms.enabled.value > 0,
    };
}
