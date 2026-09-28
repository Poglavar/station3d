// Keep CPU read preparation slice boundaries and cancellation safe without browser machinery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroundPaintReadSteps } from '../core/ground-paint-read-slice.js';

function* records(items, onClose = () => {}) {
    try {
        for (const item of items) yield item;
        return 'complete';
    } finally {
        onClose();
    }
}

test('yields final per-slice counts and preserves the completed result', () => {
    let clock = 0;
    const stats = { slices: 0, checks: 0, operations: 0, maxSliceMs: 0 };
    const task = prepareGroundPaintReadSteps(records([
        { phase: 'sample' }, { phase: 'sample' }, { phase: 'index' },
    ]), () => true, { now: () => clock++, budgetMs: 100, maxSteps: 8, stats });
    const yielded = task.next();
    assert.equal(yielded.value.phase, 'paint-cpu');
    assert.deepEqual(yielded.value.operations, { sample: 2, index: 1 });
    assert.deepEqual(task.next(), { value: 'complete', done: true });
    assert.deepEqual(stats, { slices: 1, checks: 2, operations: 3, maxSliceMs: 4 });
});

test('freshness is checked after each slice and before returning a completed value', () => {
    let current = true;
    let advanced = 0;
    let closed = false;
    const source = {
        next() { advanced++; return { value: { phase: 'read' }, done: false }; },
        return() { closed = true; return { done: true }; },
    };
    let clock = 0;
    const task = prepareGroundPaintReadSteps(source, () => current, {
        now: () => clock++, budgetMs: 1, maxSteps: 4,
    });
    assert.equal(task.next().done, false);
    current = false;
    assert.deepEqual(task.next(), { value: null, done: true });
    assert.equal(advanced, 1);
    assert.equal(closed, true);

    current = true;
    const short = prepareGroundPaintReadSteps(records([{ phase: 'read' }]), () => current,
        { now: () => 0, budgetMs: 20, maxSteps: 4 });
    assert.equal(short.next().done, false);
    current = false;
    assert.deepEqual(short.next(), { value: null, done: true });
});

test('consumer cancellation closes the source iterator', () => {
    let closed = false;
    const task = prepareGroundPaintReadSteps(records([{ phase: 'read' }], () => { closed = true; }),
        () => true, { now: () => 0, budgetMs: 0, maxSteps: 1 });
    task.next();
    task.return();
    assert.equal(closed, true);
});

test('checks clock after each operation, even when a single read is costly', () => {
    let calls = 0;
    let reads = 0;
    const task = prepareGroundPaintReadSteps({
        next() { reads++; return { value: { phase: 'slow-read' }, done: false }; },
        return() { return { done: true }; },
    }, () => true, { now: () => calls++ === 0 ? 0 : 7, budgetMs: 2, maxSteps: 100 });
    assert.deepEqual(task.next(), {
        value: { phase: 'paint-cpu', operations: { 'slow-read': 1 } }, done: false,
    });
    assert.equal(reads, 1);
    assert.equal(calls, 3);
    task.return();
});

test('maxSteps caps a slice with a fixed clock and validates safe integers', () => {
    let reads = 0;
    const task = prepareGroundPaintReadSteps({
        next() { reads++; return { value: { phase: 'read' }, done: false }; },
        return() { return { done: true }; },
    }, () => true, { now: () => 0, budgetMs: 10, maxSteps: 3 });
    assert.deepEqual(task.next(), {
        value: { phase: 'paint-cpu', operations: { read: 3 } }, done: false,
    });
    assert.equal(reads, 3);
    task.return();
    const invalid = prepareGroundPaintReadSteps(records([]), () => true,
        { maxSteps: Number.MAX_SAFE_INTEGER + 1 });
    assert.throws(() => invalid.next(), TypeError);
});

test('rejects actual readiness and dependency wait flags and closes the iterator', () => {
    for (const record of [
        { phase: 'paint-prepare', deferFrame: true },
        { phase: 'build-bucket', ready: Promise.resolve() },
        { phase: 'dependency', waitingForDependency: true },
    ]) {
        let closed = false;
        const task = prepareGroundPaintReadSteps(records([record], () => { closed = true; }),
            () => true, { now: () => 0, budgetMs: 1 });
        assert.throws(() => task.next(), TypeError);
        assert.equal(closed, true);
    }
});
