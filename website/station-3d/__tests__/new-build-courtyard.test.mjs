// Courtyard landscaping layout for new-build blocks: which holes qualify, that
// the paving really is a ring inside the court, and that nothing is planted in
// the walls or standing in the path.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COURTYARD_PATH_INSET_M,
    COURTYARD_PATH_WIDTH_M,
    newBuildCourtyardLayout,
    newBuildCourtyardLayouts,
    newBuildCourtyardLayoutsFromRings,
} from '../core/new-build-courtyard.js';
import { EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LAT = 43.75;
const ANCHOR_LON = 15.87;
const M_PER_DEG_LAT = EARTH_RADIUS_M * Math.PI / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(ANCHOR_LAT * Math.PI / 180);

// Closed lon/lat rectangle of w×d metres centred on the anchor.
function rectRing(w, d, reverse = false) {
    const toLonLat = (x, z) => [ANCHOR_LON + x / M_PER_DEG_LON, ANCHOR_LAT - z / M_PER_DEG_LAT];
    const ring = [
        toLonLat(-w / 2, -d / 2), toLonLat(w / 2, -d / 2),
        toLonLat(w / 2, d / 2), toLonLat(-w / 2, d / 2),
        toLonLat(-w / 2, -d / 2),
    ];
    return reverse ? ring.slice().reverse() : ring;
}

function bounds(w, d) {
    return { minX: -w / 2, maxX: w / 2, minZ: -d / 2, maxZ: d / 2 };
}

function items(layout) {
    return [...layout.bushes, ...layout.trees, ...layout.benches];
}

function edgeDistance(point, box) {
    return Math.min(
        point.x - box.minX, box.maxX - point.x,
        point.z - box.minZ, box.maxZ - point.z,
    );
}

test('a light well is too small to landscape, a real court is not', () => {
    assert.equal(newBuildCourtyardLayout(rectRing(5, 5), ANCHOR_LAT, ANCHOR_LON, 1), null);
    const court = newBuildCourtyardLayout(rectRing(24, 16), ANCHOR_LAT, ANCHOR_LON, 1);
    assert.ok(court);
    assert.ok(court.areaM2 > 380 && court.areaM2 < 390);
    assert.ok(court.lawn.length >= 5, 'the lawn is the courtyard ring itself');
});

test('degenerate rings are refused rather than thrown on', () => {
    assert.equal(newBuildCourtyardLayout(null, ANCHOR_LAT, ANCHOR_LON, 1), null);
    assert.equal(newBuildCourtyardLayout([[15.87, 43.75]], ANCHOR_LAT, ANCHOR_LON, 1), null);
    assert.equal(newBuildCourtyardLayout(
        [[15.87, 43.75], [Number.NaN, 43.75], [15.88, 43.76], [15.87, 43.75]],
        ANCHOR_LAT, ANCHOR_LON, 1,
    ), null);
});

test('the path is a closed ring set in from the walls, with a crossing leg', () => {
    const layout = newBuildCourtyardLayout(rectRing(30, 22), ANCHOR_LAT, ANCHOR_LON, 3);
    assert.ok(layout.path, 'a courtyard this size gets paving');
    const box = bounds(30, 22);
    assert.equal(layout.path.outer.length, layout.path.inner.length);
    for (let i = 0; i < layout.path.outer.length; i++) {
        const outerEdge = edgeDistance(layout.path.outer[i], box);
        const innerEdge = edgeDistance(layout.path.inner[i], box);
        // The paving sits INSIDE the court: its outer edge is inset from the
        // wall, and its inner edge is deeper still.
        assert.ok(Math.abs(outerEdge - COURTYARD_PATH_INSET_M) < 0.6,
            `path outer edge ${outerEdge.toFixed(2)} m from the wall`);
        assert.ok(innerEdge > outerEdge + COURTYARD_PATH_WIDTH_M * 0.5,
            'the band must not be inverted or collapsed');
    }
    assert.equal(layout.pathLegs.length, 1);
    const leg = layout.pathLegs[0];
    assert.ok(Math.hypot(leg.b.x - leg.a.x, leg.b.z - leg.a.z) > 5,
        'the crossing leg must actually cross the court');
});

// The hole ring of a polygon-with-holes is wound opposite its outer ring, and a
// naive inset would push the paving OUT through the walls on one of the two
// windings. Both must land in the same place.
test('paving lands inside the court whichever way the hole ring is wound', () => {
    const clockwise = newBuildCourtyardLayout(rectRing(30, 22), ANCHOR_LAT, ANCHOR_LON, 3);
    const counter = newBuildCourtyardLayout(rectRing(30, 22, true), ANCHOR_LAT, ANCHOR_LON, 3);
    assert.ok(clockwise.path && counter.path);
    const box = bounds(30, 22);
    for (const layout of [clockwise, counter]) {
        for (const point of layout.path.outer) {
            assert.ok(edgeDistance(point, box) > 0.5,
                'paving pushed outside the courtyard by the winding');
        }
    }
});

test('a small court is planted but left unpaved rather than filled with path', () => {
    const layout = newBuildCourtyardLayout(rectRing(10, 8), ANCHOR_LAT, ANCHOR_LON, 5);
    assert.ok(layout);
    assert.equal(layout.path, null);
    assert.equal(layout.pathLegs.length, 0);
    assert.ok(items(layout).length > 0, 'it should still be a garden');
});

test('planting and benches stay off the walls and out of the paving', () => {
    const layout = newBuildCourtyardLayout(rectRing(34, 26), ANCHOR_LAT, ANCHOR_LON, 7);
    const box = bounds(34, 26);
    assert.ok(layout.trees.length > 0 && layout.bushes.length > 0 && layout.benches.length > 0);
    for (const item of items(layout)) {
        assert.ok(edgeDistance(item, box) > 0.8,
            `item ${item.x.toFixed(1)},${item.z.toFixed(1)} is against a wall`);
    }
    // Nothing may sit on the paved ring: every item is clear of both its edges.
    for (const item of items(layout)) {
        for (const band of [layout.path.outer, layout.path.inner]) {
            let nearest = Infinity;
            for (let i = 0, n = band.length - 1; i < n; i++) {
                const a = band[i];
                const b = band[i + 1];
                const dx = b.x - a.x;
                const dz = b.z - a.z;
                const lenSq = dx * dx + dz * dz;
                const t = lenSq > 0
                    ? Math.max(0, Math.min(1, ((item.x - a.x) * dx + (item.z - a.z) * dz) / lenSq))
                    : 0;
                nearest = Math.min(nearest, Math.hypot(item.x - (a.x + dx * t), item.z - (a.z + dz * t)));
            }
            assert.ok(nearest >= 0.79, `item stands on the paving (${nearest.toFixed(2)} m)`);
        }
    }
});

test('benches face the middle of the courtyard', () => {
    const layout = newBuildCourtyardLayout(rectRing(34, 26), ANCHOR_LAT, ANCHOR_LON, 11);
    for (const seat of layout.benches) {
        // The seat's facing direction is its angle + 90°, by construction.
        const facing = { x: Math.cos(seat.angle - Math.PI / 2), z: Math.sin(seat.angle - Math.PI / 2) };
        const toCentre = { x: -seat.x, z: -seat.z };
        const length = Math.hypot(toCentre.x, toCentre.z) || 1;
        const dot = (facing.x * toCentre.x + facing.z * toCentre.z) / length;
        assert.ok(dot > 0.7, `bench faces away from the courtyard (dot ${dot.toFixed(2)})`);
    }
});

test('the same footprint always lays out identically, and every hole is used', () => {
    const outer = rectRing(60, 40);
    const holeA = rectRing(20, 14);
    const holeB = rectRing(16, 12);
    const twice = [0, 1].map(() => newBuildCourtyardLayouts(
        [outer, holeA, holeB], ANCHOR_LAT, ANCHOR_LON, 13,
    ));
    assert.equal(twice[0].length, 2, 'both courtyards are landscaped');
    assert.deepEqual(twice[0], twice[1]);
    // The outer ring is a building, never a garden.
    assert.equal(newBuildCourtyardLayouts([outer], ANCHOR_LAT, ANCHOR_LON, 13).length, 0);
    // Two holes of different size must not receive an identical layout.
    assert.notDeepEqual(twice[0][0], twice[0][1]);
});

test('an explicit block-wide courtyard is landscaped even when a parcel piece has no hole', () => {
    const courtyard = rectRing(24, 16);
    const layouts = newBuildCourtyardLayoutsFromRings(
        [courtyard], ANCHOR_LAT, ANCHOR_LON, 17,
    );

    assert.equal(layouts.length, 1);
    assert.ok(layouts[0].areaM2 > 380);
    assert.deepEqual(
        layouts,
        newBuildCourtyardLayouts([rectRing(50, 40), courtyard], ANCHOR_LAT, ANCHOR_LON, 17),
    );
});
