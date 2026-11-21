import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M,
    HEAVY_RAIL_SLEEPER_LENGTH_M,
    HEAVY_RAIL_SLEEPER_SPACING_M,
    heavyRailDistantSleeperMask,
    isHeavyRailSegment,
    planHeavyRailSleepers,
} from '../core/heavy-rail-dressing.js';

test('far ballast sleeper bands keep the same four-tie phase as 3D sleepers', () => {
    assert.equal(HEAVY_RAIL_DISTANT_SLEEPER_TILE_LENGTH_M, 2.6);
    for (const center of [0.125, 0.375, 0.625, 0.875]) {
        assert.ok(heavyRailDistantSleeperMask(center, 0) > 0.99);
    }
    assert.equal(heavyRailDistantSleeperMask(0, 0), 0);
    assert.equal(heavyRailDistantSleeperMask(0.25, 0), 0);
    assert.equal(heavyRailDistantSleeperMask(0.125, 0.49), 0);
});

function segment(overrides = {}) {
    return {
        x1: 0,
        yStart: 2,
        z1: 0,
        x2: 10,
        yEnd: 3,
        z2: 0,
        px: 0,
        pz: -1,
        angle: Math.PI / 2,
        len: 10,
        uStart: 0,
        startTrackCenterOffsetsM: [0],
        endTrackCenterOffsetsM: [0],
        properties: { railway_type: 'rail', gauge: '1435' },
        ...overrides,
    };
}

test('only heavy rail receives mainline sleeper dressing', () => {
    assert.equal(isHeavyRailSegment(segment()), true);
    assert.equal(isHeavyRailSegment(segment({
        properties: { railway_type: 'tram', gauge: '1000' },
    })), false);
    assert.deepEqual(planHeavyRailSleepers([segment({
        properties: { railway_type: 'tram', gauge: '1000' },
    })]), []);
});

test('sleepers follow regular global chainage across segment boundaries', () => {
    const first = segment({ len: 1.3, x2: 1.3 });
    const second = segment({
        x1: 1.3,
        x2: 3.25,
        yStart: 2.13,
        yEnd: 2.325,
        len: 1.95,
        uStart: 1.3,
    });
    const placements = planHeavyRailSleepers([first, second]);
    assert.deepEqual(
        placements.map(item => Number(item.chainageM.toFixed(3))),
        [0.325, 0.975, 1.625, 2.275, 2.925],
    );
    assert.equal(new Set(placements.map(item => item.chainageM)).size, placements.length);
    assert.ok(placements.every(item => item.lengthM === HEAVY_RAIL_SLEEPER_LENGTH_M));
    assert.ok(Math.abs(placements[1].chainageM - placements[0].chainageM
        - HEAVY_RAIL_SLEEPER_SPACING_M) < 1e-9);
});

test('each rendered track gets a sleeper with interpolated offset and grade', () => {
    const placements = planHeavyRailSleepers([segment({
        startTrackCenterOffsetsM: [-1.7, 1.7],
        endTrackCenterOffsetsM: [-2.1, 2.1],
    })]);
    assert.equal(placements.length % 2, 0);
    const [left, right] = placements;
    assert.equal(left.trackIndex, 0);
    assert.equal(right.trackIndex, 1);
    assert.ok(left.z > 0 && right.z < 0);
    assert.ok(left.y > 2 && left.y < 3.2);
});
