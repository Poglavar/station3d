// Street curbs along the drivable road network. The server (/roads/curbs)
// returns the ST_Union outline of buffered road polygons per tile as oriented
// polygons (RFC 7946: exterior CCW, holes CW), clipped to the tile bbox. This
// layer extrudes a small curb profile along those rings: a vertical face up to
// CURB_TOP_Y, a flat curb-stone band, and bounded raised-side infill that meets
// the composed civil/terrain surface without client-side boolean geometry.

import * as THREE from 'three';
import { createBoundsGrid } from '../core/bounds-grid.js';
import { prepareCurbTileGeometrySteps } from '../core/curb-tile-geometry.js';
import { curbCollisionSurfacesNear, prepareCurbPublicationGroupSteps } from '../core/curb-publication-group.js';
import { ownReadSnapshot, retainReadSnapshot } from '../core/read-snapshot-lifetime.js';
import {
    curbOpeningMaskReason,
    curbRaisedSideTouchesMask,
    curbTramProxySuppressesBoundary,
} from '../core/curb-opening-mask.js';
import {
    computeCurbOffsetJoins,
    createCurbProfileRow,
} from '../core/curb-profile.js';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { getApiBase } from '../core/api.js';
import {
    CURB_OWNER_SEPARATION_M,
    curbUnionHasSeparatedOwnersAtLocal,
    curbUnionNeedsSeparatedOwnerChecks,
    resolveCurbSceneYAtLocal,
} from '../core/curb-height.js';
import { curbTouchesRenderedRailSurfaceAtLocal } from '../core/curb-rendered-rail.js';
import {
    createRailCutEdgeEvaluator,
    curbCrossesOpenRailCutAtLocal,
} from '../core/curb-rail-cut.js';
import { changedCivilGroundDependencyBounds } from '../core/civil-ground-composition.js';
import {
    peekRailCivilGroundDependencySnapshot,
    railCivilGroundDependencySnapshot,
} from '../core/rail-road-grade-separation.js';
import {
    CURB_DRAPE_KIND,
    curbDrapeHeightSource,
    stepCurbTerrainDrape,
    stepCurbTerrainDrapeSettled,
    withoutOmittedCurbRanges,
} from '../core/curb-terrain-drape.js';
import { isPermanentTerrainGap } from '../core/terrain-evidence-gap.js';
import {
    createFrameChunkQueue,
    getFrameChunkSequence,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { noteWorldQueueActive, noteWorldQueueIdle } from '../core/world-ready.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { replacementCorridorTouchesEdge } from '../core/road-vertical-alignment.js';
import {
    edgeNearAnyMask,
    pointInAnyMask,
    pointInAnyMaskExcept,
    pointInMask,
    pointInRing,
} from '../core/mask-query.js';
import { createPlannerTrackIndex } from '../core/planner-track-index.js';
import { createTileBuildGenerationController } from '../core/tile-build-generation.js';
import { createSurfaceRebuildLedger, surfaceChangesFromTerrainEvent } from '../core/surface-rebuild-ledger.js';
import { disposeGroup, registerShared, unregisterShared } from '../core/dispose.js';
import {
    CURB_AHEAD,
    NEAR_ROAD_STREAM_OPTIONS,
    boundsIntersectWithPadding,
    tileBbox,
    tileDistanceSqToPoint,
} from '../core/tile-stream.js';
import { initialWorldSupportTileKeys } from '../core/initial-world-support.js';
import {
    camera,
    scene,
    renderer,
    getSidewalkTexture,
    SIDEWALK_UV_PER_M,
} from '../scene/setup.js';
import {
    getDecorParkingIndex, queryDecorParkingEntries, queryDecorGreenEntries,
    getGrassTexture, GRASS_UV_PER_M,
} from './decor.js';
import { applyStreetLampSurfaceLighting } from './streetlamp-lighting.js';
import { applyPlannerSurfaceCutout, createPlannerGeometryMaterialCache } from './planner-surface-cutout.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { getActiveTerrainSurface } from './terrain-surface.js';
import { buildTrackCorridorVolumes, isPointInsideCorridorVolumes } from './track-corridors.js';
import { applyUrbanGroundSurface } from './urban-ground-surface.js';
import { buildPlannerStationClearanceVolumes } from './planner-station-layout.js';
import {
    pushManholesAlongRun,
    buildManholeMesh,
    getManholeMaterial,
} from './manholes.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_RENDER_ORDER,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
    roadSurfaceSceneOffset,
    reviseSurfaceClaim,
} from '../core/surface-hierarchy.js';

export { getStreetLampSurfaceLightingState as getCurbLampLightingState } from './streetlamp-lighting.js';

// Curb top sits above every road surface (roads render at ~0.02-0.04) so the
// step reads as ~15-16 cm from the asphalt, matching a typical Zagreb kerb.
export const CURB_TOP_Y = 0.18;
// Width of the flat curb-stone band behind the face.
const BAND_W = 0.30;
// The raised-side infill transitions from the stone band to its surrounding
// ground over this distance, avoiding a second exposed curb face.
const RAMP_W = 1.0;
// The terrain-coloured landing tucks under the DGU surface. This is deep
// enough to survive opposite triangle diagonals and depth precision, while
// remaining far below a visible step at the outer edge.
const TERRAIN_SEAM_OVERLAP_M = 0.035;
// One curb stone per this many metres along the ring; drives the joint-line
// texture repeat.
const CURB_STONE_M = 1.2;
// Segments produced by the server-side bbox clip lie exactly on the tile
// border and are not real curbs — drop any segment whose both endpoints sit
// on the same tile edge. The neighbouring tile owns the continuation.
const TILE_EDGE_EPS = 0.05;
const MITER_LIMIT = 2.0;
const MIN_SEG_M = 0.02;
// Only real crossing mouths and pedestrian precincts open a curb. A separately
// mapped parallel sidewalk/path is another paved neighbour, not evidence that
// the physical curb vanished. These polygons come from the shared roads:cab
// tiles the roads layer already fetches, so suppression costs no extra network.
const NON_ROADBED_HIGHWAY_TYPES = new Set([
    'pedestrian', 'footway', 'path', 'cycleway', 'steps', 'bridleway',
]);
// Curb edges near a mask get subdivided to this step so suppression can
// start/stop mid-edge (long simplified edges would otherwise vanish whole).
const SUPPRESS_SAMPLE_M = 2.0;
// Filtering a layer-0 union may query several vertically separated road owners
// per edge. Keep one cooperative visit small even when a long edge subdivides
// into hundreds of suppression samples.
// One ownership/mask query is the indivisible unit here. Mixed vertical unions
// can make that single query several milliseconds; batching ten of them turned
// a nominally cooperative queue item into the 412 ms `curbs:roads … filter`
// spike reported by the perf overlay.
const CURB_FILTER_WORK_UNITS_PER_STEP = 1;
const CURB_RUN_SCAN_UNITS_PER_STEP = 256;
// Street-side parking (decor 'parking' polygons) counts as roadbed: road
// curbs facing a parking area are suppressed, and the curb runs around the
// parking area's outer edge instead. Gap samples bridge the small offsets
// between OSM parking polygons and the buffered road edge.
const PARKING_GAP_SAMPLES_M = [0.4, 1.1];
const PARKING_MIN_AREA_M2 = 10;
// OSM road buffers top out at 9 m half-width for motorways. Ten metres opens
// the complete false layer-boundary cap while leaving longitudinal curb runs
// to the directional ownership test.
const ROAD_JOIN_CAP_RADIUS_M = 10;
const CURB_SEPARATED_OWNER_PAD_M = 12;
// Curbs are small near-field detail. Six hundred metres gives even the 75 m/s
// boost eight seconds of fetch lead while avoiding full-detail geometry behind
// the opaque 1,200 m fog horizon.
const FORMATION_DIRTY_PADDING_M = 15;
// Rail cells publish one at a time. Wait for a short quiet window, then rebuild
// only curb tiles that actually contain a tram proxy; rebuilding every loaded
// city tile after every cell would turn exact ownership into a streaming stall.
const RENDERED_RAIL_SURFACE_QUIET_MS = 120;
const RAIL_CUT_EDGE_PADDING_M = BAND_W + 0.25;
const CURB_RAIL_CUT_CROSS_SECTION_OFFSETS_M = Object.freeze([
    0,
    BAND_W * 0.5,
    BAND_W,
]);
// The back-ramp is synthetic fill for otherwise bare terrain. Rendered road,
// sidewalk and parking surfaces all claim the generic roadbed bit before the
// ramp; test only that bit so the independent carriageway flag cannot make a
// valid road fragment compare as empty. With a zero write mask the ramp never
// changes ownership for later landuse layers.
const CURB_DRESSING_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.ROAD_DRESSING,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    // One shared curb material spans ordinary roads and carried structures.
    // Unknown must preserve geometry until those batches are split by band.
    verticalRelation: SURFACE_VERTICAL_RELATION.UNKNOWN,
    ownerId: 'curb-dressing',
    sourceId: 'world/curbs.js',
});
const CURB_RAMP_CLAIM = compileSurfaceClaim({
    surfaceClass: SURFACE_CLASS.CURB_RAMP,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ownerId: 'curb-ramp',
    sourceId: 'world/curbs.js',
});
const CURB_TERRAIN_SEAM_CLAIM = compileSurfaceClaim({
    // A bounded continuation of the surrounding earth, not an extension of
    // the concrete curb. Its rendered top is firm support, but it never cuts
    // the terrain backstop beneath it.
    surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK,
    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
    verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
    verticalBand: 'ground',
    ownerId: 'curb-terrain-seam',
    sourceId: 'world/curbs.js:terrain-seam',
    supportReady: true,
    cutsBackstop: false,
});

function authorizeCurbMaterial(material, claim) {
    applySurfaceStencil(material, claim);
    applyGroundOwnership(material, claim);
    applyPlannerSurfaceCutout(material, claim);
    return material;
}
let curbsGroup = null;
let surfacePublications = null;
let groundPublications = null;
let groundPhysicsProvider = null;
// Serialize the captured curb table, not geometry preparation. Unrelated tiles
// can prepare concurrently without repeatedly invalidating each other's work.
let curbPublicationLease = null;
let groundCoordinator = null;
let groundManaged = false;
const plannerGeometryMaterials = createPlannerGeometryMaterialCache();
let lastCurbGpuFrame = -1;
const curbGpuReadiness = new Set();
const curbEvictions = new Map();
let curbPublicationGeneration = 0;
let curbMaterial = null;
let rampMaterial = null;
let greenRampMaterial = null;
let terrainSeamMaterial = null;
let curbTexture = null;
let tileSource = null;
let tileSubscription = null;
let anchorLat = 0;
let anchorLon = 0;
let tileFeatures = new Map();
let tileGroups = new Map();
let tileCollisionSurfaces = new Map();
let curbCollisionRevision = 0;
let tileBuildController = null;
let curbBuildFocusX = 0;
let curbBuildFocusZ = 0;
let curbSupportFocusX = 0;
let curbSupportFocusZ = 0;
let maskTileSource = null;
let maskTileSubscription = null;
let maskTileFeatures = new Map(); // tileKey → no-curb-class features
let maskCache = new Map();        // tileKey → [{bounds, polygons}] in local coords
let tramTileFeatures = new Map(); // tileKey → broad tram buffers to suppress as raised curbs
let tramCache = new Map();        // tileKey → tram-buffer masks in local coords
let roadbedTileFeatures = new Map(); // tileKey → actual highway roadbed features
let roadbedCache = new Map();     // tileKey → [{bounds, polygons}] in local coords
let parkingIndex = null;          // decor spatial index of parking entries
let parkingCache = new Map();     // tileKey → [{bounds, polygons}] in local coords
let greenCache = new Map();       // tileKey → green-surface masks in local coords
let plannerTrackCorridorVolumes = [];
// Spatial index over the above, rebuilt with it. See setPlannerTrackCorridorVolumes.
let plannerTrackVolumeGrid = null;
let terrainReference = null;
let captureSurfaceBuildGround = null;
let terrainChangeSubscription = null;
const curbRebuildLedger = createSurfaceRebuildLedger();
const curbDependencyScans = new Map();
let curbDependencyRevision = 0;
let roadFormationModel = null;
let roadFormationRevision = -1;
let railFormationModel = null;
let railFormationProvider = null;
let railCivilGroundDependencies = [];
let railCivilGroundSignature = '';
let railCutEdgeEvaluatorKey = null;
let railCutEdgeEvaluator = () => false;
let renderedRailSurfaceObservedRevision = -1;
let renderedRailSurfaceChangedAtMs = 0;
let renderedRailSurfaceRefreshPending = false;
let roadVerticalAlignmentModel = null;
let roadVerticalAlignmentRevision = -1;
let roadSurfaceTiles = null;
let roadSurfaceWaiters = new Map();
let sessionId = 0;
let initialNearCurbTileKeys = new Set();
let parkingIndexReady = false;
let curbMaterialPrewarmState = null;

const buildQueue = createFrameChunkQueue({
    label: 'curbs',
    frameBudgetMs: 4,
    preferAnimationFrame: true,
    workClass: 'near',
    workTier: 'surface',
    // This queue continues streaming after reveal. Startup readiness is the
    // four observer tiles, explicitly gated on every geometry dependency.
    trackWorldReady: false,
    reportWorldProgress: true,
});

function beginInitialNearCurbGate() {
    initialNearCurbTileKeys = initialWorldSupportTileKeys();
    noteWorldQueueActive('curbs');
}

function noteInitialNearCurbTileReady(tileKey) {
    if (!initialNearCurbTileKeys.delete(String(tileKey))) return;
    if (initialNearCurbTileKeys.size === 0) noteWorldQueueIdle('curbs');
}

function curbTileDependenciesReady(tileKey) {
    return parkingIndexReady
        && tileFeatures.has(tileKey)
        && maskTileFeatures.has(tileKey)
        && roadSurfaceTiles.isReady(tileKey);
}

function clearRoadSurfaceWaiter(tileKey) {
    const unsubscribe = roadSurfaceWaiters.get(String(tileKey));
    if (unsubscribe) unsubscribe();
    roadSurfaceWaiters.delete(String(tileKey));
}

function waitForRoadSurfaceTile(tileKey) {
    const key = String(tileKey);
    if (roadSurfaceWaiters.has(key)) return;
    const unsubscribe = roadSurfaceTiles.whenReady(tileKey, () => {
        roadSurfaceWaiters.delete(key);
        enqueueTileBuildIfReady(key);
    });
    roadSurfaceWaiters.set(key, unsubscribe);
}

// Paints an irregular dark joint line: darkness and thickness vary along the
// run, edges bleed softly, and occasional pixels break the line — a real
// weathered gap instead of a crisp drawn stroke. `horizontal` runs the line
// along X at row `at`; otherwise along Y at column `at`.
function paintWornJoint(ctx, len, at, maxThick, r, g, b, baseAlpha, horizontal) {
    for (let i = 0; i < len; i++) {
        if (Math.random() < 0.05) continue;                 // pinched/bright break
        const a = baseAlpha * (0.5 + Math.random() * 0.5);
        const thick = 1 + Math.random() * (maxThick - 1);
        const off = at + (Math.random() - 0.5) * 1.6;
        ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(2)})`;
        if (horizontal) ctx.fillRect(i, off, 1, thick);
        else ctx.fillRect(off, i, thick, 1);
        ctx.fillStyle = `rgba(${r},${g},${b},${(a * 0.3).toFixed(2)})`;
        if (horizontal) ctx.fillRect(i, off - 1.2, 1, thick + 2.4);
        else ctx.fillRect(off - 1.2, i, thick + 2.4, 1);
    }
}

// Light grey concrete curb stone with a dark expansion joint on the left
// edge of each repeat. Lower part of the canvas (the vertical face, v<0.45)
// is slightly darker than the sun-worn top band.
function getCurbTexture() {
    if (curbTexture) return curbTexture;
    const W = 128, H = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const data = img.data;
    // CanvasTexture flips Y: canvas top = v=1 = band top, canvas bottom =
    // v=0 = face bottom.
    const faceRows = Math.floor(H * 0.55);
    for (let y = 0; y < H; y++) {
        const isFace = y >= H - faceRows;
        const base = isFace ? 138 : 158;
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const j = Math.floor((Math.random() - 0.5) * 18);
            data[i + 0] = base + 4 + j;
            data[i + 1] = base + 2 + j;
            data[i + 2] = base + j;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    // Expansion joint at the left edge, full height — painted worn.
    paintWornJoint(ctx, H, 0.4, 2.2, 60, 58, 55, 0.85, false);
    // Narrow dark slits where the curb meets its neighbours: the roadbed at
    // the face bottom (v=0 = canvas BOTTOM, remember the flip) and the
    // sidewalk/ramp at the band's back edge (v=1 = canvas top). The road
    // joint collects more dirt, so it gets the wider line.
    paintWornJoint(ctx, W, H - 3, 3, 45, 43, 40, 0.95, true);
    paintWornJoint(ctx, W, 0.4, 2.6, 45, 43, 40, 0.9, true);
    curbTexture = new THREE.CanvasTexture(canvas);
    curbTexture.wrapS = THREE.RepeatWrapping;
    curbTexture.wrapT = THREE.ClampToEdgeWrapping;
    curbTexture.colorSpace = THREE.SRGBColorSpace;
    curbTexture.anisotropy = 4;
    registerShared(curbTexture);
    return curbTexture;
}

function getCurbMaterial() {
    if (curbMaterial) return curbMaterial;
    curbMaterial = authorizeCurbMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getCurbTexture(),
        roughness: 0.95,
        side: THREE.DoubleSide,
    })), CURB_DRESSING_CLAIM);
    registerShared(curbMaterial);
    return curbMaterial;
}

function getRampMaterial() {
    if (rampMaterial) return rampMaterial;
    // Base (world-anchored) sidewalk texture with world-XZ UVs — identical
    // mapping to the catch-all ground plane and OSM paving polygons, so the
    // ramp foot blends into the ground with no visible seam.
    rampMaterial = authorizeCurbMaterial(applyStreetLampSurfaceLighting(new THREE.MeshStandardMaterial({
        map: getSidewalkTexture(),
        roughness: 0.92,
        side: THREE.DoubleSide,
    })), CURB_RAMP_CLAIM);
    registerShared(rampMaterial);
    return rampMaterial;
}

function getGreenRampMaterial() {
    if (greenRampMaterial) return greenRampMaterial;
    // Same world-anchored grass texture as DecorGreenery. Only the synthetic
    // curb back-ramp uses this material; the concrete curb profile stays
    // visible at the road edge.
    // Decor grass currently follows scene lighting without the additive lamp
    // shader; keep the ramp identical so the texture cannot change tone at
    // its outer edge after dark.
    greenRampMaterial = authorizeCurbMaterial(new THREE.MeshStandardMaterial({
        map: getGrassTexture(),
        roughness: 0.95,
        side: THREE.DoubleSide,
    }), CURB_RAMP_CLAIM);
    registerShared(greenRampMaterial);
    return greenRampMaterial;
}

function getTerrainSeamMaterial() {
    if (terrainSeamMaterial) return terrainSeamMaterial;
    const surface = getActiveTerrainSurface();
    terrainSeamMaterial = authorizeCurbMaterial(applyStreetLampSurfaceLighting(
        new THREE.MeshStandardMaterial({
            map: surface.map,
            bumpMap: surface.bumpMap,
            bumpScale: surface.bumpScale,
            roughness: 0.96,
            metalness: 0,
            side: THREE.DoubleSide,
        }),
    ), CURB_TERRAIN_SEAM_CLAIM);
    // Match the neighbouring road-formation collar: explicit natural landuse
    // stays natural, while upward-facing infill inside the shared urban mask
    // continues the city pavement instead of drawing a green strip behind an
    // otherwise correct curb.
    applyUrbanGroundSurface(terrainSeamMaterial, CURB_TERRAIN_SEAM_CLAIM, {
        fieldPatchwork: true,
        urbanGroundUpwardOnly: true,
    });
    registerShared(terrainSeamMaterial);
    return terrainSeamMaterial;
}

const CURB_MATERIAL_PREWARM_READY_LABEL = 'curb-material-prewarm';

function* createCurbMaterialPrewarm(root, geometry) {
    for (const [name, getMaterial] of [
        ['curb', getCurbMaterial],
        ['ramp', getRampMaterial],
        ['green-ramp', getGreenRampMaterial],
        ['terrain-seam', getTerrainSeamMaterial],
        ['manhole', getManholeMaterial],
    ]) {
        const material = getMaterial();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `CurbMaterialPrewarm:${name}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        root.add(mesh);
        yield { phase: 'curb-material-prewarm:create', name };
    }
    yield* prewarmDetachedObject(root, {
        renderer,
        camera,
        targetScene: scene,
        asyncShaders: true,
        label: CURB_MATERIAL_PREWARM_READY_LABEL,
        uploadBatch: 1,
        sliceMs: 2,
        uploadGeometry: false,
    });
}

function settleCurbMaterialPrewarm(state) {
    if (!state || state.settled) return;
    state.settled = true;
    state.iterator?.return?.();
    state.root.clear();
    state.geometry.dispose();
    if (curbMaterialPrewarmState === state) curbMaterialPrewarmState = null;
    noteWorldQueueIdle(CURB_MATERIAL_PREWARM_READY_LABEL);
}

function startCurbMaterialPrewarm() {
    if (curbMaterialPrewarmState) settleCurbMaterialPrewarm(curbMaterialPrewarmState);
    const root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const state = {
        root,
        geometry,
        iterator: createCurbMaterialPrewarm(root, geometry),
        job: null,
        settled: false,
    };
    curbMaterialPrewarmState = state;
    noteWorldQueueActive(CURB_MATERIAL_PREWARM_READY_LABEL);
    const settle = () => settleCurbMaterialPrewarm(state);
    state.job = buildQueue.enqueue([state], (item) => {
        const outcome = item.iterator.next();
        trackCurbGpuReadiness(outcome.value);
        return outcome.done ? undefined : FRAME_CHUNK_DEFER_ITEM;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: settle,
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 1,
        priority: Number.MAX_SAFE_INTEGER,
        describeItem: () => 'curb material GPU prewarm',
    });
}

function lonLatToLocal(lon, lat) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
        z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M,
    };
}

function tileLocalBounds(tileKey) {
    const parts = String(tileKey || '').split('_').map(Number);
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    const bbox = tileBbox(parts[0], parts[1], anchorLat, anchorLon);
    const a = lonLatToLocal(bbox.west, bbox.south);
    const b = lonLatToLocal(bbox.east, bbox.north);
    return {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
    };
}

function ringToLocalPoints(ring) {
    const points = [];
    let last = null;
    for (const coord of ring || []) {
        if (!Array.isArray(coord) || coord.length < 2) continue;
        const p = lonLatToLocal(coord[0], coord[1]);
        if (last && Math.abs(p.x - last.x) < 0.01 && Math.abs(p.z - last.z) < 0.01) continue;
        points.push(p);
        last = p;
    }
    if (points.length > 1) {
        const first = points[0];
        const end = points[points.length - 1];
        if (Math.abs(first.x - end.x) < 0.01 && Math.abs(first.z - end.z) < 0.01) points.pop();
    }
    return points;
}

// Convert GeoJSON ring sets into local-coordinate mask polygons with bounds.
//
// These five live here, not in core/mask-query.js: that module answers "is this
// point inside one of these polygons" and knows nothing about tiles, the decor
// index or our lon/lat frame. These build the mask lists it is asked about.
function localMasksFromRingSets(ringSets) {
    const masks = [];
    for (const rings of ringSets) {
        const outerRing = ringToLocalPoints(rings[0] || []);
        if (outerRing.length < 3) continue;
        const holeRings = [];
        for (let i = 1; i < rings.length; i++) {
            const hole = ringToLocalPoints(rings[i]);
            if (hole.length >= 3) holeRings.push(hole);
        }
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of outerRing) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        }
        masks.push({ bounds: { minX, maxX, minZ, maxZ }, polygons: [{ outerRing, holeRings }] });
    }
    return masks;
}

function ringSetsFromFeatures(features) {
    const ringSets = [];
    for (const feature of features || []) {
        const geom = feature && feature.geometry;
        if (!geom) continue;
        if (geom.type === 'Polygon') ringSets.push(geom.coordinates);
        else if (geom.type === 'MultiPolygon') ringSets.push(...(geom.coordinates || []));
    }
    return ringSets;
}

// `has`, not truthiness: a tile with no masks caches an empty array, and a
// truthiness check would rebuild it on every query for the life of the tile.
// The identity of the returned array is also load-bearing — core/mask-query.js
// memoises its spatial grid on it (see maskGridFor).
function cachedMasks(cache, tileKey, buildRingSets) {
    if (cache.has(tileKey)) return cache.get(tileKey);
    const masks = localMasksFromRingSets(buildRingSets());
    cache.set(tileKey, masks);
    return masks;
}

// Parking entries near this tile from the citywide decor asset (lon/lat
// bounds query, then converted to local polygons).
function parkingMasksForTile(tileKey) {
    if (!parkingIndex) return [];
    return cachedMasks(parkingCache, tileKey, () => {
        const parts = String(tileKey).split('_').map(Number);
        const bbox = tileBbox(parts[0], parts[1], anchorLat, anchorLon);
        const pad = 0.0005; // ~40-55 m: catch parking straddling the tile edge
        const entries = queryDecorParkingEntries(parkingIndex, {
            minLat: bbox.south - pad, maxLat: bbox.north + pad,
            minLon: bbox.west - pad, maxLon: bbox.east + pad,
        });
        return entries.map((entry) => entry.rings).filter(Boolean);
    });
}

function greenMasksForTile(tileKey) {
    if (!parkingIndex) return [];
    return cachedMasks(greenCache, tileKey, () => {
        const parts = String(tileKey).split('_').map(Number);
        const bbox = tileBbox(parts[0], parts[1], anchorLat, anchorLon);
        const pad = 0.0005;
        return queryDecorGreenEntries(parkingIndex, {
            minLat: bbox.south - pad, maxLat: bbox.north + pad,
            minLon: bbox.west - pad, maxLon: bbox.east + pad,
        }).map((entry) => entry.rings).filter(Boolean);
    });
}

function signedArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j].x * points[i].z - points[i].x * points[j].z;
    }
    return area * 0.5;
}

// Winding convention: the server emits RFC 7946 rings (exterior CCW, holes CW
// in lon/lat). Our local frame negates latitude (z = -lat), which mirrors
// winding, so a compliant exterior ring has NEGATIVE shoelace area here. We
// normalise both ring kinds so that, walking the vertex order, asphalt is on
// the right and the raised (sidewalk) side is on the LEFT — the left normal
// of direction (dx, dz) being (-dz, dx).
function normalizeRingWinding(points, isHole) {
    const area = signedArea(points);
    const wantPositive = isHole;
    if ((area > 0) !== wantPositive) points.reverse();
    return points;
}

// The pad the index is built with. Both queries below run their own exact test
// over the candidates, so the index only has to be a SUPERSET — building it with
// the largest pad any caller uses keeps one index correct for both.
const PLANNER_TRACK_INDEX_PAD_M = BAND_W + RAMP_W + 0.5;

function setPlannerTrackCorridorVolumes(volumes) {
    plannerTrackCorridorVolumes = volumes || [];
    plannerTrackVolumeGrid = createPlannerTrackIndex(plannerTrackCorridorVolumes, {
        padM: PLANNER_TRACK_INDEX_PAD_M,
    });
}

function edgeNearPlannerTrack(a, b, planner, pad = PLANNER_TRACK_INDEX_PAD_M) {
    const { grid: plannerTrackVolumeGrid, volumes: plannerTrackCorridorVolumes } = planner;
    const edgeMinX = Math.min(a.x, b.x);
    const edgeMaxX = Math.max(a.x, b.x);
    const edgeMinZ = Math.min(a.z, b.z);
    const edgeMaxZ = Math.max(a.z, b.z);
    // A pad wider than the index was built with could reach a volume the grid
    // does not return, so that caller falls back to the full scan.
    const entries = (plannerTrackVolumeGrid && pad <= PLANNER_TRACK_INDEX_PAD_M)
        ? plannerTrackVolumeGrid.candidatesInBox(edgeMinX, edgeMinZ, edgeMaxX, edgeMaxZ)
        : null;
    const count = entries ? entries.length : plannerTrackCorridorVolumes.length;
    for (let index = 0; index < count; index++) {
        const volume = entries ? entries[index] : plannerTrackCorridorVolumes[index];
        const extentX = Math.abs(volume.rightX) * (volume.halfWidth + pad)
            + Math.abs(volume.alongX) * (volume.halfDepth + pad);
        const extentZ = Math.abs(volume.rightZ) * (volume.halfWidth + pad)
            + Math.abs(volume.alongZ) * (volume.halfDepth + pad);
        if (edgeMaxX < volume.centerX - extentX || edgeMinX > volume.centerX + extentX) continue;
        if (edgeMaxZ < volume.centerZ - extentZ || edgeMinZ > volume.centerZ + extentZ) continue;
        return true;
    }
    return false;
}

function pointInsideSurfacePlannerTrack(x, z, planner) {
    const { grid: plannerTrackVolumeGrid, volumes: plannerTrackCorridorVolumes } = planner;
    const entries = plannerTrackVolumeGrid ? plannerTrackVolumeGrid.candidatesAt(x, z) : null;
    const count = entries ? entries.length : plannerTrackCorridorVolumes.length;
    for (let cursor = 0; cursor < count; cursor++) {
        const volume = entries ? entries[cursor] : plannerTrackCorridorVolumes[cursor];
        const dx = x - volume.centerX;
        const dz = z - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) > volume.halfWidth || Math.abs(localAlong) > volume.halfDepth) continue;

        // Corridor volumes normally use a vertical OBB for buildings and
        // furniture. A curb crossing needs the actual pitched centreline:
        // only erase it where the ramp is still at street height, never under
        // a viaduct ten metres overhead.
        // finiteOrNull, not Number(): a corridor with no readable level hands
        // out null, and `Number(null)` is 0 — "the ramp is at street height",
        // which erases the curb under a deck instead of leaving it alone.
        const segmentHalfLength = finiteOrNull(volume.segmentHalfLength);
        const startElevationM = finiteOrNull(volume.startElevationM);
        const endElevationM = finiteOrNull(volume.endElevationM);
        if (segmentHalfLength !== null && segmentHalfLength > 0
            && startElevationM !== null && endElevationM !== null) {
            const t = Math.max(0, Math.min(1, (localAlong + segmentHalfLength) / (segmentHalfLength * 2)));
            const elevationM = startElevationM + (endElevationM - startElevationM) * t;
            if (Math.abs(elevationM) <= 0.5) return true;
            continue;
        }
        if (isPointInsideCorridorVolumes(x, CURB_TOP_Y, z, [volume])) return true;
    }
    return false;
}

// A generated curb is wider than its road-edge centreline: behind the 30 cm
// cap sits a one-metre synthetic sidewalk/green ramp. Sample that full raised
// cross-section so none of it can overhang a planner trackbed after the curb
// centreline itself has already cleared the crossing.
function curbPieceTouchesSurfacePlannerTrack(mx, mz, nx, nz, planner) {
    const offsets = [0, BAND_W * 0.5, BAND_W, BAND_W + RAMP_W * 0.5, BAND_W + RAMP_W];
    return offsets.some(offset => pointInsideSurfacePlannerTrack(mx + nx * offset, mz + nz * offset, planner));
}

function segmentOnTileEdge(a, b, bounds) {
    if (!bounds) return false;
    return (Math.abs(a.x - bounds.minX) < TILE_EDGE_EPS && Math.abs(b.x - bounds.minX) < TILE_EDGE_EPS)
        || (Math.abs(a.x - bounds.maxX) < TILE_EDGE_EPS && Math.abs(b.x - bounds.maxX) < TILE_EDGE_EPS)
        || (Math.abs(a.z - bounds.minZ) < TILE_EDGE_EPS && Math.abs(b.z - bounds.minZ) < TILE_EDGE_EPS)
        || (Math.abs(a.z - bounds.maxZ) < TILE_EDGE_EPS && Math.abs(b.z - bounds.maxZ) < TILE_EDGE_EPS);
}

// Split a closed ring into runs of consecutive kept pieces. `dropEdge`
// short-circuits whole edges (tile-border clip artifacts); `nearFilter`
// says whether an edge needs subdividing to SUPPRESS_SAMPLE_M; `dropPiece`
// judges each subdivided piece (given midpoint and the left/raised-side
// normal). Each run is an open polyline; a ring with nothing removed comes
// back as one closed run.
function ringToRuns(points, { dropEdge, nearFilter, dropPiece }) {
    const n = points.length;
    const pieces = []; // { a, b, kept }
    for (let i = 0; i < n; i++) {
        const a = points[i];
        const b = points[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < MIN_SEG_M || (dropEdge && dropEdge(a, b))) {
            pieces.push({ a, b, kept: false });
            continue;
        }
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len; // raised side
        if (!nearFilter || !nearFilter(a, b)) {
            pieces.push({ a, b, kept: true });
            continue;
        }
        const steps = Math.max(1, Math.ceil(len / SUPPRESS_SAMPLE_M));
        for (let s = 0; s < steps; s++) {
            const t0 = s / steps, t1 = (s + 1) / steps;
            const pa = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
            const pb = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
            const mx = (pa.x + pb.x) * 0.5, mz = (pa.z + pb.z) * 0.5;
            pieces.push({ a: pa, b: pb, kept: !dropPiece(mx, mz, nx, nz) });
        }
    }
    if (pieces.every((p) => p.kept)) return [{ points, closed: true }];
    const m = pieces.length;
    const runs = [];
    let run = null;
    // Start scanning just after a removed piece so runs never wrap.
    let start = pieces.findIndex((p) => !p.kept) + 1;
    for (let s = 0; s < m; s++) {
        const piece = pieces[(start + s) % m];
        if (piece.kept) {
            if (!run) run = [piece.a];
            run.push(piece.b);
        } else if (run) {
            runs.push({ points: run, closed: false });
            run = null;
        }
    }
    if (run) runs.push({ points: run, closed: false });
    return runs;
}

// Incremental, byte-for-byte equivalent form of ringToRuns for streamed road
// unions. The old polygon-level queue item still performed every owner query,
// subdivision and emitted run in one callback; a single complex layer-0 union
// could therefore occupy 80+ ms despite living inside FrameChunkQueue. Parking
// rings keep the synchronous helper above because they do not run the vertical
// owner filters.
function createRingRunsTask(points, { dropEdge, nearFilter, dropPiece }) {
    const n = points.length;
    const pieces = [];
    let edgeIndex = 0;
    let activeEdge = null;
    let firstDroppedIndex = -1;
    let phase = 'filter';
    let runs = null;
    let run = null;
    let scanStart = 0;
    let scanOffset = 0;

    const pushPiece = (piece) => {
        if (!piece.kept && firstDroppedIndex < 0) firstDroppedIndex = pieces.length;
        pieces.push(piece);
    };

    return {
        step() {
            if (phase === 'filter') {
                let workUnits = 0;
                while (edgeIndex < n && workUnits < CURB_FILTER_WORK_UNITS_PER_STEP) {
                    if (!activeEdge) {
                        const a = points[edgeIndex];
                        const b = points[(edgeIndex + 1) % n];
                        const len = Math.hypot(b.x - a.x, b.z - a.z);
                        if (len < MIN_SEG_M || (dropEdge && dropEdge(a, b))) {
                            pushPiece({ a, b, kept: false });
                            edgeIndex += 1;
                            workUnits += 1;
                            continue;
                        }
                        const nx = -(b.z - a.z) / len;
                        const nz = (b.x - a.x) / len;
                        if (!nearFilter || !nearFilter(a, b)) {
                            pushPiece({ a, b, kept: true });
                            edgeIndex += 1;
                            workUnits += 1;
                            continue;
                        }
                        activeEdge = {
                            a,
                            b,
                            nx,
                            nz,
                            steps: Math.max(1, Math.ceil(len / SUPPRESS_SAMPLE_M)),
                            stepIndex: 0,
                        };
                    }
                    const edge = activeEdge;
                    const t0 = edge.stepIndex / edge.steps;
                    const t1 = (edge.stepIndex + 1) / edge.steps;
                    const pa = {
                        x: edge.a.x + (edge.b.x - edge.a.x) * t0,
                        z: edge.a.z + (edge.b.z - edge.a.z) * t0,
                    };
                    const pb = {
                        x: edge.a.x + (edge.b.x - edge.a.x) * t1,
                        z: edge.a.z + (edge.b.z - edge.a.z) * t1,
                    };
                    const mx = (pa.x + pb.x) * 0.5;
                    const mz = (pa.z + pb.z) * 0.5;
                    pushPiece({
                        a: pa,
                        b: pb,
                        kept: !dropPiece(mx, mz, edge.nx, edge.nz),
                    });
                    edge.stepIndex += 1;
                    workUnits += 1;
                    if (edge.stepIndex >= edge.steps) {
                        activeEdge = null;
                        edgeIndex += 1;
                    }
                }
                if (edgeIndex < n) return 'more';
                if (firstDroppedIndex < 0) {
                    runs = [{ points, closed: true }];
                    phase = 'done';
                    return 'done';
                }
                runs = [];
                scanStart = firstDroppedIndex + 1;
                phase = 'runs';
                return 'more';
            }
            if (phase === 'runs') {
                let workUnits = 0;
                while (scanOffset < pieces.length && workUnits < CURB_RUN_SCAN_UNITS_PER_STEP) {
                    const piece = pieces[(scanStart + scanOffset) % pieces.length];
                    if (piece.kept) {
                        if (!run) run = [piece.a];
                        run.push(piece.b);
                    } else if (run) {
                        runs.push({ points: run, closed: false });
                        run = null;
                    }
                    scanOffset += 1;
                    workUnits += 1;
                }
                if (scanOffset < pieces.length) return 'more';
                if (run) runs.push({ points: run, closed: false });
                run = null;
                phase = 'done';
            }
            return 'done';
        },
        result: () => runs || [],
        phaseLabel: () => phase,
    };
}

function appendRunGeometry(
    run,
    curb,
    ramp,
    greenRamp = null,
    terrainSeam = null,
    greenMasks = [],
    roadbedMasks = [],
    { backProfile = 'ramp' } = {},
) {
    const points = run.points;
    const n = points.length;
    if (n < 2) return;
    const joins = computeCurbOffsetJoins(points, {
        closed: run.closed,
        miterLimit: MITER_LIMIT,
    });
    // Each sharp vertex has a separate incoming and outgoing row. Segment
    // strips therefore stay parallel to their own edge; the bounded wedge
    // between the rows is closed below instead of becoming a clamped diagonal
    // spike at parking islands and other acute road-union corners.
    const rows = [];
    let u = 0;
    const profileRow = (point, direction, rowU) => createCurbProfileRow(
        point,
        direction,
        {
            u: rowU,
            bandWidthM: BAND_W,
            rampWidthM: RAMP_W,
            curbTopY: CURB_TOP_Y,
            terrainOverlapM: TERRAIN_SEAM_OVERLAP_M,
        },
    );
    for (let i = 0; i < n; i++) {
        if (i > 0) u += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        const p = points[i];
        const join = joins[i];
        const rowU = u / CURB_STONE_M;
        rows.push({
            join,
            incoming: profileRow(p, join.incoming, rowU),
            outgoing: profileRow(p, join.outgoing, rowU),
        });
    }
    const quadCount = run.closed ? n : n - 1;
    for (let i = 0; i < quadCount; i++) {
        const a = rows[i].outgoing;
        const b = rows[(i + 1) % n].incoming;
        // On closed rings the wrap-around quad continues the u accumulation.
        const bu = (i === n - 1)
            ? a.u + Math.hypot(points[0].x - points[i].x, points[0].z - points[i].z) / CURB_STONE_M
            : b.u;
        pushQuad(curb, a.f0, b.f0, a.f1, b.f1, a.u, bu, 0.0, 0.45);
        pushQuad(curb, a.f1, b.f1, a.b, b.b, a.u, bu, 0.45, 1.0);
        if (backProfile === 'vertical') {
            // Parking and planted-island polygons already provide the surface
            // behind their curb. Close the stone itself instead of projecting
            // a one-metre synthetic sidewalk across that mapped surface.
            pushQuad(curb, a.b0, b.b0, a.b, b.b, a.u, bu, 0.0, 0.45);
            continue;
        }
        // Sample the actual middle of the synthetic back-ramp. When that
        // footprint belongs to a mapped lawn/park, keep the slope but clothe
        // it in the same grass texture; otherwise the one-metre concrete ramp
        // hides all but a thin green line beside the curb.
        const rampMidX = (a.b.x + b.b.x + a.r.x + b.r.x) * 0.25;
        const rampMidZ = (a.b.z + b.b.z + a.r.z + b.r.z) * 0.25;
        if (backProfile === 'terrain-seam') {
            // Continue the raised side from the exact rear curb vertices to
            // the final road-formation/terrain surface. This seam is also the
            // curb-to-sidewalk infill: suppressing it merely because a civil
            // batter exists leaves the stone's rear face exposed above that
            // lower batter.
            if (terrainSeam) {
                pushRampQuad(
                    terrainSeam,
                    a.b,
                    b.b,
                    a.terrainLanding,
                    b.terrainLanding,
                );
            }
            continue;
        }
        const rampTarget = greenRamp
            && pointInAnyMask(rampMidX, rampMidZ, greenMasks)
            && !pointInAnyMask(rampMidX, rampMidZ, roadbedMasks)
            ? greenRamp
            : ramp;
        pushRampQuad(rampTarget, a.b, b.b, a.r, b.r);
    }

    // Masked curb ownership (parking bays, crossings, neighbouring roads) can
    // split one boundary into open runs. The longitudinal strips above used to
    // leave both cross-sections hollow, exposing a dark triangular slit at the
    // exact places where curbs meet angled islands or parking surfaces.
    if (!run.closed) {
        pushCurbRunEndCap(curb, rows[0].outgoing, backProfile, false);
        pushCurbRunEndCap(curb, rows[n - 1].incoming, backProfile, true);
    }

    const joinStart = run.closed ? 0 : 1;
    const joinEnd = run.closed ? n : n - 1;
    for (let i = joinStart; i < joinEnd; i++) {
        const row = rows[i];
        if (!row.join.beveled) continue;
        const incoming = row.incoming;
        const outgoing = row.outgoing;
        pushCurbBevelJoin(curb, incoming.f1, incoming.b, outgoing.b, incoming.u);

        if (backProfile === 'vertical') {
            pushQuad(
                curb,
                incoming.b0,
                outgoing.b0,
                incoming.b,
                outgoing.b,
                incoming.u,
                outgoing.u,
                0.0,
                0.45,
            );
            continue;
        }

        const rampMidX = (incoming.b.x + outgoing.b.x + incoming.r.x + outgoing.r.x) * 0.25;
        const rampMidZ = (incoming.b.z + outgoing.b.z + incoming.r.z + outgoing.r.z) * 0.25;
        if (pointInAnyMask(rampMidX, rampMidZ, roadbedMasks)) continue;
        if (backProfile === 'terrain-seam') {
            if (terrainSeam) {
                pushRampBevelJoin(
                    terrainSeam,
                    incoming.b,
                    outgoing.b,
                    incoming.terrainLanding,
                    outgoing.terrainLanding,
                );
            }
            continue;
        }
        const rampTarget = greenRamp && pointInAnyMask(rampMidX, rampMidZ, greenMasks)
            ? greenRamp
            : ramp;
        pushRampBevelJoin(
            rampTarget,
            incoming.b,
            outgoing.b,
            incoming.r,
            outgoing.r,
        );
    }
}

function pushCurbRunEndCap(out, row, backProfile, reverse) {
    const rearBottom = backProfile === 'vertical'
        ? row.b0
        : backProfile === 'terrain-seam'
            ? row.terrainLanding
            : row.r;
    if (reverse) {
        pushQuad(
            out,
            rearBottom,
            row.f0,
            row.b,
            row.f1,
            row.u,
            row.u,
            0,
            1,
        );
        return;
    }
    pushQuad(
        out,
        row.f0,
        rearBottom,
        row.f1,
        row.b,
        row.u,
        row.u,
        0,
        1,
    );
}

function pushTriangleUp(out, a, b, c, uvs = null) {
    const windingY = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const second = windingY >= 0 ? b : c;
    const third = windingY >= 0 ? c : b;
    out.positions.push(
        a.x, a.y, a.z,
        second.x, second.y, second.z,
        third.x, third.y, third.z,
    );
    if (uvs) {
        const secondUv = windingY >= 0 ? uvs[1] : uvs[2];
        const thirdUv = windingY >= 0 ? uvs[2] : uvs[1];
        out.uvs.push(
            uvs[0][0], uvs[0][1],
            secondUv[0], secondUv[1],
            thirdUv[0], thirdUv[1],
        );
    } else {
        out.uvs.push(0, 0, 0, 0, 0, 0);
    }
}

function pushCurbBevelJoin(out, faceTop, incomingBand, outgoingBand, u) {
    pushTriangleUp(out, faceTop, incomingBand, outgoingBand, [
        [u, 0.45],
        [u, 1],
        [u, 1],
    ]);
}

function pushRampBevelJoin(out, incomingBand, outgoingBand, incomingRamp, outgoingRamp) {
    pushTriangleUp(out, incomingBand, incomingRamp, outgoingBand);
    pushTriangleUp(out, outgoingBand, incomingRamp, outgoingRamp);
}

// Ramp triangles must wind UPWARD-facing: the ramp uses forced (0,1,0)
// normals, and with a DoubleSide material three.js negates the shading
// normal on back faces — down-winding would flip "up" to "down" and the
// ramp would render ambient-only (a uniform dark strip along every curb).
// The face/band quads don't care: their computeVertexNormals() normals get
// flipped together with the facing, which lands correctly.
function pushRampQuad(out, aLo, bLo, aHi, bHi) {
    out.positions.push(
        aLo.x, aLo.y, aLo.z, aHi.x, aHi.y, aHi.z, bLo.x, bLo.y, bLo.z,
        bLo.x, bLo.y, bLo.z, aHi.x, aHi.y, aHi.z, bHi.x, bHi.y, bHi.z,
    );
    // UVs are placeholders — the tile builder overwrites them with world-XZ
    // mapping to match the ground texture.
    out.uvs.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

// Two triangles for the strip section between rows a and b, from profile
// line (aLo,bLo) to (aHi,bHi). Curb UVs are (u along run, v across profile).
function pushQuad(out, aLo, bLo, aHi, bHi, ua, ub, vLo, vHi) {
    out.positions.push(
        aLo.x, aLo.y, aLo.z, bLo.x, bLo.y, bLo.z, aHi.x, aHi.y, aHi.z,
        bLo.x, bLo.y, bLo.z, bHi.x, bHi.y, bHi.z, aHi.x, aHi.y, aHi.z,
    );
    out.uvs.push(
        ua, vLo, ub, vLo, ua, vHi,
        ub, vLo, ub, vHi, ua, vHi,
    );
}

const TERRAIN_VERTICES_PER_CHUNK = 256;

// One tile's geometry, built across several frames instead of one.
//
// This used to be a single queue item, and a single item cannot be interrupted:
// the frame budget only decides whether to START one. Measured on a Zagreb ride
// the longest curb item was 71.9 ms with six over 50 ms, which is a dropped
// frame every time a curb tile lands however small the budget is set. The work
// splits cleanly along the two loops it already had — one road polygon and one
// parking ring at a time — so each stage is a fraction of a frame and the
// scheduler can stop between any two. A server feature may be a MultiPolygon:
// treating the whole feature as one item left the seven-piece Most mladosti
// bridge union as a recurring 60-100 ms callback despite the queue budget.
//
// Ordering is preserved exactly: roads before parking, features and polygons in tile order,
// appending into the same accumulators, so the geometry is byte-identical to
// what the one-shot version produced.

// Setup used to be one stage that projected every coordinate of every mask kind
// this tile needs — no-curb surfaces, tram buffers, roadbeds, parking lots,
// green surfaces — before any road feature could start. Cooperative staging
// could not help it: `roads` and `parking` divide per feature, but a stage that
// does not divide is one long frame however small the slice around it is.
//
// Each entry below resolves ONE mask kind into the module-level cache that
// prepareTileBuildContext then reads, so the setup cost is spread over as many
// stages as there are kinds, and the assemble step afterwards is all cache hits.
const CURB_MASK_STAGES = [
    ['masks:noCurb', (tileKey) => cachedMasks(maskCache, tileKey,
        () => ringSetsFromFeatures(maskTileFeatures.get(tileKey)))],
    ['masks:tram', (tileKey) => cachedMasks(tramCache, tileKey,
        () => ringSetsFromFeatures(tramTileFeatures.get(tileKey)))],
    ['masks:roadbed', (tileKey) => cachedMasks(roadbedCache, tileKey,
        () => ringSetsFromFeatures(roadbedTileFeatures.get(tileKey)))],
    ['masks:parking', (tileKey) => parkingMasksForTile(tileKey)],
    ['masks:green', (tileKey) => greenMasksForTile(tileKey)],
];

function createTilePrepTask(tileKey, suppliedGround = null) {
    let phase = 'inputs';
    let inputSteps = suppliedGround ? null : captureSurfaceBuildGround('curb-tile');
    let ground = retainReadSnapshot(suppliedGround, 'curb-tile');
    let groundCurrent = () => true;
    let maskStageAt = 0;
    let context = null;
    let featureIndex = 0;
    let roadFeatureTask = null;
    let parkingIndexAt = 0;
    let result = null;

    // The gates prepareTileBuildContext applies before it touches any mask. Run
    // them first so a tile with nothing to build still aborts in one cheap step
    // rather than after resolving five mask kinds it will never use.
    function tileHasWorkToDo() {
        if (!curbsGroup) return false;
        const features = tileFeatures.get(tileKey);
        if (!features || features.length === 0) return false;
        return maskTileFeatures.has(tileKey) && !!tileLocalBounds(tileKey);
    }

    function masks() {
        if (maskStageAt === 0 && !tileHasWorkToDo()) return 'abort';
        CURB_MASK_STAGES[maskStageAt][1](tileKey);
        maskStageAt += 1;
        phase = maskStageAt < CURB_MASK_STAGES.length
            ? CURB_MASK_STAGES[maskStageAt][0]
            : 'assemble';
        return 'more';
    }

    function assemble() {
        // Every mask kind is cached by now, so this is the cheap part that was
        // always the point of the stage: bounds, accumulators, ring filters.
        const prepared = prepareTileBuildContext(tileKey, ground);
        if (!prepared) return 'abort';
        context = prepared;
        phase = 'roads';
        return 'more';
    }

    function roads() {
        const { features } = context;
        while (featureIndex < features.length) {
            if (!roadFeatureTask) {
                roadFeatureTask = createRoadFeatureGeometryTask(
                    context,
                    features[featureIndex],
                );
                // Feature ownership/filter setup can lazily compile the road
                // alignment model. Yield before the first polygon so that
                // one queue item never combines that one-time work with a
                // substantial geometry part.
                return 'more';
            }
            const outcome = roadFeatureTask.step();
            if (outcome === 'more') return 'more';
            roadFeatureTask = null;
            featureIndex += 1;
            if (outcome === 'done') return 'more';
            // Empty/unsupported features cost no geometry work and can be
            // skipped in this item. A real polygon always yields after one.
        }
        if (featureIndex >= features.length) phase = 'parking';
        return 'more';
    }

    function parking() {
        const { parkingMasks } = context;
        if (parkingIndexAt < parkingMasks.length) {
            appendParkingRingGeometry(context, parkingIndexAt);
            parkingIndexAt += 1;
            return 'more';
        }
        result = {
            tileKey,
            bounds: context.bounds,
            ground,
            curb: context.curb,
            ramp: context.ramp,
            greenRamp: context.greenRamp,
            terrainSeam: context.terrainSeam,
            manholes: context.manholes,
            heightRanges: context.heightRanges,
            verticalAlignmentModel: context.verticalAlignmentModel,
            terrainYByOwner: new Map(),
        };
        phase = 'done';
        return 'done';
    }

    return {
        // 'more' — call again; 'done' — state is ready; 'abort' — nothing to build.
        step() {
            if (ground && !groundCurrent()) return 'stale';
            if (phase === 'inputs') {
                if (!ground) {
                    const next = inputSteps.next();
                    if (!next.done) return 'more';
                    ground = next.value;
                    if (!ground) { inputSteps = captureSurfaceBuildGround('curb-tile'); return 'more'; }
                }
                inputSteps = null;
                const renderedRailSurface = suppliedGround ? ground.renderedRailSurface
                    : terrainReference?.renderedRailSurface || null;
                const planner = suppliedGround ? ground.planner : Object.freeze({
                    grid: plannerTrackVolumeGrid, volumes: plannerTrackCorridorVolumes });
                if (renderedRailSurface === undefined || !planner || typeof ground.isCurrent !== 'function') {
                    throw new TypeError('Curb build requires explicit immutable ground, rail surface and planner inputs');
                }
                const bounds = tileLocalBounds(tileKey);
                const queryBounds = bounds ? {
                    minX: bounds.minX - FORMATION_DIRTY_PADDING_M, maxX: bounds.maxX + FORMATION_DIRTY_PADDING_M,
                    minZ: bounds.minZ - FORMATION_DIRTY_PADDING_M, maxZ: bounds.maxZ + FORMATION_DIRTY_PADDING_M,
                } : null;
                const baseCurrent = ground.currentWithin?.(queryBounds) || ground.isCurrent;
                groundCurrent = suppliedGround ? baseCurrent : () => baseCurrent()
                    && renderedRailSurface === (terrainReference?.renderedRailSurface || null)
                    && planner.grid === plannerTrackVolumeGrid && planner.volumes === plannerTrackCorridorVolumes;
                ground = Object.freeze({ ...ground, renderedRailSurface, planner });
                phase = CURB_MASK_STAGES[0][0];
                return 'more';
            }
            if (phase.startsWith('masks:')) return masks();
            if (phase === 'assemble') return assemble();
            if (phase === 'roads') return roads();
            if (phase === 'parking') return parking();
            return 'done';
        },
        // Which stage the queue is about to run, so a fat item names the work.
        // `roads` and `parking` are one feature/ring each; `setup` is the whole
        // per-tile mask preparation and is the only one that cannot subdivide,
        // which is exactly what the fat-item line needs to be able to say.
        phase: () => {
            if (phase !== 'roads') return phase;
            const osmIds = context?.features?.[featureIndex]?.properties?.osm_ids;
            const featureLabel = Array.isArray(osmIds) && osmIds.length > 0
                ? `roads ${osmIds.slice(0, 4).join('+')}`
                : 'roads';
            return roadFeatureTask
                ? `${featureLabel} ${roadFeatureTask.progressLabel()}`
                : featureLabel;
        },
        state: () => result,
        isCurrent: () => groundCurrent(),
        dispose() {
            inputSteps?.return?.(); inputSteps = null;
            ground?.release?.(); ground = null;
        },
    };
}

function currentRailCutEdgeEvaluator(model) {
    // Independent read owners share one immutable profile array. Key on that
    // data, rather than rebuilding the edge index for each retained handle.
    const profiles = model?.getSurfaceProfiles?.() || null;
    const revision = model?.revision || 0;
    const mutation = model?.civilGroundMutationRevision || 0;
    if (railCutEdgeEvaluatorKey?.profiles !== profiles
        || railCutEdgeEvaluatorKey?.revision !== revision
        || railCutEdgeEvaluatorKey?.mutation !== mutation) {
        railCutEdgeEvaluatorKey = { profiles, revision, mutation };
        railCutEdgeEvaluator = createRailCutEdgeEvaluator(
            model,
            RAIL_CUT_EDGE_PADDING_M,
        );
    }
    return railCutEdgeEvaluator;
}

// Everything the two geometry loops need, resolved once before either starts.
function prepareTileBuildContext(tileKey, ground) {
    if (!curbsGroup) return null;
    const features = tileFeatures.get(tileKey);
    if (!features || features.length === 0) return null;
    // Never display provisional, unmasked curb rings. The subscription-level
    // dependency gate waits for roads:cab plus parking/green surfaces before a
    // build is enqueued; retain this invariant here as a defensive boundary.
    if (!maskTileFeatures.has(tileKey)) return null;
    const bounds = tileLocalBounds(tileKey);
    if (!bounds) return null;
    const verticalAlignmentModel = ground.verticalAlignments?.getAlignments().length
        ? ground.verticalAlignments : null;
    const noCurbMasks = cachedMasks(maskCache, tileKey,
        () => ringSetsFromFeatures(maskTileFeatures.get(tileKey)));
    const tramMasks = cachedMasks(tramCache, tileKey,
        () => ringSetsFromFeatures(tramTileFeatures.get(tileKey)));
    const roadbedMasks = cachedMasks(roadbedCache, tileKey,
        () => ringSetsFromFeatures(roadbedTileFeatures.get(tileKey)));
    const parkingMasks = parkingMasksForTile(tileKey);
    const greenMasks = greenMasksForTile(tileKey);
    const edgeMayTouchRailCut = currentRailCutEdgeEvaluator(ground.railFormation);
    const renderedRailSurface = ground.renderedRailSurface;

    const curb = { positions: [], uvs: [] };
    // Manhole covers ride the same kept curb runs — see manholes.js.
    const manholes = { positions: [], uvs: [] };
    const ramp = { positions: [], uvs: [] };
    const greenRamp = { positions: [], uvs: [] };
    const terrainSeam = { positions: [], uvs: [] };
    const heightRanges = [];

    // Road-union rings from the server: suppress pieces inside no-curb
    // surfaces, and pieces whose raised side faces a parking area (street
    // parking is roadbed — the curb wraps around it instead, below). A broad
    // tram routing buffer may suppress only its own unsupported perimeter. If
    // the lower side is real highway, that edge is still the final visible
    // carriageway/sidewalk boundary even when the coarse tram proxy overlaps
    // it; the exact published trackbed wins later through the shared surface
    // hierarchy rather than moving or deleting the source curb pre-emptively.
    const roadRingFilters = {
        dropEdge: (a, b) => segmentOnTileEdge(a, b, bounds),
        nearFilter: (a, b) => edgeNearAnyMask(a, b, noCurbMasks)
            || edgeNearAnyMask(a, b, tramMasks, 0.25)
            || edgeNearAnyMask(a, b, parkingMasks, 1.2)
            || edgeNearPlannerTrack(a, b, ground.planner)
            || edgeMayTouchRailCut(a, b),
        dropPiece: (mx, mz, nx, nz) => pointInAnyMask(mx, mz, noCurbMasks)
            || curbTramProxySuppressesBoundary(
                mx,
                mz,
                nx,
                nz,
                tramMasks,
                roadbedMasks,
            )
            || curbPieceTouchesSurfacePlannerTrack(mx, mz, nx, nz, ground.planner)
            || verticalAlignmentModel?.containsReplacementCorridor(mx, mz, 18)
            || PARKING_GAP_SAMPLES_M.some((d) => pointInAnyMask(mx + nx * d, mz + nz * d, parkingMasks)),
    };
    return {
        tileKey,
        ground,
        features,
        bounds,
        noCurbMasks,
        tramMasks,
        roadbedMasks,
        parkingMasks,
        greenMasks,
        curb,
        manholes,
        ramp,
        greenRamp,
        terrainSeam,
        heightRanges,
        roadRingFilters,
        railFormation: ground.railFormation,
        renderedRailSurface,
        verticalAlignmentModel,
    };
}

// Cheap conservative gate before the exact height-owner test. A mixed curb
// union may contain thousands of edges, but only edges whose boxes reach a
// vertical alignment can possibly be the false connector between upper and
// lower roads. Index the aligned centreline segments once per feature and run
// the expensive two-owner height query only inside that narrow corridor.
function createSeparatedOwnerEdgeEvaluator(
    verticalOsmIds,
    roadVerticalAlignments,
    padM = CURB_SEPARATED_OWNER_PAD_M,
) {
    const alignments = Array.from(new Set(
        (Array.isArray(verticalOsmIds) ? verticalOsmIds : [])
            .map(osmId => (
                roadVerticalAlignments?.getProfileOwnerForOsmId?.(osmId)
                || roadVerticalAlignments?.getAlignmentForOsmId?.(osmId)
            ))
            .filter(Boolean),
    ));
    const pad = Math.max(0, Number(padM) || 0);
    const segments = [];
    for (const alignment of alignments) {
        const points = alignment?.points || [];
        for (let index = 0; index + 1 < points.length; index++) {
            const a = points[index];
            const b = points[index + 1];
            if (![a?.x, a?.z, b?.x, b?.z].every(Number.isFinite)) continue;
            segments.push({
                bounds: {
                    minX: Math.min(a.x, b.x) - pad,
                    minZ: Math.min(a.z, b.z) - pad,
                    maxX: Math.max(a.x, b.x) + pad,
                    maxZ: Math.max(a.z, b.z) + pad,
                },
            });
        }
    }
    if (segments.length === 0) return () => false;
    const grid = createBoundsGrid(segments);
    return (a, b) => {
        const minX = Math.min(a.x, b.x);
        const minZ = Math.min(a.z, b.z);
        const maxX = Math.max(a.x, b.x);
        const maxZ = Math.max(a.z, b.z);
        for (const segment of grid.candidatesInBox(minX, minZ, maxX, maxZ)) {
            const bounds = segment.bounds;
            if (maxX < bounds.minX || minX > bounds.maxX
                || maxZ < bounds.minZ || minZ > bounds.maxZ) continue;
            return true;
        }
        return false;
    };
}

function createRoadFeatureGeometryTask(context, feature) {
    const { terrain: terrainReference, roadFormation: roadFormationModel } = context.ground;
    const {
        curb, ramp, greenRamp, terrainSeam, manholes, greenMasks, roadbedMasks, heightRanges,
        roadRingFilters, railFormation, renderedRailSurface, verticalAlignmentModel,
    } = context;
    const heightData = [curb, ramp, greenRamp, terrainSeam, manholes];
    const starts = heightData.map(data => data.positions.length);
    const geom = feature && feature.geometry;
    const osmIds = Array.isArray(feature?.properties?.osm_ids)
        ? feature.properties.osm_ids
        : null;
    // A synthesized underpass surface owns the complete short tunnel member.
    // Its independent PostGIS buffer is a closed capsule; keeping that curb
    // feature would recreate the full circular cap that the replacement joins
    // smoothly to the two-lane approaches.
    const replacedWholeFeature = Array.isArray(osmIds)
        && osmIds.length > 0
        && osmIds.every(osmId => (
            verticalAlignmentModel?.replacesRoadSurfaceForOsmId(osmId)
        ));
    // Resolve this once per polygon feature, not once per vertex. Ordinary
    // curb unions retain the existing road-formation hot path; a bridge-owned
    // feature is pinned to its layer before the lower crossing can claim it.
    const verticalOsmIds = verticalAlignmentModel && Array.isArray(osmIds)
        ? osmIds.filter(osmId => verticalAlignmentModel.getAlignmentForOsmId(osmId))
        : null;
    const verticalLayer = finiteOrNull(feature?.properties?.vertical_layer) ?? 0;
    // A terrain landing is meaningful only for an ordinary curb at the DGU
    // ground level. Bridge/tunnel curbs keep a closed rear face; extending
    // earth from one of those carried edges would create a flap into open air.
    const backProfile = !terrainReference
        ? 'ramp'
        : verticalLayer === 0 && !(verticalOsmIds?.length)
            ? 'terrain-seam'
            : 'vertical';
    const curbSceneYCache = new Map();
    const curbSceneYAtLocal = (x, z) => {
        const key = `${x}|${z}`;
        if (curbSceneYCache.has(key)) return curbSceneYCache.get(key);
        const sceneY = resolveCurbSceneYAtLocal({
            x,
            z,
            osmIds,
            verticalOsmIds,
            roadVerticalAlignments: verticalAlignmentModel,
            roadFormation: roadFormationModel,
            terrain: terrainReference,
            allowStaleRoadFormation: true,
        });
        curbSceneYCache.set(key, sceneY);
        return sceneY;
    };
    const crossesRailCut = (mx, mz, nx, nz) => (
        curbCrossesOpenRailCutAtLocal({
            x: mx,
            z: mz,
            normalX: nx,
            normalZ: nz,
            crossSectionOffsetsM: CURB_RAIL_CUT_CROSS_SECTION_OFFSETS_M,
            curbSceneYAtLocal,
            railFormation,
        })
    );
    const touchesRenderedRailSurface = (mx, mz, nx, nz) => (
        curbTouchesRenderedRailSurfaceAtLocal({
            x: mx,
            z: mz,
            normalX: nx,
            normalZ: nz,
            crossSectionOffsetsM: CURB_RAIL_CUT_CROSS_SECTION_OFFSETS_M,
            curbSceneYAtLocal,
            renderedRailSurface,
        })
    );
    const railAwareRoadRingFilters = railFormation || renderedRailSurface
        ? {
            ...roadRingFilters,
            dropPiece: (mx, mz, nx, nz) => (
                roadRingFilters.dropPiece(mx, mz, nx, nz)
                || (railFormation && crossesRailCut(mx, mz, nx, nz))
                || (renderedRailSurface
                    && touchesRenderedRailSurface(mx, mz, nx, nz))
            ),
        }
        : roadRingFilters;
    const hasReplacementAlignment = verticalOsmIds?.some(osmId => (
        verticalAlignmentModel.replacesRoadSurfaceForOsmId(osmId)
        || verticalAlignmentModel.getAlignmentForOsmId(osmId)
            ?.definition?.replaceRoadSurface
    ));
    const mixedVerticalUnion = curbUnionNeedsSeparatedOwnerChecks({
        verticalLayer: feature?.properties?.vertical_layer,
        osmIds,
        verticalOsmIds,
    });
    const isBufferedRoadJoinArtifact = verticalAlignmentModel
        ?.createBufferedRoadJoinArtifactEvaluator(osmIds, ROAD_JOIN_CAP_RADIUS_M)
        || ((x, z) => verticalAlignmentModel?.isBufferedRoadJoinArtifactAtLocal(
            x,
            z,
            osmIds,
            ROAD_JOIN_CAP_RADIUS_M,
        ));
    const hasSeparatedOwnersAt = (x, z) => (
        mixedVerticalUnion
        && curbUnionHasSeparatedOwnersAtLocal({
            x,
            z,
            osmIds,
            verticalOsmIds,
            roadVerticalAlignments: verticalAlignmentModel,
            roadFormation: roadFormationModel,
            minimumSeparationM: CURB_OWNER_SEPARATION_M,
            allowStaleRoadFormation: true,
        })
    );
    const edgeMightTouchSeparatedOwners = mixedVerticalUnion
        ? createSeparatedOwnerEdgeEvaluator(
            verticalOsmIds,
            verticalAlignmentModel,
            CURB_SEPARATED_OWNER_PAD_M,
        )
        : () => false;
    const featureRingFilters = !verticalAlignmentModel
        ? railAwareRoadRingFilters
        : {
            ...railAwareRoadRingFilters,
            // Both polygons at a layer boundary have a rounded ST_Buffer cap:
            // the bridge-only polygon and the adjoining at-grade road polygon.
            // Test against every loaded structural alignment so both halves of
            // the false curb are opened. Ordinary edges retain the fast path
            // and are subdivided only when an endpoint/cap is actually nearby.
            nearFilter: (a, b) => (
                railAwareRoadRingFilters.nearFilter(a, b)
                // `dropPiece` is evaluated only after `nearFilter` opts an
                // edge into subdivision. A synthesized underpass alignment
                // begins at its ramp toe, while the false layer-0 buffer cap
                // sits roughly 91 m later at the tunnel portal. The old
                // endpoint-only join test therefore never invoked the
                // replacement-corridor filter at the actual cap.
                || (hasReplacementAlignment && replacementCorridorTouchesEdge(
                    verticalAlignmentModel,
                    a,
                    b,
                    18,
                ))
                || isBufferedRoadJoinArtifact(
                    a.x,
                    a.z,
                )
                || isBufferedRoadJoinArtifact(
                    b.x,
                    b.z,
                )
                || isBufferedRoadJoinArtifact(
                    (a.x + b.x) * 0.5,
                    (a.z + b.z) * 0.5,
                )
                || edgeMightTouchSeparatedOwners(a, b)
            ),
            dropPiece: (mx, mz, nx, nz) => (
                railAwareRoadRingFilters.dropPiece(mx, mz, nx, nz)
                || isBufferedRoadJoinArtifact(
                    mx,
                    mz,
                )
                // A planar ST_Union can wrap an upper approach and a lower
                // road into one at-grade intersection ring. Remove only the
                // locally ambiguous connector pieces; the alignment renderer
                // owns the upper continuous curb and the lower road keeps its
                // own formation height. No geometry may slope between them.
                || hasSeparatedOwnersAt(mx, mz)
            ),
        };
    const polygons = !geom || replacedWholeFeature
        ? []
        : geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? (geom.coordinates || [])
            : [];
    let polygonIndex = 0;
    let ringIndex = 0;
    let ringTask = null;
    let runs = null;
    let runIndex = 0;
    let finalized = false;

    function finalizeHeightRanges() {
        if (finalized) return;
        finalized = true;
        for (let index = 0; index < heightData.length; index++) {
            const positions = heightData[index].positions;
            if (positions.length <= starts[index]) continue;
            heightRanges.push({
                positions,
                start: starts[index],
                end: positions.length,
                osmIds,
                verticalOsmIds,
                drapeKind: heightData[index] === terrainSeam
                    ? CURB_DRAPE_KIND.TERRAIN_SEAM
                    : CURB_DRAPE_KIND.OWNER,
            });
        }
    }

    return {
        // Filter one bounded ring slice, then emit one run per queue item. The
        // feature remains off-scene until the tile transaction publishes it,
        // and polygon/ring/run ordering is identical to the synchronous build.
        step() {
            if (polygonIndex >= polygons.length) {
                finalizeHeightRanges();
                return polygons.length === 0 ? 'empty' : 'done';
            }
            const rings = polygons[polygonIndex];
            if (ringIndex >= (rings || []).length) {
                polygonIndex += 1;
                ringIndex = 0;
                if (polygonIndex < polygons.length) return 'more';
                finalizeHeightRanges();
                return 'done';
            }
            if (runs) {
                if (runIndex < runs.length) {
                    const run = runs[runIndex];
                    appendRunGeometry(
                        run,
                        curb,
                        ramp,
                        greenRamp,
                        terrainSeam,
                        greenMasks,
                        roadbedMasks,
                        {
                            // The one-metre concrete back-ramp belongs to the
                            // legacy flat catch-all ground. In a DGU terrain
                            // world, a terrain/urban-ground collar closes the
                            // raised side against its actual civil support.
                            backProfile,
                        },
                    );
                    pushManholesAlongRun(manholes, run);
                    runIndex += 1;
                    return 'more';
                }
                runs = null;
                runIndex = 0;
                ringIndex += 1;
                return 'more';
            }
            if (!ringTask) {
                const points = ringToLocalPoints(rings[ringIndex]);
                if (points.length < 3) {
                    ringIndex += 1;
                    return 'more';
                }
                normalizeRingWinding(points, ringIndex > 0);
                ringTask = createRingRunsTask(points, featureRingFilters);
                return 'more';
            }
            const ringStatus = ringTask.step();
            if (ringStatus === 'more') return 'more';
            runs = ringTask.result();
            ringTask = null;
            runIndex = 0;
            return 'more';
        },
        progressLabel() {
            if (polygons.length === 0) return 'empty';
            const rings = polygons[Math.min(polygonIndex, polygons.length - 1)] || [];
            const polygonLabel = `polygon ${Math.min(polygonIndex + 1, polygons.length)}/${polygons.length}`;
            const ringLabel = `ring ${Math.min(ringIndex + 1, Math.max(1, rings.length))}/${Math.max(1, rings.length)}`;
            if (ringTask) return `${polygonLabel} ${ringLabel} ${ringTask.phaseLabel()}`;
            if (runs) return `${polygonLabel} ${ringLabel} run ${Math.min(runIndex + 1, Math.max(1, runs.length))}/${Math.max(1, runs.length)}`;
            return `${polygonLabel} ${ringLabel}`;
        },
    };
}

// Parking-area outer rings: same curb profile around the lot, except where the
// lot meets the roadbed (that side stays open, like the real dropped entry),
// overlaps another lot, or sits in a no-curb surface. The citywide asset isn't
// tile-clipped, so each tile only emits pieces whose midpoint it owns.
function appendParkingRingGeometry(context, pi) {
    const { terrain: terrainReference, roadFormation: roadFormationModel } = context.ground;
    const {
        bounds, noCurbMasks, roadbedMasks, parkingMasks, greenMasks,
        curb, ramp, greenRamp, terrainSeam, heightRanges, railFormation, verticalAlignmentModel,
    } = context;
    const heightData = [curb, ramp, greenRamp, terrainSeam];
    const starts = heightData.map(data => data.positions.length);
    const selfMask = parkingMasks[pi];
    const points = selfMask.polygons[0].outerRing.slice();
    if (points.length < 3 || Math.abs(signedArea(points)) < PARKING_MIN_AREA_M2) return;
    normalizeRingWinding(points, false);
    // The "open" side of a parking curb is any roadbed or any OTHER lot. That used to
    // be materialised per ring as `roadbedMasks.concat(parkingMasks.filter(j !== pi))`,
    // which is two allocations per ring — and, once mask queries became grid-indexed,
    // a whole spatial index REBUILT per ring, because the grid is memoised on the array
    // identity and that array was new every time. A tile with a hundred lots therefore
    // built a hundred indexes over nearly the same hundred polygons.
    //
    // Querying the tile's own cached arrays instead means each is indexed once per tile
    // and the index is shared with the road-feature pass that already queries them.
    const openSurface = (x, z) => pointInAnyMask(x, z, roadbedMasks)
        || pointInAnyMaskExcept(x, z, parkingMasks, selfMask);
    const parkingCurbSceneYAtLocal = (x, z) => resolveCurbSceneYAtLocal({
        x,
        z,
        osmIds: null,
        verticalOsmIds: null,
        roadVerticalAlignments: verticalAlignmentModel,
        roadFormation: roadFormationModel,
        terrain: terrainReference,
        allowStaleRoadFormation: true,
    });
    const parkingRingFilters = {
        dropEdge: null,
        nearFilter: () => true,
        dropPiece: (mx, mz, nx, nz) => {
            if (mx < bounds.minX || mx > bounds.maxX || mz < bounds.minZ || mz > bounds.maxZ) return true;
            if (curbCrossesOpenRailCutAtLocal({
                x: mx,
                z: mz,
                normalX: nx,
                normalZ: nz,
                crossSectionOffsetsM: CURB_RAIL_CUT_CROSS_SECTION_OFFSETS_M,
                curbSceneYAtLocal: parkingCurbSceneYAtLocal,
                railFormation,
            })) return true;
            if (verticalAlignmentModel?.containsReplacementCorridor(mx, mz, 18)) return true;
            if (curbPieceTouchesSurfacePlannerTrack(mx, mz, nx, nz, context.ground.planner)) return true;
            if (openSurface(mx, mz)) return true;
            if (PARKING_GAP_SAMPLES_M.some((d) => openSurface(mx + nx * d, mz + nz * d))) return true;
            if (curbRaisedSideTouchesMask(
                mx,
                mz,
                nx,
                nz,
                (x, z) => pointInAnyMask(x, z, greenMasks),
                PARKING_GAP_SAMPLES_M,
            )) return true;
            return pointInAnyMask(mx, mz, noCurbMasks);
        },
    };
    for (const run of ringToRuns(points, parkingRingFilters)) {
        appendRunGeometry(
            run,
            curb,
            ramp,
            greenRamp,
            terrainSeam,
            greenMasks,
            roadbedMasks,
            { backProfile: 'vertical' },
        );
    }
    for (let index = 0; index < heightData.length; index++) {
        const positions = heightData[index].positions;
        if (positions.length <= starts[index]) continue;
        heightRanges.push({
            positions,
            start: starts[index],
            end: positions.length,
            osmIds: null,
            verticalOsmIds: null,
            drapeKind: heightData[index] === terrainSeam
                ? CURB_DRAPE_KIND.TERRAIN_SEAM
                : CURB_DRAPE_KIND.OWNER,
        });
    }
}

function terrainBuildItems(state) {
    if (!state?.ground?.terrain) return [];
    const items = [];
    for (const range of state.heightRanges) {
        const { positions, osmIds, verticalOsmIds, drapeKind } = range;
        const chunkFloats = TERRAIN_VERTICES_PER_CHUNK * 3;
        for (let start = range.start; start < range.end; start += chunkFloats) {
            items.push({
                positions,
                start,
                end: Math.min(range.end, start + chunkFloats),
                osmIds,
                verticalOsmIds,
                drapeKind,
                range,
            });
        }
    }
    return items;
}

const curbLandingSurfaceOffsetY = profile => roadSurfaceSceneOffset(profile?.highway);

function terrainYForBuild(state, x, z, osmIds, verticalOsmIds, drapeVertex = null) {
    const { terrain: terrainReference, roadFormation: roadFormationModel } = state.ground;
    const heightSource = curbDrapeHeightSource(
        drapeVertex?.drapeKind,
        drapeVertex?.localY,
    );
    // These arrays belong to this build's retained input. A union can contain
    // many road ids; joining the same array for every vertex copied hundreds
    // of megabytes during a single streamed curb replacement.
    let ownerIdsKey = '';
    if (Array.isArray(osmIds) && osmIds.length > 0) {
        const keys = state.terrainOwnerKeys ??= new WeakMap();
        ownerIdsKey = keys.get(osmIds);
        if (ownerIdsKey === undefined) {
            ownerIdsKey = osmIds.join(',');
            keys.set(osmIds, ownerIdsKey);
        }
    }
    const ownerKey = `${heightSource}|${ownerIdsKey}`;
    let byX = state.terrainYByOwner.get(ownerKey);
    if (!byX) {
        byX = new Map();
        state.terrainYByOwner.set(ownerKey, byX);
    }
    let byZ = byX.get(x);
    if (!byZ) {
        byZ = new Map();
        byX.set(x, byZ);
    } else if (byZ.has(z)) {
        return byZ.get(z);
    }
    let y = null;
    if (heightSource === 'raised-side') {
        // The landing is not part of the road-owned curb row. Sample the
        // already-rendered civil batter/collar, including its physical road
        // surface offset, and fall back to immutable terrain only outside it.
        // This lets the infill meet deep cut/fill slopes without becoming a
        // one-metre shelf at carriageway height.
        y = finiteOrNull(roadFormationModel?.civilGroundSceneYAtLocal?.(
            x,
            z,
            {
                surfaceOffsetYAtProfile: curbLandingSurfaceOffsetY,
                allowStale: true,
            },
        ));
        if (y === null) y = finiteOrNull(terrainReference?.evidenceSceneYAtLocal?.(x, z));
    } else {
        y = resolveCurbSceneYAtLocal({
            x,
            z,
            osmIds,
            verticalOsmIds,
            roadVerticalAlignments: state.verticalAlignmentModel,
            roadFormation: roadFormationModel,
            terrain: terrainReference,
            // Prep and terrain draping are separate cooperative jobs. Both use
            // this tile's captured road/terrain views; a live model must never
            // rebuild or change a height halfway through these ranges.
            allowStaleRoadFormation: true,
        });
    }
    byZ.set(z, y);
    return y;
}

function applyTerrainBuildItem(state, item) {
    return stepCurbTerrainDrape(item, terrainYForBuild, state);
}

// A quay kerb on a harbour mole fails its drape on every retry; terrain that
// has merely not streamed in yet must still reject the candidate. See
// core/terrain-evidence-gap.js for why the sea mask is the authority.
const curbGapIsPermanent = (state, x, z) => isPermanentTerrainGap(state?.ground, x, z);

// Same visit for the coordinated generation, which must not lose every other
// ground layer to one unsupported kerb vertex. See stepCurbTerrainDrapeSettled.
function settleTerrainBuildItem(state, item) {
    return stepCurbTerrainDrapeSettled(item, terrainYForBuild, state,
        { isPermanentGap: curbGapIsPermanent });
}

function describeTerrainBuildItem(item) {
    const start = typeof item?.start === 'number' && Number.isFinite(item.start)
        ? item.start
        : 0;
    const end = typeof item?.end === 'number' && Number.isFinite(item.end)
        ? item.end
        : start;
    const cursor = typeof item?.cursor === 'number' && Number.isFinite(item.cursor)
        ? item.cursor
        : start;
    return `terrain-drape ${Math.max(0, Math.floor((cursor - start) / 3))}`
        + `/${Math.max(0, Math.floor((end - start) / 3))}`;
}

function curbTilePublicationKey(tileKey) {
    return `curbs:tile:${String(tileKey)}`;
}

function disposeCurbTileRoot(root) {
    disposeGroup(root);
}

function annotateCurbTilePublication(root, tileKey, generation) {
    const replacementKey = curbTilePublicationKey(tileKey);
    root.traverse((object) => {
        if (!object?.isMesh) return;
        const materialClaim = object.material?.userData?.surfaceClaim;
        const claim = object.userData?.surfaceClaim
            || materialClaim
            || CURB_DRESSING_CLAIM;
        markSurfaceClaim(object, reviseSurfaceClaim(claim, {
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            replacementKey,
            generation,
        }));
    });
}

function commitCurbTileState(tileKey, root, collisionSurface) {
    if (root) tileGroups.set(tileKey, root);
    else tileGroups.delete(tileKey);
    if (collisionSurface) tileCollisionSurfaces.set(tileKey, collisionSurface);
    else tileCollisionSurfaces.delete(tileKey);
    curbCollisionRevision += 1;
}

// Build the publication entry before changing either render or support state.
// A dependency group may hold this entry and combine it with terrain/roads;
// acknowledgement is deliberately separate from the reversible commit.
function prepareCurbTilePublication(tileKey, root, collisionSurface, onCommit = null, isCurrent = null) {
    const generation = ++curbPublicationGeneration;
    const previous = tileGroups.get(tileKey) || null;
    const previousCollision = tileCollisionSurfaces.get(tileKey) || null;
    const parent = curbsGroup;
    let previousRevision = null, committed = false, finalized = false, discarded = false;
    if (root) {
        root.name = `CurbTile:${String(tileKey)}`;
        annotateCurbTilePublication(root, tileKey, generation);
    }
    const current = () => curbsGroup === parent && (!isCurrent || isCurrent())
        && (tileGroups.get(tileKey) || null) === previous
        && (tileCollisionSurfaces.get(tileKey) || null) === previousCollision;
    const ticket = surfacePublications?.begin({
        key: curbTilePublicationKey(tileKey), generation, parent,
        retire: (_context, retiringRoot) => disposeCurbTileRoot(retiringRoot),
    }) || null;
    const discard = () => {
        if (discarded || committed) return;
        discarded = true;
        if (ticket?.state === 'pending') ticket.discard();
        disposeCurbTileRoot(root);
    };
    const entry = {
        ticket, ...(root ? { root } : { clear: true }), isCurrent: () => !discarded && current(),
        commit() {
            previousRevision = curbCollisionRevision;
            commitCurbTileState(tileKey, root, collisionSurface);
            committed = true;
        },
        rollback() {
            if (previousRevision === null) return;
            if (previous) tileGroups.set(tileKey, previous);
            else tileGroups.delete(tileKey);
            if (previousCollision) tileCollisionSurfaces.set(tileKey, previousCollision);
            else tileCollisionSurfaces.delete(tileKey);
            curbCollisionRevision = previousRevision;
            committed = false;
        },
        discard,
    };
    return {
        tileKey, collisionSurface, entry, discard,
        finalize() {
            if (finalized || !committed || (ticket && !['published', 'cleared'].includes(ticket.state))) return false;
            finalized = true;
            onCommit?.();
            return true;
        },
        publish() {
            if (ticket) {
                const batch = surfacePublications.prepareBatch([entry]);
                if (!batch.publish) return false;
                batch.publish();
            } else {
                if (!current()) { disposeCurbTileRoot(root); return false; }
                if (root) parent.add(root);
                entry.commit();
                if (previous) disposeCurbTileRoot(previous);
            }
            return this.finalize();
        },
    };
}

function clearPublishedCurbTile(tileKey, onCommit = null) {
    return prepareCurbTilePublication(tileKey, null, null, onCommit).publish();
}

function* prepareTileBuildPublicationSteps(state, onCommit = null, isCurrent = () => true) {
    if (!curbsGroup || !state) return null;
    const receiverMaterial = material => state.ground?.openings ? plannerGeometryMaterials.get(material) : material;
    const output = yield* prepareCurbTileGeometrySteps(state, {
        materials: {
            curb: state.curb.positions.length ? receiverMaterial(getCurbMaterial()) : null,
            ramp: state.ramp.positions.length ? receiverMaterial(getRampMaterial()) : null,
            greenRamp: state.greenRamp.positions.length ? receiverMaterial(getGreenRampMaterial()) : null,
            terrainSeam: state.terrainSeam.positions.length ? receiverMaterial(getTerrainSeamMaterial()) : null,
        },
        uvPerM: { ramp: SIDEWALK_UV_PER_M, greenRamp: GRASS_UV_PER_M,
            terrainSeam: state.terrainSeam.positions.length ? getActiveTerrainSurface().uvPerM : 0 },
        claims: { terrainSeam: CURB_TERRAIN_SEAM_CLAIM },
        openingRead: state.ground?.openings || null,
        openingClaim: CURB_DRESSING_CLAIM,
        renderOrders: { curbRamp: SURFACE_RENDER_ORDER.CURB_RAMP,
            roadEarthwork: SURFACE_RENDER_ORDER.ROAD_EARTHWORK },
        buildManholeMesh, markSurfaceClaim, materialForGeometry: receiverMaterial, isCurrent: isCurrent || (() => true),
    });
    if (!output) return null;
    try {
        return prepareCurbTilePublication(state.tileKey, output.root, output.collisionSurface, onCommit, isCurrent);
    } catch (error) { disposeCurbTileRoot(output.root); throw error; }
}

function prepareTileBuildPublication(state, onCommit = null, isCurrent = null) {
    const steps = prepareTileBuildPublicationSteps(state, onCommit, isCurrent);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function finalizeTileBuild(state, onCommit = null, isCurrent = null) {
    return prepareTileBuildPublication(state, onCommit, isCurrent)?.publish() || false;
}

function disposeTileGroup(tileKey, reason = 'curb-tile-retired') {
    const existing = tileGroups.get(tileKey);
    tileGroups.delete(tileKey);
    if (tileCollisionSurfaces.delete(tileKey)) curbCollisionRevision += 1;
    if (!existing) return;
    if (surfacePublications?.retire?.(curbTilePublicationKey(tileKey), {
        root: existing,
        reason,
    })) return;
    disposeCurbTileRoot(existing);
}

function trackCurbGpuReadiness(value) {
    if (!value?.ready || curbGpuReadiness.has(value.ready)) return;
    curbGpuReadiness.add(value.ready);
    value.ready.then(() => curbGpuReadiness.delete(value.ready), () => curbGpuReadiness.delete(value.ready));
}

function* prewarmCurbTileSteps(root, isCurrent) {
    if (!root) return true;
    const gpu = prewarmDetachedObject(root, { renderer, camera, targetScene: scene,
        asyncShaders: true, label: 'curbs:tile-upload', uploadBatch: 8, maxUploadBytes: 256 * 1024, sliceMs: 2 });
    try {
        for (;;) {
            if (!isCurrent()) return false;
            while (lastCurbGpuFrame === getFrameChunkSequence()) {
                yield { phase: 'curb-upload-slot', deferFrame: true };
                if (!isCurrent()) return false;
            }
            const next = gpu.next();
            if (next.done) return true;
            if (next.value?.deferFrame) lastCurbGpuFrame = getFrameChunkSequence();
            trackCurbGpuReadiness(next.value);
            yield next.value;
        }
    } finally { gpu.return?.(); }
}

// A complete ground generation calls the same curb/manhole compiler as normal
// tile streaming. Its source masks are captured by identity and the resulting
// support table joins the coordinator's single physics reservation.
function* prepareCurbReceiverGenerationSteps({ tileKeys, ground, isCurrent, maxTiles }) {
    if (!Array.isArray(tileKeys) || !Number.isSafeInteger(maxTiles) || maxTiles <= 0
        || tileKeys.length > maxTiles || new Set(tileKeys).size !== tileKeys.length
        || !ground || !Object.isFrozen(ground) || typeof ground.isCurrent !== 'function'
        || ground.renderedRailSurface === undefined || typeof isCurrent !== 'function') {
        throw new TypeError('Curbs require a bounded captured ground generation and rail coverage');
    }
    if (!curbsGroup || !parkingIndexReady || curbPublicationLease) {
        throw Object.assign(new Error('Curb publication dependency is not ready'), { code: 'ground-dependency-busy' });
    }
    const lease = {}, thisSession = sessionId, parent = curbsGroup, revision = curbCollisionRevision;
    const parkingSource = parkingIndex, plannerGrid = plannerTrackVolumeGrid, plannerVolumes = plannerTrackCorridorVolumes;
    const tables = [tileFeatures, maskTileFeatures, tramTileFeatures, roadbedTileFeatures];
    const rows = tileKeys.map(tileKey => ({ tileKey, sources: tables.map(table => table.get(tileKey)),
        dependencyRevision: curbRebuildLedger.pendingRevision(tileKey) }));
    const current = () => curbPublicationLease === lease && sessionId === thisSession && curbsGroup === parent
        && curbCollisionRevision === revision && parkingIndex === parkingSource && parkingIndexReady
        && plannerTrackVolumeGrid === plannerGrid && plannerTrackCorridorVolumes === plannerVolumes
        && rows.every(row => tables.every((table, index) => table.get(row.tileKey) === row.sources[index])
            && curbRebuildLedger.pendingRevision(row.tileKey) === row.dependencyRevision)
        && isCurrent() && ground.isCurrent();
    const members = [];
    let heldGround = null, buildGround = null, prep = null, group = null, handedOff = false, settled = false;
    curbPublicationLease = lease;
    const release = () => {
        prep?.dispose(); prep = null;
        buildGround?.release(); buildGround = null;
        heldGround?.release?.(); heldGround = null;
        if (curbPublicationLease === lease) curbPublicationLease = null;
    };
    const discard = () => {
        if (settled) return false;
        settled = true;
        group?.discard();
        if (!group) for (const member of members) member.discard();
        release(); return true;
    };
    try {
        heldGround = retainReadSnapshot(ground, 'curb-ground-generation');
        buildGround = ownReadSnapshot({ ...heldGround,
            planner: Object.freeze({ grid: plannerGrid, volumes: plannerVolumes }),
            isCurrent: current, currentWithin: () => current }, [heldGround]);
        heldGround = null;
        for (const row of rows) {
            if (!current()) return null;
            if (row.sources[0]?.length && !row.sources[1]) {
                throw Object.assign(new Error('Curb source masks have not arrived'), { code: 'ground-dependency-busy' });
            }
            prep = createTilePrepTask(row.tileKey, buildGround);
            for (;;) {
                if (!current()) return null;
                const outcome = prep.step();
                if (outcome === 'stale') return null;
                if (outcome === 'done' || outcome === 'abort') break;
                yield { phase: `curb-generation:${prep.phase()}` };
            }
            const acknowledge = () => {
                if (sessionId !== thisSession) return;
                if (curbRebuildLedger.publish(row.tileKey, row.dependencyRevision)) noteInitialNearCurbTileReady(row.tileKey);
            };
            const state = prep.state();
            // A kerb run standing on ground the terrain model will never have
            // (a pier, a port apron) is omitted from this tile's geometry; the
            // rest of the tile publishes and acknowledges, so the world can
            // finish loading and keeps the terrain, paving, water and coast
            // collar that share the generation. The run stays in the retained
            // ranges for a later terrain revision. Evidence that is merely
            // late still throws below and is retried.
            const omitted = new Set();
            let firstGap = null;
            for (const range of state?.heightRanges || []) range.omitted = false;
            for (const item of state ? terrainBuildItems(state) : []) {
                if (item.range?.omitted) continue;
                let complete, evidenceGap;
                do {
                    if (!current()) return null;
                    ({ complete, evidenceGap } = settleTerrainBuildItem(state, item));
                    yield { phase: 'curb-generation:terrain-drape' };
                } while (!complete);
                if (evidenceGap && item.range) { item.range.omitted = true; omitted.add(item.range); firstGap ||= evidenceGap; }
            }
            if (omitted.size) {
                const osmIds = [...new Set([...omitted].flatMap(range => range.osmIds || []))].slice(0, 6);
                console.warn(`[${new Date().toISOString()}] [curbs] tile ${row.tileKey} published without`
                    + ` ${omitted.size} of ${state.heightRanges.length} kerb runs${osmIds.length ? ` (osm ${osmIds.join(', ')})` : ''}:`
                    + ` ${firstGap.message}`);
            }
            const member = state
                ? yield* prepareTileBuildPublicationSteps(withoutOmittedCurbRanges(state), acknowledge, current)
                : prepareCurbTilePublication(row.tileKey, null, null, acknowledge, current);
            if (!member || !current()) { member?.discard(); return null; }
            members.push(member);
            if (!(yield* prewarmCurbTileSteps(member.entry.root, current))) return null;
            prep.dispose(); prep = null;
        }
        group = yield* prepareCurbPublicationGroupSteps({ members, activeSurfaces: tileCollisionSurfaces,
            revision, getRevision: () => curbCollisionRevision, isCurrent: current,
            getPhysics: groundPhysicsProvider, preparePhysics: false,
            registry: surfacePublications, generation: ++curbPublicationGeneration });
        if (!group || !current()) return null;
        // A registry rollback must also release this generation's retained
        // inputs and publication lease, not just the individual curb roots.
        const entries = group.entries.map((entry, index) => index === group.entries.length - 1
            ? { ...entry, discard } : entry);
        handedOff = true;
        return { entries, curbSurfaceRead: group.read,
            isCurrent: () => current() && group.entries.every(entry => entry.isCurrent()), discard,
            finalize() {
                if (settled) return false;
                if (!group.finalize()) return false;
                settled = true; release(); return true;
            } };
    } finally { if (!handedOff) discard(); }
}

// A completed CPU tile is still private until its buffers, support query and
// disabled Rapier replacement are ready at the shared pre-controller boundary.
function* publishCurbBuildSteps(token) {
    const thisSession = sessionId, parent = curbsGroup;
    const current = () => !token.cancelled && sessionId === thisSession && curbsGroup === parent
        && token.isCurrent() && (token.eviction
            || curbRebuildLedger.pendingRevision(token.tileKey) === token.dependencyRevision);
    let member = null, group = null, batch = null, boundaryTicket = null, result = null, failure = null;
    let published = false;
    const lease = {};
    try {
        if (!current()) return false;
        const acknowledge = () => {
            if (token.eviction || sessionId !== thisSession) return;
            if (curbRebuildLedger.publish(token.tileKey, token.dependencyRevision)) noteInitialNearCurbTileReady(token.tileKey);
        };
        member = token.state
            ? yield* prepareTileBuildPublicationSteps(token.state, acknowledge, current)
            : prepareCurbTilePublication(token.tileKey, null, null, acknowledge, current);
        if (!member || !current()) return false;
        if (!(yield* prewarmCurbTileSteps(member.entry.root, current))) return false;
        while (curbPublicationLease) {
            yield { phase: 'curb-publication-slot', deferFrame: true };
            if (!current()) return false;
        }
        curbPublicationLease = lease;
        group = yield* prepareCurbPublicationGroupSteps({ members: [member], activeSurfaces: tileCollisionSurfaces,
            revision: curbCollisionRevision, getRevision: () => curbCollisionRevision, isCurrent: current,
            getPhysics: groundPhysicsProvider, registry: surfacePublications, generation: ++curbPublicationGeneration });
        if (!group || !current()) return false;
        batch = surfacePublications.prepareBatch(group.entries);
        if (batch.state !== 'staged') return false;
        while (!boundaryTicket) {
            boundaryTicket = groundPublications.enqueue(batch, { onPublished(value) {
                // Set this before callbacks: active resources must survive even
                // if acknowledgement reports an error after a successful swap.
                published = true; result = value; group.finalize();
            } });
            if (!boundaryTicket) {
                yield { phase: 'curb-boundary-slot', deferFrame: true };
                if (!current()) return false;
            }
        }
        boundaryTicket.promise.then(value => { result = value; }, error => { failure = error; });
        while (!result && !failure) {
            yield { phase: 'curb-boundary', deferFrame: true };
            if (!published && !current()) return false;
        }
        if (failure) throw failure;
        return published;
    } finally {
        if (!published) {
            boundaryTicket?.cancel('curb-build-superseded');
            if (batch?.state === 'staged') batch.discard('curb-build-superseded');
            group?.discard(); member?.discard();
        }
        if (curbPublicationLease === lease) curbPublicationLease = null;
    }
}

function startTileBuild(tileKey, generation, isCurrent) {
    let resolveBuild;
    let rejectBuild;
    const promise = new Promise((resolve, reject) => {
        resolveBuild = resolve;
        rejectBuild = reject;
    });
    promise.catch(() => {});
    const token = {
        tileKey,
        job: null,
        state: null,
        cancelled: false,
        settled: false,
        publicationSteps: null,
        isCurrent: () => (!isCurrent || isCurrent()) && prep.isCurrent(),
        dependencyRevision: curbRebuildLedger.pendingRevision(tileKey),
    };
    const settle = (error = null, cancelled = false) => {
        if (token.settled) return;
        token.settled = true;
        token.publicationSteps?.return();
        prep.dispose();
        if (error) rejectBuild(error);
        else resolveBuild({ cancelled });
    };
    const publish = () => {
        token.publicationSteps = publishCurbBuildSteps(token);
        token.job = buildQueue.enqueue([token], () => {
            const next = token.publicationSteps.next();
            if (next.done) { token.published = next.value === true; return undefined; }
            return next.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
        }, {
            describeItem: () => 'curb tile publication', priority,
            onComplete: () => settle(null, !token.published),
            onCancel: () => settle(null, true), onError: error => settle(error),
        });
    };
    const priority = () => {
        const [tileTx, tileTz] = String(tileKey).split('_').map(Number);
        if (tileDistanceSqToPoint(
            tileTx,
            tileTz,
            curbSupportFocusX,
            curbSupportFocusZ,
        ) === 0) return 1e12;
        return -tileDistanceSqToPoint(
            tileTx,
            tileTz,
            curbBuildFocusX,
            curbBuildFocusZ,
        );
    };
    // One stage per visit, so the scheduler can stop between any two rather
    // than being committed to a whole tile once it lets this item start.
    const prep = createTilePrepTask(tileKey);
    // describeItem is read BEFORE the stage runs, which is what we want: the
    // label names the stage whose cost is about to be measured.
    const stageAtStart = () => prep.phase();
    token.job = buildQueue.enqueue([tileKey], () => {
        const status = prep.step();
        if (status === 'more') return FRAME_CHUNK_REPEAT_ITEM;
        if (status === 'stale') token.cancelled = true;
        token.state = status === 'done' ? prep.state() : null;
        return undefined;
    }, {
        describeItem: stageAtStart,
        onComplete: () => {
            if (token.cancelled) { settle(null, true); return; }
            if (token.isCurrent && !token.isCurrent()) { settle(null, true); return; }
            if (!token.state) {
                publish();
                return;
            }
            const terrainItems = terrainBuildItems(token.state);
            if (terrainItems.length === 0) {
                publish();
                return;
            }
            token.job = buildQueue.enqueue(
                terrainItems,
                (item) => {
                    if (!applyTerrainBuildItem(token.state, item)) {
                        return FRAME_CHUNK_REPEAT_ITEM;
                    }
                    return undefined;
                },
                {
                    describeItem: describeTerrainBuildItem,
                    onComplete: () => {
                        publish();
                    },
                    onCancel: () => settle(null, true),
                    onError: (error) => settle(error),
                    priority,
                },
            );
        },
        onCancel: () => settle(null, true),
        onError: (error) => settle(error),
        priority,
    });
    return {
        promise,
        cancel: () => {
            if (token.cancelled) return;
            token.cancelled = true;
            if (token.job) buildQueue.cancel(token.job);
            settle(null, true);
        },
    };
}

function cancelCurbEviction(tileKey) {
    const eviction = curbEvictions.get(tileKey);
    if (!eviction) return;
    eviction.cancelled = true;
    if (eviction.job) buildQueue.cancel(eviction.job);
    eviction.steps?.return();
    curbEvictions.delete(tileKey);
}

function enqueueCurbEviction(tileKey) {
    cancelCurbEviction(tileKey);
    if (!tileGroups.has(tileKey) && !tileCollisionSurfaces.has(tileKey)) return;
    const thisSession = sessionId;
    const token = { tileKey, eviction: true, state: null, cancelled: false, failed: null,
        isCurrent: () => sessionId === thisSession && !tileFeatures.has(tileKey) };
    token.steps = publishCurbBuildSteps(token);
    const settle = error => {
        token.steps.return(); token.job = null;
        if (error) {
            token.failed = String(error?.message || error);
            console.error('[Station3D] Curb eviction failed; previous ground retained', error);
        } else if (curbEvictions.get(tileKey) === token) curbEvictions.delete(tileKey);
    };
    curbEvictions.set(tileKey, token);
    token.job = buildQueue.enqueue([token], () => {
        const next = token.steps.next();
        if (next.done) token.published = next.value === true;
        return next.done ? undefined : next.value?.deferFrame ? FRAME_CHUNK_DEFER_ITEM : FRAME_CHUNK_REPEAT_ITEM;
    }, { describeItem: () => 'curb tile eviction', onComplete: () => {
        if (token.published) settle();
        else { token.steps.return(); token.job = null; }
    },
        onCancel: () => settle(), onError: settle });
}

function retryCurbEviction() {
    const next = curbEvictions.entries().next();
    if (next.done) return;
    const [key, token] = next.value;
    curbEvictions.delete(key); curbEvictions.set(key, token);
    if (!token.job && !token.failed && !tileFeatures.has(key)) enqueueCurbEviction(key);
}

function cancelTileBuildJob(tileKey) {
    tileBuildController?.cancel(tileKey);
}

function enqueueTileBuild(tileKey) {
    if (!tileBuildController) return Promise.resolve({ cancelled: true });
    // Initial/source-triggered builds can also lose their captured inputs.
    // Keep their obligation until publication, just like a terrain rebuild.
    // A distinct request revision prevents an older coalesced completion from
    // releasing the newer request and causing repeated follow-ups every frame.
    curbRebuildLedger.mark(tileKey, ++curbDependencyRevision);
    const revision = curbRebuildLedger.requested(tileKey);
    const thisSession = sessionId;
    const promise = tileBuildController.request(tileKey);
    // Keep the original rejection for the stream owner. Failed obligations
    // remain inspectable, but cannot become an every-frame retry loop.
    promise.then(
        () => { if (thisSession === sessionId) curbRebuildLedger.settled(tileKey, revision); },
        () => { if (thisSession === sessionId) curbRebuildLedger.settled(tileKey, revision, { failed: true }); },
    );
    return promise;
}

function enqueueTileBuildIfReady(tileKey) {
    if (groundManaged) {
        groundCoordinator.invalidate('curbs', { keys: [String(tileKey)] });
        return;
    }
    if (!parkingIndexReady
        || !tileFeatures.has(tileKey)
        || !maskTileFeatures.has(tileKey)) {
        return undefined;
    }
    if (!roadSurfaceTiles.isReady(tileKey)) {
        waitForRoadSurfaceTile(tileKey);
        return undefined;
    }
    clearRoadSurfaceWaiter(tileKey);
    if (!curbTileDependenciesReady(tileKey)) return undefined;
    return enqueueTileBuild(tileKey);
}

function tileIntersectsFormationChanges(tileKey, changes) {
    if (!changes || changes.full) return true;
    const tileBounds = tileLocalBounds(tileKey);
    if (!tileBounds) return false;
    return changes.bounds.some(bounds => (
        boundsIntersectWithPadding(tileBounds, bounds, FORMATION_DIRTY_PADDING_M)
    ));
}

function enqueueCurbDependencyTileScan(label, changes, includeTile = () => true) {
    // Every delta is an obligation: callers have already advanced their
    // observed revision. A newer, disjoint delta must not cancel the remaining
    // tiles from this one, or their visual AND collision surfaces stay stale.
    // Each scan is short per visit; tile builds themselves already coalesce.
    const tileKeys = [...tileFeatures.keys()];
    if (tileKeys.length === 0) return null;
    const revision = ++curbDependencyRevision;
    const thisSession = sessionId;
    curbDependencyScans.set(revision, { changes, failed: false });
    const job = buildQueue.enqueue(tileKeys, (tileKey) => {
        if (tileFeatures.has(tileKey) && includeTile(tileKey)
            && tileIntersectsFormationChanges(tileKey, changes)) {
            curbRebuildLedger.mark(tileKey, revision);
            if (curbRebuildLedger.shouldRequest(tileKey)) enqueueTileBuildIfReady(tileKey);
        }
    }, {
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 2,
        priority: Number.MAX_SAFE_INTEGER - 2,
        describeItem: tileKey => `${label} tile ${tileKey}`,
        onComplete: () => { if (thisSession === sessionId) curbDependencyScans.delete(revision); },
    });
    job.promise.catch(error => {
        const scan = thisSession === sessionId ? curbDependencyScans.get(revision) : null;
        if (scan) scan.failed = true;
        console.error(`[curbs] ${label} dependency scan failed`, error);
    });
    return job;
}

function retryCurbDependencyTiles() {
    const tileKey = curbRebuildLedger.nextTile();
    if (tileKey === null) return;
    if (!tileFeatures.has(tileKey)) { curbRebuildLedger.forget(tileKey); return; }
    if (curbRebuildLedger.shouldRequest(tileKey)) enqueueTileBuildIfReady(tileKey);
}

function onTerrainReferenceChanged(_revision, change) {
    if (groundManaged) return;
    // No geometry work or world-wide tile loop inside replaceGrid's listener.
    enqueueCurbDependencyTileScan('terrain', surfaceChangesFromTerrainEvent(change));
}

function rebuildFormationChangedTiles() {
    if (!roadFormationModel || roadFormationModel.revision === roadFormationRevision) return;
    const changes = typeof roadFormationModel.getChangesSince === 'function'
        ? roadFormationModel.getChangesSince(roadFormationRevision)
        : { revision: roadFormationModel.revision, full: true, bounds: [] };
    roadFormationRevision = changes.revision;
    enqueueCurbDependencyTileScan('road-formation', changes);
}

function rebuildRailFormationChangedTiles() {
    const nextModel = typeof railFormationProvider === 'function'
        ? railFormationProvider()
        : railFormationModel;
    const nextSnapshot = nextModel
        ? peekRailCivilGroundDependencySnapshot(
            nextModel,
            FORMATION_DIRTY_PADDING_M,
        )
        : railCivilGroundDependencySnapshot(null, FORMATION_DIRTY_PADDING_M);
    // Rails publishes its complete fingerprint only after the bounded builder
    // finishes. Keep the previous curb ownership generation until then instead
    // of recomputing the same cache miss monolithically in this frame hook.
    if (!nextSnapshot) return;
    const nextSignature = nextSnapshot.signature;
    if (nextModel === railFormationModel
        && nextSignature === railCivilGroundSignature) return;
    const changedBounds = changedCivilGroundDependencyBounds(
        railCivilGroundDependencies,
        nextSnapshot.entries,
    );
    railFormationModel = nextModel || null;
    railCivilGroundDependencies = nextSnapshot.entries;
    railCivilGroundSignature = nextSignature;
    if (changedBounds.length === 0) return;
    enqueueCurbDependencyTileScan('rail-formation', {
        full: false,
        bounds: changedBounds,
    });
}

function rebuildRenderedRailSurfaceChangedTiles(nowMs = performance.now()) {
    const nextRevision = Number(terrainReference?.renderedRailSurface?.revision) || 0;
    if (nextRevision !== renderedRailSurfaceObservedRevision) {
        renderedRailSurfaceObservedRevision = nextRevision;
        renderedRailSurfaceChangedAtMs = nowMs;
        renderedRailSurfaceRefreshPending = true;
        return;
    }
    if (!renderedRailSurfaceRefreshPending
        || nowMs - renderedRailSurfaceChangedAtMs < RENDERED_RAIL_SURFACE_QUIET_MS) {
        return;
    }
    renderedRailSurfaceRefreshPending = false;
    enqueueCurbDependencyTileScan(
        'rendered-rail-surface',
        { full: true, bounds: [] },
        tileKey => (tramTileFeatures.get(tileKey) || []).length > 0,
    );
}

function rebuildVerticalAlignmentChangedTiles() {
    if (!roadVerticalAlignmentModel
        || roadVerticalAlignmentModel.revision === roadVerticalAlignmentRevision) {
        return;
    }
    const changes = typeof roadVerticalAlignmentModel.getChangesSince === 'function'
        ? roadVerticalAlignmentModel.getChangesSince(roadVerticalAlignmentRevision)
        : {
            revision: roadVerticalAlignmentModel.revision,
            full: true,
            bounds: [],
        };
    roadVerticalAlignmentRevision = changes.revision;
    enqueueCurbDependencyTileScan('vertical-alignment', changes);
}

export function getCurbCollisionRevision() {
    return curbCollisionRevision;
}

export function getCurbCollisionSurfacesNear(x, z, radiusM = 120) {
    return curbCollisionSurfacesNear(tileCollisionSurfaces, x, z, radiusM);
}

export function getCurbsGroupForWalkSupport() {
    return curbsGroup;
}

export function getCurbAuditReadiness(bounds) {
    const intersects = tileKey => {
        const tile = tileLocalBounds(tileKey);
        return tile && boundsIntersectWithPadding(tile, bounds, 0);
    };
    const builds = (tileBuildController?.snapshot() || []).filter(entry => intersects(entry.tileKey));
    const dirty = curbRebuildLedger.entries().filter(entry => intersects(entry.tileKey));
    const scans = [...curbDependencyScans.values()].filter(({ changes }) => changes.full
        || changes.bounds.some(change => boundsIntersectWithPadding(change, bounds, FORMATION_DIRTY_PADDING_M)));
    const evictions = [...curbEvictions.values()].filter(entry => intersects(entry.tileKey))
        .map(entry => ({ tileKey: entry.tileKey, failed: entry.failed }));
    return { pending: builds.length + dirty.length + scans.length + evictions.length,
        failed: dirty.filter(entry => entry.failed !== null).length + scans.filter(scan => scan.failed).length
            + evictions.filter(entry => entry.failed).length,
        builds, dirty, scans: scans.length, evictions };
}

export const curbsLayer = {
    groundReady: () => !!curbsGroup && parkingIndexReady && !curbPublicationLease
        && !tileBuildController?.snapshot().length && !curbEvictions.size && !curbDependencyScans.size,
    manageGroundPublications(coordinator) {
        groundCoordinator = coordinator; groundManaged = true;
        // Initial readiness transfers with publication ownership to the
        // shared initial-view gate; old per-tile callbacks will not publish.
        initialNearCurbTileKeys.clear();
        noteWorldQueueIdle('curbs');
    },
    groundSourceDependencies({ maxTiles }) {
        const keys = [];
        for (const [key, features] of tileFeatures) if (features.length) {
            if (keys.length >= maxTiles) throw Object.assign(new RangeError('Curb source dependency capacity exceeded'),
                { code: 'ground-generation-capacity' });
            keys.push(key);
        }
        return [{ sourceKey: 'roads:cab', tileKeys: keys,
            isReady: () => keys.every(key => maskTileFeatures.has(key)) }];
    },
    *groundTileKeysSteps({ bounds = [], keys = [], full = false, maxTiles }) {
        const requested = new Set(keys), result = new Set();
        for (const table of [tileFeatures, tileGroups]) for (const key of table.keys()) {
            if (result.has(key)) continue;
            if (full || requested.has(key) || tileIntersectsFormationChanges(key, { full: false, bounds })) result.add(key);
            if (result.size > maxTiles) throw Object.assign(new Error('Curb dependency closure exceeds capacity'), { code: 'ground-generation-capacity' });
            yield { phase: 'curb-dependency-closure' };
        }
        return [...result];
    },
    prepareGroundGenerationSteps: prepareCurbReceiverGenerationSteps,
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        fetchController,
        sharedTileSession,
        customTrackCorridors,
        otherTracks,
        allStops,
        terrain,
        roadFormation,
        railFormation,
        getRailFormation,
        roadVerticalAlignments,
        captureSurfaceBuildGround: captureGround,
        roadSurfaceTiles: surfaceTiles,
        surfacePublications: publicationRegistry,
        groundPublications: publicationBoundary,
        getGroundPhysics,
    }) {
        groundManaged = false; groundCoordinator = null;
        sessionId += 1;
        const thisSession = sessionId;
        anchorLat = lat;
        anchorLon = lon;
        surfacePublications = publicationRegistry || null;
        groundPublications = publicationBoundary || null;
        groundPhysicsProvider = getGroundPhysics || null;
        if (!surfacePublications || !groundPublications) throw new TypeError('Curbs require the shared ground publication boundary');
        terrainReference = terrain || null;
        if (typeof captureGround !== 'function') throw new TypeError('Curbs require the shared surface-build ground capture');
        captureSurfaceBuildGround = captureGround;
        terrainChangeSubscription?.();
        terrainChangeSubscription = terrainReference?.onChange?.(onTerrainReferenceChanged) || null;
        curbRebuildLedger.clear();
        curbDependencyScans.clear();
        curbDependencyRevision = 0;
        roadFormationModel = roadFormation || null;
        railFormationModel = railFormation || null;
        railFormationProvider = typeof getRailFormation === 'function'
            ? getRailFormation
            : (() => railFormationModel);
        const initialRailSnapshot = railFormationModel
            ? peekRailCivilGroundDependencySnapshot(
                railFormationModel,
                FORMATION_DIRTY_PADDING_M,
            ) || railCivilGroundDependencySnapshot(null, FORMATION_DIRTY_PADDING_M)
            : railCivilGroundDependencySnapshot(null, FORMATION_DIRTY_PADDING_M);
        railCivilGroundDependencies = initialRailSnapshot.entries;
        railCivilGroundSignature = initialRailSnapshot.signature;
        railCutEdgeEvaluatorKey = null;
        railCutEdgeEvaluator = () => false;
        renderedRailSurfaceObservedRevision = Number(
            terrainReference?.renderedRailSurface?.revision,
        ) || 0;
        renderedRailSurfaceChangedAtMs = performance.now();
        renderedRailSurfaceRefreshPending = false;
        roadVerticalAlignmentModel = roadVerticalAlignments || null;
        roadSurfaceTiles = surfaceTiles;
        roadSurfaceWaiters = new Map();
        roadFormationRevision = roadFormationModel ? roadFormationModel.revision : -1;
        roadVerticalAlignmentRevision = roadVerticalAlignmentModel
            ? roadVerticalAlignmentModel.revision
            : -1;
        tileFeatures = new Map();
        tileGroups = new Map();
        tileCollisionSurfaces = new Map();
        curbCollisionRevision += 1;
        tileBuildController?.clear();
        tileBuildController = createTileBuildGenerationController({
            startBuild: startTileBuild,
        });
        curbBuildFocusX = 0;
        curbBuildFocusZ = 0;
        curbSupportFocusX = 0;
        curbSupportFocusZ = 0;
        maskTileFeatures = new Map();
        maskCache = new Map();
        tramTileFeatures = new Map();
        tramCache = new Map();
        roadbedTileFeatures = new Map();
        roadbedCache = new Map();
        parkingIndex = null;
        parkingIndexReady = false;
        parkingCache = new Map();
        greenCache = new Map();
        beginInitialNearCurbGate();
        setPlannerTrackCorridorVolumes(buildTrackCorridorVolumes(
            customTrackCorridors || [],
            lat,
            lon,
            {
                halfWidthPadding: 0.25,
                elevatedRightExtension: 0,
                endPad: 0.75,
            },
        ).concat(buildPlannerStationClearanceVolumes(
            allStops,
            otherTracks,
            anchorLat,
            anchorLon,
        )));

        curbsGroup = new THREE.Group();
        curbsGroup.name = 'Curbs';
        markInspectionLayer(curbsGroup, {
            id: 'curbs',
            label: 'Curbs and sidewalk ramps',
            category: 'Transport',
            source: 'world/curbs.js · /roads/curbs profiles',
            order: 120,
        });
        scene.add(curbsGroup);
        startCurbMaterialPrewarm();

        getDecorParkingIndex(
            anchorLat,
            anchorLon,
            fetchController?.signal,
            sharedTileSession,
        )
            .then((index) => {
                if (sessionId !== thisSession) return;
                parkingIndex = index;
                parkingIndexReady = true;
                parkingCache.clear();
                greenCache.clear();
                for (const tileKey of tileFeatures.keys()) enqueueTileBuildIfReady(tileKey);
            })
            .catch((err) => {
                if (sessionId !== thisSession) return;
                parkingIndexReady = true;
                console.warn('[Station3D] curbs could not load parking surfaces', err);
                // A failed optional decor request must not strand the world
                // loader; publish the final shape available from road data.
                for (const tileKey of tileFeatures.keys()) enqueueTileBuildIfReady(tileKey);
            });

        tileSource = sharedTileSession.getSource({
            key: 'roads:curbs',
            label: 'curbs',
            url: (bb) => `${getApiBase()}/roads/curbs?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        tileSubscription = tileSource.subscribe({
            onFetch: (features, tileKey) => {
                cancelCurbEviction(tileKey);
                tileFeatures.set(tileKey, Array.isArray(features) ? features : []);
                return enqueueTileBuildIfReady(tileKey);
            },
            onEvict: (tileKey) => {
                if (groundManaged) {
                    tileFeatures.delete(tileKey);
                    groundCoordinator.invalidate('curbs', { keys: [String(tileKey)], reason: 'source-evicted' });
                    return;
                }
                cancelTileBuildJob(tileKey);
                curbRebuildLedger.forget(tileKey);
                clearRoadSurfaceWaiter(tileKey);
                tileFeatures.delete(tileKey);
                enqueueCurbEviction(tileKey);
            },
        });
        // Piggyback on the roads layer's tile source (same key → one fetch)
        // for tagged crossing mouths and pedestrian precincts that open curbs.
        maskTileSource = sharedTileSession.getSource({
            key: 'roads:cab',
            label: 'roads',
            url: (bb) => `${getApiBase()}/roads/cab?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        maskTileSubscription = maskTileSource.subscribe({
            onFetch: (features, tileKey) => {
                const list = Array.isArray(features) ? features : [];
                maskTileFeatures.set(tileKey, list.filter(f => (
                    curbOpeningMaskReason(f) !== null
                )));
                // Broad OSM tram buffers are not physical roadbed. Their
                // raised server-union curb is suppressed; rails.js supplies a
                // narrow flush curb at the real paver-bed boundary instead.
                tramTileFeatures.set(tileKey, list.filter((f) => {
                    const props = f && f.properties;
                    return props && props.railway_type === 'tram';
                }));
                // Actual highway surfaces keep parking-ring mouths open.
                roadbedTileFeatures.set(tileKey, list.filter((f) => {
                    const props = f && f.properties;
                    if (!props) return false;
                    return props.highway_type
                        && !NON_ROADBED_HIGHWAY_TYPES.has(props.highway_type);
                }));
                maskCache.delete(tileKey);
                tramCache.delete(tileKey);
                roadbedCache.delete(tileKey);
                return enqueueTileBuildIfReady(tileKey);
            },
            onEvict: (tileKey) => {
                clearRoadSurfaceWaiter(tileKey);
                maskTileFeatures.delete(tileKey);
                tramTileFeatures.delete(tileKey);
                roadbedTileFeatures.delete(tileKey);
                maskCache.delete(tileKey);
                tramCache.delete(tileKey);
                roadbedCache.delete(tileKey);
                if (groundManaged) groundCoordinator.invalidate('curbs', {
                    keys: [String(tileKey)], reason: 'mask-source-evicted' });
            },
        });
        tileSource.ensureAround(0, 0);
        maskTileSource.ensureAround(0, 0);
    },
    onFrame(pose, local) {
        const streamingFocus = pose?.surfaceStreamingFocus || local;
        curbSupportFocusX = Number.isFinite(local?.x) ? local.x : 0;
        curbSupportFocusZ = Number.isFinite(local?.z) ? local.z : 0;
        curbBuildFocusX = Number.isFinite(streamingFocus?.x)
            ? streamingFocus.x
            : curbSupportFocusX;
        curbBuildFocusZ = Number.isFinite(streamingFocus?.z)
            ? streamingFocus.z
            : curbSupportFocusZ;
        if (!groundManaged) {
            rebuildVerticalAlignmentChangedTiles(); rebuildRailFormationChangedTiles(); rebuildFormationChangedTiles();
            rebuildRenderedRailSurfaceChangedTiles(); retryCurbDependencyTiles(); retryCurbEviction();
        }
        const headingDeg = finiteOrNull(streamingFocus?.headingDeg)
            ?? pose?.headingDeg;
        if (tileSource) {
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
            tileSource.ensureAhead(curbBuildFocusX, curbBuildFocusZ, headingDeg, {
                ...CURB_AHEAD,
            });
        }
        if (maskTileSource) {
            maskTileSource.ensureAround(local.x, local.z);
        }
    },
    endSession() {
        groundManaged = false; groundCoordinator = null;
        sessionId += 1;
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        if (maskTileSubscription) maskTileSubscription();
        maskTileSubscription = null;
        maskTileSource = null;
        buildQueue.clear();
        for (const tileKey of curbEvictions.keys()) cancelCurbEviction(tileKey);
        if (curbMaterialPrewarmState) {
            settleCurbMaterialPrewarm(curbMaterialPrewarmState);
        }
        tileBuildController?.clear();
        tileBuildController = null;
        for (const tileKey of [...roadSurfaceWaiters.keys()]) {
            clearRoadSurfaceWaiter(tileKey);
        }
        roadSurfaceWaiters.clear();
        roadSurfaceTiles = null;
        tileFeatures.clear();
        maskTileFeatures.clear();
        maskCache.clear();
        tramTileFeatures.clear();
        tramCache.clear();
        roadbedTileFeatures.clear();
        roadbedCache.clear();
        parkingIndex = null;
        parkingIndexReady = false;
        parkingCache.clear();
        greenCache.clear();
        initialNearCurbTileKeys.clear();
        setPlannerTrackCorridorVolumes([]);
        roadFormationRevision = -1;
        roadFormationModel = null;
        railFormationModel = null;
        railFormationProvider = null;
        railCivilGroundDependencies = [];
        railCivilGroundSignature = '';
        railCutEdgeEvaluatorKey = null;
        railCutEdgeEvaluator = () => false;
        renderedRailSurfaceObservedRevision = -1;
        renderedRailSurfaceChangedAtMs = 0;
        renderedRailSurfaceRefreshPending = false;
        roadVerticalAlignmentRevision = -1;
        roadVerticalAlignmentModel = null;
        terrainReference = null;
        captureSurfaceBuildGround = null;
        terrainChangeSubscription?.();
        terrainChangeSubscription = null;
        curbRebuildLedger.clear();
        curbDependencyScans.clear();
        curbDependencyRevision = 0;
        for (const tileKey of [...tileGroups.keys()]) {
            disposeTileGroup(tileKey, 'curbs-layer-ended');
        }
        tileGroups.clear();
        tileCollisionSurfaces.clear();
        curbCollisionRevision += 1;
        if (curbsGroup) {
            disposeGroup(curbsGroup);
            curbsGroup = null;
        }
        // compileAsync can still be polling a shared program after its tile
        // was cancelled. Release the ending session's materials after that
        // fence, even if another session has already created new materials.
        const resources = [curbMaterial, rampMaterial, greenRampMaterial, terrainSeamMaterial, curbTexture,
            ...plannerGeometryMaterials.take()].filter(Boolean);
        curbMaterial = rampMaterial = greenRampMaterial = terrainSeamMaterial = curbTexture = null;
        const disposeResources = () => { for (const resource of resources) { unregisterShared(resource); resource.dispose(); } };
        if (curbGpuReadiness.size) Promise.allSettled([...curbGpuReadiness]).then(disposeResources);
        else disposeResources();
        surfacePublications = null;
        groundPublications = null;
        groundPhysicsProvider = null;
    },
};
