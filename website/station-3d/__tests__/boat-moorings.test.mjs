// Moored boats come from the loaded shoreline: on the water side of the bank,
// parallel to it, a hull's clearance out, at stable spots with stable looks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MOORED_BOAT_HULL_SCALES, MOORED_BOAT_LETTERINGS, MOORING_DEFAULTS, mooringHash, shorelineMoorings,
} from '../core/boat-moorings.js';
import { boatPoseIsNavigable } from '../core/boat-navigation.js';

// A 400 m square lake centred on the origin, ring closed, water inside.
const LAKE = [[-200, -200], [200, -200], [200, 200], [-200, 200], [-200, -200]];
const inLake = (x, z) => Math.abs(x) < 200 && Math.abs(z) < 200;
const distanceToBank = (x, z) => 200 - Math.max(Math.abs(x), Math.abs(z));

test('lake moorings sit a hull out from the bank, lie along it, and are tied to a point on the ring', () => {
    const moorings = shorelineMoorings({ rings: [LAKE], x: 0, z: -190, isWaterAt: inLake, radiusM: 300, share: 1 });
    assert.ok(moorings.length >= 8, `${moorings.length} moorings`);
    let previous = -1;
    for (const mooring of moorings) {
        assert.ok(inLake(mooring.x, mooring.z), `${mooring.id} is in the water`);
        assert.ok(Math.abs(distanceToBank(mooring.x, mooring.z) - MOORING_DEFAULTS.offsetM) < 1e-6, `${mooring.id} lies ${distanceToBank(mooring.x, mooring.z).toFixed(2)} m off the bank`);
        assert.equal(distanceToBank(mooring.rope.x, mooring.rope.z), 0, 'the rope is tied on the bank');
        // Parallel to the bank: on the south bank the heading is east or west.
        const onSouthOrNorth = Math.abs(mooring.rope.z) === 200;
        const alongX = Math.abs(Math.sin(mooring.heading)) > 0.999;
        assert.equal(alongX, onSouthOrNorth, `${mooring.id} lies along its bank`);
        assert.ok(mooring.distanceM >= previous, 'nearest first');
        assert.ok(mooring.distanceM <= 300);
        previous = mooring.distanceM;
        assert.ok(MOORED_BOAT_LETTERINGS.includes(mooring.lettering));
        assert.ok(MOORED_BOAT_HULL_SCALES.includes(mooring.hullScale));
        assert.equal(boatPoseIsNavigable(mooring, inLake), true, `${mooring.id} fits its hull`);
    }
    assert.deepEqual(moorings, shorelineMoorings({ rings: [LAKE], x: 0, z: -190, isWaterAt: inLake, radiusM: 300, share: 1 }), 'deterministic');
});

test('the share thins the moorings by a stable hash, so the same spots keep their boats', () => {
    const all = shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: inLake, radiusM: 400, share: 1 });
    const some = shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: inLake, radiusM: 400 });
    const none = shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: inLake, radiusM: 400, share: 0 });
    assert.equal(none.length, 0);
    assert.ok(some.length > 0 && some.length < all.length, `${some.length} of ${all.length}`);
    const allIds = new Set(all.map(mooring => mooring.id));
    assert.ok(some.every(mooring => allIds.has(mooring.id)));
    // Moving the player keeps every id that is still in range.
    const moved = shorelineMoorings({ rings: [LAKE], x: 150, z: 150, isWaterAt: inLake, radiusM: 400 });
    const someIds = new Set(some.map(mooring => mooring.id));
    for (const mooring of moved) if (mooring.distanceM <= 400) assert.ok(someIds.has(mooring.id) || mooring.distanceM > 0);
    assert.notEqual(mooringHash(1, 2), mooringHash(2, 1));
    assert.equal(mooringHash(7, -3), mooringHash(7, -3));
});

test('a straight coast as an open line, {x, z} points, and an island hole all moor on the water side', () => {
    const sea = (_x, z) => z < 0;
    const coast = shorelineMoorings({ rings: [[{ x: -300, z: 0 }, { x: 300, z: 0 }]], x: 0, z: 10, isWaterAt: sea, radiusM: 200, share: 1 });
    assert.ok(coast.length >= 6);
    for (const mooring of coast) {
        assert.ok(Math.abs(mooring.z + MOORING_DEFAULTS.offsetM) < 1e-6, 'off the coast, on the sea side');
        assert.ok(Math.abs(Math.sin(mooring.heading)) > 0.999, 'along the coast');
    }
    const island = [[-50, -50], [50, -50], [50, 50], [-50, 50], [-50, -50]];
    const aroundIsland = (x, z) => !(Math.abs(x) < 50 && Math.abs(z) < 50);
    const shore = shorelineMoorings({ rings: [island], x: 0, z: -60, isWaterAt: aroundIsland, radiusM: 200, share: 1 });
    assert.ok(shore.length >= 4);
    for (const mooring of shore) {
        assert.ok(aroundIsland(mooring.x, mooring.z), 'in the water, outside the island');
        assert.ok(Math.max(Math.abs(mooring.x), Math.abs(mooring.z)) - 50 > 2, 'clear of the island bank');
    }
});

test('no water, water on both sides, junk rings and a missing probe yield nothing', () => {
    assert.deepEqual(shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: () => false, share: 1 }), []);
    assert.deepEqual(shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: () => true, share: 1 }), [], 'a spit with water either side is no bank');
    assert.deepEqual(shorelineMoorings({ rings: [null, [], [[1, 2]], [[NaN, 1], [2, 3]]], x: 0, z: 0, isWaterAt: inLake, share: 1 }), []);
    assert.deepEqual(shorelineMoorings({ rings: [LAKE], x: NaN, z: 0, isWaterAt: inLake }), []);
    assert.deepEqual(shorelineMoorings({ rings: [LAKE], x: 0, z: 0 }), []);
    assert.deepEqual(shorelineMoorings({ rings: [LAKE], x: 0, z: 0, isWaterAt: inLake, radiusM: 10, share: 1 }), [], 'nothing within reach');
});
