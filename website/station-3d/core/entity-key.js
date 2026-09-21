// Canonical source-object identity helpers shared by the checker and Station3D.

const ENTITY_KEY_PATTERN = /^([a-z][a-z0-9_-]*):([a-z][a-z0-9_-]*):([^:]+)$/;
const OSM_TYPES = new Set(['node', 'way', 'relation']);

function normalizedId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    return id && !id.includes(':') ? id : null;
}

function normalizedToken(value) {
    const token = String(value || '').trim().toLowerCase();
    return /^[a-z][a-z0-9_-]*$/.test(token) ? token : null;
}

export function sourceEntityKey(source, type, objectId) {
    const normalizedSource = normalizedToken(source);
    const normalizedType = normalizedToken(type);
    const id = normalizedId(objectId);
    if (!normalizedSource || !normalizedType || !id) return null;
    return `${normalizedSource}:${normalizedType}:${id}`;
}

export function osmElementKey(osmType, osmId) {
    const type = normalizedToken(osmType);
    const id = normalizedId(osmId);
    if (!OSM_TYPES.has(type) || !id || !/^[1-9]\d*$/.test(id)) return null;
    return sourceEntityKey('osm', type, id);
}

export function osmWayKey(osmId) {
    return osmElementKey('way', osmId);
}

export function buildingKey(source, objectId) {
    const normalizedSource = String(source || '').trim().toLowerCase();
    if (!['gdi', 'overture'].includes(normalizedSource)) return null;
    return sourceEntityKey(normalizedSource, 'building', objectId);
}

export function parseEntityKey(key) {
    const value = String(key || '').trim();
    const match = value.match(ENTITY_KEY_PATTERN);
    if (!match) return null;
    if (match[1] === 'osm' && OSM_TYPES.has(match[2]) && !/^[1-9]\d*$/.test(match[3])) {
        return null;
    }
    return {
        key: value,
        source: match[1],
        type: match[2],
        id: match[3],
    };
}

export function isEntityKey(key) {
    return parseEntityKey(key) !== null;
}

export function entityKeyForFeature(feature, kind = null) {
    const properties = feature?.properties || {};
    if (kind === 'road' || properties.osm_type === 'way' || properties.highway_type
        || properties.highway) {
        return osmElementKey(properties.osm_type || 'way', properties.osm_id);
    }
    return buildingKey(properties.source, properties.object_id ?? properties.id);
}
