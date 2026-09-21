// CPU preparation for one immutable material page. Triangulation is independent
// of terrain height; the page may only be consumed by its resolved receiver.
import { ShapeUtils, Vector2 } from 'three';
import { GROUND_PAINT_UPDATE, planGroundPaintUpdate } from './ground-paint-update.js';
import { captureGroundPaintStyles } from './ground-paint-styles.js';

export const GROUND_PAINT_PACKET = 'station3d-ground-paint-packet-v3';
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function* createGroundPaintPacketSteps({ plan, bounds, size, styles, limits, update = null }) {
    if (plan?.contract !== 'station3d-ground-composite-plan-v1' || !(styles instanceof Map)) {
        throw new TypeError('Paint page requires a completed plan and explicit material recipes');
    }
    if (!Number.isSafeInteger(size) || size < 1 || !bounds
        || !['minX', 'maxX', 'minZ', 'maxZ'].every(key => finite(bounds[key]))
        || bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) throw new TypeError('Invalid paint page dimensions');
    for (const key of ['pixels', 'draws', 'verticesPerPolygon']) {
        if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1) throw new TypeError(`Explicit paint page ${key} limit required`);
    }
    if (size * size > limits.pixels) throw new RangeError('Paint page pixel budget exceeded');
    const styleTable = captureGroundPaintStyles(styles);
    const pageBounds = Object.freeze({ ...bounds });
    update ||= planGroundPaintUpdate({ receiver: plan.receiver, bounds: pageBounds, size });
    if (update.contract !== GROUND_PAINT_UPDATE || update.size !== size
        || ['minX', 'minZ', 'maxX', 'maxZ'].some(key => update.bounds[key] !== pageBounds[key])
        || ['key', 'verticalBand', 'coverageRevision'].some(key => update.receiver[key] !== plan.receiver[key])) {
        throw new TypeError('Paint update belongs to a different page');
    }
    if (update.source && update.source.styles?.key !== styleTable.key) {
        throw new Error('Paint style table changed; copied texels require a full repaint');
    }
    const commands = new Map();
    for (const region of update.repaints) {
        for (const command of plan.commandsInBounds(region.bounds)) commands.set(command.key, command);
        yield { phase: 'paint-region-query', commands: commands.size };
    }
    // Preserve the plan's rank order even when dirty blocks found contributors
    // in a different order. No source triangulation is needed for copied blocks.
    const paintCommands = plan.commands.filter(command => commands.has(command.key));
    const draws = [];
    let vertices = 0, triangles = 0, geometryBytes = 0, submissions = 0;
    function* emitGroup(group) {
        if (!group) return;
        if (draws.length >= limits.draws) throw new RangeError('Paint page draw budget exceeded');
        const nextBytes = (group.points.length + group.faces.length) * 3 * 4;
        if (geometryBytes + nextBytes > (limits.geometryBytes ?? Infinity)) throw new RangeError('Paint page geometry byte budget exceeded');
        if (submissions + group.regions.length > (limits.submissions ?? limits.draws * update.repaints.length)) {
            throw new RangeError('Paint page submission budget exceeded');
        }
        const positions = new Float32Array(group.points.length * 3);
        for (let index = 0; index < group.points.length; index++) {
            const point = group.points[index];
            positions[index * 3] = point.x; positions[index * 3 + 1] = point.y;
            if (index % 256 === 0) yield { phase: 'paint-merge-copy', vertices: index };
        }
        const indices = new Uint32Array(group.faces.length * 3);
        for (let index = 0; index < group.faces.length; index++) {
            indices.set(group.faces[index], index * 3);
            if (index % 256 === 0) yield { phase: 'paint-merge-indices', triangles: index };
        }
        submissions += group.regions.length;
        vertices += group.points.length; triangles += group.faces.length; geometryBytes += nextBytes;
        draws.push(Object.freeze({ sources: Object.freeze(group.sources.map(source => Object.freeze(source))),
            materialKey: group.recipe.key, materialRevision: group.recipe.revision,
            styleId: group.styleId, positions, indices, regions: Object.freeze(group.regions) }));
    }
    let group = null;
    for (const command of paintCommands) {
        const recipe = styleTable.byKey(command.materialKey);
        if (!recipe || recipe.revision !== command.materialRevision
            || recipe.surfaceClass !== command.claim.surfaceClass) {
            throw new TypeError(`Missing or invalid paint recipe ${command.materialKey}`);
        }
        for (const polygon of command.polygons) {
            const sourceRings = [polygon.outerRing, ...polygon.holeRings];
            const vertexCount = sourceRings.reduce((count, ring) => count + ring.length, 0);
            if (vertexCount > limits.verticesPerPolygon) throw new RangeError('Paint triangulation item budget exceeded');
            // A source can span many pages/dirty blocks. Reject each polygon
            // before making triangulation copies, but keep skipped work cooperative.
            const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
            for (const ring of sourceRings) for (const point of ring) {
                box.minX = Math.min(box.minX, point.x); box.maxX = Math.max(box.maxX, point.x);
                box.minZ = Math.min(box.minZ, point.z); box.maxZ = Math.max(box.maxZ, point.z);
            }
            const regions = [];
            let signature = '';
            for (let index = 0; index < update.repaints.length; index++) {
                const region = update.repaints[index], b = region.bounds;
                if (box.minX <= b.maxX && box.maxX >= b.minX && box.minZ <= b.maxZ && box.maxZ >= b.minZ) {
                    regions.push(region); signature += `${index},`;
                }
            }
            if (!regions.length) {
                yield { phase: 'paint-polygon-cull' };
                continue;
            }
            // Page-local coordinates preserve centimetres far from the session
            // anchor. ShapeUtils removes duplicate closing points in these copies.
            const rings = sourceRings.map(ring => ring.map(point => new Vector2(
                point.x - pageBounds.minX, point.z - pageBounds.minZ,
            )));
            const faces = ShapeUtils.triangulateShape(rings[0], rings.slice(1));
            if (!faces.length) throw new Error(`Paint polygon has no triangles: ${command.key}`);
            const points = rings.flat();
            // Only consecutive, identically shaded contributions may merge.
            // Keep source index ranges for ownership inspection without forcing
            // a separate upload/draw for every road segment or decoration owner.
            if (!group || group.signature !== signature || group.styleId !== recipe.id
                || group.points.length + points.length > limits.verticesPerPolygon) {
                yield* emitGroup(group);
                group = { signature, recipe, styleId: recipe.id, regions, points: [], faces: [], sources: [] };
            }
            const source = group.sources.at(-1);
            if (source?.key === command.key) source.indexCount += faces.length * 3;
            else {
                group.sources.push({ key: command.key, sourceRevision: command.sourceRevision,
                    indexOffset: group.faces.length * 3, indexCount: faces.length * 3 });
            }
            const offset = group.points.length;
            group.points.push(...points);
            for (const face of faces) group.faces.push(face.map(index => index + offset));
            yield { phase: 'paint-triangulation', draws: draws.length, vertices, triangles };
        }
    }
    yield* emitGroup(group);
    return Object.freeze({
        contract: GROUND_PAINT_PACKET, receiver: plan.receiver, receiverBounds: plan.bounds, bounds: pageBounds, size,
        draws: Object.freeze(draws), update, styles: styleTable,
        stats: Object.freeze({ vertices, triangles, geometryBytes, draws: draws.length, submissions,
            // Exact R8 material ID; zero is uncovered. Material textures and
            // shading tables are separate, explicitly budgeted resources.
            textureBytes: size * size }),
    });
}
