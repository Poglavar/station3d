// Verifies that the Dalmatian terrain raster is deterministic and materially varied.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDalmatianTerrainRaster } from '../core/dalmatian-terrain-texture.js';

test('builds a deterministic varied Dalmatian terrain raster', () => {
    const first = createDalmatianTerrainRaster(32, 1234);
    const same = createDalmatianTerrainRaster(32, 1234);
    const different = createDalmatianTerrainRaster(32, 1235);
    assert.equal(first.color.length, 32 * 32 * 4);
    assert.deepEqual(first.color, same.color);
    assert.notDeepEqual(first.color, different.color);
    const luminance = [];
    for (let index = 0; index < first.color.length; index += 4) {
        luminance.push((first.color[index] + first.color[index + 1] + first.color[index + 2]) / 3);
        assert.equal(first.color[index + 3], 255);
        assert.equal(first.height[index + 3], 255);
    }
    assert.ok(Math.max(...luminance) - Math.min(...luminance) > 35);
    const meanRed = first.color.filter((_value, index) => index % 4 === 0)
        .reduce((sum, value) => sum + value, 0) / (32 * 32);
    const meanBlue = first.color.filter((_value, index) => index % 4 === 2)
        .reduce((sum, value) => sum + value, 0) / (32 * 32);
    assert.ok(meanRed > meanBlue + 15, `expected warm ground, got R=${meanRed} B=${meanBlue}`);
});
