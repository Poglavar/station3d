// Curb suppression is decided entirely by these queries: a false positive deletes a
// real kerb, a false negative paints one across a car-park entrance. They were inside
// world/curbs.js (THREE + DOM) and so had no coverage at all.
//
// The parking pass used to ask "is this piece facing a roadbed or another lot?" by
// MATERIALISING `roadbed.concat(parking.filter(j !== pi))` for every ring — two
// allocations per ring, and once the queries became grid-indexed, a whole spatial index
// rebuilt per ring, because the grid is memoised on array identity. The replacement
// queries the tile's own stable arrays and excludes self. These pin that the answer did
// not change, which is the only thing that makes the speedup legitimate.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    edgeNearAnyMask,
    pointInAnyMask,
    pointInAnyMaskExcept,
    pointInMask,
    pointInRing,
    pointTouchesAnyMask,
} from '../core/mask-query.js';

const ring = (...pts) => pts.map(([x, z]) => ({ x, z }));

function mask(minX, minZ, maxX, maxZ, holeRings = []) {
    return {
        bounds: { minX, minZ, maxX, maxZ },
        polygons: [{
            outerRing: ring([minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]),
            holeRings,
        }],
    };
}

test('a point inside a square is inside, outside is outside', () => {
    const m = mask(0, 0, 10, 10);
    assert.equal(pointInMask(5, 5, m), true);
    assert.equal(pointInMask(-1, 5, m), false);
    assert.equal(pointInMask(11, 5, m), false);
    assert.equal(pointInRing(5, 5, m.polygons[0].outerRing), true);
});

test('a hole is not inside', () => {
    // A courtyard in the middle of a no-curb surface is not part of it.
    const m = mask(0, 0, 10, 10, [ring([3, 3], [7, 3], [7, 7], [3, 7])]);
    assert.equal(pointInMask(5, 5, m), false, 'the hole');
    assert.equal(pointInMask(1, 1, m), true, 'the ring around it');
});

test('excluding self is exactly the old concat/filter answer', () => {
    // The property the parking rewrite depends on, checked against the construction it
    // replaced, over a spread dense enough for lots to overlap each other.
    const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(3);
    const roadbed = [];
    for (let i = 0; i < 25; i++) {
        const x = rnd() * 120, z = rnd() * 120;
        roadbed.push(mask(x, z, x + 8 + rnd() * 14, z + 8 + rnd() * 14));
    }
    const parking = [];
    for (let i = 0; i < 60; i++) {
        const x = rnd() * 120, z = rnd() * 120;
        parking.push(mask(x, z, x + 5 + rnd() * 12, z + 5 + rnd() * 12));
    }

    let compared = 0;
    let trueCount = 0;
    for (let pi = 0; pi < parking.length; pi += 7) {
        // Exactly what appendParkingRingGeometry used to build, per ring.
        const openSurfaces = roadbed.concat(parking.filter((_, j) => j !== pi));
        for (let i = 0; i < 400; i++) {
            const x = rnd() * 140 - 10;
            const z = rnd() * 140 - 10;
            const before = pointInAnyMask(x, z, openSurfaces);
            const after = pointInAnyMask(x, z, roadbed)
                || pointInAnyMaskExcept(x, z, parking, parking[pi]);
            assert.equal(after, before, `differs at ${x},${z} for lot ${pi}`);
            compared += 1;
            if (before) trueCount += 1;
        }
    }
    assert.ok(compared > 3000, `expected a broad sweep, compared ${compared}`);
    // A sweep that never fires either way would pass while proving nothing.
    assert.ok(trueCount > 100 && trueCount < compared - 100,
        `expected a mix of hits and misses, got ${trueCount}/${compared}`);
});

test('the excluded mask really is excluded, and only it', () => {
    const a = mask(0, 0, 10, 10);
    const b = mask(5, 5, 15, 15);          // overlaps a
    const masks = [a, b];
    // A point inside `a` only.
    assert.equal(pointInAnyMask(2, 2, masks), true);
    assert.equal(pointInAnyMaskExcept(2, 2, masks, a), false, 'a was the only cover');
    assert.equal(pointInAnyMaskExcept(2, 2, masks, b), true, 'a still covers it');
    // A point in the overlap is covered whichever single mask is excluded.
    assert.equal(pointInAnyMaskExcept(7, 7, masks, a), true);
    assert.equal(pointInAnyMaskExcept(7, 7, masks, b), true);
});

test('empty and absent mask lists answer false rather than throwing', () => {
    for (const empty of [[], null, undefined]) {
        assert.equal(pointInAnyMask(1, 1, empty), false);
        assert.equal(pointInAnyMaskExcept(1, 1, empty, null), false);
        assert.equal(edgeNearAnyMask({ x: 0, z: 0 }, { x: 1, z: 1 }, empty), false);
    }
});

test('pointTouchesAnyMask probes both sides of the piece', () => {
    // The raised side of a curb matters: a piece whose CENTRE is clear but whose
    // offset sample lands in a tram bed must still be suppressed.
    const masks = [mask(10, 0, 20, 10)];
    assert.equal(pointInAnyMask(9.5, 5, masks), false, 'centre is clear');
    assert.equal(pointTouchesAnyMask(9.5, 5, -1, 0, masks, 1.0), true, 'offset lands inside');
    assert.equal(pointTouchesAnyMask(5, 5, -1, 0, masks, 1.0), false, 'far enough away');
});

test('edgeNearAnyMask is a bounds gate, not an exact test', () => {
    const masks = [mask(10, 10, 20, 20)];
    // Diagonal edge passing near the box but not through it: the gate says "worth
    // subdividing", which is its job — being conservative here only costs time.
    assert.equal(edgeNearAnyMask({ x: 0, z: 0 }, { x: 12, z: 12 }, masks), true);
    assert.equal(edgeNearAnyMask({ x: 0, z: 0 }, { x: 5, z: 5 }, masks), false);
    assert.equal(edgeNearAnyMask({ x: 0, z: 0 }, { x: 9, z: 9 }, masks, 2), true, 'pad widens it');
});
