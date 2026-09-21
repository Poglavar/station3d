// Worker-only comparison of immutable far tiles with live source/selection evidence.
// This index cannot publish geometry or become a world authority.
import { bakedWorldTileKey } from './baked-world-manifest.js';
import { worldTileBounds, worldTilePlacement } from './world-tile-placement.js';
import { compileLod1BuildingPrisms } from './lod1-prism-geometry.js';
import { pickFarHeightForFeature } from '../world/lod1-geometry.js';
import { farBuildingColorForUseClass } from './building-use-colors.js';
import { belongsInBuildingLayer } from './building-pipeline.js';
import { farBuildingSourceIdentity } from './far-building-source.js';

function canonical(value) {
    return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

// Ring start, winding and MultiPolygon ordering are not source identity changes.
function ringKey(ring) {
    const points = ring.slice(0, -1).map(point => JSON.stringify(point));
    if (!points.length) return '';
    const minimum = [...points].sort()[0];
    const candidates = [];
    for (let i = 0; i < points.length; i++) if (points[i] === minimum) {
        candidates.push(Array.from({ length: points.length }, (_, j) => points[(i + j) % points.length]).join(','));
        candidates.push(Array.from({ length: points.length }, (_, j) => points[(i - j + points.length) % points.length]).join(','));
    }
    return candidates.sort()[0];
}
export function farShadowGeometryKey(geometry) {
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates;
    if (!Array.isArray(polygons)) return null;
    return polygons.map(polygon => `${ringKey(polygon[0])}|${polygon.slice(1).map(ringKey).sort().join('|')}`).sort().join(';');
}

function featureBounds(geometry) {
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates || [];
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
        west = Math.min(west, lon); east = Math.max(east, lon);
        south = Math.min(south, lat); north = Math.max(north, lat);
    }
    return { west, east, south, north };
}
const intersects = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

export function createBakedFarShadowIndex() {
    const tiles = new Map(), entities = new Map();
    function rebuild() {
        entities.clear();
        for (const [key, tile] of tiles) {
            const primitives = new Map(tile.packet.primitives.map(p => [p.entityRanges[0].entityId, p]));
            for (const entity of tile.entities) {
                let copies = entities.get(entity.entityId);
                if (!copies) { copies = []; entities.set(entity.entityId, copies); }
                copies.push({ key, tile, entity, primitive: primitives.get(entity.entityId),
                    geometryKey: farShadowGeometryKey(entity.feature.geometry) });
            }
        }
        for (const copies of entities.values()) copies.sort((a, b) => a.key.localeCompare(b.key));
    }
    function summary() {
        let duplicateEntities = 0, duplicateCopies = 0, conflicts = 0;
        const examples = [], conflictExamples = [];
        for (const [entityId, copies] of entities) {
            if (copies.length < 2) continue;
            duplicateEntities++; duplicateCopies += copies.length - 1;
            const first = copies[0];
            const conflict = copies.some(copy => copy.geometryKey !== first.geometryKey
                || canonical(copy.entity.feature.properties) !== canonical(first.entity.feature.properties));
            if (conflict) conflicts++;
            if (conflict && conflictExamples.length < 12) conflictExamples.push({ entityId, copies: copies.map(copy => copy.key),
                geometryChanged: copies.some(copy => copy.geometryKey !== first.geometryKey),
                propertiesChanged: copies.some(copy => canonical(copy.entity.feature.properties) !== canonical(first.entity.feature.properties)) });
            if (examples.length < 12) examples.push({ entityId, copies: copies.map(copy => copy.key),
                prospectiveOwner: first.key, conflict });
        }
        return { tiles: [...tiles.keys()], entities: entities.size, duplicateEntities, duplicateCopies, conflicts, examples, conflictExamples,
            ownership: 'diagnostic-only: one prospective owner per identity; live ownership unchanged' };
    }
    return {
        put(tile) { tiles.set(bakedWorldTileKey(tile), tile); rebuild(); return summary(); },
        retain(keys) {
            const keep = new Set(keys);
            for (const key of tiles.keys()) if (!keep.has(key)) tiles.delete(key);
            rebuild(); return summary();
        },
        summary,
        compare({ kind, features, frame }) {
            const report = { examined: 0, matched: 0, outsideCoverage: 0, boundaryUnresolved: 0,
                missing: 0, changed: 0, unsupportedSource: 0, topologyChanged: 0, maxVertexDeltaM: 0, examples: [] };
            const record = (entityId, reason) => {
                report.changed++;
                if (report.examples.length < 12) report.examples.push({ entityId, reason });
            };
            for (const feature of features) {
                report.examined++;
                const props = kind === 'selected' ? null : feature.properties;
                const identity = farBuildingSourceIdentity(kind === 'selected' ? feature.sourceProperties : props);
                const source = kind === 'selected' ? (identity?.source ?? feature.source) : identity?.source;
                const objectId = kind === 'selected' ? feature.objectId : props?.object_id;
                if (typeof source !== 'string' || !source || typeof objectId !== 'string' || !objectId) {
                    // Missing/ambiguous identity is not a fabricated missing building.
                    report.unsupportedSource++;
                    if (report.examples.length < 12) report.examples.push({ liveObjectId: objectId ?? null,
                        reason: 'live source identity contract is missing or ambiguous' });
                    continue;
                }
                const entityId = `${source}:${objectId}`;
                const copies = entities.get(entityId);
                if (!copies) {
                    const bounds = featureBounds(feature.geometry);
                    const boxes = [...tiles.values()].map(tile => worldTileBounds(tile.tile));
                    if (boxes.some(box => bounds.west >= box.west && bounds.east <= box.east
                        && bounds.south >= box.south && bounds.north <= box.north)) {
                        report.missing++;
                        if (report.examples.length < 12) report.examples.push({ entityId, reason: 'missing inside covered tile' });
                    } else if (boxes.some(box => intersects(bounds, box))) report.boundaryUnresolved++;
                    else report.outsideCoverage++;
                    continue;
                }
                const copy = copies[0], entity = copy.entity;
                if (identity && entity.sourceContract && identity.contract !== entity.sourceContract) {
                    report.unsupportedSource++;
                    if (report.examples.length < 12) report.examples.push({ entityId, reason: 'live/baked source contracts differ' });
                    continue;
                }
                if (farShadowGeometryKey(feature.geometry) !== copy.geometryKey) { record(entityId, 'source footprint changed'); continue; }
                if (props && canonical(props) !== canonical(entity.feature.properties)) { record(entityId, 'source properties changed'); continue; }
                if (props && belongsInBuildingLayer(props) !== entity.drawable) { record(entityId, 'drawable policy changed'); continue; }
                if (kind !== 'selected') { report.matched++; continue; }
                if (!copy.primitive) { record(entityId, 'selected entity has no baked prism'); continue; }
                const heightM = pickFarHeightForFeature(entity.feature.properties, entity.feature.geometry, frame.anchorLat);
                if (Math.abs(heightM - feature.heightM) > 1e-9
                    || farBuildingColorForUseClass(entity.feature.properties.use_class) !== feature.color) {
                    record(entityId, 'selected height or tint changed'); continue;
                }
                // This is additional diagnostic work in the shadow Worker only.
                // The visible layer still consumes its own original live packet.
                const live = compileLod1BuildingPrisms(feature.geometry, feature.heightM, frame.anchorLon,
                    frame.anchorLat, feature.baseY, { originX: frame.tileOriginX, originZ: frame.tileOriginZ });
                const baked = copy.primitive;
                if (!live || live.positions.length !== baked.positions.length || live.indices.length !== baked.indices.length
                    || live.indices.some((value, i) => value !== baked.indices[i])) {
                    report.topologyChanged++; record(entityId, 'selected topology/order changed'); continue;
                }
                const placement = worldTilePlacement(copy.tile.tile, { anchor: { lat: frame.anchorLat, lon: frame.anchorLon } });
                let delta = 0;
                for (let i = 0; i < live.positions.length; i += 3) {
                    delta = Math.max(delta,
                        Math.abs(live.positions[i] + frame.tileOriginX - (baked.positions[i] * placement.scale.x + placement.position.x)),
                        Math.abs(live.positions[i + 1] - (baked.positions[i + 1] * heightM / entity.heightM + feature.baseY)),
                        Math.abs(live.positions[i + 2] + frame.tileOriginZ - (baked.positions[i + 2] + placement.position.z)));
                }
                report.maxVertexDeltaM = Math.max(report.maxVertexDeltaM, delta);
                if (delta > 0.0001) record(entityId, 'selected world vertices differ by more than 0.1 mm');
                else report.matched++;
            }
            return report;
        },
    };
}
