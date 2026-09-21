// Road appearance and physical geometry have separate eligibility. Only ordinary
// paving can surrender its draped mesh; a profiled road remains its own receiver.
import { roadVerticalAlignmentFromProperties } from './road-vertical-alignment.js';
import {
    SURFACE_CLASS, SURFACE_VERTICAL_RELATION,
} from './surface-hierarchy.js';

const pedestrianTypes = new Set(['pedestrian', 'footway', 'path']);
const explicit = v => v !== undefined && v !== null && v !== '' && v !== false && v !== 'no' && v !== '0';

export function roadGroundPaintEligible({ type, properties = {}, engineered = false,
    followsVerticalAlignment = false, followsNearbyCarriagewayProfile = false } = {}) {
    if (!pedestrianTypes.has(String(type || properties.highway_type || properties.highway || properties.tags?.highway || '').toLowerCase())) return false;
    if (engineered || followsVerticalAlignment || followsNearbyCarriagewayProfile) return false;
    if (roadVerticalAlignmentFromProperties(properties)) return false;
    const tags = properties.tags || {};
    for (const key of ['bridge', 'tunnel', 'ele', 'level', 'embankment', 'cutting']) {
        if (explicit(properties[key]) || explicit(tags[key])) return false;
    }
    for (const key of ['layer', 'raised', 'kerb']) {
        const value = properties[key] ?? tags[key];
        if (key === 'layer' ? Number.isFinite(Number(value)) && Number(value) !== 0 : (key === 'kerb' ? explicit(value) && !['no', 'flush'].includes(String(value).toLowerCase()) : explicit(value))) return false;
    }
    if (String(properties.highway || tags.highway || '').toLowerCase() === 'steps') return false;
    return true;
}

// Appearance may also bind to a retained ordinary road/path profile. Authored
// levels and grade-separated structures require their own receiver binding.
export function roadReceiverPaintEligible({ claim, properties = {}, followsVerticalAlignment = false, type } = {}) {
    if (!claim?.capabilities?.color || claim.verticalBand !== 'ground'
        || claim.verticalRelation !== SURFACE_VERTICAL_RELATION.SAME_LEVEL
        || followsVerticalAlignment || roadVerticalAlignmentFromProperties(properties)) return false;
    if (![SURFACE_CLASS.ROAD_CARRIAGEWAY, SURFACE_CLASS.BUFFERED_SIDEWALK, SURFACE_CLASS.CYCLEWAY].includes(claim.surfaceClass)
        || type === 'steps') return false;
    const tags = properties.tags || {};
    for (const key of ['bridge', 'tunnel', 'ele', 'level']) {
        if (explicit(properties[key]) || explicit(tags[key])) return false;
    }
    const layer = properties.layer ?? tags.layer;
    return layer == null || layer === '' || Number(layer) === 0;
}
