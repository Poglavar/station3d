// Proposal overlay layer (walk mode). Fetches one or more proposals from
// the consensus-builder API by ID and renders each according to its goal:
//
//   buildings  → LOCAL STYLE via the ordinary buildings pipeline (default), or
//                glass prisms / hidden — ?proposalsView=solid|ghost|off, N
//                cycles it live (core/proposal-building-display.js). Solid
//                hands the footprints to buildings.js as synthetic tiles
//                (core/proposal-building-features.js): frame-budgeted build,
//                aggregate batching, facades and roofs like the town around
//                them. (geometry.buildings: Feature[])
//   road-track → saved cross-section strips or tram rails/bed (geometry.roadPlan,
//                                                               metadata.isTrack selects tram)
//   park       → edited grass boundary + authored paths/ponds/planting/furniture
//   square     → edited paving boundary + authored fountains/trees/benches/stalls
//   lake       → water surface             (structureProposal.geometry: MultiPolygon
//                                           when geometry.lakeGraphics is null)
//
// Every kind also contributes to a unified footprint mask (isMaskedByProposals). That mask is what
// keeps the OSM/cadastre GROUND fabric from showing through a proposal: roads, lane markings, tram
// rails and decor under a new park, square, lake or street are swept away by it.
//
// EXISTING BUILDINGS ARE NOT MASKED THAT WAY. Road proposals are CARVED by the server: a road can
// demolish a building, cut a slice out of it, or TUNNEL under it, and only the proposal knows which.
// Proposed tracks intentionally use a simpler local rule: their smoothed construction corridor is
// indexed once, and every touched building is removed in full and shown only as a transparent
// ghost. The union mask cannot represent either policy. The one building mask that remains is
// buildingMaskPolygons: a PROPOSED building replaces the legacy one on its plot, and that is a
// substitution, not a demolition, so no server carve record exists for it.
//
// Buildings therefore wait for proposalsReady() before they are built, so a legacy building can
// never be drawn before its road-carve or track-demolition fate is known.
//
// structureProposal.geometry/decorations are authoritative for newly edited parks and squares;
// geometry.<kind>Graphics remains supported for old records.
//
// URL trigger: ?proposals=8,9,10,... on the /voznja walk-mode deeplink, and/or
// ?plan=<slug|ENS name> (sibenik-2066-1.proposals.urbangametheory.eth) which
// resolves a whole NAMED plan to its ids via GET /plans/<slug> (core/ens-plan.js).
// Single-session lifecycle — no tile streaming. Cleared on endSession.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
    scene,
    getGravelTexture,
    GRAVEL_UV_PER_M,
    getSidewalkTexture,
} from '../scene/setup.js';
import {
    DEG_TO_RAD,
    EARTH_RADIUS_M,
    cssColorToHex,
    finiteOrNull,
    haversineMeters,
} from '../core/math.js';
import { registerShared, disposeGroup } from '../core/dispose.js';
import { ProposalTrackImpactIndex } from '../core/proposal-track-impact.js';
import { getTerrainReference, isTerrainRequested } from './terrain.js';
import {
    PROPOSAL_BUILDING_TILE_SIZE_M,
    enqueueProposalBuildingTiles,
    pruneBuildingsByMask,
    setProposalBuildingMeshesVisible,
} from './buildings.js';
import {
    nextProposalBuildingDisplay,
    parseProposalBuildingDisplay,
    proposalBuildingDisplayPolicy,
} from '../core/proposal-building-display.js';
import { proposalBuildingFeaturesByTile } from '../core/proposal-building-features.js';
import { proposalCourtyardRings } from '../core/proposal-block-massing.js';
import { mergeProposalIds, parseEnsPlanParam } from '../core/ens-plan.js';
import { refineTriangulatedSurface } from '../core/road-formation.js';
import {
    proposalRoadFormationFeatures,
    proposalRoadFormationId,
} from '../core/proposal-road-formation.js';
import { isAuthoredPlannerRailFeature } from '../core/proposal-track.js';
import { proposalRoadSurfaceReady } from '../core/proposal-road-publication.js';
import {
    buildProposalRoadCurbGeometryData,
    buildProposalRoadCoastalClosureGeometryData,
    buildProposalRoadJunctionGeometryData,
    buildProposalRoadStationChunks,
    buildProposalRoadSurfaceGeometryData,
    proposalRoadFormationChangeTouchesBounds,
    proposalRoadStationChunksBounds,
    proposalRoadSurfaceOwnerNeedsRefresh,
} from '../core/proposal-road-surface.js';
import {
    drapeEdgeMForStep,
    sampleGroundRange,
} from '../core/proposal-ground.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { onWorldReady } from '../core/world-ready.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { getGrassTexture, GRASS_UV_PER_M, rebuildDecorForProposalMask } from './decor.js';
import {
    appendRoadFormationDressingToGroup,
    ASPHALT_UV_PER_M,
    getAsphaltMaterialForProposals,
    rebuildRoadsForProposalMask,
} from './roads.js';
import { addProposalRoadCenterlines } from './cars.js';
import { updateDemolishedCounter, hideDemolishedCounter } from '../ui/hud.js';
import { appendLaneMarkingStripsForLine, getLaneMarkingsDashMaterial, rebuildLaneMarkingsForProposalMask } from './lane-markings.js';
import { rebuildRailsForProposalMask } from './rails.js';
import {
    animateWaterMaterials,
    applyWorldXZWaterUvs,
    buildWaterBankGeometry,
    buildWaterShoreGeometry,
    createWaterBankMaterial,
    createWaterGroundCutoutMesh,
    createWaterMaterial,
    createWaterShoreMaterial,
} from './water-material.js';
import {
    isMappedSeaReady,
    isPointInMappedSea,
    mappedSeaSurfaceSceneY,
    subscribeMappedSeaChanges,
} from './water.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { WATER_LEVELS } from './ground-surface-levels.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';
import {
    getTrackbedHalfWidthMeters,
    TRAM_TRACKBED_WIDTH_M,
} from './tram-trackbed-dimensions.js';
import {
    buildProposalCorridorJunctionRing,
    buildProposalCorridorStripRing,
    findProposalCorridorJunctions,
    proposalCorridorLaneSeparators,
    proposalCorridorSegmentEntries,
    proposalCorridorStripSpans,
    sampleProposalCorridorOffset,
    splitProposalCorridorAtJunctions,
    topologizeProposalCorridorEntries,
} from './proposal-corridor.js';
import { getLocation } from '../core/locations.js';
import {
    loadRecordsById,
    shouldLoadLegacyGdiCarves,
} from '../core/prefetched-records.js';

let maskPolygons = [];      // Array<{ ring, holes, aabb }>  — union across all kinds
let maskRevision = 0;
let maskReadSnapshot = null;
// The subset contributed by proposal BUILDINGS only. A proposed building substitutes for whatever
// stood on its plot, and that substitution leaves no demolition record for the server carve to find
// — so this is the one mask existing buildings are still suppressed by. Roads, parks, squares and
// lakes are NOT in here: what they did to a building is the carve's answer to give, not the mask's.
let buildingMaskPolygons = [];
// object_id → { verdict: 'razed' | 'cut', faces, z_min, z_max } from POST /buildings/carve.
// Null until the fetch resolves; a building absent from the map is untouched by these proposals.
let legacyCarves = null;

// Unique object_ids of existing buildings the drawn track PASSES THROUGH and
// demolishes (rendered as transparent ghosts) — the client-side track-impact
// mechanism that works in every city (Split included), not the Zagreb-only GDI
// carve. buildings.js calls recordTrackDemolition() as each such building is
// first materialised; the HUD 🏚️ counter shows the running unique total.
const trackDemolishedIds = new Set();
// object_id → {lat, lon} centroid of each demolished building, so the ride can
// tell which ones the tram has driven PAST.
const trackDemolishedGeo = new Map();
// object_ids the current ride has already driven past. The 🏚️ HUD counter
// shows the size of THIS set — it ticks up as you drive through the buildings,
// like the kill counter, rather than showing the whole-route total up front.
const passedDemolishedIds = new Set();
// How close (m) the tram/walker must get to a demolished building's centroid
// for it to count as "passed".
const DEMOLITION_PASS_RADIUS_M = 30;

export function recordTrackDemolition(objectId, lat, lon) {
    if (objectId == null || trackDemolishedIds.has(objectId)) return;
    trackDemolishedIds.add(objectId);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        trackDemolishedGeo.set(objectId, { lat, lon });
    }
}

// Called each ride frame with the tram/walker geo position. Marks any
// not-yet-passed demolished building within DEMOLITION_PASS_RADIUS_M as passed
// and ticks the 🏚️ counter. Geo-space proximity (haversine) so it needs no
// scene-anchor conversion and works in every city.
export function markTrackDemolitionPassed(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || trackDemolishedGeo.size === 0) return;
    let changed = false;
    for (const [objectId, geo] of trackDemolishedGeo) {
        if (passedDemolishedIds.has(objectId)) continue;
        if (haversineMeters(lat, lon, geo.lat, geo.lon) <= DEMOLITION_PASS_RADIUS_M) {
            passedDemolishedIds.add(objectId);
            changed = true;
        }
    }
    if (changed) updateDemolishedCounter(passedDemolishedIds.size);
}

// Total buildings the current track demolishes (whole-route count, distinct
// from the passed-so-far figure the HUD counter shows).
export function getDemolishedBuildingCount() {
    return trackDemolishedIds.size;
}
// Smoothed proposal track corridor → binary existing-building demolition.
// Indexed once per session, then queried against each streamed building tile.
let proposalTrackImpactIndex = null;
// Session ctx the impact index reads its rail formation from, lazily — the
// formation does not exist yet when the index is constructed.
let proposalTrackImpactSessionCtx = null;
const PROPOSAL_TRACK_CONSTRUCTION_CLEARANCE_M = 0.75;
// Resolves once the proposals, track impact index, and road-carve verdicts are known. The buildings
// layer waits on it, so it never renders a legacy building before its fate is established.
let proposalsReadyPromise = Promise.resolve();
let activeBuildings = [];   // Array<{ ring, heightM, colorHex, modelUrl }>
let gltfLoader = null;      // lazily created; shared across loads
let activeParks = [];       // Array<{ ring, holes, aabb, decorations, hasAuthoredDecorations }>
let activeSquares = [];     // Array<{ ring, holes, aabb, decorations, hasAuthoredDecorations }>
let activeLakes = [];       // Array<{ ring, holes, aabb }>
let activeParkPonds = [];   // Authored pond polygons also count as walk-mode water.
let activeRoads = [];       // Array<{ ring, isTrack, id, topologyId, formationId, profile, line, renderLines, widthM }>
let activeRoadJunctions = []; // Array<{ ring, lat, lng, trimM, radiusM, formationIds, surfaceMesh }>
// Centerlines from `roadPlan.points` — one entry per proposal that has them,
// kept separate from the polygon list so we can inject them into the cars
// graph without re-deriving from the rendered surface. cars.js's
// addProposalRoadCenterlines consumes these after the layer's beginSession.
let activeRoadCenterlines = []; // Array<{ proposalId, isTrack, lineStrings: Array<Array<{lat,lng}>> }>
// Proposal carriageways join roads.js's existing RoadFormationModel. These
// synthetic tile keys are private to this one-session layer and are removed on
// teardown if roads.js is still alive (normal teardown clears the whole model
// first). Paths, parks, and plazas never enter this authority.
const PROPOSAL_ROAD_CENTERLINE_TILE_KEY = 'proposal-overlay:centerlines';
const PROPOSAL_ROAD_SURFACE_TILE_KEY = 'proposal-overlay:surfaces';
let proposalRoadFormationModel = null;
let registeredProposalRoadFormationIds = [];
let proposalsGroup = null;
// Proposal road, park, square, and path tops are included in the walk support raycast. Water and
// vertical furniture stay outside this group so the player cannot land on a pond or tree crown.
let proposalsWalkableGroup = null;
// Sub-group for proposal buildings only. Walk-mode's rooftop raycast in
// cab.js targets THIS group via getProposalsBuildingsGroup() so the
// player only lands on actual proposed buildings — not on tree foliage
// cones, fountain pillars, or ground-level park grass which would
// misplace the camera several metres above where it should be.
let proposalsBuildingsGroup = null;
// Glass prisms only (the `ghost` display state) — a sub-group of the buildings
// group so one visible flag shows/hides every prism, while uploaded glTF
// models (which are the bespoke look, not a diagram) stay direct children of
// proposalsBuildingsGroup and hide only in `off`.
let proposalsGhostGroup = null;
let proposalGlassTexture = null;

// Display state for proposal BUILDINGS (solid | ghost | off) — the model lives
// in core/proposal-building-display.js. Solid routes the footprints through
// the ordinary buildings pipeline (local style, frame-budgeted, batched);
// ghost is the old glass prism; both are built lazily on first entry into
// their state, then toggled by visibility.
let buildingDisplayState = 'solid';
let solidBuildingsEnqueued = false;
let ghostBuildingsEmitted = false;
let buildingsEmitAnchor = null;   // { anchorLat, anchorLon } captured at emitAll

function consensusApiBase() {
    // Dev escape hatches. ?consensusApi=prod hits the public API directly
    // (CORS may bite on a localhost origin); ?consensusApi=fixture reads
    // from /dev-proposal-fixtures/<id>.json, which works offline and is
    // the path the dev fixtures live under; an absolute origin points at a
    // specific local backend — the localhost default below is port 3000, and
    // whichever worktree's server holds that port may not have the proposals
    // you're testing (?consensusApi=http://localhost:4583).
    if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        const override = params.get('consensusApi');
        if (override === 'prod') return 'https://api.urbangametheory.xyz';
        if (override === 'fixture') return '__fixture__';
        // An absolute API origin is a dev-only escape hatch; honoring it on the
        // public origin would let a crafted link point the sim at an
        // attacker-controlled backend. Restrict it to localhost.
        const oh = (window.location.hostname || '').toLowerCase();
        if (override && /^https?:\/\//.test(override) && ['localhost', '127.0.0.1'].includes(oh)) {
            return override.replace(/\/+$/, '');
        }
    }
    const h = (typeof window !== 'undefined' && window.location && window.location.hostname || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

function proposalUrl(id) {
    const base = consensusApiBase();
    if (base === '__fixture__') return `/dev-proposal-fixtures/${encodeURIComponent(id)}.json`;
    return `${base}/proposals/${encodeURIComponent(id)}`;
}

// Resolve a NAMED plan (?plan=<slug|ENS name>, normalized upstream) to its
// proposal ids via GET /plans/<slug>. Fixture mode reads the dumped plan from
// /dev-proposal-fixtures/plans/<slug>.json so an offline session still opens
// a whole plan by name.
async function loadPlanProposalIds(slug) {
    const base = consensusApiBase();
    const url = base === '__fixture__'
        ? `/dev-proposal-fixtures/plans/${encodeURIComponent(slug)}.json`
        : `${base}/plans/${encodeURIComponent(slug)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    const plan = await res.json();
    const planIds = Array.isArray(plan && plan.proposalIds) ? plan.proposalIds : [];
    if (planIds.length === 0) {
        console.warn(`[proposals] plan "${slug}" resolved but carries no proposals`);
    }
    return planIds;
}

function ringAabb(ring) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of ring) {
        const lon = p[0], lat = p[1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    }
    return { minLat, maxLat, minLon, maxLon };
}

function addMaskPolygon(ring, aabb = null, holes = []) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    // Mask readers can outlive a proposal edit while their road/rail builders
    // yield. Own the coordinates once here; never freeze the author's arrays.
    const ownRing = value => Object.freeze(value.map(point => Object.freeze([...point])));
    ring = ownRing(ring);
    const validHoles = Array.isArray(holes)
        ? holes.filter((hole) => Array.isArray(hole) && hole.length >= 3).map(ownRing)
        : [];
    const polyAabb = Object.freeze(aabb ? { ...aabb } : ringAabb(ring));
    const centroid = ringCentroidLatLon(ring);
    const poly = Object.freeze({
        ring,
        holes: Object.freeze(validHoles),
        aabb: polyAabb,
        centroid: centroid && !validHoles.some((hole) => pointInRing(centroid.lat, centroid.lon, hole))
            ? Object.freeze(centroid)
            : null,
    });
    maskPolygons.push(poly);
    maskRevision++;
    maskReadSnapshot = null;
    return poly;
}

function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const crosses = ((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (crosses) inside = !inside;
    }
    return inside;
}

function pointInMaskPolygon(lat, lon, polygon) {
    if (!polygon || !pointInRing(lat, lon, polygon.ring)) return false;
    return !(polygon.holes || []).some((hole) => pointInRing(lat, lon, hole));
}

function orient(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, c) {
    const eps = 1e-12;
    return Math.min(a[0], b[0]) - eps <= c[0] && c[0] <= Math.max(a[0], b[0]) + eps
        && Math.min(a[1], b[1]) - eps <= c[1] && c[1] <= Math.max(a[1], b[1]) + eps
        && Math.abs(orient(a, b, c)) <= eps;
}

function segmentsIntersect(a, b, c, d) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
    return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function ringsIntersect(aRing, bRing) {
    const aN = Array.isArray(aRing) ? aRing.length : 0;
    const bN = Array.isArray(bRing) ? bRing.length : 0;
    if (aN < 3 || bN < 3) return false;
    for (let ai = 0; ai < aN; ai++) {
        const a0 = aRing[ai];
        const a1 = aRing[(ai + 1) % aN];
        if (!a0 || !a1 || (ai === aN - 1 && a0[0] === a1[0] && a0[1] === a1[1])) continue;
        for (let bi = 0; bi < bN; bi++) {
            const b0 = bRing[bi];
            const b1 = bRing[(bi + 1) % bN];
            if (!b0 || !b1 || (bi === bN - 1 && b0[0] === b1[0] && b0[1] === b1[1])) continue;
            if (segmentsIntersect(a0, a1, b0, b1)) return true;
        }
    }
    return false;
}

// All outer rings, for either Polygon or MultiPolygon. Inner rings (holes)
// are dropped here — callers that need to preserve courtyards / cutouts
// (e.g. building rule proposals shaped as perimeter blocks around an
// open inner court) should use extractRingsWithHoles below instead.
function unwrapGeometry(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'Feature') return value.geometry || null;
    return value.geometry && !value.coordinates ? value.geometry : value;
}

function extractAllOuterRings(geometry) {
    geometry = unwrapGeometry(geometry);
    if (!geometry) return [];
    if (geometry.type === 'Polygon') {
        const ring = geometry.coordinates && geometry.coordinates[0];
        return Array.isArray(ring) && ring.length >= 3 ? [ring] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const out = [];
        for (const poly of geometry.coordinates || []) {
            const ring = poly && poly[0];
            if (Array.isArray(ring) && ring.length >= 3) out.push(ring);
        }
        return out;
    }
    return [];
}

// Returns Array<{outer, holes}> — outer ring + any inner rings (holes).
// GeoJSON Polygon `coordinates` is `[outer, hole1, hole2, ...]`; we keep
// every inner ring with at least 3 vertices so courtyards survive
// through the extrude pass below as actual cutouts in the building.
function extractRingsWithHoles(geometry) {
    geometry = unwrapGeometry(geometry);
    if (!geometry) return [];
    const consume = (rings) => {
        if (!Array.isArray(rings) || rings.length === 0) return null;
        const outer = rings[0];
        if (!Array.isArray(outer) || outer.length < 3) return null;
        const holes = [];
        for (let i = 1; i < rings.length; i++) {
            const r = rings[i];
            if (Array.isArray(r) && r.length >= 3) holes.push(r);
        }
        return { outer, holes };
    };
    if (geometry.type === 'Polygon') {
        const p = consume(geometry.coordinates);
        return p ? [p] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const out = [];
        for (const poly of geometry.coordinates || []) {
            const p = consume(poly);
            if (p) out.push(p);
        }
        return out;
    }
    return [];
}

function ringCentroidLatLon(ring) {
    if (!Array.isArray(ring) || ring.length === 0) return null;
    const last = ring[ring.length - 1];
    const isClosed = ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1];
    const upper = isClosed ? ring.length - 1 : ring.length;
    if (upper === 0) return null;
    let sumLat = 0, sumLon = 0;
    for (let i = 0; i < upper; i++) {
        sumLon += ring[i][0];
        sumLat += ring[i][1];
    }
    return { lat: sumLat / upper, lon: sumLon / upper };
}

// Centroid of a GeoJSON feature's outer ring. Used by buildings.js to
// decide whether a cadastre footprint sits under any proposal polygon.
export function featureCentroidLatLon(feature) {
    return ringCentroidLatLon(extractAllOuterRings(feature && feature.geometry)[0] || null);
}

// Centroid + 4 AABB corners of a feature, in lat/lon. Used by the
// proposal mask: a cadastre building straddling a proposal polygon's
// boundary has its centroid outside the polygon (so centroid-only
// masking missed it), but at least one corner is inside — so the
// building correctly counts as "replaced" and gets skipped. Returns
// at most 5 points; empty array if the feature has no usable ring.
export function featureSamplePointsLatLon(feature) {
    const ring = extractAllOuterRings(feature && feature.geometry)[0];
    if (!ring) return [];
    const c = ringCentroidLatLon(ring);
    const a = ringAabb(ring);
    const out = [];
    if (c) out.push(c);
    out.push({ lat: a.minLat, lon: a.minLon });
    out.push({ lat: a.minLat, lon: a.maxLon });
    out.push({ lat: a.maxLat, lon: a.minLon });
    out.push({ lat: a.maxLat, lon: a.maxLon });
    return out;
}

// LineString variant of the feature mask: tests if any vertex of a
// LineString sits inside any proposal polygon. Used by rails.js,
// lane-markings.js, and any other layer that streams LineString
// features — those carry centerlines, not footprints, so the AABB-
// corner sample for polygons doesn't apply.
export function isLineStringMaskedByProposals(feature, polygons = maskPolygons) {
    if (polygons.length === 0) return false;
    const geom = feature && feature.geometry;
    if (!geom || geom.type !== 'LineString') return false;
    const coords = geom.coordinates;
    if (!Array.isArray(coords)) return false;
    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (Array.isArray(c)) {
            for (const poly of polygons) {
                const a = poly.aabb;
                if (c[1] < a.minLat || c[1] > a.maxLat || c[0] < a.minLon || c[0] > a.maxLon) continue;
                if (pointInMaskPolygon(c[1], c[0], poly)) return true;
            }
        }
        if (i === 0) continue;
        const prev = coords[i - 1];
        if (!Array.isArray(prev) || !Array.isArray(c)) continue;
        for (const poly of polygons) {
            const a = poly.aabb;
            const minLon = Math.min(prev[0], c[0]);
            const maxLon = Math.max(prev[0], c[0]);
            const minLat = Math.min(prev[1], c[1]);
            const maxLat = Math.max(prev[1], c[1]);
            if (maxLat < a.minLat || minLat > a.maxLat || maxLon < a.minLon || minLon > a.maxLon) continue;
            const midLat = (prev[1] + c[1]) * 0.5;
            const midLon = (prev[0] + c[0]) * 0.5;
            if (pointInMaskPolygon(midLat, midLon, poly)) return true;
            const ring = poly.ring;
            for (let r = 0; r < ring.length; r++) {
                const p0 = ring[r];
                const p1 = ring[(r + 1) % ring.length];
                if (p0 && p1 && segmentsIntersect(prev, c, p0, p1)) return true;
            }
        }
    }
    return false;
}

// Convenience: true if the feature overlaps any polygon in `polys` (the union mask by default).
// Cheap AABB prefilter first, then point containment and finally edge
// intersections. The edge pass matters for long, narrow road/rail footprints:
// their corners can sit outside a lake while the grey band still crosses it.
export function isFeatureMaskedByProposals(feature, polys = maskPolygons) {
    if (polys.length === 0) return false;
    const rings = extractAllOuterRings(feature && feature.geometry);
    if (rings.length === 0) return false;
    for (const ring of rings) {
        const fAabb = ringAabb(ring);
        const featureCentroid = ringCentroidLatLon(ring);
        for (const poly of polys) {
            const pAabb = poly.aabb;
            if (fAabb.maxLat < pAabb.minLat || fAabb.minLat > pAabb.maxLat) continue;
            if (fAabb.maxLon < pAabb.minLon || fAabb.minLon > pAabb.maxLon) continue;
            // AABBs overlap. Try 5 feature points first.
            const pts = [
                featureCentroid,
                { lat: fAabb.minLat, lon: fAabb.minLon },
                { lat: fAabb.minLat, lon: fAabb.maxLon },
                { lat: fAabb.maxLat, lon: fAabb.minLon },
                { lat: fAabb.maxLat, lon: fAabb.maxLon },
            ];
            for (const p of pts) {
                if (p && pointInMaskPolygon(p.lat, p.lon, poly)) return true;
            }
            for (const v of ring) {
                if (v && pointInMaskPolygon(v[1], v[0], poly)) return true;
            }
            for (const v of poly.ring) {
                if (v && pointInRing(v[1], v[0], ring)) return true;
            }
            const pc = poly.centroid;
            if (pc && pointInRing(pc.lat, pc.lon, ring)) return true;
            if (ringsIntersect(ring, poly.ring)) return true;
        }
    }
    return false;
}

// One immutable query per proposal revision, shared by all waiting builders.
// Its answer stays fixed after an edit; validity tells publication to retry.
export function captureProposalMaskSnapshot() {
    if (maskReadSnapshot) return maskReadSnapshot;
    const polygons = Object.freeze(maskPolygons.slice());
    const revision = maskRevision;
    maskReadSnapshot = Object.freeze({
        revision,
        isCurrent: () => maskRevision === revision,
        isFeatureMasked: feature => isFeatureMaskedByProposals(feature, polygons),
        isLineStringMasked: feature => isLineStringMaskedByProposals(feature, polygons),
    });
    return maskReadSnapshot;
}

// Walk-mode's rooftop raycast in cab.js targets this BUILDINGS-only
// sub-group so the player only lands on actual proposed buildings —
// not on tree foliage cones, fountain pillars, or ground-level park
// grass which would misplace the camera several metres above where it
// should be. Returns null until at least one proposal building has
// rendered.
export function getProposalsBuildingsGroup() {
    return proposalsBuildingsGroup;
}

export function getProposalsWalkableGroup() {
    return proposalsWalkableGroup;
}

// Union mask: true if (lat, lon) sits inside ANY collected proposal
// polygon — building, park, square, lake, or road. Drives the ground fabric (roads, lane markings,
// rails, decor). NOT the existing-buildings decision: see isFeatureMaskedByProposalBuildings.
export function isMaskedByProposals(lat, lon) {
    if (maskPolygons.length === 0) return false;
    for (const poly of maskPolygons) {
        const a = poly.aabb;
        if (lat < a.minLat || lat > a.maxLat || lon < a.minLon || lon > a.maxLon) continue;
        if (pointInMaskPolygon(lat, lon, poly)) return true;
    }
    return false;
}

// The only mask an EXISTING building is still subject to: a PROPOSED building stands where it
// stood. Everything else a proposal does to an existing building — raze it, cut it, tunnel under
// it — is the server's carve to decide, and blanket-masking those away is exactly the bug this
// replaced (a tunnelled building vanished instead of surviving).
export function isFeatureMaskedByProposalBuildings(feature) {
    return isFeatureMaskedByProposals(feature, buildingMaskPolygons);
}

export function isMaskedByProposalBuildings(lat, lon) {
    if (buildingMaskPolygons.length === 0) return false;
    for (const poly of buildingMaskPolygons) {
        const a = poly.aabb;
        if (lat < a.minLat || lat > a.maxLat || lon < a.minLon || lon > a.maxLon) continue;
        if (pointInMaskPolygon(lat, lon, poly)) return true;
    }
    return false;
}

// What the loaded proposals did to the existing building with this object_id:
//   null                                → untouched (also every TUNNELLED building)
//   { verdict: 'razed' }                → do not render it
//   { verdict: 'cut', faces, z_min, … } → render `faces` instead of the building's own
export function getLegacyBuildingCarve(objectId) {
    if (!legacyCarves || objectId == null) return null;
    return legacyCarves.get(objectId) || null;
}

export function isFeatureDemolishedByProposalTrack(feature) {
    return proposalTrackImpactIndex?.intersectsFeature(feature) || false;
}

// The buildings layer awaits this before it builds anything, so no legacy building is ever drawn
// before its fate is known. Resolved immediately when the deeplink carries no proposals.
export function proposalsReady() {
    return proposalsReadyPromise;
}

export function isPointInProposalLake(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    for (const lake of [...activeLakes, ...activeParkPonds]) {
        const a = lake.aabb;
        if (a && (lat < a.minLat || lat > a.maxLat || lon < a.minLon || lon > a.maxLon)) continue;
        if (!pointInRing(lat, lon, lake.ring)) continue;
        if (Array.isArray(lake.holes) && lake.holes.some((hole) => pointInRing(lat, lon, hole))) continue;
        return true;
    }
    return false;
}

// ─── Per-kind extraction from a fetched proposal ───────────────────────────

function collectBuildingFeatures(proposal) {
    if (!proposal) return [];
    if (Array.isArray(proposal.geometry && proposal.geometry.buildings) && proposal.geometry.buildings.length) {
        return proposal.geometry.buildings;
    }
    const bp = proposal.buildingProposal;
    if (bp && Array.isArray(bp.buildings) && bp.buildings.length) {
        return bp.buildings.map((e) => e && e.feature).filter(Boolean);
    }
    return [];
}

function legacyBlockGeometryOps() {
    const turf = globalThis.turf;
    if (!turf || typeof turf.union !== 'function'
        || typeof turf.buffer !== 'function' || typeof turf.area !== 'function') return null;
    return {
        union: features => turf.union({ type: 'FeatureCollection', features }),
        buffer: (feature, distanceM) => turf.buffer(feature, distanceM, { units: 'meters' }),
        area: feature => turf.area(feature),
    };
}

function ingestBuildings(proposal) {
    const courtyardRings = proposalCourtyardRings(proposal, legacyBlockGeometryOps());
    let courtyardAssigned = false;
    for (const f of collectBuildingFeatures(proposal)) {
        // Polygon-with-holes is the building-rule case: outer = perimeter
        // block, inner ring(s) = courtyard cutouts. MultiPolygon means
        // a single feature shipped multiple disjoint pieces — we treat
        // each piece as its own extrusion so the courtyard hole travels
        // with the right outer ring.
        const polys = extractRingsWithHoles(f && f.geometry);
        if (polys.length === 0) continue;
        const heightRaw = Number(f.properties && f.properties.height);
        const colorRaw = f.properties && f.properties.color;
        const heightM = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : 6;
        const colorHex = typeof colorRaw === 'string' ? cssColorToHex(colorRaw) : null;
        // Uploaded buildings carry a glTF model URL — render the real mesh instead of an
        // extruded footprint. Attach it to the first piece only so a split feature doesn't
        // spawn the model multiple times.
        const modelUrl = (f.properties && typeof f.properties.modelUrl === 'string' && f.properties.modelUrl)
            ? f.properties.modelUrl : null;
        let firstPiece = true;
        for (const { outer, holes } of polys) {
            // Mask uses the OUTER ring only — the courtyard area inside
            // a perimeter-block proposal still replaces whatever was
            // there in the cadastre, even if the building itself has a
            // hole over the courtyard.
            // A proposed building also goes into buildingMaskPolygons: it SUBSTITUTES for whatever
            // stood on its plot, which leaves no demolition record for the server carve to find, so
            // this is the one case where an existing building is still suppressed by a mask.
            const poly = addMaskPolygon(outer);
            if (poly) buildingMaskPolygons.push(poly);
            activeBuildings.push({
                ring: outer,
                holes,
                ...(!courtyardAssigned && courtyardRings.length ? { courtyardRings } : {}),
                heightM,
                colorHex,
                modelUrl: firstPiece ? modelUrl : null,
                proposalId: proposal.id ?? proposal.proposalId ?? null,
            });
            if (!courtyardAssigned && courtyardRings.length) courtyardAssigned = true;
            firstPiece = false;
        }
    }
}

// Current edited structures put their authoritative boundary and furniture in structureProposal,
// while older records use geometry.<kind>Graphics. A brief serializer generation also wrote the raw
// GeoJSON geometry at the top level, so all three shapes are accepted at this one schema boundary.
function geometryForKind(proposal, key, kind) {
    const container = proposal && proposal.geometry;
    const structure = proposal && proposal.structureProposal;
    if (structure && String(structure.kind || '').toLowerCase() === kind) {
        if (extractRingsWithHoles(structure.geometry).length > 0) return structure.geometry;
    }
    const direct = container && typeof container === 'object' ? container[key] : null;
    if (extractRingsWithHoles(direct).length > 0) return direct;
    if (String(proposal && proposal.goal || '').toLowerCase() === kind
        && extractRingsWithHoles(container).length > 0) {
        return container;
    }
    return null;
}

function decorationsForKind(proposal, key, kind) {
    const structure = proposal && proposal.structureProposal;
    if (structure && String(structure.kind || '').toLowerCase() === kind
        && structure.decorations && typeof structure.decorations === 'object') {
        return { value: structure.decorations, authored: true };
    }
    const direct = proposal && proposal.geometry && proposal.geometry[key];
    const properties = direct && direct.type === 'Feature' ? direct.properties : null;
    if (properties && properties.decorations && typeof properties.decorations === 'object') {
        return { value: properties.decorations, authored: true };
    }
    if (proposal && proposal.decorations && typeof proposal.decorations === 'object') {
        return { value: proposal.decorations, authored: true };
    }
    return { value: null, authored: false };
}

function ingestParks(proposal) {
    const polygons = extractRingsWithHoles(geometryForKind(proposal, 'parkGraphics', 'park'));
    const decorations = decorationsForKind(proposal, 'parkGraphics', 'park');
    polygons.forEach(({ outer, holes }, index) => {
        const aabb = ringAabb(outer);
        activeParks.push({
            ring: outer,
            holes,
            aabb,
            decorations: index === 0 ? decorations.value : null,
            hasAuthoredDecorations: decorations.authored,
        });
        addMaskPolygon(outer, aabb, holes);
    });
    if (decorations.authored && Array.isArray(decorations.value.ponds)) {
        for (const ring of decorations.value.ponds) {
            if (!Array.isArray(ring) || ring.length < 3) continue;
            activeParkPonds.push({ ring, holes: [], aabb: ringAabb(ring) });
        }
    }
}

function ingestSquares(proposal) {
    const polygons = extractRingsWithHoles(geometryForKind(proposal, 'squareGraphics', 'square'));
    const decorations = decorationsForKind(proposal, 'squareGraphics', 'square');
    polygons.forEach(({ outer, holes }, index) => {
        const aabb = ringAabb(outer);
        activeSquares.push({
            ring: outer,
            holes,
            aabb,
            decorations: index === 0 ? decorations.value : null,
            hasAuthoredDecorations: decorations.authored,
        });
        addMaskPolygon(outer, aabb, holes);
    });
}

function ingestLakes(proposal) {
    for (const { outer, holes } of extractRingsWithHoles(geometryForKind(proposal, 'lakeGraphics', 'lake'))) {
        const aabb = ringAabb(outer);
        activeLakes.push({ ring: outer, holes, aabb });
        addMaskPolygon(outer, aabb, holes);
    }
}

const DEFAULT_PROPOSAL_ROAD_WIDTH_M = 8;

function ingestRoads(proposal) {
    const rp = (proposal.geometry && proposal.geometry.roadPlan)
        || proposal.definition
        || (proposal.roadProposal && proposal.roadProposal.definition);
    if (!rp) return;
    const isTrack = !!(rp.metadata && rp.metadata.isTrack);
    const proposalId = proposal.id ?? proposal.proposalId;
    const entries = proposalCorridorSegmentEntries(rp, DEFAULT_PROPOSAL_ROAD_WIDTH_M).map((entry, index) => ({
        ...entry,
        // Track proposals retain Station3D's canonical double-rail bed. Their planning
        // right-of-way/profile is not a second grey slab outside those rails.
        widthM: isTrack ? TRAM_TRACKBED_WIDTH_M : entry.widthM,
        formationId: isTrack
            ? null
            : proposalRoadFormationId(proposalId, entry.id, index),
        topologyId: isTrack
            ? `proposal-track:${proposalId ?? 'unknown'}:${entry.id}:${index}`
            : proposalRoadFormationId(proposalId, entry.id, index),
    }));
    for (const entry of entries) {
        activeRoads.push({
            ring: null,
            isTrack,
            id: entry.id,
            topologyId: entry.topologyId,
            proposalId,
            formationId: entry.formationId,
            profile: isTrack ? null : entry.profile,
            line: entry.points,
            renderLines: [],
            widthM: entry.widthM,
        });
    }
    if (entries.length === 0) {
        if (isTrack) return;
        const rings = extractAllOuterRings(rp.polygon);
        if (rings.length > 0) {
            for (const ring of rings) {
                activeRoads.push({
                    ring,
                    isTrack,
                    id: null,
                    proposalId,
                    formationId: null,
                    profile: null,
                    line: null,
                    renderLines: [],
                    widthM: null,
                });
                addMaskPolygon(ring);
            }
        }
    }
}

// Resolve the complete plan together, not one proposal at a time. Junctions
// routinely connect road segments saved in different proposal records; doing
// this inside ingestRoads left those physically meeting roads as independent
// strips, each free to cap and form an embankment across the other.
function finalizeProposalRoadCorridors() {
    activeRoadJunctions = [];
    activeRoadCenterlines = [];
    const ordinaryRoads = activeRoads.filter(road => (
        !road.isTrack && Array.isArray(road.line) && road.line.length >= 2
    ));
    const topologyEntries = topologizeProposalCorridorEntries(ordinaryRoads.map(road => ({
        id: road.id,
        topologyId: road.topologyId,
        points: road.line,
        widthM: road.widthM,
        road,
    })));
    const entryByTopologyId = new Map(topologyEntries.map(entry => [entry.topologyId, entry]));
    const junctions = findProposalCorridorJunctions(topologyEntries);

    for (const road of activeRoads) {
        if (!Array.isArray(road.line) || road.line.length < 2) continue;
        const entry = road.isTrack ? null : entryByTopologyId.get(road.topologyId);
        if (entry) road.line = entry.points;
        road.ring = buildProposalCorridorStripRing(
            road.line,
            road.widthM / 2,
            -road.widthM / 2,
        );
        if (!road.ring) continue;
        road.renderLines = road.isTrack
            ? [{ points: road.line, junctionStart: false, junctionEnd: false }]
            : splitProposalCorridorAtJunctions(entry, junctions);
        addMaskPolygon(road.ring);
    }

    for (const junction of junctions.values()) {
        const ring = buildProposalCorridorJunctionRing(junction);
        if (!ring) continue;
        const formationIds = ordinaryRoads
            .filter(road => junction.entryIds.has(road.topologyId))
            .map(road => road.formationId)
            .filter(Boolean);
        activeRoadJunctions.push({ ...junction, ring, formationIds });
        addMaskPolygon(ring);
    }

    const centerlineGroups = new Map();
    for (const road of activeRoads) {
        if (!Array.isArray(road.line) || road.line.length < 2) continue;
        const key = `${road.proposalId ?? 'unknown'}|${road.isTrack ? 'track' : 'road'}`;
        let group = centerlineGroups.get(key);
        if (!group) {
            group = {
                proposalId: road.proposalId,
                isTrack: road.isTrack,
                lineStrings: [],
                formationIds: [],
            };
            centerlineGroups.set(key, group);
        }
        group.lineStrings.push(road.line);
        group.formationIds.push(road.formationId);
    }
    activeRoadCenterlines = Array.from(centerlineGroups.values());
}

function registerProposalRoadFormation() {
    if (!proposalRoadFormationModel) return;
    const { centerlines, surfaces } = proposalRoadFormationFeatures(activeRoads);
    registeredProposalRoadFormationIds = Array.from(new Set(surfaces
        .map(feature => feature?.properties?.osm_id)
        .filter(id => id != null)
        .map(String)));
    // The profiles are needed to construct level road tops and their complete
    // cut/fill dressing, but terrain ownership is not. Keep every proposal id
    // unpublished until its visible surface transaction has committed.
    proposalRoadFormationModel.setSurfacePublicationReadyForOsmIds(
        registeredProposalRoadFormationIds,
        false,
    );
    proposalRoadFormationModel.setCenterlineTile(
        PROPOSAL_ROAD_CENTERLINE_TILE_KEY,
        centerlines,
    );
    proposalRoadFormationModel.setSurfaceTile(
        PROPOSAL_ROAD_SURFACE_TILE_KEY,
        surfaces,
    );
}

function unregisterProposalRoadFormation() {
    if (!proposalRoadFormationModel) return;
    // Close ownership before visible meshes disappear. The formation rebuild
    // is cooperative, so its last complete profile generation can otherwise
    // outlive these synthetic tiles briefly and reopen a terrain-only hole.
    proposalRoadFormationModel.setSurfacePublicationReadyForOsmIds(
        registeredProposalRoadFormationIds,
        false,
    );
    proposalRoadFormationModel.removeCenterlineTile(PROPOSAL_ROAD_CENTERLINE_TILE_KEY);
    proposalRoadFormationModel.removeSurfaceTile(PROPOSAL_ROAD_SURFACE_TILE_KEY);
    registeredProposalRoadFormationIds = [];
    proposalRoadFormationModel = null;
}

async function fetchOne(id) {
    const url = proposalUrl(id);
    try {
        const r = await fetch(url, { credentials: 'omit' });
        if (!r.ok) {
            console.warn(`[proposals] fetch ${id} failed: HTTP ${r.status}`);
            return null;
        }
        return await r.json();
    } catch (err) {
        console.warn(`[proposals] fetch ${id} error:`, err);
        return null;
    }
}

// What the proposals did to the EXISTING buildings under them. consensus-builder owns this answer —
// it is the only thing that knows a road tunnels under a building rather than through it — and it
// runs the same carve module its own 3D view runs, so the sim and the app cannot disagree.
//
// Only AFFECTED buildings come back, keyed by the `gdi_building_3d` (was `building_3d`) object_id the cadastre API also
// serves them under. The buildings layer keeps its own mesh source (facade colours and building
// types this endpoint does not carry) and simply applies these verdicts to it.
async function loadLegacyCarves(ids, cityId) {
    legacyCarves = new Map();
    // The carve service and object IDs are Zagreb GDI contracts. Split uses
    // Overture buildings, so submitting a Split proposal as city:'zagreb'
    // performed expensive, irrelevant geometry work and could never match a
    // rendered Split building.
    if (!shouldLoadLegacyGdiCarves(cityId)) return;
    const base = consensusApiBase();
    if (base === '__fixture__') return;   // offline fixtures carry no carve
    try {
        const r = await fetch(`${base}/buildings/carve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({ proposals: ids.map(String), city: cityId }),
        });
        if (!r.ok) {
            console.warn(`[proposals] carve fetch failed: HTTP ${r.status} — existing buildings will render uncarved`);
            return;
        }
        const data = await r.json();
        legacyCarves = new Map((data.carves || []).map((c) => [c.object_id, c]));
        const razed = (data.carves || []).filter((c) => c.verdict === 'razed').length;
        console.log(`[proposals] carve: ${legacyCarves.size} existing buildings affected (${razed} razed, ${legacyCarves.size - razed} cut)`);
    } catch (err) {
        console.warn('[proposals] carve fetch error — existing buildings will render uncarved:', err);
    }
}

// consensus-builder uses several goal values for building proposals — 'single'
// (one building), 'buildings'/'residences' (multiple), 'row', and 'parcelBased'.
// Earlier we only matched 'buildings', so single-building proposals (goal: 'single')
// rendered nothing in walk mode even though their geometry was present.
const BUILDING_GOALS = new Set(['buildings', 'single', 'row', 'parcelbased']);

async function loadProposals(ids, prefetchedRecords = null) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const proposals = await loadRecordsById(ids, prefetchedRecords, fetchOne);
    for (const p of proposals) {
        if (!p) continue;
        const goal = p.goal;
        const goalKey = typeof goal === 'string' ? goal.toLowerCase() : '';
        if (BUILDING_GOALS.has(goalKey))       ingestBuildings(p);
        else if (goalKey === 'park')           ingestParks(p);
        else if (goalKey === 'square')         ingestSquares(p);
        else if (goalKey === 'lake')           ingestLakes(p);
        else if (goalKey === 'road-track')     ingestRoads(p);
        // 'reparcellization' / 'decide-later' carry no rendering geometry.
    }
    finalizeProposalRoadCorridors();
}

// ─── Shared materials ──────────────────────────────────────────────────────

const sharedMats = {};
function getMat(key, factory) {
    if (sharedMats[key]) return sharedMats[key];
    const m = factory();
    registerShared(m);
    sharedMats[key] = m;
    return m;
}

const PARK_SURFACE_Y = 0.17;
const SQUARE_SURFACE_Y = 0.20;
const PATH_SURFACE_Y = 0.22;
const PROPOSAL_ROAD_Y = 0.10;
const PROPOSAL_ROAD_STRIP_Y = 0.108;
const PROPOSAL_LANE_MARKING_Y = 0.118;
const PROPOSAL_RAISED_STRIP_Y = 0.25;
const PROPOSAL_FLOWERBED_Y = 0.232;

// Ground-plane (groundMesh in scene/setup.js) sits at y=0 covering the
// whole world, so replacement surfaces use polygonOffset as well as a small
// height separation to win depth tests against streamed infrastructure.
//
// DoubleSide is required because makeGroundGeometry's Y→Z remap inverts
// triangle winding so the resulting normals point DOWN — single-sided
// rendering would backface-cull them when the camera is above.
const GROUND_SHARED = {
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
};

function proposalSurfaceClaim(surfaceClass, ownerId, options = {}) {
    return compileSurfaceClaim({
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: surfaceClass === SURFACE_CLASS.WATER ? null : 'ground',
        ownerId,
        sourceId: 'world/proposals.js',
        supportReady: options.supportReady === true,
        cutsBackstop: options.cutsBackstop === true,
    });
}

function authorizeProposalSurfaceMaterial(material, claim) {
    applySurfaceStencil(material, claim);
    applyGroundOwnership(material, claim);
    applyPlannerSurfaceCutout(material, claim);
    return material;
}

const PROPOSAL_GRASS_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.PASSIVE_LANDUSE,
    'proposal-grass',
);
const PROPOSAL_PATH_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.BUFFERED_SIDEWALK,
    'proposal-path',
    { supportReady: true, cutsBackstop: true },
);
const PROPOSAL_WATER_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.WATER,
    'proposal-water',
    { cutsBackstop: true },
);
const PROPOSAL_SIDEWALK_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.SIDEWALK,
    'proposal-sidewalk',
    { supportReady: true, cutsBackstop: true },
);
const PROPOSAL_ROAD_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.ROAD_CARRIAGEWAY,
    'proposal-road',
    { supportReady: true, cutsBackstop: true },
);
const PROPOSAL_CYCLEWAY_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.CYCLEWAY,
    'proposal-cycleway',
    { supportReady: true, cutsBackstop: true },
);
const PROPOSAL_PARKING_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.PARKING,
    'proposal-parking',
    { supportReady: true, cutsBackstop: true },
);
const PROPOSAL_CURB_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.ROAD_DRESSING,
    'proposal-curb',
);
const PROPOSAL_COAST_STRUCTURE_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.STRUCTURE,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    ownerId: 'proposal-road-coastal-closure',
    sourceId: 'world/proposals.js',
    supportReady: true,
});
const PROPOSAL_PAINT_CLAIM = proposalSurfaceClaim(
    SURFACE_CLASS.ROAD_MARKING,
    'proposal-road-paint',
);

const grassMat      = () => getMat('grass',    () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({ map: getGrassTexture(), roughness: 0.95, ...GROUND_SHARED }), PROPOSAL_GRASS_CLAIM));
const pathMat       = () => getMat('path',     () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({ map: getGravelTexture(), roughness: 0.95, ...GROUND_SHARED }), PROPOSAL_PATH_CLAIM));
const trunkMat      = () => getMat('trunk',    () => new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.9 }));
const foliageMat    = () => getMat('foliage',  () => new THREE.MeshStandardMaterial({ color: 0x3a6b35, roughness: 0.85 }));
const waterMat      = () => getMat('water',    () => authorizeProposalSurfaceMaterial(createWaterMaterial({
    profile: 'sheltered',
    ...GROUND_SHARED,
}), PROPOSAL_WATER_CLAIM));
const waterShoreMat = () => getMat('water-shore', () => authorizeProposalSurfaceMaterial(createWaterShoreMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
}), PROPOSAL_GRASS_CLAIM));
const waterBankMat = () => getMat('water-bank', () => authorizeProposalSurfaceMaterial(createWaterBankMaterial(), PROPOSAL_GRASS_CLAIM));
const fountainBowl  = () => getMat('fbowl',    () => new THREE.MeshStandardMaterial({ color: 0x9e9588, roughness: 0.8 }));
const fountainWater = () => getMat('fwater',   () => new THREE.MeshLambertMaterial({ color: 0x6abfde }));
const proposalSidewalkMat = () => getMat('road-sidewalk', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    map: getSidewalkTexture(),
    color: 0xe1dfd8,
    roughness: 0.94,
    ...GROUND_SHARED,
}), PROPOSAL_SIDEWALK_CLAIM));
const proposalBusMat = () => getMat('road-bus', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0x765149,
    roughness: 0.96,
    ...GROUND_SHARED,
}), PROPOSAL_ROAD_CLAIM));
const proposalCyclewayMat = () => getMat('road-cycleway', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0xa44941,
    roughness: 0.92,
    ...GROUND_SHARED,
}), PROPOSAL_CYCLEWAY_CLAIM));
const proposalParkingMat = () => getMat('road-parking', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0x565b5e,
    roughness: 0.98,
    ...GROUND_SHARED,
}), PROPOSAL_PARKING_CLAIM));
const proposalCurbMat = () => getMat('road-curb', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0x9b9a93,
    roughness: 0.96,
    side: THREE.DoubleSide,
}), PROPOSAL_CURB_CLAIM));
const proposalCoastalClosureMat = () => getMat('road-coastal-closure', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0xd7d2c6,
    roughness: 0.97,
    metalness: 0,
    side: THREE.DoubleSide,
}), PROPOSAL_COAST_STRUCTURE_CLAIM));
const proposalRoadPaintMat = () => getMat('road-paint', () => authorizeProposalSurfaceMaterial(new THREE.MeshBasicMaterial({
    color: 0xf2f0df,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
}), PROPOSAL_PAINT_CLAIM));
const flowerbedMat = () => getMat('flowerbed', () => authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
    color: 0x713f49,
    roughness: 0.98,
    ...GROUND_SHARED,
}), PROPOSAL_GRASS_CLAIM));
const benchWoodMat = () => getMat('bench-wood', () => new THREE.MeshStandardMaterial({ color: 0x765133, roughness: 0.82 }));
const benchMetalMat = () => getMat('bench-metal', () => new THREE.MeshStandardMaterial({ color: 0x34383b, roughness: 0.62, metalness: 0.35 }));
const stallCanvasMat = () => getMat('stall-canvas', () => new THREE.MeshStandardMaterial({ color: 0xd6b24a, roughness: 0.86 }));

// Procedural paving texture for squares: irregular stone tiles, beige base.
let pavingTexture = null;
let pavingMat = null;
function getPavingMaterial() {
    if (pavingMat) return pavingMat;
    if (!pavingTexture) {
        const SIZE = 512;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#b5a890';
        ctx.fillRect(0, 0, SIZE, SIZE);
        // Varied rows and slab lengths keep the stone character without
        // exposing a checkerboard repeat when the camera sees a whole square.
        const ROW_MIN = 20;
        const ROW_MAX = 36;
        let y = -ROW_MAX;
        while (y < SIZE + ROW_MAX) {
            const rowH = ROW_MIN + Math.random() * (ROW_MAX - ROW_MIN);
            let x = -ROW_MAX - Math.random() * 42;
            const rowSkew = (Math.random() - 0.5) * 8;
            while (x < SIZE + ROW_MAX) {
                const slabW = 24 + Math.random() * 48;
                const inset = 1 + Math.random() * 1.8;
                const px = x + inset + rowSkew;
                const py = y + inset;
                const w = Math.max(8, slabW - inset * 2 + (Math.random() - 0.5) * 5);
                const h = Math.max(8, rowH - inset * 2 + (Math.random() - 0.5) * 3);
                const v = 154 + Math.floor(Math.random() * 46);
                const warm = Math.floor((Math.random() - 0.5) * 18);
                ctx.fillStyle = `rgb(${v + warm},${v - 10 + Math.floor(warm * 0.3)},${Math.max(0, v - 34 - warm)})`;
                ctx.fillRect(px, py, w, h);

                if (Math.random() < 0.18) {
                    ctx.strokeStyle = 'rgba(85,70,55,0.16)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(px + Math.random() * w, py + 2);
                    ctx.lineTo(px + Math.random() * w, py + h - 2);
                    ctx.stroke();
                }
                x += slabW;
            }
            y += rowH;
        }
        // Subtle stains and aggregate flecks break up the remaining repeat.
        for (let i = 0; i < 1700; i++) {
            const x = Math.random() * SIZE;
            const y = Math.random() * SIZE;
            const r = 0.6 + Math.random() * 2.4;
            const alpha = 0.03 + Math.random() * 0.08;
            ctx.fillStyle = Math.random() < 0.65
                ? `rgba(255,245,220,${alpha})`
                : `rgba(58,46,34,${alpha})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.strokeStyle = 'rgba(70,60,50,0.42)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
        pavingTexture = new THREE.CanvasTexture(canvas);
        pavingTexture.wrapS = THREE.RepeatWrapping;
        pavingTexture.wrapT = THREE.RepeatWrapping;
        pavingTexture.colorSpace = THREE.SRGBColorSpace;
        pavingTexture.anisotropy = 4;
        pavingTexture.minFilter = THREE.LinearMipmapLinearFilter;
        pavingTexture.magFilter = THREE.LinearFilter;
        pavingTexture.generateMipmaps = true;
        registerShared(pavingTexture);
    }
    pavingMat = authorizeProposalSurfaceMaterial(new THREE.MeshStandardMaterial({
        map: pavingTexture, roughness: 0.85,
        ...GROUND_SHARED,
    }), PROPOSAL_SIDEWALK_CLAIM);
    registerShared(pavingMat);
    return pavingMat;
}

// ─── Geometry helpers ──────────────────────────────────────────────────────

// Project a ring to local (sx, sy) pairs using the same anchor + axis
// convention `ringToShape` uses, so a hole built with `ringToPath`
// can be plugged straight into the same shape's `holes` array.
function ringToLocal2D(ring, anchorLat, anchorLon, opts) {
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const flipZ = opts && opts.flipZ;
    const out = [];
    for (let i = 0; i < ring.length; i++) {
        const lon = ring[i][0], lat = ring[i][1];
        const x = (lon - anchorLon) * SCALE_LON;
        const z = -(lat - anchorLat) * SCALE_LAT;
        out.push([x, flipZ ? z : -z]);
    }
    return out;
}

// THREE.Shape wants 2D points; the caller decides what goes on each axis
// (XY for extrudes, XZ-as-XY for ground polys with a later remap).
function ringToShape(ring, anchorLat, anchorLon, opts) {
    const pts = ringToLocal2D(ring, anchorLat, anchorLon, opts);
    const shape = new THREE.Shape();
    for (let i = 0; i < pts.length; i++) {
        if (i === 0) shape.moveTo(pts[i][0], pts[i][1]);
        else shape.lineTo(pts[i][0], pts[i][1]);
    }
    return shape;
}

// Same projection as ringToShape but builds a THREE.Path, suitable for
// pushing into `shape.holes` so ExtrudeGeometry carves the hole out.
function ringToPath(ring, anchorLat, anchorLon, opts) {
    const pts = ringToLocal2D(ring, anchorLat, anchorLon, opts);
    const path = new THREE.Path();
    for (let i = 0; i < pts.length; i++) {
        if (i === 0) path.moveTo(pts[i][0], pts[i][1]);
        else path.lineTo(pts[i][0], pts[i][1]);
    }
    return path;
}

// Ground polygon at height y. Edited park/square boundaries may contain holes, which must remain
// open rather than being filled back in by the 3D adapter.
// ─── Terrain drape for the overlay's ground fabric ──────────────────────────
// Proposal ground fabric used to be built FLAT at its lift above the
// session anchor plane (scene y = 0 = the spawn's elevation) — a flat-world-era
// assumption that hung a coastal path metres in the air wherever the shore
// dropped below the spawn, and buried it wherever ground rose above. With a
// terrain reference present, passive polygons refine to the terrain's OWN
// sample step. Engineered roads instead use bounded shared-station cross-section
// grids whose grade comes from RoadFormationModel, preserving longitudinal
// grade while removing raw cross-slope. Without terrain the old flat output is
// byte-for-byte preserved.
//
// Same triangle budget as roads.js DRAPED_SURFACE_MAX_TRIANGLES, same reason:
// a merged plaza polygon must not fill its flat interior with half a million
// coplanar triangles.
const PROPOSAL_DRAPE_MAX_TRIANGLES = 1200;

function proposalTerrain() {
    const terrain = getTerrainReference();
    return terrain && typeof terrain.evidenceSceneYAtLocal === 'function'
        ? terrain
        : null;
}

function proposalGroundYAtLocal(x, z) {
    const terrain = proposalTerrain();
    if (!terrain) return isTerrainRequested() ? Number.NaN : 0;
    const raw = terrain.evidenceSceneYAtLocal(x, z);
    if (raw == null) return Number.NaN;
    const y = Number(raw);
    return Number.isFinite(y) ? y : Number.NaN;
}

function proposalRoadYAtLocal(road, x, z) {
    if (!proposalRoadFormationModel) return proposalGroundYAtLocal(x, z);
    const options = Array.isArray(road?.formationIds) && road.formationIds.length > 0
        ? { osmIds: road.formationIds }
        : road?.formationId != null
            ? { osmId: road.formationId }
            : null;
    if (!options) return proposalGroundYAtLocal(x, z);
    const raw = proposalRoadFormationModel.sceneYAtLocal(x, z, options);
    const y = Number(raw);
    return Number.isFinite(y) ? y : proposalGroundYAtLocal(x, z);
}

function proposalGeographicPoint(value, anchorLat, anchorLon) {
    if (Array.isArray(value) && value.length >= 2) {
        const lon = Number(value[0]);
        const lat = Number(value[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)
            && Math.abs(lon - anchorLon) < 5
            && Math.abs(lat - anchorLat) < 5) {
            return { lat, lon };
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const lat = Number(value.lat);
        const lon = Number(value.lng ?? value.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)
            && Math.abs(lon - anchorLon) < 5
            && Math.abs(lat - anchorLat) < 5) {
            return { lat, lon };
        }
    }
    return null;
}

function proposalTerrainEvidenceReady(value, anchorLat, anchorLon) {
    const terrain = proposalTerrain();
    if (!terrain) return !isTerrainRequested();
    const localPoints = [];
    const seen = new WeakSet();
    const addSequence = (points) => {
        for (let index = 0; index < points.length; index++) {
            const start = latLonToLocal(
                points[index].lat,
                points[index].lon,
                anchorLat,
                anchorLon,
            );
            localPoints.push(start);
            if (index + 1 >= points.length) continue;
            const end = latLonToLocal(
                points[index + 1].lat,
                points[index + 1].lon,
                anchorLat,
                anchorLon,
            );
            const steps = Math.max(1, Math.ceil(
                Math.hypot(end.x - start.x, end.z - start.z) / 20,
            ));
            for (let step = 1; step < steps; step++) {
                const t = step / steps;
                localPoints.push({
                    x: start.x + (end.x - start.x) * t,
                    z: start.z + (end.z - start.z) * t,
                });
            }
        }
    };
    const visit = (node) => {
        const direct = proposalGeographicPoint(node, anchorLat, anchorLon);
        if (direct) {
            addSequence([direct]);
            if (Array.isArray(node)) return;
        }
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            const sequence = node.map(item => (
                proposalGeographicPoint(item, anchorLat, anchorLon)
            ));
            if (sequence.length > 0 && sequence.every(Boolean)) {
                addSequence(sequence);
                return;
            }
            for (const item of node) visit(item);
            return;
        }
        for (const child of Object.values(node)) visit(child);
    };
    visit(value);
    if (localPoints.length === 0) return true;
    let centerX = 0;
    let centerZ = 0;
    for (const point of localPoints) {
        const raw = terrain.evidenceSceneYAtLocal(point.x, point.z);
        if (finiteOrNull(raw) === null) return false;
        centerX += point.x;
        centerZ += point.z;
    }
    centerX /= localPoints.length;
    centerZ /= localPoints.length;
    const centerY = terrain.evidenceSceneYAtLocal(centerX, centerZ);
    return finiteOrNull(centerY) !== null;
}

// Local-space core: `localRing`/`localHoles` are {x, z} scene metres. `level`
// keeps water horizontal. `surfaceYAtLocal` is reserved for engineered road
// ownership: it samples the road's centreline grade, not raw terrain at the
// polygon vertex. Every other ground polygon retains the coastal drape.
function makeLocalGroundGeometry(localRing, y, {
    localHoles = [],
    level = false,
    surfaceYAtLocal = null,
} = {}) {
    const shape = new THREE.Shape();
    localRing.forEach((point, index) => {
        if (index === 0) shape.moveTo(point.x, point.z);
        else shape.lineTo(point.x, point.z);
    });
    for (const holeRing of localHoles) {
        if (!Array.isArray(holeRing) || holeRing.length < 3) continue;
        const hole = new THREE.Path();
        holeRing.forEach((point, index) => {
            if (index === 0) hole.moveTo(point.x, point.z);
            else hole.lineTo(point.x, point.z);
        });
        shape.holes.push(hole);
    }
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.getAttribute('position');
    const terrain = proposalTerrain();
    if (!terrain) {
        // Flat world: exactly the old behaviour — swap shape-Y into scene-Z,
        // lift to the plane. Zero extra cost where there is no terrain.
        for (let i = 0; i < pos.count; i++) {
            const sceneZ = pos.getY(i);
            pos.setY(i, y);
            pos.setZ(i, sceneZ);
        }
        pos.needsUpdate = true;
        return geo;
    }
    // Seed points/triangles out of the flat triangulation, refined to the
    // terrain's sample step at this polygon — finer edges would only
    // interpolate between the same samples.
    const seedPoints = [];
    for (let i = 0; i < pos.count; i++) {
        seedPoints.push({ x: pos.getX(i), z: pos.getY(i) });
    }
    const seedIndex = geo.index
        ? Array.from(geo.index.array)
        : Array.from({ length: pos.count }, (_v, i) => i);
    const seedTriangles = [];
    for (let i = 0; i + 2 < seedIndex.length; i += 3) {
        seedTriangles.push([seedIndex[i], seedIndex[i + 1], seedIndex[i + 2]]);
    }
    geo.dispose();
    let cx = 0, cz = 0;
    for (const point of localRing) { cx += point.x; cz += point.z; }
    cx /= localRing.length; cz /= localRing.length;
    const edgeM = drapeEdgeMForStep(terrain.sampleStepMAtLocal?.(cx, cz));
    const refined = refineTriangulatedSurface(
        seedPoints,
        seedTriangles,
        edgeM,
        PROPOSAL_DRAPE_MAX_TRIANGLES,
    );
    const levelBase = level
        ? (sampleGroundRange(
            localRing,
            (x, z) => terrain.evidenceSceneYAtLocal(x, z),
        )?.min ?? 0)
        : 0;
    const positions = new Float32Array(refined.points.length * 3);
    const sampleSurfaceY = typeof surfaceYAtLocal === 'function'
        ? surfaceYAtLocal
        : proposalGroundYAtLocal;
    for (let i = 0; i < refined.points.length; i++) {
        const point = refined.points[i];
        positions[i * 3] = point.x;
        positions[i * 3 + 1] = level
            ? levelBase + y
            : sampleSurfaceY(point.x, point.z) + y;
        positions[i * 3 + 2] = point.z;
    }
    const indices = new Uint32Array(refined.triangles.length * 3);
    refined.triangles.forEach((triangle, i) => {
        indices[i * 3] = triangle[0];
        indices[i * 3 + 1] = triangle[1];
        indices[i * 3 + 2] = triangle[2];
    });
    const draped = new THREE.BufferGeometry();
    draped.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // A uv attribute sized to the refined count, so callers that rescale an
    // EXISTING attribute (the paving loop) keep working; world-XZ by default.
    const uvs = new Float32Array(refined.points.length * 2);
    for (let i = 0; i < refined.points.length; i++) {
        uvs[i * 2] = positions[i * 3];
        uvs[i * 2 + 1] = positions[i * 3 + 2];
    }
    draped.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    draped.setIndex(new THREE.BufferAttribute(indices, 1));
    return draped;
}

function makeGroundGeometry(ring, anchorLat, anchorLon, y, holes = [], {
    level = false,
    surfaceYAtLocal = null,
} = {}) {
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const project = (pair) => ({
        x: (pair[0] - anchorLon) * SCALE_LON,
        z: -(pair[1] - anchorLat) * SCALE_LAT,
    });
    const localRing = ring.map(project);
    const localHoles = (holes || [])
        .filter((holeRing) => Array.isArray(holeRing) && holeRing.length >= 3)
        .map((holeRing) => holeRing.map(project));
    return makeLocalGroundGeometry(localRing, y, {
        localHoles,
        level,
        surfaceYAtLocal,
    });
}

function addWalkableSurface(mesh, targetGroup = proposalsWalkableGroup) {
    if (!mesh || !targetGroup) return;
    mesh.userData.walkableSurface = true;
    targetGroup.add(mesh);
}

function applyWorldXZUvs(geo, uvPerM) {
    if (!geo || !Number.isFinite(uvPerM) || uvPerM <= 0) return;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    let uv = geo.getAttribute('uv');
    if (!uv || uv.count !== pos.count) {
        uv = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2);
        geo.setAttribute('uv', uv);
    }
    for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, pos.getX(i) * uvPerM, pos.getZ(i) * uvPerM);
    }
    uv.needsUpdate = true;
}

function latLonToLocal(lat, lon, anchorLat, anchorLon) {
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    return {
        x: (lon - anchorLon) * SCALE_LON,
        z: -(lat - anchorLat) * SCALE_LAT,
    };
}

// Cheap deterministic hash for tree jitter.
function hash01(x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
}

function getProposalGlassFacadeTexture() {
    if (proposalGlassTexture) return proposalGlassTexture;
    const width = 256;
    const height = 384;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#edf6ff';
    ctx.fillRect(0, 0, width, height);

    const floorH = 56;
    const bayW = 44;
    for (let y = 0; y < height; y += floorH) {
        for (let x = 0; x < width; x += bayW) {
            const insetX = 5 + ((x / bayW) % 2) * 1.5;
            const insetY = 6;
            const panelW = bayW - insetX * 2;
            const panelH = floorH - insetY * 2;
            const shade = 210 + Math.floor(Math.random() * 28);
            ctx.fillStyle = `rgb(${shade - 6},${shade},${Math.min(255, shade + 10)})`;
            ctx.fillRect(x + insetX, y + insetY, panelW, panelH);

            const highlight = ctx.createLinearGradient(x + insetX, y + insetY, x + insetX, y + insetY + panelH);
            highlight.addColorStop(0, 'rgba(255,255,255,0.34)');
            highlight.addColorStop(0.55, 'rgba(255,255,255,0.07)');
            highlight.addColorStop(1, 'rgba(160,195,225,0.14)');
            ctx.fillStyle = highlight;
            ctx.fillRect(x + insetX, y + insetY, panelW, panelH);

            if (((x / bayW) + (y / floorH)) % 3 === 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.10)';
                ctx.fillRect(x + insetX + 3, y + insetY + 3, panelW - 6, Math.max(6, panelH * 0.22));
            }
        }
    }

    ctx.strokeStyle = 'rgba(58,86,112,0.58)';
    ctx.lineWidth = 4;
    for (let x = 0; x <= width; x += bayW) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
    }
    ctx.lineWidth = 5;
    for (let y = 0; y <= height; y += floorH) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
    }

    proposalGlassTexture = new THREE.CanvasTexture(canvas);
    proposalGlassTexture.wrapS = THREE.RepeatWrapping;
    proposalGlassTexture.wrapT = THREE.RepeatWrapping;
    proposalGlassTexture.repeat.set(0.16, 0.18);
    proposalGlassTexture.colorSpace = THREE.SRGBColorSpace;
    proposalGlassTexture.anisotropy = 4;
    proposalGlassTexture.minFilter = THREE.LinearMipmapLinearFilter;
    proposalGlassTexture.magFilter = THREE.LinearFilter;
    proposalGlassTexture.generateMipmaps = true;
    registerShared(proposalGlassTexture);
    return proposalGlassTexture;
}

function createProposalGlassTextureVariant(seedA, seedB, seedC) {
    const tex = getProposalGlassFacadeTexture().clone();
    tex.repeat.set(
        0.09 + seedA * 0.18,
        0.11 + seedB * 0.17,
    );
    tex.offset.set(seedC * 0.93, seedA * 0.89);
    tex.needsUpdate = true;
    return tex;
}

function createProposalGlassMaterials(building) {
    const centroid = ringCentroidLatLon(building.ring) || { lat: 0, lon: 0 };
    const seedA = hash01(centroid.lat * 37.1 + building.heightM * 0.013, centroid.lon * 19.7 + building.ring.length * 0.11);
    const seedB = hash01(centroid.lon * 41.3 - building.ring.length * 0.17, centroid.lat * 23.9 + building.heightM * 0.021);
    const seedC = hash01(seedA * 13.1 + building.ring.length, seedB * 17.7 + building.heightM);

    const wallColor = new THREE.Color().setHSL(
        0.50 + seedA * 0.30,
        0.28 + seedB * 0.34,
        0.40 + seedC * 0.16,
    );
    if (building.colorHex != null) {
        wallColor.lerp(new THREE.Color(building.colorHex), 0.45);
    }
    const roofColor = wallColor.clone().lerp(new THREE.Color(0x161d24), 0.58 + seedB * 0.10);
    const emissiveColor = wallColor.clone().multiplyScalar(0.18 + seedC * 0.08);
    const facadeTex = createProposalGlassTextureVariant(seedA, seedB, seedC);
    const usePhysicalGlass = seedA > 0.57;

    const roofMat = new THREE.MeshStandardMaterial({
        color: roofColor,
        roughness: 0.34 + seedA * 0.18,
        metalness: 0.10 + seedB * 0.08,
        envMapIntensity: 0.25 + seedC * 0.20,
    });
    const facadeMat = usePhysicalGlass
        ? new THREE.MeshPhysicalMaterial({
            color: wallColor,
            map: facadeTex,
            emissiveMap: facadeTex,
            emissive: emissiveColor,
            emissiveIntensity: 0.10,
            roughness: 0.03 + seedB * 0.07,
            metalness: 0.02 + seedC * 0.03,
            // No transmission: it makes three.js re-render the whole scene into
            // a transmission target every frame (see platforms.js). A glass
            // facade reads as glass from clearcoat + low roughness + high
            // envMapIntensity + transparency, none of which cost a second pass.
            clearcoat: 0.75 + seedA * 0.20,
            clearcoatRoughness: 0.04 + seedC * 0.10,
            envMapIntensity: 1.35 + seedA * 0.75,
            transparent: true,
            opacity: 0.96,
            ior: 1.45,
        })
        : new THREE.MeshStandardMaterial({
            color: wallColor,
            map: facadeTex,
            emissiveMap: facadeTex,
            emissive: emissiveColor,
            emissiveIntensity: 0.22,
            roughness: 0.12 + seedB * 0.16,
            metalness: 0.08 + seedA * 0.10,
            envMapIntensity: 0.90 + seedC * 0.45,
        });
    return [roofMat, facadeMat];
}

// ─── Per-kind emitters ─────────────────────────────────────────────────────

// Uploaded glTF models are emitted once, whatever the display state: they ARE
// the bespoke look. They hide only in `off` (see applyBuildingDisplayState).
function emitBuildingModels(anchorLat, anchorLon) {
    for (const b of activeBuildings) {
        if (b.modelUrl) emitBuildingModel(b, anchorLat, anchorLon);
    }
}

// The `ghost` display state: every extrude-path building as a glass prism.
// Lazy — first entry into the state pays the emit, after that it is one
// visible flag on the ghost group.
function emitGhostBuildings(anchorLat, anchorLon) {
    for (const b of activeBuildings) {
        if (!b.modelUrl) emitBuildingExtrude(b, anchorLat, anchorLon);
    }
}

function emitBuildingExtrude(b, anchorLat, anchorLon, { asModelFallback = false } = {}) {
    const shape = ringToShape(b.ring, anchorLat, anchorLon, { flipZ: false });
    // Inner rings (courtyards / cutouts) are attached as Path holes
    // on the Shape — ExtrudeGeometry then renders the perimeter
    // block AND the inside courtyard walls correctly, instead of
    // collapsing the whole thing into a solid block.
    if (Array.isArray(b.holes)) {
        for (const hole of b.holes) {
            shape.holes.push(ringToPath(hole, anchorLat, anchorLon, { flipZ: false }));
        }
    }
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(1, b.heightM),
        bevelEnabled: false,
    });
    geo.rotateX(-Math.PI / 2);
    const materials = createProposalGlassMaterials(b);
    const mesh = new THREE.Mesh(geo, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.disposables = materials;
    // Routed under the buildings-only sub-group so walk-mode's rooftop
    // raycast lets the player stand on proposal building roofs but
    // not on park trees, fountains, or grass.
    if (asModelFallback) {
        // A prism standing in for a FAILED model load follows model
        // visibility: in solid mode the ghost group is hidden, and this
        // building has no solid twin (model entries skip that path).
        mesh.userData.proposalBuildingModel = true;
        mesh.visible = proposalBuildingDisplayPolicy(buildingDisplayState).models;
        proposalsBuildingsGroup.add(mesh);
        return;
    }
    proposalsGhostGroup.add(mesh);
}

// Load an uploaded glTF building and place it at its footprint centroid, grounded.
// The scene is Y-up in real metres (no Mercator inflation) and the model is authored
// in metres, so scale is 1:1. Loaded fresh per session so disposeGroup can free it.
function emitBuildingModel(b, anchorLat, anchorLon) {
    const centroid = ringCentroidLatLon(b.ring);
    if (!centroid) { emitBuildingExtrude(b, anchorLat, anchorLon); return; }
    const { x, z } = latLonToLocal(centroid.lat, centroid.lon, anchorLat, anchorLon);
    // Capture the group; if the walk session ends (or restarts) before the async load
    // resolves, proposalsBuildingsGroup is nulled/replaced and we drop the late result.
    const targetGroup = proposalsBuildingsGroup;
    if (!gltfLoader) gltfLoader = new GLTFLoader();

    gltfLoader.loadAsync(b.modelUrl).then((gltf) => {
        const model = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
        if (!model || proposalsBuildingsGroup !== targetGroup) return;

        const box = new THREE.Box3().setFromObject(model);
        if (box.isEmpty()) return;
        const center = new THREE.Vector3();
        box.getCenter(center);
        // Centre the footprint over the origin and sit the base on the ground (y=0),
        // matching the extrude base datum.
        model.position.x -= center.x;
        model.position.z -= center.z;
        model.position.y -= box.min.y;

        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.position.set(x, 0, z);
        wrapper.traverse((o) => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });
        // Models hide only in the `off` display state — consulted here because
        // the load is async and can resolve after a toggle.
        wrapper.userData.proposalBuildingModel = true;
        wrapper.visible = proposalBuildingDisplayPolicy(buildingDisplayState).models;
        proposalsBuildingsGroup.add(wrapper);
    }).catch((err) => {
        // Fall back to the extruded box so the building is still visible/standable.
        if (proposalsBuildingsGroup !== targetGroup) return;
        emitBuildingExtrude(b, anchorLat, anchorLon, { asModelFallback: true });
        if (typeof console !== 'undefined') {
            console.warn('[proposals] building model load failed, used box fallback:', b.modelUrl, err);
        }
    });
}

// `surfaceLiftY` is the height of the surface the trees stand on ABOVE ITS
// GROUND (park grass, square paving, road verge) — each instance samples the
// terrain at its own trunk, so an avenue on a slope steps downhill with the
// street instead of floating at the anchor plane.
function emitTreeInstancesAtCoordinates(
    coordinates,
    anchorLat,
    anchorLon,
    surfaceLiftY,
    name,
    surfaceYAtLocal = proposalGroundYAtLocal,
) {
    const positions = (coordinates || []).map((coordinate) => {
        const lat = Number(coordinate && (coordinate.lat ?? coordinate[1]));
        const lng = Number(coordinate && (coordinate.lng ?? coordinate.lon ?? coordinate[0]));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
            ...latLonToLocal(lat, lng, anchorLat, anchorLon),
            source: coordinate,
        };
    }).filter(Boolean);
    if (positions.length === 0) return;
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.28, 3.0, 6);
    const foliageGeo = new THREE.ConeGeometry(2.2, 4.0, 8);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat(), positions.length);
    const foliageMesh = new THREE.InstancedMesh(foliageGeo, foliageMat(), positions.length);
    trunkMesh.name = `${name}:trunks`;
    foliageMesh.name = `${name}:foliage`;
    trunkMesh.castShadow = true;
    foliageMesh.castShadow = true;
    foliageMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    positions.forEach((position, index) => {
        const scale = 0.85 + hash01(position.x, position.z) * 0.4;
        const baseY = surfaceYAtLocal(position.x, position.z, position.source) + surfaceLiftY;
        dummy.position.set(position.x, baseY + 1.5, position.z);
        dummy.scale.setScalar(scale);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(index, dummy.matrix);
        dummy.position.set(position.x, baseY + 5.0, position.z);
        dummy.updateMatrix();
        foliageMesh.setMatrixAt(index, dummy.matrix);
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    foliageMesh.instanceMatrix.needsUpdate = true;
    trunkMesh.userData.disposables = [trunkGeo];
    foliageMesh.userData.disposables = [foliageGeo];
    proposalsGroup.add(trunkMesh, foliageMesh);
}

// Painted dividers follow the saved traffic-lane boundaries. Legacy proposals without a profile
// retain their single centerline; tracks still defer entirely to the rail renderer.
// One road's lane dashes into the shared accumulator, then that road's SLICE
// of positions draped in the same pass — bounded work per queue item, and the
// whole plan still merges into a single mesh at the end.
function proposalRoadRenderLinePoints(renderLine) {
    if (Array.isArray(renderLine)) return renderLine;
    return Array.isArray(renderLine?.points) ? renderLine.points : [];
}

function accumulateRoadLaneMarkings(r, anchorLat, anchorLon, out) {
    if (r.isTrack) return;
    const separators = r.profile ? proposalCorridorLaneSeparators(r.profile) : [{ offset: 0 }];
    if (separators.length === 0) return;
    const sliceStart = out.positions.length;
    for (const renderLine of r.renderLines || []) {
        const line = proposalRoadRenderLinePoints(renderLine);
        const coords = line.map((point) => [point.lng, point.lat]);
        if (coords.length < 2) continue;
        appendLaneMarkingStripsForLine(
            coords,
            separators.map((separator) => separator.offset),
            anchorLat,
            anchorLon,
            out,
        );
    }
    // The appender writes the constant stripY; re-seat this road's dashes on
    // its designed centreline grade. The road model makes that height a
    // function of chainage only, so opposite paint corners cannot inherit the
    // hillside's cross-slope.
    if (proposalTerrain()) {
        for (let i = sliceStart; i < out.positions.length; i += 3) {
            out.positions[i + 1] = proposalRoadYAtLocal(
                r,
                out.positions[i],
                out.positions[i + 2],
            )
                + PROPOSAL_LANE_MARKING_Y;
        }
    }
}

function finalizeLaneMarkings(out) {
    if (out.positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(out.positions), 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(new Float32Array(out.uvs), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(out.indices), 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, getLaneMarkingsDashMaterial());
    mesh.name = 'ProposalRoadLaneMarkings';
    mesh.renderOrder = 12;
    proposalsGroup.add(mesh);
}

function roadStripMaterial(type) {
    if (type === 'sidewalk') return proposalSidewalkMat();
    if (type === 'cycleway') return proposalCyclewayMat();
    if (type === 'bus') return proposalBusMat();
    if (type === 'parking') return proposalParkingMat();
    if (type === 'verge' || type === 'median') return grassMat();
    if (type === 'rail') return proposalSidewalkMat();
    return getAsphaltMaterialForProposals(PROPOSAL_ROAD_CLAIM);
}

function roadStripY(type) {
    return type === 'sidewalk' || type === 'verge' || type === 'median'
        ? PROPOSAL_RAISED_STRIP_Y
        : PROPOSAL_ROAD_STRIP_Y;
}

function applyRoadStripUvs(geometry, type) {
    if (type === 'driving') applyWorldXZUvs(geometry, ASPHALT_UV_PER_M);
    else if (type === 'sidewalk' || type === 'rail') applyWorldXZUvs(geometry, ASPHALT_UV_PER_M);
    else if (type === 'verge' || type === 'median') applyWorldXZUvs(geometry, GRASS_UV_PER_M);
}

// One road's parking ticks into the shared accumulator — same split as the
// lane dashes: bounded per-road work, one merged mesh at the end. Each corner
// samples its own ground so a tick on a slope lies on the street, not on the
// anchor plane.
function accumulateRoadParkingMarkings(road, anchorLat, anchorLon, positions) {
    if (road.isTrack || !road.profile) return;
    const cornerY = (x, z) => proposalRoadYAtLocal(road, x, z)
        + PROPOSAL_LANE_MARKING_Y;
    for (const strip of proposalCorridorStripSpans(road.profile)) {
        if (strip.type !== 'parking') continue;
        const offset = (strip.left + strip.right) / 2;
        for (const renderLine of road.renderLines || []) {
            const line = proposalRoadRenderLinePoints(renderLine);
            for (const sample of sampleProposalCorridorOffset(line, offset, 5.5, 1.5)) {
                const center = latLonToLocal(sample.lat, sample.lng, anchorLat, anchorLon);
                const tx = Math.cos(sample.angleRad), tz = -Math.sin(sample.angleRad);
                const nx = -Math.sin(sample.angleRad), nz = -Math.cos(sample.angleRad);
                const halfLength = Math.max(0.3, strip.width * 0.43);
                const halfThickness = 0.045;
                const corners = [
                    [center.x - nx * halfLength - tx * halfThickness, center.z - nz * halfLength - tz * halfThickness],
                    [center.x + nx * halfLength - tx * halfThickness, center.z + nz * halfLength - tz * halfThickness],
                    [center.x + nx * halfLength + tx * halfThickness, center.z + nz * halfLength + tz * halfThickness],
                    [center.x - nx * halfLength + tx * halfThickness, center.z - nz * halfLength + tz * halfThickness],
                ];
                positions.push(
                    corners[0][0], cornerY(corners[0][0], corners[0][1]), corners[0][1],
                    corners[1][0], cornerY(corners[1][0], corners[1][1]), corners[1][1],
                    corners[2][0], cornerY(corners[2][0], corners[2][1]), corners[2][1],
                    corners[0][0], cornerY(corners[0][0], corners[0][1]), corners[0][1],
                    corners[2][0], cornerY(corners[2][0], corners[2][1]), corners[2][1],
                    corners[3][0], cornerY(corners[3][0], corners[3][1]), corners[3][1],
                );
            }
        }
    }
}

function finalizeParkingMarkings(positions) {
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, proposalRoadPaintMat());
    mesh.name = 'ProposalRoadParkingMarkings';
    mesh.renderOrder = 13;
    proposalsGroup.add(mesh);
}

function makeProposalRoadGeometry(data) {
    if (!data?.positions || data.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function proposalRoadCrossSectionOffsets(r, strips) {
    if (strips.length > 0) {
        const offsets = [strips[0].left, ...strips.map(strip => strip.right)];
        return offsets.filter((offset, index) => (
            index === 0 || Math.abs(offset - offsets[index - 1]) > 1e-6
        ));
    }
    const halfWidth = Math.max(0.5, Number(r.widthM) / 2 || DEFAULT_PROPOSAL_ROAD_WIDTH_M / 2);
    return [halfWidth, -halfWidth];
}

function mergeProposalRoadBounds(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    return {
        minX: Math.min(a.minX, b.minX),
        minZ: Math.min(a.minZ, b.minZ),
        maxX: Math.max(a.maxX, b.maxX),
        maxZ: Math.max(a.maxZ, b.maxZ),
    };
}

function proposalRoadLandscapeTrees(r, strips) {
    const trees = [];
    for (const strip of strips) {
        if ((strip.type !== 'verge' && strip.type !== 'median')
            || strip.landscape !== 'trees') continue;
        const offset = (strip.left + strip.right) / 2;
        for (const renderLine of r.renderLines || []) {
            const line = proposalRoadRenderLinePoints(renderLine);
            trees.push(...sampleProposalCorridorOffset(line, offset, 9, 4).map(
                sample => ({ ...sample, formationId: r.formationId }),
            ));
        }
    }
    return trees;
}

function appendProposalRoadSurfaceChunk(
    r,
    chunk,
    strips,
    foundationOffsets,
    surfaceGroup,
    dressingGroup,
) {
    const baseSceneYs = chunk.stations.map(station => (
        proposalRoadYAtLocal(r, station.x, station.z)
    ));
    const chunkName = `${chunk.lineIndex}:${chunk.index}`;
    const surfaceChunk = new THREE.Group();
    surfaceChunk.name = `ProposalRoadChunk:${chunkName}`;
    const dressingChunk = new THREE.Group();
    dressingChunk.name = `ProposalRoadChunkDressing:${chunkName}`;
    const foundationGeometry = makeProposalRoadGeometry(
        buildProposalRoadSurfaceGeometryData(
            chunk,
            foundationOffsets,
            baseSceneYs,
            PROPOSAL_ROAD_Y,
        ),
    );
    if (!foundationGeometry) return;
    applyWorldXZUvs(foundationGeometry, ASPHALT_UV_PER_M);
    const foundation = new THREE.Mesh(
        foundationGeometry,
        getAsphaltMaterialForProposals(PROPOSAL_ROAD_CLAIM),
    );
    foundation.name = 'ProposalRoadFoundation';
    foundation.receiveShadow = true;
    foundation.userData.segmentId = r.id;
    foundation.userData.formationId = r.formationId;
    foundation.userData.widthM = r.widthM;
    foundation.userData.lineIndex = chunk.lineIndex;
    foundation.userData.chunkIndex = chunk.index;
    foundation.userData.surfaceY = PROPOSAL_ROAD_Y;
    addWalkableSurface(foundation, surfaceChunk);

    for (const strip of strips) {
        const surfaceY = roadStripY(strip.type);
        const geometry = makeProposalRoadGeometry(
            buildProposalRoadSurfaceGeometryData(
                chunk,
                [strip.left, strip.right],
                baseSceneYs,
                surfaceY,
            ),
        );
        if (!geometry) continue;
        applyRoadStripUvs(geometry, strip.type);
        const mesh = new THREE.Mesh(geometry, roadStripMaterial(strip.type));
        mesh.name = `ProposalRoadStrip:${strip.type}`;
        mesh.receiveShadow = true;
        mesh.renderOrder = 10;
        mesh.userData.segmentId = r.id;
        mesh.userData.stripIndex = strip.index;
        mesh.userData.widthM = strip.width;
        mesh.userData.direction = strip.direction || null;
        mesh.userData.landscape = strip.landscape || null;
        mesh.userData.surfaceY = surfaceY;
        mesh.userData.lineIndex = chunk.lineIndex;
        mesh.userData.chunkIndex = chunk.index;
        addWalkableSurface(mesh, surfaceChunk);

        if (surfaceY <= PROPOSAL_ROAD_STRIP_Y + 0.01) continue;
        const curbGeometry = makeProposalRoadGeometry(
            buildProposalRoadCurbGeometryData(
                chunk,
                strip.left,
                strip.right,
                baseSceneYs,
                PROPOSAL_ROAD_STRIP_Y,
                surfaceY,
                {
                    capStart: chunk.isLineStart && chunk.junctionStart !== true,
                    capEnd: chunk.isLineEnd && chunk.junctionEnd !== true,
                },
            ),
        );
        if (!curbGeometry) continue;
        const wall = new THREE.Mesh(curbGeometry, proposalCurbMat());
        wall.name = `ProposalRoadCurb:${strip.type}`;
        wall.receiveShadow = true;
        wall.renderOrder = 9;
        wall.userData.segmentId = r.id;
        wall.userData.lineIndex = chunk.lineIndex;
        wall.userData.chunkIndex = chunk.index;
        dressingChunk.add(wall);
    }
    if (isMappedSeaReady()) {
        const minimumOffset = Math.min(...foundationOffsets);
        const maximumOffset = Math.max(...foundationOffsets);
        const crossSectionCenter = (minimumOffset + maximumOffset) * 0.5;
        for (const edgeOffset of [maximumOffset, minimumOffset]) {
            const outsideDirection = edgeOffset >= crossSectionCenter ? 1 : -1;
            const closureData = buildProposalRoadCoastalClosureGeometryData(
                chunk,
                edgeOffset,
                outsideDirection,
                baseSceneYs,
                PROPOSAL_ROAD_Y,
                {
                    isMappedSeaAtLocal: isPointInMappedSea,
                    seaSceneY: mappedSeaSurfaceSceneY(),
                },
            );
            const closureGeometry = makeProposalRoadGeometry(closureData);
            if (!closureGeometry) continue;
            const closure = new THREE.Mesh(
                closureGeometry,
                proposalCoastalClosureMat(),
            );
            closure.name = 'ProposalRoadCoastalClosure';
            closure.receiveShadow = true;
            closure.castShadow = false;
            closure.renderOrder = 9;
            closure.userData.segmentId = r.id;
            closure.userData.formationId = r.formationId;
            closure.userData.lineIndex = chunk.lineIndex;
            closure.userData.chunkIndex = chunk.index;
            closure.userData.edgeOffsetM = edgeOffset;
            dressingChunk.add(closure);
        }
    }
    surfaceGroup.add(surfaceChunk);
    if (dressingChunk.children.length > 0) dressingGroup.add(dressingChunk);
}

function appendLegacyProposalRoadSurface(r, anchorLat, anchorLon, surfaceGroup) {
    const geometry = makeGroundGeometry(
        r.ring,
        anchorLat,
        anchorLon,
        PROPOSAL_ROAD_Y,
        [],
        { surfaceYAtLocal: (x, z) => proposalRoadYAtLocal(r, x, z) },
    );
    applyWorldXZUvs(geometry, ASPHALT_UV_PER_M);
    geometry.computeVertexNormals();
    const foundation = new THREE.Mesh(
        geometry,
        getAsphaltMaterialForProposals(PROPOSAL_ROAD_CLAIM),
    );
    foundation.name = 'ProposalRoadFoundation';
    foundation.receiveShadow = true;
    foundation.userData.segmentId = r.id;
    foundation.userData.formationId = r.formationId;
    foundation.userData.widthM = r.widthM;
    foundation.userData.surfaceY = PROPOSAL_ROAD_Y;
    addWalkableSurface(foundation, surfaceGroup);
}

// One semantic road owner builds as bounded longitudinal steps. Its complete
// off-scene chunk set swaps in atomically, so a formation revision can never
// leave half the road on an old grade or expose terrain between generations.
function createProposalRoadBuildTask(r, anchorLat, anchorLon, landscapedTrees = null) {
    const walkableTarget = proposalsWalkableGroup;
    const visualTarget = proposalsGroup;
    const strips = proposalCorridorStripSpans(r.profile);
    const foundationOffsets = proposalRoadCrossSectionOffsets(r, strips);
    let chunks = [];
    let bounds = null;
    let buildRevision = proposalRoadFormationModel?.revision ?? null;
    let buildMappedSeaRevision = proposalRoadMappedSeaRevision;
    let surfaceGroup = null;
    let dressingGroup = null;
    let formationProfiles = [];
    let chunkIndex = 0;
    let dressingIndex = 0;
    let legacyBuilt = false;
    let prepared = false;
    let finished = false;

    const makeGroups = () => {
        surfaceGroup = new THREE.Group();
        surfaceGroup.name = `ProposalRoadSurface:${r.id ?? r.formationId ?? 'polygon'}`;
        dressingGroup = new THREE.Group();
        dressingGroup.name = `ProposalRoadDressing:${r.id ?? r.formationId ?? 'polygon'}`;
    };
    const discardOffSceneBuild = () => {
        if (surfaceGroup) disposeGroup(surfaceGroup);
        if (dressingGroup) disposeGroup(dressingGroup);
        surfaceGroup = null;
        dressingGroup = null;
    };
    const resetBuild = () => {
        discardOffSceneBuild();
        makeGroups();
        chunkIndex = 0;
        dressingIndex = 0;
        legacyBuilt = false;
        buildRevision = proposalRoadFormationModel?.revision ?? null;
        buildMappedSeaRevision = proposalRoadMappedSeaRevision;
        formationProfiles = r.formationId == null || !proposalRoadFormationModel
            ? []
            : proposalRoadFormationModel.getSurfaceProfilesForOsmId(r.formationId);
    };
    const prepare = () => {
        for (const [lineIndex, renderLine] of (r.renderLines || []).entries()) {
            const line = proposalRoadRenderLinePoints(renderLine);
            const localLine = line.map(point => latLonToLocal(
                point.lat,
                point.lng,
                anchorLat,
                anchorLon,
            ));
            const lineChunks = buildProposalRoadStationChunks(localLine).map(chunk => ({
                ...chunk,
                lineIndex,
                junctionStart: chunk.isLineStart && renderLine?.junctionStart === true,
                junctionEnd: chunk.isLineEnd && renderLine?.junctionEnd === true,
            }));
            chunks.push(...lineChunks);
            bounds = mergeProposalRoadBounds(
                bounds,
                proposalRoadStationChunksBounds(lineChunks, Number(r.widthM) / 2),
            );
        }
        if (!bounds && Array.isArray(r.ring)) {
            for (const [lon, lat] of r.ring) {
                const point = latLonToLocal(lat, lon, anchorLat, anchorLon);
                bounds = mergeProposalRoadBounds(bounds, {
                    minX: point.x,
                    minZ: point.z,
                    maxX: point.x,
                    maxZ: point.z,
                });
            }
        }
        resetBuild();
        prepared = true;
    };
    const buildEnvironmentChanged = () => {
        if (proposalRoadMappedSeaRevision !== buildMappedSeaRevision) return true;
        if (!proposalRoadFormationModel
            || proposalRoadFormationModel.revision === buildRevision) return false;
        const change = typeof proposalRoadFormationModel.getChangesSince === 'function'
            ? proposalRoadFormationModel.getChangesSince(buildRevision)
            : { revision: proposalRoadFormationModel.revision, full: true, bounds: [] };
        const touches = proposalRoadFormationChangeTouchesBounds(change, bounds);
        if (!touches) buildRevision = change.revision;
        return touches;
    };
    const complete = () => {
        if (!surfaceGroup || surfaceGroup.children.length === 0) {
            throw new Error(`proposal road ${r.id ?? r.formationId ?? 'polygon'} built no surface`);
        }
        // Add the complete replacement before retiring the prior generation;
        // both operations occur inside one queue callback, between frames.
        walkableTarget.add(surfaceGroup);
        const publishedDressing = dressingGroup.children.length > 0 ? dressingGroup : null;
        if (publishedDressing) visualTarget.add(publishedDressing);
        else disposeGroup(dressingGroup);
        const previousSurface = r.surfaceGroup || null;
        const previousDressing = r.dressingGroup || null;
        r.surfaceGroup = surfaceGroup;
        r.dressingGroup = publishedDressing;
        r.surfaceBounds = bounds;
        r.renderedFormationRevision = buildRevision;
        r.renderedMappedSeaRevision = buildMappedSeaRevision;
        if (buildRevision === proposalRoadFormationModel?.revision
            && buildMappedSeaRevision === proposalRoadMappedSeaRevision) {
            pendingProposalRoadRefreshes.delete(r);
        }
        surfaceGroup = null;
        dressingGroup = null;
        if (previousSurface) {
            previousSurface.parent?.remove(previousSurface);
            disposeGroup(previousSurface);
        }
        if (previousDressing) {
            previousDressing.parent?.remove(previousDressing);
            disposeGroup(previousDressing);
        }
        if (landscapedTrees && !r.landscapedTreesPublished) {
            landscapedTrees.push(...proposalRoadLandscapeTrees(r, strips));
            r.landscapedTreesPublished = true;
        }
        finished = true;
        activeProposalRoadBuildTasks.delete(task);
        return true;
    };
    const step = () => {
        if (finished || !walkableTarget || !visualTarget) return false;
        try {
            if (!prepared) {
                prepare();
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (proposalRoadFormationModel?.hasPendingBuild?.() === true) {
                proposalRoadFormationModel.stepPendingBuildPreparation?.();
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (buildEnvironmentChanged()) {
                resetBuild();
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (chunkIndex < chunks.length) {
                appendProposalRoadSurfaceChunk(
                    r,
                    chunks[chunkIndex],
                    strips,
                    foundationOffsets,
                    surfaceGroup,
                    dressingGroup,
                );
                chunkIndex += 1;
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (chunks.length === 0 && !legacyBuilt) {
                appendLegacyProposalRoadSurface(r, anchorLat, anchorLon, surfaceGroup);
                legacyBuilt = true;
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            if (dressingIndex < formationProfiles.length) {
                appendRoadFormationDressingToGroup({
                    profile: formationProfiles[dressingIndex],
                    group: dressingGroup,
                    osmId: r.formationId,
                    surfaceY: PROPOSAL_ROAD_Y,
                });
                dressingIndex += 1;
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            return complete();
        } catch (error) {
            discardOffSceneBuild();
            finished = true;
            activeProposalRoadBuildTasks.delete(task);
            throw error;
        }
    };
    const task = {
        step,
        dispose() {
            if (finished) return;
            discardOffSceneBuild();
            finished = true;
            activeProposalRoadBuildTasks.delete(task);
        },
    };
    activeProposalRoadBuildTasks.add(task);
    return task;
}

function publishRoadJunction(junction, anchorLat, anchorLon) {
    const center = latLonToLocal(junction.lat, junction.lng, anchorLat, anchorLon);
    const boundary = junction.ring.slice(0, -1).map(([lon, lat]) => (
        latLonToLocal(lat, lon, anchorLat, anchorLon)
    ));
    const buildRevision = proposalRoadFormationModel?.revision ?? null;
    const geometry = makeProposalRoadGeometry(buildProposalRoadJunctionGeometryData({
        centerX: center.x,
        centerZ: center.z,
        boundary,
        surfaceOffsetY: PROPOSAL_ROAD_Y + 0.002,
        surfaceYAtLocal: (x, z) => proposalRoadYAtLocal(junction, x, z),
    }));
    if (!geometry) return;
    applyWorldXZUvs(geometry, ASPHALT_UV_PER_M);
    const mesh = new THREE.Mesh(
        geometry,
        getAsphaltMaterialForProposals(PROPOSAL_ROAD_CLAIM),
    );
    mesh.name = 'ProposalRoadJunction';
    mesh.receiveShadow = true;
    mesh.userData.radiusM = junction.radiusM;
    mesh.userData.trimM = junction.trimM;
    mesh.userData.junctionKey = junction.key;
    // Publish before retiring the old generation, matching proposal branches.
    addWalkableSurface(mesh);
    const previous = junction.surfaceMesh || null;
    junction.surfaceMesh = mesh;
    junction.surfaceBounds = {
        minX: center.x - junction.radiusM,
        minZ: center.z - junction.radiusM,
        maxX: center.x + junction.radiusM,
        maxZ: center.z + junction.radiusM,
    };
    junction.renderedFormationRevision = buildRevision;
    if (buildRevision === proposalRoadFormationModel?.revision) {
        pendingProposalRoadJunctionRefreshes.delete(junction);
    }
    if (previous) disposeGroup(previous);
}

function emitRecessedProposalWater(
    ring,
    holes,
    anchorLat,
    anchorLon,
    {
        surfaceName,
        cutoutName,
        bankName,
        shoreName,
        bankTopY = WATER_LEVELS.naturalBankTop,
        renderOrder = 20,
    },
) {
    // Water stays LEVEL — the one surface that must not follow the ground. It
    // sits at min(ground over its ring) + the recess, so it never floats above
    // its own banks; the bank collar climbs to max(ground) + its old lift so
    // it always reaches the draped surroundings on every side of a slope.
    const geometry = makeGroundGeometry(
        ring, anchorLat, anchorLon, WATER_LEVELS.inland, holes, { level: true });
    applyWorldXZWaterUvs(geometry);
    geometry.computeVertexNormals();
    const surface = new THREE.Mesh(geometry, waterMat());
    surface.name = surfaceName;
    surface.receiveShadow = true;
    surface.renderOrder = renderOrder;
    proposalsGroup.add(surface);

    const cutout = createWaterGroundCutoutMesh(geometry, {
        name: cutoutName,
        ownerId: 'proposal-water-cutout',
        replacementClaim: PROPOSAL_WATER_CLAIM,
    });
    if (cutout) proposalsGroup.add(cutout);

    const localRing = ring.map(([lon, lat]) => latLonToLocal(lat, lon, anchorLat, anchorLon));
    const localHoles = (holes || []).map((hole) => hole.map(([lon, lat]) => (
        latLonToLocal(lat, lon, anchorLat, anchorLon)
    )));
    const groundRange = sampleGroundRange(
        localRing,
        (x, z) => proposalTerrain()?.evidenceSceneYAtLocal(x, z),
    );
    const waterY = (groundRange?.min ?? 0) + WATER_LEVELS.inland;
    const bankGeometry = buildWaterBankGeometry(
        localRing,
        localHoles,
        waterY,
        (groundRange?.max ?? 0) + bankTopY,
    );
    if (bankGeometry) {
        const bank = new THREE.Mesh(bankGeometry, waterBankMat());
        bank.name = bankName;
        bank.receiveShadow = true;
        bank.renderOrder = renderOrder - 1;
        proposalsGroup.add(bank);
    }
    const shoreGeometry = buildWaterShoreGeometry(localRing, localHoles, waterY);
    if (shoreGeometry) {
        const shore = new THREE.Mesh(shoreGeometry, waterShoreMat());
        shore.name = shoreName;
        shore.renderOrder = renderOrder + 1;
        proposalsGroup.add(shore);
    }
}

function emitLake(lake, anchorLat, anchorLon) {
    emitRecessedProposalWater(lake.ring, lake.holes, anchorLat, anchorLon, {
        surfaceName: 'ProposalLakeSurface',
        cutoutName: 'ProposalLakeGroundCutout',
        bankName: 'ProposalLakeBank',
        shoreName: 'ProposalLakeShore',
    });
}

function authoredPondHolesForPark(park) {
    const holes = Array.isArray(park.holes) ? [...park.holes] : [];
    const ponds = park.hasAuthoredDecorations && park.decorations
        ? park.decorations.ponds
        : null;
    for (const ring of Array.isArray(ponds) ? ponds : []) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        const center = ringCentroidLatLon(ring);
        if (!center || !pointInRing(center.lat, center.lon, park.ring)) continue;
        if (holes.some((hole) => pointInRing(center.lat, center.lon, hole))) continue;
        holes.push(ring);
    }
    return holes;
}

function emitPark(p, anchorLat, anchorLon) {
    // Authored ponds are true holes in the raised grass surface. The
    // recessed water and bank would otherwise remain hidden under the
    // park polygon even after the global catch-all ground is cut away.
    const geo = makeGroundGeometry(
        p.ring,
        anchorLat,
        anchorLon,
        PARK_SURFACE_Y,
        authoredPondHolesForPark(p),
    );
    applyWorldXZUvs(geo, GRASS_UV_PER_M);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, grassMat());
    mesh.name = 'ProposalParkSurface';
    mesh.receiveShadow = true;
    addWalkableSurface(mesh);
    if (p.hasAuthoredDecorations) {
        if (p.decorations) emitAuthoredParkDecorations(p.decorations, anchorLat, anchorLon);
    } else {
        emitParkPaths(p, anchorLat, anchorLon);
        emitParkTrees(p, anchorLat, anchorLon);
    }
}

function emitAuthoredParkDecorations(decorations, anchorLat, anchorLon) {
    for (const path of Array.isArray(decorations.paths) ? decorations.paths : []) {
        const ring = buildProposalCorridorStripRing(path, 0.8, -0.8);
        if (!ring) continue;
        const geometry = makeGroundGeometry(ring, anchorLat, anchorLon, PATH_SURFACE_Y);
        applyWorldXZUvs(geometry, GRAVEL_UV_PER_M);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, pathMat());
        mesh.name = 'ProposalParkPath';
        mesh.receiveShadow = true;
        addWalkableSurface(mesh);
    }
    for (const ring of Array.isArray(decorations.ponds) ? decorations.ponds : []) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        emitRecessedProposalWater(ring, [], anchorLat, anchorLon, {
            surfaceName: 'ProposalParkPond',
            cutoutName: 'ProposalParkPondGroundCutout',
            bankName: 'ProposalParkPondBank',
            shoreName: 'ProposalParkPondShore',
            bankTopY: PARK_SURFACE_Y,
            renderOrder: 24,
        });
    }
    for (const ring of Array.isArray(decorations.flowerbeds) ? decorations.flowerbeds : []) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        const geometry = makeGroundGeometry(ring, anchorLat, anchorLon, PROPOSAL_FLOWERBED_Y);
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, flowerbedMat());
        mesh.name = 'ProposalParkFlowerbed';
        mesh.receiveShadow = true;
        proposalsGroup.add(mesh);
    }
    emitTreeInstancesAtCoordinates(
        Array.isArray(decorations.trees) ? decorations.trees : [],
        anchorLat,
        anchorLon,
        PARK_SURFACE_Y,
        'ProposalParkTrees',
    );
}

// Star-pattern of straight paths from the polygon centroid out to a few
// perimeter sample points. Strips overshoot a little so they reach the
// edge cleanly even if the centroid sits just off-centre. Works for
// roughly convex park shapes; for wildly concave ones some strips will
// poke outside the grass — we accept that for now to avoid pulling in a
// proper polygon skeleton library.
function emitParkPaths(park, anchorLat, anchorLon) {
    const centroid = ringCentroidLatLon(park.ring);
    if (!centroid) return;
    const c = latLonToLocal(centroid.lat, centroid.lon, anchorLat, anchorLon);
    const ring = park.ring;
    const last = ring[ring.length - 1];
    const isClosed = ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1];
    const upper = isClosed ? ring.length - 1 : ring.length;
    const PATH_SAMPLES = 5;
    const PATH_WIDTH_M = 1.6;
    for (let i = 0; i < PATH_SAMPLES; i++) {
        const idx = Math.floor((i / PATH_SAMPLES) * upper);
        const v = ring[idx];
        const p = latLonToLocal(v[1], v[0], anchorLat, anchorLon);
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 4) continue;
        const ux = dx / len, uz = dz / len;
        // Perpendicular (right-handed).
        const px = -uz, pz = ux;
        const w = PATH_WIDTH_M / 2;
        // A local-space rectangle through the shared draped-ground path, so a
        // path leg follows the park's relief instead of spanning it as one
        // flat chord (a 60 m leg used to be two triangles at plane height).
        const localRing = [
            { x: c.x - px * w, z: c.z - pz * w },
            { x: c.x + px * w, z: c.z + pz * w },
            { x: p.x + px * w, z: p.z + pz * w },
            { x: p.x - px * w, z: p.z - pz * w },
        ];
        const geo = makeLocalGroundGeometry(localRing, PATH_SURFACE_Y);
        applyWorldXZUvs(geo, GRAVEL_UV_PER_M);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, pathMat());
        mesh.name = 'ProposalParkPath';
        mesh.receiveShadow = true;
        addWalkableSurface(mesh);
    }
}

// Sample a regular lat/lon grid inside the park's AABB and place a tree
// at each point that survives the point-in-polygon test, with a tiny
// hash-based jitter so the result doesn't read as a perfect lattice.
// Trees are batched into shared InstancedMeshes (one for trunks, one
// for foliage) so a dense park stays cheap.
function emitParkTrees(park, anchorLat, anchorLon) {
    // 14 m grid keeps the canopy looking inviting without turning the
    // park into a forest the player can't walk through. Real urban park
    // trees sit at 8–20 m centres; we land in the middle.
    const TREE_SPACING_M = 14;
    const dLat = TREE_SPACING_M / (DEG_TO_RAD * EARTH_RADIUS_M);
    const dLon = dLat / Math.cos(anchorLat * DEG_TO_RAD);
    const a = park.aabb;
    const coordinates = [];
    for (let lat = a.minLat + dLat * 0.5; lat < a.maxLat; lat += dLat) {
        for (let lon = a.minLon + dLon * 0.5; lon < a.maxLon; lon += dLon) {
            const j1 = (hash01(lon, lat) - 0.5) * dLat * 0.7;
            const j2 = (hash01(lat, lon) - 0.5) * dLon * 0.7;
            const sLat = lat + j1, sLon = lon + j2;
            if (!pointInRing(sLat, sLon, park.ring)) continue;
            coordinates.push([sLon, sLat]);
        }
    }
    // Trunk and foliage geometry is shared through the same instanced helper used by authored
    // tree points and landscaped road strips.
    emitTreeInstancesAtCoordinates(coordinates, anchorLat, anchorLon, PARK_SURFACE_Y, 'ProposalParkTrees');
}

function emitSquare(s, anchorLat, anchorLon) {
    const geo = makeGroundGeometry(s.ring, anchorLat, anchorLon, SQUARE_SURFACE_Y, s.holes);
    // World-XZ UVs so the paving texture tiles continuously and
    // adjacent slabs read at a believable scale.
    const PAVING_TILE_M = 6.0;
    const uv = geo.getAttribute('uv');
    const pos = geo.getAttribute('position');
    if (uv) {
        const inv = 1 / PAVING_TILE_M;
        for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, pos.getX(i) * inv, pos.getZ(i) * inv);
        }
        uv.needsUpdate = true;
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, getPavingMaterial());
    mesh.name = 'ProposalSquareSurface';
    mesh.receiveShadow = true;
    addWalkableSurface(mesh);
    if (s.hasAuthoredDecorations) {
        if (s.decorations) emitAuthoredSquareDecorations(s.decorations, anchorLat, anchorLon);
    } else {
        emitFountain(s, anchorLat, anchorLon);
    }
}

function decorationCoordinate(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lng = Number(value[0]), lat = Number(value[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

function emitAuthoredSquareDecorations(decorations, anchorLat, anchorLon) {
    const fountains = Array.isArray(decorations.fountains)
        ? decorations.fountains
        : (decorationCoordinate(decorations.fountain) ? [decorations.fountain] : []);
    for (const coordinate of fountains) {
        if (decorationCoordinate(coordinate)) emitFountainAt(coordinate, anchorLat, anchorLon);
    }
    emitTreeInstancesAtCoordinates(
        Array.isArray(decorations.trees) ? decorations.trees : [],
        anchorLat,
        anchorLon,
        SQUARE_SURFACE_Y,
        'ProposalSquareTrees',
    );
    for (const bench of Array.isArray(decorations.benches) ? decorations.benches : []) {
        const coordinate = decorationCoordinate(bench && (bench.coordinate || bench.position || bench));
        if (coordinate) emitBench(coordinate, Number(bench && bench.bearing) || 0, anchorLat, anchorLon);
    }
    for (const coordinate of Array.isArray(decorations.stalls) ? decorations.stalls : []) {
        if (decorationCoordinate(coordinate)) emitMarketStall(coordinate, anchorLat, anchorLon);
    }
}

function addBoxToGroup(group, size, position, material, name) {
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
}

function emitBench(coordinate, bearingDeg, anchorLat, anchorLon) {
    const local = latLonToLocal(coordinate[1], coordinate[0], anchorLat, anchorLon);
    const group = new THREE.Group();
    group.name = 'ProposalSquareBench';
    group.position.set(local.x, proposalGroundYAtLocal(local.x, local.z) + SQUARE_SURFACE_Y, local.z);
    group.rotation.y = -bearingDeg * DEG_TO_RAD;
    group.userData.bearing = ((bearingDeg % 360) + 360) % 360;
    addBoxToGroup(group, [1.8, 0.12, 0.48], [0, 0.66, 0], benchWoodMat(), 'BenchSeat');
    addBoxToGroup(group, [1.8, 0.62, 0.10], [0, 1.02, 0.19], benchWoodMat(), 'BenchBack');
    addBoxToGroup(group, [0.10, 0.62, 0.10], [-0.62, 0.31, 0], benchMetalMat(), 'BenchLeg');
    addBoxToGroup(group, [0.10, 0.62, 0.10], [0.62, 0.31, 0], benchMetalMat(), 'BenchLeg');
    proposalsGroup.add(group);
}

function emitMarketStall(coordinate, anchorLat, anchorLon) {
    const local = latLonToLocal(coordinate[1], coordinate[0], anchorLat, anchorLon);
    const group = new THREE.Group();
    group.name = 'ProposalSquareStall';
    group.position.set(local.x, proposalGroundYAtLocal(local.x, local.z) + SQUARE_SURFACE_Y, local.z);
    group.rotation.y = hash01(local.x, local.z) * Math.PI;
    addBoxToGroup(group, [2.2, 0.18, 1.1], [0, 0.92, 0], benchWoodMat(), 'StallCounter');
    addBoxToGroup(group, [2.5, 0.16, 1.55], [0, 2.25, 0], stallCanvasMat(), 'StallCanopy');
    for (const x of [-1.0, 1.0]) {
        for (const z of [-0.55, 0.55]) {
            addBoxToGroup(group, [0.08, 2.2, 0.08], [x, 1.1, z], benchMetalMat(), 'StallPost');
        }
    }
    proposalsGroup.add(group);
}

// Two-tier fountain at the square's centroid: outer stone basin + inner
// raised water disc + a small water spout. Cheap geo, no animation.
function emitFountain(square, anchorLat, anchorLon) {
    const centroid = ringCentroidLatLon(square.ring);
    if (!centroid) return;
    emitFountainAt([centroid.lon, centroid.lat], anchorLat, anchorLon);
}

function emitFountainAt(coordinate, anchorLat, anchorLon) {
    const c = latLonToLocal(coordinate[1], coordinate[0], anchorLat, anchorLon);
    const group = new THREE.Group();
    group.name = 'ProposalSquareFountain';
    group.position.set(c.x, proposalGroundYAtLocal(c.x, c.z) + SQUARE_SURFACE_Y, c.z);

    const basinGeo = new THREE.CylinderGeometry(2.4, 2.6, 0.6, 24);
    const basin = new THREE.Mesh(basinGeo, fountainBowl());
    basin.position.set(0, 0.3, 0);
    basin.name = 'FountainBasin';
    basin.castShadow = true;
    basin.receiveShadow = true;
    basin.userData.disposables = [basinGeo];
    group.add(basin);

    const waterGeo = new THREE.CylinderGeometry(2.15, 2.15, 0.08, 24);
    const water = new THREE.Mesh(waterGeo, fountainWater());
    water.position.set(0, 0.62, 0);
    water.name = 'FountainWater';
    water.userData.disposables = [waterGeo];
    group.add(water);

    const pillarGeo = new THREE.CylinderGeometry(0.25, 0.35, 1.0, 12);
    const pillar = new THREE.Mesh(pillarGeo, fountainBowl());
    pillar.position.set(0, 1.16, 0);
    pillar.name = 'FountainPillar';
    pillar.castShadow = true;
    pillar.userData.disposables = [pillarGeo];
    group.add(pillar);

    const sprayGeo = new THREE.ConeGeometry(0.35, 1.4, 8, 1, true);
    const spray = new THREE.Mesh(sprayGeo, fountainWater());
    spray.position.set(0, 2.36, 0);
    spray.name = 'FountainSpray';
    spray.userData.disposables = [sprayGeo];
    group.add(spray);
    proposalsGroup.add(group);
}

// ─── Session protocol ──────────────────────────────────────────────────────

function ensureGroup() {
    if (!proposalsGroup) {
        proposalsGroup = new THREE.Group();
        proposalsGroup.name = 'Proposals';
        markInspectionLayer(proposalsGroup, {
            id: 'proposal-overlays',
            label: 'Proposal surfaces and structures',
            category: 'Plans',
            source: 'world/proposals.js · consensus-builder authored geometry',
            order: 180,
        });
        scene.add(proposalsGroup);
    }
    if (!proposalsWalkableGroup) {
        proposalsWalkableGroup = new THREE.Group();
        proposalsWalkableGroup.name = 'ProposalWalkableSurfaces';
        proposalsGroup.add(proposalsWalkableGroup);
    }
    if (!proposalsBuildingsGroup) {
        proposalsBuildingsGroup = new THREE.Group();
        proposalsBuildingsGroup.name = 'ProposalBuildings';
        proposalsGroup.add(proposalsBuildingsGroup);
    }
    if (!proposalsGhostGroup) {
        proposalsGhostGroup = new THREE.Group();
        proposalsGhostGroup.name = 'ProposalBuildingGhosts';
        markInspectionLayer(proposalsGhostGroup, {
            id: 'proposal-building-ghosts',
            label: 'Proposal building ghosts',
            category: 'Plans',
            source: 'world/proposals.js · transparent proposal massing',
            order: 181,
        });
        proposalsBuildingsGroup.add(proposalsGhostGroup);
    }
}

// Build/show what the current display state wants, hide what it doesn't.
// Both representations are lazy: the state that is never entered is never
// built. Masking never varies with state — a proposed building substitutes
// for the cadastre one on its plot in solid, ghost AND off.
function applyBuildingDisplayState() {
    const policy = proposalBuildingDisplayPolicy(buildingDisplayState);
    if (activeBuildings.length && buildingsEmitAnchor) {
        const { anchorLat, anchorLon } = buildingsEmitAnchor;
        if (policy.solid && !solidBuildingsEnqueued) {
            solidBuildingsEnqueued = true;
            const byTile = proposalBuildingFeaturesByTile(activeBuildings, {
                anchorLat,
                anchorLon,
                tileSizeM: PROPOSAL_BUILDING_TILE_SIZE_M,
            });
            // Frame-budgeted: the buildings queue schedules these like any
            // streamed tile, near-first. Loud on failure, and only about the
            // buildings — the rest of the overlay is already up.
            enqueueProposalBuildingTiles(byTile).catch((err) => {
                console.error('[proposals] solid proposal buildings failed to build', err);
            });
        }
        if (policy.ghost && !ghostBuildingsEmitted) {
            ghostBuildingsEmitted = true;
            ensureGroup();
            emitGhostBuildings(anchorLat, anchorLon);
        }
    }
    setProposalBuildingMeshesVisible(policy.solid);
    if (proposalsGhostGroup) proposalsGhostGroup.visible = policy.ghost;
    if (proposalsBuildingsGroup) {
        for (const child of proposalsBuildingsGroup.children) {
            if (child.userData && child.userData.proposalBuildingModel) {
                child.visible = policy.models;
            }
        }
    }
}

// N in the cab/walk cycles solid → ghost → off. Returns the new state for the
// toast, or null when there is nothing to toggle (no proposal buildings) so
// the key stays inert on plain rides.
export function cycleProposalBuildingDisplay() {
    if (!activeBuildings.length) return null;
    buildingDisplayState = nextProposalBuildingDisplay(buildingDisplayState);
    applyBuildingDisplayState();
    return buildingDisplayState;
}

export function getProposalBuildingDisplay() {
    return buildingDisplayState;
}

// The overlay's passive ground fabric refines one polygon at a time. Engineered
// roads go further: every repeat-item invocation builds at most one bounded
// longitudinal chunk, then the complete off-scene road publishes atomically.
// This keeps a 299-proposal plan (~1,900 ground polygons) and kilometre-scale
// authored roads inside the shared frame budget. Flat worlds pay almost
// nothing per item and drain in a few frames. `trackWorldReady: false` — the
// overlay streams in behind the load hold like the far ring does; it must not
// delay the reveal.
const emitQueue = createFrameChunkQueue({
    label: 'proposal-overlay',
    frameBudgetMs: 3,
    pauseDuringMovement: false,
    preferAnimationFrame: true,
    trackWorldReady: false,
    workClass: 'near',
});
let emitJob = null;
let proposalRoadRefreshJob = null;
let proposalRoadObservedFormationRevision = null;
let proposalRoadAnchorLat = null;
let proposalRoadAnchorLon = null;
let proposalRoadMappedSeaRevision = 0;
let proposalRoadMappedSeaUnsubscribe = null;
const activeProposalRoadBuildTasks = new Set();
const pendingProposalRoadRefreshes = new Set();
const pendingProposalRoadJunctionRefreshes = new Set();

function stepProposalOverlayItem(item, group, anchorLat, anchorLon) {
    if (proposalsGroup !== group) {
        item.dispose?.();
        return undefined;
    }
    // Never let a mesh query trigger RoadFormationModel's atomic fallback
    // build. OSM streams and proposal registration can both dirty the shared
    // authority; advance one bounded stage and keep this item at the head
    // until a complete generation is published.
    if (item.requiresRoadFormation
        && proposalRoadFormationModel?.hasPendingBuild?.() === true) {
        proposalRoadFormationModel.stepPendingBuildPreparation?.();
        return FRAME_CHUNK_REPEAT_ITEM;
    }
    // A completed engineered formation is its road surface's placement
    // authority. Its longitudinal solver deliberately bridges small DTM
    // NoData gaps from measured samples on both sides; applying the passive-
    // polygon all-points terrain gate here suppressed an otherwise complete
    // two-kilometre coastal road because 19 corridor samples crossed Adriatic
    // NoData. Passive parks, squares and water retain the strict raw-terrain
    // gate because they have no designed profile.
    const hasFormationIds = Array.isArray(item.formationIds)
        && item.formationIds.length > 0;
    if (hasFormationIds) {
        if (!proposalRoadSurfaceReady(
            proposalRoadFormationModel,
            item.formationIds,
        )) {
            item.dispose?.();
            return undefined;
        }
    } else if (!proposalTerrainEvidenceReady(
        item.terrainInput,
        anchorLat,
        anchorLon,
    )) return undefined;
    try {
        return item.run();
    } catch (err) {
        // A proposal that fails to draw costs that proposal, never the rest of
        // the overlay (same rule as the data gate).
        console.error('[proposals] overlay item failed to draw', err);
        return undefined;
    }
}

function emitAll(anchorLat, anchorLon) {
    ensureGroup();
    // A late item must never draw into the NEXT session's scene: everything
    // enqueued below re-checks that the group it was built for is still live.
    const group = proposalsGroup;
    const landscapedTrees = [];
    const laneOut = { positions: [], uvs: [], indices: [], vertBase: 0, stripY: PROPOSAL_LANE_MARKING_Y };
    const parkingPositions = [];
    const publishedFormationIds = new Set();
    const items = [];
    // Order matters within the list exactly as it did in the old synchronous
    // emit: ground surfaces first (so building/tree shadows fall on them
    // visibly), then verticals; accumulator finalizers after every
    // contributor. The queue preserves enqueue order.
    const addItem = (terrainInput, run, {
        requiresRoadFormation = false,
        formationIds = [],
        dispose = null,
    } = {}) => {
        items.push({ terrainInput, run, requiresRoadFormation, formationIds, dispose });
    };
    for (const lake of activeLakes) {
        addItem(lake, () => emitLake(lake, anchorLat, anchorLon));
    }
    for (const r of activeRoads) {
        if (r.isTrack) continue;
        const roadTask = createProposalRoadBuildTask(
            r,
            anchorLat,
            anchorLon,
            landscapedTrees,
        );
        addItem(
            r,
            () => {
                const published = roadTask.step();
                if (published === true && r.formationId != null) {
                    publishedFormationIds.add(String(r.formationId));
                }
                return published;
            },
            {
                requiresRoadFormation: r.formationId != null,
                formationIds: r.formationId != null ? [r.formationId] : [],
                dispose: () => roadTask.dispose(),
            },
        );
        addItem(
            r,
            () => {
                if (r.surfaceGroup) {
                    accumulateRoadLaneMarkings(r, anchorLat, anchorLon, laneOut);
                }
            },
            {
                requiresRoadFormation: r.formationId != null,
                formationIds: r.formationId != null ? [r.formationId] : [],
            },
        );
        addItem(
            r,
            () => {
                if (r.surfaceGroup) {
                    accumulateRoadParkingMarkings(r, anchorLat, anchorLon, parkingPositions);
                }
            },
            {
                requiresRoadFormation: r.formationId != null,
                formationIds: r.formationId != null ? [r.formationId] : [],
            },
        );
    }
    for (const junction of activeRoadJunctions) {
        addItem(
            junction,
            () => publishRoadJunction(junction, anchorLat, anchorLon),
            {
                requiresRoadFormation: true,
                formationIds: junction.formationIds || [],
            },
        );
    }
    addItem(null, () => finalizeLaneMarkings(laneOut));
    addItem(null, () => finalizeParkingMarkings(parkingPositions));
    addItem(
        landscapedTrees,
        () => emitTreeInstancesAtCoordinates(
            landscapedTrees,
            anchorLat,
            anchorLon,
            PROPOSAL_RAISED_STRIP_Y,
            'ProposalRoadTrees',
            (x, z, source) => proposalRoadYAtLocal(source, x, z),
        ),
        { requiresRoadFormation: activeRoads.some(road => road.formationId != null) },
    );
    for (const p of activeParks) {
        addItem(p, () => emitPark(p, anchorLat, anchorLon));
    }
    for (const s of activeSquares) {
        addItem(s, () => emitSquare(s, anchorLat, anchorLon));
    }
    if (items.length > 0) {
        // Enqueued only once the load hold has lifted: the overlay shares the
        // near-class frame budget with the spawn tiles, and letting ~1,900
        // draped polygons compete with them doubled the hold (measured 2.5 s
        // → 5.3–7.0 s). The reveal gates the CITY; the plan overlay streams in
        // right after it, like the far ring — and the walker stands on
        // terrain 10–25 cm below the incoming surfaces in the meantime.
        onWorldReady(() => {
            if (proposalsGroup !== group) return;
            // A single unevidenced far/coastal polygon used to sit at the head
            // of this one queue forever: everything behind it stayed invisible
            // while the already-published formation mask cut holes for all of
            // them. This layer is explicitly single-session, not spatially
            // streamed, so an unsupported item completes as a no-op. Keep the
            // evidence checks cooperative inside the queue: preflighting the
            // whole plan synchronously would merely turn the void into a long
            // reveal-frame stall.
            emitJob = emitQueue.enqueue(
                items,
                item => stepProposalOverlayItem(item, group, anchorLat, anchorLon),
                {
                    onComplete: () => {
                        emitJob = null;
                        if (proposalsGroup !== group || !proposalRoadFormationModel) return;
                        // The complete supported overlay is visible first; only
                        // then may its successfully published roads own civil ground
                        // and remove the terrain beneath their tops/dressing.
                        proposalRoadFormationModel.setSurfacePublicationReadyForOsmIds(
                            Array.from(publishedFormationIds),
                            true,
                        );
                    },
                },
            );
        });
    }
    // Buildings go through the display-state machine: solid routes them into
    // the ordinary buildings pipeline (frame-budgeted, batched, local style),
    // ghost emits the glass prisms, off shows the cleared plots. The old
    // unconditional emit built 860 prisms synchronously in this frame.
    buildingsEmitAnchor = { anchorLat, anchorLon };
    emitBuildingModels(anchorLat, anchorLon);
    applyBuildingDisplayState();
}

function observeProposalRoadFormationChanges() {
    const model = proposalRoadFormationModel;
    if (!model || !Number.isInteger(model.revision)) return;
    if (!Number.isInteger(proposalRoadObservedFormationRevision)) {
        proposalRoadObservedFormationRevision = model.revision;
        return;
    }
    if (model.revision === proposalRoadObservedFormationRevision) return;
    const change = typeof model.getChangesSince === 'function'
        ? model.getChangesSince(proposalRoadObservedFormationRevision)
        : { revision: model.revision, full: true, bounds: [] };
    proposalRoadObservedFormationRevision = change.revision;
    for (const road of activeRoads) {
        if (road.isTrack || road.formationId == null || !road.surfaceGroup) continue;
        if (proposalRoadSurfaceOwnerNeedsRefresh(road, change)) {
            pendingProposalRoadRefreshes.add(road);
        }
    }
    for (const junction of activeRoadJunctions) {
        if (!junction.surfaceMesh) continue;
        if (proposalRoadSurfaceOwnerNeedsRefresh(junction, change)) {
            pendingProposalRoadJunctionRefreshes.add(junction);
        }
    }
}

function observeProposalRoadMappedSeaChange() {
    proposalRoadMappedSeaRevision += 1;
    for (const road of activeRoads) {
        if (road.isTrack || road.formationId == null || !road.surfaceGroup) continue;
        if (road.renderedMappedSeaRevision !== proposalRoadMappedSeaRevision) {
            pendingProposalRoadRefreshes.add(road);
        }
    }
}

function scheduleProposalRoadRefresh() {
    if (emitJob || proposalRoadRefreshJob
        || (pendingProposalRoadRefreshes.size === 0
            && pendingProposalRoadJunctionRefreshes.size === 0)) return;
    if (!proposalsGroup || !proposalsWalkableGroup || !proposalRoadFormationModel) return;
    if (!Number.isFinite(proposalRoadAnchorLat) || !Number.isFinite(proposalRoadAnchorLon)) return;
    const group = proposalsGroup;
    const roads = Array.from(pendingProposalRoadRefreshes).filter(road => (
        road.surfaceGroup
        && road.formationId != null
    ));
    const junctions = Array.from(pendingProposalRoadJunctionRefreshes).filter(junction => (
        junction.surfaceMesh
        && Array.isArray(junction.formationIds)
        && junction.formationIds.length > 0
    ));
    if (roads.length === 0 && junctions.length === 0) return;
    const items = roads.map((road) => {
        const task = createProposalRoadBuildTask(
            road,
            proposalRoadAnchorLat,
            proposalRoadAnchorLon,
        );
        return {
            terrainInput: road,
            requiresRoadFormation: true,
            formationIds: [road.formationId],
            run: () => task.step(),
            dispose: () => task.dispose(),
        };
    });
    items.push(...junctions.map(junction => ({
        terrainInput: junction,
        requiresRoadFormation: true,
        formationIds: junction.formationIds,
        run: () => publishRoadJunction(
            junction,
            proposalRoadAnchorLat,
            proposalRoadAnchorLon,
        ),
    })));
    proposalRoadRefreshJob = emitQueue.enqueue(
        items,
        item => stepProposalOverlayItem(
            item,
            group,
            proposalRoadAnchorLat,
            proposalRoadAnchorLon,
        ),
        {
            onComplete: () => {
                proposalRoadRefreshJob = null;
            },
        },
    );
}

function updateProposalRoadFormationRefresh() {
    observeProposalRoadFormationChanges();
    scheduleProposalRoadRefresh();
}

// ctx fields used:
//   - anchorLat, anchorLon
//   - proposalIds: number[] | string[] (optional)
export const proposalsLayer = {
    beginSession(ctx) {
        proposalRoadFormationModel = ctx?.roadFormation || null;
        proposalRoadObservedFormationRevision = proposalRoadFormationModel?.revision ?? null;
        proposalRoadAnchorLat = Number(ctx?.anchorLat);
        proposalRoadAnchorLon = Number(ctx?.anchorLon);
        proposalRoadMappedSeaUnsubscribe?.();
        proposalRoadMappedSeaUnsubscribe = subscribeMappedSeaChanges(
            observeProposalRoadMappedSeaChange,
        );
        // Any planner track that physically runs through a building ghosts it,
        // not only saved cb-proposal tracks. A freshly drawn / directly
        // elevation-edited line (source 'user'/'user-line') carves terrain and
        // builds its rail bed via the same isEngineeredRailFeature path, so it
        // must ghost intersected buildings too — otherwise the track drives
        // straight through solid façades.
        const proposalTracks = (ctx?.customTrackCorridors || []).filter(
            isAuthoredPlannerRailFeature,
        );
        // How proposal buildings render this session: ?proposalsView=solid|
        // ghost|off, default solid. Re-parsed per session so a share link
        // opens in the state it names; N cycles it live afterwards.
        buildingDisplayState = parseProposalBuildingDisplay();
        proposalTrackImpactSessionCtx = ctx || null;
        proposalTrackImpactIndex = proposalTracks.length > 0
            ? new ProposalTrackImpactIndex({
                anchorLat: ctx.anchorLat,
                anchorLon: ctx.anchorLon,
                features: proposalTracks,
                halfWidthForFeature: (feature) => getTrackbedHalfWidthMeters(
                    feature?.properties || {},
                ) + PROPOSAL_TRACK_CONSTRUCTION_CLEARANCE_M,
                // The rails layer publishes its formation on the shared session
                // ctx during the same boot; buildings stream (and ask about
                // demolition) only after. Read it lazily so tunnel and viaduct
                // spans can spare the buildings above/below them.
                railFormation: () => proposalTrackImpactSessionCtx?.railFormation || null,
                // Lets the index tell an overpass from a wall: a building's
                // surveyed base is absolute (EVRF2000) while the formation
                // reports rail and ground in scene metres, and the overhead
                // test subtracts them. Read lazily for the same reason the
                // formation is — terrain arms during the same session boot.
                absoluteToSceneY: (heightM) => {
                    const terrain = getTerrainReference();
                    if (!terrain || typeof terrain.absoluteToSceneY !== 'function') return null;
                    return terrain.absoluteToSceneY(heightM);
                },
            })
            : null;
        const ids = ctx && ctx.proposalIds;
        // ?plan=<slug or ENS name> loads a whole NAMED plan without enumerating
        // its ids — /plans/<slug> answers with them. Merged with any explicit
        // ?proposals= list, explicit first.
        const planSlug = parseEnsPlanParam();
        if ((!Array.isArray(ids) || ids.length === 0) && !planSlug) return;
        // With enumerated ids the fetches start immediately and in parallel,
        // exactly as before: the carve only needs the ids from the deeplink,
        // not the proposals themselves. A NAMED plan costs one resolving
        // round-trip first — nothing knows the ids until the plan answers.
        // The buildings layer awaits proposalsReady() before it builds
        // anything, so an existing building is never drawn uncarved either way.
        const location = getLocation();
        const cityId = location.regionalLocationId || location.styleCityId || location.id;
        const idsReady = planSlug
            ? loadPlanProposalIds(planSlug).then(
                (planIds) => mergeProposalIds(ids, planIds),
                (err) => {
                    // A typoed plan name costs the plan, never the explicitly
                    // listed proposals — and never the city (see the gate note).
                    console.error(`[proposals] named plan "${planSlug}" failed to resolve`, err);
                    return mergeProposalIds(ids, null);
                })
            : Promise.resolve(mergeProposalIds(ids, null));
        const dataReady = idsReady.then((allIds) => (allIds.length === 0 ? [] : Promise.all([
            loadProposals(allIds, ctx.prefetchedProposals),
            loadLegacyCarves(allIds, cityId),
        ])));
        // The gate is on the DATA, never on the emit/sweep block below — and it never rejects.
        // The whole cadastre building layer is downstream of this promise: if it stayed pending or
        // rejected because emitting some proposal's geometry threw, the city would come up with no
        // buildings at all. A proposal that fails to draw must cost us that proposal, not the city.
        proposalsReadyPromise = dataReady.catch(() => {});
        dataReady.then(() => {
            // Roads own one shared grade/cut/fill model for the session. The
            // proposal fetch resolves after roads.js starts, so publish these
            // authored centreline + surface features before any overlay mesh
            // samples a height. Generic park/path drape remains untouched.
            registerProposalRoadFormation();
            // Even when no polygons need rendering, road-only proposals
            // (centerline-only, no polygon footprint) still want their
            // centerlines injected into the cars graph below — so we
            // don't early-return on an empty mask.
            if (maskPolygons.length > 0) emitAll(ctx.anchorLat, ctx.anchorLon);
            // Other streamed/static ground layers may have rendered before
            // the proposal fetch resolved. Rebuild/sweep them now against
            // the populated mask so grey OSM infra cannot remain across a
            // proposal lake, park, square, or road.
            //
            // Existing BUILDINGS are swept against the proposal-buildings mask ONLY: what a road,
            // park, square or lake did to a building is the server carve's answer (applied at
            // intake in buildings.js), and sweeping them by the union mask here is precisely what
            // used to delete tunnelled buildings along with razed ones. Buildings gate on
            // proposalsReady() so in practice nothing is left to sweep — this stays as the
            // belt-and-braces pass for anything a future streamed source renders early.
            pruneBuildingsByMask((lat, lon) => isMaskedByProposalBuildings(lat, lon));
            rebuildRoadsForProposalMask();
            rebuildLaneMarkingsForProposalMask();
            rebuildRailsForProposalMask();
            rebuildDecorForProposalMask((lat, lon) => isMaskedByProposals(lat, lon));
            // Inject proposal road centerlines into the cars graph so
            // cars route over the new streets like any other road.
            // Tracks (tram corridors) are skipped inside cars.js.
            for (const r of activeRoadCenterlines) {
                addProposalRoadCenterlines(r.lineStrings, r.proposalId, {
                    isTrack: r.isTrack,
                    formationIds: r.formationIds,
                });
            }
        }).catch((err) => {
            // Loud, and only ever about the overlay: the buildings gate above is already settled.
            console.error('[proposals] rendering the proposal overlay failed', err);
        });
    },
    onFrame() {
        updateProposalRoadFormationRefresh();
        if (proposalsGroup && sharedMats.water) {
            animateWaterMaterials(
                [sharedMats.water],
                (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
            );
        }
    },
    endSession() {
        proposalRoadMappedSeaUnsubscribe?.();
        proposalRoadMappedSeaUnsubscribe = null;
        if (emitJob) {
            emitQueue.cancel(emitJob);
            emitJob = null;
        }
        if (proposalRoadRefreshJob) {
            emitQueue.cancel(proposalRoadRefreshJob);
            proposalRoadRefreshJob = null;
        }
        for (const task of Array.from(activeProposalRoadBuildTasks)) task.dispose();
        pendingProposalRoadRefreshes.clear();
        pendingProposalRoadJunctionRefreshes.clear();
        unregisterProposalRoadFormation();
        if (proposalsGroup) {
            disposeGroup(proposalsGroup);
            proposalsGroup = null;
        }
        proposalsBuildingsGroup = null;
        proposalsGhostGroup = null;
        proposalsWalkableGroup = null;
        solidBuildingsEnqueued = false;
        ghostBuildingsEmitted = false;
        buildingsEmitAnchor = null;
        maskPolygons = [];
        maskRevision++;
        maskReadSnapshot = null;
        buildingMaskPolygons = [];
        legacyCarves = null;
        trackDemolishedIds.clear();
        trackDemolishedGeo.clear();
        passedDemolishedIds.clear();
        hideDemolishedCounter();
        proposalTrackImpactIndex = null;
        proposalTrackImpactSessionCtx = null;
        proposalsReadyPromise = Promise.resolve();
        activeBuildings = [];
        activeParks = [];
        activeSquares = [];
        activeLakes = [];
        activeParkPonds = [];
        activeRoads = [];
        activeRoadJunctions = [];
        activeRoadCenterlines = [];
        proposalRoadObservedFormationRevision = null;
        proposalRoadAnchorLat = null;
        proposalRoadAnchorLon = null;
        proposalRoadMappedSeaRevision = 0;
    },
};
