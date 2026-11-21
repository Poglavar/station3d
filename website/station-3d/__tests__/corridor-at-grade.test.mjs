// Tests for the pure corridor-segment collection: which spans of an
// elevation-aware polyline earn photoreal earthworks, and the elevation each
// kept segment carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAtGradeCorridor, collectFullCorridor } from '../core/corridor-at-grade.js';

const EPS = 0.5;

test('flat 2D polyline passes through unchanged (missing elev counts as 0)', () => {
    const pts = [[0, 0], [100, 0], [200, 50]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.deepEqual(segs, [[0, 0, 100, 0, 0, 0], [100, 0, 200, 50, 0, 0]]);
    assert.deepEqual(discCenters, [[0, 0, 0], [100, 0, 0], [200, 50, 0]]);
});

test('explicit zero and NaN elevations count as at grade', () => {
    const pts = [[0, 0, 0], [100, 0, NaN], [200, 0, undefined]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.equal(segs.length, 2);
    assert.equal(discCenters.length, 3);
});

test('+10 m elevated span is dropped', () => {
    const pts = [[0, 0, 0], [100, 0, 10], [200, 0, 10], [300, 0, 0]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.deepEqual(segs, []);
    assert.deepEqual(discCenters, [[0, 0, 0], [300, 0, 0]]);
});

test('-10 m underground span is dropped (eps is symmetric)', () => {
    const pts = [[0, 0, -10], [100, 0, -10]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.deepEqual(segs, []);
    assert.deepEqual(discCenters, []);
});

test('ramp chord straddling eps is dropped, at-grade tail kept with its elevations', () => {
    // 0 -> 0.4 kept (both within eps); 0.4 -> 5 dropped; 5 -> 10 dropped
    const pts = [[0, 0, 0], [100, 0, 0.4], [200, 0, 5], [300, 0, 10]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.deepEqual(segs, [[0, 0, 100, 0, 0, 0.4]]);
    assert.deepEqual(discCenters, [[0, 0, 0], [100, 0, 0.4]]);
});

test('elevation exactly at eps still counts as at grade', () => {
    const pts = [[0, 0, 0.5], [100, 0, -0.5]];
    const { segs } = collectAtGradeCorridor(pts, EPS);
    assert.equal(segs.length, 1);
});

test('fully elevated line yields empty output', () => {
    const pts = [[0, 0, 10], [100, 0, 10], [200, 0, 10]];
    const { segs, discCenters } = collectAtGradeCorridor(pts, EPS);
    assert.deepEqual(segs, []);
    assert.deepEqual(discCenters, []);
});

test('non-array input yields empty output', () => {
    const atGrade = collectAtGradeCorridor(null, EPS);
    assert.deepEqual(atGrade, { segs: [], discCenters: [] });
    assert.deepEqual(collectFullCorridor(null), { segs: [], discCenters: [] });
});

test('collectFullCorridor keeps every segment with its endpoint elevations', () => {
    const pts = [[0, 0, 120], [100, 0, 130.5], [200, 50, 95]];
    const { segs, discCenters } = collectFullCorridor(pts);
    assert.deepEqual(segs, [
        [0, 0, 100, 0, 120, 130.5],
        [100, 0, 200, 50, 130.5, 95],
    ]);
    assert.deepEqual(discCenters, [[0, 0, 120], [100, 0, 130.5], [200, 50, 95]]);
});
