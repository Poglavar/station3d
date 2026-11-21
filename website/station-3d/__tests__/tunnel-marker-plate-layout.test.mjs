// The tunnel-marker plate must never paint outside its atlas cell: the atlas
// UVs inset a few pixels per side, so anything at the edge is cropped on the
// wall — which is how a shipped plate ended up with a sliced arrowhead and a
// half-eaten trailing zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    APPROX_DIGIT_WIDTH_EM,
    PLATE_CELL,
    plateContentLayout,
} from '../core/tunnel-marker-plate-layout.js';

// Stands in for ctx.measureText. Deliberately a touch WIDER than real bold
// digits, so the test errs toward catching an overflow rather than missing one.
const measure = (digits, fontPx) => digits.length * fontPx * (APPROX_DIGIT_WIDTH_EM + 0.02);

// Every chainage a marker can carry: 50 m steps up to a 30 km bore, which is
// well past the longest tunnel on the network.
const CHAINAGES = Array.from({ length: 600 }, (_unused, index) => String((index + 1) * 50));

test('keeps every plate inside the cropped area of its atlas cell', () => {
    const inset = PLATE_CELL.insetPx;
    for (const text of CHAINAGES) {
        const { bounds } = plateContentLayout(text, measure);
        assert.ok(bounds.minX >= inset, `"${text}" reaches left to ${bounds.minX.toFixed(1)} px`);
        assert.ok(bounds.maxX <= PLATE_CELL.widthPx - inset,
            `"${text}" reaches right to ${bounds.maxX.toFixed(1)} px`);
        assert.ok(bounds.minY >= inset, `"${text}" reaches up to ${bounds.minY.toFixed(1)} px`);
        assert.ok(bounds.maxY <= PLATE_CELL.heightPx - inset,
            `"${text}" reaches down to ${bounds.maxY.toFixed(1)} px`);
    }
});

test('shrinks only when the content would not otherwise fit', () => {
    const short = plateContentLayout('50', measure);
    const long = plateContentLayout('29950', measure);
    assert.ok(long.scale < short.scale, 'a five-digit chainage must shrink further than a two-digit one');
    assert.ok(long.scale > 0.5, 'shrinking past half would make the longest chainage unreadable');
    // Whatever the scale, the digits still sit clear of the arrow.
    for (const layout of [short, long]) {
        assert.ok(layout.textX - layout.digitsWidth / 2 > layout.arrow.totalW);
    }
});

test('the plate is drawn at the size the wall quad expects', () => {
    // The quad is 4.8 × 3.0 m and maps one whole cell, so a cell aspect that
    // drifts from 1.6 would stretch the paint on the wall.
    assert.ok(Math.abs(PLATE_CELL.widthPx / PLATE_CELL.heightPx - 4.8 / 3.0) < 1e-9);
    assert.ok(PLATE_CELL.marginPx > PLATE_CELL.insetPx,
        'the layout margin has to be wider than the UV crop or the crop bites into paint');
});
