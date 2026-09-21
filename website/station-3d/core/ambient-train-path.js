// Pure path preparation and sampling for articulated ambient trains.

import { finiteOrNull } from './math.js';

// Pins a legacy train sample to the rail path that produced it. At a
// grade-separated crossing, a global nearest-formation query is horizontally
// ambiguous and can return the viaduct above instead.
//
// `deckTopM` is load-bearing and was missing. The stylized viaduct is modelled
// with its deck top at DECK_TOP_Y internally, and a sample's `yOff` is only the
// CORRECTION applied to that — 0 for a full-height viaduct, −(deckTop − groundBed)
// where the ground gate has lowered it to a bed, and the same negative constant
// when the whole line is draped on DGU terrain. So the rail head is at
// deckTop + yOff (+ terrain), and computing terrain + yOff alone put every legacy
// train exactly DECK_TOP_Y below its own track: sitting on the ground under the
// viaduct in the flat world, and buried under the terrain — hence invisible, hence
// unreported — in the elevation world.
export function legacyTrainRailPoint(point, terrainY = 0, deckTopM = 0) {
    if (!point) return null;
    if (finiteOrNull(point.railY) != null) return point;
    const baseY = Number(terrainY);
    const yOff = Number(point.yOff);
    const deckTop = Number(deckTopM);
    return {
        ...point,
        railY: (Number.isFinite(baseY) ? baseY : 0)
            + (Number.isFinite(yOff) ? yOff : 0)
            + (Number.isFinite(deckTop) ? deckTop : 0),
    };
}

// Which drawn-track features each ambient-train system rides. Planner tracks
// carry timetabled SERVICES (two trains shuttling with stops); a
// consensus-builder track proposal has no timetable, so it feeds the ROAMING
// spawner instead — a train materializes down the line near the walker and
// rolls past, the legacy-rail behaviour.
export const PROJECT_TRACK_SOURCES = new Set(['user', 'user-line']);
export const ROAMING_TRACK_SOURCES = new Set(['cb-proposal']);

export function selectAmbientTrainTrackFeatures(features, sources) {
    return (Array.isArray(features) ? features : []).filter((feature) => (
        sources.has(feature?.properties?.source)
        && feature?.geometry?.type === 'LineString'
    ));
}

// The rail head for one project/proposal coordinate, from already-resolved
// samples. The formation is the authority whenever it answers — it is what
// seats the visible rails, bridge deck included. Absolute heights WITHOUT a
// formation are refused rather than guessed (treating EVRF2000 metres as a
// local lift would hang the train ~100 m above the scene); the caller drops
// the point. Everything else rides terrain plus the coordinate's own lift.
export function projectTrackRailPoint({
    x,
    z,
    elevationM = null,
    elevationMode = null,
    formationRailY = null,
    terrainY = null,
} = {}) {
    const localX = finiteOrNull(x);
    const localZ = finiteOrNull(z);
    if (localX == null || localZ == null) return null;
    const formation = finiteOrNull(formationRailY);
    if (formation != null) return { x: localX, z: localZ, railY: formation };
    if (elevationMode === 'absolute') return null;
    const terrain = finiteOrNull(terrainY);
    if (terrain == null) return null;
    return {
        x: localX,
        z: localZ,
        railY: terrain + (finiteOrNull(elevationM) ?? 0),
    };
}

function interpolateOptional(a, b, key, t) {
    const start = finiteOrNull(a?.[key]);
    const end = finiteOrNull(b?.[key]);
    if (start == null && end == null) return null;
    if (start == null) return end;
    if (end == null) return start;
    return start + (end - start) * t;
}

function poseOnSegment(a, b, distanceM, segmentLengthM, direction) {
    if (!(segmentLengthM > 1e-6)) return null;
    const t = distanceM / segmentLengthM;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const pose = {
        x: a.x + dx * t,
        z: a.z + dz * t,
        heading: Math.atan2(dx * direction, -dz * direction),
        pitch: 0,
    };
    const yOff = interpolateOptional(a, b, 'yOff', t);
    if (yOff != null) pose.yOff = yOff;
    const railY = interpolateOptional(a, b, 'railY', t);
    if (railY != null) {
        pose.railY = railY;
        pose.pitch = Math.atan2(
            ((finiteOrNull(b?.railY) ?? railY) - (finiteOrNull(a?.railY) ?? railY)) * direction,
            segmentLengthM,
        );
    }
    return pose;
}

export function prepareAmbientTrainPath(points, {
    minimumLengthM = 0,
    ...metadata
} = {}) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const first = points[0];
    if (finiteOrNull(first?.x) == null || finiteOrNull(first?.z) == null) return null;
    const cleanPoints = [first];
    const cumulative = [0];
    let totalLength = 0;
    for (let index = 1; index < points.length; index++) {
        const previous = cleanPoints[cleanPoints.length - 1];
        const point = points[index];
        if (finiteOrNull(point?.x) == null || finiteOrNull(point?.z) == null) continue;
        const lengthM = Math.hypot(point.x - previous.x, point.z - previous.z);
        if (lengthM < 0.05) continue;
        totalLength += lengthM;
        cleanPoints.push(point);
        cumulative.push(totalLength);
    }
    if (cleanPoints.length < 2 || totalLength < Math.max(0, Number(minimumLengthM) || 0)) {
        return null;
    }
    return {
        ...metadata,
        points: cleanPoints,
        cumulative,
        totalLength,
    };
}

export function nearestPointOnAmbientTrainPath(path, x, z) {
    if (!path || !Array.isArray(path.points)) return null;
    let best = null;
    for (let index = 0; index < path.points.length - 1; index++) {
        const a = path.points[index];
        const b = path.points[index + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segmentLengthSquared = dx * dx + dz * dz;
        if (segmentLengthSquared < 1e-6) continue;
        const t = Math.max(0, Math.min(
            1,
            ((x - a.x) * dx + (z - a.z) * dz) / segmentLengthSquared,
        ));
        const pointX = a.x + dx * t;
        const pointZ = a.z + dz * t;
        const distanceM = Math.hypot(x - pointX, z - pointZ);
        if (!best || distanceM < best.distanceM) {
            best = {
                distanceM,
                s: path.cumulative[index] + Math.sqrt(segmentLengthSquared) * t,
            };
        }
    }
    return best;
}

export function sampleAmbientTrainPathPose(path, s, direction = 1) {
    if (!path || !Array.isArray(path.points) || path.points.length < 2) return null;
    const dir = direction < 0 ? -1 : 1;
    const lastIndex = path.points.length - 1;
    if (s <= 0) {
        const pose = poseOnSegment(
            path.points[0],
            path.points[1],
            s,
            path.cumulative[1],
            dir,
        );
        // Preserve the legacy guideway's ground-gate behavior: geometry
        // extrapolates beyond the endpoint, but its deck offset stays pinned
        // to that endpoint rather than extending the ramp into empty space.
        if (path.kind === 'legacy' && pose) {
            pose.yOff = finiteOrNull(path.points[0]?.yOff) ?? 0;
        }
        return pose;
    }
    if (s >= path.totalLength) {
        const segmentStartM = path.cumulative[lastIndex - 1];
        const pose = poseOnSegment(
            path.points[lastIndex - 1],
            path.points[lastIndex],
            s - segmentStartM,
            path.totalLength - segmentStartM,
            dir,
        );
        if (path.kind === 'legacy' && pose) {
            pose.yOff = finiteOrNull(path.points[lastIndex]?.yOff) ?? 0;
        }
        return pose;
    }

    let low = 0;
    let high = path.cumulative.length - 1;
    while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (path.cumulative[middle] <= s) low = middle;
        else high = middle;
    }
    return poseOnSegment(
        path.points[low],
        path.points[low + 1],
        s - path.cumulative[low],
        path.cumulative[low + 1] - path.cumulative[low],
        dir,
    );
}

export function offsetAmbientTrainPoseRight(pose, offsetM) {
    const offset = Number(offsetM);
    if (!pose || !Number.isFinite(offset) || Math.abs(offset) < 1e-6) return pose;
    return {
        ...pose,
        x: pose.x + Math.cos(pose.heading) * offset,
        z: pose.z + Math.sin(pose.heading) * offset,
    };
}
