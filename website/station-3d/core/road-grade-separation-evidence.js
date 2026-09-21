// Derives paired road/rail crossing evidence and clear-zone measurements from
// the centerlines already carried by /roads/cab. Pure geometry only: no DOM,
// THREE, fetch, terrain sampling, or scene mutation.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import {
    getCarriagewayWidthM,
    getLaneCountForProperties,
} from './lane-marking-geometry.js';

const DEFAULT_ROAD_WIDTH_M = 6.5;
const DEFAULT_PATH_WIDTH_M = 2.5;
const DEFAULT_RAIL_FORMATION_WIDTH_M = 5;
const ROAD_FORMATION_EDGE_M = 1.5;
const PATH_FORMATION_EDGE_M = 0.5;
const RAIL_FORMATION_EDGE_M = 0.5;
const CROSSING_PLAN_MARGIN_M = 1;
const MIN_CROSSING_SINE = 0.15;
const ENDPOINT_CROSSING_EPS_M = 0.5;
const ROAD_CLEAR_HEIGHT_M = 4.5;
const RAIL_CLEAR_HEIGHT_M = 5.5;
const BRIDGE_DECK_DEPTH_M = 0.9;
const UNDERPASS_ROOF_DEPTH_M = 0.7;
// A separately mapped pedestrian tunnel is a much smaller civil structure
// than a vehicle underpass. Export these so the profile solver and crossing
// evidence use the same box dimensions without creating an import cycle.
export const PEDESTRIAN_UNDERPASS_CLEAR_HEIGHT_M = 2.6;
export const PEDESTRIAN_UNDERPASS_ROOF_DEPTH_M = 0.45;
const CLEARANCE_SAFETY_MARGIN_M = 0.1;
const FALSE_OSM_VALUES = new Set(['', '0', 'false', 'no']);
const PATH_HIGHWAYS = new Set([
    'footway', 'path', 'cycleway', 'steps', 'bridleway', 'pedestrian',
]);

function numericId(value) {
    return value == null ? null : String(value);
}

function propertyValue(properties, key) {
    return properties?.[key] ?? properties?.tags?.[key] ?? null;
}

function truthyOsmValue(value) {
    if (value == null) return false;
    return !FALSE_OSM_VALUES.has(String(value).trim().toLowerCase());
}

function highwayFromProperties(properties) {
    return propertyValue(properties, 'highway')
        ?? properties?.highway_type
        ?? null;
}

function railwayFromProperties(properties) {
    return propertyValue(properties, 'railway')
        ?? properties?.railway_type
        ?? null;
}

function corridorMode(properties) {
    if (railwayFromProperties(properties)) return 'rail';
    return highwayFromProperties(properties) ? 'road' : null;
}

function corridorLayer(properties) {
    const tagged = finiteOrNull(propertyValue(properties, 'layer'));
    if (tagged != null) return tagged;
    if (truthyOsmValue(propertyValue(properties, 'bridge'))) return 1;
    const tunnel = propertyValue(properties, 'tunnel');
    if (truthyOsmValue(tunnel)
        && String(tunnel).trim().toLowerCase() !== 'building_passage') {
        return -1;
    }
    return 0;
}

export function roadGradeSeparationCorridorWidthM(properties, mode) {
    const explicit = finiteOrNull(
        properties?.width_meters ?? propertyValue(properties, 'width'),
    );
    if (explicit != null && explicit > 0) return explicit;
    if (mode === 'rail') return DEFAULT_RAIL_FORMATION_WIDTH_M;
    const highway = String(highwayFromProperties(properties) || '');
    if (PATH_HIGHWAYS.has(highway)) return DEFAULT_PATH_WIDTH_M;
    return getCarriagewayWidthM(properties) || DEFAULT_ROAD_WIDTH_M;
}

export function roadGradeSeparationFormationHalfWidthM(properties, mode) {
    const widthM = roadGradeSeparationCorridorWidthM(properties, mode);
    if (mode === 'rail') return widthM * 0.5 + RAIL_FORMATION_EDGE_M;
    const highway = String(highwayFromProperties(properties) || '');
    return widthM * 0.5
        + (PATH_HIGHWAYS.has(highway)
            ? PATH_FORMATION_EDGE_M
            : ROAD_FORMATION_EDGE_M);
}

function corridorComposition(record) {
    const properties = record.properties || {};
    const highway = highwayFromProperties(properties);
    const railway = railwayFromProperties(properties);
    return {
        mode: record.mode,
        osmId: record.osmId,
        ref: propertyValue(properties, 'ref'),
        name: propertyValue(properties, 'name'),
        highway: highway == null ? null : String(highway),
        railway: railway == null ? null : String(railway),
        laneCount: record.mode === 'road'
            ? getLaneCountForProperties(properties)
            : null,
        carriagewayWidthM: record.mode === 'road'
            ? roadGradeSeparationCorridorWidthM(properties, record.mode)
            : null,
        formationWidthM: roadGradeSeparationFormationHalfWidthM(
            properties,
            record.mode,
        ) * 2,
        electrified: record.mode === 'rail'
            ? propertyValue(properties, 'electrified')
            : null,
    };
}

function coordinateDeltaM(from, to) {
    const meanLat = (Number(from[1]) + Number(to[1])) * 0.5 * DEG_TO_RAD;
    return {
        x: (Number(to[0]) - Number(from[0]))
            * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(meanLat),
        z: -(Number(to[1]) - Number(from[1])) * DEG_TO_RAD * EARTH_RADIUS_M,
    };
}

function coordinateDistanceM(a, b) {
    const delta = coordinateDeltaM(a, b);
    return Math.hypot(delta.x, delta.z);
}

function cross2d(a, b) {
    return a.x * b.z - a.z * b.x;
}

function segmentIntersection(a, b, c, d) {
    const ab = coordinateDeltaM(a, b);
    const ac = coordinateDeltaM(a, c);
    const cd = coordinateDeltaM(c, d);
    const denominator = cross2d(ab, cd);
    if (Math.abs(denominator) < 1e-8) return null;
    const t = cross2d(ac, cd) / denominator;
    const u = cross2d(ac, ab) / denominator;
    if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) {
        return null;
    }
    const abLengthM = Math.hypot(ab.x, ab.z);
    const cdLengthM = Math.hypot(cd.x, cd.z);
    if (abLengthM < 0.05 || cdLengthM < 0.05) return null;
    const directionDot = (
        ab.x * cd.x + ab.z * cd.z
    ) / (abLengthM * cdLengthM);
    const crossingSine = Math.sqrt(
        Math.max(0, 1 - Math.min(1, directionDot ** 2)),
    );
    if (crossingSine < MIN_CROSSING_SINE) return null;
    return {
        t: Math.max(0, Math.min(1, t)),
        u: Math.max(0, Math.min(1, u)),
        crossingSine,
        angleDeg: Math.asin(crossingSine) / DEG_TO_RAD,
        coordinate: [
            Number(a[0]) + (Number(b[0]) - Number(a[0])) * t,
            Number(a[1]) + (Number(b[1]) - Number(a[1])) * t,
        ],
    };
}

function cumulativeLengths(coordinates) {
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index++) {
        cumulative.push(
            cumulative[index - 1]
            + coordinateDistanceM(coordinates[index - 1], coordinates[index]),
        );
    }
    return cumulative;
}

function coordinateBounds(coordinates) {
    return coordinates.reduce((bounds, coordinate) => ({
        minLon: Math.min(bounds.minLon, Number(coordinate[0])),
        minLat: Math.min(bounds.minLat, Number(coordinate[1])),
        maxLon: Math.max(bounds.maxLon, Number(coordinate[0])),
        maxLat: Math.max(bounds.maxLat, Number(coordinate[1])),
    }), {
        minLon: Infinity,
        minLat: Infinity,
        maxLon: -Infinity,
        maxLat: -Infinity,
    });
}

function boundsOverlap(a, b) {
    return !!a && !!b
        && a.minLon <= b.maxLon
        && a.maxLon >= b.minLon
        && a.minLat <= b.maxLat
        && a.maxLat >= b.minLat;
}

export function coordinateAtCorridorStation(
    coordinates,
    cumulative,
    stationM,
) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const totalLengthM = cumulative[cumulative.length - 1] || 0;
    const s = Math.max(0, Math.min(totalLengthM, Number(stationM) || 0));
    let segmentIndex = coordinates.length - 2;
    for (let index = 0; index + 1 < cumulative.length; index++) {
        if (s <= cumulative[index + 1]) {
            segmentIndex = index;
            break;
        }
    }
    const spanM = cumulative[segmentIndex + 1] - cumulative[segmentIndex];
    const t = spanM > 0 ? (s - cumulative[segmentIndex]) / spanM : 0;
    const a = coordinates[segmentIndex];
    const b = coordinates[segmentIndex + 1];
    return [
        Number(a[0]) + (Number(b[0]) - Number(a[0])) * t,
        Number(a[1]) + (Number(b[1]) - Number(a[1])) * t,
    ];
}

export function roadGradeSeparationCorridorRecords(features = []) {
    const records = [];
    for (const feature of Array.isArray(features) ? features : []) {
        const properties = feature?.properties || {};
        const coordinates = properties.centerline_geometry?.type === 'LineString'
            ? properties.centerline_geometry.coordinates
            : null;
        const mode = corridorMode(properties);
        if (!mode || !Array.isArray(coordinates) || coordinates.length < 2) continue;
        const cumulative = cumulativeLengths(coordinates);
        records.push({
            feature,
            properties,
            coordinates,
            mode,
            osmId: numericId(properties.osm_id),
            layer: corridorLayer(properties),
            bounds: coordinateBounds(coordinates),
            cumulative,
            totalLengthM: cumulative[cumulative.length - 1] || 0,
        });
    }
    return records;
}

function requiredClearanceM(lowerRecord) {
    if (lowerRecord.mode === 'rail') return RAIL_CLEAR_HEIGHT_M;
    const highway = String(highwayFromProperties(lowerRecord.properties) || '');
    return PATH_HIGHWAYS.has(highway)
        ? PEDESTRIAN_UNDERPASS_CLEAR_HEIGHT_M
        : ROAD_CLEAR_HEIGHT_M;
}

function requiredSurfaceSeparationM(ownerKind, lowerRecord) {
    const highway = String(highwayFromProperties(lowerRecord.properties) || '');
    const roofDepthM = ownerKind === 'underpass' && PATH_HIGHWAYS.has(highway)
        ? PEDESTRIAN_UNDERPASS_ROOF_DEPTH_M
        : ownerKind === 'overpass'
            ? BRIDGE_DECK_DEPTH_M
            : UNDERPASS_ROOF_DEPTH_M;
    return requiredClearanceM(lowerRecord)
        + roofDepthM
        + CLEARANCE_SAFETY_MARGIN_M;
}

function nonnegativeLimit(value) {
    if (value === Infinity) return Infinity;
    const parsed = finiteOrNull(value);
    return parsed == null ? Infinity : Math.max(0, parsed);
}

// Solve the crossing elevation pair before either corridor builds its
// longitudinal curve. The objective is the minimum weighted squared movement
// from both normal profiles, constrained to raising the upper corridor and/or
// cutting the lower corridor. Movement limits are where approach length, grade,
// or explicit elevation ownership enters the otherwise geometry-only solve.
export function solveRoadGradeSeparationElevationPair({
    upperBaseElevationAslM,
    lowerBaseElevationAslM,
    requiredSurfaceSeparationM: requiredSeparationValue,
    upperRaiseLimitM = Infinity,
    lowerCutLimitM = Infinity,
    upperMovementWeight = 1,
    lowerMovementWeight = 1,
} = {}) {
    const upperBaseM = finiteOrNull(upperBaseElevationAslM);
    const lowerBaseM = finiteOrNull(lowerBaseElevationAslM);
    const requiredSeparationM = finiteOrNull(requiredSeparationValue);
    if (upperBaseM == null || lowerBaseM == null
        || requiredSeparationM == null || requiredSeparationM < 0) {
        return {
            status: 'unavailable',
            feasible: false,
            reason: 'missing-elevation-evidence',
        };
    }

    const initialSeparationM = upperBaseM - lowerBaseM;
    const deficitM = Math.max(0, requiredSeparationM - initialSeparationM);
    const upperLimitM = nonnegativeLimit(upperRaiseLimitM);
    const lowerLimitM = nonnegativeLimit(lowerCutLimitM);
    const upperWeight = Math.max(1e-9, finiteOrNull(upperMovementWeight) ?? 1);
    const lowerWeight = Math.max(1e-9, finiteOrNull(lowerMovementWeight) ?? 1);

    let upperLiftM = Math.min(
        upperLimitM,
        deficitM * lowerWeight / (upperWeight + lowerWeight),
    );
    let lowerCutM = deficitM - upperLiftM;
    if (lowerCutM > lowerLimitM) {
        lowerCutM = lowerLimitM;
        upperLiftM = Math.min(upperLimitM, deficitM - lowerCutM);
    }
    if (upperLiftM > upperLimitM) {
        upperLiftM = upperLimitM;
        lowerCutM = Math.min(lowerLimitM, deficitM - upperLiftM);
    }

    const upperElevationAslM = upperBaseM + upperLiftM;
    const lowerElevationAslM = lowerBaseM - lowerCutM;
    const achievedSeparationM = upperElevationAslM - lowerElevationAslM;
    const remainingDeficitM = Math.max(
        0,
        requiredSeparationM - achievedSeparationM,
    );
    const feasible = remainingDeficitM <= 1e-6;
    let allocation = 'existing-clearance';
    if (upperLiftM > 1e-6 && lowerCutM > 1e-6) allocation = 'split';
    else if (upperLiftM > 1e-6) allocation = 'upper-only';
    else if (lowerCutM > 1e-6) allocation = 'lower-only';

    return {
        status: feasible ? 'solved' : 'infeasible',
        feasible,
        allocation,
        upperBaseElevationAslM: upperBaseM,
        lowerBaseElevationAslM: lowerBaseM,
        upperElevationAslM,
        lowerElevationAslM,
        upperLiftM,
        lowerCutM,
        initialSeparationM,
        achievedSeparationM,
        requiredSurfaceSeparationM: requiredSeparationM,
        remainingDeficitM,
    };
}

function candidateHasCorrectOrder(owner, candidate, ownerKind) {
    if (ownerKind === 'overpass') return candidate.layer < owner.layer;
    return candidate.layer > owner.layer;
}

export function roadGradeSeparationCrossings(
    owner,
    corridors,
    ownerKind,
) {
    if (!owner || !['overpass', 'underpass'].includes(ownerKind)) return [];
    const ownerCoordinates = owner.coordinates;
    const ownerCumulative = owner.cumulative || cumulativeLengths(ownerCoordinates);
    const ownerTotalLengthM = owner.totalLengthM
        ?? ownerCumulative[ownerCumulative.length - 1]
        ?? 0;
    const crossings = [];
    const seen = new Set();
    for (const candidate of Array.isArray(corridors) ? corridors : []) {
        if (!candidate
            || candidate === owner
            || (owner.osmId != null && candidate.osmId === owner.osmId)
            || !boundsOverlap(owner.bounds, candidate.bounds)
            || !candidateHasCorrectOrder(owner, candidate, ownerKind)) {
            continue;
        }
        const candidateCumulative = candidate.cumulative
            || cumulativeLengths(candidate.coordinates);
        for (let ownerIndex = 0; ownerIndex + 1 < ownerCoordinates.length; ownerIndex++) {
            const ownerA = ownerCoordinates[ownerIndex];
            const ownerB = ownerCoordinates[ownerIndex + 1];
            const ownerSegmentM = ownerCumulative[ownerIndex + 1]
                - ownerCumulative[ownerIndex];
            for (
                let candidateIndex = 0;
                candidateIndex + 1 < candidate.coordinates.length;
                candidateIndex++
            ) {
                const intersection = segmentIntersection(
                    ownerA,
                    ownerB,
                    candidate.coordinates[candidateIndex],
                    candidate.coordinates[candidateIndex + 1],
                );
                if (!intersection) continue;
                const stationM = ownerCumulative[ownerIndex]
                    + ownerSegmentM * intersection.t;
                if (stationM <= ENDPOINT_CROSSING_EPS_M
                    || stationM >= ownerTotalLengthM - ENDPOINT_CROSSING_EPS_M) {
                    continue;
                }
                const candidateStationM = candidateCumulative[candidateIndex]
                    + (
                        candidateCumulative[candidateIndex + 1]
                        - candidateCumulative[candidateIndex]
                    ) * intersection.u;
                const lower = ownerKind === 'overpass' ? candidate : owner;
                const projectedHalfLengthM = (
                    roadGradeSeparationFormationHalfWidthM(
                        candidate.properties,
                        candidate.mode,
                    ) / intersection.crossingSine
                ) + CROSSING_PLAN_MARGIN_M;
                const key = `${candidate.osmId ?? 'anonymous'}:${Math.round(stationM * 10)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                crossings.push({
                    coordinate: intersection.coordinate,
                    angleDeg: intersection.angleDeg,
                    stationM,
                    candidateStationM,
                    clearStartM: Math.max(0, stationM - projectedHalfLengthM),
                    clearEndM: Math.min(
                        ownerTotalLengthM,
                        stationM + projectedHalfLengthM,
                    ),
                    upperOsmIds: ownerKind === 'overpass'
                        ? [owner.osmId].filter(Boolean)
                        : [candidate.osmId].filter(Boolean),
                    lowerOsmIds: ownerKind === 'overpass'
                        ? [candidate.osmId].filter(Boolean)
                        : [owner.osmId].filter(Boolean),
                    upperComposition: corridorComposition(
                        ownerKind === 'overpass' ? owner : candidate,
                    ),
                    lowerComposition: corridorComposition(lower),
                    requiredClearanceM: requiredClearanceM(lower),
                    requiredSurfaceSeparationM: requiredSurfaceSeparationM(
                        ownerKind,
                        lower,
                    ),
                    evidence: {
                        ownerLayer: owner.layer,
                        counterpartLayer: candidate.layer,
                        source: 'osm-centerline-intersection',
                    },
                });
            }
        }
    }
    return crossings.sort((a, b) => a.stationM - b.stationM);
}

export function roadGradeSeparationCrossingClearHalfLengthsM(
    crossing,
    ownerKind,
    { useStoredRange = true } = {},
) {
    const stationM = finiteOrNull(crossing?.stationM);
    const clearStartM = finiteOrNull(crossing?.clearStartM);
    const clearEndM = finiteOrNull(crossing?.clearEndM);
    if (useStoredRange
        && stationM != null && clearStartM != null && clearEndM != null) {
        return {
            beforeM: Math.max(0, stationM - clearStartM),
            afterM: Math.max(0, clearEndM - stationM),
        };
    }

    const crossedComposition = ownerKind === 'underpass'
        ? crossing?.upperComposition
        : crossing?.lowerComposition;
    const formationWidthM = finiteOrNull(crossedComposition?.formationWidthM);
    const angleDeg = finiteOrNull(crossing?.angleDeg);
    if (formationWidthM == null || formationWidthM <= 0 || angleDeg == null) {
        return null;
    }
    const crossingSine = Math.max(
        MIN_CROSSING_SINE,
        Math.abs(Math.sin(angleDeg * DEG_TO_RAD)),
    );
    const projectedHalfLengthM = formationWidthM * 0.5 / crossingSine
        + CROSSING_PLAN_MARGIN_M;
    return {
        beforeM: projectedHalfLengthM,
        afterM: projectedHalfLengthM,
    };
}

export function roadGradeSeparationClearRange(owner, crossings) {
    if (!owner || !Array.isArray(crossings) || crossings.length === 0) return null;
    const cumulative = owner.cumulative || cumulativeLengths(owner.coordinates);
    const totalLengthM = owner.totalLengthM
        ?? cumulative[cumulative.length - 1]
        ?? 0;
    const startM = Math.max(
        0,
        Math.min(...crossings.map(crossing => crossing.clearStartM)),
    );
    const endM = Math.min(
        totalLengthM,
        Math.max(...crossings.map(crossing => crossing.clearEndM)),
    );
    return {
        startM,
        endM,
        startCoordinate: coordinateAtCorridorStation(
            owner.coordinates,
            cumulative,
            startM,
        ),
        endCoordinate: coordinateAtCorridorStation(
            owner.coordinates,
            cumulative,
            endM,
        ),
        requiredSurfaceSeparationM: Math.max(
            ...crossings.map(crossing => crossing.requiredSurfaceSeparationM),
        ),
    };
}
