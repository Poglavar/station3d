// Verifies cooperative build staging, cancellation, and atomic publication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooperativeBuildTask } from '../core/cooperative-build-task.js';

test('publishes only after every yielded stage and a separate commit step', () => {
    const events = [];
    let clock = 0;
    function* build() {
        clock += 2;
        yield { phase: 'geometry' };
        clock += 3;
        yield { phase: 'facades' };
        clock += 1;
        return { meshes: 4 };
    }
    const task = createCooperativeBuildTask({
        iterator: build,
        now: () => clock,
        publish: artifact => {
            events.push(`publish:${artifact.meshes}`);
            clock += 1;
            return artifact.meshes;
        },
        discard: () => events.push('discard'),
        onPhase: ({ phase, ms }) => events.push(`${phase}:${ms}`),
    });

    assert.equal(task.step().done, false);
    assert.equal(task.step().done, false);
    assert.equal(task.step().readyToPublish, true);
    assert.equal(events.some(event => event.startsWith('publish:')), false);
    assert.deepEqual(task.step(), {
        done: true,
        cancelled: false,
        result: 4,
        phase: 'publish',
    });
    assert.deepEqual(events, [
        'geometry:2',
        'facades:3',
        'ready-to-publish:1',
        'publish:4',
        'publish:1',
    ]);
});

test('cancellation runs iterator cleanup and discards without publication', () => {
    const events = [];
    function* build() {
        try {
            yield { phase: 'geometry' };
            return { mesh: true };
        } finally {
            events.push('iterator-cleanup');
        }
    }
    const task = createCooperativeBuildTask({
        iterator: build,
        publish: () => events.push('publish'),
        discard: () => events.push('discard'),
    });

    task.step();
    task.cancel('tile-evicted');
    task.cancel('duplicate-cancel');
    assert.deepEqual(events, ['iterator-cleanup', 'discard']);
    assert.deepEqual(task.snapshot(), {
        done: true,
        cancelled: true,
        readyToPublish: false,
        discarded: true,
        result: undefined,
    });
});

test('a failed stage discards once and rethrows the original error', () => {
    const events = [];
    function* build() {
        yield { phase: 'geometry' };
        throw new Error('bad facade');
    }
    const task = createCooperativeBuildTask({
        iterator: build,
        discard: (_value, error) => events.push(error.message),
    });
    task.step();
    assert.throws(() => task.step(), /bad facade/);
    task.cancel();
    assert.deepEqual(events, ['bad facade']);
});
