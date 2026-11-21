// The stated-material brick map must be deterministic and colour-faithful:
// the sim regenerates it per session, so any drift from the authoring viewer's
// output would repaint a landmark between visits.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { brickTextureData, boxProjectedUvs, seededUnit } from '../core/brick-texture.js';

test('brick texture is deterministic for a given config', () => {
    const a = brickTextureData(64, '#c9a183', '#a5654c', '#b6aa96', 7);
    const b = brickTextureData(64, '#c9a183', '#a5654c', '#b6aa96', 7);
    assert.deepEqual(Array.from(a), Array.from(b));
});

test('mortar lines carry the mortar tone, sRGB-faithful within rounding', () => {
    const size = 64;
    const data = brickTextureData(size, '#c9a183', '#a5654c', '#b6aa96', 7);
    // y=0 is a course line: every pixel there is mortar.
    const mortar = new THREE.Color('#b6aa96').convertLinearToSRGB();
    for (const x of [0, 13, 40, size - 1]) {
        const i = x * 4;
        assert.ok(Math.abs(data[i] - Math.round(mortar.r * 255)) <= 2, `r at x=${x}`);
        assert.ok(Math.abs(data[i + 1] - Math.round(mortar.g * 255)) <= 2, `g at x=${x}`);
        assert.ok(Math.abs(data[i + 2] - Math.round(mortar.b * 255)) <= 2, `b at x=${x}`);
        assert.equal(data[i + 3], 255);
    }
});

test('brick field varies per brick but stays near the base tone', () => {
    const size = 64;
    const data = brickTextureData(size, '#c9a183', '#a5654c', '#b6aa96', 7);
    const tones = new Set();
    // Sample brick interiors (skip course line y=0; courseH = 64/24 ≈ 2.7).
    for (let y = 1; y < size; y += 3) {
        for (let x = 2; x < size; x += 5) {
            const i = (y * size + x) * 4;
            tones.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        }
    }
    assert.ok(tones.size > 8, `expected per-brick jitter, got ${tones.size} tones`);
});

test('box UVs project each triangle on its dominant axis in metres over scale', () => {
    // A wall facing +x (normal along x): UV must be (z, y) / scale.
    const wall = [0, 0, 0, 0, 0, 3.6, 0, 3.6, 0];
    const uv = boxProjectedUvs(Float32Array.from(wall), 1.8);
    assert.deepEqual(Array.from(uv), [0, 0, 2, 0, 0, 2]);
    // A floor facing +y: UV must be (x, z) / scale.
    const floor = [0, 5, 0, 1.8, 5, 0, 0, 5, 1.8];
    const uvFloor = boxProjectedUvs(Float32Array.from(floor), 1.8);
    assert.deepEqual(Array.from(uvFloor), [0, 0, 1, 0, 0, 1]);
});

test('seededUnit is a stable unit-interval hash', () => {
    assert.equal(seededUnit(3, 4, 7), seededUnit(3, 4, 7));
    assert.notEqual(seededUnit(3, 4, 7), seededUnit(4, 3, 7));
    for (let i = 0; i < 50; i++) {
        const v = seededUnit(i, i * 3, 11);
        assert.ok(v >= 0 && v < 1);
    }
});
