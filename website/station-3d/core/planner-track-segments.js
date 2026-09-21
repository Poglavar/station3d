// Planner source conversion is independent of Three.js and of publication.
// The same captured terrain frame supplies every endpoint and evidence probe.
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { plannerStructureJoinVector } from './planner-opening-boundaries.js';

export const PLANNER_TRACK_SEGMENT_LIMITS = Object.freeze({
    maxFeatures: 4096, maxCoordinates: 262144, maxSegments: 262144, maxEvidenceQueries: 1048576,
});
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function* capturePlannerTrackSegmentsSteps(features, anchorLat, anchorLon, {
    absoluteToSceneY = null, groundSceneYAtLocal = null, elevationEpsilon = .5,
    limits = PLANNER_TRACK_SEGMENT_LIMITS, now = () => performance.now(), isCurrent = () => true,
} = {}) {
    features ||= [];
    if (!Array.isArray(features) || ![anchorLat, anchorLon, elevationEpsilon].every(Number.isFinite)
        || elevationEpsilon < 0 || !Object.keys(PLANNER_TRACK_SEGMENT_LIMITS)
            .every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)) {
        throw new TypeError('Planner tracks require an explicit frame and finite capacities');
    }
    const capacity = () => fail('ground-generation-capacity', 'Planner track source capacity exceeded');
    if (features.length > limits.maxFeatures) capacity();
    let deadline = now() + .5, coordinateCount = 0, evidenceQueries = 0;
    function* budget(phase) {
        if (!isCurrent()) fail('ground-generation-stale', 'Planner track source capture expired');
        if (now() >= deadline) {
            yield { phase };
            if (!isCurrent()) fail('ground-generation-stale', 'Planner track source capture expired');
            deadline = now() + .5;
        }
    }
    const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
    const SCALE_LON = M_PER_DEG * Math.cos(anchorLat * DEG_TO_RAD);
    const segments = [];
    let terrainEvidenceIncomplete = false;
    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        yield* budget('planner-track-feature');
        const f = features[featureIndex], geom = f?.geometry;
        if (!geom || geom.type !== 'LineString') continue;
        const properties = f.properties || {};
        const usesAbsoluteElevation = properties.elevationMode === 'absolute';
        const toSceneY = usesAbsoluteElevation && typeof absoluteToSceneY === 'function' ? absoluteToSceneY : null;
        // Photo heights belong to the photo frame. Terrain-relative/absolute
        // tracks are converted here but their civil geometry belongs to rails.
        if (properties.elevationDatum === 'asl' || usesAbsoluteElevation && !toSceneY) continue;
        const groundY = properties.elevationMode === 'ground-relative' && typeof groundSceneYAtLocal === 'function'
            ? groundSceneYAtLocal : null;
        const structuresBuiltElsewhere = !!toSceneY || !!groundY;
        const trackId = properties.trackId ?? null, trackIds = [];
        for (const id of Array.isArray(properties.trackIds) ? properties.trackIds : []) {
            if (trackIds.length >= limits.maxFeatures) capacity();
            yield* budget('planner-track-identity'); trackIds.push(String(id));
        }
        const coords = geom.coordinates || [];
        if (!Array.isArray(coords)) throw new TypeError('Planner track coordinates must be an array');
        coordinateCount += coords.length;
        if (coordinateCount > limits.maxCoordinates) capacity();
        if (groundY) {
            let missingEvidence = false;
            for (let index = 0; index < coords.length - 1 && !missingEvidence; index++) {
                yield* budget('planner-track-evidence-segment');
                const a = coords[index], b = coords[index + 1];
                const ax = (Number(a?.[0]) - anchorLon) * SCALE_LON;
                const az = -(Number(a?.[1]) - anchorLat) * M_PER_DEG;
                const bx = (Number(b?.[0]) - anchorLon) * SCALE_LON;
                const bz = -(Number(b?.[1]) - anchorLat) * M_PER_DEG;
                if (![ax, az, bx, bz].every(Number.isFinite)) continue;
                const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 20));
                for (let step = 0; step <= steps; step++) {
                    if (++evidenceQueries > limits.maxEvidenceQueries) capacity();
                    yield* budget('planner-track-evidence');
                    const t = step / steps;
                    if (finiteOrNull(groundY(ax + (bx - ax) * t, az + (bz - az) * t)) === null) {
                        missingEvidence = true; break;
                    }
                }
            }
            if (missingEvidence) { terrainEvidenceIncomplete = true; continue; }
        }
        let elevated = false;
        for (const coord of coords) {
            yield* budget('planner-track-elevation');
            if (Number.isFinite(coord[2]) && Math.abs(coord[2]) > elevationEpsilon) { elevated = true; break; }
        }
        if (!elevated) continue;
        const localPoints = [], frames = [], joins = [];
        for (const [lng, lat] of coords) {
            yield* budget('planner-track-coordinate');
            localPoints.push({ x: (lng - anchorLon) * SCALE_LON, z: -(lat - anchorLat) * M_PER_DEG });
        }
        for (let i = 0; i < localPoints.length - 1; i++) {
            yield* budget('planner-track-frame');
            const dx = localPoints[i + 1].x - localPoints[i].x, dz = localPoints[i + 1].z - localPoints[i].z;
            const len = Math.hypot(dx, dz);
            frames.push(len > 1e-6 ? { x: -dz / len, z: dx / len } : null);
        }
        for (let i = 0; i < localPoints.length; i++) {
            yield* budget('planner-track-join');
            joins.push(plannerStructureJoinVector(frames[i - 1], frames[i]));
        }
        let routeStartM = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            yield* budget('planner-track-segment');
            const elev1 = coords[i][2], elev2 = coords[i + 1][2];
            const rawE1 = Number.isFinite(elev1) ? elev1 : 0, rawE2 = Number.isFinite(elev2) ? elev2 : 0;
            const { x: x1, z: z1 } = localPoints[i], { x: x2, z: z2 } = localPoints[i + 1];
            if (groundY && (evidenceQueries += 2) > limits.maxEvidenceQueries) capacity();
            const groundE1 = groundY ? finiteOrNull(groundY(x1, z1)) : null;
            const groundE2 = groundY ? finiteOrNull(groundY(x2, z2)) : null;
            if (groundY && (groundE1 === null || groundE2 === null)) {
                terrainEvidenceIncomplete = true;
                routeStartM += Math.hypot(x2 - x1, z2 - z1); continue;
            }
            const e1 = toSceneY ? toSceneY(rawE1) : groundY ? groundE1 + rawE1 : rawE1;
            const e2 = toSceneY ? toSceneY(rawE2) : groundY ? groundE2 + rawE2 : rawE2;
            const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
            if (![x1, z1, x2, z2, e1, e2].every(Number.isFinite)) {
                fail('ground-source-unavailable', 'Planner track lacks finite converted coordinates');
            }
            if (len < .01) continue;
            if (segments.length >= limits.maxSegments) capacity();
            segments.push({ featureIndex, featureSegmentIndex: i, routeStartM, trackId, trackIds, properties,
                structuresBuiltElsewhere, cx: (x1 + x2) * .5, cz: (z1 + z2) * .5,
                angle: Math.atan2(dx, dz), len, e1, e2, x1, z1, x2, z2,
                startJoinX: joins[i].x, startJoinZ: joins[i].z, endJoinX: joins[i + 1].x, endJoinZ: joins[i + 1].z });
            routeStartM += len;
        }
    }
    if (!isCurrent()) fail('ground-generation-stale', 'Planner track source capture expired');
    if (terrainEvidenceIncomplete) Object.defineProperty(segments, 'terrainEvidenceIncomplete', { value: true });
    return segments;
}

export function capturePlannerTrackSegments(...args) {
    const steps = capturePlannerTrackSegmentsSteps(...args);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
