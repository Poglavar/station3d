// Manual one-tile offline bake with immutable, read-back-verified output and safe resume.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, linkSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { compileFarBuildingBake, validateFarBuildingBakeSource, FAR_BUILDING_BAKE_VERSION } from '../website/station-3d/core/compilers/far-building-bake.js';
import { FAR_BUILDING_PACKET_COMPILER_ID, FAR_BUILDING_PACKET_COMPILER_VERSION } from '../website/station-3d/core/compilers/far-building-render-packet.js';
import { encodeBakedWorldTile, decodeBakedWorldTile, bakedWorldTileChecksum } from '../website/station-3d/core/baked-world-tile.js';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function publishFile(path, bytes) {
    if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error(`Refusing to overwrite conflicting artifact: ${path}`);
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const dir = mkdtempSync(join(dirname(path), '.st3d-bake-'));
    const candidate = join(dir, 'candidate');
    try {
        writeFileSync(candidate, bytes, { flag: 'wx' });
        if (sha256(readFileSync(candidate)) !== sha256(bytes)) throw new Error('Baked artifact readback failed');
        linkSync(candidate, path);
    } finally { if (existsSync(candidate)) unlinkSync(candidate); rmdirSync(dir); }
}
if (!args.includes('--run') || args.includes('--help')) {
    console.log('Usage: node tools/bake-station3d-far.mjs --run --source SNAPSHOT.json --tile 15/x/y --revision NAME --out TILE.bin\nOffline only. Builds and verifies one tile; never publishes a live release.');
} else {
    for (const name of ['--source', '--tile', '--revision', '--out']) if (!arg(name)) throw new Error(`${name} is required`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(arg('--revision'))) throw new Error('Revision must be a stable path-safe identifier');
    const parts = arg('--tile').split('/').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isInteger(n))) throw new Error('Tile must be z/x/y');
    const source = resolve(arg('--source')), output = resolve(arg('--out'));
    if (statSync(source).size > 64 * 1024 * 1024) throw new Error('Source file exceeds the 64 MiB safety limit');
    const snapshot = JSON.parse(readFileSync(source, 'utf8'));
    if (sha256(JSON.stringify(snapshot.payload)) !== snapshot.sourceRevision) throw new Error('Source snapshot checksum mismatch');
    // Resume is not an escape from a newly discovered source-validation failure.
    validateFarBuildingBakeSource(snapshot);
    const tile = { matrix: 'EPSG:3857', z: parts[0], x: parts[1], y: parts[2] };
    const expected = { tile, revision: arg('--revision'), sourceRevision: snapshot.sourceRevision,
        compilerId: FAR_BUILDING_PACKET_COMPILER_ID, compilerVersion: FAR_BUILDING_PACKET_COMPILER_VERSION };
    console.log(`[${new Date().toISOString()}] 0/1 · canonical source ${snapshot.sourceRevision}`);
    // A valid completed artifact skips compilation on resume. Never trust just
    // the descriptor: verify and decode the actual stored bytes first.
    const descriptorPath = output + '.json';
    if (existsSync(output) && existsSync(descriptorPath)) {
        const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
        if (descriptor.bakeVersion !== FAR_BUILDING_BAKE_VERSION) throw new Error('Existing bake version is incompatible; use a new revision/output');
        await decodeBakedWorldTile(readFileSync(output), { ...expected, checksum: descriptor.sha256 });
        if (!existsSync(output + '.gz') || sha256(readFileSync(output + '.gz')) !== descriptor.gzip.sha256) throw new Error('Stored gzip artifact is missing or corrupt');
        console.log(`[${new Date().toISOString()}] 1/1 · already complete: ${output}`);
    } else {
        const baked = compileFarBuildingBake(snapshot, { tile, revision: arg('--revision') });
        const bytes = new Uint8Array(encodeBakedWorldTile(baked));
        const checksum = await bakedWorldTileChecksum(bytes);
        await decodeBakedWorldTile(bytes, { ...expected, checksum });
        const gzip = gzipSync(bytes, { level: 6 });
        const descriptor = {
            contract: 'station3d-baked-world-descriptor-v1', ...expected, lod: 1, layer: 'far-buildings',
            state: baked.state, compilerId: baked.packet.compilerId, compilerVersion: baked.packet.compilerVersion,
            bakeVersion: baked.bakeVersion, byteLength: bytes.byteLength, sha256: checksum,
            entities: baked.entities.length, primitives: baked.packet.primitives.length,
            gzip: { byteLength: gzip.byteLength, sha256: sha256(gzip) },
        };
        publishFile(output, bytes); publishFile(output + '.gz', gzip);
        publishFile(descriptorPath, Buffer.from(JSON.stringify(descriptor, null, 2) + '\n'));
        console.log(`[${new Date().toISOString()}] 1/1 · ${descriptor.entities} entities · ${descriptor.primitives} prisms · ${bytes.byteLength} bytes (${gzip.byteLength} gzip) · ${output}`);
    }
}
