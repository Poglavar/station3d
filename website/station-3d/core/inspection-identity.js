// Resolves a Shift-inspected render hit back to the source entity that owns it,
// including face ranges in merged meshes and instances in far-building batches.

import { ownerRangeForFace } from './geometry-batch.js';

function objectIdFrom(metadata, userData) {
    return metadata?.renderObjectId
        ?? metadata?.objectId
        ?? metadata?.object_id
        ?? userData?.objectId
        ?? userData?.object_id
        ?? null;
}

export function inspectionIdentityForHit(hit) {
    const object = hit?.object;
    const userData = object?.userData || {};
    const batchId = Number.isInteger(hit?.batchId) ? hit.batchId : null;
    if (batchId !== null) {
        const objectId = userData.objectIdsByBatchId?.[batchId] ?? null;
        return {
            key: null,
            metadata: null,
            objectId,
            batchId,
        };
    }

    const range = ownerRangeForFace(userData.entityRanges, hit?.faceIndex);
    const metadata = range?.metadata || userData.entityMetadata || null;
    return {
        key: range?.key ?? metadata?.key ?? userData.entityKey ?? null,
        metadata,
        objectId: objectIdFrom(metadata, userData),
        batchId: null,
    };
}
