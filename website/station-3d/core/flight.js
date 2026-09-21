// Freeform flight camera: pure math for flying the camera independently of the
// train, reusing the campaign cinematic contract ({position, lookAt, fovDeg}
// with geographic poses and heightM above a stable filming ground reference).
//
// Two ways to fly, one module:
//  - a FOLLOW profile derives the camera each frame from the live cab pose
//    (a drone pacing the train at a lateral/vertical offset). This is the
//    default for recordings, because detailed streaming only exists in a
//    CAB_RING bubble (~±400 m) around the train — an authored path that drifts
//    from the train flies into unbuilt world.
//  - an authored TRACK is the campaign cinematic keyframe schema, validated
//    here so a hand-written JSON fails loudly at play() instead of sampling
//    NaN poses silently.
//
// No DOM, no three.js: inputs are plain poses and profiles, outputs are plain
// camera frames, so all of it runs under node --test.

import { geoToLocal } from './math.js';

const METERS_PER_DEG_LAT = 110574;
const METERS_PER_DEG_LON_EQUATOR = 111320;
const DEG_TO_RAD = Math.PI / 180;

function finite(value) {
    // Number(null) is 0 — an ABSENT value must stay absent, or a missing
    // fovDeg becomes a real-looking 0° lens.
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Geographic point `meters` away from (lat, lon) along `bearingDeg`
// (0 = north, 90 = east). Equirectangular — fine at flight scales.
export function offsetGeo(lat, lon, bearingDeg, meters) {
    const bearing = bearingDeg * DEG_TO_RAD;
    const dNorth = Math.cos(bearing) * meters;
    const dEast = Math.sin(bearing) * meters;
    return {
        lat: lat + dNorth / METERS_PER_DEG_LAT,
        lon: lon + dEast / (METERS_PER_DEG_LON_EQUATOR * Math.cos(lat * DEG_TO_RAD)),
    };
}

export const DEFAULT_FOLLOW_PROFILE = Object.freeze({
    side: 'left',       // which side of the direction of travel the drone rides
    sideM: 140,         // lateral offset from the track
    heightM: 55,        // camera height above the recording's initial ground
    behindM: 0,         // >0 trails the train, <0 leads it
    aheadM: 260,        // how far ahead of the train the camera looks
    lookHeightM: 12,    // lookAt height above its initial ground — low = onto roofs
    fovDeg: null,       // null keeps the scene camera's own FOV
});

export function normalizeFollowProfile(profile = {}) {
    const merged = { ...DEFAULT_FOLLOW_PROFILE, ...profile };
    const side = merged.side === 'right' ? 'right' : 'left';
    const num = (key) => {
        const value = finite(merged[key]);
        if (value === null && key !== 'fovDeg') {
            throw new Error(`flight follow profile: ${key} is not a number`);
        }
        return value === null ? null : value;
    };
    return {
        side,
        sideM: num('sideM'),
        heightM: num('heightM'),
        behindM: num('behindM'),
        aheadM: num('aheadM'),
        lookHeightM: num('lookHeightM'),
        fovDeg: finite(merged.fovDeg),
    };
}

// One camera frame from the live pose. Null pose (or a pose without a fix)
// returns null, which the cab loop treats as "no override this frame".
export function flightCameraFromPose(pose, profile) {
    const lat = finite(pose?.lat);
    const lon = finite(pose?.lon);
    const headingDeg = finite(pose?.headingDeg) ?? 0;
    if (lat === null || lon === null) return null;

    const sideBearing = headingDeg + (profile.side === 'right' ? 90 : -90);
    const lateral = offsetGeo(lat, lon, sideBearing, profile.sideM);
    const position = offsetGeo(lateral.lat, lateral.lon, headingDeg, -profile.behindM);
    const look = offsetGeo(lat, lon, headingDeg, profile.aheadM);
    return {
        position: { lat: position.lat, lon: position.lon, heightM: profile.heightM },
        lookAt: { lat: look.lat, lon: look.lon, heightM: profile.lookHeightM },
        ...(profile.fovDeg !== null ? { fovDeg: profile.fovDeg } : {}),
    };
}

// One resolver belongs to one filming session. Geographic camera and aim
// heights use their initial ground, so terrain bumps and later tile updates
// cannot bend an authored move or nod its eyeline. A new explicit reference
// (for example, another dialogue speaker) starts a new ground frame. Missing
// terrain waits for its first real sample; water/gaps afterward keep that frame.
export function createFlightCameraResolver({ anchorLon, anchorLat, groundYAt }) {
    let referenceKey;
    let cameraGroundY = null;
    let lookGroundY = null;
    const localPoint = (point) => finite(point?.lat) !== null && finite(point?.lon) !== null
        ? geoToLocal(Number(point.lon), Number(point.lat), anchorLon, anchorLat)
        : null;
    return (frame) => {
        // Subject-relative shots already carry scene coordinates. Tracking an
        // aircraft must preserve its altitude without consulting the ground.
        if (frame?.local?.position && frame?.local?.lookAt) {
            return { ...frame.local, fovDeg: finite(frame.local.fovDeg ?? frame.fovDeg) };
        }
        const position = localPoint(frame?.position);
        const lookAt = localPoint(frame?.lookAt);
        if (!position || !lookAt) return null;
        const reference = localPoint(frame.groundReference);
        const key = reference ? JSON.stringify(frame.groundReference) : null;
        if (key !== referenceKey) {
            referenceKey = key;
            cameraGroundY = null;
            lookGroundY = null;
        }
        if (reference) {
            cameraGroundY ??= finite(groundYAt(reference.x, reference.z, frame.groundReference));
            lookGroundY = cameraGroundY;
        } else {
            cameraGroundY ??= finite(groundYAt(position.x, position.z));
            lookGroundY ??= finite(groundYAt(lookAt.x, lookAt.z));
        }
        if (cameraGroundY === null || lookGroundY === null) return null;
        return {
            position: { ...position, y: cameraGroundY + (finite(frame.position.heightM) ?? 0) },
            lookAt: { ...lookAt, y: lookGroundY + (finite(frame.lookAt.heightM) ?? 0) },
            fovDeg: finite(frame.fovDeg),
        };
    };
}

// Authored tracks reuse the campaign cinematic schema; sampleCinematic already
// interpolates them. This only guards the invariants a hand-written JSON can
// break: every keyframe placed in time and in the world, times monotonic.
export function normalizeFlightTrack(track) {
    const durationMs = finite(track?.durationMs);
    if (durationMs === null || durationMs <= 0) {
        throw new Error('flight track: durationMs must be a positive number');
    }
    const keyframes = Array.isArray(track?.keyframes) ? track.keyframes : [];
    if (keyframes.length < 2) {
        throw new Error('flight track: need at least 2 keyframes');
    }
    let prevAt = -Infinity;
    for (const [index, frame] of keyframes.entries()) {
        const atMs = finite(frame?.atMs);
        if (atMs === null || atMs < prevAt) {
            throw new Error(`flight track: keyframes[${index}].atMs must be a number, non-decreasing`);
        }
        prevAt = atMs;
        for (const slot of ['position', 'lookAt']) {
            const pose = frame?.camera?.[slot];
            if (finite(pose?.lat) === null || finite(pose?.lon) === null || finite(pose?.heightM) === null) {
                throw new Error(`flight track: keyframes[${index}].camera.${slot} needs finite lat/lon/heightM`);
            }
        }
    }
    return { durationMs, keyframes };
}
