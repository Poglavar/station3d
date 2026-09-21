// Pure geometry for dressing an AT-GRADE track×road level crossing in the model
// world. Where the drawn track crosses a road exactly level (the track has
// precedence and cuts across), the crossing should still read as a proper level
// crossing: a pedestrian zebra painted across the road, and small ramp aprons
// where the road surface meets the level trackbed on either side.
//
// This module is pure planar geometry — no THREE, no DOM. It emits crossing
// frames and [x, z] quad corners; a thin world layer (mirroring lane-markings)
// turns those into painted meshes. All coordinates are the caller's local
// metric frame (station-3d uses x = east, z = -north); the module is
// frame-agnostic, so node tests can drive it with plain planar points.
//
// A crossing counts as a level crossing ONLY where the crossed track segment is
// at grade at BOTH ends. A segment on a viaduct or in a cut carries its own
// designed structure (deck / trench) and must never grow a spurious zebra.

const EPS = 1e-9;

function unit(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < EPS) return null;
    return [dx / len, dz / len, len];
}

// Segment a→b (track) vs c→d (road), each [x, z]. Returns the crossing frame
//   { x, z, tTrack, tRoad, roadAxis:[ux,uz], trackAxis:[ux,uz], skewRad }
// or null when the segments do not cross within both spans. roadAxis/trackAxis
// are unit vectors along the road / track at the crossing; skewRad is the acute
// angle between them (0 = the track runs along the road, π/2 = square crossing).
export function segmentCrossing(a, b, c, d) {
    const r = unit(b[0] - a[0], b[1] - a[1]);
    const s = unit(d[0] - c[0], d[1] - c[1]);
    if (!r || !s) return null;
    const rx = b[0] - a[0], rz = b[1] - a[1];
    const sx = d[0] - c[0], sz = d[1] - c[1];
    const denom = rx * sz - rz * sx;
    if (Math.abs(denom) < EPS) return null;   // parallel / collinear
    const qpx = c[0] - a[0], qpz = c[1] - a[1];
    const tTrack = (qpx * sz - qpz * sx) / denom;
    const tRoad = (qpx * rz - qpz * rx) / denom;
    if (tTrack < 0 || tTrack > 1 || tRoad < 0 || tRoad > 1) return null;
    const x = a[0] + rx * tTrack;
    const z = a[1] + rz * tTrack;
    const trackAxis = [r[0], r[1]];
    const roadAxis = [s[0], s[1]];
    const dot = Math.abs(trackAxis[0] * roadAxis[0] + trackAxis[1] * roadAxis[1]);
    const skewRad = Math.acos(Math.min(1, dot));
    return { x, z, tTrack, tRoad, roadAxis, trackAxis, skewRad };
}

// trackPts: [[x,z], …] track polyline; atGrade: parallel boolean[] (a vertex is
// within the at-grade epsilon of the terrain). roadSegments: [[ax,az,bx,bz], …]
// nearby road centrelines (from road-index, converted to the local frame).
// Returns the level-crossing frames, deduped so two road segments meeting at a
// crossing don't paint two overlapping zebras (mergeM = merge radius).
export function collectAtGradeLevelCrossings(trackPts, atGrade, roadSegments, options = {}) {
    const steps = collectAtGradeLevelCrossingsSteps(trackPts, atGrade, roadSegments, options);
    let next; do { next = steps.next(); } while (!next.done); return next.value;
}

export function* collectAtGradeLevelCrossingsSteps(trackPts, atGrade, roadSegments, options = {}) {
    const mergeM = Number.isFinite(options.mergeM) ? options.mergeM : 4;
    const now = options.now || (() => performance.now()), current = options.isCurrent || (() => true);
    let started = now();
    const out = [];
    if (!Array.isArray(trackPts) || !Array.isArray(roadSegments)) return out;
    const flags = Array.isArray(atGrade) ? atGrade : null;
    for (let i = 0; i < trackPts.length - 1; i++) {
        if (!current()) return null;
        if (now() - started >= .5) { yield { phase: 'crossing-track-segment' }; started = now(); if (!current()) return null; }
        // Only a track segment level at BOTH ends is a level crossing; a segment
        // straddling the threshold is a ramp the aprons/earthworks already model.
        if (flags && !(flags[i] && flags[i + 1])) continue;
        const a = trackPts[i], b = trackPts[i + 1];
        for (const seg of roadSegments) {
            if (now() - started >= .5) { yield { phase: 'crossing-road-segment' }; started = now(); if (!current()) return null; }
            const hit = segmentCrossing(a, b, [seg[0], seg[1]], [seg[2], seg[3]]);
            if (!hit) continue;
            let near = false;
            for (const h of out) {
                if (now() - started >= .5) { yield { phase: 'crossing-dedup' }; started = now(); if (!current()) return null; }
                if (Math.hypot(h.x - hit.x, h.z - hit.z) <= mergeM) { near = true; break; }
            }
            if (near) continue;   // keep the first; skip a near-duplicate crossing
            hit.segmentIndex = i;
            out.push(hit);
        }
    }
    return current() ? out : null;
}

// Zebra band across the road at a crossing. Stripes run PARALLEL to the road
// axis (the direction cars travel) and repeat across the carriageway width — the
// standard zebra layout. Each stripe is a quad [c0, c1, c2, c3] of [x, z].
//   roadWidthM  carriageway width painted across (default 7 m, two lanes)
//   bandDepthM  depth of the crossing along the road (default 4 m)
//   stripeW     stripe width across the road (default 0.5 m)
//   gapW        gap between stripes (default 0.5 m)
//   offsetM     shift the band along the road off the track centre so the zebra
//               sits BESIDE the rails, not on them (default 0 = centred)
export function buildZebraStripes(frame, options = {}) {
    const roadWidthM = Number.isFinite(options.roadWidthM) ? options.roadWidthM : 7;
    const bandDepthM = Number.isFinite(options.bandDepthM) ? options.bandDepthM : 4;
    const stripeW = Number.isFinite(options.stripeW) ? options.stripeW : 0.5;
    const gapW = Number.isFinite(options.gapW) ? options.gapW : 0.5;
    const offsetM = Number.isFinite(options.offsetM) ? options.offsetM : 0;
    const [ux, uz] = frame.roadAxis;          // along the road (stripe long axis)
    const nx = -uz, nz = ux;                  // across the road
    // Band centre, optionally nudged along the road so the zebra sits beside the
    // track instead of under it.
    const cx = frame.x + ux * offsetM;
    const cz = frame.z + uz * offsetM;
    const halfDepth = bandDepthM / 2;
    const period = stripeW + gapW;
    const count = Math.max(1, Math.floor(roadWidthM / period));
    // Centre the run of stripes across the carriageway.
    const totalSpan = count * period - gapW;
    const start = -totalSpan / 2;
    const quads = [];
    for (let i = 0; i < count; i++) {
        const s0 = start + i * period;         // near edge of this stripe (across)
        const s1 = s0 + stripeW;               // far edge
        const corner = (across, along) => [
            cx + nx * across + ux * along,
            cz + nz * across + uz * along,
        ];
        quads.push([
            corner(s0, -halfDepth),
            corner(s1, -halfDepth),
            corner(s1, halfDepth),
            corner(s0, halfDepth),
        ]);
    }
    return quads;
}

// Approach aprons: two short quads either side of the trackbed where the road
// surface ramps up to meet the level trackbed. Returns [quadNear, quadFar],
// each a [x, z] quad, on the −roadAxis and +roadAxis sides of the crossing.
//   trackHalfWidthM  half-width of the level trackbed the road abuts (default 3)
//   apronLenM        along-road length of each apron ramp (default 2.5)
//   roadWidthM       across-road width of the apron (default matches the zebra)
export function buildCrossingAprons(frame, options = {}) {
    const trackHalfWidthM = Number.isFinite(options.trackHalfWidthM) ? options.trackHalfWidthM : 3;
    const apronLenM = Number.isFinite(options.apronLenM) ? options.apronLenM : 2.5;
    const roadWidthM = Number.isFinite(options.roadWidthM) ? options.roadWidthM : 7;
    const [ux, uz] = frame.roadAxis;
    const nx = -uz, nz = ux;
    const halfW = roadWidthM / 2;
    const corner = (along, across) => [
        frame.x + ux * along + nx * across,
        frame.z + uz * along + nz * across,
    ];
    const apron = (d0, d1) => [
        corner(d0, -halfW),
        corner(d1, -halfW),
        corner(d1, halfW),
        corner(d0, halfW),
    ];
    return [
        apron(-(trackHalfWidthM + apronLenM), -trackHalfWidthM),  // near side
        apron(trackHalfWidthM, trackHalfWidthM + apronLenM),      // far side
    ];
}
