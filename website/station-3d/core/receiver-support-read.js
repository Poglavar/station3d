// Indexed downward support over captured physical receiver triangles. Published
// readers keep their source identities, including when a producer is removed.
import { createBoundsGridSteps } from './bounds-grid.js';

// Captured surfaces are immutable publications. Aggregates may reuse their
// face records, but each aggregate builds its own bounded spatial index: a
// limit on each producer alone does not limit the complete point query.
const capturedFaces = new WeakMap();
const DEFAULT_QUERY_LIMITS = Object.freeze({ maxSurfaces: 16384, maxFaces: 1048576,
    maxIndexEntries: 4194304, maxPointCandidates: 4096 });
const capacity = message => { throw Object.assign(new RangeError(message), { code: 'ground-generation-capacity' }); };

export const EMPTY_RECEIVER_SUPPORT_READ = Object.freeze({ revision: 0,
    sources: Object.freeze([]), surfaces: Object.freeze([]),
    surfacesNear: () => [], supportYAt: () => null });

export function* createReceiverSupportQuerySteps(surfaces, { now = () => performance.now(),
    isCurrent = () => true, maxSurfaces = DEFAULT_QUERY_LIMITS.maxSurfaces,
    maxFaces = DEFAULT_QUERY_LIMITS.maxFaces, maxIndexEntries = DEFAULT_QUERY_LIMITS.maxIndexEntries,
    maxPointCandidates = DEFAULT_QUERY_LIMITS.maxPointCandidates } = {}) {
    if (!Array.isArray(surfaces) || ![maxSurfaces, maxFaces, maxIndexEntries, maxPointCandidates]
        .every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Receiver support requires captured surfaces and finite query capacities');
    }
    if (surfaces.length > maxSurfaces) capacity('Receiver support surface capacity exceeded');
    const faces = [];
    const check = () => {
        if (!isCurrent()) throw Object.assign(new Error('Receiver support query expired'),
            { code: 'ground-generation-stale' });
    };
    let deadline = now() + .5;
    for (const surface of surfaces) {
        check();
        const cached = capturedFaces.get(surface);
        if (cached) {
            if (faces.length + cached.length > maxFaces) capacity('Receiver support face capacity exceeded');
            for (const face of cached) {
                if (now() >= deadline) { yield { phase: 'receiver-support-query' }; check(); deadline = now() + .5; }
                faces.push(face);
            }
            continue;
        }
        const surfaceFaces = [];
        const p = surface.positions, indices = surface.indices;
        const originX = surface.originX ?? 0, originZ = surface.originZ ?? 0;
        if (![originX, originZ].every(Number.isFinite)) throw new TypeError('Receiver support requires a finite origin');
        const count = indices?.length ?? p.length / 3;
        for (let offset = 0; offset < count; offset += 3) {
            if (now() >= deadline) { yield { phase: 'receiver-support-query' }; check(); deadline = now() + .5; }
            const a = (indices ? indices[offset] : offset) * 3;
            const b = (indices ? indices[offset + 1] : offset + 1) * 3;
            const c = (indices ? indices[offset + 2] : offset + 2) * 3;
            const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vz = p[c + 2] - p[a + 2];
            const up = uz * vx - ux * vz;
            // Walls and downward-facing ceilings remain physical collision
            // faces, but cannot become a floor for a downward support query.
            if (!(up > 0)) continue;
            if (faces.length >= maxFaces) capacity('Receiver support face capacity exceeded');
            const face = { p, a, b, c, up, originX, originZ, bounds: {
                minX: Math.min(p[a], p[b], p[c]) + originX, maxX: Math.max(p[a], p[b], p[c]) + originX,
                minZ: Math.min(p[a + 2], p[b + 2], p[c + 2]) + originZ, maxZ: Math.max(p[a + 2], p[b + 2], p[c + 2]) + originZ,
            } };
            faces.push(face); surfaceFaces.push(face);
        }
        // Only the frozen receiver contract permits sharing derived records.
        // The standalone compiler also accepts mutable test/authoring inputs.
        if (Object.isFrozen(surface)) capturedFaces.set(surface, surfaceFaces);
    }
    const steps = createBoundsGridSteps(faces, { cellM: 8, now, maxPointCandidates, maxIndexEntries });
    let index;
    try {
        for (;;) {
            check(); const next = steps.next();
            if (next.done) { index = next.value; break; }
            yield next.value;
        }
    } finally { steps.return(); }
    check();
    const supportYAt = (x, z, { maxY = Infinity } = {}) => {
        if (![x, z].every(Number.isFinite) || !(Number.isFinite(maxY) || maxY === Infinity)) return null;
        let best = null;
        for (const { p, a, b, c, up, bounds, originX, originZ } of index.candidatesAt(x, z)) {
            if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
            const dx = x - originX - p[a], dz = z - originZ - p[a + 2];
            const wb = (dz * (p[c] - p[a]) - dx * (p[c + 2] - p[a + 2])) / up;
            const wc = ((p[b + 2] - p[a + 2]) * dx - (p[b] - p[a]) * dz) / up;
            if (wb < -1e-10 || wc < -1e-10 || wb + wc > 1 + 1e-10) continue;
            const y = p[a + 1] + wb * (p[b + 1] - p[a + 1]) + wc * (p[c + 1] - p[a + 1]);
            if (y <= maxY && (best === null || y > best)) best = y;
        }
        return best;
    };
    return Object.freeze(Object.assign(supportYAt, { usage: Object.freeze({
        surfaces: surfaces.length, faces: faces.length, ...index.stats(),
    }) }));
}

export function composeReceiverSupportReads(previous, sources, options) {
    const steps = composeReceiverSupportReadsSteps(previous, sources, options);
    try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
    finally { steps.return(); }
}

export function* composeReceiverSupportReadsSteps(previous = EMPTY_RECEIVER_SUPPORT_READ, sources = [],
    { now = () => performance.now(), isCurrent = () => true,
        maxSources = 16384, ...queryLimits } = {}) {
    if (!Array.isArray(sources) || !Number.isSafeInteger(maxSources) || maxSources < 1) {
        throw new TypeError('Receiver aggregation requires complete sources and a finite capacity');
    }
    if (sources.length > maxSources) capacity('Receiver support source capacity exceeded');
    const check = () => {
        if (!isCurrent()) throw Object.assign(new Error('Receiver support aggregation expired'),
            { code: 'ground-generation-stale' });
    };
    const unique = [], seenSources = new Set(), surfaces = [], seenSurfaces = new Map();
    let deadline = now() + .5;
    const resolvedLimits = { ...DEFAULT_QUERY_LIMITS, ...queryLimits };
    if (!Object.values(resolvedLimits).every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError('Receiver aggregation requires finite query capacities');
    }
    const { maxSurfaces, maxFaces, maxIndexEntries, maxPointCandidates } = resolvedLimits;
    for (const read of sources) {
        check();
        if (now() >= deadline) { yield { phase: 'receiver-support-sources' }; check(); deadline = now() + .5; }
        if (seenSources.has(read)) continue;
        if (!Number.isSafeInteger(read?.revision) || read.revision < 0 || !Array.isArray(read.surfaces)
            || typeof read.surfacesNear !== 'function' || typeof read.supportYAt !== 'function') {
            throw new TypeError('Published receivers require captured geometry and point support');
        }
        unique.push(read); seenSources.add(read);
    }
    check();
    if (previous.sources?.length === unique.length
        && unique.every((read, index) => previous.sources[index] === read)) {
        const usage = previous.usage;
        if (usage && (usage.surfaces > maxSurfaces || usage.faces > maxFaces
            || usage.indexEntries + usage.regionIndexEntries > maxIndexEntries
            || usage.maxPointCandidates > maxPointCandidates)) capacity('Retained receiver aggregate exceeds query capacity');
        return previous;
    }
    const revision = previous.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('Receiver support revision exhausted');
    for (const read of unique) for (const surface of read.surfaces) {
        if (now() >= deadline) { yield { phase: 'receiver-support-surfaces' }; check(); deadline = now() + .5; }
        if (seenSurfaces.has(surface)) continue;
        if (surfaces.length >= maxSurfaces) capacity('Combined receiver surface capacity exceeded');
        seenSurfaces.set(surface, surfaces.length); surfaces.push(surface);
    }
    // No renderer or producer callback runs during a point lookup. Flattening
    // captured faces also makes a nested structure aggregate obey this same
    // total density limit, including overlapping producers and stacked levels.
    const supportYAt = yield* createReceiverSupportQuerySteps(surfaces, { ...resolvedLimits, now, isCurrent });
    const remainingIndexEntries = maxIndexEntries - supportYAt.usage.indexEntries;
    if (remainingIndexEntries < surfaces.length) capacity('Combined receiver indices exceed storage capacity');
    const regionSteps = createBoundsGridSteps(surfaces, { cellM: 8, now,
        maxIndexEntries: Math.max(1, remainingIndexEntries),
        maxPointCandidates: maxSurfaces });
    let regionIndex;
    try {
        for (;;) { check(); const next = regionSteps.next(); if (next.done) { regionIndex = next.value; break; } yield next.value; }
    } finally { regionSteps.return(); }
    check();
    return Object.freeze({ revision, sources: Object.freeze(unique), surfaces: Object.freeze(surfaces),
        supportYAt, usage: Object.freeze({ sources: unique.length, ...supportYAt.usage,
            regionIndexEntries: regionIndex.stats().indexEntries }),
        surfacesNear(x, z, radius) {
            if (![x, z, radius].every(Number.isFinite) || radius <= 0) return [];
            const selected = [], seen = new Set();
            for (const surface of regionIndex.candidateItemsInBox(x - radius, z - radius, x + radius, z + radius)) {
                if (seen.has(surface)) continue;
                seen.add(surface);
                const { bounds } = surface;
                if (Math.max(bounds.minX - x, 0, x - bounds.maxX) ** 2
                    + Math.max(bounds.minZ - z, 0, z - bounds.maxZ) ** 2 <= radius ** 2) selected.push(seenSurfaces.get(surface));
            }
            // Collider buffer order remains stable as the query crosses grid
            // boundaries; spatial bucket traversal must not reorder faces.
            return selected.sort((a, b) => a - b).map(index => surfaces[index]);
        } });
}
