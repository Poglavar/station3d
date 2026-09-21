// Narrows "which planner track corridor volumes are near this point/edge?" from
// a scan of the whole project to the handful actually nearby.
//
// A corridor volume is one per track segment, so a 52 km alignment is thousands
// of them. Curb suppression asks this question once per sampled piece — and five
// times over, for the raised cross-section offsets — while a ring is sampled
// every 2 m. That made the cost of curbs scale with the LENGTH OF THE PROJECT
// rather than with anything on screen: a single parking lot reached 140 ms.
//
// The index only narrows. Every caller still runs its own exact oriented-box
// test on the candidates, so this can be too generous but never too strict —
// which is the property the tests pin, because a miss here silently paints a
// curb straight through a trackbed.
//
// Pure: no THREE, no DOM. A volume is
// `{ centerX, centerZ, rightX, rightZ, alongX, alongZ, halfWidth, halfDepth }`.

import { createBoundsGrid } from './bounds-grid.js';

// Axis-aligned bounds of an oriented box grown by `pad` on both local axes.
export function plannerTrackAabb(volume, pad = 0) {
    const extentX = Math.abs(volume.rightX) * (volume.halfWidth + pad)
        + Math.abs(volume.alongX) * (volume.halfDepth + pad);
    const extentZ = Math.abs(volume.rightZ) * (volume.halfWidth + pad)
        + Math.abs(volume.alongZ) * (volume.halfDepth + pad);
    return {
        minX: volume.centerX - extentX, maxX: volume.centerX + extentX,
        minZ: volume.centerZ - extentZ, maxZ: volume.centerZ + extentZ,
    };
}

export function createPlannerTrackIndex(volumes, { padM = 0 } = {}) {
    const list = Array.isArray(volumes) ? volumes : [];
    if (list.length === 0) return null;
    // Built once with the LARGEST pad any caller uses, so one index serves both
    // the point query (pad 0) and the edge query (a curb's full cross-section).
    const grid = createBoundsGrid(list.map(volume => ({
        volume,
        bounds: plannerTrackAabb(volume, padM),
    })));

    // Reuses the grid's scratch array contract: the returned array is valid only
    // until the next query on this index. Callers iterate immediately.
    const unwrapped = [];
    const unwrap = (entries) => {
        unwrapped.length = 0;
        for (let index = 0; index < entries.length; index++) unwrapped.push(entries[index].volume);
        return unwrapped;
    };

    return {
        padM,
        candidatesAt(x, z) {
            return unwrap(grid.candidatesAt(x, z));
        },
        candidatesInBox(minX, minZ, maxX, maxZ) {
            return unwrap(grid.candidatesInBox(minX, minZ, maxX, maxZ));
        },
        stats: () => grid.stats(),
    };
}
