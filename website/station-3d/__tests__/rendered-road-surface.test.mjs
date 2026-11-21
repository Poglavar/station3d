import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createRenderedRoadSurfaceRegistry } from '../core/rendered-road-surface.js';
import { createSurfacePublicationRegistry } from '../core/surface-publication-registry.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';
import { groundPaintReceiverAcceptsClaim } from '../core/ground-paint-receiver-claim.js';

const publicationLimits = { maxOwners: 4, maxCells: 16, maxCellParts: 40,
    queryBounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 } };

test('dense point support keeps exact heights while skipping remote faces in the same cell', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/dense-road-detail-query.json', import.meta.url)));
    const registry = createRenderedRoadSurfaceRegistry();
    const reference = createRenderedRoadSurfaceRegistry();
    let coordinateReads = 0;
    const points = [[62, 61.06], [50, 50], [62, 100], [60, 140], [49, 60], [74, 60]];
    for (const part of fixture.parts) {
        const positions = new Proxy(part.positions, {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) coordinateReads++;
                return Reflect.get(target, property, receiver);
            },
        });
        registry.replace(part.ownerId, [{ ...part, positions }]);
        // Small parts take the exhaustive path, independently of the dense-cell
        // acceleration. Keep the source faces, claims and heights unchanged.
        const indices = part.indices || Array.from({ length: part.positions.length / 3 }, (_, i) => i);
        const flat = [];
        for (let offset = 0; offset < indices.length; offset += 96) {
            flat.push({ ...part, id: `${part.id}:${offset}`, indices: indices.slice(offset, offset + 96) });
        }
        reference.replace(part.ownerId, flat);
        for (let offset = 0; offset + 2 < indices.length; offset += 999) {
            const [a, b, c] = indices.slice(offset, offset + 3).map(i => i * 3);
            const p = part.positions;
            points.push([(p[a] + p[b] + p[c]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3]);
            points.push([p[a], p[a + 2]], [p[a] + 5e-8, p[a + 2] - 5e-8]);
        }
    }
    coordinateReads = 0;
    assert.equal(registry.supportYAt(62, 61.06), reference.supportYAt(62, 61.06));
    assert.ok(coordinateReads < 2000, `dense point query read ${coordinateReads} coordinates`);
    for (const [x, z] of points) {
        for (const maxY of [Infinity, 0]) {
            assert.equal(registry.supportYAt(x, z, { maxY }), reference.supportYAt(x, z, { maxY }),
                `height at ${x}, ${z}, ceiling ${maxY}`);
        }
    }
});

test('dense non-indexed point support preserves edges, gaps and stacked surface policy', () => {
    const registry = createRenderedRoadSurfaceRegistry();
    const positions = [];
    for (let i = 0; i < 64; i++) {
        const x = 1 + i % 8 * 4, z = 1 + Math.floor(i / 8) * 4;
        positions.push(x, 3, z, x + 1, 3, z, x, 3, z + 1);
    }
    registry.replace('road', [{ positions, drivable: true }]);
    registry.replace('walk-deck', [{ positions: positions.map((value, i) => i % 3 === 1 ? 8 : value) }]);
    for (const [x, z] of [[1, 1], [1 - 5e-8, 1], [1.5, 1.5], [29, 29]]) {
        assert.ok(Math.abs(registry.supportYAt(x, z) - 8) < 1e-12);
        assert.ok(Math.abs(registry.supportYAt(x, z, { maxY: 4 }) - 3) < 1e-12);
        assert.ok(Math.abs(registry.supportYAt(x, z, { drivableOnly: true }) - 3) < 1e-12);
        assert.ok(Math.abs(registry.supportYAt(x, z, { acceptPart: p => p.ownerId === 'road' }) - 3) < 1e-12);
        assert.equal(registry.supportYAt(x, z, { maxY: 2 }), null);
    }
    assert.equal(registry.supportYAt(1 - 2e-7, 1), null);
    assert.equal(registry.supportYAt(3, 3), null);
});

test('dense published road queries skip remote faces without losing boundary-spanning triangles', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/dense-road-detail-query.json', import.meta.url)));
    const registry = createRenderedRoadSurfaceRegistry();
    for (const part of fixture.parts) registry.replace(part.ownerId, [part]);
    const ids = new Map(fixture.parts.map(part => [part.positions, part.id]));
    const faceKey = ({ positions, a, b, c }) => `${ids.get(positions)}:${a}:${b}:${c}`;
    const bruteForce = bounds => {
        const faces = [];
        for (const { positions: p, indices } of fixture.parts) {
            for (let offset = 0; offset < (indices?.length ?? p.length / 3); offset += 3) {
                const a = (indices ? indices[offset] : offset) * 3;
                const b = (indices ? indices[offset + 1] : offset + 1) * 3;
                const c = (indices ? indices[offset + 2] : offset + 2) * 3;
                if (Math.min(p[a], p[b], p[c]) >= bounds.maxX || Math.max(p[a], p[b], p[c]) <= bounds.minX
                    || Math.min(p[a + 2], p[b + 2], p[c + 2]) >= bounds.maxZ
                    || Math.max(p[a + 2], p[b + 2], p[c + 2]) <= bounds.minZ) continue;
                faces.push(faceKey({ positions: p, a, b, c }));
            }
        }
        return faces.sort();
    };
    for (const bounds of [fixture.bounds,
        { minX: 49.9, maxX: 55, minZ: 49.9, maxZ: 51 },
        { minX: 60, maxX: 62, minZ: 99.9, maxZ: 100.1 }]) {
        const records = Array.from(registry.trianglesInBounds(bounds));
        const actual = records.filter(Boolean).map(faceKey).sort();
        assert.deepEqual(actual, bruteForce(bounds));
        assert.equal(new Set(actual).size, actual.length, 'faces spanning cells must be emitted once');
        if (bounds === fixture.bounds) {
            assert.equal(actual.length, 108);
            assert.ok(records.length < 400, `narrow footprint visited ${records.length} records (formerly 4340)`);
        }
    }
    assert.throws(() => Array.from(registry.trianglesInBounds(fixture.bounds, { maxTriangles: 20 })), /capacity/);
});

test('paint placement queries exact ground triangles and excludes stacked structure levels', () => {
    const registry = createRenderedRoadSurfaceRegistry();
    const receiver = { verticalBand: 'ground' };
    const claim = (band, relation) => compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_CARRIAGEWAY,
        ownerId: band, verticalBand: band, verticalRelation: relation, coverageState: 'published',
        supportReady: true, cutsBackstop: false });
    const make = (y, surfaceClaim) => ({ ...squarePart({ id: String(y), minX: -2, maxX: 2,
        minZ: -2, maxZ: 2, y, drivable: true }), surfaceClaim });
    const ground = make(.8212, claim('ground', 'same-level'));
    registry.replace('test', [ground, make(6, claim('bridge:1', 'grade-separated')), make(2, null)]);
    const options = { acceptPart: part => groundPaintReceiverAcceptsClaim(receiver, part.surfaceClaim) };
    assert.equal(registry.supportYAt(0, 0), 6);
    assert.ok(Math.abs(registry.supportYAt(0, 0, options) - .8212) < 1e-7);
    const read = drain(registry.captureReadSnapshotSteps(publicationLimits.queryBounds, publicationLimits));
    assert.equal(read.supportYAt(0, 0, options), registry.supportYAt(0, 0, options));
    registry.replace('test', [make(6, claim('bridge:1', 'grade-separated'))]);
    assert.equal(registry.supportYAt(0, 0, options), null);
    assert.equal(read.isCurrent(), false);
    read.release();
});
function drain(iterator, visit = () => {}) {
    for (let steps = 0; steps < 10000; steps++) {
        const next = iterator.next(); if (next.done) return next.value;
        visit(next.value);
    }
    throw new Error('Road support preparation did not finish');
}

function squarePart({
    id,
    minX,
    minZ,
    maxX,
    maxZ,
    y,
    drivable,
}) {
    return {
        id,
        drivable,
        positions: new Float32Array([
            minX, y, minZ,
            maxX, y, minZ,
            maxX, y, maxZ,
            minX, y, maxZ,
        ]),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    };
}

function sparseIndexedPart({ id, y = 1, clusterXs = [-50000, 50000] }) {
    const positions = [];
    const indices = [];
    let triangle = 0;
    for (const clusterX of clusterXs) {
        for (let i = 0; i < 17; i += 1) {
            const x = clusterX + (i % 4) * 2;
            const z = (i % 5) * 2;
            const base = positions.length / 3;
            positions.push(x, y, z, x + 1, y, z, x, y, z + 1);
            indices.push(base, base + 1, base + 2);
            triangle += 1;
        }
    }
    assert.equal(triangle, 34);
    return { id, drivable: true, positions: new Float32Array(positions),
        indices: new Uint32Array(indices) };
}

test('detail queries reuse indexed published triangles and keep support and drive policy separate', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const claim = support => compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.ROAD_EARTHWORK,
        verticalBand: 'ground', verticalRelation: 'same-level', ownerId: 'collar', coverageState: 'published',
        supportReady: support, cutsBackstop: false });
    const road = { ...squarePart({ id: 'road', minX: -2, maxX: 2, minZ: -2, maxZ: 2, y: 1, drivable: true }) };
    const collar = { ...road, id: 'collar', drivable: false, positions: Float32Array.from(road.positions,
        (v, i) => i % 3 === 1 ? 2 : v), surfaceClaim: claim(true) };
    const seam = { ...collar, id: 'seam', positions: Float32Array.from(road.positions,
        (v, i) => i % 3 === 1 ? 3 : v), surfaceClaim: claim(false) };
    registry.replace('roads', [road, collar, seam]);
    const bounds = { minX: -.5, minZ: -.5, maxX: .5, maxZ: .5 };
    const read = drain(registry.captureReadSnapshotSteps(bounds, { maxCells: 4, maxCellParts: 16 }));
    const faces = Array.from(read.trianglesInBounds(bounds)).filter(Boolean);
    assert.equal(faces.length, 6, 'each original triangle appears once across the four cells');
    assert.equal(faces.filter(f => f.positions === collar.positions).length, 2);
    assert.equal(faces.filter(f => f.positions === seam.positions).length, 2);
    assert.equal(read.supportYAt(0, 0), 2, 'non-supporting seam does not acquire walking semantics');
    assert.equal(read.supportYAt(0, 0, { drivableOnly: true }), 1, 'collar does not acquire tyre road semantics');
    registry.remove('roads');
    assert.equal(Array.from(registry.trianglesInBounds(bounds)).filter(Boolean).length, 0);
    assert.equal(Array.from(read.trianglesInBounds(bounds)).filter(Boolean).length, 6);
    assert.equal(read.isCurrent(), false);
    assert.throws(() => Array.from(read.trianglesInBounds({ ...bounds, maxX: 1 })), /coverage/);
    read.release();
    assert.throws(() => Array.from(read.trianglesInBounds(bounds)), /released/);
});

test('sparse detail queries avoid remote triangles and enforce explicit query capacity', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    registry.replace('sparse', [sparseIndexedPart({ id: 'sparse' })]);
    const bounds = { minX: -50000.1, maxX: -49999.9, minZ: -.1, maxZ: .1 };
    const candidates = Array.from(registry.trianglesInBounds(bounds)).filter(Boolean);
    assert.equal(candidates.length, 1);
    assert.throws(() => Array.from(registry.trianglesInBounds(bounds, { maxCells: 1 })), /capacity/);
});

test('indexed sparse road parts register triangle cells instead of empty AABB gaps', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const part = sparseIndexedPart({ id: 'sparse-v1', y: 3 });
    const limits = { maxOwners: 4, maxCells: 16, maxCellParts: 100 };
    const tx = drain(registry.preparePublicationSteps([registry.prepare('sparse', [part])], limits));
    assert.equal(tx.commit(), true);
    assert.equal(tx.finalize(), true);
    assert.equal(registry.supportYAt(-50000, 0), 3);
    assert.equal(registry.supportYAt(50000, 0), 3);
    assert.equal(registry.supportYAt(0, 0), null);
    assert.equal(registry.partsNear(-50000, 0, 5).length, 1);
    assert.equal(registry.partsNear(0, 0, 5).length, 0);

    registry.replace('sparse', [sparseIndexedPart({ id: 'sparse-v2', y: 7 })]);
    assert.equal(registry.supportYAt(-50000, 0), 7);
    registry.remove('sparse');
    assert.equal(registry.supportYAt(-50000, 0), null);
});

test('empty publication candidate captures bounded read without changing owners', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const near = squarePart({ id: 'near', minX: -2, minZ: -2, maxX: 2, maxZ: 2, y: 5, drivable: true });
    const far = squarePart({ id: 'far', minX: 500, minZ: 500, maxX: 504, maxZ: 504, y: 9, drivable: true });
    registry.replace('near', [near]); registry.replace('far', [far]);
    const revision = registry.revision;
    const tx = drain(registry.preparePublicationSteps([], {
        maxOwners: 4, maxCells: 16, maxCellParts: 32,
        queryBounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 },
    }));
    assert.equal(tx.read.supportYAt(0, 0), 5);
    assert.throws(() => tx.read.partsNear(500, 500, 1), /coverage/);
    assert.equal(registry.revision, revision);
    assert.equal(tx.commit(), true); assert.equal(registry.revision, revision);
    assert.equal(tx.finalize(), true);
    assert.equal(registry.supportYAt(0, 0), 5);
    assert.equal(registry.supportYAt(500, 500), 9);
});

test('bounded empty candidate becomes stale on intersecting change and releases its read', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const part = y => squarePart({ id: 'road', minX: -2, minZ: -2, maxX: 2, maxZ: 2, y, drivable: true });
    registry.replace('road', [part(1)]);
    const tx = drain(registry.preparePublicationSteps([], {
        maxOwners: 4, maxCells: 16, maxCellParts: 32,
        queryBounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 },
    }));
    assert.equal(tx.read.supportYAt(0, 0), 1);
    registry.replace('road', [part(2)]);
    assert.equal(tx.isCurrent(), false);
    assert.equal(tx.commit(), false);
    assert.equal(tx.discard(), true);
    assert.throws(() => tx.read.supportYAt(0, 0), /released/);
    assert.equal(registry.supportYAt(0, 0), 2);
});

test('road support batch preserves stacked levels, local revisions and old support after later failure', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const part = (id, y, drivable = true, x = -2) => squarePart({ id, y, drivable,
        minX: x, minZ: -2, maxX: x + 4, maxZ: 2 });
    registry.replace('ground', [part('ground-v1', 1)]);
    registry.replace('bridge', [part('bridge', 8)]);
    registry.replace('foot', [part('foot', 2, false, 5)]);
    const oldLocalRevision = registry.revisionNear(0, 0, 10);
    const values = [registry.prepare('ground', [part('ground-v2', 3)]), registry.prepare('foot', [])];
    const tx = drain(registry.preparePublicationSteps(values, publicationLimits), () => {
        assert.equal(registry.supportYAt(0, 0, { maxY: 5, drivableOnly: true }), 1);
        assert.equal(registry.revisionNear(0, 0, 10), oldLocalRevision);
    });
    assert.equal(tx.read.supportYAt(0, 0), 8);
    assert.equal(tx.read.supportYAt(0, 0, { maxY: 5, drivableOnly: true }), 3);
    assert.equal(tx.read.supportYAt(6, 0), null);
    assert.equal(registry.supportYAt(6, 0), 2);
    assert.deepEqual(tx.read.partsNear(0, 0, 5, { drivableOnly: true }).map(p => p.id).sort(), ['bridge', 'ground-v2']);
    assert.throws(() => tx.read.supportYAt(100, 0), /coverage/);
    assert.throws(() => tx.read.partsNear(9, 0, 5), /coverage/);
    registry.replace('far', [part('far', 11, true, 500)]);
    const beforeCommitRevision = registry.revision;
    assert.equal(tx.isCurrent(), true, 'unrelated cell publication does not restart this region');
    const publications = createSurfacePublicationRegistry();
    const entry = candidate => ({ ticket: publications.begin({ key: 'road-support', generation: registry.revision + 1 }),
        clear: true, commit: candidate.commit, rollback: candidate.rollback, discard: candidate.discard });
    assert.throws(() => publications.prepareBatch([entry(tx)], {
        commit() { assert.equal(registry.supportYAt(0, 0, { maxY: 5 }), 3); throw new Error('physics failed'); },
    }).publish(), /physics failed/);
    assert.equal(tx.state, 'discarded'); assert.throws(() => tx.read.supportYAt(0, 0), /released/);
    assert.equal(registry.supportYAt(0, 0, { maxY: 5 }), 1);
    assert.equal(registry.supportYAt(6, 0), 2); assert.equal(registry.supportYAt(501, 0), 11);
    assert.equal(registry.revision, beforeCommitRevision);
    assert.equal(registry.revisionNear(0, 0, 10), oldLocalRevision);
    const retry = drain(registry.preparePublicationSteps(values, publicationLimits));
    assert.equal(publications.prepareBatch([entry(retry)]).publish().status, 'published');
    assert.equal(retry.finalize(), true);
    assert.equal(registry.supportYAt(0, 0, { maxY: 5 }), 3);
    assert.equal(registry.supportYAt(0, 0), 8); assert.equal(registry.supportYAt(6, 0), null);
    assert.equal(registry.supportYAt(501, 0), 11);
    assert.equal(registry.revision, beforeCommitRevision + 1);
    assert.equal(registry.debugState().ownerCount, 3); publications.close(); registry.clear();
});

test('road support publication budgets, stale reads, cancellation and session clear fail without changing authority', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    const square = y => squarePart({ id: 'road', minX: -2, minZ: -2, maxX: 2, maxZ: 2, y, drivable: true });
    registry.replace('road', [square(1)]);
    const values = [registry.prepare('road', [square(2)])];
    for (const limits of [{ ...publicationLimits, maxCells: 1 }, { ...publicationLimits, maxCellParts: 1 },
        { ...publicationLimits, queryBounds: { minX: 1e30, maxX: 1e30, minZ: 0, maxZ: 0 } }]) {
        assert.throws(() => drain(registry.preparePublicationSteps(values, limits)), /capacity|coordinates/);
        assert.equal(registry.supportYAt(0, 0), 1);
    }
    const other = createRenderedRoadSurfaceRegistry();
    assert.throws(() => drain(other.preparePublicationSteps(values, publicationLimits)), /another owner or registry/);
    assert.throws(() => drain(registry.preparePublicationSteps([...values, ...values], publicationLimits)), /Duplicate/);
    const partial = registry.preparePublicationSteps(values, publicationLimits);
    assert.equal(partial.next().done, false); partial.return();
    let tx = drain(registry.preparePublicationSteps(values, publicationLimits));
    registry.replace('road', [square(4)]);
    assert.equal(tx.isCurrent(), false); assert.equal(tx.commit(), false);
    assert.equal(tx.read.supportYAt(0, 0), 2, 'held candidate read remains a snapshot');
    assert.equal(tx.discard(), true); assert.equal(registry.supportYAt(0, 0), 4);
    tx = drain(registry.preparePublicationSteps(values, publicationLimits));
    registry.clear(); assert.equal(tx.commit(), false); assert.equal(tx.discard(), true);
    assert.equal(registry.supportYAt(0, 0), null);
    tx = drain(registry.preparePublicationSteps([registry.prepare('absent', [])], publicationLimits));
    const before = registry.revision;
    assert.equal(tx.commit(), true); assert.equal(tx.finalize(), true); assert.equal(registry.revision, before);
    assert.equal(registry.debugState().ownerCount, 0);
});

test('published road triangles are one shared support authority for feet and tyres', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    registry.replace('osm:teslina', [squarePart({
        id: 'teslina',
        minX: -5,
        minZ: -20,
        maxX: 5,
        maxZ: 20,
        y: 3.4,
        drivable: true,
    })]);
    registry.replace('osm:footway', [squarePart({
        id: 'footway',
        minX: 7,
        minZ: -5,
        maxX: 10,
        maxZ: 5,
        y: 3.6,
        drivable: false,
    })]);

    assert.ok(Math.abs(registry.supportYAt(0, 0) - 3.4) < 1e-5);
    assert.ok(Math.abs(
        registry.supportYAt(0, 0, { drivableOnly: true }) - 3.4,
    ) < 1e-5);
    assert.ok(Math.abs(registry.supportYAt(8, 0) - 3.6) < 1e-5);
    assert.equal(registry.supportYAt(8, 0, { drivableOnly: true }), null);
    assert.equal(registry.partsNear(0, 0, 30, { drivableOnly: true }).length, 1);
});

test('replacement and eviction invalidate only the touched surface cells', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    registry.replace('near', [squarePart({
        id: 'near-v1',
        minX: -2,
        minZ: -2,
        maxX: 2,
        maxZ: 2,
        y: 1,
        drivable: true,
    })]);
    const nearV1 = registry.revisionNear(0, 0, 5);
    registry.replace('far', [squarePart({
        id: 'far',
        minX: 500,
        minZ: 500,
        maxX: 505,
        maxZ: 505,
        y: 9,
        drivable: true,
    })]);
    assert.equal(registry.revisionNear(0, 0, 5), nearV1);

    registry.replace('near', [squarePart({
        id: 'near-v2',
        minX: -2,
        minZ: -2,
        maxX: 2,
        maxZ: 2,
        y: 2,
        drivable: true,
    })]);
    assert.ok(registry.revisionNear(0, 0, 5) > nearV1);
    assert.ok(Math.abs(registry.supportYAt(0, 0) - 2) < 1e-5);
    registry.remove('near');
    assert.equal(registry.supportYAt(0, 0), null);
});

test('prepared support remains private until its visible generation commits', () => {
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    registry.replace('roads:tile:owner', [squarePart({
        id: 'old-visible-road',
        minX: -2,
        minZ: -2,
        maxX: 2,
        maxZ: 2,
        y: 1,
        drivable: true,
    })]);
    const beforePrepareRevision = registry.revision;
    const prepared = registry.prepare('roads:tile:owner', [squarePart({
        id: 'detached-successor',
        minX: -2,
        minZ: -2,
        maxX: 2,
        maxZ: 2,
        y: 4,
        drivable: true,
    })]);

    assert.equal(registry.revision, beforePrepareRevision);
    assert.equal(registry.supportYAt(0, 0), 1);
    registry.replacePrepared('roads:tile:owner', prepared);
    assert.equal(registry.supportYAt(0, 0), 4);
    assert.throws(
        () => registry.replacePrepared('another-owner', prepared),
        /another owner or registry/,
    );
});

test('large road parts inspect only triangles in the queried cell', () => {
    const values = [];
    const indices = [];
    for (let square = 0; square < 80; square += 1) {
        const minX = square * 60;
        const vertex = values.length / 3;
        values.push(
            minX, 4, 0,
            minX + 10, 4, 0,
            minX + 10, 4, 10,
            minX, 4, 10,
        );
        indices.push(
            vertex, vertex + 1, vertex + 2,
            vertex, vertex + 2, vertex + 3,
        );
    }
    let coordinateReads = 0;
    const positions = new Proxy(values, {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                coordinateReads += 1;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const registry = createRenderedRoadSurfaceRegistry({ cellSizeM: 20 });
    registry.replace('long-road', [{
        id: 'long-road',
        drivable: true,
        positions,
        indices: new Uint16Array(indices),
    }]);

    coordinateReads = 0;
    assert.equal(registry.supportYAt(5, 5), 4);
    assert.ok(
        coordinateReads < 100,
        `local query read ${coordinateReads} coordinates from the long road`,
    );
});
