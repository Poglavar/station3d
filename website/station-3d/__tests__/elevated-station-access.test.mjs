// Elevated stairs and lifts must use terrain-local ground, not an assumed
// station-group origin of zero.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveElevatedStationAccessHeights } from '../world/planner-station-layout.js';

test('access levels stay coherent when local ground is not zero', () => {
    const levels = resolveElevatedStationAccessHeights(18, 7);
    assert.equal(levels.groundY, 7.06);
    assert.equal(levels.middleY, (7.06 + 18) / 2);
    assert.equal(levels.liftBaseY, 7);
    assert.equal(levels.liftTopY, 20.5);
    assert.equal(levels.liftShaftHeight, 13.5);
    assert.equal(levels.liftShaftCenterY, 13.75);
});

test('the common zero-ground station layout remains unchanged', () => {
    const levels = resolveElevatedStationAccessHeights(10, 0);
    assert.equal(levels.groundY, 0.06);
    assert.equal(levels.middleY, 5.03);
    assert.equal(levels.liftBaseY, 0);
    assert.equal(levels.liftTopY, 12.5);
    assert.equal(levels.liftShaftHeight, 12.5);
});
