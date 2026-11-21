// Contract tests for decor readiness without clocks, polling, DOM, or renderer state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecorAssetReadiness } from '../core/decor-asset-readiness.js';

const kinds = ['greenery', 'trees', 'hedges'];

test('latest ticket wins and stale completion cannot change state', () => {
    const readiness = createDecorAssetReadiness(kinds);
    const oldTicket = readiness.begin('greenery');
    const currentTicket = readiness.begin('greenery');
    assert.equal(readiness.complete(oldTicket), false);
    assert.equal(readiness.snapshot().pending, 1);
    assert.equal(readiness.complete(currentTicket), true);
    assert.equal(readiness.snapshot().published, 1);
});

test('tickets are one shot after publication or failure', () => {
    const readiness = createDecorAssetReadiness(kinds);
    const published = readiness.begin('greenery');
    assert.equal(readiness.complete(published), true);
    assert.equal(readiness.complete(published, { empty: true }), false);
    assert.equal(readiness.fail(published, 'late failure'), false);
    const failed = readiness.begin('trees');
    assert.equal(readiness.fail(failed, 'fetch failed'), true);
    assert.equal(readiness.complete(failed), false);
    assert.equal(readiness.snapshot().published, 1);
    assert.equal(readiness.snapshot().failed, 1);
});

test('empty is valid and a stale failure after a successor is ignored', () => {
    const readiness = createDecorAssetReadiness(kinds);
    const oldTicket = readiness.begin('greenery');
    const successor = readiness.begin('greenery');
    assert.equal(readiness.fail(oldTicket, 'stale'), false);
    assert.equal(readiness.complete(successor, { empty: true }), true);
    assert.equal(readiness.snapshot().empty, 1);
    assert.equal(readiness.snapshot().failed, 0);
});

test('successor replaces failed state', () => {
    const readiness = createDecorAssetReadiness(kinds);
    const failed = readiness.begin('greenery');
    readiness.fail(failed, 'old');
    const successor = readiness.begin('greenery');
    assert.equal(readiness.snapshot().failed, 0);
    assert.equal(readiness.complete(successor), true);
    assert.equal(readiness.snapshot().published, 1);
});

test('reset invalidates old tickets and snapshots are deeply immutable', () => {
    const readiness = createDecorAssetReadiness(kinds);
    const ticket = readiness.begin('trees');
    readiness.complete(ticket);
    const snapshot = readiness.snapshot();
    assert.throws(() => snapshot.assets.push({}), /object is not extensible/);
    assert.throws(() => { snapshot.assets[0].status = 'failed'; }, /read only|Cannot assign/);
    readiness.reset();
    assert.equal(readiness.complete(ticket), false);
    assert.deepEqual(readiness.snapshot(), {
        expected: 0, pending: 0, published: 0, empty: 0, failed: 0, assets: [],
    });
});

test('fixed kind bound rejects unknown and malformed lists', () => {
    assert.throws(() => createDecorAssetReadiness(['trees', 'trees']), /unique/);
    assert.throws(() => createDecorAssetReadiness(['trees', 3]), /finite/);
    const readiness = createDecorAssetReadiness(kinds);
    assert.throws(() => readiness.begin('parking'), /Unknown/);
});
