// Collect unsorted hits from the visible scene. Preserve Three's layer and
// raycast-return-false traversal rules, but reject hidden subtrees before
// testing their triangles. Roof support selects the highest eligible hit.
export function collectVisibleRayHits(raycaster, root, hits = []) {
    for (let node = root; node; node = node.parent) {
        if (node.visible === false) return hits;
    }
    function visit(object) {
        if (object.visible === false) return;
        if (object.layers.test(raycaster.layers) && object.raycast(raycaster, hits) === false) return;
        for (const child of object.children) visit(child);
    }
    if (root) visit(root);
    return hits;
}
