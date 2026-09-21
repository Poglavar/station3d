import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReceiverDetailSteps } from '../core/receiver-detail-projection.js';

function finish(iterator) {
    let next = iterator.next();
    while (!next.done) next = iterator.next();
    return next.value;
}

test('receiver detail keeps interpolated UVs when receiver facets split a marking', () => {
    const receiver = new Float64Array([
        0, 0, 0, 1, 0, 0, 0, 0, 1,
        1, 0, 0, 1, 1, 1, 0, 0, 1,
    ]);
    const result = finish(projectReceiverDetailSteps({
        vertices: new Float64Array([
            0, 0, 0, 1, 0, 0, 1, 0, 1,
            0, 0, 0, 1, 0, 1, 0, 0, 1,
        ]),
        attributes: {
            uv: {
                array: new Float64Array([
                    0, 0, 1, 0, 1, 1,
                    0, 0, 1, 1, 0, 1,
                ]),
                itemSize: 2,
            },
        },
        receiverTriangles: function* () {
            yield { positions: receiver, a: 0, b: 3, c: 6 };
            yield { positions: receiver, a: 9, b: 12, c: 15 };
        },
    }));

    assert.ok(result.positions.length >= 18);
    assert.equal(result.attributes.uv.length, result.positions.length / 3 * 2);
    for (let index = 0; index < result.positions.length; index += 3) {
        const x = result.positions[index];
        const y = result.positions[index + 1];
        const z = result.positions[index + 2];
        const uvIndex = index / 3 * 2;
        assert.ok(Math.abs(result.attributes.uv[uvIndex] - x) < 1e-6);
        assert.ok(Math.abs(result.attributes.uv[uvIndex + 1] - z) < 1e-6);
        const expectedReceiverY = Math.max(0, x + z - 1);
        assert.ok(Math.abs(y - (expectedReceiverY + 0.002)) < 1e-6);
    }
});

test('receiver detail rejects attributes that do not match the source vertices', () => {
    assert.throws(() => projectReceiverDetailSteps({
        vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1],
        attributes: { uv: { array: [0, 0], itemSize: 2 } },
        receiverTriangles: function* () {},
    }).next(), /does not match/);
});
