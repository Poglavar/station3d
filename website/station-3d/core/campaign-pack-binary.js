// Backward-compatible S3L1 campaign identity over the shared typed-array codec.
import { createTypedArrayEnvelopeCodec, TypedArrayEnvelopeError } from './typed-array-envelope.js';

export const CAMPAIGN_PACK_BINARY_MAGIC = 'S3L1';
export const CAMPAIGN_PACK_BINARY_VERSION = 1;
export const CAMPAIGN_PACK_CHUNK_CONTRACT = 'station3d-campaign-pack-chunk-v1';

export class CampaignPackBinaryError extends TypedArrayEnvelopeError {
    constructor(code, message, details = null) {
        super(code, message, details);
        this.name = 'CampaignPackBinaryError';
    }
}
function fail(code, message) { throw new CampaignPackBinaryError(code, message); }

function validateChunkIdentity(chunk) {
    if (!chunk || typeof chunk !== 'object') fail('missing-chunk', 'Campaign pack chunk is required');
    if (chunk.contract !== CAMPAIGN_PACK_CHUNK_CONTRACT) {
        fail('unsupported-contract', `Expected ${CAMPAIGN_PACK_CHUNK_CONTRACT}`);
    }
    if (chunk.schemaVersion !== CAMPAIGN_PACK_BINARY_VERSION) {
        fail('unsupported-version', `Expected campaign pack schema ${CAMPAIGN_PACK_BINARY_VERSION}`);
    }
    if (!String(chunk.key || '').trim()) fail('missing-chunk-key', 'Campaign pack chunk key is required');
    if (!String(chunk.packId || '').trim()) fail('missing-pack-id', 'Campaign pack id is required');
    if (!Array.isArray(chunk.packets)) fail('invalid-packets', 'Campaign pack packets must be an array');
    if (!chunk.materials || typeof chunk.materials !== 'object' || Array.isArray(chunk.materials)) {
        fail('invalid-materials', 'Campaign pack materials must be an object');
    }
    return chunk;
}

const codec = createTypedArrayEnvelopeCodec({
    magic: CAMPAIGN_PACK_BINARY_MAGIC, version: CAMPAIGN_PACK_BINARY_VERSION,
    validate: validateChunkIdentity, ErrorType: CampaignPackBinaryError, label: 'Campaign pack',
});
export const encodeCampaignPackChunk = codec.encode;
export const encodeCampaignPackChunkBlob = codec.encodeBlob;
export const decodeCampaignPackChunk = codec.decode;
