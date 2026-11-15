// A ground generation reuses the published rail construction only when none of
// its changes can move it: road and curb deliveries and window moves cannot;
// terrain, rail sources, the planner and stations can.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reusesPublishedRailConstruction } from '../core/ground-generation-scope.js';

const change = family => ({ family, bounds: [], keys: [], full: false });
const reuses = (families, receiversActive = true) => reusesPublishedRailConstruction(
    families.map(change), { receiversActive });

test('road, curb and window changes reuse the published rail construction', () => {
    for (const families of [['roads'], ['curbs'], ['roads', 'curbs'], ['ground-window'], ['terrain-window', 'roads']]) {
        assert.equal(reuses(families), true, families.join('+'));
    }
});

test('a terrain change rebuilds the rails, alone or coalesced with road changes', () => {
    // Finer terrain arriving under a line built on the coarse grid must reach
    // its formation, or the line keeps cut walls the ground no longer has.
    for (const families of [['terrain'], ['terrain', 'roads'], ['curbs', 'terrain']]) {
        assert.equal(reuses(families), false, families.join('+'));
    }
});

test('rail, planner, station and bootstrap changes rebuild the rails', () => {
    for (const family of ['rails', 'planner', 'stations', 'bootstrap']) {
        assert.equal(reuses(['roads', family]), false, family);
    }
});

test('nothing is reused before a construction is published, or without changes', () => {
    assert.equal(reuses(['roads'], false), false);
    assert.equal(reuses([]), false);
});
