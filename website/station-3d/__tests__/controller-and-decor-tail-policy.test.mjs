import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    computeFlatNormalsRange,
    normalizeNormals,
    triangleCount,
} from '../core/flat-normals.js';

test('rail controller profiling has no ordinary-session timer path', async () => {
    const [animate, cab] = await Promise.all([
        readFile(new URL('../scene/animate.js', import.meta.url), 'utf8'),
        readFile(new URL('../modes/cab.js', import.meta.url), 'utf8'),
    ]);
    assert.match(animate, /export function isPerformanceProfilingActive/);
    assert.match(cab, /const profilePhases = isPerformanceProfilingActive\(\)/);
    assert.match(cab, /profilePhases \? performance\.now\(\) : 0/);
    for (const phase of [
        'background',
        'graph-refresh',
        'autopilot-pose',
        'autopilot-controls',
        'driver-step',
        'pose',
        'external-pose',
    ]) {
        assert.match(cab, new RegExp(`finishPhase\\?\\.\\('${phase}'\\)`));
    }
});

test('decor finalization normalizes and writes UVs inside cooperative slices', async () => {
    const [decor, waterMaterial] = await Promise.all([
        readFile(new URL('../world/decor.js', import.meta.url), 'utf8'),
        readFile(new URL('../world/water-material.js', import.meta.url), 'utf8'),
    ]);
    assert.match(
        decor,
        /normalizeNormals\(mergedNormals\.subarray\(triangle \* 9, endTriangle \* 9\)\)/,
    );
    assert.doesNotMatch(decor, /normalizeNormals\(mergedNormals\);/);
    assert.match(decor, /const createWorldUvs = async/);
    assert.match(decor, /'greenery:uv'/);
    assert.match(decor, /await createWorldUvs\(WATER_UV_PER_M\)/);
    assert.match(decor, /const cancelMergedBuild = \(\) => \{[\s\S]*?mergedGeo\.dispose\(\)/);
    assert.match(decor, /if \(!uvs\) return cancelMergedBuild\(\)/);
    assert.match(decor, /`greenery:material:\$\{type\}`/);
    assert.match(decor, /`greenery:publication:\$\{type\}`/);
    assert.match(decor, /`greenery:cutout:\$\{type\}`/);
    assert.doesNotMatch(decor, /'greenery:merge'/);
    assert.match(decor, /await prepareWaterMaterialResourcesCooperatively/);
    assert.match(decor, /`greenery:water-texture:\$\{phase\}`/);
    assert.match(waterMaterial, /export async function prepareWaterMaterialResourcesCooperatively/);
    assert.match(waterMaterial, /for \(let startY = 0; startY < size; startY \+= rowsPerChunk\)/);
    assert.match(waterMaterial, /await continueAfterChunk\('pattern'\)/);
    assert.match(waterMaterial, /await continueAfterChunk\('normal'\)/);
});

test('normalizing each complete non-indexed slice is byte-identical to one pass', () => {
    const positions = new Float32Array([
        0, 0, 0, 2, 0, 0, 0, 1, -2,
        1, 2, 3, 4, 3, 2, -1, 5, 7,
    ]);
    const whole = new Float32Array(positions.length);
    computeFlatNormalsRange(positions, whole, 0, triangleCount(positions));
    normalizeNormals(whole);

    const sliced = new Float32Array(positions.length);
    for (let triangle = 0; triangle < triangleCount(positions); triangle++) {
        computeFlatNormalsRange(positions, sliced, triangle, triangle + 1);
        normalizeNormals(sliced.subarray(triangle * 9, (triangle + 1) * 9));
    }
    assert.deepEqual(sliced, whole);
});
