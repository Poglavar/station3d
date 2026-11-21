// Verifies dense geometry buffers are appended without invoking JavaScript's
// bounded function-argument/spread path, including the building AO wiring.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { appendArrayValues } from '../core/array-append.js';

test('large typed geometry buffers append completely and in order', () => {
    const source = new Float32Array(250_000);
    for (let index = 0; index < source.length; index++) source[index] = index;
    const target = [-1];
    const result = appendArrayValues(target, source);
    assert.equal(result, target);
    assert.equal(target.length, source.length + 1);
    assert.equal(target[0], -1);
    assert.equal(target[1], 0);
    assert.equal(target.at(-1), source.length - 1);
});

test('building contact shadows use bounded typed-array assembly', async () => {
    const source = await readFile(new URL('../core/contact-ao-batch.js', import.meta.url), 'utf8');
    assert.match(source, /const positions = new Float32Array\(capacityVertices \* 3\)/);
    assert.match(source, /copiedSinceYield >= vertexLimit/);
    assert.doesNotMatch(source, /\.push\(\.\.\./);
});

test('rail collars use pre-sized typed buffers instead of a spread append', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    const start = source.indexOf('function* addRailFormationTerrainCollarsSteps(');
    const end = source.indexOf('\nfunction ', start + 1);
    const body = source.slice(start, end);

    assert.ok(start > 0, 'rails.js no longer declares addRailFormationTerrainCollarsSteps');
    assert.match(body, /const positions = new Float32Array\(positionCount\)/);
    assert.match(body, /positions\[positionOffset \+ index\] = positionChunk\[index\]/);
    assert.doesNotMatch(
        body,
        /\.push\(\.\.\./,
        'a spread here overflows on nationwide rail collar geometry',
    );
});
