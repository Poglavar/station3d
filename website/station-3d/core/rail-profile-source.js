import { streamedRailFeatureIdentity } from './streamed-rail-features.js';
import { finiteOrNull } from './math.js';
import { RENDERED_TUNNEL_BED_ABOVE_RAIL_M } from './rail-formation.js';
import { createBoundsGrid } from './bounds-grid.js';

export const RAIL_PROFILE_OSM = 'osm';
export const RAIL_PROFILE_SOLVED = 'solved';

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_COVERAGE_RADIUS_M = 9;
const DEFAULT_COVERAGE_SAMPLE_STEP_M = 6;
const DEFAULT_PARALLEL_TOLERANCE_DEG = 30;
const DEFAULT_INDEX_CELL_M = 80;
// rails.js places the tunnel bed at rail head + tramBed (0.075 m) - 0.015 m.
// Clearance is resolved against the same datum so the reconstructed profile
// protects the actual rendered ceiling, not an approximate rail-centre plane.
const DEFAULT_CLEARANCE_SAMPLE_STEP_M = 10;
const DEFAULT_CLEARANCE_CROSS_STEP_M = 1.5;

function finishRailSourceSteps(steps) {
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

function createRailSourceWork({ now = () => performance.now() } = {}) {
    let deadline = now() + 0.5;
    return {
        expired: () => now() >= deadline,
        restart() { deadline = now() + 0.5; },
        *map(values, project, phase) {
            const result = [];
            for (let index = 0; index < values.length; index++) {
                if (this.expired()) { yield { phase }; this.restart(); }
                result.push(project(values[index], index));
            }
            return result;
        },
    };
}

// A solved route is still the one authoritative/driveable alignment. Selected
// OSM geometry may augment it as non-driveable visual context where the real
// infrastructure is visibly wider than that route. These scopes are data, not
// a general "show the whole OSM network" switch: surface ways are clipped to
// the named station yard, while the companion through track is allowed only
// inside the already solved physical tunnel.
const SOLVED_RAIL_CONTEXTS = Object.freeze([Object.freeze({
    sourceId: 'legacy-rail-perkovic-split-v1',
    segmentKey: 'rail:m604:perkovic-split',
    groupId: 'split-station',
    surfaceBbox: Object.freeze({
        west: 16.4415,
        south: 43.5008,
        east: 16.4455,
        north: 43.5069,
    }),
    tunnelName: 'split',
    // One physical, non-electrified double-track bore. The driven solved
    // centreline remains a single track. A second OSM centreline measures the
    // shared section when present; when the road stream omits railway ways the
    // same reviewed spacing supplies a visual-only companion, never another
    // driveable track or another tunnel shell.
    tunnelSection: Object.freeze({
        physicalId: 'split-tunnel',
        trackCount: 2,
        minimumBoreHalfWidthM: 4.6,
        outerTrackCentreClearanceM: 2.4,
        clearHeightM: 5.2,
        portalCrownM: 0.65,
        // The one-metre DGU triangles at the south mouth bridge farther into
        // the bore than the generic 1.5 m anti-alias overlap.  Let the opaque
        // tube own a short, reviewed throat so the source terrain cannot hang
        // below its ceiling.  This remains a portal-local aperture, not a cut
        // through the intact tunnel roof.
        portalTerrainOpeningInsideM: 4.5,
        // Reviewed from the two mapped Split tunnel centrelines. The roads
        // stream is allowed to arrive without railway ways, so physical civil
        // ownership cannot depend on whether that optional visual context was
        // in the current tile payload. When the companion IS present its
        // measured offset below replaces these values.
        fallbackTrackSpacingM: 4.1,
        fallbackCenterOffsetM: -2.05,
        fallbackTunnelRun: 'last',
        // The reconstructed rail-head profile is evidence, not an immutable
        // render offset. Resolve it downward wherever the complete tunnel
        // envelope would pierce the DGU surface, then spread that correction
        // into both approaches with a bounded additional grade.
        // This is a shallow engineered urban bore, with road construction
        // immediately over a thin structural roof rather than a deep soil cap.
        minimumRoofCoverM: 0.25,
        maximumVerticalAdjustmentGrade: 0.008,
        clearanceSampleStepM: 10,
    }),
    // The final approach is a compact urban retained section, not a rural
    // earthwork. Both sides are engineered: buildings/foundations form the
    // west edge and a vertical wall carries the parallel road on the east.
    formationSections: Object.freeze([Object.freeze({
        sourceStartM: 48664.145,
        sourceEndM: 48900.58,
        style: 'vertical-retained',
        // On this source direction the negative normal is the west/building
        // side. Carry the level cess all the way to those vertical structures
        // instead of leaving a strip of natural DTM beside the portal.
        negativeNormalRetainedBenchM: 6,
    })]),
    // Survey/reference geometry sits slightly too far into the parallel road
    // at the portal. Move the complete physical pair west through the retained
    // block, with long smooth tapers back onto the published alignment.
    alignmentCorrection: Object.freeze({
        lateralOffsetM: -1.25,
        rampInStartM: 48558.03,
        fullStartM: 48637.88,
        fullEndM: 48777.63,
        rampOutEndM: 48857.51,
    }),
    // The descending road immediately east of the portal is carried on the
    // railway's retained block. Declaring that semantic interface here lets
    // the generic road formation replace its rural fill batter with a flat
    // paved bench and vertical wall, independent of layer streaming order.
    roadInterfaces: Object.freeze([
        Object.freeze({
            osmWayId: '912809760',
            style: 'vertical-retained',
            // The road is on the positive-normal/east side of the solved rail.
            // Both formations meet at one physical wall: the road owns the face
            // that retains its carriageway, while rail keeps its level cess below.
            railBoundarySide: 'positive-normal',
        }),
        Object.freeze({
            osmWayId: '912809761',
            style: 'vertical-retained',
            railBoundarySide: 'positive-normal',
            // This adjoining OSM way begins at the portal and continues over
            // the shallow tunnel. Carry the open-cut wall plane just through
            // the opaque portal throat, then let the buried road resume its
            // own terrain edge. Without this bounded continuation, its first
            // vertex drops to the rail floor while the next one samples the
            // tunnel roof, producing the large diagonal see-through wedge.
            boundaryContinuationM: 9,
            boundarySnapDistanceM: 4,
        }),
    ]),
    surfaceOsmWayIds: Object.freeze(new Set([
        // Numbered passenger/station tracks 1–5. Track 3 north of the stop is
        // the solved authority; its south throat remains useful visual context.
        '133502486',
        '71447508',
        '659571084',
        '143731412',
        '71447510',
        '133502480',
        // Two short switch leads joining the numbered station tracks.
        '133502482',
        '133502485',
    ])),
    tunnelCompanionOsmWayIds: Object.freeze(new Set([
        '1413069201',
        '909020201',
        '254437420',
    ])),
    suppressedOsmWayIds: Object.freeze(new Set([
        // Do not turn the short, unnamed portal sidings/crossovers into their
        // own civil works. The numbered surface sidings stop at their mapped
        // endpoints; only the second main track continues through the bore.
        '1413069202',
        '659560394',
        '659560395',
        '909020202',
        '909020203',
    ])),
    // These OSM ways are the exact station-to-portal and tunnel chain already
    // represented by the solved M604 route. ID ownership makes dedupe robust to
    // the light render smoothing applied to the OSM copy.
    coveredOsmWayIds: Object.freeze(new Set([
        '659571085',
        '909020200',
        '25566946',
    ])),
})]);

function finiteCoordinate(coordinate) {
    return Array.isArray(coordinate)
        && finiteOrNull(coordinate[0]) !== null
        && finiteOrNull(coordinate[1]) !== null;
}

function lineCoordinates(feature) {
    return feature?.geometry?.type === 'LineString'
        ? (feature.geometry.coordinates || []).filter(finiteCoordinate)
        : [];
}

function property(feature, key) {
    return feature?.properties?.[key] ?? feature?.properties?.tags?.[key];
}

function affirmative(value) {
    if (value === true || value === 1) return true;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized !== '' && !['0', 'false', 'no', 'none'].includes(normalized);
}

export function normalizeRailProfileMode(value) {
    return String(value || '').trim().toLowerCase() === RAIL_PROFILE_SOLVED
        ? RAIL_PROFILE_SOLVED
        : RAIL_PROFILE_OSM;
}

export function isSolvedRailFeature(feature) {
    const properties = feature?.properties || {};
    const coordinates = lineCoordinates(feature);
    return properties.source === 'reference-project'
        && properties.elevationMode === 'absolute'
        && properties.elevationDatum === 'EVRF2000'
        && coordinates.length >= 2
        && coordinates.every(coordinate => finiteOrNull(coordinate[2]) !== null);
}

function isSuppliedOsmRailFeature(feature) {
    const properties = feature?.properties || {};
    const source = String(properties.source || '').trim().toLowerCase();
    if (source) return source === 'osm';
    const osmId = properties.osm_id ?? properties.osmId;
    return osmId != null && String(osmId) !== '';
}

// A streaming session replaces only its static OSM input. Authored alignments
// (planner tracks, proposal tracks and non-EVRF reference geometry) belong to
// the session itself and must remain present while OSM tiles arrive or leave.
// Strict solved references still pass through the profile selector so the
// explicit osm/solved mode keeps its existing meaning.
export function resolveStreamedRailSessionFeatures(options = {}) {
    return finishRailSourceSteps(resolveStreamedRailSessionFeaturesSteps(options));
}

export function* resolveStreamedRailSessionFeaturesSteps({
    suppliedFeatures = [],
    streamedOsmFeatures = [],
    mode = RAIL_PROFILE_OSM,
    coverageOptions = {},
    terrainReference = null,
} = {}, scheduling = {}) {
    const supplied = Array.isArray(suppliedFeatures) ? suppliedFeatures : [];
    const solved = supplied.filter(isSolvedRailFeature);
    const authored = supplied.filter(feature => (
        !isSolvedRailFeature(feature) && !isSuppliedOsmRailFeature(feature)
    ));
    return [
        ...(yield* resolveRailProfileFeaturesSteps({
            osmFeatures: streamedOsmFeatures,
            solvedFeatures: solved,
            mode,
            coverageOptions,
            terrainReference,
        }, scheduling)),
        ...authored,
    ];
}

// OSM splits a railway way at a bridge/tunnel boundary. Keep that explicit
// ownership beside the inferred vertical profile so a short road crossing does
// not have to exceed a generic 30 m terrain-evidence threshold to get its deck.
export function osmRailStructureKind(feature) {
    if (affirmative(property(feature, 'tunnel')) || affirmative(property(feature, 'covered'))) {
        return 'tunnel';
    }
    if (affirmative(property(feature, 'bridge'))) return 'viaduct';
    const layer = Number(property(feature, 'layer'));
    if (Number.isFinite(layer) && layer > 0) return 'viaduct';
    if (Number.isFinite(layer) && layer < 0) return 'tunnel';
    return null;
}

function osmTramNeedsOwnFormation(feature) {
    if (osmRailStructureKind(feature)) return true;
    return affirmative(property(feature, 'embankment'));
}

export function prepareOsmRailFeature(feature) {
    const properties = feature?.properties || {};
    // Solved-context rails already carry an authoritative absolute profile and
    // an explicit formation role. Running them through the generic OSM path
    // would erase that role and re-infer their height from terrain.
    if (properties.railProfileSource === 'solved-context') {
        return {
            ...feature,
            properties: {
                ...properties,
                railMode: 'train',
            },
        };
    }
    const {
        terrainFormation: _terrainFormation,
        railProfileSource: _railProfileSource,
        railStructure: _railStructure,
        ...sourceProperties
    } = properties;
    const railway = String(
        properties.railway_type ?? properties.railway ?? properties.tags?.railway ?? '',
    ).trim().toLowerCase();
    const structure = osmRailStructureKind(feature);
    const tramOwnsFormation = railway === 'tram' && osmTramNeedsOwnFormation(feature);
    const inferFormation = railway !== 'tram' || tramOwnsFormation;
    return {
        ...feature,
        properties: {
            ...sourceProperties,
            railMode: railway === 'tram' ? 'tram' : 'train',
            ...(inferFormation ? {
                terrainFormation: 'smooth-grade',
                railProfileSource: 'osm-inferred',
            } : {}),
            ...(structure ? { railStructure: structure } : {}),
        },
    };
}

function projectionFor(features) {
    let latitudeSum = 0;
    let count = 0;
    for (const feature of features || []) {
        for (const coordinate of lineCoordinates(feature)) {
            latitudeSum += Number(coordinate[1]);
            count += 1;
        }
    }
    const anchorLat = count > 0 ? latitudeSum / count : 45;
    const metresPerLat = EARTH_RADIUS_M * DEG_TO_RAD;
    const metresPerLon = metresPerLat * Math.cos(anchorLat * DEG_TO_RAD);
    return coordinate => ({
        x: Number(coordinate[0]) * metresPerLon,
        z: -Number(coordinate[1]) * metresPerLat,
    });
}

function cellKey(x, z, cellM) {
    return `${Math.floor(x / cellM)}:${Math.floor(z / cellM)}`;
}

function buildCoverageIndex(features, { cellM = DEFAULT_INDEX_CELL_M } = {}) {
    const project = projectionFor(features);
    const cells = new Map();
    let segmentCount = 0;
    for (const feature of features || []) {
        const coordinates = lineCoordinates(feature);
        for (let index = 0; index < coordinates.length - 1; index++) {
            const a = project(coordinates[index]);
            const b = project(coordinates[index + 1]);
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const length = Math.hypot(dx, dz);
            if (length < 0.01) continue;
            const segment = {
                a,
                b,
                ux: dx / length,
                uz: dz / length,
                lengthSquared: length * length,
            };
            const minCellX = Math.floor(Math.min(a.x, b.x) / cellM);
            const maxCellX = Math.floor(Math.max(a.x, b.x) / cellM);
            const minCellZ = Math.floor(Math.min(a.z, b.z) / cellM);
            const maxCellZ = Math.floor(Math.max(a.z, b.z) / cellM);
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                    const key = `${cellX}:${cellZ}`;
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(segment);
                }
            }
            segmentCount += 1;
        }
    }
    return { project, cells, cellM, segmentCount };
}

function distanceSquaredToSegment(point, segment) {
    const dx = segment.b.x - segment.a.x;
    const dz = segment.b.z - segment.a.z;
    const t = Math.max(0, Math.min(1,
        ((point.x - segment.a.x) * dx + (point.z - segment.a.z) * dz)
            / segment.lengthSquared));
    const x = segment.a.x + dx * t;
    const z = segment.a.z + dz * t;
    return (point.x - x) ** 2 + (point.z - z) ** 2;
}

function pointIsCovered(coordinate, direction, coverage, {
    radiusM,
    parallelCos,
}) {
    if (!coverage?.segmentCount) return false;
    const point = coverage.project(coordinate);
    const cellRadius = Math.max(1, Math.ceil(radiusM / coverage.cellM));
    const centerCellX = Math.floor(point.x / coverage.cellM);
    const centerCellZ = Math.floor(point.z / coverage.cellM);
    const radiusSquared = radiusM * radiusM;
    for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX++) {
        for (let offsetZ = -cellRadius; offsetZ <= cellRadius; offsetZ++) {
            const candidates = coverage.cells.get(
                cellKey(
                    (centerCellX + offsetX) * coverage.cellM,
                    (centerCellZ + offsetZ) * coverage.cellM,
                    coverage.cellM,
                ),
            ) || [];
            for (const segment of candidates) {
                const directionDot = Math.abs(direction.ux * segment.ux + direction.uz * segment.uz);
                if (directionDot < parallelCos) continue;
                if (distanceSquaredToSegment(point, segment) <= radiusSquared) return true;
            }
        }
    }
    return false;
}

function interpolateCoordinate(a, b, t) {
    const coordinate = [
        Number(a[0]) + (Number(b[0]) - Number(a[0])) * t,
        Number(a[1]) + (Number(b[1]) - Number(a[1])) * t,
    ];
    const az = Number(a[2]);
    const bz = Number(b[2]);
    if (Number.isFinite(az) && Number.isFinite(bz)) coordinate.push(az + (bz - az) * t);
    return coordinate;
}

function coordinateInsideBbox(coordinate, bbox) {
    const lon = Number(coordinate?.[0]);
    const lat = Number(coordinate?.[1]);
    return Number.isFinite(lon) && Number.isFinite(lat)
        && lon >= bbox.west && lon <= bbox.east
        && lat >= bbox.south && lat <= bbox.north;
}

// Liang-Barsky clipping preserves exact entry/exit coordinates without a GIS
// dependency. The optional elevation component is interpolated by the same
// helper used for solved-corridor clipping.
function clipSegmentToBbox(a, b, bbox) {
    const x0 = Number(a?.[0]);
    const y0 = Number(a?.[1]);
    const x1 = Number(b?.[0]);
    const y1 = Number(b?.[1]);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    const dx = x1 - x0;
    const dy = y1 - y0;
    let enter = 0;
    let leave = 1;
    for (const [p, q] of [
        [-dx, x0 - bbox.west],
        [dx, bbox.east - x0],
        [-dy, y0 - bbox.south],
        [dy, bbox.north - y0],
    ]) {
        if (Math.abs(p) < 1e-15) {
            if (q < 0) return null;
            continue;
        }
        const ratio = q / p;
        if (p < 0) enter = Math.max(enter, ratio);
        else leave = Math.min(leave, ratio);
        if (enter > leave) return null;
    }
    return [interpolateCoordinate(a, b, enter), interpolateCoordinate(a, b, leave)];
}

function clipFeatureToBbox(feature, bbox) {
    const coordinates = lineCoordinates(feature);
    if (coordinates.length < 2) return [];
    const fragments = [];
    let current = null;
    const finish = () => {
        if (current?.length >= 2) fragments.push(current);
        current = null;
    };
    for (let index = 0; index < coordinates.length - 1; index++) {
        const clipped = clipSegmentToBbox(coordinates[index], coordinates[index + 1], bbox);
        if (!clipped) {
            finish();
            continue;
        }
        const [a, b] = clipped;
        if (!current) current = [a];
        else if (!sameCoordinate(current[current.length - 1], a)) {
            finish();
            current = [a];
        }
        if (!sameCoordinate(current[current.length - 1], b)) current.push(b);
        if (!coordinateInsideBbox(coordinates[index + 1], bbox)) finish();
    }
    finish();
    const baseIdentity = streamedRailFeatureIdentity(feature);
    return fragments.map((fragment, index) => ({
        ...feature,
        properties: {
            ...(feature.properties || {}),
            railProfileFragment: `${baseIdentity}:context:${index}`,
        },
        geometry: { type: 'LineString', coordinates: fragment },
    }));
}

function sameCoordinate(a, b) {
    return Math.abs(Number(a?.[0]) - Number(b?.[0])) < 1e-12
        && Math.abs(Number(a?.[1]) - Number(b?.[1])) < 1e-12
        && (a?.length < 3 || b?.length < 3
            || Math.abs(Number(a?.[2]) - Number(b?.[2])) < 1e-9);
}

function* clipFeatureAgainstCoverageSteps(feature, coverage, {
    radiusM = DEFAULT_COVERAGE_RADIUS_M,
    sampleStepM = DEFAULT_COVERAGE_SAMPLE_STEP_M,
    parallelToleranceDeg = DEFAULT_PARALLEL_TOLERANCE_DEG,
} = {}, work) {
    const coordinates = lineCoordinates(feature);
    if (coordinates.length < 2) return [];
    if (!coverage?.segmentCount) return [feature];
    const parallelCos = Math.cos(Math.max(0, parallelToleranceDeg) * DEG_TO_RAD);
    const fragments = [];
    let current = null;
    let didClip = false;
    const finish = () => {
        if (current?.length >= 2) fragments.push(current);
        current = null;
    };
    for (let index = 0; index < coordinates.length - 1; index++) {
        const sourceA = coordinates[index];
        const sourceB = coordinates[index + 1];
        const aLocal = coverage.project(sourceA);
        const bLocal = coverage.project(sourceB);
        const dx = bLocal.x - aLocal.x;
        const dz = bLocal.z - aLocal.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.01) continue;
        const direction = { ux: dx / length, uz: dz / length };
        const parts = Math.max(1, Math.ceil(length / Math.max(1, sampleStepM)));
        for (let part = 0; part < parts; part++) {
            if (work.expired()) { yield { phase: 'rail-source:coverage' }; work.restart(); }
            const a = interpolateCoordinate(sourceA, sourceB, part / parts);
            const b = interpolateCoordinate(sourceA, sourceB, (part + 1) / parts);
            const midpoint = interpolateCoordinate(sourceA, sourceB, (part + 0.5) / parts);
            if (pointIsCovered(midpoint, direction, coverage, { radiusM, parallelCos })) {
                didClip = true;
                finish();
                continue;
            }
            if (!current) current = [a];
            else if (!sameCoordinate(current[current.length - 1], a)) current.push(a);
            if (!sameCoordinate(current[current.length - 1], b)) current.push(b);
        }
    }
    finish();
    if (!didClip) return [feature];
    const baseIdentity = streamedRailFeatureIdentity(feature);
    return fragments.map((fragment, index) => ({
        ...feature,
        properties: {
            ...(feature.properties || {}),
            railProfileFragment: `${baseIdentity}:${index}`,
        },
        geometry: { type: 'LineString', coordinates: fragment },
    }));
}

function solvedProjectPriority(feature) {
    const value = Number(
        feature?.properties?.referenceProjectId ?? feature?.properties?.projectId,
    );
    return Number.isFinite(value) ? value : 0;
}

function normalizedOsmWayId(feature) {
    const value = feature?.properties?.osm_id ?? feature?.properties?.osmId;
    const match = String(value ?? '').match(/(?:way\/)?(\d+)$/);
    return match ? match[1] : null;
}

function normalizedText(value) {
    return String(value ?? '').trim().toLocaleLowerCase('hr');
}

function contextForSolvedFeature(feature) {
    const properties = feature?.properties || {};
    const sourceId = String(properties.referenceSourceId || '').trim();
    const segmentKey = String(properties.referenceSegmentKey || '').trim();
    return SOLVED_RAIL_CONTEXTS.find(context => (
        sourceId === context.sourceId || segmentKey === context.segmentKey
    )) || null;
}

function smoothstep01(value) {
    const t = Math.max(0, Math.min(1, Number(value) || 0));
    return t * t * (3 - 2 * t);
}

function contextLateralOffsetM(context, sourceM) {
    const correction = context?.alignmentCorrection;
    const stationM = finiteOrNull(sourceM);
    const offsetM = finiteOrNull(correction?.lateralOffsetM);
    const rampInStartM = finiteOrNull(correction?.rampInStartM);
    const fullStartM = finiteOrNull(correction?.fullStartM);
    const fullEndM = finiteOrNull(correction?.fullEndM);
    const rampOutEndM = finiteOrNull(correction?.rampOutEndM);
    if (stationM === null || offsetM === null
        || rampInStartM === null || fullStartM === null
        || fullEndM === null || rampOutEndM === null
        || !(rampInStartM < fullStartM
            && fullStartM <= fullEndM
            && fullEndM < rampOutEndM)) return 0;
    if (stationM <= rampInStartM || stationM >= rampOutEndM) return 0;
    if (stationM < fullStartM) {
        return offsetM * smoothstep01(
            (stationM - rampInStartM) / (fullStartM - rampInStartM),
        );
    }
    if (stationM <= fullEndM) return offsetM;
    return offsetM * smoothstep01(
        (rampOutEndM - stationM) / (rampOutEndM - fullEndM),
    );
}

function shiftedLateralCoordinate(coordinate, normalX, normalZ, offsetM) {
    if (!(Math.abs(offsetM) > 1e-9)) return coordinate.slice();
    const latitude = Number(coordinate[1]);
    const metresPerDegreeLat = EARTH_RADIUS_M * DEG_TO_RAD;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(latitude * DEG_TO_RAD);
    if (!(metresPerDegreeLon > 0)) return coordinate.slice();
    return [
        Number(coordinate[0]) + normalX * offsetM / metresPerDegreeLon,
        latitude - normalZ * offsetM / metresPerDegreeLat,
        ...coordinate.slice(2),
    ];
}

function solvedCoordinateNormal(coordinates, index) {
    const previous = coordinates[Math.max(0, index - 1)];
    const next = coordinates[Math.min(coordinates.length - 1, index + 1)];
    const latitude = (Number(previous[1]) + Number(next[1])) * 0.5;
    const metresPerDegreeLat = EARTH_RADIUS_M * DEG_TO_RAD;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(latitude * DEG_TO_RAD);
    const dx = (Number(next[0]) - Number(previous[0])) * metresPerDegreeLon;
    const dz = -(Number(next[1]) - Number(previous[1])) * metresPerDegreeLat;
    const length = Math.hypot(dx, dz);
    return length > 1e-6
        ? { x: dz / length, z: -dx / length }
        : null;
}

// Rendering and physical driving tracks consume this same source alignment.
// A resolved feature may also reach a parked train or another rail session;
// the correction belongs to the source once, not to each consumer in turn.
export function resolveSolvedRailAlignment(features) {
    return (features || []).map((feature) => {
        if (feature?.properties?.railHorizontalAlignmentResolution) return feature;
        const context = contextForSolvedFeature(feature);
        if (!context?.alignmentCorrection) return feature;
        const coordinates = lineCoordinates(feature);
        const chainages = feature?.properties?.railSourceChainagesM;
        if (!Array.isArray(chainages) || chainages.length !== coordinates.length) return feature;
        let maxAppliedOffsetM = 0;
        const shifted = coordinates.map((coordinate, index) => {
            const offsetM = contextLateralOffsetM(context, chainages[index]);
            const normal = solvedCoordinateNormal(coordinates, index);
            if (!normal || Math.abs(offsetM) <= 1e-9) return coordinate.slice();
            maxAppliedOffsetM = Math.max(maxAppliedOffsetM, Math.abs(offsetM));
            return shiftedLateralCoordinate(coordinate, normal.x, normal.z, offsetM);
        });
        if (!(maxAppliedOffsetM > 0)) return feature;
        return {
            ...feature,
            properties: {
                ...(feature.properties || {}),
                railHorizontalAlignmentResolution: {
                    method: 'source-chainage-lateral-taper',
                    maxAppliedOffsetM,
                },
            },
            geometry: { type: 'LineString', coordinates: shifted },
        };
    });
}

// Source resolution runs before the formation's first cooperative visit.
// Query nearby source segments, rather than scanning a complete solved route
// for every companion/siding vertex. The distant fallback preserves the
// original global-nearest contract; input order still breaks exact ties.
function createSolvedSegmentLookup(segments) {
    const rows = segments.map((segment, order) => ({ segment, order, bounds: {
        minX: Math.min(segment.a.x, segment.b?.x ?? segment.a.x + segment.dx),
        maxX: Math.max(segment.a.x, segment.b?.x ?? segment.a.x + segment.dx),
        minZ: Math.min(segment.a.z, segment.b?.z ?? segment.a.z + segment.dz),
        maxZ: Math.max(segment.a.z, segment.b?.z ?? segment.a.z + segment.dz),
    } }));
    const index = createBoundsGrid(rows, { cellM: DEFAULT_INDEX_CELL_M,
        maxPointCandidates: 8192, maxIndexEntries: 1048576 });
    return (point, { maxDistanceM = Infinity, distanceMetric = false } = {}) => {
        const radius = Number.isFinite(maxDistanceM) ? maxDistanceM : DEFAULT_INDEX_CELL_M;
        let best = null, bestScore = Infinity, bestOrder = Infinity;
        const visit = candidates => {
            for (const { segment, order } of candidates) {
                const t = Math.max(0, Math.min(1,
                    ((point.x - segment.a.x) * segment.dx + (point.z - segment.a.z) * segment.dz)
                        / segment.lengthSquared));
                const deltaX = point.x - (segment.a.x + segment.dx * t);
                const deltaZ = point.z - (segment.a.z + segment.dz * t);
                const distanceSquared = deltaX ** 2 + deltaZ ** 2;
                const score = distanceMetric ? Math.hypot(deltaX, deltaZ) : distanceSquared;
                if (score > bestScore || score === bestScore && order >= bestOrder) continue;
                bestScore = score; bestOrder = order;
                best = { segment, t, deltaX, deltaZ, distanceSquared,
                    distanceM: distanceMetric ? score : Math.sqrt(distanceSquared) };
            }
        };
        visit(index.candidatesInBox(point.x - radius, point.z - radius, point.x + radius, point.z + radius));
        if (Number.isFinite(maxDistanceM)) return best?.distanceM <= maxDistanceM ? best : null;
        // A segment whose box is outside the search square cannot beat a
        // point inside its inscribed circle. Otherwise use the exact fallback.
        if (!best || best.distanceM > radius) visit(rows);
        return best;
    };
}

function solvedElevationSampler(features) {
    const project = projectionFor(features);
    const segments = [];
    for (const feature of features || []) {
        const coordinates = lineCoordinates(feature);
        for (let index = 0; index < coordinates.length - 1; index++) {
            const elevationA = finiteOrNull(coordinates[index]?.[2]);
            const elevationB = finiteOrNull(coordinates[index + 1]?.[2]);
            if (elevationA === null || elevationB === null) continue;
            const a = project(coordinates[index]);
            const b = project(coordinates[index + 1]);
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const lengthSquared = dx * dx + dz * dz;
            if (lengthSquared < 1e-6) continue;
            segments.push({ a, b, dx, dz, lengthSquared, elevationA, elevationB });
        }
    }
    const lookup = createSolvedSegmentLookup(segments);
    return coordinate => {
        const nearest = lookup(project(coordinate));
        return nearest ? nearest.segment.elevationA
            + (nearest.segment.elevationB - nearest.segment.elevationA) * nearest.t : null;
    };
}

function median(values) {
    const ordered = (values || [])
        .map(Number)
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
    if (!ordered.length) return null;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) * 0.5;
}

function solvedSourceSegments(features, project, sourceRange = null) {
    const segments = [];
    const sourceStartM = finiteOrNull(sourceRange?.startM);
    const sourceEndM = finiteOrNull(sourceRange?.endM);
    for (const feature of features || []) {
        const coordinates = lineCoordinates(feature);
        const sourceChainagesM = feature?.properties?.railSourceChainagesM;
        if (!Array.isArray(sourceChainagesM)
            || sourceChainagesM.length !== coordinates.length) continue;
        for (let index = 0; index < coordinates.length - 1; index++) {
            const sourceA = finiteOrNull(sourceChainagesM[index]);
            const sourceB = finiteOrNull(sourceChainagesM[index + 1]);
            if (sourceA === null || sourceB === null) continue;
            // Horizontal corrections usually cover only a few hundred metres
            // of a country-scale solved route. Keep only segments that can
            // produce a non-zero correction instead of making every streamed
            // station coordinate scan the complete route on every rail refresh.
            if (sourceStartM !== null && sourceEndM !== null
                && (Math.max(sourceA, sourceB) < sourceStartM
                    || Math.min(sourceA, sourceB) > sourceEndM)) continue;
            const a = project(coordinates[index]);
            const b = project(coordinates[index + 1]);
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const lengthSquared = dx * dx + dz * dz;
            if (lengthSquared < 1e-6) continue;
            const length = Math.sqrt(lengthSquared);
            segments.push({
                a,
                dx,
                dz,
                length,
                lengthSquared,
                sourceA,
                sourceB,
            });
        }
    }
    return segments;
}

function* applyContextAlignmentCorrectionsSteps(contextFeatures, solvedContexts, work) {
    const framesByGroup = new Map();
    for (const [context, authorities] of solvedContexts || []) {
        if (!context?.alignmentCorrection) continue;
        const project = projectionFor(authorities);
        const correction = context.alignmentCorrection;
        framesByGroup.set(context.groupId, {
            context,
            project,
            segments: solvedSourceSegments(authorities, project, {
                startM: correction.rampInStartM,
                endM: correction.rampOutEndM,
            }),
        });
    }
    const result = [];
    for (const feature of contextFeatures || []) {
        const frame = framesByGroup.get(feature?.properties?.railContextGroupId);
        if (!frame?.segments?.length) { result.push(feature); continue; }
        let maxAppliedOffsetM = 0;
        const coordinates = yield* work.map(lineCoordinates(feature), (coordinate) => {
            const point = frame.project(coordinate);
            let nearest = null;
            for (const segment of frame.segments) {
                const t = Math.max(0, Math.min(1,
                    ((point.x - segment.a.x) * segment.dx
                        + (point.z - segment.a.z) * segment.dz)
                        / segment.lengthSquared));
                const x = segment.a.x + segment.dx * t;
                const z = segment.a.z + segment.dz * t;
                const distanceM = Math.hypot(point.x - x, point.z - z);
                if (nearest && distanceM >= nearest.distanceM) continue;
                nearest = {
                    distanceM,
                    normalX: segment.dz / segment.length,
                    normalZ: -segment.dx / segment.length,
                    sourceM: segment.sourceA
                        + (segment.sourceB - segment.sourceA) * t,
                };
            }
            // Shift only rails that actually belong to the solved corridor;
            // selected station sidings farther away keep their surveyed plan.
            if (!nearest || nearest.distanceM > 12) return coordinate.slice();
            const offsetM = contextLateralOffsetM(frame.context, nearest.sourceM);
            if (Math.abs(offsetM) <= 1e-9) return coordinate.slice();
            maxAppliedOffsetM = Math.max(maxAppliedOffsetM, Math.abs(offsetM));
            return shiftedLateralCoordinate(
                coordinate,
                nearest.normalX,
                nearest.normalZ,
                offsetM,
            );
        }, 'rail-source:context-alignment');
        if (!(maxAppliedOffsetM > 0)) { result.push(feature); continue; }
        result.push({
            ...feature,
            properties: {
                ...(feature.properties || {}),
                railHorizontalAlignmentResolution: {
                    method: 'source-chainage-lateral-taper',
                    maxAppliedOffsetM,
                },
            },
            geometry: { type: 'LineString', coordinates },
        });
    }
    return result;
}

function publishedTunnelRuns(features) {
    const runs = [];
    for (const feature of features || []) {
        for (const run of feature?.properties?.railCivilRuns || []) {
            const regime = normalizedText(
                run?.regime ?? run?.structure ?? run?.expectedRegime ?? run?.type,
            );
            const startM = finiteOrNull(run?.startM ?? run?.fromM ?? run?.dM0);
            const endM = finiteOrNull(run?.endM ?? run?.toM ?? run?.dM1);
            if (regime !== 'tunnel' || startM === null || endM === null || endM <= startM) {
                continue;
            }
            runs.push({ startM, endM });
        }
    }
    return runs;
}

function tunnelClearancePolicy(policy) {
    const minimumRoofCoverM = finiteOrNull(policy?.minimumRoofCoverM);
    const maximumVerticalAdjustmentGrade = finiteOrNull(
        policy?.maximumVerticalAdjustmentGrade,
    );
    const clearanceSampleStepM = finiteOrNull(policy?.clearanceSampleStepM);
    return {
        minimumRoofCoverM: minimumRoofCoverM !== null && minimumRoofCoverM >= 0
            ? minimumRoofCoverM : 0,
        maximumVerticalAdjustmentGrade: maximumVerticalAdjustmentGrade !== null
            && maximumVerticalAdjustmentGrade > 0
            ? maximumVerticalAdjustmentGrade : 0,
        clearanceSampleStepM: clearanceSampleStepM !== null && clearanceSampleStepM > 0
            ? clearanceSampleStepM : DEFAULT_CLEARANCE_SAMPLE_STEP_M,
    };
}

function tunnelPortalTerrainOpeningPolicy(policy) {
    const insideM = finiteOrNull(policy?.portalTerrainOpeningInsideM);
    return insideM !== null && insideM >= 0
        ? { portalTerrainOpeningInsideM: insideM }
        : {};
}

function declaredSharedTunnelSection(solvedFeatures, context) {
    const policy = context?.tunnelSection;
    if (!policy) return null;
    const runs = publishedTunnelRuns(solvedFeatures)
        .sort((left, right) => left.startM - right.startM || left.endM - right.endM);
    if (runs.length === 0) return null;
    const run = policy.fallbackTunnelRun === 'last'
        ? runs[runs.length - 1]
        : runs[0];
    const trackSpacingM = finiteOrNull(policy.fallbackTrackSpacingM);
    const centerOffsetM = finiteOrNull(policy.fallbackCenterOffsetM);
    if (trackSpacingM === null || trackSpacingM <= 0 || centerOffsetM === null) return null;
    const boreHalfWidthM = Math.max(
        Number(policy.minimumBoreHalfWidthM) || 0,
        trackSpacingM * 0.5 + (Number(policy.outerTrackCentreClearanceM) || 0),
    );
    return {
        sourceStartM: run.startM,
        sourceEndM: run.endM,
        physicalId: policy.physicalId,
        trackCount: Number(policy.trackCount) || 2,
        trackSpacingM,
        centerOffsetM,
        boreHalfWidthM,
        clearHeightM: Number(policy.clearHeightM),
        portalCrownM: Number(policy.portalCrownM),
        ...tunnelPortalTerrainOpeningPolicy(policy),
        ...tunnelClearancePolicy(policy),
        evidence: 'curated-osm-companion-fallback',
    };
}

// Resolve the second OSM centreline onto the solved route's original chainage
// axis. Its signed lateral distance supplies the midpoint of the shared bore;
// the matching published tunnel run supplies the exact two portal chainages.
// This keeps the civil shell double-track without changing the solved route's
// driveable trackCount=1 contract.
function* measuredSharedTunnelSectionSteps(solvedFeatures, companionFeatures, context, work) {
    if (!context?.tunnelSection || !companionFeatures?.length) return null;
    const project = projectionFor([...(solvedFeatures || []), ...companionFeatures]);
    const segments = solvedSourceSegments(solvedFeatures, project);
    if (!segments.length) return null;
    const lookup = createSolvedSegmentLookup(segments);
    const measurements = [];
    for (const feature of companionFeatures) {
        for (const coordinate of lineCoordinates(feature)) {
            if (work.expired()) { yield { phase: 'rail-source:shared-tunnel' }; work.restart(); }
            const point = project(coordinate);
            const hit = lookup(point, { maxDistanceM: 10, distanceMetric: true });
            let nearest = null;
            if (hit) {
                const { segment, t, deltaX, deltaZ, distanceM } = hit;
                // Same normal convention as RailFormationModel and rails.js:
                // +(dz,-dx) is alignment-left on the solved feature direction.
                const signedOffsetM = deltaX * (segment.dz / segment.length)
                    + deltaZ * (-segment.dx / segment.length);
                nearest = {
                    distanceM,
                    signedOffsetM,
                    sourceM: segment.sourceA + (segment.sourceB - segment.sourceA) * t,
                };
            }
            if (!nearest || nearest.distanceM < 1.5 || nearest.distanceM > 10) continue;
            measurements.push(nearest);
        }
    }
    const signedTrackSpacingM = median(measurements.map(item => item.signedOffsetM));
    if (signedTrackSpacingM === null
        || Math.abs(signedTrackSpacingM) < 2
        || Math.abs(signedTrackSpacingM) > 8) return null;
    const measuredStartM = Math.min(...measurements.map(item => item.sourceM));
    const measuredEndM = Math.max(...measurements.map(item => item.sourceM));
    const civilRun = publishedTunnelRuns(solvedFeatures)
        .map(run => ({
            ...run,
            overlapM: Math.max(0,
                Math.min(run.endM, measuredEndM) - Math.max(run.startM, measuredStartM)),
            midpointGapM: Math.abs(
                (run.startM + run.endM) * 0.5 - (measuredStartM + measuredEndM) * 0.5,
            ),
        }))
        .sort((left, right) => right.overlapM - left.overlapM
            || left.midpointGapM - right.midpointGapM)[0];
    if (!civilRun || civilRun.overlapM <= 0) return null;
    const policy = context.tunnelSection;
    const trackSpacingM = Math.abs(signedTrackSpacingM);
    const boreHalfWidthM = Math.max(
        Number(policy.minimumBoreHalfWidthM) || 0,
        trackSpacingM * 0.5 + (Number(policy.outerTrackCentreClearanceM) || 0),
    );
    return {
        sourceStartM: civilRun.startM,
        sourceEndM: civilRun.endM,
        physicalId: policy.physicalId,
        trackCount: Number(policy.trackCount) || 2,
        trackSpacingM,
        centerOffsetM: signedTrackSpacingM * 0.5,
        boreHalfWidthM,
        clearHeightM: Number(policy.clearHeightM),
        portalCrownM: Number(policy.portalCrownM),
        ...tunnelPortalTerrainOpeningPolicy(policy),
        ...tunnelClearancePolicy(policy),
        evidence: 'osm-companion-centreline',
    };
}

function osmRailwayType(feature) {
    return normalizedText(
        property(feature, 'railway_type') || property(feature, 'railway'),
    );
}

function contextRoleForOsmFeature(feature, context) {
    if (osmRailwayType(feature) !== 'rail') return null;
    const wayId = normalizedOsmWayId(feature);
    if (context.tunnelCompanionOsmWayIds.has(wayId)) return 'tunnel-companion';
    if (context.surfaceOsmWayIds.has(wayId)) return 'station-yard';
    return null;
}

function* attachSolvedContextSteps(feature, context, role, elevationAtCoordinate, work) {
    const coordinates = yield* work.map(lineCoordinates(feature), (coordinate) => {
        const elevationM = elevationAtCoordinate(coordinate);
        return elevationM === null
            ? null
            : [Number(coordinate[0]), Number(coordinate[1]), elevationM];
    }, 'rail-source:context-elevations');
    if (coordinates.length < 2 || coordinates.some(coordinate => coordinate === null)) return null;
    return {
        ...feature,
        properties: {
            ...(feature.properties || {}),
            source: 'osm-solved-context',
            railProfileSource: 'solved-context',
            railContextGroupId: context.groupId,
            railContextRole: role,
            railFormationParticipation: role === 'tunnel-companion'
                ? 'visual-only'
                : 'surface',
            terrainFormation: role === 'station-yard' ? 'smooth-grade' : undefined,
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
            railMode: 'train',
            trackCount: 1,
            trackArrangement: 'single',
            ...(role === 'tunnel-companion' ? { railStructure: 'tunnel' } : {}),
        },
        geometry: { type: 'LineString', coordinates },
    };
}

function coalesceSolvedContextFragments(features) {
    const groups = new Map();
    const passthrough = [];
    for (const feature of features || []) {
        if (feature?.properties?.railProfileSource !== 'solved-context') {
            passthrough.push(feature);
            continue;
        }
        const key = [
            feature.properties.railContextGroupId,
            feature.properties.railContextRole,
            normalizedOsmWayId(feature) || streamedRailFeatureIdentity(feature),
        ].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(feature);
    }
    const combined = [...passthrough];
    for (const fragments of groups.values()) {
        const pending = fragments.map(feature => ({
            feature,
            coordinates: lineCoordinates(feature).map(coordinate => coordinate.slice()),
        }));
        while (pending.length) {
            const current = pending.shift();
            let didJoin = true;
            while (didJoin) {
                didJoin = false;
                for (let index = 0; index < pending.length; index++) {
                    const candidate = pending[index].coordinates;
                    const start = current.coordinates[0];
                    const end = current.coordinates[current.coordinates.length - 1];
                    if (sameCoordinate(end, candidate[0])) {
                        current.coordinates.push(...candidate.slice(1));
                    } else if (sameCoordinate(end, candidate[candidate.length - 1])) {
                        current.coordinates.push(...candidate.slice(0, -1).reverse());
                    } else if (sameCoordinate(start, candidate[candidate.length - 1])) {
                        current.coordinates.unshift(...candidate.slice(0, -1));
                    } else if (sameCoordinate(start, candidate[0])) {
                        current.coordinates.unshift(...candidate.slice(1).reverse());
                    } else {
                        continue;
                    }
                    pending.splice(index, 1);
                    didJoin = true;
                    break;
                }
            }
            combined.push({
                ...current.feature,
                properties: {
                    ...(current.feature.properties || {}),
                    railProfileFragment: `${streamedRailFeatureIdentity(current.feature)}:joined`,
                },
                geometry: { type: 'LineString', coordinates: current.coordinates },
            });
        }
    }
    return combined;
}

function* contextualOsmFeaturesSteps(feature, context, solvedForContext, work) {
    const wayId = normalizedOsmWayId(feature);
    if (context.coveredOsmWayIds.has(wayId)
        || context.suppressedOsmWayIds.has(wayId)) return [];
    const role = contextRoleForOsmFeature(feature, context);
    if (!role) {
        // Inside the curated station/tunnel scope, omission is intentional: do
        // not let the normal nationwide OSM fallback re-add every siding.
        const inSurfaceScope = lineCoordinates(feature).some(coordinate => (
            coordinateInsideBbox(coordinate, context.surfaceBbox)
        ));
        const inNamedTunnel = normalizedText(property(feature, 'tunnel:name'))
            === context.tunnelName;
        return inSurfaceScope || inNamedTunnel ? [] : null;
    }
    const scoped = role === 'tunnel-companion'
        ? [feature]
        : clipFeatureToBbox(feature, context.surfaceBbox);
    const elevationAtCoordinate = solvedElevationSampler(solvedForContext);
    const result = [];
    for (const candidate of scoped) {
        const attached = yield* attachSolvedContextSteps(
            candidate,
            context,
            role,
            elevationAtCoordinate, work,
        );
        if (attached) result.push(attached);
    }
    return result;
}

function* attachSharedTunnelSectionsSteps(solvedFeatures, contextFeatures, solvedContexts, work) {
    const sectionsByContext = new Map();
    for (const [context] of solvedContexts) {
        const solvedForContext = (solvedFeatures || []).filter(feature => (
            contextForSolvedFeature(feature) === context
        ));
        const companionFeatures = (contextFeatures || []).filter(feature => (
            feature?.properties?.railContextGroupId === context.groupId
            && feature?.properties?.railContextRole === 'tunnel-companion'
        ));
        const section = (yield* measuredSharedTunnelSectionSteps(
            solvedForContext,
            companionFeatures,
            context, work,
        )) || declaredSharedTunnelSection(solvedForContext, context);
        if (section) sectionsByContext.set(context, section);
    }
    return (solvedFeatures || []).map((feature) => {
        const context = contextForSolvedFeature(feature);
        const section = context ? sectionsByContext.get(context) : null;
        if (!section) return feature;
        const existingSections = feature?.properties?.railTunnelSections || [];
        const withoutDuplicate = existingSections.filter(existing => !(
            existing?.physicalId === section.physicalId
            && Math.abs(Number(existing?.sourceStartM) - section.sourceStartM) < 1e-3
            && Math.abs(Number(existing?.sourceEndM) - section.sourceEndM) < 1e-3
        ));
        return {
            ...feature,
            properties: {
                ...(feature.properties || {}),
                railTunnelSections: [
                    ...withoutDuplicate,
                    section,
                ],
            },
        };
    });
}

function terrainLocalPoint(terrainReference, coordinate) {
    const anchorLon = finiteOrNull(terrainReference?.anchorLon);
    const anchorLat = finiteOrNull(terrainReference?.anchorLat);
    const metresPerDegreeLat = finiteOrNull(terrainReference?.metresPerDegreeLat)
        ?? (EARTH_RADIUS_M * DEG_TO_RAD);
    const metresPerDegreeLon = finiteOrNull(terrainReference?.metresPerDegreeLon)
        ?? (metresPerDegreeLat * Math.cos((anchorLat ?? Number(coordinate?.[1])) * DEG_TO_RAD));
    if (anchorLon === null || anchorLat === null
        || !Number.isFinite(metresPerDegreeLon) || metresPerDegreeLon <= 0) return null;
    return {
        x: (Number(coordinate[0]) - anchorLon) * metresPerDegreeLon,
        z: -(Number(coordinate[1]) - anchorLat) * metresPerDegreeLat,
        metresPerDegreeLon,
        metresPerDegreeLat,
    };
}

function sourceSampleAt(features, sourceM, terrainReference) {
    for (const feature of features || []) {
        const coordinates = lineCoordinates(feature);
        const chainages = feature?.properties?.railSourceChainagesM;
        if (!Array.isArray(chainages) || chainages.length !== coordinates.length) continue;
        for (let index = 0; index < coordinates.length - 1; index++) {
            const sourceA = finiteOrNull(chainages[index]);
            const sourceB = finiteOrNull(chainages[index + 1]);
            if (sourceA === null || sourceB === null || Math.abs(sourceB - sourceA) < 1e-9) continue;
            if (sourceM < Math.min(sourceA, sourceB) - 1e-6
                || sourceM > Math.max(sourceA, sourceB) + 1e-6) continue;
            const t = Math.max(0, Math.min(1, (sourceM - sourceA) / (sourceB - sourceA)));
            const coordinate = interpolateCoordinate(coordinates[index], coordinates[index + 1], t);
            const a = terrainLocalPoint(terrainReference, coordinates[index]);
            const b = terrainLocalPoint(terrainReference, coordinates[index + 1]);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const length = Math.hypot(dx, dz);
            if (length < 1e-6) continue;
            return {
                coordinate,
                elevationM: finiteOrNull(coordinate[2]),
                x: a.x + dx * t,
                z: a.z + dz * t,
                normalX: dz / length,
                normalZ: -dx / length,
            };
        }
    }
    return null;
}

function terrainAbsoluteYAt(terrainReference, x, z) {
    if (typeof terrainReference?.evidenceSceneYAtLocal !== 'function') return null;
    const sceneY = finiteOrNull(
        terrainReference.evidenceSceneYAtLocal(x, z),
    );
    const anchorHeightM = finiteOrNull(terrainReference.anchorHeightM);
    return sceneY === null || anchorHeightM === null ? null : sceneY + anchorHeightM;
}

function uniqueTunnelSections(features) {
    const sections = new Map();
    for (const feature of features || []) {
        for (const section of feature?.properties?.railTunnelSections || []) {
            const startM = finiteOrNull(section?.sourceStartM);
            const endM = finiteOrNull(section?.sourceEndM);
            if (startM === null || endM === null || endM <= startM) continue;
            const key = `${section?.physicalId || ''}:${startM.toFixed(3)}:${endM.toFixed(3)}`;
            if (!sections.has(key)) sections.set(key, { ...section, sourceStartM: startM, sourceEndM: endM });
        }
    }
    return [...sections.values()];
}

function* tunnelClearanceConstraintsSteps(features, terrainReference, work) {
    const constraints = [];
    for (const section of uniqueTunnelSections(features)) {
        const clearHeightM = finiteOrNull(section.clearHeightM);
        const boreHalfWidthM = finiteOrNull(section.boreHalfWidthM);
        if (clearHeightM === null || clearHeightM <= 0
            || boreHalfWidthM === null || boreHalfWidthM <= 0) continue;
        const centerOffsetM = finiteOrNull(section.centerOffsetM) ?? 0;
        const minimumRoofCoverM = Math.max(0, finiteOrNull(section.minimumRoofCoverM) ?? 0);
        const stepM = Math.max(1, finiteOrNull(section.clearanceSampleStepM)
            ?? DEFAULT_CLEARANCE_SAMPLE_STEP_M);
        const spanM = section.sourceEndM - section.sourceStartM;
        const parts = Math.max(1, Math.ceil(spanM / stepM));
        for (let index = 0; index <= parts; index++) {
            if (work.expired()) { yield { phase: 'rail-source:clearance-samples' }; work.restart(); }
            const sourceM = index === parts
                ? section.sourceEndM
                : section.sourceStartM + spanM * index / parts;
            const sample = sourceSampleAt(features, sourceM, terrainReference);
            if (!sample || sample.elevationM === null) continue;
            const atPortal = index === 0 || index === parts;
            // A portal is an open headwall, not another metre of buried tube.
            // Sampling its full face as roof cover makes the lowest retained
            // edge control the whole alignment; at Split that turned the
            // engineered open portal into a five-metre-deep rural cutting.
            // The first interior sample still protects the actual tunnel roof.
            if (atPortal) continue;
            const lateralHalfWidthM = boreHalfWidthM;
            const lateralParts = Math.max(
                2,
                Math.ceil((lateralHalfWidthM * 2) / DEFAULT_CLEARANCE_CROSS_STEP_M),
            );
            let minimumTerrainM = Infinity;
            for (let lateralIndex = 0; lateralIndex <= lateralParts; lateralIndex++) {
                const lateralM = centerOffsetM - lateralHalfWidthM
                    + lateralHalfWidthM * 2 * lateralIndex / lateralParts;
                const terrainM = terrainAbsoluteYAt(
                    terrainReference,
                    sample.x + sample.normalX * lateralM,
                    sample.z + sample.normalZ * lateralM,
                );
                if (terrainM !== null) minimumTerrainM = Math.min(minimumTerrainM, terrainM);
            }
            if (!Number.isFinite(minimumTerrainM)) continue;
            const maximumRailElevationM = minimumTerrainM
                - RENDERED_TUNNEL_BED_ABOVE_RAIL_M - clearHeightM - minimumRoofCoverM;
            const requiredDropM = sample.elevationM - maximumRailElevationM;
            if (requiredDropM > 1e-4) {
                constraints.push({
                    sourceM,
                    requiredDropM,
                    maximumVerticalAdjustmentGrade: Math.max(
                        0,
                        finiteOrNull(section.maximumVerticalAdjustmentGrade) ?? 0,
                    ),
                    physicalId: section.physicalId || null,
                });
            }
        }
    }
    return constraints;
}

function insertConstraintChainages(feature, constraints) {
    const coordinates = lineCoordinates(feature);
    const chainages = feature?.properties?.railSourceChainagesM;
    if (!Array.isArray(chainages) || chainages.length !== coordinates.length) {
        return { coordinates: coordinates.map(coordinate => coordinate.slice()), chainages: null };
    }
    const nextCoordinates = [];
    const nextChainages = [];
    for (let index = 0; index < coordinates.length - 1; index++) {
        const a = coordinates[index];
        const b = coordinates[index + 1];
        const sourceA = Number(chainages[index]);
        const sourceB = Number(chainages[index + 1]);
        if (index === 0) {
            nextCoordinates.push(a.slice());
            nextChainages.push(sourceA);
        }
        const inserted = constraints
            .map(constraint => constraint.sourceM)
            .filter(sourceM => sourceM > Math.min(sourceA, sourceB) + 1e-6
                && sourceM < Math.max(sourceA, sourceB) - 1e-6)
            .sort((left, right) => sourceA <= sourceB ? left - right : right - left);
        for (const sourceM of inserted) {
            const t = (sourceM - sourceA) / (sourceB - sourceA);
            nextCoordinates.push(interpolateCoordinate(a, b, t));
            nextChainages.push(sourceM);
        }
        nextCoordinates.push(b.slice());
        nextChainages.push(sourceB);
    }
    return { coordinates: nextCoordinates, chainages: nextChainages };
}

// Reconstructed heights are evidence, but the complete civil envelope is the
// render contract. Lower an authority wherever its tunnel would pierce the
// rendered terrain and spread that correction along source chainage with a
// bounded added grade. This is deterministic semantic resolution; streaming
// or draw order never decides the winning elevation.
export function resolveSolvedTunnelClearance(features, terrainReference) {
    return finishRailSourceSteps(resolveSolvedTunnelClearanceSteps(features, terrainReference, createRailSourceWork()));
}

function* resolveSolvedTunnelClearanceSteps(features, terrainReference, work) {
    if (!terrainReference || typeof terrainReference.evidenceSceneYAtLocal !== 'function') {
        return features || [];
    }
    const groups = new Map();
    const ungrouped = [];
    for (const feature of features || []) {
        const groupId = feature?.properties?.railContextGroupId;
        if (!groupId) {
            ungrouped.push(feature);
            continue;
        }
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(feature);
    }
    const resolvedByFeature = new Map();
    for (const groupedFeatures of groups.values()) {
        const constraints = yield* tunnelClearanceConstraintsSteps(groupedFeatures, terrainReference, work);
        if (constraints.length === 0) continue;
        for (const feature of groupedFeatures) {
            const expanded = insertConstraintChainages(feature, constraints);
            if (!expanded.chainages) continue;
            let maxDropM = 0;
            const coordinates = yield* work.map(expanded.coordinates, (coordinate, index) => {
                const sourceM = expanded.chainages[index];
                let dropM = 0;
                for (const constraint of constraints) {
                    const candidate = constraint.requiredDropM
                        - constraint.maximumVerticalAdjustmentGrade
                            * Math.abs(sourceM - constraint.sourceM);
                    if (candidate > dropM) dropM = candidate;
                }
                dropM = Math.max(0, dropM);
                maxDropM = Math.max(maxDropM, dropM);
                const elevationM = finiteOrNull(coordinate[2]);
                return elevationM === null || dropM <= 1e-6
                    ? coordinate.slice()
                    : [Number(coordinate[0]), Number(coordinate[1]), elevationM - dropM];
            }, 'rail-source:clearance-profile');
            resolvedByFeature.set(feature, {
                ...feature,
                properties: {
                    ...(feature.properties || {}),
                    railSourceChainagesM: expanded.chainages,
                    railTunnelClearanceResolution: {
                        constraintCount: constraints.length,
                        maxDropM,
                        method: 'terrain-envelope-grade-bounded',
                    },
                },
                geometry: { type: 'LineString', coordinates },
            });
        }
    }
    return (features || []).map(feature => resolvedByFeature.get(feature) || feature);
}

function* rebaseSolvedContextFeaturesSteps(contextFeatures, resolvedSolved, work) {
    const solvedByGroup = new Map();
    for (const feature of resolvedSolved || []) {
        const groupId = feature?.properties?.railContextGroupId;
        if (!groupId) continue;
        if (!solvedByGroup.has(groupId)) solvedByGroup.set(groupId, []);
        solvedByGroup.get(groupId).push(feature);
    }
    const samplers = new Map();
    const result = [];
    for (const feature of contextFeatures || []) {
        if (feature?.properties?.railProfileSource !== 'solved-context') { result.push(feature); continue; }
        const groupId = feature.properties.railContextGroupId;
        const authorities = solvedByGroup.get(groupId);
        if (!authorities?.length) { result.push(feature); continue; }
        if (!samplers.has(groupId)) samplers.set(groupId, solvedElevationSampler(authorities));
        const elevationAt = samplers.get(groupId);
        const coordinates = yield* work.map(lineCoordinates(feature), (coordinate) => {
            const elevationM = elevationAt(coordinate);
            return elevationM === null
                ? coordinate.slice()
                : [Number(coordinate[0]), Number(coordinate[1]), elevationM];
        }, 'rail-source:context-rebase');
        result.push({ ...feature, geometry: { type: 'LineString', coordinates } });
    }
    return result;
}

function fallbackCompanionCoordinates(authorities, section) {
    const samples = [];
    for (const sourceM of [section.sourceStartM, section.sourceEndM]) {
        const sample = sourceSampleAt(authorities, sourceM, {
            anchorLon: 0,
            anchorLat: 0,
            metresPerDegreeLon: EARTH_RADIUS_M * DEG_TO_RAD,
            metresPerDegreeLat: EARTH_RADIUS_M * DEG_TO_RAD,
        });
        if (sample?.coordinate) samples.push({ sourceM, coordinate: sample.coordinate });
    }
    for (const feature of authorities || []) {
        const coordinates = lineCoordinates(feature);
        const chainages = feature?.properties?.railSourceChainagesM;
        if (!Array.isArray(chainages) || chainages.length !== coordinates.length) continue;
        for (let index = 0; index < coordinates.length; index++) {
            const sourceM = finiteOrNull(chainages[index]);
            if (sourceM === null || sourceM <= section.sourceStartM + 1e-6
                || sourceM >= section.sourceEndM - 1e-6) continue;
            samples.push({ sourceM, coordinate: coordinates[index].slice() });
        }
    }
    samples.sort((left, right) => left.sourceM - right.sourceM);
    const deduped = samples.filter((sample, index) => (
        index === 0 || Math.abs(sample.sourceM - samples[index - 1].sourceM) > 1e-6
    ));
    if (deduped.length < 2) return [];
    const signedSpacingM = Math.sign(Number(section.centerOffsetM) || -1)
        * Number(section.trackSpacingM);
    return deduped.map((sample, index) => {
        const previous = deduped[Math.max(0, index - 1)].coordinate;
        const next = deduped[Math.min(deduped.length - 1, index + 1)].coordinate;
        const latitude = Number(sample.coordinate[1]);
        const metresPerDegreeLat = EARTH_RADIUS_M * DEG_TO_RAD;
        const metresPerDegreeLon = metresPerDegreeLat * Math.cos(latitude * DEG_TO_RAD);
        const dx = (Number(next[0]) - Number(previous[0])) * metresPerDegreeLon;
        const dz = -(Number(next[1]) - Number(previous[1])) * metresPerDegreeLat;
        const length = Math.hypot(dx, dz) || 1;
        const normalX = dz / length;
        const normalZ = -dx / length;
        return [
            Number(sample.coordinate[0]) + normalX * signedSpacingM / metresPerDegreeLon,
            Number(sample.coordinate[1]) - normalZ * signedSpacingM / metresPerDegreeLat,
            Number(sample.coordinate[2]),
        ];
    });
}

function synthesizeMissingTunnelCompanions(resolvedSolved, contextFeatures, solvedContexts) {
    const synthetic = [];
    for (const [context] of solvedContexts) {
        const alreadyPresent = (contextFeatures || []).some(feature => (
            feature?.properties?.railContextGroupId === context.groupId
            && feature?.properties?.railContextRole === 'tunnel-companion'
        ));
        if (alreadyPresent) continue;
        const authorities = (resolvedSolved || []).filter(feature => (
            feature?.properties?.railContextGroupId === context.groupId
            && feature?.properties?.railContextRole === 'solved-authority'
        ));
        const section = uniqueTunnelSections(authorities)[0];
        if (!section || !(Number(section.trackSpacingM) > 0)) continue;
        const coordinates = fallbackCompanionCoordinates(authorities, section);
        if (coordinates.length < 2) continue;
        synthetic.push({
            type: 'Feature',
            properties: {
                source: 'curated-solved-context',
                railway_type: 'rail',
                railway: 'rail',
                railProfileSource: 'solved-context',
                railProfileFragment: `${context.groupId}:fallback-tunnel-companion`,
                railContextGroupId: context.groupId,
                railContextRole: 'tunnel-companion',
                railContextEvidence: section.evidence,
                railFormationParticipation: 'visual-only',
                elevationMode: 'absolute',
                elevationDatum: 'EVRF2000',
                railMode: 'train',
                trackCount: 1,
                trackArrangement: 'single',
                railStructure: 'tunnel',
                railPhysicalId: section.physicalId,
            },
            geometry: { type: 'LineString', coordinates },
        });
    }
    return synthetic;
}

// Multiple reconstructed projects may share a physical trunk before branching.
// Keep the newest project on the shared metres, but preserve every uncovered
// continuation. Grouping by project prevents one track/span from erasing a
// sibling span belonging to the same reconstruction.
export function canonicalSolvedRailFeatures(features, options = {}) {
    return finishRailSourceSteps(canonicalSolvedRailFeaturesSteps(features, options, createRailSourceWork()));
}

function* canonicalSolvedRailFeaturesSteps(features, options, work) {
    const groups = new Map();
    for (const feature of (features || []).filter(isSolvedRailFeature)) {
        const priority = solvedProjectPriority(feature);
        if (!groups.has(priority)) groups.set(priority, []);
        groups.get(priority).push(feature);
    }
    const selected = [];
    for (const priority of [...groups.keys()].sort((a, b) => b - a)) {
        const coverage = buildCoverageIndex(selected, options);
        for (const feature of groups.get(priority)) {
            selected.push(...(yield* clipFeatureAgainstCoverageSteps(feature, coverage, options, work)));
        }
    }
    return selected;
}

export function resolveRailProfileFeatures(options = {}) {
    return finishRailSourceSteps(resolveRailProfileFeaturesSteps(options));
}

// The synchronous API and the streamed generation drain this same compiler.
// Spatial matching and terrain clearance yield inside dense coordinate loops;
// new rail tiles cannot resolve a complete solved route in one frame callback.
export function* resolveRailProfileFeaturesSteps({
    osmFeatures = [],
    solvedFeatures = [],
    mode = RAIL_PROFILE_OSM,
    coverageOptions = {},
    terrainReference = null,
} = {}, scheduling = {}) {
    const work = createRailSourceWork(scheduling);
    const normalizedMode = normalizeRailProfileMode(mode);
    if (normalizedMode === RAIL_PROFILE_OSM) {
        return yield* work.map(osmFeatures || [], prepareOsmRailFeature, 'rail-source:osm');
    }
    const solved = yield* canonicalSolvedRailFeaturesSteps(solvedFeatures, coverageOptions, work);
    yield { phase: 'rail-source:canonical' }; work.restart();
    if (solved.length === 0) return yield* work.map(osmFeatures || [], prepareOsmRailFeature, 'rail-source:osm');
    const solvedContexts = new Map();
    for (const feature of solved) {
        const context = contextForSolvedFeature(feature);
        if (!context) continue;
        if (!solvedContexts.has(context)) solvedContexts.set(context, []);
        solvedContexts.get(context).push(feature);
    }
    const taggedSolved = solved.map((feature) => {
        const context = contextForSolvedFeature(feature);
        return context ? {
            ...feature,
            properties: {
                ...(feature.properties || {}),
                railContextGroupId: context.groupId,
                railContextRole: 'solved-authority',
                ...(context.formationSections?.length ? {
                    railFormationSections: context.formationSections.map(section => ({
                        ...section,
                    })),
                } : {}),
                ...(context.roadInterfaces?.length ? {
                    railRoadInterfaces: context.roadInterfaces.map(declaration => ({
                        ...declaration,
                    })),
                } : {}),
            },
        } : feature;
    });
    const coverage = buildCoverageIndex(taggedSolved, coverageOptions);
    yield { phase: 'rail-source:coverage-index' }; work.restart();
    const uncoveredOsm = [];
    for (const feature of osmFeatures || []) {
        let contextual = null;
        for (const [context, solvedForContext] of solvedContexts) {
            contextual = yield* contextualOsmFeaturesSteps(feature, context, solvedForContext, work);
            if (contextual !== null) break;
        }
        if (contextual !== null) {
            uncoveredOsm.push(...contextual);
            continue;
        }
        uncoveredOsm.push(...(yield* clipFeatureAgainstCoverageSteps(feature, coverage, coverageOptions, work)));
    }
    const preparedContext = coalesceSolvedContextFragments(uncoveredOsm)
        .map(prepareOsmRailFeature);
    yield { phase: 'rail-source:context' }; work.restart();
    const solvedWithSections = yield* attachSharedTunnelSectionsSteps(
        taggedSolved,
        preparedContext,
        solvedContexts, work,
    );
    // Measure the physical pair on its source geometry first, then move the
    // authority and every nearby visual context track together. This keeps the
    // declared bore width/axis stable while applying the reviewed site fix.
    yield { phase: 'rail-source:tunnel-sections' }; work.restart();
    const horizontallyResolvedSolved = resolveSolvedRailAlignment(
        solvedWithSections,
    );
    yield { phase: 'rail-source:solved-alignment' }; work.restart();
    const horizontallyResolvedContext = yield* applyContextAlignmentCorrectionsSteps(
        preparedContext,
        solvedContexts, work,
    );
    const resolvedSolved = yield* resolveSolvedTunnelClearanceSteps(
        horizontallyResolvedSolved,
        terrainReference, work,
    );
    const rebasedContext = yield* rebaseSolvedContextFeaturesSteps(
        horizontallyResolvedContext,
        resolvedSolved, work,
    );
    yield { phase: 'rail-source:rebase' }; work.restart();
    return [
        ...resolvedSolved,
        ...rebasedContext,
        ...synthesizeMissingTunnelCompanions(resolvedSolved, rebasedContext, solvedContexts),
    ];
}
