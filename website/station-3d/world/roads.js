// Road + railway ground-polygon layer. Streams tiles in a small ring around
// the tram position and dedupes by OSM id. Asphalt and pedestrian/trackbed
// surfaces share scene lighting so their deliberately different base tones
// remain different by day, at night, and under street lamps. Cab sessions reuse a shared
// road tile source so roads and passage carving don't double-fetch.

import * as THREE from 'three';
import {
    bikePaintSceneY,
    buildBikeLaneQuads,
    buildCenteredBikeLaneQuads,
    resolveBikeLaneBands,
} from '../core/bike-lane-geometry.js';
import { buildChainsFromSegments } from './footpath-geometry.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { prepareGroundCoverRoadBucketSteps, clearGroundCoverRoads } from './ground-cover.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { getApiBase } from '../core/api.js';
import {
    getFrameChunkSequence,
    createFrameChunkQueue,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { decodeRoadTile } from '../core/road-tile-binary.js';
import { startupTrace } from '../core/startup-trace.js';
import { captureGroundReadSnapshot } from '../core/terrain-snapshot.js';
import { createRoadRenderGroundCapture, roadRenderQueryBounds, roadRenderQueryBoundsSteps } from '../core/road-render-ground.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { createReceiverFootprintSteps } from '../core/receiver-footprint.js';
import { clipReceiverOpeningsSteps } from '../core/receiver-opening-geometry.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { noteWorldQueueActive, noteWorldQueueIdle } from '../core/world-ready.js';
import {
    buildFormationTerrainCollarGeometryData,
    buildRetainingWallPositions,
    buildWallFaceUvsForPositions,
    buildWorldXZUvsForPositions,
    densifyClosedLocalRing,
    refineTriangulatedSurface,
    roadSurfaceUsesEngineeredFormation,
    RoadFormationModel,
} from '../core/road-formation.js';
import { createRoadFormationSurfaceTileIndex } from '../core/road-formation-surface-tile-index.js';
import { createRoadTileRegistrationTask } from '../core/road-tile-registration.js';
import { createRoadSurfaceAlignmentInputs } from '../core/road-surface-alignment-inputs.js';
import { createRoadRetainingConcreteRaster } from '../core/concrete-texture.js';
import {
    roadVerticalAlignmentFromProperties,
    roadVerticalCenterlinesFromSurfaceFeatures,
    roadVerticalCenterlinesFromSurfaceFeaturesSteps,
    RoadVerticalAlignmentModel,
} from '../core/road-vertical-alignment.js';
import {
    isRoadStructurePublicationKey,
    roadReplacementOsmIdsFromRoot,
    roadReplacementPublicationReadyForOsmId,
} from '../core/road-replacement-publication.js';
import {
    isTunnelPathSurface,
    isUnmodelledTunnelPathSurface,
    tunnelPathSurfaceAboveGround,
} from '../core/unmodelled-tunnel-path.js';
import {
    sampleRailFormationElevationAslMAtCoordinate,
} from '../core/rail-crossing-elevation.js';
import {
    roadProfileTerrainEvidenceYAtLocal,
    railCivilGroundDependencySnapshotSteps,
} from '../core/rail-road-grade-separation.js';
import {
    changedCivilGroundDependencyBounds,
    changedCivilGroundDependencyBoundsSteps,
    CIVIL_GROUND_AUTHORITY,
} from '../core/civil-ground-composition.js';
import {
    boundsIntersectWithPadding,
    NEAR_ROAD_STREAM_OPTIONS,
    TILE_M,
    tileDistanceSqToPoint,
} from '../core/tile-stream.js';
import { initialWorldSupportTileKeys } from '../core/initial-world-support.js';
import {
    camera,
    getGravelTexture,
    GRAVEL_UV_PER_M,
    getSidewalkTexture,
    renderer,
    scene,
} from '../scene/setup.js';
import { captureProposalMaskSnapshot } from './proposals.js';
import { buildSurfaceEdgingMesh } from './decor.js';
import { applyStreetLampSurfaceLighting } from './streetlamp-lighting.js';
import { applyPlannerSurfaceCutout, createPlannerGeometryMaterialCache } from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { getActiveTerrainSurface } from './terrain-surface.js';
import { applyUrbanGroundSurface } from './urban-ground-surface.js';
import {
    GROUND_SURFACE_LEVELS,
    ROAD_STENCIL_RENDER_ORDER,
    roadSurfaceSceneOffset,
} from './ground-surface-levels.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_POLYGON_OFFSET,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';
import { roadEntityMetadata } from '../core/entity-metadata.js';
import { createRoadFeatureIdentityIndex } from '../core/road-feature-identity.js';
import { createRoadFeatureSourceIndex } from '../core/road-feature-sources.js';
import { retireRoadFeatureIfUnused, releaseRoadTileReferences, holdRoadFeatureForBuild, releaseRoadFeatureBuildHold } from '../core/road-feature-lifetime.js';
import { registerAggregateEntityRanges } from '../core/entity-interaction.js';
import { createGeometryBatcher } from '../core/geometry-batch.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
import { drapeEdgeMForTriangulation } from '../core/proposal-ground.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    createSettleGate,
    markSettleGateApplied,
    shouldRunOnSettle,
} from '../core/settle-gate.js';
import { createTilePublicationTracker } from '../core/tile-publication-tracker.js';
import {
    createRoadPathTangentSampler,
    roadPathUsesNearbyCarriagewayProfile,
} from '../core/road-path-surface.js';
import {
    buildRoadsideSurfaceTerrainSeamGeometryData,
} from '../core/roadside-surface-seam.js';
import { terrainRevisionRoadOsmIds } from '../core/road-surface-terrain-refresh.js';
import { createForcedRebuildLedger } from '../core/road-forced-rebuild-ledger.js';
import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { roadGroundPaintEligible, roadReceiverPaintEligible } from '../core/road-ground-paint.js';
import { createGroundSurfacePaintRecordSteps } from '../core/ground-surface-paint.js';
import { createGroundBikePaintRecordsSteps } from '../core/ground-bike-paint.js';
import { groundPaintCapacity } from '../core/ground-paint-source-plans.js';

// Tram trackbed is rendered with a procedural canvas texture matching
// the Zagreb-style concrete-paver pattern: small ~10 cm square pavers
// on a grid, grouped into ~40 cm panels separated by deeper grooves,
// with periodic lighter inset markers at panel corners (the short
// white rectangles visible in the real Street View shots). Heavy rail
// is now handled purely by world/elevated-rail.js, so this ground layer
// only keeps the brighter cartographic subway corridor.
const RAILWAY_COLORS = {
    subway: 0x9090b8,
};
const COLOURED_RAILWAY_TYPES = new Set(['subway']);

// One repeat of the asphalt tile = ASPHALT_TILE_M metres on the ground.
// Smaller = busier surface (grain reads bigger), larger = smoother. The
// trackbed texture uses the same world-XZ UVs but bakes in its own
// per-image repeat scaling so individual pavers read at a realistic
// ~10 cm size.
const ASPHALT_TILE_M = 16.0;   // bigger tile → room for macro wear, less visible repetition
export const ASPHALT_UV_PER_M = 1 / ASPHALT_TILE_M;
const ZAGREB_TILE_PER_IMAGE_M = 1.6;    // 256 px image ≈ 1.6 m on the ground
const STONE_PAVING_TILE_PER_IMAGE_M = 3.6;
const ROAD_RETAINING_CONCRETE_TILE_M = 5.6;

// Sidewalk-level ways: in Zagreb these run on the raised pavement, not the
// roadbed, so they must read as light concrete rather than asphalt — dark
// polygons behind the curb read as stray roadbed. Rendered lit (like the
// ground plane and paving polygons) so their tone tracks the ground exactly.
const SIDEWALK_LEVEL_TYPES = new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway']);

const renderedRoadSurfaces = createRenderedRoadSurfaceRegistry();

export function getRenderedRoadSurfaceRevision(x = null, z = null, radiusM = 0) {
    return Number.isFinite(x) && Number.isFinite(z)
        ? renderedRoadSurfaces.revisionNear(x, z, radiusM)
        : renderedRoadSurfaces.revision;
}

export function getRenderedRoadSurfacePartsNear(
    x,
    z,
    radiusM,
    { drivableOnly = false } = {},
) {
    return renderedRoadSurfaces.partsNear(x, z, radiusM, { drivableOnly });
}

export function renderedRoadSurfaceSupportYAtLocal(
    x,
    z,
    { maxY = Infinity, drivableOnly = false, acceptPart = null } = {},
) {
    return renderedRoadSurfaces.supportYAt(x, z, { maxY, drivableOnly, acceptPart });
}

// Plan-view record of paved pedestrian ground (promenades, squares) in the
// loaded tiles. Painted paving has no mesh of its own, so this is how a reader
// learns the walker stands on paving rather than bare terrain.
export function pedestrianZoneAtLocal(x, z) {
    return pointInsideSiblingPedestrianZone(x, z, null, pedestrianRings);
}

export function renderedRoadTrianglesInBounds(bounds, options) {
    return renderedRoadSurfaces.trianglesInBounds(bounds, options);
}

// Source arrival is not enough: a road tile is safe for a fast vehicle only
// after every aggregate bucket it needs has committed to the visible scene.
export function isRenderedRoadTilePublishedAtLocal(localX, localZ) {
    const x = finiteOrNull(localX);
    const z = finiteOrNull(localZ);
    if (x === null || z === null) return false;
    if (!roadSurfaceTiles) return true;
    // The visible polygon is only final after all three source families that
    // can change its height have delivered this tile. A first asphalt upload
    // may precede its centreline formation or explicit vertical alignment.
    if (tileSource && !tileSource.isLoadedAtLocal(x, z)) return false;
    if (centerlineSource && !centerlineSource.isLoadedAtLocal(x, z)) return false;
    if (verticalAlignmentSource
        && !verticalAlignmentSource.isLoadedAtLocal(x, z)) return false;
    const key = `${Math.floor(x / TILE_M)}_${Math.floor(z / TILE_M)}`;
    if (pendingFormationSurfaceTiles.has(key)) return false;
    if (roadFormationModel?.hasPendingBuild()) {
        const changes = roadFormationModel.getChangesSince(roadFormationModel.surfaceGeometrySourceRevision);
        if (changes.full || roadTileIntersectsGroundChange(key, changes.bounds)) return false;
    }
    return roadSurfaceTiles.isCurrent(key);
}

function ensurePinnedSurfaceCorridor(source, preload) {
    if (!source || !preload) return;
    source.ensurePinnedPoints(preload.points, {
        signature: preload.signature,
        priorityX: preload.priority?.x,
        priorityZ: preload.priority?.z,
        headingDeg: preload.priority?.headingDeg,
    });
}

const roadMaterials = new Map();
const asphaltMaterials = new Map();
const concretePathMaterials = new Map();
let asphaltTexture = null;
const stonePavingMaterials = new Map();
let stonePavingTexture = null;
const trackbedMaterials = new Map();
let trackbedTexture = null;
const retainingWallMaterials = new Map();
let retainingWallConcreteSurface = null;
const formationTerrainCollarMaterials = new Map();
const sidewalkTerrainSeamMaterials = new Map();
let roadsGroup = null;
let centeredBikePaintGroup = null;
let surfacePublications = null;
let groundPublications = null;
let groundPhysicsProvider = null;
let groundPaint = null;
let surfacePublicationSubscription = null;
let centeredBikePublicationGeneration = 0;
const CENTERED_BIKE_PUBLICATION_KEY = 'roads:centered-bike-paint';
// Published road features are reference-counted across bbox tiles. The API
// can return one long OSM way in several neighbouring responses; keeping one
// feature until its final tile evicts prevents boundary disappear/reappear bugs.
let roadEntries = new Map();  // featureKey → { featureKey, tileRefs, pendingRefs }
let roadReceiverMutationEpoch = 0;
let roadReceiverGenerationLease = null;
let groundCoordinator = null;
let groundManaged = false;
const plannerGeometryMaterials = createPlannerGeometryMaterialCache();
const groundFeatureBounds = new WeakMap();
const roadFeatureIdentities = createRoadFeatureIdentityIndex();
const roadFeatureSources = createRoadFeatureSourceIndex(roadFeatureIdentities);

// ─── Merged road aggregates ─────────────────────────────────────────────────
// Features no longer publish their meshes to the scene one by one. A census of
// a project-96 ride counted 4,267 road meshes — 2,403 of them individual
// bike-lane quads — over a handful of shared materials, and per-OBJECT cost
// (three.js walks, frustum-tests, sorts and submits every mesh, every frame)
// is the measured render floor. Publishing now hands each built mesh's
// geometry to an owner-keyed batcher; the scene holds ONE merged mesh per
// bucket (material + render flags), rebuilt from cached parts when features
// come and go. The feature refcount lifecycle above is untouched — an owner is
// removed from the batcher exactly where its meshes used to leave the scene.
//
// Assembly is settle-gated like the lane-markings aggregate: a streaming burst
// marks buckets dirty many times and pays for ONE rebuild when it goes quiet.
// Same knobs, same reasoning (see world/lane-markings.js).
const ROAD_AGGREGATE_QUIET_FRAMES = 12;
const ROAD_AGGREGATE_MAX_DEFERRED_FRAMES = 120;
const roadBatcher = createGeometryBatcher();
// bucketKey → { material, renderOrder, name, pickable } — captured from the
// first mesh that lands in the bucket; every later mesh matches by key
// construction (the key IS material identity + render order + kind).
const roadBucketDescriptors = new Map();
// Stable small ids for material identity inside bucket keys.
const roadMaterialIds = new Map();
// bucketKey → { mesh, unregisterEntities }
const roadAggregates = new Map();
// Analytic road support follows the exact visible aggregate generation. Each
// feature/bucket candidate is prepared while detached, then activated from the
// same publication commit that installs the merged mesh and picking ranges.
// Removing or replacing an owner changes only this desired state; the last
// complete support remains live until the bucket's successor publishes.
const roadCollisionCandidatesByBucket = new Map();
const roadCollisionDirtyOwnersByBucket = new Map();
const roadCollisionBucketRevisions = new Map();
const publishedRoadSurfaceOwnersByBucket = new Map();
const roadAggregateEntityUnregister = new WeakMap();
// Surface buckets that contain owner changes not yet reflected by a rendered
// aggregate. A second tile can reference an owner first published by its
// neighbour while that aggregate is still queued, so "entry exists" alone is
// not a visibility guarantee.
const roadSurfaceBucketsPendingPublication = new Set();
let roadSurfaceTiles = null;
let roadAggregateRevision = 0;
let roadAggregateGate = createSettleGate({
    quietFrames: ROAD_AGGREGATE_QUIET_FRAMES,
    maxDeferredFrames: ROAD_AGGREGATE_MAX_DEFERRED_FRAMES,
});

// Buckets are REGIONAL — keyed by the publishing tile as well as material —
// because assembly cost is proportional to bucket size. The first cut used one
// city-wide bucket per material, and its own instrumentation convicted it:
// `roads:assemble 41× · 104 ms worst` on a 90 s ride, a 1.3 M-triangle memcpy
// re-run on every streaming settle. Per-tile buckets make an assemble touch
// one tile's features (single-digit ms), let eviction drain a bucket to
// nothing, and give the frustum culler back something it can cull — a
// city-wide aggregate is never off-screen. A feature that spans tiles lives in
// the region that FIRST published it; which aggregate holds it is cosmetic,
// its refcounted lifetime is not affected.
function roadRegionForTile(tileKey) {
    const [tx, tz] = String(tileKey ?? '0_0').split('_').map(Number);
    return `r${Number.isFinite(tx) ? tx : 0}_${Number.isFinite(tz) ? tz : 0}`;
}

function roadAggregatePublicationKey(bucketKey) {
    return `roads:aggregate:${String(bucketKey)}`;
}

function roadSurfaceSupportOwnerId(bucketKey, featureKey) {
    return `roads:support:${String(bucketKey)}:${String(featureKey)}`;
}

function roadBucketKeyForMesh(mesh, region) {
    const material = mesh.material;
    let materialId = roadMaterialIds.get(material);
    if (materialId == null) {
        materialId = roadMaterialIds.size;
        roadMaterialIds.set(material, materialId);
    }
    // Kind prefix keeps the census readable; material id + render order are
    // what actually make the bucket mergeable.
    const kind = String(mesh.name || 'Road').split(':')[0];
    const surfaceClass = mesh.userData?.surfaceClaim?.surfaceClass || 'unclaimed';
    return `${kind}:${surfaceClass}#${materialId}@${Number(mesh.renderOrder) || 0}/${region}`;
}

function roadSurfaceClass(ctx) {
    const railwayType = String(ctx?.feature?.properties?.railway_type || '');
    if (COLOURED_RAILWAY_TYPES.has(railwayType)) return SURFACE_CLASS.TRAM_CORRIDOR;
    if (ctx?.type === 'pedestrian') return SURFACE_CLASS.SIDEWALK;
    if (ctx?.type === 'cycleway') return SURFACE_CLASS.CYCLEWAY;
    if (SIDEWALK_LEVEL_TYPES.has(ctx?.type)) return SURFACE_CLASS.BUFFERED_SIDEWALK;
    return SURFACE_CLASS.ROAD_CARRIAGEWAY;
}

function roadSurfaceVerticalRelation(ctx) {
    return ctx?.followsVerticalAlignment
        || roadVerticalAlignmentFromProperties(ctx?.feature?.properties || {})
        ? SURFACE_VERTICAL_RELATION.GRADE_SEPARATED
        : SURFACE_VERTICAL_RELATION.SAME_LEVEL;
}

function roadSurfaceClaim(ctx, { coverageState, ownerId } = {}) {
    const verticalRelation = roadSurfaceVerticalRelation(ctx);
    return compileSurfaceClaim({
        surfaceClass: roadSurfaceClass(ctx),
        coverageState: coverageState || SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation,
        verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ? 'ground'
            : null,
        ownerId: ownerId || ctx?.entityMetadata?.key || ctx?.osm_id || null,
        featureId: ctx?.entityMetadata?.key || ctx?.osm_id || null,
        sourceId: 'world/roads.js',
        supportReady: true,
        cutsBackstop: true,
    });
}

function roadEarthworkClaim(ctx, coverageState = SURFACE_COVERAGE_STATE.PUBLISHED) {
    const verticalRelation = roadSurfaceVerticalRelation(ctx);
    return compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK,
        coverageState,
        verticalRelation,
        verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
            ? 'ground'
            : null,
        ownerId: ctx?.entityMetadata?.key || ctx?.osm_id || 'road-earthwork',
        sourceId: 'world/roads.js',
        supportReady: true,
        cutsBackstop: true,
    });
}

function sidewalkTerrainSeamClaim(
    ctx,
    coverageState = SURFACE_COVERAGE_STATE.PUBLISHED,
) {
    return compileSurfaceClaim({
        // This is a bounded continuation of the terrain surface, not a curb or
        // road ornament. The earthwork class is intentionally eligible for the
        // same landuse shader as terrain, so grass/karst does not turn into a
        // generic grey strip beside the concrete edge.
        surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK,
        coverageState,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: ctx?.entityMetadata?.key || ctx?.osm_id || 'sidewalk-terrain-seam',
        featureId: ctx?.entityMetadata?.key || ctx?.osm_id || null,
        sourceId: 'world/roads.js:sidewalk-terrain-seam',
        supportReady: false,
        cutsBackstop: false,
    });
}

function roadStructureClaim(ctx, coverageState = SURFACE_COVERAGE_STATE.PUBLISHED) {
    return compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState,
        verticalRelation: roadSurfaceVerticalRelation(ctx),
        ownerId: ctx?.entityMetadata?.key || ctx?.osm_id || 'road-structure',
        sourceId: 'world/roads.js',
        supportReady: true,
    });
}

function surfaceMaterialKey(claim) {
    return `${claim.surfaceClass}:${claim.verticalRelation}`
        + `:${Number(claim.capabilities.support)}:${Number(claim.capabilities.backstopCut)}`;
}

function markRoadSurfaceClaim(mesh, ctx, { coverageState, ownerId } = {}) {
    return markSurfaceClaim(mesh, roadSurfaceClaim(ctx, {
        coverageState: coverageState || SURFACE_COVERAGE_STATE.BUILDING,
        ownerId,
    }));
}

function markRoadStructureClaim(mesh, ctx, ownerId = null) {
    return markSurfaceClaim(mesh, reviseSurfaceClaim(
        roadStructureClaim(ctx, SURFACE_COVERAGE_STATE.BUILDING),
        { ownerId: ownerId || ctx?.entityMetadata?.key || ctx?.osm_id || null },
    ));
}

function markRoadEarthworkClaim(mesh, ctx) {
    return markSurfaceClaim(
        mesh,
        roadEarthworkClaim(ctx, SURFACE_COVERAGE_STATE.BUILDING),
    );
}

function markSidewalkTerrainSeamClaim(mesh, ctx) {
    return markSurfaceClaim(
        mesh,
        sidewalkTerrainSeamClaim(ctx, SURFACE_COVERAGE_STATE.BUILDING),
    );
}

function roadInspectionSpec(mesh) {
    const name = String(mesh?.name || 'Road');
    const type = String(mesh?.userData?.surfaceType || name.split(':')[1] || 'default');
    if (name.startsWith('RoadFormationTerrainCollar:')) {
        return {
            id: 'road-earthworks',
            label: 'Road embankments and cut slopes',
            category: 'Civil works',
            source: 'world/roads.js · engineered road formation earth geometry',
            order: 141,
        };
    }
    if (name.startsWith('RoadRetainingWall:')) {
        return {
            id: 'road-retaining-walls',
            label: 'Road retaining walls',
            category: 'Civil works',
            source: 'world/roads.js · engineered road retaining faces',
            order: 142,
        };
    }
    if (name.includes('bike-lane') || type === 'cycleway') {
        return {
            id: 'bike-surfaces',
            label: 'Cycleways and bicycle paint',
            category: 'Transport',
            source: 'world/roads.js · OSM cycling infrastructure',
            order: 112,
        };
    }
    if (type === 'pedestrian' || SIDEWALK_LEVEL_TYPES.has(type)) {
        return {
            id: 'sidewalks-paths',
            label: 'Sidewalks and pedestrian paving',
            category: 'Transport',
            source: 'world/roads.js · OSM pedestrian/path polygons',
            order: 111,
        };
    }
    return {
        id: 'road-asphalt',
        label: 'Roadbed / asphalt',
        category: 'Transport',
        source: 'world/roads.js · OSM carriageway polygons',
        order: 110,
    };
}

function markRoadAggregatesDirty() {
    roadAggregateRevision += 1;
}
let tileRoads = new Map();    // tileKey → Set<featureKey>
let tileFeatures = new Map(); // tileKey → Feature[]
const surfaceAlignmentInputs = createRoadSurfaceAlignmentInputs();
let tileSource = null;
let tileSubscription = null;
let centerlineSource = null;
let centerlineSubscription = null;
let verticalAlignmentSource = null;
let verticalAlignmentSubscription = null;
let centerlineTileFeatures = new Map();
const roadFormationSurfaceTiles = createRoadFormationSurfaceTileIndex();
let anchorLat = 0, anchorLon = 0;
let terrainReference = null;
let terrainChangeSubscription = null;
let civilGroundReference = null;
let releaseCivilGroundAuthority = null;
let railFormationProvider = null;
let observedCivilGroundDependencies = [];
let observedCivilGroundSignature = '';
let roadFormationModel = null;
let observedFormationGeometryRevision = 0;
let formationPreparationJob = null;
let formationPreparationFailure = null;
const FORMATION_RETRY_MS = 2000;
const formationSurfaceRetryAt = new Map();
const pendingFormationSurfaceTiles = new Set();
let roadVerticalAlignmentModel = null;
let surfaceAlignmentRefreshBatch = null;
// Outstanding forced-rebuild obligations that must survive a skipped or
// cancelled refresh batch — see core/road-forced-rebuild-ledger.js.
const roadForcedRebuildLedger = createForcedRebuildLedger();
let roadBuildFocusX = 0, roadBuildFocusZ = 0;
let roadSupportFocusX = 0, roadSupportFocusZ = 0;
let initialNearRoadTileKeys = new Set();
let roadMaterialPrewarmState = null;
const buildQueue = createFrameChunkQueue({
    label: 'roads',
    frameBudgetMs: 4,
    preferAnimationFrame: true,
    workClass: 'near',
    workTier: 'surface',
    // The queue continues down the fog-horizon corridor. The loading gate is
    // tracked explicitly by the four tiles touching the initial observer.
    trackWorldReady: false,
    reportWorldProgress: true,
});
const centeredBikePaintQueue = createFrameChunkQueue({
    label: 'bike-paint',
    frameBudgetMs: 2,
    preferAnimationFrame: true,
    workClass: 'delivery',
    trackWorldReady: false,
});
let centeredBikePaintJob = null;
const tileBuildJobs = new Map();
const tileRegistrationJobs = new Map();
// Scene fog is fully opaque at 1,200 m. Keep a slim road-only corridor ready
// slightly beyond it so an unfetched tile can never become visible ahead.
const ROAD_AHEAD_PREFETCH_M = 1400;
const ROAD_AHEAD_HALF_WIDTH_M = 120;
const ENGINEERED_SURFACE_MAX_EDGE_M = 4;
// The base DGU DTM is a 20 m grid, while the camera-centred LiDAR surface is
// finer. Ordinary draped surfaces choose the rendered terrain's own step during
// the seed phase below: matching it prevents a 20 m sidewalk triangle and a
// fine terrain triangle from crossing in a green/white sawtooth. This constant
// remains the coarse fallback and upper bound. The triangle cap bounds plazas
// and merged junction buffers so fine terrain cannot freeze a frame. Engineered
// formations keep their explicit 4 m step because they carry a vertical profile
// the terrain grid cannot express.
const DRAPED_SURFACE_MAX_EDGE_M = 20;
const DRAPED_SURFACE_MAX_TRIANGLES = 1200;
// Engineered surfaces keep the fine 4 m edge (for authored ramp/tunnel profiles)
// but MUST still be capped: a large-area engineered polygon (station plaza, wide
// junction/apron) was filling its flat interior with ~485 k coplanar triangles
// each. The profile between grade breaks is piecewise-linear (planar), so
// coarsening those big flat interiors is nearly lossless; normal roads/ramps stay
// well under this cap and are untouched.
const ENGINEERED_SURFACE_MAX_TRIANGLES = 8000;
// Synthesized vertical alignments are sampled every 8 m. Refining their road
// surfaces to 4 m added no profile information, but narrow buffered polygons
// can make longest-edge subdivision race to the 8k cap. Match the authored
// profile resolution and keep a lower safety cap; boundary vertices and all
// grade breaks remain exact.
const VERTICAL_ALIGNMENT_SURFACE_MAX_EDGE_M = 8;
const VERTICAL_ALIGNMENT_SURFACE_MAX_TRIANGLES = 2000;
const ROAD_STAGED_RING_MIN_POINTS = 32;
// Terrain/formation lookup is the expensive part of a refined road surface.
// Keep one visit comparable to the existing bike-paint task (8 quads × 4
// vertices), so an 8k-triangle engineered apron cannot monopolize a frame.
const ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP = 32;
const ROAD_VERTICAL_BIKE_MAX_SEGMENT_M = 8;
const SURFACE_ALIGNMENT_SET_KEY = 'road-surfaces:loaded';

function roadTileBuildPriority(tileTx, tileTz) {
    // Never let prediction demote the tile physically under the car. Once that
    // support tile is complete, the projected focus chooses the next build.
    if (tileDistanceSqToPoint(
        tileTx,
        tileTz,
        roadSupportFocusX,
        roadSupportFocusZ,
    ) === 0) return 1e12;
    return -tileDistanceSqToPoint(
        tileTx,
        tileTz,
        roadBuildFocusX,
        roadBuildFocusZ,
    );
}

// Wear tuning for the asphalt tile. Deliberately grouped so the "how dirty
// is our city" dials are in one place — counts are per 16×16 m tile.
const ASPHALT_WEAR = {
    tonePatches: 7,     // big soft lighter/darker worn areas
    cracks: 6,          // jagged dark crack polylines
    repairs: 3,         // darker fresh-asphalt patch rectangles
    potholes: 2,        // small dark blobs with a lighter rim
    stains: 5,          // faint oil/dirt streaks
};

// Procedurally-generated asphalt texture. 1024×1024 covering 16 m of road:
// mid-grey base with per-pixel grain plus macro wear — tonal patches,
// cracks, repair patches, the odd pothole and oil stain — so the surface
// reads as used city asphalt rather than fresh print. Wraps in both axes so
// the road UVs (world XZ in createRoadPolygonGeometry) repeat continuously
// across the entire network without seams. Generated once; ships zero bytes.
export function getAsphaltTexture() {
    if (asphaltTexture) return asphaltTexture;
    const SIZE = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;
    for (let i = 0; i < SIZE * SIZE; i++) {
        // Mid grey base + ±12 brightness noise — reads as weathered
        // concrete-grey rather than near-black.
        const v = 104 + Math.floor((Math.random() - 0.5) * 22);
        data[i * 4 + 0] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
    }
    // Sprinkle ~3% lighter aggregate specks (small lighter dots).
    const aggregateCount = Math.floor(SIZE * SIZE * 0.03);
    for (let n = 0; n < aggregateCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const v = 155 + Math.floor(Math.random() * 35);
        data[i + 0] = v; data[i + 1] = v; data[i + 2] = v;
    }
    // ~1% darker pits.
    const pitCount = Math.floor(SIZE * SIZE * 0.01);
    for (let n = 0; n < pitCount; n++) {
        const x = Math.floor(Math.random() * SIZE);
        const y = Math.floor(Math.random() * SIZE);
        const i = (y * SIZE + x) * 4;
        const v = 70 + Math.floor(Math.random() * 15);
        data[i + 0] = v; data[i + 1] = v; data[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);

    // ── Macro wear (painted over the grain) ────────────────────────────
    // Large soft tonal patches: slightly lighter worn areas and darker
    // damp/dirty ones, blended with radial gradients.
    for (let n = 0; n < ASPHALT_WEAR.tonePatches; n++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = 90 + Math.random() * 220;
        const lighter = Math.random() < 0.5;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const tone = lighter ? '190,190,188' : '52,52,54';
        g.addColorStop(0, `rgba(${tone},${(0.05 + Math.random() * 0.06).toFixed(2)})`);
        g.addColorStop(1, `rgba(${tone},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Repair patches: darker rectangles of fresher asphalt with a faint
    // outline, at a slight angle like real cut-and-fill work.
    for (let n = 0; n < ASPHALT_WEAR.repairs; n++) {
        ctx.save();
        ctx.translate(Math.random() * SIZE, Math.random() * SIZE);
        ctx.rotate((Math.random() - 0.5) * 0.5);
        const w = 90 + Math.random() * 200, h = 60 + Math.random() * 120;
        ctx.fillStyle = `rgba(58,58,62,${(0.18 + Math.random() * 0.10).toFixed(2)})`;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.strokeStyle = 'rgba(38,38,40,0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.restore();
    }
    // Cracks: jagged random-walk polylines with a soft dark halo.
    for (let n = 0; n < ASPHALT_WEAR.cracks; n++) {
        let x = Math.random() * SIZE, y = Math.random() * SIZE;
        let dir = Math.random() * Math.PI * 2;
        const steps = 14 + Math.floor(Math.random() * 22);
        for (const [width, alpha] of [[3.4, 0.10], [1.4, 0.45]]) {
            let cx = x, cy = y, cd = dir;
            ctx.strokeStyle = `rgba(30,30,32,${alpha})`;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            for (let s2 = 0; s2 < steps; s2++) {
                cd += (Math.random() - 0.5) * 1.1;
                cx += Math.cos(cd) * (6 + Math.random() * 12);
                cy += Math.sin(cd) * (6 + Math.random() * 12);
                ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        }
    }
    // Potholes: small dark blobs with a lighter worn rim.
    for (let n = 0; n < ASPHALT_WEAR.potholes; n++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = 7 + Math.random() * 14;
        ctx.fillStyle = 'rgba(168,168,164,0.30)';
        ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(24,24,26,0.75)';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // Oil / dirt streaks: long faint smudges.
    for (let n = 0; n < ASPHALT_WEAR.stains; n++) {
        ctx.save();
        ctx.translate(Math.random() * SIZE, Math.random() * SIZE);
        ctx.rotate(Math.random() * Math.PI);
        const w = 120 + Math.random() * 260, h = 8 + Math.random() * 22;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
        g.addColorStop(0, `rgba(40,40,42,${(0.08 + Math.random() * 0.07).toFixed(2)})`);
        g.addColorStop(1, 'rgba(40,40,42,0)');
        ctx.fillStyle = g;
        ctx.scale(1, h / w);
        ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }
    asphaltTexture = new THREE.CanvasTexture(canvas);
    asphaltTexture.wrapS = THREE.RepeatWrapping;
    asphaltTexture.wrapT = THREE.RepeatWrapping;
    asphaltTexture.colorSpace = THREE.SRGBColorSpace;
    asphaltTexture.anisotropy = 4;
    asphaltTexture.minFilter = THREE.LinearMipmapLinearFilter;
    asphaltTexture.magFilter = THREE.LinearFilter;
    asphaltTexture.generateMipmaps = true;
    registerShared(asphaltTexture);
    return asphaltTexture;
}

// Road surfaces and their dressing stand ON the ground rather than being it, so
// they answer to the narrower excavation channel rather than to plain formation
// ownership. A road may legitimately share a rail formation's ground — that is
// what a level crossing IS, and deleting it there would be a worse bug than the
// one this fixes — but it may never roof an open cut, which is exactly what the
// car park over the Stankovacka ulica station bay was doing: road surface,
// terrain collar and retaining face all hanging over a 4.2 m trench because
// this layer never asked the formation mask anything at all.
function authorizeSurfaceMaterial(material, claim) {
    applySurfaceStencil(material, claim);
    applyGroundOwnership(material, claim);
    applyPlannerSurfaceCutout(material, claim);
    return material;
}

export function getAsphaltMaterial(claim) {
    const key = surfaceMaterialKey(claim);
    if (asphaltMaterials.has(key)) return asphaltMaterials.get(key);
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getAsphaltTexture(),
        color: 0xd4d7da,
        // Preserve a very low albedo floor inside deep bridge/embankment
        // shadows. The surface at Savska was present and firm, but direct
        // shadow drove it close enough to black to read as an unloaded void.
        // This is deliberately too weak to look self-lit at night.
        emissive: 0x151719,
        emissiveIntensity: 0.32,
        roughness: 0.99,
        metalness: 0,
        // DoubleSide keeps physical decks visible from either side. The
        // polygon compiler gives every top an upward front face.
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.ROAD.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.ROAD.units,
    })), claim);
    registerShared(material);
    asphaltMaterials.set(key, material);
    return material;
}

// Dark European-style stone paving for pedestrian precincts. Intentionally
// cool grey / dark grey only — no warm yellow setts — and fairly flat so it
// reads as worn urban paving rather than rounded historic cobbles.
function getStonePavingTexture() {
    if (stonePavingTexture) return stonePavingTexture;
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgb(86,92,98)'; // cool mid-grey mortar
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Broad tonal drifts keep large plazas from reading like a tiny tiled stamp.
    for (let i = 0; i < 42; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const rx = 30 + Math.random() * 110;
        const ry = 24 + Math.random() * 90;
        const tone = Math.random() < 0.65 ? '236,242,248' : '42,48,54';
        const alpha = 0.02 + Math.random() * 0.04;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((Math.random() - 0.5) * Math.PI);
        ctx.fillStyle = `rgba(${tone},${alpha})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    let y = -20;
    while (y < SIZE + 28) {
        const rowH = 20 + ((Math.random() * 14) | 0);
        let x = -40 - ((Math.random() * 30) | 0);
        const rowOffset = (Math.random() - 0.5) * 20;
        const rowToneLift = (Math.random() - 0.5) * 14;
        while (x < SIZE + 44) {
            const stoneW = 26 + ((Math.random() * 30) | 0);
            const inset = 1;
            const px = x + inset + rowOffset;
            const py = y + inset;
            const w = Math.max(14, stoneW - inset * 2);
            const h = Math.max(12, rowH - inset * 2);

            const tone = 126 + rowToneLift + ((Math.random() * 26) | 0);
            const coolShift = -5 + ((Math.random() * 10) | 0);
            ctx.fillStyle = `rgb(${tone + coolShift},${tone + 2},${tone + 6})`;
            ctx.fillRect(px, py, w, h);

            // Subtle top-edge highlight and lower-edge darkening keep the
            // stones readable while still feeling flat and worn.
            ctx.fillStyle = 'rgba(230,238,246,0.13)';
            ctx.fillRect(px, py, w, 1);
            ctx.fillStyle = 'rgba(26,30,34,0.12)';
            ctx.fillRect(px, py + h - 1, w, 1);

            if (Math.random() < 0.2) {
                ctx.fillStyle = 'rgba(214,224,232,0.08)';
                ctx.fillRect(px + 3, py + 3, Math.max(5, w - 6), Math.max(3, h * 0.16));
            }
            if (Math.random() < 0.16) {
                ctx.fillStyle = 'rgba(60,68,74,0.06)';
                ctx.fillRect(px + 4, py + h * 0.35, Math.max(6, w - 8), Math.max(2, h * 0.12));
            }
            x += stoneW;
        }
        y += rowH;
    }

    // Fine grain / wear specks layered over the broader tone drift.
    for (let i = 0; i < 2600; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const r = 0.6 + Math.random() * 2.6;
        ctx.fillStyle = Math.random() < 0.55
            ? `rgba(226,234,242,${0.02 + Math.random() * 0.04})`
            : `rgba(32,38,44,${0.02 + Math.random() * 0.04})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    stonePavingTexture = new THREE.CanvasTexture(canvas);
    stonePavingTexture.wrapS = THREE.RepeatWrapping;
    stonePavingTexture.wrapT = THREE.RepeatWrapping;
    stonePavingTexture.colorSpace = THREE.SRGBColorSpace;
    stonePavingTexture.anisotropy = 4;
    stonePavingTexture.minFilter = THREE.LinearMipmapLinearFilter;
    stonePavingTexture.magFilter = THREE.LinearFilter;
    stonePavingTexture.generateMipmaps = true;
    const r = ASPHALT_TILE_M / STONE_PAVING_TILE_PER_IMAGE_M;
    stonePavingTexture.repeat.set(r, r);
    registerShared(stonePavingTexture);
    return stonePavingTexture;
}

function getStonePavingMaterial(claim) {
    const key = surfaceMaterialKey(claim);
    if (stonePavingMaterials.has(key)) return stonePavingMaterials.get(key);
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshBasicMaterial({
        map: getStonePavingTexture(),
        side: THREE.DoubleSide,
        polygonOffset: true,
        // More negative than asphalt's (-1) so pedestrian paving wins depth
        // ties against overlapping mapped roads at grazing distance.
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.SIDEWALK.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.SIDEWALK.units,
    })), claim);
    registerShared(material);
    stonePavingMaterials.set(key, material);
    return material;
}

const registeredGroundPaintStyles = new WeakSet();
export function roadGroundPaintStyle(type, paint = groundPaint) {
    // Stable IDs and shared texture identities keep owner updates local. Cycle
    // paint reuses concrete's pattern; road appearance adds one pattern layer.
    if (!registeredGroundPaintStyles.has(paint)) {
        const concrete = getSidewalkTexture();
        const styles = [
            ['pedestrian-pavers', 1, SURFACE_CLASS.SIDEWALK, getStonePavingTexture(), .95, 0xffffff, 'pedestrian-pavers'],
            ['concrete-path', 2, SURFACE_CLASS.BUFFERED_SIDEWALK, concrete, .92, 0xffffff, 'concrete-path'],
            ['road-asphalt', 3, SURFACE_CLASS.ROAD_CARRIAGEWAY, getAsphaltTexture(), .99, 0xd4d7da, 'road-asphalt'],
            ['cycle-base', 4, SURFACE_CLASS.CYCLEWAY, concrete, .92, 0xffffff, 'concrete-path'],
            ['cycle-red', 5, SURFACE_CLASS.CYCLEWAY, concrete, .9, 0xa8452f, 'concrete-path'],
            ['parking-asphalt', 6, SURFACE_CLASS.PARKING, getAsphaltTexture(), .9, 0xc4c4c4, 'road-asphalt'],
            ['construction-gravel', 7, SURFACE_CLASS.CONSTRUCTION, getGravelTexture(), .95, 0xffffff, 'construction-gravel', GRAVEL_UV_PER_M],
        ];
        for (const [key, id, surfaceClass, texture, roughness, color, patternKey, uvPerM = ASPHALT_UV_PER_M] of styles) {
            texture.updateMatrix();
            const e = texture.matrix.elements;
            paint.registerStyle(key, { id, revision: 'ground-material-v2', surfaceClass,
                roughness, metalness: 0, normalInfluence: 0, linearColor: new THREE.Color(color).toArray(),
                albedoMap: { key: patternKey, revision: 'ground-texture-v2',
                    uvTransform: [e[0]*uvPerM, e[3]*uvPerM, e[6],
                        e[1]*uvPerM, e[4]*uvPerM, e[7]] },
            }, texture);
        }
        registeredGroundPaintStyles.add(paint);
    }
    const key = type === 'pedestrian' ? 'pedestrian-pavers' : type === 'cycleway' ? 'cycle-base'
        : type === 'parking' ? 'parking-asphalt' : type === 'construction' ? 'construction-gravel'
        : type === 'bike-paint' ? 'cycle-red' : SIDEWALK_LEVEL_TYPES.has(type) ? 'concrete-path' : 'road-asphalt';
    return { key, revision: 'ground-material-v2' };
}

// Procedural Zagreb-style trackbed pattern. The real Zagreb tram
// trackbed (visible from Street View) is laid in small concrete pavers
// on a regular grid, organised into larger panels with deeper grooves
// between them, with small light-coloured rectangular markers cast
// into the panel corners. We approximate that:
//   • ~10 cm pavers (1 paver = PAVER_PX of texture)
//   • 4×4 pavers per panel = 40 cm panel
//   • Mortar lines between every paver
//   • Deeper groove between panels
//   • One small light marker per panel corner
//   • Per-paver brightness jitter so it doesn't look like a regular grid
// 256² canvas = 1.6 m on the ground (see ZAGREB_TILE_PER_IMAGE_M).
function getTrackbedTexture() {
    if (trackbedTexture) return trackbedTexture;
    const SIZE = 256;
    const PAVER_PX = 16;             // ≈10 cm paver at 1.6 m / 256 px
    const PANEL_PX = PAVER_PX * 4;   // 4 pavers per panel = 40 cm
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    // Dark, weathered concrete grey. The previous pale base read almost like
    // sidewalk paving in sunlight and weakened the new narrow-bed boundary.
    ctx.fillStyle = 'rgb(132,134,132)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Per-paver tint + per-pixel grain: walk the bitmap once and
    // add a small per-paver brightness offset plus tiny per-pixel
    // noise. Reads as cast concrete rather than a flat grid.
    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    const data = img.data;
    for (let py = 0; py < SIZE; py += PAVER_PX) {
        for (let px = 0; px < SIZE; px += PAVER_PX) {
            const tint = Math.floor((Math.random() - 0.5) * 28);
            for (let dy = 0; dy < PAVER_PX; dy++) {
                for (let dx = 0; dx < PAVER_PX; dx++) {
                    const i = ((py + dy) * SIZE + (px + dx)) * 4;
                    const noise = Math.floor((Math.random() - 0.5) * 8);
                    const v = Math.max(0, Math.min(255, data[i] + tint + noise));
                    data[i + 0] = v; data[i + 1] = v; data[i + 2] = v;
                }
            }
        }
    }
    ctx.putImageData(img, 0, 0);

    // Mortar lines between every paver (1 px, dark grey).
    ctx.strokeStyle = 'rgba(64,66,66,0.85)';
    ctx.lineWidth = 1;
    for (let p = 0; p <= SIZE; p += PAVER_PX) {
        ctx.beginPath();
        ctx.moveTo(p + 0.5, 0);
        ctx.lineTo(p + 0.5, SIZE);
        ctx.moveTo(0, p + 0.5);
        ctx.lineTo(SIZE, p + 0.5);
        ctx.stroke();
    }
    // Panel-break grooves every 4 pavers (2 px, deeper).
    ctx.strokeStyle = 'rgba(40,42,42,0.95)';
    ctx.lineWidth = 2;
    for (let p = 0; p <= SIZE; p += PANEL_PX) {
        ctx.beginPath();
        ctx.moveTo(p, 0); ctx.lineTo(p, SIZE);
        ctx.moveTo(0, p); ctx.lineTo(SIZE, p);
        ctx.stroke();
    }

    // Light inset markers at each panel corner — short bright rectangles
    // oriented along the rail direction (the trackbed strip's local Z).
    // Three markers per panel (top-left, top-right, bottom-left of the
    // panel quadrant) to roughly match the Zagreb pattern density.
    ctx.fillStyle = 'rgba(202,202,196,0.82)';
    for (let py = 0; py < SIZE; py += PANEL_PX) {
        for (let px = 0; px < SIZE; px += PANEL_PX) {
            // Top-left corner of panel
            ctx.fillRect(px + PAVER_PX * 0.3, py + PAVER_PX * 0.3, 3, 5);
            // Top-right corner of panel
            ctx.fillRect(px + PANEL_PX - PAVER_PX * 0.6, py + PAVER_PX * 0.3, 3, 5);
            // Mid-bottom marker
            ctx.fillRect(px + PANEL_PX * 0.5, py + PANEL_PX - PAVER_PX * 0.7, 3, 5);
        }
    }

    trackbedTexture = new THREE.CanvasTexture(canvas);
    trackbedTexture.wrapS = THREE.RepeatWrapping;
    trackbedTexture.wrapT = THREE.RepeatWrapping;
    trackbedTexture.colorSpace = THREE.SRGBColorSpace;
    trackbedTexture.anisotropy = 4;
    trackbedTexture.minFilter = THREE.LinearMipmapLinearFilter;
    trackbedTexture.magFilter = THREE.LinearFilter;
    trackbedTexture.generateMipmaps = true;
    // World-XZ UVs come in at 1/ASPHALT_TILE_M = 0.0625 units per metre.
    // Image covers ZAGREB_TILE_PER_IMAGE_M m, so repeat = ASPHALT/ZAGREB.
    const r = ASPHALT_TILE_M / ZAGREB_TILE_PER_IMAGE_M;
    trackbedTexture.repeat.set(r, r);
    registerShared(trackbedTexture);
    return trackbedTexture;
}

function getTrackbedMaterial(claim) {
    const key = surfaceMaterialKey(claim);
    if (trackbedMaterials.has(key)) return trackbedMaterials.get(key);
    // Lit, unlike asphalt: an unlit pale texture stayed at daytime brightness
    // after sunset. A restrained conformal lamp contribution makes paving
    // readable near fixtures without turning the whole bed white.
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getTrackbedTexture(),
        roughness: 0.96,
        side: THREE.DoubleSide,
        polygonOffset: true,
        // Tram paving is the final ground surface wherever it overlaps a
        // road, plaza, pedestrian zone, or decor polygon. Its bias must be
        // stronger than pedestrian paving/edging (-2) so shallow cab views
        // cannot let those neighbouring surfaces punch through the bed.
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.RAIL_TRACKBED.units,
    }), GROUND_SURFACE_LEVELS.tramBed), claim);
    registerShared(material);
    trackbedMaterials.set(key, material);
    return material;
}

function getConcretePathMaterial(claim) {
    const key = surfaceMaterialKey(claim);
    if (concretePathMaterials.has(key)) return concretePathMaterials.get(key);
    // Same texture and UV scale as the ground plane (ASPHALT_TILE_M ==
    // SIDEWALK_TILE_M == 16 m), so footways blend into the surrounding
    // pavement seamlessly and only stand out where they cross grass.
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        roughness: 0.92,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.BUFFERED_SIDEWALK.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.BUFFERED_SIDEWALK.units,
    })), claim);
    registerShared(material);
    concretePathMaterials.set(key, material);
    return material;
}

// Every OSM representation of cycling infrastructure uses the same red paint
// ribbon below: standalone highway=cycleway ways, side-specific road tags, and
// shared bicycle paths. The owning road/path polygon remains neutral paving.
const bikePaintMaterials = new Map();

function getBikePaintMaterial(ownerClaim) {
    const claim = reviseSurfaceClaim(ownerClaim, {
        surfaceClass: SURFACE_CLASS.CYCLEWAY,
        paintsColor: true,
        supportReady: false,
        cutsBackstop: false,
    });
    const key = surfaceMaterialKey(claim);
    if (bikePaintMaterials.has(key)) return bikePaintMaterials.get(key);
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        color: 0xa8452f,
        roughness: 0.9,
        side: THREE.DoubleSide,
        // Paint must still obey the owning surface's depth. Disabling this made
        // a cycle lane on the far side of a bridge visible through its asphalt.
        // The slight polygon offset keeps coplanar paint crisp without turning
        // it into an always-on-top overlay.
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: SURFACE_POLYGON_OFFSET.CYCLEWAY.factor,
        polygonOffsetUnits: SURFACE_POLYGON_OFFSET.CYCLEWAY.units,
    })), claim);
    registerShared(material);
    bikePaintMaterials.set(key, material);
    return material;
}

function getRoadMaterial(type, claim) {
    // Standalone buffered tram polygons are rejected in
    // buildRoadFeatureGroup; rails.js owns that complete surface. A real
    // highway that also carries tram tags still arrives here as its highway
    // type and remains ordinary asphalt around the paved tram bed.
    if (type === 'pedestrian') {
        return getStonePavingMaterial(claim);
    }
    if (SIDEWALK_LEVEL_TYPES.has(type)) {
        return getConcretePathMaterial(claim);
    }
    if (COLOURED_RAILWAY_TYPES.has(type)) {
        const key = `${type}:${surfaceMaterialKey(claim)}`;
        if (!roadMaterials.has(key)) {
            const mat = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(new THREE.MeshBasicMaterial({
                color: RAILWAY_COLORS[type],
                side: THREE.DoubleSide,
                polygonOffset: true,
                // More aggressively negative than asphalt's (factor -1, units 1):
                // both are coplanar in places and we want rail to win the
                // depth comparison so the overpass flicker disappears even
                // when the Y-lift above isn't quite enough at extreme view
                // distances.
                polygonOffsetFactor: SURFACE_POLYGON_OFFSET.TRAM_CORRIDOR.factor,
                polygonOffsetUnits: SURFACE_POLYGON_OFFSET.TRAM_CORRIDOR.units,
            })), claim);
            registerShared(mat);
            roadMaterials.set(key, mat);
        }
        return roadMaterials.get(key);
    }
    return getAsphaltMaterial(claim);
}

function getRetainingWallMaterial(ctx) {
    const claim = roadStructureClaim(ctx);
    const key = surfaceMaterialKey(claim);
    if (retainingWallMaterials.has(key)) return retainingWallMaterials.get(key);
    if (!retainingWallConcreteSurface) {
        const raster = createRoadRetainingConcreteRaster(256, 0x72d14a);
        const makeTexture = (data, colorSpace = null) => {
            const texture = new THREE.DataTexture(
                data,
                raster.size,
                raster.size,
                THREE.RGBAFormat,
            );
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = true;
            texture.anisotropy = 4;
            texture.repeat.set(
                1 / ROAD_RETAINING_CONCRETE_TILE_M,
                1 / ROAD_RETAINING_CONCRETE_TILE_M,
            );
            if (colorSpace) texture.colorSpace = colorSpace;
            texture.needsUpdate = true;
            registerShared(texture);
            return texture;
        };
        retainingWallConcreteSurface = {
            map: makeTexture(raster.color, THREE.SRGBColorSpace),
            bumpMap: makeTexture(raster.height),
        };
    }
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(
        new THREE.MeshStandardMaterial({
            map: retainingWallConcreteSurface.map,
            bumpMap: retainingWallConcreteSurface.bumpMap,
            bumpScale: 0.34,
            color: 0xe5dbc7,
            roughness: 0.97,
            metalness: 0,
            side: THREE.DoubleSide,
        }),
    ), claim);
    registerShared(material);
    retainingWallMaterials.set(key, material);
    return material;
}

function getFormationTerrainCollarMaterial(ctx) {
    const claim = roadEarthworkClaim(ctx);
    const key = surfaceMaterialKey(claim);
    if (formationTerrainCollarMaterials.has(key)) {
        return formationTerrainCollarMaterials.get(key);
    }
    const surface = getActiveTerrainSurface();
    // Collars deliberately overlap the terrain to seal quantisation gaps, so
    // they must carry every material classification of the terrain they
    // continue. The same batch also contains cut/fill earth faces: restrict
    // the broad urban cover to upward-facing ground so Ilica's flat seam reads
    // as pavement without painting concrete down an embankment.
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(
        new THREE.MeshStandardMaterial({
            map: surface.map,
            bumpMap: surface.bumpMap,
            bumpScale: surface.bumpScale,
            roughness: 0.96,
            metalness: 0,
            side: THREE.DoubleSide,
        }),
    ), claim);
    applyUrbanGroundSurface(material, claim, {
        fieldPatchwork: true,
        urbanGroundUpwardOnly: true,
    });
    registerShared(material);
    formationTerrainCollarMaterials.set(key, material);
    return material;
}

function getSidewalkTerrainSeamMaterial(ctx) {
    const claim = sidewalkTerrainSeamClaim(ctx);
    const key = surfaceMaterialKey(claim);
    if (sidewalkTerrainSeamMaterials.has(key)) {
        return sidewalkTerrainSeamMaterials.get(key);
    }
    const surface = getActiveTerrainSurface();
    // This collar is the final few centimetres of surrounding ground. It must
    // inherit the same urban/natural classification as that ground while the
    // exact sidewalk mesh remains the sole owner of the explicit paved
    // footprint. Limit the generic cover to upward-facing facets so a seam on
    // a cut does not turn its exposed earth wall into concrete.
    const material = authorizeSurfaceMaterial(applyStreetLampSurfaceLighting(
        new THREE.MeshStandardMaterial({
            map: surface.map,
            bumpMap: surface.bumpMap,
            bumpScale: surface.bumpScale,
            roughness: 0.96,
            metalness: 0,
            side: THREE.DoubleSide,
        }),
    ), claim);
    applyUrbanGroundSurface(material, claim, {
        fieldPatchwork: true,
        urbanGroundUpwardOnly: true,
    });
    registerShared(material);
    sidewalkTerrainSeamMaterials.set(key, material);
    return material;
}

// Exposed for rails.js to paint a narrow trackbed strip. Same texture
// instance the road layer would use, just lazy-initialised on demand.
export function getTrackbedMaterialForRails(claim) {
    return getTrackbedMaterial(claim);
}

// Exposed for proposals.js so proposed road polygons share the exact
// asphalt material used by OSM roads (matching look, single shared
// texture). Lazy — does nothing until the first proposal road shows up.
export function getAsphaltMaterialForProposals(claim) {
    return getAsphaltMaterial(claim);
}

const ROAD_MATERIAL_PREWARM_READY_LABEL = 'road-material-prewarm';

function addRoadMaterialPrewarmRepresentative(
    root,
    geometry,
    material,
    seenMaterials,
    { receiveShadow = true } = {},
) {
    if (!material || seenMaterials.has(material)) return;
    seenMaterials.add(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'RoadMaterialPrewarmRepresentative';
    mesh.receiveShadow = receiveShadow;
    mesh.castShadow = false;
    root.add(mesh);
}

function* createRoadMaterialPrewarm(root, geometry) {
    const seenMaterials = new Set();
    for (const followsVerticalAlignment of [false, true]) {
        const suffix = followsVerticalAlignment ? 'grade-separated' : 'same-level';
        const contextFor = (type, railwayType = '') => ({
            type,
            followsVerticalAlignment,
            feature: {
                properties: railwayType ? { railway_type: railwayType } : {},
            },
            entityMetadata: { key: `road-material-prewarm:${type}:${suffix}` },
        });
        for (const [type, railwayType] of [
            ['default', ''],
            ['pedestrian', ''],
            ['footway', ''],
            ['cycleway', ''],
            ['subway', 'subway'],
        ]) {
            const ctx = contextFor(type, railwayType);
            const claim = roadSurfaceClaim(ctx);
            addRoadMaterialPrewarmRepresentative(
                root,
                geometry,
                getRoadMaterial(type, claim),
                seenMaterials,
            );
            yield { phase: 'road-material-prewarm:create', type, suffix };
            if (type === 'cycleway') {
                addRoadMaterialPrewarmRepresentative(
                    root,
                    geometry,
                    getBikePaintMaterial(claim),
                    seenMaterials,
                );
                yield { phase: 'road-material-prewarm:create', type: 'bike-paint', suffix };
            }
        }

        const structureContext = contextFor('default');
        addRoadMaterialPrewarmRepresentative(
            root,
            geometry,
            getRetainingWallMaterial(structureContext),
            seenMaterials,
            { receiveShadow: false },
        );
        yield { phase: 'road-material-prewarm:create', type: 'retaining-wall', suffix };
        addRoadMaterialPrewarmRepresentative(
            root,
            geometry,
            getFormationTerrainCollarMaterial(structureContext),
            seenMaterials,
        );
        yield { phase: 'road-material-prewarm:create', type: 'terrain-collar', suffix };
    }

    yield* prewarmDetachedObject(root, {
        renderer,
        camera,
        targetScene: scene,
        asyncShaders: true,
        label: ROAD_MATERIAL_PREWARM_READY_LABEL,
        uploadBatch: 1,
        sliceMs: 2,
        uploadGeometry: false,
    });
}

function settleRoadMaterialPrewarm(state) {
    if (!state || state.settled) return;
    state.settled = true;
    state.iterator?.return?.();
    state.root.clear();
    state.geometry.dispose();
    if (roadMaterialPrewarmState === state) roadMaterialPrewarmState = null;
    noteWorldQueueIdle(ROAD_MATERIAL_PREWARM_READY_LABEL);
}

function startRoadMaterialPrewarm() {
    if (roadMaterialPrewarmState) settleRoadMaterialPrewarm(roadMaterialPrewarmState);
    const root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const state = {
        root,
        geometry,
        iterator: createRoadMaterialPrewarm(root, geometry),
        job: null,
        settled: false,
    };
    roadMaterialPrewarmState = state;
    noteWorldQueueActive(ROAD_MATERIAL_PREWARM_READY_LABEL);
    const settle = () => settleRoadMaterialPrewarm(state);
    state.job = buildQueue.enqueue([state], (item) => {
        const startedMs = performance.now();
        const outcome = item.iterator.next();
        const phase = String(outcome.value?.phase || 'complete');
        recordLayerFrameMs(`roads:${phase}`, performance.now() - startedMs);
        return outcome.done ? undefined : FRAME_CHUNK_DEFER_ITEM;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: settle,
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 1,
        priority: Number.MAX_SAFE_INTEGER,
        describeItem: () => 'road material GPU prewarm',
    });
}

function getRoadSurfaceY(type, railwayType) {
    return roadSurfaceSceneOffset(type, railwayType);
}

function localRoadRing(ring, aLon, aLat) {
    const cosLat = Math.cos(aLat * DEG_TO_RAD);
    const points = [];
    for (const [lon, lat] of ring) {
        const x = (lon - aLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
        const z = -(lat - aLat) * DEG_TO_RAD * EARTH_RADIUS_M;
        points.push({ x, z });
    }
    if (points.length > 2) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.z - last.z) < 1e-6) points.pop();
    }
    return points;
}

function shapeGeometryForLocalRing(localRing) {
    const shape = new THREE.Shape();
    for (let index = 0; index < localRing.length; index++) {
        const point = localRing[index];
        if (index === 0) shape.moveTo(point.x, point.z);
        else shape.lineTo(point.x, point.z);
    }
    return new THREE.ShapeGeometry(shape);
}

function applyWorldRoadUvs(geometry) {
    const positions = geometry.getAttribute('position');
    const uvs = new Float32Array(positions.count * 2);
    for (let index = 0; index < positions.count; index++) {
        uvs[index * 2] = positions.getX(index) * ASPHALT_UV_PER_M;
        uvs[index * 2 + 1] = positions.getZ(index) * ASPHALT_UV_PER_M;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function orientRoadTopGeometry(geometry) {
    // The compiler maps ShapeGeometry's XY plane to world XZ, a reflection
    // that turns its +Z front faces downward. Reverse the final topology once
    // so flat, draped and engineered tops all retain an upward front face.
    // Do this AFTER refinement: reversing its input can change tied edge
    // choices and the tessellation. Final reversal preserves every sampled
    // coordinate, UV and support triangle, changing only its facing direction.
    const indices = geometry.index.array;
    for (let i = 0; i < indices.length; i += 3) {
        const second = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = second;
    }
    return geometry;
}

// Aggregated per-sub-step timing for the road build, dumped once via
// window.__roadsBuildReport() after the world settles. Only accumulates when the
// startup trace is enabled (?perf / localhost), so it costs nothing in normal use.
const roadBuildProfile = {
    roads: 0, rings: 0, verts: 0,
    ms_total: 0, ms_mask: 0, ms_densify: 0, ms_shape: 0,
    ms_formation: 0, max_formation: 0, formation_builds: 0,
    ms_refine: 0, ms_sample: 0, ms_finalize: 0,
};
function profNow() { return startupTrace.enabled ? performance.now() : 0; }
function profAdd(key, t0) {
    if (!startupTrace.enabled) return 0;
    const elapsedMs = performance.now() - t0;
    roadBuildProfile[key] += elapsedMs;
    return elapsedMs;
}
if (typeof window !== 'undefined') {
    window.__roadsBuildReport = () => {
        const p = roadBuildProfile;
        const perRoad = p.roads ? (p.ms_total / p.roads) : 0;
        console.log(`%c[roads-build] ${p.roads} roads, ${p.rings} rings, ${p.verts} refined verts — ${perRoad.toFixed(1)}ms/road`, 'color:#9fe;font-weight:bold');
        if (console.table) console.table({
            mask: +p.ms_mask.toFixed(0), densify: +p.ms_densify.toFixed(0),
            formation: +p.ms_formation.toFixed(0),
            'formation max': +p.max_formation.toFixed(1),
            'formation builds': p.formation_builds,
            'shape(earcut)': +p.ms_shape.toFixed(0), refine: +p.ms_refine.toFixed(0),
            'sample(terrain)': +p.ms_sample.toFixed(0), finalize: +p.ms_finalize.toFixed(0),
            TOTAL: +p.ms_total.toFixed(0),
        });
        return p;
    };
}

function createTerrainConformingRoadGeometryTask(
    seedGeometry,
    y,
    osmId,
    engineered,
    followNearbyCarriagewayProfile,
    nearbyCarriagewayTangentAtLocal = null,
    useComposedCivilGround = false,
    tunnelPathSurface = false,
    ground,
    { abortOnMissingTerrain = false } = {},
) {
    const { terrain: terrainReference, roadFormation: roadFormationModel,
        verticalAlignments: roadVerticalAlignmentModel, civilGround: civilGroundReference } = ground;
    const followsVerticalAlignment = osmId != null
        && !!roadVerticalAlignmentModel?.getAlignmentForOsmId(osmId);
    let refinementMaxEdgeM = followsVerticalAlignment
        ? VERTICAL_ALIGNMENT_SURFACE_MAX_EDGE_M
        : engineered ? ENGINEERED_SURFACE_MAX_EDGE_M : DRAPED_SURFACE_MAX_EDGE_M;
    const refinementMaxTriangles = followsVerticalAlignment
        ? VERTICAL_ALIGNMENT_SURFACE_MAX_TRIANGLES
        : engineered ? ENGINEERED_SURFACE_MAX_TRIANGLES : DRAPED_SURFACE_MAX_TRIANGLES;
    const formationModel = engineered || followNearbyCarriagewayProfile
        ? roadFormationModel
        : null;
    let phase = 'seed';
    let seedPoints = null;
    let seedTriangles = null;
    let refined = null;
    let positions = null;
    let sampleIndex = 0;
    let geometry = null;
    // Set when the task gives up on a sample for good: which point, and why.
    let omission = null;

    return {
        step() {
            if (phase === 'seed') {
                const seedPositions = seedGeometry.getAttribute('position');
                seedPoints = [];
                for (let index = 0; index < seedPositions.count; index++) {
                    seedPoints.push({ x: seedPositions.getX(index), z: seedPositions.getY(index) });
                }
                const seedIndexValues = seedGeometry.index
                    ? Array.from(seedGeometry.index.array)
                    : Array.from({ length: seedPositions.count }, (_value, index) => index);
                seedTriangles = [];
                for (let index = 0; index + 2 < seedIndexValues.length; index += 3) {
                    seedTriangles.push([
                        seedIndexValues[index],
                        seedIndexValues[index + 1],
                        seedIndexValues[index + 2],
                    ]);
                }
                if (!followsVerticalAlignment && !engineered) {
                    refinementMaxEdgeM = drapeEdgeMForTriangulation(
                        seedPoints,
                        seedTriangles,
                        (x, z) => terrainReference?.sampleStepMAtLocal?.(x, z),
                        DRAPED_SURFACE_MAX_EDGE_M,
                    );
                }
                phase = 'refine';
                return 'more';
            }
            if (phase === 'refine') {
                const tRefine = profNow();
                refined = refineTriangulatedSurface(
                    seedPoints,
                    seedTriangles,
                    refinementMaxEdgeM,
                    refinementMaxTriangles,
                );
                profAdd('ms_refine', tRefine);
                if (startupTrace.enabled) roadBuildProfile.verts += refined.points.length;
                seedPoints = null;
                seedTriangles = null;
                phase = 'sample';
                return 'more';
            }
            if (phase === 'sample') {
                const tSample = profNow();
                if (!positions) positions = new Float32Array(refined.points.length * 3);
                const end = Math.min(
                    refined.points.length,
                    sampleIndex + ROAD_TERRAIN_SAMPLE_POINTS_PER_STEP,
                );
                while (sampleIndex < end) {
                    const point = refined.points[sampleIndex];
                    const alignmentY = !followsVerticalAlignment
                        ? null
                        : finiteOrNull(roadVerticalAlignmentModel?.roadYAtLocal(
                            point.x,
                            point.z,
                            osmId,
                        ));
                    // A tunnel path is underground by definition, so its solved
                    // floor may never show above the ground the player sees.
                    // The solver digs below the civil terrain EVIDENCE, and on
                    // a steep ridge that coarse evidence can sit metres above
                    // the rendered LiDAR ground (Tomićeva: 5 m), which put the
                    // passage under the funicular 2 m over the viaduct deck.
                    // Judge against the rendered terrain once its core has
                    // loaded; drop the ring rather than float the strip.
                    if (tunnelPathSurface && alignmentY != null
                        && tunnelPathSurfaceAboveGround(
                            alignmentY,
                            terrainReference.hasLoadedCoreCoverageAtLocal?.(point.x, point.z)
                                === true
                                ? finiteOrNull(terrainReference.sceneYAtLocal?.(point.x, point.z))
                                : terrainReference.evidenceSceneYAtLocal(point.x, point.z),
                        )) {
                        omission = Object.freeze({ kind: 'excluded', reason: 'tunnel-path-above-ground',
                            x: point.x, z: point.z });
                        seedGeometry.dispose();
                        seedGeometry = null;
                        refined = null;
                        positions = null;
                        phase = 'no-data';
                        return 'no-data';
                    }
                    const groundY = alignmentY != null
                        ? alignmentY
                        : engineered && formationModel
                            ? formationModel.sceneYAtLocal(point.x, point.z, { osmId })
                        // A way explicitly mapped as a roadside sidewalk uses
                        // the nearby carriageway's smoothly blended grade.
                        : followNearbyCarriagewayProfile && formationModel
                            ? formationModel.groundSceneYAtLocal(
                                point.x,
                                point.z,
                                nearbyCarriagewayTangentAtLocal?.(point.x, point.z) || {},
                            )
                        // A standalone path is later than rail and road in the
                        // civil-ground order. Sampling the immutable DTM here
                        // leaves a floating sheet when an embankment/cut has
                        // replaced that terrain underneath it.
                        : useComposedCivilGround
                            ? civilGroundReference?.inputEvidenceSceneYAtLocal(
                                CIVIL_GROUND_AUTHORITY.PATH,
                                point.x,
                                point.z,
                            )
                        : terrainReference.evidenceSceneYAtLocal(point.x, point.z);
                    if (finiteOrNull(groundY) === null) {
                        // A missing owning terrain cell, or evidence withheld
                        // while a detail window is pending, is transient and
                        // must defer. NoData inside an already loaded core is
                        // final (coast/sea or a source hole): retrying it
                        // forever wedges every tile job behind this feature.
                        // Drop the unpublished ring without inventing a
                        // terrain height, and record WHERE: permanence is a
                        // property of this sample, not of the feature. A 40 m
                        // pier way at Split's port has 20 m data at its centre
                        // and NoData at its west end (2026-09-16), so a test at
                        // the feature's centre said "retry" for good.
                        // core/terrain-evidence-gap.js holds the one rule.
                        if (!isPermanentTerrainGap(ground, point.x, point.z)) {
                            // A coordinated ground generation owns an immutable
                            // terrain read. Waiting inside that candidate cannot
                            // make this sample appear; newer terrain windows
                            // would only accumulate behind it. Retire the private
                            // candidate so the coordinator can restore its source
                            // obligation against the newest admitted terrain.
                            if (abortOnMissingTerrain) {
                                throw Object.assign(
                                    new Error(`Road surface ${osmId ?? 'unknown'} lacks terrain evidence at ${point.x},${point.z}`),
                                    { code: 'road-surface-terrain-incomplete', details: {
                                        osmId: osmId ?? null, x: point.x, z: point.z,
                                    } },
                                );
                            }
                            return 'defer';
                        }
                        omission = Object.freeze({ kind: 'excluded', reason: 'terrain-evidence',
                            x: point.x, z: point.z });
                        seedGeometry.dispose();
                        seedGeometry = null;
                        refined = null;
                        positions = null;
                        phase = 'no-data';
                        return 'no-data';
                    }
                    positions[sampleIndex * 3] = point.x;
                    positions[sampleIndex * 3 + 1] = groundY + y;
                    positions[sampleIndex * 3 + 2] = point.z;
                    sampleIndex += 1;
                }
                profAdd('ms_sample', tSample);
                if (sampleIndex < refined.points.length) return 'more';
                phase = 'finalize';
                return 'more';
            }
            if (phase === 'finalize') {
                const tFinalize = profNow();
                geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                geometry.setIndex(refined.triangles.flat());
                orientRoadTopGeometry(geometry);
                applyWorldRoadUvs(geometry);
                geometry.computeVertexNormals();
                geometry.computeBoundingSphere();
                seedGeometry.dispose();
                seedGeometry = null;
                profAdd('ms_finalize', tFinalize);
                refined = null;
                positions = null;
                phase = 'done';
            }
            return 'done';
        },
        dispose() {
            seedGeometry?.dispose();
            geometry?.dispose();
            seedGeometry = geometry = refined = positions = null;
            phase = 'done';
        },
        geometry: () => geometry,
        omission: () => omission,
        phaseLabel: () => {
            if (phase === 'sample') {
                return `sample ${sampleIndex}/${refined?.points?.length || 0}`;
            }
            return phase;
        },
    };
}

function createRoadPolygonGeometryTask(
    ring,
    aLon,
    aLat,
    y,
    osmId,
    engineered,
    profile = null,
    followNearbyCarriagewayProfile = false,
    nearbyCarriagewayTangentAtLocal = null,
    useComposedCivilGround = false,
    tunnelPathSurface = false,
    ground,
    options = {},
) {
    const { terrain: terrainReference, roadFormation: roadFormationModel,
        verticalAlignments: roadVerticalAlignmentModel, civilGround: civilGroundReference } = ground;
    let phase = 'project';
    let localRing = null;
    let seedGeometry = null;
    let terrainTask = null;
    let geometry = null;
    let footprint = null;
    let omission = null;

    return {
        step() {
            if (phase === 'project') {
                const rawLocalRing = localRoadRing(ring, aLon, aLat);
                footprint = rawLocalRing;
                // Use the profile's own inner ring for engineered roads: the road top and
                // retaining face then share byte-for-byte boundary coordinates. Generic
                // terrain-draped paths still receive a short perimeter before refinement.
                const tDensify = profNow();
                localRing = engineered && profile?.innerRing?.length >= 3
                    ? profile.innerRing
                    // Seed the ring at the DTM resolution, not the 4 m PROFILE_STEP_M: finer
                    // perimeter points only inflate the ShapeGeometry seed (and, for complex
                    // polygons, push it past the refinement cap into thousands of draped
                    // vertices) without adding terrain detail the 20 m grid contains. Raw
                    // polygon vertices are always preserved; only collinear infill is coarser.
                    : terrainReference
                        ? densifyClosedLocalRing(rawLocalRing, DRAPED_SURFACE_MAX_EDGE_M)
                        : rawLocalRing;
                profAdd('ms_densify', tDensify);
                phase = localRing.length < 3 ? 'done' : 'shape';
                return phase === 'done' ? 'done' : 'more';
            }
            if (phase === 'shape') {
                const tShape = profNow();
                seedGeometry = shapeGeometryForLocalRing(localRing);
                profAdd('ms_shape', tShape);
                if (startupTrace.enabled) roadBuildProfile.rings += 1;
                localRing = null;
                if (terrainReference) {
                    terrainTask = createTerrainConformingRoadGeometryTask(
                        seedGeometry,
                        y,
                        osmId,
                        engineered,
                        followNearbyCarriagewayProfile,
                        nearbyCarriagewayTangentAtLocal,
                        useComposedCivilGround,
                        tunnelPathSurface,
                        ground,
                        options,
                    );
                    phase = 'terrain';
                    return 'more';
                }
                phase = 'flat';
                return 'more';
            }
            if (phase === 'terrain') {
                const status = terrainTask.step();
                if (status === 'more') return 'more';
                if (status === 'defer') return 'defer';
                if (status === 'no-data') {
                    omission = terrainTask.omission?.() || null;
                    terrainTask = null;
                    seedGeometry = null;
                    phase = 'done';
                    return 'no-data';
                }
                geometry = terrainTask.geometry();
                terrainTask = null;
                seedGeometry = null;
                phase = 'done';
                return 'done';
            }
            if (phase === 'flat') {
                // ShapeGeometry emits vertices in the XY plane — remap the unchanged flat
                // mode to XZ at its legacy layer height.
                const pos = seedGeometry.getAttribute('position');
                for (let i = 0; i < pos.count; i++) {
                    const sceneZ = pos.getY(i);
                    pos.setY(i, y);
                    pos.setZ(i, sceneZ);
                }
                pos.needsUpdate = true;
                // Override UVs so the asphalt texture tiles uniformly in WORLD XZ
                // metres (1 repeat per ASPHALT_TILE_M). This makes adjacent road
                // polygons line up seamlessly at junctions instead of each polygon
                // re-fitting the texture into its own 0..1 bounding-box UVs (which
                // is what ShapeGeometry produces by default — looked patchwork).
                orientRoadTopGeometry(seedGeometry);
                applyWorldRoadUvs(seedGeometry);
                seedGeometry.computeVertexNormals();
                geometry = seedGeometry;
                seedGeometry = null;
                phase = 'done';
            }
            return 'done';
        },
        dispose() {
            if (terrainTask) terrainTask.dispose();
            else seedGeometry?.dispose();
            geometry?.dispose();
            terrainTask = seedGeometry = geometry = null;
            footprint = null;
            phase = 'done';
        },
        geometry: () => geometry,
        footprint: () => footprint,
        omission: () => omission,
        phaseLabel: () => phase === 'terrain'
            ? `terrain:${terrainTask?.phaseLabel?.() || 'done'}`
            : phase,
    };
}

function centerlineLocalPoints(geometry) {
    if (!geometry) return [];
    const lines = geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return lines.map((line) => line.map(([lon, lat]) => ({
        x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
        z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M,
    })));
}

const BIKE_LANE_GEOMETRY_QUADS_PER_STEP = 8;

function createBikeLaneGeometryTask(
    quadOrQuads,
    osmIdOrIds,
    surfaceY,
    { terrainDraped = false, ground } = {},
) {
    const { terrain: terrainReference, roadFormation: roadFormationModel,
        verticalAlignments: roadVerticalAlignmentModel } = ground;
    const quads = Array.isArray(quadOrQuads?.[0])
        ? quadOrQuads
        : [quadOrQuads];
    const positions = new Float32Array(quads.length * 4 * 3);
    const indices = new Array(quads.length * 6);
    const osmIds = Array.from(new Set(
        (Array.isArray(osmIdOrIds) ? osmIdOrIds : [osmIdOrIds])
            .filter(osmId => osmId != null),
    ));
    const followsVerticalAlignment = osmIds.some(
        osmId => !!roadVerticalAlignmentModel?.getAlignmentForOsmId(osmId),
    );
    const formationModel = !terrainDraped ? roadFormationModel : null;
    let quadIndex = 0;
    let phase = 'sample';
    let geometry = null;
    return {
        step() {
            if (phase === 'sample') {
                const end = Math.min(
                    quads.length,
                    quadIndex + BIKE_LANE_GEOMETRY_QUADS_PER_STEP,
                );
                while (quadIndex < end) {
                    const quad = quads[quadIndex];
                    for (let pointIndex = 0; pointIndex < quad.length; pointIndex++) {
                        const point = quad[pointIndex];
                        const alignmentY = !followsVerticalAlignment
                            ? null
                            : finiteOrNull(roadVerticalAlignmentModel?.roadYForOsmIdsAtLocal(
                                point.x,
                                point.z,
                                osmIds,
                            ));
                        const groundY = alignmentY != null
                            ? alignmentY
                            : terrainDraped && terrainReference
                                ? terrainReference.evidenceSceneYAtLocal(point.x, point.z)
                                : formationModel
                                    ? formationModel.sceneYAtLocal(point.x, point.z, {
                                        osmId: osmIds[0] ?? null,
                                    })
                                    : terrainReference
                                        ? terrainReference.evidenceSceneYAtLocal(point.x, point.z)
                                        : 0;
                        if (finiteOrNull(groundY) === null) return 'defer';
                        const vertex = quadIndex * 4 + pointIndex;
                        positions[vertex * 3] = point.x;
                        // Exact owning-surface height. Visibility comes from the paint pass,
                        // not from lifting a separate red slab above the street.
                        positions[vertex * 3 + 1] = bikePaintSceneY(
                            groundY,
                            surfaceY,
                            { pathOwned: terrainDraped },
                        );
                        positions[vertex * 3 + 2] = point.z;
                    }
                    const vertex = quadIndex * 4;
                    const index = quadIndex * 6;
                    indices[index] = vertex;
                    indices[index + 1] = vertex + 1;
                    indices[index + 2] = vertex + 2;
                    indices[index + 3] = vertex;
                    indices[index + 4] = vertex + 2;
                    indices[index + 5] = vertex + 3;
                    quadIndex += 1;
                }
                if (quadIndex < quads.length) return 'more';
                phase = 'finalize';
                return 'more';
            }
            if (phase === 'finalize') {
                geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                geometry.setIndex(indices);
                applyWorldRoadUvs(geometry);
                geometry.computeVertexNormals();
                geometry.computeBoundingSphere();
                phase = 'done';
            }
            return 'done';
        },
        dispose() { geometry?.dispose(); geometry = null; phase = 'done'; },
        geometry: () => geometry,
        phaseLabel: () => {
            if (phase === 'sample') return `sample ${quadIndex}/${quads.length}`;
            return phase;
        },
    };
}

function createBikeLaneGeometry(
    quadOrQuads,
    osmIdOrIds,
    surfaceY,
    options = {},
) {
    const task = createBikeLaneGeometryTask(
        quadOrQuads,
        osmIdOrIds,
        surfaceY,
        options,
    );
    let status = task.step();
    while (status === 'more') {
        // Small per-road ribbons preserve the synchronous feature-build contract.
        status = task.step();
    }
    return status === 'done' ? task.geometry() : null;
}

function createRetainingWallGeometry(profile, surfaceY, faceKind = 'all') {
    const positions = buildRetainingWallPositions(profile, surfaceY, { faceKind });
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
    );
    if (faceKind === 'earth') {
        geometry.setAttribute(
            'uv',
            new THREE.BufferAttribute(
                buildWorldXZUvsForPositions(
                    positions,
                    getActiveTerrainSurface().uvPerM,
                ),
                2,
            ),
        );
    } else if (faceKind === 'retaining') {
        geometry.setAttribute(
            'uv',
            new THREE.BufferAttribute(
                buildWallFaceUvsForPositions(positions),
                2,
            ),
        );
    }
    geometry.computeVertexNormals();
    return geometry;
}

function createFormationTerrainCollarGeometry(profile) {
    const { positions, uvs: uvMeters } = buildFormationTerrainCollarGeometryData(profile);
    if (positions.length === 0) return null;
    const surface = getActiveTerrainSurface();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
    );
    // Builder UVs are metres (flat spans = world XZ so the collar continues
    // the terrain texture; steep spans = true arc/section metres, no smear).
    const uvs = new Float32Array(uvMeters.length);
    for (let index = 0; index < uvMeters.length; index++) {
        uvs[index] = uvMeters[index] * surface.uvPerM;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    return geometry;
}

function roadFeatureKey(feature, tileKey, featureIndex) {
    return roadFeatureIdentities.identityFor(feature, { tileKey, featureIndex }).key;
}

function disposeRoadFeatureGroup(group) {
    if (!group) return;
    if (group.parent) group.parent.remove(group);
    group.traverse((child) => {
        if (child && child.geometry) child.geometry.dispose();
    });
}

function markRoadCollisionOwnerDirty(bucketKey, featureKey) {
    let owners = roadCollisionDirtyOwnersByBucket.get(bucketKey);
    if (!owners) {
        owners = new Set();
        roadCollisionDirtyOwnersByBucket.set(bucketKey, owners);
    }
    owners.add(featureKey);
    roadCollisionBucketRevisions.set(bucketKey, (roadCollisionBucketRevisions.get(bucketKey) || 0) + 1);
}

function stageRoadCollisionSupport(bucketKey, featureKey, parts) {
    let candidates = roadCollisionCandidatesByBucket.get(bucketKey);
    if (!candidates) {
        candidates = new Map();
        roadCollisionCandidatesByBucket.set(bucketKey, candidates);
    }
    const ownerId = roadSurfaceSupportOwnerId(bucketKey, featureKey);
    candidates.set(featureKey, {
        ownerId,
        prepared: renderedRoadSurfaces.prepare(ownerId, parts),
        groundCoverRings: parts.filter(part => part.groundCoverRing).map(part => part.groundCoverRing),
    });
    markRoadCollisionOwnerDirty(bucketKey, featureKey);
}

function removeRoadCollisionSupportCandidate(bucketKey, featureKey) {
    const candidates = roadCollisionCandidatesByBucket.get(bucketKey);
    if (candidates?.delete(featureKey) && candidates.size === 0) {
        roadCollisionCandidatesByBucket.delete(bucketKey);
    }
    markRoadCollisionOwnerDirty(bucketKey, featureKey);
}

// Sparse support staging uses the same time slice as aggregate assembly. The
// limits bound private index tables; they are not a measured mobile quality
// tier or a licence for an equally large synchronous commit.
const ROAD_SUPPORT_PUBLICATION_LIMITS = Object.freeze({
    maxOwners: 2048,
    maxCells: 4096,
    maxCellParts: 131072,
});

function* prepareRoadCollisionSupportBucketSteps(bucketKey, queryBounds = null, bucketKeys = [bucketKey], candidateSources = null, maxOwners = ROAD_SUPPORT_PUBLICATION_LIMITS.maxOwners) {
    if (!Number.isSafeInteger(maxOwners) || maxOwners <= 0) throw new TypeError('Road support owner limit must be a positive integer');
    if (!bucketKeys.length) return null;
    const rows = new Map(), prepared = [];
    for (const key of bucketKeys) {
        const previousDirtyOwners = roadCollisionDirtyOwnersByBucket.get(key);
        const dirtyOwners = candidateSources?.get(key)?.dirtyOwners || previousDirtyOwners;
        if (!dirtyOwners?.size) continue;
        if (dirtyOwners.size > maxOwners) {
            throw Object.assign(new RangeError(`Road aggregate support owner capacity exceeded: ${dirtyOwners.size} > ${maxOwners}: ${key}`), { code: 'ground-generation-capacity' });
        }
        const previousOwners = publishedRoadSurfaceOwnersByBucket.get(key) || null;
        if (previousOwners?.size > maxOwners) {
            throw Object.assign(new RangeError(`Road aggregate retained support owner capacity exceeded: ${previousOwners.size} > ${maxOwners}: ${key}`), { code: 'ground-generation-capacity' });
        }
        rows.set(key, { dirtyOwners, previousDirtyOwners, previousOwners, nextOwners: new Set(),
            revision: roadCollisionBucketRevisions.get(key),
            previousCandidates: roadCollisionCandidatesByBucket.get(key),
            candidates: candidateSources?.get(key)?.candidates || roadCollisionCandidatesByBucket.get(key), footprints: null });
    }
    if (!rows.size) return null;
    const current = () => [...rows].every(([key, row]) => roadCollisionBucketRevisions.get(key) === row.revision
        && (publishedRoadSurfaceOwnersByBucket.get(key) || null) === row.previousOwners);
    for (const [key, row] of rows) {
        for (const featureKey of row.previousOwners || []) {
            if (!current()) return null;
            row.nextOwners.add(featureKey); yield;
        }
        for (const featureKey of row.dirtyOwners) {
            if (!current()) return null;
            if (prepared.length >= maxOwners) {
                throw Object.assign(new RangeError(`Road group support owner capacity exceeded: ${prepared.length + 1} > ${maxOwners}`), { code: 'ground-generation-capacity' });
            }
            const candidate = row.candidates?.get(featureKey);
            prepared.push(candidate?.prepared || renderedRoadSurfaces.prepare(
                roadSurfaceSupportOwnerId(key, featureKey), [],
            ));
            if (candidate) row.nextOwners.add(featureKey); else row.nextOwners.delete(featureKey);
            if (row.nextOwners.size > maxOwners) {
                throw Object.assign(new RangeError(`Road aggregate support owner capacity exceeded: ${row.nextOwners.size} > ${maxOwners}: ${key}`), { code: 'ground-generation-capacity' });
            }
            yield;
        }
    }
    let support = null, handedOff = false, committed = false;
    const rollbackFootprints = () => {
        for (const row of [...rows.values()].reverse()) row.footprints?.rollback();
    };
    try {
        support = yield* renderedRoadSurfaces.preparePublicationSteps(prepared,
            { ...ROAD_SUPPORT_PUBLICATION_LIMITS, maxOwners, queryBounds });
        if (!current()) return null;
        for (const [key, row] of rows) {
            function* footprintOwners() {
                for (const owner of row.nextOwners) yield [owner, row.candidates?.get(owner)?.groundCoverRings || []];
            }
            row.footprints = yield* prepareGroundCoverRoadBucketSteps(key, footprintOwners(), { isCurrent: current });
            if (!current()) return null;
        }
        handedOff = true;
        return {
            read: support.read,
            captureReadSnapshotSteps: support.captureReadSnapshotSteps,
            changesQueryWindow: support.changesQueryWindow,
            changesDrivableQueryWindow: support.changesDrivableQueryWindow,
            isCurrent: () => current() && support.isCurrent()
                && [...rows.values()].every(row => !row.footprints || row.footprints.isCurrent()),
            commit() {
                if (!current() || [...rows.values()].some(row => row.footprints && !row.footprints.isCurrent())
                    || !support.commit()) return false;
                try {
                    for (const row of rows.values()) {
                        if (row.footprints && !row.footprints.commit()) {
                            rollbackFootprints(); support.rollback(); return false;
                        }
                    }
                } catch (error) { rollbackFootprints(); support.rollback(); throw error; }
                committed = true;
                for (const [key, row] of rows) {
                    if (row.nextOwners.size) publishedRoadSurfaceOwnersByBucket.set(key, row.nextOwners);
                    else publishedRoadSurfaceOwnersByBucket.delete(key);
                    if (candidateSources?.has(key)) {
                        if (row.candidates?.size) roadCollisionCandidatesByBucket.set(key, row.candidates);
                        else roadCollisionCandidatesByBucket.delete(key);
                        roadCollisionBucketRevisions.set(key, (row.revision || 0) + 1);
                    }
                    roadCollisionDirtyOwnersByBucket.delete(key);
                }
                return true;
            },
            rollback() {
                if (!committed) return;
                for (const [key, row] of rows) {
                    if (row.previousOwners) publishedRoadSurfaceOwnersByBucket.set(key, row.previousOwners);
                    else publishedRoadSurfaceOwnersByBucket.delete(key);
                    if (row.previousDirtyOwners) roadCollisionDirtyOwnersByBucket.set(key, row.previousDirtyOwners);
                    else roadCollisionDirtyOwnersByBucket.delete(key);
                    if (candidateSources?.has(key)) {
                        if (row.previousCandidates) roadCollisionCandidatesByBucket.set(key, row.previousCandidates);
                        else roadCollisionCandidatesByBucket.delete(key);
                        if (row.revision === undefined) roadCollisionBucketRevisions.delete(key);
                        else roadCollisionBucketRevisions.set(key, row.revision);
                    }
                }
                rollbackFootprints(); support.rollback(); committed = false;
            },
            discard() { for (const row of rows.values()) row.footprints?.discard(); support.discard(); },
            finalize() { for (const row of rows.values()) row.footprints?.finalize(); support.finalize(); },
        };
    } finally {
        if (!handedOff) { for (const row of rows.values()) row.footprints?.discard(); support?.discard(); }
    }
}

// "Publish" no longer means "add meshes to the scene": every mesh the feature
// build produced is decomposed into raw geometry parts and handed to the
// batcher under the feature's key. The meshes themselves were never rendered
// (built off-scene) and never uploaded, so there is nothing GPU-side to free —
// the typed arrays live on inside the batcher until the owner is removed.
function* collectRoadFeatureGroupSteps(group, featureKey, tileKey, openingRead = null) {
    const regionTileKey = tileKey ?? group?.userData?.sourceTileKey;
    const region = roadRegionForTile(regionTileKey);
    let parts = 0;
    let surfaceParts = 0;
    const collisionPartsByBucket = new Map();
    const surfaceBucketKeys = new Set();
    const bucketKeys = new Set();
    let paintBucketKey = null;
    const paintRecords = group?.userData?.groundPaintRecords || null;
    if (paintRecords) {
        paintBucketKey = `RoadPaint@${region}`;
        bucketKeys.add(paintBucketKey);
        surfaceBucketKeys.add(paintBucketKey);
    }
    const geometryParts = [];
    const terrainCutoutRegions = [];
    const descriptors = new Map();
    const walk = group ? [{ iterator: [group][Symbol.iterator]() }] : [];
    while (walk.length) {
        const frame = walk[walk.length - 1];
        const next = frame.iterator.next();
        if (next.done) { walk.pop(); continue; }
        const child = next.value;
        if (child?.children?.length) walk.push({ iterator: child.children[Symbol.iterator]() });
        if (!child?.isMesh || !child.geometry) { yield; continue; }
        const geometry = child.geometry;
        const position = geometry.getAttribute('position');
        if (!position || position.count === 0) { yield; continue; }
        const uv = geometry.getAttribute('uv');
        const normal = geometry.getAttribute('normal');
        const color = geometry.getAttribute('color');
        const surfaceClaim = child.userData?.surfaceClaim || child.material?.userData?.surfaceClaim || null;
        let data = {positions:position.array,indices:geometry.index?.array||null,
            ...(uv?{uvs:uv.array}:{}),...(normal?{normals:normal.array}:{}),...(color?{colors:color.array}:{})};
        let cutRegions = child.userData?.terrainCutoutRegions || [];
        if (openingRead) {
            const sphere=geometry.boundingSphere;
            const bounds=sphere&&Number.isFinite(sphere.radius)?{
                minX:sphere.center.x-sphere.radius,minY:sphere.center.y-sphere.radius,minZ:sphere.center.z-sphere.radius,
                maxX:sphere.center.x+sphere.radius,maxY:sphere.center.y+sphere.radius,maxZ:sphere.center.z+sphere.radius,
            }:null;
            data=yield* clipReceiverOpeningsSteps({geometry:data,openingRead,claim:surfaceClaim,bounds,
                maxVertices:GROUND_GENERATION_LIMITS.cutout.maxVertices,maxTriangles:GROUND_GENERATION_LIMITS.cutout.maxTriangles});
            // The retained terrain footprint must follow the clipped top,
            // including its holes. Keeping the old polygon here would grant
            // terrain removal to a part of the road that no longer exists.
            if(data.topology?.changedTriangles && Object.hasOwn(child.userData,'terrainCutoutRegions')) {
                cutRegions=(yield* createReceiverFootprintSteps({positions:data.positions,indices:data.indices,topologyVertexIds:data.topologyVertexIds,
                    ...GROUND_GENERATION_LIMITS.roadFootprint,isCurrent:openingRead.isCurrent})).regions;
            }
            if(data.indices?.length===0){yield;continue;}
        }
        const attributes = { position:data.positions };
        if(data.uvs)attributes.uv=data.uvs;
        if(data.normals)attributes.normal=data.normals;
        if(data.colors)attributes.color=data.colors;
        const indices=data.indices;
        const entity = child.userData?.selectableRoadSurface && child.userData.entityKey
            ? { key: child.userData.entityKey, metadata: child.userData.entityMetadata }
            : null;
        const bucketKey = roadBucketKeyForMesh(child, region);
        bucketKeys.add(bucketKey);
        const part = {
            attributes,
            ...(indices ? { index: indices } : {}),
            ...(entity ? { entity } : {}),
            surfaceClaim,
        };
        geometryParts.push({ bucketKey, part });
        if (!descriptors.has(bucketKey)) {
            descriptors.set(bucketKey, {
                material: openingRead ? plannerGeometryMaterials.get(child.material) : child.material,
                renderOrder: Number(child.renderOrder) || 0,
                name: `RoadAggregate:${String(child.name || 'Road').split(':')[0]}`,
                surface: String(child.name || '').startsWith('RoadSurface:'),
                inspection: roadInspectionSpec(child),
                surfaceClaim: child.userData?.surfaceClaim
                    || child.material?.userData?.surfaceClaim
                    || null,
            });
        }
        parts += 1;
        const roadTop = String(child.name || '').startsWith('RoadSurface:');
        const terrainContinuation = surfaceClaim?.surfaceClass === SURFACE_CLASS.ROAD_EARTHWORK
            && surfaceClaim.verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL;
        if (roadTop || terrainContinuation) {
            // Collars/seams are real visible receivers too. Retain their exact
            // triangles in the same atomic publication for detail and walking.
            // They neither remove terrain nor acquire drivable-road semantics.
            for (const region of roadTop ? cutRegions : []) {
                terrainCutoutRegions.push(region); yield;
            }
            surfaceParts += 1;
            surfaceBucketKeys.add(bucketKey);
            const surfaceType = String(child.userData?.surfaceType || 'default');
            let collisionParts = collisionPartsByBucket.get(bucketKey);
            if (!collisionParts) {
                collisionParts = [];
                collisionPartsByBucket.set(bucketKey, collisionParts);
            }
            collisionParts.push({
                id: `${featureKey}:${surfaceParts - 1}`,
                surfaceClaim,
                osmId: child.userData?.osmId
                    ?? (String(featureKey).startsWith('osm:')
                        ? String(featureKey).slice(4) : null),
                surfaceType,
                // Pedestrian/shared streets are still continuous paved tops
                // and can carry an authorised/campaign vehicle. Sidewalk and
                // paint polygons remain firm for feet but do not steer tyres.
                drivable: roadTop && !SIDEWALK_LEVEL_TYPES.has(surfaceType)
                    && surfaceType !== 'cycleway'
                    && !String(child.name || '').includes('bike-lane'),
                positions: data.positions,
                indices,
                groundCoverRing: child.userData?.groundCoverRing || null,
            });
        }
        yield;
    }
    return {
        featureKey, regionTileKey, bucketKeys, parts, surfaceParts,
        surfaceBucketKeys, paintBucketKey, geometryParts, descriptors,
        collisionPartsByBucket, paintRecords, terrainCutoutRegions: Object.freeze(terrainCutoutRegions),
    };
}

function publishRoadFeatureGroup(group, featureKey, tileKey) {
    const steps = collectRoadFeatureGroupSteps(group, featureKey, tileKey);
    let collected;
    while (true) {
        const step = steps.next();
        if (step.done) { collected = step.value; break; }
    }
    const {
        regionTileKey, bucketKeys, parts, surfaceParts, surfaceBucketKeys,
        paintBucketKey, geometryParts, descriptors, collisionPartsByBucket,
        paintRecords, terrainCutoutRegions,
    } = collected;
    if (paintRecords) {
        groundPaint.stage(paintBucketKey, featureKey, paintRecords);
        roadSurfaceBucketsPendingPublication.add(paintBucketKey);
        pendingAssembleBuckets.push(paintBucketKey);
        roadBucketDescriptors.set(paintBucketKey, { renderOrder: SURFACE_RENDER_ORDER.SIDEWALK });
    }
    for (const bucketKey of surfaceBucketKeys) roadSurfaceBucketsPendingPublication.add(bucketKey);
    for (const { bucketKey, part } of geometryParts) roadBatcher.addPart(bucketKey, featureKey, part);
    for (const [bucketKey, descriptor] of descriptors) {
        if (!roadBucketDescriptors.has(bucketKey)) roadBucketDescriptors.set(bucketKey, descriptor);
    }
    for (const [bucketKey, collisionParts] of collisionPartsByBucket) {
        stageRoadCollisionSupport(bucketKey, featureKey, collisionParts);
    }
    markRoadAggregateOwnerBuckets(featureKey, bucketKeys);
    markRoadAggregatesDirty();
    return {
        featureKey,
        regionTileKey,
        bucketKeys,
        parts,
        surfaceParts,
        surfaceBucketKeys,
        paintBucketKey,
        terrainCutoutRegions,
    };
}

function disposePublishedRoadEntry(entry) {
    if (!entry?.featureKey) return;
    for (const bucketKey of entry.surfaceBucketKeys || []) {
        removeRoadCollisionSupportCandidate(bucketKey, entry.featureKey);
    }
    const removedBuckets = roadBatcher.removeOwnerEverywhere(entry.featureKey);
    if (entry.paintBucketKey) {
        groundPaint.stage(entry.paintBucketKey, entry.featureKey, null);
        removedBuckets.push(entry.paintBucketKey);
        pendingAssembleBuckets.push(entry.paintBucketKey);
    }
    if (removedBuckets.length > 0) {
        markRoadAggregateOwnerBuckets(entry.featureKey, removedBuckets);
        markRoadAggregatesDirty();
    }
}

// Rebuild every dirty bucket's merged mesh from the batcher's cached parts.
// Ranges from the assembly re-register picking for the bucket; the entity
// registry re-applies hover/select state on registration, so a selected road
// stays highlighted across a rebuild that moved its range.
// Buckets approved for assembly but not yet rebuilt. Most regional buckets are
// small, but density and owner churn can make one bucket large enough to exceed
// a frame by itself; a spawn burst can also cover dozens. The cooperative task
// bounds both cases without changing bucket membership or geometry.
let pendingAssembleBuckets = [];
let activeRoadAssemblyTask = null;
const roadAggregateFailures = new Map();
const ROAD_ASSEMBLE_FRAME_BUDGET_MS = 6;
// The historical three-swap limit avoided 130–360 ms upload bursts in dense
// scenes. Dependent buckets now upload privately, one preparer step per frame,
// before their group can swap. This also limits completed-bucket bookkeeping;
// it must never split a dependency group across controller frames.
const ROAD_ASSEMBLE_MAX_UPLOADS_PER_FRAME = 3;

function disposeRoadAggregateMesh(mesh) {
    if (!mesh) return;
    const unregisterEntities = roadAggregateEntityUnregister.get(mesh);
    if (unregisterEntities) unregisterEntities();
    roadAggregateEntityUnregister.delete(mesh);
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry?.dispose?.();
}

function createRoadAggregateMesh(bucketKey, assembled, descriptor, generation) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(assembled.attributes.position, 3));
    if (assembled.attributes.uv) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(assembled.attributes.uv, 2));
    }
    if (assembled.attributes.normal) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(assembled.attributes.normal, 3));
    }
    if (assembled.index) geometry.setIndex(new THREE.BufferAttribute(assembled.index, 1));
    if (assembled.bounds) {
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
    mesh.name = descriptor.name;
    mesh.renderOrder = descriptor.renderOrder;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    markInspectionLayer(mesh, descriptor.inspection);
    const publicationKey = roadAggregatePublicationKey(bucketKey);
    if (descriptor.surfaceClaim) {
        markSurfaceClaim(mesh, reviseSurfaceClaim(descriptor.surfaceClaim, {
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            ownerId: bucketKey,
            replacementKey: publicationKey,
            generation,
        }));
    }
    return mesh;
}

// Returns an ordinary registry entry, so a ground region can include the same
// live road adapter in its larger batch. No observer/readiness callback runs
// until the complete batch succeeds. The streaming group gives its first entry
// all related support buckets, so one query/collider snapshot covers the group.
function* prepareRoadAggregatePublicationSteps(bucketKey, assembled, descriptor, {
    generation = roadAggregateRevision,
    isCurrent = () => true,
    supportBucketKeys = [bucketKey],
    preparePhysics = true,
} = {}) {
    // Source revisions and coordinator group ids are separate clocks. Tickets
    // for this family share one admission sequence, including cancelled work.
    const publicationGeneration = ++roadAggregatePublicationSequence;
    const parent = roadsGroup;
    const physicsSession = preparePhysics ? groundPhysicsProvider?.() || null : null;
    const physicsRegion = physicsSession?.captureGroundPublicationRegion(['road-surfaces']) || null;
    const physicsCurrent = () => !preparePhysics || (groundPhysicsProvider?.() || null) === physicsSession
        && (physicsRegion ? physicsRegion.isCurrent()
            : !physicsSession?.captureGroundPublicationRegion(['road-surfaces']));
    const previous = roadAggregates.get(bucketKey) || null;
    const collisionRevision = roadCollisionBucketRevisions.get(bucketKey);
    let mesh = null, support = null, physics = null, handedOff = false, committed = false;
    let batch = null, boundaryTicket = null, boundaryResult = null, boundaryError = null;
    let unregisterEntities = null, settled = false, finalized = false;
    const inputsCurrent = () => isCurrent() && roadsGroup === parent
        && roadCollisionBucketRevisions.get(bucketKey) === collisionRevision && physicsCurrent();
    const current = () => inputsCurrent()
        && (roadAggregates.get(bucketKey) || null) === previous
        && (!support || support.isCurrent()) && (!physics || physics.entry.isCurrent());
    const discard = () => {
        if (settled) return;
        if (committed) throw new Error('Rollback road aggregate before discarding');
        settled = true;
        disposeRoadAggregateMesh(mesh);
        physics?.entry.discard();
        support?.discard();
    };
    try {
        support = yield* prepareRoadCollisionSupportBucketSteps(bucketKey, physicsRegion?.bounds, supportBucketKeys);
        if (!current()) return null;
        if (support?.changesDrivableQueryWindow) {
            physics = yield* physicsRegion.prepareSteps({ 'road-surfaces': support.read },
                () => inputsCurrent() && support.isCurrent(), (label, callback) => {
                    const started = performance.now();
                    try { return callback(); }
                    finally { recordLayerFrameMs(`ground:${label}`, performance.now()-started); }
                });
            if (!physics || !current()) return null;
        }
        if (assembled) {
            if (!descriptor) throw new Error(`Missing road aggregate descriptor: ${bucketKey}`);
            mesh = createRoadAggregateMesh(bucketKey, assembled, descriptor, publicationGeneration);
            mesh.userData.groundGeneration = generation;
            groundPaint?.bindRoot(mesh);
            mesh.userData.surfaceAuditRanges = [];
            for (const range of assembled.surfaceAuditRanges || []) {
                mesh.userData.surfaceAuditRanges.push({ ...range,
                    claim: range.claim ? reviseSurfaceClaim(range.claim, {
                        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                        ownerId: bucketKey,
                        replacementKey: roadAggregatePublicationKey(bucketKey),
                        generation: publicationGeneration,
                    }) : null,
                });
                yield;
                if (!current()) return null;
            }
        }
        if (!current()) return null;
        const ticket = surfacePublications?.begin({
            key: roadAggregatePublicationKey(bucketKey), generation: publicationGeneration, parent,
            retire: (_context, root) => disposeRoadAggregateMesh(root),
        }) || null;
        const entry = {
            ticket, ...(mesh ? { root: mesh } : { clear: true }), isCurrent: current,
            commit() {
                if (support && !support.commit()) return false;
                committed = true;
                if (physics && !physics.entry.commit()) return false;
                if (mesh) {
                    if (assembled.ranges.some(range => range.entity)) {
                        unregisterEntities = registerAggregateEntityRanges(mesh, assembled.ranges);
                        roadAggregateEntityUnregister.set(mesh, unregisterEntities);
                    }
                    roadAggregates.set(bucketKey, { mesh, unregisterEntities });
                } else roadAggregates.delete(bucketKey);
                return true;
            },
            rollback() {
                if (!committed) return;
                if (previous) roadAggregates.set(bucketKey, previous);
                else roadAggregates.delete(bucketKey);
                unregisterEntities?.(); unregisterEntities = null;
                roadAggregateEntityUnregister.delete(mesh);
                physics?.entry.rollback();
                support?.rollback(); committed = false;
            },
            discard,
        };
        const finalize = () => {
            if (finalized || !committed || (ticket && !['published', 'cleared'].includes(ticket.state))) return false;
            finalized = true; settled = true;
            physics?.finalize();
            support?.finalize();
            // A registry observer may have requested a newer owner while the
            // batch settled. Do not acknowledge that newer obligation.
            if (isCurrent() && roadsGroup === parent
                && roadCollisionBucketRevisions.get(bucketKey) === collisionRevision) {
                roadSurfaceBucketsPendingPublication.delete(bucketKey);
                roadSurfaceTiles?.markBucketReady(bucketKey);
            }
            return true;
        };
        handedOff = true;
        return {
            entry, finalize,
            get boundaryResult() { return boundaryResult; },
            get boundaryError() { return boundaryError; },
            enqueue() {
                if (boundaryTicket) return true;
                if (!groundPublications || !surfacePublications) {
                    throw new Error('Road streaming requires the shared ground publication boundary');
                }
                batch ||= surfacePublications.prepareBatch([entry]);
                if (batch.state !== 'staged') {
                    boundaryResult = batch;
                    return true;
                }
                boundaryTicket = groundPublications.enqueue(batch, { onPublished(result) {
                    boundaryResult = result;
                    finalize();
                } });
                if (!boundaryTicket) return false;
                boundaryTicket.promise.then(result => { boundaryResult = result; },
                    error => { boundaryError = error; });
                return true;
            },
            discard() {
                boundaryTicket?.cancel('road-aggregate-superseded');
                if (batch?.state === 'staged') batch.discard('road-aggregate-superseded');
                if (ticket?.state === 'pending') ticket.discard();
                discard();
            },
            publish() {
                if (surfacePublications) {
                    const batch = surfacePublications.prepareBatch([entry]);
                    const result = batch.publish?.() || batch;
                    finalize();
                    return result.status.startsWith('published');
                }
                if (!current()) { discard(); return false; }
                try {
                    if (mesh) parent.add(mesh);
                    if (!entry.commit()) throw new Error('Road aggregate support publication rejected');
                } catch (error) { entry.rollback(); discard(); throw error; }
                if (previous) disposeRoadAggregateMesh(previous.mesh);
                finalize(); return true;
            },
        };
    } finally {
        if (!handedOff) discard();
    }
}

// A source owner can move between material buckets or contribute a top plus
// its physical edges. Keep its pending old/new buckets connected until their
// complete dependency group publishes; unrelated owners/regions stay separate.
const roadPendingOwnerBuckets = new Map();
const roadPendingBucketOwners = new Map();
const roadDependencyRevisions = new Map();
const ROAD_PUBLICATION_MAX_BUCKETS = 32;
const ROAD_PUBLICATION_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
let lastRoadAggregateGpuFrame = -1;
let roadAggregatePublicationSequence = 0;

function* prewarmRoadAggregateSteps(root, isCurrent) {
    if (!root) return true;
    const gpu = prewarmDetachedObject(root, { renderer, camera, targetScene: scene,
        asyncShaders: true, label: 'roads:aggregate-upload', uploadBatch: 8, maxUploadBytes: 256 * 1024, sliceMs: 2 });
    try {
        for (;;) {
            if (!isCurrent()) return false;
            while (lastRoadAggregateGpuFrame === getFrameChunkSequence()) {
                yield { phase: 'road-aggregate-upload-slot', deferFrame: true };
                if (!isCurrent()) return false;
            }
            const next = gpu.next();
            if (next.done) return true;
            if (next.value?.deferFrame) lastRoadAggregateGpuFrame = getFrameChunkSequence();
            yield next.value;
        }
    } finally { gpu.return?.(); }
}

// The coordinator supplies completed feature geometry from its retained read.
// Existing batching, support, footprint and paint compilers prepare their own
// reversible members here. No feature/source map is changed during assembly.
function* prepareRoadReceiverReplacementSteps(replacements, {
    generation, isCurrent, queryBounds = null, maxBuckets, maxSourceTiles, maxOwners = ROAD_SUPPORT_PUBLICATION_LIMITS.maxOwners,
    maxGeometryBytes = ROAD_PUBLICATION_MAX_OUTPUT_BYTES, checkRead = check => check(),
} = {}) {
    if (!Array.isArray(replacements) || (!replacements.length && !queryBounds)
        || !Number.isSafeInteger(maxOwners) || maxOwners <= 0 || typeof isCurrent !== 'function'
        || typeof checkRead !== 'function'
        || ![maxBuckets, maxSourceTiles, maxGeometryBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Road receivers require a bounded captured replacement set');
    }
    if (replacements.length > maxOwners) throw Object.assign(
        new RangeError(`Road receiver owner capacity exceeded (${replacements.length} > ${maxOwners})`),
        { code: 'ground-generation-capacity' });
    const parent = roadsGroup;
    const changes = new Map(), geometryRows = [], paintRows = [], descriptors = new Map(), supportSources = new Map();
    const previousDescriptors = new Map(), dependencyRevisions = new Map(), members = [], tileChanges = new Map();
    let geometryDependencyBuckets = 0, paintDependencyBuckets = 0;
    let geometry = null, support = null, paint = null, ticket = null;
    let handedOff = false, committed = false, settled = false;
    const dependenciesCurrent = () => {
        for (const key of dependencyRevisions.keys()) {
            if (roadDependencyRevisions.get(key) !== dependencyRevisions.get(key)) return false;
        }
        return true;
    };
    const ownCurrent = () => {
        if (roadsGroup !== parent || !dependenciesCurrent()) return false;
        for (const key of changes.keys()) {
            if ((roadEntries.get(key) || null) !== changes.get(key).previousEntry) return false;
        }
        for (const key of tileChanges.keys()) {
            if (tileRoads.get(key) !== tileChanges.get(key).previous) return false;
        }
        return true;
    };
    // Every bucket reads the same completed receiver dependency closure.
    // The coordinator may share that read during one synchronous preparation
    // visit or final preflight; it renews the check after every yield and ends
    // the scope before mutations. Ordinary publishers keep fresh checks.
    const inputsCurrent = () => ownCurrent() && isCurrent()
        && (!geometry || geometry.isCurrent()) && (!support || support.isCurrent());
    const current = () => checkRead(inputsCurrent);
    const completeCurrent = () => current() && members.every(member => member.entry.isCurrent())
        && (!paint || paint.entry.isCurrent());
    const discard = () => {
        if (settled || committed) return false;
        settled = true;
        for (const member of members) member.discard();
        paint?.discard(); support?.discard(); geometry?.discard();
        if (ticket?.state === 'pending') ticket.discard();
        return true;
    };
    try {
        const supportChanges = new Map();
        for (const row of replacements) {
            if (!row || typeof row.featureKey !== 'string' || changes.has(row.featureKey)
                || row.previousEntry !== (roadEntries.get(row.featureKey) || null)
                || (row.nextEntry && row.nextEntry.featureKey !== row.featureKey)
                || (row.collected && row.collected.featureKey !== row.featureKey)) {
                throw new TypeError('Invalid or duplicate road receiver owner');
            }
            changes.set(row.featureKey, row);
            const old = row.previousEntry, next = row.collected;
            if (row.replaceTileMembership === true) {
                for (const tileKey of new Set([...(old?.tileRefs || []), ...(row.nextEntry?.tileRefs || [])])) {
                    let tile = tileChanges.get(tileKey);
                    if (!tile) {
                        if (tileChanges.size >= maxSourceTiles) throw Object.assign(new RangeError(
                            `Road receiver tile capacity exceeded (${tileChanges.size + 1} > ${maxSourceTiles})`), { code: 'ground-generation-capacity' });
                        tile = { previous: tileRoads.get(tileKey), next: new Set() };
                        tileChanges.set(tileKey, tile);
                        for (const key of tile.previous || []) {
                            if (tile.next.size >= maxOwners) throw Object.assign(new RangeError(
                                `Road receiver tile owner capacity exceeded (${tile.next.size + 1} > ${maxOwners})`),
                            { code: 'ground-generation-capacity' });
                            tile.next.add(key);
                            yield { phase: 'road-receiver-tile-membership' }; if (!current()) return null;
                        }
                    }
                    if (row.nextEntry?.tileRefs.has(tileKey)) tile.next.add(row.featureKey);
                    else tile.next.delete(row.featureKey);
                    if (tile.next.size > maxOwners) throw Object.assign(new RangeError(
                        `Road receiver tile owner capacity exceeded (${tile.next.size} > ${maxOwners})`),
                    { code: 'ground-generation-capacity' });
                }
            }
            if (row.reuseGeometry === true) {
                if (!old || row.nextEntry?.parts !== old.parts || row.nextEntry?.identity !== old.identity) {
                    throw new TypeError('Membership-only replacement must retain exact published road parts');
                }
                continue;
            }
            const buckets = new Set([...(old?.bucketKeys || []), ...(next?.bucketKeys || [])]);
            for (const key of buckets) {
                // The source ledger admits a region before holding its model
                // graph. An older ordinary bucket group must finish first; its
                // still-staged parts cannot be retained as published inputs.
                if (roadPendingBucketOwners.has(key) || roadCollisionDirtyOwnersByBucket.has(key)
                    || pendingAssembleBuckets.includes(key) || activeRoadAssemblyTask?.bucketKeys.includes(key)) {
                    throw Object.assign(new Error('Road receiver dependency is still publishing'), { code: 'ground-dependency-busy' });
                }
                if (!dependencyRevisions.has(key)) {
                    // Paint regions have their own admission limit. Charging
                    // them to the geometry limit rejected otherwise bounded
                    // updates before either compiler saw its actual inputs.
                    const paintBucket = key === old?.paintBucketKey || key === next?.paintBucketKey;
                    const count = paintBucket ? ++paintDependencyBuckets : ++geometryDependencyBuckets;
                    const limit = paintBucket ? GROUND_GENERATION_LIMITS.paintSources.maxChangedRegions : maxBuckets;
                    if (count > limit) throw Object.assign(new RangeError(
                        `Road receiver ${paintBucket ? 'paint' : 'geometry'} bucket capacity exceeded (${count} > ${limit})`),
                    { code: 'ground-generation-capacity' });
                }
                dependencyRevisions.set(key, roadDependencyRevisions.get(key));
            }
            const byBucket = new Map();
            for (const { bucketKey, part } of next?.geometryParts || []) {
                if (!byBucket.has(bucketKey)) byBucket.set(bucketKey, []);
                byBucket.get(bucketKey).push(part);
                yield { phase: 'road-receiver-parts' }; if (!current()) return null;
            }
            for (const key of buckets) {
                if (key === old?.paintBucketKey || key === next?.paintBucketKey) {
                    paintRows.push(Object.freeze({ bucketKey: key, owner: row.featureKey,
                        records: key === next?.paintBucketKey ? next.paintRecords : null }));
                } else {
                    geometryRows.push({ bucketKey: key, ownerKey: row.featureKey, parts: byBucket.get(key) || [] });
                }
                if ((old?.surfaceBucketKeys?.has(key) || next?.surfaceBucketKeys?.has(key))
                    && key !== old?.paintBucketKey && key !== next?.paintBucketKey) {
                    if (!supportChanges.has(key)) supportChanges.set(key, new Map());
                    supportChanges.get(key).set(row.featureKey, next?.collisionPartsByBucket.get(key) || []);
                }
            }
            for (const [key, descriptor] of next?.descriptors || []) {
                if (!descriptors.has(key)) {
                    descriptors.set(key, roadBucketDescriptors.get(key) || descriptor);
                    previousDescriptors.set(key, roadBucketDescriptors.get(key));
                }
            }
            yield { phase: 'road-receiver-owners' }; if (!current()) return null;
        }
        if (geometryRows.length) geometry = yield* roadBatcher.prepareReplacementSteps(geometryRows, {
            maxBuckets, maxOwners,
            maxParts: ROAD_SUPPORT_PUBLICATION_LIMITS.maxCellParts, maxOutputBytes: maxGeometryBytes,
        });
        if (!current()) return null;
        for (const [key, owners] of supportChanges) {
            const candidates = new Map(), dirtyOwners = new Set();
            for (const [owner, value] of roadCollisionCandidatesByBucket.get(key) || []) {
                candidates.set(owner, value); yield { phase: 'road-receiver-retained-support' }; if (!current()) return null;
            }
            for (const owner of roadCollisionDirtyOwnersByBucket.get(key) || []) dirtyOwners.add(owner);
            for (const [owner, parts] of owners) {
                dirtyOwners.add(owner);
                if (parts.length) candidates.set(owner, {
                    ownerId: roadSurfaceSupportOwnerId(key, owner),
                    prepared: renderedRoadSurfaces.prepare(roadSurfaceSupportOwnerId(key, owner), parts),
                    groundCoverRings: parts.filter(part => part.groundCoverRing).map(part => part.groundCoverRing),
                });
                else candidates.delete(owner);
                yield { phase: 'road-receiver-support-owners' }; if (!current()) return null;
            }
            supportSources.set(key, { candidates, dirtyOwners });
        }
        if (supportSources.size) support = yield* prepareRoadCollisionSupportBucketSteps(null, queryBounds,
            [...supportSources.keys()], supportSources, maxOwners);
        else if (queryBounds) support = yield* renderedRoadSurfaces.preparePublicationSteps([],
            { ...ROAD_SUPPORT_PUBLICATION_LIMITS, maxOwners, queryBounds });
        if (!current() || (supportSources.size && !support)) return null;
        if (paintRows.length) {
            if (!groundPaint) throw new Error('Road receiver paint has no session compositor');
            paint = yield* groundPaint.prepareReplacementsSteps(Object.freeze(paintRows), current);
            if (!paint || !current()) return null;
        }
        for (const key of geometry?.bucketKeys || []) {
            const assembly = geometry.beginAssembly(key, { includeBounds: true });
            while (!assembly.step(.5)) {
                yield { phase: 'road-receiver-aggregate' }; if (!current()) return null;
            }
            const member = yield* prepareRoadAggregatePublicationSteps(key, assembly.result(),
                descriptors.get(key) || roadBucketDescriptors.get(key), {
                    generation, isCurrent: current, supportBucketKeys: [], preparePhysics: false,
                });
            if (!member || !current()) { member?.discard(); return null; }
            members.push(member);
            if (!(yield* prewarmRoadAggregateSteps(member.entry.root, current))) return null;
        }
        if (!current()) return null;
        ticket = surfacePublications.begin({ key: 'roads:receiver-inputs', generation });
        const entry = { ticket, clear: true, isCurrent: current,
            commit() {
                if (settled || committed || !ownCurrent()) return false;
                if (geometry && !geometry.commit()) return false;
                try {
                    if (support && !support.commit()) { geometry?.rollback(); return false; }
                } catch (error) { geometry?.rollback(); throw error; }
                roadReceiverMutationEpoch++;
                for (const [key, descriptor] of descriptors) roadBucketDescriptors.set(key, descriptor);
                for (const [key, row] of changes) {
                    if (row.nextEntry) roadEntries.set(key, row.nextEntry); else roadEntries.delete(key);
                }
                for (const [key, row] of tileChanges) {
                    if (row.next.size) tileRoads.set(key, row.next); else tileRoads.delete(key);
                }
                committed = true; return true;
            },
            rollback() {
                if (!committed || settled) return false;
                roadReceiverMutationEpoch++;
                for (const [key, row] of changes) {
                    if (row.previousEntry) roadEntries.set(key, row.previousEntry); else roadEntries.delete(key);
                }
                for (const [key, row] of tileChanges) {
                    if (row.previous) tileRoads.set(key, row.previous); else tileRoads.delete(key);
                }
                for (const [key, value] of previousDescriptors) {
                    if (value) roadBucketDescriptors.set(key, value); else roadBucketDescriptors.delete(key);
                }
                support?.rollback(); geometry?.rollback(); committed = false; return true;
            }, discard,
        };
        handedOff = true;
        return { entries: [...members.map(member => member.entry), ...(paint ? [paint.entry] : []), entry],
            usage: Object.freeze({ owners: changes.size, sourceTiles: tileChanges.size,
                dependencyBuckets: dependencyRevisions.size, geometryDependencyBuckets, paintDependencyBuckets,
                geometryBuckets: geometry?.bucketKeys.length || 0,
                geometryBytes: geometry?.outputBytes || 0 }),
            roadSurfaceRead: support?.read || null,
            *captureRoadSurfaceReadSteps(bounds, isCurrent) {
                return yield* (support || renderedRoadSurfaces).captureReadSnapshotSteps(bounds,
                    { ...ROAD_SUPPORT_PUBLICATION_LIMITS, isCurrent: () => current() && isCurrent() });
            },
            changesDrivableQueryWindow: support?.changesDrivableQueryWindow || false,
            isCurrent: () => checkRead(completeCurrent), discard,
            finalize() {
                if (!committed || settled) return false;
                settled = true;
                for (const member of members) member.finalize();
                paint?.finalize(); support?.finalize(); geometry?.finalize();
                if (roadsGroup === parent && dependenciesCurrent()
                    && [...changes].every(([key, row]) => (roadEntries.get(key) || null) === (row.nextEntry || null))) {
                    for (const key of dependencyRevisions.keys()) {
                        roadSurfaceBucketsPendingPublication.delete(key);
                        roadSurfaceTiles?.markBucketReady(key);
                    }
                }
                return true;
            },
        };
    } finally { if (!handedOff) discard(); }
}

function markRoadAggregateOwnerBuckets(owner, bucketKeys) {
    let keys = roadPendingOwnerBuckets.get(owner);
    if (!keys) roadPendingOwnerBuckets.set(owner, keys = new Set());
    for (const key of bucketKeys) {
        keys.add(key);
        let owners = roadPendingBucketOwners.get(key);
        if (!owners) roadPendingBucketOwners.set(key, owners = new Set());
        owners.add(owner);
    }
    for (const key of keys) roadDependencyRevisions.set(key, (roadDependencyRevisions.get(key) || 0) + 1);
}
function roadAggregateDependencyKeys(first) {
    const found = new Set([first]);
    const ownersSeen = new Set();
    for (const key of found) {
        for (const owner of roadPendingBucketOwners.get(key) || []) {
            if (ownersSeen.has(owner)) continue;
            ownersSeen.add(owner);
            if (ownersSeen.size > ROAD_SUPPORT_PUBLICATION_LIMITS.maxOwners) {
                throw new Error('Road publication dependency owner capacity exceeded');
            }
            for (const related of roadPendingOwnerBuckets.get(owner) || []) {
                found.add(related);
                if (found.size > ROAD_PUBLICATION_MAX_BUCKETS) throw new Error('Road publication bucket capacity exceeded');
            }
        }
    }
    return [...found];
}
function acknowledgeRoadAggregateDependencies(keys) {
    for (const key of keys) {
        for (const owner of roadPendingBucketOwners.get(key) || []) {
            const pending = roadPendingOwnerBuckets.get(owner);
            pending?.delete(key);
            if (!pending?.size) roadPendingOwnerBuckets.delete(owner);
        }
        roadPendingBucketOwners.delete(key);
        roadDependencyRevisions.delete(key);
    }
}

function* prepareRoadAggregateGroupSteps(active) {
    const members = [];
    let handedOff = false, batch = null, ticket = null, result = null, error = null;
    const discard = () => {
        ticket?.cancel('road-group-superseded');
        if (batch?.state === 'staged') batch.discard('road-group-superseded');
        for (const member of members) member.discard();
    };
    try {
        // Prepare coarse material coverage before acquiring the GTA staging
        // lease. The resulting entry joins every physical member below.
        const paint = groundPaint ? yield* groundPaint.prepareBucketsSteps(active.bucketKeys, active.isCurrent) : null;
        if (!active.isCurrent()) { paint?.discard(); return null; }
        if (paint) members.push(paint);
        for (const [index, row] of active.rows.entries()) {
            const member = yield* prepareRoadAggregatePublicationSteps(row.key, row.assembled, row.descriptor,
                { isCurrent: active.isCurrent, supportBucketKeys: index === 0 ? active.bucketKeys : [] });
            if (!member || !active.isCurrent()) { member?.discard(); return null; }
            members.push(member);
            if (!(yield* prewarmRoadAggregateSteps(member.entry.root, active.isCurrent))) return null;
        }
        handedOff = true;
        return {
            entries: members.map(member => member.entry),
            get boundaryResult() { return result; },
            get boundaryError() { return error; },
            enqueue() {
                if (ticket) return true;
                batch ||= surfacePublications.prepareBatch(members.map(member => member.entry));
                if (batch.state !== 'staged') { result = batch; return true; }
                ticket = groundPublications.enqueue(batch, { onPublished(value) {
                    for (const member of members) member.finalize();
                    result = value;
                } });
                if (!ticket) return false;
                ticket.promise.then(value => { result = value; }, failure => { error = failure; });
                return true;
            },
            discard,
        };
    } finally { if (!handedOff) discard(); }
}

function discardActiveRoadAssembly() {
    const active = activeRoadAssemblyTask;
    activeRoadAssemblyTask = null;
    active?.publicationSteps?.return();
    active?.publication?.discard();
    for (const row of active?.rows || []) row.task.cancel();
}

function assembleDirtyRoadAggregates({ frameBudgetMs = Infinity, maxUploads = Infinity } = {}) {
    const changed = roadBatcher.takeDirtyBuckets();
    for (const key of changed) roadAggregateFailures.delete(key);
    pendingAssembleBuckets.push(...changed);
    for (const [key, failure] of roadAggregateFailures) {
        if (performance.now() >= failure.retryAt) {
            pendingAssembleBuckets.push(...(failure.bucketKeys || [key]));
            failure.retryAt = Infinity;
        }
    }
    if ((!activeRoadAssemblyTask && !pendingAssembleBuckets.length) || !roadsGroup) return 0;
    pendingAssembleBuckets = [...new Set(pendingAssembleBuckets)];
    const order = key => Number(roadBucketDescriptors.get(key)?.renderOrder) || 0;
    const sortPending = () => pendingAssembleBuckets.sort((a,b) => order(a)-order(b));
    const requeue = active => {
        pendingAssembleBuckets.push(...active.bucketKeys);
        pendingAssembleBuckets = [...new Set(pendingAssembleBuckets)];
        discardActiveRoadAssembly(); sortPending();
    };
    sortPending();
    if (activeRoadAssemblyTask && (!activeRoadAssemblyTask.isCurrent()
        || (pendingAssembleBuckets.length && order(pendingAssembleBuckets[0]) < order(activeRoadAssemblyTask.bucketKey)))) {
        requeue(activeRoadAssemblyTask);
    }
    const startedMs = performance.now();
    let processed = 0;
    while (activeRoadAssemblyTask || pendingAssembleBuckets.length) {
        if (performance.now()-startedMs > frameBudgetMs) break;
        if (!activeRoadAssemblyTask) {
            const key = pendingAssembleBuckets.shift();
            let keys;
            try { keys = roadAggregateDependencyKeys(key).sort((a,b) => order(a)-order(b)); }
            catch (error) {
                roadAggregateFailures.set(key, { attempts: 3, error: String(error.message), retryAt: Infinity });
                console.error(`[roads] aggregate dependency group failed for ${key}`, error); continue;
            }
            const selected = new Set(keys);
            pendingAssembleBuckets = pendingAssembleBuckets.filter(value => !selected.has(value));
            let outputBytes = 0;
            const rows = keys.map(key => ({ key, descriptor: roadBucketDescriptors.get(key),
                dependencyRevision: roadDependencyRevisions.get(key),
                task: roadBatcher.beginAssembly(key, { includeBounds: true, admitBytes(bytes) {
                    if (!Number.isSafeInteger(bytes) || outputBytes+bytes > ROAD_PUBLICATION_MAX_OUTPUT_BYTES) {
                        throw new Error('Road publication output capacity exceeded');
                    }
                    outputBytes += bytes; return true;
                } }), assembled: null }));
            activeRoadAssemblyTask = { bucketKey: keys[0], bucketKeys: keys, rows, assemblyIndex: 0,
                publicationSteps: null, publication: null,
                isCurrent: () => rows.every(row => row.task.isCurrent()
                    && roadDependencyRevisions.get(row.key) === row.dependencyRevision) };
        }
        const active = activeRoadAssemblyTask;
        if (!active.isCurrent()) { requeue(active); continue; }
        try {
            while (active.assemblyIndex < active.rows.length) {
                const row = active.rows[active.assemblyIndex];
                const remaining = frameBudgetMs === Infinity ? Infinity
                    : Math.max(.1, frameBudgetMs-(performance.now()-startedMs));
                if (!row.task.step(remaining)) break;
                row.assembled = row.task.result();
                active.assemblyIndex++;
                if (performance.now()-startedMs > frameBudgetMs) break;
            }
            if (active.assemblyIndex < active.rows.length) break;
            active.publicationSteps ||= active.publication ? null : prepareRoadAggregateGroupSteps(active);
            let deferred = false;
            while (!active.publication && performance.now()-startedMs <= frameBudgetMs) {
                const next = active.publicationSteps.next();
                if (next.done) {
                    active.publication = next.value;
                    active.publicationSteps = null;
                    if (!active.publication) requeue(active);
                    break;
                }
                if (next.value?.deferFrame) { deferred = true; break; }
            }
            if (activeRoadAssemblyTask !== active) continue;
            if (deferred || !active.publication) break;
            if (active.publication.boundaryError) throw active.publication.boundaryError;
            if (!active.publication.boundaryResult) { active.publication.enqueue(); break; }
            if (!active.publication.boundaryResult.status.startsWith('published')) { requeue(active); continue; }
            for (const key of active.bucketKeys) roadAggregateFailures.delete(key);
            if (active.isCurrent()) acknowledgeRoadAggregateDependencies(active.bucketKeys);
            activeRoadAssemblyTask = null;
            processed += active.bucketKeys.length;
            // Uploads were staged over frames. Keep the old public argument as
            // a limit on completed group processing, never split an atomic group.
            if (processed >= maxUploads) break;
        } catch (error) {
            discardActiveRoadAssembly();
            const attempts = (roadAggregateFailures.get(active.bucketKey)?.attempts || 0)+1;
            roadAggregateFailures.set(active.bucketKey, { attempts, bucketKeys: active.bucketKeys,
                error: String(error?.message || error),
                retryAt: attempts < 3 ? performance.now()+1000*2**(attempts-1) : Infinity });
            console.error(`[roads] aggregate publication failed for ${active.bucketKey}`, error);
        }
    }
    recordLayerFrameMs('roads:assemble', performance.now()-startedMs);
    return processed;
}

// The settle-gated per-frame driver, and the force path for synchronous
// rebuilds (proposal republish) that must not leave stale aggregates on
// screen for even one frame. The budgeted path also drains any backlog the
// budget deferred on earlier frames, without waiting for a fresh settle.
function flushRoadAggregatesIfSettled() {
    const settled = shouldRunOnSettle(roadAggregateGate, roadAggregateRevision);
    if (!settled && pendingAssembleBuckets.length === 0 && !activeRoadAssemblyTask
        && roadAggregateFailures.size === 0) return;
    assembleDirtyRoadAggregates({
        frameBudgetMs: ROAD_ASSEMBLE_FRAME_BUDGET_MS,
        maxUploads: ROAD_ASSEMBLE_MAX_UPLOADS_PER_FRAME,
    });
}

function flushRoadAggregatesNow() {
    markSettleGateApplied(roadAggregateGate, roadAggregateRevision);
    assembleDirtyRoadAggregates();
}

function disposeRoadAggregates() {
    for (const [bucketKey, aggregate] of roadAggregates) {
        if (surfacePublications?.retire?.(roadAggregatePublicationKey(bucketKey), {
            root: aggregate.mesh,
            reason: 'roads-layer-ended',
        })) continue;
        disposeRoadAggregateMesh(aggregate.mesh);
    }
    roadAggregates.clear();
    roadBatcher.clear();
    roadBucketDescriptors.clear();
    roadMaterialIds.clear();
    roadCollisionCandidatesByBucket.clear();
    roadCollisionDirtyOwnersByBucket.clear();
    roadCollisionBucketRevisions.clear();
    publishedRoadSurfaceOwnersByBucket.clear();
    clearGroundCoverRoads();
    roadSurfaceBucketsPendingPublication.clear();
    pendingAssembleBuckets = [];
    discardActiveRoadAssembly();
    roadAggregateFailures.clear();
    roadPendingOwnerBuckets.clear();
    roadPendingBucketOwners.clear();
    roadDependencyRevisions.clear();
    lastRoadAggregateGpuFrame = -1;
}

// Builds one complete road feature off-scene. Tile jobs call this under the
// existing frame budget, then stage all completed feature groups together;
// no road polygon becomes visible while its tile is only half constructed.
// One road feature, built across frames. The queue already gives roads one item
// per feature, but a single feature was still up to 27.4 ms — a multi-ring
// motorway polygon with retaining profiles builds a surface, a terrain collar
// and a wall per ring, and an item cannot be interrupted once it starts.
//
// Stages: setup (masks, materials) -> one ring per visit ->
// pedestrian edging -> bike lanes -> done. Order and output are unchanged; the
// featureGroup is simply assembled over several frames instead of one.
const captureRoadRenderGround = createRoadRenderGroundCapture({
    railSurfaceOffsetY: GROUND_SURFACE_LEVELS.tramBed,
    roadSurfaceOffsetAtProfile: profile => roadSurfaceSceneOffset(profile?.highway),
});

function* captureRoadRenderGroundSteps(owner = 'surface-builder', preparedFormation = null, preparedRailFormation = undefined) {
    const terrain = terrainReference, civilGround = civilGroundReference, roadFormation = roadFormationModel;
    try {
        return yield* captureRoadRenderGround({ terrain, civilGround, roadFormation, owner, preparedFormation, preparedRailFormation,
            sourcesCurrent: () => terrainReference === terrain && civilGroundReference === civilGround
                && roadFormationModel === roadFormation });
    } catch (error) {
        if (['formation-inputs-stale', 'formation-snapshot-stale', 'road-alignment-snapshot-stale',
            'rail-formation-snapshot-stale', 'road-render-ground-stale'].includes(error.code)) return null;
        throw error;
    }
}

// The coordinator supplies the civil construction read explicitly. Final
// receiver withdrawals are supplied separately to captureRoadRenderGroundSteps
// after road design, and can never feed back into that same design pass.
function* prepareRoadAlignmentGroundSourcesSteps({ terrain, railFormation, maxFeatures,
    maxDependencyEntries, maxDependencyBounds, isCurrent, terrainBounds = [], composedBounds = [] }) {
    if (!Object.isFrozen(terrain) || !Object.isFrozen(railFormation)
        || ![maxFeatures, maxDependencyEntries, maxDependencyBounds].every(value => Number.isSafeInteger(value) && value > 0)
        || typeof isCurrent !== 'function') {
        throw new TypeError('Road alignment sources require captured terrain and construction rail');
    }
    const features = loadedSurfaceFeaturesForVerticalAlignments();
    if (features.length > maxFeatures) throw Object.assign(new Error('Road alignment source capacity exceeded'), { code: 'ground-generation-capacity' });
    if (terrainBounds === null || terrainBounds.length) {
        roadVerticalAlignmentModel.invalidateTerrain(terrainBounds);
        roadFormationModel.invalidateTerrain(terrainBounds);
    }
    // Cached road grades were sampled against the previously published rail
    // construction. Diff that read against this candidate, before road design;
    // final rail receiver withdrawals must never feed back into road grading.
    const previousRail = roadFormationModel.getPublishedBuildInputs()?.context.railFormation;
    const previousCivil = yield* railCivilGroundDependencySnapshotSteps(previousRail);
    const nextCivil = yield* railCivilGroundDependencySnapshotSteps(railFormation);
    const railBounds = yield* changedCivilGroundDependencyBoundsSteps(previousCivil.entries, nextCivil.entries, {
        maxEntries: maxDependencyEntries, maxBounds: maxDependencyBounds, isCurrent,
    });
    if (railBounds.length) yield* roadFormationModel.invalidateComposedGroundSteps(railBounds);
    if (composedBounds.length) yield* roadFormationModel.invalidateComposedGroundSteps(composedBounds);
    const steps = roadVerticalCenterlinesFromSurfaceFeaturesSteps(features, {
        terrainElevationAslMAtCoordinate: ([lon, lat]) => {
            const y = terrain.evidenceSceneYAt(lon, lat);
            return typeof y === 'number' && Number.isFinite(y) ? terrain.anchorHeightM + y : null;
        },
        railElevationAslMAtCoordinate: (coordinate, { composition }) => sampleRailFormationElevationAslMAtCoordinate({
            railFormation, coordinate, composition, anchorElevationAslM: terrain.anchorHeightM }),
    });
    try {
        for (;;) {
            if (!isCurrent()) throw Object.assign(new Error('Alignment sources changed'), { code: 'ground-generation-stale' });
            const next = steps.next();
            if (next.done) {
                const change = roadVerticalAlignmentModel.setCenterlineTile(SURFACE_ALIGNMENT_SET_KEY, next.value);
                if (change?.changed) roadFormationModel.invalidateVerticalAlignments(change.bounds);
                return change;
            }
            yield next.value;
        }
    } finally { steps.return(); }
}

function* prepareRoadFormationGroundSteps({ terrain, railFormation, verticalAlignments,
    terrainReplacement, isCurrent }) {
    if (!Object.isFrozen(terrain) || typeof isCurrent !== 'function') {
        throw new TypeError('Road construction requires captured ground');
    }
    const model = roadFormationModel, civil = civilGroundReference;
    if (!model || !civil) throw Object.assign(new Error('Road model is not ready'), { code: 'ground-dependency-busy' });
    const current = () => model === roadFormationModel && civil === civilGroundReference && isCurrent();
    const preparedReads = Object.freeze({ terrain, railFormation, verticalAlignments, terrainReplacement });
    for (const [key, features] of tileFeatures) {
        updateSurfaceFormationTile(key, features, verticalAlignments);
        yield { phase: 'road-candidate-surface-inputs' };
        if (!current()) return null;
    }
    const captureBuildInputsSteps = () => captureRoadFormationBuildInputsSteps({ terrain,
        civilGround: civil, railFormation, verticalAlignments, authoredPortalReplacements: [],
        sourcesCurrent: current, preparedReads });
    const publication = yield* model.preparePublicationSteps({ captureBuildInputsSteps, isCurrent: current });
    if (publication) return publication;
    // An unchanged engineered profile still shares the current candidate
    // base with ordinary paths. Keep its compiled profile read, and capture
    // fresh construction inputs without acknowledging nonexistent model work.
    let inputs = null, read = null, handedOff = false, settled = false;
    const release = () => {
        if (settled) return false;
        settled = true; inputs?.release(); read?.release(); return true;
    };
    try {
        inputs = yield* captureBuildInputsSteps();
        const published = model.getPublishedBuildInputs();
        if (!published) throw Object.assign(new Error('Road model has no published generation'), { code: 'ground-dependency-busy' });
        const revision = model.revision, geometryRevision = model.surfaceGeometryRevision;
        read = yield* model.captureReadSnapshotSteps({ ...published.callbacks, readInputs: published,
            replacementTerrainCutoutRegions: published.callbacks.replacementTerrainCutoutRegions?.() || [] });
        const valid = () => !settled && current() && model.revision === revision
            && model.surfaceGeometryRevision === geometryRevision && model.getPublishedBuildInputs() === published;
        if (!valid()) return null;
        handedOff = true;
        return Object.freeze({ read, inputs, isCurrent: valid, unchanged: true, discard: release, finalize: release });
    } finally { if (!handedOff) release(); }
}

// Source holds keep the ordinary publishers drained while the coordinator
// resolves physical dependencies. Only changed receivers need source rows;
// their aggregate publication will retain unchanged bucket neighbours.
function* admitRoadGroundGenerationSteps(featureKeys, { isCurrent, maxFeatures,
    ground = null, changedBounds = [], full = true } = {}) {
    if (!Array.isArray(featureKeys) || !Number.isSafeInteger(maxFeatures) || maxFeatures <= 0
        || featureKeys.length > maxFeatures
        || !Array.isArray(changedBounds)
        || (ground && typeof ground.roadFormation?.getSurfaceGeometryGeneration !== 'function')
        || new Set(featureKeys).size !== featureKeys.length || typeof isCurrent !== 'function') {
        throw new TypeError('Road admission requires a bounded source-owner set');
    }
    if (!roadsGroup || roadReceiverGenerationLease) return null;
    const parent = roadsGroup, table = roadEntries, rows = [], regions = new Set(), lease = {};
    const sourceEpoch = roadFeatureSources.revision, receiverEpoch = roadReceiverMutationEpoch;
    const current = () => roadReceiverGenerationLease === lease && roadsGroup === parent && roadEntries === table
        && sourceEpoch === roadFeatureSources.revision && receiverEpoch === roadReceiverMutationEpoch && isCurrent();
    // The row audit belongs to admission/publication, not every vertex in a
    // detached rail or road build. All receiver writers advance the epoch.
    const validate = () => current() && rows.every(row => row.source.isCurrent()
            && (roadEntries.get(row.featureKey) || null) === row.previousEntry
            && (!row.previousEntry || row.previousEntry.pendingRefs === 0
                && row.previousEntry.tileRefs.size === row.previousTileRefs.length
                && row.previousTileRefs.every(key => row.previousEntry.tileRefs.has(key))));
    const release = () => { if (roadReceiverGenerationLease === lease) roadReceiverGenerationLease = null; };
    lease.cancel = release;
    roadReceiverGenerationLease = lease;
    let handedOff = false, retainedOwners = 0;
    try {
        for (const featureKey of featureKeys) {
            if (typeof featureKey !== 'string') throw new TypeError('Road source keys must be strings');
            const source = roadFeatureSources.captureOwner(featureKey), previousEntry = roadEntries.get(featureKey) || null;
            if (previousEntry?.pendingRefs) return null;
            const previousTileRefs = [...(previousEntry?.tileRefs || [])];
            const tileKeys = new Set([...previousTileRefs, ...source.tileKeys]);
            if (tileKeys.size > ROAD_PUBLICATION_MAX_BUCKETS) throw new RangeError('Road source membership capacity exceeded');
            for (const key of tileKeys) if (tileBuildJobs.has(key) || tileRegistrationJobs.has(key)) return null;
            const regionTileKey = previousEntry?.regionTileKey ?? source.selected?.tileKey;
            const bounds = [];
            for (const feature of new Set([source.selected?.feature, previousEntry?.sourceFeature].filter(Boolean))) {
                let value = groundFeatureBounds.get(feature);
                if (!value) {
                    value = yield* roadRenderQueryBoundsSteps(feature, (lon, lat) => ({
                        x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD),
                        z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M }));
                    if (value) groundFeatureBounds.set(feature, Object.freeze(value));
                }
                if (value) bounds.push(value);
            }
            if (ground && !full && previousEntry && source.selected
                && previousEntry.identity?.revisionKey === source.selected.identity.revisionKey
                && previousEntry.formationGeneration === (roadSurfaceUsesEngineeredFormation(source.selected.feature)
                    ? ground.roadFormation.getSurfaceGeometryGeneration(source.selected.feature.properties?.osm_id) : 0)
                && previousTileRefs.length === source.tileKeys.length
                && source.tileKeys.every(key => previousEntry.tileRefs.has(key))
                && !bounds.some(b => changedBounds.some(change => boundsIntersectWithPadding(b, change, 0)))) {
                retainedOwners++;
                yield { phase: 'road-generation-admission-retain' }; if (!current()) return null;
                continue;
            }
            if (rows.length >= maxFeatures) throw Object.assign(new RangeError('Road source closure exceeds capacity'),
                { code: 'ground-generation-capacity' });
            if (regionTileKey !== undefined) regions.add(roadRegionForTile(regionTileKey));
            rows.push({ featureKey, source, previousEntry, previousTileRefs, regionTileKey, bounds });
            yield { phase: 'road-generation-admission' }; if (!current()) return null;
        }
        const affected = key => [...regions].some(region => key.endsWith(`/${region}`) || key === `RoadPaint@${region}`);
        for (const keys of [roadPendingBucketOwners.keys(), roadCollisionDirtyOwnersByBucket.keys(),
            pendingAssembleBuckets, activeRoadAssemblyTask?.bucketKeys || []]) {
            for (const key of keys) {
                if (affected(key)) return null;
                yield { phase: 'road-generation-admission-queue' }; if (!current()) return null;
            }
        }
        if (!validate()) return null;
        handedOff = true;
        return Object.freeze({ rows: Object.freeze(rows.map(Object.freeze)), isCurrent: current, validate, release,
            usage: Object.freeze({ examinedOwners: featureKeys.length, admittedOwners: rows.length, retainedOwners }),
            setCancel(callback) { if (typeof callback !== 'function') throw new TypeError('Road generation requires cancellation'); lease.cancel = callback; } });
    } finally { if (!handedOff) release(); }
}

// Source polygons, real ring geometry, aggregate receivers, query ownership,
// and tile membership are prepared through the ordinary production compilers.
function* prepareRoadGroundGenerationSteps({ admission, ground, generation, isCurrent, queryBounds = null,
    changedBounds = [], full = true, maxBuckets, maxSourceTiles, maxOwners = ROAD_SUPPORT_PUBLICATION_LIMITS.maxOwners,
    maxGeometryBytes = ROAD_PUBLICATION_MAX_OUTPUT_BYTES, checkRead = check => check() }) {
    if (!admission?.isCurrent || !Object.isFrozen(ground) || typeof ground?.isCurrent !== 'function'
        || !Object.hasOwn(ground, 'structurePublications') || !ground.structurePublications?.getActive
        || typeof isCurrent !== 'function' || typeof checkRead !== 'function'
        || ![maxBuckets, maxSourceTiles, maxOwners, maxGeometryBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Road generation requires admitted sources, receiver budgets and explicit prepared ground');
    }
    if (admission.rows.length > maxOwners) throw Object.assign(
        new RangeError(`Road generation owner capacity exceeded: ${admission.rows.length} > ${maxOwners}`),
        { code: 'ground-generation-capacity' });
    let held = null, buildGround = null, task = null, candidate = null, handedOff = false, settled = false;
    const replacements = [], publishedSourceTiles = new Map(), backstopEpoch = roadReceiverMutationEpoch;
    // Aggregate support ownership includes unchanged neighbours. Count actual
    // source recompilation separately so closure fan-out remains measurable.
    const sourceOwners = { ...admission.usage, compiledOwners: 0, omittedOwners: 0,
        removedOwners: 0, membershipOnlyOwners: 0, retainedOwners: admission.usage?.retainedOwners || 0,
        newOwners: 0, changedSources: 0, changedGrades: 0, physicalDependencies: 0, fullOwners: 0 };
    const backstopsCurrent = () => roadReceiverMutationEpoch === backstopEpoch;
    const current = () => !settled && admission.isCurrent() && ground.isCurrent() && isCurrent() && backstopsCurrent();
    const release = () => {
        task?.dispose(); task = null;
        buildGround?.release(); buildGround = null; held?.release?.(); held = null;
        admission.release();
    };
    const discard = () => {
        if (settled) return false;
        settled = true; candidate?.discard(); release(); return true;
    };
    admission.setCancel(discard);
    try {
        if (!current()) return null;
        // This publisher replaces the ordinary per-tile build jobs. Capture
        // their source receipts, including empty tiles, so successful shared
        // publication can acknowledge the same tile-readiness contract.
        for (const [key, features] of tileFeatures) {
            if (publishedSourceTiles.size >= maxSourceTiles) throw Object.assign(
                new RangeError('Road publication source-tile capacity exceeded'),
                { code: 'ground-generation-capacity' });
            publishedSourceTiles.set(key, features);
            yield { phase: 'road-generation-tile-readiness' };
            if (!current()) return null;
        }
        held = retainReadSnapshot(ground, 'road-receiver-generation');
        const proposalMask = ground.proposalMask || captureProposalMaskSnapshot();
        buildGround = ownReadSnapshot({ ...held, proposalMask,
            isCurrent: () => current() && proposalMask.isCurrent(),
            currentWithin: () => () => current() && proposalMask.isCurrent() }, [held]);
        held = null;
        for (const row of admission.rows) {
            if (!buildGround.isCurrent()) return null;
            const feature = row.source.selected?.feature;
            const previous = row.previousEntry;
            const expectedFormation = feature && roadSurfaceUsesEngineeredFormation(feature)
                ? ground.roadFormation.getSurfaceGeometryGeneration(feature.properties?.osm_id) : 0;
            const changedSource = previous && feature && previous.identity?.revisionKey !== row.source.selected.identity.revisionKey;
            const changedGrade = previous && feature && previous.formationGeneration !== expectedFormation;
            const changedDependency = (row.bounds || []).some(b => changedBounds.some(change => boundsIntersectWithPadding(b, change, 0)));
            const geometryUnchanged = !full && previous && feature && !changedSource && !changedGrade && !changedDependency;
            if (geometryUnchanged) {
                if (previous.tileRefs.size !== row.source.tileKeys.length
                    || row.source.tileKeys.some(key => !previous.tileRefs.has(key))) {
                    sourceOwners.membershipOnlyOwners++;
                    replacements.push({ featureKey: row.featureKey, previousEntry: previous,
                        nextEntry: { ...previous, tileRefs: new Set(row.source.tileKeys) },
                        reuseGeometry: true, replaceTileMembership: true });
                } else sourceOwners.retainedOwners++;
                yield { phase: 'road-generation:retain' };
                continue;
            }
            let collected = null, nextEntry = null;
            if (feature) {
                sourceOwners.compiledOwners++;
                if (!previous) sourceOwners.newOwners++;
                if (changedSource) sourceOwners.changedSources++;
                if (changedGrade) sourceOwners.changedGrades++;
                if (changedDependency) sourceOwners.physicalDependencies++;
                if (full) sourceOwners.fullOwners++;
                task = createRoadFeatureTask(feature, row.regionTileKey, buildGround, {
                    abortOnMissingTerrain: true,
                });
                let status;
                do {
                    status = task.step();
                    yield { phase: `road-generation:${task.phaseLabel()}`, ...(status === 'defer' ? { deferFrame: true } : {}) };
                    if (!buildGround.isCurrent() || !task.isCurrent()) return null;
                } while (status === 'more' || status === 'defer');
                if (status !== 'done' && task.omission()?.kind !== 'excluded') {
                    throw Object.assign(new Error(`Road receiver ${row.featureKey} lacks ${task.omission()?.reason || 'geometry'}`),
                        { code: 'road-receiver-evidence-unavailable' });
                }
                if (task.group()) {
                    const steps = collectRoadFeatureGroupSteps(task.group(), row.featureKey, row.regionTileKey, buildGround.openings);
                    try {
                        for (;;) {
                            const next = steps.next();
                            if (next.done) { collected = next.value; break; }
                            yield { phase: 'road-generation:parts' }; if (!buildGround.isCurrent()) return null;
                        }
                    } finally { steps.return(); }
                    const { featureKey, regionTileKey, bucketKeys, parts, surfaceParts, surfaceBucketKeys, paintBucketKey,
                        terrainCutoutRegions } = collected;
                    nextEntry = { featureKey, regionTileKey, bucketKeys, parts, surfaceParts, surfaceBucketKeys, paintBucketKey,
                        terrainCutoutRegions,
                        identity: row.source.selected.identity,
                        sourceFeature: feature,
                        formationGeneration: roadSurfaceUsesEngineeredFormation(feature)
                            ? (ground.roadFormation?.getSurfaceGeometryGeneration(feature.properties?.osm_id) || 0) : 0,
                        tileRefs: new Set(row.source.tileKeys), pendingRefs: 0 };
                }
                if (!collected) sourceOwners.omittedOwners++;
                task.dispose(); task = null;
            } else if (previous) sourceOwners.removedOwners++;
            replacements.push({ featureKey: row.featureKey, previousEntry: row.previousEntry, nextEntry, collected, replaceTileMembership: true });
        }
        candidate = replacements.length || queryBounds ? yield* prepareRoadReceiverReplacementSteps(replacements, {
            generation, isCurrent: () => buildGround.isCurrent(), queryBounds, maxBuckets, maxSourceTiles, maxOwners, maxGeometryBytes, checkRead,
        }) : { entries: [], roadSurfaceRead: null, isCurrent: () => true, discard() {}, finalize: () => true };
        if (!candidate || !buildGround.isCurrent()) return null;
        const entries = candidate.entries.map((entry, index) => index === candidate.entries.length - 1 ? { ...entry, discard } : entry);
        const nextEntries = new Map(replacements.map(row => [row.featureKey, row.nextEntry]));
        handedOff = true;
        return { ...candidate, usage: Object.freeze({ ...candidate.usage, sourceOwners: Object.freeze(sourceOwners) }),
            entries, discard, isCurrent: () => !settled && backstopsCurrent() && candidate.isCurrent(),
            *captureRoadSurfaceReadSteps(bounds, isCurrent) {
                const currentRead = () => !settled && backstopsCurrent() && candidate.isCurrent() && isCurrent();
                return candidate.captureRoadSurfaceReadSteps
                    ? yield* candidate.captureRoadSurfaceReadSteps(bounds, currentRead)
                    : yield* renderedRoadSurfaces.captureReadSnapshotSteps(bounds,
                        { ...ROAD_SUPPORT_PUBLICATION_LIMITS, isCurrent: currentRead });
            },
            *terrainCutoutRegionsSteps({ bounds, maxRegions }) {
                if (!bounds || !Number.isSafeInteger(maxRegions) || maxRegions < 1) {
                    throw new TypeError('Road receiver cuts require bounded coverage');
                }
                const regions = [];
                const owners = function* () {
                    for (const [key, entry] of roadEntries) yield nextEntries.has(key) ? nextEntries.get(key) : entry;
                    for (const [key, entry] of nextEntries) if (!roadEntries.has(key)) yield entry;
                };
                for (const entry of owners()) {
                    if (!current()) throw Object.assign(new Error('Road cut backstop changed'), { code: 'ground-generation-stale' });
                    for (const region of entry?.terrainCutoutRegions || []) {
                        if (!boundsIntersectWithPadding(region.bounds, bounds, 0)) continue;
                        if (regions.length >= maxRegions) throw Object.assign(new Error('Road receiver cut capacity exceeded'),
                            { code: 'ground-generation-capacity' });
                        regions.push(region); yield { phase: 'road-receiver-cut-boundaries' };
                    }
                    yield { phase: 'road-receiver-cut-owners' };
                }
                return Object.freeze(regions);
            },
            formationBackstopReady(profile) {
                if (settled || !profile?.sourceOwnerKey || !profile.sourceRevisionKey) return false;
                const key = profile.sourceOwnerKey;
                const entry = nextEntries.has(key) ? nextEntries.get(key) : roadEntries.get(key);
                if (!entry || entry.identity?.revisionKey !== profile.sourceRevisionKey
                    || entry.formationGeneration !== ground.roadFormation.getSurfaceGeometryGeneration(profile.osmId)
                    || !(entry.surfaceParts > 0)) return false;
                // A currently published unaffected receiver is usable proof,
                // but it must remain exactly that receiver until the cut commits.
                return true;
            },
            finalize() {
                if (settled || !candidate.finalize()) return false;
                for (const [key, features] of publishedSourceTiles) {
                    // Never acknowledge an arriving replacement on behalf of
                    // the older generation that just became visible.
                    if (tileFeatures.get(key) === features && !tileRegistrationJobs.has(key)) {
                        roadSurfaceTiles?.awaitBuckets(key, []);
                    }
                }
                settled = true; release(); return true;
            } };
    } finally { if (!handedOff) discard(); }
}

function createRoadFeatureTask(feature, tileKey, suppliedGround = null, {
    abortOnMissingTerrain = false,
} = {}) {
    let phase = 'inputs';
    let inputSteps = suppliedGround ? null : captureRoadRenderGroundSteps('road-feature');
    let ground = retainReadSnapshot(suppliedGround, 'road-feature');
    let proposalMask = suppliedGround?.proposalMask || null;
    let groundCurrent = () => true;
    let ctx = null;
    let ringIndex = 0;
    let ringTask = null;
    let paintSteps = null;
    let bikePaintSteps = null;
    let result = null;
    let omission = null;
    const osmId = feature?.properties?.osm_id;
    const featureLabel = osmId == null ? 'road' : `road ${osmId}`;
    const releaseGround = () => { ground?.release?.(); ground = null; };

    return {
        isCurrent: () => groundCurrent(),
        step() {
            if (phase === 'inputs') {
                if (!ground) {
                    const next = inputSteps.next();
                    if (!next.done) return 'more';
                    ground = next.value;
                    if (!ground) { inputSteps = captureRoadRenderGroundSteps('road-feature'); return 'more'; }
                }
                if (typeof ground.isCurrent !== 'function') throw new TypeError('Road build requires captured ground validity');
                const bounds = roadRenderQueryBounds(feature, (lon, lat) => ({
                    x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD),
                    z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M,
                }));
                proposalMask ||= captureProposalMaskSnapshot();
                const capturedGroundCurrent = ground.currentWithin?.(bounds) || ground.isCurrent;
                groundCurrent = () => capturedGroundCurrent() && proposalMask.isCurrent();
                inputSteps = null;
                phase = 'setup';
                return 'more';
            }
            if (phase === 'setup') {
                ctx = prepareRoadFeature(feature, tileKey, ground, proposalMask,
                    (kind, reason) => { omission = Object.freeze({ kind, reason }); });
                if (!ctx) { releaseGround(); phase = 'done'; return 'abort'; }
                ctx.abortOnMissingTerrain = abortOnMissingTerrain;
                if (ctx.paintAppearance) {
                    const style = roadGroundPaintStyle(ctx.type);
                    paintSteps = createGroundSurfacePaintRecordSteps({ geometry: feature.geometry,
                        identity: roadFeatureIdentities.identityFor(feature, { tileKey }),
                        receiver: groundPaint.receiver, claim: ctx.surfaceClaim,
                        materialKey: style.key, materialRevision: style.revision,
                        project: (lon, lat) => ({ x: (lon-anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat*DEG_TO_RAD),
                            z: -(lat-anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M }) });
                    phase = 'paint';
                } else phase = 'rings';
                return 'more';
            }
            if (phase === 'paint') {
                const next = paintSteps.next();
                if (!next.done) return 'more';
                ctx.featureGroup.userData.groundPaintRecords = Object.freeze([next.value]);
                phase = ctx.paintOnly ? 'bike' : 'rings';
                return 'more';
            }
            if (phase === 'rings') {
                if (ringIndex < ctx.rings.length) {
                    if (!ringTask) {
                        ringTask = createRoadRingTask(ctx, ringIndex, groundCurrent);
                        return 'more';
                    }
                    const ringStatus = ringTask.step();
                    if (ringStatus === 'more' || ringStatus === 'defer') return ringStatus;
                    if (ringStatus === 'no-data') {
                        // A road on a pier or mole is real, but the DGU grid stops at
                        // the natural coastline, so this ring has no data on every
                        // retry. The ring's terrain task gives up only on a gap it
                        // proved permanent AT THE SAMPLE (core/terrain-evidence-gap.js)
                        // or on a tunnel path it refuses to float, and it names the
                        // point. Both are final: exclude the road — the omission the
                        // caller already tolerates — instead of rejecting the shared
                        // ground generation and every other layer in it. Judging
                        // permanence at the feature's centre instead (16 Sep) held
                        // Split's port ground for good: way 126354021 on the ferry
                        // pier has 20 m data at its centre and NoData at its west
                        // end, so every generation was rejected as unavailable and
                        // no terrain revision was ever going to change that.
                        omission = ringTask.omission?.()
                            || Object.freeze({ kind: 'unavailable', reason: 'terrain-evidence' });
                        if (omission.kind === 'excluded') {
                            console.warn(`[${new Date().toISOString()}] [roads] ${featureLabel} excluded from the ground generation: `
                                + `${omission.reason} at ${omission.x?.toFixed(1)},${omission.z?.toFixed(1)}`);
                        }
                        disposeRoadFeatureGroup(ctx.featureGroup);
                        ringTask = null;
                        ctx = null;
                        releaseGround();
                        phase = 'done';
                        return 'abort';
                    }
                    ringTask = null;
                    ringIndex += 1;
                    return 'more';
                }
                phase = 'pedestrian';
                return 'more';
            }
            if (phase === 'pedestrian') {
                if (!appendPedestrianEdging(ctx)) return 'defer';
                phase = 'bike';
                return 'more';
            }
            if (phase === 'bike') {
                bikePaintSteps ||= ctx.paintAppearance ? createRoadBikePaintSteps(ctx) : createRoadBikeGeometrySteps(ctx);
                const next = bikePaintSteps.next();
                if (!next.done) return next.value?.deferFrame ? 'defer' : 'more';
                if (ctx.paintAppearance && next.value.length) ctx.featureGroup.userData.groundPaintRecords = Object.freeze([
                    ...ctx.featureGroup.userData.groundPaintRecords, ...next.value,
                ]);
                result = finishRoadFeature(ctx);
                releaseGround();
                phase = 'done';
                return result ? 'done' : 'abort';
            }
            return 'done';
        },
        group: () => result,
        omission: () => omission || (result ? null
            : Object.freeze({ kind: 'unavailable', reason: 'empty-geometry' })),
        dispose() {
            inputSteps?.return?.();
            releaseGround();
            ringTask?.dispose?.();
            paintSteps?.return?.();
            bikePaintSteps?.return?.();
            disposeRoadFeatureGroup(ctx?.featureGroup || result);
            ctx = null;
            result = null;
            ringTask = null;
            phase = 'done';
        },
        phaseLabel: () => {
            if (phase !== 'rings') return `${featureLabel} ${phase}`;
            const ringCount = ctx?.rings?.length || 0;
            const ringLabel = `${featureLabel} ring ${Math.min(ringIndex + 1, ringCount)}/${ringCount}`;
            return ringTask ? `${ringLabel} ${ringTask.phaseLabel()}` : ringLabel;
        },
    };
}

// Synchronous drain, for the publish-now path: a proposal edit republishes a
// feature immediately and has nowhere to yield to. Same stages, no interruption.
function buildRoadFeatureGroup(feature, tileKey) {
    const task = createRoadFeatureTask(feature, tileKey);
    try {
        let status = task.step();
        while (status === 'more') status = task.step();
        if (status === 'done') return task.group();
        task.dispose();
        return null;
    } catch (error) {
        task.dispose();
        throw error;
    }
}

function prepareRoadFeature(feature, tileKey, ground, proposalMask, onOmitted = null) {
    const omit = (kind, reason) => { onOmitted?.(kind, reason); return null; };
    const { roadFormation: roadFormationModel, verticalAlignments: roadVerticalAlignmentModel } = ground;
    const tRoadTotal = profNow();
    // Footprint mask: OSM road/rail polygons sit at y=0.02–0.12 — above
    // proposal lakes/parks/squares — so without this check a tram rail
    // would render straight through the middle of a proposed lake.
    // Same multi-point overlap test used for cadastre buildings.
    const tMask = profNow();
    const masked = proposalMask.isFeatureMasked(feature);
    profAdd('ms_mask', tMask);
    if (masked) return omit('excluded', 'proposal-mask');
    const { osm_id, highway_type, railway_type } = feature.properties || {};
    // A solved alignment is a plan; its detached civil root can take several
    // cooperative frames to finish. Until that root is actually published,
    // retain this ordinary OSM polygon as a backstop. It already samples the
    // solved vertical profile below, so Miramarska stays low without exposing
    // terrain/a void while walls and collars are still being assembled.
    if (roadReplacementPublicationReadyForOsmId({
        alignmentModel: roadVerticalAlignmentModel,
        surfacePublications: Object.hasOwn(ground, 'structurePublications')
            ? ground.structurePublications : surfacePublications,
        osmId: osm_id,
    })) return omit('excluded', 'published-structure');
    if (railway_type === 'rail') return omit('excluded', 'rail-owner');

    // The API's tram feature is a broad convenience buffer, not a second
    // physical surface. Drawing it produced an inconsistent asphalt shoulder
    // outside the narrower paver bed. Keep an independently mapped highway,
    // but let rails.js exclusively render standalone tram infrastructure.
    if (railway_type === 'tram' && !highway_type) return omit('excluded', 'tram-owner');

    const type = highway_type || railway_type || 'default';
    const y = getRoadSurfaceY(type, highway_type ? null : railway_type);
    const formationCandidate = !!roadFormationModel
        && roadSurfaceUsesEngineeredFormation(feature);
    const formationWasPending = formationCandidate
        && roadFormationModel.hasPendingBuild?.() === true;
    const tFormation = profNow();
    const retainingProfiles = formationCandidate
        ? roadFormationModel.getSurfaceProfilesForFeature(feature)
        : [];
    if (formationCandidate) {
        const formationMs = profAdd('ms_formation', tFormation);
        roadBuildProfile.max_formation = Math.max(
            roadBuildProfile.max_formation,
            formationMs,
        );
        if (formationWasPending) roadBuildProfile.formation_builds += 1;
    }
    // A buffered polygon can graze one tile while its centerline falls in the
    // neighbouring tile. Wait for that matching line instead of publishing a
    // one-frame terrain-draped version that would then be retained by osm_id.
    if (formationCandidate && retainingProfiles.length === 0) return omit('unavailable', 'formation-profile');
    const engineered = formationCandidate;
    const followsVerticalAlignment = osm_id != null
        && !!roadVerticalAlignmentModel?.getAlignmentForOsmId(osm_id);
    // A path tagged as a tunnel is underground by definition. Until the solver
    // gives it a bore, it has no surface to show: draped on the composed civil
    // ground it would publish a false grade-separated claim on top of the real
    // owner of that ground (the Tomićeva passage floated 3 m above the
    // funicular deck it runs under).
    if (isUnmodelledTunnelPathSurface({
        properties: feature.properties || {}, type, engineered, followsVerticalAlignment,
    })) return omit('unavailable', 'tunnel-alignment');
    const followsNearbyCarriagewayProfile = roadPathUsesNearbyCarriagewayProfile(
        feature.properties || {},
    );
    // Same-level concrete paths are independently triangulated from their
    // neighbouring ground. Even when both sample the same evidence, opposite
    // triangle diagonals can open a scalloped slot at the perimeter; a short
    // terrain-coloured collar seals that shared boundary. A carried bridge or
    // tunnel path owns a structural edge instead and must not grow into terrain.
    const hasTerrainSeam = SIDEWALK_LEVEL_TYPES.has(type)
        && !engineered
        && !followsVerticalAlignment
        && !roadVerticalAlignmentFromProperties(feature.properties || {});
    // Only an ordinary, terrain-draped pedestrian precinct replaces the terrain
    // backstop in the same vertical layer. Explicit or compiled bridge/tunnel
    // evidence keeps normal depth semantics, including while streams are still
    // arriving and the compiled alignment may not exist yet.
    const pedestrianTerrainPriority = type === 'pedestrian'
        && !engineered
        && !followsVerticalAlignment
        && !roadVerticalAlignmentFromProperties(feature.properties || {});
    const usesComposedCivilGround = (type === 'pedestrian'
        || SIDEWALK_LEVEL_TYPES.has(type))
        && !engineered
        && !followsVerticalAlignment
        && !followsNearbyCarriagewayProfile;
    const tunnelPathSurface = isTunnelPathSurface({
        properties: feature.properties || {}, type,
    });
    const entityMetadata = roadEntityMetadata(feature);
    const surfaceContext = {
        feature,
        osm_id,
        type,
        engineered,
        followsVerticalAlignment,
        entityMetadata,
    };
    const surfaceClaim = roadSurfaceClaim(surfaceContext);
    const paintOnly = !!groundPaint
        && [SURFACE_CLASS.SIDEWALK, SURFACE_CLASS.BUFFERED_SIDEWALK].includes(surfaceClaim.surfaceClass)
        && roadGroundPaintEligible({ type, properties: feature.properties,
        engineered, followsVerticalAlignment, followsNearbyCarriagewayProfile });
    const paintAppearance = paintOnly || (!!groundPaint && roadReceiverPaintEligible({
        claim: surfaceClaim, properties: feature.properties, followsVerticalAlignment, type,
    }));
    // Keep the real sidewalk grade and its terrain seam.
    // Its prepared physical footprint, rather than paint coverage, replaces
    // terrain underneath it. Carried/unknown decks retain both vertical levels.
    const terrainCutoutRequired = !paintOnly
        && surfaceClaim.surfaceClass === SURFACE_CLASS.BUFFERED_SIDEWALK
        && surfaceClaim.verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
        && surfaceClaim.verticalBand === 'ground'
        && surfaceClaim.capabilities.support && surfaceClaim.capabilities.backstopCut;
    const mat = paintOnly ? null : getRoadMaterial(type, surfaceClaim);

    const geom = feature.geometry;
    if (!geom) return omit('unavailable', 'source-geometry');
    const nearbyCarriagewayTangentAtLocal = followsNearbyCarriagewayProfile
        ? createRoadPathTangentSampler(
            centerlineLocalPoints(feature.properties?.centerline_geometry),
        )
        : null;
    const rings = geom.type === 'Polygon' ? [geom.coordinates[0]]
                : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0])
                : [];
    // Ground-cover footprints travel with completed ring meshes. Detached or
    // cancelled features must never alter the catch-all paving mask.
    const featureGroup = new THREE.Group();
    featureGroup.name = `RoadFeature:${osm_id != null ? osm_id : type}`;
    featureGroup.userData.sourceTileKey = tileKey;
    return {
        feature, tileKey, osm_id, type, y, mat, engineered, followsVerticalAlignment, ground,
        surfaceClaim,
        paintOnly, paintAppearance,
        terrainCutoutRequired,
        followsNearbyCarriagewayProfile, nearbyCarriagewayTangentAtLocal,
        usesComposedCivilGround,
        tunnelPathSurface,
        hasTerrainSeam,
        pedestrianTerrainPriority,
        retainingProfiles, rings, featureGroup, tRoadTotal,
        pedestrianRings: type === 'pedestrian' ? new Map(pedestrianRings) : null,
        // Carried explicitly. When this build was split into cooperative stages
        // (7ebe0bd), entityMetadata stayed behind as a dead local here while
        // appendRoadRing kept referencing the bare name — a ReferenceError on
        // EVERY road tile, which is why Split rendered roads as voids with only
        // their lane markings (a different layer) visible. Anything the appender
        // needs has to travel in ctx; there is no shared scope any more.
        entityMetadata,
    };
}

function appendRoadRingSurface(ctx, readyGeometry, footprint = null) {
    const {
        tileKey, type, mat, featureGroup,
        entityMetadata,
    } = ctx;
    const geo = readyGeometry;
    // `continue` in the original loop — one ring contributing nothing is not
    // a reason to abandon the rest of the feature.
    if (!geo) return false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `RoadSurface:${type}`;
    mesh.userData.surfaceType = type;
    mesh.userData.groundCoverRing = footprint;
    markRoadSurfaceClaim(mesh, ctx, {
        coverageState: SURFACE_COVERAGE_STATE.BUILDING,
    });
    if (ctx.pedestrianTerrainPriority) {
        mesh.userData.terrainBackstopReplacement = true;
    }
    if (entityMetadata) {
        mesh.userData.selectableRoadSurface = true;
        mesh.userData.entityKey = entityMetadata.key;
        mesh.userData.entityMetadata = entityMetadata;
        mesh.userData.osmId = entityMetadata.osmId;
    }
    mesh.renderOrder = SIDEWALK_LEVEL_TYPES.has(type)
        ? SURFACE_RENDER_ORDER.SIDEWALK
        : ROAD_STENCIL_RENDER_ORDER;
    mesh.receiveShadow = true;
    if (tileKey != null) mesh.userData.tileKey = tileKey;
    featureGroup.add(mesh);
    return mesh;
}

function appendRoadRingTerrainSeam(ctx, surfaceGeometry) {
    const { terrain: terrainReference, civilGround: civilGroundReference,
        roadFormation: roadFormationModel } = ctx.ground;
    const positions = surfaceGeometry?.getAttribute?.('position')?.array;
    if (!positions?.length) return 'done';
    const indices = surfaceGeometry.index?.array || null;
    const landingSceneYAtLocal = (x, z) => {
        const composedY = finiteOrNull(
            civilGroundReference?.inputEvidenceSceneYAtLocal?.(
                CIVIL_GROUND_AUTHORITY.PATH,
                x,
                z,
            ),
        );
        if (composedY !== null) return composedY;
        // An explicitly flat session has a known zero-height ground plane.
        // A present terrain provider with missing evidence must still wait.
        return terrainReference ? terrainReference.evidenceSceneYAtLocal?.(x, z) : 0;
    };
    const seam = buildRoadsideSurfaceTerrainSeamGeometryData({
        positions,
        indices,
        landingSceneYAtLocal,
        // The carriageway and sidewalk already share a paved edge. Only the
        // terrain-facing side needs a ground collar; drawing it onto asphalt
        // would turn a correct curb line into an earth-coloured wash.
        segmentKeep: ({ outerMidX, outerMidZ }) => (
            !roadFormationModel?.publishedSurfaceAtLocal?.(outerMidX, outerMidZ)
        ),
    });
    if (!seam.ready) {
        const missing = seam.missingPoint;
        return missing
            && terrainReference?.hasLoadedCoreCoverageAtLocal?.(
                missing.x,
                missing.z,
            ) === true
            ? 'done'
            : 'defer';
    }
    if (seam.positions.length === 0) return 'done';
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(seam.positions), 3),
    );
    geometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(
            buildWorldXZUvsForPositions(
                seam.positions,
                getActiveTerrainSurface().uvPerM,
            ),
            2,
        ),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, getSidewalkTerrainSeamMaterial(ctx));
    mesh.name = `RoadSidewalkTerrainSeam:${ctx.type}`;
    mesh.userData.surfaceType = ctx.type;
    markSidewalkTerrainSeamClaim(mesh, ctx);
    mesh.renderOrder = SURFACE_RENDER_ORDER.ROAD_EARTHWORK;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    if (ctx.tileKey != null) mesh.userData.tileKey = ctx.tileKey;
    ctx.featureGroup.add(mesh);
    return 'done';
}

function appendRoadRingCollar(ctx, ringIndex) {
    const { tileKey, type, retainingProfiles, featureGroup } = ctx;
    const retainingProfile = retainingProfiles[ringIndex] || null;
    const collarGeometry = retainingProfile
        ? createFormationTerrainCollarGeometry(retainingProfile)
        : null;
    if (!collarGeometry) return;
    const collar = new THREE.Mesh(
        collarGeometry,
        getFormationTerrainCollarMaterial(ctx),
    );
    collar.name = `RoadFormationTerrainCollar:${type}`;
    markRoadEarthworkClaim(collar, ctx);
    collar.renderOrder = SURFACE_RENDER_ORDER.ROAD_EARTHWORK;
    collar.receiveShadow = true;
    collar.castShadow = false;
    if (tileKey != null) collar.userData.tileKey = tileKey;
    featureGroup.add(collar);
}

function appendRoadRingWall(ctx, ringIndex) {
    const { tileKey, type, y, retainingProfiles, featureGroup } = ctx;
    const retainingProfile = retainingProfiles[ringIndex] || null;
    const earthGeometry = retainingProfile
        ? createRetainingWallGeometry(retainingProfile, y, 'earth')
        : null;
    if (earthGeometry) {
        // Ordinary fill and shallow cut are earthwork, not concrete retaining
        // walls. Continue the exact active terrain/landuse material down the
        // slope from the back of the curb to the supplied terrain.
        const earth = new THREE.Mesh(earthGeometry, getFormationTerrainCollarMaterial(ctx));
        // Same aggregate kind/material/order as the adjoining collar: the
        // earth face and its seam become one regional draw call.
        earth.name = `RoadFormationTerrainCollar:${type}`;
        markRoadEarthworkClaim(earth, ctx);
        earth.renderOrder = SURFACE_RENDER_ORDER.ROAD_EARTHWORK;
        earth.receiveShadow = true;
        earth.castShadow = false;
        if (tileKey != null) earth.userData.tileKey = tileKey;
        featureGroup.add(earth);
    }
    const wallGeometry = retainingProfile
        ? createRetainingWallGeometry(retainingProfile, y, 'retaining')
        : null;
    if (wallGeometry) {
        const wall = new THREE.Mesh(wallGeometry, getRetainingWallMaterial(ctx));
        wall.name = `RoadRetainingWall:${type}`;
        markRoadStructureClaim(wall, ctx);
        // Terrain is not a shadow caster, so surface cars otherwise project
        // through it onto open-cut walls as if they were driving overhead.
        wall.receiveShadow = false;
        wall.castShadow = false;
        if (tileKey != null) wall.userData.tileKey = tileKey;
        featureGroup.add(wall);
    }
}

// Proposal roads are authored by a different data layer but remain the same
// physical ROAD authority. Let that layer reuse the exact earth collar,
// battered cut/fill face, retaining-wall material, claims, and render order as
// streamed OSM roads instead of maintaining a second civil-works renderer.
export function appendRoadFormationDressingToGroup({
    profile,
    group,
    osmId,
    surfaceY = 0,
    type = 'residential',
} = {}) {
    if (!profile || !group || typeof group.add !== 'function') return 0;
    const before = group.children.length;
    const ctx = {
        tileKey: null,
        type,
        y: Number(surfaceY) || 0,
        retainingProfiles: [profile],
        featureGroup: group,
        osm_id: osmId == null ? profile.osmId : osmId,
        entityMetadata: null,
        followsVerticalAlignment: false,
        feature: null,
    };
    appendRoadRingCollar(ctx, 0);
    appendRoadRingWall(ctx, 0);
    return group.children.length - before;
}

// A large, engineered, or vertically aligned ring can own three independently
// expensive meshes: its tessellated deck, terrain collar, and retaining face.
// Those rings yield between the exact output-preserving project, triangulate,
// refine, sample, finalize, collar, and wall stages. Small ordinary rings drain
// the same geometry task in one cheap visit to avoid thousands of scheduler
// objects during a citywide road load.
function createRoadRingTask(ctx, ringIndex, isCurrent = () => ctx.ground.isCurrent()) {
    const ringPointCount = ctx.rings[ringIndex]?.length || 0;
    if (!ctx.followsVerticalAlignment
        && !ctx.engineered
        && !ctx.hasTerrainSeam
        && !ctx.terrainCutoutRequired
        && ringPointCount < ROAD_STAGED_RING_MIN_POINTS) {
        let done = false;
        let task = null;
        return {
            step() {
                if (!done) {
                    if (!task) {
                        task = createRoadPolygonGeometryTask(
                            ctx.rings[ringIndex],
                            anchorLon,
                            anchorLat,
                            ctx.y,
                            ctx.osm_id,
                            ctx.engineered,
                            ctx.retainingProfiles[ringIndex] || null,
                            ctx.followsNearbyCarriagewayProfile,
                            ctx.nearbyCarriagewayTangentAtLocal,
                            ctx.usesComposedCivilGround,
                            ctx.tunnelPathSurface,
                            ctx.ground,
                            { abortOnMissingTerrain: ctx.abortOnMissingTerrain },
                        );
                    }
                    let status = task.step();
                    while (status === 'more') status = task.step();
                    if (status === 'defer') return 'defer';
                    if (status === 'no-data') {
                        done = true;
                        return 'no-data';
                    }
                    appendRoadRingSurface(ctx, task.geometry(), task.footprint());
                }
                done = true;
                return 'done';
            },
            dispose: () => task?.dispose(),
            phaseLabel: () => 'geometry',
            omission: () => task?.omission?.() || null,
        };
    }
    let phase = 'surface';
    let surfaceTask = null;
    let surfaceMesh = null;
    let omission = null;
    let footprintSteps = null, afterFootprint = null;
    const hasRetainingProfile = !!ctx.retainingProfiles[ringIndex];
    return {
        step() {
            if (phase === 'surface') {
                if (!surfaceTask) {
                    surfaceTask = createRoadPolygonGeometryTask(
                        ctx.rings[ringIndex],
                        anchorLon,
                        anchorLat,
                        ctx.y,
                        ctx.osm_id,
                        ctx.engineered,
                        ctx.retainingProfiles[ringIndex] || null,
                        ctx.followsNearbyCarriagewayProfile,
                        ctx.nearbyCarriagewayTangentAtLocal,
                        ctx.usesComposedCivilGround,
                        ctx.tunnelPathSurface,
                        ctx.ground,
                        { abortOnMissingTerrain: ctx.abortOnMissingTerrain },
                    );
                    return 'more';
                }
                const surfaceStatus = surfaceTask.step();
                if (surfaceStatus === 'more' || surfaceStatus === 'defer') {
                    return surfaceStatus;
                }
                if (surfaceStatus === 'no-data') {
                    omission = surfaceTask.omission?.() || null;
                    surfaceTask = null;
                    phase = 'done';
                    return 'no-data';
                }
                surfaceMesh = appendRoadRingSurface(
                    ctx,
                    surfaceTask.geometry(),
                    surfaceTask.footprint(),
                );
                surfaceTask = null;
                phase = surfaceMesh && hasRetainingProfile
                    ? 'collar'
                    : surfaceMesh && ctx.hasTerrainSeam
                        ? 'terrain-seam'
                        : 'done';
                if (surfaceMesh && ctx.terrainCutoutRequired) {
                    afterFootprint = phase; phase = 'terrain-cut-boundary';
                    footprintSteps = createReceiverFootprintSteps({
                        positions: surfaceMesh.geometry.getAttribute('position').array,
                        indices: surfaceMesh.geometry.index?.array || null,
                        ...GROUND_GENERATION_LIMITS.roadFootprint,
                        // Use the feature's captured regional validity, just
                        // like its top geometry. An unrelated distant source
                        // update must not cancel this immutable boundary.
                        isCurrent,
                    });
                }
                return phase === 'done' ? 'done' : 'more';
            }
            if (phase === 'terrain-cut-boundary') {
                const next = footprintSteps.next();
                if (!next.done) return 'more';
                surfaceMesh.userData.terrainCutoutRegions = next.value.regions;
                surfaceMesh.userData.terrainCutoutPrecision = { maxFoldWidthM: next.value.maxFoldWidthM,
                    maxHeightDifferenceM: next.value.maxHeightDifferenceM, collapsedFaces: next.value.collapsedFaces };
                footprintSteps = null; phase = afterFootprint;
                return phase === 'done' ? 'done' : 'more';
            }
            if (phase === 'collar') {
                appendRoadRingCollar(ctx, ringIndex);
                phase = 'wall';
                return 'more';
            }
            if (phase === 'wall') {
                appendRoadRingWall(ctx, ringIndex);
                phase = surfaceMesh && ctx.hasTerrainSeam ? 'terrain-seam' : 'done';
                return phase === 'done' ? 'done' : 'more';
            }
            if (phase === 'terrain-seam') {
                const status = appendRoadRingTerrainSeam(ctx, surfaceMesh?.geometry);
                if (status === 'defer') return 'defer';
                phase = 'done';
            }
            return 'done';
        },
        dispose() { footprintSteps?.return(); footprintSteps = null; surfaceTask?.dispose(); },
        omission: () => omission,
        phaseLabel: () => phase === 'surface' && surfaceTask
            ? `surface:${surfaceTask.phaseLabel()}`
            : phase,
    };
}

// Stone-paved pedestrian zones get the narrow flat edging band along their
// boundary, same as lawns and landuse paving — the seam against sidewalks and
// roadbeds otherwise reads as a raw texture edge. Band segments that fall INSIDE
// a sibling pedestrian polygon are dropped: zones arrive as overlapping per-way
// buffers, and without the filter their internal borders draw phantom curbs
// mid-square.
function appendPedestrianEdging(ctx) {
    const { type, rings, osm_id, tileKey, featureGroup } = ctx;
    const terrainReference = ctx.ground.terrain;
    if (type !== 'pedestrian') return true;
    let terminalTerrainNoData = false;
    const edging = buildSurfaceEdgingMesh(
        ringsToLocalEdgingRings(rings),
        PEDESTRIAN_EDGING_Y,
        (mx, mz) => !pointInsideSiblingPedestrianZone(mx, mz, osm_id, ctx.pedestrianRings),
        terrainReference
            ? (x, z) => {
                const groundY = terrainReference.evidenceSceneYAtLocal(x, z);
                if (finiteOrNull(groundY) === null && isPermanentTerrainGap(ctx.ground, x, z)) {
                    terminalTerrainNoData = true;
                }
                return groundY;
            }
            : null,
    );
    if (edging === false) {
        // The paved surface is already complete. A missing terrain cell may
        // still arrive, but NoData in its loaded owner never will; omit only
        // this detached decorative band instead of pinning the whole road tile.
        return terminalTerrainNoData;
    }
    if (edging) {
        if (tileKey != null) edging.userData.tileKey = tileKey;
        featureGroup.add(edging);
    }
    return true;
}

// A managed generation owns complete canonical source ways, including their
// centered cycle paint. It does not rely on the old asynchronous tile-wide
// bicycle builder, which cannot publish inside the receiver transaction.
function* roadBikeQuadsSteps(ctx) {
    const bands = resolveBikeLaneBands(ctx.feature.properties || {})
        .filter(band => groundManaged || band.side !== 'center');
    if (!bands.length) return [];
    const geometry = ctx.feature.properties?.centerline_geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    const quads = [], maxQuads = 7 * 2048;
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const width = Number(ctx.feature.properties?.width_meters) || 6;
    const center = bands.find(band => band.side === 'center');
    const sides = bands.filter(band => band.side !== 'center');
    let sourcePoints = 0;
    for (const line of lines) {
        const points = [];
        for (const [lon, lat] of line) {
            if (++sourcePoints > 2048) throw groundPaintCapacity('Cycle centerline point capacity exceeded');
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new TypeError('Cycle centerline requires finite coordinates');
            points.push({ x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
                z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M });
            if (sourcePoints % 128 === 0) yield { phase: 'road-cycle-centerline' };
        }
        let stations = points.length;
        const maxSegmentM = center && ctx.followsVerticalAlignment ? ROAD_VERTICAL_BIKE_MAX_SEGMENT_M : null;
        if (maxSegmentM && points.length > 1) {
            stations = 1;
            for (let i = 1; i < points.length; i++) stations += Math.max(1,
                Math.ceil(Math.hypot(points[i].x - points[i-1].x, points[i].z - points[i-1].z) / maxSegmentM));
        }
        // The existing smoothing/miter operations are synchronous. Bound their
        // input and worst-case expansion before calling them, including bridges
        // with only two source points but thousands of metres between them.
        const expansion = count => count < 2 ? 0 : count < 3 ? 1 : count * 4 - 1;
        if (stations > 2048 || quads.length + expansion(points.length) * sides.length
            + (center ? expansion(stations) : 0) > maxQuads) throw groundPaintCapacity('Cycle ribbon capacity exceeded');
        const append = function* (ribbons) {
            for (const quad of ribbons) {
                quads.push(quad);
                if (quads.length % 32 === 0) yield { phase: 'road-cycle-quads' };
            }
        };
        if (sides.length) yield* append(buildBikeLaneQuads(points, sides, width));
        if (center) yield* append(buildCenteredBikeLaneQuads(points, points.map(() => center.widthM), { maxSegmentM }));
    }
    return quads;
}

// Ordinary cycle colour shares the road owner's transaction and paints its
// existing receiver. No extra height sampling, draped quads or collider parts.
function* createRoadBikePaintSteps(ctx) {
    const quads = yield* roadBikeQuadsSteps(ctx);
    const style = roadGroundPaintStyle('bike-paint');
    return yield* createGroundBikePaintRecordsSteps({ quads,
        identity: roadFeatureIdentities.identityFor(ctx.feature, { tileKey: ctx.tileKey }),
        receiver: groundPaint.receiver, claim: reviseSurfaceClaim(ctx.surfaceClaim, { surfaceClass: SURFACE_CLASS.CYCLEWAY }),
        materialKey: style.key, materialRevision: style.revision });
}

// A carried or otherwise ineligible path still needs paint on its physical
// deck. Batch the ribbons and retain cooperative height/profile sampling.
function* createRoadBikeGeometrySteps(ctx) {
    const quads = yield* roadBikeQuadsSteps(ctx);
    if (!quads.length) return;
    const centered = resolveBikeLaneBands(ctx.feature.properties || {}).some(band => band.side === 'center');
    const task = createBikeLaneGeometryTask(quads, ctx.osm_id,
        centered ? getRoadSurfaceY('cycleway', null) : ctx.y,
        { terrainDraped: centered && SIDEWALK_LEVEL_TYPES.has(ctx.type), ground: ctx.ground });
    let transferred = false;
    try {
        for (;;) {
            const status = task.step();
            if (status !== 'more' && status !== 'defer') break;
            yield { phase: 'road-cycle-profile', deferFrame: status === 'defer' };
        }
        const geometry = task.geometry();
        if (!geometry) throw new Error('Cycle ribbon did not produce its required deck geometry');
        const lane = new THREE.Mesh(geometry, getBikePaintMaterial(ctx.surfaceClaim));
        lane.name = 'RoadSurface:bike-lane';
        lane.userData.surfaceType = 'cycleway';
        markSurfaceClaim(lane, reviseSurfaceClaim(ctx.surfaceClaim, {
            surfaceClass: SURFACE_CLASS.CYCLEWAY, coverageState: SURFACE_COVERAGE_STATE.BUILDING,
            supportReady: false, cutsBackstop: false,
        }));
        lane.renderOrder = SURFACE_RENDER_ORDER.CYCLEWAY;
        lane.receiveShadow = true;
        if (ctx.tileKey != null) lane.userData.tileKey = ctx.tileKey;
        ctx.featureGroup.add(lane); transferred = true;
    } finally { if (!transferred) task.dispose(); }
}

function finishRoadFeature(ctx) {
    const { featureGroup, tRoadTotal } = ctx;
    if (featureGroup.children.length === 0 && !featureGroup.userData.groundPaintRecords) return null;
    if (startupTrace.enabled) roadBuildProfile.roads += 1;
    profAdd('ms_total', tRoadTotal);
    return featureGroup;
}

// Pedestrian paving sits below the paver trackbed strip (0.075); its edging
// band sits just above the pedestrian surface.
const PEDESTRIAN_SURFACE_Y = GROUND_SURFACE_LEVELS.pedestrian;
const PEDESTRIAN_EDGING_Y = GROUND_SURFACE_LEVELS.pedestrianEdging;
const PEDESTRIAN_EDGING_MIN_AREA_M2 = 25;

// Registry of every loaded pedestrian zone's outer ring (local coords +
// bbox), so edging can detect segments buried inside a sibling zone. Keyed
// by tileKey and kept in lockstep with tileFeatures.
let pedestrianRings = new Map();

function createCenteredBikePaintBatchTask(batch, surfaceY, group, ground) {
    let phase = 'chains';
    let chains = null;
    let chainIndex = 0;
    const batchQuads = [];
    let geometryTask = null;

    return {
        dispose: () => geometryTask?.dispose(),
        phaseLabel() {
            if (phase === 'quads') {
                return `quads ${chainIndex}/${chains.length}`;
            }
            if (phase === 'geometry') return geometryTask.phaseLabel();
            return phase;
        },
        step() {
            if (phase === 'chains') {
                chains = buildChainsFromSegments(batch.segments);
                phase = 'quads';
                return 'more';
            }
            if (phase === 'quads') {
                if (chainIndex < chains.length) {
                    const chain = chains[chainIndex];
                    const chainQuads = buildCenteredBikeLaneQuads(
                        chain.points,
                        chain.widths,
                        {
                            // OSM bridge paths are commonly one long two-node way.
                            // Profile every short chord or the red strip remains a
                            // flat diagonal while its paved polygon follows the crest.
                            maxSegmentM: batch.osmIds.size === 0
                                ? null
                                : ROAD_VERTICAL_BIKE_MAX_SEGMENT_M,
                        },
                    );
                    for (const quad of chainQuads) batchQuads.push(quad);
                    chainIndex += 1;
                    return 'more';
                }
                if (batchQuads.length === 0) {
                    phase = 'done';
                    return 'done';
                }
                geometryTask = createBikeLaneGeometryTask(
                    batchQuads,
                    Array.from(batch.osmIds),
                    surfaceY,
                    { terrainDraped: batch.terrainDraped, ground },
                );
                phase = 'geometry';
                return 'more';
            }
            if (phase === 'geometry') {
                const status = geometryTask.step();
                if (status === 'more' || status === 'defer') return status;
                const verticalRelation = batch.osmIds.size > 0
                    ? SURFACE_VERTICAL_RELATION.GRADE_SEPARATED
                    : SURFACE_VERTICAL_RELATION.SAME_LEVEL;
                const paintClaim = compileSurfaceClaim({
                    surfaceClass: SURFACE_CLASS.CYCLEWAY,
                    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                    verticalRelation,
                    verticalBand: verticalRelation === SURFACE_VERTICAL_RELATION.SAME_LEVEL
                        ? 'ground'
                        : null,
                    ownerId: `centered-bike:${Array.from(batch.osmIds).join(',') || 'ordinary'}`,
                    sourceId: 'world/roads.js:centered-bike-paint',
                    paintsColor: true,
                    supportReady: false,
                    cutsBackstop: false,
                });
                const lane = new THREE.Mesh(
                    geometryTask.geometry(),
                    getBikePaintMaterial(paintClaim),
                );
                lane.name = 'RoadSurface:bike-lane';
                lane.userData.surfaceType = 'cycleway';
                markSurfaceClaim(lane, reviseSurfaceClaim(paintClaim, {
                    coverageState: SURFACE_COVERAGE_STATE.BUILDING,
                }));
                lane.renderOrder = SURFACE_RENDER_ORDER.CYCLEWAY;
                lane.receiveShadow = true;
                group.add(lane);
                geometryTask = null;
                phase = 'done';
            }
            return 'done';
        },
    };
}

function createCenteredBikePaintBuildTask() {
    const featureTiles = Array.from(tileFeatures.entries());
    const seen = new Set();
    const batchesByKey = new Map();
    const group = new THREE.Group();
    group.name = 'CenteredBikePaint';
    const generation = ++centeredBikePublicationGeneration;
    const publicationTicket = surfacePublications?.begin?.({
        key: CENTERED_BIKE_PUBLICATION_KEY,
        generation,
        parent: roadsGroup,
        retire: (_context, root) => disposeRoadFeatureGroup(root),
    }) || null;
    markInspectionLayer(group, {
        id: 'bike-surfaces',
        label: 'Cycleways and bicycle paint',
        category: 'Transport',
        source: 'world/roads.js · derived centered bicycle lanes',
        order: 112,
    });
    const surfaceY = getRoadSurfaceY('cycleway', null);
    let tileIndex = 0;
    let batches = null;
    let batchIndex = 0;
    let batchTask = null;
    let phase = 'inputs';
    let inputSteps = captureRoadRenderGroundSteps('road-bike-paint');
    let ground = null;
    let roadVerticalAlignmentModel = null;
    let committed = false;

    const batchFor = (key, terrainDraped, osmId = null) => {
        let batch = batchesByKey.get(key);
        if (!batch) {
            batch = {
                osmIds: new Set(),
                segments: [],
                terrainDraped,
            };
            batchesByKey.set(key, batch);
        }
        if (osmId != null) batch.osmIds.add(osmId);
        return batch;
    };

    const collectTile = ([tileKey, features]) => {
        for (const [featureIndex, feature] of (features || []).entries()) {
            const key = roadFeatureKey(feature, tileKey, featureIndex);
            if (seen.has(key)) continue;
            seen.add(key);
            const selected = roadFeatureSources.selected(key);
            const properties = (selected?.feature || feature)?.properties || {};
            if (roadVerticalAlignmentModel?.replacesRoadSurfaceForOsmId(
                properties.osm_id,
            )) continue;
            const band = resolveBikeLaneBands(properties)
                .find((candidate) => candidate.side === 'center');
            if (!band) continue;
            const osmId = properties.osm_id;
            const aligned = osmId != null
                && !!roadVerticalAlignmentModel?.getAlignmentForOsmId(osmId);
            const terrainDraped = SIDEWALK_LEVEL_TYPES.has(
                String(properties.highway_type || ''),
            );
            let batchKey = `ordinary:${selected?.tileKey || tileKey}:${terrainDraped ? 'terrain' : 'formation'}`;
            if (aligned) {
                const owner = roadVerticalAlignmentModel.getProfileOwnerForOsmId(osmId);
                batchKey = `aligned:${owner?.id || `osm-${osmId}`}`
                    + `:${terrainDraped ? 'terrain' : 'formation'}`;
            }
            const batch = batchFor(
                batchKey,
                terrainDraped,
                aligned ? osmId : null,
            );
            for (const points of centerlineLocalPoints(properties.centerline_geometry)) {
                for (let index = 0; index + 1 < points.length; index++) {
                    batch.segments.push({
                        x1: points[index].x,
                        z1: points[index].z,
                        x2: points[index + 1].x,
                        z2: points[index + 1].z,
                        width: band.widthM,
                    });
                }
            }
        }
    };

    return {
        phaseLabel() {
            if (phase === 'collect') {
                return `bike-paint collect ${Math.min(tileIndex + 1, featureTiles.length)}`
                    + `/${featureTiles.length}`;
            }
            if (phase === 'geometry') {
                const prefix = `bike-paint geometry ${Math.min(batchIndex + 1, batches.length)}`
                    + `/${batches.length}`;
                return batchTask ? `${prefix}:${batchTask.phaseLabel()}` : prefix;
            }
            return `bike-paint ${phase}`;
        },
        step() {
            if (ground && !ground.isCurrent()) return 'stale';
            if (phase === 'inputs') {
                const next = inputSteps.next();
                if (!next.done) return 'more';
                ground = next.value;
                if (!ground) { inputSteps = captureRoadRenderGroundSteps('road-bike-paint'); return 'more'; }
                inputSteps = null;
                roadVerticalAlignmentModel = ground.verticalAlignments;
                phase = 'collect';
                return 'more';
            }
            if (phase === 'collect') {
                if (tileIndex < featureTiles.length) {
                    collectTile(featureTiles[tileIndex]);
                    tileIndex += 1;
                    return 'more';
                }
                batches = Array.from(batchesByKey.values());
                phase = 'geometry';
                return 'more';
            }
            if (phase === 'geometry') {
                if (batchIndex < batches.length) {
                    if (!batchTask) {
                        batchTask = createCenteredBikePaintBatchTask(
                            batches[batchIndex],
                            surfaceY,
                            group,
                            ground,
                        );
                        return 'more';
                    }
                    const status = batchTask.step();
                    if (status === 'more' || status === 'defer') return status;
                    batchTask = null;
                    batchIndex += 1;
                    return 'more';
                }
                phase = 'publish';
                return 'more';
            }
            if (phase === 'publish') {
                const previous = centeredBikePaintGroup;
                if (roadsGroup && group.children.length > 0) {
                    group.traverse((child) => {
                        const claim = child.userData?.surfaceClaim;
                        if (!claim) return;
                        markSurfaceClaim(child, reviseSurfaceClaim(claim, {
                            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                            replacementKey: CENTERED_BIKE_PUBLICATION_KEY,
                            generation,
                        }));
                    });
                    if (publicationTicket) {
                        publicationTicket.publish(group, {
                            commit: () => { centeredBikePaintGroup = group; },
                        });
                    } else {
                        roadsGroup.add(group);
                        centeredBikePaintGroup = group;
                        if (previous) disposeRoadFeatureGroup(previous);
                    }
                } else {
                    disposeRoadFeatureGroup(group);
                    if (publicationTicket) {
                        publicationTicket.clear({
                            commit: () => { centeredBikePaintGroup = null; },
                        });
                    } else {
                        centeredBikePaintGroup = null;
                        if (previous) disposeRoadFeatureGroup(previous);
                    }
                }
                committed = true;
                ground.release?.();
                ground = null;
                phase = 'done';
            }
            return 'done';
        },
        cancel() {
            inputSteps?.return?.();
            ground?.release?.();
            ground = null;
            batchTask?.dispose?.();
            if (!committed) {
                publicationTicket?.discard?.('centered-bike-build-cancelled');
                disposeRoadFeatureGroup(group);
            }
        },
    };
}

function enqueueCenteredBikePaintBuild() {
    if (centeredBikePaintJob) centeredBikePaintQueue.cancel(centeredBikePaintJob);
    let task = createCenteredBikePaintBuildTask();
    const job = centeredBikePaintQueue.enqueue([task], item => {
        const status = task.step();
        if (status === 'stale') {
            task.cancel();
            task = createCenteredBikePaintBuildTask();
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (status === 'more') return FRAME_CHUNK_REPEAT_ITEM;
        if (status === 'defer') return FRAME_CHUNK_DEFER_ITEM;
        return undefined;
    }, {
        describeItem: () => task.phaseLabel(),
        onComplete: () => {
            if (centeredBikePaintJob === job) centeredBikePaintJob = null;
        },
        onCancel: () => {
            task.cancel();
            if (centeredBikePaintJob === job) centeredBikePaintJob = null;
        },
        onError: () => {
            task.cancel();
            if (centeredBikePaintJob === job) centeredBikePaintJob = null;
        },
    });
    centeredBikePaintJob = job.cancelled ? null : job;
    return job.promise;
}

function rebuildCenteredBikePaint() {
    if (centeredBikePaintJob) centeredBikePaintQueue.cancel(centeredBikePaintJob);
    let task = createCenteredBikePaintBuildTask();
    let status = task.step();
    while (status === 'more' || status === 'stale') {
        if (status === 'stale') { task.cancel(); task = createCenteredBikePaintBuildTask(); }
        // Proposal-mask rebuilds are an explicit synchronous scene contract.
        status = task.step();
    }
    if (status === 'defer') task.cancel();
}

function publishPedestrianRings(tileKey, entries) {
    if (entries.length > 0) pedestrianRings.set(tileKey, entries);
    else pedestrianRings.delete(tileKey);
}

function pointInLocalRing(x, z, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if ((a.z > z) !== (b.z > z) &&
            x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInsideSiblingPedestrianZone(x, z, selfOsmId, rings) {
    for (const entries of rings.values()) {
        for (const e of entries) {
            if (e.osmId === selfOsmId) continue;
            if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
            if (pointInLocalRing(x, z, e.pts)) return true;
        }
    }
    return false;
}

function ringsToLocalEdgingRings(rings) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    const SCALE_LON = DEG_TO_RAD * EARTH_RADIUS_M * cosLat;
    const SCALE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
    const out = [];
    for (const ring of rings || []) {
        const pts = [];
        for (const [lon, lat] of ring) {
            pts.push({ x: (lon - anchorLon) * SCALE_LON, z: -(lat - anchorLat) * SCALE_LAT });
        }
        // Drop the GeoJSON closing duplicate — the edging walker treats
        // rings as unclosed loops.
        if (pts.length > 1) {
            const a = pts[0], b = pts[pts.length - 1];
            if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6) pts.pop();
        }
        if (pts.length < 3) continue;
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i], q = pts[(i + 1) % pts.length];
            area += p.x * q.z - q.x * p.z;
        }
        if (Math.abs(area / 2) < PEDESTRIAN_EDGING_MIN_AREA_M2) continue;
        out.push(pts);
    }
    return out;
}

function removeTile(tileKey) {
    if (groundManaged) {
        roadFormationSurfaceTiles.removeTile(tileKey); tileFeatures.delete(tileKey);
        roadFeatureSources.removeTile(tileKey); surfaceAlignmentInputs.removeTile(tileKey);
        pedestrianRings.delete(tileKey); roadSurfaceTiles?.forget(tileKey);
        groundCoordinator.invalidate('roads', { keys: [tileKey], reason: 'source-evicted' });
        return Promise.resolve();
    }
    cancelTileRegistrationJob(tileKey);
    cancelTileBuildJob(tileKey);
    releaseTileRoadReferences(tileKey);
    roadFormationSurfaceTiles.removeTile(tileKey);
    tileFeatures.delete(tileKey);
    const sourceChanges = roadFeatureSources.removeTile(tileKey);
    surfaceAlignmentInputs.removeTile(tileKey);
    pedestrianRings.delete(tileKey);
    if (roadSurfaceTiles) roadSurfaceTiles.forget(tileKey);
    return scheduleChangedRoadSources(sourceChanges);
}

function scheduleChangedRoadSources(changes, includeTileKey = null) {
    const tiles = new Set(includeTileKey == null ? [] : [includeTileKey]);
    for (const change of changes) if (change.next) tiles.add(change.next.tileKey);
    return Promise.all([...tiles].map(key => scheduleSurfaceAlignmentRefresh(key)));
}

function loadedSurfaceFeaturesForVerticalAlignments() {
    return surfaceAlignmentInputs.getFeatures();
}

function rebuildSurfaceVerticalAlignments() {
    if (!roadVerticalAlignmentModel) return null;
    return roadVerticalAlignmentModel.setCenterlineTile(
        SURFACE_ALIGNMENT_SET_KEY,
        roadVerticalCenterlinesFromSurfaceFeatures(
            loadedSurfaceFeaturesForVerticalAlignments(),
            {
                // Size each approach from the actual DGU-relative rise and
                // turn crossing clearances into one absolute deck elevation.
                // Only genuine grid evidence may size an approach; the visual
                // fallback exists solely to keep the world opaque.
                terrainElevationAslMAtCoordinate: ([lon, lat]) => {
                    const sceneY = finiteOrNull(
                        terrainReference.evidenceSceneYAt?.(lon, lat),
                    );
                    return sceneY == null
                        ? null
                        : terrainReference.anchorHeightM + sceneY;
                },
                // Rail keeps sole ownership of its designed profile. The road
                // compiler only samples that immutable route at the paired OSM
                // crossing; it never moves or re-solves the railway.
                railElevationAslMAtCoordinate: (coordinate, { composition }) => (
                    sampleRailFormationElevationAslMAtCoordinate({
                        railFormation: railFormationProvider?.(),
                        coordinate,
                        composition,
                        anchorElevationAslM: terrainReference.anchorHeightM,
                    })
                ),
            },
        ),
    );
}

function resolveSurfaceAlignmentBatchWaiters(batch, buildByTile, dependencies = []) {
    const sharedDependencies = Array.from(dependencies || []);
    const ownedBuilds = new Set();
    for (const [tileKey, waiters] of batch.tileWaiters.entries()) {
        const tileBuild = buildByTile.get(tileKey) || Promise.resolve();
        ownedBuilds.add(tileBuild);
        const build = sharedDependencies.length > 0
            ? Promise.all([tileBuild, ...sharedDependencies]).then(() => undefined)
            : tileBuild;
        for (const { resolve, reject } of waiters) {
            build.then(resolve, reject);
        }
    }
    const builds = Array.from(buildByTile.entries());
    for (const [tileKey, build] of builds) {
        if (ownedBuilds.has(build)) continue;
        build.catch((error) => {
            console.error(
                `[roads] alignment refresh failed for existing surface tile ${tileKey}:`,
                error,
            );
        });
    }
    Promise.allSettled([
        ...builds.map(([_tileKey, build]) => build),
        ...sharedDependencies,
    ])
        .then(() => {
            for (const { resolve } of batch.aggregateWaiters) resolve();
        });
}

function rejectSurfaceAlignmentBatchWaiters(batch, error) {
    for (const waiters of batch.tileWaiters.values()) {
        for (const { reject } of waiters) reject(error);
    }
    for (const { reject } of batch.aggregateWaiters) reject(error);
}

function flushSurfaceAlignmentRefreshBatch(batch) {
    if (surfaceAlignmentRefreshBatch === batch) {
        surfaceAlignmentRefreshBatch = null;
    }
    try {
        const refreshStartedMs = performance.now();
        const alignmentChange = rebuildSurfaceVerticalAlignments();
        const alignmentFinishedMs = performance.now();
        // Compile explicitly so the cost is attributed to the alignment
        // generation instead of hiding inside the first bike-paint height
        // query below.
        roadVerticalAlignmentModel?.getAlignments?.();
        const alignmentCompiledMs = performance.now();
        const bikePaintBuild = enqueueCenteredBikePaintBuild();
        const bikePaintFinishedMs = performance.now();
        const buildByTile = new Map();
        const forceRebuildOsmIds = new Set([
            ...(alignmentChange?.osmIds || []).map(String),
            ...batch.forceRebuildOsmIds,
        ]);
        if (roadFormationModel && alignmentChange?.changed) {
            roadFormationModel.invalidateVerticalAlignments(
                alignmentChange.bounds,
            );
            for (const [tileKey, features] of tileFeatures.entries()) {
                if (!roadTileMatchesAlignmentChange(
                    tileKey,
                    features,
                    alignmentChange,
                )) {
                    continue;
                }
                updateSurfaceFormationTile(tileKey, features);
                buildByTile.set(tileKey, enqueueTileRoads(tileKey, features, {
                    forceRebuildOsmIds,
                }));
            }
        }
        for (const tileKey of batch.tileKeys) {
            const features = tileFeatures.get(tileKey);
            if (!features) continue;
            if (roadFormationModel) {
                updateSurfaceFormationTile(tileKey, features);
                if (buildByTile.has(tileKey)) continue;
                if (!centerlineTileFeatures.has(tileKey)) {
                    // The tile's centreline data has not streamed in yet, so
                    // the rebuild is deferred to that arrival. The force set
                    // must not die with this batch: a later force-less refresh
                    // would retain the stale published geometry verbatim.
                    if (forceRebuildOsmIds.size > 0) {
                        roadForcedRebuildLedger.stash(tileKey, forceRebuildOsmIds);
                    }
                    continue;
                }
            }
            buildByTile.set(tileKey, enqueueTileRoads(tileKey, features, {
                forceRebuildOsmIds,
            }));
        }
        const rebuildsScheduledMs = performance.now();
        recordLayerFrameMs(
            'roads:alignmentRefresh:alignment',
            alignmentFinishedMs - refreshStartedMs,
        );
        recordLayerFrameMs(
            'roads:alignmentRefresh:compile',
            alignmentCompiledMs - alignmentFinishedMs,
        );
        recordLayerFrameMs(
            'roads:alignmentRefresh:bikePaintSchedule',
            bikePaintFinishedMs - alignmentCompiledMs,
        );
        recordLayerFrameMs(
            'roads:alignmentRefresh:schedule',
            rebuildsScheduledMs - bikePaintFinishedMs,
        );
        recordLayerFrameMs(
            'roads:alignmentRefresh',
            rebuildsScheduledMs - refreshStartedMs,
        );
        resolveSurfaceAlignmentBatchWaiters(batch, buildByTile, [bikePaintBuild]);
    } catch (error) {
        rejectSurfaceAlignmentBatchWaiters(batch, error);
    }
}

function scheduleSurfaceAlignmentRefresh(tileKey = null, {
    forceRebuildOsmIds = null,
} = {}) {
    if (groundManaged) {
        groundCoordinator.invalidate('roads', { keys: tileKey == null ? [] : [String(tileKey)],
            reason: 'road-source' });
        return Promise.resolve();
    }
    let batch = surfaceAlignmentRefreshBatch;
    if (!batch) {
        batch = {
            timerId: null,
            tileKeys: new Set(),
            forceRebuildOsmIds: new Set(),
            tileWaiters: new Map(),
            aggregateWaiters: [],
        };
        batch.timerId = setTimeout(
            () => flushSurfaceAlignmentRefreshBatch(batch),
            0,
        );
        surfaceAlignmentRefreshBatch = batch;
    }
    for (const osmId of forceRebuildOsmIds || []) {
        batch.forceRebuildOsmIds.add(String(osmId));
    }
    if (tileKey == null) {
        return new Promise((resolve, reject) => {
            batch.aggregateWaiters.push({ resolve, reject });
        });
    }
    const key = String(tileKey);
    batch.tileKeys.add(key);
    return new Promise((resolve, reject) => {
        let waiters = batch.tileWaiters.get(key);
        if (!waiters) {
            waiters = [];
            batch.tileWaiters.set(key, waiters);
        }
        waiters.push({ resolve, reject });
    });
}

function roadReplacementOsmIdsFromPublicationEvent(event) {
    const roots = [
        event?.root,
        event?.active?.root,
        event?.previous?.root,
    ];
    return new Set(roots.flatMap(roadReplacementOsmIdsFromRoot));
}

function onRoadStructurePublicationChanged(event) {
    if (groundManaged) return;
    if (!isRoadStructurePublicationKey(event?.key)) return;
    const forceRebuildOsmIds = roadReplacementOsmIdsFromPublicationEvent(event);
    if (forceRebuildOsmIds.size === 0) return;
    const affectedTiles = [];
    for (const [tileKey, features] of tileFeatures.entries()) {
        if (!(features || []).some(feature => {
            const osmId = feature?.properties?.osm_id;
            return osmId != null && forceRebuildOsmIds.has(String(osmId));
        })) continue;
        affectedTiles.push(tileKey);
    }
    const builds = affectedTiles.map((tileKey, index) => (
        scheduleSurfaceAlignmentRefresh(tileKey, {
            forceRebuildOsmIds: index === 0 ? forceRebuildOsmIds : null,
        })
    ));
    Promise.allSettled(builds).then((results) => {
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error(
                    '[roads] replacement publication rebuild failed',
                    result.reason,
                );
            }
        }
    });
}

function roadTileIntersectsGroundChange(tileKey, bounds) {
    if (!Array.isArray(bounds) || bounds.length === 0) return true;
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;
    const tileBounds = {
        minX: tx * TILE_M,
        maxX: (tx + 1) * TILE_M,
        minZ: tz * TILE_M,
        maxZ: (tz + 1) * TILE_M,
    };
    return bounds.some(changed => boundsIntersectWithPadding(tileBounds, changed, 20));
}

function civilGroundPedestrianOsmIds(features) {
    const osmIds = new Set();
    for (const feature of features || []) {
        const properties = feature?.properties || {};
        const osmId = properties.osm_id;
        const type = properties.highway_type || properties.railway_type || 'default';
        if (osmId == null
            || (type !== 'pedestrian' && !SIDEWALK_LEVEL_TYPES.has(type))
            || roadSurfaceUsesEngineeredFormation(feature)
            || roadVerticalAlignmentFromProperties(properties)
            || roadVerticalAlignmentModel?.getAlignmentForOsmId(osmId)) {
            continue;
        }
        osmIds.add(String(osmId));
    }
    return osmIds;
}

function enqueueCivilGroundDependencyRefresh(changedBounds) {
    const formation = roadFormationModel;
    if (!formation || changedBounds.length === 0) return;
    const item = {
        phase: 'invalidate',
        invalidation: typeof formation.invalidateComposedGroundSteps === 'function'
            ? formation.invalidateComposedGroundSteps(changedBounds)
            : null,
        affectedOsmIds: null,
        forceRebuildOsmIds: null,
        tileIterator: null,
        affectedTiles: [],
    };
    const job = buildQueue.enqueue([item], (work) => {
        const startedMs = performance.now();
        if (work.phase === 'invalidate') {
            if (!work.invalidation) {
                work.affectedOsmIds = formation.invalidateComposedGround(changedBounds);
            } else {
                const outcome = work.invalidation.next();
                work.phaseDetail = String(outcome.value?.phase || 'commit');
                if (!outcome.done) {
                    recordLayerFrameMs(
                        `roads:civilGround:${work.phaseDetail}`,
                        performance.now() - startedMs,
                    );
                    return FRAME_CHUNK_REPEAT_ITEM;
                }
                work.affectedOsmIds = outcome.value;
                work.invalidation = null;
            }
            work.forceRebuildOsmIds = new Set(
                Array.from(work.affectedOsmIds || [], String),
            );
            work.tileIterator = tileFeatures.entries();
            work.phase = 'tiles';
            recordLayerFrameMs('roads:civilGround:commit', performance.now() - startedMs);
            return FRAME_CHUNK_REPEAT_ITEM;
        }

        if (work.phase === 'tiles') {
            const outcome = work.tileIterator.next();
            if (!outcome.done) {
                const [tileKey, features] = outcome.value;
                if (roadTileIntersectsGroundChange(tileKey, changedBounds)) {
                    const hasAffectedRoad = (features || []).some(feature => {
                        const osmId = feature?.properties?.osm_id;
                        return osmId != null && work.forceRebuildOsmIds.has(String(osmId));
                    });
                    const pedestrianOsmIds = civilGroundPedestrianOsmIds(features);
                    if (hasAffectedRoad || pedestrianOsmIds.size > 0) {
                        for (const osmId of pedestrianOsmIds) {
                            work.forceRebuildOsmIds.add(osmId);
                        }
                        work.affectedTiles.push(tileKey);
                    }
                }
                recordLayerFrameMs('roads:civilGround:tile', performance.now() - startedMs);
                return FRAME_CHUNK_REPEAT_ITEM;
            }
            work.tileIterator = null;
            work.phase = 'schedule';
        }

        const builds = work.affectedTiles.map((tileKey, index) => (
            scheduleSurfaceAlignmentRefresh(tileKey, {
                forceRebuildOsmIds: index === 0 ? work.forceRebuildOsmIds : null,
            })
        ));
        Promise.allSettled(builds).then((results) => {
            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error(
                        '[roads] civil-ground dependency rebuild failed',
                        result.reason,
                    );
                }
            }
        });
        recordLayerFrameMs('roads:civilGround:schedule', performance.now() - startedMs);
        return undefined;
    }, {
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 1,
        priority: Number.MAX_SAFE_INTEGER - 1,
        describeItem: work => `civil-ground ${work.phaseDetail || work.phase}`,
    });
    job.promise.catch(error => {
        console.error('[roads] civil-ground refresh task failed', error);
    });
}

// Keep only the latest read generation; replacement and session teardown
// release its upstream owners before dropping the cache entry.
const roadRailReadSnapshots = new Map();
const roadAlignmentReadSnapshots = new Map();

function clearRoadInputReadSnapshots() {
    for (const cache of [roadRailReadSnapshots, roadAlignmentReadSnapshots]) {
        for (const entry of cache.values()) entry.view.release?.();
        cache.clear();
    }
}

function* captureRoadFormationBuildInputsSteps({
    terrain, civilGround, railFormation, verticalAlignments, authoredPortalReplacements,
    sourcesCurrent, preparedReads = null,
}) {
    if (preparedReads && (!Object.isFrozen(preparedReads)
        || ['terrain', 'railFormation', 'verticalAlignments', 'terrainReplacement'].some(key => !Object.hasOwn(preparedReads, key))
        || !preparedReads.terrain || Object.values(preparedReads).some(read => read && !Object.isFrozen(read)))) {
        throw new TypeError('Road formation requires a complete captured dependency graph');
    }
    const ground = preparedReads ? retainReadSnapshot(preparedReads.terrain, 'road-formation-input')
        : captureGroundReadSnapshot(terrain, 'road-formation-input');
    let rail = null, alignment = null, handedOff = false;
    try {
        const terrainRevision = terrain.revision;
        const civilRevision = civilGround.registrationRevision;
        const terrainReplacement = preparedReads ? preparedReads.terrainReplacement
            : civilGround.captureTerrainReplacementReadSnapshot();
        const railRevision = railFormation?.revision;
        const railMutation = railFormation?.civilGroundMutationRevision || 0;
        // Alignment rows and analytic approaches compile from one captured terrain
        // input. Capture its read view before any subsequent source generation can
        // change which replacement corridor a road is being built against.
        if (!preparedReads) verticalAlignments?.getAlignments();
        const alignmentRevision = verticalAlignments?.revision;
        const portals = (authoredPortalReplacements || []).map(entry => ({
            alignmentId: entry?.alignmentId, replacementBackstopReady: entry?.replacementBackstopReady === true,
            selectionBounds: entry?.selectionBounds ? { ...entry.selectionBounds } : null,
        }));
        const portalKey = JSON.stringify(portals);
        const currentDetails = () => Object.freeze({
            sources: sourcesCurrent(),
            terrain: Object.freeze({ expected: terrainRevision, current: terrain.revision }),
            civil: Object.freeze({ expected: civilRevision, current: civilGround.registrationRevision }),
            rail: Object.freeze({ expected: railRevision, current: railFormation?.revision }),
            railMutation: Object.freeze({ expected: railMutation,
                current: railFormation?.civilGroundMutationRevision || 0 }),
            alignment: Object.freeze({ expected: alignmentRevision,
                current: verticalAlignments?.revision }),
        });
        const detailsCurrent = details => details.sources
            && details.terrain.current === details.terrain.expected
            && details.civil.current === details.civil.expected
            && details.rail.current === details.rail.expected
            && details.railMutation.current === details.railMutation.expected
            && details.alignment.current === details.alignment.expected;
        const isCurrent = () => detailsCurrent(currentDetails());
        if (preparedReads) {
            rail = retainReadSnapshot(preparedReads.railFormation, 'road-formation-rail-input');
            alignment = retainReadSnapshot(preparedReads.verticalAlignments, 'road-formation-alignment-input');
        } else if (railFormation) {
            const cached = roadRailReadSnapshots.get(railFormation);
            if (cached?.revision === railRevision && cached.mutation === railMutation) {
                rail = retainReadSnapshot(cached.view, 'road-formation-rail-input');
            }
            else {
                const view = yield* railFormation.captureReadSnapshotSteps({
                    // The live rail factory captured this callback with its own
                    // compiled generation; substituting current terrain would mix it.
                    baseSceneYAtLocal: railFormation.baseSceneYAtLocal,
                });
                for (const entry of roadRailReadSnapshots.values()) entry.view.release?.();
                roadRailReadSnapshots.clear();
                roadRailReadSnapshots.set(railFormation, { revision: railRevision, mutation: railMutation, view });
                rail = retainReadSnapshot(view, 'road-formation-rail-input');
            }
        }
        if (!preparedReads && verticalAlignments) {
            const cached = roadAlignmentReadSnapshots.get(verticalAlignments);
            if (cached?.revision === alignmentRevision && cached.portalKey === portalKey) {
                alignment = retainReadSnapshot(cached.view, 'road-formation-alignment-input');
            }
            else {
                const view = yield* verticalAlignments.captureReadSnapshotSteps({ authoredPortalReplacements: portals });
                for (const entry of roadAlignmentReadSnapshots.values()) entry.view.release?.();
                roadAlignmentReadSnapshots.clear();
                roadAlignmentReadSnapshots.set(verticalAlignments, { revision: alignmentRevision, portalKey, view });
                alignment = retainReadSnapshot(view, 'road-formation-alignment-input');
            }
        }
        const providers = new Map();
        if (civilGround.hasGroundAuthority(CIVIL_GROUND_AUTHORITY.RAIL)) {
            const sample = (x, z) => rail?.civilGroundSceneYAtLocal(x, z, { surfaceOffsetY: GROUND_SURFACE_LEVELS.tramBed }) ?? null;
            providers.set(CIVIL_GROUND_AUTHORITY.RAIL, { id: 'rail-formation',
                sampleSceneYAtLocal: sample, sampleEvidenceSceneYAtLocal: sample });
        }
        const civil = civilGround.captureReadSnapshot({
            beforeAuthority: CIVIL_GROUND_AUTHORITY.ROAD,
            terrainSceneYAtLocal: (x, z) => ground.sceneYAtLocal(x, z),
            terrainEvidenceSceneYAtLocal: (x, z) => ground.evidenceSceneYAtLocal(x, z), terrainReplacement, providers,
            ...(preparedReads ? { preparedTerrainReplacement: terrainReplacement } : {}),
        });
        const base = (x, z) => civil.inputEvidenceSceneYAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, x, z);
        const inputs = ownReadSnapshot({
            context: Object.freeze({ terrain: ground, terrainReplacement, civilGround: civil,
                railFormation: rail, verticalAlignments: alignment }),
            isCurrent, currentDetails,
            callbacks: {
                baseSceneYAtLocal: base,
                terrainEvidenceSceneYAtLocal: (x, z) => roadProfileTerrainEvidenceYAtLocal({
                    railFormation: rail, groundEvidenceSceneYAtLocal: base, x, z,
                }),
                sourceTerrainInputSceneYAtLocal: (x, z) => civil.inputSceneYOwnedByAtLocal(
                    CIVIL_GROUND_AUTHORITY.ROAD, CIVIL_GROUND_AUTHORITY.TERRAIN, x, z),
                sourceTerrainOwnsInputAtLocal: (x, z) => civil.inputOwnerAuthorityAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, x, z)
                    === CIVIL_GROUND_AUTHORITY.TERRAIN,
                baseTerrainReplacementAtLocal: (x, z) => civil.inputOwnerAuthorityAtLocal(CIVIL_GROUND_AUTHORITY.ROAD, x, z)
                    === CIVIL_GROUND_AUTHORITY.TERRAIN && civil.terrainReplacementOwnsAtLocal(x, z),
                roadYOverrideAtLocal: (x, z, id) => alignment?.roadYAtLocal(x, z, id),
                roadStructureAtLocal: (x, z, id) => alignment?.structureAtLocal(x, z, id),
                roadReplacementAtLocal: (x, z, id) => alignment?.containsReplacementCorridorForOsmId(x, z, id),
                replacementTerrainCutoutRegions: () => alignment?.getReplacementTerrainCutoutRegions() || [],
                formationStyleForOsmId: id => rail?.roadFormationStyleForOsmId(id),
                retainedWallBoundaryForOsmIdAtLocal: (id, x, z, options) => rail?.retainedBoundaryForRoadInterfaceAtLocal(id, x, z, options),
            },
        }, [ground, rail, alignment]);
        handedOff = true;
        return inputs;
    } finally {
        if (!handedOff) {
            ground.release?.(); rail?.release?.(); alignment?.release?.();
        }
    }
}

function onTerrainReferenceChanged(_revision, change) {
    if (groundManaged) return;
    const bounds = Array.isArray(change?.bounds) ? change.bounds : [];
    roadVerticalAlignmentModel?.invalidateTerrain(bounds.length > 0 ? bounds : null);
    // Formation caches contain terrain-derived grades even though their OSM
    // features did not change. Advancing this bounded revision also tells
    // curbs/lane dependants exactly which loaded tiles must replay.
    const affectedOsmIds = roadFormationModel?.invalidateTerrain?.(
        bounds.length > 0 ? bounds : null,
    ) || new Set();
    const forceRebuildOsmIds = new Set(Array.from(affectedOsmIds, String));
    const affectedTiles = [];
    for (const [tileKey, features] of tileFeatures.entries()) {
        if (!roadTileIntersectsGroundChange(tileKey, bounds)) continue;
        affectedTiles.push(tileKey);
        // Ordinary roads sample TerrainReference directly; ordinary paths
        // consume the composed rail->road ground, while an explicit roadside
        // sidewalk consumes its terrain-backed carriageway profile. None is
        // necessarily present in RoadFormationModel's engineered cache, so add
        // them explicitly or a published mesh retains an obsolete elevation.
        for (const osmId of terrainRevisionRoadOsmIds(features, {
            hasVerticalAlignmentForOsmId: id => (
                !!roadVerticalAlignmentModel?.getAlignmentForOsmId(id)
            ),
        })) {
            forceRebuildOsmIds.add(osmId);
        }
    }
    // The scheduler coalesces same-turn tile requests into one batch. Add the
    // completed ID set once instead of copying an ever-growing set for every
    // changed tile.
    const builds = affectedTiles.map((tileKey, index) => (
        scheduleSurfaceAlignmentRefresh(tileKey, {
            forceRebuildOsmIds: index === 0 ? forceRebuildOsmIds : null,
        })
    ));
    Promise.allSettled(builds).then((results) => {
        for (const result of results) {
            if (result.status === 'rejected') {
                console.error('[roads] terrain revision rebuild failed', result.reason);
            }
        }
    });
}

function refreshCivilGroundDependencies() {
    const nextSnapshot = civilGroundReference?.dependencySnapshotBefore?.(
        CIVIL_GROUND_AUTHORITY.ROAD,
    ) || { entries: [], signature: '' };
    const nextSignature = nextSnapshot.signature;
    if (nextSignature === observedCivilGroundSignature) return;
    const changedBounds = changedCivilGroundDependencyBounds(
        observedCivilGroundDependencies,
        nextSnapshot.entries,
    );
    observedCivilGroundDependencies = nextSnapshot.entries;
    observedCivilGroundSignature = nextSignature;
    if (!roadFormationModel || changedBounds.length === 0) return;

    // Rail is an earlier civil-ground authority and starts after roads. Its
    // bounded dependency snapshot changes when a streamed profile first
    // publishes (or genuinely changes height), but deliberately stays stable
    // across irrelevant formation revisions. Re-run the vertical compiler in
    // the same coalesced batch as the affected road tiles so road-under-rail
    // crossings gain canonical rail evidence without a second invalidation
    // mechanism or a whole-world replay.
    // Discovery and tile fan-out are themselves bounded queue work. The old
    // path did both inside onFrame and produced 119 ms roads:civilGround hooks.
    enqueueCivilGroundDependencyRefresh(changedBounds);
}

function roadFeatureFormationGeneration(feature) {
    return roadSurfaceUsesEngineeredFormation(feature)
        ? (roadFormationModel?.getSurfaceGeometryGeneration(feature?.properties?.osm_id) || 0)
        : 0;
}

function refreshPublishedFormationSurfaces() {
    if (!roadFormationModel) return;
    const formation = roadFormationModel;
    const now = performance.now();
    const preparingRevision = formation.revision;
    const mayPrepare = !formationPreparationFailure
        || formationPreparationFailure.model !== formation
        || formationPreparationFailure.revision !== preparingRevision
        || now >= formationPreparationFailure.retryAt;
    if (formation.hasPendingBuild() && !formationPreparationJob && mayPrepare) {
        const job = buildQueue.enqueue([formation], model => (
            model.stepPendingBuildPreparation() === 'more' ? FRAME_CHUNK_REPEAT_ITEM : undefined
        ), {
            maxItemsPerFrame: 1,
            maxItemsPerSettledFrame: 1,
            describeItem: model => model.pendingBuildPreparationPhase(),
            onComplete: () => { if (formationPreparationJob === job) formationPreparationJob = null; },
            onCancel: () => { if (formationPreparationJob === job) formationPreparationJob = null; },
            onError: () => { if (formationPreparationJob === job) formationPreparationJob = null; },
        });
        if (!job.cancelled) formationPreparationJob = job;
        job.promise.catch(error => {
            if (roadFormationModel !== formation) return;
            formationPreparationFailure = { model: formation, revision: preparingRevision,
                retryAt: performance.now() + FORMATION_RETRY_MS };
            console.error('[roads] formation preparation failed', error);
        });
    }
    if (roadFormationModel.surfaceGeometryRevision !== observedFormationGeometryRevision) {
        const change = roadFormationModel.getSurfaceGeometryChangesSince(observedFormationGeometryRevision);
        observedFormationGeometryRevision = change.revision;
        const affectedTiles = change.full ? tileFeatures.keys()
            : roadFormationSurfaceTiles.tileKeysForOsmIds(change.osmIds);
        formationPreparationFailure = null;
        for (const tileKey of affectedTiles) {
            pendingFormationSurfaceTiles.add(tileKey);
            formationSurfaceRetryAt.delete(tileKey);
        }
    }
    // One tile visit/admission per frame. Existing builds validate their captured
    // generation themselves; let them finish instead of cancelling useful work
    // each time another road's junction publishes.
    const tileKey = pendingFormationSurfaceTiles.values().next().value;
    if (tileKey === undefined) return;
    pendingFormationSurfaceTiles.delete(tileKey);
    const features = tileFeatures.get(tileKey);
    if (!features) { formationSurfaceRetryAt.delete(tileKey); return; }
    if (tileBuildJobs.has(tileKey) || tileRegistrationJobs.has(tileKey)
        || now < (formationSurfaceRetryAt.get(tileKey) || 0)) {
        pendingFormationSurfaceTiles.add(tileKey);
        return;
    }
    formationSurfaceRetryAt.delete(tileKey);
    const stale = features.some((feature, index) => {
        if (!roadSurfaceUsesEngineeredFormation(feature)) return false;
        const key = roadFeatureKey(feature, tileKey, index);
        const selected = roadFeatureSources.selected(key);
        return selected && roadEntries.get(key)?.formationGeneration !== roadFeatureFormationGeneration(selected.feature);
    });
    if (stale) enqueueTileRoads(tileKey, features).catch(error => {
        if (roadFormationModel !== formation || !tileFeatures.has(tileKey)) return;
        pendingFormationSurfaceTiles.add(tileKey);
        formationSurfaceRetryAt.set(tileKey, performance.now() + FORMATION_RETRY_MS);
        console.error(`[roads] formation successor failed for ${tileKey}`, error);
    });
}

function cancelSurfaceAlignmentRefresh() {
    const batch = surfaceAlignmentRefreshBatch;
    if (!batch) return;
    clearTimeout(batch.timerId);
    surfaceAlignmentRefreshBatch = null;
    for (const waiters of batch.tileWaiters.values()) {
        for (const { resolve } of waiters) resolve();
    }
    for (const { resolve } of batch.aggregateWaiters) resolve();
}

function disposeRoadEntryIfUnused(featureKey, entry) {
    roadReceiverMutationEpoch++;
    return retireRoadFeatureIfUnused(featureKey, entry, {
        entries: roadEntries, retire: disposePublishedRoadEntry,
    });
}

function releaseTileRoadReferences(tileKey) {
    roadReceiverMutationEpoch++;
    releaseRoadTileReferences(tileKey, {
        entries: roadEntries, tiles: tileRoads, retire: disposePublishedRoadEntry,
    });
}

function clearPublishedRoads() {
    roadReceiverMutationEpoch++;
    for (const entry of roadEntries.values()) disposePublishedRoadEntry(entry);
    roadEntries.clear();
    tileRoads.clear();
    roadFeatureIdentities.clear();
}

function publishRoadFeatureNow(
    feature,
    tileKey,
    featureIndex,
    tileFeatureKeys,
    requiredSurfaceBuckets,
) {
    const identity = roadFeatureIdentities.identityFor(feature, { tileKey, featureIndex });
    const featureKey = identity.key;
    if (tileFeatureKeys.has(featureKey)) return;
    roadReceiverMutationEpoch++;
    let entry = roadEntries.get(featureKey);
    if (entry) roadFeatureIdentities.assertCompatible(entry.identity, identity);
    if (!entry) {
        const selected = roadFeatureSources.selected(featureKey);
        const group = buildRoadFeatureGroup(selected?.feature || feature, tileKey);
        if (!group) return;
        const published = publishRoadFeatureGroup(group, featureKey, tileKey);
        entry = {
            ...published,
            identity: selected?.identity || identity,
            sourceFeature: selected?.feature || feature,
            formationGeneration: roadFeatureFormationGeneration(selected?.feature || feature),
            tileRefs: new Set(),
            pendingRefs: 0,
        };
        roadEntries.set(featureKey, entry);
    }
    for (const bucketKey of entry.surfaceBucketKeys || []) {
        if (roadSurfaceBucketsPendingPublication.has(bucketKey)) {
            requiredSurfaceBuckets.add(bucketKey);
        }
    }
    entry.tileRefs.add(tileKey);
    tileFeatureKeys.add(featureKey);
}

function rebuildLoadedTiles() {
    if (groundManaged) {
        groundCoordinator.invalidate('roads', { full: true, reason: 'appearance-changed' });
        return roadEntries.size;
    }
    buildQueue.clear();
    tileBuildJobs.clear();
    if (!roadsGroup) return 0;
    const before = roadEntries.size;
    clearPublishedRoads();
    for (const [tileKey, features] of tileFeatures.entries()) {
        roadSurfaceTiles?.markPending(tileKey);
        const tileFeatureKeys = new Set();
        const requiredSurfaceBuckets = new Set();
        const safeFeatures = Array.isArray(features) ? features : [];
        for (let i = 0; i < safeFeatures.length; i++) {
            publishRoadFeatureNow(
                safeFeatures[i],
                tileKey,
                i,
                tileFeatureKeys,
                requiredSurfaceBuckets,
            );
        }
        tileRoads.set(tileKey, tileFeatureKeys);
        roadSurfaceTiles.awaitBuckets(tileKey, requiredSurfaceBuckets);
    }
    rebuildCenteredBikePaint();
    // Synchronous rebuild path (proposal masks): the caller expects the scene
    // to reflect the new feature set when this returns, not a settle later.
    flushRoadAggregatesNow();
    return before;
}

function roadTileMatchesAlignmentChange(tileKey, features, change) {
    if (!change?.changed) return false;
    const changedOsmIds = new Set((change.osmIds || []).map(String));
    if (changedOsmIds.size > 0 && (features || []).some(feature => {
        const osmId = feature?.properties?.osm_id;
        return osmId != null && changedOsmIds.has(String(osmId));
    })) {
        return true;
    }
    if (!Array.isArray(change.bounds) || change.bounds.length === 0) return false;
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;
    const tileBounds = {
        minX: tx * TILE_M,
        maxX: (tx + 1) * TILE_M,
        minZ: tz * TILE_M,
        maxZ: (tz + 1) * TILE_M,
    };
    return change.bounds.some(bounds => boundsIntersectWithPadding(tileBounds, bounds, 20));
}

function updateSurfaceFormationTile(tileKey, features, alignment = roadVerticalAlignmentModel) {
    if (!roadFormationModel) return;
    roadFormationModel.setSurfaceTile(
        tileKey,
        alignment
            ? (features || []).filter(feature => (
                !alignment.replacesRoadSurfaceForOsmId(
                    feature?.properties?.osm_id,
                )
                || alignment.retainsRoadFormationForOsmId(
                    feature?.properties?.osm_id,
                )
            ))
            : features || [],
    );
}

function enqueueRoadTilesForAlignmentChange(change) {
    if (!change?.changed) return Promise.resolve([]);
    roadFormationModel?.invalidateVerticalAlignments(change.bounds);
    const forceRebuildOsmIds = new Set(
        (change.osmIds || []).map(String),
    );
    const builds = [];
    for (const [tileKey, features] of tileFeatures.entries()) {
        if (!roadTileMatchesAlignmentChange(tileKey, features, change)) continue;
        updateSurfaceFormationTile(tileKey, features);
        builds.push(enqueueTileRoads(tileKey, features, {
            forceRebuildOsmIds,
        }));
    }
    return Promise.all(builds);
}

export function rebuildRoadsForProposalMask() {
    return rebuildLoadedTiles();
}

// Test/profiling snapshot for the streaming contract. It intentionally
// exposes counts only; production rendering never calls this hot path.
export function getRoadStreamingDebugState() {
    // Features no longer publish one mesh per surface — the batcher holds their
    // PARTS and the scene holds one merged mesh per bucket. The published part
    // count is the same quantity the old per-mesh traversal measured (parts are
    // extracted 1:1 from the meshes the build produced).
    let publishedSurfaceMeshCount = 0;
    for (const entry of roadEntries.values()) {
        publishedSurfaceMeshCount += entry.surfaceParts || 0;
    }
    return {
        publishedFeatureCount: roadEntries.size,
        publishedSurfaceMeshCount,
        publishedAggregateMeshCount: roadAggregates.size,
        publishedTileCount: tileRoads.size,
        pendingTileBuildCount: tileBuildJobs.size,
        pendingAggregateCount: pendingAssembleBuckets.length + Number(!!activeRoadAssemblyTask),
        failedAggregates: Array.from(roadAggregateFailures, ([bucketKey, failure]) => ({
            bucketKey, attempts: failure.attempts, error: failure.error,
        })),
        pendingFormationTileCount: pendingFormationSurfaceTiles.size,
        formationPreparing: !!formationPreparationJob,
        formationGeometryRevision: roadFormationModel?.surfaceGeometryRevision || 0,
        pendingTileBuilds: Array.from(tileBuildJobs.entries()).map(([tileKey, build]) => ({
            tileKey,
            remainingFeatureCount: Array.from(build.featureTasks.values()).length,
            activeFeatures: Array.from(build.featureTasks.entries()).map(
                ([featureKey, task]) => ({ featureKey, phase: task.phaseLabel() }),
            ),
        })),
        renderedSurfaceAuthority: renderedRoadSurfaces.debugState(),
        groundPaint: groundPaint?.snapshot() || null,
        identityConflicts: roadFeatureSources.conflicts(),
        sourceIndex: roadFeatureSources.debugState(),
        featureRefs: Array.from(roadEntries.entries()).map(([featureKey, entry]) => ({
            featureKey,
            tileRefCount: entry.tileRefs.size,
            pendingRefCount: entry.pendingRefs,
            formationGeneration: entry.formationGeneration,
        })),
    };
}

function cancelTileBuildJob(tileKey) {
    if (tileKey == null) return;
    const build = tileBuildJobs.get(tileKey);
    if (!build) return;
    buildQueue.cancel(build.job);
}

function cancelTileRegistrationJob(tileKey) {
    if (tileKey == null) return;
    const registration = tileRegistrationJobs.get(tileKey);
    if (!registration) return;
    buildQueue.cancel(registration.job);
}

function enqueueRoadTileRegistration(tileKey, features) {
    cancelTileRegistrationJob(tileKey);
    if (groundManaged) roadSurfaceTiles?.markPending(tileKey);
    const safeFeatures = Array.isArray(features) ? features : [];
    const task = createRoadTileRegistrationTask(safeFeatures, {
        anchorLat,
        anchorLon,
        pedestrianMinAreaM2: PEDESTRIAN_EDGING_MIN_AREA_M2,
    });
    const [tileTx, tileTz] = String(tileKey).split('_').map(Number);
    const registration = {
        job: null,
        alignmentBuild: Promise.resolve(),
        sourceRecords: [],
        sourceIndex: 0,
    };
    const settle = () => {
        if (tileRegistrationJobs.get(tileKey) === registration) {
            tileRegistrationJobs.delete(tileKey);
        }
    };
    registration.job = buildQueue.enqueue([task], (item) => {
        // Canonicalization is charged to one existing queue item per feature,
        // not hidden in the final all-features registration commit.
        if (registration.sourceIndex < safeFeatures.length) {
            const featureIndex = registration.sourceIndex++;
            registration.sourceRecords.push(roadFeatureSources.prepare(safeFeatures[featureIndex], { tileKey, featureIndex }));
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.step() === 'more') return FRAME_CHUNK_REPEAT_ITEM;
        const result = item.result();
        // Publish all derived registries in one turn. Readers therefore see
        // either the previous complete tile or this complete replacement,
        // never a half-indexed pedestrian/formation surface.
        tileFeatures.set(tileKey, safeFeatures);
        const sourceChanges = roadFeatureSources.setTile(tileKey, registration.sourceRecords);
        surfaceAlignmentInputs.setTileEntries(tileKey, result.alignmentEntries);
        roadFormationSurfaceTiles.setTileOsmIds(tileKey, result.engineeredOsmIds);
        publishPedestrianRings(tileKey, result.pedestrianEntries);
        registration.alignmentBuild = scheduleChangedRoadSources(sourceChanges, tileKey);
        return undefined;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: settle,
        maxItemsPerFrame: 20,
        describeItem: item => item.phaseLabel(),
        priority: () => roadTileBuildPriority(tileTx, tileTz),
    });
    if (!registration.job.cancelled) tileRegistrationJobs.set(tileKey, registration);
    return registration.job.promise.then(({ cancelled } = {}) => (
        cancelled ? undefined : registration.alignmentBuild
    ));
}

function cleanupStagedTileBuild(build) {
    roadReceiverMutationEpoch++;
    for (const task of build.featureTasks.values()) task.dispose();
    build.featureTasks.clear();
    for (const group of build.stagedGroups.values()) disposeRoadFeatureGroup(group);
    build.stagedGroups.clear();
    for (const featureKey of build.heldFeatureKeys) {
        const entry = roadEntries.get(featureKey);
        if (!entry) continue;
        releaseRoadFeatureBuildHold(entry);
        disposeRoadEntryIfUnused(featureKey, entry);
    }
    build.heldFeatureKeys.clear();
}

function publishStagedTileBuild(build) {
    roadReceiverMutationEpoch++;
    const { tileKey } = build;
    if (!roadsGroup || !tileFeatures.has(tileKey)) {
        cleanupStagedTileBuild(build);
        return false;
    }

    // A different response may have replaced the chosen source while this
    // tile was building. Never let a late completion roll the shared owner
    // back. The caller requeues this tile and keeps its old complete drawing.
    for (const identity of build.identities.values()) {
        if (!roadFeatureSources.isCurrent(identity)) return false;
    }
    for (const [featureKey, input] of build.groundInputs) {
        const source = build.sources.get(featureKey);
        if (input.formationGeneration !== roadFeatureFormationGeneration(source.feature)) return false;
        // A masked/no-data result has no mesh but is still a captured decision.
        // Reject it too if its source changed before the tile can publish.
        if (input.isCurrent?.() === false || (build.stagedGroups.has(featureKey)
            && input.terrainRevision !== (terrainReference?.revision || 0))) return false;
    }

    // A replay/rebuild replaces this tile's reference set only after its full
    // successor is ready, so a render frame can never observe a half tile.
    releaseTileRoadReferences(tileKey);
    const publishedFeatureKeys = new Set();
    const requiredSurfaceBuckets = new Set();

    for (const featureKey of build.heldFeatureKeys) {
        const entry = roadEntries.get(featureKey);
        if (!entry) continue;
        if (!build.retainedFeatureKeys.has(featureKey)) continue;
        entry.tileRefs.add(tileKey);
        publishedFeatureKeys.add(featureKey);
        for (const bucketKey of entry.surfaceBucketKeys || []) {
            if (roadSurfaceBucketsPendingPublication.has(bucketKey)) {
                requiredSurfaceBuckets.add(bucketKey);
            }
        }
    }
    for (const [featureKey, stagedGroup] of build.stagedGroups.entries()) {
        let entry = roadEntries.get(featureKey);
        if (entry) roadFeatureIdentities.assertCompatible(entry.identity, build.identities.get(featureKey));
        if (entry && (build.replacementFeatureKeys.has(featureKey)
            || entry.identity.canonical !== build.identities.get(featureKey).canonical
            || entry.formationGeneration !== build.groundInputs.get(featureKey).formationGeneration)) {
            const tileRefs = new Set(entry.tileRefs);
            const pendingRefs = entry.pendingRefs;
            const regionTileKey = entry.regionTileKey ?? tileKey;
            // Remove and re-add the SAME owner before any aggregate assembly.
            // The currently rendered aggregate remains visible throughout,
            // while its successor stays in the already-visible regional bucket
            // instead of exposing the terrain between two bucket uploads.
            disposePublishedRoadEntry(entry);
            const published = publishRoadFeatureGroup(
                stagedGroup,
                featureKey,
                regionTileKey,
            );
            entry = {
                ...published,
                identity: build.identities.get(featureKey),
                sourceFeature: roadFeatureSources.selected(featureKey)?.feature,
                formationGeneration: build.groundInputs.get(featureKey).formationGeneration,
                tileRefs,
                pendingRefs,
            };
            roadEntries.set(featureKey, entry);
        } else if (entry) {
            disposeRoadFeatureGroup(stagedGroup);
        } else {
            const published = publishRoadFeatureGroup(stagedGroup, featureKey, tileKey);
            entry = {
                ...published,
                identity: build.identities.get(featureKey),
                sourceFeature: roadFeatureSources.selected(featureKey)?.feature,
                formationGeneration: build.groundInputs.get(featureKey).formationGeneration,
                tileRefs: new Set(),
                pendingRefs: 0,
            };
            roadEntries.set(featureKey, entry);
        }
        entry.tileRefs.add(tileKey);
        publishedFeatureKeys.add(featureKey);
        for (const bucketKey of entry.surfaceBucketKeys || []) {
            if (roadSurfaceBucketsPendingPublication.has(bucketKey)) {
                requiredSurfaceBuckets.add(bucketKey);
            }
        }
    }
    build.stagedGroups.clear();
    // Replacement leases outlive releasing the old tile membership and moving
    // the source parts. This also retains the original regional bucket, so an
    // owner cannot draw twice while two different buckets upload on later frames.
    for (const featureKey of build.heldFeatureKeys) {
        const entry = roadEntries.get(featureKey);
        if (!entry) continue;
        releaseRoadFeatureBuildHold(entry);
        disposeRoadEntryIfUnused(featureKey, entry);
    }
    build.heldFeatureKeys.clear();
    tileRoads.set(tileKey, publishedFeatureKeys);
    roadSurfaceTiles.awaitBuckets(tileKey, requiredSurfaceBuckets);
    return true;
}

function enqueueTileRoads(tileKey, features, options) {
    if (groundManaged) return scheduleSurfaceAlignmentRefresh(tileKey);
    cancelTileBuildJob(tileKey);
    roadSurfaceTiles?.markPending(tileKey);
    const safeFeatures = Array.isArray(features) ? features : [];
    // Fold in any outstanding forced-rebuild obligation for this tile. The
    // ledger is settled only when THIS build publishes; a cancelled or errored
    // build leaves the obligation for its successor, so a stale feature can
    // never slip back in through the retain path below.
    const { forceRebuildOsmIds, consumed: consumedForceRebuildOsmIds } = (
        roadForcedRebuildLedger.consume(tileKey, options?.forceRebuildOsmIds)
    );
    // The batch-provided part of the force set has no durable home of its own:
    // when this build is superseded mid-flight, its staged corrected geometry
    // is discarded AND the successor arrives force-less, so the retained old
    // entries would stay stale forever (the floating-footway ribbon). Record
    // which forced ids this tile actually carries so a non-published settle
    // can hand the obligation to the successor via the ledger.
    let tileForcedRebuildOsmIds = null;
    if (forceRebuildOsmIds && forceRebuildOsmIds.size > 0) {
        for (const feature of safeFeatures) {
            const osmId = feature?.properties?.osm_id;
            if (osmId == null || !forceRebuildOsmIds.has(String(osmId))) continue;
            (tileForcedRebuildOsmIds ||= new Set()).add(String(osmId));
        }
    }
    const build = {
        tileKey,
        job: null,
        settled: false,
        featureKeys: new Set(),
        heldFeatureKeys: new Set(),
        retainedFeatureKeys: new Set(),
        stagedGroups: new Map(),
        replacementFeatureKeys: new Set(),
        identities: new Map(),
        // Partially built features, keyed the same way, so a feature interrupted
        // mid-ring resumes on the next visit instead of restarting.
        featureTasks: new Map(),
        sources: new Map(),
        groundInputs: new Map(),
    };
    let retryStaleSource = false;
    const [tileTx, tileTz] = String(tileKey).split('_').map(Number);
    const settle = (publish) => {
        if (build.settled) return;
        build.settled = true;
        try {
            if (publish && !publishStagedTileBuild(build)) {
                publish = false;
                retryStaleSource = tileFeatures.has(tileKey);
            }
            if (publish) {
                roadForcedRebuildLedger.notePublished(tileKey, consumedForceRebuildOsmIds);
                if (initialNearRoadTileKeys.delete(String(tileKey))) {
                    // The spawn tiles are the ground under the camera: assemble
                    // them the moment they publish rather than waiting out the
                    // settle window — at session start the stream never goes
                    // quiet, and the world would open over bare terrain.
                    flushRoadAggregatesNow();
                    if (initialNearRoadTileKeys.size === 0) noteWorldQueueIdle('roads');
                }
            } else {
                cleanupStagedTileBuild(build);
                if (tileForcedRebuildOsmIds) {
                    roadForcedRebuildLedger.stash(tileKey, tileForcedRebuildOsmIds);
                }
            }
        } catch (error) {
            cleanupStagedTileBuild(build);
            if (tileForcedRebuildOsmIds) {
                roadForcedRebuildLedger.stash(tileKey, tileForcedRebuildOsmIds);
            }
            throw error;
        } finally {
            if (tileBuildJobs.get(tileKey) === build) tileBuildJobs.delete(tileKey);
        }
    };
    build.job = buildQueue.enqueue(
        safeFeatures,
        (feature, featureIndex) => {
            const featureKey = roadFeatureKey(feature, tileKey, featureIndex);
            if (build.featureKeys.has(featureKey)) return;
            let selected = build.sources.get(featureKey);
            if (!selected) {
                selected = roadFeatureSources.selected(featureKey);
                if (!selected) return;
                build.sources.set(featureKey, selected);
                build.identities.set(featureKey, selected.identity);
            }
            const { identity } = selected;
            // Resolve the complete model before deciding whether an existing
            // source-identical road can be retained. Its neighbour collar may
            // have changed even though this road's OSM record did not.
            if (roadFormationModel?.hasPendingBuild?.() === true) {
                if (roadFormationModel.stepPendingBuildPreparation() === 'more') return FRAME_CHUNK_REPEAT_ITEM;
            }
            const formationGeneration = roadFeatureFormationGeneration(selected.feature);
            const terrainRevision = terrainReference?.revision || 0;
            const entry = roadEntries.get(featureKey);
            if (entry) roadFeatureIdentities.assertCompatible(entry.identity, identity);
            const osmId = selected.feature?.properties?.osm_id;
            const forceRebuild = osmId != null
                && forceRebuildOsmIds?.has(String(osmId));
            if (entry && !build.heldFeatureKeys.has(featureKey)) {
                roadReceiverMutationEpoch++;
                holdRoadFeatureForBuild(entry);
                build.heldFeatureKeys.add(featureKey);
            }
            if (entry && !forceRebuild && entry.identity.canonical === identity.canonical
                && entry.formationGeneration === formationGeneration) {
                build.featureTasks.get(featureKey)?.dispose();
                build.featureTasks.delete(featureKey);
                build.retainedFeatureKeys.add(featureKey);
                build.groundInputs.set(featureKey, { formationGeneration, terrainRevision });
                build.featureKeys.add(featureKey);
                return;
            }
            if (forceRebuild) build.replacementFeatureKeys.add(featureKey);
            // One stage per visit. A multi-ring feature is resumed on later
            // frames rather than holding the main thread for all of its rings.
            let task = build.featureTasks.get(featureKey);
            const priorInput = build.groundInputs.get(featureKey);
            if (task && (!task.isCurrent() || priorInput.formationGeneration !== formationGeneration || priorInput.terrainRevision !== terrainRevision)) {
                task.dispose();
                task = null;
            }
            if (!task) {
                task = createRoadFeatureTask(selected.feature, tileKey);
                build.featureTasks.set(featureKey, task);
                build.groundInputs.set(featureKey, { formationGeneration, terrainRevision, isCurrent: task.isCurrent });
            }
            const status = task.step();
            if (status === 'more') return FRAME_CHUNK_REPEAT_ITEM;
            if (status === 'defer') return FRAME_CHUNK_DEFER_ITEM;
            build.featureTasks.delete(featureKey);
            const group = status === 'done' ? task.group() : null;
            if (!group) return;
            build.stagedGroups.set(featureKey, group);
            build.featureKeys.add(featureKey);
            return undefined;
        },
        {
            onComplete: () => settle(true),
            onCancel: () => settle(false),
            onError: () => settle(false),
            // The time budget bounds expensive stages; this active-view visit
            // cap also bounds a run of cheap stages and the dependent work
            // they unlock. Once position and camera rotation have settled, the
            // queue may use the whole bounded time slice so recordings and
            // stopped vehicles converge instead of preserving a frozen tail.
            // Scale the active cap by elapsed display time so 30 Hz retains the
            // same per-second throughput as 120 Hz.
            maxItemsPerFrame: 20,
            maxItemsPerSettledFrame: Infinity,
            scaleMaxItemsWithFrameTime: true,
            describeItem: (feature, featureIndex) => {
                const featureKey = roadFeatureKey(feature, tileKey, featureIndex);
                const task = build.featureTasks.get(featureKey);
                if (task) return task.phaseLabel();
                if (roadFormationModel?.hasPendingBuild?.() === true) {
                    return roadFormationModel.pendingBuildPreparationPhase?.()
                        || 'road formation setup';
                }
                const osmId = feature?.properties?.osm_id;
                return osmId == null ? 'road setup' : `road ${osmId} setup`;
            },
            // Re-evaluate against the latest camera tile whenever queues sort:
            // after a fast flight, the stopped observer's tile wins over the
            // stale corridor left behind.
            priority: () => roadTileBuildPriority(tileTx, tileTz),
        }
    );
    if (!build.job.cancelled) tileBuildJobs.set(tileKey, build);
    return build.job.promise.then(result => {
        if (!retryStaleSource || !roadsGroup || !tileFeatures.has(tileKey)) return result;
        const successor = tileBuildJobs.get(tileKey);
        return successor ? successor.job.promise
            : enqueueTileRoads(tileKey, tileFeatures.get(tileKey));
    });
}

export const roadsLayer = {
    groundReady() {
        return !!roadsGroup && !!roadFormationModel && !!roadVerticalAlignmentModel && !roadReceiverGenerationLease
            && !tileBuildJobs.size && !tileRegistrationJobs.size && !activeRoadAssemblyTask
            && !pendingAssembleBuckets.length && !surfaceAlignmentRefreshBatch && !formationPreparationJob
            && !roadPendingBucketOwners.size && !roadCollisionDirtyOwnersByBucket.size;
    },
    groundSourceKeys: function* () {
        const seen = new Set();
        for (const keys of [roadFeatureSources.keys(), roadEntries.keys()]) for (const key of keys) {
            if (!seen.has(key)) { seen.add(key); yield key; }
        }
    },
    manageGroundPublications(coordinator) {
        groundCoordinator = coordinator; groundManaged = true;
        roadFormationModel.managePublications(); roadVerticalAlignmentModel.managePublications();
        // The shared initial-view gate now waits for source delivery and the
        // complete ground publication. Ordinary tile callbacks no longer own
        // publication, so they cannot complete their former four-tile gate.
        initialNearRoadTileKeys.clear();
        noteWorldQueueIdle('roads');
    },
    prepareAlignmentSourcesGroundSteps: prepareRoadAlignmentGroundSourcesSteps,
    prepareFormationGroundSteps: prepareRoadFormationGroundSteps,
    capturePreparedGroundSteps: captureRoadRenderGroundSteps,
    admitGroundGenerationSteps: admitRoadGroundGenerationSteps,
    prepareGroundGenerationSteps: prepareRoadGroundGenerationSteps,
    beginSession(ctx) {
        groundManaged = false; groundCoordinator = ctx.groundCoordinator || null;
        roadReceiverGenerationLease?.cancel();
        captureRoadRenderGround.clear();
        clearRoadInputReadSnapshots();
        const {
            anchorLat: lat,
            anchorLon: lon,
            sharedTileSession,
            terrain,
            locationId,
        } = ctx;
        anchorLat = lat;
        anchorLon = lon;
        surfacePublications = ctx.surfacePublications || null;
        groundPublications = ctx.groundPublications || null;
        groundPhysicsProvider = ctx.getGroundPhysics || null;
        groundPaint = ctx.groundPaint || null;
        surfacePublicationSubscription?.();
        surfacePublicationSubscription = surfacePublications?.subscribe?.(
            onRoadStructurePublicationChanged,
        ) || null;
        terrainReference = ctx.terrainSource || terrain || null;
        civilGroundReference = ctx.civilGround || null;
        if (terrainReference && !civilGroundReference) {
            throw new Error('Roads require the session civil-ground composition');
        }
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(
            onTerrainReferenceChanged,
        ) || null;
        // Structure evidence remains a dynamic query because an upper rail
        // viaduct can invalidate DGU samples for a lower road. Ground height
        // itself comes only through the semantic composition below.
        railFormationProvider = () => ctx.railFormation || null;
        observedCivilGroundDependencies = [];
        observedCivilGroundSignature = '';
        const terrainEvidenceYAtLocal = (x, z) => (
            typeof terrainReference?.evidenceSceneYAtLocal === 'function'
                ? terrainReference.evidenceSceneYAtLocal(x, z)
                : null
        );
        roadVerticalAlignmentModel = terrainReference
            ? new RoadVerticalAlignmentModel({
                anchorLat,
                anchorLon,
                locationId,
                terrainSceneYAtLocal: terrainEvidenceYAtLocal,
                captureTerrainSnapshot: () => captureGroundReadSnapshot(terrainReference, 'road-alignment-build'),
                absoluteToSceneY: (heightM) => terrainReference.absoluteToSceneY(heightM),
                anchorElevationAslM: terrainReference.anchorHeightM,
                authoredPortalReplacements: () => (
                    ctx?.authoredRoadPortalReplacements || []
                ),
            })
            : null;
        const roadInputGroundYAtLocal = (x, z) => (
            civilGroundReference?.inputSceneYAtLocal(
                CIVIL_GROUND_AUTHORITY.ROAD,
                x,
                z,
            )
        );
        const roadInputGroundEvidenceYAtLocal = (x, z) => (
            civilGroundReference?.inputEvidenceSceneYAtLocal(
                CIVIL_GROUND_AUTHORITY.ROAD,
                x,
                z,
            )
        );
        roadFormationModel = terrainReference
            ? new RoadFormationModel({
                featureIdentities: roadFeatureIdentities,
                captureBuildInputsSteps: () => {
                    const sourceTerrain = terrainReference, sourceRail = railFormationProvider?.();
                    const sourceAlignment = roadVerticalAlignmentModel, sourceCivil = civilGroundReference;
                    const sourcePortals = ctx.authoredRoadPortalReplacements || [];
                    return captureRoadFormationBuildInputsSteps({ terrain: sourceTerrain,
                        civilGround: sourceCivil, railFormation: sourceRail, verticalAlignments: sourceAlignment,
                        authoredPortalReplacements: sourcePortals,
                        sourcesCurrent: () => terrainReference === sourceTerrain
                            && railFormationProvider?.() === sourceRail
                            && roadVerticalAlignmentModel === sourceAlignment && civilGroundReference === sourceCivil
                            && (ctx.authoredRoadPortalReplacements || []).length === sourcePortals.length
                            && (ctx.authoredRoadPortalReplacements || []).every((entry, index) => entry === sourcePortals[index]),
                    });
                },
                anchorLat,
                anchorLon,
                baseSceneYAtLocal: roadInputGroundEvidenceYAtLocal,
                terrainEvidenceSceneYAtLocal: (x, z) => (
                    roadProfileTerrainEvidenceYAtLocal({
                        railFormation: railFormationProvider?.(),
                        groundEvidenceSceneYAtLocal: roadInputGroundEvidenceYAtLocal,
                        x,
                        z,
                    })
                ),
                // The visible DGU mesh and the accumulated civil input are
                // different facts. Asphalt removes the former only where it is
                // still the semantic pre-road owner; an earlier rail formation
                // keeps its ground even when it shares this XZ footprint.
                sourceTerrainInputSceneYAtLocal: (x, z) => (
                    civilGroundReference.inputSceneYOwnedByAtLocal(
                        CIVIL_GROUND_AUTHORITY.ROAD,
                        CIVIL_GROUND_AUTHORITY.TERRAIN,
                        x,
                        z,
                    )
                ),
                sourceTerrainOwnsInputAtLocal: (x, z) => (
                    civilGroundReference.inputOwnerAuthorityAtLocal(
                        CIVIL_GROUND_AUTHORITY.ROAD,
                        x,
                        z,
                    ) === CIVIL_GROUND_AUTHORITY.TERRAIN
                ),
                baseTerrainReplacementAtLocal: (x, z) => (
                    civilGroundReference.inputOwnerAuthorityAtLocal(
                        CIVIL_GROUND_AUTHORITY.ROAD,
                        x,
                        z,
                    ) === CIVIL_GROUND_AUTHORITY.TERRAIN
                    && civilGroundReference.terrainReplacementOwnsAtLocal(x, z)
                ),
                roadYOverrideAtLocal: (x, z, osmId) => (
                    roadVerticalAlignmentModel?.roadYAtLocal(x, z, osmId)
                ),
                roadStructureAtLocal: (x, z, osmId) => (
                    roadVerticalAlignmentModel?.structureAtLocal(x, z, osmId)
                ),
                roadReplacementAtLocal: (x, z, osmId) => (
                    roadVerticalAlignmentModel?.containsReplacementCorridorForOsmId(
                        x,
                        z,
                        osmId,
                    )
                ),
                replacementTerrainCutoutRegions: () => (
                    roadVerticalAlignmentModel?.getReplacementTerrainCutoutRegions() || []
                ),
                formationStyleForOsmId: osmId => (
                    railFormationProvider?.()?.roadFormationStyleForOsmId?.(osmId)
                ),
                retainedWallBoundaryForOsmIdAtLocal: (osmId, x, z, options) => (
                    railFormationProvider?.()
                        ?.retainedBoundaryForRoadInterfaceAtLocal?.(
                            osmId,
                            x,
                            z,
                            options,
                        )
                ),
            })
            : null;
        releaseCivilGroundAuthority?.();
        releaseCivilGroundAuthority = roadFormationModel
            ? civilGroundReference.setGroundAuthority(
                CIVIL_GROUND_AUTHORITY.ROAD,
                {
                    id: 'road-formation',
                    sampleSceneYAtLocal: (x, z) => (
                        roadFormationModel?.civilGroundSceneYAtLocal?.(
                            x,
                            z,
                            {
                                surfaceOffsetYAtProfile: profile => (
                                    roadSurfaceSceneOffset(profile?.highway)
                                ),
                            },
                        )
                    ),
                    sampleEvidenceSceneYAtLocal: (x, z) => (
                        roadFormationModel?.civilGroundSceneYAtLocal?.(
                            x,
                            z,
                            {
                                surfaceOffsetYAtProfile: profile => (
                                    roadSurfaceSceneOffset(profile?.highway)
                                ),
                            },
                        )
                    ),
                },
            )
            : null;
        const initialCivilGroundSnapshot = civilGroundReference
            ?.dependencySnapshotBefore(CIVIL_GROUND_AUTHORITY.ROAD)
            || { entries: [], signature: '' };
        observedCivilGroundDependencies = initialCivilGroundSnapshot.entries;
        observedCivilGroundSignature = initialCivilGroundSnapshot.signature;
        ctx.roadFormation = roadFormationModel;
        ctx.roadVerticalAlignments = roadVerticalAlignmentModel;
        ctx.captureSurfaceBuildGround = captureRoadRenderGroundSteps;
        roadSurfaceTiles?.clear();
        roadSurfaceTiles = createTilePublicationTracker();
        ctx.roadSurfaceTiles = roadSurfaceTiles;
        // Debug handles for console probes (harmless in production).
        if (typeof window !== 'undefined') {
            window.__roadFormationModel = roadFormationModel;
            window.__roadVerticalAlignmentModel = roadVerticalAlignmentModel;
            window.__s3dRoadStreamingState = getRoadStreamingDebugState;
        }
        if (terrainReference && typeof terrainReference.setRoadFormation === 'function') {
            terrainReference.setRoadFormation(roadFormationModel);
            ctx.terrain?.setRoadFormation?.(roadFormationModel);
        }
        if (!roadsGroup) {
            roadsGroup = new THREE.Group();
            roadsGroup.name = 'Roads';
            markInspectionLayer(roadsGroup, {
                id: 'roads-container',
                label: 'Road renderer',
                category: 'Transport',
                source: 'world/roads.js · OSM road polygons',
                order: 100,
                containerOnly: true,
            });
            scene.add(roadsGroup);
        }
        roadEntries = new Map();
        observedFormationGeometryRevision = 0;
        formationPreparationJob = null;
        pendingFormationSurfaceTiles.clear();
        formationSurfaceRetryAt.clear();
        formationPreparationFailure = null;
        roadFeatureIdentities.clear();
        roadFeatureSources.clear();
        renderedRoadSurfaces.clear();
        roadCollisionCandidatesByBucket.clear();
        roadCollisionDirtyOwnersByBucket.clear();
        roadCollisionBucketRevisions.clear();
        publishedRoadSurfaceOwnersByBucket.clear();
        tileRoads = new Map();
        tileFeatures = new Map();
        surfaceAlignmentInputs.clear();
        centerlineTileFeatures = new Map();
        roadForcedRebuildLedger.clear();
        roadFormationSurfaceTiles.clear();
        pedestrianRings = new Map();
        roadAggregateRevision = 0;
        roadAggregateGate = createSettleGate({
            quietFrames: ROAD_AGGREGATE_QUIET_FRAMES,
            maxDeferredFrames: ROAD_AGGREGATE_MAX_DEFERRED_FRAMES,
        });
        roadBuildFocusX = 0;
        roadBuildFocusZ = 0;
        roadSupportFocusX = 0;
        roadSupportFocusZ = 0;
        initialNearRoadTileKeys = initialWorldSupportTileKeys();
        noteWorldQueueActive('roads');
        // Compile the finite road material family while the opaque startup hold
        // is still active. This warms tiny representatives only: real regional
        // road buffers remain on the bounded publication path, where a prior
        // attempt to prewarm them caused a measured 487 ms upload frame.
        startRoadMaterialPrewarm();

        if (roadVerticalAlignmentModel) {
            verticalAlignmentSource = sharedTileSession.getSource({
                key: 'roads:vertical-alignments',
                label: 'road-vertical-alignments',
                url: (bb) => `${getApiBase()}/roads/vertical-alignments?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
                ...NEAR_ROAD_STREAM_OPTIONS,
            });
            verticalAlignmentSubscription = verticalAlignmentSource.subscribe({
                onFetch: (features, tileKey) => {
                    const change = roadVerticalAlignmentModel.setAlignmentTile(
                        tileKey,
                        features || [],
                    );
                    return enqueueRoadTilesForAlignmentChange(change);
                },
                onEvict: (tileKey) => {
                    const change = roadVerticalAlignmentModel.removeAlignmentTile(tileKey);
                    return enqueueRoadTilesForAlignmentChange(change);
                },
            });
            verticalAlignmentSource.ensureAround(0, 0);
        }

        // Binary road tiles. The surface polygons are ~181k coordinate pairs per
        // tile; as GeoJSON that is 4.45 MB and 30-66 ms of JSON.parse on the
        // ANIMATION thread for every tile — the `tile-delivery 64ms×1>50` fat
        // item in the perf overlay. Quantised to 1e-7 degrees (~1.1 cm) the same
        // geometry is 1.45 MB and decodes in ~2 ms. See core/road-tile-binary.js.
        //
        // ?format=bin is additive: an API that does not know it returns GeoJSON,
        // which would decode as garbage — so the decoder checks a magic number
        // and throws rather than drawing a wrong city. The tile then fails and
        // retries like any other failed tile.
        tileSource = sharedTileSession.getSource({
            key: 'roads:cab',
            label: 'roads',
            url: (bb) => `${getApiBase()}/roads/cab?bbox=${bb.west},${bb.south},${bb.east},${bb.north}&format=bin`,
            decodeBody: decodeRoadTile,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        tileSubscription = tileSource.subscribe({
            onFetch: (features, tileKey) => {
                const safeFeatures = features || [];
                // A bridge member and its approach members often fall in
                // adjacent 200 m surface tiles. Compile from the deduplicated
                // loaded set so later tile arrivals can extend one canonical
                // profile instead of leaving the first short bridge immutable.
                // Same-turn tile deliveries share one generation: recompiling
                // and invalidating after every member caused cancellation
                // storms while the canonical axis was still arriving.
                // Rings must be registered BEFORE any feature of the tile
                // builds its edging, or same-tile overlaps escape the filter.
                return enqueueRoadTileRegistration(tileKey, safeFeatures);
            },
            // Road builds are staged transactionally and clean themselves on
            // queue failure. Keep any previously published generation visible
            // while the failed successor backs off and rebuilds.
            onBuildFailure: () => {},
            onEvict: (tileKey) => {
                if (roadFormationModel) roadFormationModel.removeSurfaceTile(tileKey);
                return Promise.all([removeTile(tileKey), scheduleSurfaceAlignmentRefresh()]);
            },
        });
        if (roadFormationModel) {
            centerlineSource = sharedTileSession.getSource({
                key: 'roads:graph',
                label: 'road-formations',
                url: (bb) => `${getApiBase()}/roads?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
                ...NEAR_ROAD_STREAM_OPTIONS,
            });
            centerlineSubscription = centerlineSource.subscribe({
                deliveryLabel: 'road-formations',
                onFetch: (features, tileKey) => {
                    const safeFeatures = features || [];
                    centerlineTileFeatures.set(tileKey, safeFeatures);
                    const sourceChanged = roadFormationModel.setCenterlineTile(tileKey, safeFeatures);
                    if (groundManaged) {
                        if (sourceChanged.changed) groundCoordinator.invalidate('roads', {
                            keys: [String(tileKey)], reason: 'centerline-source' });
                        return;
                    }
                    const arrivedIds = new Set(safeFeatures
                        .map((feature) => feature?.properties?.osm_id)
                        .filter((osmId) => osmId != null)
                        .map(String));
                    const affectedSurfaceTileKeys = new Set();
                    if (tileFeatures.has(tileKey)) affectedSurfaceTileKeys.add(tileKey);
                    const unpublishedArrivedIds = [...arrivedIds].filter(osmId => (
                        roadFormationModel.getSurfaceGeometryGeneration(osmId) === 0
                    ));
                    for (const surfaceTileKey of roadFormationSurfaceTiles
                        .tileKeysForOsmIds(unpublishedArrivedIds)) {
                        affectedSurfaceTileKeys.add(surfaceTileKey);
                    }
                    for (const surfaceTileKey of affectedSurfaceTileKeys) {
                        const surfaces = tileFeatures.get(surfaceTileKey);
                        if (!surfaces) continue;
                        // A SURFACE tile's rebuild failing is not this centerline
                        // tile's fault, and it must not be reported as one.
                        //
                        // These builds belong to other tiles entirely — this
                        // centerline arrival merely triggers them. Retaining this
                        // graph delivery until several road builds settled coupled
                        // one source tile's completion to another queue's backlog.
                        // The roads queue owns build readiness; the graph tile owns
                        // only this bounded data handoff.
                        //
                        // Not suppressed: each failure is logged with the tile
                        // that actually failed, which preserves the attribution
                        // lost when they were collapsed into one rejection.
                        enqueueTileRoads(surfaceTileKey, surfaces).catch((error) => {
                            console.error(
                                '[roads] surface tile build failed after centerline'
                                + ` ${tileKey} arrived — surface tile ${surfaceTileKey}:`,
                                error,
                            );
                        });
                    }
                },
                onEvict: (tileKey) => {
                    centerlineTileFeatures.delete(tileKey);
                    const sourceChanged = roadFormationModel?.removeCenterlineTile(tileKey);
                    if (groundManaged && sourceChanged?.changed) groundCoordinator.invalidate('roads', {
                        keys: [String(tileKey)], reason: 'centerline-source-evicted' });
                },
            });
            centerlineSource.ensureAround(0, 0);
        }
        tileSource.ensureAround(0, 0);
    },
    onFrame(pose, local) {
        let phaseStartedMs = performance.now();
        if (!groundManaged) { refreshPublishedFormationSurfaces(); refreshCivilGroundDependencies(); }
        recordLayerFrameMs('roads:civilGround', performance.now() - phaseStartedMs);
        const streamingFocus = pose?.surfaceStreamingFocus || local;
        const streamingHeadingDeg = finiteOrNull(streamingFocus?.headingDeg)
            ?? pose?.headingDeg;
        roadSupportFocusX = Number.isFinite(local?.x) ? local.x : 0;
        roadSupportFocusZ = Number.isFinite(local?.z) ? local.z : 0;
        roadBuildFocusX = Number.isFinite(streamingFocus?.x)
            ? streamingFocus.x
            : roadSupportFocusX;
        roadBuildFocusZ = Number.isFinite(streamingFocus?.z)
            ? streamingFocus.z
            : roadSupportFocusZ;
        // onFrame is four calls, yet it has been seen costing 1353 ms of a 1397 ms
        // frame — so the cost is inside ensureAround/ensureAhead, i.e. a frame
        // where the tile source delivers synchronously. Split so a trace says
        // WHICH of the four instead of just "roads".
        const t0 = performance.now();
        const surfacePreload = pose?.surfaceStreamingPreload;
        if (tileSource) {
            ensurePinnedSurfaceCorridor(tileSource, surfacePreload);
            tileSource.ensureAround(local.x, local.z);
            const t1 = performance.now();
            tileSource.ensureAhead(
                roadBuildFocusX,
                roadBuildFocusZ,
                streamingHeadingDeg,
                {
                distanceM: ROAD_AHEAD_PREFETCH_M,
                halfWidthM: ROAD_AHEAD_HALF_WIDTH_M,
                },
            );
            recordLayerFrameMs('roads:surfAround', t1 - t0);
            recordLayerFrameMs('roads:surfAhead', performance.now() - t1);
        }
        const t3 = performance.now();
        if (centerlineSource) {
            ensurePinnedSurfaceCorridor(centerlineSource, surfacePreload);
            centerlineSource.ensureAround(local.x, local.z);
            const t4 = performance.now();
            centerlineSource.ensureAhead(
                roadBuildFocusX,
                roadBuildFocusZ,
                streamingHeadingDeg,
                {
                distanceM: ROAD_AHEAD_PREFETCH_M,
                halfWidthM: ROAD_AHEAD_HALF_WIDTH_M,
                },
            );
            recordLayerFrameMs('roads:ctrAround', t4 - t3);
            recordLayerFrameMs('roads:ctrAhead', performance.now() - t4);
        }
        if (verticalAlignmentSource) {
            ensurePinnedSurfaceCorridor(verticalAlignmentSource, surfacePreload);
            phaseStartedMs = performance.now();
            verticalAlignmentSource.ensureAround(local.x, local.z);
            recordLayerFrameMs('roads:verticalAround', performance.now() - phaseStartedMs);
            phaseStartedMs = performance.now();
            verticalAlignmentSource.ensureAhead(
                roadBuildFocusX,
                roadBuildFocusZ,
                streamingHeadingDeg,
                {
                distanceM: ROAD_AHEAD_PREFETCH_M,
                halfWidthM: ROAD_AHEAD_HALF_WIDTH_M,
                },
            );
            recordLayerFrameMs('roads:verticalAhead', performance.now() - phaseStartedMs);
        }
        phaseStartedMs = performance.now();
        if (!groundManaged) flushRoadAggregatesIfSettled();
        recordLayerFrameMs('roads:aggregateFlush', performance.now() - phaseStartedMs);
    },
    endSession() {
        groundManaged = false; groundCoordinator = null;
        roadReceiverGenerationLease?.cancel();
        captureRoadRenderGround.clear();
        clearRoadInputReadSnapshots();
        surfacePublicationSubscription?.();
        surfacePublicationSubscription = null;
        releaseCivilGroundAuthority?.();
        releaseCivilGroundAuthority = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        if (centerlineSubscription) centerlineSubscription();
        centerlineSubscription = null;
        centerlineSource = null;
        if (verticalAlignmentSubscription) verticalAlignmentSubscription();
        verticalAlignmentSubscription = null;
        verticalAlignmentSource = null;
        cancelSurfaceAlignmentRefresh();
        centeredBikePaintQueue.clear();
        centeredBikePaintJob = null;
        buildQueue.clear();
        if (roadMaterialPrewarmState) {
            settleRoadMaterialPrewarm(roadMaterialPrewarmState);
        }
        tileBuildJobs.clear();
        tileRegistrationJobs.clear();
        roadForcedRebuildLedger.clear();
        initialNearRoadTileKeys.clear();
        clearPublishedRoads();
        if (centeredBikePaintGroup) {
            const retiringBikePaint = centeredBikePaintGroup;
            centeredBikePaintGroup = null;
            if (!surfacePublications?.retire?.(CENTERED_BIKE_PUBLICATION_KEY, {
                root: retiringBikePaint,
                reason: 'roads-layer-ended',
            })) {
                disposeRoadFeatureGroup(retiringBikePaint);
            }
        }
        disposeRoadAggregates();
        groundPaint = null;
        if (roadsGroup) {
            while (roadsGroup.children.length > 0) {
                disposeRoadFeatureGroup(roadsGroup.children[0]);
            }
            if (roadsGroup.parent) roadsGroup.parent.remove(roadsGroup);
            roadsGroup = null;
        }
        roadVerticalAlignmentModel?.dispose();
        roadVerticalAlignmentModel = null;
        for (const material of plannerGeometryMaterials.take()) { unregisterShared(material); material.dispose(); }
        for (const materials of [
            roadMaterials,
            asphaltMaterials,
            stonePavingMaterials,
            concretePathMaterials,
            bikePaintMaterials,
            trackbedMaterials,
            retainingWallMaterials,
            formationTerrainCollarMaterials,
            sidewalkTerrainSeamMaterials,
        ]) {
            for (const material of materials.values()) {
                unregisterShared(material);
                material.dispose();
            }
            materials.clear();
        }
        if (asphaltTexture) {
            unregisterShared(asphaltTexture);
            asphaltTexture.dispose();
            asphaltTexture = null;
        }
        if (stonePavingTexture) {
            unregisterShared(stonePavingTexture);
            stonePavingTexture.dispose();
            stonePavingTexture = null;
        }
        if (trackbedTexture) {
            unregisterShared(trackbedTexture);
            trackbedTexture.dispose();
            trackbedTexture = null;
        }
        if (retainingWallConcreteSurface) {
            for (const texture of Object.values(retainingWallConcreteSurface)) {
                unregisterShared(texture);
                texture.dispose();
            }
            retainingWallConcreteSurface = null;
        }
        roadEntries = new Map();
        roadFeatureIdentities.clear();
        roadFeatureSources.clear();
        renderedRoadSurfaces.clear();
        tileRoads = new Map();
        tileFeatures = new Map();
        surfaceAlignmentInputs.clear();
        centerlineTileFeatures = new Map();
        roadFormationSurfaceTiles.clear();
        pedestrianRings = new Map();
        if (terrainReference && typeof terrainReference.setRoadFormation === 'function') {
            terrainReference.setRoadFormation(null);
        }
        roadSurfaceTiles?.clear();
        roadSurfaceTiles = null;
        roadFormationModel?.dispose();
        roadFormationModel = null;
        formationPreparationJob = null;
        pendingFormationSurfaceTiles.clear();
        formationSurfaceRetryAt.clear();
        formationPreparationFailure = null;
        observedFormationGeometryRevision = 0;
        terrainReference = null;
        civilGroundReference = null;
        railFormationProvider = null;
        observedCivilGroundDependencies = [];
        observedCivilGroundSignature = '';
        surfacePublications = null;
        groundPublications = null;
        groundPhysicsProvider = null;
    },
};
