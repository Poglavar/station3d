// Predictive focus for the surface layers a fast vehicle can physically reach.
// The current position remains a separate hard-support anchor in each layer;
// this point only moves the next road/formation/terrain work ahead of the car.

import { DEG_TO_RAD, finiteOrNull, localToGeo } from './math.js';

export const VEHICLE_SURFACE_STREAMING = Object.freeze({
    lookAheadSeconds: 6,
    baseLeadM: 40,
    baseLeadFullSpeedMps: 5,
    brakingDecelerationMps2: 6,
    brakingDistanceShare: 0.5,
    maximumLeadM: 260,
    minimumMotionMps: 0.35,
});

// A controller that owns an exact route can safely look farther ahead than a
// freely steering car. The atomic terrain/road/rail compositor has measured
// 22-26 second publications on the Split corridor under load, so 35 seconds
// leaves recovery margin instead of letting a 70 km/h train reach an unfinished
// generation. The cap keeps the moving window bounded. This is
// controller-independent: any routed vehicle can provide the sampler used by
// routedVehicleSurfaceStreamingFocus().
export const ROUTED_VEHICLE_SURFACE_STREAMING = Object.freeze({
    ...VEHICLE_SURFACE_STREAMING,
    lookAheadSeconds: 35,
    baseLeadM: 100,
    maximumLeadM: 1200,
});

function normalizeHeadingDeg(headingDeg) {
    const heading = finiteOrNull(headingDeg);
    if (heading === null) return 0;
    return ((heading % 360) + 360) % 360;
}

function headingVector(headingDeg) {
    const heading = normalizeHeadingDeg(headingDeg) * DEG_TO_RAD;
    return { x: Math.sin(heading), z: -Math.cos(heading) };
}

export function vehicleSurfaceLeadM(speedMps, tuning = VEHICLE_SURFACE_STREAMING) {
    const speed = Math.abs(finiteOrNull(speedMps) ?? 0);
    const minimumMotionMps = Math.max(0, finiteOrNull(tuning.minimumMotionMps) ?? 0);
    if (speed < minimumMotionMps) return 0;
    const lookAheadSeconds = Math.max(0, finiteOrNull(tuning.lookAheadSeconds) ?? 0);
    const baseLeadM = Math.max(0, finiteOrNull(tuning.baseLeadM) ?? 0);
    const baseLeadFullSpeedMps = Math.max(
        minimumMotionMps,
        finiteOrNull(tuning.baseLeadFullSpeedMps) ?? 1,
    );
    const brakingDecelerationMps2 = Math.max(
        0.1,
        finiteOrNull(tuning.brakingDecelerationMps2) ?? 6,
    );
    const brakingDistanceShare = Math.max(
        0,
        finiteOrNull(tuning.brakingDistanceShare) ?? 0,
    );
    const maximumLeadM = Math.max(0, finiteOrNull(tuning.maximumLeadM) ?? 0);
    const baseRamp = Math.min(1, speed / baseLeadFullSpeedMps);
    const brakingDistanceM = speed * speed / (2 * brakingDecelerationMps2);
    return Math.min(
        maximumLeadM,
        speed * lookAheadSeconds
            + baseLeadM * baseRamp
            + brakingDistanceM * brakingDistanceShare,
    );
}

export function routedVehicleSurfaceStreamingFocus({
    local,
    speedMps = 0,
    headingDeg = 0,
    sampleRouteLocal,
    tuning = ROUTED_VEHICLE_SURFACE_STREAMING,
} = {}) {
    const x = finiteOrNull(local?.x) ?? 0;
    const z = finiteOrNull(local?.z) ?? 0;
    const signedSpeedMps = finiteOrNull(speedMps) ?? 0;
    const speed = Math.abs(signedSpeedMps);
    const leadM = vehicleSurfaceLeadM(speed, tuning);
    const reverse = signedSpeedMps < 0;
    const fallbackHeadingDeg = normalizeHeadingDeg(
        (finiteOrNull(headingDeg) ?? 0) + (reverse ? 180 : 0),
    );
    if (!(leadM > 0) || typeof sampleRouteLocal !== 'function') {
        return { x, z, headingDeg: fallbackHeadingDeg, leadM: 0, speedMps: speed };
    }
    const sample = sampleRouteLocal(reverse ? -leadM : leadM);
    const sampleX = finiteOrNull(sample?.x);
    const sampleZ = finiteOrNull(sample?.z);
    if (sampleX === null || sampleZ === null) {
        return { x, z, headingDeg: fallbackHeadingDeg, leadM: 0, speedMps: speed };
    }
    return {
        x: sampleX,
        z: sampleZ,
        headingDeg: normalizeHeadingDeg(
            (finiteOrNull(sample?.headingDeg) ?? headingDeg) + (reverse ? 180 : 0),
        ),
        leadM,
        speedMps: speed,
    };
}

// The source loaders can rank work at the full look-ahead point because they
// retain the current support ring separately. A bounded atomic ground
// publication has one centre, so place it halfway across that interval: its
// finite terrain/rail window then covers both the vehicle and the work it is
// preparing rather than abandoning either end of the corridor.
export function vehicleSurfaceGenerationCenter(local, focus) {
    const x = finiteOrNull(local?.x) ?? 0;
    const z = finiteOrNull(local?.z) ?? 0;
    const focusX = finiteOrNull(focus?.x);
    const focusZ = finiteOrNull(focus?.z);
    if (focusX === null || focusZ === null) return { x, z };
    return { x: (x + focusX) * 0.5, z: (z + focusZ) * 0.5 };
}

// Network-backed surface sources use geographic bounds, while the shared
// predictive focus is expressed in local world metres. Convert the exact
// route-ahead point when one exists and otherwise retain the current pose.
// This lets slow coastal/terrain source work start ahead without changing the
// renderer or giving routed vehicles a separate publication path.
export function vehicleSurfaceStreamingGeoTarget({ pose, anchorLon, anchorLat } = {}) {
    const lat = finiteOrNull(pose?.lat);
    const lon = finiteOrNull(pose?.lon);
    if (lat === null || lon === null) return null;
    const focusX = finiteOrNull(pose?.surfaceStreamingFocus?.x);
    const focusZ = finiteOrNull(pose?.surfaceStreamingFocus?.z);
    const originLon = finiteOrNull(anchorLon);
    const originLat = finiteOrNull(anchorLat);
    if (focusX === null || focusZ === null || originLon === null || originLat === null) {
        return { lat, lon };
    }
    return localToGeo(focusX, focusZ, originLon, originLat);
}

export function vehicleSurfaceStreamingFocus({
    local,
    vehiclePose,
    headingDeg,
    tuning = VEHICLE_SURFACE_STREAMING,
} = {}) {
    const x = finiteOrNull(local?.x) ?? finiteOrNull(vehiclePose?.x) ?? 0;
    const z = finiteOrNull(local?.z) ?? finiteOrNull(vehiclePose?.z) ?? 0;
    const velocityX = finiteOrNull(vehiclePose?.velocityX);
    const velocityZ = finiteOrNull(vehiclePose?.velocityZ);
    const measuredSpeedMps = velocityX !== null && velocityZ !== null
        ? Math.hypot(velocityX, velocityZ)
        : null;
    const signedSpeedMps = finiteOrNull(vehiclePose?.speedMps) ?? 0;
    const speedMps = measuredSpeedMps ?? Math.abs(signedSpeedMps);
    const minimumMotionMps = Math.max(0, finiteOrNull(tuning.minimumMotionMps) ?? 0);

    let travelHeadingDeg = normalizeHeadingDeg(
        finiteOrNull(headingDeg) ?? vehiclePose?.headingDeg,
    );
    let direction = headingVector(travelHeadingDeg);
    if (measuredSpeedMps !== null && measuredSpeedMps >= minimumMotionMps) {
        direction = {
            x: velocityX / measuredSpeedMps,
            z: velocityZ / measuredSpeedMps,
        };
        travelHeadingDeg = normalizeHeadingDeg(
            Math.atan2(direction.x, -direction.z) / DEG_TO_RAD,
        );
    } else if (signedSpeedMps < -minimumMotionMps) {
        travelHeadingDeg = normalizeHeadingDeg(travelHeadingDeg + 180);
        direction = headingVector(travelHeadingDeg);
    }

    if (speedMps < minimumMotionMps) {
        return {
            x,
            z,
            headingDeg: travelHeadingDeg,
            leadM: 0,
            speedMps,
        };
    }

    const leadM = vehicleSurfaceLeadM(speedMps, tuning);

    return {
        x: x + direction.x * leadM,
        z: z + direction.z * leadM,
        headingDeg: travelHeadingDeg,
        leadM,
        speedMps,
    };
}
