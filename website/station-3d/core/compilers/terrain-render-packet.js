// Pure terrain render-packet compiler. The Worker supplies a reconstructed
// immutable TerrainReference; Three.js material and publication work stay out.

import { boundsForPositions, localizeXZ } from '../indexed-geometry.js';
import {
    RENDER_PACKET_SCHEMA_VERSION,
    validateRenderPacket,
} from '../render-packet.js';
import { createTerrainTileGeometryTask } from '../terrain-tile-geometry.js';
import { createTerrainCutoutTopologySteps } from '../terrain-cutout-topology.js';
import { clipReceiverGeometrySteps } from '../terrain-receiver-topology.js';
import { TERRAIN_PACKET_COMPILER_ID, TERRAIN_PACKET_COMPILER_VERSION } from './terrain-render-contract.js';

export { TERRAIN_PACKET_COMPILER_ID, TERRAIN_PACKET_COMPILER_VERSION } from './terrain-render-contract.js';
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };

export function compileTerrainRenderPacket(request, terrainReference) {
    if (!terrainReference || typeof terrainReference.sceneYAtLocal !== 'function') {
        throw new Error('Terrain compiler requires a reconstructed TerrainReference');
    }
    const input = request?.inputs || {};
    const tileX = Number(input.tileX);
    const tileZ = Number(input.tileZ);
    const tileM = Number(input.tileM);
    const segments = Number(input.segments);
    if (![tileX, tileZ, tileM, segments].every(Number.isFinite)
        || tileM <= 0 || !Number.isInteger(segments) || segments < 1) {
        throw new Error('Terrain compiler received invalid tile dimensions');
    }
    if (Number(input.snapshotRevision) !== Number(terrainReference.revision)) {
        throw new Error('Terrain compiler snapshot revision is stale');
    }
    const stepM = tileM / segments;
    const task = createTerrainTileGeometryTask({
        tileX,
        tileZ,
        tileM,
        segments,
        uvPerM: input.uvPerM,
        sceneYAtLocal: (x, z) => terrainReference.sceneYAtLocal(x, z),
        normalAtLocal: (x, z) => terrainReference.normalAtLocal(x, z, stepM),
    });
    task.step(Infinity);
    const lattice = task.result();
    const originX = tileX * tileM;
    const originZ = tileZ * tileM;
    localizeXZ(lattice.positions, originX, originZ);
    const cutout = input.cutout;
    const topology = cutout ? drain(createTerrainCutoutTopologySteps({layers:cutout.layers,limits:cutout.limits})) : null;
    const geometry = topology ? drain(clipReceiverGeometrySteps({geometry:lattice,topology,originX,originZ,
        maxVertices:cutout.maxVertices,maxTriangles:cutout.maxTriangles})) : lattice;
    const bounds = boundsForPositions(geometry.positions);
    const packet = {
        schemaVersion: RENDER_PACKET_SCHEMA_VERSION,
        compilerId: TERRAIN_PACKET_COMPILER_ID,
        compilerVersion: TERRAIN_PACKET_COMPILER_VERSION,
        sourceRevision: request.sourceRevision,
        generation: request.generation,
        tile: request.tile,
        primitives: [{
            positions: geometry.positions,
            normals: geometry.normals,
            uvs: geometry.uvs,
            indices: geometry.indices,
            empty: geometry.indices.length === 0,
            materialKey: 'terrain',
            renderOrder: Number(input.renderOrder) || 0,
            bounds,
            entityRanges: [{
                entityId: `terrain:${tileX}:${tileZ}`,
                startIndex: 0,
                indexCount: geometry.indices.length,
            }],
            surfaceClaims: geometry.indices.length === 0 ? [] : [{
                surfaceClass: 'terrain',
                coverageState: 'published',
                verticalRelation: 'same-level',
                verticalBand: 'ground',
                ownerId: `terrain:${tileX}:${tileZ}`,
                sourceId: 'world/terrain.js',
                supportReady: true,
            }],
            colliderData: null,
            // Transfer the exact source lattice and source-face lookup with
            // the clipped receiver. The main thread validates publication;
            // neither queries nor physics infer topology from a texture.
            terrainLattice: {
                positions: lattice.positions, indices: lattice.indices, segments,
                sourceTriangleOffsets: geometry.sourceTriangleOffsets || null,
            },
        }],
    };
    return validateRenderPacket(packet, {
        compilerId: TERRAIN_PACKET_COMPILER_ID,
        compilerVersion: TERRAIN_PACKET_COMPILER_VERSION,
        sourceRevision: request.sourceRevision,
        generation: request.generation,
        tile: request.tile,
    });
}
