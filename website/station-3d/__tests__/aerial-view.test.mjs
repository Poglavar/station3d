// Locks the aerial view's numbers: fog that opens with height, a far terrain
// window inside both API limits, land cover by vegetation type, and a far
// terrain mesh that leaves the sea open and faces the sky.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AERIAL_VIEW_DEFAULTS,
    FAR_TERRAIN_MAX_CELLS,
    LAND_COVER,
    LAND_COVER_MAX_SPAN_DEG,
    SESSION_FOG_DEFAULTS,
    aerialFogAtHeight,
    buildFarTerrainGeometryData,
    createFarTerrainGeometryBuilder,
    createLandCoverRaster,
    farTerrainCoverageMask,
    farTerrainLattice,
    farTerrainNeedsRecenter,
    farTerrainWindow,
    landCoverClassForType,
    rasterizeLandCover,
    resolveAerialViewConfig,
} from '../core/aerial-view.js';
import { geoToLocal, localToGeo } from '../core/math.js';

const ANCHOR = Object.freeze({ lon: 16.18, lat: 43.06 });

test('an authored aerial view resolves to defaults and refuses a fog that does not open', () => {
    assert.equal(resolveAerialViewConfig(null), null);
    assert.equal(resolveAerialViewConfig(false), null);
    const config = resolveAerialViewConfig(true);
    assert.equal(config.farTerrainHalfSizeM, AERIAL_VIEW_DEFAULTS.farTerrainHalfSizeM);
    assert.deepEqual(config.fog, AERIAL_VIEW_DEFAULTS.fog);
    assert.equal(resolveAerialViewConfig({ fog: { farM: 6000 } }).fog.farM, 6000);
    assert.throws(() => resolveAerialViewConfig({ fog: { nearM: 5000, farM: 4000 } }), /fog\.farM/);
    assert.throws(() => resolveAerialViewConfig({ farTerrainCellM: 0 }), /farTerrainCellM/);
    assert.throws(() => resolveAerialViewConfig({ fogStartHeightM: 300 }), /fogFullHeightM/);
});

test('fog stays the session\'s own on the ground and opens to the aerial distance with height', () => {
    const config = resolveAerialViewConfig(true);
    assert.equal(aerialFogAtHeight(2, config), null);
    assert.equal(aerialFogAtHeight(config.fogStartHeightM, config), null);
    assert.equal(aerialFogAtHeight(null, config), null);
    assert.deepEqual(aerialFogAtHeight(config.fogFullHeightM + 50, config), {
        nearM: config.fog.nearM,
        farM: config.fog.farM,
        cameraFarM: config.fog.cameraFarM,
    });
    let previousFar = SESSION_FOG_DEFAULTS.farM;
    for (let height = config.fogStartHeightM + 5; height <= config.fogFullHeightM; height += 5) {
        const fog = aerialFogAtHeight(height, config);
        assert.ok(fog.farM >= previousFar, `the far edge never closes in while climbing (${height} m)`);
        assert.ok(fog.cameraFarM >= fog.farM + 200, 'the far plane stays behind the fog');
        previousFar = fog.farM;
    }
    // A session with its own fog opens from that, not from the defaults.
    const custom = aerialFogAtHeight(config.fogStartHeightM + 1, config, { nearM: 100, farM: 700, cameraFarM: 1500 });
    assert.ok(custom.farM < 800, `${custom.farM}`);
});

test('the far window stays inside the terrain grid and decor API limits at Croatian latitudes', () => {
    const config = resolveAerialViewConfig(true);
    for (const centerLat of [42.4, 43.08, 45.81, 46.5]) {
        const window = farTerrainWindow({
            centerLat,
            centerLon: 16.17,
            halfSizeM: config.farTerrainHalfSizeM,
            cellM: config.farTerrainCellM,
        });
        assert.ok(window.approxCells < FAR_TERRAIN_MAX_CELLS, `${window.approxCells} cells`);
        assert.ok(window.spanLonDeg <= LAND_COVER_MAX_SPAN_DEG, `lon span ${window.spanLonDeg}`);
        assert.ok(window.spanLatDeg <= LAND_COVER_MAX_SPAN_DEG, `lat span ${window.spanLatDeg}`);
        assert.ok(Math.abs(window.resolutionDeg * 111195 - config.farTerrainCellM) < 1);
        assert.ok(window.bbox[0] < 16.17 && window.bbox[2] > 16.17);
        assert.ok(window.bbox[1] < centerLat && window.bbox[3] > centerLat);
    }
});

test('a far window is centred on its focus and rebuilt only once the focus has moved well inside it', () => {
    const lattice = farTerrainLattice({ centerX: 100, centerZ: -50, halfSizeM: 9000, cellM: 80 });
    assert.equal(lattice.columns, lattice.rows);
    assert.equal(lattice.columns, Math.ceil(18000 / 80) + 1);
    assert.ok(Math.abs(lattice.originX + ((lattice.columns - 1) * 80) / 2 - 100) < 1e-9);
    assert.equal(farTerrainNeedsRecenter(null, { x: 0, z: 0 }, 2500), true);
    assert.equal(farTerrainNeedsRecenter(lattice, { x: 2000, z: -50 }, 2500), false);
    assert.equal(farTerrainNeedsRecenter(lattice, { x: 2700, z: -50 }, 2500), true);
    assert.equal(farTerrainNeedsRecenter(lattice, { x: null, z: 0 }, 2500), false, 'an unknown focus keeps the window');
});

function squareFeature(t, centerX, centerZ, halfM, holeHalfM = 0) {
    const ring = half => [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
        .map(([dx, dz]) => {
            const point = localToGeo(centerX + dx, centerZ + dz, ANCHOR.lon, ANCHOR.lat);
            return [point.lon, point.lat];
        });
    return {
        type: 'Feature',
        properties: { t },
        geometry: { type: 'Polygon', coordinates: holeHalfM ? [ring(halfM), ring(holeHalfM)] : [ring(halfM)] },
    };
}

test('land cover follows the vegetation types, the wood wins over the meadow, and holes stay open', () => {
    assert.equal(landCoverClassForType('forest'), LAND_COVER.FOREST);
    assert.equal(landCoverClassForType('scrub'), LAND_COVER.MEADOW);
    assert.equal(landCoverClassForType('parking'), null);
    const lattice = farTerrainLattice({ centerX: 0, centerZ: 0, halfSizeM: 400, cellM: 50 });
    const classes = rasterizeLandCover([
        squareFeature('meadow', 0, 0, 300),
        squareFeature('forest', 0, 0, 160, 60),
        squareFeature('parking', 200, 200, 100),
    ], lattice, { anchorLon: ANCHOR.lon, anchorLat: ANCHOR.lat });
    const at = (x, z) => classes[
        Math.round((z - lattice.originZ) / 50) * lattice.columns + Math.round((x - lattice.originX) / 50)
    ];
    assert.equal(at(-400, -400), LAND_COVER.BARE, 'outside every polygon');
    assert.equal(at(250, 0), LAND_COVER.MEADOW);
    assert.equal(at(100, 100), LAND_COVER.FOREST, 'the wood inside the meadow');
    assert.equal(at(0, 0), LAND_COVER.MEADOW, 'the clearing in the wood keeps the meadow around it');
    assert.equal(at(250, 250), LAND_COVER.MEADOW, 'parking is not vegetation and changes nothing');
});

test('the far terrain mesh leaves the sea open, sinks under the streamed tiles and faces the sky', () => {
    const lattice = farTerrainLattice({ centerX: 0, centerZ: 0, halfSizeM: 1000, cellM: 100 });
    const heightAt = (lon, lat) => {
        const { x, z } = geoToLocal(lon, lat, ANCHOR.lon, ANCHOR.lat);
        const radius = Math.hypot(x, z);
        return radius < 450 ? 120 - radius * 0.2 : null;
    };
    const data = buildFarTerrainGeometryData({
        lattice,
        anchorLon: ANCHOR.lon,
        anchorLat: ANCHOR.lat,
        heightAt,
        toSceneY: height => height - 5,
        seaLevelCutM: 0.4,
        dropM: 1.5,
    });
    assert.equal(data.vertexCount, lattice.columns * lattice.rows);
    assert.ok(data.landVertexCount > 0 && data.landVertexCount < data.vertexCount);
    assert.equal(data.triangleCount, data.indices.length / 3);
    const seaVertexY = -5 - 1.5;
    const vertex = index => [0, 1, 2].map(axis => data.positions[index * 3 + axis]);
    for (let offset = 0; offset < data.indices.length; offset += 3) {
        const [a, b, c] = [0, 1, 2].map(k => vertex(data.indices[offset + k]));
        assert.ok([a, b, c].some(point => point[1] > seaVertexY + 1e-4), 'a sea-only triangle would cover the water');
        const ux = b[0] - a[0];
        const uz = b[2] - a[2];
        const vx = c[0] - a[0];
        const vz = c[2] - a[2];
        assert.ok(uz * vx - ux * vz > 0, 'front faces look up at the sky');
    }
    const centre = Math.round(-lattice.originZ / 100) * lattice.columns + Math.round(-lattice.originX / 100);
    assert.ok(Math.abs(vertex(centre)[1] - (120 - 5 - 1.5)) < 1e-4);
    assert.ok(Array.from(data.colors).every(value => value >= 0 && value <= 1));
    assert.equal(buildFarTerrainGeometryData({
        lattice, anchorLon: ANCHOR.lon, anchorLat: ANCHOR.lat, heightAt: () => null, toSceneY: h => h,
    }).triangleCount, 0, 'open sea draws no far terrain at all');
});

test('built a few rows per frame, the far terrain is identical to the whole-window build', () => {
    const lattice = farTerrainLattice({ centerX: 40, centerZ: -60, halfSizeM: 700, cellM: 70 });
    const heightAt = (lon, lat) => {
        const { x, z } = geoToLocal(lon, lat, ANCHOR.lon, ANCHOR.lat);
        return x > 0 ? 30 + z * 0.01 : null;
    };
    const raster = createLandCoverRaster(lattice, { anchorLon: ANCHOR.lon, anchorLat: ANCHOR.lat });
    raster.addFeature(squareFeature('forest', 300, 0, 150));
    const options = { lattice, anchorLon: ANCHOR.lon, anchorLat: ANCHOR.lat, heightAt, toSceneY: h => h, classes: raster.classes };
    const whole = buildFarTerrainGeometryData(options);
    const builder = createFarTerrainGeometryBuilder(options);
    assert.throws(() => builder.finish(), /before every row/);
    let steps = 0;
    while (!builder.stepRows(3)) steps += 1;
    const chunked = builder.finish();
    assert.ok(steps > 3, 'the build really was spread over several steps');
    assert.deepEqual(chunked.positions, whole.positions);
    assert.deepEqual(chunked.colors, whole.colors);
    assert.deepEqual(chunked.normals, whole.normals);
    assert.deepEqual(chunked.indices, whole.indices);
    assert.deepEqual(chunked.bounds, whole.bounds);
    assert.ok(raster.classes.some(value => value === LAND_COVER.FOREST));
});

// Normals and bounds come out of the row steps, so publishing the far island
// never walks the whole mesh in one frame.
test('far terrain normals face up on the flat and lean downhill on a slope, and the bounds hold every vertex', () => {
    const lattice = farTerrainLattice({ centerX: 0, centerZ: 0, halfSizeM: 500, cellM: 100 });
    const build = heightAt => buildFarTerrainGeometryData({
        lattice, anchorLon: ANCHOR.lon, anchorLat: ANCHOR.lat, heightAt, toSceneY: h => h, dropM: 0,
    });
    const normalAt = (data, index) => [0, 1, 2].map(axis => data.normals[index * 3 + axis]);
    const flat = build(() => 80);
    for (let index = 0; index < flat.vertexCount; index++) {
        const [x, y, z] = normalAt(flat, index);
        assert.ok(Math.abs(x) < 1e-6 && Math.abs(y - 1) < 1e-6 && Math.abs(z) < 1e-6, `flat normal ${index}`);
    }
    // Rising 0.2 m per metre to the east: every normal, edges included, leans west.
    const slope = build((lon, lat) => 150 + 0.2 * geoToLocal(lon, lat, ANCHOR.lon, ANCHOR.lat).x);
    const expected = [-0.2, 1, 0].map(value => value / Math.hypot(0.2, 1));
    for (let index = 0; index < slope.vertexCount; index++) {
        const normal = normalAt(slope, index);
        assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-5, `unit normal ${index}`);
        normal.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-3, `slope normal ${index} axis ${axis}`));
    }
    const axisRange = axis => {
        const values = Array.from({ length: slope.vertexCount }, (_, index) => slope.positions[index * 3 + axis]);
        return [Math.min(...values), Math.max(...values)];
    };
    const { bounds } = slope;
    assert.deepEqual([bounds.minX, bounds.maxX], axisRange(0));
    assert.deepEqual([bounds.minY, bounds.maxY], axisRange(1));
    assert.deepEqual([bounds.minZ, bounds.maxZ], axisRange(2));
});

test('streamed tiles are marked in the coverage mask so the coarse surface steps aside for them', () => {
    const published = new Set(['0_0', '1_0', '0_-1']);
    const mask = farTerrainCoverageMask({
        centerX: 0,
        centerZ: 0,
        halfSizeM: 1200,
        tileM: 400,
        isPublishedAt: (x, z) => published.has(`${Math.floor(x / 400)}_${Math.floor(z / 400)}`),
    });
    assert.equal(mask.published, 3);
    const byte = (tileX, tileZ) => mask.data[
        ((tileZ * 400 - mask.originZ) / 400) * mask.size + (tileX * 400 - mask.originX) / 400
    ];
    assert.equal(byte(0, 0), 255);
    assert.equal(byte(1, 0), 255);
    assert.equal(byte(0, -1), 255);
    assert.equal(byte(-1, 0), 0);
});
