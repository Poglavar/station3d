// Building rendering for all three data sources (footprint / GDI LOD2 /
// Overture). Exposes two entry points:
//
//   buildingsLayer.{beginSession, onFrame, endSession}  — cab-mode tile streaming
//   loadBuildingsRadius / loadCatchmentStats            — static-mode radius load
//
// Deduplicates by object_id across overlapping tile fetches. Cab sessions use
// a shared tile source so buildings, passages, and nests can all
// reuse one fetch/evict ring for the same endpoint.
//
// PROPOSALS. When the deeplink carries ?proposals=, every fetched batch passes through
// applyProposalCarve() before anything is built. Road proposals use the server's detailed
// razed/cut/tunnel verdicts. Proposed tracks use a deliberately binary local rule: if their
// construction corridor touches a building, the solid building is removed and replaced by a
// transparent whole-building ghost. Both fetch paths await proposalsReady() first, so a building
// is never built before its fate is known. See world/proposals.js.

import * as THREE from 'three';
import { logStamp } from '../core/log-stamp.js';
import { appendArrayValues } from '../core/array-append.js';
import { createMutableBoundsGrid } from '../core/bounds-grid.js';
import {
    DEG_TO_RAD,
    EARTH_RADIUS_M,
    finiteOrNull,
    makeCircleRing,
} from '../core/math.js';
import { offsetPolygonOutward } from '../core/ring-offset.js';
import { groundCoverNoteBuildingRect } from './ground-cover.js';
import { disposeGroup, registerShared, unregisterShared, isShared } from '../core/dispose.js';
import { brickTextureData, boxProjectedUvs } from '../core/brick-texture.js';
import { getApiBase } from '../core/api.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';
import {
    belongsInBuildingLayer,
    buildingPipelineForFeature,
    PIPELINE_MESH,
} from '../core/building-pipeline.js';
import {
    publishDetailedTile,
    resetDetailed,
    setDetailed,
    setDetailedTile,
} from './building-lod-registry.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_WAIT_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
    getFrameChunkWorkMotionState,
} from '../core/frame-chunk-queue.js';
import { buildingAggregateDrainPolicy } from '../core/building-aggregate-drain-policy.js';
import { createCooperativeBuildTask } from '../core/cooperative-build-task.js';
import {
    advanceRoadFormationDependency,
    foundationFormationWaitAllowanceMs,
    pendingRoadFormationChangeTouches,
    roadFormationWaitExpired,
} from '../core/road-formation-dependency.js';
import {
    localizeGdiFace,
    localizeGdiFaceCooperative,
} from '../core/gdi-face-localization.js';
import {
    classifyViewPriority,
    featureLocalBounds,
    tileLocalBounds,
} from '../core/view-priority.js';
import { buildingTileBuildPriority } from '../core/building-tile-priority.js';
import {
    isWorldBuilding,
    noteWorldQueueActive,
    noteWorldQueueIdle,
} from '../core/world-ready.js';
import {
    camera,
    scene,
    renderer,
    buildingMaterial,
    BUILDING_RADIUS_M,
    getRenderQualityContext,
} from '../scene/setup.js';
import { STATION3D_QUALITY_PROFILES } from '../core/quality-profile.js';
import { t } from '../core/i18n.js';
import {
    DETAILED_BUILDING_STREAM_OPTIONS,
    DETAILED_BUILDING_AHEAD,
    GTA_DETAILED_BUILDING_AHEAD,
    DETAILED_BUILDING_TILE_M,
    tileBbox,
} from '../core/tile-stream.js';
import { initialWorldSupportTileKeys } from '../core/initial-world-support.js';
import {
    isMaskedByProposals,
    featureCentroidLatLon,
    isFeatureMaskedByProposalBuildings,
    isFeatureDemolishedByProposalTrack,
    recordTrackDemolition,
    getLegacyBuildingCarve,
    proposalsReady,
} from './proposals.js';
import {
    buildFacadePhotoMesh,
    buildFacadeWindowMeshes,
    clearFacadePhotoTextureCache,
    ensureFacadeWindowData,
    hasFacadeWindows,
} from './facade-windows.js';
import { PASSAGE_HEIGHT_M } from './passage-geometry.js';
import { ensureFacadeSpecData, hasFacadeSpec, buildFacadeSpecGroup } from './facade-spec.js';
import { ensureMassingOverrideData, massingOverrideFor } from './massing-overrides.js';
import { ensureFacadeColorData, facadeColorFor } from './facade-color.js';
import { buildFacadeExposureIndex, logicalFacadeBordersBuilding } from './facade-exposure.js';
import {
    buildLogicalFacadeSurfaces,
    buildLogicalFacadeSurfacesCooperative,
    prepareFacadeCoverageIndexCooperative,
    rectangleFullyCoveredBySurface,
    getFacadeHeadHeight,
    clipTriangleBelowY,
    mergeDuplicateWallSurfaces,
    buildSharedWallIndex,
    wallFaceIsShortCopy,
    tallerWallCoverageRects,
} from './facade-surfaces.js';
import { restoreFacadeTopologyCache } from '../core/facade-topology-cache.js';
import {
    fetchStreetFacingFacades,
    buildStreetFacingIndex,
    classifyStreetFacingSurface,
} from './street-facing.js';
import { pushContactAoSkirt, buildContactAoMesh } from './contact-ao.js';
import {
    assembleContactAoBatch,
    createRevisionGuardedContactAoTask,
} from '../core/contact-ao-batch.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import {
    buildFoundationSkirtPositionsCooperative,
    composeFoundationGroundSampler,
    foundationSegmentsForMeshFeatureCooperative,
    foundationSegmentsFromFootprint,
    foundationSegmentsFromWallFaces,
    prepareFoundationSkirtBuffersCooperative,
} from '../core/foundation-skirt.js';
import {
    buildRoofDrainageMesh,
    getRoofDrainageMaterial,
    GUTTER_MIN_FOOTPRINT_M2,
    pickDownpipeU,
    pushDownpipe,
    pushEavesGutter,
    surfaceCarriesEaves,
} from './roof-drainage.js';
import { buildingTileSourceForLocation, getLocation, LOCATIONS } from '../core/locations.js';
import { createStopShelterGroup } from '../models/objects/stop-shelter.js';
import {
    buildFootprintWallGeometry,
    buildGreenhouseRowsGeometry,
    buildOvertureFacadeBatches,
    buildGabledRoofGeometry,
    buildHippedRoofGeometry,
    estimateOvertureBuildingHeight,
    GREENHOUSE_RIDGE_HEIGHT_M,
    isGreenhouseBuilding,
    proceduralRoofHeightM,
} from '../core/overture-building-shape.js';
import {
    buildingEntityMetadata,
    stampEntityTree,
} from '../core/entity-metadata.js';
import {
    registerAggregateEntityRanges,
    registerEntityObject,
    unregisterEntityTree,
} from '../core/entity-interaction.js';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { createOwnerRangeRaycast } from '../core/owner-range-raycast.js';
import { createAggregateGate } from '../core/aggregate-gate.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { createQueuedShaderWarmup } from '../core/queued-shader-warmup.js';
import {
    createFacadeAtlasLayout,
    remapFacadeAtlasUvs,
} from '../core/facade-atlas-layout.js';
import {
    closeFacadeTextureScale,
    createCloseFacadeRecordIndex,
} from '../core/facade-close-lod.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { createDalmatianStoneRaster } from '../core/dalmatian-stone-texture.js';
import { createFoundationWeatheringRaster } from '../core/foundation-weathering-texture.js';
import { footprintMatchesRenderedBounds } from '../core/pedestrian-routing.js';
import { planRegionalTileRebuild, takeNextTileRebuild } from '../core/regional-tile-rebuild.js';
import { createBuildingGroundDependencyCache } from '../core/building-ground-dependencies.js';
import { createOwnedResourceCache, createMeshResourceBindings } from '../core/owned-resource-cache.js';
import { buildingGeometryMemory, bindGeometryMemory, publishGeometryMemory } from '../core/geometry-memory-budget.js';
import { statedNightIntensity } from '../core/stated-night-lights.js';
import { buildNewBuildRoofDecorMeshes } from './new-build-roof-decor.js';
import {
    clearRoofActivitySurfaces,
    registerRoofActivitySurface,
    unregisterRoofActivityOwner,
} from './roof-activity-registry.js';
import { buildNewBuildCourtyardMesh } from './new-build-courtyard.js';
import { dedupeTwinFeatures } from '../core/dedupe-twin-features.js';
import { wallWindowLightAt } from '../core/facade-window-lights.js';
import { isStaticallyBlockedBuildingObjectId } from '../core/building-suppression.js';
import {
    isProposalBuildingBucketKey,
    isProposalBuildingFeature,
    isProposalBuildingObjectId,
    isProposalBuildingTileKey,
} from '../core/proposal-building-features.js';
import {
    NEW_BUILD_WALL_FINISHES,
    NEW_BUILD_WALL_PALETTE,
    NEW_BUILD_WINDOW_STYLE_BASE,
    getLowRiseFacadeStyle,
    getPitchedRoofStyle,
    hasFlatRoof,
    hasMassiveVolumeCurtain,
    kanalicaHeightAt,
    newBuildWindowStyles,
    resolveFacadeWindowStyle,
} from '../core/building-architectural-style.js';

// Load detected real-window data (object_id → world-space windows) once, so
// buildings that have it render their actual openings instead of the
// procedural grid. Lazy fetch; buildings built before it lands just use the grid.
ensureFacadeWindowData();
ensureFacadeSpecData();
ensureMassingOverrideData();
// Measured wall colours. Unlike the tower data this does NOT gate the build: a building
// that renders before it lands just gets the palette, which is the pre-existing look.
ensureFacadeColorData();

const BUILDING_MATERIAL_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.BUILDING,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
    ownerId: 'building-material',
    sourceId: 'world/buildings.js',
});

// 'footprint' = gdi_building_footprint (ArcGIS/GDI aerial survey, Z_Delta extrusion)
// 'gdi'       = gdi_building_3d (GDI LOD2 meshes — actual 3D face geometry)
// 'overture'  = overture_building_footprint (Overture Maps — footprint + height)
// (Renamed 2026-07-14 to source-prefixed names — building_footprint / building_3d /
//  zagreb_building_overture are now DEPRECATED compat views. We read these via the
//  cadastre API, not the DB, so nothing here queries them by name.)
// Chosen from the active spatial session. The national mesh endpoint resolves
// the best available survey independently for every requested bbox.
// Effective source can fall back at load time: a bespoke city survey (GDI)
// ends at the city's administrative boundary, and a session anchored outside
// it (Velika Gorica, the airport) would otherwise have NO buildings at all.
// When the bespoke source returns zero features, Overture takes over for the
// session — the meshing branches below read this variable, never the config.
let BUILDING_SOURCE = getLocation().buildings;

// Country/corridor sessions keep their data-source identity (`croatia`,
// `zagreb-split`, …) while presentation follows a nearby prepared city. Read
// that live style id at build time so newly streamed tiles do not remain stuck
// on the architecture that happened to be active when this module imported.
function architecturalLocationId() {
    const location = getLocation();
    return location.styleCityId && LOCATIONS[location.styleCityId]
        ? location.styleCityId
        : location.id;
}

function architecturalLocationConfig() {
    const id = architecturalLocationId();
    const location = getLocation();
    const config = { id, ...(LOCATIONS[id] || location) };
    // `nearest-city` is a broad regional look, not a grant of a city's narrow
    // coordinate-specific exceptions. In particular, Zagreb's airport-hall
    // curtain rule must not spread across every continental town whose nearest
    // prepared style happens to be Zagreb.
    if (location.styleFrom === 'nearest-city' && !location.styleCityContainsPosition) {
        config.massiveVolumeCurtains = null;
    }
    return config;
}

function architecturalPresentationKey() {
    const location = getLocation();
    const localPolicy = location.styleFrom !== 'nearest-city'
        || location.styleCityContainsPosition === true;
    return `${architecturalLocationId()}:${localPolicy ? 'local' : 'regional'}`;
}

function activePitchedRoofStyle() {
    return getPitchedRoofStyle(architecturalLocationId());
}

// A tile may be built from a DIFFERENT source than the location's configured one
// — see the per-tile Overture fallback in attachBuildingsTileSource. BUILDING_SOURCE
// drives feature construction, demolition-ghost geometry, the street-facing gate and
// the GDI terrain lift; all of those are reached SYNCHRONOUSLY from the tile's build
// callback, so the source is scoped around that call rather than threaded through
// four read sites in three functions. Restores on the way out, including on throw.
function withTileBuildingSource(source, run) {
    if (!source || source === BUILDING_SOURCE) return run();
    const previous = BUILDING_SOURCE;
    BUILDING_SOURCE = source;
    try {
        return run();
    } finally {
        BUILDING_SOURCE = previous;
    }
}
// Facade display toggles:
//   P — for buildings WITH detection data, swap synthesised window quads ↔ the
//       glued Street View photo.
//   O — master openings toggle: hide ALL procedural/detected window and door
//       overlays. The underlying building geometry and materials never change.
//   Shift+F — facade-spec override: buildings with a recognized 3D facade spec
//       show the full relief facade instead of window quads / photo. Optional;
//       ON by default. Buildings without a spec are unaffected. (Plain F is the
//       stats-overlay toggle in scene/animate.js.)
let facadePhotoMode = false;
let showOpenings = true;
let facadeSpecMode = true;
// Display toggle for SOLID proposal buildings (the proposals layer's massing
// rendered through this pipeline). Consulted wherever their meshes are created
// — individual leftovers, AO/drainage batches, aggregates — so a mesh landing
// after a toggle lands in the right state. The proposals layer drives it via
// setProposalBuildingMeshesVisible().
let proposalBuildingMeshesVisible = true;
function applyFacadeVisibility() {
    if (!buildingsGroup) return;
    buildingsGroup.traverse((m) => {
        const u = m.userData;
        if (!u) return;
        if (u.facadeCloseDetail) m.visible = showOpenings;
        // Procedural window overlays are NOT toggled here any more: they merge
        // into shared aggregates, where per-building visibility does not exist.
        // The O toggle was a testing aid; the detected-window, photo and spec
        // facades below are separate per-building meshes and still respond.
        if (u.facadeWindow) m.visible = showOpenings && !facadePhotoMode && !(facadeSpecMode && u.hasSpecSibling);
        else if (u.facadePhoto) m.visible = showOpenings && facadePhotoMode && !(facadeSpecMode && u.hasSpecSibling);
        else if (u.facadeSpecRoot) m.visible = showOpenings && facadeSpecMode;
    });
}
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const k = (e.key || '').toLowerCase();
        if (k === 'p') {
            facadePhotoMode = !facadePhotoMode;
            applyFacadeVisibility();
            console.log('[facade] photo mode:', facadePhotoMode ? 'ON (glued photo)' : 'OFF (window quads)');
        } else if (k === 'o') {
            showOpenings = !showOpenings;
            applyFacadeVisibility();
            console.log('[facade] openings:', showOpenings ? 'ON' : 'OFF (bare walls)');
        } else if (k === 'f' && e.shiftKey) {
            facadeSpecMode = !facadeSpecMode;
            applyFacadeVisibility();
            console.log('[facade] spec facades:', facadeSpecMode ? 'ON (3D relief)' : 'OFF (window quads)');
        }
    });
}

export function isBlockedBuildingObjectId(objectId) {
    if (objectId == null) return false;
    // Custom-source precedence is resolved by the backend. This client list is
    // reserved for known source defects that stay hidden in every world.
    return isStaticallyBlockedBuildingObjectId(objectId);
}

// Re-export tile constants so the cab orchestrator's tile bookkeeping stays
// consistent with the stream's expectations. Kept as module re-exports rather
// than a shared constants file so growth doesn't create a junk-drawer module.
export { TILE_M, CAB_RING } from '../core/tile-stream.js';

// Palette is pure and shared with the offline compiler; preserve this public export.
import { BUILDING_USE_COLORS } from '../core/building-use-colors.js';
export { BUILDING_USE_COLORS };

// ─── Module-level (per-session) state ──────────────────────────────────────

const buildingMaterials = {};           // bucketed key → material (cache for ALL building materials)
let demolitionGhostMaterial = null;
let demolitionGhostEdgeMaterial = null;
let foundationSkirtMaterial = null;      // shared muted-concrete band under draped buildings
let foundationSkirtTexture = null;       // shared weathered-concrete albedo texture
let buildingsGroup = null;
let loadedBuildingIds = new Set();
let tileBuildings = new Map();          // tileKey → Set<object_id>
let buildingEntrances = new Map();      // object_id → street-facing local doorway
let buildingFootprints = new Map();     // object_id → rendered GDI ground-wall boundary
let authoritativeBuildingFootprints = new Map(); // object_id → cleaned GDI footprint polygon
let authoritativeFootprintTiles = new Map();     // far tileKey → Set<object_id>
const createBuildingFootprintIndex = () => createMutableBoundsGrid({
    cellM: 64,
    boundsOf: footprint => footprint,
});
const createBuildingEntranceIndex = () => createMutableBoundsGrid({
    cellM: 64,
    boundsOf: entrance => ({
        minX: entrance.x,
        minZ: entrance.z,
        maxX: entrance.x,
        maxZ: entrance.z,
    }),
});
let buildingEntranceIndex = createBuildingEntranceIndex();
let buildingFootprintIndex = createBuildingFootprintIndex();
let authoritativeBuildingFootprintIndex = createBuildingFootprintIndex();
let tileSource = null;
let tileSubscription = null;
const streamedBuildingTiles = new Map();
let buildingArchitectureRegionId = null;
let regionalBuildingRebuildQueue = [];
let staticFetchController = null;
let staticStatsFetchController = null;
// Street-facing facades are fetched per tile outside the shared tile source (which owns one
// URL), so cab sessions cancel them through their own controller.
let streetFacingFetchController = null;
let networkRequestScheduler = null;
let onCountChanged = () => {};
let anchorLat = 0, anchorLon = 0;
let terrainReference = null;
let initialBuildingGroundCoordinator = null;
let terrainChangeSubscription = null;
let terrainBuildingRebuildQueue = [];
// The road formation publication last seen by onFrame; a new one re-checks
// the tiles its changed profiles touch (see roadFormationWaitExpired).
let lastFormationPublicationRevision = null;
// One wait per pending formation change, shared by every building: a tile job
// walks its buildings one at a time, so a per-building allowance made a tile
// of a hundred buildings wait it a hundred times over (1.8 buildings/s across
// four jobs, Split 2026-09-17). Keyed on the published generation: the first
// building to find it stale starts the clock, a publication resets it.
let formationWaitPublishedRevision = null;
let formationWaitStartedAtMs = null;
function formationWaitStartMs(formation) {
    const published = formation?.surfaceGeometrySourceRevision ?? null;
    if (published !== formationWaitPublishedRevision || formationWaitStartedAtMs === null) {
        formationWaitPublishedRevision = published;
        formationWaitStartedAtMs = performance.now();
    }
    return formationWaitStartedAtMs;
}
// Two slots allow construction to progress while a completed sibling awaits
// aggregate upload. Hold each slot until the old visual generation retires,
// not merely until feature work finishes. Queued source invalidations retain
// the old scenery without allocating another detached generation for every
// tile in the ring (headed Sep 6: 8–11 simultaneous old/new tile pairs).
const MAX_ACTIVE_BUILDING_REPLACEMENTS = 2;
// How far beside a footprint the foundation sampler consults a road formation
// (its maxDistanceM), so a pending road change farther away than this cannot
// move the skirt and need not be waited for.
const FOUNDATION_FORMATION_REACH_M = 24;
let surfacePublications = null;
let buildingAggregatePublicationGeneration = 0;
// A terrain/style replacement builds beside the last complete tile and swaps
// only after its regional aggregates are ready. The old direct children stay
// visible meanwhile; mergeable parts are staged as raw arrays here rather than
// mutating the live regional batcher mid-build.
const tileVisualReplacements = new Map();
let currentBuildLocalX = 0;
let currentBuildLocalZ = 0;
let currentBuildViewHeadingDeg = Number.NaN;
let currentBuildViewFovDeg = 90;
let staticBuildToken = 0;
let staticBuildJob = null;
// Advanced by the late proposal-mask sweep. A contact-AO task owns the revision
// present when the task starts; if it changes during any bounded assembly or
// publication step, the whole detached task restarts on the new mask.
let contactAoMaskRevision = 0;
const tileBuildJobs = new Map();
const buildingGroundDependencies = createBuildingGroundDependencyCache();
let terrainBuildingRebuildCheck = null;
let reservedBuildingIds = new Map();
const buildingBuildPhaseStats = new Map();
let streetFacingBuildStats = null;
let initialNearTileKeys = new Set();
// Nearby detailed meshes are visible replacements for LOD1, not optional
// background decoration. Spend a bounded slice every stationary frame so a
// busy WebGL render cannot starve them for minutes; movement still pauses work.
const buildQueue = createFrameChunkQueue({
    label: 'buildings',
    frameBudgetMs: 5,
    preferAnimationFrame: true,
    workClass: 'near',
    activityDetails: buildingActivityDetails,
    // Roads retain their four-millisecond support/surface reservation, but
    // visible unfinished buildings outrank cosmetic curb work for the rest of
    // the stationary near-world budget. Hidden-only building work stays at
    // the normal five-millisecond reservation.
    stationaryReservationMs: buildingStationaryReservationMs,
    // The queue continues through the whole ring. The loading gate is tracked
    // explicitly by the four tiles touching the initial observer instead.
    trackWorldReady: false,
    reportWorldProgress: true,
});
const BUILD_STAGE_TARGET_MS = 2;
const BUILD_GEOMETRY_TRIANGLES_PER_STAGE = 128;

function buildingNowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function buildingActivityDetails() {
    const snapshot = getBuildingBuildStateSnapshot();
    return {
        ...snapshot.pendingByVisibility,
        oldestVisibleWaitMs: snapshot.oldestVisibleWaitMs,
    };
}

function buildingStationaryReservationMs() {
    const { pendingByVisibility } = getBuildingBuildStateSnapshot();
    return pendingByVisibility.support + pendingByVisibility.visible > 0 ? 8 : 5;
}

function drainBuildingIterator(iterator) {
    let next;
    do {
        next = iterator.next();
    } while (!next.done);
    return next.value;
}

function noteBuildingBuildPhase({ phase, ms, metadata }) {
    const label = String(phase || 'unknown');
    const elapsedMs = Math.max(0, Number(ms) || 0);
    const stats = buildingBuildPhaseStats.get(label) || {
        phase: label,
        count: 0,
        cpuMs: 0,
        longestMs: 0,
        over4ms: 0,
        over16ms: 0,
        over50ms: 0,
        slowest: [],
    };
    stats.count += 1;
    stats.cpuMs += elapsedMs;
    stats.longestMs = Math.max(stats.longestMs, elapsedMs);
    if (elapsedMs > 4) stats.over4ms += 1;
    if (elapsedMs > 16) stats.over16ms += 1;
    if (elapsedMs > 50) stats.over50ms += 1;
    const objectId = metadata?.objectId;
    if (objectId != null) {
        stats.slowest.push({ objectId, ms: elapsedMs });
        stats.slowest.sort((a, b) => b.ms - a.ms);
        if (stats.slowest.length > 5) stats.slowest.length = 5;
    }
    buildingBuildPhaseStats.set(label, stats);
}

export function getBuildingBuildPhaseSnapshot() {
    return [...buildingBuildPhaseStats.values()]
        .map(stats => ({ ...stats, slowest: stats.slowest.map(entry => ({ ...entry })) }))
        .sort((a, b) => b.cpuMs - a.cpuMs);
}

export function getBuildingBuildStateSnapshot({ includeEntries = false } = {}) {
    const pendingByVisibility = {
        support: 0,
        visible: 0,
        peripheral: 0,
        hidden: 0,
        unknown: 0,
    };
    let oldestVisibleWaitMs = 0;
    const now = buildingNowMs();
    for (const job of tileBuildJobs.values()) {
        for (const item of job?.workItems || []) {
            if (!item || item.isDone()) continue;
            const priority = item.viewPriority();
            pendingByVisibility[priority.tier] += 1;
            if (priority.tier === 'support' || priority.tier === 'visible') {
                oldestVisibleWaitMs = Math.max(
                    oldestVisibleWaitMs,
                    Math.max(0, now - item.enqueuedAtMs),
                );
            }
        }
    }
    return {
        loadedBuildingCount: loadedBuildingIds.size,
        reservedBuildingCount: reservedBuildingIds.size,
        activeTileBuildCount: tileBuildJobs.size,
        activeVisualReplacementTiles: tileVisualReplacements.size,
        maxActiveVisualReplacementTiles: MAX_ACTIVE_BUILDING_REPLACEMENTS,
        aggregatePipeline: getBuildingAggregatePipelineSnapshot(),
        overlayRepaint: {
            active: !!overlayRepaintScheduled,
            pendingBuckets: pendingOverlayReplacements.size,
            failed: overlayRepaintFailed,
        },
        visualQuality: { profileId: buildingQualityProfile.id, ...buildingQualityProfile.buildings },
        facadeResources: facadeResources.snapshot({ includeEntries }),
        facadeAtlasResources: facadeAtlasResources.snapshot({ includeEntries }),
        // Compare actual coverage and material owners when diagnosing memory;
        // detailed lists are never part of the ordinary readiness/frame poll.
        ...(includeEntries ? { loadedBuildingIds: Array.from(loadedBuildingIds) } : {}),
        geometryMemory: buildingGeometryMemory.snapshot(),
        pendingTerrainRebuildTiles: terrainBuildingRebuildQueue.length + (terrainBuildingRebuildCheck ? 1 : 0),
        initialGroundPending: !!initialBuildingGroundCoordinator,
        groundDependencies: buildingGroundDependencies.snapshot(),
        pendingRegionalRebuildTiles: regionalBuildingRebuildQueue.length,
        staticBuildActive: !!staticBuildJob,
        viewHeadingDeg: currentBuildViewHeadingDeg,
        viewFovDeg: currentBuildViewFovDeg,
        pendingByVisibility,
        oldestVisibleWaitMs,
    };
}

function resetBuildingBuildPhaseStats() {
    buildingBuildPhaseStats.clear();
}

function resetStreetFacingBuildStats() {
    streetFacingBuildStats = {
        completedBatches: 0,
        apiFacades: 0,
        apiBuildings: 0,
        matchedSurfaces: 0,
        fallbackSurfaces: 0,
        fallbackBuildings: 0,
    };
}

export function getStreetFacingBuildSnapshot() {
    if (!streetFacingBuildStats) resetStreetFacingBuildStats();
    return { ...streetFacingBuildStats };
}

if (typeof window !== 'undefined') {
    window.__s3dBuildingBuildReport = () => getBuildingBuildPhaseSnapshot();
    window.__s3dBuildingBuildState = options => getBuildingBuildStateSnapshot(options);
    window.__s3dFacadeAtlasOccupancy = () => getFacadeAtlasOccupancySnapshot({ includePages: true });
    window.__s3dStreetFacingState = () => getStreetFacingBuildSnapshot();
}

const WALL_FACE_NORMAL_QUANT = 0.05;
const WALL_FACE_D_QUANT = 0.10;
const WALL_FACE_PLANAR_EPS_M = 0.08;
const WALL_FACE_UV_QUANT = 0.05;

// ─── Rendering (per-variant) ───────────────────────────────────────────────

// Per-object HSL jitter. 64 deterministic buckets keyed off object_id, so
// each building gets one of 64 distinct hue/saturation/lightness shifts of
// its base colour. NULL-type buildings (~67% of the cadastre) jitter widely
// around a warm tan; type-coloured buildings jitter LESS so the categorical
// signal (101=tan, 201=blue-grey, 301=blue, etc.) still reads clearly.
const JITTER_BUCKETS = 64;
const NULL_BASE_HEX = 0xcfbb98;
// Wide range for null-type fallback so the "boring beige cluster" gets the
// most visible variety — from cream through peach to ochre and rosier tones.
const RANGE_NULL = { h: 0.045, s: 0.34, l: 0.19 };
// Narrow range for typed buildings so each type stays visually distinct
// (a jittered '101' shouldn't get mistaken for '301').
const RANGE_TYPED = { h: 0.012, s: 0.14, l: 0.11 };
const MAX_WALL_LIGHTNESS = 0.81;
const MAX_PASSAGE_VOLUMES = 24;
// Passage-volume shader patch. The patched variant is assigned only to
// building meshes whose cached world bounds overlap an active passage OBB;
// applying its fragment loop to every city building more than doubled frame
// time in the fixed central performance scene.
const PASSAGE_DISCARD_ENABLED = true;
const PASSAGE_BOUNDS_MARGIN_M = 0.35;

// FULL passage cut-volume registry, not capped to the shader's nearest-N.
// Facade painting consults it when laying out windows/doors so no opening is
// ever drawn across a passage hole (see getFacadeOpeningMask); the shader
// uniform set below stays player-proximity-capped for performance.
// `revision` bumps only when cut GEOMETRY changed (passage added/removed):
// a passage can register AFTER its building's facade was painted — the road
// tile may sit a ring farther than the building tile — and then the painted
// windows must be re-masked (see scheduleOverlayPassageRepaint).
let allPassageCutVolumes = [];
let ordinaryPassageCutVolumes = [];
let authoredPassageCutVolumes = [];
let ordinaryPassageCutVolumesRevision = 0;
let authoredPassageCutVolumesRevision = 0;
let passageCutVolumesRevision = '0|authored:0';

function syncAllPassageCutVolumes() {
    // Authored openings go first: unlike the rolling courtyard candidates,
    // they are permanent pieces of the world and must never lose their slot.
    allPassageCutVolumes = authoredPassageCutVolumes.concat(ordinaryPassageCutVolumes);
    const revision = `${ordinaryPassageCutVolumesRevision}`
        + `|authored:${authoredPassageCutVolumesRevision}`;
    if (revision === passageCutVolumesRevision) return;
    passageCutVolumesRevision = revision;
    scheduleOverlayPassageRepaint();
}

export function setAllBuildingPassageCutVolumes(
    volumes,
    revision = ordinaryPassageCutVolumesRevision,
) {
    ordinaryPassageCutVolumes = Array.isArray(volumes) ? volumes : [];
    ordinaryPassageCutVolumesRevision = revision;
    syncAllPassageCutVolumes();
}

const passageCentersHalfWidth = Array.from({ length: MAX_PASSAGE_VOLUMES }, () => new THREE.Vector4());
const passageRightsHalfHeight = Array.from({ length: MAX_PASSAGE_VOLUMES }, () => new THREE.Vector4());
const passageAlongsHalfDepth = Array.from({ length: MAX_PASSAGE_VOLUMES }, () => new THREE.Vector4());
const activePassageVolumes = [];
const passageShaderState = { count: 0 };
const passageMaterials = new Set();
const passageMaterialVariants = new Map();
const passageBaseMaterialByMesh = new WeakMap();
const passageBoundsByMesh = new WeakMap();

function getPassageMeshBounds(mesh) {
    if (!mesh || !mesh.geometry) return null;
    const cached = passageBoundsByMesh.get(mesh);
    if (cached) return cached;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const localBox = mesh.geometry.boundingBox;
    if (!localBox || localBox.isEmpty()) return null;
    mesh.updateWorldMatrix(true, false);
    const worldBox = localBox.clone().applyMatrix4(mesh.matrixWorld);
    const bounds = {
        minX: worldBox.min.x,
        minY: worldBox.min.y,
        minZ: worldBox.min.z,
        maxX: worldBox.max.x,
        maxY: worldBox.max.y,
        maxZ: worldBox.max.z,
    };
    passageBoundsByMesh.set(mesh, bounds);
    return bounds;
}

function meshBoundsOverlapPassage(bounds, volume) {
    const extentX = Math.abs(volume.rightX) * volume.halfWidth +
        Math.abs(volume.alongX) * volume.halfDepth;
    const extentZ = Math.abs(volume.rightZ) * volume.halfWidth +
        Math.abs(volume.alongZ) * volume.halfDepth;
    const margin = PASSAGE_BOUNDS_MARGIN_M;
    return !(bounds.maxX < volume.centerX - extentX - margin ||
        bounds.minX > volume.centerX + extentX + margin ||
        bounds.maxY < volume.centerY - volume.halfHeight - margin ||
        bounds.minY > volume.centerY + volume.halfHeight + margin ||
        bounds.maxZ < volume.centerZ - extentZ - margin ||
        bounds.minZ > volume.centerZ + extentZ + margin);
}

function meshNeedsPassageMaterial(mesh) {
    if (!PASSAGE_DISCARD_ENABLED || activePassageVolumes.length === 0) return false;
    const bounds = getPassageMeshBounds(mesh);
    if (!bounds) return false;
    for (const volume of activePassageVolumes) {
        if (meshBoundsOverlapPassage(bounds, volume)) return true;
    }
    return false;
}

function syncPassageShaderUniforms() {
    for (const mat of passageMaterials) {
        const shaders = mat && mat.userData && mat.userData.passageShaders;
        if (!Array.isArray(shaders)) continue;
        for (const shader of shaders) {
            if (!shader || !shader.uniforms) continue;
            if (shader.uniforms.uPassageCount) {
                shader.uniforms.uPassageCount.value = passageShaderState.count;
            }
        }
    }
}

function ensurePassageDiscardMaterial(mat) {
    if (!mat) return mat;
    if (!PASSAGE_DISCARD_ENABLED) return mat;
    if (mat.userData.passageDiscardPatched) return mat;
    mat.userData.passageDiscardPatched = true;
    mat.userData.passageShaders = [];
    const prevCompile = mat.onBeforeCompile;
    const prevCacheKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = (shader, renderer) => {
        if (typeof prevCompile === 'function') prevCompile(shader, renderer);
        bindRenderOriginShader(shader);
        shader.uniforms.uPassageCount = { value: passageShaderState.count };
        shader.uniforms.uPassageCenterHalfWidth = { value: passageCentersHalfWidth };
        shader.uniforms.uPassageRightHalfHeight = { value: passageRightsHalfHeight };
        shader.uniforms.uPassageAlongHalfDepth = { value: passageAlongsHalfDepth };
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vPassageWorldPosition;'
            )
            .replace(
                '#include <worldpos_vertex>',
                '#include <worldpos_vertex>\nvPassageWorldPosition = worldPosition.xyz;'
            );
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
varying vec3 vPassageWorldPosition;
uniform int uPassageCount;
uniform vec4 uPassageCenterHalfWidth[${MAX_PASSAGE_VOLUMES}];
uniform vec4 uPassageRightHalfHeight[${MAX_PASSAGE_VOLUMES}];
uniform vec4 uPassageAlongHalfDepth[${MAX_PASSAGE_VOLUMES}];
bool insideAnyPassageVolume(vec3 worldPos) {
    for (int i = 0; i < ${MAX_PASSAGE_VOLUMES}; i++) {
        if (i >= uPassageCount) break;
        vec4 centerHalfWidth = uPassageCenterHalfWidth[i];
        vec4 rightHalfHeight = uPassageRightHalfHeight[i];
        vec4 alongHalfDepth = uPassageAlongHalfDepth[i];
        vec3 delta = worldPos - centerHalfWidth.xyz;
        float localRight = dot(delta, rightHalfHeight.xyz);
        float localUp = delta.y;
        float localAlong = dot(delta, alongHalfDepth.xyz);
        if (abs(localRight) <= centerHalfWidth.w &&
            abs(localUp) <= rightHalfHeight.w &&
            abs(localAlong) <= alongHalfDepth.w) {
            return true;
        }
    }
    return false;
}`
            )
            .replace(
                '#include <dithering_fragment>',
                [
                    'vec3 passageAbsoluteWorldPosition = vPassageWorldPosition;',
                    'passageAbsoluteWorldPosition.xz += uRenderOriginXZ;',
                    'if (insideAnyPassageVolume(passageAbsoluteWorldPosition)) discard;',
                    '#include <dithering_fragment>',
                ].join('\n')
            );
        mat.userData.passageShaders.push(shader);
    };
    mat.customProgramCacheKey = () => {
        const base = typeof prevCacheKey === 'function' ? prevCacheKey.call(mat) : '';
        return `${base}|passages-v2-${MAX_PASSAGE_VOLUMES}`;
    };
    passageMaterials.add(mat);
    mat.needsUpdate = true;
    return mat;
}

function getPassageMaterialVariant(baseMaterial) {
    if (!baseMaterial || !PASSAGE_DISCARD_ENABLED) return baseMaterial;
    let variant = passageMaterialVariants.get(baseMaterial);
    if (variant) return variant;
    variant = baseMaterial.clone();
    // Material.clone() intentionally does not preserve shader callbacks.
    // Carry forward any pre-existing customization before adding ours.
    variant.onBeforeCompile = baseMaterial.onBeforeCompile;
    variant.customProgramCacheKey = baseMaterial.customProgramCacheKey;
    variant.name = baseMaterial.name
        ? `${baseMaterial.name}:passage`
        : 'BuildingPassageMaterial';
    registerShared(variant);
    ensurePassageDiscardMaterial(variant);
    passageMaterialVariants.set(baseMaterial, variant);
    return variant;
}

function setPassageAwareMaterial(mesh, baseMaterial) {
    if (!mesh || !baseMaterial || Array.isArray(baseMaterial)) return;
    bindFacadeMeshResource(mesh, baseMaterial);
    if (!mesh.userData?.surfaceClaim) {
        markSurfaceClaim(mesh, {
            surfaceClass: SURFACE_CLASS.BUILDING,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
            ownerId: mesh.userData?.entityKey
                || mesh.userData?.objectId
                || mesh.name
                || null,
            featureId: mesh.userData?.entityKey || mesh.userData?.objectId || null,
            sourceId: 'world/buildings.js',
        });
    }
    // A deep rail cut is open to the sky. Buildings may remain over a bored
    // tunnel, but no wall, roof, far-LOD prism, AO skirt or drain may bridge an
    // excavation. The shared G-channel is drawn from the very same formation
    // boundary as terrain/roads, so every layer clears on one exact footprint.
    applySurfaceStencil(baseMaterial, BUILDING_MATERIAL_CLAIM);
    applyGroundOwnership(baseMaterial, BUILDING_MATERIAL_CLAIM);
    passageBaseMaterialByMesh.set(mesh, baseMaterial);
    const relevant = meshNeedsPassageMaterial(mesh);
    mesh.userData.passageDiscardRelevant = relevant;
    mesh.material = relevant ? getPassageMaterialVariant(baseMaterial) : baseMaterial;
}

// Groups outside buildingsGroup (e.g. the far-LOD building prisms) whose
// meshes also carry passage discard variants. Without this, a building that
// exists ONLY as a far prism (no detailed 3D model) renders straight through
// a passage cut — the "flat slab sealing the far end of the arch" bug.
const passageAwareForeignGroups = new Set();
export function registerPassageAwareGroup(group) {
    if (group) passageAwareForeignGroups.add(group);
}
export function unregisterPassageAwareGroup(group) {
    return passageAwareForeignGroups.delete(group);
}
export function applyPassageAwareMaterial(mesh, baseMaterial) {
    setPassageAwareMaterial(mesh, baseMaterial);
}

function refreshBuildingPassageMaterials() {
    const visit = (object) => {
        const baseMaterial = passageBaseMaterialByMesh.get(object);
        if (baseMaterial) setPassageAwareMaterial(object, baseMaterial);
    };
    if (buildingsGroup) buildingsGroup.traverse(visit);
    for (const group of passageAwareForeignGroups) group.traverse(visit);
}

function syncPassageVariantNightState() {
    for (const [baseMaterial, variant] of passageMaterialVariants) {
        if (!baseMaterial.emissive || !variant.emissive) continue;
        variant.emissive.copy(baseMaterial.emissive);
        variant.emissiveIntensity = baseMaterial.emissiveIntensity;
        if (variant.emissiveMap !== baseMaterial.emissiveMap) {
            variant.emissiveMap = baseMaterial.emissiveMap;
            variant.needsUpdate = true;
        }
    }
}

function disposePassageMaterialVariants() {
    for (const variant of passageMaterialVariants.values()) {
        passageMaterials.delete(variant);
        unregisterShared(variant);
        variant.dispose();
    }
    passageMaterialVariants.clear();
    passageMaterials.clear();
}

function disposePassageMaterialVariant(baseMaterial) {
    const variant = passageMaterialVariants.get(baseMaterial);
    if (!variant) return false;
    passageMaterialVariants.delete(baseMaterial);
    passageMaterials.delete(variant);
    unregisterShared(variant);
    variant.dispose();
    return true;
}

let ordinaryActivePassageVolumes = [];

function applyBuildingPassageVolumes(volumes) {
    const safeVolumes = Array.isArray(volumes) ? volumes : [];
    const count = Math.min(MAX_PASSAGE_VOLUMES, safeVolumes.length);
    passageShaderState.count = count;
    activePassageVolumes.length = count;
    for (let i = 0; i < MAX_PASSAGE_VOLUMES; i++) {
        const v = i < count ? safeVolumes[i] : null;
        if (i < count) {
            activePassageVolumes[i] = {
                centerX: v.centerX,
                centerY: v.centerY,
                centerZ: v.centerZ,
                rightX: v.rightX,
                rightZ: v.rightZ,
                alongX: v.alongX,
                alongZ: v.alongZ,
                halfWidth: v.halfWidth,
                halfHeight: v.halfHeight,
                halfDepth: v.halfDepth,
            };
        }
        passageCentersHalfWidth[i].set(
            v ? v.centerX : 0,
            v ? v.centerY : 0,
            v ? v.centerZ : 0,
            v ? v.halfWidth : 0,
        );
        passageRightsHalfHeight[i].set(
            v ? v.rightX : 0,
            0,
            v ? v.rightZ : 0,
            v ? v.halfHeight : 0,
        );
        passageAlongsHalfDepth[i].set(
            v ? v.alongX : 0,
            0,
            v ? v.alongZ : 0,
            v ? v.halfDepth : 0,
        );
    }
    syncPassageShaderUniforms();
    refreshBuildingPassageMaterials();
}

export function setBuildingPassageVolumes(volumes) {
    ordinaryActivePassageVolumes = Array.isArray(volumes) ? volumes : [];
    applyBuildingPassageVolumes(
        authoredPassageCutVolumes.concat(ordinaryActivePassageVolumes).slice(0, MAX_PASSAGE_VOLUMES),
    );
}

// Fixed world landmarks publish their cut volumes independently of the
// courtyard-road stream. Keeping the two registries separate prevents a late
// road tile (or a session reset) from silently sealing the landmark again.
export function setAuthoredBuildingPassageVolumes(volumes, revision = 0) {
    authoredPassageCutVolumes = Array.isArray(volumes) ? volumes : [];
    authoredPassageCutVolumesRevision = revision;
    syncAllPassageCutVolumes();
    applyBuildingPassageVolumes(
        authoredPassageCutVolumes.concat(ordinaryActivePassageVolumes).slice(0, MAX_PASSAGE_VOLUMES),
    );
}

export function isPointInsideBuildingPassageVolume(worldX, worldY, worldZ) {
    for (const v of activePassageVolumes) {
        const dx = worldX - v.centerX;
        const dy = worldY - v.centerY;
        const dz = worldZ - v.centerZ;
        const localRight = dx * v.rightX + dz * v.rightZ;
        const localAlong = dx * v.alongX + dz * v.alongZ;
        if (Math.abs(localRight) <= v.halfWidth &&
            Math.abs(dy) <= v.halfHeight &&
            Math.abs(localAlong) <= v.halfDepth) {
            return true;
        }
    }
    return false;
}

function hashObjectId(id) {
    let h = 2166136261;
    const s = String(id);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// ─── Procedural wall textures ──────────────────────────────────────────────
// Multiple white-base canvas variants — each is its own surface character
// (smooth plaster, coarse stucco, concrete shuttering lines, aggregate
// speckle, vertical cladding). Each building hashes to one variant via
// (bucket % TEXTURE_VARIANTS), and each variant has a baseline roughness
// matching its surface so highlights read differently per variant.
//
// All variants are white-dominant so they multiply cleanly with the
// material's tinted base color — they modulate, not recolour.
//
// UVs are computed in metres in stageBuildingFeatureGdi; `repeat` here is
// set so one canvas cell tiles every 3 m of world distance.
//
// `_wallEmissiveTexture` is a single all-black mask so night-mode emissive
// is fully suppressed. Kept in place so we can re-introduce a window-only
// glow later without re-wiring materials.

const WALL_TEX_CELL_M = 4.5;
const WALL_ATLAS_GRID = 4;
const WALL_ATLAS_TILE_SIZE = 128;
const TEXTURE_VARIANTS = 4;
const WALL_ENV_MAP_INTENSITY = 0.35;
// Per-variant baseline roughness. Index aligns with paintVariant() switch.
const VARIANT_ROUGHNESS = [0.82, 0.90, 0.85, 0.87];
// Per-variant normal-map strength. Smooth plaster gets a faint hint;
// stucco / aggregate push hardest. Tuned so even the strongest reads as
// "real surface" rather than a videogame normal demo at typical viewing
// distance — bump these back up if the relief is invisible from across
// the street.
const VARIANT_NORMAL_SCALE = [0.035, 0.07, 0.055, 0.05];

const _wallTextures = new Array(TEXTURE_VARIANTS).fill(null);
const _wallNormalTextures = new Array(TEXTURE_VARIANTS).fill(null);
let _wallEmissiveTexture = null;
let _roofTexture = null;
let _roofNormalTexture = null;
let _kanalicaRoofTexture = null;
let _kanalicaRoofNormalTexture = null;
const _dalmatianStoneSurfaces = new Map();

const ROOF_TEX_CELL_W_M = 1.8;
const ROOF_TEX_CELL_H_M = 1.4;
function makeStoneDataTexture(data, size, colorSpace = null) {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    registerShared(texture);
    return texture;
}

function getDalmatianStoneSurface(style, variant) {
    const safeVariant = Math.max(0, Math.min(style.variants - 1, variant | 0));
    const cacheKey = `${style.key}:${safeVariant}`;
    let surface = _dalmatianStoneSurfaces.get(cacheKey);
    if (surface) return surface;
    const raster = createDalmatianStoneRaster(256, 0x57a0e + safeVariant * 7919);
    const map = makeStoneDataTexture(raster.color, raster.size, THREE.SRGBColorSpace);
    const bumpMap = makeStoneDataTexture(raster.height, raster.size);
    map.repeat.set(1 / style.textureWidthM, 1 / style.textureHeightM);
    bumpMap.repeat.copy(map.repeat);
    surface = { map, bumpMap };
    _dalmatianStoneSurfaces.set(cacheKey, surface);
    return surface;
}

function createSeededRandom(seed) {
    let state = seed >>> 0;
    return function seededRandom() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function applyPixelNoise(ctx, size, amp, rand = Math.random) {
    const iterator = applyPixelNoiseCooperative(ctx, size, amp, rand);
    while (!iterator.next().done) { /* synchronous callers are startup-only */ }
}

function* applyPixelNoiseCooperative(
    ctx,
    size,
    amp,
    rand = Math.random,
    phase = 'wall-atlas-noise',
) {
    const id = ctx.getImageData(0, 0, size, size);
    const d = id.data;
    yield { phase: `${phase}-readback` };
    for (let i = 0; i < d.length; i += 4) {
        const n = (rand() - 0.5) * amp;
        d[i]     = Math.max(0, Math.min(255, d[i]     + n));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        if (i > 0 && i % (2048 * 4) === 0) yield { phase };
    }
    ctx.putImageData(id, 0, 0);
    yield { phase: `${phase}-upload` };
}

function paintSoftBlotches(ctx, size, count, {
    minRadius = size * 0.06,
    maxRadius = size * 0.18,
    palette = [[226, 218, 206], [194, 184, 168]],
    alphaMin = 0.04,
    alphaMax = 0.10,
} = {}, rand = Math.random) {
    for (let i = 0; i < count; i++) {
        const [r, g, b] = palette[i % palette.length];
        const radius = minRadius + rand() * (maxRadius - minRadius);
        const x = rand() * size;
        const y = rand() * size;
        ctx.fillStyle = `rgba(${r},${g},${b},${alphaMin + rand() * (alphaMax - alphaMin)})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

function paintVerticalStreaks(ctx, size, count, {
    palette = [[150, 138, 122], [208, 198, 184]],
    alphaMin = 0.03,
    alphaMax = 0.08,
} = {}, rand = Math.random) {
    for (let i = 0; i < count; i++) {
        const [r, g, b] = palette[i % palette.length];
        const x = rand() * size;
        const y = rand() * size * 0.7;
        const w = 1 + rand() * 2;
        const h = size * (0.16 + rand() * 0.34);
        ctx.fillStyle = `rgba(${r},${g},${b},${alphaMin + rand() * (alphaMax - alphaMin)})`;
        ctx.fillRect(x, y, w, h);
    }
}

function paintPatchRectangles(ctx, size, count, rand = Math.random) {
    for (let i = 0; i < count; i++) {
        const shade = 164 + Math.floor(rand() * 34);
        const alpha = 0.05 + rand() * 0.06;
        const x = rand() * size;
        const y = rand() * size;
        const w = size * (0.10 + rand() * 0.18);
        const h = size * (0.08 + rand() * 0.16);
        ctx.fillStyle = `rgba(${shade},${shade - 6},${shade - 12},${alpha})`;
        ctx.fillRect(x, y, w, h);
    }
}

function* paintVariantCooperative(idx, ctx, size, rand = Math.random) {
    ctx.fillStyle = '#d7d0c4';
    ctx.fillRect(0, 0, size, size);

    if (idx === 0) {
        // Smooth painted plaster — broad tonal variation, almost no grain.
        paintSoftBlotches(ctx, size, 18, {
            minRadius: size * 0.10,
            maxRadius: size * 0.24,
            alphaMin: 0.03,
            alphaMax: 0.07,
        }, rand);
        paintVerticalStreaks(ctx, size, 10, { alphaMin: 0.02, alphaMax: 0.05 }, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            6,
            rand,
            'wall-color-atlas-noise',
        );
    } else if (idx === 1) {
        // Fine stucco — pinhead-scale speckles, not chunky aggregate.
        paintSoftBlotches(ctx, size, 12, {
            minRadius: size * 0.08,
            maxRadius: size * 0.18,
            alphaMin: 0.03,
            alphaMax: 0.06,
        }, rand);
        for (let i = 0; i < 1800; i++) {
            const x = rand() * size;
            const y = rand() * size;
            const v = 168 + Math.floor(rand() * 26);
            ctx.fillStyle = `rgba(${v},${v - 3},${v - 6},0.16)`;
            ctx.fillRect(x, y, 1, 1);
            if ((i + 1) % 128 === 0) yield { phase: 'wall-color-atlas-speckles' };
        }
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            8,
            rand,
            'wall-color-atlas-noise',
        );
    } else if (idx === 2) {
        // Rendered concrete/plaster with subtle seams and runoff marks.
        paintSoftBlotches(ctx, size, 10, {
            minRadius: size * 0.12,
            maxRadius: size * 0.22,
            alphaMin: 0.03,
            alphaMax: 0.06,
        }, rand);
        ctx.fillStyle = 'rgba(118, 108, 96, 0.22)';
        for (let i = 1; i < 4; i++) {
            ctx.fillRect(0, Math.floor((i / 4) * size), size, 1);
        }
        paintVerticalStreaks(ctx, size, 12, {
            palette: [[132, 122, 110], [188, 178, 164]],
            alphaMin: 0.03,
            alphaMax: 0.06,
        }, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            7,
            rand,
            'wall-color-atlas-noise',
        );
    } else {
        // Patched facade repaint — broad patch repairs rather than gravel-like speckle.
        paintPatchRectangles(ctx, size, 14, rand);
        paintVerticalStreaks(ctx, size, 8, { alphaMin: 0.02, alphaMax: 0.05 }, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            7,
            rand,
            'wall-color-atlas-noise',
        );
    }
}

function makeRepeatingTexture(canvas, repeatX, repeatY, colorSpace = THREE.SRGBColorSpace) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.colorSpace = colorSpace;
    t.repeat.set(repeatX, repeatY);
    registerShared(t);
    return t;
}

function makeWallTexture(canvas) {
    return makeRepeatingTexture(
        canvas,
        1 / (WALL_TEX_CELL_M * WALL_ATLAS_GRID),
        1 / (WALL_TEX_CELL_M * WALL_ATLAS_GRID),
    );
}

function* buildWallAtlasCooperative(idx, paintTileFn, phase, contextAttributes) {
    const atlasSize = WALL_ATLAS_TILE_SIZE * WALL_ATLAS_GRID;
    const atlas = document.createElement('canvas');
    atlas.width = atlasSize;
    atlas.height = atlasSize;
    const atlasCtx = atlas.getContext('2d', contextAttributes);
    for (let row = 0; row < WALL_ATLAS_GRID; row++) {
        for (let col = 0; col < WALL_ATLAS_GRID; col++) {
            const tile = document.createElement('canvas');
            tile.width = WALL_ATLAS_TILE_SIZE;
            tile.height = WALL_ATLAS_TILE_SIZE;
            const tileCtx = tile.getContext('2d', { willReadFrequently: true });
            const rand = createSeededRandom(((idx + 1) * 1009) ^ (row * 9176) ^ (col * 6113));
            const paintTask = paintTileFn(tileCtx, WALL_ATLAS_TILE_SIZE, rand);
            if (paintTask && typeof paintTask.next === 'function') yield* paintTask;
            atlasCtx.drawImage(tile, col * WALL_ATLAS_TILE_SIZE, row * WALL_ATLAS_TILE_SIZE);
            yield { phase };
        }
    }
    return atlas;
}

function buildWallAtlas(idx, paintTileFn) {
    return drainBuildingIterator(
        buildWallAtlasCooperative(idx, paintTileFn, 'wall-atlas-tile'),
    );
}

const wallTextureBuilds = [];

function* buildWallTextureVariant(idx) {
    const canvas = yield* buildWallAtlasCooperative(
        idx,
        (ctx, size, rand) => paintVariantCooperative(idx, ctx, size, rand),
        'wall-color-atlas-tile',
    );
    return makeWallTexture(canvas);
}

function* getWallTextureVariantCooperative(idx) {
    if (_wallTextures[idx]) return _wallTextures[idx];
    let state = wallTextureBuilds[idx];
    if (!state) {
        state = { iterator: buildWallTextureVariant(idx), done: false };
        wallTextureBuilds[idx] = state;
    }
    while (!state.done) {
        let next;
        try {
            next = state.iterator.next();
        } catch (error) {
            wallTextureBuilds[idx] = null;
            throw error;
        }
        if (next.done) {
            if (!next.value) {
                wallTextureBuilds[idx] = null;
                throw new Error(`Wall texture variant ${idx} completed without a texture`);
            }
            _wallTextures[idx] = next.value;
            state.done = true;
            state.iterator = null;
            break;
        }
        yield next.value;
    }
    return _wallTextures[idx];
}

function getWallTextureVariant(idx) {
    return drainBuildingIterator(getWallTextureVariantCooperative(idx));
}

function paintRoofTiles(ctx, size, asHeight) {
    const cols = 6;
    const rows = 8;
    const tileW = size / cols;
    const rowH = size / rows;
    const bodyH = rowH * 0.92;
    ctx.fillStyle = asHeight ? '#666666' : '#d7cec2';
    ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < rows + 1; row++) {
        const y = row * rowH - rowH * 0.25;
        const offset = (row % 2) * tileW * 0.5;
        for (let col = -1; col < cols + 1; col++) {
            const x = col * tileW + offset;
            const shade = 0.92 + Math.random() * 0.10;
            if (asHeight) {
                const v = Math.round(138 + shade * 40);
                ctx.fillStyle = `rgb(${v},${v},${v})`;
            } else {
                const v = Math.round(215 + shade * 20);
                ctx.fillStyle = `rgb(${v},${v - 8},${v - 14})`;
            }
            ctx.beginPath();
            ctx.moveTo(x + tileW * 0.08, y);
            ctx.lineTo(x + tileW * 0.92, y);
            ctx.lineTo(x + tileW * 0.92, y + bodyH * 0.72);
            ctx.quadraticCurveTo(x + tileW * 0.50, y + bodyH, x + tileW * 0.08, y + bodyH * 0.72);
            ctx.closePath();
            ctx.fill();
            if (!asHeight) {
                ctx.strokeStyle = 'rgba(150, 110, 92, 0.22)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }
    if (asHeight) {
        ctx.fillStyle = 'rgba(86, 86, 86, 0.72)';
        for (let row = 1; row < rows; row++) {
            const y = Math.round(row * rowH) - 1;
            ctx.fillRect(0, y, size, 2);
        }
    } else {
        ctx.fillStyle = 'rgba(116, 78, 58, 0.20)';
        for (let row = 1; row < rows; row++) {
            const y = Math.round(row * rowH) - 1;
            ctx.fillRect(0, y, size, 2);
        }
        applyPixelNoise(ctx, size, 10);
    }
}

function paintKanalicaRoofTiles(ctx, size, asHeight) {
    const channels = 6;
    const tileRows = 4;
    const image = ctx.createImageData(size, size);
    const pixels = image.data;
    const rand = createSeededRandom(0x4b555041);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = ((x + 0.5) / size) * channels;
            const v = ((y + 0.5) / size) * tileRows;
            const height = kanalicaHeightAt(u, v);
            const offset = (y * size + x) * 4;
            if (asHeight) {
                const value = Math.round(height * 255);
                pixels[offset] = value;
                pixels[offset + 1] = value;
                pixels[offset + 2] = value;
            } else {
                // Kanalica are overlapping pieces, not one continuous corrugated
                // sheet. Stagger their end joints by channel and draw both the
                // dark joint and the short shadow below the raised overlap.
                const channel = Math.floor(u);
                const stagger = ((channel % 2) + 2) % 2 === 0 ? 0 : 0.5;
                const along = (v + stagger) - Math.floor(v + stagger);
                const seamDistance = Math.min(along, 1 - along);
                const endJoint = Math.max(0, 1 - seamDistance / 0.045) * 34;
                const overlapShadow = along > 0.18 && along < 0.30
                    ? (1 - (along - 0.18) / 0.12) * 28
                    : 0;
                const overlapHighlight = along < 0.13 ? (1 - along / 0.13) * 9 : 0;
                const shade = 158 + height * 92 + overlapHighlight
                    - endJoint - overlapShadow + (rand() - 0.5) * 7;
                pixels[offset] = Math.max(0, Math.min(255, Math.round(shade + 7)));
                pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(shade - 3)));
                pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(shade - 13)));
            }
            pixels[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
}

function getRoofTexture() {
    if (_roofTexture) return _roofTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    paintRoofTiles(canvas.getContext('2d', { willReadFrequently: true }), size, false);
    _roofTexture = makeRepeatingTexture(canvas, 1 / ROOF_TEX_CELL_W_M, 1 / ROOF_TEX_CELL_H_M);
    return _roofTexture;
}

function getRoofNormalTexture() {
    if (_roofNormalTexture) return _roofNormalTexture;
    const size = 128;
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = size;
    heightCanvas.height = size;
    paintRoofTiles(heightCanvas.getContext('2d', { willReadFrequently: true }), size, true);
    const normalCanvas = heightCanvasToNormalCanvas(heightCanvas, size);
    const tex = makeRepeatingTexture(
        normalCanvas,
        1 / ROOF_TEX_CELL_W_M,
        1 / ROOF_TEX_CELL_H_M,
        THREE.LinearSRGBColorSpace,
    );
    _roofNormalTexture = tex;
    return tex;
}

function getKanalicaRoofTexture(style) {
    if (_kanalicaRoofTexture) return _kanalicaRoofTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    paintKanalicaRoofTiles(canvas.getContext('2d', { willReadFrequently: true }), size, false);
    _kanalicaRoofTexture = makeRepeatingTexture(
        canvas,
        1 / style.textureCellWidthM,
        1 / style.textureCellHeightM,
    );
    return _kanalicaRoofTexture;
}

function getKanalicaRoofNormalTexture(style) {
    if (_kanalicaRoofNormalTexture) return _kanalicaRoofNormalTexture;
    const size = 128;
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = size;
    heightCanvas.height = size;
    paintKanalicaRoofTiles(heightCanvas.getContext('2d', { willReadFrequently: true }), size, true);
    const normalCanvas = heightCanvasToNormalCanvas(heightCanvas, size);
    _kanalicaRoofNormalTexture = makeRepeatingTexture(
        normalCanvas,
        1 / style.textureCellWidthM,
        1 / style.textureCellHeightM,
        THREE.LinearSRGBColorSpace,
    );
    return _kanalicaRoofNormalTexture;
}

function getPitchedRoofTexture(style) {
    return style.profile === 'kanalica' ? getKanalicaRoofTexture(style) : getRoofTexture();
}

function getPitchedRoofNormalTexture(style) {
    return style.profile === 'kanalica'
        ? getKanalicaRoofNormalTexture(style)
        : getRoofNormalTexture();
}

// The night mask for plain (untextured-facade) walls: one window per atlas
// cell, about a third of them lit. Painted at atlas resolution so it lines up
// with the diffuse atlas cell for cell — WALL_TEX_CELL_M of wall per cell,
// which is roughly one storey and one bay. Invisible by day, when
// emissiveIntensity is 0, so a daylit city pays for one texture and nothing else.
function getWallEmissiveTexture() {
    if (_wallEmissiveTexture) return _wallEmissiveTexture;
    const tile = WALL_ATLAS_TILE_SIZE;
    const size = tile * WALL_ATLAS_GRID;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    const windowW = tile * 0.34;
    const windowH = tile * 0.46;
    for (let row = 0; row < WALL_ATLAS_GRID; row += 1) {
        for (let col = 0; col < WALL_ATLAS_GRID; col += 1) {
            const light = wallWindowLightAt(col, row, WALL_WINDOW_SEED);
            if (!light.lit) continue;
            const level = Math.round(255 * light.brightness);
            const x = col * tile + (tile - windowW) / 2;
            const y = row * tile + (tile - windowH) / 2;
            // A lamp lights the reveal around its own window, so the pane gets a
            // soft halo instead of reading as a rectangle floating on black.
            const glow = ctx.createRadialGradient(
                x + windowW / 2, y + windowH / 2, windowW * 0.2,
                x + windowW / 2, y + windowH / 2, windowW * 1.15,
            );
            glow.addColorStop(0, `rgba(${level}, ${Math.round(level * 0.86)}, ${Math.round(level * 0.62)}, 0.55)`);
            glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(col * tile, row * tile, tile, tile);
            ctx.fillStyle = `rgb(${level}, ${Math.round(level * 0.9)}, ${Math.round(level * 0.68)})`;
            ctx.fillRect(x, y, windowW, windowH);
        }
    }
    _wallEmissiveTexture = makeWallTexture(canvas);
    return _wallEmissiveTexture;
}

// ─── Procedural normal maps ────────────────────────────────────────────────
// For each variant we paint a grayscale "height field" (mid-gray = flat,
// brighter = raised, darker = recessed), then convert it to a tangent-space
// normal map via central differences (a cheap Sobel-equivalent). This gives
// each variant real surface relief that responds to the sun position —
// stucco grain catches highlights at low angles, shuttering lines on
// concrete cast micro-shadows, etc. Sampled with `repeat` matching the
// diffuse map so the normal aligns with the colour pattern.

function* paintHeightVariantCooperative(idx, ctx, size, rand = Math.random) {
    // Mid-gray = flat normal in the encoded map
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    if (idx === 0) {
        // Smooth plaster — barely-there micro-relief.
        paintSoftBlotches(ctx, size, 12, {
            minRadius: size * 0.08,
            maxRadius: size * 0.18,
            palette: [[138, 138, 138], [120, 120, 120]],
            alphaMin: 0.05,
            alphaMax: 0.10,
        }, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            8,
            rand,
            'wall-height-atlas-noise',
        );
    } else if (idx === 1) {
        // Fine stucco — small granular relief, not gravel-like chunks.
        for (let i = 0; i < 1600; i++) {
            const x = rand() * size;
            const y = rand() * size;
            const v = 116 + Math.floor(rand() * 30);
            ctx.fillStyle = `rgba(${v},${v},${v},0.22)`;
            ctx.fillRect(x, y, 1, 1);
            if ((i + 1) % 128 === 0) yield { phase: 'wall-height-atlas-speckles' };
        }
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            8,
            rand,
            'wall-height-atlas-noise',
        );
    } else if (idx === 2) {
        // Faint rendered-concrete seams.
        ctx.fillStyle = 'rgba(60, 60, 60, 0.34)';
        for (let i = 1; i < 4; i++) {
            ctx.fillRect(0, Math.floor((i / 4) * size), size, 2);
        }
        paintVerticalStreaks(ctx, size, 10, {
            palette: [[150, 150, 150], [104, 104, 104]],
            alphaMin: 0.03,
            alphaMax: 0.08,
        }, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            7,
            rand,
            'wall-height-atlas-noise',
        );
    } else {
        // Patch repairs — soft large-scale relief only.
        paintPatchRectangles(ctx, size, 10, rand);
        yield* applyPixelNoiseCooperative(
            ctx,
            size,
            6,
            rand,
            'wall-height-atlas-noise',
        );
    }
}

function* heightCanvasToNormalCanvasCooperative(heightCanvas, size) {
    const heightData = heightCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
    yield { phase: 'normal-map-readback' };
    const sample = (x, y) => {
        const xx = ((x % size) + size) % size;   // wrap so the map tiles cleanly
        const yy = ((y % size) + size) % size;
        return heightData[(yy * size + xx) * 4] / 255;
    };

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = size;
    normalCanvas.height = size;
    const nctx = normalCanvas.getContext('2d');
    const out = nctx.createImageData(size, size);
    const od = out.data;

    // Strength here is the height-to-slope conversion only — the visible
    // bumpiness is ultimately controlled by material.normalScale per variant.
    const heightStrength = 2.4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (sample(x + 1, y) - sample(x - 1, y)) * heightStrength;
            const dy = (sample(x, y + 1) - sample(x, y - 1)) * heightStrength;
            // Tangent-space normal = normalize(-dx, -dy, 1)
            const len = Math.sqrt(dx*dx + dy*dy + 1);
            const nx = -dx / len, ny = -dy / len, nz = 1 / len;
            const i = (y * size + x) * 4;
            od[i]     = Math.round((nx * 0.5 + 0.5) * 255);
            od[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            od[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            od[i + 3] = 255;
        }
        if ((y + 1) % 8 === 0) yield { phase: 'normal-map-rows' };
    }
    nctx.putImageData(out, 0, 0);
    yield { phase: 'normal-map-upload' };
    return normalCanvas;
}

function heightCanvasToNormalCanvas(heightCanvas, size) {
    return drainBuildingIterator(heightCanvasToNormalCanvasCooperative(heightCanvas, size));
}

const wallNormalBuilds = [];

function* buildWallNormalVariant(idx) {
    // Normal conversion reads the complete height atlas. Select the readback
    // context on creation: requesting it later cannot change an existing one.
    // Color atlases are only drawn/uploaded and keep their original context.
    const heightCanvas = yield* buildWallAtlasCooperative(
        idx,
        (ctx, size, rand) => paintHeightVariantCooperative(idx, ctx, size, rand),
        'wall-height-atlas-tile',
        { willReadFrequently: true },
    );
    const normalCanvas = yield* heightCanvasToNormalCanvasCooperative(
        heightCanvas,
        heightCanvas.width,
    );
    // Normal maps must NOT be sRGB-decoded; LinearSRGBColorSpace keeps the
    // RGB values as-encoded so the per-pixel vector decoding in the shader
    // (rgb * 2 - 1) lines up with what we wrote.
    const tex = makeRepeatingTexture(
        normalCanvas,
        1 / WALL_TEX_CELL_M,
        1 / WALL_TEX_CELL_M,
        THREE.LinearSRGBColorSpace,
    );
    return tex;
}

function* getWallNormalVariantCooperative(idx) {
    if (_wallNormalTextures[idx]) return _wallNormalTextures[idx];
    let state = wallNormalBuilds[idx];
    if (!state) {
        state = { iterator: buildWallNormalVariant(idx), done: false };
        wallNormalBuilds[idx] = state;
    }
    while (!state.done) {
        let next;
        try {
            next = state.iterator.next();
        } catch (error) {
            wallNormalBuilds[idx] = null;
            throw error;
        }
        if (next.done) {
            if (!next.value) {
                wallNormalBuilds[idx] = null;
                throw new Error(`Wall normal variant ${idx} completed without a texture`);
            }
            _wallNormalTextures[idx] = next.value;
            state.done = true;
            state.iterator = null;
            break;
        }
        yield next.value;
    }
    return _wallNormalTextures[idx];
}

function getWallNormalVariant(idx) {
    return drainBuildingIterator(getWallNormalVariantCooperative(idx));
}

// ─── Parametric window/floor facades ───────────────────────────────────────
// Blank-plaster walls read as unfinished. This paints a real floor/window
// grid anchored to the building base: floor count is derived from the
// building's *actual* height (floorsForHeight), so windows land on plausible
// storeys; the ground floor is a taller shopfront/entrance band; and a
// matching emissive map lights a scatter of windows at night.
//
// Mapping exploits the wall UVs from stageBuildingFeatureGdi (U = metres along
// the wall, V = metres up from the base). The diffuse/emissive tile
// horizontally at one window bay (RepeatWrapping) and are CLAMPED vertically
// (repeat.y = 1/totalHeight) so a single texture spans the whole facade once,
// floors anchored to V=0 at the ground. The surface-grain normal map keeps
// its own tiled transform — three.js r150+ supports per-map UV transforms.
const FACADE_WINDOWS = true;
// Tuned for Zagreb's old-town stock: high ceilings → tall storeys → fewer
// floors, and wide window bays → fewer windows per facade.
const FACADE_FLOOR_M = 4.2;        // upper-storey height (high ceilings)
const FACADE_GROUND_M = 5.0;       // taller ground-floor band
const FACADE_FLOORS_CAP = 40;
const FACADE_BAY_M = 4.6;          // horizontal window-to-window pitch (wide)
const FACADE_BAYS_PER_TILE = 4;    // (legacy) bays per repeat — superseded by per-face bay count
// Real-world opening sizes. The facade texture is now generated per wall face at
// its own bay/floor count and mapped 1:1 (UV 0..1), so a window is drawn at a
// fixed metric size instead of a fraction of a stretched bay — no more squished
// or oversized windows, and whole bays/floors mean nothing gets sliced.
const WINDOW_W_M = 1.35;           // window width
const WINDOW_H_M = 2.0;            // window height (tall — high-ceiling old-town stock)
const FACADE_MIN_FACE_W_M = 2.0;   // narrower wall faces stay blank plaster (no 1-window sliver)
// Footprint-size gates for openings (wall-bbox m², a mild over-estimate for
// L-shapes — fine for this coarse split): below the first, a structure is a
// monument pedestal / substation / kiosk and gets NO openings at all; below
// the second it is shed-sized and gets openings on its WIDEST face only,
// as a single bay (one door), never on three sides of a hut.
const FACADE_MIN_OPENINGS_FOOTPRINT_M2 = 16;
const FACADE_SINGLE_OPENING_FOOTPRINT_M2 = 55;
// Include a small visual safety margin around every painted frame/sill. The
// logical-surface test itself is exact; this margin prevents texture filtering
// at a roof edge from making an otherwise tangent window look clipped.
const FACADE_OPENING_SURFACE_MARGIN_M = 0.03;
const FACADE_PX_PER_M_V = 18;
const FACADE_PX_PER_BAY = 52;
const FACADE_SHOPFRONT_BAY_CHANCE = 0.55;
const FACADE_ENTRANCE_FRAME = '#302a25';
const _facadeTextures = new Map();           // variant/floors/bays/fit-mask → openings-only texture
const _facadeEmissiveTextures = new Map();   // matching fit-mask → emissive texture
// Warm reuse is bounded independently from live borrowers. These are estimates
// for RGBA canvases plus mipmapped texture storage, NOT total browser/GPU memory.
// Active meshes/builds/paints may exceed this idle allowance and stay protected.
const facadeResources = createOwnedResourceCache({ maxIdleBytes: 32 * 1024 * 1024 });
const bindFacadeMeshResource = createMeshResourceBindings({ retain: retainBuildingFacadeMaterial });

function retainBuildingFacadeMaterial(material, owner) {
    return facadeResources.retain(material, owner) || facadeAtlasResources.retain(material, owner);
}

// Storeys from height: first storey is the taller ground band, the rest are
// regular floors. Clamped to a sane range so degenerate heights don't make
// a 0-floor or absurdly tall texture.
function floorsForHeight(h) {
    if (!(h > 0)) return 1;
    const f = Math.round((h - FACADE_GROUND_M) / FACADE_FLOOR_M) + 1;
    return Math.max(1, Math.min(FACADE_FLOORS_CAP, f));
}

function facadeTotalM(floors) {
    return FACADE_GROUND_M + Math.max(0, floors - 1) * FACADE_FLOOR_M;
}

// Per-building window look. The four original styles differed only in two
// colours, so every facade in the city read as the same stamped window; these
// change the opening itself — proportions, how the panes are divided, whether
// it carries a stone sill, a cornice or an arched head.
//
// Every style stays inside the envelope getFacadeOpeningLayout tests (see
// WINDOW_MAX_*_SCALE), so the fit mask that keeps windows off roof edges stays
// valid whichever style a building happens to draw.
const FACADE_WINDOW_STYLES = [
    // Old-town cross casement: pale frame, stone sill, two-over-two panes.
    { frame: '#e8e2d6', glass: '#3a4654', wScale: 1.00, hScale: 1.00, panes: 'cross', sill: 'stone', head: 'none' },
    // Tall French casement, slim transom high in the opening, flat cornice.
    { frame: '#dcd5c4', glass: '#33404c', wScale: 0.92, hScale: 1.12, panes: 'french', sill: 'stone', head: 'cornice' },
    // Wide three-pane, post-war stock: flat frame, no sill relief.
    { frame: '#d8d2c4', glass: '#455259', wScale: 1.15, hScale: 0.88, panes: 'triple', sill: 'flush', head: 'none' },
    // Small deep-set squares, utilitarian.
    { frame: '#cfc7b6', glass: '#2f3b46', wScale: 0.86, hScale: 0.86, panes: 'cross', sill: 'flush', head: 'none' },
    // Historicist segmental arch over a single mullion.
    { frame: '#efe8da', glass: '#36424e', wScale: 0.96, hScale: 1.06, panes: 'vertical', sill: 'stone', head: 'arch' },
    // Modern flush glazing: thin dark frame, one pane, no sill.
    { frame: '#4a4f55', glass: '#4c5a64', wScale: 1.08, hScale: 1.02, panes: 'single', sill: 'flush', head: 'none' },
];
// The mask envelope must cover the largest window ANY style can paint, or a
// building drawing small windows would be told a big one overhangs the roof.
const WINDOW_MAX_W_SCALE = 1.15;
const WINDOW_MAX_H_SCALE = 1.12;

function getFacadeWindowStyle(styleIdx, architectureId = architecturalLocationId()) {
    // The new-build namespace sits above the base: proposal buildings draw from
    // their own modern style set, never location-tinted like the old stock.
    if (styleIdx >= NEW_BUILD_WINDOW_STYLE_BASE) {
        const styles = newBuildWindowStyles(architectureId);
        return styles[(styleIdx - NEW_BUILD_WINDOW_STYLE_BASE) % styles.length];
    }
    const index = ((styleIdx % FACADE_WINDOW_STYLES.length) + FACADE_WINDOW_STYLES.length)
        % FACADE_WINDOW_STYLES.length;
    return resolveFacadeWindowStyle(architectureId, FACADE_WINDOW_STYLES[index], index);
}

// ─── Glass towers ──────────────────────────────────────────────────────────
// Above the threshold a building is not old-town stock with punched windows: it
// is a modern frame with a curtain wall. It gets a continuous glazed skin —
// glass spanning between floor spandrels, mullions on a metric grid — instead of
// windows in plaster, and a material that actually reflects the sky.
//
// Measured at the EAVES, not the ridge. The tallest wall vertex is no good: a
// gable end is a vertical wall with a triangular top, so its apex counts as wall
// height and a short building with a steep roof measured as tall as its ridge —
// which is how short-ish buildings ended up wearing curtain walls.
const FACADE_GLASS_MIN_HEIGHT_M = 35;
// Curtain walls band on an office storey, not the 4.2 m old-town ceiling.
const FACADE_GLASS_FLOOR_M = 3.4;
const FACADE_GLASS_MULLION_M = 1.5;
const FACADE_GLASS_SPANDREL_M = 0.95;
const FACADE_GLASS_STYLES = [
    { glass: '#4d6c80', spandrel: '#2b3a45', mullion: '#b9c2c8', sky: '#93b3c8' }, // blue-green
    { glass: '#6b6352', spandrel: '#3a3529', mullion: '#c9c0a9', sky: '#c0ae86' }, // bronze
    { glass: '#59646b', spandrel: '#333b40', mullion: '#aab4bb', sky: '#9fb0ba' }, // neutral grey
];

// ─── Overture wall/roof variety (Zagreb surroundings) ───────────────────────
// Muted, washed facade shades — grey, beige, white-turned-grey — instead of
// one uniform beige for every Overture building.
// Twelve genuinely DISTINCT muted shades — near-white, cool greys, warm
// beiges, sage-grey, ochre washes — spread far enough apart to read as
// different buildings at a glance (the first attempt was ten flavours of the
// same beige). Variety comes from palette × wear texture (60 shared
// materials total); per-building HSL jitter was dropped deliberately — with
// JITTER_BUCKETS=64 it minted hundreds of unique materials and broke all
// material batching.
const OVERTURE_WALL_PALETTE = [
    0xe0ddd6, 0xd9d2c6, 0xd8cfc0, 0xcfd2d1, 0xc9c0ae, 0xc4cbc6,
    0xbdb9b1, 0xb3ada0, 0xa8a29a, 0x9d9995, 0xd0c2ac, 0xc7b9a8,
];
const OVERTURE_WALL_TEXTURE_VARIANTS = 5;
const OVERTURE_WALL_TILE_M = 6;
let overtureWallTextures = null;

// Five subtle wear recipes (patches, hairline cracks, weather streaks, coarse
// render, rising damp) — deliberately NOT Split's limestone, which stays
// Split-specific. Near-neutral base so the per-building palette colour shows.
function getOvertureWallTexture(variant) {
    const count = OVERTURE_WALL_TEXTURE_VARIANTS;
    const idx = ((variant % count) + count) % count;
    if (!overtureWallTextures) overtureWallTextures = new Array(count).fill(null);
    if (overtureWallTextures[idx]) return overtureWallTextures[idx];
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    let seed = 4242 + idx * 977;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    ctx.fillStyle = '#b8b4ac';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 700; i++) {
        const dark = rand() < 0.55;
        ctx.fillStyle = dark
            ? `rgba(74, 71, 66, ${0.03 + rand() * 0.05})`
            : `rgba(214, 211, 204, ${0.03 + rand() * 0.05})`;
        ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 1.5, 1 + rand() * 1.5);
    }
    if (idx === 0) {
        for (let i = 0; i < 9; i++) {
            const x = rand() * size, y = rand() * size, r = 18 + rand() * 42;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            const tone = rand() < 0.5 ? '92, 89, 83' : '201, 198, 190';
            g.addColorStop(0, `rgba(${tone}, ${0.06 + rand() * 0.05})`);
            g.addColorStop(1, `rgba(${tone}, 0)`);
            ctx.fillStyle = g;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
    } else if (idx === 1) {
        ctx.strokeStyle = 'rgba(64, 61, 55, 0.16)';
        ctx.lineWidth = 1;
        for (let c = 0; c < 4; c++) {
            let x = rand() * size, y = rand() * size * 0.4;
            ctx.beginPath();
            ctx.moveTo(x, y);
            const steps = 6 + Math.floor(rand() * 5);
            for (let k = 0; k < steps; k++) {
                x += (rand() - 0.5) * 26;
                y += 14 + rand() * 22;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    } else if (idx === 2) {
        for (let c = 0; c < 14; c++) {
            const x = rand() * size;
            const w = 3 + rand() * 9;
            const h = size * (0.3 + rand() * 0.7);
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, `rgba(88, 85, 79, ${0.05 + rand() * 0.05})`);
            g.addColorStop(1, 'rgba(88, 85, 79, 0)');
            ctx.fillStyle = g;
            ctx.fillRect(x, 0, w, h);
        }
    } else if (idx === 3) {
        for (let i = 0; i < 1200; i++) {
            const dark = rand() < 0.6;
            ctx.fillStyle = dark
                ? `rgba(70, 67, 62, ${0.05 + rand() * 0.07})`
                : `rgba(220, 217, 210, ${0.04 + rand() * 0.06})`;
            ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
        }
    } else {
        const g = ctx.createLinearGradient(0, size, 0, size * 0.55);
        g.addColorStop(0, 'rgba(96, 92, 84, 0.12)');
        g.addColorStop(1, 'rgba(96, 92, 84, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, size * 0.55, size, size * 0.45);
        for (let i = 0; i < 7; i++) {
            const x = rand() * size, y = size * (0.7 + rand() * 0.3), r = 12 + rand() * 26;
            const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
            blot.addColorStop(0, `rgba(90, 87, 80, ${0.07 + rand() * 0.05})`);
            blot.addColorStop(1, 'rgba(90, 87, 80, 0)');
            ctx.fillStyle = blot;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / OVERTURE_WALL_TILE_M, 1 / OVERTURE_WALL_TILE_M);
    texture.colorSpace = THREE.SRGBColorSpace;
    registerShared(texture);
    overtureWallTextures[idx] = texture;
    return texture;
}

function getOvertureWallMaterial(objectId) {
    if (objectId == null) return buildingMaterial;
    // Proposal massing is NEW construction: whites/light tones and marble
    // cladding instead of the existing stock's weathered greys.
    if (isProposalBuildingObjectId(objectId)) return getNewBuildWallMaterial(objectId);
    const hash = hashObjectId(objectId);
    const paletteIndex = hash % OVERTURE_WALL_PALETTE.length;
    const variant = (hash >>> 3) % OVERTURE_WALL_TEXTURE_VARIANTS;
    const cacheKey = 'ovtWall_' + paletteIndex + '_' + variant;
    if (!buildingMaterials[cacheKey]) {
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(OVERTURE_WALL_PALETTE[paletteIndex]),
            map: getOvertureWallTexture(variant),
            roughness: 0.9,
            envMapIntensity: 0.3,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, true);
        buildingMaterials[cacheKey] = mat;
    }
    return buildingMaterials[cacheKey];
}

// ─── New-build (proposal) walls ─────────────────────────────────────────────
// Fresh construction has no damp stains or hairline cracks, so the Overture
// wear recipes are wrong for it. Three clean finishes: fine render (near-flat
// grain), polished marble (soft veining), and light stone cladding (subtle
// coursing). Palette and finish weights live in building-architectural-style.
const NEW_BUILD_WALL_TILE_M = 6;
let newBuildWallTextures = null;

function getNewBuildWallTexture(finishKey) {
    if (!newBuildWallTextures) newBuildWallTextures = new Map();
    if (newBuildWallTextures.has(finishKey)) return newBuildWallTextures.get(finishKey);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    let seed = 7331 + finishKey.length * 911;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    // Near-white neutral base so the per-building palette colour reads true.
    ctx.fillStyle = '#f0eeea';
    ctx.fillRect(0, 0, size, size);
    if (finishKey === 'marble') {
        // Soft grey-blue veins wandering diagonally, plus faint tonal clouds.
        for (let i = 0; i < 6; i++) {
            const x0 = rand() * size, y0 = rand() * size, r = 40 + rand() * 70;
            const g = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
            g.addColorStop(0, `rgba(206, 208, 212, ${0.10 + rand() * 0.08})`);
            g.addColorStop(1, 'rgba(206, 208, 212, 0)');
            ctx.fillStyle = g;
            ctx.fillRect(x0 - r, y0 - r, r * 2, r * 2);
        }
        for (let v = 0; v < 7; v++) {
            ctx.strokeStyle = `rgba(148, 154, 162, ${0.10 + rand() * 0.10})`;
            ctx.lineWidth = 0.6 + rand() * 0.9;
            let x = rand() * size, y = rand() * size * 0.3;
            ctx.beginPath();
            ctx.moveTo(x, y);
            const steps = 5 + Math.floor(rand() * 4);
            for (let k = 0; k < steps; k++) {
                x += 10 + rand() * 30;
                y += 18 + rand() * 34;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    } else if (finishKey === 'stone') {
        // Subtle horizontal coursing (~0.9 m) with a whisper of speckle.
        ctx.strokeStyle = 'rgba(150, 146, 138, 0.14)';
        ctx.lineWidth = 1;
        for (let y = 38; y < size; y += 38) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(size, y);
            ctx.stroke();
        }
        for (let i = 0; i < 260; i++) {
            ctx.fillStyle = rand() < 0.5
                ? `rgba(160, 156, 148, ${0.03 + rand() * 0.04})`
                : `rgba(252, 250, 246, ${0.03 + rand() * 0.04})`;
            ctx.fillRect(rand() * size, rand() * size, 1 + rand(), 1 + rand());
        }
    } else if (finishKey === 'tiles') {
        // Ceramic tile grid, 0.75 m cells (32 px divides the 256 px wrap):
        // faint per-tile tone shifts under bright grout lines.
        const cell = 32;
        for (let ty = 0; ty < size; ty += cell) {
            for (let tx = 0; tx < size; tx += cell) {
                const tone = rand();
                ctx.fillStyle = tone < 0.5
                    ? `rgba(198, 196, 190, ${0.04 + tone * 0.08})`
                    : `rgba(255, 253, 248, ${0.04 + (tone - 0.5) * 0.08})`;
                ctx.fillRect(tx, ty, cell, cell);
            }
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        for (let g = 0; g < size; g += cell) {
            ctx.fillRect(0, g, size, 1);
            ctx.fillRect(g, 0, 1, size);
        }
        // A hair of shadow beside each grout line sells the relief.
        ctx.fillStyle = 'rgba(120, 117, 110, 0.14)';
        for (let g = 0; g < size; g += cell) {
            ctx.fillRect(0, g + 1, size, 1);
            ctx.fillRect(g + 1, 0, 1, size);
        }
    } else if (finishKey === 'blocks') {
        // Staggered ashlar: 0.75 m courses of 1.5 m blocks with light seams.
        const course = 32;
        const block = 64;
        for (let row = 0; row * course < size; row++) {
            const y = row * course;
            const shift = (row % 2) * (block / 2);
            for (let x = -block; x < size + block; x += block) {
                const tone = rand();
                ctx.fillStyle = tone < 0.5
                    ? `rgba(196, 192, 184, ${0.05 + tone * 0.10})`
                    : `rgba(255, 252, 246, ${0.05 + (tone - 0.5) * 0.10})`;
                ctx.fillRect(x + shift, y, block, course);
            }
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        for (let y = 0; y < size; y += course) {
            ctx.fillRect(0, y, size, 1);
            const shift = ((y / course) % 2) * (block / 2);
            for (let x = shift; x < size + block; x += block) {
                ctx.fillRect((x % size + size) % size, y, 1, course);
            }
        }
        ctx.fillStyle = 'rgba(118, 114, 106, 0.16)';
        for (let y = 0; y < size; y += course) ctx.fillRect(0, y + 1, size, 1);
    } else {
        // Fine fresh render: sparse micro-speckle, no wear.
        for (let i = 0; i < 320; i++) {
            ctx.fillStyle = rand() < 0.5
                ? `rgba(190, 187, 180, ${0.03 + rand() * 0.04})`
                : `rgba(255, 253, 248, ${0.03 + rand() * 0.04})`;
            ctx.fillRect(rand() * size, rand() * size, 1 + rand(), 1 + rand());
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / NEW_BUILD_WALL_TILE_M, 1 / NEW_BUILD_WALL_TILE_M);
    texture.colorSpace = THREE.SRGBColorSpace;
    registerShared(texture);
    newBuildWallTextures.set(finishKey, texture);
    return texture;
}

function getNewBuildWallMaterial(objectId) {
    const hash = hashObjectId(objectId);
    const paletteIndex = hash % NEW_BUILD_WALL_PALETTE.length;
    const finishIndex = (hash >>> 3) % NEW_BUILD_WALL_FINISHES.length;
    const finish = NEW_BUILD_WALL_FINISHES[finishIndex];
    const cacheKey = 'nbWall_' + paletteIndex + '_' + finishIndex;
    if (!buildingMaterials[cacheKey]) {
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(NEW_BUILD_WALL_PALETTE[paletteIndex]),
            map: getNewBuildWallTexture(finish.key),
            roughness: finish.roughness,
            envMapIntensity: finish.envMapIntensity,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, true);
        buildingMaterials[cacheKey] = mat;
        // Declare the batcher colour family, one per finish TEXTURE (both
        // marble slots share one), or every palette×finish combo becomes its
        // own aggregate bucket per tile — measured as ~+500 scene meshes over
        // the Šibenik plan before this line existed.
        wallColorFamilyByMaterial.set(mat, {
            familyKey: `nbWallFamily_${finish.key}`,
            color: mat.color.toArray(),
        });
    }
    return buildingMaterials[cacheKey];
}

// Flat roofs carry waterproofing/gravel — dark greys, never the body colour.
const OVERTURE_FLAT_ROOF_PALETTE = [0x4d4b47, 0x413f3b, 0x565349, 0x474a45, 0x3d3b38];
let overtureFlatRoofTexture = null;
function getOvertureFlatRoofTexture() {
    if (overtureFlatRoofTexture) return overtureFlatRoofTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    let seed = 9091;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    ctx.fillStyle = '#8f8d88';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
        const dark = rand() < 0.5;
        ctx.fillStyle = dark
            ? `rgba(52, 51, 48, ${0.10 + rand() * 0.14})`
            : `rgba(176, 173, 166, ${0.08 + rand() * 0.12})`;
        ctx.fillRect(rand() * size, rand() * size, 1, 1);
    }
    overtureFlatRoofTexture = new THREE.CanvasTexture(canvas);
    overtureFlatRoofTexture.wrapS = overtureFlatRoofTexture.wrapT = THREE.RepeatWrapping;
    overtureFlatRoofTexture.repeat.set(1 / 3, 1 / 3);
    overtureFlatRoofTexture.colorSpace = THREE.SRGBColorSpace;
    registerShared(overtureFlatRoofTexture);
    return overtureFlatRoofTexture;
}

function getOvertureFlatRoofMaterial(objectId) {
    const hash = objectId == null ? 0 : hashObjectId(objectId);
    const paletteIndex = hash % OVERTURE_FLAT_ROOF_PALETTE.length;
    const cacheKey = 'ovtFlatRoof_' + paletteIndex;
    if (!buildingMaterials[cacheKey]) {
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(OVERTURE_FLAT_ROOF_PALETTE[paletteIndex]),
            map: getOvertureFlatRoofTexture(),
            roughness: 0.97,
            metalness: 0,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, false);
        buildingMaterials[cacheKey] = mat;
    }
    return buildingMaterials[cacheKey];
}

// Insulated flat-roof cap for Overture buildings that end level: the bare
// extrusion top used to show the wall beige — flat roofs are grey/dark
// (membrane, gravel), never blank body-coloured slabs.
const roofActivityOwnerId = objectId => `building:${String(objectId)}`;

function localRoofActivityRings(polygon, aLat, aLon) {
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const rings = [];
    for (const ring of polygon?.coordinates || []) {
        if (!Array.isArray(ring) || ring.length < 4) continue;
        const local = [];
        for (const coordinate of ring) {
            const lon = Number(coordinate?.[0]);
            const lat = Number(coordinate?.[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
                local.length = 0;
                break;
            }
            local.push({
                x: (lon - aLon) * scaleLon,
                z: -(lat - aLat) * scaleLat,
            });
        }
        if (local.length >= 4) rings.push(local);
    }
    return rings;
}

function addOvertureFlatRoofCap(
    polygon,
    heightM,
    objectId,
    aLat,
    aLon,
    foundationY,
    polygonIndex = 0,
) {
    const ring = polygon.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const shape = new THREE.Shape();
    for (let i = 0; i < ring.length; i++) {
        const x = (ring[i][0] - aLon) * scaleLon;
        const z = -(ring[i][1] - aLat) * scaleLat;
        if (i === 0) shape.moveTo(x, -z);
        else shape.lineTo(x, -z);
    }
    // Courtyards stay open to the sky: the extrusion below keeps the hole
    // (createBuildingMesh), so a cap without it would roof the court over.
    for (let r = 1; r < polygon.coordinates.length; r++) {
        const hole = polygon.coordinates[r];
        if (!Array.isArray(hole) || hole.length < 3) continue;
        const path = new THREE.Path();
        for (let i = 0; i < hole.length; i++) {
            const x = (hole[i][0] - aLon) * scaleLon;
            const z = -(hole[i][1] - aLat) * scaleLat;
            if (i === 0) path.moveTo(x, -z);
            else path.lineTo(x, -z);
        }
        shape.holes.push(path);
    }
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    const material = getOvertureFlatRoofMaterial(objectId);
    const cap = new THREE.Mesh(geometry, material);
    const capY = foundationY + Math.max(heightM || 3, 1) + 0.03;
    cap.position.y = capY;
    cap.castShadow = false;
    cap.receiveShadow = true;
    cap.userData.baseBuildingRoof = true;
    cap.userData.flatRoof = true;
    if (objectId != null) cap.userData.objectId = objectId;
    setPassageAwareMaterial(cap, material);
    buildingsGroup.add(cap);
    // New-build roofs get LIVED-ON tops — railing, jogging track, greenery,
    // terrace furniture and occasional pools. Opaque decor and translucent
    // water each share one material, so the tile batcher folds the region into
    // at most two decor draw calls rather than one draw per roof.
    let roofLayout = null;
    if (isProposalBuildingObjectId(objectId)) {
        const decor = buildNewBuildRoofDecorMeshes(
            polygon.coordinates, aLat, aLon, hashObjectId(objectId));
        if (decor) {
            roofLayout = decor.layout;
            for (const mesh of decor.meshes) {
                mesh.position.y = capY;
                mesh.userData.objectId = objectId;
                buildingsGroup.add(mesh);
            }
        }
    }
    // Only this footprint path publishes roof activity: its Polygon rings,
    // holes, flat classification and cap height are all exact. Ambiguous mesh
    // roofs stay excluded rather than letting a person stand over a lower wing.
    if (objectId != null) {
        registerRoofActivitySurface({
            id: `${String(objectId)}:${polygonIndex}`,
            ownerId: roofActivityOwnerId(objectId),
            rings: localRoofActivityRings(polygon, aLat, aLon),
            floorY: capY,
            obstacles: roofLayout?.pool ? [roofLayout.pool] : [],
            benches: roofLayout?.benches || [],
        });
    }
}

// ─── Massive-volume curtain walls ──────────────────────────────────────────
// Buildings that are not tall but HUGE by volume are halls, terminals and
// logistics sheds — house-like procedural windows read wrong on them, so they
// get large glass panels instead. City-proper keeps its 35 m height rule.
//
// The thresholds and the band now live in the active location's config
// (locations.js), not in this file: they used to be a bare latitude ceiling,
// which every coastal location sits entirely below, so ordinary two-storey
// coastal buildings were being glazed like the airport terminal.
// Hall curtain modules are LARGER than the downtown tower grid — big glass
// panels, generous storey pitch.
const VG_CURTAIN_BAY_M = 2.8;
const VG_CURTAIN_FLOOR_M = 4.0;
const VG_CURTAIN_SPANDREL_M = 1.0;
// The TOP-3 buildings of the airport area itself (terminal + the two big
// halls; volumes 170k/99k/58k m³ with a clean gap to 20k next — from the
// ingested Overture data) wear terminal-scale glazing: panels 4× the hall
// module (2× per side). Baked by stable Overture id, airport bbox only.
const VG_XL_CURTAIN_IDS = new Set([
    '23b2322d-0fc4-4302-9447-ba8ff8341a05',
    'a1501102-aa07-45a8-b7ce-7d4d9fd2bc2e',
    'c4302cd3-f4a4-41c4-9ef1-84bb4afd9018',
]);
const VG_XL_CURTAIN_BAY_M = VG_CURTAIN_BAY_M * 2;
const VG_XL_CURTAIN_FLOOR_M = VG_CURTAIN_FLOOR_M * 2;
const VG_XL_CURTAIN_SPANDREL_M = 1.6;

function overtureRingAreaM2(ring, aLat) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const x1 = ring[i][0] * scaleLon, y1 = ring[i][1] * scaleLat;
        const x2 = ring[i + 1][0] * scaleLon, y2 = ring[i + 1][1] * scaleLat;
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) * 0.5;
}

// Geometry here, policy in building-architectural-style.js. The current
// architectural region supplies the massive-volume rule, so a location that
// was never granted it cannot fall into it by latitude.
function isMassiveVolumeOverture(ring, heightM, aLat) {
    const config = architecturalLocationConfig().massiveVolumeCurtains || null;
    if (!config || !Array.isArray(ring) || ring.length < 4) return false;
    let latSum = 0;
    for (const c of ring) latSum += Number(c[1]) || 0;
    return hasMassiveVolumeCurtain(config, {
        areaM2: overtureRingAreaM2(ring, aLat),
        heightM,
        latitude: latSum / ring.length,
    });
}

let curtainWallTextures = null;
function getCurtainWallTexture(styleIndex, xl = false) {
    const count = FACADE_GLASS_STYLES.length;
    const idx = ((styleIndex % count) + count) % count;
    const slot = idx + (xl ? count : 0);
    if (!curtainWallTextures) curtainWallTextures = new Array(count * 2).fill(null);
    if (curtainWallTextures[slot]) return curtainWallTextures[slot];
    const style = FACADE_GLASS_STYLES[idx];
    const w = 160, h = 224;   // one bay × one storey (metres set by repeat)
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const floorM = xl ? VG_XL_CURTAIN_FLOOR_M : VG_CURTAIN_FLOOR_M;
    const bayM = xl ? VG_XL_CURTAIN_BAY_M : VG_CURTAIN_BAY_M;
    const spandrelM = xl ? VG_XL_CURTAIN_SPANDREL_M : VG_CURTAIN_SPANDREL_M;
    const spandrelPx = Math.round(h * (spandrelM / floorM));
    const glass = ctx.createLinearGradient(0, 0, 0, h - spandrelPx);
    glass.addColorStop(0, style.sky);
    glass.addColorStop(0.35, style.glass);
    glass.addColorStop(1, style.glass);
    ctx.fillStyle = glass;
    ctx.fillRect(0, 0, w, h - spandrelPx);
    ctx.fillStyle = style.spandrel;
    ctx.fillRect(0, h - spandrelPx, w, spandrelPx);
    ctx.fillStyle = style.mullion;
    ctx.fillRect(0, 0, 3, h);
    ctx.fillRect(0, h - spandrelPx - 2, w, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(Math.round(w * 0.16), 0, Math.round(w * 0.10), h - spandrelPx);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / bayM, 1 / floorM);
    texture.colorSpace = THREE.SRGBColorSpace;
    registerShared(texture);
    curtainWallTextures[slot] = texture;
    return texture;
}

function getCurtainWallMaterial(objectId) {
    const hash = objectId == null ? 0 : hashObjectId(objectId);
    const styleIndex = hash % FACADE_GLASS_STYLES.length;
    const xl = objectId != null && VG_XL_CURTAIN_IDS.has(String(objectId));
    const cacheKey = 'ovtCurtain_' + styleIndex + (xl ? '_xl' : '');
    if (!buildingMaterials[cacheKey]) {
        const mat = new THREE.MeshStandardMaterial({
            map: getCurtainWallTexture(styleIndex, xl),
            metalness: 0.5,
            roughness: 0.38,
            envMapIntensity: 0.8,
            side: THREE.DoubleSide,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, true);
        buildingMaterials[cacheKey] = mat;
    }
    return buildingMaterials[cacheKey];
}

// Full-height curtain-wall overlay over the extrusion walls. It used to be built
// on the SAME ring and rely on the base wall's polygonOffset to sit behind, but a
// depth-buffer bias of one unit is below precision a few hundred metres out, so the
// tan extrusion wall streaked through the glass. The overlay is now pushed
// physically clear of the wall it covers, which does not care about range.
const CURTAIN_WALL_CLEARANCE_M = 0.03;
function addCurtainWallMesh(polygon, height, objectId, aLat, aLon) {
    const wallData = buildFootprintWallGeometry(
        offsetPolygonOutward(polygon, CURTAIN_WALL_CLEARANCE_M, aLat),
        height,
        aLon,
        aLat,
    );
    if (!wallData) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(wallData.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(wallData.uvs, 2));
    geometry.computeVertexNormals();
    const material = getCurtainWallMaterial(objectId);
    const mesh = new THREE.Mesh(geometry, material);
    const ring = polygon.coordinates?.[0];
    mesh.position.y = terrainReference && ring
        ? terrainReference.evidenceFoundationSceneY(ring)
        : 0;
    mesh.name = 'VgMassiveCurtainWall';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (objectId != null) mesh.userData.objectId = objectId;
    setPassageAwareMaterial(mesh, material);
    buildingsGroup.add(mesh);
}

export function isGlassTowerHeight(heightM) {
    return Number.isFinite(heightM) && heightM >= FACADE_GLASS_MIN_HEIGHT_M;
}

// Bright "showroom" glass for ground-floor commercial fronts: a vertical
// gradient (sky reflection up top, darker interior at the bottom) plus a
// diagonal sheen, so the street level reads as lit display windows rather than
// the dark punched windows of the residential floors above.
function paintShopGlass(ctx, x, y, w, hh) {
    const g = ctx.createLinearGradient(x, y, x, y + hh);
    g.addColorStop(0.0, '#b6c6d1');
    g.addColorStop(0.5, '#90a6b4');
    g.addColorStop(1.0, '#6f8492');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, hh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, hh);
    ctx.clip();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    const sw = w * 0.3;
    const sx = x + w * 0.12;
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(sx + sw, y);
    ctx.lineTo(sx + sw - hh * 0.6, y + hh);
    ctx.lineTo(sx - hh * 0.6, y + hh);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// Stable per-facade variation: one entrance, with the other ground-floor bays
// independently split between commercial fronts and ordinary windows. Keeping
// this seeded prevents storefronts from changing whenever a tile is rebuilt.
//
// Only a STREET-FACING facade earns them (world/street-facing.js decides). A
// courtyard wall gets ordinary windows on its ground floor: it has no shop and
// no front door onto a street that isn't there.
export function getGroundFloorBayTypes(variantIdx, bays, storefronts = true) {
    const count = Math.max(1, Math.floor(bays));
    if (!storefronts) return Array.from({ length: count }, () => 'window');
    const rand = createSeededRandom(((variantIdx + 1) * 1597334677) ^ (count * 3812015801));
    const entranceBay = Math.floor(rand() * count);
    return Array.from({ length: count }, (_, bay) => {
        if (bay === entranceBay) return 'entrance';
        return rand() < FACADE_SHOPFRONT_BAY_CHANCE ? 'shopfront' : 'window';
    });
}

// Returns the complete painted envelope of every desired opening in texture
// coordinates. The mask and the painter consume the same ordering: upper
// storeys bottom-to-top, then the ground-floor bays left-to-right.
function getFacadeOpeningLayout(floors, bays) {
    const totalM = facadeTotalM(floors);
    const bayPx = FACADE_PX_PER_BAY;
    const widthPx = Math.max(1, bays * bayPx);
    const heightPx = Math.max(1, Math.round(totalM * FACADE_PX_PER_M_V));
    const groundPx = Math.round(FACADE_GROUND_M * FACADE_PX_PER_M_V);
    const upperPx = FACADE_FLOOR_M * FACADE_PX_PER_M_V;
    const winW = (WINDOW_W_M / FACADE_BAY_M) * bayPx;
    const winH = Math.min(WINDOW_H_M * FACADE_PX_PER_M_V, upperPx * 0.82);
    // Envelope of the biggest window on offer, plus room for a sill or an
    // arched head. Painting stays inside it whichever style is drawn.
    const envW = winW * WINDOW_MAX_W_SCALE;
    const envH = Math.min(winH * WINDOW_MAX_H_SCALE, upperPx * 0.82);
    const openings = [];

    for (let floor = 1; floor < floors; floor++) {
        const bandBottom = heightPx - groundPx - (floor - 1) * upperPx;
        const bandTop = bandBottom - upperPx;
        const top = bandTop + (upperPx - envH) / 2;
        for (let bay = 0; bay < bays; bay++) {
            const cx = bay * bayPx + bayPx / 2;
            openings.push({
                minX: cx - envW / 2 - 5,
                maxX: cx + envW / 2 + 5,
                minY: top - 6,
                maxY: top + envH + 5,
            });
        }
    }

    // The shopfront is wider than the entrance that may replace it, so this
    // envelope safely covers either deterministic ground-floor treatment.
    const groundTop = heightPx - groundPx;
    const openTop = groundTop + groundPx * 0.15;
    const openH = groundPx * 0.72;
    const sillH = Math.max(2, Math.round(groundPx * 0.05));
    const doorTop = groundTop + groundPx * 0.11;
    const doorH = groundPx * 0.82;
    for (let bay = 0; bay < bays; bay++) {
        const margin = bayPx * 0.14;
        const gx = bay * bayPx + margin, gw = bayPx - margin * 2;
        openings.push({
            minX: gx - 3,
            maxX: gx + gw + 3,
            minY: Math.min(openTop - 3, doorTop - 3),
            maxY: Math.max(openTop + openH + sillH, doorTop + doorH + 3),
        });
    }
    return { widthPx, heightPx, groundPx, upperPx, winW, winH, openings };
}

// minOpeningV: the height a neighbouring building buries this wall to (see
// world/street-facing.js). Openings whose frame reaches below it are dropped —
// the storeys behind the neighbour have no facade, while the exposed band above
// its roof keeps its windows.
// Spans of this wall (in its own u/V frame) crossed by a passage cut volume.
// Openings must not be laid out there: the discard hole would slice them,
// leaving half-windows at the jambs and panels floating inside the arch.
const PASSAGE_OPENING_CLEARANCE_M = 0.25;
function passageBlockedRectsOnSurface(surface) {
    if (allPassageCutVolumes.length === 0) return null;
    const baseX = surface.d * surface.nx;
    const baseZ = surface.d * surface.nz;
    let rects = null;
    for (const v of allPassageCutVolumes) {
        // Clip the wall's base line p(u) = base + u·t against the volume's
        // oriented XZ rectangle (standard slab test, linear in u).
        let start = surface.minU;
        let end = surface.maxU;
        const dx = baseX - v.centerX;
        const dz = baseZ - v.centerZ;
        const clipAxis = (origin, delta, half) => {
            if (Math.abs(delta) < 1e-9) return Math.abs(origin) <= half;
            let enter = (-half - origin) / delta;
            let exit = (half - origin) / delta;
            if (enter > exit) [enter, exit] = [exit, enter];
            start = Math.max(start, enter);
            end = Math.min(end, exit);
            return end > start;
        };
        if (!clipAxis(dx * v.rightX + dz * v.rightZ, surface.tx * v.rightX + surface.tz * v.rightZ, v.halfWidth)) continue;
        if (!clipAxis(dx * v.alongX + dz * v.alongZ, surface.tx * v.alongX + surface.tz * v.alongZ, v.halfDepth)) continue;
        if (!rects) rects = [];
        // V is the wall's OWN vertical coordinate — 0 at the building base,
        // because a facade is built base-at-0 and the mesh is lifted onto the
        // terrain afterwards. A courtyard-passage OBB therefore reports its
        // band twice: centerY/halfHeight in scene-Y for the shader, and
        // cutHeightM measured from the building base for exactly this frame.
        // Reading the scene band here would reserve nothing near the arch on
        // any slope (and paint windows straight across the opening). Volumes
        // with no local band are the planner's remove-the-whole-building cuts,
        // whose scene span is deliberately far taller than any wall.
        const bandBottomV = Number.isFinite(v.cutHeightM) ? 0 : v.centerY - v.halfHeight;
        const bandTopV = Number.isFinite(v.cutHeightM)
            ? v.cutHeightM
            : v.centerY + v.halfHeight;
        rects.push({
            minU: start - PASSAGE_OPENING_CLEARANCE_M,
            maxU: end + PASSAGE_OPENING_CLEARANCE_M,
            minV: bandBottomV - PASSAGE_OPENING_CLEARANCE_M,
            // Reserve the volume's full potential height, not its current
            // one: a road's cut height follows the minimum arch among live
            // passages and can GROW up to PASSAGE_HEIGHT_M when tiles evict,
            // slicing any window painted just above the current hole.
            maxV: Math.max(bandTopV, PASSAGE_HEIGHT_M) + PASSAGE_OPENING_CLEARANCE_M,
        });
    }
    return rects;
}

export function getFacadeOpeningMask(surface, floors, bays, minOpeningV = 0, headM = surface.maxV) {
    const layout = getFacadeOpeningLayout(floors, bays);
    const widthM = surface.maxU - surface.minU;
    // The grid spans the storeyed wall, which ends at the eaves — NOT at maxV,
    // which on a gable end is the ridge. See getFacadeHeadHeight().
    const topM = headM;
    const margin = FACADE_OPENING_SURFACE_MARGIN_M;
    const coveredToV = Number.isFinite(minOpeningV) ? minOpeningV : 0;
    let blockedRects = passageBlockedRectsOnSurface(surface);
    // A taller coplanar wall (another object re-modelling this same street
    // wall) covers part of this surface: never lay openings there. Geometry
    // inset alone only wins the depth test up close — from afar the offset
    // overlay pulls through and the facade shows two overlapping grids.
    if (surface.coveredByTallerRects) {
        blockedRects = blockedRects
            ? blockedRects.concat(surface.coveredByTallerRects)
            : surface.coveredByTallerRects;
    }
    const mask = layout.openings.map((opening) => {
        const rect = {
            minU: surface.minU + widthM * opening.minX / layout.widthPx - margin,
            maxU: surface.minU + widthM * opening.maxX / layout.widthPx + margin,
            // Canvas Y points down and CanvasTexture flipY maps its bottom to
            // facade V=0, exactly like the UVs assigned below.
            minV: topM * (1 - opening.maxY / layout.heightPx) - margin,
            maxV: topM * (1 - opening.minY / layout.heightPx) + margin,
        };
        if (rect.minV < coveredToV) return '0';
        if (blockedRects) {
            for (const blocked of blockedRects) {
                if (rect.minU < blocked.maxU && rect.maxU > blocked.minU &&
                    rect.minV < blocked.maxV && rect.maxV > blocked.minV) return '0';
            }
        }
        return rectangleFullyCoveredBySurface(surface, rect) ? '1' : '0';
    }).join('');
    return mask.includes('0') ? mask : null;
}

// ─── Late passage → overlay re-mask ─────────────────────────────────────────
// A passage can register AFTER its building's facade was painted (the road
// tile may live a ring farther than the building tile, or simply arrive
// later). The overlay GEOMETRY never encodes the opening mask — only its
// material's texture does — so a late fix is: recompute each surface
// segment's mask, regroup segments by their (cached) material, and swap /
// split the overlay mesh accordingly. Coalesced through the building queue and
// prefiltered by bounds; replacements stay detached until their GPU work is ready.
let overlayRepaintScheduled = null;
let overlayRepaintedRevision = 0;
let overlayRepaintFailed = 0;
const pendingOverlayReplacements = new Map();
const overlayRepaintWarmups = new Set();

function scheduleOverlayPassageRepaint() {
    if (!buildingsGroup) return;
    if (overlayRepaintScheduled?.revision === passageCutVolumesRevision) return;
    if (overlayRepaintScheduled) buildQueue.cancel(overlayRepaintScheduled.job);
    if (overlayRepaintedRevision === passageCutVolumesRevision) return;
    const run = {
        revision: passageCutVolumesRevision,
        session: buildingsSessionToken,
        group: buildingsGroup,
        phase: 'scan',
        job: null,
    };
    const iterator = repaintOverlaysForPassages(run);
    overlayRepaintScheduled = run;
    overlayRepaintFailed = 0;
    const finish = () => {
        iterator.return();
        if (overlayRepaintScheduled === run) overlayRepaintScheduled = null;
    };
    run.job = buildQueue.enqueue([run], () => {
        if (run.session !== buildingsSessionToken || run.group !== buildingsGroup
            || run.revision !== passageCutVolumesRevision) {
            iterator.return();
            return undefined;
        }
        const started = buildingNowMs();
        const next = iterator.next();
        run.phase = next.value?.phase || 'complete';
        recordLayerFrameMs(`bld:overlay:${run.phase}`, buildingNowMs() - started);
        return next.done ? undefined
            : next.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
    }, {
        describeItem: () => `passage facade ${run.phase}`,
        onComplete() {
            finish();
            overlayRepaintedRevision = run.revision;
            scheduleOverlayPassageRepaint();
        },
        onCancel: finish,
        onError(error) {
            finish();
            overlayRepaintFailed += 1;
            console.error('[Station3D] passage facade replacement failed:', error);
        },
    });
}

function overlapsAnyPassage(bounds) {
    for (const volume of allPassageCutVolumes) {
        if (meshBoundsOverlapPassage(bounds, volume)) return true;
    }
    return false;
}

// Reconstruct a merged overlay off-scene with its original source UVs. Its old
// aggregate keeps drawing until the prepared replacement can swap with it.
//
// Re-masking splits an overlay by material — one wall's segments can end up
// needing two different textures — so the merged form would have to move parts
// between buckets and re-assemble both. Passages are rare (Zagreb's densest
// walk had 99 of them) and each one un-merges a single building, so paying the
// individual-mesh cost for those and keeping the existing, working re-split is
// the cheaper and far less risky trade.
function createOverlayOwnerMesh(record) {
    const descriptor = overtureBucketDescriptors.get(record.bucketKey);
    if (!descriptor || !buildingsGroup) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(record.positions, 3));
    if (record.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(record.uv, 2));
    geometry.computeVertexNormals();
    const source = record.facadeSource;
    const material = source ? getFacadeOverlayMaterial(
        source.objectId, source.floors, source.bays, source.openingMask,
        source.storefronts, source.glass, source,
    ) : descriptor.material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'BuildingFacadeOverlay';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.objectId = record.objectId;
    mesh.userData.tileKey = record.scope;
    mesh.userData.facadeWindowOverlay = true;
    mesh.userData.overlayRepaint = { objectId: record.objectId, segments: record.segments, facadeSource: source };
    setPassageAwareMaterial(mesh, material);
    return mesh;
}

function* repaintOverlaysForPassages(run) {
    if (!buildingsGroup || allPassageCutVolumes.length === 0) return;
    const candidates = [];
    // Overlays still drawn as their own mesh (never merged, or already
    // un-merged by an earlier repaint).
    const scan = [...buildingsGroup.children];
    for (let i = 0; i < scan.length; i++) {
        const object = scan[i];
        for (const child of object.children) scan.push(child);
        if (object.isMesh && object.userData?.overlayRepaint) {
            const bounds = getPassageMeshBounds(object);
            if (bounds && overlapsAnyPassage(bounds)) candidates.push({ mesh: object });
        }
        if (i % 32 === 31) yield { phase: 'scan' };
    }
    // Merged owners retain their published aggregate while the replacement is
    // prepared. A pending owner must not be removed a second time by a new sweep.
    let scanned = 0;
    for (const record of [...overlayOwnersByKey.values()]) {
        if (record.passageRepaint && overlapsAnyPassage(record.bounds)
            && !pendingOverlayReplacements.get(record.bucketKey)?.has(record.ownerKey)) {
            candidates.push({ record });
        }
        if (++scanned % 32 === 0) yield { phase: 'scan' };
    }
    for (const candidate of candidates) yield* prepareOverlayPassageReplacement(candidate, run);
}

function disposeOverlayStagedRoot(root) {
    for (const mesh of [...root.children]) {
        mesh.geometry.dispose();
        root.remove(mesh);
    }
}

function* prepareOverlayPassageReplacement({ mesh: publishedMesh, record }, run) {
    const closeKey = record ? `${record.ownerKey}#${record.bucketKey}` : null;
    const parent = publishedMesh?.parent;
    const current = () => run.session === buildingsSessionToken && run.group === buildingsGroup
        && run.revision === passageCutVolumesRevision
        && (record
            ? overlayOwnersByKey.get(closeKey) === record
                && !tileVisualReplacements.has(record.scope)
                && !pendingOverlayReplacements.get(record.bucketKey)?.has(record.ownerKey)
            : !!parent && publishedMesh.parent === parent);
    if (!current()) return;
    const source = publishedMesh || createOverlayOwnerMesh(record);
    if (!source) return;
    const staged = new THREE.Group();
    let transferred = false, warmup = null, upload = null, uploadReady = null;
    const releaseWarmup = () => {
        if (!warmup) return;
        overlayRepaintWarmups.delete(warmup);
        warmup.dispose(); // owned shader clones outlive any pending compiler fence
    };
    try {
        if (!(yield* repaintOverlayMeshForPassages(source, staged))) return;
        if (!current()) return;
        if (staged.children.length) {
            const proxy = new THREE.Group();
            // Camera movement can switch a facade between its base and passage
            // shader. Warm both exact variants; uniforms still come from the engine.
            for (const mesh of staged.children) {
                const base = passageBaseMaterialByMesh.get(mesh);
                const variant = getPassageMaterialVariant(base);
                for (const material of new Set([base, variant])) {
                    // Object3D.clone serializes userData, including every facade
                    // surface. Shader proxies need only geometry and render state.
                    const object = new THREE.Mesh(mesh.geometry, material);
                    object.position.copy(mesh.position);
                    object.quaternion.copy(mesh.quaternion);
                    object.scale.copy(mesh.scale);
                    object.receiveShadow = mesh.receiveShadow;
                    proxy.add(object);
                }
            }
            warmup = createQueuedShaderWarmup(proxy, {
                renderer, camera, targetScene: scene, label: 'building-passage-facade-shader',
            });
            overlayRepaintWarmups.add(warmup);
            while (!warmup.ready) {
                if (warmup.error) throw warmup.error;
                if (warmup.closed || !current()) return;
                yield { phase: 'shader-wait', deferFrame: true };
            }
            upload = prewarmDetachedObject(staged, {
                renderer, camera, targetScene: scene, label: 'building-passage-facade',
                asyncShaders: true, prewarmShaders: false,
            });
            for (;;) {
                if (!current()) return;
                const next = upload.next();
                uploadReady = next.value?.ready || null;
                if (next.done) break;
                yield next.value;
            }
        }
        if (!current()) return;
        // The first visible use must find a live program, not one evicted when
        // a warmup clone was disposed. Keep the clones for these meshes' lifetime.
        let remaining = staged.children.length;
        for (const mesh of staged.children) {
            const onDispose = () => {
                mesh.geometry.removeEventListener('dispose', onDispose);
                if (--remaining === 0) releaseWarmup();
            };
            mesh.geometry.addEventListener('dispose', onDispose);
        }
        if (record) {
            if (!overtureBatcher.removeOwner(record.bucketKey, record.ownerKey)) return;
            let pending = pendingOverlayReplacements.get(record.bucketKey);
            if (!pending) {
                pending = new Map();
                pendingOverlayReplacements.set(record.bucketKey, pending);
            }
            pending.set(record.ownerKey, { record, staged, revision: run.revision, session: run.session });
            // Removing a source part does not retire the old rendered aggregate.
            // Publish the standalone overlays in its rebuild's commit below.
            queueOvertureBucket(record.bucketKey);
        } else {
            for (const mesh of [...staged.children]) {
                mesh.visible = publishedMesh.visible;
                parent.add(mesh);
            }
            parent.remove(publishedMesh);
            publishedMesh.geometry.dispose();
        }
        transferred = true;
        yield { phase: 'publish' };
    } finally {
        if (!publishedMesh) source.geometry.dispose();
        if (!transferred) {
            releaseWarmup();
            const discard = () => {
                upload?.return();
                disposeOverlayStagedRoot(staged);
            };
            if (uploadReady) uploadReady.then(discard, discard);
            else discard();
        }
    }
}

function publishPendingOverlayReplacements(bucketKey) {
    const pending = pendingOverlayReplacements.get(bucketKey);
    if (!pending) return;
    pendingOverlayReplacements.delete(bucketKey);
    let resweep = false;
    for (const { record, staged, revision, session } of pending.values()) {
        const closeKey = `${record.ownerKey}#${record.bucketKey}`;
        const current = session === buildingsSessionToken && buildingsGroup
            && overlayOwnersByKey.get(closeKey) === record
            && overtureScopeOwners.get(record.scope)?.has(record.ownerKey);
        if (!current) { disposeOverlayStagedRoot(staged); continue; }
        removeCloseFacadeDetail(closeKey);
        overlayOwnersByKey.delete(closeKey);
        for (const mesh of [...staged.children]) buildingsGroup.add(mesh);
        if (revision !== passageCutVolumesRevision) resweep = true;
    }
    if (resweep) {
        overlayRepaintedRevision = null;
        scheduleOverlayPassageRepaint();
    }
}

function clearOverlayPassageRepaint() {
    if (overlayRepaintScheduled) buildQueue.cancel(overlayRepaintScheduled.job);
    overlayRepaintScheduled = null;
    overlayRepaintedRevision = 0;
    overlayRepaintFailed = 0;
    for (const pending of pendingOverlayReplacements.values()) {
        for (const { staged } of pending.values()) disposeOverlayStagedRoot(staged);
    }
    pendingOverlayReplacements.clear();
    for (const warmup of overlayRepaintWarmups) warmup.dispose();
    overlayRepaintWarmups.clear();
}

function* repaintOverlayMeshForPassages(mesh, staged) {
    const info = mesh.userData.overlayRepaint;
    if (!info || !Array.isArray(info.segments) || info.segments.length === 0) return;
    const groups = new Map();
    const leases = [];
    let dropped = 0;
    try {
        for (const seg of info.segments) {
            const mask = seg.glassTower
                ? null
                : getFacadeOpeningMask(seg.surface, seg.floors, seg.bays, seg.coveredHeightM, seg.headM);
            if (!seg.glassTower && mask !== null && !mask.includes('1')) {
                dropped++;
                yield { phase: 'mask' };
                continue;
            }
            const mat = getFacadeOverlayMaterial(
                info.objectId, seg.floors, seg.bays, mask, seg.storefronts, seg.glassTower,
                info.facadeSource,
            );
            let group = groups.get(mat);
            if (!group) {
                group = []; groups.set(mat, group);
                leases.push(retainBuildingFacadeMaterial(mat, 'overlay-remask'));
            }
            group.push(seg);
            yield { phase: 'mask' };
        }
        const currentBase = passageBaseMaterialByMesh.get(mesh) || mesh.material;
        if (dropped === 0 && groups.size === 1 && groups.keys().next().value === currentBase) return;

        // Re-split this overlay's vertex data by the new material grouping.
        const position = mesh.geometry.getAttribute('position');
        const uvAttr = mesh.geometry.getAttribute('uv');
        for (const [material, segments] of groups) {
            const total = segments.reduce((sum, seg) => sum + seg.vertexCount, 0);
            const positions = new Float32Array(total * 3);
            const uvs = new Float32Array(total * 2);
            const remapped = [];
            let offset = 0;
            for (const seg of segments) {
                positions.set(
                    position.array.subarray(seg.vertexStart * 3, (seg.vertexStart + seg.vertexCount) * 3),
                    offset * 3,
                );
                uvs.set(
                    uvAttr.array.subarray(seg.vertexStart * 2, (seg.vertexStart + seg.vertexCount) * 2),
                    offset * 2,
                );
                remapped.push({ ...seg, vertexStart: offset });
                offset += seg.vertexCount;
                yield { phase: 'geometry' };
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geometry.computeVertexNormals();
            const replacement = new THREE.Mesh(geometry, material);
            replacement.name = 'BuildingFacadeOverlay';
            replacement.castShadow = false;
            replacement.receiveShadow = true;
            replacement.visible = mesh.visible;
            replacement.position.copy(mesh.position);
            replacement.quaternion.copy(mesh.quaternion);
            replacement.scale.copy(mesh.scale);
            replacement.renderOrder = mesh.renderOrder;
            replacement.userData = { ...mesh.userData };
            replacement.userData.objectId = info.objectId;
            replacement.userData.overlayRepaint = { ...info, segments: remapped };
            setPassageAwareMaterial(replacement, material);
            staged.add(replacement);
            yield { phase: 'geometry' };
        }
        return true; // an empty staged group deliberately removes a fully masked overlay
    } finally {
        for (const release of leases) release?.();
    }
}

// Paints transparent window/door + emissive canvases together so openings line
// up exactly. There is deliberately no plaster, cornice, or string-course
// paint here: procedural facade logic is an additive openings overlay and must
// never replace or otherwise alter the source building surface beneath it.
// Canvas Y grows downward and CanvasTexture keeps flipY=true, so the building
// base (V=0) maps to the bottom row.
export function paintFacade(
    variantIdx,
    floors,
    bays,
    openingMask = null,
    storefronts = true,
    glass = false,
    resolutionScale = 1,
    architectureId = architecturalLocationId(),
) {
    if (glass) return paintGlassFacade(variantIdx, floors, bays, storefronts, resolutionScale);
    const style = getFacadeWindowStyle(variantIdx, architectureId);
    const layout = getFacadeOpeningLayout(floors, bays);
    const bayPx = FACADE_PX_PER_BAY;
    const w = layout.widthPx;
    const h = layout.heightPx;
    const groundPx = layout.groundPx;
    const upperPx = layout.upperPx;
    const rand = createSeededRandom(((variantIdx + 1) * 2654435761) ^ (floors * 40503) ^ (bays * 2246822519));

    const outputW = Math.max(1, Math.round(w * Math.max(1, resolutionScale)));
    const outputH = Math.max(1, Math.round(h * Math.max(1, resolutionScale)));
    const dCanvas = document.createElement('canvas'); dCanvas.width = outputW; dCanvas.height = outputH;
    const eCanvas = document.createElement('canvas'); eCanvas.width = outputW; eCanvas.height = outputH;
    const d = dCanvas.getContext('2d', { willReadFrequently: true });
    const e = eCanvas.getContext('2d');
    d.scale(outputW / w, outputH / h);
    e.scale(outputW / w, outputH / h);

    d.clearRect(0, 0, w, h);
    e.fillStyle = '#000000'; e.fillRect(0, 0, w, h);

    // Real-world window size (px). Width is a fixed metric size, not a fraction
    // of the bay, so it stays realistic no matter how wide the bay is; the
    // style scales it within the envelope the fit mask already reserved.
    const winW = layout.winW;
    const winH = layout.winH;
    const drawWindow = (cx, bandTop, bandH, lit) => {
        const ww = winW * style.wScale;
        const wh = Math.min(winH * style.hScale, bandH * 0.82);
        const top = bandTop + (bandH - wh) / 2;   // centred in the storey band
        const left = cx - ww / 2;

        d.fillStyle = style.frame;
        d.fillRect(left - 2, top - 2, ww + 4, wh + 4);
        d.fillStyle = style.glass;
        d.fillRect(left, top, ww, wh);

        // Pane division — the strongest cue that two buildings are not the same.
        d.fillStyle = style.mullion || 'rgba(232,226,214,0.45)';
        if (style.panes === 'cross') {
            d.fillRect(cx - 1, top, 2, wh);
            d.fillRect(left, top + wh / 2 - 1, ww, 2);
        } else if (style.panes === 'french') {
            d.fillRect(cx - 1, top, 2, wh);
            d.fillRect(left, top + wh * 0.26 - 1, ww, 2);
        } else if (style.panes === 'triple') {
            d.fillRect(left + ww / 3 - 1, top, 2, wh);
            d.fillRect(left + (ww * 2) / 3 - 1, top, 2, wh);
        } else if (style.panes === 'vertical') {
            d.fillRect(cx - 1, top, 2, wh);
        }

        // Aluminium sliding shutters (new-build styles): a green louvred panel
        // drawn INSIDE the opening — over part of the glass ('slide') or all of
        // it ('closed') — so it stays within the envelope the opening mask
        // already reserved and can never overhang a roof edge. The lit emissive
        // rect below shrinks to the glass the shutter leaves uncovered.
        let glassLeft = left;
        let glassW = ww;
        if (style.shutter && style.shutterColor) {
            const coverW = style.shutter === 'closed'
                ? ww
                : ww * (0.35 + rand() * 0.25);
            const fromLeft = style.shutter === 'closed' || rand() < 0.5;
            const panelX = fromLeft ? left : left + ww - coverW;
            d.fillStyle = style.shutterColor;
            d.fillRect(panelX, top, coverW, wh);
            // Louvre slats: subtle darker horizontals with a light alu edge.
            d.fillStyle = 'rgba(0,0,0,0.18)';
            for (let ly = top + 2; ly < top + wh - 1; ly += 3) d.fillRect(panelX, ly, coverW, 1);
            d.fillStyle = 'rgba(255,255,255,0.28)';
            d.fillRect(fromLeft ? panelX + coverW - 1 : panelX, top, 1, wh);
            glassW = Math.max(0, ww - coverW);
            glassLeft = fromLeft ? left + coverW : left;
        }

        if (style.head === 'arch') {
            // Segmental arch turned in the frame colour over the opening.
            d.save();
            d.strokeStyle = style.frame;
            d.lineWidth = 3;
            d.beginPath();
            d.arc(cx, top + 1, ww / 2 + 1, Math.PI, 0);
            d.stroke();
            d.restore();
        } else if (style.head === 'cornice') {
            d.fillStyle = 'rgba(238,232,220,0.75)';
            d.fillRect(left - 4, top - 5, ww + 8, 3);
        }

        if (style.sill === 'stone') {
            d.fillStyle = 'rgba(206,198,182,0.85)';
            d.fillRect(left - 4, top + wh, ww + 8, 4);
            d.fillStyle = 'rgba(120,112,98,0.45)';
            d.fillRect(left - 4, top + wh + 4, ww + 8, 2);
        } else {
            d.fillStyle = 'rgba(120,112,98,0.5)';
            d.fillRect(left - 2, top + wh, ww + 4, 2);
        }

        if (lit && glassW > 1) { e.fillStyle = '#ffd9a0'; e.fillRect(glassLeft, top, glassW, wh); }
    };

    // Upper floors stacked above the ground band — one window centred per bay.
    let openingIndex = 0;
    for (let f = 1; f < floors; f++) {
        const bandBottom = h - groundPx - (f - 1) * upperPx;
        const bandTop = bandBottom - upperPx;
        for (let b = 0; b < bays; b++) {
            const fits = !openingMask || openingMask[openingIndex] !== '0';
            openingIndex++;
            if (fits) drawWindow(b * bayPx + bayPx / 2, bandTop, upperPx, rand() < 0.35);
        }
    }

    // Ground floor: on a street frontage, one glazed entrance with a stable random
    // mix of commercial fronts and ordinary windows in the remaining whole bays. On
    // a courtyard wall, plain windows only.
    {
        const bandTop = h - groundPx;
        const groundBayTypes = getGroundFloorBayTypes(variantIdx, bays, storefronts);
        const openTop = bandTop + groundPx * 0.15;
        const openH = groundPx * 0.72;
        const sillH = Math.max(2, Math.round(groundPx * 0.05));
        for (let b = 0; b < bays; b++) {
            const fits = !openingMask || openingMask[openingIndex] !== '0';
            openingIndex++;
            if (!fits) continue;
            const cx = b * bayPx + bayPx / 2;
            const bayType = groundBayTypes[b];
            if (bayType === 'entrance') {
                const dw = bayPx * 0.46, dh = groundPx * 0.82, dTop = bandTop + groundPx * 0.11;
                d.fillStyle = FACADE_ENTRANCE_FRAME;
                d.fillRect(cx - dw / 2 - 3, dTop - 3, dw + 6, dh + 6);
                paintShopGlass(d, cx - dw / 2, dTop, dw, dh);
                d.fillStyle = FACADE_ENTRANCE_FRAME;
                d.fillRect(cx - dw / 2 - 1, dTop + dh * 0.16, dw + 2, 2);
                d.fillStyle = 'rgba(40,40,44,0.7)'; d.fillRect(cx + dw * 0.26, dTop + dh * 0.42, 3, dh * 0.22);
                e.fillStyle = '#ffe6b0'; e.fillRect(cx - dw / 2, dTop, dw, dh);
                continue;
            }
            if (bayType === 'window') {
                drawWindow(cx, bandTop, groundPx, rand() < 0.35);
                continue;
            }
            const margin = bayPx * 0.14;
            const gx = b * bayPx + margin, gw = bayPx - margin * 2;
            d.fillStyle = style.frame; d.fillRect(gx - 3, openTop - 3, gw + 6, openH + 6);
            paintShopGlass(d, gx, openTop, gw, openH);
            d.fillStyle = style.mullion || 'rgba(232,226,214,0.55)'; d.fillRect(gx + gw / 2 - 1, openTop, 2, openH);  // centre mullion
            d.fillStyle = 'rgba(118,108,94,0.5)'; d.fillRect(gx - 3, openTop + openH * 0.16, gw + 6, 2);
            d.fillStyle = 'rgba(95,88,78,0.55)'; d.fillRect(gx - 3, openTop + openH, gw + 6, sillH);
            e.fillStyle = '#ffe6b0'; e.fillRect(gx, openTop, gw, openH);
        }
    }

    return { diffuse: dCanvas, emissive: eCanvas };
}

// A curtain wall, not punched windows: glass from spandrel to spandrel, an
// aluminium mullion grid on a metric module, and a glazed lobby at the street.
// Unlike the window overlay this covers the wall completely — that IS the
// building's skin — so its canvas is opaque throughout.
function paintGlassFacade(variantIdx, floors, bays, storefronts = true, resolutionScale = 1) {
    const style = FACADE_GLASS_STYLES[
        ((variantIdx % FACADE_GLASS_STYLES.length) + FACADE_GLASS_STYLES.length)
        % FACADE_GLASS_STYLES.length
    ];
    const totalM = facadeTotalM(floors);
    const bayPx = FACADE_PX_PER_BAY;
    const w = Math.max(1, bays * bayPx);
    const h = Math.max(1, Math.round(totalM * FACADE_PX_PER_M_V));
    const pxPerMV = h / totalM;
    const pxPerMU = bayPx / FACADE_BAY_M;
    const rand = createSeededRandom(((variantIdx + 1) * 40503) ^ (floors * 2654435761) ^ (bays * 2246822519));

    const outputW = Math.max(1, Math.round(w * Math.max(1, resolutionScale)));
    const outputH = Math.max(1, Math.round(h * Math.max(1, resolutionScale)));
    const dCanvas = document.createElement('canvas'); dCanvas.width = outputW; dCanvas.height = outputH;
    const eCanvas = document.createElement('canvas'); eCanvas.width = outputW; eCanvas.height = outputH;
    const d = dCanvas.getContext('2d', { willReadFrequently: true });
    const e = eCanvas.getContext('2d');
    d.scale(outputW / w, outputH / h);
    e.scale(outputW / w, outputH / h);
    e.fillStyle = '#000000'; e.fillRect(0, 0, w, h);

    // Glass, graded: it holds the sky at the top and the street at the bottom.
    const sky = d.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0.0, style.sky);
    sky.addColorStop(0.45, style.glass);
    sky.addColorStop(1.0, style.spandrel);
    d.fillStyle = sky;
    d.fillRect(0, 0, w, h);

    const lobbyPx = Math.round(Math.min(FACADE_GROUND_M, totalM * 0.25) * pxPerMV);
    const lobbyTop = h - lobbyPx;
    const shaftPx = lobbyTop;
    const floorPx = FACADE_GLASS_FLOOR_M * pxPerMV;
    const bandCount = Math.max(1, Math.round(shaftPx / floorPx));
    const bandPx = shaftPx / bandCount;
    const spandrelPx = Math.max(3, Math.round(FACADE_GLASS_SPANDREL_M * pxPerMV));

    // Floor spandrels + the transom that caps each glazed band.
    for (let band = 0; band < bandCount; band++) {
        const bandTop = band * bandPx;
        d.fillStyle = style.spandrel;
        d.fillRect(0, bandTop, w, spandrelPx);
        d.fillStyle = 'rgba(255,255,255,0.10)';
        d.fillRect(0, bandTop + spandrelPx, w, 1);
        d.fillStyle = 'rgba(0,0,0,0.18)';
        d.fillRect(0, bandTop - 1, w, 1);
        // Office lights: whole floors light up, not scattered flats.
        if (rand() < 0.45) {
            e.fillStyle = '#ffe3b4';
            e.fillRect(0, bandTop + spandrelPx, w, bandPx - spandrelPx);
        }
    }

    // Aluminium mullions on a fixed metric grid, straight through the spandrels.
    const mullionStep = FACADE_GLASS_MULLION_M * pxPerMU;
    const mullionW = Math.max(1, Math.round(0.09 * pxPerMU));
    d.fillStyle = style.mullion;
    for (let x = mullionStep / 2; x < w; x += mullionStep) {
        d.fillRect(Math.round(x - mullionW / 2), 0, mullionW, lobbyTop);
    }

    // Glazed lobby: taller bays, brighter glass, one entrance on a street front.
    d.fillStyle = style.spandrel;
    d.fillRect(0, lobbyTop - 2, w, 3);
    const lobbyGlassTop = lobbyTop + Math.round(lobbyPx * 0.08);
    const lobbyGlassH = Math.round(lobbyPx * 0.80);
    for (let bay = 0; bay < bays; bay++) {
        const gx = bay * bayPx + bayPx * 0.06;
        const gw = bayPx * 0.88;
        paintShopGlass(d, gx, lobbyGlassTop, gw, lobbyGlassH);
        e.fillStyle = '#ffe6b0';
        e.fillRect(gx, lobbyGlassTop, gw, lobbyGlassH);
    }
    d.fillStyle = style.mullion;
    for (let x = mullionStep / 2; x < w; x += mullionStep) {
        d.fillRect(Math.round(x - mullionW / 2), lobbyGlassTop, mullionW, lobbyGlassH);
    }
    if (storefronts && bays > 0) {
        const entranceBay = Math.floor(rand() * bays);
        const cx = entranceBay * bayPx + bayPx / 2;
        const dw = bayPx * 0.5;
        const dh = lobbyPx * 0.72;
        const dTop = h - dh;
        d.fillStyle = FACADE_ENTRANCE_FRAME;
        d.fillRect(cx - dw / 2 - 3, dTop - 3, dw + 6, dh + 3);
        paintShopGlass(d, cx - dw / 2, dTop, dw, dh);
        d.fillStyle = FACADE_ENTRANCE_FRAME;
        d.fillRect(cx - 1, dTop, 2, dh);
        e.fillStyle = '#fff0cf';
        e.fillRect(cx - dw / 2, dTop, dw, dh);
    }
    // The sill line where the skin meets the pavement.
    d.fillStyle = 'rgba(30,34,38,0.85)';
    d.fillRect(0, h - Math.max(2, Math.round(0.25 * pxPerMV)), w, Math.max(2, Math.round(0.25 * pxPerMV)));

    return { diffuse: dCanvas, emissive: eCanvas };
}

function makeFacadeTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    // The geometry maps each wall face's UV to 0..1 in BOTH axes (whole bays
    // across, ground→cornice up), so the texture spans the face exactly once —
    // no horizontal tiling-stretch, no vertical cut. Clamp both axes.
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    registerShared(t);
    return t;
}

// One texture per (variant, floors, bays, fit mask, ground-floor treatment): the bay
// count comes from the wall's true width, the mask is shared whenever silhouettes
// match, and street frontages and courtyard walls never share a ground floor.
function facadeTextureKey(variantIdx, floors, bays, openingMask, storefronts, glass, architectureId = architecturalLocationId()) {
    return architectureId + '_' + variantIdx + '_' + floors + '_' + bays
        + '_' + (openingMask || 'all') +
        (storefronts ? '_shops' : '_plain') + (glass ? '_glass' : '');
}

function getFacadeTexture(variantIdx, floors, bays, openingMask = null, storefronts = true, glass = false, architectureId = architecturalLocationId()) {
    const key = facadeTextureKey(variantIdx, floors, bays, openingMask, storefronts, glass, architectureId);
    if (_facadeTextures.has(key)) return _facadeTextures.get(key);
    const { diffuse, emissive } = paintFacade(variantIdx, floors, bays, openingMask, storefronts, glass, 1, architectureId);
    _facadeTextures.set(key, makeFacadeTexture(diffuse));
    _facadeEmissiveTextures.set(key, makeFacadeTexture(emissive));
    return _facadeTextures.get(key);
}

function getFacadeEmissiveTexture(variantIdx, floors, bays, openingMask = null, storefronts = true, glass = false, architectureId = architecturalLocationId()) {
    const key = facadeTextureKey(variantIdx, floors, bays, openingMask, storefronts, glass, architectureId);
    if (!_facadeEmissiveTextures.has(key)) {
        getFacadeTexture(variantIdx, floors, bays, openingMask, storefronts, glass, architectureId);
    }
    return _facadeEmissiveTextures.get(key);
}

// ─── Night-window glow ─────────────────────────────────────────────────────
// At night every wall gets a small warm emissive contribution so the city
// reads as "lit from inside" rather than going to a flat dim ambient. Roofs
// are left dark — interior light doesn't escape the roof. With the facade
// emissive map (FACADE_WINDOWS) the warm glow is masked to window rects so
// individual windows light up; otherwise it's a single uniform wall glow.

const NIGHT_EMISSIVE_HEX = 0xffd9a0;
// Lit windows are lamps behind glass, brighter and warmer than the old
// whole-wall wash, and applied through a mask so the wall between stays dark.
const NIGHT_WINDOW_EMISSIVE_HEX = 0xffcf8c;
const NIGHT_WINDOW_EMISSIVE_INTENSITY = 1.15;
// One scatter for the whole city: the mask tiles, so a per-building seed would
// only show up as a seam between two walls of the same building.
const WALL_WINDOW_SEED = 12;
// Paired with the stronger directional moonlight in sky.js: enough warm
// window glow to read at night without flattening every facade into beige.
const NIGHT_EMISSIVE_INTENSITY = 0.26;
// Compensates the emissive tint's average luminance (walls ≈ 0.78) so the
// overall night brightness matches the old flat-glow look.
const NIGHT_EMISSIVE_TINT_COMP = 1.28;
let isNightMode = false;
// Material.clone() JSON-clones userData. A Texture stored there becomes a
// texture-shaped plain object, which later crashes WebGLMaterials while reading
// its matrix. Keep live GPU resources outside serialised material metadata.
const windowEmissiveMapByMaterial = new WeakMap();

function applyNightModeToMaterial(mat, isWall) {
    if (!isWall) return;          // roofs don't glow
    if (isNightMode) {
        // A material that came with its own window mask lights ITS WINDOWS, not
        // its whole surface. Substituting the diffuse map here — which is what
        // this used to do — turned every painted facade and every plain wall
        // into one uniformly glowing slab after dark, which is why a night city
        // read as an overcast afternoon. The lamp colour is the lamp's, not the
        // plaster's, so it is not multiplied by mat.color.
        const windowMask = windowEmissiveMapByMaterial.get(mat) || null;
        if (windowMask) {
            mat.emissive.setHex(NIGHT_WINDOW_EMISSIVE_HEX);
            if (mat.emissiveMap !== windowMask) {
                mat.emissiveMap = windowMask;
                mat.needsUpdate = true;
            }
            mat.emissiveIntensity = NIGHT_WINDOW_EMISSIVE_INTENSITY;
        } else {
            // No mask (a massing block, a stated landmark colour): keep the old
            // whole-surface glow so it still reads against the sky.
            mat.emissive.setHex(NIGHT_EMISSIVE_HEX);
            if (mat.color) mat.emissive.multiply(mat.color);
            if (mat.emissiveMap !== (mat.map || null)) {
                mat.emissiveMap = mat.map || null;
                mat.needsUpdate = true;
            }
            mat.emissiveIntensity = NIGHT_EMISSIVE_INTENSITY * NIGHT_EMISSIVE_TINT_COMP;
        }
    } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        if (mat.emissiveMap) {
            mat.emissiveMap = null;
            mat.needsUpdate = true;
        }
    }
}

// Exposed for the bullet system: ray-tests against every building mesh
// in the current tile cache. Holes are stamped as children of the
// hit mesh and so evict automatically with their tile.
export function getBuildingsGroup() {
    return buildingsGroup;
}

// Moving pedestrians query the already-streamed detailed building cache, so
// they can enter real street-facing doors without owning another tile source.
export function getBuildingEntrancesNear(localX, localZ, radiusM = 60) {
    const radius = Math.max(0, Number(radiusM) || 0);
    const radiusSq = radius * radius;
    const entrances = [];
    for (const entrance of buildingEntranceIndex.candidatesInBox(
        localX - radius,
        localZ - radius,
        localX + radius,
        localZ + radius,
    )) {
        const dx = entrance.x - localX;
        const dz = entrance.z - localZ;
        if (dx * dx + dz * dz <= radiusSq) entrances.push(entrance);
    }
    return entrances;
}

// Pedestrian routing uses the footprint belonging to the same GDI survey as
// the rendered mesh. This avoids crossing a cadastral outline that may not
// describe the building the player actually sees.
export function getBuildingFootprintsNear(localX, localZ, radiusM = 60) {
    const footprints = [];
    const radius = Math.max(0, Number(radiusM) || 0);
    const radiusSq = radius * radius;
    const appendNearby = (footprint) => {
        const dx = localX < footprint.minX ? footprint.minX - localX
            : localX > footprint.maxX ? localX - footprint.maxX
            : 0;
        const dz = localZ < footprint.minZ ? footprint.minZ - localZ
            : localZ > footprint.maxZ ? localZ - footprint.maxZ
            : 0;
        if (dx * dx + dz * dz <= radiusSq) footprints.push(footprint);
    };
    // Detailed segments stop crossings of the exact walls on screen. Keep the
    // closed LOD1 outline too when its bounds match the rendered mesh: it fills
    // any gaps left by warped or sloped ground-wall faces. Reject mismatched
    // source outliers rather than turning a malformed giant polygon solid.
    for (const footprint of buildingFootprintIndex.candidatesInBox(
        localX - radius,
        localZ - radius,
        localX + radius,
        localZ + radius,
    )) appendNearby(footprint);
    for (const footprint of authoritativeBuildingFootprintIndex.candidatesInBox(
        localX - radius,
        localZ - radius,
        localX + radius,
        localZ + radius,
    )) {
        const objectId = footprint.objectId;
        const detailed = buildingFootprints.get(objectId);
        if (!detailed || footprintMatchesRenderedBounds(detailed, footprint)) appendNearby(footprint);
    }
    return footprints;
}

function localizeFootprintGeometry(objectId, geometry, tileKey, aLat, aLon) {
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const segments = foundationSegmentsFromFootprint(geometry, (lon, lat) => ({
        x: (lon - aLon) * scaleLon,
        z: -(lat - aLat) * scaleLat,
    }));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const segment of segments) {
        minX = Math.min(minX, segment.ax, segment.bx);
        maxX = Math.max(maxX, segment.ax, segment.bx);
        minZ = Math.min(minZ, segment.az, segment.bz);
        maxZ = Math.max(maxZ, segment.az, segment.bz);
    }
    if (segments.length < 3) return null;
    return { objectId, tileKey, source: 'gdi-footprint', closed: true, minX, maxX, minZ, maxZ, segments };
}

// The far-building stream already carries gdi_building_3d.footprint_geom: the
// cleaned 2D outline belonging to the exact rendered mesh object_id. It is the
// authoritative pedestrian obstacle for far LOD1 prisms. A loaded detailed
// mesh still takes priority because its ground walls are the visible boundary.
export function registerAuthoritativeBuildingFootprints(features, tileKey, aLat, aLon) {
    let tileIds = authoritativeFootprintTiles.get(tileKey);
    if (!tileIds) {
        tileIds = new Set();
        authoritativeFootprintTiles.set(tileKey, tileIds);
    }
    for (const feature of features || []) {
        const objectId = feature && feature.properties && feature.properties.object_id;
        if (objectId == null) continue;
        const footprint = localizeFootprintGeometry(objectId, feature.geometry, tileKey, aLat, aLon);
        if (!footprint) continue;
        // The render payload knows the prism's ground and height, so its
        // walls end at the roof line for the walker instead of standing an
        // assumed 24 m tall wherever the walker happens to be. Without a
        // terrain reference the world is flat and every base is 0.
        const properties = feature.properties;
        const groundZ = Number(properties.ground_z_m);
        const heightM = [properties.height, properties.ridge_height_m, properties.eave_height_m]
            .map(Number)
            .find(value => Number.isFinite(value) && value > 0) ?? null;
        const baseY = !terrainReference
            ? 0
            : Number.isFinite(groundZ) ? terrainReference.absoluteToSceneY(groundZ) : null;
        footprint.baseY = Number.isFinite(baseY) ? baseY : null;
        footprint.heightM = heightM;
        footprint.topY = Number.isFinite(baseY) && heightM !== null ? baseY + heightM : null;
        const existing = authoritativeBuildingFootprints.get(objectId);
        footprint.tileKeys = existing && existing.tileKeys ? existing.tileKeys : new Set();
        footprint.tileKeys.add(tileKey);
        authoritativeBuildingFootprints.set(objectId, footprint);
        authoritativeBuildingFootprintIndex.set(objectId, footprint);
        tileIds.add(objectId);
    }
}

export function unregisterAuthoritativeBuildingFootprints(tileKey) {
    const tileIds = authoritativeFootprintTiles.get(tileKey);
    if (!tileIds) return;
    for (const objectId of tileIds) {
        const footprint = authoritativeBuildingFootprints.get(objectId);
        if (!footprint || !footprint.tileKeys) continue;
        footprint.tileKeys.delete(tileKey);
        if (footprint.tileKeys.size === 0) {
            authoritativeBuildingFootprints.delete(objectId);
            authoritativeBuildingFootprintIndex.delete(objectId);
        }
    }
    authoritativeFootprintTiles.delete(tileKey);
}

export function clearAuthoritativeBuildingFootprints() {
    authoritativeBuildingFootprints = new Map();
    authoritativeFootprintTiles = new Map();
    authoritativeBuildingFootprintIndex.clear();
}

// Called by scene/sky.js when the sim hour crosses dawn / dusk. Updates the
// emissive on every cached wall material in one pass.
export function setBuildingNightMode(night) {
    if (night === isNightMode) return;
    isNightMode = night;
    for (const k of Object.keys(buildingMaterials)) {
        // Roof keys all start with '_roof'; everything else is a wall.
        applyNightModeToMaterial(buildingMaterials[k], !k.startsWith('_roof'));
    }
    for (const entry of closeFacadeMaterialCache.values()) {
        applyNightModeToMaterial(entry.material, true);
    }
    for (const material of facadeAtlasMaterials) {
        applyNightModeToMaterial(material, true);
    }
    if (buildingMaterial) applyNightModeToMaterial(buildingMaterial, true);
    // Meshes that STATED an emissive light up from their own stated colour, not
    // the procedural warm tint above: the source already decided what colour
    // this building glows. Interned by (kind, optics), so a whole city of
    // landmarks is a handful of uniform writes — no recompile, since
    // emissiveIntensity is a uniform and not part of the shader program.
    for (const family of statedMaterialFamilies.values()) {
        if (!family.lightsUp) continue;
        family.material.emissiveIntensity = statedNightIntensity(family.kind, isNightMode);
    }
    // Runs last: it copies emissive state from each base onto its passage
    // variant, so both loops above must have settled first.
    syncPassageVariantNightState();
}

// Returns three uncorrelated [0,1) values from a bucket index — used as
// independent jitter coords for h/s/l so colour shifts don't move in lockstep.
function bucketTriplet(bucket) {
    return [
        bucket / JITTER_BUCKETS,
        ((bucket * 7) % JITTER_BUCKETS) / JITTER_BUCKETS,
        ((bucket * 13) % JITTER_BUCKETS) / JITTER_BUCKETS,
    ];
}

function* buildJitteredMaterialCooperative(baseHex, bucket, range) {
    const baseHSL = new THREE.Color(baseHex).getHSL({});
    const [t1, t2, t3] = bucketTriplet(bucket);
    const h = (baseHSL.h + (t1 - 0.5) * range.h + 1) % 1;
    const s = Math.max(0, Math.min(1, baseHSL.s + (t2 - 0.5) * range.s));
    const l = Math.max(0, Math.min(MAX_WALL_LIGHTNESS, baseHSL.l + (t3 - 0.5) * range.l));
    const color = new THREE.Color().setHSL(h, s, l);
    // Pick one of the texture variants by bucket — building gets a
    // consistent surface character (smooth plaster / coarse stucco /
    // shuttered concrete / aggregate speckle / vertical cladding).
    const variantIdx = bucket % TEXTURE_VARIANTS;
    // Roughness = variant baseline ± small jitter from a 4th uncorrelated
    // bucket coord, so two buildings sharing a variant still differ.
    const tRough = ((bucket * 19) % JITTER_BUCKETS) / JITTER_BUCKETS;
    const roughness = VARIANT_ROUGHNESS[variantIdx] + (tRough - 0.5) * 0.10;
    const normalScale = VARIANT_NORMAL_SCALE[variantIdx];
    const map = yield* getWallTextureVariantCooperative(variantIdx);
    const emissiveMap = getWallEmissiveTexture();
    yield { phase: 'wall-emissive-texture' };
    const normalMap = yield* getWallNormalVariantCooperative(variantIdx);
    const mat = new THREE.MeshStandardMaterial({
        color,
        map,
        emissiveMap,
        normalMap,
        normalScale: new THREE.Vector2(normalScale, normalScale),
        roughness,
        envMapIntensity: WALL_ENV_MAP_INTENSITY,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
    });
    windowEmissiveMapByMaterial.set(mat, emissiveMap);
    registerShared(mat);
    applyNightModeToMaterial(mat, /* isWall */ true);
    return mat;
}

function buildJitteredMaterial(baseHex, bucket, range) {
    return drainBuildingIterator(buildJitteredMaterialCooperative(baseHex, bucket, range));
}

// Jittered survey-mesh wall material → the family it can merge into.
//
// A wall's 64 jitter buckets differ in COLOUR (free to move into a vertex
// attribute) but also pick one of TEXTURE_VARIANTS maps/normal maps, which
// cannot be. So there is one family per texture variant: 64 materials collapse
// to 4, and 4 is the floor until the wall textures are atlased.
//
// What this deliberately drops is the per-bucket roughness wobble (variant
// baseline ±0.05): a family takes the roughness of whichever member built it.
// Two buildings sharing a variant still differ by colour, which is the jitter
// that reads at street distance.
const wallColorFamilyByMaterial = new Map();   // material → { familyKey, color: [r,g,b] }

function registerWallColorFamily(material, bucket) {
    if (!material || wallColorFamilyByMaterial.has(material)) return;
    wallColorFamilyByMaterial.set(material, {
        familyKey: `gdiWallFamily_${bucket % TEXTURE_VARIANTS}`,
        color: material.color.toArray(),
    });
}

function* getBuildingMaterialCooperative(useClass, objectId) {
    // Both colour overrides live at the top of the GENERATOR, not in the getBuildingMaterial
    // wrapper below it. The streaming path builds the city by driving this iterator directly
    // (see the materialIterator call in the tile loop), so anything added only to the wrapper
    // would pass a unit test and never colour a single building on screen.
    //
    // Neither block yields — they return a finished material — so they are safe here.

    // A landmark whose real colour everyone knows overrides the use_class palette. Checked
    // before the palette (and before the per-object hue jitter) so the cathedral is the
    // cathedral's colour and not a random bucket of "sakralna" grey.
    const ov = massingOverrideFor(objectId);
    if (ov && ov.color) {
        const key = 'override_' + ov.color + '_' + (ov.roughness ?? 'd');
        if (!buildingMaterials[key]) {
            const mat = new THREE.MeshStandardMaterial({
                color: new THREE.Color(ov.color),
                roughness: ov.roughness ?? 0.9,
                envMapIntensity: 0.3,
                side: THREE.DoubleSide,
            });
            registerShared(mat);
            applyNightModeToMaterial(mat, true);
            buildingMaterials[key] = mat;
        }
        return buildingMaterials[key];
    }
    // A colour MEASURED off this building's own Street View photograph beats a colour
    // inferred from what the building is used for. Deliberately NOT jittered afterwards:
    // the hue jitter exists to break up a categorical palette, and applying it here would
    // scatter a measurement on purpose.
    const measured = facadeColorFor(objectId);
    if (measured) {
        const key = 'measured_' + measured;
        if (!buildingMaterials[key]) {
            const mat = new THREE.MeshStandardMaterial({
                color: new THREE.Color(measured),
                roughness: 0.92,
                envMapIntensity: 0.3,
                side: THREE.DoubleSide,
            });
            registerShared(mat);
            applyNightModeToMaterial(mat, true);
            buildingMaterials[key] = mat;
        }
        return buildingMaterials[key];
    }

    const typeColor = BUILDING_USE_COLORS[useClass];
    const baseHex = typeColor != null ? typeColor : NULL_BASE_HEX;
    const range = typeColor != null ? RANGE_TYPED : RANGE_NULL;

    // Without an objectId we can't jitter — return the unjittered cached
    // base material so the rendering remains deterministic at least per type.
    if (objectId == null) {
        if (typeColor == null) return buildingMaterial;
        const fallbackKey = 'base_' + useClass;
        if (!buildingMaterials[fallbackKey]) {
            const ns0 = VARIANT_NORMAL_SCALE[0];
            const map = yield* getWallTextureVariantCooperative(0);
            const emissiveMap = getWallEmissiveTexture();
            yield { phase: 'wall-emissive-texture' };
            const normalMap = yield* getWallNormalVariantCooperative(0);
            const mat = new THREE.MeshStandardMaterial({
                color: typeColor,
                map,   // smooth plaster default
                emissiveMap,
                normalMap,
                normalScale: new THREE.Vector2(ns0, ns0),
                envMapIntensity: WALL_ENV_MAP_INTENSITY,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
            });
            registerShared(mat);
            applyNightModeToMaterial(mat, /* isWall */ true);
            buildingMaterials[fallbackKey] = mat;
        }
        return buildingMaterials[fallbackKey];
    }

    const bucket = hashObjectId(objectId) % JITTER_BUCKETS;
    // Cache key includes the use so a jittered housing bucket-7 and a jittered
    // 'NULL' bucket-7 don't collide.
    const cacheKey = (typeColor != null ? useClass : 'NULL') + '_' + bucket;
    if (!buildingMaterials[cacheKey]) {
        buildingMaterials[cacheKey] = yield* buildJitteredMaterialCooperative(
            baseHex,
            bucket,
            range,
        );
        // Record which colour FAMILY this jittered wall belongs to, so the
        // aggregate batcher can collapse it. Recorded here rather than derived
        // from the cache key later: this key is `<useClass>_<bucket>`, and use
        // classes are free text, so a key-shape regex would also match things
        // like `measured_123456` and hand a wall the wrong family. The identity
        // is known exactly at the point of creation, so it is stated there.
        registerWallColorFamily(buildingMaterials[cacheKey], bucket);
    }
    return buildingMaterials[cacheKey];
}

function getBuildingMaterial(useClass, objectId) {
    return drainBuildingIterator(getBuildingMaterialCooperative(useClass, objectId));
}

function getLowRiseFacadeMaterial(objectId, floors) {
    // A low proposal building is new construction, not weathered old-town
    // limestone — it keeps the new-build wall it already has.
    if (isProposalBuildingObjectId(objectId)) return null;
    const style = getLowRiseFacadeStyle(architecturalLocationId(), floors);
    if (!style) return null;
    const hash = objectId == null ? 0 : hashObjectId(objectId);
    const variant = hash % style.variants;
    const cacheKey = `_wall_${style.key}_${variant}`;
    if (!buildingMaterials[cacheKey]) {
        const surface = getDalmatianStoneSurface(style, variant);
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            map: surface.map,
            bumpMap: surface.bumpMap,
            bumpScale: style.bumpScale,
            roughness: style.roughness,
            envMapIntensity: WALL_ENV_MAP_INTENSITY * 0.72,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 0,
            polygonOffsetUnits: 0,
        });
        material.name = style.key;
        registerShared(material);
        applyNightModeToMaterial(material, true);
        buildingMaterials[cacheKey] = material;
    }
    return buildingMaterials[cacheKey];
}

function getFacadeStyleIndex(objectId, glass = false) {
    const bucket = objectId == null ? 0 : hashObjectId(objectId) % JITTER_BUCKETS;
    // Proposal buildings are new construction and take the new-build window
    // set (curtain-wall towers keep the shared glass styles — already modern).
    if (!glass && isProposalBuildingObjectId(objectId)) {
        return NEW_BUILD_WINDOW_STYLE_BASE
            + bucket % newBuildWindowStyles(architecturalLocationId()).length;
    }
    // The window look is its own draw from the building's hash, so it does not
    // move in lockstep with the plaster texture variant (which only has four).
    return glass
        ? bucket % FACADE_GLASS_STYLES.length
        : (bucket + Math.floor(bucket / FACADE_WINDOW_STYLES.length)) % FACADE_WINDOW_STYLES.length;
}

function facadeOverlayDescriptor(objectId, floors, bays, openingMask = null, storefronts = true, glass = false, source = null) {
    const styleIdx = source?.styleIdx ?? getFacadeStyleIndex(objectId, glass);
    const architectureId = source?.architectureId ?? architecturalLocationId();
    // Keyed by the STYLE, not by the building's jitter bucket.
    //
    // Every field of this material comes from styleIdx (plus the geometry
    // arguments) — getFacadeTexture caches on exactly the same set. The key
    // used the 64-value bucket instead, and styleIdx is a many-to-one function
    // of it: 64 buckets over 6 window styles (3 glass ones), so up to 10.7x
    // (21x for glass) PIXEL-IDENTICAL materials were being created for one
    // combination. They share the cached texture, so the cost was not memory —
    // it was draw calls, because two materials can never share one.
    const key = `_facadeOverlay_s${styleIdx}_${architectureId}_${floors}f_${bays}b_${openingMask || 'all'}`
        + (storefronts ? '_shops' : '_plain') + (glass ? '_glass' : '');
    return { key, objectId, styleIdx, architectureId, floors, bays, openingMask, storefronts, glass };
}

function getFacadeOverlayMaterial(objectId, floors, bays, openingMask = null, storefronts = true, glass = false, source = null) {
    // Keep the _facadeOverlay_ identity shared with the pixel-free atlas lookup.
    const { key: cacheKey, styleIdx, architectureId } = facadeOverlayDescriptor(
        objectId, floors, bays, openingMask, storefronts, glass, source,
    );
    return facadeResources.getOrCreate(cacheKey, () => {
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            map: getFacadeTexture(styleIdx, floors, bays, openingMask, storefronts, glass, architectureId),
            emissiveMap: getFacadeEmissiveTexture(styleIdx, floors, bays, openingMask, storefronts, glass, architectureId),
            // A curtain wall is the building's skin: it covers the wall, so it
            // gets glass optics (sky reflection) instead of plaster roughness.
            // The window overlay stays matte and punched through to the plaster.
            roughness: glass ? 0.14 : 0.78,
            metalness: glass ? 0.35 : 0,
            envMapIntensity: glass ? WALL_ENV_MAP_INTENSITY * 2.4 : WALL_ENV_MAP_INTENSITY,
            side: THREE.DoubleSide,
            // The window canvas is transparent everywhere except openings. Alpha
            // testing avoids transparent-surface sorting and ensures the overlay
            // cannot hide even one pixel of the base building mesh. The curtain
            // wall canvas is opaque throughout and needs no test.
            ...(glass ? {} : { alphaTest: 0.04 }),
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        // Atlas slots belong to immutable pixels, not this evictable texture
        // instance. Recreating a source must reuse an already painted slot.
        mat.userData.facadeSourceKey = cacheKey;
        if (mat.emissiveMap) windowEmissiveMapByMaterial.set(mat, mat.emissiveMap);
        registerShared(mat);
        applyNightModeToMaterial(mat, /* isWall */ true);
        buildingMaterials[cacheKey] = mat;
        const textureKey = facadeTextureKey(styleIdx, floors, bays, openingMask, storefronts, glass, architectureId);
        const textures = [mat.map, windowEmissiveMapByMaterial.get(mat)];
        const cpuBytes = textures.reduce((sum, texture) => sum + texture.image.width * texture.image.height * 4, 0);
        return {
            value: mat, cpuBytes, gpuBytes: Math.ceil(cpuBytes * 4 / 3),
            dispose() {
                disposePassageMaterialVariant(mat);
                windowEmissiveMapByMaterial.delete(mat);
                unregisterShared(mat);
                mat.dispose();
                mat.map = null;
                mat.emissiveMap = null;
                delete buildingMaterials[cacheKey];
                _facadeTextures.delete(textureKey);
                _facadeEmissiveTextures.delete(textureKey);
                for (const texture of textures) {
                    unregisterShared(texture);
                    texture.dispose();
                    texture.image.width = 0;
                    texture.image.height = 0;
                    texture.image = null;
                }
            },
        };
    });
}

// ─── Flat roofs ────────────────────────────────────────────────────────────
// Nobody tiles a flat roof. It is a bitumen or PVC membrane, sometimes under
// gravel ballast — weathered dark grey, never clay. A roof triangle within ~10°
// of level takes this instead of shingles, so an extruded LOD1 block, a mansard
// top and a flat annex all read correctly, while a shallow tiled pitch (15°+)
// still gets its tiles.
const FLAT_ROOF_MAX_TILT = 0.985;      // |n·up| above this is a flat roof
const FLAT_ROOF_PALETTE = [0x3d4145, 0x45484b, 0x35383a, 0x4b4e50];
const FLAT_ROOF_JITTER = { h: 0.006, s: 0.03, l: 0.05 };
const FLAT_ROOF_ROUGHNESS = 0.95;
const FLAT_ROOF_TEX_CELL_M = 2.4;
let _flatRoofTexture = null;

function isFlatRoofNormal(ny, length) {
    return length > 1e-6 && Math.abs(ny) / length > FLAT_ROOF_MAX_TILT;
}

function getFlatRoofTexture() {
    if (_flatRoofTexture) return _flatRoofTexture;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#8f9296';
    ctx.fillRect(0, 0, size, size);
    // Weathering: ponding stains and patched-up repairs, in grey only.
    const rand = createSeededRandom(0x9e3779b9);
    for (let i = 0; i < 26; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const r = 6 + rand() * 22;
        ctx.fillStyle = `rgba(${rand() < 0.5 ? '120,124,128' : '150,153,157'},${0.10 + rand() * 0.16})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.5 + rand() * 0.7), rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
    }
    // Welded membrane seams: the rolls run in one direction, ~1 m apart.
    const seamStep = size / (FLAT_ROOF_TEX_CELL_M / 1.05);
    for (let y = seamStep * 0.5; y < size; y += seamStep) {
        ctx.fillStyle = 'rgba(88,92,96,0.55)';
        ctx.fillRect(0, Math.round(y), size, 2);
        ctx.fillStyle = 'rgba(176,180,184,0.20)';
        ctx.fillRect(0, Math.round(y) + 2, size, 1);
    }
    applyPixelNoise(ctx, size, 14);
    _flatRoofTexture = makeRepeatingTexture(canvas, 1 / FLAT_ROOF_TEX_CELL_M, 1 / FLAT_ROOF_TEX_CELL_M);
    return _flatRoofTexture;
}

function getFlatRoofMaterial(objectId) {
    const hash = objectId == null ? 0 : hashObjectId(objectId);
    const paletteIndex = hash % FLAT_ROOF_PALETTE.length;
    const bucket = (hash >>> 4) % JITTER_BUCKETS;
    const cacheKey = '_roofFlat_' + paletteIndex + '_' + bucket;
    if (!buildingMaterials[cacheKey]) {
        const baseHSL = new THREE.Color(FLAT_ROOF_PALETTE[paletteIndex]).getHSL({});
        const [t1, t2, t3] = bucketTriplet(bucket);
        const h = (baseHSL.h + (t1 - 0.5) * FLAT_ROOF_JITTER.h + 1) % 1;
        const s = Math.max(0, Math.min(0.10, baseHSL.s + (t2 - 0.5) * FLAT_ROOF_JITTER.s));
        const l = Math.max(0.14, Math.min(0.34, baseHSL.l + (t3 - 0.5) * FLAT_ROOF_JITTER.l));
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(h, s, l),
            map: getFlatRoofTexture(),
            side: THREE.DoubleSide,
            roughness: FLAT_ROOF_ROUGHNESS,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, /* isWall */ false);
        buildingMaterials[cacheKey] = mat;
    }
    return buildingMaterials[cacheKey];
}

function getRoofMaterial(objectId) {
    const style = activePitchedRoofStyle();
    const palette = style.palette;
    const jitter = style.jitter;
    const cachePrefix = `_roof_${style.key}`;
    if (objectId == null) {
        const defaultKey = cachePrefix + '_default';
        if (!buildingMaterials[defaultKey]) {
            const mat = new THREE.MeshStandardMaterial({
                color: palette[0],
                map: getPitchedRoofTexture(style),
                normalMap: getPitchedRoofNormalTexture(style),
                normalScale: new THREE.Vector2(style.normalScale, style.normalScale),
                side: THREE.DoubleSide,
                roughness: style.roughness,
            });
            registerShared(mat);
            applyNightModeToMaterial(mat, /* isWall */ false);
            buildingMaterials[defaultKey] = mat;
        }
        return buildingMaterials[defaultKey];
    }
    const hash = hashObjectId(objectId);
    const paletteIndex = hash % palette.length;
    // Use higher hash bits for the bucket so palette and jitter are uncorrelated.
    const bucket = (hash >>> 4) % JITTER_BUCKETS;
    const cacheKey = cachePrefix + '_' + paletteIndex + '_' + bucket;
    if (!buildingMaterials[cacheKey]) {
        const baseHex = palette[paletteIndex];
        const baseHSL = new THREE.Color(baseHex).getHSL({});
        const [t1, t2, t3] = bucketTriplet(bucket);
        const h = (baseHSL.h + (t1 - 0.5) * jitter.h + 1) % 1;
        const s = Math.max(0, Math.min(1, baseHSL.s + (t2 - 0.5) * jitter.s));
        const l = Math.max(0, Math.min(1, baseHSL.l + (t3 - 0.5) * jitter.l));
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(h, s, l),
            map: getPitchedRoofTexture(style),
            normalMap: getPitchedRoofNormalTexture(style),
            normalScale: new THREE.Vector2(style.normalScale, style.normalScale),
            side: THREE.DoubleSide,
            roughness: style.roughness,
        });
        registerShared(mat);
        applyNightModeToMaterial(mat, /* isWall */ false);
        buildingMaterials[cacheKey] = mat;
    }
    return buildingMaterials[cacheKey];
}

function recordTileBuilding(tileKey, objectId) {
    if (tileKey == null || objectId == null) return;
    let set = tileBuildings.get(tileKey);
    if (!set) { set = new Set(); tileBuildings.set(tileKey, set); }
    set.add(objectId);
    // Construction is not publication. The far LOD stays visible until the
    // complete tile generation (including regional aggregate upload) commits.
}

function registerBuildingEntrance(objectId, entrance, tileKey) {
    if (objectId == null || !entrance) return;
    const registered = {
        objectId,
        tileKey,
        x: entrance.x,
        y: Number.isFinite(entrance.y) ? entrance.y : 0,
        z: entrance.z,
        wallX: Number.isFinite(entrance.wallX) ? entrance.wallX : entrance.x,
        wallZ: Number.isFinite(entrance.wallZ) ? entrance.wallZ : entrance.z,
        normalX: Number.isFinite(entrance.normalX) ? entrance.normalX : 0,
        normalZ: Number.isFinite(entrance.normalZ) ? entrance.normalZ : 1,
        doorWidthM: Number.isFinite(entrance.doorWidthM) ? entrance.doorWidthM : 1.25,
        doorHeightM: Number.isFinite(entrance.doorHeightM) ? entrance.doorHeightM : 2.6,
    };
    buildingEntrances.set(objectId, registered);
    buildingEntranceIndex.set(objectId, registered);
}

function registerBuildingFootprint(
    objectId,
    faces,
    center,
    tileKey,
    renderedBounds = null,
    baseY = null,
    topY = null,
) {
    if (objectId == null || !center || !Array.isArray(faces)) return;
    const segments = foundationSegmentsFromWallFaces(faces, center);
    if (segments.length < 3) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const segment of segments) {
        minX = Math.min(minX, segment.ax, segment.bx);
        maxX = Math.max(maxX, segment.ax, segment.bx);
        minZ = Math.min(minZ, segment.az, segment.bz);
        maxZ = Math.max(maxZ, segment.az, segment.bz);
    }
    const footprint = {
        objectId,
        tileKey,
        source: 'mesh-walls',
        closed: false,
        renderedBounds,
        minX,
        maxX,
        minZ,
        maxZ,
        segments,
        baseY: Number.isFinite(baseY) ? baseY : null,
        // Scene Y of the cornice: a jetpack walker above it is over the
        // block, not against its facade.
        topY: Number.isFinite(topY) ? topY : null,
    };
    buildingFootprints.set(objectId, footprint);
    buildingFootprintIndex.set(objectId, footprint);
}

function createBuildingBuildContextTemplate(
    features = [],
    aLat = anchorLat,
    aLon = anchorLon,
    streetFacingFeatures = [],
) {
    const facadeObjectKeys = new WeakMap();
    const wallFaces = [];
    // A source-agnostic tile can mix survey meshes, footprint fallbacks and
    // stated landmark parts. Facade topology belongs to the MESH PIPELINE,
    // not to the endpoint/source label (`BUILDING_SOURCE` is now often
    // "mesh"). Restricting by the resolved pipeline also keeps footprint and
    // authored landmark geometry out of the GDI wall-plane analyser.
    const meshFeatures = FACADE_WINDOWS
        ? features.filter((feature) => (
            buildingPipelineForFeature(feature?.properties, BUILDING_SOURCE) === PIPELINE_MESH
        ))
        : [];
    const boundaryFaces = meshFeatures.length > 0
        ? collectFacadeBoundaryFaces(meshFeatures, aLat, aLon, facadeObjectKeys, wallFaces)
        : [];
    return {
        // Every wall in the tile, by plane — so a building can tell whether the wall
        // it is about to paint is one another building already models taller.
        sharedWallIndex: buildSharedWallIndex(wallFaces),
        facadeObjectKeys,
        // The shared answer (public.facade_street) and the local geometric fallback for
        // the buildings it has no row for yet. See classifyFacadeExposure().
        streetFacingIndex: buildStreetFacingIndex(streetFacingFeatures, aLat, aLon),
        facadeExposureIndex: buildFacadeExposureIndex(boundaryFaces),
    };
}

function createBuildingBuildContext(
    features = [],
    aLat = anchorLat,
    aLon = anchorLon,
    streetFacingFeatures = [],
    template = null,
) {
    // Facade topology, shared-wall lookup and street-facing evidence depend on
    // the fetched tile only. Terrain/style revisions rebuild the same features,
    // so keep those immutable indexes with the tile and allocate only the
    // generation-owned registries/contribution buffers again. Recomputing the
    // indexes during a ride measured 50-62 ms in rebuildDrain three frames in a
    // row, even though the previous complete visual generation stayed visible.
    const immutable = template || createBuildingBuildContextTemplate(
        features,
        aLat,
        aLon,
        streetFacingFeatures,
    );
    return {
        ...immutable,
        wallFaceRegistry: new Set(),
        contactAoContributions: [],
        roofDrainageContributions: [],
        streetFacingStats: { matched: 0, fallback: 0, fallbackObjects: new Set() },
    };
}

// One logical wall surface → the rules its openings must follow.
//
// The shared street-facing data decides whenever the API has a row that this surface
// matches. Its local party-wall geometry (world/facade-exposure.js) is the FALLBACK for
// buildings the still-in-progress gdi_facade_street table does not cover: an all-or-nothing
// verdict that blanks a whole wall and cannot tell a courtyard from a frontage.
// center: the building's footprint centre, which is what says which way a canonicalised
// wall plane actually faces (the same reference the contact-AO skirts use).
function classifyFacadeExposure(buildContext, objectKey, surface, center) {
    const index = buildContext && buildContext.streetFacingIndex;
    const stats = buildContext && buildContext.streetFacingStats;
    const shared = index ? classifyStreetFacingSurface(index, objectKey, surface, center) : null;
    if (shared) {
        if (stats) stats.matched++;
        return shared;
    }
    if (stats) {
        stats.fallback++;
        if (objectKey != null) stats.fallbackObjects.add(objectKey);
    }
    const partyWall = logicalFacadeBordersBuilding(
        buildContext && buildContext.facadeExposureIndex,
        objectKey,
        surface,
    );
    return {
        source: 'local-party-wall',
        streetFacing: !partyWall,
        coveredHeightM: 0,
        openings: !partyWall,
        storefronts: !partyWall,
    };
}

// Keep the evidence available without printing one line for every completed tile.
// DevTools console rendering amplified a large streamed building ring into visible
// startup work even though empty shared-facade coverage is an expected condition.
function logStreetFacingSummary(buildContext, label) {
    const stats = buildContext && buildContext.streetFacingStats;
    const index = buildContext && buildContext.streetFacingIndex;
    if (!stats || (stats.matched === 0 && stats.fallback === 0)) return;
    if (!streetFacingBuildStats) resetStreetFacingBuildStats();
    streetFacingBuildStats.completedBatches += 1;
    streetFacingBuildStats.apiFacades += index.facadeCount;
    streetFacingBuildStats.apiBuildings += index.objectCount;
    streetFacingBuildStats.matchedSurfaces += stats.matched;
    streetFacingBuildStats.fallbackSurfaces += stats.fallback;
    streetFacingBuildStats.fallbackBuildings += stats.fallbackObjects.size;
    // A batch that actually used shared evidence is useful provenance. Empty
    // coverage is inspectable through __s3dStreetFacingState without flooding
    // the console with the same expected fallback report during rebuilds.
    if (stats.matched === 0) return;
    console.log(logStamp(), 
        `[street-facing] ${label}: ${index.facadeCount} API facades on ${index.objectCount} buildings; ` +
        `${stats.matched} wall surfaces classified from shared data, ` +
        `${stats.fallback} fell back to local party-wall geometry ` +
        `(${stats.fallbackObjects.size} buildings)`,
    );
}

// Gutters and downpipes for the whole tile in ONE mesh. Per building they
// would be ~500 extra draw calls; the scene already runs 2-5k.
function addRoofDrainageBatch(buildContext, tileKey) {
    const contributions = buildContext && buildContext.roofDrainageContributions;
    if (!contributions || contributions.length === 0) return null;
    // A proposal tile's gutters hang on the proposal's own buildings, which sit
    // inside the proposal mask by definition — the recheck below would strip
    // every one of them.
    const proposalTile = isProposalBuildingTileKey(tileKey);
    const positions = [];
    for (const contribution of contributions) {
        // A proposal mask can resolve while this tile's chunk job is running.
        // Recheck at publication, exactly as the AO skirts do, so drainage
        // never outlives the building it hangs on.
        const c = contribution.centroidLatLon;
        if (!proposalTile && c && isMaskedByProposals(c.lat, c.lon)) continue;
        const liftY = Number(contribution.baseY) || 0;
        const src = contribution.positions;
        for (let i = 0; i < src.length; i += 3) positions.push(src[i], src[i + 1] + liftY, src[i + 2]);
    }
    contributions.length = 0;
    const mesh = buildRoofDrainageMesh(positions);
    if (!mesh) return null;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    if (proposalTile) {
        mesh.userData.proposalBuilding = true;
        mesh.visible = proposalBuildingMeshesVisible;
    }
    // Walls are shader-cut inside courtyard/track passages; their drainage has
    // to be cut with them or it hangs in the opening.
    setPassageAwareMaterial(mesh, getRoofDrainageMaterial());
    buildingsGroup.add(mesh);
    hideTileReplacementChild(mesh, tileKey);
    return mesh;
}

function publishContactAoBatch(staged, tileKey) {
    if (!staged || staged.positions.length === 0 || staged.entries.length === 0) return null;
    // Same exemption as the drainage batch: a proposal building's own AO sits
    // inside the proposal mask by definition.
    const proposalTile = isProposalBuildingTileKey(tileKey);
    const mesh = buildContactAoMesh(staged.positions, staged.colors);
    if (!mesh) return null;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    if (proposalTile) {
        mesh.userData.proposalBuilding = true;
        mesh.visible = proposalBuildingMeshesVisible;
    }
    // Keep only vertex ranges and centroids after upload. This lets a late
    // proposal-mask sweep remove one building's contribution without giving
    // up the single AO draw call for the rest of the tile.
    mesh.userData.contactAoEntries = staged.entries;
    // Building walls are shader-cut inside courtyard/custom-track passages.
    // Give the independently batched contact shadow the same discard volumes
    // so a removed wall cannot leave its dark skirt floating on the roadbed.
    setPassageAwareMaterial(mesh, mesh.material);
    buildingsGroup.add(mesh);
    hideTileReplacementChild(mesh, tileKey);
    return mesh;
}

function createContactAoFinalizationTask(buildContext, tileKey) {
    const contributions = buildContext && buildContext.contactAoContributions;
    if (!contributions || contributions.length === 0) return null;
    const proposalTile = isProposalBuildingTileKey(tileKey);
    const include = (contribution) => {
        const c = contribution?.centroidLatLon;
        return proposalTile || !c || !isMaskedByProposals(c.lat, c.lon);
    };
    const createTask = () => createCooperativeBuildTask({
        iterator: () => assembleContactAoBatch(contributions, { include }),
        publish: staged => {
            contributions.length = 0;
            return publishContactAoBatch(staged, tileKey);
        },
    });
    return createRevisionGuardedContactAoTask({
        createTask,
        getMaskRevision: () => contactAoMaskRevision,
    });
}

function hideTileReplacementChild(child, tileKey) {
    const replacement = tileVisualReplacements.get(String(tileKey));
    if (!replacement || !child || replacement.retainedChildren.has(child)
        || replacement.newChildVisibility.has(child)) return;
    replacement.newChildVisibility.set(child, child.visible);
    child.visible = false;
}

function hideTileReplacementChildren(tileKey, startIndex = 0) {
    if (!buildingsGroup) return;
    for (let i = Math.max(0, Number(startIndex) || 0); i < buildingsGroup.children.length; i++) {
        const child = buildingsGroup.children[i];
        if (child?.userData?.tileKey === tileKey) hideTileReplacementChild(child, tileKey);
    }
}

function tagNewChildren(group, before, tileKey) {
    for (let i = before; i < group.children.length; i++) {
        const child = group.children[i];
        child.userData.tileKey = tileKey;
        hideTileReplacementChild(child, tileKey);
    }
}

function registerBuildingEntityTree(root, feature, fallbackSource = null) {
    const metadata = buildingEntityMetadata(feature, fallbackSource);
    if (!metadata) return;
    const meshes = stampEntityTree(root, metadata, {
        include: (object) => object?.isMesh && !object.userData?.proposalTrackDemolitionGhost,
    });
    for (const mesh of meshes) {
        registerEntityObject(mesh, metadata.key, metadata);
    }
}

function setBuildFocus(localX, localZ, viewHeadingDeg = Number.NaN, viewFovDeg = 90) {
    currentBuildLocalX = Number.isFinite(localX) ? localX : 0;
    currentBuildLocalZ = Number.isFinite(localZ) ? localZ : 0;
    currentBuildViewHeadingDeg = Number.isFinite(Number(viewHeadingDeg))
        ? Number(viewHeadingDeg)
        : Number.NaN;
    currentBuildViewFovDeg = Number.isFinite(Number(viewFovDeg))
        ? Number(viewFovDeg)
        : 90;
}

function currentBuildingView() {
    return {
        observerX: currentBuildLocalX,
        observerZ: currentBuildLocalZ,
        headingDeg: currentBuildViewHeadingDeg,
        fovDeg: currentBuildViewFovDeg,
    };
}

function featureBuildDistanceSq(feature) {
    const centroid = featureCentroidLatLon(feature);
    if (!centroid) return Infinity;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const x = (centroid.lon - anchorLon) * scaleLon;
    const z = -(centroid.lat - anchorLat) * scaleLat;
    const dx = x - currentBuildLocalX;
    const dz = z - currentBuildLocalZ;
    return dx * dx + dz * dz;
}

// Applies the server's carve verdicts to a freshly fetched batch of existing buildings.
//
//   razed → dropped from the batch
//   cut   → same feature, same properties (facade colour, building type, object_id), but the
//           geometry swapped for the faces the server re-extruded from the surviving remainder.
//           A LOD2 mesh cannot be sliced face by face, so a cut building trades its facade detail
//           for the truth about its shape — the same trade consensus-builder's own 3D view makes.
//   otherwise → passed through untouched. TUNNELLED buildings land here: they have no verdict,
//           because the road goes UNDER them and nothing about them changed.
//
// A no-op when the deeplink carries no proposals. The GDI feature geometry is a MultiPolygon whose
// polygons are the mesh faces, which is exactly what the carve endpoint returns as `faces`.
function applyProposalCarve(features) {
    const list = Array.isArray(features) ? features : [];
    if (list.length === 0) return list;
    const out = [];
    for (const feature of list) {
        // A PROPOSED building is what the proposals decided to build — running
        // it through their own verdicts makes no sense in any direction: there
        // is no server carve for it, and a planner track crossing it is a
        // plan-authoring overlap, not an acquisition — rendering it as a
        // demolished ruin would claim a decision nobody made.
        if (isProposalBuildingFeature(feature)) {
            out.push(feature);
            continue;
        }
        if (isFeatureDemolishedByProposalTrack(feature)) {
            // Rail acquisition is binary for now: retain the original feature
            // only as data for a transparent whole-building ghost. This takes
            // precedence over legacy road carving, which would otherwise
            // return a misleading sliced remainder.
            // Tally it for the 🏚️ HUD counter (deduped by object_id inside),
            // anchored at its centroid so the ride can count it once passed.
            const demolitionCentroid = featureCentroidLatLon(feature);
            recordTrackDemolition(
                feature?.properties?.object_id,
                demolitionCentroid?.lat,
                demolitionCentroid?.lon,
            );
            out.push({
                ...feature,
                properties: {
                    ...(feature.properties || {}),
                    __proposalTrackDemolished: true,
                },
            });
            continue;
        }
        const objectId = feature && feature.properties && feature.properties.object_id;
        const carve = getLegacyBuildingCarve(objectId);
        if (!carve) {
            out.push(feature);
            continue;
        }
        if (carve.verdict === 'razed') continue;
        if (!Array.isArray(carve.faces) || carve.faces.length === 0) {
            console.warn(`[buildings] cut verdict for ${objectId} carries no faces — rendering it uncarved`);
            out.push(feature);
            continue;
        }
        out.push({
            ...feature,
            // This geometry no longer matches the immutable source mesh whose
            // facade groups the API baked. The full builder handles the carved
            // remainder once; retaining the cache could group the wrong faces
            // if the triangle count happened to remain unchanged.
            properties: {
                ...(feature.properties || {}),
                facade_topology: null,
            },
            geometry: { type: 'MultiPolygon', coordinates: carve.faces.map((f) => f.coordinates) },
        });
    }
    return out;
}

function prioritizeFeatures(features) {
    const safeFeatures = Array.isArray(features) ? features : [];
    if (safeFeatures.length <= 1) return safeFeatures;
    return safeFeatures
        .map((feature, index) => ({
            feature,
            index,
            distanceSq: featureBuildDistanceSq(feature),
        }))
        .sort((a, b) => {
            if (a.distanceSq !== b.distanceSq) return a.distanceSq - b.distanceSq;
            return a.index - b.index;
        })
        .map((entry) => entry.feature);
}

function tileBuildPriority(tileKey, workItems = null) {
    const items = Array.isArray(workItems) ? workItems : [];
    const initialNear = initialNearTileKeys.has(String(tileKey));
    const inProgress = items.find(item => item?.isInProgress());
    if (inProgress) {
        // Once construction has staged part of a building, finish its atomic
        // transaction. The view may turn, but abandoning staged resources to
        // chase it would trade correct ordering for churn.
        return buildingTileBuildPriority(inProgress.viewPriority().score, {
            initialNear,
            inProgress: true,
        });
    }
    let bestRemaining = -Number.MAX_SAFE_INTEGER;
    for (const item of items) {
        if (!item || item.isDone()) continue;
        bestRemaining = Math.max(bestRemaining, item.viewPriority().score);
    }
    if (bestRemaining > -Number.MAX_SAFE_INTEGER) {
        return buildingTileBuildPriority(bestRemaining, { initialNear });
    }
    if (tileKey == null) return buildingTileBuildPriority(0, { initialNear });
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) {
        return buildingTileBuildPriority(0, { initialNear });
    }
    const viewScore = classifyViewPriority(
        tileLocalBounds(tx, tz, DETAILED_BUILDING_TILE_M),
        currentBuildingView(),
    ).score;
    return buildingTileBuildPriority(viewScore, { initialNear });
}

// A feature whose terrain evidence has not arrived ranks below every runnable
// feature of its tile, so the job builds the rest and returns to it. Ranked by
// view alone, the job re-selected the same pending feature every flush and the
// whole tile waited with it (two features at Split's western edge held their
// tiles for 30 s, 2026-09-17). The finalization item ranks below even this.
const DEPENDENCY_PENDING_PRIORITY_PENALTY = 1e9;

function buildingWorkItemPriority(item) {
    if (!item || item.isDone()) return -Number.MAX_SAFE_INTEGER;
    const score = item.viewPriority().score;
    return item.dependencyPending?.() === true ? score - DEPENDENCY_PENDING_PRIORITY_PENALTY : score;
}

function buildingVisibilityBounds(feature) {
    const bounds = featureLocalBounds(feature, anchorLat, anchorLon);
    if (bounds) return bounds;
    const centroid = featureCentroidLatLon(feature);
    if (!centroid) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const x = (centroid.lon - anchorLon) * scaleLon;
    const z = -(centroid.lat - anchorLat) * scaleLat;
    return {
        minX: x,
        maxX: x,
        minZ: z,
        maxZ: z,
    };
}

function classifyBuildingWorkItem(item) {
    return classifyViewPriority(
        item?.visibilityBounds,
        currentBuildingView(),
    );
}

function beginInitialNearFieldGate() {
    // Only the tiles touching the observer block reveal. The complete 5 x 5
    // detailed ring and route-ahead corridor remain requested, but making all
    // 25 tiles part of startup kept production behind the curtain for minutes.
    initialNearTileKeys = initialWorldSupportTileKeys();
    noteWorldQueueActive('buildings');
}

function noteInitialNearTileReady(tileKey) {
    if (!initialNearTileKeys.delete(String(tileKey))) return;
    if (initialNearTileKeys.size === 0) noteWorldQueueIdle('buildings');
}

function quantizeWallFaceKey(nx, nz, d) {
    const qx = Math.round(nx / WALL_FACE_NORMAL_QUANT) * WALL_FACE_NORMAL_QUANT;
    const qz = Math.round(nz / WALL_FACE_NORMAL_QUANT) * WALL_FACE_NORMAL_QUANT;
    const qd = Math.round(d / WALL_FACE_D_QUANT) * WALL_FACE_D_QUANT;
    return `${qx.toFixed(2)}|${qz.toFixed(2)}|${qd.toFixed(1)}`;
}

function canonicalizeWallPlane(nx, nz, d) {
    const len = Math.sqrt(nx * nx + nz * nz);
    if (len < 1e-6) return null;
    let cnx = nx / len;
    let cnz = nz / len;
    let cd = d / len;
    if (cnx < -1e-6 || (Math.abs(cnx) <= 1e-6 && cnz < 0)) {
        cnx = -cnx;
        cnz = -cnz;
        cd = -cd;
    }
    return { nx: cnx, nz: cnz, d: cd };
}

function quantizeWallFaceUv(value) {
    return Math.round(value / WALL_FACE_UV_QUANT) * WALL_FACE_UV_QUANT;
}

function makeWallFaceSignature(planeKey, verts, tx, tz) {
    const unique = new Set();
    for (const v of verts) {
        const u = quantizeWallFaceUv(v[0] * tx + v[2] * tz);
        const y = quantizeWallFaceUv(v[1]);
        unique.add(`${u.toFixed(2)},${y.toFixed(2)}`);
    }
    return `${planeKey}|${Array.from(unique).sort().join(';')}`;
}

// `tolerant` keeps the description of a ring GDI could not hold in one plane — 8% of
// them are more than WALL_FACE_PLANAR_EPS_M out. It is used ONLY to decide which of two
// walls standing in the same place is in front, where a few centimetres of warp change
// nothing. The exact-duplicate registry and the AO skirts keep the strict verdict: they
// compare walls for identity, and there a warped ring is not the same wall.
function describeVerticalWallFace(verts, { tolerant = false } = {}) {
    if (!Array.isArray(verts) || verts.length < 3) return null;
    let plane = null;
    const v0 = verts[0];
    for (let i = 1; i < verts.length - 1; i++) {
        const v1 = verts[i];
        const v2 = verts[i + 1];
        const e1x = v1[0] - v0[0];
        const e1y = v1[1] - v0[1];
        const e1z = v1[2] - v0[2];
        const e2x = v2[0] - v0[0];
        const e2y = v2[1] - v0[1];
        const e2z = v2[2] - v0[2];
        const cnx = e1y * e2z - e1z * e2y;
        const cny = e1z * e2x - e1x * e2z;
        const cnz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz);
        if (len < 1e-6) continue;
        if (Math.abs(cny) / len > 0.5) return null;
        const canonical = canonicalizeWallPlane(cnx, cnz, cnx * v0[0] + cnz * v0[2]);
        if (!canonical) return null;
        const horizontalLength = Math.hypot(cnx, cnz);
        const outwardNx = cnx / horizontalLength;
        const outwardNz = cnz / horizontalLength;
        const outwardAlongCanonical = outwardNx * canonical.nx + outwardNz * canonical.nz;
        plane = {
            ...canonical,
            // The ring normal points out of the GDI solid, so its interior is
            // the opposite canonical half-plane.
            interiorSide: outwardAlongCanonical >= 0 ? -1 : 1,
        };
        break;
    }
    if (!plane) return null;

    let warped = false;
    for (const v of verts) {
        const gap = Math.abs(plane.nx * v[0] + plane.nz * v[2] - plane.d);
        if (gap > WALL_FACE_PLANAR_EPS_M) { warped = true; break; }
    }
    if (warped) {
        if (!tolerant) return null;
        // Best-fit depth across the whole ring rather than the first triangle's,
        // so a warped wall is placed at its middle instead of at one corner.
        plane = {
            ...plane,
            d: verts.reduce((sum, v) => sum + plane.nx * v[0] + plane.nz * v[2], 0) / verts.length,
        };
    }

    const tx = plane.nz;
    const tz = -plane.nx;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const v of verts) {
        const u = v[0] * tx + v[2] * tz;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v[1] < vMin) vMin = v[1];
        if (v[1] > vMax) vMax = v[1];
    }

    return {
        ...plane,
        key: quantizeWallFaceKey(plane.nx, plane.nz, plane.d),
        signature: makeWallFaceSignature(
            quantizeWallFaceKey(plane.nx, plane.nz, plane.d),
            verts,
            tx,
            tz,
        ),
        uMin,
        uMax,
        vMin,
        vMax,
    };
}

// Recover each building's footprint boundary from its ground-touching GDI
// wall faces. The resulting index is built once per fetched batch; individual
// window cells never repeat this work.
function collectFacadeBoundaryFaces(features, aLat, aLon, objectKeys, allWallFaces = null) {
    const boundaryFaces = [];
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        const feature = features[featureIndex];
        if (!feature || typeof feature !== 'object') continue;
        const properties = feature.properties || {};
        const objectId = properties.object_id;
        const objectKey = objectId != null ? objectId : `anonymous-building:${featureIndex}`;
        objectKeys.set(feature, objectKey);
        if (isBlockedBuildingObjectId(objectId)) continue;
        // Only the proposal-BUILDINGS mask applies here: razed buildings never reach this list
        // (applyProposalCarve dropped them) and cut ones arrive already carved, so their facade
        // index is built from the remainder they actually have.
        if (isFeatureMaskedByProposalBuildings(feature)) continue;
        const geometry = feature.geometry;
        if (!geometry || geometry.type !== 'MultiPolygon') continue;
        const zMin = properties.z_min || 0;
        const fallbackWallTriangles = [];
        for (const polygonCoords of geometry.coordinates || []) {
            const verts = localizeGdiFace(
                polygonCoords,
                zMin,
                aLat,
                aLon,
                scaleLon,
                scaleLat,
            );
            const wallFace = describeVerticalWallFace(verts);
            if (wallFace) {
                if (wallFace.vMin <= 0.5 && wallFace.uMax - wallFace.uMin >= 0.8) {
                    boundaryFaces.push({ ...wallFace, objectId: objectKey });
                }
                // Every wall face, at any height, feeds the shared-wall index: a
                // wall split into a lower and an upper ring would otherwise look
                // short from the ground, and the taller copy would go unnoticed.
                if (allWallFaces) allWallFaces.push({ ...wallFace, objectId: objectKey });
                continue;
            }
            // Warped rings stand somewhere too, and a wall they hide behind still has
            // to know they are there.
            if (allWallFaces) {
                const tolerantFace = describeVerticalWallFace(verts, { tolerant: true });
                if (tolerantFace) allWallFaces.push({ ...tolerantFace, objectId: objectKey });
            }

            // Slightly non-planar rings are recovered triangle-first by the
            // renderer. Feed the same fallback surfaces into the exposure
            // index, otherwise two imperfect row-house party walls could both
            // be mistaken for exposed facades.
            const v0 = verts[0];
            for (let i = 1; i < verts.length - 1; i++) {
                const v1 = verts[i], v2 = verts[i + 1];
                const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
                const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
                const cnx = e1y * e2z - e1z * e2y;
                const cny = e1z * e2x - e1x * e2z;
                const cnz = e1x * e2y - e1y * e2x;
                const cnLen = Math.hypot(cnx, cny, cnz);
                if (cnLen > 1e-6 && Math.abs(cny) / cnLen <= 0.5) {
                    fallbackWallTriangles.push([v0, v1, v2]);
                }
            }
        }
        for (const surface of buildLogicalFacadeSurfaces(fallbackWallTriangles)) {
            if (surface.minV > 0.5 || surface.maxU - surface.minU < 0.8) continue;
            boundaryFaces.push({
                objectId: objectKey,
                nx: surface.nx,
                nz: surface.nz,
                d: surface.d,
                interiorSide: surface.interiorSide,
                minU: surface.minU,
                maxU: surface.maxU,
            });
        }
    }
    return boundaryFaces;
}

// Enough to settle a depth tie between coplanar duplicates, far too little to
// see. It is applied to the copy's geometry, never to whether it is drawn.
const DUPLICATE_WALL_INSET_M = 0.01;
// A wall that another building models taller, at the same depth, goes back far enough
// that the taller one wins the depth test outright rather than flickering against it.
const SHORT_COPY_WALL_INSET_M = 0.03;

function insetWallTriangle(v0, v1, v2, inset) {
    return [
        [v0[0] + inset.x, v0[1], v0[2] + inset.z],
        [v1[0] + inset.x, v1[1], v1[2] + inset.z],
        [v2[0] + inset.x, v2[1], v2[2] + inset.z],
    ];
}

function shouldSkipDuplicateWallFace(faceRegistry, face) {
    if (!faceRegistry || !face) return false;
    return faceRegistry.has(face.signature);
}

function registerWallFace(faceRegistry, face) {
    if (!faceRegistry || !face) return;
    faceRegistry.add(face.signature);
}

function createBuildingMesh(polygon, zDelta, centerLon, centerLat, objectId = null) {
    const ring = polygon.coordinates[0];
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(centerLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const shape = new THREE.Shape();
    for (let i = 0; i < ring.length; i++) {
        const lon = ring[i][0], lat = ring[i][1];
        const x = (lon - centerLon) * SCALE_LON;
        const z = -(lat - centerLat) * SCALE_LAT;
        if (i === 0) shape.moveTo(x, -z);
        else shape.lineTo(x, -z);
    }
    // Inner rings are courtyards. Attached as Path holes so ExtrudeGeometry
    // keeps the court open and builds its walls — a perimeter block used to
    // extrude as a solid slab because only coordinates[0] was read.
    for (let r = 1; r < polygon.coordinates.length; r++) {
        const hole = polygon.coordinates[r];
        if (!Array.isArray(hole) || hole.length < 3) continue;
        const path = new THREE.Path();
        for (let i = 0; i < hole.length; i++) {
            const x = (hole[i][0] - centerLon) * SCALE_LON;
            const z = -(hole[i][1] - centerLat) * SCALE_LAT;
            if (i === 0) path.moveTo(x, -z);
            else path.lineTo(x, -z);
        }
        shape.holes.push(path);
    }
    const height = Math.max(zDelta || 3, 1);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    // Per-building muted shade + wear texture for Overture stock; the shared
    // beige remains the id-less fallback (bus imports and degenerate data).
    const wallMaterial = objectId != null ? getOvertureWallMaterial(objectId) : buildingMaterial;
    const mesh = new THREE.Mesh(geometry, wallMaterial);
    if (terrainReference) mesh.position.y = terrainReference.evidenceFoundationSceneY(ring);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    setPassageAwareMaterial(mesh, wallMaterial);
    return mesh;
}

const FOUNDATION_SKIRT_TEXTURE_M = 5.5;

function getFoundationSkirtTexture() {
    if (foundationSkirtTexture) return foundationSkirtTexture;
    const raster = createFoundationWeatheringRaster(128);
    const map = makeStoneDataTexture(raster.color, raster.size, THREE.SRGBColorSpace);
    map.name = 'BuildingFoundationWeatheredConcrete';
    map.repeat.set(1 / FOUNDATION_SKIRT_TEXTURE_M, 1 / FOUNDATION_SKIRT_TEXTURE_M);
    foundationSkirtTexture = map;
    return foundationSkirtTexture;
}

// Muted concrete-grey band shared by every foundation skirt. Its metre-based
// UVs now carry one seamless weathered-concrete map: fine aggregate,
// restrained pour joints, mineral blooms, runoff and hairline cracking. One
// shared material preserves the existing batching/resource contract. Honours the
// planner surface cutout (ramp/stairwell openings a wall must not seal). The
// generic road/formation channel still does NOT cut this material: a skirt may
// stand down to a benched street. setPassageAwareMaterial adds only the much
// narrower rail-EXCAVATION channel, because a deep open railway cut cannot
// legitimately carry a facade or foundation at any height.
function getFoundationSkirtMaterial() {
    if (foundationSkirtMaterial) return foundationSkirtMaterial;
    const mat = new THREE.MeshStandardMaterial({
        // The near-white map multiplies this tint back to the original average
        // dark-grey value while giving it real concrete variation.
        color: 0x777674,
        map: getFoundationSkirtTexture(),
        roughness: 0.94,
        metalness: 0,
        envMapIntensity: 0.22,
    });
    mat.name = 'BuildingFoundationSkirt';
    applyPlannerSurfaceCutout(mat, BUILDING_MATERIAL_CLAIM);
    registerShared(mat);
    foundationSkirtMaterial = mat;
    return mat;
}

// Additive draped foundation: a separate vertical band around a footprint,
// from the flat building base (foundationSceneY — the terrain MAX over the
// footprint, so its top edge meets the wall base) DOWN to the terrain at each
// footprint vertex. On flat ground every edge is flush and no band is emitted;
// on a slope it fills the gap under the downhill side. Tagged so the existing
// tile-eviction/clear logic disposes it with the building. Never throws — a
// missing terrain reference or degenerate footprint simply skips.
function createBuildingFoundationGroundSampler(topSceneY) {
    // The visible ground beside a building is not always the raw grid: streets
    // benched into a slope render a metre or two below it. Where the raw band
    // would be near-skipped, the sampler consults the road/rail formations, so
    // a street-facing edge closes down to the street instead of skipping as
    // "flat" and leaving an open gap under the facade from that side.
    return composeFoundationGroundSampler({
        terrainAt: (x, z) => terrainReference.evidenceSceneYAtLocal(x, z),
        formationAts: [
            // Published indexes only: a pending build elsewhere must never
            // turn this sample into a synchronous road compile.
            terrainReference.roadFormation
                ? (x, z) => terrainReference.roadFormation.sceneYAtLocal(x, z, { maxDistanceM: 18, allowStale: true })
                : null,
            terrainReference.railFormation
                ? (x, z) => terrainReference.railFormation.sceneYAtLocal(x, z, { maxDistanceM: 18 })
                : null,
        ].filter(Boolean),
        topSceneY,
    });
}

function buildingFoundationMinimumBottomYAtLocal(x, z) {
    const roof = terrainReference.railFormation?.tunnelRoofInfoAt?.(x, z, 0.1);
    const ceilingY = Number(roof?.ceilingY);
    return Number.isFinite(ceilingY) ? ceilingY + 0.04 : NaN;
}

function createFoundationSkirtPositionsIterator(segments, topSceneY, dependencies = null) {
    if (!terrainReference || !Array.isArray(segments) || segments.length < 3
        || !Number.isFinite(topSceneY)) return null;
    const groundAt = createBuildingFoundationGroundSampler(topSceneY);
    const sampleYAtLocal = dependencies
        ? (x, z) => dependencies.record(0, topSceneY, x, z, groundAt(x, z)) : groundAt;
    return buildFoundationSkirtPositionsCooperative(
        segments,
        topSceneY,
        sampleYAtLocal,
        {
            // Sample along the wall, not just at its corners: a long footprint
            // edge across a swale used to bridge the dip with a straight chord
            // (a see-through hole under the facade) or skip its band entirely
            // when both corners sat flush. 6 m stays under the 20 m terrain
            // cell, so every cell crossing under the wall is sampled.
            maxSegmentM: 6,
            // Tuck the band WELL under the sampled grid: the visible ground is
            // often a draped decor plaza whose coarser refinement (edges up to
            // 32 m) sags metres below the raw grid in dips, and it is baked
            // geometry with no surface to query. Three metres covers the
            // worst measured mismatch on Rijeka's slopes; the overshoot is
            // buried and invisible, flat ground still emits nothing, and
            // formation cutouts still discard the band wherever a road/rail
            // cut owns the ground.
            plungeM: 3.0,
            // A bored tunnel keeps the building and terrain above it, so its
            // plan footprint is intentionally NOT in the rail-excavation mask.
            // Stop only the blind burial overshoot at the physical tube roof;
            // the visible foundation remains free to descend to adjacent open
            // cuts and retained streets outside the bore.
            minimumBottomYAtLocal: dependencies
                ? (x, z) => dependencies.record(1, topSceneY, x, z, buildingFoundationMinimumBottomYAtLocal(x, z))
                : buildingFoundationMinimumBottomYAtLocal,
            // Formation refinement can make one terrain sample substantially
            // more expensive than the pure geometry arithmetic. Yield after
            // every sampled piece so a pathological perimeter cannot turn the
            // fixed 16-piece batch into a long frame.
            piecesPerStage: 1,
        },
    );
}

function createFoundationSkirtMesh(segments, topSceneY, tileKey, objectId, {
    positionYOffsetY = 0,
    geometryData = null,
    bufferData = null,
} = {}) {
    let skirtData = bufferData;
    if (!skirtData) {
        let sampledData = geometryData;
        if (!sampledData) {
            const iterator = createFoundationSkirtPositionsIterator(segments, topSceneY);
            if (!iterator) return null;
            let outcome;
            do {
                outcome = iterator.next();
            } while (!outcome.done);
            sampledData = outcome.value;
        }
        const bufferIterator = prepareFoundationSkirtBuffersCooperative(
            sampledData,
            { positionYOffsetY, consumeSource: true },
        );
        let bufferStep;
        do {
            bufferStep = bufferIterator.next();
        } while (!bufferStep.done);
        skirtData = bufferStep.value;
    }
    const { positions, normals, uvs, triangleCount } = skirtData;
    if (triangleCount === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals.length === positions.length) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
        geometry.computeVertexNormals();
    }
    if (uvs.length === (positions.length / 3) * 2) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    const mesh = new THREE.Mesh(geometry, getFoundationSkirtMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.buildingFoundationSkirt = true;
    if (objectId != null) mesh.userData.objectId = objectId;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    return mesh;
}

function addFoundationSkirt(polygon, aLat, aLon, tileKey, objectId) {
    if (!terrainReference || !buildingsGroup) return;
    const ring = polygon && polygon.coordinates && polygon.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return;
    // Same base the building mesh is lifted to, so the top edge has no seam.
    const topSceneY = terrainReference.evidenceFoundationSceneY(ring);
    if (!Number.isFinite(topSceneY)) return;
    const footprint = localizeFootprintGeometry(objectId, polygon, tileKey, aLat, aLon);
    if (!footprint || !Array.isArray(footprint.segments) || footprint.segments.length < 3) return;
    const mesh = createFoundationSkirtMesh(
        footprint.segments,
        topSceneY,
        tileKey,
        objectId,
    );
    if (!mesh) return;
    buildingsGroup.add(mesh);
}

function addBuildingFeatureFootprint(feature, aLat, aLon, tileKey) {
    const objectId = feature.properties && feature.properties.object_id;
    if (objectId != null) {
        if (loadedBuildingIds.has(objectId)) return 0;
        loadedBuildingIds.add(objectId);
        recordTileBuilding(tileKey, objectId);
    }
    const geom = feature.geometry;
    const zDelta = feature.properties && feature.properties.z_delta;
    if (!geom) return 0;
    const before = buildingsGroup.children.length;
    let added = 0;
    if (geom.type === 'Polygon') {
        buildingsGroup.add(createBuildingMesh(geom, zDelta, aLon, aLat));
        addFoundationSkirt(geom, aLat, aLon, tileKey, objectId);
        added = 1;
    } else if (geom.type === 'MultiPolygon') {
        for (const polygonCoords of geom.coordinates) {
            const polygon = { type: 'Polygon', coordinates: polygonCoords };
            buildingsGroup.add(createBuildingMesh(polygon, zDelta, aLon, aLat));
            addFoundationSkirt(polygon, aLat, aLon, tileKey, objectId);
            added++;
        }
    }
    tagNewChildren(buildingsGroup, before, tileKey);
    return added;
}

function* stageBuildingFeatureGdi(
    feature,
    aLat,
    aLon,
    tileKey,
    buildContext,
    transaction,
) {
    const objectId = feature.properties && feature.properties.object_id;
    const targetGroup = transaction.group;
    // The key the shared-wall index tags its faces with — needed in the face loop
    // below, long before the facade grid is laid out.
    const sharedWallKey = buildContext && buildContext.facadeObjectKeys
        ? buildContext.facadeObjectKeys.get(feature) ?? objectId
        : objectId;
    const geom = feature.geometry;
    const zMin = (feature.properties && feature.properties.z_min) || 0;
    if (!geom || geom.type !== 'MultiPolygon') return 0;
    // The building's walls/roof are authored base-at-0 and lifted to their
    // surveyed absolute height by the caller (see addBuildingFeature). The gutters
    // and contact-AO skirts are batched into a per-tile mesh added AFTER that lift,
    // so they must carry the same lift on their contributions or they stay pinned to
    // the anchor plane while the building rises (skirts/gutters left on the ground).
    const foundationLiftY = terrainReference ? terrainReference.absoluteToSceneY(zMin) : 0;

    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    // Procedural windows are painted per logical facade, under the rules
    // classifyFacadeExposure() reads off the shared street-facing data: a street
    // frontage gets windows and a ground floor of shops, a courtyard wall gets plain
    // windows and no shops, and the part of a wall a neighbour stands against gets
    // nothing.
    const facadeTriangles = [];    // wall triangles, grouped later into true logical surfaces
    const aoFaces = [];            // ground-touching planar walls → contact-AO skirts
    const footprintFaces = [];     // strict + tolerant ground walls → pedestrian boundary
    const wallSupportTriangles = []; // actual wall silhouette for strict opening containment
    const blankWallPositions = [];
    const blankWallNormals = [];
    const blankWallUVs = [];
    const roofPositions = [];
    const roofNormals = [];
    const roofUVs = [];
    const flatRoofPositions = [];
    const flatRoofNormals = [];
    const flatRoofUVs = [];
    let hasPitchedRoof = false;
    // Footprint extent, for the "large buildings only" gutter gate.
    let footprintMinX = Infinity, footprintMaxX = -Infinity;
    let footprintMinZ = Infinity, footprintMaxZ = -Infinity;
    const appendBlankWallTriangle = (v0, v1, v2, tangent = null) => {
        let ux = tangent && tangent[0];
        let uz = tangent && tangent[1];
        if (!Number.isFinite(ux) || !Number.isFinite(uz)) {
            const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
            const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
            const cnx = e1y * e2z - e1z * e2y;
            const cnz = e1x * e2y - e1y * e2x;
            const tLen = Math.hypot(cnx, cnz);
            ux = tLen > 1e-6 ? cnz / tLen : 1;
            uz = tLen > 1e-6 ? -cnx / tLen : 0;
        }
        blankWallPositions.push(
            v0[0], v0[1], v0[2],
            v1[0], v1[1], v1[2],
            v2[0], v2[1], v2[2],
        );
        const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
        const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const normalLength = Math.hypot(nx, ny, nz) || 1;
        const normalX = nx / normalLength;
        const normalY = ny / normalLength;
        const normalZ = nz / normalLength;
        blankWallNormals.push(
            normalX, normalY, normalZ,
            normalX, normalY, normalZ,
            normalX, normalY, normalZ,
        );
        blankWallUVs.push(
            v0[0] * ux + v0[2] * uz, v0[1],
            v1[0] * ux + v1[2] * uz, v1[1],
            v2[0] * ux + v2[2] * uz, v2[1],
        );
    };
    let maxBuildingY = 0;   // tallest vertex above the base → drives facade floor count
    let maxWallY = 0;       // tallest WALL (non-roof) vertex = the cornice → window scaling
    // Buildings with detected real windows keep the same base walls and draw
    // those actual opening overlays instead of the procedural overlay.
    const useRealWindows = hasFacadeWindows(objectId);
    let cxSum = 0, czSum = 0, vCount = 0;   // footprint centroid → orients window normals
    let geometryStageStartedMs = buildingNowMs();
    let geometryTrianglesSinceYield = 0;
    for (const polygonCoords of geom.coordinates) {
        const localizeIterator = localizeGdiFaceCooperative(
            polygonCoords,
            zMin,
            aLat,
            aLon,
            SCALE_LON,
            SCALE_LAT,
        );
        let localizeStep = localizeIterator.next();
        while (!localizeStep.done) {
            yield { ...localizeStep.value, objectId };
            geometryStageStartedMs = buildingNowMs();
            geometryTrianglesSinceYield = 0;
            localizeStep = localizeIterator.next();
        }
        const verts = localizeStep.value;
        if (verts.length < 3) continue;
        for (const v of verts) {
            if (v[1] > maxBuildingY) maxBuildingY = v[1];
            if (v[0] < footprintMinX) footprintMinX = v[0];
            if (v[0] > footprintMaxX) footprintMaxX = v[0];
            if (v[2] < footprintMinZ) footprintMinZ = v[2];
            if (v[2] > footprintMaxZ) footprintMaxZ = v[2];
            cxSum += v[0]; czSum += v[2]; vCount++;
        }
        const wallFace = describeVerticalWallFace(verts);
        // Exact duplicate faces may share one procedural opening overlay, but
        // never suppress source building geometry. The base wall below is
        // emitted regardless of this window-only deduplication result.
        const duplicateFacadeFace = wallFace && shouldSkipDuplicateWallFace(
            buildContext && buildContext.wallFaceRegistry,
            wallFace,
        );
        // Two GDI features can carry the same party wall as identical coplanar
        // geometry, and both copies get drawn (deleting source triangles is how
        // buildings end up with holes). Coplanar duplicates with different
        // per-object plaster tints z-fight, so the second copy is pushed one
        // centimetre into its OWN solid, where it can never win the depth test
        // against the first. Nothing is dropped: a wrong duplicate verdict can
        // only shift a wall by a centimetre, never open it.
        // A wall another building models TALLER at the same depth is that same wall,
        // modelled twice — a ground-floor annex is its own GDI object and carries the
        // main building's street wall again, 5 m tall. Both copies earn a facade grid,
        // and at equal depth the two ground floors z-fight. Pushing the short copy into
        // its own solid lets the taller wall — the one with the storeys — win the depth
        // test. NOTHING is dropped: the short wall keeps its grid and still paints
        // wherever the taller one does not cover it.
        const depthFace = wallFace || describeVerticalWallFace(verts, { tolerant: true });
        const shortCopyFace = depthFace && !duplicateFacadeFace && wallFaceIsShortCopy(
            buildContext && buildContext.sharedWallIndex,
            depthFace,
            sharedWallKey,
        );
        const wallInsetDepthM = duplicateFacadeFace ? DUPLICATE_WALL_INSET_M
            : shortCopyFace ? SHORT_COPY_WALL_INSET_M
            : 0;
        const insetFace = duplicateFacadeFace ? wallFace : depthFace;
        const duplicateInsetM = wallInsetDepthM > 0 && insetFace
            ? {
                x: insetFace.nx * insetFace.interiorSide * wallInsetDepthM,
                z: insetFace.nz * insetFace.interiorSide * wallInsetDepthM,
            }
            : null;
        // Collect every wall triangle before deciding whether it earns a
        // procedural facade. A GDI source polygon can be a few centimetres out
        // of plane even though its individual triangles form valid connected
        // wall surfaces (object 64898 is one such case). Requiring the whole
        // ring to pass describeVerticalWallFace() forced those triangles into
        // blank plaster and hid a valid facade behind them. Coplanarity,
        // connectivity, width, ground contact and party-wall checks all belong
        // to the logical-surface pass below.
        const collectFacadeTriangles = FACADE_WINDOWS
            && !useRealWindows
            && !duplicateFacadeFace;
        // Per-triangle classification: each fan triangle decides for itself
        // whether it's a roof (mostly upward-facing normal) or a wall, rather
        // than the whole polygon inheriting the first triangle's verdict.
        // Non-planar polygons in GDI data — common for buildings with slight
        // Z-variance in their wall vertices — used to misclassify entire
        // walls as roofs because the very first triangle happened to point
        // upward; per-triangle classification fixes that.
        const v0 = verts[0];
        for (let i = 1; i < verts.length - 1; i++) {
            const v1 = verts[i], v2 = verts[i + 1];
            const e1x = v1[0]-v0[0], e1y = v1[1]-v0[1], e1z = v1[2]-v0[2];
            const e2x = v2[0]-v0[0], e2y = v2[1]-v0[1], e2z = v2[2]-v0[2];
            const cnx = e1y*e2z - e1z*e2y, cny = e1z*e2x - e1x*e2z, cnz = e1x*e2y - e1y*e2x;
            const cnLen = Math.sqrt(cnx*cnx + cny*cny + cnz*cnz);
            const isRoof = cnLen > 1e-6 && Math.abs(cny) / cnLen > 0.5;
            if (!isRoof) {
                if (v0[1] > maxWallY) maxWallY = v0[1];
                if (v1[1] > maxWallY) maxWallY = v1[1];
                if (v2[1] > maxWallY) maxWallY = v2[1];
                if (useRealWindows) wallSupportTriangles.push([v0, v1, v2]);
            }
            if (isRoof) {
                // Shingles belong on a pitch. A level roof is a membrane.
                const flat = isFlatRoofNormal(cny, cnLen);
                const positions = flat ? flatRoofPositions : roofPositions;
                const normals = flat ? flatRoofNormals : roofNormals;
                const uvs = flat ? flatRoofUVs : roofUVs;
                if (!flat) hasPitchedRoof = true;
                positions.push(...v0, ...v1, ...v2);
                const normalX = cnLen > 1e-6 ? cnx / cnLen : 0;
                const normalY = cnLen > 1e-6 ? cny / cnLen : 1;
                const normalZ = cnLen > 1e-6 ? cnz / cnLen : 0;
                normals.push(
                    normalX, normalY, normalZ,
                    normalX, normalY, normalZ,
                    normalX, normalY, normalZ,
                );
                uvs.push(
                    v0[0], v0[2],
                    v1[0], v1[2],
                    v2[0], v2[2],
                );
            } else {
                // The inset runs along the wall's own normal, so u and v are untouched:
                // the grid this wall carries is identical, only its depth changes. Wall
                // and facade take the SAME triangle, so an overlay can never float free
                // of the wall it is painting.
                const triangle = duplicateInsetM
                    ? insetWallTriangle(v0, v1, v2, duplicateInsetM)
                    : collectFacadeTriangles
                        ? [v0, v1, v2]
                        : null;
                const renderedV0 = triangle?.[0] || v0;
                const renderedV1 = triangle?.[1] || v1;
                const renderedV2 = triangle?.[2] || v2;
                // The base building surface is unconditional. Facade logic may
                // add an openings overlay later, but it cannot replace,
                // repartition, or remove this triangle.
                appendBlankWallTriangle(renderedV0, renderedV1, renderedV2);
                if (collectFacadeTriangles) facadeTriangles.push(triangle);
            }
            geometryTrianglesSinceYield += 1;
            if (geometryTrianglesSinceYield >= BUILD_GEOMETRY_TRIANGLES_PER_STAGE
                || buildingNowMs() - geometryStageStartedMs >= BUILD_STAGE_TARGET_MS) {
                yield { phase: 'geometry-triangles', objectId };
                geometryStageStartedMs = buildingNowMs();
                geometryTrianglesSinceYield = 0;
            }
        }
        if (wallFace) registerWallFace(buildContext && buildContext.wallFaceRegistry, wallFace);
        if (wallFace && wallFace.vMin <= 0.5 && (wallFace.uMax - wallFace.uMin) >= 0.8) {
            aoFaces.push(wallFace);
        }
        if (depthFace && depthFace.vMin <= 0.5 && (depthFace.uMax - depthFace.uMin) >= 0.2) {
            footprintFaces.push(depthFace);
        }
        if (buildingNowMs() - geometryStageStartedMs >= BUILD_STAGE_TARGET_MS) {
            yield { phase: 'geometry-faces', objectId };
            geometryStageStartedMs = buildingNowMs();
            geometryTrianglesSinceYield = 0;
        }
    }
    yield { phase: 'geometry-finalize', objectId };

    if (facadeTriangles.length === 0 && blankWallPositions.length === 0
        && roofPositions.length === 0 && flatRoofPositions.length === 0) return 0;

    const featureObjectId = feature.properties && feature.properties.object_id;
    const useClass = feature.properties && feature.properties.use_class;
    const addMesh = (positions, mat, uvs, normals = null) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        if (uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        if (normals && normals.length === positions.length) {
            geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        } else {
            geo.computeVertexNormals();
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (tileKey != null) mesh.userData.tileKey = tileKey;
        if (featureObjectId != null) mesh.userData.objectId = featureObjectId;
        setPassageAwareMaterial(mesh, mat);
        targetGroup.add(mesh);
        return mesh;
    };
    // Build one grid only across triangles that form one tightly-coplanar,
    // connected wall surface. Unlike the former 4 m depth band, a 0.5 m setback
    // is necessarily a separate facade and can never provide the missing half
    // of a window on its neighbour.
    const buildingCenterX = vCount > 0 ? cxSum / vCount : 0;
    const buildingCenterZ = vCount > 0 ? czSum / vCount : 0;
    // One grid per wall. Two overlapping patches of the SAME wall would each lay
    // out their own storeys, bays, entrance and shopfronts, and the alpha-tested
    // overlay leaves both of them visible — one grid's window painted over the
    // other's shopfront, and two front doors on one facade.
    const cachedFacadeSurfaces = restoreFacadeTopologyCache(
        facadeTriangles,
        feature.properties && feature.properties.facade_topology,
    );
    let facadeSurfaces = cachedFacadeSurfaces;
    if (!facadeSurfaces) {
        const facadeSurfaceIterator = buildLogicalFacadeSurfacesCooperative(facadeTriangles);
        let facadeSurfaceStep = facadeSurfaceIterator.next();
        while (!facadeSurfaceStep.done) {
            yield { ...facadeSurfaceStep.value, objectId };
            facadeSurfaceStep = facadeSurfaceIterator.next();
        }
        facadeSurfaces = mergeDuplicateWallSurfaces(facadeSurfaceStep.value);
    }
    yield {
        phase: cachedFacadeSurfaces ? 'facade-topology-cache' : 'facade-topology',
        objectId,
    };
    // Facade analysis below is additive only: it may create an openings
    // overlay, while the complete base wall geometry already exists above.
    const facadeBatches = new Map();
    const facadeObjectKey = buildContext && buildContext.facadeObjectKeys
        ? buildContext.facadeObjectKeys.get(feature) ?? objectId
        : objectId;
    // Decided once for the whole building, not per wall: a tower is glazed on
    // every side, and a low wing of a tall building must not revert to plaster.
    // The eaves line: the head of every wall that ends level, which is the top of
    // a flat-roofed block and the gutter line of a pitched one. A gable end's
    // sloped head disqualifies it, so a ridge can never stand in for a storey.
    const eavesSurfaces = new Set();
    let eavesY = 0;
    for (const surface of facadeSurfaces) {
        if (!surfaceCarriesEaves(surface)) continue;
        eavesSurfaces.add(surface);
        if (surface.maxV > eavesY) eavesY = surface.maxV;
    }
    // GDI surveys the cornice itself (gdi_building.eave_height_m), in the same datum as
    // the mesh — metres above this building's own base. Prefer it: the geometric eaves
    // line is inferred from wall heads, and inferring it is what put curtain walls on
    // old-town blocks in the first place. GDI's own low-confidence flag falls back.
    const surveyedEavesM = feature.properties && feature.properties.eave_height_m;
    const eavesHeightM = Number.isFinite(surveyedEavesM)
        && !(feature.properties && feature.properties.eave_low_confidence)
        ? surveyedEavesM
        : eavesY;
    const glassTower = isGlassTowerHeight(eavesHeightM);
    // Rain gutters: large buildings only for now, and only where there is an
    // actual eave. A flat roof drains internally behind a parapet — hanging a
    // trough off it would be inventing a building that isn't there.
    const footprintM2 = vCount > 0 && Number.isFinite(footprintMinX)
        ? (footprintMaxX - footprintMinX) * (footprintMaxZ - footprintMinZ)
        : 0;
    const wantsGutters = hasPitchedRoof && footprintM2 >= GUTTER_MIN_FOOTPRINT_M2 && vCount > 0;
    // Shed-sized buildings put their single opening on the widest face.
    let singleOpeningSurface = null;
    if (footprintM2 >= FACADE_MIN_OPENINGS_FOOTPRINT_M2
        && footprintM2 < FACADE_SINGLE_OPENING_FOOTPRINT_M2) {
        for (const candidate of facadeSurfaces) {
            if (!singleOpeningSurface
                || (candidate.maxU - candidate.minU) > (singleOpeningSurface.maxU - singleOpeningSurface.minU)) {
                singleOpeningSurface = candidate;
            }
        }
    }
    const drainagePositions = [];
    const eavesRuns = [];
    let entranceCandidate = null;
    for (const surface of facadeSurfaces) {
        const widthM = surface.maxU - surface.minU;
        // The wall's head is where a gutter hangs. The storeyed head is where the
        // windows stop: on a gable end the two differ by the whole roof triangle.
        const wallTopM = surface.maxV;
        const headM = getFacadeHeadHeight(surface);
        const exposure = classifyFacadeExposure(
            buildContext,
            facadeObjectKey,
            surface,
            vCount > 0 ? { x: buildingCenterX, z: buildingCenterZ } : null,
        );
        // A gutter rides the wall head, so it needs the same outward side the
        // AO skirts resolve: the canonicalised plane normal has no orientation
        // of its own until it is asked which way the footprint centre lies.
        if (wantsGutters && exposure.openings && eavesSurfaces.has(surface)) {
            const uMid = (surface.minU + surface.maxU) / 2;
            const mx = surface.d * surface.nx + uMid * surface.tx;
            const mz = surface.d * surface.nz + uMid * surface.tz;
            const flip = (surface.nx * (mx - buildingCenterX)
                + surface.nz * (mz - buildingCenterZ)) < 0 ? -1 : 1;
            const run = {
                originX: surface.d * surface.nx + surface.minU * surface.tx,
                originZ: surface.d * surface.nz + surface.minU * surface.tz,
                ux: surface.tx,
                uz: surface.tz,
                nx: surface.nx * flip,
                nz: surface.nz * flip,
                width: widthM,
                headY: wallTopM,
            };
            pushEavesGutter(drainagePositions, run);
            eavesRuns.push(run);
        }
        const openingsAllowedBySize = footprintM2 >= FACADE_MIN_OPENINGS_FOOTPRINT_M2
            && (singleOpeningSurface == null || surface === singleOpeningSurface);
        if (openingsAllowedBySize && exposure.openings && widthM >= FACADE_MIN_FACE_W_M && headM > 2.5 && surface.minV < 1.5) {
            // Regions of this wall that a TALLER coplanar wall (usually the
            // main building, when this surface belongs to an annex re-carrying
            // its street wall) already covers. Stored on the surface so the
            // late passage-repaint recomputes the same mask.
            surface.coveredByTallerRects = tallerWallCoverageRects(
                buildContext && buildContext.sharedWallIndex,
                { nx: surface.nx, nz: surface.nz, d: surface.d,
                  interiorSide: surface.interiorSide,
                  uMin: surface.minU, uMax: surface.maxU,
                  vMin: surface.minV, vMax: surface.maxV },
                sharedWallKey,
            );
            const floors = floorsForHeight(headM);
            const bays = surface === singleOpeningSurface
                ? 1
                : Math.max(1, Math.round(widthM / FACADE_BAY_M));
            // Windows are suppressed below the height a neighbour buries this wall to,
            // not across the whole wall: a tall building against a low neighbour keeps
            // the storeys above the neighbour's roof.
            //
            // A curtain wall needs no such mask: it is a continuous skin, and a
            // glazed panel cut by a roofline is what one actually looks like.
            let openingMask = null;
            if (!glassTower) {
                const coverageIterator = prepareFacadeCoverageIndexCooperative(surface);
                let coverageStep = coverageIterator.next();
                while (!coverageStep.done) {
                    yield { ...coverageStep.value, objectId };
                    coverageStep = coverageIterator.next();
                }
                openingMask = getFacadeOpeningMask(
                    surface,
                    floors,
                    bays,
                    exposure.coveredHeightM,
                    headM,
                );
            }
            // Nothing survived the neighbour and the wall silhouette — no overlay at all.
            if (!glassTower && openingMask !== null && !openingMask.includes('1')) {
                yield { phase: 'facade-surface', objectId };
                continue;
            }
            const facadeSource = facadeOverlayDescriptor(
                featureObjectId,
                floors,
                bays,
                openingMask,
                exposure.storefronts,
                glassTower,
            );
            if (exposure.storefronts) {
                const styleIdx = getFacadeStyleIndex(featureObjectId, glassTower);
                const bayTypes = getGroundFloorBayTypes(styleIdx, bays, true);
                const entranceBay = bayTypes.indexOf('entrance');
                const maskIndex = (floors - 1) * bays + entranceBay;
                const entranceVisible = entranceBay >= 0
                    && (openingMask == null || openingMask[maskIndex] !== '0');
                if (entranceVisible && (!entranceCandidate || widthM > entranceCandidate.widthM)) {
                    const doorU = surface.minU + widthM * (entranceBay + 0.5) / bays;
                    const wallX = surface.d * surface.nx + doorU * surface.tx;
                    const wallZ = surface.d * surface.nz + doorU * surface.tz;
                    const outwardSign = surface.nx * (wallX - buildingCenterX)
                        + surface.nz * (wallZ - buildingCenterZ) < 0 ? -1 : 1;
                    const normalX = surface.nx * outwardSign;
                    const normalZ = surface.nz * outwardSign;
                    const bayWidthM = widthM / bays;
                    entranceCandidate = {
                        widthM,
                        x: wallX + normalX * 0.45,
                        y: Math.max(0, surface.minV),
                        z: wallZ + normalZ * 0.45,
                        wallX,
                        wallZ,
                        normalX,
                        normalZ,
                        doorWidthM: Math.max(0.9, Math.min(1.8, bayWidthM * 0.46)),
                        doorHeightM: Math.max(2.2, Math.min(3.2, FACADE_GROUND_M * 0.82)),
                    };
                }
            }
            let batch = facadeBatches.get(facadeSource.key);
            if (!batch) {
                // Geometry preparation does not need a texture. Decide whether
                // a source is needed only when this detached mesh is built.
                batch = { facadeSource, positions: [], uv: [], segments: [] };
                facadeBatches.set(facadeSource.key, batch);
            }
            const segmentVertexStart = batch.positions.length / 3;
            // Reuse the exact source-wall triangles for the additive opening
            // texture. A physically displaced flat quad can intersect a
            // slightly warped wall, land on the wrong side of a concave
            // footprint, or enter a courtyard-passage discard volume while
            // its wall does not. Identical geometry plus polygonOffset keeps
            // the overlay visible without changing or replacing the base wall.
            // Clipped at the eaves, so the roof triangle above a gable end keeps
            // its plaster and no window is stretched up into it. Clipping the
            // source triangles (rather than substituting a quad) keeps every
            // overlay vertex exactly on the wall it is painting.
            const overlayTriangles = wallTopM - headM > 0.01
                ? surface.worldTriangles.flatMap((t) => clipTriangleBelowY(t, headM))
                : surface.worldTriangles;
            for (const triangle of overlayTriangles) {
                for (const point of triangle) {
                    const u = point[0] * surface.tx + point[2] * surface.tz;
                    batch.positions.push(point[0], point[1], point[2]);
                    batch.uv.push(
                        (u - surface.minU) / widthM,
                        point[1] / headM,
                    );
                }
            }
            // Everything a late re-mask needs, per surface segment: a slim
            // surface copy (no worldTriangles — the vertex data lives in the
            // mesh) plus the layout params. See repaintOverlayMeshForPassages.
            batch.segments.push({
                vertexStart: segmentVertexStart,
                vertexCount: batch.positions.length / 3 - segmentVertexStart,
                surface: {
                    nx: surface.nx, nz: surface.nz, d: surface.d,
                    tx: surface.tx, tz: surface.tz,
                    minU: surface.minU, maxU: surface.maxU, maxV: surface.maxV,
                    triangles: surface.triangles,
                    coveredByTallerRects: surface.coveredByTallerRects,
                },
                floors,
                bays,
                coveredHeightM: exposure.coveredHeightM,
                headM,
                storefronts: exposure.storefronts,
                glassTower,
            });
        }
        yield { phase: 'facade-surface', objectId };
    }
    transaction.footprint = {
        objectId: featureObjectId,
        faces: footprintFaces,
        center: vCount > 0 ? { x: buildingCenterX, z: buildingCenterZ } : null,
        tileKey,
        // Cornice height above the base (staged-local Y), so the walker's
        // walls stop at the roof line instead of assuming 24 m.
        wallTopM: maxWallY > 1 ? maxWallY : maxBuildingY,
        renderedBounds: Number.isFinite(footprintMinX) ? {
            minX: footprintMinX,
            maxX: footprintMaxX,
            minZ: footprintMinZ,
            maxZ: footprintMaxZ,
        } : null,
    };
    // Survey/GDI walls are authored relative to z_min and the whole staged
    // group is lifted by foundationLiftY only when it is published. Use the
    // server's closed survey footprint for the skirt: inferring a perimeter
    // from separate wall polygons left dangling panels whenever even one wall
    // face was warped or absent. Older payloads without properties.footprint
    // retain that wall-face recovery. Build in staged-local Y; publish() then
    // applies the shared lift exactly once to walls, roofs, and foundation.
    if (transaction.footprint.center && Number.isFinite(foundationLiftY)) {
        // Foundation skirts are derived from both terrain and the engineered
        // road surface beside a facade. A streamed road revision becomes
        // visible before its replacement indexes are atomically published;
        // querying sceneYAtLocal in that interval synchronously built the
        // entire road model inside this nominally cooperative stage (four
        // measured buildings took 153-174 ms each). Keep this detached
        // transaction pending until roads publish, then sample that generation.
        // Only a pending change that reaches this footprint is worth the
        // wait: managed reads are consistent, and a coordinated chain after a
        // move otherwise holds every building for minutes (see
        // pendingRoadFormationChangeTouches).
        const foundationBounds = buildingVisibilityBounds(feature);
        while (pendingRoadFormationChangeTouches(terrainReference?.roadFormation,
            foundationBounds, FOUNDATION_FORMATION_REACH_M)) {
            // Bounded, and shared with every other building waiting on the
            // same change: past the allowance the skirt builds on the
            // published generation and the ground check refines it when the
            // formation publishes.
            if (roadFormationWaitExpired(formationWaitStartMs(terrainReference?.roadFormation), performance.now(),
                foundationFormationWaitAllowanceMs(getFrameChunkWorkMotionState()))) break;
            yield { phase: 'foundation-formation-wait', objectId };
        }
        const foundationSegmentsIterator = foundationSegmentsForMeshFeatureCooperative(
            feature,
            (lon, lat) => ({
                x: (lon - aLon) * SCALE_LON,
                z: -(lat - aLat) * SCALE_LAT,
            }),
            footprintFaces,
            transaction.footprint.center,
        );
        let foundationSegmentsStep = foundationSegmentsIterator.next();
        while (!foundationSegmentsStep.done) {
            yield { ...foundationSegmentsStep.value, objectId };
            foundationSegmentsStep = foundationSegmentsIterator.next();
        }
        const foundationSegments = foundationSegmentsStep.value;
        const foundationIterator = createFoundationSkirtPositionsIterator(
            foundationSegments,
            foundationLiftY,
            buildContext?.groundDependencies,
        );
        let foundationMesh = null;
        if (foundationIterator) {
            let foundationStep = foundationIterator.next();
            while (!foundationStep.done) {
                yield { ...foundationStep.value, objectId };
                foundationStep = foundationIterator.next();
            }
            const foundationBufferIterator = prepareFoundationSkirtBuffersCooperative(
                foundationStep.value,
                {
                    positionYOffsetY: -foundationLiftY,
                    consumeSource: true,
                },
            );
            let foundationBufferStep = foundationBufferIterator.next();
            while (!foundationBufferStep.done) {
                yield { ...foundationBufferStep.value, objectId };
                foundationBufferStep = foundationBufferIterator.next();
            }
            foundationMesh = createFoundationSkirtMesh(
                foundationSegments,
                foundationLiftY,
                tileKey,
                featureObjectId,
                {
                    bufferData: foundationBufferStep.value,
                },
            );
        }
        if (foundationMesh) {
            targetGroup.add(foundationMesh);
            yield { phase: 'foundation-skirt-mesh', objectId };
        }
    }
    if (entranceCandidate) {
        transaction.entrance = {
            objectId: featureObjectId,
            entrance: entranceCandidate,
            tileKey,
        };
    }
    // Publish the immutable base geometry before any additive openings.
    if (blankWallPositions.length > 0) {
        const materialIterator = getBuildingMaterialCooperative(useClass, featureObjectId);
        let materialStep = materialIterator.next();
        while (!materialStep.done) {
            yield { ...materialStep.value, objectId };
            materialStep = materialIterator.next();
        }
        const baseWallMaterial = materialStep.value;
        yield { phase: 'base-wall-material-finalize', objectId };
        const baseWall = addMesh(
            blankWallPositions,
            baseWallMaterial,
            blankWallUVs,
            blankWallNormals,
        );
        baseWall.userData.baseBuildingWall = true;
        yield { phase: 'base-wall-mesh', objectId };
    }
    if (roofPositions.length > 0) {
        const pitchedRoofMaterial = getRoofMaterial(featureObjectId);
        yield { phase: 'pitched-roof-material', objectId };
        const baseRoof = addMesh(
            roofPositions,
            pitchedRoofMaterial,
            roofUVs,
            roofNormals,
        );
        baseRoof.userData.baseBuildingRoof = true;
        yield { phase: 'pitched-roof-mesh', objectId };
    }
    if (flatRoofPositions.length > 0) {
        const flatRoofMaterial = getFlatRoofMaterial(featureObjectId);
        yield { phase: 'flat-roof-material', objectId };
        const flatRoof = addMesh(
            flatRoofPositions,
            flatRoofMaterial,
            flatRoofUVs,
            flatRoofNormals,
        );
        flatRoof.userData.baseBuildingRoof = true;
        flatRoof.userData.flatRoof = true;
        yield { phase: 'flat-roof-mesh', objectId };
    }
    // Logical surfaces stay independent for containment and UV layout, while
    // overlays with the same finished material share one draw call.
    yield* addGdiFacadeOverlayMeshes(facadeBatches, tileKey, featureObjectId, addMesh);
    // One downpipe per building, on its longest eave, at a corner picked from
    // the building's own hash so it never moves when the tile is rebuilt.
    if (eavesRuns.length > 0) {
        const hash = featureObjectId == null ? 0 : hashObjectId(featureObjectId);
        const longest = eavesRuns.reduce((best, run) => (run.width > best.width ? run : best));
        pushDownpipe(drainagePositions, {
            ...longest,
            u: pickDownpipeU(longest.width, hash),
            baseY: 0,
        });
    }
    if (drainagePositions.length > 0) {
        const contributions = buildContext && buildContext.roofDrainageContributions;
        if (contributions) {
            contributions.push({
                positions: drainagePositions,
                baseY: foundationLiftY,
                centroidLatLon: featureCentroidLatLon(feature),
            });
        } else {
            const drainageMesh = buildRoofDrainageMesh(drainagePositions);
            if (drainageMesh) {
                if (tileKey != null) drainageMesh.userData.tileKey = tileKey;
                setPassageAwareMaterial(drainageMesh, getRoofDrainageMaterial());
                targetGroup.add(drainageMesh);
            }
        }
        yield { phase: 'roof-drainage', objectId };
    }
    // Contact-AO skirts along every ground-touching wall. The outward side is
    // resolved per face against the footprint centroid (the canonicalised
    // wall-plane normal has no inherent orientation).
    if (aoFaces.length > 0 && vCount > 0) {
        const aoPos = [], aoCol = [];
        for (let faceIndex = 0; faceIndex < aoFaces.length; faceIndex++) {
            const f = aoFaces[faceIndex];
            const tx = f.nz, tz = -f.nx;   // same tangent frame as describeVerticalWallFace
            const uMid = (f.uMin + f.uMax) / 2;
            const mx = f.d * f.nx + uMid * tx;
            const mz = f.d * f.nz + uMid * tz;
            const flip = (f.nx * (mx - buildingCenterX) + f.nz * (mz - buildingCenterZ)) < 0 ? -1 : 1;
            pushContactAoSkirt(aoPos, aoCol, {
                originX: f.d * f.nx + f.uMin * tx,
                originZ: f.d * f.nz + f.uMin * tz,
                ux: tx, uz: tz,
                nx: f.nx * flip, nz: f.nz * flip,
                width: f.uMax - f.uMin,
                vMin: f.vMin,
            });
            if ((faceIndex + 1) % 16 === 0) {
                yield { phase: 'contact-ao-geometry', objectId };
            }
        }
        if (buildContext && buildContext.contactAoContributions) {
            buildContext.contactAoContributions.push({
                positions: aoPos,
                colors: aoCol,
                baseY: foundationLiftY,
                centroidLatLon: featureCentroidLatLon(feature),
            });
        } else {
            // Defensive fallback for callers that build a feature outside a
            // tile/static chunk job.
            const aoMesh = buildContactAoMesh(aoPos, aoCol);
            if (aoMesh) {
                if (tileKey != null) aoMesh.userData.tileKey = tileKey;
                if (featureObjectId != null) aoMesh.userData.objectId = featureObjectId;
                setPassageAwareMaterial(aoMesh, aoMesh.material);
                targetGroup.add(aoMesh);
            }
        }
        yield { phase: 'contact-ao-finalize', objectId };
    }
    // Real detected windows/doors as source-conforming overlays on the walls.
    if (useRealWindows && vCount > 0) {
        const cx = cxSum / vCount, cz = czSum / vCount;
        // Scale to the cornice (wall top), not the ridge, so windows stay on the
        // facade and never climb onto the roof. Fall back to full height if a
        // building has no classified wall faces.
        const wallH = maxWallY > 1 ? maxWallY : maxBuildingY;
        // Full 3D relief facade from a recognized facade spec (toggle: F). Built
        // ALONGSIDE the window quads / photo so all three can be switched live;
        // when spec mode is on it wins over quads and photo for this building.
        let specSibling = false;
        if (hasFacadeSpec(objectId)) {
            const specGroup = buildFacadeSpecGroup(
                objectId,
                aLat,
                aLon,
                cx,
                cz,
                wallH,
                wallSupportTriangles,
            );
            if (specGroup) {
                specSibling = true;
                if (tileKey != null) specGroup.userData.tileKey = tileKey;
                if (featureObjectId != null) specGroup.userData.objectId = featureObjectId;
                specGroup.userData.facadeSpecRoot = true;
                specGroup.traverse((o) => {
                    if (tileKey != null) o.userData.tileKey = tileKey;
                    // Relief facades sit on walls that get shader-cut inside
                    // passages; cut them with the wall or they span the arch.
                    if (o.isMesh && o.material && !Array.isArray(o.material)) {
                        setPassageAwareMaterial(o, o.material);
                    }
                });
                specGroup.visible = showOpenings && facadeSpecMode;
                targetGroup.add(specGroup);
                yield { phase: 'facade-spec-mesh', objectId };
            }
        }
        for (const m of buildFacadeWindowMeshes(
            objectId,
            aLat,
            aLon,
            cx,
            cz,
            wallH,
            wallSupportTriangles,
        )) {
            if (tileKey != null) m.userData.tileKey = tileKey;
            if (featureObjectId != null) m.userData.objectId = featureObjectId;
            m.userData.facadeWindow = true;
            m.userData.hasSpecSibling = specSibling;
            setPassageAwareMaterial(m, m.material);
            m.visible = showOpenings && !facadePhotoMode && !(facadeSpecMode && specSibling);   // O hides; P photo; F spec
            targetGroup.add(m);
            yield { phase: 'detected-window-mesh', objectId };
        }
        // Experiment: the rectified facade photo glued onto the wall (toggle: P).
        const photo = buildFacadePhotoMesh(objectId, aLat, aLon, cx, cz);
        if (photo) {
            if (tileKey != null) photo.userData.tileKey = tileKey;
            if (featureObjectId != null) photo.userData.objectId = featureObjectId;
            photo.userData.facadePhoto = true;
            photo.userData.hasSpecSibling = specSibling;
            setPassageAwareMaterial(photo, photo.material);
            photo.visible = showOpenings && facadePhotoMode && !(facadeSpecMode && specSibling);
            targetGroup.add(photo);
            yield { phase: 'facade-photo-mesh', objectId };
        }
    }
    yield { phase: 'finalize-staged-building', objectId };
    return 1;
}

function* addGdiFacadeOverlayMeshes(facadeBatches, tileKey, objectId, addMesh) {
    for (const batch of facadeBatches.values()) {
        const binding = getFacadeOverlayBinding(batch.facadeSource, tileKey);
        const mesh = addMesh(batch.positions, binding.material, batch.uv);
        mesh.userData.facadeWindowOverlay = true;
        mesh.userData.overlayRepaint = { objectId, segments: batch.segments, facadeSource: batch.facadeSource };
        rememberFacadeOverlayBinding(mesh, binding);
        // Always visible: these merge into shared aggregates a moment later,
        // and a hidden mesh would be merged and drawn anyway. The O toggle no
        // longer covers procedural overlays (see applyFacadeVisibility).
        mesh.castShadow = false;
        yield { phase: 'facade-overlay-mesh', objectId };
    }
}

function createTransactionalBuildContext(buildContext) {
    if (!buildContext) return null;
    return {
        ...buildContext,
        wallFaceRegistry: new Set(buildContext.wallFaceRegistry || []),
        contactAoContributions: [],
        roofDrainageContributions: [],
        streetFacingStats: {
            matched: 0,
            fallback: 0,
            fallbackObjects: new Set(),
        },
    };
}

function mergeTransactionalBuildContext(buildContext, transactionalContext) {
    if (!buildContext || !transactionalContext) return;
    for (const signature of transactionalContext.wallFaceRegistry || []) {
        buildContext.wallFaceRegistry.add(signature);
    }
    buildContext.contactAoContributions.push(
        ...(transactionalContext.contactAoContributions || []),
    );
    buildContext.roofDrainageContributions.push(
        ...(transactionalContext.roofDrainageContributions || []),
    );
    const sourceStats = transactionalContext.streetFacingStats;
    const targetStats = buildContext.streetFacingStats;
    if (sourceStats && targetStats) {
        targetStats.matched += sourceStats.matched;
        targetStats.fallback += sourceStats.fallback;
        for (const objectKey of sourceStats.fallbackObjects) {
            targetStats.fallbackObjects.add(objectKey);
        }
    }
}

function createGdiBuildingBuildTask(feature, tileKey, buildContext = null) {
    const objectId = feature?.properties?.object_id;
    const reservation = {};
    const group = new THREE.Group();
    group.name = 'StagedGdiBuilding';
    const transactionalContext = createTransactionalBuildContext(buildContext);
    const transaction = {
        group,
        footprint: null,
        entrance: null,
    };
    const centroid = featureCentroidLatLon(feature);
    let reserved = false;
    let published = false;

    function releaseReservation() {
        if (!reserved || objectId == null) return;
        if (reservedBuildingIds.get(objectId) === reservation) {
            reservedBuildingIds.delete(objectId);
        }
        reserved = false;
    }

    function discard() {
        releaseReservation();
        if (!published) disposeGroup(group);
    }

    function* build() {
        if (isBlockedBuildingObjectId(objectId)) return 0;
        if (!feature?.geometry || feature.geometry.type !== 'MultiPolygon') return 0;
        if (isFeatureMaskedByProposalBuildings(feature)) return 0;
        if (objectId != null) {
            while (reservedBuildingIds.has(objectId)
                && reservedBuildingIds.get(objectId) !== reservation) {
                yield { phase: 'reservation-wait', objectId };
            }
            if (loadedBuildingIds.has(objectId)) return 0;
            reservedBuildingIds.set(objectId, reservation);
            reserved = true;
        }
        return yield* stageBuildingFeatureGdi(
            feature,
            anchorLat,
            anchorLon,
            tileKey,
            transactionalContext,
            transaction,
        );
    }

    function publish(added) {
        if (!(added > 0)
            || !buildingsGroup
            || isFeatureMaskedByProposalBuildings(feature)
            || (objectId != null && loadedBuildingIds.has(objectId))) {
            discard();
            return 0;
        }

        const zMin = Number(feature?.properties?.z_min);
        const baseY = terrainReference && Number.isFinite(zMin)
            ? terrainReference.absoluteToSceneY(zMin)
            : 0;
        for (const child of group.children) {
            child.position.y += baseY;
            if (centroid) child.userData.centroidLatLon = centroid;
        }

        // All potentially expensive construction has finished in the detached
        // group. The following synchronous commit has no render opportunity in
        // the middle, so LOD ownership, collision metadata, auxiliary batches,
        // and scene meshes become visible as one transaction.
        noteBuildingGroundCoverage(feature);
        if (transaction.footprint) {
            const wallTopM = transaction.footprint.wallTopM;
            registerBuildingFootprint(
                transaction.footprint.objectId,
                transaction.footprint.faces,
                transaction.footprint.center,
                transaction.footprint.tileKey,
                transaction.footprint.renderedBounds,
                baseY,
                Number.isFinite(wallTopM) && wallTopM > 0 ? baseY + wallTopM : null,
            );
        }
        if (transaction.entrance) {
            registerBuildingEntrance(
                transaction.entrance.objectId,
                transaction.entrance.entrance,
                transaction.entrance.tileKey,
            );
        }
        mergeTransactionalBuildContext(buildContext, transactionalContext);
        const mergeStartIndex = buildingsGroup.children.length;
        for (const child of [...group.children]) buildingsGroup.add(child);
        // Merge the base surfaces (walls, pitched and flat roofs) into the
        // shared regional aggregates; window overlays and anything else that
        // cannot share a bucket stay behind as individual meshes.
        captureBuildingMeshesForBatching(feature, tileKey, mergeStartIndex, 'gdi');
        hideTileReplacementChildren(tileKey, mergeStartIndex);
        // Register entities AFTER the merge, over the survivors only — exactly
        // the order the Overture path uses. Registering first would leave the
        // registry holding meshes the merge has just removed from the scene,
        // and a click would resolve to a building that is no longer drawn.
        // Merged geometry keeps its identity through the batcher's per-owner
        // face ranges instead (registerAggregateEntityRanges).
        for (let i = mergeStartIndex; i < buildingsGroup.children.length; i++) {
            registerBuildingEntityTree(buildingsGroup.children[i], feature, 'gdi');
        }
        if (objectId != null) {
            loadedBuildingIds.add(objectId);
            recordTileBuilding(tileKey, objectId);
        }
        published = true;
        releaseReservation();
        return added;
    }

    return createCooperativeBuildTask({
        iterator: build,
        publish,
        discard,
        onPhase: noteBuildingBuildPhase,
    });
}

function runBuildingBuildTaskToCompletion(task) {
    let outcome;
    do {
        outcome = task.step();
    } while (!outcome.done);
    return outcome.result || 0;
}

function addOvertureFacadeMeshes(polygon, height, objectId, aLat, aLon, tileKey) {
    const ring = polygon.coordinates?.[0];
    const batches = buildOvertureFacadeBatches(
        polygon,
        height,
        aLon,
        aLat,
        { minFaceWidthM: FACADE_MIN_FACE_W_M, bayPitchM: FACADE_BAY_M },
    );
    if (batches.length === 0) return;
    const floors = floorsForHeight(height);
    const foundationY = terrainReference && ring
        ? terrainReference.evidenceFoundationSceneY(ring)
        : 0;
    for (const batch of batches) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
        geometry.computeVertexNormals();
        // Courtyard-facing walls get plain windows and entrances, never the
        // street's shopfront glazing.
        const facadeSource = facadeOverlayDescriptor(
            objectId, floors, batch.bays, null, /* storefronts */ !batch.courtyard);
        const binding = getFacadeOverlayBinding(facadeSource, tileKey);
        const mesh = new THREE.Mesh(geometry, binding.material);
        mesh.position.y = foundationY;
        mesh.userData.facadeWindowOverlay = true;
        mesh.userData.facadeCloseSegments = [{
            floors,
            bays: batch.bays,
            openingMask: null,
            storefronts: !batch.courtyard,
            glassTower: false,
        }];
        if (objectId != null) mesh.userData.objectId = objectId;
        mesh.visible = showOpenings;
        mesh.castShadow = false;
        setPassageAwareMaterial(mesh, binding.material);
        rememberFacadeOverlayBinding(mesh, binding);
        buildingsGroup.add(mesh);
    }
}

function addLowRiseStoneFacadeMesh(polygon, height, objectId, aLat, aLon, material) {
    if (!material) return;
    const wallData = buildFootprintWallGeometry(polygon, height, aLon, aLat);
    if (!wallData) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(wallData.positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(wallData.uvs, 2));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    const ring = polygon.coordinates?.[0];
    mesh.position.y = terrainReference && ring
        ? terrainReference.evidenceFoundationSceneY(ring)
        : 0;
    mesh.name = 'SplitLowRiseDalmatianStoneFacade';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.dalmatianStoneFacade = true;
    if (objectId != null) mesh.userData.objectId = objectId;
    setPassageAwareMaterial(mesh, material);
    buildingsGroup.add(mesh);
}

function buildMetricTriangleUvs(positions) {
    const uvs = [];
    for (let offset = 0; offset < positions.length; offset += 9) {
        const triangle = [0, 3, 6].map((index) => ({
            x: positions[offset + index],
            y: positions[offset + index + 1],
            z: positions[offset + index + 2],
        }));
        const xRange = Math.max(...triangle.map((point) => point.x)) - Math.min(...triangle.map((point) => point.x));
        const zRange = Math.max(...triangle.map((point) => point.z)) - Math.min(...triangle.map((point) => point.z));
        for (const point of triangle) uvs.push(xRange >= zRange ? point.x : point.z, point.y);
    }
    return uvs;
}

// ─── Merged Overture building aggregates ────────────────────────────────────
// An Overture building is 3-6 meshes (prism, foundation skirt, stone facade,
// roof, gables) drawing from deliberately SHARED material families — the wall
// palette is capped at 60 materials precisely so batching would stay possible.
// A census of a project-96 ride counted 6,795 of these meshes, the single
// biggest per-object owner in the scene, and per-object cost is the measured
// render floor. Same cure as roads: meshes built per building are decomposed
// into an owner-keyed batcher and the scene holds one merged mesh per bucket.
//
// Buckets are keyed by material + render flags + attribute schema + the TILE,
// because here the tile is the lifecycle: buildings dedupe globally by id, a
// building belongs to the tile that first built it, and that tile's eviction
// removes it (removeTile filters by userData.tileKey — which the aggregates
// carry too). Tile eviction therefore just DROPS the tile's buckets whole; no
// re-assembly, no copying. The schema fingerprint is in the key because two
// meshes sharing a material may legitimately differ in attributes (gables
// carry uv only when a stone facade material exists).
//
// Owners are individual buildings, so the assembly's ranges give per-building
// entity picking on the merged mesh — the same contract roads use.
const overtureBatcher = createGeometryBatcher();
// Holds each completed tile's "detailed coverage is up" announcement until the
// merged meshes covering it have actually assembled, so assembly can be
// budgeted instead of run synchronously at tile completion.
const aggregateGate = createAggregateGate();
// How much of the old region-wide re-assembly was redundant. `regionQueued` is
// what the region-wide rule would have merged; `actuallyDirty` is what changed.
// Read it with __s3dAggregateWaste() during a walk.
const aggregateWaste = { regionQueued: 0, actuallyDirty: 0 };
// Features seen per source ('gdi', 'lidar', 'landmark', 'overture'), plus how
// many stated their own material. Counted at intake so it reflects what the
// endpoint actually delivered, not what survived the build.
const featureSourceCounts = { __withMaterial: 0 };
if (typeof window !== 'undefined') {
    // What the buildings layer is actually drawing, by source and by material.
    //
    // Render here costs ~7.7 microseconds per DRAW CALL and is near-independent
    // of triangle count, so the numbers that matter are OBJECT and MATERIAL
    // counts, not geometry. This is the instrument for that: how many features
    // arrived from each source, how many stated their own material, and how
    // many distinct materials and aggregate meshes came out the other side.
    //
    // Read it with __s3dBuildingDraw() during a walk.
    window.__s3dBuildingDraw = () => {
        const bySource = {};
        for (const [key, count] of Object.entries(featureSourceCounts)) bySource[key] = count;
        const materials = new Set();
        let aggregates = 0;
        let aggregateRoots = 0;
        let loneMeshes = 0;
        if (buildingsGroup) {
            for (const child of buildingsGroup.children) {
                if (child.userData?.overtureAggregate) {
                    aggregateRoots += 1;
                    child.traverse((object) => {
                        if (!object.isMesh) return;
                        aggregates += 1;
                        const material = object.material;
                        (Array.isArray(material) ? material : [material])
                            .forEach((entry) => entry && materials.add(entry.uuid));
                    });
                    continue;
                }
                if (!child.isMesh) continue;
                const material = child.material;
                (Array.isArray(material) ? material : [material])
                    .forEach((entry) => entry && materials.add(entry.uuid));
                loneMeshes += 1;
            }
        }
        return {
            featuresBySource: bySource,
            // ARRIVED, not drawn. This counter fires at tile intake, before the
            // pipeline is even chosen, so it says nothing about how a feature
            // was rendered — reading it as proof that stated materials were
            // honoured is exactly how landmarks shipped painted in stucco.
            // statedMaterialsDrawn is the one that can tell you.
            featuresStatingMaterialArrived: featureSourceCounts.__withMaterial || 0,
            statedMaterialsDrawn,
            // A bucket whose material expects per-vertex colour but whose parts
            // carry none renders BLACK; anything above zero here is a defect.
            batchColorMismatches,
            objects: aggregates + loneMeshes,
            aggregates,
            aggregateRoots,
            loneMeshes,
            distinctMaterials: materials.size,
            facadeAtlas: {
                activeGroups: facadeAtlasGroups.size,
                activePages: facadeAtlasStats.pagesCreated - facadeAtlasStats.pagesDisposed,
                resources: facadeAtlasResources.snapshot(),
                occupancy: getFacadeAtlasOccupancySnapshot(),
                // Historical counters; occupancy above is the current set.
                ...facadeAtlasStats,
            },
            aggregatePipeline: getBuildingAggregatePipelineSnapshot(),
        };
    };
    window.__s3dAggregateWaste = () => ({
        ...aggregateWaste,
        redundancyFactor: aggregateWaste.actuallyDirty > 0
            ? +(aggregateWaste.regionQueued / aggregateWaste.actuallyDirty).toFixed(2)
            : null,
    });
}
// Drawn-as-modelled tally, and the defect counter that guards it. Both are
// read by __s3dBuildingDraw(); see the note there on why an intake count is
// not evidence that anything was drawn.
let statedMaterialsDrawn = 0;
let batchColorMismatches = 0;
const overtureBucketDescriptors = new Map(); // bucketKey → material + flags
const overtureAggregates = new Map();        // bucketKey → {mesh, unregisterEntities}
const overtureAggregateEntityUnregister = new WeakMap();
const overtureTileBuckets = new Map();       // region → Set<bucketKey>
const overtureScopeOwners = new Map();       // tileScope → Set<ownerKey>
let overtureMaterialIds = new WeakMap();
let nextOvertureMaterialId = 0;
const overtureDirtyTiles = new Set();

// The static radius loader has no tile; its whole load shares one scope and is
// torn down by clearBuildings rather than removeTile.
const overtureTileScope = (tileKey) => String(tileKey ?? 'radius');

function buildingAggregatePublicationKey(bucketKey) {
    return `buildings:aggregate:${String(bucketKey)}`;
}

function disposeOvertureAggregateMesh(mesh) {
    if (!mesh) return;
    const unregisterEntities = overtureAggregateEntityUnregister.get(mesh);
    if (unregisterEntities) unregisterEntities();
    overtureAggregateEntityUnregister.delete(mesh);
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry?.dispose?.();
}

function commitOvertureAggregate(bucketKey, mesh, assembled) {
    let unregisterEntities = null;
    if (assembled.ranges.some(range => range.entity)) {
        unregisterEntities = registerAggregateEntityRanges(mesh, assembled.ranges);
        overtureAggregateEntityUnregister.set(mesh, unregisterEntities);
    }
    overtureAggregates.set(bucketKey, { mesh, unregisterEntities });
    publishGeometryMemory(mesh.geometry);
}

function forgetEmptyOvertureBucket(bucketKey) {
    overtureAggregates.delete(bucketKey);
    overtureBucketDescriptors.get(bucketKey)?.releaseFacadeMaterial?.();
    overtureBucketDescriptors.delete(bucketKey);
    // The bucket is region-scoped; drop it from whichever region set holds it
    // and forget an emptied region.
    for (const [region, set] of overtureTileBuckets) {
        if (set.delete(bucketKey) && set.size === 0) {
            overtureTileBuckets.delete(region);
        }
    }
    // Atlas ownership is finer than a region. Staged replacements and an old
    // mesh being retired may still use this page after its last bucket leaves.
    // The bounded resource drainer reclaims it only after those leases end.
}

function clearOvertureAggregate(bucketKey, generation) {
    const previous = overtureAggregates.get(bucketKey) || null;
    const commit = () => forgetEmptyOvertureBucket(bucketKey);
    if (surfacePublications) {
        surfacePublications.begin({
            key: buildingAggregatePublicationKey(bucketKey),
            generation,
            parent: buildingsGroup,
            retire: (_context, root) => disposeOvertureAggregateMesh(root),
        }).clear({ commit });
        publishPendingOverlayReplacements(bucketKey);
        return;
    }
    commit();
    if (previous) disposeOvertureAggregateMesh(previous.mesh);
    publishPendingOverlayReplacements(bucketKey);
}

// Buckets aggregate a REGION of 2×2 tiles, not a single tile: Split measured
// 2,237 aggregates for 3,222 buildings with per-tile buckets — the 60-material
// wall palette × schema variants splintered every tile into near-singletons.
// Regions quarter the bucket count; the price is that a tile's eviction can no
// longer drop whole buckets and instead removes the tile's OWNERS from the
// region's buckets and re-assembles them (small: a region's content).
const OVERTURE_REGION_TILES = 2;
function overtureRegionForScope(scope) {
    if (scope === 'radius') return 'radius';
    const [tx, tz] = String(scope).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return scope;
    return `${Math.floor(tx / OVERTURE_REGION_TILES)}_${Math.floor(tz / OVERTURE_REGION_TILES)}`;
}

// Per-building colour moves into a vertex-colour attribute so whole MATERIAL
// FAMILIES — pitched roofs (ROOF_PALETTE × 64 jitter buckets) and Overture
// walls (12 palette shades × 5 wear textures) — collapse into one white
// vertexColors material per texture. diffuse = color × vertexColor × map makes
// the day pixels identical. Night needed one more step for walls: their glow
// is emissive = NIGHT_HEX × mat.color, and vertex colours do NOT reach the
// emissive term — a naive white family would flatten every facade to one
// uniform glow after dark, the exact regression the night-mode comment above
// warns about. The family material therefore patches one line into the
// fragment shader (totalEmissiveRadiance *= vColor) so the glow follows the
// vertex colour exactly as it used to follow mat.color.
let overtureColorFamilyByBase = new WeakMap();   // base material → {material, color} | null

// Facade window overlays used to be excluded from merging: keyed by the
// building's 64-value jitter bucket, their materials were near-unique, and
// merging produced 1,202 single-building aggregates on a Split walk — all
// machinery, no batching.
//
// That key was wrong (nothing in the material depended on the bucket; it varies
// by STYLE, of which there are 6). With it fixed, 4,049 overlay meshes share 785
// materials — 5.2 buildings per material — so a bucket is now a real batch and
// the exclusion has been removed. Overlays are ~2,200 of the frame's draw calls,
// and render is ~7.7 microseconds per call, so this is where the time is.
//
// Nothing is excluded today. The hook stays because the reasoning is not
// hypothetical: a material family that ends up near-unique per building costs
// more in merge machinery than it saves, and this is where it would be named.
let overtureExcludedByBase = new WeakMap();
function overtureMaterialExcluded(base) {
    if (overtureExcludedByBase.has(base)) return overtureExcludedByBase.get(base);
    const excluded = false;
    overtureExcludedByBase.set(base, excluded);
    return excluded;
}

// Procedural opening overlays used to keep one material per exact painted
// facade (style × floors × bays × silhouette mask). The pixels were correct,
// but the late Zagreb tram scene consequently published 756 texture-bound
// aggregate meshes. Put those immutable canvases into region-local pages and
// remap only the aggregate UV copy. Close LOD and passage repaint records keep
// their original 0..1 UVs and therefore retain their existing exact textures.
//
// The high profile's 192 px cap is deliberate: these are ordinary/distant overlays.
// Medium/low use smaller entries; their limits are pinned until the next complete
// world reset, never changed beneath live UVs. Source/repair textures stay exact. The
// nearby controller replaces selected facades with a separately bounded
// high-resolution texture. Keep the backing page power-of-two and bounded:
// measured 768 px CanvasTexture updates once caused three consecutive 63–68 ms
// render frames on the Zagreb tram as the driver uploaded/mipmapped each page.
// Page count, not page size, is what the frame pays for every frame: at 512 px
// a dense Zagreb region needed 16 pages per family, and ~170 of 474 visible
// building meshes were one-material atlas pages of 30–120 triangles
// (2026-09-23). Re-measured the same day on M1 Pro/ANGLE Metal, a full
// 1024 px canvas page upload plus mipmaps took ~1.2 ms (2048 px: ~2 ms), so
// 1024 px quarters those draws while each transfer stays small and a sparse
// region still reserves only 4 MB per page.
const FACADE_ATLAS_PAGE_SIZE = 1024;
const FACADE_ATLAS_PADDING = 2;
let buildingQualityProfile = STATION3D_QUALITY_PROFILES.high;
const facadeAtlasGroups = new Map(); // `${region}|punched|glass` -> layout/pages
const facadeAtlasMaterials = new Set();
const facadeAtlasPageByMaterial = new WeakMap();
// No warm allowance for pages: live borrowers already preserve reusable pixels.
// This accounts for atlas canvases + estimated mip storage, not all world RAM.
const facadeAtlasResources = createOwnedResourceCache({ maxIdleBytes: 0 });
const facadeAtlasPaintPages = [];
let facadeAtlasPaintJob = null;
const facadeAtlasStats = {
    sourceReuses: 0,
    entries: 0,
    pagesCreated: 0,
    pagesDisposed: 0,
    pageUpdates: 0,
    sourcePixels: 0,
    atlasEntryPixels: 0,
    retiredEntries: 0,
    retiredContentTexels: 0,
    retiredReservedTexels: 0,
    retiredCapacityTexels: 0,
};

function getFacadeAtlasOccupancySnapshot({ includePages = false } = {}) {
    // These are allocated rectangles, not a claim that each facade still has
    // a visible borrower. Slots intentionally survive until their entire page
    // retires. Unallocated texels are not independently reclaimable RAM.
    const totals = {
        activeGroups: facadeAtlasGroups.size,
        activePages: 0,
        allocatedEntries: 0,
        capacityTexels: 0,
        allocatedContentTexels: 0,
        reservedTexels: 0,
        sourceTexels: 0,
        gutterTexels: 0,
        unallocatedTexels: 0,
        shelfWasteTexels: 0,
    };
    const resources = facadeAtlasResources.snapshot({ includeEntries: includePages });
    const ownership = new Map((resources.entryDetails || []).map(entry => [entry.key, entry]));
    const pageDetails = [];
    const fillHistogram = { below25Percent: 0, below50Percent: 0, below75Percent: 0, atLeast75Percent: 0 };
    for (const group of facadeAtlasGroups.values()) {
        const stats = group.layout.stats({ includePages });
        totals.activePages += stats.pages;
        totals.allocatedEntries += stats.entries;
        for (const key of [
            'capacityTexels', 'allocatedContentTexels', 'reservedTexels', 'sourceTexels',
            'gutterTexels', 'unallocatedTexels', 'shelfWasteTexels',
        ]) totals[key] += stats[key];
        for (const allocation of stats.pageDetails || []) {
            const key = `${group.key}|${allocation.pageIndex}`;
            const page = group.pages[allocation.pageIndex];
            const resource = ownership.get(key);
            pageDetails.push({
                key, region: group.region, family: group.family, ...allocation,
                resourcePresent: !!resource,
                references: resource?.references ?? null,
                owners: resource?.owners || {},
                idle: resource?.idle ?? null,
                estimatedCanvasBytes: resource?.estimatedCanvasBytes ?? null,
                estimatedTextureBytes: resource?.estimatedTextureBytes ?? null,
                pendingPaints: page ? page.pendingPaints.length - page.paintCursor : null,
                paintQueued: page?.paintQueued ?? null,
                paintFailed: page?.paintFailed ?? null,
            });
            const ratio = allocation.reservedFillRatio;
            fillHistogram[ratio < 0.25 ? 'below25Percent'
                : ratio < 0.5 ? 'below50Percent'
                    : ratio < 0.75 ? 'below75Percent' : 'atLeast75Percent'] += 1;
        }
    }
    return {
        ...totals,
        allocationScope: 'retained-page rectangles; individual slot liveness is not tracked',
        contentFillRatio: totals.capacityTexels > 0
            ? totals.allocatedContentTexels / totals.capacityTexels : 0,
        reservedFillRatio: totals.capacityTexels > 0
            ? totals.reservedTexels / totals.capacityTexels : 0,
        estimatedCanvasBytes: resources.estimatedCanvasBytes,
        estimatedTextureBytes: resources.estimatedTextureBytes,
        pinnedBytes: resources.pinnedBytes,
        idleBytes: resources.idleBytes,
        ...(includePages ? { fillHistogram, pageDetails } : {}),
    };
}

// Metadata only: no hidden source Material/Texture lease. Mesh geometry pins
// the actual page through setPassageAwareMaterial, even while detached.
const facadeOverlayBindings = new WeakMap();

function getFacadeOverlayBinding(source, tileKey) {
    const region = overtureRegionForScope(overtureTileScope(tileKey));
    const family = source.glass ? 'glass' : 'punched';
    const group = facadeAtlasGroups.get(`${region}|${family}`);
    const slot = group?.layout.get(source.key);
    const page = slot && group.pages[slot.pageIndex];
    if (page && !page.disposed && !page.paintFailed) {
        facadeAtlasStats.sourceReuses += 1;
        return { source, region, material: page.material, slot, page };
    }
    // First use / retired region / standalone repair still uses the same
    // ordinary diffuse + emissive source and the existing atlas paint queue.
    const material = getFacadeOverlayMaterial(
        source.objectId, source.floors, source.bays, source.openingMask,
        source.storefronts, source.glass, source,
    );
    return { source, region, material, slot: null };
}

function rememberFacadeOverlayBinding(mesh, binding) {
    const sourceUvs = mesh.geometry.getAttribute('uv').array;
    if (binding.slot) {
        mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(
            remapFacadeAtlasUvs(sourceUvs, binding.slot), 2,
        ));
    }
    facadeOverlayBindings.set(mesh, { ...binding, sourceUvs });
}

function restoreFacadeOverlaySource(mesh) {
    const binding = facadeOverlayBindings.get(mesh);
    if (!binding?.slot) return;
    const source = binding.source;
    const material = getFacadeOverlayMaterial(
        source.objectId, source.floors, source.bays, source.openingMask,
        source.storefronts, source.glass, source,
    );
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(binding.sourceUvs, 2));
    setPassageAwareMaterial(mesh, material); // acquire source before releasing page
    binding.material = material;
    binding.slot = null;
    binding.page = null;
}

const facadeAtlasPaintQueue = createFrameChunkQueue({
    label: 'facade-atlas-upload',
    frameBudgetMs: 1,
    preferAnimationFrame: true,
    pauseDuringMovement: false,
    trackWorldReady: false,
    workClass: 'delivery',
});

function facadeAtlasFamily(mesh, base) {
    if (!mesh?.userData?.facadeWindowOverlay || !base?.map?.image) return null;
    const segments = mesh.userData?.overlayRepaint?.segments
        || mesh.userData?.facadeCloseSegments
        || [];
    const glass = segments.some(segment => segment?.glassTower === true)
        || ((Number(base.roughness) || 1) < 0.2 && (Number(base.metalness) || 0) > 0.3);
    return glass ? 'glass' : 'punched';
}

function paintFacadeAtlasGutter(context, image, slot) {
    const { x, y, width, height, padding, sourceWidth, sourceHeight } = slot;
    context.clearRect(x - padding, y - padding, width + padding * 2, height + padding * 2);
    context.drawImage(image, 0, 0, sourceWidth, sourceHeight, x, y, width, height);
    if (padding <= 0) return;
    // Repeat the outermost source pixel through the gutter. Linear filtering
    // and mip generation can then never borrow a neighbouring facade.
    context.drawImage(image, 0, 0, sourceWidth, 1, x, y - padding, width, padding);
    context.drawImage(
        image,
        0,
        sourceHeight - 1,
        sourceWidth,
        1,
        x,
        y + height,
        width,
        padding,
    );
    context.drawImage(image, 0, 0, 1, sourceHeight, x - padding, y, padding, height);
    context.drawImage(
        image,
        sourceWidth - 1,
        0,
        1,
        sourceHeight,
        x + width,
        y,
        padding,
        height,
    );
    context.drawImage(image, 0, 0, 1, 1, x - padding, y - padding, padding, padding);
    context.drawImage(
        image,
        sourceWidth - 1,
        0,
        1,
        1,
        x + width,
        y - padding,
        padding,
        padding,
    );
    context.drawImage(
        image,
        0,
        sourceHeight - 1,
        1,
        1,
        x - padding,
        y + height,
        padding,
        padding,
    );
    context.drawImage(
        image,
        sourceWidth - 1,
        sourceHeight - 1,
        1,
        1,
        x + width,
        y + height,
        padding,
        padding,
    );
}

function advanceFacadeAtlasPaintPage(page) {
    if (!page || page.disposed) return undefined;
    const startedMs = buildingNowMs();
    do {
        const pending = page.pendingPaints[page.paintCursor];
        if (!pending) break;
        paintFacadeAtlasGutter(page.context, pending.image, pending.slot);
        pending.releaseSource?.();
        pending.releaseSource = null;
        pending.image = null;
        page.paintCursor += 1;
    } while (buildingNowMs() - startedMs < 0.75);
    if (page.paintCursor < page.pendingPaints.length) return FRAME_CHUNK_REPEAT_ITEM;

    page.texture.needsUpdate = true;
    // Upload while this work is still named and governed by the delivery
    // queue. Publishing first would make the next ordinary render pay the
    // whole texture transfer as an unattributed render/stall frame.
    renderer?.initTexture?.(page.texture);
    page.pendingPaints = [];
    page.paintCursor = 0;
    page.paintQueued = false;
    page.releasePaint?.();
    page.releasePaint = null;
    facadeAtlasStats.pageUpdates += 1;
    return undefined;
}

function ensureFacadeAtlasPaintQueue() {
    if (facadeAtlasPaintJob || facadeAtlasPaintPages.length === 0) return;
    facadeAtlasPaintJob = facadeAtlasPaintQueue.enqueue(
        facadeAtlasPaintPages,
        advanceFacadeAtlasPaintPage,
        {
            // The same job can span reveal. Use the existing loading time
            // allowance to release source rasters promptly, then restore the
            // one-item guard as soon as the player can interact.
            maxItemsPerFrame: () => isWorldBuilding() ? Infinity : 1,
            describeItem: page => page?.texture?.name || 'facade atlas page',
            onComplete: () => {
                facadeAtlasPaintJob = null;
                facadeAtlasPaintPages.length = 0;
            },
            onCancel: () => {
                for (const page of facadeAtlasPaintPages) {
                    clearFacadeAtlasSourcePaints(page, true);
                }
                facadeAtlasPaintJob = null;
                facadeAtlasPaintPages.length = 0;
            },
            onError: () => {
                for (const page of facadeAtlasPaintPages) clearFacadeAtlasSourcePaints(page, true);
                facadeAtlasPaintJob = null;
                facadeAtlasPaintPages.length = 0;
            },
        },
    );
}

function clearFacadeAtlasSourcePaints(page, failed = false) {
    if (!page) return;
    // The queue's array also includes pages it has already finished. A later
    // page's failure must not poison those successfully uploaded pages.
    if (failed && (page.paintQueued || page.pendingPaints.length > 0)) page.paintFailed = true;
    for (const paint of page.pendingPaints) {
        paint.releaseSource?.();
        paint.image = null;
        paint.releaseSource = null;
    }
    page.pendingPaints = [];
    page.paintCursor = 0;
    page.paintQueued = false;
    page.releasePaint?.();
    page.releasePaint = null;
}

function queueFacadeAtlasPaint(page, image, slot, sourceMaterial) {
    page.pendingPaints.push({ image, slot, releaseSource: facadeResources.retain(sourceMaterial, 'atlas-paint') });
    if (!page.paintQueued) {
        page.paintQueued = true;
        page.releasePaint = facadeAtlasResources.retain(page.material, 'paint');
        facadeAtlasPaintPages.push(page);
    }
    ensureFacadeAtlasPaintQueue();
}

function clearFacadeAtlasPaintQueue() {
    facadeAtlasPaintQueue.clear();
    facadeAtlasPaintJob = null;
    for (const page of facadeAtlasPaintPages) {
        clearFacadeAtlasSourcePaints(page, true);
    }
    facadeAtlasPaintPages.length = 0;
}

function createFacadeAtlasPage(group, base, region, family, pageIndex) {
    const resourceKey = `${region}|${family}|${pageIndex}`;
    const cachedMaterial = facadeAtlasResources.getOrCreate(resourceKey, () => {
        const canvas = document.createElement('canvas');
        canvas.width = FACADE_ATLAS_PAGE_SIZE;
        canvas.height = FACADE_ATLAS_PAGE_SIZE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Station3D facade atlas needs a 2D canvas context');
        const texture = makeFacadeTexture(canvas);
        texture.name = `FacadeAtlas:${region}:${family}:${pageIndex}`;
        const material = base.clone();
        // Material.clone() does not promise to retain custom shader callbacks.
        // The source already carries terrain/stencil authority, so preserve it
        // explicitly before the aggregate passage wrapper composes on top.
        material.onBeforeCompile = base.onBeforeCompile;
        material.customProgramCacheKey = base.customProgramCacheKey;
        material.name = `FacadeAtlas:${family}:${region}:${pageIndex}`;
        material.map = texture;
        material.emissiveMap = null;
        registerShared(material);
        applyNightModeToMaterial(material, true);
        const page = {
            canvas,
            context,
            texture,
            material,
            pendingPaints: [],
            paintCursor: 0,
            paintQueued: false,
            releasePaint: null,
            paintFailed: false,
            disposed: false,
        };
        group.pages[pageIndex] = page;
        group.livePages += 1;
        facadeAtlasMaterials.add(material);
        facadeAtlasPageByMaterial.set(material, page);
        facadeAtlasStats.pagesCreated += 1;
        return {
            value: material,
            cpuBytes: FACADE_ATLAS_PAGE_SIZE ** 2 * 4,
            gpuBytes: Math.ceil(FACADE_ATLAS_PAGE_SIZE ** 2 * 4 * 4 / 3),
            dispose: () => disposeFacadeAtlasPage(group, pageIndex),
        };
    });
    return facadeAtlasPageByMaterial.get(cachedMaterial);
}

function facadeAtlasPart(mesh, base, region, sourceUvs) {
    const family = facadeAtlasFamily(mesh, base);
    const image = base?.map?.image;
    const sourceWidth = Number(image?.width);
    const sourceHeight = Number(image?.height);
    if (!family || !sourceUvs || !(sourceWidth > 0) || !(sourceHeight > 0)) return null;
    const groupKey = `${region}|${family}`;
    let group = facadeAtlasGroups.get(groupKey);
    if (!group) {
        group = {
            key: groupKey,
            region,
            family,
            layout: createFacadeAtlasLayout({
                pageSize: FACADE_ATLAS_PAGE_SIZE,
                padding: FACADE_ATLAS_PADDING,
                maxEntrySize: buildingQualityProfile.buildings.facadeAtlasMaxEntrySize,
            }),
            pages: [],
            livePages: 0,
        };
        facadeAtlasGroups.set(groupKey, group);
    }
    const imageKey = base.userData.facadeSourceKey || base.map.uuid;
    const existing = group.layout.get(imageKey);
    // An incomplete/failed paint is not a cache hit. Keep this newly captured
    // facade on its ordinary source; do not attach another borrower to an
    // invalid page that the publication gate correctly refuses to show.
    if (existing && group.pages[existing.pageIndex]?.paintFailed) return null;
    const slot = existing || group.layout.allocate(imageKey, sourceWidth, sourceHeight);
    const page = group.pages[slot.pageIndex]
        || createFacadeAtlasPage(group, base, region, family, slot.pageIndex);
    if (!existing) {
        queueFacadeAtlasPaint(page, image, slot, base);
        facadeAtlasStats.entries += 1;
        facadeAtlasStats.sourcePixels += sourceWidth * sourceHeight;
        facadeAtlasStats.atlasEntryPixels += slot.width * slot.height;
    }
    return {
        material: page.material,
        uvs: remapFacadeAtlasUvs(sourceUvs, slot),
    };
}

function disposeFacadeAtlasPage(group, pageIndex) {
    const page = group.pages[pageIndex];
    if (!page || page.disposed) return;
    const retirement = group.layout.pageStats(pageIndex);
    page.disposed = true;
    clearFacadeAtlasSourcePaints(page);
    disposePassageMaterialVariant(page.material);
    facadeAtlasMaterials.delete(page.material);
    facadeAtlasPageByMaterial.delete(page.material);
    unregisterShared(page.material);
    page.material.dispose();
    unregisterShared(page.texture);
    page.texture.dispose();
    page.canvas.width = 0;
    page.canvas.height = 0;
    page.texture.image = null;
    page.context = null;
    facadeAtlasStats.pagesDisposed += 1;
    facadeAtlasStats.retiredEntries += retirement.entries;
    facadeAtlasStats.retiredContentTexels += retirement.allocatedContentTexels;
    facadeAtlasStats.retiredReservedTexels += retirement.reservedTexels;
    facadeAtlasStats.retiredCapacityTexels += retirement.capacityTexels;
    group.layout.releasePage(pageIndex);
    group.pages[pageIndex] = null;
    group.livePages -= 1;
    if (group.livePages === 0) facadeAtlasGroups.delete(group.key);
}

function disposeFacadeAtlases() {
    // clear() refuses to hide a borrower leak at teardown. Call only after
    // staged parts, buckets and old/new aggregate geometries have retired.
    facadeAtlasResources.clear();
}

// A merged overlay has no mesh of its own any more, but a courtyard passage
// that registers LATE still has to re-mask it (see the repaint below). So the
// merge records what the repaint needs, keyed by the batcher's owner key:
// the segments (slim metadata), and references to the very arrays the batcher
// holds, so this costs bookkeeping rather than a second copy of the geometry.
const overlayOwnersByKey = createCloseFacadeRecordIndex();

// A second, close-only openings overlay. The ordinary low-resolution overlay
// stays inside the regional aggregate, so walking across a LOD boundary never
// tears that aggregate apart. At most a small number of copied facade owners
// sit above it with a more detailed texture and a stronger depth bias.
const CLOSE_FACADE_UPDATE_INTERVAL_MS = 250;
const CLOSE_FACADE_UPDATE_MOVE_M = 2;
const CLOSE_FACADE_MAX_CREATES_PER_UPDATE = 1;
const CLOSE_FACADE_MAX_MATERIALS = 12;
const CLOSE_FACADE_MAX_CACHED_TEXELS = 6_500_000; // diffuse + emissive, before mipmaps
const closeFacadeDetails = new Map();  // overlay-owner key → { mesh, cacheKey }
const closeFacadeMaterialCache = new Map(); // texture key → material/textures/refcount
let closeFacadeCachedTexels = 0;
let closeFacadeLastUpdateMs = -Infinity;
let closeFacadeLastX = Infinity;
let closeFacadeLastZ = Infinity;
const closeFacadeStats = {
    created: 0,
    disposed: 0,
    skippedByCache: 0,
    maxCreateMs: 0,
    maxTextureWidth: 0,
    maxTextureHeight: 0,
};

function closeFacadeMaterialArgs(record) {
    const segment = record?.segments?.[0];
    if (!segment) return null;
    const openingMask = Object.prototype.hasOwnProperty.call(segment, 'openingMask')
        ? segment.openingMask
        : segment.glassTower
            ? null
            : getFacadeOpeningMask(
            segment.surface,
            segment.floors,
            segment.bays,
            segment.coveredHeightM,
            segment.headM,
            );
    const styleIdx = record.facadeSource?.styleIdx ?? getFacadeStyleIndex(record.objectId, segment.glassTower);
    const layout = getFacadeOpeningLayout(segment.floors, segment.bays);
    const scale = closeFacadeTextureScale(layout.widthPx, layout.heightPx);
    if (scale <= 1.05) return null;
    return {
        styleIdx,
        architectureId: record.facadeSource?.architectureId ?? architecturalLocationId(),
        floors: segment.floors,
        bays: segment.bays,
        openingMask,
        storefronts: segment.storefronts,
        glass: segment.glassTower,
        scale,
        outputWidth: Math.round(layout.widthPx * scale),
        outputHeight: Math.round(layout.heightPx * scale),
    };
}

function disposeCloseFacadeCacheEntry(cacheKey, entry) {
    if (!entry || entry.refCount > 0) return false;
    unregisterShared(entry.material);
    entry.material.dispose();
    unregisterShared(entry.diffuseTexture);
    entry.diffuseTexture.dispose();
    unregisterShared(entry.emissiveTexture);
    entry.emissiveTexture.dispose();
    closeFacadeCachedTexels = Math.max(0, closeFacadeCachedTexels - entry.texels);
    closeFacadeMaterialCache.delete(cacheKey);
    return true;
}

function makeRoomInCloseFacadeCache(extraTexels) {
    const inactive = [...closeFacadeMaterialCache.entries()]
        .filter(([, entry]) => entry.refCount === 0)
        .sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
    while ((closeFacadeMaterialCache.size >= CLOSE_FACADE_MAX_MATERIALS
        || closeFacadeCachedTexels + extraTexels > CLOSE_FACADE_MAX_CACHED_TEXELS)
        && inactive.length > 0) {
        const [cacheKey, entry] = inactive.shift();
        disposeCloseFacadeCacheEntry(cacheKey, entry);
    }
    return closeFacadeMaterialCache.size < CLOSE_FACADE_MAX_MATERIALS
        && closeFacadeCachedTexels + extraTexels <= CLOSE_FACADE_MAX_CACHED_TEXELS;
}

function acquireCloseFacadeMaterial(record) {
    const args = closeFacadeMaterialArgs(record);
    if (!args) return null;
    const lowKey = facadeTextureKey(
        args.styleIdx,
        args.floors,
        args.bays,
        args.openingMask,
        args.storefronts,
        args.glass,
        args.architectureId,
    );
    const cacheKey = `${lowKey}@close${args.scale.toFixed(3)}`;
    let entry = closeFacadeMaterialCache.get(cacheKey);
    if (!entry) {
        const createStartedMs = buildingNowMs();
        const texels = args.outputWidth * args.outputHeight * 2;
        if (!makeRoomInCloseFacadeCache(texels)) {
            closeFacadeStats.skippedByCache += 1;
            return null;
        }
        const descriptor = overtureBucketDescriptors.get(record.bucketKey);
        if (!descriptor?.material) return null;
        const painted = paintFacade(
            args.styleIdx,
            args.floors,
            args.bays,
            args.openingMask,
            args.storefronts,
            args.glass,
            args.scale,
            args.architectureId,
        );
        const diffuseTexture = makeFacadeTexture(painted.diffuse);
        const emissiveTexture = makeFacadeTexture(painted.emissive);
        const material = descriptor.material.clone();
        material.name = `CloseFacade:${lowKey}`;
        material.map = diffuseTexture;
        material.emissiveMap = emissiveTexture;
        material.polygonOffset = true;
        material.polygonOffsetFactor = -3;
        material.polygonOffsetUnits = -3;
        registerShared(material);
        applyNightModeToMaterial(material, true);
        entry = {
            material,
            diffuseTexture,
            emissiveTexture,
            texels,
            refCount: 0,
            lastUsedMs: buildingNowMs(),
        };
        closeFacadeMaterialCache.set(cacheKey, entry);
        closeFacadeCachedTexels += texels;
        closeFacadeStats.maxCreateMs = Math.max(
            closeFacadeStats.maxCreateMs,
            buildingNowMs() - createStartedMs,
        );
        closeFacadeStats.maxTextureWidth = Math.max(
            closeFacadeStats.maxTextureWidth,
            args.outputWidth,
        );
        closeFacadeStats.maxTextureHeight = Math.max(
            closeFacadeStats.maxTextureHeight,
            args.outputHeight,
        );
    }
    entry.refCount += 1;
    entry.lastUsedMs = buildingNowMs();
    return { cacheKey, material: entry.material };
}

function releaseCloseFacadeMaterial(cacheKey) {
    const entry = closeFacadeMaterialCache.get(cacheKey);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedMs = buildingNowMs();
}

function removeCloseFacadeDetail(key) {
    const detail = closeFacadeDetails.get(key);
    if (!detail) return;
    closeFacadeDetails.delete(key);
    if (detail.mesh.parent) detail.mesh.parent.remove(detail.mesh);
    detail.mesh.geometry.dispose();
    releaseCloseFacadeMaterial(detail.cacheKey);
    closeFacadeStats.disposed += 1;
}

function addCloseFacadeDetail(key, record) {
    if (!buildingsGroup || closeFacadeDetails.has(key)) return false;
    const acquired = acquireCloseFacadeMaterial(record);
    if (!acquired) return false;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
        new Float32Array(record.positions),
        3,
    ));
    if (record.uv) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(record.uv), 2));
    }
    geometry.computeVertexNormals();
    const descriptor = overtureBucketDescriptors.get(record.bucketKey);
    const mesh = new THREE.Mesh(geometry, acquired.material);
    mesh.name = 'CloseFacadeDetail';
    mesh.renderOrder = (descriptor?.renderOrder || 0) + 0.01;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = showOpenings && (!isProposalBuildingBucketKey(record.bucketKey)
        || proposalBuildingMeshesVisible);
    mesh.userData.facadeCloseDetail = true;
    if (isProposalBuildingBucketKey(record.bucketKey)) mesh.userData.proposalBuilding = true;
    // The low overlay's opening mask already removes pixels over passages, and
    // a late passage unmerges/removes this owner before repainting it. Keeping
    // the close material out of the passage-variant cache also lets its bounded
    // LRU dispose textures immediately when no close facade uses them.
    buildingsGroup.add(mesh);
    closeFacadeDetails.set(key, { mesh, cacheKey: acquired.cacheKey });
    closeFacadeStats.created += 1;
    return true;
}

function updateCloseFacadeDetails(localX, localZ, force = false) {
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return;
    const now = buildingNowMs();
    const movedSq = (localX - closeFacadeLastX) ** 2 + (localZ - closeFacadeLastZ) ** 2;
    if (!force && now - closeFacadeLastUpdateMs < CLOSE_FACADE_UPDATE_INTERVAL_MS
        && movedSq < CLOSE_FACADE_UPDATE_MOVE_M ** 2) return;
    closeFacadeLastUpdateMs = now;
    closeFacadeLastX = localX;
    closeFacadeLastZ = localZ;
    let phaseStartedMs = performance.now();
    const selected = overlayOwnersByKey.select(
        new Set(closeFacadeDetails.keys()),
        localX,
        localZ,
        { maxOwners: buildingQualityProfile.buildings.closeFacadeMaxOwners },
    );
    recordLayerFrameMs(
        'buildings:closeFacades:select',
        performance.now() - phaseStartedMs,
    );
    phaseStartedMs = performance.now();
    const desired = new Set(selected.map(({ key }) => key));
    for (const key of [...closeFacadeDetails.keys()]) {
        if (!desired.has(key) || !overlayOwnersByKey.has(key)) removeCloseFacadeDetail(key);
    }
    recordLayerFrameMs(
        'buildings:closeFacades:remove',
        performance.now() - phaseStartedMs,
    );
    phaseStartedMs = performance.now();
    let created = 0;
    for (const { key, record } of selected) {
        if (closeFacadeDetails.has(key)) continue;
        if (created >= CLOSE_FACADE_MAX_CREATES_PER_UPDATE) break;
        if (addCloseFacadeDetail(key, record)) created += 1;
    }
    recordLayerFrameMs(
        'buildings:closeFacades:create',
        performance.now() - phaseStartedMs,
    );
}

function clearCloseFacadeDetails(disposeCache = false) {
    for (const key of [...closeFacadeDetails.keys()]) removeCloseFacadeDetail(key);
    closeFacadeLastUpdateMs = -Infinity;
    closeFacadeLastX = Infinity;
    closeFacadeLastZ = Infinity;
    if (!disposeCache) return;
    for (const [cacheKey, entry] of [...closeFacadeMaterialCache.entries()]) {
        disposeCloseFacadeCacheEntry(cacheKey, entry);
    }
}

function disposeBuildingTextureCaches() {
    const textures = new Set();
    const remember = resource => { if (resource) textures.add(resource); };
    const rememberAll = values => {
        if (!values) return;
        for (const value of values) remember(value);
    };

    rememberAll(_wallTextures);
    rememberAll(_wallNormalTextures);
    _wallTextures.fill(null);
    _wallNormalTextures.fill(null);
    for (const texture of [
        _wallEmissiveTexture,
        _roofTexture,
        _roofNormalTexture,
        _kanalicaRoofTexture,
        _kanalicaRoofNormalTexture,
        overtureFlatRoofTexture,
        _flatRoofTexture,
    ]) remember(texture);
    _wallEmissiveTexture = null;
    _roofTexture = null;
    _roofNormalTexture = null;
    _kanalicaRoofTexture = null;
    _kanalicaRoofNormalTexture = null;
    overtureFlatRoofTexture = null;
    _flatRoofTexture = null;

    for (const surface of _dalmatianStoneSurfaces.values()) {
        remember(surface?.map);
        remember(surface?.bumpMap);
    }
    _dalmatianStoneSurfaces.clear();
    rememberAll(_facadeTextures.values());
    rememberAll(_facadeEmissiveTextures.values());
    _facadeTextures.clear();
    _facadeEmissiveTextures.clear();
    rememberAll(overtureWallTextures);
    overtureWallTextures = null;
    rememberAll(newBuildWallTextures?.values());
    newBuildWallTextures?.clear();
    newBuildWallTextures = null;
    rememberAll(curtainWallTextures);
    curtainWallTextures = null;
    rememberAll(statedBrickTextures.values());
    statedBrickTextures.clear();

    for (const texture of textures) {
        unregisterShared(texture);
        texture.dispose();
    }
}

function disposeStatedMaterialFamilies() {
    for (const family of statedMaterialFamilies.values()) {
        if (!family?.material) continue;
        unregisterShared(family.material);
        family.material.dispose();
    }
    statedMaterialFamilies.clear();
}

if (typeof window !== 'undefined') {
    window.__s3dCloseFacades = () => ({
        activeOwners: closeFacadeDetails.size,
        cachedMaterials: closeFacadeMaterialCache.size,
        cachedTexels: closeFacadeCachedTexels,
        ownerIndex: overlayOwnersByKey.stats(),
        ...closeFacadeStats,
    });
}

// World-space bounds straight from a flat position array. Used at merge time,
// where the array has already had the mesh's translation BAKED into it — going
// through the mesh would apply mesh.matrixWorld on top and translate twice.
function boundsOfPositions(positions) {
    if (!positions || positions.length < 3) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Number.isFinite(minX) ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
}

function makeOvertureFamilyMaterial(base, familyKey, isWall) {
    const familyMaterial = base.clone();
    familyMaterial.color.set(0xffffff);
    familyMaterial.vertexColors = true;
    const previousCompile = familyMaterial.onBeforeCompile;
    familyMaterial.onBeforeCompile = (shader, renderer) => {
        if (previousCompile) previousCompile(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n'
            + '#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= vColor.rgb;\n#endif',
        );
    };
    // Every aggregate family uses the exact same shader patch. Keeping the
    // colour/texture family in the program key compiled four byte-identical
    // programs as each wall family first streamed into view (the measured
    // render spikes arrived in +4 program steps). Texture identity and vertex
    // colours are uniforms/attributes, so one shared variant is authoritative.
    familyMaterial.customProgramCacheKey = () => 'building-vc-emissive-v1';
    registerShared(familyMaterial);
    // Recompute emissive for the WHITE base — the clone inherited the tinted
    // one — and register under buildingMaterials so the night-mode toggle loop
    // reaches it forever after (its isWall test is key-prefix based).
    buildingMaterials[familyKey] = familyMaterial;
    applyNightModeToMaterial(familyMaterial, isWall);
    return familyMaterial;
}

function overtureColorFamilyFor(base) {
    if (overtureColorFamilyByBase.has(base)) return overtureColorFamilyByBase.get(base);
    // Survey-mesh walls declare their family when they are built, because their
    // cache key cannot be pattern-matched safely (see registerWallColorFamily).
    const declared = wallColorFamilyByMaterial.get(base);
    if (declared) {
        const familyMaterial = buildingMaterials[declared.familyKey]
            || makeOvertureFamilyMaterial(base, declared.familyKey, /* isWall */ true);
        const family = { material: familyMaterial, color: declared.color };
        overtureColorFamilyByBase.set(base, family);
        return family;
    }
    let family = null;
    for (const [cacheKey, material] of Object.entries(buildingMaterials)) {
        if (material !== base) continue;
        const roofMatch = /^(_roof_[^_]+)_/.exec(cacheKey);
        const roof = !!roofMatch;
        // Flat roofs are FLAT_ROOF_PALETTE x 64 buckets over one shared
        // texture, so the whole lot collapses into a single family.
        const flatRoof = cacheKey.startsWith('_roofFlat_');
        const wall = /^ovtWall_\d+_(\d+)$/.exec(cacheKey);
        if (roof || flatRoof || wall) {
            // One family per shared TEXTURE: all roofs use one, walls one per
            // wear variant. The key must keep the roof prefix so the night
            // toggle treats families like their members.
            const familyKey = roof
                ? `${roofMatch[1]}_family`
                : flatRoof
                    ? '_roofFlat_family'
                    : `ovtWallFamily_${wall[1]}`;
            const familyMaterial = buildingMaterials[familyKey]
                || makeOvertureFamilyMaterial(base, familyKey, /* isWall */ !roof && !flatRoof);
            family = {
                material: familyMaterial,
                color: [base.color.r, base.color.g, base.color.b],
            };
        }
        break;
    }
    overtureColorFamilyByBase.set(base, family);
    return family;
}

// Merge a freshly added building's meshes into the shared regional aggregates.
//
// Source-agnostic: it takes whatever meshes the building just put in
// buildingsGroup and merges the mergeable ones, so an Overture extrusion and a
// LOD2 survey mesh land in the same aggregates and are told apart only by the
// `source` their entity metadata carries.
//
// Why the survey path needed this: it was the ONLY building path still emitting
// one mesh per surface per building. Measured on a Split walk, 8,495 building
// meshes carrying 3,083 materials — and render time here is ~7.7 microseconds
// per draw call, essentially independent of triangle count, so the object count
// IS the frame time. The Overture path had already been merged for exactly this
// reason; this makes the survey path pay the same low per-object cost.
function publishBuildingAggregatePart(record) {
    const { scope, region, ownerKey, bucketKey, part, descriptor, overlayRecord = null } = record;
    try {
        let scopeOwners = overtureScopeOwners.get(scope);
        if (!scopeOwners) {
            scopeOwners = new Set();
            overtureScopeOwners.set(scope, scopeOwners);
        }
        scopeOwners.add(ownerKey);
        overtureBatcher.addPart(bucketKey, ownerKey, part);
        if (overlayRecord) {
            overlayOwnersByKey.set(`${ownerKey}#${bucketKey}`, overlayRecord);
        }
        if (!overtureBucketDescriptors.has(bucketKey)) {
            descriptor.releaseFacadeMaterial = retainBuildingFacadeMaterial(descriptor.material, 'bucket');
            overtureBucketDescriptors.set(bucketKey, descriptor);
        }
        let bucketSet = overtureTileBuckets.get(region);
        if (!bucketSet) {
            bucketSet = new Set();
            overtureTileBuckets.set(region, bucketSet);
        }
        bucketSet.add(bucketKey);
        overtureDirtyTiles.add(region);
    } finally {
        record.releaseFacadeMaterial?.();
    }
}

function captureBuildingMeshesForBatching(feature, tileKey, startIndex, source = 'overture') {
    if (!buildingsGroup || buildingsGroup.children.length <= startIndex) return;
    const scope = overtureTileScope(tileKey);
    const region = overtureRegionForScope(scope);
    // The scope prefix makes eviction possible: removeTile knows only its own
    // tile, and every owner it must pull out of the region's buckets is
    // recoverable from this set.
    const metadata = buildingEntityMetadata(feature, source);
    const ownerKey = `${scope}|${metadata?.key || `i${startIndex}`}`;
    const replacement = tileVisualReplacements.get(scope);
    const children = buildingsGroup.children;
    const kept = [];
    for (let i = startIndex; i < children.length; i++) {
        const mesh = children[i];
        const geometry = mesh?.geometry;
        const position = geometry?.getAttribute?.('position');
        // Only translation-only, childless meshes merge; anything fancier
        // (a rotated prop, a nested group) stays an individual mesh. The
        // translation is baked into the (per-building, freshly built)
        // position array, so the merged bucket needs no transform at all.
        const mergeable = mesh?.isMesh && position && position.count > 0
            && mesh.children.length === 0
            && !isShared(geometry)
            // Runtime close-detail overlays can be appended while a resumable
            // building build is between stages. They belong to the player LOD
            // controller, never to whichever building happens to finish next.
            && !mesh.userData?.facadeCloseDetail
            && mesh.quaternion.w === 1 && mesh.quaternion.x === 0
            && mesh.quaternion.y === 0 && mesh.quaternion.z === 0
            && mesh.scale.x === 1 && mesh.scale.y === 1 && mesh.scale.z === 1
            && !Array.isArray(mesh.material);
        if (!mergeable) { restoreFacadeOverlaySource(mesh); kept.push(mesh); continue; }
        const facadeBinding = facadeOverlayBindings.get(mesh);
        if (facadeBinding?.slot && (facadeBinding.region !== region || facadeBinding.page.paintFailed)) {
            restoreFacadeOverlaySource(mesh);
        }
        // Bucket by the BASE material: the aggregate re-resolves its own
        // passage variant (setPassageAwareMaterial below), so a building near
        // a courtyard passage no longer needs its own mesh. Roof-family bases
        // consolidate further: colour moves into a vertex attribute and the
        // bucket material is the family's shared white.
        const base = passageBaseMaterialByMesh.get(mesh) || mesh.material;
        if (overtureMaterialExcluded(base)) { restoreFacadeOverlaySource(mesh); kept.push(mesh); continue; }
        // Every keep-decision must precede this point: the bake mutates the
        // mesh's live position array, so a mesh kept AFTER it would render its
        // translation twice — geometry + still-set mesh.position. That is
        // exactly how Rijeka's window overlays floated 2× uphill/downhill.
        const array = position.array;
        const { x: ox, y: oy, z: oz } = mesh.position;
        if (ox !== 0 || oy !== 0 || oz !== 0) {
            for (let v = 0; v < array.length; v += 3) {
                array[v] += ox;
                array[v + 1] += oy;
                array[v + 2] += oz;
            }
        }
        const attributes = { position: array };
        const uv = geometry.getAttribute('uv');
        const facadeAtlas = uv ? (facadeBinding?.slot
            ? { material: base, uvs: uv.array }
            : facadeAtlasPart(mesh, base, region, uv.array)) : null;
        if (uv) attributes.uv = facadeAtlas ? facadeAtlas.uvs : uv.array;
        const normal = geometry.getAttribute('normal');
        if (normal) attributes.normal = normal.array;
        const roofFamily = facadeAtlas ? null : overtureColorFamilyFor(base);
        const bucketMaterial = facadeAtlas?.material
            || (roofFamily ? roofFamily.material : base);
        if (roofFamily) {
            const colorArray = new Float32Array(position.count * 3);
            for (let v = 0; v < colorArray.length; v += 3) {
                colorArray[v] = roofFamily.color[0];
                colorArray[v + 1] = roofFamily.color[1];
                colorArray[v + 2] = roofFamily.color[2];
            }
            attributes.color = colorArray;
        } else {
            // A part that arrived WITH per-vertex colour keeps it. The roof
            // family SYNTHESISES one because its meshes have none, and reading
            // only that case silently dropped the colour of every mesh that had
            // brought its own — while the bucket kept the vertexColors:true
            // material. WebGL then supplies (0,0,0) for the missing attribute
            // and multiplies the whole bucket to black, which is how Cibona's
            // glass and mullions came out as a black silhouette.
            const vertexColor = geometry.getAttribute('color');
            if (vertexColor) attributes.color = vertexColor.array;
        }
        if (bucketMaterial.vertexColors && !attributes.color) {
            batchColorMismatches += 1;
            console.error('[Station3D] batch part has no colour attribute but its '
                + 'material reads one — this bucket will render black', bucketMaterial.uuid);
        }
        let materialId = overtureMaterialIds.get(bucketMaterial);
        if (materialId == null) {
            materialId = nextOvertureMaterialId++;
            overtureMaterialIds.set(bucketMaterial, materialId);
        }
        const fingerprint = `${uv ? 'u' : ''}${normal ? 'n' : ''}`
            + `${attributes.color ? 'k' : ''}${geometry.index ? 'i' : ''}`;
        const bucketKey = `ov#${materialId}@${Number(mesh.renderOrder) || 0}`
            + `${mesh.castShadow ? 'c' : ''}${mesh.receiveShadow ? 'r' : ''}`
            + `:${fingerprint}/${region}`;
        const part = {
            attributes,
            ...(geometry.index ? { index: geometry.index.array } : {}),
            ...(metadata ? { entity: { key: metadata.key, metadata } } : {}),
        };
        // Keep what a late courtyard passage needs to re-mask this overlay. The
        // mesh is about to vanish into the merge, and its userData with it; the
        // arrays are the ones the batcher owns (or the replacement record stages),
        // so this is bookkeeping, not a copy. Bounds are computed once, here,
        // while the mesh still exists.
        const repaintInfo = mesh.userData?.overlayRepaint;
        const closeSegments = repaintInfo?.segments || mesh.userData?.facadeCloseSegments;
        let overlayRecord = null;
        if (closeSegments) {
            // Bounds from the BAKED array, which is already world-space.
            // getPassageMeshBounds would re-apply mesh.matrixWorld — and
            // mesh.position is still set at this point — translating twice.
            const bounds = boundsOfPositions(attributes.position);
            if (bounds) {
                overlayRecord = {
                    scope,
                    ownerKey,
                    bucketKey,
                    objectId: repaintInfo?.objectId ?? mesh.userData?.objectId,
                    // Close-LOD-only Overture records do not carry facade
                    // surfaces and cannot enter the courtyard re-mask path.
                    passageRepaint: !!repaintInfo,
                    segments: closeSegments,
                    positions: attributes.position,
                    // Atlas UVs belong only to the ordinary aggregate. Close
                    // detail and a passage repaint bind a standalone texture
                    // and therefore retain the source facade's 0..1 UVs.
                    uv: facadeBinding?.sourceUvs || uv?.array,
                    facadeSource: facadeBinding?.source,
                    bounds,
                };
            }
        }
        const record = {
            scope,
            region,
            ownerKey,
            bucketKey,
            part,
            overlayRecord,
            releaseFacadeMaterial: retainBuildingFacadeMaterial(bucketMaterial, 'staged-part'),
            descriptor: {
                material: bucketMaterial,
                renderOrder: Number(mesh.renderOrder) || 0,
                castShadow: !!mesh.castShadow,
                receiveShadow: !!mesh.receiveShadow,
            },
        };
        if (replacement) replacement.stagedAggregateParts.push(record);
        else publishBuildingAggregatePart(record);
        // The arrays now belong to the batcher/staged record; the discarded
        // mesh no longer owns GPU buffers or its standalone facade source.
        geometry.dispose();
    }
    children.length = startIndex;
    for (const mesh of kept) children.push(mesh);
}

// Buckets released for assembly but not yet rebuilt into a merged mesh. A region
// turns "ready" all at once — a tile completes, or a tile evicts and its owners
// leave the shared regional buckets — and rebuilding every bucket in one frame
// hands three.js several fresh merged buffers that all upload to the GPU inside
// the NEXT renderer.render(): the sustained "render" cost a moving cab pays as
// tiles stream in and out (and, un-budgeted, the occasional second-long spike).
// The drainer rebuilds a few buckets per frame under a time budget and an upload
// cap, so a region's re-upload is spread across frames instead of paid at once.
let pendingOvertureBuckets = [];
let pendingOvertureBucketHead = 0;
const pendingOvertureBucketSet = new Set();
let activeOvertureAssembly = null;
// These are inner generator yields, not per-frame limits: the outer task still
// stops at the 2/3 ms deadline. Four-thousand values made a dense regional
// bucket require hundreds of effectively zero-cost frame visits, holding the
// initial coverage gate for 20+ seconds. A 32k typed-array copy is sub-ms on
// the target host while cutting scheduler bookkeeping by eight.
const OVERTURE_ASSEMBLY_VALUES_PER_STAGE = 32768;
const OVERTURE_ASSEMBLY_PARTS_PER_STAGE = 128;
function buildOvertureAggregateMesh({
    bucketKey,
    assembled,
    descriptor,
    generation,
    publicationKey,
    memoryReservation,
}) {
    const geometry = new THREE.BufferGeometry();
    bindGeometryMemory(geometry, memoryReservation, { disposeEvent: true });
    try {
        geometry.setAttribute('position', new THREE.BufferAttribute(assembled.attributes.position, 3));
        if (assembled.attributes.uv) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(assembled.attributes.uv, 2));
        }
        if (assembled.attributes.normal) {
            geometry.setAttribute('normal', new THREE.BufferAttribute(assembled.attributes.normal, 3));
        }
        if (assembled.attributes.color) {
            geometry.setAttribute('color', new THREE.BufferAttribute(assembled.attributes.color, 3));
        }
        if (assembled.index) geometry.setIndex(new THREE.BufferAttribute(assembled.index, 1));
        if (assembled.bounds) {
            // Assembly already measured these bounds cooperatively. Give the
            // exact box to Mesh.raycast too: a regional sphere alone sends
            // nearby street/roof queries through every triangle in the batch.
            geometry.boundingBox = new THREE.Box3(
                new THREE.Vector3(assembled.bounds.minX, assembled.bounds.minY, assembled.bounds.minZ),
                new THREE.Vector3(assembled.bounds.maxX, assembled.bounds.maxY, assembled.bounds.maxZ),
            );
            const center = new THREE.Vector3(
                (assembled.bounds.minX + assembled.bounds.maxX) * 0.5,
                (assembled.bounds.minY + assembled.bounds.maxY) * 0.5,
                (assembled.bounds.minZ + assembled.bounds.maxZ) * 0.5,
            );
            geometry.boundingSphere = new THREE.Sphere(
                center,
                Math.hypot(
                    assembled.bounds.maxX - center.x,
                    assembled.bounds.maxY - center.y,
                    assembled.bounds.maxZ - center.z,
                ),
            );
        } else {
            geometry.computeBoundingSphere();
        }
        const mesh = new THREE.Mesh(geometry, descriptor.material);
        mesh.raycast = createOwnerRangeRaycast(assembled.ranges);
        mesh.name = descriptor.material?.name
            ? `OvertureAggregate:${descriptor.material.name}`
            : 'OvertureAggregate';
        mesh.renderOrder = descriptor.renderOrder;
        mesh.castShadow = descriptor.castShadow;
        mesh.receiveShadow = descriptor.receiveShadow;
        mesh.userData.overtureAggregate = true;
        if (isProposalBuildingBucketKey(bucketKey)) {
            mesh.userData.proposalBuilding = true;
            mesh.visible = proposalBuildingMeshesVisible;
            markInspectionLayer(mesh, {
                id: 'proposal-buildings',
                label: 'Proposal buildings (local style)',
                category: 'Plans',
                source: 'world/buildings.js · proposal footprints through ordinary building pipeline',
                order: 182,
            });
        }
        setPassageAwareMaterial(mesh, descriptor.material);
        markSurfaceClaim(mesh, {
            surfaceClass: SURFACE_CLASS.BUILDING,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
            ownerId: bucketKey,
            sourceId: 'world/buildings.js',
            replacementKey: publicationKey,
            generation,
        });
        return mesh;
    } catch (error) {
        // Preparation can fail before the drainer receives its mesh. Retire
        // this geometry (including attached leases) at the allocation owner.
        geometry.dispose();
        throw error;
    }
}

function queueOvertureBucket(bucketKey) {
    if (pendingOvertureBucketSet.has(bucketKey)) return;
    pendingOvertureBucketSet.add(bucketKey);
    pendingOvertureBuckets.push(bucketKey);
}

function queueOvertureBuckets(bucketKeys) {
    for (const bucketKey of bucketKeys || []) queueOvertureBucket(bucketKey);
}

function pendingOvertureBucketCount() {
    return pendingOvertureBuckets.length - pendingOvertureBucketHead;
}

function getBuildingAggregatePipelineSnapshot() {
    return {
        pendingBuckets: pendingOvertureBucketCount(),
        activeBucket: activeOvertureAssembly?.bucketKey || null,
        activePhase: activeOvertureAssembly?.prewarm ? 'gpu-prewarm'
            : activeOvertureAssembly?.publishReady ? 'publish'
                : activeOvertureAssembly ? 'assemble' : null,
        activeCurrent: activeOvertureAssembly?.task?.isCurrent?.() ?? null,
        activeStepCalls: activeOvertureAssembly?.stepCalls || 0,
        activeCpuMs: activeOvertureAssembly?.cpuMs || 0,
        activeRemainingMs: activeOvertureAssembly?.lastRemainingMs ?? null,
        waitingTiles: aggregateGate.size,
    };
}

function compactPendingOvertureBuckets() {
    if (pendingOvertureBucketHead === pendingOvertureBuckets.length) {
        pendingOvertureBuckets = [];
        pendingOvertureBucketHead = 0;
        return;
    }
    // A cross-country stream may never make the queue literally empty. Keep
    // the consumed prefix from retaining every historical bucket forever,
    // while compacting only occasionally rather than slicing every frame.
    if (pendingOvertureBucketHead >= 1024
        && pendingOvertureBucketHead * 2 >= pendingOvertureBuckets.length) {
        pendingOvertureBuckets = pendingOvertureBuckets.slice(pendingOvertureBucketHead);
        pendingOvertureBucketHead = 0;
    }
}

function cancelOvertureAssembly() {
    const active = activeOvertureAssembly;
    if (!active) return;
    active.prewarm?.return?.();
    active.task?.cancel?.();
    if (active.mesh) disposeOvertureAggregateMesh(active.mesh);
    active.memoryReservation?.release();
    activeOvertureAssembly = null;
}

// Rebuild queued dirty buckets into merged meshes. With the default (Infinity)
// budget this is the old synchronous behaviour, used at tile completion so a
// tile's buildings are on screen before the far layer drops its prisms. The
// onFrame drainer passes a finite budget + upload cap; buckets not reached this
// frame stay queued for the next.
function assembleOvertureBuckets({ frameBudgetMs = Infinity, maxUploads = Infinity } = {}) {
    if ((!activeOvertureAssembly && pendingOvertureBucketCount() === 0) || !buildingsGroup) return;
    const startedMs = performance.now();
    let uploads = 0;
    // Buckets dealt with in THIS drain, whatever the outcome — assembled,
    // emptied and dropped, or descriptor already gone. Reported to the gate
    // after the loop, never inside it, so a tile is announced only once every
    // mesh this drain produces is actually in the scene.
    const settled = [];
    try {
        while (activeOvertureAssembly
            || pendingOvertureBucketHead < pendingOvertureBuckets.length) {
            if (uploads >= maxUploads || performance.now() - startedMs > frameBudgetMs) {
                break;
            }
            if (!activeOvertureAssembly) {
                const bucketKey = pendingOvertureBuckets[pendingOvertureBucketHead];
                pendingOvertureBucketHead += 1;
                pendingOvertureBucketSet.delete(bucketKey);
                const descriptor = overtureBucketDescriptors.get(bucketKey);
                if (!descriptor) {
                    settled.push(bucketKey);
                    continue;
                }
                const atlasPage = facadeAtlasPageByMaterial.get(descriptor.material);
                if (atlasPage?.paintFailed || atlasPage?.paintQueued || atlasPage?.pendingPaints?.length > 0) {
                    // The previous complete aggregate remains visible until the exact
                    // pixels for this page have been painted and initialized on the
                    // GPU. Requeue once and let the delivery queue make progress; do
                    // not spin over the same bucket inside this drain.
                    queueOvertureBucket(bucketKey);
                    break;
                }
                const active = {
                    bucketKey,
                    stepCalls: 0,
                    cpuMs: 0,
                    memoryReservation: null,
                    task: overtureBatcher.beginAssembly(bucketKey, {
                        valuesPerStage: OVERTURE_ASSEMBLY_VALUES_PER_STAGE,
                        partsPerStage: OVERTURE_ASSEMBLY_PARTS_PER_STAGE,
                        includeBounds: true,
                        includeOwnerBounds: true,
                        admitBytes: bytes => {
                            active.memoryReservation ||= buildingGeometryMemory.request({
                                lane: 'near', key: `aggregate:${bucketKey}`,
                                cpuBytes: bytes, gpuBytes: bytes,
                            });
                            return active.memoryReservation.tryAcquire();
                        },
                    }),
                };
                activeOvertureAssembly = active;
            }
            // Reject stale generations before allocating or copying any more
            // buffers. A budget waiter must not retain yesterday's source snapshot.
            if (!activeOvertureAssembly.task.isCurrent()) {
                const bucketKey = activeOvertureAssembly.bucketKey;
                cancelOvertureAssembly();
                queueOvertureBucket(bucketKey);
                continue;
            }
            if (activeOvertureAssembly.publishReady) {
                const active = activeOvertureAssembly;
                const stepStartedMs = performance.now();
                const outcome = active.prewarm ? active.prewarm.next() : { done: true };
                recordLayerFrameMs(
                    `bld:ovAssemble:${outcome.value?.phase || (outcome.done ? 'prewarm-complete' : 'gpu-prewarm')}`,
                    performance.now() - stepStartedMs,
                );
                if (!outcome.done) {
                    // A task started by a finite drain may be resumed by the
                    // static Infinity path. Async compilation still needs a new
                    // event-loop turn, irrespective of the caller's CPU budget.
                    if (frameBudgetMs === Infinity && outcome.value?.waiting !== true) continue;
                    break;
                }
                const currentDescriptor = overtureBucketDescriptors.get(active.bucketKey);
                if (!currentDescriptor || currentDescriptor !== active.descriptor) {
                    cancelOvertureAssembly();
                    if (currentDescriptor) queueOvertureBucket(active.bucketKey);
                    else settled.push(active.bucketKey);
                    continue;
                }
                settled.push(active.bucketKey);
                const publicationTicket = surfacePublications?.begin?.({
                    key: active.publicationKey,
                    generation: active.generation,
                    parent: buildingsGroup,
                    retire: (_context, root) => disposeOvertureAggregateMesh(root),
                }) || null;
                if (publicationTicket) {
                    publicationTicket.publish(active.mesh, {
                        commit: () => commitOvertureAggregate(
                            active.bucketKey,
                            active.mesh,
                            active.assembled,
                        ),
                    });
                } else {
                    buildingsGroup.add(active.mesh);
                    commitOvertureAggregate(active.bucketKey, active.mesh, active.assembled);
                    if (active.aggregate) disposeOvertureAggregateMesh(active.aggregate.mesh);
                }
                publishPendingOverlayReplacements(active.bucketKey);
                activeOvertureAssembly = null;
                uploads += 1;
                continue;
            }
            const { bucketKey, task } = activeOvertureAssembly;
            const elapsedMs = performance.now() - startedMs;
            const remainingMs = frameBudgetMs === Infinity
                ? Infinity
                : Math.max(0.1, frameBudgetMs - elapsedMs);
            const stepStartedMs = performance.now();
            activeOvertureAssembly.lastRemainingMs = remainingMs;
            const taskComplete = task.step(remainingMs);
            const stepMs = performance.now() - stepStartedMs;
            recordLayerFrameMs(
                `bld:ovAssemble:${task.lastPhase?.() || (taskComplete ? 'complete' : 'unknown')}`,
                stepMs,
            );
            activeOvertureAssembly.stepCalls += 1;
            activeOvertureAssembly.cpuMs += stepMs;
            if (!taskComplete) break;
            if (!task.isCurrent()) {
                cancelOvertureAssembly();
                queueOvertureBucket(bucketKey);
                continue;
            }
            const descriptor = overtureBucketDescriptors.get(bucketKey);
            if (!descriptor) {
                cancelOvertureAssembly();
                settled.push(bucketKey);
                continue;
            }
            const assembled = task.result();
            const aggregate = overtureAggregates.get(bucketKey) || null;
            const generation = ++buildingAggregatePublicationGeneration;
            if (!assembled) {
                cancelOvertureAssembly();
                settled.push(bucketKey);
                clearOvertureAggregate(bucketKey, generation);
                continue;
            }
            const publicationKey = buildingAggregatePublicationKey(bucketKey);
            const memoryReservation = activeOvertureAssembly.memoryReservation;
            const mesh = buildOvertureAggregateMesh({
                bucketKey,
                assembled,
                descriptor,
                generation,
                publicationKey,
                memoryReservation,
            });
            activeOvertureAssembly = {
                bucketKey,
                task,
                descriptor,
                assembled,
                aggregate,
                generation,
                mesh,
                publicationKey,
                memoryReservation,
                publishReady: true,
                prewarm: isWorldBuilding() ? null : prewarmDetachedObject(mesh, {
                    renderer,
                    camera,
                    targetScene: scene,
                    // A finite frame budget revisits this generator on later turns,
                    // so compileAsync can settle between steps. The static radius
                    // path deliberately drains with Infinity in one call; waiting
                    // on a Promise there would tight-loop in the same JS task and
                    // prevent that Promise from ever settling.
                    asyncShaders: frameBudgetMs !== Infinity,
                    label: 'building-aggregate-shader',
                    uploadGeometry: false,
                    prewarmShaders: true,
                    prewarmTextures: false,
                }),
            };
        }
    } catch (error) {
        cancelOvertureAssembly();
        throw error;
    }
    compactPendingOvertureBuckets();
    for (const bucketKey of settled) aggregateGate.noteAssembled(bucketKey);
    recordLayerFrameMs('bld:ovAssemble', performance.now() - startedMs);
}

// One assemble per completed tile (or radius load) — the batch boundary is the
// moment the tile's last building lands, so a tile in progress never rebuilds
// its buckets once per building. Completion drains synchronously so the tile's
// buildings are visible before the far layer drops its prisms.
// Queue a completed tile's buckets for assembly and report which ones it must
// wait on before its detailed coverage may be announced.
//
// This used to assemble SYNCHRONOUSLY and unbudgeted, because the far layer's
// prisms are dropped immediately afterwards and the merged geometry had to
// exist by then. That handed three.js every freshly merged buffer at once, all
// uploading inside the next render — measured on a Zagreb walk, stall went
// 1.95 ms to 4.37 ms once survey meshes joined the buckets, cancelling out a
// 27% draw-call win. The assembly is now budgeted like every other rebuild and
// the ANNOUNCEMENT waits instead (see core/aggregate-gate.js), so the prisms
// stay up over the gap rather than racing it.
// Only buckets whose CONTENTS changed are re-merged, not the whole region.
//
// A region spans OVERTURE_REGION_TILES^2 tiles, and every tile completing in it
// used to queue every bucket the region owns — so a bucket no building touched
// was re-merged and re-uploaded once per neighbouring tile. The batcher has
// always known exactly which buckets changed (addPart and removeOwner mark
// them); that set was being discarded in favour of re-assembling by region.
// The take is SCOPED to this region so it cannot clear dirt belonging to a
// region whose own tile has not completed yet.
function queueTileAggregates(tileKey) {
    const region = overtureRegionForScope(overtureTileScope(tileKey));
    if (!overtureDirtyTiles.delete(region)) return null;
    const bucketKeys = overtureTileBuckets.get(region);
    if (!bucketKeys || bucketKeys.size === 0) return null;
    const changed = overtureBatcher.takeDirtyBuckets(bucketKeys);
    aggregateWaste.regionQueued += bucketKeys.size;
    aggregateWaste.actuallyDirty += changed.length;
    if (changed.length === 0) return null;
    queueOvertureBuckets(changed);
    return new Set(changed);
}

// Tile eviction: pull the tile's OWNERS out of its region's buckets and
// re-assemble what remains. A region outliving the tile is the point of
// regional buckets; when the last owner leaves, the assemble pass drops the
// emptied bucket and its mesh.
function dropOvertureTileState(tileKey, { deferAssembly = false } = {}) {
    const scope = overtureTileScope(tileKey);
    const owners = overtureScopeOwners.get(scope);
    if (!owners) return;
    overtureScopeOwners.delete(scope);
    const region = overtureRegionForScope(scope);
    const bucketKeys = overtureTileBuckets.get(region);
    if (!bucketKeys) return;
    let changed = false;
    for (const bucketKey of bucketKeys) {
        for (const ownerKey of owners) {
            // Drop the overlay repaint record with the owner it describes, or it
            // outlives the geometry and a later passage sweep works from bounds
            // for a building that is no longer loaded.
            const closeKey = `${ownerKey}#${bucketKey}`;
            removeCloseFacadeDetail(closeKey);
            overlayOwnersByKey.delete(closeKey);
            const pending = pendingOverlayReplacements.get(bucketKey);
            const replacement = pending?.get(ownerKey);
            if (replacement) {
                disposeOverlayStagedRoot(replacement.staged);
                pending.delete(ownerKey);
                if (pending.size === 0) pendingOverlayReplacements.delete(bucketKey);
            }
            if (overtureBatcher.removeOwner(bucketKey, ownerKey)) changed = true;
        }
    }
    if (!changed) return;
    if (deferAssembly) {
        // A replacement publishes its staged parts in this same turn. Keep the
        // last assembled regional mesh on screen and let the completed tile
        // take the combined remove+add dirt once, after all new parts exist.
        overtureDirtyTiles.add(region);
        return;
    }
    // Re-assemble only the buckets this tile's owners actually left, not every
    // bucket in the region. Scoped so a neighbouring region's pending dirt
    // survives. (This set used to be discarded in favour of region-wide
    // re-assembly, which re-merged and re-uploaded untouched buckets.)
    const changedBuckets = overtureBatcher.takeDirtyBuckets(bucketKeys);
    aggregateWaste.regionQueued += bucketKeys.size;
    aggregateWaste.actuallyDirty += changedBuckets.length;
    if (changedBuckets.length === 0) return;
    // Defer the rebuild to the onFrame drainer. A synchronous whole-region
    // rebuild + GPU re-upload on every tile that drops behind a moving cab is
    // the tunnel-drive stutter; the evicted buildings linger at most a few
    // frames behind the camera, which is invisible. The drainer drops an
    // emptied bucket (and its now-empty region set) once it re-assembles it.
    queueOvertureBuckets(changedBuckets);
}

function resetOvertureAggregateState() {
    clearOverlayPassageRepaint();
    aggregateGate.clear();
    clearCloseFacadeDetails();
    overlayOwnersByKey.clear();
    clearFacadeAtlasPaintQueue();
    for (const [bucketKey, aggregate] of overtureAggregates) {
        if (!surfacePublications?.retire?.(
            buildingAggregatePublicationKey(bucketKey),
            {
                root: aggregate.mesh,
                reason: 'building-aggregate-reset',
            },
        )) {
            disposeOvertureAggregateMesh(aggregate.mesh);
        }
    }
    overtureAggregates.clear();
    overtureBatcher.clear();
    for (const descriptor of overtureBucketDescriptors.values()) descriptor.releaseFacadeMaterial?.();
    overtureBucketDescriptors.clear();
    overtureTileBuckets.clear();
    overtureScopeOwners.clear();
    overtureColorFamilyByBase = new WeakMap();
    overtureExcludedByBase = new WeakMap();
    overtureMaterialIds = new WeakMap();
    nextOvertureMaterialId = 0;
    overtureDirtyTiles.clear();
    pendingOvertureBuckets = [];
    pendingOvertureBucketHead = 0;
    pendingOvertureBucketSet.clear();
    cancelOvertureAssembly();
    disposeFacadeAtlases();
}

function getGreenhouseMaterial(kind) {
    const key = `greenhouse_${kind}`;
    if (buildingMaterials[key]) return buildingMaterials[key];
    let material;
    if (kind === 'glass') {
        material = new THREE.MeshStandardMaterial({
            color: 0xc5d4cc,
            roughness: 0.42,
            metalness: 0.08,
            transparent: true,
            opacity: 0.58,
            depthWrite: true,
            side: THREE.DoubleSide,
            flatShading: true,
        });
    } else if (kind === 'frame') {
        material = new THREE.MeshStandardMaterial({
            color: 0x68736d,
            roughness: 0.72,
            metalness: 0.32,
            side: THREE.DoubleSide,
        });
    } else {
        material = new THREE.MeshStandardMaterial({
            color: 0x637a3d,
            roughness: 1,
            metalness: 0,
            side: THREE.DoubleSide,
        });
    }
    registerShared(material);
    applyNightModeToMaterial(material, false);
    buildingMaterials[key] = material;
    return material;
}

function addGreenhouseRows(polygon, objectId, aLat, aLon) {
    const data = buildGreenhouseRowsGeometry(polygon, aLon, aLat);
    if (!data) return false;
    const ring = polygon.coordinates?.[0];
    // The real complexes sit slightly below the roadside. Terrain remains the
    // authority; this small seating offset only buries the glass/frame toes so
    // a large level agricultural pad never reads as a floating building slab.
    const foundationY = (terrainReference && ring
        ? terrainReference.evidenceFoundationSceneY(ring)
        : 0) - 0.18;
    const addBatch = (positions, material, name, receiveShadow) => {
        if (!positions.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
        );
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.position.y = foundationY;
        mesh.castShadow = false;
        mesh.receiveShadow = receiveShadow;
        mesh.userData.greenhouse = true;
        if (objectId != null) mesh.userData.objectId = objectId;
        setPassageAwareMaterial(mesh, material);
        buildingsGroup.add(mesh);
    };
    // Plants first, then translucent covers and their slim structural lines.
    addBatch(data.plantPositions, getGreenhouseMaterial('plants'), 'GreenhousePlantBeds', true);
    addBatch(data.shellPositions, getGreenhouseMaterial('glass'), 'GreenhouseGlassRows', true);
    addBatch(data.framePositions, getGreenhouseMaterial('frame'), 'GreenhouseFrames', false);
    return true;
}

function addBuildingFeatureOverture(feature, aLat, aLon, tileKey) {
    const objectId = feature.properties && feature.properties.object_id;
    if (objectId != null) {
        if (loadedBuildingIds.has(objectId)) return 0;
        loadedBuildingIds.add(objectId);
        recordTileBuilding(tileKey, objectId);
    }
    const geom = feature.geometry;
    if (!geom) return 0;
    const greenhouse = isGreenhouseBuilding(feature.properties);
    const rawHeight = Number(feature.properties && feature.properties.height);
    // Split's Overture footprints rarely carry height. Reintroduce the stable
    // low-rise estimate from split-sim-3d-realism instead of flattening nearly
    // every building to createBuildingMesh's 3 m minimum.
    const height = greenhouse
        ? GREENHOUSE_RIDGE_HEIGHT_M
        : Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : estimateOvertureBuildingHeight(geom, objectId, aLat);
    const before = buildingsGroup.children.length;
    let added = 0;
    // A mesh feature routed here (a greenhouse — see buildingPipelineForFeature)
    // carries its ground OUTLINE separately, because its geometry is a soup of
    // faces and extruding those would make no sense. Prefer the outline whenever
    // the server sent one; an Overture footprint has none and its geometry IS
    // the outline.
    const outline = feature.properties && feature.properties.footprint;
    const shape = outline && (outline.type === 'Polygon' || outline.type === 'MultiPolygon')
        ? outline
        : geom;
    const polygons = shape.type === 'Polygon'
        ? [shape]
        : shape.type === 'MultiPolygon'
            ? shape.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
            : [];
    // Server-classified transit shelter (see the API's stop-shelter.js): a
    // real shelter model instead of the procedural small-house-with-a-window
    // that used to stand at every equipped stop. A footprint that defeats the
    // fit draws NOTHING — the wrong fallback is exactly the house.
    const shelter = !greenhouse && feature.properties && feature.properties.shelter === true;
    for (const [polygonIndex, polygon] of polygons.entries()) {
        if (shelter) {
            const ring = polygon.coordinates && polygon.coordinates[0];
            const foundationY = terrainReference && ring
                ? terrainReference.evidenceFoundationSceneY(ring)
                : 0;
            const shelterGroup = createStopShelterGroup(polygon, aLat, aLon, foundationY);
            if (shelterGroup) {
                if (objectId != null) shelterGroup.userData.objectId = objectId;
                buildingsGroup.add(shelterGroup);
                added++;
            }
            continue;
        }
        if (greenhouse) {
            if (addGreenhouseRows(polygon, objectId, aLat, aLon)) added++;
            continue;
        }
        buildingsGroup.add(createBuildingMesh(polygon, height, aLon, aLat, objectId));
        addFoundationSkirt(polygon, aLat, aLon, tileKey, objectId);
        const floors = floorsForHeight(height);
        const lowRiseFacadeMaterial = getLowRiseFacadeMaterial(objectId, floors);
        addLowRiseStoneFacadeMesh(
            polygon,
            height,
            objectId,
            aLat,
            aLon,
            lowRiseFacadeMaterial,
        );
        const ring = polygon.coordinates?.[0];
        // Massive-volume halls in the VG band wear large glass panels and a
        // flat membrane roof; never house windows or a pitched roof. The
        // baked airport top-3 always qualify regardless of the lat gate.
        const massiveVg = isMassiveVolumeOverture(ring, height, aLat)
            || (objectId != null && VG_XL_CURTAIN_IDS.has(String(objectId)));
        // Same flat-top path the massive halls take: no pitched roof means the extrusion's own
        // top face is the roof. A holed footprint is flat too: the pitched
        // builders read only the outer ring and would roof its courtyard over.
        const architectureId = architecturalLocationId();
        const roofStyle = activePitchedRoofStyle();
        const holed = polygon.coordinates.length > 1;
        const flatRoofed = massiveVg || holed || hasFlatRoof(architectureId, floors);
        const roofHeight = flatRoofed ? null : proceduralRoofHeightM(ring, aLat);
        let roofData = null;
        if (roofHeight != null) {
            roofData = roofStyle.roofForm === 'gable'
                ? buildGabledRoofGeometry(polygon, height, roofHeight, aLon, aLat)
                : buildHippedRoofGeometry(polygon, height, roofHeight, aLon, aLat);
            // A badly self-intersecting footprint cannot be ear-clipped into a
            // gable. Keep that one building roofed without changing Zagreb's
            // established hipped-roof path.
            if (!roofData && roofStyle.roofForm === 'gable') {
                roofData = buildHippedRoofGeometry(polygon, height, roofHeight, aLon, aLat);
            }
        }
        if (roofData) {
            const foundationY = terrainReference
                ? terrainReference.evidenceFoundationSceneY(ring)
                : 0;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(roofData.positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(roofData.uvs, 2));
            geometry.computeVertexNormals();
            const material = getRoofMaterial(objectId);
            const roof = new THREE.Mesh(geometry, material);
            roof.position.y = foundationY;
            roof.castShadow = true;
            roof.receiveShadow = true;
            roof.userData.baseBuildingRoof = true;
            setPassageAwareMaterial(roof, material);
            buildingsGroup.add(roof);

            if (roofData.gablePositions?.length) {
                const gableGeometry = new THREE.BufferGeometry();
                gableGeometry.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(roofData.gablePositions, 3),
                );
                if (lowRiseFacadeMaterial) {
                    gableGeometry.setAttribute(
                        'uv',
                        new THREE.Float32BufferAttribute(buildMetricTriangleUvs(roofData.gablePositions), 2),
                    );
                }
                gableGeometry.computeVertexNormals();
                const gableMaterial = lowRiseFacadeMaterial
                    || (objectId != null ? getOvertureWallMaterial(objectId) : buildingMaterial);
                const gables = new THREE.Mesh(gableGeometry, gableMaterial);
                gables.position.y = foundationY;
                gables.castShadow = true;
                gables.receiveShadow = true;
                if (objectId != null) gables.userData.objectId = objectId;
                setPassageAwareMaterial(gables, gableMaterial);
                buildingsGroup.add(gables);
            }
        }
        if (!roofData) {
            const foundationY = terrainReference && ring
                ? terrainReference.evidenceFoundationSceneY(ring)
                : 0;
            addOvertureFlatRoofCap(
                polygon,
                height,
                objectId,
                aLat,
                aLon,
                foundationY,
                polygonIndex,
            );
        }
        if (massiveVg) {
            addCurtainWallMesh(polygon, height, objectId, aLat, aLon);
        } else {
            // The old branch emitted one mesh per wall. Group equal-width
            // faces by bay count so a typical rectangle needs two facade draw
            // calls while retaining correct window density and the current
            // terrain foundation.
            addOvertureFacadeMeshes(polygon, height, objectId, aLat, aLon, tileKey);
        }
        // A perimeter block's courtyard is a footprint HOLE, and nothing was
        // ever drawn inside it — the block enclosed bare ground. New-build
        // courts get lawn, a paved perimeter path, planting and benches, in one
        // merged mesh sharing the roof decor's material.
        if (isProposalBuildingObjectId(objectId)) {
            const courtyard = buildNewBuildCourtyardMesh(
                polygon.coordinates,
                aLat,
                aLon,
                hashObjectId(objectId),
                feature?.properties?.__proposalCourtyardRings || null,
            );
            if (courtyard) {
                courtyard.position.y = terrainReference && ring
                    ? terrainReference.evidenceFoundationSceneY(ring)
                    : 0;
                courtyard.userData.objectId = objectId;
                buildingsGroup.add(courtyard);
            }
        }
        added++;
    }
    tagNewChildren(buildingsGroup, before, tileKey);
    // Decompose everything this building just added into the per-tile merged
    // aggregates. Non-mergeable meshes stay behind, tagged and individual.
    captureBuildingMeshesForBatching(feature, tileKey, before, 'overture');
    return added;
}

function getDemolitionGhostMaterials() {
    if (!demolitionGhostMaterial) {
        demolitionGhostMaterial = new THREE.MeshBasicMaterial({
            color: 0xff7a45,
            transparent: true,
            opacity: 0.16,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        demolitionGhostEdgeMaterial = new THREE.LineBasicMaterial({
            color: 0xff9a72,
            transparent: true,
            opacity: 0.62,
            depthWrite: false,
        });
        registerShared(demolitionGhostMaterial, demolitionGhostEdgeMaterial);
    }
    return { fill: demolitionGhostMaterial, edge: demolitionGhostEdgeMaterial };
}

function createFootprintGhostGeometry(polygon, heightM, aLon, aLat) {
    const rings = polygon?.coordinates || [];
    if (!Array.isArray(rings[0]) || rings[0].length < 3) return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const pathFromRing = (ring, PathType) => {
        const path = new PathType();
        let pointCount = 0;
        for (const coordinate of ring || []) {
            const lon = Number(coordinate?.[0]);
            const lat = Number(coordinate?.[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            const x = (lon - aLon) * scaleLon;
            const y = (lat - aLat) * scaleLat;
            if (pointCount === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
            pointCount += 1;
        }
        return pointCount >= 3 ? path : null;
    };
    const shape = pathFromRing(rings[0], THREE.Shape);
    if (!shape) return null;
    for (const holeRing of rings.slice(1)) {
        const hole = pathFromRing(holeRing, THREE.Path);
        if (hole) shape.holes.push(hole);
    }
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(1, Number(heightM) || 3),
        bevelEnabled: false,
    });
    geometry.rotateX(-Math.PI / 2);
    return geometry;
}

function createGdiGhostGeometry(feature, aLat, aLon) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'MultiPolygon') return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const zMin = Number(feature?.properties?.z_min) || 0;
    const positions = [];
    for (const polygonCoordinates of geometry.coordinates || []) {
        const vertices = localizeGdiFace(
            polygonCoordinates,
            zMin,
            aLat,
            aLon,
            scaleLon,
            scaleLat,
        );
        for (let index = 1; index < vertices.length - 1; index++) {
            positions.push(...vertices[0], ...vertices[index], ...vertices[index + 1]);
        }
    }
    if (positions.length === 0) return null;
    const ghostGeometry = new THREE.BufferGeometry();
    ghostGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    ghostGeometry.computeVertexNormals();
    return ghostGeometry;
}

function addDemolitionGhostGeometry(geometry, baseY, objectId, tileKey) {
    if (!geometry) return;
    const materials = getDemolitionGhostMaterials();
    const fill = new THREE.Mesh(geometry, materials.fill);
    fill.name = 'ProposalTrackDemolishedBuildingGhost';
    fill.position.y = baseY;
    fill.renderOrder = 8;
    fill.userData.proposalTrackDemolitionGhost = true;
    if (tileKey != null) fill.userData.tileKey = tileKey;
    if (objectId != null) fill.userData.objectId = objectId;
    buildingsGroup.add(fill);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), materials.edge);
    edges.name = 'ProposalTrackDemolishedBuildingOutline';
    edges.position.y = baseY;
    edges.renderOrder = 9;
    edges.userData.proposalTrackDemolitionGhost = true;
    if (tileKey != null) edges.userData.tileKey = tileKey;
    if (objectId != null) edges.userData.objectId = objectId;
    buildingsGroup.add(edges);
}

function addProposalTrackDemolitionGhost(feature, aLat, aLon, tileKey) {
    const objectId = feature?.properties?.object_id;
    if (objectId != null) {
        if (loadedBuildingIds.has(objectId)) return 0;
        loadedBuildingIds.add(objectId);
        recordTileBuilding(tileKey, objectId);
    }
    const geometry = feature?.geometry;
    if (!geometry) return 0;
    if (BUILDING_SOURCE === 'gdi') {
        addDemolitionGhostGeometry(
            createGdiGhostGeometry(feature, aLat, aLon),
            0,
            objectId,
            tileKey,
        );
        return 1;
    }
    const rawHeight = Number(feature?.properties?.height ?? feature?.properties?.z_delta);
    const heightM = isGreenhouseBuilding(feature?.properties)
        ? GREENHOUSE_RIDGE_HEIGHT_M
        : Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : BUILDING_SOURCE === 'overture'
            ? estimateOvertureBuildingHeight(geometry, objectId, aLat)
            : 3;
    const polygons = geometry.type === 'Polygon'
        ? [geometry]
        : geometry.type === 'MultiPolygon'
            ? geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
            : [];
    for (const polygon of polygons) {
        const ring = polygon.coordinates?.[0];
        const baseY = terrainReference && ring
            ? terrainReference.evidenceFoundationSceneY(ring)
            : 0;
        addDemolitionGhostGeometry(
            createFootprintGhostGeometry(polygon, heightM, aLon, aLat),
            baseY,
            objectId,
            tileKey,
        );
    }
    return polygons.length > 0 ? 1 : 0;
}

// Every building contributes its lng/lat bbox (→ local metres) to the
// ground-cover mask: paved catch-all near houses, grassland beyond.
function noteBuildingGroundCoverage(feature) {
    const coordinates = feature?.geometry?.coordinates;
    if (!coordinates) return;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const walk = (node) => {
        if (!Array.isArray(node)) return;
        if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
            if (node[0] < minLon) minLon = node[0];
            if (node[0] > maxLon) maxLon = node[0];
            if (node[1] < minLat) minLat = node[1];
            if (node[1] > maxLat) maxLat = node[1];
            return;
        }
        for (const child of node) walk(child);
    };
    walk(coordinates);
    // Degenerate or continent-sized bboxes are data errors, not coverage.
    if (!Number.isFinite(minLon) || !Number.isFinite(minLat)
        || maxLon - minLon > 0.02 || maxLat - minLat > 0.02) return;
    const mPerDeg = DEG_TO_RAD * EARTH_RADIUS_M;
    const scaleLon = mPerDeg * Math.cos(anchorLat * DEG_TO_RAD);
    groundCoverNoteBuildingRect(
        (minLon - anchorLon) * scaleLon,
        -(maxLat - anchorLat) * mPerDeg,
        (maxLon - anchorLon) * scaleLon,
        -(minLat - anchorLat) * mPerDeg,
    );
}

// A mesh whose SOURCE stated its material, drawn exactly as it was modelled.
//
// No procedural windows, no roof-palette classification, no facade grid: those
// exist to invent a look for a survey mesh that has none, and a mesh that came
// with a material has already been given one. The rule is deliberately about
// the DATA and not about landmarks — the client never learns that these are
// hand-modelled, only that the source specified how they should look.
//
// Colour rides in a vertex attribute over a shared white material, which is the
// same trick the roof and Overture-wall families use. Every part in the city
// that agrees on (kind, optics) then shares one material and merges into one
// bucket, so 200-odd landmark parts cost a handful of draw calls rather than
// one each.
const statedMaterialFamilies = new Map();   // kind|optics -> { material, kind, lightsUp }

// A stated part may also declare a procedural texture ({kind:'brick', scale,
// accent, mortar} riding on landmark_mesh.texture). The generated map carries
// the tones — base colour included — so the part's vertex colour goes WHITE and
// the (kind, optics, texture) triple forms its own material family. One shared
// DataTexture per palette: every part on a landmark reuses it, and a second
// landmark with the same brick would too.
const statedBrickTextures = new Map();      // base|accent|mortar -> DataTexture

function statedBrickTexture(baseHex, texture) {
    const key = `${baseHex}|${texture.accent || ''}|${texture.mortar || ''}`;
    let map = statedBrickTextures.get(key);
    if (map) return map;
    const size = 256;
    map = new THREE.DataTexture(
        brickTextureData(size, `#${baseHex}`, `#${texture.accent || 'a5654c'}`,
            `#${texture.mortar || 'b6aa96'}`),
        size, size, THREE.RGBAFormat,
    );
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.needsUpdate = true;
    statedBrickTextures.set(key, map);
    return map;
}

function statedTextureConfig(stated) {
    return stated.texture && stated.texture.kind === 'brick' ? stated.texture : null;
}

// A mesh that states an emissive colour has told us it lights up after dark, so
// it goes through the SAME dusk switch as every other building rather than a
// layer of its own — setBuildingNightMode() drives both. How bright lives in
// core/stated-night-lights.js, where it can be tested without a browser.

function statedMaterialFamily(stated) {
    const texture = statedTextureConfig(stated);
    // Textured parts paint their tones through the map, so the vertex colour
    // must stay white — a `#c9a183` vertex under a `#c9a183` map would square
    // the tint. The base colour still keys the family: it is baked into the map.
    const color = new THREE.Color(texture ? '#ffffff' : `#${stated.color || 'ffffff'}`);
    const key = `${stated.kind}|${stated.metalness}|${stated.roughness}`
        + `|${stated.env_map_intensity}|${stated.emissive || ''}`
        + (texture ? `|brick:${stated.color}:${texture.accent}:${texture.mortar}:${texture.scale}` : '');
    let family = statedMaterialFamilies.get(key);
    if (family) return { material: family.material, color };
    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        side: THREE.DoubleSide,
        ...(texture ? { map: statedBrickTexture(stated.color || 'c9a183', texture) } : {}),
        metalness: Number.isFinite(stated.metalness) ? stated.metalness : 0.1,
        roughness: Number.isFinite(stated.roughness) ? stated.roughness : 0.8,
        envMapIntensity: Number.isFinite(stated.env_map_intensity) ? stated.env_map_intensity : 1,
        // Born already lit when the family is minted after dusk. Landmarks
        // STREAM, so a family first seen at 22:00 would otherwise stay dark for
        // the rest of the session — the dusk switch had already fired and only
        // walks families that existed when it did.
        ...(stated.emissive ? {
            emissive: new THREE.Color(`#${stated.emissive}`),
            emissiveIntensity: statedNightIntensity(stated.kind, isNightMode),
        } : {}),
    });
    registerShared(material);
    family = { material, kind: stated.kind, lightsUp: !!stated.emissive };
    statedMaterialFamilies.set(key, family);
    return { material, color };
}

function addBuildingFeatureStatedMaterial(feature, aLat, aLon, tileKey) {
    const geometry = feature?.geometry;
    if (!geometry || geometry.type !== 'MultiPolygon' || !buildingsGroup) return 0;
    const stated = feature.properties.material;
    const { material, color } = statedMaterialFamily(stated);
    const zMin = Number(feature.properties.z_min) || 0;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(aLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;

    const positions = [];
    for (const polygon of geometry.coordinates) {
        const face = localizeGdiFace(polygon, zMin, aLat, aLon, scaleLon, scaleLat);
        // Fan-triangulate the face. These are modelled faces, already convex
        // and usually triangles to begin with.
        for (let i = 1; i + 1 < face.length; i++) {
            positions.push(...face[0], ...face[i], ...face[i + 1]);
        }
    }
    if (positions.length === 0) return 0;

    const colors = new Float32Array(positions.length);
    for (let i = 0; i < colors.length; i += 3) {
        colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const texture = statedTextureConfig(stated);
    if (texture) {
        // Box-projected in local metres so the bond runs continuously across
        // the facade; the batching capture carries `uv` into merged buckets.
        geo.setAttribute('uv', new THREE.BufferAttribute(
            boxProjectedUvs(positions, Number(texture.scale) || 1.8), 2,
        ));
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    if (feature.properties.object_id != null) mesh.userData.objectId = feature.properties.object_id;
    // Authored base-at-0 like a GDI mesh, so it takes the same terrain lift.
    mesh.position.y = terrainReference && Number.isFinite(zMin)
        ? terrainReference.absoluteToSceneY(zMin) : 0;
    setPassageAwareMaterial(mesh, material);
    buildingsGroup.add(mesh);
    return 1;
}

function addBuildingFeature(feature, tileKey, buildContext = null) {
    if (!belongsInBuildingLayer(feature?.properties)) return 0;
    if (isBlockedBuildingObjectId(feature?.properties?.object_id)) return 0;
    const demolishedByTrack = !!feature?.properties?.__proposalTrackDemolished;
    // Checked before the survey paths: a stated material means the source has
    // already decided how this looks, and running it through the facade/roof
    // machinery would paint windows onto a modelled landmark.
    if (!demolishedByTrack && feature?.properties?.material) {
        // Stated-material parts dedupe globally by id like every other building:
        // a landmark part whose outline spans two streamed tiles otherwise
        // builds once per tile, and the exact coincident copies z-fight along
        // the facade edges. The key is source-namespaced because landmark part
        // ids are small row ids that would collide with raw GDI object ids in
        // the shared set.
        const statedId = feature.properties.object_id ?? feature.properties.id;
        const statedKey = statedId == null
            ? null
            : `${feature.properties.source || 'stated'}:${statedId}`;
        if (statedKey != null && loadedBuildingIds.has(statedKey)) return 0;
        const before = buildingsGroup ? buildingsGroup.children.length : 0;
        const added = addBuildingFeatureStatedMaterial(feature, anchorLat, anchorLon, tileKey);
        if (added > 0) {
            if (statedKey != null) {
                loadedBuildingIds.add(statedKey);
                recordTileBuilding(tileKey, statedKey);
            }
            statedMaterialsDrawn += added;
            tagNewChildren(buildingsGroup, before, tileKey);
            captureBuildingMeshesForBatching(
                feature, tileKey, before, feature.properties.source || 'stated');
            for (let i = before; i < buildingsGroup.children.length; i++) {
                registerBuildingEntityTree(buildingsGroup.children[i], feature, 'stated');
            }
        }
        return added;
    }
    if (!demolishedByTrack && BUILDING_SOURCE === 'gdi') {
        return runBuildingBuildTaskToCompletion(
            createGdiBuildingBuildTask(feature, tileKey, buildContext),
        );
    }
    // Agricultural glass covers contain soil and plants, not a paved urban
    // building apron. Their own low plant-bed geometry supplies the near view.
    if (!isGreenhouseBuilding(feature?.properties)) noteBuildingGroundCoverage(feature);
    // Footprint mask: skip the cadastre building when a PROPOSED BUILDING stands on its plot. We
    // sample the centroid + the 4 AABB corners and mask if ANY is inside — centroid-only missed
    // buildings that straddle the proposal boundary, leaving the player standing on a rooftop above
    // what should have been the new block. Cheap (5 point-in-polygon tests with AABB pre-filter
    // inside) and a no-op when no proposals are loaded.
    //
    // Roads, parks, squares and lakes do NOT mask buildings away here any more: what they did to a
    // building — razed / cut / tunnelled under — was decided by the server and already applied to
    // this feature by applyProposalCarve() at intake. Masking them here as well would delete the
    // tunnelled ones the carve deliberately spared.
    //
    // The proposal's OWN buildings are exempt: a proposed building stands inside
    // its own substitution mask by definition, so the test would eat exactly
    // the thing the mask exists to make room for.
    const proposalBuilding = isProposalBuildingFeature(feature);
    if (!demolishedByTrack && !proposalBuilding && isFeatureMaskedByProposalBuildings(feature)) return 0;
    const c = featureCentroidLatLon(feature);
    const before = buildingsGroup ? buildingsGroup.children.length : 0;
    let added;
    if (demolishedByTrack)                   added = addProposalTrackDemolitionGhost(feature, anchorLat, anchorLon, tileKey);
    else if (BUILDING_SOURCE === 'overture') added = addBuildingFeatureOverture(feature, anchorLat, anchorLon, tileKey);
    else                                     added = addBuildingFeatureFootprint(feature, anchorLat, anchorLon, tileKey);
    // GDI meshes are authored with their base at local y=0 (the gdi z_min is
    // subtracted off in localizeGdiFace), i.e. they sit on the scene anchor plane
    // regardless of the ground beneath them. That only matches the terrain near
    // spawn (where terrain ≈ anchor); uphill the DGU surface rises above the anchor
    // and buries them, downhill it drops and they float. With DGU terrain active,
    // lift every freshly added GDI mesh by its surveyed absolute base (gdi z_min)
    // so the photogrammetric footprint meets the real ground. GDI and DGU are both
    // EVRF2000, so a realistic z_min lands on the realistic terrain.
    if (added > 0 && buildingsGroup && BUILDING_SOURCE === 'gdi' && terrainReference) {
        const zMin = Number(feature?.properties?.z_min);
        if (Number.isFinite(zMin)) {
            const baseY = terrainReference.absoluteToSceneY(zMin);
            for (let i = before; i < buildingsGroup.children.length; i++) {
                buildingsGroup.children[i].position.y += baseY;
            }
        }
    }
    // Stamp centroid on each emitted mesh so a late-arriving proposal
    // load can sweep already-rendered buildings (see pruneBuildingsByMask).
    if (added > 0 && c && buildingsGroup) {
        for (let i = before; i < buildingsGroup.children.length; i++) {
            buildingsGroup.children[i].userData.centroidLatLon = c;
        }
    }
    // A proposal building's meshes obey the display toggle (solid ↔ ghost ↔
    // off) — consulted at creation so a mesh built after a toggle lands in the
    // right state. Merged siblings get the same treatment where their
    // aggregate is assembled (see assembleOvertureBuckets).
    if (added > 0 && proposalBuilding && buildingsGroup) {
        for (let i = before; i < buildingsGroup.children.length; i++) {
            buildingsGroup.children[i].userData.proposalBuilding = true;
            buildingsGroup.children[i].visible = proposalBuildingMeshesVisible;
        }
    }
    if (added > 0 && buildingsGroup) {
        for (let i = before; i < buildingsGroup.children.length; i++) {
            registerBuildingEntityTree(buildingsGroup.children[i], feature, BUILDING_SOURCE);
        }
    }
    return added;
}

function buildingFeatureNeedsTerrainEvidence(feature) {
    if (!terrainReference) return false;
    // Survey/GDI meshes and stated landmark parts carry an absolute vertical
    // datum. Their optional foundation skirt is rebuilt when terrain arrives,
    // but the authored body itself is not terrain-relative.
    if (BUILDING_SOURCE === 'gdi') return false;
    if (feature?.properties?.material) return false;
    return true;
}

function buildingTerrainFootprintOuterRings(feature) {
    const explicit = feature?.properties?.footprint;
    const geometry = explicit?.type === 'Polygon' || explicit?.type === 'MultiPolygon'
        ? explicit
        : feature?.geometry;
    if (geometry?.type === 'Polygon') {
        return Array.isArray(geometry.coordinates?.[0])
            ? [geometry.coordinates[0]]
            : [];
    }
    if (geometry?.type === 'MultiPolygon') {
        return (geometry.coordinates || [])
            .map(polygon => polygon?.[0])
            .filter(ring => Array.isArray(ring));
    }
    return [];
}

function buildingTerrainEvidenceState(feature) {
    if (typeof terrainReference?.evidenceFoundationSceneY !== 'function') return 'pending';
    const rings = buildingTerrainFootprintOuterRings(feature);
    if (rings.length === 0) return 'pending';
    let hasNoData = false;
    for (const ring of rings) {
        if (finiteOrNull(terrainReference.evidenceFoundationSceneY(ring)) !== null) continue;
        const points = (ring || []).filter(point => (
            Array.isArray(point)
            && finiteOrNull(point[0]) !== null
            && finiteOrNull(point[1]) !== null
        ));
        if (points.length === 0) return 'pending';
        const center = points.reduce((sum, point) => ({
            lon: sum.lon + Number(point[0]),
            lat: sum.lat + Number(point[1]),
        }), { lon: 0, lat: 0 });
        const sampledPoints = [
            ...points,
            [center.lon / points.length, center.lat / points.length],
        ];
        if (!sampledPoints.every(point => (
            terrainReference.hasLoadedCoreCoverageAt?.(point[0], point[1]) === true
        ))) return 'pending';
        hasNoData = true;
    }
    return hasNoData ? 'no-data' : 'ready';
}

function advanceBuildingRoadFormationDependency() {
    return advanceRoadFormationDependency(terrainReference?.roadFormation);
}

function createBuildingFeatureWorkItem(feature, tileKey, buildContext, source = null) {
    let task = null;
    let done = false;
    let inProgress = false;
    let lastPhase = 'queued';
    let dependencyPending = false;
    const visibilityBounds = buildingVisibilityBounds(feature);
    const enqueuedAtMs = buildingNowMs();

    function step() {
        if (done) return 'done';
        // Buildings are downstream of the first coherent ground publication.
        // Fetch their inputs concurrently, but do not construct a foundation
        // against the provisional startup surface and then rebuild the tile.
        // The ground producer has no building-layer dependency; decoded tile
        // delivery has already returned its global network slot.
        if (initialBuildingGroundCoordinator) {
            lastPhase = 'ground-startup-wait';
            dependencyPending = true;
            return 'defer';
        }
        dependencyPending = false;
        return withTileBuildingSource(source, () => {
            if (buildingFeatureNeedsTerrainEvidence(feature)) {
                const terrainEvidenceState = buildingTerrainEvidenceState(feature);
                if (terrainEvidenceState !== 'ready') {
                    inProgress = false;
                    if (terrainEvidenceState === 'no-data') {
                        lastPhase = 'terrain-no-data';
                        done = true;
                        return 'done';
                    }
                    // Named, and ranked behind runnable siblings until the
                    // evidence lands (see buildingWorkItemPriority).
                    lastPhase = 'terrain-evidence-wait';
                    dependencyPending = true;
                    return 'defer';
                }
                dependencyPending = false;
            }
            const stagedGdi = BUILDING_SOURCE === 'gdi'
                && !feature?.properties?.__proposalTrackDemolished;
            if (stagedGdi) {
                if (!task) task = createGdiBuildingBuildTask(feature, tileKey, buildContext);
                // The formation can become dirty AFTER the generator's first
                // foundation readiness check: road tiles keep streaming while
                // this detached building advances one skirt sample per frame.
                // Re-check at every sampling boundary. Otherwise one nominally
                // tiny `sceneYAtLocal()` call invokes RoadFormationModel's
                // synchronous compatibility builder; object 65021 measured
                // 210 ms inside one `foundation-skirt-geometry` queue item.
                const samplingFoundation = lastPhase === 'foundation-formation-wait'
                    || lastPhase === 'foundation-skirt-segments'
                    || lastPhase === 'foundation-skirt-geometry';
                const formationChangeTouches = samplingFoundation
                    && pendingRoadFormationChangeTouches(terrainReference?.roadFormation,
                        visibilityBounds, FOUNDATION_FORMATION_REACH_M);
                if (formationChangeTouches && !roadFormationWaitExpired(
                    formationWaitStartMs(terrainReference?.roadFormation), performance.now(),
                    foundationFormationWaitAllowanceMs(getFrameChunkWorkMotionState()))) {
                    lastPhase = 'foundation-formation-wait';
                    const dependencyStatus = advanceBuildingRoadFormationDependency();
                    inProgress = dependencyStatus === 'repeat';
                    return dependencyStatus;
                }
                const outcome = task.step();
                lastPhase = outcome.phase || (outcome.done ? 'done' : lastPhase);
                done = outcome.done;
                if (done) {
                    inProgress = false;
                    return 'done';
                }
                if (outcome.phase === 'foundation-formation-wait') {
                    const dependencyStatus = advanceBuildingRoadFormationDependency();
                    inProgress = dependencyStatus === 'repeat';
                    return dependencyStatus === 'ready' ? 'repeat' : dependencyStatus;
                }
                inProgress = outcome.phase !== 'reservation-wait';
                return inProgress ? 'repeat' : 'defer';
            }
            // Footprint buildings still publish their inexpensive geometry in
            // one synchronous item. Prepare a dirty road-formation generation
            // through bounded queue stages first: querying it from the sampler
            // would synchronously complete 250-300 ms of road work. Wait before
            // reserving the object id or exposing any partial live geometry.
            const footprintChangeTouches = BUILDING_SOURCE === 'overture'
                && pendingRoadFormationChangeTouches(terrainReference?.roadFormation,
                    visibilityBounds, FOUNDATION_FORMATION_REACH_M);
            if (footprintChangeTouches && !roadFormationWaitExpired(
                formationWaitStartMs(terrainReference?.roadFormation), performance.now(),
                foundationFormationWaitAllowanceMs(getFrameChunkWorkMotionState()))) {
                const dependencyStatus = advanceBuildingRoadFormationDependency();
                inProgress = dependencyStatus === 'repeat';
                return dependencyStatus;
            }
            addBuildingFeature(feature, tileKey, buildContext);
            lastPhase = 'footprint-sync';
            done = true;
            inProgress = false;
            return 'done';
        });
    }

    function cancel(reason = null) {
        if (done) return;
        done = true;
        inProgress = false;
        task?.cancel(reason);
    }

    const item = {
        feature,
        pipeline: source,
        visibilityBounds,
        enqueuedAtMs,
        step,
        cancel,
        isDone: () => done,
        isInProgress: () => inProgress && !done,
        dependencyPending: () => dependencyPending && !done,
        lastPhase: () => lastPhase,
        viewPriority: () => classifyBuildingWorkItem(item),
    };
    return item;
}

function describeBuildingFeatureWorkItem(item) {
    if (item?.pipeline === 'tile-finalize') {
        return `tile-finalize [${item.lastPhase?.() || 'unknown-stage'}]`;
    }
    const properties = item?.feature?.properties || {};
    const objectId = properties.object_id ?? properties.id ?? 'anonymous';
    const source = properties.source || 'unknown-source';
    const pipeline = item?.pipeline || 'unknown-pipeline';
    const geometry = item?.feature?.geometry;
    const partCount = geometry?.type === 'MultiPolygon'
        ? geometry.coordinates?.length || 0
        : geometry ? 1 : 0;
    return `${pipeline}/${source} ${objectId} ${geometry?.type || 'no-geometry'} ${partCount} parts`
        + ` [${item?.lastPhase?.() || 'unknown-stage'}]`;
}

function advanceBuildingFeatureWorkItem(item) {
    const status = item.step();
    if (status === 'defer') return FRAME_CHUNK_WAIT_ITEM;
    return status === 'done' ? undefined : FRAME_CHUNK_REPEAT_ITEM;
}

function cancelBuildingFeatureWorkItems(items, reason) {
    for (const item of items || []) item?.cancel?.(reason);
}

function createBuildingTileFinalizationWorkItem({
    tileKey,
    tileSourceKind,
    buildContext,
    featureWorkItems,
    onComplete,
}) {
    const [tx, tz] = String(tileKey).split('_').map(Number);
    const visibilityBounds = Number.isFinite(tx) && Number.isFinite(tz)
        ? tileLocalBounds(tx, tz, DETAILED_BUILDING_TILE_M)
        : null;
    let stageIndex = 0;
    let done = false;
    let awaitedBuckets = null;
    let lastPhase = 'tile-wait';
    let contactAoTask = null;
    const stages = [
        {
            label: 'tile-contact-ao',
            step: () => withTileBuildingSource(tileSourceKind, () => {
                if (!contactAoTask) {
                    contactAoTask = createContactAoFinalizationTask(buildContext, tileKey);
                    if (!contactAoTask) return true;
                }
                const outcome = contactAoTask.step();
                lastPhase = `tile-contact-ao:${outcome.phase || 'complete'}`;
                return outcome.done;
            }),
        },
        {
            label: 'tile-roof-drainage',
            run: () => withTileBuildingSource(
                tileSourceKind,
                () => addRoofDrainageBatch(buildContext, tileKey),
            ),
        },
        {
            label: 'tile-replacement-parts',
            run: () => publishTileVisualReplacementAggregates(tileKey),
        },
        {
            label: 'tile-aggregate-queue',
            run: () => { awaitedBuckets = queueTileAggregates(tileKey); },
        },
        {
            label: 'tile-coverage-gate',
            run: () => {
                aggregateGate.await(tileKey, awaitedBuckets, () => {
                    const replacement = finishTileVisualReplacement(tileKey);
                    publishDetailedTile(
                        tileKey,
                        tileBuildings.get(String(tileKey)),
                        replacement?.retainedDetailedIds,
                    );
                    // World-ready means the detailed meshes are actually on
                    // screen, not merely that their upload was queued. The old
                    // signal ran in the next finalization stage and revealed
                    // GTA while these four observer tiles were still LOD1.
                    noteInitialNearTileReady(tileKey);
                });
            },
        },
        {
            label: 'tile-complete',
            run: () => {
                logStreetFacingSummary(buildContext, `tile ${tileKey}`);
                if (typeof onComplete === 'function') onComplete();
            },
        },
    ];

    const item = {
        feature: null,
        pipeline: 'tile-finalize',
        visibilityBounds,
        step() {
            if (done) return 'done';
            // The queue may select by view priority, but finalization cannot
            // overtake any feature whose detached transaction is incomplete.
            if (featureWorkItems.some(featureItem => !featureItem.isDone())) return 'defer';
            const stage = stages[stageIndex];
            lastPhase = stage.label;
            if (typeof stage.step === 'function' && !stage.step()) return 'repeat';
            if (typeof stage.run === 'function') stage.run();
            stageIndex += 1;
            done = stageIndex >= stages.length;
            return done ? 'done' : 'repeat';
        },
        cancel(reason = null) {
            contactAoTask?.cancel(reason);
            done = true;
        },
        isDone: () => done,
        isInProgress: () => stageIndex > 0 && !done,
        lastPhase: () => lastPhase,
        viewPriority: () => {
            if (featureWorkItems.some(featureItem => !featureItem.isDone())) {
                return { score: -Number.MAX_SAFE_INTEGER };
            }
            return classifyViewPriority(visibilityBounds, currentBuildingView());
        },
    };
    return item;
}

function createStaticContactAoFinalizationWorkItem(buildContext) {
    let task = null;
    let done = false;
    let inProgress = false;
    let lastPhase = 'contact-ao-wait';
    const item = {
        feature: null,
        pipeline: 'contact-ao-finalize',
        visibilityBounds: null,
        step() {
            if (done) return 'done';
            if (!task) {
                task = createContactAoFinalizationTask(buildContext, null);
                if (!task) {
                    done = true;
                    return 'done';
                }
            }
            inProgress = true;
            const outcome = task.step();
            lastPhase = `contact-ao:${outcome.phase || 'complete'}`;
            done = outcome.done;
            inProgress = !done;
            return done ? 'done' : 'repeat';
        },
        cancel(reason = null) {
            task?.cancel(reason);
            done = true;
            inProgress = false;
        },
        isDone: () => done,
        isInProgress: () => inProgress && !done,
        lastPhase: () => lastPhase,
        viewPriority: () => classifyBuildingWorkItem(item),
    };
    return item;
}

// Building roots can be nested model groups (for example transit shelters).
// Geometry belongs to the removed tree; materials/textures retain their
// separate cache ownership and must survive other buildings using them.
function disposeBuildingGeometry(root) {
    const disposed = new Set();
    root.traverse((child) => {
        const geometry = child.geometry;
        if (!geometry || isShared(geometry) || disposed.has(geometry)) return;
        disposed.add(geometry);
        geometry.dispose();
    });
}

// Late-bound mask sweep. Called by the proposals layer after its async
// fetch resolves: any building rendered before the proposal polygons
// were known gets pruned here. maskFn(lat, lon) returns true when the
// point falls inside a proposal footprint — same semantics as the
// inline isMaskedByProposals check above.
export function pruneBuildingsByMask(maskFn) {
    contactAoMaskRevision += 1;
    if (!buildingsGroup) return 0;
    const survivors = [];
    let removed = 0;
    for (const child of buildingsGroup.children) {
        // The sweep removes what a proposal REPLACED — never the proposal's own
        // buildings (or their AO batch), which stand inside their own mask by
        // definition. Checked before the AO branch: a proposal tile's AO batch
        // carries entries whose centroids all sit in the mask, and the per-entry
        // filter below would empty it.
        if (child.userData && child.userData.proposalBuilding) {
            survivors.push(child);
            continue;
        }
        const aoEntries = child.userData && child.userData.contactAoEntries;
        if (Array.isArray(aoEntries)) {
            const keptEntries = aoEntries.filter((entry) => {
                const c = entry.centroidLatLon;
                return !c || !maskFn(c.lat, c.lon);
            });
            if (keptEntries.length === 0) {
                disposeBuildingGeometry(child);
                removed++;
                continue;
            }
            if (keptEntries.length !== aoEntries.length) {
                const oldPositions = child.geometry.getAttribute('position').array;
                const oldColors = child.geometry.getAttribute('color').array;
                const positions = [];
                const colors = [];
                const rebuiltEntries = [];
                for (const entry of keptEntries) {
                    const start = positions.length / 3;
                    appendArrayValues(
                        positions,
                        oldPositions.subarray(entry.start * 3, (entry.start + entry.count) * 3),
                    );
                    appendArrayValues(
                        colors,
                        oldColors.subarray(entry.start * 4, (entry.start + entry.count) * 4),
                    );
                    rebuiltEntries.push({ ...entry, start });
                }
                const rebuilt = buildContactAoMesh(positions, colors);
                child.geometry.dispose();
                child.geometry = rebuilt.geometry;
                child.userData.contactAoEntries = rebuiltEntries;
            }
            survivors.push(child);
            continue;
        }
        const c = child.userData && child.userData.centroidLatLon;
        if (c && maskFn(c.lat, c.lon)) {
            disposeBuildingGeometry(child);
            unregisterEntityTree(child);
            const oid = child.userData && child.userData.objectId;
            if (oid != null) {
                loadedBuildingIds.delete(oid);
                buildingEntrances.delete(oid);
                buildingEntranceIndex.delete(oid);
                buildingFootprints.delete(oid);
                buildingFootprintIndex.delete(oid);
                unregisterRoofActivityOwner(roofActivityOwnerId(oid));
                setDetailed(oid, false);   // detail carved away — far box returns
            }
            removed++;
        } else {
            survivors.push(child);
        }
    }
    if (removed > 0) {
        buildingsGroup.children = survivors;
        onCountChanged(buildingsGroup.children.length);
    }
    return removed;
}

// ─── Eviction (when the shared tile source drops a tile) ───────────────────

function releaseTileBuildingRecords(tileKey, { releaseDetailedLod = false } = {}) {
    const key = String(tileKey);
    const ids = tileBuildings.get(key);
    if (!ids) return new Set();
    const releasedIds = new Set(ids);
    for (const id of ids) {
        loadedBuildingIds.delete(id);
        buildingEntrances.delete(id);
        buildingEntranceIndex.delete(id);
        buildingFootprints.delete(id);
        buildingFootprintIndex.delete(id);
        unregisterRoofActivityOwner(roofActivityOwnerId(id));
        if (releaseDetailedLod) setDetailed(id, false);
    }
    tileBuildings.delete(key);
    return releasedIds;
}

function beginTileVisualReplacement(tileKey) {
    const key = String(tileKey);
    if (tileVisualReplacements.has(key)
        || tileVisualReplacements.size >= MAX_ACTIVE_BUILDING_REPLACEMENTS) return false;
    cancelTileBuildJob(key);
    aggregateGate.forget(key);
    const retainedChildren = new Set();
    if (buildingsGroup) {
        for (const child of buildingsGroup.children) {
            if (String(child?.userData?.tileKey) !== key) continue;
            retainedChildren.add(child);
            // The retained generation is visual fallback only. New geometry
            // owns picking/collision metadata as it publishes beside it.
            unregisterEntityTree(child);
        }
    }
    // Release only construction ownership. Detailed LOD remains claimed and
    // the old scene generation stays visible until finishTileVisualReplacement.
    const retainedDetailedIds = releaseTileBuildingRecords(key);
    tileVisualReplacements.set(key, {
        retainedChildren,
        retainedDetailedIds,
        newChildVisibility: new Map(),
        stagedAggregateParts: [],
    });
    return true;
}

function publishTileVisualReplacementAggregates(tileKey) {
    const key = String(tileKey);
    const replacement = tileVisualReplacements.get(key);
    if (!replacement) return;
    // Swap the batcher's owner generation only after every replacement feature
    // has finished. The currently assembled meshes remain visible until the
    // ordinary bounded aggregate drainer uploads this combined remove+add set.
    dropOvertureTileState(key, { deferAssembly: true });
    for (const record of replacement.stagedAggregateParts) {
        publishBuildingAggregatePart(record);
    }
    replacement.stagedAggregateParts = [];
}

function finishTileVisualReplacement(tileKey) {
    const key = String(tileKey);
    const replacement = tileVisualReplacements.get(key);
    if (!replacement) return null;
    tileVisualReplacements.delete(key);
    if (!buildingsGroup) return replacement;
    const survivors = [];
    for (const child of buildingsGroup.children) {
        if (replacement.retainedChildren.has(child)) {
            disposeBuildingGeometry(child);
            continue;
        }
        survivors.push(child);
    }
    buildingsGroup.children = survivors;
    for (const [child, wasVisible] of replacement.newChildVisibility) {
        child.visible = wasVisible;
    }
    onCountChanged(buildingsGroup.children.length);
    return replacement;
}

function releaseTileReplacementResources(replacement) {
    for (const record of replacement?.stagedAggregateParts || []) record.releaseFacadeMaterial?.();
    if (replacement) replacement.stagedAggregateParts = [];
}

function clearTileVisualReplacements() {
    for (const replacement of tileVisualReplacements.values()) releaseTileReplacementResources(replacement);
    tileVisualReplacements.clear();
}

function removeTile(tileKey) {
    const key = String(tileKey);
    cancelTileBuildJob(key);
    buildingGroundDependencies.delete(key);
    if (terrainBuildingRebuildCheck?.task.tileKey === key) {
        buildQueue.cancel(terrainBuildingRebuildCheck.job);
    }
    const replacement = tileVisualReplacements.get(key) || null;
    releaseTileReplacementResources(replacement);
    tileVisualReplacements.delete(key);
    // Evicted before its merged geometry landed: it must never be announced
    // afterwards, or the far layer drops its prisms over ground that no longer
    // has a detailed tile at all.
    aggregateGate.forget(key);
    dropOvertureTileState(key);
    // Re-show the already-present far generation before detaching detailed
    // geometry. The callbacks run in this same JavaScript turn, so this is an
    // overlap-only handoff and can never expose a blank frame.
    const releasedIds = releaseTileBuildingRecords(key, { releaseDetailedLod: true });
    for (const id of replacement?.retainedDetailedIds || []) {
        if (!releasedIds.has(id)) setDetailed(id, false);
    }
    setDetailedTile(key, false);
    if (!buildingsGroup) return;
    const survivors = [];
    for (const child of buildingsGroup.children) {
        if (String(child?.userData?.tileKey) === key) {
            unregisterEntityTree(child);
            disposeBuildingGeometry(child);
        } else {
            survivors.push(child);
        }
    }
    buildingsGroup.children = survivors;
    onCountChanged(buildingsGroup.children.length);
}

function queueRegionalBuildingRebuild(nextArchitectureId) {
    regionalBuildingRebuildQueue = planRegionalTileRebuild(
        streamedBuildingTiles,
        nextArchitectureId,
        {
            tileM: DETAILED_BUILDING_TILE_M,
            focusX: currentBuildLocalX,
            focusZ: currentBuildLocalZ,
        },
    );
}

function buildingTileIntersectsTerrainChange(tileKey, bounds) {
    if (!Array.isArray(bounds) || bounds.length === 0) return true;
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;
    const tileBounds = {
        minX: tx * DETAILED_BUILDING_TILE_M,
        maxX: (tx + 1) * DETAILED_BUILDING_TILE_M,
        minZ: tz * DETAILED_BUILDING_TILE_M,
        maxZ: (tz + 1) * DETAILED_BUILDING_TILE_M,
    };
    return bounds.some(changed => !(
        tileBounds.maxX < changed.minX
        || tileBounds.minX > changed.maxX
        || tileBounds.maxZ < changed.minZ
        || tileBounds.minZ > changed.maxZ
    ));
}

function queueTerrainBuildingRebuild(change) {
    const bounds = Array.isArray(change?.bounds) ? change.bounds : [];
    const replacementKeys = new Set();
    const nextTasks = [];
    for (const [tileKey, payload] of streamedBuildingTiles) {
        if (!buildingTileIntersectsTerrainChange(tileKey, bounds)) continue;
        replacementKeys.add(tileKey);
        const [tx, tz] = String(tileKey).split('_').map(Number);
        const centerX = (tx + 0.5) * DETAILED_BUILDING_TILE_M;
        const centerZ = (tz + 0.5) * DETAILED_BUILDING_TILE_M;
        nextTasks.push({
            tileKey,
            payload,
            distanceSq: (centerX - currentBuildLocalX) ** 2
                + (centerZ - currentBuildLocalZ) ** 2,
        });
    }
    terrainBuildingRebuildQueue = terrainBuildingRebuildQueue
        .filter(task => !replacementKeys.has(task.tileKey));
    nextTasks.sort((a, b) => a.distanceSq - b.distanceSq);
    terrainBuildingRebuildQueue.push(...nextTasks);
}

function checkTerrainBuildingDependencies(task) {
    const check = { task, job: null };
    terrainBuildingRebuildCheck = check;
    let iterator = null, result = null;
    const [tileX, tileZ] = String(task.tileKey).split('_').map(Number);
    const tileBounds = tileLocalBounds(tileX, tileZ, DETAILED_BUILDING_TILE_M);
    check.job = buildQueue.enqueue([task], () => {
        // A held formation is worth a bounded wait when its pending change
        // reaches this tile: the same allowance and shared clock as a
        // foundation. A distant change, or an expired wait, must not hold the
        // serialized re-check pipeline for a whole generation (ground-check
        // -8_1 held it 44 s across two generations after a 900 m move,
        // 2026-09-17). The sampler reads published indexes only, and the
        // publication re-check revisits every tile the change touched.
        if (pendingRoadFormationChangeTouches(terrainReference?.roadFormation, tileBounds, FOUNDATION_FORMATION_REACH_M)
            && !roadFormationWaitExpired(formationWaitStartMs(terrainReference?.roadFormation), performance.now(),
                foundationFormationWaitAllowanceMs(getFrameChunkWorkMotionState()))) {
            return advanceBuildingRoadFormationDependency() === 'repeat'
                ? FRAME_CHUNK_REPEAT_ITEM : FRAME_CHUNK_WAIT_ITEM;
        }
        if (terrainReference?.railFormation?.hasPendingBuild?.() === true) return FRAME_CHUNK_WAIT_ITEM;
        if (!iterator) {
            const terrain = terrainReference, road = terrain?.roadFormation, rail = terrain?.railFormation;
            const revision = terrain?.revision, roadRevision = road?.revision, railRevision = rail?.revision;
            const roadPublication = road?.surfacePublicationRevision, railMutation = rail?.civilGroundMutationRevision;
            let previousTop, groundAt;
            iterator = buildingGroundDependencies.checkSteps(task.tileKey, {
                sampleGround(x, z, top) {
                    if (!groundAt || top !== previousTop) {
                        previousTop = top;
                        groundAt = createBuildingFoundationGroundSampler(top);
                    }
                    return groundAt(x, z);
                },
                sampleRoof: buildingFoundationMinimumBottomYAtLocal,
                isCurrent: () => terrainReference === terrain && terrain?.revision === revision
                    && terrain?.roadFormation === road && road?.revision === roadRevision
                    && road?.surfacePublicationRevision === roadPublication
                    && terrain?.railFormation === rail && rail?.revision === railRevision
                    && rail?.civilGroundMutationRevision === railMutation
                    && streamedBuildingTiles.get(task.tileKey) === task.payload
                    && !tileBuildJobs.has(task.tileKey),
            });
        }
        const step = iterator.next();
        if (!step.done) return FRAME_CHUNK_REPEAT_ITEM;
        result = step.value;
    }, {
        priority: () => tileBuildPriority(task.tileKey, []),
        describeItem: () => `ground-check ${task.tileKey}`,
        onComplete() {
            if (terrainBuildingRebuildCheck === check) terrainBuildingRebuildCheck = null;
            if (streamedBuildingTiles.get(task.tileKey) !== task.payload || result === true) return;
            // A differing input requires the normal complete replacement. A
            // publication during the check requires a fresh check, not reuse.
            task.skipDependencyCheck = result === false;
            terrainBuildingRebuildQueue = terrainBuildingRebuildQueue.filter(next => next.tileKey !== task.tileKey);
            terrainBuildingRebuildQueue.push(task);
        },
        onCancel() {
            iterator?.return();
            if (terrainBuildingRebuildCheck === check) terrainBuildingRebuildCheck = null;
        },
    });
}

// At most one admission per frame AND two live replacement generations across
// terrain and regional rebuilds. One-per-frame alone is not a residency cap:
// a slow tile can otherwise overlap every retained tile before one publishes.
// The previous complete generation remains visible until its replacement's
// regional aggregates have uploaded, so a 420 m terrain-window refresh cannot
// make nearby blocks disappear and construct themselves again in front of us.
function drainTerrainBuildingRebuild() {
    if (terrainBuildingRebuildCheck) return true;
    const task = takeNextTileRebuild(terrainBuildingRebuildQueue, {
        tilePayloads: streamedBuildingTiles,
        activeTiles: {
            size: tileVisualReplacements.size,
            has: key => tileVisualReplacements.has(key) || tileBuildJobs.has(key),
        },
        maxActive: MAX_ACTIVE_BUILDING_REPLACEMENTS,
        tileM: DETAILED_BUILDING_TILE_M,
        focusX: currentBuildLocalX,
        focusZ: currentBuildLocalZ,
    });
    if (!task) return false;
    if (!task.skipDependencyCheck && buildingGroundDependencies.has(task.tileKey)) {
        checkTerrainBuildingDependencies(task);
        return true;
    }
    if (!beginTileVisualReplacement(task.tileKey)) {
        terrainBuildingRebuildQueue.push(task);
        return false;
    }
    const current = task.payload;
    enqueueTileFeatures(
        current.features,
        task.tileKey,
        current.streetFacingFeatures,
        () => onCountChanged(buildingsGroup ? buildingsGroup.children.length : 0),
        null,
        current,
    );
    return true;
}

// One tile per frame keeps a border crossing from becoming a synchronous
// city-wide rebuild. It uses the same retain-until-ready handoff as terrain.
function drainRegionalBuildingRebuild() {
    const task = takeNextTileRebuild(regionalBuildingRebuildQueue, {
        tilePayloads: streamedBuildingTiles,
        activeTiles: tileVisualReplacements,
        maxActive: MAX_ACTIVE_BUILDING_REPLACEMENTS,
        tileM: DETAILED_BUILDING_TILE_M,
        focusX: currentBuildLocalX,
        focusZ: currentBuildLocalZ,
        stillNeeded: (candidate, current) => current.architectureId !== candidate.architectureId,
    });
    if (!task) return false;
    if (!beginTileVisualReplacement(task.tileKey)) {
        regionalBuildingRebuildQueue.push(task);
        return false;
    }
    const current = task.payload;
    current.architectureId = task.architectureId;
    enqueueTileFeatures(
        current.features,
        task.tileKey,
        current.streetFacingFeatures,
        () => onCountChanged(buildingsGroup ? buildingsGroup.children.length : 0),
        null,
        current,
    );
    return true;
}

// ─── Static mode entry points (called by modes/static.js) ──────────────────

export function abortStaticLoad() {
    staticBuildToken += 1;
    cancelStaticBuildJob();
    if (staticFetchController) { staticFetchController.abort(); staticFetchController = null; }
    if (staticStatsFetchController) { staticStatsFetchController.abort(); staticStatsFetchController = null; }
}

function ensureBuildingsGroup() {
    if (!buildingsGroup) {
        buildingsGroup = new THREE.Group();
        buildingsGroup.name = 'Buildings';
        markInspectionLayer(buildingsGroup, {
            id: 'buildings',
            label: 'Buildings and facades',
            category: 'Buildings',
            source: 'world/buildings.js · GDI/Overture/building mesh stream',
            order: 200,
        });
        scene.add(buildingsGroup);
    }
}

function clearBuildings() {
    cancelStaticBuildJob();
    cancelAllTileBuildJobs();
    if (terrainBuildingRebuildCheck) buildQueue.cancel(terrainBuildingRebuildCheck.job);
    buildingGroundDependencies.clear();
    clearTileVisualReplacements();
    resetOvertureAggregateState();
    clearRoofActivitySurfaces();
    // Both streamed and static sessions enter here. Retire every old atlas
    // before capturing the requested profile; live setQuality only changes
    // renderer settings until this next world reset, so UV/cache keys stay valid.
    buildingQualityProfile = STATION3D_QUALITY_PROFILES[getRenderQualityContext().profileId];
    if (!buildingsGroup) return;
    while (buildingsGroup.children.length > 0) {
        const mesh = buildingsGroup.children[0];
        unregisterEntityTree(mesh);
        disposeBuildingGeometry(mesh);
        buildingsGroup.remove(mesh);
    }
    loadedBuildingIds = new Set();
    reservedBuildingIds = new Map();
    tileBuildings = new Map();
    buildingEntrances = new Map();
    buildingEntranceIndex.clear();
    buildingFootprints = new Map();
    buildingFootprintIndex.clear();
    resetBuildingBuildPhaseStats();
    // No building is detailed any more — the far LOD1 layer re-shows all its boxes.
    resetDetailed();
}

// public.facade_street is keyed on GDI object_ids. Legacy GDI endpoints can
// consume it directly; a source-agnostic mesh endpoint opts in when it carries
// the same stable ids (currently Zagreb). Other locations avoid a useless
// per-tile request and keep their local procedural classification.
function fetchStreetFacing(bbox, signal, priority = null) {
    const location = getLocation();
    const locationSupportsSharedFacades = architecturalLocationConfig().streetFacingFacades === true
        && (location.styleFrom !== 'nearest-city' || location.styleCityContainsPosition === true);
    if (!FACADE_WINDOWS
        || (BUILDING_SOURCE !== 'gdi' && !locationSupportsSharedFacades)) {
        return Promise.resolve([]);
    }
    return fetchStreetFacingFacades(bbox, signal, {
        requestScheduler: networkRequestScheduler,
        priority,
    });
}

// The bbox enclosing a radius load, for the layers that are served by bbox only
// (the shared street-facing facades). Comfortably inside the API's 0.02° bbox limit
// at the 100 m building radius.
function radiusBbox(lat, lon, radiusM) {
    const latDeg = radiusM / (DEG_TO_RAD * EARTH_RADIUS_M);
    const lonDeg = latDeg / Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
    return {
        west: lon - lonDeg,
        south: lat - latDeg,
        east: lon + lonDeg,
        north: lat + latDeg,
    };
}

export function loadBuildingsRadius(lat, lon, onProgress, onCount) {
    ensureBuildingsGroup();
    clearBuildings();
    resetStreetFacingBuildStats();
    staticBuildToken += 1;
    const loadToken = staticBuildToken;
    anchorLat = lat;
    anchorLon = lon;
    setBuildFocus(0, 0);
    if (staticFetchController) staticFetchController.abort();
    staticFetchController = new AbortController();
    if (onProgress) onProgress(t('info.loading'));

    const location = getLocation();
    BUILDING_SOURCE = location.buildings;
    const endpoint = BUILDING_SOURCE === 'mesh' ? 'buildings-mesh/radius'
                   : BUILDING_SOURCE === 'gdi' ? 'buildings-3d/radius'
                   : BUILDING_SOURCE === 'overture' ? 'buildings-overture/radius'
                   : 'buildings-bus';
    // Same per-building fill the streamed tiles use: the API returns the surveyed
    // buildings PLUS the Overture footprints GDI does not cover, each stamped with
    // its source. This replaced a session-wide swap that fired only when GDI came
    // back completely empty — on a partially surveyed radius it kept the survey and
    // dropped everything else, and outside it, it threw the surveyed ones away.
    // Both mesh-serving endpoints top up ragged survey coverage the same way.
    const fill = (BUILDING_SOURCE === 'gdi' || BUILDING_SOURCE === 'mesh') ? '&fill=overture' : '';
    const url = `${getApiBase()}/${endpoint}?lat=${lat}&lon=${lon}&radius=${BUILDING_RADIUS_M}${fill}`;
    // Wait for the real-window data too, so buildings aren't built before it
    // loads (which would leave them with no detected windows and never rebuild).
    // The shared street-facing facades join the same wait for the same reason: they decide
    // which walls get windows at all, and a building built without them would keep a
    // fallback facade forever.
    // proposalsReady() joins the same wait: a building must not be built before we know whether a
    // proposal razed it, cut it, or tunnelled under it. It resolves immediately without proposals.
    Promise.all([
        fetch(url, { signal: staticFetchController.signal }).then((r) => r.json()),
        fetchStreetFacing(radiusBbox(lat, lon, BUILDING_RADIUS_M), staticFetchController.signal),
        ensureFacadeWindowData(),
        ensureFacadeSpecData(),
        ensureMassingOverrideData(),
        ensureFacadeColorData(),
        proposalsReady(),
    ])
        .then(([data, streetFacingFeatures]) => {
            if (loadToken !== staticBuildToken) return;
            const features = prioritizeFeatures(
                applyProposalCarve(data.features || [])
                    .filter(feature => belongsInBuildingLayer(feature?.properties)),
            );
            const buildContext = createBuildingBuildContext(
                features.filter((feature) => !feature?.properties?.__proposalTrackDemolished),
                anchorLat,
                anchorLon,
                streetFacingFeatures,
            );
            // Mixed sources in one radius now (see the ?fill=overture above),
            // so each feature is built as whatever the API says it is.
            const featureWorkItems = features.map(feature => createBuildingFeatureWorkItem(
                feature,
                null,
                buildContext,
                feature?.properties?.source,
            ));
            const workItems = [
                ...featureWorkItems,
                createStaticContactAoFinalizationWorkItem(buildContext),
            ];
            console.log(`[Station3D] Loaded ${features.length} buildings within ${BUILDING_RADIUS_M}m (source: ${BUILDING_SOURCE})`);
            staticBuildJob = buildQueue.enqueue(
                workItems,
                advanceBuildingFeatureWorkItem,
                {
                    onComplete: () => {
                        staticBuildJob = null;
                        if (loadToken !== staticBuildToken) return;
                        addRoofDrainageBatch(buildContext, null);
                        // Static radius load: no far-prism hand-off to gate, and
                        // no motion frames to protect, so this one drains
                        // synchronously as it always did.
                        queueTileAggregates(null);
                        assembleOvertureBuckets();
                        logStreetFacingSummary(buildContext, `radius ${BUILDING_RADIUS_M}m`);
                        if (onCount) onCount(features.length);
                    },
                    onCancel: () => {
                        cancelBuildingFeatureWorkItems(workItems, 'static-build-cancelled');
                        if (staticBuildJob) staticBuildJob = null;
                    },
                }
            );
        })
        .catch((err) => {
            if (err.name === 'AbortError') return;
            console.warn('[Station3D] Could not load buildings:', err);
            if (onProgress) onProgress(t('info.loadFailed'));
        });
}

export function loadCatchmentStats(lat, lon, onResult) {
    if (staticStatsFetchController) staticStatsFetchController.abort();
    staticStatsFetchController = new AbortController();
    const polygon = {
        type: 'Polygon',
        coordinates: [makeCircleRing(lat, lon, BUILDING_RADIUS_M, 32)],
    };
    fetch(`${getApiBase()}/buildings/catchment-stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polygon }),
        signal: staticStatsFetchController.signal,
    })
        .then((r) => r.json())
        .then((data) => onResult && onResult(data))
        .catch((err) => {
            if (err.name === 'AbortError') return;
            console.warn('[Station3D] Could not load catchment stats:', err);
        });
}

// Called by modes/static.js on session end.
export function closeStaticBuildings() {
    abortStaticLoad();
    clearBuildings();
}

function cancelStaticBuildJob() {
    if (!staticBuildJob) return;
    buildQueue.cancel(staticBuildJob);
    staticBuildJob = null;
}

function cancelTileBuildJob(tileKey) {
    if (tileKey == null) return;
    const job = tileBuildJobs.get(tileKey);
    if (!job) return;
    buildQueue.cancel(job);
    tileBuildJobs.delete(tileKey);
}

function cancelAllTileBuildJobs() {
    for (const tileKey of Array.from(tileBuildJobs.keys())) {
        cancelTileBuildJob(tileKey);
    }
}

// The shared street-facing facades of one building tile, fetched over the same bbox the
// tile source used for its buildings, so both are keyed on the same object_ids.
function fetchTileStreetFacing(tileKey) {
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return Promise.resolve([]);
    return fetchStreetFacing(
        tileBbox(tx, tz, anchorLat, anchorLon, DETAILED_BUILDING_TILE_M),
        streetFacingFetchController ? streetFacingFetchController.signal : undefined,
        () => classifyViewPriority(
            tileLocalBounds(tx, tz, DETAILED_BUILDING_TILE_M),
            currentBuildingView(),
        ),
    );
}

// ─── Proposal buildings through the ordinary pipeline ───────────────────────
// The proposals layer hands its buildings over as ordinary footprint features
// in synthetic `proposal|cx|cz` tiles (core/proposal-building-features.js), so
// they get the local style, the frame-budgeted queue and the aggregate
// batching exactly like the city's own stock — instead of the old synchronous
// 860-extrusions-in-one-frame emit. The synthetic keys are their own aggregate
// regions and are never in the shared tile session, so nothing evicts them;
// they live for the session, like the prisms did.
// Cell size for those synthetic tiles — each cell is its own aggregate REGION.
// NOT the city's 200 m region span: a plan is far sparser than a city core
// (measured on the Šibenik plan: ~14 buildings per 200 m cell against ~50 in a
// city region), and buckets split by material — wall families, per-bay facade
// overlays — so sparse cells barely merge at all. At 200 m the plan's 860
// buildings produced 2,542 aggregates (~3 per building, i.e. batching in name
// only); the city's own ratio is ~0.7. Wider cells give the overlay materials
// enough repeats to actually share buckets; the culling loss is small because
// a plan is a few kilometres across, not a city.
export const PROPOSAL_BUILDING_TILE_SIZE_M = 500;

export function enqueueProposalBuildingTiles(featuresByTile) {
    if (!buildingsGroup || !featuresByTile) return Promise.resolve();
    const jobs = [];
    for (const [tileKey, features] of featuresByTile) {
        if (!isProposalBuildingTileKey(tileKey) || !features?.length) continue;
        jobs.push(enqueueTileFeatures(features, tileKey, [], () => {
            onCountChanged(buildingsGroup ? buildingsGroup.children.length : 0);
        }, 'overture'));
    }
    return Promise.all(jobs);
}

// Show/hide every solid proposal-building mesh: tagged individuals, their
// AO/drainage batches, and the proposal-region aggregates. Meshes created
// AFTER a toggle consult the flag at creation, so late frame-budgeted work
// (an aggregate assembling, a tile completing) lands in the current state.
export function setProposalBuildingMeshesVisible(visible) {
    proposalBuildingMeshesVisible = !!visible;
    if (!buildingsGroup) return;
    for (const child of buildingsGroup.children) {
        if (child.userData && child.userData.proposalBuilding) {
            child.visible = proposalBuildingMeshesVisible;
        }
    }
}

function enqueueTileFeatures(
    features,
    tileKey,
    streetFacingFeatures,
    onComplete,
    tileSourceKind = null,
    preparationCache = null,
) {
    cancelTileBuildJob(tileKey);
    let prepared = preparationCache?.preparedBuildingInput || null;
    if (!prepared) {
        const safeFeatures = applyProposalCarve(dedupeTwinFeatures(features, (n) => {
            console.log(`[Station3D] buildings tile ${tileKey}: dropped ${n} duplicate twin object(s)`);
        })).filter(feature => belongsInBuildingLayer(feature?.properties));
        const contextFeatures = safeFeatures.filter(
            feature => !feature?.properties?.__proposalTrackDemolished,
        );
        const contextTemplate = withTileBuildingSource(
            tileSourceKind,
            () => createBuildingBuildContextTemplate(
                contextFeatures,
                anchorLat,
                anchorLon,
                streetFacingFeatures,
            ),
        );
        prepared = { safeFeatures, contextTemplate };
        if (preparationCache) preparationCache.preparedBuildingInput = prepared;
    }
    const { safeFeatures, contextTemplate } = prepared;
    const buildContext = createBuildingBuildContext(
        [],
        anchorLat,
        anchorLon,
        [],
        contextTemplate,
    );
    // Survey meshes use an immutable absolute datum for their walls/roofs;
    // only the recorded foundation queries depend on streamed ground. Mixed
    // or terrain-relative tiles still require their normal complete rebuild.
    const canTrackGround = preparationCache && terrainReference && safeFeatures.every(feature =>
        buildingPipelineForFeature(feature?.properties, tileSourceKind) === PIPELINE_MESH
        && !feature?.properties?.__proposalTrackDemolished);
    buildingGroundDependencies.delete(String(tileKey));
    const groundDependencies = canTrackGround ? buildingGroundDependencies.begin(String(tileKey)) : null;
    buildContext.groundDependencies = groundDependencies;
    for (const feature of safeFeatures) {
        const key = feature?.properties?.source || tileSourceKind || 'unknown';
        featureSourceCounts[key] = (featureSourceCounts[key] || 0) + 1;
        if (feature?.properties?.material) featureSourceCounts.__withMaterial += 1;
    }
    const featureWorkItems = safeFeatures.map(feature => createBuildingFeatureWorkItem(
        feature,
        tileKey,
        buildContext,
        // The KIND of geometry chooses the pipeline, not the survey name — so a
        // LiDAR mesh builds exactly like a GDI one and a new city needs no
        // change here. Legacy endpoints without geometry_kind still resolve by
        // source, so Zagreb is untouched.
        buildingPipelineForFeature(feature?.properties, tileSourceKind),
    ));
    const workItems = [
        ...featureWorkItems,
        createBuildingTileFinalizationWorkItem({
            tileKey,
            tileSourceKind,
            buildContext,
            featureWorkItems,
            onComplete,
        }),
    ];
    const job = buildQueue.enqueue(
        workItems,
        advanceBuildingFeatureWorkItem,
        {
            onComplete: () => {
                groundDependencies?.seal();
                tileBuildJobs.delete(tileKey);
            },
            onCancel: () => {
                groundDependencies?.discard();
                cancelBuildingFeatureWorkItems(workItems, 'tile-build-cancelled');
                tileBuildJobs.delete(tileKey);
            },
            // A work item now advances one resumable construction stage. The
            // queue's millisecond deadline is the real safety boundary; the
            // former whole-building item cap would turn thousands of cheap
            // stages into many seconds of artificial stationary latency.
            priority: () => tileBuildPriority(tileKey, workItems),
            itemPriority: buildingWorkItemPriority,
            reorderBetweenItems: true,
            describeItem: describeBuildingFeatureWorkItem,
        }
    );
    job.workItems = workItems;
    if (workItems.length > 0) tileBuildJobs.set(tileKey, job);
    return job.promise;
}

// ─── Cab-mode layer (called by modes/cab.js) ───────────────────────────────

export const buildingsLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        onBuildingCountChanged,
        sharedTileSession,
        terrain,
        groundCoordinator,
        surfacePublications: publicationRegistry,
    }) {
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        initialBuildingGroundCoordinator = groundCoordinator || null;
        surfacePublications = publicationRegistry || null;
        networkRequestScheduler = sharedTileSession || null;
        buildingAggregatePublicationGeneration = 0;
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(
            (_revision, change) => queueTerrainBuildingRebuild(change),
        ) || null;
        lastFormationPublicationRevision = terrainReference?.roadFormation?.surfaceGeometryRevision ?? null;
        formationWaitPublishedRevision = null;
        formationWaitStartedAtMs = null;
        terrainBuildingRebuildQueue = [];
        clearTileVisualReplacements();
        setBuildFocus(0, 0);
        beginInitialNearFieldGate();
        onCountChanged = onBuildingCountChanged || (() => {});
        setBuildingPassageVolumes([]);
        streamedBuildingTiles.clear();
        regionalBuildingRebuildQueue = [];
        buildingArchitectureRegionId = architecturalPresentationKey();
        // Sessions start solid; the proposals layer re-applies its own display
        // state (URL param / N key) right after its data resolves.
        proposalBuildingMeshesVisible = true;
        ensureBuildingsGroup();
        clearBuildings();
        resetStreetFacingBuildStats();
        if (streetFacingFetchController) streetFacingFetchController.abort();
        streetFacingFetchController = new AbortController();

        // Start the configured detailed stream immediately. The former GDI
        // coverage probe downloaded and discarded a 250 m-radius LOD2 payload
        // (~35 MB at this Zagreb spawn), so far LOD1 won the screen and the
        // useful stream began seconds late. Coverage is now checked in parallel
        // with the cheap LOD1 endpoint, whose object set comes from the same
        // canonical building_render resolver as the detailed mesh stream.
        // Outside the survey, empty GDI tiles are cheap and the stream switches
        // to Overture as soon as that lightweight probe resolves.
        const location = getLocation();
        BUILDING_SOURCE = location.buildings;
        buildingsSessionToken += 1;
        // Coverage is resolved PER TILE (see attachBuildingsTileSource), not by a
        // probe at the session anchor. GDI's edge is ragged — around Odra it is an
        // island a few hundred metres wide — so one 250 m sample decided the whole
        // world from a point that could sit on either side of it: anchor on the
        // station and every tile the walker actually stood in came back empty, with
        // nothing pending and no error. A tile knows its own coverage.
        attachBuildingsTileSource(buildingTileSourceForLocation(location), sharedTileSession);
    },
    onFrame(pose, local) {
        let phaseStartedMs = performance.now();
        // Check once per frame, not once per queued feature. Later movement
        // keeps the retained-generation/revalidation policy above.
        if (initialBuildingGroundCoordinator?.snapshot().published > 0) {
            initialBuildingGroundCoordinator = null;
        }
        // A formation publication is not a terrain revision, yet it moves the
        // ground beside a facade that built on the previous generation after
        // its bounded wait expired. Re-check the tiles its profiles touch.
        {
            const roadFormation = terrainReference?.roadFormation;
            const publicationRevision = roadFormation?.surfaceGeometryRevision ?? null;
            if (publicationRevision !== null && publicationRevision !== lastFormationPublicationRevision) {
                if (lastFormationPublicationRevision !== null
                    && typeof roadFormation.getSurfaceGeometryChangesSince === 'function') {
                    const changes = roadFormation.getSurfaceGeometryChangesSince(lastFormationPublicationRevision);
                    queueTerrainBuildingRebuild({ bounds: changes.full ? [] : changes.bounds,
                        reason: 'road-formation-publication' });
                }
                lastFormationPublicationRevision = publicationRevision;
            }
        }
        const viewHeadingDeg = Number.isFinite(Number(pose?.viewHeadingDeg))
            ? Number(pose.viewHeadingDeg)
            : Number(pose?.headingDeg);
        const viewFovDeg = Number.isFinite(Number(pose?.viewFovDeg))
            ? Number(pose.viewFovDeg)
            : 90;
        setBuildFocus(local && local.x, local && local.z, viewHeadingDeg, viewFovDeg);
        recordLayerFrameMs('buildings:focus', performance.now() - phaseStartedMs);
        phaseStartedMs = performance.now();
        const architectureId = architecturalPresentationKey();
        if (architectureId !== buildingArchitectureRegionId) {
            buildingArchitectureRegionId = architectureId;
            queueRegionalBuildingRebuild(architectureId);
        }
        // A terrain replacement retains the previous complete tile. Its
        // generation handoff releases picking/entity ownership and prepares a
        // fresh build job before resumable feature work starts, so it is not a
        // motion-frame task even with immutable facade indexes cached. Let the
        // retained generation carry every moving view and begin replacements
        // only once the observer is genuinely stationary.
        if (getFrameChunkWorkMotionState() === 'stationary') {
            if (!drainTerrainBuildingRebuild()) drainRegionalBuildingRebuild();
        }
        recordLayerFrameMs('buildings:rebuildDrain', performance.now() - phaseStartedMs);
        if (tileSource) {
            phaseStartedMs = performance.now();
            const surfacePreload = pose?.surfaceStreamingPreload;
            if (surfacePreload) {
                tileSource.ensurePinnedPoints(surfacePreload.points, {
                    signature: surfacePreload.signature,
                    priorityX: surfacePreload.priority?.x,
                    priorityZ: surfacePreload.priority?.z,
                    headingDeg: surfacePreload.priority?.headingDeg,
                });
            }
            tileSource.ensureAround(local.x, local.z, {
                headingDeg: viewHeadingDeg,
                fovDeg: viewFovDeg,
            });
            recordLayerFrameMs('buildings:tileAround', performance.now() - phaseStartedMs);
            // Build the initial view corridor behind the same loading curtain
            // as its ground. Deferring this call caused a fresh request burst
            // on reveal even when the observer had not moved or turned.
            phaseStartedMs = performance.now();
            tileSource.ensureAhead(
                local.x,
                local.z,
                viewHeadingDeg,
                pose?.status?.expandedBuildingStreaming
                    ? GTA_DETAILED_BUILDING_AHEAD
                    : DETAILED_BUILDING_AHEAD,
            );
            recordLayerFrameMs('buildings:tileAhead', performance.now() - phaseStartedMs);
        }
        // Rebuild any Overture buckets left dirty by tile eviction, a few per
        // frame, so a region's re-upload never lands in one motion frame.
        phaseStartedMs = performance.now();
        if (activeOvertureAssembly || pendingOvertureBucketCount()) {
            assembleOvertureBuckets(
                buildingAggregateDrainPolicy(getFrameChunkWorkMotionState()),
            );
        } else if (aggregateGate.size > 0) {
            // Nothing is queued any more, so anything still waiting is waiting
            // on a bucket that will never report — a bucket that assembled to
            // nothing and was dropped is the ordinary way that happens. Release
            // it rather than leave the tile under LOD1 prisms for the session.
            aggregateGate.releaseStranded();
        }
        recordLayerFrameMs('buildings:aggregate', performance.now() - phaseStartedMs);
        phaseStartedMs = performance.now();
        updateCloseFacadeDetails(local && local.x, local && local.z);
        recordLayerFrameMs('buildings:closeFacades', performance.now() - phaseStartedMs);
        phaseStartedMs = performance.now();
        // A fixed one-entry retirement rate can fall behind a burst of new
        // facades and retain hundreds of MB of unused source canvases. Catch
        // up within a time slice; active meshes and queued atlas paints remain
        // pinned. Loading can spend more CPU before the world is revealed.
        facadeResources.trim(32, isWorldBuilding() ? 2 : 0.25);
        recordLayerFrameMs('buildings:facadeEvict', performance.now() - phaseStartedMs);
        phaseStartedMs = performance.now();
        facadeAtlasResources.trim(1);
        recordLayerFrameMs('buildings:facadeAtlasEvict', performance.now() - phaseStartedMs);
    },
    endSession() {
        buildingsSessionToken += 1;   // cancel any in-flight endpoint probe
        initialBuildingGroundCoordinator = null;
        clearFacadePhotoTextureCache();
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        terrainBuildingRebuildQueue = [];
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        if (streetFacingFetchController) {
            streetFacingFetchController.abort();
            streetFacingFetchController = null;
        }
        buildQueue.clear();
        tileBuildJobs.clear();
        clearTileVisualReplacements();
        streamedBuildingTiles.clear();
        regionalBuildingRebuildQueue = [];
        buildingArchitectureRegionId = null;
        initialNearTileKeys.clear();
        if (buildingsGroup) {
            clearBuildings();
            if (buildingsGroup.parent) buildingsGroup.parent.remove(buildingsGroup);
            buildingsGroup = null;
        }
        resetStreetFacingBuildStats();
        // Tear down the material cache (unjittered base + per-bucket
        // jittered) so GPU memory doesn't grow across repeated cab sessions.
        // registerShared() is paired with unregisterShared() so the dispose
        // helper stays accurate.
        disposePassageMaterialVariants();
        facadeResources.clear();
        for (const k of Object.keys(buildingMaterials)) {
            unregisterShared(buildingMaterials[k]);
            buildingMaterials[k].dispose();
            delete buildingMaterials[k];
        }
        clearCloseFacadeDetails(true);
        disposeStatedMaterialFamilies();
        disposeBuildingTextureCaches();
        wallColorFamilyByMaterial.clear();
        overtureExcludedByBase = new WeakMap();
        setBuildingPassageVolumes([]);
        terrainReference = null;
        surfacePublications = null;
        networkRequestScheduler = null;
    },
};

let buildingsSessionToken = 0;

function attachBuildingsTileSource(buildingSource, sharedTileSession) {
    // GDI is flown in patches and its edge is ragged at tile scale, so a tile can
    // be PARTIALLY surveyed. The API tops such a tile up with the Overture
    // footprints GDI does not cover (?fill=overture) — deduped there with a real
    // ST_Intersects against the GDI footprints, in the same request and the same
    // response. Doing it client-side meant a second fetch per tile outside the
    // stream's concurrency budget, and a dedup reduced to centroid-vs-bbox.
    const { endpoint, key, querySuffix } = buildingSource;
    const source = sharedTileSession.getSource({
        key,
        label: 'buildings',
        url: (bb) => `${getApiBase()}/${endpoint}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}${querySuffix}`,
        prioritizeByView: true,
        ...DETAILED_BUILDING_STREAM_OPTIONS,
    });
    tileSource = source;
    tileSubscription = source.subscribe({
        // A tile can arrive before the proposals (and so before their carve verdicts) are
        // known. Hold it until they are: building a legacy building the road was about to
        // demolish, then deleting it a moment later, is the flicker this avoids — and for a
        // CUT building there would be nothing to delete, only a wrong shape left standing.
        // proposalsReady() resolves immediately when the deeplink carries no proposals.
        // The tile's shared street-facing facades are awaited alongside: they decide
        // which of its walls get windows, and a tile built without them would keep the
        // local-geometry fallback until it is evicted and refetched.
        onFetch: (features, tileKey) => {
            return Promise.all([
                proposalsReady(),
                fetchTileStreetFacing(tileKey),
            ])
                .then(([, streetFacingFeatures]) => {
                    if (tileSource !== source) return;   // session ended/replaced in flight
                    const streamedTile = {
                        features,
                        streetFacingFeatures,
                        architectureId: architecturalPresentationKey(),
                    };
                    streamedBuildingTiles.set(tileKey, streamedTile);
                    return enqueueTileFeatures(features, tileKey, streetFacingFeatures, () => {
                        onCountChanged(buildingsGroup ? buildingsGroup.children.length : 0);
                    }, null, streamedTile);
                });
        },
        onEvict: (tileKey) => {
            streamedBuildingTiles.delete(tileKey);
            removeTile(tileKey);
        },
    });
    source.ensureAround(0, 0);
}
