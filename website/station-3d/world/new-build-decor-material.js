// The ONE material every new-build decor part shares — roof railings, jogging
// tracks, terrace furniture, courtyard lawns, paths, planting and benches.
//
// Sharing it is what keeps the whole feature free: identical material + no
// rotation + no children means the buildings batcher merges every decorated
// roof and courtyard in a tile into a single aggregate draw call. Colour comes
// from a vertex attribute, which is why there is no per-part material.
//
// It is NAMED because the merge erases each part's own mesh name: the aggregate
// takes its name from this material, so decor stays identifiable in the scene
// graph (see assembleOvertureBuckets in world/buildings.js).

import * as THREE from 'three';
import { registerShared } from '../core/dispose.js';

export const NEW_BUILD_DECOR_MATERIAL_NAME = 'NewBuildDecor';

let decorMaterial = null;

export function getNewBuildDecorMaterial() {
    if (decorMaterial) return decorMaterial;
    decorMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        // Ribbons, canopies and lawns are open surfaces seen from both sides.
        side: THREE.DoubleSide,
    });
    decorMaterial.name = NEW_BUILD_DECOR_MATERIAL_NAME;
    registerShared(decorMaterial);
    return decorMaterial;
}
