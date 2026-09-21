// Main-thread, bounded uploader for far-building render packets. Worker output
// remains tile-local; this adapter incrementally fills BatchedMesh chunks while
// preserving object picking, near/far ownership, tint, and surface identity.

import * as THREE from 'three';

import { createRenderPacketValidationTask, renderPacketTransferables } from './render-packet.js';
import { bindGeometryMemory, releaseGeometryMemory } from './geometry-memory-budget.js';
import { markSurfaceClaim } from './surface-claim.js';
import { freezeStaticTransforms } from './static-transforms.js';

function positiveInteger(value, fallback) {
    const number = Math.trunc(Number(value));
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function geometryForPrimitive(primitive) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(primitive.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(primitive.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(primitive.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(primitive.indices, 1));
    // BatchedMesh copies these bounds when the geometry is registered. Leaving
    // them absent defers both scans until the first visible render, precisely
    // when a streamed tile is already competing for the frame.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function primitiveIdentity(primitive, primitiveIndex) {
    const range = primitive.entityRanges?.[0] || null;
    return {
        objectId: range?.metadata?.objectId ?? range?.entityId ?? `primitive:${primitiveIndex}`,
        metadata: range?.metadata || null,
    };
}

function chunkCapacity(primitives, start, chunkSize) {
    const end = Math.min(primitives.length, start + chunkSize);
    let vertices = 0;
    let indices = 0;
    for (let index = start; index < end; index++) {
        vertices += primitives[index].positions.length / 3;
        indices += primitives[index].indices.length;
    }
    return { count: end - start, vertices, indices, end };
}

function disposeRoot(root) {
    if (!root) return;
    for (const child of root.children || []) child.dispose?.();
    releaseGeometryMemory(root);
    root.parent?.remove?.(root);
    root.clear?.();
}

// Typed storage allocated by the installed Three.js BatchedMesh implementation:
// positions/normals/UVs, its index type, matrix/color/indirect textures and two
// CPU multidraw arrays. JS object/range metadata and driver overhead are excluded.
export function estimateFarBuildingUploadBytes(packet, chunkSize = 300) {
    let backingCpuBytes = 0, gpuBytes = 0;
    const size = positiveInteger(chunkSize, 300);
    for (let start = 0; start < packet.primitives.length; start += size) {
        const c = chunkCapacity(packet.primitives, start, size);
        const geometryBytes = c.vertices * 8 * 4 + c.indices * (c.vertices > 65535 ? 4 : 2);
        const matrixSize = Math.max(4, Math.ceil(Math.sqrt(c.count * 4) / 4) * 4);
        const instanceSize = Math.ceil(Math.sqrt(c.count));
        const textureBytes = matrixSize ** 2 * 16 + instanceSize ** 2 * 20;
        gpuBytes += geometryBytes + textureBytes;
        backingCpuBytes += geometryBytes + textureBytes + c.count * 8;
    }
    const packetBytes = renderPacketTransferables(packet).reduce((sum, buffer) => sum + buffer.byteLength, 0);
    return { packetBytes, backingCpuBytes, gpuBytes };
}

export function createFarBuildingPacketUploadTask(packetValue, {
    material,
    replacementKey,
    chunkSize = 300,
    position = null,
    colorForEntity = null,
    visibleForEntity = null,
    configureBatch = null,
    rootName = null,
    memoryBudget = null,
    // Immutable baked arrays are already owned/accounted by their source cache,
    // which must outlive this borrower. Ordinary compiler packets own their lease.
    packetMemoryTrackedExternally = false,
} = {}) {
    const validation = createRenderPacketValidationTask(packetValue);
    let packet = packetValue;
    if (!material?.isMaterial) throw new TypeError('Far-building packet material is required');
    const key = String(replacementKey || '').trim();
    if (!key) throw new TypeError('Far-building packet replacement key is required');
    const safeChunkSize = positiveInteger(chunkSize, 300);
    const primitiveCount = packet.primitives.length;
    let packetMemory = null;
    let reservation = null;
    let memoryPrepared = false;
    const root = new THREE.Group();
    root.name = rootName || `${packet.compilerId}:${packet.tile.z}/${packet.tile.x}/${packet.tile.y}`;
    root.userData.renderPacket = {
        contract: 'station3d-render-packet-v1',
        compilerId: packet.compilerId,
        compilerVersion: packet.compilerVersion,
        sourceRevision: packet.sourceRevision,
        generation: packet.generation,
        tile: { ...packet.tile },
    };
    if (position) root.position.set(
        Number(position.x) || 0,
        Number(position.y) || 0,
        Number(position.z) || 0,
    );

    let primitiveIndex = 0;
    let current = null;
    let disposed = false;
    let resultTaken = false;
    let waitingForMemory = false;

    const releasePacket = () => { packet = null; validation.dispose(); packetMemory?.release(); };

    const prepareMemory = () => {
        if (memoryPrepared) return;
        const bytes = memoryBudget ? estimateFarBuildingUploadBytes(packet, safeChunkSize) : null;
        if (bytes && !packetMemoryTrackedExternally) packetMemory = memoryBudget.trackSource({
            lane: 'far', key: `${key}:packet`, cpuBytes: bytes.packetBytes, gpuBytes: 0,
        });
        if (bytes && bytes.backingCpuBytes + bytes.gpuBytes > 0) reservation = memoryBudget.request({
            lane: 'far', key, cpuBytes: bytes.backingCpuBytes, gpuBytes: bytes.gpuBytes,
        });
        bindGeometryMemory(root, reservation);
        memoryPrepared = true;
    };

    const beginChunk = () => {
        const capacity = chunkCapacity(
            packet.primitives,
            primitiveIndex,
            safeChunkSize,
        );
        const batch = new THREE.BatchedMesh(
            capacity.count,
            capacity.vertices,
            capacity.indices,
            material,
        );
        batch.name = `${root.name}:batch:${root.children.length}`;
        batch.userData.objectIdsByBatchId = [];
        batch.userData.lodRefs = [];
        batch.castShadow = false;
        batch.receiveShadow = false;
        // Far buildings use one opaque material, so per-frame depth sorting
        // provides no visual benefit. Per-object frustum culling remains useful.
        batch.sortObjects = false;
        batch.perObjectFrustumCulled = true;
        const claim = packet.primitives[primitiveIndex]?.surfaceClaims?.[0] || {
            surfaceClass: 'building',
            coverageState: 'published',
            verticalRelation: 'unknown',
        };
        markSurfaceClaim(batch, {
            ...claim,
            replacementKey: key,
            generation: packet.generation,
        });
        root.add(batch);
        current = { batch, end: capacity.end };
    };

    const finishChunk = () => {
        if (!current) return;
        configureBatch?.(current.batch, current.batch.userData.lodRefs, packet);
        // Finish aggregate bounds while detached. This prevents the renderer
        // from discovering and scanning a newly published batch on demand.
        current.batch.computeBoundingBox();
        current.batch.computeBoundingSphere();
        freezeStaticTransforms(current.batch);
        current = null;
    };

    const appendPrimitive = (primitive, index) => {
        if (!current) beginChunk();
        const geometry = geometryForPrimitive(primitive);
        try {
            const geometryId = current.batch.addGeometry(geometry);
            const instanceId = current.batch.addInstance(geometryId);
            const identity = primitiveIdentity(primitive, index);
            const ref = {
                batch: current.batch,
                instanceId,
                objectId: identity.objectId,
                nearKey: identity.metadata?.nearKey ?? null,
            };
            current.batch.userData.objectIdsByBatchId[instanceId] = identity.objectId;
            const color = colorForEntity?.(identity, primitive, packet)
                ?? identity.metadata?.color
                ?? 0xffffff;
            current.batch.setColorAt(instanceId, new THREE.Color(color));
            current.batch.setVisibleAt(
                instanceId,
                visibleForEntity ? visibleForEntity(ref, primitive, packet) !== false : true,
            );
            current.batch.userData.lodRefs.push(ref);
        } finally {
            // BatchedMesh copies all attributes into its own backing buffers.
            geometry.dispose();
        }
        if (index + 1 >= current.end) finishChunk();
    };

    return Object.freeze({
        root,
        step(maxPrimitives = 1) {
            if (disposed) throw new Error('Far-building packet upload task is disposed');
            if (primitiveIndex === primitiveCount) { releasePacket(); return true; }
            let remaining = positiveInteger(maxPrimitives, 1);
            try {
                if (!validation.step()) return false;
                // Sizing dereferences primitive storage/metadata too. Never
                // let it run ahead of validation on a baked/direct packet.
                prepareMemory();
                waitingForMemory = reservation ? !reservation.tryAcquire() : false;
                if (waitingForMemory) return false;
                while (primitiveIndex < primitiveCount && remaining > 0) {
                    appendPrimitive(packet.primitives[primitiveIndex], primitiveIndex);
                    primitiveIndex += 1;
                    remaining -= 1;
                }
                const complete = primitiveIndex >= primitiveCount;
                if (complete) releasePacket();
                return complete;
            } catch (error) {
                disposeRoot(root);
                releasePacket();
                disposed = true;
                throw error;
            }
        },
        get done() { return primitiveIndex >= primitiveCount; },
        get waitingForMemory() { return waitingForMemory; },
        progress: () => ({
            validation: validation.progress(),
            uploadedPrimitives: primitiveIndex,
            totalPrimitives: primitiveCount,
        }),
        result() {
            if (disposed) throw new Error('Far-building packet upload task is disposed');
            if (primitiveIndex < primitiveCount) {
                throw new Error('Far-building packet upload is incomplete');
            }
            if (resultTaken) throw new Error('Far-building packet upload result was already taken');
            resultTaken = true;
            finishChunk();
            releasePacket();
            freezeStaticTransforms(root);
            return root;
        },
        dispose() {
            if (disposed || resultTaken) return false;
            disposed = true;
            disposeRoot(root);
            releasePacket();
            return true;
        },
    });
}
