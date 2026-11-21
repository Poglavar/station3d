// A streamed dependent layer may publish only after every aggregate bucket
// containing its source tile has actually been assembled.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTilePublicationTracker } from '../core/tile-publication-tracker.js';

test('releases a tile only after all of its aggregate buckets publish', () => {
    const tracker = createTilePublicationTracker();
    const released = [];
    tracker.whenReady('0_0', tileKey => released.push(tileKey));
    tracker.awaitBuckets('0_0', ['surface:a', 'surface:b']);

    tracker.markBucketReady('surface:a');
    assert.equal(tracker.isReady('0_0'), false);
    assert.deepEqual(released, []);

    tracker.markBucketReady('surface:b');
    assert.equal(tracker.isReady('0_0'), true);
    assert.deepEqual(released, ['0_0']);
});

test('an empty or already-deduplicated tile is ready immediately', () => {
    const tracker = createTilePublicationTracker();
    tracker.awaitBuckets('1_2', []);
    assert.equal(tracker.isReady('1_2'), true);
});

test('forget removes readiness, pending buckets and listeners', () => {
    const tracker = createTilePublicationTracker();
    let released = 0;
    tracker.whenReady('2_3', () => { released += 1; });
    tracker.awaitBuckets('2_3', ['surface:c']);
    tracker.forget('2_3');
    tracker.markBucketReady('surface:c');

    assert.equal(tracker.isReady('2_3'), false);
    assert.equal(released, 0);
});

test('once visible, a tile stays ready while successor geometry rebuilds', () => {
    const tracker = createTilePublicationTracker();
    tracker.awaitBuckets('4_5', []);
    assert.equal(tracker.isCurrent('4_5'), true);
    tracker.awaitBuckets('4_5', ['surface:replacement']);
    assert.equal(tracker.isReady('4_5'), true);
    assert.equal(tracker.isCurrent('4_5'), false,
        'first-ready stays visible, but the final-generation gate re-closes');
    tracker.markBucketReady('surface:replacement');
    assert.equal(tracker.isCurrent('4_5'), true);
});

test('a scheduled successor is non-current before it reaches aggregate assembly', () => {
    const tracker = createTilePublicationTracker();
    tracker.awaitBuckets('6_7', []);
    tracker.markPending('6_7');
    assert.equal(tracker.isReady('6_7'), true);
    assert.equal(tracker.isCurrent('6_7'), false);
    tracker.awaitBuckets('6_7', []);
    assert.equal(tracker.isCurrent('6_7'), true);
});
