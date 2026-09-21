// Builds the driveable centreline for one physical rail track carried by a
// rendered multi-track alignment. The source feature remains the civil/render
// authority; this derived feature is used only by the vehicle graph.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { resolveSolvedRailAlignment } from './rail-profile-source.js';

const TRACK_JOIN_MITER_LIMIT = 3;

function joinVector(previous, next) {
    if (!previous) return next || { x: 1, z: 0 };
    if (!next) return previous;
    let nextX = next.x;
    let nextZ = next.z;
    if (previous.x * nextX + previous.z * nextZ < 0) {
        nextX = -nextX;
        nextZ = -nextZ;
    }
    let x = previous.x + nextX;
    let z = previous.z + nextZ;
    const length = Math.hypot(x, z);
    if (length < 1e-5) return previous;
    x /= length;
    z /= length;
    const denominator = Math.max(
        1 / TRACK_JOIN_MITER_LIMIT,
        Math.abs(x * nextX + z * nextZ),
    );
    const scale = Math.min(TRACK_JOIN_MITER_LIMIT, 1 / denominator);
    return { x: x * scale, z: z * scale };
}

export function selectPhysicalTrackOffsetM(
    trackCenterOffsetsM,
    { initialEndpoint = 'first', runningSide = 'right' } = {},
) {
    const offsets = (trackCenterOffsetsM || [])
        .map(finiteOrNull)
        .filter(value => value !== null);
    if (offsets.length <= 1) return offsets[0] || 0;
    const travellingAgainstFeature = initialEndpoint === 'last';
    const wantsRight = String(runningSide || 'right').toLowerCase() !== 'left';
    const wantsPositive = travellingAgainstFeature === wantsRight;
    return wantsPositive ? Math.max(...offsets) : Math.min(...offsets);
}

export function offsetRailLineStringFeature(feature, centerOffsetM) {
    // The graph, parked rolling stock and rendered rails must start from the
    // same corrected axis before choosing one track of a multi-track line.
    [feature] = resolveSolvedRailAlignment([feature]);
    const offsetM = finiteOrNull(centerOffsetM);
    const coordinates = feature?.geometry?.type === 'LineString'
        ? feature.geometry.coordinates
        : null;
    if (!coordinates || coordinates.length < 2 || offsetM === null) return null;
    if (Math.abs(offsetM) < 1e-9) return feature;

    const valid = coordinates.every(coordinate => (
        finiteOrNull(coordinate?.[0]) !== null
        && finiteOrNull(coordinate?.[1]) !== null
    ));
    if (!valid) return null;

    const anchorLon = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[0]), 0)
        / coordinates.length;
    const anchorLat = coordinates.reduce((sum, coordinate) => sum + Number(coordinate[1]), 0)
        / coordinates.length;
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = metersPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const points = coordinates.map(coordinate => ({
        x: (Number(coordinate[0]) - anchorLon) * scaleLon,
        z: -(Number(coordinate[1]) - anchorLat) * metersPerDegree,
    }));
    const frames = [];
    for (let index = 0; index < points.length - 1; index += 1) {
        const dx = points[index + 1].x - points[index].x;
        const dz = points[index + 1].z - points[index].z;
        const length = Math.hypot(dx, dz);
        frames.push(length > 1e-6 ? { x: dz / length, z: -dx / length } : null);
    }
    const joins = points.map((_, index) => joinVector(frames[index - 1], frames[index]));
    const shifted = coordinates.map((coordinate, index) => {
        const point = points[index];
        const join = joins[index];
        const lon = anchorLon + (point.x + join.x * offsetM) / scaleLon;
        const lat = anchorLat - (point.z + join.z * offsetM) / metersPerDegree;
        return [lon, lat, ...coordinate.slice(2)];
    });

    return {
        ...feature,
        properties: {
            ...(feature.properties || {}),
            trackCount: 1,
            trackArrangement: 'single',
            physicalTrackOffsetM: offsetM,
            driverTrackOnly: true,
        },
        geometry: {
            ...feature.geometry,
            coordinates: shifted,
        },
    };
}
