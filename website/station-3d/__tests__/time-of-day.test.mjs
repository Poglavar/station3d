// The ?time= sky-hour override: valid forms pin the hour, anything else is
// "no override" so the sky falls back to the real clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeOfDayOverride } from '../core/time-of-day.js';

test('accepts whole, decimal, and clock-style hours', () => {
    assert.equal(parseTimeOfDayOverride('?time=14'), 14);
    assert.equal(parseTimeOfDayOverride('?time=0'), 0);
    assert.equal(parseTimeOfDayOverride('?time=14.5'), 14.5);
    assert.equal(parseTimeOfDayOverride('?time=14:30'), 14.5);
    assert.equal(parseTimeOfDayOverride('?loc=zagreb&time=6:45&elevation=1'), 6.75);
});

test('rejects garbage, out-of-range, and absent values', () => {
    assert.equal(parseTimeOfDayOverride('?time=24'), null);
    assert.equal(parseTimeOfDayOverride('?time=-1'), null);
    assert.equal(parseTimeOfDayOverride('?time=13:60'), null);
    assert.equal(parseTimeOfDayOverride('?time=noon'), null);
    assert.equal(parseTimeOfDayOverride('?time='), null);
    assert.equal(parseTimeOfDayOverride('?loc=zagreb'), null);
    assert.equal(parseTimeOfDayOverride(''), null);
    assert.equal(parseTimeOfDayOverride(undefined), null);
});
