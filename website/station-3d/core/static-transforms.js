// Freeze transforms only at explicit immutable-publication boundaries. Dynamic
// actors opt out with userData.dynamicTransform; callers decide when a subtree
// has finished construction and is safe to freeze.

export function freezeStaticTransforms(root) {
    if (!root || typeof root !== 'object') return 0;
    root.updateMatrixWorld?.(true);
    let frozen = 0;
    root.traverse?.((object) => {
        if (!object || object.userData?.dynamicTransform === true) return;
        object.updateMatrix?.();
        object.matrixAutoUpdate = false;
        // Keep world-matrix propagation alive: Station3D rebases the parent
        // scene for country-scale coordinates immediately before each render.
        // Only the immutable LOCAL transform is safe to freeze.
        object.matrixWorldAutoUpdate = true;
        object.matrixWorldNeedsUpdate = true;
        frozen += 1;
    });
    return frozen;
}

export function thawStaticTransforms(root) {
    if (!root || typeof root !== 'object') return 0;
    let thawed = 0;
    root.traverse?.((object) => {
        if (!object || object.userData?.dynamicTransform === true) return;
        object.matrixAutoUpdate = true;
        object.matrixWorldAutoUpdate = true;
        object.matrixWorldNeedsUpdate = true;
        thawed += 1;
    });
    return thawed;
}
