// Shared, source-agnostic support-placement clearance for rail and road civil
// works. It checks nearby road centrelines and tram/reference tracks once while
// geometry is built; it is not tied to any particular railway data provider.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';
import { nearbyRoadSegments } from './road-index.js';

const ROAD_CLEARANCE_M = 6;
const TRACK_CLEARANCE_M = 3;
const GRID_CELL_M = 60;
export const PILLAR_CLEARANCE_LIMITS = Object.freeze({ maxFeatures: 8192, maxCoordinates: 524288,
    // The captured Zagreb reference network has 443 short segments in one
    // 60 m cell. Keep a finite query bound (nine cells) without rejecting it.
    maxIndexEntries: 1048576, maxCellCandidates: 1024, maxRoadCandidates: 4096 });

function pointSegmentDistanceSq(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const unclamped = lengthSq > 1e-9
        ? ((px - ax) * dx + (pz - az) * dz) / lengthSq
        : 0;
    const t = Math.max(0, Math.min(1, unclamped));
    const qx = ax + dx * t;
    const qz = az + dz * t;
    return (px - qx) ** 2 + (pz - qz) ** 2;
}

function roadSegmentRelation(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const unclamped = lengthSq > 1e-9
        ? ((px - ax) * dx + (pz - az) * dz) / lengthSq
        : 0;
    const t = Math.max(0, Math.min(1, unclamped));
    const qx = ax + dx * t;
    const qz = az + dz * t;
    const length = Math.sqrt(lengthSq) || 1;
    return {
        distanceM: Math.hypot(px - qx, pz - qz),
        ux: dx / length,
        uz: dz / length,
        side: Math.sign(dx * (pz - qz) - dz * (px - qx)),
    };
}

function dividedRoadMedianClearance(relations) {
    const nearby = relations
        .filter(item => item.distanceM >= 3.4 && item.distanceM <= 9)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, 6);
    for (let left = 0; left < nearby.length; left += 1) {
        for (let right = left + 1; right < nearby.length; right += 1) {
            const a = nearby[left];
            const b = nearby[right];
            if (a.side === 0 || b.side === 0 || a.side === b.side) continue;
            if (Math.abs(a.ux * b.ux + a.uz * b.uz) < 0.92) continue;
            if (a.distanceM + b.distanceM < 8) continue;
            if (Math.abs(a.distanceM - b.distanceM) > 2.5) continue;
            return Math.min(a.distanceM, b.distanceM) - 3.4;
        }
    }
    return null;
}

function* buildTrackSegmentGridSteps(trackFeatures, anchorLat, anchorLon, { limits, groundTracksOnly, step }) {
    const metresPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const longitudeScale = metresPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const cells = new Map();
    let coordinatesSeen = 0, entries = 0;
    const push = (key, segment) => {
        const existing = cells.get(key);
        if ((existing?.length || 0) >= limits.maxCellCandidates) throw Object.assign(
            new RangeError('Track clearance cell exceeds capacity'), { code: 'ground-generation-capacity' });
        if (existing) existing.push(segment);
        else cells.set(key, [segment]);
    };

    for (const feature of trackFeatures || []) {
        yield* step();
        const geometry = feature?.geometry;
        const lines = geometry?.type === 'LineString' ? [geometry.coordinates || []]
            : groundTracksOnly && geometry?.type === 'MultiLineString' ? geometry.coordinates || [] : [];
        for (const coordinates of lines) {
        if (!Array.isArray(coordinates) || (coordinatesSeen += coordinates.length) > limits.maxCoordinates) throw Object.assign(
            new RangeError('Track clearance coordinates exceed capacity'), { code: 'ground-generation-capacity' });
        for (let index = 0; index + 1 < coordinates.length; index += 1) {
            yield* step();
            if (groundTracksOnly && [coordinates[index], coordinates[index + 1]].some(coord => {
                const y = Number(coord?.[2]); return Number.isFinite(y) && Math.abs(y) > .5;
            })) continue;
            const ax = (coordinates[index][0] - anchorLon) * longitudeScale;
            const az = -(coordinates[index][1] - anchorLat) * metresPerDegree;
            const bx = (coordinates[index + 1][0] - anchorLon) * longitudeScale;
            const bz = -(coordinates[index + 1][1] - anchorLat) * metresPerDegree;
            const segment = { ax, az, bx, bz, feature };
            if (![ax, az, bx, bz].every(Number.isFinite)) throw new TypeError('Track clearance coordinates must be finite');
            const col0 = Math.floor(Math.min(ax, bx) / GRID_CELL_M);
            const col1 = Math.floor(Math.max(ax, bx) / GRID_CELL_M);
            const row0 = Math.floor(Math.min(az, bz) / GRID_CELL_M);
            const row1 = Math.floor(Math.max(az, bz) / GRID_CELL_M);
            const count = (col1 - col0 + 1) * (row1 - row0 + 1);
            if (!Number.isSafeInteger(count) || (entries += count) > limits.maxIndexEntries) throw Object.assign(
                new RangeError('Track clearance index exceeds capacity'), { code: 'ground-generation-capacity' });
            for (let row = row0; row <= row1; row += 1) {
                for (let col = col0; col <= col1; col += 1) {
                    yield* step();
                    push(`${row},${col}`, segment);
                }
            }
        }
        }
    }

    return {
        minDistanceSq(x, z, ignoreTrackFeature = null) {
            const row = Math.floor(z / GRID_CELL_M);
            const col = Math.floor(x / GRID_CELL_M);
            let best = Infinity;
            for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
                for (let colDelta = -1; colDelta <= 1; colDelta += 1) {
                    const segments = cells.get(`${row + rowDelta},${col + colDelta}`);
                    if (!segments) continue;
                    for (const segment of segments) {
                        if (ignoreTrackFeature && segment.feature === ignoreTrackFeature) continue;
                        best = Math.min(best, pointSegmentDistanceSq(
                            x,
                            z,
                            segment.ax,
                            segment.az,
                            segment.bx,
                            segment.bz,
                        ));
                    }
                }
            }
            return best;
        },
    };
}

// Returns a clearance score at local (x, z). Non-negative means the support is
// outside road and track envelopes; a larger score is a better placement.
export function createPillarClearanceEvaluator(
    anchorLat,
    anchorLon,
    trackFeatures,
    options = {},
) {
    const steps = createPillarClearanceEvaluatorSteps(anchorLat, anchorLon, trackFeatures, options);
    try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
    finally { steps.return(); }
}

export function* createPillarClearanceEvaluatorSteps(anchorLat, anchorLon, trackFeatures = [],
    {
        roadClearanceM = ROAD_CLEARANCE_M,
        trackClearanceM = TRACK_CLEARANCE_M,
        allowDividedRoadMedian = true,
        roadSegmentsAt = nearbyRoadSegments, groundTracksOnly = false,
        limits = PILLAR_CLEARANCE_LIMITS, now = () => performance.now(), isCurrent = () => true,
    } = {},
) {
    if (![anchorLat, anchorLon].every(Number.isFinite) || !Array.isArray(trackFeatures)
        || !Object.keys(PILLAR_CLEARANCE_LIMITS).every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)
        || typeof roadSegmentsAt !== 'function') throw new TypeError('Invalid captured pillar clearance inputs');
    if (trackFeatures.length > limits.maxFeatures) throw Object.assign(
        new RangeError('Track clearance features exceed capacity'), { code: 'ground-generation-capacity' });
    const check = () => { if (!isCurrent()) throw Object.assign(new Error('Pillar clearance inputs expired'), { code: 'ground-generation-stale' }); };
    check();
    let deadline = now() + .5;
    function* step() { check(); if (now() >= deadline) { yield { phase: 'planner-pillar-clearance' }; check(); deadline = now() + .5; } }
    const metresPerDegree = DEG_TO_RAD * EARTH_RADIUS_M;
    const longitudeScale = metresPerDegree * Math.cos(anchorLat * DEG_TO_RAD);
    const trackGrid = yield* buildTrackSegmentGridSteps(trackFeatures, anchorLat, anchorLon, { limits, groundTracksOnly, step });
    check();
    const resolvedRoadClearanceM = Math.max(0, Number(roadClearanceM) || 0);
    const resolvedTrackClearanceM = Math.max(0, Number(trackClearanceM) || 0);
    return (x, z, { ignoreTrackFeature = null } = {}) => {
        const lon = anchorLon + x / longitudeScale;
        const lat = anchorLat - z / metresPerDegree;
        let minimumRoadDistanceSq = Infinity;
        const roadRelations = [];
        const roads = roadSegmentsAt(lon, lat);
        if (!Array.isArray(roads) || roads.length > limits.maxRoadCandidates) throw Object.assign(
            new RangeError('Pillar road query exceeds capacity'), { code: 'ground-generation-capacity' });
        for (const [aLon, aLat, bLon, bLat] of roads) {
            const ax = (aLon - anchorLon) * longitudeScale;
            const az = -(aLat - anchorLat) * metresPerDegree;
            const bx = (bLon - anchorLon) * longitudeScale;
            const bz = -(bLat - anchorLat) * metresPerDegree;
            const relation = roadSegmentRelation(x, z, ax, az, bx, bz);
            roadRelations.push(relation);
            minimumRoadDistanceSq = Math.min(
                minimumRoadDistanceSq,
                relation.distanceM ** 2,
            );
        }
        const medianClearance = allowDividedRoadMedian
            ? dividedRoadMedianClearance(roadRelations)
            : null;
        const roadClearance = medianClearance === null
            ? Math.sqrt(minimumRoadDistanceSq) - resolvedRoadClearanceM
            : medianClearance;
        return Math.min(
            roadClearance,
            Math.sqrt(trackGrid.minDistanceSq(x, z, ignoreTrackFeature)) - resolvedTrackClearanceM,
        );
    };
}
