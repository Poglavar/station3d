// Pure owner-aware station-flare policy. A combined rendered feature may carry
// several physical track owners, so crossings must never share station spacing.

import { stationTrackRouteMatches } from './planner-station-track-anchor.js';
import {
    getTrackCenterOffsetsAtSpacingMeters,
    getTrackCenterSpacingAtStationDistanceMeters,
} from '../world/tram-trackbed-dimensions.js';

export function plannerSegmentOwnerProperties(properties = {}, segmentIndex = 0) {
    const owner = Array.isArray(properties.segmentTrackIds)
        ? properties.segmentTrackIds[segmentIndex]
        : properties.trackId;
    if (owner == null) return properties;
    return {
        ...properties,
        trackId: owner,
        trackIds: [owner],
        segmentTrackIds: null,
    };
}

// Which stations actually push the two running track centres apart. Only a
// RIGID ISLAND HALL does: a route-following covered station keeps the ordinary
// spacing and a side platform, and a station whose stop never resolved to an
// anchor was never in the list to begin with.
//
// This is the one definition, because everything that has to sit on those rails
// has to agree with them. The ambient trains used to re-derive it from their own
// service stops and got it wrong by half the difference between the island
// spacing (13.2 m) and the running spacing (3.4 m) — 4.9 m, enough to park a
// train on the grass beside its platform.
export function stationFlaresThatSplayTrackCenters(stationFlares) {
    return (stationFlares || []).filter(station => station && !station.coveredRoute);
}

export function getOwnedEndpointTrackSpacingM(
    properties,
    x,
    z,
    elevationM,
    stationFlares,
) {
    let nearestDistanceM = Infinity;
    for (const station of stationFlares || []) {
        if (!stationTrackRouteMatches(properties, station.trackId)) continue;
        nearestDistanceM = Math.min(
            nearestDistanceM,
            Math.hypot(Number(x) - Number(station.x), Number(z) - Number(station.z)),
        );
    }
    // A matched station owns its horizontal cross-section. Do not feed the
    // route vertex's Y value into the legacy depth easing here: in terrain
    // model mode that value is absolute EVRF2000 elevation (about +100 m in
    // Zagreb), not depth below ground, and therefore collapsed the rails back
    // through the island. Outside the envelope the station contract already
    // returns ordinary running spacing.
    const ownedElevationM = Number.isFinite(nearestDistanceM) ? null : elevationM;
    return getTrackCenterSpacingAtStationDistanceMeters(
        properties,
        nearestDistanceM,
        ownedElevationM,
    );
}

// How far off the route axis something RIDING these rails sits, at one scene
// point: the outer track centre, measured at whatever spacing the rails were
// actually built to there. `stationFlares` must be the list the rails build
// published (stationFlaresThatSplayTrackCenters), so the two cannot disagree.
//
// Not half the spacing: a single-track route has ONE centre, on the axis, and
// halving its nominal spacing shoves every train on it 1.7 m into the grass.
export function ridingTrackCenterOffsetM(properties, x, z, stationFlares) {
    const spacingM = getOwnedEndpointTrackSpacingM(
        properties,
        x,
        z,
        // Never a scene Y here: in terrain-model mode that is absolute EVRF2000
        // elevation, which the legacy depth easing would read as a depth.
        null,
        stationFlares,
    );
    return Math.max(
        0,
        ...getTrackCenterOffsetsAtSpacingMeters(properties, spacingM)
            .map(offset => Math.abs(offset)),
    );
}
