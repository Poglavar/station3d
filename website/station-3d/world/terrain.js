// Opt-in streamed DGU terrain for the normal OSM TramSim world. It owns only
// the visible bare-earth mesh; TerrainReference is injected into every other
// layer so rails, roads, vehicles, and buildings use the same height basis.

import * as THREE from 'three';
import { logStamp } from '../core/log-stamp.js';
import { createPublishedTerrainReference } from '../core/terrain-publication.js';
import { createTerrainSessionReference } from '../core/terrain-session-reference.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { selectTerrainGroundScopeSteps } from '../core/terrain-ground-scope.js';
import {
    resolveTerrainSessionPolicy,
    terrainRequested,
} from '../core/terrain-request.js';
import { createRenderPacketUploadTask } from '../core/render-packet-three.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { resolveTerrainDetailConfig } from '../core/terrain-detail-config.js';
import {
    TERRAIN_PACKET_COMPILER_ID,
    TERRAIN_PACKET_COMPILER_VERSION,
} from '../core/compilers/terrain-render-contract.js';
import {
    captureTerrainReadSnapshot,
    serializeTerrainSnapshotSteps,
    terrainSnapshotTransferables,
} from '../core/terrain-snapshot.js';
import {
    planTerrainDetailRefresh,
    planDetailEvidenceGate,
    detailEvidenceGateAllowanceMs,
    planTerrainDetailChange,
    sampledTerrainTileSurfaceSignature,
    retainTrailingDetailWindows,
    mergePreparedDetails,
} from '../core/terrain-detail-change.js';
import { disposeGroup } from '../core/dispose.js';
import { getApiBase } from '../core/api.js';
import { noteTerrainCoverage } from '../core/coverage-probe.js';
import {
    buildingTileSourceForLocation,
    getLocation,
    refreshRegionalLocation,
} from '../core/locations.js';
import {
    DETAILED_BUILDING_STREAM_OPTIONS,
    tileDistanceSqToPoint,
} from '../core/tile-stream.js';
import {
    decodeTerrainGridApiPayloadSteps,
    fetchTerrainGridApi,
} from '../core/terrain-api-grid.js';
import {
    CompositeTerrainGrid,
    createCompositeTerrainGridBuildIterator,
    MosaicTerrainGrid,
    TerrainGrid,
    TerrainReference,
    terrainGridLocalBounds,
} from '../core/terrain-grid.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
    getFrameChunkWorkMotionState,
} from '../core/frame-chunk-queue.js';
import {
    TERRAIN_GRID_FETCH_RING,
    TERRAIN_GRID_KEEP_RING,
    terrainGridTileDescriptor,
    terrainGridTileIndex,
    terrainGridTileLocalBounds,
    terrainGridTileRingDistance,
    terrainGridTilesAround,
} from '../core/terrain-grid-tiles.js';
import {
    createProjectedBuildingRingCache,
    createUrbanGroundMaskBuildTask,
    normalizeUrbanGroundConfig,
    urbanGroundMaskBuildIsCurrent,
} from '../core/urban-ground.js';
import {
    applyGroundHoleMask,
    groundMesh,
    scene,
    renderer,
    camera,
} from '../scene/setup.js';
import { recordLayerFrameMs } from '../scene/animate.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { applyStreetLampSurfaceLighting } from './streetlamp-lighting.js';
import { GROUND_STENCIL_READER_RENDER_ORDER } from './ground-surface-levels.js';
import { getTerrainSurface } from './terrain-surface.js';
import {
    applyUrbanGroundSurface,
    clearUrbanGroundSurfaceMask,
    setUrbanGroundSurfaceMask,
} from './urban-ground-surface.js';
import {
    resolveDetailTerrainWindowRequest,
    resolveRouteBandTerrainRequests,
} from '../core/terrain-grid-request.js';
import {
    campaignDriveTerrainCorridor,
    campaignDriveTerrainGridDescriptors,
} from '../core/campaign-drive-preload.js';
import {
    noteWorldBuildProgress,
    noteWorldBuildRequestActive,
    noteWorldBuildRequestIdle,
    noteWorldPhase,
} from '../core/world-ready.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { classifyViewPriority } from '../core/view-priority.js';
import {
    FORMATION_MAX_CUTOUT_REACH_M,
    formationTerrainCutoutMaskRegions,
    formationTerrainCutoutMaskRings,
} from '../core/road-formation.js';
import {
    captureFormationMaskInputs,
    formationMaskRevision,
    formationMaskTaskNeedsRestart,
} from '../core/ground-ownership-mask-task.js';
import { bindRenderOriginShader } from '../core/render-origin.js';
import { retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import { buildFormationTerrainCutoutQuerySteps } from '../core/formation-terrain-cutout-query.js';
import { roadStructureMatchesAlignment, roadStructurePublicationKey } from '../core/road-replacement-publication.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import {
    SURFACE_BACKSTOP_CUT_OPERATION,
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    asSurfaceClaim,
    compileSurfaceClaim,
    surfaceGroundOwnershipMaskFill,
    surfaceGroundRemovalChannelsForClaim,
} from '../core/surface-hierarchy.js';

const TILE_M = 400;
// Read by the aerial view's coverage mask, which steps aside for these tiles.
export const TERRAIN_TILE_M = TILE_M;
const TILE_SEGMENTS = 20;
const TERRAIN_GRID_REQUEST_GROUP = 'terrain-grid';
const TERRAIN_GRID_DETAIL_REQUEST_GROUP = 'terrain-grid-detail';
const TERRAIN_GRID_MAX_CONCURRENT_REQUESTS = 2;
const TERRAIN_GRID_MAX_CONCURRENT_DETAIL_REQUESTS = 1;
const TERRAIN_GRID_RETRY_MS = 5000;
const TERRAIN_GRID_PREP_BUDGET_MS = 2;
// The Zagreb chase is only about 1.2 km long, but its deliberately broad
// alternate-street corridor needs ~17.5 M native source cells. That is a level
// load paid once behind the chapter curtain; the ordinary moving window keeps
// the smaller global budget below.
const CAMPAIGN_DRIVE_DETAIL_MAX_CELLS = 20_000_000;

let terrainGridPrepQueue = null;

function terrainGridPrepAbortError(message = 'Terrain grid preparation cancelled') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function resetTerrainGridPrepQueue() {
    terrainGridPrepQueue?.dispose();
    terrainGridPrepQueue = createFrameChunkQueue({
        label: 'terrain-grid-prep',
        frameBudgetMs: TERRAIN_GRID_PREP_BUDGET_MS,
        stationaryReservationMs: TERRAIN_GRID_PREP_BUDGET_MS,
        pauseDuringMovement: false,
        preferAnimationFrame: true,
        trackWorldReady: true,
        workClass: 'near',
        workTier: 'surface',
    });
}

function resolveTerrainGridPrepPriority(priority) {
    const value = typeof priority === 'function' ? priority() : priority;
    return Number(value?.score ?? value) || 0;
}

async function runTerrainGridPrepIterator(iterator, {
    signal = null,
    label = 'terrain-grid-prep',
    priority = 0,
    disposeResult = null,
    maxItemsPerFrame,
} = {}) {
    if (!iterator || typeof iterator.next !== 'function') {
        throw new TypeError('Terrain grid preparation requires an iterator');
    }
    if (signal?.aborted) throw terrainGridPrepAbortError();
    const queue = terrainGridPrepQueue;
    if (!queue) {
        let step = iterator.next();
        while (!step.done) {
            if (step.value?.waiting && step.value.ready) await step.value.ready;
            if (signal?.aborted) { iterator.return?.(); throw terrainGridPrepAbortError(); }
            step = iterator.next();
        }
        return step.value;
    }

    let result;
    let lastPhase = label;
    const job = queue.enqueue([iterator], () => {
        if (signal?.aborted) throw terrainGridPrepAbortError();
        const step = iterator.next();
        if (step.done) {
            result = step.value;
            return undefined;
        }
        lastPhase = String(step.value?.phase || label);
        return FRAME_CHUNK_REPEAT_ITEM;
    }, {
        priority: () => resolveTerrainGridPrepPriority(priority),
        maxItemsPerFrame,
        maxItemsPerSettledFrame: maxItemsPerFrame,
        describeItem: () => `${label}:${lastPhase}`,
        onCancel: () => iterator.return?.(),
    });
    const abort = () => queue.cancel(job);
    signal?.addEventListener?.('abort', abort, { once: true });
    try {
        const outcome = await job.promise;
        if (outcome.cancelled || signal?.aborted) {
            // A queue can finish and transfer a detached root just before an
            // abort in the same turn. The caller will not receive that result.
            disposeResult?.(result);
            throw terrainGridPrepAbortError();
        }
        return result;
    } finally {
        signal?.removeEventListener?.('abort', abort);
    }
}

function decodeTerrainGridPayloadQueued(payload, {
    signal = null,
    label = 'terrain-grid',
    priority = 0,
} = {}) {
    return runTerrainGridPrepIterator(
        decodeTerrainGridApiPayloadSteps(payload),
        { signal, label: `${label}:decode`, priority },
    );
}

async function fetchTrackedTerrainGridApi(key, apiBase, request, {
    requestScheduler = null,
    requestPriority = null,
    requestGroupKey = TERRAIN_GRID_REQUEST_GROUP,
    requestGroupLimit = TERRAIN_GRID_MAX_CONCURRENT_REQUESTS,
    supportLane = false,
    ...options
} = {}) {
    noteWorldBuildRequestActive(key);
    try {
        const run = () => fetchTerrainGridApi(apiBase, request, {
            ...options,
            decodePayload: payload => decodeTerrainGridPayloadQueued(payload, {
                signal: options.signal,
                label: key,
                priority: requestPriority,
            }),
        });
        if (typeof requestScheduler?.scheduleNetworkRequest === 'function') {
            return await requestScheduler.scheduleNetworkRequest({
                label: key,
                groupKey: requestGroupKey,
                groupLimit: requestGroupLimit,
                supportLane,
                priority: requestPriority,
                signal: options.signal,
                run,
            });
        }
        return await run();
    } finally {
        noteWorldBuildRequestIdle(key);
    }
}

// Legacy shipped grid: metadata JSON + binary .bin (Split still uses this).
async function fetchStaticGrid(config, signal) {
    const [metaResp, dataResp] = await Promise.all([
        fetch(config.metadataUrl, { signal }),
        fetch(config.dataUrl, { signal }),
    ]);
    if (!metaResp.ok) throw new Error(`terrain metadata HTTP ${metaResp.status}`);
    if (!dataResp.ok) throw new Error(`terrain binary HTTP ${dataResp.status}`);
    const [metadata, arrayBuffer] = await Promise.all([metaResp.json(), dataResp.arrayBuffer()]);
    return { metadata, arrayBuffer };
}

// Most of Croatia has no LiDAR in the database: 'best-available' silently
// falls back to the 20 m DTM there, and a native-resolution (≈0.9 m) window
// over a 20 m source is ~600× redundant bytes describing the exact bilinear
// surface the base grid already delivered — measured at 44 MB decoded of an
// 83 MB Zagreb world open. One tiny coarse probe of the anchor window asks
// which sources actually cover this area before any fine window is paid for.
// Explicit (non-composite) detail sources skip the probe: the location config
// asserted the source, and a missing one already fails per-chunk, non-fatally.
// The probe is per-anchor: a corridor that reaches remote LiDAR terrain while
// the anchor sits on DTM-only ground stays on the 20 m surface — the same
// heights, coarser lattice.
async function detailSourceHasFineData(ctx, config, signal) {
    const source = String(config.detail.source || config.source || 'best-available');
    if (source !== 'best-available') return true;
    const probe = resolveDetailTerrainWindowRequest(ctx, {
        halfSizeM: config.detail.halfSizeM || 600,
        elevationSource: source,
        resolutionDeg: 0.0002,
    });
    try {
        const payload = await fetchTrackedTerrainGridApi(
            'terrain-grid-detail-probe',
            getApiBase(),
            probe,
            {
                signal,
                requestScheduler: ctx.sharedTileSession,
                requestGroupKey: TERRAIN_GRID_DETAIL_REQUEST_GROUP,
                requestGroupLimit: TERRAIN_GRID_MAX_CONCURRENT_DETAIL_REQUESTS,
                requestPriority: { tier: 'support', score: 4e12 },
            },
        );
        const counts = payload?.metadata?.statistics?.sourceCellCounts;
        // Metadata absent: an older API build — keep the historical behaviour.
        if (!Array.isArray(counts)) return true;
        return counts.some((entry) => entry
            && entry.key !== 'dgu-dtm-20m'
            && Number(entry.count) > 0);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // Probe failed the way any detail chunk may fail: base grid covers it.
        return false;
    }
}

// Ordinary sessions use a camera-centred native-resolution window. A bounded
// campaign drive instead pays for its complete authored band at the chapter
// curtain and pins that terrain generation for the level. Failures are
// non-fatal because the already-fetched base mosaic remains authoritative; the
// campaign still pins it rather than replacing it underneath the vehicle.
async function fetchDetailGrids(ctx, config, signal) {
    if (!(await detailSourceHasFineData(ctx, config, signal))) {
        console.log(logStamp(), '[terrain] no fine-resolution source under the anchor; '
            + 'the base grid already carries this surface — skipping detail window and route band');
        return [];
    }
    const source = config.detail.source || config.source;
    const requests = [];
    const drivePlan = ctx?.campaignDriveSurfacePreload || null;
    const driveCorridor = campaignDriveTerrainCorridor(drivePlan);
    if (driveCorridor) {
        const band = resolveRouteBandTerrainRequests({
            ...ctx,
            // A road escape is terrain input only. Do not leak it into the
            // rail corridor collection shared by the other world layers.
            customTrackCorridors: [driveCorridor],
        }, {
            bandHalfM: drivePlan.halfWidthM,
            elevationSource: source,
            maximumTotalCells: CAMPAIGN_DRIVE_DETAIL_MAX_CELLS,
        });
        if (band.requests.length > 0) {
            console.log(logStamp(), 
                `[terrain] requesting final campaign drive band: ${band.requests.length} chunk(s), `
                + `±${Math.round(band.bandHalfM)} m, ~${band.totalCells.toLocaleString()} cells`
                + (band.droppedChunks > 0
                    ? `; ${band.droppedChunks} chunk(s) remain on pinned base terrain`
                    : ''),
            );
            requests.push(...band.requests);
        }
    }
    if (requests.length === 0 && config.detail.halfSizeM) {
        requests.push(resolveDetailTerrainWindowRequest(ctx, {
            halfSizeM: config.detail.halfSizeM,
            elevationSource: source,
        }));
    }
    const payloads = await Promise.all(requests.map(async (request, index) => {
        try {
            return await fetchTrackedTerrainGridApi(`terrain-grid-detail-${index}`, getApiBase(), request, {
                signal,
                requestScheduler: ctx.sharedTileSession,
                requestGroupKey: TERRAIN_GRID_DETAIL_REQUEST_GROUP,
                requestGroupLimit: TERRAIN_GRID_MAX_CONCURRENT_DETAIL_REQUESTS,
                requestPriority: { tier: 'support', score: 4e12 - index },
                onProgress: ({ receivedBytes, totalBytes }) => (
                    noteWorldBuildProgress(`terrain-grid-detail-${index}`, receivedBytes, totalBytes)
                ),
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            console.warn(logStamp(), 
                `[terrain] detail ${request.scope} chunk unavailable; base grid covers it`,
                error,
            );
            return null;
        }
    }));
    return payloads.filter(Boolean);
}

// The fine-surface rect for one detail grid: its footprint in local metres,
// inset past the composite blend band. No tile snapping here — the reference
// treats a tile as fine only when a rect fully covers it, so partial-tile
// slivers simply stay coarse.
function detailSurfaceRect(detailGrid, anchorLon, anchorLat) {
    const metresPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const metresPerDegreeLon = metresPerDegreeLat * Math.cos(anchorLat * DEG_TO_RAD);
    const insetM = 32;
    const rect = {
        minX: (detailGrid.west - anchorLon) * metresPerDegreeLon + insetM,
        maxX: (detailGrid.east - anchorLon) * metresPerDegreeLon - insetM,
        minZ: -(detailGrid.north - anchorLat) * metresPerDegreeLat + insetM,
        maxZ: -(detailGrid.south - anchorLat) * metresPerDegreeLat - insetM,
    };
    if (!(rect.maxX - rect.minX >= TILE_M) || !(rect.maxZ - rect.minZ >= TILE_M)) return null;
    return rect;
}
const FETCH_RING = 3;
const KEEP_RING = 4;
const ROAD_MASK_HALF_SIZE_M = 1600;
const ROAD_MASK_SIZE_PX = 3072;
const ROAD_MASK_REFRESH_MOVE_M = 400;
const ROAD_MASK_REVISION_SETTLE_MS = 80;
const ROAD_MASK_MAX_DEFER_MS = 350;
const ROAD_MASK_BUILD_SLICE_MS = 3;
// One road-mask texel spans just over a metre. Road faces already cover the
// first 0.8 m outside asphalt; paint that owned overlap too so bilinear mask
// filtering cannot leave a narrow DGU fringe drawn over a lower carriageway.
const ROAD_MASK_PAVED_EDGE_OVERLAP_M = 0.8;

let generation = 0;
let reference = null;
let publishedTerrain = null;
let sessionTerrain = null;
let groundCoordinator = null;
let groundManaged = false;
const terrainReceiverCutSignatures = new WeakMap();
let terrainGroup = null;
let terrainMaterial = null;
let terrainExactFormationMaterial = null;
let surfacePublications = null;
let groundPublications = null;
let groundPaint = null;
let renderCompiler = null;
let terrainRenderCompilers = [];
let terrainCompilerReadSnapshot = null;
let terrainCompilerChangeSubscription = null;
let terrainPublicationGeneration = 0;
let terrainUvPerM = 1 / 16;
let previousGroundVisible = true;
let lastTileX = null;
let lastTileZ = null;
const tiles = new Map();
const roadMaskFallbackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
roadMaskFallbackTexture.needsUpdate = true;
const roadMaskUniforms = {
    uRoadFormationMask: { value: roadMaskFallbackTexture },
    uRoadFormationCenter: { value: new THREE.Vector2(0, 0) },
    uRoadFormationHalfSize: { value: 1 },
    uRoadFormationEnabled: { value: 0 },
};

// ─── Ground ownership mask channels ─────────────────────────────────────────
// The mask answers three different questions, one per channel, because civil
// surfaces do not all yield to the same semantic owner at the same pixel.
//
//   R  generic ground is genuinely REPLACED here. Road formations currently
//      publish their covered shell; rail formations publish only measured cut
//      runs, so DGU terrain remains beneath rail fill as a watertight backstop.
//      Explicit tunnel/underpass openings also paint this channel.
//
//   G  engineered rail excavation owns the final civil surface here. A measured
//      formation excavation paints its clipped trench. Ordinary street-running
//      tram is deliberately absent from this kilometre-scale mask: its visible
//      trackbed writes the exact rail-priority stencil footprint instead. Heavy
//      rail contributes only depth-proven DGU intrusions beneath its already
//      published opaque bed. Broad formation ownership alone must not remove
//      another civil surface: the road around an at-grade track remains intact
//      and meets the paver edge through the level-crossing dressing.
//
//   B  a ROAD formation owns the final ground surface here. Rail earthwork
//      dressing asks this narrower question so its sloped/collar triangles can
//      never lie over asphalt where the later road cross-section owns the same
//      plan footprint. Trackbed, rails, and retaining structures do not ask it.
//
let roadMaskTexture = null;
let roadMaskRevision = '';
let roadMaskModels = [];
let roadMaskCenterX = Infinity;
let roadMaskCenterZ = Infinity;
let roadMaskObservedModels = [];
let roadMaskObservedRevision = '';
let roadMaskRevisionChangedAt = 0;
let roadMaskRevisionPendingSince = Infinity;
let roadMaskBuildTask = null;
let roadMaskPublication = null;
let urbanGroundConfig = null;
let urbanBuildingSource = null;
let urbanBuildingSubscription = null;
let urbanBuildingTiles = new Map();
let urbanMaskTexture = null;
let urbanMaskCenterX = Infinity;
let urbanMaskCenterZ = Infinity;
let urbanMaskDirty = false;
let urbanMaskChangedAt = 0;
let urbanMaskSourceRevision = 0;
let urbanMaskPublishedRevision = -1;
let urbanMaskBuildTask = null;
let urbanMaskBuildAttributedMs = 0;
const URBAN_MASK_SETTLE_MS = 60;
const URBAN_MASK_BUILD_SLICE_MS = 2;
const MOVING_DETAIL_REFRESH_M = 420;
// Earlier 1 m windows kept composed behind the player (core/terrain-detail-change.js
// retainTrailingDetailWindows): the tiles they cover stay fine instead of
// falling back to the base and rebuilding every layer on them.
const TRAILING_DETAIL_WINDOWS = 2;
const trailingDetailKeepDistanceM = detailConfig => (
    2 * (Number(detailConfig?.halfSizeM) || 600) + MOVING_DETAIL_REFRESH_M
);
const REGIONAL_STYLE_REFRESH_M = 1000;
let terrainGridStreamState = null;
let terrainSurfaceStyle = null;
let regionalStyleCenterX = Infinity;
let regionalStyleCenterZ = Infinity;

// Whether to render the DGU elevation surface (a `model`-world feature). ON BY
// DEFAULT wherever the active location ships an elevation grid (e.g. Split) —
// a location that HAS terrain is meant to show it, so no flag is needed. The
// sole override is `?elevation`: opt-in locations use 1/true/on, while
// 0/false/off/no disables terrain everywhere. The `photo` world renders
// Google's own mesh, so DGU terrain is always off there.
export function isTerrainRequested(sessionPolicy = null) {
    try {
        const loc = getLocation();
        const params = new URLSearchParams(window.location.search || '');
        const policy = sessionPolicy || resolveTerrainSessionPolicy(params, { location: loc });
        return terrainRequested(params, {
            locationHasTerrain: !!loc.terrain,
            locationOptIn: !!loc.terrainOptIn,
            sessionPolicy: policy,
        });
    } catch (_error) {
        return false;
    }
}

export function getTerrainReference() {
    return sessionTerrain;
}

export function getTerrainGroup() {
    return terrainGroup;
}

// Convenience for layers that keep a flat Y in the model world and need to sit
// on the DGU terrain when it is active: returns the terrain scene-Y at a local
// point, or 0 when there is no terrain (flat model world / photo world) so
// callers can add it unconditionally without changing flat-world behaviour.
export function terrainSceneYAt(localX, localZ) {
    if (!sessionTerrain) return 0;
    const y = Number(sessionTerrain.sceneYAtLocal(localX, localZ));
    return Number.isFinite(y) ? y : 0;
}

// Nullable twin for anything whose placement or shape depends on real DTM
// evidence. The total helper above is intentionally allowed to return the
// visual fallback so the world can never reveal the void; that fallback must
// never become authored geometry or the support datum for a visible actor.
// A session without a terrain authority is the deliberate flat-world datum.
export function terrainEvidenceSceneYAt(localX, localZ) {
    if (!sessionTerrain) return 0;
    const y = sessionTerrain.evidenceSceneYAtLocal(localX, localZ);
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
}

// Declares which mask channels remove this surface, and wires the lookup.
//
// The canonical surface hierarchy decides which ownership-mask facts may
// remove this target. Generic backstops open for complete formations, while a
// civil surface yields only to the other authority's proved excavation. The
// caller cannot choose RGB channels directly.
//
// One material carries ONE answer. A layer needing two must intern two
// materials; sharing one and hoping the uniform sorts it out silently gives
// every mesh whichever answer was registered first.
export function applyGroundOwnership(material, targetClaim) {
    if (!material) return material;
    const claim = asSurfaceClaim(targetClaim);
    const channels = surfaceGroundRemovalChannelsForClaim(claim);
    material.userData ||= {};
    material.userData.surfaceClaim = claim;
    const existing = material.userData.groundRemovalChannels;
    if (existing) {
        if (existing.some((value, index) => value !== channels[index])) {
            console.warn(logStamp(), 
                '[terrain] ground-removal conflict on a shared material',
                material.name || material.type,
                existing,
                '≠',
                channels,
            );
        }
        return material;
    }
    material.userData.groundRemovalChannels = [...channels];
    if (channels.every(value => value === 0)) return material;
    const removalUniform = { value: new THREE.Vector3(...channels) };
    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
        if (typeof previousCompile === 'function') previousCompile.call(material, shader, renderer);
        bindRenderOriginShader(shader);
        Object.assign(shader.uniforms, roadMaskUniforms, { uGroundRemoval: removalUniform });
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vRoadFormationWorldPos;')
            .replace('#include <begin_vertex>', [
                '#include <begin_vertex>',
                'vRoadFormationWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
            ].join('\n'));
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vRoadFormationWorldPos;',
                'uniform sampler2D uRoadFormationMask;',
                'uniform vec2 uRoadFormationCenter;',
                'uniform float uRoadFormationHalfSize;',
                'uniform float uRoadFormationEnabled;',
                'uniform vec3 uGroundRemoval;',
            ].join('\n'))
            .replace('#include <clipping_planes_fragment>', [
                'if (uRoadFormationEnabled > 0.5) {',
                '    vec2 roadFormationAbsoluteXZ = vRoadFormationWorldPos.xz + uRenderOriginXZ;',
                '    vec2 roadUv = (roadFormationAbsoluteXZ - uRoadFormationCenter)',
                '        / (2.0 * uRoadFormationHalfSize) + 0.5;',
                '    if (roadUv.x >= 0.0 && roadUv.x <= 1.0 && roadUv.y >= 0.0 && roadUv.y <= 1.0) {',
                '        vec3 groundFacts = step(vec3(0.5), texture2D(uRoadFormationMask, roadUv).rgb);',
                '        if (dot(groundFacts, uGroundRemoval) > 0.5) discard;',
                '    }',
                '}',
                '#include <clipping_planes_fragment>',
            ].join('\n'));
    };
    material.customProgramCacheKey = () => {
        const base = typeof previousCacheKey === 'function' ? previousCacheKey.call(material) : '';
        return `${base}|ground-ownership-v3`;
    };
    material.needsUpdate = true;
    return material;
}

function clearRoadFormationMask() {
    cancelRoadFormationMaskPublication('terrain-mask-cleared');
    roadMaskBuildTask = null;
    if (roadMaskTexture) roadMaskTexture.dispose();
    roadMaskTexture = null;
    roadMaskUniforms.uRoadFormationMask.value = roadMaskFallbackTexture;
    roadMaskUniforms.uRoadFormationEnabled.value = 0;
    roadMaskRevision = '';
    roadMaskModels = [];
    roadMaskCenterX = Infinity;
    roadMaskCenterZ = Infinity;
    roadMaskObservedModels = [];
    roadMaskObservedRevision = '';
    roadMaskRevisionChangedAt = 0;
    roadMaskRevisionPendingSince = Infinity;
}

// A completed canvas is a private value until the common controller boundary.
// The full ground coordinator can join this entry with its geometry/support
// entries. This adapter does not itself establish replacement readiness.
function prepareRoadFormationMaskPublication(task, inputsCurrent) {
    const texture = task.result();
    if (texture === undefined || !Array.isArray(task.models)
        || typeof inputsCurrent !== 'function') throw new TypeError('Incomplete ground mask candidate');
    if (texture && texture === roadMaskTexture) throw new TypeError('Ground mask candidate must own a detached texture');
    const previous = {
        texture: roadMaskTexture, models: roadMaskModels, revision: roadMaskRevision,
        centerX: roadMaskCenterX, centerZ: roadMaskCenterZ,
        pendingSince: roadMaskRevisionPendingSince,
        uniformTexture: roadMaskUniforms.uRoadFormationMask.value,
        uniformX: roadMaskUniforms.uRoadFormationCenter.value.x,
        uniformZ: roadMaskUniforms.uRoadFormationCenter.value.y,
        halfSize: roadMaskUniforms.uRoadFormationHalfSize.value,
        enabled: roadMaskUniforms.uRoadFormationEnabled.value,
    };
    const ticket = surfacePublications.begin({
        key: 'terrain:ownership-mask', generation: ++terrainPublicationGeneration,
    });
    let status = 'prepared', gpuReady = texture === null;
    const locallyCurrent = () => status === 'prepared' && gpuReady
        && roadMaskTexture === previous.texture && roadMaskModels === previous.models
        && roadMaskRevision === previous.revision;
    const current = () => locallyCurrent() && inputsCurrent();
    const discard = () => {
        if (status !== 'prepared') return false;
        status = 'discarded';
        texture?.dispose();
        return true;
    };
    const entry = {
        ticket, clear: true, isCurrent: current,
        commit() {
            // External graph validity was checked before the first group
            // mutation. Its models/receiver may already have promoted here.
            if (!locallyCurrent()) return false;
            // Register rollback ownership before changing any observable field.
            status = 'committed';
            roadMaskTexture = texture;
            roadMaskModels = task.models;
            roadMaskRevision = task.revision;
            roadMaskCenterX = task.centerX;
            roadMaskCenterZ = task.centerZ;
            roadMaskUniforms.uRoadFormationMask.value = texture || roadMaskFallbackTexture;
            roadMaskUniforms.uRoadFormationCenter.value.set(task.centerX, task.centerZ);
            roadMaskUniforms.uRoadFormationHalfSize.value = ROAD_MASK_HALF_SIZE_M;
            roadMaskUniforms.uRoadFormationEnabled.value = texture ? 1 : 0;
            roadMaskRevisionPendingSince = task.revision === groundOwnershipMaskRevision(activeFormationModels())
                ? Infinity : performance.now();
            return true;
        },
        rollback() {
            if (status !== 'committed') return false;
            roadMaskTexture = previous.texture;
            roadMaskModels = previous.models;
            roadMaskRevision = previous.revision;
            roadMaskCenterX = previous.centerX;
            roadMaskCenterZ = previous.centerZ;
            roadMaskRevisionPendingSince = previous.pendingSince;
            roadMaskUniforms.uRoadFormationMask.value = previous.uniformTexture;
            roadMaskUniforms.uRoadFormationCenter.value.set(previous.uniformX, previous.uniformZ);
            roadMaskUniforms.uRoadFormationHalfSize.value = previous.halfSize;
            roadMaskUniforms.uRoadFormationEnabled.value = previous.enabled;
            status = 'prepared';
            return true;
        },
        discard,
    };
    return {
        entry,
        get state() { return status; },
        *prewarmSteps() {
            if (status !== 'prepared' || !inputsCurrent()) return false;
            if (texture) {
                const started = performance.now();
                try { renderer.initTexture(texture); }
                finally { recordLayerFrameMs('terrain:ownershipMask:upload', performance.now() - started); }
                yield { phase: 'ownership-mask-upload' };
            }
            if (status !== 'prepared' || !inputsCurrent()) return false;
            gpuReady = true;
            return true;
        },
        finalize() {
            if (status !== 'committed') return false;
            status = 'published';
            previous.texture?.dispose();
            return true;
        },
        discard() {
            if (ticket.state === 'pending') ticket.discard('terrain-mask-cancelled');
            return discard();
        },
    };
}

function cancelRoadFormationMaskPublication(reason) {
    const pending = roadMaskPublication;
    if (!pending) return;
    roadMaskPublication = null;
    pending.controller.abort(terrainGridPrepAbortError(reason));
    pending.boundaryTicket?.cancel(reason);
    if (pending.batch?.state === 'staged') pending.batch.discard(reason);
    pending.prepared.discard();
}

function startRoadFormationMaskPublication(task) {
    if (roadMaskPublication) throw new Error('Ground mask publication is already pending');
    const session = generation, source = reference;
    const pending = { task, controller: new AbortController(), prepared: null,
        batch: null, boundaryTicket: null, gpuReady: false, error: null };
    const current = () => roadMaskPublication === pending && generation === session && reference === source
        && sameFormationModels(task.models, activeFormationModels());
    pending.prepared = prepareRoadFormationMaskPublication(task, current);
    roadMaskPublication = pending;
    // The fixed-size upload gets its own existing terrain-queue visit. It is
    // measured separately from canvas drawing and never runs in commit().
    runTerrainGridPrepIterator(pending.prepared.prewarmSteps(), {
        signal: pending.controller.signal, label: 'terrain-ownership-mask-prewarm',
        priority: 1e12, maxItemsPerFrame: 1,
    }).then(ready => {
        if (roadMaskPublication !== pending) return;
        if (!ready) { cancelRoadFormationMaskPublication('terrain-mask-stale'); return; }
        pending.gpuReady = true;
    }, error => {
        if (roadMaskPublication !== pending) return;
        pending.prepared.discard();
        pending.error = error;
        console.error(logStamp(), '[terrain] Ownership mask preparation failed; published mask retained', error);
    });
}

function enqueueRoadFormationMaskPublication() {
    const pending = roadMaskPublication;
    if (!pending || pending.error || !pending.gpuReady || pending.boundaryTicket) return;
    try {
        pending.batch ||= surfacePublications.prepareBatch([pending.prepared.entry]);
        if (pending.batch.state !== 'staged') {
            cancelRoadFormationMaskPublication('terrain-mask-stale');
            return;
        }
        pending.boundaryTicket = groundPublications.enqueue(pending.batch, { onPublished() {
            pending.prepared.finalize();
            if (roadMaskPublication === pending) roadMaskPublication = null;
        } });
        pending.boundaryTicket?.promise.then(result => {
            if (roadMaskPublication !== pending) return;
            cancelRoadFormationMaskPublication(result.status);
        }, error => {
            if (roadMaskPublication !== pending) return;
            pending.prepared.discard();
            pending.error = error;
            console.error(logStamp(), '[terrain] Ownership mask publication failed; published mask retained', error);
        });
    } catch (error) {
        pending.prepared.discard();
        pending.error = error;
        console.error(logStamp(), '[terrain] Ownership mask staging failed; published mask retained', error);
    }
}

function sameFormationModels(left, right) {
    return left.length === right.length && left.every((model, index) => model === right[index]);
}

function activeFormationModels() {
    return [
        reference?.roadFormation,
        reference?.railFormation,
    ].filter((model) => model && (
        typeof model.getSurfaceProfiles === 'function'
        || typeof model.getTerrainSurfaceRegions === 'function'
    ));
}

function groundOwnershipMaskRevision(models) {
    const formationRevision = formationMaskRevision(models);
    const trackbedRevision = Number(
        reference?.renderedRailSurface?.terrainCutoutRevision,
    ) || 0;
    const viaductRevision = Number(
        reference?.renderedRailSurface?.viaductTerrainCutoutRevision,
    ) || 0;
    return `${formationRevision}|trackbed:${trackbedRevision}|viaduct:${viaductRevision}`;
}

// Read-only state for the scene inspector. The shader hook alone only says a
// material *can* sample the ownership mask; these fields say whether a complete
// texture is actually published for the current formation generation.
export function groundOwnershipMaskDiagnostics() {
    const models = activeFormationModels();
    const renderedRailSurface = reference?.renderedRailSurface || null;
    return {
        enabled: roadMaskUniforms.uRoadFormationEnabled.value > 0.5,
        hasTexture: !!roadMaskTexture,
        center: Number.isFinite(roadMaskCenterX) && Number.isFinite(roadMaskCenterZ)
            ? { x: roadMaskCenterX, z: roadMaskCenterZ }
            : null,
        halfSizeM: ROAD_MASK_HALF_SIZE_M,
        publishedRevision: roadMaskRevision || null,
        observedRevision: roadMaskObservedRevision || null,
        activeRevision: groundOwnershipMaskRevision(models) || null,
        buildTask: roadMaskBuildTask ? {
            revision: roadMaskBuildTask.revision,
            center: {
                x: roadMaskBuildTask.centerX,
                z: roadMaskBuildTask.centerZ,
            },
        } : null,
        publication: roadMaskPublication ? {
            revision: roadMaskPublication.task.revision,
            gpuReady: roadMaskPublication.gpuReady,
            waitingForBoundary: !!roadMaskPublication.boundaryTicket,
            error: roadMaskPublication.error ? String(roadMaskPublication.error.message || roadMaskPublication.error) : null,
        } : null,
        models: models.map(model => ({
            authority: model === reference?.roadFormation ? 'road' : 'rail',
            revision: Number(model?.revision) || 0,
            pendingBuild: model?.hasPendingBuild?.() === true,
        })),
        renderedRailSurface: renderedRailSurface ? {
            revision: Number(renderedRailSurface.revision) || 0,
            regionCount: renderedRailSurface.getTerrainSurfaceRegions?.().length || 0,
            terrainCutoutRevision:
                Number(renderedRailSurface.terrainCutoutRevision) || 0,
            terrainCutoutRegionCount:
                renderedRailSurface.getTerrainCutoutRegions?.().length || 0,
            viaductTerrainCutoutRevision:
                Number(renderedRailSurface.viaductTerrainCutoutRevision) || 0,
            viaductTerrainCutoutRegionCount:
                renderedRailSurface.getViaductTerrainCutoutRegions?.().length || 0,
        } : null,
    };
}

// Source-canvas readback for renderer diagnostics, from the published mask
// rather than geometry that may belong to a newer formation generation.
// getImageData returns unpremultiplied RGBA; the GPU upload premultiplies alpha.
// These source bytes are not a direct readback of the shader's RGB samples.
export function groundOwnershipMaskSampleAtLocal(localX, localZ) {
    const x = Number(localX);
    const z = Number(localZ);
    const canvas = roadMaskTexture?.image;
    if (!Number.isFinite(x) || !Number.isFinite(z)
        || !canvas || typeof canvas.getContext !== 'function'
        || !Number.isFinite(roadMaskCenterX) || !Number.isFinite(roadMaskCenterZ)) {
        return null;
    }
    const pixelX = Math.floor(
        (x - roadMaskCenterX + ROAD_MASK_HALF_SIZE_M)
        / (2 * ROAD_MASK_HALF_SIZE_M) * ROAD_MASK_SIZE_PX,
    );
    const pixelZ = Math.floor(
        (z - roadMaskCenterZ + ROAD_MASK_HALF_SIZE_M)
        / (2 * ROAD_MASK_HALF_SIZE_M) * ROAD_MASK_SIZE_PX,
    );
    if (pixelX < 0 || pixelX >= canvas.width || pixelZ < 0 || pixelZ >= canvas.height) {
        return null;
    }
    const bytes = canvas.getContext('2d').getImageData(pixelX, pixelZ, 1, 1).data;
    return {
        red: bytes[0],
        green: bytes[1],
        blue: bytes[2],
        alpha: bytes[3],
        pixelX,
        pixelZ,
        centerX: roadMaskCenterX,
        centerZ: roadMaskCenterZ,
    };
}

function publishedFormationClaim(model, roadFormation = reference?.roadFormation) {
    const surfaceClass = model === roadFormation
        ? SURFACE_CLASS.ROAD_EARTHWORK
        : SURFACE_CLASS.RAIL_EARTHWORK;
    return compileSurfaceClaim({
        surfaceClass,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: surfaceClass,
        sourceId: 'world/terrain.js:ground-ownership-mask',
        generation: Number(model?.revision) || 0,
        supportReady: true,
        cutsBackstop: true,
    });
}

function publishedOpeningClaim(model, operation) {
    return compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.INTENTIONAL_OPENING,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        ownerId: operation,
        sourceId: 'world/terrain.js:ground-ownership-mask',
        replacementKey: operation,
        generation: Number(model?.revision) || 0,
        replacementBackstopReady: true,
        supportReady: true,
        cutsBackstop: true,
        paintsColor: false,
    });
}

// Which channel a model writes its excavation into — never a shared one, or a
// formation would be removed by its own trench. Only the rail model derives
// excavation runs today: its profiles are built from paired left/right boundary
// edges, while a road profile starts life as an OSM buffer polygon with no
// cross-section pairing to walk.
function excavationFillForModel(model, roadFormation = reference?.roadFormation, railFormation = reference?.railFormation) {
    if (model !== railFormation) return null;
    return surfaceGroundOwnershipMaskFill(publishedFormationClaim(model, roadFormation), {
        operation: SURFACE_BACKSTOP_CUT_OPERATION.RAIL_EXCAVATION,
    });
}

function ownershipFillForModel(model, roadFormation = reference?.roadFormation) {
    const operation = model === roadFormation
        ? SURFACE_BACKSTOP_CUT_OPERATION.ROAD_FORMATION
        : SURFACE_BACKSTOP_CUT_OPERATION.RAIL_FORMATION;
    return surfaceGroundOwnershipMaskFill(publishedFormationClaim(model, roadFormation), { operation });
}

function createRoadFormationMaskTask(models, revision, centerX, centerZ, {
    roadFormation = reference?.roadFormation,
    railFormation = reference?.railFormation,
    renderedRailSurface = reference?.renderedRailSurface || null,
} = {}) {
    const inputs = captureFormationMaskInputs(models, {
        centerX,
        centerZ,
        radiusM: ROAD_MASK_HALF_SIZE_M + FORMATION_MAX_CUTOUT_REACH_M,
    });
    if (!inputs) return null;
    const trackbedTerrainCutouts = Array.from(
        renderedRailSurface?.terrainCutoutRegionsNear?.(
            centerX,
            centerZ,
            ROAD_MASK_HALF_SIZE_M + FORMATION_MAX_CUTOUT_REACH_M,
        ) || renderedRailSurface?.getTerrainCutoutRegions?.() || [],
    );
    const viaductTerrainCutouts = Array.from(
        renderedRailSurface?.viaductTerrainCutoutRegionsNear?.(
            centerX,
            centerZ,
            ROAD_MASK_HALF_SIZE_M + FORMATION_MAX_CUTOUT_REACH_M,
        ) || renderedRailSurface?.getViaductTerrainCutoutRegions?.() || [],
    );
    const canvas = document.createElement('canvas');
    canvas.width = ROAD_MASK_SIZE_PX;
    canvas.height = ROAD_MASK_SIZE_PX;
    const context = canvas.getContext('2d');
    // A fresh canvas is transparent black. The shader reads RGB only, so a
    // full 3072² opaque-black fill is identical ground-ownership data and pure
    // main-thread raster work. Explicit restoration regions still paint black
    // below because they must overwrite already drawn channels.
    const toPixelX = (x) => (
        (x - centerX + ROAD_MASK_HALF_SIZE_M)
        / (2 * ROAD_MASK_HALF_SIZE_M) * ROAD_MASK_SIZE_PX
    );
    const toPixelZ = (z) => (
        (z - centerZ + ROAD_MASK_HALF_SIZE_M)
        / (2 * ROAD_MASK_HALF_SIZE_M) * ROAD_MASK_SIZE_PX
    );
    const ringBounds = (ring) => ring.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, Number(point.x)),
        minZ: Math.min(bounds.minZ, Number(point.z)),
        maxX: Math.max(bounds.maxX, Number(point.x)),
        maxZ: Math.max(bounds.maxZ, Number(point.z)),
    }), {
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
    });
    const ringTouchesMask = (ring, bounds = null) => {
        const resolvedBounds = bounds || ringBounds(ring);
        return !(resolvedBounds.maxX < centerX - ROAD_MASK_HALF_SIZE_M
            || resolvedBounds.minX > centerX + ROAD_MASK_HALF_SIZE_M
            || resolvedBounds.maxZ < centerZ - ROAD_MASK_HALF_SIZE_M
            || resolvedBounds.minZ > centerZ + ROAD_MASK_HALF_SIZE_M);
    };
    const appendRingPath = (path, ring, bounds = null) => {
        if (!Array.isArray(ring)
            || ring.length < 3
            || !bounds
            || !ring.every((point) => (
                typeof point?.x === 'number'
                && Number.isFinite(point.x)
                && typeof point?.z === 'number'
                && Number.isFinite(point.z)
            ))) {
            return false;
        }
        if (!ringTouchesMask(ring, bounds)) return false;
        // Give every independent subpath the same winding, so non-zero fill
        // computes a union even when overlapping source polygons arrived with
        // opposite ring orientation.
        let twiceArea = 0;
        for (let index = 0; index < ring.length; index++) {
            const a = ring[index];
            const b = ring[(index + 1) % ring.length];
            twiceArea += Number(a.x) * Number(b.z) - Number(b.x) * Number(a.z);
        }
        const first = twiceArea >= 0 ? 0 : ring.length - 1;
        const step = twiceArea >= 0 ? 1 : -1;
        path.moveTo(toPixelX(ring[first].x), toPixelZ(ring[first].z));
        for (let offset = 1; offset < ring.length; offset++) {
            const index = (first + step * offset + ring.length) % ring.length;
            path.lineTo(toPixelX(ring[index].x), toPixelZ(ring[index].z));
        }
        path.closePath();
        return true;
    };
    const drawRing = (
        ring,
        bounds,
        color,
        clipRings = [],
        { coverPavedClipBoundary = false } = {},
    ) => {
        const path = new Path2D();
        if (!appendRingPath(path, ring, bounds)) return false;
        // `clipRings` confine the fill to the exact formation footprint. The
        // excavation regions are deliberately offset well outside the batter
        // so they cannot miss the sloped flanks of a cut; the formation's exact
        // cutout rings trim them back to the real excavated footprint.
        let clipPath = null;
        for (const clipRing of clipRings || []) {
            const nextPath = new Path2D();
            if (!appendRingPath(nextPath, clipRing, ringBounds(clipRing))) continue;
            if (!clipPath) clipPath = new Path2D();
            clipPath.addPath(nextPath);
        }
        if (clipPath) {
            context.save();
            context.clip(clipPath);
        }
        context.fillStyle = color;
        context.fill(path);
        if (clipPath) context.restore();
        if (clipPath && coverPavedClipBoundary) {
            // Restrict the safety stroke to the measured intrusion run. Its
            // outward half lies under the generated road face; its inward half
            // closes the sub-texel hole that exposed terrain over asphalt.
            context.save();
            context.clip(path);
            context.strokeStyle = color;
            context.lineJoin = 'round';
            context.lineCap = 'round';
            // Canvas strokes are centred on their path. Because the clip keeps
            // only the measured-intrusion side of the paved boundary, request
            // twice the owned overlap so the retained half is the full 0.8 m.
            context.lineWidth = ROAD_MASK_PAVED_EDGE_OVERLAP_M * 2
                * ROAD_MASK_SIZE_PX / ROAD_MASK_HALF_SIZE_M;
            context.stroke(clipPath);
            context.restore();
        }
        return true;
    };
    function* drawSteps() {
        let drawn = 0;
        const surfaceCorrections = [];
        const tunnelPortalOpenings = [];
        const openingFill = surfaceGroundOwnershipMaskFill(
            publishedOpeningClaim(models[0], 'civil-ground-openings'),
            { operation: SURFACE_BACKSTOP_CUT_OPERATION.INTENTIONAL_OPENING },
        );
        // Channels are independent facts about the same pixel, so they ADD rather
        // than overwrite: where a road formation and a rail excavation overlap, the
        // pixel has to carry both, and a plain fill would drop whichever painted
        // first. Each channel still thresholds at 0.5 on its own, exactly as the
        // old single-bit mask did, so antialiased ring edges behave unchanged and
        // can never blend into a channel nobody painted.
        context.globalCompositeOperation = 'lighter';
        for (const input of inputs) {
            const { model, profiles } = input;
            const excavationFill = excavationFillForModel(model, roadFormation, railFormation);
            const ownershipFill = ownershipFillForModel(model, roadFormation);
            // Model access is a semantic boundary too. It is normally a cheap
            // published-array read, but yielding here prevents it from being
            // combined with the first substantial profile.
            yield;
            for (const profile of profiles) {
                if (profile.terrainCutoutDisabled) {
                    yield;
                    continue;
                }
                // Uninterrupted formations remain one ring. Junction-suppressed
                // formations expose a few exact paved/wall/collar run polygons so
                // the mask never opens beyond rendered geometry — without the
                // catastrophic full-canvas destination-in coverage pass.
                const ownershipRings = formationTerrainCutoutMaskRings(profile);
                const regions = formationTerrainCutoutMaskRegions(profile);
                if (regions.length === 0) yield;
                for (const region of regions) {
                    if (region.reapplyAfterReplacementClear) {
                        surfaceCorrections.push({ region, ownershipFill });
                    }
                    if (drawRing(
                        region.ring,
                        region.bounds || ringBounds(region.ring),
                        ownershipFill,
                        region.clipRings,
                        { coverPavedClipBoundary: region.coverPavedClipBoundary },
                    )) drawn += 1;
                    yield;
                }
                if (!excavationFill) continue;
                // Clipped to the same ring the terrain opens along, so the two
                // boundaries agree exactly: everything standing over the excavated
                // wedge goes, and nothing beyond where the ground was ever touched.
                for (const region of profile.excavationRegions || []) {
                    drawRing(region.ring, region.bounds, excavationFill, ownershipRings);
                    yield;
                }
            }
            // Exact rendered rail surfaces are not members of the broad
            // formation loops. Ordinary embedded tram uses its hardware-
            // rasterised stencil, while depth-proven heavy-rail intrusions are
            // painted from the bounded list below after all restorations.
            for (const region of input.tunnelPortalOpenings) {
                tunnelPortalOpenings.push(region);
                yield;
            }
        }
        // Replacement regions paint AFTER every model's profile cuts: the clear
        // ring is a restoration — it must also cancel the OTHER model's cut (a
        // rail formation crossing above a boxed underpass used to reopen the fill
        // over the tunnel, floating a strip of ground beside the box roof). And
        // every cutout paints after every clear ring, so one carriageway's trench
        // cannot be blanked by its twin alignment's protection next door.
        // Opaque black under source-over clears every channel at once, which is what
        // "restoration" means: the ground is back, for every question asked of it.
        context.globalCompositeOperation = 'source-over';
        for (const input of inputs) {
            for (const region of input.replacementRegions) {
                drawRing(region.clearRing || [], region.clearBounds, '#000');
                yield;
            }
        }
        // A boxed pedestrian underpass keeps its terrain roof, but that roof may
        // not be restored through the asphalt above it. Repaint only measured,
        // paved-footprint DGU corrections after the structural clear; broad civil
        // cuts and neighboring rail formations remain cleared/protected.
        context.globalCompositeOperation = 'lighter';
        for (const correction of surfaceCorrections) {
            const { region, ownershipFill } = correction;
            drawRing(
                region.ring,
                region.bounds || ringBounds(region.ring),
                ownershipFill,
                region.clipRings,
                { coverPavedClipBoundary: region.coverPavedClipBoundary },
            );
            yield;
        }
        // A published heavy-rail bed is the replacement backstop at these
        // exact strips. Activate them only when immutable DGU terrain is at
        // least eight centimetres above the bed, and repaint after structural
        // roof restorations so a tunnel/underpass clear cannot put the lid
        // back over visible ballast.
        for (const region of trackbedTerrainCutouts) {
            if (drawRing(
                region.ring || [],
                region.bounds || ringBounds(region.ring || []),
                openingFill,
            )) {
                drawn += 1;
            }
            yield;
        }
        // An opaque viaduct slab is a bounded 3D replacement for DGU terrain
        // that physically intrudes above it. Paint its full deck footprint
        // only after every broad tunnel/underpass restoration, so the same
        // concrete box that closes the view also owns the final opening.
        for (const region of viaductTerrainCutouts) {
            if (drawRing(
                region.ring || [],
                region.bounds || ringBounds(region.ring || []),
                openingFill,
            )) {
                drawn += 1;
            }
            yield;
        }
        // A bored tunnel normally keeps the hill above it. Its open mouth is the
        // one exception: overlap the approach cut across the exact portal plane so
        // bilinear mask sampling cannot leave a DGU tooth hanging through the
        // opening. This is terrain ownership only; it deliberately does not erase
        // an independently modelled road or structure above the tunnel.
        for (const region of tunnelPortalOpenings) {
            if (drawRing(
                region.ring || [],
                region.bounds || ringBounds(region.ring || []),
                openingFill,
            )) {
                drawn += 1;
            }
            yield;
        }
        for (const input of inputs) {
            for (const region of input.replacementRegions) {
                if (drawRing(
                    region.cutoutRing || [],
                    region.cutoutBounds,
                    openingFill,
                )) {
                    drawn += 1;
                }
                yield;
            }
        }
        context.globalCompositeOperation = 'source-over';
        return drawn;
    }

    const iterator = drawSteps();
    let complete = false;
    let texture = null;
    return {
        models: models.slice(),
        revision,
        centerX,
        centerZ,
        step(budgetMs = ROAD_MASK_BUILD_SLICE_MS) {
            if (complete) return true;
            const deadline = performance.now() + Math.max(0.1, Number(budgetMs) || 0);
            do {
                const result = iterator.next();
                if (result.done) {
                    complete = true;
                    if ((Number(result.value) || 0) > 0) {
                        texture = new THREE.CanvasTexture(canvas);
                        texture.flipY = false;
                        texture.minFilter = THREE.LinearFilter;
                        texture.magFilter = THREE.LinearFilter;
                        // This mask uses only level zero. Avoid allocating and
                        // generating an unused mip chain before publication.
                        texture.generateMipmaps = false;
                        // The old opaque-black canvas encoded antialiased edge
                        // coverage in RGB. With the implicit transparent-black
                        // background, retain that exact RGB contract by uploading
                        // the canvas premultiplied; the shader intentionally
                        // ignores alpha.
                        texture.premultiplyAlpha = true;
                    }
                    return true;
                }
            } while (performance.now() < deadline);
            return false;
        },
        result() {
            return complete ? texture : undefined;
        },
    };
}

function syncRoadFormationMask(local) {
    const models = activeFormationModels();
    const revision = groundOwnershipMaskRevision(models);
    const centerX = Number(local?.x) || 0;
    const centerZ = Number(local?.z) || 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (roadMaskPublication) {
        if (formationMaskTaskNeedsRestart(roadMaskPublication.task, models, centerX, centerZ, ROAD_MASK_REFRESH_MOVE_M)
            || (roadMaskPublication.error && roadMaskPublication.task.revision !== revision)) {
            cancelRoadFormationMaskPublication('terrain-mask-inputs-changed');
        } else {
            enqueueRoadFormationMaskPublication();
            return;
        }
    }
    if (models.length === 0) {
        roadMaskBuildTask = null;
        if (roadMaskModels.length > 0 || roadMaskTexture) {
            startRoadFormationMaskPublication({ models: [], revision, centerX, centerZ, result: () => null });
        }
        return;
    }
    if (!sameFormationModels(models, roadMaskObservedModels)) {
        roadMaskObservedModels = models.slice();
        roadMaskObservedRevision = revision;
        roadMaskRevisionChangedAt = now;
        roadMaskRevisionPendingSince = now;
    } else if (revision !== roadMaskObservedRevision) {
        roadMaskObservedRevision = revision;
        roadMaskRevisionChangedAt = now;
        if (!Number.isFinite(roadMaskRevisionPendingSince)) roadMaskRevisionPendingSince = now;
    }
    const moved = Math.hypot(centerX - roadMaskCenterX, centerZ - roadMaskCenterZ);
    if (!roadMaskBuildTask
        && sameFormationModels(models, roadMaskModels)
        && revision === roadMaskRevision
        && moved < ROAD_MASK_REFRESH_MOVE_M) {
        return;
    }
    if (roadMaskBuildTask && formationMaskTaskNeedsRestart(
        roadMaskBuildTask,
        models,
        centerX,
        centerZ,
        ROAD_MASK_REFRESH_MOVE_M,
    )) {
        // The canvas is private until publication, so abandoning an obsolete
        // generation cannot expose a half-painted ownership mask.
        roadMaskBuildTask = null;
    }
    const revisionPending = !sameFormationModels(models, roadMaskModels)
        || revision !== roadMaskRevision;
    if (!roadMaskBuildTask) {
        if (revisionPending
            && now - roadMaskRevisionChangedAt < ROAD_MASK_REVISION_SETTLE_MS
            && now - roadMaskRevisionPendingSince < ROAD_MASK_MAX_DEFER_MS) {
            return;
        }
        roadMaskBuildTask = createRoadFormationMaskTask(
            models,
            revision,
            centerX,
            centerZ,
        );
        // A model without a stale-publication accessor still has to finish its
        // own bounded build first. RoadFormationModel does expose one, so its
        // last atomic profiles can immediately recenter the terrain mask.
        if (!roadMaskBuildTask) return;
    }
    if (!roadMaskBuildTask.step(ROAD_MASK_BUILD_SLICE_MS)) return;
    const completedTask = roadMaskBuildTask;
    roadMaskBuildTask = null;
    startRoadFormationMaskPublication(completedTask);
}

function markUrbanMaskDirty() {
    urbanMaskSourceRevision += 1;
    urbanMaskDirty = true;
    urbanMaskChangedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function projectUrbanLonLat(lon, lat) {
    return {
        x: (Number(lon) - reference.anchorLon) * reference.metresPerDegreeLon,
        z: -(Number(lat) - reference.anchorLat) * reference.metresPerDegreeLat,
    };
}

function replaceUrbanGroundMask(texture, centerX, centerZ) {
    const previous = urbanMaskTexture;
    urbanMaskTexture = texture || null;
    setUrbanGroundSurfaceMask(
        urbanMaskTexture,
        centerX,
        centerZ,
        urbanGroundConfig?.maskHalfSizeM || 1,
    );
    if (previous && previous !== urbanMaskTexture) previous.dispose();
}

function syncUrbanGroundMask(local) {
    if (!urbanGroundConfig) return;
    const syncStartedAtMs = performance.now();
    urbanMaskBuildAttributedMs = 0;
    const centerX = Number(local?.x) || 0;
    const centerZ = Number(local?.z) || 0;
    try {
        if (urbanMaskBuildTask && !urbanGroundMaskBuildIsCurrent(
            urbanMaskBuildTask,
            urbanMaskSourceRevision,
            centerX,
            centerZ,
            urbanGroundConfig.refreshMoveM,
        )) {
            // The task paints private canvases. Dropping an obsolete generation
            // cannot expose partial output, while completed per-tile projection
            // caches survive and are reused by the replacement task.
            urbanMaskBuildTask = null;
        }
        const movedM = Math.hypot(centerX - urbanMaskCenterX, centerZ - urbanMaskCenterZ);
        const sourcePending = urbanMaskPublishedRevision !== urbanMaskSourceRevision;
        if (!urbanMaskBuildTask && !sourcePending && movedM < urbanGroundConfig.refreshMoveM) return;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!urbanMaskBuildTask) {
            if (sourcePending
                && urbanMaskDirty
                && now - urbanMaskChangedAt < URBAN_MASK_SETTLE_MS) return;
            urbanMaskBuildTask = createUrbanGroundMaskBuildTask({
                tileCaches: urbanBuildingTiles.values(),
                config: urbanGroundConfig,
                centerX,
                centerZ,
                sourceRevision: urbanMaskSourceRevision,
                onPhase: ({ phase, ms }) => {
                    urbanMaskBuildAttributedMs += ms;
                    recordLayerFrameMs(`terrain:urbanMask:${phase}`, ms);
                },
            });
        }
        if (!urbanMaskBuildTask.step(URBAN_MASK_BUILD_SLICE_MS)) return;
        const completedTask = urbanMaskBuildTask;
        urbanMaskBuildTask = null;
        if (!urbanGroundMaskBuildIsCurrent(
            completedTask,
            urbanMaskSourceRevision,
            centerX,
            centerZ,
            urbanGroundConfig.refreshMoveM,
        )) return;

        const canvas = completedTask.result();
        let texture = null;
        if (canvas) {
            texture = new THREE.CanvasTexture(canvas);
            texture.flipY = false;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
        }
        replaceUrbanGroundMask(texture, completedTask.centerX, completedTask.centerZ);
        urbanMaskCenterX = completedTask.centerX;
        urbanMaskCenterZ = completedTask.centerZ;
        urbanMaskPublishedRevision = completedTask.sourceRevision;
        urbanMaskDirty = urbanMaskPublishedRevision !== urbanMaskSourceRevision;
    } finally {
        recordLayerFrameMs(
            'terrain:urbanMask:control',
            Math.max(0, performance.now() - syncStartedAtMs - urbanMaskBuildAttributedMs),
        );
    }
}

function beginUrbanGround(ctx, location) {
    urbanGroundConfig = normalizeUrbanGroundConfig(location.urbanGround);
    if (!urbanGroundConfig || !ctx.sharedTileSession) return;
    const buildingSource = buildingTileSourceForLocation(location);
    urbanBuildingSource = ctx.sharedTileSession.getSource({
        key: buildingSource.key,
        label: 'buildings',
        url: (bbox) => `${getApiBase()}/${buildingSource.endpoint}?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}${buildingSource.querySuffix}`,
        ...DETAILED_BUILDING_STREAM_OPTIONS,
    });
    urbanBuildingSubscription = urbanBuildingSource.subscribe({
        onFetch: (features, tileKey) => {
            urbanBuildingTiles.set(
                tileKey,
                createProjectedBuildingRingCache(features, projectUrbanLonLat),
            );
            markUrbanMaskDirty();
        },
        onEvict: (tileKey) => {
            urbanBuildingTiles.delete(tileKey);
            markUrbanMaskDirty();
        },
    });
    urbanBuildingSource.ensureAround(0, 0);
    markUrbanMaskDirty();
}

function clearUrbanGround() {
    if (urbanBuildingSubscription) urbanBuildingSubscription();
    urbanBuildingSubscription = null;
    urbanBuildingSource = null;
    urbanBuildingTiles = new Map();
    clearUrbanGroundSurfaceMask();
    if (urbanMaskTexture) urbanMaskTexture.dispose();
    urbanMaskTexture = null;
    urbanGroundConfig = null;
    urbanMaskCenterX = Infinity;
    urbanMaskCenterZ = Infinity;
    urbanMaskDirty = false;
    urbanMaskChangedAt = 0;
    urbanMaskSourceRevision = 0;
    urbanMaskPublishedRevision = -1;
    urbanMaskBuildTask = null;
    urbanMaskBuildAttributedMs = 0;
}

function makeMaterial(surfaceStyle, { exactFormationCutouts = false } = {}) {
    const surface = getTerrainSurface(surfaceStyle);
    terrainUvPerM = surface.uvPerM;
    const terrainClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'terrain-material',
        sourceId: 'world/terrain.js',
        supportReady: true,
    });
    const material = applySurfaceStencil(new THREE.MeshStandardMaterial({
        map: surface.map,
        bumpMap: surface.bumpMap,
        bumpScale: surface.bumpScale,
        side: THREE.DoubleSide,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
    }), terrainClaim);
    // The DGU mesh is real 3D ground, not a flat landuse underlay. Roads still
    // render first and write depth, so an at-grade/raised road naturally wins;
    // but terrain that is physically ABOVE a lower road or tunnel must be free
    // to pass the depth test and cover it. Reading the plan-only road stencil
    // here made Branimirova erase the rail embankment above it and made surface
    // sidewalks punch open the roof of the pedestrian underpass. The canonical
    // TERRAIN class therefore compiles to TERRAIN_BACKSTOP_READER, which honors
    // only the depth-independent water cutout bit. Genuine civil cuts remain
    // explicit in applyGroundOwnership's formation mask below.
    applyGroundHoleMask(material, terrainClaim);
    // A compiled receiver already has the formation boundary in its actual
    // triangles and support. Reapplying the coarse ownership bitmap would
    // erase an extra fringe visible only to the shader.
    if (!exactFormationCutouts) applyGroundOwnership(material, terrainClaim);
    material.userData.terrainExactFormationCutouts = exactFormationCutouts;
    if (exactFormationCutouts) {
        material.defines = { ...material.defines, ST3D_PLANNER_GEOMETRY_CUTOUTS: 1 };
        material.userData.plannerGeometryCutouts = true;
    }
    applyStreetLampSurfaceLighting(material);
    applyPlannerSurfaceCutout(material, terrainClaim);
    // The streamed terrain is the default ground, so it carries the farmland quilt.
    applyUrbanGroundSurface(material, terrainClaim, { fieldPatchwork: true });
    groundPaint?.bindMaterial(material, terrainClaim);
    return material;
}

// Country sessions keep one logical world while crossing several landscape
// regions. Material maps can switch immediately; queued near-to-far rebuilds
// then regenerate the baked UVs at the new surface's metre scale without one
// large synchronous geometry spike.
function applyRegionalTerrainStyle(surfaceStyle, localX, localZ) {
    if (!terrainMaterial || !surfaceStyle || surfaceStyle === terrainSurfaceStyle) return false;
    const previousMaterial = terrainMaterial;
    const previousExactMaterial = terrainExactFormationMaterial;
    terrainMaterial = makeMaterial(surfaceStyle);
    terrainExactFormationMaterial = makeMaterial(surfaceStyle, { exactFormationCutouts: true });
    terrainSurfaceStyle = surfaceStyle;
    for (const root of tiles.values()) setTerrainTileMaterial(root,
        root.userData.terrainExactFormationCutouts ? terrainExactFormationMaterial : terrainMaterial);
    retireTerrainMaterial(previousMaterial);
    retireTerrainMaterial(previousExactMaterial);
    queueTerrainTileRebuild(localX, localZ, { invalidateAll: true });
    return true;
}

// A tile inside the fine region tessellates at the fine step so the mesh
// renders the 1 m data it samples; everywhere else the classic 20 m. The
// reference's fine-tile-union rule is the single source of truth, so mesh
// and sampler can never disagree about which surface a tile shows.
function tileMeshSegments(tileX, tileZ) {
    const detail = reference?.detail;
    if (!detail || !reference.isFineTile(tileX, tileZ)) return TILE_SEGMENTS;
    return Math.round(TILE_M / detail.stepM);
}

function terrainPublicationKey(tileX, tileZ) {
    return `terrain:${tileX}:${tileZ}`;
}

function disposeTerrainTileMesh(root) {
    if (!root) return;
    const geometries = new Set();
    root.traverse?.((object) => {
        if (object.geometry && !geometries.has(object.geometry)) {
            geometries.add(object.geometry);
            object.geometry.dispose?.();
        }
    });
    root.parent?.remove?.(root);
}

function setTerrainTileMaterial(root, nextMaterial) {
    root?.traverse?.((object) => {
        if (object.isMesh) object.material = nextMaterial;
    });
}

// compileAsync polls its material's current program after the initiating
// frame. A cancelled tile may release geometry immediately, but session/style
// teardown must keep that shared material alive until the compiler settles.
const terrainMaterialCompileFences = new WeakMap();
function retainTerrainMaterialCompile(material, ready) {
    let fences = terrainMaterialCompileFences.get(material);
    if (!fences) terrainMaterialCompileFences.set(material, fences = new Set());
    if (fences.has(ready)) return;
    fences.add(ready);
    const release = () => { fences.delete(ready); };
    ready.then(release, release);
}
function retireTerrainMaterial(material) {
    if (!material) return;
    const fences = terrainMaterialCompileFences.get(material);
    if (!fences?.size) { material.dispose(); return; }
    Promise.allSettled([...fences]).then(() => material.dispose());
}

function* createTerrainTileRootSteps(
    packet,
    tileX,
    tileZ,
    surfaceSignature,
    publicationGeneration,
    { exactFormationCutouts = false } = {},
) {
    const material = exactFormationCutouts ? terrainExactFormationMaterial : terrainMaterial;
    if (!material) throw new Error('Terrain receiver material is unavailable');
    const task = createRenderPacketUploadTask(packet, {
        replacementKey: terrainPublicationKey(tileX, tileZ),
        rootName: `TerrainTile:${tileX}:${tileZ}`,
        position: { x: tileX * TILE_M, y: 0, z: tileZ * TILE_M },
        materialForKey: materialKey => {
            if (materialKey !== 'terrain') {
                throw new Error(`Unexpected terrain packet material ${materialKey}`);
            }
            return material;
        },
        configureMesh: (mesh) => {
            mesh.name = `TerrainTileMesh:${tileX}:${tileZ}`;
            mesh.receiveShadow = true;
            mesh.renderOrder = GROUND_STENCIL_READER_RENDER_ORDER;
        },
    });
    let root = null;
    let handedOff = false;
    let prewarm = null;
    try {
        if (packet.primitives.length !== 1) throw new Error('Terrain packet must contain exactly one primitive');
        while (!task.step(1)) yield { phase: 'packet-validation' };
        root = task.result();
        root.userData.terrainSurfaceSignature = surfaceSignature;
        root.userData.terrainPublicationGeneration = publicationGeneration;
        root.userData.terrainExactFormationCutouts = exactFormationCutouts;
        // A fully removed receiver is a completed tile with no render/support
        // faces. Keep its revision receipt, but publish an explicit clear and
        // spend no GPU work on the empty packet.
        root.userData.terrainEmpty = packet.primitives[0].empty === true;
        prewarm = root.userData.terrainEmpty ? null : prewarmDetachedObject(root, {
            renderer, camera, targetScene: scene, asyncShaders: true,
            label: 'terrain-gpu-prewarm', uploadBatch: 1,
        });
        let step = prewarm?.next() || { done: true };
        while (!step.done) {
            if (step.value?.ready) retainTerrainMaterialCompile(material, step.value.ready);
            yield step.value;
            step = prewarm.next();
        }
        root.userData.terrainGpuPrepared = true;
        handedOff = true;
        return root;
    } finally {
        prewarm?.return?.();
        if (root && !handedOff) disposeTerrainTileMesh(root);
        task.dispose();
    }
}

function removeTile(key) {
    // A dependency group may still need this exact root for rollback. The
    // window scan will revisit deferred evictions after the group settles.
    if (terrainGroundGenerationLease || groundManaged) {
        terrainDeferredEvictions.add(key);
        if (groundManaged) groundCoordinator.invalidate('terrain-window', { keys: [key], reason: 'terrain-evicted' });
        return;
    }
    const mesh = tiles.get(key);
    if (!mesh) return;
    tiles.delete(key);
    const [tileX, tileZ] = key.split('_').map(Number);
    if (surfacePublications?.retire?.(terrainPublicationKey(tileX, tileZ), {
        root: mesh,
        reason: 'terrain-tile-evicted',
    })) return;
    disposeTerrainTileMesh(mesh);
}

// One Worker owns all render compilers. Terrain admits one tile at a time so a
// fine tile cannot multiply memory, and only the complete validated packet is
// uploaded. The previous published generation stays visible until commit.
const TERRAIN_STARTUP_SUPPORT_RING = 1;
let pendingTileBuilds = [];
let activeTileBuild = null;
let terrainGroundGenerationLease = null;
const terrainDeferredEvictions = new Set();
let terrainCompilerSnapshotFailure = null;
let terrainBuildPriorityX = 0;
let terrainBuildPriorityZ = 0;
let terrainBuildSupportX = 0;
let terrainBuildSupportZ = 0;
let terrainBuildPrioritySignature = null;
let terrainPinnedSignature = null;
let terrainPinnedTileKeys = new Set();
let terrainSurfaceEpoch = 0;
const terrainTileSurfaceRevisions = new Map();
const terrainTileBuildFailures = new Map();
const terrainBuildWaiters = new Set();

function terrainAbortError(message) {
    if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function notifyTerrainBuildWaiters() {
    for (const waiter of [...terrainBuildWaiters]) waiter.check();
}

function rejectTerrainBuildWaiters(error) {
    for (const waiter of [...terrainBuildWaiters]) waiter.reject(error);
}

function waitForTerrainSupportRing(centerX, centerZ, signal) {
    const keys = [];
    for (let dz = -TERRAIN_STARTUP_SUPPORT_RING; dz <= TERRAIN_STARTUP_SUPPORT_RING; dz++) {
        for (let dx = -TERRAIN_STARTUP_SUPPORT_RING; dx <= TERRAIN_STARTUP_SUPPORT_RING; dx++) {
            keys.push(`${centerX + dx}_${centerZ + dz}`);
        }
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            terrainBuildWaiters.delete(waiter);
            signal?.removeEventListener?.('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, terrainAbortError('Terrain session closed'));
        const waiter = {
            check() {
                if (terrainCompilerSnapshotFailure) {
                    finish(reject, terrainCompilerSnapshotFailure);
                    return;
                }
                const failedKey = keys.find(key => terrainTileBuildFailures.has(key));
                if (failedKey) {
                    finish(reject, terrainTileBuildFailures.get(failedKey));
                    return;
                }
                const ready = keys.every((key) => {
                    const root = tiles.get(key);
                    if (!root) return false;
                    const [tileX, tileZ] = key.split('_').map(Number);
                    return root.userData?.terrainSurfaceSignature
                        === terrainTileSurfaceSignature(tileX, tileZ);
                });
                if (ready) finish(resolve);
            },
            reject(error) { finish(reject, error); },
        };
        terrainBuildWaiters.add(waiter);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        waiter.check();
    });
}

async function installTerrainCompilerSnapshot(capturedRead = null) {
    if (!terrainRenderCompilers.length || !reference) {
        throw new Error('Terrain render compiler is unavailable');
    }
    if (!terrainGridPrepQueue) throw new Error('Terrain snapshot preparation queue is unavailable');
    const read = capturedRead || captureTerrainReadSnapshot(reference);
    const source = read.source;
    const compilers = terrainRenderCompilers;
    terrainCompilerSnapshotFailure = null;
    try {
        const installed = (await Promise.all(compilers.map(compiler => compiler.setState(
            'terrain',
            async ({ signal }) => {
                const snapshot = await runTerrainGridPrepIterator(
                    serializeTerrainSnapshotSteps(source),
                    { signal, label: `terrain-snapshot:${source.revision}`, priority: 5e12 },
                );
                return {
                    payload: { kind: 'terrain-snapshot', snapshot },
                    transferables: terrainSnapshotTransferables(snapshot),
                };
            },
            { revision: source.revision },
        )))).every(Boolean);
        if (installed && compilers === terrainRenderCompilers && (reference?.revision === source.revision
            || terrainGroundGenerationLease?.read === read)) {
            terrainCompilerReadSnapshot = read;
            terrainCompilerSnapshotFailure = null;
            pumpTerrainTileBuilds();
        }
        return installed;
    } catch (error) {
        if (compilers === terrainRenderCompilers && reference?.revision === source.revision) {
            terrainCompilerSnapshotFailure = error;
            rejectTerrainBuildWaiters(error);
        }
        throw error;
    }
}

function discardActiveTerrainTileBuild(reason = 'superseded') {
    if (!activeTileBuild) return;
    const discarded = activeTileBuild;
    activeTileBuild = null;
    discarded.compileHandle?.cancel?.(reason);
    discarded.uploadController?.abort();
    discarded.framePublication?.cancel(reason);
    if (discarded.preparedPublication?.state === 'staged') {
        discarded.preparedPublication.discard(reason);
    }
    if (discarded.publicationTicket?.state === 'pending') {
        discarded.publicationTicket.discard(reason);
    }
}

function beginTerrainTilePublication(tileX, tileZ) {
    const publicationGeneration = ++terrainPublicationGeneration;
    const publicationTicket = surfacePublications?.begin?.({
        key: terrainPublicationKey(tileX, tileZ),
        generation: publicationGeneration,
        parent: terrainGroup,
        retire: (_context, root) => disposeTerrainTileMesh(root),
    }) || null;
    return { publicationGeneration, publicationTicket };
}

// The worker/upload path hands off a detached root and its exact immutable
// input. The tile map is part of the reversible entry, so a later road/mask/
// physics member can fail without leaving readiness pointed at a retired root.
function prepareTerrainTilePublication(build, root) {
    const { job, tileX, tileZ, surfaceSignature, publicationTicket } = build;
    const previous = tiles.get(job.key) || null;
    const parent = terrainGroup;
    const session = generation;
    let committed = false;
    const sourceCurrent = build.isCurrent || (() => activeTileBuild === build
        && surfaceSignature === terrainTileSurfaceSignature(tileX, tileZ));
    if (!publicationTicket || root.parent || root.userData?.terrainGpuPrepared !== true) {
        throw new Error('Terrain publication requires a detached, GPU-prepared candidate');
    }
    root.userData.terrainSourceRevision = build.ground.revision;
    const empty = root.userData.terrainEmpty === true;
    return {
        ticket: publicationTicket,
        root: empty ? null : root,
        clear: empty,
        isCurrent: () => sourceCurrent() && generation === session
            && terrainGroup === parent && (tiles.get(job.key) || null) === previous
            && !committed,
        commit() {
            if (generation !== session || terrainGroup !== parent
                || (tiles.get(job.key) || null) !== previous) return false;
            tiles.set(job.key, root);
            committed = true;
            return true;
        },
        rollback() {
            if (!committed) return;
            if (previous) tiles.set(job.key, previous);
            else tiles.delete(job.key);
            committed = false;
        },
        discard: () => disposeTerrainTileMesh(root),
    };
}

function terrainTileSurfaceSignature(tileX, tileZ) {
    const key = `${tileX}_${tileZ}`;
    const fine = !!reference?.detail && reference.isFineTile(tileX, tileZ);
    const stepM = fine ? reference.detail.stepM : reference?.surfaceStepM;
    return `${terrainSurfaceEpoch}:${terrainTileSurfaceRevisions.get(key) || 0}`
        + `:${fine ? 'fine' : 'coarse'}:${Number(stepM) || 0}`;
}

// The analytic terrain reference covers a much larger area than the meshes
// currently on screen. Driving readiness must follow the published mesh, not
// that private height authority, or physics can carry a car into a blank tile.
export function isTerrainTilePublishedAtLocal(localX, localZ) {
    const x = finiteOrNull(localX);
    const z = finiteOrNull(localZ);
    if (x === null || z === null || !terrainGroup || !reference) return false;
    const tileX = Math.floor(x / TILE_M);
    const tileZ = Math.floor(z / TILE_M);
    const key = `${tileX}_${tileZ}`;
    const root = tiles.get(key);
    return !!root
        && root.visible !== false
        && (root.parent === terrainGroup || root.userData?.terrainEmpty === true)
        && root.userData?.terrainSurfaceSignature
            === terrainTileSurfaceSignature(tileX, tileZ);
}

function terrainPacketTile(tileX, tileZ) {
    const origin = reference.lonLatAtLocal(tileX * TILE_M, tileZ * TILE_M);
    return {
        matrix: 'station3d-local-metre-v1',
        z: 0,
        x: tileX,
        y: tileZ,
        originLon: origin.lon,
        originLat: origin.lat,
        sizeM: TILE_M,
    };
}

function isExpectedCompilerCancellation(error) {
    return ['cancelled', 'superseded', 'stale-result', 'client-disposed', 'state-superseded', 'state-cleared']
        .includes(error?.code);
}

function isTerrainCompilerStateFailure(error) {
    return ['state-unavailable', 'state-preparation-failed', 'state-rejected', 'state-cleared',
        'worker-crashed', 'worker-unavailable', 'invalid-worker', 'client-disposed'].includes(error?.code);
}

function* enqueueTerrainPublicationSteps(build, batch, boundary, onPublished = null) {
    while (activeTileBuild === build && batch.state === 'staged') {
        if (boundary.snapshot().closed) break;
        const ticket = boundary.enqueue(batch, { onPublished });
        if (ticket) return ticket;
        // A road or paint group can own the one ready slot. Keep this one
        // admitted upload private and retry through the existing frame queue.
        yield { phase: 'publication-slot' };
    }
    const error = terrainGridPrepAbortError('Terrain publication cancelled');
    error.code = 'cancelled';
    throw error;
}

// One captured set authorizes both exact receiver triangles and the civil
// removal channels. Source model availability alone cannot open a backstop.
function* prepareGroundOwnershipGenerationSteps({ ground, roadReceivers, railReceivers, structureReceivers,
    centerX, centerZ, radiusM, maxProfiles, maxRegions, isCurrent = () => true }) {
    if (!Object.isFrozen(ground) || !ground?.terrain || !ground?.roadFormation || !ground?.railFormation
        || !ground?.verticalAlignments || typeof ground.isCurrent !== 'function'
        || typeof roadReceivers?.formationBackstopReady !== 'function'
        || typeof roadReceivers?.terrainCutoutRegionsSteps !== 'function'
        || !railReceivers?.renderedRailSurface || !structureReceivers?.structurePublications
        || railReceivers.formationRead?.getSurfaceProfiles() !== ground.railFormation?.getSurfaceProfiles()
        || ![roadReceivers, railReceivers, structureReceivers].every(receiver => typeof receiver.isCurrent === 'function')
        || ![centerX, centerZ, radiusM].every(Number.isFinite) || radiusM < ROAD_MASK_HALF_SIZE_M * Math.SQRT2
        || ![maxProfiles, maxRegions].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Ground cuts require complete prepared receivers and explicit coverage limits');
    }
    if (roadMaskPublication || roadMaskBuildTask) {
        throw Object.assign(new Error('An earlier ground mask is still preparing'), { code: 'ground-dependency-busy' });
    }
    let held = null, task = null, publication = null, handedOff = false, settled = false;
    const current = () => !settled && isCurrent() && ground.isCurrent()
        && roadReceivers.isCurrent() && railReceivers.isCurrent() && structureReceivers.isCurrent();
    const check = () => {
        const validity = {
            generation: !!isCurrent(),
            ground: !!ground.isCurrent(),
            roads: !!roadReceivers.isCurrent(),
            rails: !!railReceivers.isCurrent(),
            structures: !!structureReceivers.isCurrent(),
        };
        if (!Object.values(validity).every(Boolean)) throw Object.assign(
            new Error('Ground cut receivers changed'),
            { code: 'ground-generation-stale', details: { validity } },
        );
    };
    const discard = () => {
        if (settled) return false;
        settled = true;
        if (publication) publication.discard(); else task?.result()?.dispose();
        held?.release?.(); held = null; return true;
    };
    try {
        held = retainReadSnapshot(ground, 'ground-cut-receivers'); check();
        const alignments = new Map();
        for (const alignment of held.verticalAlignments.getAlignments()) {
            if (alignments.size >= maxRegions) throw Object.assign(new Error('Ground structure capacity exceeded'), { code: 'ground-generation-capacity' });
            alignments.set(alignment.id, alignment); yield { phase: 'ground-cut-structures' }; check();
        }
        const inputs = captureFormationMaskInputs([held.roadFormation, held.railFormation], { centerX, centerZ, radiusM });
        if (!inputs) throw Object.assign(new Error('Ground model is not prepared'), { code: 'ground-dependency-busy' });
        const views = []; let profiles = 0, regions = 0;
        for (const input of inputs) {
            const road = input.model === held.roadFormation;
            for (const profile of input.profiles) {
                if (++profiles > maxProfiles) throw Object.assign(new Error('Ground profile capacity exceeded'), { code: 'ground-generation-capacity' });
                if (road && !profile.terrainCutoutDisabled && formationTerrainCutoutMaskRegions(profile).length
                    && !roadReceivers.formationBackstopReady(profile)) {
                    throw Object.assign(new Error('Road terrain cut has no matching receiver'), { code: 'ground-backstop-unavailable' });
                }
                yield { phase: 'ground-cut-backstops' }; check();
            }
            for (const region of input.replacementRegions) {
                if (++regions > maxRegions) throw Object.assign(new Error('Ground opening capacity exceeded'), { code: 'ground-generation-capacity' });
                if (road) {
                    const alignment = alignments.get(region.alignmentId);
                    const root = structureReceivers.structurePublications.getActive(roadStructurePublicationKey(region.alignmentId))?.root;
                    if (!alignment || !roadStructureMatchesAlignment(root, alignment)) {
                        throw Object.assign(new Error('Ground opening has no matching structure'), { code: 'ground-backstop-unavailable' });
                    }
                }
                yield { phase: 'ground-cut-openings' }; check();
            }
            regions += input.tunnelPortalOpenings.length;
            if (regions > maxRegions) throw Object.assign(new Error('Ground portal capacity exceeded'), { code: 'ground-generation-capacity' });
            views.push(Object.freeze({ ...input.model,
                getSurfaceProfiles: () => input.profiles, surfaceProfilesNear: () => input.profiles,
                getReplacementTerrainCutoutRegions: () => input.replacementRegions,
                getTunnelPortalTerrainOpenings: () => input.tunnelPortalOpenings }));
        }
        const [roadFormation, railFormation] = views, renderedRailSurface = railReceivers.renderedRailSurface;
        const receiverRegions = yield* roadReceivers.terrainCutoutRegionsSteps({ maxRegions,
            bounds: { minX: centerX-radiusM, minZ: centerZ-radiusM, maxX: centerX+radiusM, maxZ: centerZ+radiusM } });
        const cutoutQuery = yield* buildFormationTerrainCutoutQuerySteps({ models: [...views, renderedRailSurface],
            modelSources: ['road-formation', 'rail-formation', 'rail-rendered'],
            receiverRegions, receiverRegionSource: 'road-receivers', centerX, centerZ, radiusM,
            terrainSceneYAtLocal: held.terrain.evidenceSceneYAtLocal });
        check();
        task = createRoadFormationMaskTask(views, `ground:${++terrainPublicationGeneration}`, centerX, centerZ,
            { roadFormation, railFormation, renderedRailSurface });
        if (!task) throw Object.assign(new Error('Ground mask capture unavailable'), { code: 'ground-dependency-busy' });
        while (!task.step(ROAD_MASK_BUILD_SLICE_MS)) { yield { phase: 'ground-cut-mask' }; check(); }
        publication = prepareRoadFormationMaskPublication(task, current);
        if (!(yield* publication.prewarmSteps())) return null;
        check(); handedOff = true;
        return Object.freeze({ entry: { ...publication.entry, discard }, cutoutQuery,
            isCurrent: () => current() && publication.entry.isCurrent(), discard,
            finalize() {
                if (settled || !publication.finalize()) return false;
                settled = true; held.release?.(); held = null; return true;
            } });
    } finally { if (!handedOff) discard(); }
}

function admitTerrainGroundGeneration({ tileKeys, removeKeys = [], maxChangedTiles, isCurrent = () => true }) {
    if (!Array.isArray(tileKeys) || !Array.isArray(removeKeys)
        || !Number.isSafeInteger(maxChangedTiles) || maxChangedTiles <= 0
        || tileKeys.length + removeKeys.length > maxChangedTiles
        || new Set([...tileKeys, ...removeKeys]).size !== tileKeys.length + removeKeys.length
        || typeof isCurrent !== 'function') throw new TypeError('Terrain admission requires a bounded unique tile set');
    if (!reference || !terrainGroup || !renderCompiler || !surfacePublications || activeTileBuild
        || terrainGroundGenerationLease || terrainCompilerReadSnapshot?.revision !== reference.revision) {
        throw Object.assign(new Error('Terrain has older work to settle'), { code: 'ground-dependency-busy' });
    }
    const session = generation, parent = terrainGroup, source = reference, compiler = renderCompiler, material = terrainMaterial;
    const read = captureTerrainReadSnapshot(source), rows = [], removals = [];
    for (const [keys, target] of [[tileKeys, rows], [removeKeys, removals]]) for (const key of keys) {
        if (typeof key !== 'string' || !/^-?\d+_-?\d+$/.test(key)) throw new TypeError('Invalid terrain tile key');
        const [tileX, tileZ] = key.split('_').map(Number);
        if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileZ)) throw new TypeError('Invalid terrain tile coordinate');
        target.push(Object.freeze({ key, tileX, tileZ, previous: tiles.get(key) || null,
            surfaceSignature: terrainTileSurfaceSignature(tileX, tileZ) }));
    }
    const lease = { read, resume: true };
    const localCurrent = () => terrainGroundGenerationLease === lease && generation === session
        && terrainGroup === parent && reference === source && renderCompiler === compiler && terrainMaterial === material
        && !activeTileBuild;
    const current = () => localCurrent() && isCurrent()
        && [...rows, ...removals].every(row => (tiles.get(row.key) || null) === row.previous);
    const release = () => {
        if (terrainGroundGenerationLease !== lease) return false;
        terrainGroundGenerationLease = null;
        if (!lease.resume || generation !== session || reference !== source) return true;
        for (const key of terrainDeferredEvictions) {
            const [x, z] = key.split('_').map(Number);
            if (!terrainPinnedTileKeys.has(key) && (Math.abs(x - lastTileX) > KEEP_RING || Math.abs(z - lastTileZ) > KEEP_RING)) removeTile(key);
        }
        terrainDeferredEvictions.clear();
        // Incoming source evidence stayed pending while the Worker belonged
        // to this captured generation. Reinstall only after releasing it.
        if (terrainCompilerReadSnapshot?.revision !== reference.revision) {
            void installTerrainCompilerSnapshot().catch(error => console.error(logStamp(), '[terrain] Pending Worker snapshot failed', error));
        } else pumpTerrainTileBuilds();
        return true;
    };
    const admission = Object.freeze({ read, rows: Object.freeze(rows), removals: Object.freeze(removals),
        isCurrent: current, localCurrent, release, setCancel(cancel) {
            if (typeof cancel !== 'function' || !localCurrent()) throw new Error('Invalid terrain admission');
            lease.cancel = cancel;
        } });
    lease.admission = admission; lease.cancel = release; terrainGroundGenerationLease = lease;
    return admission;
}

// Serial Worker compilation, validation and detached GPU upload remain the
// ordinary terrain path. The coordinator supplies exact captured cuts and
// joins these entries to the dependent receivers and one physics reservation.
function* prepareTerrainGroundGenerationSteps({ admission, publishedTerrain, cutoutForTile,
    maxGeometryBytes, isCurrent = () => true }) {
    if (terrainGroundGenerationLease?.admission !== admission || !admission.isCurrent()) {
        throw Object.assign(new Error('Terrain admission expired'), { code: 'ground-dependency-busy' });
    }
    if (typeof publishedTerrain?.prepareSteps !== 'function' || typeof cutoutForTile !== 'function'
        || !Number.isSafeInteger(maxGeometryBytes) || maxGeometryBytes <= 0 || typeof isCurrent !== 'function') {
        admission.release(); throw new TypeError('Terrain preparation requires its published provider, exact cuts and resource budget');
    }
    const builds = [], entries = [], rows = [], buffers = new Set(), compiles = new Set();
    let bytes = 0, compile = null, upload = null, queryTx = null, read = null;
    let handedOff = false, settled = false, committed = false;
    const current = () => !settled && !committed && admission.isCurrent() && isCurrent();
    const check = () => { if (!current()) throw Object.assign(new Error('Terrain generation changed'), { code: 'ground-generation-stale' }); };
    const discard = () => {
        if (settled || committed) return false;
        settled = true;
        for (const pending of compiles) pending.cancel('terrain-generation-cancelled');
        compiles.clear(); compile = null; upload?.return?.(); upload = null;
        queryTx?.discard(); read?.release(); read = null;
        for (const build of builds) {
            if (build.publicationTicket?.state === 'pending') build.publicationTicket.discard('terrain-generation-cancelled');
            if (build.root) disposeTerrainTileMesh(build.root);
        }
        for (const entry of entries) if (entry.ticket.state === 'pending') entry.ticket.discard('terrain-generation-cancelled');
        admission.release(); return true;
    };
    function* wait(promise, phase) {
        let done = false, result, failure;
        const ready = promise.then(value => { done = true; result = value; }, error => { done = true; failure = error; });
        while (!done) { check(); yield { phase, waiting: true, ready, deferFrame: true }; }
        check(); if (failure) throw failure; return result;
    }
    admission.setCancel(discard);
    try {
        if (terrainCompilerReadSnapshot !== admission.read) {
            if (!(yield* wait(installTerrainCompilerSnapshot(admission.read), 'terrain-source-install'))) {
                throw Object.assign(new Error('Terrain Worker source was superseded'), { code: 'ground-generation-stale' });
            }
        }
        for (const row of admission.rows) {
            check();
            const { tileX, tileZ } = row;
            const bounds = { minX: tileX * TILE_M, minZ: tileZ * TILE_M, maxX: (tileX + 1) * TILE_M, maxZ: (tileZ + 1) * TILE_M };
            const cutout = cutoutForTile(Object.freeze({ ...row, bounds: Object.freeze(bounds) }));
            if (!cutout || !Array.isArray(cutout.layers)) throw new TypeError('Each terrain receiver requires explicit captured cut layers');
            if (typeof cutout.signature === 'string' && row.previous
                && row.previous.userData.terrainSurfaceSignature === row.surfaceSignature
                && (terrainReceiverCutSignatures.get(row.previous) || '') === cutout.signature) continue;
            const segments = Math.round(TILE_M / (admission.read.isFineTile(tileX, tileZ)
                ? admission.read.detail.stepM : admission.read.surfaceStepM));
            const build = { ...beginTerrainTilePublication(tileX, tileZ), job: { key: row.key },
                tileX, tileZ, surfaceSignature: row.surfaceSignature, ground: admission.read, isCurrent: current, root: null };
            builds.push(build);
            const origin = admission.read.lonLatAtLocal(bounds.minX, bounds.minZ);
            const compiler = terrainRenderCompilers[(builds.length - 1) % terrainRenderCompilers.length];
            compile = compiler.compile({ requestKey: terrainPublicationKey(tileX, tileZ),
                compilerId: TERRAIN_PACKET_COMPILER_ID, compilerVersion: TERRAIN_PACKET_COMPILER_VERSION,
                sourceRevision: `terrain:${admission.read.revision}:${row.surfaceSignature}`, requiredStates: { terrain: admission.read.revision },
                generation: build.publicationGeneration, priority: 1e12,
                tile: { matrix: 'station3d-local-metre-v1', z: 0, x: tileX, y: tileZ, originLon: origin.lon, originLat: origin.lat, sizeM: TILE_M },
                inputs: { snapshotRevision: admission.read.revision, tileX, tileZ, tileM: TILE_M, segments,
                    uvPerM: terrainUvPerM, renderOrder: GROUND_STENCIL_READER_RENDER_ORDER, cutout },
            });
            // Queue the complete bounded receiver set before awaiting the first
            // packet. The compiler still executes one tile at a time, while
            // the next tile can now compile as the previous packet is checked
            // by the cooperative main-thread validator.
            compiles.add(compile);
            compile.promise.catch(() => {}); // discard() may cancel a not-yet-awaited sibling
            build.compile = compile;
            build.sourceRow = row;
            build.segments = segments;
            build.cutSignature = cutout.signature;
            compile = null;
        }
        for (const build of builds) {
            check();
            compile = build.compile;
            const packet = yield* wait(compile.promise, 'terrain-receiver-compile');
            compiles.delete(compile); compile = null; build.compile = null;
            const row = build.sourceRow;
            const { tileX, tileZ, segments } = build;
            if (packet.primitives.length !== 1) throw new TypeError('Terrain requires one complete receiver primitive');
            const primitive = packet.primitives[0], lattice = primitive.terrainLattice;
            for (const array of [primitive.positions, primitive.indices, primitive.normals, primitive.uvs,
                lattice?.positions, lattice?.indices, lattice?.sourceTriangleOffsets]) if (array && !buffers.has(array.buffer)) {
                buffers.add(array.buffer); bytes += array.buffer.byteLength;
            }
            if (bytes > maxGeometryBytes) throw Object.assign(new Error('Terrain candidate exceeds geometry budget'), { code: 'ground-generation-capacity' });
            rows.push({ snapshot: admission.read, tileX, tileZ, segments, positions: lattice?.positions, indices: lattice?.indices,
                receiver: { positions: primitive.positions, indices: primitive.indices, sourceTriangleOffsets: lattice?.sourceTriangleOffsets } });
            build.packet = packet;
            build.sourceRow = null;
            yield { phase: 'terrain-receiver-ready', tileX, tileZ }; check();
        }
        // Validate topology, seams and retained-source peak before GPU upload.
        const query = publishedTerrain.prepareSteps(rows, { removeKeys: admission.removals.map(row => row.key), reason: 'ground-generation' });
        try { for (;;) {
            check(); const step = query.next(); if (step.done) { queryTx = step.value; break; } yield step.value;
        } } finally { query.return(); }
        read = queryTx.captureReadSnapshot('terrain-ground-generation');
        for (const build of builds) {
            upload = createTerrainTileRootSteps(build.packet, build.tileX, build.tileZ, build.surfaceSignature,
                build.publicationGeneration, { exactFormationCutouts: true });
            for (;;) {
                check(); const next = upload.next(); if (next.done) { build.root = next.value; break; }
                yield next.value;
            }
            upload = null; build.packet = null;
            if (typeof build.cutSignature === 'string') terrainReceiverCutSignatures.set(build.root, build.cutSignature);
            entries.push({ ...prepareTerrainTilePublication(build, build.root), discard() {} });
        }
        for (const row of admission.removals) {
            entries.push({ ticket: beginTerrainTilePublication(row.tileX, row.tileZ).publicationTicket,
                clear: true, isCurrent: current,
                commit() {
                    if (!admission.localCurrent() || (tiles.get(row.key) || null) !== row.previous) return false;
                    tiles.delete(row.key); return true;
                }, rollback() { if (row.previous) tiles.set(row.key, row.previous); else tiles.delete(row.key); }, discard() {},
            });
        }
        entries.push({ ticket: surfacePublications.begin({ key: 'terrain:published-query', generation: ++terrainPublicationGeneration }), clear: true,
            isCurrent: () => current() && queryTx.isCurrent(),
            commit() { if (!admission.localCurrent() || !queryTx.commit()) return false; committed = true; return true; },
            rollback() { if (committed) { queryTx.rollback(); committed = false; } }, discard,
        });
        check(); handedOff = true;
        return Object.freeze({ entries, terrain: read, source: admission.read, isCurrent: current, discard,
            usage: Object.freeze({ geometryBytes: bytes, ...queryTx.usage,
                rebuiltTiles: builds.length, retainedTiles: admission.rows.length - builds.length,
                removedTiles: admission.removals.length }),
            finalize() {
                if (settled || !committed) return false;
                settled = true; read.release(); read = null; queryTx.notify();
                // Source evidence may have advanced during preparation. Drop
                // only jobs satisfied by the actually published receiver.
                pendingTileBuilds = pendingTileBuilds.filter(job => (
                    tiles.get(job.key)?.userData?.terrainSurfaceSignature
                        !== terrainTileSurfaceSignature(job.tileX, job.tileZ)));
                for (const row of admission.removals) terrainDeferredEvictions.delete(row.key);
                admission.release(); notifyTerrainBuildWaiters(); return true;
            },
        });
    } finally { if (!handedOff) discard(); }
}

function pumpTerrainTileBuilds() {
    if (groundManaged || terrainGroundGenerationLease || activeTileBuild || !renderCompiler || !reference || !terrainGroup) return;
    if (terrainCompilerSnapshotFailure) return;
    if (terrainCompilerReadSnapshot?.revision !== reference.revision) return;
    while (pendingTileBuilds.length > 0) {
        const job = pendingTileBuilds.shift();
        const [tileX, tileZ] = job.key.split('_').map(Number);
        const surfaceSignature = terrainTileSurfaceSignature(tileX, tileZ);
        const existing = tiles.get(job.key);
        if (existing?.userData?.terrainSurfaceSignature === surfaceSignature) continue;
        terrainTileBuildFailures.delete(job.key);
        const { publicationGeneration, publicationTicket } = beginTerrainTilePublication(
            tileX,
            tileZ,
        );
        const sourceRevision = `terrain:${reference.revision}:${surfaceSignature}`;
        const request = {
            requestKey: terrainPublicationKey(tileX, tileZ),
            compilerId: TERRAIN_PACKET_COMPILER_ID,
            compilerVersion: TERRAIN_PACKET_COMPILER_VERSION,
            sourceRevision,
            requiredStates: { terrain: reference.revision },
            generation: publicationGeneration,
            priority: 1e12 - job.ring * 1e8,
            tile: terrainPacketTile(tileX, tileZ),
            inputs: {
                snapshotRevision: reference.revision,
                tileX,
                tileZ,
                tileM: TILE_M,
                segments: tileMeshSegments(tileX, tileZ),
                uvPerM: terrainUvPerM,
                renderOrder: GROUND_STENCIL_READER_RENDER_ORDER,
            },
        };
        let compileHandle;
        try {
            compileHandle = renderCompiler.compile(request);
        } catch (error) {
            publicationTicket?.discard?.('terrain-compile-refused');
            if (isTerrainCompilerStateFailure(error)) {
                // A failed shared state is not thousands of independent bad
                // tiles. Retain the backlog and stop until a new install.
                terrainCompilerSnapshotFailure = error;
                pendingTileBuilds.unshift(job);
                rejectTerrainBuildWaiters(error);
                console.error(`[${new Date().toISOString()}] [terrain] Worker state unavailable`, error);
                return;
            }
            terrainTileBuildFailures.set(job.key, error);
            console.error(logStamp(), `[terrain] Worker refused tile ${job.key}`, error);
            notifyTerrainBuildWaiters();
            continue;
        }
        const build = {
            job,
            tileX,
            tileZ,
            surfaceSignature,
            publicationGeneration,
            publicationTicket,
            compileHandle,
            ground: terrainCompilerReadSnapshot,
            uploadController: new AbortController(),
        };
        activeTileBuild = build;
        compileHandle.promise
            .then(async (packet) => {
                if (activeTileBuild !== build) return;
                if (surfaceSignature !== terrainTileSurfaceSignature(tileX, tileZ)) {
                    publicationTicket?.discard?.('terrain-signature-stale');
                    return;
                }
                const root = await runTerrainGridPrepIterator(
                    createTerrainTileRootSteps(
                        packet,
                        tileX,
                        tileZ,
                        surfaceSignature,
                        publicationGeneration,
                    ),
                    {
                        signal: build.uploadController.signal,
                        label: `${job.key}:packet-upload`,
                        priority: request.priority,
                        disposeResult: disposeTerrainTileMesh,
                        maxItemsPerFrame: 1,
                    },
                );
                if (activeTileBuild !== build
                    || surfaceSignature !== terrainTileSurfaceSignature(tileX, tileZ)) {
                    disposeTerrainTileMesh(root);
                    if (publicationTicket?.state === 'pending') publicationTicket.discard('terrain-upload-stale');
                    return;
                }
                let batch, queryTx;
                try {
                    const primitive = packet.primitives[0], lattice = primitive.terrainLattice;
                    queryTx = await runTerrainGridPrepIterator(publishedTerrain.prepareSteps([{
                        snapshot: build.ground, tileX, tileZ, segments: request.inputs.segments,
                        positions: lattice.positions, indices: lattice.indices,
                        receiver: { positions: primitive.positions, indices: primitive.indices,
                            sourceTriangleOffsets: lattice.sourceTriangleOffsets },
                    }], { reason: 'terrain-bootstrap' }), { signal: build.uploadController.signal,
                        label: `${job.key}:query-preparation`, priority: request.priority, disposeResult: value => value.discard() });
                    batch = surfacePublications.prepareBatch([
                        prepareTerrainTilePublication(build, root),
                        { ticket: surfacePublications.begin({ key: 'terrain:published-query', generation: ++terrainPublicationGeneration }),
                            clear: true, isCurrent: () => activeTileBuild === build && queryTx.isCurrent(),
                            commit: () => queryTx.commit(), rollback: () => queryTx.rollback(), discard: () => queryTx.discard() },
                    ]);
                } catch (error) {
                    queryTx?.discard();
                    // The registry owns disposal once it has staged/rejected
                    // the entry. An earlier adapter/argument error still
                    // leaves the detached upload in this builder's ownership.
                    if (publicationTicket.state === 'pending') disposeTerrainTileMesh(root);
                    throw error;
                }
                if (batch.state !== 'staged') return;
                build.preparedPublication = batch;
                try {
                    const onPublished = () => queryTx.notify();
                    build.framePublication = groundPublications.enqueue(batch, { onPublished })
                        || await runTerrainGridPrepIterator(
                            enqueueTerrainPublicationSteps(build, batch, groundPublications, onPublished),
                            { signal: build.uploadController.signal,
                                label: `${job.key}:publication-slot`, priority: request.priority,
                                maxItemsPerFrame: 1,
                                disposeResult: ticket => ticket?.cancel('terrain-publication-cancelled') },
                        );
                    await build.framePublication.promise;
                } finally {
                    if (batch.state === 'staged') batch.discard('terrain-publication-cancelled');
                    build.preparedPublication = null;
                }
            })
            .catch((error) => {
                if (activeTileBuild !== build) return;
                if (publicationTicket?.state === 'pending') {
                    publicationTicket.discard('terrain-compile-failed');
                }
                if (error?.code === 'state-superseded'
                    || (isTerrainCompilerStateFailure(error)
                        && request.inputs.snapshotRevision !== reference?.revision)) {
                    // The new snapshot can replace an unchanged tile's queued
                    // request too. Recreate that one job against the new state;
                    // already-published tiles are never rebuilt globally here.
                    if (!pendingTileBuilds.some(pending => pending.key === job.key)) pendingTileBuilds.unshift(job);
                    return;
                }
                if (isTerrainCompilerStateFailure(error)) {
                    terrainCompilerSnapshotFailure = error;
                    if (!pendingTileBuilds.some(pending => pending.key === job.key)) pendingTileBuilds.unshift(job);
                    rejectTerrainBuildWaiters(error);
                    console.error(`[${new Date().toISOString()}] [terrain] Worker state failed`, error);
                    return;
                }
                if (!isExpectedCompilerCancellation(error)) {
                    terrainTileBuildFailures.set(job.key, error);
                    console.error(logStamp(), `[terrain] Worker compilation failed for ${job.key}`, error);
                }
            })
            .finally(() => {
                if (activeTileBuild === build) activeTileBuild = null;
                notifyTerrainBuildWaiters();
                pumpTerrainTileBuilds();
            });
        return;
    }
    notifyTerrainBuildWaiters();
}

function prioritizePendingTerrainBuilds(
    focusX,
    focusZ,
    { supportX = focusX, supportZ = focusZ, force = false } = {},
) {
    const safeX = finiteOrNull(focusX) ?? 0;
    const safeZ = finiteOrNull(focusZ) ?? 0;
    const safeSupportX = finiteOrNull(supportX) ?? safeX;
    const safeSupportZ = finiteOrNull(supportZ) ?? safeZ;
    const signature = `${Math.round(safeX / 25)}:${Math.round(safeZ / 25)}`
        + `:${Math.floor(safeSupportX / TILE_M)}:${Math.floor(safeSupportZ / TILE_M)}`;
    if (!force && signature === terrainBuildPrioritySignature) return;
    terrainBuildPriorityX = safeX;
    terrainBuildPriorityZ = safeZ;
    terrainBuildSupportX = safeSupportX;
    terrainBuildSupportZ = safeSupportZ;
    terrainBuildPrioritySignature = signature;
    pendingTileBuilds.sort((left, right) => {
        // Preserve the tile actually carrying the chassis, then point every
        // remaining build slot down the velocity corridor. The old ring-first
        // order built behind and beside a fast car before the next forward tile.
        const leftSupportDistance = tileDistanceSqToPoint(
            left.tileX,
            left.tileZ,
            terrainBuildSupportX,
            terrainBuildSupportZ,
            TILE_M,
        );
        const rightSupportDistance = tileDistanceSqToPoint(
            right.tileX,
            right.tileZ,
            terrainBuildSupportX,
            terrainBuildSupportZ,
            TILE_M,
        );
        if (leftSupportDistance === 0 && rightSupportDistance !== 0) return -1;
        if (rightSupportDistance === 0 && leftSupportDistance !== 0) return 1;
        const leftDistance = tileDistanceSqToPoint(
            left.tileX,
            left.tileZ,
            terrainBuildPriorityX,
            terrainBuildPriorityZ,
            TILE_M,
        );
        const rightDistance = tileDistanceSqToPoint(
            right.tileX,
            right.tileZ,
            terrainBuildPriorityX,
            terrainBuildPriorityZ,
            TILE_M,
        );
        return leftDistance - rightDistance
            || (Number(left.ring) || 0) - (Number(right.ring) || 0)
            || left.key.localeCompare(right.key);
    });
}

function ensureAround(
    localX,
    localZ,
    _buildBudgetMs = 0,
    priorityFocus = null,
    surfacePreload = null,
) {
    if (!reference || !terrainGroup) return;
    const centerX = Math.floor(localX / TILE_M);
    const centerZ = Math.floor(localZ / TILE_M);
    const moved = centerX !== lastTileX || centerZ !== lastTileZ;
    const requestedPinnedSignature = String(surfacePreload?.signature || '');
    const pinnedChanged = requestedPinnedSignature
        && requestedPinnedSignature !== terrainPinnedSignature;
    if (pinnedChanged) {
        terrainPinnedSignature = requestedPinnedSignature;
        terrainPinnedTileKeys = new Set((surfacePreload.points || [])
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.z))
            .map(point => (
                `${Math.floor(point.x / TILE_M)}_${Math.floor(point.z / TILE_M)}`
            )));
    }
    if (moved || pinnedChanged) {
        lastTileX = centerX;
        lastTileZ = centerZ;
        const desiredTiles = new Map();
        for (let dz = -FETCH_RING; dz <= FETCH_RING; dz++) {
            for (let dx = -FETCH_RING; dx <= FETCH_RING; dx++) {
                const key = `${centerX + dx}_${centerZ + dz}`;
                desiredTiles.set(key, {
                    key,
                    tileX: centerX + dx,
                    tileZ: centerZ + dz,
                    ring: Math.max(Math.abs(dx), Math.abs(dz)),
                });
            }
        }
        for (const key of terrainPinnedTileKeys) {
            if (desiredTiles.has(key)) continue;
            const [tileX, tileZ] = key.split('_').map(Number);
            desiredTiles.set(key, {
                key,
                tileX,
                tileZ,
                ring: Math.max(Math.abs(tileX - centerX), Math.abs(tileZ - centerZ)),
            });
        }
        // Crossing a 400 m tile boundary used to cancel the one terrain worker
        // compile already in flight even when that tile remained inside the new
        // 7×7 window (or the pinned campaign corridor). A fast car could keep
        // throwing away nearly-complete forward tiles until it stopped. Retain
        // valid work and only cancel a tile that genuinely left the window or
        // whose surface generation changed.
        const activeKey = activeTileBuild?.job?.key || null;
        const activeStillDesired = !!activeKey
            && desiredTiles.has(activeKey)
            && activeTileBuild.surfaceSignature === terrainTileSurfaceSignature(
                activeTileBuild.tileX,
                activeTileBuild.tileZ,
            );
        if (activeTileBuild && !activeStillDesired) {
            discardActiveTerrainTileBuild('terrain-window-shifted');
        }
        pendingTileBuilds = [];
        for (const job of desiredTiles.values()) {
            if (activeStillDesired && job.key === activeKey) continue;
            const mesh = tiles.get(job.key);
            const signature = terrainTileSurfaceSignature(job.tileX, job.tileZ);
            if (mesh?.userData?.terrainSurfaceSignature === signature) continue;
            pendingTileBuilds.push({ ...job, rebuild: !!mesh });
        }
        for (const key of [...tiles.keys()]) {
            const [tileX, tileZ] = key.split('_').map(Number);
            if (Math.abs(tileX - centerX) > KEEP_RING || Math.abs(tileZ - centerZ) > KEEP_RING) {
                if (!terrainPinnedTileKeys.has(key)) removeTile(key);
            }
        }
        if (groundManaged) groundCoordinator.invalidate('terrain-window', { reason: 'terrain-window-moved' });
    }
    prioritizePendingTerrainBuilds(
        finiteOrNull(priorityFocus?.x) ?? localX,
        finiteOrNull(priorityFocus?.z) ?? localZ,
        { supportX: localX, supportZ: localZ, force: moved },
    );
    pumpTerrainTileBuilds();
}

function queueTerrainTileRebuild(localX, localZ, {
    changedTileKeys = null,
    invalidateAll = false,
} = {}) {
    if (invalidateAll) {
        terrainSurfaceEpoch += 1;
        terrainTileSurfaceRevisions.clear();
        terrainTileBuildFailures.clear();
    }
    const currentX = Math.floor(localX / TILE_M);
    const currentZ = Math.floor(localZ / TILE_M);
    const queued = new Map();
    const changed = invalidateAll
        ? new Set(tiles.keys())
        : new Set(Array.isArray(changedTileKeys) ? changedTileKeys : []);
    if (!invalidateAll) {
        for (const key of changed) {
            terrainTileBuildFailures.delete(key);
            terrainTileSurfaceRevisions.set(
                key,
                (terrainTileSurfaceRevisions.get(key) || 0) + 1,
            );
        }
    }
    for (const key of changed) {
        if (!tiles.has(key)) continue;
        const [tileX, tileZ] = key.split('_').map(Number);
        queued.set(key, {
            key,
            tileX,
            tileZ,
            rebuild: true,
            ring: Math.max(Math.abs(tileX - currentX), Math.abs(tileZ - currentZ)),
        });
    }
    const interruptActive = !!activeTileBuild
        && (invalidateAll || changed.has(activeTileBuild.job.key));
    const interruptedJob = interruptActive ? activeTileBuild.job : null;
    if (interruptActive) discardActiveTerrainTileBuild('terrain-surface-revised');
    // A terrain revision must not discard not-yet-built tiles from the current
    // visibility ring.  Keep those jobs behind the near-to-far rebuilds.
    for (const task of [interruptedJob, ...pendingTileBuilds]) {
        if (!task) continue;
        if (queued.has(task.key)) continue;
        const [tileX, tileZ] = task.key.split('_').map(Number);
        queued.set(task.key, {
            key: task.key,
            tileX,
            tileZ,
            rebuild: tiles.has(task.key),
            ring: Math.max(Math.abs(tileX - currentX), Math.abs(tileZ - currentZ)),
        });
    }
    pendingTileBuilds = [...queued.values()];
    prioritizePendingTerrainBuilds(
        terrainBuildPriorityX,
        terrainBuildPriorityZ,
        { force: true },
    );
    pumpTerrainTileBuilds();
}

function handleTerrainSourceChange(_revision, change) {
    const bounds = change?.bounds || [];
    const sourceKeys = new Set(change?.changedTileKeys || []);
    const keys = new Set();
    // A source patch includes shared lattice knots and interpolation near its
    // edge. Rebuild the adjacent tile on both sides of those knots, including
    // the corner neighbours, instead of discovering a stale edge after upload.
    // Only resident/pending receivers need revision entries. An enormous
    // source rectangle must not enumerate an enormous invisible tile grid.
    const candidates = new Set(tiles.keys());
    for (const row of pendingTileBuilds) candidates.add(row.key);
    for (const row of terrainGroundGenerationLease?.admission?.rows || []) candidates.add(row.key);
    for (const key of candidates) {
        const [x,z] = key.split('_').map(Number);
        let affected = bounds.some(b => b.minX <= (x+2)*TILE_M && b.maxX >= (x-1)*TILE_M
            && b.minZ <= (z+2)*TILE_M && b.maxZ >= (z-1)*TILE_M);
        for (let dx=-1;dx<=1&&!affected;dx++) for (let dz=-1;dz<=1;dz++) {
            if (sourceKeys.has(`${x+dx}_${z+dz}`)) { affected = true; break; }
        }
        if (affected) keys.add(key);
    }
    const full = !bounds.length && !sourceKeys.size;
    queueTerrainTileRebuild(change?.focus?.x ?? lastTileX*TILE_M, change?.focus?.z ?? lastTileZ*TILE_M,
        { changedTileKeys: [...keys], invalidateAll: full });
    groundCoordinator?.invalidate('terrain', { bounds, keys: [...keys], full, reason: change?.reason || 'terrain-source' });
    if (terrainGroundGenerationLease) return;
    void installTerrainCompilerSnapshot().catch(error => {
        console.error(`[${new Date().toISOString()}] [terrain] failed to install Worker snapshot`, error);
    });
}

function composeTerrainWindow(baseGrid, preparedDetail = null) {
    if (!preparedDetail) return { grid: baseGrid, detail: null };
    return {
        grid: new CompositeTerrainGrid(baseGrid, preparedDetail.grids, {
            sourceBoundaries: preparedDetail.sourceBoundaries,
        }),
        detail: preparedDetail.detail,
    };
}

async function prepareTerrainDetailWindow(
    baseGrid,
    detailPayloads,
    detailConfig,
    anchorLon,
    anchorLat,
    { signal = null, priority = 0 } = {},
) {
    const stepM = Number(detailConfig?.meshStepM) || 4;
    if (detailPayloads.length === 0 || !(stepM > 0) || TILE_M % stepM !== 0) return null;
    const grids = [];
    const rects = [];
    for (const payload of detailPayloads) {
        const detailGrid = new TerrainGrid(payload.metadata, payload.arrayBuffer, {
            sourceArrayBuffer: payload.sourceArrayBuffer,
        });
        const rect = detailSurfaceRect(detailGrid, anchorLon, anchorLat);
        if (!rect) continue;
        grids.push(detailGrid);
        rects.push(rect);
    }
    if (rects.length === 0) return null;
    const composite = await runTerrainGridPrepIterator(
        createCompositeTerrainGridBuildIterator(baseGrid, grids),
        { signal, label: 'terrain-detail-source-boundary', priority },
    );
    return {
        grids,
        sourceBoundaries: composite.sourceBoundaryIndexSnapshot(),
        detail: { stepM, tileM: TILE_M, rects },
    };
}

function linkedAbortController(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    return {
        controller,
        unlink: () => signal?.removeEventListener?.('abort', abort),
    };
}

function streamedTerrainBaseGrid(state) {
    return new MosaicTerrainGrid([...state.loadedTiles.values()].map(entry => ({
        key: entry.descriptor.key,
        coreBounds: entry.descriptor.coreBounds,
        grid: entry.grid,
    })));
}

function terrainGridRequestPriority(state, descriptor, critical = false) {
    if (critical) {
        return { tier: 'critical', tierRank: 5, distanceSq: 0, score: 5e12 };
    }
    return classifyViewPriority(
        terrainGridTileLocalBounds(descriptor, state.ctx.anchorLon, state.ctx.anchorLat),
        {
            observerX: state.focusX,
            observerZ: state.focusZ,
            headingDeg: state.headingDeg,
            fovDeg: state.fovDeg,
        },
    );
}

function requestTerrainGridTile(state, descriptor, { critical = false } = {}) {
    if (state.closed || state.signal?.aborted) return null;
    if (state.loadedTiles.has(descriptor.key)) return null;
    const existing = state.requests.get(descriptor.key);
    if (existing) return existing.promise;
    const { controller, unlink } = linkedAbortController(state.signal);
    const progressKey = `terrain-grid-base-${descriptor.key}`;
    const entry = {
        descriptor,
        controller,
        unlink,
        promise: null,
    };
    entry.promise = fetchTrackedTerrainGridApi(
        progressKey,
        getApiBase(),
        descriptor,
        {
            signal: controller.signal,
            requestScheduler: state.ctx.sharedTileSession,
            supportLane: true,
            requestPriority: () => terrainGridRequestPriority(state, descriptor, critical),
            onProgress: ({ receivedBytes, totalBytes }) => (
                noteWorldBuildProgress(progressKey, receivedBytes, totalBytes)
            ),
        },
    ).then((payload) => {
        if (state.closed || controller.signal.aborted) {
            throw new DOMException('Terrain grid tile no longer needed', 'AbortError');
        }
        const grid = new TerrainGrid(payload.metadata, payload.arrayBuffer, {
            sourceArrayBuffer: payload.sourceArrayBuffer,
        });
        if (state.pinnedBaseTileKeys?.has(descriptor.key)
            || terrainGridTileRingDistance(descriptor, state.center)
                <= TERRAIN_GRID_KEEP_RING) {
            state.loadedTiles.set(descriptor.key, { descriptor, grid });
        }
        return descriptor;
    }).catch((error) => {
        if (critical && error?.status === 404) noteTerrainCoverage('missing');
        throw error;
    }).finally(() => {
        unlink();
        if (state.requests.get(descriptor.key) === entry) {
            state.requests.delete(descriptor.key);
        }
    });
    state.requests.set(descriptor.key, entry);
    return entry.promise;
}

function terrainMeshTileKeysWithin(boundsList) {
    const keys = new Set();
    for (const bounds of boundsList) {
        if (!bounds) continue;
        const minX = Math.floor(Number(bounds.minX) / TILE_M);
        const maxX = Math.floor((Number(bounds.maxX) - 1e-6) / TILE_M);
        const minZ = Math.floor(Number(bounds.minZ) / TILE_M);
        const maxZ = Math.floor((Number(bounds.maxZ) - 1e-6) / TILE_M);
        if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;
        for (let tileZ = minZ; tileZ <= maxZ; tileZ++) {
            for (let tileX = minX; tileX <= maxX; tileX++) {
                keys.add(`${tileX}_${tileZ}`);
            }
        }
    }
    return [...keys];
}

function pruneStreamedTerrainTiles(state) {
    const outside = [...state.loadedTiles.values()].filter(entry => (
        !state.pinnedBaseTileKeys?.has(entry.descriptor.key)
        && terrainGridTileRingDistance(entry.descriptor, state.center)
            > TERRAIN_GRID_KEEP_RING
    ));
    // During a teleport retain the old mosaic until at least one cell around
    // the new camera has arrived. A bounded stale surface is safer than
    // replacing the TerrainReference with no evidence at all.
    if (outside.length >= state.loadedTiles.size) return [];
    for (const entry of outside) state.loadedTiles.delete(entry.descriptor.key);
    return outside.map(entry => entry.descriptor);
}

function publishStreamedTerrainBaseChange(state, descriptors, pose, local) {
    if (state.closed || terrainGridStreamState !== state || !reference
        || state.loadedTiles.size === 0) return;
    const unique = [...new Map(
        descriptors.filter(Boolean).map(descriptor => [descriptor.key, descriptor]),
    ).values()];
    if (unique.length === 0) return;
    const baseGrid = streamedTerrainBaseGrid(state);
    // The detail provenance index was prepared cooperatively when the window
    // arrived. Fixed base cells are deterministic, so a new mosaic wrapper can
    // reuse that immutable index instead of rescanning two million detail cells
    // after every base-ring change.
    const composed = composeTerrainWindow(baseGrid, state.preparedDetail);
    const changedBounds = unique.map(descriptor => terrainGridTileLocalBounds(
        descriptor,
        state.ctx.anchorLon,
        state.ctx.anchorLat,
    )).filter(Boolean);
    const changedTileKeys = terrainMeshTileKeysWithin(changedBounds);
    reference.replaceGrid(composed.grid, {
        detail: composed.detail,
        changedBounds,
        changedTileKeys,
        reason: 'streamed-base-tiles',
        focus: {
            x: local.x,
            z: local.z,
            lat: pose.lat,
            lon: pose.lon,
        },
    });
    console.log(logStamp(), 
        `[terrain] base mosaic revision ${reference.revision}: `
        + `${state.loadedTiles.size} cached cell(s), ${changedTileKeys.length} render tile(s) changed`,
    );
}

function ensureStreamedTerrainWindow(state, pose, local, { force = false } = {}) {
    const longitude = finiteOrNull(pose?.lon);
    const latitude = finiteOrNull(pose?.lat);
    if (state.closed || !pose || !local || longitude == null || latitude == null) return;
    state.focusX = Number(local.x) || 0;
    state.focusZ = Number(local.z) || 0;
    state.latestPose = {
        lat: latitude,
        lon: longitude,
        headingDeg: finiteOrNull(pose.headingDeg) ?? state.headingDeg,
    };
    state.latestLocal = { x: state.focusX, z: state.focusZ };
    const headingDeg = finiteOrNull(pose.headingDeg);
    if (headingDeg != null) state.headingDeg = headingDeg;
    const center = terrainGridTileIndex(longitude, latitude);
    const centerChanged = center.tx !== state.center.tx || center.ty !== state.center.ty;
    const desired = terrainGridTilesAround(longitude, latitude, {
        ring: TERRAIN_GRID_FETCH_RING,
        source: state.config.source,
    });
    const missing = desired.some(descriptor => (
        !state.loadedTiles.has(descriptor.key) && !state.requests.has(descriptor.key)
    ));
    const now = Date.now();
    if (!force && !centerChanged
        && (!missing || now - state.lastEnsureAtMs < TERRAIN_GRID_RETRY_MS)) return;
    state.center = center;
    state.lastEnsureAtMs = now;
    // Every asynchronous completion belongs to exactly one desired camera
    // window. A later centre/retry may reuse the same in-flight requests, but
    // only its newest batch may publish their changed bounds. Without this
    // token, old Promise.allSettled callbacks reopened 1,000+ road stages near
    // the end of a stopped Zagreb walk, long after their window was obsolete.
    const requestToken = ++state.baseRequestToken;

    for (const entry of state.requests.values()) {
        if (!state.pinnedBaseTileKeys?.has(entry.descriptor.key)
            && terrainGridTileRingDistance(entry.descriptor, center)
                > TERRAIN_GRID_KEEP_RING) {
            entry.controller.abort(new DOMException('Terrain grid tile left the window', 'AbortError'));
        }
    }
    const changed = pruneStreamedTerrainTiles(state);
    const requested = desired.map(descriptor => (
        requestTerrainGridTile(state, descriptor)
    )).filter(Boolean);
    if (requested.length === 0) {
        publishStreamedTerrainBaseChange(state, changed, pose, local);
        return;
    }
    Promise.allSettled(requested).then((results) => {
        if (state.closed || terrainGridStreamState !== state
            || requestToken !== state.baseRequestToken) return;
        for (const result of results) {
            if (result.status === 'fulfilled') changed.push(result.value);
            else if (result.reason?.name !== 'AbortError') {
                console.warn(logStamp(), '[terrain] fixed base tile unavailable; retaining loaded mosaic', result.reason);
            }
        }
        changed.push(...pruneStreamedTerrainTiles(state));
        publishStreamedTerrainBaseChange(
            state,
            changed,
            state.latestPose || pose,
            state.latestLocal || local,
        );
    });
}

// The moving window follows the same projected lead point the road builders
// use, so at speed the 1 m ground is requested ahead of the car rather than
// around it.
function detailRefreshTarget(pose, local) {
    const focus = pose?.surfaceStreamingFocus;
    const focusX = finiteOrNull(focus?.x);
    const focusZ = finiteOrNull(focus?.z);
    if (focusX !== null && focusZ !== null) return { x: focusX, z: focusZ };
    return { x: Number(local.x), z: Number(local.z) };
}

function detailWindowBounds(target, detailConfig) {
    const halfSizeM = Number(detailConfig?.halfSizeM) || 600;
    return {
        minX: target.x - halfSizeM,
        maxX: target.x + halfSizeM,
        minZ: target.z - halfSizeM,
        maxZ: target.z + halfSizeM,
    };
}

// The gate's expiry: a window that has not landed within the allowance gives
// the base back as evidence and stays disarmed until a window does land, so a
// fast car or a slow server degrades to today's publish-then-refine rather
// than to an undrawn road ahead.
function releaseExpiredDetailEvidenceGate(state) {
    if (!state || !reference?.pendingDetailWindow) return;
    const plan = planDetailEvidenceGate({
        action: 'none',
        armed: state.detailGateArmed,
        pendingSinceMs: state.detailGateSinceMs,
        nowMs: Date.now(),
        maxMs: detailEvidenceGateAllowanceMs(getFrameChunkWorkMotionState()),
    });
    if (plan.gate !== 'release') return;
    state.detailGateArmed = false;
    state.detailGateSinceMs = null;
    reference.clearPendingDetailWindow({ reason: plan.reason });
}

function beginStreamedTerrainDetailRefresh(state, pose, local, { force = false } = {}) {
    if (state.closed || state.detailPinned || !state.detailConfig
        || !reference || !pose || !local) return;
    const target = detailRefreshTarget(pose, local);
    const refreshPlan = planTerrainDetailRefresh({
        inFlight: state.detailInFlight,
        inFlightCenter: {
            x: state.detailRequestCenterX,
            z: state.detailRequestCenterZ,
        },
        publishedCenter: {
            x: state.detailCenterX,
            z: state.detailCenterZ,
        },
    }, target, {
        force,
        refreshDistanceM: MOVING_DETAIL_REFRESH_M,
    });
    if (refreshPlan.action === 'none' || refreshPlan.action === 'keep') return;
    if (refreshPlan.action === 'replace') {
        state.detailRequestToken += 1;
        state.detailController?.abort(
            new DOMException('Terrain detail request left the camera window', 'AbortError'),
        );
        state.detailController = null;
        state.detailInFlight = false;
    }
    const now = Date.now();
    if (!force && now - state.lastDetailAttemptAtMs < TERRAIN_GRID_RETRY_MS) return;
    state.lastDetailAttemptAtMs = now;
    const requestToken = ++state.detailRequestToken;
    const detailController = new AbortController();
    const abortForSession = () => detailController.abort(
        state.signal?.reason || new DOMException('Terrain session closed', 'AbortError'),
    );
    if (state.signal?.aborted) abortForSession();
    else state.signal?.addEventListener?.('abort', abortForSession, { once: true });
    const targetGeo = reference.lonLatAtLocal(target.x, target.z);
    const requestCtx = {
        ...state.ctx,
        anchorLat: Number(targetGeo.lat),
        anchorLon: Number(targetGeo.lon),
        customTrackCorridors: [],
    };
    state.detailInFlight = true;
    state.detailController = detailController;
    state.detailRequestCenterX = target.x;
    state.detailRequestCenterZ = target.z;
    // Until this window merges, the 20 m base inside it is not evidence:
    // roads, rails and buildings there wait for the 1 m surface instead of
    // publishing twice. A superseding request keeps the existing gate rather
    // than starting a new one, and every gate expires (see the onFrame valve).
    const gatePlan = planDetailEvidenceGate({
        action: refreshPlan.action,
        armed: state.detailGateArmed,
        pendingSinceMs: state.detailGateSinceMs,
        nowMs: now,
        maxMs: detailEvidenceGateAllowanceMs(getFrameChunkWorkMotionState()),
    });
    if (gatePlan.gate === 'set') {
        reference.setPendingDetailWindow(detailWindowBounds(target, state.detailConfig));
        state.detailGateSinceMs = now;
    }
    fetchDetailGrids(requestCtx, state.config, detailController.signal)
        .then(async (detailPayloads) => {
            if (state.closed || terrainGridStreamState !== state
                || requestToken !== state.detailRequestToken || detailController.signal.aborted) return;
            const previousDetail = reference.detail
                ? {
                    stepM: reference.detail.stepM,
                    tileM: reference.detail.tileM,
                    rects: reference.detail.rects.map(rect => ({ ...rect })),
                }
                : null;
            const preparedDetail = await prepareTerrainDetailWindow(
                streamedTerrainBaseGrid(state),
                detailPayloads,
                state.detailConfig,
                state.ctx.anchorLon,
                state.ctx.anchorLat,
                {
                    signal: detailController.signal,
                    priority: { score: 4e12 },
                },
            );
            if (state.closed || terrainGridStreamState !== state
                || requestToken !== state.detailRequestToken || detailController.signal.aborted) return;
            // Keep the windows just left behind: their tiles stay fine and
            // nothing on them rebuilds. Bounded by count and distance.
            const retainedDetails = preparedDetail
                ? retainTrailingDetailWindows(
                    [state.currentDetail, ...state.retainedDetails].filter(Boolean),
                    { nextCenter: target, maxRetained: TRAILING_DETAIL_WINDOWS,
                        maxDistanceM: trailingDetailKeepDistanceM(state.detailConfig) },
                )
                : [];
            const mergedDetail = mergePreparedDetails(
                preparedDetail,
                retainedDetails.map(entry => entry.preparedDetail),
            );
            // Base cells may have landed while the provenance index was being
            // sliced. Wrap the latest mosaic at publication time; the previous
            // complete reference remains visible until this point.
            const composed = composeTerrainWindow(
                streamedTerrainBaseGrid(state),
                mergedDetail,
            );
            const nextReference = new TerrainReference(
                composed.grid,
                reference.anchorLon,
                reference.anchorLat,
                {
                    fallbackHeightM: reference.fallbackHeightM,
                    surfaceStepM: reference.surfaceStepM,
                    detail: composed.detail,
                },
            );
            nextReference.anchorHeightM = reference.anchorHeightM;
            const detailChange = planTerrainDetailChange(previousDetail, composed.detail, {
                tileM: TILE_M,
                previousSurfaceSignature: key => sampledTerrainTileSurfaceSignature(
                    reference,
                    key,
                    { tileM: TILE_M },
                ),
                nextSurfaceSignature: key => sampledTerrainTileSurfaceSignature(
                    nextReference,
                    key,
                    { tileM: TILE_M },
                ),
            });
            state.detailCenterX = target.x;
            state.detailCenterZ = target.z;
            state.detailGateArmed = true;
            state.detailGateSinceMs = null;
            if (detailChange.noOp) {
                // Nothing to merge (no fine data here, or an identical window):
                // the base IS the surface, so release the withheld evidence.
                reference.clearPendingDetailWindow({ reason: 'detail-window-settled' });
                return;
            }
            state.preparedDetail = mergedDetail;
            state.currentDetail = preparedDetail
                ? { preparedDetail, centerX: target.x, centerZ: target.z, publishedAt: Date.now() }
                : null;
            state.retainedDetails = retainedDetails;
            reference.clearPendingDetailWindow({ notify: false });
            reference.replaceGrid(composed.grid, {
                detail: composed.detail,
                changedBounds: detailChange.changedBounds,
                changedTileKeys: detailChange.changedTileKeys,
                reason: 'moving-detail-window',
                focus: {
                    x: target.x,
                    z: target.z,
                    lat: targetGeo.lat,
                    lon: targetGeo.lon,
                },
            });
            console.log(logStamp(), 
                `[terrain] detail revision ${reference.revision} at `
                + `${Number(targetGeo.lat).toFixed(5)},${Number(targetGeo.lon).toFixed(5)}`
                + ` · ${detailChange.changedTileKeys.length} terrain tile(s) changed`,
            );
        })
        .catch(error => {
            if (error?.name !== 'AbortError') {
                console.warn(logStamp(), '[terrain] detail window refresh failed; retaining the base mosaic', error);
            }
            // A superseding request owns the pending window now; only the
            // current one releases it, so the base becomes evidence again.
            if (reference && terrainGridStreamState === state
                && requestToken === state.detailRequestToken) {
                // A window that cannot land must not keep the road ahead
                // undrawn: the base is evidence again until one does land.
                state.detailGateArmed = false;
                state.detailGateSinceMs = null;
                reference.clearPendingDetailWindow({ reason: 'detail-window-failed' });
            }
        })
        .finally(() => {
            state.signal?.removeEventListener?.('abort', abortForSession);
            if (terrainGridStreamState === state && requestToken === state.detailRequestToken) {
                state.detailInFlight = false;
                state.detailController = null;
            }
        });
}

function clearTerrain() {
    if (terrainGroundGenerationLease) {
        terrainGroundGenerationLease.resume = false;
        terrainGroundGenerationLease.cancel();
    }
    terrainDeferredEvictions.clear();
    groundCoordinator = null;
    groundManaged = false;
    publishedTerrain?.close(); publishedTerrain = null; sessionTerrain = null;
    clearRoadFormationMask();
    clearUrbanGround();
    terrainSurfaceEpoch += 1;
    terrainTileSurfaceRevisions.clear();
    pendingTileBuilds = [];
    terrainBuildPriorityX = 0;
    terrainBuildPriorityZ = 0;
    terrainBuildSupportX = 0;
    terrainBuildSupportZ = 0;
    terrainBuildPrioritySignature = null;
    terrainPinnedSignature = null;
    terrainPinnedTileKeys = new Set();
    discardActiveTerrainTileBuild('terrain-layer-cleared');
    terrainCompilerSnapshotFailure = null;
    terrainTileBuildFailures.clear();
    rejectTerrainBuildWaiters(terrainAbortError('Terrain layer cleared'));
    terrainCompilerChangeSubscription?.();
    terrainCompilerChangeSubscription = null;
    for (const compiler of terrainRenderCompilers) compiler.clearState?.('terrain');
    for (const key of [...tiles.keys()]) removeTile(key);
    if (terrainGroup) {
        disposeGroup(terrainGroup);
        terrainGroup = null;
    }
    if (terrainMaterial) {
        retireTerrainMaterial(terrainMaterial);
        terrainMaterial = null;
        terrainUvPerM = 1 / 16;
    }
    retireTerrainMaterial(terrainExactFormationMaterial);
    terrainExactFormationMaterial = null;
    if (groundMesh) groundMesh.visible = previousGroundVisible;
    reference = null;
    terrainCompilerReadSnapshot = null;
    groundPublications = null;
    groundPaint = null;
    renderCompiler = null;
    terrainRenderCompilers = [];
    lastTileX = null;
    lastTileZ = null;
    if (terrainGridStreamState) {
        terrainGridStreamState.closed = true;
        terrainGridStreamState.detailRequestToken += 1;
        terrainGridStreamState.detailController?.abort(
            new DOMException('Terrain session closed', 'AbortError'),
        );
        terrainGridStreamState.detailController = null;
        for (const entry of terrainGridStreamState.requests.values()) {
            entry.controller.abort(new DOMException('Terrain session closed', 'AbortError'));
        }
        terrainGridStreamState.requests.clear();
        terrainGridStreamState.loadedTiles.clear();
        terrainGridStreamState.preparedDetail = null;
        terrainGridStreamState.currentDetail = null;
        terrainGridStreamState.retainedDetails = [];
        terrainGridStreamState = null;
    }
    terrainGridPrepQueue?.dispose();
    terrainGridPrepQueue = null;
    terrainSurfaceStyle = null;
    regionalStyleCenterX = Infinity;
    regionalStyleCenterZ = Infinity;
}

export const terrainLayer = {
    groundReady: () => !!reference && !!terrainGroup && !!publishedTerrain && !activeTileBuild
        && !terrainGroundGenerationLease && !roadMaskBuildTask && !roadMaskPublication
        && terrainCompilerReadSnapshot?.revision === reference?.revision,
    connectGroundCoordinator(coordinator) { groundCoordinator = coordinator; },
    manageGroundPublications(coordinator) { groundCoordinator = coordinator; groundManaged = true; },
    *groundScopeSteps({ maxChangedTiles }) {
        const pending = pendingTileBuilds, pinned = terrainPinnedTileKeys, x = lastTileX, z = lastTileZ;
        const scope = yield* selectTerrainGroundScopeSteps({ residentKeys: tiles.keys(), pendingJobs: pending,
            pinnedKeys: pinned, centerTileX: x, centerTileZ: z, keepRing: KEEP_RING, maxChangedTiles });
        if (pendingTileBuilds !== pending || terrainPinnedTileKeys !== pinned || lastTileX !== x || lastTileZ !== z) {
            throw Object.assign(new Error('Terrain window changed during scope selection'), { code: 'ground-generation-stale' });
        }
        // Managed jobs are plain request records; compiled candidates and their
        // leases belong to admission. Prune expired requests even if the next
        // publication fails, while preserving every pinned/current-window job.
        pendingTileBuilds = scope.pendingJobs;
        return { tileKeys: scope.tileKeys, removeKeys: scope.removeKeys };
    },
    prepareOwnershipGroundSteps: prepareGroundOwnershipGenerationSteps,
    admitGroundGeneration: admitTerrainGroundGeneration,
    prepareGroundGenerationSteps: prepareTerrainGroundGenerationSteps,
    async beginSession(ctx) {
        const token = ++generation;
        surfacePublications = ctx.surfacePublications || null;
        groundPublications = ctx.groundPublications || null;
        groundPaint = ctx.groundPaint || null;
        terrainRenderCompilers = [...new Set([
            ctx.renderCompiler,
            ...(Array.isArray(ctx.terrainRenderCompilers) ? ctx.terrainRenderCompilers : []),
        ].filter(Boolean))];
        renderCompiler = terrainRenderCompilers[0] || null;
        if (!isTerrainRequested(ctx.terrainPolicy)) {
            noteWorldPhase('terrain-data-ready');
            noteWorldPhase('terrain-decode-ready');
            return;
        }
        const config = getLocation().terrain;
        if (!config) {
            console.warn(logStamp(), '[terrain] requested, but this location has no terrain grid');
            return;
        }
        resetTerrainGridPrepQueue();
        try {
            if (!renderCompiler) {
                throw new Error('Terrain requires the Station3D render compiler Worker');
            }
            if (!surfacePublications || !groundPublications) {
                throw new Error('Terrain requires the shared ground publication boundary');
            }
            const signal = ctx.fetchController && ctx.fetchController.signal;
            // A campaign pack bake may bring a window the location itself
            // does not carry (core/terrain-detail-config.js).
            const detailConfig = resolveTerrainDetailConfig(config, ctx.campaignTerrainDetail || null);
            const detailSourceConfig = detailConfig ? { ...config, detail: detailConfig } : config;
            const campaignDriveSurfacePreload = ctx.campaignDriveSurfacePreload || null;
            // Where the coverage probe finds 1 m data, the anchor window is
            // part of the initial load and the 20 m step is skipped for that
            // area: nothing terrain-relative publishes on the coarse surface
            // and re-solves when the fine window lands seconds later. It runs
            // alongside the base cells; a failure leaves the base authoritative.
            let initialDetailOutcome = 'none';
            const initialDetailPayloads = detailConfig
                ? fetchDetailGrids(ctx, detailSourceConfig, signal)
                    .then((payloads) => {
                        initialDetailOutcome = payloads.length > 0 ? 'loaded' : 'none';
                        return payloads;
                    })
                    .catch((error) => {
                        if (error?.name === 'AbortError') return [];
                        initialDetailOutcome = 'failed';
                        console.warn(logStamp(), '[terrain] initial 1 m window unavailable; the base mosaic carries the start', error);
                        return [];
                    })
                : Promise.resolve([]);
            let baseGrid;
            let streamState = null;
            if (config.metadataUrl && config.dataUrl) {
                const basePayload = await fetchStaticGrid(config, signal);
                baseGrid = new TerrainGrid(basePayload.metadata, basePayload.arrayBuffer, {
                    sourceArrayBuffer: basePayload.sourceArrayBuffer,
                });
            } else {
                const center = terrainGridTileIndex(ctx.anchorLon, ctx.anchorLat);
                const campaignBaseDescriptors = campaignDriveTerrainGridDescriptors(
                    campaignDriveSurfacePreload,
                    {
                        anchorLat: ctx.anchorLat,
                        anchorLon: ctx.anchorLon,
                        source: config.source,
                    },
                );
                const pinnedBaseTileKeys = new Set(
                    campaignBaseDescriptors.map(descriptor => descriptor.key),
                );
                streamState = {
                    ctx,
                    config,
                    detailConfig,
                    signal,
                    center,
                    focusX: 0,
                    focusZ: 0,
                    headingDeg: Number(ctx.initialPose?.headingDeg) || 0,
                    fovDeg: 90,
                    loadedTiles: new Map(),
                    requests: new Map(),
                    baseRequestToken: 0,
                    preparedDetail: null,
                    // The newest window alone, and the windows kept behind it.
                    currentDetail: null,
                    retainedDetails: [],
                    detailCenterX: Infinity,
                    detailCenterZ: Infinity,
                    detailRequestCenterX: Infinity,
                    detailRequestCenterZ: Infinity,
                    detailRequestToken: 0,
                    detailInFlight: false,
                    detailController: null,
                    // Evidence gate bookkeeping (core/terrain-detail-change.js).
                    detailGateArmed: true,
                    detailGateSinceMs: null,
                    lastDetailAttemptAtMs: 0,
                    lastEnsureAtMs: 0,
                    latestPose: null,
                    latestLocal: null,
                    pinnedBaseTileKeys,
                    detailPinned: !!campaignDriveSurfacePreload,
                    closed: false,
                };
                const centerDescriptor = terrainGridTileDescriptor(center.tx, center.ty, {
                    source: config.source,
                });
                console.log(logStamp(), 
                    `[terrain] requesting startup cell ${centerDescriptor.key} `
                    + `(~${centerDescriptor.estimatedCells.toLocaleString()} cells); `
                    + 'the surrounding fixed window will load before dependent layers',
                );
                // Publish one complete initial terrain revision. Roads and
                // buildings may require samples just outside the centre cell;
                // starting them against a centre-only reference both forces
                // immediate rebuilds and can leave every build waiting for a
                // support cell that has not entered the network queue yet. Put
                // the whole finite window in the shared arbiter immediately;
                // awaiting the centre before even scheduling its neighbours
                // added a full network round trip to every production start.
                const ordinaryStartupDescriptors = terrainGridTilesAround(
                    ctx.anchorLon,
                    ctx.anchorLat,
                    {
                        ring: TERRAIN_GRID_FETCH_RING,
                        source: config.source,
                    },
                );
                const startupDescriptors = [...new Map([
                    ...ordinaryStartupDescriptors,
                    ...campaignBaseDescriptors,
                ].map(descriptor => [descriptor.key, descriptor])).values()];
                const centerRequest = requestTerrainGridTile(
                    streamState,
                    centerDescriptor,
                    { critical: true },
                );
                const startupRequests = startupDescriptors
                    .filter(descriptor => descriptor.key !== centerDescriptor.key)
                    .map(descriptor => requestTerrainGridTile(streamState, descriptor))
                    .filter(Boolean);
                // The anchor cell remains mandatory. Surrounding support cells
                // are best effort, exactly as before, but now transfer beside it.
                await centerRequest;
                const startupResults = await Promise.allSettled(startupRequests);
                for (const result of startupResults) {
                    if (result.status === 'rejected' && result.reason?.name !== 'AbortError') {
                        console.warn(logStamp(), 
                            '[terrain] startup support cell unavailable; retaining available mosaic',
                            result.reason,
                        );
                    }
                }
                baseGrid = streamedTerrainBaseGrid(streamState);
            }
            if (token !== generation || signal?.aborted) return;
            let preparedDetail = null;
            if (detailConfig) {
                const detailPayloads = await initialDetailPayloads;
                if (token !== generation || signal?.aborted) return;
                if (detailPayloads.length > 0) {
                    preparedDetail = await prepareTerrainDetailWindow(
                        baseGrid,
                        detailPayloads,
                        detailConfig,
                        ctx.anchorLon,
                        ctx.anchorLat,
                        {
                            signal,
                            priority: { score: 5e12 },
                        },
                    );
                    if (token !== generation || signal?.aborted) return;
                }
            }
            noteWorldPhase('terrain-data-ready');
            const { grid, detail } = composeTerrainWindow(baseGrid, preparedDetail);
            if (detail?.rects?.length) {
                console.log(logStamp(), 
                    `[terrain] 1 m detail active: ${detail.rects.length} window(s), `
                    + `mesh step ${detail.stepM} m`,
                );
            }
            reference = new TerrainReference(grid, ctx.anchorLon, ctx.anchorLat, {
                surfaceStepM: TILE_M / TILE_SEGMENTS,
                detail,
            });
            publishedTerrain = createPublishedTerrainReference(captureTerrainReadSnapshot(reference),
                GROUND_GENERATION_LIMITS.terrainPublication);
            sessionTerrain = createTerrainSessionReference(publishedTerrain);
            for (const setter of ['setRoadFormation', 'setRailFormation', 'setRenderedRailSurface']) {
                const assign = sessionTerrain[setter];
                sessionTerrain[setter] = function(model) { assign.call(this, model); reference?.[setter](model); };
            }
            await installTerrainCompilerSnapshot();
            if (token !== generation || signal?.aborted) return;
            terrainCompilerChangeSubscription = reference.onChange(handleTerrainSourceChange);
            noteWorldPhase('terrain-decode-ready');
            ctx.terrainSource = reference;
            ctx.publishedTerrain = publishedTerrain;
            ctx.terrain = sessionTerrain;
            noteTerrainCoverage('ok');
            previousGroundVisible = groundMesh ? groundMesh.visible : true;
            if (groundMesh) groundMesh.visible = false;
            terrainSurfaceStyle = config.surfaceStyle;
            terrainMaterial = makeMaterial(terrainSurfaceStyle);
            terrainExactFormationMaterial = makeMaterial(terrainSurfaceStyle, { exactFormationCutouts: true });
            terrainGroup = new THREE.Group();
            terrainGroup.name = 'DguTerrain';
            markInspectionLayer(terrainGroup, {
                id: 'terrain',
                label: 'DGU terrain / bare earth',
                category: 'Ground',
                source: 'world/terrain.js · DGU DTM mesh tiles',
                order: 10,
            });
            scene.add(terrainGroup);
            ensureAround(0, 0, Infinity);
            await waitForTerrainSupportRing(0, 0, signal);
            if (token !== generation || signal?.aborted) return;
            regionalStyleCenterX = 0;
            regionalStyleCenterZ = 0;
            beginUrbanGround(ctx, getLocation());
            if (streamState) {
                streamState.preparedDetail = preparedDetail;
                // The startup window is the first window the moving refresh
                // keeps behind the player; it is centred on the anchor.
                streamState.currentDetail = preparedDetail
                    ? { preparedDetail, centerX: 0, centerZ: 0, publishedAt: Date.now() }
                    : null;
                if (streamState.detailPinned || initialDetailOutcome !== 'failed') {
                    // The anchor window is published with the base (or the
                    // probe found no fine data here): the moving refresh
                    // starts from the anchor and re-centres only after
                    // MOVING_DETAIL_REFRESH_M of travel.
                    streamState.detailCenterX = 0;
                    streamState.detailCenterZ = 0;
                }
                terrainGridStreamState = streamState;
                const initialTerrainPose = {
                    lat: ctx.anchorLat,
                    lon: ctx.anchorLon,
                    headingDeg: streamState.headingDeg,
                };
                ensureStreamedTerrainWindow(
                    streamState,
                    initialTerrainPose,
                    { x: 0, z: 0 },
                    { force: true },
                );
                if (initialDetailOutcome === 'failed') streamState.detailGateArmed = false;
                if (!streamState.detailPinned && initialDetailOutcome === 'failed') {
                    beginStreamedTerrainDetailRefresh(
                        streamState,
                        initialTerrainPose,
                        { x: 0, z: 0 },
                        { force: true },
                    );
                }
            }
            if (typeof window !== 'undefined') {
                window.__s3dTerrainState = () => ({
                    revision: reference?.revision ?? null,
                    lastChange: reference?.lastChange?.reason ?? null,
                    pendingDetail: reference?.pendingDetailWindow ?? null,
                    detailRects: reference?.detail?.rects?.length ?? 0,
                    detailRectBounds: (reference?.detail?.rects || []).map(rect => [
                        Math.round(rect.minX), Math.round(rect.maxX), Math.round(rect.minZ), Math.round(rect.maxZ)]),
                    retainedDetails: terrainGridStreamState?.retainedDetails?.length ?? null,
                    detailInFlight: terrainGridStreamState?.detailInFlight ?? null,
                    initialDetail: initialDetailOutcome,
                });
            }
            console.log(logStamp(), 
                `[terrain] DGU DTM active; scene anchor ${reference.anchorHeightM.toFixed(1)} m EVRF2000`
                + (preparedDetail ? ' · 1 m anchor window loaded with the base' : ''),
            );
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            console.warn(logStamp(), '[terrain] failed to load; keeping the flat world', error);
            noteWorldPhase('terrain-data-ready');
            noteWorldPhase('terrain-decode-ready');
            clearTerrain();
        }
    },

    onFrame(pose, local) {
        if (local) {
            let phaseStartedMs = performance.now();
            if (pose
                && Number.isFinite(pose.lat)
                && Number.isFinite(pose.lon)
                && Math.hypot(
                    local.x - regionalStyleCenterX,
                    local.z - regionalStyleCenterZ,
                ) >= REGIONAL_STYLE_REFRESH_M) {
                regionalStyleCenterX = local.x;
                regionalStyleCenterZ = local.z;
                const regional = refreshRegionalLocation(pose.lat, pose.lon);
                if (regional.changed) {
                    applyRegionalTerrainStyle(
                        regional.location.terrain?.surfaceStyle,
                        local.x,
                        local.z,
                    );
                }
            }
            recordLayerFrameMs('terrain:regionalStyle', performance.now() - phaseStartedMs);
            phaseStartedMs = performance.now();
            if (urbanBuildingSource) urbanBuildingSource.ensureAround(local.x, local.z);
            recordLayerFrameMs('terrain:buildingTiles', performance.now() - phaseStartedMs);
            syncUrbanGroundMask(local);
            phaseStartedMs = performance.now();
            if (!groundManaged) syncRoadFormationMask(local);
            recordLayerFrameMs('terrain:formationMask', performance.now() - phaseStartedMs);
            phaseStartedMs = performance.now();
            ensureAround(
                local.x,
                local.z,
                0,
                pose?.surfaceStreamingFocus,
                pose?.surfaceStreamingPreload,
            );
            recordLayerFrameMs('terrain:tiles', performance.now() - phaseStartedMs);
            phaseStartedMs = performance.now();
            if (terrainGridStreamState) {
                ensureStreamedTerrainWindow(terrainGridStreamState, pose, local);
                releaseExpiredDetailEvidenceGate(terrainGridStreamState);
                beginStreamedTerrainDetailRefresh(terrainGridStreamState, pose, local);
            }
            recordLayerFrameMs('terrain:gridStreaming', performance.now() - phaseStartedMs);
        }
    },

    endSession() {
        generation += 1;
        clearTerrain();
        surfacePublications = null;
    },
};
