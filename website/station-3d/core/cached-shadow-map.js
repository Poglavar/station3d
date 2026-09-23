// Skips the directional shadow pass when nothing it would draw has changed: the
// (grid-snapped) light, the caster set and every caster's transform/geometry are
// identical to the last rendered map. three otherwise re-renders the whole map
// every frame; on a dense stationary walk that pass was 23 % of main-thread time
// (2026-09-23).
//
// A static/dynamic split (cache static depth, restore it and redraw only moving
// casters) was built and measured first. On ANGLE/Metal every depth restore,
// even small rectangles, cost +3–4 ms GPU per frame, more than the CPU saved, and
// city traffic keeps casters moving almost every frame. So the map is either
// reused untouched or rendered exactly as three renders it; no copies.
//
// It wraps renderer.shadowMap.render, so the decision uses the frame's current
// matrices. Only the given directional light is handled; anything else falls
// through to three's ordinary render.

import { combineShadowSignatures } from './shadow-caster-cache.js';

function matrixHash(elements, hash) {
    for (let i = 0; i < 16; i++) hash = (Math.imul(hash, 31) + Math.round(elements[i] * 4096)) | 0;
    return hash;
}

function casterSignature(object) {
    let hash = matrixHash(object.matrixWorld.elements, object.id | 0);
    hash = (Math.imul(hash, 31) + (object.geometry?.id | 0)) | 0;
    hash = (Math.imul(hash, 31) + (object.geometry?.attributes?.position?.version | 0)) | 0;
    hash = (Math.imul(hash, 31) + (object.geometry?.drawRange?.count | 0)) | 0;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    hash = (Math.imul(hash, 31) + (material?.id | 0) + (material?.version | 0) * 7) | 0;
    if (object.isInstancedMesh) hash = (Math.imul(hash, 31) + object.instanceMatrix.version * 7 + object.count) | 0;
    if (object.isSkinnedMesh || object.morphTargetInfluences?.length) hash = (hash + performance.now() * 1000) | 0;
    return hash;
}

function lightSignature(light) {
    const camera = light.shadow.camera;
    let hash = matrixHash(light.matrixWorld.elements, 7);
    hash = matrixHash(light.target.matrixWorld.elements, hash);
    for (const value of [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far,
        light.shadow.mapSize.x, light.shadow.mapSize.y, light.shadow.bias, light.shadow.normalBias]) {
        hash = (Math.imul(hash, 31) + Math.round(value * 1000)) | 0;
    }
    return hash;
}

export function createCachedShadowMap({ renderer, scene, light } = {}) {
    if (!renderer?.shadowMap || !scene || !light?.isDirectionalLight) {
        throw new TypeError('Cached shadow map requires a renderer, scene and directional light');
    }
    const shadowMap = renderer.shadowMap;
    const originalRender = shadowMap.render;
    let lastSignature = null, lastMap = null, disposed = false, enabled = true;
    const stats = { renderedFrames: 0, skippedFrames: 0 };
    const signatures = [];

    shadowMap.render = function cachedShadowRender(lights, targetScene, camera) {
        const map = light.shadow.map;
        if (!enabled || disposed || targetScene !== scene || lights.length !== 1 || lights[0] !== light
            || !(shadowMap.autoUpdate || shadowMap.needsUpdate) || !map) {
            lastSignature = null;
            return originalRender.call(this, lights, targetScene, camera);
        }
        signatures.length = 0;
        scene.traverseVisible(object => {
            if (object.castShadow && (object.isMesh || object.isLine || object.isPoints)) signatures.push(casterSignature(object));
        });
        const signature = combineShadowSignatures(signatures, lightSignature(light), shadowMap.type);
        if (signature === lastSignature && map === lastMap && !shadowMap.needsUpdate && !light.shadow.needsUpdate) {
            stats.skippedFrames += 1;
            return undefined;
        }
        const result = originalRender.call(this, lights, targetScene, camera);
        lastSignature = signature;
        lastMap = light.shadow.map;
        stats.renderedFrames += 1;
        return result;
    };

    return Object.freeze({
        snapshot: () => ({ enabled, ...stats }),
        // Diagnostic A/B switch: off renders the map every frame, as three does.
        setEnabled(value) { enabled = value !== false; lastSignature = null; },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (shadowMap.render.name === 'cachedShadowRender') shadowMap.render = originalRender;
        },
    });
}
