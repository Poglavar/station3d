// Packs a set of already-positioned, same-material static geometries into one
// BatchedMesh. The source geometries are staging objects and are always
// disposed after their attributes have been copied into the batch.

import * as THREE from 'three';

function geometryCapacity(parts) {
    let vertices = 0;
    let indices = 0;
    for (const part of parts) {
        const geometry = part?.geometry;
        vertices += Number(geometry?.getAttribute?.('position')?.count) || 0;
        indices += Number(geometry?.index?.count) || 0;
    }
    return { vertices, indices };
}

export function createStaticBatchedMesh(partsValue, {
    material,
    name = 'StaticBatchedMesh',
    castShadow = false,
    receiveShadow = false,
} = {}) {
    const parts = Array.isArray(partsValue)
        ? partsValue.filter(part => part?.geometry)
        : [];
    if (parts.length === 0 || !material?.isMaterial) return null;
    const { vertices, indices } = geometryCapacity(parts);
    if (!(vertices > 0)) {
        for (const part of parts) part.geometry.dispose?.();
        return null;
    }

    let batch = null;
    try {
        batch = new THREE.BatchedMesh(parts.length, vertices, indices, material);
        batch.name = name;
        batch.castShadow = castShadow;
        batch.receiveShadow = receiveShadow;
        // Every part is opaque and static. Sorting buys nothing, while its
        // per-object work is paid on every frame. Per-object culling still
        // keeps distant props out of both the colour and shadow passes.
        batch.sortObjects = false;
        batch.perObjectFrustumCulled = true;
        for (const part of parts) {
            const geometry = part.geometry;
            if (!geometry.boundingBox) geometry.computeBoundingBox();
            if (!geometry.boundingSphere) geometry.computeBoundingSphere();
            const geometryId = batch.addGeometry(geometry);
            const instanceId = batch.addInstance(geometryId);
            if (part.matrix?.isMatrix4) batch.setMatrixAt(instanceId, part.matrix);
        }
        batch.computeBoundingBox();
        batch.computeBoundingSphere();
        return batch;
    } catch (error) {
        batch?.dispose?.();
        throw error;
    } finally {
        for (const part of parts) part.geometry.dispose?.();
    }
}
