import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { traceRasterLoops, extrudeLabelShapesSteps } from '../core/street-label-geometry.js';

function drain(iterator) {
    const stages = [];
    for (;;) {
        const next = iterator.next();
        if (next.done) return { stages, value: next.value };
        stages.push(next.value);
    }
}

function area(points) {
    return points.reduce((sum, [x, y], i) => {
        const [nx, ny] = points[(i + 1) % points.length];
        return sum + x * ny - nx * y;
    }, 0) / 2;
}

test('bounded raster tracing retains outer contours, holes and separate diacritics', () => {
    const rows = [
        '0000000000',
        '0111110010',
        '0100010000',
        '0100010000',
        '0111110000',
        '0000000000',
    ];
    const input = Uint8Array.from(rows.join(''), Number);
    const { stages, value: loops } = drain(traceRasterLoops(input, 10, 6, {
        pixelsPerStep: 7, edgesPerStep: 3,
    }));
    assert.equal(loops.length, 3);
    assert.deepEqual(loops.map(area).sort((a, b) => a - b), [-6, 1, 20]);
    assert.equal(stages.filter(s => s.phase === 'contour-pixels')
        .reduce((sum, s) => sum + s.pixels, 0), input.length);
    assert.ok(stages.every(s => (s.pixels || 0) <= 7 && (s.edges || 0) <= 3));
    assert.ok(loops.every(loop => loop.every(p => p.every(Number.isInteger))));
});

function rectangle(x, y, w, h) {
    return new THREE.Shape([
        new THREE.Vector2(x, y), new THREE.Vector2(x + w, y),
        new THREE.Vector2(x + w, y + h), new THREE.Vector2(x, y + h),
    ]);
}

test('per-glyph extrusion produces the same centered positions, normals and UVs as whole-label extrusion', () => {
    const shapes = [rectangle(0, 0, 4, 6), rectangle(5, 0, 2, 6), rectangle(5.5, 7, 1, 1)];
    shapes[0].holes.push(new THREE.Path([
        new THREE.Vector2(1, 1), new THREE.Vector2(1, 5),
        new THREE.Vector2(3, 5), new THREE.Vector2(3, 1),
    ]));
    const options = { depth: 0.12, bevelEnabled: false, curveSegments: 1 };
    const reference = new THREE.ExtrudeGeometry(shapes, options);
    reference.center();
    reference.computeBoundingSphere();
    const { stages, value: result } = drain(extrudeLabelShapesSteps(shapes, options));
    assert.equal(stages.filter(s => s.phase === 'extrude-glyph').length, shapes.length);
    for (const name of ['position', 'normal', 'uv']) {
        const actual = result.attributes[name].array;
        const expected = reference.attributes[name].array;
        assert.equal(actual.length, expected.length, name);
        // center() also applies an identity normal matrix: it normalises
        // normals again and turns -0 into 0. Those are geometrically equal.
        for (let i = 0; i < actual.length; i++) {
            assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${name}[${i}]`);
        }
    }
    assert.deepEqual(result.boundingBox, reference.boundingBox);
    assert.ok(Math.abs(result.boundingSphere.radius - reference.boundingSphere.radius) < 1e-6);
    result.dispose();
    reference.dispose();
});

test('a long label yields for each glyph and bounded center ranges before atomic completion', () => {
    const shapes = Array.from({ length: 180 }, (_, i) => rectangle(i * 4, 0, 2, 4));
    const iterator = extrudeLabelShapesSteps(shapes, { depth: 0.12, bevelEnabled: false });
    const { stages, value: geometry } = drain(iterator);
    assert.equal(stages.filter(s => s.phase === 'extrude-glyph').length, 180);
    assert.ok(stages.filter(s => s.phase === 'center').length > 1);
    assert.ok(stages.every(s => !s.vertices || s.vertices <= 2048));
    assert.equal(geometry.attributes.position.count, 180 * 36);
    geometry.dispose();
});

test('canceling detached extrusion never publishes a partial label', () => {
    const iterator = extrudeLabelShapesSteps([rectangle(0, 0, 2, 3)], {
        depth: 0.12, bevelEnabled: false,
    });
    assert.equal(iterator.next().done, false);
    assert.deepEqual(iterator.return(), { value: undefined, done: true });
    assert.deepEqual(iterator.next(), { value: undefined, done: true });
});
