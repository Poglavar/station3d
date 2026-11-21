// The local-bird contract: which cities have one, how sporadic the calls are,
// and that no two calls need sound the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BIRD_CALL_FIRST_GAP_RANGE_S,
    BIRD_CALL_GAP_RANGE_S,
    BIRD_CALL_GAIN_RANGE,
    birdCallVariant,
    birdForLocation,
    nextBirdCallDelayS,
} from '../core/ambient-bird-calls.js';
import { LOCATIONS } from '../core/locations.js';

test('the three configured cities carry their bird; everything else stays silent', () => {
    assert.equal(birdForLocation(LOCATIONS.zagreb), 'crow');
    assert.equal(birdForLocation(LOCATIONS.split), 'seagull');
    assert.equal(birdForLocation(LOCATIONS['sjeverna-dalmacija']), 'seagull');
    assert.equal(birdForLocation(LOCATIONS['zagreb-split']), null);
    assert.equal(birdForLocation(null), null);
    assert.equal(birdForLocation({ localBird: '  ' }), null);
});

test('calls are minutes apart, with a sooner first call', () => {
    assert.equal(nextBirdCallDelayS(() => 0, { first: true }), BIRD_CALL_FIRST_GAP_RANGE_S[0]);
    assert.equal(nextBirdCallDelayS(() => 1), BIRD_CALL_GAP_RANGE_S[1]);
    assert.ok(BIRD_CALL_FIRST_GAP_RANGE_S[1] < BIRD_CALL_GAP_RANGE_S[0],
        'the first call must be sooner than any steady-state gap');
    assert.ok(BIRD_CALL_GAP_RANGE_S[0] >= 100, 'sporadic means minutes, not seconds');
});

test('every call varies: clip, loudness, pitch and side all draw from the random source', () => {
    const seeded = (values) => { let i = 0; return () => values[i++ % values.length]; };
    const loud = birdCallVariant(seeded([0.99]), 3);
    const faint = birdCallVariant(seeded([0.01]), 3);
    assert.ok(loud.gain > faint.gain, 'intensity varies');
    assert.ok(loud.gain <= BIRD_CALL_GAIN_RANGE[1] && faint.gain >= BIRD_CALL_GAIN_RANGE[0]);
    assert.ok(faint.gain < (BIRD_CALL_GAIN_RANGE[0] + BIRD_CALL_GAIN_RANGE[1]) / 2,
        'a low draw is a distant bird');
    assert.notEqual(loud.playbackRate, faint.playbackRate, 'pitch jitters');
    assert.ok(Math.abs(loud.pan) <= 1 && Math.abs(faint.pan) <= 1);
    // Clip choice spans the whole set and never overruns it.
    const indices = new Set();
    for (let i = 0; i < 200; i++) indices.add(birdCallVariant(Math.random, 3).clipIndex);
    assert.deepEqual([...indices].sort(), [0, 1, 2]);
    assert.equal(birdCallVariant(() => 0.999, 1).clipIndex, 0);
});
