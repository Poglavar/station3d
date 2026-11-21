// Verifies FPS-overlay background counters aggregate and disappear when done.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getBackgroundActivitySnapshot,
    registerBackgroundActivityReader,
} from '../core/background-activity.js';

test('aggregates active work by kind and label and omits completed work', () => {
    const unregisterA = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'roads',
        pending: 3,
    }));
    const unregisterB = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'roads',
        pending: 2,
    }));
    const unregisterDone = registerBackgroundActivityReader(() => ({
        kind: 'load',
        label: 'buildings',
        pending: 0,
    }));

    try {
        assert.deepEqual(getBackgroundActivitySnapshot(), [
            {
                kind: 'build',
                label: 'roads',
                pending: 5,
                jobs: 0,
                loaded: 0,
                fetching: 0,
                building: 0,
                retrying: 0,
                fetchFailed: 0,
                buildFailed: 0,
                failed: 0,
            },
        ]);
    } finally {
        unregisterA();
        unregisterB();
        unregisterDone();
    }
    assert.deepEqual(getBackgroundActivitySnapshot(), []);
});

test('hides idle streams by default and includes them only for cache diagnostics', () => {
    const unregisterHealthy = registerBackgroundActivityReader(() => ({
        kind: 'stream',
        label: 'roads',
        loaded: 9,
    }));
    const unregisterFailed = registerBackgroundActivityReader(() => ({
        kind: 'stream',
        label: 'buildings',
        loaded: 4,
        pending: 1,
        retrying: 1,
        buildFailed: 1,
    }));

    try {
        const snapshot = getBackgroundActivitySnapshot();
        assert.equal(snapshot[0].label, 'buildings');
        assert.equal(snapshot[0].buildFailed, 1);
        assert.equal(snapshot[0].retrying, 1);
        assert.equal(snapshot.length, 1);

        const withIdle = getBackgroundActivitySnapshot({ includeIdle: true });
        assert.equal(withIdle[1].label, 'roads');
        assert.equal(withIdle[1].loaded, 9);
    } finally {
        unregisterHealthy();
        unregisterFailed();
    }
});

test('aggregates pending items and jobs separately', () => {
    const unregisterA = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'curbs',
        pending: 4,
        jobs: 1,
    }));
    const unregisterB = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'curbs',
        pending: 2,
        jobs: 1,
    }));
    try {
        const [curbs] = getBackgroundActivitySnapshot();
        assert.equal(curbs.pending, 6);
        assert.equal(curbs.jobs, 2);
    } finally {
        unregisterA();
        unregisterB();
    }
});

test('preserves visibility detail and the oldest visible wait for diagnostics', () => {
    const unregisterA = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'buildings',
        pending: 4,
        visible: 2,
        hidden: 2,
        oldestVisibleWaitMs: 900,
    }));
    const unregisterB = registerBackgroundActivityReader(() => ({
        kind: 'build',
        label: 'buildings',
        pending: 3,
        support: 1,
        peripheral: 2,
        oldestVisibleWaitMs: 1400,
    }));
    try {
        const [buildings] = getBackgroundActivitySnapshot();
        assert.equal(buildings.pending, 7);
        assert.equal(buildings.visible, 2);
        assert.equal(buildings.support, 1);
        assert.equal(buildings.peripheral, 2);
        assert.equal(buildings.hidden, 2);
        assert.equal(buildings.oldestVisibleWaitMs, 1400);
    } finally {
        unregisterA();
        unregisterB();
    }
});

test('preserves surface publication ownership diagnostics', () => {
    const unregister = registerBackgroundActivityReader(() => ({
        kind: 'layer',
        label: 'surface publications',
        pending: 2,
        activeOwners: 14,
        staleRejected: 3,
        conflicts: 1,
        missingClaims: 2,
        invalidClaims: 1,
    }));
    try {
        const [entry] = getBackgroundActivitySnapshot();
        assert.equal(entry.activeOwners, 14);
        assert.equal(entry.staleRejected, 3);
        assert.equal(entry.conflicts, 1);
        assert.equal(entry.missingClaims, 2);
        assert.equal(entry.invalidClaims, 1);
    } finally {
        unregister();
    }
});

test('keeps active surface owners visible after publication work settles', () => {
    const unregister = registerBackgroundActivityReader(() => ({
        kind: 'layer',
        label: 'surface publications',
        pending: 0,
        activeOwners: 9,
    }));
    try {
        const [entry] = getBackgroundActivitySnapshot();
        assert.equal(entry.label, 'surface publications');
        assert.equal(entry.pending, 0);
        assert.equal(entry.activeOwners, 9);
    } finally {
        unregister();
    }
});
