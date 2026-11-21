// Covers proportional, wrapping loading-bar spans across desktop and mobile
// grid widths.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadingGridPlan } from '../core/loading-layout.js';

const weights = [
    900, 200, 300, 1200, 1600, 1500, 700, 2500, 1200, 3500, 1200,
].map(weight => ({ weight }));

function rowsFromPlan(plan) {
    const rows = [[]];
    for (const item of plan) {
        if (item.breakBefore) rows.push([]);
        rows.at(-1).push(item.span);
    }
    return rows;
}

test('desktop plan stays proportional without stretching a final-row orphan', () => {
    const plan = loadingGridPlan(weights, {
        columns: 24,
        targetRows: 2,
        minimumSpan: 4,
    });
    const rows = rowsFromPlan(plan);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.reduce((sum, span) => sum + span, 0) <= 24));
    assert.ok(rows.every(row => row.length > 1), 'balanced partition avoids orphan rows');
    assert.ok(plan[9].span > plan[5].span, 'larger building work receives a wider bar');
    assert.ok(plan[5].span >= plan[1].span, 'road work is not narrower than decode');
});

test('mobile plan uses more readable rows and keeps one common width scale', () => {
    const plan = loadingGridPlan(weights, {
        columns: 12,
        targetRows: 3,
        minimumSpan: 3,
    });
    const rows = rowsFromPlan(plan);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.length <= 4));
    assert.ok(rows.every(row => row.reduce((sum, span) => sum + span, 0) <= 12));
    assert.ok(plan[9].span > plan[1].span);
});

test('invalid or missing weights receive a stable readable fallback', () => {
    const plan = loadingGridPlan([
        { weight: 0 }, {}, { weight: Number.NaN }, { weight: 1600 },
    ], {
        columns: 12,
        targetRows: 1,
        minimumSpan: 3,
        fallbackWeight: 800,
    });
    assert.equal(plan.length, 4);
    assert.ok(plan.every(item => item.span >= 3 && item.span <= 12));
});
