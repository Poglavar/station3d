// Locks the OSM drape geometry (core/osm-drape.js): slippy-map mercator
// projection, zoom/tile-cover planning inside the texture and tile budgets,
// and the per-vertex UV mapping into the stitched canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDrapeUvs,
    drapeBoundsFromMesh,
    mercatorNormX,
    mercatorNormY,
    osmDrapePlan,
    osmTileUrl,
} from '../core/osm-drape.js';

test('mercator normalisation matches the slippy-map tile scheme', () => {
    assert.equal(mercatorNormX(0), 0.5);
    assert.equal(mercatorNormY(0), 0.5);
    // Central Zagreb sits in the well-known z13 tile 4459/2920.
    assert.equal(Math.floor(mercatorNormX(15.98) * 8192), 4459);
    assert.equal(Math.floor(mercatorNormY(45.81) * 8192), 2920);
});

test('plan covers the bbox tile-aligned and stays inside the budgets', () => {
    const bounds = { west: 15.80, south: 43.70, east: 15.95, north: 43.79 };
    const plan = osmDrapePlan(bounds);
    assert.ok(plan.zoom >= 3 && plan.zoom <= 17);
    assert.ok(plan.tiles.length <= 150);
    assert.ok(plan.canvasWidthPx <= 4096 && plan.canvasHeightPx <= 4096);
    assert.ok(plan.norm.x0 <= mercatorNormX(bounds.west));
    assert.ok(plan.norm.x1 >= mercatorNormX(bounds.east));
    assert.ok(plan.norm.y0 <= mercatorNormY(bounds.north));
    assert.ok(plan.norm.y1 >= mercatorNormY(bounds.south));
    assert.equal(plan.tiles[0].dxPx, 0);
    assert.equal(plan.tiles[0].dyPx, 0);
    // The canvas is exactly the tile grid.
    assert.equal(plan.canvasWidthPx * plan.canvasHeightPx,
        plan.tiles.length * 256 * 256);
    // A much smaller window earns a deeper zoom.
    const detail = osmDrapePlan({ west: 15.88, south: 43.72, east: 15.90, north: 43.735 });
    assert.ok(detail.zoom > plan.zoom);
    assert.throws(() => osmDrapePlan({ west: 16, south: 44, east: 15, north: 43 }), /ordered bounds/);
});

test('drape UVs project vertices into the canvas with north at v=1', () => {
    const view = {
        centerLon: 15.9,
        centerLat: 43.75,
        metresPerDegreeLon: 80500,
        metresPerDegreeLat: 111320,
        positions: Float32Array.from([
            0, 120, 0, //          centre
            -4025, 80, 0, //       0.05 degrees west
            0, 300, -5566, //      0.05 degrees north (z shrinks northward)
        ]),
    };
    const bounds = drapeBoundsFromMesh(view);
    assert.ok(Math.abs(bounds.west - 15.85) < 1e-4);
    assert.ok(Math.abs(bounds.east - 15.90) < 1e-4);
    assert.ok(Math.abs(bounds.south - 43.75) < 1e-4);
    assert.ok(Math.abs(bounds.north - 43.80) < 1e-4);
    const norm = {
        x0: mercatorNormX(15.8),
        x1: mercatorNormX(16.0),
        y0: mercatorNormY(43.85),
        y1: mercatorNormY(43.65),
    };
    const uvs = buildDrapeUvs(view, norm);
    assert.equal(uvs.length, 6);
    assert.ok(uvs[0] > 0.45 && uvs[0] < 0.55); // centre lands mid-canvas
    assert.ok(uvs[2] < uvs[0]); //                west vertex -> smaller u
    assert.ok(uvs[5] > uvs[1]); //                north vertex -> larger v
    for (const value of uvs) assert.ok(value >= 0 && value <= 1);
});

test('tile URL hits the standard OSM raster endpoint', () => {
    assert.equal(osmTileUrl(13, 4459, 2920), 'https://tile.openstreetmap.org/13/4459/2920.png');
});
