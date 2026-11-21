// Level-crossing detection re-runs every time the streamed road formation
// advances, and the accumulator in rails.js only ever grows — so a re-run can
// only usefully contribute crossings involving roads that CHANGED since the
// last pass. The full re-scan was ~150 ms on a 52 km alignment, ~25 times over
// a five-minute prod ride: the single biggest recurring stutter in the trace.
//
// These pin the incremental contract: bounded passes look only where the roads
// changed, a bounded pass NEVER finds less than the full scan would inside its
// bounds, and the union of bounded passes equals the full scan — which is what
// makes the accumulator's contents identical either way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAtGradeLevelCrossings, detectAtGradeLevelCrossingsSteps } from '../world/level-crossing-detect.js';

// A dead-straight at-grade alignment along x, sampled every 10 m.
function railFormation(lengthM = 1000) {
    const samples = [];
    for (let x = 0; x <= lengthM; x += 10) {
        samples.push({ x, z: 0, railY: 0, terrainY: 0, maxFillM: 0, minCoverM: 0 });
    }
    return { alignments: [{ samples, halfWidthM: 3 }] };
}

test('cooperative detection preserves crossing frames and stops before further road queries when stale', () => {
    const rail = railFormation(200), roads = roadFormation([15, 75, 155]);
    const expected = detectAtGradeLevelCrossings(rail, roads);
    let clock = 0, current = true;
    const make = () => detectAtGradeLevelCrossingsSteps(rail, roads, { now: () => clock++, isCurrent: () => current });
    const phases = new Set(), steps = make(); let next;
    do { next = steps.next(); if (!next.done) phases.add(next.value.phase); } while (!next.done);
    assert.deepEqual(next.value, expected);
    assert.ok(phases.has('crossing-sample')); assert.ok(phases.has('crossing-road-segment'));
    const stale = make(); stale.next(); const count = roads.queries.count; current = false;
    assert.deepEqual(stale.next(), { value: null, done: true }); assert.equal(roads.queries.count, count);
});

test('missing terrain evidence cannot create an at-grade crossing', () => {
    const rail = railFormation(100), roads = roadFormation([15]);
    assert.equal(detectAtGradeLevelCrossings(rail, roads).length, 1);
    for (const sample of rail.alignments[0].samples) {
        sample.maxFillM = null; sample.minCoverM = null; sample.terrainY = null;
    }
    assert.deepEqual(detectAtGradeLevelCrossings(rail, roads), []);
});

// Perpendicular roads crossing the track at the given x positions, with a
// query counter so a test can assert how much of the corridor was scanned.
function roadFormation(roadXs) {
    const queries = { count: 0 };
    return {
        queries,
        nearbyCenterlineSegments(x, z, radius) {
            queries.count += 1;
            const segs = [];
            for (const roadX of roadXs) {
                if (Math.abs(x - roadX) <= radius) segs.push([roadX, -20, roadX, 20]);
            }
            return segs;
        },
    };
}

const positions = (crossings) => crossings.map(c => Math.round(c.x)).sort((a, b) => a - b);

test('a full scan finds every crossing', () => {
    const roads = roadFormation([95, 895]);
    const found = detectAtGradeLevelCrossings(railFormation(), roads);
    assert.deepEqual(positions(found), [95, 895]);
    assert.equal(roads.queries.count, 101, 'full scan queries every sample');
});

test('a bounded pass finds only crossings near the change, and scans only there', () => {
    const roads = roadFormation([95, 895]);
    const found = detectAtGradeLevelCrossings(railFormation(), roads, {
        changedBounds: [{ minX: 880, maxX: 910, minZ: -10, maxZ: 10 }],
    });
    assert.deepEqual(positions(found), [895], 'only the crossing inside the changed area');
    // 30 m of bound + 40 m pad each side ≈ 11 samples, not 101. The point of
    // the whole change: cost proportional to what changed, not to the corridor.
    assert.ok(roads.queries.count <= 15,
        `expected a handful of queries, got ${roads.queries.count}`);
});

test('the pad reaches a crossing just outside the literal bound', () => {
    // The changed road feature's bbox can end AT the crossing (a road ending on
    // the track). Samples slightly outside must still be examined.
    const roads = roadFormation([95]);
    const found = detectAtGradeLevelCrossings(railFormation(), roads, {
        changedBounds: [{ minX: 95, maxX: 96, minZ: -20, maxZ: 20 }],
    });
    assert.deepEqual(positions(found), [95]);
});

test('an empty change list detects nothing and scans nothing', () => {
    const roads = roadFormation([95, 895]);
    const found = detectAtGradeLevelCrossings(railFormation(), roads, { changedBounds: [] });
    assert.deepEqual(found, []);
    assert.equal(roads.queries.count, 0);
});

test('bounded passes over covering bounds equal the full scan', () => {
    // The property that keeps the accumulator identical whichever path ran:
    // detection over the whole corridor = union of detections over pieces.
    const roadXs = [95, 355, 615, 895];
    const full = detectAtGradeLevelCrossings(railFormation(), roadFormation(roadXs));

    const pieces = [
        { minX: 0, maxX: 400, minZ: -10, maxZ: 10 },
        { minX: 400, maxX: 1000, minZ: -10, maxZ: 10 },
    ];
    const union = [];
    for (const bound of pieces) {
        union.push(...detectAtGradeLevelCrossings(railFormation(), roadFormation(roadXs), {
            changedBounds: [bound],
        }));
    }
    // The 40 m pad makes pieces overlap, so the union may hold near-duplicates
    // — exactly what the caller's position-keyed accumulator collapses.
    const deduped = [...new Set(positions(union))];
    assert.deepEqual(deduped, positions(full));
    assert.deepEqual(positions(full), roadXs);
});

test('a change area with no at-grade track nearby detects nothing', () => {
    const roads = roadFormation([95]);
    const found = detectAtGradeLevelCrossings(railFormation(), roads, {
        changedBounds: [{ minX: 5000, maxX: 5100, minZ: 400, maxZ: 500 }],
    });
    assert.deepEqual(found, []);
});
