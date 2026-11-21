// The view corridors have to out-reach the fog, or a layer streams itself into
// existence inside your field of view.
//
// This exists because CURB_AHEAD.distanceM was silently cut from 1400 m to
// 600 m while the constant was moved from world/curbs.js into core/tile-stream.js.
// Nothing failed except one slow browser spec, which then sat red on main. A
// headless assertion on the constants catches the same regression in
// milliseconds and cannot be blamed on a flaky WebGL boot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CURB_AHEAD,
    DETAILED_BUILDING_AHEAD,
    FOG_OPAQUE_M,
} from '../core/tile-stream.js';

// world/roads.js imports three.js, which a headless unit test has no business
// loading, so its constant is read out of the source text instead.
function roadAheadPrefetchM() {
    const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    const match = /^const ROAD_AHEAD_PREFETCH_M = (\d+);$/m.exec(source);
    assert.ok(match, 'ROAD_AHEAD_PREFETCH_M not found in world/roads.js');
    return Number(match[1]);
}

test('curbs stream at least as far as the fog is transparent', () => {
    assert.ok(
        CURB_AHEAD.distanceM >= FOG_OPAQUE_M,
        `curb corridor ${CURB_AHEAD.distanceM} m is inside the ${FOG_OPAQUE_M} m fog cutoff`,
    );
});

test('curbs reach as far as the roads they edge', () => {
    assert.equal(
        CURB_AHEAD.distanceM, roadAheadPrefetchM(),
        'a curb is a ribbon along a road — a shorter corridor ends kerbs in mid-street',
    );
});

test('detailed buildings deliberately stop short of the fog', () => {
    // The one corridor that SHOULD be shorter: detailed buildings are the
    // heaviest streamed payload, so they trade a little pop-in for weight. If
    // this ever equals the fog distance, someone has copied the curb rule onto
    // a layer that cannot afford it.
    assert.ok(DETAILED_BUILDING_AHEAD.distanceM < FOG_OPAQUE_M);
    assert.ok(DETAILED_BUILDING_AHEAD.distanceM >= 600);
});
