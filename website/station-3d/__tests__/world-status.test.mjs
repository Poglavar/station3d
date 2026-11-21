// The cab's world-loading light reduces the FPS overlay's background counters to one colour.
// These lock the rule, because the dot is only useful if green really means "nothing left".

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWorldStatus, worldStatusLabel, WORLD_STATUS_COLORS } from '../core/world-status.js';

test('nothing outstanding is ready', () => {
    assert.equal(computeWorldStatus([]).state, 'ready');
    assert.equal(computeWorldStatus(null).state, 'ready');
    assert.equal(computeWorldStatus(undefined).state, 'ready');
});

test('a non-empty snapshot is NOT loading on its own', () => {
    // getBackgroundActivitySnapshot keeps 'stream' and 'layer' entries while they only report
    // how much is already loaded. Treating "snapshot has rows" as loading would leave the dot
    // amber forever on a fully built world.
    const status = computeWorldStatus([
        { kind: 'stream', label: 'buildings', loaded: 812, pending: 0 },
        { kind: 'layer', label: 'terrain', loaded: 4, pending: 0 },
    ]);
    assert.equal(status.state, 'ready');
    assert.equal(status.pending, 0);
});

test('work in any in-progress counter turns it amber', () => {
    for (const field of ['pending', 'fetching', 'building', 'retrying']) {
        const status = computeWorldStatus([{ kind: 'build', label: 'roads', [field]: 2 }]);
        assert.equal(status.state, 'loading', field);
    }
});

test('counters add up across every entry', () => {
    const status = computeWorldStatus([
        { kind: 'build', label: 'roads', pending: 3 },
        { kind: 'load', label: 'buildings', fetching: 2, building: 1 },
        { kind: 'stream', label: 'trees', retrying: 1, buildFailed: 4 },
    ]);
    assert.equal(status.pending, 6);
    assert.equal(status.retrying, 1);
    assert.equal(status.failed, 4);
    assert.equal(status.state, 'loading');
});

test('failures only show once the queue is empty — in-progress work wins', () => {
    const stillWorking = computeWorldStatus([
        { kind: 'load', label: 'buildings', pending: 1, failed: 3 },
    ]);
    assert.equal(stillWorking.state, 'loading', 'a retry may still fix it');

    const done = computeWorldStatus([
        { kind: 'load', label: 'buildings', pending: 0, fetchFailed: 2, buildFailed: 1 },
    ]);
    assert.equal(done.state, 'failed');
    assert.equal(done.failed, 3);
});

test('garbage counters do not fabricate work', () => {
    const status = computeWorldStatus([
        { kind: 'build', label: 'x', pending: -5 },
        { kind: 'build', label: 'y', pending: 'nonsense' },
        { kind: 'build', label: 'z' },
        null,
    ]);
    assert.equal(status.state, 'ready');
    assert.equal(status.pending, 0);
});

test('each state has its own colour and a label that says what is outstanding', () => {
    assert.notEqual(WORLD_STATUS_COLORS.loading, WORLD_STATUS_COLORS.ready);
    assert.notEqual(WORLD_STATUS_COLORS.failed, WORLD_STATUS_COLORS.ready);

    // The label is translated by the caller, so assert on the key and the
    // counts it interpolates rather than on one locale's wording.
    const spy = (key, params) => [key, ...Object.values(params || {})].join(':');
    assert.equal(
        worldStatusLabel(computeWorldStatus([{ label: 'a', pending: 7 }]), spy),
        'status.loading:status.loadingPending:7',
    );
    assert.equal(
        worldStatusLabel(computeWorldStatus([{ label: 'a', failed: 2 }]), spy),
        'status.partial:2',
    );
    assert.equal(worldStatusLabel(computeWorldStatus([]), spy), 'status.ready');
    // No translator: the keys themselves come back, never a crash or a blank.
    assert.equal(worldStatusLabel(computeWorldStatus([])), 'status.ready');
});
