// Adapt immutable global far tiles to the existing local tile/selection contract.
// Geometry stays untouched: runtime placement uses per-instance matrices.
import { bakedWorldTileKey } from './baked-world-manifest.js';
import { worldTileAt, worldTilePlacement } from './world-tile-placement.js';
import { bakedFarEntityPlacement } from './compilers/far-building-bake.js';
import { farBuildingSourceIdentity } from './far-building-source.js';

export function bakedFarCoverage(manifest, bbox) {
    const nw = worldTileAt(bbox.west, bbox.north, 15);
    const se = worldTileAt(bbox.east - 1e-10, bbox.south + 1e-10, 15);
    if (se.x < nw.x || se.y < nw.y || (se.x - nw.x + 1) * (se.y - nw.y + 1) > 9) return null;
    const descriptors = new Map(manifest.tiles.map(tile => [bakedWorldTileKey(tile), tile]));
    const result = [];
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) {
        const descriptor = descriptors.get(`far-buildings/1/15/${x}/${y}`);
        if (!descriptor) return null; // A partly covered local tile remains wholly live.
        result.push(descriptor);
    }
    return result.length ? result : null;
}

function geometryBounds(geometry) {
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!polygons?.length) throw new Error('Baked far entity has no footprint');
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('Invalid baked far footprint coordinate');
        west = Math.min(west, lon); east = Math.max(east, lon);
        south = Math.min(south, lat); north = Math.max(north, lat);
    }
    return { west, east, south, north };
}

// Run beside the decoder in the Worker; do not scan whole decoded tile geometry
// on the render thread just to build a geographic lookup.
export function indexBakedFarTile(tile) {
    const primitives = new Map(tile.packet.primitives.map(p => [p.entityRanges[0].entityId, p]));
    const records = tile.entities.map(entity => {
        if (farBuildingSourceIdentity(entity.feature?.properties)?.entityId !== entity.entityId) {
            throw new Error('Baked far source identity mismatch');
        }
        const primitive = primitives.get(entity.entityId);
        if (entity.drawable && !primitive) throw new Error('Drawable baked entity has no primitive');
        return { entity, primitive, bounds: geometryBounds(entity.feature.geometry) };
    });
    return { tile, records };
}

const intersects = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
function sameEntity(a, b) {
    const af = a.entity.feature, bf = b.entity.feature;
    const aShape = af.provenance?.geometrySha256 || JSON.stringify(af.geometry);
    const bShape = bf.provenance?.geometrySha256 || JSON.stringify(bf.geometry);
    return aShape === bShape && JSON.stringify(af.properties) === JSON.stringify(bf.properties);
}

export function selectBakedFarFeatures(indexedTiles, bbox, limit = 600) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 600) throw new Error('Invalid baked far draw cap');
    const records = new Map();
    let sourceRevision = null;
    for (const indexed of indexedTiles) {
        if (sourceRevision && sourceRevision !== indexed.tile.sourceRevision) throw new Error('Mixed baked far source snapshots');
        sourceRevision = indexed.tile.sourceRevision;
        for (const record of indexed.records) {
            if (!intersects(record.bounds, bbox)) continue;
            const previous = records.get(record.entity.entityId);
            if (previous && !sameEntity(previous, record)) throw new Error('Conflicting baked far border copies');
            if (!previous) records.set(record.entity.entityId, { ...record, tile: indexed.tile });
        }
    }
    // Keep the live API's frozen priority/cap BEFORE proposal and drawable
    // filtering. Geographic bounds and deterministic ID ties are pilot policy;
    // this is not claimed to reproduce PostGIS's projected-box edge selection.
    const priority = record => {
        const value = record.entity.feature.selection?.priority;
        if (value === null) return Infinity; // PostgreSQL DESC NULLS FIRST.
        if (!Number.isFinite(value)) throw new Error('Baked far selection priority is missing');
        return value;
    };
    const selected = [...records.values()].sort((a, b) => {
        const ap = priority(a), bp = priority(b);
        return (ap === bp ? 0 : ap > bp ? -1 : 1) || a.entity.entityId.localeCompare(b.entity.entityId);
    }).slice(0, limit);
    const byObject = new Map();
    for (const record of selected) {
        if (byObject.has(record.entity.objectId)) throw new Error('Baked far picking IDs collide');
        byObject.set(record.entity.objectId, record);
    }
    return { features: selected.map(record => record.entity.feature), records: byObject, sourceRevision };
}

export function prepareBakedFarPacket(request, selection) {
    const placements = new Map();
    const primitives = request.inputs.features.map(feature => {
        const record = selection.records.get(feature.objectId);
        if (!record?.primitive) throw new Error('Selected far building has no baked geometry');
        const vertical = bakedFarEntityPlacement(record.entity, { anchorLat: request.inputs.anchorLat, baseY: feature.baseY });
        if (!vertical) throw new Error('Baked far geometry requires live terrain evidence');
        const placement = worldTilePlacement(record.tile.tile, {
            anchor: { lon: request.inputs.anchorLon, lat: request.inputs.anchorLat }, vertical: record.tile.frame.vertical,
        });
        placements.set(feature.objectId, {
            x: placement.position.x - request.inputs.tileOriginX,
            y: vertical.baseY, z: placement.position.z - request.inputs.tileOriginZ,
            scaleX: placement.scale.x, scaleY: vertical.scaleY,
        });
        return { ...record.primitive, entityRanges: record.primitive.entityRanges.map(range => ({
            ...range, metadata: { ...range.metadata, nearKey: feature.nearKey, color: feature.color },
        })) };
    });
    return { placements, sourceRevision: selection.sourceRevision,
        packet: { schemaVersion: 1, compilerId: request.compilerId, compilerVersion: request.compilerVersion,
            sourceRevision: request.sourceRevision, generation: request.generation, tile: request.tile, primitives } };
}
