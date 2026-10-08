import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createGroundPaintMaterialState, bindGroundPaintMaterial } from '../core/ground-paint-material.js';
import { compileSurfaceClaim, SURFACE_CLASS, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { createWorldGroundPaint } from '../world/ground-paint.js';

const receiver = key => ({ key, verticalBand: 'ground', coverageRevision: 'ordinary-ground-v1' });
const passiveEdgingClaim = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.PASSIVE_EDGING,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ownerId: 'decor-passive-edging',
});

function createSession() {
    let materialState;
    const paint = createWorldGroundPaint({ renderer: {}, registry: {}, boundary: {},
        cacheFactory: ({ receiver: paintReceiver }) => {
            materialState = createGroundPaintMaterialState({ receiver: paintReceiver });
            return { materialState, dispose() { materialState.dispose(); } };
        } });
    return { paint, get materialState() { return materialState; } };
}

function rootWith(material, claim = passiveEdgingClaim) {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.userData.surfaceClaim = claim;
    root.add(mesh);
    return root;
}

function shaderFixture() {
    return {
        uniforms: {},
        vertexShader: '#include <common>\nvoid main() {\n#include <worldpos_vertex>\n}',
        fragmentShader: 'void main() {\n#include <common>\n#include <alphatest_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n}',
    };
}

function disposeRoot(root) {
    root.traverse(object => object.geometry?.dispose());
}

test('a shared greenery material can bind again after the first ground-paint session closes', () => {
    const sharedMaterial = new THREE.MeshStandardMaterial({ color: 0x697b52 });
    sharedMaterial.userData.surfaceClaim = passiveEdgingClaim;
    const first = createSession(), firstRoot = rootWith(sharedMaterial);
    const second = createSession(), secondRoot = rootWith(sharedMaterial);
    try {
        first.paint.bindRoot(firstRoot);
        const firstReceiver = first.paint.receiver;
        assert.equal(sharedMaterial.userData.groundPaintReceiver.key, firstReceiver.key);
        first.paint.dispose();

        assert.doesNotThrow(() => second.paint.bindRoot(secondRoot));
        assert.equal(sharedMaterial.userData.groundPaintReceiver.key, second.paint.receiver.key);
        assert.notEqual(second.paint.receiver.key, firstReceiver.key);

        const shader = shaderFixture();
        sharedMaterial.onBeforeCompile(shader, {});
        assert.equal(shader.vertexShader.match(/varying vec2 vReceiverPaintXZ;/g)?.length, 1,
            'reopening must install one receiver shader patch, not nest the previous session patch');
        assert.ok(shader.uniforms.uReceiverPaintStyles.value?.isDataTexture,
            'the rebound material must reference a live paint style table');
    } finally {
        first.paint.dispose();
        second.paint.dispose();
        disposeRoot(firstRoot); disposeRoot(secondRoot); sharedMaterial.dispose();
    }
});

test('live receiver ownership is exclusive and handle disposal restores the exact base hooks', () => {
    const material = new THREE.MeshStandardMaterial();
    const baseCompile = material.onBeforeCompile;
    const baseCacheKey = material.customProgramCacheKey;
    const baseRender = material.onBeforeRender;
    material.userData.surfaceClaim = passiveEdgingClaim;
    material.userData.keep = 'caller metadata';
    const firstState = createGroundPaintMaterialState({ receiver: receiver('receiver-one') });
    const secondState = createGroundPaintMaterialState({ receiver: receiver('receiver-two') });
    try {
        const first = bindGroundPaintMaterial(material, { state: firstState });
        assert.equal(material._listeners?.dispose?.length, 1);
        assert.throws(() => bindGroundPaintMaterial(material, { state: secondState }), /already belongs/);

        assert.equal(first.dispose(), true);
        assert.equal(first.dispose(), false);
        assert.equal(firstState.disposed, false, 'disposing a binding must leave its explicit shared state open');
        assert.equal(material.onBeforeCompile, baseCompile);
        assert.equal(material.customProgramCacheKey, baseCacheKey);
        assert.equal(material.onBeforeRender, baseRender);
        assert.equal(material.userData.groundPaintReceiver, undefined);
        assert.equal(material.userData.keep, 'caller metadata');
        assert.equal(material._listeners?.dispose?.length || 0, 0);

        const second = bindGroundPaintMaterial(material, { state: secondState });
        assert.equal(material.userData.groundPaintReceiver.key, 'receiver-two');
        first.dispose(); // A stale prior handle must not detach the current receiver.
        assert.equal(material.userData.groundPaintReceiver.key, 'receiver-two');
        second.dispose();
        assert.equal(secondState.disposed, false);
    } finally {
        firstState.dispose(); secondState.dispose(); material.dispose();
    }
});

test('material disposal releases its binding and closes only a binding-owned state', () => {
    const sharedState = createGroundPaintMaterialState({ receiver: receiver('shared-state') });
    const sharedMaterial = new THREE.MeshStandardMaterial();
    const ownedMaterial = new THREE.MeshStandardMaterial();
    const ownedByHandleMaterial = new THREE.MeshStandardMaterial();
    const sharedBaseCompile = sharedMaterial.onBeforeCompile;
    let sharedHandle, ownedHandle, ownedByHandle;
    try {
        sharedHandle = bindGroundPaintMaterial(sharedMaterial, { state: sharedState });
        sharedMaterial.dispose();
        assert.equal(sharedState.disposed, false);
        assert.equal(sharedMaterial._listeners?.dispose?.length || 0, 0);
        assert.equal(sharedHandle.dispose(), false);
        assert.equal(sharedMaterial.userData.groundPaintReceiver, undefined);
        assert.equal(sharedMaterial.onBeforeCompile, sharedBaseCompile);

        ownedByHandle = bindGroundPaintMaterial(ownedByHandleMaterial, { receiver: receiver('owned-by-handle') });
        const handleOwnedState = ownedByHandle.state;
        assert.equal(ownedByHandle.dispose(), true);
        assert.equal(handleOwnedState.disposed, true);
        assert.equal(ownedByHandleMaterial._listeners?.dispose?.length || 0, 0);

        ownedHandle = bindGroundPaintMaterial(ownedMaterial, { receiver: receiver('owned-state') });
        const ownedState = ownedHandle.state;
        ownedMaterial.dispose();
        assert.equal(ownedState.disposed, true);
        assert.equal(ownedMaterial._listeners?.dispose?.length || 0, 0);
        assert.equal(ownedHandle.dispose(), false);
    } finally {
        sharedHandle?.dispose(); ownedHandle?.dispose(); ownedByHandle?.dispose();
        sharedState.dispose();
        sharedMaterial.dispose(); ownedMaterial.dispose(); ownedByHandleMaterial.dispose();
    }
});

test('state disposal releases every material without overwriting hooks installed by another owner', () => {
    const state = createGroundPaintMaterialState({ receiver: receiver('many-materials') });
    const materials = Array.from({ length: 3 }, () => new THREE.MeshStandardMaterial());
    const baseHooks = materials.map(material => material.onBeforeCompile);
    const handles = materials.map(material => bindGroundPaintMaterial(material, { state }));
    const replacement = () => {};
    materials[1].onBeforeCompile = replacement;
    try {
        assert.equal(state.dispose(), true);
        assert.equal(state.dispose(), false);
        for (let index = 0; index < materials.length; index++) {
            assert.equal(handles[index].disposed, true);
            assert.equal(handles[index].dispose(), false);
            assert.equal(materials[index].onBeforeCompile, index === 1 ? replacement : baseHooks[index]);
            assert.equal(materials[index]._listeners?.dispose?.length || 0, 0);
            assert.equal(materials[index].userData.groundPaintReceiver, undefined);
        }
    } finally {
        state.dispose();
        for (const material of materials) material.dispose();
    }
});

test('binding retirement releases cached renderer uniforms and does not recursively dispose a material', () => {
    const state = createGroundPaintMaterialState({ receiver: receiver('renderer-cache') });
    const material = new THREE.MeshStandardMaterial();
    const handle = bindGroundPaintMaterial(material, { state });
    const shader = shaderFixture();
    material.onBeforeCompile(shader, {});
    let cachedUniforms = shader.uniforms, disposalEvents = 0;
    // WebGLRenderer retains these uniforms until the material's dispose event;
    // needsUpdate alone reuses the same customProgramCacheKey entry.
    const onDispose = () => { cachedUniforms = null; disposalEvents++; };
    material.addEventListener('dispose', onDispose);
    try {
        state.dispose();
        assert.equal(cachedUniforms, null);
        assert.equal(disposalEvents, 1);
        assert.equal(handle.dispose(), false);
        assert.equal(disposalEvents, 1);

        const next = bindGroundPaintMaterial(material, { receiver: receiver('renderer-cache-next') });
        material.dispose();
        assert.equal(disposalEvents, 2, 'an external material disposal must dispatch once, without recursion');
        assert.equal(next.disposed, true);
        assert.equal(next.state.disposed, true);
    } finally {
        material.removeEventListener('dispose', onDispose);
        state.dispose(); material.dispose();
    }
});
