// Resolves narrow, road-backed urban waterfronts into flat quay sections.
// This module is deliberately renderer-free: the water layer can classify a
// few shoreline segments per frame while streamed road support is settling,
// then publish the finished stone deck and vertical sea wall atomically.

import { finiteOrNull } from './math.js';

export const URBAN_COAST_SEARCH_M = 16;
export const URBAN_COAST_SAMPLE_STEP_M = 1;
export const URBAN_COAST_ROAD_OVERLAP_M = 0.45;
export const URBAN_COAST_TERRAIN_OVERLAP_M = 0.9;

// A simplified shoreline keeps a straight quay as one segment of 100 m or
// more, and a section's deck interpolates between its two endpoint landings.
// The 20 m DTM wobbles by 0.3 m along Split's Riva, so one long deck ends up
// a step below the promenade over most of its length. Classify the shore in
// pieces no longer than the DTM's own resolution instead.
export const URBAN_COAST_SECTION_MAX_LENGTH_M = 24;

// The deck stands at the apron's highest acceptable ground behind the first
// landing, not at the first sample: the 20 m DTM dips a few decimetres just
// inland of Split's Riva before it reaches the promenade grade, and a deck at
// the dip reads as a sunken shelf with a step up onto the paving.
export const URBAN_COAST_APRON_M = 4;

const MIN_FREEBOARD_M = 0.28;
const MAX_FREEBOARD_M = 3.5;
const MAX_TERRAIN_MISMATCH_M = 1.25;
const MIN_DIRECTION_LENGTH_M = 0.25;

function finitePoint(point) {
    return Array.isArray(point)
        && Number.isFinite(point[0])
        && Number.isFinite(point[1]);
}

function landwardUnit(shore, land) {
    if (!finitePoint(shore) || !finitePoint(land)) return null;
    const dx = land[0] - shore[0];
    const dz = land[1] - shore[1];
    const length = Math.hypot(dx, dz);
    return length >= MIN_DIRECTION_LENGTH_M
        ? { x: dx / length, z: dz / length }
        : null;
}

function midpoint(a, b) {
    return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
}

function averageDirection(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = a.x + b.x;
    const z = a.z + b.z;
    const length = Math.hypot(x, z);
    return length >= MIN_DIRECTION_LENGTH_M
        ? { x: x / length, z: z / length }
        : a;
}

function findFirmLanding(shore, direction, {
    seaY,
    sampleRoadY,
    sampleTerrainY,
    searchM,
    sampleStepM,
    roadOverlapM,
    apronM,
    minFreeboardM,
    maxFreeboardM,
    maxTerrainMismatchM,
}) {
    if (!finitePoint(shore) || !direction) return null;
    let landing = null;
    for (let distanceM = sampleStepM; distanceM <= searchM + 1e-6;
        distanceM += sampleStepM) {
        if (landing && distanceM > landing.firstM + apronM + 1e-6) break;
        const x = shore[0] + direction.x * distanceM;
        const z = shore[1] + direction.z * distanceM;
        const roadY = finiteOrNull(sampleRoadY(x, z));
        if (roadY === null) continue;
        const freeboardM = roadY - seaY;
        if (freeboardM < minFreeboardM || freeboardM > maxFreeboardM) continue;
        const terrainY = finiteOrNull(sampleTerrainY(x, z));
        if (terrainY === null
            || Math.abs(terrainY - roadY) > maxTerrainMismatchM) continue;
        if (!landing) {
            landing = { firstM: distanceM, distanceM: Math.min(searchM, distanceM + roadOverlapM), roadY };
        } else if (roadY > landing.roadY) landing.roadY = roadY;
    }
    return landing && { distanceM: landing.distanceM, roadY: landing.roadY };
}

/**
 * The firm landing a quay needs is paved ground the walker stands on. Since
 * receiver paving (2026-09-15) promenades and squares are painted onto the
 * terrain instead of built as meshes, so the rendered road registry no longer
 * knows them and Split's Riva fell back to the sloping collar. Mesh support
 * still wins where it exists; otherwise painted pedestrian ground rests on
 * terrain evidence, lifted like the collar so the deck never fights the
 * receiver it replaces. Missing evidence is never a zero-height landing.
 */
export function createUrbanCoastLandingSampler({
    sampleRoadY = null,
    pavedGroundAt = null,
    sampleTerrainY = null,
    liftM = 0,
} = {}) {
    const road = typeof sampleRoadY === 'function' ? sampleRoadY : () => null;
    const paved = typeof pavedGroundAt === 'function' ? pavedGroundAt : () => false;
    const terrain = typeof sampleTerrainY === 'function' ? sampleTerrainY : () => null;
    const lift = Number.isFinite(liftM) ? liftM : 0;
    return (x, z) => {
        const roadY = finiteOrNull(road(x, z));
        if (roadY !== null) return roadY;
        if (paved(x, z) !== true) return null;
        const terrainY = finiteOrNull(terrain(x, z));
        return terrainY === null ? null : terrainY + lift;
    };
}

/**
 * Resolve one mapped-coast collar quad. A positive classification requires a
 * firm same-grade landing on the midpoint ray; endpoint rays refine its width
 * and longitudinal grade but cannot turn a merely nearby road into a quay.
 */
export function resolveUrbanCoastSection(quad, {
    seaY = 0,
    sampleRoadY = () => null,
    sampleTerrainY = () => null,
    explicitBeachAt = () => false,
    searchM = URBAN_COAST_SEARCH_M,
    sampleStepM = URBAN_COAST_SAMPLE_STEP_M,
    roadOverlapM = URBAN_COAST_ROAD_OVERLAP_M,
    terrainOverlapM = URBAN_COAST_TERRAIN_OVERLAP_M,
    apronM = URBAN_COAST_APRON_M,
    minFreeboardM = MIN_FREEBOARD_M,
    maxFreeboardM = MAX_FREEBOARD_M,
    maxTerrainMismatchM = MAX_TERRAIN_MISMATCH_M,
} = {}) {
    const resolvedSeaY = finiteOrNull(seaY) ?? 0;
    const shoreA = quad?.shoreA;
    const shoreB = quad?.shoreB;
    const directionA = landwardUnit(shoreA, quad?.landA);
    const directionB = landwardUnit(shoreB, quad?.landB);
    const directionMid = averageDirection(directionA, directionB);
    if (!finitePoint(shoreA) || !finitePoint(shoreB) || !directionMid) return null;
    const shoreMid = midpoint(shoreA, shoreB);
    if (explicitBeachAt(shoreMid[0], shoreMid[1]) === true) return null;

    const options = {
        seaY: resolvedSeaY,
        sampleRoadY: typeof sampleRoadY === 'function' ? sampleRoadY : () => null,
        sampleTerrainY: typeof sampleTerrainY === 'function' ? sampleTerrainY : () => null,
        searchM: Math.max(2, Number(searchM) || URBAN_COAST_SEARCH_M),
        sampleStepM: Math.max(0.5, Number(sampleStepM) || URBAN_COAST_SAMPLE_STEP_M),
        roadOverlapM: Math.max(0, Number(roadOverlapM) || 0),
        apronM: Math.max(0, Number(apronM) || 0),
        minFreeboardM: Math.max(0, Number(minFreeboardM) || 0),
        maxFreeboardM: Math.max(0, Number(maxFreeboardM) || 0),
        maxTerrainMismatchM: Math.max(0, Number(maxTerrainMismatchM) || 0),
    };
    const mid = findFirmLanding(shoreMid, directionMid, options);
    if (!mid) return null;
    const landingA = findFirmLanding(shoreA, directionA || directionMid, options) || mid;
    const landingB = findFirmLanding(shoreB, directionB || directionMid, options) || mid;
    const topAY = landingA.roadY;
    const topBY = landingB.roadY;
    const segmentLengthM = Math.hypot(
        shoreB[0] - shoreA[0],
        shoreB[1] - shoreA[1],
    );
    // A discontinuity this sharp is a wall/bridge coincidence, not a paved
    // promenade. Ordinary waterfront grades remain far below this threshold.
    if (Math.abs(topBY - topAY) > Math.max(0.45, segmentLengthM * 0.3)) return null;
    // The mapped-coast terrain collar owns the authoritative land/sea seam.
    // Reaching only the FIRST road sample can stop a quay barely a metre from
    // the shoreline while that collar is still descending toward the sea,
    // exposing a deep trough between the deck and otherwise valid city ground.
    // Carry the deck beyond the collar's inland edge so it overlaps stable DGU
    // terrain (and the road that classified it) instead of ending over infill.
    const safeTerrainOverlapM = Math.max(0, Number(terrainOverlapM) || 0);
    const collarWidthA = finitePoint(quad.landA)
        ? Math.hypot(quad.landA[0] - shoreA[0], quad.landA[1] - shoreA[1])
        : landingA.distanceM;
    const collarWidthB = finitePoint(quad.landB)
        ? Math.hypot(quad.landB[0] - shoreB[0], quad.landB[1] - shoreB[1])
        : landingB.distanceM;
    const widthAM = Math.max(landingA.distanceM, collarWidthA + safeTerrainOverlapM);
    const widthBM = Math.max(landingB.distanceM, collarWidthB + safeTerrainOverlapM);
    return {
        shoreA: [...shoreA],
        shoreB: [...shoreB],
        landA: [
            shoreA[0] + (directionA || directionMid).x * widthAM,
            shoreA[1] + (directionA || directionMid).z * widthAM,
        ],
        landB: [
            shoreB[0] + (directionB || directionMid).x * widthBM,
            shoreB[1] + (directionB || directionMid).z * widthBM,
        ],
        topAY,
        topBY,
        widthAM,
        widthBM,
    };
}

// Split collar quads longer than maxLengthM into equal pieces that share
// their interior nodes bit for bit, so consecutive sections meet exactly and
// the deck follows the ground at the DTM's resolution.
export function splitLongCoastQuads(quads, maxLengthM = URBAN_COAST_SECTION_MAX_LENGTH_M) {
    const limit = Math.max(1, Number(maxLengthM) || URBAN_COAST_SECTION_MAX_LENGTH_M);
    const out = [];
    for (const quad of quads || []) {
        const { shoreA, shoreB, landA, landB } = quad || {};
        if (![shoreA, shoreB, landA, landB].every(finitePoint)) { out.push(quad); continue; }
        const lengthM = Math.hypot(shoreB[0] - shoreA[0], shoreB[1] - shoreA[1]);
        const pieces = Math.ceil(lengthM / limit);
        if (!(pieces > 1)) { out.push(quad); continue; }
        const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        let shore = shoreA, land = landA;
        for (let index = 1; index <= pieces; index++) {
            const t = index / pieces;
            const nextShore = index === pieces ? shoreB : lerp(shoreA, shoreB, t);
            const nextLand = index === pieces ? landB : lerp(landA, landB, t);
            out.push({ ...quad, shoreA: shore, shoreB: nextShore, landA: land, landB: nextLand });
            shore = nextShore; land = nextLand;
        }
    }
    return out;
}

function coastNodeKey(point) {
    return `${Number(point[0]).toFixed(5)}:${Number(point[1]).toFixed(5)}`;
}

export function buildUrbanCoastGeometryData(sections, {
    seaY = 0,
    wallSubmergenceM = 0.8,
    uvPerM = 0.22,
    originX = 0,
    originZ = 0,
} = {}) {
    if (![originX, originZ].every(Number.isFinite)) throw new TypeError('Quay geometry requires a finite storage origin');
    const accepted = Array.isArray(sections) ? sections.filter(Boolean) : [];
    const nodeHeights = new Map();
    const addNodeHeight = (point, y) => {
        if (!finitePoint(point) || !Number.isFinite(y)) return;
        const key = coastNodeKey(point);
        const entry = nodeHeights.get(key) || { total: 0, count: 0 };
        entry.total += y;
        entry.count += 1;
        nodeHeights.set(key, entry);
    };
    for (const section of accepted) {
        addNodeHeight(section.shoreA, section.topAY);
        addNodeHeight(section.shoreB, section.topBY);
    }
    const nodeHeight = (point, fallback) => {
        const entry = nodeHeights.get(coastNodeKey(point));
        return entry?.count > 0 ? entry.total / entry.count : fallback;
    };
    const topPositions = [];
    const topUvs = [];
    const wallPositions = [];
    const bottomY = (finiteOrNull(seaY) ?? 0)
        - Math.max(0.2, Number(wallSubmergenceM) || 0.8);
    const safeUvPerM = Math.max(0.01, Number(uvPerM) || 0.22);
    const topVertex = (point, y) => {
        topPositions.push(point[0] - originX, y, point[1] - originZ);
        topUvs.push(point[0] * safeUvPerM, point[1] * safeUvPerM);
    };
    const topTriangle = (a, ay, b, by, c, cy) => {
        const area = (b[0] - a[0]) * (c[1] - a[1])
            - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-6) return false;
        topVertex(a, ay);
        topVertex(b, by);
        topVertex(c, cy);
        return true;
    };
    const wallVertex = (point, y) => wallPositions.push(point[0] - originX, y, point[1] - originZ);
    const rendered = [];
    for (const section of accepted) {
        const { shoreA, shoreB, landA, landB, topAY, topBY } = section;
        if (![shoreA, shoreB, landA, landB].every(finitePoint)
            || !Number.isFinite(topAY) || !Number.isFinite(topBY)) continue;
        const resolvedAY = nodeHeight(shoreA, topAY);
        const resolvedBY = nodeHeight(shoreB, topBY);
        topTriangle(shoreA, resolvedAY, landA, resolvedAY, shoreB, resolvedBY);
        topTriangle(shoreB, resolvedBY, landA, resolvedAY, landB, resolvedBY);
        wallVertex(shoreA, resolvedAY);
        wallVertex(shoreB, resolvedBY);
        wallVertex(shoreA, bottomY);
        wallVertex(shoreB, resolvedBY);
        wallVertex(shoreB, bottomY);
        wallVertex(shoreA, bottomY);
        rendered.push({ ...section, topAY: resolvedAY, topBY: resolvedBY });
    }
    // Offset shoreline segments do not share their inland corner. The mapped
    // terrain collar fills this with explicit join triangles; the Riva must do
    // the same or every bend exposes the much lower coast infill as a blue/grey
    // triangular slit. Connect all contiguous accepted sections, including a
    // closed ring's last-to-first join.
    const starts = new Map();
    rendered.forEach((section, index) => {
        const key = coastNodeKey(section.shoreA);
        if (!starts.has(key)) starts.set(key, index);
    });
    let joinCount = 0;
    rendered.forEach((section, index) => {
        const nextIndex = starts.get(coastNodeKey(section.shoreB));
        if (!Number.isInteger(nextIndex) || nextIndex === index) return;
        const next = rendered[nextIndex];
        if (topTriangle(
            section.shoreB,
            section.topBY,
            section.landB,
            section.topBY,
            next.landA,
            next.topAY,
        )) joinCount += 1;
    });
    return {
        sectionCount: rendered.length,
        originX, originZ,
        joinCount,
        topPositions: new Float32Array(topPositions),
        topUvs: new Float32Array(topUvs),
        wallPositions: new Float32Array(wallPositions),
    };
}
