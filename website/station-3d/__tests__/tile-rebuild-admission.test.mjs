import test from 'node:test';
import assert from 'node:assert/strict';
import { takeNextTileRebuild } from '../core/regional-tile-rebuild.js';

function setup(count = 12) {
    const tilePayloads = new Map(Array.from({ length: count }, (_, i) => [`${i}_0`, { features: [i] }]));
    const tasks = [...tilePayloads].map(([tileKey, payload]) => ({ tileKey, payload }));
    const activeTiles = new Map();
    return { tasks, tilePayloads, activeTiles, maxActive: 2, tileM: 100 };
}

test('repeated frame visits cannot start a replacement generation for every retained tile', () => {
    const state = setup();
    for (let frame = 0; frame < 120; frame++) {
        const task = takeNextTileRebuild(state.tasks, state);
        if (task) state.activeTiles.set(task.tileKey, { awaitingUpload: true });
        assert.ok(state.activeTiles.size <= 2, 'old/new generations may overlap for only two tiles');
    }
    assert.equal(state.tasks.length, 10, 'unadmitted work is retained, not silently dropped');
});

test('terrain and regional queues share the same live replacement capacity', () => {
    const state = setup(6);
    const regional = state.tasks.splice(3);
    for (const queue of [state.tasks, regional, state.tasks, regional]) {
        const task = takeNextTileRebuild(queue, state);
        if (task) state.activeTiles.set(task.tileKey, {});
    }
    assert.equal(state.activeTiles.size, 2);
    assert.equal(state.tasks.length + regional.length, 4);
});

test('a slot is held through upload, and actual publication or eviction admits the next tile', () => {
    const state = setup(5);
    for (let i = 0; i < 2; i++) {
        const task = takeNextTileRebuild(state.tasks, state);
        state.activeTiles.set(task.tileKey, { built: true, published: false });
    }
    assert.equal(takeNextTileRebuild(state.tasks, state), null);
    state.activeTiles.delete('0_0'); // the real owner retires on publication/eviction
    assert.equal(takeNextTileRebuild(state.tasks, state).tileKey, '2_0');
});

test('new invalidation of an active tile survives until the previous generation is retired', () => {
    const state = setup(3);
    state.activeTiles.set('0_0', {});
    assert.equal(takeNextTileRebuild(state.tasks, state).tileKey, '1_0');
    assert.equal(state.tasks[0].tileKey, '0_0');
    state.activeTiles.delete('0_0');
    assert.equal(takeNextTileRebuild(state.tasks, state).tileKey, '0_0');
});

test('evicted and superseded payloads are pruned even when all slots are occupied', () => {
    const state = setup(5);
    state.activeTiles.set('3_0', {});
    state.activeTiles.set('4_0', {});
    state.tilePayloads.delete('0_0');
    state.tilePayloads.set('1_0', { features: ['new'] });
    assert.equal(takeNextTileRebuild(state.tasks, state), null);
    assert.deepEqual(state.tasks.map(task => task.tileKey), ['2_0', '3_0', '4_0']);
});

test('admission rechecks the current observer and never mutates source payloads', () => {
    const state = setup(10);
    state.tasks.forEach(task => Object.freeze(task.payload));
    assert.equal(takeNextTileRebuild(state.tasks, { ...state, focusX: 940 }).tileKey, '9_0');
    assert.equal(takeNextTileRebuild(state.tasks, { ...state, focusX: 40 }).tileKey, '0_0');
    assert.equal(state.tilePayloads.size, 10);
});

test('regional obligations already satisfied by the current style are discarded', () => {
    const state = setup(2);
    state.tasks[0].architectureId = 'zagreb';
    state.tasks[1].architectureId = 'split';
    state.tilePayloads.get('0_0').architectureId = 'zagreb';
    const next = takeNextTileRebuild(state.tasks, {
        ...state, stillNeeded: (task, current) => current.architectureId !== task.architectureId,
    });
    assert.equal(next.tileKey, '1_0');
    assert.equal(state.tasks.length, 0);
});
