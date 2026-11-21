// The bake-time terrain carve: baked ground opens where the live mask opens.

import assert from 'node:assert/strict';
import test from 'node:test';

import { carveTerrainPrimitive } from '../core/campaign-pack-terrain-carve.js';

// A 20 × 20 m ground patch on the bake's 4 m grid, with normals, uvs and
// colours, like a captured terrain tile.
function quad(stepM = 4) {
    const positions = [], normals = [], uvs = [], colors = [], indices = [];
    const n = Math.round(20 / stepM);
    for (let row = 0; row <= n; row++) {
        for (let col = 0; col <= n; col++) {
            positions.push(-10 + col * stepM, 0, -10 + row * stepM);
            normals.push(0, 1, 0);
            uvs.push(col / n, row / n);
            colors.push(col / n, row / n, 0.5);
        }
    }
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const a = row * (n + 1) + col;
            indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
        }
    }
    return { positions, normals, uvs, colors, indices };
}

function triangleArea(positions, indices) {
    let total = 0;
    for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
        const ax = positions[a * 3], az = positions[a * 3 + 2];
        const bx = positions[b * 3], bz = positions[b * 3 + 2];
        const cx = positions[c * 3], cz = positions[c * 3 + 2];
        total += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
    }
    return total;
}

test('ground under a corridor is removed to within the edge resolution, the rest survives', () => {
    // A 6 m wide rail corridor running along Z through the middle of the quad.
    const insideCut = (x) => Math.abs(x) < 3;
    const carved = carveTerrainPrimitive(quad(), insideCut, { maxEdgeM: 1, maxDepth: 6 });
    assert.ok(carved.carve.dropped > 0);
    const area = triangleArea(carved.positions, carved.indices);
    const expected = 400 - 20 * 6;
    assert.ok(Math.abs(area - expected) < expected * 0.04, `area ${area} vs ${expected}`);
    // No surviving triangle has its centroid in the corridor.
    for (let i = 0; i < carved.indices.length; i += 3) {
        const cx = (carved.positions[carved.indices[i] * 3] + carved.positions[carved.indices[i + 1] * 3] + carved.positions[carved.indices[i + 2] * 3]) / 3;
        assert.ok(!insideCut(cx), `triangle centroid x=${cx} inside the corridor`);
    }
    // Attributes stay aligned with the vertices.
    const vertexCount = carved.positions.length / 3;
    assert.equal(carved.normals.length, vertexCount * 3);
    assert.equal(carved.uvs.length, vertexCount * 2);
    assert.equal(carved.colors.length, vertexCount * 3);
    assert.ok(carved.indices.every(index => index < vertexCount));
});

test('a primitive nowhere near a cut is returned untouched', () => {
    const source = quad();
    const same = carveTerrainPrimitive(source, () => false);
    assert.equal(same, source);
    assert.equal(carveTerrainPrimitive(source, null), source);
});

test('a primitive wholly inside the cut vanishes', () => {
    const carved = carveTerrainPrimitive(quad(), () => true);
    assert.equal(carved.indices.length, 0);
    assert.equal(carved.positions.length, 0);
    assert.equal(carved.carve.dropped, 50);
});
