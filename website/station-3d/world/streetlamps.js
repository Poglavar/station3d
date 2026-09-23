// Street lamps along road centrelines. OSM doesn't carry lamp positions
// reliably, so we synthesise them: walk each drivable road every
// LAMP_SPACING_M metres, drop a pole to one side, and light it at night.
// Each lamp is a pole + a dark hood + an emissive underside lens. Pavement,
// road, trackbed, and curb materials share a conformal radial-light shader;
// there is no horizontal glow plane to intersect raised curb geometry.
//
// Rides the road-formation `roads:graph` source so lamps extend along the
// visible civil corridor. Ambient traffic intentionally owns a smaller,
// independent retention window; identical in-flight requests still coalesce.
// Lamps are owned and evicted per tile, while a bounded 4×4 tile region shares
// one bounded instance region. Each tile's lamps are packed contiguously in its
// region, so a region draws only real lamps. A lamp still belongs to the tile
// containing its base, so a road spanning tiles never double-places lamps.

import * as THREE from 'three';
import { DEG_TO_RAD, EARTH_RADIUS_M, finiteOrNull } from '../core/math.js';
import { POLE_H, LENS_Y, CAP_Y, getPoleGeometry, getHeadGeometry, getCapGeometry, getPoleMaterial, getHeadMaterial, getCapMaterial, setStreetLampModelNight } from '../models/objects/street-lamp.js';
import { getApiBase } from '../core/api.js';
import { scene } from '../scene/setup.js';
import { NEAR_ROAD_STREAM_OPTIONS, TILE_M } from '../core/tile-stream.js';
import {
    resetStreetLampSurfaceLighting,
    setStreetLampSurfaceNightMode,
    updateStreetLampSurfaceLighting,
} from './streetlamp-lighting.js';
import {
    buildTrackCorridorVolumes,
    isPointInsideCorridorFootprints,
} from './track-corridors.js';
import { buildPlannerStationClearanceVolumes } from './planner-station-layout.js';
import { roadFurnitureBlockedByOverpass } from '../core/road-furniture-placement.js';
import { createPackedInstanceBlocks } from '../core/packed-instance-blocks.js';

// Same public-traffic set the cars layer drives on — lamps line the streets
// with actual traffic, not service aisles or footpaths.
const LAMP_HIGHWAYS = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'residential', 'unclassified',
]);

const LAMP_SPACING_M = 32;       // pole-to-pole pitch along a road
// The pole is pushed off the centreline by the carriageway half-width + a kerb
// margin, so it always lands on the sidewalk/verge — never on the asphalt and
// never on the (centre-running) tram tracks. Half-width comes from the road's
// width/lanes tags, falling back to a per-class estimate.
const LANE_WIDTH_M = 3.4;        // matches the cars layer's carriageway model
const CURB_MARGIN_M = 1.2;       // metres past the asphalt edge onto the kerb
const DEFAULT_HALF_WIDTH_M = {
    motorway: 8, motorway_link: 5, trunk: 7, trunk_link: 5,
    primary: 7, primary_link: 5, secondary: 6, secondary_link: 4.5,
    tertiary: 4.5, tertiary_link: 4, residential: 3, unclassified: 3,
};
export const STREET_LAMP_GLOW_RADIUS_M = 7.0;
const MAX_LAMPS_PER_TILE = 160;  // clutter/perf guard for very dense tiles
const TRACK_CLEARANCE_M = 0.55;  // keep pole + broad lamp cap clear of the deck edge


let lampsGroup = null;
let anchorLat = 0, anchorLon = 0;
let tileSource = null;
let tileSubscription = null;
const tileLamps = new Map();     // tileKey → region block + positions
const lampRegions = new Map();   // 4×4 tile region → three fixed-capacity instance meshes
const tileFeatures = new Map();  // retained source data for terrain-evidence retries
const terrainDirtyTiles = new Set();
const destroyedLampIds = new Set();
let isNight = false;
let lampPositionsRevision = 0;
let lastSurfaceLightX = Infinity;
let lastSurfaceLightZ = Infinity;
let lastSurfaceLightRevision = -1;
let customTrackCorridorVolumes = [];
let terrainReference = null;
let roadFormationModel = null;
let roadVerticalAlignmentModel = null;
let terrainUnsubscribe = null;
let lastRoadFormationRevision = null;

// ─── Shared geometry + materials (one instance for the whole scene) ─────────
const LAMP_REGION_TILES = 4;
const LAMP_REGION_CAPACITY = MAX_LAMPS_PER_TILE * LAMP_REGION_TILES * LAMP_REGION_TILES;

// Convert a lon/lat to session-local metres (same projection as the rest of
// the world; +X east, -Z north).
function toLocal(lon, lat) {
    const cosLat = Math.cos(anchorLat * DEG_TO_RAD);
    return {
        x: (lon - anchorLon) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
        z: -(lat - anchorLat) * DEG_TO_RAD * EARTH_RADIUS_M,
    };
}

// Walk one road's centreline and emit lamp base positions that fall inside the
// given tile rect. Distance accumulates from the feature start so the 32 m
// cadence is continuous across tile borders (no bunching at the seams).
// Carriageway half-width in metres from width/lanes tags, or a per-class guess.
function carriagewayHalfWidthM(props) {
    const w = Number(props.width_meters);
    if (Number.isFinite(w) && w > 0) return w / 2;
    const lanes = parseInt(props.lanes, 10);
    if (Number.isFinite(lanes) && lanes > 0) return (lanes * LANE_WIDTH_M) / 2;
    return DEFAULT_HALF_WIDTH_M[props.highway] ?? 3;
}

function collectLampsForFeature(feature, rect, out) {
    const props = feature.properties || {};
    if (!LAMP_HIGHWAYS.has(props.highway)) return;
    const geom = feature.geometry;
    if (!geom || geom.type !== 'LineString') return;
    const coords = geom.coordinates;
    if (!coords || coords.length < 2) return;
    const parsedOsmId = Number(props.osm_id);
    const osmId = Number.isFinite(parsedOsmId) ? parsedOsmId : null;

    const sideOffset = carriagewayHalfWidthM(props) + CURB_MARGIN_M;
    let distToNext = LAMP_SPACING_M * 0.5;  // half-pitch in so poles avoid junctions
    let prev = toLocal(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
        const cur = toLocal(coords[i][0], coords[i][1]);
        let sx = cur.x - prev.x;
        let sz = cur.z - prev.z;
        let segLen = Math.sqrt(sx * sx + sz * sz);
        if (segLen < 1e-3) { prev = cur; continue; }
        const ux = sx / segLen, uz = sz / segLen;
        // Perpendicular (left of travel) — poles all sit on one kerb.
        const px = -uz, pz = ux;
        let walked = 0;
        while (distToNext <= segLen) {
            walked = distToNext;
            const bx = prev.x + ux * walked + px * sideOffset;
            const bz = prev.z + uz * walked + pz * sideOffset;
            if (bx >= rect.x0 && bx < rect.x1 && bz >= rect.z0 && bz < rect.z1) {
                if (isPointInsideCorridorFootprints(
                    bx,
                    bz,
                    customTrackCorridorVolumes,
                    TRACK_CLEARANCE_M,
                )) {
                    distToNext += LAMP_SPACING_M;
                    continue;
                }
                const id = `lamp:${osmId ?? 'road'}:${Math.round(bx * 10)}:${Math.round(bz * 10)}`;
                if (!destroyedLampIds.has(id)) {
                    // Keep the established source shape explicit: a source-level
                    // performance regression test verifies this tight hot path.
                    out.push({ x: bx, z: bz, osmId });
                    out[out.length - 1].id = id;
                }
                if (out.length >= MAX_LAMPS_PER_TILE) return;
            }
            distToNext += LAMP_SPACING_M;
        }
        distToNext -= segLen;
        prev = cur;
    }
}

function tileRectFromKey(tileKey) {
    const [tx, tz] = tileKey.split('_').map(Number);
    return {
        x0: tx * TILE_M, x1: (tx + 1) * TILE_M,
        z0: tz * TILE_M, z1: (tz + 1) * TILE_M,
    };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

function lampGroundSceneY({ x, z, osmId }) {
    const terrainY = terrainReference
        ? finiteOrNull(terrainReference.evidenceSceneYAtLocal?.(x, z))
        : 0;
    if (terrainY === null) return null;
    const formationY = roadFormationModel
        // Street furniture is decorative and can remain on the last
        // atomically published formation for the few frames needed to
        // prepare the next generation. A current read here synchronously
        // completed that whole generation once per graph-tile delivery,
        // producing the apparent 200+ ms road-formation spikes.
        ? finiteOrNull(roadFormationModel.sceneYAtLocal(x, z, {
            osmId,
            maxDistanceM: 15,
            allowStale: true,
        }))
        : null;
    if (formationY !== null) return formationY;
    return terrainY;
}

function lampRegionKey(tileKey) {
    const [tx, tz] = String(tileKey).split('_').map(Number);
    return `${Math.floor(tx / LAMP_REGION_TILES)}_${Math.floor(tz / LAMP_REGION_TILES)}`;
}

function createLampRegion(regionKey) {
    const poles = new THREE.InstancedMesh(
        getPoleGeometry(), getPoleMaterial(), LAMP_REGION_CAPACITY,
    );
    const heads = new THREE.InstancedMesh(
        getHeadGeometry(), getHeadMaterial(), LAMP_REGION_CAPACITY,
    );
    const caps = new THREE.InstancedMesh(
        getCapGeometry(), getCapMaterial(), LAMP_REGION_CAPACITY,
    );
    poles.name = 'StreetLampPoles';
    heads.name = 'StreetLampLenses';
    caps.name = 'StreetLampCaps';
    poles.castShadow = false;
    heads.castShadow = false;
    caps.castShadow = false;
    // Instance bounds would otherwise become stale as neighbouring tile blocks
    // arrive and leave. Regions are already bounded to 4×4 retained tiles, so
    // three unconditional regional draws are cheaper than rescanning hundreds
    // of matrices to rebuild bounds after every delivery.
    poles.frustumCulled = false;
    heads.frustumCulled = false;
    caps.frustumCulled = false;
    // InstancedMesh initializes every slot to identity. Unused capacity is
    // outside the drawn count; keep it collapsed anyway so a stale count can
    // never render phantom lamps.
    poles.instanceMatrix.array.fill(0);
    heads.instanceMatrix.array.fill(0);
    caps.instanceMatrix.array.fill(0);
    poles.count = heads.count = caps.count = 0;
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    lampsGroup.add(poles, heads, caps);
    const blocks = createPackedInstanceBlocks({ capacity: LAMP_REGION_CAPACITY });
    const region = { regionKey, poles, heads, caps, blocks, tiles: new Map() };
    lampRegions.set(regionKey, region);
    return region;
}

function ensureLampRegion(regionKey) {
    return lampRegions.get(regionKey) || createLampRegion(regionKey);
}

function updateLampRegionCount(region) {
    region.poles.count = region.heads.count = region.caps.count = region.blocks.used;
}

// Removes a tile's block and slides later tiles' lamps down over it.
function releaseLampEntryInstances(entry) {
    if (!entry?.region) return;
    const { poles, heads, caps } = entry.region;
    entry.region.blocks.remove(entry.tileKey, [poles.instanceMatrix.array, heads.instanceMatrix.array, caps.instanceMatrix.array]);
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
}

function disposeEmptyLampRegion(region) {
    if (!region || region.tiles.size > 0 || !lampsGroup) return;
    lampRegions.delete(region.regionKey);
    for (const mesh of [region.poles, region.heads, region.caps]) {
        lampsGroup.remove(mesh);
        // Geometry + material are shared; only the per-instance matrix buffer
        // is owned by this mesh and disposed with it.
        mesh.dispose();
    }
}

function disposeTileEntry(entry, keepRegion = false) {
    if (!entry?.region) return;
    releaseLampEntryInstances(entry);
    entry.region.tiles.delete(entry.tileKey);
    updateLampRegionCount(entry.region);
    if (!keepRegion) disposeEmptyLampRegion(entry.region);
}

function publishTileEntry(tileKey, lamps) {
    const previous = tileLamps.get(tileKey);
    const regionKey = lamps?.length ? lampRegionKey(tileKey) : null;
    if (previous) disposeTileEntry(previous, previous.regionKey === regionKey);
    if (!lamps?.length) {
        tileLamps.set(tileKey, null);
        lampPositionsRevision += 1;
        return;
    }
    const region = ensureLampRegion(regionKey);
    const block = region.blocks.append(tileKey, lamps.length);
    const entry = { tileKey, regionKey, region, block, positions: lamps };

    for (let index = 0; index < lamps.length; index++) {
        const { x, z, y: groundY, id } = lamps[index];
        const target = block.offset + index;
        if (destroyedLampIds.has(id)) {
            const zero = new THREE.Matrix4().makeScale(0, 0, 0);
            region.poles.setMatrixAt(target, zero);
            region.heads.setMatrixAt(target, zero);
            region.caps.setMatrixAt(target, zero);
            continue;
        }
        _p.set(x, groundY, z);
        _m.compose(_p, _q, _s);
        region.poles.setMatrixAt(target, _m);
        _p.set(x, groundY + LENS_Y, z);
        _m.compose(_p, _q, _s);
        region.heads.setMatrixAt(target, _m);
        _p.set(x, groundY + CAP_Y, z);
        _m.compose(_p, _q, _s);
        region.caps.setMatrixAt(target, _m);
    }
    region.poles.instanceMatrix.needsUpdate = true;
    region.heads.instanceMatrix.needsUpdate = true;
    region.caps.instanceMatrix.needsUpdate = true;
    region.tiles.set(tileKey, entry);
    updateLampRegionCount(region);
    tileLamps.set(tileKey, entry);
    lampPositionsRevision += 1;
}

function buildTile(tileKey, features) {
    if (!lampsGroup) return false;
    const rect = tileRectFromKey(tileKey);
    const candidates = [];
    for (const f of features) {
        collectLampsForFeature(f, rect, candidates);
        if (candidates.length >= MAX_LAMPS_PER_TILE) break;
    }
    const lamps = roadVerticalAlignmentModel
        ? candidates.filter(({ x, z, osmId }) => !roadFurnitureBlockedByOverpass(
            roadVerticalAlignmentModel.structureAtLocal(x, z),
            osmId,
        ))
        : candidates;
    if (lamps.length === 0) {
        publishTileEntry(tileKey, null);
        return true;
    }

    // A lamp is a terrain-relative static object. Resolve the complete tile
    // before allocating/publishing any mesh; visual fallback ground is an
    // opaque backstop, not placement evidence.
    for (const lamp of lamps) {
        const groundY = lampGroundSceneY(lamp);
        if (groundY === null) return false;
        lamp.y = groundY;
    }

    publishTileEntry(tileKey, lamps);
    return true;
}

function removeTile(tileKey) {
    const entry = tileLamps.get(tileKey);
    tileLamps.delete(tileKey);
    tileFeatures.delete(tileKey);
    terrainDirtyTiles.delete(tileKey);
    if (!entry) return;
    disposeTileEntry(entry);
    lampPositionsRevision += 1;
}

function markAllLampTilesDirty() {
    for (const tileKey of tileFeatures.keys()) terrainDirtyTiles.add(tileKey);
}

function rebuildOneDirtyTile() {
    const next = terrainDirtyTiles.values().next();
    if (next.done) return;
    const tileKey = next.value;
    terrainDirtyTiles.delete(tileKey);
    const features = tileFeatures.get(tileKey);
    if (features) buildTile(tileKey, features);
}

function hideLampInstance(entry, index) {
    const lamp = entry?.positions?.[index];
    if (!lamp || !entry.region) return;
    const zero = new THREE.Vector3(0, 0, 0);
    for (const mesh of [entry.region.poles, entry.region.heads, entry.region.caps]) {
        const target = entry.block.offset + index;
        mesh.getMatrixAt(target, _m);
        _m.decompose(_p, _q, _s);
        _m.compose(_p, _q, zero);
        mesh.setMatrixAt(target, _m);
        mesh.instanceMatrix.needsUpdate = true;
    }
}

export function getBreakableStreetFurnitureNear(localX, localZ, radiusM = 150) {
    const radiusSq = Math.max(0, Number(radiusM) || 0) ** 2;
    const nearby = [];
    for (const entry of tileLamps.values()) {
        for (const lamp of entry?.positions || []) {
            if (destroyedLampIds.has(lamp.id)) continue;
            const dx = lamp.x - localX;
            const dz = lamp.z - localZ;
            if (dx * dx + dz * dz > radiusSq) continue;
            nearby.push({
                id: lamp.id,
                kind: 'lamp',
                x: lamp.x,
                y: lamp.y,
                z: lamp.z,
                radiusM: 0.16,
                heightM: POLE_H,
                destructive: true,
            });
        }
    }
    return nearby;
}

export function destroyStreetFurniture(id) {
    if (!id || destroyedLampIds.has(id)) return false;
    let found = false;
    for (const entry of tileLamps.values()) {
        const index = entry?.positions?.findIndex(lamp => lamp.id === id) ?? -1;
        if (index < 0) continue;
        hideLampInstance(entry, index);
        found = true;
    }
    if (!found) return false;
    destroyedLampIds.add(id);
    lampPositionsRevision += 1;
    return true;
}

function updateSurfaceLightSelection(localX, localZ) {
    const moved = Math.hypot(localX - lastSurfaceLightX, localZ - lastSurfaceLightZ);
    if (lampPositionsRevision === lastSurfaceLightRevision && moved < 4) return;
    const positions = [];
    for (const entry of tileLamps.values()) {
        if (entry && Array.isArray(entry.positions)) {
            positions.push(...entry.positions.filter(lamp => !destroyedLampIds.has(lamp.id)));
        }
    }
    updateStreetLampSurfaceLighting(
        positions,
        localX,
        localZ,
        STREET_LAMP_GLOW_RADIUS_M,
        lampPositionsRevision,
    );
    lastSurfaceLightX = localX;
    lastSurfaceLightZ = localZ;
    lastSurfaceLightRevision = lampPositionsRevision;
}

// Called from scene/sky.js when the sim hour crosses dusk / dawn. Flips the
// shared lens material and surface-light uniforms in one assignment.
export function setStreetLampNightMode(night) {
    if (night === isNight) return;
    isNight = night;
    setStreetLampModelNight(night);
    setStreetLampSurfaceNightMode(night);
}

export const streetLampsLayer = {
    beginSession({
        anchorLat: lat,
        anchorLon: lon,
        sharedTileSession,
        customTrackCorridors,
        otherTracks,
        allStops,
        terrain,
        roadFormation,
        roadVerticalAlignments,
    }) {
        terrainUnsubscribe?.();
        terrainUnsubscribe = null;
        anchorLat = lat;
        anchorLon = lon;
        terrainReference = terrain || null;
        roadFormationModel = roadFormation || null;
        roadVerticalAlignmentModel = roadVerticalAlignments || null;
        lastRoadFormationRevision = finiteOrNull(roadFormationModel?.revision);
        terrainUnsubscribe = terrainReference?.onChange?.(() => {
            markAllLampTilesDirty();
        }) || null;
        destroyedLampIds.clear();
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
        lampPositionsRevision = 0;
        lastSurfaceLightX = Infinity;
        lastSurfaceLightZ = Infinity;
        lastSurfaceLightRevision = -1;
        setStreetLampSurfaceNightMode(isNight);
        if (!lampsGroup) {
            lampsGroup = new THREE.Group();
            lampsGroup.name = 'StreetLamps';
            scene.add(lampsGroup);
        }
        // Same source key as the cars layer → the road centrelines are fetched
        // once and replayed to us, already-loaded tiles included.
        tileSource = sharedTileSession.getSource({
            key: 'roads:graph',
            label: 'cars',
            url: (bb) => `${getApiBase()}/roads?bbox=${bb.west},${bb.south},${bb.east},${bb.north}`,
            ...NEAR_ROAD_STREAM_OPTIONS,
        });
        tileSubscription = tileSource.subscribe({
            deliveryLabel: 'streetlamps:road-graph',
            onFetch: (features, tileKey) => {
                const retained = features || [];
                tileFeatures.set(tileKey, retained);
                buildTile(tileKey, retained);
            },
            onEvict: (tileKey) => removeTile(tileKey),
        });
        tileSource.ensureAround(0, 0);
    },
    onFrame(pose, local) {
        if (tileSource) tileSource.ensureAround(local.x, local.z);
        const roadRevision = finiteOrNull(roadFormationModel?.revision);
        if (roadRevision !== lastRoadFormationRevision) {
            lastRoadFormationRevision = roadRevision;
            markAllLampTilesDirty();
        }
        rebuildOneDirtyTile();
        updateSurfaceLightSelection(local.x, local.z);
    },
    endSession() {
        if (terrainUnsubscribe) terrainUnsubscribe();
        terrainUnsubscribe = null;
        if (tileSubscription) tileSubscription();
        tileSubscription = null;
        tileSource = null;
        for (const tileKey of Array.from(tileLamps.keys())) removeTile(tileKey);
        tileLamps.clear();
        for (const region of [...lampRegions.values()]) {
            region.tiles.clear();
            disposeEmptyLampRegion(region);
        }
        lampRegions.clear();
        tileFeatures.clear();
        terrainDirtyTiles.clear();
        destroyedLampIds.clear();
        customTrackCorridorVolumes = [];
        roadVerticalAlignmentModel = null;
        roadFormationModel = null;
        lastRoadFormationRevision = null;
        terrainReference = null;
        resetStreetLampSurfaceLighting();
        if (lampsGroup) {
            if (lampsGroup.parent) lampsGroup.parent.remove(lampsGroup);
            lampsGroup = null;
        }
    },
};
