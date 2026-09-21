// Bounds one curb terrain-drape visit without changing vertex order or output.
// The caller owns terrain/formation lookup and the mutable item cursor; keeping
// this pure makes the cooperative scheduling contract testable without THREE.

import { finiteOrNull } from './math.js';

// Check elapsed time after EVERY lookup: a dense-junction lookup costs more
// than a cached repeated vertex. Two vertices per visit made a real generation
// pay source validation and scheduler overhead 125,995 times. A small time
// budget keeps expensive lookups cooperative while amortizing cached ones.
// The vertex cap also bounds a visit when clock resolution is coarse.
export const CURB_TERRAIN_VERTICES_PER_STEP = 256;
export const CURB_TERRAIN_STEP_BUDGET_MS = 0.5;
const drapeNow = () => performance.now();

export const CURB_DRAPE_KIND = Object.freeze({
    OWNER: 'curb-owner',
    TERRAIN_SEAM: 'curb-terrain-seam',
});

// A curb vertex the height chain cannot support. Two different things wear
// this code, and only one of them is worth retrying:
//
//   not delivered yet — terrain for this tile is still streaming. Rejecting
//     the candidate is right; the next generation has the evidence.
//   cannot exist here — the point is inside the mapped sea. The DGU DTM stops
//     at the natural coastline, so a kerb on a harbour mole has no evidence
//     under it and never will, however many times it is retried.
//
// `permanent` on the error separates them, so the second case can settle its
// own tile instead of rejecting a candidate forever.
export const CURB_TERRAIN_EVIDENCE_GAP = 'curb-terrain-evidence-unavailable';

// A terrain-seam triangle contains two semantically different rows. Its curb
// edge must stay on the owning road profile, while its negative local-Y landing
// must meet the already-composed ground on the raised side. Treating both rows
// as road-owned lifts the landing back to carriageway grade and can leave the
// curb standing proud of the sidewalk on both faces.
export function curbDrapeHeightSource(drapeKind, localY) {
    const finiteLocalY = finiteOrNull(localY);
    return drapeKind === CURB_DRAPE_KIND.TERRAIN_SEAM
        && finiteLocalY !== null
        && finiteLocalY < 0
        ? 'raised-side'
        : 'curb-owner';
}

export function stepCurbTerrainDrape(
    item,
    resolveY,
    context = null,
    verticesPerStep = CURB_TERRAIN_VERTICES_PER_STEP,
    now = drapeNow,
    isPermanentGap = null,
) {
    if (item?.failure) throw item.failure;
    const positions = item?.positions;
    if (!positions || typeof resolveY !== 'function') return true;

    const startValue = typeof item.start === 'number' && Number.isFinite(item.start)
        ? item.start
        : 0;
    const endValue = typeof item.end === 'number' && Number.isFinite(item.end)
        ? item.end
        : positions.length;
    const cursorValue = typeof item.cursor === 'number' && Number.isFinite(item.cursor)
        ? item.cursor
        : startValue;
    const stepValue = typeof verticesPerStep === 'number' && Number.isFinite(verticesPerStep)
        ? verticesPerStep
        : CURB_TERRAIN_VERTICES_PER_STEP;
    const start = Math.max(0, Math.trunc(startValue));
    const end = Math.max(start, Math.min(
        positions.length,
        Math.trunc(endValue),
    ));
    const cursor = Math.max(start, Math.min(
        end,
        Math.trunc(cursorValue),
    ));
    const stepVertices = Math.max(
        1,
        Math.trunc(stepValue),
    );
    const stepEnd = Math.min(end, cursor + stepVertices * 3);
    const deadline = now() + CURB_TERRAIN_STEP_BUDGET_MS;

    let next = cursor;
    for (let index = cursor; index + 2 < stepEnd; index += 3) {
        const x = positions[index];
        const localY = positions[index + 1];
        const z = positions[index + 2];
        const y = resolveY(
            context,
            x,
            z,
            item.osmIds,
            item.verticalOsmIds,
            {
                drapeKind: item.drapeKind || CURB_DRAPE_KIND.OWNER,
                localY,
            },
        );
        if (!Number.isFinite(y)) {
            // These Y values are local profile offsets, not absolute support.
            // Keeping one unchanged would fabricate a curb at the scene datum.
            // Reject the private tile; a new input generation can retry it.
            item.failure = Object.assign(new Error(`Curb terrain support is unavailable at ${x},${z}`),
                { code: CURB_TERRAIN_EVIDENCE_GAP,
                    permanent: typeof isPermanentGap === 'function' && isPermanentGap(context, x, z) === true });
            throw item.failure;
        }
        positions[index + 1] += y;
        next = index + 3;
        if (now() >= deadline) break;
    }
    if (next + 2 >= stepEnd) next = stepEnd;
    item.cursor = next;
    return next >= end;
}

// The same visit, with an evidence gap reported instead of thrown, so one
// unsupported vertex settles its own tile rather than unwinding the caller.
// It used to throw all the way out of the shared ground generation, which
// discards every other layer in that candidate — and the coast collar is
// prepared last of all, so a single kerb over the harbour left Split with a
// raw sea plane against raw paving and no shore at all (2026-09-16).
// Any other failure is still a real fault and still propagates.
export function stepCurbTerrainDrapeSettled(item, resolveY, context = null, {
    verticesPerStep = CURB_TERRAIN_VERTICES_PER_STEP,
    now = drapeNow,
    isPermanentGap = null,
} = {}) {
    try {
        return {
            complete: stepCurbTerrainDrape(item, resolveY, context, verticesPerStep, now, isPermanentGap),
            evidenceGap: null,
        };
    } catch (error) {
        // Only a gap that cannot close settles. Terrain still on its way keeps
        // rejecting the candidate, which is what makes it arrive.
        if (error?.code !== CURB_TERRAIN_EVIDENCE_GAP || error.permanent !== true) throw error;
        return { complete: true, evidenceGap: error };
    }
}

// Geometry input for a tile whose omitted kerb runs must not be drawn. A run
// whose terrain gap is permanent (a pier the model cannot ground) marks its
// height range `omitted`; the retained lists and ranges stay intact so a later
// terrain revision can re-drape and restore it, and only the copy handed to the
// geometry builder loses the omitted slices (positions and, where a list has
// them, its uvs). Clearing the whole 400 m tile for one pier kerb cost every
// kerb in the tile (Split port, 2026-09-16).
const CURB_GEOMETRY_LISTS = ['curb', 'ramp', 'greenRamp', 'terrainSeam'];

function sliceLike(list, from, to) {
    return ArrayBuffer.isView(list) ? list.subarray(from, to) : list.slice(from, to);
}

function concatLike(sample, parts) {
    if (ArrayBuffer.isView(sample)) {
        const out = new sample.constructor(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) { out.set(part, at); at += part.length; }
        return out;
    }
    return [].concat(...parts);
}

export function withoutOmittedCurbRanges(state) {
    const omitted = (state?.heightRanges || []).filter(range => range?.omitted === true);
    if (!omitted.length) return state;
    const cutsByList = new Map();
    for (const range of omitted) {
        const cuts = cutsByList.get(range.positions) || [];
        cuts.push([range.start, range.end]);
        cutsByList.set(range.positions, cuts);
    }
    const compact = (values, cuts, perVertex) => {
        const parts = [];
        let at = 0;
        for (const [start, end] of cuts) {
            const from = start / 3 * perVertex, to = end / 3 * perVertex;
            if (from > at) parts.push(sliceLike(values, at, from));
            at = Math.max(at, to);
        }
        if (at < values.length) parts.push(sliceLike(values, at, values.length));
        return concatLike(values, parts);
    };
    const next = { ...state };
    for (const key of CURB_GEOMETRY_LISTS) {
        const list = state[key];
        const cuts = list?.positions ? cutsByList.get(list.positions) : null;
        if (!cuts) continue;
        cuts.sort((a, b) => a[0] - b[0]);
        next[key] = { ...list, positions: compact(list.positions, cuts, 3),
            ...(list.uvs ? { uvs: compact(list.uvs, cuts, 2) } : {}) };
    }
    return next;
}
