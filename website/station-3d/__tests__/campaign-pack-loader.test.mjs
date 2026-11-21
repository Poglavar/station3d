import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { CAMPAIGN_PACK_CHUNK_CONTRACT, encodeCampaignPackChunk } from '../core/campaign-pack-binary.js';
import { compressCampaignPackPayload } from '../core/campaign-pack-compression.js';
import { CampaignPackError, loadCampaignPack } from '../core/campaign-pack.js';

function packet() {
    return {
        schemaVersion: 1,
        compilerId: 'fixture', compilerVersion: '1', sourceRevision: 'r1', generation: 1,
        tile: { matrix: 'campaign', z: 0, x: 0, y: 0, originLon: 15.9, originLat: 45.8 },
        primitives: [{
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
            normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
            indices: new Uint16Array([0, 1, 2]),
            materialKey: 'terrain', renderOrder: 0,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0, maxZ: 1 },
            entityRanges: [],
            surfaceClaims: [{ surfaceClass: 'terrain', coverageState: 'published', verticalRelation: 'same-level' }],
            colliderData: null,
        }],
    };
}

function fixture() {
    const payload = encodeCampaignPackChunk({
        contract: CAMPAIGN_PACK_CHUNK_CONTRACT,
        schemaVersion: 1,
        packId: 'zagreb',
        key: 'ground-0',
        materials: { terrain: { color: '#667744' } },
        packets: [packet()],
    });
    const sha256 = createHash('sha256').update(new Uint8Array(payload)).digest('hex');
    const manifest = {
        contract: 'station3d-campaign-pack-manifest-v1',
        schemaVersion: 1,
        packId: 'zagreb', releaseId: 'zagreb-r1',
        compilerVersion: '1', sourceRevision: 'r1',
        anchor: { lat: 45.8, lon: 15.9, sceneDatumAslM: 110, verticalDatum: 'EVRF2000' },
        chunks: [{
            key: 'ground-0',
            url: '/api/station3d/campaign-packs/zagreb-r1/chunks/ground-0.bin',
            byteLength: payload.byteLength,
            sha256,
        }],
    };
    return { payload, manifest };
}

test('campaign loader pins a manifest, validates SHA-256 and reports progress', async () => {
    const { payload, manifest } = fixture();
    const requests = [];
    const progress = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url, options });
        return String(url).endsWith('/manifest')
            ? new Response(JSON.stringify(manifest), { status: 200 })
            : new Response(payload, { status: 200 });
    };
    const loaded = await loadCampaignPack({
        apiBase: 'https://example.test/api',
        packId: 'zagreb',
        fetchImpl,
        cryptoImpl: webcrypto,
        onProgress: value => progress.push(value),
    });
    assert.equal(loaded.manifest.releaseId, 'zagreb-r1');
    assert.equal(loaded.chunks[0].chunk.packets[0].compilerId, 'fixture');
    assert.equal(requests[0].options.cache, 'no-cache');
    assert.equal(requests[1].options.cache, 'force-cache');
    assert.equal(
        requests[1].url,
        'https://example.test/api/station3d/campaign-packs/zagreb-r1/chunks/ground-0.bin',
    );
    assert.equal(progress[0].loadedChunks, 1);
});

test('campaign loader rejects corrupt chunks without a streaming fallback', async () => {
    const { payload, manifest } = fixture();
    manifest.chunks[0].sha256 = 'f'.repeat(64);
    const fetchImpl = async (url) => String(url).endsWith('/manifest')
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(payload, { status: 200 });
    await assert.rejects(
        loadCampaignPack({
            apiBase: 'https://example.test/api',
            packId: 'zagreb',
            fetchImpl,
            cryptoImpl: webcrypto,
        }),
        error => error instanceof CampaignPackError && error.code === 'chunk-integrity-failed',
    );
});

test('campaign loader validates compressed bytes before inflating a gzip chunk', async () => {
    const { payload, manifest } = fixture();
    const compressed = await compressCampaignPackPayload(payload);
    manifest.chunks[0] = {
        ...manifest.chunks[0],
        encoding: 'gzip',
        byteLength: compressed.byteLength,
        decodedByteLength: payload.byteLength,
        sha256: createHash('sha256').update(new Uint8Array(compressed)).digest('hex'),
    };
    const loaded = await loadCampaignPack({
        apiBase: 'https://example.test/api',
        packId: 'zagreb',
        cryptoImpl: webcrypto,
        fetchImpl: async url => String(url).endsWith('/manifest')
            ? new Response(JSON.stringify(manifest), { status: 200 })
            : new Response(compressed, { status: 200 }),
    });
    assert.equal(loaded.chunks[0].chunk.key, 'ground-0');
    assert.equal(loaded.chunks[0].byteLength, compressed.byteLength);
});
