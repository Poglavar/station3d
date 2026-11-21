// Shadow mode must be inert by default and cannot confuse cancellation/failure with coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveWorldBakeShadowConfig, createBakedWorldShadowSession } from '../core/baked-world-shadow-session.js';
import { createBakedFarShadowIndex, farShadowGeometryKey } from '../core/baked-far-shadow-index.js';
import { readBoundedWorldResponse, createWorldBakeShadowTransport } from '../core/baked-world-shadow-transport.js';
import { compileFarBuildingBake, FAR_BUILDING_BAKE_VERSION } from '../core/compilers/far-building-bake.js';
import { worldTileAt, worldTileFrame, worldTileBounds } from '../core/world-tile-placement.js';
import { bakedWorldTileUrl, bakedWorldTileKey } from '../core/baked-world-manifest.js';
import { farBuildingColorForUseClass } from '../core/building-use-colors.js';
import { encodeBakedWorldTile } from '../core/baked-world-tile.js';
import { createFarBuildingBakeShadow } from '../world/buildings-bake-shadow.js';

const tile = worldTileFrame(worldTileAt(15.97, 45.81, 15)), hash = 'a'.repeat(64);
const config = { location: 'shadow-test', releaseId: 'release-a', baseUrl: 'http://localhost:8197' };
function feature(id = 'one', lon = 15.97) {
    return { type: 'Feature', properties: { footprint_source: 'gdi', footprint_id: id, object_id: id, eave_height_m: 12, use_class: 'D5- Školska' },
        geometry: { type: 'Polygon', coordinates: [[[lon, 45.81], [lon + .0001, 45.81], [lon + .0001, 45.8101], [lon, 45.8101], [lon, 45.81]]] } };
}
function bake(features = [feature()], identity = tile) {
    const b = worldTileBounds(identity);
    return compileFarBuildingBake({ sourceRevision: hash, payload: { contract: 'station3d-source-v1', schemaVersion: 1,
        layer: 'far-buildings', queryVersion: 'building-render-rows-v2', bounds: [b.west, b.south, b.east, b.north],
        simplification: {engine:'GEOS',version:'3.14.1',operation:'simplifyTP',toleranceM:1,inputSrid:3765,repeatedRuns:2,
            validation:'same-engine-input-selected-and-delivered-geojson',policy:'valid-render-footprint-v2',
            serialization:'geojson-6-or-15-valid-topology',cleanup:'invalid-delivered-interior-rings-only',
            maxRemovedRingAreaM2:1e-9,maxRemovedRingWidthM:1e-8},
        tiles: [{ key: `${identity.z}/${identity.x}/${identity.y}`, bounds: [b.west,b.south,b.east,b.north] }],
        features: features.map(f => ({ ...f, tileKeys: [`${identity.z}/${identity.x}/${identity.y}`] })) } },
    { tile: identity, revision: 'tile-a' });
}
function descriptor(identity = tile) {
    const value = { layer: 'far-buildings', lod: 1, revision: 'tile-a', sourceRevision: hash, tile: identity,
        compilerId: 'far-buildings', compilerVersion: '1.2.0', bakeVersion: FAR_BUILDING_BAKE_VERSION, entities: 1, primitives: 1,
        state: 'ready', byteLength: 100, sha256: hash, gzip: { byteLength: 50, sha256: hash } };
    return { ...value, url: bakedWorldTileUrl(value) };
}
function manifest(tiles = [descriptor()]) {
    return { contract: 'station3d-world-manifest-v1', schemaVersion: 1, ...config, tiles };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(session) {
    for (let i = 0; i < 200; i++) {
        await tick();
        const state = session.debugState();
        if (!state.active && !state.evidenceWorking && !state.pendingEvidence) return state;
    }
    throw new Error('Shadow did not settle');
}
function fakeTransport(overrides = {}) {
    const calls = [], index = createBakedFarShadowIndex();
    let disposed = false;
    return { calls,
        manifest: async () => manifest(),
        tile: async descriptor => { calls.push(['tile', descriptor]); return index.put(bake()); },
        retain: async keys => { calls.push(['retain', keys]); return index.retain(keys); },
        compare: async evidence => { calls.push(['compare', evidence.features.length]); return index.compare(evidence); },
        dispose: () => { disposed = true; calls.push(['dispose']); },
        state: () => ({ workers: disposed ? 0 : 1, pending: 0 }), ...overrides };
}

test('only explicit pinned loopback baking is enabled; incomplete and public authority flags fail closed', () => {
    assert.equal(resolveWorldBakeShadowConfig(new URL('https://example.com/?elevation=1')), null);
    const suffix = '?worldBake=shadow&worldBakeLocation=shadow-test&worldBakeRelease=release-a&worldBakePort=8197';
    assert.deepEqual(resolveWorldBakeShadowConfig(new URL('http://localhost:8196/' + suffix)), config);
    assert.deepEqual(resolveWorldBakeShadowConfig(new URL('http://localhost:8196/' + suffix.replace('worldBake=shadow', 'worldBake=authority'))),
        { ...config, mode: 'authority' });
    const qa = resolveWorldBakeShadowConfig(new URL('http://localhost:8196/' + suffix + '&worldBakeSourcePort=8199'));
    assert.equal(qa.sourceBaseUrl, 'http://localhost:8199/api');
    assert.equal(resolveWorldBakeShadowConfig(new URL('http://localhost/?worldBakeSourcePort=8199')), null);
    for (const port of ['0', '8199x', '65536', '']) assert.throws(() => resolveWorldBakeShadowConfig(new URL('http://localhost/' + suffix + '&worldBakeSourcePort=' + port)));
    for (const url of ['https://example.com/' + suffix, 'http://localhost/?worldBake=authority',
        'http://localhost/?worldBake=shadow', 'http://localhost/' + suffix.replace('8197', '5432x')]) {
        assert.throws(() => resolveWorldBakeShadowConfig(new URL(url)));
    }
});

test('neighbor copies retain one stable identity and conflicting footprints cannot be called parity', () => {
    const index = createBakedFarShadowIndex(), features = [feature()];
    index.put(bake(features));
    const neighbor = { ...tile, x: tile.x + 1 };
    const result = index.put(bake(features, neighbor));
    assert.equal(result.entities, 1); assert.equal(result.duplicateEntities, 1); assert.equal(result.duplicateCopies, 1);
    assert.equal(result.conflicts, 0); assert.equal(result.examples[0].copies.length, 2);
    assert.equal(result.examples[0].prospectiveOwner, bakedWorldTileKey(bake(features)));
    assert.equal(index.put(bake([feature('one', 15.97002)], neighbor)).conflicts, 1);
    assert.equal(index.summary().conflictExamples[0].entityId, 'gdi:one');
    assert.equal(index.summary().conflictExamples[0].geometryChanged, true);
    assert.equal(index.retain([bakedWorldTileKey(bake())]).duplicateEntities, 0);
    assert.equal(index.retain([]).entities, 0);
});

test('render rows match by namespaced identity; incomplete identities never become fabricated missing buildings', () => {
    const index = createBakedFarShadowIndex(); index.put(bake());
    const live = feature();
    assert.equal(index.compare({ kind: 'source', features: [live] }).matched, 1);
    delete live.properties.footprint_source;
    const result = index.compare({ kind: 'source', features: [live] });
    assert.equal(result.unsupportedSource, 1); assert.equal(result.missing, 0); assert.equal(result.matched, 0);
    assert.equal(result.examples[0].liveObjectId, 'one');
    assert.doesNotMatch(JSON.stringify(result), /undefined:/);
});

test('source comparison catches changed properties/geometry/missing coverage and does not count outside as a match', () => {
    const index = createBakedFarShadowIndex(); index.put(bake());
    const input = feature(), rotated = structuredClone(input.geometry), ring = rotated.coordinates[0].slice(0, -1).reverse();
    rotated.coordinates[0] = [...ring.slice(2), ...ring.slice(0, 2)]; rotated.coordinates[0].push(rotated.coordinates[0][0]);
    assert.equal(farShadowGeometryKey(input.geometry), farShadowGeometryKey(rotated));
    const changed = feature(); changed.properties.eave_height_m = 13;
    const report = index.compare({ kind: 'source', features: [input, changed, feature('one', 15.97002), feature('missing'), feature('outside', 16.5)] });
    assert.equal(report.matched, 1); assert.equal(report.changed, 2); assert.equal(report.missing, 1); assert.equal(report.outsideCoverage, 1);
    assert.equal(report.examined, 5);
});

test('selected geometry keeps live height/tint and terrain seating at different anchors without a baked nearKey', () => {
    const index = createBakedFarShadowIndex(); index.put(bake());
    for (const anchorLat of [45.81, 46.15]) {
        const input = feature();
        const selected = { source: 'gdi', objectId: 'one', geometry: input.geometry, heightM: 12, baseY: 73.125,
            color: farBuildingColorForUseClass(input.properties.use_class), nearKey: '17_-9' };
        const evidence = { kind: 'selected', features: [selected], frame: { anchorLat, anchorLon: 15.97, tileOriginX: 0, tileOriginZ: 37600 } };
        // Keep the geometry's GPU coordinates tile-local for the distant anchor case.
        evidence.frame.tileOriginZ = (anchorLat - 45.81) * Math.PI / 180 * 6371000;
        const report = index.compare(evidence);
        assert.equal(report.matched, 1, JSON.stringify(report)); assert.equal(report.changed, 0);
        assert.ok(report.maxVertexDeltaM < .0001);
        selected.color = 1;
        assert.equal(index.compare(evidence).changed, 1);
    }
});

test('session pins once, sends bounded chunks, rebase-local changes do not refetch and eviction releases evidence', async () => {
    const transport = fakeTransport();
    const session = createBakedWorldShadowSession({ config, transport, nextSlice: tick, chunkSize: 2 });
    session.updatePose({ lon: 15.97, lat: 45.81 });
    session.observeSource('0_0', [feature(), feature(), feature(), feature(), feature()]);
    await session.start();
    const state = await settle(session);
    assert.equal(state.loaded.length, 1); assert.equal(state.reports[0].matched, 5);
    assert.deepEqual(transport.calls.filter(call => call[0] === 'compare').map(call => call[1]), [2, 2, 1]);
    session.updatePose({ lon: 15.97, lat: 45.81, x: -30000, z: 20000 }); await tick();
    assert.equal(transport.calls.filter(call => call[0] === 'tile').length, 1);
    session.evictSource('0_0'); assert.equal(session.debugState().retainedLiveSources, 0);
    session.dispose(); assert.equal(session.debugState().workers, 0); assert.equal(session.debugState().loaded.length, 0);
});

test('movement cancels in-flight transfer; late decode is discarded, return/reopen uses the same pinned immutable release', async () => {
    let finish, signal;
    const transport = fakeTransport({ tile: async (_descriptor, value) => {
        signal = value; return new Promise(resolve => { finish = resolve; });
    } });
    const session = createBakedWorldShadowSession({ config, transport });
    session.updatePose({ lon: 15.97, lat: 45.81 }); await session.start(); await tick();
    session.updatePose({ lon: 17, lat: 46 }); assert.equal(signal.aborted, true);
    finish({ tiles: [bakedWorldTileKey(descriptor())] }); await tick(); await tick();
    assert.equal(session.debugState().loaded.length, 0); assert.equal(session.debugState().counters.cancelled, 1);
    assert.deepEqual(transport.calls.filter(call => call[0] === 'retain').at(-1)[1], []);
    session.dispose();
    const reopened = createBakedWorldShadowSession({ config, transport: fakeTransport() });
    reopened.updatePose({ lon: 15.97, lat: 45.81 }); await reopened.start();
    assert.equal((await settle(reopened)).releaseId, 'release-a'); reopened.dispose();
});

test('missing tiles stay failed without frame-driven retry or empty success; closing a pending session prevents late state', async () => {
    let attempts = 0;
    const transport = fakeTransport({ tile: async () => { attempts++; throw new Error('HTTP 404'); } });
    const session = createBakedWorldShadowSession({ config, transport });
    session.updatePose({ lon: 15.97, lat: 45.81 }); await session.start(); await tick();
    for (let i = 0; i < 10; i++) session.updatePose({ lon: 15.97, lat: 45.81 });
    assert.equal(attempts, 1); assert.equal(session.debugState().loaded.length, 0); assert.equal(session.debugState().failed.length, 1);
    session.dispose();
    let finish;
    const delayed = createBakedWorldShadowSession({ config, transport: fakeTransport({ manifest: () => new Promise(resolve => { finish = resolve; }) }) });
    const start = delayed.start(); delayed.dispose(); finish(manifest()); await start;
    assert.equal(delayed.debugState().phase, 'closed'); assert.equal(delayed.debugState().workers, 0);
});

test('unsupported compiler fails before any tile request', async () => {
    const incompatible = manifest(); incompatible.tiles[0].compilerVersion = '99.0.0';
    const transport = fakeTransport({ manifest: async () => incompatible });
    const session = createBakedWorldShadowSession({ config, transport });
    session.updatePose({ lon: 15.97, lat: 45.81 }); await session.start();
    assert.equal(session.debugState().phase, 'failed'); assert.equal(transport.calls.length, 0); session.dispose();
});

test('the 2.0.0 pilot with the incomplete validity contract is rejected before tile fetch', async () => {
    const obsolete=manifest();obsolete.tiles[0].bakeVersion='2.0.0';
    const transport=fakeTransport({manifest:async()=>obsolete});
    const session=createBakedWorldShadowSession({config,transport});
    session.updatePose({lon:15.97,lat:45.81});await session.start();
    assert.equal(session.debugState().phase,'failed');assert.equal(transport.calls.length,0);session.dispose();
});

test('response reading rejects oversize decoded bodies and HTTP errors instead of truncating', async () => {
    assert.deepEqual(new Uint8Array(await readBoundedWorldResponse(new Response(new Uint8Array([1, 2, 3])), 3)), new Uint8Array([1, 2, 3]));
    await assert.rejects(readBoundedWorldResponse(new Response(new Uint8Array([1, 2, 3, 4])), 3), /byte bound/);
    await assert.rejects(readBoundedWorldResponse(new Response('missing', { status: 404 }), 100), /HTTP 404/);
});

test('disposing the owned Worker rejects pending RPCs and terminates exactly once', async () => {
    let instance;
    class Worker { constructor() { instance = this; this.terminated = 0; } postMessage(message) { this.message = message; } terminate() { this.terminated++; } }
    const transport = createWorldBakeShadowTransport({ baseUrl: config.baseUrl, WorkerClass: Worker,
        scheduleNetworkRequest: ({ run }) => run() });
    const request = transport.retain([]);
    assert.equal(transport.state().pending, 1); transport.dispose(); transport.dispose();
    await assert.rejects(request, { name: 'AbortError' }); assert.equal(instance.terminated, 1);
    assert.deepEqual(transport.state(), { workers: 0, pending: 0 });
    await assert.rejects(transport.retain([]), { name: 'AbortError' });
});

test('optional shadow cannot break world opening when Worker construction is unavailable', () => {
    const previousWorker = globalThis.Worker, previousWarn = console.warn;
    globalThis.Worker = undefined; console.warn = () => {};
    try {
        const url = new URL('http://localhost:8196/?worldBake=shadow&worldBakeLocation=test&worldBakeRelease=test&worldBakePort=8197');
        const disabled = createFarBuildingBakeShadow({}, url);
        assert.equal(disabled.debugState().phase, 'disabled'); assert.equal(disabled.debugState().workers, 0);
        assert.equal(disabled.debugState().errors.length, 1); disabled.dispose();
        assert.equal(createFarBuildingBakeShadow({}, new URL('http://localhost:8196/')), null);
    } finally { globalThis.Worker = previousWorker; console.warn = previousWarn; }
});

test('offline shadow audit is dry-run first and exits nonzero for real conflicting decoded neighbor bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'st3d-shadow-audit-test-'));
    const cli = fileURLToPath(new URL('../../../tools/audit-station3d-shadow.mjs', import.meta.url));
    const output = join(dir, 'audit.json'), release = join(dir, 'release.json');
    const dry = spawnSync(process.execPath, [cli, '--release', release, '--out', output], { encoding: 'utf8' });
    assert.equal(dry.status, 0); assert.match(dry.stdout, /Usage:/); assert.equal(existsSync(output), false);
    const tiles = [bake(), bake([feature('one', 15.97002)], { ...tile, x: tile.x + 1 })];
    const descriptors = tiles.map((value, i) => {
        const raw = new Uint8Array(encodeBakedWorldTile(value)); writeFileSync(join(dir, `${i}.bin`), raw);
        return { ...descriptor(value.tile), byteLength: raw.byteLength, sha256: createHash('sha256').update(raw).digest('hex') };
    });
    writeFileSync(release, JSON.stringify({ contract: 'station3d-world-publication-v1', manifest: manifest(descriptors),
        files: descriptors.map((value, i) => ({ key: bakedWorldTileKey(value), path: `${i}.bin` })) }));
    const run = spawnSync(process.execPath, [cli, '--run', '--release', release, '--out', output], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    const report = JSON.parse(readFileSync(output));
    assert.equal(report.blocked, true); assert.equal(report.authorityAccepted, false);
    assert.equal(report.neighbours.conflictExamples[0].entityId, 'gdi:one');
    const before = readFileSync(output);
    const repeat = spawnSync(process.execPath, [cli, '--run', '--release', release, '--out', output], { encoding: 'utf8' });
    assert.notEqual(repeat.status, 0); assert.deepEqual(readFileSync(output), before);
});
