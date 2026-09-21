// Renderer-independent material coverage for ONE explicitly resolved physical
// receiver. Source ownership is supplied by the existing producer/publication
// registry; this private index neither chooses physical support nor cuts ground.
import { createMutableBoundsGrid } from './bounds-grid.js';
import { pointInMask } from './mask-query.js';
import {
    asSurfaceClaim, reviseSurfaceClaim, surfacePolicy,
    SURFACE_COVERAGE_STATE,
} from './surface-hierarchy.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const identity = (value, label) => {
    if (typeof value !== 'string' || !value) throw new TypeError(`${label} is required`);
    return value;
};
function bounds(value) {
    if (!value || !['minX', 'minZ', 'maxX', 'maxZ'].every(key => finite(value[key]))
        || value.maxX <= value.minX || value.maxZ <= value.minZ) throw new TypeError('Invalid paint bounds');
    return Object.freeze({ minX: value.minX, minZ: value.minZ, maxX: value.maxX, maxZ: value.maxZ });
}
const intersects = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
const contains = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
function binding(input) {
    return Object.freeze({
        key: identity(input?.key, 'receiver key'),
        verticalBand: identity(input?.verticalBand, 'receiver vertical band'),
        // Height generations may reuse colour. A changed footprint, opening or
        // receiver assignment must change this separate revision.
        coverageRevision: identity(input?.coverageRevision, 'receiver coverage revision'),
    });
}
const sameBinding = (a, b) => a?.key === b?.key && a?.verticalBand === b?.verticalBand
    && a?.coverageRevision === b?.coverageRevision;
// Higher class rank wins. Equal-rank source priority must be assigned by the
// shared source/style adapter; stable identity breaks remaining ties. Neither
// arrival order nor drawing bucket chooses an overlapping material.
export const compareGroundPaint = (a, b) => a.claim.rank - b.claim.rank
    || a.sourcePriority - b.sourcePriority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function* copyFootprint(polygons, counter, limits, verticesPerStep) {
    if (!Array.isArray(polygons) || !polygons.length) throw new TypeError('Paint requires polygon rings');
    const copied = [];
    const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    let recordVertices = 0;
    for (const polygon of polygons) {
        if (!Array.isArray(polygon?.holeRings)) throw new TypeError('Explicit hole rings are required');
        const rings = [];
        for (const source of [polygon.outerRing, ...polygon.holeRings]) {
            if (!Array.isArray(source) || source.length < 3) throw new TypeError('Invalid paint ring');
            const ring = [];
            for (const point of source) {
                if (!finite(point?.x) || !finite(point?.z)) throw new TypeError('Paint vertices must be finite local X/Z');
                if (++counter.vertices > limits.vertices || ++recordVertices > limits.verticesPerRecord) {
                    throw new RangeError('Paint vertex budget exceeded');
                }
                const { x, z } = point;
                ring.push(Object.freeze({ x, z }));
                box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
                box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
                if (counter.vertices % verticesPerStep === 0) yield { phase: 'paint-vertices', vertices: counter.vertices };
            }
            rings.push(Object.freeze(ring));
        }
        copied.push(Object.freeze({ outerRing: rings[0], holeRings: Object.freeze(rings.slice(1)) }));
    }
    return { polygons: Object.freeze(copied), bounds: bounds(box) };
}

// Producers retain immutable source records across yields, just as the road
// identity index and terrain compiler do. Only the completed return value may
// be published. Limits are explicit prototype/device inputs, never truncation.
export function* createGroundCompositePlanSteps({
    receiver, records, limits, cellM = 24, verticesPerStep = 128,
}) {
    const receiverBinding = binding(receiver);
    const receiverBounds = bounds(receiver.bounds);
    for (const key of ['records', 'vertices', 'verticesPerRecord', 'oversized']) {
        if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0) throw new TypeError(`Explicit paint ${key} budget required`);
    }
    if (!finite(cellM) || cellM <= 0 || !Number.isSafeInteger(verticesPerStep) || verticesPerStep < 1) {
        throw new TypeError('Invalid paint work limits');
    }
    if (!Array.isArray(records) || records.length > limits.records) throw new RangeError('Paint record budget exceeded');
    const sources = records.slice();
    const grid = createMutableBoundsGrid({ cellM });
    const recordsByKey = new Map();
    const counter = { vertices: 0 };
    for (const input of sources) {
        const key = identity(input?.key, 'paint source owner');
        if (recordsByKey.has(key)) throw new Error(`Duplicate paint owner ${key}; select one source revision before composition`);
        const sourceRevision = identity(input.sourceRevision, 'paint source revision');
        const materialRevision = identity(input.materialRevision, 'paint material revision');
        const materialKey = identity(input.materialKey, 'paint material recipe');
        if (!sameBinding(receiverBinding, input.receiver)) throw new Error(`Paint ${key} belongs to a different receiver`);
        const sourceClaim = asSurfaceClaim(input.claim);
        if (sourceClaim.verticalBand !== receiverBinding.verticalBand
            || sourceClaim.coverageState !== SURFACE_COVERAGE_STATE.PUBLISHED
            || !sourceClaim.capabilities.color || !surfacePolicy(sourceClaim.surfaceClass).sameLevelComparable
            || !finite(sourceClaim.rank)) throw new Error(`Paint ${key} lacks published same-receiver colour authority`);
        const sourcePriority = input.sourcePriority ?? 0;
        if (!Number.isSafeInteger(sourcePriority)) throw new TypeError('Invalid paint source priority');
        const footprint = yield* copyFootprint(input.polygons, counter, limits, verticesPerStep);
        const record = Object.freeze({ key, sourceRevision, materialRevision, materialKey,
            receiver: receiverBinding, sourcePriority, visible: input.visible !== false,
            // Material coverage cannot provide support or remove a backstop.
            claim: reviseSurfaceClaim(sourceClaim, { supportReady: false, cutsBackstop: false }),
            ...footprint,
        });
        recordsByKey.set(key, record);
        if (record.visible && intersects(receiverBounds, record.bounds)) grid.set(key, record);
        if (grid.stats().oversized > limits.oversized) throw new RangeError('Oversized paint query budget exceeded');
        yield { phase: 'paint-record', records: recordsByKey.size, vertices: counter.vertices };
    }
    const commands = Object.freeze([...recordsByKey.values()].filter(record => record.visible
        && intersects(record.bounds, receiverBounds)).sort(compareGroundPaint));
    const byKey = key => recordsByKey.get(key) || null;
    return Object.freeze({
        contract: 'station3d-ground-composite-plan-v1', receiver: receiverBinding, bounds: receiverBounds,
        commands, sourceKeys: Object.freeze([...recordsByKey.keys()]), byKey,
        stats: Object.freeze({ ...grid.stats(), vertices: counter.vertices, records: recordsByKey.size }),
        paintAt(x, z, requestedReceiver) {
            if (!sameBinding(receiverBinding, requestedReceiver) || !finite(x) || !finite(z)
                || !contains(receiverBounds, x, z)) return null;
            let winner = null;
            for (const record of grid.candidatesAt(x, z)) {
                if (pointInMask(x, z, record) && (!winner || compareGroundPaint(record, winner) > 0)) winner = record;
            }
            return winner;
        },
        // Only material contributors are returned. The renderer clips/rasterizes
        // them on this receiver's actual physical triangles/openings; a bounds
        // rectangle does not grant support or permission to fill a terrain cut.
        commandsInBounds(requestedBounds) {
            const box = bounds(requestedBounds);
            if (!intersects(receiverBounds, box)) return [];
            const clipped = {
                minX: Math.max(box.minX, receiverBounds.minX), minZ: Math.max(box.minZ, receiverBounds.minZ),
                maxX: Math.min(box.maxX, receiverBounds.maxX), maxZ: Math.min(box.maxZ, receiverBounds.maxZ),
            };
            return grid.candidatesInBox(clipped.minX, clipped.minZ, clipped.maxX, clipped.maxZ)
                .filter(record => intersects(record.bounds, clipped)).sort(compareGroundPaint);
        },
    });
}

// Source adapters must change sourceRevision for geometry/claim changes and
// materialRevision for recipe/style changes. Terrain height-only revisions do
// not alter this plan. Removing/hiding a contributor replays every surviving
// contributor in these regions; it does not clear just the deleted colour.
export function groundPaintInvalidationBounds(previous, next) {
    if (!previous) return next ? [next.bounds] : [];
    if (!next) return [previous.bounds];
    if (!sameBinding(previous.receiver, next.receiver)
        || ['minX', 'minZ', 'maxX', 'maxZ'].some(key => previous.bounds[key] !== next.bounds[key])) {
        return [previous.bounds, next.bounds];
    }
    const changed = [];
    const keys = new Set([...previous.sourceKeys, ...next.sourceKeys]);
    for (const key of keys) {
        const a = previous.byKey(key), b = next.byKey(key);
        if (a && b && a.sourceRevision === b.sourceRevision && a.materialRevision === b.materialRevision
            && a.materialKey === b.materialKey && a.visible === b.visible && a.sourcePriority === b.sourcePriority) continue;
        if (a?.visible) changed.push(a.bounds);
        if (b?.visible) changed.push(b.bounds);
    }
    return changed;
}
