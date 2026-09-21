// Central disposer for THREE.Group subtrees, with a registry for shared resources
// (geometries, materials, textures) that must never be disposed by dispose calls
// just because a consumer group went away. Modules that create shared singletons
// call registerShared() once on creation — disposeGroup then skips them.
//
// Additionally, per-instance one-shot resources can be registered on
// group.userData.disposables[] and they are freed here when the group is disposed.

// Note: we don't directly reference THREE constructors here, but consumers pass
// in THREE objects, so we leave THREE out of this file's import surface.
const sharedResources = new Set();

export function registerShared(...resources) {
    for (const r of resources) {
        if (r) sharedResources.add(r);
    }
}

export function unregisterShared(...resources) {
    for (const r of resources) {
        sharedResources.delete(r);
    }
}

export function isShared(resource) {
    return sharedResources.has(resource);
}

export function disposeGroup(group) {
    if (!group) return;
    const seenGeoms = new Set();
    const seenMats = new Set();
    const seenTextures = new Set();
    const seenExtras = new Set();

    group.traverse((child) => {
        const g = child.geometry;
        if (g && !sharedResources.has(g) && !seenGeoms.has(g)) {
            seenGeoms.add(g);
            g.dispose();
        }
        const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
        for (const m of mats) {
            if (!m || sharedResources.has(m) || seenMats.has(m)) continue;
            seenMats.add(m);
            if (m.map
                && !sharedResources.has(m.map)
                && !seenTextures.has(m.map)
                && typeof m.map.dispose === 'function') {
                seenTextures.add(m.map);
                m.map.dispose();
            }
            m.dispose();
        }
    });

    const extras = group.userData && group.userData.disposables;
    if (Array.isArray(extras)) {
        for (const r of extras) {
            if (!r || sharedResources.has(r) || typeof r.dispose !== 'function') continue;
            if (seenGeoms.has(r) || seenMats.has(r) || seenTextures.has(r)) continue;
            if (seenExtras.has(r)) continue;
            seenExtras.add(r);
            r.dispose();
        }
        group.userData.disposables = null;
    }

    if (group.parent) group.parent.remove(group);
}

// Detaches a retired subtree immediately, then releases at most one object's
// resources per iterator step. This keeps atomic scene swaps cheap while using
// transaction-wide seen sets, so resources aliased by sibling meshes and the
// root's explicit disposables are still released exactly once.
export function* disposeGroupCooperatively(group) {
    if (!group) return;
    if (group.parent) group.parent.remove(group);

    const seenGeoms = new Set();
    const seenMats = new Set();
    const seenTextures = new Set();
    const seenExtras = new Set();
    const stack = [group];

    while (stack.length > 0) {
        const child = stack.pop();
        const children = Array.isArray(child?.children) ? child.children : [];
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push(children[index]);
        }

        const geometry = child?.geometry;
        if (geometry && !sharedResources.has(geometry) && !seenGeoms.has(geometry)) {
            seenGeoms.add(geometry);
            geometry.dispose();
        }
        const materials = Array.isArray(child?.material)
            ? child.material
            : child?.material ? [child.material] : [];
        for (const material of materials) {
            if (!material || sharedResources.has(material) || seenMats.has(material)) continue;
            seenMats.add(material);
            if (material.map
                && !sharedResources.has(material.map)
                && !seenTextures.has(material.map)
                && typeof material.map.dispose === 'function') {
                seenTextures.add(material.map);
                material.map.dispose();
            }
            material.dispose();
        }
        yield { phase: 'object', object: child };
    }

    const extras = group.userData && group.userData.disposables;
    if (Array.isArray(extras)) {
        for (const resource of extras) {
            if (!resource
                || sharedResources.has(resource)
                || typeof resource.dispose !== 'function'
                || seenGeoms.has(resource)
                || seenMats.has(resource)
                || seenTextures.has(resource)
                || seenExtras.has(resource)) continue;
            seenExtras.add(resource);
            resource.dispose();
            yield { phase: 'extra', object: resource };
        }
        group.userData.disposables = null;
    }
}
