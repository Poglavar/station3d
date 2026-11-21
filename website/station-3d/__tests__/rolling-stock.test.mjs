// Verifies heavy-rail sessions and standard-gauge traffic select HŽ 7022.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROLLING_STOCK_HZ_7022,
    ROLLING_STOCK_TMK_2400,
    selectRollingStock,
} from '../core/rolling-stock.js';

test('heavy-rail simulation uses HŽ 7022', () => {
    assert.equal(selectRollingStock({ isTrainSession: true }), ROLLING_STOCK_HZ_7022);
});

test('standard-gauge traffic visible from walk mode uses HŽ 7022', () => {
    assert.equal(selectRollingStock({ trackType: 'g1435' }), ROLLING_STOCK_HZ_7022);
});

test('tram sessions retain TMK 2400', () => {
    assert.equal(selectRollingStock({ trackType: 'g1000' }), ROLLING_STOCK_TMK_2400);
});

test('an explicit Zagreb tram track stays TMK 2400 inside a heavy-rail world', () => {
    assert.equal(selectRollingStock({
        isTrainSession: true,
        trackType: 'tram',
    }), ROLLING_STOCK_TMK_2400);
});
