import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGroundCompositePlanSteps, groundPaintInvalidationBounds } from '../core/ground-composite-plan.js';
import { compileSurfaceClaim, SURFACE_COVERAGE_STATE, SURFACE_VERTICAL_RELATION } from '../core/surface-hierarchy.js';
import { geoToLocal } from '../core/math.js';
const receiver = { key: 'terrain:0:0', verticalBand: 'ground', coverageRevision: 'footprint:1',
    generation: 1, bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 } };
const limits = { records: 20, vertices: 2000, verticesPerRecord: 1000, oversized: 20 };
const ring = (a, b) => [{ x: a, z: a }, { x: b, z: a }, { x: b, z: b }, { x: a, z: b }];
const paint = (key, surfaceClass, extra = {}) => ({
    key, sourceRevision: 'source:1', materialKey: surfaceClass, materialRevision: 'style:1', receiver,
    claim: compileSurfaceClaim({ surfaceClass, verticalBand: 'ground',
        verticalRelation: SURFACE_VERTICAL_RELATION.SAME_LEVEL,
        coverageState: SURFACE_COVERAGE_STATE.PUBLISHED, supportReady: true, cutsBackstop: true }),
    polygons: [{ outerRing: ring(-10, 10), holeRings: [] }], ...extra,
});
function build(records, extra = {}) {
    const iterator = createGroundCompositePlanSteps({ receiver, records, limits, ...extra });
    let step; do { step = iterator.next(); } while (!step.done);
    return step.value;
}

test('same-receiver material rank is deterministic and grants neither support nor ground removal', () => {
    const road = paint('road', 'road-carriageway'), paving = paint('paving', 'sidewalk');
    for (const records of [[road, paving], [paving, road]]) {
        const plan = build(records);
        assert.deepEqual(plan.commands.map(p => p.key), ['road', 'paving']);
        const winner = plan.paintAt(0, 0, receiver);
        assert.equal(winner.key, 'paving');
        assert.equal(winner.claim.capabilities.support, false);
        assert.equal(winner.claim.capabilities.backstopCut, false);
        assert.equal(winner.claim.capabilities.color, true);
    }
    assert.equal(build([paint('b', 'sidewalk'), paint('a', 'sidewalk')]).paintAt(0, 0, receiver).key, 'b');
    assert.equal(build([paint('b', 'sidewalk'), paint('a', 'sidewalk', { sourcePriority: 1 })]).paintAt(0, 0, receiver).key, 'a');
});

test('stacked receivers are isolated even when their polygons overlap exactly in plan', () => {
    const ground = build([paint('ground-paving', 'sidewalk')]);
    const deck = { ...receiver, key: 'bridge:deck', verticalBand: 'bridge:deck' };
    const deckRoad = paint('deck-road', 'road-carriageway', { receiver: deck,
        claim: compileSurfaceClaim({ surfaceClass: 'road-carriageway', verticalBand: deck.verticalBand,
            verticalRelation: SURFACE_VERTICAL_RELATION.GRADE_SEPARATED, coverageState: SURFACE_COVERAGE_STATE.PUBLISHED }) });
    const upper = build([deckRoad], { receiver: deck });
    assert.equal(ground.paintAt(0, 0, deck), null);
    assert.equal(upper.paintAt(0, 0, receiver), null);
    assert.equal(upper.paintAt(0, 0, deck).key, 'deck-road');
    assert.throws(() => build([deckRoad]), /different receiver/);
    assert.throws(() => build([paint('unknown', 'sidewalk', { claim: compileSurfaceClaim({ surfaceClass: 'sidewalk', coverageState: 'published' }) })]), /authority/);
});

test('polygon holes reveal the next material and inputs cannot mutate a completed plan', () => {
    const road = paint('road', 'road-carriageway');
    const paving = paint('paving', 'sidewalk', { polygons: [{ outerRing: ring(-10, 10), holeRings: [ring(-2, 2)] }] });
    const plan = build([paving, road]);
    assert.equal(plan.paintAt(0, 0, receiver).key, 'road');
    assert.equal(plan.paintAt(5, 5, receiver).key, 'paving');
    paving.polygons[0].holeRings.length = 0;
    assert.equal(plan.paintAt(0, 0, receiver).key, 'road', 'plan owns its immutable ring copy');
    assert.equal(plan.paintAt(201, 0, receiver), null);
    assert.equal(plan.paintAt(NaN, 0, receiver), null);
});

test('removal and visibility changes replay all contributors; height-only refinement does not repaint', () => {
    const road = paint('road', 'road-carriageway'), paving = paint('paving', 'sidewalk');
    const before = build([road, paving]);
    const refined = build([road, paving], { receiver: { ...receiver, generation: 2 } });
    assert.deepEqual(groundPaintInvalidationBounds(before, refined), []);
    const hidden = build([road, { ...paving, visible: false }]);
    const dirty = groundPaintInvalidationBounds(before, hidden);
    assert.equal(dirty.length, 1);
    assert.deepEqual(hidden.commandsInBounds(dirty[0]).map(p => p.key), ['road']);
    assert.equal(hidden.paintAt(0, 0, receiver).key, 'road');
    const removed = build([road]);
    assert.deepEqual(groundPaintInvalidationBounds(before, removed), dirty);
    const changed = build([road, { ...paving, sourceRevision: 'source:2', polygons: [{ outerRing: ring(30, 40), holeRings: [] }] }]);
    assert.equal(groundPaintInvalidationBounds(before, changed).length, 2, 'old and new coverage must be dirtied');
});

test('duplicate owners and resource overflow reject the private candidate instead of truncating coverage', () => {
    const a = paint('a', 'sidewalk');
    assert.throws(() => build([a, a]), /Duplicate paint owner/);
    assert.throws(() => build([a], { limits: { ...limits, vertices: 3 } }), /vertex budget/);
    assert.throws(() => build([a], { limits: { ...limits, records: 0 } }), /record budget/);
    assert.throws(() => build([{ ...a, polygons: [{ outerRing: ring(-200, 200), holeRings: [] }] }],
        { limits: { ...limits, oversized: 0 } }), /Oversized/);
    const steps = createGroundCompositePlanSteps({ receiver, records: [a], limits, verticesPerStep: 2 });
    let yields = 0, step;
    do { step = steps.next(); if (!step.done) { yields++; assert.equal(step.value.paintAt, undefined); } } while (!step.done);
    assert.ok(yields >= 3);
    assert.equal(step.value.paintAt(0, 0, receiver).key, 'a');
});

test('the real Jelačić polygon keeps its 15-vertex hole in the independent paint source index', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/ground-jelacic-source.json', import.meta.url)));
    const coordinates = fixture.road.feature.geometry.coordinates;
    const convert = ring => ring.map(([lon, lat]) => geoToLocal(lon, lat, 15.976903, 45.813215));
    const polygons = [{ outerRing: convert(coordinates[0]), holeRings: coordinates.slice(1).map(convert) }];
    const plan = build([paint('real-paving', 'sidewalk', { polygons })]);
    assert.equal(plan.byKey('real-paving').polygons[0].outerRing.length, 82);
    assert.equal(plan.byKey('real-paving').polygons[0].holeRings[0].length, 15);
    const hole = polygons[0].holeRings[0];
    const centre = hole.slice(0, -1).reduce((p, v) => ({ x: p.x + v.x / (hole.length - 1), z: p.z + v.z / (hole.length - 1) }), { x: 0, z: 0 });
    assert.equal(plan.paintAt(centre.x, centre.z, receiver), null);
    let pavingSamples = 0;
    const b = plan.byKey('real-paving').bounds;
    for (let z = b.minZ + 0.5; z < b.maxZ; z += 1) for (let x = b.minX + 0.5; x < b.maxX; x += 1) {
        if (plan.paintAt(x, z, receiver)) pavingSamples++;
    }
    assert.ok(pavingSamples > 10, 'actual material coverage must survive; an empty index cannot pass the hole check');
});
