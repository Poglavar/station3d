// Paints dashed white lane-divider strips on car-drivable roads. Uses a
// forward-prefetched /roads?bbox=… LineString source independent from the
// smaller traffic graph, so paint reaches the fog horizon without spawning
// distant cars. Simultaneous identical HTTP requests are still coalesced by
// the shared tile session. Active tiles feed one deduplicated road graph so a
// way returned by adjacent bboxes owns one marking lineage, not two.
//
// When the road data carries explicit lane counts, we derive one dashed strip
// per interior lane boundary. Without lane metadata, we fall back to a small
// set of type-based offsets so major corridors still read wider than a single
// residential centerline.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import {
    buildLaneMarkingPathsResumable,
    buildOffsetPath,
    getLaneMarkingOffsetsForProperties,
    laneMarkingFeatureKey,
} from '../core/lane-marking-geometry.js';
import {
    createSettleGate,
    markSettleGateApplied,
    shouldRunOnSettle,
} from '../core/settle-gate.js';
import {
    assembleStripGeometrySteps,
    chunkStripPath,
    createStripGeometryCache,
} from '../core/strip-geometry-cache.js';
import { projectReceiverDetailSteps } from '../core/receiver-detail-projection.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { noteWorldQueueActive, noteWorldQueueIdle } from '../core/world-ready.js';
import { getApiBase } from '../core/api.js';
import { NEAR_ROAD_STREAM_OPTIONS } from '../core/tile-stream.js';
import { scene } from '../scene/setup.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { isLineStringMaskedByProposals } from './proposals.js';
import {
    getRenderedRoadSurfaceRevision,
    renderedRoadTrianglesInBounds,
} from './roads.js';
import { GROUND_SURFACE_LEVELS } from './ground-surface-levels.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { createTileFeatureRegistry } from '../core/tile-feature-registry.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';

import { getPlannerStructuralSurfaceCutouts } from './planner-elevation.js';

const DRIVABLE = new Set([
    'motorway', 'motorway_link',
    'trunk', 'trunk_link',
    'primary', 'primary_link',
    'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
    'residential', 'unclassified',
]);

const STRIP_WIDTH = 0.14;       // metres
// Ordinary road paint yields to a published same-level trackbed. The exact
// prepass contains only ordinary at-grade tram segments, so bridge/underpass
// markings remain untouched and dedicated crossing dressing can opt in above
// the bed in world/level-crossings.js.
const STRIP_Y     = GROUND_SURFACE_LEVELS.roadMarking;
const STRIP_RENDER_ORDER = SURFACE_RENDER_ORDER.ROAD_MARKING;
const LANE_PUBLICATION_KEY = 'lane-markings:active-road-graph';
const INITIAL_LANE_READY_LABEL = 'lane-markings.rebuild';
const DASH_PERIOD_M = 6.0;      // 3 m dash + 3 m gap (Croatian-ish proportion)
const LANE_AHEAD_PREFETCH_M = 1400;
const LANE_AHEAD_HALF_WIDTH_M = 120;

let group = null;
const createLaneMarkingTileRegistry = () => createTileFeatureRegistry({
    featureKey: (feature, tileKey, index) => (
        laneMarkingFeatureKey(feature) ?? `tile:${tileKey}:${index}`
    ),
});
let tileFeatures = createLaneMarkingTileRegistry();
let aggregateMesh = null;
let surfacePublications = null;
let lanePublicationGeneration = 0;
let initialLanePublicationPending = false;
const LANE_MARKING_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.ROAD_MARKING,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    // One draw-call aggregate can contain ground, bridge, and underpass paint.
    // Until it is split by vertical band it must fail closed on every coarse
    // discard mechanism and rely on the owning road's physical depth.
    verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
    ownerId: 'lane-markings:active-road-graph',
    sourceId: 'world/lane-markings.js',
});
// Tile churn is coalesced into ONE rebuild per settled burst.
//
// The rebuild re-merges and re-triangulates EVERY loaded tile into a single mesh
// (deliberately single: Zagreb is draw-call bound). It used to run from its own
// requestAnimationFrame on every addTile/removeTile, so a stream delivering N
// tiles over N frames did N full rebuilds — O(N^2) across a session. Measured
// 2026-07-27 on a Split ride: ~23-30 ms inside hooks, the most frequent single
// cause in a 217-stutter window.
//
// Waiting for a QUIET SPELL rather than a timeout, matching the roadFormation
// revision settle below and the house rule against sleeping on a guess.
//
// The first attempt at this required ONE quiet frame, which barely coalesced
// anything: tiles arrive with gaps, so nearly every arrival still got its own
// quiet frame and its own full rebuild. Measured afterwards at 97 fps, lane
// markings still rebuilt about four times a second — one per ~25 frames, which
// was the deferral cap firing, not the settle.
//
// So both knobs are sized for how a tile stream actually delivers: ~12 frames
// (~0.12 s) of quiet before rebuilding, and at most one forced rebuild per ~120
// frames (~1.2 s) while the stream never stops. Lane markings are painted road
// detail; appearing a beat later is invisible, whereas a 37 ms hitch is not.
//
// Reducing frequency was the first lever. The per-rebuild COST is addressed two
// further ways. First, memoisation — buildLaneMarkingPaths is cross-feature, so
// every OSM/topology revision still solves the complete active graph, but its
// immutable result is reused by terrain-only refreshes. Its per-vertex drape is
// cached separately by resulting path points (core/strip-geometry-cache.js).
// Second, the drape — 81% of the
// cost, and the part that re-runs in full when the road formation revises under
// the paint — is time-sliced across frames by beginRebuild/stepRebuild: the old
// mesh stays up until the new one is assembled, so spreading it never blinks and
// a formation revision no longer forces a whole-city rebuild in one frame.
const REBUILD_QUIET_FRAMES = 12;
const REBUILD_MAX_DEFERRED_FRAMES = 120;
let tileRevision = 0;
let rebuildGate = createSettleGate({
    quietFrames: REBUILD_QUIET_FRAMES,
    maxDeferredFrames: REBUILD_MAX_DEFERRED_FRAMES,
});
let dashTexture = null;
let dashMaterial = null;
let tileSource = null;
let tileSubscription = null;
let anchorLat = 0, anchorLon = 0;
let terrainReference = null;
let terrainChangeSubscription = null;
let roadFormationModel = null;
let roadFormationRevision = -1;
let roadFormationPendingRevision = -1;
let renderedRoadRevision = -1;
// Set when the road formation has revised (heights under the paint moved) and a
// rebuild is owed; the onFrame driver starts it through the resumable path.
let formationRebuildRequested = false;
let roadVerticalAlignmentModel = null;
let stripCache = createStripGeometryCache();
let lastCacheStats = null;
let cacheFormationRevision = -1;
// OSM membership and authored lane topology are immutable between their
// explicit revisions. Terrain/formation refreshes move only Y, so retain the
// completed cross-feature solve instead of spending CPU and allocations on the
// same path graph again.
let proposalMaskRevision = 0;
let solvedPathTopology = null; // { key, entries }
let topologyCacheHits = 0;
let topologyCacheMisses = 0;
let lastInvalidationStats = null;
let worstInvalidationStats = null;

function currentPathTopologyKey() {
    const verticalRevision = finiteOrNull(roadVerticalAlignmentModel?.revision);
    return `${tileRevision}|${verticalRevision ?? -1}`
        + `|${proposalMaskRevision}`;
}

// The GLOBAL half of invalidation: changes with no location, where dropping
// everything is the only correct answer. The planner surface cutouts decide
// which stretches of a strip exist at all, and the anchor moves the whole
// local frame. Formation changes are spatial and handled separately below.
//
// Derived from the live values rather than bumped by whoever remembers to —
// see the note in core/strip-geometry-cache.js.
function drapeEpoch() {
    // Exactly the fields getLaneMarkingVisibleIntervalsForLocalSegment reads —
    // a cut that moves or widens changes which stretches of a strip exist, and
    // there is no id or revision on these to lean on instead.
    const cuts = getPlannerStructuralSurfaceCutouts();
    let cutsSignature = cuts.length;
    for (const cut of cuts) {
        cutsSignature = (cutsSignature * 31
            + cut.x1 + cut.z1 * 3 + cut.x2 * 7 + cut.z2 * 11
            + (Number(cut.widthM) || 0) * 13) % 1e12;
    }
    return `${cutsSignature}|${anchorLat},${anchorLon}`
        + `|terrain:${finiteOrNull(terrainReference?.revision) ?? -1}`;
}

// A drape query reads the formation near a vertex, not only under it, so a
// changed formation invalidates a little beyond its own footprint.
const DRAPE_INFLUENCE_PAD_M = 30;

// The road formation is deliberately NOT part of the epoch. It re-revisions on
// every streamed tile, and folding it in wiped the cache on nearly every
// rebuild — measured at hits 0 / misses 751, against 748/3 on the rebuilds
// where it happened to hold still. It reports WHERE it changed, so drop only
// the paths over that ground. Large generations can carry thousands of bounded
// changes, therefore even the indexed invalidation is advanced cooperatively.
function createFormationInvalidationJob() {
    const hasChangeSource = roadFormationModel
        && typeof roadFormationModel.getChangesSince === 'function';
    const changes = hasChangeSource
        ? roadFormationModel.getChangesSince(cacheFormationRevision)
        : null;
    const bounds = Array.isArray(changes?.bounds) ? changes.bounds : [];
    const revision = finiteOrNull(changes?.revision);
    return {
        revision: revision ?? cacheFormationRevision,
        bounds,
        full: !!hasChangeSource && (cacheFormationRevision < 0 || changes?.full === true),
        initialized: false,
        done: false,
        iterator: null,
        dropped: 0,
        cpuMs: 0,
        worstSliceMs: 0,
    };
}

function stepFormationInvalidation(build, frameStartedMs, frameBudgetMs) {
    if (build.cachePassStarted) return true;
    if (!build.invalidationJob) {
        build.invalidationJob = createFormationInvalidationJob();
    }
    const job = build.invalidationJob;
    const sliceStartedMs = performance.now();
    if (!job.initialized) {
        job.initialized = true;
        if (job.full) {
            job.dropped = stripCache.invalidateAll();
            job.done = true;
        } else if (job.bounds.length > 0) {
            job.iterator = stripCache.invalidateIntersectingSteps(
                job.bounds,
                DRAPE_INFLUENCE_PAD_M,
            );
        } else {
            job.done = true;
        }
    }
    while (!job.done && job.iterator) {
        const outcome = job.iterator.next();
        if (outcome.done) {
            job.dropped = Number(outcome.value) || 0;
            job.iterator = null;
            job.done = true;
            break;
        }
        if (performance.now() - frameStartedMs > frameBudgetMs) break;
    }
    if (job.done) {
        cacheFormationRevision = job.revision;
        stripCache.beginPass(drapeEpoch());
        build.cachePassStarted = true;
    }
    const sliceMs = performance.now() - sliceStartedMs;
    job.cpuMs += sliceMs;
    job.worstSliceMs = Math.max(job.worstSliceMs, sliceMs);
    recordLayerFrameMs('laneMk:invalidate', sliceMs);
    if (!job.done) return false;

    lastInvalidationStats = {
        bounds: job.full ? -1 : job.bounds.length,
        dropped: job.dropped,
        ms: job.cpuMs,
        worstSliceMs: job.worstSliceMs,
    };
    if (!worstInvalidationStats
        || job.worstSliceMs > worstInvalidationStats.worstSliceMs) {
        worstInvalidationStats = { ...lastInvalidationStats };
    }
    return true;
}

// Exposed for the perf harness: a rebuild that misses on everything is a cache
// that is not working, and that is invisible in a timing alone.
export function getLaneMarkingCacheStats() {
    return lastCacheStats ? {
        ...lastCacheStats,
        topologyHits: topologyCacheHits,
        topologyMisses: topologyCacheMisses,
        invalidationBounds: lastInvalidationStats?.bounds ?? 0,
        invalidationDropped: lastInvalidationStats?.dropped ?? 0,
        invalidationMs: lastInvalidationStats?.ms ?? 0,
        invalidationWorstSliceMs: lastInvalidationStats?.worstSliceMs ?? 0,
        worstInvalidationBounds: worstInvalidationStats?.bounds ?? 0,
        worstInvalidationDropped: worstInvalidationStats?.dropped ?? 0,
        worstInvalidationMs: worstInvalidationStats?.worstSliceMs ?? 0,
    } : null;
}
if (typeof window !== 'undefined') {
    window.__laneMkCacheStats = () => getLaneMarkingCacheStats();
}

// 32×32 canvas: white in the LEFT half, transparent in the right half. With
// wrapS = RepeatWrapping and U set to (along-strip metres / DASH_PERIOD_M),
// each repeat covers a dash + gap, and the strip naturally reads as a
// dashed line when we tile it along the road direction.
function getDashTexture() {
    if (dashTexture) return dashTexture;
    const SIZE = 32;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE / 2, SIZE);
    dashTexture = new THREE.CanvasTexture(canvas);
    dashTexture.wrapS = THREE.RepeatWrapping;
    dashTexture.wrapT = THREE.ClampToEdgeWrapping;
    dashTexture.colorSpace = THREE.SRGBColorSpace;
    dashTexture.anisotropy = 4;
    dashTexture.minFilter = THREE.LinearMipmapLinearFilter;
    dashTexture.magFilter = THREE.LinearFilter;
    dashTexture.generateMipmaps = true;
    registerShared(dashTexture);
    return dashTexture;
}

function getDashMaterial() {
    if (dashMaterial) return dashMaterial;
    dashMaterial = new THREE.MeshBasicMaterial({
        map: getDashTexture(),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        // More-negative offset than asphalt (factor -1, units 1) so the
        // strip wins the depth comparison against the road polygon even at
        // long view distances.
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.ROAD_MARKING.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.ROAD_MARKING.units,
    });
    applySurfaceStencil(dashMaterial, LANE_MARKING_CLAIM);
    applyGroundOwnership(dashMaterial, LANE_MARKING_CLAIM);
    applyPlannerSurfaceCutout(dashMaterial, LANE_MARKING_CLAIM);
    registerShared(dashMaterial);
    return dashMaterial;
}

export function getLaneMarkingOffsetsForFeatureProperties(props = {}) {
    return getLaneMarkingOffsetsForProperties(props);
}

function clipIntervalToAxis(interval, start, delta, min, max) {
    if (Math.abs(delta) < 1e-9) {
        return start >= min && start <= max ? interval : null;
    }
    let a = (min - start) / delta;
    let b = (max - start) / delta;
    if (a > b) [a, b] = [b, a];
    const clippedStart = Math.max(interval[0], a);
    const clippedEnd = Math.min(interval[1], b);
    return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
}

// Complements the shared shader cutout with exact geometry clipping for thin
// road-paint meshes. Transparent MeshBasicMaterial strips have historically
// been the easiest surface to leak across an open cut on some GPU/browser
// combinations. Cutting their segment intervals makes the ownership explicit
// while excluding surface-track cuts, where road paint is intentionally valid.
export function getLaneMarkingVisibleIntervalsForLocalSegment(
    x0,
    z0,
    x1,
    z1,
    cuts = getPlannerStructuralSurfaceCutouts(),
) {
    if (!Array.isArray(cuts) || cuts.length === 0) return [[0, 1]];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const hidden = [];
    for (const cut of cuts) {
        const cutDx = cut.x2 - cut.x1;
        const cutDz = cut.z2 - cut.z1;
        const cutLength = Math.hypot(cutDx, cutDz);
        if (cutLength < 1e-6) continue;
        const roughHalfWidth = Math.max(0, Number(cut.widthM) || 0) * 0.5 + STRIP_WIDTH * 0.5;
        if (Math.max(x0, x1) < Math.min(cut.x1, cut.x2) - roughHalfWidth
            || Math.min(x0, x1) > Math.max(cut.x1, cut.x2) + roughHalfWidth
            || Math.max(z0, z1) < Math.min(cut.z1, cut.z2) - roughHalfWidth
            || Math.min(z0, z1) > Math.max(cut.z1, cut.z2) + roughHalfWidth) {
            continue;
        }
        const alongX = cutDx / cutLength;
        const alongZ = cutDz / cutLength;
        const sideX = -alongZ;
        const sideZ = alongX;
        const relX = x0 - cut.x1;
        const relZ = z0 - cut.z1;
        const startAlong = relX * alongX + relZ * alongZ;
        const deltaAlong = dx * alongX + dz * alongZ;
        const startSide = relX * sideX + relZ * sideZ;
        const deltaSide = dx * sideX + dz * sideZ;
        const halfWidth = roughHalfWidth;
        const capExtension = cut.kind === 'station-entrance' ? halfWidth : 0;
        let interval = clipIntervalToAxis(
            [0, 1],
            startAlong,
            deltaAlong,
            -capExtension,
            cutLength + capExtension,
        );
        if (!interval) continue;
        interval = clipIntervalToAxis(
            interval,
            startSide,
            deltaSide,
            -halfWidth,
            halfWidth,
        );
        if (interval) hidden.push(interval);
    }
    if (hidden.length === 0) return [[0, 1]];
    hidden.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const interval of hidden) {
        const previous = merged[merged.length - 1];
        if (previous && interval[0] <= previous[1] + 1e-6) {
            previous[1] = Math.max(previous[1], interval[1]);
        } else {
            merged.push([...interval]);
        }
    }
    const visible = [];
    let cursor = 0;
    for (const interval of merged) {
        if (interval[0] > cursor + 1e-6) visible.push([cursor, interval[0]]);
        cursor = Math.max(cursor, interval[1]);
    }
    if (cursor < 1 - 1e-6) visible.push([cursor, 1]);
    return visible;
}

function interpolatePoint(from, to, t) {
    return {
        x: from.x + (to.x - from.x) * t,
        z: from.z + (to.z - from.z) * t,
    };
}

function appendStripPath(
    out,
    path,
    stripY,
    heightAt = null,
    cuts = [],
    {
        segmentStart = 0,
        segmentEnd = Array.isArray(path) ? path.length - 1 : 0,
        initialCumulativeM = 0,
    } = {},
) {
    if (!Array.isArray(path) || path.length < 2) return true;
    const half = STRIP_WIDTH / 2;
    const left = buildOffsetPath(path, half, { densify: false });
    const right = buildOffsetPath(path, -half, { densify: false });
    if (left.length !== path.length || right.length !== path.length) return true;
    let cumulativeM = initialCumulativeM;
    const firstSegment = Math.max(0, Math.floor(segmentStart));
    const lastSegment = Math.min(path.length - 1, Math.floor(segmentEnd));
    for (let index = firstSegment; index < lastSegment; index++) {
        const from = path[index];
        const to = path[index + 1];
        const segmentLength = Math.hypot(to.x - from.x, to.z - from.z);
        if (segmentLength < 0.01) continue;
        const visible = getLaneMarkingVisibleIntervalsForLocalSegment(
            from.x, from.z, to.x, to.z, cuts,
        );
        for (const [t0, t1] of visible) {
            const corners = [
                { ...interpolatePoint(left[index], left[index + 1], t0), u: (cumulativeM + segmentLength * t0) / DASH_PERIOD_M, v: 0 },
                { ...interpolatePoint(left[index], left[index + 1], t1), u: (cumulativeM + segmentLength * t1) / DASH_PERIOD_M, v: 0 },
                { ...interpolatePoint(right[index], right[index + 1], t1), u: (cumulativeM + segmentLength * t1) / DASH_PERIOD_M, v: 1 },
                { ...interpolatePoint(right[index], right[index + 1], t0), u: (cumulativeM + segmentLength * t0) / DASH_PERIOD_M, v: 1 },
            ];
            const cornerHeights = heightAt
                ? corners.map(corner => finiteOrNull(heightAt(corner.x, corner.z)))
                : corners.map(() => 0);
            if (cornerHeights.some(height => height === null)) return false;
            for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex++) {
                const corner = corners[cornerIndex];
                out.positions.push(
                    corner.x,
                    stripY + cornerHeights[cornerIndex],
                    corner.z,
                );
                out.uvs.push(corner.u, corner.v);
            }
            const vBase = out.vertBase;
            out.indices.push(vBase + 0, vBase + 1, vBase + 2);
            out.indices.push(vBase + 0, vBase + 2, vBase + 3);
            out.vertBase = vBase + 4;
        }
        cumulativeM += segmentLength;
    }
    return true;
}

function expandStripTriangles(out) {
    const positions = [];
    const uvs = [];
    for (const index of out.indices) {
        positions.push(
            out.positions[index * 3],
            0,
            out.positions[index * 3 + 2],
        );
        uvs.push(out.uvs[index * 2], out.uvs[index * 2 + 1]);
    }
    return { positions, uvs };
}

function stripChunkReceiverRevision(points) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const point of points) {
        minX = Math.min(minX, point.x); minZ = Math.min(minZ, point.z);
        maxX = Math.max(maxX, point.x); maxZ = Math.max(maxZ, point.z);
    }
    const x = (minX + maxX) * .5, z = (minZ + maxZ) * .5;
    return getRenderedRoadSurfaceRevision(
        x,
        z,
        Math.hypot(maxX - minX, maxZ - minZ) * .5 + STRIP_WIDTH,
    );
}

function roadReceiverTrianglesForMarking(bounds, osmId) {
    const wanted = osmId == null ? null : String(osmId);
    return renderedRoadTrianglesInBounds(bounds, {
        acceptPart: part => part.drivable === true
            && (wanted === null || String(part.osmId) === wanted),
    });
}

// Adds dashed centerline strip(s) for a single LineString to the open
// positions/uvs/indices arrays. `coords` is an array of [lon, lat] pairs.
// `offsets` is the list of perpendicular offsets in metres (centerline 0,
// optionally ±lane-divider). Cumulative U is *not* exported across calls,
// so each call's dashes restart at U=0; that's fine for proposal roads
// where each centerline is its own visual unit.
export function appendLaneMarkingStripsForLine(coords, offsets, anchorLatVal, anchorLonVal, out) {
    const cosLat = Math.cos(anchorLatVal * DEG_TO_RAD);
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const stripY = (out && Number.isFinite(out.stripY)) ? out.stripY : STRIP_Y;
    const plannerCuts = getPlannerStructuralSurfaceCutouts();
    const centerline = coords.map(([lon, lat]) => ({
        x: (lon - anchorLonVal) * SCALE_LON,
        z: -(lat - anchorLatVal) * SCALE_LAT,
    }));
    for (const offset of offsets) {
        appendStripPath(
            out,
            buildOffsetPath(centerline, offset),
            stripY,
            out && typeof out.heightAt === 'function' ? out.heightAt : null,
            plannerCuts,
        );
    }
}

export function getLaneMarkingsDashMaterial() {
    return getDashMaterial();
}

// The whole-city lane-marking mesh is rebuilt on two triggers, both frequent
// while driving: tiles settling, and the road formation revising (heights under
// the paint moved). Built synchronously it was one ~70 ms hook stall — merge +
// cross-feature path solve + per-vertex drape of the whole city. The drape is
// 81% of that and is per-path independent, so it is time-sliced across frames:
// `beginRebuild` snapshots the input and opens the cooperative solve;
// `stepRebuild` advances both the cross-feature path solve and the subsequent
// drape within one shared frame budget. The last step assembles and swaps the
// mesh. The OLD mesh stays visible until the swap, so a multi-frame build never
// blinks. A forced (user proposal mask) build passes Infinity and finishes in
// one call.
const LANE_BUILD_FRAME_BUDGET_MS = 4;
// The budget is cooperative, so the unit between clock checks matters. Four
// segments used to be one indivisible cache-miss job; live Zagreb traces saw
// those jobs take 133-275 ms before stepRebuild could yield. One owned segment
// still carries the neighbouring context needed for byte-identical miters and
// dash phase, but bounds the expensive road-formation drape between checks.
const LANE_BUILD_MAX_SEGMENTS_PER_JOB = 1;
let activeBuild = null;   // in-flight resumable rebuild, or null

function disposeLaneMesh(mesh) {
    if (!mesh) return;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.parent) mesh.parent.remove(mesh);
}

function settleInitialLanePublication(result = null) {
    if (!initialLanePublicationPending) return;
    if (result && !['published', 'cleared'].includes(result.status)) return;
    initialLanePublicationPending = false;
    noteWorldQueueIdle(INITIAL_LANE_READY_LABEL);
}

function discardActiveBuild(reason = 'superseded') {
    if (!activeBuild) return;
    activeBuild.publicationTicket?.discard?.(reason);
    activeBuild.receiverProjection?.steps?.return?.();
    activeBuild.cacheEndPassSteps?.return();
    activeBuild.assemblySteps?.return();
    activeBuild = null;
}

function beginLanePublication() {
    const generation = ++lanePublicationGeneration;
    const publicationTicket = surfacePublications?.begin?.({
        key: LANE_PUBLICATION_KEY,
        generation,
        parent: group,
        retire: (_context, root) => disposeLaneMesh(root),
    }) || null;
    return { generation, publicationTicket };
}

function beginRebuild() {
    // Abandon any in-flight build: its half-filled buffers are dropped and its
    // next invalidation pass starts from the last published formation revision.
    // The old mesh is untouched until the new build's final step swaps it, so
    // nothing blinks.
    discardActiveBuild();
    if (!group) return;
    const publication = beginLanePublication();
    const topologyKey = currentPathTopologyKey();
    const plannerCuts = getPlannerStructuralSurfaceCutouts();
    if (solvedPathTopology?.key === topologyKey) {
        topologyCacheHits += 1;
        activeBuild = {
            pathBuild: null,
            topologyKey,
            entries: solvedPathTopology.entries,
            invalidationJob: null,
            cachePassStarted: false,
            entryIndex: 0,
            pathIndex: 0,
            chunks: null,
            chunkIndex: 0,
            receiverProjection: null,
            cached: [],
            plannerCuts,
            drapeMs: 0,
            ...publication,
        };
        markSettleGateApplied(rebuildGate, tileRevision);
        return;
    }
    topologyCacheMisses += 1;
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;

    const startedMs = performance.now();
    const features = tileFeatures.features();
    recordLayerFrameMs('laneMk:merge', performance.now() - startedMs);

    const paintFeatures = [];
    for (const f of features || []) {
        // Skip OSM lane-marking dashes that fall under any proposal —
        // a proposed park / lake shouldn't have white centerline
        // stripes painted across it.
        if (isLineStringMaskedByProposals(f)) continue;
        const props = f.properties || {};
        const laneCountOverride = roadVerticalAlignmentModel
            ?.laneCountOverrideForOsmId(props.osm_id);
        if (roadVerticalAlignmentModel?.replacesRoadSurfaceForOsmId(props.osm_id)
            && laneCountOverride == null) {
            continue;
        }
        const highway = props.highway || 'unclassified';
        if (!DRIVABLE.has(highway)) continue;
        const coords = f.geometry && f.geometry.coordinates;
        if (!coords || coords.length < 2) continue;
        paintFeatures.push(laneCountOverride == null ? f : {
            ...f,
            properties: {
                ...props,
                lanes: String(laneCountOverride),
                tags: {
                    ...(props.tags || {}),
                    lanes: String(laneCountOverride),
                },
            },
        });
    }

    const toLocalPoint = ([lon, lat]) => ({
        x: (lon - anchorLon) * SCALE_LON,
        z: -(lat - anchorLat) * SCALE_LAT,
    });
    // Junction clearances and continuation transitions are cross-feature, so
    // the answer cannot be cached per road. The pure builder yields after each
    // bounded road/topology unit; stepRebuild owns its clock and keeps this
    // formerly 204-295 ms atomic prefix under the same budget as the drape.
    const pathBuild = buildLaneMarkingPathsResumable(paintFeatures, toLocalPoint);
    activeBuild = {
        pathBuild,
        topologyKey,
        entries: null,
        invalidationJob: null,
        cachePassStarted: false,
        entryIndex: 0,
        pathIndex: 0,
        chunks: null,
        chunkIndex: 0,
        receiverProjection: null,
        cached: [],
        plannerCuts,
        drapeMs: 0,
        ...publication,
    };
    // Claim the current tile revision so the settle gate does not re-fire for
    // tiles already folded into this build.
    markSettleGateApplied(rebuildGate, tileRevision);
}

// Drape a time-slice of the pending paths, then assemble in bounded slices and
// swap only the complete mesh. No-op when nothing is pending.
function stepRebuild(frameBudgetMs) {
    if (!activeBuild) return;
    // Streaming may supersede the solve while its detached buffers are being
    // assembled. Never publish a topology already known to be out of date.
    if (activeBuild.topologyKey !== currentPathTopologyKey()) {
        discardActiveBuild('topology-superseded');
        return;
    }
    const startedMs = performance.now();
    if (activeBuild.pathBuild) {
        const pathsStartedMs = performance.now();
        while (activeBuild.pathBuild) {
            const outcome = activeBuild.pathBuild.next();
            if (outcome.done) {
                activeBuild.pathBuild = null;
                activeBuild.entries = outcome.value;
                solvedPathTopology = {
                    key: activeBuild.topologyKey,
                    entries: outcome.value,
                };
                break;
            }
            if (performance.now() - startedMs > frameBudgetMs) {
                recordLayerFrameMs('laneMk:paths', performance.now() - pathsStartedMs);
                return;
            }
        }
        recordLayerFrameMs('laneMk:paths', performance.now() - pathsStartedMs);
        // The solve and drape share one budget. Finishing the former near the
        // deadline must not buy the latter a fresh four milliseconds.
        if (performance.now() - startedMs > frameBudgetMs) return;
    }
    if (!stepFormationInvalidation(activeBuild, startedMs, frameBudgetMs)) return;
    // Invalidation and drape share the same budget too. A 2,937-bound terrain
    // generation must not finish its final cache slice and immediately start
    // spending another four milliseconds on strip geometry.
    if (performance.now() - startedMs > frameBudgetMs) return;
    const { entries, cached, plannerCuts } = activeBuild;
    const stripsStartedMs = performance.now();
    while (activeBuild.entryIndex < entries.length) {
        if (activeBuild.receiverProjection) {
            const projectionStartedMs = performance.now();
            while (activeBuild.receiverProjection) {
                const job = activeBuild.receiverProjection;
                const outcome = job.steps.next();
                if (outcome.done) {
                    const projected = outcome.value;
                    const vertexCount = projected.positions.length / 3;
                    cached.push(stripCache.store(job.cacheKey, job.points, {
                        positions: projected.positions,
                        uvs: projected.attributes.uv,
                        indices: Uint32Array.from(
                            { length: vertexCount },
                            (_value, index) => index,
                        ),
                    }));
                    activeBuild.receiverProjection = null;
                    break;
                }
                if (performance.now() - startedMs > frameBudgetMs) {
                    const elapsedMs = performance.now() - projectionStartedMs;
                    activeBuild.drapeMs += elapsedMs;
                    recordLayerFrameMs('laneMk:receiver', elapsedMs);
                    return;
                }
            }
            const elapsedMs = performance.now() - projectionStartedMs;
            activeBuild.drapeMs += elapsedMs;
            recordLayerFrameMs('laneMk:receiver', elapsedMs);
            continue;
        }
        if (performance.now() - startedMs > frameBudgetMs) {
            const elapsedMs = performance.now() - stripsStartedMs;
            activeBuild.drapeMs += elapsedMs;
            recordLayerFrameMs('laneMk:strips', elapsedMs);
            recordLayerFrameMs('laneMk:geometry', elapsedMs);
            return;   // resume next frame; the old mesh stays up
        }
        const entry = entries[activeBuild.entryIndex];
        const props = entry.feature.properties || {};
        // osm_id is the stable identity across rebuilds; the entry index only
        // stands in for features that arrive without one.
        const featureKey = props.osm_id != null
            ? `w${props.osm_id}`
            : `i${activeBuild.entryIndex}`;
        if (activeBuild.pathIndex >= entry.paths.length) {
            activeBuild.entryIndex += 1;
            activeBuild.pathIndex = 0;
            activeBuild.chunks = null;
            activeBuild.chunkIndex = 0;
            continue;
        }
        const path = entry.paths[activeBuild.pathIndex];
        if (!activeBuild.chunks) {
            activeBuild.chunks = chunkStripPath(path.points, {
                maxSegments: LANE_BUILD_MAX_SEGMENTS_PER_JOB,
            });
            activeBuild.chunkIndex = 0;
        }
        if (activeBuild.chunkIndex >= activeBuild.chunks.length) {
            activeBuild.pathIndex += 1;
            activeBuild.chunks = null;
            activeBuild.chunkIndex = 0;
            continue;
        }
        const chunkIndex = activeBuild.chunkIndex++;
        const chunk = activeBuild.chunks[chunkIndex];
        const phaseKey = chunk.initialCumulativeM.toFixed(6);
        const receiverRevision = stripChunkReceiverRevision(chunk.points);
        const cacheKey = `${featureKey}:${activeBuild.pathIndex}:${chunkIndex}:${phaseKey}`
            + `:receiver${receiverRevision}`;
        const cachedChunk = stripCache.retain(cacheKey, chunk.points);
        if (cachedChunk) {
            cached.push(cachedChunk);
            continue;
        }
        const out = { positions: [], uvs: [], indices: [], vertBase: 0 };
        appendStripPath(out, chunk.points, 0, null, plannerCuts, chunk);
        const source = expandStripTriangles(out);
        if (source.positions.length === 0) {
            cached.push(stripCache.store(cacheKey, chunk.points, {
                positions: [],
                uvs: [],
                indices: [],
            }));
            continue;
        }
        activeBuild.receiverProjection = {
            cacheKey,
            points: chunk.points,
            steps: projectReceiverDetailSteps({
                vertices: source.positions,
                attributes: { uv: { array: source.uvs, itemSize: 2 } },
                receiverTriangles: bounds => roadReceiverTrianglesForMarking(
                    bounds,
                    props.osm_id,
                ),
                isCurrent: () => activeBuild?.topologyKey === currentPathTopologyKey()
                    && receiverRevision === stripChunkReceiverRevision(chunk.points),
            }),
        };
    }
    const elapsedMs = performance.now() - stripsStartedMs;
    activeBuild.drapeMs += elapsedMs;
    recordLayerFrameMs('laneMk:strips', elapsedMs);
    recordLayerFrameMs('laneMk:geometry', elapsedMs);

    if (!activeBuild.cachePassEnded) {
        activeBuild.cacheEndPassSteps ||= stripCache.endPassSteps();
        const cacheStartedMs = performance.now();
        while (performance.now() - startedMs <= frameBudgetMs) {
            const outcome = activeBuild.cacheEndPassSteps.next();
            if (outcome.done) {
                lastCacheStats = outcome.value;
                activeBuild.cachePassEnded = true;
                activeBuild.cacheEndPassSteps = null;
                break;
            }
        }
        recordLayerFrameMs('laneMk:cache', performance.now() - cacheStartedMs);
        if (!activeBuild.cachePassEnded) return;
    }
    const assembleStartedMs = performance.now();
    activeBuild.assemblySteps ||= assembleStripGeometrySteps(cached);
    let assembled;
    let assemblyComplete = false;
    while (performance.now() - startedMs <= frameBudgetMs) {
        const outcome = activeBuild.assemblySteps.next();
        if (outcome.done) {
            assembled = outcome.value;
            assemblyComplete = true;
            break;
        }
    }
    recordLayerFrameMs('laneMk:assemble', performance.now() - assembleStartedMs);
    if (!assemblyComplete) return;
    const completedBuild = activeBuild;
    activeBuild = null;

    if (!assembled) {
        if (completedBuild.publicationTicket) {
            const result = completedBuild.publicationTicket.clear();
            aggregateMesh = null;
            settleInitialLanePublication(result);
        } else {
            disposeAggregateMesh();
            settleInitialLanePublication();
        }
        return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(assembled.positions, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(assembled.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(assembled.indices, 1));
    const bounds = assembled.bounds;
    geo.boundingBox = new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ),
    );
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    // No computeVertexNormals: the dash material is MeshBasicMaterial, the
    // planner cutout shader reads only position, and the mesh neither casts nor
    // receives shadows — so nothing anywhere samples a normal. Computing them
    // allocated a third full-size attribute and ran a cross-product pass over
    // every vertex in the city, once per rebuild, for an attribute no shader
    // ever read.
    const mesh = new THREE.Mesh(geo, getDashMaterial());
    mesh.userData.source = 'active-road-graph';
    markSurfaceClaim(mesh, reviseSurfaceClaim(LANE_MARKING_CLAIM, {
        replacementKey: LANE_PUBLICATION_KEY,
        generation: completedBuild.generation,
    }));
    mesh.renderOrder = STRIP_RENDER_ORDER;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    if (completedBuild.publicationTicket) {
        const result = completedBuild.publicationTicket.publish(mesh, {
            commit: () => { aggregateMesh = mesh; },
        });
        settleInitialLanePublication(result);
    } else {
        const previous = aggregateMesh;
        group.add(mesh);
        aggregateMesh = mesh;
        disposeLaneMesh(previous);
        settleInitialLanePublication();
    }
}

// A full synchronous rebuild in one frame — for the user proposal mask, a global
// change the user expects to see immediately. Discards any in-flight slice.
function rebuildActiveLaneMarkingsSync() {
    beginRebuild();
    stepRebuild(Infinity);
}

function disposeAggregateMesh() {
    if (!aggregateMesh) return;
    const retiring = aggregateMesh;
    aggregateMesh = null;
    if (surfacePublications?.retire?.(LANE_PUBLICATION_KEY, {
        root: retiring,
        reason: 'lane-layer-ended',
    })) return;
    disposeLaneMesh(retiring);
}

function addTile(features, tileKey) {
    if (tileFeatures.setTile(tileKey, features || [])) tileRevision += 1;
}

function removeTile(tileKey) {
    if (tileFeatures.removeTile(tileKey)) tileRevision += 1;
}

export function rebuildLaneMarkingsForProposalMask() {
    if (!group) return 0;
    const before = aggregateMesh ? 1 : 0;
    // The mask is a global change, so this one cannot wait for a quiet frame and
    // is built in full synchronously (beginRebuild claims the settle gate).
    formationRebuildRequested = false;   // subsumed by this immediate rebuild
    proposalMaskRevision += 1;
    rebuildActiveLaneMarkingsSync();
    return before - (aggregateMesh ? 1 : 0);
}

export const laneMarkingsLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        sharedTileSession,
        initialPose,
        terrain,
        roadFormation,
        roadVerticalAlignments,
        surfacePublications: publicationRegistry,
    }) {
        surfacePublications = publicationRegistry || null;
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(() => {
            discardActiveBuild('terrain-revised');
            formationRebuildRequested = true;
        }) || null;
        roadFormationModel = roadFormation || null;
        roadVerticalAlignmentModel = roadVerticalAlignments || null;
        roadFormationRevision = roadFormationModel ? roadFormationModel.revision : -1;
        roadFormationPendingRevision = roadFormationRevision;
        renderedRoadRevision = getRenderedRoadSurfaceRevision();
        if (!group) {
            group = new THREE.Group();
            group.name = 'LaneMarkings';
            markInspectionLayer(group, {
                id: 'lane-markings',
                label: 'Lane markings',
                category: 'Transport',
                source: 'world/lane-markings.js · derived OSM lane paint',
                order: 130,
            });
            scene.add(group);
        }
        tileFeatures = createLaneMarkingTileRegistry();
        aggregateMesh = null;
        discardActiveBuild('session-reset');
        formationRebuildRequested = false;
        tileRevision = 0;
        stripCache = createStripGeometryCache();
        lastCacheStats = null;
        cacheFormationRevision = -1;
        proposalMaskRevision = 0;
        solvedPathTopology = null;
        topologyCacheHits = 0;
        topologyCacheMisses = 0;
        lastInvalidationStats = null;
        worstInvalidationStats = null;
        rebuildGate = createSettleGate({
            quietFrames: REBUILD_QUIET_FRAMES,
            maxDeferredFrames: REBUILD_MAX_DEFERRED_FRAMES,
        });
        initialLanePublicationPending = true;
        noteWorldQueueActive(INITIAL_LANE_READY_LABEL);

        tileSource = sharedTileSession.getSource({
            // Cars deliberately keep a smaller moving graph. A separate
            // lightweight source lets paint prefetch to the fog horizon
            // without spawning distant traffic or rebuilding its graph.
            key: 'roads:lane-markings',
            label: 'lane-markings',
            url: (bb) => `${getApiBase()}/roads?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        tileSubscription = tileSource.subscribe({
            onFetch: (features, tileKey) => addTile(features, tileKey),
            onEvict: (tileKey) => removeTile(tileKey),
        });
        tileSource.ensureAround(0, 0);
        tileSource.ensureAhead(0, 0, initialPose && initialPose.headingDeg, {
            distanceM: LANE_AHEAD_PREFETCH_M,
            halfWidthM: LANE_AHEAD_HALF_WIDTH_M,
        });
    },
    onFrame(pose, local) {
        const nextRenderedRoadRevision = getRenderedRoadSurfaceRevision();
        if (nextRenderedRoadRevision !== renderedRoadRevision) {
            renderedRoadRevision = nextRenderedRoadRevision;
            discardActiveBuild('road-receiver-revised');
            formationRebuildRequested = true;
        }
        if (roadFormationModel && roadFormationModel.revision !== roadFormationRevision) {
            if (roadFormationModel.revision !== roadFormationPendingRevision) {
                roadFormationPendingRevision = roadFormationModel.revision;
            } else {
                roadFormationRevision = roadFormationPendingRevision;
                // Heights moved: owe a rebuild, but spread it like the tile path
                // (the old mesh stays up until the new one is ready). This used
                // to force a synchronous whole-city rebuild every time roads
                // settled — the ~70 ms hook stall while driving.
                formationRebuildRequested = true;
            }
        }
        // A streamed road change advances the public revision before its next
        // formation generation has been built. sceneYAtLocal normally demands
        // current data, so starting a paint slice in that interval made the
        // first strip vertex synchronously build the entire road formation
        // inside the lane-marking hook (185-275 ms in clean-host traces).
        // Roads already own and queue that generation. Keep the old paint mesh
        // visible and pause this derived consumer until the atomic indexes are
        // published; the pending rebuild then samples exactly that generation.
        const roadFormationPending = roadFormationModel?.hasPendingBuild?.() === true;
        // One resumable build at a time: finish the in-flight slice before
        // starting another, so a trigger mid-build cannot restart it.
        if (activeBuild && !roadFormationPending) {
            stepRebuild(LANE_BUILD_FRAME_BUDGET_MS);
        } else if (!activeBuild && !roadFormationPending && formationRebuildRequested) {
            formationRebuildRequested = false;
            beginRebuild();
            stepRebuild(LANE_BUILD_FRAME_BUDGET_MS);
        } else if (!activeBuild && !roadFormationPending
            && group && shouldRunOnSettle(rebuildGate, tileRevision)) {
            beginRebuild();
            stepRebuild(LANE_BUILD_FRAME_BUDGET_MS);
        }
        if (tileSource) {
            const streamingFocus = pose?.surfaceStreamingFocus || local;
            const streamingHeadingDeg = finiteOrNull(streamingFocus?.headingDeg)
                ?? pose?.headingDeg;
            const surfacePreload = pose?.surfaceStreamingPreload;
            if (surfacePreload) {
                tileSource.ensurePinnedPoints(surfacePreload.points, {
                    signature: surfacePreload.signature,
                    priorityX: surfacePreload.priority?.x,
                    priorityZ: surfacePreload.priority?.z,
                    headingDeg: surfacePreload.priority?.headingDeg,
                });
            }
            tileSource.ensureAround(local.x, local.z);
            tileSource.ensureAhead(
                Number.isFinite(streamingFocus?.x) ? streamingFocus.x : local.x,
                Number.isFinite(streamingFocus?.z) ? streamingFocus.z : local.z,
                streamingHeadingDeg,
                {
                distanceM: LANE_AHEAD_PREFETCH_M,
                halfWidthM: LANE_AHEAD_HALF_WIDTH_M,
                },
            );
        }
    },
    endSession() {
        settleInitialLanePublication();
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        if (group) {
            disposeAggregateMesh();
            tileFeatures = createLaneMarkingTileRegistry();
            if (group.parent) group.parent.remove(group);
            group = null;
        }
        discardActiveBuild('lane-layer-ended');
        formationRebuildRequested = false;
        stripCache = createStripGeometryCache();
        lastCacheStats = null;
        cacheFormationRevision = -1;
        proposalMaskRevision = 0;
        solvedPathTopology = null;
        topologyCacheHits = 0;
        topologyCacheMisses = 0;
        lastInvalidationStats = null;
        worstInvalidationStats = null;
        if (dashMaterial) {
            unregisterShared(dashMaterial);
            dashMaterial.dispose();
            dashMaterial = null;
        }
        surfacePublications = null;
        if (dashTexture) {
            unregisterShared(dashTexture);
            dashTexture.dispose();
            dashTexture = null;
        }
        roadFormationRevision = -1;
        roadFormationPendingRevision = -1;
        renderedRoadRevision = -1;
        roadFormationModel = null;
        roadVerticalAlignmentModel = null;
        terrainReference = null;
    },
};
