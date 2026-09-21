// Places an uploaded immutable tile without rewriting its vertex buffers.
// Parent scene rebasing stays exclusively in render-origin.js.
import { worldTilePlacement } from './world-tile-placement.js';

export function applyWorldTilePlacement(root, tile, options) {
    if (!root?.isObject3D) throw new TypeError('World tile placement requires an Object3D root');
    const placement = worldTilePlacement(tile, options);
    root.position.set(placement.position.x, placement.position.y, placement.position.z);
    root.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
    // Upload roots have frozen automatic transforms. An explicit placement or
    // anchor change must refresh the matrix before culling, rendering or picking.
    root.updateMatrix();
    root.updateMatrixWorld(true);
    return root;
}
