// Player-controlled tram physics running on the exact OSM tram graph. Given a
// snapped start edge, the driver walks the graph edge-by-edge per frame using
// a scalar speed + armed-turn preference. Pure functions over a driver state
// object — no scene, no DOM, no module singletons aside from graph caching in
// the caller.

import { haversineMeters, signedAngleDiffDeg } from '../core/math.js';
// The rail driver owns this prerequisite in every host, including Sloboda's
// campaign scenes, which do not load the planner's classic script tags.
import '../../tram-switch-utils.js';

// Driving-feel tuning, live-tweakable from the console via
// `Station3D.tuning` (speeds in km/h, accelerations in m/s²). Physics reads
// this object every step, so changes apply mid-ride. Strictly realistic
// values (in comments) proved too slow to be fun — defaults run ~50% hotter,
// especially through curves.
export const DRIVER_TUNING = {
    maxSpeedKmh: 100,       // straight-line cap (real TMK 2200 tops out ~70)
    accel: 2.0,             // forward acceleration (real low-floor tram ~1.2)
    brake: 2.4,             // service brake (real ~1.4)
    emergencyBrake: 4.0,    // curve-overspeed safety intervention (real magnetic ~2.8)
    coast: 0.08,            // rolling resistance at crawl
    coastDragPerV2: 0.0006, // Davis-style v² term so freewheeling dies down naturally
    // Reverse drive: once the brake has stopped the tram, holding brake
    // creeps it backwards — for getting unstuck, not driving in reverse.
    reverseAccel: 0.8,
    maxReverseKmh: 14,
    // Curve comfort cap: vCurve = √(lateralAccelMax · radius). Real tram
    // operating rules use ~1.0 (0.1 g); 2.2 ≈ 1.5× the curve speeds.
    lateralAccelMax: 2.2,
    curveMinKmh: 12,        // speed floor in the tightest loops
    throttleRampPerS: 2.0,  // jerk limiter: full throttle↔brake swing takes ~1 s
};
const SAME_LINE_STRAIGHT_BIAS_DEG = 8;
const CURVE_MAX_STEPS = 96;                      // bound on the per-frame graph walk

// Builds the driver graph from exact OSM tram geometry. Connectivity comes only
// from identical shared vertices; nearby rails never become connected just
// because they are close in metres.
export function buildDriverGraph(features) {
    if (!window.TramSwitchUtils || typeof window.TramSwitchUtils.buildExactGraph !== 'function') {
        throw new Error('TramSwitchUtils.buildExactGraph is required for driver mode');
    }
    const graph = window.TramSwitchUtils.buildExactGraph(features);

    // The shared switch graph intentionally owns only topology, so enrich its
    // edges here with the authored profile used by photo sessions and absolute
    // EVRF2000 campaign snapshots. Both carry rail height in coordinate[2].
    // Without this, taking manual control discards c[2] and drops the cab to
    // y=0 even though rails and corridor still follow the designed grade.
    const profileByDirectedEdge = new Map();
    const coordKey = (lng, lat) => `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
    for (let lineIdx = 0; lineIdx < (features || []).length; lineIdx++) {
        const feature = features[lineIdx];
        const datum = String(feature?.properties?.elevationDatum || '').toLowerCase();
        if (datum !== 'asl' && datum !== 'evrf2000') continue;
        const geometry = feature?.geometry;
        const lines = geometry?.type === 'LineString'
            ? [geometry.coordinates]
            : geometry?.type === 'MultiLineString'
                ? geometry.coordinates
                : [];
        for (const coordinates of lines) {
            for (let i = 1; i < (coordinates || []).length; i++) {
                const a = coordinates[i - 1];
                const b = coordinates[i];
                const y1 = Number(a?.[2]);
                const y2 = Number(b?.[2]);
                if (!Number.isFinite(y1) || !Number.isFinite(y2)) continue;
                profileByDirectedEdge.set(
                    `${lineIdx}:${coordKey(a[0], a[1])}>${coordKey(b[0], b[1])}`,
                    {
                        y1,
                        y2,
                        elevationMode: feature?.properties?.elevationMode || null,
                        elevationDatum: feature?.properties?.elevationDatum || null,
                    },
                );
                profileByDirectedEdge.set(
                    `${lineIdx}:${coordKey(b[0], b[1])}>${coordKey(a[0], a[1])}`,
                    {
                        y1: y2,
                        y2: y1,
                        elevationMode: feature?.properties?.elevationMode || null,
                        elevationDatum: feature?.properties?.elevationDatum || null,
                    },
                );
            }
        }
    }
    for (const edge of graph.edges || []) {
        const profile = profileByDirectedEdge.get(
            `${edge.lineIdx}:${coordKey(edge.lng1, edge.lat1)}>${coordKey(edge.lng2, edge.lat2)}`,
        );
        if (!profile) continue;
        edge.authoredY1 = profile.y1;
        edge.authoredY2 = profile.y2;
        edge.authoredElevationMode = profile.elevationMode;
        edge.authoredElevationDatum = profile.elevationDatum;
    }
    return graph;
}

function transitionAllowed(graph, switchRules, switchNodeId, incomingNodeId, outgoingNodeId) {
    if (!switchRules || !window.TramSwitchUtils || typeof window.TramSwitchUtils.transitionAllowed !== 'function') {
        return true;
    }
    const switchNode = graph.nodes[switchNodeId];
    const incomingNode = graph.nodes[incomingNodeId];
    const outgoingNode = graph.nodes[outgoingNodeId];
    if (!switchNode || !incomingNode || !outgoingNode) return true;
    return window.TramSwitchUtils.transitionAllowed(
        switchRules,
        window.TramSwitchUtils.nodeKeyForCoords(switchNode.lat, switchNode.lng),
        window.TramSwitchUtils.nodeKeyForCoords(incomingNode.lat, incomingNode.lng),
        window.TramSwitchUtils.nodeKeyForCoords(outgoingNode.lat, outgoingNode.lng),
    );
}

function getAllowedOutgoingKeys(graph, switchRules, switchNodeId, incomingNodeId) {
    if (!switchRules || !window.TramSwitchUtils || typeof window.TramSwitchUtils.getAllowedOutgoingKeys !== 'function') {
        return null;
    }
    const switchNode = graph.nodes[switchNodeId];
    const incomingNode = graph.nodes[incomingNodeId];
    if (!switchNode || !incomingNode) return null;
    return window.TramSwitchUtils.getAllowedOutgoingKeys(
        switchRules,
        window.TramSwitchUtils.nodeKeyForCoords(switchNode.lat, switchNode.lng),
        window.TramSwitchUtils.nodeKeyForCoords(incomingNode.lat, incomingNode.lng),
    );
}

// Finds the closest edge to (lat, lng) whose traversal direction is most
// aligned with headingDeg. Returns null if no edge is within maxRadiusM.
export function snapPoseToGraph(graph, lat, lng, headingDeg, maxRadiusM) {
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = null;
    for (const e of graph.edges) {
        const minLat = Math.min(e.lat1, e.lat2) - 0.001;
        const maxLat = Math.max(e.lat1, e.lat2) + 0.001;
        const minLng = Math.min(e.lng1, e.lng2) - 0.001;
        const maxLng = Math.max(e.lng1, e.lng2) + 0.001;
        if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
        const ax = e.lng1 * cosLat, ay = e.lat1;
        const bx = e.lng2 * cosLat, by = e.lat2;
        const px = lng * cosLat,    py = lat;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-18) continue;
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const projLat = e.lat1 + t * (e.lat2 - e.lat1);
        const projLng = e.lng1 + t * (e.lng2 - e.lng1);
        const distM = haversineMeters(lat, lng, projLat, projLng);
        if (!best || distM < best.distM) best = { edge: e, t, distM };
    }
    if (!best || best.distM > maxRadiusM) return null;
    const e = best.edge;
    const fwdDelta = Math.abs(signedAngleDiffDeg(headingDeg, e.bearing));
    const revDelta = Math.abs(signedAngleDiffDeg(headingDeg, (e.bearing + 180) % 360));
    const direction = fwdDelta <= revDelta ? 1 : -1;
    return { edgeId: e.id, t: best.t, direction };
}

// Picks the next edge out of nodeId, excluding the one we came in on,
// honouring `switchRules`.
//
// "Real switch" = node where, after applying junction rules, there are 2+
// permissible exits. The graph topology already tells us this — no angle
// threshold needed. With:
//   * 'left'  → pick the leftmost candidate (most negative delta).
//   * 'right' → pick the rightmost candidate (most positive delta).
//   * 'straight' / null → pick the candidate closest to current heading.
// The arm only CONSUMES (clears) when the chosen candidate is different
// from the straightest one — i.e. the driver actually turned. If 'left'
// is armed but the leftmost option IS the straightest (no leftward
// alternative existed at this switch), the arm holds for the next switch.
// Single-candidate "junctions" (just edge-to-edge continuations on a
// straight stretch of track) never consume the arm.
function pickNextEdge(graph, nodeId, currentEdgeId, exitBearingDeg, armedTurn, switchRules) {
    const node = graph.nodes[nodeId];
    if (!node) return null;
    const currentEdge = graph.edges[currentEdgeId];
    const incomingNodeId = currentEdge.a === nodeId ? currentEdge.b : currentEdge.a;
    const rawCandidates = [];
    for (const a of node.adj) {
        if (a.edgeId === currentEdgeId) continue;
        const e = graph.edges[a.edgeId];
        const dir = e.a === nodeId ? 1 : -1;
        const startBearing = dir === 1 ? e.bearing : (e.bearing + 180) % 360;
        const delta = signedAngleDiffDeg(startBearing, exitBearingDeg);
        rawCandidates.push({
            edgeId: a.edgeId,
            outgoingNodeId: a.other,
            direction: dir,
            delta,
            sameLine: e.lineIdx === currentEdge.lineIdx,
        });
    }
    const hasLoadedRuleMap = !!(
        switchRules &&
        switchRules.switches &&
        Object.keys(switchRules.switches).length > 0 &&
        window.TramSwitchUtils &&
        typeof window.TramSwitchUtils.getAllowedOutgoingKeys === 'function'
    );
    const exactAllowedOutgoingKeys = hasLoadedRuleMap
        ? getAllowedOutgoingKeys(graph, switchRules, nodeId, incomingNodeId)
        : null;
    const candidates = exactAllowedOutgoingKeys
        ? rawCandidates.filter(candidate =>
            transitionAllowed(graph, switchRules, nodeId, incomingNodeId, candidate.outgoingNodeId))
        : rawCandidates;
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
        return { ...candidates[0], armConsumed: false };
    }

    // 2+ candidates → real switch with a choice.
    const byStraight = candidates.slice().sort(
        (p, q) => Math.abs(p.delta) - Math.abs(q.delta));
    const straightest = byStraight[0];
    const sameLine = candidates
        .filter(candidate => candidate.sameLine)
        .sort((p, q) => Math.abs(p.delta) - Math.abs(q.delta))[0] || null;
    // STRICT RULE POLICY. With a rule map loaded, the manually-authored
    // switch rules are the single authority on which movements exist —
    // `candidates` was already filtered down to the allowed outgoing set
    // above, and the client never invents a turn. The one decision left to
    // the client is which allowed exit counts as "continue straight": the
    // same OSM way if it continues through the node, else the angularly
    // straightest exit.
    if (hasLoadedRuleMap && !exactAllowedOutgoingKeys) {
        // Movement not in the rule map at all. No guessing: continue
        // straight and hold any armed turn. A missing movement is DATA to
        // add in the switch editor (the yellow uncovered-switch markers),
        // not something the client should infer.
        if (sameLine) return { ...sameLine, armConsumed: false };
        return { ...straightest, armConsumed: false };
    }

    if (armedTurn === 'left' || armedTurn === 'right') {
        // Covered movement: every candidate is an explicitly allowed turn,
        // so the side-most of them is picked as-is. Only when NO rule map
        // exists (planner-drawn tracks) do we exclude reversal-like
        // branches, so a manual turn can't U-turn onto an opposite
        // parallel track.
        const MAX_MANUAL_TURN_DELTA_DEG = 120;
        const pool = hasLoadedRuleMap
            ? candidates
            : candidates.filter(c => Math.abs(c.delta) <= MAX_MANUAL_TURN_DELTA_DEG);
        if (pool.length > 0) {
            const pick = armedTurn === 'left'
                ? pool.slice().sort((p, q) => p.delta - q.delta)[0]
                : pool.slice().sort((p, q) => q.delta - p.delta)[0];
            return { ...pick, armConsumed: pick.edgeId !== straightest.edgeId };
        }
        // Nothing usable on the armed side — hold the arm, go straight.
        if (sameLine) return { ...sameLine, armConsumed: false };
        return { ...straightest, armConsumed: false };
    }
    if (sameLine && Math.abs(sameLine.delta) <= Math.abs(straightest.delta) + SAME_LINE_STRAIGHT_BIAS_DEG) {
        return { ...sameLine, armConsumed: true };
    }
    return { ...straightest, armConsumed: true };
}

// Walks the graph ahead of the driver (following the same branch choices
// driverStep would take) and returns the current effective speed limit in
// m/s: the minimum over upcoming curves of the braking-curve value
// √(vCurve² + 2·brake·distance), capped at the tuned max speed. Each node
// transition contributes a curve event: heading change θ over the local arc
// length ≈ radius R = arc/θ → vCurve = √(lateralAccelMax · R).
export function computeSpeedLimit(ds, graph, switchRules) {
    const maxSpeed = DRIVER_TUNING.maxSpeedKmh / 3.6;
    const brake = DRIVER_TUNING.brake;
    const curveMin = DRIVER_TUNING.curveMinKmh / 3.6;
    // Look ahead exactly as far as a full-service-brake stop from top speed
    // could need — derived so tuning stays consistent by construction.
    const lookaheadM = (maxSpeed * maxSpeed) / (2 * brake) + 20;
    let limit = maxSpeed;
    let edge = graph.edges[ds.edgeId];
    if (!edge) return limit;
    let direction = ds.direction;
    let edgeId = ds.edgeId;
    let travelled = (direction === 1 ? (1 - ds.t) : ds.t) * edge.length;
    let exitBearing = direction === 1 ? edge.bearing : (edge.bearing + 180) % 360;
    // Measure the bend over a BASELINE, not per edge: a hand-drawn, then-smoothed
    // route zigzags a degree or two at every ~10 m vertex, and per-edge |θ| read
    // each wiggle as a tight curve — so the speed limit (and the emergency brake)
    // jittered, surging the ride. Accumulate the SIGNED heading change so a zigzag
    // cancels to ~0, and evaluate once the window spans the baseline OR a genuine
    // sharp turn has piled up (so short tight curves are still caught promptly).
    const CURVE_BASELINE_M = 18;
    const SHARP_TURN_DEG = 25;
    let accTheta = 0;           // signed heading change (deg) over the window
    let accDist = 0;            // distance over the window
    let windowStart = travelled;

    for (let step = 0; step < CURVE_MAX_STEPS && travelled <= lookaheadM; step++) {
        const endNodeId = direction === 1 ? edge.b : edge.a;
        const next = pickNextEdge(graph, endNodeId, edgeId, exitBearing, ds.armedTurn, switchRules);
        if (!next) {
            // Dead end ahead: treat as a mandatory stop.
            const v = Math.sqrt(2 * brake * Math.max(0, travelled));
            return Math.min(limit, Math.max(v, 0));
        }
        const nextEdge = graph.edges[next.edgeId];
        const startBearing = next.direction === 1 ? nextEdge.bearing : (nextEdge.bearing + 180) % 360;
        accTheta += signedAngleDiffDeg(startBearing, exitBearing);   // signed → zigzag cancels
        accDist += nextEdge.length;
        if (accDist >= CURVE_BASELINE_M || Math.abs(accTheta) >= SHARP_TURN_DEG) {
            const netTheta = Math.abs(accTheta) * (Math.PI / 180);
            if (netTheta > 0.02 && accDist > 1e-3) {   // ~1.1° net over the window = a real curve
                const radius = accDist / netTheta;
                const vCurve = Math.max(curveMin, Math.sqrt(DRIVER_TUNING.lateralAccelMax * radius));
                const allowedNow = Math.sqrt(vCurve * vCurve + 2 * brake * Math.max(0, windowStart));
                if (allowedNow < limit) limit = allowedNow;
            }
            accTheta = 0;
            accDist = 0;
            windowStart = travelled + nextEdge.length;
        }
        travelled += nextEdge.length;
        edge = nextEdge;
        edgeId = next.edgeId;
        direction = next.direction;
        exitBearing = startBearing;
    }
    return limit;
}

// Signed curvature (1/m) at the driver's current position, from the heading
// change into the next edge. Positive = turning left. Used by the camera rig
// (roll) and audio (flange squeal); returns 0 on straights and dead ends.
export function computeCurrentCurvature(ds, graph, switchRules) {
    const e = graph.edges[ds.edgeId];
    if (!e) return 0;
    const exitBearing = ds.direction === 1 ? e.bearing : (e.bearing + 180) % 360;
    const endNodeId = ds.direction === 1 ? e.b : e.a;
    const next = pickNextEdge(graph, endNodeId, ds.edgeId, exitBearing, ds.armedTurn, switchRules);
    if (!next) return 0;
    const nextEdge = graph.edges[next.edgeId];
    const startBearing = next.direction === 1 ? nextEdge.bearing : (nextEdge.bearing + 180) % 360;
    const deltaDeg = signedAngleDiffDeg(startBearing, exitBearing);
    const arc = Math.min((e.length + nextEdge.length) / 2, 14);
    if (arc < 0.5) return 0;
    // Screen-left is negative delta; curvature sign follows the turn.
    return (deltaDeg * (Math.PI / 180)) / arc;
}

// Advances the driver state `ds` by dt seconds on `graph`, honouring
// `switchRules` at junctions. Mutates ds in place.
export function driverStep(ds, graph, switchRules, dt) {
    if (!ds || !ds.enabled) return;

    // Ease throttle toward its target. The ramp doubles as the jerk
    // limiter — the "heavy vehicle" feel.
    const THROTTLE_RAMP = DRIVER_TUNING.throttleRampPerS * dt;
    if (ds.throttle < ds.throttleTarget) {
        ds.throttle = Math.min(ds.throttleTarget, ds.throttle + THROTTLE_RAMP);
    } else if (ds.throttle > ds.throttleTarget) {
        ds.throttle = Math.max(ds.throttleTarget, ds.throttle - THROTTLE_RAMP);
    }

    // Rolling + aero resistance (Davis v² term) ALWAYS opposes motion; the
    // motor force from the throttle adds on top. So a steady throttle balances
    // resistance at a steady speed — a real cruise — instead of the old
    // accelerate-then-coast limit cycle (which surged the speed and pumped the
    // autopilot throttle). Coasting is simply motor = 0.
    const resist = DRIVER_TUNING.coast + DRIVER_TUNING.coastDragPerV2 * ds.speed * ds.speed;
    const drag = ds.speed > 0 ? -resist : ds.speed < 0 ? resist : 0;
    let motor = 0;
    if (ds.throttle > 0) {
        // Forward throttle (works whether moving forward, stopped, or reversing —
        // pressing forward kills any reverse motion via the same curve).
        motor = ds.throttle * DRIVER_TUNING.accel;
    } else if (ds.throttle < 0) {
        // Brake while moving forward; once stopped, the same input becomes a
        // (much weaker) reverse throttle to creep backwards for getting unstuck.
        motor = ds.throttle * (ds.speed > 0 ? DRIVER_TUNING.brake : DRIVER_TUNING.reverseAccel);
    }
    ds.speed += (motor + drag) * dt;
    // Resistance must not drag a coasting tram backwards through zero.
    if (ds.throttle === 0 && Math.abs(ds.speed) < 0.02) ds.speed = 0;
    const maxSpeed = DRIVER_TUNING.maxSpeedKmh / 3.6;
    const maxReverse = DRIVER_TUNING.maxReverseKmh / 3.6;
    if (ds.speed > maxSpeed) ds.speed = maxSpeed;
    if (ds.speed < -maxReverse) ds.speed = -maxReverse;

    // Curve speed limit + safety intervention. The limit already includes
    // the braking curve into upcoming curves, so a driver who ignores it
    // gets the magnetic track brake (harder than service brake) instead of
    // flying through Jelačić flat out. HUD surfaces both fields.
    // The full look-ahead walk is refreshed at ~10 Hz plus on every edge
    // transition, not per frame: the limit changes slowly, and the
    // emergency-brake margin (stronger than the service rate the braking
    // curve assumes) easily absorbs 100 ms of staleness.
    ds._limitCountdown = (ds._limitCountdown || 0) - 1;
    if (ds.speedLimit == null || ds._limitCountdown <= 0 || ds._limitEdgeId !== ds.edgeId) {
        ds.speedLimit = computeSpeedLimit(ds, graph, switchRules);
        ds._limitCountdown = 6;
        ds._limitEdgeId = ds.edgeId;
    }
    const speedLimit = ds.speedLimit;
    ds.overspeed = ds.speed > speedLimit + 0.15;
    if (ds.overspeed) {
        ds.speed = Math.max(speedLimit, ds.speed - DRIVER_TUNING.emergencyBrake * dt);
    }

    // Advance can be negative when reversing. Walk the graph in either
    // direction by flipping the sign of the per-step move and inverting
    // ds.direction at node transitions.
    let advance = ds.speed * dt;
    let safety = 32;
    while (advance !== 0 && safety-- > 0) {
        const e = graph.edges[ds.edgeId];
        const movingForward = (advance > 0);
        // "Forward" relative to ds.direction: moving in the same sense
        // as ds.direction along the edge. Reversing flips that sense
        // for the purposes of which end of the edge we're approaching.
        const effDir = movingForward ? ds.direction : -ds.direction;
        const remainingFraction = effDir === 1 ? (1 - ds.t) : ds.t;
        const remainingDist = remainingFraction * e.length;
        const absAdvance = Math.abs(advance);
        if (absAdvance < remainingDist) {
            ds.t += effDir * (absAdvance / e.length);
            advance = 0;
            break;
        }
        advance = movingForward
            ? (advance - remainingDist)
            : (advance + remainingDist);
        const endNodeId = effDir === 1 ? e.b : e.a;
        const exitBearing = effDir === 1 ? e.bearing : (e.bearing + 180) % 360;
        const next = pickNextEdge(graph, endNodeId, ds.edgeId, exitBearing, ds.armedTurn, switchRules);
        // Arm only clears when an actual turn was taken (or there was no
        // choice). If the driver armed left/right and this junction only
        // had a straight option, the arm carries to the next junction.
        if (next && next.armConsumed) ds.armedTurn = 'straight';
        if (!next) {
            // Dead end — pin to far end of edge and stop.
            ds.t = effDir === 1 ? 1 : 0;
            ds.speed = 0;
            break;
        }
        // ds.direction tracks the orientation along the new edge for
        // FORWARD motion. When reversing, we end up on the new edge
        // travelling the opposite way, so flip direction for the
        // physical sense.
        ds.edgeId = next.edgeId;
        ds.direction = movingForward ? next.direction : -next.direction;
        // ds.t starts at whichever end matches "we just entered here"
        // for the forward direction, regardless of how we entered.
        ds.t = next.direction === 1 ? 0 : 1;
    }
}

// Looks ahead lookaheadM (current edge, possibly into successors) to detect
// whether the next node is a junction (≥2 branches excluding current edge).
export function findUpcomingSwitch(ds, graph, lookaheadM) {
    if (!ds) return null;
    const e = graph.edges[ds.edgeId];
    const remainingFraction = ds.direction === 1 ? (1 - ds.t) : ds.t;
    const distToEnd = remainingFraction * e.length;
    if (distToEnd > lookaheadM) return null;
    const endNodeId = ds.direction === 1 ? e.b : e.a;
    const node = graph.nodes[endNodeId];
    if (!node) return null;
    let branches = 0;
    for (const a of node.adj) if (a.edgeId !== ds.edgeId) branches++;
    if (branches < 2) return null;
    return { distM: distToEnd, branches };
}

// Samples another point along the same physical consist without mutating the
// live controller. Positive offsets are ahead of the driver's forward-facing
// direction; negative offsets walk behind it. At an edge boundary the sampled
// state's stored direction remains the vehicle's FORWARD direction, even while
// the topology walk itself is travelling backwards.
export function sampleDriverStateAtOffset(ds, graph, offsetM, switchRules = null) {
    if (!ds || !graph?.edges?.[ds.edgeId]) return null;
    const sampled = {
        ...ds,
        t: Number(ds.t) || 0,
        direction: ds.direction === -1 ? -1 : 1,
    };
    let advance = Number(offsetM) || 0;
    let safety = CURVE_MAX_STEPS;
    while (Math.abs(advance) > 1e-9 && safety-- > 0) {
        const edge = graph.edges[sampled.edgeId];
        if (!edge || !(edge.length > 0)) return null;
        const walkingForward = advance > 0;
        const physicalDirection = walkingForward
            ? sampled.direction
            : -sampled.direction;
        const remainingFraction = physicalDirection === 1
            ? 1 - sampled.t
            : sampled.t;
        const remainingM = Math.max(0, remainingFraction * edge.length);
        const stepM = Math.abs(advance);
        if (stepM <= remainingM + 1e-9) {
            sampled.t += physicalDirection * (stepM / edge.length);
            sampled.t = Math.max(0, Math.min(1, sampled.t));
            advance = 0;
            break;
        }

        advance += walkingForward ? -remainingM : remainingM;
        const nodeId = physicalDirection === 1 ? edge.b : edge.a;
        const exitBearing = physicalDirection === 1
            ? edge.bearing
            : (edge.bearing + 180) % 360;
        const next = pickNextEdge(
            graph,
            nodeId,
            sampled.edgeId,
            exitBearing,
            sampled.armedTurn,
            switchRules,
        );
        if (!next) {
            sampled.t = physicalDirection === 1 ? 1 : 0;
            break;
        }
        sampled.edgeId = next.edgeId;
        sampled.direction = walkingForward ? next.direction : -next.direction;
        sampled.t = next.direction === 1 ? 0 : 1;
    }
    return sampled;
}

export function computeDriverPose(ds, graph, {
    articulatedCarOffsetsM = null,
    switchRules = null,
} = {}) {
    const e = graph.edges[ds.edgeId];
    const lat = e.lat1 + (e.lat2 - e.lat1) * ds.t;
    const lng = e.lng1 + (e.lng2 - e.lng1) * ds.t;
    const headingDeg = ds.direction === 1 ? e.bearing : (e.bearing + 180) % 360;
    const upcoming = findUpcomingSwitch(ds, graph, 80);
    const authoredY1 = Number(e.authoredY1);
    const authoredY2 = Number(e.authoredY2);
    const hasAuthoredProfile = Number.isFinite(authoredY1) && Number.isFinite(authoredY2);
    const pose = {
        lat,
        lon: lng,
        headingDeg,
        status: {
            paused: false,
            driverMode: true,
            speedKmh: Math.round(ds.speed * 3.6),
            limitKmh: Math.round((ds.speedLimit != null ? ds.speedLimit : DRIVER_TUNING.maxSpeedKmh / 3.6) * 3.6),
            // A curve restriction is in force (vs. just the open-track cap) —
            // the HUD shows the "/ limit" suffix only then. A limit of zero is
            // a stop, not a restriction to drive to, and rendering it put a
            // bare "/0" beside the speed on the platform at Zagreb Glavni.
            limitActive: ds.speedLimit != null
                && ds.speedLimit > 0
                && ds.speedLimit < DRIVER_TUNING.maxSpeedKmh / 3.6 - 0.1,
            overspeed: !!ds.overspeed,
            throttle: ds.throttle,
            armedTurn: ds.armedTurn,
            upcomingSwitch: upcoming,
            totalPassengers: 0,
            capacity: 0,
            lastAlighted: 0,
            lastBoarded: 0,
            nextStation: null,
        },
    };
    if (hasAuthoredProfile) {
        pose.y = authoredY1 + (authoredY2 - authoredY1) * ds.t;
        pose.elevationMode = e.authoredElevationMode || null;
        pose.elevationDatum = e.authoredElevationDatum || null;
        const riseAlongHeading = (authoredY2 - authoredY1) * (ds.direction === 1 ? 1 : -1);
        pose.pitchDeg = Math.atan2(riseAlongHeading, Math.max(1e-9, e.length)) * 180 / Math.PI;
    }
    if (Array.isArray(articulatedCarOffsetsM)) {
        pose.articulatedCars = articulatedCarOffsetsM.map((offsetM) => {
            const carState = sampleDriverStateAtOffset(ds, graph, offsetM, switchRules);
            if (!carState) return null;
            const carPose = computeDriverPose(carState, graph);
            return {
                lat: carPose.lat,
                lon: carPose.lon,
                headingDeg: carPose.headingDeg,
                ...(Number.isFinite(carPose.y) ? { y: carPose.y } : {}),
                ...(carPose.elevationMode ? { elevationMode: carPose.elevationMode } : {}),
                ...(carPose.elevationDatum ? { elevationDatum: carPose.elevationDatum } : {}),
                ...(Number.isFinite(carPose.pitchDeg) ? { pitchDeg: carPose.pitchDeg } : {}),
            };
        }).filter(Boolean);
    }
    return pose;
}

// Builds a fresh driver state seeded at the given graph snap. The
// optional `initialSpeed` (m/s) lets callers transfer momentum from the
// schedule autopilot — without it, taking control mid-route would
// instantly stall the tram, which is jarring.
export function createDriverState(snap, initialSpeed = 0) {
    return {
        enabled: true,
        edgeId: snap.edgeId,
        direction: snap.direction,
        t: snap.t,
        speed: Math.max(0, Math.min(DRIVER_TUNING.maxSpeedKmh / 3.6, Number(initialSpeed) || 0)),
        speedLimit: DRIVER_TUNING.maxSpeedKmh / 3.6,
        overspeed: false,
        throttle: 0,
        throttleTarget: 0,
        armedTurn: 'straight',
        // When `autopilot` is true the cab.js per-frame loop forces
        // throttle/turn so the tram drives itself on the OSM graph.
        // Default false = manual control.
        autopilot: false,
    };
}

// Re-snaps an active rail controller after its streamed source changes while
// retaining every player-controlled dynamic. Callers keep presentation state
// such as doors and camera mode outside the solver.
export function resnapDriverState(ds, currentGraph, replacementGraph, maxRadiusM = 60) {
    if (!ds || !currentGraph || !replacementGraph) return null;
    const pose = computeDriverPose(ds, currentGraph);
    const snap = snapPoseToGraph(
        replacementGraph,
        pose.lat,
        pose.lon,
        pose.headingDeg,
        maxRadiusM,
    );
    if (!snap) return null;
    const replacement = createDriverState(snap, Math.abs(Number(ds.speed) || 0));
    replacement.speed = Number(ds.speed) || 0;
    replacement.speedLimit = ds.speedLimit;
    replacement.overspeed = !!ds.overspeed;
    replacement.throttle = Number(ds.throttle) || 0;
    replacement.throttleTarget = Number(ds.throttleTarget) || 0;
    replacement.armedTurn = ds.armedTurn || 'straight';
    replacement.autopilot = !!ds.autopilot;
    return replacement;
}
