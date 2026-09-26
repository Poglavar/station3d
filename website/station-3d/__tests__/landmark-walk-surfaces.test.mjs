// A walker in a modelled landmark meets its real faces: walls where they cross
// the body, floors within a step of the feet — never a material part's plan
// hull, and never a roof far overhead (Maksimir stadium, 2026-09-26).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildLandmarkWalkIndex,
    farOutlineIsWalkerWall,
    landmarkSupportY,
    landmarkWallFootprint,
    landmarkWallSegments,
} from '../core/landmark-walk-surfaces.js';
import { resolveWalkAgainstBuildingWalls } from '../core/walk-building-collision.js';
import { pointInBuildingFootprint, routeCrossesBuildingFootprints } from '../core/pedestrian-routing.js';

// Two triangles of an upright rectangle from (x0, z0) to (x1, z1), y0..y1.
function wall(x0, z0, x1, z1, y0, y1) {
    return [
        x0, y0, z0, x1, y0, z1, x1, y1, z1,
        x0, y0, z0, x1, y1, z1, x0, y1, z0,
    ];
}

// A quad over x0..x1 whose height runs linearly from y0 at z0 to y1 at z1,
// facing up (as a floor or tier plate) or down (as a soffit).
function slope(x0, x1, z0, y0, z1, y1, facing = 'up') {
    const a = [x0, y0, z0], b = [x1, y0, z0], c = [x1, y1, z1], d = [x0, y1, z1];
    // Scene Y is up and +z runs towards the viewer: (a, d, c) winds upward.
    const up = [...a, ...d, ...c, ...a, ...c, ...b];
    const down = [...a, ...b, ...c, ...a, ...c, ...d];
    return facing === 'up' ? up : down;
}

function plate(x0, x1, z0, z1, y, facing = 'up') {
    return slope(x0, x1, z0, y, z1, y, facing);
}

// An upright square column, width w, standing on y0 up to y1.
function column(cx, cz, w, y0, y1) {
    const h = w / 2;
    return [
        ...wall(cx - h, cz - h, cx + h, cz - h, y0, y1),
        ...wall(cx + h, cz - h, cx + h, cz + h, y0, y1),
        ...wall(cx + h, cz + h, cx - h, cz + h, y0, y1),
        ...wall(cx - h, cz + h, cx - h, cz - h, y0, y1),
    ];
}

function footprintOf(index) {
    return { objectId: 'landmark:1', source: 'landmark-faces', closed: false,
        minX: index.minX, maxX: index.maxX, minZ: index.minZ, maxZ: index.maxZ,
        segments: [], landmarkWalk: index };
}

function walker(index, feetY) {
    const band = { minY: feetY - 1, maxY: feetY + 3 };
    return (fromX, fromZ, toX, toZ) => resolveWalkAgainstBuildingWalls(
        fromX, fromZ, toX, toZ, feetY,
        [landmarkWallFootprint(footprintOf(index), fromX, fromZ, 12, band)].filter(Boolean));
}

test('a landmark far outline is not a walker wall; an ordinary building outline is', () => {
    assert.equal(farOutlineIsWalkerWall({ footprint_source: 'landmark' }), false);
    assert.equal(farOutlineIsWalkerWall({ footprint_source: 'gdi' }), true);
    assert.equal(farOutlineIsWalkerWall({}), true);
});

test('an upright wall is cut at the query height along its full width, solid from both sides', () => {
    const index = buildLandmarkWalkIndex(wall(0, 5, 10, 5, 0, 20));
    const segments = landmarkWallSegments(index, 5, 4, 3, 1.0);
    const xs = segments.flatMap(s => [s.ax, s.bx]);
    assert.ok(segments.length >= 1);
    assert.ok(Math.min(...xs) < 0.01 && Math.max(...xs) > 9.99);
    for (const s of segments) {
        assert.equal(s.baseY, 0);
        assert.equal(s.topY, 20);
        assert.ok(Math.abs(s.az - 5) < 1e-6 && Math.abs(s.bz - 5) < 1e-6);
        assert.equal(s.normalX, undefined);
    }
});

test('floors, roofs and faces wholly above or below the cut give no walls', () => {
    const index = buildLandmarkWalkIndex([
        ...plate(-20, 20, -20, 20, 0.3),      // forecourt paving
        ...plate(-20, 20, -20, 20, 35),       // roof plate
        ...wall(-20, 0, 20, 0, 30, 36),       // roof fascia, 30 m up
        ...wall(-20, 3, 20, 3, 0, 0.9),       // seat back, below the cut
    ]);
    assert.deepEqual(landmarkWallSegments(index, 0, 0, 12, 1.0), []);
});

test('an inclined slab blocks where it crosses the body, not along its plan', () => {
    // Leans towards -z: foot at z = 10, head at z = 2 when 20 m up.
    const slab = [
        -10, 0, 10, 10, 0, 10, 10, 20, 2,
        -10, 0, 10, 10, 20, 2, -10, 20, 2,
    ];
    const index = buildLandmarkWalkIndex(slab);
    const zAt = segments => segments.reduce((sum, s) => sum + s.az + s.bz, 0) / (2 * segments.length);
    assert.ok(Math.abs(zAt(landmarkWallSegments(index, 0, 6, 8, 1.0)) - 9.6) < 1e-4);
    assert.ok(Math.abs(zAt(landmarkWallSegments(index, 0, 6, 8, 10.0)) - 6.0) < 1e-4);
});

test('a thin rib perpendicular to a facade is only as long as its section', () => {
    // A 0.2 m deep rib whose side runs up an inclined facade: 7.5 m in plan,
    // but where it crosses the body it is 0.2 m long.
    const side = [0, 0, 10, 0, 0, 10.2, 0, 20, 2.2, 0, 0, 10, 0, 20, 2.2, 0, 20, 2];
    const segments = landmarkWallSegments(buildLandmarkWalkIndex(side), 0, 9, 5, 1.0);
    for (const s of segments) assert.ok(Math.hypot(s.bx - s.ax, s.bz - s.az) <= 0.2 + 1e-4);
});

test('a long wall at an angle to the grid is found all along it and filed only where it runs', () => {
    // A 164 m facade bar at the stadium's 17.6 degrees: its plan box is 156 x 50 m.
    const angle = -17.6 * Math.PI / 180;
    const [dx, dz] = [Math.cos(angle) * 164, Math.sin(angle) * 164];
    const index = buildLandmarkWalkIndex(wall(0, 0, dx, dz, 0, 20));
    const entries = index.walls.entries.length;
    // Two triangles along a ~42-cell diagonal: a thin band, not the 40 x 13 box.
    assert.ok(entries < 2 * 3 * 55, entries);
    for (const t of [0.05, 0.5, 0.95]) {
        const segments = landmarkWallSegments(index, dx * t, dz * t + 1, 2, 1.0);
        assert.ok(segments.length > 0, t);
    }
});

test('the walker stands on the highest floor within a step, never on the roof overhead', () => {
    const index = buildLandmarkWalkIndex([
        ...plate(-20, 20, -20, 20, 2.0),      // raised forecourt
        ...plate(-20, 20, -20, 20, 17.8),     // concourse slab above
        ...plate(-20, 20, -20, 20, 40.0),     // roof
    ]);
    assert.ok(Math.abs(landmarkSupportY(index, 3, 4, 0.5 + 1.75) - 2.0) < 1e-6);
    assert.ok(Math.abs(landmarkSupportY(index, 3, 4, 18) - 17.8) < 1e-6);
    assert.equal(landmarkSupportY(index, 3, 4, 1.0), null);
    assert.equal(landmarkSupportY(index, 30, 4, 50), null);
});

test('a raked tier is a floor to walk up, and a soffit sloping down towards the walker is a wall', () => {
    // Tier rising 0.5 m per metre northwards; the same slope underneath as a soffit.
    const tier = slope(-10, 10, 0, 0.0, 20, 10.0, 'up');
    const up = buildLandmarkWalkIndex(tier);
    assert.equal(up.walls.count, 0);
    assert.ok(Math.abs(landmarkSupportY(up, 0, 4, 5) - 2.0) < 1e-6);
    const soffit = buildLandmarkWalkIndex(slope(-10, 10, 0, 0.0, 20, 10.0, 'down'));
    assert.equal(soffit.floors.count, 0);
    // Walking from under the high end towards the low end: stopped where the
    // soffit comes down to the middle of the body.
    const walk = walker(soffit, 0)(0, 10, 0, 0);
    assert.equal(walk.blocked, true);
    assert.ok(walk.z > 2.0, walk.z);
});

test('the walker crosses an open forecourt under raised slabs and stops at a column', () => {
    // A stand plate 17 m up with its fascia, on one column; the old part hull
    // would have sealed the whole 40 x 40 m square.
    const index = buildLandmarkWalkIndex([
        ...plate(-20, 20, -20, 20, 17),
        ...plate(-20, 20, -20, 20, 16.2, 'down'),
        ...wall(-20, -20, 20, -20, 16.2, 17),
        ...column(0, 0, 0.9, 0, 17),
    ]);
    const walk = walker(index, 0);
    assert.equal(walk(-25, 5, -5, 5).blocked, false);
    const into = walk(-5, 0, 0, 0);
    assert.equal(into.blocked, true);
    assert.ok(into.x < -0.45 - 0.3, into.x);
    // Its faces here wind inwards, which must not matter.
    const back = walk(5, 0, 0, 0);
    assert.equal(back.blocked, true);
    assert.ok(back.x > 0.45 + 0.3, back.x);
    // Without a body band there is no height to cut at: no walls at all.
    assert.equal(landmarkWallFootprint(footprintOf(index), 0, 0, 12, null), null);
});

test('a pedestrian route is checked against the same cut: open under slabs, closed at a column', () => {
    const index = buildLandmarkWalkIndex([
        ...plate(-20, 20, -20, 20, 17),
        ...plate(-20, 20, -20, 20, 16.2, 'down'),
        ...column(0, 0, 0.9, 0, 17),
    ]);
    const feetY = 0.055;
    const cut = landmarkWallFootprint(footprintOf(index), 0, 0, 30, { minY: feetY - 1, maxY: feetY + 3 });
    assert.equal(routeCrossesBuildingFootprints({ x: -25, z: 5 }, [{ x: 25, z: 5 }], [cut]), false);
    assert.equal(routeCrossesBuildingFootprints({ x: -25, z: 0 }, [{ x: 25, z: 0 }], [cut]), true);
    // A cut is never a closed outline: nobody is "inside" the square under the plate.
    assert.equal(pointInBuildingFootprint({ x: 5, z: 5 }, cut), false);
});
