// Pure Polygon/MultiPolygon prism compiler shared by the far-building Worker
// and its parity fixtures. It intentionally has no Three.js, DOM, or layer state.

import { geoToLocal } from './math.js';
import { signedArea, triangulate } from './polygon-triangulation.js';

export function projectLod1Ring(ring, anchorLon, anchorLat) {
    return (ring || []).map(point => {
        const local = geoToLocal(point[0], point[1], anchorLon, anchorLat);
        return { x: local.x, z: local.z };
    });
}

export function lod1OuterRings(geometry) {
    if (geometry?.type === 'Polygon') {
        const ring = geometry.coordinates?.[0];
        return Array.isArray(ring) && ring.length >= 4 ? [ring] : [];
    }
    if (geometry?.type === 'MultiPolygon') {
        return (geometry.coordinates || [])
            .map(part => part?.[0])
            .filter(ring => Array.isArray(ring) && ring.length >= 4);
    }
    return [];
}

export function appendLod1Prism(
    ring,
    height,
    output = { positions: [], indices: [] },
    baseY = 0,
    topologyRing = ring,
) {
    let points = Array.isArray(ring) ? ring : [];
    let topology = Array.isArray(topologyRing) ? topologyRing : [];
    if (topology.length !== points.length) throw new TypeError('Prism topology and projected ring must correspond');
    const count = points.length;
    if (count >= 4
        && points[0].x === points[count - 1].x
        && points[0].z === points[count - 1].z) {
        points = points.slice(0, -1);
        topology = topology.slice(0, -1);
    }
    if (signedArea(topology) > 0) {
        points = points.slice().reverse();
        topology = topology.slice().reverse();
    }
    const pointCount = points.length;
    if (pointCount < 3) return output;
    const resolvedHeight = Number(height);
    const resolvedBaseY = Number(baseY);
    if (!Number.isFinite(resolvedHeight) || resolvedHeight <= 0
        || !Number.isFinite(resolvedBaseY)) return output;

    const vertexBase = output.positions.length / 3;
    for (const point of points) output.positions.push(point.x, resolvedBaseY, point.z);
    for (const point of points) {
        output.positions.push(point.x, resolvedBaseY + resolvedHeight, point.z);
    }
    for (let index = 0; index < pointCount; index++) {
        const next = (index + 1) % pointCount;
        const bottom = vertexBase + index;
        const bottomNext = vertexBase + next;
        const top = vertexBase + pointCount + index;
        const topNext = vertexBase + pointCount + next;
        output.indices.push(bottom, bottomNext, topNext, bottom, topNext, top);
    }
    for (const [a, b, c] of triangulate(topology)) {
        const facesUp = signedArea([topology[a], topology[b], topology[c]]) < 0;
        output.indices.push(
            vertexBase + pointCount + a,
            vertexBase + pointCount + (facesUp ? b : c),
            vertexBase + pointCount + (facesUp ? c : b),
        );
    }
    return output;
}

export function compileLod1BuildingPrisms(
    geometry,
    height,
    anchorLon,
    anchorLat,
    baseY = 0,
    { originX = 0, originZ = 0 } = {},
) {
    if (!Number.isFinite(originX) || !Number.isFinite(originZ)) throw new TypeError('Invalid prism local origin');
    const accumulator = { positions: [], indices: [] };
    for (const ring of lod1OuterRings(geometry)) {
        // Equirectangular projection is affine, so it cannot change topology.
        // Decide winding/ears in the source ring translated near zero, before
        // cos(latitude) or large session offsets introduce rounding noise at
        // collinear corners. No source or rendered vertex is snapped or moved.
        const topology = ring.map(point => ({ x: point[0] - ring[0][0], z: -(point[1] - ring[0][1]) }));
        appendLod1Prism(
            projectLod1Ring(ring, anchorLon, anchorLat),
            height,
            accumulator,
            baseY,
            topology,
        );
    }
    if (accumulator.positions.length === 0) return null;
    // Subtract in double precision, before packing the GPU buffer. Converting
    // a 40 km session coordinate to Float32 first permanently loses millimetres
    // even if the resulting mesh is translated back to its small tile frame.
    for (let index = 0; index < accumulator.positions.length; index += 3) {
        accumulator.positions[index] -= originX;
        accumulator.positions[index + 2] -= originZ;
    }
    return {
        positions: new Float32Array(accumulator.positions),
        indices: new Uint32Array(accumulator.indices),
    };
}
