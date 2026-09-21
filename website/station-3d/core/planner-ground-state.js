// Prepare planner walk corridors and removal sources in bounded CPU steps.
// These world-metre inputs do not depend on renderer resolution or view size.
import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';
import { describeStation, UNDERGROUND_STATION_TYPE_ID } from './station-contract.js';
import { getPlannerStopLevel, PLANNER_TUNNEL_FLOOR_WIDTH_M, PLANNER_TUNNEL_WALL_THICKNESS_M,
    PLANNER_TUNNEL_WALL_CENTER_OFFSET_M } from '../world/planner-station-layout.js';
import { getTrackCenterSpacingMeters, getTrackbedHalfWidthMeters, TRAM_TRACKBED_SHOULDER_M } from '../world/tram-trackbed-dimensions.js';
export const PLANNER_WALK_INDEX_CELL_M = 24;
const ELEV_EPS = .5;
export const PLANNER_RAMP_CUTOUT_WIDTH_M = (PLANNER_TUNNEL_WALL_CENTER_OFFSET_M + PLANNER_TUNNEL_WALL_THICKNESS_M * .5 + .05) * 2;
const capacity = () => { throw Object.assign(new Error('Planner ground state exceeds its complete capacity'), { code: 'ground-generation-capacity' }); };

// How far to either side of the route centreline this segment's corridor
// actually reaches.
//
// A running tunnel is the tube: 3.9 m. A STATION is the hall, and its tracks
// flare around the island platform — "Vidi" deliberately drops the walker
// between the rails of the right-hand track, 6.6 m off the centreline
// (UNDERGROUND_TRACK_CENTER_SPACING_METERS / 2). Searching only the tube's
// 3.9 m therefore found no floor at the one spot the walker is always spawned,
// walk physics concluded they had fallen through the world, and lifted them to
// the street — every time, in both worlds, no matter how correct the station
// geometry and the spawn height were. Arriving by train was unaffected because
// the cab never consults this lookup.
const TUNNEL_WALK_HALF_WIDTH_M = PLANNER_TUNNEL_FLOOR_WIDTH_M * 0.5 + PLANNER_TUNNEL_WALL_THICKNESS_M;
export function plannerSegmentWalkHalfWidthM(seg) {
    const half = Number(seg && seg.walkHalfWidthM);
    return Number.isFinite(half) && half > 0 ? half : TUNNEL_WALK_HALF_WIDTH_M;
}

// Widen the corridor over each underground station's envelope.
//
// The reach here is ASKED OF THE STATION, not measured against the running
// tunnel's cross-section. Inferring a station's interior from a tunnel constant
// is exactly what put the Vidi spawn 6.6 m out of a 3.9 m reach and lifted the
// walker to the street: the tracks flare around the island platform, so the
// place a walker always lands is nowhere near the tunnel's centre line.
// Occupancy is the station's to declare (core/station-contract.js).
export function* preparePlannerStationWalkWidthsSteps(segments, stops, anchorLat, anchorLon, budget) {
    budget.check();
    if (segments.length > budget.limits.maxInputSegments || stops.length > budget.limits.maxStops) capacity();
    const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
    const SCALE_LON = M_PER_DEG * Math.cos(anchorLat * DEG_TO_RAD);
    // Occupancy does not depend on the running spacing the station meets its
    // tunnels at, so one description serves every stop; the spacing is passed
    // because the contract describes a station in a route, not in the abstract.
    const station = describeStation(UNDERGROUND_STATION_TYPE_ID, {
        runningTrackSpacingM: getTrackCenterSpacingMeters(segments?.[0]?.properties || {}),
    });
    if (!station) return;
    const halfLengthM = station.occupancy.halfLengthM;
    const halfWidthM = station.occupancy.halfWidthM;
    for (const stop of stops || []) {
        yield* budget.step('planner-walk-station');
        if (getPlannerStopLevel(stop) !== -1) continue;
        const lng = Number(stop.lng ?? stop.lon);
        const lat = Number(stop.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const sx = (lng - anchorLon) * SCALE_LON;
        const sz = -(lat - anchorLat) * M_PER_DEG;
        budget.take('maxStopSegmentVisits', segments.length);
        for (const seg of segments) {
            yield* budget.step('planner-walk-station-segment');
            const dx = seg.cx - sx;
            const dz = seg.cz - sz;
            if (dx * dx + dz * dz > halfLengthM * halfLengthM) continue;
            seg.walkHalfWidthM = Math.max(plannerSegmentWalkHalfWidthM(seg), halfWidthM);
        }
    }
    budget.check();
}

export function plannerWalkIndexKey(cellX, cellZ) {
    return `${cellX}|${cellZ}`;
}

export function* preparePlannerWalkIndexSteps(segments, budget) {
    budget.check();
    if (segments.length > budget.limits.maxInputSegments) capacity();
    const index = new Map();
    for (const seg of segments) {
        yield* budget.step('planner-walk-index-segment');
        const radius = plannerSegmentWalkHalfWidthM(seg);
        const minX = Math.min(seg.x1, seg.x2) - radius;
        const maxX = Math.max(seg.x1, seg.x2) + radius;
        const minZ = Math.min(seg.z1, seg.z2) - radius;
        const maxZ = Math.max(seg.z1, seg.z2) + radius;
        const x0 = Math.floor(minX / PLANNER_WALK_INDEX_CELL_M);
        const x1 = Math.floor(maxX / PLANNER_WALK_INDEX_CELL_M);
        const z0 = Math.floor(minZ / PLANNER_WALK_INDEX_CELL_M);
        const z1 = Math.floor(maxZ / PLANNER_WALK_INDEX_CELL_M);
        const entries = (x1 - x0 + 1) * (z1 - z0 + 1);
        if (![x0, x1, z0, z1, entries].every(Number.isSafeInteger) || entries < 1) capacity();
        budget.take('maxWalkIndexEntries', entries);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                yield* budget.step('planner-walk-index-cell');
                const key = plannerWalkIndexKey(cx, cz);
                let bucket = index.get(key);
                if (!bucket) { bucket = []; index.set(key, bucket); }
                if (bucket.length >= budget.limits.maxWalkCellCandidates) capacity();
                bucket.push(seg);
            }
        }
    }
    budget.check(); return index;
}

function subsurfaceRampCutout(seg) {
    if (Math.abs(seg.e2 - seg.e1) <= ELEV_EPS) return null;
    if (Math.min(seg.e1, seg.e2) >= 0) return null;
    const delta = seg.e2 - seg.e1;
    let t1 = 0;
    let t2 = 1;
    if (Math.max(seg.e1, seg.e2) >= 0) {
        const surfaceT = -seg.e1 / delta;
        if (seg.e1 >= 0) t1 = surfaceT;
        else t2 = surfaceT;
    }
    t1 = Math.max(0, Math.min(1, t1));
    t2 = Math.max(0, Math.min(1, t2));
    if (Math.abs(t2 - t1) * seg.len < 0.25) return null;
    return {
        kind: 'ramp',
        x1: seg.x1 + (seg.x2 - seg.x1) * t1,
        z1: seg.z1 + (seg.z2 - seg.z1) * t1,
        x2: seg.x1 + (seg.x2 - seg.x1) * t2,
        z2: seg.z1 + (seg.z2 - seg.z1) * t2,
        widthM: PLANNER_RAMP_CUTOUT_WIDTH_M,
        // The cut may start halfway along a ramp. Interpolate the actual
        // backstop's joins at that point instead of adding a fresh path cap
        // or recomputing an unrelated miter from the shortened centreline.
        startJoinX: seg.startJoinX + (seg.endJoinX - seg.startJoinX) * t1,
        startJoinZ: seg.startJoinZ + (seg.endJoinZ - seg.startJoinZ) * t1,
        endJoinX: seg.startJoinX + (seg.endJoinX - seg.startJoinX) * t2,
        endJoinZ: seg.startJoinZ + (seg.endJoinZ - seg.startJoinZ) * t2,
    };
}

export function* collectGroundTrackSurfaceCutoutsSteps(features, anchorLat, anchorLon, budget) {
    budget.check();
    features ||= [];
    if (!Array.isArray(features) || ![anchorLat, anchorLon].every(Number.isFinite)) throw new TypeError('Planner cuts require a source array and finite anchor');
    budget.take('maxFeatures', features.length);
    const metersPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = metersPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const cuts = [];
    let featureIndex = 0;
    for (const feature of features || []) {
        yield* budget.step('planner-cut-feature');
        const properties = feature?.properties || {};
        if (!['user', 'user-line', 'cb-proposal'].includes(properties.source)) {
            featureIndex += 1;
            continue;
        }
        const geometry = feature?.geometry;
        if (!geometry || geometry.type !== 'LineString') {
            featureIndex += 1;
            continue;
        }
        const coordinates = geometry.coordinates || [];
        if (!Array.isArray(coordinates)) throw new TypeError('Planner cut coordinates must be an array');
        budget.take('maxCoordinates', coordinates.length);
        // Hide the owned surface only beneath the rail envelope, leaving the
        // complete 0.5 m paved shoulder to overlap and seal the mask. The
        // former over-wide cut exposed the sky/ground hole as blue-black
        // "puddles", greatly magnified at curve miters. Y/render ownership
        // still keeps roads, water, and greenery beneath the visible shoulder.
        const widthM = Math.max(
            0.5,
            getTrackbedHalfWidthMeters(properties) * 2
                - TRAM_TRACKBED_SHOULDER_M * 2,
        );
        let runIndex = 0;
        let runActive = false;
        let runOrder = 0;
        for (let i = 0; i < coordinates.length - 1; i++) {
            yield* budget.step('planner-cut-segment');
            const a = coordinates[i];
            const b = coordinates[i + 1];
            const e1 = Number.isFinite(Number(a?.[2])) ? Number(a[2]) : 0;
            const e2 = Number.isFinite(Number(b?.[2])) ? Number(b[2]) : 0;
            if (Math.abs(e1) > ELEV_EPS || Math.abs(e2) > ELEV_EPS) {
                if (runActive) runIndex += 1;
                runActive = false;
                runOrder = 0;
                continue;
            }
            const x1 = (Number(a?.[0]) - anchorLon) * scaleLon;
            const z1 = -(Number(a?.[1]) - anchorLat) * metersPerDegree;
            const x2 = (Number(b?.[0]) - anchorLon) * scaleLon;
            const z2 = -(Number(b?.[1]) - anchorLat) * metersPerDegree;
            if (![x1, z1, x2, z2].every(Number.isFinite) || Math.hypot(x2 - x1, z2 - z1) < 0.01) continue;
            runActive = true;
            budget.take('maxCuts');
            cuts.push({
                kind: 'surface-track',
                x1,
                z1,
                x2,
                z2,
                widthM,
                pathId: `surface:${featureIndex}:${runIndex}`,
                pathOrder: runOrder++,
            });
        }
        featureIndex += 1;
    }
    budget.check(); return cuts;
}

export function* collectSubsurfaceRampCutoutsSteps(segments, budget) {
    budget.check();
    if (segments.length > budget.limits.maxInputSegments) capacity();
    const cuts = [];
    let previous = null;
    let runIndex = -1;
    let pathOrder = 0;
    for (const seg of segments) {
        yield* budget.step('planner-ramp-cut');
        const cut = subsurfaceRampCutout(seg);
        if (!cut) {
            previous = null;
            continue;
        }
        const continuesPrevious = previous
            && previous.featureIndex === seg.featureIndex
            && Math.hypot(previous.cut.x2 - cut.x1, previous.cut.z2 - cut.z1) <= 0.08;
        if (!continuesPrevious) {
            runIndex += 1;
            pathOrder = 0;
        }
        cut.pathId = `ramp:${seg.featureIndex}:${runIndex}`;
        cut.pathOrder = pathOrder++;
        budget.take('maxCuts');
        cuts.push(cut);
        previous = { featureIndex: seg.featureIndex, cut };
    }
    budget.check(); return cuts;
}
