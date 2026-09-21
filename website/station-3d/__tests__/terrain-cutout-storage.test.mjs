import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerrainCutoutTopologySteps } from '../core/terrain-cutout-topology.js';

const limits = Object.freeze({
    maxSources: 16,
    maxSourceVertices: 128,
    maxIndexEntries: 256,
    maxCellCandidates: 32,
    maxOperandVertices: 256,
    maxIntersections: 256,
    maxOutputTriangles: 256,
});

function complete(generator) {
    let step = generator.next();
    while (!step.done) step = generator.next();
    return step.value;
}

test('receiver storage discards an unrepresentable densified-edge sliver', () => {
    const ring = [
        { x: 2678.1632784448675, z: 1695.30124944512 },
        { x: 2676.922174318891, z: 1692.4546918279325 },
        { x: 2677.5427187524847, z: 1693.8779706365262 },
    ];
    const topology = complete(createTerrainCutoutTopologySteps({
        layers: [{ operation: 'subtract', regions: [{ ring }] }],
        limits,
        now: () => 0,
    }));
    const stored = complete(topology.prepareReceiverStorageSteps({
        bounds: { minX: 2400, minZ: 1600, maxX: 2800, maxZ: 2000 },
        storageOrigin: { x: 2400, z: 1600 },
        now: () => 0,
    }));
    const result = complete(stored.clipTriangleSteps(
        { x: 2670, y: 0, z: 1685 },
        { x: 2685, y: 0, z: 1685 },
        { x: 2677.5, y: 0, z: 1705 },
        { storageOrigin: { x: 2400, z: 1600 }, now: () => 0 },
    ));

    assert.equal(result.unchanged, true);
    assert.equal(result.triangles, null);
});
