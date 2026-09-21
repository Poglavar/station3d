// Normalizes every source-backed checker payload into one geometry/metadata contract.

import { osmElementKey, sourceEntityKey } from './entity-key.js';

export const DECOR_KINDS = Object.freeze([
    'trees',
    'greenery',
    'hedges',
    'crossings',
    'footpaths',
    'benches',
    'fountains',
    'traffic_lights',
]);

const DECOR_TYPES = Object.freeze({
    trees: 'tree',
    greenery: 'surface',
    hedges: 'hedge',
    crossings: 'crossing',
    footpaths: 'footpath',
    benches: 'bench',
    fountains: 'fountain',
    traffic_lights: 'traffic_light',
});

const DECOR_NAMES = Object.freeze({
    tree: 'OSM stablo',
    surface: 'OSM površina',
    hedge: 'OSM živica',
    crossing: 'OSM pješački prijelaz',
    footpath: 'OSM pješačka staza',
    bench: 'OSM klupa',
    fountain: 'OSM fontana',
    traffic_light: 'OSM semafor',
    railway: 'OSM željeznica',
    stop: 'Stajalište',
});

export const DECOR_TILE_SIZE_DEG = 0.02;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function roundedNumber(value) {
    const number = finiteNumber(value);
    return number == null ? null : Number(number.toFixed(7));
}

function normalizedForHash(value) {
    if (Array.isArray(value)) return value.map(normalizedForHash);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, normalizedForHash(value[key])]),
        );
    }
    if (typeof value === 'number') return roundedNumber(value);
    return value == null ? null : String(value);
}

export function stableSnapshotId(value) {
    const input = JSON.stringify(normalizedForHash(value));
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index++) {
        const code = input.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function sourceIdentity(entityType, signature, raw = null) {
    const osmType = String(raw?.osm_type || raw?.osmType || '').trim().toLowerCase();
    const osmId = raw?.osm_id ?? raw?.osmId;
    const directKey = osmElementKey(osmType, osmId);
    if (directKey) {
        return {
            key: directKey,
            source: 'osm',
            sourceLabel: 'OSM',
            osmType,
            osmId: String(osmId),
        };
    }
    return {
        key: sourceEntityKey('osm-snapshot', entityType, stableSnapshotId(signature)),
        source: 'osm',
        sourceLabel: 'OSM snimka',
        osmType: null,
        osmId: null,
    };
}

function visitCoordinates(value, visitor) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && finiteNumber(value[0]) != null && finiteNumber(value[1]) != null) {
        visitor(Number(value[0]), Number(value[1]));
        return;
    }
    for (const child of value) visitCoordinates(child, visitor);
}

export function geometryHit(geometry) {
    if (!geometry) return null;
    let lonSum = 0;
    let latSum = 0;
    let count = 0;
    visitCoordinates(geometry.coordinates, (lon, lat) => {
        lonSum += lon;
        latSum += lat;
        count += 1;
    });
    if (count === 0) return null;
    return { lat: latSum / count, lon: lonSum / count };
}

function record({ entityType, geometry, identity, name = null, ...metadata }) {
    if (!geometry || !identity?.key) return null;
    return {
        key: identity.key,
        geometry,
        metadata: {
            ...identity,
            entityType,
            name: name || DECOR_NAMES[entityType] || entityType,
            hit: geometryHit(geometry),
            ...metadata,
        },
    };
}

function pointDecorRecord(kind, item) {
    const entityType = DECOR_TYPES[kind];
    const array = Array.isArray(item) ? item : [];
    const lat = finiteNumber(item?.lat ?? array[0]);
    const lon = finiteNumber(item?.lon ?? item?.lng ?? array[1]);
    if (lat == null || lon == null) return null;
    const extra = finiteNumber(item?.value ?? array[2]);
    const sourceInfo = item?.source || (array[3] && typeof array[3] === 'object' ? array[3] : null);
    const geometry = { type: 'Point', coordinates: [lon, lat] };
    const metadata = {};
    if (kind === 'trees') {
        metadata.heightMeters = extra;
        metadata.treeType = array[4] || item?.treeType || null;
    }
    else if (kind === 'fountains') metadata.radiusMeters = extra;
    else metadata.bearingDegrees = extra;
    return record({
        entityType,
        geometry,
        identity: sourceIdentity(entityType, [kind, lon, lat], sourceInfo),
        decorKind: kind,
        ...metadata,
    });
}

function hedgeRecord(item) {
    const coordinates = Array.isArray(item) ? item : item?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const sourceInfo = !Array.isArray(item) ? item?.source || item : null;
    const geometry = { type: 'LineString', coordinates };
    return record({
        entityType: 'hedge',
        geometry,
        identity: sourceIdentity('hedge', ['hedges', coordinates], sourceInfo),
        decorKind: 'hedges',
    });
}

function footpathRecord(item) {
    const array = Array.isArray(item) ? item : [];
    const lon1 = finiteNumber(item?.lon1 ?? array[0]);
    const lat1 = finiteNumber(item?.lat1 ?? array[1]);
    const lon2 = finiteNumber(item?.lon2 ?? array[2]);
    const lat2 = finiteNumber(item?.lat2 ?? array[3]);
    if ([lon1, lat1, lon2, lat2].some((value) => value == null)) return null;
    const widthMeters = finiteNumber(item?.width ?? array[4]);
    const sourceInfo = item?.source || (array[5] && typeof array[5] === 'object' ? array[5] : null);
    const geometry = {
        type: 'LineString',
        coordinates: [[lon1, lat1], [lon2, lat2]],
    };
    return record({
        entityType: 'footpath',
        geometry,
        identity: sourceIdentity('footpath', ['footpaths', geometry.coordinates], sourceInfo),
        decorKind: 'footpaths',
        widthMeters,
    });
}

function greeneryRecords(payload, tileKey) {
    const records = [];
    for (const feature of payload?.features || []) {
        if (!feature?.geometry) continue;
        const properties = feature.properties || {};
        const surfaceType = properties.t || properties.type || 'green';
        const entityType = properties.semantic === 'fountain' ? 'fountain' : 'surface';
        const identity = sourceIdentity(
            entityType,
            ['greenery', tileKey || '', entityType, surfaceType, feature.geometry],
            properties,
        );
        const normalized = record({
            entityType,
            geometry: feature.geometry,
            identity,
            decorKind: 'greenery',
            surfaceType,
            name: entityType === 'fountain'
                ? DECOR_NAMES.fountain
                : `OSM površina · ${surfaceType}`,
            semantic: properties.semantic || null,
            tags: properties.tags || {},
        });
        if (normalized) records.push(normalized);
    }
    return records;
}

export function normalizeDecorPayload(kind, payload, { tileKey = '' } = {}) {
    if (!DECOR_KINDS.includes(kind)) return [];
    if (kind === 'greenery') return greeneryRecords(payload, tileKey);
    const records = [];
    for (const item of Array.isArray(payload) ? payload : []) {
        const normalized = kind === 'hedges'
            ? hedgeRecord(item)
            : kind === 'footpaths'
                ? footpathRecord(item)
                : pointDecorRecord(kind, item);
        if (normalized) records.push(normalized);
    }
    return records;
}

export function normalizeWaterCollection(collection) {
    const records = [];
    for (const feature of collection?.features || []) {
        const properties = feature?.properties || {};
        const id = properties.id;
        const key = sourceEntityKey('overture', 'water', id);
        if (!key || !feature?.geometry) continue;
        const subtype = properties.subtype || properties.class || 'water';
        const normalized = record({
            entityType: 'water',
            geometry: feature.geometry,
            identity: {
                key,
                source: 'overture',
                sourceLabel: 'Overture',
                osmType: null,
                osmId: null,
            },
            objectId: String(id),
            waterType: subtype,
            name: `Overture voda · ${subtype}`,
            tags: properties,
        });
        if (normalized) records.push(normalized);
    }
    return records;
}

export function normalizeTrackCollection(collection, { railwayType = null } = {}) {
    const records = [];
    for (const feature of collection?.features || []) {
        const properties = feature?.properties || {};
        const osmId = properties.osm_id ?? properties.osmId;
        const railway = properties.railway_type || properties.railway || railwayType || 'rail';
        const identity = osmElementKey('way', osmId)
            ? {
                key: osmElementKey('way', osmId),
                source: 'osm',
                sourceLabel: 'OSM',
                osmType: 'way',
                osmId: String(osmId),
            }
            : sourceIdentity('railway', ['railway', railway, feature.geometry], properties);
        const tags = properties.tags && typeof properties.tags === 'object'
            ? properties.tags
            : {};
        const normalized = record({
            entityType: 'railway',
            geometry: feature.geometry,
            identity,
            railway,
            name: properties.name || `OSM ${railway === 'tram' ? 'tramvajska pruga' : 'željeznica'}`,
            tags,
            electrified: properties.electrified ?? tags.electrified ?? null,
            voltage: properties.voltage ?? tags.voltage ?? null,
            frequency: properties.frequency ?? tags.frequency ?? null,
            featureBounds: properties.bounds || properties.bbox || null,
            widthMeters: finiteNumber(properties.width_meters) || 2.4,
        });
        if (normalized) records.push(normalized);
    }
    return records;
}

export function normalizeStops(stops) {
    const records = [];
    const entries = Array.isArray(stops)
        ? stops.map((stop, index) => [stop?.id ?? index, stop])
        : Object.entries(stops || {});
    for (const [fallbackId, stop] of entries) {
        const lat = finiteNumber(stop?.lat);
        const lon = finiteNumber(stop?.lng ?? stop?.lon);
        if (lat == null || lon == null) continue;
        const osmId = stop?.osmId ?? stop?.osm_id;
        const osmKey = osmElementKey('node', osmId);
        const key = osmKey || sourceEntityKey('zet', 'stop', stop?.id ?? fallbackId);
        if (!key) continue;
        const normalized = record({
            entityType: 'stop',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            identity: {
                key,
                source: osmKey ? 'osm' : 'zet',
                sourceLabel: osmKey ? 'OSM' : 'ZET / GTFS',
                osmType: osmKey ? 'node' : null,
                osmId: osmKey ? String(osmId) : null,
            },
            objectId: String(stop?.id ?? fallbackId),
            name: stop?.name || 'Stajalište',
            stopType: stop?.type || stop?.stopType || null,
        });
        if (normalized) records.push(normalized);
    }
    return records;
}

export function alignedDecorTiles(bounds, tileSize = DECOR_TILE_SIZE_DEG) {
    const west = finiteNumber(bounds?.west);
    const south = finiteNumber(bounds?.south);
    const east = finiteNumber(bounds?.east);
    const north = finiteNumber(bounds?.north);
    if ([west, south, east, north].some((value) => value == null)
        || west >= east || south >= north || !(tileSize > 0)) return [];
    const epsilon = tileSize * 1e-9;
    const minX = Math.floor(west / tileSize);
    const maxX = Math.floor((east - epsilon) / tileSize);
    const minY = Math.floor(south / tileSize);
    const maxY = Math.floor((north - epsilon) / tileSize);
    const tiles = [];
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const tileWest = x * tileSize;
            const tileSouth = y * tileSize;
            const tileEast = tileWest + tileSize;
            const tileNorth = tileSouth + tileSize;
            tiles.push({
                key: `${x}:${y}`,
                west: tileWest,
                south: tileSouth,
                east: tileEast,
                north: tileNorth,
                bbox: [tileWest, tileSouth, tileEast, tileNorth]
                    .map((value) => value.toFixed(7))
                    .join(','),
            });
        }
    }
    return tiles;
}

export function dedupeEntityRecords(records) {
    const deduped = new Map();
    for (const item of records || []) {
        if (!item?.key) continue;
        if (!deduped.has(item.key)) deduped.set(item.key, item);
    }
    return [...deduped.values()];
}
