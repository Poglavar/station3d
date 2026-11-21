// Headless unit tests for the courtyard-passage wall-span geometry — the
// rules that keep passage side walls and lintels flush with the building
// facades. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    passageWallIntervals,
    intersectLongitudinalIntervals,
    pairCeilingSpans,
    MAX_FACADE_SKEW_M,
    TRUSTED_RING_MAX_SKEW_M,
    WALL_END_INSET_M,
} from '../world/passage-geometry.js';

// Road runs along +x, right axis is +z (matches principalAxis conventions).
const AXIS = { alongX: 1, alongZ: 0, rightX: 0, rightZ: 1 };
const ORIGIN = { x: 0, z: 0 };
const INSET = WALL_END_INSET_M;

const rect = (minX, maxX, minZ, maxZ) => [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
];

test('perpendicular facades: wall spans run facade-to-facade minus the reveal inset', () => {
    const ring = rect(-10, 10, -5, 5);
    for (const offset of [-1.6, 1.6]) {
        const spans = passageWallIntervals(ring, ORIGIN, AXIS, offset, -10, 10);
        assert.equal(spans.length, 1);
        assert.ok(Math.abs(spans[0].start - (-10 + INSET)) < 1e-6);
        assert.ok(Math.abs(spans[0].end - (10 - INSET)) < 1e-6);
    }
});

test('angled facade: each side wall ends where ITS line meets the facade', () => {
    // Right facade slants: x = 10 + 0.4·z (from (8,−5) up to (12,5)).
    const ring = [
        { x: -10, z: -5 },
        { x: 8, z: -5 },
        { x: 12, z: 5 },
        { x: -10, z: 5 },
    ];
    const near = passageWallIntervals(ring, ORIGIN, AXIS, -2, -10, 10);
    const far = passageWallIntervals(ring, ORIGIN, AXIS, 2, -10, 10);
    assert.ok(Math.abs(near[0].end - (9.2 - INSET)) < 1e-6);    // 10 + 0.4·(−2)
    assert.ok(Math.abs(far[0].end - (10.8 - INSET)) < 1e-6);    // 10 + 0.4·(+2)
    assert.ok(Math.abs(near[0].start - (-10 + INSET)) < 1e-6);
    assert.ok(Math.abs(far[0].start - (-10 + INSET)) < 1e-6);
});

test('open courtyard between two wings splits the wall and the lintel', () => {
    // U-shape: solid x∈[−10,−4] and [4,10], open courtyard between, for z>−2.
    const ring = [
        { x: -10, z: -5 },
        { x: 10, z: -5 },
        { x: 10, z: 5 },
        { x: 4, z: 5 },
        { x: 4, z: -2 },
        { x: -4, z: -2 },
        { x: -4, z: 5 },
        { x: -10, z: 5 },
    ];
    const left = passageWallIntervals(ring, ORIGIN, AXIS, -1.6, -10, 10);
    const right = passageWallIntervals(ring, ORIGIN, AXIS, 1.6, -10, 10);
    for (const spans of [left, right]) {
        assert.equal(spans.length, 2);
        assert.ok(Math.abs(spans[0].start - (-10 + INSET)) < 1e-6);
        assert.ok(Math.abs(spans[0].end - (-4 - INSET)) < 1e-6);
        assert.ok(Math.abs(spans[1].start - (4 + INSET)) < 1e-6);
        assert.ok(Math.abs(spans[1].end - (10 - INSET)) < 1e-6);
    }
    const lintel = intersectLongitudinalIntervals(left, right);
    assert.equal(lintel.length, 2);
});

test('wall line missing the footprint falls back to the centre-line span', () => {
    const ring = rect(-10, 10, 3, 5);   // entirely off to one side
    const spans = passageWallIntervals(ring, ORIGIN, AXIS, -1.6, -10, 10);
    assert.deepEqual(spans, [{ start: -10 + INSET, end: 10 - INSET }]);
});

test('span running far past the centre-line facade is clamped to the skew cap', () => {
    // Building continues 20 m past the facade the centre line found.
    const ring = rect(-10, 30, -5, 5);
    const spans = passageWallIntervals(ring, ORIGIN, AXIS, 1.6, -10, 10);
    assert.equal(spans.length, 1);
    assert.ok(Math.abs(spans[0].end - (10 + MAX_FACADE_SKEW_M - INSET)) < 1e-6);
});

test('spans entirely outside the passage (distant wing) are dropped', () => {
    // Two separate blocks on the same line; passage is through the first.
    const ring = [
        { x: -10, z: -5 },
        { x: 10, z: -5 },
        { x: 10, z: 5 },
        { x: 20, z: 5 },   // pinch: zero-width bridge keeps it one ring
        { x: 20, z: -5 },
        { x: 40, z: -5 },
        { x: 40, z: 6 },
        { x: -10, z: 6 },
    ];
    const spans = passageWallIntervals(ring, ORIGIN, AXIS, 1.6, -10, 10);
    for (const span of spans) {
        assert.ok(span.start <= 10 + 0.05, `span [${span.start}, ${span.end}] starts past maxT`);
    }
});

test('steeply angled facade: trusted-ring skew allowance keeps exact crossings', () => {
    // Right facade slants hard: x = 10 + z (45°) — skew at ±2 m offsets is
    // 2 m, beyond the tight hull clamp but within the trusted allowance.
    const ring = [
        { x: -10, z: -5 },
        { x: 5, z: -5 },
        { x: 15, z: 5 },
        { x: -10, z: 5 },
    ];
    const tight = passageWallIntervals(ring, ORIGIN, AXIS, 2, -10, 10);
    const trusted = passageWallIntervals(ring, ORIGIN, AXIS, 2, -10, 10, TRUSTED_RING_MAX_SKEW_M);
    assert.ok(Math.abs(tight[0].end - (10 + MAX_FACADE_SKEW_M - INSET)) < 1e-6);   // clamped
    assert.ok(Math.abs(trusted[0].end - (12 - INSET)) < 1e-6);                     // exact crossing
});

test('pairCeilingSpans: skewed walls give one slab spanning each wall fully', () => {
    const left = [{ start: -10, end: 8 }];
    const right = [{ start: -8, end: 10 }];
    const slabs = pairCeilingSpans(left, right);
    assert.equal(slabs.length, 1);
    assert.deepEqual(slabs[0], { leftStart: -10, leftEnd: 8, rightStart: -8, rightEnd: 10 });
});

test('pairCeilingSpans: courtyard split gives one slab per wing, none across the gap', () => {
    const left = [{ start: -10, end: -4 }, { start: 4, end: 10 }];
    const right = [{ start: -10.5, end: -3.5 }, { start: 3.5, end: 10.5 }];
    const slabs = pairCeilingSpans(left, right);
    assert.equal(slabs.length, 2);
    assert.deepEqual(slabs[0], { leftStart: -10, leftEnd: -4, rightStart: -10.5, rightEnd: -3.5 });
    assert.deepEqual(slabs[1], { leftStart: 4, leftEnd: 10, rightStart: 3.5, rightEnd: 10.5 });
});

test('pairCeilingSpans: non-overlapping wall spans emit no slab', () => {
    assert.deepEqual(pairCeilingSpans([{ start: -10, end: -2 }], [{ start: 2, end: 10 }]), []);
});
