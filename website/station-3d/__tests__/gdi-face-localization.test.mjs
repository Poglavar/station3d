import test from 'node:test';
import assert from 'node:assert/strict';

import {
    localizeGdiFace,
    localizeGdiFaceCooperative,
} from '../core/gdi-face-localization.js';

test('GDI face localization preserves exact open/closed-ring coordinates and fallback height', () => {
    const open = [[
        [15, 45, 120],
        [16, 45, null],
        [16, 44, 123],
    ]];
    const closed = [[...open[0], open[0][0]]];
    const expected = [
        [0, 20, -0],
        [10, 0, -0],
        [10, 23, 20],
    ];
    assert.deepEqual(localizeGdiFace(open, 100, 45, 15, 10, 20), expected);
    assert.deepEqual(localizeGdiFace(closed, 100, 45, 15, 10, 20), expected);
});

test('a dense immutable face localizes over bounded stages with identical output', () => {
    const ring = [];
    for (let index = 0; index < 18; index++) {
        ring.push([15 + index * 0.001, 45 - index * 0.002, 100 + index]);
    }
    ring.push(ring[0]);
    const polygon = [ring];
    const expected = localizeGdiFace(polygon, 100, 45, 15, 100, 200);
    const iterator = localizeGdiFaceCooperative(
        polygon,
        100,
        45,
        15,
        100,
        200,
        { verticesPerStage: 4 },
    );
    const phases = [];
    let next = iterator.next();
    while (!next.done) {
        phases.push(next.value);
        next = iterator.next();
    }
    assert.deepEqual(next.value, expected);
    assert.deepEqual(phases.map(phase => phase.completed), [4, 8, 12, 16]);
    assert.ok(phases.every(phase => phase.total === 18));
});
