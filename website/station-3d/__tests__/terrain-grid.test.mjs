// Terrain sampler contract: geographic interpolation, no-data handling, the
// scene-height anchor, slopes, and rigid building foundations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    MosaicTerrainGrid,
    TerrainGrid,
    TerrainReference,
    terrainGridLocalBounds,
} from '../core/terrain-grid.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

function makeGrid(values, { width = 2, height = 2, noDataValue = 65535 } = {}) {
    const encoded = new Uint16Array(values);
    return new TerrainGrid({
        grid: {
            width,
            height,
            bounds: { west: 10, south: 40, east: 12, north: 42 },
        },
        encoding: { type: 'uint16', scaleM: 1, offsetM: 0, noDataValue },
    }, encoded.buffer);
}

test('samples pixel centres and bilinearly interpolates the grid', () => {
    const grid = makeGrid([10, 20, 30, 40]);
    assert.equal(grid.sampleHeight(10.5, 41.5), 10);
    assert.equal(grid.sampleHeight(11.5, 41.5), 20);
    assert.equal(grid.sampleHeight(10.5, 40.5), 30);
    assert.equal(grid.sampleHeight(11, 41), 25);
    assert.equal(grid.sampleHeight(9.9, 41), null);
});

test('renormalises interpolation weights around no-data cells', () => {
    const grid = makeGrid([10, 65535, 30, 50]);
    assert.equal(grid.sampleHeight(11.5, 41.5), null);
    assert.equal(grid.sampleHeight(11, 41), 30);
});

test('keeps a nearest-cell provenance mask separate from interpolated heights', () => {
    const grid = new TerrainGrid({
        grid: {
            width: 2,
            height: 2,
            bounds: { west: 10, south: 40, east: 12, north: 42 },
        },
        encoding: { type: 'uint16', scaleM: 1, offsetM: 0, noDataValue: 65535 },
    }, Uint16Array.from([10, 20, 30, 40]).buffer, {
        sourceArrayBuffer: Uint8Array.from([0, 1, 255, 0]).buffer,
    });
    assert.equal(grid.sourceIndexAt(0, 0), 0);
    assert.equal(grid.sourceIndexAt(1, 0), 1);
    assert.equal(grid.sourceIndexAt(0, 1), null);
    assert.equal(grid.sourceIndexAtLocation(11.5, 41.5), 1);
    assert.equal(grid.sourceIndexAtLocation(20, 50), null);
});

test('keeps absolute heights in the grid and subtracts one scene anchor', () => {
    const grid = makeGrid([100, 120, 140, 160]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    assert.equal(terrain.anchorHeightM, 100);
    assert.equal(terrain.sceneYAt(11.5, 40.5), 60);
    assert.equal(terrain.absoluteToSceneY(0), -100);
    const roundTrip = terrain.lonLatAtLocal(terrain.metresPerDegreeLon, -terrain.metresPerDegreeLat);
    assert.ok(Math.abs(roundTrip.lon - 11.5) < 1e-9);
    assert.ok(Math.abs(roundTrip.lat - 42.5) < 1e-9);
});

test('moving terrain swaps grids without redefining the session height datum', () => {
    const first = makeGrid([100, 100, 100, 100]);
    const second = makeGrid([130, 130, 130, 130]);
    const terrain = new TerrainReference(first, 10.5, 41.5, { surfaceStepM: 1000 });
    const revisions = [];
    terrain.onChange(revision => revisions.push(revision));
    assert.equal(terrain.anchorHeightM, 100);
    terrain.replaceGrid(second);
    assert.equal(terrain.anchorHeightM, 100);
    assert.equal(terrain.sceneYAt(10.5, 41.5), 30);
    assert.deepEqual(revisions, [1]);
});

test('moving terrain publishes bounded change metadata without breaking revision listeners', () => {
    const first = makeGrid([100, 100, 100, 100]);
    const second = makeGrid([130, 130, 130, 130]);
    const terrain = new TerrainReference(first, 10.5, 41.5);
    const changes = [];
    terrain.onChange((revision, change) => changes.push({ revision, change }));
    terrain.replaceGrid(second, {
        changedBounds: { minX: -50, minZ: -60, maxX: 70, maxZ: 80 },
        changedTileKeys: ['0_0', '-1_2', 'bad', '0_0'],
        reason: 'moving-window',
        focus: { x: 10, z: 20, lat: 41.25, lon: 10.75 },
    });
    assert.equal(changes[0].revision, 1);
    assert.deepEqual(changes[0].change.bounds, [
        { minX: -50, minZ: -60, maxX: 70, maxZ: 80 },
    ]);
    assert.deepEqual(changes[0].change.changedTileKeys, ['0_0', '-1_2']);
    assert.deepEqual(changes[0].change.focus, {
        x: 10,
        z: 20,
        lat: 41.25,
        lon: 10.75,
    });
});

test('moving terrain does not publish absent focus coordinates as real zeroes', () => {
    const first = makeGrid([100, 100, 100, 100]);
    const second = makeGrid([130, 130, 130, 130]);
    const terrain = new TerrainReference(first, 10.5, 41.5);
    terrain.replaceGrid(second, {
        focus: { x: null, z: null, lat: null, lon: null },
    });
    assert.equal(terrain.lastChange.focus, null);
});

test('projects terrain-grid coverage into stable session-local bounds', () => {
    const grid = makeGrid([10, 20, 30, 40]);
    const bounds = terrainGridLocalBounds(grid, 11, 41);
    const latScale = DEG_TO_RAD * EARTH_RADIUS_M;
    const lonScale = latScale * Math.cos(41 * DEG_TO_RAD);
    assert.ok(Math.abs(bounds.minX + lonScale) < 1e-6);
    assert.ok(Math.abs(bounds.maxX - lonScale) < 1e-6);
    assert.ok(Math.abs(bounds.minZ + latScale) < 1e-6);
    assert.ok(Math.abs(bounds.maxZ - latScale) < 1e-6);
});

test('terrain-grid bounds reject missing geographic coverage instead of treating it as zero', () => {
    assert.equal(terrainGridLocalBounds({
        west: null,
        east: 12,
        south: 40,
        north: 42,
    }, 11, 41), null);
});

test('mosaics choose the fixed core owner regardless of terrain tile arrival order', () => {
    const west = {
        west: 10,
        east: 11.1,
        south: 40,
        north: 41,
        contains: (lon, lat) => lon >= 10 && lon <= 11.1 && lat >= 40 && lat <= 41,
        sampleHeight: () => 100,
    };
    const east = {
        west: 10.9,
        east: 12,
        south: 40,
        north: 41,
        contains: (lon, lat) => lon >= 10.9 && lon <= 12 && lat >= 40 && lat <= 41,
        sampleHeight: () => 200,
    };
    const items = [
        {
            key: 'west',
            grid: west,
            coreBounds: { west: 10, east: 11, south: 40, north: 41 },
        },
        {
            key: 'east',
            grid: east,
            coreBounds: { west: 11, east: 12, south: 40, north: 41 },
        },
    ];
    const forward = new MosaicTerrainGrid(items);
    const reverse = new MosaicTerrainGrid(items.slice().reverse());
    assert.equal(forward.sampleHeight(10.95, 40.5), 100);
    assert.equal(forward.sampleHeight(11.05, 40.5), 200);
    assert.equal(reverse.sampleHeight(10.95, 40.5), 100);
    assert.equal(reverse.sampleHeight(11.05, 40.5), 200);
    assert.equal(forward.sampleHeight(13, 40.5), null);
});

test('ordinary mosaic samples stay on the allocation-free core-owner path', () => {
    const grid = {
        west: 10,
        east: 12,
        south: 40,
        north: 42,
        contains: (lon, lat) => lon >= 10 && lon <= 12 && lat >= 40 && lat <= 42,
        sampleHeight: () => 150,
    };
    const mosaic = new MosaicTerrainGrid([{
        key: 'core',
        grid,
        coreBounds: { west: 10, east: 12, south: 40, north: 42 },
    }]);
    mosaic._orderedCandidates = () => {
        throw new Error('ordinary samples must not allocate the sorted fallback');
    };
    assert.equal(mosaic.sampleHeight(11, 41), 150);
});

test('fixed-lattice mosaics resolve the core owner without scanning neighbouring cells', () => {
    const containsCalls = [0, 0, 0];
    const items = [10, 11, 12].map((tx, index) => ({
        key: `${tx}_40`,
        coreBounds: { west: tx, east: tx + 1, south: 40, north: 41 },
        grid: {
            west: tx - 0.1,
            east: tx + 1.1,
            south: 39.9,
            north: 41.1,
            contains: (lon, lat) => {
                containsCalls[index] += 1;
                return lon >= tx - 0.1 && lon <= tx + 1.1
                    && lat >= 39.9 && lat <= 41.1;
            },
            sampleHeight: () => 100 + index,
        },
    }));
    const mosaic = new MosaicTerrainGrid(items);
    assert.equal(mosaic.sampleHeight(11.5, 40.5), 101);
    assert.deepEqual(containsCalls, [0, 1, 0]);
});

test('mosaics fall through a no-data collar to another overlapping tile', () => {
    const noData = {
        west: 10,
        east: 11.1,
        south: 40,
        north: 41,
        contains: () => true,
        sampleHeight: () => null,
    };
    const fallback = {
        west: 10.9,
        east: 12,
        south: 40,
        north: 41,
        contains: () => true,
        sampleHeight: () => 123,
    };
    const mosaic = new MosaicTerrainGrid([
        {
            key: 'a',
            grid: noData,
            coreBounds: { west: 10, east: 11, south: 40, north: 41 },
        },
        {
            key: 'b',
            grid: fallback,
            coreBounds: { west: 11, east: 12, south: 40, north: 41 },
        },
    ]);
    assert.equal(mosaic.sampleHeight(10.95, 40.5), 123);
});

test('mosaics distinguish an unloaded core from terminal NoData', () => {
    const collarOnly = {
        west: 10.9,
        east: 12.1,
        south: 39.9,
        north: 41.1,
        contains: (lon, lat) => lon >= 10.9 && lon <= 12.1 && lat >= 39.9 && lat <= 41.1,
        sampleHeight: () => null,
    };
    const mosaic = new MosaicTerrainGrid([{
        key: '11_40',
        grid: collarOnly,
        coreBounds: { west: 11, east: 12, south: 40, north: 41 },
    }]);

    assert.equal(mosaic.contains(10.95, 40.5), true, 'the neighbour padding is loaded');
    assert.equal(mosaic.hasCoreCoverage(10.95, 40.5), false,
        'padding alone cannot prove that NoData is final');
    assert.equal(mosaic.hasCoreCoverage(11.5, 40.5), true,
        'the loaded owning cell makes its NoData terminal');
});

test('places no-data at the absolute fallback datum instead of the anchor plateau', () => {
    const grid = makeGrid([100, 65535, 140, 160]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    assert.equal(terrain.anchorHeightM, 100);
    assert.equal(terrain.sourceSceneYAt(11.5, 41.5), -100);

    const belowSea = new TerrainReference(grid, 10.5, 41.5, { fallbackHeightM: -3 });
    assert.equal(belowSea.sourceSceneYAt(11.5, 41.5), -103);
});

test('keeps visual fallback ground separate from surveyed civil evidence', () => {
    const grid = makeGrid([100, 110, 120, 130]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    const inside = terrain.lonLatAtLocal(0, 0);
    assert.equal(terrain.evidenceSceneYAtLocal(0, 0), 0);
    assert.equal(terrain.sceneYAt(inside.lon, inside.lat), 0);

    const outsideX = terrain.metresPerDegreeLon * 3;
    assert.equal(terrain.evidenceSceneYAtLocal(outsideX, 0), null,
        'an unloaded moving-window point is not elevation evidence');
    assert.equal(terrain.sceneYAtLocal(outsideX, 0), -100,
        'the visible ground still falls back to the datum, so void never shows');
});

test('terrain references expose loaded NoData without treating it as evidence', () => {
    const grid = makeGrid([100, 65535, 120, 130]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    const noData = terrain.lonLatAtLocal(terrain.metresPerDegreeLon, 0);
    const outside = terrain.lonLatAtLocal(terrain.metresPerDegreeLon * 3, 0);

    assert.equal(terrain.evidenceSceneYAt(noData.lon, noData.lat), null);
    assert.equal(terrain.hasLoadedCoreCoverageAt(noData.lon, noData.lat), true);
    assert.equal(terrain.hasLoadedCoreCoverageAt(outside.lon, outside.lat), false);
});

test('terrain-dependent publication requires complete source coverage', () => {
    const grid = makeGrid([100, 110, 120, 130]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    const inside = { x: 0, z: 0 };
    const outside = { x: terrain.metresPerDegreeLon * 3, z: 0 };

    assert.equal(terrain.evidenceReadyForLocalPoints([inside]), true);
    assert.equal(terrain.evidenceReadyForLocalPoints([inside, outside]), false);
    assert.equal(terrain.evidenceReadyForLocalPoints([]), false,
        'an empty footprint is not evidence');

    const readyRing = [
        [10.5, 41.5],
        [10.6, 41.5],
        [10.6, 41.4],
        [10.5, 41.4],
    ];
    assert.notEqual(terrain.evidenceFoundationSceneY(readyRing), null);
    assert.equal(terrain.evidenceFoundationSceneY([
        ...readyRing,
        [20, 50],
    ]), null, 'one unloaded footprint vertex defers the whole rigid building');
});

test('can sample the exact piecewise-planar terrain mesh instead of a second bilinear surface', () => {
    const grid = makeGrid([0, 0, 0, 100]);
    const terrain = new TerrainReference(grid, 10.5, 41.5, { surfaceStepM: 1000 });
    const directDtmY = terrain.sourceSceneYAtLocal(500, 500);
    const visibleMeshY = terrain.sceneYAtLocal(500, 500);
    const evidenceMeshY = terrain.evidenceSceneYAtLocal(500, 500);
    assert.ok(directDtmY > 0);
    assert.ok(Math.abs(visibleMeshY) < 1e-9);
    assert.ok(Math.abs(evidenceMeshY - visibleMeshY) < 1e-9,
        'genuine evidence uses the rendered triangle height, not a second bilinear surface');
    const point = terrain.lonLatAtLocal(500, 500);
    assert.ok(Math.abs(terrain.sceneYAt(point.lon, point.lat) - visibleMeshY) < 1e-9);
});

test('reports a positive pitch when terrain rises along the heading', () => {
    const grid = makeGrid([
        20, 20, 20,
        10, 10, 10,
        0, 0, 0,
    ], { width: 3, height: 3 });
    const terrain = new TerrainReference(grid, 11, 41);
    assert.ok(terrain.slopeAlongHeadingDeg(11, 41, 0, 1000) > 0);
    assert.ok(terrain.slopeAlongHeadingDeg(11, 41, 180, 1000) < 0);
    assert.ok(terrain.evidenceSlopeAlongHeadingDeg(11, 41, 0, 1000) > 0);
    assert.ok(terrain.evidenceNormalAtLocal(0, 0, 500));

    const outsideX = terrain.metresPerDegreeLon * 4;
    assert.equal(terrain.evidenceNormalAtLocal(outsideX, 0, 20), null);
    const outside = terrain.lonLatAtLocal(outsideX, 0);
    assert.equal(
        terrain.evidenceSlopeAlongHeadingDeg(outside.lon, outside.lat, 0, 20),
        null,
        'orientation also waits for terrain surrounding the placement point',
    );
});

test('bases a rigid building foundation at the HIGHEST footprint terrain point', () => {
    // Corners map to scene Y 0/2/4/80 (grid 100/102/104/180 minus the 100 m
    // anchor); the centroid samples 21.5. The base is the max so no part of the
    // building is buried — the downhill gap is filled by the foundation skirt.
    const grid = makeGrid([100, 102, 104, 180]);
    const terrain = new TerrainReference(grid, 10.5, 41.5);
    const foundationY = terrain.foundationSceneY([
        [10.5, 41.5],
        [11.5, 41.5],
        [10.5, 40.5],
        [11.5, 40.5],
    ]);
    assert.equal(foundationY, 80);
});


