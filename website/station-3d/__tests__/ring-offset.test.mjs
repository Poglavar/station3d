// Verifies the curtain-wall separation offset: the ring must grow (never shrink)
// by the requested distance regardless of winding, in metres rather than degrees.

import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetRingOutward, offsetPolygonOutward, ringSignedArea } from '../core/ring-offset.js';

const LAT = 45.75;
const M_PER_DEG_LAT = 111320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos(LAT * Math.PI / 180);

// 100 m x 100 m square, counter-clockwise.
function square(ccw = true) {
    const d = 100 / M_PER_DEG_LAT;
    const e = 100 / mPerDegLon;
    const ring = [[16, LAT], [16 + e, LAT], [16 + e, LAT + d], [16, LAT + d], [16, LAT]];
    return ccw ? ring : [...ring].reverse();
}

function extentMetres(ring) {
    const xs = ring.map((p) => p[0] * mPerDegLon);
    const ys = ring.map((p) => p[1] * M_PER_DEG_LAT);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

test('grows the footprint by the requested distance on every side', () => {
    const before = extentMetres(square());
    const after = extentMetres(offsetRingOutward(square(), 0.03, LAT));
    // 3 cm out on both sides of each axis = 6 cm wider overall.
    assert.ok(Math.abs((after.w - before.w) - 0.06) < 0.005, `width grew ${(after.w - before.w).toFixed(4)}m`);
    assert.ok(Math.abs((after.h - before.h) - 0.06) < 0.005, `height grew ${(after.h - before.h).toFixed(4)}m`);
});

test('grows regardless of winding — a clockwise ring must not shrink', () => {
    for (const ccw of [true, false]) {
        const before = extentMetres(square(ccw));
        const after = extentMetres(offsetRingOutward(square(ccw), 0.03, LAT));
        assert.ok(after.w > before.w, `ccw=${ccw} shrank instead of growing`);
        assert.ok(after.h > before.h, `ccw=${ccw} shrank instead of growing`);
    }
});

test('offsets in metres, not degrees — x and y grow by the same distance', () => {
    // A degree of longitude is ~0.7 of a degree of latitude here, so an offset
    // applied in raw degrees would grow the two axes by different amounts.
    const before = extentMetres(square());
    const after = extentMetres(offsetRingOutward(square(), 0.25, LAT));
    const dw = after.w - before.w;
    const dh = after.h - before.h;
    assert.ok(Math.abs(dw - dh) < 0.01, `axes grew unevenly: ${dw.toFixed(3)} vs ${dh.toFixed(3)}`);
});

test('keeps the ring closed and the vertex count stable', () => {
    const out = offsetRingOutward(square(), 0.03, LAT);
    assert.equal(out.length, square().length);
    assert.deepEqual(out[0], out[out.length - 1]);
});

test('leaves degenerate input alone instead of throwing', () => {
    assert.deepEqual(offsetRingOutward([[16, LAT], [16, LAT]], 0.03, LAT), [[16, LAT], [16, LAT]]);
    assert.equal(offsetRingOutward(null, 0.03, LAT), null);
    const ring = square();
    assert.equal(offsetRingOutward(ring, 0, LAT), ring);
});

test('offsets a Polygon outer ring but leaves its holes untouched', () => {
    const hole = [[16.0002, LAT + 0.0002], [16.0004, LAT + 0.0002], [16.0004, LAT + 0.0004], [16.0002, LAT + 0.0004], [16.0002, LAT + 0.0002]];
    const poly = { type: 'Polygon', coordinates: [square(), hole] };
    const out = offsetPolygonOutward(poly, 0.03, LAT);
    assert.deepEqual(out.coordinates[1], hole);
    assert.notDeepEqual(out.coordinates[0], square());
    assert.ok(Math.abs(ringSignedArea(out.coordinates[0])) > Math.abs(ringSignedArea(square())));
});
