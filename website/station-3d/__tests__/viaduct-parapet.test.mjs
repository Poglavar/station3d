// The viaduct cross-section: walkways widen the deck past the trackbed, and
// the 1.6 m parapet layout follows the run — picket marching, rail-height
// interpolation on a graded span, and the slab ribbon the rails are built as.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VIADUCT_PARAPET_HEIGHT_M,
    VIADUCT_PARAPET_PICKET_SPACING_M,
    VIADUCT_WALKWAY_WIDTH_M,
    viaductDeckHalfWidthM,
    viaductParapetOffsetM,
    viaductParapetPickets,
    viaductSlabMesh,
} from '../core/viaduct-parapet.js';

// The bay-bridge case: a straight graded span heading +x, railY climbing.
const SPAN = [
    { x: 0, z: 0, railY: 21.7 },
    { x: 100, z: 0, railY: 25.0 },
    { x: 200, z: 0, railY: 28.3 },
];

test('the deck is wider than its trackbed by one walkway per side', () => {
    // Double-track g1435 trackbed half width ≈ 2.97 m; the deck must clear it.
    assert.equal(viaductDeckHalfWidthM(2.9675, 0.35), 2.9675 + VIADUCT_WALKWAY_WIDTH_M + 0.35);
    assert.ok(viaductParapetOffsetM(2.9675, 0.35) < viaductDeckHalfWidthM(2.9675, 0.35));
    assert.ok(viaductParapetOffsetM(2.9675, 0.35) > 2.9675,
        'the fence must stand outside the trackbed, on the walkway');
});

test('pickets march at fixed spacing across segment boundaries', () => {
    const pickets = viaductParapetPickets(SPAN, { offsetM: 4, spacingM: 35 });
    // 200 m at 35 m spacing starting at 0: 0,35,…,175 — six per 100 m segment
    // minus the shared boundary handled once.
    assert.equal(pickets.length, 6);
    assert.equal(pickets[0].x, 0);
    assert.ok(Math.abs(pickets[3].x - 105) < 1e-9,
        'the march must carry its remainder across the vertex, not restart');
    // Straight +x run: the left normal is (0, -1), so offset +4 lands at z −4.
    assert.ok(pickets.every(picket => Math.abs(picket.z + 4) < 1e-9));
});

test('picket height follows the graded rail, plus the walkway base', () => {
    const pickets = viaductParapetPickets(SPAN, { offsetM: -4, spacingM: 50, baseOffsetM: 0.2 });
    assert.ok(Math.abs(pickets[0].y - 21.9) < 1e-9);
    assert.ok(Math.abs(pickets[1].y - (21.7 + 3.3 * 0.5 + 0.2)) < 1e-9);
    // And the parapet is the asked-for 1.6 m.
    assert.equal(VIADUCT_PARAPET_HEIGHT_M, 1.6);
    assert.ok(VIADUCT_PARAPET_PICKET_SPACING_M <= 0.5, 'primarily vertical: dense pickets');
});

test('slab ribbon offsets to a deck edge and keeps the deck-quad layout', () => {
    const rail = viaductSlabMesh(SPAN, {
        centerOffsetM: 4,
        halfWidthM: 0.04,
        topOffsetM: 1.6,
        bottomOffsetM: 1.52,
    });
    assert.equal(rail.positions.length, SPAN.length * 4 * 3);
    // (segments × 24 side/top/bottom indices) + 12 for the two end caps.
    assert.equal(rail.indices.length, (SPAN.length - 1) * 24 + 12);
    // First cross-section, straight +x: z = -(4 ± 0.04), y = railY + offsets.
    const [lx, ly, lz, hx, hy, hz] = rail.positions.slice(0, 6);
    assert.equal(lx, 0);
    assert.equal(hx, 0);
    assert.ok(Math.abs(lz + 3.96) < 1e-9);
    assert.ok(Math.abs(hz + 4.04) < 1e-9);
    assert.ok(Math.abs(ly - 23.3) < 1e-9);
    assert.ok(Math.abs(hy - 23.3) < 1e-9);
    // A centred slab is symmetric — the deck itself is the offset-0 case.
    const deck = viaductSlabMesh(SPAN, { halfWidthM: 4.3, topOffsetM: 0, bottomOffsetM: -0.8 });
    assert.ok(Math.abs(deck.positions[2] + deck.positions[5]) < 1e-9);
});

test('degenerate input produces nothing rather than junk', () => {
    assert.equal(viaductSlabMesh([{ x: 0, z: 0, railY: 1 }], { halfWidthM: 1, bottomOffsetM: -1 }), null);
    assert.deepEqual(viaductParapetPickets([], { offsetM: 1 }), []);
    assert.deepEqual(viaductParapetPickets(SPAN, { offsetM: Number.NaN }), []);
});
