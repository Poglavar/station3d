// Resolves authored geographic platform endpoints into one local, renderable
// platform footprint. This keeps campaign and future scenario station data
// independent of the Three.js platform layer.

import { finiteOrNull, geoToLocal } from './math.js';

const MIN_PLATFORM_LENGTH_M = 4;
const MAX_PLATFORM_LENGTH_M = 500;
const MIN_PLATFORM_WIDTH_M = 2;
const MAX_PLATFORM_WIDTH_M = 20;

function finitePoint(point) {
    const lat = Number(point?.lat);
    const lon = Number(point?.lon ?? point?.lng);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

export function resolvePrimaryPlatformExtent(stop, { anchorLat, anchorLon } = {}) {
    const stopLat = Number(stop?.lat);
    const stopLon = Number(stop?.lon ?? stop?.lng);
    const candidates = (stop?.platformExtents || []).map((extent) => {
        const start = finitePoint(extent?.start);
        const end = finitePoint(extent?.end);
        if (!start || !end) return null;
        const startLocal = geoToLocal(start.lon, start.lat, anchorLon, anchorLat);
        const endLocal = geoToLocal(end.lon, end.lat, anchorLon, anchorLat);
        const dx = endLocal.x - startLocal.x;
        const dz = endLocal.z - startLocal.z;
        const rawLengthM = Math.hypot(dx, dz);
        if (!Number.isFinite(rawLengthM) || rawLengthM < MIN_PLATFORM_LENGTH_M) return null;
        const centerX = (startLocal.x + endLocal.x) * 0.5;
        const centerZ = (startLocal.z + endLocal.z) * 0.5;
        const stopLocal = Number.isFinite(stopLat) && Number.isFinite(stopLon)
            ? geoToLocal(stopLon, stopLat, anchorLon, anchorLat)
            : { x: centerX, z: centerZ };
        return {
            id: String(extent.id || ''),
            centerX,
            centerZ,
            angleY: Math.atan2(dx, dz),
            lengthM: clamp(rawLengthM, MIN_PLATFORM_LENGTH_M, MAX_PLATFORM_LENGTH_M),
            widthM: clamp(
                finiteOrNull(extent.widthM) ?? 4.2,
                MIN_PLATFORM_WIDTH_M,
                MAX_PLATFORM_WIDTH_M,
            ),
            side: extent.side || null,
            distanceToStopM: Math.hypot(centerX - stopLocal.x, centerZ - stopLocal.z),
        };
    }).filter(Boolean);
    candidates.sort((left, right) => left.distanceToStopM - right.distanceToStopM);
    return candidates[0] || null;
}
