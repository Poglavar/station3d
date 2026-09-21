// Detects roads that enter block interiors and cuts simple archway passages
// through the solid GDI building masses so courtyard driveways don't dead-end.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createBoundsGrid } from '../core/bounds-grid.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';
import { registerShared, unregisterShared } from '../core/dispose.js';
import { getApiBase } from '../core/api.js';
import { buildingTileSourceForLocation } from '../core/locations.js';
import {
    DETAILED_BUILDING_STREAM_OPTIONS,
    DETAILED_BUILDING_TILE_M,
    NEAR_ROAD_STREAM_OPTIONS,
    tileIndex,
} from '../core/tile-stream.js';
import { scene } from '../scene/setup.js';
import { setBuildingPassageVolumes, setAllBuildingPassageCutVolumes } from './buildings.js';
import { makeFaceAccumulator, recoverFaces, extractOuterFootprintRing } from './building-facade.js';
import {
    pointInRing,
    linePolygonIntersections,
    intersectLongitudinalIntervals,
    passageWallIntervals,
    pairCeilingSpans,
    passageCutBand,
    trackCutPatchBand,
    PASSAGE_HEIGHT_M,
    MAX_FACADE_SKEW_M,
    TRUSTED_RING_MAX_SKEW_M,
    supportsGeneratedCourtyardPassages,
} from './passage-geometry.js';
import { getTerrainReference } from './terrain.js';
import {
    getLegacyBuildingCarve,
    isFeatureDemolishedByProposalTrack,
    proposalsReady,
} from './proposals.js';
import { isSceneNight } from '../scene/sky.js';
import { buildPlannerStationClearanceVolumes } from './planner-station-layout.js';
import {
    buildTrackCorridorVolumes,
    ELEVATED_GUIDEWAY_DECK_THICKNESS_M,
    isPlannerElevatedSegment,
    isPlannerSurfaceLevelSegment,
    isPlannerUndergroundRampSegment,
    PLANNER_OPEN_CUT_HALF_WIDTH_M,
} from './track-corridors.js';

// Stored-passage cap. We can keep up to this many passage candidates
// detected from tile-streamed buildings + roads. Per frame, only the
// VISIBLE_PASSAGES closest to the cab are pushed into the shader's
// uniform array (cap defined in buildings.js as MAX_PASSAGE_VOLUMES).
// So the player always sees the nearest cutouts regardless of which
// order the cadastre tiles arrived.
const MAX_PASSAGES = 200;
const VISIBLE_PASSAGES = 24;
const WALL_THICKNESS_M = 0.20;
const LINTEL_THICKNESS_M = 0.22;
// How far past each facade the shader cut must reach. OSM service roads are
// often split AT the facade or mapped only partway into the block, so the
// road polygon's own extent can end mid-building — cutting the street facade
// open while leaving the courtyard facade intact (a passage that "stops
// short"). Every accepted passage therefore extends its road's cut volume to
// cover the full facade-to-facade span plus this overhang.
const PASSAGE_CUT_END_OVERHANG_M = 0.8;
const CUSTOM_CUT_END_OVERHANG_M = 0.35;
const CUSTOM_CUT_MIN_PATCH_HEIGHT_M = 0.6;
const CUSTOM_CUT_MIN_DEPTH_M = 0.25;
// Half-height of a planner "remove the whole building volume" cut. Tall enough
// that no building escapes it above, and — since the surface and ramp cuts are
// centred on the anchor plane rather than resting on it — deep enough that none
// escapes below either, however far the DGU terrain drops away from the anchor.
// Doubled from 120 alongside that recentring so no cut's reach ever narrowed:
// every band still spans at least the ±240 m it used to reach upward.
const OPEN_CUT_HALF_HEIGHT_M = 240;
const ELEVATED_CUT_BELOW_TRACK_M = ELEVATED_GUIDEWAY_DECK_THICKNESS_M + 0.3;
const ALLOWED_HIGHWAY_TYPES = new Set([
    'service',
    'living_street',
    'residential',
    'unclassified',
    'pedestrian',
]);

// Optional diagnostic: building object_ids whose passage-detection failures
// should be logged in detail. Per-rejection lines for each (building,
// road) pair tested against the target. Also logs when the building
// gets loaded and how many overlapping roads exist.
//   To debug a different building from devtools without editing:
//     window.__passageDebugIds = new Set(['60956'])
const PASSAGE_DEBUG_BUILDING_IDS = new Set();
function isPassageDebugBuilding(id) {
    if (PASSAGE_DEBUG_BUILDING_IDS.has(id)) return true;
    if (typeof window !== 'undefined' && window.__passageDebugIds instanceof Set) {
        return window.__passageDebugIds.has(String(id));
    }
    return false;
}
function passageDbg(buildingId, roadId, reason, detail) {
    if (!isPassageDebugBuilding(buildingId)) return;
    // Flatten `detail` into a string so the values are visible in
    // copy-pasted console logs (devtools collapses the 4th arg by default).
    let line = '[passage-debug] ' + buildingId + ' road=' + roadId + ' ' + reason;
    if (detail !== undefined) {
        try { line += ' ' + JSON.stringify(detail); } catch (_) { line += ' [unstringifiable]'; }
    }
    console.log(line);
}

// True if EITHER the user has set a debug-building ID OR an explicit road
// watchlist via `window.__passageDebugRoadIds = new Set(['1266577504'])`.
// Used to gate verbose road-sample logging in extractRoadSamples.
function isAnyPassageDebugActive() {
    if (PASSAGE_DEBUG_BUILDING_IDS.size > 0) return true;
    if (typeof window === 'undefined') return false;
    if (window.__passageDebugIds instanceof Set && window.__passageDebugIds.size > 0) return true;
    if (window.__passageDebugRoadIds instanceof Set && window.__passageDebugRoadIds.size > 0) return true;
    return false;
}
function isWatchedRoadOsmId(osmId) {
    if (typeof window === 'undefined') return false;
    if (!(window.__passageDebugRoadIds instanceof Set)) return false;
    return window.__passageDebugRoadIds.has(String(osmId));
}

let anchorLat = 0;
let anchorLon = 0;
let passagesGroup = null;
let passageMaterial = null;
let customTrackPatchMaterial = null;
let roadTileSource = null;
let buildingTileSource = null;
let roadSubscription = null;
let buildingSubscription = null;
let roadSamplesByTile = new Map();
let buildingSamplesByTile = new Map();
// Vehicle collision is queried for every moving traffic car. Keep the exact
// building rings, but narrow each 100 m tile to the handful whose AABBs touch
// the chassis instead of rescanning every building in nine tiles per sample.
let vehicleBuildingGridsByTile = new Map();
let tilePassages = new Map();
let passageById = new Map();
let loadedRoadIds = new Set();
let loadedBuildingIds = new Set();
let tileRoadIds = new Map();
let tileBuildingIds = new Map();
// Per-road OBB registry. The shader-discard volume is a property of the
// ROAD, not of any (building, road) pair — so split OSM segments and
// adjacent-building duplicates can no longer produce overlapping cutouts.
// heights maps each referencing (building, road) passage id to its arch
// height; the OBB's cut height follows the minimum and the OBB unregisters
// when the last entry is removed (tile eviction).
let roadOBBs = new Map();           // roadId → { obb, heights: Map<passageId, archHeight> }
// Bumped whenever cut GEOMETRY changes (passage volume added/removed/resized).
// buildings.js watches it to re-mask facades painted before a passage arrived.
let cutVolumesRevision = 0;
let customTrackOpenCutOBBs = [];
let customTrackPatchById = new Map();
let customTrackPatchIdsByTile = new Map();
// Player position in local scene coords (X, Z). Updated each onFrame so
// syncBuildingPassageVolumes can pick the closest VISIBLE_PASSAGES.
let playerLocalX = 0;
let playerLocalZ = 0;
let lastSyncedPlayerX = Infinity;
let lastSyncedPlayerZ = Infinity;
const RESYNC_DISTANCE_M = 5;        // re-pick top-N when player moves this far

// Debug handle: dump live passage state from devtools (volumes, wall spans,
// road OBBs, tile counts). Companion to window.__passageDebugIds — this is
// how a reported broken passage gets diagnosed numerically in the field.
if (typeof window !== 'undefined') {
    window.__passageDump = () => ({
        passages: Array.from(passageById.entries()).map(([id, e]) => ({ id, volume: e.volume })),
        roadOBBs: Array.from(roadOBBs.entries()).map(([id, e]) => ({
            id, obb: e.obb, requirements: Array.from(e.passages.values()),
        })),
        player: { x: playerLocalX, z: playerLocalZ },
        anchor: { lat: anchorLat, lon: anchorLon },
        tiles: {
            roadTiles: roadSamplesByTile.size,
            buildingTiles: buildingSamplesByTile.size,
            roadSamples: Array.from(roadSamplesByTile.values()).reduce((s, a) => s + a.length, 0),
            buildingSamples: Array.from(buildingSamplesByTile.values()).reduce((s, a) => s + a.length, 0),
        },
    });
}

function ensurePassagesGroup() {
    if (passagesGroup) return passagesGroup;
    passagesGroup = new THREE.Group();
    passagesGroup.name = 'CourtyardPassages';
    scene.add(passagesGroup);
    return passagesGroup;
}

function getPassageMaterial() {
    if (passageMaterial) return passageMaterial;
    passageMaterial = new THREE.MeshStandardMaterial({
        color: 0x544c41,
        roughness: 0.94,
        metalness: 0.02,
        side: THREE.DoubleSide,
    });
    registerShared(passageMaterial);
    return passageMaterial;
}

// Faint warm glow on passage walls at night: real Zagreb passages keep a
// bulb burning. Without it the unlit tunnel and the flat unlit facade seen
// through the far arch fuse into one dark mass that reads as a walled-up
// passage. Uniform-only change — no shader recompile.
let passageMaterialIsNight = null;
function syncPassageMaterialNight() {
    if (!passageMaterial) return;
    const night = isSceneNight();
    if (night === passageMaterialIsNight) return;
    passageMaterialIsNight = night;
    passageMaterial.emissive.setHex(night ? 0x40301a : 0x000000);
}

function getCustomTrackPatchMaterial() {
    if (customTrackPatchMaterial) return customTrackPatchMaterial;
    customTrackPatchMaterial = new THREE.MeshStandardMaterial({
        color: 0x88847d,
        roughness: 0.96,
        metalness: 0,
        side: THREE.DoubleSide,
    });
    registerShared(customTrackPatchMaterial);
    return customTrackPatchMaterial;
}

function trimmedRing(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return [];
    if (ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]) {
        return ring.slice(0, -1);
    }
    return ring.slice();
}

function toLocalRingXZ(ring) {
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    return trimmedRing(ring).map(([lon, lat]) => ({
        x: (lon - anchorLon) * scaleLon,
        z: -(lat - anchorLat) * scaleLat,
    }));
}

function ringBounds(ring) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, minZ, maxX, maxZ };
}

function boxesOverlap(a, b, margin = 0) {
    return !(a.maxX < b.minX - margin ||
        a.minX > b.maxX + margin ||
        a.maxZ < b.minZ - margin ||
        a.minZ > b.maxZ + margin);
}

function pointInsidePassageXZ(x, z) {
    // Accepted road OBBs span the full mapped road, matching the same volumes
    // used to cut visible building geometry. This keeps the driveable corridor
    // open after a car exits an arch into a courtyard instead of treating the
    // outer footprint hull as solid courtyard floor.
    for (const entry of roadOBBs.values()) {
        const v = entry && entry.obb;
        if (!v) continue;
        const dx = x - v.centerX;
        const dz = z - v.centerZ;
        const localRight = dx * v.rightX + dz * v.rightZ;
        const localAlong = dx * v.alongX + dz * v.alongZ;
        if (Math.abs(localRight) <= v.halfWidth && Math.abs(localAlong) <= v.halfDepth) return true;
    }
    return false;
}

function segmentIntersectionPoint(a, b, c, d) {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const cdx = d.x - c.x;
    const cdz = d.z - c.z;
    const denom = abx * cdz - abz * cdx;
    if (Math.abs(denom) < 1e-8) return null;
    const acx = c.x - a.x;
    const acz = c.z - a.z;
    const t = (acx * cdz - acz * cdx) / denom;
    const u = (acx * abz - acz * abx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a.x + abx * t, z: a.z + abz * t };
}

// Exact 2D overlap between an oriented vehicle rectangle and one building
// footprint ring. Passage points are exempt so legitimate courtyard arches
// remain driveable while walls stay solid.
export function orientedVehicleIntersectsBuildingRing(
    x,
    z,
    heading,
    halfWidth,
    halfLength,
    ring,
    isPassagePoint = () => false,
) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    const forward = { x: sin, z: cos };
    const right = { x: cos, z: -sin };
    const corner = (rightScale, forwardScale) => ({
        x: x + right.x * rightScale + forward.x * forwardScale,
        z: z + right.z * rightScale + forward.z * forwardScale,
    });
    const corners = [
        corner(-halfWidth, -halfLength),
        corner(halfWidth, -halfLength),
        corner(halfWidth, halfLength),
        corner(-halfWidth, halfLength),
    ];
    const samples = [{ x, z }, ...corners];
    for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        samples.push({ x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
    }
    for (const p of samples) {
        if (pointInRing(p.x, p.z, ring) && !isPassagePoint(p.x, p.z)) return true;
    }

    const pointInsideVehicle = (p) => {
        const dx = p.x - x;
        const dz = p.z - z;
        const localRight = dx * right.x + dz * right.z;
        const localForward = dx * forward.x + dz * forward.z;
        return Math.abs(localRight) <= halfWidth && Math.abs(localForward) <= halfLength;
    };
    for (const p of ring) {
        if (pointInsideVehicle(p) && !isPassagePoint(p.x, p.z)) return true;
    }

    for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        for (let j = 0; j < ring.length; j++) {
            const hit = segmentIntersectionPoint(a, b, ring[j], ring[(j + 1) % ring.length]);
            if (hit && !isPassagePoint(hit.x, hit.z)) return true;
        }
    }
    return false;
}

export function vehicleFootprintIntersectsLoadedBuilding(x, z, heading, halfWidth, halfLength) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(heading)) return false;
    const tx = tileIndex(x, DETAILED_BUILDING_TILE_M);
    const tz = tileIndex(z, DETAILED_BUILDING_TILE_M);
    const radius = Math.hypot(halfWidth, halfLength);
    const vehicleBounds = {
        minX: x - radius,
        maxX: x + radius,
        minZ: z - radius,
        maxZ: z + radius,
    };
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            const grid = vehicleBuildingGridsByTile.get(`${tx + dx}_${tz + dz}`);
            if (!grid) continue;
            const buildings = grid.candidatesInBox(
                vehicleBounds.minX,
                vehicleBounds.minZ,
                vehicleBounds.maxX,
                vehicleBounds.maxZ,
            );
            for (const building of buildings) {
                if (!building || !boxesOverlap(vehicleBounds, building.bbox)) continue;
                if (orientedVehicleIntersectsBuildingRing(
                    x,
                    z,
                    heading,
                    halfWidth,
                    halfLength,
                    building.ring,
                    pointInsidePassageXZ,
                )) return true;
            }
        }
    }
    return false;
}

export function vehicleSweepIntersectsLoadedBuilding(
    x0,
    z0,
    x1,
    z1,
    heading,
    halfWidth,
    halfLength,
) {
    const distance = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(distance / 0.75));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        if (vehicleFootprintIntersectsLoadedBuilding(x, z, heading, halfWidth, halfLength)) return true;
    }
    return false;
}

function averagePoint(points) {
    let sx = 0;
    let sz = 0;
    for (const p of points) {
        sx += p.x;
        sz += p.z;
    }
    const inv = points.length > 0 ? 1 / points.length : 0;
    return { x: sx * inv, z: sz * inv };
}

function principalAxis(ring) {
    if (!ring || ring.length < 3) return null;
    const c = averagePoint(ring);
    let xx = 0;
    let zz = 0;
    let xz = 0;
    for (const p of ring) {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        xx += dx * dx;
        zz += dz * dz;
        xz += dx * dz;
    }
    const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
    const alongX = Math.cos(angle);
    const alongZ = Math.sin(angle);
    const rightX = -alongZ;
    const rightZ = alongX;
    let minAlong = Infinity, maxAlong = -Infinity, minRight = Infinity, maxRight = -Infinity;
    for (const p of ring) {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const along = dx * alongX + dz * alongZ;
        const right = dx * rightX + dz * rightZ;
        if (along < minAlong) minAlong = along;
        if (along > maxAlong) maxAlong = along;
        if (right < minRight) minRight = right;
        if (right > maxRight) maxRight = right;
    }
    return {
        center: c,
        alongX,
        alongZ,
        rightX,
        rightZ,
        length: maxAlong - minAlong,
        width: maxRight - minRight,
    };
}

function recordTileId(map, tileKey, id) {
    if (tileKey == null || id == null) return;
    let set = map.get(tileKey);
    if (!set) {
        set = new Set();
        map.set(tileKey, set);
    }
    set.add(id);
}

function extractRoadSamples(features, tileKey) {
    const debugAny = isAnyPassageDebugActive();
    const samples = [];
    for (const feature of features || []) {
        const props = feature.properties || {};
        const osmId = props.osm_id != null ? String(props.osm_id) : null;
        const watch = osmId && isWatchedRoadOsmId(osmId);
        if (props.railway_type) {
            if (watch || (debugAny && osmId)) {
                console.log('[passage-debug-road] reject railway', { osmId, railway_type: props.railway_type });
            }
            continue;
        }
        if (!ALLOWED_HIGHWAY_TYPES.has(props.highway_type)) {
            if (watch || (debugAny && osmId)) {
                console.log('[passage-debug-road] reject highway_type', { osmId, highway_type: props.highway_type });
            }
            continue;
        }
        const geom = feature.geometry;
        if (!geom) {
            if (watch) console.log('[passage-debug-road] reject: feature has no geometry', { osmId });
            continue;
        }
        const rings = geom.type === 'Polygon' ? [geom.coordinates[0]]
            : geom.type === 'MultiPolygon' ? geom.coordinates.map((poly) => poly[0])
                : [];
        if (rings.length === 0 && watch) {
            console.log('[passage-debug-road] reject: geometry not Polygon/MultiPolygon', { osmId, type: geom.type });
        }
        const baseId = osmId != null ? osmId : `${tileKey}:road`;
        for (let i = 0; i < rings.length; i++) {
            const roadId = `${baseId}:${i}`;
            if (loadedRoadIds.has(roadId)) continue;
            const ring = toLocalRingXZ(rings[i]);
            if (ring.length < 4) {
                if (watch) console.log('[passage-debug-road] reject: ring too short', { roadId, ringLen: ring.length });
                continue;
            }
            const axis = principalAxis(ring);
            if (!axis) {
                if (watch) console.log('[passage-debug-road] reject: principalAxis returned null', { roadId });
                continue;
            }
            if (axis.length < 6 || axis.width < 2.4 || axis.width > 12) {
                if (watch) {
                    console.log('[passage-debug-road] reject: length/width filter',
                        { roadId, length: axis.length.toFixed(2), width: axis.width.toFixed(2),
                          required: 'length≥6, 2.4≤width≤12' });
                }
                continue;
            }
            if (axis.length < axis.width * 1.35) {
                if (watch) {
                    console.log('[passage-debug-road] reject: aspect ratio',
                        { roadId, length: axis.length.toFixed(2), width: axis.width.toFixed(2),
                          required: 'length ≥ width × 1.35' });
                }
                continue;
            }
            if (watch) {
                const bb = ringBounds(ring);
                console.log('[passage-debug-road] ACCEPTED ' + roadId +
                    ' length=' + axis.length.toFixed(2) + ' width=' + axis.width.toFixed(2) +
                    ' bbox=x[' + bb.minX.toFixed(1) + ',' + bb.maxX.toFixed(1) + ']' +
                    ' z[' + bb.minZ.toFixed(1) + ',' + bb.maxZ.toFixed(1) + ']');
            }
            loadedRoadIds.add(roadId);
            recordTileId(tileRoadIds, tileKey, roadId);
            // Precomputed road OBB: this is the volume the shader will use
            // to discard wall fragments anywhere the road runs. Centred at
            // the road's centroid, oriented to its principal axis, halfDepth
            // = full road length / 2 so the OBB covers the road end-to-end.
            // halfHeight = PASSAGE_HEIGHT_M / 2 (a bit below ground to a bit
            // above, so all wall+roof fragments at street-passage height get
            // discarded). halfWidth = road's width / 2 + small slack.
            const roadObb = {
                centerX: axis.center.x,
                centerY: PASSAGE_HEIGHT_M / 2,
                centerZ: axis.center.z,
                alongX: axis.alongX,
                alongZ: axis.alongZ,
                rightX: axis.rightX,
                rightZ: axis.rightZ,
                halfWidth: Math.min(axis.width * 0.5 + 0.2, 5.5),
                halfHeight: PASSAGE_HEIGHT_M / 2,
                halfDepth: axis.length * 0.5,
            };
            samples.push({
                roadId,
                tileKey,
                ring,
                bbox: ringBounds(ring),
                alongX: axis.alongX,
                alongZ: axis.alongZ,
                rightX: axis.rightX,
                rightZ: axis.rightZ,
                width: axis.width,
                obb: roadObb,
            });
        }
    }
    return samples;
}

// Andrew's monotone-chain 2D convex hull. Used as a fallback ring when
// extractOuterFootprintRing returns a fragmented sub-loop (passage in
// the building breaks the outer-perimeter graph). Hull always covers the
// true building extent, so passage detection sees roads correctly even
// when the recovered ring is broken.
function convexHullXZ(points) {
    const n = points.length;
    if (n < 3) return points.slice();
    const sorted = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

// Scene-Y floor of one building, matching how buildings.js places it: a
// MultiPolygon survey mesh is authored base-at-0 and lifted by its surveyed
// absolute base (z_min, EVRF2000 like the DGU terrain) whenever the DGU
// surface is active. 0 in the flat model world, where no lift happens.
function buildingBaseSceneY(zMinM) {
    const terrain = getTerrainReference();
    if (!terrain || typeof terrain.absoluteToSceneY !== 'function') return 0;
    const zMin = Number(zMinM);
    if (!Number.isFinite(zMin)) return 0;
    const baseY = Number(terrain.absoluteToSceneY(zMin));
    return Number.isFinite(baseY) ? baseY : 0;
}

function extractBuildingFootprint(feature) {
    const geom = feature.geometry;
    const zMin = (feature.properties && feature.properties.z_min) || 0;
    if (!geom || geom.type !== 'MultiPolygon') return null;
    const scaleLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(anchorLat * DEG_TO_RAD);
    const scaleLat = DEG_TO_RAD * EARTH_RADIUS_M;
    const faceAccum = makeFaceAccumulator();
    let maxY = 0;
    // Collect every ground-level wall vertex (y < 0.5 m) so we can compute
    // a robust bbox + convex-hull fallback ring. Buildings with passages
    // cut through them produce fragmented outer-perimeter graphs that the
    // loop walker can mis-thread; the hull is correct in all cases.
    const groundWallVerts = [];
    for (const polygonCoords of geom.coordinates) {
        const rawRing = polygonCoords[0];
        const pts = trimmedRing(rawRing);
        if (pts.length < 3) continue;
        const verts = pts.map(([lon, lat, z]) => {
            const y = (z != null ? z : zMin) - zMin;
            if (y > maxY) maxY = y;
            return [
                (lon - anchorLon) * scaleLon,
                y,
                -(lat - anchorLat) * scaleLat,
            ];
        });
        const v0 = verts[0];
        for (let i = 1; i < verts.length - 1; i++) {
            const v1 = verts[i];
            const v2 = verts[i + 1];
            const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
            const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
            const cnx = e1y * e2z - e1z * e2y;
            const cny = e1z * e2x - e1x * e2z;
            const cnz = e1x * e2y - e1y * e2x;
            const cnLen = Math.hypot(cnx, cny, cnz);
            if (cnLen < 1e-6) continue;
            if (Math.abs(cny) / cnLen > 0.5) continue;
            faceAccum.push(v0, v1, v2);
        }
        for (const v of verts) {
            if (v[1] < 0.5) groundWallVerts.push({ x: v[0], z: v[2] });
        }
    }
    if (groundWallVerts.length < 3) return null;

    // Robust bbox = AABB of all ground-level wall verts. This is the
    // building's true spatial extent regardless of how messy the wall
    // graph topology is.
    let bbMinX = Infinity, bbMaxX = -Infinity, bbMinZ = Infinity, bbMaxZ = -Infinity;
    for (const p of groundWallVerts) {
        if (p.x < bbMinX) bbMinX = p.x;
        if (p.x > bbMaxX) bbMaxX = p.x;
        if (p.z < bbMinZ) bbMinZ = p.z;
        if (p.z > bbMaxZ) bbMaxZ = p.z;
    }
    const trueBbox = { minX: bbMinX, maxX: bbMaxX, minZ: bbMinZ, maxZ: bbMaxZ };
    const trueSpanX = bbMaxX - bbMinX;
    const trueSpanZ = bbMaxZ - bbMinZ;

    const faces = recoverFaces(faceAccum.faces());
    const outerRing = extractOuterFootprintRing(faces);
    let ring;
    let usedFallback = false;
    if (outerRing && Array.isArray(outerRing.verts) && outerRing.verts.length >= 3) {
        const rb = ringBounds(outerRing.verts);
        const ringSpanX = rb.maxX - rb.minX;
        const ringSpanZ = rb.maxZ - rb.minZ;
        // If the recovered ring covers <70% of the true bbox in either
        // axis, the loop walker took a wrong turn (likely passage-induced
        // graph fragmentation). Fall back to convex hull of all wall verts.
        if (trueSpanX > 0 && ringSpanX < trueSpanX * 0.7 ||
            trueSpanZ > 0 && ringSpanZ < trueSpanZ * 0.7) {
            ring = convexHullXZ(groundWallVerts);
            usedFallback = true;
        } else {
            ring = outerRing.verts;
        }
    } else {
        ring = convexHullXZ(groundWallVerts);
        usedFallback = true;
    }
    if (!ring || ring.length < 3) return null;
    return {
        ring,
        bbox: trueBbox,
        // Local, i.e. measured from this building's own base — never mix it
        // with a scene-Y without adding baseSceneY first.
        topY: maxY,
        baseSceneY: buildingBaseSceneY(zMin),
        usedHullFallback: usedFallback,
    };
}

// A building the loaded proposals REMOVE has no walls left for a passage to be
// cut through, so an arch detected in it survives as a free-standing gate in
// open ground — building 35372 at Divulje, whose only remaining geometry is a
// demolition ghost. The passage layer streams the raw, uncarved features on its
// own subscription, so it has to ask the same two questions buildings.js asks
// before it draws anything: does the proposal track take this building, and did
// a legacy road carve raze it.
function isBuildingRemovedByProposals(feature) {
    if (isFeatureDemolishedByProposalTrack(feature)) return true;
    const carve = getLegacyBuildingCarve(feature?.properties?.object_id);
    return !!carve && carve.verdict === 'razed';
}

function extractBuildingSamples(features, tileKey) {
    const samples = [];
    for (let i = 0; i < (features || []).length; i++) {
        const feature = features[i];
        const baseId = feature.properties && feature.properties.object_id != null
            ? String(feature.properties.object_id)
            : `${tileKey}:building:${i}`;
        if (loadedBuildingIds.has(baseId)) continue;
        if (isBuildingRemovedByProposals(feature)) {
            if (isPassageDebugBuilding(baseId)) {
                console.log('[passage-debug] ' + baseId +
                    ' building rejected — removed by the loaded proposals');
            }
            continue;
        }
        const footprint = extractBuildingFootprint(feature);
        if (!footprint || footprint.ring.length < 3) {
            if (isPassageDebugBuilding(baseId)) {
                const ringLen = footprint && footprint.ring && footprint.ring.length;
                console.log('[passage-debug] ' + baseId +
                    ' building rejected — extractBuildingFootprint returned ring of length ' + ringLen);
            }
            continue;
        }
        loadedBuildingIds.add(baseId);
        recordTileId(tileBuildingIds, tileKey, baseId);
        if (isPassageDebugBuilding(baseId)) {
            const bb = footprint.bbox;
            console.log('[passage-debug] ' + baseId +
                ' building loaded — tileKey=' + tileKey +
                ' bbox=x[' + bb.minX.toFixed(1) + ',' + bb.maxX.toFixed(1) + ']' +
                ' z[' + bb.minZ.toFixed(1) + ',' + bb.maxZ.toFixed(1) + ']' +
                ' span=' + (bb.maxX - bb.minX).toFixed(1) + 'x' + (bb.maxZ - bb.minZ).toFixed(1) + 'm' +
                ' topY=' + footprint.topY.toFixed(2) +
                ' ringPts=' + footprint.ring.length +
                (footprint.usedHullFallback ? ' [hull fallback]' : ' [outer-ring]'));
        }
        samples.push({
            buildingId: baseId,
            tileKey,
            ring: footprint.ring,
            bbox: footprint.bbox,
            bounds: footprint.bbox,
            topY: footprint.topY,
            baseSceneY: footprint.baseSceneY,
            usedHullFallback: footprint.usedHullFallback,
            supportsGeneratedPassages: supportsGeneratedCourtyardPassages(feature),
        });
    }
    return samples;
}

function buildPassageVolume(building, road) {
    const dbg = isPassageDebugBuilding(building.buildingId);
    if (!boxesOverlap(building.bbox, road.bbox, 1.5)) {
        if (dbg) passageDbg(building.buildingId, road.roadId, 'reject: bboxes do not overlap',
            { buildingBbox: building.bbox, roadBbox: road.bbox });
        return null;
    }
    const inside = [];
    let hasOutside = false;
    for (const p of road.ring) {
        if (pointInRing(p.x, p.z, building.ring)) inside.push(p);
        else hasOutside = true;
    }
    if (!hasOutside || inside.length < 2) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: insufficient inside/outside split',
            { insideCount: inside.length, hasOutside });
        return null;
    }
    const origin = averagePoint(inside);
    // Snap the working origin laterally onto the road's centre line. The
    // inside-vertex average can sit anywhere within the road polygon, and any
    // lateral offset shifts the spawned walls off the shader's discard hole
    // (which is centred on the road axis) — leaving a see-through slit on one
    // side and a wall standing in the open corridor on the other.
    const originRight = (origin.x - road.obb.centerX) * road.rightX
        + (origin.z - road.obb.centerZ) * road.rightZ;
    origin.x -= road.rightX * originRight;
    origin.z -= road.rightZ * originRight;
    const hits = linePolygonIntersections(origin, road.alongX, road.alongZ, building.ring).sort((a, b) => a - b);
    if (hits.length < 2) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: < 2 line/polygon intersections',
            { hits });
        return null;
    }
    const minT = hits[0];
    const maxT = hits[hits.length - 1];
    const depth = maxT - minT;
    if (depth < 3.0 || depth < road.width * 0.85) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: depth too small',
            { depth: depth.toFixed(2), roadWidth: road.width.toFixed(2),
              required: Math.max(3.0, road.width * 0.85).toFixed(2) });
        return null;
    }
    // Traversal check: the road's actual along-axis extent must overlap
    // most of the building's depth (between facades, [minT, maxT]).
    //   - Segment B (passes through):   road extent fully covers [minT, maxT] → overlap ≈ depth ✓
    //   - Segment A (ends at facade):    road extent ends near minT          → overlap ≈ 0     ✗
    //   - Segment C (starts at facade):  road extent starts near maxT        → overlap ≈ 0     ✗
    // We project ALL road.ring points (not just inside ones) so a buffered
    // straight road with only 4 corner vertices still reports its true
    // length — the inside-vertices count would be 0 in that case even
    // though the road clearly traverses the building.
    let roadMinAlong = Infinity;
    let roadMaxAlong = -Infinity;
    for (const p of road.ring) {
        const dx = p.x - origin.x;
        const dz = p.z - origin.z;
        const along = dx * road.alongX + dz * road.alongZ;
        if (along < roadMinAlong) roadMinAlong = along;
        if (along > roadMaxAlong) roadMaxAlong = along;
    }
    const overlapMin = Math.max(roadMinAlong, minT);
    const overlapMax = Math.min(roadMaxAlong, maxT);
    const overlapLength = Math.max(0, overlapMax - overlapMin);
    // 0.5 instead of 0.6 — gives borderline traversing roads (whose
    // OSM polygon ends right at the facade, so overlap = depth × ~0.5)
    // a chance to pass while still rejecting clear stubs at <30% overlap.
    const requiredOverlap = depth * 0.5;
    if (overlapLength < requiredOverlap) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: road overlap with building depth too small (stub segment touching facade)',
            { overlapLength: overlapLength.toFixed(2),
              required: requiredOverlap.toFixed(2),
              buildingDepth: depth.toFixed(2),
              roadAlong: [roadMinAlong.toFixed(2), roadMaxAlong.toFixed(2)],
              buildingAlong: [minT.toFixed(2), maxT.toFixed(2)] });
        return null;
    }
    let before = false;
    let after = false;
    for (const p of road.ring) {
        const dx = p.x - origin.x;
        const dz = p.z - origin.z;
        const along = dx * road.alongX + dz * road.alongZ;
        if (along < minT - 0.8) before = true;
        if (along > maxT + 0.8) after = true;
    }
    // Reject only when the road has neither before nor after — that would
    // mean the road lies ENTIRELY inside the building (e.g. a courtyard
    // road wrongly tagged as service). Roads split at the facade — common
    // in OSM, where a service road through a passage is two ways meeting
    // at the building edge — have only one of before/after but should
    // still produce a passage cutout.
    if (!before && !after) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: road lies entirely inside the building (no before/after)',
            { before, after, depth: depth.toFixed(2) });
        return null;
    }
    const height = Math.min(PASSAGE_HEIGHT_M, building.topY - 0.35);
    if (height < 3.2) {
        if (dbg) passageDbg(building.buildingId, road.roadId,
            'reject: building too short for passage',
            { topY: building.topY.toFixed(2), neededHeight: 3.2 });
        return null;
    }
    const halfWidth = Math.min(road.width * 0.5 + 0.2, 5.5);
    // One span list per side wall (world right offset −/+). Each span runs
    // exactly facade-to-facade along that wall's own centre line, so the
    // visible walls and lintel stay flush with the facades instead of
    // overhanging past them (the shader discard hole in the facade comes
    // from the per-road OBB, which needs no help from these boxes). The
    // spans also break where the line leaves the footprint, keeping an open
    // courtyard between two wings unwalled.
    const wallOffset = halfWidth + WALL_THICKNESS_M * 0.5;
    // A trusted outer ring gives exact facade crossings, so a road meeting
    // the facade at a steep angle may skew the two walls' ends by metres —
    // that skew is real geometry, not noise. Hull-fallback rings stay on the
    // tight clamp because their crossings can be metres off.
    const maxSkewM = building.usedHullFallback ? MAX_FACADE_SKEW_M : TRUSTED_RING_MAX_SKEW_M;
    const wallIntervals = [-1, 1].map((side) =>
        passageWallIntervals(building.ring, origin, road, side * wallOffset, minT, maxT, maxSkewM));
    const midT = (minT + maxT) * 0.5;
    // Top of the SEAL above the ceiling. Two reasons it must rise past the
    // arch: (1) the lintel is inset behind the facade, so with lintel top ==
    // hole top a grazing upward sight ray slips over the lintel through the
    // reveal slot into the hollow interior — a pale strip along the hole's
    // top edge; 0.4 m of extra height closes that for any street viewpoint.
    // (2) the shader hole can GROW after tile eviction (its height follows
    // the minimum arch among live passages), up to PASSAGE_HEIGHT_M. Capped
    // below the building top so it never pokes through a low roof; hidden
    // behind intact facade whenever nothing cuts above.
    const sealTopY = Math.min(
        Math.max(height + 0.4, PASSAGE_HEIGHT_M),
        Math.max(height, building.topY - 0.05),
    );
    return {
        centerX: origin.x + road.alongX * midT,
        centerY: height * 0.5,
        centerZ: origin.z + road.alongZ * midT,
        // Every Y above is measured from this building's own base; the mesh
        // spawner lifts the whole group by it so the arch meets the facade.
        baseSceneY: Number.isFinite(building.baseSceneY) ? building.baseSceneY : 0,
        alongX: road.alongX,
        alongZ: road.alongZ,
        rightX: road.rightX,
        rightZ: road.rightZ,
        halfWidth,
        halfHeight: height * 0.5,
        halfDepth: depth * 0.5,
        midT,
        sealTopY,
        wallIntervals,
        // One skewed slab per overlapping wall-span pair — each edge follows
        // its own wall's extent, so the roof reaches both facades even when
        // the road crosses the building at an angle.
        ceilingSlabs: pairCeilingSpans(wallIntervals[0], wallIntervals[1]),
    };
}

function addBox(group, sx, sy, sz, px, py, pz, material = getPassageMaterial()) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
}

// A ceiling slab whose two long edges follow their own wall's extent: when
// the road crosses the building at an angle the slab is a parallelogram in
// plan, not a rectangle. Local frame: x = lateral (edge A at xA, edge B at
// xB), z = along the road, prism from yBottom to yTop.
function addCeilingSlab(group, xA, xB, yBottom, yTop, zAStart, zAEnd, zBStart, zBEnd) {
    const corners = [
        [xA, yBottom, zAStart], [xA, yBottom, zAEnd], [xB, yBottom, zBEnd], [xB, yBottom, zBStart],
        [xA, yTop, zAStart], [xA, yTop, zAEnd], [xB, yTop, zBEnd], [xB, yTop, zBStart],
    ];
    const indices = [
        0, 1, 2, 0, 2, 3,       // underside (the visible passage ceiling)
        4, 6, 5, 4, 7, 6,       // top
        0, 4, 5, 0, 5, 1,       // edge A
        1, 5, 6, 1, 6, 2,       // far end
        2, 6, 7, 2, 7, 3,       // edge B
        3, 7, 4, 3, 4, 0,       // near end
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, getPassageMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
}

// All parts of one passage are immutable, share one material, and move in the
// same local frame. Keeping every wall span and lintel slab as its own Mesh
// made each passage cost several color and shadow draws. Merge only within the
// passage so tile eviction and cut ownership stay independently disposable.
function mergePassageShell(group) {
    const meshes = group.children.filter((child) => child.isMesh && child.geometry);
    if (meshes.length < 2) return;
    const transformed = [];
    for (const mesh of meshes) {
        mesh.updateMatrix();
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrix);
        // The solid material does not sample UVs. The custom lintel geometry
        // has none, while BoxGeometry does; removing the unused attribute makes
        // their schemas compatible for one indexed merge.
        geometry.deleteAttribute('uv');
        transformed.push(geometry);
    }
    const geometry = mergeGeometries(transformed, false);
    for (const part of transformed) part.dispose();
    if (!geometry) return;
    for (const mesh of meshes) {
        mesh.geometry.dispose();
        group.remove(mesh);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const shell = new THREE.Mesh(geometry, getPassageMaterial());
    shell.name = 'CourtyardPassageShell';
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);
}

// A surface track, exposed -1 ramp, or planner-station footprint removes the
// building volume all the way to the sky. Each local slab caps one freshly
// exposed building face; unlike a courtyard passage it has no opposite-side
// twin and deliberately has no roof.
function spawnCustomTrackCutPatchMesh(id, volume) {
    const group = new THREE.Group();
    group.name = `CustomTrackCutPatch:${id}`;
    group.position.set(
        volume.centerX,
        volume.centerY - volume.halfHeight,
        volume.centerZ,
    );
    group.rotation.y = Math.atan2(volume.alongX, volume.alongZ);
    const height = volume.halfHeight * 2;
    const depth = volume.halfDepth * 2 + WALL_THICKNESS_M;
    const material = getCustomTrackPatchMaterial();
    addBox(group, WALL_THICKNESS_M, height, depth, 0, volume.halfHeight, 0, material);
    group.userData.patchSide = volume.patchSide;
    ensurePassagesGroup().add(group);
    return group;
}

function spawnPassageMesh(id, volume) {
    const group = new THREE.Group();
    group.name = `CourtyardPassage:${id}`;
    group.position.set(
        volume.centerX,
        (volume.baseSceneY || 0) + volume.centerY - volume.halfHeight,
        volume.centerZ,
    );
    group.rotation.y = Math.atan2(volume.alongX, volume.alongZ);
    const height = volume.halfHeight * 2;
    // Side walls stop at the lintel's UNDERSIDE. Running them to the full
    // arch height leaves the wall tops visible as a lintel-thick step above
    // the ceiling plane at the facade.
    const wallTopY = height - LINTEL_THICKNESS_M;
    // Local +x maps to world −right, so a wall whose spans were computed at
    // world right offset s·wallOffset sits at local x = −s·wallOffset.
    const wallOffset = volume.halfWidth + WALL_THICKNESS_M * 0.5;
    for (let sideIndex = 0; sideIndex < volume.wallIntervals.length; sideIndex++) {
        const side = sideIndex === 0 ? -1 : 1;
        for (const span of volume.wallIntervals[sideIndex]) {
            addBox(group, WALL_THICKNESS_M, wallTopY, span.end - span.start,
                -side * wallOffset, wallTopY * 0.5, (span.start + span.end) * 0.5 - volume.midT);
        }
    }
    // The ceiling runs from just under the arch top all the way up to the
    // seal top (see buildPassageVolume.sealTopY), closing the zone a taller
    // or later-grown shader cut can expose above the arch. Each slab's edges
    // follow their own wall's extent — skewed passages get a parallelogram
    // roof that reaches both facades. Local +x maps to world −right, so the
    // slab edge for wallIntervals[0] (world right offset −wallOffset) sits
    // at local +x.
    const lintelBottomY = height - LINTEL_THICKNESS_M;
    const lintelTopY = Math.max(volume.sealTopY || height, height);
    const slabEdgeX = volume.halfWidth + WALL_THICKNESS_M;
    for (const slab of volume.ceilingSlabs) {
        addCeilingSlab(
            group,
            slabEdgeX,
            -slabEdgeX,
            lintelBottomY,
            lintelTopY,
            slab.leftStart - volume.midT,
            slab.leftEnd - volume.midT,
            slab.rightStart - volume.midT,
            slab.rightEnd - volume.midT,
        );
    }
    mergePassageShell(group);
    ensurePassagesGroup().add(group);
    return group;
}

function disposePassageMesh(mesh) {
    if (!mesh) return;
    while (mesh.children.length > 0) {
        const child = mesh.children[0];
        if (child.geometry) child.geometry.dispose();
        mesh.remove(child);
    }
    if (mesh.parent) mesh.parent.remove(mesh);
}

function trackVolumeBounds(volume) {
    const extentX = Math.abs(volume.rightX) * volume.halfWidth +
        Math.abs(volume.alongX) * volume.halfDepth;
    const extentZ = Math.abs(volume.rightZ) * volume.halfWidth +
        Math.abs(volume.alongZ) * volume.halfDepth;
    return {
        minX: volume.centerX - extentX,
        maxX: volume.centerX + extentX,
        minZ: volume.centerZ - extentZ,
        maxZ: volume.centerZ + extentZ,
    };
}

function customTrackInsideIntervals(building, track, rightOffset) {
    const origin = {
        x: track.centerX + track.rightX * rightOffset,
        z: track.centerZ + track.rightZ * rightOffset,
    };
    const minAlong = -track.halfDepth;
    const maxAlong = track.halfDepth;
    const cuts = [minAlong, maxAlong];
    for (const hit of linePolygonIntersections(origin, track.alongX, track.alongZ, building.ring)) {
        if (hit > minAlong + 1e-4 && hit < maxAlong - 1e-4) cuts.push(hit);
    }
    cuts.sort((a, b) => a - b);
    const uniqueCuts = [];
    for (const cut of cuts) {
        if (uniqueCuts.length === 0 || Math.abs(cut - uniqueCuts[uniqueCuts.length - 1]) > 1e-4) {
            uniqueCuts.push(cut);
        }
    }
    const intervals = [];
    for (let i = 0; i < uniqueCuts.length - 1; i++) {
        const start = uniqueCuts[i];
        const end = uniqueCuts[i + 1];
        if (end - start < 0.05) continue;
        const mid = (start + end) * 0.5;
        const x = origin.x + track.alongX * mid;
        const z = origin.z + track.alongZ * mid;
        if (pointInRing(x, z, building.ring)) intervals.push({ start, end });
    }
    return intervals;
}

function mergeLongitudinalIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && interval.start <= previous.end + 0.15) {
            previous.end = Math.max(previous.end, interval.end);
        } else {
            merged.push({ ...interval });
        }
    }
    return merged;
}

function corridorCoverageIntervalOnTrackLine(track, rightOffset, other) {
    const originX = track.centerX + track.rightX * rightOffset;
    const originZ = track.centerZ + track.rightZ * rightOffset;
    const dx = originX - other.centerX;
    const dz = originZ - other.centerZ;
    const originRight = dx * other.rightX + dz * other.rightZ;
    const originAlong = dx * other.alongX + dz * other.alongZ;
    const deltaRight = track.alongX * other.rightX + track.alongZ * other.rightZ;
    const deltaAlong = track.alongX * other.alongX + track.alongZ * other.alongZ;
    let start = -track.halfDepth;
    let end = track.halfDepth;
    const clipAxis = (origin, delta, min, max) => {
        if (Math.abs(delta) < 1e-9) return origin >= min && origin <= max;
        let enter = (min - origin) / delta;
        let exit = (max - origin) / delta;
        if (enter > exit) [enter, exit] = [exit, enter];
        start = Math.max(start, enter);
        end = Math.min(end, exit);
        return end > start + 0.01;
    };
    if (!clipAxis(originRight, deltaRight, -other.halfWidth, other.halfWidth)) return null;
    if (!clipAxis(originAlong, deltaAlong, -other.halfDepth, other.halfDepth)) return null;
    return { start, end };
}

function subtractLongitudinalIntervals(intervals, blockers) {
    let remaining = intervals.slice();
    for (const blocker of blockers) {
        const next = [];
        for (const interval of remaining) {
            if (blocker.end <= interval.start + 0.01 || blocker.start >= interval.end - 0.01) {
                next.push(interval);
                continue;
            }
            if (blocker.start > interval.start + 0.05) {
                next.push({ start: interval.start, end: Math.min(interval.end, blocker.start) });
            }
            if (blocker.end < interval.end - 0.05) {
                next.push({ start: Math.max(interval.start, blocker.end), end: interval.end });
            }
        }
        remaining = next;
        if (remaining.length === 0) break;
    }
    return remaining;
}

// Probe each corridor boundary independently. A patch exists only where the
// same building crosses from just inside the cut to just outside that exact
// side, so either side may be absent and their facade spans may differ.
function buildCustomTrackCutPatches(building, track, trackIndex) {
    if (!boxesOverlap(building.bbox, trackVolumeBounds(track), 0.05)) return [];

    // The cut volume lives in scene-Y while building.topY is measured from the
    // building's own base, so the two only line up once the base is added —
    // otherwise a terrain world patches a face metres above the building.
    const band = trackCutPatchBand(
        building.baseSceneY,
        building.topY,
        track.centerY - track.halfHeight,
        track.centerY + track.halfHeight,
        CUSTOM_CUT_MIN_PATCH_HEIGHT_M,
    );
    if (!band) return [];
    const patchBaseY = band.baseY;
    const patchTopY = band.topY;
    const height = band.height;

    const patches = [];
    const edgeInset = Math.min(0.04, track.halfWidth * 0.02);
    const outsideProbeM = 0.06;
    for (const side of [-1, 1]) {
        const insideIntervals = customTrackInsideIntervals(
            building,
            track,
            side * (track.halfWidth - edgeInset),
        );
        const outsideIntervals = customTrackInsideIntervals(
            building,
            track,
            side * (track.halfWidth + outsideProbeM),
        );
        const outsideOffset = side * (track.halfWidth + outsideProbeM);
        const blockers = [];
        for (let otherIndex = 0; otherIndex < customTrackOpenCutOBBs.length; otherIndex++) {
            if (otherIndex === trackIndex) continue;
            const other = customTrackOpenCutOBBs[otherIndex];
            const otherBaseY = other.centerY - other.halfHeight;
            const otherTopY = other.centerY + other.halfHeight;
            if (otherTopY <= patchBaseY || otherBaseY >= patchTopY) continue;
            const blocked = corridorCoverageIntervalOnTrackLine(track, outsideOffset, other);
            if (blocked) blockers.push(blocked);
        }
        const exposedIntervals = mergeLongitudinalIntervals(
            subtractLongitudinalIntervals(
                intersectLongitudinalIntervals(insideIntervals, outsideIntervals),
                blockers,
            ),
        );
        for (const interval of exposedIntervals) {
            const start = Math.max(-track.halfDepth, interval.start - CUSTOM_CUT_END_OVERHANG_M);
            const end = Math.min(track.halfDepth, interval.end + CUSTOM_CUT_END_OVERHANG_M);
            if (end - start < CUSTOM_CUT_MIN_DEPTH_M) continue;
            const mid = (start + end) * 0.5;
            const rightOffset = side * (track.halfWidth + WALL_THICKNESS_M * 0.5);
            patches.push({
                centerX: track.centerX + track.alongX * mid + track.rightX * rightOffset,
                centerY: patchBaseY + height * 0.5,
                centerZ: track.centerZ + track.alongZ * mid + track.rightZ * rightOffset,
                alongX: track.alongX,
                alongZ: track.alongZ,
                rightX: track.rightX,
                rightZ: track.rightZ,
                halfHeight: height * 0.5,
                halfDepth: (end - start) * 0.5,
                patchSide: side,
            });
        }
    }
    return patches;
}

function pairBuildingsAgainstCustomTrackCuts(buildings) {
    for (const building of buildings) {
        for (let trackIndex = 0; trackIndex < customTrackOpenCutOBBs.length; trackIndex++) {
            const volumes = buildCustomTrackCutPatches(
                building,
                customTrackOpenCutOBBs[trackIndex],
                trackIndex,
            );
            for (let partIndex = 0; partIndex < volumes.length; partIndex++) {
                const id = `${building.buildingId}:custom-track:${trackIndex}:${volumes[partIndex].patchSide}:${partIndex}`;
                if (customTrackPatchById.has(id)) continue;
                const mesh = spawnCustomTrackCutPatchMesh(id, volumes[partIndex]);
                customTrackPatchById.set(id, {
                    mesh,
                    buildingId: building.buildingId,
                    buildingTileKey: building.tileKey,
                });
                recordTileId(customTrackPatchIdsByTile, building.tileKey, id);
            }
        }
    }
}

function removeCustomTrackPatch(id) {
    const entry = customTrackPatchById.get(id);
    if (!entry) return;
    disposePassageMesh(entry.mesh);
    customTrackPatchById.delete(id);
}

function removeTileCustomTrackPatches(tileKey) {
    const ids = customTrackPatchIdsByTile.get(tileKey);
    if (!ids) return;
    for (const id of ids) removeCustomTrackPatch(id);
    customTrackPatchIdsByTile.delete(tileKey);
}

function getAllPassageOBBs() {
    return Array.from(roadOBBs.values()).map((entry) => entry.obb).concat(customTrackOpenCutOBBs);
}

function getPassageVolumeCount() {
    return roadOBBs.size + customTrackOpenCutOBBs.length;
}

// Push the closest VISIBLE_PASSAGES passage OBBs into the shader. Sources are
// roadOBBs (one entry per OSM road with at least one detected passage) plus
// any active custom-track corridor OBBs for the current planner route. Closest
// by squared distance from the player to the OBB centre.
function syncBuildingPassageVolumes() {
    const entries = getAllPassageOBBs();
    // Facade painting needs EVERY cut volume (windows must never be laid out
    // across a passage hole), while the shader gets only the nearest N below.
    // The revision lets buildings.js re-mask facades painted before a
    // passage registered (late road tiles).
    setAllBuildingPassageCutVolumes(entries, cutVolumesRevision);
    if (entries.length <= VISIBLE_PASSAGES) {
        setBuildingPassageVolumes(entries);
        lastSyncedPlayerX = playerLocalX;
        lastSyncedPlayerZ = playerLocalZ;
        return;
    }
    const scored = entries.map((obb) => {
        const dx = obb.centerX - playerLocalX;
        const dz = obb.centerZ - playerLocalZ;
        return { obb, d2: dx * dx + dz * dz };
    });
    scored.sort((a, b) => a.d2 - b.d2);
    setBuildingPassageVolumes(scored.slice(0, VISIBLE_PASSAGES).map((s) => s.obb));
    lastSyncedPlayerX = playerLocalX;
    lastSyncedPlayerZ = playerLocalZ;
}

function linkPassageToTile(tileKey, id) {
    if (tileKey == null) return;
    let set = tilePassages.get(tileKey);
    if (!set) {
        set = new Set();
        tilePassages.set(tileKey, set);
    }
    set.add(id);
}

// Register a road's OBB with the shader once, even if multiple buildings
// detect it as a passage. Each passage records its requirements on the entry
// (the scene-Y floor of its building, its arch height and the along-axis span
// it needs cut) and the OBB follows them: the vertical band comes from
// passageCutBand — floor at the LOWEST building base, ceiling at the SHORTEST
// arch on the road, since a fixed 5 m cut through a low wing would slice its
// roof open — and depth = the road's own extent UNION every passage's
// facade-to-facade span + overhang (the road polygon alone can end mid-building
// and leave the far facade uncut). Recomputed when passages are added or
// removed; both acquire and release return true when the shader needs a
// re-sync.
function applyRoadOBBGeometry(entry) {
    let start = -entry.baseHalfDepth;
    let end = entry.baseHalfDepth;
    for (const req of entry.passages.values()) {
        if (req.start < start) start = req.start;
        if (req.end > end) end = req.end;
    }
    const band = passageCutBand(entry.passages.values(), PASSAGE_HEIGHT_M);
    const obb = entry.obb;
    const mid = (start + end) * 0.5;
    const halfDepth = (end - start) * 0.5;
    const centerX = entry.baseX + obb.alongX * mid;
    const centerZ = entry.baseZ + obb.alongZ * mid;
    const centerY = (band.bottomY + band.topY) * 0.5;
    const halfHeight = (band.topY - band.bottomY) * 0.5;
    const changed = obb.halfHeight !== halfHeight
        || obb.centerY !== centerY
        || obb.halfDepth !== halfDepth
        || obb.centerX !== centerX
        || obb.centerZ !== centerZ;
    obb.centerY = centerY;
    obb.halfHeight = halfHeight;
    obb.halfDepth = halfDepth;
    obb.centerX = centerX;
    obb.centerZ = centerZ;
    // The same band measured from the building's own base rather than from the
    // scene anchor. The shader wants the scene-Y one above (it compares against
    // a world position); the facade painter works in the wall's own frame,
    // where the base is 0 — handing it the scene band would reserve window
    // space tens of metres off the arch on any slope.
    obb.cutHeightM = band.topY - band.bottomY;
    return changed;
}
function acquireRoadOBB(road, passageId, requirement) {
    let entry = roadOBBs.get(road.roadId);
    let isNew = false;
    if (!entry) {
        // Copy the sample's OBB: the mutations below must not leak into the
        // cached road sample and survive tile evictions. baseX/Z/HalfDepth
        // remember the road's own centre and extent as the fixed reference
        // frame the per-passage spans are measured in.
        entry = {
            obb: { ...road.obb },
            baseX: road.obb.centerX,
            baseZ: road.obb.centerZ,
            baseHalfDepth: road.obb.halfDepth,
            passages: new Map(),
        };
        roadOBBs.set(road.roadId, entry);
        isNew = true;
    }
    entry.passages.set(passageId, requirement);
    const geometryChanged = applyRoadOBBGeometry(entry);
    const changed = isNew || geometryChanged;
    if (changed) cutVolumesRevision++;
    return changed;
}
function releaseRoadOBB(roadId, passageId) {
    const entry = roadOBBs.get(roadId);
    if (!entry) return false;
    entry.passages.delete(passageId);
    if (entry.passages.size === 0) {
        roadOBBs.delete(roadId);
        cutVolumesRevision++;
        return true;
    }
    const changed = applyRoadOBBGeometry(entry);
    if (changed) cutVolumesRevision++;
    return changed;
}

function tryAddPassage(building, road) {
    // Authored/stated-material meshes still stay in buildingSamplesByTile for
    // vehicle collision and proposal-track cuts; only the generic road-driven
    // courtyard reconstruction is forbidden from inventing geometry on them.
    if (building.supportsGeneratedPassages === false) return;
    if (passageById.size >= MAX_PASSAGES) {
        if (isPassageDebugBuilding(building.buildingId)) {
            passageDbg(building.buildingId, road.roadId,
                'skip: MAX_PASSAGES (' + MAX_PASSAGES + ') already used',
                { totalSoFar: passageById.size });
        }
        return;
    }
    const id = `${building.buildingId}:${road.roadId}`;
    if (passageById.has(id)) return;
    // Per-pair geometry (lintel + side walls). Filters in buildPassageVolume
    // ensure the road actually traverses this building (depth, traversal
    // overlap, height). Returns null when the (building, road) pair isn't
    // a real passage — in which case we don't register the road OBB either.
    const volume = buildPassageVolume(building, road);
    if (!volume) return;
    if (isPassageDebugBuilding(building.buildingId)) {
        passageDbg(building.buildingId, road.roadId, 'ACCEPTED — registering road OBB + spawning mesh', {
            depth: (volume.halfDepth * 2).toFixed(2),
            width: (volume.halfWidth * 2).toFixed(2),
            height: (volume.halfHeight * 2).toFixed(2),
            roadObbDepth: (road.obb.halfDepth * 2).toFixed(2),
        });
    }
    const mesh = spawnPassageMesh(id, volume);
    // The along-axis span this passage needs cut, measured in the road's own
    // frame (relative to the road polygon's centroid). volume.center sits on
    // the road centre line, so a plain projection is exact.
    const alongMid = (volume.centerX - road.obb.centerX) * road.alongX
        + (volume.centerZ - road.obb.centerZ) * road.alongZ;
    const obbChanged = acquireRoadOBB(road, id, {
        baseY: volume.baseSceneY || 0,
        archHeight: volume.halfHeight * 2,
        start: alongMid - volume.halfDepth - PASSAGE_CUT_END_OVERHANG_M,
        end: alongMid + volume.halfDepth + PASSAGE_CUT_END_OVERHANG_M,
    });
    passageById.set(id, {
        mesh,
        volume,
        roadId: road.roadId,
        buildingId: building.buildingId,
        buildingTileKey: building.tileKey,
        roadTileKey: road.tileKey,
    });
    linkPassageToTile(building.tileKey, id);
    linkPassageToTile(road.tileKey, id);
    return obbChanged;
}

function pairRoadsAgainstBuildings(roads) {
    let changed = false;
    for (const road of roads) {
        for (const buildings of buildingSamplesByTile.values()) {
            for (const building of buildings) {
                changed = tryAddPassage(building, road) || changed;
            }
        }
    }
    // Publish the complete delivery once. Publishing inside tryAddPassage
    // repeatedly copied/sorted the growing cut set and notified facade owners.
    if (changed) syncBuildingPassageVolumes();
}

function pairBuildingsAgainstRoads(buildings) {
    let changed = false;
    for (const building of buildings) {
        let roadCandidates = 0;
        let bboxOverlaps = 0;
        for (const roads of roadSamplesByTile.values()) {
            for (const road of roads) {
                roadCandidates++;
                if (boxesOverlap(building.bbox, road.bbox, 1.5)) bboxOverlaps++;
                changed = tryAddPassage(building, road) || changed;
            }
        }
        if (isPassageDebugBuilding(building.buildingId)) {
            console.log('[passage-debug]', building.buildingId,
                'pair-pass complete',
                { totalRoadCandidates: roadCandidates, withBboxOverlap: bboxOverlaps });
        }
    }
    if (changed) syncBuildingPassageVolumes();
}

function removePassage(id) {
    const entry = passageById.get(id);
    if (!entry) return;
    disposePassageMesh(entry.mesh);
    passageById.delete(id);
    if (entry.roadId != null && releaseRoadOBB(entry.roadId, id)) {
        // The road's OBB is gone or its cut height changed — the enclosing
        // tile/session removal re-syncs the shader once with the final set.
        return true;
    }
}

function removeTilePassages(tileKey) {
    const ids = tilePassages.get(tileKey);
    if (!ids) return;
    for (const id of ids) removePassage(id);
    tilePassages.delete(tileKey);
    syncBuildingPassageVolumes();
}

function removeTileSamples(tileKey, samplesByTile, tileIds, loadedIds) {
    samplesByTile.delete(tileKey);
    const ids = tileIds.get(tileKey);
    if (!ids) return;
    for (const id of ids) loadedIds.delete(id);
    tileIds.delete(tileKey);
}

function clearAllPassages() {
    for (const id of Array.from(passageById.keys())) removePassage(id);
    for (const id of Array.from(customTrackPatchById.keys())) removeCustomTrackPatch(id);
    passageById.clear();
    customTrackPatchById.clear();
    customTrackPatchIdsByTile.clear();
    tilePassages.clear();
    roadSamplesByTile.clear();
    buildingSamplesByTile.clear();
    vehicleBuildingGridsByTile.clear();
    loadedRoadIds.clear();
    loadedBuildingIds.clear();
    tileRoadIds.clear();
    tileBuildingIds.clear();
    roadOBBs.clear();
    customTrackOpenCutOBBs = [];
    cutVolumesRevision++;
    syncBuildingPassageVolumes();
}

export const courtyardPassagesLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        sharedTileSession,
        customTrackCorridors,
        otherTracks,
        allStops,
    }) {
        anchorLat = lat;
        anchorLon = lon;
        clearAllPassages();
        // A surface or below-grade cut is "the ground all the way to the sky",
        // and resting it ON the anchor plane only spelled that correctly on flat
        // ground: with the DGU surface active a building stands at its surveyed
        // base, which at Divulje is ~22 m BELOW the anchor plane, so a band
        // starting at 0 missed those buildings entirely. Centring on 0 covers
        // any terrain offset, and changes nothing in the flat world, where no
        // building geometry exists below y = 0.
        const surfaceTrackCuts = buildTrackCorridorVolumes(customTrackCorridors, anchorLat, anchorLon, {
            centerY: 0,
            halfHeight: OPEN_CUT_HALF_HEIGHT_M,
            segmentFilter: ({ startElevationM, endElevationM }) =>
                isPlannerSurfaceLevelSegment(startElevationM, endElevationM),
        });
        const rampCuts = buildTrackCorridorVolumes(customTrackCorridors, anchorLat, anchorLon, {
            centerY: 0,
            halfHeight: OPEN_CUT_HALF_HEIGHT_M,
            halfWidth: PLANNER_OPEN_CUT_HALF_WIDTH_M,
            elevatedRightExtension: 0,
            segmentFilter: ({ startElevationM, endElevationM }) =>
                isPlannerUndergroundRampSegment(startElevationM, endElevationM),
        });
        // Positive ramps are shallow enough to run through upper floors long
        // before reaching +1. Cut each elevated segment from just below its
        // deck all the way to the sky; the existing per-building boundary
        // patcher closes only the genuinely exposed side faces.
        const elevatedCuts = buildTrackCorridorVolumes(customTrackCorridors, anchorLat, anchorLon, {
            centerY: OPEN_CUT_HALF_HEIGHT_M - ELEVATED_CUT_BELOW_TRACK_M,
            halfHeight: OPEN_CUT_HALF_HEIGHT_M,
            segmentFilter: ({ startElevationM, endElevationM }) =>
                isPlannerElevatedSegment(startElevationM, endElevationM),
        });
        const stationCuts = buildPlannerStationClearanceVolumes(
            allStops,
            otherTracks,
            anchorLat,
            anchorLon,
        );
        customTrackOpenCutOBBs = surfaceTrackCuts.concat(rampCuts, elevatedCuts, stationCuts);
        syncBuildingPassageVolumes();
        ensurePassagesGroup();
        roadTileSource = sharedTileSession.getSource({
            key: 'roads:cab',
            label: 'courtyard-roads',
            url: (bb) => `${getApiBase()}/roads/cab?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        const buildingSource = buildingTileSourceForLocation();
        buildingTileSource = sharedTileSession.getSource({
            key: buildingSource.key,
            label: 'courtyard-buildings',
            url: (bb) => `${getApiBase()}/${buildingSource.endpoint}?bbox=${bb.west},${bb.south},${bb.east},${bb.north}${buildingSource.querySuffix}`,
            ...DETAILED_BUILDING_STREAM_OPTIONS,
        });
        roadSubscription = roadTileSource.subscribe({
            onFetch: (features, tileKey) => {
                const roads = extractRoadSamples(features, tileKey);
                roadSamplesByTile.set(tileKey, roads);
                pairRoadsAgainstBuildings(roads);
            },
            onEvict: (tileKey) => {
                removeTilePassages(tileKey);
                removeTileSamples(tileKey, roadSamplesByTile, tileRoadIds, loadedRoadIds);
            },
        });
        const activeBuildingSource = buildingTileSource;
        buildingSubscription = buildingTileSource.subscribe({
            // The same hold buildings.js puts on every building tile: a tile
            // can land before the proposals' carve verdicts do, and until they
            // are known we cannot tell which of these buildings is still
            // standing. Nothing re-evaluates a tile afterwards, so a passage
            // cut through a demolished building would outlive it until the
            // tile is evicted.
            onFetch: (features, tileKey) => proposalsReady().then(() => {
                if (buildingTileSource !== activeBuildingSource) return;  // session ended in flight
                const buildings = extractBuildingSamples(features, tileKey);
                buildingSamplesByTile.set(tileKey, buildings);
                vehicleBuildingGridsByTile.set(tileKey, createBoundsGrid(buildings, {
                    cellM: 20,
                }));
                pairBuildingsAgainstCustomTrackCuts(buildings);
                pairBuildingsAgainstRoads(buildings);
            }),
            onEvict: (tileKey) => {
                removeTileCustomTrackPatches(tileKey);
                removeTilePassages(tileKey);
                removeTileSamples(tileKey, buildingSamplesByTile, tileBuildingIds, loadedBuildingIds);
                vehicleBuildingGridsByTile.delete(tileKey);
            },
        });
        roadTileSource.ensureAround(0, 0);
        buildingTileSource.ensureAround(0, 0);
    },
    onFrame(pose, local) {
        if (roadTileSource) roadTileSource.ensureAround(local.x, local.z);
        if (buildingTileSource) buildingTileSource.ensureAround(local.x, local.z);
        syncPassageMaterialNight();
        playerLocalX = local.x;
        playerLocalZ = local.z;
        // Re-pick the closest VISIBLE_PASSAGES whenever the cab has moved
        // far enough that the previous pick may be stale. Cheap: O(N log N)
        // sort over ≤ MAX_PASSAGES (200) entries, gated by movement.
        const dx = playerLocalX - lastSyncedPlayerX;
        const dz = playerLocalZ - lastSyncedPlayerZ;
        if (dx * dx + dz * dz > RESYNC_DISTANCE_M * RESYNC_DISTANCE_M
            && getPassageVolumeCount() > VISIBLE_PASSAGES) {
            syncBuildingPassageVolumes();
        }
    },
    endSession() {
        if (roadSubscription) roadSubscription();
        if (buildingSubscription) buildingSubscription();
        roadSubscription = null;
        buildingSubscription = null;
        roadTileSource = null;
        buildingTileSource = null;
        clearAllPassages();
        if (passagesGroup) {
            if (passagesGroup.parent) passagesGroup.parent.remove(passagesGroup);
            passagesGroup = null;
        }
        if (passageMaterial) {
            unregisterShared(passageMaterial);
            passageMaterial.dispose();
            passageMaterial = null;
            passageMaterialIsNight = null;
        }
        if (customTrackPatchMaterial) {
            unregisterShared(customTrackPatchMaterial);
            customTrackPatchMaterial.dispose();
            customTrackPatchMaterial = null;
        }
    },
};
