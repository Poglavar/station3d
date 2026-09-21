// Pure navigation math for the 2D HUD. No DOM, canvas or THREE dependencies.

import { signedAngleDiffDeg } from './math.js';

export const ZAGREB_CITY_CENTRE = Object.freeze({
    label: 'TBJJ',
    title: 'Trg bana Josipa Jelačića',
    lat: 45.8131,
    lon: 15.9772,
});

export const CITY_CENTRE_POINTER_PATH = 'M10 1 L18 10 H13 V23 H7 V10 H2 Z';

// How much ground the follow minimap shows around the player, and how far
// they may drift from the cached centre before the map re-centres. On foot
// and in a car 250 m is a neighbourhood; an aircraft crosses that in three
// seconds, so it gets a coastline-scale window, and the re-centre step scales
// with the window so a fast vehicle does not jump the map every second.
export const MINIMAP_FOLLOW_SPANS_M = Object.freeze({
    walk: 250,
    aircraft: 1500,
    boatDocking: 60,
    vehicleExit: 24,
});
export const MINIMAP_FOLLOW_RECENTER_M = 60;

export function minimapFollowSpan({ vehicleKind = null, vehicleExitTarget = false, nearBoatDestination = false } = {}) {
    const halfSpanM = vehicleExitTarget ? MINIMAP_FOLLOW_SPANS_M.vehicleExit
        : nearBoatDestination ? MINIMAP_FOLLOW_SPANS_M.boatDocking
            : vehicleKind === 'aircraft' ? MINIMAP_FOLLOW_SPANS_M.aircraft
                : MINIMAP_FOLLOW_SPANS_M.walk;
    const recenterM = Math.min(halfSpanM * 0.24, Math.max(MINIMAP_FOLLOW_RECENTER_M, halfSpanM * 0.12));
    return { halfSpanM, recenterM };
}

export function minimapViewportTransform({
    centerX = 0,
    centerZ = 0,
    halfSpanM,
    size,
    padding,
} = {}) {
    const mapSize = Number.isFinite(size) ? Math.max(1, size) : 1;
    const inset = Number.isFinite(padding)
        ? Math.max(0, Math.min(mapSize / 2 - 0.5, padding))
        : 0;
    const radius = Number.isFinite(halfSpanM) ? Math.max(1, halfSpanM) : 1;
    return {
        centerX: Number.isFinite(centerX) ? centerX : 0,
        centerZ: Number.isFinite(centerZ) ? centerZ : 0,
        size: mapSize,
        scale: (mapSize - inset * 2) / (radius * 2),
    };
}

export function minimapPointToScreen(transform, x, z) {
    const size = Number(transform?.size) || 1;
    const scale = Number(transform?.scale) || 1;
    return {
        sx: size / 2 + ((Number(x) || 0) - (Number(transform?.centerX) || 0)) * scale,
        sy: size / 2 + ((Number(z) || 0) - (Number(transform?.centerZ) || 0)) * scale,
    };
}

export function minimapViewportNeedsRecenter({
    centerX,
    centerZ,
    playerX,
    playerZ,
    thresholdM,
} = {}) {
    const threshold = Number.isFinite(thresholdM) ? Math.max(0, thresholdM) : 0;
    return Math.hypot(
        (Number(playerX) || 0) - (Number(centerX) || 0),
        (Number(playerZ) || 0) - (Number(centerZ) || 0),
    ) >= threshold;
}

export function minimapMarkerPlacement({
    sx,
    sy,
    headingDeg = 0,
    size,
    padding,
}) {
    const min = padding;
    const max = size - padding;
    const inside = sx >= min && sx <= max && sy >= min && sy <= max;
    if (inside) {
        return {
            sx,
            sy,
            rotationDeg: Number.isFinite(headingDeg) ? headingDeg : 0,
            offMap: false,
        };
    }

    const center = size / 2;
    const dx = sx - center;
    const dy = sy - center;
    // Intersect the centre-to-player ray with the inset map rectangle. This
    // keeps the marker on the correct edge even when the player is far beyond
    // two sides of the fixed route extent.
    const half = Math.max(1, size / 2 - padding);
    const scale = half / Math.max(Math.abs(dx), Math.abs(dy), 1e-9);
    return {
        sx: center + dx * scale,
        sy: center + dy * scale,
        // Canvas heading convention: 0 points up and +90 points right.
        rotationDeg: Math.atan2(dx, -dy) * 180 / Math.PI,
        offMap: true,
    };
}

export function cityCentreGuidance({
    x,
    z,
    headingDeg = 0,
    targetX,
    targetZ,
}) {
    const dx = targetX - x;
    const dz = targetZ - z;
    const bearingDeg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    return {
        bearingDeg,
        relativeBearingDeg: signedAngleDiffDeg(bearingDeg, headingDeg),
        distanceM: Math.hypot(dx, dz),
    };
}

export function formatGuidanceDistance(distanceM) {
    if (!Number.isFinite(distanceM)) return '';
    if (distanceM < 20) return `${Math.max(1, Math.ceil(distanceM))} m`;
    if (distanceM < 950) return `${Math.max(0, Math.round(distanceM / 10) * 10)} m`;
    return `${(distanceM / 1000).toFixed(distanceM < 9950 ? 1 : 0)} km`;
}

// The three centred pills form one column: the vehicle status row (health and
// the exit prompt), then the instrument readouts, then the bearing to the
// objective. Both stacking rules take the row above as a measured rectangle, so
// a longer prompt or a taller readout pushes the rest down instead of colliding.
export function routeOverlayTopPx({
    statusVisible = false,
    statusTopPx = 12,
    statusHeightPx = 32,
    basePx = 14,
    gapPx = 8,
    // Phones stack the readouts in the top-right corner (see shell.css) and
    // reserve the whole status band above them whether or not a prompt is
    // showing, so a prompt appearing never moves them. The band is the pill's
    // tallest single line plus its gap.
    stackedBandPx = null,
} = {}) {
    const base = Number.isFinite(basePx) ? Math.max(0, basePx) : 14;
    const top = Number.isFinite(statusTopPx) ? Math.max(0, statusTopPx) : 12;
    if (Number.isFinite(stackedBandPx) && stackedBandPx > 0) return top + stackedBandPx;
    if (!statusVisible) return base;
    const height = Number.isFinite(statusHeightPx) ? Math.max(0, statusHeightPx) : 32;
    const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 8;
    return Math.max(base, top + height + gap);
}

export function cityCentreGuideTopPx({
    walkMode = false,
    // The route overlay carries the vehicle line (health, exit prompt) once the
    // player is driving; the guide must stack under it there too, or the bearing
    // lands on top of the exit prompt the moment the player boards.
    routeVisible = false,
    baseTopPx = 12,
    routeTopPx = 14,
    routeHeightPx = 40,
    gapPx = 8,
} = {}) {
    const base = Number.isFinite(baseTopPx) ? Math.max(0, baseTopPx) : 12;
    if (!walkMode && !routeVisible) return base;
    const routeTop = Number.isFinite(routeTopPx) ? Math.max(0, routeTopPx) : 14;
    const routeHeight = Number.isFinite(routeHeightPx)
        ? Math.max(0, routeHeightPx)
        : 40;
    const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 8;
    return Math.max(base, routeTop + routeHeight + gap);
}

// Reaching a waypoint advances the cue monotonically. The swept segment also
// catches a small waypoint crossed between two samples at vehicle speed.
export function advanceNavigationWaypoint(waypoints, index, player, previous = player) {
    let next = Math.max(0, Math.trunc(index) || 0);
    if (![player?.x, player?.z].every(Number.isFinite)) return next;
    const start = [previous?.x, previous?.z].every(Number.isFinite) ? previous : player;
    const dx = player.x - start.x, dz = player.z - start.z;
    const lengthSq = dx * dx + dz * dz;
    while (next < waypoints.length) {
        const point = waypoints[next];
        if (![point?.x, point?.z].every(Number.isFinite)) { next += 1; continue; }
        const radius = Number.isFinite(point.radiusM) ? Math.max(.5, point.radiusM) : 12;
        const t = lengthSq ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq)) : 0;
        if (Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t) > radius) break;
        next += 1;
    }
    return next;
}

// An objective may carry two cue lines: `waypoints` for the driving line and
// `walkWaypoints` for the pedestrian one. On foot the walk line wins when it
// exists; a vehicle always follows the driving line.
export function navigationWaypointsFor(target, { driving = false } = {}) {
    if (!target) return [];
    const walk = Array.isArray(target.walkWaypoints) ? target.walkWaypoints : null;
    const drive = Array.isArray(target.waypoints) ? target.waypoints : [];
    return !driving && walk ? walk : drive;
}

// A cue the player has left behind must not keep the pill pointing backwards.
// When the current waypoint is far (beyond `minDistanceM` and `radiusFactor`
// radii) AND receding since the last sample, jump forward to the nearest
// later waypoint if that one is closer. Never moves backwards.
export function skipRecedingWaypoint(waypoints, index, player, previous, { minDistanceM = 60, radiusFactor = 4 } = {}) {
    const current = Math.max(0, Math.trunc(index) || 0);
    const point = waypoints?.[current];
    if (!point || ![player?.x, player?.z, point.x, point.z].every(Number.isFinite)) return current;
    const distance = Math.hypot(player.x - point.x, player.z - point.z);
    const radius = Number.isFinite(point.radiusM) ? Math.max(.5, point.radiusM) : 12;
    if (distance <= Math.max(minDistanceM, radiusFactor * radius)) return current;
    const before = [previous?.x, previous?.z].every(Number.isFinite)
        ? Math.hypot(previous.x - point.x, previous.z - point.z)
        : distance;
    if (distance <= before) return current;
    let best = { index: current, distance };
    for (let i = current + 1; i < waypoints.length; i++) {
        const candidate = waypoints[i];
        if (![candidate?.x, candidate?.z].every(Number.isFinite)) continue;
        const d = Math.hypot(player.x - candidate.x, player.z - candidate.z);
        if (d < best.distance) best = { index: i, distance: d };
    }
    return best.index;
}

export function rejoinNavigationRoute(waypoints, destination, index, player, maxDistanceM = 12) {
    let next = Math.max(0, Math.trunc(index) || 0);
    if (![player?.x, player?.z].every(Number.isFinite)) return next;
    const points = [...(waypoints || []), destination].filter(point =>
        [point?.x, point?.z].every(Number.isFinite));
    const limit = Math.max(12, Number(maxDistanceM) || 0);
    let best = null;
    for (let i = next; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        if (!lengthSq) continue;
        const t = Math.max(0, Math.min(1, ((player.x - a.x) * dx + (player.z - a.z) * dz) / lengthSq));
        if (t <= 0) continue;
        const distance = Math.hypot(player.x - (a.x + dx * t), player.z - (a.z + dz * t));
        if (distance <= limit && (!best || distance < best.distance)) best = { index: i + 1, distance };
    }
    return best ? Math.max(next, best.index) : next;
}
