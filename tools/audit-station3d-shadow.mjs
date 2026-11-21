// Replays a bounded local shadow compatibility gate without opening/rendering a city.
// A passing storage checksum is not cross-tile consistency or live-source parity.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorldManifest, bakedWorldTileKey } from '../website/station-3d/core/baked-world-manifest.js';
import { decodeBakedWorldTile, BAKED_WORLD_TILE_MAX_BYTES } from '../website/station-3d/core/baked-world-tile.js';
import { createBakedFarShadowIndex } from '../website/station-3d/core/baked-far-shadow-index.js';
import { FAR_SHADOW_COMPATIBILITY } from '../website/station-3d/core/baked-world-shadow-session.js';
import { readBoundedWorldResponse } from '../website/station-3d/core/baked-world-shadow-transport.js';

const args = process.argv.slice(2), arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
function read(path, maximum) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error(`Invalid bounded input: ${path}`);
    return readFileSync(path);
}
if (!args.includes('--run') || args.includes('--help')) {
    console.log('Usage: node tools/audit-station3d-shadow.mjs --run --release release.json [--live-url http://localhost:3001/api/buildings-render?bbox=...] [--out NEW.json]\nRead-only local inputs/API. At most nine pilot tiles; exit 2 means a compatibility blocker. Never publishes or accepts authority.');
} else {
    if (!arg('--release')) throw new Error('--release is required');
    const path = resolve(arg('--release')), bytes = read(path, 8 * 1024 * 1024), publication = JSON.parse(bytes);
    if (publication.contract !== 'station3d-world-publication-v1') throw new Error('Expected world publication artifact');
    const manifest = validateWorldManifest(publication.manifest, { layers: FAR_SHADOW_COMPATIBILITY });
    if (manifest.tiles.length > 9 || !Array.isArray(publication.files) || publication.files.length !== manifest.tiles.length) {
        throw new Error('Audit one bounded pilot coverage set (at most nine tiles)');
    }
    const files = new Map(publication.files.map(file => [file.key, file.path]));
    if (files.size !== manifest.tiles.length) throw new Error('Duplicate/missing tile files');
    const index = createBakedFarShadowIndex();
    for (const descriptor of manifest.tiles) {
        const file = files.get(bakedWorldTileKey(descriptor));
        if (typeof file !== 'string' || isAbsolute(file)) throw new Error('Tile file must be release-relative');
        const tilePath = resolve(dirname(path), file), within = relative(dirname(path), tilePath);
        if (within.startsWith('..') || isAbsolute(within)) throw new Error('Tile escaped the pilot artifact directory');
        const raw = read(tilePath, BAKED_WORLD_TILE_MAX_BYTES);
        if (raw.byteLength !== descriptor.byteLength) throw new Error('Manifest byte count mismatch');
        const tile = await decodeBakedWorldTile(raw, { ...descriptor, checksum: descriptor.sha256 });
        if (tile.bakeVersion !== descriptor.bakeVersion || tile.state !== descriptor.state
            || tile.entities.length !== descriptor.entities || tile.packet.primitives.length !== descriptor.primitives) {
            throw new Error('Decoded tile counts/version disagree with the pinned manifest');
        }
        index.put(tile);
    }
    const report = { contract: 'station3d-shadow-audit-v1', recordedAt: new Date().toISOString(),
        scope: 'bounded local compatibility diagnostic; not a headed or performance acceptance',
        releaseId: manifest.releaseId, publicationSha256: createHash('sha256').update(bytes).digest('hex'),
        neighbours: index.summary(), authorityAccepted: false, live: null };
    if (arg('--live-url')) {
        const url = new URL(arg('--live-url'));
        if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            || url.username || url.password || !['/api/buildings-render', '/api/buildings-lod1'].includes(url.pathname)) {
            throw new Error('Only an explicit loopback building endpoint may be inspected');
        }
        const body = await readBoundedWorldResponse(await fetch(url, { signal: AbortSignal.timeout(15000) }), 16 * 1024 * 1024);
        const value = JSON.parse(new TextDecoder().decode(body));
        if (!Array.isArray(value.features) || value.features.length > 10000) throw new Error('Live response has no bounded feature contract');
        report.live = { url: url.href, byteLength: body.byteLength, sha256: createHash('sha256').update(Buffer.from(body)).digest('hex'),
            features: value.features.length, propertyFields: Object.keys(value.features[0]?.properties || {}).sort(),
            comparison: index.compare({ kind: 'source', features: value.features }) };
    }
    report.blocked = report.neighbours.conflicts > 0 || !!report.live && (
        report.live.comparison.unsupportedSource > 0 || report.live.comparison.missing > 0 || report.live.comparison.changed > 0);
    if (arg('--out')) {
        const out = resolve(arg('--out')); mkdirSync(dirname(out), { recursive: true });
        const serialized = JSON.stringify(report, null, 2) + '\n';
        writeFileSync(out, serialized, { flag: 'wx' });
        if (readFileSync(out, 'utf8') !== serialized) throw new Error('Audit artifact readback failed');
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.blocked) process.exitCode = 2;
}
