// THREE adapter for the canonical surface hierarchy. Surface producers pass a
// semantic claim; this module alone translates it into concrete stencil state.

import * as THREE from 'three';
import {
    asSurfaceClaim,
    SURFACE_STENCIL_COMPARE,
    SURFACE_STENCIL_OPERATION,
    compileSurfaceRenderContract,
    surfaceStencilContract,
} from '../core/surface-hierarchy.js';
import { surfaceClaimForObject } from '../core/surface-claim.js';

const STENCIL_FUNCTION = Object.freeze({
    [SURFACE_STENCIL_COMPARE.ALWAYS]: THREE.AlwaysStencilFunc,
    [SURFACE_STENCIL_COMPARE.EQUAL]: THREE.EqualStencilFunc,
    [SURFACE_STENCIL_COMPARE.NOT_EQUAL]: THREE.NotEqualStencilFunc,
});

const STENCIL_OPERATION = Object.freeze({
    [SURFACE_STENCIL_OPERATION.KEEP]: THREE.KeepStencilOp,
    [SURFACE_STENCIL_OPERATION.REPLACE]: THREE.ReplaceStencilOp,
});

export function applySurfaceStencil(material, claim) {
    if (!material || typeof material !== 'object') {
        throw new TypeError('Surface stencil target must be a material');
    }
    const renderContract = compileSurfaceRenderContract(claim);
    const stencil = surfaceStencilContract(renderContract.claim);
    material.userData ||= {};
    const baseState = material.userData.surfaceStencilBaseState || Object.freeze({
        colorWrite: material.colorWrite !== false,
        depthTest: material.depthTest !== false,
        depthWrite: material.depthWrite !== false,
    });
    material.userData.surfaceStencilBaseState = baseState;
    material.userData.surfaceClaim = renderContract.claim;
    material.userData.surfaceRenderContract = renderContract;
    material.userData.surfaceStencilContract = stencil;
    // Claims may be revised when an aggregate moves from unknown/building to
    // published. Restore the producer's original non-stencil state first so a
    // former mask/prepass cannot leave invisible colour or disabled depth on a
    // later visible material generation.
    material.colorWrite = baseState.colorWrite;
    material.depthTest = baseState.depthTest;
    material.depthWrite = baseState.depthWrite;
    material.stencilWrite = stencil.enabled;
    if (!stencil.enabled) return material;
    material.stencilRef = stencil.ref;
    material.stencilFunc = STENCIL_FUNCTION[stencil.compare];
    material.stencilFuncMask = stencil.funcMask;
    material.stencilWriteMask = stencil.writeMask;
    material.stencilFail = THREE.KeepStencilOp;
    material.stencilZFail = THREE.KeepStencilOp;
    material.stencilZPass = STENCIL_OPERATION[stencil.zPass];
    if (typeof stencil.colorWrite === 'boolean') material.colorWrite = stencil.colorWrite;
    if (typeof stencil.depthTest === 'boolean') material.depthTest = stencil.depthTest;
    if (typeof stencil.depthWrite === 'boolean') material.depthWrite = stencil.depthWrite;
    return material;
}

export function surfaceRenderContractForMaterial(material) {
    return material?.userData?.surfaceRenderContract || null;
}

function applyMaterialDrawContract(material, claim) {
    if (!material || typeof material !== 'object') return;
    const technical = claim.technical;
    material.userData ||= {};
    material.userData.surfaceDrawContract = technical;
    if (technical.polygonOffset) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = technical.polygonOffset.factor;
        material.polygonOffsetUnits = technical.polygonOffset.units;
    }
    if (typeof technical.depthTest === 'boolean') {
        material.depthTest = technical.depthTest;
    }
    if (typeof technical.depthWrite === 'boolean') {
        material.depthWrite = technical.depthWrite;
    }
}

export function applySurfaceDrawContract(object, inputClaim) {
    if (!object || typeof object !== 'object') {
        throw new TypeError('Surface draw-contract target must be an object');
    }
    const claim = asSurfaceClaim(inputClaim);
    const technical = claim.technical;
    object.userData ||= {};
    object.userData.surfaceDrawContract = technical;
    if (Number.isFinite(technical.renderOrder)) object.renderOrder = technical.renderOrder;
    const materials = Array.isArray(object.material)
        ? object.material
        : object.material
            ? [object.material]
            : [];
    for (const material of materials) applyMaterialDrawContract(material, claim);
    return object;
}

// Publication-time compiler for a complete detached root. Producers describe
// semantics through claims; this is the only THREE adapter that turns their
// canonical technical contract into object/material draw state.
export function applySurfacePublicationDrawContracts(root) {
    if (!root || typeof root !== 'object') return root;
    const visit = typeof root.traverse === 'function'
        ? callback => root.traverse(callback)
        : callback => {
            const walk = (object) => {
                callback(object);
                for (const child of object?.children || []) walk(child);
            };
            walk(root);
        };
    visit((object) => {
        if (!object?.isMesh) return;
        const objectClaim = surfaceClaimForObject(object);
        if (objectClaim) {
            applySurfaceDrawContract(object, objectClaim);
            return;
        }
        const materials = Array.isArray(object.material)
            ? object.material
            : object.material
                ? [object.material]
                : [];
        const materialClaims = materials
            .map(material => material?.userData?.surfaceClaim)
            .filter(Boolean)
            .map(asSurfaceClaim);
        for (let index = 0; index < materials.length; index += 1) {
            const claim = materials[index]?.userData?.surfaceClaim;
            if (claim) applyMaterialDrawContract(materials[index], asSurfaceClaim(claim));
        }
        const orders = [...new Set(materialClaims
            .map(claim => claim.technical.renderOrder)
            .filter(Number.isFinite))];
        if (orders.length === 1) object.renderOrder = orders[0];
    });
    return root;
}
