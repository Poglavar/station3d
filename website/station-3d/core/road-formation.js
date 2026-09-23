// Pure road-formation geometry: OSM topology anchors a smoothed longitudinal
// grade, while buffered road polygons define one level corridor cross-section
// shared by asphalt, markings, curbs and adjacent sidewalk surfaces.
// No THREE, DOM, fetch, or scene state so the civil-geometry rules are testable.

import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from './math.js';
import { ownReadSnapshot, retainReadSnapshot } from './read-snapshot-lifetime.js';
import { createRoadFeatureIdentityIndex } from './road-feature-identity.js';
import { createRoadFeatureSourceIndex } from './road-feature-sources.js';
import {
    buildFormationExcavationRegions,
    TERRAIN_EXCAVATION_MIN_DEPTH_M,
} from './formation-excavation.js';
import { delaunayFlipSteps } from './delaunay-flip.js';

const INDEX_CELL_M = 80;
// Road surface rings are densified every ~4 m and can contain thousands of
// vertices. Re-testing every edge for every surface query made lazy formation
// rebuilds quadratic. Bucket ring edges by Z so ray casting only visits edges
// that can cross the query ray.
const RING_QUERY_CELL_M = 16;
const FORMATION_DRESSING_QUERY_CELL_M = 20;
export const ROAD_FORMATION_QUERY_RADIUS_M = 32;
const DEFAULT_QUERY_RADIUS_M = ROAD_FORMATION_QUERY_RADIUS_M;
const EMPTY_QUERY_OPTIONS = Object.freeze({});
// A road is not a pointwise terrain drape. Sample its centreline densely, fit a
// local LINEAR grade (which preserves a sustained climb but rejects short-wave
// DTM noise), then force that profile through shared topology nodes. A window
// wider than the 20 m DGU lattice removes the corrugated cell-scale response.
const ROAD_PROFILE_SAMPLE_STEP_M = 6;
const ROAD_PROFILE_SMOOTH_RADIUS_M = 36;
const ROAD_PROFILE_SMOOTH_SIGMA_M = 16;
// Exact OSM junction coordinates are normally byte-identical. A small snap also
// joins coordinates rounded independently by the API without merging parallel
// carriageways or grade-separated crossings that merely cross between vertices.
const TOPOLOGY_NODE_SNAP_M = 0.05;
const TOPOLOGY_NODE_PROBE_M = 6;
// Standalone footway/path polygons beside a carriageway belong to the same
// corridor cross-section. Farther away they ease back to bare terrain so plazas
// and independent hillside paths remain terrain-following.
const SIDEWALK_PROFILE_FULL_M = 12;
const SIDEWALK_PROFILE_END_M = 20;
// A sidewalk can curve around a corner, so this is deliberately looser than a
// strict parallel test while still rejecting a perpendicular cross street.
const SIDEWALK_PROFILE_MIN_DIRECTION_COSINE = 0.6;
const PROFILE_STEP_M = 4;
const MIN_BATTER_M = 0.8;
const BATTER_PER_VERTICAL_M = 0.12;
const MAX_BATTER_M = 1.5;
const MAX_MITER_SCALE = 2.25;
const TERRAIN_SEAM_OVERLAP_M = 2;
// Terrain removal stops at the visible civil toe. The collar beyond it is an
// overlap over intact terrain, not part of the excavation: its triangles and
// the terrain raster use different tessellations, so cutting beneath the
// collar can expose a thin sky slot wherever their interpolated heights differ.
const TERRAIN_CUTOUT_WITHIN_COLLAR_T = 0;
const WALL_VERTICAL_OVERLAP_M = 0.4;
const MAX_REFINEMENT_PASSES = 20;
const FORMATION_CHANGE_HISTORY_LIMIT = 128;
const AT_GRADE_JUNCTION_MAX_DELTA_M = 1.5;
// Junction suppression is cheap per boundary vertex but dense road rings can
// contain thousands of them. A time slice avoids both extremes: one queue
// visit never walks the whole city, while transit-mode scheduling does not
// spend a separate scarce queue item on every sub-millisecond point check.
const FORMATION_JUNCTION_STEP_BUDGET_MS = 1;
// A curb-scale terrain mismatch is ordinary at-grade paving, not a cut or
// embankment. Only add the battered face, terrain collar and cutout when the
// complete profile departs from the designed road top by more than this.
const AT_GRADE_DRESSING_MAX_DELTA_M = 0.2;
// Terrain is the source ground. A road may cover it in fill, but removes it
// only where consecutive samples on its OWN axis prove a genuine civil cut
// with a complete face/collar replacement. The DGU terrain material no longer
// accepts the old plan-only road stencil (lower roads used it to punch through
// embankments), and a zero-thickness paved top is not a replacement backstop:
// from a grazing view it leaves the cut terrain's vertical edge open to sky.
export const ROAD_TERRAIN_EXCAVATION_MIN_DEPTH_M = TERRAIN_EXCAVATION_MIN_DEPTH_M;
const ROAD_CIVIL_EXCAVATION_MIN_DEPTH_M = 0.5;
// Keep measuring smaller source-terrain intrusions: they are useful evidence
// for future surface draping and diagnostics. They may not enter the terrain
// cutout publication, however, until a volumetric road replacement owns their
// top AND exposed edge. Sub-centimetre survey noise remains irrelevant.
const ROAD_SURFACE_INTRUSION_MIN_DEPTH_M = 0.015;
const ROAD_SURFACE_INTRUSION_SAMPLE_STEP_M = 1.5;
// A caller that opts into the resumable profile compiler must be able to
// advance one semantic item without accidentally sampling a complete railway
// corridor. One millisecond leaves headroom for the owning near-work queue and
// still drains short profiles in a single step.
const FORMATION_PROFILE_SLICE_MS = 1;

function formationBuildNowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function drainFormationGenerator(iterator) {
    let outcome;
    do {
        outcome = iterator.next();
    } while (!outcome.done);
    return outcome.value;
}


// Cross-slope bench cut. The near-vertical batter above leaves the outer point
// only ~MIN_BATTER_M out, so on a CUT the terrain cutout is too narrow to clear
// a hillside: the ground just beyond it is still above the trackbed and buries
// the uphill edge. When the outer terrain sits meaningfully above the designed
// top, walk the outer point outward until the terrain daylights back to trackbed
// level, or until the face from the trackbed edge out to that point has reached
// the design batter. The fill side keeps the plain batter.
//
// The reach used to be a flat 2.5 m whatever the depth, which is a SLOT, not a
// cut: an 8 m deep cutting kept its full-height hillside standing 4.5 m off the
// centreline, so from track level the untouched shoulder closed over the
// corridor and the line read as driving into solid ground (Rijeka Brajdica,
// chainage 1010–1135). A real cutting daylights roughly one horizontal metre per
// vertical metre, so the reach now grows with the depth it is cutting through —
// with the old 2.5 m kept as the floor, so shallow cross-slopes are unchanged.
const CUT_BENCH_TRIGGER_M = 0.5;     // outer terrain must exceed roadY by this to bench
const CUT_BENCH_DAYLIGHT_TOL_M = 0.2; // "back to trackbed level" tolerance
const CUT_BENCH_MIN_M = 2.5;          // floor: shallow cross-slopes keep the tuned bench
const CUT_BENCH_PER_VERTICAL_M = 1;   // design batter: 1 m out per 1 m of cut depth
const CUT_BENCH_MAX_M = 12;           // hard cap, so a mountainside is never carved away
const CUT_BENCH_STEP_M = 0.35;        // outward march resolution

// The furthest the terrain cutout can ever sit outside the formation edge:
// the widest bench the march may buy, plus the collar overlap the cutout line
// is buried in. A caller that needs to cover the WHOLE excavated footprint —
// not just the level bed, but the battered flanks above it — offsets by this
// and lets the exact ring clip the result, rather than re-deriving the batter
// rule and drifting out of step with it.
export const FORMATION_MAX_CUTOUT_REACH_M = CUT_BENCH_MAX_M + TERRAIN_SEAM_OVERLAP_M;

// How far out the cut face may reach for a given depth below the untouched
// ground. Exported so the renderer and tests share ONE statement of the rule.
// `factor` (0..1) eases the depth-earned reach back to the floor — 0 keeps
// exactly the pre-batter bench, 1 the full rule; the portal taper uses it.
export function cutBenchReachMeters(depthM, factor = 1) {
    const depth = Number(depthM);
    const t = Math.max(0, Math.min(1, Number(factor)));
    if (!Number.isFinite(depth) || depth <= 0) return CUT_BENCH_MIN_M;
    const reach = Math.min(
        CUT_BENCH_MAX_M,
        Math.max(CUT_BENCH_MIN_M, depth * CUT_BENCH_PER_VERTICAL_M),
    );
    return CUT_BENCH_MIN_M + (reach - CUT_BENCH_MIN_M) * t;
}

// Per-vertex bench easing (0 at an open cap → 1 one taper-length away along
// the ring). Distances walk the closed dense ring, so both the left and right
// wall lines ease over the same stretch of trackbed that the mouth's width
// flare occupies, whatever the vertex density.
function openCapBenchFactors(denseRing, segmentTags, { openCapStart, openCapEnd, taperM }) {
    const count = denseRing.length;
    const prefix = new Array(count + 1);
    prefix[0] = 0;
    for (let index = 0; index < count; index++) {
        const from = denseRing[index];
        const to = denseRing[(index + 1) % count];
        prefix[index + 1] = prefix[index] + Math.hypot(to.x - from.x, to.z - from.z);
    }
    const total = prefix[count];
    const anchors = [];
    for (let index = 0; index < count; index++) {
        const tag = segmentTags[index];
        if ((tag === 'start' && openCapStart) || (tag === 'end' && openCapEnd)) {
            anchors.push(prefix[index], prefix[index + 1]);
        }
    }
    if (anchors.length === 0 || !(total > 0)) return null;
    return denseRing.map((_, index) => {
        let nearest = Infinity;
        for (const anchor of anchors) {
            const direct = Math.abs(prefix[index] - anchor);
            nearest = Math.min(nearest, direct, total - direct);
        }
        const t = Math.max(0, Math.min(1, nearest / taperM));
        return t * t * (3 - 2 * t);
    });
}

// These are carriageways whose buffered polygons represent an engineered
// formation. Footways, cycleways and pedestrian squares retain the natural
// terrain drape for now; broad plazas should not acquire perimeter walls.
export const ENGINEERED_HIGHWAYS = new Set([
    'motorway', 'motorway_link',
    'trunk', 'trunk_link',
    'primary', 'primary_link',
    'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
    'residential', 'unclassified',
    'living_street', 'service',
]);

// A parking aisle is a paved lot surface that follows the lot's terrain. A
// closed aisle can enclose most of the parking polygon; treating that loop as
// an engineered cut/fill road makes its buffered outer ring punch a large
// terrain hole and leaves concave mask wedges beyond the civil collar. Keep
// ordinary service roads engineered, but let explicitly tagged parking aisles
// use the same terrain-draped surface contract as their surrounding parking.
export function roadSurfaceUsesEngineeredFormation(feature) {
    const properties = feature?.properties || {};
    const highway = String(properties.highway_type || '').trim().toLowerCase();
    if (!ENGINEERED_HIGHWAYS.has(highway)) return false;
    const service = String(properties.tags?.service || '').trim().toLowerCase();
    return !(highway === 'service' && service === 'parking_aisle');
}

function numericId(value) {
    return value == null ? null : String(value);
}

function finitePoint(point) {
    return Array.isArray(point)
        && finiteOrNull(point[0]) !== null
        && finiteOrNull(point[1]) !== null;
}

function samePoint(a, b) {
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function stripClosingPoint(points) {
    const safe = points.filter((point) => (
        point && Number.isFinite(point.x) && Number.isFinite(point.z)
    ));
    if (safe.length > 2 && samePoint(safe[0], safe[safe.length - 1])) safe.pop();
    return safe;
}

// When `outSegmentTags` is supplied it is filled with one tag per densified
// segment, copied from the originating ring vertex's `capEdge` property. This
// lets callers mark specific input edges (e.g. a rail formation's two end
// cross-caps) and recover which dense segments belong to them after densifying.
export function densifyClosedLocalRing(points, maxSegmentM = PROFILE_STEP_M, outSegmentTags = null) {
    return drainFormationGenerator(densifyClosedLocalRingSteps(
        points,
        maxSegmentM,
        outSegmentTags,
    ));
}

export function* densifyClosedLocalRingSteps(
    points,
    maxSegmentM = PROFILE_STEP_M,
    outSegmentTags = null,
) {
    const ring = stripClosingPoint(points || []);
    if (ring.length < 3) return ring;
    const maxStep = Math.max(1, Number(maxSegmentM) || PROFILE_STEP_M);
    const dense = [];
    let sliceStartedAt = formationBuildNowMs();
    for (let index = 0; index < ring.length; index++) {
        const from = ring[index];
        const to = ring[(index + 1) % ring.length];
        const tag = from && from.capEdge != null ? from.capEdge : null;
        const fromReachM = finiteOrNull(from?.minimumCutBenchReachM);
        const toReachM = finiteOrNull(to?.minimumCutBenchReachM);
        const fromApronWidthM = finiteOrNull(from?.surfaceApronWidthM);
        const toApronWidthM = finiteOrNull(to?.surfaceApronWidthM);
        dense.push({
            x: from.x,
            z: from.z,
            ...(fromReachM !== null ? { minimumCutBenchReachM: fromReachM } : {}),
            ...(fromApronWidthM !== null
                ? { surfaceApronWidthM: Math.max(0, fromApronWidthM) }
                : {}),
        });
        if (outSegmentTags) outSegmentTags.push(tag);
        const distance = Math.hypot(to.x - from.x, to.z - from.z);
        const steps = Math.max(1, Math.ceil(distance / maxStep));
        for (let step = 1; step < steps; step++) {
            const t = step / steps;
            dense.push({
                x: from.x + (to.x - from.x) * t,
                z: from.z + (to.z - from.z) * t,
                ...((fromReachM !== null || toReachM !== null)
                    ? {
                        minimumCutBenchReachM: (fromReachM || 0)
                            + ((toReachM || 0) - (fromReachM || 0)) * t,
                    }
                    : {}),
                ...((fromApronWidthM !== null || toApronWidthM !== null)
                    ? {
                        surfaceApronWidthM: Math.max(0,
                            (fromApronWidthM ?? 0)
                            + ((toApronWidthM ?? 0) - (fromApronWidthM ?? 0)) * t),
                    }
                    : {}),
            });
            if (outSegmentTags) outSegmentTags.push(tag);
            if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
                yield { phase: 'densify', count: dense.length };
                sliceStartedAt = formationBuildNowMs();
            }
        }
        if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
            yield { phase: 'densify', count: dense.length };
            sliceStartedAt = formationBuildNowMs();
        }
    }
    return dense;
}

// Subdivide ring segments that cross sharp relief. The whole seam system —
// wall top, collar rows, cutout mask ring — interpolates STRAIGHT between ring
// samples, and the terrain underneath is a piecewise-planar lattice: wherever a
// segment crosses a lattice kink (a 20 m DGU cell edge on a cliff), the straight
// span misses the surface by up to the kink's full height. In plan the seams
// overlap correctly; vertically they tear — sky wedges at wall toes, terrain
// lips over wall crests. Splitting any segment whose endpoint terrain differs
// by more than maxDeltaM pins every seam to the relief. Flat ground has no
// such segments and comes out byte-identical.
export function refineRingByRelief(ring, segmentTags, sampleY, {
    maxDeltaM = 1.2,
    minStepM = 1,
    maxRounds = 4,
} = {}) {
    return drainFormationGenerator(refineRingByReliefSteps(
        ring,
        segmentTags,
        sampleY,
        { maxDeltaM, minStepM, maxRounds },
    ));
}

export function* refineRingByReliefSteps(ring, segmentTags, sampleY, {
    maxDeltaM = 1.2,
    minStepM = 1,
    maxRounds = 4,
} = {}) {
    if (typeof sampleY !== 'function' || !Array.isArray(ring) || ring.length < 3) {
        return { ring, segmentTags };
    }
    let points = ring;
    let tags = segmentTags;
    let sliceStartedAt = formationBuildNowMs();
    let heights = [];
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        heights.push(Number(sampleY(point.x, point.z)));
        if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
            yield { phase: 'relief', round: -1, count: index + 1 };
            sliceStartedAt = formationBuildNowMs();
        }
    }
    for (let round = 0; round < maxRounds; round++) {
        let split = false;
        const nextPoints = [];
        const nextTags = tags ? [] : null;
        const nextHeights = [];
        for (let index = 0; index < points.length; index++) {
            const from = points[index];
            const to = points[(index + 1) % points.length];
            const tag = tags ? tags[index] : null;
            nextPoints.push(from);
            if (nextTags) nextTags.push(tag);
            nextHeights.push(heights[index]);
            const heightFrom = heights[index];
            const heightTo = heights[(index + 1) % points.length];
            const planM = Math.hypot(to.x - from.x, to.z - from.z);
            if (planM < minStepM * 2
                || !Number.isFinite(heightFrom) || !Number.isFinite(heightTo)
                || Math.abs(heightTo - heightFrom) <= maxDeltaM) {
                continue;
            }
            const fromReachM = finiteOrNull(from.minimumCutBenchReachM);
            const toReachM = finiteOrNull(to.minimumCutBenchReachM);
            const fromApronWidthM = finiteOrNull(from.surfaceApronWidthM);
            const toApronWidthM = finiteOrNull(to.surfaceApronWidthM);
            const mid = {
                x: (from.x + to.x) * 0.5,
                z: (from.z + to.z) * 0.5,
                ...((fromReachM !== null || toReachM !== null)
                    ? { minimumCutBenchReachM: ((fromReachM || 0) + (toReachM || 0)) * 0.5 }
                    : {}),
                ...((fromApronWidthM !== null || toApronWidthM !== null)
                    ? {
                        surfaceApronWidthM: Math.max(0,
                            ((fromApronWidthM ?? 0) + (toApronWidthM ?? 0)) * 0.5),
                    }
                    : {}),
            };
            nextPoints.push(mid);
            if (nextTags) nextTags.push(tag);   // inserted vertex keeps its segment's tag
            nextHeights.push(Number(sampleY(mid.x, mid.z)));
            split = true;
            if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
                yield { phase: 'relief', round, count: index + 1 };
                sliceStartedAt = formationBuildNowMs();
            }
        }
        points = nextPoints;
        tags = nextTags;
        heights = nextHeights;
        if (!split) break;
    }
    return { ring: points, segmentTags: tags };
}

// Refines an existing valid polygon triangulation without changing its
// boundary. Midpoints are keyed by the shared vertex pair, so neighbouring
// triangles always split a common edge identically and cannot form cracks or
// T-junctions. This is used before sampling road grade: generic ear-clipping
// can span a long road polygon with a handful of enormous diagonal triangles,
// which turn into visible ramps when their vertices receive different heights.
export function* refineTriangulatedSurfaceSteps(
    points,
    triangles,
    maxEdgeM = 8,
    maxTriangles = Infinity,
    options = {},
) {
    const refinedPoints = (points || []).map((point) => ({
        x: Number(point?.x),
        z: Number(point?.z),
    }));
    let refinedTriangles = (triangles || [])
        .map((triangle) => Array.isArray(triangle) ? triangle.map(Number) : [])
        .filter((triangle) => (
            triangle.length === 3
            && triangle.every((index) => Number.isInteger(index)
                && index >= 0 && index < refinedPoints.length)
        ));
    const maxEdge = Math.max(0.25, Number(maxEdgeM) || 8);
    const maxEdgeSquared = maxEdge * maxEdge;
    const requestedLimit = Number(maxTriangles);
    const triangleLimit = Number.isFinite(requestedLimit)
        ? Math.max(refinedTriangles.length, Math.floor(requestedLimit))
        : Infinity;
    const trianglesPerYield = Math.max(
        1,
        Math.floor(Number(options.trianglesPerYield) || 64),
    );
    // Midpoint splitting preserves triangle shape, so an earcut needle would
    // refine into a fan of slivers whose count grows with its squared length.
    // Flip to the constrained Delaunay triangulation of the same points and
    // boundary first; refinement then subdivides well-shaped triangles.
    yield* delaunayFlipSteps(refinedPoints, refinedTriangles, { flipsPerYield: trianglesPerYield });

    // One subdivision pass at the given edge threshold. Rolls itself back and
    // returns null when the result would exceed the triangle budget — dropping
    // individual triangles instead would create literal holes in the surface.
    const attemptPass = function* (thresholdSquared, pass, attemptIndex) {
        const pointCountBeforePass = refinedPoints.length;
        // Nested numeric maps avoid allocating a `${low}:${high}` string for
        // every triangle edge in every refinement pass. This is the hottest
        // loop while streamed road surfaces build.
        const midpointByEdge = new Map();
        let splitCount = 0;
        const midpointForLongEdge = (aIndex, bIndex) => {
            const a = refinedPoints[aIndex];
            const b = refinedPoints[bIndex];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            if (dx * dx + dz * dz <= thresholdSquared + 1e-9) return null;
            const low = Math.min(aIndex, bIndex);
            const high = Math.max(aIndex, bIndex);
            let highEdges = midpointByEdge.get(low);
            if (highEdges) {
                const existing = highEdges.get(high);
                if (existing != null) return existing;
            } else {
                highEdges = new Map();
                midpointByEdge.set(low, highEdges);
            }
            const midpointIndex = refinedPoints.length;
            refinedPoints.push({ x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
            highEdges.set(high, midpointIndex);
            splitCount += 1;
            return midpointIndex;
        };

        const nextTriangles = [];
        let processedTriangles = 0;
        for (const [a, b, c] of refinedTriangles) {
            const ab = midpointForLongEdge(a, b);
            const bc = midpointForLongEdge(b, c);
            const ca = midpointForLongEdge(c, a);
            const mask = (ab != null ? 1 : 0) | (bc != null ? 2 : 0) | (ca != null ? 4 : 0);
            if (mask === 0) nextTriangles.push([a, b, c]);
            else if (mask === 1) nextTriangles.push([a, ab, c], [ab, b, c]);
            else if (mask === 2) nextTriangles.push([b, bc, a], [bc, c, a]);
            else if (mask === 4) nextTriangles.push([c, ca, b], [ca, a, b]);
            else if (mask === 3) {
                nextTriangles.push([b, bc, ab], [a, ab, c], [ab, bc, c]);
            } else if (mask === 6) {
                nextTriangles.push([c, ca, bc], [b, bc, a], [bc, ca, a]);
            } else if (mask === 5) {
                nextTriangles.push([a, ab, ca], [c, ca, b], [ca, ab, b]);
            } else {
                nextTriangles.push(
                    [a, ab, ca],
                    [ab, b, bc],
                    [ca, bc, c],
                    [ab, bc, ca],
                );
            }
            // This entire pass is transactional and will be rejected once it
            // exceeds the budget. Stop at the first impossible prefix instead
            // of constructing and then discarding the rest of a multi-thousand
            // triangle pass.
            if (nextTriangles.length > triangleLimit) {
                refinedPoints.length = pointCountBeforePass;
                return null;
            }
            processedTriangles += 1;
            if ((processedTriangles % trianglesPerYield) === 0) {
                yield {
                    phase: 'surface-refinement',
                    pass,
                    attempt: attemptIndex,
                    processedTriangles,
                };
            }
        }
        return { nextTriangles, splitCount };
    };

    // Abandoning refinement when the budget could not afford a full base-
    // threshold pass shipped the raw earcut shards — 25–75 m triangles whose
    // flat interiors bridged the curved drape field by ±0.85 m and read as
    // deep grooves across Rijeka's graded streets. Instead, each pass finds
    // the finest affordable threshold by climbing from the base (splitting
    // only ever-longer edges), so the budget is always spent on the worst
    // shards first. A uniform threshold per pass keeps shared edges crack-
    // free; the threshold eases back down after each commit.
    let passEdgeSquared = maxEdgeSquared;
    for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass++) {
        let attemptIndex = 0;
        let attempt = yield* attemptPass(passEdgeSquared, pass, attemptIndex);
        while (!attempt) {
            passEdgeSquared *= 4;
            attemptIndex += 1;
            attempt = yield* attemptPass(passEdgeSquared, pass, attemptIndex);
        }
        refinedTriangles = attempt.nextTriangles;
        if (attempt.splitCount === 0 && passEdgeSquared <= maxEdgeSquared) break;
        if (attempt.splitCount === 0) {
            // Nothing above the raised threshold splits any more. Try the base
            // threshold once: affordable now means the earlier climbs freed up,
            // unaffordable means the budget is truly spent.
            passEdgeSquared = maxEdgeSquared;
            const fine = yield* attemptPass(passEdgeSquared, pass, attemptIndex + 1);
            if (!fine) break;
            refinedTriangles = fine.nextTriangles;
            if (fine.splitCount === 0) break;
            continue;
        }
        passEdgeSquared = Math.max(maxEdgeSquared, passEdgeSquared / 4);
    }

    return { points: refinedPoints, triangles: refinedTriangles };
}

// Keep the established synchronous API for road/proposal callers. Both paths
// drain the same generator, so cooperative decor refinement cannot drift from
// the authoritative geometry algorithm.
export function refineTriangulatedSurface(
    points,
    triangles,
    maxEdgeM = 8,
    maxTriangles = Infinity,
) {
    const steps = refineTriangulatedSurfaceSteps(
        points,
        triangles,
        maxEdgeM,
        maxTriangles,
    );
    let outcome = steps.next();
    while (!outcome.done) outcome = steps.next();
    return outcome.value;
}

function signedArea(points) {
    let area2 = 0;
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        area2 += a.x * b.z - b.x * a.z;
    }
    return area2 * 0.5;
}

function segmentOutwardNormal(a, b, windingSign) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return { x: 0, z: 0 };
    // Positive local-XZ area is counter-clockwise: interior lies left of an
    // edge and (dz,-dx) points right/outward. Reverse it for clockwise rings.
    return {
        x: windingSign * dz / length,
        z: windingSign * -dx / length,
    };
}

function outwardMiterDirections(points) {
    const windingSign = signedArea(points) >= 0 ? 1 : -1;
    const directions = [];
    for (let index = 0; index < points.length; index++) {
        const previous = points[(index - 1 + points.length) % points.length];
        const current = points[index];
        const next = points[(index + 1) % points.length];
        const before = segmentOutwardNormal(previous, current, windingSign);
        const after = segmentOutwardNormal(current, next, windingSign);
        let mx = before.x + after.x;
        let mz = before.z + after.z;
        const length = Math.hypot(mx, mz);
        if (length < 1e-5) {
            directions.push(after);
            continue;
        }
        mx /= length;
        mz /= length;
        const alignment = Math.max(0.2, mx * after.x + mz * after.z);
        const scale = Math.min(MAX_MITER_SCALE, 1 / alignment);
        directions.push({ x: mx * scale, z: mz * scale });
    }
    return directions;
}

function createRingQueryIndex(ring) {
    const cells = new Map();
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const a = ring[index];
        const b = ring[previous];
        // Horizontal edges never cross the horizontal ray used below.
        if (a.z === b.z) continue;
        const minCell = Math.floor(Math.min(a.z, b.z) / RING_QUERY_CELL_M);
        const maxCell = Math.floor(Math.max(a.z, b.z) / RING_QUERY_CELL_M);
        const edge = { a, b };
        for (let cell = minCell; cell <= maxCell; cell++) {
            addToIndex(cells, cell, edge);
        }
    }
    return cells;
}

function pointInRing(x, z, ring, ringQueryIndex = null) {
    let inside = false;
    const indexedEdges = ringQueryIndex?.get(
        Math.floor(z / RING_QUERY_CELL_M),
    );
    const edges = indexedEdges || null;
    const edgeCount = edges ? edges.length : ring.length;
    for (let index = 0; index < edgeCount; index++) {
        const a = edges ? edges[index].a : ring[index];
        const b = edges ? edges[index].b : ring[(index + ring.length - 1) % ring.length];
        if ((a.z > z) !== (b.z > z)
            && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

function ringBounds(ring) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const point of ring) {
        minX = Math.min(minX, point.x);
        minZ = Math.min(minZ, point.z);
        maxX = Math.max(maxX, point.x);
        maxZ = Math.max(maxZ, point.z);
    }
    return { minX, minZ, maxX, maxZ };
}

function distanceSquaredToRing(x, z, ring) {
    let best = Infinity;
    for (let index = 0; index < ring.length; index++) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        const projected = projectPointToSegment(x, z, {
            x1: a.x,
            z1: a.z,
            x2: b.x,
            z2: b.z,
        });
        if (projected) best = Math.min(best, projected.distanceSquared);
    }
    return best;
}

function boundsOverlap(a, b) {
    return !!a && !!b
        && a.minX <= b.maxX
        && a.maxX >= b.minX
        && a.minZ <= b.maxZ
        && a.maxZ >= b.minZ;
}

function cellKey(x, z) {
    return `${Math.floor(x / INDEX_CELL_M)}_${Math.floor(z / INDEX_CELL_M)}`;
}

function addToIndex(index, key, value) {
    let entries = index.get(key);
    if (!entries) {
        entries = [];
        index.set(key, entries);
    }
    entries.push(value);
}

function projectPointToSegment(x, z, segment) {
    const dx = segment.x2 - segment.x1;
    const dz = segment.z2 - segment.z1;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-9) return null;
    const t = Math.max(0, Math.min(1,
        ((x - segment.x1) * dx + (z - segment.z1) * dz) / lengthSquared));
    const projectedX = segment.x1 + dx * t;
    const projectedZ = segment.z1 + dz * t;
    return {
        x: projectedX,
        z: projectedZ,
        t,
        distanceSquared: (x - projectedX) ** 2 + (z - projectedZ) ** 2,
    };
}

function topologyNodeKey(point) {
    return `${Math.round(point.x / TOPOLOGY_NODE_SNAP_M)}`
        + `:${Math.round(point.z / TOPOLOGY_NODE_SNAP_M)}`;
}

// Build the terrain evidence for ONE OSM way. Terrain samples remain evidence;
// the returned baseHeights are a locally fitted longitudinal design profile.
// Local linear regression is important here: a moving average rounds a steady
// climb at the ends of its window, while this fit reproduces a constant grade
// exactly and suppresses only the short-wave up/down component.
function buildSmoothedRoadProfile(points, sampleSceneYAtLocal) {
    if (!Array.isArray(points) || points.length < 2
        || typeof sampleSceneYAtLocal !== 'function') return null;

    const chainages = [0];
    const profilePoints = [{ x: points[0].x, z: points[0].z }];
    const sourceSampleIndices = [0];
    let totalM = 0;
    for (let sourceIndex = 0; sourceIndex < points.length - 1; sourceIndex++) {
        const from = points[sourceIndex];
        const to = points[sourceIndex + 1];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lengthM = Math.hypot(dx, dz);
        if (lengthM < 1e-6) {
            sourceSampleIndices.push(chainages.length - 1);
            continue;
        }
        const steps = Math.max(1, Math.ceil(lengthM / ROAD_PROFILE_SAMPLE_STEP_M));
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            chainages.push(totalM + lengthM * t);
            profilePoints.push({ x: from.x + dx * t, z: from.z + dz * t });
        }
        totalM += lengthM;
        sourceSampleIndices.push(chainages.length - 1);
    }
    if (!(totalM > 0)) return null;

    const terrainHeights = profilePoints.map((point) => (
        finiteOrNull(sampleSceneYAtLocal(point.x, point.z))
    ));
    const nextKnown = new Array(terrainHeights.length).fill(-1);
    let next = -1;
    for (let index = terrainHeights.length - 1; index >= 0; index--) {
        if (terrainHeights[index] !== null) next = index;
        nextKnown[index] = next;
    }
    if (next < 0) return null;

    // Unknown samples remain unknown evidence; bridge only the profile input
    // from the nearest known samples instead of silently converting misses to 0.
    const filledHeights = terrainHeights.slice();
    let previous = -1;
    for (let index = 0; index < filledHeights.length; index++) {
        if (filledHeights[index] !== null) {
            previous = index;
            continue;
        }
        const following = nextKnown[index];
        if (previous < 0) filledHeights[index] = filledHeights[following];
        else if (following < 0) filledHeights[index] = filledHeights[previous];
        else {
            const spanM = chainages[following] - chainages[previous];
            const t = spanM > 1e-9
                ? (chainages[index] - chainages[previous]) / spanM
                : 0;
            filledHeights[index] = filledHeights[previous]
                + (filledHeights[following] - filledHeights[previous]) * t;
        }
    }

    const baseHeights = new Array(filledHeights.length);
    let left = 0;
    let right = 0;
    for (let index = 0; index < filledHeights.length; index++) {
        const stationM = chainages[index];
        while (left < index
            && stationM - chainages[left] > ROAD_PROFILE_SMOOTH_RADIUS_M) left += 1;
        right = Math.max(right, index);
        while (right + 1 < chainages.length
            && chainages[right + 1] - stationM <= ROAD_PROFILE_SMOOTH_RADIUS_M) right += 1;

        let sumW = 0;
        let sumX = 0;
        let sumY = 0;
        let sumXX = 0;
        let sumXY = 0;
        for (let sampleIndex = left; sampleIndex <= right; sampleIndex++) {
            const offsetM = chainages[sampleIndex] - stationM;
            const scaled = offsetM / ROAD_PROFILE_SMOOTH_SIGMA_M;
            const weight = Math.exp(-0.5 * scaled * scaled);
            const sampleY = filledHeights[sampleIndex];
            sumW += weight;
            sumX += weight * offsetM;
            sumY += weight * sampleY;
            sumXX += weight * offsetM * offsetM;
            sumXY += weight * offsetM * sampleY;
        }
        const denominator = sumW * sumXX - sumX * sumX;
        const slope = Math.abs(denominator) > 1e-9
            ? (sumW * sumXY - sumX * sumY) / denominator
            : 0;
        baseHeights[index] = sumW > 0 ? (sumY - slope * sumX) / sumW : filledHeights[index];
    }

    return {
        chainages,
        points: profilePoints,
        baseHeights,
        sourceSampleIndices,
    };
}

// Shift each smoothed interval by a LINEAR correction so it meets its two
// topology-node elevations exactly. The correction cannot introduce a hump or
// valley: it only changes the interval's overall offset and grade.
function anchorRoadProfile(baseProfile, anchors) {
    if (!baseProfile || !Array.isArray(anchors) || anchors.length < 2) return baseProfile;
    const heights = baseProfile.baseHeights.slice();
    for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex++) {
        const fromAnchor = anchors[anchorIndex];
        const toAnchor = anchors[anchorIndex + 1];
        const fromIndex = baseProfile.sourceSampleIndices[fromAnchor.sourceIndex];
        const toIndex = baseProfile.sourceSampleIndices[toAnchor.sourceIndex];
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) continue;
        if (toIndex <= fromIndex) {
            heights[fromIndex] = toAnchor.height;
            continue;
        }
        const fromStationM = baseProfile.chainages[fromIndex];
        const toStationM = baseProfile.chainages[toIndex];
        const spanM = toStationM - fromStationM;
        const fromCorrection = fromAnchor.height - baseProfile.baseHeights[fromIndex];
        const toCorrection = toAnchor.height - baseProfile.baseHeights[toIndex];
        for (let sampleIndex = fromIndex; sampleIndex <= toIndex; sampleIndex++) {
            const t = spanM > 1e-9
                ? (baseProfile.chainages[sampleIndex] - fromStationM) / spanM
                : 0;
            heights[sampleIndex] = baseProfile.baseHeights[sampleIndex]
                + fromCorrection * (1 - t) + toCorrection * t;
        }
    }
    return { ...baseProfile, heights };
}

function roadProfileYAtSegment(segment, t) {
    const profile = segment && segment.profile;
    if (!profile || !Array.isArray(profile.heights)) return null;
    let low = Number(segment.profileStartIndex);
    let high = Number(segment.profileEndIndex);
    if (!Number.isInteger(low) || !Number.isInteger(high)
        || low < 0 || high < low || high >= profile.chainages.length) return null;
    if (low === high) return finiteOrNull(profile.heights[low]);
    const stationM = profile.chainages[low]
        + (profile.chainages[high] - profile.chainages[low]) * t;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (profile.chainages[middle] <= stationM) low = middle;
        else high = middle;
    }
    const spanM = profile.chainages[high] - profile.chainages[low];
    const localT = spanM > 1e-9 ? (stationM - profile.chainages[low]) / spanM : 0;
    return profile.heights[low] + (profile.heights[high] - profile.heights[low]) * localT;
}

function featureHighway(feature, surface = false) {
    const properties = (feature && feature.properties) || {};
    return surface ? properties.highway_type : properties.highway;
}

function isEngineeredFeature(feature, surface = false) {
    return surface
        ? roadSurfaceUsesEngineeredFormation(feature)
        : ENGINEERED_HIGHWAYS.has(featureHighway(feature, false));
}

function usableEngineeredFeatureId(feature, surface = false) {
    if (!isEngineeredFeature(feature, surface)) return null;
    const osmId = numericId(feature?.properties?.osm_id);
    if (osmId == null) return null;
    const geometry = feature?.geometry;
    if (!surface) {
        return geometry?.type === 'LineString'
            && Array.isArray(geometry.coordinates)
            && geometry.coordinates.length >= 2
            ? osmId
            : null;
    }
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates
            : [];
    return polygons.some((polygon) => (
        Array.isArray(polygon)
        && Array.isArray(polygon[0])
        && polygon[0].length >= 3
    )) ? osmId : null;
}

function formationSourceState(identities) {
    return { index: createRoadFeatureSourceIndex(identities), records: new Map(), features: new Map() };
}

const pairedSurfaceCenterlines = new WeakMap();
function surfaceCenterlineFeature(surface) {
    const geometry = surface?.properties?.centerline_geometry;
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)
        || geometry.coordinates.length < 2) return null;
    let feature = pairedSurfaceCenterlines.get(surface);
    if (!feature) {
        feature = Object.freeze({ type: 'Feature', geometry,
            properties: Object.freeze({ ...surface.properties, highway: surface.properties.highway_type }) });
        pairedSurfaceCenterlines.set(surface, feature);
    }
    return feature;
}

function formationDependencyBounds(profile) {
    return profile.overlapBounds || profile.terrainCutoutBounds || profile.outerBounds || profile.bounds;
}

// Full source variants choose the same revision as roads.js. Explicit polygon
// parts remain separate contributions to one road's formation; they are never
// mistaken for competing full-source variants or connected across a gap.
function updateFormationSources(state, tileKey, features, surface) {
    const records = [];
    for (const [featureIndex, feature] of features.entries()) {
        if (usableEngineeredFeatureId(feature, surface) == null) continue;
        records.push(state.index.prepare(feature, { tileKey, featureIndex }));
    }
    const changes = state.index.setTile(tileKey, records);
    const changedIds = new Set();
    for (const change of changes) {
        const osmId = numericId((change.next || change.previous).feature.properties.osm_id);
        changedIds.add(osmId);
        let parts = state.records.get(osmId);
        if (!parts) state.records.set(osmId, parts = new Map());
        if (change.next) parts.set(change.key, change.next);
        else parts.delete(change.key);
        if (parts.size === 0) state.records.delete(osmId);
    }
    for (const osmId of changedIds) {
        const parts = [...(state.records.get(osmId)?.values() || [])]
            .sort((a, b) => a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
        if (!parts.length) state.features.delete(osmId);
        else state.features.set(osmId, parts[0].feature);
    }
    return { changedIds, changes };
}

const FORMATION_BOUNDARY_INTERPOLATION_KEYS = [
    'innerX', 'innerZ', 'roadY',
    'outerX', 'outerZ', 'terrainY', 'wallTerrainY',
    'cutoutX', 'cutoutZ', 'cutoutTerrainY',
    'overlapX', 'overlapZ', 'overlapTerrainY',
    'surfaceApronWidthM',
];

function interpolateFormationBoundaryPoint(a, b, t) {
    if (t <= 1e-9) return a;
    if (t >= 1 - 1e-9) return b;
    const point = {};
    for (const key of FORMATION_BOUNDARY_INTERPOLATION_KEYS) {
        // surfaceApronWidthM was added after the boundary format was already
        // used by tests and diagnostic callers. Missing values mean no apron;
        // do not turn a partially clipped opening into NaN geometry.
        const aValue = key === 'surfaceApronWidthM' ? (finiteOrNull(a[key]) ?? 0) : a[key];
        const bValue = key === 'surfaceApronWidthM' ? (finiteOrNull(b[key]) ?? 0) : b[key];
        point[key] = aValue + (bValue - aValue) * t;
    }
    point._boundaryT = t;
    return point;
}

// Road-under-rail ownership can start or end in the middle of a densified
// formation segment. Preserve the two visible remnants instead of dropping
// that whole segment: whole-segment suppression created metre-wide side gaps
// and a stair-step/scalloped edge across parallel tracks.
export function* visibleFormationBoundaryPiecesSteps(profile, index, a, b) {
    const suppressions = profile?.roadOpeningSegmentRanges?.[index];
    if (!Array.isArray(suppressions) || suppressions.length === 0) {
        yield { phase: 'boundary-range', index, output: false };
        return [[a, b]];
    }
    const pieces = [];
    let cursor = 0;
    for (const range of suppressions) {
        yield { phase: 'boundary-range', index, output: false };
        const start = Math.max(cursor, Math.max(0, Math.min(1, Number(range?.[0]))));
        const end = Math.max(start, Math.max(0, Math.min(1, Number(range?.[1]))));
        if (start > cursor + 1e-9) {
            pieces.push([
                interpolateFormationBoundaryPoint(a, b, cursor),
                interpolateFormationBoundaryPoint(a, b, start),
            ]);
            yield { phase: 'boundary-piece', index };
        }
        cursor = Math.max(cursor, end);
        if (cursor >= 1 - 1e-9) break;
    }
    if (cursor < 1 - 1e-9) {
        pieces.push([
            interpolateFormationBoundaryPoint(a, b, cursor),
            b,
        ]);
        yield { phase: 'boundary-piece', index };
    }
    return pieces;
}

export function visibleFormationBoundaryPieces(profile, index, a, b) {
    return drainFormationGenerator(visibleFormationBoundaryPiecesSteps(profile, index, a, b));
}

function triangleSurfaceYAtLocal(x, z, a, b, c) {
    const denominator = (b.z - c.z) * (a.x - c.x)
        + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) <= 1e-10) return null;
    const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z))
        / denominator;
    const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z))
        / denominator;
    const wc = 1 - wa - wb;
    const tolerance = 1e-7;
    if (wa < -tolerance || wb < -tolerance || wc < -tolerance) return null;
    return wa * a.y + wb * b.y + wc * c.y;
}

function formationBandSurfaceYAtLocal(x, z, a, b, near, far) {
    const nearA = { x: a[near.x], z: a[near.z], y: a[near.y] };
    const nearB = { x: b[near.x], z: b[near.z], y: b[near.y] };
    const farA = { x: a[far.x], z: a[far.z], y: a[far.y] };
    const farB = { x: b[far.x], z: b[far.z], y: b[far.y] };
    return triangleSurfaceYAtLocal(x, z, nearA, nearB, farA)
        ?? triangleSurfaceYAtLocal(x, z, nearB, farB, farA);
}

const formationDressingIndexes = new WeakMap();

function formationDressingQueryIndex(profile) {
    const cached = profile && formationDressingIndexes.get(profile);
    if (cached) return cached;
    const points = Array.isArray(profile?.points) ? profile.points : [];
    const cells = new Map();
    for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const xs = [a.innerX, a.outerX, a.cutoutX, a.overlapX,
            b.innerX, b.outerX, b.cutoutX, b.overlapX].filter(Number.isFinite);
        const zs = [a.innerZ, a.outerZ, a.cutoutZ, a.overlapZ,
            b.innerZ, b.outerZ, b.cutoutZ, b.overlapZ].filter(Number.isFinite);
        if (xs.length === 0 || zs.length === 0) continue;
        const minCellX = Math.floor(Math.min(...xs) / FORMATION_DRESSING_QUERY_CELL_M);
        const maxCellX = Math.floor(Math.max(...xs) / FORMATION_DRESSING_QUERY_CELL_M);
        const minCellZ = Math.floor(Math.min(...zs) / FORMATION_DRESSING_QUERY_CELL_M);
        const maxCellZ = Math.floor(Math.max(...zs) / FORMATION_DRESSING_QUERY_CELL_M);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                const key = `${cellX}_${cellZ}`;
                let bucket = cells.get(key);
                if (!bucket) cells.set(key, bucket = []);
                bucket.push(index);
            }
        }
    }
    if (profile) formationDressingIndexes.set(profile, cells);
    return cells;
}

function formationDressingSegmentsAtLocal(profile, x, z) {
    const index = formationDressingQueryIndex(profile);
    const cellX = Math.floor(x / FORMATION_DRESSING_QUERY_CELL_M);
    const cellZ = Math.floor(z / FORMATION_DRESSING_QUERY_CELL_M);
    return index.get(`${cellX}_${cellZ}`) || [];
}

// Samples the same visible boundary surface emitted by
// buildRetainingWallPositions + buildFormationTerrainCollarGeometryData.
// This is the civil-ground handoff seam: a later formation can consume an
// earlier formation as terrain without mutating the immutable DGU mesh or
// depending on which streamed mesh happened to publish first.
export function formationDressingSurfaceYAtLocal(
    profile,
    x,
    z,
    { surfaceOffsetY = 0 } = {},
) {
    if (!profile || profile.formationDressingDisabled) return null;
    const localX = finiteOrNull(x);
    const localZ = finiteOrNull(z);
    if (localX == null || localZ == null) return null;
    const offsetY = finiteOrNull(surfaceOffsetY) || 0;
    const points = Array.isArray(profile.points) ? profile.points : [];
    if (points.length < 3) return null;
    let bestY = null;
    const keepHighest = (candidate) => {
        if (candidate == null || !Number.isFinite(candidate)) return;
        bestY = bestY == null ? candidate : Math.max(bestY, candidate);
    };
    for (const index of formationDressingSegmentsAtLocal(
        profile,
        localX,
        localZ,
    )) {
        if (profile.internalSegments?.[index]) continue;
        const a = points[index];
        const b = points[(index + 1) % points.length];
        for (const [visibleA, visibleB] of visibleFormationBoundaryPieces(
            profile,
            index,
            a,
            b,
        )) {
            // The wall/batter begins at the paved formation top. Offset only
            // that row; terrain/collar rows already carry absolute scene Y.
            const topA = { ...visibleA, topY: visibleA.roadY + offsetY };
            const topB = { ...visibleB, topY: visibleB.roadY + offsetY };
            if (profile.verticalRetainedWalls) {
                // The plan-area between track/road edge and wall is a level
                // engineered bench. The terrain jump happens on the wall's
                // zero-area plane at outerX/Z, not across a fake earth slope.
                const benchA = { ...topA, benchY: topA.topY };
                const benchB = { ...topB, benchY: topB.topY };
                keepHighest(formationBandSurfaceYAtLocal(
                    localX,
                    localZ,
                    benchA,
                    benchB,
                    { x: 'innerX', z: 'innerZ', y: 'topY' },
                    { x: 'outerX', z: 'outerZ', y: 'benchY' },
                ));
            } else {
                keepHighest(formationBandSurfaceYAtLocal(
                    localX,
                    localZ,
                    topA,
                    topB,
                    { x: 'innerX', z: 'innerZ', y: 'topY' },
                    { x: 'outerX', z: 'outerZ', y: 'terrainY' },
                ));
            }
            if (profile.collarInternalSegments?.[index]
                || profile.sharedRetainingWallSegments?.[index]) continue;
            keepHighest(formationBandSurfaceYAtLocal(
                localX,
                localZ,
                visibleA,
                visibleB,
                { x: 'outerX', z: 'outerZ', y: 'terrainY' },
                { x: 'cutoutX', z: 'cutoutZ', y: 'cutoutTerrainY' },
            ));
            keepHighest(formationBandSurfaceYAtLocal(
                localX,
                localZ,
                visibleA,
                visibleB,
                { x: 'cutoutX', z: 'cutoutZ', y: 'cutoutTerrainY' },
                { x: 'overlapX', z: 'overlapZ', y: 'overlapTerrainY' },
            ));
        }
    }
    return bestY;
}

function formationBandPoint(point, xKey, zKey) {
    return { x: point[xKey], z: point[zKey] };
}

// A retained face can add a short horizontal flange underneath its owning paved
// surface. A zero-width edge shared by separately sampled meshes can open a
// grazing-angle crack even when both calculations agree mathematically; this
// gives the ownership handoff an area without moving the visible wall plane.
function formationWallTopPoint(point, surfaceOffsetY = 0, underlapM = 0) {
    const dx = Number(point.innerX) - Number(point.outerX);
    const dz = Number(point.innerZ) - Number(point.outerZ);
    const length = Math.hypot(dx, dz);
    const distance = Math.max(0, Number(underlapM) || 0);
    const scale = length > 1e-9 ? distance / length : 0;
    return {
        topX: Number(point.innerX) + dx * scale,
        topZ: Number(point.innerZ) + dz * scale,
        topY: Number(point.roadY) + (Number(surfaceOffsetY) || 0),
    };
}

function appendFormationBandRuns(
    rings,
    profile,
    eligible,
    nearXKey,
    nearZKey,
    farXKey,
    farZKey,
) {
    const points = profile.points;
    const count = points.length;
    const partial = profile.roadOpeningSegmentRanges || [];
    const full = points.map((_point, index) => (
        eligible(index)
        && !(Array.isArray(partial[index]) && partial[index].length > 0)
    ));

    // One polygon per CONTIGUOUS visible boundary run, not one quad per
    // densified edge. A long road with one suppressed junction therefore adds
    // two or three tiny mask paths instead of thousands — the latter made the
    // synchronous 3072px terrain mask take 2–7 seconds on every streamed
    // formation revision.
    for (let start = 0; start < count; start++) {
        const previous = (start - 1 + count) % count;
        if (!full[start] || full[previous]) continue;
        const near = [];
        const far = [];
        let index = start;
        near.push(formationBandPoint(points[index], nearXKey, nearZKey));
        far.push(formationBandPoint(points[index], farXKey, farZKey));
        do {
            const end = (index + 1) % count;
            near.push(formationBandPoint(points[end], nearXKey, nearZKey));
            far.push(formationBandPoint(points[end], farXKey, farZKey));
            index = end;
        } while (index !== start && full[index]);
        rings.push([...near, ...far.reverse()]);
    }

    // A replacement opening can begin midway through one boundary segment.
    // Keep its two exact visible remnants as individual quads; these ranges
    // are rare, while grouping every complete segment above is the hot-path
    // performance win.
    for (let index = 0; index < count; index++) {
        if (!eligible(index)
            || !(Array.isArray(partial[index]) && partial[index].length > 0)) {
            continue;
        }
        const a = points[index];
        const b = points[(index + 1) % count];
        for (const [visibleA, visibleB] of visibleFormationBoundaryPieces(
            profile,
            index,
            a,
            b,
        )) {
            rings.push([
                formationBandPoint(visibleA, nearXKey, nearZKey),
                formationBandPoint(visibleB, nearXKey, nearZKey),
                formationBandPoint(visibleB, farXKey, farZKey),
                formationBandPoint(visibleA, farXKey, farZKey),
            ]);
        }
    }
}

// Exact plan-view pieces under which terrain may be discarded. The common
// uninterrupted formation remains one cheap cutout ring. Only junctions whose
// wall/collar ownership is suppressed split into: paved top + contiguous wall
// runs + contiguous collar runs. This preserves the invariant that every cut
// is covered by rendered geometry without a full-canvas polygon intersection
// in terrain.onFrame().
export function formationTerrainCutoutMaskRings(profile) {
    if (!profile
        || profile.surfacePublicationReady === false
        || profile.terrainCutoutDisabled) return [];
    const innerRing = Array.isArray(profile.innerRing) ? profile.innerRing : [];
    if (innerRing.length < 3) return [];
    if (profile.formationDressingDisabled) return [innerRing];
    const points = Array.isArray(profile.points) ? profile.points : [];
    if (points.length < 3) return [innerRing];
    const hasSuppressedBoundary = profile.internalSegments?.some(Boolean)
        || profile.collarInternalSegments?.some(Boolean)
        || profile.sharedRetainingWallSegments?.some(Boolean)
        || profile.roadOpeningSegmentRanges?.some((ranges) => (
            Array.isArray(ranges) && ranges.length > 0
        ));
    if (!hasSuppressedBoundary
        && Array.isArray(profile.terrainCutoutRing)
        && profile.terrainCutoutRing.length >= 3) {
        return [profile.terrainCutoutRing];
    }

    const rings = [innerRing];
    appendFormationBandRuns(
        rings,
        profile,
        index => !profile.internalSegments?.[index],
        'innerX',
        'innerZ',
        'outerX',
        'outerZ',
    );
    appendFormationBandRuns(
        rings,
        profile,
        index => (
            !profile.internalSegments?.[index]
            && !profile.collarInternalSegments?.[index]
            && !profile.sharedRetainingWallSegments?.[index]
        ),
        'outerX',
        'outerZ',
        'cutoutX',
        'cutoutZ',
    );
    return rings;
}

// The visible terrain does not disappear merely because a civil formation
// occupies the same XZ footprint. Fill sits ON the supplied terrain; only a
// genuine excavation with a closed replacement shell is allowed to remove it.
// Both road and rail profiles attach `terrainExcavationRegions`, so fill keeps
// the supplied ground beneath it and only a measured, fully dressed cut opens
// it. At junctions, `clipRings` split the shell into the paved top plus only the
// wall/collar runs that remain rendered, keeping over-wide sampling bands out
// of any deliberately suppressed boundary.
export function formationTerrainCutoutMaskRegions(profile) {
    const clipRings = formationTerrainCutoutMaskRings(profile);
    if (!Array.isArray(profile?.terrainExcavationRegions)) {
        return clipRings.map((ring) => ({
            ring,
            bounds: ringBounds(ring),
            clipRings: [],
        }));
    }
    if (clipRings.length === 0) return [];
    return profile.terrainExcavationRegions
        // A plan-view surface can prove that terrain protrudes through its
        // colour mesh, but it cannot prove a watertight replacement. In
        // particular, ordinary asphalt is a zero-thickness sheet. Refusing
        // those diagnostic regions here keeps this publication boundary safe
        // even if a caller accidentally mixes them with real civil cuts.
        .filter((region) => region?.replacementBackstopReady !== false)
        .filter((region) => Array.isArray(region?.ring) && region.ring.length >= 3)
        .map((region) => ({
            ring: region.ring,
            bounds: region.bounds || ringBounds(region.ring),
            clipRings: region.clipToPavedSurface ? [profile.innerRing] : clipRings,
            // The terrain ownership mask is about one metre per texel. A hard
            // clip exactly on the asphalt edge therefore leaves a sub-texel
            // fringe where linearly filtered terrain can still win the depth
            // test over a lower road. Where civil dressing exists, its face
            // owns the narrow strip outside the paved ring, so the renderer may
            // safely cover that raster edge inside the already-built face.
            coverPavedClipBoundary: region.clipToPavedSurface === true
                && profile.formationDressingDisabled !== true,
            // A replacement clear ring protects the terrain roof around an
            // underpass. It must not restore a DGU triangle THROUGH asphalt,
            // however: the paved-footprint correction is redrawn after that
            // clear in both the terrain shader mask and the physics query.
            reapplyAfterReplacementClear: region.clipToPavedSurface === true,
        }));
}

function openPolylineNormalAt(points, index) {
    const current = points[index];
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const beforeLength = Math.hypot(current.x - previous.x, current.z - previous.z);
    const afterLength = Math.hypot(next.x - current.x, next.z - current.z);
    let tangentX = 0;
    let tangentZ = 0;
    if (beforeLength > 1e-6) {
        tangentX += (current.x - previous.x) / beforeLength;
        tangentZ += (current.z - previous.z) / beforeLength;
    }
    if (afterLength > 1e-6) {
        tangentX += (next.x - current.x) / afterLength;
        tangentZ += (next.z - current.z) / afterLength;
    }
    const tangentLength = Math.hypot(tangentX, tangentZ);
    if (tangentLength < 1e-6) return { x: 0, z: 1 };
    return { x: tangentZ / tangentLength, z: -tangentX / tangentLength };
}

// Axis evidence decides WHETHER excavation exists. The emitted region is wide
// enough to cover its cut face, then clipped to this profile's exact
// paved/wall/collar rings by formationTerrainCutoutMaskRegions().
export function buildRoadTerrainExcavationRegions({
    centerlineProfile,
    baseSceneYAtLocal,
    roadSceneYAtLocal = null,
    regionHalfWidthM = FORMATION_MAX_CUTOUT_REACH_M,
    minDepthM = ROAD_TERRAIN_EXCAVATION_MIN_DEPTH_M,
} = {}) {
    const points = Array.isArray(centerlineProfile?.points)
        ? centerlineProfile.points
        : [];
    const heights = Array.isArray(centerlineProfile?.heights)
        ? centerlineProfile.heights
        : centerlineProfile?.baseHeights;
    const hasStoredHeights = Array.isArray(heights) && heights.length === points.length;
    if (points.length < 2
        || (!hasStoredHeights && typeof roadSceneYAtLocal !== 'function')
        || typeof baseSceneYAtLocal !== 'function') return [];
    const regionHalfWidth = Math.max(0, Number(regionHalfWidthM) || 0);
    const normals = points.map((_, index) => openPolylineNormalAt(points, index));
    const samples = points.map((point, index) => {
        return {
            x: point.x,
            z: point.z,
            roadY: finiteOrNull(
                typeof roadSceneYAtLocal === 'function'
                    ? roadSceneYAtLocal(point.x, point.z)
                    : heights[index],
            ),
            // Only ground occupying the road axis can authorize removal.
            // Taking the maximum across the whole cross-section made a road
            // beside a rail embankment classify that neighboring slope as a
            // trench, opening a long horizontal slot through the embankment.
            terrainY: finiteOrNull(baseSceneYAtLocal(point.x, point.z)),
        };
    });
    const left = samples.map((sample, index) => ({
        x: sample.x + normals[index].x * regionHalfWidth,
        z: sample.z + normals[index].z * regionHalfWidth,
    }));
    const right = samples.map((sample, index) => ({
        x: sample.x - normals[index].x * regionHalfWidth,
        z: sample.z - normals[index].z * regionHalfWidth,
    }));
    return buildFormationExcavationRegions({
        samples,
        left,
        right,
        baseYAtLocal: baseSceneYAtLocal,
        minDepthM,
    });
}

// The smoothed road axis can be correct while source terrain on ONE SIDE of a
// level carriageway rises above it. A semantic pre-road-owner predicate
// separates that terrain from earlier rail earthwork; depth no longer has to
// guess which one supplied the height.
//
// Preserve that lateral fact in the mask. The former implementation reduced a
// complete cross-section to its single deepest sample, then removed ground
// across the whole paved width. On a hillside that turned the intended
// cut/uphill + fill/downhill section into a full-width excavation. In a coastal
// fill the later OSM/DGU terrain replacement was consequently discarded under
// the elevated half of the road, exposing sky beneath the embankment.
//
// Build bounded longitudinal ribbons per lateral sample band instead. Their
// shared boundaries are byte-identical and the final canvas union remains
// clipped to the exact paved ring. Only bands with proved source-terrain
// intrusion yield; the fill side stays an opaque backstop.
//
// A broad trench needs two consecutive deep stations before it may remove an
// uncovered ground surface. This narrower detector also retains an isolated
// qualifying station so render diagnostics do not discard a real DGU high spot
// at the first 6 m profile station after a topology node. Its output is only
// evidence: the paved top has no thickness and therefore cannot authorize a
// terrain-backstop cut by itself.
function buildPavedSurfaceIntrusionRegions(samples, left, right, minDepthM) {
    const count = Math.min(samples?.length || 0, left?.length || 0, right?.length || 0);
    if (count < 2) return [];
    const qualifies = (sample) => (
        Number.isFinite(sample?.roadY)
        && Number.isFinite(sample?.terrainY)
        && sample.terrainY - sample.roadY >= minDepthM
    );
    const runs = [];
    let start = -1;
    for (let index = 0; index <= count; index++) {
        if (index < count && qualifies(samples[index])) {
            if (start < 0) start = index;
            continue;
        }
        if (start >= 0) runs.push([start, index - 1]);
        start = -1;
    }
    const midpoint = (a, b) => ({
        x: (Number(a.x) + Number(b.x)) * 0.5,
        z: (Number(a.z) + Number(b.z)) * 0.5,
    });
    const samePoint = (a, b) => (
        Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.z - b.z) <= 1e-9
    );
    const pushUnique = (ring, point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return;
        if (ring.length === 0 || !samePoint(ring[ring.length - 1], point)) {
            ring.push({ x: Number(point.x), z: Number(point.z) });
        }
    };
    return runs.map(([runStart, runEnd]) => {
        const ring = [];
        const leftStart = runStart === 0
            ? left[runStart]
            : midpoint(left[runStart - 1], left[runStart]);
        const leftEnd = runEnd === count - 1
            ? left[runEnd]
            : midpoint(left[runEnd], left[runEnd + 1]);
        const rightStart = runStart === 0
            ? right[runStart]
            : midpoint(right[runStart - 1], right[runStart]);
        const rightEnd = runEnd === count - 1
            ? right[runEnd]
            : midpoint(right[runEnd], right[runEnd + 1]);
        pushUnique(ring, leftStart);
        for (let index = runStart; index <= runEnd; index++) pushUnique(ring, left[index]);
        pushUnique(ring, leftEnd);
        pushUnique(ring, rightEnd);
        for (let index = runEnd; index >= runStart; index--) pushUnique(ring, right[index]);
        pushUnique(ring, rightStart);
        return ring.length >= 4 ? { ring, bounds: ringBounds(ring) } : null;
    }).filter(Boolean);
}

export function buildRoadSurfaceTerrainIntrusionRegions({
    centerlineProfile,
    surfaceRing,
    surfaceRingQueryIndex = null,
    sourceTerrainInputSceneYAtLocal,
    roadSceneYAtLocal,
    regionHalfWidthM = FORMATION_MAX_CUTOUT_REACH_M,
    minDepthM = ROAD_SURFACE_INTRUSION_MIN_DEPTH_M,
} = {}) {
    const points = Array.isArray(centerlineProfile?.points)
        ? centerlineProfile.points
        : [];
    if (points.length < 2
        || !Array.isArray(surfaceRing) || surfaceRing.length < 3
        || typeof sourceTerrainInputSceneYAtLocal !== 'function'
        || typeof roadSceneYAtLocal !== 'function') return [];
    const regionHalfWidth = Math.max(0, Number(regionHalfWidthM) || 0);
    if (!(regionHalfWidth > 0)) return [];
    const normals = points.map((_, index) => openPolylineNormalAt(points, index));
    const boundaries = [-regionHalfWidth];
    for (let offsetM = -Math.floor(
        regionHalfWidth / ROAD_SURFACE_INTRUSION_SAMPLE_STEP_M,
    ) * ROAD_SURFACE_INTRUSION_SAMPLE_STEP_M;
    offsetM <= regionHalfWidth + 1e-9;
    offsetM += ROAD_SURFACE_INTRUSION_SAMPLE_STEP_M) {
        if (offsetM > -regionHalfWidth + 1e-9
            && offsetM < regionHalfWidth - 1e-9) boundaries.push(offsetM);
    }
    boundaries.push(regionHalfWidth);
    boundaries.sort((a, b) => a - b);

    const regions = [];
    for (let bandIndex = 0; bandIndex + 1 < boundaries.length; bandIndex++) {
        const nearOffsetM = boundaries[bandIndex];
        const farOffsetM = boundaries[bandIndex + 1];
        if (!(farOffsetM - nearOffsetM > 1e-6)) continue;
        const middleOffsetM = (nearOffsetM + farOffsetM) * 0.5;
        const samples = points.map((point, index) => {
            const roadY = finiteOrNull(roadSceneYAtLocal(point.x, point.z));
            const normal = normals[index];
            const x = point.x + normal.x * middleOffsetM;
            const z = point.z + normal.z * middleOffsetM;
            if (roadY === null) return { x, z, roadY: null, terrainY: null };
            let deepestM = null;
            // Endpoints plus midpoint make each 1.5 m band conservative while
            // retaining the lateral cut/fill boundary. Exact paved clipping
            // below removes the portions of edge bands outside the road.
            for (const offsetM of [nearOffsetM, middleOffsetM, farOffsetM]) {
                const sampleX = point.x + normal.x * offsetM;
                const sampleZ = point.z + normal.z * offsetM;
                if (!pointInRing(
                    sampleX,
                    sampleZ,
                    surfaceRing,
                    surfaceRingQueryIndex,
                )) continue;
                const terrainY = finiteOrNull(
                    sourceTerrainInputSceneYAtLocal(sampleX, sampleZ),
                );
                if (terrainY === null) continue;
                const depthM = terrainY - roadY;
                deepestM = deepestM === null ? depthM : Math.max(deepestM, depthM);
            }
            const terrainIntrusion = deepestM !== null && deepestM >= minDepthM;
            return {
                x,
                z,
                // Null design evidence deliberately breaks the longitudinal
                // run; formationCutDepths must not fall back to an unrelated
                // centre sample and re-authorize this lateral band.
                roadY: terrainIntrusion ? roadY : null,
                terrainY: terrainIntrusion ? roadY + deepestM : null,
            };
        });
        const near = points.map((point, index) => ({
            x: point.x + normals[index].x * nearOffsetM,
            z: point.z + normals[index].z * nearOffsetM,
        }));
        const far = points.map((point, index) => ({
            x: point.x + normals[index].x * farOffsetM,
            z: point.z + normals[index].z * farOffsetM,
        }));
        regions.push(...buildPavedSurfaceIntrusionRegions(
            samples,
            near,
            far,
            minDepthM,
        ));
    }
    return regions.map(region => ({
        ...region,
        clipToPavedSurface: true,
        // Canonical no-void contract: a colour-only asphalt sheet does not
        // seal the vertical boundary exposed when source terrain disappears.
        replacementBackstopReady: false,
    }));
}

// Formation dressing is one-sided in practice: a cut wall is seen from the
// trench, a fill embankment from downhill, a collar from above. The ring's
// march direction flips between its two long sides, so emitting a fixed
// vertex order faces half of every ring backwards — computeVertexNormals then
// lights those triangles from behind, which reads as near-black navy panels
// at night (ambient only) and over-bright patches under the walker lamp.
// Orient each triangle against an explicit face direction instead.
function pushTriangleFacing(positions, faceX, faceY, faceZ, a, b, c) {
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * faceX + ny * faceY + nz * faceZ >= 0) {
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    } else {
        positions.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    }
}

export function* buildRetainingWallPositionsSteps(
    profile,
    surfaceOffsetY = 0,
    { faceKind = 'all' } = {},
) {
    const positions = [];
    if (profile?.formationDressingDisabled) return positions;
    const points = profile && Array.isArray(profile.points) ? profile.points : [];
    if (points.length < 3) return positions;
    const topUnderlapM = Math.max(
        0,
        finiteOrNull(profile.wallTopUnderlapM) || 0,
    );
    for (let index = 0; index < points.length; index++) {
        yield { phase: 'retaining-segment', index };
        if (profile.internalSegments && profile.internalSegments[index]) continue;
        const a = points[index];
        const b = points[(index + 1) % points.length];
        for (const [visibleA, visibleB] of yield* visibleFormationBoundaryPiecesSteps(
            profile,
            index,
            a,
            b,
        )) {
            yield { phase: 'retaining-piece', index };
            const aTopY = visibleA.roadY + surfaceOffsetY;
            const bTopY = visibleB.roadY + surfaceOffsetY;
            // Face the air side: a cut wall (terrain above the top) is viewed
            // from inside the trench, a fill wall from outside the formation.
            const cut = (visibleA.terrainY + visibleB.terrainY) * 0.5
                >= (aTopY + bTopY) * 0.5;
            const cutDepthM = (visibleA.terrainY + visibleB.terrainY) * 0.5
                - (aTopY + bTopY) * 0.5;
            // An explicitly vertical section is structural in either cut or
            // fill. Otherwise curb-scale relief remains an earth shoulder even
            // if a noisy DGU sample lands a few centimetres above the pavement;
            // reserve concrete for a sustained civil cut.
            const materialKind = profile.verticalRetainedWalls
                ? 'retaining'
                : cut && cutDepthM >= ROAD_CIVIL_EXCAVATION_MIN_DEPTH_M
                    ? 'retaining'
                    : 'earth';
            if (faceKind !== 'all'
                && faceKind !== (cut ? 'cut' : 'fill')
                && faceKind !== materialKind) continue;
            const inwardX = (
                (visibleA.innerX + visibleB.innerX)
                - (visibleA.outerX + visibleB.outerX)
            ) * 0.5;
            const inwardZ = (
                (visibleA.innerZ + visibleB.innerZ)
                - (visibleA.outerZ + visibleB.outerZ)
            ) * 0.5;
            const faceX = cut ? inwardX : -inwardX;
            const faceZ = cut ? inwardZ : -inwardZ;
            const innerA = [visibleA.innerX, aTopY, visibleA.innerZ];
            const innerB = [visibleB.innerX, bTopY, visibleB.innerZ];
            if (profile.verticalRetainedWalls) {
                const footA = [visibleA.outerX, aTopY, visibleA.outerZ];
                const footB = [visibleB.outerX, bTopY, visibleB.outerZ];
                const retainedA = [visibleA.outerX, visibleA.terrainY, visibleA.outerZ];
                const retainedB = [visibleB.outerX, visibleB.terrainY, visibleB.outerZ];
                // Flat engineered cess/bench from the surface edge to the
                // wall. It replaces the terrain that a rural batter occupied.
                pushTriangleFacing(positions, 0, 1, 0, innerA, innerB, footA);
                pushTriangleFacing(positions, 0, 1, 0, innerB, footB, footA);
                // The shared rail/road interface keeps this lower level bench,
                // but the later road owns the one vertical face on the exact
                // same plane. Omitting only the jump avoids both a floor void
                // and two independently triangulated walls fighting in depth.
                if (profile.sharedRetainingWallSegments?.[index]) continue;
                // The retained jump itself has no horizontal run.
                pushTriangleFacing(positions, faceX, 0, faceZ,
                    footA, footB, retainedA);
                pushTriangleFacing(positions, faceX, 0, faceZ,
                    footB, retainedB, retainedA);
                const skirtA = [
                    visibleA.outerX,
                    visibleA.wallTerrainY,
                    visibleA.outerZ,
                ];
                const skirtB = [
                    visibleB.outerX,
                    visibleB.wallTerrainY,
                    visibleB.outerZ,
                ];
                pushTriangleFacing(positions, faceX, 0, faceZ,
                    retainedA, retainedB, skirtA);
                pushTriangleFacing(positions, faceX, 0, faceZ,
                    retainedB, skirtB, skirtA);
                continue;
            }
            if (topUnderlapM > 0) {
                const topA = formationWallTopPoint(
                    visibleA,
                    surfaceOffsetY,
                    topUnderlapM,
                );
                const topB = formationWallTopPoint(
                    visibleB,
                    surfaceOffsetY,
                    topUnderlapM,
                );
                const underA = [topA.topX, topA.topY, topA.topZ];
                const underB = [topB.topX, topB.topY, topB.topZ];
                pushTriangleFacing(positions, 0, 1, 0, underA, innerA, underB);
                pushTriangleFacing(positions, 0, 1, 0, innerA, innerB, underB);
            }
            const toeA = [visibleA.outerX, visibleA.terrainY, visibleA.outerZ];
            const toeB = [visibleB.outerX, visibleB.terrainY, visibleB.outerZ];
            pushTriangleFacing(positions, faceX, 0, faceZ, innerA, innerB, toeA);
            pushTriangleFacing(positions, faceX, 0, faceZ, innerB, toeB, toeA);
            // Vertical penetration at the seam prevents a sub-pixel cutout
            // discrepancy from opening above a cut wall or below a fill wall.
            // The visible face terminates at terrainY exactly; only this
            // zero-width vertical skirt penetrates the terrain, so the toe
            // cannot wander across a sloped face as terrain triangles change.
            const skirtA = [visibleA.outerX, visibleA.wallTerrainY, visibleA.outerZ];
            const skirtB = [visibleB.outerX, visibleB.wallTerrainY, visibleB.outerZ];
            pushTriangleFacing(positions, faceX, 0, faceZ, toeA, toeB, skirtA);
            pushTriangleFacing(positions, faceX, 0, faceZ, toeB, skirtB, skirtA);
        }
    }
    return positions;
}

export function buildRetainingWallPositions(profile, surfaceOffsetY = 0, options = {}) {
    return drainFormationGenerator(buildRetainingWallPositionsSteps(profile, surfaceOffsetY, options));
}

// Terrain-mapped civil faces share a regional geometry bucket with the exact
// formation collar. The batch contract requires every part in that bucket to
// expose the same attributes, while the material requires the UV phase to
// continue from the supplied terrain. Keep this pure so the collar + earth
// batching contract can be exercised without Three.js or a browser.
export function* buildWorldXZUvsForPositionsSteps(positions, uvPerM = 1) {
    const vertexCount = Math.floor((positions?.length || 0) / 3);
    const scale = Number(uvPerM);
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const uvs = new Float32Array(vertexCount * 2);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        if (vertex % 128 === 0) yield { phase: 'world-uv', vertex };
        uvs[vertex * 2] = positions[vertex * 3] * safeScale;
        uvs[vertex * 2 + 1] = positions[vertex * 3 + 2] * safeScale;
    }
    return uvs;
}

export function buildWorldXZUvsForPositions(positions, uvPerM = 1) {
    return drainFormationGenerator(buildWorldXZUvsForPositionsSteps(positions, uvPerM));
}

// Retaining faces are unindexed triangles that can run in any plan direction.
// U follows each triangle's longest horizontal edge; V is absolute world
// height. The resulting coordinates are in metres and work with a repeating
// procedural texture without smearing Z-running or curved wall panels.
export function buildWallFaceUvsForPositions(positions) {
    const values = Array.isArray(positions) || ArrayBuffer.isView(positions)
        ? positions
        : [];
    const uvs = new Float32Array(Math.floor(values.length / 3) * 2);
    for (let triangle = 0; triangle + 9 <= values.length; triangle += 9) {
        let tangentX = 1;
        let tangentZ = 0;
        let bestLengthSquared = -1;
        for (let edge = 0; edge < 3; edge++) {
            const a = triangle + edge * 3;
            const b = triangle + ((edge + 1) % 3) * 3;
            const dx = values[b] - values[a];
            const dz = values[b + 2] - values[a + 2];
            const lengthSquared = dx * dx + dz * dz;
            if (lengthSquared <= bestLengthSquared) continue;
            bestLengthSquared = lengthSquared;
            const length = Math.sqrt(lengthSquared) || 1;
            tangentX = dx / length;
            tangentZ = dz / length;
        }
        for (let vertex = 0; vertex < 3; vertex++) {
            const positionIndex = triangle + vertex * 3;
            const uvIndex = (triangle / 3 + vertex) * 2;
            uvs[uvIndex] = values[positionIndex] * tangentX
                + values[positionIndex + 2] * tangentZ;
            uvs[uvIndex + 1] = values[positionIndex + 1];
        }
    }
    return uvs;
}

// Level ground between a narrow rendered surface (for rail, the ballast bed)
// and the wider civil formation edge. Without this band an excavation mask is
// correct to remove the source terrain across the formation, but has no opaque
// replacement over the drainage/cess apron — exposing the underlay as a long
// sky/water slot. Emit it into the caller's existing earthwork mesh so the fix
// costs vertices only, not another material or draw call.
export function* buildFormationSurfaceApronGeometryDataSteps(
    profile,
    surfaceOffsetY = 0,
) {
    const positions = [];
    if (profile?.formationDressingDisabled) {
        return { positions, uvs: new Float32Array(0) };
    }
    const points = Array.isArray(profile?.points) ? profile.points : [];
    if (points.length < 3) return { positions, uvs: new Float32Array(0) };
    const overlapM = Math.max(0, finiteOrNull(profile.wallTopUnderlapM) || 0);
    for (let index = 0; index < points.length; index++) {
        yield { phase: 'apron-segment', index };
        if (profile.internalSegments?.[index]) continue;
        const a = points[index];
        const b = points[(index + 1) % points.length];
        for (const [visibleA, visibleB] of yield* visibleFormationBoundaryPiecesSteps(
            profile,
            index,
            a,
            b,
        )) {
            yield { phase: 'apron-piece', index };
            const widthA = Math.max(0, finiteOrNull(visibleA.surfaceApronWidthM) || 0);
            const widthB = Math.max(0, finiteOrNull(visibleB.surfaceApronWidthM) || 0);
            if (!(widthA > 0 || widthB > 0)) continue;
            const formationA = [
                visibleA.innerX,
                visibleA.roadY + surfaceOffsetY,
                visibleA.innerZ,
            ];
            const formationB = [
                visibleB.innerX,
                visibleB.roadY + surfaceOffsetY,
                visibleB.innerZ,
            ];
            const insetA = formationWallTopPoint(
                visibleA,
                surfaceOffsetY,
                widthA > 0 ? widthA + overlapM : 0,
            );
            const insetB = formationWallTopPoint(
                visibleB,
                surfaceOffsetY,
                widthB > 0 ? widthB + overlapM : 0,
            );
            const trackbedA = [insetA.topX, insetA.topY, insetA.topZ];
            const trackbedB = [insetB.topX, insetB.topY, insetB.topZ];
            pushTriangleFacing(positions, 0, 1, 0, trackbedA, formationA, trackbedB);
            pushTriangleFacing(positions, 0, 1, 0, formationA, formationB, trackbedB);
        }
    }
    return {
        positions,
        uvs: yield* buildWorldXZUvsForPositionsSteps(positions),
    };
}

export function buildFormationSurfaceApronGeometryData(profile, surfaceOffsetY = 0) {
    return drainFormationGenerator(buildFormationSurfaceApronGeometryDataSteps(profile, surfaceOffsetY));
}

// Terrain-coloured rail seam geometry. It starts at the exact retaining-wall
// toe and extends past the raster cutout, so mask quantisation can reveal only
// a continuation of the surrounding terrain rather than sky, water, or a grey
// civil-structure strip.
//
// Two vertex rows meet at the CUTOUT line. For ordinary formations that line
// is coincident with the exact retaining-wall toe; the first row is therefore
// degenerate in plan, but remains useful as a vertical seal when a shared
// retained boundary and the sampled terrain disagree in height. Terrain stays
// intact beneath the visible outer→overlap collar, so different terrain/collar
// triangulations cannot reveal sky at their boundary.
//
// UVs are in METRES (the caller scales by its texture's uvPerM). On flat
// ground they equal the world-XZ projection exactly — the camouflage that
// makes the collar continue the surrounding terrain texture — and as a span
// turns steep they blend to an arc/section mapping so a near-vertical collar
// face carries its true metres instead of smearing one texel down the cliff.
export function* buildFormationTerrainCollarGeometryDataSteps(profile) {
    const positions = [];
    const uvs = [];
    if (profile?.formationDressingDisabled) return { positions, uvs };
    const points = profile && Array.isArray(profile.points) ? profile.points : [];
    if (points.length < 3) return { positions, uvs };
    // Collar rows from the toe through the overlap. The shared cutout row is
    // also the steep-face U axis: using one common 3D arc keeps diagonals from
    // collapsing when the independently sampled outer rows have different
    // lengths along a cliff.
    const lines = [
        ['outerX', 'outerZ', 'terrainY'],
        ['cutoutX', 'cutoutZ', 'cutoutTerrainY'],
        ['overlapX', 'overlapZ', 'overlapTerrainY'],
    ];
    // Older/synthetic profiles predate the explicit cutout row. Treat their
    // cutout as the midpoint of the same outer→overlap collar instead of
    // emitting NaNs; current profiles always provide the exact terrain-mask
    // boundary coordinates.
    const lineValue = (point, row, component) => {
        const value = Number(point?.[lines[row][component]]);
        if (Number.isFinite(value)) return value;
        if (row !== 1) return value;
        const outer = Number(point?.[lines[0][component]]);
        const overlap = Number(point?.[lines[2][component]]);
        return Number.isFinite(outer) && Number.isFinite(overlap)
            ? (outer + overlap) * 0.5
            : value;
    };
    const sectionArc3d = new Array(points.length + 1).fill(0);
    for (let index = 1; index <= points.length; index++) {
        yield { phase: 'collar-section', index };
        const previous = points[index - 1];
        const current = points[index % points.length];
        sectionArc3d[index] = sectionArc3d[index - 1] + Math.hypot(
            lineValue(current, 1, 0) - lineValue(previous, 1, 0),
            lineValue(current, 1, 1) - lineValue(previous, 1, 1),
            lineValue(current, 1, 2) - lineValue(previous, 1, 2),
        );
    }
    const steepness = (planM, threeDM) => {
        if (!(planM > 1e-6)) return 1;
        return Math.max(0, Math.min(1, (threeDM / planM - 1) / 1.5));
    };
    const vertex = (x, y, z, steepU, steepV, steep01) => {
        positions.push(x, y, z);
        // Flat quad → world-XZ (continues the terrain texture, byte-identical
        // to the old mapping); steep quad → true 3D arc/section metres (no
        // smear). Per-quad blend on an unindexed strip: neighbouring quads can
        // disagree only across their shared edge, invisible on cliff faces.
        uvs.push(
            x * (1 - steep01) + steepU * steep01,
            z * (1 - steep01) + steepV * steep01,
        );
    };
    for (let index = 0; index < points.length; index++) {
        yield { phase: 'collar-segment', index };
        if (profile.internalSegments && profile.internalSegments[index]) continue;
        // A collar that would ride across another road's surface (which sits
        // at its own level on relief) is suppressed even where the wall stays.
        if (profile.collarInternalSegments && profile.collarInternalSegments[index]) continue;
        // A published terrain replacement is already the opaque backstop for
        // this fill toe. Re-triangulating the same terrain as a generic collar
        // creates folded flaps where its diagonal differs from the replacement
        // surface (most visibly at the OSM/DGU coastal transition).
        if (profile.terrainReplacementBackstopSegments?.[index]) continue;
        if (profile.sharedRetainingWallSegments?.[index]) continue;
        const a = points[index];
        const b = points[(index + 1) % points.length];
        for (const [visibleA, visibleB] of yield* visibleFormationBoundaryPiecesSteps(
            profile,
            index,
            a,
            b,
        )) {
            yield { phase: 'collar-piece', index };
            const startT = Number.isFinite(visibleA._boundaryT) ? visibleA._boundaryT : 0;
            const endT = Number.isFinite(visibleB._boundaryT) ? visibleB._boundaryT : 1;
            let baseVA = 0;
            let baseVB = 0;
            for (let row = 0; row < 2; row++) {
                const nearAx = lineValue(visibleA, row, 0);
                const nearAz = lineValue(visibleA, row, 1);
                const nearAy = lineValue(visibleA, row, 2);
                const nearBx = lineValue(visibleB, row, 0);
                const nearBz = lineValue(visibleB, row, 1);
                const nearBy = lineValue(visibleB, row, 2);
                const farAx = lineValue(visibleA, row + 1, 0);
                const farAz = lineValue(visibleA, row + 1, 1);
                const farAy = lineValue(visibleA, row + 1, 2);
                const farBx = lineValue(visibleB, row + 1, 0);
                const farBz = lineValue(visibleB, row + 1, 1);
                const farBy = lineValue(visibleB, row + 1, 2);
                const crossPlanA = Math.hypot(farAx - nearAx, farAz - nearAz);
                const crossPlanB = Math.hypot(farBx - nearBx, farBz - nearBz);
                const cross3dA = Math.hypot(crossPlanA, farAy - nearAy);
                const cross3dB = Math.hypot(crossPlanB, farBy - nearBy);
                // With the cutout located at the toe, ordinary outer→cutout
                // rows coincide exactly. Do not upload zero-area triangles;
                // retain the row only where differing prescribed/sample
                // heights make it a real vertical sealing face.
                if (cross3dA <= 1e-7 && cross3dB <= 1e-7) continue;
                const alongPlanNear = Math.hypot(nearBx - nearAx, nearBz - nearAz);
                const alongPlanFar = Math.hypot(farBx - farAx, farBz - farAz);
                const along3dNear = Math.hypot(alongPlanNear, nearBy - nearAy);
                const along3dFar = Math.hypot(alongPlanFar, farBy - farAy);
                const steep01 = Math.max(
                    steepness(crossPlanA, cross3dA),
                    steepness(crossPlanB, cross3dB),
                    steepness(alongPlanNear, along3dNear),
                    steepness(alongPlanFar, along3dFar),
                );
                const sectionArcStart = sectionArc3d[index];
                const sectionArcDelta = sectionArc3d[index + 1] - sectionArcStart;
                const sharedUA = sectionArcStart + sectionArcDelta * startT;
                const sharedUB = sectionArcStart + sectionArcDelta * endT;
                const farVA = baseVA + cross3dA;
                const farVB = baseVB + cross3dB;
                // Lying quads must face up (they overlay kept terrain), cliff-grade
                // quads outward, away from the formation; a blended reference
                // handles both. Orientation swaps carry the uv with the vertex.
                const faceX = ((farAx + farBx) - (nearAx + nearBx)) * 0.3;
                const faceZ = ((farAz + farBz) - (nearAz + nearBz)) * 0.3;
                const nearA = [nearAx, nearAy, nearAz, sharedUA, baseVA, steep01];
                const nearB = [nearBx, nearBy, nearBz, sharedUB, baseVB, steep01];
                const farA = [farAx, farAy, farAz, sharedUA, farVA, steep01];
                const farB = [farBx, farBy, farBz, sharedUB, farVB, steep01];
                const emitTriangle = (v0, v1, v2) => {
                    const ux = v1[0] - v0[0]; const uy = v1[1] - v0[1]; const uz = v1[2] - v0[2];
                    const vx = v2[0] - v0[0]; const vy = v2[1] - v0[1]; const vz = v2[2] - v0[2];
                    const nx = uy * vz - uz * vy;
                    const ny = uz * vx - ux * vz;
                    const nz = ux * vy - uy * vx;
                    const ordered = nx * faceX + ny + nz * faceZ >= 0
                        ? [v0, v1, v2]
                        : [v0, v2, v1];
                    for (const v of ordered) vertex(v[0], v[1], v[2], v[3], v[4], v[5]);
                };
                emitTriangle(nearA, nearB, farA);
                emitTriangle(nearB, farB, farA);
                baseVA = farVA;
                baseVB = farVB;
            }
        }
    }
    return { positions, uvs };
}

export function buildFormationTerrainCollarGeometryData(profile) {
    return drainFormationGenerator(buildFormationTerrainCollarGeometryDataSteps(profile));
}

export function buildFormationTerrainCollarPositions(profile) {
    return buildFormationTerrainCollarGeometryData(profile).positions;
}

// Builds the shared cut/fill seam used by roads and engineered rail beds.
// `surfaceSceneYAtLocal` owns the designed top while `baseSceneYAtLocal`
// samples untouched terrain at the battered edge and matching overlap collar.
export function buildFormationSurfaceProfile(options) {
    return drainFormationGenerator(buildFormationSurfaceProfileSteps(options));
}

export function* buildFormationSurfaceProfileSteps({
    innerRing,
    surfaceSceneYAtLocal,
    baseSceneYAtLocal,
    // Identifies points at which baseSceneYAtLocal is supplied by an opaque,
    // published terrain replacement rather than the raw terrain mesh. This is
    // kept separate from the height sampler so geometry never guesses semantic
    // ownership from elevation coincidence.
    baseTerrainReplacementAtLocal = null,
    maxSegmentM = PROFILE_STEP_M,
    metadata = {},
    // Opening a cross-cap drops the wall + collar face that seals a formation
    // end, so a bore's tube can pass through the mouth instead of driving into
    // a slab. Caps are identified by `capEdge` tags on the innerRing vertices
    // (see densifyClosedLocalRing). Roads pass neither and stay unaffected.
    openCapStart = false,
    openCapEnd = false,
    // Carve a shallow cross-slope bench on the cut flank (see the bench march
    // below). Rail beds opt in; roads keep their near-vertical batter.
    crossSlopeBench = false,
    // Near an OPEN cap the caller has its own width contract — a tunnel mouth
    // flares the innerRing to exactly the bore half-width so the cut wall meets
    // the stone tunnel wall flush. The depth-scaled bench must not out-carve
    // that seam (it opened sky wedges beside the portal and exposed the tube's
    // shell), so within this many ring-metres of an open cap the bench eases
    // back to its CUT_BENCH_MIN_M floor. 0 (the default) changes nothing.
    capBenchTaperM = 0,
    // A local access route may need the retained face to run farther than the
    // ordinary 1:1 cut batter. Surface-cut station stairs use this to carry
    // their treads and landing all the way to untouched ground. Returning null
    // keeps the normal depth-derived reach; roads and ordinary rail do not pass
    // this callback and are byte-identical.
    minimumCutBenchReachAtLocal = null,
    // Retaining faces may continue beneath their owning top surface so their
    // handoff is an overlap rather than a fragile shared line. Roads keep the
    // zero default; rail passes a curb-width overlap for its trackbed.
    wallTopUnderlapM = 0,
    // A civil formation can be wider than the surface rendered inside it. The
    // caller may put a per-vertex width on innerRing (for flared approaches),
    // or use this constant fallback. The resulting level apron is emitted by
    // buildFormationSurfaceApronGeometryData; zero keeps ordinary roads and
    // narrow rail byte-identical.
    surfaceApronWidthM = 0,
    // Dense urban corridors often replace an earth batter with a level civil
    // bench and a vertical wall at its outside edge. The same profile still
    // owns the terrain cutout/collar seam; only the visible cross-section and
    // the ground query change. Roads retain their existing battered default.
    verticalRetainedWalls = false,
    // A reviewed parallel civil work may already define the physical wall
    // plane. The later formation can snap its provisional outer point to that
    // boundary while retaining ownership of its own visible face. Returning
    // null keeps the independently solved default.
    retainedWallBoundaryAtLocal = null,
}) {
    if (typeof surfaceSceneYAtLocal !== 'function'
        || typeof baseSceneYAtLocal !== 'function') return null;
    const wantsCapTags = openCapStart || openCapEnd;
    // Rail OSM ways often end only because a tag or tile boundary split one
    // physical track. Preserve cap identity even when this particular cap is
    // not already known to be a tunnel mouth; the rail boundary resolver can
    // then remove false walls/collars where another alignment continues.
    // Ordinary road polygons carry no capEdge tags and pay no extra allocation.
    const hasCapTags = Array.isArray(innerRing)
        && innerRing.some(point => point?.capEdge != null);
    let segmentTags = hasCapTags ? [] : null;
    let denseRing = yield* densifyClosedLocalRingSteps(
        innerRing,
        maxSegmentM,
        segmentTags,
    );
    if (denseRing.length < 3) return null;
    // Sharp relief tears straight seam spans vertically (see refineRingByRelief);
    // split ring segments across it so wall top, collar and cutout ring all
    // follow the terrain they are sealing against.
    ({ ring: denseRing, segmentTags } = yield* refineRingByReliefSteps(
        denseRing,
        segmentTags,
        baseSceneYAtLocal,
    ));
    const capBenchFactors = crossSlopeBench && capBenchTaperM > 0 && wantsCapTags
        ? openCapBenchFactors(denseRing, segmentTags, {
            openCapStart,
            openCapEnd,
            taperM: capBenchTaperM,
        })
        : null;
    const directions = outwardMiterDirections(denseRing);
    const defaultSurfaceApronWidthM = Math.max(0, Number(surfaceApronWidthM) || 0);
    const points = [];
    let sliceStartedAt = formationBuildNowMs();
    for (let index = 0; index < denseRing.length; index++) {
        const inner = denseRing[index];
        const roadY = Number(surfaceSceneYAtLocal(inner.x, inner.z));
        if (!Number.isFinite(roadY)) return null;
        const direction = directions[index];
        const rawAtBoundary = finiteOrNull(baseSceneYAtLocal(inner.x, inner.z));
        let setback = Math.min(
            MAX_BATTER_M,
            Math.max(MIN_BATTER_M,
                Math.abs((rawAtBoundary === null ? roadY : rawAtBoundary) - roadY)
                    * BATTER_PER_VERTICAL_M),
        );
        let outerX = inner.x + direction.x * setback;
        let outerZ = inner.z + direction.z * setback;
        let terrainY = finiteOrNull(baseSceneYAtLocal(outerX, outerZ));
        if (terrainY === null) terrainY = roadY;
        // One correction uses the actual toe/crest height. This keeps the
        // batter near-vertical on tall cuts/fills without making shallow
        // edges needlessly wide.
        setback = Math.min(
            MAX_BATTER_M,
            Math.max(MIN_BATTER_M,
                Math.abs(terrainY - roadY) * BATTER_PER_VERTICAL_M),
        );
        outerX = inner.x + direction.x * setback;
        outerZ = inner.z + direction.z * setback;
        terrainY = finiteOrNull(baseSceneYAtLocal(outerX, outerZ));
        if (terrainY === null) terrainY = roadY;
        // A retained urban section may declare where its wall actually stands.
        // Honour that surveyed/semantic reach even when there is no rural cut
        // batter to "earn" it from terrain depth. The property is shared with
        // the cross-slope bench below and is measured in real plan metres;
        // miter vectors can be longer than one at corners.
        const retainedReachM = finiteOrNull(inner.minimumCutBenchReachM);
        if (verticalRetainedWalls && retainedReachM !== null) {
            const directionLength = Math.hypot(direction.x, direction.z) || 1;
            if (setback * directionLength < retainedReachM) {
                setback = retainedReachM / directionLength;
                outerX = inner.x + direction.x * setback;
                outerZ = inner.z + direction.z * setback;
                terrainY = finiteOrNull(baseSceneYAtLocal(outerX, outerZ));
                if (terrainY === null) terrainY = roadY;
            }
        }
        // Cross-slope bench: on a CUT (terrain above the designed top) push the
        // outer point out to where the ground daylights back to trackbed level,
        // or to where the face has reached the design batter, so the cutout +
        // wall + collar reach past the burying hillside. `direction` is a miter
        // vector (up to MAX_MITER_SCALE at corners), so the march and its reach
        // are converted to metres via its length to keep the rule honest at bends.
        // The reach is re-earned each step from the depth actually found there:
        // a hillside that keeps climbing keeps buying face, up to CUT_BENCH_MAX_M.
        if (crossSlopeBench && terrainY - roadY > CUT_BENCH_TRIGGER_M) {
            const dirLen = Math.hypot(direction.x, direction.z) || 1;
            const stepMarch = CUT_BENCH_STEP_M / dirLen;
            const capFactor = capBenchFactors ? capBenchFactors[index] : 1;
            // The reach is earned by the depth AT THE TRACKBED EDGE — a true
            // cut buries the bed edge itself, so a deep cut daylights a wide
            // face. Keying it on the marched FLANK depth instead made every
            // hillside-hugging at-grade stretch carve like a cutting: the bed
            // edge sat at grade but the slope 2 m out was "8 m deep", so a
            // 12 m collar band smeared along entire quay-side cliffs (Rijeka
            // Pećine). The hill beside an at-grade line is scenery, not spoil.
            const edgeDepthM = (rawAtBoundary === null ? terrainY : rawAtBoundary) - roadY;
            let reachM = cutBenchReachMeters(edgeDepthM, capFactor);
            let requestedReachM = finiteOrNull(inner.minimumCutBenchReachM);
            if (requestedReachM === null && typeof minimumCutBenchReachAtLocal === 'function') {
                requestedReachM = finiteOrNull(minimumCutBenchReachAtLocal(inner.x, inner.z));
            }
            if (requestedReachM !== null) reachM = Math.max(reachM, requestedReachM);
            let benchMarch = setback;
            let benchTerrainY = terrainY;
            for (let march = setback; march <= reachM / dirLen; march += stepMarch) {
                const marchX = inner.x + direction.x * march;
                const marchZ = inner.z + direction.z * march;
                // Unknown ground stops the bench march: it cannot daylight to
                // grade against a height nobody measured.
                const marchY = finiteOrNull(baseSceneYAtLocal(marchX, marchZ));
                if (marchY === null) break;
                benchMarch = march;
                benchTerrainY = marchY;
                if (marchY <= roadY + CUT_BENCH_DAYLIGHT_TOL_M) break; // reached grade → bench edge
            }
            setback = benchMarch;
            outerX = inner.x + direction.x * setback;
            outerZ = inner.z + direction.z * setback;
            terrainY = benchTerrainY;
        }
        let retainedBoundary = null;
        if (verticalRetainedWalls
            && typeof retainedWallBoundaryAtLocal === 'function') {
            const candidate = retainedWallBoundaryAtLocal(outerX, outerZ, {
                innerX: inner.x,
                innerZ: inner.z,
                roadY,
                directionX: direction.x,
                directionZ: direction.z,
            });
            const candidateX = finiteOrNull(candidate?.x);
            const candidateZ = finiteOrNull(candidate?.z);
            if (candidateX !== null && candidateZ !== null) {
                outerX = candidateX;
                outerZ = candidateZ;
                const retainedBaseY = finiteOrNull(candidate?.retainedBaseY);
                if (retainedBaseY !== null) {
                    terrainY = retainedBaseY;
                } else {
                    const snappedTerrainY = finiteOrNull(
                        baseSceneYAtLocal(outerX, outerZ),
                    );
                    if (snappedTerrainY !== null) terrainY = snappedTerrainY;
                }
                retainedBoundary = candidate;
            }
        }
        const overlapX = outerX + direction.x * TERRAIN_SEAM_OVERLAP_M;
        const overlapZ = outerZ + direction.z * TERRAIN_SEAM_OVERLAP_M;
        const sampledOverlapY = finiteOrNull(baseSceneYAtLocal(overlapX, overlapZ));
        const outerTerrainReplacement =
            baseTerrainReplacementAtLocal?.(outerX, outerZ) === true;
        const overlapTerrainReplacement =
            baseTerrainReplacementAtLocal?.(overlapX, overlapZ) === true;
        // The terrain/water mask stops at the civil toe. Sample that exact line
        // independently because a shared retained boundary can prescribe a toe
        // height that differs from the untouched terrain meeting it.
        const cutoutX = outerX + direction.x * TERRAIN_SEAM_OVERLAP_M * TERRAIN_CUTOUT_WITHIN_COLLAR_T;
        const cutoutZ = outerZ + direction.z * TERRAIN_SEAM_OVERLAP_M * TERRAIN_CUTOUT_WITHIN_COLLAR_T;
        const sampledCutoutY = finiteOrNull(baseSceneYAtLocal(cutoutX, cutoutZ));
        points.push({
            innerX: inner.x,
            innerZ: inner.z,
            roadY,
            surfaceApronWidthM: Math.max(0,
                finiteOrNull(inner.surfaceApronWidthM) ?? defaultSurfaceApronWidthM),
            // Preserve the supplied terrain reading at the civil edge. It is
            // useful to downstream ownership checks and, unlike terrainY,
            // cannot be confused with the sampled toe several metres away.
            innerTerrainY: rawAtBoundary === null ? roadY : rawAtBoundary,
            outerX,
            outerZ,
            terrainY,
            // The zero-width sealing skirt is hidden below the sampled toe.
            // Extending it uphill exposed a grey ribbon above cut slopes.
            wallTerrainY: terrainY - WALL_VERTICAL_OVERLAP_M,
            cutoutX,
            cutoutZ,
            cutoutTerrainY: Number.isFinite(sampledCutoutY) ? sampledCutoutY : terrainY,
            overlapX,
            overlapZ,
            overlapTerrainY: Number.isFinite(sampledOverlapY) ? sampledOverlapY : terrainY,
            outerTerrainReplacement,
            overlapTerrainReplacement,
            ...(retainedBoundary?.sharedRailRetainingBoundary === true ? {
                sharedRailRetainingBoundary: true,
                railFormationId: retainedBoundary.railFormationId || null,
                railBoundarySide: retainedBoundary.railBoundarySide || null,
                railSegmentIndex: finiteOrNull(retainedBoundary.railSegmentIndex),
            } : {}),
        });
        if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
            yield { phase: 'points', count: index + 1 };
            sliceStartedAt = formationBuildNowMs();
        }
    }
    const resolvedInnerRing = [];
    const outerRing = [];
    const overlapRing = [];
    const terrainCutoutRing = [];
    const sharedRailBoundarySegments = [];
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const next = points[(index + 1) % points.length];
        resolvedInnerRing.push({ x: point.innerX, z: point.innerZ });
        outerRing.push({ x: point.outerX, z: point.outerZ });
        overlapRing.push({ x: point.overlapX, z: point.overlapZ });
        terrainCutoutRing.push({ x: point.cutoutX, z: point.cutoutZ });
        sharedRailBoundarySegments.push(
            point?.sharedRailRetainingBoundary === true
                && next?.sharedRailRetainingBoundary === true
                && point.railFormationId === next.railFormationId
                && point.railBoundarySide === next.railBoundarySide,
        );
        if (formationBuildNowMs() - sliceStartedAt >= FORMATION_PROFILE_SLICE_MS) {
            yield { phase: 'finalize', count: index + 1 };
            sliceStartedAt = formationBuildNowMs();
        }
    }
    // The visible civil face and the terrain cut both end at outerRing. The
    // terrain-coloured collar continues to overlapRing on top of kept terrain.
    // Keeping the mask out of that overlap prevents interpolation differences
    // between the independently triangulated surfaces from opening sky slots.
    // internalSegments marks segments whose wall + collar are suppressed (both
    // builders skip them). Junction-overlap suppression is added later by the
    // road model; here we seed it with the requested open cross-caps so a
    // tunnel-abutting formation end is left open rather than walled shut.
    const internalSegments = new Array(points.length).fill(false);
    if (wantsCapTags && segmentTags) {
        for (let index = 0; index < internalSegments.length; index++) {
            const tag = segmentTags[index];
            if ((tag === 'start' && openCapStart) || (tag === 'end' && openCapEnd)) {
                internalSegments[index] = true;
            }
        }
    }
    // At a shared road/rail wall the road owns the vertical face and the rail
    // owns the lower cess on its air side. The road must therefore stop its
    // terrain collar exactly at the wall plane. Letting that collar continue
    // into the rail corridor creates a second sloping owner over the cess and,
    // at a portal endpoint, a tall diagonal wedge between floor and roof.
    const safelyBelowRoad = point => (
        Number.isFinite(point?.roadY)
        && [point.terrainY, point.cutoutTerrainY, point.overlapTerrainY]
            .every(value => (
                Number.isFinite(value)
                && value < point.roadY - AT_GRADE_DRESSING_MAX_DELTA_M
            ))
    );
    // On a fill, the retained earth face already joins the paved edge to the
    // replacement surface. Suppress only longitudinal collar segments whose
    // two endpoints are safely below the road and touch that opaque backstop;
    // cuts and at-grade seams retain the ordinary collar contract.
    const terrainReplacementBackstopSegments = points.map((point, index) => {
        const next = points[(index + 1) % points.length];
        const touchesReplacement = point.outerTerrainReplacement
            || point.overlapTerrainReplacement
            || next.outerTerrainReplacement
            || next.overlapTerrainReplacement;
        return touchesReplacement && safelyBelowRoad(point) && safelyBelowRoad(next);
    });
    return {
        ...metadata,
        verticalRetainedWalls: !!verticalRetainedWalls,
        wallTopUnderlapM: Math.max(0, Number(wallTopUnderlapM) || 0),
        points,
        innerRing: resolvedInnerRing,
        outerRing,
        overlapRing,
        terrainCutoutRing,
        bounds: ringBounds(resolvedInnerRing),
        outerBounds: ringBounds(outerRing),
        overlapBounds: ringBounds(overlapRing),
        terrainCutoutBounds: ringBounds(terrainCutoutRing),
        internalSegments,
        roadOpeningSegmentRanges: Array.from(
            { length: points.length },
            () => [],
        ),
        sharedRetainingWallSegments: new Array(points.length).fill(false),
        sharedRailBoundarySegments,
        terrainReplacementBackstopSegments,
        boundarySegmentTags: segmentTags,
        // Collar-only suppression: the collar band reaches TERRAIN_SEAM_OVERLAP_M
        // past the wall band, so it can cross a neighbouring carriageway whose
        // surface the wall test never sees. Filled by the road model's overlap
        // recheck; starts as a copy of the cap-seeded wall flags.
        collarInternalSegments: internalSegments.map((suppressed, index) => (
            suppressed || sharedRailBoundarySegments[index]
        )),
    };
}

// Adjacent OSM road polygons can overlap slightly at a shared topology node.
// When both are snapped to one reviewed rail wall, that overlap becomes two
// coplanar concrete faces. Suppress only a segment whose complete endpoints
// and midpoint are covered by a longer (or deterministically preferred equal)
// segment on the same physical rail boundary. Partial coverage is never
// enough: opening a real wall gap is worse than retaining a tiny overlap.
export function* sharedRetainingWallSuppressionSteps(
    profiles,
    { maxSeparationM = 0.08 } = {},
) {
    const segments = [];
    const segmentsByInterface = new Map();
    for (const profile of profiles || []) {
        const points = Array.isArray(profile?.points) ? profile.points : [];
        if (!profile?.verticalRetainedWalls || points.length < 2) continue;
        if (!Array.isArray(profile.sharedRetainingWallSegments)
            || profile.sharedRetainingWallSegments.length !== points.length) {
            profile.sharedRetainingWallSegments = new Array(points.length).fill(false);
        }
        yield;
        for (let index = 0; index < points.length; index++) {
            yield;
            if (profile.sharedRailBoundarySegments?.[index] !== true
                || profile.internalSegments?.[index] === true) continue;
            const a = points[index];
            const b = points[(index + 1) % points.length];
            const lengthM = Math.hypot(b.outerX - a.outerX, b.outerZ - a.outerZ);
            if (!(lengthM > 1e-6)) continue;
            const segment = {
                profile,
                index,
                a: { x: a.outerX, z: a.outerZ },
                b: { x: b.outerX, z: b.outerZ },
                lengthM,
                railFormationId: a.railFormationId || null,
                railBoundarySide: a.railBoundarySide || null,
                key: `${String(profile.osmId ?? '')}:${index}`,
            };
            segments.push(segment);
            let sides = segmentsByInterface.get(segment.railFormationId);
            if (!sides) segmentsByInterface.set(segment.railFormationId, sides = new Map());
            let siblings = sides.get(segment.railBoundarySide);
            if (!siblings) sides.set(segment.railBoundarySide, siblings = []);
            siblings.push(segment);
        }
    }
    const maxDistanceSquared = Math.max(0, Number(maxSeparationM) || 0) ** 2;
    let suppressed = 0;
    for (const segment of segments) {
        const midpoint = {
            x: (segment.a.x + segment.b.x) * 0.5,
            z: (segment.a.z + segment.b.z) * 0.5,
        };
        let coveredBy = false;
        const siblings = segmentsByInterface.get(segment.railFormationId).get(segment.railBoundarySide);
        for (const candidate of siblings) {
            yield;
            if (candidate.profile === segment.profile
                || candidate.railFormationId !== segment.railFormationId
                || candidate.railBoundarySide !== segment.railBoundarySide) continue;
            const longer = candidate.lengthM > segment.lengthM + 1e-6;
            const preferredTie = Math.abs(candidate.lengthM - segment.lengthM) <= 1e-6
                && candidate.key < segment.key;
            if (!longer && !preferredTie) continue;
            coveredBy = [segment.a, midpoint, segment.b].every(point => (
                (projectPointToSegment(point.x, point.z, {
                    x1: candidate.a.x,
                    z1: candidate.a.z,
                    x2: candidate.b.x,
                    z2: candidate.b.z,
                })?.distanceSquared ?? Infinity) <= maxDistanceSquared
            ));
            if (coveredBy) break;
        }
        if (!coveredBy || segment.profile.sharedRetainingWallSegments[segment.index]) {
            continue;
        }
        segment.profile.sharedRetainingWallSegments[segment.index] = true;
        suppressed += 1;
    }
    return suppressed;
}

export function suppressDuplicateSharedRetainingWallSegments(profiles, options) {
    const iterator = sharedRetainingWallSuppressionSteps(profiles, options);
    let result = iterator.next();
    while (!result.done) result = iterator.next();
    return result.value;
}

// Candidate preparation temporarily installs only these explicit input
// callbacks during a synchronous step; published readers retain the previous
// callbacks until the completed indexes and inputs are promoted together.
const FORMATION_INPUT_CALLBACKS = Object.freeze([
    'baseSceneYAtLocal', 'baseTerrainReplacementAtLocal', 'terrainEvidenceSceneYAtLocal',
    'sourceTerrainInputSceneYAtLocal', 'sourceTerrainOwnsInputAtLocal',
    'roadYOverrideAtLocal', 'roadStructureAtLocal', 'roadReplacementAtLocal',
    'replacementTerrainCutoutRegions', 'formationStyleForOsmId',
    'retainedWallBoundaryForOsmIdAtLocal',
]);

export class RoadFormationModel {
    constructor({
        anchorLat,
        anchorLon,
        baseSceneYAtLocal,
        baseTerrainReplacementAtLocal = null,
        terrainEvidenceSceneYAtLocal = null,
        sourceTerrainInputSceneYAtLocal = null,
        sourceTerrainOwnsInputAtLocal = null,
        roadYOverrideAtLocal = null,
        roadStructureAtLocal = null,
        roadReplacementAtLocal = null,
        replacementTerrainCutoutRegions = null,
        formationStyleForOsmId = null,
        retainedWallBoundaryForOsmIdAtLocal = null,
        featureIdentities = createRoadFeatureIdentityIndex(),
        captureBuildInputsSteps = null,
    }) {
        if (captureBuildInputsSteps != null && typeof captureBuildInputsSteps !== 'function') {
            throw new TypeError('Road formation input capture must be a generator factory');
        }
        this.captureBuildInputsSteps = captureBuildInputsSteps;
        this._publishedBuildInputs = null;
        this._disposed = false;
        this.anchorLat = Number(anchorLat);
        this.anchorLon = Number(anchorLon);
        this.baseSceneYAtLocal = typeof baseSceneYAtLocal === 'function'
            ? baseSceneYAtLocal
            : (() => 0);
        this.baseTerrainReplacementAtLocal =
            typeof baseTerrainReplacementAtLocal === 'function'
                ? baseTerrainReplacementAtLocal
                : (() => false);
        this.terrainEvidenceSceneYAtLocal = typeof terrainEvidenceSceneYAtLocal === 'function'
            ? terrainEvidenceSceneYAtLocal
            : this.baseSceneYAtLocal;
        this.sourceTerrainInputSceneYAtLocal =
            typeof sourceTerrainInputSceneYAtLocal === 'function'
                ? sourceTerrainInputSceneYAtLocal
                : this.baseSceneYAtLocal;
        this.sourceTerrainOwnsInputAtLocal =
            typeof sourceTerrainOwnsInputAtLocal === 'function'
                ? sourceTerrainOwnsInputAtLocal
                : (() => true);
        this.roadYOverrideAtLocal = typeof roadYOverrideAtLocal === 'function'
            ? roadYOverrideAtLocal
            : null;
        this.roadStructureAtLocal = typeof roadStructureAtLocal === 'function'
            ? roadStructureAtLocal
            : null;
        this.roadReplacementAtLocal = typeof roadReplacementAtLocal === 'function'
            ? roadReplacementAtLocal
            : null;
        this.replacementTerrainCutoutRegions =
            typeof replacementTerrainCutoutRegions === 'function'
                ? replacementTerrainCutoutRegions
                : null;
        this.formationStyleForOsmId = typeof formationStyleForOsmId === 'function'
            ? formationStyleForOsmId
            : null;
        this.retainedWallBoundaryForOsmIdAtLocal =
            typeof retainedWallBoundaryForOsmIdAtLocal === 'function'
                ? retainedWallBoundaryForOsmIdAtLocal
                : null;
        this._requiredCapturedInputs = FORMATION_INPUT_CALLBACKS.filter(name => this[name] != null);
        this.metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
        this.metresPerDegreeLon = this.metresPerDegreeLat
            * Math.cos(this.anchorLat * DEG_TO_RAD);
        this.centerlineTiles = new Map();
        this.surfaceTiles = new Map();
        this._centerlineSources = formationSourceState(featureIdentities);
        this._surfaceSources = formationSourceState(featureIdentities);
        this._featureIdentities = featureIdentities;
        this.revision = 0;
        // A formation profile may be needed to BUILD its visible road before
        // that road is allowed to own civil ground or remove terrain. Proposal
        // roads use this independent publication revision so revealing one
        // overlay batch refreshes the ownership mask without pretending the
        // underlying streamed road geometry changed (which would fan out a
        // city-wide formation rebuild and every ordinary road consumer).
        this.surfacePublicationRevision = 0;
        this._surfacePublicationChanges = [];
        this._surfacePublicationReadyByOsmId = new Map();
        this._dirty = true;
        this._segmentsByOsmId = new Map();
        this._segmentIndex = new Map();
        // Same grid as _segmentIndex but keyed by road as well, so a query that
        // already knows its osm_id can reach its own nearby segments without
        // walking every segment the road has. See _nearestOnOwnSegments.
        this._ownSegmentIndex = new Map();
        this._surfaceIndex = new Map();
        this._civilGroundProfileIndex = new Map();
        this._civilGroundProfileChecks = 0;
        this._profiles = [];
        this._formationChanges = [];
        this.surfaceGeometryRevision = 0;
        this.surfaceGeometrySourceRevision = 0;
        this._surfaceGeometryVersions = new Map();
        this._surfaceGeometryChanges = [];
        // Retain expensive projected/smoothed forms across exact duplicate
        // arrivals. Source replacement and terrain revisions invalidate their
        // actual dependencies; an unchanged OSM id is not immutable geometry.
        this._centerlineGeometryCache = new Map();
        this._roadGradeCache = new Map();
        this._topologyNodeHeightCache = new Map();
        this._segmentCache = new Map();
        this._profileCache = new Map();
        this._terrainEvidenceRevision = 0;
        this._pendingBuildPreparation = null;
        this._publicationOwner = null;
        this._publicationManaged = false;
        this._recentMutations = [];
    }

    toLocal(lon, lat) {
        return {
            x: (Number(lon) - this.anchorLon) * this.metresPerDegreeLon,
            z: -(Number(lat) - this.anchorLat) * this.metresPerDegreeLat,
        };
    }

    _changedFeatureBounds(changedIds, ...featureLists) {
        const bounds = [];
        for (const features of featureLists) {
            for (const feature of Array.isArray(features) ? features : []) {
                const osmId = numericId(feature?.properties?.osm_id);
                if (osmId == null || !changedIds.has(osmId)) continue;
                let minX = Infinity;
                let minZ = Infinity;
                let maxX = -Infinity;
                let maxZ = -Infinity;
                const visit = (coordinates) => {
                    if (!Array.isArray(coordinates)) return;
                    if (coordinates.length >= 2
                        && finiteOrNull(coordinates[0]) !== null
                        && finiteOrNull(coordinates[1]) !== null) {
                        const local = this.toLocal(coordinates[0], coordinates[1]);
                        minX = Math.min(minX, local.x);
                        minZ = Math.min(minZ, local.z);
                        maxX = Math.max(maxX, local.x);
                        maxZ = Math.max(maxZ, local.z);
                        return;
                    }
                    for (const child of coordinates) visit(child);
                };
                visit(feature?.geometry?.coordinates);
                if (Number.isFinite(minX)) bounds.push({ minX, minZ, maxX, maxZ });
            }
        }
        return bounds;
    }

    _setSourceTile(tileKey, features, surface, remove = false) {
        const key = String(tileKey);
        const tiles = surface ? this.surfaceTiles : this.centerlineTiles;
        const sources = surface ? this._surfaceSources : this._centerlineSources;
        const nextFeatures = Array.isArray(features) ? features : [];
        const { changedIds, changes } = updateFormationSources(sources, key, nextFeatures, surface);
        if (remove) tiles.delete(key);
        else tiles.set(key, nextFeatures);
        const previous = changes.flatMap(change => change.previous ? [change.previous.feature] : []);
        const next = changes.flatMap(change => change.next ? [change.next.feature] : []);
        const bounds = this._changedFeatureBounds(changedIds, previous, next);
        const pairedIds = surface ? new Set([...previous, ...next]
            .filter(feature => surfaceCenterlineFeature(feature))
            .map(feature => numericId(feature.properties.osm_id))) : null;
        for (const osmId of changedIds) {
            this._profileCache.delete(osmId);
            if (surface && !pairedIds.has(osmId)) continue;
            // Changed source coordinates cannot reuse projected segments,
            // smoothing or cached shared-node evidence from the old axis.
            for (const nodeKey of this._centerlineGeometryCache.get(osmId)?.pointKeys || []) {
                this._topologyNodeHeightCache.delete(nodeKey);
            }
            for (const point of sources.features.get(osmId)?.geometry.coordinates || []) {
                if (finitePoint(point)) this._topologyNodeHeightCache.delete(topologyNodeKey(this.toLocal(...point)));
            }
            this._centerlineGeometryCache.delete(osmId);
            this._roadGradeCache.delete(osmId);
            this._segmentCache.delete(osmId);
        }
        if (changedIds.size) this._markDirty(bounds, {
            kind: remove
                ? (surface ? 'remove-surface-tile' : 'remove-centerline-tile')
                : (surface ? 'set-surface-tile' : 'set-centerline-tile'),
            tileKey: key,
            changedIds: changedIds.size,
        });
        return { changed: changedIds.size > 0, osmIds: [...changedIds], bounds, revision: this.revision };
    }

    setCenterlineTile(tileKey, features) { return this._setSourceTile(tileKey, features, false); }
    setSurfaceTile(tileKey, features) { return this._setSourceTile(tileKey, features, true); }
    removeCenterlineTile(tileKey) { return this._setSourceTile(tileKey, [], false, true); }
    removeSurfaceTile(tileKey) { return this._setSourceTile(tileKey, [], true, true); }

    // Defaults to ready so ordinary streamed OSM roads retain their existing
    // behaviour. A staged owner can opt specific ids out before registering
    // their geometry, build complete visible surfaces from the still-queryable
    // grade profiles, then atomically opt only the successfully published ids
    // back in. This changes cutout/civil-ground publication only; it must not
    // dirty or rebuild the formation geometry itself.
    setSurfacePublicationReadyForOsmIds(osmIds, ready = true) {
        const nextReady = ready !== false;
        const ids = new Set((Array.isArray(osmIds) ? osmIds : [osmIds])
            .map(numericId)
            .filter(id => id != null));
        const changedIds = new Set();
        for (const osmId of ids) {
            const currentReady = this._surfacePublicationReadyByOsmId.get(osmId) !== false;
            if (currentReady === nextReady) continue;
            if (nextReady) this._surfacePublicationReadyByOsmId.delete(osmId);
            else this._surfacePublicationReadyByOsmId.set(osmId, false);
            changedIds.add(osmId);
        }
        if (changedIds.size === 0) return false;

        const bounds = this._profiles.filter(profile => changedIds.has(numericId(profile.osmId)))
            .map(profile => ({ ...formationDependencyBounds(profile) }));

        const updateProfiles = (profiles) => {
            for (const profile of Array.isArray(profiles) ? profiles : []) {
                if (!changedIds.has(numericId(profile?.osmId))) continue;
                profile.surfacePublicationReady = nextReady;
            }
        };
        updateProfiles(this._profiles);
        for (const osmId of changedIds) updateProfiles(this._profileCache.get(osmId));
        const pending = this._pendingBuildPreparation;
        updateProfiles(pending?.profiles);
        updateProfiles(pending?.profilesToRecheck);
        updateProfiles(pending?.activeSurface?.profiles);
        for (const profiles of pending?.profileCacheOverrides?.values?.() || []) {
            updateProfiles(profiles);
        }
        this.surfacePublicationRevision += 1;
        this._surfacePublicationChanges.push({ revision: this.surfacePublicationRevision, bounds });
        if (this._surfacePublicationChanges.length > FORMATION_CHANGE_HISTORY_LIMIT) this._surfacePublicationChanges.shift();
        return true;
    }

    getSurfacePublicationChangesSince(revision) {
        if (revision === this.surfacePublicationRevision) return { full: false, bounds: [] };
        const changes = this._surfacePublicationChanges.filter(change => change.revision > revision);
        const full = !Number.isInteger(revision) || revision < 0 || revision > this.surfacePublicationRevision
            || changes[0]?.revision !== revision + 1;
        return { full, bounds: full ? [] : changes.flatMap(change => change.bounds) };
    }

    clear() {
        const hadActiveFeatures = this._centerlineSources.features.size > 0
            || this._surfaceSources.features.size > 0;
        this.centerlineTiles.clear();
        this.surfaceTiles.clear();
        for (const state of [this._centerlineSources, this._surfaceSources]) {
            state.index.clear();
            state.records.clear();
            state.features.clear();
        }
        if (hadActiveFeatures) this._markDirty(null, { kind: 'clear' });
    }

    dispose() {
        if (this._disposed) return false;
        this._publicationOwner?.cancel?.();
        this._discardBuildInputs(this._pendingBuildPreparation);
        this._publishedBuildInputs?.release?.();
        this._publishedBuildInputs = null;
        this._disposed = true;
        return true;
    }

    _discardBuildInputs(task) {
        task?.inputIterator?.return?.();
        task?.publicationIterator?.return?.();
        if (task && !task.published && !task.inputsReleased) {
            task.inputs?.release?.();
            task.inputsReleased = true;
        }
        if (this._pendingBuildPreparation === task) this._pendingBuildPreparation = null;
    }

    invalidateVerticalAlignments(bounds = null) {
        if (Array.isArray(bounds) && bounds.length > 0) {
            // A streamed alignment changes its own road and contacting civil
            // geometry. Clearing every profile here also advances every road's
            // geometry generation, turning one local arrival into a complete
            // receiver rebuild. Junction preparation expands the affected
            // profiles to their physical neighbours after this invalidation.
            for (const [osmId, profiles] of this._profileCache) {
                const centerlineBounds = this._centerlineGeometryCache.get(osmId)?.bounds;
                if (bounds.some(change => boundsOverlap(centerlineBounds, change)
                    || profiles.some(profile => boundsOverlap(formationDependencyBounds(profile), change)))) {
                    this._profileCache.delete(osmId);
                }
            }
        } else {
            this._profileCache.clear();
        }
        this._markDirty(Array.isArray(bounds) ? bounds : null, { kind: 'invalidate-vertical-alignments' });
    }

    _invalidateTerrainCachesWithin(changedBounds) {
        const directlyAffectedOsmIds = new Set();
        const overlapsChange = candidate => changedBounds.some(
            changed => boundsOverlap(candidate, changed),
        );
        for (const [osmId, data] of this._centerlineGeometryCache.entries()) {
            if (overlapsChange(data?.bounds)) directlyAffectedOsmIds.add(osmId);
        }
        for (const [osmId, profiles] of this._profileCache.entries()) {
            if ((profiles || []).some(profile => overlapsChange(
                profile?.overlapBounds
                || profile?.terrainCutoutBounds
                || profile?.outerBounds
                || profile?.bounds,
            ))) directlyAffectedOsmIds.add(osmId);
        }
        if (directlyAffectedOsmIds.size === 0) return directlyAffectedOsmIds;

        // A changed shared topology node also changes the cheap linear grade
        // correction on each incident way. Keep those immediate neighbours in
        // the rebuild without spreading invalidation across the road graph.
        const affectedOsmIds = new Set(directlyAffectedOsmIds);
        const affectedNodeKeys = new Set();
        for (const osmId of directlyAffectedOsmIds) {
            for (const key of this._centerlineGeometryCache.get(osmId)?.pointKeys || []) {
                affectedNodeKeys.add(key);
            }
        }
        for (const [osmId, data] of this._centerlineGeometryCache.entries()) {
            if (affectedOsmIds.has(osmId)) continue;
            if ((data?.pointKeys || []).some(key => affectedNodeKeys.has(key))) {
                affectedOsmIds.add(osmId);
            }
        }

        for (const osmId of affectedOsmIds) {
            const data = this._centerlineGeometryCache.get(osmId);
            for (const key of data?.pointKeys || []) {
                this._topologyNodeHeightCache.delete(key);
            }
            if (!directlyAffectedOsmIds.has(osmId)) continue;
            // The global revision remains stable for a bounded update. Mark
            // only the intersecting immutable XZ record stale so pass 1
            // resamples its terrain evidence on the next build.
            if (data) data.terrainEvidenceRevision = -1;
            this._roadGradeCache.delete(osmId);
            this._profileCache.delete(osmId);
        }
        return affectedOsmIds;
    }

    // The moving DGU window changes the height function without changing any
    // OSM feature identity. A bounded revision must not evict an entire city's
    // terrain-derived road profiles: the first curb query would otherwise pay
    // for their synchronous reconstruction. Projected XZ segments are safe to
    // retain in both paths because _ensureBuilt reattaches their solved grade.
    invalidateTerrain(bounds = null) {
        const changedBounds = (Array.isArray(bounds) ? bounds : []).filter(entry => (
            entry
            && [entry.minX, entry.minZ, entry.maxX, entry.maxZ].every(Number.isFinite)
        ));
        if (changedBounds.length > 0) {
            const affectedOsmIds = this._invalidateTerrainCachesWithin(changedBounds);
            if (affectedOsmIds.size > 0) this._markDirty(changedBounds, {
                kind: 'invalidate-terrain', affectedOsmIds: affectedOsmIds.size,
            });
            return affectedOsmIds;
        }
        this._terrainEvidenceRevision += 1;
        this._roadGradeCache.clear();
        this._topologyNodeHeightCache.clear();
        this._profileCache.clear();
        this._markDirty(null, { kind: 'invalidate-terrain-full' });
        return new Set(this._centerlineGeometryCache.keys());
    }

    invalidateTerrainEvidence(bounds = null) {
        this._terrainEvidenceRevision += 1;
        this._roadGradeCache.clear();
        this._topologyNodeHeightCache.clear();
        this._profileCache.clear();
        this._markDirty(Array.isArray(bounds) ? bounds : null, { kind: 'invalidate-terrain-evidence' });
    }

    // Rail is a composed ground layer, not a new terrain dataset. A streamed
    // rail update therefore cannot advance the global DGU revision: doing so
    // evicts every loaded road and makes the first car/walker ground query pay
    // for a synchronous whole-world rebuild. Evict only ways whose solved axis
    // or already-built civil envelope overlaps the changed rail footprint.
    *invalidateComposedGroundSteps(bounds = null, { scanPerStep = 64 } = {}) {
        const changedBounds = (Array.isArray(bounds) ? bounds : []).filter(entry => (
            entry
            && [entry.minX, entry.minZ, entry.maxX, entry.maxZ].every(Number.isFinite)
        ));
        if (changedBounds.length === 0) return new Set();

        const stepLimit = Math.max(1, Math.floor(Number(scanPerStep) || 1));
        const affectedOsmIds = new Set();
        const overlapsChange = candidate => changedBounds.some(
            changed => boundsOverlap(candidate, changed),
        );
        let scanned = 0;
        for (const [osmId, data] of this._centerlineGeometryCache.entries()) {
            if (overlapsChange(data?.bounds)) affectedOsmIds.add(osmId);
            scanned += 1;
            if (scanned >= stepLimit) {
                scanned = 0;
                yield { phase: 'centerlines' };
            }
        }
        for (const [osmId, profiles] of this._profileCache.entries()) {
            if ((profiles || []).some(profile => overlapsChange(
                profile?.overlapBounds
                || profile?.terrainCutoutBounds
                || profile?.outerBounds
                || profile?.bounds,
            ))) affectedOsmIds.add(osmId);
            scanned += 1;
            if (scanned >= stepLimit) {
                scanned = 0;
                yield { phase: 'profiles' };
            }
        }
        if (affectedOsmIds.size === 0) return affectedOsmIds;
        const directlyAffectedOsmIds = new Set(affectedOsmIds);

        // Every incident way must consume the same freshly sampled shared-node
        // height. Include direct neighbours of the affected ways without
        // spreading the invalidation through the rest of the road graph.
        const affectedNodeKeys = new Set();
        for (const osmId of affectedOsmIds) {
            for (const key of this._centerlineGeometryCache.get(osmId)?.pointKeys || []) {
                affectedNodeKeys.add(key);
            }
            scanned += 1;
            if (scanned >= stepLimit) {
                scanned = 0;
                yield { phase: 'nodes' };
            }
        }
        for (const [osmId, data] of this._centerlineGeometryCache.entries()) {
            if (!affectedOsmIds.has(osmId)
                && (data?.pointKeys || []).some(key => affectedNodeKeys.has(key))) {
                affectedOsmIds.add(osmId);
            }
            scanned += 1;
            if (scanned >= stepLimit) {
                scanned = 0;
                yield { phase: 'neighbours' };
            }
        }

        // Discovery above is read-only across resumable steps. Commit cache
        // mutation together, then advance the public revision once, so no
        // query can observe a half-invalidated generation.
        for (const osmId of affectedOsmIds) {
            const data = this._centerlineGeometryCache.get(osmId);
            if (data) {
                // Keep the immutable projected XZ geometry. A mismatched local
                // evidence revision makes pass 1 recompute only a way that
                // physically crosses the changed ground. Incident neighbours
                // retain their base terrain samples and re-anchor only their
                // grade at the freshly sampled shared topology node.
                if (directlyAffectedOsmIds.has(osmId)) {
                    data.terrainEvidenceRevision = -1;
                }
                for (const key of data.pointKeys || []) {
                    this._topologyNodeHeightCache.delete(key);
                }
            }
            if (directlyAffectedOsmIds.has(osmId)) {
                this._roadGradeCache.delete(osmId);
                this._profileCache.delete(osmId);
            }
        }
        // Segment XZ is immutable and remains cached; _ensureBuilt reattaches
        // each retained segment to its newly solved vertical profile.
        this._markDirty(changedBounds, {
            kind: 'invalidate-composed-ground', affectedOsmIds: affectedOsmIds.size,
        });
        return affectedOsmIds;
    }

    invalidateComposedGround(bounds = null) {
        const task = this.invalidateComposedGroundSteps(bounds);
        let outcome = task.next();
        while (!outcome.done) outcome = task.next();
        return outcome.value;
    }

    _markDirty(bounds = null, mutation = null) {
        this.revision += 1;
        this._recentMutations.push(Object.freeze({
            revision: this.revision,
            ...(mutation || { kind: 'unknown' }),
            bounds: Array.isArray(bounds) ? bounds.length : null,
        }));
        if (this._recentMutations.length > 8) this._recentMutations.shift();
        this._dirty = true;
        // A coordinator-owned prepared publication retains its immutable read
        // graph until that owner observes the revision mismatch and discards
        // it. Releasing it here turns ordinary supersession into a downstream
        // `read-snapshot-released` exception before atomic validation can fail
        // cleanly. Background preparations still have no owner and can be
        // discarded immediately.
        if (!this._publicationOwner) this._discardBuildInputs(this._pendingBuildPreparation);
        this._formationChanges.push({
            revision: this.revision,
            bounds: Array.isArray(bounds) ? bounds.map(entry => ({ ...entry })) : null,
        });
        if (this._formationChanges.length > FORMATION_CHANGE_HISTORY_LIMIT) {
            this._formationChanges.splice(
                0,
                this._formationChanges.length - FORMATION_CHANGE_HISTORY_LIMIT,
            );
        }
    }

    recentMutations() { return this._recentMutations.map(entry => ({ ...entry })); }

    getChangesSince(revision) {
        const since = Number(revision);
        if (!Number.isInteger(since) || since < 0 || since > this.revision) {
            return { revision: this.revision, full: true, bounds: [] };
        }
        if (since === this.revision) {
            return { revision: this.revision, full: false, bounds: [] };
        }
        const changes = this._formationChanges.filter(change => change.revision > since);
        if (changes.length === 0 || changes[0].revision !== since + 1) {
            return { revision: this.revision, full: true, bounds: [] };
        }
        if (changes.some(change => change.bounds == null)) {
            return { revision: this.revision, full: true, bounds: [] };
        }
        return {
            revision: this.revision,
            full: false,
            bounds: changes.flatMap(change => change.bounds.map(entry => ({ ...entry }))),
        };
    }

    // This revision advances when the complete profile geometry publishes,
    // including changed neighbour collars. Source revision alone advances too
    // early and cannot tell a renderer which cached owner needs replacement.
    getSurfaceGeometryGeneration(osmId) {
        return this._surfaceGeometryVersions.get(numericId(osmId)) || 0;
    }

    getSurfaceGeometryChangesSince(revision) {
        const changes = this._surfaceGeometryChanges.filter(change => change.revision > revision);
        const full = !Number.isInteger(revision) || revision < 0 || revision > this.surfaceGeometryRevision
            || (revision !== this.surfaceGeometryRevision && changes[0]?.revision !== revision + 1);
        return { revision: this.surfaceGeometryRevision, full,
            osmIds: full ? [...this._surfaceGeometryVersions.keys()] : [...new Set(changes.flatMap(change => change.osmIds))],
            bounds: full ? [] : changes.flatMap(change => change.bounds) };
    }

    *_prepareSurfacePublicationSteps(task) {
        let deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
        const byId = function* (rows) {
            const result = new Map();
            for (const profile of rows) {
                let parts = result.get(profile.osmId);
                if (!parts) result.set(profile.osmId, parts = []);
                parts.push(profile);
                if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
            }
            return result;
        };
        const previous = yield* byId(task.previousProfiles), next = yield* byId(task.profiles);
        yield;
        deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
        const ids = new Set();
        for (const map of [previous, next]) for (const id of map.keys()) {
            ids.add(id);
            if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
        }
        const osmIds = [], bounds = [];
        for (const osmId of ids) {
            const before = previous.get(osmId) || [], after = next.get(osmId) || [];
            if (before.length !== after.length || !before.every((profile, index) => profile === after[index])) {
                osmIds.push(osmId);
                for (const profiles of [before, after]) for (const profile of profiles) {
                    bounds.push({ ...formationDependencyBounds(profile) });
                    if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
                }
            }
            if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
        }
        let versions = this._surfaceGeometryVersions;
        let changes = this._surfaceGeometryChanges;
        let revision = this.surfaceGeometryRevision;
        if (osmIds.length) {
            revision++;
            versions = new Map();
            for (const [id, version] of this._surfaceGeometryVersions) {
                versions.set(id, version);
                if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
            }
            for (const id of osmIds) {
                if (next.has(id)) versions.set(id, revision);
                else versions.delete(id);
                if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
            }
            changes = [...changes.slice(-(FORMATION_CHANGE_HISTORY_LIMIT - 1)), { revision, osmIds, bounds }];
        }
        yield;
        deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
        const profileCache = new Map();
        for (const [id, profiles] of this._profileCache) {
            profileCache.set(id, task.profileCacheOverrides.get(id) || profiles);
            if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
        }
        for (const [id, profiles] of task.profileCacheOverrides) {
            profileCache.set(id, profiles);
            if (formationBuildNowMs() >= deadline) { yield; deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS; }
        }
        // No live table changed above. The following phase installs only
        // these prepared pointers; allocation or supersession keeps the old
        // complete indexes, versions and captured input callbacks together.
        return { profileCache, versions, changes, revision };
    }

    // Ground height, or NULL where terrain is not known — never 0. See
    // finiteOrNull in core/math.js for why the obvious guard is not enough.
    _baseY(x, z) {
        return finiteOrNull(this.baseSceneYAtLocal(x, z));
    }

    _terrainEvidenceY(x, z) {
        return finiteOrNull(this.terrainEvidenceSceneYAtLocal(x, z));
    }

    _sourceTerrainInputY(x, z) {
        return finiteOrNull(this.sourceTerrainInputSceneYAtLocal(x, z));
    }

    _sourceTerrainOwnsInput(x, z) {
        return this.sourceTerrainOwnsInputAtLocal(x, z) === true;
    }

    // A topology node is fixed to one deterministic local terrain estimate,
    // shared by every incident way. Symmetric probes preserve a planar hillside
    // exactly but soften a single DTM-cell kink, hence "somewhat fixed" rather
    // than blindly pinning the junction to one potentially noisy texel.
    _topologyNodeY(key, point) {
        if (this._topologyNodeHeightCache.has(key)) {
            return this._topologyNodeHeightCache.get(key);
        }
        const probes = [
            [0, 0, 4],
            [TOPOLOGY_NODE_PROBE_M, 0, 1],
            [-TOPOLOGY_NODE_PROBE_M, 0, 1],
            [0, TOPOLOGY_NODE_PROBE_M, 1],
            [0, -TOPOLOGY_NODE_PROBE_M, 1],
        ];
        let weightedY = 0;
        let weightSum = 0;
        for (const [dx, dz, weight] of probes) {
            const sampleY = this._terrainEvidenceY(point.x + dx, point.z + dz);
            if (sampleY === null) continue;
            weightedY += sampleY * weight;
            weightSum += weight;
        }
        const resolved = weightSum > 0 ? weightedY / weightSum : null;
        this._topologyNodeHeightCache.set(key, resolved);
        return resolved;
    }

    // Segments examined since the last reset. The cost of a formation query is
    // this number, so a test can pin the complexity instead of only the answer —
    // which is the difference between noticing and not noticing that an index
    // stopped being used.
    resetSegmentProjectionCount() {
        this._segmentProjections = 0;
    }

    getSegmentProjectionCount() {
        return this._segmentProjections || 0;
    }

    // Height is resolved ONCE, for the winner. It used to be resolved for every
    // candidate that improved on the running best — and because segments are
    // stored in order along the road, walking towards the query point improves
    // repeatedly, so a single query could take a dozen terrain samples and throw
    // all but the last away. The result is identical either way: only the final
    // best is ever returned.
    _nearestOnSegments(x, z, segments, maxDistanceM = Infinity, {
        tangentX = null,
        tangentZ = null,
        minDirectionCosine = SIDEWALK_PROFILE_MIN_DIRECTION_COSINE,
    } = EMPTY_QUERY_OPTIONS) {
        let bestSegment = null;
        let bestX = 0, bestZ = 0, bestT = 0;
        let bestDistanceSquared = maxDistanceM * maxDistanceM;
        const queryTangentX = finiteOrNull(tangentX);
        const queryTangentZ = finiteOrNull(tangentZ);
        const queryTangentLength = queryTangentX !== null && queryTangentZ !== null
            ? Math.hypot(queryTangentX, queryTangentZ)
            : null;
        const directional = queryTangentLength !== null && queryTangentLength > 1e-6;
        const requestedCosine = finiteOrNull(minDirectionCosine);
        const minimumCosine = Math.max(0, Math.min(1,
            requestedCosine ?? SIDEWALK_PROFILE_MIN_DIRECTION_COSINE));
        for (const segment of segments || []) {
            const segmentDx = segment.x2 - segment.x1;
            const segmentDz = segment.z2 - segment.z1;
            if (directional) {
                const segmentLength = Math.hypot(segmentDx, segmentDz);
                if (!(segmentLength > 1e-6)) continue;
                const directionCosine = Math.abs(
                    (segmentDx * queryTangentX + segmentDz * queryTangentZ)
                    / (segmentLength * queryTangentLength),
                );
                if (directionCosine + 1e-9 < minimumCosine) continue;
            }
            this._segmentProjections = (this._segmentProjections || 0) + 1;
            // Keep only the winning projection. Terrain/curb draping calls
            // this per vertex; allocating a result for every losing segment
            // creates garbage proportional to the entire candidate search.
            const lengthSquared = segmentDx * segmentDx + segmentDz * segmentDz;
            if (lengthSquared < 1e-9) continue;
            const t = Math.max(0, Math.min(1,
                ((x - segment.x1) * segmentDx + (z - segment.z1) * segmentDz) / lengthSquared));
            const projectedX = segment.x1 + segmentDx * t;
            const projectedZ = segment.z1 + segmentDz * t;
            const distanceSquared = (x - projectedX) ** 2 + (z - projectedZ) ** 2;
            if (distanceSquared > bestDistanceSquared) continue;
            bestDistanceSquared = distanceSquared;
            bestX = projectedX; bestZ = projectedZ; bestT = t;
            bestSegment = segment;
        }
        if (!bestSegment) return null;
        // Elevation is a function of centreline chainage only. Every point in a
        // cross-section therefore receives the same designed height; raw terrain
        // is evidence used while building the profile, never a per-vertex owner.
        let baseRoadY = roadProfileYAtSegment(bestSegment, bestT);
        if (!Number.isFinite(baseRoadY)) {
            baseRoadY = this._baseY(bestX, bestZ);
        }
        const overrideRoadY = this.roadYOverrideAtLocal?.(
            bestX,
            bestZ,
            bestSegment.osmId,
            baseRoadY,
        );
        const numericOverrideRoadY = overrideRoadY == null
            ? NaN
            : Number(overrideRoadY);
        return {
            x: bestX, z: bestZ, t: bestT, distanceSquared: bestDistanceSquared,
            tangentX: bestSegment.x2 - bestSegment.x1,
            tangentZ: bestSegment.z2 - bestSegment.z1,
            osmId: bestSegment.osmId,
            highway: bestSegment.highway,
            roadY: Number.isFinite(numericOverrideRoadY)
                ? numericOverrideRoadY
                : baseRoadY,
            // Overridden ways (custom viaducts) hold a deliberate above-grade
            // level; the junction blend must neither move them nor be pulled
            // toward them.
            overridden: Number.isFinite(numericOverrideRoadY),
        };
    }

    _genericSegmentsNear(x, z, maxDistanceM) {
        const radius = Math.max(0, Number(maxDistanceM) || DEFAULT_QUERY_RADIUS_M);
        const minCellX = Math.floor((x - radius) / INDEX_CELL_M);
        const maxCellX = Math.floor((x + radius) / INDEX_CELL_M);
        const minCellZ = Math.floor((z - radius) / INDEX_CELL_M);
        const maxCellZ = Math.floor((z + radius) / INDEX_CELL_M);
        const found = [];
        const seen = new Set();
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                for (const segment of this._segmentIndex.get(`${cellX}_${cellZ}`) || []) {
                    if (seen.has(segment)) continue;
                    seen.add(segment);
                    found.push(segment);
                }
            }
        }
        return found;
    }

    formationAtLocal(x, z, {
        osmId = null,
        osmIds = null,
        maxDistanceM = DEFAULT_QUERY_RADIUS_M,
        requireSurface = false,
        allowStale = false,
    } = {}) {
        // Read-only frame-time consumers may keep using the last atomically
        // published indexes while streamed tiles make the next generation
        // dirty. Builders retain the default and synchronously demand current
        // data; the roads layer is responsible for preparing that generation.
        if (!allowStale) this._ensureBuilt();
        let requestedId = numericId(osmId);
        if (requireSurface && requestedId == null) {
            const surface = this._surfaceAtLocalBuilt(x, z);
            if (!surface) return null;
            requestedId = surface.osmId;
        }
        if (requestedId != null) {
            return this._nearestOnOwnSegments(Number(x), Number(z), requestedId);
        }
        // A coupled crossing queries a SET of member roads at once. Each id
        // resolves through the per-road index; the closest of the per-road
        // winners is exact because every per-id answer is that road's nearest.
        if (Array.isArray(osmIds)) {
            const requestedIds = Array.from(
                new Set(osmIds.map(numericId).filter(value => value != null)),
            );
            if (requestedIds.length > 0) {
                let best = null;
                for (const id of requestedIds) {
                    const candidate = this._nearestOnOwnSegments(Number(x), Number(z), id);
                    if (candidate && (!best || candidate.distanceSquared < best.distanceSquared)) {
                        best = candidate;
                    }
                }
                return best;
            }
        }
        return this._nearestOnSegments(
            Number(x),
            Number(z),
            this._genericSegmentsNear(x, z, maxDistanceM),
            maxDistanceM,
        );
    }

    // True when this location sits beside the rendered earthwork/retaining
    // boundary of one of the requested road surfaces. Curb construction asks
    // this at its back-ramp midpoint: the curb stone remains, while the generic
    // sidewalk ramp yields to the road formation's one authoritative shoulder.
    hasDressedSurfaceBoundaryAtLocal(x, z, {
        osmIds = null,
        maxDistanceM = 1.5,
        allowStale = false,
    } = {}) {
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const radiusM = Math.max(0, finiteOrNull(maxDistanceM) ?? 0);
        if (localX === null || localZ === null || radiusM <= 0) return false;
        const requestedIds = new Set(
            (Array.isArray(osmIds) ? osmIds : [osmIds])
                .map(numericId)
                .filter(value => value != null),
        );
        if (requestedIds.size === 0) return false;
        const maximumDistanceSquared = radiusM * radiusM;
        return this.surfaceProfilesNear(localX, localZ, radiusM, { allowStale }).some((profile) => (
            requestedIds.has(profile.osmId)
            && !profile.formationDressingDisabled
            && distanceSquaredToRing(localX, localZ, profile.innerRing)
                <= maximumDistanceSquared
        ));
    }

    // Nearest point on ONE road's centreline, without scanning the whole road.
    //
    // The unindexed form was O(segments of that road) per call at an infinite
    // search radius, and its callers query per VERTEX of geometry draped on that
    // same road — so a long primary cost O(segments²) to drape once. Measured
    // 2026-07-30, this was the bulk of a lane-marking rebuild that reached 124 ms
    // and ran two to three times a second while tiles streamed.
    //
    // The 3×3 cell block around the point covers at least INDEX_CELL_M in every
    // direction, and a segment is registered in every cell its bounding box
    // touches. So any segment within INDEX_CELL_M of the point is certainly in
    // the block: if the best candidate found is that close, it is provably the
    // global nearest and the full scan can be skipped. Only a point genuinely
    // far from its own road falls through to the old behaviour, which is what
    // preserves the infinite-radius contract.
    _nearestOnOwnSegments(x, z, requestedId) {
        const cellX = Math.floor(x / INDEX_CELL_M);
        const cellZ = Math.floor(z / INDEX_CELL_M);

        // The overwhelmingly common case — geometry draped on the road it
        // belongs to — is answered from the single cell the point sits in, with
        // no gathering and no allocation. A hit closer than the nearest cell
        // EDGE is provably the global nearest: anything closer would have to
        // pass through this cell, and would therefore be indexed in it.
        const ownCell = this._ownSegmentIndex.get(`${requestedId}:${cellX}_${cellZ}`);
        if (ownCell) {
            const best = this._nearestOnSegments(x, z, ownCell, Infinity);
            if (best) {
                const edge = Math.min(
                    x - cellX * INDEX_CELL_M,
                    (cellX + 1) * INDEX_CELL_M - x,
                    z - cellZ * INDEX_CELL_M,
                    (cellZ + 1) * INDEX_CELL_M - z,
                );
                if (best.distanceSquared <= edge * edge) return best;
            }
        }

        const near = [];
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cell = this._ownSegmentIndex.get(
                    `${requestedId}:${cellX + dx}_${cellZ + dz}`,
                );
                if (cell) near.push(...cell);
            }
        }
        if (near.length > 0) {
            const best = this._nearestOnSegments(x, z, near, Infinity);
            if (best && best.distanceSquared <= INDEX_CELL_M * INDEX_CELL_M) return best;
        }
        return this._nearestOnSegments(
            x,
            z,
            this._segmentsByOsmId.get(requestedId),
            Infinity,
        );
    }

    sceneYAtLocal(x, z, options = {}) {
        const own = this.formationAtLocal(x, z, options);
        // No owning way: bare terrain. The walk floor depends on this (off the
        // road the walker stands on real ground); draped SURFACES that should
        // follow nearby carriageways call groundSceneYAtLocal explicitly.
        if (!own) return this._baseY(x, z);
        // Real junction continuity comes from a shared topology-node elevation,
        // not from mixing every road within an arbitrary radius. Radius blending
        // made nearby parallel/crossing ways pull broad valleys into one another.
        return own.roadY;
    }

    // Ground height for NON-engineered draped surfaces (footways, pedestrian
    // strips, cycleways). Beside an engineered road they follow its blended
    // grade and ease back to raw terrain with distance — a strip draped on the
    // hillside used to stand a full cross-slope step against the carriageway
    // it borders, rendered as a streaky near-vertical wall along the street.
    groundSceneYAtLocal(x, z, {
        tangentX = null,
        tangentZ = null,
    } = {}) {
        this._ensureBuilt();
        const radius = SIDEWALK_PROFILE_END_M;
        const terrainY = this._baseY(x, z);
        const nearbySegments = this._genericSegmentsNear(x, z, radius);
        const queryTangentX = finiteOrNull(tangentX);
        const queryTangentZ = finiteOrNull(tangentZ);
        const hasDirection = queryTangentX !== null
            && queryTangentZ !== null
            && Math.hypot(queryTangentX, queryTangentZ) > 1e-6;
        let nearest = this._nearestOnSegments(
            Number(x),
            Number(z),
            nearbySegments,
            radius,
            hasDirection
                ? { tangentX: queryTangentX, tangentZ: queryTangentZ }
                : undefined,
        );
        // Missing or malformed path centerlines retain the legacy nearest-road
        // behaviour; a real direction with no parallel candidate may still be
        // a short connector at an intersection and needs the same fallback.
        if (!nearest && hasDirection) {
            nearest = this._nearestOnSegments(
                Number(x),
                Number(z),
                nearbySegments,
                radius,
            );
        }
        if (!nearest || nearest.overridden) return terrainY;
        if (!Number.isFinite(terrainY)) return nearest.roadY;
        const distanceM = Math.sqrt(nearest.distanceSquared);
        if (distanceM <= SIDEWALK_PROFILE_FULL_M) return nearest.roadY;
        const linearT = Math.max(0, Math.min(1,
            (distanceM - SIDEWALK_PROFILE_FULL_M)
                / (SIDEWALK_PROFILE_END_M - SIDEWALK_PROFILE_FULL_M)));
        const terrainMix = linearT * linearT * (3 - 2 * linearT);
        return nearest.roadY * (1 - terrainMix) + terrainY * terrainMix;
    }

    // Effective ground after road civil work, for later semantic authorities.
    // A bridge/underpass is a carried structure rather than ground, so only
    // ordinary road tops and their actual cut/fill dressing can claim a point.
    civilGroundSceneYAtLocal(x, z, {
        surfaceOffsetYAtProfile = null,
        allowStale = false,
    } = {}) {
        // Derived streamed geometry may consume the last complete formation
        // while the next tile generation is still compiling. It must never
        // force that whole generation synchronously from a per-vertex query.
        if (!allowStale) this._ensureBuilt();
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        if (localX == null || localZ == null) return null;
        let bestY = null;
        for (const profile of this._civilGroundProfileIndex.get(cellKey(localX, localZ)) || []) {
            if (profile.surfacePublicationReady === false) continue;
            this._civilGroundProfileChecks += 1;
            const bounds = profile.overlapBounds
                || profile.terrainCutoutBounds
                || profile.outerBounds
                || profile.bounds;
            if (bounds && (localX < bounds.minX || localX > bounds.maxX
                || localZ < bounds.minZ || localZ > bounds.maxZ)) continue;
            const structure = this.roadStructureAtLocal?.(
                localX,
                localZ,
                profile.osmId,
            );
            if (structure?.kind === 'overpass' || structure?.kind === 'underpass'
                || this.roadReplacementAtLocal?.(localX, localZ, profile.osmId)) {
                continue;
            }
            const offsetY = typeof surfaceOffsetYAtProfile === 'function'
                ? (finiteOrNull(surfaceOffsetYAtProfile(profile)) || 0)
                : 0;
            let candidate = null;
            if (pointInRing(
                localX,
                localZ,
                profile.innerRing || [],
                profile._ringQueryIndex,
            )) {
                const formation = this.formationAtLocal(localX, localZ, {
                    osmId: profile.osmId,
                    allowStale,
                });
                if (Number.isFinite(formation?.roadY)) {
                    candidate = formation.roadY + offsetY;
                }
            } else {
                candidate = formationDressingSurfaceYAtLocal(
                    profile,
                    localX,
                    localZ,
                    { surfaceOffsetY: offsetY },
                );
            }
            if (!Number.isFinite(candidate)) continue;
            bestY = bestY == null ? candidate : Math.max(bestY, candidate);
        }
        return bestY;
    }

    resetCivilGroundProfileCheckCount() {
        this._civilGroundProfileChecks = 0;
    }

    getCivilGroundProfileCheckCount() {
        return this._civilGroundProfileChecks;
    }

    // Nearby road centreline segments in the LOCAL frame, as [x1, z1, x2, z2]
    // arrays. This is the level-crossing detector's road input: it reads the
    // STREAMED centrelines (the baked road-index is empty for some locations,
    // e.g. Split), so it reflects whichever /roads tiles have loaded so far.
    // Ensures the spatial index is built first.
    nearbyCenterlineSegments(x, z, maxDistanceM = DEFAULT_QUERY_RADIUS_M) {
        this._ensureBuilt();
        return this._genericSegmentsNear(Number(x), Number(z), Number(maxDistanceM))
            .map((seg) => [seg.x1, seg.z1, seg.x2, seg.z2]);
    }

    surfaceAtLocal(x, z, excludeOsmId = null) {
        this._ensureBuilt();
        return this._surfaceAtLocalBuilt(x, z, excludeOsmId);
    }

    // Derived frame-budgeted consumers may read the last complete formation
    // generation without forcing a dirty replacement to build synchronously.
    // Once roads publish the replacement, their revision invalidates the
    // affected derived cells and those consumers rebuild against it.
    publishedSurfaceAtLocal(x, z, excludeOsmId = null) {
        return this._surfaceAtLocalBuilt(x, z, excludeOsmId);
    }

    _surfaceAtLocalBuilt(x, z, excludeOsmId = null) {
        const excludedIds = excludeOsmId instanceof Set || Array.isArray(excludeOsmId)
            ? new Set(
                Array.from(excludeOsmId)
                    .map(numericId)
                    .filter(value => value != null),
            )
            : null;
        const excludedId = excludedIds ? null : numericId(excludeOsmId);
        for (const profile of this._surfaceIndex.get(cellKey(x, z)) || []) {
            if (profile.osmId === excludedId || excludedIds?.has(profile.osmId)) {
                continue;
            }
            const bounds = profile.bounds;
            if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
            if (pointInRing(x, z, profile.innerRing, profile._ringQueryIndex)) return profile;
        }
        return null;
    }

    // A single OSM way can arrive as several Polygon members of one
    // MultiPolygon. Those members are separate rendered profiles, so only the
    // profile whose boundary is being dressed is "self" here. Excluding the
    // whole OSM id leaves internal member seams free to grow their own wall and
    // terrain collar across sibling asphalt (Split's Riva portal road).
    _surfaceAtLocalExcludingProfile(x, z, excludedProfile) {
        for (const profile of this._surfaceIndex.get(cellKey(x, z)) || []) {
            if (profile === excludedProfile) continue;
            const bounds = profile.bounds;
            if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
            if (pointInRing(x, z, profile.innerRing, profile._ringQueryIndex)) return profile;
        }
        return null;
    }

    _hasAtGradeSurfaceAtLocal(x, z, ownProfile) {
        const ownOsmId = numericId(ownProfile?.osmId);
        let own = null;
        for (const profile of this._surfaceIndex.get(cellKey(x, z)) || []) {
            if (profile === ownProfile) continue;
            const bounds = profile.bounds;
            if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
            if (!pointInRing(x, z, profile.innerRing, profile._ringQueryIndex)) continue;
            // Most formation edges do not overlap another surface. Defer both
            // height projections until the cheap bounds/ring test proves that
            // this point is actually a junction.
            own ||= this._nearestOnSegments(
                x,
                z,
                this._segmentsByOsmId.get(ownOsmId),
            );
            if (!own) return false;
            const other = this._nearestOnSegments(
                x,
                z,
                this._segmentsByOsmId.get(profile.osmId),
            );
            if (other && Math.abs(other.roadY - own.roadY) <= AT_GRADE_JUNCTION_MAX_DELTA_M) {
                return true;
            }
        }
        return false;
    }

    getSurfaceProfiles() {
        this._ensureBuilt();
        return this._profiles;
    }

    hasPendingBuild() {
        return this._dirty;
    }

    surfaceProfilesNear(
        x,
        z,
        radiusM = DEFAULT_QUERY_RADIUS_M,
        { allowStale = false } = {},
    ) {
        if (!allowStale) this._ensureBuilt();
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const radius = finiteOrNull(radiusM);
        if (localX === null || localZ === null || radius === null || radius < 0) return [];
        const minCellX = Math.floor((localX - radius) / INDEX_CELL_M);
        const maxCellX = Math.floor((localX + radius) / INDEX_CELL_M);
        const minCellZ = Math.floor((localZ - radius) / INDEX_CELL_M);
        const maxCellZ = Math.floor((localZ + radius) / INDEX_CELL_M);
        const profiles = new Set();
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                for (const profile of this._surfaceIndex.get(`${cellX}_${cellZ}`) || []) {
                    const bounds = profile.bounds;
                    const dx = localX < bounds.minX ? bounds.minX - localX
                        : localX > bounds.maxX ? localX - bounds.maxX : 0;
                    const dz = localZ < bounds.minZ ? bounds.minZ - localZ
                        : localZ > bounds.maxZ ? localZ - bounds.maxZ : 0;
                    if (dx * dx + dz * dz <= radius * radius) profiles.add(profile);
                }
            }
        }
        return Array.from(profiles);
    }

    // Profiles whose civil dressing can reach a disc, from the index keyed by
    // the same overlap/cut-out/outer bounds the dressing builders use. The
    // surface index is keyed by the paved ring only and can miss a collar.
    dressingProfilesNear(x, z, radiusM, { allowStale = false } = {}) {
        if (!allowStale) this._ensureBuilt();
        const localX = finiteOrNull(x);
        const localZ = finiteOrNull(z);
        const radius = finiteOrNull(radiusM);
        if (localX === null || localZ === null || radius === null || radius < 0) return [];
        const profiles = new Set();
        for (let cellZ = Math.floor((localZ - radius) / INDEX_CELL_M); cellZ <= Math.floor((localZ + radius) / INDEX_CELL_M); cellZ += 1) {
            for (let cellX = Math.floor((localX - radius) / INDEX_CELL_M); cellX <= Math.floor((localX + radius) / INDEX_CELL_M); cellX += 1) {
                for (const profile of this._civilGroundProfileIndex.get(`${cellX}_${cellZ}`) || []) {
                    const bounds = profile.overlapBounds || profile.terrainCutoutBounds
                        || profile.outerBounds || profile.bounds;
                    const dx = localX < bounds.minX ? bounds.minX - localX
                        : localX > bounds.maxX ? localX - bounds.maxX : 0;
                    const dz = localZ < bounds.minZ ? bounds.minZ - localZ
                        : localZ > bounds.maxZ ? localZ - bounds.maxZ : 0;
                    if (dx * dx + dz * dz <= radius * radius) profiles.add(profile);
                }
            }
        }
        return Array.from(profiles);
    }

    getSurfaceProfilesForOsmId(osmId, { allowStale = false } = {}) {
        if (!allowStale) this._ensureBuilt();
        const requestedId = numericId(osmId);
        return this._profiles.filter((profile) => profile.osmId === requestedId);
    }

    getSurfaceProfilesForFeature(feature, { allowStale = false } = {}) {
        if (!allowStale) this._ensureBuilt();
        const identity = this._featureIdentities.identityFor(feature);
        const profiles = this._profiles.filter(profile => profile.sourceOwnerKey === identity.key
            && profile.sourceRevisionKey === identity.revisionKey);
        const byPolygon = new Map(profiles.map(profile => [profile.sourcePolygonKey, profile]));
        return identity.polygonKeys.map(key => byPolygon.get(key)).filter(Boolean);
    }

    getReplacementTerrainCutoutRegions() {
        const regions = this.replacementTerrainCutoutRegions?.();
        return Array.isArray(regions) ? regions : [];
    }

    _isOverpassStructureAtLocal(x, z, osmId) {
        return this.roadStructureAtLocal?.(x, z, osmId)?.kind === 'overpass';
    }

    _surfaceProfileBuildOptions(osmId, highway, ring) {
        const formationStyle = String(
            this.formationStyleForOsmId?.(osmId, highway) || '',
        ).trim() || null;
        return {
            innerRing: ring,
            // The ring's designed top reads the same topology-anchored profile
            // as asphalt, markings and curbs, so every corridor owner meets it.
            surfaceSceneYAtLocal: (x, z) => this.sceneYAtLocal(x, z, { osmId }),
            baseSceneYAtLocal: (x, z) => this._baseY(x, z),
            baseTerrainReplacementAtLocal: (x, z) => (
                this.baseTerrainReplacementAtLocal(x, z)
            ),
            verticalRetainedWalls: formationStyle === 'vertical-retained',
            retainedWallBoundaryAtLocal: formationStyle === 'vertical-retained'
                && this.retainedWallBoundaryForOsmIdAtLocal
                ? (x, z, options) => this.retainedWallBoundaryForOsmIdAtLocal(
                    osmId,
                    x,
                    z,
                    options,
                )
                : null,
            metadata: { osmId, highway, formationStyle },
        };
    }

    _finishSurfaceProfile(osmId, profile) {
        const segments = this._segmentsByOsmId.get(osmId);
        if (!segments || segments.length === 0) return null;
        if (profile) {
            // Junction suppression may contract this edge. Keep the unsuppressed
            // boundary so a later neighbour eviction can restore it exactly.
            profile.baseTerrainCutout = profile.points.map(point => Object.freeze({
                x: point.cutoutX, z: point.cutoutZ, y: point.cutoutTerrainY,
            }));
            profile.surfacePublicationReady =
                this._surfacePublicationReadyByOsmId.get(osmId) !== false;
            profile._ringQueryIndex = createRingQueryIndex(profile.innerRing);
            const centerlineProfile = segments[0]?.profile;
            const baseSceneYAtLocal = (x, z) => this._baseY(x, z);
            const sourceTerrainInputSceneYAtLocal = (x, z) => {
                if (this.roadReplacementAtLocal?.(x, z, osmId)) return null;
                const structure = this.roadStructureAtLocal?.(x, z, osmId);
                if (structure?.kind === 'overpass' || structure?.kind === 'underpass') {
                    return null;
                }
                return this._sourceTerrainInputY(x, z);
            };
            const roadSceneYAtLocal = (x, z) => (
                this.sceneYAtLocal(x, z, { osmId })
            );
            profile.terrainExcavationRegions = [
                ...buildRoadTerrainExcavationRegions({
                    centerlineProfile,
                    baseSceneYAtLocal,
                    roadSceneYAtLocal,
                    minDepthM: ROAD_CIVIL_EXCAVATION_MIN_DEPTH_M,
                }),
                ...buildRoadSurfaceTerrainIntrusionRegions({
                    centerlineProfile,
                    surfaceRing: profile.innerRing,
                    surfaceRingQueryIndex: profile._ringQueryIndex,
                    sourceTerrainInputSceneYAtLocal,
                    roadSceneYAtLocal,
                }),
            ];
            // A perfectly ordinary at-grade road needs only its paved top.
            // Emitting the minimum-width batter anyway turns its zero-height
            // face into a horizontal grey apron along both road edges. Disable
            // the whole civil dressing only when every terrain row remains
            // curb-close to the road; a single real cut/fill point conservatively
            // keeps the profile's face, collar and matching terrain cutout.
            profile.formationDressingDisabled = profile.points.length >= 3
                && profile.points.every((point) => (
                    typeof point.roadY === 'number'
                    && Number.isFinite(point.roadY)
                    && [
                        point.terrainY,
                        point.cutoutTerrainY,
                        point.overlapTerrainY,
                    ].every((terrainY) => (
                        typeof terrainY === 'number'
                        && Number.isFinite(terrainY)
                        && Math.abs(terrainY - point.roadY)
                        <= AT_GRADE_DRESSING_MAX_DELTA_M
                    ))
                ));
            // The standalone intrusion detector deliberately fails closed: it
            // sees only a paved polygon, not the replacement shell. Once this
            // complete profile proves that its retaining face and terrain
            // collar will be rendered, those paved-footprint regions may join
            // the cut publication. Junction clipping below still removes any
            // individual wall/collar run that another surface suppresses.
            if (!profile.formationDressingDisabled) {
                for (const region of profile.terrainExcavationRegions) {
                    if (region.clipToPavedSurface === true) {
                        region.replacementBackstopReady = true;
                    }
                }
            }
            // A bridge span likewise owns a deck, not the ground below it. Its
            // ordinary road polygon still supplies the paved top, but neither
            // a bridge nor a flush road may punch a terrain hole.
            const hasOverpass = profile.points.some((point) => (
                this._isOverpassStructureAtLocal(
                    point.innerX,
                    point.innerZ,
                    osmId,
                )
            ));
            profile.terrainCutoutDisabled = hasOverpass
                || (profile.formationDressingDisabled
                    && formationTerrainCutoutMaskRegions(profile).length === 0);
        }
        return profile;
    }

    _createPendingBuildPreparation(captureBuildInputsSteps = this.captureBuildInputsSteps) {
        return {
            revision: this.revision,
            previousProfiles: this._profiles,
            phase: captureBuildInputsSteps ? 'capture-inputs' : 'collect-centerlines',
            inputIterator: captureBuildInputsSteps?.call(this),
            inputs: null,
            index: 0,
            centerlineTiles: Array.from(this.centerlineTiles.values()),
            centerlinesById: new Map(),
            centerlineEntries: null,
            centerlineDataById: new Map(),
            ownersByNodeKey: new Map(),
            gradeChangedBounds: [],
            segmentsByOsmId: new Map(),
            segmentIndex: new Map(),
            ownSegmentIndex: new Map(),
            surfaceTiles: Array.from(this.surfaceTiles.values()),
            surfacesById: new Map(),
            surfaceEntries: null,
            activeSurface: null,
            profiles: [],
            profilesToRecheck: [],
            profileCacheOverrides: new Map(),
            activeJunctionProfile: null,
            junctionSegmentIndex: 0,
            junctionCutoutIndex: 0,
            surfaceIndex: new Map(),
            civilGroundProfileIndex: new Map(),
        };
    }

    _cloneProfileForPreparedRecheck(profile) {
        return {
            ...profile,
            points: (profile.points || []).map(point => ({ ...point })),
            terrainCutoutRing: (profile.terrainCutoutRing || [])
                .map(point => ({ ...point })),
            internalSegments: Array.isArray(profile.internalSegments)
                ? [...profile.internalSegments]
                : [],
            collarInternalSegments: Array.isArray(profile.collarInternalSegments)
                ? [...profile.collarInternalSegments]
                : [],
            sharedRetainingWallSegments:
                Array.isArray(profile.sharedRetainingWallSegments)
                    ? [...profile.sharedRetainingWallSegments]
                    : [],
            terrainReplacementBackstopSegments:
                Array.isArray(profile.terrainReplacementBackstopSegments)
                    ? [...profile.terrainReplacementBackstopSegments]
                    : [],
        };
    }

    _withPreparedBuildIndexes(preparation, callback) {
        const previous = {
            dirty: this._dirty,
            segmentsByOsmId: this._segmentsByOsmId,
            segmentIndex: this._segmentIndex,
            ownSegmentIndex: this._ownSegmentIndex,
            surfaceIndex: this._surfaceIndex,
            civilGroundProfileIndex: this._civilGroundProfileIndex,
            profiles: this._profiles,
        };
        this._dirty = false;
        this._segmentsByOsmId = preparation.segmentsByOsmId;
        this._segmentIndex = preparation.segmentIndex;
        this._ownSegmentIndex = preparation.ownSegmentIndex;
        this._surfaceIndex = preparation.surfaceIndex;
        this._civilGroundProfileIndex = preparation.civilGroundProfileIndex;
        this._profiles = preparation.profiles;
        try {
            return callback();
        } finally {
            this._dirty = previous.dirty;
            this._segmentsByOsmId = previous.segmentsByOsmId;
            this._segmentIndex = previous.segmentIndex;
            this._ownSegmentIndex = previous.ownSegmentIndex;
            this._surfaceIndex = previous.surfaceIndex;
            this._civilGroundProfileIndex = previous.civilGroundProfileIndex;
            this._profiles = previous.profiles;
        }
    }

    // Builds the next formation cooperatively, one bounded road/profile step
    // per visit. Live spatial indexes remain on the last complete generation
    // until the final atomic swap. A superseding revision discards this task
    // and starts a new snapshot without exposing partial state.
    stepPendingBuildPreparation(owner = null) {
        if (this._disposed) throw new Error('Road formation is disposed');
        // A dependency group owns this preparation until its mesh/query/support
        // swap settles. An incidental live query must not publish it early.
        if (!this._dirty) return 'done';
        if (this._publicationManaged && (!owner || owner !== this._publicationOwner)) return 'held';
        if (!this._pendingBuildPreparation
            || this._pendingBuildPreparation.revision !== this.revision) {
            this._discardBuildInputs(this._pendingBuildPreparation);
            this._pendingBuildPreparation = this._createPendingBuildPreparation(owner?.captureBuildInputsSteps);
        }
        const task = this._pendingBuildPreparation;

        try {
            if (task.phase === 'capture-inputs') {
                if (typeof task.inputIterator?.next !== 'function') {
                    throw new TypeError('Road formation input capture must return an iterator');
                }
                const step = task.inputIterator.next();
                if (!step.done) return 'more';
                const input = step.value;
                // The completed generator transfers its read owners even when
                // validation below rejects an incomplete callback contract.
                task.inputs = input;
                for (const name of this._requiredCapturedInputs) {
                    if (typeof input?.callbacks?.[name] !== 'function') {
                        throw new TypeError(`Road formation requires captured ${name}`);
                    }
                }
                if (!input?.context || typeof input.context !== 'object' || !Object.isFrozen(input.context)) {
                    throw new TypeError('Road formation requires a frozen captured build context');
                }
                if (input.isCurrent != null && typeof input.isCurrent !== 'function') {
                    throw new TypeError('Road formation input validity must be a function');
                }
                task.inputs = Object.freeze({ ...input, context: input.context,
                    isCurrent: input.isCurrent,
                    callbacks: Object.freeze(Object.fromEntries(FORMATION_INPUT_CALLBACKS
                        .map(name => [name, input.callbacks[name] ?? null]))) });
                task.inputIterator = null;
                task.phase = 'collect-centerlines';
                return 'more';
            }
            if (!task.inputs) return this._stepPreparedBuild(task);
            if (task.inputs.isCurrent && !task.inputs.isCurrent()) {
                const error = new Error('Road formation inputs changed during preparation');
                error.code = 'formation-inputs-stale';
                error.details = { validity: task.inputs.currentDetails?.() };
                throw error;
            }
            const previous = FORMATION_INPUT_CALLBACKS.map(name => this[name]);
            for (const name of FORMATION_INPUT_CALLBACKS) this[name] = task.inputs.callbacks[name];
            try {
                return this._stepPreparedBuild(task);
            } finally {
                if (!task.published) FORMATION_INPUT_CALLBACKS.forEach((name, index) => { this[name] = previous[index]; });
            }
        } catch (error) {
            this._discardBuildInputs(task);
            throw error;
        }
    }

    getPublishedBuildInputs() { return this._publishedBuildInputs; }

    managePublications() {
        if (this._disposed) throw new Error('Road formation is disposed');
        this._publicationManaged = true;
    }

    // The same compiler supplies a dependency group's off-scene receiver
    // builders. No competing formation model or mutable upstream callbacks are
    // cloned. Call finalize only after the shared registry batch has succeeded.
    // The first call transfers publication responsibility to that coordinator
    // for this model's lifetime. Cancellation releases the candidate, not this
    // responsibility: a subsequent query must not auto-publish a failed change.
    *preparePublicationSteps({ captureBuildInputsSteps = this.captureBuildInputsSteps, isCurrent = () => true } = {}) {
        if (this._disposed) throw new Error('Road formation is disposed');
        if (this._publicationOwner) throw new Error('Road formation publication is already held');
        if (typeof captureBuildInputsSteps !== 'function' || typeof isCurrent !== 'function') {
            throw new TypeError('Road publication requires captured build inputs and validity');
        }
        this._publicationManaged = true;
        if (!this._dirty) return null;
        const owner = { captureBuildInputsSteps }, admittedRevision = this.revision;
        this._publicationOwner = owner;
        let task = null, read = null, queryIterator = null, handedOff = false, previous = null, status = 'preparing';
        const release = () => { if (this._publicationOwner === owner) this._publicationOwner = null; };
        owner.cancel = () => {
            if (status === 'discarded' || status === 'published') return false;
            queryIterator?.return?.(); queryIterator = null;
            this._discardBuildInputs(task || this._pendingBuildPreparation);
            if (status === 'committed') previous?._publishedBuildInputs?.release?.();
            read?.release?.(); read = null;
            status = 'discarded'; previous = null; task = null; release();
            return true;
        };
        try {
            // A private dependency graph cannot inherit an earlier background
            // task which captured the active upstream providers.
            this._discardBuildInputs(this._pendingBuildPreparation);
            while (true) {
                const publicationValidity = () => ({
                    owner: this._publicationOwner === owner,
                    disposed: this._disposed,
                    revision: { expected: admittedRevision, current: this.revision },
                    external: isCurrent(),
                    inputs: task?.inputs?.currentDetails?.(),
                });
                const validity = publicationValidity();
                if (!validity.owner || validity.disposed
                    || validity.revision.current !== validity.revision.expected || !validity.external) {
                    throw Object.assign(new Error('Road publication inputs changed during preparation'), {
                        code: 'formation-inputs-stale',
                        details: { validity },
                    });
                }
                const phase = this.stepPendingBuildPreparation(owner);
                task = this._pendingBuildPreparation;
                if (phase === 'prepared') break;
                yield { phase: this.pendingBuildPreparationPhase() };
            }
            task = this._pendingBuildPreparation;
            const publicationRevision = this.surfacePublicationRevision;
            const localCurrent = () => !this._disposed && this._publicationOwner === owner && this._pendingBuildPreparation === task
                && this.revision === task.revision && this.surfacePublicationRevision === publicationRevision;
            const current = () => localCurrent() && isCurrent()
                && (!task.inputs.isCurrent || task.inputs.isCurrent() === true);
            queryIterator = this._captureCompiledReadSnapshotSteps({ ...task.inputs.callbacks, readInputs: task.inputs,
                replacementTerrainCutoutRegions: task.inputs.callbacks.replacementTerrainCutoutRegions?.() || [],
            }, {
                profiles: task.profiles, segmentIndex: task.segmentIndex, ownSegmentIndex: task.ownSegmentIndex,
                segmentsByOsmId: task.segmentsByOsmId, surfaceIndex: task.surfaceIndex,
                civilGroundProfileIndex: task.civilGroundProfileIndex, versions: task.publication.versions,
                geometryRevision: task.publication.revision, publicationRevision, sourceRevision: task.revision,
            }, current);
            read = yield* queryIterator;
            queryIterator = null;
            if (!current() || !read) {
                throw Object.assign(new Error('Road publication was cancelled during query capture'), {
                    code: 'formation-inputs-stale',
                    details: { validity: task?.inputs?.currentDetails?.() },
                });
            }
            const keys = ['_profileCache', '_surfaceGeometryVersions', '_surfaceGeometryChanges',
                'surfaceGeometryRevision', '_segmentsByOsmId', '_segmentIndex', '_ownSegmentIndex',
                '_surfaceIndex', '_civilGroundProfileIndex', '_profiles', '_dirty', '_pendingBuildPreparation',
                'surfaceGeometrySourceRevision', '_publishedBuildInputs', ...FORMATION_INPUT_CALLBACKS];
            previous = Object.fromEntries(keys.map(key => [key, this[key]]));
            status = 'prepared';
            const currentDetails = () => ({
                status,
                owner: this._publicationOwner === owner,
                disposed: this._disposed,
                pendingBuild: this._pendingBuildPreparation === task,
                revision: { expected: task?.revision, current: this.revision },
                recentMutations: this.recentMutations(),
                surfacePublicationRevision: { expected: publicationRevision,
                    current: this.surfacePublicationRevision },
                external: isCurrent(),
                inputs: task?.inputs?.currentDetails?.(),
            });
            handedOff = true;
            return Object.freeze({
                read, inputs: task.inputs,
                get state() { return status; },
                isCurrent: () => status === 'prepared' && current(),
                currentDetails,
                commit: () => {
                    // The registry validates the entire external graph before
                    // its first mutation. An upstream member may now have
                    // promoted successfully; recheck only this member's owner.
                    if (status !== 'prepared' || !localCurrent()) return false;
                    this._publishPreparedBuild(task);
                    status = 'committed';
                    return true;
                },
                rollback: () => {
                    if (status !== 'committed' || this._publicationOwner !== owner) return false;
                    Object.assign(this, previous);
                    task.published = false;
                    status = 'prepared';
                    return true;
                },
                discard: () => {
                    if (status !== 'prepared') return false;
                    return owner.cancel();
                },
                finalize: () => {
                    if (status !== 'committed' || this._publicationOwner !== owner) return false;
                    previous._publishedBuildInputs?.release?.();
                    read.release();
                    status = 'published'; previous = null; task = null; release();
                    return true;
                },
            });
        } finally {
            if (!handedOff) {
                owner.cancel();
            }
        }
    }

    _publishPreparedBuild(task) {
        const previousInputs = this._publishedBuildInputs;
        this._profileCache = task.publication.profileCache;
        this._surfaceGeometryVersions = task.publication.versions;
        this._surfaceGeometryChanges = task.publication.changes;
        this.surfaceGeometryRevision = task.publication.revision;
        this._segmentsByOsmId = task.segmentsByOsmId;
        this._segmentIndex = task.segmentIndex;
        this._ownSegmentIndex = task.ownSegmentIndex;
        this._surfaceIndex = task.surfaceIndex;
        this._civilGroundProfileIndex = task.civilGroundProfileIndex;
        this._profiles = task.profiles;
        this._dirty = false;
        this._pendingBuildPreparation = null;
        this.surfaceGeometrySourceRevision = task.revision;
        this._publishedBuildInputs = task.inputs;
        if (task.inputs) for (const name of FORMATION_INPUT_CALLBACKS) this[name] = task.inputs.callbacks[name];
        task.published = true;
        // A reversible group retains the old inputs until finalize; ordinary
        // compilation has completed its swap and can release them immediately.
        if (!this._publicationOwner) previousInputs?.release?.();
    }

    _stepPreparedBuild(task) {
        if (task.phase === 'collect-centerlines') {
            if (task.index < task.centerlineTiles.length) {
                for (const feature of task.centerlineTiles[task.index] || []) {
                    const osmId = usableEngineeredFeatureId(feature, false);
                    if (osmId == null || task.centerlinesById.has(osmId)) continue;
                    task.centerlinesById.set(osmId, this._centerlineSources.features.get(osmId));
                }
                task.index += 1;
                return 'more';
            }
            task.surfaceCenterlines = this._surfaceSources.features.entries();
            task.phase = 'collect-surface-centerlines';
            return 'more';
        }

        if (task.phase === 'collect-surface-centerlines') {
            const next = task.surfaceCenterlines.next();
            if (!next.done) {
                const [osmId, surface] = next.value, paired = surfaceCenterlineFeature(surface);
                // The polygon and this axis came from one source record. The
                // graph feed still contributes roads without a paired surface;
                // its omissions or arrival order cannot erase this road.
                if (paired) task.centerlinesById.set(osmId, paired);
                return 'more';
            }
            task.surfaceCenterlines = null;
            task.centerlineEntries = Array.from(task.centerlinesById.entries()).sort(([a], [b]) => a - b);
            task.index = 0;
            task.phase = 'prune-centerline-caches';
            return 'more';
        }

        if (task.phase === 'prune-centerline-caches') {
            for (const cache of [
                this._centerlineGeometryCache,
                this._roadGradeCache,
                this._segmentCache,
            ]) {
                for (const osmId of cache.keys()) {
                    if (!task.centerlinesById.has(osmId)) cache.delete(osmId);
                }
            }
            task.phase = 'centerline-terrain';
            return 'more';
        }

        if (task.phase === 'centerline-terrain') {
            if (task.index < task.centerlineEntries.length) {
                const [osmId, feature] = task.centerlineEntries[task.index];
                let data = this._centerlineGeometryCache.get(osmId);
                if (data && data.sourceFeature !== feature) {
                    data = null;
                    this._centerlineGeometryCache.delete(osmId);
                    this._roadGradeCache.delete(osmId);
                    this._segmentCache.delete(osmId);
                    this._profileCache.delete(osmId);
                }
                if (!data) {
                    const local = feature.geometry.coordinates
                        .filter(finitePoint)
                        .map(([lon, lat]) => this.toLocal(lon, lat));
                    if (local.length >= 2) {
                        data = {
                            sourceFeature: feature,
                            local,
                            pointKeys: local.map(topologyNodeKey),
                            highway: featureHighway(feature, false),
                            bounds: ringBounds(local),
                        };
                        this._centerlineGeometryCache.set(osmId, data);
                    }
                }
                if (data) {
                    if (data.terrainEvidenceRevision !== this._terrainEvidenceRevision) {
                        data.baseProfile = buildSmoothedRoadProfile(
                            data.local,
                            (x, z) => this._terrainEvidenceY(x, z),
                        );
                        data.terrainEvidenceRevision = this._terrainEvidenceRevision;
                    }
                    task.centerlineDataById.set(osmId, data);
                    for (const key of new Set(data.pointKeys)) {
                        let owners = task.ownersByNodeKey.get(key);
                        if (!owners) {
                            owners = new Set();
                            task.ownersByNodeKey.set(key, owners);
                        }
                        owners.add(osmId);
                    }
                }
                task.index += 1;
                return 'more';
            }
            task.index = 0;
            task.phase = 'centerline-grade';
            return 'more';
        }

        if (task.phase === 'centerline-grade') {
            if (task.index < task.centerlineEntries.length) {
                const [osmId] = task.centerlineEntries[task.index];
                const data = task.centerlineDataById.get(osmId);
                if (data) {
                    const baseProfile = data.baseProfile;
                    let profile = null;
                    let signature = 'terrain-unavailable';
                    if (baseProfile) {
                        const anchors = [];
                        for (
                            let sourceIndex = 0;
                            sourceIndex < data.local.length;
                            sourceIndex += 1
                        ) {
                            const key = data.pointKeys[sourceIndex];
                            const isEnding = sourceIndex === 0
                                || sourceIndex === data.local.length - 1;
                            if (!isEnding
                                && (task.ownersByNodeKey.get(key)?.size || 0) < 2) continue;
                            const sampleIndex = baseProfile.sourceSampleIndices[sourceIndex];
                            const nodeY = this._topologyNodeY(key, data.local[sourceIndex]);
                            const fallbackY = baseProfile.baseHeights[sampleIndex];
                            anchors.push({
                                sourceIndex,
                                height: Number.isFinite(nodeY) ? nodeY : fallbackY,
                            });
                        }
                        signature = anchors
                            .map(anchor => `${anchor.sourceIndex}:${anchor.height.toFixed(4)}`)
                            .join('|');
                        const cachedGrade = this._roadGradeCache.get(osmId);
                        if (cachedGrade?.signature === signature) profile = cachedGrade.profile;
                        else {
                            profile = anchorRoadProfile(baseProfile, anchors);
                            this._roadGradeCache.set(osmId, { signature, profile });
                            if (cachedGrade || this._profileCache.has(osmId)) {
                                this._profileCache.delete(osmId);
                                task.gradeChangedBounds.push(data.bounds);
                            }
                        }
                    }
                    data.profile = profile;

                    let segmentTemplates = this._segmentCache.get(osmId);
                    if (!segmentTemplates) {
                        segmentTemplates = [];
                        for (let index = 0; index < data.local.length - 1; index += 1) {
                            const from = data.local[index];
                            const to = data.local[index + 1];
                            if (Math.hypot(to.x - from.x, to.z - from.z) < 0.05) continue;
                            segmentTemplates.push({
                                x1: from.x,
                                z1: from.z,
                                x2: to.x,
                                z2: to.z,
                                osmId,
                                highway: data.highway,
                                sourceIndex: index,
                            });
                        }
                        this._segmentCache.set(osmId, segmentTemplates);
                    }
                    // Published indexes may still reference the cached segment
                    // objects from an earlier synchronous generation. Keep the
                    // next grade task-local so allowStale readers cannot observe
                    // half of the atomic rebuild before publication.
                    const segments = segmentTemplates.map(segment => ({
                        ...segment,
                        profile,
                        profileStartIndex: profile
                            ? profile.sourceSampleIndices[segment.sourceIndex]
                            : null,
                        profileEndIndex: profile
                            ? profile.sourceSampleIndices[segment.sourceIndex + 1]
                            : null,
                    }));
                    for (const segment of segments) {
                        const minCellX = Math.floor(
                            Math.min(segment.x1, segment.x2) / INDEX_CELL_M,
                        );
                        const maxCellX = Math.floor(
                            Math.max(segment.x1, segment.x2) / INDEX_CELL_M,
                        );
                        const minCellZ = Math.floor(
                            Math.min(segment.z1, segment.z2) / INDEX_CELL_M,
                        );
                        const maxCellZ = Math.floor(
                            Math.max(segment.z1, segment.z2) / INDEX_CELL_M,
                        );
                        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                                addToIndex(task.segmentIndex, `${cellX}_${cellZ}`, segment);
                                addToIndex(
                                    task.ownSegmentIndex,
                                    `${osmId}:${cellX}_${cellZ}`,
                                    segment,
                                );
                            }
                        }
                    }
                    if (segments.length > 0) task.segmentsByOsmId.set(osmId, segments);
                }
                task.index += 1;
                return 'more';
            }
            task.phase = 'record-grade-changes';
            return 'more';
        }

        if (task.phase === 'record-grade-changes') {
            if (task.gradeChangedBounds.length > 0) {
                const latestChange = this._formationChanges[this._formationChanges.length - 1];
                if (latestChange?.revision === this.revision
                    && Array.isArray(latestChange.bounds)) {
                    latestChange.bounds.push(...task.gradeChangedBounds.map(
                        bounds => ({ ...bounds }),
                    ));
                }
            }
            task.index = 0;
            task.phase = 'collect-surfaces';
            return 'more';
        }

        if (task.phase === 'collect-surfaces') {
            if (task.index < task.surfaceTiles.length) {
                for (const feature of task.surfaceTiles[task.index] || []) {
                    const osmId = usableEngineeredFeatureId(feature, true);
                    if (osmId == null || task.surfacesById.has(osmId)) continue;
                    task.surfacesById.set(osmId, this._surfaceSources.features.get(osmId));
                }
                task.index += 1;
                return 'more';
            }
            task.surfaceEntries = Array.from(task.surfacesById.entries()).sort(([a], [b]) => a - b);
            task.index = 0;
            task.phase = 'prune-surface-cache';
            return 'more';
        }

        if (task.phase === 'prune-surface-cache') {
            for (const osmId of this._profileCache.keys()) {
                if (!task.surfacesById.has(osmId)
                    || !task.segmentsByOsmId.has(osmId)) {
                    this._profileCache.delete(osmId);
                }
            }
            task.phase = 'surface-profiles';
            return 'more';
        }

        if (task.phase === 'surface-profiles') {
            if (task.index >= task.surfaceEntries.length) {
                task.index = 0;
                task.phase = 'collect-profiles';
                return 'more';
            }
            const [osmId, feature] = task.surfaceEntries[task.index];
            if (!task.segmentsByOsmId.has(osmId)) {
                task.index += 1;
                return 'more';
            }
            const cachedProfiles = this._profileCache.get(osmId);
            if (cachedProfiles) {
                task.index += 1;
                return 'more';
            }
            if (!task.activeSurface) {
                const sources = [...this._surfaceSources.records.get(osmId).values()]
                    .sort((a, b) => a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
                task.activeSurface = {
                    osmId,
                    feature,
                    profiles: [],
                    polygons: sources.flatMap(record => {
                        const geometry = record.feature.geometry;
                        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
                        return polygons.map((coordinates, index) => ({
                            coordinates, source: record, polygonKey: record.identity.polygonKeys[index],
                        }));
                    }),
                    polygonIndex: 0,
                    rawRing: null,
                    localRing: null,
                    ringIndex: 0,
                    profileIterator: null,
                    profilePhase: '',
                };
            }
            const active = task.activeSurface;
            if (active.polygonIndex < active.polygons.length) {
                if (!active.rawRing) {
                    const polygon = active.polygons[active.polygonIndex];
                    const rawRing = polygon.coordinates[0];
                    if (!Array.isArray(rawRing)) {
                        active.polygonIndex += 1;
                        return 'more';
                    }
                    active.rawRing = rawRing;
                    active.localRing = [];
                    active.ringIndex = 0;
                    active.profilePhase = 'localize';
                }
                if (active.ringIndex < active.rawRing.length) {
                    const deadlineMs = formationBuildNowMs() + FORMATION_PROFILE_SLICE_MS;
                    do {
                        const point = active.rawRing[active.ringIndex];
                        if (finitePoint(point)) active.localRing.push(this.toLocal(point[0], point[1]));
                        active.ringIndex += 1;
                    } while (active.ringIndex < active.rawRing.length
                        && formationBuildNowMs() < deadlineMs);
                    return 'more';
                }
                if (!active.profileIterator) {
                    active.profileIterator = buildFormationSurfaceProfileSteps(
                        this._surfaceProfileBuildOptions(
                            osmId,
                            featureHighway(active.polygons[active.polygonIndex].source.feature, true),
                            active.localRing,
                        ),
                    );
                    active.profilePhase = 'start';
                }
                const outcome = this._withPreparedBuildIndexes(
                    task,
                    () => active.profileIterator.next(),
                );
                if (!outcome.done) {
                    active.profilePhase = String(outcome.value?.phase || 'profile');
                    return 'more';
                }
                const profile = this._withPreparedBuildIndexes(
                    task,
                    () => this._finishSurfaceProfile(osmId, outcome.value),
                );
                if (profile) {
                    const { identity } = active.polygons[active.polygonIndex].source;
                    profile.sourceOwnerKey = identity.key;
                    profile.sourceRevisionKey = identity.revisionKey;
                    profile.sourcePolygonKey = active.polygons[active.polygonIndex].polygonKey;
                    active.profiles.push(profile);
                }
                active.polygonIndex += 1;
                active.rawRing = null;
                active.localRing = null;
                active.ringIndex = 0;
                active.profileIterator = null;
                active.profilePhase = '';
                return 'more';
            }
            this._profileCache.set(osmId, active.profiles);
            task.activeSurface = null;
            task.index += 1;
            return 'more';
        }

        if (task.phase === 'collect-profiles') {
            if (task.index < task.surfaceEntries.length) {
                const [osmId] = task.surfaceEntries[task.index];
                for (const profile of this._profileCache.get(osmId) || []) {
                    if (!profile._ringQueryIndex) {
                        profile._ringQueryIndex = createRingQueryIndex(profile.innerRing);
                    }
                    task.profiles.push(profile);
                }
                task.index += 1;
                return 'more';
            }
            task.phase = 'plan-junctions';
            return 'more';
        }

        if (task.phase === 'plan-junctions') {
            const previousProfileSet = new Set(task.previousProfiles);
            const activeProfileSet = new Set(task.profiles);
            const changedBounds = [];
            for (const profile of task.previousProfiles) {
                if (!activeProfileSet.has(profile)) changedBounds.push(formationDependencyBounds(profile));
            }
            for (const profile of task.profiles) {
                if (!previousProfileSet.has(profile)) changedBounds.push(formationDependencyBounds(profile));
            }
            const originalsToRecheck = changedBounds.length === 0
                ? []
                : task.profiles.filter((profile) => (
                    !previousProfileSet.has(profile)
                    // A collar reaches beyond the paved ring. A new road can
                    // suppress that collar without intersecting either inner
                    // polygon; excluding this halo retained arrival-order shards.
                    || changedBounds.some((bounds) => boundsOverlap(formationDependencyBounds(profile), bounds))
                ));
            const cloneByOriginal = new Map();
            for (const profile of originalsToRecheck) {
                if (!previousProfileSet.has(profile)) continue;
                cloneByOriginal.set(profile, this._cloneProfileForPreparedRecheck(profile));
            }
            if (cloneByOriginal.size > 0) {
                task.profiles = task.profiles.map(
                    profile => cloneByOriginal.get(profile) || profile,
                );
                for (const [osmId, profiles] of this._profileCache.entries()) {
                    if (!(profiles || []).some(profile => cloneByOriginal.has(profile))) continue;
                    task.profileCacheOverrides.set(
                        osmId,
                        profiles.map(profile => cloneByOriginal.get(profile) || profile),
                    );
                }
            }
            task.profilesToRecheck = originalsToRecheck.map(
                profile => cloneByOriginal.get(profile) || profile,
            );
            task.index = 0;
            task.phase = 'profile-indexes';
            return 'more';
        }

        if (task.phase === 'profile-indexes') {
            if (task.index < task.profiles.length) {
                const profile = task.profiles[task.index];
                const bounds = profile.bounds;
                const minCellX = Math.floor(bounds.minX / INDEX_CELL_M);
                const maxCellX = Math.floor(bounds.maxX / INDEX_CELL_M);
                const minCellZ = Math.floor(bounds.minZ / INDEX_CELL_M);
                const maxCellZ = Math.floor(bounds.maxZ / INDEX_CELL_M);
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                        addToIndex(task.surfaceIndex, `${cellX}_${cellZ}`, profile);
                    }
                }
                const civilBounds = profile.overlapBounds
                    || profile.terrainCutoutBounds
                    || profile.outerBounds
                    || profile.bounds;
                const civilMinCellX = Math.floor(civilBounds.minX / INDEX_CELL_M);
                const civilMaxCellX = Math.floor(civilBounds.maxX / INDEX_CELL_M);
                const civilMinCellZ = Math.floor(civilBounds.minZ / INDEX_CELL_M);
                const civilMaxCellZ = Math.floor(civilBounds.maxZ / INDEX_CELL_M);
                for (let cellZ = civilMinCellZ; cellZ <= civilMaxCellZ; cellZ += 1) {
                    for (let cellX = civilMinCellX; cellX <= civilMaxCellX; cellX += 1) {
                        addToIndex(
                            task.civilGroundProfileIndex,
                            `${cellX}_${cellZ}`,
                            profile,
                        );
                    }
                }
                task.index += 1;
                return 'more';
            }
            task.index = 0;
            task.phase = task.reindexAfterSharedWalls ? 'prepare-publication' : 'junction-segments';
            return 'more';
        }

        if (task.phase === 'junction-segments') {
            const deadlineMs = formationBuildNowMs()
                + FORMATION_JUNCTION_STEP_BUDGET_MS;
            do {
                if (!task.activeJunctionProfile) {
                    if (task.index >= task.profilesToRecheck.length) {
                        task.index = 0;
                        task.phase = 'shared-walls';
                        return 'more';
                    }
                    const nextProfile = task.profilesToRecheck[task.index];
                    for (const [index, point] of nextProfile.points.entries()) {
                        const base = nextProfile.baseTerrainCutout[index];
                        point.cutoutX = base.x;
                        point.cutoutZ = base.z;
                        point.cutoutTerrainY = base.y;
                        nextProfile.terrainCutoutRing[index] = { x: base.x, z: base.z };
                    }
                    nextProfile.internalSegments.fill(false);
                    if (!Array.isArray(nextProfile.collarInternalSegments)
                        || nextProfile.collarInternalSegments.length
                            !== nextProfile.points.length) {
                        nextProfile.collarInternalSegments = new Array(
                            nextProfile.points.length,
                        ).fill(false);
                    } else {
                        nextProfile.collarInternalSegments.fill(false);
                    }
                    task.activeJunctionProfile = nextProfile;
                    task.junctionSegmentIndex = 0;
                    task.junctionCutoutIndex = 0;
                }
                const profile = task.profilesToRecheck[task.index];
                if (task.junctionSegmentIndex >= profile.points.length) {
                    task.phase = 'junction-cutouts';
                    return 'more';
                }
                const index = task.junctionSegmentIndex;
                this._withPreparedBuildIndexes(task, () => {
                    const a = profile.points[index];
                    const b = profile.points[(index + 1) % profile.points.length];
                    const openingOwnsPoint = (x, z) => (
                        !!this.roadReplacementAtLocal?.(x, z, profile.osmId)
                        || this._isOverpassStructureAtLocal(x, z, profile.osmId)
                    );
                    const wallPointInside = (x, z) => {
                        if (openingOwnsPoint(x, z)) return true;
                        return this._hasAtGradeSurfaceAtLocal(x, z, profile);
                    };
                    const collarPointInside = (x, z) => (
                        openingOwnsPoint(x, z)
                        || !!this._surfaceAtLocalExcludingProfile(x, z, profile)
                        || !this._sourceTerrainOwnsInput(x, z)
                    );
                    const bandInside = (
                        nearXKey,
                        nearZKey,
                        farXKey,
                        farZKey,
                        acrossFractions,
                        pointInside,
                        alongFractions = [0.25, 0.5, 0.75],
                    ) => (
                        alongFractions.some((t) => {
                            const nearX = a[nearXKey] + (b[nearXKey] - a[nearXKey]) * t;
                            const nearZ = a[nearZKey] + (b[nearZKey] - a[nearZKey]) * t;
                            const farX = a[farXKey] + (b[farXKey] - a[farXKey]) * t;
                            const farZ = a[farZKey] + (b[farZKey] - a[farZKey]) * t;
                            return acrossFractions.some((s) => pointInside(
                                nearX + (farX - nearX) * s,
                                nearZ + (farZ - nearZ) * s,
                            ));
                        })
                    );
                    const wallInside = bandInside(
                        'innerX',
                        'innerZ',
                        'outerX',
                        'outerZ',
                        [0.5],
                        wallPointInside,
                    );
                    profile.internalSegments[index] = wallInside;
                    profile.collarInternalSegments[index] = wallInside
                        || profile.sharedRailBoundarySegments?.[index] === true
                        || bandInside(
                            'outerX',
                            'outerZ',
                            'overlapX',
                            'overlapZ',
                            [0.5, 1],
                            collarPointInside,
                            [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1],
                        );
                });
                task.junctionSegmentIndex += 1;
            } while (formationBuildNowMs() < deadlineMs);
            return 'more';
        }

        if (task.phase === 'junction-cutouts') {
            const profile = task.activeJunctionProfile;
            const deadlineMs = formationBuildNowMs()
                + FORMATION_JUNCTION_STEP_BUDGET_MS;
            do {
                if (task.junctionCutoutIndex >= profile.points.length) {
                    task.activeJunctionProfile = null;
                    task.index += 1;
                    task.phase = 'junction-segments';
                    return 'more';
                }
                const index = task.junctionCutoutIndex;
                const previous = (index - 1 + profile.points.length)
                    % profile.points.length;
                if (profile.internalSegments[index]
                    && profile.internalSegments[previous]) {
                    const point = profile.points[index];
                    point.cutoutX = point.innerX;
                    point.cutoutZ = point.innerZ;
                    point.cutoutTerrainY = point.roadY;
                    profile.terrainCutoutRing[index] = {
                        x: point.innerX,
                        z: point.innerZ,
                    };
                }
                task.junctionCutoutIndex += 1;
            } while (formationBuildNowMs() < deadlineMs);
            return 'more';
        }

        if (task.phase === 'shared-walls') {
            if (!task.sharedWallProfiles) {
                task.sharedWallProfileIndexes = [];
                for (let index = 0; index < task.profiles.length; index++) {
                    if (task.profiles[index].verticalRetainedWalls) task.sharedWallProfileIndexes.push(index);
                }
                task.sharedWallProfiles = task.sharedWallProfileIndexes.map(index => {
                    const profile = task.profiles[index];
                    return { ...profile, sharedRetainingWallSegments: new Array(profile.points.length).fill(false) };
                });
                task.sharedWallIterator = sharedRetainingWallSuppressionSteps(task.sharedWallProfiles);
            }
            const deadlineMs = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
            do {
                if (task.sharedWallIterator.next().done) {
                    task.sharedWallFlags = new Map(task.sharedWallProfiles.map(profile => [
                        profile.points, profile.sharedRetainingWallSegments,
                    ]));
                    task.sharedWallProfiles = null;
                    task.sharedWallIterator = null;
                    task.index = 0;
                    task.phase = 'shared-wall-flags';
                    return 'more';
                }
            } while (formationBuildNowMs() < deadlineMs);
            return 'more';
        }

        if (task.phase === 'shared-wall-flags') {
            if (task.index < task.sharedWallProfileIndexes.length) {
                const profileIndex = task.sharedWallProfileIndexes[task.index];
                const profile = task.profiles[profileIndex];
                const flags = task.sharedWallFlags.get(profile.points);
                if (flags && flags.some((flag, index) => flag !== profile.sharedRetainingWallSegments?.[index])) {
                    // Even a distant retained profile is immutable. Recompute
                    // shared-wall visibility on detached records, then copy
                    // only profiles whose final flags actually changed.
                    const successor = { ...profile, sharedRetainingWallSegments: flags };
                    task.profiles[profileIndex] = successor;
                    const cached = task.profileCacheOverrides.get(profile.osmId)
                        || this._profileCache.get(profile.osmId);
                    if (cached) task.profileCacheOverrides.set(profile.osmId,
                        cached.map(entry => entry === profile ? successor : entry));
                    task.reindexAfterSharedWalls = true;
                }
                task.index++;
                return 'more';
            }
            task.sharedWallFlags = null;
            task.index = 0;
            if (task.reindexAfterSharedWalls) {
                task.surfaceIndex = new Map();
                task.civilGroundProfileIndex = new Map();
                task.phase = 'profile-indexes';
            } else task.phase = 'prepare-publication';
            return 'more';
        }

        if (task.phase === 'prepare-publication') {
            if (!task.publicationIterator) task.publicationIterator = this._prepareSurfacePublicationSteps(task);
            const next = task.publicationIterator.next();
            if (!next.done) return 'more';
            task.publication = next.value;
            task.publicationIterator = null;
            task.phase = 'publish';
            return 'more';
        }
        if (task.phase === 'publish') {
            if (this._publicationOwner) return 'prepared';
            this._publishPreparedBuild(task);
            return 'done';
        }

        return 'more';
    }

    pendingBuildPreparationPhase() {
        const task = this._pendingBuildPreparation;
        if (!this._dirty) return 'formation current';
        if (!task) return 'formation setup';
        if (task.phase === 'centerline-terrain'
            || task.phase === 'centerline-grade') {
            const total = task.centerlineEntries?.length || 0;
            return `formation ${task.phase} ${Math.min(task.index + 1, total)}/${total}`;
        }
        if (task.phase === 'surface-profiles') {
            const total = task.surfaceEntries?.length || 0;
            const detail = task.activeSurface?.profilePhase
                ? ` ${task.activeSurface.profilePhase}`
                : '';
            return `formation surface-profiles ${Math.min(task.index + 1, total)}/${total}${detail}`;
        }
        return `formation ${task.phase}`;
    }

    // Capture compiled query data, never the source/compiler caches. Callers
    // must supply callbacks bound to their immutable upstream generation; the
    // live model's terrain/alignment closures are deliberately not inherited.
    *captureReadSnapshotSteps(inputs) {
        if (this._dirty) throw new Error('Prepare the complete formation before capturing its query snapshot');
        const geometryRevision = this.surfaceGeometryRevision, publicationRevision = this.surfacePublicationRevision;
        const profiles = this._profiles;
        return yield* this._captureCompiledReadSnapshotSteps(inputs, {
            profiles, geometryRevision, publicationRevision, sourceRevision: this.surfaceGeometrySourceRevision,
            segmentsByOsmId: this._segmentsByOsmId, segmentIndex: this._segmentIndex,
            ownSegmentIndex: this._ownSegmentIndex, surfaceIndex: this._surfaceIndex,
            civilGroundProfileIndex: this._civilGroundProfileIndex, versions: this._surfaceGeometryVersions,
        }, () => !this._dirty && this._profiles === profiles && this.surfaceGeometryRevision === geometryRevision
            && this.surfacePublicationRevision === publicationRevision);
    }

    *_captureCompiledReadSnapshotSteps(inputs, compiled, isCurrent) {
        const readInputs = retainReadSnapshot(inputs?.readInputs, 'road-formation-query');
        let handedOff = false;
        try {
            if (!inputs || typeof inputs.baseSceneYAtLocal !== 'function') {
                throw new TypeError('Formation snapshot requires captured upstream ground');
            }
            for (const name of ['roadYOverrideAtLocal', 'roadStructureAtLocal', 'roadReplacementAtLocal']) {
                if (this[name] && typeof inputs[name] !== 'function') {
                    throw new TypeError(`Formation snapshot requires captured ${name}`);
                }
            }
            if (this.replacementTerrainCutoutRegions && !Array.isArray(inputs.replacementTerrainCutoutRegions)) {
                throw new TypeError('Formation snapshot requires captured replacement cutouts');
            }
            const { profiles, geometryRevision, publicationRevision } = compiled;
            const replacementRegions = Object.freeze([...(inputs.replacementTerrainCutoutRegions || [])]);
            const query = {
                anchorLat: this.anchorLat, anchorLon: this.anchorLon,
                metresPerDegreeLat: this.metresPerDegreeLat, metresPerDegreeLon: this.metresPerDegreeLon,
                baseSceneYAtLocal: inputs.baseSceneYAtLocal,
                roadYOverrideAtLocal: inputs.roadYOverrideAtLocal || null,
                roadStructureAtLocal: inputs.roadStructureAtLocal || null,
                roadReplacementAtLocal: inputs.roadReplacementAtLocal || null,
                replacementTerrainCutoutRegions: () => replacementRegions,
                _segmentsByOsmId: compiled.segmentsByOsmId,
                _segmentIndex: compiled.segmentIndex,
                _ownSegmentIndex: compiled.ownSegmentIndex,
                _surfaceIndex: new Map(),
                _civilGroundProfileIndex: new Map(),
                _profiles: [],
                _featureIdentities: this._featureIdentities,
                _civilGroundProfileChecks: 0,
                _segmentProjections: 0,
                _ensureBuilt() {},
            };
            const sourceIndexes = { _surfaceIndex: compiled.surfaceIndex, _civilGroundProfileIndex: compiled.civilGroundProfileIndex };
            const snapshots = new Map();
            let deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
            for (const profile of profiles) {
                // Geometry arrays belong to the immutable completed build. Only
                // publicationReady is updated separately on live profile wrappers.
                const snapshot = Object.freeze({ ...profile });
                snapshots.set(profile, snapshot);
                query._profiles.push(snapshot);
                if (formationBuildNowMs() >= deadline) {
                    yield { phase: 'formation-query-profile' };
                    deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
                }
            }
            Object.freeze(query._profiles);
            // A queue item is scarce while moving. Yield on time, checking each
            // member, rather than spending a whole item on every cheap map entry.
            yield { phase: 'formation-query-profile-end' };
            deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
            for (const [name, index] of Object.entries(sourceIndexes)) for (const [key, members] of index) {
                const copied = [];
                for (const profile of members) {
                    copied.push(snapshots.get(profile));
                    if (formationBuildNowMs() >= deadline) {
                        yield { phase: 'formation-query-index' };
                        deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
                    }
                }
                query[name].set(key, copied);
                if (formationBuildNowMs() >= deadline) {
                    yield { phase: 'formation-query-index' };
                    deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
                }
            }
            const versions = new Map();
            for (const [id, version] of compiled.versions) {
                versions.set(id, version);
                if (formationBuildNowMs() >= deadline) {
                    yield { phase: 'formation-query-version' };
                    deadline = formationBuildNowMs() + FORMATION_JUNCTION_STEP_BUDGET_MS;
                }
            }
            if (!isCurrent()) {
                const error = new Error('Formation changed while capturing its query snapshot');
                error.code = 'formation-snapshot-stale';
                throw error;
            }
            const methods = [
                'toLocal', '_baseY', '_nearestOnSegments', '_genericSegmentsNear', '_nearestOnOwnSegments',
                'formationAtLocal', 'sceneYAtLocal', 'groundSceneYAtLocal', 'civilGroundSceneYAtLocal',
                'hasDressedSurfaceBoundaryAtLocal', 'nearbyCenterlineSegments', 'surfaceAtLocal',
                'publishedSurfaceAtLocal', '_surfaceAtLocalBuilt', 'surfaceProfilesNear', 'dressingProfilesNear',
                'getSurfaceProfiles', 'getSurfaceProfilesForOsmId', 'getSurfaceProfilesForFeature',
                'getReplacementTerrainCutoutRegions',
            ];
            const result = {
                contract: 'station3d-road-formation-read-snapshot-v1',
                revision: geometryRevision, surfaceGeometryRevision: geometryRevision,
                surfaceGeometrySourceRevision: compiled.sourceRevision,
                surfacePublicationRevision: publicationRevision,
                hasPendingBuild: () => false,
                getSurfaceGeometryGeneration: id => versions.get(numericId(id)) || 0,
            };
            for (const name of methods) {
                query[name] = RoadFormationModel.prototype[name].bind(query);
                if (!name.startsWith('_')) result[name] = query[name];
            }
            handedOff = true;
            return ownReadSnapshot(result, [readInputs]);
        } finally {
            if (!handedOff) readInputs?.release?.();
        }
    }

    _ensureBuilt() {
        if (this._disposed) throw new Error('Road formation is disposed');
        // One compiler for synchronous and scheduled callers. In particular,
        // synchronous reads must not mutate the previous published profile's
        // junction flags while cooperative builds preserve it.
        if (this._publicationManaged) return;
        while (this.stepPendingBuildPreparation() !== 'done') {}
    }
}
