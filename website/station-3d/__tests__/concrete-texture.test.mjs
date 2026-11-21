// Locks the retaining-wall concrete raster: deterministic, correctly shaped, and
// a plausibly grey/opaque field (so a broken generator can't ship a blank map).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createConcreteRaster,
    createRoadRetainingConcreteRaster,
} from '../core/concrete-texture.js';

test('createConcreteRaster returns a deterministic RGBA color + height field', () => {
    const a = createConcreteRaster(64, 0x1234);
    const b = createConcreteRaster(64, 0x1234);
    assert.equal(a.size, 64);
    assert.equal(a.color.length, 64 * 64 * 4);
    assert.equal(a.height.length, 64 * 64 * 4);
    assert.deepEqual(a.color, b.color, 'same seed must reproduce the same color raster');
    assert.deepEqual(a.height, b.height, 'same seed must reproduce the same height raster');
    // Different seed must actually differ (the generator uses the seed).
    const c = createConcreteRaster(64, 0x9999);
    assert.ok(!a.color.every((value, index) => value === c.color[index]), 'seed must change output');
});

test('concrete raster is opaque, mid-grey and neutral (not a blank or tinted field)', () => {
    const { color } = createConcreteRaster(48, 0x3c0c2e);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const pixels = color.length / 4;
    for (let index = 0; index < color.length; index += 4) {
        assert.equal(color[index + 3], 255, 'every texel must be opaque');
        sumR += color[index];
        sumG += color[index + 1];
        sumB += color[index + 2];
    }
    const meanR = sumR / pixels;
    const meanG = sumG / pixels;
    const meanB = sumB / pixels;
    assert.ok(meanR > 120 && meanR < 175, `mean grey out of range: ${meanR}`);
    assert.ok(Math.abs(meanR - meanB) < 8, 'concrete must stay near-neutral grey');
});

test('road retaining concrete is deterministic, weathered and visibly warmer than rail concrete', () => {
    const road = createRoadRetainingConcreteRaster(64, 0x72d14a);
    const same = createRoadRetainingConcreteRaster(64, 0x72d14a);
    const rail = createConcreteRaster(64, 0x3c0c2e);
    assert.deepEqual(road.color, same.color);
    assert.deepEqual(road.height, same.height);
    assert.ok(!road.color.every((value, index) => value === rail.color[index]),
        'road concrete must not reuse the rail wall raster');
    let red = 0;
    let green = 0;
    let blue = 0;
    let darkest = 255;
    let lightest = 0;
    const pixels = road.color.length / 4;
    for (let index = 0; index < road.color.length; index += 4) {
        assert.equal(road.color[index + 3], 255);
        red += road.color[index];
        green += road.color[index + 1];
        blue += road.color[index + 2];
        darkest = Math.min(darkest, road.color[index + 1]);
        lightest = Math.max(lightest, road.color[index + 1]);
    }
    assert.ok(red / pixels - blue / pixels > 10,
        'aged road concrete needs a readable warm/ochre cast');
    assert.ok(lightest - darkest > 55,
        'runoff, joints and damp patches need visible tonal range');
    assert.ok(red > green && green > blue);
});
