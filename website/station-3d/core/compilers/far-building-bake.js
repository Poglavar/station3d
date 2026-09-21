// Offline foundation-relative far prisms, compiled by the same pure code as the live Worker.
// All authoritative footprints survive; terrain, proposals and the runtime draw cap do not bake.
import { compileFarBuildingRenderPacket } from './far-building-render-packet.js';
import { pickFarHeightForFeature } from '../../world/lod1-geometry.js';
import { belongsInBuildingLayer } from '../building-pipeline.js';
import { farBuildingColorForUseClass } from '../building-use-colors.js';
import { BAKED_WORLD_TILE_CONTRACT, validateBakedWorldTile } from '../baked-world-tile.js';
import { worldTileFrame, worldTileBounds, WORLD_TILE_EARTH_RADIUS_M, WORLD_TILE_PROJECTION } from '../world-tile-placement.js';
import { farBuildingSourceIdentity } from '../far-building-source.js';

// 2.0.0 snapshots trusted the old DB's incomplete MultiPolygon validity check.
// 2.2.0 validates delivered geometry and records bounded numerical-hole cleanup.
export const FAR_BUILDING_BAKE_VERSION = '2.2.0';
export const FAR_BUILDING_SOURCE_VALIDATION = 'same-engine-input-selected-and-delivered-geojson';

function validateGeometry(geometry) {
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!Array.isArray(polygons) || !polygons.length) throw new TypeError('Far bake requires polygon geometry');
    for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) throw new TypeError('Missing polygon rings');
        for (const ring of polygon) {
            if (!Array.isArray(ring) || ring.length < 4) throw new TypeError('Incomplete polygon ring');
            for (const p of ring) {
                if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])
                    || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85) throw new TypeError('Invalid footprint coordinate');
            }
            if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new TypeError('Unclosed footprint ring');
        }
    }
}

export function validateFarBuildingBakeSource(snapshot) {
    const payload = snapshot?.payload;
    if (payload?.contract !== 'station3d-source-v1' || payload.schemaVersion !== 1
        || payload.layer !== 'far-buildings' || payload.queryVersion !== 'building-render-rows-v2'
        || !Array.isArray(payload.features) || !/^[0-9a-f]{64}$/.test(snapshot.sourceRevision)) {
        throw new TypeError('A complete canonical far-building source snapshot is required');
    }
    const profile = payload.simplification;
    if (profile?.engine !== 'GEOS' || profile.version !== '3.14.1' || profile.operation !== 'simplifyTP'
        || profile.toleranceM !== 1 || profile.inputSrid !== 3765 || profile.repeatedRuns !== 2
        || profile.validation !== FAR_BUILDING_SOURCE_VALIDATION
        || profile.policy !== 'valid-render-footprint-v2'
        || profile.serialization !== 'geojson-6-or-15-valid-topology'
        || profile.cleanup !== 'invalid-delivered-interior-rings-only'
        || profile.maxRemovedRingAreaM2 !== 1e-9 || profile.maxRemovedRingWidthM !== 1e-8) {
        throw new TypeError('Source requires pinned same-engine input/output validity; re-export before baking or resuming');
    }
    return payload;
}

export function compileFarBuildingBake(snapshot, { tile: identity, revision } = {}) {
    const payload = validateFarBuildingBakeSource(snapshot);
    const tile = worldTileFrame(identity);
    if (tile.z !== 15) throw new RangeError('The first far-building bake supports z15 only');
    const bounds = worldTileBounds(tile);
    const box = [bounds.west, bounds.south, bounds.east, bounds.north];
    const tileKey = `${tile.z}/${tile.x}/${tile.y}`;
    const coverage = payload.tiles?.find(entry => entry.key === tileKey);
    if (!coverage || !Array.isArray(coverage.bounds) || coverage.bounds.length !== 4
        || box.some((v, i) => typeof coverage.bounds[i] !== 'number' || Math.abs(coverage.bounds[i] - v) > 1e-10)) {
        throw new TypeError('Source snapshot coverage must match the requested global tile');
    }
    // The snapshot freezes this canonical corner once. Repeating inverse
    // Mercator in another JS runtime can differ by one double ULP, which can
    // move a Float32 vertex across a rounding boundary. Keep the stored frame.
    tile.originLon = coverage.bounds[0];
    tile.originLat = coverage.bounds[3];
    const entities = [], features = [], ids = new Set();
    for (const feature of payload.features) {
        const props = feature?.properties;
        const identity = farBuildingSourceIdentity(props);
        if (identity?.contract !== payload.queryVersion) throw new TypeError('Canonical render-row identity is missing');
        const { entityId } = identity;
        if (ids.has(entityId)) throw new TypeError(`Duplicate source entity ${entityId}`);
        ids.add(entityId);
        if (!Array.isArray(feature.tileKeys) || feature.tileKeys.some(key => !payload.tiles.some(entry => entry.key === key))) {
            throw new TypeError('Canonical entity tile membership is incomplete');
        }
        if (!feature.tileKeys.includes(tileKey)) continue;
        validateGeometry(feature.geometry);
        const heightM = pickFarHeightForFeature(props, feature.geometry, tile.originLat);
        const drawable = belongsInBuildingLayer(props);
        entities.push({ entityId, objectId: props.object_id, sourceContract: payload.queryVersion,
            parentId: feature.provenance?.landmarkId ? `landmark:${feature.provenance.landmarkId}` : entityId, feature, heightM,
            heightReferenceLat: tile.originLat, drawable });
        if (drawable) features.push({ entityId, objectId: props.object_id, geometry: feature.geometry,
            heightM, baseY: 0, color: farBuildingColorForUseClass(props.use_class) });
    }
    const packet = compileFarBuildingRenderPacket({
        tile, sourceRevision: snapshot.sourceRevision, generation: 0,
        inputs: { anchorLon: tile.originLon, anchorLat: tile.originLat, tileOriginX: 0, tileOriginZ: 0, features },
    });
    if (packet.primitives.length !== features.length) throw new Error('Far compiler omitted an expected entity');
    return validateBakedWorldTile({
        contract: BAKED_WORLD_TILE_CONTRACT, schemaVersion: 1, layer: 'far-buildings', revision,
        sourceRevision: snapshot.sourceRevision, bakeVersion: FAR_BUILDING_BAKE_VERSION,
        state: packet.primitives.length ? 'ready' : 'empty', lod: 1, tile, packet, entities,
        frame: { projection: WORLD_TILE_PROJECTION, earthRadiusM: WORLD_TILE_EARTH_RADIUS_M,
            units: 'metres', axes: 'east-up-south', vertical: { mode: 'foundation-relative', datum: null, originHeightM: 0 } },
        materials: { 'far-buildings': { profile: 'far-buildings-v1' } },
    });
}

// Height estimates depend on the session latitude today. Preserve that policy
// through a cheap instance Y scale, rather than freezing a changed estimate or
// rebuilding triangles. A missing terrain foundation is never coerced to zero.
export function bakedFarEntityPlacement(entity, { anchorLat, baseY } = {}) {
    if (typeof anchorLat !== 'number' || !Number.isFinite(anchorLat)
        || typeof baseY !== 'number' || !Number.isFinite(baseY)) return null;
    if (!(typeof entity?.heightM === 'number' && entity.heightM > 0 && Number.isFinite(entity.heightM))) {
        throw new TypeError('Invalid baked far reference height');
    }
    const heightM = pickFarHeightForFeature(entity.feature.properties, entity.feature.geometry, anchorLat);
    return { baseY, heightM, scaleY: heightM / entity.heightM };
}
