// The plain-array primitives every merged decor mesh is built from. Each check
// asserts the SHAPE that ends up on screen — extents, winding-independent vertex
// counts, and that colour really travels per-vertex, which is what lets all this
// share one material and one draw call.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDecorArrays,
    pushBench,
    pushBlob,
    pushBox,
    pushCafeChair,
    pushFlatStrip,
    pushRingBand,
    pushSunshade,
    pushTree,
} from '../core/vertex-color-geometry.js';

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

function extents(arrays) {
    const p = arrays.positions;
    const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < p.length; i += 3) {
        out.minX = Math.min(out.minX, p[i]); out.maxX = Math.max(out.maxX, p[i]);
        out.minY = Math.min(out.minY, p[i + 1]); out.maxY = Math.max(out.maxY, p[i + 1]);
        out.minZ = Math.min(out.minZ, p[i + 2]); out.maxZ = Math.max(out.maxZ, p[i + 2]);
    }
    return out;
}

function colorTriples(arrays) {
    const seen = new Set();
    for (let i = 0; i < arrays.colors.length; i += 3) {
        seen.add(`${arrays.colors[i]},${arrays.colors[i + 1]},${arrays.colors[i + 2]}`);
    }
    return seen;
}

test('every primitive emits one colour per vertex', () => {
    const arrays = createDecorArrays();
    pushBox(arrays, 0, 0, 0, 1, 1, 1, 0, RED);
    pushBlob(arrays, 5, 1, 5, 0.5, 0.8, RED);
    pushTree(arrays, 9, 9, 3, RED, BLUE);
    pushBench(arrays, -4, -4, 0.3, RED);
    pushFlatStrip(arrays, { x: 0, z: 0 }, { x: 4, z: 0 }, 1.2, 0, RED);
    assert.equal(arrays.positions.length % 9, 0, 'positions must be whole triangles');
    assert.equal(arrays.colors.length, arrays.positions.length,
        'a colour per position component, or the merged material renders black');
});

test('a box stands ON its base and spans its footprint', () => {
    const arrays = createDecorArrays();
    pushBox(arrays, 2, 10, -3, 2, 4, 1, 0, RED);
    const box = extents(arrays);
    assert.equal(box.minY, 10);
    assert.equal(box.maxY, 14);
    assert.ok(Math.abs(box.minX - 1) < 1e-9 && Math.abs(box.maxX - 3) < 1e-9);
    assert.ok(Math.abs(box.minZ - -3.5) < 1e-9 && Math.abs(box.maxZ - -2.5) < 1e-9);
});

test('a capless box is exactly one quad lighter than a capped one', () => {
    const capped = createDecorArrays();
    const capless = createDecorArrays();
    pushBox(capped, 0, 0, 0, 1, 1, 1, 0, RED, true);
    pushBox(capless, 0, 0, 0, 1, 1, 1, 0, RED, false);
    assert.equal((capped.positions.length - capless.positions.length) / 9, 2,
        'the cap is two triangles');
});

test('a rotated box keeps its size but changes its footprint', () => {
    const straight = createDecorArrays();
    const turned = createDecorArrays();
    pushBox(straight, 0, 0, 0, 4, 1, 1, 0, RED, false);
    pushBox(turned, 0, 0, 0, 4, 1, 1, Math.PI / 2, RED, false);
    const a = extents(straight);
    const b = extents(turned);
    assert.ok(Math.abs((a.maxX - a.minX) - 4) < 1e-9);
    assert.ok(Math.abs((b.maxZ - b.minZ) - 4) < 1e-9, 'a quarter turn swaps the long axis');
    assert.ok(Math.abs((b.maxX - b.minX) - 1) < 1e-9);
});

test('a tree crown sits above its trunk and within its height', () => {
    const arrays = createDecorArrays();
    pushTree(arrays, 0, 0, 4, RED, BLUE, 2);
    const box = extents(arrays);
    assert.ok(box.minY >= 2 - 1e-9, 'the trunk starts on the given ground');
    assert.ok(box.maxY <= 2 + 4 + 1e-6, 'nothing pokes above the stated height');
    assert.ok(box.maxY > 2 + 4 * 0.8, 'and the crown reaches most of it');
    assert.deepEqual([...colorTriples(arrays)], ['1,0,0', '0,0,1'],
        'trunk and foliage stay distinct colours in one mesh');
});

// Parasols are the roof's spot of colour: alternating segments make one umbrella
// striped rather than flat.
test('a sunshade stripes its canopy through the colours it is given', () => {
    const striped = createDecorArrays();
    pushSunshade(striped, 0, 0, [RED, BLUE], { r: 0.5, g: 0.5, b: 0.5 });
    const colors = colorTriples(striped);
    assert.ok(colors.has('1,0,0') && colors.has('0,0,1'), 'both canopy tones are present');

    const plain = createDecorArrays();
    pushSunshade(plain, 0, 0, RED, { r: 0.5, g: 0.5, b: 0.5 });
    assert.equal(plain.positions.length, striped.positions.length,
        'striping is colour only — it must not cost geometry');
    assert.ok(!colorTriples(plain).has('0,0,1'));

    const box = extents(striped);
    assert.ok(box.maxY > 2.3 && box.maxY < 2.4, 'canopy sits at parasol height');
    assert.ok(Math.abs(box.maxX - 1.4) < 1e-6, 'and spans its radius');
});

test('a bench has a seat above the ground with legs reaching it', () => {
    const arrays = createDecorArrays();
    pushBench(arrays, 0, 0, 0, RED, 1);
    const box = extents(arrays);
    assert.equal(box.minY, 1, 'legs stand on the given ground');
    assert.ok(box.maxY > 1.8 && box.maxY < 2.0, 'backrest tops out at sitting height');
    assert.ok((box.maxX - box.minX) > 1.6, 'and it is bench-length');
});

test('a bench back stays behind the yaw a seated person faces', () => {
    for (const yaw of [0, Math.PI / 3, -Math.PI / 2, Math.PI]) {
        const arrays = createDecorArrays();
        pushBench(arrays, 4, -2, yaw, RED);
        const high = [];
        for (let index = 0; index < arrays.positions.length; index += 3) {
            if (arrays.positions[index + 1] <= 0.55) continue;
            high.push({ x: arrays.positions[index], z: arrays.positions[index + 2] });
        }
        const center = high.reduce(
            (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
            { x: 0, z: 0 },
        );
        center.x /= high.length;
        center.z /= high.length;
        const frontX = Math.sin(yaw);
        const frontZ = Math.cos(yaw);
        const backDot = (center.x - 4) * frontX + (center.z + 2) * frontZ;
        assert.ok(backDot < -0.15, `yaw ${yaw} put the backrest in front (${backDot})`);
    }
});

test('a cafe chair is lightweight furniture, not two stacked solid boxes', () => {
    const arrays = createDecorArrays();
    pushCafeChair(arrays, 0, 0, 0, RED, BLUE, 1);
    const box = extents(arrays);

    assert.equal(box.minY, 1, 'all four legs reach the roof');
    assert.ok(box.maxY > 1.82 && box.maxY < 1.92, 'back is a plausible chair height');
    assert.ok(box.maxX - box.minX < 0.6 && box.maxZ - box.minZ < 0.6,
        'the chair keeps a domestic cafe-chair footprint');
    assert.deepEqual([...colorTriples(arrays)].sort(), ['0,0,1', '1,0,0'],
        'slats and metal frame remain distinct inside the shared decor mesh');
    assert.equal(arrays.positions.length / 9, 48,
        'four legs and separate seat/back slats stay inside the batched geometry budget');
});

test('a cafe chair back stays behind its declared facing direction', () => {
    for (const angle of [0, Math.PI / 3, -Math.PI / 2, Math.PI]) {
        const arrays = createDecorArrays();
        pushCafeChair(arrays, 4, -2, angle, RED, BLUE);
        const high = [];
        for (let index = 0; index < arrays.positions.length; index += 3) {
            if (arrays.positions[index + 1] <= 0.55) continue;
            high.push({ x: arrays.positions[index], z: arrays.positions[index + 2] });
        }
        const center = high.reduce(
            (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
            { x: 0, z: 0 },
        );
        center.x /= high.length;
        center.z /= high.length;
        const backDot = (center.x - 4) * Math.cos(angle)
            + (center.z + 2) * Math.sin(angle);
        assert.ok(backDot < -0.1, `angle ${angle} put the backrest in front (${backDot})`);
    }
});

test('a ring band spans between its two rings without inverting', () => {
    const outer = [{ x: -2, z: -2 }, { x: 2, z: -2 }, { x: 2, z: 2 }, { x: -2, z: 2 }, { x: -2, z: -2 }];
    const inner = outer.map(p => ({ x: p.x * 0.5, z: p.z * 0.5 }));
    const arrays = createDecorArrays();
    pushRingBand(arrays, outer, inner, 0.25, RED);
    const box = extents(arrays);
    assert.equal(box.minY, 0.25);
    assert.equal(box.maxY, 0.25, 'a band is flat');
    assert.ok(Math.abs(box.maxX - 2) < 1e-9 && Math.abs(box.minX + 2) < 1e-9);
    assert.equal(arrays.positions.length / 9, (outer.length - 1) * 2, 'two triangles per segment');
});

test('a degenerate strip emits nothing rather than NaN geometry', () => {
    const arrays = createDecorArrays();
    pushFlatStrip(arrays, { x: 1, z: 1 }, { x: 1, z: 1 }, 1.2, 0, RED);
    assert.equal(arrays.positions.length, 0);
    pushFlatStrip(arrays, { x: 0, z: 0 }, { x: 3, z: 4 }, 2, 0, RED);
    assert.ok(arrays.positions.every(Number.isFinite));
});
