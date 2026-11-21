// Visible baked authority must replace source/compile work without changing
// runtime terrain placement, bounded selection, picking or tile lifetimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bakedFarCoverage, indexBakedFarTile, selectBakedFarFeatures, prepareBakedFarPacket } from '../core/baked-far-authority.js';
import { createBakedFarAuthoritySession } from '../core/baked-far-authority-session.js';
import { compileFarBuildingBake, FAR_BUILDING_BAKE_VERSION } from '../core/compilers/far-building-bake.js';
import { compileFarBuildingRenderPacket } from '../core/compilers/far-building-render-packet.js';
import { worldTileAt, worldTileFrame, worldTileBounds } from '../core/world-tile-placement.js';
import { bakedWorldTileKey, bakedWorldTileUrl } from '../core/baked-world-manifest.js';
import { geoToLocal } from '../core/math.js';
import { pickFarHeightForFeature } from '../world/lod1-geometry.js';
import { createGeometryMemoryBudget } from '../core/geometry-memory-budget.js';

const hash = 'a'.repeat(64), tile = worldTileFrame(worldTileAt(15.97, 45.81, 15));
const bounds = worldTileBounds(tile);
const bbox = { west: 15.969, south: 45.809, east: 15.971, north: 45.811 };
const config = { location: 'authority-test', releaseId: 'release-a', baseUrl: 'http://localhost:8198', mode: 'authority' };
function feature(id = 'one', priority = 12) {
    return { type: 'Feature', properties: { footprint_source: 'gdi', footprint_id: id, object_id: id,
        eave_height_m: 12, use_class: 'D5- Školska' }, selection: { priority },
    geometry: { type: 'Polygon', coordinates: [[[15.97,45.81],[15.9701,45.81],[15.9701,45.8101],[15.97,45.8101],[15.97,45.81]]] } };
}
function bake(features = [feature()], identity = tile) {
    const b = worldTileBounds(identity), key = `${identity.z}/${identity.x}/${identity.y}`;
    return compileFarBuildingBake({ sourceRevision: hash, payload: { contract: 'station3d-source-v1', schemaVersion: 1,
        layer: 'far-buildings', queryVersion: 'building-render-rows-v2',
        simplification: { engine: 'GEOS', version: '3.14.1', operation: 'simplifyTP', toleranceM: 1, inputSrid: 3765,
            repeatedRuns: 2, validation: 'same-engine-input-selected-and-delivered-geojson', policy: 'valid-render-footprint-v2',
            serialization: 'geojson-6-or-15-valid-topology', cleanup: 'invalid-delivered-interior-rings-only',
            maxRemovedRingAreaM2: 1e-9, maxRemovedRingWidthM: 1e-8 },
        tiles: [{ key, bounds: [b.west,b.south,b.east,b.north] }],
        features: features.map(f => ({ ...f, tileKeys: [key] })) } }, { tile: identity, revision: 'tile-a' });
}
function descriptor(baked) {
    const d = { layer: 'far-buildings', lod: 1, revision: baked.revision, sourceRevision: hash, tile: baked.tile,
        compilerId: 'far-buildings', compilerVersion: '1.2.0', bakeVersion: FAR_BUILDING_BAKE_VERSION,
        entities: baked.entities.length, primitives: baked.packet.primitives.length, state: baked.state,
        byteLength: 100, sha256: hash, gzip: { byteLength: 50, sha256: hash } };
    return { ...d, url: bakedWorldTileUrl(d) };
}
function manifest(baked = [bake()]) {
    return { contract: 'station3d-world-manifest-v1', schemaVersion: 1,
        location: config.location, releaseId: config.releaseId, tiles: baked.map(descriptor) };
}
function request(features, { anchorLat = 45.81, anchorLon = 15.97, baseY = 72.25 } = {}) {
    const origin = geoToLocal(15.968, 45.812, anchorLon, anchorLat);
    return { compilerId: 'far-buildings', compilerVersion: '1.2.0', sourceRevision: 'runtime:1', generation: 7,
        tile: { matrix: 'station3d-local-metre-v1', z: 0, x: 1, y: 1, originLon: 15.968, originLat: 45.812, sizeM: 800 },
        inputs: { anchorLat, anchorLon, tileOriginX: origin.x, tileOriginZ: origin.z,
            features: features.map(f => ({ objectId: f.properties.object_id, entityId: `gdi:${f.properties.object_id}`,
                nearKey: '3_4', color: 0x123456, geometry: f.geometry, baseY,
                heightM: pickFarHeightForFeature(f.properties, f.geometry, anchorLat) })) } };
}
function transportFor(baked = [bake()], overrides = {}) {
    const byKey = new Map(baked.map(b => [bakedWorldTileKey(b), b]));
    const calls = { manifests: 0, tiles: 0, disposed: 0, signals: [] };
    return { calls,
        async manifest() { calls.manifests++; return manifest(baked); },
        async tile(d, signal, options) {
            calls.tiles++; calls.signals.push(signal);
            assert.equal(options.alreadyScheduled, true, 'do not nest a network slot inside the source slot');
            return indexBakedFarTile(byKey.get(bakedWorldTileKey(d)));
        },
        dispose() { calls.disposed++; }, state: () => ({ workers: calls.disposed ? 0 : 1, pending: 0 }), ...overrides };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only complete geographic coverage can replace a local tile, including explicit empty coverage', () => {
    assert.equal(bakedFarCoverage(manifest(), bbox).length, 1);
    assert.equal(bakedFarCoverage(manifest(), bounds).length, 1);
    assert.equal(bakedFarCoverage(manifest(), { ...bbox, west: bounds.west - .001 }), null);
    assert.equal(bakedFarCoverage(manifest([bake([])]), bbox)[0].state, 'empty');
});

test('frozen priority is capped before gameplay filtering; global border copies do not create a second instance', () => {
    const features = Array.from({ length: 605 }, (_, i) => feature(`id-${String(i).padStart(3, '0')}`, i));
    const a = indexBakedFarTile(bake(features)), b = indexBakedFarTile(bake(features, { ...tile, x: tile.x + 1 }));
    const selected = selectBakedFarFeatures([a, b], bbox);
    assert.equal(selected.features.length, 600); assert.equal(selected.records.size, 600);
    assert.equal(selected.features[0].properties.object_id, 'id-604');
    assert.equal(selected.features.at(-1).properties.object_id, 'id-005');
    const req = request(selected.features.slice(1)); // One selected proposal demolition, no backfill.
    assert.equal(prepareBakedFarPacket(req, selected).packet.primitives.length, 599);
    const changed = indexBakedFarTile(bake([feature('id-604', 7)], { ...tile, x: tile.x + 1 }));
    changed.records[0].entity.feature.properties.eave_height_m = 100;
    assert.throws(() => selectBakedFarFeatures([a, changed], bbox), /Conflicting/);
});

test('instance placement equals fresh live geometry at changed anchors without rewriting baked buffers', () => {
    const f = feature(); f.properties.eave_height_m = null;
    const indexed = indexBakedFarTile(bake([f]));
    const selection = selectBakedFarFeatures([indexed], bbox);
    for (const anchor of [{ anchorLat: 45.81, anchorLon: 15.97 }, { anchorLat: 46.15, anchorLon: 16.05 }]) {
        const req = request(selection.features, anchor), baked = prepareBakedFarPacket(req, selection);
        const fresh = compileFarBuildingRenderPacket(req).primitives[0], original = indexed.tile.packet.primitives[0];
        const p = baked.placements.get('one'), actual = baked.packet.primitives[0];
        assert.equal(actual.positions, original.positions); assert.equal(actual.indices, original.indices);
        assert.equal(actual.entityRanges[0].metadata.nearKey, '3_4');
        assert.equal(original.entityRanges[0].metadata.nearKey, null, 'session metadata must not mutate the immutable tile');
        for (let i = 0; i < fresh.positions.length; i += 3) {
            assert.ok(Math.abs(actual.positions[i] * p.scaleX + p.x - fresh.positions[i]) < .0001);
            assert.ok(Math.abs(actual.positions[i+1] * p.scaleY + p.y - fresh.positions[i+1]) < .0001);
            assert.ok(Math.abs(actual.positions[i+2] + p.z - fresh.positions[i+2]) < .0001);
        }
    }
    assert.throws(() => prepareBakedFarPacket(request(selection.features, { baseY: null }), selection), /terrain evidence/);
});

test('healthy authority suppresses live loading, supplies packets, shares decoded tiles and releases them on eviction', async () => {
    const transport = transportFor(), memoryBudget = createGeometryMemoryBudget({ nearBytes: 1e6, farBytes: 1e6 });
    const session = createBakedFarAuthoritySession({ config, transport, memoryBudget });
    const signal = new AbortController().signal;
    let live = 0;
    const loadLive = async () => { live++; return { features: [] }; };
    const a = await session.loadPayload({ bbox, tileKey: '0_0', signal, loadLive });
    const b = await session.loadPayload({ bbox, tileKey: '1_0', signal, loadLive });
    assert.equal(live, 0); assert.equal(transport.calls.tiles, 1); assert.equal(transport.calls.manifests, 1);
    assert.equal(session.packetFor(request(a.features), a.features).packet.primitives.length, 1);
    assert.equal(session.packetFor(request(b.features), b.features).packet.primitives.length, 1);
    assert.equal(session.packetFor(request(a.features), [...a.features]), null, 'ordinary source must still compile');
    assert.ok(session.debugState().retainedPacketBytes > 0);
    assert.equal(memoryBudget.snapshot().source.count, 1);
    assert.equal(memoryBudget.snapshot().source.cpuBytes, session.debugState().retainedPacketBytes);
    session.evictSource('0_0'); assert.equal(session.debugState().loaded.length, 1);
    session.evictSource('1_0'); assert.equal(session.debugState().loaded.length, 0);
    assert.equal(session.debugState().retainedPacketBytes, 0);
    assert.equal(memoryBudget.snapshot().source.count, 0);
    assert.equal(memoryBudget.snapshot().estimatedBytes, 0);
    session.dispose(); session.dispose(); assert.equal(transport.calls.disposed, 1);
});

test('partial coverage and corrupt tiles keep a live city; corrupt baked keys are not retried per source tile', async () => {
    const transport = transportFor(), session = createBakedFarAuthoritySession({ config, transport });
    const signal = new AbortController().signal;
    let live = 0;
    const liveFeatures = [feature('live')], loadLive = async () => { live++; return { features: liveFeatures }; };
    assert.equal((await session.loadPayload({ bbox: { ...bbox, west: bounds.west - .001 }, tileKey: '-1_0', signal, loadLive })).features, liveFeatures);
    assert.equal(transport.calls.tiles, 0); assert.equal(live, 1); session.dispose();
    const broken = transportFor();
    broken.tile = async () => { broken.calls.tiles++; throw new Error('World tile checksum mismatch'); };
    const fallback = createBakedFarAuthoritySession({ config, transport: broken });
    for (const tileKey of ['0_0', '1_0']) {
        assert.equal((await fallback.loadPayload({ bbox, tileKey, signal, loadLive })).features, liveFeatures);
    }
    assert.equal(broken.calls.tiles, 1); assert.equal(live, 3);
    assert.equal(fallback.debugState().loaded.length, 0);
    assert.equal(fallback.packetFor(request(liveFeatures), liveFeatures), null);
    fallback.dispose();
});

test('only a checksummed explicit empty tile suppresses live work; incompatible manifests fall back before tile fetch', async () => {
    let live = 0;
    const input = { bbox, tileKey: '0_0', signal: new AbortController().signal,
        loadLive: async () => { live++; return { features: [feature('live')] }; } };
    const emptyTransport = transportFor([bake([])]), empty = createBakedFarAuthoritySession({ config, transport: emptyTransport });
    const result = await empty.loadPayload(input);
    assert.equal(result.features.length, 0); assert.equal(emptyTransport.calls.tiles, 1); assert.equal(live, 0);
    assert.equal(empty.packetFor(request(result.features), result.features).packet.primitives.length, 0);
    empty.dispose();
    const bad = transportFor();
    bad.manifest = async () => { const m = manifest(); m.tiles[0].compilerVersion = 'unsupported'; return m; };
    const session = createBakedFarAuthoritySession({ config, transport: bad });
    assert.equal((await session.loadPayload(input)).features[0].properties.object_id, 'live');
    assert.equal(bad.calls.tiles, 0); assert.equal(session.debugState().phase, 'live-fallback'); session.dispose();
});

test('closing or evicting a pending transfer rejects late data without a fallback or retained geometry', async () => {
    for (const close of [false, true]) {
        let finish, entered = false, live = 0;
        const transport = transportFor();
        transport.tile = async (_d, signal) => {
            transport.calls.signals.push(signal); entered = true;
            return new Promise(resolve => { finish = resolve; });
        };
        const session = createBakedFarAuthoritySession({ config, transport }), controller = new AbortController();
        const pending = session.loadPayload({ bbox, tileKey: '0_0', signal: controller.signal,
            loadLive: async () => { live++; return { features: [] }; } });
        while (!entered) await tick();
        const rejection = assert.rejects(pending, { name: 'AbortError' });
        if (close) session.dispose(); else controller.abort();
        assert.equal(transport.calls.signals[0].aborted, true);
        finish(indexBakedFarTile(bake())); await rejection;
        assert.equal(live, 0); assert.equal(session.debugState().loaded.length, 0);
        assert.equal(session.debugState().tiles.length, 0); session.dispose();
    }
});

test('visible-mode wiring uses the shared terrain gate, upload queue and publication path', () => {
    const source = readFileSync(new URL('../world/buildings-far.js', import.meta.url), 'utf8');
    assert.match(source, /loadPayload: bakeShadow\?\.loadPayload/);
    assert.ok(source.indexOf('farFeatures.some(feature => feature.baseY === null)') < source.indexOf('bakeShadow?.packetFor?.'));
    assert.match(source, /job\.compileHandle = bakedPacket \? \{ promise: Promise\.resolve\(bakedPacket\.packet\) \}/);
    assert.match(source, /matrix\.makeScale\(placement\.scaleX, placement\.scaleY, 1\)/);
    assert.match(source, /matrix\.setPosition\(placement\.x, placement\.y, placement\.z\)/);
    assert.match(source, /batch\.setMatrixAt\(ref\.instanceId, matrix\)/);
    assert.match(source, /publicationTicket\.publish\(root/);
});
