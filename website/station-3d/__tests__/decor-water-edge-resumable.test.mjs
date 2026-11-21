// A large river ring must not remain one several-hundred-millisecond decor
// step. Drape sampling and its post-drape normal rebuild both yield in chunks;
// the old greenery group remains visible until the replacement is complete.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DECOR = readFileSync(
    fileURLToPath(new URL('../world/decor.js', import.meta.url)),
    'utf8',
);
const WATER = readFileSync(
    fileURLToPath(new URL('../world/water-material.js', import.meta.url)),
    'utf8',
);

test('terrain-draped banks and shores are cooperatively chunked', () => {
    const drape = DECOR.slice(
        DECOR.indexOf('async function drapeWaterEdgeGeometry'),
        DECOR.indexOf('function indexCell'),
    );
    assert.match(drape, /DECOR_WATER_DRAPE_CHUNK_VERTICES/);
    assert.match(drape, /await maybeYieldBuild\(yieldState, shouldCancel, label\)/,
        'terrain samples yield between bounded vertex runs');
    assert.match(drape, /computeFlatNormalsRange/);
    assert.match(drape, /await maybeYieldBuild\(yieldState, shouldCancel, `\$\{label\}:normals`\)/,
        'the post-drape normal pass is bounded too');

    const greenery = DECOR.slice(
        DECOR.indexOf('async function buildGreeneryGroup'),
        DECOR.indexOf('// ─── Pedestrian crossings'),
    );
    assert.match(greenery, /await drapeWaterEdgeGeometry\([\s\S]*?'greenery:bank'/);
    assert.match(greenery, /await drapeWaterEdgeGeometry\([\s\S]*?'greenery:shore'/);
    assert.match(greenery, /computeNormals: !terrainReference/,
        'terrain mode skips the wasted normals that draping immediately replaces');
    assert.ok(
        greenery.indexOf('resetBuildYieldState(yieldState)')
            < greenery.indexOf("'greenery:bank'"),
        'nested child-builder wall time is not attributed to the next shoreline step',
    );
});

test('water geometry keeps eager normals for ordinary callers', () => {
    assert.match(WATER, /buildWaterBankGeometry\([\s\S]*?\{ computeNormals = true \} = \{\}/);
    assert.match(WATER, /buildWaterShoreGeometry\([\s\S]*?\{ computeNormals = true \} = \{\}/);
    assert.equal((WATER.match(/if \(computeNormals\) geometry\.computeVertexNormals\(\);/g) || []).length, 2);
});
