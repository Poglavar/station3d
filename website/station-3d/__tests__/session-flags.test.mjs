// Verifies URL modes that suppress optional Station 3D showcase layers.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isElevationMode,
    shouldRenderDguTerrain,
} from '../core/session-flags.js';

test('recognizes enabled elevation query values', () => {
    assert.equal(isElevationMode('?elevation=true'), true);
    assert.equal(isElevationMode('?elevation=1'), true);
    assert.equal(isElevationMode('?elevation='), true);
});

test('does not suppress elevated rail when elevation mode is absent or disabled', () => {
    assert.equal(isElevationMode('?terrain=1'), false);
    assert.equal(isElevationMode('?elevation=false'), false);
    assert.equal(isElevationMode('?elevation=0'), false);
});

test('terrain query flag is retired for both opt-in and default-on locations', () => {
    const optInLocation = { terrain: {}, terrainOptIn: true };
    const defaultOnLocation = { terrain: {} };
    assert.equal(shouldRenderDguTerrain('?terrain=1', optInLocation), false);
    assert.equal(shouldRenderDguTerrain('?terrain=true', optInLocation), false);
    assert.equal(shouldRenderDguTerrain('?terrain=0', defaultOnLocation), true);
});

test('elevation is the sole DGU terrain query flag', () => {
    const optInLocation = { terrain: {}, terrainOptIn: true };
    assert.equal(shouldRenderDguTerrain('?elevation=1', optInLocation), true);
    assert.equal(shouldRenderDguTerrain('?elevation=true', optInLocation), true);
    assert.equal(shouldRenderDguTerrain('?elevation=0', optInLocation), false);
    assert.equal(shouldRenderDguTerrain('?photo=&elevation=1', optInLocation), false);
});
