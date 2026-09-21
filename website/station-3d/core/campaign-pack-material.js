// Builds the Three.js material for one baked campaign-pack material descriptor.
// Kept apart from the scene and renderer, so the rules a baked level depends on
// (the multiply-blended contact shadows above all) are unit-tested in node.

import * as THREE from 'three';

import { finiteOrNull } from './math.js';

const DEFAULT_COLORS = Object.freeze({
    terrain: 0x71845a,
    road: 0x35383b,
    sidewalk: 0xa7a49b,
    path: 0x938f83,
    rail: 0x5d5b56,
    building: 0xc1b8aa,
    water: 0x487c9d,
});

function colorValue(value, fallback) {
    if (typeof value === 'string' || Number.isFinite(value)) return value;
    return fallback;
}

function textureFromDescriptor(loader, value) {
    if (ArrayBuffer.isView(value?.encodedData) && String(value.mimeType || '').startsWith('image/')) {
        const blobUrl = URL.createObjectURL(new Blob([value.encodedData], { type: value.mimeType }));
        const texture = loader.load(blobUrl, () => URL.revokeObjectURL(blobUrl));
        texture.colorSpace = value.colorSpace === 'linear'
            ? THREE.NoColorSpace
            : THREE.SRGBColorSpace;
        if (Array.isArray(value.repeat)) texture.repeat.set(Number(value.repeat[0]) || 1, Number(value.repeat[1]) || 1);
        if (Array.isArray(value.offset)) texture.offset.set(Number(value.offset[0]) || 0, Number(value.offset[1]) || 0);
        texture.wrapS = value.wrapS === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.wrapT = value.wrapT === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.flipY = value.flipY !== false;
        return texture;
    }
    if (ArrayBuffer.isView(value?.data)
        && Number.isInteger(value.width) && Number.isInteger(value.height)) {
        const texture = new THREE.DataTexture(value.data, value.width, value.height, THREE.RGBAFormat);
        texture.colorSpace = value.colorSpace === 'linear'
            ? THREE.NoColorSpace
            : THREE.SRGBColorSpace;
        if (Array.isArray(value.repeat)) texture.repeat.set(Number(value.repeat[0]) || 1, Number(value.repeat[1]) || 1);
        if (Array.isArray(value.offset)) texture.offset.set(Number(value.offset[0]) || 0, Number(value.offset[1]) || 0);
        texture.wrapS = value.wrapS === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.wrapT = value.wrapT === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        texture.flipY = value.flipY !== false;
        texture.needsUpdate = true;
        return texture;
    }
    const url = String(value?.url || '').trim();
    if (!url) return null;
    const texture = loader.load(url);
    texture.colorSpace = value.colorSpace === 'linear'
        ? THREE.NoColorSpace
        : THREE.SRGBColorSpace;
    if (Array.isArray(value.repeat)) texture.repeat.set(Number(value.repeat[0]) || 1, Number(value.repeat[1]) || 1);
    if (Array.isArray(value.offset)) texture.offset.set(Number(value.offset[0]) || 0, Number(value.offset[1]) || 0);
    texture.wrapS = value.wrapS === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.wrapT = value.wrapT === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.flipY = value.flipY !== false;
    return texture;
}

export function createCampaignPackMaterial(descriptorValue, key, loader) {
    const descriptor = descriptorValue || {};
    const semantic = String(descriptor.semantic || key || '').split(':')[0];
    const fallback = DEFAULT_COLORS[semantic] ?? 0xb8b3aa;
    const opacity = finiteOrNull(descriptor.opacity) ?? 1;
    const roughness = finiteOrNull(descriptor.roughness) ?? 0.86;
    const metalness = finiteOrNull(descriptor.metalness) ?? 0;
    const common = {
        color: colorValue(descriptor.color, fallback),
        map: textureFromDescriptor(loader, descriptor.map),
        opacity,
        transparent: descriptor.transparent === true || opacity < 1,
        vertexColors: descriptor.vertexColors === true,
        side: descriptor.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: descriptor.depthWrite !== false,
        depthTest: descriptor.depthTest !== false,
    };
    let material;
    if (descriptor.type === 'MeshBasicMaterial') {
        material = new THREE.MeshBasicMaterial(common);
    } else if (descriptor.type === 'MeshLambertMaterial') {
        material = new THREE.MeshLambertMaterial(common);
    } else if (descriptor.type === 'MeshPhongMaterial') {
        material = new THREE.MeshPhongMaterial({
            ...common,
            shininess: Number(descriptor.shininess) || 30,
        });
    } else {
        material = new THREE.MeshStandardMaterial({
            ...common,
            roughness,
            metalness,
        });
    }
    material.name = `CampaignPack:${key}`;
    material.alphaTest = Number(descriptor.alphaTest) || 0;
    // A darkening overlay (the contact-AO skirts) multiplies what is under it;
    // fog would drag its factor toward the fog colour at distance.
    if (descriptor.blending === 'multiply') {
        material.blending = THREE.MultiplyBlending;
        // three binds a multiply blend only for a premultiplied material; without
        // this it logs an error every frame and draws the skirt opaque (pale bands
        // along every facade in the baked Zagreb level, 2026-09-11).
        material.premultipliedAlpha = true;
        material.transparent = true;
        material.fog = false;
    }
    if (descriptor.polygonOffset) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = Number(descriptor.polygonOffset.factor) || 0;
        material.polygonOffsetUnits = Number(descriptor.polygonOffset.units) || 0;
    }
    return material;
}
