// Pins the rail deck's snug overlap with adjoining embankment formation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extendViaductDeckSamples } from '../core/rail-viaduct-deck.js';

test('extends only real run ends and preserves the rail grade', () => {
    const samples = [
        { station: 10, x: 0, z: 0, railY: 2 },
        { station: 20, x: 10, z: 0, railY: 3 },
        { station: 30, x: 20, z: 0, railY: 4 },
    ];
    const extended = extendViaductDeckSamples(samples, { samples }, 1.5);
    assert.deepEqual(extended[0], {
        station: 8.5,
        x: -1.5,
        z: 0,
        railY: 1.85,
    });
    assert.deepEqual(extended.at(-1), {
        station: 31.5,
        x: 21.5,
        z: 0,
        railY: 4.15,
    });
    assert.equal(extended[1], samples[0]);
    assert.equal(extended.at(-2), samples.at(-1));
});

test('does not extend a slice boundary created only by the render window', () => {
    const samples = [
        { station: 0, x: 0, z: 0, railY: 0 },
        { station: 10, x: 10, z: 0, railY: 0 },
        { station: 20, x: 20, z: 0, railY: 0 },
        { station: 30, x: 30, z: 0, railY: 0 },
    ];
    const slice = samples.slice(1, 3);
    assert.deepEqual(extendViaductDeckSamples(slice, { samples }, 1.5), slice);
});
