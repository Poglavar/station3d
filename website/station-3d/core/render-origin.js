// Scene-wide floating origin for long free-roam sessions.
//
// Layer caches, tile ids, terrain queries, and physics all keep using the
// session's absolute local metres. Only the Three scene root and camera are
// translated for rendering, so a country-scale trip never feeds very large XZ
// values to the GPU and no streamed object needs to be rebuilt during a rebase.

import * as THREE from 'three';

export const RENDER_ORIGIN_REBASE_M = 2000;

const renderOrigin = { x: 0, z: 0 };
const installedAfterRenderScenes = new WeakSet();
let activeRenderTransform = null;

// Every world-space shader hook shares this exact uniform object. Materials
// that compose several hooks therefore see one atomic origin update.
export const renderOriginUniform = { value: new THREE.Vector2(0, 0) };

function finiteCoordinate(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function getRenderOrigin() {
    return { x: renderOrigin.x, z: renderOrigin.z };
}

export function resolveRenderOriginRebase(
    origin,
    focus,
    thresholdM = RENDER_ORIGIN_REBASE_M,
) {
    const originX = finiteCoordinate(origin?.x);
    const originZ = finiteCoordinate(origin?.z);
    const focusX = finiteCoordinate(focus?.x, originX);
    const focusZ = finiteCoordinate(focus?.z, originZ);
    const threshold = Math.max(1, finiteCoordinate(thresholdM, RENDER_ORIGIN_REBASE_M));
    if (Math.hypot(focusX - originX, focusZ - originZ) < threshold) return null;
    return { x: focusX, z: focusZ };
}

export function setSceneRenderOrigin(scene, origin) {
    const x = finiteCoordinate(origin?.x);
    const z = finiteCoordinate(origin?.z);
    const changed = x !== renderOrigin.x || z !== renderOrigin.z;
    renderOrigin.x = x;
    renderOrigin.z = z;
    renderOriginUniform.value.set(x, z);
    if (scene?.position) {
        scene.position.x = x === 0 ? 0 : -x;
        scene.position.z = z === 0 ? 0 : -z;
    }
    return changed;
}

export function resetSceneRenderOrigin(scene) {
    restoreAbsoluteRenderCoordinates();
    return setSceneRenderOrigin(scene, { x: 0, z: 0 });
}

// Call only after the camera has been positioned in absolute session-local
// coordinates for the current frame. Its orientation is already correct:
// translating camera and target by the same XZ vector does not change it.
export function compensateCameraForRenderOrigin(camera) {
    if (!camera?.position) return;
    camera.position.x -= renderOrigin.x;
    camera.position.z -= renderOrigin.z;
}

export function restoreAbsoluteRenderCoordinates() {
    const active = activeRenderTransform;
    if (!active) return false;
    activeRenderTransform = null;
    if (active.scene?.position) {
        active.scene.position.x = 0;
        active.scene.position.z = 0;
    }
    if (active.camera?.position) {
        active.camera.position.x += active.x;
        active.camera.position.z += active.z;
    }
    return true;
}

function installAfterRenderRestore(scene) {
    if (!scene || installedAfterRenderScenes.has(scene)) return;
    const previousAfterRender = scene.onAfterRender;
    scene.onAfterRender = function renderOriginAfterRender(...args) {
        try {
            if (typeof previousAfterRender === 'function') {
                previousAfterRender.apply(this, args);
            }
        } finally {
            restoreAbsoluteRenderCoordinates();
        }
    };
    installedAfterRenderScenes.add(scene);
}

// Apply as the final before-render operation. Three invokes Scene.onAfterRender
// after the complete render pass; the installed restore then puts both objects
// back into absolute CPU coordinates before events or idle work can run.
export function applyRenderOriginForRender(scene, camera) {
    restoreAbsoluteRenderCoordinates();
    installAfterRenderRestore(scene);
    const x = renderOrigin.x;
    const z = renderOrigin.z;
    if (scene?.position) {
        scene.position.x = x === 0 ? 0 : -x;
        scene.position.z = z === 0 ? 0 : -z;
    }
    compensateCameraForRenderOrigin(camera);
    activeRenderTransform = { scene, camera, x, z };
}

// Shader hooks are deliberately composable. This binder is idempotent, so a
// material using ground ownership + planner cutout + street-lamp lighting gets
// one GLSL declaration instead of three duplicate-uniform compile errors.
export function bindRenderOriginShader(shader) {
    if (!shader?.uniforms) return;
    shader.uniforms.uRenderOriginXZ = renderOriginUniform;
    if (!shader.fragmentShader || shader.fragmentShader.includes('uniform vec2 uRenderOriginXZ;')) {
        return;
    }
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform vec2 uRenderOriginXZ;',
    );
}
