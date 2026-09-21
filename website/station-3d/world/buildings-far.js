// Far LOD1 building layer: cheap footprint-extrusion boxes that fill the horizon
// beyond the ~300 m detailed-mesh ring when flying. One BatchedMesh per coarse
// (800 m) tile, one instance per building, extruded flat to eave height. Buildings
// the detailed layer has loaded are hidden here via the shared LOD registry, so
// exactly one representation draws — see building-lod-registry.js.
//
// A module Worker builds the indexed footprint prisms into tile-local render
// packets. The main thread validates those packets, then a bounded delivery queue
// uploads BatchedMesh chunks before one atomic tile publication. The prior complete
// generation remains visible throughout compilation and upload.
//
// Registered in modes/cab.js as an opt-in per-location layer
// (locations.js `farBuildings`). Uses the /buildings-lod1 API endpoint.
import * as THREE from 'three';
import { camera, renderer, scene } from '../scene/setup.js';
import { getApiBase } from '../core/api.js';
import { farBuildingTileSourceForLocation, getLocation } from '../core/locations.js';
import { isFeatureDemolishedByProposalTrack, proposalsReady } from './proposals.js';
import { finiteOrNull, localToGeo } from '../core/math.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
    frameChunkObserverIsMoving,
} from '../core/frame-chunk-queue.js';
import { createFarBuildingPacketUploadTask } from '../core/far-building-packet-three.js';
import { createFeatureCollectionJsonParseTask } from '../core/cooperative-feature-collection-json.js';
import { buildingGeometryMemory, publishGeometryMemory, releaseGeometryMemory } from '../core/geometry-memory-budget.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import {
    FAR_BUILDING_PACKET_COMPILER_ID,
    FAR_BUILDING_PACKET_COMPILER_VERSION,
} from '../core/compilers/far-building-render-packet.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import {
    BUILDING_USE_COLORS,
    registerPassageAwareGroup,
    unregisterPassageAwareGroup,
    applyPassageAwareMaterial,
    registerAuthoritativeBuildingFootprints,
    unregisterAuthoritativeBuildingFootprints,
    clearAuthoritativeBuildingFootprints,
    isBlockedBuildingObjectId,
} from './buildings.js';
import {
    pickFarHeightForFeature, outerRings, farFrameBudgetMs,
} from './lod1-geometry.js';
import { isDetailed, isDetailedTile, onDetailedChange, onDetailedTileChange } from './building-lod-registry.js';
import { DETAILED_BUILDING_TILE_M, tileIndex } from '../core/tile-stream.js';
import { classifyViewPriority, tileLocalBounds } from '../core/view-priority.js';
import { applyFarBuildingTint } from './far-building-color.js';
import { belongsInBuildingLayer } from '../core/building-pipeline.js';
import { createFarBuildingLodIndex } from '../core/far-building-lod-index.js';

// Coarse grid: a 3×3 ring of 800 m tiles reaches ~800–1600 m (mean ~1200 m),
// landing inside the 250–1200 m fog so the layer's outer edge is never visible.
const FAR_TILE_M = 800;
const FAR_RING = 1;
const FAR_KEEP_RING = 2;
// Same warm tan the detailed layer gives unmapped use classes, so the two tiers
// read as one city where they meet.
const FAR_DEFAULT_COLOR = 0xe7ab6e;
// A dense 800 m tile holds ~2000 buildings. Finalising a BatchedMesh only after the
// whole tile is built means nothing appears for seconds; instead we flush a sub-batch
// every CHUNK buildings. The real detached BatchedMesh is uploaded before
// publication, so this cap also bounds the data in one indivisible GPU upload.
const FAR_CHUNK = 32;
// Horizon LOD cap: a dense 800 m tile holds ~2000 footprints, but at 800–1600 m
// only the tallest read as skyline — the rest are sub-pixel sheds. Enqueuing all
// of them is what let a Rijeka amphitheatre tile pile ~2000 prisms into the far
// queue (which gets no frame budget while moving, so the backlog just sat full
// and then uploaded in a burst on stop). Keep the tallest N per tile; drop the
// invisible tail at the source.
const FAR_MAX_PER_TILE = 600;
const FAR_PACKET_PREWARM_ITEM = Symbol('far-building-packet-prewarm');

let anchorLat = 0;
let anchorLon = 0;
let enabled = false;
let farGroup = null;
let material = null;
let source = null;
let bakeShadow = null; // explicit loopback-only shadow or baked source adapter
let subscription = null;
let detailedUnsub = null;
let detailedTileUnsub = null;
let terrainChangeSubscription = null;
let terrainReference = null;
let renderCompiler = null;
let surfacePublications = null;
let farBuildFocusX = 0;
let farBuildFocusZ = 0;
let farBuildHeadingDeg = Number.NaN;
let farBuildFovDeg = 90;
let terrainFarRebuildQueue = [];

function isExpectedFarBuildCancellation(error) {
    return ['cancelled', 'superseded', 'stale-result', 'client-disposed']
        .includes(error?.code);
}

const tileBatches = new Map();          // tileKey → BatchedMesh[]  (sub-batches)
const tileRoots = new Map();            // tileKey → atomically published Group
const streamedFarTiles = new Map();     // tileKey → latest Feature[] payload
// Index every border copy, by object ID and by the detailed 100 m tile of its
// centroid. A single-ref map silently lost all but the last published copy.
const farLodIndex = createFarBuildingLodIndex({ isDetailed, isDetailedTile });
const tileJobs = new Map();             // tileKey → Worker compile + upload job
// rAF-backed delivery, NOT requestIdleCallback: under a busy main thread (dense
// load, or a loaded machine) idle callbacks never fire even on their timeout.
// Small budget + low priority lets the detailed layer win the frame.
// The first full ring — 9 tiles at FAR_RING 1. Until it is built the queue takes
// a real slice; after that it drops to the trickle. Reset per session.
const FAR_PRIME_TILES = (2 * FAR_RING + 1) ** 2;
let farTilesBuilt = 0;
let farPublicationGeneration = 0;
let packetUploadQueue = null;

function createFarPacketUploadQueue() {
    return createFrameChunkQueue({
        label: 'far-building-packet-upload',
        frameBudgetMs: () => farFrameBudgetMs(farTilesBuilt, { primeTiles: FAR_PRIME_TILES }),
        // Compilation is already on the Worker. These are bounded main-thread
        // packet copies/uploads, not whole far-tile builds. The far class's
        // one-item/500 ms liveness valve would process just two primitives per
        // second while near work is pending, stranding thousands of primitives.
        workClass: 'delivery',
        preferAnimationFrame: true,
        trackWorldReady: false,
    });
}

function colorForUseClass(useClass) {
    const hex = BUILDING_USE_COLORS[useClass];
    return hex == null ? FAR_DEFAULT_COLOR : hex;
}

function ensureFarGroup() {
    if (!farGroup) {
        farGroup = new THREE.Group();
        farGroup.name = 'far-buildings';
        markInspectionLayer(farGroup, {
            id: 'far-buildings',
            label: 'Far building massing',
            category: 'Buildings',
            source: 'world/buildings-far.js · LOD1 footprint prisms',
            order: 210,
        });
        scene.add(farGroup);
        // Far prisms must honour courtyard-passage cuts like detailed
        // buildings do: a building with no detailed 3D model exists ONLY as
        // a prism, and an unpatched prism seals the far end of any passage
        // cut through or in front of it.
        registerPassageAwareGroup(farGroup);
    }
}

// Terrain lift for a footprint. The horizon must obey the same evidence gate
// as detailed buildings: a visual fallback datum may cover void, but it may
// not author a prism that later jumps when the moving DTM window arrives.
function farBaseY(geometry) {
    const ring = outerRings(geometry)[0];
    if (!ring || ring.length === 0) return 0;
    if (!terrainReference) return 0;
    if (typeof terrainReference.evidenceFoundationSceneY !== 'function') return null;
    return finiteOrNull(terrainReference.evidenceFoundationSceneY(ring));
}

function cancelTileJob(tileKey) {
    const job = tileJobs.get(tileKey);
    if (!job) return false;
    job.cancelled = true;
    job.compileHandle?.cancel?.('far-building-tile-cancelled');
    job.prewarm?.return?.();
    job.prewarm = null;
    if (job.uploadJob) packetUploadQueue?.cancel?.(job.uploadJob);
    else job.uploadTask?.dispose?.();
    if (job.publicationTicket?.state === 'pending') {
        job.publicationTicket.discard('far-building-tile-cancelled');
    }
    if (tileJobs.get(tileKey) === job) tileJobs.delete(tileKey);
    return true;
}

function farPublicationKey(tileKey) {
    return `far-buildings:${tileKey}`;
}

function registerFarRoot(tileKey, root) {
    const batches = root.children.filter(child => child.isBatchedMesh);
    for (const batch of batches) {
        for (const ref of batch.userData.lodRefs || []) {
            farLodIndex.register(ref);
        }
    }
    tileRoots.set(tileKey, root);
    tileBatches.set(tileKey, batches);
    publishGeometryMemory(root);
}

function unregisterFarRoot(tileKey, root) {
    for (const batch of root?.children || []) {
        for (const ref of batch.userData?.lodRefs || []) {
            farLodIndex.unregister(ref);
        }
    }
    if (tileRoots.get(tileKey) === root) {
        tileRoots.delete(tileKey);
        tileBatches.delete(tileKey);
    }
}

function disposeFarRoot(_context, root) {
    if (!root) return;
    root.userData ||= {};
    if (root.userData.farDisposed) return;
    root.userData.farDisposed = true;
    const tileKey = root.userData?.farTileKey;
    if (tileKey != null) unregisterFarRoot(tileKey, root);
    root.parent?.remove?.(root);
    for (const batch of [...(root.children || [])]) batch.dispose?.();
    releaseGeometryMemory(root);
    root.clear?.();
}

function configureFarBatch(batch) {
    // Same perf strategy as detailed meshes: only overlapping batches receive
    // the passage-aware shader variant.
    applyPassageAwareMaterial(batch, material);
}

function tintFarEntity(identity) {
    return applyFarBuildingTint(
        new THREE.Color(),
        identity.metadata?.color ?? FAR_DEFAULT_COLOR,
        identity.objectId,
    );
}

function onFarTileFetch(features, tileKey, options = {}) {
    if (!enabled || !farGroup) return undefined;
    // proposalsReady() joins the wait for the same reason the near layer waits on
    // it: a building must not be drawn before we know whether the corridor takes
    // it. This ring streams from /buildings-lod1, which knows nothing about the
    // proposal, so without the carve below a demolished building kept standing
    // out here as a prism — including right at the rim of an open cut, where it
    // is anything but distant.
    return proposalsReady().then(() => buildFarTile(features, tileKey, options));
}

function buildFarTile(features, tileKey, { replaceExisting = false } = {}) {
    // Re-checked after the await: a session can end while proposal data is in flight, and
    // building into a disposed group is how a leak starts.
    if (!enabled || !farGroup) return undefined;
    const visibleFeatures = (features || []).filter((feature) => (
        belongsInBuildingLayer(feature?.properties)
        && !isBlockedBuildingObjectId(feature?.properties?.object_id)
    ));
    // Authoritative footprints cover the WHOLE tile (the detailed layer's far→
    // near swap must know every building), even the ones the horizon LOD drops.
    registerAuthoritativeBuildingFootprints(visibleFeatures, tileKey, anchorLat, anchorLon);
    if (!replaceExisting && tileRoots.has(tileKey)) {
        return undefined;   // already built (replay to late subscriber)
    }

    // Cap the prisms actually built: keep the tallest FAR_MAX_PER_TILE, drop the
    // sub-pixel tail. Height is computed once here and reused by the builder.
    // Demolished buildings are dropped from what gets BUILT, not from the
    // authoritative footprints above: the far→near swap still has to know every
    // building the tile contains, whether or not this layer draws it.
    let farFeatures = visibleFeatures
        .filter((feature) => !isFeatureDemolishedByProposalTrack(feature))
        .map((feature) => ({
        feature,
        farHeight: pickFarHeightForFeature(feature.properties || {}, feature.geometry, anchorLat),
        baseY: farBaseY(feature.geometry),
    }));
    if (farFeatures.length > FAR_MAX_PER_TILE) {
        farFeatures.sort((a, b) => b.farHeight - a.farHeight);
        farFeatures = farFeatures.slice(0, FAR_MAX_PER_TILE);
    }
    // All-or-nothing per streamed tile. A partially evidenced horizon would
    // replace a complete prior tile with holes and then pop again on the next
    // terrain revision. Keep the old generation until every retained prism is
    // seatable from source evidence.
    if (farFeatures.some(feature => feature.baseY === null)) return undefined;
    cancelTileJob(tileKey);
    const [tileTx, tileTz] = String(tileKey).split('_').map(Number);
    const terrainGeneration = terrainReference
        ? { reference: terrainReference, revision: terrainReference.revision }
        : null;
    if (![tileTx, tileTz].every(Number.isFinite)) {
        throw new Error(`Invalid far-building tile key ${tileKey}`);
    }
    if (!renderCompiler || !surfacePublications || !packetUploadQueue) {
        throw new Error('Far buildings require the render compiler Worker and publication registry');
    }
    const generation = ++farPublicationGeneration;
    const replacementKey = farPublicationKey(tileKey);
    const publicationTicket = surfacePublications.begin({
        key: replacementKey,
        generation,
        parent: farGroup,
        retire: disposeFarRoot,
        discard: disposeFarRoot,
    });
    const tileOriginX = tileTx * FAR_TILE_M;
    const tileOriginZ = tileTz * FAR_TILE_M;
    const tileOrigin = localToGeo(tileOriginX, tileOriginZ, anchorLon, anchorLat);
    const requestFeatures = farFeatures.map(({ feature, farHeight, baseY }, index) => {
        const props = feature.properties || {};
        return {
            entityId: props.object_id ?? `far:${tileKey}:${index}`,
            objectId: props.object_id ?? null,
            nearKey: nearTileKeyOf(feature.geometry),
            color: colorForUseClass(props.use_class),
            heightM: farHeight,
            baseY,
            geometry: feature.geometry,
        };
    });
    const request = {
        requestKey: replacementKey,
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID,
        compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION,
        sourceRevision: `far:${terrainReference?.revision || 0}:${generation}`,
        generation,
        priority: classifyViewPriority(
            tileLocalBounds(tileTx, tileTz, FAR_TILE_M),
            {
                observerX: farBuildFocusX,
                observerZ: farBuildFocusZ,
                headingDeg: farBuildHeadingDeg,
                fovDeg: farBuildFovDeg,
            },
        ).score,
        tile: {
            matrix: 'station3d-local-metre-v1',
            z: 0,
            x: tileTx,
            y: tileTz,
            originLon: tileOrigin.lon,
            originLat: tileOrigin.lat,
            sizeM: FAR_TILE_M,
        },
        inputs: {
            anchorLon,
            anchorLat,
            tileOriginX,
            tileOriginZ,
            renderOrder: 0,
            features: requestFeatures,
        },
    };
    bakeShadow?.observeSelection(tileKey, request, farFeatures);
    const bakedPacket = bakeShadow?.packetFor?.(request, features) || null;
    const job = {
        tileKey,
        features,
        replaceExisting,
        terrainGeneration,
        publicationTicket,
        compileHandle: null,
        uploadTask: null,
        uploadJob: null,
        candidateRoot: null,
        prewarm: null,
        prewarmPhase: '',
        cancelled: false,
        promise: null,
    };
    const isCurrent = () => {
        const terrainStillCurrent = !terrainGeneration
            || (terrainReference === terrainGeneration.reference
                && terrainReference.revision === terrainGeneration.revision);
        return !job.cancelled
            && enabled
            && !!farGroup
            && tileJobs.get(tileKey) === job
            && terrainStillCurrent
            && streamedFarTiles.get(tileKey) === features;
    };
    const discardCandidate = (reason) => {
        job.prewarm?.return?.();
        job.prewarm = null;
        if (job.candidateRoot) {
            disposeFarRoot(null, job.candidateRoot);
            job.candidateRoot = null;
        } else {
            job.uploadTask?.dispose?.();
        }
        if (publicationTicket.state === 'pending') publicationTicket.discard(reason);
    };
    const uploadPacket = (packet) => {
        // A resolved compile Promise retains its result. Once the uploader
        // owns the packet, keeping this handle would pin every source array
        // throughout a later (possibly movement-deferred) GPU prewarm.
        job.compileHandle = null;
        if (!isCurrent()) {
            publicationTicket.discard('far-building-generation-stale');
            return false;
        }
        if (packet.primitives.length === 0) {
            publicationTicket.clear();
            if (!replaceExisting) farTilesBuilt += 1;
            return true;
        }
        job.uploadTask = createFarBuildingPacketUploadTask(packet, {
            material,
            replacementKey,
            chunkSize: FAR_CHUNK,
            position: { x: tileOriginX, y: 0, z: tileOriginZ },
            colorForEntity: tintFarEntity,
            visibleForEntity: refVisible,
            configureBatch: (batch, refs) => {
                if (bakedPacket) {
                    const matrix = new THREE.Matrix4();
                    for (const ref of refs) {
                        const placement = bakedPacket.placements.get(ref.objectId);
                        if (!placement) throw new Error('Baked far instance placement missing');
                        matrix.makeScale(placement.scaleX, placement.scaleY, 1);
                        matrix.setPosition(placement.x, placement.y, placement.z);
                        batch.setMatrixAt(ref.instanceId, matrix);
                    }
                }
                configureFarBatch(batch);
            },
            rootName: `far-buildings:${tileKey}:generation:${generation}`,
            memoryBudget: buildingGeometryMemory,
            packetMemoryTrackedExternally: !!bakedPacket,
        });
        // Queue tokens must not keep every transferred primitive alive after
        // the uploader has copied it and released its packet source lease.
        const uploadItems = [...packet.primitives.keys(), FAR_PACKET_PREWARM_ITEM];
        job.uploadJob = packetUploadQueue.enqueue(
            uploadItems,
            (item) => {
                if (item !== FAR_PACKET_PREWARM_ITEM) {
                    const before = job.uploadTask.progress().uploadedPrimitives;
                    job.uploadTask.step(1);
                    if (job.uploadTask.waitingForMemory) return FRAME_CHUNK_DEFER_ITEM;
                    return job.uploadTask.progress().uploadedPrimitives > before
                        ? undefined : FRAME_CHUNK_REPEAT_ITEM;
                }
                // Filling detached BatchedMesh buffers is bounded CPU work, but
                // prewarming them can ask WebGL to allocate/upload large backing
                // buffers. If a packet reaches this boundary after departure,
                // leave the previous complete tile visible and resume at the
                // next stop instead of turning the first moving frames into GPU
                // upload/render stalls.
                if (frameChunkObserverIsMoving()) return FRAME_CHUNK_DEFER_ITEM;
                if (!job.candidateRoot) {
                    const root = job.uploadTask.result();
                    job.candidateRoot = root;
                    root.userData.farTileKey = tileKey;
                    if (bakedPacket) root.userData.worldBake = { releaseId: bakedPacket.releaseId,
                        sourceRevision: bakedPacket.sourceRevision };
                    job.prewarm = prewarmDetachedObject(root, {
                        renderer,
                        camera,
                        targetScene: scene,
                        asyncShaders: true,
                        label: 'far-building-gpu-prewarm',
                        scanChunk: 24,
                        uploadBatch: 1,
                        sliceMs: 2,
                        uploadBatchedGeometry: true,
                    });
                }
                const outcome = job.prewarm.next();
                job.prewarmPhase = String(outcome.value?.phase || 'complete');
                if (!outcome.done) return FRAME_CHUNK_REPEAT_ITEM;
                job.prewarm = null;
                return undefined;
            },
            {
                maxItemsPerFrame: 24,
                priority: () => classifyViewPriority(
                    tileLocalBounds(tileTx, tileTz, FAR_TILE_M),
                    {
                        observerX: farBuildFocusX,
                        observerZ: farBuildFocusZ,
                        headingDeg: farBuildHeadingDeg,
                        fovDeg: farBuildFovDeg,
                    },
                ).score,
                describeItem: (item) => item === FAR_PACKET_PREWARM_ITEM
                    ? `${tileKey}:${job.prewarmPhase || 'gpu-prewarm'}`
                    : `${tileKey}:${job.uploadTask.progress().validation.complete ? 'primitive' : 'validation'}`
                        + `:${job.uploadTask.progress().uploadedPrimitives}`,
                onComplete: () => {
                    if (!isCurrent()) {
                        discardCandidate('far-building-upload-stale');
                        return;
                    }
                    const root = job.candidateRoot;
                    const result = publicationTicket.publish(root, {
                        commit: () => registerFarRoot(tileKey, root),
                    });
                    if (result.status === 'published'
                        || result.status === 'published-with-retirement-error') {
                        job.candidateRoot = null;
                        if (!replaceExisting) farTilesBuilt += 1;
                    }
                },
                onCancel: () => discardCandidate('far-building-upload-cancelled'),
                onError: () => discardCandidate('far-building-upload-failed'),
            },
        );
        return job.uploadJob.promise;
    };
    try {
        // Baked authority supplies the already compiled primitives. Everything
        // after this boundary is the same bounded uploader and atomic publication.
        job.compileHandle = bakedPacket ? { promise: Promise.resolve(bakedPacket.packet) }
            : renderCompiler.compile(request);
    } catch (error) {
        publicationTicket.discard('far-building-compile-refused');
        throw error;
    }
    job.promise = job.compileHandle.promise
        .then(uploadPacket)
        .catch((error) => {
            discardCandidate('far-building-compile-failed');
            if (!isExpectedFarBuildCancellation(error)) {
                console.error(`[far-buildings] Worker compilation failed for ${tileKey}`, error);
            }
            throw error;
        })
        .finally(() => {
            if (tileJobs.get(tileKey) === job) tileJobs.delete(tileKey);
        });
    tileJobs.set(tileKey, job);
    return job.promise;
}

function removeFarTileVisuals(tileKey) {
    const root = tileRoots.get(tileKey);
    if (!root) return;
    if (surfacePublications?.retire?.(farPublicationKey(tileKey), {
        root,
        reason: 'far-building-tile-evicted',
    })) return;
    disposeFarRoot(null, root);
}

function removeFarTile(tileKey) {
    unregisterAuthoritativeBuildingFootprints(tileKey);
    cancelTileJob(tileKey);
    removeFarTileVisuals(tileKey);
}

function farTileIntersectsTerrainChange(tileKey, bounds) {
    if (!Array.isArray(bounds) || bounds.length === 0) return true;
    const [tx, tz] = String(tileKey).split('_').map(Number);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;
    const tileBounds = {
        minX: tx * FAR_TILE_M,
        maxX: (tx + 1) * FAR_TILE_M,
        minZ: tz * FAR_TILE_M,
        maxZ: (tz + 1) * FAR_TILE_M,
    };
    return bounds.some(changed => !(
        tileBounds.maxX < changed.minX
        || tileBounds.minX > changed.maxX
        || tileBounds.maxZ < changed.minZ
        || tileBounds.minZ > changed.maxZ
    ));
}

function queueTerrainFarRebuild(change) {
    const bounds = Array.isArray(change?.bounds) ? change.bounds : [];
    const replacements = new Set();
    const tasks = [];
    for (const [tileKey, features] of streamedFarTiles) {
        if (!farTileIntersectsTerrainChange(tileKey, bounds)) continue;
        replacements.add(tileKey);
        const [tx, tz] = String(tileKey).split('_').map(Number);
        const centerX = (tx + 0.5) * FAR_TILE_M;
        const centerZ = (tz + 0.5) * FAR_TILE_M;
        tasks.push({
            tileKey,
            features,
            distanceSq: (centerX - farBuildFocusX) ** 2
                + (centerZ - farBuildFocusZ) ** 2,
        });
    }
    terrainFarRebuildQueue = terrainFarRebuildQueue
        .filter(task => !replacements.has(task.tileKey));
    tasks.sort((a, b) => a.distanceSq - b.distanceSq);
    terrainFarRebuildQueue.push(...tasks);
}

function drainTerrainFarRebuild() {
    while (terrainFarRebuildQueue.length > 0) {
        const task = terrainFarRebuildQueue.shift();
        if (streamedFarTiles.get(task.tileKey) !== task.features) continue;
        Promise.resolve(onFarTileFetch(task.features, task.tileKey, {
            replaceExisting: true,
        })).catch((error) => {
            if (!isExpectedFarBuildCancellation(error)) {
                console.error(`[far-buildings] terrain rebuild failed for ${task.tileKey}`, error);
            }
        });
        break;
    }
}

// Centroid of the footprint's outer ring, mapped onto the DETAILED layer's
// 100 m tile grid (same `${tx}_${tz}` keys the near layer reports).
function nearTileKeyOf(geometry) {
    const ring = geometry && (geometry.type === 'Polygon'
        ? geometry.coordinates[0]
        : geometry.type === 'MultiPolygon'
            ? geometry.coordinates[0] && geometry.coordinates[0][0]
            : null);
    if (!Array.isArray(ring) || ring.length === 0) return null;
    let sLon = 0, sLat = 0, n = 0;
    for (const [lon, lat] of ring) { sLon += lon; sLat += lat; n++; }
    if (n === 0) return null;
    const scaleLon = Math.PI / 180 * 6371008.8 * Math.cos(anchorLat * Math.PI / 180);
    const scaleLat = Math.PI / 180 * 6371008.8;
    const x = (sLon / n - anchorLon) * scaleLon;
    const z = -(sLat / n - anchorLat) * scaleLat;
    return `${tileIndex(x, DETAILED_BUILDING_TILE_M)}_${tileIndex(z, DETAILED_BUILDING_TILE_M)}`;
}

function refVisible(ref) {
    return farLodIndex.visible(ref);
}

// The detailed layer built or dropped a building → hide or re-show its far box.
function onDetailed(objectId) {
    farLodIndex.syncObject(objectId);
}

// A detailed tile finished building (or was evicted) → hide/re-show every far
// prism whose centroid sits in it, so no lone LOD1 box survives between
// detailed neighbours.
function onDetailedTile(tileKey) {
    farLodIndex.syncTile(tileKey);
}

export const farBuildingsLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        sharedTileSession,
        terrain,
        renderCompiler: compiler,
        surfacePublications: publications,
        bakedWorldShadow,
    }) {
        bakeShadow = bakedWorldShadow || null;
        clearAuthoritativeBuildingFootprints();
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        streamedFarTiles.clear();
        terrainFarRebuildQueue = [];
        enabled = !!getLocation().farBuildings;
        if (!enabled) return;
        if (!compiler || !publications) {
            throw new Error('Far buildings require the Station3D render compiler Worker');
        }
        renderCompiler = compiler;
        surfacePublications = publications;
        packetUploadQueue?.dispose?.();
        packetUploadQueue = createFarPacketUploadQueue();
        farTilesBuilt = 0;   // a new session starts cold and primes again
        farPublicationGeneration = 0;
        farBuildFocusX = 0;
        farBuildFocusZ = 0;
        farBuildHeadingDeg = Number.NaN;
        farBuildFovDeg = 90;
        terrainReference = terrain || null;
        terrainChangeSubscription = terrainReference?.onChange?.(
            (_revision, change) => {
                // Detached batches are revision-bound. Cancel them before the
                // frame queue can publish an old-height chunk, then rebuild
                // streamed tiles near-to-far against the new evidence.
                for (const tileKey of [...tileJobs.keys()]) cancelTileJob(tileKey);
                queueTerrainFarRebuild(change);
            },
        ) || null;
        anchorLat = lat;
        anchorLon = lon;
        ensureFarGroup();
        if (!material) material = new THREE.MeshLambertMaterial({ color: 0xffffff });
        detailedUnsub = onDetailedChange(onDetailed);
        detailedTileUnsub = onDetailedTileChange(onDetailedTile);
        // Endpoint follows the location, mirroring the detailed layer: a region
        // with resolved heights gets them out here too, so a building does not
        // change size at the hand-off.
        const farSource = farBuildingTileSourceForLocation();
        const sourceBase = bakeShadow?.sourceBaseUrl || getApiBase();
        if (bakeShadow?.sourceBaseUrl && farSource.endpoint !== 'buildings-render') {
            throw new Error('Canonical-source QA is only defined for the render-row far source');
        }
        source = sharedTileSession.getSource({
            key: bakeShadow?.sourceBaseUrl ? `${farSource.key}:canonical-qa:${sourceBase}` : farSource.key,
            label: 'far-buildings',
            // fill=overture (lod1 only): a coarse tile the GDI survey never
            // covered is filled wholly from Overture, so the horizon is not blank
            // outside the survey. All-or-nothing by design — a per-building union
            // at this range costs ~117 ms to add ~1% more blocks nobody can
            // resolve 800-1600 m away.
            url: (bb) => `${sourceBase}/${farSource.endpoint}`
                + `?bbox=${bb.west},${bb.south},${bb.east},${bb.north}${farSource.querySuffix}`,
            tileM: FAR_TILE_M,
            ring: FAR_RING,
            keepRing: FAR_KEEP_RING,
            // Horizon placeholders are useful, but they must not open nine
            // coarse requests ahead of the four near detailed-building tiles.
            maxConcurrentRequests: 2,
            prioritizeByView: true,
            // Worker geometry compilation starts AFTER JSON delivery. These
            // coarse FeatureCollections can still be large, so use the same
            // cooperative parser as near detail instead of one whole-body parse.
            createTextDecodeTask: createFeatureCollectionJsonParseTask,
            loadPayload: bakeShadow?.loadPayload || null,
        });
        subscription = source.subscribe({
            onFetch: (features, tileKey) => {
                streamedFarTiles.set(tileKey, features);
                bakeShadow?.observeSource(tileKey, features);
                return onFarTileFetch(features, tileKey);
            },
            isExpectedBuildCancellation: isExpectedFarBuildCancellation,
            onEvict: (tileKey) => {
                streamedFarTiles.delete(tileKey);
                bakeShadow?.evictSource(tileKey);
                removeFarTile(tileKey);
            },
        });
        source.ensureAround(0, 0);
    },
    onFrame(pose, local) {
        if (local) {
            farBuildFocusX = Number(local.x) || 0;
            farBuildFocusZ = Number(local.z) || 0;
        }
        if (source && local) {
            const surfacePreload = pose?.surfaceStreamingPreload;
            if (surfacePreload) {
                source.ensurePinnedPoints(surfacePreload.points, {
                    signature: surfacePreload.signature,
                    priorityX: surfacePreload.priority?.x,
                    priorityZ: surfacePreload.priority?.z,
                    headingDeg: surfacePreload.priority?.headingDeg,
                });
            }
            const headingDeg = finiteOrNull(pose?.viewHeadingDeg)
                ?? finiteOrNull(pose?.headingDeg);
            if (headingDeg != null) farBuildHeadingDeg = headingDeg;
            farBuildFovDeg = finiteOrNull(pose?.viewFovDeg) ?? 90;
            source.ensureAround(local.x, local.z, {
                headingDeg: farBuildHeadingDeg,
                fovDeg: farBuildFovDeg,
            });
        }
        drainTerrainFarRebuild();
    },
    endSession() {
        enabled = false;
        bakeShadow = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        streamedFarTiles.clear();
        terrainFarRebuildQueue = [];
        terrainReference = null;
        clearAuthoritativeBuildingFootprints();
        if (subscription) subscription();
        subscription = null;
        source = null;
        if (detailedUnsub) detailedUnsub();
        detailedUnsub = null;
        if (detailedTileUnsub) detailedTileUnsub();
        detailedTileUnsub = null;
        for (const tileKey of [...tileJobs.keys()]) cancelTileJob(tileKey);
        packetUploadQueue?.dispose?.();
        packetUploadQueue = null;
        tileJobs.clear();
        for (const tileKey of [...tileRoots.keys()]) removeFarTileVisuals(tileKey);
        tileRoots.clear();
        tileBatches.clear();
        farLodIndex.clear();
        if (farGroup) {
            unregisterPassageAwareGroup(farGroup);
            if (farGroup.parent) farGroup.parent.remove(farGroup);
            farGroup = null;
        }
        if (material) {
            material.dispose();
            material = null;
        }
        renderCompiler = null;
        surfacePublications = null;
    },
};

// On-demand inspection, not an extra scan in the frame loop. Includes every
// published ref, so duplicate border instances cannot disappear from the audit.
export function farBuildingShadowOwnership() {
    const refs = [];
    for (const [tileKey, batches] of tileBatches) for (const batch of batches) {
        for (const ref of batch.userData.lodRefs || []) refs.push({ tileKey,
            objectId: ref.objectId, nearKey: ref.nearKey, visible: batch.getVisibleAt(ref.instanceId),
            expectedVisible: refVisible(ref) });
    }
    return { tileCount: tileRoots.size, pendingBuilds: tileJobs.size, refs,
        tiles: [...tileRoots].map(([key, root]) => ({ key, mode: root.userData.worldBake ? 'baked' : 'live',
            bake: root.userData.worldBake || null })) };
}
