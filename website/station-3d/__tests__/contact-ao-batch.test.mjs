import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assembleContactAoBatch,
    createRevisionGuardedContactAoTask,
} from '../core/contact-ao-batch.js';
import { createCooperativeBuildTask } from '../core/cooperative-build-task.js';

function contribution(id, vertexCount, baseY = 0) {
    const positions = [];
    const colors = [];
    for (let index = 0; index < vertexCount; index++) {
        positions.push(id * 100 + index, index, -index);
        colors.push(0, 0, 0, 0.32);
    }
    return {
        id,
        positions,
        colors,
        baseY,
        centroidLatLon: { lat: id, lon: -id },
    };
}

test('contact AO assembly bounds every copy step and preserves entry ranges', () => {
    const iterator = assembleContactAoBatch([
        contribution(1, 7, 10),
        contribution(2, 9, -2),
        contribution(3, 4, 3),
    ], {
        countPerStep: 2,
        verticesPerStep: 5,
    });
    const yielded = [];
    let outcome = iterator.next();
    while (!outcome.done) {
        yielded.push(outcome.value);
        outcome = iterator.next();
    }

    assert.ok(yielded.filter(step => step.phase === 'contact-ao-copy').length > 1);
    assert.ok(yielded
        .filter(step => step.phase === 'contact-ao-copy')
        .every(step => step.vertices <= 5));
    assert.equal(outcome.value.positions.length, 20 * 3);
    assert.equal(outcome.value.colors.length, 20 * 4);
    assert.deepEqual(outcome.value.entries.map(entry => [entry.start, entry.count]), [
        [0, 7], [7, 9], [16, 4],
    ]);
    assert.equal(outcome.value.positions[1], 10);
    assert.equal(outcome.value.positions[7 * 3 + 1], -2);
});

test('contact AO rechecks a late proposal mask without publishing its alpha', () => {
    const contributions = [contribution(1, 3), contribution(2, 4)];
    const excluded = new Set();
    const iterator = assembleContactAoBatch(contributions, {
        include: item => !excluded.has(item.id),
        countPerStep: 1,
        verticesPerStep: 3,
    });
    let outcome = iterator.next();
    while (!outcome.done && outcome.value.phase !== 'contact-ao-copy') {
        outcome = iterator.next();
    }
    excluded.add(1);
    while (!outcome.done) outcome = iterator.next();

    assert.deepEqual(outcome.value.entries.map(entry => entry.centroidLatLon.lat), [2]);
    assert.deepEqual(
        Array.from(outcome.value.colors.slice(0, 3 * 4)).filter((_value, index) => index % 4 === 3),
        [0, 0, 0],
    );
});

test('contact AO restarts if the mask changes between bounded recheck chunks', () => {
    const contributions = [contribution(1, 3), contribution(2, 4)];
    const excluded = new Set();
    const published = [];
    const cancelled = [];
    let maskRevision = 0;
    let taskCount = 0;
    const guarded = createRevisionGuardedContactAoTask({
        getMaskRevision: () => maskRevision,
        createTask: () => {
            taskCount += 1;
            return createCooperativeBuildTask({
                iterator: () => assembleContactAoBatch(contributions, {
                    include: item => !excluded.has(item.id),
                    countPerStep: 1,
                    verticesPerStep: 16,
                }),
                publish: staged => {
                    published.push(staged);
                    return staged;
                },
                discard: (_staged, reason) => cancelled.push(reason),
            });
        },
    });

    let outcome = guarded.step();
    while (outcome.phase !== 'contact-ao-mask-recheck') outcome = guarded.step();
    excluded.add(1);
    maskRevision += 1;
    while (!outcome.done) outcome = guarded.step();

    assert.equal(taskCount, 2, 'the partially rechecked generation was replaced');
    assert.deepEqual(cancelled, ['proposal-mask-changed-before-contact-ao-publication']);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].entries.map(entry => entry.centroidLatLon.lat), [2]);
});
