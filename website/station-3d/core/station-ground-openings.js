// Station entrance footprints authorize removal only above their actual
// upward floor faces. A capsule by itself is not proof of a backed opening.
import { captureEntranceOpeningRegionsSteps } from './surface-opening-shapes.js';
import { createSurfaceOpeningTopologySteps } from './surface-opening-topology.js';

export function* captureStationGroundOpeningsSteps({ cuts, supportRead, replacementKey,
    limits, maxCuts, now = () => performance.now(), isCurrent = () => true }) {
    if (!Array.isArray(supportRead?.surfaces) || !replacementKey) throw new TypeError('Station openings require physical support');
    const footprints = yield* captureEntranceOpeningRegionsSteps(cuts, { maxCuts,
        maxVertices: limits.maxSourceVertices, chordErrorM: .001, now, isCurrent });
    if (!footprints.length) return Object.freeze([]);
    // Each footprint must have a floor. Keep its ceiling independent from a
    // different station elsewhere in the window, including above the datum.
    const regions = [];
    let vertices = 0, deadline = now() + .5;
    const check = () => { if (!isCurrent()) throw Object.assign(new Error('Station opening preparation expired'), { code: 'ground-opening-stale' }); };
    for (const footprint of footprints) {
        const start = regions.length;
        const topology = yield* createSurfaceOpeningTopologySteps({ regions: [footprint], limits, now, isCurrent });
        for (const surface of supportRead.surfaces) {
            check();
            if (now() >= deadline) { yield { phase: 'station-opening-surfaces' }; deadline = now() + .5; }
            const b = surface.bounds, f = footprint.bounds;
            if (b.minX > f.maxX || b.maxX < f.minX || b.minZ > f.maxZ || b.maxZ < f.minZ) continue;
            const positions = surface.positions, indices = surface.indices;
            const originX = surface.originX ?? 0, originZ = surface.originZ ?? 0;
            const count = indices?.length ?? positions.length / 3;
            for (let offset = 0; offset < count; offset += 3) {
                check();
                if (now() >= deadline) { yield { phase: 'station-opening-faces' }; deadline = now() + .5; }
                const face = [0, 1, 2].map(j => {
                    const i = (indices?.[offset + j] ?? offset + j) * 3;
                    return { x: positions[i] + originX, y: positions[i + 1], z: positions[i + 2] + originZ };
                });
                const [a, b, c] = face;
                const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
                const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
                const up = uz * vx - ux * vz;
                if (!(up > 0)) continue;
                const minPlane = Object.freeze({ ...a, slopeX: -(uy * vz - uz * vy) / up,
                    slopeZ: -(ux * vy - uy * vx) / up });
                const result = yield* topology.clipTriangleSteps(...face, { removedOnly: true });
                for (const { polygon, maxY, maxYExclusive } of result.removed) {
                    vertices += polygon.length;
                    if (regions.length >= limits.maxRegions || vertices > limits.maxSourceVertices) {
                        throw Object.assign(new Error('Station openings exceed boundary capacity'), { code: 'ground-opening-capacity' });
                    }
                    const ring = Object.freeze(polygon.map(({ x, z }) => Object.freeze({ x, z })));
                    regions.push(Object.freeze({ ring, minPlane, minY: null, maxY, maxYExclusive, replacementKey,
                        bounds: Object.freeze({ minX: Math.min(...ring.map(p => p.x)), maxX: Math.max(...ring.map(p => p.x)),
                            minZ: Math.min(...ring.map(p => p.z)), maxZ: Math.max(...ring.map(p => p.z)) }) }));
                }
            }
        }
        if (regions.length === start) throw Object.assign(new Error('Station entrance has no physical floor'), { code: 'ground-backstop-unavailable' });
    }
    check(); return Object.freeze(regions);
}
