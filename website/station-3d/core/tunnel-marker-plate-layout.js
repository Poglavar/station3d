// Where the arrow and the digits sit inside one tunnel-marker atlas cell, as
// pure numbers. Separated from the canvas painting so the one invariant that
// matters — no paint outside the cell — can be checked headlessly.
//
// It matters because the atlas UVs inset a few pixels on every side to stop
// neighbouring cells bleeding in under filtering. Anything drawn out at the
// cell edge is therefore not just tight, it is CROPPED: the first version laid
// out 246 px of content in a 256 px cell and shipped plates whose arrowhead and
// trailing digit were sliced off mid-stroke.

export const PLATE_CELL = {
    widthPx: 512,
    heightPx: 320,
    // UV inset per side. Paint reaching into this band gets cropped on the wall.
    insetPx: 8,
    // Content is laid out to fit inside this margin, which is what buys the
    // inset its safety.
    marginPx: 28,
    fontPx: 208,
};

// Bold sans digits are close enough to this fraction of the font size each; the
// layout only needs a width to centre and scale by, and the canvas measures the
// real thing at paint time.
export const APPROX_DIGIT_WIDTH_EM = 0.56;

// Cap height of a digit as a fraction of font size — how tall the painted
// number actually is, which is not the font's em box.
const DIGIT_CAP_EM = 0.72;

// text: the chainage string. measureDigitsPx: (text, fontPx) => width in pixels,
// so the caller can pass the canvas's own measurement and the test a model of it.
// Returns cell-space geometry: the arrow silhouette runs from x=0, the digits
// are centred on textX, and everything is drawn under `scale` about the cell
// centre after shifting left by total/2.
export function plateContentLayout(text, measureDigitsPx, strokePx = 10) {
    const digits = String(text);
    const font = PLATE_CELL.fontPx;
    const arrow = {
        headW: font * 0.38,
        headH: font * 0.72,
        shaftH: font * 0.26,
        totalW: font * 0.62,
    };
    const gap = font * 0.20;
    const digitsWidth = measureDigitsPx(digits, font);
    const total = arrow.totalW + gap + digitsWidth;
    // Fit, never overflow: a five-digit chainage shrinks rather than run under
    // the cell edge.
    const scale = Math.min(1, (PLATE_CELL.widthPx - PLATE_CELL.marginPx * 2) / total);
    const textX = arrow.totalW + gap + digitsWidth / 2;
    const halfContentH = Math.max(arrow.headH, font * DIGIT_CAP_EM) / 2;
    const centreX = PLATE_CELL.widthPx / 2;
    const centreY = PLATE_CELL.heightPx / 2;
    // The outline is stroked around the silhouette, so it reaches half a line
    // width further out than the shapes themselves.
    const reachX = (total / 2 + strokePx / 2) * scale;
    const reachY = (halfContentH + strokePx / 2) * scale;
    return {
        digits,
        scale,
        arrow,
        gap,
        digitsWidth,
        total,
        textX,
        bounds: {
            minX: centreX - reachX,
            maxX: centreX + reachX,
            minY: centreY - reachY,
            maxY: centreY + reachY,
        },
    };
}
