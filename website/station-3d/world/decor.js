// Terrain-aware decorations around the cab position: OSM trees, OSM landuse /
// natural / leisure patches (greenery), gravel footpaths, benches, and
// pedestrian crossings.
//
// Each asset type is rendered as a single InstancedMesh or merged buffer so
// the whole layer costs one or two draw calls regardless of feature count.
// The three asset files are fetched once per session and the groups are
// rebuilt whenever the cab position has moved more than DECOR_REBUILD_M from
// where they were last centred.

import * as THREE from 'three';
import { createBenchParts } from '../models/objects/bench.js';
import { createPalmTreeParts } from '../models/objects/palm-tree.js';
import {
    clearAmbientBenchSeats,
    removeAmbientBenchSeat,
    replaceAmbientBenchSeats,
} from '../core/ambient-bench-seats.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull, geoToLocal, haversineMeters } from '../core/math.js';
import { getApiBase } from '../core/api.js';
import { disposeGroup, registerShared } from '../core/dispose.js';
import { scene, renderer, camera, getSidewalkTexture, SIDEWALK_UV_PER_M, getGravelTexture, GRAVEL_UV_PER_M } from '../scene/setup.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import {
    animateWaterMaterials,
    buildWaterBankGeometry,
    buildWaterShoreGeometry,
    createWaterBankMaterial,
    createWaterGroundCutoutMesh,
    createWaterMaterial,
    createWaterShoreMaterial,
    prepareWaterMaterialResourcesCooperatively,
    WATER_UV_PER_M,
} from './water-material.js';
import {
    buildTrackCorridorVolumes,
    ELEVATED_GUIDEWAY_DECK_THICKNESS_M,
    isPlannerElevatedSegment,
    isPointInsideCorridorFootprints,
    isPointInsideCorridorVolumes,
} from './track-corridors.js';
import { buildPlannerStationClearanceVolumes } from './planner-station-layout.js';
import { isPointInsidePlannerSurfaceCutout } from './planner-elevation.js';
import { buildingTileSourceForLocation, getLocation } from '../core/locations.js';
import {
    DETAILED_BUILDING_STREAM_OPTIONS,
    NEAR_ROAD_STREAM_OPTIONS,
} from '../core/tile-stream.js';
import { normalizeUrbanGroundConfig } from '../core/urban-ground.js';
import { decorSurfaceEdgingTypeIndex, decorSurfaceEdgingPolygonsSteps } from '../core/decor-surface-edging.js';
import { markInspectionLayer, hiddenInspectionLayerIds, subscribeInspectionLayerVisibility, releaseInspectionLayerObjects } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import { createDecorGroundPaintOwnerSteps, decorGroundPaintEligible, DECOR_LANDUSE_TYPES } from '../core/decor-ground-paint.js';
import { EMPTY_GROUND_PAINT_OWNERS, groundPaintOwnerReplacementsSteps } from '../core/ground-paint-owner-set.js';
import { roadGroundPaintStyle, getRenderedRoadSurfaceRevision, renderedRoadTrianglesInBounds } from './roads.js';
import { groundPaintReceiverAcceptsClaim } from '../core/ground-paint-receiver-claim.js';
import { projectReceiverDetailSteps } from '../core/receiver-detail-projection.js';
import { createDecorAssetReadiness } from '../core/decor-asset-readiness.js';
import {
    SESSION_CAPABILITY,
    sessionCapabilityEnabled,
} from '../core/session-capabilities.js';
import { surfacePublicationClaimCoverage } from '../core/surface-publication-registry.js';
import {
    buildLimestoneOutcropPieces,
    buildNaturalScatterCandidates,
    naturalGroundMaterialStyle,
} from '../core/natural-scatter.js';
import {
    GROUND_SURFACE_LEVELS,
    WATER_LEVELS,
} from './ground-surface-levels.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { isPhotorealCorridorGround } from './photoreal.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';
import { buildChainsFromSegments, densifyChain, smoothChain, computeRibbonStations } from './footpath-geometry.js';
import { refineTriangulatedSurfaceSteps } from '../core/road-formation.js';
import {
    evidencePlacementBaseSceneY,
    evidencePlacementSceneY,
} from '../core/terrain-placement.js';
import {
    clipRingToWindow,
    sampleSpacingForBudget,
    surfaceRefinementEdgeForArea,
} from '../core/render-budgets.js';
import { frameChunkWorkShouldPauseForMovement } from '../core/frame-chunk-queue.js';
import { registerBackgroundActivityReader } from '../core/background-activity.js';
import { createTileFeatureRegistry } from '../core/tile-feature-registry.js';
import { parkingMayOverlapRoadFormation } from '../core/parking-formation-overlap.js';
import { reportOutOfLoopWork } from '../core/out-of-loop-work.js';
import { createStaticBatchedMesh } from '../core/static-batched-mesh.js';
import {
    normalizeTreeType,
    TREE_TYPE_PALM,
    treeShapeDimensions,
} from '../core/tree-shape.js';
import {
    trafficSignalBrakeFactor,
    trafficSignalPhase,
} from '../core/traffic-signal-cycle.js';
import {
    findTrafficSignalPolePlacement,
    trafficSignalLampFacePositions,
} from '../core/traffic-signal-placement.js';
import {
    pointInLocalRing,
    runwaySpawnCandidates,
} from '../core/gta-special-vehicle-spawns.js';
import {
    computeFlatNormalsRange,
    prepareFlatSurfaceBuffersSteps,
    normalizeNormals,
    triangleCount,
} from '../core/flat-normals.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import {
    isMappedSeaReady,
    isPointInMappedSea,
    subscribeMappedSeaChanges,
} from './water.js';
import { mappedSeaCoversDecorWaterPolygon } from '../core/decor-water-ownership.js';

const DECOR_REBUILD_M = 900;
const DECOR_INDEX_CELL_DEG = 0.01;
const DECOR_BUILD_BUDGET_MS = 2;
// Triangles per normal slice. Sized so one slice is well under the 2 ms budget
// (the budget then decides whether to actually yield), while staying big enough
// that the per-slice call overhead stays negligible.
const DECOR_NORMAL_CHUNK_TRIS = 2000;
// TypedArray#set is normally a cheap memcpy, but a single clipped forest can
// still carry a multi-megabyte surface. Copy in bounded pieces so one unusually
// dense polygon cannot turn the final merge into a 200+ ms async-builder step.
const DECOR_MERGE_COPY_CHUNK_VALUES = 30_000;
// Terrain sampling, unlike the arithmetic normal pass, can be expensive at an
// individual vertex. Shore/bank rings can contain thousands of them, so make
// their drape interruptible well below one render-frame's worth of samples.
const DECOR_WATER_DRAPE_CHUNK_VERTICES = 32;
// A marking vertex can cross into a newly published engineered formation and
// pay a non-trivial indexed height query. One authoritative sample per visit
// is the only strict upper bound; the async builder can consume several cheap
// visits inside its 2 ms slice when the terrain is uncomplicated.
const DECOR_MARKING_DRAPE_CHUNK_VERTICES = 1;
// ShapeGeometry itself is one bounded earcut operation. Everything around it
// (source extraction, shared-edge refinement, and terrain drape) is split so a
// dense clipped polygon cannot hide a whole 100+ ms build under one
// `greenery:surface` label.
const DECOR_SURFACE_SOURCE_CHUNK_ITEMS = 64;
const DECOR_SURFACE_REFINEMENT_CHUNK_TRIANGLES = 64;
// How often the 2 ms budget is actually CONSULTED. This used to be 32, which
// meant the budget bounded nothing: a step is one prop (a tree costs a terrain
// height sample plus its trunk/crown maths), so the real slice was 32 steps of
// whatever those cost — tens of milliseconds on a dense tile, i.e. a dropped
// frame every time decor rebuilt, which is once per 900 m of travel.
// The clock read is ~50 ns against a per-prop cost thousands of times that, and
// each step already awaits a microtask through maybeYieldBuild, so checking
// every step is free in practice and is the only value that makes the slice
// bounded by the budget rather than by the step count.
const DECOR_BUILD_YIELD_EVERY = 1;
// The road layer prefetches a long corridor in the viewing direction. A turn
// can therefore fetch/evict dozens of road tiles without the camera moving.
// Those tiles only affect generated parking access/paint; wait for the fetch
// burst and the turn itself to settle before rebuilding decor from them.
const DECOR_ROAD_REFRESH_SETTLE_MS = 250;
const DECOR_ROAD_TURN_IDLE_MS = 300;
const NATURAL_SCATTER_CELL_M = 18;
const NATURAL_SCATTER_DENSITY = 0.30;
const NATURAL_SCATTER_SEED = 0x5a117;
const NATURAL_ROAD_CLEARANCE_M = 4.5;
const NATURAL_BUILDING_CLEARANCE_M = 12;
const NATURAL_TRACK_CLEARANCE_M = 4;
const NATURAL_OUTCROP_RADIUS_M = 4;
// 1500 → 1100: fog is opaque at 1200 m, so greenery/parking surfaces built
// past ~1100 m were invisible yet still paid the full per-vertex terrain/road
// sampling cost on every rebuild. Shrinking to the fog distance cuts the polygon
// count (and thus the whole greenery build) by ~45% with no visible change.
// Exported: nothing found beyond this radius exists yet, so a consumer's own
// search radius (aircraft on runways) must not pretend to see further.
export const GREENERY_RADIUS_M = 1100;
// Was 20 000 — absurdly fine for a draped GRASS surface, and every vertex costs
// a terrain evidence sample (evidencePlacementBaseSceneY → pointInRing)
// plus a centroid point-in-polygon test. Profiling near heavy greenery showed
// those per-vertex samples dominating terrain-mode; grass is near-planar so a
// far coarser mesh is visually indistinguishable.
// Terrain worlds refine against real relief, where a small cap starves a big
// forest polygon into unrefined ear-clip giants that drape across valleys as
// floating slabs (Medvednica ships one 9 km² polygon with 63 vertices).
// Polygons are clipped to the greenery window first, so this budget only ever
// pays for VISIBLE area — and triangles are cheap here (Zagreb renders are
// draw-call-bound), while slabs are not. Flat worlds skip refinement entirely.
const MAX_GREENERY_SURFACE_TRIANGLES_PER_POLYGON_TERRAIN = 12_000;
const GREENERY_SURFACE_MAX_EDGE_TERRAIN_M = 32;
// Clip window reaches one max edge beyond the fetch radius so the clipped
// boundary stays inside the opaque fog and never pops on screen.
const GREENERY_CLIP_MARGIN_M = 64;
const FOREST_TREE_INSTANCE_BUDGET = 6_000;
// One city-scale InstancedMesh has a city-scale bounding sphere, so the whole
// forest renders even when only one corner enters the camera. Spatial batches
// preserve instancing while giving Three.js useful frustum/shadow bounds.
const FOREST_TREE_CHUNK_M = 240;
const FLOWERBED_PLANT_INSTANCE_BUDGET = 8_000;
const GREEN_SURFACE_TYPES = new Set(['grass', 'meadow', 'park', 'pitch', 'cemetery']);
const NATURAL_WATER_SURFACE_TYPES = new Set([
    'water', 'sea', 'lake', 'pond', 'reservoir', 'river', 'riverbank', 'stream',
]);
const DECOR_SURFACE_SHARED = {
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
};
function publishedDecorSurfaceClaim(surfaceClass, ownerId, options = {}) {
    return compileSurfaceClaim({
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: surfaceClass === SURFACE_CLASS.WATER ? null : 'ground',
        ownerId,
        sourceId: 'world/decor.js',
        supportReady: options.supportReady === true,
        cutsBackstop: options.cutsBackstop === true,
        paintsColor: options.paintsColor !== false,
    });
}

function authorizeDecorSurfaceMaterial(material, claim) {
    applySurfaceStencil(material, claim);
    applyGroundOwnership(material, claim);
    applyPlannerSurfaceCutout(material, claim);
    return material;
}
const DECOR_WATER_RENDER_ORDER = SURFACE_RENDER_ORDER.WATER_SURFACE;
const DECOR_WATER_BANK_RENDER_ORDER = SURFACE_RENDER_ORDER.WATER_BANK;
const DECOR_SHORE_RENDER_ORDER = SURFACE_RENDER_ORDER.WATER_SHORE;
const DECOR_CONSTRUCTION_RENDER_ORDER = SURFACE_RENDER_ORDER.CONSTRUCTION;

// Procedural grass texture. 256² canvas tiles every GRASS_TILE_M metres on
// the ground. Three layers of variation give it a "natural" look without
// shipping any image bytes:
//   • per-pixel RGB jitter on a dark-green base (high-frequency grain)
//   • per-cell low-frequency tint shift so each ~8 cm patch has its own
//     overall hue (large-scale variation reads as different blade clumps)
//   • scattered lighter blade-tip specks, darker shadow specks, and
//     occasional brown dry-patch tufts for hue richness
const GRASS_TILE_M = 3.0;
export const GRASS_UV_PER_M = 1 / GRASS_TILE_M;
let _grassTexture = null;
const FLOWERBED_TILE_M = 1.7;
const FLOWERBED_UV_PER_M = 1 / FLOWERBED_TILE_M;
let _flowerbedTexture = null;
let _hedgeTexture = null;
const FOOTPATH_TILE_M = 1.8;
const FOOTPATH_UV_PER_M = 1 / FOOTPATH_TILE_M;
let _footpathTexture = null;
const PARKING_TILE_M = 5.4;
const PARKING_UV_PER_M = 1 / PARKING_TILE_M;
let _parkingTexture = null;
// Parking is roadbed in its own right. Keep it above every ordinary streamed
// road polygon (up to pedestrian paving at 0.043), but below the dedicated
// tram bed at 0.075 so rails.js still owns the complete track corridor.
const PARKING_SURFACE_Y = GROUND_SURFACE_LEVELS.parking;
const PARKING_MARKING_Y = GROUND_SURFACE_LEVELS.parkingMarking;
const CONSTRUCTION_SURFACE_Y = GROUND_SURFACE_LEVELS.construction;
const PARKING_MARKING_WIDTH_M = 0.12;
const PARKING_EDGE_CLEARANCE_M = 0.55;
const PARKING_PERP_STALL_WIDTH_M = 2.6;
const PARKING_PERP_STALL_DEPTH_M = 5.2;
const PARKING_PARALLEL_STALL_LENGTH_M = 6.4;
const PARKING_PARALLEL_STALL_DEPTH_M = 2.6;
const PARKING_STALL_SAMPLE_MARGIN_M = 0.22;
const PARKING_ACCESS_SAMPLE_M = 1.2;
// Parking layouts are an urban-lot / roadside feature. Above this footprint a
// greenery polygon is a park or forest with no stalls — and its huge bounding
// box makes getParkingRoadEdgeCandidates point-test every nearby road edge
// against many samples (O(polygon-edges × roads × vertices)). Profiling near a
// large forest showed this as ~60% of ALL CPU (pointInRing), running async so it
// hid in the frame "gap". Skipping oversized polygons removes that blow-up.
const MAX_PARKING_POLYGON_AREA_M2 = 20000;   // 2 ha
const FOREST_TREE_SPACING_M = 9.5;
const FLOWERBED_PLANT_SPACING_M = 1.75;
const HEDGE_HEIGHT_M = 0.55;
const HEDGE_WIDTH_M = 0.42;
const HEDGE_STRIP_WIDTH_M = 0.72;
const HEDGE_STRIP_HEIGHT_M = 0.03;
const HEDGE_SEGMENT_OVERLAP_M = 0.08;
const HEDGE_STRIP_Y = 0.0105;
const HEDGE_MODULE_TARGET_LENGTH_M = 1.18;
const HEDGE_MODULE_GAP_M = 0.08;
// Natural lakes, rivers, and streams share a visibly recessed inland level.
// A stencil silhouette opens the catch-all ground, while mapped roads remain
// visible across the water as bridge-like crossings.
const WATER_Y = WATER_LEVELS.inland;
const TERRAIN_WATER_Y = WATER_LEVELS.naturalBankTop + 0.002;
// Fountain polygons are mapped basin water, not lakes cut into the terrain.
// Their exact surface sits just above paving, enclosed by a shallow stone rim.
const FOUNTAIN_WATER_Y = 0.075;
const FOUNTAIN_RIM_Y = 0.18;
const FOUNTAIN_WALL_BASE_Y = 0.018;
const FOUNTAIN_RIM_WIDTH_M = 0.34;
const FOOTPATH_Y = 0.0138;

let terrainReference = null;
let renderedGroundYAt = null;
let terrainChangeSubscription = null;
let terrainRefreshPending = false;
let terrainAwaitingDecorCenter = null;

// A visible fallback datum keeps the world opaque while a moving DTM window
// loads, but it is not placement evidence. Decor builders are cooperative and
// can span many frames, so bind every generation to both genuine source evidence
// at its request centre and the exact terrain revision that supplied it. This
// point gates data availability, not placement: its terrain receiver may be
// intentionally removed under a road, rail or structure. Each actual placement
// still queries its own physical receiver. A revision that
// lands during the build invalidates the detached result before publication.
function decorTerrainGenerationToken(centerLat, centerLon) {
    if (!terrainReference) {
        return {
            reference: null,
            revision: null,
            roadRevision: groundPaint ? getRenderedRoadSurfaceRevision() : null,
            centerLat,
            centerLon,
        };
    }
    if (typeof terrainReference.sourceEvidenceSceneYAtLocal !== 'function') return null;
    const local = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const evidenceY = finiteOrNull(
        terrainReference.sourceEvidenceSceneYAtLocal(local.x, local.z),
    );
    if (evidenceY === null) return null;
    return {
        reference: terrainReference,
        revision: terrainReference.revision,
        roadRevision: groundPaint ? getRenderedRoadSurfaceRevision() : null,
        centerLat,
        centerLon,
    };
}

function decorTerrainGenerationIsCurrent(token) {
    if (!token) return false;
    if (token.roadRevision !== (groundPaint ? getRenderedRoadSurfaceRevision() : null)) return false;
    if (token.reference === null) return terrainReference === null;
    if (terrainReference !== token.reference
        || terrainReference.revision !== token.revision) return false;
    return decorTerrainGenerationToken(token.centerLat, token.centerLon) !== null;
}

function awaitDecorTerrain(centerLat, centerLon) {
    terrainAwaitingDecorCenter = { lat: centerLat, lon: centerLon };
}

function terrainBaseY(localX, localZ, preferRoadSurface = false) {
    const placementY = evidencePlacementBaseSceneY(
        terrainReference,
        localX,
        localZ,
        { preferRoadSurface },
    );
    if (placementY === null) return null;
    if (!preferRoadSurface || typeof renderedGroundYAt !== 'function') return placementY;
    return finiteOrNull(renderedGroundYAt(localX, localZ, placementY)) ?? placementY;
}

function terrainPlacedY(localX, localZ, offsetM, preferRoadSurface = false) {
    return evidencePlacementSceneY(
        terrainReference,
        localX,
        localZ,
        offsetM,
        { preferRoadSurface },
    );
}

const PARKING_RECEIVER_QUERY = Object.freeze({ acceptPart: part => (
    groundPaintReceiverAcceptsClaim(groundPaint?.receiver, part.surfaceClaim)
) });

function* parkingReceiverTriangles(bounds) {
    if (terrainReference) {
        yield* terrainReference.receiverTrianglesInBounds(bounds);
    } else {
        // Explicit flat-world ground is itself a physical receiver at Y=0.
        // A missing streamed tile never enters this branch.
        const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = bounds;
        const positions = new Float64Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]);
        yield { positions, a: 0, b: 3, c: 6 }; yield { positions, a: 0, b: 6, c: 9 };
    }
    yield* renderedRoadTrianglesInBounds(bounds, PARKING_RECEIVER_QUERY);
}

function decorSurfaceYAt(type, localX, localZ, preferParkingRoadSurface = true) {
    // Flexible inland water follows the active DGU surface per vertex. Keep
    // only its small semantic recess below the surrounding terrain; pinning
    // every river to one scene Y creates enormous floating sheets as the
    // route moves away from the session anchor.
    if (type === 'water') {
        return terrainReference
            ? terrainPlacedY(localX, localZ, TERRAIN_WATER_Y)
            : surfaceY(type);
    }
    if (type === 'fountain') {
        return terrainPlacedY(localX, localZ, FOUNTAIN_WATER_Y);
    }
    return terrainPlacedY(
        localX,
        localZ,
        surfaceY(type),
        type === 'parking' && preferParkingRoadSurface,
    );
}

async function drapeWaterEdgeGeometry(
    geometry,
    yieldState,
    shouldCancel,
    label,
) {
    if (!terrainReference || !geometry) return geometry;
    const positions = geometry.getAttribute('position');
    if (!positions) return geometry;
    for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index);
        const z = positions.getZ(index);
        const authoredY = positions.getY(index);
        const placedY = terrainPlacedY(x, z, authoredY);
        if (placedY === null) {
            geometry.dispose();
            return null;
        }
        positions.setY(index, placedY);
        if ((index + 1) % DECOR_WATER_DRAPE_CHUNK_VERTICES === 0
            && !(await maybeYieldBuild(yieldState, shouldCancel, label))) {
            geometry.dispose();
            return null;
        }
    }
    positions.needsUpdate = true;
    // The edge builders emit non-indexed triangles. Recompute their normals in
    // the same bounded form as merged greenery instead of one uninterruptible
    // computeVertexNormals call (and skip the pre-drape normal pass entirely).
    const rawPositions = positions.array;
    const normals = new Float32Array(rawPositions.length);
    const totalTriangles = triangleCount(rawPositions);
    for (let triangle = 0; triangle < totalTriangles; triangle += DECOR_NORMAL_CHUNK_TRIS) {
        computeFlatNormalsRange(
            rawPositions,
            normals,
            triangle,
            Math.min(totalTriangles, triangle + DECOR_NORMAL_CHUNK_TRIS),
        );
        if (!(await maybeYieldBuild(yieldState, shouldCancel, `${label}:normals`))) {
            geometry.dispose();
            return null;
        }
    }
    normalizeNormals(normals);
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    return geometry;
}

function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

function nextAnimationFrame() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    return Promise.resolve();
}

function resetBuildYieldState(yieldState) {
    const now = nowMs();
    yieldState.frameStartMs = now;
    yieldState.lastStepMs = now;
    yieldState.cpuSliceMs = 0;
}

function createBuildYieldState() {
    const state = {
        frameStartMs: 0,
        steps: 0,
        lastStepMs: 0,
        cpuSliceMs: 0,
    };
    resetBuildYieldState(state);
    return state;
}

// `await` always resumes in a later microtask, even when an async function
// returns immediately. Reset the step clock in the microtask immediately
// before the caller's continuation, so unrelated queued work is not charged
// to the caller's next decor step. The accumulated CPU slice remains intact.
function resetBuildStepClockBeforeContinuation(yieldState) {
    const reset = () => {
        yieldState.lastStepMs = nowMs();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(reset);
    else Promise.resolve().then(reset);
}

// Some decor is placed on engineered road height. A road tile advances the
// formation revision before its replacement indexes are atomically published;
// querying in that window makes an async decor builder synchronously build the
// whole formation inside one innocent-looking placement step. Roads own that
// generation already. Keep the previous decor group visible and wait without
// burning CPU until the authoritative generation is ready.
async function waitForPublishedRoadFormation(
    formation,
    yieldState,
    shouldCancel,
) {
    while (formation?.hasPendingBuild?.() === true) {
        if (shouldCancel()) return false;
        await nextAnimationFrame();
        resetBuildYieldState(yieldState);
    }
    return !shouldCancel();
}

// Worst SINGLE step per label. A slice longer than the budget can only mean one
// step overran it, but a slice is `steps since the last yield`, so it cannot say
// whether that was one huge step or a run of small ones — and those have
// opposite fixes (subdivide the step vs. yield more often).
const decorStepMax = new Map();
if (typeof window !== 'undefined') {
    window.__decorStepMax = () => Object.fromEntries(
        [...decorStepMax.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]),
    );
}

// The budget is consulted every step (DECOR_BUILD_YIELD_EVERY = 1), so a slice
// longer than the budget can only mean ONE step overran it — the budget decides
// whether to yield BETWEEN steps and cannot interrupt one. Slices peaked at
// 138 ms against a 2 ms budget, so somewhere a single step is doing ~70× its
// share, and `decor:build` alone cannot say which of the eleven builders it is.
// The label is the cheapest thing that can.
async function maybeYieldBuild(yieldState, shouldCancel, label = 'build', forceFrame = false) {
    yieldState.steps += 1;
    const stepEndedMs = nowMs();
    const stepMs = stepEndedMs - yieldState.lastStepMs;
    if (stepMs > (decorStepMax.get(label) || 0)) decorStepMax.set(label, stepMs);
    yieldState.cpuSliceMs += stepMs;
    yieldState.lastStepMs = stepEndedMs;
    // Vegetation/landuse construction has its own async builder rather than a
    // frame-chunk queue. Keep it under the same movement-first contract: while
    // flying, do not resume even a nominally budgeted greenery slice.
    if (frameChunkWorkShouldPauseForMovement()) {
        if (yieldState.cpuSliceMs >= DECOR_BUILD_BUDGET_MS) {
            reportOutOfLoopWork(`decor:${label}`, yieldState.cpuSliceMs);
        }
        while (frameChunkWorkShouldPauseForMovement()) {
            if (shouldCancel()) return false;
            await nextAnimationFrame();
        }
        resetBuildYieldState(yieldState);
        return !shouldCancel();
    }
    if (!forceFrame && (yieldState.steps % DECOR_BUILD_YIELD_EVERY) !== 0) {
        resetBuildStepClockBeforeContinuation(yieldState);
        return !shouldCancel();
    }
    if (!forceFrame && yieldState.cpuSliceMs < DECOR_BUILD_BUDGET_MS) {
        resetBuildStepClockBeforeContinuation(yieldState);
        return !shouldCancel();
    }
    // These slices resume in the builder's own animation frame, so they are
    // outside the render loop exactly like a queue flush is. Report measured
    // CPU only; wall time across Promise continuations belongs to whichever
    // queued task actually consumed it.
    reportOutOfLoopWork(`decor:${label}`, yieldState.cpuSliceMs);
    await nextAnimationFrame();
    resetBuildYieldState(yieldState);
    return !shouldCancel();
}

function indexCell(value) {
    return Math.floor(value / DECOR_INDEX_CELL_DEG);
}

function addIndexBucket(buckets, latCell, lonCell, entry) {
    const key = `${latCell}:${lonCell}`;
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
    }
    bucket.push(entry);
}

function createSpatialIndex(entries) {
    const buckets = new Map();
    for (const entry of entries) {
        const latMinCell = indexCell(entry.minLat);
        const latMaxCell = indexCell(entry.maxLat);
        const lonMinCell = indexCell(entry.minLon);
        const lonMaxCell = indexCell(entry.maxLon);
        for (let latCell = latMinCell; latCell <= latMaxCell; latCell++) {
            for (let lonCell = lonMinCell; lonCell <= lonMaxCell; lonCell++) {
                addIndexBucket(buckets, latCell, lonCell, entry);
            }
        }
    }
    return { entries, buckets };
}

function boundsIntersect(a, b) {
    return !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);
}

function querySpatialIndex(index, bounds) {
    if (!index) return [];
    const results = [];
    const seen = new Set();
    const latMinCell = indexCell(bounds.minLat);
    const latMaxCell = indexCell(bounds.maxLat);
    const lonMinCell = indexCell(bounds.minLon);
    const lonMaxCell = indexCell(bounds.maxLon);
    for (let latCell = latMinCell; latCell <= latMaxCell; latCell++) {
        for (let lonCell = lonMinCell; lonCell <= lonMaxCell; lonCell++) {
            const bucket = index.buckets.get(`${latCell}:${lonCell}`);
            if (!bucket) continue;
            for (const entry of bucket) {
                if (seen.has(entry)) continue;
                seen.add(entry);
                if (boundsIntersect(entry, bounds)) results.push(entry);
            }
        }
    }
    return results;
}

// Parking surface polygons for the curbs layer: street-side parking is part
// of the roadbed in Zagreb, so curbs must wrap around parking areas rather
// than run between them and the road. Shares the cached greenery asset with
// the surface renderer — no extra fetch.
// centerLat/centerLon are required on the apiDecor path and ignored on the baked one.
// The caller must supply them: curbs.js begins BEFORE decor.js in cab.js's layer
// order, so this module's own anchor is still 0,0 when curbs asks.
export function getDecorParkingIndex(centerLat, centerLon, signal, requestScheduler = null) {
    // Always the API: the baked greenery file is gone.
    return fetchDecorAsset(
        'greenery',
        centerLat,
        centerLon,
        prepareGreeneryAsset,
        signal,
        requestScheduler,
    );
}

export function queryDecorParkingEntries(index, bounds) {
    return querySpatialIndex(index, bounds).filter((entry) => entry.type === 'parking');
}

// Green surfaces adjoining a street curb need to continue across the curb's
// synthetic back-ramp instead of being hidden under a metre of grey paving.
// Curbs shares the already-cached greenery index, so this adds no fetch.
export function queryDecorGreenEntries(index, bounds) {
    return querySpatialIndex(index, bounds).filter((entry) =>
        GREEN_SURFACE_TYPES.has(entry.type) || entry.type === 'forest');
}

function radiusBounds(centerLat, centerLon, radiusM) {
    const cosLat = Math.max(0.00001, Math.cos(centerLat * DEG_TO_RAD));
    const dLat = radiusM / EARTH_RADIUS_M / DEG_TO_RAD;
    const dLon = radiusM / (EARTH_RADIUS_M * cosLat) / DEG_TO_RAD;
    return {
        minLat: centerLat - dLat,
        maxLat: centerLat + dLat,
        minLon: centerLon - dLon,
        maxLon: centerLon + dLon,
    };
}


function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export function getGrassTexture() {
    if (_grassTexture) return _grassTexture;
    const SIZE = 256;
    const CELL = 8;            // low-freq cell size in pixels
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;

    // Dark-green base with per-pixel + per-cell jitter. The cell tint is
    // applied first so each block has a coherent overall shade; per-pixel
    // noise then breaks the cell edges so they don't read as a grid.
    for (let cy = 0; cy < SIZE; cy += CELL) {
        for (let cx = 0; cx < SIZE; cx += CELL) {
            const tintR = Math.floor((Math.random() - 0.5) * 18);
            const tintG = Math.floor((Math.random() - 0.5) * 24);
            const tintB = Math.floor((Math.random() - 0.5) * 14);
            for (let dy = 0; dy < CELL; dy++) {
                for (let dx = 0; dx < CELL; dx++) {
                    const px = cx + dx, py = cy + dy;
                    const i = (py * SIZE + px) * 4;
                    const noiseR = Math.floor((Math.random() - 0.5) * 16);
                    const noiseG = Math.floor((Math.random() - 0.5) * 22);
                    const noiseB = Math.floor((Math.random() - 0.5) * 12);
                    data[i + 0] = clampByte(34 + tintR + noiseR);
                    data[i + 1] = clampByte(72 + tintG + noiseG);
                    data[i + 2] = clampByte(30 + tintB + noiseB);
                    data[i + 3] = 255;
                }
            }
        }
    }
    // ~4% lighter blade-tip specks (sun-touched grass).
    let count = Math.floor(SIZE * SIZE * 0.04);
    for (let n = 0; n < count; n++) {
        const px = (Math.random() * SIZE) | 0;
        const py = (Math.random() * SIZE) | 0;
        const i = (py * SIZE + px) * 4;
        const lift = 14 + Math.floor(Math.random() * 28);
        data[i + 0] = clampByte(data[i + 0] + lift - 10);
        data[i + 1] = clampByte(data[i + 1] + lift);
        data[i + 2] = clampByte(data[i + 2] + lift - 14);
    }
    // ~2.5% darker specks (shadows between blades).
    count = Math.floor(SIZE * SIZE * 0.025);
    for (let n = 0; n < count; n++) {
        const px = (Math.random() * SIZE) | 0;
        const py = (Math.random() * SIZE) | 0;
        const i = (py * SIZE + px) * 4;
        data[i + 0] = clampByte(data[i + 0] - 14);
        data[i + 1] = clampByte(data[i + 1] - 18);
        data[i + 2] = clampByte(data[i + 2] - 10);
    }
    // ~0.5% brown dry-patch specks for hue variance.
    count = Math.floor(SIZE * SIZE * 0.005);
    for (let n = 0; n < count; n++) {
        const px = (Math.random() * SIZE) | 0;
        const py = (Math.random() * SIZE) | 0;
        const i = (py * SIZE + px) * 4;
        data[i + 0] = 76 + Math.floor(Math.random() * 24);
        data[i + 1] = 56 + Math.floor(Math.random() * 18);
        data[i + 2] = 28 + Math.floor(Math.random() * 10);
    }
    ctx.putImageData(img, 0, 0);

    _grassTexture = new THREE.CanvasTexture(canvas);
    _grassTexture.wrapS = THREE.RepeatWrapping;
    _grassTexture.wrapT = THREE.RepeatWrapping;
    _grassTexture.colorSpace = THREE.SRGBColorSpace;
    _grassTexture.anisotropy = 4;
    _grassTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _grassTexture.magFilter = THREE.LinearFilter;
    _grassTexture.generateMipmaps = true;
    registerShared(_grassTexture);
    return _grassTexture;
}

function getFlowerbedTexture() {
    if (_flowerbedTexture) return _flowerbedTexture;
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    for (let i = 0; i < SIZE * SIZE; i++) {
        const soil = 74 + Math.floor((Math.random() - 0.5) * 20);
        data[i * 4 + 0] = clampByte(soil + 28);
        data[i * 4 + 1] = clampByte(soil);
        data[i * 4 + 2] = clampByte(soil - 18);
        data[i * 4 + 3] = 255;
    }
    const blooms = [
        [0xf1, 0x6c, 0xb2],
        [0xff, 0xd1, 0x66],
        [0xff, 0x8e, 0x4d],
        [0xc7, 0xa7, 0xff],
        [0xff, 0xf1, 0xf4],
    ];
    const bloomCount = Math.floor(SIZE * SIZE * 0.035);
    for (let n = 0; n < bloomCount; n++) {
        const px = (Math.random() * SIZE) | 0;
        const py = (Math.random() * SIZE) | 0;
        const [r, g, b] = blooms[(Math.random() * blooms.length) | 0];
        const radius = 1 + ((Math.random() * 2) | 0);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx * dx + dy * dy > radius * radius + 0.2) continue;
                const x = px + dx;
                const y = py + dy;
                if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
                const i = (y * SIZE + x) * 4;
                data[i + 0] = r;
                data[i + 1] = g;
                data[i + 2] = b;
            }
        }
    }
    ctx.putImageData(img, 0, 0);
    _flowerbedTexture = new THREE.CanvasTexture(canvas);
    _flowerbedTexture.wrapS = THREE.RepeatWrapping;
    _flowerbedTexture.wrapT = THREE.RepeatWrapping;
    _flowerbedTexture.colorSpace = THREE.SRGBColorSpace;
    _flowerbedTexture.anisotropy = 4;
    _flowerbedTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _flowerbedTexture.magFilter = THREE.LinearFilter;
    _flowerbedTexture.generateMipmaps = true;
    registerShared(_flowerbedTexture);
    return _flowerbedTexture;
}

function getHedgeTexture() {
    if (_hedgeTexture) return _hedgeTexture;
    const SIZE = 256;
    const CELL = 16;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;

    for (let cy = 0; cy < SIZE; cy += CELL) {
        for (let cx = 0; cx < SIZE; cx += CELL) {
            const tint = Math.floor((Math.random() - 0.5) * 20);
            for (let dy = 0; dy < CELL; dy++) {
                for (let dx = 0; dx < CELL; dx++) {
                    const px = cx + dx;
                    const py = cy + dy;
                    const i = (py * SIZE + px) * 4;
                    const noise = Math.floor((Math.random() - 0.5) * 12);
                    const edgeDarken = ((dx === 0 || dy === 0) ? -18 : 0) + ((dx === CELL - 1 || dy === CELL - 1) ? -14 : 0);
                    data[i + 0] = clampByte(132 + tint * 0.55 + noise + edgeDarken);
                    data[i + 1] = clampByte(170 + tint + noise * 1.2 + edgeDarken);
                    data[i + 2] = clampByte(118 + tint * 0.45 + noise + edgeDarken);
                    data[i + 3] = 255;
                }
            }
        }
    }
    const topLiftRows = Math.floor(SIZE * 0.18);
    for (let y = 0; y < topLiftRows; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const lift = Math.floor(10 + (1 - y / Math.max(1, topLiftRows - 1)) * 12);
            data[i + 0] = clampByte(data[i + 0] + lift - 6);
            data[i + 1] = clampByte(data[i + 1] + lift);
            data[i + 2] = clampByte(data[i + 2] + lift - 5);
        }
    }
    const speckCount = Math.floor(SIZE * SIZE * 0.035);
    for (let n = 0; n < speckCount; n++) {
        const px = (Math.random() * SIZE) | 0;
        const py = (Math.random() * SIZE) | 0;
        const i = (py * SIZE + px) * 4;
        const delta = Math.random() < 0.55 ? 12 : -10;
        data[i + 0] = clampByte(data[i + 0] + delta * 0.4);
        data[i + 1] = clampByte(data[i + 1] + delta);
        data[i + 2] = clampByte(data[i + 2] + delta * 0.45);
    }
    ctx.putImageData(img, 0, 0);

    _hedgeTexture = new THREE.CanvasTexture(canvas);
    _hedgeTexture.wrapS = THREE.RepeatWrapping;
    _hedgeTexture.wrapT = THREE.RepeatWrapping;
    _hedgeTexture.colorSpace = THREE.SRGBColorSpace;
    _hedgeTexture.anisotropy = 4;
    _hedgeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _hedgeTexture.magFilter = THREE.LinearFilter;
    _hedgeTexture.generateMipmaps = true;
    registerShared(_hedgeTexture);
    return _hedgeTexture;
}

function createInstancedMesh(geometry, material, count) {
    const InstancedMesh = typeof window !== 'undefined' && window.__Station3DInstancedMesh
        ? window.__Station3DInstancedMesh
        : THREE.InstancedMesh;
    return new InstancedMesh(geometry, material, count);
}

function getFootpathTexture() {
    if (_footpathTexture) return _footpathTexture;
    const SIZE = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    // Macadam, not concrete: darker warm grey-brown base with strong grain.
    for (let i = 0; i < SIZE * SIZE; i++) {
        const base = 128 + Math.floor((Math.random() - 0.5) * 38);
        data[i * 4 + 0] = clampByte(base + 10);
        data[i * 4 + 1] = clampByte(base + 4);
        data[i * 4 + 2] = clampByte(base - 10);
        data[i * 4 + 3] = 255;
    }
    const pebbleCount = Math.floor(SIZE * SIZE * 0.09);
    for (let n = 0; n < pebbleCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const delta = Math.random() < 0.5
            ? 20 + Math.floor(Math.random() * 22)
            : -(16 + Math.floor(Math.random() * 20));
        data[i + 0] = clampByte(data[i + 0] + delta);
        data[i + 1] = clampByte(data[i + 1] + delta);
        data[i + 2] = clampByte(data[i + 2] + delta * 0.85);
    }
    ctx.putImageData(img, 0, 0);
    // Low-frequency dirt: soft brownish blotches so long stretches don't read
    // as one uniform sheet (wear patches, damp spots, mud tracked in).
    const blotches = 42;
    for (let n = 0; n < blotches; n++) {
        const bx = Math.random() * SIZE;
        const by = Math.random() * SIZE;
        const radius = 12 + Math.random() * 34;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
        const dark = Math.random() < 0.65;
        const tone = dark ? 'rgba(96, 84, 66,' : 'rgba(196, 188, 172,';
        g.addColorStop(0, `${tone} ${0.05 + Math.random() * 0.08})`);
        g.addColorStop(1, `${tone} 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(bx - radius, by - radius, radius * 2, radius * 2);
    }
    _footpathTexture = new THREE.CanvasTexture(canvas);
    _footpathTexture.wrapS = THREE.RepeatWrapping;
    _footpathTexture.wrapT = THREE.RepeatWrapping;
    _footpathTexture.colorSpace = THREE.SRGBColorSpace;
    _footpathTexture.anisotropy = 4;
    _footpathTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _footpathTexture.magFilter = THREE.LinearFilter;
    _footpathTexture.generateMipmaps = true;
    registerShared(_footpathTexture);
    return _footpathTexture;
}

function getParkingTexture() {
    if (_parkingTexture) return _parkingTexture;
    const SIZE = 512;
    const CELL = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;

    for (let cy = 0; cy < SIZE; cy += CELL) {
        for (let cx = 0; cx < SIZE; cx += CELL) {
            const tint = Math.floor((Math.random() - 0.5) * 16);
            for (let dy = 0; dy < CELL; dy++) {
                for (let dx = 0; dx < CELL; dx++) {
                    const px = cx + dx;
                    const py = cy + dy;
                    const i = (py * SIZE + px) * 4;
                    const noise = Math.floor((Math.random() - 0.5) * 12);
                    const edgeDarken = ((dx === 0 || dy === 0) ? -5 : 0) + ((dx === CELL - 1 || dy === CELL - 1) ? -4 : 0);
                    data[i + 0] = clampByte(78 + tint + noise + edgeDarken);
                    data[i + 1] = clampByte(79 + tint + noise + edgeDarken);
                    data[i + 2] = clampByte(81 + tint + noise + edgeDarken);
                    data[i + 3] = 255;
                }
            }
        }
    }

    const aggregateCount = Math.floor(SIZE * SIZE * 0.02);
    for (let n = 0; n < aggregateCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const delta = 8 + Math.floor(Math.random() * 14);
        data[i + 0] = clampByte(data[i + 0] + delta);
        data[i + 1] = clampByte(data[i + 1] + delta);
        data[i + 2] = clampByte(data[i + 2] + delta);
    }

    const stainCount = 26;
    for (let n = 0; n < stainCount; n++) {
        const cx = Math.random() * SIZE;
        const cy = Math.random() * SIZE;
        const rx = 16 + Math.random() * 54;
        const ry = 12 + Math.random() * 42;
        const strength = 6 + Math.random() * 10;
        const minX = Math.max(0, Math.floor(cx - rx));
        const maxX = Math.min(SIZE - 1, Math.ceil(cx + rx));
        const minY = Math.max(0, Math.floor(cy - ry));
        const maxY = Math.min(SIZE - 1, Math.ceil(cy + ry));
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const nx = (x - cx) / rx;
                const ny = (y - cy) / ry;
                const dist = nx * nx + ny * ny;
                if (dist >= 1) continue;
                const falloff = (1 - dist) * strength;
                const i = (y * SIZE + x) * 4;
                data[i + 0] = clampByte(data[i + 0] - falloff);
                data[i + 1] = clampByte(data[i + 1] - falloff);
                data[i + 2] = clampByte(data[i + 2] - falloff);
            }
        }
    }
    ctx.putImageData(img, 0, 0);

    _parkingTexture = new THREE.CanvasTexture(canvas);
    _parkingTexture.wrapS = THREE.RepeatWrapping;
    _parkingTexture.wrapT = THREE.RepeatWrapping;
    _parkingTexture.colorSpace = THREE.SRGBColorSpace;
    _parkingTexture.anisotropy = 4;
    _parkingTexture.minFilter = THREE.LinearMipmapLinearFilter;
    _parkingTexture.magFilter = THREE.LinearFilter;
    _parkingTexture.generateMipmaps = true;
    registerShared(_parkingTexture);
    return _parkingTexture;
}

function normaliseSurfaceType(type) {
    if (GREEN_SURFACE_TYPES.has(type)) return 'green';
    if (NATURAL_WATER_SURFACE_TYPES.has(type)) return 'water';
    if (type === 'forest') return 'forest';
    if (type === 'flowerbed') return 'flowerbed';
    return type;
}

function surfaceY(type) {
    if (type === 'water') return WATER_Y;
    if (type === 'fountain') return FOUNTAIN_WATER_Y;
    if (type === 'green') return 0.012;
    if (type === 'forest') return 0.0126;
    if (type === 'fitness') return 0.011;
    if (type === 'flowerbed') return 0.013;
    if (type === 'sand' || type === 'playground') return 0.013;
    if (type === 'paving') return 0.014;
    if (type === 'parking') return PARKING_SURFACE_Y;
    // Active construction wins over both parking paint and ordinary roads,
    // while remaining safely underneath the dedicated tram bed.
    if (type === 'construction') return CONSTRUCTION_SURFACE_Y;
    return 0.012;
}

function cleanRing(ring, anchorLon, anchorLat, cosLat) {
    const points = [];
    let lastX = null, lastZ = null;
    for (const [lon, lat] of ring) {
        const x = (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
        const z = -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M;
        if (lastX != null && Math.abs(x - lastX) < 0.01 && Math.abs(z - lastZ) < 0.01) continue;
        points.push({ x, z });
        lastX = x; lastZ = z;
    }
    if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) {
            points.pop();
        }
    }
    return points;
}

function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        const crosses = (a.z > z) !== (b.z > z);
        if (!crosses) continue;
        const xAtZ = ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
        if (x < xAtZ) inside = !inside;
    }
    return inside;
}

function pointInPolygon(x, z, outer, holes) {
    if (!pointInRing(x, z, outer)) return false;
    for (const hole of holes) {
        if (pointInRing(x, z, hole)) return false;
    }
    return true;
}

function getDominantRingAxis(ring) {
    let bestDx = 1;
    let bestDz = 0;
    let bestLenSq = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lenSq = dx * dx + dz * dz;
        if (lenSq <= bestLenSq) continue;
        bestLenSq = lenSq;
        bestDx = dx;
        bestDz = dz;
    }
    const len = Math.hypot(bestDx, bestDz) || 1;
    let axisX = bestDx / len;
    let axisZ = bestDz / len;
    if (axisX < 0 || (Math.abs(axisX) < 1e-6 && axisZ < 0)) {
        axisX *= -1;
        axisZ *= -1;
    }
    return { axisX, axisZ, normalX: -axisZ, normalZ: axisX };
}

function buildParkingSurfaceUvs(positions, outerRing) {
    const { axisX, axisZ, normalX, normalZ } = getDominantRingAxis(outerRing);
    let minU = Infinity;
    let minV = Infinity;
    for (const point of outerRing) {
        const u = point.x * axisX + point.z * axisZ;
        const v = point.x * normalX + point.z * normalZ;
        if (u < minU) minU = u;
        if (v < minV) minV = v;
    }
    const uvs = new Float32Array((positions.length / 3) * 2);
    for (let i = 0, uvIndex = 0; i < positions.length; i += 3, uvIndex += 2) {
        const x = positions[i];
        const z = positions[i + 2];
        uvs[uvIndex + 0] = (x * axisX + z * axisZ - minU) * PARKING_UV_PER_M;
        uvs[uvIndex + 1] = (x * normalX + z * normalZ - minV) * PARKING_UV_PER_M;
    }
    return uvs;
}

function expandBoundsByMeters(bounds, meters) {
    if (!bounds) return null;
    const centerLat = ((bounds.minLat + bounds.maxLat) * 0.5) || 0;
    const cosLat = Math.max(0.00001, Math.cos(centerLat * DEG_TO_RAD));
    const dLat = meters / EARTH_RADIUS_M / DEG_TO_RAD;
    const dLon = meters / (EARTH_RADIUS_M * cosLat) / DEG_TO_RAD;
    return {
        minLat: bounds.minLat - dLat,
        maxLat: bounds.maxLat + dLat,
        minLon: bounds.minLon - dLon,
        maxLon: bounds.maxLon + dLon,
    };
}

// Cached local-XZ bounding box for a polygon's outer ring. The ring is stable
// for the life of the spatial-index entry, so we compute it once and reuse it
// as a cheap fast-reject before the full point-in-ring vertex loop.
function ringXZBounds(ring) {
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, maxX, minZ, maxZ };
}

function isPointInsideAnyPolygon(x, z, polygons) {
    for (const polygon of polygons || []) {
        // Bounding-box fast-reject: skips the O(vertices) ring loop for every
        // polygon the point can't possibly be inside. This is what made the
        // parking-edge search O(n²) near greenery — pointInRing was ~55% of CPU.
        const bb = polygon._xzBounds || (polygon._xzBounds = ringXZBounds(polygon.outerRing));
        if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
        if (pointInPolygon(x, z, polygon.outerRing, polygon.holeRings || [])) return true;
    }
    return false;
}

function pointSegmentDistanceSq(x, z, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-9) return (x - a.x) ** 2 + (z - a.z) ** 2;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    const nearestX = a.x + dx * t;
    const nearestZ = a.z + dz * t;
    return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

function pointNearRing(x, z, ring, clearanceSq) {
    for (let index = 0; index < (ring || []).length; index++) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];
        if (pointSegmentDistanceSq(x, z, start, end) <= clearanceSq) return true;
    }
    return false;
}

function pointTouchesPolygons(x, z, polygons, clearanceM) {
    const clearanceSq = Math.max(0, clearanceM) ** 2;
    for (const polygon of polygons || []) {
        if (pointInPolygon(x, z, polygon.outerRing, polygon.holeRings || [])) return true;
        if (pointNearRing(x, z, polygon.outerRing, clearanceSq)) return true;
        for (const hole of polygon.holeRings || []) {
            if (pointNearRing(x, z, hole, clearanceSq)) return true;
        }
    }
    return false;
}

function spatialPolygonsTouchPoint(index, lon, lat, x, z, clearanceM) {
    if (!index) return false;
    const candidates = querySpatialIndex(index, radiusBounds(lat, lon, Math.max(1, clearanceM)));
    return pointTouchesPolygons(x, z, candidates, clearanceM);
}

function edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, edgeDistance, inwardDistance) {
    return {
        x: start.x + edgeX * edgeDistance + inwardX * inwardDistance,
        z: start.z + edgeZ * edgeDistance + inwardZ * inwardDistance,
    };
}

function pushLineQuad(vertices, start, end, width, y) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 0.05) return;
    const halfWidth = width * 0.5;
    const nx = -dz / length * halfWidth;
    const nz = dx / length * halfWidth;
    vertices.push(
        start.x + nx, y, start.z + nz,
        start.x - nx, y, start.z - nz,
        end.x + nx, y, end.z + nz,
        start.x - nx, y, start.z - nz,
        end.x - nx, y, end.z - nz,
        end.x + nx, y, end.z + nz,
    );
}

// Per FEATURE, not per asset: the caller memoises these on the tile-feature
// registry, so a tile arrival only projects rings for features it introduced
// instead of re-projecting every coordinate of every loaded road again.
// cleanRing is the expensive part (one projection per coordinate) and it is
// anchor-dependent — the registry's memo is cleared with the session that owns
// the anchor.
function polygonSurfaceEntries(geometry) {
    const entries = [];
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const polygons = geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
            ? geometry.coordinates
            : [];
    for (const rings of polygons) {
        if (!Array.isArray(rings) || rings.length === 0) continue;
        const outerRing = cleanRing(rings[0], anchorLon, anchorLat, cosLat);
        if (outerRing.length < 3) continue;
        const holeRings = [];
        for (let index = 1; index < rings.length; index++) {
            const holeRing = cleanRing(rings[index], anchorLon, anchorLat, cosLat);
            if (holeRing.length >= 3) holeRings.push(holeRing);
        }
        entries.push({
            ...polygonBoundsFromLonLatRing(rings[0]),
            outerRing,
            holeRings,
        });
    }
    return entries;
}

function roadSurfaceEntriesForFeature(feature) {
    if (!feature || !feature.geometry) return [];
    const props = feature.properties || {};
    if (props.railway_type) return [];
    if (props.highway_type === 'pedestrian') return [];
    return polygonSurfaceEntries(feature.geometry);
}

// Decor keeps props off buildings, which is a question about a building's plan.
// Prefer the server-sent ground outline: a LOD2 mesh's `geometry` parts are
// FACES, so indexing them yields ~168 wall slivers per building instead of one
// footprint — the same explosion that cost the terrain mask 82 ms a frame (see
// core/urban-ground.js). A footprint endpoint's geometry already IS the outline,
// so the fallback stays correct there.
function buildingFootprintEntriesForFeature(feature) {
    const outline = feature?.properties?.footprint || feature?.geometry;
    if (!outline) return [];
    return polygonSurfaceEntries(outline);
}

function getParkingRoadEdgeCandidates(outerRing, holeRings, bounds, roadSurfaceIndex) {
    if (!roadSurfaceIndex) return [];
    const roadPolygons = querySpatialIndex(roadSurfaceIndex, expandBoundsByMeters(bounds, 14));
    if (roadPolygons.length === 0) return [];
    const candidates = [];
    const isCcw = signedRingArea(outerRing) > 0;
    const addCandidate = ({ start, end, inwardX, inwardZ, roadHits }) => {
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (!Number.isFinite(length) || length < 4) return;
        candidates.push({
            start,
            end,
            length,
            edgeX: dx / length,
            edgeZ: dz / length,
            inwardX,
            inwardZ,
            roadHits,
            roadPolygons,
        });
    };

    for (let i = 0; i < outerRing.length; i++) {
        const start = outerRing[i];
        const end = outerRing[(i + 1) % outerRing.length];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (!Number.isFinite(length) || length < 4) continue;
        const edgeX = dx / length;
        const edgeZ = dz / length;
        const outwardX = isCcw ? edgeZ : -edgeZ;
        const outwardZ = isCcw ? -edgeX : edgeX;
        const inwardX = -outwardX;
        const inwardZ = -outwardZ;
        let roadHits = 0;
        for (const fraction of [0.2, 0.5, 0.8]) {
            const sample = edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, length * fraction, -PARKING_ACCESS_SAMPLE_M);
            if (isPointInsideAnyPolygon(sample.x, sample.z, roadPolygons)) roadHits += 1;
        }
        if (roadHits === 0) continue;
        addCandidate({ start, end, inwardX, inwardZ, roadHits });
    }

    const boundarySideSample = 0.6;
    for (const roadPolygon of roadPolygons) {
        const roadRings = [roadPolygon.outerRing, ...(roadPolygon.holeRings || [])];
        for (let ringIndex = 0; ringIndex < roadRings.length; ringIndex++) {
            const ring = roadRings[ringIndex];
            // A valid polygon's winding tells us which side of each boundary
            // is road. The previous code ran two full point-in-polygon tests
            // for every boundary segment, turning an N-vertex road into O(N²)
            // work. Outer-ring road is on the ring-interior side; for a hole
            // it is on the opposite side.
            const ringArea = signedRingArea(ring);
            if (Math.abs(ringArea) < 1e-7) continue;
            const ringInteriorNormalSign = ringArea > 0 ? 1 : -1;
            const roadNormalSign = ringIndex === 0
                ? ringInteriorNormalSign
                : -ringInteriorNormalSign;
            const parkingNormalSign = -roadNormalSign;
            for (let i = 0; i < ring.length; i++) {
                const start = ring[i];
                const end = ring[(i + 1) % ring.length];
                const dx = end.x - start.x;
                const dz = end.z - start.z;
                const length = Math.hypot(dx, dz);
                if (!Number.isFinite(length) || length < 4) continue;
                const edgeX = dx / length;
                const edgeZ = dz / length;
                const normalX = -edgeZ;
                const normalZ = edgeX;
                const midAlong = length * 0.5;
                const parkingSample = edgeFramePoint(
                    start,
                    edgeX,
                    edgeZ,
                    normalX,
                    normalZ,
                    midAlong,
                    boundarySideSample * parkingNormalSign,
                );
                if (!pointInPolygon(parkingSample.x, parkingSample.z, outerRing, holeRings)) continue;
                if (isPointInsideAnyPolygon(parkingSample.x, parkingSample.z, roadPolygons)) continue;
                addCandidate({
                    start,
                    end,
                    inwardX: normalX * parkingNormalSign,
                    inwardZ: normalZ * parkingNormalSign,
                    roadHits: 3,
                });
            }
        }
    }
    return candidates;
}

function canFitParkingStall({ start, edgeX, edgeZ, inwardX, inwardZ, stallStart, stallEnd, depth, outerRing, holeRings, roadPolygons, accessFractions }) {
    const sampleMargin = PARKING_STALL_SAMPLE_MARGIN_M;
    const insideSamples = [
        edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, stallStart + sampleMargin, sampleMargin),
        edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, stallEnd - sampleMargin, sampleMargin),
        edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, stallStart + sampleMargin, depth - sampleMargin),
        edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, stallEnd - sampleMargin, depth - sampleMargin),
        edgeFramePoint(start, edgeX, edgeZ, inwardX, inwardZ, (stallStart + stallEnd) * 0.5, depth * 0.5),
    ];
    for (const point of insideSamples) {
        if (!pointInPolygon(point.x, point.z, outerRing, holeRings)) return false;
    }
    for (const fraction of accessFractions) {
        const accessPoint = edgeFramePoint(
            start,
            edgeX,
            edgeZ,
            inwardX,
            inwardZ,
            stallStart + (stallEnd - stallStart) * fraction,
            -PARKING_ACCESS_SAMPLE_M
        );
        if (!isPointInsideAnyPolygon(accessPoint.x, accessPoint.z, roadPolygons)) return false;
    }
    return true;
}

function buildParkingStallPolygon(layout, stall) {
    const { edge, depth } = layout;
    return [
        edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start, 0),
        edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end, 0),
        edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end, depth),
        edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start, depth),
    ];
}

function ringCenter(ring) {
    let sumX = 0;
    let sumZ = 0;
    for (const point of ring) {
        sumX += point.x;
        sumZ += point.z;
    }
    const count = Math.max(1, ring.length);
    return { x: sumX / count, z: sumZ / count };
}

function segmentsProperlyIntersect(a, b, c, d) {
    const eps = 1e-7;
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return Math.abs(o1) > eps
        && Math.abs(o2) > eps
        && Math.abs(o3) > eps
        && Math.abs(o4) > eps
        && (o1 > 0) !== (o2 > 0)
        && (o3 > 0) !== (o4 > 0);
}

function polygonRingsOverlap(ringA, ringB) {
    const boundsA = ringA._xzBounds || (ringA._xzBounds = ringXZBounds(ringA));
    const boundsB = ringB._xzBounds || (ringB._xzBounds = ringXZBounds(ringB));
    if (boundsA.maxX < boundsB.minX || boundsA.minX > boundsB.maxX
        || boundsA.maxZ < boundsB.minZ || boundsA.minZ > boundsB.maxZ) {
        return false;
    }
    for (let i = 0; i < ringA.length; i++) {
        const a = ringA[i];
        const b = ringA[(i + 1) % ringA.length];
        for (let j = 0; j < ringB.length; j++) {
            const c = ringB[j];
            const d = ringB[(j + 1) % ringB.length];
            if (segmentsProperlyIntersect(a, b, c, d)) return true;
        }
    }
    const centerA = ringCenter(ringA);
    const centerB = ringCenter(ringB);
    if (pointInRing(centerA.x, centerA.z, ringB)) return true;
    if (pointInRing(centerB.x, centerB.z, ringA)) return true;
    return false;
}

function buildParkingLayoutForEdge(edge, outerRing, holeRings) {
    const variants = [
        {
            mode: 'perpendicular',
            span: PARKING_PERP_STALL_WIDTH_M,
            depth: PARKING_PERP_STALL_DEPTH_M,
            accessFractions: [0.5],
        },
        {
            mode: 'parallel',
            span: PARKING_PARALLEL_STALL_LENGTH_M,
            depth: PARKING_PARALLEL_STALL_DEPTH_M,
            accessFractions: [0.2, 0.5, 0.8],
        },
    ];
    let best = null;
    for (const variant of variants) {
        const usableLength = edge.length - PARKING_EDGE_CLEARANCE_M * 2;
        if (usableLength < variant.span) continue;
        const stallCount = Math.floor(usableLength / variant.span);
        if (stallCount < 1) continue;
        const rowStart = PARKING_EDGE_CLEARANCE_M + (usableLength - stallCount * variant.span) * 0.5;
        const stalls = [];
        for (let i = 0; i < stallCount; i++) {
            const stallStart = rowStart + i * variant.span;
            const stallEnd = stallStart + variant.span;
            const fits = canFitParkingStall({
                start: edge.start,
                edgeX: edge.edgeX,
                edgeZ: edge.edgeZ,
                inwardX: edge.inwardX,
                inwardZ: edge.inwardZ,
                stallStart,
                stallEnd,
                depth: variant.depth,
                outerRing,
                holeRings,
                roadPolygons: edge.roadPolygons,
                accessFractions: variant.accessFractions,
            });
            if (!fits) continue;
            stalls.push({ start: stallStart, end: stallEnd });
        }
        if (stalls.length === 0) continue;
        const layout = {
            ...variant,
            stalls,
            rowStart,
            edge,
        };
        if (!best
            || layout.stalls.length > best.stalls.length
            || (layout.stalls.length === best.stalls.length && layout.mode === 'perpendicular' && best.mode !== 'perpendicular')) {
            best = layout;
        }
    }
    return best;
}

function buildParkingLayouts(outerRing, holeRings, bounds, roadSurfaceIndex) {
    // Forests / large parks have no parking stalls; skip the O(n²) edge search.
    if (Math.abs(signedRingArea(outerRing)) > MAX_PARKING_POLYGON_AREA_M2) return [];
    const edges = getParkingRoadEdgeCandidates(outerRing, holeRings, bounds, roadSurfaceIndex);
    const layouts = [];
    for (const edge of edges) {
        const layout = buildParkingLayoutForEdge(edge, outerRing, holeRings);
        if (layout) layouts.push(layout);
    }
    if (layouts.length === 0) return [];
    layouts.sort((a, b) => {
        if (b.stalls.length !== a.stalls.length) return b.stalls.length - a.stalls.length;
        if (b.edge.roadHits !== a.edge.roadHits) return b.edge.roadHits - a.edge.roadHits;
        if (b.edge.length !== a.edge.length) return b.edge.length - a.edge.length;
        if (a.mode !== b.mode) return a.mode === 'perpendicular' ? -1 : 1;
        return 0;
    });
    const acceptedLayouts = [];
    const acceptedStallPolygons = [];
    for (const layout of layouts) {
        const keptStalls = [];
        const keptPolygons = [];
        for (const stall of layout.stalls) {
            const polygon = buildParkingStallPolygon(layout, stall);
            const overlapsAccepted = acceptedStallPolygons.some((accepted) => polygonRingsOverlap(polygon, accepted))
                || keptPolygons.some((accepted) => polygonRingsOverlap(polygon, accepted));
            if (overlapsAccepted) continue;
            keptStalls.push(stall);
            keptPolygons.push(polygon);
        }
        if (keptStalls.length === 0) continue;
        acceptedLayouts.push({ ...layout, stalls: keptStalls });
        acceptedStallPolygons.push(...keptPolygons);
    }
    return acceptedLayouts;
}

function appendParkingLayoutMarkings(vertices, layout) {
    if (!layout || !Array.isArray(layout.stalls) || layout.stalls.length === 0) return;
    const { edge, mode, depth, stalls } = layout;
    const lineColorInset = mode === 'parallel' ? 0.1 : 0.22;
    const lineStartInset = 0.28;
    if (mode === 'perpendicular') {
        const boundaryKeys = new Set();
        for (const stall of stalls) {
            boundaryKeys.add(stall.start.toFixed(3));
            boundaryKeys.add(stall.end.toFixed(3));
        }
        const boundaries = Array.from(boundaryKeys).map(Number).sort((a, b) => a - b);
        for (const boundary of boundaries) {
            pushLineQuad(
                vertices,
                edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, boundary, lineStartInset),
                edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, boundary, depth - lineColorInset),
                PARKING_MARKING_WIDTH_M,
                PARKING_MARKING_Y
            );
        }
        for (const stall of stalls) {
            pushLineQuad(
                vertices,
                edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start + lineColorInset, depth - lineColorInset),
                edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end - lineColorInset, depth - lineColorInset),
                PARKING_MARKING_WIDTH_M,
                PARKING_MARKING_Y
            );
        }
        return;
    }
    for (const stall of stalls) {
        pushLineQuad(
            vertices,
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start, lineStartInset),
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start, depth - lineColorInset),
            PARKING_MARKING_WIDTH_M,
            PARKING_MARKING_Y
        );
        pushLineQuad(
            vertices,
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end, lineStartInset),
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end, depth - lineColorInset),
            PARKING_MARKING_WIDTH_M,
            PARKING_MARKING_Y
        );
        pushLineQuad(
            vertices,
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.start + lineColorInset, depth - lineColorInset),
            edgeFramePoint(edge.start, edge.edgeX, edge.edgeZ, edge.inwardX, edge.inwardZ, stall.end - lineColorInset, depth - lineColorInset),
            PARKING_MARKING_WIDTH_M,
            PARKING_MARKING_Y
        );
    }
}

function appendParkingLayoutsMarkings(vertices, layouts) {
    for (const layout of layouts || []) {
        appendParkingLayoutMarkings(vertices, layout);
    }
}

function prepareTreesAsset(trees) {
    return createSpatialIndex((trees || []).map(([lat, lng, osmH, sourceId, treeType]) => ({
        minLat: lat,
        maxLat: lat,
        minLon: lng,
        maxLon: lng,
        lat,
        lng,
        osmH,
        treeType: normalizeTreeType(treeType),
        id: sourceId ? `tree:${sourceId}` : `tree:${Number(lat).toFixed(7)}:${Number(lng).toFixed(7)}`,
    })));
}

function prepareCrossingsAsset(crossings) {
    return createSpatialIndex((crossings || []).map(([lat, lng, bearing]) => ({
        minLat: lat,
        maxLat: lat,
        minLon: lng,
        maxLon: lng,
        lat,
        lng,
        bearing,
    })));
}

function prepareTrafficLightsAsset(signals) {
    return createSpatialIndex((signals || []).map(([lat, lng, bearing, sourceId]) => ({
        minLat: lat,
        maxLat: lat,
        minLon: lng,
        maxLon: lng,
        lat,
        lng,
        bearing,
        id: sourceId
            ? `traffic-light:${sourceId}`
            : `traffic-light:${Number(lat).toFixed(7)}:${Number(lng).toFixed(7)}`,
    })));
}

// [[lat, lon, radius_m], ...] — point-mapped OSM amenity=fountain features.
// Area/line fountains are exact polygon surfaces in the greenery feed.
function prepareFountainsAsset(fountains) {
    return createSpatialIndex((fountains || []).map(([lat, lng, radius, sourceId]) => ({
        minLat: lat, maxLat: lat, minLon: lng, maxLon: lng,
        lat, lng,
        id: sourceId ? `fountain:${sourceId}` : `fountain:${Number(lat).toFixed(7)}:${Number(lng).toFixed(7)}`,
        radius: Math.max(0.8, Number(radius) || 1.6),
    })));
}

function prepareBenchesAsset(benches) {
    return createSpatialIndex((benches || []).map(([lat, lng, bearing, sourceId]) => ({
        minLat: lat,
        maxLat: lat,
        minLon: lng,
        maxLon: lng,
        lat,
        lng,
        bearing,
        id: sourceId ? `bench:${sourceId}` : `bench:${Number(lat).toFixed(7)}:${Number(lng).toFixed(7)}`,
    })));
}

// The API delivers footpaths as independent segments; drawn one rectangle
// each they meet with cracks and open wedges at every bend. Join them back
// into polyline chains here (in a fixed pseudo-metre frame, so the join
// epsilon is isotropic), and let the builder smooth + ribbon each chain.
function prepareFootpathsAsset(segments) {
    const raw = [];
    let refLat = null;
    for (const segment of segments || []) {
        if (!Array.isArray(segment) || segment.length < 5) continue;
        const [lon1, lat1, lon2, lat2, width] = segment;
        if (refLat == null) refLat = lat1;
        raw.push({ lon1, lat1, lon2, lat2, width });
    }
    if (raw.length === 0) return createSpatialIndex([]);
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(refLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const chains = buildChainsFromSegments(raw.map((s) => ({
        x1: s.lon1 * scaleLon, z1: -s.lat1 * scaleLat,
        x2: s.lon2 * scaleLon, z2: -s.lat2 * scaleLat,
        width: s.width,
    })));
    const entries = [];
    for (const chain of chains) {
        const coords = chain.points.map((p) => [p.x / scaleLon, -p.z / scaleLat]);
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const [lon, lat] of coords) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
        entries.push({ minLat, maxLat, minLon, maxLon, coords, widths: chain.widths });
    }
    return createSpatialIndex(entries);
}

function polylineBoundsFromLonLatCoords(coords) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of coords || []) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    }
    return { minLat, maxLat, minLon, maxLon };
}

function prepareHedgesAsset(lines) {
    const entries = [];
    for (const coords of lines || []) {
        if (!Array.isArray(coords) || coords.length < 2) continue;
        entries.push({
            ...polylineBoundsFromLonLatCoords(coords),
            coords,
        });
    }
    return createSpatialIndex(entries);
}

function polygonBoundsFromLonLatRing(ring) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lon, lat] of ring || []) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    }
    return { minLat, maxLat, minLon, maxLon };
}

function prepareGreeneryAsset(fc) {
    const entries = [];
    for (const feat of (fc && fc.features) || []) {
        const properties = feat.properties || {};
        const type = properties.t || 'grass';
        const geom = feat.geometry;
        if (!geom) continue;
        const polygons = geom.type === 'Polygon'
            ? [geom.coordinates]
            : geom.type === 'MultiPolygon'
                ? geom.coordinates
                : [];
        for (const rings of polygons) {
            if (!Array.isArray(rings) || rings.length === 0) continue;
            entries.push({
                ...polygonBoundsFromLonLatRing(rings[0]),
                type,
                semantic: properties.semantic || null,
                aeroway: properties.aeroway || null,
                sourceId: properties.sourceId || null,
                groundPaintEligible: decorGroundPaintEligible(normaliseSurfaceType(type), properties),
                barrier: properties.barrier || null,
                fountain: properties.fountain || null,
                rings,
            });
        }
    }
    return createSpatialIndex(entries);
}

export function isPointInDecorWater(localX, localZ) {
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return false;
    for (const poly of currentWaterPolygons) {
        if (pointInPolygon(localX, localZ, poly.outerRing, poly.holeRings)) return true;
    }
    return false;
}

// Lake and river banks as local [x, z] rings for moorings, converted once per
// greenery publication rather than on every spawn scan.
let decorShorelineCache = { polygons: null, rings: [] };
export function decorWaterShorelineRings() {
    if (decorShorelineCache.polygons !== currentWaterPolygons) {
        decorShorelineCache = {
            polygons: currentWaterPolygons,
            rings: currentWaterPolygons.flatMap(poly => [poly.outerRing, ...(poly.holeRings || [])]
                .filter(ring => Array.isArray(ring) && ring.length >= 2)
                .map(ring => ring.map(point => [point.x, point.z]))),
        };
    }
    return decorShorelineCache.rings;
}

export function getRunwaySpawnCandidatesNear(localX, localZ, radiusM = 1800) {
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return [];
    const radiusSq = Math.max(0, Number(radiusM) || 0) ** 2;
    return currentRunwaySpawns
        .filter(candidate => (
            (candidate.x - localX) ** 2 + (candidate.z - localZ) ** 2 <= radiusSq
        ))
        .map(candidate => ({ ...candidate }));
}

export function isPointInLoadedRunway(localX, localZ) {
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return false;
    return currentRunwaySpawns.some(candidate => (
        pointInLocalRing(localX, localZ, candidate.ring)
    ));
}

function signedRingArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        area += a.x * b.z - b.x * a.z;
    }
    return area * 0.5;
}

function orient(a, b, c) {
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(a, b, p) {
    const eps = 1e-7;
    return Math.min(a.x, b.x) - eps <= p.x && p.x <= Math.max(a.x, b.x) + eps
        && Math.min(a.z, b.z) - eps <= p.z && p.z <= Math.max(a.z, b.z) + eps
        && Math.abs(orient(a, b, p)) <= eps;
}

function segmentsIntersect(a, b, c, d) {
    const eps = 1e-7;
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if (Math.abs(o1) <= eps && onSegment(a, b, c)) return true;
    if (Math.abs(o2) <= eps && onSegment(a, b, d)) return true;
    if (Math.abs(o3) <= eps && onSegment(c, d, a)) return true;
    if (Math.abs(o4) <= eps && onSegment(c, d, b)) return true;
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function ringSelfIntersects(ring) {
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        for (let j = i + 1; j < ring.length; j++) {
            if (Math.abs(i - j) <= 1) continue;
            if (i === 0 && j === ring.length - 1) continue;
            const c = ring[j];
            const d = ring[(j + 1) % ring.length];
            if (segmentsIntersect(a, b, c, d)) return true;
        }
    }
    return false;
}

// A prop stands on the street surface, so it has to go wherever that surface
// is removed. The corridor volumes cannot decide this alone: each one rides
// down with its own track segment (centerY carries the segment elevation), so
// a ramp deeper than ~5 m has its volume metres below a surface prop and never
// contains it — while the ground above it IS cut away. The shader cutout does
// not save us either: it only discards fragments below y = 1, so a tree over
// an open trench lost its trunk and kept its crown, hanging in mid-air. Test
// the prop against the ground actually removed.
const DECOR_SURFACE_CUT_MARGIN_M = 0.4;

// Point-in-ring test on the XZ plane (ray casting). ring = [{x, z}, …].
function pointInRingXZ(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const zi = ring[i].z;
        const zj = ring[j].z;
        if ((zi > z) !== (zj > z)
            && x < (ring[j].x - ring[i].x) * (z - zi) / (zj - zi) + ring[i].x) {
            inside = !inside;
        }
    }
    return inside;
}

// The engineered rail formation reshapes the ground far wider than the trackbed
// corridor: a cut opens a trench, a fill raises an embankment, and both flare out
// to batter slopes. None of that is covered by customTrackCorridorVolumes (trackbed
// width only) or the planner surface cutout (y < 1 discard), so a tree on the batter
// or over an open cut survived and punched through the deck. Cull anything standing
// on a surface profile's full footprint. Viaduct runs have no surface profile, so
// trees legitimately remain under viaducts.
function standsOnRailFormation(localX, localZ) {
    const model = terrainReference && terrainReference.railFormation;
    if (!model || typeof model.getSurfaceProfiles !== 'function') return false;
    const profiles = typeof model.getSurfaceProfilesAtLocal === 'function'
        ? model.getSurfaceProfilesAtLocal(localX, localZ)
        : model.getSurfaceProfiles();
    for (const profile of profiles) {
        const ring = profile.outerRing || profile.overlapRing || profile.terrainCutoutRing;
        if (!ring || ring.length < 3) continue;
        const b = profile.outerBounds || profile.overlapBounds
            || profile.terrainCutoutBounds || profile.bounds;
        if (b && (localX < b.minX || localX > b.maxX || localZ < b.minZ || localZ > b.maxZ)) continue;
        if (pointInRingXZ(localX, localZ, ring)) return true;
    }
    return false;
}

function standsOnRemovedGround(localX, localZ) {
    return isPointInsideCorridorVolumes(localX, 0, localZ, customTrackCorridorVolumes)
        // The volume test above is Y-aware (evaluated at the ground plane), so it
        // MISSES an at-grade drawn track whose corridor volume sits above y=0 —
        // that let trees stand in the middle of a flat trackbed. Also cull anything
        // inside the corridor FOOTPRINT. (A thin strip directly under a viaduct is
        // culled too; that's fine — the deck shadows it and it's barely visible.)
        || isPointInsideCorridorFootprints(localX, localZ, customTrackCorridorVolumes, DECOR_SURFACE_CUT_MARGIN_M)
        || isPointInsidePlannerSurfaceCutout(localX, localZ, DECOR_SURFACE_CUT_MARGIN_M)
        || standsOnRailFormation(localX, localZ)
        // Photoreal (DGU) worlds carve the corridor with their own machinery, not
        // the rail-formation model above — so trees over an open cut or the
        // trackbed survived and punched through. Cull them against that carve too.
        || isPhotorealCorridorGround(localX, localZ);
}

// Unified decor-corridor cull used by EVERY decor sub-layer. True when the object
// base — or its footprint of radiusM — sits on the removed/formed track ground
// (cut, fill, embankment batter, at-grade corridor via the rail formation) or in
// the drawn proposal mask. Single authority that keeps trees, forest/greenery
// bushes, hedges, natural props and benches off the track in cut / fill / viaduct
// / at-grade; tall decor (trees) additionally tests treeIntersectsElevatedTrack.
// Pass lat=NaN to skip the geographic mask (for layers holding only local coords).
function standsOnOrOverCorridor(localX, localZ, lat, lng, radiusM = 0) {
    if (standsOnRemovedGround(localX, localZ)) return true;
    if (Number.isFinite(lat) && decorMaskedAt(lat, lng)) return true;
    if (radiusM > 0) {
        if (standsOnRemovedGround(localX + radiusM, localZ)) return true;
        if (standsOnRemovedGround(localX - radiusM, localZ)) return true;
        if (standsOnRemovedGround(localX, localZ + radiusM)) return true;
        if (standsOnRemovedGround(localX, localZ - radiusM)) return true;
    }
    return false;
}

// ─── Trees ─────────────────────────────────────────────────────────────────

function treeIntersectsElevatedTrack(localX, localZ, treeTopY, crownRadius) {
    for (const volume of customElevatedTrackCorridorVolumes) {
        const dx = localX - volume.centerX;
        const dz = localZ - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) > volume.halfWidth + crownRadius
            || Math.abs(localAlong) > volume.halfDepth + crownRadius) continue;
        const segmentLength = Math.max(0.01, volume.segmentHalfLength * 2);
        const t = Math.max(0, Math.min(1,
            (localAlong + volume.segmentHalfLength) / segmentLength,
        ));
        // A volume with no readable level is not a deck to hide under. Left as
        // arithmetic on null this read as a deck at 0 m, and every tree along a
        // corridor whose levels are absolute got culled under a phantom one.
        const startElevationM = finiteOrNull(volume.startElevationM);
        const endElevationM = finiteOrNull(volume.endElevationM);
        if (startElevationM === null || endElevationM === null) continue;
        const deckTopY = startElevationM + (endElevationM - startElevationM) * t;
        if (deckTopY <= 0.5) continue;
        if (treeTopY >= deckTopY - ELEVATED_GUIDEWAY_DECK_THICKNESS_M) return true;
    }
    // Model-mode viaducts are built from the rail formation (designed railY), not
    // from authored corridor Z, so customElevatedTrackCorridorVolumes above is
    // empty for them and trees punched up through the deck. Cull against the same
    // viaduct-run geometry rails.js renders, mirroring standsOnRailFormation.
    const railModel = terrainReference && terrainReference.railFormation;
    if (railModel && typeof railModel.getViaductRuns === 'function') {
        for (const run of railModel.getViaductRuns()) {
            const samples = run.samples;
            if (!samples || samples.length < 2) continue;
            // + VIADUCT_DECK_EDGE_MARGIN_M (rails.js:79, not exported) + crown reach.
            const reach = (run.alignment?.halfWidthM ?? 1.15) + 0.35 + crownRadius;
            for (let i = 0; i < samples.length - 1; i++) {
                const a = samples[i];
                const b = samples[i + 1];
                const sdx = b.x - a.x;
                const sdz = b.z - a.z;
                const segLen2 = sdx * sdx + sdz * sdz;
                if (segLen2 < 1e-6) continue;
                const t = Math.max(0, Math.min(1,
                    ((localX - a.x) * sdx + (localZ - a.z) * sdz) / segLen2));
                const px = a.x + sdx * t;
                const pz = a.z + sdz * t;
                if ((localX - px) ** 2 + (localZ - pz) ** 2 > reach * reach) continue;
                const railY = a.railY + (b.railY - a.railY) * t;
                // Deck top matches rails.js addRailViaducts: railY + trackbed − 0.015.
                const deckTopY = railY + GROUND_SURFACE_LEVELS.tramBed - 0.015;
                if (treeTopY >= deckTopY - ELEVATED_GUIDEWAY_DECK_THICKNESS_M) return true;
            }
        }
    }
    return false;
}

async function buildTreesGroup(treesIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!treesIndex) return null;

    const rng = (lat, lng) => {
        const s = Math.sin(lat * 127.3 + lng * 311.7) * 43758.5453;
        return s - Math.floor(s);
    };
    const RADIUS_M = 1800;
    const r2 = RADIUS_M * RADIUS_M;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(treesIndex, radiusBounds(centerLat, centerLon, RADIUS_M));
    const nearby = [];
    const yieldState = createBuildYieldState();
    for (const entry of candidates) {
        const { lat, lng, osmH, treeType } = entry;
        const local = geoToLocal(lng, lat, anchorLon, anchorLat);
        const dx = local.x - centerLocal.x;
        const dz = local.z - centerLocal.z;
        if (dx * dx + dz * dz > r2) continue;
        const randomUnit = rng(lat, lng);
        const parsedHeight = Number(osmH);
        const totalH = Number.isFinite(parsedHeight) && parsedHeight > 0
            ? parsedHeight
            : 6 + randomUnit * 9;
        const { trunkHeightM: trunkH, crownRadiusM: crownR } = treeShapeDimensions(totalH, treeType);
        // Cull the base OR the crown footprint over the track corridor (cut/fill/
        // formation/mask); the elevated-deck test below then covers viaducts.
        if (standsOnOrOverCorridor(local.x, local.z, lat, lng, crownR)) continue;
        const groundY = terrainBaseY(local.x, local.z);
        if (groundY === null) continue;
        const treeTopY = groundY + trunkH + (treeType === TREE_TYPE_PALM ? crownR * 0.58 : crownR * 1.8);
        if (treeIntersectsElevatedTrack(local.x, local.z, treeTopY, crownR)) continue;
        nearby.push({ id: entry.id, local, totalH, groundY, treeType });
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'trees'))) return null;
    }
    if (nearby.length === 0) return null;

    const broadleafTrunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
    const crownGeo = new THREE.SphereGeometry(1, 6, 5);
    const palmParts = createPalmTreeParts();
    const broadleafTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.9 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x3a6b35, roughness: 0.85 });
    const disposeLocal = () => {
        broadleafTrunkGeo.dispose();
        crownGeo.dispose();
        palmParts.trunkGeo.dispose();
        palmParts.crownGeo.dispose();
        broadleafTrunkMat.dispose();
        crownMat.dispose();
        palmParts.trunkMat.dispose();
        palmParts.crownMat.dispose();
    };

    const broadleafTrees = nearby.filter(tree => tree.treeType !== TREE_TYPE_PALM);
    const palmTrees = nearby.filter(tree => tree.treeType === TREE_TYPE_PALM);
    const broadleafTrunkMesh = broadleafTrees.length > 0
        ? createInstancedMesh(broadleafTrunkGeo, broadleafTrunkMat, broadleafTrees.length)
        : null;
    const crownMesh = broadleafTrees.length > 0
        ? createInstancedMesh(crownGeo, crownMat, broadleafTrees.length)
        : null;
    const palmTrunkMesh = palmTrees.length > 0
        ? createInstancedMesh(palmParts.trunkGeo, palmParts.trunkMat, palmTrees.length)
        : null;
    const palmCrownMesh = palmTrees.length > 0
        ? createInstancedMesh(palmParts.crownGeo, palmParts.crownMat, palmTrees.length)
        : null;
    if (!broadleafTrunkMesh) {
        broadleafTrunkGeo.dispose();
        broadleafTrunkMat.dispose();
        crownGeo.dispose();
        crownMat.dispose();
    }
    if (!palmTrunkMesh) {
        palmParts.trunkGeo.dispose();
        palmParts.crownGeo.dispose();
        palmParts.trunkMat.dispose();
        palmParts.crownMat.dispose();
    }
    if (broadleafTrunkMesh) {
        broadleafTrunkMesh.name = 'BroadleafTreeTrunks';
        broadleafTrunkMesh.castShadow = true;
    }
    if (crownMesh) {
        crownMesh.name = 'BroadleafTreeCrowns';
        crownMesh.castShadow = true;
    }
    if (palmTrunkMesh) {
        palmTrunkMesh.name = 'PalmTreeTrunks';
        palmTrunkMesh.castShadow = true;
        palmCrownMesh.name = 'PalmTreeCrowns';
        palmCrownMesh.castShadow = true;
    }

    const dummy = new THREE.Object3D();
    for (let index = 0; index < broadleafTrees.length; index++) {
        const { local, totalH, groundY } = broadleafTrees[index];
        const { trunkHeightM: trunkH, crownRadiusM: crownR } = treeShapeDimensions(totalH);
        dummy.position.set(local.x, groundY + trunkH / 2, local.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, trunkH, 1);
        dummy.updateMatrix();
        broadleafTrunkMesh.setMatrixAt(index, dummy.matrix);
        dummy.position.set(local.x, groundY + trunkH + crownR * 0.65, local.z);
        dummy.scale.set(crownR, crownR * 1.15, crownR);
        dummy.updateMatrix();
        crownMesh.setMatrixAt(index, dummy.matrix);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'trees'))) {
            disposeLocal();
            return null;
        }
    }
    if (broadleafTrunkMesh) broadleafTrunkMesh.instanceMatrix.needsUpdate = true;
    if (crownMesh) crownMesh.instanceMatrix.needsUpdate = true;

    for (let index = 0; index < palmTrees.length; index++) {
        const { local, totalH, groundY } = palmTrees[index];
        const { trunkHeightM: trunkH, crownRadiusM: crownR, trunkRadiusM } = treeShapeDimensions(totalH, TREE_TYPE_PALM);
        const yaw = rng(local.x, local.z) * Math.PI * 2;
        dummy.position.set(local.x, groundY, local.z);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(trunkRadiusM, trunkH, trunkRadiusM);
        dummy.updateMatrix();
        palmTrunkMesh.setMatrixAt(index, dummy.matrix);
        dummy.position.set(local.x, groundY + trunkH, local.z);
        dummy.rotation.set(0, yaw, 0);
        const crownVariation = 0.92 + rng(local.z, local.x) * 0.14;
        dummy.scale.set(crownR * crownVariation, crownR, crownR / crownVariation);
        dummy.updateMatrix();
        palmCrownMesh.setMatrixAt(index, dummy.matrix);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'trees'))) {
            disposeLocal();
            return null;
        }
    }
    if (palmTrunkMesh) palmTrunkMesh.instanceMatrix.needsUpdate = true;
    if (palmCrownMesh) palmCrownMesh.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.name = 'DecorTrees';
    if (broadleafTrunkMesh) group.add(broadleafTrunkMesh);
    if (crownMesh) group.add(crownMesh);
    if (palmTrunkMesh) group.add(palmTrunkMesh, palmCrownMesh);
    group.userData.immutableProps = nearby.map(tree => ({
        id: tree.id,
        kind: 'tree',
        x: tree.local.x,
        y: tree.groundY,
        z: tree.local.z,
        radiusM: Math.max(0.22, Math.min(0.55, tree.totalH * 0.025)),
        heightM: tree.totalH,
        treeType: tree.treeType,
        destructive: false,
    }));
    return group;
}

// ─── Greenery (landuse / natural / leisure polygons) ───────────────────────

function ringBounds(ring) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, maxX, minZ, maxZ };
}

function seededNoise(x, z, salt) {
    const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
    return s - Math.floor(s);
}

function polygonAreaM2({ outerRing, holeRings = [] }) {
    return Math.max(
        0,
        Math.abs(signedRingArea(outerRing))
            - holeRings.reduce((sum, ring) => sum + Math.abs(signedRingArea(ring)), 0),
    );
}

async function sampleDecorPoints(
    polygons,
    spacing,
    jitter,
    chance,
    margin = 0,
    shouldCancel = () => false,
    maxPoints = Infinity,
) {
    const points = [];
    const yieldState = createBuildYieldState();
    for (let polyIndex = 0; polyIndex < polygons.length; polyIndex++) {
        const poly = polygons[polyIndex];
        const { outerRing, holeRings } = poly;
        const area = polygonAreaM2(poly);
        if (!Number.isFinite(area) || area < spacing * spacing * 0.5) continue;
        const bounds = ringBounds(outerRing);
        const startX = bounds.minX + spacing * 0.5;
        const endX = bounds.maxX - spacing * 0.5;
        const startZ = bounds.minZ + spacing * 0.5;
        const endZ = bounds.maxZ - spacing * 0.5;
        if (endX < startX || endZ < startZ) continue;
        for (let x = startX; x <= endX + 1e-6; x += spacing) {
            for (let z = startZ; z <= endZ + 1e-6; z += spacing) {
                const roll = seededNoise(x, z, polyIndex + 1);
                if (roll <= chance) {
                    const jitterX = (seededNoise(x, z, polyIndex + 11) - 0.5) * jitter;
                    const jitterZ = (seededNoise(x, z, polyIndex + 23) - 0.5) * jitter;
                    const px = x + jitterX;
                    const pz = z + jitterZ;
                    const inside = pointInPolygon(px, pz, outerRing, holeRings)
                        && (margin <= 0 || (
                            pointInPolygon(px + margin, pz, outerRing, holeRings)
                            && pointInPolygon(px - margin, pz, outerRing, holeRings)
                            && pointInPolygon(px, pz + margin, outerRing, holeRings)
                            && pointInPolygon(px, pz - margin, outerRing, holeRings)
                        ));
                    if (inside && !standsOnRemovedGround(px, pz)) {
                        points.push({ x: px, z: pz, seed: roll });
                        if (points.length >= maxPoints) return points;
                    }
                }
                // Yield on probes, not only accepted points. A sparse or
                // heavily-holed polygon must not monopolise the main thread.
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'sample'))) return null;
            }
        }
    }
    return points;
}

async function buildForestTreesGroup(polygons, shouldCancel) {
    const totalAreaM2 = polygons.reduce((sum, polygon) => sum + polygonAreaM2(polygon), 0);
    const spacing = sampleSpacingForBudget(totalAreaM2, {
        baseSpacingM: FOREST_TREE_SPACING_M,
        acceptanceChance: 0.72,
        maxPoints: FOREST_TREE_INSTANCE_BUDGET,
    });
    let points = await sampleDecorPoints(
        polygons,
        spacing,
        Math.min(4.8, spacing * 0.5),
        0.72,
        1.4,
        shouldCancel,
        FOREST_TREE_INSTANCE_BUDGET,
    );
    if (!points) return null;
    if (shouldCancel()) return null;
    // Cull forest/greenery trees whose base or crown footprint sits on the track
    // corridor — a track crossing a park/forest landuse otherwise drops trees and
    // bushes right onto the rails (this layer had no corridor cull at all).
    points = points.filter((p) => !standsOnOrOverCorridor(p.x, p.z, NaN, NaN, 2.5));
    if (points.length === 0) return null;

    const yieldState = createBuildYieldState();
    const chunks = new Map();
    let readyPointCount = 0;
    for (const point of points) {
        const groundY = terrainBaseY(point.x, point.z);
        if (groundY !== null) {
            const key = `${Math.floor(point.x / FOREST_TREE_CHUNK_M)}:${Math.floor(point.z / FOREST_TREE_CHUNK_M)}`;
            if (!chunks.has(key)) chunks.set(key, []);
            chunks.get(key).push({ ...point, groundY });
            readyPointCount += 1;
        }
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'forest:evidence'))) return null;
    }
    if (readyPointCount === 0) return null;

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1, 6);
    const crownGeo = new THREE.SphereGeometry(1, 7, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1d, roughness: 0.92 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f5c2d, roughness: 0.9 });
    const disposeLocal = () => {
        trunkGeo.dispose();
        crownGeo.dispose();
        trunkMat.dispose();
        crownMat.dispose();
    };
    const group = new THREE.Group();
    group.name = 'DecorForestTrees';
    group.userData.decorKind = 'forest';
    group.userData.instanceCount = readyPointCount;
    group.userData.chunkCount = chunks.size;
    const dummy = new THREE.Object3D();
    for (const chunkPoints of chunks.values()) {
        const trunkMesh = createInstancedMesh(trunkGeo, trunkMat, chunkPoints.length);
        const crownMesh = createInstancedMesh(crownGeo, crownMat, chunkPoints.length);
        trunkMesh.castShadow = true;
        crownMesh.castShadow = true;
        for (let index = 0; index < chunkPoints.length; index++) {
            const { x, z, seed, groundY } = chunkPoints[index];
            const totalH = 5.5 + seededNoise(x, z, seed * 101 + 5) * 8.5;
            const trunkH = totalH * 0.52;
            const crownR = totalH * 0.2 + 0.7;
            dummy.position.set(x, groundY + trunkH / 2, z);
            dummy.scale.set(1, trunkH, 1);
            dummy.updateMatrix();
            trunkMesh.setMatrixAt(index, dummy.matrix);

            dummy.position.set(x, groundY + trunkH + crownR * 0.72, z);
            dummy.scale.set(crownR, crownR * 1.18, crownR);
            dummy.updateMatrix();
            crownMesh.setMatrixAt(index, dummy.matrix);
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'forest'))) {
                disposeLocal();
                return null;
            }
        }
        trunkMesh.instanceMatrix.needsUpdate = true;
        crownMesh.instanceMatrix.needsUpdate = true;
        trunkMesh.computeBoundingBox();
        trunkMesh.computeBoundingSphere();
        crownMesh.computeBoundingBox();
        crownMesh.computeBoundingSphere();
        group.add(trunkMesh);
        group.add(crownMesh);
    }
    return group;
}

async function buildFlowerbedsGroup(polygons, shouldCancel) {
    const totalAreaM2 = polygons.reduce((sum, polygon) => sum + polygonAreaM2(polygon), 0);
    const spacing = sampleSpacingForBudget(totalAreaM2, {
        baseSpacingM: FLOWERBED_PLANT_SPACING_M,
        acceptanceChance: 0.86,
        maxPoints: FLOWERBED_PLANT_INSTANCE_BUDGET,
    });
    const sampledPoints = await sampleDecorPoints(
        polygons,
        spacing,
        Math.min(0.8, spacing * 0.5),
        0.86,
        0.18,
        shouldCancel,
        FLOWERBED_PLANT_INSTANCE_BUDGET,
    );
    if (!sampledPoints) return null;
    if (shouldCancel()) return null;
    if (sampledPoints.length === 0) return null;

    const yieldState = createBuildYieldState();
    const points = [];
    for (const point of sampledPoints) {
        const groundY = decorSurfaceYAt('flowerbed', point.x, point.z);
        if (groundY !== null) points.push({ ...point, groundY });
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'flowerbeds:evidence'))) {
            return null;
        }
    }
    if (points.length === 0) return null;

    const stemGeo = new THREE.CylinderGeometry(0.02, 0.026, 1, 5);
    const bloomGeo = new THREE.OctahedronGeometry(1, 0);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x2f6f2f, roughness: 0.88 });
    const bloomPalette = [0xffd166, 0xff7aa2, 0xff8f4d, 0xc7a7ff, 0xfff5f7];
    const bloomMeshes = bloomPalette.map((color) => {
        const mesh = createInstancedMesh(bloomGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.02 }), points.length);
        mesh.castShadow = true;
        return mesh;
    });
    const stemMesh = createInstancedMesh(stemGeo, stemMat, points.length);
    stemMesh.castShadow = true;
    const disposeLocal = () => {
        stemGeo.dispose();
        bloomGeo.dispose();
        stemMat.dispose();
        for (const bloomMesh of bloomMeshes) {
            if (bloomMesh.material && typeof bloomMesh.material.dispose === 'function') {
                bloomMesh.material.dispose();
            }
        }
    };

    const dummy = new THREE.Object3D();
    const counts = new Array(bloomMeshes.length).fill(0);
    for (let i = 0; i < points.length; i++) {
        const { x, z, seed, groundY } = points[i];
        const plantH = 0.16 + seededNoise(x, z, seed * 71 + 13) * 0.42;
        dummy.position.set(x, groundY + plantH * 0.5, z);
        dummy.scale.set(1, plantH, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        stemMesh.setMatrixAt(i, dummy.matrix);

        const bloomScale = 0.06 + seededNoise(x, z, seed * 43 + 29) * 0.12;
        const bloomMeshIndex = Math.min(
            bloomMeshes.length - 1,
            Math.floor(seededNoise(x, z, seed * 19 + 7) * bloomMeshes.length),
        );
        const bloomMesh = bloomMeshes[bloomMeshIndex];
        dummy.position.set(x, groundY + plantH + bloomScale * 0.85, z);
        dummy.scale.setScalar(bloomScale);
        dummy.rotation.set(
            seededNoise(x, z, seed * 31 + 2) * Math.PI * 0.35,
            seededNoise(x, z, seed * 37 + 3) * Math.PI * 2,
            seededNoise(x, z, seed * 41 + 5) * Math.PI * 0.35,
        );
        dummy.updateMatrix();
        bloomMesh.setMatrixAt(counts[bloomMeshIndex], dummy.matrix);
        counts[bloomMeshIndex] += 1;
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'flowerbeds'))) {
            disposeLocal();
            return null;
        }
    }
    stemMesh.instanceMatrix.needsUpdate = true;
    const group = new THREE.Group();
    group.name = 'DecorFlowerbeds';
    group.userData.decorKind = 'flowerbed';
    group.add(stemMesh);
    for (let i = 0; i < bloomMeshes.length; i++) {
        const bloomMesh = bloomMeshes[i];
        bloomMesh.count = counts[i];
        bloomMesh.instanceMatrix.needsUpdate = true;
        group.add(bloomMesh);
    }
    return group;
}

async function buildHedgesGroup(hedgesIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!hedgesIndex) return null;

    const HEDGE_RADIUS_M = 1500;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(hedgesIndex, radiusBounds(centerLat, centerLon, HEDGE_RADIUS_M));
    const stripSegments = [];
    const hedgeModules = [];
    const yieldState = createBuildYieldState();

    for (const entry of candidates) {
        const localPoints = [];
        for (const [lon, lat] of entry.coords) {
            localPoints.push(geoToLocal(lon, lat, anchorLon, anchorLat));
        }
        for (let i = 0; i < localPoints.length - 1; i++) {
            const a = localPoints[i];
            const b = localPoints[i + 1];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const length = Math.hypot(dx, dz);
            if (!Number.isFinite(length) || length < 0.25) continue;
            const midX = (a.x + b.x) * 0.5;
            const midZ = (a.z + b.z) * 0.5;
            const offsetX = midX - centerLocal.x;
            const offsetZ = midZ - centerLocal.z;
            const maxDist = HEDGE_RADIUS_M + length * 0.5;
            if ((offsetX * offsetX + offsetZ * offsetZ) > maxDist * maxDist) continue;
            if (standsOnOrOverCorridor(midX, midZ, NaN, NaN, 0.6)) continue;
            const dirX = dx / length;
            const dirZ = dz / length;
            let moduleCount = Math.max(1, Math.round((length + HEDGE_MODULE_GAP_M) / (HEDGE_MODULE_TARGET_LENGTH_M + HEDGE_MODULE_GAP_M)));
            let moduleLength = (length - HEDGE_MODULE_GAP_M * (moduleCount - 1)) / moduleCount;
            while (moduleCount > 1 && moduleLength < 0.55) {
                moduleCount -= 1;
                moduleLength = (length - HEDGE_MODULE_GAP_M * (moduleCount - 1)) / moduleCount;
            }
            for (let moduleIndex = 0; moduleIndex < moduleCount; moduleIndex++) {
                const offsetAlong = -length * 0.5 + moduleLength * 0.5 + moduleIndex * (moduleLength + HEDGE_MODULE_GAP_M);
                const moduleX = midX + dirX * offsetAlong;
                const moduleZ = midZ + dirZ * offsetAlong;
                const moduleGroundY = terrainBaseY(moduleX, moduleZ);
                if (moduleGroundY === null) continue;
                stripSegments.push({
                    x: moduleX,
                    z: moduleZ,
                    yaw: Math.atan2(dx, dz),
                    length: moduleLength + HEDGE_MODULE_GAP_M,
                    groundY: moduleGroundY,
                });
                hedgeModules.push({
                    x: moduleX,
                    z: moduleZ,
                    yaw: Math.atan2(dx, dz),
                    length: moduleLength + HEDGE_SEGMENT_OVERLAP_M,
                    width: HEDGE_WIDTH_M * (0.96 + seededNoise(moduleX, moduleZ, moduleIndex + 17) * 0.08),
                    height: HEDGE_HEIGHT_M * (0.97 + seededNoise(moduleX, moduleZ, moduleIndex + 53) * 0.06),
                    groundY: moduleGroundY,
                });
            }
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'hedges'))) return null;
        }
    }

    if (stripSegments.length === 0 || hedgeModules.length === 0) return null;

    const stripGeo = new THREE.BoxGeometry(1, 1, 1);
    stripGeo.translate(0, 0.5, 0);
    const stripMat = new THREE.MeshStandardMaterial({
        map: getGrassTexture(),
        color: 0x4e6a3e,
        roughness: 0.95,
    });
    const stripMesh = createInstancedMesh(stripGeo, stripMat, stripSegments.length);
    stripMesh.name = 'DecorHedgeStrips';
    stripMesh.receiveShadow = true;

    const hedgeGeo = new THREE.BoxGeometry(1, 1, 1);
    hedgeGeo.translate(0, 0.5, 0);
    const hedgeMat = new THREE.MeshStandardMaterial({
        map: getHedgeTexture(),
        color: 0x4e6a3e,
        roughness: 0.98,
    });
    const hedgeMesh = createInstancedMesh(hedgeGeo, hedgeMat, hedgeModules.length);
    hedgeMesh.name = 'DecorHedgeBodies';
    hedgeMesh.castShadow = true;
    hedgeMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < stripSegments.length; i++) {
        const { x, z, yaw, length, groundY } = stripSegments[i];
        dummy.position.set(x, groundY + HEDGE_STRIP_Y, z);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(HEDGE_STRIP_WIDTH_M, HEDGE_STRIP_HEIGHT_M, length + HEDGE_SEGMENT_OVERLAP_M);
        dummy.updateMatrix();
        stripMesh.setMatrixAt(i, dummy.matrix);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'hedges'))) {
            stripGeo.dispose();
            stripMat.dispose();
            hedgeGeo.dispose();
            hedgeMat.dispose();
            return null;
        }
    }
    for (let i = 0; i < hedgeModules.length; i++) {
        const { x, z, yaw, width, height, length, groundY } = hedgeModules[i];
        dummy.position.set(x, groundY + 0.012, z);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(width, height, length);
        dummy.updateMatrix();
        hedgeMesh.setMatrixAt(i, dummy.matrix);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'hedges'))) {
            stripGeo.dispose();
            stripMat.dispose();
            hedgeGeo.dispose();
            hedgeMat.dispose();
            return null;
        }
    }
    stripMesh.instanceMatrix.needsUpdate = true;
    hedgeMesh.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.name = 'DecorHedges';
    group.userData.decorKind = 'hedge';
    group.add(stripMesh);
    group.add(hedgeMesh);
    return group;
}

// ─── Surface edging ────────────────────────────────────────────────────────
// Small flat curb band along explicitly finished surface perimeters
// (flowerbeds, paved/tiled areas, sand and playgrounds), straddling the
// boundary between the surface and whatever it meets. Generic OSM grass is a
// terrain material classification, not evidence of a built curb; real street
// and sidewalk curbs are owned by world/curbs.js. Sits above both neighbouring
// surfaces so the seam never z-fights; each qualifying type gets its own tiny
// Y stagger because two adjacent surfaces both emit a band along their shared
// border.
const EDGING_W = 0.14;   // Zagreb's lawn/pavement edging slabs are narrow
const EDGING_Y = GROUND_SURFACE_LEVELS.passiveEdging;
const EDGING_MIN_AREA_M2 = 30;
const EDGING_SLAB_LEN_M = 0.8;   // one texture repeat = one slab

let _edgingTexture = null;

// Irregular worn joint line for the edging slabs — same idea as the curb
// joints: varying darkness/thickness with soft bleed and occasional breaks.
function paintEdgingWornJoint(ctx, len, at, maxThick, baseAlpha, horizontal) {
    for (let i = 0; i < len; i++) {
        if (Math.random() < 0.06) continue;
        const a = baseAlpha * (0.5 + Math.random() * 0.5);
        const thick = 1 + Math.random() * (maxThick - 1);
        const off = at + (Math.random() - 0.5) * 1.4;
        ctx.fillStyle = `rgba(38,36,33,${a.toFixed(2)})`;
        if (horizontal) ctx.fillRect(i, off, 1, thick);
        else ctx.fillRect(off, i, thick, 1);
        ctx.fillStyle = `rgba(38,36,33,${(a * 0.3).toFixed(2)})`;
        if (horizontal) ctx.fillRect(i, off - 1, 1, thick + 2);
        else ctx.fillRect(off - 1, i, thick + 2, 1);
    }
}

// Dark, dirty curb-slab texture: grimy grey base with per-pixel grain,
// scattered darker stains, and a perpendicular joint line at the left edge
// of each repeat so the band reads as elongated slabs laid end to end.
function getEdgingTexture() {
    if (_edgingTexture) return _edgingTexture;
    const W = 128, H = 32;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const data = img.data;
    for (let i = 0; i < W * H; i++) {
        const j = Math.floor((Math.random() - 0.5) * 22);
        data[i * 4 + 0] = 82 + j;
        data[i * 4 + 1] = 79 + j;
        data[i * 4 + 2] = 74 + j;
        data[i * 4 + 3] = 255;
    }
    // ~4% darker grime blotches.
    const stainCount = Math.floor(W * H * 0.04);
    for (let s = 0; s < stainCount; s++) {
        const i = (Math.floor(Math.random() * H) * W + Math.floor(Math.random() * W)) * 4;
        const v = 46 + Math.floor(Math.random() * 18);
        data[i + 0] = v + 3;
        data[i + 1] = v + 1;
        data[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    // Slab joint across the band at the repeat edge, plus dark borders along
    // BOTH long edges so every slab reads outlined against whatever surface
    // it meets. All painted as irregular worn gaps (varying darkness and
    // thickness, soft bleed, occasional breaks) rather than crisp strokes.
    paintEdgingWornJoint(ctx, H, 0.4, 2.2, 0.9, false);
    paintEdgingWornJoint(ctx, W, 0.3, 2.2, 0.85, true);
    paintEdgingWornJoint(ctx, W, H - 2.2, 2.2, 0.85, true);
    _edgingTexture = new THREE.CanvasTexture(canvas);
    _edgingTexture.wrapS = THREE.RepeatWrapping;
    _edgingTexture.wrapT = THREE.ClampToEdgeWrapping;
    _edgingTexture.colorSpace = THREE.SRGBColorSpace;
    _edgingTexture.anisotropy = 4;
    registerShared(_edgingTexture);
    return _edgingTexture;
}

let _edgingMaterial = null;
let _passiveEdgingMaterial = null;
let _fountainRimMaterial = null;

// Darkness and grime are baked into the slab texture itself.
function getEdgingMaterial() {
    if (_edgingMaterial) return _edgingMaterial;
    const claim = publishedDecorSurfaceClaim(
        SURFACE_CLASS.PEDESTRIAN_EDGING,
        'decor-pedestrian-edging',
    );
    _edgingMaterial = authorizeDecorSurfaceMaterial(new THREE.MeshStandardMaterial({
        map: getEdgingTexture(),
        roughness: 0.95,
        ...DECOR_SURFACE_SHARED,
    }), claim);
    registerShared(_edgingMaterial);
    return _edgingMaterial;
}

function getPassiveEdgingMaterial() {
    if (_passiveEdgingMaterial) return _passiveEdgingMaterial;
    const claim = publishedDecorSurfaceClaim(
        SURFACE_CLASS.PASSIVE_EDGING,
        'decor-passive-edging',
    );
    _passiveEdgingMaterial = authorizeDecorSurfaceMaterial(new THREE.MeshStandardMaterial({
        map: getEdgingTexture(),
        roughness: 0.95,
        ...DECOR_SURFACE_SHARED,
    }), claim);
    registerShared(_passiveEdgingMaterial);
    return _passiveEdgingMaterial;
}

function getFountainRimMaterial() {
    if (_fountainRimMaterial) return _fountainRimMaterial;
    const claim = publishedDecorSurfaceClaim(
        SURFACE_CLASS.PEDESTRIAN_EDGING,
        'decor-fountain-rim',
    );
    _fountainRimMaterial = authorizeDecorSurfaceMaterial(new THREE.MeshStandardMaterial({
        map: getEdgingTexture(),
        color: 0xc8c1b3,
        roughness: 0.82,
        metalness: 0.015,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    }), claim);
    registerShared(_fountainRimMaterial);
    return _fountainRimMaterial;
}

// Builds one edging-band mesh along the given local-coordinate rings (arrays
// of {x,z} points, unclosed) at height y. Used by the greenery pipeline above
// and by roads.js to edge stone-paved pedestrian zones. `segmentKeep(mx, mz)`
// optionally vetoes individual band segments by their ring midpoint (roads.js
// drops segments buried inside a sibling pedestrian zone). Caller adds the
// mesh to its group and tags it for eviction.
export function buildSurfaceEdgingMesh(localRings, y, segmentKeep = null, heightAt = null) {
    const verts = [], uvs = [];
    for (const ring of localRings || []) {
        // `false` is distinct from an empty/degenerate result: it means the
        // caller supplied a strict height sampler and at least one required
        // point still lacks evidence. Streaming callers must defer publication
        // instead of accepting a partially built edge.
        if (!appendRingEdging(verts, uvs, ring, y, segmentKeep, heightAt)) return false;
    }
    if (verts.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, getEdgingMaterial());
    mesh.name = 'SurfaceEdging';
    mesh.userData.surfaceType = 'surface-edging';
    markSurfaceClaim(mesh, {
        surfaceClass: SURFACE_CLASS.PEDESTRIAN_EDGING,
        coverageState: SURFACE_COVERAGE_STATE.BUILDING,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'surface-edging',
        sourceId: 'world/decor.js:buildSurfaceEdgingMesh',
    });
    mesh.receiveShadow = true;
    return mesh;
}

function appendRingEdging(
    verts,
    uvs,
    ring,
    y,
    segmentKeep = null,
    heightAt = null,
    width = EDGING_W,
    slabLengthM = EDGING_SLAB_LEN_M,
) {
    const n = ring.length;
    if (n < 3) return true;
    const inner = [], outer = [], arcU = [];
    let cum = 0;
    for (let i = 0; i < n; i++) {
        const prev = ring[(i + n - 1) % n], cur = ring[i], next = ring[(i + 1) % n];
        const e1x = cur.x - prev.x, e1z = cur.z - prev.z;
        const e2x = next.x - cur.x, e2z = next.z - cur.z;
        const l1 = Math.hypot(e1x, e1z) || 1, l2 = Math.hypot(e2x, e2z) || 1;
        const n1x = -e1z / l1, n1z = e1x / l1;
        const n2x = -e2z / l2, n2z = e2x / l2;
        let nx = n1x + n2x, nz = n1z + n2z;
        const nl = Math.hypot(nx, nz);
        if (nl < 1e-6) { nx = n1x; nz = n1z; } else { nx /= nl; nz /= nl; }
        // Miter, clamped so spiky corners don't shoot the band outward.
        const miter = Math.max(0.5, nx * n1x + nz * n1z);
        const half = (width / 2) / miter;
        inner.push([cur.x - nx * half, cur.z - nz * half]);
        outer.push([cur.x + nx * half, cur.z + nz * half]);
        // U in slab units along the ring so joint lines land every
        // EDGING_SLAB_LEN_M metres regardless of vertex spacing.
        if (i > 0) cum += l1;
        arcU.push(cum / slabLengthM);
    }
    const innerY = [];
    const outerY = [];
    for (let i = 0; i < n; i++) {
        const innerGroundY = heightAt ? finiteOrNull(heightAt(inner[i][0], inner[i][1])) : 0;
        const outerGroundY = heightAt ? finiteOrNull(heightAt(outer[i][0], outer[i][1])) : 0;
        if (innerGroundY === null || outerGroundY === null) return false;
        innerY.push(y + innerGroundY);
        outerY.push(y + outerGroundY);
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (segmentKeep && !segmentKeep((ring[i].x + ring[j].x) / 2, (ring[i].z + ring[j].z) / 2)) continue;
        // The closing segment continues U past the last vertex instead of
        // snapping back to 0.
        const uj = j === 0 ? arcU[i] + Math.hypot(ring[0].x - ring[i].x, ring[0].z - ring[i].z) / slabLengthM : arcU[j];
        verts.push(
            inner[i][0], innerY[i], inner[i][1],
            outer[i][0], outerY[i], outer[i][1],
            outer[j][0], outerY[j], outer[j][1],
            inner[i][0], innerY[i], inner[i][1],
            outer[j][0], outerY[j], outer[j][1],
            inner[j][0], innerY[j], inner[j][1],
        );
        uvs.push(
            arcU[i], 0,
            arcU[i], 1,
            uj, 1,
            arcU[i], 0,
            uj, 1,
            uj, 0,
        );
    }
    return true;
}

function appendFountainWall(positions, uvs, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return true;
    const segments = [];
    let distanceM = 0;
    for (let index = 0; index < ring.length; index++) {
        const nextIndex = (index + 1) % ring.length;
        const a = ring[index];
        const b = ring[nextIndex];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!(length > 0.02)) continue;
        const u0 = distanceM / EDGING_SLAB_LEN_M;
        const u1 = (distanceM + length) / EDGING_SLAB_LEN_M;
        const aBottom = terrainPlacedY(a.x, a.z, FOUNTAIN_WALL_BASE_Y);
        const bBottom = terrainPlacedY(b.x, b.z, FOUNTAIN_WALL_BASE_Y);
        const aTop = terrainPlacedY(a.x, a.z, FOUNTAIN_RIM_Y);
        const bTop = terrainPlacedY(b.x, b.z, FOUNTAIN_RIM_Y);
        if ([aBottom, bBottom, aTop, bTop].some((value) => value === null)) {
            return false;
        }
        segments.push({ a, b, aBottom, bBottom, aTop, bTop, u0, u1 });
        distanceM += length;
    }
    for (const { a, b, aBottom, bBottom, aTop, bTop, u0, u1 } of segments) {
        positions.push(
            a.x, aBottom, a.z,
            b.x, bBottom, b.z,
            b.x, bTop, b.z,
            a.x, aBottom, a.z,
            b.x, bTop, b.z,
            a.x, aTop, a.z,
        );
        uvs.push(
            u0, 0,
            u1, 0,
            u1, 1,
            u0, 0,
            u1, 1,
            u0, 1,
        );
    }
    return true;
}

function buildFountainRimMesh(polygons) {
    const positions = [];
    const uvs = [];
    const appendRing = (targetPositions, targetUvs, ring) => {
        if (!appendRingEdging(
            targetPositions,
            targetUvs,
            ring,
            FOUNTAIN_RIM_Y,
            null,
            (x, z) => terrainBaseY(x, z),
            FOUNTAIN_RIM_WIDTH_M,
        )) return false;
        return appendFountainWall(targetPositions, targetUvs, ring);
    };
    for (const polygon of polygons || []) {
        const polygonPositions = [];
        const polygonUvs = [];
        const rings = [polygon.outerRing, ...(polygon.holeRings || [])];
        if (!rings.every((ring) => appendRing(polygonPositions, polygonUvs, ring))) continue;
        for (const value of polygonPositions) positions.push(value);
        for (const value of polygonUvs) uvs.push(value);
    }
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(uvs), 2));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, getFountainRimMaterial());
    mesh.name = 'DecorFountainRims';
    mesh.userData.decorSurfaceType = 'fountain-rim';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

const registeredDecorPaintStyles = new WeakSet();
function decorGroundPaintStyle(type, paint) {
    if (type === 'parking' || type === 'construction') return roadGroundPaintStyle(type, paint);
    if (!registeredDecorPaintStyles.has(paint)) {
        // Road recipes own IDs 1–7. Grass and soil add two immutable pattern
        // layers; the other uses share concrete already in that library.
        roadGroundPaintStyle('parking', paint);
        const concrete = getSidewalkTexture();
        const styles = [
            ['green', 8, getGrassTexture(), GRASS_UV_PER_M, 'landuse-grass', [1, 1, 1]],
            ['forest', 9, getGrassTexture(), GRASS_UV_PER_M, 'landuse-grass', [.62, .78, .62]],
            ['paving', 10, concrete, SIDEWALK_UV_PER_M, 'concrete-path', [1, 1, 1]],
            ['flowerbed', 11, getFlowerbedTexture(), FLOWERBED_UV_PER_M, 'landuse-soil', [1, 1, 1]],
            ['sand', 12, null, 1, null, [.83, .72, .48]],
            ['playground', 13, concrete, SIDEWALK_UV_PER_M, 'concrete-path', [.42, .12, .12]],
            ['fitness', 14, concrete, SIDEWALK_UV_PER_M, 'concrete-path', [.35, .08, .10]],
            // The 14 cm strip is coverage on the actual receiver. Its stone
            // grain uses stable world UVs, independent of ring tessellation.
            ['edging', 15, concrete, 1 / EDGING_SLAB_LEN_M, 'concrete-path', [.7, .7, .68]],
        ];
        for (const [name, id, texture, uvPerM, patternKey, linearColor] of styles) {
            texture?.updateMatrix();
            const e = texture?.matrix.elements;
            paint.registerStyle(`decor-${name}`, { id, revision: 'decor-material-v1',
                surfaceClass: name === 'edging' ? SURFACE_CLASS.PASSIVE_EDGING : SURFACE_CLASS.PASSIVE_LANDUSE,
                roughness: .95, metalness: 0, normalInfluence: 0, linearColor,
                albedoMap: texture ? { key: patternKey,
                    revision: patternKey === 'concrete-path' ? 'ground-texture-v2' : 'decor-texture-v1',
                    uvTransform: [e[0] * uvPerM, e[3] * uvPerM, e[6], e[1] * uvPerM, e[4] * uvPerM, e[7]],
                } : null,
            }, texture);
        }
        registeredDecorPaintStyles.add(paint);
    }
    return { key: `decor-${type}`, revision: 'decor-material-v1' };
}

async function buildGreeneryGroup(greeneryIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!greeneryIndex) return null;

    const COLORS = {
        green:        0x315732,
        playground:   0x6b1f1f,
        fitness:      0x5a1518,
        sand:         0xd4b87a,
        water:        0x3a7ebf,
        parking:      0x3a3a3a,
        // Pavement / sidewalk landuse — was 0x8a8a8a, dropped to a
        // darker grey so it sits closer to the asphalt surface than to
        // the sky. The previous value read as near-white under the
        // cab's combined ambient + sun + fill lighting.
        paving:       0x5e6266,
        construction: 0xa0622a,
    };
    // Most OSM landuse sits above the grey catch-all ground but below road
    // surfaces. Parking and construction are the exceptions: they are road
    // surfaces themselves and retain ownership when road tiles stream in.

    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const candidatePolygons = querySpatialIndex(greeneryIndex, radiusBounds(centerLat, centerLon, GREENERY_RADIUS_M));
    const roadSurfaceIndex = getDecorRoadSurfaceIndex();
    // Greenery window center in local metres (same projection as cleanRing) —
    // drawn surfaces are clipped to this square in terrain worlds so the
    // refinement budget below is spent on visible area only.
    const windowCenterX = (centerLon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
    const windowCenterZ = -(centerLat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M;
    const windowHalfM = GREENERY_RADIUS_M + GREENERY_CLIP_MARGIN_M;
    const groundPaintOwners = new Map();
    const groundPaintLayerIds = new Set();
    const hiddenPaintLayers = hiddenInspectionLayerIds();

    const buckets = {};
    const forestPolygons = [];
    const flowerbedPolygons = [];
    const waterPolygons = [];
    const naturalWaterPolygons = [];
    const fountainPolygons = [];
    let parkingMarkingVertices = [];
    let parkingFormationMarkingVertices = [];
    let receiverParkingMarkingVertices = [];
    const edgingVerts = [];
    const edgingUvs = [];
    const yieldState = createBuildYieldState();
    const appendPaintOwner = async (type, sourceId, polygons) => {
        const style = decorGroundPaintStyle(type, groundPaint);
        const steps = createDecorGroundPaintOwnerSteps({ type, sourceId, polygons,
            receiver: groundPaint.receiver, materialKey: style.key, materialRevision: style.revision });
        let owner;
        try {
            for (;;) {
                const next = steps.next();
                if (next.done) { owner = next.value; break; }
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:ground-paint'))) return false;
            }
        } finally { steps.return(); }
        const previous = groundPaintOwners.get(owner.owner);
        if (previous && previous.canonical !== owner.canonical) throw new Error('Decor paint source identity collision');
        groundPaintOwners.set(owner.owner, owner);
        return maybeYieldBuild(yieldState, shouldCancel, 'greenery:ground-paint');
    };
    const parkingRoadFormation = terrainReference?.roadFormation || null;
    let parkingFormationProfiles = null;
    let parkingFormationRevision = null;

    const currentParkingFormationProfiles = () => {
        if (!parkingRoadFormation
            || typeof parkingRoadFormation.getSurfaceProfiles !== 'function') return [];
        if (parkingFormationProfiles == null
            || parkingFormationRevision !== parkingRoadFormation.revision) {
            parkingFormationProfiles = parkingRoadFormation.getSurfaceProfiles();
            parkingFormationRevision = parkingRoadFormation.revision;
        }
        return parkingFormationProfiles;
    };

    for (const entry of candidatePolygons) {
        const { type, semantic, rings, minLat, maxLat, minLon, maxLon } = entry;
        if (!rings || rings.length === 0) continue;
        const outerRing = cleanRing(rings[0], anchorLon, anchorLat, cosLat);
        if (outerRing.length < 3) continue;

        const holeRings = [];
        for (let h = 1; h < rings.length; h++) {
            const cleanHole = cleanRing(rings[h], anchorLon, anchorLat, cosLat);
            if (cleanHole.length < 3) continue;
            if (Math.abs(signedRingArea(cleanHole)) < 0.5 || ringSelfIntersects(cleanHole)) continue;
            holeRings.push(cleanHole);
        }

        const isFountainSurface = semantic === 'fountain';
        const surfaceType = isFountainSurface ? 'fountain' : normaliseSurfaceType(type);
        // The canonical layer owns sea level and shoreline masks, while this
        // layer owns terrain-relative rivers and lakes. Wait for the sea
        // classifier, then suppress only a polygon it actually covers. A sea
        // polygon elsewhere in the fetch window must not erase Jadro or any
        // other river merely because the city is coastal.
        if (surfaceType === 'water' && getLocation().water) {
            if (!isMappedSeaReady()) continue;
            if (mappedSeaCoversDecorWaterPolygon(outerRing, isPointInMappedSea)) continue;
        }
        const polygonArea = polygonAreaM2({ outerRing, holeRings });
        const minimumAreaM2 = isFountainSurface ? 0.05 : 0.5;
        if (polygonArea < minimumAreaM2 || ringSelfIntersects(outerRing)) continue;
        if (surfaceType === 'forest') forestPolygons.push({ outerRing, holeRings });
        if (surfaceType === 'flowerbed') flowerbedPolygons.push({ outerRing, holeRings });
        const compositeSurface = !!groundPaint && entry.groundPaintEligible;
        // Decorative bands follow source boundaries, including holes. Only
        // explicit unsupported vertical surfaces retain the draped mesh path.
        const edgingTypeIdx = decorSurfaceEdgingTypeIndex(surfaceType);
        const hasEdging = edgingTypeIdx >= 0 && Math.abs(signedRingArea(outerRing)) >= EDGING_MIN_AREA_M2;
        if (hasEdging && compositeSurface) {
            groundPaintLayerIds.add('surface-edging');
            if (!hiddenPaintLayers.has('surface-edging')) {
                for (const polygons of decorSurfaceEdgingPolygonsSteps([outerRing, ...holeRings])) {
                    if (!(await appendPaintOwner('edging', entry.sourceId, polygons))) return null;
                }
            }
        } else if (hasEdging) {
            const edgingY = EDGING_Y + edgingTypeIdx * 0.0015;
            const heightAt = terrainReference
                ? (x, z) => terrainBaseY(x, z)
                : null;
            const polygonEdgingVerts = [];
            const polygonEdgingUvs = [];
            let edgingReady = appendRingEdging(
                polygonEdgingVerts,
                polygonEdgingUvs,
                outerRing,
                edgingY,
                null,
                heightAt,
            );
            for (const holeRing of holeRings) {
                if (!edgingReady) break;
                edgingReady = appendRingEdging(
                    polygonEdgingVerts,
                    polygonEdgingUvs,
                    holeRing,
                    edgingY,
                    null,
                    heightAt,
                );
            }
            if (edgingReady) {
                for (const value of polygonEdgingVerts) edgingVerts.push(value);
                for (const value of polygonEdgingUvs) edgingUvs.push(value);
            }
        }

        // Terrain worlds triangulate only the window's share of the polygon.
        // The containment test further down still uses the ORIGINAL rings, so
        // clipping can never draw outside the source polygon; it only stops a
        // mountain-sized polygon from starving the refinement budget with
        // fog-hidden area (the floating-slab bug).
        const drawnOuter = terrainReference
            ? clipRingToWindow(outerRing, windowCenterX, windowCenterZ, windowHalfM)
            : outerRing;
        if (drawnOuter.length < 3) continue;
        const drawnHoles = terrainReference
            ? holeRings
                .map((hole) => clipRingToWindow(hole, windowCenterX, windowCenterZ, windowHalfM))
                .filter((hole) => hole.length >= 3)
            : holeRings;
        const drawnArea = terrainReference
            ? polygonAreaM2({ outerRing: drawnOuter, holeRings: drawnHoles })
            : polygonArea;
        if (drawnArea < minimumAreaM2) continue;

        if (surfaceType === 'parking'
            && !(await waitForPublishedRoadFormation(
                parkingRoadFormation,
                yieldState,
                shouldCancel,
            ))) return null;

        if (compositeSurface) {
            const layerId = `landuse-${safeSurfaceId(surfaceType)}`;
            groundPaintLayerIds.add(layerId);
            if (!hiddenPaintLayers.has(layerId)
                && !(await appendPaintOwner(surfaceType, entry.sourceId, [[outerRing, ...holeRings]]))) return null;
            if (surfaceType === 'parking') {
                const layouts = buildParkingLayouts(outerRing, holeRings,
                    { minLat, maxLat, minLon, maxLon }, roadSurfaceIndex);
                appendParkingLayoutsMarkings(receiverParkingMarkingVertices, layouts);
            }
            // Paint samples the existing receiver. The old refined/draped
            // colour sheet never supplied player support or collider geometry.
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:ground-paint'))) return null;
            continue;
        }

        if (terrainReference) {
            let boundaryReady = true;
            for (const ring of [drawnOuter, ...drawnHoles]) {
                for (const point of ring) {
                    if (terrainBaseY(point.x, point.z) === null) {
                        boundaryReady = false;
                        break;
                    }
                    if (!(await maybeYieldBuild(
                        yieldState,
                        shouldCancel,
                        'greenery:evidence',
                    ))) return null;
                }
                if (!boundaryReady) break;
            }
            if (!boundaryReady) continue;
        }

        const shape = new THREE.Shape();
        let first = true;
        for (const p of drawnOuter) {
            if (first) { shape.moveTo(p.x, p.z); first = false; }
            else shape.lineTo(p.x, p.z);
        }
        for (const cleanHole of drawnHoles) {
            const hole = new THREE.Path();
            let hFirst = true;
            for (const p of cleanHole) {
                if (hFirst) { hole.moveTo(p.x, p.z); hFirst = false; }
                else hole.lineTo(p.x, p.z);
            }
            shape.holes.push(hole);
        }

        if (!(await maybeYieldBuild(
            yieldState,
            shouldCancel,
            'greenery:triangulate:prepare',
        ))) return null;
        const geo = new THREE.ShapeGeometry(shape);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:triangulate'))) {
            geo.dispose();
            return null;
        }
        const pos = geo.getAttribute('position');
        const sourcePoints = [];
        for (let index = 0; index < pos.count; index++) {
            sourcePoints.push({ x: pos.getX(index), z: pos.getY(index) });
            if (((index + 1) % DECOR_SURFACE_SOURCE_CHUNK_ITEMS) === 0
                && !(await maybeYieldBuild(
                    yieldState,
                    shouldCancel,
                    'greenery:source-points',
                ))) {
                geo.dispose();
                return null;
            }
        }
        const sourceTriangles = [];
        const index = geo.getIndex();
        if (index) {
            for (let i = 0; i + 2 < index.count; i += 3) {
                sourceTriangles.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
                if ((((i / 3) + 1) % DECOR_SURFACE_SOURCE_CHUNK_ITEMS) === 0
                    && !(await maybeYieldBuild(
                        yieldState,
                        shouldCancel,
                        'greenery:source-triangles',
                    ))) {
                    geo.dispose();
                    return null;
                }
            }
        } else {
            for (let i = 0; i + 2 < sourcePoints.length; i += 3) {
                sourceTriangles.push([i, i + 1, i + 2]);
                if ((((i / 3) + 1) % DECOR_SURFACE_SOURCE_CHUNK_ITEMS) === 0
                    && !(await maybeYieldBuild(
                        yieldState,
                        shouldCancel,
                        'greenery:source-triangles',
                    ))) {
                    geo.dispose();
                    return null;
                }
            }
        }
        let refined = { points: sourcePoints, triangles: sourceTriangles };
        if (terrainReference) {
            const refinementSteps = refineTriangulatedSurfaceSteps(
                sourcePoints,
                sourceTriangles,
                surfaceRefinementEdgeForArea(drawnArea, {
                    baseEdgeM: Math.max(4, Math.min(12, terrainReference.surfaceStepM || 8)),
                    maxTriangles: MAX_GREENERY_SURFACE_TRIANGLES_PER_POLYGON_TERRAIN,
                    maxEdgeM: GREENERY_SURFACE_MAX_EDGE_TERRAIN_M,
                }),
                MAX_GREENERY_SURFACE_TRIANGLES_PER_POLYGON_TERRAIN,
                { trianglesPerYield: DECOR_SURFACE_REFINEMENT_CHUNK_TRIANGLES },
            );
            let refinement = refinementSteps.next();
            while (!refinement.done) {
                if (!(await maybeYieldBuild(
                    yieldState,
                    shouldCancel,
                    'greenery:refinement',
                ))) {
                    geo.dispose();
                    return null;
                }
                refinement = refinementSteps.next();
            }
            refined = refinement.value;
        }
        // Evidence placement with `preferRoadSurface` performs an indexed polygon
        // lookup and a formation projection for every vertex. Most parking lots
        // are nowhere near engineered road profiles. Reject those once per
        // polygon; any possible bounds overlap retains the exact old path.
        let parkingUsesFormation = false;
        // getSurfaceProfiles() is a current-generation query. Calling it while
        // streamed roads are dirty synchronously completes the whole formation
        // build; that 216 ms wait was then charged to the first innocent
        // terrain-drape sample below. Roads already own the cooperative build,
        // so wait before the INITIAL broad phase as well as on resumed slices.
        if (surfaceType === 'parking') {
            if (!(await waitForPublishedRoadFormation(
                parkingRoadFormation,
                yieldState,
                shouldCancel,
            ))) {
                geo.dispose();
                return null;
            }
            parkingUsesFormation = parkingMayOverlapRoadFormation(
                outerRing,
                currentParkingFormationProfiles(),
            );
        }
        const verts = [];
        let surfaceReady = true;
        let sampledFormationRevision = surfaceType === 'parking'
            ? parkingRoadFormation?.revision ?? null
            : null;
        for (let triangleIndex = 0; triangleIndex < refined.triangles.length;) {
            if (surfaceType === 'parking') {
                if (parkingRoadFormation?.hasPendingBuild?.() === true
                    && !(await waitForPublishedRoadFormation(
                        parkingRoadFormation,
                        yieldState,
                        shouldCancel,
                    ))) {
                    geo.dispose();
                    return null;
                }
                const currentRevision = parkingRoadFormation?.revision ?? null;
                if (currentRevision !== sampledFormationRevision) {
                    sampledFormationRevision = currentRevision;
                    parkingUsesFormation = parkingMayOverlapRoadFormation(
                        outerRing,
                        currentParkingFormationProfiles(),
                    );
                    verts.length = 0;
                    surfaceReady = true;
                    triangleIndex = 0;
                }
            }
            const triangle = refined.triangles[triangleIndex];
            triangleIndex += 1;
            const a = refined.points[triangle[0]];
            const b = refined.points[triangle[1]];
            const c = refined.points[triangle[2]];
            const ax = a.x, az = a.z;
            const bx = b.x, bz = b.z;
            const cx = c.x, cz = c.z;
            const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
            if (area < 0.02) continue;
            const mx = (ax + bx + cx) / 3;
            const mz = (az + bz + cz) / 3;
            if (!pointInPolygon(mx, mz, outerRing, holeRings)) continue;
            const ay = decorSurfaceYAt(surfaceType, ax, az, parkingUsesFormation);
            const by = decorSurfaceYAt(surfaceType, bx, bz, parkingUsesFormation);
            const cy = decorSurfaceYAt(surfaceType, cx, cz, parkingUsesFormation);
            if (ay === null || by === null || cy === null) {
                surfaceReady = false;
                break;
            }
            verts.push(
                ax, ay, az,
                bx, by, bz,
                cx, cy, cz,
            );
            if (!(await maybeYieldBuild(
                yieldState,
                shouldCancel,
                'greenery:terrain-drape',
            ))) {
                geo.dispose();
                return null;
            }
        }
        geo.dispose();
        if (!surfaceReady || verts.length === 0) continue;

        if (surfaceType === 'water') {
            const polygon = { outerRing, holeRings };
            waterPolygons.push(polygon);
            naturalWaterPolygons.push(polygon);
        }
        if (surfaceType === 'fountain') {
            const polygon = { outerRing, holeRings, sourceId: entry.sourceId };
            waterPolygons.push(polygon);
            fountainPolygons.push(polygon);
        }

        if (!buckets[surfaceType]) buckets[surfaceType] = [];
        const surface = { positions: new Float32Array(verts) };
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:buffer'))) return null;
        if (surfaceType === 'parking') {
            surface.uvs = buildParkingSurfaceUvs(surface.positions, outerRing);
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:parking-uv'))) return null;
            const parkingLayouts = buildParkingLayouts(
                outerRing,
                holeRings,
                { minLat, maxLat, minLon, maxLon },
                roadSurfaceIndex
            );
            if (!(await maybeYieldBuild(
                yieldState,
                shouldCancel,
                'greenery:parking-layout',
            ))) return null;
            appendParkingLayoutsMarkings(
                parkingUsesFormation
                    ? parkingFormationMarkingVertices
                    : parkingMarkingVertices,
                parkingLayouts,
            );
            if (!(await maybeYieldBuild(
                yieldState,
                shouldCancel,
                'greenery:parking-markings',
            ))) return null;
        }
        buckets[surfaceType].push(surface);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:surface'))) return null;
    }

    let parkingProjectionUsage = null;
    if (receiverParkingMarkingVertices.length > 0) {
        const steps = projectReceiverDetailSteps({ vertices: receiverParkingMarkingVertices,
            originX: windowCenterX, originZ: windowCenterZ,
            receiverTriangles: parkingReceiverTriangles, isCurrent: () => !shouldCancel() });
        try {
            for (;;) {
                const next = steps.next();
                if (next.done) {
                    receiverParkingMarkingVertices = next.value.positions;
                    parkingProjectionUsage = next.value.usage;
                    break;
                }
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:receiver-marking-project'))) return null;
            }
        } finally { steps.return(); }
    }

    if (terrainReference) {
        // The polygon loop can span many frames after its per-parking readiness
        // checks. Re-check immediately before the later batch of road-height
        // samples so a newly arrived road tile cannot turn this drape into a
        // synchronous formation rebuild.
        if (parkingFormationMarkingVertices.length > 0
            && !(await waitForPublishedRoadFormation(
                parkingRoadFormation,
                yieldState,
                shouldCancel,
            ))) return null;
        const drapeParkingMarkings = async (vertices, preferRoadSurface) => {
            const draped = [];
            const drapeLabel = preferRoadSurface
                ? 'greenery:marking-drape:formation'
                : 'greenery:marking-drape:terrain';
            const needsFormation = preferRoadSurface;
            let sampledFormationRevision = needsFormation
                ? parkingRoadFormation?.revision ?? null
                : null;
            const trianglesPerChunk = Math.max(
                1,
                Math.floor(DECOR_MARKING_DRAPE_CHUNK_VERTICES / 3),
            );
            const valuesPerChunk = trianglesPerChunk * 9;
            for (let start = 0; start < vertices.length;) {
                // This pass spans many animation frames. A road tile can dirty
                // the shared formation after the readiness check above; the
                // next placement query would then synchronously finish that
                // generation (measured at 148-217 ms for one marking vertex).
                // Wait at every road-owned chunk boundary and restart into the
                // detached output if its immutable generation changed, so the
                // published mesh never mixes old and new road heights.
                if (needsFormation) {
                    if (!(await waitForPublishedRoadFormation(
                        parkingRoadFormation,
                        yieldState,
                        shouldCancel,
                    ))) return null;
                    const currentRevision = parkingRoadFormation?.revision ?? null;
                    if (currentRevision !== sampledFormationRevision) {
                        sampledFormationRevision = currentRevision;
                        draped.length = 0;
                        start = 0;
                    }
                }
                const end = Math.min(vertices.length, start + valuesPerChunk);
                for (let i = start; i + 8 < end; i += 9) {
                    const triangle = [];
                    let triangleReady = true;
                    for (let vertex = i; vertex < i + 9; vertex += 3) {
                        const y = terrainPlacedY(
                            vertices[vertex],
                            vertices[vertex + 2],
                            vertices[vertex + 1],
                            preferRoadSurface,
                        );
                        if (y === null) {
                            triangleReady = false;
                            break;
                        }
                        triangle.push(vertices[vertex], y, vertices[vertex + 2]);
                    }
                    if (triangleReady) draped.push(...triangle);
                }
                start = end;
                if (!(await maybeYieldBuild(
                    yieldState,
                    shouldCancel,
                    drapeLabel,
                ))) return null;
            }
            return draped;
        };
        parkingMarkingVertices = await drapeParkingMarkings(
            parkingMarkingVertices,
            false,
        );
        if (!parkingMarkingVertices) return null;
        parkingFormationMarkingVertices = await drapeParkingMarkings(
            parkingFormationMarkingVertices,
            true,
        );
        if (!parkingFormationMarkingVertices) return null;
    }
    // Keep one marking mesh/draw call, local to the same storage origin as the
    // projected stripes. Subtract in double precision before Float32 storage;
    // render-origin rebasing cannot restore geometry rounded before rendering.
    for (let index = 0; index < parkingMarkingVertices.length; index += 3) {
        parkingMarkingVertices[index] -= windowCenterX;
        parkingMarkingVertices[index + 2] -= windowCenterZ;
        if ((index + 3) % DECOR_MERGE_COPY_CHUNK_VALUES === 0
            && !(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:marking-localize'))) return null;
    }
    // Ordering is immaterial for opaque paint, and a loop avoids the
    // argument-count limit of push(...largeArray).
    for (
        let start = 0;
        start < parkingFormationMarkingVertices.length;
        start += DECOR_MERGE_COPY_CHUNK_VALUES
    ) {
        const end = Math.min(
            parkingFormationMarkingVertices.length,
            start + DECOR_MERGE_COPY_CHUNK_VALUES,
        );
        for (let index = start; index < end; index++) {
            const origin = index % 3 === 0 ? windowCenterX : index % 3 === 2 ? windowCenterZ : 0;
            parkingMarkingVertices.push(parkingFormationMarkingVertices[index] - origin);
        }
        if (!(await maybeYieldBuild(
            yieldState,
            shouldCancel,
            'greenery:marking-merge',
        ))) return null;
    }
    for (let index = 0; index < receiverParkingMarkingVertices.length; index++) {
        parkingMarkingVertices.push(receiverParkingMarkingVertices[index]);
        if ((index + 1) % DECOR_MERGE_COPY_CHUNK_VALUES === 0
            && !(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:receiver-marking-merge'))) return null;
    }

    const group = new THREE.Group();
    group.userData.parkingProjectionUsage = parkingProjectionUsage;
    const disposeGreeneryBuild = () => {
        disposeGroup(group);
    };
    group.name = 'DecorGreenery';
    if (edgingVerts.length > 0) {
        const edgingGeo = new THREE.BufferGeometry();
        edgingGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgingVerts, 3));
        edgingGeo.setAttribute('uv', new THREE.Float32BufferAttribute(edgingUvs, 2));
        edgingGeo.computeVertexNormals();
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:edging'))) {
            edgingGeo.dispose();
            disposeGreeneryBuild();
            return null;
        }
        const edgingMesh = new THREE.Mesh(edgingGeo, getPassiveEdgingMaterial());
        edgingMesh.name = 'SurfaceEdging';
        edgingMesh.userData.surfaceType = 'surface-edging';
        markSurfaceClaim(edgingMesh, {
            surfaceClass: SURFACE_CLASS.PASSIVE_EDGING,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            verticalBand: 'ground',
            ownerId: 'decor-passive-edging',
            sourceId: 'world/decor.js',
        });
        edgingMesh.receiveShadow = true;
        group.add(edgingMesh);
    }
    const waterMats = [];
    for (const [type, surfaces] of Object.entries(buckets)) {
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:bucket'))) {
            disposeGreeneryBuild();
            return null;
        }
        const totalVerts = surfaces.reduce((s, surface) => s + surface.positions.length / 3, 0);
        const merged = new Float32Array(totalVerts * 3);
        const mergedUvs = type === 'parking' ? new Float32Array(totalVerts * 2) : null;
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:alloc'))) {
            disposeGreeneryBuild();
            return null;
        }
        let positionOffset = 0;
        let uvOffset = 0;
        for (const surface of surfaces) {
            for (
                let sourceOffset = 0;
                sourceOffset < surface.positions.length;
                sourceOffset += DECOR_MERGE_COPY_CHUNK_VALUES
            ) {
                const end = Math.min(
                    surface.positions.length,
                    sourceOffset + DECOR_MERGE_COPY_CHUNK_VALUES,
                );
                merged.set(
                    surface.positions.subarray(sourceOffset, end),
                    positionOffset + sourceOffset,
                );
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:concat'))) {
                    disposeGreeneryBuild();
                    return null;
                }
            }
            positionOffset += surface.positions.length;
            if (mergedUvs) {
                if (surface.uvs) {
                    for (
                        let sourceOffset = 0;
                        sourceOffset < surface.uvs.length;
                        sourceOffset += DECOR_MERGE_COPY_CHUNK_VALUES
                    ) {
                        const end = Math.min(
                            surface.uvs.length,
                            sourceOffset + DECOR_MERGE_COPY_CHUNK_VALUES,
                        );
                        mergedUvs.set(
                            surface.uvs.subarray(sourceOffset, end),
                            uvOffset + sourceOffset,
                        );
                        if (!(await maybeYieldBuild(
                            yieldState,
                            shouldCancel,
                            'greenery:concat',
                        ))) {
                            disposeGreeneryBuild();
                            return null;
                        }
                    }
                    uvOffset += surface.uvs.length;
                } else {
                    const sourceValuesPerChunk = Math.max(
                        3,
                        DECOR_MERGE_COPY_CHUNK_VALUES
                            - (DECOR_MERGE_COPY_CHUNK_VALUES % 3),
                    );
                    for (
                        let sourceOffset = 0;
                        sourceOffset < surface.positions.length;
                        sourceOffset += sourceValuesPerChunk
                    ) {
                        const end = Math.min(
                            surface.positions.length,
                            sourceOffset + sourceValuesPerChunk,
                        );
                        for (let i = sourceOffset; i < end; i += 3) {
                            mergedUvs[uvOffset++] = surface.positions[i] * PARKING_UV_PER_M;
                            mergedUvs[uvOffset++] = surface.positions[i + 2] * PARKING_UV_PER_M;
                        }
                        if (!(await maybeYieldBuild(
                            yieldState,
                            shouldCancel,
                            'greenery:concat',
                        ))) {
                            disposeGreeneryBuild();
                            return null;
                        }
                    }
                }
            }
        }
        const mergedGeo = new THREE.BufferGeometry();
        const cancelMergedBuild = () => {
            // The geometry is not owned by `group` until the mesh is published,
            // so cancellation during normals/UV finalization must release it
            // explicitly instead of relying on disposeGreeneryBuild().
            mergedGeo.dispose();
            disposeGreeneryBuild();
            return null;
        };
        mergedGeo.setAttribute('position', new THREE.Float32BufferAttribute(merged, 3));
        // computeVertexNormals() over every green surface in the decor radius was
        // 71 ms of a 171 ms step, and one call cannot be interrupted. The merge is
        // non-indexed, so each triangle owns its vertices and a slice of triangles
        // computes exactly what the whole buffer would — see core/flat-normals.js.
        const mergedNormals = new Float32Array(merged.length);
        const totalTriangles = triangleCount(merged);
        for (let triangle = 0; triangle < totalTriangles; triangle += DECOR_NORMAL_CHUNK_TRIS) {
            const endTriangle = Math.min(
                totalTriangles,
                triangle + DECOR_NORMAL_CHUNK_TRIS,
            );
            computeFlatNormalsRange(
                merged,
                mergedNormals,
                triangle,
                endTriangle,
            );
            // The merge is non-indexed, so each slice owns complete normals.
            // Normalize it before yielding instead of re-walking the entire
            // buffer in one uninterruptible final pass.
            normalizeNormals(mergedNormals.subarray(triangle * 9, endTriangle * 9));
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:normals'))) {
                return cancelMergedBuild();
            }
        }
        mergedGeo.setAttribute('normal', new THREE.Float32BufferAttribute(mergedNormals, 3));
        const createWorldUvs = async (uvPerM) => {
            const uvs = new Float32Array(totalVerts * 2);
            const verticesPerChunk = Math.max(
                1,
                Math.floor(DECOR_MERGE_COPY_CHUNK_VALUES / 3),
            );
            for (let start = 0; start < totalVerts; start += verticesPerChunk) {
                const end = Math.min(totalVerts, start + verticesPerChunk);
                for (let i = start; i < end; i++) {
                    uvs[i * 2] = merged[i * 3] * uvPerM;
                    uvs[i * 2 + 1] = merged[i * 3 + 2] * uvPerM;
                }
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:uv'))) {
                    return null;
                }
            }
            return uvs;
        };
        let mat;
        if (type === 'paving') {
            // Wear the shared concrete texture, with UVs taken from world
            // XZ in tile units so the image stays anchored in world space.
            const uvs = await createWorldUvs(SIDEWALK_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getSidewalkTexture(),
                roughness: 0.9,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'green') {
            // Procedural grass texture, UVs in world XZ so adjacent green
            // polygons line up seamlessly across their shared edges.
            const uvs = await createWorldUvs(GRASS_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getGrassTexture(),
                roughness: 0.95,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'forest') {
            const uvs = await createWorldUvs(GRASS_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getGrassTexture(),
                color: 0x284628,
                roughness: 0.95,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'flowerbed') {
            const uvs = await createWorldUvs(FLOWERBED_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getFlowerbedTexture(),
                roughness: 0.92,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'construction') {
            // Torn-up earth/gravel for active construction sites — replaces
            // the previous flat orange wash with the procedural dirt+pebbles.
            const uvs = await createWorldUvs(GRAVEL_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getGravelTexture(),
                roughness: 0.95,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'parking') {
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(mergedUvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getParkingTexture(),
                roughness: 0.9,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'playground' || type === 'fitness') {
            // Dark-red rubberised sport surface — playgrounds and outdoor
            // fitness stations use the same granular mat feel, with fitness
            // stations pushed a touch darker so they read more like tartan.
            const uvs = await createWorldUvs(SIDEWALK_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            mat = new THREE.MeshStandardMaterial({
                map: getSidewalkTexture(),
                color: COLORS[type],
                roughness: 0.95,
                ...DECOR_SURFACE_SHARED,
            });
        } else if (type === 'water' || type === 'fountain') {
            const uvs = await createWorldUvs(WATER_UV_PER_M);
            if (!uvs) return cancelMergedBuild();
            mergedGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            const waterResourcesReady = await prepareWaterMaterialResourcesCooperatively({
                onChunk: (phase) => maybeYieldBuild(
                    yieldState,
                    shouldCancel,
                    `greenery:water-texture:${phase}`,
                ),
            });
            if (!waterResourcesReady) return cancelMergedBuild();
            mat = createWaterMaterial({
                profile: type === 'fountain' ? 'fountain' : 'sheltered',
                ...DECOR_SURFACE_SHARED,
            });
            waterMats.push(mat);
        } else {
            mat = new THREE.MeshStandardMaterial({
                color: COLORS[type] || 0x4a7c3f,
                roughness: 0.9,
                ...DECOR_SURFACE_SHARED,
            });
        }
        if (!(await maybeYieldBuild(
            yieldState,
            shouldCancel,
            `greenery:material:${type}`,
        ))) {
            mat.dispose();
            return cancelMergedBuild();
        }
        const surfaceClass = type === 'parking'
            ? SURFACE_CLASS.PARKING
            : type === 'construction'
                ? SURFACE_CLASS.CONSTRUCTION
                : type === 'water' || type === 'fountain'
                    ? SURFACE_CLASS.WATER
                    : SURFACE_CLASS.PASSIVE_LANDUSE;
        const isFirmSurface = surfaceClass === SURFACE_CLASS.PARKING
            || surfaceClass === SURFACE_CLASS.CONSTRUCTION;
        const isWaterReplacement = surfaceClass === SURFACE_CLASS.WATER;
        const surfaceClaim = publishedDecorSurfaceClaim(
            surfaceClass,
            `decor-surface:${type}`,
            {
                supportReady: isFirmSurface,
                cutsBackstop: isFirmSurface || isWaterReplacement,
            },
        );
        authorizeDecorSurfaceMaterial(mat, surfaceClaim);
        const mesh = new THREE.Mesh(mergedGeo, mat);
        mesh.name = `DecorSurface:${type}`;
        mesh.userData.decorSurfaceType = type;
        markSurfaceClaim(mesh, surfaceClaim);
        mesh.receiveShadow = true;
        if (type === 'water' || type === 'fountain') mesh.renderOrder = DECOR_WATER_RENDER_ORDER;
        if (type === 'construction') mesh.renderOrder = DECOR_CONSTRUCTION_RENDER_ORDER;
        if (type === 'parking') mesh.renderOrder = SURFACE_RENDER_ORDER.PARKING;
        group.add(mesh);
        if (!(await maybeYieldBuild(
            yieldState,
            shouldCancel,
            `greenery:publication:${type}`,
        ))) {
            disposeGreeneryBuild();
            return null;
        }
        if (type === 'water') {
            // A terrain-draped river is a surface overlay, not a flat-bottomed
            // excavation. The legacy Y=0 stencil silhouette only applies to
            // the flat model world; using it over variable DGU terrain opened
            // a viewpoint-dependent hole into the void.
            if (!terrainReference) {
                const cutout = createWaterGroundCutoutMesh(mergedGeo, {
                    name: 'DecorWaterGroundCutout',
                    ownerId: 'decor-water-cutout',
                    replacementClaim: surfaceClaim,
                });
                if (cutout) {
                    group.add(cutout);
                }
            }
            if (!(await maybeYieldBuild(
                yieldState,
                shouldCancel,
                `greenery:cutout:${type}`,
            ))) {
                disposeGreeneryBuild();
                return null;
            }
        }
    }
    if (parkingMarkingVertices.length > 0) {
        const bufferSteps = prepareFlatSurfaceBuffersSteps(parkingMarkingVertices, DECOR_NORMAL_CHUNK_TRIS);
        let markingBuffers;
        try {
            while (true) {
                const step = bufferSteps.next();
                if (step.done) { markingBuffers = step.value; break; }
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:markings'))) {
                    disposeGreeneryBuild();
                    return null;
                }
            }
        } finally { bufferSteps.return(); }
        const markingGeometry = new THREE.BufferGeometry();
        markingGeometry.setAttribute('position', new THREE.BufferAttribute(markingBuffers.positions, 3));
        markingGeometry.setAttribute('normal', new THREE.BufferAttribute(markingBuffers.normals, 3));
        // Painted bays are part of the same draped surface as the asphalt under
        // them, so they must answer the formation mask too. Without this they
        // outlived the parking lot they belong to: the tarmac was discarded over
        // an open cut and the white stripes stayed, floating.
        const markingClaim = publishedDecorSurfaceClaim(
            SURFACE_CLASS.PARKING_MARKING,
            'decor-parking-markings',
        );
        const markingMaterial = authorizeDecorSurfaceMaterial(
            new THREE.MeshStandardMaterial({
                color: 0xd9d7cf,
                roughness: 0.98,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -3,
                polygonOffsetUnits: -3,
            }),
            markingClaim,
        );
        groundPaint?.bindMaterial(markingMaterial, markingClaim);
        const markingMesh = new THREE.Mesh(markingGeometry, markingMaterial);
        markingMesh.position.set(windowCenterX, 0, windowCenterZ);
        markingMesh.name = 'DecorParkingMarkings';
        markSurfaceClaim(markingMesh, markingClaim);
        markingMesh.renderOrder = SURFACE_RENDER_ORDER.PARKING_MARKING;
        markingMesh.receiveShadow = true;
        group.add(markingMesh);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:markings'))) {
            disposeGreeneryBuild();
            return null;
        }
    }
    const forestTreesGroup = await buildForestTreesGroup(forestPolygons, shouldCancel);
    if (shouldCancel()) {
        disposeGroup(forestTreesGroup);
        disposeGreeneryBuild();
        return null;
    }
    if (forestTreesGroup) group.add(forestTreesGroup);
    const flowerbedsGroup = await buildFlowerbedsGroup(flowerbedPolygons, shouldCancel);
    if (shouldCancel()) {
        disposeGroup(flowerbedsGroup);
        disposeGreeneryBuild();
        return null;
    }
    if (flowerbedsGroup) group.add(flowerbedsGroup);
    // The child builders above own their own yield clocks and may span many
    // animation frames. Do not charge that awaited wall time to the parent's
    // next bank/shore step (the old diagnostic reported a fictitious 315-425
    // ms shoreline atom even when no shoreline frame actually ran that long).
    resetBuildYieldState(yieldState);
    if (Array.isArray(buckets.water) && buckets.water.length > 0) {
        const shoreMat = createWaterShoreMaterial({
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
        });
        const bankMat = createWaterBankMaterial();
        const waterEdgeY = terrainReference ? TERRAIN_WATER_Y : WATER_Y;
        for (const poly of naturalWaterPolygons) {
            const bankGeo = await drapeWaterEdgeGeometry(
                buildWaterBankGeometry(
                    poly.outerRing,
                    poly.holeRings,
                    waterEdgeY,
                    undefined,
                    { computeNormals: !terrainReference },
                ),
                yieldState,
                shouldCancel,
                'greenery:bank',
            );
            if (shouldCancel()) {
                disposeGreeneryBuild();
                return null;
            }
            if (bankGeo) {
                const bankMesh = new THREE.Mesh(bankGeo, bankMat);
                bankMesh.name = 'DecorWaterBank';
                markSurfaceClaim(bankMesh, {
                    surfaceClass: SURFACE_CLASS.PASSIVE_EDGING,
                    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
                    verticalBand: 'ground',
                    ownerId: 'decor-water-bank',
                    sourceId: 'world/decor.js',
                });
                bankMesh.receiveShadow = true;
                bankMesh.renderOrder = DECOR_WATER_BANK_RENDER_ORDER;
                group.add(bankMesh);
            }
            const shoreGeo = await drapeWaterEdgeGeometry(
                buildWaterShoreGeometry(
                    poly.outerRing,
                    poly.holeRings,
                    waterEdgeY,
                    undefined,
                    undefined,
                    { computeNormals: !terrainReference },
                ),
                yieldState,
                shouldCancel,
                'greenery:shore',
            );
            if (shouldCancel()) {
                disposeGreeneryBuild();
                return null;
            }
            if (!shoreGeo) continue;
            const shoreMesh = new THREE.Mesh(shoreGeo, shoreMat);
            shoreMesh.name = 'DecorWaterShore';
            markSurfaceClaim(shoreMesh, {
                surfaceClass: SURFACE_CLASS.PASSIVE_EDGING,
                coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
                verticalBand: 'ground',
                ownerId: 'decor-water-shore',
                sourceId: 'world/decor.js',
            });
            shoreMesh.receiveShadow = false;
            shoreMesh.renderOrder = DECOR_SHORE_RENDER_ORDER;
            group.add(shoreMesh);
            if (!(await maybeYieldBuild(yieldState, shouldCancel, 'greenery:shore'))) {
                disposeGreeneryBuild();
                return null;
            }
        }
    }
    const fountainRimMesh = buildFountainRimMesh(fountainPolygons);
    if (fountainRimMesh) group.add(fountainRimMesh);
    group.userData.waterMaterials = waterMats;
    group.userData.groundPaintOwners = Object.freeze([...groundPaintOwners.values()]);
    group.userData.groundPaintLayerIds = Object.freeze([...groundPaintLayerIds]);
    group.userData.waterPolygons = waterPolygons;
    group.userData.runwaySpawns = runwaySpawnCandidates(greeneryIndex.entries, {
        toLocal: (lon, lat) => geoToLocal(lon, lat, anchorLon, anchorLat),
    });
    try {
        prepareGreeneryPublicationGroup(group);
    } catch (error) {
        disposeGreeneryBuild();
        throw error;
    }
    return group;
}

// ─── Pedestrian crossings (zebra-striped instanced planes) ─────────────────

async function buildCrossingsGroup(crossingsIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!crossingsIndex) return null;

    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const RADIUS_M = 1200;

    const nearbyCandidates = [];
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(crossingsIndex, radiusBounds(centerLat, centerLon, RADIUS_M));
    const yieldState = createBuildYieldState();
    for (const entry of candidates) {
        const { lat, lng, bearing } = entry;
        const dx = (lng - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
        const dz = -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M;
        const offsetX = dx - centerLocal.x;
        const offsetZ = dz - centerLocal.z;
        if ((offsetX * offsetX + offsetZ * offsetZ) <= RADIUS_M * RADIUS_M) {
            nearbyCandidates.push({ bearing, dx, dz });
        }
        // The spatial index bounds are square while the visible window is
        // circular. Rejected corner candidates are still real work and must
        // reach the scheduler; otherwise a long rejected tail is charged to
        // the first terrain-evidence sample as one uninterruptible slice.
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'crossings'))) return null;
    }

    if (nearbyCandidates.length === 0) return null;

    // Placement below is one synchronous instance loop. Let the roads layer
    // publish first rather than making the first height lookup build it here.
    if (!(await waitForPublishedRoadFormation(
        terrainReference?.roadFormation || null,
        yieldState,
        shouldCancel,
    ))) return null;
    resetBuildYieldState(yieldState);

    const nearby = [];
    for (const candidate of nearbyCandidates) {
        const groundY = terrainPlacedY(
            candidate.dx,
            candidate.dz,
            GROUND_SURFACE_LEVELS.roadMarking,
            true,
        );
        if (groundY !== null) nearby.push({ ...candidate, groundY });
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'crossings:evidence'))) {
            return null;
        }
    }
    if (nearby.length === 0) return null;

    const STRIPE_COUNT = 6;
    const tw = 256, th = 64;
    const canvas = document.createElement('canvas');
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, tw, th);
    ctx.fillStyle = '#e8e8e8';
    for (let i = 0; i < STRIPE_COUNT; i++) {
        const x = (i / STRIPE_COUNT) * tw;
        const w = (tw / STRIPE_COUNT) * 0.52;
        ctx.fillRect(x, 0, w, th);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;

    const crossingDepth = STRIPE_COUNT * 0.9;
    const roadWidth = 6;
    const geo = new THREE.PlaneGeometry(crossingDepth, roadWidth);
    geo.rotateX(-Math.PI / 2);
    const crossingClaim = publishedDecorSurfaceClaim(
        SURFACE_CLASS.ROAD_MARKING,
        'decor-crossings',
    );
    const mat = authorizeDecorSurfaceMaterial(new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
    }), crossingClaim);

    const mesh = createInstancedMesh(geo, mat, nearby.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    markSurfaceClaim(mesh, crossingClaim);
    mesh.renderOrder = SURFACE_RENDER_ORDER.ROAD_MARKING;
    // Zebra crossings sit on the asphalt — let tram/building shadows land
    // on them instead of passing through to the ground plane beneath.
    mesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    nearby.forEach(({ bearing, dx, dz, groundY }, i) => {
        // Generic zebra paint is ordinary road dressing and yields to a
        // same-level trackbed. world/level-crossings.js owns the explicit
        // rail-crossing exception after at-grade topology is proved.
        dummy.position.set(dx, groundY, dz);
        dummy.rotation.set(0, Math.PI - bearing * DEG_TO_RAD, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.add(mesh);
    return group;
}

// Fringe colour at the ribbon edge: fades to fully transparent, tinted well
// down toward trodden dirt / grass shadow so the transition reads as worn
// ground rather than a pale glow.
const FOOTPATH_FRINGE_RGBA = [0.52, 0.60, 0.42, 0];
// The core is dimmed a touch too — full daylight over a warm-white texture
// otherwise still reads as concrete.
const FOOTPATH_CORE_RGBA = [0.88, 0.85, 0.78, 1];

async function buildFootpathsGroup(footpathsIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!footpathsIndex) return null;

    const RADIUS_M = 1500;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(footpathsIndex, radiusBounds(centerLat, centerLon, RADIUS_M));
    const vertices = [];
    const uvs = [];
    const colors = [];
    const capsPlaced = new Set();
    const yieldState = createBuildYieldState();

    // One cross-section sample of the ribbon: fringe | core | fringe. The
    // fringe fades to transparent grass-tinted macadam, so the path edge is
    // soft instead of a razor line on the lawn.
    const stationRow = (s) => {
        const fringe = Math.min(0.5, Math.max(0.25, s.halfWidth * 0.5));
        const outer = s.halfWidth + fringe;
        const lane = (offset) => ({
            x: s.x + s.nx * offset,
            z: s.z + s.nz * offset,
            u: s.arc * FOOTPATH_UV_PER_M,
            v: (offset + outer) * FOOTPATH_UV_PER_M,
        });
        return [lane(-outer), lane(-s.halfWidth), lane(s.halfWidth), lane(outer)];
    };
    const CORE_RGBA = FOOTPATH_CORE_RGBA;
    const laneColor = (laneIndex) => (laneIndex === 0 || laneIndex === 3 ? FOOTPATH_FRINGE_RGBA : CORE_RGBA);
    const pathHeightCache = new Map();
    const pathY = (point, offset = FOOTPATH_Y) => {
        const key = `${point.x}:${point.z}:${offset}`;
        if (!pathHeightCache.has(key)) {
            pathHeightCache.set(key, terrainPlacedY(point.x, point.z, offset));
        }
        return pathHeightCache.get(key);
    };
    const CAP_Y = FOOTPATH_Y - 0.0004;
    const pathRunTerrainReady = async (stations) => {
        let sampleCount = 0;
        const sampleReady = async (point, offset = FOOTPATH_Y) => {
            if (pathY(point, offset) === null) return false;
            sampleCount += 1;
            if (sampleCount % DECOR_WATER_DRAPE_CHUNK_VERTICES === 0
                && !(await maybeYieldBuild(yieldState, shouldCancel, 'footpaths:evidence'))) {
                return null;
            }
            return true;
        };
        for (const station of stations) {
            for (const point of stationRow(station)) {
                const ready = await sampleReady(point);
                if (ready !== true) return ready;
            }
        }
        const SEGS = 10;
        for (const station of [stations[0], stations[stations.length - 1]]) {
            const centerReady = await sampleReady(station, CAP_Y);
            if (centerReady !== true) return centerReady;
            const fringe = Math.min(0.5, Math.max(0.25, station.halfWidth * 0.5));
            for (let i = 0; i <= SEGS; i++) {
                const angle = (i / SEGS) * Math.PI * 2;
                for (const radius of [station.halfWidth, station.halfWidth + fringe]) {
                    const ringReady = await sampleReady({
                        x: station.x + Math.cos(angle) * radius,
                        z: station.z + Math.sin(angle) * radius,
                    }, CAP_Y);
                    if (ringReady !== true) return ringReady;
                }
            }
        }
        return true;
    };
    const pushQuad = (a, b, c, d, colA, colB, colC, colD) => {
        // a-b on the previous station, c-d on the next; both ordered left→right.
        vertices.push(
            a.x, pathY(a), a.z, b.x, pathY(b), b.z, c.x, pathY(c), c.z,
            b.x, pathY(b), b.z, d.x, pathY(d), d.z, c.x, pathY(c), c.z,
        );
        uvs.push(a.u, a.v, b.u, b.v, c.u, c.v, b.u, b.v, d.u, d.v, c.u, c.v);
        colors.push(...colA, ...colB, ...colC, ...colB, ...colD, ...colC);
    };

    // Rounded, fading cap at every ribbon end — covers junction wedges where
    // several chains meet and finishes dead ends softly. Slightly below the
    // ribbon so overlaps resolve by depth instead of z-fighting.
    const pushCap = (s) => {
        const key = `${Math.round(s.x * 2)}_${Math.round(s.z * 2)}`;
        if (capsPlaced.has(key)) return;
        capsPlaced.add(key);
        const fringe = Math.min(0.5, Math.max(0.25, s.halfWidth * 0.5));
        const SEGS = 10;
        const ring = (radius) => Array.from({ length: SEGS + 1 }, (_, i) => {
            const a = (i / SEGS) * Math.PI * 2;
            return { x: s.x + Math.cos(a) * radius, z: s.z + Math.sin(a) * radius };
        });
        const inner = ring(s.halfWidth);
        const outer = ring(s.halfWidth + fringe);
        const uvOf = (p) => [p.x * FOOTPATH_UV_PER_M, p.z * FOOTPATH_UV_PER_M];
        for (let i = 0; i < SEGS; i++) {
            // core fan
            vertices.push(
                s.x, pathY(s, CAP_Y), s.z,
                inner[i].x, pathY(inner[i], CAP_Y), inner[i].z,
                inner[i + 1].x, pathY(inner[i + 1], CAP_Y), inner[i + 1].z,
            );
            uvs.push(...uvOf(s), ...uvOf(inner[i]), ...uvOf(inner[i + 1]));
            colors.push(...CORE_RGBA, ...CORE_RGBA, ...CORE_RGBA);
            // fading fringe ring
            vertices.push(
                inner[i].x, pathY(inner[i], CAP_Y), inner[i].z,
                outer[i].x, pathY(outer[i], CAP_Y), outer[i].z,
                inner[i + 1].x, pathY(inner[i + 1], CAP_Y), inner[i + 1].z,
                outer[i].x, pathY(outer[i], CAP_Y), outer[i].z,
                outer[i + 1].x, pathY(outer[i + 1], CAP_Y), outer[i + 1].z,
                inner[i + 1].x, pathY(inner[i + 1], CAP_Y), inner[i + 1].z,
            );
            uvs.push(
                ...uvOf(inner[i]), ...uvOf(outer[i]), ...uvOf(inner[i + 1]),
                ...uvOf(outer[i]), ...uvOf(outer[i + 1]), ...uvOf(inner[i + 1]),
            );
            colors.push(
                ...CORE_RGBA, ...FOOTPATH_FRINGE_RGBA, ...CORE_RGBA,
                ...FOOTPATH_FRINGE_RGBA, ...FOOTPATH_FRINGE_RGBA, ...CORE_RGBA,
            );
        }
    };

    for (const entry of candidates) {
        const localPoints = entry.coords.map(([lon, lat]) => geoToLocal(lon, lat, anchorLon, anchorLat));
        // Split the chain into runs of points that are in range and not on
        // removed ground; each run becomes one smooth ribbon.
        const runs = [];
        let current = null;
        for (let i = 0; i < localPoints.length; i++) {
            const p = localPoints[i];
            const offsetX = p.x - centerLocal.x;
            const offsetZ = p.z - centerLocal.z;
            const keep = (offsetX * offsetX + offsetZ * offsetZ) <= RADIUS_M * RADIUS_M
                && !standsOnRemovedGround(p.x, p.z);
            if (keep) {
                if (!current) {
                    current = { points: [], widths: [] };
                    runs.push(current);
                }
                current.points.push({ x: p.x, z: p.z });
                current.widths.push(Math.max(0.7, Number(entry.widths[i]) || 1.2));
            } else {
                current = null;
            }
        }
        for (const run of runs) {
            if (run.points.length < 2) continue;
            const dense = terrainReference
                ? densifyChain(run.points, run.widths, Math.max(4, Math.min(10, terrainReference.surfaceStepM || 8)))
                : run;
            const smoothed = smoothChain(dense.points, dense.widths, 2);
            const stations = computeRibbonStations(smoothed.points, smoothed.widths);
            if (stations.length < 2) continue;
            // A path is one continuous owned surface. Never publish only the
            // loaded half of a ribbon: wait for evidence under every row and
            // cap, then build the whole run in the same synchronous turn.
            const terrainReady = await pathRunTerrainReady(stations);
            if (terrainReady === null) return null;
            if (!terrainReady) continue;
            for (let i = 0; i < stations.length - 1; i++) {
                const rowA = stationRow(stations[i]);
                const rowB = stationRow(stations[i + 1]);
                for (let lane = 0; lane < 3; lane++) {
                    pushQuad(
                        rowA[lane], rowA[lane + 1], rowB[lane], rowB[lane + 1],
                        laneColor(lane), laneColor(lane + 1), laneColor(lane), laneColor(lane + 1),
                    );
                }
            }
            pushCap(stations[0]);
            pushCap(stations[stations.length - 1]);
        }
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'footpaths'))) return null;
    }

    if (vertices.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(uvs), 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 4));
    geometry.computeVertexNormals();
    const footpathClaim = publishedDecorSurfaceClaim(
        SURFACE_CLASS.BUFFERED_SIDEWALK,
        'decor-footpaths',
        { supportReady: true, cutsBackstop: true },
    );
    const material = authorizeDecorSurfaceMaterial(new THREE.MeshStandardMaterial({
        map: getFootpathTexture(),
        roughness: 0.97,
        vertexColors: true,
        transparent: true,
        // Overlapping fringes (junctions, crossing chains) blend instead of
        // z-fighting; the paths are flat ground decals over opaque grass.
        depthWrite: false,
        ...DECOR_SURFACE_SHARED,
    }), footpathClaim);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'DecorFootpaths';
    mesh.userData.decorKind = 'footpath';
    markSurfaceClaim(mesh, footpathClaim);
    mesh.receiveShadow = true;
    return mesh;
}

// Stone basin + water disc (+ centre pedestal with its own bowl and spray on
// the larger ones), scaled by the mapped basin radius. The whole assembly
// stands on the plaza surface, so it draws OVER paved pedestrian areas that
// previously hid any trace of the fountain.
const FOUNTAIN_BASE_Y = 0.02;
function fountainPart(geometry, x, y, z) {
    return {
        geometry,
        matrix: new THREE.Matrix4().makeTranslation(x, y, z),
    };
}

function disposeFountainParts(...partLists) {
    for (const parts of partLists) {
        for (const part of parts) part.geometry?.dispose?.();
    }
}

async function buildFountainsGroup(fountainsIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!fountainsIndex) return null;

    const RADIUS_M = 1200;
    const TRACK_CLEARANCE_M = 0.85;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(fountainsIndex, radiusBounds(centerLat, centerLon, RADIUS_M));
    const yieldState = createBuildYieldState();
    const group = new THREE.Group();
    group.name = 'DecorFountains';
    const stone = new THREE.MeshStandardMaterial({ color: 0x9e9588, roughness: 0.8 });
    const water = new THREE.MeshLambertMaterial({ color: 0x6abfde });
    const basinParts = [];
    const upperStoneParts = [];
    const waterParts = [];
    let fountainCount = 0;

    for (const entry of candidates) {
        if (decorMaskedAt(entry.lat, entry.lng)) continue;
        const local = geoToLocal(entry.lng, entry.lat, anchorLon, anchorLat);
        const offsetX = local.x - centerLocal.x;
        const offsetZ = local.z - centerLocal.z;
        if ((offsetX * offsetX + offsetZ * offsetZ) > RADIUS_M * RADIUS_M) continue;
        if (standsOnRemovedGround(local.x, local.z)) continue;
        if (isPointInsideCorridorFootprints(
            local.x,
            local.z,
            customTrackCorridorVolumes,
            TRACK_CLEARANCE_M,
        )) continue;

        const r = entry.radius;
        const groundY = terrainPlacedY(local.x, local.z, FOUNTAIN_BASE_Y);
        if (groundY === null) continue;
        const fountain = new THREE.Object3D();
        fountain.position.set(local.x, groundY, local.z);
        const rimH = Math.min(0.7, 0.45 + r * 0.03);
        fountain.userData.decorObstacle = {
            id: entry.id,
            kind: 'fountain',
            x: local.x,
            y: fountain.position.y,
            z: local.z,
            radiusM: Math.max(0.8, r + 0.15),
            heightM: r >= 2 ? 2.6 : rimH,
            destructive: false,
        };

        basinParts.push(fountainPart(
            new THREE.CylinderGeometry(r, r + 0.15, rimH, 28),
            local.x,
            groundY + rimH * 0.5,
            local.z,
        ));
        waterParts.push(fountainPart(
            new THREE.CylinderGeometry(
                Math.max(0.4, r - 0.28),
                Math.max(0.4, r - 0.28),
                0.06,
                28,
            ),
            local.x,
            groundY + rimH + 0.02,
            local.z,
        ));

        if (r >= 2) {
            upperStoneParts.push(fountainPart(
                new THREE.CylinderGeometry(0.28, 0.42, 1.1, 14),
                local.x,
                groundY + rimH + 0.55,
                local.z,
            ));
            upperStoneParts.push(fountainPart(
                new THREE.CylinderGeometry(Math.min(1.6, r * 0.28), 0.5, 0.3, 20),
                local.x,
                groundY + rimH + 1.15,
                local.z,
            ));
            waterParts.push(fountainPart(
                new THREE.CylinderGeometry(
                    Math.min(1.45, r * 0.28 - 0.12),
                    Math.min(1.45, r * 0.28 - 0.12),
                    0.05,
                    20,
                ),
                local.x,
                groundY + rimH + 1.3,
                local.z,
            ));
            waterParts.push(fountainPart(
                new THREE.ConeGeometry(0.3, 1.2, 8, 1, true),
                local.x,
                groundY + rimH + 1.9,
                local.z,
            ));
        }

        group.add(fountain);
        fountainCount += 1;
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'fountains'))) {
            disposeFountainParts(basinParts, upperStoneParts, waterParts);
            disposeGroup(group);
            stone.dispose();
            water.dispose();
            return null;
        }
    }

    if (fountainCount === 0) {
        stone.dispose();
        water.dispose();
        return null;
    }
    const batches = [];
    group.userData.disposables = batches;
    const families = [
        [basinParts, {
            material: stone,
            name: 'DecorFountainBasins',
            castShadow: true,
            receiveShadow: true,
        }],
        [upperStoneParts, {
            material: stone,
            name: 'DecorFountainUpperStone',
            castShadow: true,
        }],
        [waterParts, {
            material: water,
            name: 'DecorFountainWater',
        }],
    ];
    let complete = false;
    try {
        // Each source is a small cylinder/cone. Bound both batch construction
        // and its eventual GPU upload; a whole city's props is not one item.
        for (const [parts, options] of families) {
            for (let offset = 0; offset < parts.length; offset += 32) {
                const batch = createStaticBatchedMesh(parts.slice(offset, offset + 32), options);
                if (batch) {
                    batches.push(batch);
                    batch.userData.decorKind = 'fountain';
                    group.add(batch);
                }
                if (!(await maybeYieldBuild(yieldState, shouldCancel, 'fountains:batch'))) return null;
            }
        }
        complete = true;
    } finally {
        if (!complete) {
            disposeFountainParts(basinParts, upperStoneParts, waterParts);
            disposeGroup(group);
            stone.dispose();
            water.dispose();
        }
    }
    // BatchedMesh owns matrix/color textures in addition to its geometry.
    // disposeGroup releases the visible resources; this explicit list releases
    // those internal textures once when the streamed group retires.
    return group;
}

async function buildBenchesGroup(benchesIndex, anchorLat, anchorLon, centerLat, centerLon, shouldCancel) {
    if (!benchesIndex) return null;

    const RADIUS_M = 1200;
    const BENCH_GROUND_Y = 0.014;
    const TRACK_CLEARANCE_M = 0.85;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(benchesIndex, radiusBounds(centerLat, centerLon, RADIUS_M));
    const nearby = [];
    const yieldState = createBuildYieldState();

    for (const entry of candidates) {
        if (decorMaskedAt(entry.lat, entry.lng)) continue;
        const local = geoToLocal(entry.lng, entry.lat, anchorLon, anchorLat);
        // customTrackCorridorVolumes is empty in model mode — also cull against the
        // rail formation so a bench never sits on a cut/fill/at-grade corridor.
        if (standsOnRemovedGround(local.x, local.z)) continue;
        if (isPointInsideCorridorFootprints(
            local.x,
            local.z,
            customTrackCorridorVolumes,
            TRACK_CLEARANCE_M,
        )) continue;
        const offsetX = local.x - centerLocal.x;
        const offsetZ = local.z - centerLocal.z;
        if ((offsetX * offsetX + offsetZ * offsetZ) > RADIUS_M * RADIUS_M) continue;
        if (destroyedDecorPropIds.has(entry.id)) continue;
        // This builder yields between candidates, so road tiles can make the
        // formation dirty again at any iteration. Gate the exact road-height
        // boundary; terrain-only bench filtering remains free to proceed.
        if (!(await waitForPublishedRoadFormation(
            terrainReference?.roadFormation || null,
            yieldState,
            shouldCancel,
        ))) return null;
        const groundY = terrainBaseY(local.x, local.z, true);
        if (groundY === null) continue;
        nearby.push({
            id: entry.id,
            x: local.x,
            z: local.z,
            yaw: Number.isFinite(entry.bearing) ? (Math.PI * 0.5) - (entry.bearing * DEG_TO_RAD) : 0,
            groundY,
        });
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'benches'))) return null;
    }

    if (nearby.length === 0) return null;

    const { woodMat, metalMat, seatGeo, backGeo, leftSupportGeo, rightSupportGeo } = createBenchParts();

    const disposeLocal = () => {
        seatGeo.dispose();
        backGeo.dispose();
        leftSupportGeo.dispose();
        rightSupportGeo.dispose();
        woodMat.dispose();
        metalMat.dispose();
    };

    const seatMesh = createInstancedMesh(seatGeo, woodMat, nearby.length);
    seatMesh.name = 'DecorBenchSeats';
    seatMesh.castShadow = true;
    seatMesh.receiveShadow = true;
    const backMesh = createInstancedMesh(backGeo, woodMat, nearby.length);
    backMesh.name = 'DecorBenchBacks';
    backMesh.castShadow = true;
    backMesh.receiveShadow = true;
    const leftSupportMesh = createInstancedMesh(leftSupportGeo, metalMat, nearby.length);
    leftSupportMesh.name = 'DecorBenchSupportsLeft';
    // The seat and back already cast the readable bench silhouette. Two thin
    // support batches doubled the shadow-pass cost for no visible ground
    // detail at the configured shadow-map resolution.
    leftSupportMesh.castShadow = false;
    leftSupportMesh.receiveShadow = true;
    const rightSupportMesh = createInstancedMesh(rightSupportGeo, metalMat, nearby.length);
    rightSupportMesh.name = 'DecorBenchSupportsRight';
    rightSupportMesh.castShadow = false;
    rightSupportMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < nearby.length; i++) {
        const { x, z, yaw, groundY } = nearby[i];
        dummy.position.set(x, groundY + BENCH_GROUND_Y, z);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        seatMesh.setMatrixAt(i, dummy.matrix);
        backMesh.setMatrixAt(i, dummy.matrix);
        leftSupportMesh.setMatrixAt(i, dummy.matrix);
        rightSupportMesh.setMatrixAt(i, dummy.matrix);
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'benches'))) {
            disposeLocal();
            return null;
        }
    }

    seatMesh.instanceMatrix.needsUpdate = true;
    backMesh.instanceMatrix.needsUpdate = true;
    leftSupportMesh.instanceMatrix.needsUpdate = true;
    rightSupportMesh.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.name = 'DecorBenches';
    group.add(leftSupportMesh);
    group.add(rightSupportMesh);
    group.add(seatMesh);
    group.add(backMesh);
    group.userData.breakableProps = nearby.map((bench, index) => ({
        id: bench.id,
        kind: 'bench',
        x: bench.x,
        y: bench.groundY + BENCH_GROUND_Y,
        z: bench.z,
        yaw: bench.yaw,
        radiusM: 0.78,
        heightM: 0.9,
        destructive: true,
        index,
        meshes: [leftSupportMesh, rightSupportMesh, seatMesh, backMesh],
    }));
    return group;
}

const TRAFFIC_LIGHT_RADIUS_M = 1200;
const MAX_TRAFFIC_LIGHTS = 1200;
const SIGNAL_POLE_CLEARANCE_M = 0.4;
const SIGNAL_POLE_SEARCH_RADIUS_M = 26;
const SIGNAL_LAMP_FACE_OFFSET_M = 0.18;
const SIGNAL_LIGHT_COLORS = Object.freeze({
    redOn: new THREE.Color(0xff2d21),
    redOff: new THREE.Color(0x260503),
    amberOn: new THREE.Color(0xffa317),
    amberOff: new THREE.Color(0x281503),
    greenOn: new THREE.Color(0x30e873),
    greenOff: new THREE.Color(0x03240e),
});

function setSignalInstance(mesh, index, x, y, z, yaw, dummy) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
}

function updateTrafficLightColors(group, elapsedSeconds) {
    if (!group?.userData?.signals) return;
    const bucket = Math.floor((Number(elapsedSeconds) || 0) * 4);
    if (group.userData.colorBucket === bucket) return;
    group.userData.colorBucket = bucket;
    const { redMesh, amberMesh, greenMesh } = group.userData;
    group.userData.signals.forEach((signal, index) => {
        const phase = destroyedDecorPropIds.has(signal.id)
            ? 'off' : trafficSignalPhase(signal, elapsedSeconds);
        const red = phase === 'red' ? SIGNAL_LIGHT_COLORS.redOn : SIGNAL_LIGHT_COLORS.redOff;
        const amber = phase === 'amber'
            ? SIGNAL_LIGHT_COLORS.amberOn : SIGNAL_LIGHT_COLORS.amberOff;
        const green = phase === 'green'
            ? SIGNAL_LIGHT_COLORS.greenOn : SIGNAL_LIGHT_COLORS.greenOff;
        for (let face = 0; face < 2; face += 1) {
            const faceIndex = index * 2 + face;
            redMesh.setColorAt(faceIndex, red);
            amberMesh.setColorAt(faceIndex, amber);
            greenMesh.setColorAt(faceIndex, green);
        }
    });
    if (redMesh.instanceColor) redMesh.instanceColor.needsUpdate = true;
    if (amberMesh.instanceColor) amberMesh.instanceColor.needsUpdate = true;
    if (greenMesh.instanceColor) greenMesh.instanceColor.needsUpdate = true;
}

async function buildTrafficLightsGroup(
    signalsIndex,
    anchorLat,
    anchorLon,
    centerLat,
    centerLon,
    shouldCancel,
) {
    if (!signalsIndex) return null;
    const centerLocal = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = querySpatialIndex(
        signalsIndex,
        radiusBounds(centerLat, centerLon, TRAFFIC_LIGHT_RADIUS_M),
    );
    const roadSurfaceIndex = getDecorRoadSurfaceIndex();
    const signals = [];
    const yieldState = createBuildYieldState();
    for (const entry of candidates) {
        if (decorMaskedAt(entry.lat, entry.lng)) continue;
        if (destroyedDecorPropIds.has(entry.id)) continue;
        const local = geoToLocal(entry.lng, entry.lat, anchorLon, anchorLat);
        const dx = local.x - centerLocal.x;
        const dz = local.z - centerLocal.z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > TRAFFIC_LIGHT_RADIUS_M * TRAFFIC_LIGHT_RADIUS_M) continue;
        const bearingDeg = Number(entry.bearing) || 0;
        const roadPolygons = roadSurfaceIndex
            ? querySpatialIndex(
                roadSurfaceIndex,
                radiusBounds(entry.lat, entry.lng, SIGNAL_POLE_SEARCH_RADIUS_M),
            )
            : [];
        const placement = findTrafficSignalPolePlacement({
            x: local.x,
            z: local.z,
            bearingDeg,
            roadPolygons,
            clearanceM: SIGNAL_POLE_CLEARANCE_M,
            maximumOffsetM: SIGNAL_POLE_SEARCH_RADIUS_M - 2,
        });
        // A source node without loaded carriageway truth is deferred until the
        // road-tile subscription rebuilds decor. Rendering it at a guessed
        // offset would put the pole back on a wide roadbed.
        if (!placement) continue;
        const poleX = placement.x;
        const poleZ = placement.z;
        // As with benches, each candidate can resume in a later frame. Never
        // let this road-height sample become the synchronous road builder.
        if (!(await waitForPublishedRoadFormation(
            terrainReference?.roadFormation || null,
            yieldState,
            shouldCancel,
        ))) return null;
        const groundY = terrainBaseY(poleX, poleZ, true);
        if (groundY === null) continue;
        signals.push({
            id: entry.id,
            x: local.x,
            z: local.z,
            poleX,
            poleZ,
            bearingDeg,
            roadX: placement.roadX,
            roadZ: placement.roadZ,
            yaw: placement.yaw,
            poleOffsetM: placement.offsetM,
            groundY,
            distanceSq,
        });
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'traffic-lights'))) return null;
    }
    signals.sort((left, right) => left.distanceSq - right.distanceSq || left.id.localeCompare(right.id));
    signals.length = Math.min(signals.length, MAX_TRAFFIC_LIGHTS);
    if (signals.length === 0) return null;

    const poleMesh = createInstancedMesh(
        new THREE.CylinderGeometry(0.075, 0.095, 2.5, 8),
        new THREE.MeshStandardMaterial({ color: 0x555c62, metalness: 0.55, roughness: 0.48 }),
        signals.length,
    );
    const headMesh = createInstancedMesh(
        new THREE.BoxGeometry(0.34, 0.84, 0.24),
        new THREE.MeshStandardMaterial({ color: 0x171a1c, roughness: 0.8 }),
        signals.length,
    );
    const lightGeometry = new THREE.SphereGeometry(0.13, 12, 8);
    const lightMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
    });
    const faceCount = signals.length * 2;
    const redMesh = createInstancedMesh(lightGeometry, lightMaterial, faceCount);
    const amberMesh = createInstancedMesh(lightGeometry.clone(), lightMaterial.clone(), faceCount);
    const greenMesh = createInstancedMesh(lightGeometry.clone(), lightMaterial.clone(), faceCount);
    poleMesh.name = 'TrafficLightPoles';
    headMesh.name = 'TrafficLightHeads';
    redMesh.name = 'TrafficLightRed';
    amberMesh.name = 'TrafficLightAmber';
    greenMesh.name = 'TrafficLightGreen';
    poleMesh.castShadow = true;
    headMesh.castShadow = true;

    const dummy = new THREE.Object3D();
    signals.forEach((signal, index) => {
        const { poleX, poleZ, groundY, yaw } = signal;
        setSignalInstance(poleMesh, index, poleX, groundY + 1.3, poleZ, yaw, dummy);
        setSignalInstance(headMesh, index, poleX, groundY + 2.73, poleZ, yaw, dummy);
        const faces = trafficSignalLampFacePositions(signal, SIGNAL_LAMP_FACE_OFFSET_M);
        faces.forEach((facePosition, face) => {
            const faceIndex = index * 2 + face;
            setSignalInstance(
                redMesh, faceIndex, facePosition.x, groundY + 3.03, facePosition.z, yaw, dummy,
            );
            setSignalInstance(
                amberMesh, faceIndex, facePosition.x, groundY + 2.73, facePosition.z, yaw, dummy,
            );
            setSignalInstance(
                greenMesh, faceIndex, facePosition.x, groundY + 2.43, facePosition.z, yaw, dummy,
            );
        });
    });
    for (const mesh of [poleMesh, headMesh, redMesh, amberMesh, greenMesh]) {
        mesh.instanceMatrix.needsUpdate = true;
    }

    const group = new THREE.Group();
    group.name = 'TrafficLights';
    group.add(poleMesh, headMesh, redMesh, amberMesh, greenMesh);
    Object.assign(group.userData, {
        signals,
        redMesh,
        amberMesh,
        greenMesh,
        colorBucket: null,
        breakableProps: signals.map((signal, index) => ({
            id: signal.id,
            kind: 'traffic_light',
            x: signal.poleX,
            y: signal.groundY,
            z: signal.poleZ,
            yaw: signal.yaw,
            radiusM: 0.24,
            heightM: 3.15,
            destructive: true,
            index,
            meshInstances: [
                { mesh: poleMesh, indices: [index] },
                { mesh: headMesh, indices: [index] },
                { mesh: redMesh, indices: [index * 2, index * 2 + 1] },
                { mesh: amberMesh, indices: [index * 2, index * 2 + 1] },
                { mesh: greenMesh, indices: [index * 2, index * 2 + 1] },
            ],
        })),
    });
    updateTrafficLightColors(group, performance.now() / 1000);
    return group;
}

// ─── Sparse Dalmatian karst detail ────────────────────────────────────────

function buildNaturalInstancedMesh(entries, kind, lod) {
    if (entries.length === 0) return null;
    const limestone = kind === 'limestone';
    const style = naturalGroundMaterialStyle(kind, lod);
    const geometry = limestone
        ? new THREE.IcosahedronGeometry(0.62, 0)
        : lod === 'near'
            ? new THREE.DodecahedronGeometry(0.58, 0)
            : new THREE.IcosahedronGeometry(0.58, 0);
    const material = new THREE.MeshStandardMaterial({
        // Limestone colour is material-owned rather than supplied through
        // instanceColor. The latter was resolving almost black in the live
        // renderer even when fed a pale limestone value or a green shrub
        // value. Material-owned colours make both families unambiguous.
        color: style.colorHex,
        emissive: style.emissiveHex,
        emissiveIntensity: style.emissiveIntensity,
        roughness: style.roughness,
        vertexColors: false,
        flatShading: true,
    });
    const mesh = createInstancedMesh(geometry, material, entries.length);
    mesh.name = kind === 'limestone'
        ? 'DalmatianLimestoneOutcrops'
        : lod === 'near' ? 'DalmatianKarstShrubsNear' : 'DalmatianKarstShrubsFar';
    mesh.castShadow = lod === 'near';
    mesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        dummy.position.set(entry.x, entry.y, entry.z);
        dummy.rotation.set(
            kind === 'limestone' ? entry.tiltX : 0,
            entry.rotationY,
            kind === 'limestone' ? entry.tiltZ : 0,
        );
        if (kind === 'limestone') {
            dummy.scale.set(entry.scaleX, entry.scaleY, entry.scaleZ);
        } else {
            dummy.scale.set(entry.scale * entry.aspect, entry.scale * 0.72, entry.scale / entry.aspect);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}

async function buildDalmatianNaturalProps(centerLat, centerLon, config, shouldCancel) {
    if (!terrainReference || config?.style !== 'dalmatian-karst') return null;
    const center = geoToLocal(centerLon, centerLat, anchorLon, anchorLat);
    const candidates = buildNaturalScatterCandidates(center.x, center.z, {
        radiusM: config.radiusM,
        cellSizeM: NATURAL_SCATTER_CELL_M,
        density: NATURAL_SCATTER_DENSITY,
        seed: NATURAL_SCATTER_SEED,
    });
    const roads = getDecorRoadSurfaceIndex();
    const buildings = getDecorBuildingSurfaceIndex();
    const urbanGround = normalizeUrbanGroundConfig(getLocation().urbanGround);
    const buildingClearanceM = Math.max(
        NATURAL_BUILDING_CLEARANCE_M,
        (urbanGround?.coreRadiusM || 0) + (urbanGround?.blendRadiusM || 0),
    );
    const buckets = {
        shrubNear: [],
        shrubFar: [],
        limestone: [],
    };
    const yieldState = createBuildYieldState();

    for (const candidate of candidates) {
        if (shouldCancel()) return null;
        // Every rejection exits this block and reaches the scheduler below.
        // A rejected sea/road/building candidate is still work; letting `continue`
        // bypass the yield point accumulated entire rejected tails into one slice.
        candidatePlacement: {
            const geo = terrainReference.lonLatAtLocal(candidate.x, candidate.z);
            const absoluteHeightM = terrainReference.heightAt(geo.lon, geo.lat);
            // DGU NoData is mostly Adriatic, while the mapped coastline remains
            // the exact land/sea authority at the shore. Both checks are needed:
            // one keeps props outside the valid DTM, the other keeps them off sea
            // polygons where interpolation still finds a neighbouring land cell.
            if (!Number.isFinite(absoluteHeightM)
                || isPointInMappedSea(candidate.x, candidate.z)) break candidatePlacement;
            if (decorMaskedAt(geo.lat, geo.lon)) {
                break candidatePlacement;
            }
            // customTrackCorridorVolumes is empty in model mode — also cull against the
            // rail formation (+ footprint) so a shrub/prop never sits on the cut/fill track.
            if (standsOnOrOverCorridor(candidate.x, candidate.z, NaN, NaN, 1.2)) {
                break candidatePlacement;
            }
            const clusterMarginM = candidate.kind === 'outcrop' ? NATURAL_OUTCROP_RADIUS_M : 0;
            if (isPointInsideCorridorFootprints(
                candidate.x,
                candidate.z,
                customTrackCorridorVolumes,
                NATURAL_TRACK_CLEARANCE_M + clusterMarginM,
            )) break candidatePlacement;
            if (spatialPolygonsTouchPoint(
                roads,
                geo.lon,
                geo.lat,
                candidate.x,
                candidate.z,
                NATURAL_ROAD_CLEARANCE_M + clusterMarginM,
            )) break candidatePlacement;
            if (spatialPolygonsTouchPoint(
                buildings,
                geo.lon,
                geo.lat,
                candidate.x,
                candidate.z,
                buildingClearanceM + clusterMarginM,
            )) break candidatePlacement;

            const normal = terrainReference.evidenceNormalAtLocal?.(candidate.x, candidate.z, 12);
            if (!normal || (candidate.kind === 'shrub' ? normal.y < 0.72 : normal.y < 0.48)) {
                break candidatePlacement;
            }
            if (candidate.kind === 'outcrop') {
                for (const piece of buildLimestoneOutcropPieces(candidate)) {
                    const pieceGeo = terrainReference.lonLatAtLocal(piece.x, piece.z);
                    const pieceHeightM = terrainReference.heightAt(pieceGeo.lon, pieceGeo.lat);
                    if (!Number.isFinite(pieceHeightM) || isPointInMappedSea(piece.x, piece.z)) continue;
                    const pieceNormal = terrainReference.evidenceNormalAtLocal?.(piece.x, piece.z, 8);
                    if (!pieceNormal || pieceNormal.y < 0.48) continue;
                    const groundY = finiteOrNull(
                        terrainReference.evidenceSceneYAtLocal?.(piece.x, piece.z),
                    );
                    if (groundY === null) continue;
                    // Icosahedron radius is 0.62. Lowering its centre by a
                    // fraction of that half-height leaves only a broad cap above
                    // the terrain, so the contact area cannot read as a balanced
                    // freestanding boulder.
                    const visiblePiece = {
                        ...piece,
                        y: groundY - piece.scaleY * 0.62 * piece.embedRatio,
                    };
                    buckets.limestone.push(visiblePiece);
                }
            } else {
                const groundY = finiteOrNull(
                    terrainReference.evidenceSceneYAtLocal?.(candidate.x, candidate.z),
                );
                if (groundY === null) break candidatePlacement;
                const entry = { ...candidate, y: groundY + candidate.scale * 0.31 };
                if (candidate.lod === 'near') buckets.shrubNear.push(entry);
                else buckets.shrubFar.push(entry);
            }
        }
        if (!(await maybeYieldBuild(yieldState, shouldCancel, 'dalmatian'))) return null;
    }

    const group = new THREE.Group();
    group.name = 'DalmatianNaturalGroundDetail';
    const meshes = [
        buildNaturalInstancedMesh(buckets.shrubNear, 'shrub', 'near'),
        buildNaturalInstancedMesh(buckets.shrubFar, 'shrub', 'far'),
        buildNaturalInstancedMesh(buckets.limestone, 'limestone', 'near'),
    ].filter(Boolean);
    for (const mesh of meshes) group.add(mesh);
    group.userData.naturalPropCount = buckets.shrubNear.length
        + buckets.shrubFar.length
        + buckets.limestone.length;
    return group.children.length > 0 ? group : null;
}

// ─── Session state + refresh scheduler ─────────────────────────────────────

let anchorLat = 0, anchorLon = 0;
let fetchController = null;
let networkRequestScheduler = null;
let surfacePublications = null;
let groundPaint = null;
let paintVisibilitySubscription = null;
let paintVisibilityRevision = 0;
let paintVisibilityRefreshPending = false;
let greeneryPublicationGeneration = 0;
let treesGroup = null;
let greeneryGroup = null;
let hedgesGroup = null;
let crossingsGroup = null;
let footpathsGroup = null;
let benchesGroup = null;
let fountainsGroup = null;
let trafficLightsGroup = null;
let trafficLightsEnabled = false;
let trafficSignalElapsedSeconds = 0;
const trafficSignalCells = new Map();
const TRAFFIC_SIGNAL_CELL_M = 32;
const destroyedDecorPropIds = new Set();
const activeDecorObstacles = new Map();
const DECOR_BENCH_OWNER = 'decor';
let naturalPropsGroup = null;
let waterMaterials = [];
let currentWaterPolygons = [];
let currentRunwaySpawns = [];
const greenerySurfaceRootByGroup = new WeakMap();
const disposedGreeneryGroups = new WeakSet();
const greeneryGroupBySurfaceRoot = new WeakMap();
const GREENERY_SURFACE_PUBLICATION_KEY = 'decor:greenery-surfaces';
let lastLat = null;
let lastLon = null;
let requestId = 0;
let customTrackCorridorVolumes = [];
let customElevatedTrackCorridorVolumes = [];
let decorMaskPredicate = null;
// A second, independent mask owned by a campaign set-piece (the tower site);
// the proposal mask above and this one are consulted together so neither
// clobbers the other.
let campaignDecorMask = null;

function decorMaskedAt(lat, lng) {
    return !!((decorMaskPredicate && decorMaskPredicate(lat, lng))
        || (campaignDecorMask && campaignDecorMask(lat, lng)));
}
let roadTileSource = null;
let roadTileSubscription = null;
// Stable across tiles when the source carries an OSM id, so overlapping bboxes
// contribute one record rather than one per delivery.
function decorRoadFeatureKey(feature, tileKey, featureIndex) {
    const properties = feature?.properties || {};
    if (properties.osm_id != null) return `osm:${String(properties.osm_id)}`;
    if (feature?.id != null) return `feature:${String(feature.id)}`;
    return `tile:${tileKey}:${featureIndex}`;
}

const decorRoadFeatures = createTileFeatureRegistry({ featureKey: decorRoadFeatureKey });
let decorRoadSurfaceIndex = null;
let decorRoadSurfaceRevision = -1;
let decorRoadRefreshTimer = null;
let lastDecorHeadingDeg = null;
let lastDecorHeadingChangeMs = 0;
let buildingTileSource = null;
let buildingTileSubscription = null;
const decorBuildingFeatures = createTileFeatureRegistry({ featureKey: decorRoadFeatureKey });
let decorBuildingSurfaceIndex = null;
let decorBuildingSurfaceRevision = -1;
let naturalRefreshTimer = null;
let naturalRequestId = 0;
let lastNaturalLat = null;
let lastNaturalLon = null;
let lastNaturalStyle = null;
let mappedSeaSubscription = null;
let decorActivityCount = 0;
let decorInitialized = false;
const decorAssetReadiness = createDecorAssetReadiness([
    'trees', 'greenery', 'hedges', 'crossings', 'footpaths', 'benches', 'fountains', 'trafficLights',
]);

export function getDecorReadinessSnapshot() {
    const assets = decorAssetReadiness.snapshot();
    const waitingTerrain = !!terrainAwaitingDecorCenter || terrainRefreshPending;
    const pending = Math.max(decorActivityCount, assets.pending)
        + (waitingTerrain || decorRoadRefreshTimer != null || naturalRefreshTimer != null ? 1 : 0);
    return Object.freeze({ ...assets, initialized: decorInitialized, pending, waitingTerrain,
        ready: decorInitialized && pending === 0 && assets.failed === 0 });
}

registerBackgroundActivityReader(() => {
    const status = getDecorReadinessSnapshot();
    return { kind: 'build', label: 'decor', pending: status.pending, failed: status.failed };
});

function rebuildDecorObstacleRegistry() {
    activeDecorObstacles.clear();
    const benchSeats = [];
    for (const obstacle of treesGroup?.userData?.immutableProps || []) {
        activeDecorObstacles.set(obstacle.id, obstacle);
    }
    for (const obstacle of benchesGroup?.userData?.breakableProps || []) {
        if (destroyedDecorPropIds.has(obstacle.id)) continue;
        activeDecorObstacles.set(obstacle.id, obstacle);
        benchSeats.push({
            id: String(obstacle.id),
            x: obstacle.x,
            z: obstacle.z,
            yaw: obstacle.yaw,
            // The instanced seat top is 0.50 m above its ground transform.
            seatY: obstacle.y + 0.50,
        });
    }
    for (const obstacle of trafficLightsGroup?.userData?.breakableProps || []) {
        if (!destroyedDecorPropIds.has(obstacle.id)) activeDecorObstacles.set(obstacle.id, obstacle);
    }
    for (const child of fountainsGroup?.children || []) {
        const obstacle = child?.userData?.decorObstacle;
        if (obstacle) activeDecorObstacles.set(obstacle.id, obstacle);
    }
    replaceAmbientBenchSeats(DECOR_BENCH_OWNER, benchSeats);
}

function rebuildTrafficSignalCells() {
    trafficSignalCells.clear();
    for (const signal of trafficLightsGroup?.userData?.signals || []) {
        const key = `${Math.floor(signal.x / TRAFFIC_SIGNAL_CELL_M)}_${Math.floor(signal.z / TRAFFIC_SIGNAL_CELL_M)}`;
        let cell = trafficSignalCells.get(key);
        if (!cell) {
            cell = [];
            trafficSignalCells.set(key, cell);
        }
        cell.push(signal);
    }
}

export function trafficSignalSpeedFactorAt(localX, localZ, heading) {
    if (!trafficLightsEnabled || trafficSignalCells.size === 0) return 1;
    const cellX = Math.floor(Number(localX) / TRAFFIC_SIGNAL_CELL_M);
    const cellZ = Math.floor(Number(localZ) / TRAFFIC_SIGNAL_CELL_M);
    let factor = 1;
    for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            for (const signal of trafficSignalCells.get(`${cellX + dx}_${cellZ + dz}`) || []) {
                if (destroyedDecorPropIds.has(signal.id)) continue;
                factor = Math.min(factor, trafficSignalBrakeFactor({
                    vehicleX: localX,
                    vehicleZ: localZ,
                    heading,
                    signal,
                    elapsedSeconds: trafficSignalElapsedSeconds,
                }));
            }
        }
    }
    return factor;
}

export function getDecorObstaclesNear(localX, localZ, radiusM = 150) {
    const radiusSq = Math.max(0, Number(radiusM) || 0) ** 2;
    const nearby = [];
    for (const obstacle of activeDecorObstacles.values()) {
        if (destroyedDecorPropIds.has(obstacle.id)) continue;
        const dx = obstacle.x - localX;
        const dz = obstacle.z - localZ;
        if (dx * dx + dz * dz <= radiusSq) nearby.push({
            ...obstacle,
            meshes: undefined,
            meshInstances: undefined,
        });
    }
    return nearby;
}

export function destroyDecorProp(id) {
    const obstacle = activeDecorObstacles.get(id);
    if (!obstacle || !obstacle.destructive || destroyedDecorPropIds.has(id)) return false;
    const zero = new THREE.Vector3(0, 0, 0);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const targets = obstacle.meshInstances?.length
        ? obstacle.meshInstances
        : (obstacle.meshes || []).map(mesh => ({ mesh, indices: [obstacle.index] }));
    for (const target of targets) {
        for (const index of target.indices || []) {
            target.mesh.getMatrixAt(index, matrix);
            matrix.decompose(position, quaternion, scale);
            matrix.compose(position, quaternion, zero);
            target.mesh.setMatrixAt(index, matrix);
        }
        target.mesh.instanceMatrix.needsUpdate = true;
    }
    destroyedDecorPropIds.add(id);
    activeDecorObstacles.delete(id);
    removeAmbientBenchSeat(String(id), DECOR_BENCH_OWNER);
    return true;
}

function scheduleDecorRoadRefresh() {
    if (lastLat == null || lastLon == null) return;
    if (!fetchController || (fetchController.signal && fetchController.signal.aborted)) return;
    if (decorRoadRefreshTimer != null) clearTimeout(decorRoadRefreshTimer);
    const flush = () => {
        decorRoadRefreshTimer = null;
        if (lastLat == null || lastLon == null) return;
        if (!fetchController || (fetchController.signal && fetchController.signal.aborted)) return;
        const turnIdleMs = nowMs() - lastDecorHeadingChangeMs;
        if (lastDecorHeadingDeg != null && turnIdleMs < DECOR_ROAD_TURN_IDLE_MS) {
            decorRoadRefreshTimer = setTimeout(
                flush,
                Math.max(16, DECOR_ROAD_TURN_IDLE_MS - turnIdleMs),
            );
            return;
        }
        // The unique feature set is maintained incrementally, so "did anything
        // change?" is a revision compare rather than a re-scan of every loaded
        // tile. This flush runs from a setTimeout — outside the render loop and
        // outside every work queue — so whatever it costs is unattributable
        // freeze. Keep it O(what changed).
        if (decorRoadSurfaceIndex
            && decorRoadSurfaceRevision === decorRoadFeatures.revision) return;
        buildDecorRoadSurfaceIndex();
        refresh(lastLat, lastLon);
    };
    decorRoadRefreshTimer = setTimeout(flush, DECOR_ROAD_REFRESH_SETTLE_MS);
}

function invalidateDecorRoadSurfaceIndex() {
    decorRoadSurfaceIndex = null;
    decorRoadSurfaceRevision = -1;
}

// Projected rings are memoised per feature by the registry, so this re-derives
// only features seen for the first time; everything else is a bucket insert.
function buildDecorRoadSurfaceIndex() {
    const startedMs = nowMs();
    const entries = decorRoadFeatures.collect(roadSurfaceEntriesForFeature);
    decorRoadSurfaceIndex = createSpatialIndex(entries);
    decorRoadSurfaceRevision = decorRoadFeatures.revision;
    recordLayerFrameMs('decor:roadIndex', nowMs() - startedMs);
    return decorRoadSurfaceIndex;
}

function getDecorRoadSurfaceIndex() {
    if (decorRoadSurfaceIndex
        && decorRoadSurfaceRevision === decorRoadFeatures.revision) return decorRoadSurfaceIndex;
    return buildDecorRoadSurfaceIndex();
}

function invalidateDecorBuildingSurfaceIndex() {
    decorBuildingSurfaceIndex = null;
    decorBuildingSurfaceRevision = -1;
}

function getDecorBuildingSurfaceIndex() {
    if (decorBuildingSurfaceIndex
        && decorBuildingSurfaceRevision === decorBuildingFeatures.revision) {
        return decorBuildingSurfaceIndex;
    }
    const startedMs = nowMs();
    const entries = decorBuildingFeatures.collect(buildingFootprintEntriesForFeature);
    decorBuildingSurfaceIndex = createSpatialIndex(entries);
    decorBuildingSurfaceRevision = decorBuildingFeatures.revision;
    recordLayerFrameMs('decor:buildingIndex', nowMs() - startedMs);
    return decorBuildingSurfaceIndex;
}

function naturalRequestIsStale(currentRequestId) {
    return currentRequestId !== naturalRequestId
        || (fetchController && fetchController.signal && fetchController.signal.aborted);
}

async function refreshNaturalProps(centerLat, centerLon) {
    const config = getLocation().naturalGround;
    if (!config) {
        lastNaturalLat = centerLat;
        lastNaturalLon = centerLon;
        replaceGroup('naturalProps', null);
        return;
    }
    const currentRequestId = ++naturalRequestId;
    lastNaturalLat = centerLat;
    lastNaturalLon = centerLon;
    decorActivityCount += 1;
    try {
        const group = await buildDalmatianNaturalProps(
            centerLat,
            centerLon,
            config,
            () => naturalRequestIsStale(currentRequestId),
        );
        if (naturalRequestIsStale(currentRequestId)) {
            disposeGroup(group);
            return;
        }
        replaceGroup('naturalProps', group);
    } catch (error) {
        if (!naturalRequestIsStale(currentRequestId)) {
            console.warn('[Station3D] natural ground detail build failed', error);
        }
    } finally {
        decorActivityCount = Math.max(0, decorActivityCount - 1);
    }
}

function scheduleNaturalRefresh() {
    if (lastNaturalLat == null || lastNaturalLon == null) return;
    if (!fetchController || (fetchController.signal && fetchController.signal.aborted)) return;
    if (naturalRefreshTimer != null) return;
    naturalRefreshTimer = setTimeout(() => {
        naturalRefreshTimer = null;
        if (lastNaturalLat == null || lastNaturalLon == null) return;
        refreshNaturalProps(lastNaturalLat, lastNaturalLon);
    }, 120);
}

// One greenery response contains two very different things: horizontal
// surfaces that participate in ground ownership, and volumetric forest/flower
// props that do not. Publish only the former through the surface registry;
// assigning a fake ground claim to a tree merely to satisfy validation would
// corrupt both draw contracts and diagnostics.
function prepareGreeneryPublicationGroup(group) {
    if (!group || greenerySurfaceRootByGroup.has(group)) return group;
    const surfaceRoot = new THREE.Group();
    surfaceRoot.name = 'DecorGreenerySurfaces';
    const propsRoot = new THREE.Group();
    propsRoot.name = 'DecorGreeneryProps';
    for (const child of [...group.children]) {
        const coverage = surfacePublicationClaimCoverage(child);
        if (coverage.claimedMeshCount > 0 && !coverage.complete) {
            throw new Error(
                `decor greenery child ${child.name || '(unnamed)'} mixes claimed surfaces and props`,
            );
        }
        const target = coverage.complete
            ? surfaceRoot
            : propsRoot;
        target.add(child);
    }
    group.add(surfaceRoot);
    if (propsRoot.children.length > 0) group.add(propsRoot);
    greenerySurfaceRootByGroup.set(group, surfaceRoot);
    greeneryGroupBySurfaceRoot.set(surfaceRoot, group);
    return group;
}

function setPublishedGreeneryState(group) {
    greeneryGroup = group || null;
    waterMaterials = group?.userData?.waterMaterials || [];
    currentWaterPolygons = group?.userData?.waterPolygons || [];
    currentRunwaySpawns = group?.userData?.runwaySpawns || [];
}

function disposeGreeneryGroup(group) {
    if (!group || disposedGreeneryGroups.has(group)) return;
    disposedGreeneryGroups.add(group);
    releaseInspectionLayerObjects(group);
    disposeGroup(group);
}

function disposeGreeneryPublicationRoot(root) {
    const group = greeneryGroupBySurfaceRoot.get(root) || null;
    if (!group) {
        disposeGroup(root);
        return;
    }
    // Validation can discard a still-detached root. Reattach it to its private
    // container so the ordinary recursive disposer releases both the surface
    // candidate and its non-surface props exactly once.
    if (root.parent !== group) group.add(root);
    disposeGreeneryGroup(group);
}

function publishGreeneryGroup(group, { paint = null, isCurrent = () => true } = {}) {
    if (group && !greenerySurfaceRootByGroup.has(group)) {
        throw new Error('decor greenery candidate was not partitioned for surface publication');
    }
    const previous = greeneryGroup;
    const previousSurfaceRoot = previous
        ? greenerySurfaceRootByGroup.get(previous) || null
        : null;
    const previousWasRegistryOwned = !!previousSurfaceRoot
        && surfacePublications?.getActive?.(GREENERY_SURFACE_PUBLICATION_KEY)?.root
            === previousSurfaceRoot;
    const surfaceRoot = group
        ? greenerySurfaceRootByGroup.get(group) || null
        : null;
    const hasSurfaceMeshes = (surfaceRoot?.children.length || 0) > 0;
    const generation = ++greeneryPublicationGeneration;

    if (surfacePublications) {
        const ticket = surfacePublications.begin({
            key: GREENERY_SURFACE_PUBLICATION_KEY,
            generation,
            parent: scene,
            add: (_context, root) => {
                group.add(root);
                scene.add(group);
            },
            retire: (_context, root) => disposeGreeneryPublicationRoot(root),
            discard: (_context, root) => disposeGreeneryPublicationRoot(root),
        });
        let entry;
        if (surfaceRoot && hasSurfaceMeshes) {
            // The validator requires a detached root. Its private container and
            // prop subtree stay detached too until the registry's add phase.
            group.remove(surfaceRoot);
            entry = { ticket, root: surfaceRoot, isCurrent,
                commit: () => setPublishedGreeneryState(group),
                rollback: () => setPublishedGreeneryState(previous),
            };
        } else {
            // A window with only forest/flower props intentionally clears its
            // old surface owner. Restore the terrain material backstop and add
            // those props before the previous surface root retires.
            entry = { ticket, clear: true, isCurrent,
                commit: () => {
                    if (group) scene.add(group);
                    setPublishedGreeneryState(group);
                },
                rollback: () => {
                    setPublishedGreeneryState(previous);
                    disposeGreeneryGroup(group);
                },
            };
        }
        const batch = surfacePublications.prepareBatch([...(paint ? [paint.entry] : []), entry]);
        const result = typeof batch.publish === 'function' ? batch.publish() : batch;
        if (result.status === 'published') paint?.finalize();
        else {
            paint?.discard();
            if (!hasSurfaceMeshes) disposeGreeneryGroup(group);
        }
        if ((String(result.status).startsWith('published')
            || String(result.status).startsWith('cleared'))
            && previous && !previousWasRegistryOwned) {
            disposeGreeneryGroup(previous);
        }
        return result;
    }

    if (group) scene.add(group);
    setPublishedGreeneryState(group);
    if (previous && previous !== group) disposeGreeneryGroup(previous);
    return { status: group ? 'published-without-registry' : 'cleared-without-registry' };
}

function replaceGroup(prop, group, publication = undefined) {
    const swapStartedMs = nowMs();
    let publicationResult = { status: group ? 'published' : 'cleared' };
    annotateDecorInspection(prop, group);
    if (prop === 'trees')      { if (treesGroup) disposeGroup(treesGroup);      treesGroup = group || null;      if (group) scene.add(group); }
    if (prop === 'greenery') publicationResult = publishGreeneryGroup(group, publication);
    if (prop === 'hedges')     { if (hedgesGroup) disposeGroup(hedgesGroup); hedgesGroup = group || null; if (group) scene.add(group); }
    if (prop === 'crossings')  { if (crossingsGroup) disposeGroup(crossingsGroup); crossingsGroup = group || null; if (group) scene.add(group); }
    if (prop === 'footpaths')  { if (footpathsGroup) disposeGroup(footpathsGroup); footpathsGroup = group || null; if (group) scene.add(group); }
    if (prop === 'benches')    { if (benchesGroup) disposeGroup(benchesGroup); benchesGroup = group || null; if (group) scene.add(group); }
    if (prop === 'fountains')  { if (fountainsGroup) disposeGroup(fountainsGroup); fountainsGroup = group || null; if (group) scene.add(group); }
    if (prop === 'trafficLights') {
        if (trafficLightsGroup) disposeGroup(trafficLightsGroup);
        trafficLightsGroup = group || null;
        if (group) scene.add(group);
        rebuildTrafficSignalCells();
    }
    if (prop === 'naturalProps') { if (naturalPropsGroup) disposeGroup(naturalPropsGroup); naturalPropsGroup = group || null; if (group) scene.add(group); }
    if (prop === 'trees' || prop === 'benches' || prop === 'fountains'
        || prop === 'trafficLights') rebuildDecorObstacleRegistry();
    const swapMs = nowMs() - swapStartedMs;
    if (swapMs >= 1) reportOutOfLoopWork(`decor:swap:${prop}`, swapMs);
    return publicationResult;
}

const DECOR_LAYER_SPECS = {
    trees: ['decor-trees', 'Trees', 'Vegetation', 'OSM tree points and forest instances', 300],
    hedges: ['decor-hedges', 'Hedges', 'Vegetation', 'OSM hedge lines', 302],
    crossings: ['decor-crossings', 'Pedestrian crossings', 'Transport', 'derived crossing paint', 303],
    footpaths: ['decor-footpaths', 'Decor footpaths', 'Transport', 'OSM footpath ribbons', 304],
    benches: ['decor-benches', 'Benches', 'Street furniture', 'OSM bench instances', 305],
    fountains: ['decor-fountains', 'Fountains', 'Street furniture', 'OSM fountain geometry', 306],
    trafficLights: ['decor-traffic-lights', 'Traffic lights', 'Street furniture', 'OSM traffic signals', 307],
    naturalProps: ['decor-natural-ground', 'Natural ground detail', 'Vegetation', 'Dalmatian shrubs and limestone props', 308],
};

function decorSpec(id, label, category, detail, order) {
    return {
        id,
        label,
        category,
        source: `world/decor.js · ${detail}`,
        order,
    };
}

function safeSurfaceId(type) {
    return String(type || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function greeneryInspectionSpec(object) {
    const name = String(object?.name || '');
    if (name.startsWith('DecorSurface:')) {
        const type = name.slice('DecorSurface:'.length) || 'other';
        const greenTypes = /grass|meadow|forest|park|garden|pitch|scrub|wood/i.test(type);
        return decorSpec(
            `landuse-${safeSurfaceId(type)}`,
            greenTypes ? `Grass / land use: ${type}` : `Land-use surface: ${type}`,
            greenTypes ? 'Vegetation' : 'Ground',
            `explicit OSM ${type} polygon`,
            greenTypes ? 310 : 315,
        );
    }
    if (/Water|Shore|Bank/i.test(name)) {
        return decorSpec('inland-water', 'Inland water, banks, and shores', 'Water',
            'OSM inland-water geometry', 320);
    }
    if (/ParkingMarkings/i.test(name)) {
        return decorSpec('parking-markings', 'Parking markings', 'Transport',
            'parking-space paint', 314);
    }
    if (/SurfaceEdging/i.test(name)) {
        return decorSpec('surface-edging', 'Surface edging', 'Ground',
            'land-use boundary edging', 313);
    }
    return decorSpec('decor-landuse-other', 'Other land-use geometry', 'Ground',
        'merged OSM land-use surface', 319);
}

function annotateDecorInspection(prop, group) {
    if (!group) return;
    if (prop !== 'greenery') {
        const spec = DECOR_LAYER_SPECS[prop];
        if (spec) markInspectionLayer(group, decorSpec(...spec));
        return;
    }
    markInspectionLayer(group, {
        id: 'decor-greenery-container',
        label: 'Land-use renderer',
        category: 'Ground',
        source: 'world/decor.js · OSM land use',
        order: 309,
        containerOnly: true,
    });
    group.traverse((object) => {
        if (!object?.isMesh) return;
        markInspectionLayer(object, greeneryInspectionSpec(object));
    });
    // Paint has no mesh of its own. Empty metadata nodes retain the existing
    // category controls without introducing draws or hiding a physical deck.
    for (const id of group.userData.groundPaintLayerIds || []) {
        const layer = new THREE.Object3D();
        layer.name = id === 'surface-edging' ? 'SurfaceEdging' : `DecorSurface:${id.slice(8)}`;
        markInspectionLayer(layer, greeneryInspectionSpec(layer));
        group.add(layer);
    }
}

function isDecorRequestStale(currentRequestId) {
    return currentRequestId !== requestId || (fetchController && fetchController.signal && fetchController.signal.aborted);
}

async function prepareGreeneryPaint(group, paintOwner, previous, isCurrent) {
    const yieldState = createBuildYieldState();
    function* prepare() {
        const rows = yield* groundPaintOwnerReplacementsSteps(
            previous?.userData?.groundPaintOwners || EMPTY_GROUND_PAINT_OWNERS,
            group?.userData?.groundPaintOwners || EMPTY_GROUND_PAINT_OWNERS);
        if (!rows.length) return { paint: null };
        const paint = yield* paintOwner.prepareReplacementsSteps(rows, isCurrent);
        return paint ? { paint } : null;
    }
    const steps = prepare();
    try {
        while (isCurrent()) {
            const next = steps.next();
            if (next.done) return next.value;
            // GPU deferral is a real frame boundary too: account its CPU work
            // before waiting, then reset the clock so wall time cannot force
            // an unnecessary second frame or masquerade as construction cost.
            if (!(await maybeYieldBuild(yieldState, () => !isCurrent(),
                'greenery:paint-publication', next.value?.deferFrame === true))) return null;
        }
        return null;
    } finally { steps.return(); }
}

async function loadAsset(
    currentRequestId,
    terrainGeneration,
    url,
    prop,
    loadIndexedAsset,
    buildGroup,
) {
    decorActivityCount += 1;
    const visibilityRevision = paintVisibilityRevision;
    const requestStale = () => isDecorRequestStale(currentRequestId)
        || (prop === 'greenery' && visibilityRevision !== paintVisibilityRevision);
    const readinessTicket = decorAssetReadiness.begin(prop);
    let group = null;
    let paint = null;
    try {
        const indexedAsset = await loadIndexedAsset();
        if (requestStale()) return;
        if (!decorTerrainGenerationIsCurrent(terrainGeneration)) {
            awaitDecorTerrain(
                terrainGeneration?.centerLat,
                terrainGeneration?.centerLon,
            );
            return;
        }
        group = indexedAsset
            ? await buildGroup(indexedAsset, () => requestStale()
                || !decorTerrainGenerationIsCurrent(terrainGeneration))
            : null;
        if (group) {
            // Acquire the replacement's shader programs BEFORE disposing the
            // old group. Otherwise its last material can release the program,
            // and the next visible draw recompiles it (70 ms on a fountain).
            // No giant geometry upload or offscreen shader variant is needed.
            const prewarm = prewarmDetachedObject(group, {
                renderer, camera, targetScene: scene,
                asyncShaders: true, uploadGeometry: false, prewarmTextures: false,
                label: `decor:${prop}:shader-prewarm`,
            });
            let shaderReady = null;
            try {
                while (!requestStale()
                    && decorTerrainGenerationIsCurrent(terrainGeneration)) {
                    const startedAt = nowMs();
                    const outcome = prewarm.next();
                    shaderReady = outcome.value?.ready || null;
                    reportOutOfLoopWork(`decor:${prop}:shader-prewarm`, nowMs() - startedAt);
                    if (outcome.done) break;
                    await nextAnimationFrame();
                }
            } finally {
                // Cancellation discards the generation, but not a material
                // still being polled by three.js's parallel shader compiler.
                // Keep the old visible group and this detached candidate alive
                // until that one pending compile has settled.
                if (shaderReady) await shaderReady;
                prewarm.return();
            }
        }
        if (requestStale()
            || !decorTerrainGenerationIsCurrent(terrainGeneration)) {
            if (prop === 'greenery') disposeGreeneryGroup(group);
            else disposeGroup(group);
            if (!requestStale()) {
                awaitDecorTerrain(
                    terrainGeneration?.centerLat,
                    terrainGeneration?.centerLon,
                );
            }
            return;
        }
        const paintOwner = groundPaint, previousGreenery = greeneryGroup;
        const publicationCurrent = () => !requestStale()
            && decorTerrainGenerationIsCurrent(terrainGeneration)
            && groundPaint === paintOwner && greeneryGroup === previousGreenery;
        if (prop === 'greenery' && paintOwner) {
            const prepared = await prepareGreeneryPaint(group, paintOwner, previousGreenery, publicationCurrent);
            paint = prepared?.paint || null;
            if (!prepared || !publicationCurrent()) {
                if (!prepared && publicationCurrent()) throw new Error('Decor greenery paint preparation did not produce a publication');
                disposeGreeneryGroup(group); group = null;
                if (!requestStale()) awaitDecorTerrain(terrainGeneration?.centerLat, terrainGeneration?.centerLon);
                return;
            }
        }
        const result = replaceGroup(prop, group, prop === 'greenery' ? { paint, isCurrent: publicationCurrent } : undefined);
        if (!/^(published|cleared)(?:-|$)/.test(result?.status || '')) {
            if (publicationCurrent()) throw new Error(`Decor ${prop} publication rejected: ${result?.status || 'unknown'}`);
            if (!requestStale()) awaitDecorTerrain(terrainGeneration?.centerLat, terrainGeneration?.centerLon);
            group = null; // Rejected candidates are disposed by the publication owner.
            return;
        }
        decorAssetReadiness.complete(readinessTicket, { empty: !group });
        group = null; // Published ownership belongs to replaceGroup now.
    } catch (err) {
        if (prop === 'greenery') disposeGreeneryGroup(group);
        else disposeGroup(group);
        if (requestStale()) return;
        if (!decorTerrainGenerationIsCurrent(terrainGeneration)) {
            // Cooperative geometry compilers can signal cancellation by
            // throwing. A superseded receiver is pending replacement, not a
            // failed current producer or permission to publish stale detail.
            awaitDecorTerrain(terrainGeneration?.centerLat, terrainGeneration?.centerLon);
            return;
        }
        decorAssetReadiness.fail(readinessTicket, err);
        console.warn('[Station3D] decor asset build failed', url, err);
    } finally {
        paint?.discard();
        decorActivityCount = Math.max(0, decorActivityCount - 1);
    }
}

// Fetch one decor kind for the moving render window. The API returns the same
// payload shapes as the legacy Zagreb bake, so indexing and geometry stay
// shared; only the transport changes.
const DECOR_API_RADIUS_BY_KIND_M = Object.freeze({
    trees: 1800,
    greenery: GREENERY_RADIUS_M,
    hedges: 1500,
    crossings: 1200,
    benches: 1200,
    fountains: 1200,
    traffic_lights: TRAFFIC_LIGHT_RADIUS_M,
});
// Curbs asks for the greenery index before the deferred decor layer begins.
// Keep exact same-session requests as one promise so the later surface build
// reuses both the response parse and the prepared spatial index. Associate the
// entry with the session AbortSignal: a new session must not inherit stale DB
// data merely because it starts at the same coordinate.
const DECOR_ASSET_REQUEST_CACHE_LIMIT = 24;
const decorAssetRequestCache = new Map();

function fetchDecorAsset(
    kind,
    centerLat,
    centerLon,
    prepareFn,
    explicitSignal,
    explicitRequestScheduler = null,
) {
    const radiusM = DECOR_API_RADIUS_BY_KIND_M[kind] || GREENERY_RADIUS_M;
    const dLat = radiusM / (DEG_TO_RAD * EARTH_RADIUS_M);
    const dLon = dLat / Math.max(0.01, Math.cos(centerLat * DEG_TO_RAD));
    const bbox = [
        centerLon - dLon,
        centerLat - dLat,
        centerLon + dLon,
        centerLat + dLat,
    ].join(',');
    const url = `${getApiBase()}/decor?kind=${encodeURIComponent(kind)}&bbox=${bbox}`;
    const signal = explicitSignal || fetchController?.signal || null;
    const cached = decorAssetRequestCache.get(url);
    if (cached && cached.signal === signal && !signal?.aborted) return cached.promise;

    const entry = { signal, promise: null };
    const options = signal ? { signal } : {};
    const run = async () => {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    };
    const scheduler = explicitRequestScheduler || networkRequestScheduler;
    const dataPromise = typeof scheduler?.scheduleNetworkRequest === 'function'
        ? scheduler.scheduleNetworkRequest({
            label: `decor:${kind}`,
            groupKey: 'decor-assets',
            groupLimit: 2,
            priority: { tier: 'support', score: 4e12 },
            signal,
            run,
        })
        : run();
    entry.promise = dataPromise
        .then((payload) => {
            const prepareStartedMs = nowMs();
            const prepared = prepareFn(payload);
            const prepareMs = nowMs() - prepareStartedMs;
            if (prepareMs >= 1) reportOutOfLoopWork(`decor:prepare:${kind}`, prepareMs);
            return prepared;
        })
        .catch((error) => {
            if (decorAssetRequestCache.get(url) === entry) decorAssetRequestCache.delete(url);
            throw error;
        });
    decorAssetRequestCache.set(url, entry);
    while (decorAssetRequestCache.size > DECOR_ASSET_REQUEST_CACHE_LIMIT) {
        decorAssetRequestCache.delete(decorAssetRequestCache.keys().next().value);
    }
    return entry.promise;
}

function refresh(centerLat, centerLon) {
    requestId += 1;
    decorAssetReadiness.reset();
    const rid = requestId;
    lastLat = centerLat;
    lastLon = centerLon;
    const terrainGeneration = decorTerrainGenerationToken(centerLat, centerLon);
    if (!terrainGeneration) {
        awaitDecorTerrain(centerLat, centerLon);
        return false;
    }
    terrainAwaitingDecorCenter = null;
    const location = getLocation();

    if (location.naturalGround) refreshNaturalProps(centerLat, centerLon);

    if (location.apiDecor) {
        const tag = `${centerLat.toFixed(3)},${centerLon.toFixed(3)}`;
        loadAsset(rid, terrainGeneration, `decor:trees@${tag}`, 'trees',
            () => fetchDecorAsset('trees', centerLat, centerLon, prepareTreesAsset),
            (index, shouldCancel) => buildTreesGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        loadAsset(rid, terrainGeneration, `decor:greenery@${tag}`, 'greenery',
            () => fetchDecorAsset('greenery', centerLat, centerLon, prepareGreeneryAsset),
            (index, shouldCancel) => buildGreeneryGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        loadAsset(rid, terrainGeneration, `decor:hedges@${tag}`, 'hedges',
            () => fetchDecorAsset('hedges', centerLat, centerLon, prepareHedgesAsset),
            (index, shouldCancel) => buildHedgesGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        loadAsset(rid, terrainGeneration, `decor:crossings@${tag}`, 'crossings',
            () => fetchDecorAsset('crossings', centerLat, centerLon, prepareCrossingsAsset),
            (index, shouldCancel) => buildCrossingsGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        // /roads/cab is the single rendered owner for OSM footways, paths and
        // cycleways. The legacy compact footpath feed contains the same OSM
        // segments without ids or tags; loading both created two ribbons that
        // diverged vertically beside Hrvatske bratske zajednice.
        loadAsset(rid, terrainGeneration, `decor:benches@${tag}`, 'benches',
            () => fetchDecorAsset('benches', centerLat, centerLon, prepareBenchesAsset),
            (index, shouldCancel) => buildBenchesGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        // Fountains were baked-only until now, so this branch used to return six
        // kinds where the baked branch below builds seven — switching a city to
        // apiDecor silently dropped every fountain.
        loadAsset(rid, terrainGeneration, `decor:fountains@${tag}`, 'fountains',
            () => fetchDecorAsset('fountains', centerLat, centerLon, prepareFountainsAsset),
            (index, shouldCancel) => buildFountainsGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
        if (trafficLightsEnabled) {
            loadAsset(rid, terrainGeneration, `decor:traffic_lights@${tag}`, 'trafficLights',
                () => fetchDecorAsset('traffic_lights', centerLat, centerLon, prepareTrafficLightsAsset),
                (index, shouldCancel) => buildTrafficLightsGroup(
                    index,
                    anchorLat,
                    anchorLon,
                    centerLat,
                    centerLon,
                    shouldCancel,
                ));
        }
        return true;
    }

    // No baked-file branch any more: every location sets apiDecor, decor lives in
    // public.osm_decor, and the website/zagreb_tram_*.json assets this used to read
    // are gone. Reaching here means a location was configured with neither apiDecor
    // nor naturalGround — a config error worth hearing about rather than a silent
    // empty world.
    console.warn('[Station3D] decor: location has no apiDecor source',
        location.id || '(unnamed)');
    return true;
}

function refreshGreeneryPaintVisibility() {
    if (!groundPaint || lastLat == null || lastLon == null) return;
    const centerLat = lastLat, centerLon = lastLon;
    const terrainGeneration = decorTerrainGenerationToken(centerLat, centerLon);
    if (!terrainGeneration) { awaitDecorTerrain(centerLat, centerLon); return; }
    const tag = `${centerLat.toFixed(3)},${centerLon.toFixed(3)}`;
    loadAsset(requestId, terrainGeneration, `decor:greenery@${tag}`, 'greenery',
        () => fetchDecorAsset('greenery', centerLat, centerLon, prepareGreeneryAsset),
        (index, shouldCancel) => buildGreeneryGroup(index, anchorLat, anchorLon, centerLat, centerLon, shouldCancel));
}

export function rebuildDecorForProposalMask(maskPredicate = null) {
    decorMaskPredicate = typeof maskPredicate === 'function' ? maskPredicate : null;
    if (lastLat == null || lastLon == null) return;
    refresh(lastLat, lastLon);
}

// The campaign layer that owns a cleared footprint publishes it here and
// withdraws it when its session ends; a live session re-culls at once.
export function setCampaignDecorMask(maskPredicate = null) {
    const next = typeof maskPredicate === 'function' ? maskPredicate : null;
    if (next === campaignDecorMask) return;
    campaignDecorMask = next;
    if (lastLat == null || lastLon == null) return;
    refresh(lastLat, lastLon);
}

export const decorLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        fetchController: ctrl,
        initialPose,
        customTrackCorridors,
        otherTracks,
        allStops,
        sharedTileSession,
        terrain,
        actorGroundYAt,
        sessionCapabilities,
        groundPaint: paintOwner,
        surfacePublications: publicationRegistry,
    }) {
        decorAssetReadiness.reset();
        decorInitialized = true;
        surfacePublications = publicationRegistry || null;
        groundPaint = paintOwner || null;
        paintVisibilitySubscription?.();
        paintVisibilitySubscription = null;
        paintVisibilityRevision++;
        paintVisibilityRefreshPending = false;
        if (groundPaint) {
            const ids = new Set(['surface-edging', ...DECOR_LANDUSE_TYPES.map(type => `landuse-${type}`),
                'landuse-parking', 'landuse-construction']);
            const key = hidden => [...hidden].filter(id => ids.has(id)).sort().join('|');
            let previous = key(hiddenInspectionLayerIds());
            paintVisibilitySubscription = subscribeInspectionLayerVisibility(hidden => {
                const next = key(hidden);
                if (next === previous) return;
                previous = next;
                paintVisibilityRevision++;
                paintVisibilityRefreshPending = true;
            });
        }
        greeneryPublicationGeneration = 0;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        terrainRefreshPending = false;
        terrainAwaitingDecorCenter = null;
        trafficLightsEnabled = sessionCapabilityEnabled(
            sessionCapabilities,
            SESSION_CAPABILITY.TRAFFIC_LIGHTS,
        );
        trafficSignalElapsedSeconds = 0;
        trafficSignalCells.clear();
        // Locations can use either the legacy Zagreb bake or the multi-city
        // bbox API. A location with neither source avoids speculative 404s.
        const location = getLocation();
        if (!location.decorEnabled && !location.apiDecor && !location.naturalGround) {
            terrainReference = null;
            renderedGroundYAt = null;
            console.log('[Station3D] decor disabled for this location (no bake or API source)');
            return;
        }
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        renderedGroundYAt = typeof actorGroundYAt === 'function' ? actorGroundYAt : null;
        terrainChangeSubscription = terrainReference?.onChange?.(() => {
            terrainRefreshPending = true;
        }) || null;
        destroyedDecorPropIds.clear();
        activeDecorObstacles.clear();
        clearAmbientBenchSeats(DECOR_BENCH_OWNER);
        fetchController = ctrl;
        networkRequestScheduler = sharedTileSession || null;
        waterMaterials = [];
        currentWaterPolygons = [];
        currentRunwaySpawns = [];
        customTrackCorridorVolumes = buildTrackCorridorVolumes(
            customTrackCorridors,
            anchorLat,
            anchorLon,
        ).concat(buildPlannerStationClearanceVolumes(
            allStops,
            otherTracks,
            anchorLat,
            anchorLon,
        ));
        customElevatedTrackCorridorVolumes = buildTrackCorridorVolumes(
            customTrackCorridors,
            anchorLat,
            anchorLon,
            {
                segmentFilter: ({ startElevationM, endElevationM }) =>
                    isPlannerElevatedSegment(startElevationM, endElevationM, 0.5),
            },
        );
        // Do not clear an already-installed proposal mask here. Proposals are
        // immediate while decor is deferred, so their data can resolve and
        // call rebuildDecorForProposalMask() before this beginSession runs.
        // endSession owns the reset between sessions; clearing here reopened a
        // race in which benches and other props reappeared inside proposal
        // lakes depending only on network timing.
        lastLat = null;
        lastLon = null;
        lastDecorHeadingDeg = null;
        lastDecorHeadingChangeMs = 0;
        lastNaturalLat = null;
        lastNaturalLon = null;
        lastNaturalStyle = location.naturalGround?.style || null;
        naturalRequestId += 1;
        if (mappedSeaSubscription) mappedSeaSubscription();
        mappedSeaSubscription = location.naturalGround
            ? subscribeMappedSeaChanges(() => {
                scheduleNaturalRefresh();
                // The first greenery build may have deliberately withheld OSM
                // water while the canonical sea query was unresolved. Reuse
                // the cached decor response once that query classifies this
                // window as coastal or inland.
                if (lastLat != null && lastLon != null) refresh(lastLat, lastLon);
            })
            : null;
        if (roadTileSubscription) roadTileSubscription();
        roadTileSubscription = null;
        roadTileSource = null;
        decorRoadFeatures.clear();
        invalidateDecorRoadSurfaceIndex();
        if (buildingTileSubscription) buildingTileSubscription();
        buildingTileSubscription = null;
        buildingTileSource = null;
        decorBuildingFeatures.clear();
        invalidateDecorBuildingSurfaceIndex();
        if (decorRoadRefreshTimer != null) {
            clearTimeout(decorRoadRefreshTimer);
            decorRoadRefreshTimer = null;
        }
        if (naturalRefreshTimer != null) {
            clearTimeout(naturalRefreshTimer);
            naturalRefreshTimer = null;
        }
        if (sharedTileSession) {
            roadTileSource = sharedTileSession.getSource({
                key: 'roads:cab',
                label: 'roads',
                url: (bb) => `${getApiBase()}/roads/cab?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
                ...NEAR_ROAD_STREAM_OPTIONS,
            });
            roadTileSubscription = roadTileSource.subscribe({
                // Only schedule when the deduplicated set actually changed. An
                // overlapping bbox that re-delivers roads a neighbouring tile
                // already owns is a no-op, and used to buy a full index rebuild.
                onFetch: (features, tileKey) => {
                    if (decorRoadFeatures.setTile(tileKey, features)) scheduleDecorRoadRefresh();
                },
                onEvict: (tileKey) => {
                    if (decorRoadFeatures.removeTile(tileKey)) scheduleDecorRoadRefresh();
                },
            });
            roadTileSource.ensureAround(0, 0);

            const buildingSource = buildingTileSourceForLocation(location);
            buildingTileSource = sharedTileSession.getSource({
                key: buildingSource.key,
                label: 'buildings',
                url: (bb) => `${getApiBase()}/${buildingSource.endpoint}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}${buildingSource.querySuffix}`,
                ...DETAILED_BUILDING_STREAM_OPTIONS,
            });
            buildingTileSubscription = buildingTileSource.subscribe({
                onFetch: (features, tileKey) => {
                    if (decorBuildingFeatures.setTile(tileKey, features)) scheduleNaturalRefresh();
                },
                onEvict: (tileKey) => {
                    if (decorBuildingFeatures.removeTile(tileKey)) scheduleNaturalRefresh();
                },
            });
            buildingTileSource.ensureAround(0, 0);
        }
        if (initialPose) refresh(initialPose.lat, initialPose.lon);
    },
    onFrame(pose) {
        if (paintVisibilityRefreshPending) {
            paintVisibilityRefreshPending = false;
            refreshGreeneryPaintVisibility();
        }
        trafficSignalElapsedSeconds = (typeof performance !== 'undefined'
            ? performance.now() : Date.now()) / 1000;
        updateTrafficLightColors(trafficLightsGroup, trafficSignalElapsedSeconds);
        const headingDeg = Number(pose?.headingDeg);
        if (Number.isFinite(headingDeg)) {
            if (lastDecorHeadingDeg == null) {
                lastDecorHeadingDeg = headingDeg;
            } else {
                const headingDelta = Math.abs(
                    ((headingDeg - lastDecorHeadingDeg + 540) % 360) - 180,
                );
                // Keep the old sample across sub-threshold jitter so a genuinely
                // slow turn eventually accumulates enough delta to be detected.
                if (headingDelta > 0.01) {
                    lastDecorHeadingDeg = headingDeg;
                    lastDecorHeadingChangeMs = nowMs();
                }
            }
        }
        if (waterMaterials.length > 0) {
            animateWaterMaterials(waterMaterials, (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
        }
        if (terrainRefreshPending) {
            terrainRefreshPending = false;
            // The decor world is already a bounded 1.2–1.8 km moving window.
            // Reuse its cached assets and cooperative builders at the current
            // decor centre so every seated vertex/instance samples the new DTM.
            const retryLat = terrainAwaitingDecorCenter?.lat ?? lastLat;
            const retryLon = terrainAwaitingDecorCenter?.lon ?? lastLon;
            if (retryLat != null && retryLon != null) {
                refresh(retryLat, retryLon);
                return;
            }
        }
        if (!pose || lastLat == null) return;
        const naturalStyle = getLocation().naturalGround?.style || null;
        const naturalStyleChanged = naturalStyle !== lastNaturalStyle;
        if (naturalStyleChanged) lastNaturalStyle = naturalStyle;
        const generalDistanceM = haversineMeters(pose.lat, pose.lon, lastLat, lastLon);
        if (generalDistanceM >= DECOR_REBUILD_M) {
            refresh(pose.lat, pose.lon);
            return;
        }
        if (naturalStyleChanged) refreshNaturalProps(pose.lat, pose.lon);
        const naturalConfig = getLocation().naturalGround;
        if (naturalConfig && lastNaturalLat != null && haversineMeters(
            pose.lat,
            pose.lon,
            lastNaturalLat,
            lastNaturalLon,
        ) >= (Number(naturalConfig.rebuildM) || 280)) {
            refreshNaturalProps(pose.lat, pose.lon);
        }
    },
    endSession() {
        requestId += 1;  // invalidate any in-flight fetches
        decorAssetReadiness.reset();
        decorInitialized = false;
        groundPaint = null;
        paintVisibilitySubscription?.();
        paintVisibilitySubscription = null;
        paintVisibilityRevision++;
        paintVisibilityRefreshPending = false;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        terrainRefreshPending = false;
        terrainAwaitingDecorCenter = null;
        if (treesGroup)     { disposeGroup(treesGroup);     treesGroup = null; }
        const retiringGreeneryGroup = greeneryGroup;
        const retiringGreenerySurfaceRoot = retiringGreeneryGroup
            ? greenerySurfaceRootByGroup.get(retiringGreeneryGroup) || null
            : null;
        setPublishedGreeneryState(null);
        if (retiringGreeneryGroup) {
            if (!retiringGreenerySurfaceRoot
                || !surfacePublications?.retire?.(
                    GREENERY_SURFACE_PUBLICATION_KEY,
                    {
                        root: retiringGreenerySurfaceRoot,
                        reason: 'decor-session-ended',
                    },
                )) {
                disposeGreeneryGroup(retiringGreeneryGroup);
            }
        }
        if (hedgesGroup)    { disposeGroup(hedgesGroup);    hedgesGroup = null; }
        if (crossingsGroup) { disposeGroup(crossingsGroup); crossingsGroup = null; }
        if (footpathsGroup) { disposeGroup(footpathsGroup); footpathsGroup = null; }
        if (benchesGroup)   { disposeGroup(benchesGroup);   benchesGroup = null; }
        if (fountainsGroup) { disposeGroup(fountainsGroup); fountainsGroup = null; }
        if (trafficLightsGroup) { disposeGroup(trafficLightsGroup); trafficLightsGroup = null; }
        if (naturalPropsGroup) { disposeGroup(naturalPropsGroup); naturalPropsGroup = null; }
        destroyedDecorPropIds.clear();
        activeDecorObstacles.clear();
        clearAmbientBenchSeats(DECOR_BENCH_OWNER);
        trafficSignalCells.clear();
        trafficLightsEnabled = false;
        trafficSignalElapsedSeconds = 0;
        waterMaterials = [];
        currentWaterPolygons = [];
        currentRunwaySpawns = [];
        customTrackCorridorVolumes = [];
        customElevatedTrackCorridorVolumes = [];
        decorMaskPredicate = null;
        lastLat = null;
        lastLon = null;
        lastDecorHeadingDeg = null;
        lastDecorHeadingChangeMs = 0;
        lastNaturalLat = null;
        lastNaturalLon = null;
        lastNaturalStyle = null;
        renderedGroundYAt = null;
        naturalRequestId += 1;
        if (mappedSeaSubscription) mappedSeaSubscription();
        mappedSeaSubscription = null;
        if (roadTileSubscription) roadTileSubscription();
        roadTileSubscription = null;
        roadTileSource = null;
        decorRoadFeatures.clear();
        invalidateDecorRoadSurfaceIndex();
        if (buildingTileSubscription) buildingTileSubscription();
        buildingTileSubscription = null;
        buildingTileSource = null;
        decorBuildingFeatures.clear();
        invalidateDecorBuildingSurfaceIndex();
        if (decorRoadRefreshTimer != null) {
            clearTimeout(decorRoadRefreshTimer);
            decorRoadRefreshTimer = null;
        }
        if (naturalRefreshTimer != null) {
            clearTimeout(naturalRefreshTimer);
            naturalRefreshTimer = null;
        }
        fetchController = null;
        networkRequestScheduler = null;
        decorAssetRequestCache.clear();
        terrainReference = null;
        surfacePublications = null;
    },
};

export function setDecorSessionCapabilities(capabilities) {
    const next = sessionCapabilityEnabled(capabilities, SESSION_CAPABILITY.TRAFFIC_LIGHTS);
    if (trafficLightsEnabled === next) return;
    trafficLightsEnabled = next;
    if (lastLat != null && lastLon != null) refresh(lastLat, lastLon);
}
