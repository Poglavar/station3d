// The ordering that lets merged-geometry assembly be budgeted instead of
// synchronous: the far layer's prisms may only drop once the merged mesh that
// replaces them exists. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAggregateGate } from '../core/aggregate-gate.js';

test('a tile is announced only when its LAST bucket has assembled', () => {
    const gate = createAggregateGate();
    let announced = 0;
    gate.await('t1', ['a', 'b'], () => { announced++; });

    gate.noteAssembled('a');
    // Announcing here would drop the prisms while half the tile's walls are
    // still un-merged and therefore drawn nowhere — a hole in the ground.
    assert.equal(announced, 0, 'must not announce on a partial assembly');

    gate.noteAssembled('b');
    assert.equal(announced, 1);
    assert.equal(gate.size, 0);

    // Late repeats of an already-satisfied bucket must not re-announce.
    gate.noteAssembled('b');
    assert.equal(announced, 1);
});

test('a tile with nothing to merge is announced immediately', () => {
    const gate = createAggregateGate();
    let announced = 0;
    // No mergeable buildings (or none at all): holding the prisms up would be
    // pure lag, since no merged geometry is coming.
    const gatedEmpty = gate.await('t1', [], () => { announced++; });
    assert.equal(announced, 1);
    assert.equal(gatedEmpty, false);
    assert.equal(gate.size, 0);

    const gatedNull = gate.await('t2', null, () => { announced++; });
    assert.equal(announced, 2);
    assert.equal(gatedNull, false);
});

test('several tiles sharing a regional bucket all resolve on it', () => {
    // Buckets are REGIONAL: neighbouring tiles contribute to the same merged
    // mesh, so one assembly can be the last thing several tiles wait for.
    const gate = createAggregateGate();
    const seen = [];
    gate.await('t1', ['shared'], () => seen.push('t1'));
    gate.await('t2', ['shared'], () => seen.push('t2'));
    gate.await('t3', ['shared', 'other'], () => seen.push('t3'));

    gate.noteAssembled('shared');
    assert.deepEqual(seen, ['t1', 't2']);
    assert.equal(gate.size, 1, 't3 still waits on its second bucket');

    gate.noteAssembled('other');
    assert.deepEqual(seen, ['t1', 't2', 't3']);
});

test('an evicted tile is never announced', () => {
    const gate = createAggregateGate();
    let announced = 0;
    gate.await('t1', ['a'], () => { announced++; });
    gate.forget('t1');
    gate.noteAssembled('a');
    // Announcing after eviction tells the far layer to drop its prisms over
    // ground that has no detailed tile at all — a permanent hole.
    assert.equal(announced, 0);
    assert.equal(gate.size, 0);
});

test('stranded tiles are released rather than left under prisms forever', () => {
    const gate = createAggregateGate();
    const seen = [];
    gate.await('t1', ['gone'], () => seen.push('t1'));
    gate.await('t2', ['also-gone'], () => seen.push('t2'));

    // A bucket that assembles to nothing is deleted and never reports. Without
    // this failsafe the tile stays covered by LOD1 prisms for the whole session.
    assert.equal(gate.releaseStranded(), 2);
    assert.deepEqual(seen, ['t1', 't2']);
    assert.equal(gate.size, 0);
    assert.equal(gate.releaseStranded(), 0, 'nothing left to release');
});

test('a tile completing twice supersedes its earlier wait', () => {
    const gate = createAggregateGate();
    const seen = [];
    gate.await('t1', ['a'], () => seen.push('first'));
    gate.await('t1', ['b'], () => seen.push('second'));
    gate.noteAssembled('a');
    assert.deepEqual(seen, [], 'the superseded wait must not fire');
    gate.noteAssembled('b');
    assert.deepEqual(seen, ['second']);
});

test('clear drops everything without announcing', () => {
    const gate = createAggregateGate();
    let announced = 0;
    gate.await('t1', ['a'], () => { announced++; });
    gate.clear();
    gate.noteAssembled('a');
    assert.equal(announced, 0);
    assert.equal(gate.size, 0);
});
