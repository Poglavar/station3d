// Keeps planner station infrastructure in the same tangent-frame coordinates
// as authored photo-mode rails, without changing legacy/model placement.

import { geoToLocal } from './math.js';

export function plannerFeatureUsesPhotoFrame(properties, photoTrackFrame) {
    return !!photoTrackFrame && properties?.elevationDatum === 'asl';
}

// Model-mode tracks whose c[2] is authored ABSOLUTE EVRF2000 a.s.l. (no photo
// frame). Their elevation must be converted to scene-Y via terrain.absoluteToSceneY
// — the same datum the rail formation rides — not treated as a terrain-relative
// height (which would float the station by the whole terrain elevation).
export function plannerFeatureUsesAbsoluteElevation(properties) {
    return properties?.elevationMode === 'absolute' && properties?.elevationDatum === 'EVRF2000';
}

export function plannerScenePoint({
    lon,
    lat,
    elevationM = 0,
    anchorLon,
    anchorLat,
    photoTrackFrame = null,
    usePhotoFrame = false,
} = {}) {
    const elevation = Number(elevationM);
    const y = Number.isFinite(elevation) ? elevation : 0;
    if (usePhotoFrame && photoTrackFrame) {
        return photoTrackFrame.toScene(lon, lat, y);
    }
    const local = geoToLocal(lon, lat, anchorLon, anchorLat);
    return { x: local.x, y, z: local.z };
}

// Before Google tiles reveal, derive a DGU-ground fallback for the station
// group's origin. The platform layer may replace that origin with sampled local
// Google ground, but recomputes the opposite local track offset so their sum is
// always the immutable authored rail Y (including tangent-frame curvature).
export function resolvePhotoStationVerticalPlacement({
    photoTrackFrame,
    lon,
    lat,
    trackRelativeHeightM,
    trackSceneY,
    authoredGroundOffsetM,
    semanticLevel = 0,
    levelHeightM = 10,
} = {}) {
    if (!photoTrackFrame || !Number.isFinite(Number(trackSceneY))) return null;
    const trackHeight = Number(trackRelativeHeightM);
    if (!Number.isFinite(trackHeight)) return null;
    const authoredOffsetProvided = authoredGroundOffsetM !== null
        && authoredGroundOffsetM !== undefined
        && authoredGroundOffsetM !== '';
    const authoredOffset = Number(authoredGroundOffsetM);
    const fallbackOffset = Number(semanticLevel) * Number(levelHeightM);
    const groundOffsetM = authoredOffsetProvided && Number.isFinite(authoredOffset)
        ? authoredOffset
        : (Number.isFinite(fallbackOffset) ? fallbackOffset : 0);
    const ground = photoTrackFrame.toScene(lon, lat, trackHeight - groundOffsetM);
    if (!ground || !Number.isFinite(Number(ground.y))) return null;
    return {
        groundSceneY: Number(ground.y),
        trackLocalY: Number(trackSceneY) - Number(ground.y),
        groundOffsetM,
    };
}
