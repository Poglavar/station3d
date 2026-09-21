// Runs the pure track-geometry functions out of transit.js in a vm with a
// minimal Leaflet stub, so the curve/smoothing maths can be tested headlessly
// without extracting it from the 15k-line classic script. Functions are pulled
// out by name: a rename fails loudly here rather than silently skipping a test.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const TRANSIT_PATH = new URL('../../../transit.js', import.meta.url);

const CONSTANTS = [
    'TRACK_LEVEL_MIN', 'TRACK_LEVEL_MAX', 'LEVEL_HEIGHT_METERS',
    'TRACK_CENTER_SPACING_METERS', 'UNDERGROUND_TRACK_CENTER_SPACING_METERS', 'GAUGES',
    'EARTH_RADIUS_M', 'DEG_TO_RAD', 'TRACK_MIN_FULL_LEVEL_LENGTH_M',
    'TRACK_CURVE_MIN_TURN_DEG', 'TRACK_CURVE_MAX_TURN_DEG', 'TRACK_CURVE_SAMPLE_SPACING_M',
    'TRACK_CURVE_LENGTH_EPSILON_M', 'LEGACY_CURVE_MAX_FILLET_M', 'LEGACY_CURVE_ADJ_LEN_FRACTION',
    'LEGACY_CURVE_MIN_ADJ_LEN_M', 'TRACK_LEVEL_FULL_EPSILON', 'SMOOTHING_CHUNK_MARGIN',
    'SMOOTHING_INCREMENTAL_MAX_MOVED_VERTICES', 'NEAREST_POINT_HINT_WINDOW_SEGMENTS',
];

const FUNCTIONS = [
    'normalizeGauge', 'getTrackCenterSpacingMeters', 'getPlannerCenterlineMinCurveRadiusMeters',
    'getMinLevelChangeMeters', 'normalizeTrackElevationLevel', 'isExplicitRampSegment',
    'getTrackSegmentLevelProfile', 'getContinuousTrackLevel', 'distanceMetersLatLng',
    'buildTrackCurvePlan', 'getCurvePlanWindowForSegments', 'getTrackCurveViolations',
    'pushUniqueSmoothedPoint', 'appendCircularTrackCurve', 'appendLegacyTrackCurve',
    'buildSmoothedVertexChunk', 'snapshotLatLngs', 'findMovedVertexRange', 'samePointList',
    'buildTrackSmoothingCacheEntry', 'patchTrackSmoothingCacheEntry', 'resampleLatLngsSmooth',
    'latLngToLocalMeters', 'localMetersToLatLng', 'interpolateSegmentPosition',
    'isFullTrackLevel', 'buildTrackChainage',
    'nearestPointOnSegment', 'nearestPointOnTrack', 'nearestPointOnTrackWithinOffsets',
    'nearestFullLevelPointOnTrack',
];

function sliceDeclaration(lines, header, isEnd) {
    const start = lines.findIndex(line => line.startsWith(header));
    if (start < 0) throw new Error(`transit.js no longer declares: ${header.trim()}`);
    let end = start;
    while (end < lines.length && !isEnd(lines[end])) end++;
    if (end >= lines.length) throw new Error(`unterminated declaration: ${header.trim()}`);
    return lines.slice(start, end + 1).join('\n');
}

// A top-level function in this file always closes on a bare `}` in column 0;
// a top-level const always closes on the first line ending in `;`.
const sliceFunction = (lines, name) => sliceDeclaration(lines, `function ${name}(`, line => line === '}');
const sliceConst = (lines, name) => sliceDeclaration(lines, `const ${name} `, line => line.trimEnd().endsWith(';'));

class StubLatLng {
    constructor(lat, lng) { this.lat = lat; this.lng = lng; }
    distanceTo(other) {
        const R = 6371000;
        const d = Math.PI / 180;
        const dLat = (other.lat - this.lat) * d;
        const dLng = (other.lng - this.lng) * d;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(this.lat * d) * Math.cos(other.lat * d) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}

export function createTransitGeometrySandbox() {
    const lines = readFileSync(TRANSIT_PATH, 'utf8').split('\n');
    const source = [
        ...CONSTANTS.map(name => sliceConst(lines, name)),
        'const trackSmoothingCache = new WeakMap();',
        ...FUNCTIONS.map(name => sliceFunction(lines, name)),
        // A top-level `function` becomes a property of the vm's global object,
        // but a top-level `const` does NOT — it lives in the script's lexical
        // scope. Without this, every constant read out of the sandbox was
        // silently `undefined`, which is exactly the kind of quiet wrongness a
        // test oracle must not be built on.
        ...CONSTANTS.map(name => `globalThis.${name} = ${name};`),
    ].join('\n\n');

    const sandbox = {
        L: { latLng: (a, b) => (a instanceof StubLatLng ? a : new StubLatLng(a, b)) },
        TEST_CONFIG: {},
        WeakMap,
        Float64Array,
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'transit-geometry-slice.js' });
    return sandbox;
}

// A gently meandering line, long enough that arcs and legacy fillets both fire.
export function makeWindingTrack(count, { stepM = 60, amplitudeM = 90, period = 11 } = {}) {
    const originLat = 45.6;
    const mPerLat = (Math.PI / 180) * 6371000;
    const mPerLon = mPerLat * Math.cos(originLat * Math.PI / 180);
    const latlngs = [];
    for (let i = 0; i < count; i++) {
        const alongM = i * stepM;
        const acrossM = Math.sin((i / period) * Math.PI * 2) * amplitudeM
            + Math.sin((i / 3.7) * Math.PI * 2) * amplitudeM * 0.25;
        latlngs.push([originLat + acrossM / mPerLat, 16 + alongM / mPerLon]);
    }
    return latlngs;
}

// Deterministic 0..1 generator — Math.random() is banned in this repo's jobs
// and makes a failing case impossible to reproduce.
export function makeSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
