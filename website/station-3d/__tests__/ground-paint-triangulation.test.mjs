// Verifies bounded topology reuse and page output across revisions and origins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { createGroundPaintPacketSteps } from '../core/ground-paint-packet.js';
import {
    createGroundPaintTriangulationCache,
    triangulateGroundPaintPolygon,
} from '../core/ground-paint-triangulation.js';
import { planGroundPaintUpdate } from '../core/ground-paint-update.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';

const claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.SIDEWALK,
    coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' });
const receiver = { key: 'paint-cache-test', verticalBand: 'ground', coverageRevision: 'r1',
    bounds: { minX: 100_000_000, minZ: 100_000_000, maxX: 100_000_020, maxZ: 100_000_020 } };
const triangle = x => ({ outerRing: [{ x, z: 0 }, { x: x + 2, z: 0 }, { x, z: 2 }], holeRings: [] });
const squareWithHole = {
    outerRing: [
        { x: 100_000_000, z: 100_000_000 }, { x: 100_000_012, z: 100_000_000 },
        { x: 100_000_012, z: 100_000_012 }, { x: 100_000_000, z: 100_000_012 },
        { x: 100_000_000, z: 100_000_000 },
    ],
    holeRings: [[
        { x: 100_000_003, z: 100_000_003 }, { x: 100_000_009, z: 100_000_003 },
        { x: 100_000_009, z: 100_000_009 }, { x: 100_000_003, z: 100_000_009 },
        { x: 100_000_003, z: 100_000_003 },
    ]],
};
const farTriangle = { outerRing: [
    { x: 100_000_014, z: 100_000_001 }, { x: 100_000_018, z: 100_000_001 },
    { x: 100_000_014, z: 100_000_005 }, { x: 100_000_014, z: 100_000_001 },
], holeRings: [] };
const makeCommand = ({ key = 'owner', sourceRevision = 'source-1', polygons = [triangle(0)] } = {}) => ({
    key, sourceRevision, materialKey: 'sidewalk', materialRevision: 'material-1',
    claim, receiver, polygons,
});
const run = generator => {
    let result;
    do { result = generator.next(); } while (!result.done);
    return result.value;
};
function makePlan(command) {
    return run(createGroundCompositePlanSteps({ receiver, records: [command],
        limits: { records: 10, vertices: 100, verticesPerRecord: 100, oversized: 10 } }));
}

test('cache hits only the same source revision and polygon index', () => {
    const cache = createGroundPaintTriangulationCache();
    const command = makeCommand({ polygons: [triangle(0), triangle(4)] });
    const first = cache.get(command, 0);
    const hit = cache.get(command, 0);
    const secondPolygon = cache.get(command, 1);
    const revised = cache.get({ ...command, sourceRevision: 'source-2' }, 0);

    assert.equal(first.reused, false);
    assert.equal(hit.reused, true);
    assert.strictEqual(hit.geometry, first.geometry);
    assert.notStrictEqual(secondPolygon.geometry, first.geometry, 'multipolygon members have separate cache entries');
    assert.equal(secondPolygon.reused, false);
    assert.notStrictEqual(revised.geometry, first.geometry, 'a new source revision must recompute topology');
    assert.equal(revised.reused, false);
    assert.deepEqual(cache.snapshot(), { entries: 3, bytes: first.geometry.byteLength
        + secondPolygon.geometry.byteLength + revised.geometry.byteLength,
    maxBytes: 16 * 1024 * 1024, maxEntries: 8192, hits: 1, misses: 3, evictions: 0 });
});

test('byte and entry limits evict least-recently-used topology', () => {
    const sample = triangulateGroundPaintPolygon(triangle(0));
    const byBytes = createGroundPaintTriangulationCache({ maxBytes: sample.byteLength * 2, maxEntries: 10 });
    const a = makeCommand({ key: 'a' }), b = makeCommand({ key: 'b' }), c = makeCommand({ key: 'c' });
    const aGeometry = byBytes.get(a, 0).geometry;
    byBytes.get(b, 0);
    assert.strictEqual(byBytes.get(a, 0).geometry, aGeometry, 'a hit makes a the most recently used entry');
    byBytes.get(c, 0);
    assert.deepEqual(byBytes.snapshot(), { entries: 2, bytes: sample.byteLength * 2,
        maxBytes: sample.byteLength * 2, maxEntries: 10, hits: 1, misses: 3, evictions: 1 });
    assert.equal(byBytes.get(b, 0).reused, false, 'the older b entry was evicted by byte pressure');
    assert.ok(byBytes.snapshot().bytes <= byBytes.snapshot().maxBytes);

    const byEntries = createGroundPaintTriangulationCache({ maxBytes: sample.byteLength * 10, maxEntries: 1 });
    byEntries.get(a, 0);
    byEntries.get(b, 0);
    assert.deepEqual(byEntries.snapshot(), { entries: 1, bytes: sample.byteLength,
        maxBytes: sample.byteLength * 10, maxEntries: 1, hits: 0, misses: 2, evictions: 1 });
    assert.ok(byEntries.snapshot().entries <= byEntries.snapshot().maxEntries);
});

test('oversized polygons are triangulated but never retained; retain and clear release bytes', () => {
    const geometry = triangulateGroundPaintPolygon(triangle(0));
    const oversized = createGroundPaintTriangulationCache({ maxBytes: geometry.byteLength - 1, maxEntries: 4 });
    const command = makeCommand({ key: 'too-large' });
    const first = oversized.get(command, 0), second = oversized.get(command, 0);
    assert.equal(first.reused, false);
    assert.equal(second.reused, false, 'uncacheable geometry is recomputed on the next request');
    assert.deepEqual(oversized.snapshot(), { entries: 0, bytes: 0, maxBytes: geometry.byteLength - 1,
        maxEntries: 4, hits: 0, misses: 2, evictions: 0 });

    const cache = createGroundPaintTriangulationCache();
    cache.get(makeCommand({ key: 'keep', sourceRevision: 'v1' }), 0);
    cache.get(makeCommand({ key: 'revise', sourceRevision: 'v1' }), 0);
    cache.get(makeCommand({ key: 'retire', sourceRevision: 'v1' }), 0);
    const retainedBytes = cache.snapshot().bytes;
    cache.retain({ byKey: key => key === 'keep' ? { sourceRevision: 'v1' }
        : key === 'revise' ? { sourceRevision: 'v2' } : null });
    assert.deepEqual(cache.snapshot(), { entries: 1, bytes: geometry.byteLength,
        maxBytes: 16 * 1024 * 1024, maxEntries: 8192, hits: 0, misses: 3, evictions: 0 });
    assert.ok(cache.snapshot().bytes < retainedBytes, 'revised and retired owners release their entries');
    cache.clear();
    assert.equal(cache.snapshot().entries, 0);
    assert.equal(cache.snapshot().bytes, 0, 'clear releases retained geometry bytes');
});

test('cached packets preserve output and inputs across shifted origins and closed rings at large coordinates', () => {
    const polygons = [squareWithHole, farTriangle];
    const command = makeCommand({ key: 'closed-rings', sourceRevision: 'cassette-7', polygons });
    const inputBefore = structuredClone(command);
    const plan = makePlan(command);
    const styles = new Map([['sidewalk', { id: 7, revision: 'material-1',
        surfaceClass: SURFACE_CLASS.SIDEWALK, roughness: 0.96, metalness: 0,
        normalInfluence: 0, linearColor: [0.4, 0.5, 0.6] }]]);
    const cache = createGroundPaintTriangulationCache();
    const geometrySnapshot = new Map();

    for (const [iteration, bounds] of [
        { minX: 100_000_000, minZ: 100_000_000, maxX: 100_000_020, maxZ: 100_000_020 },
        { minX: 100_000_002, minZ: 100_000_001, maxX: 100_000_022, maxZ: 100_000_021 },
    ].entries()) {
        const options = { plan, bounds, size: 32, styles,
            limits: { pixels: 2048, draws: 10, verticesPerPolygon: 100 } };
        const uncached = run(createGroundPaintPacketSteps(options));
        const cached = run(createGroundPaintPacketSteps({ ...options, triangulationCache: cache }));
        assert.equal(cached.stats.triangulations, iteration === 0 ? polygons.length : 0);
        assert.equal(cached.stats.triangulationHits, iteration === 0 ? 0 : polygons.length);
        assert.deepEqual(cached.draws.map(draw => ({
            positions: [...draw.positions], indices: [...draw.indices], materialKey: draw.materialKey,
            materialRevision: draw.materialRevision, styleId: draw.styleId, sources: draw.sources,
        })), uncached.draws.map(draw => ({
            positions: [...draw.positions], indices: [...draw.indices], materialKey: draw.materialKey,
            materialRevision: draw.materialRevision, styleId: draw.styleId, sources: draw.sources,
        })), 'translation, topology, styles and source ranges must match without the cache');

        for (const [index, polygon] of polygons.entries()) {
            const geometry = cache.get(command, index).geometry;
            if (!geometrySnapshot.has(index)) geometrySnapshot.set(index, {
                coordinates: [...geometry.coordinates], indices: [...geometry.indices],
            });
            assert.deepEqual([...geometry.coordinates], geometrySnapshot.get(index).coordinates);
            assert.deepEqual([...geometry.indices], geometrySnapshot.get(index).indices);
            assert.equal(polygon.outerRing[0].x, inputBefore.polygons[index].outerRing[0].x);
        }
    }
    assert.deepEqual(command, inputBefore, 'triangulation and packet construction leave source rings untouched');
    assert.deepEqual(cache.snapshot(), { entries: polygons.length,
        bytes: [...geometrySnapshot.values()].reduce((sum, geometry) => sum
            + geometry.coordinates.length * Float64Array.BYTES_PER_ELEMENT
            + geometry.indices.length * Uint32Array.BYTES_PER_ELEMENT, 0),
        maxBytes: 16 * 1024 * 1024, maxEntries: 8192, hits: polygons.length * 3,
        misses: polygons.length, evictions: 0 });

    // The cache's retained triangles must cover the ring hole, not fill it.
    const holePlan = makePlan(command);
    const holeUpdate = planGroundPaintUpdate({ receiver, bounds: {
        minX: 100_000_000, minZ: 100_000_000, maxX: 100_000_020, maxZ: 100_000_020,
    }, size: 32 });
    const holePacket = run(createGroundPaintPacketSteps({ plan: holePlan,
        bounds: { minX: 100_000_000, minZ: 100_000_000, maxX: 100_000_020, maxZ: 100_000_020 },
        size: 32, styles, limits: { pixels: 2048, draws: 10, verticesPerPolygon: 100 },
        update: holeUpdate, triangulationCache: cache }));
    const draw = holePacket.draws[0];
    const source = draw.sources.find(item => item.key === command.key);
    assert.ok(source);
    for (let i = source.indexOffset; i < source.indexOffset + source.indexCount; i += 3) {
        const points = [draw.indices[i], draw.indices[i + 1], draw.indices[i + 2]].map(index => [
            draw.positions[index * 3] + 100_000_000, draw.positions[index * 3 + 1] + 100_000_000,
        ]);
        const cx = points.reduce((sum, point) => sum + point[0], 0) / 3;
        const cz = points.reduce((sum, point) => sum + point[1], 0) / 3;
        assert.equal(cx > 100_000_003 && cx < 100_000_009 && cz > 100_000_003 && cz < 100_000_009,
            false, 'triangles must not fill the interior hole');
    }
    assert.equal(cache.snapshot().bytes, [...geometrySnapshot.values()].reduce((sum, geometry) => sum
        + geometry.coordinates.length * Float64Array.BYTES_PER_ELEMENT
        + geometry.indices.length * Uint32Array.BYTES_PER_ELEMENT, 0), 'packet operations do not mutate cached arrays');
});
