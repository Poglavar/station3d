// Pure planning for tunnel-wall distance markers — no three.js, no DOM — so the
// placement rules are unit-testable headless. A marker is painted every spacingM
// of ABSOLUTE chainage (same fixed-grid philosophy as the ceiling-light and
// pillar rhythms): the plate shows the exact remaining metres to the portal the
// countdown runs toward, so a 395 m bore reads 345, 295, 245, ... — decreasing
// by spacingM, not pinned to round numbers. The RIGHT wall (in the direction of
// increasing chainage) counts down to the far end; the LEFT wall counts down to
// the near end, serving drivers going the other way.

export const TUNNEL_MARKER_SPACING_M = 50;
export const TUNNEL_MARKER_MIN_SPAN_M = 50;   // a tube shorter than the grid gets no signage
export const TUNNEL_MARKER_ROUND_M = 5;       // wayfinding precision, not false exactness

// spans: [{ startM, endM }] in chainage metres (need not be sorted).
// Returns one record per grid position inside a long-enough span:
//   { chainageM, rightM, leftM }
// rightM = rounded remaining to the span END   (painted on the right wall);
// leftM  = rounded remaining to the span START (painted on the left wall).
// Each is null when it rounds to nothing (a "0 m" plate at the portal is noise).
export function planTunnelDistanceMarkers(spans, {
    spacingM = TUNNEL_MARKER_SPACING_M,
    minSpanM = TUNNEL_MARKER_MIN_SPAN_M,
    roundToM = TUNNEL_MARKER_ROUND_M,
} = {}) {
    if (!Array.isArray(spans) || !(spacingM > 0)) return [];
    const round = (v) => {
        const r = Math.round(v / roundToM) * roundToM;
        return r > 0 ? r : null;
    };
    const out = [];
    for (const span of spans) {
        const startM = Number(span?.startM);
        const endM = Number(span?.endM);
        if (!Number.isFinite(startM) || !Number.isFinite(endM)) continue;
        if (endM - startM < minSpanM) continue;
        // First grid chainage strictly inside the span, then every spacingM.
        for (let d = Math.ceil((startM + 1e-9) / spacingM) * spacingM;
            d < endM - 1e-9;
            d += spacingM) {
            const rightM = round(endM - d);
            const leftM = round(d - startM);
            if (rightM == null && leftM == null) continue;
            out.push({ chainageM: d, rightM, leftM });
        }
    }
    out.sort((a, b) => a.chainageM - b.chainageM);
    return out;
}

// Height of a plate's centre above the tunnel FLOOR. Lives here, beside the
// spacing and rounding rules, rather than privately in the one layer that draws
// plates today: a second tunnel type reading its own copy is how the same sign
// ends up hanging at two heights, which reads as a bug in the world rather than
// as a constant.
export const TUNNEL_MARKER_CENTRE_ABOVE_FLOOR_M = 1.9;
