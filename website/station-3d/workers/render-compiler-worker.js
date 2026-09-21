// Single Station3D module Worker. Compiler imports are pure core modules only:
// no Three.js, DOM, UI, scene, or world-layer singleton is reachable here.

import {
    compileFarBuildingRenderPacket,
    FAR_BUILDING_PACKET_COMPILER_ID,
    FAR_BUILDING_PACKET_COMPILER_VERSION,
} from '../core/compilers/far-building-render-packet.js';
import {
    compileTerrainRenderPacket,
    TERRAIN_PACKET_COMPILER_ID,
    TERRAIN_PACKET_COMPILER_VERSION,
} from '../core/compilers/terrain-render-packet.js';
import { renderPacketTransferables } from '../core/render-packet.js';
import { deserializeTerrainReference } from '../core/terrain-snapshot.js';

const states = new Map();
const cancelledJobs = new Set();

function serializableError(error) {
    return {
        name: String(error?.name || 'Error'),
        message: String(error?.message || error || 'Render compiler failed'),
        code: error?.code || null,
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : null,
        terrainStorage: error?.details?.terrainStorage || null,
    };
}

function installState(stateId, payload, declaredRevision) {
    if (payload?.kind === 'terrain-snapshot') {
        states.set(stateId, {
            kind: payload.kind,
            revision: Number(payload.snapshot?.revision) || 0,
            reference: deserializeTerrainReference(payload.snapshot),
        });
        return states.get(stateId).revision;
    }
    states.set(stateId, payload);
    return declaredRevision;
}

function compile(request) {
    if (request.compilerId === TERRAIN_PACKET_COMPILER_ID) {
        if (String(request.compilerVersion) !== TERRAIN_PACKET_COMPILER_VERSION) {
            throw new Error(`Unsupported terrain compiler version ${request.compilerVersion}`);
        }
        const terrain = states.get('terrain');
        if (!terrain?.reference) throw new Error('Terrain snapshot has not been installed');
        return compileTerrainRenderPacket(request, terrain.reference);
    }
    if (request.compilerId === FAR_BUILDING_PACKET_COMPILER_ID) {
        if (String(request.compilerVersion) !== FAR_BUILDING_PACKET_COMPILER_VERSION) {
            throw new Error(`Unsupported far-building compiler version ${request.compilerVersion}`);
        }
        return compileFarBuildingRenderPacket(request);
    }
    throw new Error(`Unknown render packet compiler: ${request.compilerId}`);
}

globalThis.onmessage = (event) => {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
        try {
            const stateRevision = installState(String(message.stateId || ''), message.payload, message.stateRevision);
            globalThis.postMessage({
                type: 'state-ready', stateId: message.stateId, stateGeneration: message.stateGeneration, stateRevision,
            });
        } catch (error) {
            globalThis.postMessage({
                type: 'state-error',
                stateId: message.stateId,
                stateGeneration: message.stateGeneration,
                error: serializableError(error),
            });
        }
        return;
    }
    if (message.type === 'clear-state') {
        states.delete(String(message.stateId || ''));
        return;
    }
    if (message.type === 'cancel') {
        cancelledJobs.add(message.jobId);
        return;
    }
    if (message.type !== 'compile') return;
    const { jobId, request } = message;
    if (cancelledJobs.delete(jobId)) return;
    try {
        const packet = compile(request);
        if (cancelledJobs.delete(jobId)) return;
        globalThis.postMessage(
            { type: 'result', jobId, packet },
            renderPacketTransferables(packet),
        );
    } catch (error) {
        if (cancelledJobs.delete(jobId)) return;
        globalThis.postMessage({ type: 'error', jobId, error: serializableError(error) });
    }
};
