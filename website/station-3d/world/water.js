// Sea layer: mapped vector water is the sole shoreline authority. Fetches
// Overture water polygons through GET /api/water, punches the exact same mask
// into terrain and the inverse mask into one recessed sea plane, then builds
// quay walls on that vector boundary. The DGU DTM supplies elevation only:
// its coarse NoData edge must never redraw the coast. Roads, quays and piers
// remain explicit geometry above the water rather than modifying this mask.
// The query is spatial and cheap when empty, so every model-world session runs
// it; a URL flag must never decide whether mapped sea exists.

import { navigationMapContext } from '../core/navigation-map-context.js';
import * as THREE from 'three';
import {
    DEG_TO_RAD,
    EARTH_RADIUS_M,
    finiteOrNull,
    haversineMeters,
} from '../core/math.js';
import { vehicleSurfaceStreamingGeoTarget } from '../core/vehicle-surface-streaming.js';
import {
    applyGroundWaterMask,
    camera,
    renderer,
    scene,
    setGroundHoleMask,
    clearGroundHoleMask,
} from '../scene/setup.js';
import { getApiBase } from '../core/api.js';
import { disposeGroup, registerShared } from '../core/dispose.js';
import {
    createFrameChunkQueue,
    frameChunkObserverIsMoving,
    FRAME_CHUNK_DEFER_ITEM,
    FRAME_CHUNK_REPEAT_ITEM,
} from '../core/frame-chunk-queue.js';
import { createCoastDressingBuildTask } from '../core/coast-dressing-build-task.js';
import {
    buildUrbanCoastGeometryData,
    createUrbanCoastLandingSampler,
    resolveUrbanCoastSection,
    splitLongCoastQuads,
    URBAN_COAST_SEARCH_M,
} from '../core/urban-coast-formation.js';
import { prewarmDetachedObject } from '../core/detached-gpu-prewarm.js';
import { compileMappedWaterSurfaceSteps, captureMappedWaterOpeningsSteps, sameMappedWaterGeometrySteps } from '../core/mapped-water-ground.js';
import { captureReceiverMeshReadSteps } from '../core/receiver-mesh-read.js';
import { EMPTY_RECEIVER_SUPPORT_READ } from '../core/receiver-support-read.js';
import { clipReceiverMeshOpeningsSteps } from '../core/receiver-mesh-openings.js';
import { GROUND_GENERATION_LIMITS } from '../core/ground-generation-limits.js';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';
import { createWaterMaterial, applyWorldXZWaterUvs, animateWaterMaterials } from './water-material.js';
import { applyPlannerSurfaceCutout } from './planner-surface-cutout.js';
import { WATER_LEVELS } from './ground-surface-levels.js';
import { applyGroundOwnership } from './terrain.js';
import { applySurfaceStencil } from './surface-material-authority.js';
import { applyStreetLampSurfaceLighting } from './streetlamp-lighting.js';
import {
    buildMappedCoastLandCollar,
    buildMappedCoastLandCollarSteps,
    clipMappedCoastQuadToWindow,
    buildMappedCoastTerrainCutout,
    createMappedCoastTerrainSurfaceSampler,
    createMappedCoastline,
    resolveMappedCoastTerrainInfill,
    resolveMappedCoastTerrainInfillSteps,
    selectMappedSeaFeatures,
} from '../core/coastline-mask.js';
import { getActiveTerrainSurface } from './terrain-surface.js';
import { applyUrbanGroundSurface } from './urban-ground-surface.js';
import {
    getRenderedRoadSurfaceRevision,
    pedestrianZoneAtLocal,
    renderedRoadSurfaceSupportYAtLocal,
} from './roads.js';
import { markInspectionLayer } from '../core/scene-inspection.js';
import { markSurfaceClaim } from '../core/surface-claim.js';
import {
    SURFACE_CLASS,
    SURFACE_COVERAGE_STATE,
    SURFACE_VERTICAL_RELATION,
    compileSurfaceClaim,
} from '../core/surface-hierarchy.js';

const SEA_Y = WATER_LEVELS.sea; // water surface below the y=0 ground
const WALL_TOP_Y = 0.02;
const WALL_BOTTOM_Y = -2.4;    // quay walls run past the surface so waves never expose their lower edge
const FETCH_RADIUS_M = 1500;   // fog fully hides ~1200 m; fetch slightly beyond
const REFRESH_MOVE_M = 600;    // rebuild when the pose strays this far from the last fetch center
const MASK_HALF_SIZE_M = 1600; // world extent of the ground hole mask around the fetch center
const MASK_SIZE_PX = 2048;     // ≈ 1.6 m/px; its edge is buried beneath the exact vector collar
const SEA_PLANE_SIZE_M = 2 * MASK_HALF_SIZE_M + 800; // must cover every hole the mask can punch
const COAST_MIN_COLLAR_M = 2.0; // ordinary coast gets 4.5 m; narrow landforms may shrink this far
const COAST_WATER_MASK_OVERDRAW_M = 0.75; // water overlaps beneath the exact shoreline surface
const COAST_LAND_COLLAR_M = 4.5;    // narrows only where another water edge bounds a thin landform
const COAST_TERRAIN_INNER_OVERLAP_M = 0.75; // DGU and replacement remain opaque at the inner seam
const COAST_SURFACE_LIFT_M = 0.012;
const COAST_TERRAIN_MAX_REACH_M = 128; // bounded bridge from permanent coastal DTM NoData to land
// OSM-derived Overture water carries metre-scale digitising wiggles along
// otherwise straight quay walls. Remove only sub-2 m render noise: this is
// approximately one mask texel and preserves real piers, corners and inlets.
const COASTLINE_SIMPLIFY_M = 2.0;
const URBAN_COAST_RADIUS_M = 280;
const URBAN_COAST_REFRESH_MOVE_M = 120;
const URBAN_COAST_ROAD_SETTLE_MS = 700;
const coastDressingQueue = createFrameChunkQueue({
    label: 'water-dressing',
    frameBudgetMs: 2,
    preferAnimationFrame: true,
    pauseDuringMovement: false,
    workClass: 'delivery',
    trackWorldReady: false,
});

let sessionToken = 0;
let waterGroundContext = null;
let waterGroundCoordinator = null;
let waterGroundSource = null;
let activeWaterGround = null;
let activeUrbanGround = null;
let activeCoastGround = null;
let waterWorldGroup = null;
let requestedUrbanGroundCenter = null;
let group = null;
let surfacePublications = null;
let waterPublicationGeneration = 0;
let activeWaterPublicationTicket = null;
let waterMaterials = [];
let anchorLat = null;
let anchorLon = null;
let fetchController = null;
let networkRequestScheduler = null;
let lastLat = null;            // center of the last completed refresh
let lastLon = null;
let refreshing = false;
let terrainReference = null;
let terrainUnsubscribe = null;
let pendingCoastDressing = null;
let activeCoastDressing = null;
let coastDressingGroup = null;
let coastDressingDirty = false;
let coastDressingRevision = 0;
let coastDressingBuild = null;
let groundMaskTexture = null;
let activeSeaClaim = null;
let civilGroundReference = null;
let releaseCoastTerrainReplacement = null;
let coastTerrainReplacementRevision = 0;
let urbanCoastGroup = null;
let urbanCoastBuild = null;
let urbanCoastSceneYAtLocal = null;
let urbanCoastGeneration = 0;
let urbanCoastCenterX = null;
let urbanCoastCenterZ = null;
let observedUrbanRoadRevision = null;
let appliedUrbanRoadRevision = null;
let urbanRoadRevisionChangedAtMs = 0;
let urbanCoastRefreshRequested = false;
// The same canonical coastline that owns Split's visible land/sea seam also
// answers walk-contact queries. Keeping the classifier here prevents audio
// from inventing a second, drifting notion of where the sea begins.
let activeCoastline = null;
let mappedSeaReady = false;
let mappedSeaSurfaceY = SEA_Y;
let publishedSeaPlane = null;
const mappedSeaListeners = new Set();
const urbanCoastListeners = new Set();

function resolveMappedSeaSurfaceY(terrain) {
    const sceneY = terrain?.absoluteToSceneY?.(0);
    return Number.isFinite(sceneY) ? sceneY - 0.05 : SEA_Y;
}

function notifyMappedSeaListeners({ groundPublished = false } = {}) {
    for (const listener of mappedSeaListeners) {
        try {
            listener(activeCoastline, { groundPublished });
        } catch (error) {
            console.warn('[water] mapped-sea listener failed', error);
        }
    }
}

function setActiveCoastline(coastline) {
    activeCoastline = coastline || null;
    navigationMapContext.setWater(activeCoastline);
    mappedSeaReady = true;
    notifyMappedSeaListeners();
}

function resetActiveCoastline() {
    activeCoastline = null;
    navigationMapContext.setWater(null);
    mappedSeaReady = false;
}

function clearCoastTerrainReplacement() {
    releaseCoastTerrainReplacement?.();
    releaseCoastTerrainReplacement = null;
}

function publishCoastTerrainReplacement(dressing, { notify = false } = {}) {
    const sampler = dressing?.userData?.coastTerrainSceneYAtLocal;
    const bounds = sampler?.bounds;
    clearCoastTerrainReplacement();
    if (typeof sampler === 'function'
        && bounds
        && [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite)) {
        const revision = ++coastTerrainReplacementRevision;
        const dependencySnapshot = {
            entries: [{
                signature: `generation-${revision}`,
                bounds: { ...bounds },
            }],
        };
        releaseCoastTerrainReplacement = civilGroundReference?.setTerrainReplacement?.({
            id: 'mapped-coast-terrain-infill',
            sampleSceneYAtLocal: sampler,
            sampleEvidenceSceneYAtLocal: sampler,
            dependencySnapshot: () => dependencySnapshot,
        }) || null;
    }
    if (notify) notifyMappedSeaListeners();
}

export function subscribeMappedSeaChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    mappedSeaListeners.add(listener);
    return () => mappedSeaListeners.delete(listener);
}

export function subscribeUrbanCoastFormationChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    urbanCoastListeners.add(listener);
    return () => urbanCoastListeners.delete(listener);
}

function notifyUrbanCoastListeners() {
    for (const listener of urbanCoastListeners) {
        try {
            listener(urbanCoastSceneYAtLocal);
        } catch (error) {
            console.warn('[water] urban-coast listener failed', error);
        }
    }
}

export function urbanCoastFormationSupportYAtLocal(localX, localZ, {
    maxY = Infinity,
} = {}) {
    const sceneY = urbanCoastSceneYAtLocal?.(localX, localZ);
    return Number.isFinite(sceneY) && sceneY <= maxY + 1e-6 ? sceneY : null;
}

export function isPointInMappedSea(localX, localZ) {
    return Number.isFinite(localX)
        && Number.isFinite(localZ)
        && !!activeCoastline
        && activeCoastline.contains(localX, localZ);
}

export function isMappedSeaReady() {
    return mappedSeaReady;
}

// The canonical shoreline as local [x, z] rings (outer coasts and island
// holes), for moorings along the bank; empty until the sea is mapped.
export function mappedShorelineRings() {
    return activeCoastline ? activeCoastline.features.flatMap(feature => feature.rings) : [];
}

export function hasMappedSeaCoverage() {
    return !!activeCoastline && activeCoastline.features.length > 0;
}

// Boats and the masked sea plane must share one scene-space vertical datum.
// In terrain worlds y=0 is not sea level, so WATER_LEVELS.sea alone would
// bury the hull while the sea renderer follows the DGU absolute datum.
export function mappedSeaSurfaceSceneY() {
    return mappedSeaSurfaceY;
}

// Where the published sea can draw, in scene metres: the square of its water
// mask, outside which the sea plane discards every fragment. A far sea beyond
// it (world/aerial-view.js) steps aside only inside that square, so no ring is
// left without water. Null before the first publication of a session.
// Collar quads of the active mapped coastline around a point: the shoreline
// segments the shore-formation probe walks. Empty until the sea has loaded.
export function mappedCoastCollarQuadsNear(localX, localZ) {
    if (!activeCoastline || !Number.isFinite(localX) || !Number.isFinite(localZ)) return [];
    return coastCollarNear(activeCoastline, localX, localZ).quads;
}

export function mappedSeaPlaneExtent() {
    return publishedSeaPlane;
}

function latLonToLocal(lat, lon) {
    const mPerDeg = DEG_TO_RAD * EARTH_RADIUS_M;
    return {
        x: (lon - anchorLon) * mPerDeg * Math.cos(anchorLat * DEG_TO_RAD),
        z: -(lat - anchorLat) * mPerDeg,
    };
}

// GeoJSON Polygon/MultiPolygon features → [{outer: [[x,z],…], holes: [...]}]
// in anchor-local coordinates (the scene space).
function collectPolygons(features) {
    const polys = [];
    const ringToLocal = (ring) => ring.map(([lon, lat]) => {
        const p = latLonToLocal(lat, lon);
        return [p.x, p.z];
    });
    for (const f of features || []) {
        const g = f && f.geometry;
        if (!g) continue;
        const polygons = g.type === 'Polygon' ? [g.coordinates]
            : g.type === 'MultiPolygon' ? g.coordinates
            : [];
        for (const rings of polygons) {
            if (!Array.isArray(rings) || rings.length === 0 || rings[0].length < 4) continue;
            polys.push({
                outer: ringToLocal(rings[0]),
                holes: rings.slice(1).map(ringToLocal),
            });
        }
    }
    return polys;
}

// World-anchored coastline ownership mask centered on (cx, cz): red removes
// the original DGU terrain, green reveals the sea plane. Both channels cover
// exact OSM water, while only red covers the generated land-side transition.
// Keeping them separate is what prevents the original coarse DGU triangle from
// surviving as a shelf above the infill without rendering blue water inland.
function buildMaskTexture(coastline, terrainCutout, cx, cz) {
    const canvas = document.createElement('canvas');
    canvas.width = MASK_SIZE_PX;
    canvas.height = MASK_SIZE_PX;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MASK_SIZE_PX, MASK_SIZE_PX);

    const toPxX = (v) => (v - cx + MASK_HALF_SIZE_M) / (2 * MASK_HALF_SIZE_M) * MASK_SIZE_PX;
    const toPxZ = (v) => (v - cz + MASK_HALF_SIZE_M) / (2 * MASK_HALF_SIZE_M) * MASK_SIZE_PX;
    const traceFeature = (feature) => {
        const path = new Path2D();
        for (const ring of feature.rings) {
            path.moveTo(toPxX(ring[0][0]), toPxZ(ring[0][1]));
            for (let i = 1; i < ring.length; i++) path.lineTo(toPxX(ring[i][0]), toPxZ(ring[i][1]));
            path.closePath();
        }
        return path;
    };

    const tracePolygon = (points) => {
        const path = new Path2D();
        if (!Array.isArray(points) || points.length < 3) return path;
        path.moveTo(toPxX(points[0][0]), toPxZ(points[0][1]));
        for (let index = 1; index < points.length; index++) {
            path.lineTo(toPxX(points[index][0]), toPxZ(points[index][1]));
        }
        path.closePath();
        return path;
    };

    // Green is the water visibility authority. Its small landward overlap is
    // buried beneath the exact vector coast surface, so mask texels cannot
    // open a hairline gap between that surface and the sea.
    ctx.fillStyle = '#00ff00';
    ctx.strokeStyle = '#00ff00';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = COAST_WATER_MASK_OVERDRAW_M * 2
        / (2 * MASK_HALF_SIZE_M) * MASK_SIZE_PX;
    for (const feature of coastline.features) {
        const path = traceFeature(feature);
        ctx.fill(path, 'evenodd');
        ctx.stroke(path);
    }

    // Add red without erasing green. Exact water always removes terrain; the
    // resolved collar cutout additionally removes DGU only beneath the coast
    // replacement, stopping short of its inner edge for an opaque overlap.
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ff0000';
    for (const feature of coastline.features) ctx.fill(traceFeature(feature), 'evenodd');
    for (const quad of terrainCutout?.quads || []) {
        ctx.fill(tracePolygon([quad.shoreA, quad.shoreB, quad.landB, quad.landA]));
    }
    for (const join of terrainCutout?.joins || []) {
        ctx.fill(tracePolygon([join.shore, join.landPrevious, join.landNext]));
    }
    ctx.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

function replaceGroundMask(texture, centerX, centerZ, sourceClaim, { retirePrevious = true } = {}) {
    const previous = groundMaskTexture;
    const next = texture || null;
    if (next) {
        setGroundHoleMask(
            next,
            centerX,
            centerZ,
            MASK_HALF_SIZE_M,
            sourceClaim,
        );
    } else {
        clearGroundHoleMask();
    }
    // Publish the JS-side owner only after the shader accepted the new mask.
    // A throwing shader adapter therefore leaves the previous generation and
    // its texture fully recoverable by the publication registry.
    groundMaskTexture = next;
    if (retirePrevious && previous && previous !== groundMaskTexture) previous.dispose();
}

function coastCollarNear(coastline, cx, cz) {
    const collar = buildMappedCoastLandCollar(coastline, {
        widthM: COAST_LAND_COLLAR_M,
        minimumWidthM: COAST_MIN_COLLAR_M,
    });
    return clipCoastCollarToWindow(collar, coastline, cx, cz);
}

function clipCoastCollarToWindow(collar, coastline, cx, cz) {
    const quads = collar.quads.map(quad => clipMappedCoastQuadToWindow(quad, cx, cz, MASK_HALF_SIZE_M)).filter(Boolean);
    const joins = collar.joins.filter(({ shore }) => (
        Math.abs(shore[0] - cx) <= MASK_HALF_SIZE_M && Math.abs(shore[1] - cz) <= MASK_HALF_SIZE_M
    ));
    return { quads, joins, coastline };
}

function terrainCollarY(point) {
    if (!terrainReference) return WALL_TOP_Y;
    const evidenceY = finiteOrNull(
        terrainReference.evidenceSceneYAtLocal?.(point[0], point[1]),
    );
    return evidenceY === null ? null : evidenceY + COAST_SURFACE_LIFT_M;
}

function resolveCoastTerrainInfill(collar, seaY, terrain = terrainReference) {
    if (!terrain) {
        return {
            quads: (collar.quads || []).map(quad => ({
                ...quad,
                shoreAY: WALL_TOP_Y,
                shoreBY: WALL_TOP_Y,
                landAY: WALL_TOP_Y,
                landBY: WALL_TOP_Y,
                extendedA: false,
                extendedB: false,
            })),
            joins: (collar.joins || []).map(join => ({
                ...join,
                shoreY: WALL_TOP_Y,
                landPreviousY: WALL_TOP_Y,
                landNextY: WALL_TOP_Y,
                extendedPrevious: false,
                extendedNext: false,
            })),
            diagnostics: {
                resolvedRayCount: 0,
                extendedRayCount: 0,
                inferredRayCount: 0,
                unresolvedRayCount: 0,
                omittedQuadCount: 0,
                omittedJoinCount: 0,
                maximumResolvedReachM: COAST_LAND_COLLAR_M,
            },
        };
    }
    return resolveMappedCoastTerrainInfill(collar, coastInfillOptions(collar, seaY, terrain));
}

function coastInfillOptions(collar, seaY, terrain) {
    return {
        coastline: collar.coastline,
        evidenceSceneYAtLocal: (x, z) => finiteOrNull(
            terrain.evidenceSceneYAtLocal?.(x, z),
        ),
        shoreSceneY: seaY + COAST_SURFACE_LIFT_M,
        surfaceLiftM: COAST_SURFACE_LIFT_M,
        maxReachM: COAST_TERRAIN_MAX_REACH_M,
    };
}

// Probe on the land edge of the collar rather than exactly on the mapped
// waterline: DGU correctly has NoData offshore, and a small source mismatch
// must not collapse the quay top down to the 0 m fallback datum.
function collarTopY(shore, land, shoreTopIndex, explicitY = null) {
    if (Number.isFinite(explicitY)) return explicitY;
    if (!terrainReference) return WALL_TOP_Y;
    const indexed = shoreTopIndex?.get(`${shore[0]}:${shore[1]}`);
    if (Number.isFinite(indexed)) return indexed;
    return terrainCollarY(land);
}

function buildShoreTopIndex(quads) {
    const candidates = new Map();
    const add = (shore, land, explicitY) => {
        const key = `${shore[0]}:${shore[1]}`;
        const y = Number.isFinite(explicitY) ? explicitY : terrainCollarY(land);
        if (y === null) return false;
        const previous = candidates.get(key);
        // The landward sample with the higher valid DTM surface wins. This
        // prevents one offshore NoData fallback from pulling a shared corner
        // down while its adjacent segment already found the promenade deck.
        candidates.set(key, Number.isFinite(previous) ? Math.max(previous, y) : y);
    };
    for (const { shoreA, shoreB, landA, landB, shoreAY, shoreBY } of quads) {
        if (add(shoreA, landA, shoreAY) === false
            || add(shoreB, landB, shoreBY) === false) return false;
    }
    return candidates;
}

function buildLandCollarGeometry(collar, shoreTopIndex, uvPerM) {
    const positions = [];
    const uvs = [];
    const pushVertex = (point, y) => {
        positions.push(point[0], y, point[1]);
        uvs.push(point[0], point[1]);
    };
    const pushTriangle = (a, ay, b, by, c, cy) => {
        const area = (b[0] - a[0]) * (c[1] - a[1])
            - (c[0] - a[0]) * (b[1] - a[1]);
        if (area > 0) {
            [b, c] = [c, b];
            [by, cy] = [cy, by];
        }
        pushVertex(a, ay);
        pushVertex(b, by);
        pushVertex(c, cy);
    };
    const landY = (point) => terrainCollarY(point);
    for (const quad of collar.quads) {
        const shoreAY = collarTopY(
            quad.shoreA, quad.landA, shoreTopIndex, quad.shoreAY,
        );
        const shoreBY = collarTopY(
            quad.shoreB, quad.landB, shoreTopIndex, quad.shoreBY,
        );
        const landAY = Number.isFinite(quad.landAY) ? quad.landAY : landY(quad.landA);
        const landBY = Number.isFinite(quad.landBY) ? quad.landBY : landY(quad.landB);
        if ([shoreAY, shoreBY, landAY, landBY].some(value => value === null)) return null;
        pushTriangle(quad.shoreA, shoreAY, quad.landA, landAY, quad.shoreB, shoreBY);
        pushTriangle(quad.shoreB, shoreBY, quad.landA, landAY, quad.landB, landBY);
    }
    for (const join of collar.joins) {
        const shoreY = collarTopY(
            join.shore, join.landNext, shoreTopIndex, join.shoreY,
        );
        const previousY = Number.isFinite(join.landPreviousY)
            ? join.landPreviousY
            : landY(join.landPrevious);
        const nextY = Number.isFinite(join.landNextY)
            ? join.landNextY
            : landY(join.landNext);
        if ([shoreY, previousY, nextY].some(value => value === null)) return null;
        pushTriangle(
            join.shore,
            shoreY,
            join.landPrevious,
            previousY,
            join.landNext,
            nextY,
        );
    }
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(
        new Float32Array(uvs.map(value => value * uvPerM)),
        2,
    ));
    geometry.computeVertexNormals();
    return geometry;
}

function createCoastTerrainMaterial({ exactFormationCutouts = false } = {}) {
    const claim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.TERRAIN,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'mapped-coast-terrain-infill',
        sourceId: 'world/water.js',
        supportReady: true,
    });
    const surface = getActiveTerrainSurface();
    // The terrain maps are location-wide singletons. Coast generations own
    // their material, never those shared textures.
    registerShared(surface.map, surface.bumpMap);
    const material = new THREE.MeshStandardMaterial({
        map: surface.map,
        bumpMap: surface.bumpMap,
        bumpScale: surface.bumpScale,
        side: THREE.DoubleSide,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
    applySurfaceStencil(material, claim);
    if (!exactFormationCutouts) applyGroundOwnership(material, claim);
    applyStreetLampSurfaceLighting(material);
    applyPlannerSurfaceCutout(material, claim);
    // This is explicit, vector-bounded terrain geometry rather than the DGU
    // tile itself, so it must not consume the raster sea-hole shader. Its
    // exact shoreline vertices already own that boundary. It does retain the
    // natural location material and mapped land-use tint.
    applyUrbanGroundSurface(material, claim, {
        fieldPatchwork: true,
        urbanGround: false,
    });
    return material;
}

// The wall and land collar consume the same vector quads and therefore share
// bit-identical shoreline vertices; there is no independent seam to drift.
function buildWallGeometry(quads, shoreTopIndex, seaY) {
    const positions = [];
    for (const { shoreA, shoreB, landA, landB, shoreAY, shoreBY } of quads) {
        const topA = collarTopY(shoreA, landA, shoreTopIndex, shoreAY);
        const topB = collarTopY(shoreB, landB, shoreTopIndex, shoreBY);
        if (topA === null || topB === null) return null;
        const bottomY = terrainReference ? seaY - 0.8 : WALL_BOTTOM_Y;
        positions.push(
            shoreA[0], topA, shoreA[1],
            shoreB[0], topB, shoreB[1],
            shoreA[0], bottomY, shoreA[1],
            shoreB[0], topB, shoreB[1],
            shoreB[0], bottomY, shoreB[1],
            shoreA[0], bottomY, shoreA[1],
        );
    }
    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    return geo;
}

function geometryFromCoastData(positions, normals, uvs = null) {
    if (!positions || positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return geometry;
}

function createUrbanQuayStoneTexture() {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#8d887c';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    const courseH = 82;
    const stoneW = 132;
    for (let row = -1; row < 8; row += 1) {
        const y = row * courseH;
        const offset = row % 2 === 0 ? 0 : -stoneW * 0.5;
        for (let column = -1; column < 6; column += 1) {
            const x = offset + column * stoneW;
            const tone = 150 + ((row * 17 + column * 11) % 5) * 5;
            drawing.fillStyle = `rgb(${tone + 5},${tone + 2},${tone - 5})`;
            drawing.fillRect(x + 4, y + 4, stoneW - 8, courseH - 8);
            drawing.strokeStyle = 'rgba(61,58,53,0.58)';
            drawing.lineWidth = 4;
            drawing.strokeRect(x + 2, y + 2, stoneW - 4, courseH - 4);
            drawing.strokeStyle = 'rgba(235,229,214,0.24)';
            drawing.lineWidth = 2;
            drawing.strokeRect(x + 7, y + 7, stoneW - 14, courseH - 14);
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 2;
    return texture;
}

function buildUrbanCoastFormationGroup(sections, seaY, {
    generation = null,
    replacementKey = 'mapped-sea',
    originX = 0,
    originZ = 0,
} = {}) {
    const data = buildUrbanCoastGeometryData(sections, { seaY, originX, originZ });
    if (data.sectionCount === 0) return null;
    const next = new THREE.Group();
    next.name = 'UrbanCoastFormation';
    next.position.set(originX, 0, originZ);
    next.userData.sectionCount = data.sectionCount;

    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute('position', new THREE.Float32BufferAttribute(data.topPositions, 3));
    topGeo.setAttribute('uv', new THREE.Float32BufferAttribute(data.topUvs, 2));
    topGeo.computeVertexNormals();
    const topClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.SIDEWALK,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        verticalBand: 'ground',
        ownerId: 'mapped-urban-coast-formation',
        sourceId: 'world/water.js',
        replacementKey,
        generation,
        supportReady: true,
        cutsBackstop: true,
    });
    const topMaterial = new THREE.MeshStandardMaterial({
        color: 0xe2ded3,
        map: createUrbanQuayStoneTexture(),
        roughness: 0.96,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
    applySurfaceStencil(topMaterial, topClaim);
    applyGroundOwnership(topMaterial, topClaim);
    applyPlannerSurfaceCutout(topMaterial, topClaim);
    applyStreetLampSurfaceLighting(topMaterial);
    const top = new THREE.Mesh(topGeo, topMaterial);
    top.name = 'UrbanQuayStoneDeck';
    top.userData.walkableSurface = true;
    markSurfaceClaim(top, topClaim);
    markInspectionLayer(top, {
        id: 'urban-coast-formations',
        label: 'Urban quays and rivas',
        category: 'Civil works',
        source: 'world/water.js · road-backed mapped shoreline formation',
        order: 334,
    });
    top.receiveShadow = true;
    next.add(top);

    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(data.wallPositions, 3));
    wallGeo.computeVertexNormals();
    const wallClaim = compileSurfaceClaim({
        surfaceClass: SURFACE_CLASS.STRUCTURE,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
        verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
        ownerId: 'mapped-urban-coast-wall',
        sourceId: 'world/water.js',
        structureId: 'mapped-urban-coast',
        replacementKey,
        generation,
    });
    const wallMaterial = applyPlannerSurfaceCutout(new THREE.MeshStandardMaterial({
        color: 0x817b70,
        roughness: 0.98,
        side: THREE.DoubleSide,
    }), wallClaim);
    const wall = new THREE.Mesh(wallGeo, wallMaterial);
    wall.name = 'UrbanQuayVerticalWall';
    markSurfaceClaim(wall, wallClaim);
    markInspectionLayer(wall, {
        id: 'urban-coast-walls',
        label: 'Urban quay vertical faces',
        category: 'Civil works',
        source: 'world/water.js · road-backed mapped shoreline wall',
        order: 335,
    });
    wall.receiveShadow = true;
    next.add(wall);
    const sample = createMappedCoastTerrainSurfaceSampler(data.topPositions);
    next.userData.sceneYAtLocal = sample ? (x, z) => sample(x - originX, z - originZ) : null;
    return next;
}

function cancelUrbanCoastBuild() {
    if (!urbanCoastBuild) return;
    coastDressingQueue.cancel(urbanCoastBuild.job);
}

function clearUrbanCoastFormation({ notify = false } = {}) {
    cancelUrbanCoastBuild();
    if (urbanCoastGroup) disposeGroup(urbanCoastGroup);
    urbanCoastGroup = null;
    urbanCoastSceneYAtLocal = null;
    if (notify) notifyUrbanCoastListeners();
}

function terrainEvidenceYAtLocal(x, z) {
    return finiteOrNull(terrainReference?.evidenceSceneYAtLocal?.(x, z));
}

function urbanCoastQuadsNear(collar, centerX, centerZ) {
    return splitLongCoastQuads((collar?.quads || []).map(quad => clipMappedCoastQuadToWindow(quad,
        centerX, centerZ, URBAN_COAST_RADIUS_M)).filter(Boolean));
}

function scheduleUrbanCoastBuild(collar, seaY, centerX, centerZ, roadRevision) {
    if (!group || urbanCoastBuild || !collar
        || !Number.isFinite(centerX) || !Number.isFinite(centerZ)) return false;
    const build = {
        sessionToken,
        generation: ++urbanCoastGeneration,
        parent: group,
        roadRevision,
        centerX,
        centerZ,
        seaY,
        sections: [],
        candidate: null,
        job: null,
        published: false,
        settled: false,
    };
    const quads = urbanCoastQuadsNear(collar, centerX, centerZ);
    const sampleLandingY = createUrbanCoastLandingSampler({
        sampleRoadY: renderedRoadSurfaceSupportYAtLocal, pavedGroundAt: pedestrianZoneAtLocal,
        sampleTerrainY: terrainEvidenceYAtLocal, liftM: COAST_SURFACE_LIFT_M,
    });
    urbanCoastBuild = build;
    const settle = (publish) => {
        if (build.settled) return;
        build.settled = true;
        const current = urbanCoastBuild === build
            && build.sessionToken === sessionToken
            && build.parent === group
            && build.roadRevision === observedUrbanRoadRevision;
        if (publish && current) {
            build.candidate = buildUrbanCoastFormationGroup(
                build.sections,
                build.seaY,
                { generation: build.generation, originX: build.centerX, originZ: build.centerZ },
            );
            const previous = urbanCoastGroup;
            urbanCoastGroup = build.candidate;
            urbanCoastSceneYAtLocal = build.candidate?.userData?.sceneYAtLocal || null;
            if (urbanCoastGroup) build.parent.add(urbanCoastGroup);
            build.published = true;
            if (previous && previous !== urbanCoastGroup) disposeGroup(previous);
            appliedUrbanRoadRevision = build.roadRevision;
            urbanCoastCenterX = build.centerX;
            urbanCoastCenterZ = build.centerZ;
            urbanCoastRefreshRequested = false;
            notifyUrbanCoastListeners();
        }
        if (build.candidate && !build.published) disposeGroup(build.candidate);
        if (urbanCoastBuild === build) urbanCoastBuild = null;
    };
    build.job = coastDressingQueue.enqueue(quads, (quad) => {
        if (urbanCoastBuild !== build || build.sessionToken !== sessionToken
            || build.parent !== group) return undefined;
        if (frameChunkObserverIsMoving()) return FRAME_CHUNK_DEFER_ITEM;
        const section = resolveUrbanCoastSection(quad, {
            seaY,
            sampleRoadY: sampleLandingY,
            sampleTerrainY: terrainEvidenceYAtLocal,
        });
        if (section) build.sections.push(section);
        return undefined;
    }, {
        onComplete: () => settle(true),
        onCancel: () => settle(false),
        onError: (error) => {
            console.warn('[water] urban-coast build failed:', error);
            settle(false);
        },
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 2,
        describeItem: () => 'urban-quay:classify',
    });
    return true;
}

function requestUrbanCoastRefresh(centerX, centerZ) {
    if (!Number.isFinite(centerX) || !Number.isFinite(centerZ)) return;
    urbanCoastCenterX = centerX;
    urbanCoastCenterZ = centerZ;
    observedUrbanRoadRevision = getRenderedRoadSurfaceRevision(
        centerX,
        centerZ,
        URBAN_COAST_RADIUS_M + URBAN_COAST_SEARCH_M,
    );
    urbanRoadRevisionChangedAtMs = typeof performance !== 'undefined'
        ? performance.now()
        : Date.now();
    urbanCoastRefreshRequested = true;
    cancelUrbanCoastBuild();
}

function updateUrbanCoastFormation(local) {
    if (!activeCoastDressing || !group || !local
        || !Number.isFinite(local.x) || !Number.isFinite(local.z)) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!Number.isFinite(urbanCoastCenterX)
        || !Number.isFinite(urbanCoastCenterZ)
        || Math.hypot(
            local.x - urbanCoastCenterX,
            local.z - urbanCoastCenterZ,
        ) >= URBAN_COAST_REFRESH_MOVE_M) {
        requestUrbanCoastRefresh(local.x, local.z);
        return;
    }
    const roadRevision = getRenderedRoadSurfaceRevision(
        urbanCoastCenterX,
        urbanCoastCenterZ,
        URBAN_COAST_RADIUS_M + URBAN_COAST_SEARCH_M,
    );
    if (roadRevision !== observedUrbanRoadRevision) {
        observedUrbanRoadRevision = roadRevision;
        urbanRoadRevisionChangedAtMs = now;
        urbanCoastRefreshRequested = true;
        cancelUrbanCoastBuild();
        return;
    }
    if (urbanCoastBuild
        || now - urbanRoadRevisionChangedAtMs < URBAN_COAST_ROAD_SETTLE_MS
        || (!urbanCoastRefreshRequested
            && appliedUrbanRoadRevision === observedUrbanRoadRevision)) return;
    scheduleUrbanCoastBuild(
        activeCoastDressing.collar,
        activeCoastDressing.seaY,
        urbanCoastCenterX,
        urbanCoastCenterZ,
        observedUrbanRoadRevision,
    );
}

function buildCoastDressingGroup(collar, seaY, {
    replacementKey = null,
    generation = null,
    terrainInfill: suppliedTerrainInfill = null,
    geometryData = null,
    exactFormationCutouts = false,
} = {}) {
    const terrainInfill = suppliedTerrainInfill || resolveCoastTerrainInfill(collar, seaY);
    if (terrainInfill.quads.length === 0) return null;
    const shoreTopIndex = buildShoreTopIndex(terrainInfill.quads);
    if (shoreTopIndex === false) return false;
    const nextGroup = new THREE.Group();
    nextGroup.name = 'SeaCoastDressing';
    const originX = geometryData?.originX ?? 0, originZ = geometryData?.originZ ?? 0;
    nextGroup.position.set(originX, 0, originZ);
    nextGroup.userData.coastTerrainInfill = terrainInfill.diagnostics;

    const terrainSurface = getActiveTerrainSurface();
    const collarGeo = geometryData
        ? geometryFromCoastData(
            geometryData.collarPositions,
            geometryData.collarNormals,
            geometryData.collarUvs,
        )
        : buildLandCollarGeometry(
            terrainInfill,
            shoreTopIndex,
            terrainSurface.uvPerM,
        );
    if (collarGeo) {
        const coastTerrainSceneYAtLocal = createMappedCoastTerrainSurfaceSampler(
            collarGeo.getAttribute('position')?.array,
        );
        if (coastTerrainSceneYAtLocal) {
            nextGroup.userData.coastTerrainSceneYAtLocal = (x, z) => coastTerrainSceneYAtLocal(x - originX, z - originZ);
        }
        const collarMesh = new THREE.Mesh(collarGeo, createCoastTerrainMaterial({ exactFormationCutouts }));
        collarMesh.name = 'SeaTerrainInfill';
        markSurfaceClaim(collarMesh, {
            surfaceClass: SURFACE_CLASS.TERRAIN,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
            verticalBand: 'ground',
            ownerId: 'mapped-coast-terrain-infill',
            sourceId: 'world/water.js',
            replacementKey,
            generation,
            supportReady: true,
        });
        markInspectionLayer(collarMesh, {
            id: 'coast-terrain-infill',
            label: 'Mapped coast terrain infill',
            category: 'Ground',
            source: 'world/water.js · DGU-evidenced terrain to mapped shoreline',
            order: 332,
        });
        collarMesh.userData.walkableSurface = true;
        collarMesh.userData.coastTerrainInfill = terrainInfill.diagnostics;
        collarMesh.receiveShadow = true;
        collarMesh.renderOrder = -5;
        nextGroup.add(collarMesh);
    }

    // A short below-water skirt prevents a grazing view from seeing beneath
    // the final terrain triangle. The visible top is at the sea datum; this is
    // not a quay wall and does not hold the natural coast above the water.
    const wallGeo = geometryData
        ? geometryFromCoastData(geometryData.wallPositions, geometryData.wallNormals)
        : buildWallGeometry(terrainInfill.quads, shoreTopIndex, seaY);
    if (wallGeo) {
        const wallClaim = compileSurfaceClaim({
            surfaceClass: SURFACE_CLASS.STRUCTURE,
            coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
            verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED,
            ownerId: 'mapped-coast-edge-skirt',
            sourceId: 'world/water.js',
            structureId: 'mapped-coastline',
            replacementKey,
            generation,
        });
        const wallMat = applyPlannerSurfaceCutout(new THREE.MeshStandardMaterial({
            color: 0x9a938a,
            roughness: 0.95,
            side: THREE.DoubleSide,
        }), wallClaim);
        const walls = new THREE.Mesh(wallGeo, wallMat);
        walls.name = 'SeaCoastEdgeSkirt';
        markSurfaceClaim(walls, wallClaim);
        markInspectionLayer(walls, {
            id: 'coast-edge-skirt',
            label: 'Mapped coast submerged edge',
            category: 'Civil works',
            source: 'world/water.js · mapped shoreline below-water closure',
            order: 333,
        });
        walls.receiveShadow = true;
        nextGroup.add(walls);
    }
    return nextGroup;
}

function cleanupCoastDressingBuild(build) {
    if (!build || build.cleaned) return;
    build.cleaned = true;
    build.geometryTask?.cancel?.();
    const prewarm = build.prewarm;
    const ready = build.prewarmReady;
    const candidate = build.published ? null : build.candidate;
    const maskTexture = build.maskPublished ? null : build.maskTexture;
    build.prewarm = null;
    build.prewarmReady = null;
    build.candidate = null;
    build.maskTexture = null;
    const disposeCandidate = () => {
        prewarm?.return?.();
        if (candidate) disposeGroup(candidate);
        maskTexture?.dispose();
    };
    // A cancelled coast generation is detached already. Its materials still
    // belong to Three's asynchronous shader poll until this fence settles.
    // Retire that captured generation only; a newer build may already exist.
    if (ready) {
        ready.then(disposeCandidate, disposeCandidate).catch(error => {
            console.warn('[water] coast-dressing cleanup failed:', error);
        });
    } else disposeCandidate();
}

function cancelCoastDressingBuild() {
    const build = coastDressingBuild;
    if (!build) return;
    coastDressingQueue.cancel(build.job);
}

function coastDressingBuildIsCurrent(build) {
    return !!build
        && coastDressingBuild === build
        && build.sessionToken === sessionToken
        && build.revision === coastDressingRevision
        && build.parent === group
        && build.seaClaim === activeSeaClaim;
}

function scheduleCoastDressingBuild(collar, seaY, maskCenterX, maskCenterZ) {
    if (!group || !activeSeaClaim || coastDressingBuild
        || !Number.isFinite(maskCenterX) || !Number.isFinite(maskCenterZ)) return false;
    const active = surfacePublications?.getActive?.('mapped-sea');
    const build = {
        sessionToken,
        revision: coastDressingRevision,
        parent: group,
        seaClaim: activeSeaClaim,
        collar,
        seaY,
        maskCenterX,
        maskCenterZ,
        terrainInfill: null,
        terrainCutout: null,
        geometryTask: null,
        geometryData: null,
        candidate: null,
        maskTexture: null,
        prewarm: null,
        prewarmReady: null,
        phase: 'resolve-infill',
        phaseLabel: 'resolve-infill',
        ready: false,
        published: false,
        maskPublished: false,
        cleaned: false,
        job: null,
    };
    coastDressingBuild = build;
    const settle = () => {
        const current = coastDressingBuildIsCurrent(build);
        if (current && build.ready && build.candidate && build.maskTexture) {
            // The existing complete shoreline and terrain replacement remain
            // visible through every CPU/GPU stage. Attach the candidate first,
            // switch the dual-channel ground mask in the same turn, then retire
            // the previous generation.
            const previous = coastDressingGroup;
            build.parent.add(build.candidate);
            try {
                replaceGroundMask(
                    build.maskTexture,
                    build.maskCenterX,
                    build.maskCenterZ,
                    build.seaClaim,
                );
            } catch (error) {
                build.parent.remove(build.candidate);
                console.warn(
                    '[water] coast transition refresh retained its previous generation',
                    error,
                );
            }
            if (build.maskTexture === groundMaskTexture) {
                coastDressingGroup = build.candidate;
                build.published = true;
                build.maskPublished = true;
                publishCoastTerrainReplacement(build.candidate, { notify: true });
                if (previous && previous !== coastDressingGroup) disposeGroup(previous);
                activeCoastDressing = {
                    collar: build.collar,
                    seaY: build.seaY,
                    maskCenterX: build.maskCenterX,
                    maskCenterZ: build.maskCenterZ,
                };
                pendingCoastDressing = null;
                coastDressingDirty = false;
            }
        }
        if (coastDressingBuild === build) coastDressingBuild = null;
        cleanupCoastDressingBuild(build);
    };
    build.job = coastDressingQueue.enqueue([build], (item) => {
        if (!coastDressingBuildIsCurrent(item)) return undefined;
        // A terrain revision is cosmetic while the old complete mapped coast
        // still owns the seam. Do none of its compilation or 2048px mask upload
        // during travel; it resumes behind the delivery boundary after settle.
        if (frameChunkObserverIsMoving()) {
            item.phaseLabel = `${item.phase}:waiting-for-settle`;
            return FRAME_CHUNK_DEFER_ITEM;
        }
        item.phaseLabel = item.phase;
        if (item.phase === 'resolve-infill') {
            item.terrainInfill = resolveCoastTerrainInfill(item.collar, item.seaY);
            if (item.terrainInfill.quads.length === 0) return undefined;
            item.phase = 'terrain-cutout';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.phase === 'terrain-cutout') {
            item.terrainCutout = buildMappedCoastTerrainCutout(item.terrainInfill, {
                innerOverlapM: COAST_TERRAIN_INNER_OVERLAP_M,
            });
            const terrainSurface = getActiveTerrainSurface();
            item.geometryTask = createCoastDressingBuildTask({
                collar: item.terrainInfill,
                seaY: item.seaY,
                originX: item.maskCenterX,
                originZ: item.maskCenterZ,
                terrainAware: !!terrainReference,
                sampleTerrainY: terrainCollarY,
                fallbackTopY: WALL_TOP_Y,
                wallBottomY: WALL_BOTTOM_Y,
                uvPerM: terrainSurface.uvPerM,
            });
            item.phase = 'geometry';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.phase === 'geometry') {
            item.phaseLabel = `geometry:${item.geometryTask.phaseLabel()}`;
            if (item.geometryTask.step() === 'more') return FRAME_CHUNK_REPEAT_ITEM;
            item.geometryData = item.geometryTask.result();
            if (item.geometryData?.status !== 'ready') return undefined;
            item.phase = 'candidate';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.phase === 'candidate') {
            item.candidate = buildCoastDressingGroup(item.collar, item.seaY, {
                replacementKey: 'mapped-sea',
                generation: active?.generation ?? waterPublicationGeneration,
                terrainInfill: item.terrainInfill,
                geometryData: item.geometryData,
            });
            item.geometryData = null;
            if (!item.candidate) return undefined;
            item.prewarm = prewarmDetachedObject(item.candidate, {
                renderer,
                camera,
                targetScene: scene,
                asyncShaders: true,
                label: 'water-dressing-gpu-prewarm',
                uploadBatch: 1,
                sliceMs: 2,
                // Rendering the entire terrain-infill buffer into the 1x1
                // prewarm target caused a measured 514 ms driver stall. Its
                // ordinary first visible upload is below the 50 ms gate; keep
                // async material preparation here and let that upload happen
                // through the normal renderer after atomic publication.
                uploadGeometry: false,
            });
            item.phase = 'mask';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.phase === 'mask') {
            item.maskTexture = buildMaskTexture(
                item.collar.coastline,
                item.terrainCutout,
                item.maskCenterX,
                item.maskCenterZ,
            );
            item.phase = 'mask-upload';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        if (item.phase === 'mask-upload') {
            renderer.initTexture?.(item.maskTexture);
            item.phase = 'gpu-prewarm';
            return FRAME_CHUNK_REPEAT_ITEM;
        }
        const outcome = item.prewarm.next();
        item.prewarmReady = outcome.value?.ready || null;
        item.phaseLabel = String(outcome.value?.phase || 'publish');
        if (!outcome.done) return FRAME_CHUNK_REPEAT_ITEM;
        item.prewarm = null;
        item.ready = true;
        return undefined;
    }, {
        onComplete: settle,
        onCancel: settle,
        onError: (error) => {
            console.warn('[water] coast-dressing rebuild failed:', error);
            settle();
        },
        maxItemsPerFrame: 1,
        maxItemsPerSettledFrame: 1,
        describeItem: item => `coast:${item.phaseLabel}`,
    });
    coastDressingDirty = false;
    return true;
}

function waterGroundFailure(code, message) { throw Object.assign(new Error(message), { code }); }

function* waterOpeningSignatureSteps(openings, bounds, isCurrent) {
    const parts = [];
    for (const region of openings?.regions || []) {
        if (!isCurrent()) waterGroundFailure('ground-generation-stale', 'Water inputs expired');
        const b = region.bounds;
        if (!['mapped-sea', 'mapped-coast-ground'].includes(region.replacementKey) && bounds
            && b.minX <= bounds.maxX && b.maxX >= bounds.minX && b.minZ <= bounds.maxZ && b.maxZ >= bounds.minZ) {
            parts.push(JSON.stringify([region.targetMask, region.ring, region.minPlane,
                region.minY, region.maxY, region.maxYExclusive, region.replacementKey]));
        }
        yield { phase: 'water-opening-dependencies' };
    }
    return parts.join('|');
}

function* waterSurfaceBoundsSteps(surfaces) {
    const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    let count = 0;
    for (const { positions, originX = 0, originZ = 0 } of surfaces) for (let i = 0; i < positions.length; i += 3) {
        bounds.minX = Math.min(bounds.minX, positions[i] + originX); bounds.maxX = Math.max(bounds.maxX, positions[i] + originX);
        bounds.minZ = Math.min(bounds.minZ, positions[i + 2] + originZ); bounds.maxZ = Math.max(bounds.maxZ, positions[i + 2] + originZ);
        if (++count % 256 === 0) yield { phase: 'water-surface-bounds' };
    }
    return count ? Object.freeze(bounds) : null;
}

// These roots remain private through clipping, physical-face capture and GPU
// readiness. Every managed support mesh opts out of ordinary collider rebuilds.
function* prepareWaterRootSteps(root, { openings, generation, isCurrent, onFence, prewarm = true }) {
    if (!root) return EMPTY_RECEIVER_SUPPORT_READ;
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse(object => { if (object.isMesh) meshes.push(object); });
    const colliderState = { published: false };
    root.userData.groundColliderState = colliderState;
    let geometryBytes = 0;
    for (let mesh of meshes) {
        if (!isCurrent()) waterGroundFailure('ground-generation-stale', 'Water receiver expired');
        const clipped = yield* clipReceiverMeshOpeningsSteps({ mesh, worldMatrix: mesh.matrixWorld,
            openingRead: openings, ...GROUND_GENERATION_LIMITS.openingSupport,
            maxGeometryBytes: GROUND_GENERATION_LIMITS.water.maxGeometryBytes, isCurrent });
        if (clipped !== mesh) {
            const parent = mesh.parent; parent.remove(mesh); parent.add(clipped);
            mesh.geometry.dispose(); mesh = clipped;
        }
        for (const attribute of [mesh.geometry.index, ...Object.values(mesh.geometry.attributes)]) {
            geometryBytes += attribute?.array?.byteLength || 0;
        }
        if (geometryBytes > GROUND_GENERATION_LIMITS.water.maxGeometryBytes) {
            waterGroundFailure('ground-generation-capacity', 'Water receiver exceeds geometry capacity');
        }
        // Exact clipping now supplies all planner/authored openings.
        mesh.material.defines = { ...mesh.material.defines, ST3D_PLANNER_GEOMETRY_CUTOUTS: 1 };
        mesh.material.userData.plannerGeometryCutouts = true;
        mesh.material.needsUpdate = true;
        if (mesh.userData.surfaceClaim?.surfaceClass !== SURFACE_CLASS.WATER) {
            mesh.userData.groundColliderFamily = 'authored-surfaces';
            mesh.userData.groundColliderState = colliderState;
        }
    }
    const supportRead = yield* captureReceiverMeshReadSteps({ root, revision: generation,
        include: mesh => mesh.userData.groundColliderFamily === 'authored-surfaces',
        ...GROUND_GENERATION_LIMITS.openingSupport, isCurrent });
    if (!prewarm) return supportRead;
    const upload = prewarmDetachedObject(root, { renderer, camera, targetScene: scene,
        asyncShaders: true, label: 'water:ground-upload', uploadBatch: 8, maxUploadBytes: 256 * 1024, sliceMs: 2 });
    try { for (;;) {
        if (!isCurrent()) waterGroundFailure('ground-generation-stale', 'Water upload expired');
        const next = upload.next(); if (next.done) break;
        onFence(next.value?.ready || null); yield next.value;
    } } finally { upload.return(); }
    return supportRead;
}

function applyWaterGroundState(state) {
    const center = state?.data.source?.center || { x: 0, z: 0 };
    const maskCenter = state?.maskCenter || center;
    replaceGroundMask(state?.mask || null, maskCenter.x, maskCenter.z, state?.claim, { retirePrevious: false });
    activeWaterGround = state;
    group = state?.root || null;
    waterMaterials = state?.materials || [];
    activeSeaClaim = state?.claim || null;
    publishedSeaPlane = state?.data.sea.triangleCount ? Object.freeze({
        centerX: center.x, centerZ: center.z, halfSizeM: MASK_HALF_SIZE_M }) : null;
    activeCoastline = state?.data.source?.coastline || null;
    mappedSeaReady = !!state?.data.source;
    navigationMapContext.setWater(activeCoastline);
}

function* prepareWaterGroundSteps({ terrain, registry, generation, isCurrent }) {
    const ctx = waterGroundContext, source = waterGroundSource, previous = activeWaterGround;
    // A refresh installs a new immutable source and queues a successor ground
    // generation. It must not invalidate the frozen source already captured by
    // this transaction: a coastal network response can arrive while an
    // otherwise valid road generation is uploading, which used to discard the
    // complete road/curb/terrain graph and leave only streamed centrelines.
    // Session teardown and replacement of the published predecessor remain
    // hard invalidations.
    const current = () => waterGroundContext === ctx
        && activeWaterGround === previous && isCurrent();
    if (!ctx || !current()) waterGroundFailure('ground-dependency-busy', 'Water source is unavailable');
    let data = previous?.data;
    if (!data || data.source !== source || source?.coastline.features.length && data.terrainRevision !== terrain.revision) {
        const coastline = source?.coastline || createMappedCoastline([]), center = source?.center || { x: 0, z: 0 };
        const seaY = source?.seaY ?? resolveMappedSeaSurfaceY(terrain);
        const sea = yield* compileMappedWaterSurfaceSteps({ coastline, centerX: center.x, centerZ: center.z,
            halfSizeM: MASK_HALF_SIZE_M, seaY, limits: GROUND_GENERATION_LIMITS.water, isCurrent: current });
        const rawCollar = yield* buildMappedCoastLandCollarSteps(coastline, {
            widthM: COAST_LAND_COLLAR_M, minimumWidthM: COAST_MIN_COLLAR_M, isCurrent: current });
        const collar = clipCoastCollarToWindow(rawCollar, coastline, center.x, center.z);
        if (collar.quads.length * 2 + collar.joins.length + sea.triangleCount > GROUND_GENERATION_LIMITS.openings.maxRegions) {
            waterGroundFailure('ground-opening-capacity', 'Complete coastline exceeds opening capacity');
        }
        yield { phase: 'water-coast-collar' };
        if (!current()) waterGroundFailure('ground-generation-stale', 'Coast inputs expired');
        const infill = yield* resolveMappedCoastTerrainInfillSteps(collar,
            { ...coastInfillOptions(collar, seaY, terrain), isCurrent: current });
        const task = createCoastDressingBuildTask({ collar: infill, seaY, originX: center.x, originZ: center.z,
            sampleTerrainY: point => {
                const y = finiteOrNull(terrain.evidenceSceneYAtLocal(point[0], point[1]));
                return y === null ? null : y + COAST_SURFACE_LIFT_M;
            }, uvPerM: getActiveTerrainSurface().uvPerM, wallBottomY: WALL_BOTTOM_Y });
        let geometry;
        try {
            while (task.step() !== 'done') {
                yield { phase: `water-coast-${task.phaseLabel()}` };
                if (!current()) waterGroundFailure('ground-generation-stale', 'Coast evidence expired');
            }
            geometry = task.result();
        } finally { task.cancel(); }
        if (geometry.status !== 'ready') waterGroundFailure('ground-backstop-unavailable', 'Coast geometry lacks complete evidence');
        const identical = yield* sameMappedWaterGeometrySteps(previous?.data, { sea, geometry }, current);
        const surfaces = [sea, { positions: geometry.collarPositions, originX: geometry.originX, originZ: geometry.originZ }];
        const water = identical ? previous.data.water : Object.freeze([
            ...(yield* captureMappedWaterOpeningsSteps({ surfaces: [sea], replacementKey: 'mapped-sea',
                limits: GROUND_GENERATION_LIMITS.openings, isCurrent: current })),
            ...(yield* captureMappedWaterOpeningsSteps({ surfaces: [surfaces[1]], replacementKey: 'mapped-coast-ground',
                limits: GROUND_GENERATION_LIMITS.openings, isCurrent: current })),
        ]);
        const bounds = identical ? previous.data.bounds : yield* waterSurfaceBoundsSteps(surfaces);
        const coastBounds = identical ? previous.data.coastBounds : yield* waterSurfaceBoundsSteps([surfaces[1]]);
        data = Object.freeze({ source, terrainRevision: terrain.revision, sea, seaY, collar, infill, geometry, water, bounds, coastBounds,
            geometryIdentity: identical ? previous.data.geometryIdentity : Object.freeze({}) });
    }
    const mappedWater = Object.freeze({ signature: `${source?.coastline.features.length ? source.revision : 'empty'}:${data.seaY}`,
        contains: (x, z) => source?.coastline.contains(x, z) === true, sceneY: data.seaY });
    return Object.freeze({ entries: [], water: data.water, mappedWater, isCurrent: current, discard() {}, finalize: () => true,
        *prepareOpeningReceiversSteps({ openings }) {
            const signature = yield* waterOpeningSignatureSteps(openings, data.bounds, current);
            if (previous?.data.geometryIdentity === data.geometryIdentity && previous.signature === signature) {
                // A DTM revision away from the coast may change source reads
                // without changing one stored face. Advance input metadata,
                // preserving geometry, masks, civil registration and support.
                const entries = [], state = { ...previous, data };
                let committed = false;
                if (previous.data !== data) entries.push({
                    ticket: registry.begin({ key: 'ground:water-inputs', generation }), clear: true, isCurrent: current,
                    commit() { committed = true; applyWaterGroundState(state); return true; },
                    rollback() { if (committed) applyWaterGroundState(previous); committed = false; }, discard() {},
                });
                return Object.freeze({ entries, terrainReplacement: previous.replacement,
                    changedBounds: [], isCurrent: current, discard() {}, finalize() {
                        if (committed) notifyMappedSeaListeners({ groundPublished: true }); return true;
                    } });
            }
            let root = null, inputCoast = null, mask = null, ticket = null, fence = null, handedOff = false;
            let committed = false, finalized = false, discarded = false;
            const discard = () => {
                if (discarded || finalized) return; discarded = true;
                if (ticket?.state === 'pending') ticket.discard();
                const dispose = () => { if (root) disposeGroup(root); if (inputCoast) disposeGroup(inputCoast); mask?.dispose(); };
                if (fence) Promise.resolve(fence).then(dispose, dispose); else dispose();
            };
            try {
                const materials = [];
                const claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.WATER,
                    coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
                    ownerId: 'mapped-sea', sourceId: 'world/water.js', replacementKey: 'mapped-sea', generation, cutsBackstop: true });
                if (data.sea.triangleCount) {
                    root = new THREE.Group(); root.name = 'SeaWater';
                    if (data.sea.triangleCount) {
                        const geo = geometryFromCoastData(data.sea.positions, data.sea.normals);
                        applyWorldXZWaterUvs(geo, undefined, data.sea);
                        const material = createWaterMaterial({ profile: 'sea' }); materials.push(material);
                        applySurfaceStencil(material, claim); applyGroundOwnership(material, claim); applyPlannerSurfaceCutout(material, claim);
                        const sea = new THREE.Mesh(geo, material);
                        sea.position.set(data.sea.originX, 0, data.sea.originZ);
                        sea.name = 'SeaWaterSurface'; markSurfaceClaim(sea, claim); root.add(sea);
                    }
                }
                // Construction sees coastal ground before road/rail removal.
                // Its captured faces outlive this temporary, never-uploaded root.
                inputCoast = buildCoastDressingGroup(data.collar, data.seaY, { terrainInfill: data.infill,
                    geometryData: data.geometry, generation, replacementKey: 'mapped-coast-ground', exactFormationCutouts: true });
                const supportRead = yield* prepareWaterRootSteps(inputCoast, { openings, generation, isCurrent: current, prewarm: false });
                if (inputCoast) { disposeGroup(inputCoast); inputCoast = null; }
                yield* prepareWaterRootSteps(root, { openings, generation, isCurrent: current, onFence: value => { fence = value; } });
                const bounds = yield* waterSurfaceBoundsSteps(supportRead.surfaces);
                const dependency = Object.freeze({ entries: Object.freeze(bounds ? [{ signature: `water-ground-${generation}`, bounds }] : []) });
                const replacement = bounds ? Object.freeze({ id: 'mapped-coast-terrain-infill',
                    sampleSceneYAtLocal: supportRead.supportYAt, sampleEvidenceSceneYAtLocal: supportRead.supportYAt,
                    dependencySnapshot: () => dependency }) : null;
                const civil = ctx.civilGround.prepareTerrainReplacementPublication(replacement);
                if (data.source?.coastline.features.length) {
                    mask = buildMaskTexture(data.source.coastline, buildMappedCoastTerrainCutout(data.infill,
                        { innerOverlapM: COAST_TERRAIN_INNER_OVERLAP_M }), data.source.center.x, data.source.center.z);
                    renderer.initTexture(mask);
                    yield { phase: 'water-ground-mask-upload', deferFrame: true };
                }
                const state = { data, root, mask, maskCenter: data.source?.center, materials, claim,
                    replacement, replacementBounds: bounds, supportRead, signature };
                const oldRelease = releaseCoastTerrainReplacement;
                ticket = registry.begin({ key: 'mapped-sea', generation, parent: waterWorldGroup, retire: (_context, old) => disposeGroup(old) });
                const entry = { ticket, ...(root ? { root } : { clear: true }), isCurrent: () => current() && civil.isCurrent(),
                    commit() {
                        if (!civil.commit()) return false;
                        committed = true;
                        applyWaterGroundState(state); releaseCoastTerrainReplacement = civil.release;
                        if (root) root.userData.groundColliderState.published = true;
                        return true;
                    },
                    rollback() {
                        if (!committed) return;
                        if (root) root.userData.groundColliderState.published = false;
                        civil.rollback(); applyWaterGroundState(previous); releaseCoastTerrainReplacement = oldRelease; committed = false;
                    }, discard };
                handedOff = true;
                return Object.freeze({ entries: [entry], terrainReplacement: replacement,
                    changedBounds: [previous?.replacementBounds, bounds].filter(Boolean), isCurrent: current, discard,
                    finalize() {
                        if (!committed || finalized) return false;
                        finalized = true; previous?.mask?.dispose(); notifyMappedSeaListeners({ groundPublished: true }); return true;
                    } });
            } finally { if (!handedOff) discard(); }
        },
        *prepareRoadReceiversSteps({ roads, openings, centerX, centerZ }) {
            return yield* prepareUrbanWaterGroundSteps({ data, terrain, roads, openings, centerX, centerZ,
                registry, generation, isCurrent: current });
        },
        *prepareTerrainReceiversSteps({ cutoutLayers, openings }) {
            return yield* prepareCoastWaterGroundSteps({ data, cutoutLayers, openings, registry, generation, isCurrent: current });
        },
    });
}

function* prepareCoastWaterGroundSteps({ data, cutoutLayers, openings, registry, generation, isCurrent }) {
    const previous = activeCoastGround;
    const current = () => activeCoastGround === previous && isCurrent();
    const cuts = data.coastBounds ? (yield* prepareTerrainCutoutTilesSteps(cutoutLayers,
        [{ key: 'coast', bounds: data.coastBounds }], { tileM: 400,
            maxRegions: GROUND_GENERATION_LIMITS.cutout.limits.maxSources,
            maxVertices: GROUND_GENERATION_LIMITS.cutout.limits.maxSourceVertices })).get('coast') : { layers: [], signature: '' };
    const signature = cuts.signature + '|' + (yield* waterOpeningSignatureSteps(openings, data.coastBounds, current));
    if (previous?.geometryIdentity === data.geometryIdentity && previous.signature === signature) return Object.freeze({
        entries: [], supportRead: previous.supportRead, isCurrent: current, discard() {}, finalize: () => true });
    let root = null, ticket = null, fence = null, handedOff = false, committed = false, discarded = false, finalized = false;
    const discard = () => {
        if (discarded || finalized) return; discarded = true;
        if (ticket?.state === 'pending') ticket.discard();
        const dispose = () => { if (root) disposeGroup(root); };
        if (fence) Promise.resolve(fence).then(dispose, dispose); else dispose();
    };
    try {
        root = buildCoastDressingGroup(data.collar, data.seaY, { terrainInfill: data.infill,
            geometryData: data.geometry, generation, replacementKey: 'mapped-coast-ground', exactFormationCutouts: true });
        const mesh = root?.getObjectByName('SeaTerrainInfill');
        if (mesh && cuts.layers.length) {
            const topology = yield* createTerrainCutoutTopologySteps({ layers: cuts.layers,
                limits: GROUND_GENERATION_LIMITS.cutout.limits, isCurrent: current });
            const geometry = mesh.geometry;
            const clipped = yield* clipReceiverGeometrySteps({ geometry: { positions: geometry.attributes.position.array,
                normals: geometry.attributes.normal.array, uvs: geometry.attributes.uv?.array, indices: geometry.index?.array },
                topology, originX: data.geometry.originX, originZ: data.geometry.originZ,
                // Extended collar quads cross each other at bends by design; the
                // sampler picks the upper face, so the cut must not demand a seam.
                overlappingFaces: true,
                ...GROUND_GENERATION_LIMITS.openingSupport, isCurrent: current });
            if (clipped.topology.changedTriangles) {
                mesh.geometry = geometryFromCoastData(clipped.positions, clipped.normals, clipped.uvs);
                if (clipped.indices) mesh.geometry.setIndex(new THREE.BufferAttribute(clipped.indices, 1));
                geometry.dispose();
            }
        }
        const supportRead = yield* prepareWaterRootSteps(root, { openings, generation, isCurrent: current, onFence: value => { fence = value; } });
        const state = { root, supportRead, signature, geometryIdentity: data.geometryIdentity };
        ticket = registry.begin({ key: 'mapped-coast-ground', generation, parent: waterWorldGroup, retire: (_context, old) => disposeGroup(old) });
        const entry = { ticket, ...(root ? { root } : { clear: true }), isCurrent: current,
            commit() { committed = true; activeCoastGround = state; if (root) root.userData.groundColliderState.published = true; return true; },
            rollback() { if (!committed) return; if (root) root.userData.groundColliderState.published = false; activeCoastGround = previous; committed = false; }, discard };
        handedOff = true;
        return Object.freeze({ entries: [entry], supportRead, isCurrent: current, discard,
            finalize() { if (!committed || finalized) return false; finalized = true; return true; } });
    } finally { if (!handedOff) discard(); }
}

function* prepareUrbanWaterGroundSteps({ data, terrain, roads, openings, centerX, centerZ, registry, generation, isCurrent }) {
    const previous = activeUrbanGround, sections = [], radius = URBAN_COAST_RADIUS_M + URBAN_COAST_SEARCH_M;
    const bounds = { minX: centerX - radius, maxX: centerX + radius, minZ: centerZ - radius, maxZ: centerZ + radius };
    const quads = urbanCoastQuadsNear(data.collar, centerX, centerZ);
    if (quads.length) {
        const roadRead = yield* roads.captureRoadSurfaceReadSteps(bounds, isCurrent);
        if (!roadRead) waterGroundFailure('ground-dependency-busy', 'Coastal road receivers are unavailable');
        // Painted promenades have no road mesh; their landing is the paved terrain itself.
        const sampleRoadY = createUrbanCoastLandingSampler({ sampleRoadY: roadRead.supportYAt,
            pavedGroundAt: pedestrianZoneAtLocal, sampleTerrainY: terrain.evidenceSceneYAtLocal, liftM: COAST_SURFACE_LIFT_M });
        try {
            for (const quad of quads) {
                if (!isCurrent() || !roadRead.isCurrent()) waterGroundFailure('ground-generation-stale', 'Coastal road evidence expired');
                const section = resolveUrbanCoastSection(quad, { seaY: data.seaY,
                    sampleRoadY, sampleTerrainY: terrain.evidenceSceneYAtLocal });
                if (section) sections.push(section);
                yield { phase: 'water-urban-classification' };
            }
        } finally { roadRead.release(); }
    }
    const signature = JSON.stringify([data.seaY, sections]) + '|' + (yield* waterOpeningSignatureSteps(openings, bounds, isCurrent));
    const current = () => activeUrbanGround === previous && isCurrent();
    if (previous?.signature === signature) return Object.freeze({ entries: [], supportRead: previous.supportRead,
        isCurrent: current, discard() {}, finalize: () => true });
    let root = null, ticket = null, fence = null, handedOff = false, committed = false, discarded = false, finalized = false;
    const discard = () => {
        if (discarded || finalized) return; discarded = true;
        if (ticket?.state === 'pending') ticket.discard();
        const dispose = () => { if (root) disposeGroup(root); };
        if (fence) Promise.resolve(fence).then(dispose, dispose); else dispose();
    };
    const apply = state => {
        activeUrbanGround = state; urbanCoastGroup = state?.root || null;
        urbanCoastSceneYAtLocal = state?.supportRead.supportYAt || null;
    };
    try {
        root = buildUrbanCoastFormationGroup(sections, data.seaY, { generation, replacementKey: 'mapped-urban-coast',
            originX: centerX, originZ: centerZ });
        const supportRead = yield* prepareWaterRootSteps(root, { openings, generation, isCurrent: current, onFence: value => { fence = value; } });
        const state = { root, supportRead, signature };
        ticket = registry.begin({ key: 'mapped-urban-coast', generation, parent: waterWorldGroup, retire: (_context, old) => disposeGroup(old) });
        const entry = { ticket, ...(root ? { root } : { clear: true }), isCurrent: current,
            commit() { committed = true; apply(state); if (root) root.userData.groundColliderState.published = true; return true; },
            rollback() { if (!committed) return; if (root) root.userData.groundColliderState.published = false; apply(previous); committed = false; }, discard };
        handedOff = true;
        return Object.freeze({ entries: [entry], supportRead, isCurrent: current, discard,
            finalize() { if (!committed || finalized) return false; finalized = true; notifyUrbanCoastListeners(); return true; } });
    } finally { if (!handedOff) discard(); }
}

// Fetch water + pavement around (lat, lon) and rebuild mask, sea plane, and
// shoreline terrain. Serialized: a move during an in-flight refresh waits for the next
// onFrame past the distance gate.
function refresh(lat, lon) {
    const myToken = sessionToken;
    const publicationGeneration = ++waterPublicationGeneration;
    const publicationTicket = !waterGroundCoordinator && surfacePublications?.begin?.({
        key: 'mapped-sea',
        generation: publicationGeneration,
        parent: scene,
        retire: (_context, root) => disposeGroup(root),
    }) || null;
    activeWaterPublicationTicket = publicationTicket;
    refreshing = true;
    let stagedMaskTexture = null;
    const signal = fetchController && fetchController.signal;
    const dLat = FETCH_RADIUS_M / (DEG_TO_RAD * EARTH_RADIUS_M);
    const dLon = dLat / Math.cos(anchorLat * DEG_TO_RAD);
    const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(',');
    const opts = signal ? { signal } : {};
    const getJson = (url) => {
        const run = async () => {
            const response = await fetch(url, opts);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        };
        return typeof networkRequestScheduler?.scheduleNetworkRequest === 'function'
            ? networkRequestScheduler.scheduleNetworkRequest({
                label: 'water:coastline',
                groupKey: 'water',
                groupLimit: 1,
                priority: { tier: 'support', score: 4e12 },
                signal,
                run,
            })
            : run();
    };

    getJson(`${getApiBase()}/water?bbox=${bbox}`)
        .then((waterData) => {
            if (myToken !== sessionToken) {
                publicationTicket?.state === 'pending'
                    && publicationTicket.discard('water-session-stale');
                return;
            }
            const mappedFeatures = waterData.features || [];
            const seaFeatures = selectMappedSeaFeatures(mappedFeatures);
            const coastline = createMappedCoastline(collectPolygons(seaFeatures), {
                simplifyToleranceM: COASTLINE_SIMPLIFY_M,
            });
            const center = latLonToLocal(lat, lon);
            const seaY = mappedSeaSurfaceY;
            if (waterGroundCoordinator) {
                waterGroundSource = Object.freeze({ coastline, center: Object.freeze(center), seaY, revision: publicationGeneration });
                lastLat = lat; lastLon = lon;
                waterGroundCoordinator.invalidate('water', { reason: 'mapped-source' });
                return;
            }
            console.log(`[water] refresh @ ${lat.toFixed(5)},${lon.toFixed(5)}: `
                + `${seaFeatures.length}/${mappedFeatures.length} canonical sea features, `
                + `${coastline.features.length} polygons, `
                + `${COASTLINE_SIMPLIFY_M.toFixed(1)} m shoreline render tolerance`);

            if (coastline.features.length === 0) {
                const clearState = () => {
                    // Restore the opaque terrain backstop before retiring the
                    // sea that previously filled this opening.
                    coastDressingRevision += 1;
                    cancelCoastDressingBuild();
                    replaceGroundMask(null, center.x, center.z);
                    group = null;
                    pendingCoastDressing = null;
                    activeCoastDressing = null;
                    coastDressingGroup = null;
                    coastDressingDirty = false;
                    waterMaterials = [];
                    activeSeaClaim = null;
                    clearUrbanCoastFormation({ notify: true });
                    urbanCoastRefreshRequested = false;
                    clearCoastTerrainReplacement();
                    setActiveCoastline(null);
                };
                if (publicationTicket) publicationTicket.clear({ commit: clearState });
                else {
                    const previousGroup = group;
                    clearState();
                    if (previousGroup) disposeGroup(previousGroup);
                }
                lastLat = lat;
                lastLon = lon;
                return;
            }

            const nextGroup = new THREE.Group();
            nextGroup.name = 'SeaWater';
            markInspectionLayer(nextGroup, {
                id: 'sea-container',
                label: 'Sea renderer',
                category: 'Water',
                source: 'world/water.js · mapped coastline',
                order: 330,
                containerOnly: true,
            });
            const coastCollar = coastCollarNear(coastline, center.x, center.z);
            const terrainInfill = resolveCoastTerrainInfill(coastCollar, seaY);
            const terrainCutout = buildMappedCoastTerrainCutout(terrainInfill, {
                innerOverlapM: COAST_TERRAIN_INNER_OVERLAP_M,
            });
            const maskTexture = buildMaskTexture(
                coastline,
                terrainCutout,
                center.x,
                center.z,
            );
            stagedMaskTexture = maskTexture;

            // Sea surface: one plane under the whole mask extent, recentered
            // on the fetch center — it shows exactly through the mask holes.
            const seaGeo = new THREE.PlaneGeometry(SEA_PLANE_SIZE_M, SEA_PLANE_SIZE_M);
            seaGeo.rotateX(-Math.PI / 2);
            seaGeo.translate(center.x, 0, center.z);
            applyWorldXZWaterUvs(seaGeo);
            // The sea is deliberately one large plane beneath the streamed
            // terrain. Give it the same engineered-formation cutout as the
            // DTM; otherwise every road/rail excavation reveals blue water
            // even tens of metres inland.
            const seaClaim = compileSurfaceClaim({
                surfaceClass: SURFACE_CLASS.WATER,
                coverageState: SURFACE_COVERAGE_STATE.PUBLISHED,
                verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
                ownerId: 'mapped-sea',
                sourceId: 'world/water.js',
                replacementKey: 'mapped-sea',
                generation: publicationGeneration,
                cutsBackstop: true,
            });
            const seaMat = createWaterMaterial({ profile: 'sea' });
            applySurfaceStencil(seaMat, seaClaim);
            applyGroundWaterMask(seaMat, seaClaim);
            applyGroundOwnership(seaMat, seaClaim);
            applyPlannerSurfaceCutout(seaMat, seaClaim);
            const sea = new THREE.Mesh(seaGeo, seaMat);
            sea.name = 'SeaWaterSurface';
            markSurfaceClaim(sea, seaClaim);
            markInspectionLayer(sea, {
                id: 'sea-water',
                label: 'Sea surface',
                category: 'Water',
                source: 'world/water.js · recessed masked sea plane',
                order: 331,
            });
            sea.position.y = seaY;
            sea.receiveShadow = false;
            nextGroup.add(sea);

            const stagedCoastDressing = buildCoastDressingGroup(coastCollar, seaY, {
                replacementKey: 'mapped-sea',
                generation: publicationGeneration,
                terrainInfill,
            });
            if (stagedCoastDressing) nextGroup.add(stagedCoastDressing);

            // Publish replacement water and shoreline geometry before its mask
            // is allowed to remove terrain. The previous generation stays in
            // the scene until the complete new generation owns the opening.
            const commitPublication = () => {
                // The registry has already attached and selected nextGroup,
                // while the previous group is still present. Apply the only
                // fallible cross-layer operation before switching local state.
                coastDressingRevision += 1;
                cancelCoastDressingBuild();
                cancelUrbanCoastBuild();
                replaceGroundMask(maskTexture, center.x, center.z, seaClaim);
                stagedMaskTexture = null;
                group = nextGroup;
                publishedSeaPlane = Object.freeze({
                    centerX: center.x,
                    centerZ: center.z,
                    halfSizeM: MASK_HALF_SIZE_M,
                });
                urbanCoastGroup = null;
                urbanCoastSceneYAtLocal = null;
                waterMaterials = [seaMat];
                activeSeaClaim = seaClaim;
                coastDressingGroup = stagedCoastDressing;
                activeCoastDressing = stagedCoastDressing
                    ? {
                        collar: coastCollar,
                        seaY,
                        maskCenterX: center.x,
                        maskCenterZ: center.z,
                    }
                    : null;
                pendingCoastDressing = stagedCoastDressing
                    ? null
                    : {
                        collar: coastCollar,
                        seaY,
                        maskCenterX: center.x,
                        maskCenterZ: center.z,
                    };
                coastDressingDirty = false;
                publishCoastTerrainReplacement(stagedCoastDressing);
                setActiveCoastline(coastline);
                requestUrbanCoastRefresh(center.x, center.z);
            };
            if (publicationTicket) {
                const result = publicationTicket.publish(nextGroup, {
                    commit: commitPublication,
                });
                if (result.status !== 'published'
                    && result.status !== 'published-with-retirement-error') {
                    maskTexture.dispose();
                    stagedMaskTexture = null;
                    return;
                }
            } else {
                const previousGroup = group;
                scene.add(nextGroup);
                commitPublication();
                if (previousGroup && previousGroup !== nextGroup) disposeGroup(previousGroup);
            }
            lastLat = lat;
            lastLon = lon;
        })
        .catch((err) => {
            stagedMaskTexture?.dispose?.();
            stagedMaskTexture = null;
            if (publicationTicket?.state === 'pending') {
                publicationTicket.discard(err?.name === 'AbortError'
                    ? 'water-fetch-aborted'
                    : 'water-fetch-failed');
            }
            if (err && err.name === 'AbortError') return;
            console.warn('[water] failed to load water polygons:', err);
        })
        .finally(() => {
            if (activeWaterPublicationTicket === publicationTicket) {
                activeWaterPublicationTicket = null;
            }
            if (publicationGeneration === waterPublicationGeneration) refreshing = false;
        });
}

export function getWaterGroupForWalkColliders() {
    return waterWorldGroup || group;
}

export const waterLayer = {
    beginSession(ctx) {
        const {
        anchorLat: lat,
        anchorLon: lon,
        fetchController: ctrl,
        sharedTileSession,
        initialPose,
        terrain,
        civilGround,
        surfacePublications: publicationRegistry,
        } = ctx;
        waterGroundContext = ctx;
        waterGroundCoordinator = ctx.groundCoordinator || null;
        waterGroundSource = null; activeWaterGround = null; activeUrbanGround = null;
        activeCoastGround = null;
        waterWorldGroup = waterGroundCoordinator ? new THREE.Group() : null;
        if (waterWorldGroup) { waterWorldGroup.name = 'MappedWaterWorld'; scene.add(waterWorldGroup); }
        requestedUrbanGroundCenter = null;
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        coastDressingRevision += 1;
        cancelCoastDressingBuild();
        coastDressingQueue.clear();
        resetActiveCoastline();
        sessionToken++;
        urbanCoastGroup = null;
        urbanCoastBuild = null;
        urbanCoastSceneYAtLocal = null;
        urbanCoastGeneration = 0;
        urbanCoastCenterX = null;
        urbanCoastCenterZ = null;
        observedUrbanRoadRevision = null;
        appliedUrbanRoadRevision = null;
        urbanRoadRevisionChangedAtMs = 0;
        urbanCoastRefreshRequested = false;
        surfacePublications = publicationRegistry || null;
        activeWaterPublicationTicket = null;
        activeSeaClaim = null;
        publishedSeaPlane = null;
        civilGroundReference = civilGround || null;
        clearCoastTerrainReplacement();
        coastTerrainReplacementRevision = 0;
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            if (waterGroundCoordinator) return;
            if (!pendingCoastDressing && !activeCoastDressing) return;
            coastDressingRevision += 1;
            coastDressingDirty = true;
            cancelCoastDressingBuild();
            urbanCoastRefreshRequested = true;
            cancelUrbanCoastBuild();
        }) || null;
        mappedSeaSurfaceY = resolveMappedSeaSurfaceY(terrainReference);
        fetchController = ctrl;
        networkRequestScheduler = sharedTileSession || null;
        lastLat = null;
        lastLon = null;
        const startLat = (initialPose && initialPose.lat) ?? lat;
        const startLon = (initialPose && initialPose.lon) ?? lon;
        refresh(startLat, startLon);
    },
    onFrame(pose, local) {
        if (waterMaterials.length > 0) {
            animateWaterMaterials(waterMaterials, (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
        }
        if (!waterGroundCoordinator && coastDressingDirty && (pendingCoastDressing || activeCoastDressing)) {
            const pending = pendingCoastDressing || activeCoastDressing;
            scheduleCoastDressingBuild(
                pending.collar,
                pending.seaY,
                pending.maskCenterX,
                pending.maskCenterZ,
            );
        }
        if (waterGroundCoordinator && waterGroundSource?.coastline.features.length && local
            && (!requestedUrbanGroundCenter || Math.hypot(local.x - requestedUrbanGroundCenter.x,
                local.z - requestedUrbanGroundCenter.z) >= URBAN_COAST_REFRESH_MOVE_M)) {
            requestedUrbanGroundCenter = { x: local.x, z: local.z };
            waterGroundCoordinator.invalidate('water', { reason: 'urban-coast-window' });
        } else if (!waterGroundCoordinator) updateUrbanCoastFormation(local);
        if (!pose || refreshing || lastLat == null || anchorLat == null) return;
        const target = vehicleSurfaceStreamingGeoTarget({ pose, anchorLon, anchorLat });
        if (!target || haversineMeters(target.lat, target.lon, lastLat, lastLon) < REFRESH_MOVE_M) return;
        refresh(target.lat, target.lon);
    },
    endSession() {
        const managedUrbanRoot = activeUrbanGround?.root;
        const managedCoastRoot = activeCoastGround?.root;
        waterGroundContext = null; waterGroundCoordinator = null; waterGroundSource = null;
        activeWaterGround = null; activeUrbanGround = null; requestedUrbanGroundCenter = null;
        activeCoastGround = null;
        if (terrainUnsubscribe) terrainUnsubscribe();
        terrainUnsubscribe = null;
        sessionToken++;
        coastDressingRevision += 1;
        cancelCoastDressingBuild();
        cancelUrbanCoastBuild();
        coastDressingQueue.clear();
        if (activeWaterPublicationTicket?.state === 'pending') {
            activeWaterPublicationTicket.discard('water-layer-ended');
        }
        activeWaterPublicationTicket = null;
        refreshing = false;
        publishedSeaPlane = null;
        replaceGroundMask(null, 0, 0);
        if (group) {
            if (!surfacePublications?.retire?.('mapped-sea', {
                root: group,
                reason: 'water-layer-ended',
            })) disposeGroup(group);
            group = null;
        }
        if (managedUrbanRoot) {
            if (!surfacePublications?.retire?.('mapped-urban-coast', { root: managedUrbanRoot,
                reason: 'water-layer-ended' })) disposeGroup(managedUrbanRoot);
        }
        if (managedCoastRoot) {
            if (!surfacePublications?.retire?.('mapped-coast-ground', { root: managedCoastRoot,
                reason: 'water-layer-ended' })) disposeGroup(managedCoastRoot);
        }
        waterWorldGroup?.removeFromParent(); waterWorldGroup = null;
        waterMaterials = [];
        activeSeaClaim = null;
        clearCoastTerrainReplacement();
        civilGroundReference = null;
        pendingCoastDressing = null;
        activeCoastDressing = null;
        coastDressingGroup = null;
        coastDressingDirty = false;
        urbanCoastGroup = null;
        urbanCoastBuild = null;
        urbanCoastSceneYAtLocal = null;
        urbanCoastGeneration = 0;
        urbanCoastCenterX = null;
        urbanCoastCenterZ = null;
        observedUrbanRoadRevision = null;
        appliedUrbanRoadRevision = null;
        urbanRoadRevisionChangedAtMs = 0;
        urbanCoastRefreshRequested = false;
        resetActiveCoastline();
        anchorLat = null;
        anchorLon = null;
        fetchController = null;
        networkRequestScheduler = null;
        lastLat = null;
        lastLon = null;
        terrainReference = null;
        mappedSeaSurfaceY = SEA_Y;
        surfacePublications = null;
    },
    groundReady: () => !!waterGroundContext,
    manageGroundPublications(coordinator) { waterGroundCoordinator = coordinator; },
    prepareOpeningGroundSteps: prepareWaterGroundSteps,
};
