// Normalizes API feature properties into source-explicit checker metadata.

import { buildingKey } from './entity-key.js';
import { roadSourceIdentity } from './road-feature-identity.js';

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function roadEntityMetadata(feature) {
    const properties = feature?.properties || {};
    const identity = roadSourceIdentity(feature);
    const key = identity.entityKey;
    if (!key) return null;
    const highway = properties.highway_type || properties.highway || null;
    const railway = properties.railway_type || properties.railway || null;
    return {
        key,
        source: identity.synthetic ? identity.provenance.dataset : 'osm',
        sourceLabel: identity.synthetic ? 'OSM-derived road polygons' : 'OSM',
        entityType: railway && !highway ? 'railway' : 'road',
        osmType: identity.synthetic ? null : identity.provenance.osmType,
        osmId: identity.synthetic ? null : identity.sourceId,
        sourceObjectId: identity.sourceId,
        name: properties.name || properties.tags?.name || null,
        highway,
        railway,
        widthMeters: finiteNumber(properties.width_meters),
        tags: properties.tags && typeof properties.tags === 'object' ? properties.tags : {},
    };
}

export function buildingEntityMetadata(feature, fallbackSource = null) {
    const properties = feature?.properties || {};
    const source = String(properties.source || fallbackSource || '').trim().toLowerCase();
    const objectId = properties.object_id ?? properties.id;
    const key = buildingKey(source, objectId);
    if (!key) return null;
    const names = properties.names && typeof properties.names === 'object'
        ? properties.names
        : null;
    return {
        key,
        source,
        sourceLabel: source === 'gdi' ? 'GDI' : 'Overture',
        entityType: 'building',
        objectId: String(objectId),
        renderObjectId: objectId,
        osmId: properties.osm_id == null ? null : String(properties.osm_id),
        name: properties.name || names?.primary || null,
        useClass: properties.use_class || properties.class || properties.building_type || null,
        useGroup: properties.use_group || properties.subtype || null,
        heightMeters: finiteNumber(properties.height ?? properties.height_m ?? properties.z_delta),
        eaveHeightMeters: finiteNumber(properties.eave_height_m),
        floors: finiteNumber(properties.num_floors),
        tags: properties.tags && typeof properties.tags === 'object' ? properties.tags : {},
    };
}

export function stampEntityTree(root, metadata, {
    include = (object) => object?.isMesh,
} = {}) {
    if (!root || !metadata?.key) return [];
    const stamped = [];
    const visit = (object) => {
        if (!include(object)) return;
        object.userData ||= {};
        Object.assign(object.userData, {
            entityKey: metadata.key,
            entityMetadata: metadata,
            source: metadata.source,
            objectId: object.userData.objectId ?? metadata.renderObjectId ?? metadata.objectId,
            osmId: metadata.osmId ?? object.userData.osmId,
        });
        stamped.push(object);
    };
    if (typeof root.traverse === 'function') root.traverse(visit);
    else visit(root);
    return stamped;
}
