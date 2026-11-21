// The walker's building walls: outside they block and slide, inside they let
// you out, and a facade is never something the body passes through.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveWalkAgainstBuildingWalls,
    walkerWallsFromFootprints,
    WALK_WALL_BODY_RADIUS_M,
} from '../core/walk-building-collision.js';

// A 10 m square block centred on the origin with outward normals, like the
// live footprint index produces from a ring's winding.
function squareBlock({ normals = true, baseY = 0, topY = 12 } = {}) {
    const corners = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const segments = corners.map(([ax, az], index) => {
        const [bx, bz] = corners[(index + 1) % corners.length];
        const midX = (ax + bx) / 2;
        const midZ = (az + bz) / 2;
        const length = Math.hypot(midX, midZ);
        return {
            ax, az, bx, bz, baseY, topY,
            ...(normals ? { normalX: midX / length, normalZ: midZ / length } : {}),
        };
    });
    return { objectId: 'block', closed: true, baseY, topY, segments };
}

test('walking into a facade stops at the body radius and slides along it', () => {
    const walls = [squareBlock()];
    // Head-on from the east: x stays at least radius off the x=5 wall.
    const headOn = resolveWalkAgainstBuildingWalls(8, 0, 3, 0, 0, walls);
    assert.ok(headOn.blocked);
    assert.ok(Math.abs(headOn.x - (5 + WALK_WALL_BODY_RADIUS_M)) < 1e-6, `x=${headOn.x}`);
    assert.ok(Math.abs(headOn.z) < 1e-6);
    // Diagonal: the tangential part of the stride survives.
    const diagonal = resolveWalkAgainstBuildingWalls(6, 0, 4, 2, 0, walls);
    assert.ok(diagonal.blocked);
    assert.ok(Math.abs(diagonal.x - (5 + WALK_WALL_BODY_RADIUS_M)) < 1e-6);
    assert.ok(diagonal.z > 1.5, `slid to z=${diagonal.z}`);
});

test('a long stride cannot tunnel through a thin wall', () => {
    const walls = [squareBlock()];
    const result = resolveWalkAgainstBuildingWalls(5.6, 1, -2, 1, 0, walls);
    assert.ok(result.x >= 5 + WALK_WALL_BODY_RADIUS_M - 1e-6, `x=${result.x}`);
});

test('a walker already inside the block walks out, never sealed in', () => {
    const walls = [squareBlock()];
    const out = resolveWalkAgainstBuildingWalls(0, 0, 7, 0, 0, walls);
    assert.equal(out.blocked, false);
    assert.ok(Math.abs(out.x - 7) < 1e-9);
});

test('without outward normals a wall blocks from either side, except for a walker already embedded in it', () => {
    // The pack's facade index: one footprint per wall, one claim per chunk.
    const block = squareBlock({ normals: false });
    const walls = block.segments.map(segment => ({ objectId: 'chunk', segments: [segment] }));
    const fromOutside = resolveWalkAgainstBuildingWalls(8, 0, 3, 0, 0, walls);
    assert.ok(fromOutside.blocked);
    assert.ok(Math.abs(fromOutside.x - (5 + WALK_WALL_BODY_RADIUS_M)) < 1e-6);
    const fromInside = resolveWalkAgainstBuildingWalls(0, 0, 7, 0, 0, walls);
    assert.ok(fromInside.blocked, 'no outline knowledge: the wall holds from inside too');
    assert.ok(fromInside.x <= 5 - WALK_WALL_BODY_RADIUS_M + 1e-6);
    // Spawned in the wall's band: let through rather than wedged.
    const embedded = resolveWalkAgainstBuildingWalls(5.1, 0, 6, 0, 0, walls);
    assert.equal(embedded.blocked, false);
    assert.ok(Math.abs(embedded.x - 6) < 1e-9);
    // Sliding along a wall at exactly the radius is not "embedded".
    const sliding = resolveWalkAgainstBuildingWalls(5 + WALK_WALL_BODY_RADIUS_M, 0, 4, 1, 0, walls);
    assert.ok(sliding.blocked);
    assert.ok(Math.abs(sliding.x - (5 + WALK_WALL_BODY_RADIUS_M)) < 1e-6);
});

test('walls only count at the walker\'s height: roofs, underpasses and plinths pass', () => {
    const block = squareBlock({ baseY: 0, topY: 12 });
    assert.equal(walkerWallsFromFootprints([block], 12.1).length, 0, 'standing on the roof');
    assert.equal(walkerWallsFromFootprints([block], -3).length, 0, 'a corridor under the building');
    assert.equal(walkerWallsFromFootprints([squareBlock({ baseY: 0, topY: 1.2 })], 0).length, 0, 'a plinth is stepped onto');
    assert.equal(walkerWallsFromFootprints([block], 0).length, 4);
    const unknownHeight = { objectId: 'lod1', segments: [{ ax: 0, az: 0, bx: 4, bz: 0 }] };
    assert.equal(walkerWallsFromFootprints([unknownHeight], 3).length, 1, 'an unknown facade is tall');
});

// A jetpack walker reported "I fly but in flight can't move forward": an
// unknown-height facade was anchored to the walker's feet, so it rose with
// them and blocked at every altitude. The wall stands on the ground instead.
test('an unknown facade stands on the ground, not on the walker\'s feet', () => {
    const unknownHeight = { objectId: 'lod1', segments: [{ ax: 0, az: 0, bx: 4, bz: 0 }] };
    assert.equal(walkerWallsFromFootprints([unknownHeight], 3, { groundY: 0 }).length, 1, 'street level: tall');
    assert.equal(walkerWallsFromFootprints([unknownHeight], 20, { groundY: 0 }).length, 1, 'below the assumed cornice');
    assert.equal(walkerWallsFromFootprints([unknownHeight], 30, { groundY: 0 }).length, 0, 'jetpack above the assumed cornice');
    assert.equal(walkerWallsFromFootprints([unknownHeight], 30, { groundY: 20 }).length, 1, 'the same wall on a 20 m hill');
    const knownHeight = { objectId: 'lod1', heightM: 40, segments: [{ ax: 0, az: 0, bx: 4, bz: 0 }] };
    assert.equal(walkerWallsFromFootprints([knownHeight], 30, { groundY: 0 }).length, 1, 'a 40 m tower is a wall at 30 m');
    assert.equal(walkerWallsFromFootprints([knownHeight], 41, { groundY: 0 }).length, 0, 'and open above its roof line');
    // Sliding at altitude: the step over an unknown block completes once the
    // walker is above the cornice, and is still stopped underneath it.
    const block = { objectId: 'lod1', segments: squareBlock({ baseY: null, topY: null }).segments
        .map(({ ax, az, bx, bz, normalX, normalZ }) => ({ ax, az, bx, bz, normalX, normalZ })) };
    const over = resolveWalkAgainstBuildingWalls(8, 0, 3, 0, 30, [block], { groundY: 0 });
    assert.equal(over.blocked, false);
    assert.ok(Math.abs(over.x - 3) < 1e-9, 'flew over the block');
    const under = resolveWalkAgainstBuildingWalls(8, 0, 3, 0, 10, [block], { groundY: 0 });
    assert.ok(under.blocked, 'held by the facade below the cornice');
});

test('a passage volume lets the walker through the wall it cuts', () => {
    const walls = [squareBlock()];
    const through = resolveWalkAgainstBuildingWalls(8, 0, 3, 0, 0, walls, {
        insidePassage: (x, z) => Math.abs(z) < 1.5 && x < 6,
    });
    assert.equal(through.blocked, false);
    assert.ok(Math.abs(through.x - 3) < 1e-9);
});

test('rounding a corner keeps the body radius off the vertex', () => {
    const walls = [squareBlock()];
    const corner = resolveWalkAgainstBuildingWalls(5.2, 5.2, 5.05, 5.05, 0, walls);
    assert.ok(Math.hypot(corner.x - 5, corner.z - 5) >= WALK_WALL_BODY_RADIUS_M - 1e-6);
});
