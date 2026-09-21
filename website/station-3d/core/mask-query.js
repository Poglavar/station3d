// "Is this point inside any of these polygons?" — the question curb suppression asks
// a few times for every piece of every ring it samples, which is the hottest loop in
// the curbs build.
//
// Extracted from world/curbs.js so it can be tested without THREE or a DOM. The
// answers are the whole correctness story of which curbs exist: a false positive
// deletes a real kerb, a false negative paints one across a car park entrance.
//
// A mask is `{ bounds: {minX,maxX,minZ,maxZ}, polygons: [{ outerRing, holeRings }] }`
// in local metres; rings are arrays of `{x, z}`.

import { createBoundsGrid } from './bounds-grid.js';

export function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.z > z) === (b.z > z)) continue;
        const xAtZ = ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
        if (x < xAtZ) inside = !inside;
    }
    return inside;
}

// Canvas fill/clip and terrain Boolean operations use nonzero winding.
// Keep this explicit: ordinary mask polygons above retain even-odd semantics.
export function pointInRingNonZero(x, z, ring) {
    let winding = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const side = (b.x-a.x)*(z-a.z)-(b.z-a.z)*(x-a.x);
        if (a.z <= z) { if (b.z > z && side > 0) winding++; }
        else if (b.z <= z && side < 0) winding--;
    }
    return winding !== 0;
}

export function pointInMask(x, z, mask) {
    const bounds = mask.bounds;
    if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) return false;
    for (const polygon of mask.polygons) {
        if (!pointInRing(x, z, polygon.outerRing)) continue;
        let inHole = false;
        for (const hole of polygon.holeRings) {
            if (pointInRing(x, z, hole)) { inHole = true; break; }
        }
        if (!inHole) return true;
    }
    return false;
}

// One grid per mask ARRAY, keyed by the array itself, so a tile's cached mask list is
// indexed once and then answers every query from every ring and every road feature in
// that tile.
//
// Keying on identity is the load-bearing part: pass a freshly built array — `a.concat(b)`,
// `list.filter(...)` — and you get a freshly built index, every call. That is exactly how
// the parking pass came to rebuild a hundred indexes over nearly the same hundred
// polygons. Query the stable arrays and exclude what you must (pointInAnyMaskExcept).
const maskGrids = new WeakMap();

export function maskGridFor(masks) {
    if (!Array.isArray(masks) || masks.length === 0) return null;
    let grid = maskGrids.get(masks);
    if (!grid) {
        grid = createBoundsGrid(masks);
        maskGrids.set(masks, grid);
    }
    return grid;
}

export function pointInAnyMask(x, z, masks) {
    const grid = maskGridFor(masks);
    if (!grid) return false;
    const candidates = grid.candidatesAt(x, z);
    for (let index = 0; index < candidates.length; index++) {
        if (pointInMask(x, z, candidates[index])) return true;
    }
    return false;
}

// Same query, minus one mask — for a parking lot asking "does this piece of MY ring
// face someone else's surface?".
//
// Excluding by identity rather than by index is exact for these arrays: each mask is a
// freshly constructed object, so no two entries are ever the same reference.
export function pointInAnyMaskExcept(x, z, masks, excluded) {
    const grid = maskGridFor(masks);
    if (!grid) return false;
    const candidates = grid.candidatesAt(x, z);
    for (let index = 0; index < candidates.length; index++) {
        const mask = candidates[index];
        if (mask === excluded) continue;
        if (pointInMask(x, z, mask)) return true;
    }
    return false;
}

export function pointTouchesAnyMask(x, z, nx, nz, masks, padding = 0.25) {
    return pointInAnyMask(x, z, masks)
        || pointInAnyMask(x - nx * padding, z - nz * padding, masks)
        || pointInAnyMask(x + nx * padding, z + nz * padding, masks);
}

// Bounds-only: does this edge's padded box overlap any mask's box? Deliberately not an
// exact test — it is the cheap gate that decides whether a segment is worth subdividing
// and testing piece by piece at all.
export function edgeNearAnyMask(a, b, masks, pad = 0) {
    const grid = maskGridFor(masks);
    if (!grid) return false;
    const minX = Math.min(a.x, b.x) - pad, maxX = Math.max(a.x, b.x) + pad;
    const minZ = Math.min(a.z, b.z) - pad, maxZ = Math.max(a.z, b.z) + pad;
    const candidates = grid.candidatesInBox(minX, minZ, maxX, maxZ);
    for (let index = 0; index < candidates.length; index++) {
        const mask = candidates[index];
        if (maxX >= mask.bounds.minX && minX <= mask.bounds.maxX
            && maxZ >= mask.bounds.minZ && minZ <= mask.bounds.maxZ) return true;
    }
    return false;
}
