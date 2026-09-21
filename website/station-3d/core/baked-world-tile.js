// Immutable base-world envelope; runtime generations, terrain seating and LOD decisions stay live.
import { createTypedArrayEnvelopeCodec, TypedArrayEnvelopeError } from './typed-array-envelope.js';
import { validateRenderPacket } from './render-packet.js';
import {
    WORLD_TILE_PROJECTION, WORLD_TILE_EARTH_RADIUS_M, validateWorldTileFrame, validateWorldTileVertical,
} from './world-tile-placement.js';

export const BAKED_WORLD_TILE_CONTRACT = 'station3d-baked-world-tile-v1';
export const BAKED_WORLD_TILE_MAGIC = 'S3B1';
export const BAKED_WORLD_TILE_MAX_BYTES = 64 * 1024 * 1024;

function fail(message) { throw new TypedArrayEnvelopeError('invalid-world-tile', message); }
function text(value, label) {
    if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
}

export function validateBakedWorldTile(value, expected = {}) {
    if (value?.contract !== BAKED_WORLD_TILE_CONTRACT || value.schemaVersion !== 1) fail('Unsupported baked world tile contract');
    for (const key of ['layer', 'revision', 'sourceRevision']) text(value[key], key);
    if (!/^[a-z][a-z0-9-]*$/.test(value.layer)) fail('Invalid layer key');
    if (!Number.isInteger(value.lod) || value.lod < 0) fail('Invalid world tile LOD');
    validateWorldTileFrame(value.tile);
    if (value.frame?.projection !== WORLD_TILE_PROJECTION || value.frame.units !== 'metres'
        || value.frame.axes !== 'east-up-south' || value.frame.earthRadiusM !== WORLD_TILE_EARTH_RADIUS_M) {
        fail('Unsupported world tile coordinate frame');
    }
    validateWorldTileVertical(value.frame.vertical);
    validateRenderPacket(value.packet, { generation: 0, tile: value.tile, sourceRevision: value.sourceRevision });
    if (!['ready', 'empty'].includes(value.state)
        || (value.state === 'empty') !== (value.packet.primitives.length === 0)) fail('World tile empty state disagrees with geometry');
    if (!value.materials || typeof value.materials !== 'object' || Array.isArray(value.materials)) fail('Missing material profiles');
    if (!Array.isArray(value.entities)) fail('Missing immutable entity metadata');
    const ids = new Set();
    for (const entity of value.entities) {
        text(entity?.entityId, 'entityId');
        if (ids.has(entity.entityId)) fail('Duplicate world tile entity identity');
        if (entity.nearKey != null) fail('Session nearKey cannot be baked');
        ids.add(entity.entityId);
    }
    for (const primitive of value.packet.primitives) {
        if (!Object.hasOwn(value.materials, primitive.materialKey)) fail('Unknown material profile');
        for (const range of primitive.entityRanges) {
            if (!ids.has(range.entityId)) fail('Geometry references an unknown entity');
            if (range.metadata?.nearKey != null) fail('Session nearKey cannot be baked');
        }
    }
    for (const key of ['layer', 'revision', 'sourceRevision', 'lod']) {
        if (expected[key] != null && expected[key] !== value[key]) fail(`World tile ${key} mismatch`);
    }
    if (expected.tile) {
        for (const key of ['matrix', 'z', 'x', 'y']) {
            if (expected.tile[key] !== value.tile[key]) fail('World tile identity mismatch');
        }
    }
    if (expected.compilerId != null && value.packet.compilerId !== expected.compilerId) fail('World tile compiler mismatch');
    if (expected.compilerVersion != null && value.packet.compilerVersion !== expected.compilerVersion) fail('World tile compiler version mismatch');
    return value;
}

const codec = createTypedArrayEnvelopeCodec({
    magic: BAKED_WORLD_TILE_MAGIC, version: 1, validate: validateBakedWorldTile,
    label: 'Baked world tile', maxBytes: BAKED_WORLD_TILE_MAX_BYTES,
});
export const encodeBakedWorldTile = codec.encode;
export const encodeBakedWorldTileBlob = codec.encodeBlob;

export async function bakedWorldTileChecksum(value) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!bytes || bytes.byteLength > BAKED_WORLD_TILE_MAX_BYTES) fail('Invalid world tile byte length');
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Invoke in the decode Worker for real streaming; async checksum does not justify
// decoding large geometry on the main thread. A missing tile is never empty success.
export async function decodeBakedWorldTile(bytes, expected = {}) {
    if (expected.checksum != null) {
        if (!/^[0-9a-f]{64}$/.test(expected.checksum)
            || await bakedWorldTileChecksum(bytes) !== expected.checksum) fail('World tile checksum mismatch');
    }
    return validateBakedWorldTile(codec.decode(bytes), expected);
}
