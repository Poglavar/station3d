import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    WATER_MATERIAL_PROFILES,
    WATER_TILE_M,
    sampleWaterSurfacePattern,
} from '../world/water-material.js';

const close = (a, b, epsilon = 1e-12) => Math.abs(a - b) <= epsilon;

test('water pattern is deterministic and seamless on both repeat boundaries', () => {
    for (const t of [0, 0.071, 0.23, 0.5, 0.819, 0.999]) {
        const left = sampleWaterSurfacePattern(0, t);
        const right = sampleWaterSurfacePattern(1, t);
        const bottom = sampleWaterSurfacePattern(t, 0);
        const top = sampleWaterSurfacePattern(t, 1);
        assert.ok(close(left.tint, right.tint));
        assert.ok(close(left.height, right.height));
        assert.ok(close(bottom.tint, top.tint));
        assert.ok(close(bottom.height, top.height));
        assert.deepEqual(sampleWaterSurfacePattern(t, t * 0.37), sampleWaterSurfacePattern(t, t * 0.37));
    }
});

test('water carries broad colour variation and fine ripples inside a long repeat', () => {
    const samples = [];
    let quarterRepeatDelta = 0;
    for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) {
            const u = x / 20;
            const v = y / 20;
            const sample = sampleWaterSurfacePattern(u, v);
            samples.push(sample);
            quarterRepeatDelta += Math.abs(sample.height - sampleWaterSurfacePattern(u + 0.25, v).height);
        }
    }
    const tint = samples.map(sample => sample.tint);
    const height = samples.map(sample => sample.height);
    assert.ok(Math.max(...tint) - Math.min(...tint) > 0.55);
    assert.ok(Math.max(...height) - Math.min(...height) > 1.1);
    assert.ok(quarterRepeatDelta / samples.length > 0.2, 'pattern must not read as four repeated 12 m cells');
    assert.equal(WATER_TILE_M, 48);
});

test('water profiles distinguish sea, sheltered water and fountains without another texture layer', () => {
    assert.deepEqual(Object.keys(WATER_MATERIAL_PROFILES), ['sea', 'sheltered', 'fountain']);
    assert.ok(WATER_MATERIAL_PROFILES.sheltered.normalScale < WATER_MATERIAL_PROFILES.sea.normalScale);
    assert.ok(WATER_MATERIAL_PROFILES.fountain.normalScale > WATER_MATERIAL_PROFILES.sea.normalScale);
    assert.ok(WATER_MATERIAL_PROFILES.sheltered.roughness > WATER_MATERIAL_PROFILES.sea.roughness);

    const source = readFileSync(new URL('../world/water-material.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Math\.random/);
    assert.doesNotMatch(source, /strokeStyle\s*=\s*['"]rgba\(210, 244, 255/);
    assert.equal((source.match(/map:\s*getWaterTexture\(\)/g) || []).length, 1);
    assert.equal((source.match(/normalMap:\s*getWaterNormalTexture\(\)/g) || []).length, 1);
});

test('known water settings request the intended material profile', () => {
    const read = name => readFileSync(new URL(`../world/${name}`, import.meta.url), 'utf8');
    assert.match(read('water.js'), /createWaterMaterial\(\{ profile: 'sea' \}\)/);
    assert.match(read('aerial-view.js'), /profile: 'sea'/);
    assert.match(read('proposals.js'), /profile: 'sheltered'/);
    assert.match(read('decor.js'), /type === 'fountain' \? 'fountain' : 'sheltered'/);
});
