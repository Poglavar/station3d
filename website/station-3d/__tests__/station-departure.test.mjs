// Covers station countdown presentation and automatic door timing without a
// browser or an independent test clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS,
    normalizeDwellRemainingSeconds,
    shouldAutomaticDoorsRemainOpen,
    stationDeparturePresentation,
} from '../core/station-departure.js';

test('normalizes only finite non-negative dwell values', () => {
    assert.equal(normalizeDwellRemainingSeconds(4.25), 4.25);
    assert.equal(normalizeDwellRemainingSeconds(-2), 0);
    assert.equal(normalizeDwellRemainingSeconds(null), null);
    assert.equal(normalizeDwellRemainingSeconds('not-a-clock'), null);
});

test('countdown is a rounded view of the authoritative fractional dwell', () => {
    assert.deepEqual(stationDeparturePresentation({
        paused: true,
        departureAutomatic: true,
        dwellRemainingS: 4.01,
    }), { kind: 'countdown', seconds: 5 });
    assert.deepEqual(stationDeparturePresentation({
        paused: true,
        departureAutomatic: true,
        dwellRemainingS: 4,
    }), { kind: 'countdown', seconds: 4 });
});

test('expired automatic dwell exposes door delay instead of a false timer', () => {
    assert.deepEqual(stationDeparturePresentation({
        paused: true,
        departureAutomatic: true,
        departureBlockedByDoors: true,
        dwellRemainingS: 0,
    }), { kind: 'waiting-doors' });
    assert.deepEqual(stationDeparturePresentation({
        paused: true,
        departureAutomatic: true,
        departureBlockedByDoors: false,
        dwellRemainingS: 0,
    }), { kind: 'departing' });
});

test('manual station stop never claims an automatic departure time', () => {
    assert.deepEqual(stationDeparturePresentation({
        paused: true,
        departureAutomatic: false,
    }), { kind: 'manual' });
    assert.equal(stationDeparturePresentation({ paused: false }), null);
});

test('automatic doors close during the final dwell lead time', () => {
    assert.equal(shouldAutomaticDoorsRemainOpen({
        paused: true,
        dwellRemainingS: AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS + 0.01,
    }), true);
    assert.equal(shouldAutomaticDoorsRemainOpen({
        paused: true,
        dwellRemainingS: AUTOMATIC_DOOR_CLOSE_LEAD_SECONDS,
    }), false);
    assert.equal(shouldAutomaticDoorsRemainOpen({ paused: true }), true);
    assert.equal(shouldAutomaticDoorsRemainOpen({
        paused: false,
        dwellRemainingS: 10,
    }), false);
});
