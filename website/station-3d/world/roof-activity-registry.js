// Streamed registry of bounded flat-roof activity surfaces. Building tiles
// publish and retire surfaces by owner; ambient pedestrians query the spatial
// index, while roof benches join the same seat registry as ordinary benches.

import { replaceAmbientBenchSeats, clearAmbientBenchSeats } from '../core/ambient-bench-seats.js';
import { createMutableBoundsGrid } from '../core/bounds-grid.js';
import { benchSeatFrame } from '../core/pedestrian-bench-behavior.js';
import {
    createRoofActivitySurface,
    roofActivityPointIsSafe,
    roofActivitySegmentIsSafe,
} from '../core/pedestrian-roof-activity.js';

const surfacesById = new Map();
const surfaceIdsByOwner = new Map();
const surfaceIndex = createMutableBoundsGrid({
    cellM: 64,
    boundsOf: surface => surface,
});

const benchOwner = surfaceId => `roof-surface:${surfaceId}`;

function unregisterSurface(id) {
    const key = String(id);
    const surface = surfacesById.get(key);
    if (!surface) return false;
    surfacesById.delete(key);
    surfaceIndex.delete(key);
    clearAmbientBenchSeats(benchOwner(key));
    const ownerIds = surfaceIdsByOwner.get(surface.ownerId);
    ownerIds?.delete(key);
    if (ownerIds?.size === 0) surfaceIdsByOwner.delete(surface.ownerId);
    return true;
}

function publishRoofBenchSeats(surface, benches) {
    const seats = [];
    for (let index = 0; index < (benches || []).length; index++) {
        const bench = benches[index];
        const x = Number(bench?.x);
        const z = Number(bench?.z);
        const yaw = Number(bench?.angle ?? bench?.yaw) || 0;
        if (![x, z].every(Number.isFinite)) continue;
        const seat = {
            id: `roof-bench:${surface.id}:${index}`,
            x,
            z,
            yaw,
            seatY: surface.floorY + 0.50,
            surfaceId: surface.id,
        };
        const frame = benchSeatFrame(seat);
        if (!frame
            || !roofActivityPointIsSafe(surface, frame.x, frame.z)
            || !roofActivityPointIsSafe(surface, frame.approachX, frame.approachZ)
            || !roofActivitySegmentIsSafe(surface, frame, {
                x: frame.approachX,
                z: frame.approachZ,
            })) continue;
        seats.push(seat);
    }
    replaceAmbientBenchSeats(benchOwner(surface.id), seats);
    return seats.length;
}

export function registerRoofActivitySurface({
    id,
    ownerId,
    rings,
    floorY,
    edgeMarginM,
    obstacles = [],
    benches = [],
} = {}) {
    // A streamed refresh replaces the old publication even when the new
    // footprint is too small or otherwise invalid. Retaining the last valid
    // polygon would leave walkers supported by a roof that no longer exists.
    if (id != null) unregisterSurface(String(id));
    const surface = createRoofActivitySurface({
        id,
        ownerId,
        rings,
        floorY,
        edgeMarginM,
        obstacles,
    });
    if (!surface) return null;
    surfacesById.set(surface.id, surface);
    surfaceIndex.set(surface.id, surface);
    let ownerIds = surfaceIdsByOwner.get(surface.ownerId);
    if (!ownerIds) surfaceIdsByOwner.set(surface.ownerId, ownerIds = new Set());
    ownerIds.add(surface.id);
    surface.benchCount = publishRoofBenchSeats(surface, benches);
    return surface;
}

export function unregisterRoofActivityOwner(ownerId) {
    const owner = String(ownerId);
    const ids = Array.from(surfaceIdsByOwner.get(owner) || []);
    for (const id of ids) unregisterSurface(id);
    return ids.length;
}

export function clearRoofActivitySurfaces() {
    for (const id of Array.from(surfacesById.keys())) unregisterSurface(id);
    surfaceIdsByOwner.clear();
    surfaceIndex.clear();
}

export function getRoofActivitySurface(id) {
    return surfacesById.get(String(id)) || null;
}

export function roofActivitySurfacesNear(localX, localZ, radiusM = 210) {
    const x = Number(localX);
    const z = Number(localZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const radius = Math.max(0, Number(radiusM) || 0);
    const radiusSq = radius * radius;
    const nearby = [];
    for (const surface of surfaceIndex.candidatesInBox(
        x - radius,
        z - radius,
        x + radius,
        z + radius,
    )) {
        const dx = x < surface.minX ? surface.minX - x
            : x > surface.maxX ? x - surface.maxX
            : 0;
        const dz = z < surface.minZ ? surface.minZ - z
            : z > surface.maxZ ? z - surface.maxZ
            : 0;
        if (dx * dx + dz * dz <= radiusSq) nearby.push(surface);
    }
    return nearby;
}

export function roofActivitySurfaceCount() {
    return surfacesById.size;
}
