// Decides when the model world can stop working on the surface because the
// observer is sealed inside a tunnel, and when it has to start again so the
// outside is ready before the portal. Pure — no THREE, no DOM — so the span
// bookkeeping and the resume lead are unit-testable headless.
//
// Why this exists: every layer's onFrame runs every frame regardless of where the
// observer is, so a train in a tunnel keeps streaming and building the city
// overhead — roads on a 1.4 km corridor, detailed buildings on 800 m, curbs, lane
// paint, decor — none of which is visible from inside an opaque tube. The photo
// world already suspends its source in a tunnel (shouldSuspendPhotoSource); this
// is the model world's equivalent.

// Enclosed chunks arrive in build order along the route. Consecutive chunks belong
// to the same tunnel when their chainage is contiguous; a gap means the line
// surfaced in between (a portal, a station box, an open cut) and a new span starts.
export function buildEnclosedSpanIndex(records = []) {
    const spans = [];
    let current = null;
    for (const record of records) {
        const chainageM = Number(record?.chainageM);
        const lengthM = Number(record?.lengthM);
        if (!Number.isFinite(chainageM) || !Number.isFinite(lengthM) || lengthM <= 0) continue;
        const startM = chainageM - lengthM / 2;
        const endM = chainageM + lengthM / 2;
        // 1.5 chunks of slack: consecutive chunks share a boundary, so anything
        // under this is the same tube and anything over it is a genuine break.
        if (current && startM - current.endM <= lengthM * 1.5) {
            current.endM = Math.max(current.endM, endM);
            current.chunks.push(record);
        } else {
            current = { startM, endM, chunks: [record] };
            spans.push(current);
        }
    }
    return spans;
}

// RailFormationModel publishes complete tunnel runs rather than the planner
// elevation layer's chunk records. Normalize those runs to the same cheap
// spatial index so every rendered tunnel can drive shared enclosure behavior.
export function buildRailTunnelSpanIndex(runs = []) {
    const spans = [];
    for (const run of runs || []) {
        const samples = run?.boreSamples || run?.samples || [];
        const startIndex = Math.max(0, Number(run?.portalStartMouthIndex) || 0);
        const rawEndIndex = Number(run?.portalEndMouthIndex);
        const endIndex = Number.isFinite(rawEndIndex)
            ? Math.min(samples.length - 1, rawEndIndex)
            : samples.length - 1;
        if (endIndex <= startIndex) continue;
        const chunks = [];
        for (let index = startIndex; index < endIndex; index++) {
            const from = samples[index];
            const to = samples[index + 1];
            const x1 = Number(from?.x);
            const z1 = Number(from?.z);
            const x2 = Number(to?.x);
            const z2 = Number(to?.z);
            if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
            const lengthM = Math.hypot(x2 - x1, z2 - z1);
            if (lengthM <= 0.01) continue;
            const fromStation = Number(from?.station);
            const toStation = Number(to?.station);
            const chainageM = Number.isFinite(fromStation) && Number.isFinite(toStation)
                ? (fromStation + toStation) / 2
                : chunks.length
                    ? chunks.at(-1).chainageM + (chunks.at(-1).lengthM + lengthM) / 2
                    : lengthM / 2;
            chunks.push({
                x: (x1 + x2) / 2,
                z: (z1 + z2) / 2,
                chainageM,
                lengthM,
            });
        }
        if (!chunks.length) continue;
        const first = chunks[0];
        const last = chunks.at(-1);
        spans.push({
            startM: first.chainageM - first.lengthM / 2,
            endM: last.chainageM + last.lengthM / 2,
            chunks,
        });
    }
    return spans;
}

// Which enclosed span, if any, the observer is inside. Matched on the nearest
// enclosed chunk centre rather than a polygon test: chunks are short (15 m) and a
// tunnel is narrow, so a lateral tolerance is both cheaper and more forgiving of
// the observer riding slightly off the centreline.
export function findEnclosingSpan(spans, x, z, maxLateralM = 12) {
    let best = null;
    for (const span of spans) {
        for (const chunk of span.chunks) {
            const dx = x - chunk.x;
            const dz = z - chunk.z;
            const distanceSq = dx * dx + dz * dz;
            if (best && distanceSq >= best.distanceSq) continue;
            best = { span, chunk, distanceSq };
        }
    }
    if (!best) return null;
    // Allow for the observer being up to half a chunk along the tube from the
    // nearest centre, on top of the lateral tolerance.
    const reachM = maxLateralM + (Number(best.chunk.lengthM) || 0) / 2;
    if (best.distanceSq > reachM * reachM) return null;
    return {
        span: best.span,
        chainageM: best.chunk.chainageM,
        metresToExit: Math.max(0, best.span.endM - best.chunk.chainageM),
        metresFromEntry: Math.max(0, best.chunk.chainageM - best.span.startM),
    };
}

export const TUNNEL_RESUME_DEFAULTS = Object.freeze({
    // Enough road/building corridor to have arrived by the time the portal does.
    leadM: 450,
    // …and at speed, distance alone is not enough: 12 s of travel outruns 450 m
    // above ~135 km/h, so the lead grows with velocity.
    leadSeconds: 12,
    // Re-suspending needs to clear the resume distance by this factor, so sitting
    // near the threshold cannot flap the whole surface world on and off.
    reSuspendFactor: 1.35,
});

// The suspension decision. `wasSuspended` carries the previous answer so the
// hysteresis has something to hold onto.
export function shouldSuspendOutsideWorld({
    inside = false,
    metresToExit = null,
    speedMps = 0,
    wasSuspended = false,
    leadM = TUNNEL_RESUME_DEFAULTS.leadM,
    leadSeconds = TUNNEL_RESUME_DEFAULTS.leadSeconds,
    reSuspendFactor = TUNNEL_RESUME_DEFAULTS.reSuspendFactor,
} = {}) {
    if (!inside || !Number.isFinite(metresToExit)) return false;
    const speed = Math.max(0, Number(speedMps) || 0);
    const resumeAtM = Math.max(leadM, speed * leadSeconds);
    // Already suspended: hold until the exit is genuinely close.
    if (wasSuspended) return metresToExit > resumeAtM;
    // Not yet suspended: only take the world down if there is real tunnel left,
    // so a short tube is ridden through without ever dropping the surface.
    return metresToExit > resumeAtM * reSuspendFactor;
}

// Metres of tunnel a span must have for suspension to ever engage at a given
// speed. Exposed so callers can log/So a 300 m tube is knowingly never suspended.
export function minimumSuspendableSpanM(speedMps = 0, options = {}) {
    const { leadM, leadSeconds, reSuspendFactor } = { ...TUNNEL_RESUME_DEFAULTS, ...options };
    return Math.max(leadM, Math.max(0, speedMps) * leadSeconds) * reSuspendFactor;
}
