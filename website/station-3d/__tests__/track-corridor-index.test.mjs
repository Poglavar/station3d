// The corridor point tests are backed by a uniform-grid index instead of a scan
// over every volume. An index that merely looks right is worthless here: a
// missed volume means a curb drawn through a trackbed, or decor standing on the
// rails, in one specific spot that nobody will reproduce on purpose.
//
// So this compares the indexed answer against an exhaustive scan for thousands
// of pseudo-random points against thousands of rotated volumes. Any disagreement
// at all fails, and the volume count is pushed well past the threshold where the
// index switches on.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isPointInsideCorridorFootprints,
    isPointInsideCorridorVolumes,
    orientedFootprintIntersectsCorridors,
} from '../world/track-corridors.js';

// Deterministic PRNG: a failure has to be reproducible.
function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

// A chain of oriented boxes along a wandering path, which is the real shape:
// hundreds of segments strung end to end, each rotated to its own heading.
function makeVolumes(count, seed) {
    const random = rng(seed);
    const volumes = [];
    let x = 0;
    let z = 0;
    let heading = 0;
    for (let i = 0; i < count; i++) {
        heading += (random() - 0.5) * 0.6;
        const halfDepth = 4 + random() * 8;
        const alongX = Math.cos(heading);
        const alongZ = Math.sin(heading);
        x += alongX * halfDepth * 2;
        z += alongZ * halfDepth * 2;
        volumes.push({
            centerX: x,
            centerZ: z,
            centerY: 2.5,
            rightX: -alongZ,
            rightZ: alongX,
            alongX,
            alongZ,
            halfWidth: 2 + random() * 3,
            halfDepth,
            halfHeight: 2.5,
        });
    }
    return volumes;
}

// The pre-index implementations, kept verbatim as the reference answer.
function scanVolumes(worldX, worldY, worldZ, volumes) {
    for (const volume of volumes) {
        const dx = worldX - volume.centerX;
        const dy = worldY - volume.centerY;
        const dz = worldZ - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) <= volume.halfWidth
            && Math.abs(dy) <= volume.halfHeight
            && Math.abs(localAlong) <= volume.halfDepth) return true;
    }
    return false;
}

function scanFootprints(worldX, worldZ, volumes, padding = 0) {
    const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
    for (const volume of volumes) {
        const dx = worldX - volume.centerX;
        const dz = worldZ - volume.centerZ;
        const localRight = dx * volume.rightX + dz * volume.rightZ;
        const localAlong = dx * volume.alongX + dz * volume.alongZ;
        if (Math.abs(localRight) <= volume.halfWidth + safePadding
            && Math.abs(localAlong) <= volume.halfDepth + safePadding) return true;
    }
    return false;
}

test('the indexed volume test agrees with an exhaustive scan everywhere', () => {
    const volumes = makeVolumes(1500, 12345);
    const random = rng(999);
    let inside = 0;
    for (let i = 0; i < 20000; i++) {
        // Sample near the chain, so a good share of points land inside rather
        // than all of them trivially missing.
        const anchor = volumes[Math.floor(random() * volumes.length)];
        const x = anchor.centerX + (random() - 0.5) * 40;
        const z = anchor.centerZ + (random() - 0.5) * 40;
        const y = 2.5 + (random() - 0.5) * 8;
        const expected = scanVolumes(x, y, z, volumes);
        if (expected) inside += 1;
        assert.equal(
            isPointInsideCorridorVolumes(x, y, z, volumes), expected,
            `disagreement at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`,
        );
    }
    // If nothing landed inside, the test proved only that empty space is empty.
    assert.ok(inside > 2000, `only ${inside} of 20000 points were inside — sample is not exercising hits`);
});

test('the indexed footprint test agrees with an exhaustive scan, padding included', () => {
    const volumes = makeVolumes(1200, 777);
    const random = rng(4242);
    let inside = 0;
    for (let i = 0; i < 20000; i++) {
        const anchor = volumes[Math.floor(random() * volumes.length)];
        const x = anchor.centerX + (random() - 0.5) * 40;
        const z = anchor.centerZ + (random() - 0.5) * 40;
        // Paddings that straddle the 32 m cell size, including one larger than
        // a cell, which is the case a naive single-cell lookup gets wrong.
        const padding = [0, 0.25, 1.2, 6, 40][i % 5];
        const expected = scanFootprints(x, z, volumes, padding);
        if (expected) inside += 1;
        assert.equal(
            isPointInsideCorridorFootprints(x, z, volumes, padding), expected,
            `disagreement at (${x.toFixed(3)}, ${z.toFixed(3)}) padding ${padding}`,
        );
    }
    assert.ok(inside > 2000, `only ${inside} of 20000 points were inside — sample is not exercising hits`);
});

test('small volume sets and junk inputs behave as before', () => {
    // Under the index threshold the scan is used; the answers must not change.
    const few = makeVolumes(4, 31337);
    for (const v of few) {
        assert.equal(isPointInsideCorridorVolumes(v.centerX, v.centerY, v.centerZ, few), true);
        assert.equal(isPointInsideCorridorFootprints(v.centerX, v.centerZ, few), true);
    }
    assert.equal(isPointInsideCorridorVolumes(0, 0, 0, null), false);
    assert.equal(isPointInsideCorridorVolumes(0, 0, 0, []), false);
    assert.equal(isPointInsideCorridorFootprints(0, 0, undefined), false);
    assert.equal(isPointInsideCorridorFootprints(0, 0, [], Number.NaN), false);
});

test('a point far from the chain is outside however many volumes there are', () => {
    const volumes = makeVolumes(2000, 5150);
    assert.equal(isPointInsideCorridorVolumes(1e6, 2.5, 1e6, volumes), false);
    assert.equal(isPointInsideCorridorFootprints(1e6, 1e6, volumes, 10), false);
});

test('an oriented parked-vehicle footprint catches nose and corner overlap', () => {
    const corridor = [{
        centerX: 0,
        centerZ: 0,
        rightX: 1,
        rightZ: 0,
        alongX: 0,
        alongZ: 1,
        halfWidth: 1.5,
        halfDepth: 12,
    }];
    const intersects = (overrides = {}) => orientedFootprintIntersectsCorridors({
        centerX: 0,
        centerZ: 14,
        heading: 0,
        widthM: 1.8,
        lengthM: 4.5,
        volumes: corridor,
        ...overrides,
    });

    assert.equal(intersects(), true,
        'the vehicle nose overlaps although its centre is beyond the track box');
    assert.equal(intersects({ centerZ: 15 }), false);
    assert.equal(intersects({ centerX: 3, centerZ: 13.5, heading: Math.PI / 4 }), true,
        'a rotated vehicle corner overlaps the tram sweep');
    assert.equal(intersects({ centerX: 5, centerZ: 13.5, heading: Math.PI / 4 }), false);
    assert.equal(orientedFootprintIntersectsCorridors({ volumes: corridor }), false);
});
