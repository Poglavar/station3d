// Guard paint preparation work while comparing the emitted triangles with the
// independent source ownership query, including holes and overlapping ranks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShapeUtils } from 'three';
import { createGroundCompositePlanSteps } from '../core/ground-composite-plan.js';
import { createGroundPaintPacketSteps } from '../core/ground-paint-packet.js';
import { planGroundPaintUpdate } from '../core/ground-paint-update.js';
import { captureGroundPaintStyles } from '../core/ground-paint-styles.js';
import { compileSurfaceClaim, SURFACE_CLASS } from '../core/surface-hierarchy.js';

const bounds = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
const receiver = { key: 'paint-work', verticalBand: 'ground', coverageRevision: 'r1', bounds };
const claim = compileSurfaceClaim({ surfaceClass: SURFACE_CLASS.SIDEWALK,
    coverageState: 'published', verticalBand: 'ground', verticalRelation: 'same-level' });
const styles = new Map(['a', 'b'].map((key, index) => [key, {
    id: index + 1, revision: 'm1', surfaceClass: SURFACE_CLASS.SIDEWALK,
    roughness: .96, metalness: 0, normalInfluence: 0, linearColor: [1, 1, 1],
}]));
const run = task => { let next; do { next = task.next(); } while (!next.done); return next.value; };
const rectangle = (x, z, width, height = width) => ({ outerRing: [
    { x, z }, { x: x + width, z }, { x: x + width, z: z + height }, { x, z: z + height },
], holeRings: [] });
const record = (key, polygons, materialKey = 'a') => ({ key, sourceRevision: `${key}:1`,
    materialKey, materialRevision: 'm1', claim, receiver, polygons });
const planFor = (records, target = receiver) => run(createGroundCompositePlanSteps({ receiver: target,
    records: records.map(row => ({ ...row, receiver: target })),
    limits: { records: 100, vertices: 10000, verticesPerRecord: 10000, oversized: 100 } }));
const prepare = (plan, extra = {}) => createGroundPaintPacketSteps({ plan, bounds, size: 16, styles,
    limits: { pixels: 256, draws: 100, verticesPerPolygon: 8192 }, ...extra });

function paintedStyle(packet, x, z) {
    let style = 0;
    const px = x - packet.bounds.minX, pz = z - packet.bounds.minZ;
    for (const draw of packet.draws) {
        if (!draw.regions.some(({ bounds: b }) => x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ)) continue;
        for (let i = 0; i < draw.indices.length; i += 3) {
            const cross = [];
            for (let edge = 0; edge < 3; edge++) {
                const a = draw.indices[i + edge] * 3, b = draw.indices[i + (edge + 1) % 3] * 3;
                cross.push((draw.positions[b] - draw.positions[a]) * (pz - draw.positions[a + 1])
                    - (draw.positions[b + 1] - draw.positions[a + 1]) * (px - draw.positions[a]));
            }
            if (cross.every(n => n >= -1e-8) || cross.every(n => n <= 1e-8)) style = draw.styleId;
        }
    }
    return style;
}

test('one wide source only triangulates polygons touching the page and yields while rejecting the rest', t => {
    const visible = rectangle(1, 1, 8);
    visible.holeRings = [rectangle(3, 3, 4).outerRing];
    const remote = Array.from({ length: 128 }, (_, i) => rectangle(100 + i, 100, .5));
    const plan = planFor([record('wide-source', [...remote, visible])]);
    const spy = t.mock.method(ShapeUtils, 'triangulateShape', ShapeUtils.triangulateShape);
    const task = prepare(plan);
    let workBeforeTriangulation = 0, next;
    do {
        next = task.next();
        if (!next.done && spy.mock.callCount() === 0 && next.value.phase !== 'paint-region-query') workBeforeTriangulation++;
    } while (!next.done);
    assert.equal(spy.mock.callCount(), 1, 'off-page polygons must not allocate triangulation work');
    assert.ok(workBeforeTriangulation > 0, 'a rejected polygon run must still allow cancellation/frame budgeting');
    assert.equal(next.value.stats.triangles, 8, 'the visible hole remains open');
    for (const [x, z] of [[2, 2], [5, 5], [.5, .5]]) {
        assert.equal(paintedStyle(next.value, x, z), plan.paintAt(x, z, receiver) ? 1 : 0);
    }
});

test('copied blocks avoid triangulation for untouched polygons inside the same page', t => {
    const plan = planFor([record('wide-source', [rectangle(.4, .4, 1), rectangle(8, 8, 1)])]);
    const previous = { receiver, bounds, size: 16, styles: captureGroundPaintStyles(styles) };
    const update = planGroundPaintUpdate({ receiver, bounds, size: 16, previous, blockSize: 4,
        dirtyBounds: [{ minX: .5, minZ: .5, maxX: 1, maxZ: 1 }] });
    const spy = t.mock.method(ShapeUtils, 'triangulateShape', ShapeUtils.triangulateShape);
    const packet = run(prepare(plan, { update }));
    assert.ok(update.copies.length > 0);
    assert.equal(spy.mock.callCount(), 1, 'a copied block retains its pixels without re-triangulating its polygon');
    assert.equal(paintedStyle(packet, .75, .75), 1);
    assert.equal(packet.stats.triangles, 2);
});

test('adjacent identical material owners share draws without crossing a different material or losing provenance', () => {
    const hole = rectangle(0, 0, 10);
    hole.holeRings = [rectangle(4, 4, 2).outerRing];
    const records = [record('a-base', [hole]), record('b-same', [rectangle(0, 0, 3)]),
        record('c-other', [rectangle(1, 1, 2)], 'b'), record('d-top', [rectangle(2, 2, 1)])];
    const plan = planFor(records);
    const packet = run(prepare(plan));
    assert.equal(packet.draws.length, 3, 'only consecutive matching materials may merge');
    assert.deepEqual(packet.draws.map(draw => draw.styleId), [1, 2, 1]);
    assert.deepEqual(packet.draws.flatMap(draw => draw.sources.map(source => source.key)), records.map(row => row.key));
    assert.deepEqual(packet.draws[0].sources.map(source => source.sourceRevision), ['a-base:1', 'b-same:1']);
    assert.equal(Object.isFrozen(packet.draws[0].sources), true);
    for (const draw of packet.draws) {
        let offset = 0;
        for (const source of draw.sources) {
            assert.equal(source.indexOffset, offset);
            assert.ok(source.indexCount > 0 && source.indexCount % 3 === 0);
            assert.ok(Object.isFrozen(source));
            offset += source.indexCount;
        }
        assert.equal(offset, draw.indices.length, 'source ranges partition the complete geometry');
    }
    for (let z = .125; z < 10; z += .25) for (let x = .125; x < 10; x += .25) {
        const winner = plan.paintAt(x, z, receiver);
        assert.equal(paintedStyle(packet, x, z), winner ? styles.get(winner.materialKey).id : 0, `${x},${z}`);
    }
});

test('merged owners retain the finite vertex, submission and geometry limits', () => {
    const plan = planFor([record('a', [rectangle(0, 0, 2)]), record('b', [rectangle(4, 0, 2)])]);
    const limits = { pixels: 256, draws: 100, verticesPerPolygon: 8, submissions: 1, geometryBytes: 144 };
    const merged = run(prepare(plan, { limits }));
    assert.equal(merged.stats.draws, 1);
    assert.equal(merged.stats.submissions, 1);
    assert.equal(merged.stats.geometryBytes, 144);
    assert.throws(() => run(prepare(plan, { limits: { ...limits, geometryBytes: 143 } })), /geometry byte budget/);
    assert.throws(() => run(prepare(plan, { limits: { ...limits, verticesPerPolygon: 4 } })), /submission budget/);
    const split = run(prepare(plan, { limits: { ...limits, verticesPerPolygon: 4, submissions: 2 } }));
    assert.equal(split.draws.length, 2);
});

test('early page rejection retains precision far from the scene anchor and validates polygon capacity', () => {
    const bounds = { minX: 100000, minZ: -100000, maxX: 100010, maxZ: -99990 };
    const target = { ...receiver, bounds };
    const plan = planFor([record('distant', [rectangle(100001, -99999, .125), rectangle(100100, -99900, 1)])], target);
    const packet = run(prepare(plan, { bounds }));
    assert.deepEqual([...packet.draws[0].positions], [1, 1, 0, 1.125, 1, 0, 1.125, 1.125, 0, 1, 1.125, 0]);
    const oversized = rectangle(100100, -99900, 1);
    oversized.outerRing.push({ ...oversized.outerRing[0] });
    const invalid = planFor([record('distant', [rectangle(100001, -99999, .125), oversized])], target);
    assert.throws(() => run(prepare(invalid, { bounds,
        limits: { pixels: 256, draws: 100, verticesPerPolygon: 4 } })), /item budget/);
});
