import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturePlannerTrackSegmentsSteps, capturePlannerTrackSegments,
    PLANNER_TRACK_SEGMENT_LIMITS } from '../core/planner-track-segments.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/planner-segments-before-capture.json', import.meta.url), 'utf8'));
const drain = steps => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };
const ground = (x, z) => 100 + .1 * x + .05 * z;

test('cooperative planner capture preserves independent frozen routes, grades and joins', () => {
    for (const fixture of golden.cases) {
        let clock = 0, yields = 0;
        const options = fixture.options === 'absolute' ? { absoluteToSceneY: y => y - 120 }
            : fixture.options === 'ground' ? { groundSceneYAtLocal: ground }
                : fixture.options === 'ground-missing' ? { groundSceneYAtLocal: (x, z) => x > 3 ? null : ground(x, z) }
                    : fixture.options === 'ground-missing-interior'
                        ? { groundSceneYAtLocal: (x, z) => x > 300 && x < 400 ? null : ground(x, z) } : {};
        const steps = capturePlannerTrackSegmentsSteps(fixture.features, golden.anchor.lat, golden.anchor.lon,
            { ...options, now: () => clock += .3 });
        let result;
        for (;;) { const next = steps.next(); if (next.done) { result = next.value; break; } yields++; }
        // JSON normalises -0 exactly as the independently saved fixture did.
        assert.deepEqual(JSON.parse(JSON.stringify(result)), fixture.segments, fixture.name);
        assert.equal(result.terrainEvidenceIncomplete === true, fixture.terrainEvidenceIncomplete, fixture.name);
        assert.ok(yields > 0);
    }
});

test('a long evidence segment yields between probes, rejects missing interior evidence, and obeys query capacity', () => {
    const features = [{ geometry: { type: 'LineString', coordinates: [[15.97, 45.81, -10], [15.98, 45.81, -10]] },
        properties: { elevationMode: 'ground-relative' } }];
    let clock = 0, calls = 0, previousCalls = 0;
    const steps = capturePlannerTrackSegmentsSteps(features, 45.81, 15.97, { now: () => clock += .3,
        groundSceneYAtLocal(x, z) { calls++; return x > 300 && x < 400 ? null : ground(x, z); } });
    let result;
    for (;;) {
        const next = steps.next();
        assert.ok(calls - previousCalls <= 2, 'one scheduler visit consumed the whole evidence segment');
        previousCalls = calls;
        if (next.done) { result = next.value; break; }
    }
    assert.deepEqual(result, []); assert.equal(result.terrainEvidenceIncomplete, true); assert.ok(calls > 10);
    assert.throws(() => capturePlannerTrackSegments(features, 45.81, 15.97, {
        groundSceneYAtLocal: ground, limits: { ...PLANNER_TRACK_SEGMENT_LIMITS, maxEvidenceQueries: 3 },
    }), { code: 'ground-generation-capacity' });
});

test('source caps, cancellation, and missing converted heights reject the complete candidate', () => {
    const fixture = golden.cases[0];
    assert.throws(() => capturePlannerTrackSegments(fixture.features, golden.anchor.lat, golden.anchor.lon, {
        limits: { ...PLANNER_TRACK_SEGMENT_LIMITS, maxCoordinates: 2 },
    }), { code: 'ground-generation-capacity' });
    let current = true, clock = 0;
    const steps = capturePlannerTrackSegmentsSteps(fixture.features, golden.anchor.lat, golden.anchor.lon,
        { isCurrent: () => current, now: () => clock += .3 });
    assert.equal(steps.next().done, false); current = false;
    assert.throws(() => drain(steps), { code: 'ground-generation-stale' });
    const absolute = golden.cases.find(row => row.name === 'absolute-converted');
    assert.throws(() => capturePlannerTrackSegments(absolute.features, golden.anchor.lat, golden.anchor.lon,
        { absoluteToSceneY: () => null }), { code: 'ground-source-unavailable' });
});
