// Verifies the pure configuration and building-footprint inputs to the urban terrain mask.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectProjectedBuildingOuterRings,
    collectProjectedBuildingOuterRingsCooperative,
    createProjectedBuildingRingCache,
    createUrbanGroundMaskBuildTask,
    normalizeUrbanGroundConfig,
    urbanGroundMaskBuildIsCurrent,
} from '../core/urban-ground.js';

test('normalizes bounded urban-ground defaults without enabling absent config', () => {
    assert.equal(normalizeUrbanGroundConfig(null), null);
    assert.deepEqual(normalizeUrbanGroundConfig({}), {
        coreRadiusM: 14,
        blendRadiusM: 18,
        maskHalfSizeM: 320,
        maskSizePx: 512,
        refreshMoveM: 80,
    });
    assert.deepEqual(normalizeUrbanGroundConfig({
        coreRadiusM: -5,
        blendRadiusM: 0,
        maskHalfSizeM: 20,
        maskSizePx: 9000,
        refreshMoveM: 2,
    }), {
        coreRadiusM: 0,
        blendRadiusM: 1,
        maskHalfSizeM: 100,
        maskSizePx: 2048,
        refreshMoveM: 20,
    });
});

test('projects only Polygon and MultiPolygon outer building rings', () => {
    const features = [
        {
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [[16, 43], [16.1, 43], [16.1, 43.1], [16, 43]],
                    [[16.02, 43.02], [16.03, 43.02], [16.02, 43.02]],
                ],
            },
        },
        {
            geometry: {
                type: 'MultiPolygon',
                coordinates: [
                    [[[17, 44], [17.1, 44], [17, 44.1], [17, 44]]],
                    [[[18, 45], [18.1, 45], [18, 45.1], [18, 45]]],
                ],
            },
        },
        { geometry: { type: 'Point', coordinates: [16, 43] } },
    ];
    const rings = collectProjectedBuildingOuterRings(features, (lon, lat) => ({
        x: lon * 10,
        z: -lat * 10,
    }));
    assert.equal(rings.length, 3);
    assert.deepEqual(rings[0][0], { x: 160, z: -430 });
    assert.equal(rings[0].length, 4);
    assert.equal(rings[1][0].x, 170);
    assert.equal(rings[2][0].x, 180);
});

test('cooperative projection is exact and yields by generic work chunks', () => {
    const features = [{
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [0, 0],
                [4, 0],
                [4, 3],
                [0, 3],
                [0, 0],
            ]],
        },
    }];
    const projectLonLat = (lon, lat) => ({ x: lon * 2, z: -lat * 3 });
    const expected = collectProjectedBuildingOuterRings(features, projectLonLat);
    const iterator = collectProjectedBuildingOuterRingsCooperative(
        features,
        projectLonLat,
        { workChunkSize: 2 },
    );
    let yields = 0;
    let next = iterator.next();
    while (!next.done) {
        assert.equal(next.value.phase, 'project');
        yields += 1;
        next = iterator.next();
    }
    assert.ok(yields >= 3);
    assert.deepEqual(next.value, expected);
});

function createFakeCanvasFactory(calls) {
    return () => {
        const context = {
            fillRect: (...args) => calls.push(['fillRect', ...args]),
            fill: () => calls.push(['fill']),
            stroke: () => calls.push(['stroke']),
            drawImage: () => calls.push(['drawImage']),
        };
        return {
            width: 0,
            height: 0,
            getContext: () => context,
        };
    };
}

function createFakePath() {
    return {
        moveTo() {},
        lineTo() {},
        closePath() {},
    };
}

function drainMaskTask(task) {
    let steps = 0;
    while (!task.step(0.1)) {
        steps += 1;
        assert.ok(steps < 1000, 'mask task must make bounded progress');
    }
    return steps;
}

test('mask generations resume work and reuse immutable tile projection caches', () => {
    let projections = 0;
    const features = Array.from({ length: 8 }, (_, index) => ({
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [index, 0],
                [index + 0.5, 0],
                [index + 0.5, 0.5],
                [index, 0],
            ]],
        },
    }));
    const cache = createProjectedBuildingRingCache(
        features,
        (lon, lat) => {
            projections += 1;
            return { x: lon, z: lat };
        },
        { workChunkSize: 2 },
    );
    const calls = [];
    let clock = 0;
    const taskOptions = {
        tileCaches: [cache],
        config: {},
        sourceRevision: 7,
        createCanvas: createFakeCanvasFactory(calls),
        createPath: createFakePath,
        now: () => clock++,
        pathWorkChunkSize: 2,
    };
    const firstTask = createUrbanGroundMaskBuildTask(taskOptions);
    assert.ok(drainMaskTask(firstTask) > 1, 'projection and raster work must span steps');
    assert.ok(firstTask.result());
    assert.equal(cache.complete, true);
    const firstProjectionCount = projections;
    assert.ok(firstProjectionCount > 0);
    assert.ok(calls.some(([name]) => name === 'drawImage'));

    const secondTask = createUrbanGroundMaskBuildTask({
        ...taskOptions,
        centerX: 20,
    });
    drainMaskTask(secondTask);
    assert.ok(secondTask.result());
    assert.equal(
        projections,
        firstProjectionCount,
        'moving-window masks must not reproject immutable building coordinates',
    );
});

test('only the current source revision and nearby build centre may publish', () => {
    const task = { sourceRevision: 4, centerX: 100, centerZ: -50 };
    assert.equal(urbanGroundMaskBuildIsCurrent(task, 4, 110, -55, 80), true);
    assert.equal(urbanGroundMaskBuildIsCurrent(task, 5, 110, -55, 80), false);
    assert.equal(urbanGroundMaskBuildIsCurrent(task, 4, 180, -50, 80), false);
});

// --- the ground mask must use the SERVED outline, not the mesh faces ---------
//
// A LOD2 building arrives as a MultiPolygon of FACES (walls + roof), so treating
// its parts as outlines is both wrong and ruinously slow. On one dense 800 m
// tile, 2,311 buildings yielded 388,008 rings that way against 2,539 for
// the footprint endpoint, and filling/stroking those into the 512 px mask cost
// 82 ms PER FRAME in the terrain hook — 60 fps down to 7, while drawing FEWER
// triangles than before. The server therefore sends properties.footprint.
const project = (lon, lat) => ({ x: lon * 1000, z: -lat * 1000 });

// A crude stand-in for a LOD2 mesh: one building, many face polygons.
function meshFeatureWithFaces(faceCount) {
    const faces = [];
    for (let i = 0; i < faceCount; i++) {
        faces.push([[[i, 0], [i + 1, 0], [i + 1, 1], [i, 0]]]);   // a wall quad
    }
    return {
        properties: {
            geometry_kind: 'mesh',
            footprint: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
        },
        geometry: { type: 'MultiPolygon', coordinates: faces },
    };
}

test('a mesh contributes ONE ring — its footprint — not one per face', async () => {
    const { collectProjectedBuildingOuterRings } = await import('../core/urban-ground.js');
    const rings = collectProjectedBuildingOuterRings([meshFeatureWithFaces(168)], project);
    // Without the fix this is 168. That factor is the whole regression.
    assert.equal(rings.length, 1);
    assert.equal(rings[0].length, 5);            // the footprint ring, not a wall quad
});

test('many meshes scale by BUILDING count, not by face count', async () => {
    const { collectProjectedBuildingOuterRings } = await import('../core/urban-ground.js');
    const features = Array.from({ length: 50 }, () => meshFeatureWithFaces(168));
    const rings = collectProjectedBuildingOuterRings(features, project);
    assert.equal(rings.length, 50, 'must be one ring per building');
    assert.ok(rings.length < 200, 'a per-face count would be 8,400 here');
});

test('a footprint feature still works with no footprint property', async () => {
    const { collectProjectedBuildingOuterRings } = await import('../core/urban-ground.js');
    // /buildings-render and /buildings-overture send the outline AS the geometry
    // and no properties.footprint. The fallback must keep them correct.
    const rings = collectProjectedBuildingOuterRings([{
        properties: { source: 'overture' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    }], project);
    assert.equal(rings.length, 1);
    assert.equal(rings[0].length, 4);
});
