// These normals replace a three.js computeVertexNormals() call on decor's merged
// ground surfaces, so the only thing that matters is that they are the SAME
// normals — a sign flip or a different cross order lights every lawn and pavement
// in the city from underneath, which no timing would ever reveal.
//
// The reference below is three.js r184's own non-indexed branch, transcribed:
//   cb = C - B, ab = A - B, n = cb × ab, written to all three vertices,
//   then normalizeNormals().

import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import {
    computeFlatNormalsRange,
    prepareFlatSurfaceBuffersSteps,
    normalizeNormals,
    triangleCount,
} from '../core/flat-normals.js';

test('surface buffer preparation bounds each slice and matches Three geometry on slopes and degenerates', () => {
    const values = [];
    for (let i = 0; i < 73; i++) {
        values.push(i / 7, .003 * i, 0, i / 7 + .1, .02 * i, 2,
            i / 7 + (i % 3 ? 2 : .1), .02 * i, 2);
    }
    const reference = new BufferGeometry();
    reference.setAttribute('position', new Float32BufferAttribute(values, 3));
    reference.computeVertexNormals();
    let reads = 0;
    const source = new Proxy(values, {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
            return Reflect.get(target, property, receiver);
        },
    });
    const steps = prepareFlatSurfaceBuffersSteps(source, 8);
    let buffers, slices = 0;
    while (true) {
        const before = reads, result = steps.next();
        assert.ok(reads - before <= 8 * 9, 'one checkpoint must bound conversion and normal work');
        if (result.done) { buffers = result.value; break; }
        slices++;
    }
    assert.equal(slices, 10);
    assert.equal(reads, values.length, 'positions are converted once');
    assert.deepEqual(buffers.positions, reference.getAttribute('position').array);
    const expected = reference.getAttribute('normal').array;
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Number.isFinite(buffers.normals[i]));
        assert.ok(Math.abs(buffers.normals[i] - expected[i]) < 1e-6, `normal ${i}`);
    }
    reference.dispose();
});

test('closing surface preparation stops before reading the remaining geometry', () => {
    const values = new Proxy(new Array(9 * 10).fill(0), {
        get(target, property, receiver) {
            if (/^\d+$/.test(String(property)) && Number(property) >= 9) throw new Error('read beyond cancelled slice');
            return Reflect.get(target, property, receiver);
        },
    });
    const steps = prepareFlatSurfaceBuffersSteps(values, 1);
    assert.deepEqual(steps.next(), { value: { preparedTriangles: 1 }, done: false });
    steps.return();
    assert.equal(steps.next().done, true);
    assert.throws(() => prepareFlatSurfaceBuffersSteps([0], 1).next(), /complete triangles/);
    assert.throws(() => prepareFlatSurfaceBuffersSteps([], 0).next(), /positive chunk/);
});

// three.js's algorithm, written straightforwardly rather than in slices.
function referenceNormals(positions) {
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 9) {
        const [ax, ay, az] = [positions[i], positions[i + 1], positions[i + 2]];
        const [bx, by, bz] = [positions[i + 3], positions[i + 4], positions[i + 5]];
        const [cx, cy, cz] = [positions[i + 6], positions[i + 7], positions[i + 8]];
        const cb = [cx - bx, cy - by, cz - bz];
        const ab = [ax - bx, ay - by, az - bz];
        const n = [
            cb[1] * ab[2] - cb[2] * ab[1],
            cb[2] * ab[0] - cb[0] * ab[2],
            cb[0] * ab[1] - cb[1] * ab[0],
        ];
        for (let v = 0; v < 3; v++) {
            normals[i + v * 3] = n[0];
            normals[i + v * 3 + 1] = n[1];
            normals[i + v * 3 + 2] = n[2];
        }
    }
    for (let i = 0; i < normals.length; i += 3) {
        const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
        if (len === 0) continue;
        normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
    }
    return normals;
}

test('a flat ground triangle faces up, not down', () => {
    // The sign check that matters: decor surfaces are lit from the sky.
    // Counter-clockwise seen from above in three.js's right-handed frame.
    const positions = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 0, -1,
    ]);
    const normals = new Float32Array(9);
    computeFlatNormalsRange(positions, normals, 0, 1);
    normalizeNormals(normals);
    assert.ok(normals[1] > 0.99, `expected +Y, got ${[...normals.slice(0, 3)]}`);
    assert.deepEqual([...normals.slice(0, 3)], [...normals.slice(3, 6)], 'all three vertices share it');
});

test('chunked computation equals one pass, and both equal three.js', () => {
    const rnd = (s => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(5);
    const tris = 500;
    const positions = new Float32Array(tris * 9);
    for (let i = 0; i < positions.length; i++) positions[i] = rnd() * 200 - 100;

    const onePass = new Float32Array(positions.length);
    computeFlatNormalsRange(positions, onePass, 0, triangleCount(positions));
    normalizeNormals(onePass);

    // The whole point: arbitrary slice boundaries must not change the answer.
    const chunked = new Float32Array(positions.length);
    let at = 0;
    for (const size of [1, 7, 33, 100, 2, 250, 107]) {
        const end = Math.min(triangleCount(positions), at + size);
        computeFlatNormalsRange(positions, chunked, at, end);
        at = end;
    }
    computeFlatNormalsRange(positions, chunked, at, triangleCount(positions));
    normalizeNormals(chunked);

    const reference = referenceNormals(positions);
    for (let i = 0; i < positions.length; i++) {
        assert.ok(Math.abs(onePass[i] - reference[i]) < 1e-6, `one-pass differs at ${i}`);
        assert.ok(Math.abs(chunked[i] - reference[i]) < 1e-6, `chunked differs at ${i}`);
    }
});

test('a degenerate triangle yields a zero normal, never NaN', () => {
    // three.js divides by zero here and stores NaN, which then poisons anything
    // that averages it. A zero normal is wrong-but-inert; NaN is contagious.
    const positions = new Float32Array([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    const normals = new Float32Array(9);
    computeFlatNormalsRange(positions, normals, 0, 1);
    normalizeNormals(normals);
    for (const value of normals) assert.ok(Number.isFinite(value), 'no NaN may escape');
    assert.deepEqual([...normals], new Array(9).fill(0));
});

test('triangleCount ignores a trailing partial triangle', () => {
    assert.equal(triangleCount(new Float32Array(9)), 1);
    assert.equal(triangleCount(new Float32Array(18)), 2);
    assert.equal(triangleCount(new Float32Array(20)), 2, 'a partial triangle is not one');
    assert.equal(triangleCount(new Float32Array(0)), 0);
});

test('an empty range writes nothing', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const normals = new Float32Array(9).fill(7);
    computeFlatNormalsRange(positions, normals, 0, 0);
    assert.deepEqual([...normals], new Array(9).fill(7), 'untouched');
});
