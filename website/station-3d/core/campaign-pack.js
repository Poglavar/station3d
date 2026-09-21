import { decodeCampaignPackChunk } from './campaign-pack-binary.js';
import { decompressCampaignPackPayload } from './campaign-pack-compression.js';
import { validateRenderPacket } from './render-packet.js';

export const CAMPAIGN_PACK_MANIFEST_CONTRACT = 'station3d-campaign-pack-manifest-v1';
export const CAMPAIGN_PACK_MANIFEST_VERSION = 1;

export class CampaignPackError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'CampaignPackError';
        this.code = code;
        this.details = details;
    }
}

export function campaignPackRailFeatures(pack) {
    const features = pack?.manifest?.buildParameters?.railFeatures;
    if (!Array.isArray(features) || features.length === 0) {
        throw new CampaignPackError(
            'rail-network-missing',
            'The baked level must be rebuilt with its matching rail driving geometry.',
        );
    }
    return features;
}

function fail(code, message, details = null) {
    throw new CampaignPackError(code, message, details);
}

function text(value, label) {
    const output = String(value ?? '').trim();
    if (!output) fail('invalid-manifest', `${label} is required`);
    return output;
}

function finite(value, label) {
    const output = Number(value);
    if (!Number.isFinite(output)) fail('invalid-manifest', `${label} must be finite`);
    return output;
}

function normalizeSha256(value, label) {
    const output = text(value, label).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(output)) fail('invalid-manifest', `${label} must be SHA-256 hex`);
    return output;
}

export function validateCampaignPackManifest(value, expected = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('invalid-manifest', 'Campaign pack manifest must be an object');
    }
    if (value.contract !== CAMPAIGN_PACK_MANIFEST_CONTRACT
        || value.schemaVersion !== CAMPAIGN_PACK_MANIFEST_VERSION) {
        fail('unsupported-manifest', 'Campaign pack manifest version is unsupported');
    }
    const packId = text(value.packId, 'packId');
    const releaseId = text(value.releaseId, 'releaseId');
    text(value.compilerVersion, 'compilerVersion');
    text(value.sourceRevision, 'sourceRevision');
    if (expected.packId && packId !== expected.packId) {
        fail('pack-mismatch', `Expected campaign pack ${expected.packId}, got ${packId}`);
    }
    if (expected.releaseId && releaseId !== expected.releaseId) {
        fail('release-mismatch', `Expected campaign release ${expected.releaseId}, got ${releaseId}`);
    }
    if (!value.anchor || typeof value.anchor !== 'object') {
        fail('invalid-manifest', 'Campaign pack anchor is required');
    }
    finite(value.anchor.lat, 'anchor.lat');
    finite(value.anchor.lon, 'anchor.lon');
    if (value.anchor.verticalDatum !== 'EVRF2000') {
        fail('vertical-datum-mismatch', 'Campaign pack must declare EVRF2000 elevations');
    }
    if (!Array.isArray(value.chunks) || value.chunks.length === 0) {
        fail('invalid-manifest', 'Campaign pack must contain at least one chunk');
    }
    const keys = new Set();
    for (let index = 0; index < value.chunks.length; index++) {
        const chunk = value.chunks[index];
        if (!chunk || typeof chunk !== 'object') fail('invalid-manifest', `chunks[${index}] is invalid`);
        const key = text(chunk.key, `chunks[${index}].key`);
        if (keys.has(key)) fail('duplicate-chunk', `Campaign pack chunk ${key} is duplicated`);
        keys.add(key);
        text(chunk.url, `chunks[${index}].url`);
        normalizeSha256(chunk.sha256, `chunks[${index}].sha256`);
        const byteLength = Number(chunk.byteLength);
        if (!Number.isInteger(byteLength) || byteLength <= 0) {
            fail('invalid-manifest', `chunks[${index}].byteLength must be positive`);
        }
        const decodedByteLength = Number(chunk.decodedByteLength ?? byteLength);
        if (!Number.isInteger(decodedByteLength) || decodedByteLength <= 0) {
            fail('invalid-manifest', `chunks[${index}].decodedByteLength must be positive`);
        }
        if (!['identity', 'gzip'].includes(chunk.encoding || 'identity')) {
            fail('invalid-manifest', `chunks[${index}].encoding is unsupported`);
        }
    }
    return value;
}

function joinUrl(base, path) {
    const value = String(path || '');
    try {
        // Root-relative API links still belong to the configured API origin.
        // Returning them verbatim silently redirects cross-origin dev/runtime
        // configurations back to the frontend server.
        return new URL(value, base).href;
    } catch (_error) {
        if (value.startsWith('/')) return value;
        const prefix = String(base || '').replace(/\/+$/, '');
        return `${prefix}/${value.replace(/^\/+/, '')}`;
    }
}

function hex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle?.digest) fail('crypto-unavailable', 'SHA-256 is unavailable');
    return hex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', value)));
}

async function fetchJson(fetchImpl, url, signal) {
    let response;
    try {
        response = await fetchImpl(url, { cache: 'no-cache', signal });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        fail('manifest-network-failed', 'Campaign level manifest could not be downloaded', error?.message);
    }
    if (!response.ok) {
        fail(
            response.status === 404 ? 'pack-not-published' : 'manifest-http-failed',
            `Campaign level manifest request failed (${response.status})`,
        );
    }
    try {
        return await response.json();
    } catch (error) {
        fail('manifest-decode-failed', 'Campaign level manifest is not valid JSON', error?.message);
    }
}

async function loadChunk({ fetchImpl, cryptoImpl, manifestUrl, manifest, descriptor, signal }) {
    const url = joinUrl(manifestUrl, descriptor.url);
    let response;
    try {
        response = await fetchImpl(url, { cache: 'force-cache', signal });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        fail('chunk-network-failed', `Campaign level chunk ${descriptor.key} could not be downloaded`, error?.message);
    }
    if (!response.ok) fail('chunk-http-failed', `Campaign level chunk ${descriptor.key} failed (${response.status})`);
    const buffer = await response.arrayBuffer();
    const actualSha256 = await sha256Hex(buffer, cryptoImpl);
    if (actualSha256 !== descriptor.sha256) {
        fail('chunk-integrity-failed', `Campaign level chunk ${descriptor.key} failed integrity validation`, {
            expected: descriptor.sha256,
            actual: actualSha256,
        });
    }
    let decodedBuffer;
    try {
        decodedBuffer = await decompressCampaignPackPayload(buffer, {
            encoding: descriptor.encoding || 'identity',
        });
    } catch (error) {
        fail('chunk-decompression-failed', `Campaign level chunk ${descriptor.key} could not be decompressed`, {
            message: error?.message,
        });
    }
    const expectedDecodedBytes = Number(descriptor.decodedByteLength ?? buffer.byteLength);
    if (decodedBuffer.byteLength !== expectedDecodedBytes) {
        fail('chunk-decompression-failed', `Campaign level chunk ${descriptor.key} has the wrong decoded size`);
    }
    let chunk;
    try {
        chunk = decodeCampaignPackChunk(decodedBuffer);
    } catch (error) {
        fail('chunk-decode-failed', `Campaign level chunk ${descriptor.key} is invalid`, {
            code: error?.code,
            message: error?.message,
        });
    }
    if (chunk.key !== descriptor.key || chunk.packId !== manifest.packId) {
        fail('chunk-identity-mismatch', `Campaign level chunk ${descriptor.key} has the wrong identity`);
    }
    chunk.packets.forEach(packet => validateRenderPacket(packet));
    return Object.freeze({ descriptor, chunk, byteLength: buffer.byteLength });
}

export function campaignPackManifestUrl(apiBase, packId, releaseId = null) {
    const base = String(apiBase || '').replace(/\/+$/, '');
    const release = releaseId ? `?release=${encodeURIComponent(releaseId)}` : '';
    return `${base}/station3d/campaign-packs/${encodeURIComponent(packId)}/manifest${release}`;
}

export async function loadCampaignPack({
    apiBase,
    packId,
    releaseId = null,
    fetchImpl = globalThis.fetch,
    cryptoImpl = globalThis.crypto,
    signal,
    concurrency = 4,
    onProgress = null,
} = {}) {
    if (typeof fetchImpl !== 'function') fail('fetch-unavailable', 'Campaign pack loading requires fetch');
    const manifestUrl = campaignPackManifestUrl(apiBase, text(packId, 'packId'), releaseId);
    const manifest = validateCampaignPackManifest(
        await fetchJson(fetchImpl, manifestUrl, signal),
        { packId, releaseId },
    );
    const results = new Array(manifest.chunks.length);
    let nextIndex = 0;
    let loadedChunks = 0;
    let loadedBytes = 0;
    const workers = Array.from(
        { length: Math.max(1, Math.min(manifest.chunks.length, Math.trunc(concurrency) || 1)) },
        async () => {
            while (nextIndex < manifest.chunks.length) {
                const index = nextIndex++;
                const result = await loadChunk({
                    fetchImpl,
                    cryptoImpl,
                    manifestUrl,
                    manifest,
                    descriptor: manifest.chunks[index],
                    signal,
                });
                results[index] = result;
                loadedChunks += 1;
                loadedBytes += result.byteLength;
                onProgress?.({
                    loadedChunks,
                    totalChunks: manifest.chunks.length,
                    loadedBytes,
                    totalBytes: manifest.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
                });
            }
        },
    );
    await Promise.all(workers);
    return Object.freeze({
        contract: 'station3d-loaded-campaign-pack-v1',
        manifest,
        chunks: Object.freeze(results),
    });
}
