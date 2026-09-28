// Session-local, byte-bounded reuse of immutable paint polygon topology.
// Coordinates stay in CPU double precision; page translation happens on copy.
import { ShapeUtils, Vector2 } from 'three';

export function triangulateGroundPaintPolygon(polygon) {
    const sources = [polygon.outerRing, ...polygon.holeRings].map(ring => {
        const first = ring[0], last = ring.at(-1);
        return ring.length > 1 && first.x === last.x && first.z === last.z ? ring.slice(0, -1) : ring;
    });
    // Use a stable local origin for every page. Keep original world doubles
    // separately so subtracting the page origin never round-trips coordinates.
    const origin = sources[0][0];
    const rings = sources.map(ring => ring.map(point => new Vector2(point.x - origin.x, point.z - origin.z)));
    const faces = ShapeUtils.triangulateShape(rings[0], rings.slice(1));
    if (!faces.length) throw new Error('Paint polygon has no triangles');
    const points = sources.flat();
    const coordinates = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
        coordinates[i * 2] = points[i].x; coordinates[i * 2 + 1] = points[i].z;
    }
    const indices = new Uint32Array(faces.length * 3);
    for (let i = 0; i < faces.length; i++) indices.set(faces[i], i * 3);
    return Object.freeze({ coordinates, indices, byteLength: coordinates.byteLength + indices.byteLength });
}

export function createGroundPaintTriangulationCache({ maxBytes = 16 * 1024 * 1024, maxEntries = 8192 } = {}) {
    if (![maxBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Explicit positive paint triangulation cache limits required');
    }
    const entries = new Map();
    let bytes = 0, hits = 0, misses = 0, evictions = 0;
    const remove = key => {
        const entry = entries.get(key);
        if (!entry) return;
        bytes -= entry.geometry.byteLength; entries.delete(key);
    };
    return Object.freeze({
        get(command, polygonIndex) {
            const key = JSON.stringify([command.key, command.sourceRevision, polygonIndex]);
            const previous = entries.get(key);
            if (previous) {
                hits++; entries.delete(key); entries.set(key, previous);
                return { geometry: previous.geometry, reused: true };
            }
            misses++;
            const geometry = triangulateGroundPaintPolygon(command.polygons[polygonIndex]);
            if (geometry.byteLength <= maxBytes) {
                while (entries.size >= maxEntries || bytes + geometry.byteLength > maxBytes) {
                    remove(entries.keys().next().value); evictions++;
                }
                entries.set(key, { sourceKey: command.key, sourceRevision: command.sourceRevision, geometry });
                bytes += geometry.byteLength;
            }
            return { geometry, reused: false };
        },
        // Publication can evict retired sources immediately. A cancelled private
        // candidate may warm the cache, but can never exceed its fixed limits.
        retain(plan) {
            for (const [key, entry] of entries) {
                if (plan.byKey(entry.sourceKey)?.sourceRevision !== entry.sourceRevision) remove(key);
            }
        },
        clear() { entries.clear(); bytes = 0; },
        snapshot: () => ({ entries: entries.size, bytes, maxBytes, maxEntries, hits, misses, evictions }),
    });
}
