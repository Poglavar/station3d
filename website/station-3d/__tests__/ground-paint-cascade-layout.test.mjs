import test from 'node:test';
import assert from 'node:assert/strict';
import { planGroundPaintCascadeLayout } from '../core/ground-paint-cascade-layout.js';

const base = { cameraX: 0, cameraZ: 0, widthM: 16, size: 64, blockSize: 16 };

test('snaps negative coordinates to integer block texels', () => {
    const page = planGroundPaintCascadeLayout({ ...base, cameraX: -0.01, cameraZ: -4.01 });
    assert.deepEqual(page.bounds, { minX: -8, minZ: -12, maxX: 8, maxZ: 4 });
    assert.ok(page.bounds.minX <= -0.01 && page.bounds.maxX >= -0.01);
    assert.equal(page.texelM, 0.25);
    assert.equal(page.changed, true);
});

test('retains the previous page inside hysteresis and reports same', () => {
    const first = planGroundPaintCascadeLayout(base);
    const second = planGroundPaintCascadeLayout({ ...base, cameraX: 1.9, cameraZ: -1.9, previous: first });
    assert.equal(second.same, true);
    assert.equal(second.changed, false);
    assert.deepEqual(second.bounds, first.bounds);
    assert.ok(first.bounds.minX <= 0 && first.bounds.maxX >= 0);
    assert.ok(first.bounds.minZ <= 0 && first.bounds.maxZ >= 0);
});

test('rebuilds after hysteresis threshold, and teleports to snapped origin', () => {
    const first = planGroundPaintCascadeLayout(base);
    const moved = planGroundPaintCascadeLayout({ ...base, cameraX: 10.01, previous: first });
    assert.equal(moved.changed, true);
    assert.equal(moved.bounds.minX, 4);
    const far = planGroundPaintCascadeLayout({ ...base, cameraX: 1000.1, cameraZ: -1000.1, previous: moved });
    assert.equal(far.changed, true);
    assert.deepEqual(far.bounds, { minX: 992, minZ: -1008, maxX: 1008, maxZ: -992 });
});

test('invalid dimensions and disposed or incompatible pages are rejected or ignored', () => {
    for (const bad of [
        { widthM: 0 }, { size: 0 }, { blockSize: 0 }, { size: 63 }, { blockSize: 32 },
        { cameraX: NaN }, { cameraZ: Infinity },
    ]) assert.throws(() => planGroundPaintCascadeLayout({ ...base, ...bad }));
    const first = planGroundPaintCascadeLayout(base);
    const fresh = planGroundPaintCascadeLayout({ ...base, cameraX: 9, previous: { ...first, disposed: true } });
    assert.equal(fresh.changed, true);
    const incompatible = planGroundPaintCascadeLayout({ ...base, cameraX: 9, previous: { ...first, size: 32 } });
    assert.equal(incompatible.changed, true);
});
