// Locks immutable world-tile identity, binary integrity, and anchor-independent placement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { encodeCampaignPackChunk, decodeCampaignPackChunk } from '../core/campaign-pack-binary.js';
import { geoToLocal, EARTH_RADIUS_M } from '../core/math.js';
import { compileFarBuildingRenderPacket } from '../core/compilers/far-building-render-packet.js';
import {
    worldTileAt, worldTileFrame, worldTilePlacement, placeWorldTilePoint,
} from '../core/world-tile-placement.js';
import {
    BAKED_WORLD_TILE_CONTRACT, encodeBakedWorldTile, decodeBakedWorldTile,
    validateBakedWorldTile, bakedWorldTileChecksum,
} from '../core/baked-world-tile.js';

function fixture() {
    const tile = worldTileFrame(worldTileAt(15.97, 45.81, 15));
    const packet = compileFarBuildingRenderPacket({
        sourceRevision: 'source-test-1', generation: 0, tile,
        inputs: {
            anchorLon: tile.originLon, anchorLat: tile.originLat, tileOriginX: 0, tileOriginZ: 0,
            features: [{
                entityId: 'building:1', objectId: '1', heightM: 20, baseY: 0, color: 0x789abc,
                geometry: { type: 'Polygon', coordinates: [[
                    [15.97, 45.81], [15.9702, 45.81], [15.9702, 45.8102],
                    [15.97, 45.8102], [15.97, 45.81],
                ]] },
            }],
        },
    });
    return {
        contract: BAKED_WORLD_TILE_CONTRACT, schemaVersion: 1,
        layer: 'far-buildings', revision: 'fixture-v1', sourceRevision: 'source-test-1', lod: 1,
        state: 'ready', tile, packet,
        frame: {
            projection: 'station3d-equirectangular-v1', units: 'metres', axes: 'east-up-south',
            earthRadiusM: EARTH_RADIUS_M,
            vertical: { mode: 'foundation-relative', datum: null, originHeightM: 0 },
        },
        materials: { 'far-buildings': { profile: 'far-buildings-v1' } },
        entities: [{ entityId: 'building:1', objectId: '1' }],
    };
}

test('S3L1 campaign bytes are unchanged by shared envelope extraction', () => {
    const old = {
        contract: 'station3d-campaign-pack-chunk-v1', schemaVersion: 1,
        packId: 'legacy-fixture', key: 'tile-0', materials: { stone: { color: 123 } }, packets: [],
        extra: { floats: new Float32Array([1.25, -2, 0]), indices: new Uint16Array([0, 1, 2]), raw: new Uint8Array([4, 5]).buffer },
    };
    const bytes = encodeCampaignPackChunk(old);
    assert.equal(bytes.byteLength, 464);
    assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
        '3d1291be98210d9d54b7008c7c9eff3ec7f0ae8b3a09739f4f79ff8f8bda499b');
    assert.deepEqual(decodeCampaignPackChunk(bytes), old);
});

test('baked geometry is deterministic, owns decoded buffers, and verifies its checksum', async () => {
    const source = fixture();
    const bytes = encodeBakedWorldTile(source);
    const checksum = await bakedWorldTileChecksum(bytes);
    assert.equal(checksum, createHash('sha256').update(new Uint8Array(bytes)).digest('hex'));
    const decoded = await decodeBakedWorldTile(bytes, { checksum, revision: 'fixture-v1', tile: source.tile });
    assert.deepEqual(decoded, source);
    assert.deepEqual(new Uint8Array(encodeBakedWorldTile(decoded)), new Uint8Array(bytes));
    new Uint8Array(bytes).fill(0);
    assert.ok(decoded.packet.primitives[0].positions.some(value => value !== 0));
    await assert.rejects(decodeBakedWorldTile(encodeBakedWorldTile(source), { checksum: '0'.repeat(64) }), /checksum/i);
});

test('malformed, stale, session-specific, or ambiguous tiles fail closed', async () => {
    for (const mutate of [
        t => { t.packet.generation = 12; },
        t => { t.tile.originLon += 0.001; },
        t => { t.frame.earthRadiusM = 6378137; },
        t => { t.frame.vertical.originHeightM = null; },
        t => { t.packet.sourceRevision = 'different'; },
        t => { t.entities.push(t.entities[0]); },
        t => { t.packet.primitives[0].entityRanges[0].metadata.nearKey = 'session-tile'; },
        t => { t.state = 'empty'; },
        t => { t.packet.primitives[0].positions[0] = NaN; },
    ]) {
        const bad = fixture(); mutate(bad);
        assert.throws(() => validateBakedWorldTile(bad));
    }
    const bytes = encodeBakedWorldTile(fixture());
    await assert.rejects(decodeBakedWorldTile(bytes, { revision: 'other' }), /revision/i);
    await assert.rejects(decodeBakedWorldTile(bytes.slice(0, -1)), /length|truncat/i);
    new Uint8Array(bytes)[0] = 0;
    await assert.rejects(decodeBakedWorldTile(bytes), /magic/i);
});

test('explicit empty tiles round-trip, unlike missing or failed tiles', async () => {
    const tile = fixture();
    tile.state = 'empty'; tile.packet.primitives = []; tile.entities = [];
    assert.equal((await decodeBakedWorldTile(encodeBakedWorldTile(tile))).state, 'empty');
    assert.throws(() => validateBakedWorldTile(null));
});

test('slippy identities use global EPSG:3857 indexing but physical metre vertices', () => {
    assert.deepEqual(worldTileAt(0, 0, 1), { matrix: 'EPSG:3857', z: 1, x: 1, y: 1 });
    assert.deepEqual(worldTileAt(-180, 85, 1), { matrix: 'EPSG:3857', z: 1, x: 0, y: 0 });
    for (const bad of [[null, 45, 15], [15, null, 15], [181, 45, 15], [15, 86, 15], [15, 45, -1]]) {
        assert.throws(() => worldTileAt(...bad));
    }
    assert.throws(() => worldTileFrame({ matrix: 'local', z: 15, x: 0, y: 0 }));
    assert.throws(() => worldTileFrame({ matrix: 'EPSG:3857', z: 15, x: 32768, y: 0 }));
});

test('two anchors and a floating-origin rebase match direct world projection', () => {
    const tile = fixture().tile;
    const point = { lon: 15.97015, lat: 45.81017 };
    const local = geoToLocal(point.lon, point.lat, tile.originLon, tile.originLat);
    for (const anchor of [{ lon: 15.96, lat: 45.80 }, { lon: 16.05, lat: 46.15 }]) {
        for (const rebase of [{ x: 0, z: 0 }, { x: 2300, z: -1700 }]) {
            const placement = worldTilePlacement(tile, { anchor });
            const actual = placeWorldTilePoint({ ...local, y: 20 }, placement);
            const expected = geoToLocal(point.lon, point.lat, anchor.lon, anchor.lat);
            // Rebase belongs to the scene root, not to the immutable tile adapter.
            assert.ok(Math.abs((actual.x - rebase.x) - (expected.x - rebase.x)) < 1e-7);
            assert.ok(Math.abs((actual.z - rebase.z) - (expected.z - rebase.z)) < 1e-7);
            assert.equal(actual.y, 20);
        }
    }
});

test('adjacent tile coordinates share a seam under a different anchor', () => {
    const left = fixture().tile;
    const right = worldTileFrame({ ...left, x: left.x + 1 });
    const seam = { lon: right.originLon, lat: right.originLat - 0.003 };
    const anchor = { lon: 16.04, lat: 46.1 };
    const positions = [left, right].map(tile => placeWorldTilePoint({
        ...geoToLocal(seam.lon, seam.lat, tile.originLon, tile.originLat), y: 12,
    }, worldTilePlacement(tile, { anchor })));
    assert.ok(Math.abs(positions[0].x - positions[1].x) < 1e-7);
    assert.ok(Math.abs(positions[0].z - positions[1].z) < 1e-7);
});

test('datum translation is explicit and missing elevation cannot become sea level', () => {
    const tile = fixture().tile;
    const anchor = { lon: 15.97, lat: 45.81 };
    const vertical = { mode: 'absolute-datum', datum: 'HVRS71', originHeightM: 120 };
    const placement = worldTilePlacement(tile, { anchor, vertical, sessionDatum: { datum: 'HVRS71', heightM: 110 } });
    assert.equal(placeWorldTilePoint({ x: 0, y: 2, z: 0 }, placement).y, 12);
    for (const sessionDatum of [null, { datum: 'HVRS71', heightM: null }, { datum: 'ellipsoid', heightM: 110 }]) {
        assert.throws(() => worldTilePlacement(tile, { anchor, vertical, sessionDatum }));
    }
});
