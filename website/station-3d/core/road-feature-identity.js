// Source ownership and exact content revisions for refcounted road polygons.
// Features are immutable tile-response records; cache only while those records live.
import { osmElementKey, sourceEntityKey } from './entity-key.js';

export const ROAD_SURFACE_DATASET = 'croatia-road-surfaces';

function exactInteger(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const text = String(value).trim();
    return /^-?[1-9]\d*$/.test(text) ? text : null;
}
export function roadSourceIdentity(feature, dataset = ROAD_SURFACE_DATASET) {
    const properties = feature?.properties || {};
    const id = exactInteger(properties.osm_id);
    const synthetic = id?.startsWith('-') === true;
    const rawPart = properties.part_index ?? properties.polygon_part ?? null;
    const part = rawPart == null ? null : String(rawPart);
    if (part !== null && ((typeof rawPart !== 'string' && typeof rawPart !== 'number')
        || (typeof rawPart === 'number' && !Number.isSafeInteger(rawPart))
        || !/^(0|[1-9]\d*)$/.test(part))) throw new TypeError('Invalid explicit road source part');
    return {
        entityKey: synthetic ? sourceEntityKey(dataset, 'polygon', id)
            : osmElementKey(properties.osm_type || 'way', id),
        synthetic,
        sourceId: id,
        // Synthetic ids encode a dataset part, not recoverable OSM provenance.
        provenance: {
            dataset, source: properties.source ?? null,
            osmType: properties.osm_type ?? (synthetic ? null : 'way'),
            sourceOsmId: properties.source_osm_id ?? null,
            part,
        },
    };
}

// Booth's minimum rotation: linear visits and linear retained memory, including
// repeated vertices. Enumerating every rotation makes large paving O(n²) space.
function leastRotation(tokens) {
    const length = tokens.length;
    let first = 0, second = 1, offset = 0;
    while (first < length && second < length && offset < length) {
        const a = tokens[(first + offset) % length];
        const b = tokens[(second + offset) % length];
        if (a === b) { offset++; continue; }
        if (a > b) { first += offset + 1; if (first === second) first++; }
        else { second += offset + 1; if (first === second) second++; }
        offset = 0;
    }
    const start = Math.min(first, second);
    return tokens.slice(start).concat(tokens.slice(0, start)).join(',');
}
function canonicalRing(coordinates) {
    if (!Array.isArray(coordinates)) throw new TypeError('Invalid road polygon ring');
    const tokens = coordinates.map(point => {
        if (!Array.isArray(point) || point.length < 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            throw new TypeError('Invalid road polygon coordinate');
        }
        return JSON.stringify(point);
    });
    if (tokens.length > 1 && tokens[0] === tokens.at(-1)) tokens.pop();
    if (tokens.length < 3) throw new TypeError('Road polygon requires three vertices');
    const forward = leastRotation(tokens);
    const reverse = leastRotation(tokens.reverse());
    return `[${forward < reverse ? forward : reverse}]`;
}
function canonicalPolygon(rings) {
    if (!Array.isArray(rings) || !rings.length) throw new TypeError('Missing road polygon rings');
    // Ring zero is the exterior. Sorting it together with holes changes meaning.
    return `[${[canonicalRing(rings[0]), ...rings.slice(1).map(canonicalRing).sort()].join(',')}]`;
}
function stableJson(value) {
    return JSON.stringify(value, function (_key, item) {
        return item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
    });
}
function canonicalGeometry(geometry) {
    const polygonKeys = geometry?.type === 'Polygon' ? [canonicalPolygon(geometry.coordinates)]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates.map(canonicalPolygon) : [];
    const canonical = geometry?.type === 'Polygon' ? `Polygon:${polygonKeys[0]}`
        : geometry?.type === 'MultiPolygon' ? `MultiPolygon:[${[...polygonKeys].sort().join(',')}]`
            : stableJson(geometry ?? null);
    return { canonical, polygonKeys: Object.freeze(polygonKeys) };
}
function fingerprint(text) {
    let first = 2166136261, second = 5381;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ code, 1597334677) >>> 0;
    }
    return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

export function createRoadFeatureIdentityIndex({ dataset = ROAD_SURFACE_DATASET, hashText = fingerprint } = {}) {
    if (!sourceEntityKey(dataset, 'polygon', '1')) throw new TypeError('Invalid road dataset namespace');
    let cache = new WeakMap();
    let computed = 0;
    const conflicts = [];
    function identityFor(feature, { tileKey = '0_0', featureIndex = 0 } = {}) {
        let identity = feature && cache.get(feature);
        if (!identity) {
            const source = roadSourceIdentity(feature, dataset);
            const geometry = canonicalGeometry(feature?.geometry);
            const properties = { ...feature?.properties };
            if (source.sourceId !== null) properties.osm_id = source.sourceId;
            const content = stableJson({ properties, provenance: source.provenance });
            identity = Object.freeze({
                ...source,
                geometrySignature: hashText(geometry.canonical), contentSignature: hashText(content),
                // Exact per-polygon keys retain correspondence when equivalent
                // MultiPolygon records reorder their parts between tiles.
                polygonKeys: geometry.polygonKeys,
                // Exact comparison is required on a hash-key hit. Hashes alone
                // must never silently merge two independent source records.
                canonical: `${geometry.canonical}\n${content}`,
            });
            if (feature && typeof feature === 'object') cache.set(feature, identity);
            computed++;
        }
        const sourceKey = identity.entityKey ?? (feature?.id != null
            ? sourceEntityKey(dataset, 'feature', String(feature.id)) : null)
            ?? `tile:${tileKey}:${featureIndex}`;
        // /roads/cab returns FULL source polygons, not bbox-clipped pieces.
        // Geometry can vary with the request's taper context; a different shape
        // is a revision of this owner, never permission for a second drawing.
        // Only explicit source part provenance may split one source owner.
        const key = identity.provenance.part == null ? sourceKey
            : `${sourceKey}:part:${encodeURIComponent(String(identity.provenance.part))}`;
        return { ...identity, key,
            revisionKey: `${key}:g${identity.geometrySignature}:c${identity.contentSignature}` };
    }
    function assertCompatible(first, second) {
        if (!first || !second || first.revisionKey !== second.revisionKey || first.canonical === second.canonical) return;
        conflicts.push({ key: second.revisionKey, reason: 'content-hash-collision' });
        if (conflicts.length > 32) conflicts.shift();
        throw new Error(`Road identity hash collision: ${second.key}`);
    }
    function describeConflicts(identities) {
        const byOwner = new Map();
        const result = [];
        for (const identity of identities) {
            if (!identity?.entityKey) continue;
            const previous = byOwner.get(identity.key);
            if (previous && previous.canonical !== identity.canonical) {
                result.push({ entityKey: identity.entityKey,
                    reason: 'conflicting-full-source-variants', keys: [previous.revisionKey, identity.revisionKey].sort() });
                if (result.length >= 32) break;
            } else byOwner.set(identity.key, identity);
        }
        return result;
    }
    return { identityFor, assertCompatible, describeConflicts,
        clear() { cache = new WeakMap(); computed = 0; conflicts.length = 0; },
        debugState() { return { computed, conflicts: [...conflicts] }; },
    };
}
