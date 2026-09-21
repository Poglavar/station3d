// Push a closed lon/lat ring outward by a fixed distance in metres, along each
// vertex's outward bisector. Pure — no DOM, no three.js — so the geometry is
// unit-testable headless.
//
// Why this exists: an overlay facade (the VG curtain wall) is built from the very
// same footprint ring as the extrusion wall underneath it, so the two are exactly
// coplanar and z-fight. polygonOffset was supposed to separate them, but it is a
// depth-buffer bias — its effect shrinks with distance and precision, so the
// fighting reappears a few hundred metres out. A real geometric offset of a couple
// of centimetres does not care about range.

const M_PER_DEG_LAT = 111320;

// Standard shoelace, in lon/lat units. Positive = counter-clockwise in a y-up
// (north-up) reading of the coordinates, which is what decides which side
// "outward" is on. Note this is the opposite sign to the (x2-x1)(y2+y1) variant.
export function ringSignedArea(ring) {
    let sum = 0;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}

// `ring` is a closed GeoJSON ring ([[lon,lat], …] with the last point repeating the
// first). Returns a new closed ring pushed outward by `metres`. Degenerate input is
// returned untouched rather than exploded — a bad ring should render in the wrong
// place, not crash the building layer.
export function offsetRingOutward(ring, metres, latitudeForScale = null) {
    if (!Array.isArray(ring) || ring.length < 4 || !Number.isFinite(metres) || metres === 0) {
        return ring;
    }
    const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    const pts = closed ? ring.slice(0, -1) : ring.slice();
    const n = pts.length;
    if (n < 3) return ring;

    const lat = Number.isFinite(latitudeForScale) ? latitudeForScale : pts[0][1];
    const mPerDegLon = M_PER_DEG_LAT * Math.max(0.01, Math.cos(lat * Math.PI / 180));
    // A clockwise ring (negative signed area under this convention) needs the
    // opposite normal, or the "outward" push shrinks the footprint instead.
    const sign = ringSignedArea(closed ? ring : [...ring, ring[0]]) > 0 ? 1 : -1;

    const out = [];
    for (let i = 0; i < n; i++) {
        const prev = pts[(i - 1 + n) % n];
        const cur = pts[i];
        const next = pts[(i + 1) % n];

        // Work in metres so the bisector is not skewed by the lon/lat aspect ratio.
        const e1x = (cur[0] - prev[0]) * mPerDegLon;
        const e1y = (cur[1] - prev[1]) * M_PER_DEG_LAT;
        const e2x = (next[0] - cur[0]) * mPerDegLon;
        const e2y = (next[1] - cur[1]) * M_PER_DEG_LAT;
        const l1 = Math.hypot(e1x, e1y) || 1;
        const l2 = Math.hypot(e2x, e2y) || 1;

        // Outward normal of an edge is its direction rotated -90°, times winding.
        const n1x = (e1y / l1) * sign;
        const n1y = (-e1x / l1) * sign;
        const n2x = (e2y / l2) * sign;
        const n2y = (-e2x / l2) * sign;

        let bx = n1x + n2x;
        let by = n1y + n2y;
        const bl = Math.hypot(bx, by);
        if (bl < 1e-9) { bx = n2x; by = n2y; }        // 180° spike: fall back to one edge
        else { bx /= bl; by /= bl; }

        // Miter: moving the vertex ALONG the bisector by `metres` only offsets each
        // edge by metres·cos(half-angle) — a right-angle corner would come out at
        // metres/√2. Divide by that cosine so every EDGE ends up `metres` out.
        // Clamped because the scale runs away as a corner approaches a spike.
        const cosHalf = Math.max(0.25, bx * n2x + by * n2y);
        const step = metres / cosHalf;

        out.push([
            cur[0] + (bx * step) / mPerDegLon,
            cur[1] + (by * step) / M_PER_DEG_LAT,
        ]);
    }
    out.push([out[0][0], out[0][1]]);
    return out;
}

// Same, applied to a GeoJSON Polygon/MultiPolygon's OUTER rings only. Holes are
// left alone: a curtain wall overlay is drawn on the outside of the building, and
// nudging a courtyard's ring outward would shrink the courtyard into the facade.
export function offsetPolygonOutward(geometry, metres, latitudeForScale = null) {
    if (!geometry || !Number.isFinite(metres) || metres === 0) return geometry;
    if (geometry.type === 'Polygon') {
        const [outer, ...holes] = geometry.coordinates || [];
        if (!outer) return geometry;
        return {
            ...geometry,
            coordinates: [offsetRingOutward(outer, metres, latitudeForScale), ...holes],
        };
    }
    if (geometry.type === 'MultiPolygon') {
        return {
            ...geometry,
            coordinates: (geometry.coordinates || []).map((part) => {
                const [outer, ...holes] = part || [];
                if (!outer) return part;
                return [offsetRingOutward(outer, metres, latitudeForScale), ...holes];
            }),
        };
    }
    return geometry;
}
