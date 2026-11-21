import test from 'node:test';
import assert from 'node:assert/strict';

import {
    streamedRailChangedNearObserver,
    streamedRailObserverTilesSettled,
    streamedRailRefreshDue,
} from '../core/streamed-rail-refresh.js';

const policy = {
    quietMs: 250,
    minIntervalMs: 1_000,
    firstPreviewMs: 350,
    maxDeferredMs: 5_000,
};

test('waits for the observer ring before showing the first streamed rail set', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 100,
        lastChangeMs: 100,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: false,
        policy,
    }), false);
    assert.equal(streamedRailRefreshDue({
        nowMs: 100,
        lastChangeMs: 100,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: true,
        policy,
    }), true);
});

test('first rail snapshot fails soft when a local tile never settles', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 5_100,
        lastChangeMs: 100,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: false,
        policy,
    }), true);
});

test('publishes a centre-tile rail preview before the complete support ring', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 449,
        lastChangeMs: 120,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: false,
        initialPreviewReady: true,
        policy,
    }), false);
    assert.equal(streamedRailRefreshDue({
        nowMs: 450,
        lastChangeMs: 120,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: false,
        initialPreviewReady: true,
        policy,
    }), true);
});

test('does not publish a preview before the observer tile itself arrives', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 1_000,
        lastChangeMs: 120,
        dirtySinceMs: 100,
        lastAppliedMs: Number.NaN,
        hasRenderedFeatures: false,
        settledForObserver: false,
        initialPreviewReady: false,
        policy,
    }), false);
});

test('observer settlement counts delivered empty tiles and ignores the far corridor', () => {
    const delivered = new Set();
    for (let tz = -1; tz <= 1; tz += 1) {
        for (let tx = -1; tx <= 1; tx += 1) delivered.add(`${tx}_${tz}`);
    }
    assert.equal(streamedRailObserverTilesSettled(delivered, 20, 30), true);
    delivered.delete('1_1');
    delivered.add('12_12');
    assert.equal(streamedRailObserverTilesSettled(delivered, 20, 30), false);
});

test('only changed rail tiles in the current observer ring unlock a local refresh', () => {
    const changed = new Set(['8_8', '-2_0']);
    assert.equal(streamedRailChangedNearObserver(changed, 20, 30), false);
    changed.add('1_0');
    assert.equal(streamedRailChangedNearObserver(changed, 20, 30), true);
});

test('coalesces adjacent tile deliveries until quiet and rate-limited', () => {
    const state = {
        lastChangeMs: 900,
        dirtySinceMs: 500,
        lastAppliedMs: 400,
        hasRenderedFeatures: true,
        policy,
    };
    assert.equal(streamedRailRefreshDue({ nowMs: 1_000, ...state }), false);
    assert.equal(streamedRailRefreshDue({ nowMs: 1_200, ...state }), false);
    assert.equal(streamedRailRefreshDue({ nowMs: 1_400, ...state }), true);
});

test('stationary loading does not repeatedly rebuild a rendered rail snapshot', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 5_500,
        lastChangeMs: 5_490,
        dirtySinceMs: 500,
        lastAppliedMs: 5_100,
        hasRenderedFeatures: true,
        settledForObserver: false,
        policy,
    }), false);
});

test('a drained source releases the final refresh outside a complete observer ring', () => {
    const snapshot = {
        nowMs: 5_500,
        lastChangeMs: 4_000,
        dirtySinceMs: 500,
        lastAppliedMs: 3_000,
        hasRenderedFeatures: true,
        settledForObserver: false,
        policy,
    };
    assert.equal(streamedRailRefreshDue({ ...snapshot, sourceSettled: false }), false);
    assert.equal(streamedRailRefreshDue({ ...snapshot, sourceSettled: true }), true);
});

test('movement keeps continuously loading rails from being postponed indefinitely', () => {
    assert.equal(streamedRailRefreshDue({
        nowMs: 5_500,
        lastChangeMs: 5_490,
        dirtySinceMs: 500,
        lastAppliedMs: 5_100,
        hasRenderedFeatures: true,
        settledForObserver: false,
        observerMovedEnough: true,
        policy,
    }), true);
});
