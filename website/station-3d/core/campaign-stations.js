// Defines heavy-rail arrival bands and evaluates stopping/door exchange from
// serializable session snapshots without depending on the 3D renderer.

import { haversineMeters } from './math.js';

function pointSegmentDistanceM(point, start, end) {
    const lat0 = Number(point.lat) * Math.PI / 180;
    const metersPerLat = 111_320;
    const metersPerLon = Math.cos(lat0) * metersPerLat;
    const px = Number(point.lon) * metersPerLon;
    const py = Number(point.lat) * metersPerLat;
    const ax = Number(start.lon) * metersPerLon;
    const ay = Number(start.lat) * metersPerLat;
    const bx = Number(end.lon) * metersPerLon;
    const by = Number(end.lat) * metersPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function railArrivalDistanceM(station, pose) {
    if (station?.arrivalBand?.start && station?.arrivalBand?.end) {
        return pointSegmentDistanceM(pose, station.arrivalBand.start, station.arrivalBand.end);
    }
    return haversineMeters(
        Number(pose?.lat),
        Number(pose?.lon),
        Number(station?.stoppingPoint?.lat),
        Number(station?.stoppingPoint?.lon),
    );
}

export function evaluateRailArrival(station, snapshot = {}) {
    const distanceM = railArrivalDistanceM(station, snapshot.pose || snapshot);
    const inArrivalBand = distanceM <= Number(station?.arrivalBand?.widthM || 8);
    const speedMps = Math.abs(Number(snapshot.speedMps ?? snapshot.pose?.speedMps) || 0);
    const stopped = speedMps <= Number(station?.stoppedSpeedMps ?? 0.15);
    const doorsOpen = snapshot.doorsOpen === true || Number(snapshot.doorRatio) >= 0.8;
    return {
        stationId: station?.id || null,
        distanceM,
        inArrivalBand,
        stopped,
        doorsOpen,
        complete: inArrivalBand && stopped && doorsOpen,
    };
}
