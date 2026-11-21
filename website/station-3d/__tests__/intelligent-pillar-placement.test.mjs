import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pointAtPlacedSupport,
    resolveIntelligentPillarSamples,
} from '../core/intelligent-pillar-placement.js';

const samples = (count = 5) => Array.from({ length: count }, (_, index) => ({
    x: index * 30,
    z: 0,
    s: index * 30,
    ux: 1,
    uz: 0,
}));

test('keeps clear supports and slides a blocked support along the alignment', () => {
    const result = resolveIntelligentPillarSamples(
        samples(3),
        (x) => (x >= 28 && x <= 34 ? -1 : 1),
    );
    assert.equal(result.length, 3);
    assert.equal(result[1].placement, 'slid');
    assert.ok(result[1].x < 28 || result[1].x > 34);
});

test('skips an obstructed support when the resulting span remains plausible', () => {
    const result = resolveIntelligentPillarSamples(
        samples(5),
        (x) => (x > 20 && x < 70 ? -1 : 1),
        { slideMaxM: 4, maxSpanM: 95 },
    );
    assert.deepEqual(result.map(item => item.sourceIndex), [0, 3, 4]);
    assert.equal(result[1].s - result[0].s, 90);
});

test('forces the least-bad candidate when skipping would exceed maximum span', () => {
    const result = resolveIntelligentPillarSamples(
        samples(5),
        (x) => (x > 20 && x < 100 ? -(100 - x) : 1),
        { slideMaxM: 4, maxSpanM: 50 },
    );
    assert.ok(result.some(item => item.placement === 'forced'));
});

test('support-local cap geometry follows a slid shaft instead of its nominal point closure', () => {
    const placed = {
        x: 42,
        y: 8,
        z: 12,
        nx: 0,
        nz: 1,
        point: () => ({ x: 30, y: 8, z: 12 }),
    };

    assert.deepEqual(
        pointAtPlacedSupport(placed, 3, 7.5),
        { x: 42, y: 7.5, z: 15 },
    );
});
