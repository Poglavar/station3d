// One-file handoff between the browser bake and the Node publication tool.
// The archive deliberately reuses S3L1 typed sections; it is an offline
// container only and is never served to a game client.

import {
    CAMPAIGN_PACK_CHUNK_CONTRACT,
    decodeCampaignPackChunk,
    encodeCampaignPackChunk,
    encodeCampaignPackChunkBlob,
} from './campaign-pack-binary.js';

export const CAMPAIGN_PACK_ARCHIVE_CONTRACT = 'station3d-campaign-pack-archive-v1';

export function encodeCampaignPackArchive({ manifest, chunks } = {}) {
    if (!manifest?.packId || !manifest?.releaseId || !Array.isArray(chunks) || chunks.length === 0) {
        throw new TypeError('Campaign pack archive requires a manifest and chunks');
    }
    return encodeCampaignPackChunk({
        contract: CAMPAIGN_PACK_CHUNK_CONTRACT,
        schemaVersion: 1,
        packId: manifest.packId,
        key: 'archive',
        packets: [],
        materials: {},
        archive: {
            contract: CAMPAIGN_PACK_ARCHIVE_CONTRACT,
            manifest,
            files: chunks.map(chunk => ({
                key: chunk.key,
                layerGroup: chunk.layerGroup,
                priority: chunk.priority,
                sha256: chunk.sha256,
                payload: chunk.payload,
            })),
        },
    });
}

export function encodeCampaignPackArchiveBlob({ manifest, chunks } = {}) {
    if (!manifest?.packId || !manifest?.releaseId || !Array.isArray(chunks) || chunks.length === 0) {
        throw new TypeError('Campaign pack archive requires a manifest and chunks');
    }
    return encodeCampaignPackChunkBlob({
        contract: CAMPAIGN_PACK_CHUNK_CONTRACT,
        schemaVersion: 1,
        packId: manifest.packId,
        key: 'archive',
        packets: [],
        materials: {},
        archive: {
            contract: CAMPAIGN_PACK_ARCHIVE_CONTRACT,
            manifest,
            files: chunks.map(chunk => ({
                key: chunk.key,
                layerGroup: chunk.layerGroup,
                priority: chunk.priority,
                sha256: chunk.sha256,
                payload: chunk.payload,
            })),
        },
    }, { type: 'application/vnd.station3d.campaign-archive' });
}

export function decodeCampaignPackArchive(value) {
    const container = decodeCampaignPackChunk(value);
    const archive = container.archive;
    if (container.key !== 'archive'
        || archive?.contract !== CAMPAIGN_PACK_ARCHIVE_CONTRACT
        || archive.manifest?.packId !== container.packId
        || !Array.isArray(archive.files)
        || archive.files.length === 0) {
        throw new Error('Invalid Station3D campaign pack archive');
    }
    const descriptors = new Map((archive.manifest.chunks || []).map(chunk => [chunk.key, chunk]));
    for (const file of archive.files) {
        const descriptor = descriptors.get(file.key);
        if (!descriptor || file.sha256 !== descriptor.sha256 || file.payload.byteLength !== descriptor.byteLength) {
            throw new Error(`Campaign pack archive file ${file.key || '(unknown)'} does not match its manifest`);
        }
    }
    return archive;
}
