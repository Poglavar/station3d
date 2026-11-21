// Verifies crop orientation, no-data coastline holes, and colours in the
// standalone DGU terrain viewer without requiring a browser or WebGL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGrid } from '../core/terrain-grid.js';
import {
    buildTerrainViewerMeshData,
    parseTerrainViewerSettings,
    terrainColorAtHeight,
    terrainColorAtSource,
    terrainThresholdSliderModel,
    terrainViewerLocationAtLocal,
} from '../core/terrain-viewer-model.js';

test('threshold slider spans the relief in whole metres and keeps a clamped previous choice', () => {
    assert.deepEqual(
        terrainThresholdSliderModel(12.4, 787.2),
        { min: 12, max: 788, step: 5, value: 12, enabled: true },
    );
    assert.deepEqual(
        terrainThresholdSliderModel(-3.2, 96.1),
        { min: -4, max: 97, step: 1, value: -4, enabled: true },
    );
    assert.equal(terrainThresholdSliderModel(0, 300, 150).value, 150);
    assert.equal(terrainThresholdSliderModel(0, 120, 500).value, 120);
    assert.equal(terrainThresholdSliderModel(5, 5).enabled, false);
    assert.equal(terrainThresholdSliderModel(NaN, NaN).enabled, false);
});

function syntheticGrid(values, width = 4, height = 3) {
    const metadata = {
        grid: { width, height, bounds: { west: 16, south: 43, east: 16.04, north: 43.03 } },
        encoding: { scaleM: 1, offsetM: 0, noDataValue: 65535 },
    };
    return new TerrainGrid(metadata, Uint16Array.from(values).buffer);
}

test('viewer URL settings keep intended defaults when parameters are absent', () => {
    const presets = { corridor: 30, split: 10 };
    assert.deepEqual(
        parseTerrainViewerSettings('', presets, { area: 'corridor', stride: 1, verticalScale: 1.5 }),
        {
            area: 'corridor',
            spanKm: 30,
            verticalScale: 1.5,
            stride: 1,
            seaVisible: true,
            wireframe: false,
            basemap: 'relief',
        },
    );
});

test('invalid sampling falls back to the requested native-resolution default', () => {
    const settings = parseTerrainViewerSettings(
        '?stride=3',
        { corridor: 30 },
        { area: 'corridor', stride: 1 },
    );
    assert.equal(settings.stride, 1);
});

test('viewer URL settings validate ranges and toggles', () => {
    const settings = parseTerrainViewerSettings(
        '?area=split&span=99&vertical=0.25&stride=4&sea=0&wire=1&basemap=osm',
        { corridor: 30, split: 10 },
        { area: 'corridor' },
    );
    assert.deepEqual(settings, {
        area: 'split',
        spanKm: 35,
        verticalScale: 1,
        stride: 4,
        seaVisible: false,
        wireframe: true,
        basemap: 'osm',
    });
    assert.equal(
        parseTerrainViewerSettings('?basemap=nonsense', { corridor: 30 }, { area: 'corridor' }).basemap,
        'relief',
    );
});

test('builds north-to-south terrain with upward-facing triangles', () => {
    const grid = syntheticGrid([
        30, 31, 32, 33,
        20, 21, 22, 23,
        10, 11, 12, 13,
    ]);
    const mesh = buildTerrainViewerMeshData(grid, {
        centerLon: 16.02,
        centerLat: 43.015,
        spanM: 50000,
        stride: 1,
    });
    assert.equal(mesh.columns, 4);
    assert.equal(mesh.rows, 3);
    assert.equal(mesh.triangleCount, 12);
    assert.ok(mesh.positions[2] < mesh.positions[(mesh.columns * 3) + 2], 'north row must have smaller z');
    assert.deepEqual([...mesh.indices.slice(0, 6)], [0, 4, 1, 1, 4, 5]);
    assert.equal(mesh.minimumHeightM, 10);
    assert.equal(mesh.maximumHeightM, 33);
});

test('omits every quad touching a DGU no-data sample so sea can show through', () => {
    const grid = syntheticGrid([
        10, 10, 10, 10,
        10, 65535, 10, 10,
        10, 10, 10, 10,
    ]);
    const mesh = buildTerrainViewerMeshData(grid, {
        centerLon: 16.02,
        centerLat: 43.015,
        spanM: 50000,
        stride: 1,
    });
    assert.equal(mesh.validVertexCount, 11);
    assert.equal(mesh.triangleCount, 4, 'two unaffected quads should remain');
    assert.equal(mesh.indices.includes(5), false, 'no triangle may reference the no-data vertex');
});

test('keeps the crop boundary when a stride does not divide the sample count', () => {
    const grid = syntheticGrid(new Array(12).fill(25));
    const mesh = buildTerrainViewerMeshData(grid, {
        centerLon: 16.02,
        centerLat: 43.015,
        spanM: 50000,
        stride: 2,
    });
    assert.equal(mesh.columns, 3, 'columns 0, 2, and final column 3');
    assert.equal(mesh.rows, 2, 'rows 0 and 2');
    assert.equal(mesh.triangleCount, 4);
});

test('hypsometric colour becomes lighter at alpine elevations', () => {
    const low = terrainColorAtHeight(0);
    const high = terrainColorAtHeight(1000);
    assert.ok(high[0] > low[0]);
    assert.ok(high[1] > low[1]);
    assert.ok(high[2] > low[2]);
});

test('hypsometric stops are converted from display sRGB into linear vertex colours', () => {
    const seaLevel = terrainColorAtHeight(0);
    assert.ok(seaLevel[0] < 0.25, 'unconverted 0.47 sRGB red would wash out the relief');
    assert.ok(seaLevel[1] < 0.30, 'unconverted 0.54 sRGB green would wash out the relief');
});

test('source colours are distinct linear-display colours', () => {
    const fine = terrainColorAtSource(0);
    const fallback = terrainColorAtSource(1);
    assert.notDeepEqual(fine, fallback);
    assert.ok(fine.every((channel) => channel >= 0 && channel <= 1));
    assert.ok(fallback.every((channel) => channel >= 0 && channel <= 1));
});

test('maps a clicked local point back to longitude, latitude, and DGU elevation', () => {
    const grid = syntheticGrid([
        30, 31, 32, 33,
        20, 21, 22, 23,
        10, 11, 12, 13,
    ]);
    const view = buildTerrainViewerMeshData(grid, {
        centerLon: 16.02,
        centerLat: 43.015,
        spanM: 50000,
        stride: 1,
    });
    const center = terrainViewerLocationAtLocal(grid, view, 0, 0);
    const southeast = terrainViewerLocationAtLocal(grid, view, 100, 100);
    assert.equal(center.lon, view.centerLon);
    assert.equal(center.lat, view.centerLat);
    assert.ok(Number.isFinite(center.elevationM));
    assert.ok(southeast.lon > center.lon, 'positive x must point east');
    assert.ok(southeast.lat < center.lat, 'positive z must point south');
});
