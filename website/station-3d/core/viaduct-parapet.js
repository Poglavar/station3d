// Cross-section maths for rail viaduct decks: the evacuation walkways that
// widen the deck past the trackbed, and the parapet fence that edges it —
// pure sample-in, arrays-out, so the layout is testable without THREE.
//
// A deck exactly as wide as its trackbed has nowhere to stand when a train
// fails mid-span. The deck therefore carries a walkway on EACH side, closed
// off by a 1.6 m white parapet: dense vertical pickets under a top rail and
// a mid rail, inset just inside the deck edge.

// One walkway per side, added to the trackbed half width.
export const VIADUCT_WALKWAY_WIDTH_M = 1.0;
// The visible slab extends a little beyond the evacuation walkway. Keep this
// beside the shared cross-section maths: terrain ownership, deck geometry and
// parapets must all terminate on the same physical edge.
export const VIADUCT_DECK_EDGE_MARGIN_M = 0.35;
// The slab top is tucked just below the rendered trackbed surface. This is a
// real cross-section dimension, not a polygon-offset/render-order adjustment.
export const VIADUCT_DECK_TOP_BELOW_TRACKBED_M = 0.015;
export const VIADUCT_PARAPET_HEIGHT_M = 1.6;
// Dense enough that the fence reads as vertical bars from the deck; every
// picket is one instance of a shared box, so spacing costs matrices, not
// draw calls.
export const VIADUCT_PARAPET_PICKET_SPACING_M = 0.35;
export const VIADUCT_PARAPET_PICKET_SIZE_M = 0.06;
// The pickets stand just inside the deck edge.
export const VIADUCT_PARAPET_EDGE_INSET_M = 0.10;
// Horizontal members, as {bottom, top} above the walkway surface: the top
// rail caps the pickets at parapet height, the mid rail ties them together.
export const VIADUCT_PARAPET_RAIL_BANDS_M = Object.freeze([
    Object.freeze({ bottom: VIADUCT_PARAPET_HEIGHT_M - 0.08, top: VIADUCT_PARAPET_HEIGHT_M }),
    Object.freeze({ bottom: 0.76, top: 0.84 }),
]);
export const VIADUCT_PARAPET_RAIL_HALF_WIDTH_M = 0.04;

export function viaductDeckHalfWidthM(trackbedHalfWidthM, edgeMarginM = 0) {
    return trackbedHalfWidthM + VIADUCT_WALKWAY_WIDTH_M + edgeMarginM;
}

export function viaductParapetOffsetM(trackbedHalfWidthM, edgeMarginM = 0) {
    return viaductDeckHalfWidthM(trackbedHalfWidthM, edgeMarginM)
        - VIADUCT_PARAPET_EDGE_INSET_M;
}

// Per-segment unit normals and mitred per-vertex join vectors — the same
// construction the trackbed and deck use, so every ribbon on the deck bends
// identically at a kink.
const MITER_LIMIT = 3;

function segmentFrames(samples) {
    const steps = segmentFramesSteps(samples);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

function* segmentFramesSteps(samples, { now = () => performance.now(), isCurrent = () => true } = {}) {
    const frames = [];
    let started = now();
    if (!isCurrent()) return null;
    for (let index = 0; index < samples.length - 1; index++) {
        if (now() - started >= .5) {
            yield { phase: 'viaduct-frames' }; started = now();
            if (!isCurrent()) return null;
        }
        const dx = samples[index + 1].x - samples[index].x;
        const dz = samples[index + 1].z - samples[index].z;
        const length = Math.hypot(dx, dz);
        frames.push(length > 1e-6 ? { x: dz / length, z: -dx / length } : null);
    }
    return isCurrent() ? frames : null;
}

function joinVector(a, b) {
    if (!a) return b || { x: 1, z: 0 };
    if (!b) return a;
    let bx = b.x, bz = b.z;
    if (a.x * bx + a.z * bz < 0) { bx = -bx; bz = -bz; }
    let mx = a.x + bx, mz = a.z + bz;
    const length = Math.hypot(mx, mz);
    if (length < 1e-5) return a;
    mx /= length;
    mz /= length;
    const denom = Math.max(1 / MITER_LIMIT, Math.abs(mx * bx + mz * bz));
    const scale = Math.min(MITER_LIMIT, 1 / denom);
    return { x: mx * scale, z: mz * scale };
}

export function viaductSampleJoins(samples) {
    const steps = viaductSampleJoinsSteps(samples);
    let next; do { next = steps.next(); } while (!next.done);
    return next.value;
}

export function* viaductSampleJoinsSteps(samples, {
    now = () => performance.now(), isCurrent = () => true,
} = {}) {
    const frames = yield* segmentFramesSteps(samples, { now, isCurrent });
    if (!frames) return null;
    const joins = [];
    let started = now();
    for (let index = 0; index < samples.length; index++) {
        if (now() - started >= .5) {
            yield { phase: 'viaduct-joins' }; started = now();
            if (!isCurrent()) return null;
        }
        joins.push(joinVector(frames[index - 1], frames[index]));
    }
    return isCurrent() ? joins : null;
}

// A rectangular slab ribbon following the samples: the deck itself
// (centerOffsetM 0, the full half width) and each parapet rail (offset to a
// deck edge, a few centimetres wide). Returns plain position/index arrays;
// the caller wraps them in a BufferGeometry. Ends are capped.
export function viaductSlabMesh(samples, {
    centerOffsetM = 0,
    halfWidthM,
    topOffsetM = 0,
    bottomOffsetM,
} = {}) {
    if (!samples || samples.length < 2 || !Number.isFinite(halfWidthM)) return null;
    const joins = viaductSampleJoins(samples);
    const positions = [];
    const indices = [];
    for (let index = 0; index < samples.length; index++) {
        const sample = samples[index];
        const join = joins[index];
        const topY = sample.railY + topOffsetM;
        const bottomY = sample.railY + bottomOffsetM;
        const lowOffset = centerOffsetM - halfWidthM;
        const highOffset = centerOffsetM + halfWidthM;
        positions.push(
            sample.x + join.x * lowOffset, topY, sample.z + join.z * lowOffset,
            sample.x + join.x * highOffset, topY, sample.z + join.z * highOffset,
            sample.x + join.x * lowOffset, bottomY, sample.z + join.z * lowOffset,
            sample.x + join.x * highOffset, bottomY, sample.z + join.z * highOffset,
        );
    }
    for (let index = 0; index < samples.length - 1; index++) {
        const a = index * 4;
        const b = (index + 1) * 4;
        indices.push(
            // top, bottom, left fascia, right fascia
            a, b, a + 1, a + 1, b, b + 1,
            a + 2, a + 3, b + 2, a + 3, b + 3, b + 2,
            a, a + 2, b, a + 2, b + 2, b,
            a + 1, b + 1, a + 3, a + 3, b + 1, b + 3,
        );
    }
    const last = (samples.length - 1) * 4;
    indices.push(
        0, 1, 2, 1, 3, 2,
        last, last + 2, last + 1, last + 1, last + 2, last + 3,
    );
    return { positions, indices };
}

// Picket centres along one side of the run: marching a fixed spacing over the
// cumulative station, interpolating position and rail height inside each
// segment and offsetting along the segment's own normal. `baseOffsetM` lifts
// the returned y to the walkway surface; the picket's own height is the
// caller's to apply.
export function viaductParapetPickets(samples, {
    offsetM,
    spacingM = VIADUCT_PARAPET_PICKET_SPACING_M,
    baseOffsetM = 0,
} = {}) {
    if (!samples || samples.length < 2 || !Number.isFinite(offsetM)) return [];
    const frames = segmentFrames(samples);
    const pickets = [];
    let carryM = 0;
    for (let index = 0; index < samples.length - 1; index++) {
        const a = samples[index];
        const b = samples[index + 1];
        const frame = frames[index];
        if (!frame) continue;
        const lengthM = Math.hypot(b.x - a.x, b.z - a.z);
        const angle = Math.atan2(b.x - a.x, b.z - a.z);
        for (let s = carryM; s < lengthM; s += spacingM) {
            const t = s / lengthM;
            pickets.push({
                x: a.x + (b.x - a.x) * t + frame.x * offsetM,
                z: a.z + (b.z - a.z) * t + frame.z * offsetM,
                y: a.railY + (b.railY - a.railY) * t + baseOffsetM,
                angle,
            });
        }
        carryM = (carryM - lengthM) % spacingM;
        while (carryM < 0) carryM += spacingM;
    }
    return pickets;
}
