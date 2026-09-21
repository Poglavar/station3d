// Pure planning and geometry for the terrain inspector's draped city layers:
// which layers a given window may load, how to split it into fetchable bboxes,
// how an OSM way is classified and widened, and how a centreline or a building
// footprint becomes vertices that follow the DGU relief. No THREE, no DOM, no
// fetch — the viewer adds only materials and network on top.
//
// The ribbon primitives (densify → miter → stations) and the prism builder are
// the same ones Station3D uses, so a road drawn here has the same cross-section
// semantics as the same road in the simulator.

import { computeRibbonStations, densifyChain } from '../world/footpath-geometry.js';
import { buildBuildingPrisms, outerRings, pickFarHeightForFeature, projectRing } from '../world/lod1-geometry.js';

// The three layers cost wildly different amounts, so they get different
// ceilings rather than one flat cut-off. Measured feature counts:
//
//   window        rails   roads (all)   roads (≥secondary)   buildings
//   Split 13 km     227        11,886                  597      26,703
//   Zagreb 13 km  1,109        59,075                2,031     226,396
//   Zagreb 35 km  1,387        90,996                4,606     356,232
//
// Rails are cheap at ANY width — all of Zagreb at 35 km is fewer ways than a
// 2 km window's roads — and a rail corridor is exactly what a wide window is
// for, so they have no ceiling. Roads only explode because of residential
// streets, so wide windows drop to the main network instead of being refused.
// Buildings cannot be generalised this way and keep a hard ceiling.
export const DRAPE_HOUSE_MAX_SPAN_KM = 3;

// Road detail by window, named for the least important class each tier keeps.
// Ordered narrowest-first; the first tier the span fits in wins.
export const DRAPE_ROAD_TIERS = Object.freeze([
    Object.freeze({
        key: 'all',
        maxSpanKm: 3,
        classes: Object.freeze(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service']),
    }),
    Object.freeze({
        key: 'tertiary',
        maxSpanKm: 10,
        classes: Object.freeze(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']),
    }),
    Object.freeze({
        key: 'secondary',
        maxSpanKm: Infinity,
        classes: Object.freeze(['motorway', 'trunk', 'primary', 'secondary']),
    }),
]);

// Longitudinal drape resolution. Comfortably below the 20 m DTM cell so a
// ribbon cannot span a whole cell as one chord and cut through the relief,
// while staying coarse enough that a 2 km window is a few hundred thousand
// vertices rather than millions.
export const DRAPE_SAMPLE_STEP_M = 8;

// Surfaces sit slightly proud of the terrain they are draped on. Exact
// coplanarity is a depth-buffer coin toss at a grazing angle — the same
// z-fighting that produces "curb rings" on the night roads — and polygonOffset
// alone weakens with distance. Rails sit above roads so a level crossing
// resolves the way it does on the ground.
export const ROAD_LIFT_M = 0.30;
export const RAIL_LIFT_M = 0.55;

// A bridge deck is held on a straight ramp between its abutments rather than
// draped, because draping it would drop the deck into the valley it exists to
// cross. The extra lift keeps a short bridge from disappearing into the DTM's
// own smoothing of the gorge underneath it.
export const BRIDGE_DECK_LIFT_M = 1.5;

// Metres of arc a rail texture tile covers, so sleepers repeat at a plausible
// spacing when the viewer gives the rail material a striped map.
export const RAIL_TEXTURE_TILE_M = 2.4;

const ROAD_CLASSES = Object.freeze({
    motorway: Object.freeze({ key: 'motorway', widthM: 22, color: 0x3f4750 }),
    trunk: Object.freeze({ key: 'trunk', widthM: 16, color: 0x4b535c }),
    primary: Object.freeze({ key: 'primary', widthM: 13, color: 0x5a616a }),
    secondary: Object.freeze({ key: 'secondary', widthM: 10.5, color: 0x666d76 }),
    tertiary: Object.freeze({ key: 'tertiary', widthM: 8.5, color: 0x727982 }),
    residential: Object.freeze({ key: 'residential', widthM: 6.5, color: 0x7d848c }),
    service: Object.freeze({ key: 'service', widthM: 4, color: 0x888e95 }),
});

const HIGHWAY_TO_CLASS = Object.freeze({
    motorway: 'motorway',
    motorway_link: 'motorway',
    trunk: 'trunk',
    trunk_link: 'trunk',
    primary: 'primary',
    primary_link: 'primary',
    secondary: 'secondary',
    secondary_link: 'secondary',
    tertiary: 'tertiary',
    tertiary_link: 'tertiary',
    residential: 'residential',
    unclassified: 'residential',
    living_street: 'residential',
    road: 'residential',
    service: 'service',
});

const RAIL_CLASSES = Object.freeze({
    rail: Object.freeze({ key: 'rail', widthM: 4.6, color: 0x8a7259 }),
    tram: Object.freeze({ key: 'tram', widthM: 3.2, color: 0x9a8368 }),
});

const RAILWAY_TO_CLASS = Object.freeze({
    rail: 'rail',
    narrow_gauge: 'rail',
    subway: 'rail',
    funicular: 'rail',
    tram: 'tram',
    light_rail: 'tram',
});

export const DRAPE_ROAD_CLASSES = ROAD_CLASSES;
export const DRAPE_RAIL_CLASSES = RAIL_CLASSES;

// Strict: a measurement is a number or it is absent. Number(null) is 0 and
// Number('') is 0, so a Number()-then-isFinite test silently turns a missing
// relief sample into sea level — which is how a road ends up nailed to 0 m
// under a hillside. Everything that consumes a HEIGHT goes through this.
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// OSM tag values arrive as strings ('1435', '2'), so these do want coercion —
// but only from something that was actually written down.
function numericTag(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (text === '') return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

// What each layer may load at this window size. `roads.tier` says how much of
// the network the window gets, so the UI can state it rather than leaving the
// user to wonder why the side streets went away.
export function terrainDrapeLayerPolicy(spanKm) {
    const span = numericTag(spanKm);
    if (span === null || span <= 0) {
        return {
            spanKm: null,
            rails: { enabled: false },
            roads: { enabled: false, tier: null, classes: [] },
            houses: { enabled: false, maxSpanKm: DRAPE_HOUSE_MAX_SPAN_KM },
        };
    }
    const tier = DRAPE_ROAD_TIERS.find((candidate) => span <= candidate.maxSpanKm)
        || DRAPE_ROAD_TIERS[DRAPE_ROAD_TIERS.length - 1];
    return {
        spanKm: span,
        rails: { enabled: true },
        roads: { enabled: true, tier: tier.key, classes: [...tier.classes] },
        houses: { enabled: span <= DRAPE_HOUSE_MAX_SPAN_KM, maxSpanKm: DRAPE_HOUSE_MAX_SPAN_KM },
    };
}

// The OSM highway values behind a set of class keys, for the roads endpoint's
// ?highways= filter. Derived by inverting the class table so the `_link`
// variants and the aliases folded into `residential` cannot drift apart from
// what the renderer will actually style.
export function roadHighwayValuesForClasses(classes) {
    const wanted = new Set(classes || []);
    return Object.entries(HIGHWAY_TO_CLASS)
        .filter(([, classKey]) => wanted.has(classKey))
        .map(([highway]) => highway);
}

// Split a window into request bboxes no larger than the endpoint's own cap.
// Returned in degrees, covering the bounds exactly (the last column/row is
// short rather than overhanging), so nothing outside the window is fetched.
export function drapeFetchBboxes(bounds, { maxSpanDeg = 0.018 } = {}) {
    const west = finiteNumber(bounds?.west);
    const east = finiteNumber(bounds?.east);
    const south = finiteNumber(bounds?.south);
    const north = finiteNumber(bounds?.north);
    if (west === null || east === null || south === null || north === null) return [];
    if (!(east > west) || !(north > south)) return [];
    const step = Math.max(1e-4, Number(maxSpanDeg) || 0.018);
    const columns = Math.max(1, Math.ceil((east - west) / step));
    const rows = Math.max(1, Math.ceil((north - south) / step));
    const boxes = [];
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            boxes.push({
                west: west + ((east - west) * column) / columns,
                east: west + ((east - west) * (column + 1)) / columns,
                south: south + ((north - south) * row) / rows,
                north: south + ((north - south) * (row + 1)) / rows,
            });
        }
    }
    return boxes;
}

// tunnel=* values that are still a road ON the ground. A building_passage runs
// under a building at grade — not a bore through the hill — and central Zagreb
// has 284 of them against 30 real tunnels, so treating them as tunnels erases
// most of the arcaded city centre.
const AT_GRADE_TUNNEL_VALUES = new Set(['no', 'building_passage', 'covered']);

// A way's vertical mode. `tunnel` is a real answer, not a missing one: the
// caller drops those ways rather than painting a road across the hill they
// pass under.
export function drapeVerticalMode(properties) {
    const tunnel = properties?.tunnel;
    if (tunnel && !AT_GRADE_TUNNEL_VALUES.has(tunnel)) return 'tunnel';
    const bridge = properties?.bridge;
    if (bridge && bridge !== 'no') return 'bridge';
    return 'drape';
}

export function roadDrapeStyle(properties) {
    const classKey = HIGHWAY_TO_CLASS[properties?.highway] || null;
    if (!classKey) return null;
    const roadClass = ROAD_CLASSES[classKey];
    const surveyed = numericTag(properties?.width_meters);
    return {
        classKey,
        color: roadClass.color,
        // A surveyed width wins, but only when it is a plausible carriageway:
        // osm_road carries some sub-metre widths that would render as threads.
        widthM: surveyed !== null && surveyed >= 2 ? surveyed : roadClass.widthM,
        mode: drapeVerticalMode(properties),
        liftM: ROAD_LIFT_M,
    };
}

export function railDrapeStyle(properties) {
    const classKey = RAILWAY_TO_CLASS[properties?.railway] || null;
    if (!classKey) return null;
    const railClass = RAIL_CLASSES[classKey];
    // `tracks` counts parallel tracks carried by one OSM way; two tracks on one
    // way must not render as a single-track ribbon.
    const tracks = numericTag(properties?.tracks);
    const multiplier = tracks !== null && tracks >= 1 ? Math.min(6, Math.round(tracks)) : 1;
    return {
        classKey,
        color: railClass.color,
        widthM: railClass.widthM * multiplier,
        mode: drapeVerticalMode(properties),
        liftM: RAIL_LIFT_M,
    };
}

// Heights for one chain of stations.
//
// `sampleHeightM` returns null outside DGU coverage, and a null must never
// become a number by arithmetic — a 0 here would nail a road to sea level. So
// gaps are filled EXPLICITLY, by interpolating between the real samples that
// bracket them, and the count of filled stations is reported rather than
// hidden. A chain with no valid sample at all is refused outright.
export function drapedHeights(stations, sampleHeightM, { mode = 'drape', liftM = 0 } = {}) {
    const count = stations.length;
    const raw = new Array(count);
    let firstValid = -1;
    let lastValid = -1;
    for (let index = 0; index < count; index++) {
        const sampled = finiteNumber(sampleHeightM(stations[index].x, stations[index].z));
        raw[index] = sampled;
        if (sampled === null) continue;
        if (firstValid < 0) firstValid = index;
        lastValid = index;
    }
    if (firstValid < 0) return { heights: null, ok: false, filledCount: count };

    const lift = Number(liftM) || 0;
    if (mode === 'bridge') {
        // Straight ramp between the abutments: the ends of an OSM bridge way
        // are where the deck meets the ground, so those two samples define it.
        const startY = raw[firstValid];
        const endY = raw[lastValid];
        const total = stations[count - 1].arc - stations[0].arc;
        const heights = new Float64Array(count);
        for (let index = 0; index < count; index++) {
            const t = total > 1e-6 ? (stations[index].arc - stations[0].arc) / total : 0;
            heights[index] = startY + (endY - startY) * t + lift + BRIDGE_DECK_LIFT_M;
        }
        return { heights, ok: true, filledCount: 0 };
    }

    const heights = new Float64Array(count);
    let filledCount = 0;
    for (let index = 0; index < count; index++) {
        if (raw[index] !== null) {
            heights[index] = raw[index] + lift;
            continue;
        }
        filledCount += 1;
        if (index < firstValid) { heights[index] = raw[firstValid] + lift; continue; }
        if (index > lastValid) { heights[index] = raw[lastValid] + lift; continue; }
        let before = index - 1;
        while (before >= 0 && raw[before] === null) before -= 1;
        let after = index + 1;
        while (after < count && raw[after] === null) after += 1;
        const span = stations[after].arc - stations[before].arc;
        const t = span > 1e-6 ? (stations[index].arc - stations[before].arc) / span : 0;
        heights[index] = raw[before] + (raw[after] - raw[before]) * t + lift;
    }
    return { heights, ok: true, filledCount };
}

// The rendered crop, as a local-metre rectangle. Ribbons must be clipped to it:
// the endpoints answer every feature INTERSECTING the request bbox, and the DGU
// grid keeps returning real heights past the crop, so an unclipped way carries
// on for kilometres beyond the terrain — visibly floating over the sea plane.
export function drapeClipRectFromView(view) {
    const bounds = view?.bounds;
    if (!bounds) return null;
    return {
        minX: (bounds.west - view.centerLon) * view.metresPerDegreeLon,
        maxX: (bounds.east - view.centerLon) * view.metresPerDegreeLon,
        minZ: (view.centerLat - bounds.north) * view.metresPerDegreeLat,
        maxZ: (view.centerLat - bounds.south) * view.metresPerDegreeLat,
    };
}

// Liang–Barsky: the portion of segment a→b inside the rect, as parameters on
// the segment, or null when it misses entirely.
function clipSegment(a, b, rect) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edgeP = [-dx, dx, -dz, dz];
    const edgeQ = [a.x - rect.minX, rect.maxX - a.x, a.z - rect.minZ, rect.maxZ - a.z];
    let t0 = 0;
    let t1 = 1;
    for (let edge = 0; edge < 4; edge++) {
        if (edgeP[edge] === 0) {
            if (edgeQ[edge] < 0) return null; // parallel to this edge and outside it
            continue;
        }
        const ratio = edgeQ[edge] / edgeP[edge];
        if (edgeP[edge] < 0) {
            if (ratio > t1) return null;
            if (ratio > t0) t0 = ratio;
        } else {
            if (ratio < t0) return null;
            if (ratio < t1) t1 = ratio;
        }
    }
    return { t0, t1 };
}

function lerpPoint(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

// One polyline → the sub-chains of it that lie inside the rect, cut exactly at
// the boundary. A way that leaves and re-enters comes back as two chains, not
// one chain with a chord across the gap.
export function clipChainToRect(points, rect) {
    if (!rect) return points.length >= 2 ? [points] : [];
    const runs = [];
    let current = [];
    const flush = () => {
        if (current.length >= 2) runs.push(current);
        current = [];
    };
    for (let index = 0; index + 1 < points.length; index++) {
        const from = points[index];
        const to = points[index + 1];
        const clipped = clipSegment(from, to, rect);
        if (!clipped) { flush(); continue; }
        const entry = lerpPoint(from, to, clipped.t0);
        const exit = lerpPoint(from, to, clipped.t1);
        const tail = current[current.length - 1];
        if (!tail || Math.hypot(tail.x - entry.x, tail.z - entry.z) > 1e-6) {
            flush();
            current.push(entry);
        }
        current.push(exit);
        if (clipped.t1 < 1 - 1e-9) flush(); // the way leaves the crop here
    }
    flush();
    return runs;
}

function cleanChain(points) {
    const clean = [];
    for (const point of points || []) {
        const x = finiteNumber(point?.x);
        const z = finiteNumber(point?.z);
        if (x === null || z === null) continue;
        const previous = clean[clean.length - 1];
        if (previous && Math.hypot(x - previous.x, z - previous.z) < 0.05) continue;
        clean.push({ x, z });
    }
    return clean;
}

// One centreline → a terrain-following ribbon of its real width. Returns null
// for anything unbuildable (a tunnel, a degenerate way, a chain entirely
// outside DGU coverage) so the caller can count what it skipped.
//
// UVs run 0→1 across the ribbon and arc/tileM along it, which is what lets the
// rail material repeat a sleeper stripe at a fixed ground spacing.
export function buildDrapedRibbon(points, {
    widthM = 6,
    mode = 'drape',
    liftM = 0,
    sampleHeightM,
    maxSegmentM = DRAPE_SAMPLE_STEP_M,
    textureTileM = 0,
} = {}) {
    if (mode === 'tunnel') return null;
    if (typeof sampleHeightM !== 'function') throw new Error('draped ribbon needs a height sampler');
    const chain = cleanChain(points);
    if (chain.length < 2) return null;
    const width = Math.max(1, Number(widthM) || 1);
    const dense = densifyChain(chain, chain.map(() => width), maxSegmentM);
    // Deliberately NOT Chaikin-smoothed: a road here is evidence about where
    // the survey says the road is, and smoothing would move it off the OSM
    // geometry the elevation readout is compared against.
    const stations = computeRibbonStations(dense.points, dense.widths);
    if (stations.length < 2) return null;
    const solved = drapedHeights(stations, sampleHeightM, { mode, liftM });
    if (!solved.ok) return null;

    const count = stations.length;
    const positions = new Float32Array(count * 6);
    const uvs = new Float32Array(count * 4);
    const tile = Number(textureTileM) > 0 ? Number(textureTileM) : 0;
    for (let index = 0; index < count; index++) {
        const station = stations[index];
        const y = solved.heights[index];
        const offset = index * 6;
        positions[offset] = station.x - station.nx * station.halfWidth;
        positions[offset + 1] = y;
        positions[offset + 2] = station.z - station.nz * station.halfWidth;
        positions[offset + 3] = station.x + station.nx * station.halfWidth;
        positions[offset + 4] = y;
        positions[offset + 5] = station.z + station.nz * station.halfWidth;
        const v = tile > 0 ? station.arc / tile : station.arc;
        uvs[index * 4] = 0;
        uvs[index * 4 + 1] = v;
        uvs[index * 4 + 2] = 1;
        uvs[index * 4 + 3] = v;
    }
    const indices = new Uint32Array((count - 1) * 6);
    for (let index = 0, out = 0; index + 1 < count; index++, out += 6) {
        const a = index * 2;
        indices[out] = a;
        indices[out + 1] = a + 2;
        indices[out + 2] = a + 1;
        indices[out + 3] = a + 1;
        indices[out + 4] = a + 2;
        indices[out + 5] = a + 3;
    }
    return { positions, uvs, indices, filledCount: solved.filledCount, stationCount: count };
}

// Ground height a prism should stand on: the LOWEST relief under its footprint.
// The alternative — the centroid — floats the downhill corners of anything on a
// slope, and a floating building reads as a bug. Burying the uphill side does
// not, and a simplified prism has no basement to expose.
export function drapedBuildingBaseM(ring, sampleHeightM) {
    let lowest = null;
    for (const point of ring) {
        const sampled = finiteNumber(sampleHeightM(point.x, point.z));
        if (sampled === null) continue;
        if (lowest === null || sampled < lowest) lowest = sampled;
    }
    return lowest;
}

// One GeoJSON building → a flat-topped prism standing on the relief. Height
// comes from the shared LOD1 rule, so a building here is as tall as the same
// building in Station3D. Returns null when the footprint has no DGU coverage.
export function buildDrapedBuilding(feature, {
    centerLon,
    centerLat,
    sampleHeightM,
    minHeightM = 2,
} = {}) {
    if (typeof sampleHeightM !== 'function') throw new Error('draped building needs a height sampler');
    const geometry = feature?.geometry;
    const rings = outerRings(geometry);
    if (rings.length === 0) return null;
    let baseY = null;
    for (const ring of rings) {
        const candidate = drapedBuildingBaseM(projectRing(ring, centerLon, centerLat), sampleHeightM);
        if (candidate === null) continue;
        if (baseY === null || candidate < baseY) baseY = candidate;
    }
    if (baseY === null) return null;
    const heightM = Math.max(
        minHeightM,
        pickFarHeightForFeature(feature?.properties, geometry, centerLat),
    );
    const prisms = buildBuildingPrisms(geometry, heightM, centerLon, centerLat, baseY);
    if (!prisms) return null;
    return { ...prisms, baseY, heightM };
}
