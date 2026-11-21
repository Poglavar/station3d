// Verifies that Split's low-rise masonry texture is stable and stone-like.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDalmatianStoneRaster } from '../core/dalmatian-stone-texture.js';

test('creates deterministic large-stone colour and recessed mortar', () => {
    const first = createDalmatianStoneRaster(64, 12);
    const same = createDalmatianStoneRaster(64, 12);
    const different = createDalmatianStoneRaster(64, 13);
    assert.deepEqual(first, same);
    assert.notDeepEqual(first.color, different.color);
    const relief = [];
    let warmPixels = 0;
    for (let index = 0; index < first.color.length; index += 4) {
        relief.push(first.height[index]);
        if (first.color[index] > first.color[index + 2]) warmPixels += 1;
        assert.equal(first.color[index + 3], 255);
    }
    assert.ok(Math.min(...relief) < 100, 'mortar should be recessed');
    assert.ok(Math.max(...relief) > 190, 'stone faces should stand proud');
    assert.ok(warmPixels > 64 * 64 * 0.85);
});
