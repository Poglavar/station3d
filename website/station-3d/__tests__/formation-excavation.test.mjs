// The depth gate that separates "a formation owns this ground" from "a
// formation dug a hole here". Getting it wrong in either direction is visible:
// too permissive punches a hole through a road at a level crossing, too strict
// leaves a car park roofing an open-cut station.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OPEN_CUT_LID_MIN_DEPTH_M,
    buildFormationExcavationRegions,
    excavationRings,
    excavationRuns,
    formationCutDepths,
    ringBoundsXZ,
} from '../core/formation-excavation.js';

// Samples along +x at 10 m spacing; `railY` is the designed formation top.
function straightRun(railYs) {
    return railYs.map((railY, index) => ({ x: index * 10, z: 0, station: index * 10, railY }));
}
const leftOf = (samples) => samples.map(s => ({ x: s.x, z: s.z - 3 }));
const rightOf = (samples) => samples.map(s => ({ x: s.x, z: s.z + 3 }));

test('a missing terrain sample yields unknown depth, never zero', () => {
    const samples = straightRun([0, 0]);
    const depths = formationCutDepths(samples, () => null);
    assert.deepEqual(depths, [null, null]);
    // NaN and undefined are the same kind of nothing.
    assert.deepEqual(formationCutDepths(samples, () => NaN), [null, null]);
    assert.deepEqual(formationCutDepths(samples, () => undefined), [null, null]);
});

test('depth is natural ground minus designed top', () => {
    const samples = straightRun([-4, -1]);
    assert.deepEqual(formationCutDepths(samples, () => 0), [4, 1]);
});

test('pre-sampled cross-section terrain evidence wins over a centre-only lookup', () => {
    const samples = straightRun([0, 0]).map(sample => ({
        ...sample,
        terrainY: 3,
    }));
    assert.deepEqual(
        formationCutDepths(samples, () => 0),
        [3, 3],
        'an uphill road edge must still establish a cut',
    );
});

test('runs cover consecutive deep samples only', () => {
    const depths = [0, 0, 3, 4, 5, 0, 0];
    assert.deepEqual(excavationRuns(depths, { minDepthM: 1.5 }), [[2, 4]]);
});

test('a lone deep sample is noise, not a trench', () => {
    assert.deepEqual(excavationRuns([0, 9, 0], { minDepthM: 1.5 }), []);
});

test('two trenches separated by an at-grade stretch stay separate', () => {
    const runs = excavationRuns([5, 5, 0, 0, 5, 5], { minDepthM: 1.5 });
    assert.deepEqual(runs, [[0, 1], [4, 5]]);
});

test('unknown depth breaks a run rather than extending it', () => {
    assert.deepEqual(excavationRuns([5, 5, null, 5, 5], { minDepthM: 1.5 }), [[0, 1], [3, 4]]);
});

test('a run reaching the last sample is closed', () => {
    assert.deepEqual(excavationRuns([0, 5, 5], { minDepthM: 1.5 }), [[1, 2]]);
});

test('the ring runs down one edge and back up the other', () => {
    const samples = straightRun([-5, -5, -5]);
    const rings = excavationRings(leftOf(samples), rightOf(samples), [[0, 2]]);
    assert.equal(rings.length, 1);
    assert.deepEqual(rings[0], [
        { x: 0, z: -3 }, { x: 10, z: -3 }, { x: 20, z: -3 },
        { x: 20, z: 3 }, { x: 10, z: 3 }, { x: 0, z: 3 },
    ]);
});

test('the ring spans only the deep stretch, not the whole formation', () => {
    // 60 m of formation; only the middle 20 m is dug in.
    const samples = straightRun([0, 0, -6, -6, 0, 0, 0]);
    const regions = buildFormationExcavationRegions({
        samples,
        left: leftOf(samples),
        right: rightOf(samples),
        baseYAtLocal: () => 0,
    });
    assert.equal(regions.length, 1);
    assert.deepEqual(ringBoundsXZ(regions[0].ring), { minX: 20, maxX: 30, minZ: -3, maxZ: 3 });
});

// The regression this whole gate exists to prevent. Delete the depth test and
// this goes red: an at-grade formation would claim its footprint as excavated,
// and every road crossing it at grade would have a hole cut through it.
test('an at-grade formation excavates nothing', () => {
    const samples = straightRun([0, 0, 0, 0, 0]);
    const regions = buildFormationExcavationRegions({
        samples,
        left: leftOf(samples),
        right: rightOf(samples),
        baseYAtLocal: () => 0.05,      // a few centimetres of survey noise
    });
    assert.deepEqual(regions, []);
});

test('an embankment excavates nothing either', () => {
    const samples = straightRun([6, 6, 6, 6]);
    const regions = buildFormationExcavationRegions({
        samples,
        left: leftOf(samples),
        right: rightOf(samples),
        baseYAtLocal: () => 0,
    });
    assert.deepEqual(regions, []);
});

test('the threshold clears at-grade noise and admits a station bay', () => {
    // A 4.2 m cut station bay (Stankovacka ulica) must qualify; a level
    // crossing's centimetres must not.
    assert.ok(OPEN_CUT_LID_MIN_DEPTH_M > 0.5, 'must clear terrain/survey noise');
    assert.ok(OPEN_CUT_LID_MIN_DEPTH_M < 4.19, 'must admit a real cut station');
});
