// Verify relocatable asset URLs, optional package media and the shipped face atlas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

import { station3dAssetUrl } from '../core/asset-url.js';
import { createCrowdFaceAtlas } from '../core/crowd-face-atlas.js';
import { encodeCrowdFacePng } from '../scripts/generate-crowd-face-atlas.mjs';

test('static assets resolve from the stable Station3D root in a split production chunk', () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
        __station3DAssetConfig: { rootUrl: 'https://example.test/station-3d/' },
    };
    try {
        assert.equal(
            station3dAssetUrl('/audio/sfx/test.wav'),
            'https://example.test/station-3d/audio/sfx/test.wav',
        );
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('compiled optional assets use the exact package catalog and preserve explicit host roots', () => {
    const source = readFileSync(new URL('../core/asset-url.js', import.meta.url), 'utf8');
    const code = transformSync(source, { format: 'cjs', define: {
        __STATION3D_PACKAGED_ASSETS__: JSON.stringify(['audio/sfx/birds/song.mp3']),
        'import.meta.url': JSON.stringify('https://example.test/vendor/station3d/chunks/chunk.js'),
    } }).code;
    const packageRoot = 'https://example.test/vendor/station3d/';
    const config = { rootUrl: packageRoot, baseUrl: packageRoot, productionBundle: true };
    const context = { URL, module: { exports: {} }, window: { __station3DAssetConfig: config } };
    runInNewContext(code, context);
    const { station3dAssetUrl: required, station3dOptionalAssetUrl: optional } = context.module.exports;
    assert.equal(optional('/audio/sfx/birds/song.mp3'), `${packageRoot}audio/sfx/birds/song.mp3`);
    assert.equal(optional('audio/sfx/birds/missing.mp3'), null, 'a licensed directory does not imply every file exists');
    assert.equal(optional('audio/enemy-music/missing.mp3'), null);
    assert.equal(required('assets/required.png'), `${packageRoot}assets/required.png`,
        'mandatory assets retain their normal URL/error behavior');
    config.rootUrl = 'https://media.example.test/product/';
    assert.equal(optional('audio/enemy-music/host-track.mp3'), 'https://media.example.test/product/audio/enemy-music/host-track.mp3');
    delete context.window;
    assert.equal(optional('audio/enemy-music/missing.mp3'), null, 'direct bundle use also respects its compiled catalog');
});

test('crowd-face atlas rasterization is deterministic RGBA data for every face tile', () => {
    const first = createCrowdFaceAtlas(16);
    const second = createCrowdFaceAtlas(16);
    assert.equal(first.width, 128);
    assert.equal(first.height, 128);
    assert.equal(first.data.length, first.width * first.height * 4);
    assert.deepEqual(first.data, second.data);

    const alpha = first.data.filter((_, index) => index % 4 === 3);
    assert.ok(alpha.some(value => value > 0), 'face markings should be visible');
    assert.ok(alpha.some(value => value === 0), 'unpainted pixels should remain transparent');

    const png = encodeCrowdFacePng(first);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), first.width);
    assert.equal(png.readUInt32BE(20), first.height);
    assert.deepEqual(encodeCrowdFacePng(second), png, 'PNG encoding should be deterministic');
});

test('the published crowd-face PNG contains the complete current procedural raster', () => {
    const png = readFileSync(new URL('../assets/people/crowd-faces.png', import.meta.url));
    const atlas = createCrowdFaceAtlas();
    assert.equal(png.readUInt32BE(16), atlas.width);
    assert.equal(png.readUInt32BE(20), atlas.height);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
    const imageChunks = [];
    for (let offset = 8; offset < png.length;) {
        const size = png.readUInt32BE(offset);
        assert.ok(offset + size + 12 <= png.length, 'PNG chunks must not be truncated');
        if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
            imageChunks.push(png.subarray(offset + 8, offset + size + 8));
        }
        offset += size + 12;
    }
    const scanlines = inflateSync(Buffer.concat(imageChunks));
    const stride = atlas.width * 4;
    assert.equal(scanlines.length, (stride + 1) * atlas.height);
    for (let y = 0; y < atlas.height; y++) {
        const offset = y * (stride + 1);
        assert.equal(scanlines[offset], 0, 'the offline encoder uses unfiltered scanlines');
        assert.ok(scanlines.subarray(offset + 1, offset + 1 + stride).equals(
            Buffer.from(atlas.data.subarray(y * stride, (y + 1) * stride))), `raster row ${y} must match`);
    }
});
