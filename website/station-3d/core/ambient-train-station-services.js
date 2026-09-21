// Authored station locations select the shared ambient train service policy.
// Motion, dwell, boarding and ownership remain in ambient-tram-provider.js;
// this file only says where a station visit is appropriate.

import { geoToLocal, haversineMeters } from './math.js';

export const AMBIENT_TRAIN_STATION_SERVICES = Object.freeze([
    Object.freeze({
        id: 'split-kolodvor',
        lat: 43.504970,
        lon: 16.443016,
        activationRadiusM: 35_000,
        pathSnapToleranceM: 90,
        approachDistanceM: 500,
        clearDistanceM: 600,
        initialWaitMs: Object.freeze([5_000, 15_000]),
        dwellMs: Object.freeze([20_000, 32_000]),
        intervalMs: Object.freeze([75_000, 150_000]),
    }),
]);

export function ambientTrainStationServiceForAnchor(anchorLat, anchorLon) {
    const lat = Number(anchorLat);
    const lon = Number(anchorLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    let best = null;
    for (const service of AMBIENT_TRAIN_STATION_SERVICES) {
        const distanceM = haversineMeters(lat, lon, service.lat, service.lon);
        if (distanceM > service.activationRadiusM
            || (best && distanceM >= best.distanceM)) continue;
        const stationLocal = geoToLocal(service.lon, service.lat, lon, lat);
        best = {
            ...service,
            stationX: stationLocal.x,
            stationZ: stationLocal.z,
            distanceM,
        };
    }
    return best;
}
