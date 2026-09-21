// Resolves boarding actors and tram-door targets in the authored photo-track
// tangent frame while leaving the legacy flat/model coordinate path unchanged.

import { geoToLocal } from './math.js';

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function shouldSuppressPhotoStationBoarding({
    hasPhotoFrame = false,
    stopTrackId = null,
    runtimeStructure = null,
    rigidStructure = true,
} = {}) {
    return !!hasPhotoFrame
        && stopTrackId != null
        && runtimeStructure === 'tunnel'
        && rigidStructure === false;
}

export function boardingPointToScene({
    lon,
    lat,
    relativeHeightM = 0,
    anchorLon,
    anchorLat,
    photoTrackFrame = null,
} = {}) {
    const height = finite(relativeHeightM);
    if (photoTrackFrame) return photoTrackFrame.toScene(lon, lat, height);
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    return { x: local.x, y: height, z: local.z };
}

export function boardingPoseToScene({
    lon,
    lat,
    relativeHeightM = 0,
    headingDeg = 0,
    anchorLon,
    anchorLat,
    photoTrackFrame = null,
} = {}) {
    const height = finite(relativeHeightM);
    const point = boardingPointToScene({
        lon,
        lat,
        relativeHeightM: height,
        anchorLon,
        anchorLat,
        photoTrackFrame,
    });
    const orientation = photoTrackFrame?.orientationAt?.({
        lon,
        lat,
        relativeHeightM: height,
        headingDeg: finite(headingDeg),
    });
    return {
        ...point,
        headingDeg: Number.isFinite(Number(orientation?.headingDeg))
            ? Number(orientation.headingDeg)
            : finite(headingDeg),
    };
}

export function boardingPlatformFeetY({
    lon,
    lat,
    trackRelativeHeightM = 0,
    platformOffsetM = 0,
    anchorLon,
    anchorLat,
    photoTrackFrame = null,
} = {}) {
    return boardingPointToScene({
        lon,
        lat,
        relativeHeightM: trackRelativeHeightM,
        anchorLon,
        anchorLat,
        photoTrackFrame,
    }).y + finite(platformOffsetM);
}

// Where a stop's crowd stands, in scene Y. The whole point of this function is
// the first branch: a stop's `elevM` is ABSOLUTE (EVRF2000 a.s.l.), not a height
// above the ground, so adding the terrain's scene-Y to it counts the ground
// twice. Measured on Split's level-0 Trogirska cesta stop: elevM 41.12 + terrain
// 1.02 put the boarding crowd at 42.20 — passengers standing forty metres above
// a surface station. platforms.js already fixes exactly this for the shelters
// ("floating tens of metres up"); this is the same rule for the people.
//
// Relative heights (level x LEVEL_HEIGHT, what every stop carried before the
// planner cab began passing absolute elevations) genuinely ARE above the ground,
// and those still add the terrain.
export function platformFeetSceneY({
    elevM = null,
    platformOffsetM = 0,
    absoluteToSceneY = null,
    relativeFeetY = 0,
    terrainSceneY = 0,
} = {}) {
    if (Number.isFinite(elevM) && typeof absoluteToSceneY === 'function') {
        // NOT Number(...): Number(null) is 0 and Number.isFinite(0) is true, so
        // coercing here turns a converter that cannot answer into a platform at
        // the datum — a plausible-looking height that is pure fiction. This
        // codebase's most productive bug family, caught by its own test.
        const converted = absoluteToSceneY(elevM);
        if (typeof converted === 'number' && Number.isFinite(converted)) {
            return converted + platformOffsetM;
        }
        // Could not convert: fall through to the relative path rather than
        // invent a ground.
    }
    return relativeFeetY + terrainSceneY;
}
