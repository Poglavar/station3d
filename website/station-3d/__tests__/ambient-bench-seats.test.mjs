// Every streamed bench source shares this registry. These tests lock owner
// replacement, source coexistence and the spatial lookup used by pedestrians.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ambientBenchSeatCount,
    clearAmbientBenchSeats,
    getAmbientBenchSeat,
    replaceAmbientBenchSeats,
    visitAmbientBenchSeatsNear,
} from '../core/ambient-bench-seats.js';

const OWNERS = ['test-ground-benches', 'test-roof-benches'];

function clearTestSeats() {
    for (const owner of OWNERS) clearAmbientBenchSeats(owner);
}

test.afterEach(clearTestSeats);

test('ground and roof benches coexist under the same seat contract', () => {
    replaceAmbientBenchSeats(OWNERS[0], [
        { id: 'ground:a', x: 1, z: 2, seatY: 0.5, yaw: 0 },
        { id: 'ground:b', x: 40, z: 40, seatY: 1, yaw: Math.PI },
    ]);
    replaceAmbientBenchSeats(OWNERS[1], [
        { id: 'roof:a', x: 3, z: 4, seatY: 14.5, yaw: 1, surfaceId: 'roof:7' },
    ]);

    assert.equal(ambientBenchSeatCount(), 3);
    assert.equal(getAmbientBenchSeat('roof:a').surfaceId, 'roof:7');

    const nearby = [];
    visitAmbientBenchSeatsNear(0, 0, 8, seat => nearby.push(seat.id));
    assert.deepEqual(nearby.sort(), ['ground:a', 'roof:a']);
});

test('replacing or clearing one owner cannot retire another owner’s seats', () => {
    replaceAmbientBenchSeats(OWNERS[0], [
        { id: 'ground:a', x: 1, z: 2, seatY: 0.5, yaw: 0 },
    ]);
    replaceAmbientBenchSeats(OWNERS[1], [
        { id: 'roof:a', x: 3, z: 4, seatY: 14.5, yaw: 1, surfaceId: 'roof:7' },
    ]);

    replaceAmbientBenchSeats(OWNERS[0], [
        { id: 'ground:c', x: 5, z: 6, seatY: 0.6, yaw: 0.2 },
    ]);
    assert.equal(getAmbientBenchSeat('ground:a'), null);
    assert.ok(getAmbientBenchSeat('ground:c'));
    assert.ok(getAmbientBenchSeat('roof:a'));

    assert.equal(clearAmbientBenchSeats(OWNERS[1]), 1);
    assert.equal(getAmbientBenchSeat('roof:a'), null);
    assert.ok(getAmbientBenchSeat('ground:c'));
});
