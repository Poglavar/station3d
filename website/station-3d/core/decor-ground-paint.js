// Decor contributes colour to existing ordinary receivers.
// No height samples, collision promises or ground-removal claims are produced.
import { createGroundSurfacePaintRecordSteps } from './ground-surface-paint.js';
import { createRoadFeatureIdentityIndex } from './road-feature-identity.js';
import { compileSurfaceClaim, SURFACE_CLASS } from './surface-hierarchy.js';
import { groundPaintCapacity } from './ground-paint-source-plans.js';

const identities = createRoadFeatureIdentityIndex({ dataset: 'decor-ground' });
export const DECOR_LANDUSE_TYPES = Object.freeze(['green', 'forest', 'paving', 'flowerbed', 'sand', 'playground', 'fitness']);
const classes = { parking: SURFACE_CLASS.PARKING, construction: SURFACE_CLASS.CONSTRUCTION,
    ...Object.fromEntries(DECOR_LANDUSE_TYPES.map(type => [type, SURFACE_CLASS.PASSIVE_LANDUSE])),
    edging: SURFACE_CLASS.PASSIVE_EDGING };
const explicit = value => value != null && !['', 'no', 'false', '0'].includes(String(value).toLowerCase());

export function decorGroundPaintEligible(type, properties = {}) {
    if (!Object.hasOwn(classes, type) || properties.semantic === 'fountain') return false;
    const tags = properties.tags || {};
    if (['bridge', 'tunnel', 'level', 'ele'].some(key => explicit(properties[key]) || explicit(tags[key]))) return false;
    const layer = properties.layer ?? tags.layer;
    return layer == null || layer === '' || Number(layer) === 0;
}

export function* createDecorGroundPaintOwnerSteps({ type, sourceId, rings, polygons = [rings], receiver, materialKey, materialRevision }) {
    if (!Object.hasOwn(classes, type)) throw new TypeError('Unsupported decor ground paint class');
    let vertices = 0, minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const coordinates = [];
    for (const polygon of polygons) {
      const polygonCoordinates = [];
      for (const ring of polygon) {
        const points = [];
        for (const { x, z } of ring) {
            if (++vertices > 8192) throw groundPaintCapacity('Decor paint vertex capacity exceeded');
            if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('Decor paint requires finite coordinates');
            points.push([x, z]);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
            if (vertices % 128 === 0) yield { phase: 'decor-paint-source' };
        }
        polygonCoordinates.push(points);
      }
      coordinates.push(polygonCoordinates);
    }
    const geometry = { type: 'MultiPolygon', coordinates };
    const identity = identities.identityFor({ geometry, properties: { type, sourceId: sourceId ?? null } });
    const key = `decor:${type}:${identity.geometrySignature}:${identity.contentSignature}`;
    const record = yield* createGroundSurfacePaintRecordSteps({ geometry,
        identity: { key, revisionKey: identity.revisionKey }, receiver, materialKey, materialRevision,
        project: (x, z) => ({ x, z }),
        claim: compileSurfaceClaim({ surfaceClass: classes[type], ownerId: key,
            verticalBand: receiver.verticalBand, verticalRelation: 'same-level' }),
        // Match the old land-use classification order where mapped uses
        // overlap: forest over grass, then paved/soil/sport surfaces.
        sourcePriority: DECOR_LANDUSE_TYPES.indexOf(type) + 1,
    });
    return Object.freeze({ bucketKey: `DecorPaint@${Math.floor((minX + maxX) / 800)}_${Math.floor((minZ + maxZ) / 800)}`,
        owner: key, records: Object.freeze([record]), canonical: identity.canonical });
}
