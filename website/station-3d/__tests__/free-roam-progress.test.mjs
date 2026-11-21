import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FREE_ROAM_PROGRESS_KEY,
    JETPACK_PRICE_BTC,
    JETPACK_PRICE_DINARS,
    purchaseJetpack,
    readFreeRoamProgress,
    reduceJetpackShop,
} from '../core/free-roam-progress.js';

const storage = (initial = null) => {
    let value = initial;
    return {
        getItem: () => value,
        setItem: (_key, next) => { value = next; },
    };
};

test('shop constants and direct buy rejection', () => {
    assert.equal(JETPACK_PRICE_DINARS, 30_000_000_000);
    assert.equal(JETPACK_PRICE_BTC, 0.1);
    assert.deepEqual(reduceJetpackShop(undefined, 'buy'), { phase: 'offer', jetpackOwned: false });
});

test('bitcoin offer then buy reaches owned', () => {
    let state = reduceJetpackShop(undefined, 'offer-bitcoin');
    state = reduceJetpackShop(state, 'buy');
    assert.deepEqual(state, { phase: 'owned', jetpackOwned: true });
    assert.deepEqual(reduceJetpackShop(state, 'buy'), state);
});

test('purchase persists and repeated purchase is idempotent', () => {
    const store = storage();
    assert.deepEqual(purchaseJetpack(store), { jetpackOwned: true });
    const saved = store.getItem(FREE_ROAM_PROGRESS_KEY);
    assert.deepEqual(readFreeRoamProgress(store), { version: 1, jetpackOwned: true });
    assert.deepEqual(purchaseJetpack(store), { jetpackOwned: true });
    assert.equal(store.getItem(FREE_ROAM_PROGRESS_KEY), saved);
});

test('corrupt or invalid storage safely defaults', () => {
    for (const raw of ['{bad', '{}', '{"version":2,"jetpackOwned":true}', '{"version":1,"jetpackOwned":1}']) {
        assert.deepEqual(readFreeRoamProgress(storage(raw)), { version: 1, jetpackOwned: false });
    }
});

test('write failure propagates', () => {
    const error = new Error('quota');
    const failing = { getItem: () => null, setItem: () => { throw error; } };
    assert.throws(() => purchaseJetpack(failing), error);
});
