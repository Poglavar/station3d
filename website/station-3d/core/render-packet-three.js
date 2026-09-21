// Main-thread landing adapter for station3d-render-packet-v1. It validates the
// packet before creating any Three.js resource, then uploads at most the number
// of primitives the caller explicitly admits per delivery step.

import * as THREE from 'three';

import { createRenderPacketValidationTask } from './render-packet.js';
import { markSurfaceClaim } from './surface-claim.js';
import { freezeStaticTransforms } from './static-transforms.js';

function positiveInteger(value, fallback = 1) {
    const number = Math.trunc(Number(value));
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function createGeometry(primitive) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(primitive.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(primitive.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(primitive.uvs, 2));
    if (primitive.colors) {
        geometry.setAttribute('color', new THREE.BufferAttribute(primitive.colors, 3));
    }
    geometry.setIndex(new THREE.BufferAttribute(primitive.indices, 1));
    const bounds = primitive.bounds;
    geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    return geometry;
}

// Packet materials are supplied by the layer and normally shared across every
// tile. The upload task owns only the BufferGeometries it creates; disposing a
// cancelled candidate must never tear down the caller's live material family.
function disposePacketRoot(root) {
    if (!root) return;
    const geometries = new Set();
    root.traverse?.((child) => {
        if (child.geometry && !geometries.has(child.geometry)) {
            geometries.add(child.geometry);
            child.geometry.dispose?.();
        }
    });
    root.parent?.remove?.(root);
}

function inspectionRanges(entityRanges) {
    return (entityRanges || []).map(range => ({
        start: range.startIndex,
        count: range.indexCount,
        key: String(range.entityId),
        metadata: range.metadata || null,
    }));
}

function surfaceClaimForPrimitive(primitive, packet, replacementKey) {
    const input = primitive.surfaceClaims?.[0];
    if (!input) return null;
    return {
        ...input,
        replacementKey,
        generation: packet.generation,
    };
}

export function createRenderPacketUploadTask(packetValue, {
    materialForKey,
    replacementKey,
    rootName = null,
    position = null,
    configureMesh = null,
    freezeTransforms = true,
} = {}) {
    const validation = createRenderPacketValidationTask(packetValue);
    const packet = packetValue;
    if (typeof materialForKey !== 'function') {
        throw new TypeError('Render packet upload requires materialForKey(key, primitive)');
    }
    const key = String(replacementKey || '').trim();
    if (!key) throw new TypeError('Render packet upload requires a replacement key');
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
    let done = packet.primitives.length === 0;
    let disposed = false;
    let resultTaken = false;

    const appendPrimitive = (primitive, index) => {
        if (primitive.empty === true) return;
        const material = materialForKey(primitive.materialKey, primitive, packet);
        if (!material?.isMaterial) {
            throw new Error(`No Three.js material for packet key ${primitive.materialKey}`);
        }
        const mesh = new THREE.Mesh(createGeometry(primitive), material);
        mesh.name = `${root.name}:primitive:${index}`;
        mesh.renderOrder = primitive.renderOrder;
        mesh.userData.entityRanges = inspectionRanges(primitive.entityRanges);
        mesh.userData.colliderData = primitive.colliderData || null;
        mesh.userData.packetPrimitiveIndex = index;
        const claim = surfaceClaimForPrimitive(primitive, packet, key);
        if (claim) markSurfaceClaim(mesh, claim);
        configureMesh?.(mesh, primitive, packet);
        root.add(mesh);
    };

    return Object.freeze({
        root,
        step(maxPrimitives = 1) {
            if (disposed) throw new Error('Render packet upload task is disposed');
            if (done) return true;
            let remaining = positiveInteger(maxPrimitives);
            try {
                if (!validation.step()) return false;
                while (primitiveIndex < packet.primitives.length && remaining > 0) {
                    appendPrimitive(packet.primitives[primitiveIndex], primitiveIndex);
                    primitiveIndex += 1;
                    remaining -= 1;
                }
                done = primitiveIndex >= packet.primitives.length;
                return done;
            } catch (error) {
                validation.dispose();
                disposePacketRoot(root);
                disposed = true;
                throw error;
            }
        },
        get done() { return done; },
        progress: () => ({
            validation: validation.progress(),
            uploadedPrimitives: primitiveIndex,
            totalPrimitives: packet.primitives.length,
        }),
        result() {
            if (disposed) throw new Error('Render packet upload task is disposed');
            if (!done) throw new Error('Render packet upload is incomplete');
            if (resultTaken) throw new Error('Render packet upload result was already taken');
            resultTaken = true;
            validation.dispose();
            if (freezeTransforms) freezeStaticTransforms(root);
            return root;
        },
        dispose() {
            if (disposed || resultTaken) return false;
            disposed = true;
            validation.dispose();
            disposePacketRoot(root);
            return true;
        },
    });
}

export function uploadRenderPacket(packet, options) {
    const task = createRenderPacketUploadTask(packet, options);
    while (!task.step(Number.MAX_SAFE_INTEGER)) { /* bounded task drained explicitly */ }
    return task.result();
}
