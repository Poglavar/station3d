// Memoises the vertex arrays of one draped strip path, so a lane-marking
// rebuild triggered by ONE arriving tile does not re-drape the whole city.
//
// The rebuild it serves is deliberately whole-world: buildLaneMarkingPaths is
// cross-feature (junction clearances, continuation transitions), so a new tile
// really can change its neighbours' paths and a per-FEATURE cache would be
// wrong. Measured on a Zagreb ride, though, that cross-feature solve is only
// 18% of the cost — 585 ms of 3,184 ms. The other 81% is turning already-solved
// paths into vertices, one terrain/formation height query per vertex, and that
// part depends on nothing but the path itself.
//
// The world layer retains a completed global solve while its immutable topology
// key is unchanged. This lower-level cache memoises that solve's OUTPUT: paths
// that came back identical reuse their draped vertices, paths the solve actually
// moved are re-draped. Correctness is not traded for speed — an entry is reused
// only after its points compare equal, element by element.
//
// Epoch covers what changes heights underneath an unmoved path: the road
// anchor and planner surface cutouts. Bounded road-formation revisions are
// invalidated spatially instead of changing the global epoch. A changed epoch
// drops everything; the cache derives it from its own inputs rather than
// trusting call sites to remember.

// Points arrive as [{x, z}, …] and are stored flat: half the objects, and a
// compare that walks one contiguous buffer instead of chasing pointers.
import { createMutableBoundsGrid } from './bounds-grid.js';

export const STRIP_INVALIDATION_CANDIDATES_PER_STEP = 64;
export const STRIP_ASSEMBLY_ENTRIES_PER_STEP = 128;
export const STRIP_ASSEMBLY_WORK_UNITS_PER_STEP = 1024;

function flattenPoints(points) {
    const flat = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
        flat[i * 2] = points[i].x;
        flat[i * 2 + 1] = points[i].z;
    }
    return flat;
}

function boundsOf(points) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.z < minZ) minZ = point.z;
        if (point.z > maxZ) maxZ = point.z;
    }
    return { minX, minZ, maxX, maxZ };
}

function samePoints(flat, points) {
    if (flat.length !== points.length * 2) return false;
    for (let i = 0; i < points.length; i++) {
        if (flat[i * 2] !== points[i].x) return false;
        if (flat[i * 2 + 1] !== points[i].z) return false;
    }
    return true;
}

// Split a long polyline into independently cacheable, bounded strip jobs.
// Each job carries one point of context on either side so miter normals at job
// boundaries are identical to the unsplit path. `segmentStart`/`segmentEnd`
// select only the owned core segments from that context, preventing overlap.
export function chunkStripPath(points, { maxSegments = 4 } = {}) {
    const path = Array.isArray(points) ? points : [];
    if (path.length < 2) return [];
    const segmentLimit = Math.max(1, Math.floor(Number(maxSegments) || 1));
    const cumulative = new Float64Array(path.length);
    for (let index = 1; index < path.length; index++) {
        cumulative[index] = cumulative[index - 1] + Math.hypot(
            Number(path[index]?.x) - Number(path[index - 1]?.x),
            Number(path[index]?.z) - Number(path[index - 1]?.z),
        );
    }
    const chunks = [];
    for (let coreStart = 0; coreStart < path.length - 1; coreStart += segmentLimit) {
        const coreEnd = Math.min(path.length - 1, coreStart + segmentLimit);
        const contextStart = Math.max(0, coreStart - 1);
        const contextEnd = Math.min(path.length - 1, coreEnd + 1);
        chunks.push({
            points: path.slice(contextStart, contextEnd + 1),
            segmentStart: coreStart - contextStart,
            segmentEnd: coreEnd - contextStart,
            initialCumulativeM: cumulative[coreStart],
        });
    }
    return chunks;
}

export function createStripGeometryCache() {
    let entries = new Map();   // key -> { flat, positions, uvs, indices?, quads, pass }
    const spatial = createMutableBoundsGrid({ boundsOf: entry => entry?.bounds });
    let epoch = null;
    let pass = 0;
    let hits = 0;
    let misses = 0;

    function* invalidateIntersectingSteps(boxes, padM = 0) {
        if (!Array.isArray(boxes) || boxes.length === 0) return 0;
        let dropped = 0;
        for (const box of boxes) {
            const minX = Number(box?.minX) - padM;
            const maxX = Number(box?.maxX) + padM;
            const minZ = Number(box?.minZ) - padM;
            const maxZ = Number(box?.maxZ) + padM;
            if ([minX, maxX, minZ, maxZ].every(Number.isFinite)) {
                const candidates = spatial.candidatesInBox(minX, minZ, maxX, maxZ);
                let candidatesSinceYield = 0;
                for (const entry of candidates) {
                    const key = entry.cacheKey;
                    if (entries.has(key)
                        && entry.bounds.maxX >= minX
                        && entry.bounds.minX <= maxX
                        && entry.bounds.maxZ >= minZ
                        && entry.bounds.minZ <= maxZ) {
                        entries.delete(key);
                        spatial.delete(key);
                        dropped += 1;
                    }
                    candidatesSinceYield += 1;
                    if (candidatesSinceYield >= STRIP_INVALIDATION_CANDIDATES_PER_STEP) {
                        candidatesSinceYield = 0;
                        yield 'candidates';
                    }
                }
            }
            // Sparse footprints still yield once. Dense footprints also yield
            // during candidate traversal above, so one broad formation change
            // cannot turn iterator.next() into a 20-35 ms lane-marking item.
            yield 'bounds';
        }
        return dropped;
    }

    function* endPassSteps() {
        let evicted = 0, visited = 0;
        const endingPass = pass;
        for (const [key, entry] of entries) {
            if (endingPass !== pass) return; // superseded; the new pass owns eviction
            if (entry.pass !== endingPass) {
                entries.delete(key);
                spatial.delete(key);
                evicted += 1;
            }
            if (++visited % STRIP_ASSEMBLY_ENTRIES_PER_STEP === 0) yield { phase: 'evict', visited, evicted };
        }
        return { hits, misses, evicted, size: entries.size };
    }

    const retain = (key, points) => {
        const found = entries.get(key);
        if (!found || !samePoints(found.flat, points)) return null;
        found.pass = pass;
        hits += 1;
        return found;
    };

    const store = (key, points, built) => {
        const entry = {
            cacheKey: key,
            flat: flattenPoints(points),
            bounds: boundsOf(points),
            positions: Float32Array.from(built.positions),
            uvs: Float32Array.from(built.uvs),
            indices: built.indices ? Uint32Array.from(built.indices) : null,
            quads: built.quads || 0,
            pass,
        };
        entries.set(key, entry);
        spatial.set(key, entry);
        misses += 1;
        return entry;
    };

    return {
        // `nextEpoch` is any value that compares === when the height field and
        // the cutouts are unchanged; a string of the revisions is fine.
        beginPass(nextEpoch) {
            if (nextEpoch !== epoch) {
                entries.clear();
                spatial.clear();
                epoch = nextEpoch;
            }
            pass += 1;
            hits = 0;
            misses = 0;
        },

        // Legacy builders return { positions, uvs, quads } for one path and
        // assembly regenerates their quad indices. A receiver-projected entry
        // may instead provide explicit triangle indices through `store`.
        get(key, points, build) {
            return retain(key, points) || store(key, points, build(points));
        },

        // Receiver projection is cooperative. Let a caller keep a cache hit
        // immediately, or store the completed result of a multi-frame build.
        retain,
        store,

        // The ground moved under some part of the world. Only paths that
        // overlap it are stale — dropping the rest would be correct but throws
        // away the whole point, since road formations stream in continuously
        // and a wholesale drop leaves the cache empty on nearly every rebuild.
        //
        // `padM` widens each box because a drape query reads the formation
        // NEAR a vertex, not only under it, so a change just outside a path's
        // own bounding box can still alter its heights.
        invalidateIntersectingSteps,
        invalidateIntersecting(boxes, padM = 0) {
            const build = invalidateIntersectingSteps(boxes, padM);
            let outcome = build.next();
            while (!outcome.done) outcome = build.next();
            return outcome.value;
        },

        invalidateAll() {
            const dropped = entries.size;
            entries.clear();
            spatial.clear();
            return dropped;
        },

        // Anything not asked for this pass belongs to a path that no longer
        // exists — an evicted tile, or a feature the solve dropped.
        endPassSteps,
        endPass() {
            const steps = endPassSteps();
            let outcome = steps.next();
            while (!outcome.done) outcome = steps.next();
            return outcome.value;
        },

        size: () => entries.size,
    };
}

// Concatenate the pass's cached paths into one set of buffers.
//
// Typed arrays with one `set` per path rather than pushing onto plain arrays:
// the aggregate is hundreds of thousands of floats and `set` is a memcpy. The
// Legacy quad entries regenerate `base+[0,1,2,0,2,3]`. Receiver-projected
// entries retain their clipped triangle indices because one source quad may be
// split at several physical receiver facets.
export function* assembleStripGeometrySteps(entries) {
    let positionCount = 0;
    let uvCount = 0;
    let indexCount = 0;
    let countedEntries = 0;
    for (const entry of entries) {
        positionCount += entry.positions.length;
        uvCount += entry.uvs.length;
        indexCount += entry.indices?.length ?? entry.quads * 6;
        if (++countedEntries % STRIP_ASSEMBLY_ENTRIES_PER_STEP === 0) {
            yield { phase: 'count', countedEntries };
        }
    }
    if (indexCount === 0) return null;

    const positions = new Float32Array(positionCount);
    yield { phase: 'allocate-positions' };
    const uvs = new Float32Array(uvCount);
    yield { phase: 'allocate-uvs' };
    const indices = new Uint32Array(indexCount);
    yield { phase: 'allocate-indices' };
    let positionAt = 0;
    let uvAt = 0;
    let indexAt = 0;
    let vertBase = 0;
    let remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
    const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    for (const entry of entries) {
        const sourcePositions = entry.positions, sourceUvs = entry.uvs;
        for (let vertex = 0; vertex < sourcePositions.length / 3;) {
            const count = Math.min(remaining, sourcePositions.length / 3 - vertex);
            const end = vertex + count;
            positions.set(sourcePositions.subarray(vertex * 3, end * 3), positionAt + vertex * 3);
            for (let index = vertex * 3; index < end * 3; index += 3) {
                const x = sourcePositions[index], y = sourcePositions[index + 1], z = sourcePositions[index + 2];
                bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
                bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
                bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
            }
            vertex = end;
            remaining -= count;
            if (remaining === 0) {
                yield { phase: 'positions', workUnits: STRIP_ASSEMBLY_WORK_UNITS_PER_STEP };
                remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
            }
        }
        for (let vertex = 0; vertex < sourceUvs.length / 2;) {
            const count = Math.min(remaining, sourceUvs.length / 2 - vertex);
            const end = vertex + count;
            uvs.set(sourceUvs.subarray(vertex * 2, end * 2), uvAt + vertex * 2);
            vertex = end;
            remaining -= count;
            if (remaining === 0) {
                yield { phase: 'uvs', workUnits: STRIP_ASSEMBLY_WORK_UNITS_PER_STEP };
                remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
            }
        }
        positionAt += sourcePositions.length;
        uvAt += sourceUvs.length;
        if (entry.indices) {
            const entryVertexBase = vertBase;
            for (let index = 0; index < entry.indices.length;) {
                const count = Math.min(remaining, entry.indices.length - index);
                for (let item = 0; item < count; item++) {
                    indices[indexAt++] = entryVertexBase + entry.indices[index + item];
                }
                index += count;
                remaining -= count;
                if (remaining === 0) {
                    yield { phase: 'indices', workUnits: STRIP_ASSEMBLY_WORK_UNITS_PER_STEP };
                    remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
                }
            }
            vertBase += sourcePositions.length / 3;
        } else {
            for (let quad = 0; quad < entry.quads;) {
                const count = Math.min(remaining, entry.quads - quad);
                for (let index = 0; index < count; index++) {
                    indices[indexAt++] = vertBase + 0;
                    indices[indexAt++] = vertBase + 1;
                    indices[indexAt++] = vertBase + 2;
                    indices[indexAt++] = vertBase + 0;
                    indices[indexAt++] = vertBase + 2;
                    indices[indexAt++] = vertBase + 3;
                    vertBase += 4;
                }
                quad += count;
                remaining -= count;
                if (remaining === 0) {
                    yield { phase: 'indices', workUnits: STRIP_ASSEMBLY_WORK_UNITS_PER_STEP };
                    remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
                }
            }
        }
        // Empty/small entries consume a unit too: a many-empty-entry input
        // must not turn one next() into a whole loaded-world traversal.
        if (--remaining === 0) {
            yield { phase: 'entries', workUnits: STRIP_ASSEMBLY_WORK_UNITS_PER_STEP };
            remaining = STRIP_ASSEMBLY_WORK_UNITS_PER_STEP;
        }
    }
    return { positions, uvs, indices, vertexCount: vertBase, bounds };
}

// Explicit synchronous drain for headless callers. The live layer consumes
// assembleStripGeometrySteps inside its existing per-frame build budget.
export function assembleStripGeometry(entries) {
    const steps = assembleStripGeometrySteps(entries);
    let outcome = steps.next();
    while (!outcome.done) outcome = steps.next();
    return outcome.value;
}
