// Pure material coverage records. Geometry and support belong to the receiving
// surface; these immutable source records grant colour ownership only.
import { compileSurfaceClaim, reviseSurfaceClaim, SURFACE_CLASS,
    SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from './surface-hierarchy.js';
import { groundPaintCapacity } from './ground-paint-source-plans.js';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const paintClasses = new Set([SURFACE_CLASS.SIDEWALK, SURFACE_CLASS.BUFFERED_SIDEWALK,
    SURFACE_CLASS.ROAD_CARRIAGEWAY, SURFACE_CLASS.CYCLEWAY, SURFACE_CLASS.PARKING,
    SURFACE_CLASS.CONSTRUCTION, SURFACE_CLASS.PASSIVE_LANDUSE, SURFACE_CLASS.PASSIVE_EDGING]);

function projectCoordinate(coordinate, project) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) throw new TypeError('Invalid ground paint coordinate');
    if (!finite(coordinate[0]) || !finite(coordinate[1]) || typeof project !== 'function') throw new TypeError('Ground paint requires finite coordinates and a projection');
    const value = project(coordinate[0], coordinate[1]);
    const x = value?.x;
    const z = value?.z;
    if (!finite(x) || !finite(z)) throw new TypeError('Ground paint coordinate projection must be finite');
    return Object.freeze({ x, z });
}

export function* createGroundSurfacePaintRecordSteps({ geometry, identity, receiver, project, claim,
    materialKey, materialRevision, sourcePriority = 0, verticesPerStep = 128, maxVertices = 8192 } = {}) {
    if (!identity?.key || !identity?.revisionKey) throw new TypeError('Canonical ground paint identity required');
    if (!receiver?.key || !receiver?.verticalBand || !receiver?.coverageRevision) throw new TypeError('Ground paint receiver required');
    if (!Number.isSafeInteger(verticesPerStep) || verticesPerStep < 1 || !Number.isSafeInteger(maxVertices) || maxVertices < 1) throw new TypeError('Invalid ground paint limits');
    if (typeof materialKey !== 'string' || !materialKey || typeof materialRevision !== 'string' || !materialRevision) throw new TypeError('Ground paint material identity required');
    const initial = claim ? compileSurfaceClaim(claim) : compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.SIDEWALK, verticalBand: receiver.verticalBand, verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL });
    if (initial.verticalRelation !== SURFACE_VERTICAL_RELATION.SAME_LEVEL || initial.verticalBand !== receiver.verticalBand) throw new Error('Contradictory ground paint claim relation');
    if (!paintClasses.has(initial.surfaceClass) || !initial.capabilities.color) throw new Error('Unsupported ground paint surface class');
    if (!Number.isSafeInteger(sourcePriority)) throw new TypeError('Ground paint source priority must be an integer');
    const source = reviseSurfaceClaim(initial, { coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, paintsColor: true, supportReady: false, cutsBackstop: false });
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new TypeError('Ground paint requires Polygon or MultiPolygon geometry');
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polys) || !polys.length) throw new TypeError('Invalid ground paint polygon rings');
    const polygons = [];
    let vertices = 0;
    for (const poly of polys) {
        if (!Array.isArray(poly) || !poly.length) throw new TypeError('Invalid ground paint polygon rings');
        const rings = [];
        for (const ringSource of poly) {
            if (!Array.isArray(ringSource) || ringSource.length < 3) throw new TypeError('Invalid ground paint ring');
            const ring = [];
            for (const point of ringSource) {
                if (vertices >= maxVertices) throw groundPaintCapacity('Ground paint vertex budget exceeded');
                ring.push(projectCoordinate(point, project));
                vertices++;
                if (vertices % verticesPerStep === 0) yield { phase: 'ground-paint-vertices', vertices };
            }
            rings.push(Object.freeze(ring));
        }
        polygons.push(Object.freeze({ outerRing: rings[0], holeRings: Object.freeze(rings.slice(1)) }));
    }
    return Object.freeze({ contract: 'station3d-ground-surface-paint-record-v1', key: identity.key, sourceRevision: identity.revisionKey,
        materialKey, materialRevision, claim: source, receiver: Object.freeze({ ...receiver }), receiverBinding: Object.freeze({ ...receiver }),
        sourcePriority, polygons: Object.freeze(polygons), rings: Object.freeze(polygons.flatMap(p => [p.outerRing, ...p.holeRings])), vertices });
}
