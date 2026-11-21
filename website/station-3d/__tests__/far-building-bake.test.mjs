// Bakes complete canonical inputs without freezing runtime terrain, proposal or LOD policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFarBuildingBake, bakedFarEntityPlacement } from '../core/compilers/far-building-bake.js';
import { compileFarBuildingRenderPacket } from '../core/compilers/far-building-render-packet.js';
import { worldTileAt, worldTileFrame, worldTileBounds } from '../core/world-tile-placement.js';
import { farBuildingColorForUseClass } from '../core/building-use-colors.js';
import { pickFarHeightForFeature } from '../world/lod1-geometry.js';
import { encodeBakedWorldTile } from '../core/baked-world-tile.js';

const tile = worldTileFrame(worldTileAt(15.97, 45.81, 15));
function snapshot(count = 1) {
    const b = worldTileBounds(tile);
    const payload = { contract: 'station3d-source-v1', schemaVersion: 1, layer: 'far-buildings',
        queryVersion: 'building-render-rows-v2', bounds: [b.west, b.south, b.east, b.north],
        simplification: { engine:'GEOS',version:'3.14.1',operation:'simplifyTP',toleranceM:1,inputSrid:3765,repeatedRuns:2,
            validation:'same-engine-input-selected-and-delivered-geojson',policy:'valid-render-footprint-v2',
            serialization:'geojson-6-or-15-valid-topology',cleanup:'invalid-delivered-interior-rings-only',
            maxRemovedRingAreaM2:1e-9,maxRemovedRingWidthM:1e-8 },
        tiles: [{ key: `${tile.z}/${tile.x}/${tile.y}`, bounds: [b.west, b.south, b.east, b.north] }],
        features: Array.from({ length: count }, (_, i) => ({ type: 'Feature',
            properties: { footprint_source: 'gdi', footprint_id: String(i), object_id: String(i), eave_height_m: 12, ground_z_m: null, use_class: 'D5- Školska' },
            tileKeys: [`${tile.z}/${tile.x}/${tile.y}`],
            provenance: [{ renderId: String(i), heightSource: 'gdi_survey' }],
            geometry: { type: 'Polygon', coordinates: [[[15.97, 45.81], [15.9701, 45.81], [15.9701, 45.8101], [15.97, 45.8101], [15.97, 45.81]]] },
        })) };
    return { payload, sourceRevision: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
const options = { tile, revision: 'pilot-test-v1' };

test('bake is deterministic and preserves all footprints above the runtime horizon cap', () => {
    const source = snapshot(605);
    const baked = compileFarBuildingBake(source, options);
    assert.equal(baked.entities.length, 605);
    assert.equal(baked.packet.primitives.length, 605);
    assert.equal(baked.packet.generation, 0);
    assert.equal(baked.entities[0].feature.properties.ground_z_m, null);
    assert.deepEqual(baked.entities[0].feature.provenance, [{ renderId: '0', heightSource: 'gdi_survey' }]);
    assert.equal(baked.packet.primitives[0].bounds.minY, 0);
    assert.equal(baked.packet.primitives[0].bounds.maxY, 12);
    assert.equal(baked.packet.primitives[0].entityRanges[0].metadata.nearKey, null);
    assert.equal(baked.packet.primitives[0].entityRanges[0].metadata.color, 0x7596cb);
    assert.deepEqual(new Uint8Array(encodeBakedWorldTile(baked)), new Uint8Array(encodeBakedWorldTile(compileFarBuildingBake(source, options))));
});

test('bake uses exactly the existing pure Worker compiler', () => {
    const baked = compileFarBuildingBake(snapshot(), options);
    const entity = baked.entities[0], feature = entity.feature;
    const direct = compileFarBuildingRenderPacket({
        tile, generation: 0, sourceRevision: baked.sourceRevision,
        inputs: { anchorLon: tile.originLon, anchorLat: tile.originLat, tileOriginX: 0, tileOriginZ: 0,
            features: [{ entityId: entity.entityId, objectId: entity.objectId, geometry: feature.geometry,
                heightM: pickFarHeightForFeature(feature.properties, feature.geometry, tile.originLat), baseY: 0,
                color: farBuildingColorForUseClass(feature.properties.use_class) }] },
    });
    assert.deepEqual(baked.packet, direct);
});

test('source snapshot freezes the geographic origin across JavaScript runtimes', () => {
    const source = snapshot();
    // Math.atan/sinh may differ by one double ULP between Node and Chrome.
    // The already-validated snapshot frame, not another inverse projection,
    // must remain the exact origin used to generate and later compare vertices.
    source.payload.tiles[0].bounds[3] += Number.EPSILON * 32;
    const baked = compileFarBuildingBake(source, options);
    assert.equal(baked.tile.originLat, source.payload.tiles[0].bounds[3]);
    assert.equal(baked.entities[0].heightReferenceLat, source.payload.tiles[0].bounds[3]);
});

test('terrain foundation stays live; missing evidence gates publication and estimates retain session policy', () => {
    const source = snapshot();
    source.payload.features[0].properties.footprint_source = 'overture';
    source.payload.features[0].properties.height_source = 'none';
    source.payload.features[0].properties.eave_height_m = null;
    const entity = compileFarBuildingBake(source, options).entities[0];
    for (const anchorLat of [45.8, 46.15]) {
        const value = bakedFarEntityPlacement(entity, { anchorLat, baseY: 37.5 });
        assert.equal(value.baseY, 37.5);
        assert.equal(value.heightM, pickFarHeightForFeature(entity.feature.properties, entity.feature.geometry, anchorLat));
        assert.equal(value.scaleY * entity.heightM, value.heightM);
    }
    for (const baseY of [null, undefined, NaN, '0']) assert.equal(bakedFarEntityPlacement(entity, { anchorLat: 45.8, baseY }), null);
});

test('landmark parts keep their own prism identity and explicit whole-landmark parent; non-buildings are not drawn', () => {
    const source = snapshot(2);
    const one = source.payload.features[0];
    one.properties.footprint_source = 'landmark'; one.provenance = { landmarkId: 'fixture' };
    one.geometry = { type: 'MultiPolygon', coordinates: [one.geometry.coordinates,
        one.geometry.coordinates.map(ring=>ring.map(([x,y])=>[x+0.0002,y]))] };
    source.payload.features[1].properties.use_class = 'Cesta';
    const baked = compileFarBuildingBake(source, options);
    assert.equal(baked.entities.length, 2);
    assert.equal(baked.packet.primitives.length, 1);
    assert.equal(baked.packet.primitives[0].entityRanges.length, 1);
    assert.equal(baked.entities[1].drawable, false);
    assert.equal(baked.entities[0].parentId, 'landmark:fixture');
    assert.equal(baked.entities[0].entityId, 'landmark:0');
});

test('malformed or mismatched source cannot silently produce an incomplete tile', () => {
    for (const mutate of [
        s => { s.payload.tiles[0].bounds[0] += 0.001; },
        s => { s.payload.features[0].properties.object_id = null; },
        s => { s.payload.features.push(s.payload.features[0]); },
        s => { s.payload.features[0].geometry.coordinates[0][0][0] = NaN; },
        s => { s.payload.features[0].geometry.coordinates[0].pop(); },
        s => { delete s.payload.simplification.validation; },
        s => { delete s.payload.simplification.policy; },
        s => { delete s.payload.simplification.serialization; },
        s => { s.payload.simplification.version='3.9.0'; },
    ]) { const s = snapshot(); mutate(s); assert.throws(() => compileFarBuildingBake(s, options)); }
});

test('offline CLI reads back immutable output, resumes, and rejects a corrupt source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'st3d-bake-test-'));
    const sourcePath = join(directory, 'source.json'), output = join(directory, 'tile.bin');
    const source = snapshot(); writeFileSync(sourcePath, JSON.stringify(source));
    const cli = fileURLToPath(new URL('../../../tools/bake-station3d-far.mjs', import.meta.url));
    const args = [cli, '--run', '--source', sourcePath, '--tile', `${tile.z}/${tile.x}/${tile.y}`, '--revision', options.revision, '--out', output];
    const run = () => spawnSync(process.execPath, args, { encoding: 'utf8' });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(output);
    const second = run(); assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /already complete/);
    assert.deepEqual(readFileSync(output), before);
    source.payload.features[0].properties.eave_height_m++;
    writeFileSync(sourcePath, JSON.stringify(source));
    const corrupt = run(); assert.notEqual(corrupt.status, 0); assert.match(corrupt.stderr, /checksum mismatch/);
    assert.deepEqual(readFileSync(output), before);
    delete source.payload.simplification.validation;
    source.sourceRevision=createHash('sha256').update(JSON.stringify(source.payload)).digest('hex');
    writeFileSync(sourcePath,JSON.stringify(source));
    const unvalidated=run(); assert.notEqual(unvalidated.status,0);assert.match(unvalidated.stderr,/same-engine/);
    assert.deepEqual(readFileSync(output),before);
});
