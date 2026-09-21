// Versioned facade topology shared by the offline producer and browser. The DB
// clears it atomically whenever the source mesh changes; the payload retains a
// geometry signature for producer audits. Runtime validates the version, count,
// and every triangle membership before rebuilding scene-origin-dependent plane
// offsets and projected bounds linearly.

import {
    buildLogicalFacadeSurfaces,
    mergeDuplicateWallSurfaces,
    restoreLogicalFacadeSurfaces,
} from '../world/facade-surfaces.js';
import { localizeGdiFace } from './gdi-face-localization.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';

export const FACADE_TOPOLOGY_CACHE_VERSION = 5;

function fnv1aInteger(hash, value) {
    let next = (hash ^ (value | 0)) >>> 0;
    next = Math.imul(next, 0x01000193) >>> 0;
    next ^= Math.trunc(value / 0x100000000) | 0;
    return Math.imul(next, 0x01000193) >>> 0;
}

export function facadeGeometrySignature(geometry) {
    if (!geometry || geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) {
        return null;
    }
    let hash = 0x811c9dc5;
    let coordinateCount = 0;
    const visit = (value) => {
        if (Array.isArray(value)) {
            hash = fnv1aInteger(hash, 0x5b);
            for (const child of value) visit(child);
            hash = fnv1aInteger(hash, 0x5d);
            return;
        }
        const number = finiteOrNull(value);
        if (number == null) {
            hash = fnv1aInteger(hash, 0x7fffffff);
            return;
        }
        coordinateCount += 1;
        hash = fnv1aInteger(hash, Math.round(number * 1e7));
    };
    visit(geometry.coordinates);
    return `f${FACADE_TOPOLOGY_CACHE_VERSION}:${coordinateCount}:${hash.toString(16).padStart(8, '0')}`;
}

export function createFacadeTopologyCache(wallTriangles, geometry) {
    if (!Array.isArray(wallTriangles)) return null;
    const geometrySignature = facadeGeometrySignature(geometry);
    if (!geometrySignature) return null;
    const triangleIndex = new Map(wallTriangles.map((triangle, index) => [triangle, index]));
    const logicalSurfaces = buildLogicalFacadeSurfaces(wallTriangles);
    const fits = [];
    const fitIndexByKey = new Map();
    for (const surface of logicalSurfaces) {
        const fitKey = `${surface.nx}|${surface.nz}|${surface.d}|${surface.interiorSide}`;
        let fitIndex = fitIndexByKey.get(fitKey);
        if (fitIndex == null) {
            fitIndex = fits.length;
            fits.push({ triangles: [] });
            fitIndexByKey.set(fitKey, fitIndex);
        }
        for (const triangle of surface.worldTriangles || []) {
            const index = triangleIndex.get(triangle);
            if (!Number.isInteger(index)) return null;
            fits[fitIndex].triangles.push(index);
        }
    }
    for (const fit of fits) fit.triangles.sort((a, b) => a - b);

    const surfaces = [];
    for (const surface of mergeDuplicateWallSurfaces(logicalSurfaces)) {
        const indexes = [];
        for (const triangle of surface.worldTriangles || []) {
            const index = triangleIndex.get(triangle);
            if (!Number.isInteger(index)) return null;
            indexes.push(index);
        }
        if (indexes.length === 0) continue;
        const fitKey = `${surface.nx}|${surface.nz}|${surface.d}|${surface.interiorSide}`;
        const fit = fitIndexByKey.get(fitKey);
        if (!Number.isInteger(fit)) return null;
        surfaces.push({ fit, triangles: indexes });
    }
    return {
        version: FACADE_TOPOLOGY_CACHE_VERSION,
        geometry: geometrySignature,
        wall_triangles: wallTriangles.length,
        fits,
        surfaces,
    };
}

export function restoreFacadeTopologyCache(wallTriangles, cache) {
    if (!cache || cache.version !== FACADE_TOPOLOGY_CACHE_VERSION
        || cache.wall_triangles !== wallTriangles?.length
        || !Array.isArray(cache.fits)
        || !Array.isArray(cache.surfaces)) return null;
    return restoreLogicalFacadeSurfaces(wallTriangles, cache);
}

// Producer helper. It deliberately mirrors the renderer's fan triangulation
// and wall/roof test, but uses a deterministic per-mesh anchor so the stored
// membership stays independent of any Station3D session.
export function facadeWallTrianglesFromGeometry(geometry, zMin = null) {
    if (!geometry || geometry.type !== 'MultiPolygon' || !Array.isArray(geometry.coordinates)) {
        return [];
    }
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let inferredZMin = Infinity;
    for (const polygon of geometry.coordinates) {
        for (const ring of polygon || []) {
            for (const point of ring || []) {
                if (!Array.isArray(point)) continue;
                const lon = Number(point[0]);
                const lat = Number(point[1]);
                const z = Number(point[2]);
                if (Number.isFinite(lon)) { minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); }
                if (Number.isFinite(lat)) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
                if (Number.isFinite(z)) inferredZMin = Math.min(inferredZMin, z);
            }
        }
    }
    if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) return [];
    const anchorLon = (minLon + maxLon) / 2;
    const anchorLat = (minLat + maxLat) / 2;
    const statedZMin = finiteOrNull(zMin);
    const baseZ = statedZMin ?? (Number.isFinite(inferredZMin) ? inferredZMin : 0);
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const triangles = [];
    for (const polygonCoords of geometry.coordinates) {
        const verts = localizeGdiFace(
            polygonCoords,
            baseZ,
            anchorLat,
            anchorLon,
            scaleLon,
            scaleLat,
        );
        if (verts.length < 3) continue;
        const v0 = verts[0];
        for (let index = 1; index < verts.length - 1; index++) {
            const v1 = verts[index];
            const v2 = verts[index + 1];
            const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
            const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
            const cnx = e1y * e2z - e1z * e2y;
            const cny = e1z * e2x - e1x * e2z;
            const cnz = e1x * e2y - e1y * e2x;
            const length = Math.hypot(cnx, cny, cnz);
            if (length > 1e-6 && Math.abs(cny) / length <= 0.5) {
                triangles.push([v0, v1, v2]);
            }
        }
    }
    return triangles;
}

export function createFacadeTopologyCacheForGeometry(geometry, zMin = null) {
    const triangles = facadeWallTrianglesFromGeometry(geometry, zMin);
    return createFacadeTopologyCache(triangles, geometry);
}
