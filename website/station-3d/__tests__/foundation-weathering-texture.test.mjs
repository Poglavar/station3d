import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFoundationWeatheringRaster } from '../core/foundation-weathering-texture.js';

function rgbStatistics(data) {
    let minimum = 255;
    let maximum = 0;
    let luminance = 0;
    let red = 0;
    let blue = 0;
    const tones = new Set();
    const pixels = data.length / 4;
    for (let index = 0; index < data.length; index += 4) {
        const value = (data[index] + data[index + 1] + data[index + 2]) / 3;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
        luminance += value;
        red += data[index];
        blue += data[index + 2];
        tones.add(`${data[index]}|${data[index + 1]}|${data[index + 2]}`);
        assert.equal(data[index + 3], 255);
    }
    return {
        minimum,
        maximum,
        mean: luminance / pixels,
        meanRed: red / pixels,
        meanBlue: blue / pixels,
        uniqueTones: tones.size,
    };
}

function averageWrappedEdgeDifference(data, size) {
    let difference = 0;
    let samples = 0;
    for (let y = 0; y < size; y++) {
        for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(
                data[(y * size) * 4 + channel]
                - data[(y * size + size - 1) * 4 + channel],
            );
            samples += 1;
        }
    }
    for (let x = 0; x < size; x++) {
        for (let channel = 0; channel < 3; channel++) {
            difference += Math.abs(
                data[x * 4 + channel]
                - data[((size - 1) * size + x) * 4 + channel],
            );
            samples += 1;
        }
    }
    return difference / samples;
}

test('foundation concrete weathering is deterministic and fully opaque', () => {
    const first = createFoundationWeatheringRaster(64, 8128);
    const second = createFoundationWeatheringRaster(64, 8128);
    assert.equal(first.size, 64);
    assert.equal(first.color.length, 64 * 64 * 4);
    assert.deepEqual(first.color, second.color);
    rgbStatistics(first.color);
});

test('foundation concrete carries visible age and restrained warm mineral variation', () => {
    const raster = createFoundationWeatheringRaster(128);
    const color = rgbStatistics(raster.color);
    assert.ok(color.mean > 215 && color.mean < 245,
        `near-white modulation must preserve the dark-grey material tint, got ${color.mean}`);
    assert.ok(color.minimum < 205 && color.maximum > 248,
        'runoff, cracks and mineral blooms must span a visible tonal range');
    assert.ok(color.meanRed - color.meanBlue > 4,
        'aged concrete should carry a restrained warm mineral cast');
    assert.ok(color.uniqueTones > 700,
        `weathering must not collapse to a handful of flat greys, got ${color.uniqueTones}`);
});

test('foundation weathering wraps without an artificial tile border', () => {
    const raster = createFoundationWeatheringRaster(128);
    assert.ok(
        averageWrappedEdgeDifference(raster.color, raster.size) < 10,
        'opposite texture edges must remain neighbours in the periodic field',
    );
});

test('the building foundation material uses one shared weathered colour map', () => {
    const source = readFileSync(new URL('../world/buildings.js', import.meta.url), 'utf8');
    assert.match(source, /createFoundationWeatheringRaster\(128\)/);
    const materialStart = source.indexOf('function getFoundationSkirtMaterial()');
    const materialEnd = source.indexOf('// Additive draped foundation', materialStart);
    const material = source.slice(materialStart, materialEnd);
    assert.match(material, /map: getFoundationSkirtTexture\(\)/);
    assert.doesNotMatch(material, /bumpMap|normalMap/,
        'foundation weathering must not add a second fragment-stage texture sample');
    assert.match(source, /FOUNDATION_SKIRT_TEXTURE_M = 5\.5/);
});
