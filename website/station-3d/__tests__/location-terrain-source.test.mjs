import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildingTileSourceForLocation,
    farBuildingTileSourceForLocation,
    getLocation,
    LOCATIONS,
    resolveRegionalLocation,
    resolveSpatialLocation,
} from '../core/locations.js';


test('Split: coarse base on the 20 m DTM, 1 m truth in the detail windows', () => {
    // The Trogir–Split 1 m DMR carries the real Divulje road-tunnel cuttings;
    // a camera-following detail window reads it. The moving fixed-cell BASE
    // stays on the 20 m DTM so coarse terrain never clips the full LiDAR set.
    assert.equal(LOCATIONS.split.terrain.source, 'dgu-dtm-20m');
    assert.equal(LOCATIONS.split.terrain.detail.source, 'best-available');
    assert.equal(LOCATIONS.split.terrain.detail.halfSizeM, 550);
    assert.equal(LOCATIONS.split.terrain.detail.bandHalfM, undefined);
});

test('other locations retain the backwards-compatible 20 m API default', () => {
    assert.equal(LOCATIONS.rijeka.terrain.source, undefined);
    assert.equal(LOCATIONS['sjeverna-dalmacija'].terrain.source, undefined);
});

test('Croatia free roam uses the camera-following national terrain profile', () => {
    assert.equal(LOCATIONS.croatia.terrain.source, 'dgu-dtm-20m');
    assert.equal(LOCATIONS.croatia.terrain.detail.source, 'best-available');
    assert.equal(LOCATIONS.croatia.terrain.detail.halfSizeM, 550);
    assert.equal(LOCATIONS.croatia.terrain.detail.bandHalfM, undefined);
    assert.equal(LOCATIONS.croatia.terrain.movingWindow, undefined);
    assert.equal(LOCATIONS.croatia.roadIndexUrl, null);
    assert.equal(LOCATIONS.croatia.passengers, false);
});

test('Croatia free roam resolves continental and karst presentation from position', () => {
    const base = { id: 'croatia', ...LOCATIONS.croatia };
    const zagreb = resolveRegionalLocation(base, 45.81, 15.98, {
        nearestCityId: () => 'zagreb',
    });
    const split = resolveRegionalLocation(base, 43.51, 16.44, {
        nearestCityId: () => 'split',
        REGISTRY: { split: { bbox: [16.18, 43.43, 16.58, 43.64] } },
    });

    assert.equal(zagreb.styleCityId, 'zagreb');
    assert.equal(zagreb.terrain.surfaceStyle, 'grass');
    assert.equal(zagreb.naturalGround.style, 'grass');
    assert.equal(split.styleCityId, 'split');
    assert.equal(split.styleCityContainsPosition, true);
    assert.equal(split.terrain.surfaceStyle, 'dalmatian-karst');
    assert.equal(split.naturalGround.style, 'dalmatian-karst');
});

test('nearest-city style does not pretend a distant point is inside that city', () => {
    const base = { id: 'croatia', ...LOCATIONS.croatia };
    const regionalZagreb = resolveRegionalLocation(base, 45.56, 18.68, {
        nearestCityId: () => 'zagreb',
        REGISTRY: { zagreb: { bbox: [15.70, 45.68, 16.25, 45.92] } },
    });

    assert.equal(regionalZagreb.styleCityId, 'zagreb');
    assert.equal(regionalZagreb.styleCityContainsPosition, false);
});

test('regional presentation resolution never mutates the country profile', () => {
    const originalTerrain = LOCATIONS.croatia.terrain;
    const originalNaturalGround = LOCATIONS.croatia.naturalGround;
    resolveRegionalLocation({ id: 'croatia', ...LOCATIONS.croatia }, 43.51, 16.44, {
        nearestCityId: () => 'split',
    });

    assert.equal(LOCATIONS.croatia.terrain, originalTerrain);
    assert.equal(LOCATIONS.croatia.naturalGround, originalNaturalGround);
    assert.equal(LOCATIONS.croatia.terrain.surfaceStyle, 'grass');
    assert.equal(LOCATIONS.croatia.naturalGround.style, 'grass');
});
