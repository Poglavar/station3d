// One opaque mesh/material per head, also usable as one instanced crowd draw.
// Face selection is a vertex/instance attribute; the material and atlas are
// shared. Distance fading runs in the shader, without per-person frame work.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { station3dAssetUrl } from '../core/asset-url.js';
import {
    CROWD_FACE_COLUMNS, CROWD_FACE_COUNT, CROWD_FACE_NEAR_M, CROWD_FACE_FAR_M,
} from '../core/person-appearance.js';

const geometryCache = new Map();
const materialCache = new Map();
let baseGeometry = null;
let atlas = null;

function tag(geometry, feature) {
    geometry.setAttribute('headFeature', new THREE.Float32BufferAttribute(
        new Float32Array(geometry.getAttribute('position').count).fill(feature), 1));
    return geometry;
}

function getBaseGeometry() {
    if (baseGeometry) return baseGeometry;
    const skull = new THREE.SphereGeometry(1, 12, 8).toNonIndexed();
    const positions = skull.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
        const jaw = 1 - Math.max(0, -positions.getY(i) - 0.25) * 0.16;
        positions.setX(i, positions.getX(i) * jaw);
    }
    skull.computeVertexNormals();
    const parts = [tag(skull, 0)];
    // A short wedge nose, with its base buried in the head.
    const nose = new THREE.BufferGeometry();
    nose.setAttribute('position', new THREE.Float32BufferAttribute([
        -0.105, -0.22, 0.9, 0.105, -0.22, 0.9, 0, 0.13, 0.96, 0, -0.16, 1.19,
    ], 3));
    nose.setIndex([0, 3, 2, 2, 3, 1, 1, 3, 0]);
    nose.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(8), 2));
    nose.computeVertexNormals();
    const flatNose = nose.toNonIndexed();
    nose.dispose();
    parts.push(tag(flatNose, 1));
    for (const side of [-1, 1]) {
        const ear = new THREE.OctahedronGeometry(1, 0);
        ear.scale(0.14, 0.2, 0.13);
        ear.translate(side * 0.94, -0.025, 0);
        parts.push(tag(ear, 2));
    }
    baseGeometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    baseGeometry.computeBoundingBox();
    baseGeometry.computeBoundingSphere();
    registerShared(baseGeometry);
    return baseGeometry;
}

export function getPersonHeadGeometry(variant) {
    if (!Number.isInteger(variant) || variant < 0 || variant >= CROWD_FACE_COUNT) {
        throw new RangeError('Invalid crowd face variant.');
    }
    let geometry = geometryCache.get(variant);
    if (!geometry) {
        geometry = getBaseGeometry().clone();
        geometry.setAttribute('headVariant', new THREE.Float32BufferAttribute(
            new Float32Array(geometry.getAttribute('position').count).fill(variant), 1));
        registerShared(geometry);
        geometryCache.set(variant, geometry);
    }
    return geometry;
}

export function createInstancedPersonHeadGeometry(variants) {
    // This geometry belongs to its platform group; disposeGroup releases it.
    const geometry = getBaseGeometry().clone();
    geometry.setAttribute('headVariant', new THREE.InstancedBufferAttribute(
        Float32Array.from(variants), 1));
    return geometry;
}

function getAtlas() {
    if (!atlas) {
        // Creating geometry in headless tests must not require a browser DOM.
        atlas = typeof document === 'undefined' ? new THREE.Texture() : new THREE.TextureLoader().load(
            station3dAssetUrl('assets/people/crowd-faces.png'));
        atlas.colorSpace = THREE.SRGBColorSpace;
        atlas.minFilter = THREE.LinearFilter;
        atlas.magFilter = THREE.LinearFilter;
        atlas.generateMipmaps = false;
        registerShared(atlas);
    }
    return atlas;
}

export function getPersonHeadMaterial(skinColor = 0xffffff, { unlit = false } = {}) {
    const key = String(skinColor) + '|' + unlit;
    let material = materialCache.get(key);
    if (material) return material;
    material = unlit
        ? new THREE.MeshBasicMaterial({ color: skinColor })
        : new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.85 });
    const texture = getAtlas();
    // Keep the atlas discoverable by texture prewarm/disposal tools. Its alpha
    // blends markings into skin in the shader; the head itself stays opaque.
    material.map = texture;
    material.customProgramCacheKey = () => 'station3d-crowd-head-v1';
    material.onBeforeCompile = shader => {
        shader.vertexShader = [
            'attribute float headVariant;',
            'attribute float headFeature;',
            'varying vec2 vCrowdHeadUv;',
            'varying float vCrowdVariant;',
            'varying float vCrowdFeature;',
            'varying float vCrowdDetail;',
            shader.vertexShader,
        ].join('\n').replace('#include <begin_vertex>', [
            '#include <begin_vertex>',
            'vCrowdHeadUv = uv;',
            'vCrowdVariant = headVariant;',
            'vCrowdFeature = headFeature;',
            'vec4 crowdCentre = vec4(0.0, 0.0, 0.0, 1.0);',
            '#ifdef USE_INSTANCING',
            'crowdCentre = instanceMatrix * crowdCentre;',
            '#endif',
            'float crowdDistance = length((modelViewMatrix * crowdCentre).xyz);',
            'vCrowdDetail = 1.0 - smoothstep(' + CROWD_FACE_NEAR_M.toFixed(1) + ', '
                + CROWD_FACE_FAR_M.toFixed(1) + ', crowdDistance);',
            'if (headFeature > 0.5 && headFeature < 1.5) {',
            '    transformed.x *= 0.82 + mod(headVariant, 5.0) * 0.09;',
            '    transformed.z = mix(0.7, transformed.z, vCrowdDetail);',
            '}',
            'if (headFeature > 1.5) transformed.x *= mix(0.85, 1.0, vCrowdDetail);',
        ].join('\n'));
        shader.fragmentShader = [
            'varying vec2 vCrowdHeadUv;',
            'varying float vCrowdVariant;',
            'varying float vCrowdFeature;',
            'varying float vCrowdDetail;',
            shader.fragmentShader,
        ].join('\n').replace('#include <color_fragment>', [
            '#include <color_fragment>',
            'if (vCrowdFeature < 0.5 && vCrowdDetail > 0.001) {',
            '    float column = mod(vCrowdVariant, ' + CROWD_FACE_COLUMNS.toFixed(1) + ');',
            // PNG rows are top-down; texture UVs are bottom-up.
            '    float row = ' + (CROWD_FACE_COLUMNS - 1).toFixed(1) + ' - floor(vCrowdVariant / '
                + CROWD_FACE_COLUMNS.toFixed(1) + ');',
            '    vec2 faceUv = (vec2(column, row) + vec2(fract(vCrowdHeadUv.x), vCrowdHeadUv.y)) / '
                + CROWD_FACE_COLUMNS.toFixed(1) + ';',
            '    vec4 markings = texture2D(map, faceUv);',
            '    diffuseColor.rgb = mix(diffuseColor.rgb, markings.rgb, markings.a * vCrowdDetail);',
            '}',
        ].join('\n')).replace('#include <map_fragment>', '');
    };
    registerShared(material);
    materialCache.set(key, material);
    return material;
}

export function preparePersonHeadAssets() {
    getAtlas();
    for (let variant = 0; variant < CROWD_FACE_COUNT; variant++) getPersonHeadGeometry(variant);
}

export function disposePersonHeadCaches() {
    for (const resource of [baseGeometry, atlas, ...geometryCache.values(), ...materialCache.values()]) {
        if (!resource) continue;
        unregisterShared(resource);
        resource.dispose();
    }
    baseGeometry = atlas = null;
    geometryCache.clear();
    materialCache.clear();
}
