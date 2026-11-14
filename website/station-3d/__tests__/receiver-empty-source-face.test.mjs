// A source face whose vertices sit nanometres apart draws no area: the opening clipper
// must keep it as an empty face, not clip it into a fragment that fails Float32 storage.
// The coordinates are the face that failed every ground generation beside Stari terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipReceiverGeometrySteps } from '../core/terrain-receiver-topology.js';

const drain = (steps) => { for (;;) { const next = steps.next(); if (next.done) return next.value; } };

// Source triangle 259 as logged: A, and B/C one Float32 step (5.4 µm) apart, both
// recovered from the clipped fragment's barycentric weights.
const A = { x: -55.94684982299805, y: 0.3814797103404999, z: 41.89827346801758 };
const B = { x: -58.80338668823241, y: 0.38175934553146346, z: 44.64043045043946 };
const C = { x: -58.80338287353514, y: 0.38175934553146335, z: 44.640426635742166 };
const WA = 0.8076200513564097, WC = 0.19237994864359031;
const mix = (wa, wb, wc, a, b, c) => ({ x: wa * a.x + wb * b.x + wc * c.x, y: wa * a.y + wb * b.y + wc * c.y,
    z: wa * a.z + wb * b.z + wc * c.z, weights: [wa, wb, wc] });

function receiver(points) {
    return { positions: new Float32Array(points.flatMap(p => [p.x, p.y, p.z])), indices: new Uint32Array([0, 1, 2]) };
}

// An opening topology that clips every triangle the way the real one clipped this face:
// keep the corner at A, cut across the other two at 19 % of the way from A.
function cuttingTopology(calls) {
    return {
        contract: 'station3d-surface-opening-topology-v1',
        *clipTriangleSteps(a, b, c) {
            calls.push([a, b, c]);
            return { triangles: [[mix(WA, 0, WC, a, b, c), { ...a, weights: [1, 0, 0] }, mix(WA, WC, 0, a, b, c)]] };
        },
    };
}

const clip = (geometry, topology) => drain(clipReceiverGeometrySteps({
    geometry, topology, maxVertices: 64, maxTriangles: 64, now: () => 0,
}));

test('the logged sliver is kept as an empty face instead of failing the generation', () => {
    const calls = [];
    const result = clip(receiver([A, B, C]), cuttingTopology(calls));
    assert.equal(calls.length, 0, 'an empty face is never clipped');
    assert.equal(result.topology.degenerateSourceTriangles, 1);
    assert.deepEqual([...result.indices], [0, 1, 2]);
});

test('a small but real face (1 cm edges) is still clipped', () => {
    const calls = [];
    const small = [{ x: 0, y: 0, z: 0 }, { x: 0.01, y: 0, z: 0 }, { x: 0, y: 0.01, z: 0.01 }];
    clip(receiver(small), cuttingTopology(calls));
    assert.equal(calls.length, 1);
});
