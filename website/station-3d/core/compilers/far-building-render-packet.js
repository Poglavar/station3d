// Pure far-building packet compiler. Proposal filtering, terrain-evidence
// gating, and LOD ownership are immutable request inputs from the main thread.

import {
    boundsForPositions,
    computeIndexedVertexNormals,
    emptyUvs,
} from '../indexed-geometry.js';
import { compileLod1BuildingPrisms } from '../lod1-prism-geometry.js';
import {
    RENDER_PACKET_SCHEMA_VERSION,
    validateRenderPacket,
} from '../render-packet.js';

export const FAR_BUILDING_PACKET_COMPILER_ID = 'far-buildings';
export const FAR_BUILDING_PACKET_COMPILER_VERSION = '1.2.0';

export function compileFarBuildingRenderPacket(request) {
    const input = request?.inputs || {};
    const anchorLon = Number(input.anchorLon);
    const anchorLat = Number(input.anchorLat);
    const originX = Number(input.tileOriginX);
    const originZ = Number(input.tileOriginZ);
    if (![anchorLon, anchorLat, originX, originZ].every(Number.isFinite)) {
        throw new Error('Far-building compiler received an invalid tile frame');
    }
    const primitives = [];
    for (let featureIndex = 0; featureIndex < (input.features || []).length; featureIndex++) {
        const feature = input.features[featureIndex] || {};
        const geometry = compileLod1BuildingPrisms(
            feature.geometry,
            feature.heightM,
            anchorLon,
            anchorLat,
            feature.baseY,
            { originX, originZ },
        );
        if (!geometry) continue;
        const normals = computeIndexedVertexNormals(geometry.positions, geometry.indices);
        const entityId = feature.entityId ?? `feature:${featureIndex}`;
        primitives.push({
            positions: geometry.positions,
            normals,
            uvs: emptyUvs(geometry.positions.length / 3),
            indices: geometry.indices,
            materialKey: 'far-buildings',
            renderOrder: Number(input.renderOrder) || 0,
            bounds: boundsForPositions(geometry.positions),
            entityRanges: [{
                entityId,
                startIndex: 0,
                indexCount: geometry.indices.length,
                metadata: {
                    objectId: feature.objectId ?? entityId,
                    color: Number(feature.color) || 0xffffff,
                    nearKey: feature.nearKey ?? null,
                },
            }],
            surfaceClaims: [{
                surfaceClass: 'building',
                coverageState: 'published',
                verticalRelation: 'unknown',
                ownerId: `far-buildings:${request.tile.x}:${request.tile.y}`,
                sourceId: 'world/buildings-far.js',
                supportReady: false,
            }],
            colliderData: null,
        });
    }
    return validateRenderPacket({
        schemaVersion: RENDER_PACKET_SCHEMA_VERSION,
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID,
        compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        sourceRevision: request.sourceRevision,
        generation: request.generation,
        tile: request.tile,
        primitives,
    }, {
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID,
        compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        sourceRevision: request.sourceRevision,
        generation: request.generation,
        tile: request.tile,
    });
}
