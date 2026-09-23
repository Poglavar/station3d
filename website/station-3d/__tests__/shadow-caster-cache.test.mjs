// Shadow signature and light stepping: any drawn change must change the signature,
// and small observer/solar motion must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { combineShadowSignatures, quantizeDirection, snapShadowAnchor } from '../core/shadow-caster-cache.js';

test('the combined signature changes with any caster, the light, the order or the count', () => {
    const base = combineShadowSignatures([11, 22, 33], 7, 1);
    assert.equal(combineShadowSignatures([11, 22, 33], 7, 1), base);
    assert.notEqual(combineShadowSignatures([11, 22, 34], 7, 1), base, 'a caster moved');
    assert.notEqual(combineShadowSignatures([11, 22], 7, 1), base, 'a caster vanished');
    assert.notEqual(combineShadowSignatures([11, 22, 33, 44], 7, 1), base, 'a caster appeared');
    assert.notEqual(combineShadowSignatures([11, 22, 33], 8, 1), base, 'the light stepped');
    assert.notEqual(combineShadowSignatures([11, 22, 33], 7, 2), base, 'the shadow type changed');
});

test('shadow anchors snap to a grid and solar direction moves in bounded steps', () => {
    assert.equal(snapShadowAnchor(13.9, 8), 16);
    assert.equal(snapShadowAnchor(-3.9, 8), -0);
    assert.equal(snapShadowAnchor(5, 0), 5);
    const step = Math.PI / 360;
    const a = quantizeDirection({ x: 0.6, y: 0.64, z: 0.48 }, step);
    const b = quantizeDirection({ x: 0.6001, y: 0.6401, z: 0.4799 }, step);
    assert.deepEqual(a, b, 'sub-step solar drift keeps the same light');
    const angle = Math.acos(a.x * 0.6 + a.y * 0.64 + a.z * 0.48);
    assert.ok(angle < step * 1.5, `quantized within a step (${angle})`);
    assert.ok(Math.abs(Math.hypot(a.x, a.y, a.z) - 1) < 1e-9);
});
