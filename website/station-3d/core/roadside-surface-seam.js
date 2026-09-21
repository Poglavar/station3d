// Pure boundary geometry for sealing terrain-draped roadside surfaces to ground.

import { finiteOrNull } from './math.js';

const DEFAULT_LANDING_WIDTH_M = 0.65;
const DEFAULT_TERRAIN_OVERLAP_M = 0.025;
const DEFAULT_MAX_MITER_SCALE = 2.5;

function positionAt(positions, index) {
    const offset = index * 3;
    const x = finiteOrNull(positions?.[offset]);
    const y = finiteOrNull(positions?.[offset + 1]);
    const z = finiteOrNull(positions?.[offset + 2]);
    return x === null || y === null || z === null ? null : { x, y, z };
}

function boundaryEdges(positions, indices) {
    const vertexCount = Math.floor((positions?.length || 0) / 3);
    const sourceIndices = indices?.length
        ? Array.from(indices)
        : Array.from({ length: vertexCount }, (_value, index) => index);
    const edges = new Map();
    const addEdge = (a, b, third) => {
        if (a === b || a < 0 || b < 0 || third < 0
            || a >= vertexCount || b >= vertexCount || third >= vertexCount) return;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const existing = edges.get(key);
        if (existing) {
            existing.count += 1;
            return;
        }
        edges.set(key, { a, b, third, count: 1 });
    };
    for (let offset = 0; offset + 2 < sourceIndices.length; offset += 3) {
        const a = Number(sourceIndices[offset]);
        const b = Number(sourceIndices[offset + 1]);
        const c = Number(sourceIndices[offset + 2]);
        if (![a, b, c].every(Number.isInteger)) continue;
        addEdge(a, b, c);
        addEdge(b, c, a);
        addEdge(c, a, b);
    }
    return Array.from(edges.values()).filter(edge => edge.count === 1);
}

function edgeOutwardNormal(positions, edge) {
    const a = positionAt(positions, edge.a);
    const b = positionAt(positions, edge.b);
    const third = positionAt(positions, edge.third);
    if (!a || !b || !third) return null;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-7)) return null;
    const thirdSide = dx * (third.z - a.z) - dz * (third.x - a.x);
    if (Math.abs(thirdSide) < 1e-9) return null;
    // The triangle interior lies on `thirdSide`; the seam lands on the
    // opposite side of this boundary edge.
    return thirdSide > 0
        ? { x: dz / length, z: -dx / length }
        : { x: -dz / length, z: dx / length };
}

function pushVertexNormal(normalsByVertex, index, normal) {
    let entry = normalsByVertex.get(index);
    if (!entry) {
        entry = { x: 0, z: 0, normals: [] };
        normalsByVertex.set(index, entry);
    }
    entry.x += normal.x;
    entry.z += normal.z;
    entry.normals.push(normal);
}

function landingOffsetForVertex(entry, widthM, maxMiterScale) {
    if (!entry || entry.normals.length === 0) return null;
    const length = Math.hypot(entry.x, entry.z);
    const direction = length > 1e-7
        ? { x: entry.x / length, z: entry.z / length }
        : entry.normals[0];
    let minimumProjection = Infinity;
    for (const normal of entry.normals) {
        minimumProjection = Math.min(
            minimumProjection,
            direction.x * normal.x + direction.z * normal.z,
        );
    }
    const miterScale = Math.min(
        maxMiterScale,
        1 / Math.max(0.4, minimumProjection),
    );
    return {
        x: direction.x * widthM * miterScale,
        z: direction.z * widthM * miterScale,
    };
}

function pushTriangle(positions, a, b, c) {
    positions.push(
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        c.x, c.y, c.z,
    );
}

// The paved top is authoritative, so its actual triangulated boundary is the
// inner row. The outer row samples the already-composed ground immediately
// beside it and tucks a few centimetres underneath, closing both vertical gaps
// and mismatched terrain/sidewalk triangle diagonals without widening paving.
export function buildRoadsideSurfaceTerrainSeamGeometryData({
    positions,
    indices = null,
    landingSceneYAtLocal,
    segmentKeep = null,
    landingWidthM = DEFAULT_LANDING_WIDTH_M,
    terrainOverlapM = DEFAULT_TERRAIN_OVERLAP_M,
    maxMiterScale = DEFAULT_MAX_MITER_SCALE,
} = {}) {
    const widthM = Math.max(0, finiteOrNull(landingWidthM) ?? 0);
    const overlapM = Math.max(0, finiteOrNull(terrainOverlapM) ?? 0);
    const safeMiterScale = Math.max(1, finiteOrNull(maxMiterScale) ?? 1);
    if (!(widthM > 0) || typeof landingSceneYAtLocal !== 'function') {
        return { ready: true, positions: [], boundaryEdgeCount: 0, emittedEdgeCount: 0 };
    }

    const edges = boundaryEdges(positions, indices)
        .map(edge => ({ ...edge, normal: edgeOutwardNormal(positions, edge) }))
        .filter(edge => edge.normal);
    const normalsByVertex = new Map();
    for (const edge of edges) {
        pushVertexNormal(normalsByVertex, edge.a, edge.normal);
        pushVertexNormal(normalsByVertex, edge.b, edge.normal);
    }
    const offsetsByVertex = new Map();
    for (const [index, entry] of normalsByVertex) {
        offsetsByVertex.set(
            index,
            landingOffsetForVertex(entry, widthM, safeMiterScale),
        );
    }

    const output = [];
    const landingByVertex = new Map();
    let missingPoint = null;
    let emittedEdgeCount = 0;
    const landingAt = (index) => {
        if (landingByVertex.has(index)) return landingByVertex.get(index);
        const top = positionAt(positions, index);
        const offset = offsetsByVertex.get(index);
        if (!top || !offset) return null;
        const x = top.x + offset.x;
        const z = top.z + offset.z;
        const groundY = finiteOrNull(landingSceneYAtLocal(x, z));
        if (groundY === null) {
            missingPoint = { x, z };
            return null;
        }
        const landing = { x, y: groundY - overlapM, z };
        landingByVertex.set(index, landing);
        return landing;
    };

    for (const edge of edges) {
        const topA = positionAt(positions, edge.a);
        const topB = positionAt(positions, edge.b);
        const offsetA = offsetsByVertex.get(edge.a);
        const offsetB = offsetsByVertex.get(edge.b);
        if (!topA || !topB || !offsetA || !offsetB) continue;
        const outerMidX = (topA.x + offsetA.x + topB.x + offsetB.x) * 0.5;
        const outerMidZ = (topA.z + offsetA.z + topB.z + offsetB.z) * 0.5;
        if (segmentKeep && !segmentKeep({
            midX: (topA.x + topB.x) * 0.5,
            midZ: (topA.z + topB.z) * 0.5,
            outerMidX,
            outerMidZ,
            aIndex: edge.a,
            bIndex: edge.b,
        })) continue;
        const landingA = landingAt(edge.a);
        const landingB = landingAt(edge.b);
        if (!landingA || !landingB) {
            return {
                ready: false,
                positions: [],
                boundaryEdgeCount: edges.length,
                emittedEdgeCount: 0,
                missingPoint,
            };
        }
        pushTriangle(output, topA, landingA, landingB);
        pushTriangle(output, topA, landingB, topB);
        emittedEdgeCount += 1;
    }
    return {
        ready: true,
        positions: output,
        boundaryEdgeCount: edges.length,
        emittedEdgeCount,
    };
}
