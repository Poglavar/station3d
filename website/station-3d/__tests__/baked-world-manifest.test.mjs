// Immutable coverage and compatibility gates must fail before a session publishes any tile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorldManifest, bakedWorldTileUrl, worldManifestText } from '../core/baked-world-manifest.js';

export function manifestFixture() {
    const descriptor = { layer: 'far-buildings', revision: 'tile-v1', lod: 1,
        tile: { matrix: 'EPSG:3857', z: 15, x: 17837, y: 11682 }, state: 'ready',
        compilerId: 'far-buildings', compilerVersion: '1.2.0', bakeVersion: '1.1.0',
        sourceRevision: 'a'.repeat(64), entities: 1, primitives: 1,
        byteLength: 100, sha256: 'b'.repeat(64), gzip: { byteLength: 80, sha256: 'c'.repeat(64) } };
    return { contract: 'station3d-world-manifest-v1', schemaVersion: 1,
        location: 'pilot', releaseId: 'pilot-a', tiles: [{ ...descriptor, url: bakedWorldTileUrl(descriptor) }] };
}
test('manifest pins stable coverage and canonical text, including explicit empty tiles', () => {
    const value = manifestFixture();
    assert.equal(validateWorldManifest(value), value);
    assert.equal(worldManifestText(value), worldManifestText(JSON.parse(worldManifestText(value))));
    const empty = structuredClone(value); empty.tiles[0].state = 'empty'; empty.tiles[0].primitives = 0;
    assert.equal(validateWorldManifest(empty), empty);
});
test('untrusted URLs, duplicate/missing coverage, corruption and unsupported compilers fail closed', () => {
    for (const mutate of [m => m.tiles.push(m.tiles[0]), m => { m.tiles = []; },
        m => { m.tiles[0].url = 'https://example.com/tile.bin'; }, m => { m.tiles[0].sha256 = 'bad'; },
        m => { m.tiles[0].state = 'empty'; }, m => { m.tiles[0].byteLength = 100e6; },
        m => { delete m.releaseId; }, m => { delete m.tiles[0].compilerVersion; },
        m => { m.tiles[0].tile.x = 2 ** 15; }]) {
        const value = manifestFixture(); mutate(value); assert.throws(() => validateWorldManifest(value));
    }
    assert.throws(() => validateWorldManifest(manifestFixture(), { releaseId: 'other' }));
    assert.throws(() => validateWorldManifest(manifestFixture(), { layers: {} }));
    assert.throws(() => validateWorldManifest(manifestFixture(), { layers: { 'far-buildings': { compilerVersion: '99' } } }));
});
