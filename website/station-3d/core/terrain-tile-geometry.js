// Builds one terrain tile a bounded row at a time so fine DGU meshes never
// monopolise a render frame while sampling heights and normals.

import { finiteOrNull } from './math.js';

function positiveInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function createTerrainTileGeometryTask({
    tileX,
    tileZ,
    tileM,
    segments,
    uvPerM,
    sceneYAtLocal,
    normalAtLocal,
}) {
    const resolvedTileM = Number(tileM) > 0 ? Number(tileM) : 400;
    const resolvedSegments = positiveInteger(segments, 20);
    const parsedUvPerM = finiteOrNull(uvPerM);
    const resolvedUvPerM = parsedUvPerM === null ? 0 : parsedUvPerM;
    const sampleY = typeof sceneYAtLocal === 'function' ? sceneYAtLocal : (() => 0);
    const sampleNormal = typeof normalAtLocal === 'function'
        ? normalAtLocal
        : (() => ({ x: 0, y: 1, z: 0 }));
    const vertexSide = resolvedSegments + 1;
    const positions = new Float32Array(vertexSide * vertexSide * 3);
    const normals = new Float32Array(vertexSide * vertexSide * 3);
    const uvs = new Float32Array(vertexSide * vertexSide * 2);
    const indices = new Uint32Array(resolvedSegments * resolvedSegments * 6);
    const x0 = Number(tileX) * resolvedTileM;
    const z0 = Number(tileZ) * resolvedTileM;
    const stepM = resolvedTileM / resolvedSegments;
    let vertexRow = 0;
    let indexRow = 0;
    let minY = Infinity;
    let maxY = -Infinity;

    function buildVertexRow(row) {
        const z = z0 + row * stepM;
        let vertexOffset = row * vertexSide * 3;
        let uvOffset = row * vertexSide * 2;
        for (let column = 0; column < vertexSide; column++) {
            const x = x0 + column * stepM;
            const y = Number(sampleY(x, z));
            const normal = sampleNormal(x, z, stepM) || { x: 0, y: 1, z: 0 };
            positions[vertexOffset] = x;
            positions[vertexOffset + 1] = y;
            positions[vertexOffset + 2] = z;
            normals[vertexOffset] = Number(normal.x) || 0;
            normals[vertexOffset + 1] = Number(normal.y) || 0;
            normals[vertexOffset + 2] = Number(normal.z) || 0;
            uvs[uvOffset] = x * resolvedUvPerM;
            uvs[uvOffset + 1] = z * resolvedUvPerM;
            if (Number.isFinite(y)) {
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
            vertexOffset += 3;
            uvOffset += 2;
        }
    }

    function buildIndexRow(row) {
        let indexOffset = row * resolvedSegments * 6;
        for (let column = 0; column < resolvedSegments; column++) {
            const a = row * vertexSide + column;
            const b = a + 1;
            const c = a + vertexSide;
            const d = c + 1;
            indices[indexOffset++] = a;
            indices[indexOffset++] = c;
            indices[indexOffset++] = b;
            indices[indexOffset++] = b;
            indices[indexOffset++] = c;
            indices[indexOffset++] = d;
        }
    }

    return {
        step(rowBudget = 1) {
            let rows = rowBudget === Infinity
                ? Infinity
                : positiveInteger(rowBudget, 1);
            while (vertexRow < vertexSide && rows > 0) {
                buildVertexRow(vertexRow++);
                rows -= 1;
            }
            while (vertexRow >= vertexSide && indexRow < resolvedSegments && rows > 0) {
                buildIndexRow(indexRow++);
                rows -= 1;
            }
            return vertexRow >= vertexSide && indexRow >= resolvedSegments;
        },
        get done() {
            return vertexRow >= vertexSide && indexRow >= resolvedSegments;
        },
        progress() {
            return {
                vertexRows: vertexRow,
                vertexRowCount: vertexSide,
                indexRows: indexRow,
                indexRowCount: resolvedSegments,
            };
        },
        result() {
            if (!(vertexRow >= vertexSide && indexRow >= resolvedSegments)) {
                throw new Error('terrain tile geometry is not complete');
            }
            return {
                positions,
                normals,
                uvs,
                indices,
                bounds: {
                    minX: x0,
                    minY: Number.isFinite(minY) ? minY : 0,
                    minZ: z0,
                    maxX: x0 + resolvedTileM,
                    maxY: Number.isFinite(maxY) ? maxY : 0,
                    maxZ: z0 + resolvedTileM,
                },
            };
        },
    };
}
