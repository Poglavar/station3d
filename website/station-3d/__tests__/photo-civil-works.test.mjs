// Verifies that Google terrain changes structure choice, never fixed track Y.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buryDsmSurfaceCrown,
    buryDsmSurfaceCrownFromSamples,
    classifyPhotoCivilWorks,
    photoRetainingWallTop,
    selectPhotoBareEarthHeight,
    slabSpanRiseM,
} from '../core/photo-civil-works.js';

function chunks(trackYs, grounds, spanLen = 12) {
    return trackYs.map((ty, index) => ({
        mx: index * spanLen,
        mz: 0,
        spanLen,
        ty,
        groundL: grounds[index],
        groundR: grounds[index],
        groundC: grounds[index],
    }));
}

test('design depth below DGU classifies cut-and-cover tunnel on flat Google ground', () => {
    // Flat city: Google surface at 0 offers no bore cover, but the DESIGN
    // runs 10 m under the DGU bare earth — cut-and-cover, one underground
    // type. 12 chunks × 12 m = 144 m, comfortably past the 40 m minimum run.
    const deep = chunks(new Array(12).fill(-10), new Array(12).fill(0))
        .map(chunk => ({ ...chunk, dguGroundY: 0 }));
    assert.deepEqual(classifyPhotoCivilWorks(deep), new Array(12).fill('tunnel'));

    // Revised 2026-07-23: ~6 m design cover cannot bury the 7.3 m tube roof —
    // there is NO covered-cut middle type, so it is an OPEN CUT in every
    // world, same as the model world classifies it.
    const shallowCover = chunks(new Array(12).fill(-6), new Array(12).fill(0))
        .map(chunk => ({ ...chunk, dguGroundY: 0 }));
    assert.deepEqual(classifyPhotoCivilWorks(shallowCover), new Array(12).fill('formation'));

    // A 4 m trench cannot plausibly host the running tube at all — it stays
    // an open cut (formation dressing), exactly as before.
    const shallow = chunks(new Array(12).fill(-4), new Array(12).fill(0))
        .map(chunk => ({ ...chunk, dguGroundY: 0 }));
    assert.deepEqual(classifyPhotoCivilWorks(shallow), new Array(12).fill('formation'));

    // The design prior is what bores THIS street: Google sees only 6 m of
    // cover here (below the 8 m rule → open cut), while the authored design
    // runs 10 m under DGU bare earth. With the prior it tunnels; strip the
    // prior and the same chunks stay open. (Revised 2026-07-24: the old
    // version of this check used 10 m of Google cover, which the 15 m model
    // threshold rejected — at the unified 8 m rule that is now a genuine
    // tunnel on Google evidence alone, so it no longer isolates the prior.)
    const priorOnly = chunks(new Array(12).fill(-10), new Array(12).fill(-4));
    assert.deepEqual(
        classifyPhotoCivilWorks(priorOnly.map(chunk => ({ ...chunk, dguGroundY: 0 }))),
        new Array(12).fill('tunnel'),
    );
    assert.deepEqual(classifyPhotoCivilWorks(priorOnly), new Array(12).fill('formation'));
});

test('terrain revisions alter civil works without bending the authored alignment', () => {
    const authoredTrackY = [0, 1, 2, 3, 4, 5];
    const lowTerrain = [-8, -7, -6, -5, -4, -3];
    const highTerrain = [20, 21, 22, 23, 24, 25];
    const lowChunks = chunks(authoredTrackY, lowTerrain);
    const highChunks = chunks(authoredTrackY, highTerrain);

    assert.deepEqual(classifyPhotoCivilWorks(lowChunks), new Array(6).fill('viaduct'));
    assert.deepEqual(classifyPhotoCivilWorks(highChunks), new Array(6).fill('tunnel'));
    assert.deepEqual(lowChunks.map(chunk => chunk.ty), authoredTrackY);
    assert.deepEqual(highChunks.map(chunk => chunk.ty), authoredTrackY);
});

test('short isolated fills remain formation under the shared model policy', () => {
    assert.deepEqual(
        classifyPhotoCivilWorks(chunks([0, 0], [-8, -8])),
        ['formation', 'formation'],
    );
    assert.deepEqual(
        classifyPhotoCivilWorks(chunks([0, 0, 0], [-8, -8, -8])),
        ['viaduct', 'viaduct', 'viaduct'],
    );
});

test('classification never bridges a spatial discontinuity between route legs', () => {
    const route = chunks([0, 0, 0, 0], [-8, -8, -8, -8]);
    route[2].mx = 500;
    route[3].mx = 512;
    assert.deepEqual(classifyPhotoCivilWorks(route), new Array(4).fill('formation'));
});

test('classification never bridges colocated but distinct source line runs', () => {
    const route = chunks([0, 0, 0, 0], [-8, -8, -8, -8]);
    route[0].routeRunId = 'a';
    route[1].routeRunId = 'a';
    route[2].routeRunId = 'b';
    route[3].routeRunId = 'b';
    assert.deepEqual(classifyPhotoCivilWorks(route), new Array(4).fill('formation'));
});

test('missing Google samples cannot fabricate a structure', () => {
    const incomplete = chunks([10, 10, 10], [0, 0, 0]);
    incomplete[0].groundL = null;
    incomplete[1].groundR = undefined;
    incomplete[2].groundC = Number.NaN;
    assert.deepEqual(classifyPhotoCivilWorks(incomplete), new Array(3).fill('formation'));

    const tunnelWithUnknownGap = chunks(
        new Array(9).fill(0),
        [20, 20, 20, 20, 20, 20, 20, 20, 20],
    );
    tunnelWithUnknownGap[4].groundC = null;
    assert.deepEqual(
        classifyPhotoCivilWorks(tunnelWithUnknownGap),
        ['tunnel', 'tunnel', 'tunnel', 'tunnel', 'formation', 'tunnel', 'tunnel', 'tunnel', 'tunnel'],
    );
});

test('bare-earth selector rejects an isolated roof or tree crown', () => {
    assert.equal(selectPhotoBareEarthHeight(
        [121, 100.4, 100.8, 101.1, 99.9],
        { expectedGroundY: 100 },
    ), 99.9);
});

test('sustained Google/DGU residual remains Google evidence', () => {
    assert.equal(selectPhotoBareEarthHeight(
        [118, 119, 120, 121, 122],
        { expectedGroundY: 100 },
    ), 119);
});

test('visible source spikes cannot inflate the bare-earth retaining wall', () => {
    const route = chunks(new Array(4).fill(10), new Array(4).fill(10));
    for (const chunk of route) {
        chunk.surfaceL = 40;
        chunk.surfaceR = 40;
        chunk.surfaceC = 40;
    }
    assert.deepEqual(classifyPhotoCivilWorks(route), new Array(4).fill('formation'));
    assert.equal(photoRetainingWallTop([10, 10.5, 80], {
        trackY: 10,
        parapetM: 1,
        maxHeightM: 60,
    }), 11.5, 'one coarse-mesh spike is rejected by the local median');
    assert.equal(photoRetainingWallTop([10, 80], {
        trackY: 10,
        parapetM: 1,
        maxHeightM: 60,
    }), 11, 'one route-end spike is rejected by the lower median');
    assert.equal(photoRetainingWallTop([80, 81, 82], {
        trackY: 10,
        parapetM: 1,
        maxHeightM: 60,
    }), 70, 'a sustained extreme is still bounded by the civil height cap');
});

// Bug 1: the ride/support dressing slabs must ramp with the grade instead of
// stepping. Each chunk's box tilts its along-track basis by slabSpanRiseM; the
// box top at the shared chunk boundary must equal the authored track height so
// adjacent chunks meet (a continuous incline, not a staircase of terraces).
const SPAN_LEN = 12;
const OVERLAP = 1.6;
// Reconstruct the top-face height at a chunk end (t=+0.5 → chunk boundary),
// mirroring photoreal.js: box centred at the chunk midpoint height, tilted by
// the overlap-extended rise; the boundary sits spanLen/(spanLen+overlap) of the
// way to the box end.
function slabTopAtChunkEnd(ty0, ty1, sign) {
    const midY = (ty0 + ty1) * 0.5;
    const boxRise = slabSpanRiseM(ty0, ty1, SPAN_LEN, SPAN_LEN + OVERLAP);
    const boundaryFrac = SPAN_LEN / (SPAN_LEN + OVERLAP);
    return midY + sign * 0.5 * boxRise * boundaryFrac;
}

test('grade dressing ramps continuously across chunks instead of stepping', () => {
    // Flat ground carries no tilt (stays axis-aligned → still a walk collider).
    assert.equal(slabSpanRiseM(5, 5, SPAN_LEN, SPAN_LEN + OVERLAP), 0);
    // Degenerate / non-finite chunks never fabricate a slope.
    assert.equal(slabSpanRiseM(0, 1, 0, 13.6), 0);
    assert.equal(slabSpanRiseM(0, Number.NaN, SPAN_LEN, 13.6), 0);
    // A ~8% grade tilts by rise/run scaled to the extended box span.
    assert.ok(Math.abs(slabSpanRiseM(0, 1, SPAN_LEN, SPAN_LEN + OVERLAP) - (SPAN_LEN + OVERLAP) / SPAN_LEN) < 1e-9);

    // Two adjacent chunks on a 0→1→2 ramp: chunk A ends and chunk B starts at
    // the same authored height (1), so their slab tops meet — no terrace.
    const aEnd = slabTopAtChunkEnd(0, 1, +1);
    const bStart = slabTopAtChunkEnd(1, 2, -1);
    assert.ok(Math.abs(aEnd - 1) < 1e-9, `chunk A slab top ends at the track height: ${aEnd}`);
    assert.ok(Math.abs(bStart - 1) < 1e-9, `chunk B slab top starts at the track height: ${bStart}`);
    assert.ok(Math.abs(aEnd - bStart) < 1e-9, 'adjacent slab tops are continuous (no step)');

    // Contrast: the OLD flat-box behaviour placed each chunk's top at its own
    // midpoint, so the boundary jumped by half a chunk's rise — a visible step.
    const oldAEnd = (0 + 1) * 0.5;   // 0.5
    const oldBStart = (1 + 2) * 0.5; // 1.5
    assert.ok(Math.abs(oldAEnd - oldBStart) > 0.5, 'the old flat boxes stepped at the boundary');
});

test('missing photogrammetry stays unknown instead of fabricating DGU terrain', () => {
    assert.equal(selectPhotoBareEarthHeight(
        [null, undefined, Number.NaN],
        { expectedGroundY: 100 },
    ), null);
});

test('plausible Google terrain residuals still adapt the civil works', () => {
    assert.equal(selectPhotoBareEarthHeight(
        [102.1, 102.4, 102.2, 102.5, 102.3],
        { expectedGroundY: 100 },
    ), 102.2);
    assert.equal(selectPhotoBareEarthHeight(
        [92.2, 92.5, 92.3, 92.4, 92.1],
        { expectedGroundY: 100 },
    ), 92.2);
});

test('crowns that must bury the DSM rise to the surface within a bounded allowance', () => {
    assert.equal(buryDsmSurfaceCrown(20, null), 20,
        'no surface evidence leaves the robust crown alone');
    assert.equal(buryDsmSurfaceCrown(20, 18, { hideM: 1, allowanceM: 8 }), 20,
        'a surface already below the crown changes nothing');
    assert.equal(buryDsmSurfaceCrown(20, 22.5, { hideM: 1, allowanceM: 8 }), 23.5,
        'a modest excess (hummock, brush) is buried with the hide margin');
    assert.equal(buryDsmSurfaceCrown(20, 45, { hideM: 1, allowanceM: 8 }), 28,
        'a tall spike (roof, LOD blob) saturates at the allowance — no towers');
    assert.equal(buryDsmSurfaceCrown(null, 30, { hideM: 1, allowanceM: 8 }), null,
        'surface evidence alone never builds masonry');
});

test('portal crowns bury the consensus surface with no allowance saturation', () => {
    // Steep real hillside: many samples agree high. A fixed allowance
    // saturated here and left the torn tongue one allowance above the crown;
    // consensus burial must reach the actual crust.
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [45, 44.5, 43, 40, 36, 30, 24],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 46.5, 'second-highest sample + hide margin, unbounded by any allowance');
    // Isolated spike: no second witness at that height — it cannot mint a tower.
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [80, 22, 21.5, 21],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 24, 'a lone roof/LOD blob is outvoted by the consensus');
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [50],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 20, 'a single sample is a potential spike, not a consensus');
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [null, undefined, Number.NaN],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 20, 'no finite evidence leaves the robust crown alone');
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [200, 199, 198],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 60, 'the shared rail-relative civil clamp still bounds the masonry');
    assert.equal(buryDsmSurfaceCrownFromSamples(
        null,
        [30, 29],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), null, 'surface consensus alone never builds masonry');
    assert.equal(buryDsmSurfaceCrownFromSamples(
        20,
        [12, 11, 10],
        { hideM: 2, trackY: 0, maxHeightM: 60 },
    ), 20, 'a surface below the robust crown never lowers it');
});
