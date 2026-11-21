import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoastDressingBuildTask } from '../core/coast-dressing-build-task.js';

const COLLAR = {
    quads: [{
        shoreA: [0, 0],
        shoreB: [10, 0],
        landA: [0, 2],
        landB: [10, 2],
    }],
    joins: [{
        shore: [10, 0],
        landPrevious: [10, 2],
        landNext: [12, 2],
    }],
};

function drain(task) {
    let visits = 0;
    while (task.step() === 'more') {
        visits += 1;
        assert.ok(visits < 100, 'task must make bounded forward progress');
    }
    return { visits, result: task.result() };
}

function config(overrides = {}) {
    return {
        collar: COLLAR,
        seaY: -1,
        sampleTerrainY: ([x, z]) => x * 0.1 + z * 0.25,
        terrainAware: true,
        uvPerM: 0.5,
        ...overrides,
    };
}

test('coast dressing compiler is deterministic across chunk sizes', () => {
    const fine = drain(createCoastDressingBuildTask(config({
        itemsPerStep: 1,
        trianglesPerStep: 1,
    })));
    const coarse = drain(createCoastDressingBuildTask(config({
        itemsPerStep: 100,
        trianglesPerStep: 100,
    })));

    assert.ok(fine.visits > coarse.visits, 'small chunks yield more often');
    assert.equal(fine.result.status, 'ready');
    assert.deepEqual(fine.result.collarPositions, coarse.result.collarPositions);
    assert.deepEqual(fine.result.collarNormals, coarse.result.collarNormals);
    assert.deepEqual(fine.result.collarUvs, coarse.result.collarUvs);
    assert.deepEqual(fine.result.wallPositions, coarse.result.wallPositions);
    assert.deepEqual(fine.result.wallNormals, coarse.result.wallNormals);
    assert.equal(fine.result.collarPositions.length, 27);
    assert.equal(fine.result.collarUvs.length, 18);
    assert.equal(fine.result.wallPositions.length, 18);
});

test('every task visit samples at most its configured shoreline chunk', () => {
    let samples = 0;
    const task = createCoastDressingBuildTask(config({
        itemsPerStep: 1,
        sampleTerrainY: () => {
            samples += 1;
            return 3;
        },
    }));

    task.step();
    assert.equal(samples, 2, 'one quad samples its two landward endpoints');
    task.step();
    assert.equal(samples, 3, 'the join reuses one endpoint and samples one new point');
});

test('shared shoreline corners use the highest valid landward surface', () => {
    const collar = {
        quads: [
            { shoreA: [0, 0], shoreB: [1, 0], landA: [0, 1], landB: [1, 1] },
            { shoreA: [1, 0], shoreB: [2, 0], landA: [1, 2], landB: [2, 2] },
        ],
        joins: [],
    };
    const { result } = drain(createCoastDressingBuildTask(config({
        collar,
        sampleTerrainY: ([, z]) => z,
    })));
    const sharedCornerYs = [];
    for (let offset = 0; offset < result.collarPositions.length; offset += 3) {
        if (result.collarPositions[offset] === 1
            && result.collarPositions[offset + 2] === 0) {
            sharedCornerYs.push(result.collarPositions[offset + 1]);
        }
    }
    assert.ok(sharedCornerYs.length > 1);
    assert.deepEqual(new Set(sharedCornerYs), new Set([2]));
});

test('resolved coastal infill keeps its explicit shoreline and land heights', () => {
    const collar = {
        quads: [{
            shoreA: [0, 0], shoreB: [2, 0], landA: [0, 4], landB: [2, 4],
            shoreAY: -0.25, shoreBY: -0.25, landAY: 7, landBY: 9,
        }],
        joins: [],
    };
    let samples = 0;
    const { result } = drain(createCoastDressingBuildTask(config({
        collar,
        sampleTerrainY: () => {
            samples += 1;
            return 100;
        },
    })));
    assert.equal(samples, 0, 'resolved infill never resamples mutable terrain');
    const vertices = [];
    for (let offset = 0; offset < result.collarPositions.length; offset += 3) {
        vertices.push(Array.from(result.collarPositions.slice(offset, offset + 3)));
    }
    assert.ok(vertices.some(([x, y, z]) => x === 0 && z === 0 && y === -0.25));
    assert.ok(vertices.some(([x, y, z]) => x === 0 && z === 4 && y === 7));
    assert.ok(vertices.some(([x, y, z]) => x === 2 && z === 4 && y === 9));
});

test('missing terrain evidence produces no partial geometry', () => {
    const { result } = drain(createCoastDressingBuildTask(config({
        sampleTerrainY: ([x]) => (x === 10 ? null : 1),
    })));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.collarPositions.length, 0);
    assert.equal(result.wallPositions.length, 0);
});

test('normals are finite and normalized without an eager whole-buffer pass', () => {
    const { result } = drain(createCoastDressingBuildTask(config()));
    for (const normals of [result.collarNormals, result.wallNormals]) {
        for (let offset = 0; offset < normals.length; offset += 3) {
            const length = Math.hypot(
                normals[offset],
                normals[offset + 1],
                normals[offset + 2],
            );
            assert.ok(Number.isFinite(length));
            assert.ok(Math.abs(length - 1) < 1e-5, `normal length ${length}`);
        }
    }
});

test('cancellation releases staged typed arrays and cannot resume', () => {
    const task = createCoastDressingBuildTask(config({ itemsPerStep: 1 }));
    assert.equal(task.step(), 'more');
    task.cancel();
    assert.equal(task.phaseLabel(), 'done');
    assert.deepEqual(task.result(), { status: 'cancelled' });
    assert.equal(task.step(), 'done');
});
