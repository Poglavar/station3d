import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTerrainCutoutTilesSteps } from '../core/terrain-cutout-tiles.js';
import { compileTerrainRenderPacket } from '../core/compilers/terrain-render-packet.js';

const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const region = (minX, minZ, maxX, maxZ) => ({ bounds: { minX, minZ, maxX, maxZ },
    ring: [{x:minX,z:minZ},{x:maxX,z:minZ},{x:maxX,z:maxZ},{x:minX,z:maxZ}], clipRings: [] });
const options = { tileM: 40, maxRegions: 128, maxVertices: 1024 };
const rows = [{ key: '-1_0', tileX: -1, tileZ: 0 }, { key: '0_0', tileX: 0, tileZ: 0 }, { key: '1_0', tileX: 1, tileZ: 0 }];
const layers = [
    { operation: 'subtract', regions: [region(-5, 1, 5, 8), region(3000, 3000, 3010, 3010)] },
    { operation: 'restore', regions: [region(-2, 2, 2, 7)] },
    { operation: 'subtract', regions: [region(-1, 3, 1, 6)] },
];
const limits = { maxSources: 128, maxSourceVertices: 1024, maxIndexEntries: 8192,
    maxCellCandidates: 128, maxOperandVertices: 1024, maxIntersections: 1024, maxOutputTriangles: 8192 };
function compile(row, operandLayers) {
    const terrain = { revision: 0, sceneYAtLocal: () => 0, normalAtLocal: () => ({x:0,y:1,z:0}) };
    return compileTerrainRenderPacket({ generation: 1, sourceRevision: 'flat',
        tile: { matrix: 'fixture', z: 0, x: row.tileX, y: row.tileZ, originLon: 16, originLat: 45.8, sizeM: 40 },
        inputs: { tileX: row.tileX, tileZ: row.tileZ, tileM: 40, segments: 4, snapshotRevision: 0,
            cutout: { layers: operandLayers, limits, maxVertices: 8192, maxTriangles: 8192 } } }, terrain).primitives[0];
}

test('per-tile operands preserve exact compiled triangles, crossing edges and ordered roof restoration', () => {
    const plans = drain(prepareTerrainCutoutTilesSteps(layers, rows, options));
    for (const row of rows) {
        const expected = compile(row, layers), actual = compile(row, plans.get(row.key).layers);
        assert.deepEqual(actual.positions, expected.positions);
        assert.deepEqual(actual.indices, expected.indices);
    }
    assert.equal(plans.get('1_0').signature, '');
    assert.equal(plans.get('-1_0').layers[0].regions[0], layers[0].regions[0], 'complete operand survives across tile boundary');
    assert.equal(plans.get('0_0').layers[0].regions.length, 1, 'distant operand is not transferred');
});

test('exact cut signatures preserve unchanged tiles and detect tiny coordinate edits without a hash collision', () => {
    const first = drain(prepareTerrainCutoutTilesSteps(layers, rows, options));
    const copy = structuredClone(layers);
    assert.deepEqual([...drain(prepareTerrainCutoutTilesSteps(copy, rows, options))].map(([k,v])=>[k,v.signature]),
        [...first].map(([k,v])=>[k,v.signature]));
    copy[0].regions[0].ring[0].x += .000000001;
    const changed = drain(prepareTerrainCutoutTilesSteps(copy, rows, options));
    assert.notEqual(changed.get('0_0').signature, first.get('0_0').signature);
    assert.equal(changed.get('1_0').signature, first.get('1_0').signature);
    const vertical = structuredClone(layers);
    vertical[0].regions[0].minY = -1;
    vertical[0].regions[0].maxY = 1;
    const heightBounded = drain(prepareTerrainCutoutTilesSteps(vertical, rows, options));
    assert.notEqual(heightBounded.get('0_0').signature, first.get('0_0').signature);
    assert.equal(heightBounded.get('1_0').signature, first.get('1_0').signature);
    vertical[0].regions[0].maxYExclusive=true;
    const strict=drain(prepareTerrainCutoutTilesSteps(vertical,rows,options));
    assert.notEqual(strict.get('0_0').signature,heightBounded.get('0_0').signature);
    assert.equal(strict.get('1_0').signature,heightBounded.get('1_0').signature);
    assert.throws(() => drain(prepareTerrainCutoutTilesSteps(layers, rows, {...options,maxRegions:1})), {code:'ground-generation-capacity'});
    assert.throws(() => drain(prepareTerrainCutoutTilesSteps(layers, rows, {...options,maxVertices:3})), {code:'ground-generation-capacity'});
});

test('hole and clip rings have distinct signatures and hole edits invalidate the tile', () => {
    const clip = structuredClone(layers);
    clip[0].regions[0].clipRings = [region(-2, 2, 2, 7).ring];
    const hole = structuredClone(layers);
    hole[0].regions[0].holeRings = [region(-2, 2, 2, 7).ring];
    const clipPlan = drain(prepareTerrainCutoutTilesSteps(clip, rows, options));
    const holePlan = drain(prepareTerrainCutoutTilesSteps(hole, rows, options));
    assert.notEqual(clipPlan.get('0_0').signature, holePlan.get('0_0').signature);
    const edited = structuredClone(hole);
    edited[0].regions[0].holeRings[0][0].x += .000000001;
    const editedPlan = drain(prepareTerrainCutoutTilesSteps(edited, rows, options));
    assert.notEqual(editedPlan.get('0_0').signature, holePlan.get('0_0').signature);
    assert.equal(editedPlan.get('1_0').signature, holePlan.get('1_0').signature);
});

test('source arrival order does not invalidate equal cuts, while restoration order still matters', () => {
    const cuts = [region(1, 1, 10, 10), region(7, 7, 14, 14), region(2, 2, 8, 8)];
    const first = [{ operation: 'subtract', regions: cuts },
        { operation: 'restore', regions: [region(3, 3, 4, 4)] }];
    const reordered = [{ operation: 'subtract', regions: [cuts[2], cuts[0], cuts[1]] }, first[1]];
    const signature = layers => drain(prepareTerrainCutoutTilesSteps(layers, rows, options)).get('0_0').signature;
    assert.equal(signature(reordered), signature(first));
    assert.notEqual(signature([first[1], first[0]]), signature(first));
    const area = primitive => {
        let total = 0;
        for (let i = 0; i < primitive.indices.length; i += 3) {
            const [a, b, c] = [...primitive.indices.slice(i, i + 3)].map(index => index * 3);
            const p = primitive.positions;
            total += Math.abs((p[b] - p[a]) * (p[c + 2] - p[a + 2]) - (p[b + 2] - p[a + 2]) * (p[c] - p[a])) / 2;
        }
        return total;
    };
    assert.ok(Math.abs(area(compile(rows[1], first)) - area(compile(rows[1], reordered))) < 1e-6);
});

test('shared rings count distinct vertices once while preserving compiled operands', () => {
    const shared = [{ x: 1, z: 1 }, { x: 10, z: 1 }, { x: 10, z: 10 }, { x: 1, z: 10 }];
    const ring = offset => shared.map(point => ({ x: point.x + offset, z: point.z + offset }));
    const cuts = [{ bounds: { minX: 1, minZ: 1, maxX: 10, maxZ: 10 }, ring: shared, clipRings: [] },
        { bounds: { minX: 2, minZ: 2, maxX: 11, maxZ: 11 }, ring: ring(1), clipRings: [] },
        { bounds: { minX: 3, minZ: 3, maxX: 12, maxZ: 12 }, ring: ring(2), clipRings: [] },
        { bounds: { minX: 4, minZ: 4, maxX: 13, maxZ: 13 }, ring: shared, clipRings: [] }];
    const operand = [{ operation: 'subtract', regions: cuts }];
    const plan = drain(prepareTerrainCutoutTilesSteps(operand, [rows[1]], { ...options, maxVertices: 12 }));
    const actual = compile(rows[1], plan.get('0_0').layers);
    const expected = compile(rows[1], operand);
    assert.deepEqual(actual.positions, expected.positions);
    assert.deepEqual(actual.indices, expected.indices);
    assert.throws(() => drain(prepareTerrainCutoutTilesSteps(operand, [rows[1]], { ...options, maxVertices: 11 })), error => {
        assert.equal(error.code, 'ground-generation-capacity');
        assert.equal(error.details.terrainCutout.kind, 'source-vertices');
        return true;
    });
});

test('distant operands are not counted, while ring-reference capacity is deterministic', () => {
    const distant = region(1000, 1000, 1100, 1100);
    assert.doesNotThrow(() => drain(prepareTerrainCutoutTilesSteps([{ operation: 'subtract', regions: [distant] }], [rows[1]], { ...options, maxVertices: 1 })));
    const shared = [{ x: 1, z: 1 }, { x: 10, z: 1 }, { x: 10, z: 10 }, { x: 1, z: 10 }];
    const operand = [{ operation: 'subtract', regions: [
        { bounds: { minX: 1, minZ: 1, maxX: 10, maxZ: 10 }, ring: shared, clipRings: [] },
        { bounds: { minX: 2, minZ: 2, maxX: 9, maxZ: 9 }, ring: shared, clipRings: [] },
    ] }];
    assert.throws(() => drain(prepareTerrainCutoutTilesSteps(operand, [rows[1]], { ...options, maxVertices: 4, maxRingReferences: 1 })), /ring-reference capacity/);
});

test('shared content edits invalidate affected tiles and cloned rings keep signatures stable', () => {
    const base = [{ operation: 'subtract', regions: [region(1, 1, 10, 10), region(2, 2, 8, 8)] }];
    const clone = structuredClone(base);
    const a = drain(prepareTerrainCutoutTilesSteps(base, [rows[1]], options)).get('0_0').signature;
    const b = drain(prepareTerrainCutoutTilesSteps(clone, [rows[1]], options)).get('0_0').signature;
    assert.equal(a, b);
    clone[0].regions[0].ring[0].x += 1;
    assert.notEqual(drain(prepareTerrainCutoutTilesSteps(clone, [rows[1]], options)).get('0_0').signature, a);
});
