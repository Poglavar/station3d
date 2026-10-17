// Decodes a consensus-builder corridor record into the stretches and
// cross-sections Station3D draws. consensus-builder stores and publishes a
// corridor as an OSM document under `definition.osm` (frontend/js/
// corridor-osm-form.js, toRecord); every reader decodes it, as its toView does.
// This mirrors that decoder (definitionFromOsmForm, profileFromLaneTags,
// corridor-profile.js corridorProfileFromOsmTags) so both apps read one shape.

// ---- cross-section vocabulary (consensus-builder corridor-profile.js) -------

const LANE_TYPES = {
    driving: { directional: true },
    bus: { directional: true },
    parking: { orientation: 'parallel' },
    parking_perpendicular: { orientation: 'perpendicular' },
    parking_angled: { orientation: 'angled' },
    cycleway: { directional: true },
    sidewalk: {},
    verge: {},
    median: {},
    rail: {},
};
const GREEN_TYPES = new Set(['verge', 'median']);
const LANDSCAPES = ['grass', 'trees'];
const PAVINGS = ['asphalt', 'paved'];
const PAVED_TYPES = new Set(['sidewalk']);
const DIRECTIONS = ['forward', 'backward', 'both'];
const RAIL_GAUGES = [1000, 1435];
const DEFAULT_RAIL_GAUGE = 1435;
const RAIL_GAUGE_WIDTHS = { 1000: 2.75, 1435: 3.5 };

const OSM_DEFAULT_SIDEWALK_WIDTH = 2;
const OSM_DEFAULT_CYCLEWAY_WIDTH = 1.5;
const OSM_DEFAULT_PARKING_WIDTH = 2.5;
const PARKING_PERPENDICULAR_WIDTH = 5;
const PARKING_ANGLED_WIDTH = 4.5;
const OSM_DEFAULT_VERGE_WIDTH = 1.5;
const OSM_DEFAULT_MEDIAN_WIDTH = 2.5;
const OSM_LANE_WIDTH_BY_HIGHWAY = {
    motorway: 3.75, motorway_link: 3.5, trunk: 3.5, trunk_link: 3.25,
    primary: 3.5, primary_link: 3.25, secondary: 3.25, secondary_link: 3,
    tertiary: 3, tertiary_link: 3, residential: 3, unclassified: 3,
    living_street: 2.75, service: 2.75, track: 2.5, busway: 3.5, road: 3,
};
const OSM_DEFAULT_LANE_WIDTH = 3;
const OSM_CARRIAGEWAY_FREE_HIGHWAYS = {
    footway: { type: 'sidewalk', width: 2 },
    path: { type: 'sidewalk', width: 2 },
    steps: { type: 'sidewalk', width: 2 },
    bridleway: { type: 'sidewalk', width: 2 },
    pedestrian: { type: 'sidewalk', width: 8 },
    cycleway: { type: 'cycleway', width: 2.5 },
};
const OSM_SINGLE_LANE_HIGHWAYS = new Set(['service', 'track']);
const STANDARD_WIDTHS = {
    driving: OSM_DEFAULT_LANE_WIDTH,
    bus: OSM_LANE_WIDTH_BY_HIGHWAY.busway,
    parking: OSM_DEFAULT_PARKING_WIDTH,
    parking_perpendicular: PARKING_PERPENDICULAR_WIDTH,
    parking_angled: PARKING_ANGLED_WIDTH,
    cycleway: OSM_DEFAULT_CYCLEWAY_WIDTH,
    sidewalk: OSM_DEFAULT_SIDEWALK_WIDTH,
    verge: OSM_DEFAULT_VERGE_WIDTH,
    median: OSM_DEFAULT_MEDIAN_WIDTH,
};
const OSM_ABSENT = new Set(['no', 'none', 'separate', 'false', '0']);
const CARRIAGEWAY_TYPES = new Set(['driving', 'bus']);
const SURFACE_PAVING = { paving_stones: 'paved', sett: 'paved', asphalt: 'asphalt' };

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round3 = value => Math.round(value * 1000) / 1000;
const isLaneType = type => Object.prototype.hasOwnProperty.call(LANE_TYPES, type);
const parkingOrientation = type => (isLaneType(type) && LANE_TYPES[type].orientation) || null;

function railGauge(gauge) {
    const value = parseInt(gauge, 10);
    return RAIL_GAUGES.includes(value) ? value : DEFAULT_RAIL_GAUGE;
}

function standardWidth(type, gauge) {
    if (type === 'rail') return RAIL_GAUGE_WIDTHS[railGauge(gauge)];
    return STANDARD_WIDTHS[type] || OSM_DEFAULT_LANE_WIDTH;
}

export function normalizeCorridorRecordProfile(profile) {
    const raw = Array.isArray(profile) ? profile : (profile && Array.isArray(profile.strips) ? profile.strips : null);
    if (!raw) return null;
    const strips = raw.map((strip) => {
        const type = String(strip && strip.type);
        const lane = { type, width: Number(strip && strip.width) };
        const direction = strip && strip.direction;
        if (isLaneType(type) && LANE_TYPES[type].directional && DIRECTIONS.includes(direction)) {
            lane.direction = direction;
        }
        if (GREEN_TYPES.has(type) && LANDSCAPES.includes(strip && strip.landscape)) lane.landscape = strip.landscape;
        if (parkingOrientation(type)) {
            const treeEvery = parseInt(strip && strip.treeEvery, 10);
            if (Number.isFinite(treeEvery) && treeEvery > 0) lane.treeEvery = treeEvery;
        }
        if (type === 'rail') lane.gauge = railGauge(strip && strip.gauge);
        if (PAVED_TYPES.has(type) && PAVINGS.includes(strip && strip.paving)) lane.paving = strip.paving;
        return lane;
    }).filter(strip => isLaneType(strip.type) && Number.isFinite(strip.width) && strip.width > 0);
    return strips.length ? { strips } : null;
}

function profileWidth(profile) {
    const normalized = normalizeCorridorRecordProfile(profile);
    return normalized ? normalized.strips.reduce((total, strip) => total + strip.width, 0) : 0;
}

// ---- OSM way tags -> cross-section ------------------------------------------

function parseOsmNumber(value) {
    if (value === undefined || value === null) return NaN;
    const number = parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : NaN;
}

function osmSideValue(tags, key, side) {
    if (!tags) return undefined;
    const specific = tags[`${key}:${side}`];
    if (specific !== undefined) return specific;
    const both = tags[`${key}:both`];
    if (both !== undefined) return both;
    const bare = tags[key];
    if (bare === undefined) return undefined;
    if (bare === 'left' || bare === 'right') return bare === side ? 'yes' : 'no';
    if (bare === 'both') return 'yes';
    return bare;
}

function osmSideWidth(tags, key, side, fallback) {
    for (const candidate of [`${key}:${side}:width`, `${key}:both:width`, `${key}:width`]) {
        const width = parseOsmNumber(tags && tags[candidate]);
        if (Number.isFinite(width) && width > 0) return width;
    }
    return fallback;
}

const osmSidePresent = value => value !== undefined && !OSM_ABSENT.has(String(value));

function osmParkingOrientation(tags, side) {
    if (!tags) return undefined;
    const explicit = [`parking:${side}:orientation`, 'parking:both:orientation', 'parking:orientation']
        .map(key => tags[key])
        .find(value => value !== undefined);
    if (explicit !== undefined) return explicit;
    return osmSideValue(tags, 'parking:lane', side);
}

function parkingTypeFromOsm(orientation) {
    if (orientation === 'perpendicular') return 'parking_perpendicular';
    if (orientation === 'diagonal' || orientation === 'inclined') return 'parking_angled';
    return 'parking';
}

// consensus-builder corridorProfileFromOsmTags: the standard OSM lane scheme.
function profileFromStandardTags(tags) {
    const source = tags || {};
    if (source.railway) {
        const gauge = railGauge(source.gauge);
        const tracks = Math.max(1, parseInt(source.tracks, 10) || 1);
        const railWidth = parseOsmNumber(source.width) || (standardWidth('rail', gauge) * tracks);
        return { strips: Array.from({ length: tracks }, () => ({ type: 'rail', width: railWidth / tracks, gauge })) };
    }
    const taggedWidth = parseOsmNumber(source.width) || 0;
    const carriagewayFree = OSM_CARRIAGEWAY_FREE_HIGHWAYS[source.highway];
    if (carriagewayFree) {
        return normalizeCorridorRecordProfile([{
            type: carriagewayFree.type,
            width: taggedWidth > 0 ? taggedWidth : carriagewayFree.width,
            direction: carriagewayFree.type === 'cycleway' ? 'both' : undefined,
        }]);
    }
    if (!source.highway && !(taggedWidth > 0)) return null;

    const oneway = source.oneway === 'yes' || source.oneway === '-1';
    const defaultLanes = oneway || OSM_SINGLE_LANE_HIGHWAYS.has(source.highway) ? 1 : 2;
    const laneCount = Math.max(1, parseInt(source.lanes, 10) || defaultLanes);
    const bothWaysCount = Math.min(laneCount, Math.max(0, parseInt(source['lanes:both_ways'], 10) || 0));
    const directedCount = laneCount - bothWaysCount;
    const taggedForward = parseInt(source['lanes:forward'], 10);
    const taggedBackward = parseInt(source['lanes:backward'], 10);
    const wantedForward = Number.isFinite(taggedForward)
        ? taggedForward
        : (Number.isFinite(taggedBackward)
            ? directedCount - taggedBackward
            : (oneway ? (source.oneway === '-1' ? 0 : directedCount) : Math.ceil(directedCount / 2)));
    const forwardCount = Math.max(0, Math.min(directedCount, wantedForward));
    const backwardCount = directedCount - forwardCount;

    const cyclewayDirection = (side) => {
        const own = source[`cycleway:${side}:oneway`] ?? source['cycleway:both:oneway'];
        if (own === 'yes') return 'forward';
        if (own === '-1') return 'backward';
        if (own === 'no') return 'both';
        if (source.oneway === 'yes') return 'forward';
        if (source.oneway === '-1') return 'backward';
        return side === 'left' ? 'backward' : 'forward';
    };

    const left = [];
    const right = [];
    for (const side of ['left', 'right']) {
        const target = side === 'left' ? left : right;
        if (osmSidePresent(osmSideValue(source, 'sidewalk', side))) {
            target.push({ type: 'sidewalk', width: osmSideWidth(source, 'sidewalk', side, OSM_DEFAULT_SIDEWALK_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'verge', side))) {
            target.push({ type: 'verge', width: osmSideWidth(source, 'verge', side, OSM_DEFAULT_VERGE_WIDTH) });
        }
        if (osmSidePresent(osmSideValue(source, 'cycleway', side))) {
            target.push({
                type: 'cycleway',
                width: osmSideWidth(source, 'cycleway', side, OSM_DEFAULT_CYCLEWAY_WIDTH),
                direction: cyclewayDirection(side),
            });
        }
        if (osmSidePresent(osmSideValue(source, 'parking', side))
            || osmSidePresent(osmSideValue(source, 'parking:lane', side))) {
            const parkingType = parkingTypeFromOsm(osmParkingOrientation(source, side));
            target.push({ type: parkingType, width: osmSideWidth(source, 'parking', side, standardWidth(parkingType)) });
        }
    }

    const medianWidth = osmSidePresent(source.median)
        ? (parseOsmNumber(source['median:width']) || OSM_DEFAULT_MEDIAN_WIDTH)
        : 0;
    const flanks = [...left, ...right].reduce((sum, lane) => sum + lane.width, 0) + medianWidth;
    const defaultLaneWidth = OSM_LANE_WIDTH_BY_HIGHWAY[source.highway] || OSM_DEFAULT_LANE_WIDTH;
    const carriageway = taggedWidth > 0 ? taggedWidth - flanks : laneCount * defaultLaneWidth;
    if (carriageway < laneCount * 2) return null;

    const laneWidth = round3(carriageway / laneCount);
    const driving = Array.from({ length: laneCount }, (unused, index) => ({
        type: 'driving',
        width: laneWidth,
        direction: index < backwardCount
            ? 'backward'
            : (index < backwardCount + bothWaysCount ? 'both' : 'forward'),
    }));
    driving[driving.length - 1].width = round3(carriageway - laneWidth * (laneCount - 1));
    const carriagewayLanes = medianWidth
        ? [...driving.slice(0, backwardCount), { type: 'median', width: medianWidth }, ...driving.slice(backwardCount)]
        : driving;
    return normalizeCorridorRecordProfile([...left, ...carriagewayLanes, ...right.reverse()]);
}

function decodeLane(text) {
    const [type, width, ...rest] = String(text).split(':');
    const lane = { type, width: Number(width) };
    for (const part of rest) {
        const eq = part.indexOf('=');
        if (eq === -1) lane.direction = part;
        else lane[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return lane;
}

// consensus-builder corridor-osm-form.js profileFromLaneTags: `cb:lanes`
// carries the lanes whole; otherwise the standard scheme plus its refinements.
export function corridorProfileFromWayTags(tags) {
    const source = tags || {};
    if (source['cb:lanes']) {
        return normalizeCorridorRecordProfile({ strips: String(source['cb:lanes']).split('|').map(decodeLane) });
    }
    const base = profileFromStandardTags({ ...source, highway: source.highway || (source.railway ? undefined : 'road') });
    if (!base) return null;
    const lanes = base.strips.map(lane => ({ ...lane }));
    const carriageway = lanes.filter(lane => CARRIAGEWAY_TYPES.has(lane.type));
    const widths = source['width:lanes'] ? String(source['width:lanes']).split('|').map(Number) : null;
    const buses = source['bus:lanes'] ? String(source['bus:lanes']).split('|') : null;
    carriageway.forEach((lane, index) => {
        if (widths && finite(widths[index]) && widths[index] > 0) lane.width = widths[index];
        if (buses && buses[index] === 'designated') lane.type = 'bus';
    });
    const centre = lanes.findIndex(lane => CARRIAGEWAY_TYPES.has(lane.type) || lane.type === 'rail' || lane.type === 'median');
    const sideOf = index => (centre === -1 || index < centre ? 'left' : 'right');
    lanes.forEach((lane, index) => {
        const side = sideOf(index);
        if (lane.type === 'sidewalk') {
            const paving = SURFACE_PAVING[source[`sidewalk:${side}:surface`] || source['sidewalk:both:surface']];
            if (paving) lane.paving = paving;
        }
        if (lane.type === 'verge') {
            const landscape = source[`cb:verge:${side}:landscape`];
            if (landscape) lane.landscape = landscape;
        }
        if (parkingOrientation(lane.type)) {
            const every = parseInt(source[`cb:parking:${side}:tree_every`], 10);
            if (every > 0) lane.treeEvery = every;
        }
        if (lane.type === 'median' && source['cb:median:landscape']) lane.landscape = source['cb:median:landscape'];
    });
    return normalizeCorridorRecordProfile({ strips: lanes });
}

const atMillimetre = (profile) => {
    const normalized = normalizeCorridorRecordProfile(profile);
    return normalized
        ? { ...normalized, strips: normalized.strips.map(lane => ({ ...lane, width: round3(lane.width) })) }
        : normalized;
};
const sameProfile = (a, b) => JSON.stringify(atMillimetre(a)) === JSON.stringify(atMillimetre(b));

// ---- OSM document -> view ----------------------------------------------------

// consensus-builder definitionFromOsmForm: every way is a stretch, the first
// way's cross-section is the default and differing ones become overrides.
function viewFromOsmForm(form) {
    const elements = (form && Array.isArray(form.elements)) ? form.elements : [];
    const nodes = new Map(elements.filter(element => element && element.type === 'node').map(node => [node.id, node]));
    const ways = elements.filter(element => element && element.type === 'way' && Array.isArray(element.nodes));
    const stretches = [];
    for (const way of ways) {
        const points = way.nodes.map(id => nodes.get(id)).filter(Boolean).map((node) => {
            const point = { lat: node.lat, lng: node.lon };
            const level = node.tags && Number(node.tags['cb:level']);
            if (finite(level)) point.level = level;
            const elevation = node.tags && node.tags.ele !== undefined ? Number(node.tags.ele) : NaN;
            if (finite(elevation)) point.elevationM = elevation;
            return point;
        });
        const profile = corridorProfileFromWayTags(way.tags || {});
        if (points.length < 2 || !profile) continue;
        const tagged = way.tags && way.tags['cb:segment'];
        stretches.push({
            points,
            profile,
            id: (tagged !== undefined && tagged !== null) ? String(tagged) : null,
            wayId: way.id,
        });
    }
    if (!stretches.length) return null;
    const profile = stretches[0].profile;
    const segmentProfiles = {};
    for (const stretch of stretches) {
        if (sameProfile(stretch.profile, profile)) continue;
        if (stretch.id === null) stretch.id = `way${stretch.wayId}`;
        segmentProfiles[stretch.id] = stretch.profile;
    }
    const segments = stretches.map(stretch => stretch.points);
    const view = { points: segments, segments, profile, width: round3(profileWidth(profile)) };
    if (stretches.some(stretch => stretch.id !== null)) view.segmentIds = stretches.map(stretch => stretch.id);
    if (Object.keys(segmentProfiles).length) view.segmentProfiles = segmentProfiles;
    return view;
}

// The stretches of a corridor record: { points, segments, profile, width,
// segmentIds?, segmentProfiles? }, or null for a record with no drawn stretch
// (a designation, which consensus-builder stores as land or a polygon alone).
export function proposalCorridorView(definition) {
    return definition && typeof definition === 'object' && definition.osm
        ? viewFromOsmForm(definition.osm)
        : null;
}
