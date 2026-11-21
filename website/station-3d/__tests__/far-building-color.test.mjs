import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
    applyFarBuildingTint,
    FAR_TINT_HSL_HALF_RANGE,
} from '../world/far-building-color.js';

const FAR_SOURCE = readFileSync(
    fileURLToPath(new URL('../world/buildings-far.js', import.meta.url)),
    'utf8',
);

function circularHueDistance(a, b) {
    const direct = Math.abs(a - b);
    return Math.min(direct, 1 - direct);
}

test('far-building tint is stable per object and leaves unidentified buildings unchanged', () => {
    const baseHex = 0xe7ab6e;
    const target = new THREE.Color();
    const first = applyFarBuildingTint(target, baseHex, 123456).getHex();
    const second = applyFarBuildingTint(target, baseHex, 123456).getHex();
    const stringId = applyFarBuildingTint(target, baseHex, '123456').getHex();

    assert.equal(first, second);
    assert.equal(first, stringId, 'numeric and string forms of an object id must match');
    assert.equal(applyFarBuildingTint(target, baseHex, null).getHex(), baseHex);
});

test('far-building tint stays subtle while producing visible palette variation', () => {
    const baseHex = 0xe7ab6e;
    const baseHsl = new THREE.Color(baseHex).getHSL({});
    const colors = new Set();

    for (let objectId = 1; objectId <= 128; objectId++) {
        const color = applyFarBuildingTint(new THREE.Color(), baseHex, objectId);
        const hsl = color.getHSL({});
        colors.add(color.getHex());
        assert.ok(circularHueDistance(hsl.h, baseHsl.h) <= FAR_TINT_HSL_HALF_RANGE.h + 1e-9);
        assert.ok(Math.abs(hsl.s - baseHsl.s) <= FAR_TINT_HSL_HALF_RANGE.s + 1e-9);
        assert.ok(Math.abs(hsl.l - baseHsl.l) <= FAR_TINT_HSL_HALF_RANGE.l + 1e-9);
    }

    assert.ok(colors.size >= 32, `expected varied skyline colours, got ${colors.size}`);
});

test('far BatchedMesh applies the tint through its existing per-instance color', () => {
    assert.match(FAR_SOURCE, /function tintFarEntity\(identity\)[\s\S]*applyFarBuildingTint\(/);
    assert.match(FAR_SOURCE, /colorForEntity: tintFarEntity/);
});
