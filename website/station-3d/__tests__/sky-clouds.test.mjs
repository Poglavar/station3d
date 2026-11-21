// Locks the authored sky settings and the cloud field that must tile on a
// repeating texture without a seam.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SKY_DEFAULTS,
    buildTileableCloudNoise,
    cloudNoiseAt,
    resolveSkyConfig,
} from '../core/sky-clouds.js';

test('an authored sky resolves to fair-weather defaults, can drop its clouds and refuses a cloud layer at the sea', () => {
    assert.equal(resolveSkyConfig(null), null);
    const sky = resolveSkyConfig(true);
    assert.deepEqual(sky.clouds, SKY_DEFAULTS.clouds);
    assert.equal(sky.sunDisc, true);
    assert.equal(sky.lensFlare, true);
    assert.equal(resolveSkyConfig({ clouds: false }).clouds, null);
    assert.equal(resolveSkyConfig({ clouds: { coverage: 3 } }).clouds.coverage, 1);
    assert.equal(resolveSkyConfig({ lensFlare: false }).lensFlare, false);
    assert.throws(() => resolveSkyConfig({ clouds: { altitudeM: 0 } }), /altitudeM/);
});

test('the cloud field repeats exactly every texture width in both directions and follows its seed', () => {
    const options = { size: 64, octaves: 4, basePeriod: 4, seed: 7 };
    for (const [x, y] of [[0, 0], [3.5, 17.25], [63, 1], [40.75, 63.5]]) {
        const value = cloudNoiseAt(x, y, options);
        assert.equal(cloudNoiseAt(x + 64, y, options), value);
        assert.equal(cloudNoiseAt(x, y - 64, options), value);
        assert.ok(value >= 0 && value <= 1);
    }
    assert.notEqual(cloudNoiseAt(10.5, 20.5, options), cloudNoiseAt(10.5, 20.5, { ...options, seed: 8 }));
});

test('the cloud texture spans the full byte range and has no seam at its wrap', () => {
    const size = 64;
    const data = buildTileableCloudNoise({ size, octaves: 4, basePeriod: 4, seed: 3 });
    assert.equal(data.length, size * size);
    assert.equal(Math.min(...data), 0);
    assert.equal(Math.max(...data), 255);
    let interior = 0;
    let seam = 0;
    for (let y = 0; y < size; y++) {
        interior = Math.max(interior, Math.abs(data[y * size + 1] - data[y * size]));
        seam = Math.max(seam, Math.abs(data[y * size] - data[y * size + size - 1]));
    }
    assert.ok(seam <= interior * 2 + 8, `seam step ${seam} against interior step ${interior}`);
    assert.throws(() => buildTileableCloudNoise({ size: 100 }), /power of two/);
});
