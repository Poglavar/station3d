import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    CAMPAIGN_PACK_CHUNK_CONTRACT,
    CampaignPackBinaryError,
    decodeCampaignPackChunk,
    encodeCampaignPackChunk,
} from '../core/campaign-pack-binary.js';

function fixture() {
    return {
        contract: CAMPAIGN_PACK_CHUNK_CONTRACT,
        schemaVersion: 1,
        packId: 'zagreb-chapter',
        key: 'ground-0',
        materials: { asphalt: { type: 'MeshStandardMaterial', color: '#222222' } },
        packets: [{
            schemaVersion: 1,
            compilerId: 'fixture',
            compilerVersion: '1',
            sourceRevision: 'abc',
            generation: 1,
            tile: { matrix: 'campaign', z: 0, x: 0, y: 0, originLon: 15.97, originLat: 45.81 },
            primitives: [{
                positions: new Float32Array([0, 1, 0, 10, 1, 0, 0, 1, 10]),
                normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
                uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
                indices: new Uint16Array([0, 1, 2]),
                materialKey: 'asphalt',
                renderOrder: 0,
                bounds: { minX: 0, minY: 1, minZ: 0, maxX: 10, maxY: 1, maxZ: 10 },
                entityRanges: [],
                surfaceClaims: [{ surfaceClass: 'road', coverageState: 'published', verticalRelation: 'same-level' }],
                colliderData: { drivable: true },
            }],
        }],
    };
}

test('campaign pack binary is deterministic and round-trips typed geometry', () => {
    const first = encodeCampaignPackChunk(fixture());
    const second = encodeCampaignPackChunk(fixture());
    assert.deepEqual(new Uint8Array(first), new Uint8Array(second));
    const decoded = decodeCampaignPackChunk(first);
    assert.equal(decoded.key, 'ground-0');
    assert.ok(decoded.packets[0].primitives[0].positions instanceof Float32Array);
    assert.ok(decoded.packets[0].primitives[0].indices instanceof Uint16Array);
    assert.deepEqual([...decoded.packets[0].primitives[0].positions], [0, 1, 0, 10, 1, 0, 0, 1, 10]);
});
test('campaign pack binary rejects truncation and unknown versions', () => {
    const encoded = encodeCampaignPackChunk(fixture());
    assert.throws(
        () => decodeCampaignPackChunk(encoded.slice(0, encoded.byteLength - 1)),
        error => error instanceof CampaignPackBinaryError && error.code === 'byte-length-mismatch',
    );
    const unsupported = encoded.slice(0);
    new DataView(unsupported).setUint16(4, 99, true);
    assert.throws(
        () => decodeCampaignPackChunk(unsupported),
        error => error instanceof CampaignPackBinaryError && error.code === 'unsupported-version',
    );
});
