// Tests for the pure level-crossing geometry (station-3d/core/level-crossing.js):
// track×road intersection frames, at-grade filtering + dedup, and the zebra /
// apron quad layouts. All planar [x, z] — no THREE, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    segmentCrossing, collectAtGradeLevelCrossings, buildZebraStripes, buildCrossingAprons,
} from '../core/level-crossing.js';

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('segmentCrossing finds a square crossing at the origin', () => {
    // Track runs S→N through origin; road runs W→E through origin.
    const f = segmentCrossing([0, -10], [0, 10], [-10, 0], [10, 0]);
    assert.ok(f, 'segments cross');
    assert.ok(approx(f.x, 0) && approx(f.z, 0), 'crossing at origin');
    assert.ok(approx(f.skewRad, Math.PI / 2), 'square crossing → 90°');
    // roadAxis points along +x, trackAxis along +z (magnitudes normalised).
    assert.ok(approx(Math.hypot(...f.roadAxis), 1) && approx(Math.hypot(...f.trackAxis), 1));
});

test('segmentCrossing returns null when segments miss or are parallel', () => {
    assert.equal(segmentCrossing([0, 0], [0, 10], [5, 0], [5, 10]), null, 'parallel');
    assert.equal(segmentCrossing([0, 0], [0, 2], [10, -1], [10, 1]), null, 'no overlap');
    assert.equal(segmentCrossing([0, 0], [0, 0], [-1, 0], [1, 0]), null, 'degenerate track');
});

test('collectAtGradeLevelCrossings keeps only both-ends-at-grade segments', () => {
    // A 3-vertex track; the FIRST segment is at grade, the second is on a viaduct
    // (vertex 2 not at grade). Both segments cross a road, but only the level one
    // should produce a crossing.
    const trackPts = [[0, -5], [0, 5], [0, 15]];
    const atGrade = [true, true, false];   // vertex 2 elevated
    const roads = [
        [-10, 0, 10, 0],    // crosses segment 0 at (0,0)  → level crossing
        [-10, 10, 10, 10],  // crosses segment 1 at (0,10) → on the viaduct, skip
    ];
    const crossings = collectAtGradeLevelCrossings(trackPts, atGrade, roads);
    assert.equal(crossings.length, 1);
    assert.ok(approx(crossings[0].z, 0), 'kept the at-grade crossing, dropped the elevated one');
    assert.equal(crossings[0].segmentIndex, 0);
});

test('collectAtGradeLevelCrossings dedups near-coincident road hits', () => {
    // Two road segments meeting AT the crossing (a T-junction on the track) must
    // paint one zebra, not two overlapping ones.
    const trackPts = [[0, -5], [0, 5]];
    const atGrade = [true, true];
    const roads = [
        [-10, 0, 0, 0],   // ends at the crossing
        [0, 0, 10, 0],    // starts at the crossing
    ];
    const crossings = collectAtGradeLevelCrossings(trackPts, atGrade, roads, { mergeM: 4 });
    assert.equal(crossings.length, 1, 'merged into a single crossing');
});

test('buildZebraStripes lays parallel stripes across the carriageway', () => {
    const frame = { x: 0, z: 0, roadAxis: [1, 0], trackAxis: [0, 1] };
    const quads = buildZebraStripes(frame, { roadWidthM: 7, bandDepthM: 4, stripeW: 0.5, gapW: 0.5 });
    // 7 m / 1 m period → 7 stripes.
    assert.equal(quads.length, 7);
    // Each quad has 4 [x,z] corners.
    for (const q of quads) {
        assert.equal(q.length, 4);
        for (const c of q) assert.equal(c.length, 2);
    }
    // Stripes run ALONG the road (±2 m in x here), and step ACROSS it (in z).
    const q0 = quads[0];
    const alongSpan = Math.max(...q0.map((c) => c[0])) - Math.min(...q0.map((c) => c[0]));
    const acrossSpan = Math.max(...q0.map((c) => c[1])) - Math.min(...q0.map((c) => c[1]));
    assert.ok(approx(alongSpan, 4), 'stripe length = band depth along road');
    assert.ok(approx(acrossSpan, 0.5), 'stripe width across road');
    // The run is centred: 7 stripes × 0.5 m + 6 gaps × 0.5 m = 6.5 m band → ±3.25.
    const nearEdge = Math.min(...quads.flat().map((c) => c[1]));
    const farEdge = Math.max(...quads.flat().map((c) => c[1]));
    assert.ok(approx(nearEdge, -3.25) && approx(farEdge, 3.25), 'zebra band centred across the road');
});

test('buildZebraStripes orients stripes with a diagonal road', () => {
    // Road at 45°: stripes must follow the road axis, not the world axes.
    const inv = 1 / Math.SQRT2;
    const frame = { x: 5, z: 5, roadAxis: [inv, inv], trackAxis: [inv, -inv] };
    const quads = buildZebraStripes(frame, { roadWidthM: 4, bandDepthM: 4, stripeW: 0.5, gapW: 0.5 });
    assert.ok(quads.length >= 1);
    // A stripe's long edge (corner 1→2, the along-road side) follows the road axis.
    const q = quads[0];
    const edge = [q[2][0] - q[1][0], q[2][1] - q[1][1]];
    const el = Math.hypot(...edge);
    assert.ok(approx(edge[0] / el, inv) && approx(edge[1] / el, inv), 'long edge follows the road');
});

test('buildCrossingAprons returns two ramps flanking the trackbed', () => {
    const frame = { x: 0, z: 0, roadAxis: [1, 0], trackAxis: [0, 1] };
    const [near, far] = buildCrossingAprons(frame, { trackHalfWidthM: 3, apronLenM: 2.5, roadWidthM: 7 });
    assert.equal(near.length, 4);
    assert.equal(far.length, 4);
    // Near apron sits on −x from the trackbed edge (−5.5 … −3), far on +x (3 … 5.5).
    assert.ok(Math.max(...near.map((c) => c[0])) <= -3 + 1e-6, 'near apron ends at the trackbed edge');
    assert.ok(Math.min(...far.map((c) => c[0])) >= 3 - 1e-6, 'far apron starts at the trackbed edge');
    // Both span the full road width across.
    for (const q of [near, far]) {
        const acrossSpan = Math.max(...q.map((c) => c[1])) - Math.min(...q.map((c) => c[1]));
        assert.ok(approx(acrossSpan, 7), 'apron spans the road width');
    }
});
