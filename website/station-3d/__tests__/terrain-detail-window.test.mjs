// The camera-centred 1 m terrain window (Station3D docs/performance/audit.md):
// composite grid sampling, the detail request geometry, and the two-step
// planar surface with its watertight boundary rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CompositeTerrainGrid,
    createCompositeTerrainGridBuildIterator,
    TerrainGrid,
    TerrainReference,
} from '../core/terrain-grid.js';
import { planTerrainDetailRefresh } from '../core/terrain-detail-change.js';
import {
    resolveDetailTerrainWindowRequest,
    resolveRouteBandTerrainRequests,
} from '../core/terrain-grid-request.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const ANCHOR_LON = 16.28;
const ANCHOR_LAT = 43.53;
const M_PER_LAT = DEG_TO_RAD * EARTH_RADIUS_M;
const M_PER_LON = M_PER_LAT * Math.cos(ANCHOR_LAT * DEG_TO_RAD);
const terrainLayerSource = readFileSync(
    new URL('../world/terrain.js', import.meta.url),
    'utf8',
);

// Encodes heightFn(lon, lat) into a real TerrainGrid raster over the given
// local-metre bounds (relative to the anchor), so the tests exercise the real
// decode/sample path instead of a stub.
function makeGrid({ minX, maxX, minZ, maxZ, cellM, heightFn, sourceFn = null }) {
    const west = ANCHOR_LON + minX / M_PER_LON;
    const east = ANCHOR_LON + maxX / M_PER_LON;
    const north = ANCHOR_LAT - minZ / M_PER_LAT;
    const south = ANCHOR_LAT - maxZ / M_PER_LAT;
    const width = Math.max(2, Math.round((maxX - minX) / cellM));
    const height = Math.max(2, Math.round((maxZ - minZ) / cellM));
    const values = new Uint16Array(width * height);
    const sourceValues = sourceFn ? new Uint8Array(width * height) : null;
    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            const lon = west + ((column + 0.5) / width) * (east - west);
            const lat = north - ((row + 0.5) / height) * (north - south);
            const x = (lon - ANCHOR_LON) * M_PER_LON;
            const z = -(lat - ANCHOR_LAT) * M_PER_LAT;
            const heightM = heightFn(x, z);
            values[row * width + column] = heightM === null
                ? 65535
                : Math.round((heightM + 100) / 0.1);
            if (sourceValues) sourceValues[row * width + column] = sourceFn(x, z);
        }
    }
    return new TerrainGrid({
        grid: { width, height, bounds: { west, east, south, north } },
        encoding: { scaleM: 0.1, offsetM: -100, noDataValue: 65535 },
        source: sourceValues ? {
            sources: [
                { index: 0, key: 'dgu-lidar-dmr', resolutionM: 1 },
                { index: 1, key: 'dgu-dtm-20m', resolutionM: 20 },
            ],
        } : undefined,
    }, values.buffer, {
        sourceArrayBuffer: sourceValues?.buffer || null,
    });
}

const flat10 = () => 10;
// A smooth bump the coarse base cannot represent at its cell size.
const bump = (x, z) => 10 + 8 * Math.exp(-((x - 200) ** 2 + (z - 200) ** 2) / 4000);

test('composite grid: detail wins inside, base outside, holes fall through', () => {
    const base = makeGrid({ minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000, cellM: 20, heightFn: flat10 });
    const detail = makeGrid({
        minX: 0, maxX: 400, minZ: 0, maxZ: 400, cellM: 1,
        heightFn: (x, z) => (x > 180 && x < 190 && z > 180 && z < 190 ? null : bump(x, z)),
    });
    const composite = new CompositeTerrainGrid(base, detail, { blendMarginM: 24 });
    const at = (x, z) => composite.sampleHeight(
        ANCHOR_LON + x / M_PER_LON,
        ANCHOR_LAT - z / M_PER_LAT,
    );
    assert.ok(Math.abs(at(200, 200) - bump(200, 200)) < 0.2, 'detail wins deep inside');
    assert.ok(Math.abs(at(1000, 1000) - 10) < 0.2, 'base outside the window');
    assert.ok(Math.abs(at(185, 185) - 10) < 0.6, 'a detail NoData hole falls through to base');
    const edge = at(200, 2);
    assert.ok(
        edge > 9.5 && edge < bump(200, 2) + 0.5,
        `blend band stays between base and detail (${edge})`,
    );
});

test('composite grid feathers coarse fallback into a LiDAR coverage edge', () => {
    const base = makeGrid({
        minX: -200, maxX: 600, minZ: -200, maxZ: 600, cellM: 20,
        heightFn: () => 100,
    });
    const detail = makeGrid({
        minX: 0, maxX: 400, minZ: 0, maxZ: 400, cellM: 1,
        heightFn: (x) => (x >= 200 ? 102 : 100),
        sourceFn: (x) => (x >= 200 ? 0 : 1),
    });
    const composite = new CompositeTerrainGrid(base, detail, {
        blendMarginM: 0,
        sourceBlendMarginM: 48,
    });
    const at = (x) => composite.sampleHeight(
        ANCHOR_LON + x / M_PER_LON,
        ANCHOR_LAT - 200 / M_PER_LAT,
    );

    assert.ok(Math.abs(at(240) - 102) < 0.15, 'authoritative LiDAR stays unchanged');
    assert.ok(Math.abs(at(140) - 100) < 0.15, 'distant DTM fallback stays unchanged');
    assert.ok(at(190) > 101.5, 'nearby DTM rises to meet the LiDAR edge');
    assert.ok(Math.abs(at(200) - 102) < 0.15, 'the source boundary has no mixed-source notch');
    assert.ok(
        Math.abs(at(199.5) - at(200.5)) < 0.2,
        `source edge is continuous (${at(199.5)} vs ${at(200.5)})`,
    );
});

test('cooperative composite preparation preserves source-edge sampling exactly', () => {
    const base = makeGrid({
        minX: -100, maxX: 180, minZ: -100, maxZ: 180, cellM: 20,
        heightFn: () => 100,
    });
    const detail = makeGrid({
        minX: 0, maxX: 80, minZ: 0, maxZ: 80, cellM: 1,
        heightFn: x => (x >= 40 ? 102 : 100),
        sourceFn: x => (x >= 40 ? 0 : 1),
    });
    const expected = new CompositeTerrainGrid(base, detail, {
        blendMarginM: 0,
        sourceBlendMarginM: 48,
    });
    const iterator = createCompositeTerrainGridBuildIterator(base, detail, {
        blendMarginM: 0,
        sourceBlendMarginM: 48,
        rowsPerStep: 4,
    });
    let checkpoints = 0;
    let step = iterator.next();
    while (!step.done) {
        checkpoints += 1;
        assert.equal(step.value.phase, 'source-boundary-rows');
        step = iterator.next();
    }
    const cooperative = step.value;
    const reused = new CompositeTerrainGrid(base, detail, {
        blendMarginM: 0,
        sourceBlendMarginM: 48,
        sourceBoundaries: cooperative.sourceBoundaryIndexSnapshot(),
    });
    const sample = (grid, x) => grid.sampleHeight(
        ANCHOR_LON + x / M_PER_LON,
        ANCHOR_LAT - 40 / M_PER_LAT,
    );

    assert.ok(checkpoints >= 10, `expected row checkpoints, got ${checkpoints}`);
    for (const x of [10, 30, 38, 39.5, 40, 40.5, 42, 60, 75]) {
        assert.equal(cooperative.sampleHeight(
            ANCHOR_LON + x / M_PER_LON,
            ANCHOR_LAT - 40 / M_PER_LAT,
        ), sample(expected, x));
        assert.equal(sample(reused, x), sample(expected, x));
    }
});

test('detail window request: centred bbox, shrinks instead of coarsening', () => {
    const request = resolveDetailTerrainWindowRequest(
        { anchorLon: ANCHOR_LON, anchorLat: ANCHOR_LAT },
        { halfSizeM: 550, elevationSource: 'best-available' },
    );
    assert.equal(request.source, 'best-available');
    assert.equal(request.scope, 'detail-window');
    assert.ok(request.estimatedCells <= 2_400_000);
    assert.equal(request.halfSizeM, 550, 'a fitting window is not shrunk');
    const [west, south, east, north] = request.bbox;
    assert.ok(Math.abs((west + east) / 2 - ANCHOR_LON) < 1e-9);
    assert.ok(Math.abs((south + north) / 2 - ANCHOR_LAT) < 1e-9);
    assert.ok(Math.abs((north - south) * M_PER_LAT - 1100) < 5);

    const capped = resolveDetailTerrainWindowRequest(
        { anchorLon: ANCHOR_LON, anchorLat: ANCHOR_LAT },
        { halfSizeM: 5000, elevationSource: 'best-available' },
    );
    assert.ok(capped.estimatedCells <= 2_400_000, 'cell budget holds');
    assert.ok(capped.halfSizeM < 5000, 'the window shrinks, the resolution stays');
    assert.equal(capped.resolutionDeg, 0.000008);
});

test('moving terrain rejects stale support batches and reserves base request slots', () => {
    const ensureStart = terrainLayerSource.indexOf(
        'function ensureStreamedTerrainWindow',
    );
    const ensureEnd = terrainLayerSource.indexOf(
        'function beginStreamedTerrainDetailRefresh',
        ensureStart,
    );
    const ensureSource = terrainLayerSource.slice(ensureStart, ensureEnd);
    assert.match(ensureSource, /const requestToken = \+\+state\.baseRequestToken/);
    assert.match(
        ensureSource,
        /requestToken !== state\.baseRequestToken/,
        'an obsolete camera-window completion must not publish terrain bounds',
    );
    assert.match(terrainLayerSource, /baseRequestToken:\s*0/);

    assert.match(
        terrainLayerSource,
        /TERRAIN_GRID_DETAIL_REQUEST_GROUP = 'terrain-grid-detail'/,
    );
    assert.ok(
        terrainLayerSource.match(
            /requestGroupKey:\s*TERRAIN_GRID_DETAIL_REQUEST_GROUP/g,
        )?.length >= 2,
        'both the fine-source probe and detail payload use the cosmetic request group',
    );
    assert.match(
        terrainLayerSource,
        /requestGroupLimit:\s*TERRAIN_GRID_MAX_CONCURRENT_DETAIL_REQUESTS/,
        'a long-running fine request cannot occupy both base-support slots',
    );
});

test('moving detail terrain replaces a request that left the camera window', () => {
    const inFlight = {
        inFlight: true,
        inFlightCenter: { x: 0, z: 0 },
        publishedCenter: { x: -400, z: 0 },
    };
    assert.deepEqual(
        planTerrainDetailRefresh(inFlight, { x: 419, z: 0 }),
        { action: 'keep', distanceM: 419 },
        'an in-window request remains authoritative',
    );
    assert.deepEqual(
        planTerrainDetailRefresh(inFlight, { x: 421, z: 0 }),
        { action: 'replace', distanceM: 421 },
        'distance is measured from the pending request, not stale published terrain',
    );
    assert.deepEqual(
        planTerrainDetailRefresh({
            inFlight: false,
            publishedCenter: { x: 100, z: 100 },
        }, { x: 520, z: 100 }),
        { action: 'start', distanceM: 420 },
    );
    assert.deepEqual(
        planTerrainDetailRefresh(inFlight, { x: null, z: 0 }),
        { action: 'none', distanceM: Infinity },
        'missing coordinates never become a real origin',
    );
});

test('two-step surface: fine inside the rect, coarse outside, watertight boundary', () => {
    const base = makeGrid({ minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000, cellM: 20, heightFn: bump });
    const detail = makeGrid({ minX: -60, maxX: 460, minZ: -60, maxZ: 460, cellM: 1, heightFn: bump });
    const composite = new CompositeTerrainGrid(base, detail, { blendMarginM: 24 });
    const rect = {
        stepM: 4,
        tileM: 400,
        rects: [{ minX: 0, maxX: 400, minZ: 0, maxZ: 400 }],
    };
    const fine = new TerrainReference(composite, ANCHOR_LON, ANCHOR_LAT, {
        surfaceStepM: 20,
        detail: rect,
    });
    const coarse = new TerrainReference(composite, ANCHOR_LON, ANCHOR_LAT, {
        surfaceStepM: 20,
    });

    // Outside the rect the two references are the same surface.
    assert.equal(fine.sceneYAtLocal(700, 700), coarse.sceneYAtLocal(700, 700));
    assert.equal(fine.sceneYAtLocal(-500, 100), coarse.sceneYAtLocal(-500, 100));

    // Inside, the fine surface resolves the bump peak better than the coarse
    // 20 m planar surface can between its corners.
    const peakTrue = bump(202, 202) - fine.anchorHeightM;
    const fineError = Math.abs(fine.sceneYAtLocal(202, 202) - peakTrue);
    const coarseError = Math.abs(coarse.sceneYAtLocal(202, 202) - peakTrue);
    assert.ok(
        fineError < coarseError - 0.01,
        `fine surface tracks the bump (fine ${fineError.toFixed(3)} m, coarse ${coarseError.toFixed(3)} m)`,
    );

    // Watertight boundary: ON the rect edge the fine surface equals the
    // coarse surface — at coarse corners AND between them (the fine corners
    // on the edge take the coarse edge's linear value).
    for (const x of [0, 4, 8, 20, 36, 152, 396, 400]) {
        assert.ok(
            Math.abs(fine.sceneYAtLocal(x, 0) - coarse.sceneYAtLocal(x, 0)) < 1e-9,
            `boundary z=0 continuous at x=${x}`,
        );
        assert.ok(
            Math.abs(fine.sceneYAtLocal(0, x) - coarse.sceneYAtLocal(0, x)) < 1e-9,
            `boundary x=0 continuous at z=${x}`,
        );
        assert.ok(
            Math.abs(fine.sceneYAtLocal(x, 400) - coarse.sceneYAtLocal(x, 400)) < 1e-9,
            `boundary z=400 continuous at x=${x}`,
        );
    }

    // A degenerate or coarse-step detail region is refused rather than obeyed.
    const refused = new TerrainReference(composite, ANCHOR_LON, ANCHOR_LAT, {
        surfaceStepM: 20,
        detail: {
            stepM: 20,
            tileM: 400,
            rects: [{ minX: 0, maxX: 400, minZ: 0, maxZ: 400 }],
        },
    });
    assert.equal(refused.detail, null);
});

test('route band: chunks cover the corridor, budget narrows the band honestly', () => {
    // A ~6 km diagonal corridor with sparse vertices (one 4 km straight leg),
    // so chunk cuts must interpolate rather than lean on vertex spacing.
    const route = {
        geometry: {
            type: 'LineString',
            coordinates: [
                [ANCHOR_LON, ANCHOR_LAT],
                [ANCHOR_LON + 1000 / M_PER_LON, ANCHOR_LAT + 800 / M_PER_LAT],
                [ANCHOR_LON + 4000 / M_PER_LON, ANCHOR_LAT + 3200 / M_PER_LAT],
                [ANCHOR_LON + 4400 / M_PER_LON, ANCHOR_LAT + 3900 / M_PER_LAT],
            ],
        },
    };
    const ctx = {
        anchorLon: ANCHOR_LON,
        anchorLat: ANCHOR_LAT,
        customTrackCorridors: [route],
    };
    const band = resolveRouteBandTerrainRequests(ctx, {
        bandHalfM: 100,
        elevationSource: 'best-available',
    });
    assert.ok(band.requests.length >= 3, `chunked (${band.requests.length})`);
    assert.equal(band.droppedChunks, 0);
    for (const request of band.requests) {
        assert.ok(request.estimatedCells <= 2_400_000, 'chunk under the per-request cap');
        assert.equal(request.source, 'best-available');
    }
    // Every route vertex sits inside some chunk bbox with the band to spare.
    const marginDeg = 90 / M_PER_LAT;
    for (const [lon, lat] of route.geometry.coordinates) {
        const covered = band.requests.some(({ bbox: [west, south, east, north] }) => (
            lon >= west + marginDeg && lon <= east - marginDeg
            && lat >= south + marginDeg && lat <= north - marginDeg
        ));
        assert.ok(covered, `vertex ${lon.toFixed(4)},${lat.toFixed(4)} covered with band margin`);
    }

    // A tight total budget narrows the band instead of coarsening, and says
    // what it dropped when even that cannot fit.
    const squeezed = resolveRouteBandTerrainRequests(ctx, {
        bandHalfM: 100,
        elevationSource: 'best-available',
        maximumTotalCells: 2_000_000,
    });
    assert.ok(squeezed.bandHalfM < 100, `band narrowed to ±${squeezed.bandHalfM.toFixed(0)} m`);
    assert.ok(
        squeezed.requests.reduce((sum, request) => sum + request.estimatedCells, 0)
            <= 2_000_000,
    );

    // A corridor far beyond the walk neighbourhood requests nothing.
    const farAway = resolveRouteBandTerrainRequests(
        { anchorLon: ANCHOR_LON + 1, anchorLat: ANCHOR_LAT, customTrackCorridors: [route] },
        { bandHalfM: 100, elevationSource: 'best-available' },
    );
    assert.equal(farAway.requests.length, 0);
});

test('multi-window surface: chunk joins stay full-detail and tile-union boundary holds', () => {
    const base = makeGrid({ minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000, cellM: 20, heightFn: bump });
    // Two overlapping 1 m chunks along x, like adjacent route-band windows.
    const chunkA = makeGrid({ minX: -60, maxX: 500, minZ: -60, maxZ: 460, cellM: 1, heightFn: bump });
    const chunkB = makeGrid({ minX: 300, maxX: 900, minZ: -60, maxZ: 460, cellM: 1, heightFn: bump });
    const composite = new CompositeTerrainGrid(base, [chunkA, chunkB], { blendMarginM: 24 });

    // At the join (x=400..460 is interior of B but the blend edge of A and
    // vice versa), the deeper-inside chunk must win: no dip toward the base.
    const at = (x, z) => composite.sampleHeight(
        ANCHOR_LON + x / M_PER_LON,
        ANCHOR_LAT - z / M_PER_LAT,
    );
    for (const x of [310, 360, 420, 480]) {
        assert.ok(
            Math.abs(at(x, 200) - bump(x, 200)) < 0.2,
            `full detail across the chunk join at x=${x}`,
        );
    }

    const reference = new TerrainReference(composite, ANCHOR_LON, ANCHOR_LAT, {
        surfaceStepM: 20,
        detail: {
            stepM: 4,
            tileM: 400,
            rects: [
                { minX: 0, maxX: 480, minZ: 0, maxZ: 400 },
                { minX: 320, maxX: 880, minZ: 0, maxZ: 400 },
            ],
        },
    });
    // Tile (0,0) is inside rect A alone, tile (1,0) inside rect B alone —
    // both fine even though NEITHER rect covers their union.
    assert.equal(reference.isFineTile(0, 0), true);
    assert.equal(reference.isFineTile(1, 0), true);
    assert.equal(reference.isFineTile(2, 0), false, 'x 800..1200 exceeds both rects');
    assert.equal(reference.isFineTile(0, 1), false, 'z 400..800 exceeds both rects');

    // Continuity across the fine-tile boundary at x=800: the fine surface's
    // boundary corners take the coarse value, matching the coarse tile beyond.
    const coarse = new TerrainReference(composite, ANCHOR_LON, ANCHOR_LAT, {
        surfaceStepM: 20,
    });
    for (const z of [0, 4, 40, 396, 400]) {
        assert.ok(
            Math.abs(reference.sceneYAtLocal(800, z) - coarse.sceneYAtLocal(800, z)) < 1e-9,
            `union boundary x=800 continuous at z=${z}`,
        );
    }
    // Deep inside tile (1,0), spanning the two chunks' data, the surface is fine.
    const trueY = bump(420, 202) - reference.anchorHeightM;
    assert.ok(Math.abs(reference.sceneYAtLocal(420, 202) - trueY) < 0.25);
});

test('the moving refresh composes the windows just left behind instead of dropping them', () => {
    const refresh = terrainLayerSource.slice(
        terrainLayerSource.indexOf('function beginStreamedTerrainDetailRefresh('),
        terrainLayerSource.indexOf('function clearTerrain('),
    );
    assert.match(refresh, /retainTrailingDetailWindows\(\s*\[state\.currentDetail, \.\.\.state\.retainedDetails\]\.filter\(Boolean\)/,
        'the previous window and the retained ones are the candidates');
    assert.match(refresh, /mergePreparedDetails\(\s*preparedDetail,\s*retainedDetails\.map\(entry => entry\.preparedDetail\)/,
        'the composite is built from the merged windows');
    assert.match(refresh, /composeTerrainWindow\(\s*streamedTerrainBaseGrid\(state\),\s*mergedDetail,/);
    assert.match(refresh, /state\.preparedDetail = mergedDetail;/, 'a later base change re-wraps the same merged windows');
    assert.match(terrainLayerSource, /const TRAILING_DETAIL_WINDOWS = 2;/);
    assert.match(terrainLayerSource, /streamState\.preparedDetail = preparedDetail;\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*streamState\.currentDetail = preparedDetail\s*\? \{ preparedDetail, centerX: 0, centerZ: 0, publishedAt: Date\.now\(\) \}/,
        'the startup window is the first window kept behind the player');
});
