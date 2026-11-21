import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    campaignPackSpawnSupportY,
    createCampaignPackSupportIndex,
} from '../core/campaign-pack-support.js';

function primitive(surfaceClass, y) {
    return {
        positions: new Float32Array([0, y, 0, 10, y, 0, 0, y, 10]),
        indices: new Uint16Array([0, 1, 2]),
        surfaceClaims: [{ surfaceClass }],
    };
}

function compiledPrimitive(surfaceClass, y, support = true) {
    const value = primitive(surfaceClass, y);
    value.surfaceClaims[0].capabilities = { support };
    return value;
}

test('campaign support uses the same triangles for terrain and road physics', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [
        primitive('terrain', 2),
        primitive('road', 4),
        primitive('building', 12),
    ] }]);
    assert.equal(index.terrainYAt(2, 2), 2);
    assert.equal(index.supportYAt(2, 2, { drivableOnly: true }), 4);
    assert.equal(index.supportYAt(2, 2, { drivableOnly: true, maxY: 3 }), 2);
    assert.equal(index.supportYAt(9, 9), null);
    assert.equal(index.snapshot().triangleCount, 3);
});

test('campaign support translates pack coordinates into a session anchor', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [primitive('terrain', 3)] }], {
        offsetX: -20,
        offsetZ: 30,
    });
    assert.equal(index.terrainYAt(-18, 32), 3);
    assert.equal(index.terrainYAt(2, 2), null);
});

test('float32 rail endpoints remain supported without bridging real gaps', () => {
    const rail = compiledPrimitive('rail-trackbed', 2);
    rail.positions = new Float32Array([
        720.7695922851562, 2, -101.52096557617188,
        701.1015014648438, 2, -96.66974639892578,
        721.0240478515625, 2, -98.19318389892578,
    ]);
    // The exact driving endpoint lies six micrometres beyond the quantized
    // mesh edge. A missed lookup here switches the train to the ground below.
    const x = 720.8992085777846;
    const z = -99.82591665742419;
    for (const [offsetX, offsetZ] of [[0, 0], [-1000, 2000]]) {
        const index = createCampaignPackSupportIndex([{ primitives: [rail] }], { offsetX, offsetZ });
        assert.equal(index.supportYAt(x + offsetX, z + offsetZ), 2);
        assert.equal(index.supportYAt(x + offsetX + 0.005, z + offsetZ), null);
    }
    rail.positions = new Float32Array([16, 2, 0, 26, 2, 0, 16, 2, 10]);
    const boundary = createCampaignPackSupportIndex([{ primitives: [rail] }]);
    assert.equal(boundary.supportYAt(16 - 1e-7, 2), 2,
        'rounding into a neighbouring index cell must not hide the triangle');
    assert.equal(boundary.supportYAt(16 - 0.001, 2), null);
});

test('canonical baked paving classes are visible support and vehicle support', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [
        compiledPrimitive('terrain', 1),
        compiledPrimitive('road-carriageway', 2),
        compiledPrimitive('buffered-sidewalk', 3),
        compiledPrimitive('rail-trackbed', 4),
    ] }]);
    assert.equal(index.supportYAt(2, 2), 4);
    assert.equal(index.supportYAt(2, 2, { drivableOnly: true }), 4);
    assert.equal(index.supportYAt(2, 2, { drivableOnly: true, maxY: 2.5 }), 2);
});

test('building roofs remain walk support but never become vehicle ground', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [
        compiledPrimitive('terrain', 1),
        compiledPrimitive('building', 12, false),
    ] }]);
    assert.equal(index.supportYAt(2, 2), 12);
    assert.equal(index.supportYAt(2, 2, { drivableOnly: true }), 1);
});

test('campaign spawns choose street dressing near terrain instead of an overhead roof', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [
        primitive('terrain', 10),
        primitive('sidewalk', 10.25),
        primitive('building', 22),
    ] }]);
    assert.equal(campaignPackSpawnSupportY(index, 2, 2), 10.25);
    assert.equal(campaignPackSpawnSupportY(index, 9, 9), null);
});

test('campaign spawns use non-building transport support at a carved entrance', () => {
    const index = createCampaignPackSupportIndex([{ primitives: [
        primitive('sidewalk', 10.25),
        primitive('building', 22),
    ] }]);
    assert.equal(campaignPackSpawnSupportY(index, 2, 2), 10.25);
});
