// Locks profile-solver output and cooperation independently of a live renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    designRailVerticalProfile,
    designRailVerticalProfileSteps,
    interpolateUnknownTerrain,
} from '../core/rail-formation.js';

test('windowed profile design preserves the pre-optimization floating-point result', () => {
    const samples = Array.from({ length: 13 }, (_, index) => ({
        station: index * 37,
        terrainY: index === 4 || index === 5 ? null : 12 + Math.sin(index * 0.72) * 9 + index * 0.3,
    }));
    // Captured from main at 0f69144 before changing the solver, not computed by
    // the implementation under test. Contains gaps, endpoint ties and cut bias.
    assert.deepEqual(designRailVerticalProfile(samples, {
        denoiseRadiusM: 70, smoothingRadiusM: 170, maxGrade: 0.06, cutAvoidanceRatio: 0.35,
    }), [
        12, 14.219999999999999, 16.439999999999998, 17.02451442184328,
        14.80451442184328, 12.58451442184328, 11.263906552741073,
        11.440410926327075, 13.080012861622905, 15.300012861622903,
        17.520012861622902, 19.7400128616229, 21.9600128616229,
    ]);
});

test('long solver steps yield during normalization, smoothing and grade projection', () => {
    const samples = Array.from({ length: 5000 }, (_, index) => ({
        station: index * 4,
        terrainY: index % 71 === 0 ? null : 10 + Math.sin(index * 0.1),
    }));
    const original = structuredClone(samples);
    const steps = designRailVerticalProfileSteps(samples);
    const phases = new Set();
    let outcome = steps.next();
    while (!outcome.done) {
        phases.add(outcome.value.phase);
        outcome = steps.next();
    }
    for (const phase of ['normalize', 'interpolate', 'denoise', 'smooth', 'grade']) {
        assert.ok(phases.has(phase), `missing ${phase} yield`);
    }
    assert.deepEqual(outcome.value, designRailVerticalProfile(samples));
    assert.deepEqual(samples, original, 'the solver must not write its input samples');
});

test('terrain-gap interpolation follows input neighbours even with unordered stations', () => {
    assert.deepEqual(interpolateUnknownTerrain([
        { station: 20, terrainY: null },
        { station: 10, terrainY: 2 },
        { station: 5, terrainY: null },
        { station: 0, terrainY: 8 },
        { station: -5, terrainY: null },
    ]).map(sample => sample.terrainY), [2, 2, 2, 8, 8]);
    assert.equal(designRailVerticalProfile([{ terrainY: null }, { terrainY: undefined }]), null);
});
