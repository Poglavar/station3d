// A session pins an immutable release; explicit empty coverage is still a checksummed tile.
import { worldTileFrame } from './world-tile-placement.js';
import { BAKED_WORLD_TILE_MAX_BYTES } from './baked-world-tile.js';

export const WORLD_MANIFEST_CONTRACT = 'station3d-world-manifest-v1';
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const validId = value => typeof value === 'string' && ID.test(value);
function requireValue(ok, message) { if (!ok) throw new TypeError(message); }

export function bakedWorldTileKey(descriptor) {
    return `${descriptor.layer}/${descriptor.lod}/${descriptor.tile.z}/${descriptor.tile.x}/${descriptor.tile.y}`;
}
export function bakedWorldTileUrl(descriptor) {
    return `/api/station3d/tiles/${descriptor.layer}/${descriptor.revision}/${descriptor.lod}/${descriptor.tile.z}/${descriptor.tile.x}/${descriptor.tile.y}.bin`;
}
export function validateWorldManifest(value, expected = {}) {
    requireValue(value?.contract === WORLD_MANIFEST_CONTRACT && value.schemaVersion === 1, 'Unsupported world manifest contract');
    requireValue(validId(value.location) && validId(value.releaseId), 'Invalid world release identity');
    for (const key of ['location', 'releaseId']) {
        requireValue(expected[key] == null || expected[key] === value[key], `World ${key} mismatch`);
    }
    requireValue(Array.isArray(value.tiles) && value.tiles.length > 0 && value.tiles.length <= 4096, 'World release needs bounded, explicit tile coverage');
    const keys = new Set();
    for (const tile of value.tiles) {
        requireValue(typeof tile?.layer === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(tile.layer) && validId(tile.revision), 'Invalid tile layer/revision');
        requireValue(Number.isInteger(tile.lod) && tile.lod >= 0 && tile.lod <= 16, 'Invalid tile LOD');
        worldTileFrame(tile.tile);
        requireValue(['ready', 'empty'].includes(tile.state), 'Missing explicit tile state');
        for (const version of ['compilerId', 'compilerVersion', 'bakeVersion']) requireValue(validId(tile[version]), `Invalid ${version}`);
        requireValue(HASH.test(tile.sourceRevision), 'Invalid tile source revision');
        requireValue(Number.isInteger(tile.entities) && tile.entities >= 0 && Number.isInteger(tile.primitives) && tile.primitives >= 0,
            'Invalid tile entity/primitive counts');
        requireValue((tile.state === 'empty') === (tile.primitives === 0), 'Tile state/count disagreement');
        for (const representation of [tile, tile.gzip]) {
            requireValue(Number.isInteger(representation?.byteLength) && representation.byteLength > 0
                && representation.byteLength <= BAKED_WORLD_TILE_MAX_BYTES && HASH.test(representation.sha256), 'Invalid tile representation');
        }
        const key = bakedWorldTileKey(tile);
        requireValue(!keys.has(key), 'Duplicate tile coverage'); keys.add(key);
        requireValue(tile.url === bakedWorldTileUrl(tile), 'Tile URL must identify its pinned immutable revision');
        const supported = expected.layers?.[tile.layer];
        if (expected.layers) {
            requireValue(supported, 'Unsupported world layer');
            for (const field of ['compilerId', 'compilerVersion', 'bakeVersion', 'lod']) {
                requireValue(supported[field] == null || supported[field] === tile[field], `Unsupported tile ${field}`);
            }
            requireValue(supported.z == null || supported.z === tile.tile.z, 'Unsupported tile zoom');
        }
    }
    return value;
}

export function worldManifestText(value) {
    validateWorldManifest(value);
    return JSON.stringify(value, (_, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Non-finite manifest metadata');
        return item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item;
    });
}
