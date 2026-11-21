import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingGroundDependencyCache } from '../core/building-ground-dependencies.js';
import {
    buildFoundationSkirtPositionsCooperative,
    composeFoundationGroundSampler,
} from '../core/foundation-skirt.js';

const collect = (iterator) => {
    const yields = [];
    let step = iterator.next();
    while (!step.done) {
        yields.push(step.value);
        step = iterator.next();
    }
    return { yields, result: step.value };
};

const recordCapture = (cache, key, samples) => {
    const capture = cache.begin(key);
    for (const sample of samples) capture.record(...sample);
    capture.seal();
    return capture;
};

const samples = [
    [0, 10, 0, 0, 2],
    [0, 10, 1, 0, 2],
    [1, 10, 0, 1, 8],
];

test('equal inputs retain, while exact and null changes reject', () => {
    const cache = createBuildingGroundDependencyCache({ chunkSamples: 2, checksPerStep: 1 });
    recordCapture(cache, 'tile', samples);
    assert.equal(collect(cache.checkSteps('tile', {
        sampleGround: () => 2,
        sampleRoof: () => 8,
    })).result, true);
    assert.equal(collect(cache.checkSteps('tile', {
        sampleGround: (x) => (x === 1 ? 2.001 : 2),
        sampleRoof: () => 8,
    })).result, false);
    assert.equal(collect(cache.checkSteps('tile', {
        sampleGround: (x) => (x === 1 ? null : 2),
        sampleRoof: () => 8,
    })).result, false);
    recordCapture(cache, 'nan', [[0, 10, 0, 0, null]]);
    assert.equal(collect(cache.checkSteps('nan', {
        sampleGround: () => Number.NaN,
    })).result, false, 'null and NaN are distinct canonical samples');
});

test('checks yield and become stale when current flips after a yield', () => {
    const cache = createBuildingGroundDependencyCache({ chunkSamples: 2, checksPerStep: 1 });
    recordCapture(cache, 'tile', samples);
    let current = true;
    const iterator = cache.checkSteps('tile', {
        sampleGround: () => 2,
        sampleRoof: () => 8,
        isCurrent: () => current,
    });
    assert.deepEqual(iterator.next().value, {
        phase: 'building-ground-dependencies',
        checked: 1,
    });
    current = false;
    assert.equal(iterator.next().value, null);
});

test('successor survives old capture discard and five cycles release memory', () => {
    const cache = createBuildingGroundDependencyCache({ chunkSamples: 2 });
    for (let cycle = 0; cycle < 5; cycle++) {
        const old = cache.begin('tile');
        old.record(0, 10, 0, 0, 2);
        old.seal();
        const successor = cache.begin('tile');
        old.discard();
        successor.record(0, 10, 0, 0, 3);
        successor.seal();
        assert.equal(cache.has('tile'), true);
        assert.equal(collect(cache.checkSteps('tile', { sampleGround: () => 3 })).result, true);
        successor.discard();
    }
    assert.equal(cache.snapshot().bytes, 0);
});

test('global budget overflow releases only overflowing entry', () => {
    const cache = createBuildingGroundDependencyCache({ maxSamples: 6, chunkSamples: 2 });
    recordCapture(cache, 'kept', [[0, 10, 0, 0, 2], [0, 10, 1, 0, 2]]);
    const overflow = cache.begin('overflow');
    overflow.record(0, 10, 0, 0, 2);
    overflow.record(0, 10, 1, 0, 2);
    overflow.record(0, 10, 2, 0, 2);
    overflow.record(0, 10, 3, 0, 2);
    overflow.record(0, 10, 4, 0, 2);
    overflow.seal();
    assert.equal(cache.has('overflow'), false);
    assert.equal(cache.has('kept'), true);
    assert.equal(collect(cache.checkSteps('kept', { sampleGround: () => 2 })).result, true);
    assert.equal(cache.snapshot().bytes, 80);
});

test('real skirt callbacks can be captured and detect road and roof changes', () => {
    const segments = [
        { ax: 0, az: 0, bx: 4, bz: 0, normalX: 0, normalZ: 1 },
    ];
    const cache = createBuildingGroundDependencyCache({ checksPerStep: 1 });
    let roadHeight = -2;
    const terrain = (x) => (x < 2 ? -1 : 0);
    const sampler = composeFoundationGroundSampler({
        terrainAt: terrain,
        formationAts: [(x) => (x < 2 ? roadHeight : null)],
        topSceneY: 0,
    });
    const callbacks = [];
    const recordingSampler = (x, z) => {
        const value = sampler(x, z);
        callbacks.push({ x, z, value });
        return value;
    };
    const first = collect(buildFoundationSkirtPositionsCooperative(
        segments, 0, recordingSampler, { piecesPerStage: 1 },
    )).result;
    const capture = cache.begin('building');
    for (const { x, z, value } of callbacks) capture.record(0, 0, x, z, value);
    capture.seal();
    const same = collect(cache.checkSteps('building', {
        sampleGround: (x, z) => sampler(x, z),
    })).result;
    assert.equal(same, true);
    const unchanged = collect(buildFoundationSkirtPositionsCooperative(
        segments, 0, sampler, { piecesPerStage: 1 },
    )).result;
    assert.deepEqual(unchanged.positions, first.positions);

    roadHeight = -3;
    assert.equal(collect(cache.checkSteps('building', {
        sampleGround: (x, z) => sampler(x, z),
    })).result, false);
    const roadChanged = collect(buildFoundationSkirtPositionsCooperative(
        segments, 0, sampler, { piecesPerStage: 1 },
    )).result;
    assert.notDeepEqual(roadChanged.positions, first.positions);

    roadHeight = -2;
    let minimum = 0;
    const minimumSampler = composeFoundationGroundSampler({ terrainAt: () => -1, topSceneY: 0 });
    const minimumCapture = cache.begin('minimum');
    const minimumFirst = collect(buildFoundationSkirtPositionsCooperative(
        segments, 0, (x, z) => minimumCapture.record(0, 0, x, z, minimumSampler(x, z)), {
            piecesPerStage: 1,
            minimumBottomYAtLocal: (x, z) => minimumCapture.record(1, 0, x, z, minimum),
        },
    )).result;
    minimumCapture.seal();
    assert.equal(collect(cache.checkSteps('minimum', {
        sampleGround: () => -1, sampleRoof: () => minimum,
    })).result, true);
    minimum = -0.5;
    assert.equal(collect(cache.checkSteps('minimum', {
        sampleGround: () => -1, sampleRoof: () => minimum,
    })).result, false, 'the structural floor is a dependency even when ground height is unchanged');
    const minimumChanged = collect(buildFoundationSkirtPositionsCooperative(
        segments, 0, minimumSampler, {
            piecesPerStage: 1,
            minimumBottomYAtLocal: () => minimum,
        },
    )).result;
    assert.notDeepEqual(minimumChanged.positions, minimumFirst.positions);
});
