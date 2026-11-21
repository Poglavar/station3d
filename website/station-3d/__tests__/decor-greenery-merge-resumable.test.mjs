// The greenery builder is browser-bound, so lock the cooperative seams that
// keep one dense clipped polygon from monopolising an animation frame.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../world/decor.js', import.meta.url), 'utf8');

test('greenery height sampling and final typed-buffer copies are bounded', () => {
    assert.match(source, /const DECOR_MERGE_COPY_CHUNK_VALUES = 30_000/);
    assert.match(source, /const DECOR_MARKING_DRAPE_CHUNK_VERTICES = 1/);
    assert.match(source, /const drapeParkingMarkings = async/);
    assert.match(source, /Math\.floor\(DECOR_MARKING_DRAPE_CHUNK_VERTICES \/ 3\)/);
    assert.match(source, /const valuesPerChunk = trianglesPerChunk \* 9/);
    assert.match(source, /'greenery:marking-drape:formation'/);
    assert.match(source, /'greenery:marking-drape:terrain'/);
    assert.match(source, /sourceOffset \+= DECOR_MERGE_COPY_CHUNK_VALUES/);
    assert.match(source, /surface\.positions\.subarray\(sourceOffset, end\)/);
    assert.match(source, /'greenery:concat'/);
});

test('greenery triangulation, refinement, and drape are resumable inside one polygon', () => {
    assert.match(source, /refineTriangulatedSurfaceSteps/);
    assert.match(source, /trianglesPerYield: DECOR_SURFACE_REFINEMENT_CHUNK_TRIANGLES/);
    assert.match(source, /'greenery:triangulate'/);
    assert.match(source, /'greenery:refinement'/);
    assert.match(source, /'greenery:terrain-drape'/);
    assert.match(
        source,
        /parkingRoadFormation\?\.hasPendingBuild\?\.\(\) === true[\s\S]*?await waitForPublishedRoadFormation[\s\S]*?decorSurfaceYAt/,
        'a road revision cannot resume inside a terrain sample and force a synchronous rebuild',
    );
});

test('greenery merge labels every formerly hidden preparation boundary', () => {
    assert.match(source, /'greenery:marking-merge'/);
    assert.match(source, /'greenery:ground-paint'/);
    assert.match(source, /'greenery:edging'/);
    assert.match(source, /'greenery:bucket'/);
    assert.match(source, /'greenery:alloc'/);
});
