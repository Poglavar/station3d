// Resolves authored and OSM grade-separation metadata into sampled road
// alignments. Pure geometry only: no THREE, DOM, fetch, or scene state.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { ownReadSnapshot, retainReadSnapshot } from './read-snapshot-lifetime.js';
import { createBoundsGridSteps } from './bounds-grid.js';
import { pointInRing } from './mask-query.js';
import { permanentTerrainGapTest } from './terrain-evidence-gap.js';
import { roadStructureHalfWidths, roadStructureFormationHalfWidthM, roadStructureSampleFrame } from './road-structure-cross-section.js';
import {
    getCarriagewayWidthM,
    getLaneCountForProperties,
} from './lane-marking-geometry.js';
import {
    coordinateAtCorridorStation,
    roadGradeSeparationClearRange,
    roadGradeSeparationCrossingClearHalfLengthsM,
    roadGradeSeparationCorridorWidthM,
    roadGradeSeparationFormationHalfWidthM,
    roadGradeSeparationCorridorRecords,
    roadGradeSeparationCrossings,
    solveRoadGradeSeparationElevationPair,
    PEDESTRIAN_UNDERPASS_CLEAR_HEIGHT_M,
    PEDESTRIAN_UNDERPASS_ROOF_DEPTH_M,
} from './road-grade-separation-evidence.js';

export const ROAD_VERTICAL_KINDS = new Set(['overpass', 'underpass']);

function alignmentPreparationClock({ now = () => performance.now(), isCurrent = () => true } = {}) {
    let started = now();
    const check = () => {
        if (!isCurrent()) throw Object.assign(new Error('Road alignment preparation was superseded'),
            { code: 'road-alignment-preparation-stale' });
    };
    return { now, check,
        expired() {
            check();
            return now() - started >= .5;
        }, restart() { check(); started = now(); },
    };
}

function drainAlignmentSteps(steps) {
    let next; do { next = steps.next(); } while (!next.done); return next.value;
}

function* mapAlignmentSteps(values, map, clock, phase) {
    const result = [];
    for (let index = 0; index < values.length; index++) {
        if (clock.expired()) { yield { phase }; clock.restart(); }
        result.push(map(values[index], index));
    }
    return result;
}

function* mapAlignmentGeneratorSteps(values, map, clock, phase) {
    const result = [];
    for (let index = 0; index < values.length; index++) {
        if (clock.expired()) { yield { phase }; clock.restart(); }
        result.push(yield* map(values[index], index));
    }
    return result;
}

function* filterAlignmentSteps(values, predicate, clock, phase) {
    const result = [];
    for (let index = 0; index < values.length; index++) {
        if (clock.expired()) { yield { phase }; clock.restart(); }
        if (predicate(values[index], index, values)) result.push(values[index]);
    }
    return result;
}

// Stable merge sorting keeps station insertion/duplicate ordering deterministic
// without putting the complete station list in one native sort callback.
function* sortAlignmentSteps(values, compare, clock, phase) {
    let source = values, target = new Array(values.length);
    for (let width = 1; width < values.length; width *= 2) {
        for (let start = 0; start < values.length; start += width * 2) {
            const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
            let left = start, right = middle;
            for (let at = start; at < end; at++) {
                if (clock.expired()) { yield { phase }; clock.restart(); }
                target[at] = left < middle && (right >= end || compare(source[left], source[right]) <= 0)
                    ? source[left++] : source[right++];
            }
        }
        [source, target] = [target, source];
    }
    return source;
}

const DEFAULT_UNDERPASS_OFFSET_M = -6.5;
const DEFAULT_UNDERPASS_MAX_GRADE = 0.08;
const DEFAULT_PEDESTRIAN_UNDERPASS_MAX_GRADE = 0.16;
const UNDERPASS_CLEARANCE_MARGIN_M = 0.35;
const DEFAULT_UNDERPASS_ROOF_DEPTH_M = 0.7;
// Mirrors the spec's TUNNEL_CLEAR_HEIGHT_M (importing it here would cycle:
// road-grade-separation-spec.js already imports from this module).
const DEFAULT_UNDERPASS_CLEAR_HEIGHT_M = 5.5;
const SYNTHESIZED_ROAD_SHOULDER_M = 0.75;
const SYNTHESIZED_UNDERPASS_TERRAIN_CLEAR_MARGIN_M = 4;
// At the outer end of a cut, the authored replacement must become exactly as
// wide as the ordinary carriageway it overlaps. Expanding the full shoulder
// into a zero-depth endpoint cuts two dark wedges out of otherwise valid
// terrain. The shoulder reaches full width once there is enough cut to need a
// retaining wall.
const SYNTHESIZED_UNDERPASS_FULL_FORMATION_DEPTH_M = 0.75;
const UNDERPASS_MIN_DEPTH_M = 4.5;
const UNDERPASS_ENDPOINT_PRECISION = 6;
// Croatian roads require a 4.5 m free profile. This is the road-surface lift,
// not the clearance: it also allows for the rendered bridge deck and margin.
// A relative peak keeps OSM bridge endpoints joined to the surrounding terrain.
const DEFAULT_OVERPASS_OFFSET_M = 6.5;
const DEFAULT_OVERPASS_MAX_GRADE = 0.08;
// A bridge-tagged footway with no transport corridor beneath it is normally a
// small park/water footbridge, not a road-clearance flyover. Giving it the
// vehicle fallback lifted the connected Botanički vrt path 6.2 m into the air.
// Actual road/rail crossings still derive their full clearance from evidence.
const DEFAULT_SURFACE_ONLY_OVERPASS_OFFSET_M = 0.45;
const DEFAULT_SURFACE_ONLY_OVERPASS_MAX_GRADE = 0.16;
const OVERPASS_LATERAL_TERRAIN_ENVELOPE_FADE_M = 0.5;
const DEFAULT_SAMPLE_SPACING_M = 8;
const DEFAULT_CORRIDOR_HALF_WIDTH_M = 12;
// A synthesized curve commonly ends partway through one long OSM member.
// Keep one full corridor-width of that member in the alignment after it has
// rejoined terrain. Otherwise one polygon triangle can have profiled vertices
// on one side of the artificial endpoint and terrain-fallback vertices on the
// other, which appears as a large road/sidewalk wedge.
const SYNTHESIZED_APPROACH_RUNOUT_M = DEFAULT_CORRIDOR_HALF_WIDTH_M;
const SYNTHESIZED_COMPOSITE_MAX_EXTENSION_PASSES = 8;
const OSM_FALSE_VALUES = new Set(['', '0', 'false', 'no']);
const SURFACE_ONLY_HIGHWAYS = new Set([
    'footway', 'path', 'cycleway', 'steps', 'bridleway',
]);
const STRUCTURE_COMPANION_MAX_OFFSET_M = 20;
const STRUCTURE_COMPANION_MIN_DIRECTION_DOT = 0.85;
const STRUCTURE_COMPANION_DEFAULT_HALF_WIDTH_M = 1.25;
const STRUCTURE_COMPANION_EDGE_MARGIN_M = 0.5;
const BUFFERED_END_CAP_STATION_EPS_M = 0.25;
const ALIGNMENT_ENDPOINT_PLANE_EPS_M = 0.05;
const ALIGNMENT_CHANGE_HISTORY_LIMIT = 128;
const ROAD_SUPPORT_SWEPT_ENVELOPE_MARGIN_M = 1;
// OSM often splits one elevated road at a short earthwork seam between bridge
// decks. That connector is part of the continuous crest, while a long mapped
// embankment is a genuine graded approach and must remain terrain-bound.
const OVERPASS_CONNECTOR_MAX_LENGTH_M = 60;
// Very short private-access tunnels in OSM are commonly garage ramps or
// building entrances. Without a matching authored building/garage volume we
// cannot infer their portal, roof or grade. Expanding one into the ordinary
// synthesized underpass envelope is much worse than leaving the access road
// terrain-bound: a 4.6 m driveway in Zagreb opened an 11 m-wide hole more than
// 11 m away from its axis. Keep this deliberately narrow — ordinary roads and
// longer service tunnels still use the grade-separation pipeline.
export const ROAD_UNMODELED_ACCESS_TUNNEL_MAX_LENGTH_M = 20;
const UNMODELED_ACCESS_TUNNEL_SERVICES = new Set(['driveway', 'parking_aisle']);
// Extra clearance past a joining road's half width before the companion
// sidewalk resumes — room for the junction's curb radii.
const JUNCTION_GAP_FILLET_M = 1.5;

function numericId(value) {
    return value == null ? null : String(value);
}

function finiteCoordinate(value) {
    return Array.isArray(value)
        && finiteOrNull(value[0]) != null
        && finiteOrNull(value[1]) != null;
}

function truthyOsmValue(value) {
    if (value == null) return false;
    return !OSM_FALSE_VALUES.has(String(value).trim().toLowerCase());
}

function smoothstep(value) {
    const t = Math.max(0, Math.min(1, Number(value) || 0));
    return t * t * (3 - 2 * t);
}

function linearInterpolate(a, b, t) {
    return a + (b - a) * t;
}

function projectPointToSegment(x, z, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 1e-9
        ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared))
        : 0;
    const qx = a.x + dx * t;
    const qz = a.z + dz * t;
    return {
        x: qx,
        z: qz,
        t,
        distanceSquared: (x - qx) ** 2 + (z - qz) ** 2,
    };
}

function nearestOnPolyline(points, cumulative, x, z) {
    return nearestOnPolylineSegments(points, cumulative, x, z, null);
}

function nearestOnPolylineSegments(points, cumulative, x, z, segments) {
    let best = null;
    const count = Array.isArray(segments) ? segments.length : Math.max(0, points.length - 1);
    for (let cursor = 0; cursor < count; cursor++) {
        const index = Array.isArray(segments)
            ? Number(segments[cursor]?.segmentIndex)
            : cursor;
        if (!Number.isInteger(index) || index < 0 || index + 1 >= points.length) continue;
        const projected = projectPointToSegment(x, z, points[index], points[index + 1]);
        if (!best || projected.distanceSquared < best.distanceSquared) {
            best = {
                ...projected,
                segmentIndex: index,
                s: cumulative[index]
                    + (cumulative[index + 1] - cumulative[index]) * projected.t,
            };
        }
    }
    return best;
}

function* nearestOnPolylineSteps(points, cumulative, x, z, clock, segments = null) {
    function* allSegments() {
        for (let segmentIndex = 0; segmentIndex + 1 < points.length; segmentIndex++) yield { segmentIndex };
    }
    let best = null;
    for (const { segmentIndex: index } of segments || allSegments()) {
        if (clock.expired()) { yield { phase: 'alignment-nearest-query' }; clock.restart(); }
        const projected = projectPointToSegment(x, z, points[index], points[index + 1]);
        if (!best || projected.distanceSquared < best.distanceSquared) {
            best = { ...projected, segmentIndex: index,
                s: cumulative[index] + (cumulative[index + 1] - cumulative[index]) * projected.t };
        }
    }
    return best;
}

// Road surfaces query their owning vertical profile once per refined vertex.
// A synthesized bridge axis can contain hundreds of approach samples, so a
// full scan here turns one otherwise modest road polygon into a 50+ ms queue
// item. Index padded segment bounds once, then retain the exact full-scan
// answer whenever the query falls outside that known-near corridor.
export function createIndexedPolylineNearest(
    points,
    cumulative,
    { searchRadiusM = 24, cellM = 24 } = {},
) {
    return drainAlignmentSteps(createIndexedPolylineNearestSteps(points, cumulative, { searchRadiusM, cellM }));
}

export function* createIndexedPolylineNearestSteps(points, cumulative, {
    searchRadiusM = 24, cellM = 24, now, isCurrent, preparation = alignmentPreparationClock({ now, isCurrent }),
} = {}) {
    const safePoints = Array.isArray(points) ? points : [];
    const radiusM = Math.max(1, Number(searchRadiusM) || 24);
    const radiusSquared = radiusM * radiusM;
    const segments = [];
    for (let segmentIndex = 0; segmentIndex + 1 < safePoints.length; segmentIndex++) {
        if (preparation.expired()) { yield { phase: 'alignment-nearest-segments' }; preparation.restart(); }
        const a = safePoints[segmentIndex];
        const b = safePoints[segmentIndex + 1];
        segments.push({
            segmentIndex,
            bounds: {
                minX: Math.min(a.x, b.x) - radiusM,
                minZ: Math.min(a.z, b.z) - radiusM,
                maxX: Math.max(a.x, b.x) + radiusM,
                maxZ: Math.max(a.z, b.z) + radiusM,
            },
        });
    }
    const grid = yield* createBoundsGridSteps(segments, {
        cellM: Math.max(1, Number(cellM) || 24),
        now: () => { preparation.check(); return preparation.now(); },
    });
    preparation.expired();
    const nearest = (x, z) => {
        const px = Number(x);
        const pz = Number(z);
        const candidates = grid.candidatesAt(px, pz);
        const indexed = nearestOnPolylineSegments(
            safePoints,
            cumulative,
            px,
            pz,
            candidates,
        );
        // Every segment within radiusM has an expanded bound containing this
        // point and is therefore in candidates. A winner inside that radius is
        // provably global; otherwise preserve the old exact full scan.
        if (indexed && indexed.distanceSquared <= radiusSquared) return indexed;
        return nearestOnPolyline(safePoints, cumulative, px, pz);
    };
    nearest.prepareSteps = function* (x, z, clock) {
        const px = Number(x), pz = Number(z);
        const indexed = yield* nearestOnPolylineSteps(safePoints, cumulative, px, pz, clock,
            grid.candidateItemsAt(px, pz));
        if (indexed && indexed.distanceSquared <= radiusSquared) return indexed;
        return yield* nearestOnPolylineSteps(safePoints, cumulative, px, pz, clock);
    };
    return nearest;
}

function pointAtStation(points, cumulative, stationM) {
    const totalLengthM = cumulative[cumulative.length - 1] || 0;
    const s = Math.max(0, Math.min(totalLengthM, Number(stationM) || 0));
    // The first ending station >= s preserves the former scan at shared
    // vertices and repeated coordinates, while sampling a long axis is O(log n).
    let low = 1, high = cumulative.length - 1;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (s <= cumulative[middle]) high = middle;
        else low = middle + 1;
    }
    const segmentIndex = Math.max(0, low - 1);
    const span = cumulative[segmentIndex + 1] - cumulative[segmentIndex];
    const t = span > 0 ? (s - cumulative[segmentIndex]) / span : 0;
    const a = points[segmentIndex];
    const b = points[segmentIndex + 1];
    return {
        x: linearInterpolate(a.x, b.x, t),
        z: linearInterpolate(a.z, b.z, t),
        s,
    };
}

function pointIsPastAlignmentEndpoint(alignment, nearest, x, z) {
    const points = alignment?.points || [];
    if (!nearest || points.length < 2) return false;
    const totalLengthM = Number(alignment.totalLengthM) || 0;
    let endpoint = null;
    let tangent = null;
    let direction = 1;
    if (nearest.s <= ALIGNMENT_ENDPOINT_PLANE_EPS_M) {
        endpoint = points[0];
        tangent = {
            x: points[1].x - endpoint.x,
            z: points[1].z - endpoint.z,
        };
        direction = -1;
    } else if (
        totalLengthM - nearest.s <= ALIGNMENT_ENDPOINT_PLANE_EPS_M
    ) {
        endpoint = points[points.length - 1];
        tangent = {
            x: endpoint.x - points[points.length - 2].x,
            z: endpoint.z - points[points.length - 2].z,
        };
    } else {
        return false;
    }
    const tangentLengthM = Math.hypot(tangent.x, tangent.z);
    if (tangentLengthM < 1e-6) return false;
    const alongM = (
        (Number(x) - endpoint.x) * tangent.x
        + (Number(z) - endpoint.z) * tangent.z
    ) / tangentLengthM;
    return direction * alongM > ALIGNMENT_ENDPOINT_PLANE_EPS_M;
}

export function replacementCorridorTouchesEdge(
    roadVerticalAlignmentModel,
    a,
    b,
    halfWidthM = 18,
) {
    if (!roadVerticalAlignmentModel
        || finiteOrNull(a?.x) == null
        || finiteOrNull(a?.z) == null
        || finiteOrNull(b?.x) == null
        || finiteOrNull(b?.z) == null) {
        return false;
    }
    return [
        a,
        b,
        {
            x: (Number(a.x) + Number(b.x)) * 0.5,
            z: (Number(a.z) + Number(b.z)) * 0.5,
        },
    ].some(point => roadVerticalAlignmentModel.containsReplacementCorridor(
        point.x,
        point.z,
        halfWidthM,
    ));
}

function stationForLocator(locator, points, cumulative, toLocal) {
    return drainAlignmentSteps(stationForLocatorSteps(locator, points, cumulative, toLocal));
}

function* stationForLocatorSteps(locator, points, cumulative, toLocal, clock = null, nearest = null) {
    const totalLengthM = cumulative[cumulative.length - 1] || 0;
    const directStationM = finiteOrNull(locator);
    if (directStationM != null) {
        return Math.max(0, Math.min(totalLengthM, directStationM));
    }
    if (!locator || typeof locator !== 'object') return null;
    const distanceM = finiteOrNull(locator.distanceM);
    if (distanceM != null) {
        return Math.max(0, Math.min(totalLengthM, distanceM));
    }
    const fraction = finiteOrNull(locator.fraction);
    if (fraction != null) {
        return totalLengthM * Math.max(0, Math.min(1, fraction));
    }
    if (finiteCoordinate(locator.coordinate)) {
        const point = toLocal(locator.coordinate);
        if (clock) {
            const hit = nearest ? yield* nearest.prepareSteps(point.x, point.z, clock)
                : yield* nearestOnPolylineSteps(points, cumulative, point.x, point.z, clock);
            return hit?.s ?? null;
        }
        return nearestOnPolyline(points, cumulative, point.x, point.z)?.s ?? null;
    }
    return null;
}

function profileKindFromProperties(properties = {}) {
    const osmTags = properties.tags && typeof properties.tags === 'object'
        ? properties.tags
        : {};
    const explicit = properties.road_vertical_alignment
        ?? properties.vertical_alignment
        ?? properties.grade_separation;
    if (typeof explicit === 'string' && ROAD_VERTICAL_KINDS.has(explicit)) {
        return { kind: explicit };
    }
    if (explicit && typeof explicit === 'object' && ROAD_VERTICAL_KINDS.has(explicit.kind)) {
        return { ...explicit };
    }
    const bridge = properties.bridge ?? properties.osm_bridge ?? osmTags.bridge;
    const tunnel = properties.tunnel ?? properties.osm_tunnel ?? osmTags.tunnel;
    const buildingPassage = truthyOsmValue(tunnel)
        && String(tunnel).trim().toLowerCase() === 'building_passage';
    const layer = Number(properties.layer ?? properties.osm_layer ?? osmTags.layer);
    if (truthyOsmValue(bridge)) {
        return {
            kind: 'overpass',
            osm: { bridge: String(bridge), layer: Number.isFinite(layer) ? layer : null },
        };
    }
    // A building passage is a road through a building shell, not a terrain
    // underpass; treating Zagreb's 545 passages as tunnels would sink them all.
    if (truthyOsmValue(tunnel) && !buildingPassage) {
        return {
            kind: 'underpass',
            osm: { tunnel: String(tunnel), layer: Number.isFinite(layer) ? layer : null },
        };
    }
    if (!buildingPassage && Number.isFinite(layer) && layer !== 0) {
        return {
            kind: layer > 0 ? 'overpass' : 'underpass',
            osm: { layer },
        };
    }
    return null;
}

export function roadVerticalAlignmentFromProperties(properties = {}) {
    return profileKindFromProperties(properties);
}

function highwayFromProperties(properties = {}) {
    return properties.highway
        ?? properties.highway_type
        ?? properties.tags?.highway
        ?? null;
}

function isSurfaceOnlyHighway(properties = {}) {
    return SURFACE_ONLY_HIGHWAYS.has(String(highwayFromProperties(properties) || ''));
}

function isTaggedRoadTunnel(properties = {}) {
    const tunnel = properties.tunnel
        ?? properties.osm_tunnel
        ?? properties.tags?.tunnel;
    return truthyOsmValue(tunnel)
        && String(tunnel).trim().toLowerCase() !== 'building_passage';
}

function isIndependentSurfaceTunnel(properties = {}) {
    return isSurfaceOnlyHighway(properties)
        && isTaggedRoadTunnel(properties);
}

function endpointKey(coordinate) {
    if (!finiteCoordinate(coordinate)) return null;
    return `${Number(coordinate[0]).toFixed(UNDERPASS_ENDPOINT_PRECISION)},`
        + `${Number(coordinate[1]).toFixed(UNDERPASS_ENDPOINT_PRECISION)}`;
}

function uniqueRoadJunctions(junctions = []) {
    const byKey = new Map();
    for (const junction of junctions) {
        const key = [
            String(junction?.osmId ?? ''),
            endpointKey(junction?.coordinate) || '',
            endpointKey(junction?.towardCoordinate) || '',
        ].join(':');
        if (!byKey.has(key)) byKey.set(key, junction);
    }
    return Array.from(byKey.values());
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

// A road tagged tunnel=yes resolves to kind 'underpass', which digs an open
// trench at DEFAULT_UNDERPASS_OFFSET_M along the WHOLE way, with retaining
// walls and a terrain collar. That is right for a dip under a bridge and
// catastrophic for a bore: service road 306878572 at Divulje runs 429 m beneath
// a hill carrying ~70 m of cover (10 m at the portal, 79 m mid-span, measured
// against the DGU 1 m DMR) and was being carved open end to end — the sheer tan
// walls and the ramp climbing out of the hillside in the Trogir view.
//
// Such a way keeps its tunnel and its road surface; what changes is the size of
// the opening at each end (see ROAD_TUNNEL_PORTAL_CARVE_M).
//
// Length stands in for cover, which is not available at this point. Of the 2,079
// tunnel-tagged ways in the road table, 71% are shorter than this bound and keep
// their underpass; the tail beyond it runs to 10 km and is bores.
export const ROAD_BORED_TUNNEL_MIN_LENGTH_M = 250;

// Length of the open cut-and-cover mouth at each end of a bore. Mirrors
// rail-formation.js TUNNEL_PORTAL_CARVE_M so a road portal and a rail portal
// open the hillside by the same amount.
export const ROAD_TUNNEL_PORTAL_CARVE_M = 24;

// A walking tunnel needs only a person-scale reveal before its roof disappears
// into the hill. Reusing the vehicle/rail mouth length turns a narrow urban
// passage into a long open trench.
export const ROAD_PEDESTRIAN_TUNNEL_PORTAL_CARVE_M = 6;

// A road portal's covered box is CLEAR_HEIGHT + roof (~6.2 m) tall, so the
// mouth carve must run inward until the hill can actually swallow it — at
// Divulje the cover 24 m in is only 2–5 m and the fixed carve left the box
// roof sticking out of the hillside. The carve extends to the first station
// with full cover, but never beyond this cap: past it the box starts anyway
// and its portal face stands proud of the slope, bounded, the way a rail
// facade does — instead of an excavation that chases shallow cover.
export const ROAD_TUNNEL_PORTAL_CARVE_MAX_M = 3 * ROAD_TUNNEL_PORTAL_CARVE_M;

// How far a bore's authored approach follows the access road. A dip sizes its
// approach from ramp grade, but a bore's bed stays on the ground — what the
// approach needs is to reach a NATURAL break (the next junction) instead of
// stopping mid-slope, where the seam between the raw unpaved member and the
// authored bed reads as an abandoned end cap on open hillside (the curb "U"
// on the Divulje access road). The trace still stops early at any road-class
// change or junction; this is only the ceiling.
export const ROAD_BORED_TUNNEL_APPROACH_TRACE_M = 200;

export function roadRecordLengthM(coordinates) {
    const points = Array.isArray(coordinates) ? coordinates : [];
    let lengthM = 0;
    for (let index = 1; index < points.length; index += 1) {
        if (!finiteCoordinate(points[index - 1]) || !finiteCoordinate(points[index])) continue;
        lengthM += coordinateDistanceM(points[index - 1], points[index]);
    }
    return lengthM;
}

// True when a tunnel-tagged way is too long to be an underpass dip. Only the
// OSM `tunnel` tag qualifies — a bare negative `layer` is an ordinary lower
// level, not a bore, and authored alignments are always honoured.
export function isBoredTunnelRoadRecord(record) {
    if (!isTaggedRoadTunnel(record?.properties || {})) return false;
    return roadRecordLengthM(record?.coordinates) > ROAD_BORED_TUNNEL_MIN_LENGTH_M;
}

// A long tunnel-tagged way is only a BORE when the ground genuinely rises over
// the straight grade line between its portals. A long flat cut-and-cover must
// keep the dug dip: its separation comes from excavation, not from a hill. The
// bound must clear the buried-roof test (clear height + roof, ~6.2 m) or no
// span of the "bore" could carry intact fill anyway.
export const ROAD_BORED_TUNNEL_MIN_COVER_M = 8;

// Peak ground rise above the portal-to-portal grade line, from the same
// terrain evidence that sizes approaches. Null when that evidence is missing.
function boredTunnelPeakCoverM(owner, options) {
    const coordinates = owner.coordinates;
    const startAslM = terrainElevationAslMAtCoordinate(options, coordinates[0]);
    const endAslM = terrainElevationAslMAtCoordinate(
        options,
        coordinates[coordinates.length - 1],
    );
    const totalLengthM = finiteOrNull(owner.totalLengthM);
    if (startAslM == null || endAslM == null || !(totalLengthM > 0)) return null;
    let peakCoverM = null;
    const steps = 16;
    for (let step = 1; step < steps; step++) {
        const stationM = totalLengthM * step / steps;
        const terrainAslM = terrainElevationAslMAtCoordinate(
            options,
            coordinateAtCorridorStation(coordinates, owner.cumulative, stationM),
        );
        if (terrainAslM == null) continue;
        const chordAslM = linearInterpolate(
            startAslM,
            endAslM,
            stationM / totalLengthM,
        );
        const coverM = terrainAslM - chordAslM;
        if (peakCoverM == null || coverM > peakCoverM) peakCoverM = coverM;
    }
    return peakCoverM;
}

// A branch may terminate at an INTERIOR node of another tunnel rather than at
// daylight. Terrain at that node is the hilltop, not a portal elevation. Use
// the connected tunnel's portal-to-portal grade as the best available shared
// floor datum. Requiring an exact OSM vertex avoids coupling tunnels that only
// cross in plan.
function interiorTunnelJunctionElevationAslM(
    owner,
    junction,
    corridors,
    options,
) {
    const junctionKey = endpointKey(junction);
    if (!junctionKey) return null;
    const candidates = (Array.isArray(corridors) ? corridors : [])
        .filter(candidate => (
            candidate?.mode === 'road'
            && String(candidate.osmId ?? '') !== String(owner.osmId ?? '')
            && isTaggedRoadTunnel(candidate.properties)
            && Array.isArray(candidate.coordinates)
            && candidate.coordinates.some((coordinate, index, coordinates) => (
                index > 0
                && index < coordinates.length - 1
                && endpointKey(coordinate) === junctionKey
            ))
        ))
        .sort((left, right) => (
            Number(right.totalLengthM || 0) - Number(left.totalLengthM || 0)
        ));
    for (const candidate of candidates) {
        const candidateCoverM = boredTunnelPeakCoverM(candidate, options);
        const candidateIsBore = (
            isBoredTunnelRoadRecord(candidate)
            && (candidateCoverM == null
                || candidateCoverM >= ROAD_BORED_TUNNEL_MIN_COVER_M)
        ) || (
            candidateCoverM != null
            && candidateCoverM >= ROAD_BORED_TUNNEL_MIN_COVER_M
        );
        if (!candidateIsBore) continue;
        const startElevationAslM = terrainElevationAslMAtCoordinate(
            options,
            candidate.coordinates[0],
        );
        const endElevationAslM = terrainElevationAslMAtCoordinate(
            options,
            candidate.coordinates[candidate.coordinates.length - 1],
        );
        const station = nearestStationOnCoordinateAxis(
            junction,
            candidate.coordinates,
            candidate.cumulative,
        );
        if (startElevationAslM == null
            || endElevationAslM == null
            || station == null
            || station.distanceSquared > 0.05 ** 2
            || !(candidate.totalLengthM > 0)) {
            continue;
        }
        return linearInterpolate(
            startElevationAslM,
            endElevationAslM,
            station.stationM / candidate.totalLengthM,
        );
    }
    return null;
}

function coordinatePolylineLengthM(coordinates) {
    return (Array.isArray(coordinates) ? coordinates : [])
        .slice(1)
        .reduce(
            (lengthM, coordinate, index) => (
                lengthM + coordinateDistanceM(coordinates[index], coordinate)
            ),
            0,
        );
}

function corridorMetrics(coordinates) {
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index++) {
        cumulative.push(
            cumulative[index - 1]
                + coordinateDistanceM(coordinates[index - 1], coordinates[index]),
        );
    }
    const bounds = coordinates.reduce((result, coordinate) => ({
        minLon: Math.min(result.minLon, Number(coordinate[0])),
        minLat: Math.min(result.minLat, Number(coordinate[1])),
        maxLon: Math.max(result.maxLon, Number(coordinate[0])),
        maxLat: Math.max(result.maxLat, Number(coordinate[1])),
    }), {
        minLon: Infinity,
        minLat: Infinity,
        maxLon: -Infinity,
        maxLat: -Infinity,
    });
    return {
        cumulative,
        bounds,
        totalLengthM: cumulative[cumulative.length - 1] || 0,
    };
}

function gradeSafeApproachStation(options) {
    return drainAlignmentSteps(gradeSafeApproachStationSteps(options));
}

function* gradeSafeApproachStationSteps({
    initialStationM,
    peakStationM,
    outerStationM,
    targetY,
    maxGrade,
    sampleYAtStation,
    stepM = 2,
}, clock = null) {
    const initialM = finiteOrNull(initialStationM);
    const peakM = finiteOrNull(peakStationM);
    const outerM = finiteOrNull(outerStationM);
    const designY = finiteOrNull(targetY);
    const grade = finiteOrNull(maxGrade);
    if (initialM == null || peakM == null || outerM == null
        || designY == null || !(grade > 0)
        || typeof sampleYAtStation !== 'function') {
        return null;
    }
    const searchLengthM = Math.abs(initialM - outerM);
    if (searchLengthM <= 1e-6) return null;

    // The longitudinal profile is a smoothstep from terrain at the selected
    // curve endpoint to the shared lower plateau. Its peak derivative is 1.5
    // times its average slope. Search outward for the latest endpoint that
    // satisfies the advertised grade against the terrain actually present
    // there. This one rule is shared by the source-axis sizing pass and the
    // final scene profile, so their metadata and rendered curve cannot drift.
    const steps = Math.max(1, Math.ceil(searchLengthM / Math.max(0.25, stepM)));
    for (let step = 0; step <= steps; step += 1) {
        if (clock?.expired()) { yield { phase: 'alignment-grade-search' }; clock.restart(); }
        const stationM = linearInterpolate(initialM, outerM, step / steps);
        const curveLengthM = Math.abs(peakM - stationM);
        if (curveLengthM <= 1e-6) continue;
        const terrainY = finiteOrNull(sampleYAtStation(stationM));
        if (terrainY == null) continue;
        const maximumCurveGrade = 1.5
            * Math.abs(terrainY - designY)
            / curveLengthM;
        if (maximumCurveGrade <= grade + 1e-6) return stationM;
    }
    return null;
}

function unitCoordinateDirection(from, to) {
    const delta = coordinateDeltaM(from, to);
    const lengthM = Math.hypot(delta.x, delta.z);
    return lengthM > 1e-6
        ? { x: delta.x / lengthM, z: delta.z / lengthM }
        : null;
}

function roadLineageValue(properties, key) {
    const value = properties?.[key] ?? properties?.tags?.[key];
    return value == null || String(value).trim() === ''
        ? null
        : String(value).trim();
}

function sameRoadLineage(owner, candidate) {
    const ownerRef = roadLineageValue(owner.properties, 'ref');
    const candidateRef = roadLineageValue(candidate.properties, 'ref');
    if (ownerRef && candidateRef && ownerRef !== candidateRef) return false;
    const ownerName = roadLineageValue(owner.properties, 'name');
    const candidateName = roadLineageValue(candidate.properties, 'name');
    if (!ownerRef && !candidateRef && ownerName && candidateName && ownerName !== candidateName) {
        return false;
    }
    if (SURFACE_ONLY_HIGHWAYS.has(String(owner.highway))
        && SURFACE_ONLY_HIGHWAYS.has(String(candidate.highway))) {
        return true;
    }
    if (ownerRef && candidateRef) return ownerRef === candidateRef;
    return String(owner.highway) === String(candidate.highway);
}

function explicitVerticalAlignment(properties = {}) {
    const explicit = properties.road_vertical_alignment
        ?? properties.vertical_alignment
        ?? properties.grade_separation;
    return explicit && typeof explicit === 'object' ? explicit : null;
}

export function isUnmodeledShortAccessTunnelRoadRecord(record) {
    const properties = record?.properties || {};
    const authored = properties.road_vertical_alignment
        ?? properties.vertical_alignment
        ?? properties.grade_separation;
    if (explicitVerticalAlignment(properties)
        || (typeof authored === 'string' && ROAD_VERTICAL_KINDS.has(authored))) {
        return false;
    }
    const tags = properties.tags && typeof properties.tags === 'object'
        ? properties.tags
        : {};
    const tunnel = properties.tunnel ?? properties.osm_tunnel ?? tags.tunnel;
    if (!truthyOsmValue(tunnel)
        || String(tunnel).trim().toLowerCase() === 'building_passage') {
        return false;
    }
    const highway = String(record?.highway ?? highwayFromProperties(properties) ?? '')
        .trim()
        .toLowerCase();
    const service = String(properties.service ?? tags.service ?? '')
        .trim()
        .toLowerCase();
    return highway === 'service'
        && UNMODELED_ACCESS_TUNNEL_SERVICES.has(service)
        && roadRecordLengthM(record?.coordinates)
            <= ROAD_UNMODELED_ACCESS_TUNNEL_MAX_LENGTH_M;
}

function isShortOverpassConnector(record) {
    const properties = record?.properties || {};
    const tags = properties.tags && typeof properties.tags === 'object'
        ? properties.tags
        : {};
    const embankment = properties.embankment
        ?? properties.osm_embankment
        ?? tags.embankment;
    return truthyOsmValue(embankment)
        && Number(record?.totalLengthM) <= OVERPASS_CONNECTOR_MAX_LENGTH_M;
}

function isPlainOverpassRunMember(record) {
    if (!record || explicitVerticalAlignment(record.properties)) return false;
    return profileKindFromProperties(record.properties)?.kind === 'overpass'
        || isShortOverpassConnector(record);
}

function traceOverpassRunDirection({
    lineageOwner,
    junction,
    outwardDirection,
    endpointIndex,
    usedRecords,
}) {
    const coordinates = [junction];
    const records = [];
    let current = junction;
    let direction = outwardDirection;
    while (direction) {
        let best = null;
        for (const candidate of endpointIndex.get(endpointKey(current)) || []) {
            if (usedRecords.has(candidate.record)
                || !isPlainOverpassRunMember(candidate.record)
                || !sameRoadLineage(lineageOwner, candidate.record)) {
                continue;
            }
            const source = candidate.record.coordinates;
            const oriented = candidate.endpointIndex === 0
                ? source
                : source.slice().reverse();
            const candidateDirection = unitCoordinateDirection(oriented[0], oriented[1]);
            if (!candidateDirection) continue;
            const dot = direction.x * candidateDirection.x
                + direction.z * candidateDirection.z;
            if (dot < 0 || (best && dot <= best.dot)) continue;
            best = { ...candidate, oriented, dot };
        }
        if (!best) break;
        usedRecords.add(best.record);
        records.push(best.record);
        coordinates.push(...best.oriented.slice(1));
        current = coordinates[coordinates.length - 1];
        direction = unitCoordinateDirection(
            coordinates[coordinates.length - 2],
            current,
        );
    }
    return { coordinates, records };
}

// Join bridge -> short embankment -> bridge OSM members before solving the
// profile. Solving every tagged member separately makes each one descend to
// terrain at its own rounded endpoint, creating a visible step and making cars
// jump at what is physically one continuous crest.
function mergedPlainOsmOverpassRun(owner, endpointIndex) {
    const usedRecords = new Set([owner]);
    const startTrace = traceOverpassRunDirection({
        lineageOwner: owner,
        junction: owner.coordinates[0],
        outwardDirection: unitCoordinateDirection(
            owner.coordinates[1],
            owner.coordinates[0],
        ),
        endpointIndex,
        usedRecords,
    });
    const endTrace = traceOverpassRunDirection({
        lineageOwner: owner,
        junction: owner.coordinates[owner.coordinates.length - 1],
        outwardDirection: unitCoordinateDirection(
            owner.coordinates[owner.coordinates.length - 2],
            owner.coordinates[owner.coordinates.length - 1],
        ),
        endpointIndex,
        usedRecords,
    });
    const structuralMemberRecords = [
        ...startTrace.records.slice().reverse(),
        owner,
        ...endTrace.records,
    ];
    const representative = structuralMemberRecords
        .filter(record => profileKindFromProperties(record.properties)?.kind === 'overpass')
        .sort((a, b) => (
            Number(b.layer || 0) - Number(a.layer || 0)
            || String(a.osmId || '').localeCompare(String(b.osmId || ''))
        ))[0] || owner;
    const coordinates = [
        ...startTrace.coordinates.slice().reverse(),
        ...owner.coordinates.slice(1),
        ...endTrace.coordinates.slice(1),
    ];
    const metrics = corridorMetrics(coordinates);
    return {
        ...representative,
        coordinates,
        ...metrics,
        layer: Math.max(...structuralMemberRecords.map(record => Number(record.layer) || 0)),
        structuralMemberRecords,
        consumedRecords: usedRecords,
    };
}

function underpassDepthM(properties = {}) {
    const pedestrian = isSurfaceOnlyHighway(properties);
    const roofDepthM = pedestrian
        ? PEDESTRIAN_UNDERPASS_ROOF_DEPTH_M
        : DEFAULT_UNDERPASS_ROOF_DEPTH_M;
    const minimumDepthM = pedestrian
        ? PEDESTRIAN_UNDERPASS_CLEAR_HEIGHT_M
            + UNDERPASS_CLEARANCE_MARGIN_M
            + roofDepthM
        : UNDERPASS_MIN_DEPTH_M;
    const taggedMaxHeightM = Number.parseFloat(
        properties.maxheight ?? properties.tags?.maxheight ?? '',
    );
    if (Number.isFinite(taggedMaxHeightM) && taggedMaxHeightM > 0) {
        return -Math.max(
            minimumDepthM,
            taggedMaxHeightM
                + UNDERPASS_CLEARANCE_MARGIN_M
                + roofDepthM,
        );
    }
    return pedestrian ? -minimumDepthM : DEFAULT_UNDERPASS_OFFSET_M;
}

// A tagged height restriction on a way is physical testimony that something
// passes low overhead — the one OSM fact that separates a genuine low passage
// (Miramarski podvožnjak, maxheight=3.65) from an ordinary at-grade street
// that merely happens to run beneath an elevated pedestrian deck.
function taggedLowPassage(properties = {}) {
    const raw = properties.maxheight
        ?? properties.tags?.maxheight
        ?? properties.tags?.['maxheight:physical'];
    const parsed = Number.parseFloat(raw ?? '');
    return Number.isFinite(parsed) && parsed > 0;
}

function underpassClearHeightM(properties = {}) {
    const taggedMaxHeightM = Number.parseFloat(
        properties.maxheight ?? properties.tags?.maxheight ?? '',
    );
    if (Number.isFinite(taggedMaxHeightM) && taggedMaxHeightM > 0) {
        return taggedMaxHeightM + UNDERPASS_CLEARANCE_MARGIN_M;
    }
    return isSurfaceOnlyHighway(properties)
        ? PEDESTRIAN_UNDERPASS_CLEAR_HEIGHT_M
        : null;
}

function centerlineRecordsFromSurfaceFeatures(features) {
    return roadGradeSeparationCorridorRecords(features)
        // /roads/cab also carries railway beds. Railway bridge/tunnel tags
        // belong to the rail formation and must never create asphalt road
        // decks, sidewalks, curbs, or road safety fences.
        .filter(record => record.mode === 'road')
        .map(record => ({
            ...record,
            highway: highwayFromProperties(record.properties),
        }));
}

function buildEndpointIndex(records) {
    const index = new Map();
    for (const record of records) {
        for (const endpointIndex of [0, record.coordinates.length - 1]) {
            const key = endpointKey(record.coordinates[endpointIndex]);
            if (!key) continue;
            if (!index.has(key)) index.set(key, []);
            index.get(key).push({ record, endpointIndex });
        }
    }
    return index;
}

function traceRoadApproach({
    owner,
    junction,
    outwardDirection,
    targetLengthM,
    endpointIndex,
}) {
    const coordinates = [junction];
    const memberOsmIds = [];
    const memberRecords = [];
    const junctionArms = [];
    const junctionArmRecords = new Set();
    const usedRecords = new Set([owner]);
    let current = junction;
    let direction = outwardDirection;
    let remainingM = targetLengthM;

    while (remainingM > 0.05 && direction) {
        const candidates = endpointIndex.get(endpointKey(current)) || [];
        let best = null;
        for (const candidate of candidates) {
            if (usedRecords.has(candidate.record)
                || profileKindFromProperties(candidate.record.properties)
                || !sameRoadLineage(owner, candidate.record)) {
                continue;
            }
            const source = candidate.record.coordinates;
            const oriented = candidate.endpointIndex === 0
                ? source
                : source.slice().reverse();
            const candidateDirection = unitCoordinateDirection(oriented[0], oriented[1]);
            if (!candidateDirection) continue;
            const dot = direction.x * candidateDirection.x
                + direction.z * candidateDirection.z;
            if (dot < 0 || (best && dot <= best.dot)) continue;
            best = { ...candidate, oriented, dot };
        }
        // Every carriageway arm at this node that the trace does not consume
        // is a junction mouth: the authored companion sidewalk must break
        // there instead of running over the connecting road. Footway-class
        // arms keep the sidewalk — pedestrians join it, they don't cross it.
        for (const candidate of candidates) {
            const record = candidate.record;
            if (record === best?.record
                || usedRecords.has(record)
                || junctionArmRecords.has(record)
                // The split-lower builder wraps its owner in a fresh record,
                // so identity alone misses it: never treat the owner way's
                // own other-direction arm as a junction mouth.
                || (record.osmId != null && owner.osmId != null
                    && String(record.osmId) === String(owner.osmId))
                || SURFACE_ONLY_HIGHWAYS.has(String(record.highway))) {
                continue;
            }
            const source = record.coordinates;
            const oriented = candidate.endpointIndex === 0
                ? source
                : source.slice().reverse();
            if (oriented.length < 2) continue;
            junctionArmRecords.add(record);
            junctionArms.push({
                record,
                coordinate: current,
                towardCoordinate: oriented[1],
                osmId: record.osmId ?? null,
                widthM: getCarriagewayWidthM(record.properties) || null,
            });
        }
        if (!best) break;

        usedRecords.add(best.record);
        memberRecords.push(best.record);
        if (best.record.osmId != null) memberOsmIds.push(best.record.osmId);
        let consumedWholeRecord = true;
        for (let index = 1; index < best.oriented.length; index++) {
            const a = best.oriented[index - 1];
            const b = best.oriented[index];
            const segmentLengthM = coordinateDistanceM(a, b);
            if (segmentLengthM <= remainingM + 1e-6) {
                coordinates.push(b);
                remainingM -= segmentLengthM;
                continue;
            }
            const t = remainingM / Math.max(segmentLengthM, 1e-6);
            coordinates.push([
                linearInterpolate(Number(a[0]), Number(b[0]), t),
                linearInterpolate(Number(a[1]), Number(b[1]), t),
            ]);
            remainingM = 0;
            consumedWholeRecord = false;
            break;
        }
        if (!consumedWholeRecord || coordinates.length < 2) break;
        current = coordinates[coordinates.length - 1];
        direction = unitCoordinateDirection(
            coordinates[coordinates.length - 2],
            current,
        );
    }

    return {
        coordinates,
        memberOsmIds,
        memberRecords,
        // An arm seen at an early node can still be consumed as a member at a
        // later node (both its endpoints on the trace); drop those.
        junctions: junctionArms
            .filter(arm => !usedRecords.has(arm.record))
            .map(({ record: _record, ...arm }) => arm),
    };
}

function roadMaximumGrade(properties, fallback) {
    const raw = properties?.max_grade
        ?? properties?.maxgrade
        ?? properties?.tags?.max_grade
        ?? properties?.tags?.maxgrade;
    const parsed = Number.parseFloat(String(raw ?? '').replace('%', ''));
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed > 1 ? parsed / 100 : parsed;
}

function terrainElevationAslMAtCoordinate(options, coordinate) {
    return finiteOrNull(
        options?.terrainElevationAslMAtCoordinate?.(coordinate),
    );
}

function normalizeCrossingElevationEvidence(value, fallbackSource) {
    const elevationAslM = finiteOrNull(
        value && typeof value === 'object'
            ? value.elevationAslM
            : value,
    );
    if (elevationAslM == null) return null;
    if (!value || typeof value !== 'object') {
        return { elevationAslM, source: fallbackSource };
    }
    return {
        elevationAslM,
        source: value.source == null ? fallbackSource : String(value.source),
        match: value.match == null ? null : String(value.match),
        alignmentId: value.alignmentId == null ? null : String(value.alignmentId),
        distanceM: finiteOrNull(value.distanceM),
        structure: value.structure == null ? null : String(value.structure),
        authoredAbsolute: value.authoredAbsolute === true,
    };
}

function crossingSideElevationEvidence(
    crossing,
    side,
    options,
    terrainElevationAslM,
) {
    const composition = crossing?.[`${side}Composition`] || {};
    if (composition.mode !== 'rail') {
        return terrainElevationAslM == null
            ? { elevationAslM: null, source: 'terrain-unavailable' }
            : { elevationAslM: terrainElevationAslM, source: 'dgu-dtm' };
    }
    const sampler = options?.railElevationAslMAtCoordinate;
    if (typeof sampler !== 'function') {
        return terrainElevationAslM == null
            ? { elevationAslM: null, source: 'terrain-unavailable' }
            : {
                elevationAslM: terrainElevationAslM,
                source: 'dgu-dtm-rail-fallback',
            };
    }
    const sampled = normalizeCrossingElevationEvidence(
        sampler(crossing.coordinate, {
            crossing,
            side,
            composition,
        }),
        'rail-formation',
    );
    return sampled || {
        elevationAslM: null,
        source: 'rail-formation-unavailable',
    };
}

function osmElevationAslM(properties = {}) {
    const parsed = Number.parseFloat(
        properties.ele ?? properties.tags?.ele ?? '',
    );
    return Number.isFinite(parsed) ? parsed : null;
}

function crossingWithElevationSolution(
    crossing,
    ownerKind,
    ownerElevationAslM,
    options,
    {
        upperRaiseLimitM = null,
        lowerCutLimitM = null,
        upperMovementWeight = 1,
        lowerMovementWeight = 1,
    } = {},
) {
    const terrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        crossing.coordinate,
    );
    const ownerElevationIsFixed = ownerElevationAslM != null;
    const ownerIsUpper = ownerKind === 'overpass';
    let upperEvidence = crossingSideElevationEvidence(
        crossing,
        'upper',
        options,
        terrainElevationAslM,
    );
    let lowerEvidence = crossingSideElevationEvidence(
        crossing,
        'lower',
        options,
        terrainElevationAslM,
    );
    if (ownerElevationIsFixed) {
        const fixedEvidence = {
            elevationAslM: ownerElevationAslM,
            source: 'osm-ele',
        };
        if (ownerIsUpper) upperEvidence = fixedEvidence;
        else lowerEvidence = fixedEvidence;
    }
    const elevationEvidence = {
        upper: upperEvidence,
        lower: lowerEvidence,
    };
    if (upperEvidence.elevationAslM == null
        || lowerEvidence.elevationAslM == null) {
        return { ...crossing, elevationEvidence };
    }
    const solution = solveRoadGradeSeparationElevationPair({
        upperBaseElevationAslM: upperEvidence.elevationAslM,
        lowerBaseElevationAslM: lowerEvidence.elevationAslM,
        requiredSurfaceSeparationM: crossing.requiredSurfaceSeparationM,
        upperRaiseLimitM: upperRaiseLimitM
            ?? (ownerIsUpper && !ownerElevationIsFixed ? Infinity : 0),
        lowerCutLimitM: lowerCutLimitM
            ?? (!ownerIsUpper && !ownerElevationIsFixed ? Infinity : 0),
        upperMovementWeight,
        lowerMovementWeight,
    });
    return {
        ...crossing,
        elevationEvidence,
        elevationSolution: {
            ...solution,
            solver: 'minimum-weighted-movement-v1',
            upperBaseSource: upperEvidence.source,
            lowerBaseSource: lowerEvidence.source,
            upperOwnership: ownerIsUpper ? 'authored-owner' : 'fixed-counterpart',
            lowerOwnership: ownerIsUpper ? 'fixed-counterpart' : 'authored-owner',
        },
    };
}

function roadRecordForOsmIds(corridors, osmIds) {
    const requested = new Set(
        (Array.isArray(osmIds) ? osmIds : [])
            .map(numericId)
            .filter(Boolean),
    );
    return (Array.isArray(corridors) ? corridors : []).find(record => (
        record?.mode === 'road'
        && requested.has(record.osmId)
        && !SURFACE_ONLY_HIGHWAYS.has(String(
            highwayFromProperties(record.properties) || '',
        ))
        && !profileKindFromProperties(record.properties)
    )) || null;
}

function prepareLowerRoadSplitPlan(
    crossing,
    corridors,
    endpointIndex,
    options,
) {
    const owner = roadRecordForOsmIds(corridors, crossing.lowerOsmIds);
    const stationM = finiteOrNull(crossing.candidateStationM);
    const halfLengths = roadGradeSeparationCrossingClearHalfLengthsM(
        crossing,
        'underpass',
        { useStoredRange: false },
    );
    if (!owner || stationM == null || !halfLengths) return null;

    const clearStartM = Math.max(0, stationM - halfLengths.beforeM);
    const clearEndM = Math.min(
        owner.totalLengthM,
        stationM + halfLengths.afterM,
    );
    const maxGrade = roadMaximumGrade(
        owner.properties,
        isSurfaceOnlyHighway(owner.properties)
            ? DEFAULT_PEDESTRIAN_UNDERPASS_MAX_GRADE
            : DEFAULT_UNDERPASS_MAX_GRADE,
    );
    const maximumRequiredCutM = Math.max(
        0,
        finiteOrNull(crossing.requiredSurfaceSeparationM) || 0,
    );
    const start = owner.coordinates[0];
    const end = owner.coordinates[owner.coordinates.length - 1];
    const crossingTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        crossing.coordinate,
    );
    const startTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        start,
    );
    const endTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        end,
    );
    if (crossingTerrainElevationAslM == null
        || startTerrainElevationAslM == null
        || endTerrainElevationAslM == null) {
        return null;
    }
    const maximumTargetElevationAslM = crossingTerrainElevationAslM
        - maximumRequiredCutM;
    const maximumStartApproachM = Math.abs(
        maximumTargetElevationAslM - startTerrainElevationAslM,
    ) * 1.5 / maxGrade;
    const maximumEndApproachM = Math.abs(
        maximumTargetElevationAslM - endTerrainElevationAslM,
    ) * 1.5 / maxGrade;
    const requiredStartOutsideM = Math.max(
        0,
        maximumStartApproachM - clearStartM,
    );
    const requiredEndOutsideM = Math.max(
        0,
        maximumEndApproachM - (owner.totalLengthM - clearEndM),
    );
    const startCapacityApproach = traceRoadApproach({
        owner,
        junction: start,
        outwardDirection: unitCoordinateDirection(owner.coordinates[1], start),
        targetLengthM: requiredStartOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const endCapacityApproach = traceRoadApproach({
        owner,
        junction: end,
        outwardDirection: unitCoordinateDirection(
            owner.coordinates[owner.coordinates.length - 2],
            end,
        ),
        targetLengthM: requiredEndOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const startOutsideM = coordinatePolylineLengthM(
        startCapacityApproach.coordinates,
    );
    const endOutsideM = coordinatePolylineLengthM(
        endCapacityApproach.coordinates,
    );
    const startRunoutM = Math.max(0, startOutsideM - requiredStartOutsideM);
    const endRunoutM = Math.max(0, endOutsideM - requiredEndOutsideM);
    const availableStartCurveM = clearStartM + startOutsideM - startRunoutM;
    const availableEndCurveM = owner.totalLengthM - clearEndM
        + endOutsideM - endRunoutM;
    const minimumStartTargetElevationAslM = startTerrainElevationAslM
        - availableStartCurveM * maxGrade / 1.5;
    const minimumEndTargetElevationAslM = endTerrainElevationAslM
        - availableEndCurveM * maxGrade / 1.5;
    const minimumTargetElevationAslM = Math.max(
        minimumStartTargetElevationAslM,
        minimumEndTargetElevationAslM,
    );
    return {
        owner,
        stationM,
        clearStartM,
        clearEndM,
        maxGrade,
        startTerrainElevationAslM,
        endTerrainElevationAslM,
        cutLimitM: Math.max(
            0,
            crossingTerrainElevationAslM - minimumTargetElevationAslM,
        ),
    };
}

function applyUpperProfileTargetToSolution(
    solution,
    upperElevationAslM,
    lowerCutLimitM,
) {
    if (!solution || solution.status === 'unavailable') return solution;
    const upperBaseM = solution.upperBaseElevationAslM;
    const lowerBaseM = solution.lowerBaseElevationAslM;
    const requiredSeparationM = solution.requiredSurfaceSeparationM;
    const upperLiftM = Math.max(0, upperElevationAslM - upperBaseM);
    const requiredLowerCutM = Math.max(
        0,
        requiredSeparationM - (upperElevationAslM - lowerBaseM),
    );
    const lowerCutM = Math.min(
        Math.max(0, finiteOrNull(lowerCutLimitM) ?? 0),
        requiredLowerCutM,
    );
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
        ...solution,
        status: feasible ? 'solved' : 'infeasible',
        feasible,
        allocation,
        upperElevationAslM,
        lowerElevationAslM,
        upperLiftM,
        lowerCutM,
        achievedSeparationM,
        remainingDeficitM,
    };
}

function synthesizedUnderpassCenterline(
    owner,
    endpointIndex,
    corridors,
    options = {},
    { bored = false } = {},
) {
    const coordinates = owner.coordinates;
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    const depthM = underpassDepthM(owner.properties);
    const ownerElevationAslM = osmElevationAslM(owner.properties);
    const crossings = roadGradeSeparationCrossings(
        owner,
        corridors,
        'underpass',
    ).map(crossing => crossingWithElevationSolution(
        crossing,
        'underpass',
        ownerElevationAslM,
        options,
    ));
    const solvedLowerElevationsAslM = crossings
        .map(crossing => crossing.elevationSolution)
        .filter(solution => solution && solution.status !== 'unavailable')
        .map(solution => Math.min(
            solution.lowerElevationAslM,
            solution.lowerBaseElevationAslM + depthM,
        ))
        .filter(Number.isFinite);
    const profileElevationAslM = ownerElevationAslM
        ?? (solvedLowerElevationsAslM.length > 0
            ? Math.min(...solvedLowerElevationsAslM)
            : null);
    const surfaceOnly = isSurfaceOnlyHighway(owner.properties);
    const maxGrade = roadMaximumGrade(
        owner.properties,
        surfaceOnly
            ? DEFAULT_PEDESTRIAN_UNDERPASS_MAX_GRADE
            : DEFAULT_UNDERPASS_MAX_GRADE,
    );
    const startTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        start,
    );
    const endTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        end,
    );
    const startTunnelJunctionElevationAslM = interiorTunnelJunctionElevationAslM(
        owner,
        start,
        corridors,
        options,
    );
    const endTunnelJunctionElevationAslM = interiorTunnelJunctionElevationAslM(
        owner,
        end,
        corridors,
        options,
    );
    const startCutM = profileElevationAslM != null
        && startTerrainElevationAslM != null
        ? Math.abs(profileElevationAslM - startTerrainElevationAslM)
        : Math.abs(depthM);
    const endCutM = profileElevationAslM != null
        && endTerrainElevationAslM != null
        ? Math.abs(profileElevationAslM - endTerrainElevationAslM)
        : Math.abs(depthM);
    // A BORE is not a dip. The dip profile below holds one floor depth
    // relative to the terrain at MID-SPAN, which for a way passing under a
    // hill hangs the whole bed near the hilltop: at Divulje (service road
    // 306878572, 429 m under ~70 m of cover) the floor sat 40+ m above its
    // own portals, and every stretch where that bed was not buried was carved
    // open — 262 x 242 m and 103 x 176 m of hillside at the two mouths. A
    // bore's floor instead grades between the ground at its two portals: the
    // road enters the hill at grade on each side, the cover keeps the span
    // buried, and only the shallow portal stretches open as mouths — the same
    // look rail gets from its authored profiles plus TUNNEL_PORTAL_CARVE_M.
    // The cover gate keeps long flat cut-and-covers on the dip profile. Length
    // alone cannot identify a bore, however: a short branch entering a steep
    // hillside can have a low exterior portal and an underground junction at
    // its other end. If the crossing-clearance plateau sits ABOVE either
    // portal's terrain, an exposed dip would have to climb through open air —
    // categorically a bore, regardless of length. Grič's 86 m south branch
    // exposed that failure by lifting its 24 m stair approach about 20 m and
    // then cutting away the perfectly valid hill below it.
    const taggedTunnel = isTaggedRoadTunnel(owner.properties);
    const boreCoverM = taggedTunnel
        ? boredTunnelPeakCoverM(owner, options)
        : null;
    const clearanceFloorAbovePortal = taggedTunnel
        && profileElevationAslM != null
        && [startTerrainElevationAslM, endTerrainElevationAslM]
            .some(terrainElevationAslM => (
                terrainElevationAslM != null
                && profileElevationAslM - terrainElevationAslM
                    > SYNTHESIZED_UNDERPASS_FULL_FORMATION_DEPTH_M
            ));
    const boreProfile = taggedTunnel && (
        clearanceFloorAbovePortal
        || (boreCoverM != null
            && boreCoverM >= ROAD_BORED_TUNNEL_MIN_COVER_M)
        || (bored && boreCoverM == null)
    );
    // smoothstep's steepest derivative is 1.5x its average slope, so size the
    // approach for that peak rather than accidentally producing a 12% ramp
    // from an advertised 8% design limit. A bore joins its neighbours at
    // grade, so its approach only needs the short portal run-in (mirrors
    // rail-formation.js TUNNEL_PORTAL_CARVE_M).
    const startApproachLengthM = boreProfile
        ? Math.min(startCutM * 1.5 / maxGrade, ROAD_TUNNEL_PORTAL_CARVE_M)
        : startCutM * 1.5 / maxGrade;
    const endApproachLengthM = boreProfile
        ? Math.min(endCutM * 1.5 / maxGrade, ROAD_TUNNEL_PORTAL_CARVE_M)
        : endCutM * 1.5 / maxGrade;
    const startApproach = traceRoadApproach({
        owner,
        junction: start,
        outwardDirection: unitCoordinateDirection(coordinates[1], start),
        targetLengthM: (boreProfile
            ? ROAD_BORED_TUNNEL_APPROACH_TRACE_M
            : startApproachLengthM) + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const endApproach = traceRoadApproach({
        owner,
        junction: end,
        outwardDirection: unitCoordinateDirection(
            coordinates[coordinates.length - 2],
            end,
        ),
        targetLengthM: (boreProfile
            ? ROAD_BORED_TUNNEL_APPROACH_TRACE_M
            : endApproachLengthM) + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const startApproachRunoutM = Math.max(
        0,
        coordinatePolylineLengthM(startApproach.coordinates)
            - startApproachLengthM,
    );
    const endApproachRunoutM = Math.max(
        0,
        coordinatePolylineLengthM(endApproach.coordinates)
            - endApproachLengthM,
    );
    const memberOsmIds = [
        owner.osmId,
        ...startApproach.memberOsmIds,
        ...endApproach.memberOsmIds,
    ].filter(id => id != null);
    const connectedRecords = [
        owner,
        ...startApproach.memberRecords,
        ...endApproach.memberRecords,
    ];
    const laneCountOverride = Math.max(
        ...connectedRecords.map(record => (
            getLaneCountForProperties(record.properties) || 0
        )),
    ) || null;
    const measuredWidthM = Math.max(
        ...connectedRecords.map(record => (
            getCarriagewayWidthM(record.properties) || 0
        )),
    ) || null;
    // A widthless OSM footway is not a 24 m road corridor. Use the same
    // pedestrian fallback that discovered its crossing envelope; otherwise a
    // small tunnel mouth inherits DEFAULT_CORRIDOR_HALF_WIDTH_M and removes a
    // building-sized rectangle from the hillside (Grič south portal).
    const widthM = measuredWidthM ?? (surfaceOnly
        ? roadGradeSeparationCorridorWidthM(owner.properties, 'road')
        : null);
    const formationHalfWidthM = widthM == null
        ? null
        : measuredWidthM != null || !surfaceOnly
            ? widthM * 0.5 + SYNTHESIZED_ROAD_SHOULDER_M
            : roadGradeSeparationFormationHalfWidthM(
                owner.properties,
                'road',
            );
    const profileRange = {
        start: { coordinate: start },
        end: { coordinate: end },
    };
    const details = {
        kind: 'underpass',
        id: `osm-${owner.osmId}`,
        memberOsmIds,
        structureOsmIds: owner.osmId == null ? [] : [owner.osmId],
        profile: boreProfile
            ? {
                // Portal-to-portal grade through the hill; along the traced
                // approaches the bed keeps a node on the ground at every OSM
                // vertex, so the access road CLIMBS THE REAL SLOPE instead of
                // riding one straight chord that floats over dips and digs
                // through rises (slice(1): the first approach coordinate is
                // the portal node itself).
                type: 'nodes',
                nodes: [
                    ...startApproach.coordinates.slice(1).map(coordinate => (
                        { at: { coordinate }, terrainOffsetM: 0 }
                    )),
                    startTunnelJunctionElevationAslM == null
                        ? { at: { coordinate: start }, terrainOffsetM: 0 }
                        : {
                            at: { coordinate: start },
                            elevationAslM: startTunnelJunctionElevationAslM,
                        },
                    endTunnelJunctionElevationAslM == null
                        ? { at: { coordinate: end }, terrainOffsetM: 0 }
                        : {
                            at: { coordinate: end },
                            elevationAslM: endTunnelJunctionElevationAslM,
                        },
                    ...endApproach.coordinates.slice(1).map(coordinate => (
                        { at: { coordinate }, terrainOffsetM: 0 }
                    )),
                ],
            }
            : {
                type: ownerElevationAslM != null
                    ? 'absolute-peak'
                    : profileElevationAslM != null
                        ? 'coupled-clearance-peak'
                        : 'relative-peak',
                ...(profileElevationAslM != null
                    ? {
                        peakElevationAslM: profileElevationAslM,
                        fallbackOffsetM: depthM,
                    }
                    : { peakOffsetM: depthM }),
                peakRange: profileRange,
                approachRunoutM: {
                    start: startApproachRunoutM,
                    end: endApproachRunoutM,
                },
            },
        structureRange: profileRange,
        // The bore keeps its hill by STATION (see isCoveredStructureSample);
        // rendering and terrain cutouts must agree on that rule.
        ...(boreProfile ? {
            structureMode: 'bored',
            borePortalOpenEnds: {
                start: startTunnelJunctionElevationAslM == null,
                end: endTunnelJunctionElevationAslM == null,
            },
            ...(surfaceOnly ? {
                borePortalCarveM: ROAD_PEDESTRIAN_TUNNEL_PORTAL_CARVE_M,
                borePortalCarveMaxM:
                    3 * ROAD_PEDESTRIAN_TUNNEL_PORTAL_CARVE_M,
            } : {}),
        } : {}),
        clearHeightM: underpassClearHeightM(owner.properties),
        roofDepthM: isSurfaceOnlyHighway(owner.properties)
            ? PEDESTRIAN_UNDERPASS_ROOF_DEPTH_M
            : DEFAULT_UNDERPASS_ROOF_DEPTH_M,
        maxGrade,
        approachLengthM: Math.max(
            startApproachLengthM,
            endApproachLengthM,
        ),
        approachLengthsM: {
            start: startApproachLengthM,
            end: endApproachLengthM,
        },
        crossings,
        crossingElevationPairSolved: crossings.length > 0
            && crossings.every(crossing => (
                crossing.elevationSolution?.feasible === true
            )),
        widthM,
        laneCountOverride,
        // Side roads joining the approaches: the companion sidewalk and its
        // curb open over these mouths so the connecting road stays usable.
        junctions: [...startApproach.junctions, ...endApproach.junctions],
        replaceRoadSurface: true,
        // One authored cross-section owns the tunnel and both graded ramps.
        // Suppress every source member in that span so disconnected PostGIS
        // buffers cannot cover the continuous sidewalk or fight its roadbed.
        replaceRoadSurfaceOsmIds: memberOsmIds,
        replaceRoadSurfaceRange: 'profile',
        replacementCarriagewayOnly: true,
        crossSection: {
            carriagewayHalfWidthM: widthM == null ? null : widthM * 0.5,
            formationHalfWidthM,
            // The raw PostGIS road buffers have rounded member end caps. The
            // synthesized alignment replaces their mask inside this wider
            // strip, then cuts one square-ended opening just inside the
            // alignment-owned concrete wall.
            terrainClearHalfWidthM: formationHalfWidthM == null
                ? null
                : formationHalfWidthM
                    + SYNTHESIZED_UNDERPASS_TERRAIN_CLEAR_MARGIN_M,
            terrainCutoutHalfWidthM: formationHalfWidthM == null
                ? null
                : formationHalfWidthM,
        },
        source: 'osm',
    };
    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                ...startApproach.coordinates.slice().reverse(),
                ...coordinates.slice(1),
                ...endApproach.coordinates.slice(1),
            ],
        },
        properties: {
            ...owner.properties,
            highway: owner.highway,
            road_vertical_alignment: details,
        },
    };
}

function synthesizedSplitLowerCenterline(
    upperOwner,
    crossing,
    plan,
    endpointIndex,
) {
    const owner = plan.owner;
    const lowerCutM = Math.max(
        0,
        finiteOrNull(crossing.elevationSolution?.lowerCutM) || 0,
    );
    if (lowerCutM <= 1e-6) return null;
    const targetElevationAslM = crossing.elevationSolution.lowerElevationAslM;
    const requiredStartApproachM = Math.abs(
        targetElevationAslM - plan.startTerrainElevationAslM,
    ) * 1.5 / plan.maxGrade;
    const requiredEndApproachM = Math.abs(
        targetElevationAslM - plan.endTerrainElevationAslM,
    ) * 1.5 / plan.maxGrade;
    const requiredStartOutsideM = Math.max(
        0,
        requiredStartApproachM - plan.clearStartM,
    );
    const requiredEndOutsideM = Math.max(
        0,
        requiredEndApproachM - (owner.totalLengthM - plan.clearEndM),
    );
    const start = owner.coordinates[0];
    const end = owner.coordinates[owner.coordinates.length - 1];
    const startApproach = traceRoadApproach({
        owner,
        junction: start,
        outwardDirection: unitCoordinateDirection(owner.coordinates[1], start),
        targetLengthM: requiredStartOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const endApproach = traceRoadApproach({
        owner,
        junction: end,
        outwardDirection: unitCoordinateDirection(
            owner.coordinates[owner.coordinates.length - 2],
            end,
        ),
        targetLengthM: requiredEndOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const startApproachRunoutM = Math.max(
        0,
        coordinatePolylineLengthM(startApproach.coordinates)
            - requiredStartOutsideM,
    );
    const endApproachRunoutM = Math.max(
        0,
        coordinatePolylineLengthM(endApproach.coordinates)
            - requiredEndOutsideM,
    );
    const connectedRecords = [
        owner,
        ...startApproach.memberRecords,
        ...endApproach.memberRecords,
    ];
    const widthM = Math.max(
        ...connectedRecords.map(record => (
            getCarriagewayWidthM(record.properties) || 0
        )),
    ) || null;
    const laneCountOverride = Math.max(
        ...connectedRecords.map(record => (
            getLaneCountForProperties(record.properties) || 0
        )),
    ) || null;
    const formationHalfWidthM = widthM == null
        ? null
        : widthM * 0.5 + SYNTHESIZED_ROAD_SHOULDER_M;
    const memberOsmIds = [
        owner.osmId,
        ...startApproach.memberOsmIds,
        ...endApproach.memberOsmIds,
    ].filter(id => id != null);
    const clearStartCoordinate = coordinateAtCorridorStation(
        owner.coordinates,
        owner.cumulative,
        plan.clearStartM,
    );
    const clearEndCoordinate = coordinateAtCorridorStation(
        owner.coordinates,
        owner.cumulative,
        plan.clearEndM,
    );
    const lowerCrossing = {
        ...crossing,
        stationM: plan.stationM,
        candidateStationM: crossing.stationM,
        clearStartM: plan.clearStartM,
        clearEndM: plan.clearEndM,
    };
    const alignmentId = `osm-${upperOwner.osmId}-split-lower-${owner.osmId}`;
    const details = {
        kind: 'underpass',
        id: alignmentId,
        memberOsmIds,
        structureOsmIds: [],
        profile: {
            type: 'coupled-clearance-peak',
            peakElevationAslM:
                crossing.elevationSolution.lowerElevationAslM,
            peakRange: {
                start: { coordinate: clearStartCoordinate },
                end: { coordinate: clearEndCoordinate },
            },
            approachRunoutM: {
                start: startApproachRunoutM,
                end: endApproachRunoutM,
            },
        },
        // One zero-length marker keeps the open cut walled through the crossing
        // while deliberately producing no tunnel box or portal pair.
        structureRange: {
            start: { coordinate: crossing.coordinate },
            end: { coordinate: crossing.coordinate },
        },
        structureMode: 'open-cut',
        crossings: [lowerCrossing],
        crossingElevationPairSolved: true,
        jointProfileSolved: true,
        pairedAlignmentId: `osm-${upperOwner.osmId}`,
        maxGrade: plan.maxGrade,
        approachLengthM: Math.max(
            requiredStartApproachM,
            requiredEndApproachM,
        ),
        approachLengthsM: {
            start: requiredStartApproachM,
            end: requiredEndApproachM,
        },
        widthM,
        laneCountOverride,
        junctions: [...startApproach.junctions, ...endApproach.junctions],
        replaceRoadSurface: true,
        // The generated floor contains the traced approach members as well as
        // the directly crossed seed way. Suppress every one of those ordinary
        // terrain-draped asphalt buffers; otherwise a split OSM carriageway can
        // rise back toward terrain halfway through the underpass.
        replaceRoadSurfaceOsmIds: memberOsmIds,
        // This generated counterpart is an open cut with only a zero-length
        // structure marker, so its authored floor must continue through the
        // whole solved profile.
        replaceRoadSurfaceRange: 'profile',
        replacementCarriagewayOnly: true,
        crossSection: {
            carriagewayHalfWidthM: widthM == null ? null : widthM * 0.5,
            formationHalfWidthM,
            terrainClearHalfWidthM: formationHalfWidthM == null
                ? null
                : formationHalfWidthM
                    + SYNTHESIZED_UNDERPASS_TERRAIN_CLEAR_MARGIN_M,
            terrainCutoutHalfWidthM: formationHalfWidthM,
        },
        source: 'osm-paired-split',
    };
    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                ...startApproach.coordinates.slice().reverse(),
                ...owner.coordinates.slice(1),
                ...endApproach.coordinates.slice(1),
            ],
        },
        properties: {
            ...owner.properties,
            highway: highwayFromProperties(owner.properties),
            road_vertical_alignment: details,
        },
    };
}

function synthesizedOverpassCenterlines(
    owner,
    endpointIndex,
    corridors,
    options = {},
) {
    const coordinates = owner.coordinates;
    const start = coordinates[0];
    const end = coordinates[coordinates.length - 1];
    const originalLengthM = coordinates.slice(1).reduce(
        (lengthM, coordinate, index) => (
            lengthM + coordinateDistanceM(coordinates[index], coordinate)
        ),
        0,
    );
    const ownerElevationAslM = osmElevationAslM(owner.properties);
    const rawCrossings = roadGradeSeparationCrossings(
        owner,
        corridors,
        'overpass',
    );
    const initialCrossings = rawCrossings.map(crossing => (
        crossingWithElevationSolution(
        crossing,
        'overpass',
        ownerElevationAslM,
        options,
    )));
    const clearRange = roadGradeSeparationClearRange(owner, initialCrossings);
    const liftM = clearRange?.requiredSurfaceSeparationM
        ?? (isSurfaceOnlyHighway(owner.properties)
            ? DEFAULT_SURFACE_ONLY_OVERPASS_OFFSET_M
            : DEFAULT_OVERPASS_OFFSET_M);
    const maxGrade = roadMaximumGrade(
        owner.properties,
        isSurfaceOnlyHighway(owner.properties) && initialCrossings.length === 0
            ? DEFAULT_SURFACE_ONLY_OVERPASS_MAX_GRADE
            : DEFAULT_OVERPASS_MAX_GRADE,
    );
    const clearancePeakElevationAslM = initialCrossings.length > 0
        ? Math.max(...initialCrossings.map(crossing => (
            crossing.elevationSolution?.upperElevationAslM ?? -Infinity
        )))
        : -Infinity;
    const peakElevationAslM = ownerElevationAslM != null
        ? ownerElevationAslM
        : Number.isFinite(clearancePeakElevationAslM)
            ? clearancePeakElevationAslM
            : null;
    const startTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        start,
    );
    const endTerrainElevationAslM = terrainElevationAslMAtCoordinate(
        options,
        end,
    );
    const initialStartRiseM = peakElevationAslM != null
        && startTerrainElevationAslM != null
        ? Math.abs(peakElevationAslM - startTerrainElevationAslM)
        : Math.abs(liftM);
    const initialEndRiseM = peakElevationAslM != null
        && endTerrainElevationAslM != null
        ? Math.abs(peakElevationAslM - endTerrainElevationAslM)
        : Math.abs(liftM);
    // smoothstep reaches 1.5x its average slope. Extend only the missing part
    // of each approach beyond the tagged bridge member: the part between the
    // OSM endpoint and the measured clear zone already contributes useful run.
    const initialRequiredStartApproachM = initialStartRiseM * 1.5 / maxGrade;
    const initialRequiredEndApproachM = initialEndRiseM * 1.5 / maxGrade;
    const clearStartM = clearRange?.startM ?? originalLengthM * 0.45;
    const clearEndM = clearRange?.endM ?? originalLengthM * 0.55;
    const initialRequiredStartOutsideM = Math.max(
        0,
        initialRequiredStartApproachM - clearStartM,
    );
    const initialRequiredEndOutsideM = Math.max(
        0,
        initialRequiredEndApproachM - (originalLengthM - clearEndM),
    );
    const startApproach = traceRoadApproach({
        owner,
        junction: start,
        outwardDirection: unitCoordinateDirection(coordinates[1], start),
        targetLengthM: initialRequiredStartOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const endApproach = traceRoadApproach({
        owner,
        junction: end,
        outwardDirection: unitCoordinateDirection(
            coordinates[coordinates.length - 2],
            end,
        ),
        targetLengthM: initialRequiredEndOutsideM
            + SYNTHESIZED_APPROACH_RUNOUT_M,
        endpointIndex,
    });
    const startApproachLengthOutsideM = coordinatePolylineLengthM(
        startApproach.coordinates,
    );
    const endApproachLengthOutsideM = coordinatePolylineLengthM(
        endApproach.coordinates,
    );
    const initialStartRunoutM = Math.max(
        0,
        startApproachLengthOutsideM - initialRequiredStartOutsideM,
    );
    const initialEndRunoutM = Math.max(
        0,
        endApproachLengthOutsideM - initialRequiredEndOutsideM,
    );
    const availableStartCurveM = clearStartM
        + startApproachLengthOutsideM - initialStartRunoutM;
    const availableEndCurveM = originalLengthM - clearEndM
        + endApproachLengthOutsideM - initialEndRunoutM;
    const surfaceOnlyUpper = isSurfaceOnlyHighway(owner.properties);
    const upperMaximumElevationAslM = ownerElevationAslM != null
        ? ownerElevationAslM
        : startTerrainElevationAslM != null
            && endTerrainElevationAslM != null
            ? Math.min(
                startTerrainElevationAslM
                    + availableStartCurveM * maxGrade / 1.5,
                endTerrainElevationAslM
                    + availableEndCurveM * maxGrade / 1.5,
            )
            : Infinity;
    const splitPlans = rawCrossings.map(crossing => (
        prepareLowerRoadSplitPlan(
            crossing,
            corridors,
            endpointIndex,
            options,
        )
    ));
    // A vehicular bridge can only climb what its traced approaches allow, so
    // its raise capacity is capped by grade over the available run and any
    // residual clearance goes into a generated lower cut (Miramarska under
    // Slavonska). A PEDESTRIAN deck has no vehicular approach constraint:
    // stairs, ramps and lifts climb in place. It may still seed a lower cut,
    // but only where the lower way itself testifies to a low passage (a
    // maxheight restriction — the Miramarski podvožnjak). Without that
    // evidence a pedestrian deck absorbs its whole clearance by rising:
    // one short elevated walkway at Strojarska (way 783288530) used to demand
    // five open-cut trenches through the at-grade service alleys below it.
    const pedestrianExemptCrossings = splitPlans.map(splitPlan => (
        surfaceOnlyUpper
        && !taggedLowPassage(splitPlan?.owner?.properties)
    ));
    let crossings = rawCrossings.map((crossing, index) => {
        const terrainElevationAslM = terrainElevationAslMAtCoordinate(
            options,
            crossing.coordinate,
        );
        const upperBaseElevationAslM = ownerElevationAslM
            ?? terrainElevationAslM;
        const upperRaiseLimitM = upperBaseElevationAslM == null
            || upperMaximumElevationAslM === Infinity
            || pedestrianExemptCrossings[index]
            ? Infinity
            : Math.max(
                0,
                upperMaximumElevationAslM - upperBaseElevationAslM,
            );
        const initialSeparationM = ownerElevationAslM != null
            && terrainElevationAslM != null
            ? ownerElevationAslM - terrainElevationAslM
            : 0;
        const deficitM = Math.max(
            0,
            Number(crossing.requiredSurfaceSeparationM || liftM)
                - initialSeparationM,
        );
        const splitPlan = splitPlans[index];
        const lowerCutLimitM = splitPlan
            && !pedestrianExemptCrossings[index]
            && upperRaiseLimitM < deficitM - 1e-6
            ? splitPlan.cutLimitM
            : 0;
        return crossingWithElevationSolution(
            crossing,
            'overpass',
            ownerElevationAslM,
            options,
            {
                upperRaiseLimitM,
                lowerCutLimitM,
                // A bridge tag is evidence that the upper road should carry
                // the movement. The lower road moves only after that approach
                // reaches its grade/lineage capacity.
                upperMovementWeight: 1,
                lowerMovementWeight: 1e9,
            },
        );
    });
    const solvedUpperTargets = crossings
        .map(crossing => crossing.elevationSolution?.upperElevationAslM)
        .filter(Number.isFinite);
    const appliedPeakElevationAslM = ownerElevationAslM
        ?? (solvedUpperTargets.length > 0
            ? Math.max(...solvedUpperTargets)
            : null);
    if (appliedPeakElevationAslM != null) {
        crossings = crossings.map((crossing, index) => {
            if (!crossing.elevationSolution) return crossing;
            return {
                ...crossing,
                elevationSolution: {
                    ...applyUpperProfileTargetToSolution(
                        crossing.elevationSolution,
                        appliedPeakElevationAslM,
                        pedestrianExemptCrossings[index]
                            ? 0
                            : splitPlans[index]?.cutLimitM ?? 0,
                    ),
                    solver: 'minimum-weighted-movement-v1',
                    upperOwnership: 'authored-owner',
                    lowerOwnership: crossing.elevationSolution?.lowerCutM > 1e-6
                        && splitPlans[index]
                        ? 'generated-counterpart'
                        : 'fixed-counterpart',
                },
            };
        });
    }
    const finalStartRiseM = appliedPeakElevationAslM != null
        && startTerrainElevationAslM != null
        ? Math.abs(appliedPeakElevationAslM - startTerrainElevationAslM)
        : Math.abs(liftM);
    const finalEndRiseM = appliedPeakElevationAslM != null
        && endTerrainElevationAslM != null
        ? Math.abs(appliedPeakElevationAslM - endTerrainElevationAslM)
        : Math.abs(liftM);
    const requiredStartApproachM = finalStartRiseM * 1.5 / maxGrade;
    const requiredEndApproachM = finalEndRiseM * 1.5 / maxGrade;
    const requiredStartOutsideM = Math.max(
        0,
        requiredStartApproachM - clearStartM,
    );
    const requiredEndOutsideM = Math.max(
        0,
        requiredEndApproachM - (originalLengthM - clearEndM),
    );
    const startApproachRunoutM = Math.max(
        0,
        startApproachLengthOutsideM - requiredStartOutsideM,
    );
    const endApproachRunoutM = Math.max(
        0,
        endApproachLengthOutsideM - requiredEndOutsideM,
    );
    const structureRecords = Array.isArray(owner.structuralMemberRecords)
        ? owner.structuralMemberRecords
        : [owner];
    const connectedRecords = [
        ...structureRecords,
        ...startApproach.memberRecords,
        ...endApproach.memberRecords,
    ];
    const widthM = Math.max(
        ...connectedRecords.map(record => (
            getCarriagewayWidthM(record.properties) || 0
        )),
    ) || null;
    const laneCountOverride = Math.max(
        ...connectedRecords.map(record => (
            getLaneCountForProperties(record.properties) || 0
        )),
    ) || null;
    const memberOsmIds = [
        ...structureRecords.map(record => record.osmId),
        ...startApproach.memberOsmIds,
        ...endApproach.memberOsmIds,
    ].filter(id => id != null);
    const peakRange = clearRange
        ? {
            start: { coordinate: clearRange.startCoordinate },
            end: { coordinate: clearRange.endCoordinate },
        }
        : {
            start: { fraction: 0.45 },
            end: { fraction: 0.55 },
        };
    const details = {
        kind: 'overpass',
        id: `osm-${owner.osmId}`,
        memberOsmIds,
        structureOsmIds: structureRecords
            .map(record => record.osmId)
            .filter(id => id != null),
        profile: {
            type: ownerElevationAslM != null
                ? 'absolute-peak'
                : appliedPeakElevationAslM != null
                    ? 'terrain-clearance-peak'
                    : crossings.length > 0
                        ? 'crossing-clearance'
                        : 'relative-peak',
            ...(ownerElevationAslM != null
                ? { peakElevationAslM: ownerElevationAslM }
                : appliedPeakElevationAslM != null
                    ? {
                        peakElevationAslM: appliedPeakElevationAslM,
                        fallbackOffsetM: liftM,
                    }
                    : { peakOffsetM: liftM }),
            peakRange,
            approachRunoutM: {
                start: startApproachRunoutM,
                end: endApproachRunoutM,
            },
        },
        structureRange: {
            start: { coordinate: start },
            end: { coordinate: end },
        },
        crossings,
        crossingElevationPairSolved: crossings.length > 0
            && crossings.every(crossing => (
                crossing.elevationSolution?.feasible === true
            )),
        maxGrade,
        approachLengthM: Math.max(
            requiredStartApproachM,
            requiredEndApproachM,
        ),
        approachLengthsM: {
            start: requiredStartApproachM,
            end: requiredEndApproachM,
        },
        widthM,
        laneCountOverride,
        crossSection: {
            carriagewayHalfWidthM: widthM == null ? null : widthM * 0.5,
            formationHalfWidthM: widthM == null
                ? null
                : widthM * 0.5 + SYNTHESIZED_ROAD_SHOULDER_M,
        },
        source: crossings.length > 0 ? 'osm-paired' : 'osm',
    };
    const lowerFeatures = [];
    const generatedLowerOsmIds = new Set();
    const splitOrder = crossings
        .map((crossing, index) => ({ crossing, index }))
        .sort((a, b) => (
            Number(b.crossing.elevationSolution?.lowerCutM || 0)
            - Number(a.crossing.elevationSolution?.lowerCutM || 0)
        ));
    for (const { crossing, index } of splitOrder) {
        const plan = splitPlans[index];
        if (!plan
            || generatedLowerOsmIds.has(plan.owner.osmId)
            || !(crossing.elevationSolution?.lowerCutM > 1e-6)) {
            continue;
        }
        const lowerFeature = synthesizedSplitLowerCenterline(
            owner,
            crossing,
            plan,
            endpointIndex,
        );
        if (!lowerFeature) continue;
        generatedLowerOsmIds.add(plan.owner.osmId);
        lowerFeatures.push(lowerFeature);
    }
    details.jointProfileSolved = lowerFeatures.length > 0
        && crossings.every(crossing => crossing.elevationSolution?.feasible === true);
    details.counterpartAlignmentIds = lowerFeatures.map(feature => (
        feature.properties.road_vertical_alignment.id
    ));
    const upperFeature = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [
                ...startApproach.coordinates.slice().reverse(),
                ...coordinates.slice(1),
                ...endApproach.coordinates.slice(1),
            ],
        },
        properties: {
            ...owner.properties,
            highway: owner.highway,
            road_vertical_alignment: details,
        },
    };
    return [upperFeature, ...lowerFeatures];
}

function nearestStationOnCoordinateAxis(coordinate, coordinates, cumulative) {
    if (!finiteCoordinate(coordinate)
        || !Array.isArray(coordinates)
        || coordinates.length < 2) {
        return null;
    }
    let best = null;
    for (let index = 0; index + 1 < coordinates.length; index++) {
        const a = coordinates[index];
        const b = coordinates[index + 1];
        const ab = coordinateDeltaM(a, b);
        const ap = coordinateDeltaM(a, coordinate);
        const lengthSquared = ab.x * ab.x + ab.z * ab.z;
        if (lengthSquared <= 1e-9) continue;
        const t = Math.max(0, Math.min(
            1,
            (ap.x * ab.x + ap.z * ab.z) / lengthSquared,
        ));
        const dx = ap.x - ab.x * t;
        const dz = ap.z - ab.z * t;
        const distanceSquared = dx * dx + dz * dz;
        if (best && distanceSquared >= best.distanceSquared) continue;
        best = {
            stationM: cumulative[index] + Math.sqrt(lengthSquared) * t,
            distanceSquared,
        };
    }
    return best;
}

function sharedStringMember(left, right) {
    for (const value of left) {
        if (right.has(value)) return true;
    }
    return false;
}

function adjustedLowerCrossingSolution(crossing, targetElevationAslM) {
    const solution = crossing?.elevationSolution;
    if (!solution || !Number.isFinite(targetElevationAslM)) return solution;
    const lowerBaseElevationAslM = finiteOrNull(solution.lowerBaseElevationAslM);
    const upperElevationAslM = finiteOrNull(solution.upperElevationAslM);
    if (lowerBaseElevationAslM == null || upperElevationAslM == null) return solution;
    const lowerCutM = Math.max(0, lowerBaseElevationAslM - targetElevationAslM);
    const achievedSeparationM = upperElevationAslM - targetElevationAslM;
    const requiredSurfaceSeparationM = finiteOrNull(
        crossing.requiredSurfaceSeparationM,
    ) || 0;
    const remainingDeficitM = Math.max(
        0,
        requiredSurfaceSeparationM - achievedSeparationM,
    );
    const feasible = remainingDeficitM <= 1e-6;
    return {
        ...solution,
        status: feasible ? 'solved' : 'infeasible',
        feasible,
        allocation: solution.upperLiftM > 1e-6
            ? (lowerCutM > 1e-6 ? 'split' : 'upper-only')
            : (lowerCutM > 1e-6 ? 'lower-only' : 'existing-clearance'),
        lowerElevationAslM: targetElevationAslM,
        lowerCutM,
        achievedSeparationM,
        remainingDeficitM,
        lowerOwnership: 'composite-counterpart',
    };
}

// One lower road can run beneath several independently mapped bridge members.
// Each upper owner used to emit its own lower counterpart, and _byOsmId then
// picked whichever tile arrived first. Miramarska consequently alternated
// between a complete 220 m trench and a short profile already back at terrain.
// Collapse intersecting lower lineages here, while all OSM corridors are still
// available, so rendering, replacement, terrain cutout, and diagnostics read
// one deterministic owner.
function composeSynthesizedSplitLowerCenterlines(
    centerlines,
    corridors,
    options,
    records,
    endpointIndex,
) {
    const splitEntries = centerlines
        .map((feature, index) => ({
            feature,
            index,
            details: feature?.properties?.road_vertical_alignment,
        }))
        .filter(entry => entry.details?.source === 'osm-paired-split');
    if (splitEntries.length === 0) return centerlines;

    const groups = [];
    for (const entry of splitEntries) {
        entry.members = new Set(
            (entry.details.memberOsmIds || []).map(String),
        );
        const matches = groups.filter(group => (
            sharedStringMember(group.members, entry.members)
        ));
        if (matches.length === 0) {
            groups.push({ entries: [entry], members: new Set(entry.members) });
            continue;
        }
        const group = matches[0];
        group.entries.push(entry);
        for (const member of entry.members) group.members.add(member);
        for (const merged of matches.slice(1)) {
            group.entries.push(...merged.entries);
            for (const member of merged.members) group.members.add(member);
            groups.splice(groups.indexOf(merged), 1);
        }
    }

    const replacementByIndex = new Map();
    const removedIndices = new Set();
    const counterpartIds = new Map();
    for (const group of groups) {
        const ranked = group.entries.slice().sort((a, b) => {
            const aElevation = finiteOrNull(a.details.profile?.peakElevationAslM);
            const bElevation = finiteOrNull(b.details.profile?.peakElevationAslM);
            if (aElevation != null || bElevation != null) {
                if (aElevation == null) return 1;
                if (bElevation == null) return -1;
                if (aElevation !== bElevation) return aElevation - bElevation;
            }
            return coordinatePolylineLengthM(b.feature.geometry.coordinates)
                - coordinatePolylineLengthM(a.feature.geometry.coordinates)
                || String(a.details.id).localeCompare(String(b.details.id));
        });
        const chosen = ranked[0];
        let coordinates = chosen.feature.geometry.coordinates;
        let metrics = corridorMetrics(coordinates);
        let targetElevationAslM = finiteOrNull(
            chosen.details.profile?.peakElevationAslM,
        );
        const originalCrossings = group.entries.flatMap(
            entry => entry.details.crossings || [],
        );
        const knownCrossings = centerlines.flatMap(feature => (
            feature?.properties?.road_vertical_alignment?.crossings || []
        ));
        const matchingKnownCrossing = (raw) => {
            const rawUpperIds = new Set((raw.upperOsmIds || []).map(String));
            const candidates = knownCrossings
                .filter(candidate => (
                    sharedStringMember(
                        rawUpperIds,
                        new Set((candidate.upperOsmIds || []).map(String)),
                    )
                    && coordinateDistanceM(raw.coordinate, candidate.coordinate) <= 3
                ));
            const sameLowerLineage = candidates.filter(candidate => (
                (candidate.lowerOsmIds || []).some(osmId => (
                    group.members.has(String(osmId))
                ))
            ));
            const rankedCandidates = sameLowerLineage.length > 0
                ? sameLowerLineage
                : candidates;
            return rankedCandidates.sort((a, b) => {
                const aAuthoredUpper = a.elevationSolution?.upperOwnership
                    === 'authored-owner' ? 1 : 0;
                const bAuthoredUpper = b.elevationSolution?.upperOwnership
                    === 'authored-owner' ? 1 : 0;
                return bAuthoredUpper - aAuthoredUpper
                    || Number(!!b.elevationSolution) - Number(!!a.elevationSolution)
                    || coordinateDistanceM(raw.coordinate, a.coordinate)
                        - coordinateDistanceM(raw.coordinate, b.coordinate);
            })[0] || null;
        };
        const crossingWithKnownEvidence = (raw) => {
            const matched = matchingKnownCrossing(raw);
            if (matched) {
                return {
                    ...raw,
                    elevationEvidence: matched.elevationEvidence,
                    elevationSolution: matched.elevationSolution,
                };
            }
            // A crossing discovered only after extending the lower axis has no
            // generated counterpart yet. Solve its evidence without fixing the
            // old plateau so it can deepen the shared lower road when needed.
            return crossingWithElevationSolution(
                raw,
                'underpass',
                null,
                options,
            );
        };
        const deepenTargetForCrossings = (crossings) => {
            const requiredTargets = crossings
                .map(crossing => finiteOrNull(
                    crossing.elevationSolution?.lowerElevationAslM,
                ))
                .filter(value => value != null);
            if (targetElevationAslM != null) requiredTargets.push(targetElevationAslM);
            if (requiredTargets.length > 0) {
                targetElevationAslM = Math.min(...requiredTargets);
            }
        };
        const ownerForCoordinates = () => ({
            osmId: String(chosen.feature.properties.osm_id ?? ''),
            mode: 'road',
            layer: 0,
            properties: chosen.feature.properties,
            coordinates,
            ...metrics,
        });
        let rawCrossings = roadGradeSeparationCrossings(
            ownerForCoordinates(),
            corridors,
            'underpass',
        );
        if (group.entries.length === 1) {
            const originalUpperIds = new Set(originalCrossings.flatMap(
                crossing => (crossing.upperOsmIds || []).map(String),
            ));
            const addsCrossingOwner = rawCrossings.some(crossing => (
                (crossing.upperOsmIds || []).some(
                    osmId => !originalUpperIds.has(String(osmId)),
                )
            ));
            if (!addsCrossingOwner) continue;
        }
        const maxGrade = finiteOrNull(chosen.details.maxGrade)
            || DEFAULT_UNDERPASS_MAX_GRADE;
        const sourceOwnerId = String(chosen.feature.properties.osm_id ?? '');
        const sourceOwner = records.find(record => (
            String(record.osmId ?? '') === sourceOwnerId
        )) || null;
        const extendedMemberOsmIds = new Set();
        const extendedJunctions = [];

        // A split-lower feature is initially sized from the one upper owner
        // that discovered it. Once several overlapping owners are composed,
        // the last newly discovered crossing can sit at that temporary axis
        // endpoint. The final solver then knows that it needs (for example)
        // another 135 m to climb from Miramarska's low plateau, but without
        // retracing the connected OSM lineage there is no axis on which to
        // build that approach. Iteratively extend from the original lower way;
        // each pass may reveal one more nearby bridge, while a genuinely
        // distant structure remains separate because no required approach
        // reaches it.
        for (let pass = 0;
            pass < SYNTHESIZED_COMPOSITE_MAX_EXTENSION_PASSES
                && sourceOwner
                && endpointIndex;
            pass += 1) {
            if (rawCrossings.length === 0) break;
            deepenTargetForCrossings(rawCrossings.map(crossingWithKnownEvidence));
            if (targetElevationAslM == null) break;
            const clearStartM = Math.min(...rawCrossings.map(crossing => (
                finiteOrNull(crossing.clearStartM)
                    ?? nearestStationOnCoordinateAxis(
                        crossing.coordinate,
                        coordinates,
                        metrics.cumulative,
                    )?.stationM
                    ?? metrics.totalLengthM * 0.45
            )));
            const clearEndM = Math.max(...rawCrossings.map(crossing => (
                finiteOrNull(crossing.clearEndM)
                    ?? nearestStationOnCoordinateAxis(
                        crossing.coordinate,
                        coordinates,
                        metrics.cumulative,
                    )?.stationM
                    ?? metrics.totalLengthM * 0.55
            )));
            const startCoordinate = coordinateAtCorridorStation(
                coordinates,
                metrics.cumulative,
                0,
            );
            const endCoordinate = coordinateAtCorridorStation(
                coordinates,
                metrics.cumulative,
                metrics.totalLengthM,
            );
            const startTerrainAslM = terrainElevationAslMAtCoordinate(
                options,
                startCoordinate,
            );
            const endTerrainAslM = terrainElevationAslMAtCoordinate(
                options,
                endCoordinate,
            );
            const startApproachLengthM = startTerrainAslM != null
                ? Math.abs(startTerrainAslM - targetElevationAslM)
                    * 1.5 / maxGrade
                : finiteOrNull(chosen.details.approachLengthsM?.start) || 0;
            const endApproachLengthM = endTerrainAslM != null
                ? Math.abs(endTerrainAslM - targetElevationAslM)
                    * 1.5 / maxGrade
                : finiteOrNull(chosen.details.approachLengthsM?.end) || 0;
            // Retain the complete axis already discovered on the other side.
            // Rebuilding from the source owner must only grow this envelope;
            // otherwise extending the south ramp can silently shorten the
            // north ramp by the same amount and appear to make no progress.
            const wantedStartM = Math.min(
                0,
                clearStartM
                    - startApproachLengthM
                    - SYNTHESIZED_APPROACH_RUNOUT_M,
            );
            const wantedEndM = Math.max(
                metrics.totalLengthM,
                clearEndM
                    + endApproachLengthM
                    + SYNTHESIZED_APPROACH_RUNOUT_M,
            );
            if (wantedStartM >= -0.05
                && wantedEndM <= metrics.totalLengthM + 0.05) {
                break;
            }

            const sourceCoordinates = sourceOwner.coordinates;
            const firstProjection = nearestStationOnCoordinateAxis(
                sourceCoordinates[0],
                coordinates,
                metrics.cumulative,
            );
            const lastProjection = nearestStationOnCoordinateAxis(
                sourceCoordinates[sourceCoordinates.length - 1],
                coordinates,
                metrics.cumulative,
            );
            if (!firstProjection || !lastProjection) break;
            const forward = firstProjection.stationM <= lastProjection.stationM;
            const earlyIndex = forward ? 0 : sourceCoordinates.length - 1;
            const lateIndex = forward ? sourceCoordinates.length - 1 : 0;
            const earlyStationM = Math.min(
                firstProjection.stationM,
                lastProjection.stationM,
            );
            const lateStationM = Math.max(
                firstProjection.stationM,
                lastProjection.stationM,
            );
            const outwardDirection = (endpoint) => endpoint === 0
                ? unitCoordinateDirection(sourceCoordinates[1], sourceCoordinates[0])
                : unitCoordinateDirection(
                    sourceCoordinates[sourceCoordinates.length - 2],
                    sourceCoordinates[sourceCoordinates.length - 1],
                );
            const startApproach = traceRoadApproach({
                owner: sourceOwner,
                junction: sourceCoordinates[earlyIndex],
                outwardDirection: outwardDirection(earlyIndex),
                targetLengthM: Math.max(0, earlyStationM - wantedStartM),
                endpointIndex,
            });
            const endApproach = traceRoadApproach({
                owner: sourceOwner,
                junction: sourceCoordinates[lateIndex],
                outwardDirection: outwardDirection(lateIndex),
                targetLengthM: Math.max(0, wantedEndM - lateStationM),
                endpointIndex,
            });
            const orientedOwnerCoordinates = forward
                ? sourceCoordinates
                : sourceCoordinates.slice().reverse();
            const extendedCoordinates = [
                ...startApproach.coordinates.slice().reverse(),
                ...orientedOwnerCoordinates.slice(1),
                ...endApproach.coordinates.slice(1),
            ];
            const extendedMetrics = corridorMetrics(extendedCoordinates);
            if (extendedMetrics.totalLengthM <= metrics.totalLengthM + 0.05) break;
            for (const osmId of [
                ...startApproach.memberOsmIds,
                ...endApproach.memberOsmIds,
            ]) {
                extendedMemberOsmIds.add(String(osmId));
            }
            extendedJunctions.push(
                ...startApproach.junctions,
                ...endApproach.junctions,
            );
            coordinates = extendedCoordinates;
            metrics = extendedMetrics;
            rawCrossings = roadGradeSeparationCrossings(
                ownerForCoordinates(),
                corridors,
                'underpass',
            );
        }
        const evidencedCrossings = rawCrossings.map(crossingWithKnownEvidence);
        deepenTargetForCrossings(evidencedCrossings);
        const crossings = evidencedCrossings.map(crossing => ({
            ...crossing,
            elevationSolution: adjustedLowerCrossingSolution(
                crossing,
                targetElevationAslM,
            ),
        }));
        const rangeCrossings = crossings.length > 0
            ? crossings
            : originalCrossings;
        const clearStartM = Math.min(
            ...rangeCrossings.map(crossing => (
                finiteOrNull(crossing.clearStartM)
                    ?? nearestStationOnCoordinateAxis(
                        crossing.coordinate,
                        coordinates,
                        metrics.cumulative,
                    )?.stationM
                    ?? metrics.totalLengthM * 0.45
            )),
        );
        const clearEndM = Math.max(
            ...rangeCrossings.map(crossing => (
                finiteOrNull(crossing.clearEndM)
                    ?? nearestStationOnCoordinateAxis(
                        crossing.coordinate,
                        coordinates,
                        metrics.cumulative,
                    )?.stationM
                    ?? metrics.totalLengthM * 0.55
            )),
        );
        const peakStartM = Math.max(0, Math.min(metrics.totalLengthM, clearStartM));
        const peakEndM = Math.max(peakStartM, Math.min(metrics.totalLengthM, clearEndM));
        const peakStartCoordinate = coordinateAtCorridorStation(
            coordinates,
            metrics.cumulative,
            peakStartM,
        );
        const peakEndCoordinate = coordinateAtCorridorStation(
            coordinates,
            metrics.cumulative,
            peakEndM,
        );
        const startTerrainAslM = terrainElevationAslMAtCoordinate(
            options,
            peakStartCoordinate,
        );
        const endTerrainAslM = terrainElevationAslMAtCoordinate(
            options,
            peakEndCoordinate,
        );
        const safeStartCurveM = gradeSafeApproachStation({
            initialStationM: peakStartM,
            peakStationM: peakStartM,
            outerStationM: Math.min(
                SYNTHESIZED_APPROACH_RUNOUT_M,
                peakStartM,
            ),
            targetY: targetElevationAslM,
            maxGrade,
            sampleYAtStation: stationM => terrainElevationAslMAtCoordinate(
                options,
                coordinateAtCorridorStation(
                    coordinates,
                    metrics.cumulative,
                    stationM,
                ),
            ),
        });
        const safeEndCurveM = gradeSafeApproachStation({
            initialStationM: peakEndM,
            peakStationM: peakEndM,
            outerStationM: metrics.totalLengthM - Math.min(
                SYNTHESIZED_APPROACH_RUNOUT_M,
                metrics.totalLengthM - peakEndM,
            ),
            targetY: targetElevationAslM,
            maxGrade,
            sampleYAtStation: stationM => terrainElevationAslMAtCoordinate(
                options,
                coordinateAtCorridorStation(
                    coordinates,
                    metrics.cumulative,
                    stationM,
                ),
            ),
        });
        const fallbackStartApproachLengthM = targetElevationAslM != null
            && startTerrainAslM != null
            ? Math.abs(startTerrainAslM - targetElevationAslM) * 1.5 / maxGrade
            : finiteOrNull(chosen.details.approachLengthsM?.start) || 0;
        const fallbackEndApproachLengthM = targetElevationAslM != null
            && endTerrainAslM != null
            ? Math.abs(endTerrainAslM - targetElevationAslM) * 1.5 / maxGrade
            : finiteOrNull(chosen.details.approachLengthsM?.end) || 0;
        const startApproachLengthM = safeStartCurveM == null
            ? fallbackStartApproachLengthM
            : peakStartM - safeStartCurveM;
        const endApproachLengthM = safeEndCurveM == null
            ? fallbackEndApproachLengthM
            : safeEndCurveM - peakEndM;
        const startApproachRunoutM = safeStartCurveM == null
            ? Math.max(0, peakStartM - startApproachLengthM)
            : safeStartCurveM;
        const endApproachRunoutM = safeEndCurveM == null
            ? Math.max(
                0,
                metrics.totalLengthM - peakEndM - endApproachLengthM,
            )
            : metrics.totalLengthM - safeEndCurveM;
        const memberOsmIds = Array.from(new Set([
            ...group.members,
            ...extendedMemberOsmIds,
        ])).sort();
        const originalOwnerIds = Array.from(new Set(group.entries.flatMap(entry => (
            entry.details.replaceRoadSurfaceOsmIds || []
        )).map(String))).sort();
        const canonicalOwnerId = originalOwnerIds[0] || memberOsmIds[0] || 'anonymous';
        const id = `osm-composite-split-lower-${canonicalOwnerId}`;
        const markerCoordinate = coordinateAtCorridorStation(
            coordinates,
            metrics.cumulative,
            (peakStartM + peakEndM) * 0.5,
        );
        const details = {
            ...chosen.details,
            id,
            memberOsmIds,
            profile: {
                ...chosen.details.profile,
                peakRange: {
                    start: { coordinate: peakStartCoordinate },
                    end: { coordinate: peakEndCoordinate },
                },
                approachRunoutM: {
                    start: startApproachRunoutM,
                    end: endApproachRunoutM,
                },
            },
            structureRange: {
                start: { coordinate: markerCoordinate },
                end: { coordinate: markerCoordinate },
            },
            crossings,
            crossingElevationPairSolved: crossings.length > 0
                && crossings.every(crossing => (
                    crossing.elevationSolution?.feasible === true
                )),
            pairedAlignmentIds: group.entries.map(
                entry => entry.details.pairedAlignmentId,
            ).filter(Boolean),
            approachLengthM: Math.max(
                startApproachLengthM,
                endApproachLengthM,
            ),
            approachLengthsM: {
                start: startApproachLengthM,
                end: endApproachLengthM,
            },
            junctions: uniqueRoadJunctions([
                ...(chosen.details.junctions || []),
                ...extendedJunctions,
            ]),
            // This one continuous alignment owns every source member it grades.
            // Leaving the list at only the directly crossed member allowed the
            // ordinary asphalt to fight the generated floor on adjacent ways.
            replaceRoadSurfaceOsmIds: memberOsmIds,
            source: 'osm-paired-split-composite',
        };
        delete details.pairedAlignmentId;
        const canonical = {
            ...chosen.feature,
            geometry: {
                ...chosen.feature.geometry,
                coordinates,
            },
            properties: {
                ...chosen.feature.properties,
                road_vertical_alignment: details,
            },
        };
        const insertionIndex = Math.min(...group.entries.map(entry => entry.index));
        replacementByIndex.set(insertionIndex, canonical);
        for (const entry of group.entries) {
            removedIndices.add(entry.index);
            counterpartIds.set(entry.details.id, id);
        }
    }
    if (replacementByIndex.size === 0) return centerlines;

    const composed = [];
    for (let index = 0; index < centerlines.length; index++) {
        const replacement = replacementByIndex.get(index);
        if (replacement) composed.push(replacement);
        if (removedIndices.has(index)) continue;
        const feature = centerlines[index];
        const details = feature?.properties?.road_vertical_alignment;
        if (!Array.isArray(details?.counterpartAlignmentIds)) {
            composed.push(feature);
            continue;
        }
        composed.push({
            ...feature,
            properties: {
                ...feature.properties,
                road_vertical_alignment: {
                    ...details,
                    counterpartAlignmentIds: Array.from(new Set(
                        details.counterpartAlignmentIds.map(
                            id => counterpartIds.get(id) || id,
                        ),
                    )),
                },
            },
        });
    }
    return composed;
}

// /roads/cab already carries the original OSM centreline beside each buffered
// surface. Promote only grade-separated ones into alignment inputs so companion
// cycleways and footways inherit their own OSM bridge profile without widening
// the motor-road graph or adding another stream.
export function roadVerticalCenterlinesFromSurfaceFeatures(
    features = [],
    options = {},
) {
    return drainAlignmentSteps(roadVerticalCenterlinesFromSurfaceFeaturesSteps(features, options));
}

export function* roadVerticalCenterlinesFromSurfaceFeaturesSteps(features = [], options = {}) {
    const records = centerlineRecordsFromSurfaceFeatures(features);
    yield { phase: 'alignment-source-records' };
    const corridors = roadGradeSeparationCorridorRecords(features);
    yield { phase: 'alignment-source-corridors' };
    const endpointIndex = buildEndpointIndex(records);
    yield { phase: 'alignment-source-endpoints' };
    const centerlines = [];
    const consumedOverpassRecords = new Set();
    for (const record of records) {
        yield { phase: 'alignment-source-profile' };
        if (consumedOverpassRecords.has(record)) continue;
        const resolved = profileKindFromProperties(record.properties);
        if (!resolved) continue;
        // A tiny garage/private-access tunnel is not enough evidence for a
        // country-scale civil underpass. In particular, do not let the normal
        // approach tracing inflate its few metres into a broad terrain opening.
        // Explicit authored alignments remain authoritative above.
        if (resolved.kind === 'underpass'
            && isUnmodeledShortAccessTunnelRoadRecord(record)) {
            continue;
        }
        if (resolved.kind === 'underpass'
            && !(record.properties.road_vertical_alignment
                && typeof record.properties.road_vertical_alignment === 'object')) {
            centerlines.push(synthesizedUnderpassCenterline(
                record,
                endpointIndex,
                corridors,
                options,
                // A bore keeps its hill: the floor grades portal-to-portal
                // and only the mouths open. The builder still verifies the
                // ground truly rises over the way (ROAD_BORED_TUNNEL_MIN_COVER_M)
                // so long flat cut-and-covers keep their dip.
                { bored: isBoredTunnelRoadRecord(record) },
            ));
            continue;
        }
        if (resolved.kind === 'overpass'
            && !explicitVerticalAlignment(record.properties)) {
            const owner = mergedPlainOsmOverpassRun(record, endpointIndex);
            for (const member of owner.consumedRecords) {
                consumedOverpassRecords.add(member);
            }
            centerlines.push(...synthesizedOverpassCenterlines(
                owner,
                endpointIndex,
                corridors,
                options,
            ));
            continue;
        }
        centerlines.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: record.coordinates,
            },
            properties: {
                ...record.properties,
                highway: record.highway,
            },
        });
    }
    return composeSynthesizedSplitLowerCenterlines(
        centerlines,
        corridors,
        options,
        records,
        endpointIndex,
    );
}

function alignmentDirection(alignment) {
    const start = alignment?.points?.[0];
    const end = alignment?.points?.[alignment.points.length - 1];
    const dx = Number(end?.x) - Number(start?.x);
    const dz = Number(end?.z) - Number(start?.z);
    const lengthM = Math.hypot(dx, dz);
    return lengthM >= 0.05
        ? { x: dx / lengthM, z: dz / lengthM }
        : null;
}

function alignmentMiddle(alignment) {
    return alignment?.samples?.[Math.floor((alignment.samples.length - 1) * 0.5)]
        || null;
}

function alignmentTangentAtSample(alignment, sample) {
    const samples = alignment?.samples || [];
    const candidate = lowerSampleIndex(samples, sample?.s);
    const index = samples[candidate] === sample ? candidate : samples.indexOf(sample);
    if (index < 0) return null;
    const before = samples[Math.max(0, index - 1)];
    const after = samples[Math.min(samples.length - 1, index + 1)];
    const dx = Number(after?.x) - Number(before?.x);
    const dz = Number(after?.z) - Number(before?.z);
    const lengthM = Math.hypot(dx, dz);
    return lengthM >= 0.05
        ? { x: dx / lengthM, z: dz / lengthM }
        : null;
}

function lowerSampleIndex(samples, stationM) {
    let low = 0, high = samples.length - 1;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (Number(samples[middle].s) >= stationM) high = middle;
        else low = middle + 1;
    }
    return low;
}

function alignmentStructureProbeSamples(alignment) {
    const samples = alignment?.samples || [];
    if (samples.length === 0) return [];
    const startM = Number(alignment.structureStartM);
    const endM = Number(alignment.structureEndM);
    const stations = Number.isFinite(startM) && Number.isFinite(endM)
        ? [startM, (startM + endM) * 0.5, endM]
        : [samples[Math.floor((samples.length - 1) * 0.5)]?.s];
    return Array.from(new Set(stations.map(stationM => {
        const after = lowerSampleIndex(samples, stationM), before = Math.max(0, after - 1);
        return Math.abs(Number(samples[after].s) - stationM) < Math.abs(Number(samples[before].s) - stationM)
            ? samples[after] : samples[before];
    })));
}

// Geometry, not separately sampled terrain, establishes that a path is part
// of a carriageway's bridge deck. Sampling the two parallel OSM ways
// independently can give them different crest heights on cross-sloped DTM.
function structuralCompanionRelation(owner, companion) {
    return drainAlignmentSteps(structuralCompanionRelationSteps(owner, companion));
}

function* structuralCompanionRelationSteps(owner, companion, clock = null) {
    if (!owner
        || !companion
        || owner === companion
        || owner.kind !== companion.kind
        || owner.definition?.renderStructure === false
        || companion.definition?.renderStructure !== false) {
        return null;
    }
    const ownerDirection = alignmentDirection(owner);
    const companionDirection = alignmentDirection(companion);
    const ownerMiddle = alignmentMiddle(owner);
    if (!ownerDirection || !companionDirection || !ownerMiddle) return null;
    const directionDot = Math.abs(
        ownerDirection.x * companionDirection.x
        + ownerDirection.z * companionDirection.z,
    );
    if (directionDot < STRUCTURE_COMPANION_MIN_DIRECTION_DOT) return null;
    const nearest = clock ? yield* companion.nearest.prepareSteps(ownerMiddle.x, ownerMiddle.z, clock)
        : companion.nearest(ownerMiddle.x, ownerMiddle.z);
    if (!nearest
        || nearest.distanceSquared > STRUCTURE_COMPANION_MAX_OFFSET_M ** 2
        || nearest.s < companion.structureStartM
        || nearest.s > companion.structureEndM) {
        return null;
    }
    const ownerNormalX = -ownerDirection.z;
    const ownerNormalZ = ownerDirection.x;
    return {
        distanceM: Math.sqrt(nearest.distanceSquared),
        signedOffsetM: (
            (nearest.x - ownerMiddle.x) * ownerNormalX
            + (nearest.z - ownerMiddle.z) * ownerNormalZ
        ),
        nearest,
    };
}

// The centre relation is sufficient to choose a canonical profile owner, but
// an asymmetric civil shell must contain the companion at both portals too.
// Real OSM sidewalk centre-lines can converge by a metre across a short
// tunnel; sizing the wall from only the midpoint lets one portal clip the
// sidewalk and makes the whole opening look laterally displaced.
function structuralCompanionEnvelopeRelations(owner, companion) {
    return drainAlignmentSteps(structuralCompanionEnvelopeRelationsSteps(owner, companion));
}

function* structuralCompanionEnvelopeRelationsSteps(owner, companion, clock = null) {
    if (!(yield* structuralCompanionRelationSteps(owner, companion, clock))) return [];
    const relations = [];
    for (const sample of alignmentStructureProbeSamples(owner)) {
        if (clock?.expired()) { yield { phase: 'alignment-companion-probes' }; clock.restart(); }
        const tangent = alignmentTangentAtSample(owner, sample);
        const nearest = clock ? yield* companion.nearest.prepareSteps(sample.x, sample.z, clock)
            : companion.nearest(sample.x, sample.z);
        if (!tangent
            || !nearest
            || nearest.distanceSquared > STRUCTURE_COMPANION_MAX_OFFSET_M ** 2
            || nearest.s < companion.structureStartM
            || nearest.s > companion.structureEndM) {
            continue;
        }
        const normalX = -tangent.z;
        const normalZ = tangent.x;
        relations.push({
            distanceM: Math.sqrt(nearest.distanceSquared),
            signedOffsetM: (
                (nearest.x - sample.x) * normalX
                + (nearest.z - sample.z) * normalZ
            ),
            nearest,
        });
    }
    return relations;
}

function* structuralCompanionRelationAtSampleSteps(owner, companion, sample, clock = null) {
    if (!sample || !(yield* structuralCompanionRelationSteps(owner, companion, clock))) return null;
    const tangent = alignmentTangentAtSample(owner, sample);
    const nearest = clock ? yield* companion.nearest.prepareSteps(sample.x, sample.z, clock)
        : companion.nearest(sample.x, sample.z);
    if (!tangent
        || !nearest
        || nearest.distanceSquared > STRUCTURE_COMPANION_MAX_OFFSET_M ** 2
        || pointIsPastAlignmentEndpoint(
            companion,
            nearest,
            sample.x,
            sample.z,
        )) {
        return null;
    }
    const normalX = -tangent.z;
    const normalZ = tangent.x;
    return {
        distanceM: Math.sqrt(nearest.distanceSquared),
        signedOffsetM: (
            (nearest.x - sample.x) * normalX
            + (nearest.z - sample.z) * normalZ
        ),
        nearest,
    };
}

// Keep an open-cut wall outside a separately mapped sidewalk for every ramp
// row, not only across the covered structure. The ordinary path renderer owns
// the visible approach sidewalk; this helper gives the wall and terrain hole
// the matching outer boundary without authoring a second, fighting surface.
export function roadStructureFormationOffsetsAtSampleM(alignment, alignments, baseFormationOffsetsM, sample) {
    return drainAlignmentSteps(roadStructureFormationOffsetsAtSampleSteps(alignment, alignments, baseFormationOffsetsM, sample));
}

function* roadStructureFormationOffsetsAtSampleSteps(
    alignment,
    alignments,
    baseFormationOffsetsM,
    sample,
    clock = null) {
    const baseLeftM = Math.max(
        0,
        Number(
            baseFormationOffsetsM?.leftM
            ?? baseFormationOffsetsM
            ?? 0,
        ) || 0,
    );
    const baseRightM = Math.max(
        0,
        Number(
            baseFormationOffsetsM?.rightM
            ?? baseFormationOffsetsM
            ?? 0,
        ) || 0,
    );
    const offsets = { leftM: baseLeftM, rightM: baseRightM };
    if (!alignment || alignment.definition?.renderStructure === false) return offsets;
    for (const companion of Array.isArray(alignments) ? alignments : []) {
        if (clock?.expired()) { yield { phase: 'alignment-companion-row' }; clock.restart(); }
        const relation = yield* structuralCompanionRelationAtSampleSteps(
            alignment,
            companion,
            sample, clock,
        );
        if (!relation) continue;
        const companionHalfWidthM = Number(companion.definition?.widthM) > 0
            ? Number(companion.definition.widthM) * 0.5
            : STRUCTURE_COMPANION_DEFAULT_HALF_WIDTH_M;
        const outerOffsetM = Math.abs(relation.signedOffsetM)
            + companionHalfWidthM
            + STRUCTURE_COMPANION_EDGE_MARGIN_M;
        if (relation.signedOffsetM >= 0) {
            offsets.leftM = Math.max(offsets.leftM, outerOffsetM);
        } else {
            offsets.rightM = Math.max(offsets.rightM, outerOffsetM);
        }
    }
    return offsets;
}

// A separately mapped bike/foot path often runs beside the carriageway on the
// same physical bridge. Enlarge only the side that contains that path: a
// symmetric enlargement leaves an uncovered concrete shelf on the other side.
// renderStructure=false keeps the companion from duplicating civil work.
export function roadStructureFormationOffsetsM(alignment, alignments, baseHalfWidthM) {
    return drainAlignmentSteps(roadStructureFormationOffsetsSteps(alignment, alignments, baseHalfWidthM));
}

function* roadStructureFormationOffsetsSteps(
    alignment,
    alignments,
    baseHalfWidthM, clock = null,
) {
    const baseM = Math.max(0, Number(baseHalfWidthM) || 0);
    const offsets = { leftM: baseM, rightM: baseM };
    if (!alignment || alignment.definition?.renderStructure === false) return offsets;
    for (const companion of Array.isArray(alignments) ? alignments : []) {
        if (clock?.expired()) { yield { phase: 'alignment-companion-envelope' }; clock.restart(); }
        const relations = yield* structuralCompanionEnvelopeRelationsSteps(
            alignment,
            companion, clock,
        );
        if (relations.length === 0) continue;
        const companionHalfWidthM = Number(companion.definition?.widthM) > 0
            ? Number(companion.definition.widthM) * 0.5
            : STRUCTURE_COMPANION_DEFAULT_HALF_WIDTH_M;
        for (const relation of relations) {
            const outerOffsetM = Math.abs(relation.signedOffsetM)
                + companionHalfWidthM
                + STRUCTURE_COMPANION_EDGE_MARGIN_M;
            if (relation.signedOffsetM >= 0) {
                offsets.leftM = Math.max(offsets.leftM, outerOffsetM);
            } else {
                offsets.rightM = Math.max(offsets.rightM, outerOffsetM);
            }
        }
    }
    return offsets;
}

// Return the physical sidewalk bands that the structural road must author
// when a separately mapped footway/cycleway shares its tunnel or bridge.
// The companion keeps supplying semantic/path data, while one structural
// owner emits the actual cross-section so no coplanar second deck can fight
// with the carriageway.
export function roadStructureCompanionSidewalkBandsM(
    roadHalfWidthM,
    formationOffsetsM,
    alignment,
    alignments = [],
) {
    const roadM = Math.max(0, finiteOrNull(roadHalfWidthM) ?? 0);
    const formationLeftM = Math.max(
        roadM,
        finiteOrNull(formationOffsetsM?.leftM) ?? roadM,
    );
    const formationRightM = Math.max(
        roadM,
        finiteOrNull(formationOffsetsM?.rightM) ?? roadM,
    );
    const sides = new Set();
    for (const companion of Array.isArray(alignments) ? alignments : []) {
        for (const relation of structuralCompanionEnvelopeRelations(
            alignment,
            companion,
        )) {
            sides.add(relation.signedOffsetM >= 0 ? 'left' : 'right');
        }
    }
    return [
        ...(sides.has('left') && formationLeftM - roadM >= 0.05
            ? [{
                side: 'left',
                leftOffsetM: formationLeftM,
                rightOffsetM: roadM,
            }]
            : []),
        ...(sides.has('right') && formationRightM - roadM >= 0.05
            ? [{
                side: 'right',
                leftOffsetM: -roadM,
                rightOffsetM: -formationRightM,
            }]
            : []),
    ];
}

// A bridge needs a continuous authored top outside the carriageway because
// independently buffered sidewalk/cycleway polygons can leave join wedges.
// Return only genuinely uncovered shoulder bands: never a full-width blanket
// across the asphalt, and never another surface underneath a companion path.
// Even a small profile mismatch between overlapping meshes becomes the large
// triangular paint shards seen from a grazing view.
export function roadStructureSidewalkBandsM(
    roadHalfWidthM,
    formationOffsetsM,
    alignment = null,
    alignments = [],
) {
    const roadM = Math.max(0, finiteOrNull(roadHalfWidthM) ?? 0);
    const formationLeftM = Math.max(
        roadM,
        finiteOrNull(formationOffsetsM?.leftM) ?? roadM,
    );
    const formationRightM = Math.max(
        roadM,
        finiteOrNull(formationOffsetsM?.rightM) ?? roadM,
    );
    let bands = [
        {
            side: 'left',
            leftOffsetM: formationLeftM,
            rightOffsetM: roadM,
        },
        {
            side: 'right',
            leftOffsetM: -roadM,
            rightOffsetM: -formationRightM,
        },
    ].filter(band => band.leftOffsetM - band.rightOffsetM >= 0.05);
    for (const companion of Array.isArray(alignments) ? alignments : []) {
        const relation = structuralCompanionRelation(alignment, companion);
        if (!relation) continue;
        const companionHalfWidthM = Number(companion.definition?.widthM) > 0
            ? Number(companion.definition.widthM) * 0.5
            : STRUCTURE_COMPANION_DEFAULT_HALF_WIDTH_M;
        const exclusionLeftM = relation.signedOffsetM + companionHalfWidthM;
        const exclusionRightM = relation.signedOffsetM - companionHalfWidthM;
        const nextBands = [];
        for (const band of bands) {
            if (exclusionLeftM <= band.rightOffsetM
                || exclusionRightM >= band.leftOffsetM) {
                nextBands.push(band);
                continue;
            }
            const higherBand = {
                ...band,
                rightOffsetM: Math.max(band.rightOffsetM, exclusionLeftM),
            };
            const lowerBand = {
                ...band,
                leftOffsetM: Math.min(band.leftOffsetM, exclusionRightM),
            };
            if (higherBand.leftOffsetM - higherBand.rightOffsetM >= 0.05) {
                nextBands.push(higherBand);
            }
            if (lowerBand.leftOffsetM - lowerBand.rightOffsetM >= 0.05) {
                nextBands.push(lowerBand);
            }
        }
        bands = nextBands;
    }
    return bands;
}

function* profileNodesSteps(definition, context) {
    const {
        clock, nearestAtLocal,
        points,
        cumulative,
        toLocal,
        terrainAtStation,
        absoluteToSceneY,
    } = context;
    const totalLengthM = cumulative[cumulative.length - 1];
    const sourceNodes = Array.isArray(definition.profile?.nodes)
        ? definition.profile.nodes
        : [];
    let nodes = [];
    for (const source of sourceNodes) {
        if (clock.expired()) { yield { phase: 'alignment-profile-nodes' }; clock.restart(); }
        const locator = source.at ?? source;
        const s = yield* stationForLocatorSteps(locator, points, cumulative, toLocal, clock, nearestAtLocal);
        if (!Number.isFinite(s)) continue;
        const elevationAslM = finiteOrNull(source.elevationAslM);
        const terrainOffsetM = finiteOrNull(source.terrainOffsetM);
        const offsetM = finiteOrNull(source.offsetM);
        let y = null;
        if (elevationAslM != null) {
            y = absoluteToSceneY(elevationAslM);
        } else if (terrainOffsetM != null) {
            y = terrainAtStation(s) + terrainOffsetM;
        } else if (offsetM != null) {
            y = terrainAtStation(s) + offsetM;
        }
        if (Number.isFinite(y)) nodes.push({ s, y });
    }
    nodes = yield* sortAlignmentSteps(nodes, (a, b) => a.s - b.s, clock, 'alignment-profile-sort');
    if (nodes.length === 0 || nodes[0].s > 1e-6) {
        const padded = [{ s: 0, y: terrainAtStation(0) }];
        for (const node of nodes) {
            if (clock.expired()) { yield { phase: 'alignment-profile-endpoints' }; clock.restart(); }
            padded.push(node);
        }
        nodes = padded;
    }
    if (nodes[nodes.length - 1].s < totalLengthM - 1e-6) {
        nodes.push({ s: totalLengthM, y: terrainAtStation(totalLengthM) });
    }
    return nodes;
}

function* profileYResolverSteps(definition, context) {
    const { profile = {}, kind } = definition;
    const {
        clock, nearestAtLocal,
        points,
        cumulative,
        toLocal,
        terrainAtStation,
        absoluteToSceneY,
    } = context;
    const totalLengthM = cumulative[cumulative.length - 1];
    const elevationAslM = finiteOrNull(profile.elevationAslM);

    if (profile.type === 'terrain-offset') {
        const offsetM = finiteOrNull(profile.offsetM)
            ?? (kind === 'underpass' ? DEFAULT_UNDERPASS_OFFSET_M : 0);
        return (stationM) => terrainAtStation(stationM) + offsetM;
    }

    if (profile.type === 'absolute' && elevationAslM != null) {
        const y = absoluteToSceneY(elevationAslM);
        return () => y;
    }

    if (profile.type === 'nodes') {
        const nodes = yield* profileNodesSteps(definition, context);
        const easing = profile.interpolation === 'smoothstep' ? smoothstep : (value => value);
        return (stationM) => {
            const s = Math.max(0, Math.min(totalLengthM, Number(stationM) || 0));
            let low = 1, high = nodes.length - 1;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (s <= nodes[middle].s) high = middle;
                else low = middle + 1;
            }
            const index = Math.max(0, low - 1);
            const a = nodes[index];
            const b = nodes[index + 1];
            const span = b.s - a.s;
            const t = span > 0 ? easing((s - a.s) / span) : 0;
            return linearInterpolate(a.y, b.y, t);
        };
    }

    const peakRange = profile.peakRange || {};
    const peakStartM = yield* stationForLocatorSteps(
        peakRange.start ?? { fraction: 0.45 },
        points,
        cumulative,
        toLocal, clock, nearestAtLocal
    );
    const peakEndM = yield* stationForLocatorSteps(
        peakRange.end ?? { fraction: 0.55 },
        points,
        cumulative,
        toLocal, clock, nearestAtLocal
    );
    const startM = Math.min(peakStartM ?? totalLengthM * 0.45, peakEndM ?? totalLengthM * 0.55);
    const endM = Math.max(peakStartM ?? totalLengthM * 0.45, peakEndM ?? totalLengthM * 0.55);
    const peakStationM = (startM + endM) * 0.5;
    const peakElevationAslM = finiteOrNull(profile.peakElevationAslM);
    const peakOffsetM = finiteOrNull(profile.peakOffsetM);
    let crossingPeakY = null;
    if (profile.type === 'crossing-clearance') {
        for (const crossing of Array.isArray(definition.crossings) ? definition.crossings : []) {
            if (clock.expired()) { yield { phase: 'alignment-crossing-clearance' }; clock.restart(); }
            const stationM = yield* stationForLocatorSteps({ coordinate: crossing?.coordinate }, points, cumulative, toLocal, clock, nearestAtLocal);
            const separationM = finiteOrNull(crossing?.requiredSurfaceSeparationM);
            if (stationM == null || separationM == null) continue;
            const y = terrainAtStation(stationM) + separationM;
            crossingPeakY = crossingPeakY == null ? y : Math.max(crossingPeakY, y);
        }
    }
    let peakY = null;
    if (crossingPeakY != null) {
        peakY = crossingPeakY;
    } else if (peakElevationAslM != null) {
        peakY = absoluteToSceneY(peakElevationAslM);
    } else if (peakOffsetM != null) {
        peakY = terrainAtStation(peakStationM) + peakOffsetM;
    } else {
        peakY = terrainAtStation(peakStationM)
            + (kind === 'underpass' ? DEFAULT_UNDERPASS_OFFSET_M : 0);
    }
    const approachRunout = profile.approachRunoutM;
    const startApproachRunoutM = Math.max(
        0,
        finiteOrNull(
            approachRunout && typeof approachRunout === 'object'
                ? approachRunout.start
                : approachRunout,
        ) ?? 0,
    );
    const endApproachRunoutM = Math.max(
        0,
        finiteOrNull(
            approachRunout && typeof approachRunout === 'object'
                ? approachRunout.end
                : approachRunout,
        ) ?? 0,
    );
    // A junction mouth touching an alignment end holds the bed at grade
    // through the mouth: the approach trace cannot continue past the junction
    // (its arms are other roads), so without this setback the grade ran right
    // to the node and the joining road met a sunken bed behind an earthwork
    // step instead of flat asphalt.
    const junctionGapRanges = Array.isArray(context.junctionGapRanges)
        ? context.junctionGapRanges
        : [];
    let startJunctionSetbackM = 0, endJunctionSetbackM = 0;
    for (const range of junctionGapRanges) {
        if (clock.expired()) { yield { phase: 'alignment-junction-setback' }; clock.restart(); }
        if (range.startM <= .5) startJunctionSetbackM = Math.max(startJunctionSetbackM, range.endM);
        if (range.endM >= totalLengthM - .5) endJunctionSetbackM = Math.max(endJunctionSetbackM, totalLengthM - range.startM);
    }
    let curveStartM = Math.min(
        startM,
        Math.max(startApproachRunoutM, startJunctionSetbackM),
    );
    let curveEndM = Math.max(
        endM,
        totalLengthM - Math.max(endApproachRunoutM, endJunctionSetbackM),
    );
    const permittedGrade = finiteOrNull(definition.maxGrade);
    if (permittedGrade != null && permittedGrade > 0) {
        curveStartM = (yield* gradeSafeApproachStationSteps({
            initialStationM: curveStartM,
            peakStationM: startM,
            outerStationM: startJunctionSetbackM,
            targetY: peakY,
            maxGrade: permittedGrade,
            sampleYAtStation: terrainAtStation,
        }, clock)) ?? startJunctionSetbackM;
        curveEndM = (yield* gradeSafeApproachStationSteps({
            initialStationM: curveEndM,
            peakStationM: endM,
            outerStationM: totalLengthM - endJunctionSetbackM,
            targetY: peakY,
            maxGrade: permittedGrade,
            sampleYAtStation: terrainAtStation,
        }, clock)) ?? totalLengthM - endJunctionSetbackM;
    }
    const curveStartY = terrainAtStation(curveStartM);
    const curveEndY = terrainAtStation(curveEndM);
    const overpassApproachY = (stationM, designY) => (
        kind === 'overpass'
            ? Math.max(designY, terrainAtStation(stationM))
            : designY
    );
    return (stationM) => {
        const s = Math.max(0, Math.min(totalLengthM, Number(stationM) || 0));
        if (s <= curveStartM) return terrainAtStation(s);
        if (s <= startM) {
            return overpassApproachY(
                s,
                linearInterpolate(
                    curveStartY,
                    peakY,
                    smoothstep(
                        (s - curveStartM)
                        / Math.max(1, startM - curveStartM),
                    ),
                ),
            );
        }
        if (s <= endM) return peakY;
        if (s <= curveEndM) {
            return overpassApproachY(
                s,
                linearInterpolate(
                    peakY,
                    curveEndY,
                    smoothstep(
                        (s - endM)
                        / Math.max(1, curveEndM - endM),
                    ),
                ),
            );
        }
        return terrainAtStation(s);
    };
}

function normalizeDefinition(definition, fallbackId) {
    if (!definition || !ROAD_VERTICAL_KINDS.has(definition.kind)) return null;
    const axis = Array.isArray(definition.axis)
        ? definition.axis.filter(finiteCoordinate).map(point => [Number(point[0]), Number(point[1])])
        : [];
    if (axis.length < 2) return null;
    const memberOsmIds = Array.from(new Set(
        (definition.memberOsmIds || [])
            .map(numericId)
            .filter(value => value != null),
    ));
    const structureOsmIds = Array.from(new Set(
        (
            definition.structureOsmIds
            ?? (memberOsmIds.length === 1 ? memberOsmIds : [])
        )
            .map(numericId)
            .filter(value => value != null),
    ));
    return {
        ...definition,
        id: String(definition.id || fallbackId),
        axis,
        memberOsmIds,
        structureOsmIds,
    };
}

function* compileDefinitionSteps(definition, {
    anchorLon,
    anchorLat,
    terrainSceneYAtLocal,
    absoluteToSceneY,
    sampleSpacingM, requireComplete = false, isPermanentGap = null,
}, clock) {
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * DEG_TO_RAD);
    const toLocal = ([lon, lat]) => ({
        x: (Number(lon) - anchorLon) * metresPerDegreeLon,
        z: -(Number(lat) - anchorLat) * metresPerDegreeLat,
    });
    const points = yield* mapAlignmentSteps(definition.axis, toLocal, clock, 'alignment-points');
    const cumulative = [0];
    for (let index = 1; index < points.length; index++) {
        if (clock.expired()) { yield { phase: 'alignment-stations' }; clock.restart(); }
        cumulative.push(cumulative[index - 1] + Math.hypot(
            points[index].x - points[index - 1].x,
            points[index].z - points[index - 1].z,
        ));
    }
    const totalLengthM = cumulative[cumulative.length - 1];
    if (totalLengthM < 0.05) return null;
    const nearestAtLocal = yield* createIndexedPolylineNearestSteps(points, cumulative, { preparation: clock });
    const terrainAt = (x, z) => finiteOrNull(terrainSceneYAtLocal?.(x, z));
    const terrainAtStation = (s) => {
        const point = pointAtStation(points, cumulative, s);
        return terrainAt(point.x, point.z);
    };
    // Every current road vertical profile uses terrain either for its grade,
    // its approach tie-in, its cover classification, or its supports. Do not
    // compile a plausible sea-level structure from an unloaded moving window;
    // the model's terrain revision will retry once these local samples exist.
    const readinessSamples = Math.max(2, Math.ceil(totalLengthM / sampleSpacingM));
    for (let index = 0; index <= readinessSamples; index += 1) {
        if (clock.expired()) { yield { phase: 'alignment-terrain-readiness' }; clock.restart(); }
        const station = totalLengthM * index / readinessSamples;
        if (terrainAtStation(station) === null) {
            // A pier or breakwater carries a real road over water the DGU grid
            // does not model, so its samples never arrive however often the
            // candidate is retried. Skip that alignment — the same outcome as
            // an uncompiled one — instead of rejecting the whole generation
            // and, with it, every other ground layer. See terrain-evidence-gap.
            const point = pointAtStation(points, cumulative, station);
            const permanent = typeof isPermanentGap === 'function' && isPermanentGap(point.x, point.z) === true;
            if (requireComplete && !permanent) {
                throw Object.assign(new Error(`Road alignment ${definition.id} lacks terrain evidence`),
                    { code: 'road-alignment-terrain-incomplete' });
            }
            return null;
        }
    }
    // Station spans where a side road joins the alignment. The companion
    // sidewalk, its curb, and the approach walls break over these mouths
    // (a real sidewalk yields at a junction), the side stays null when the
    // arm leaves along the axis, and a null side opens both bands. Computed
    // before the profile so an end-touching mouth can hold the bed at grade.
    const junctionRows = yield* mapAlignmentGeneratorSteps((Array.isArray(definition.junctions)
        ? definition.junctions
        : []), function* (junction) {
            if (!finiteCoordinate(junction?.coordinate)) return null;
            const local = toLocal(junction.coordinate);
            const nearest = yield* nearestAtLocal.prepareSteps(local.x, local.z, clock);
            // The junction node lies on the traced axis; a distant hit means
            // the definition no longer matches this axis.
            if (!nearest || nearest.distanceSquared > 4) return null;
            const segmentStart = points[nearest.segmentIndex];
            const segmentEnd = points[nearest.segmentIndex + 1];
            const tangentLengthM = Math.hypot(
                segmentEnd.x - segmentStart.x,
                segmentEnd.z - segmentStart.z,
            );
            if (tangentLengthM < 0.05) return null;
            const ux = (segmentEnd.x - segmentStart.x) / tangentLengthM;
            const uz = (segmentEnd.z - segmentStart.z) / tangentLengthM;
            let side = null;
            if (finiteCoordinate(junction.towardCoordinate)) {
                const toward = toLocal(junction.towardCoordinate);
                const normalDot = -uz * (toward.x - nearest.x)
                    + ux * (toward.z - nearest.z);
                if (Math.abs(normalDot) > 1e-6) {
                    side = normalDot >= 0 ? 'left' : 'right';
                }
            }
            const halfLengthM = Math.max(
                2.5,
                (finiteOrNull(junction.widthM) ?? 5.5) * 0.5,
            ) + JUNCTION_GAP_FILLET_M;
            return {
                startM: Math.max(0, nearest.s - halfLengthM),
                endM: Math.min(totalLengthM, nearest.s + halfLengthM),
                stationM: nearest.s,
                side,
                osmId: junction.osmId ?? null,
            };
        }, clock, 'alignment-junctions');
    const junctionGapRanges = yield* filterAlignmentSteps(junctionRows,
        range => range && range.endM - range.startM > .1, clock, 'alignment-junction-filter');
    const profileYAtS = yield* profileYResolverSteps(definition, {
        clock, nearestAtLocal,
        points,
        cumulative,
        toLocal,
        terrainAtStation,
        junctionGapRanges,
        absoluteToSceneY: (heightM) => {
            const value = Number(absoluteToSceneY?.(heightM));
            return Number.isFinite(value) ? value : Number(heightM);
        },
    });
    const structureRange = definition.structureRange || definition.profile?.peakRange || {};
    const rawStructureStartM = yield* stationForLocatorSteps(
        structureRange.start ?? { distanceM: 0 },
        points,
        cumulative,
        toLocal, clock, nearestAtLocal
    );
    const rawStructureEndM = yield* stationForLocatorSteps(
        structureRange.end ?? { distanceM: totalLengthM },
        points,
        cumulative,
        toLocal, clock, nearestAtLocal
    );
    const structureStartM = Math.min(
        rawStructureStartM ?? 0,
        rawStructureEndM ?? totalLengthM,
    );
    const structureEndM = Math.max(
        rawStructureStartM ?? 0,
        rawStructureEndM ?? totalLengthM,
    );
    const count = Math.max(2, Math.ceil(totalLengthM / sampleSpacingM));
    let sampleStationsM = [];
    for (let step = 0; step <= count; step++) {
        if (clock.expired()) { yield { phase: 'alignment-sample-stations' }; clock.restart(); }
        sampleStationsM.push(totalLengthM * step / count);
    }
    sampleStationsM.push(structureStartM, structureEndM);
    // Rows at junction edges retain exact opening widths between regular rows.
    for (const range of junctionGapRanges) {
        if (clock.expired()) { yield { phase: 'alignment-junction-stations' }; clock.restart(); }
        sampleStationsM.push(range.startM, range.endM);
    }
    sampleStationsM = yield* sortAlignmentSteps(sampleStationsM, (a,b)=>a-b, clock, 'alignment-station-sort');
    sampleStationsM = yield* filterAlignmentSteps(sampleStationsM,
        (stationM, index, stations) => index === 0 || Math.abs(stationM - stations[index-1]) > 1e-6,
        clock, 'alignment-station-dedup');
    const samples = yield* mapAlignmentSteps(sampleStationsM, (stationM) => {
        const point = pointAtStation(points, cumulative, stationM);
        return {
            ...point,
            y: profileYAtS(point.s),
            terrainY: terrainAt(point.x, point.z),
            structure: point.s >= structureStartM && point.s <= structureEndM,
        };
    }, clock, 'alignment-profile-samples');
    const borePortalOpenM = definition.structureMode === 'bored'
        ? yield* borePortalOpenLengthsSteps(definition, samples, structureStartM, structureEndM, clock)
        : null;
    const crossingRows = yield* mapAlignmentGeneratorSteps((Array.isArray(definition.crossings)
        ? definition.crossings
        : []), function* (crossing) {
            if (!finiteCoordinate(crossing?.coordinate)) return null;
            const crossingPoint = toLocal(crossing.coordinate);
            const crossingNearest = yield* nearestAtLocal.prepareSteps(
                crossingPoint.x,
                crossingPoint.z, clock,
            );
            const crossingStationM = crossingNearest?.s;
            const halfLengths = roadGradeSeparationCrossingClearHalfLengthsM(
                crossing,
                definition.kind,
            );
            if (!Number.isFinite(crossingStationM) || !halfLengths) return null;
            const roadStart = points[crossingNearest.segmentIndex];
            const roadEnd = points[crossingNearest.segmentIndex + 1];
            const roadDx = roadEnd.x - roadStart.x;
            const roadDz = roadEnd.z - roadStart.z;
            const roadLengthM = Math.hypot(roadDx, roadDz);
            if (roadLengthM < 0.05) return null;
            return {
                startM: Math.max(0, crossingStationM - halfLengths.beforeM),
                endM: Math.min(
                    totalLengthM,
                    crossingStationM + halfLengths.afterM,
                ),
                crossingStationM,
                crossingPoint: {
                    x: crossingNearest.x,
                    z: crossingNearest.z,
                },
                roadTangent: {
                    x: roadDx / roadLengthM,
                    z: roadDz / roadLengthM,
                },
                crossing,
            };
        }, clock, 'alignment-crossing-ranges');
    const crossingClearRanges = yield* filterAlignmentSteps(crossingRows, Boolean, clock, 'alignment-crossing-filter');
    return {
        id: definition.id,
        definition,
        kind: definition.kind,
        memberOsmIds: new Set(definition.memberOsmIds),
        structureOsmIds: new Set(definition.structureOsmIds),
        points,
        cumulative,
        totalLengthM,
        structureStartM,
        structureEndM,
        borePortalOpenM,
        crossingClearRanges,
        junctionGapRanges,
        samples,
        profileYAtS,
        // The approach envelope must use the same captured input as the
        // longitudinal profile and sample rows, including on reused alignments.
        terrainSceneYAtLocal: terrainAt,
        nearest: nearestAtLocal,
    };
}

export function roadStructureSupportClearanceAtLocal(
    alignment,
    roadFormation,
    x,
    z,
    { sweptEnvelopeMarginM = ROAD_SUPPORT_SWEPT_ENVELOPE_MARGIN_M } = {},
) {
    if (!alignment) return 1;
    let clearanceM = roadFormation?.surfaceAtLocal?.(
        Number(x),
        Number(z),
        alignment.memberOsmIds,
    ) ? -1 : 1;
    const nearest = alignment.nearest?.(Number(x), Number(z));
    if (!nearest) return clearanceM;
    const marginM = Math.max(0, Number(sweptEnvelopeMarginM) || 0);
    for (const range of alignment.crossingClearRanges || []) {
        const startM = Number(range.startM) - marginM;
        const endM = Number(range.endM) + marginM;
        if (!Number.isFinite(startM) || !Number.isFinite(endM)) continue;
        const rangeClearanceM = nearest.s <= startM
            ? startM - nearest.s
            : nearest.s >= endM
                ? nearest.s - endM
                : -Math.min(nearest.s - startM, endM - nearest.s);
        clearanceM = Math.min(clearanceM, rangeClearanceM);
    }
    return clearanceM;
}

function definitionFromFeature(feature, tileKey, featureIndex) {
    const properties = feature?.properties || {};
    const resolved = roadVerticalAlignmentFromProperties(properties);
    const coordinates = feature?.geometry?.type === 'LineString'
        ? feature.geometry.coordinates
        : null;
    if (!resolved || !Array.isArray(coordinates) || coordinates.length < 2) return null;
    const osmId = numericId(properties.osm_id);
    const explicit = properties.road_vertical_alignment
        ?? properties.vertical_alignment
        ?? properties.grade_separation;
    const details = explicit && typeof explicit === 'object' ? explicit : {};
    const osmEleM = Number.parseFloat(
        properties.ele ?? properties.tags?.ele ?? '',
    );
    const inferredProfile = Number.isFinite(osmEleM)
        ? {
            type: 'absolute',
            elevationAslM: osmEleM,
        }
        : resolved.kind === 'overpass'
            ? {
                type: 'relative-peak',
                peakOffsetM: isSurfaceOnlyHighway(properties)
                    ? DEFAULT_SURFACE_ONLY_OVERPASS_OFFSET_M
                    : DEFAULT_OVERPASS_OFFSET_M,
            }
            : {
                type: 'terrain-offset',
                offsetM: underpassDepthM(properties),
            };
    const widthM = finiteOrNull(details.widthM ?? properties.width_meters);
    const highway = properties.highway
        ?? properties.highway_type
        ?? properties.tags?.highway
        ?? null;
    return normalizeDefinition({
        ...details,
        id: details.id || `osm-${osmId ?? `${tileKey}-${featureIndex}`}`,
        kind: resolved.kind,
        memberOsmIds: details.memberOsmIds
            ?? (osmId == null ? [] : [osmId]),
        axis: coordinates,
        profile: details.profile || inferredProfile,
        structureRange: details.structureRange || {
            start: { distanceM: 0 },
            end: { fraction: 1 },
        },
        source: details.source || 'osm',
        widthM,
        osm: resolved.osm || null,
        // A separately mapped cycleway/footway on a parent bridge is only a
        // surface, not a duplicate deck. A path tagged as a tunnel is the
        // opposite: it owns the concrete box/roof beneath the upper road.
        renderStructure: details.renderStructure
            ?? (!SURFACE_ONLY_HIGHWAYS.has(String(highway || ''))
                || (resolved.kind === 'underpass'
                    && isIndependentSurfaceTunnel(properties))),
    }, `osm-${tileKey}-${featureIndex}`);
}

function definitionFromStoredFeature(feature, tileKey, featureIndex) {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.type === 'LineString'
        ? feature.geometry.coordinates
        : null;
    if (!ROAD_VERTICAL_KINDS.has(properties.kind)
        || !Array.isArray(coordinates)
        || coordinates.length < 2) return null;
    return normalizeDefinition({
        id: properties.id || `stored-${tileKey}-${featureIndex}`,
        locationId: properties.city || null,
        name: properties.name || null,
        kind: properties.kind,
        memberOsmIds: properties.member_osm_ids || properties.memberOsmIds || [],
        axis: coordinates,
        profile: properties.profile || { type: 'relative-peak' },
        crossings: Array.isArray(properties.crossings)
            ? properties.crossings
            : [],
        structureRange: properties.structure_range || properties.structureRange || null,
        corridorHalfWidthM: properties.corridor_half_width_m
            ?? properties.corridorHalfWidthM
            ?? null,
        replaceRoadSurface: properties.replace_road_surface
            ?? properties.replaceRoadSurface
            ?? false,
        renderStructure: properties.render_structure
            ?? properties.renderStructure
            ?? true,
        crossSection: properties.cross_section || properties.crossSection || null,
        source: properties.source || 'authored',
    }, `stored-${tileKey}-${featureIndex}`);
}

function stableSerialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function definitionLocalBounds(definition, anchorLon, anchorLat) {
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * DEG_TO_RAD);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const [lon, lat] of definition.axis || []) {
        const x = (Number(lon) - anchorLon) * metresPerDegreeLon;
        const z = -(Number(lat) - anchorLat) * metresPerDegreeLat;
        minX = Math.min(minX, x);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(minX)) return null;
    const paddingM = Math.max(DEFAULT_CORRIDOR_HALF_WIDTH_M,
        Number(definition.corridorHalfWidthM) || 0,
        Number(definition.crossSection?.formationHalfWidthM) || 0,
        Number(definition.crossSection?.terrainClearHalfWidthM) || 0);
    return {
        minX: minX - paddingM,
        minZ: minZ - paddingM,
        maxX: maxX + paddingM,
        maxZ: maxZ + paddingM,
    };
}

export function roadReplacementFormationBlend(alignment, sample) {
    if (alignment?.kind !== 'underpass'
        || !alignment?.definition?.replaceRoadSurface
        || !alignment?.definition?.replacementCarriagewayOnly) {
        return 1;
    }
    const terrainY = Number(sample?.terrainY);
    const roadY = Number(sample?.y);
    if (!Number.isFinite(terrainY) || !Number.isFinite(roadY)) return 1;
    return smoothstep(
        Math.max(0, terrainY - roadY)
        / SYNTHESIZED_UNDERPASS_FULL_FORMATION_DEPTH_M,
    );
}

// The fill above a covered box exists only where the ground actually clears
// the roof. A structure sample shallower than that is an OPEN trench — the
// grade runouts legitimately descend INSIDE the tagged tunnel span, so the
// tagged structure range alone must never decide what is buried (keying on
// it roofed the shallow ends of Zagrebačka avenija's ramps with grass).
export function isBuriedStructureSample(sample, clearHeightM, roofDepthM) {
    if (!sample?.structure) return false;
    // finiteOrNull, not Number(): a null terrain sample must stay ABSENT —
    // Number(null) is 0, which would read as sea-level ground over the road.
    const terrainY = finiteOrNull(sample?.terrainY);
    const roadY = finiteOrNull(sample?.y);
    if (terrainY == null || roadY == null) return false;
    return terrainY - (roadY + Number(clearHeightM) + Number(roofDepthM)) >= -0.05;
}

// Rail's portal convention, applied to ROAD bores (rail-formation.js: "a bored
// tunnel keeps its hill, but the terrain is carved for a short cut-and-cover
// MOUTH at each portal"): inside a bore the covered span is decided by
// STATION — a bounded mouth at each end, everything deeper covered — never by
// measured cover alone, which let shallow portal cover keep carving past the
// Divulje mouth (a ragged opening no wall set closes) and would open a hole
// over any mid-bore saddle. The mouth lengths themselves come from
// alignment.borePortalOpenM (carve until the hill swallows the box, clamped
// to [carve, cap]). Non-bored underpasses keep the cover-based test — their
// runouts genuinely descend inside the tagged span.
export function isCoveredStructureSample(alignment, sample, clearHeightM, roofDepthM) {
    if (alignment?.definition?.structureMode === 'bored') {
        if (!sample?.structure) return false;
        const stationM = finiteOrNull(sample?.s);
        if (stationM == null) return false;
        const open = alignment.borePortalOpenM || {};
        const startOpenM = finiteOrNull(open.startM) ?? ROAD_TUNNEL_PORTAL_CARVE_M;
        const endOpenM = finiteOrNull(open.endM) ?? ROAD_TUNNEL_PORTAL_CARVE_M;
        return stationM - alignment.structureStartM >= startOpenM
            && alignment.structureEndM - stationM >= endOpenM;
    }
    return isBuriedStructureSample(sample, clearHeightM, roofDepthM);
}

// How far each mouth of a bore stays an open cut: from the portal to the
// first sample the hill fully buries (clear height + roof), clamped between
// the fixed portal carve and its cap (see ROAD_TUNNEL_PORTAL_CARVE_MAX_M).
function* borePortalOpenLengthsSteps(definition, samples, structureStartM, structureEndM, clock) {
    const clearHeightM = finiteOrNull(definition.clearHeightM)
        ?? DEFAULT_UNDERPASS_CLEAR_HEIGHT_M;
    const roofDepthM = finiteOrNull(definition.roofDepthM)
        ?? DEFAULT_UNDERPASS_ROOF_DEPTH_M;
    const portalEnds = definition.borePortalOpenEnds || {};
    const portalCarveM = Math.max(
        0,
        finiteOrNull(definition.borePortalCarveM)
            ?? ROAD_TUNNEL_PORTAL_CARVE_M,
    );
    const portalCarveMaxM = Math.max(
        portalCarveM,
        finiteOrNull(definition.borePortalCarveMaxM)
            ?? ROAD_TUNNEL_PORTAL_CARVE_MAX_M,
    );
    const clamp = (value) => Math.min(
        portalCarveMaxM,
        Math.max(portalCarveM, value),
    );
    const structureSamples = yield* filterAlignmentSteps(samples, sample => sample.structure, clock, 'alignment-bore-rows');
    const buried = (sample) => isBuriedStructureSample(sample, clearHeightM, roofDepthM);
    let startM = 0;
    if (portalEnds.start !== false) {
        startM = portalCarveMaxM;
        for (const sample of structureSamples) {
            if (clock.expired()) { yield { phase: 'alignment-bore-mouth' }; clock.restart(); }
            if (buried(sample)) {
                startM = sample.s - structureStartM;
                break;
            }
        }
    }
    let endM = 0;
    if (portalEnds.end !== false) {
        endM = portalCarveMaxM;
        for (let index = structureSamples.length - 1; index >= 0; index--) {
            if (clock.expired()) { yield { phase: 'alignment-bore-mouth' }; clock.restart(); }
            if (buried(structureSamples[index])) {
                endM = structureEndM - structureSamples[index].s;
                break;
            }
        }
    }
    return {
        startM: portalEnds.start === false ? 0 : clamp(startM),
        endM: portalEnds.end === false ? 0 : clamp(endM),
    };
}

// Contiguous open (not-buried) stretches of an alignment profile, each
// extended by the adjoining buried boundary sample so the cutout meets the
// portal face exactly (the approach walls run one segment further than the
// last open sample). Each run needs at least two samples to form a ribbon.
function* contiguousOpenSampleRunsSteps(samples, keepsTerrain, clock) {
    const list = Array.isArray(samples) ? samples : [];
    const runs = [];
    let run = [];
    for (let index = 0; index < list.length; index++) {
        if (clock.expired()) { yield { phase: 'alignment-opening-runs' }; clock.restart(); }
        const sample = list[index];
        if (keepsTerrain(sample)) {
            if (run.length > 0) {
                run.push(sample);
                if (run.length >= 2) runs.push(run);
            }
            run = [];
            continue;
        }
        if (run.length === 0 && index > 0 && keepsTerrain(list[index - 1])) {
            run.push(list[index - 1]);
        }
        run.push(sample);
    }
    if (run.length >= 2) runs.push(run);
    return runs;
}

// A replacement surface can ask terrain to get out of its way only where the
// terrain actually intersects that surface from above. If the replacement is
// already above the DTM, opening the DTM creates a literal void beneath a
// floating road/sidewalk and violates the backstop invariant: no opaque civil
// surface replaces the deleted hillside. Keep a small tolerance so coincident
// portal rows do not oscillate between cut and retained terrain.
export function roadReplacementRequiresTerrainOpening(sample) {
    const terrainY = finiteOrNull(sample?.terrainY);
    const roadY = finiteOrNull(sample?.y);
    return terrainY != null && roadY != null
        && terrainY - roadY > ALIGNMENT_ENDPOINT_PLANE_EPS_M;
}

function* alignmentRibbonRingSteps(samples, halfWidthM, clock, alignmentSamples) {
    const safeSamples = Array.isArray(samples) ? samples : [];
    const widthAt = typeof halfWidthM === 'function'
        ? halfWidthM
        : (() => halfWidthM);
    if (safeSamples.length < 2) return [];
    // A clipped run still uses its full alignment's boundary frame. Rotating
    // the last row toward only its previous neighbour cuts beyond the wall.
    const firstIndex = lowerSampleIndex(alignmentSamples, safeSamples[0].s);
    const left = [];
    const right = [];
    for (let index = 0; index < safeSamples.length; index++) {
        if (clock.expired()) { yield { phase: 'alignment-ribbon' }; clock.restart(); }
        const sample = safeSamples[index];
        const width = typeof halfWidthM === 'function'
            ? yield* widthAt(sample, index, safeSamples) : halfWidthM;
        const leftWidthM = Number(width?.leftM ?? width);
        const rightWidthM = Number(width?.rightM ?? width);
        if (!Number.isFinite(leftWidthM) || leftWidthM <= 0
            || !Number.isFinite(rightWidthM) || rightWidthM <= 0) {
            return [];
        }
        const { nx, nz } = roadStructureSampleFrame(alignmentSamples, firstIndex + index);
        left.push({
            x: sample.x + nx * leftWidthM,
            z: sample.z + nz * leftWidthM,
        });
        right.push({
            x: sample.x - nx * rightWidthM,
            z: sample.z - nz * rightWidthM,
        });
    }
    for (let index = right.length - 1; index >= 0; index--) {
        if (clock.expired()) { yield { phase: 'alignment-ribbon-ring' }; clock.restart(); }
        left.push(right[index]);
    }
    return left;
}

function* localRingBoundsSteps(ring, clock) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    for (const point of ring) {
        if (clock.expired()) { yield { phase: 'alignment-ring-bounds' }; clock.restart(); }
        bounds.minX = Math.min(bounds.minX, point.x); bounds.minZ = Math.min(bounds.minZ, point.z);
        bounds.maxX = Math.max(bounds.maxX, point.x); bounds.maxZ = Math.max(bounds.maxZ, point.z);
    }
    return bounds;
}

function boundsOverlap(left, right) {
    if (!left || !right) return false;
    const values = [
        left.minX, left.minZ, left.maxX, left.maxZ,
        right.minX, right.minZ, right.maxX, right.maxZ,
    ].map(Number);
    if (!values.every(Number.isFinite)) return false;
    return values[0] < values[6]
        && values[2] > values[4]
        && values[1] < values[7]
        && values[3] > values[5];
}

// A permanent authored landmark may replace one automatically generated OSM
// portal. Select that portal by alignment id + overlap, then retain source
// terrain instead of also opening the generic (often much wider) approach
// trench. Clear/restoration regions and the alignment's other portal remain.
// The replacement has to opt into the same explicit ready fact used by the
// surface hierarchy; an unpublished landmark can never suppress a backstop.
export function filterReplacementTerrainCutoutsForAuthoredPortals(
    regions,
    replacements,
) {
    const ready = (Array.isArray(replacements) ? replacements : []).filter(entry => (
        entry?.replacementBackstopReady === true
        && entry.alignmentId != null
        && entry.selectionBounds
    ));
    if (ready.length === 0) return Array.isArray(regions) ? regions : [];
    return (Array.isArray(regions) ? regions : []).filter((region) => {
        if (!region?.cutoutBounds) return true;
        return !ready.some(replacement => (
            String(replacement.alignmentId) === String(region.alignmentId)
            && boundsOverlap(replacement.selectionBounds, region.cutoutBounds)
        ));
    });
}

// Build into detached collections: a failed profile or cutout cannot leave a
// partially replaced query generation in the active alignment model.
function* compileRoadAlignmentGenerationSteps(definitions, options, compile, clock) {
    const compiled = [];
    for (const definition of definitions) {
        if (clock.expired()) { yield { phase: 'alignment-definitions' }; clock.restart(); }
        const alignment = yield* compile(definition, options, clock);
        if (alignment) compiled.push(alignment);
    }
    const byOsmId = new Map();
    for (const alignment of compiled) {
        for (const osmId of alignment.memberOsmIds) {
            if (clock.expired()) { yield { phase: 'alignment-osm-index' }; clock.restart(); }
            if (!byOsmId.has(osmId)) byOsmId.set(osmId, alignment);
        }
    }
    const profileOwnerByAlignment = new Map();
    const structuralAlignments = yield* filterAlignmentSteps(compiled,
        alignment => alignment.definition?.renderStructure !== false, clock, 'alignment-structure-filter',
    );
    for (const companion of compiled) {
        if (clock.expired()) { yield { phase: 'alignment-companions' }; clock.restart(); }
        if (companion.definition?.renderStructure !== false) continue;
        let best = null;
        for (const owner of structuralAlignments) {
            if (clock.expired()) { yield { phase: 'alignment-companion-owners' }; clock.restart(); }
            const relation = yield* structuralCompanionRelationSteps(owner, companion, clock);
            if (!relation || (best && relation.distanceM >= best.distanceM)) continue;
            best = { owner, distanceM: relation.distanceM };
        }
        if (best) profileOwnerByAlignment.set(companion, best.owner);
    }
    const replacementTerrainCutoutRegions = [];
    for (const alignment of compiled) {
        if (clock.expired()) { yield { phase: 'alignment-cutout-definitions' }; clock.restart(); }
        if (alignment.kind !== 'underpass' || alignment.definition.renderStructure === false
            || !alignment.definition.replaceRoadSurface) continue;
        const crossSection = alignment.definition.crossSection || {};
        const { roadHalfWidthM, formationHalfWidthM } = roadStructureHalfWidths(alignment);
        const clearHalfWidthM = Number(crossSection.terrainClearHalfWidthM)
            || formationHalfWidthM + SYNTHESIZED_UNDERPASS_TERRAIN_CLEAR_MARGIN_M;
        const cutoutHalfWidthM = Number(crossSection.terrainCutoutHalfWidthM)
            || formationHalfWidthM;
        const formationOffsetsM = yield* roadStructureFormationOffsetsSteps(
            alignment,
            compiled,
            formationHalfWidthM, clock,
        );
        // The visible replacement surface can stop at the physical
        // tunnel while the same structure's retaining walls continue
        // through both ramps. Keep the terrain opening under that
        // complete tapered wall envelope; clipping it to the tunnel
        // range leaves each approach wall embedded in live terrain.
        const replacementSamples = alignment.samples;
        const clearMarginM = Math.max(
            0,
            clearHalfWidthM - formationHalfWidthM,
        );
        const cutoutMarginM = Math.max(
            0,
            cutoutHalfWidthM - formationHalfWidthM,
        );
        const cutoutOffsetsAtSample = function* (sample) {
            const blend = roadReplacementFormationBlend(
                alignment,
                sample,
            );
            const rowFormationOffsetsM =
                yield* roadStructureFormationOffsetsAtSampleSteps(
                    alignment,
                    compiled,
                    {
                        leftM: linearInterpolate(
                            roadHalfWidthM,
                            formationOffsetsM.leftM,
                            blend,
                        ),
                        rightM: linearInterpolate(
                            roadHalfWidthM,
                            formationOffsetsM.rightM,
                            blend,
                        ),
                    },
                    sample, clock,
                );
            return {
                leftM: rowFormationOffsetsM.leftM + cutoutMarginM,
                rightM: rowFormationOffsetsM.rightM + cutoutMarginM,
            };
        };
        // An open cut opens terrain only where terrain intersects its
        // floor. A COVERED box additionally keeps the ground over its
        // tunnel: only the intersecting stretches NOT buried under
        // the roof are cut open (exactly where the approach walls
        // run). A road above terrain is never permission to delete
        // the hillside below it.
        const fillClearHeightM = Number(alignment.definition.clearHeightM)
            || DEFAULT_UNDERPASS_CLEAR_HEIGHT_M;
        const fillRoofDepthM = Number(alignment.definition.roofDepthM)
            || DEFAULT_UNDERPASS_ROOF_DEPTH_M;
        const openCut = alignment.definition.structureMode === 'open-cut';
        const cutoutStretches = yield* contiguousOpenSampleRunsSteps(
            replacementSamples,
            (sample) => (
                !roadReplacementRequiresTerrainOpening(sample)
                || !openCut && isCoveredStructureSample(
                    alignment,
                    sample,
                    fillClearHeightM,
                    fillRoofDepthM,
                )
            ), clock,
        );
        // The protective reset exists to cancel fragmented member
        // buffer cuts where the SOLVED cross-section owns the ground:
        // the deep trench and the fill over the box. A near-grade
        // approach stretch belongs to the REAL road — blanking its
        // much wider surface cuts there painted grass across the
        // carriageways beyond the Zagrebačka avenija portals.
        const deepEnough = (sample) => {
            const terrainY = finiteOrNull(sample?.terrainY);
            const roadY = finiteOrNull(sample?.y);
            return terrainY != null && roadY != null
                && terrainY - roadY
                    >= SYNTHESIZED_UNDERPASS_FULL_FORMATION_DEPTH_M;
        };
        const clearStretches = yield* contiguousOpenSampleRunsSteps(
            replacementSamples,
            (sample) => !deepEnough(sample), clock,
        );
        for (const stretch of clearStretches) {
            const clearRing = yield* alignmentRibbonRingSteps(stretch, {
                leftM: formationOffsetsM.leftM + clearMarginM,
                rightM: formationOffsetsM.rightM + clearMarginM,
            }, clock, alignment.samples);
            const clearBounds = yield* localRingBoundsSteps(clearRing, clock);
            if (clearBounds) replacementTerrainCutoutRegions.push({ alignmentId: alignment.id,
                clearRing, clearBounds, cutoutRing: null, cutoutBounds: null });
        }
        for (const stretch of cutoutStretches) {
            const cutoutRing = yield* alignmentRibbonRingSteps(stretch, cutoutOffsetsAtSample, clock, alignment.samples);
            const cutoutBounds = yield* localRingBoundsSteps(cutoutRing, clock);
            if (cutoutBounds) replacementTerrainCutoutRegions.push({ alignmentId: alignment.id,
                clearRing: null, clearBounds: null, cutoutRing, cutoutBounds });
        }
    }
    return { compiled, byOsmId, profileOwnerByAlignment, replacementTerrainCutoutRegions };
}

export class RoadVerticalAlignmentModel {
    constructor({
        anchorLon,
        anchorLat,
        terrainSceneYAtLocal,
        absoluteToSceneY = null,
        anchorElevationAslM = null,
        definitions = [],
        locationId = null,
        sampleSpacingM = DEFAULT_SAMPLE_SPACING_M,
        authoredPortalReplacements = null,
        captureTerrainSnapshot = null,
    } = {}) {
        if (captureTerrainSnapshot != null && typeof captureTerrainSnapshot !== 'function') {
            throw new TypeError('captureTerrainSnapshot must be a function');
        }
        this.captureTerrainSnapshot = captureTerrainSnapshot;
        this._publishedInputs = null;
        this._publicationManaged = false;
        this._publicationOwner = null;
        this.publishedRevision = 0;
        this._disposed = false;
        this._compiledCache = new Map();
        this._terrainDirtyIds = new Set();
        this.anchorLon = Number(anchorLon);
        this.anchorLat = Number(anchorLat);
        this.locationId = locationId == null ? null : String(locationId);
        this.terrainSceneYAtLocal = typeof terrainSceneYAtLocal === 'function'
            ? terrainSceneYAtLocal
            : (() => 0);
        this.absoluteToSceneY = typeof absoluteToSceneY === 'function'
            ? absoluteToSceneY
            : (value => Number(value));
        this.anchorElevationAslM = finiteOrNull(anchorElevationAslM);
        this.sampleSpacingM = Math.max(1, Number(sampleSpacingM) || DEFAULT_SAMPLE_SPACING_M);
        this.authoredPortalReplacements = typeof authoredPortalReplacements === 'function'
            ? authoredPortalReplacements
            : (() => authoredPortalReplacements || []);
        this.centerlineTiles = new Map();
        this.alignmentTiles = new Map();
        this._centerlineDefinitionsByTile = new Map();
        this._alignmentDefinitionsByTile = new Map();
        this._snapshotByDefinition = new WeakMap();
        this.revision = 0;
        this._authoredDefinitions = definitions
            .filter(entry => !entry.locationId || String(entry.locationId) === this.locationId)
            .map((entry, index) => normalizeDefinition(entry, `authored-${index}`))
            .filter(Boolean);
        this._dirty = true;
        this._compiled = [];
        this._byOsmId = new Map();
        this._profileOwnerByAlignment = new Map();
        this._alignmentChanges = [];
        // Keep one committed definition generation. Tile mutations normalize
        // their own inputs; diffing and compilation share the resulting set.
        // Compiled profiles are reused only with an explicit captured terrain
        // provider and unchanged local terrain/definition dependencies.
        this._definitions = this._collectDefinitions();
        this._definitionState = this._definitionSnapshot(this._definitions);
    }

    _collectDefinitions() {
        const storedById = new Map();
        for (const tileDefinitions of this._alignmentDefinitionsByTile.values()) {
            for (const definition of tileDefinitions) {
                if (definition && !storedById.has(definition.id)) {
                    storedById.set(definition.id, definition);
                }
            }
        }
        const storedDefinitions = Array.from(storedById.values());
        const storedIds = new Set(storedDefinitions.map(entry => entry.id));
        // Database-authored rows supersede the shipped bootstrap entry once an
        // alignment with the same stable id has been persisted.
        const definitions = [
            ...storedDefinitions,
            ...this._authoredDefinitions.filter(entry => !storedIds.has(entry.id)),
        ];
        const authoredOsmIds = new Set(definitions.flatMap(entry => entry.memberOsmIds));
        const seenDynamicIds = new Set();
        for (const tileDefinitions of this._centerlineDefinitionsByTile.values()) {
            for (const { osmId, definition } of tileDefinitions) {
                if (osmId != null && (authoredOsmIds.has(osmId) || seenDynamicIds.has(osmId))) {
                    continue;
                }
                if (!definition) continue;
                definitions.push(definition);
                if (osmId != null) seenDynamicIds.add(osmId);
            }
        }
        return definitions;
    }

    _definitionSnapshot(definitions) {
        const snapshot = new Map();
        for (const definition of definitions) {
            let entry = this._snapshotByDefinition.get(definition);
            if (!entry) {
                entry = {
                    signature: stableSerialize(definition),
                    bounds: definitionLocalBounds(definition, this.anchorLon, this.anchorLat),
                    osmIds: definition.memberOsmIds,
                };
                this._snapshotByDefinition.set(definition, entry);
            }
            snapshot.set(definition.id, entry);
        }
        return snapshot;
    }

    _mutateTiles(mutate) {
        const before = this._definitionState;
        mutate();
        const definitions = this._collectDefinitions();
        const after = this._definitionSnapshot(definitions);
        // Even a no-op may replace the winning source tile with an identical
        // duplicate. Commit its input ownership without churning the revision.
        this._definitions = definitions;
        this._definitionState = after;
        const changedIds = new Set([...before.keys(), ...after.keys()]);
        const bounds = [];
        const osmIds = new Set();
        let changed = false;
        for (const id of changedIds) {
            const previous = before.get(id);
            const next = after.get(id);
            if (previous?.signature === next?.signature) continue;
            changed = true;
            if (previous?.bounds) bounds.push({ ...previous.bounds });
            if (next?.bounds) bounds.push({ ...next.bounds });
            for (const osmId of previous?.osmIds || []) osmIds.add(osmId);
            for (const osmId of next?.osmIds || []) osmIds.add(osmId);
        }
        if (!changed) {
            return {
                changed: false,
                revision: this.revision,
                bounds: [],
                ids: [],
                osmIds: [],
            };
        }
        this.revision += 1;
        this._dirty = true;
        const change = {
            changed: true,
            revision: this.revision,
            bounds,
            ids: Array.from(changedIds).filter(id => (
                before.get(id)?.signature !== after.get(id)?.signature
            )),
            osmIds: Array.from(osmIds),
        };
        this._alignmentChanges.push({
            revision: this.revision,
            bounds: bounds.map(entry => ({ ...entry })),
            ids: [...change.ids],
        });
        if (this._alignmentChanges.length > ALIGNMENT_CHANGE_HISTORY_LIMIT) {
            this._alignmentChanges.splice(
                0,
                this._alignmentChanges.length - ALIGNMENT_CHANGE_HISTORY_LIMIT,
            );
        }
        return change;
    }

    setCenterlineTile(tileKey, features) {
        const key = String(tileKey);
        const relevant = (Array.isArray(features) ? features : []).filter(feature => (
            feature?.geometry?.type === 'LineString'
            && roadVerticalAlignmentFromProperties(feature?.properties || {})
        ));
        const definitions = relevant.map((feature, index) => ({
            osmId: numericId(feature?.properties?.osm_id),
            definition: definitionFromFeature(feature, key, index),
        }));
        return this._mutateTiles(() => {
            this.centerlineTiles.set(key, relevant);
            this._centerlineDefinitionsByTile.set(key, definitions);
        });
    }

    removeCenterlineTile(tileKey) {
        if (!this.centerlineTiles.has(String(tileKey))) {
            return {
                changed: false,
                revision: this.revision,
                bounds: [],
                ids: [],
                osmIds: [],
            };
        }
        return this._mutateTiles(() => {
            this.centerlineTiles.delete(String(tileKey));
            this._centerlineDefinitionsByTile.delete(String(tileKey));
        });
    }

    setAlignmentTile(tileKey, features) {
        const key = String(tileKey);
        const relevant = (Array.isArray(features) ? features : []).filter(feature => (
            feature?.geometry?.type === 'LineString'
            && ROAD_VERTICAL_KINDS.has(feature?.properties?.kind)
        ));
        const definitions = relevant.map((feature, index) => (
            definitionFromStoredFeature(feature, key, index)
        ));
        return this._mutateTiles(() => {
            this.alignmentTiles.set(key, relevant);
            this._alignmentDefinitionsByTile.set(key, definitions);
        });
    }

    removeAlignmentTile(tileKey) {
        if (!this.alignmentTiles.has(String(tileKey))) {
            return {
                changed: false,
                revision: this.revision,
                bounds: [],
                ids: [],
                osmIds: [],
            };
        }
        return this._mutateTiles(() => {
            this.alignmentTiles.delete(String(tileKey));
            this._alignmentDefinitionsByTile.delete(String(tileKey));
        });
    }

    clear() {
        if (this.centerlineTiles.size === 0 && this.alignmentTiles.size === 0) return;
        this._mutateTiles(() => {
            this.centerlineTiles.clear();
            this.alignmentTiles.clear();
            this._centerlineDefinitionsByTile.clear();
            this._alignmentDefinitionsByTile.clear();
        });
    }

    dispose() {
        if (this._disposed) return false;
        this._publicationOwner?.cancel();
        this._publishedInputs?.release();
        this._publishedInputs = null;
        this._compiledCache.clear();
        this._disposed = true;
        return true;
    }

    captureBuildInputs(owner) {
        this._ensureBuilt();
        if (!this._publishedInputs?.terrainCaptured) throw new Error('Road alignment build requires captured terrain');
        return ownReadSnapshot({ revision: this.publishedRevision, alignments: this._compiled },
            [this._publishedInputs.retain(owner)]);
    }

    getChangesSince(revision) {
        const since = Number(revision);
        if (!Number.isInteger(since) || since < 0 || since > this.revision) {
            return { revision: this.revision, full: true, bounds: [], ids: [] };
        }
        if (since === this.revision) {
            return { revision: this.revision, full: false, bounds: [], ids: [] };
        }
        const changes = this._alignmentChanges.filter(change => change.revision > since);
        if (changes.length === 0 || changes[0].revision !== since + 1) {
            return { revision: this.revision, full: true, bounds: [], ids: [] };
        }
        return {
            revision: this.revision,
            full: false,
            bounds: changes.flatMap(change => (
                change.bounds.map(entry => ({ ...entry }))
            )),
            ids: Array.from(new Set(changes.flatMap(change => change.ids || []))),
        };
    }

    _ensureBuilt() {
        if (this._disposed) throw new Error('Road alignments are disposed');
        if (!this._dirty || this._publicationManaged) return;
        const previousInputs = this._publishedInputs;
        Object.assign(this, drainAlignmentSteps(this._buildGenerationSteps()));
        previousInputs?.release();
    }

    *_buildGenerationSteps({ terrainRead = null, now, isCurrent = () => true, requireComplete = false,
        isPermanentGap = null } = {}) {
        const terrain = terrainRead ? retainReadSnapshot(terrainRead, 'road-alignment-preparation')
            : this.captureTerrainSnapshot?.() || null;
        const definitions = this._definitions, definitionState = this._definitionState;
        const previousCache = this._compiledCache, terrainDirtyIds = this._terrainDirtyIds;
        const revision = this.revision;
        const clock = alignmentPreparationClock({ now, isCurrent });
        const reads = [];
        const nextReads = new Map();
        let handedOff = false;
        try {
            if ((terrainRead || this.captureTerrainSnapshot) && (!Object.isFrozen(terrain)
                || !['station3d-terrain-read-snapshot-v1', 'station3d-ground-read-snapshot-v1'].includes(terrain?.contract)
                || typeof terrain.evidenceSceneYAtLocal !== 'function'
                || typeof terrain.absoluteToSceneY !== 'function')) {
                throw new TypeError('Road alignments require a captured terrain sampler');
            }
            const terrainSceneYAtLocal = terrain
                ? (x, z) => terrain.evidenceSceneYAtLocal(x, z)
                : this.terrainSceneYAtLocal;
            const absoluteToSceneY = terrain
                ? heightM => terrain.absoluteToSceneY(heightM)
                : this.absoluteToSceneY;
            const nextCache = new Map();
            const generation = yield* compileRoadAlignmentGenerationSteps(definitions, {
                anchorLon: this.anchorLon,
                anchorLat: this.anchorLat,
                terrainSceneYAtLocal,
                absoluteToSceneY,
                sampleSpacingM: this.sampleSpacingM, requireComplete, isPermanentGap,
            }, function* (definition, options) {
                const signature = definitionState.get(definition.id)?.signature;
                const previous = previousCache.get(definition.id);
                const reusable = terrain && previous?.alignment && previous.signature === signature
                    && !terrainDirtyIds.has(definition.id);
                const alignment = reusable ? previous.alignment : yield* compileDefinitionSteps(definition, options, clock);
                // Reused analytic profiles still close over their original
                // sampler. Retain each distinct sampler once for this generation.
                const sourceRead = alignment ? (reusable ? previous.read : terrain) : null;
                if (sourceRead && !nextReads.has(sourceRead)) {
                    const read = retainReadSnapshot(sourceRead, 'road-alignment-cache');
                    nextReads.set(sourceRead, read); reads.push(read);
                }
                nextCache.set(definition.id, { signature, alignment, read: nextReads.get(sourceRead) || null });
                return alignment;
            }, clock);
            clock.expired();
            const state = {
                _compiled: generation.compiled, _byOsmId: generation.byOsmId,
                _profileOwnerByAlignment: generation.profileOwnerByAlignment,
                _replacementTerrainCutoutRegions: generation.replacementTerrainCutoutRegions,
                _publishedInputs: ownReadSnapshot({ terrainCaptured: !!terrain }, reads),
                _compiledCache: nextCache, _terrainDirtyIds: new Set(), _dirty: false,
                publishedRevision: revision,
            };
            handedOff = true;
            return state;
        } finally {
            terrain?.release?.();
            if (!handedOff) for (const read of reads) read.release?.();
        }
    }

    // The same compiler prepares an isolated successor for the dependency
    // group. After admission, queries keep the published generation until the
    // coordinator commits. Cancellation never re-enables query-time publishing.
    // Mark affected definition/terrain bounds before preparation; an explicit
    // terrainRead supplies the candidate dependency, not a second world rule.
    managePublications() {
        if (this._disposed) throw new Error('Road alignments are disposed');
        this._publicationManaged = true;
    }

    *preparePublicationSteps({ terrainRead = null, authoredPortalReplacements, now, isCurrent = () => true,
        mappedWater = null } = {}) {
        if (this._disposed) throw new Error('Road alignments are disposed');
        if (this._publicationOwner) throw new Error('Road alignment publication is already held');
        if (!terrainRead && !this.captureTerrainSnapshot) throw new TypeError('Road alignment publication requires captured terrain');
        if (!Array.isArray(authoredPortalReplacements)) throw new TypeError('Capture authored portal replacement state explicitly');
        this._publicationManaged = true;
        if (!this._dirty) return null;
        const owner = {}, revision = this.revision, definitions = this._definitions;
        const source = this._compiled, sourceInputs = this._publishedInputs;
        this._publicationOwner = owner;
        const locallyCurrent = () => !this._disposed && this._publicationOwner === owner
            && this.revision === revision && this._definitions === definitions
            && this._compiled === source && this._publishedInputs === sourceInputs;
        const current = () => locallyCurrent() && isCurrent() === true;
        let state = null, read = null, querySteps = null, handedOff = false, status = 'preparing';
        const releaseOwner = () => { if (this._publicationOwner === owner) this._publicationOwner = null; };
        const build = this._buildGenerationSteps({ terrainRead, now, isCurrent: current, requireComplete: true,
            isPermanentGap: permanentTerrainGapTest({ mappedWater, terrain: terrainRead }) });
        owner.cancel = () => {
            if (status !== 'preparing' && status !== 'prepared') return false;
            build.return(); querySteps?.return(); read?.release(); state?._publishedInputs.release();
            status = 'discarded'; releaseOwner(); return true;
        };
        try {
            state = yield* build;
            const query = { ...state, revision, _disposed: false, _publicationManaged: false };
            querySteps = RoadVerticalAlignmentModel.prototype.captureReadSnapshotSteps.call(query,
                { authoredPortalReplacements, now, isCurrent: current });
            read = yield* querySteps;
            if (!current()) throw Object.assign(new Error('Road alignment preparation was superseded'),
                { code: 'road-alignment-preparation-stale' });
            let previous = Object.fromEntries(Object.keys(state).map(key => [key, this[key]]));
            status = 'prepared'; handedOff = true;
            return Object.freeze({
                read,
                get state() { return status; },
                isCurrent: () => status === 'prepared' && current(),
                commit: () => {
                    // The group validates external dependencies before any
                    // member promotes. Earlier members may already be current
                    // here; only our own source/owner identity is rechecked.
                    if (status !== 'prepared' || !locallyCurrent()) return false;
                    Object.assign(this, state); status = 'committed'; return true;
                },
                rollback: () => {
                    if (status !== 'committed' || this._publicationOwner !== owner) return false;
                    Object.assign(this, previous); status = 'prepared'; return true;
                },
                discard: () => owner.cancel(),
                finalize: () => {
                    if (status !== 'committed' || this._publicationOwner !== owner) return false;
                    previous._publishedInputs?.release(); read.release();
                    status = 'published'; previous = null; state = null; releaseOwner(); return true;
                },
            });
        } finally {
            if (!handedOff) owner.cancel();
        }
    }

    // Terrain changes alter approach grades, cached sample rows and opening
    // envelopes together. Unrelated source windows do not dirty this model.
    invalidateTerrain(bounds = null) {
        const changes = Array.isArray(bounds) ? bounds : null;
        const affected = [];
        for (const [id, entry] of this._definitionState) {
            if (!changes || changes.some(bound => entry.bounds && bound
                && bound.minX <= entry.bounds.maxX && bound.maxX >= entry.bounds.minX
                && bound.minZ <= entry.bounds.maxZ && bound.maxZ >= entry.bounds.minZ)) {
                affected.push({ id, ...entry });
            }
        }
        if (!affected.length) return { changed: false, revision: this.revision, bounds: [], ids: [], osmIds: [] };
        const change = { changed: true, revision: ++this.revision,
            bounds: affected.map(entry => ({ ...entry.bounds })),
            ids: affected.map(entry => entry.id),
            osmIds: [...new Set(affected.flatMap(entry => entry.osmIds))] };
        for (const entry of affected) this._terrainDirtyIds.add(entry.id);
        this._dirty = true;
        this._alignmentChanges.push(change);
        if (this._alignmentChanges.length > ALIGNMENT_CHANGE_HISTORY_LIMIT) this._alignmentChanges.shift();
        return change;
    }

    // Only compiled query data crosses the build boundary. In particular this
    // facade has neither the source-tile maps nor a route back to the compiler.
    // Analytic profile closures already own their immutable terrain inputs.
    *captureReadSnapshotSteps({ authoredPortalReplacements, now, isCurrent = () => true } = {}) {
        if (this._disposed || (this._dirty && !this._publicationManaged) || !this._publishedInputs?.terrainCaptured) {
            throw new Error('Complete a captured road alignment generation before reading it');
        }
        if (!Array.isArray(authoredPortalReplacements)) {
            throw new TypeError('Capture authored portal replacement state explicitly');
        }
        const sourceInputs = this._publishedInputs;
        const inputs = sourceInputs.retain('road-alignment-query');
        const clock = alignmentPreparationClock({ now, isCurrent });
        let handedOff = false;
        try {
            const revision = this.publishedRevision;
            const source = this._compiled;
            const sourceByOsmId = this._byOsmId;
            const sourceOwners = this._profileOwnerByAlignment;
            const sourceCutouts = this._replacementTerrainCutoutRegions;
            const portals = yield* mapAlignmentSteps(authoredPortalReplacements, entry => Object.freeze({
                alignmentId: entry?.alignmentId,
                replacementBackstopReady: entry?.replacementBackstopReady === true,
                selectionBounds: entry?.selectionBounds ? Object.freeze({ ...entry.selectionBounds }) : null,
            }), clock, 'alignment-query-portals');
            const byOld = new Map();
            const compiled = [];
            for (const alignment of source) {
                if (clock.expired()) { yield { phase: 'alignment-query-record' }; clock.restart(); }
                const copy = Object.freeze({ ...alignment });
                byOld.set(alignment, copy);
                compiled.push(copy);
            }
            const byOsmId = new Map();
            for (const [id, alignment] of sourceByOsmId) {
                if (clock.expired()) { yield { phase: 'alignment-query-index' }; clock.restart(); }
                byOsmId.set(id, byOld.get(alignment));
            }
            const owners = new Map();
            for (const [companion, owner] of sourceOwners) {
                if (clock.expired()) { yield { phase: 'alignment-query-owner' }; clock.restart(); }
                owners.set(byOld.get(companion), byOld.get(owner));
            }
            const cutouts = yield* mapAlignmentSteps(sourceCutouts, region => region, clock, 'alignment-query-cutouts');
            const context = {
                _compiled: Object.freeze(compiled), _byOsmId: byOsmId,
                _profileOwnerByAlignment: owners,
                _replacementTerrainCutoutRegions: Object.freeze(cutouts),
                authoredPortalReplacements: () => portals,
                _ensureBuilt() {},
            };
            const names = ['getAlignments', 'getAlignmentForOsmId', 'getProfileOwnerForOsmId',
                '_roadYFromAlignmentsAtLocal', 'roadYAtLocal', 'roadYForOsmIdsAtLocal',
                'isBufferedEndCapAtLocal', 'createBufferedRoadJoinArtifactEvaluator',
                'isBufferedRoadJoinArtifactAtLocal', 'structureAtLocal', 'replacesRoadSurfaceForOsmId',
                'laneCountOverrideForOsmId', 'retainsRoadFormationForOsmId',
                'containsReplacementCorridorForOsmId', 'getReplacementTerrainCutoutRegions',
                'isInsideReplacementTerrainOpening', 'containsReplacementCorridor'];
            const api = { contract: 'station3d-road-alignment-read-snapshot-v1', revision };
            for (const name of names) {
                context[name] = RoadVerticalAlignmentModel.prototype[name].bind(context);
                if (!name.startsWith('_')) api[name] = context[name];
            }
            clock.expired();
            if (this._disposed || (this._dirty && !this._publicationManaged)
                || this.publishedRevision !== revision || this._compiled !== source || this._publishedInputs !== sourceInputs) {
                const error = new Error('Road alignment changed during snapshot preparation');
                error.code = 'road-alignment-snapshot-stale';
                throw error;
            }
            handedOff = true;
            return ownReadSnapshot(api, [inputs]);
        } finally {
            if (!handedOff) inputs.release();
        }
    }

    // Cheap readiness probe for hot consumers. Tile setters already retain
    // only features carrying vertical-alignment metadata, so these collection
    // sizes answer the question without compiling and terrain-sampling every
    // profile merely to discover that an ordinary city tile has none.
    hasAlignmentDefinitions() {
        if (this._authoredDefinitions.length > 0) return true;
        for (const features of this.centerlineTiles.values()) {
            if (features.length > 0) return true;
        }
        for (const features of this.alignmentTiles.values()) {
            if (features.length > 0) return true;
        }
        return false;
    }

    getAlignments() {
        this._ensureBuilt();
        return this._compiled;
    }

    getAlignmentForOsmId(osmId) {
        this._ensureBuilt();
        return this._byOsmId.get(numericId(osmId)) || null;
    }

    getProfileOwnerForOsmId(osmId) {
        this._ensureBuilt();
        const alignment = this._byOsmId.get(numericId(osmId)) || null;
        return alignment
            ? this._profileOwnerByAlignment.get(alignment) || alignment
            : null;
    }

    _roadYFromAlignmentsAtLocal(x, z, candidates) {
        let best = null;
        for (const alignment of candidates) {
            const nearest = alignment.nearest(x, z);
            const physicalHalfWidthM = Number(alignment.definition.corridorHalfWidthM)
                || Number(alignment.definition.crossSection?.formationHalfWidthM)
                || 0;
            // Keep profile association distinct from physical structure width.
            // Buffered approach polygons, sidewalks, and companion cycle paths
            // can extend beyond the carriageway/formation at a member join.
            // They still belong to this one continuous vertical alignment, but
            // must not make the deck, retaining wall, or collision ribbon wider.
            const halfWidthM = Math.max(
                physicalHalfWidthM,
                DEFAULT_CORRIDOR_HALF_WIDTH_M,
            );
            if (!nearest
                || nearest.distanceSquared > halfWidthM ** 2
                || pointIsPastAlignmentEndpoint(alignment, nearest, x, z)) {
                continue;
            }
            if (!best || nearest.distanceSquared < best.nearest.distanceSquared) {
                best = { alignment, nearest };
            }
        }
        if (!best) return null;
        const owner = this._profileOwnerByAlignment.get(best.alignment) || best.alignment;
        const ownerNearest = owner === best.alignment
            ? best.nearest
            : owner.nearest(x, z);
        if (!ownerNearest) return null;
        const profileY = owner.profileYAtS(ownerNearest.s);
        // A raised approach must clear the terrain across its full paved
        // cross-section, not only at the centreline sample used to construct
        // the longitudinal profile. DGU triangles can slope laterally by a few
        // centimetres and otherwise poke through one road edge while the
        // centreline is still terrain-bound. Keep the actual deck flat; only
        // the approach/runout envelope follows the higher local terrain.
        const onOverpassApproach = owner.kind === 'overpass'
            && (ownerNearest.s < owner.structureStartM
                || ownerNearest.s > owner.structureEndM);
        if (!onOverpassApproach) return profileY;
        const centerlineTerrainY = finiteOrNull(owner.terrainSceneYAtLocal(
            ownerNearest.x,
            ownerNearest.z,
        ));
        // The synthesized axis deliberately carries a terrain-bound runout
        // after each ramp. Once the design has rejoined its ordinary
        // centerline height, keep the same flat cross-section as the normal
        // road-formation fallback. Taking max(profile, local terrain) here
        // turns the runout into a laterally sloped disk and leaves a visible
        // step where the finite alignment ends on cross-sloped ground.
        if (centerlineTerrainY === null) return null;
        const localTerrainY = finiteOrNull(owner.terrainSceneYAtLocal(x, z));
        if (localTerrainY === null) return null;
        const designLiftM = Math.max(0, profileY - centerlineTerrainY);
        const localTerrainExcessM = Math.max(0, localTerrainY - profileY);
        return profileY + localTerrainExcessM * smoothstep(
            designLiftM / OVERPASS_LATERAL_TERRAIN_ENVELOPE_FADE_M,
        );
    }

    roadYAtLocal(x, z, osmId = null) {
        this._ensureBuilt();
        const requested = numericId(osmId);
        const candidates = requested != null
            ? [this._byOsmId.get(requested)].filter(Boolean)
            : this._compiled;
        return this._roadYFromAlignmentsAtLocal(x, z, candidates);
    }

    roadYForOsmIdsAtLocal(x, z, osmIds = []) {
        this._ensureBuilt();
        const candidates = Array.from(new Set(
            (Array.isArray(osmIds) ? osmIds : [osmIds])
                .map(osmId => this._byOsmId.get(numericId(osmId)))
                .filter(Boolean),
        ));
        return this._roadYFromAlignmentsAtLocal(x, z, candidates);
    }

    // ST_Buffer closes every isolated road polygon with a rounded cap. When
    // /roads/curbs keeps a bridge on its own vertical layer, that internal
    // buffer boundary would otherwise become a circular curb across the road
    // at both bridge joins. Only the longitudinal sides are real curbs.
    isBufferedEndCapAtLocal(x, z, osmIds = null) {
        this._ensureBuilt();
        const requestedIds = Array.isArray(osmIds)
            ? Array.from(new Set(osmIds.map(numericId).filter(Boolean)))
            : [numericId(osmIds)].filter(Boolean);
        const candidates = requestedIds.length > 0
            ? requestedIds.map(osmId => this._byOsmId.get(osmId)).filter(Boolean)
            : this._compiled;
        for (const alignment of candidates) {
            if (!alignment || alignment.definition?.renderStructure === false) continue;
            const nearest = alignment.nearest(x, z);
            const halfWidthM = roadStructureFormationHalfWidthM(alignment.definition);
            if (!nearest || nearest.distanceSquared > halfWidthM ** 2) continue;
            if (nearest.s <= BUFFERED_END_CAP_STATION_EPS_M
                || alignment.totalLengthM - nearest.s <= BUFFERED_END_CAP_STATION_EPS_M) {
                return true;
            }
        }
        return false;
    }

    // At a vertical-layer boundary, PostGIS buffers the bridge way and its
    // adjoining ground-level way independently. Their rounded caps overlap at
    // the shared endpoint even though they are one continuous road. For the
    // bridge-owned polygon the false cap lies outside its axis; for the
    // adjoining polygon it protrudes into the first/last metres of the bridge.
    // Directional endpoint tests remove those two caps without deleting the
    // real longitudinal curbs approaching and leaving the structure.
    createBufferedRoadJoinArtifactEvaluator(osmIds = null, maxAdjoiningCapM = 10) {
        this._ensureBuilt();
        const requestedIds = Array.isArray(osmIds)
            ? Array.from(new Set(osmIds.map(numericId).filter(Boolean)))
            : [numericId(osmIds)].filter(Boolean);
        if (requestedIds.length === 0) return () => false;

        const ownedAlignments = Array.from(new Set(
            requestedIds.map(osmId => this._byOsmId.get(osmId)).filter(Boolean),
        ));
        const candidates = ownedAlignments.length > 0
            ? ownedAlignments
            : this._compiled;
        const adjoiningLimitM = Math.max(
            BUFFERED_END_CAP_STATION_EPS_M,
            finiteOrNull(maxAdjoiningCapM) || 0,
        );
        const boundaries = [];

        for (const alignment of candidates) {
            if (!alignment || alignment.definition?.renderStructure === false) continue;
            const points = alignment.points;
            if (!Array.isArray(points) || points.length < 2) continue;
            const halfWidthM = roadStructureFormationHalfWidthM(alignment.definition);
            const structuralIds = alignment.structureOsmIds?.size > 0
                ? alignment.structureOsmIds
                : alignment.memberOsmIds;
            const ownsStructureMember = requestedIds.some(osmId => (
                structuralIds.has(osmId)
            ));
            const ownsAdjoiningMember = requestedIds.some(osmId => (
                alignment.memberOsmIds.has(osmId)
                && !structuralIds.has(osmId)
            ));
            // A feature containing both sides of the member join has already
            // been unioned continuously and owns no round internal cap. An
            // unrelated feature near the join is treated as the adjoining
            // layer so it can still discover and reject a spatial cap.
            if (ownsStructureMember && ownsAdjoiningMember) continue;
            const structureSide = ownsStructureMember;
            const adjoiningSide = ownsAdjoiningMember || ownedAlignments.length === 0;
            if (!structureSide && !adjoiningSide) continue;
            const endpointRadiusM = structureSide
                ? halfWidthM
                : Math.min(adjoiningLimitM, halfWidthM + 1.5);
            const endpointRadiusSq = endpointRadiusM ** 2;
            const structureIsInterior = (
                alignment.structureStartM > BUFFERED_END_CAP_STATION_EPS_M
                || alignment.structureEndM
                    < alignment.totalLengthM - BUFFERED_END_CAP_STATION_EPS_M
            );
            const startStationM = structureIsInterior
                ? alignment.structureStartM
                : 0;
            const endStationM = structureIsInterior
                ? alignment.structureEndM
                : alignment.totalLengthM;
            const addBoundary = (stationM, atStart) => {
                const boundary = pointAtStation(
                    alignment.points,
                    alignment.cumulative,
                    stationM,
                );
                const sampleDistanceM = Math.min(
                    0.5,
                    Math.max(0.05, alignment.totalLengthM * 0.01),
                );
                const before = pointAtStation(
                    alignment.points,
                    alignment.cumulative,
                    Math.max(0, stationM - sampleDistanceM),
                );
                const after = pointAtStation(
                    alignment.points,
                    alignment.cumulative,
                    Math.min(alignment.totalLengthM, stationM + sampleDistanceM),
                );
                const directionX = after.x - before.x;
                const directionZ = after.z - before.z;
                const directionLength = Math.hypot(directionX, directionZ);
                if (directionLength <= 1e-6) return;
                boundaries.push({
                    x: boundary.x,
                    z: boundary.z,
                    tangentX: directionX / directionLength,
                    tangentZ: directionZ / directionLength,
                    endpointRadiusSq,
                    structureSide,
                    atStart,
                });
            };
            addBoundary(startStationM, true);
            addBoundary(endStationM, false);
        }

        return (x, z) => {
            const px = finiteOrNull(x);
            const pz = finiteOrNull(z);
            if (px == null || pz == null) return false;
            for (const boundary of boundaries) {
                const dx = px - boundary.x;
                const dz = pz - boundary.z;
                if (dx * dx + dz * dz > boundary.endpointRadiusSq) continue;
                const along = dx * boundary.tangentX + dz * boundary.tangentZ;
                if (boundary.structureSide) {
                    if (boundary.atStart
                        ? along <= BUFFERED_END_CAP_STATION_EPS_M
                        : along >= -BUFFERED_END_CAP_STATION_EPS_M) return true;
                } else if (boundary.atStart
                    ? along >= -BUFFERED_END_CAP_STATION_EPS_M
                    : along <= BUFFERED_END_CAP_STATION_EPS_M) {
                    return true;
                }
            }
            return false;
        };
    }

    isBufferedRoadJoinArtifactAtLocal(x, z, osmIds = null, maxAdjoiningCapM = 10) {
        return this.createBufferedRoadJoinArtifactEvaluator(
            osmIds,
            maxAdjoiningCapM,
        )(x, z);
    }

    structureAtLocal(x, z, osmId = null) {
        this._ensureBuilt();
        const requested = numericId(osmId);
        const candidates = requested != null
            ? [this._byOsmId.get(requested)].filter(Boolean)
            : this._compiled;
        let best = null;
        for (const alignment of candidates) {
            const nearest = alignment.nearest(x, z);
            const halfWidthM = roadStructureFormationHalfWidthM(alignment.definition);
            if (!nearest
                || nearest.s < alignment.structureStartM
                || nearest.s > alignment.structureEndM
                || nearest.distanceSquared > halfWidthM ** 2) continue;
            if (!best || nearest.distanceSquared < best.distanceSquared) {
                best = {
                    id: alignment.id,
                    kind: alignment.kind,
                    osmIds: Array.from(alignment.memberOsmIds),
                    distanceSquared: nearest.distanceSquared,
                    stationM: nearest.s,
                };
            }
        }
        return best;
    }

    replacesRoadSurfaceForOsmId(osmId) {
        const requested = numericId(osmId);
        const definition = this.getAlignmentForOsmId(requested)?.definition;
        if (!definition?.replaceRoadSurface) return false;
        if (!Array.isArray(definition.replaceRoadSurfaceOsmIds)) return true;
        return definition.replaceRoadSurfaceOsmIds
            .map(numericId)
            .includes(requested);
    }

    laneCountOverrideForOsmId(osmId) {
        const requested = numericId(osmId);
        const definition = this.getAlignmentForOsmId(requested)?.definition;
        const laneCount = Number(definition?.laneCountOverride);
        if (!Number.isFinite(laneCount) || laneCount < 1) return null;
        if (Array.isArray(definition.replaceRoadSurfaceOsmIds)
            && !definition.replaceRoadSurfaceOsmIds
                .map(numericId)
                .includes(requested)) {
            return null;
        }
        return Math.round(laneCount);
    }

    retainsRoadFormationForOsmId(osmId) {
        return this.replacesRoadSurfaceForOsmId(osmId)
            && !!this.getAlignmentForOsmId(osmId)?.definition.retainRoadFormation;
    }

    containsReplacementCorridorForOsmId(x, z, osmId, halfWidthM = null) {
        const alignment = this.getAlignmentForOsmId(osmId);
        if (!alignment?.definition.replaceRoadSurface) return false;
        const nearest = alignment.nearest(x, z);
        if (alignment.definition.replaceRoadSurfaceRange === 'structure'
            && (!nearest
                || nearest.s < alignment.structureStartM
                || nearest.s > alignment.structureEndM)) {
            return false;
        }
        const width = Number(halfWidthM)
            || Number(alignment.definition.crossSection?.terrainClearHalfWidthM)
            || roadStructureFormationHalfWidthM(alignment.definition);
        return !!nearest && nearest.distanceSquared <= width ** 2;
    }

    getReplacementTerrainCutoutRegions() {
        this._ensureBuilt();
        return filterReplacementTerrainCutoutsForAuthoredPortals(
            this._replacementTerrainCutoutRegions,
            this.authoredPortalReplacements(),
        );
    }

    // Is (x, z) inside a stretch where the terrain is genuinely OPENED by a
    // replacement underpass (a ramp/trench cutout ring)? Over a boxed
    // structure this is false — the fill above the tunnel is intact ground.
    // Exactly the rings the terrain mask paints, so physics and pixels agree.
    isInsideReplacementTerrainOpening(x, z) {
        this._ensureBuilt();
        const px = Number(x);
        const pz = Number(z);
        if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
        for (const region of this.getReplacementTerrainCutoutRegions()) {
            const bounds = region.cutoutBounds;
            if (!bounds
                || px < bounds.minX || px > bounds.maxX
                || pz < bounds.minZ || pz > bounds.maxZ) continue;
            if (pointInRing(px, pz, region.cutoutRing)) return true;
        }
        return false;
    }

    containsReplacementCorridor(x, z, halfWidthM = null) {
        this._ensureBuilt();
        for (const alignment of this._compiled) {
            if (!alignment.definition.replaceRoadSurface) continue;
            const nearest = alignment.nearest(x, z);
            if (alignment.definition.replaceRoadSurfaceRange === 'structure'
                && (!nearest
                    || nearest.s < alignment.structureStartM
                    || nearest.s > alignment.structureEndM)) {
                continue;
            }
            const width = Number(halfWidthM)
                || roadStructureFormationHalfWidthM(alignment.definition);
            if (nearest && nearest.distanceSquared <= width ** 2) return true;
        }
        return false;
    }
}
