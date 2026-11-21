// The legacy estimate stays available to the watchdog. Player-facing progress
// describes measured stages; elapsed time alone never implies activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { worldLoadFraction, worldLoadStages } from '../core/loading-progress.js';

const weights = { 'terrain-data': 3000, roads: 1000, buildings: 2000 };

test('the fraction is the experienced-time share of finished components', () => {
    const result = worldLoadFraction([
        { key: 'terrain-data', done: true },
        { key: 'roads', done: false, active: true },
        { key: 'buildings', done: false },
    ], weights);
    assert.equal(result.fraction, 0.5);
    assert.equal(result.activeKey, 'roads');
    assert.equal(result.doneCount, 1);
    assert.equal(result.count, 3);
});

test('an active component with measured download progress contributes its share pro rata', () => {
    const result = worldLoadFraction([
        { key: 'terrain-data', done: false, active: true, progress: 0.5 },
        { key: 'roads', done: false },
        { key: 'buildings', done: false },
    ], weights);
    assert.equal(result.fraction, 0.25);
    assert.equal(result.activeKey, 'terrain-data');
});

test('unknown components fall back to the default weight and nothing ever exceeds one', () => {
    const result = worldLoadFraction([
        { key: 'mystery', done: true },
        { key: 'roads', done: true },
    ], weights, { fallbackWeight: 1000 });
    assert.equal(result.fraction, 1);
    assert.equal(result.activeKey, null);
    assert.equal(worldLoadFraction([], weights).fraction, 0);
    assert.equal(worldLoadFraction([{ key: 'roads', done: false, progress: 7 }], weights).fraction, 1, 'progress is clamped');
    assert.equal(worldLoadFraction([{ key: 'roads', done: false, progress: -1 }], weights).fraction, 0);
});

test('a finished component never contributes less than an unfinished one did a moment earlier', () => {
    // Monotonic across the pipeline: the same weights, components finishing in order.
    const order = ['terrain-data', 'roads', 'buildings'];
    let previous = -1;
    for (let done = 0; done <= order.length; done++) {
        const list = order.map((key, index) => ({ key, done: index < done, active: index === done }));
        const { fraction } = worldLoadFraction(list, weights);
        assert.ok(fraction >= previous, `fraction fell from ${previous} to ${fraction}`);
        previous = fraction;
    }
    assert.equal(previous, 1);
});


test('named stages keep concurrent work visible and never synthesize completion', () => {
    assert.deepEqual(worldLoadStages([
        { key: 'terrain', active: true, progress: .4 },
        { key: 'buildings', active: true },
        { key: 'roads', done: true },
    ]), {
        doneCount: 1,
        finishing: false,
        active: [{ key: 'terrain', fraction: .4, finishing: false }, { key: 'buildings', fraction: null, finishing: false }],
    });
    assert.deepEqual(worldLoadStages([{ key: 'pack', active: true, progress: 1 }]).active[0],
        { key: 'pack', fraction: null, finishing: true });
    assert.equal(worldLoadStages([{ key: 'pack', done: true }]).finishing, true);
    assert.equal(worldLoadStages([{ key: 'pack', active: true, progress: 1 }]).finishing, false);
});

