// Light geometric smoothing for surveyed rail LineStrings. Real rails curve
// smoothly, but source geometry often approximates them as straight chords
// meeting at visible kinks. At each interior BENDING vertex we replace
// the corner with a densely sampled quadratic Bézier fillet. Long fillets use
// almost half of each adjacent chord, so successive bends read as one smooth
// curve rather than several straight bars joined by tiny rounded corners.
//
// Rules that keep the rest of the system intact:
// - A vertex shared with ANY other feature (junction / way split) is never
//   touched — the driver graph's connectivity and the switch-rule node keys
//   are derived from those exact coordinates.
// - A vertex ADJACENT to a shared vertex or feature endpoint is never touched
//   either: switch rules are keyed by (switchNode, incomingNeighbor) coords,
//   so a junction's immediate neighbours must keep their original positions
//   or every rule lookup at that junction silently fails (armed turns get
//   ignored and the tram is forced straight).
// - A boundary in optional properties.segmentTrackIds is structural too, and
//   the metadata is expanded alongside any generated curve segments.
// - Optional railSourceChainagesM is vertex-aligned authoritative civil data.
//   It is interpolated through every generated fillet vertex; dropping that
//   alignment makes rail formation discard published tunnel portals and infer
//   them again from whatever terrain happens to be loaded around the cab.
// - Near-straight joints (< MIN_TURN_DEG) pass through unchanged.
// - Very sharp joints (> MAX_TURN_DEG, i.e. real switch frogs and crossings)
//   stay crisp — rounding those would misrepresent actual track geometry.
// - Short-segment joints (either side < MIN_ADJ_LEN_M) pass through: those
//   polylines are already finely sampled and need no extra vertices.
//
// Both the rendered rails AND the driver graph are built from the smoothed
// features (cab.js smooths once at session start), so the player tram follows
// the exact curves it sees. Schedule-autopilot trams ride pre-resolved paths
// and may sit slightly off the rendered rail mid-curve; the deviation remains
// local to the two surveyed chords around the original vertex.

import { DEG_TO_RAD, EARTH_RADIUS_M } from './math.js';

const MIN_TURN_DEG = 4;
const MAX_TURN_DEG = 50;
const MAX_FILLET_M = 8;       // max distance from corner to fillet entry/exit
const ADJ_LEN_FRACTION = 0.48; // leave a small straight connector between fillets
const MIN_ADJ_LEN_M = 2.4;    // both neighbours must be at least this long
const CURVE_SAMPLE_SPACING_M = 0.75;

function vertexKey(c) {
    return `${Number(c[0]).toFixed(7)},${Number(c[1]).toFixed(7)}`;
}

// opts can tune the per-corner caps. Hand-drawn proposal routes treat sharp
// corners as sketch artifacts (not switch frogs), while 20 m-sampled heavy
// rail needs a lower minimum angle than dense OSM tram geometry. The city
// network keeps the strict defaults above.
export function smoothTrackFeatures(features, opts = {}) {
    if (!Array.isArray(features) || features.length === 0) return features;

    // Vertices used more than once (within or across features) are structural.
    const useCount = new Map();
    for (const f of features) {
        const geom = f && f.geometry;
        if (!geom || geom.type !== 'LineString') continue;
        for (const c of geom.coordinates) {
            const k = vertexKey(c);
            useCount.set(k, (useCount.get(k) || 0) + 1);
        }
    }

    return features.map((f) => {
        const geom = f && f.geometry;
        if (!geom || geom.type !== 'LineString' || geom.coordinates.length < 3) return f;
        const featureOpts = typeof opts.optionsForFeature === 'function'
            ? { ...opts, ...(opts.optionsForFeature(f) || {}) }
            : opts;
        const minTurnDeg = Number.isFinite(featureOpts.minTurnDeg)
            ? Math.max(0, featureOpts.minTurnDeg)
            : MIN_TURN_DEG;
        const maxTurnDeg = Number.isFinite(featureOpts.maxTurnDeg)
            ? featureOpts.maxTurnDeg
            : MAX_TURN_DEG;
        const maxFilletM = Number.isFinite(featureOpts.maxFilletM)
            ? featureOpts.maxFilletM
            : MAX_FILLET_M;
        const coords = geom.coordinates;
        const sourceSegmentTrackIds = Array.isArray(f?.properties?.segmentTrackIds)
            ? f.properties.segmentTrackIds
            : null;
        const sourceChainagesM = Array.isArray(f?.properties?.railSourceChainagesM)
            && f.properties.railSourceChainagesM.length === coords.length
            && f.properties.railSourceChainagesM.every(Number.isFinite)
            ? f.properties.railSourceChainagesM
            : null;
        const cosLat = Math.cos(coords[0][1] * DEG_TO_RAD);
        const M_PER_DEG = DEG_TO_RAD * EARTH_RADIUS_M;
        const hasElevation = coords.some(c => Number.isFinite(Number(c[2])));
        // Local metres for angle/length math; conversions are linear so we can
        // mix freely with degree-space output.
        const toXY = (c) => ({ x: c[0] * M_PER_DEG * cosLat, y: c[1] * M_PER_DEG });
        const toLngLat = (p, elevation) => {
            const coord = [p.x / (M_PER_DEG * cosLat), p.y / M_PER_DEG];
            if (hasElevation) coord.push(Number.isFinite(elevation) ? elevation : 0);
            return coord;
        };
        const elevationOf = (coord) => Number.isFinite(Number(coord && coord[2]))
            ? Number(coord[2])
            : 0;

        const isTrackBoundary = (idx) => sourceSegmentTrackIds
            && idx > 0
            && idx < coords.length - 1
            && sourceSegmentTrackIds[idx - 1] !== sourceSegmentTrackIds[idx];
        const isJunctionStructural = (idx) =>
            idx <= 0
            || idx >= coords.length - 1
            || (useCount.get(vertexKey(coords[idx])) || 0) > 1;

        const out = [coords[0]];
        const outSegmentTrackIds = [];
        const outSourceChainagesM = sourceChainagesM ? [sourceChainagesM[0]] : null;
        const pushOut = (coordinate, sourceSegmentIndex, sourceChainageM = null) => {
            out.push(coordinate);
            if (sourceSegmentTrackIds) {
                outSegmentTrackIds.push(sourceSegmentTrackIds[sourceSegmentIndex] ?? null);
            }
            if (outSourceChainagesM) outSourceChainagesM.push(sourceChainageM);
        };
        let changed = false;
        for (let i = 1; i < coords.length - 1; i++) {
            const v = coords[i];
            // Keep the vertex AND its exact neighbours of structural nodes:
            // switch rules key on (junction, neighbour) coordinate pairs.
            if (isTrackBoundary(i)
                || isJunctionStructural(i)
                || isJunctionStructural(i - 1)
                || isJunctionStructural(i + 1)) {
                pushOut(v, i - 1, sourceChainagesM?.[i]);
                continue;
            }
            const a = toXY(coords[i - 1]), b = toXY(v), c = toXY(coords[i + 1]);
            const inx = b.x - a.x, iny = b.y - a.y;
            const outx = c.x - b.x, outy = c.y - b.y;
            const lin = Math.hypot(inx, iny), lout = Math.hypot(outx, outy);
            if (lin < MIN_ADJ_LEN_M || lout < MIN_ADJ_LEN_M) {
                pushOut(v, i - 1, sourceChainagesM?.[i]);
                continue;
            }
            const dot = Math.max(-1, Math.min(1, (inx * outx + iny * outy) / (lin * lout)));
            const turnDeg = Math.acos(dot) * 180 / Math.PI;
            if (turnDeg < minTurnDeg || turnDeg > maxTurnDeg) {
                pushOut(v, i - 1, sourceChainagesM?.[i]);
                continue;
            }

            const d = Math.min(maxFilletM, lin * ADJ_LEN_FRACTION, lout * ADJ_LEN_FRACTION);
            // Quadratic Bézier with the corner as control point: entry P,
            // original surveyed vertex B, exit Q. Sub-metre sampling keeps
            // both rails and the swept bed visually continuous.
            const P = { x: b.x - (inx / lin) * d,  y: b.y - (iny / lin) * d };
            const Q = { x: b.x + (outx / lout) * d, y: b.y + (outy / lout) * d };
            const elevA = elevationOf(coords[i - 1]);
            const elevB = elevationOf(coords[i]);
            const elevC = elevationOf(coords[i + 1]);
            const elevP = elevB + (elevA - elevB) * (d / lin);
            const elevQ = elevB + (elevC - elevB) * (d / lout);
            const chainageA = sourceChainagesM?.[i - 1];
            const chainageB = sourceChainagesM?.[i];
            const chainageC = sourceChainagesM?.[i + 1];
            const chainageP = sourceChainagesM
                ? chainageB + (chainageA - chainageB) * (d / lin)
                : null;
            const chainageQ = sourceChainagesM
                ? chainageB + (chainageC - chainageB) * (d / lout)
                : null;
            const sampleCount = Math.max(4, Math.ceil((d * 2) / CURVE_SAMPLE_SPACING_M));
            for (let sample = 0; sample <= sampleCount; sample++) {
                const t = sample / sampleCount;
                const omt = 1 - t;
                const point = {
                    x: omt * omt * P.x + 2 * omt * t * b.x + t * t * Q.x,
                    y: omt * omt * P.y + 2 * omt * t * b.y + t * t * Q.y,
                };
                const elevation = omt * omt * elevP + 2 * omt * t * elevB + t * t * elevQ;
                const sourceChainageM = sourceChainagesM
                    ? omt * omt * chainageP
                        + 2 * omt * t * chainageB
                        + t * t * chainageQ
                    : null;
                pushOut(
                    toLngLat(point, elevation),
                    t <= 0.5 ? i - 1 : i,
                    sourceChainageM,
                );
            }
            changed = true;
        }
        pushOut(
            coords[coords.length - 1],
            coords.length - 2,
            sourceChainagesM?.at(-1),
        );
        if (!changed) return f;
        return {
            ...f,
            ...(sourceSegmentTrackIds || outSourceChainagesM ? {
                properties: {
                    ...(f.properties || {}),
                    ...(sourceSegmentTrackIds ? { segmentTrackIds: outSegmentTrackIds } : {}),
                    ...(outSourceChainagesM ? {
                        railSourceChainagesM: outSourceChainagesM,
                    } : {}),
                },
            } : {}),
            geometry: { ...geom, coordinates: out },
        };
    });
}
