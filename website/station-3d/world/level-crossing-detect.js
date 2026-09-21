// Projects the rail formation's AT-GRADE stretches + nearby road centrelines
// into local level-crossing frames, so both the wall-suppression (world/rails.js)
// and the crossing dressing (world/level-crossings.js) work off ONE detection.
//
// All the geometry is the tested pure core (core/level-crossing.js); this thin
// glue only reads the streamed road centrelines from the RoadFormationModel
// (both already in the local frame, so no lon/lat projection). It uses the road
// formation rather than the baked road-index because that index is empty for
// some locations (e.g. Split) while the streamed /roads centrelines are not.

import { collectAtGradeLevelCrossingsSteps } from '../core/level-crossing.js';

// A track sample is at-grade when its formation sits within this of the terrain
// (matches the rail-formation fill/at-grade boundary sense) — BOTH the fill
// height (maxFillM) and the cut cover (minCoverM) must be small. A cut has
// maxFillM = 0 but real minCoverM, so requiring both keeps a deep cut (which is
// grade-separated: the road passes over) from being dressed as a level crossing.
const AT_GRADE_EPS_M = 0.6;
// How far off the trackbed to look for road centrelines at each at-grade sample.
const ROAD_QUERY_RADIUS_M = 40;

// railFormation.alignments each carry {samples:[{x,z,railY,terrainY,maxFillM,
// minCoverM}], halfWidthM}; roadFormation exposes nearbyCenterlineSegments(x,z,r)
// → [[x1,z1,x2,z2], …] in the local frame. Returns [{x, z, roadAxis, trackAxis,
// skewRad, halfWidthM}], one per distinct at-grade track×road crossing.
//
// options.changedBounds — the incremental contract. Detection re-runs every
// time the streamed road formation advances a revision, and it used to re-scan
// the ENTIRE alignment against every road segment within 40 m of the whole
// corridor each time: on a 52 km project that was ~150 ms, ~25 times over a
// five-minute prod ride, for crossings that were already in the accumulator.
// The caller's accumulator only ever GROWS, so a re-run can only contribute
// crossings involving roads that CHANGED since the last pass — and the road
// formation reports exactly where it changed (getChangesSince). When
// changedBounds is an array, only samples within a bound (padded by the query
// radius, which covers a track segment reaching a road inside the bound from a
// sample just outside it) are examined. Pass no changedBounds for a FULL scan
// — first run, formation history overflow, or a rail-side change, where every
// crossing must be findable from scratch.
export function detectAtGradeLevelCrossings(railFormation, roadFormation, options = {}) {
    const steps = detectAtGradeLevelCrossingsSteps(railFormation, roadFormation, options);
    let next; do { next = steps.next(); } while (!next.done); return next.value;
}

export function* detectAtGradeLevelCrossingsSteps(railFormation, roadFormation, options = {}) {
    const now = options.now || (() => performance.now()), current = options.isCurrent || (() => true);
    let started = now();
    const out = [];
    if (!railFormation || !Array.isArray(railFormation.alignments)) return out;
    if (!roadFormation || typeof roadFormation.nearbyCenterlineSegments !== 'function') return out;
    const changedBounds = Array.isArray(options.changedBounds) ? options.changedBounds : null;
    if (changedBounds && changedBounds.length === 0) return out;
    const pad = ROAD_QUERY_RADIUS_M;
    function* inChangedBounds(x, z) {
        for (const bound of changedBounds) {
            if (now() - started >= .5) { yield { phase: 'crossing-changed-bounds' }; started = now(); if (!current()) return null; }
            if (x >= bound.minX - pad && x <= bound.maxX + pad
                && z >= bound.minZ - pad && z <= bound.maxZ + pad) return true;
        }
        return false;
    }

    for (const alignment of railFormation.alignments) {
        if (!current()) return null;
        if (now() - started >= .5) { yield { phase: 'crossing-alignment' }; started = now(); if (!current()) return null; }
        const samples = alignment && alignment.samples;
        if (!Array.isArray(samples) || samples.length < 2) continue;
        const halfWidthM = Number(alignment.halfWidthM) || 3;
        const trackPts = [], atGrade = [];
        for (const s of samples) {
            if (now() - started >= .5) { yield { phase: 'crossing-sample' }; started = now(); if (!current()) return null; }
            trackPts.push([s.x, s.z]);
            const changed = !changedBounds || (yield* inChangedBounds(s.x, s.z));
            if (!current()) return null;
            const knownLevels = Number.isFinite(s.railY) && Number.isFinite(s.terrainY);
            const fill = Number.isFinite(s.maxFillM) ? s.maxFillM
                : knownLevels ? Math.max(0, s.railY - s.terrainY) : null;
            const cover = Number.isFinite(s.minCoverM) ? s.minCoverM
                : knownLevels ? Math.max(0, s.terrainY - s.railY) : null;
            atGrade.push(!!changed && fill !== null && cover !== null
                && fill <= AT_GRADE_EPS_M && cover <= AT_GRADE_EPS_M);
        }
        // Every distinct road centreline near the at-grade stretch, in the local
        // frame. Deduped by rounded endpoints so overlapping radius queries don't
        // multiply segments.
        const segs = [];
        const seen = new Set();
        for (let i = 0; i < samples.length; i++) {
            if (now() - started >= .5) { yield { phase: 'crossing-road-query' }; started = now(); if (!current()) return null; }
            if (!atGrade[i]) continue;
            for (const seg of roadFormation.nearbyCenterlineSegments(samples[i].x, samples[i].z, ROAD_QUERY_RADIUS_M)) {
                if (now() - started >= .5) { yield { phase: 'crossing-road-dedup' }; started = now(); if (!current()) return null; }
                const key = seg.map((v) => Number(v).toFixed(2)).join(',');
                if (seen.has(key)) continue;
                seen.add(key);
                segs.push(seg);
            }
        }
        if (segs.length === 0) continue;
        const frames = yield* collectAtGradeLevelCrossingsSteps(trackPts, atGrade, segs, { now, isCurrent: current });
        if (!frames) return null;
        for (const frame of frames) {
            if (now() - started >= .5) { yield { phase: 'crossing-frame' }; started = now(); if (!current()) return null; }
            frame.halfWidthM = halfWidthM;
            out.push(frame);
        }
    }
    return current() ? out : null;
}
