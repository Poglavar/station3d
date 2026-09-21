// One shared translucent material for every procedural rooftop pool. Keeping
// it shared lets the building batcher publish all pool surfaces in a proposal
// region as one draw call while the low opacity reveals the modeled basin.

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';

export const NEW_BUILD_ROOF_POOL_WATER_MATERIAL_NAME = 'NewBuildRoofPoolWater';

let poolWaterMaterial = null;

export function getNewBuildRoofPoolWaterMaterial() {
    if (poolWaterMaterial) return poolWaterMaterial;
    poolWaterMaterial = new THREE.MeshStandardMaterial({
        color: 0x35b9d1,
        roughness: 0.16,
        metalness: 0.02,
        emissive: 0x092d38,
        emissiveIntensity: 0.14,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    poolWaterMaterial.name = NEW_BUILD_ROOF_POOL_WATER_MATERIAL_NAME;
    // Building-roof support rays should land on the visible basin bottom, not
    // treat the alpha-blended water plane as a floor.
    poolWaterMaterial.userData.walkSupport = false;
    registerShared(poolWaterMaterial);
    return poolWaterMaterial;
}
