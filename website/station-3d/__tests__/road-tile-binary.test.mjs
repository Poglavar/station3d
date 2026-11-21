// Round-trips the binary road tile format (RTL1). The encoder lives in the API
// repo, so the encoder here is a deliberate REPLICA of the documented format —
// which means these tests pin the format, not the implementation. If the two
// drift, this suite still passes and the world breaks, so the real guard is the
// parity check that fetches the same bbox both ways; this one guards the
// decoder's own behaviour and the format's edges.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeRoadTile,
    isRoadTileBinary,
    ROAD_TILE_MAGIC,
    ROAD_TILE_VERSION,
} from '../core/road-tile-binary.js';

const SCALE = 1e7;
const HEADER = 28;

// Replica of the documented format. Mirrors the API encoder deliberately: these
// tests pin the FORMAT, not one implementation of it.
function encode(features, { version = ROAD_TILE_VERSION, magic = ROAD_TILE_MAGIC } = {}) {
    const types = [], polysPer = [], ringsPer = [], rings = [];
    for (const f of features) {
        const g = f.geometry;
        const t = !g ? 0 : g.type === 'Polygon' ? 1 : g.type === 'MultiPolygon' ? 2 : 0;
        const polys = t === 1 ? [g.coordinates] : t === 2 ? g.coordinates : [];
        types.push(t);
        polysPer.push(polys.length);
        for (const poly of polys) { ringsPer.push(poly.length); for (const r of poly) rings.push(r); }
    }
    const points = rings.reduce((n, r) => n + r.length, 0);
    const props = new TextEncoder().encode(JSON.stringify(features.map((f) => f.properties ?? {})));
    const bytes = HEADER + types.length * 8 + ringsPer.length * 4 + rings.length * 4
        + points * 8 + props.length;
    const buf = new ArrayBuffer(bytes);
    const view = new DataView(buf);
    view.setUint32(0, magic, true);
    view.setUint32(4, version, true);
    view.setUint32(8, features.length, true);
    view.setUint32(12, ringsPer.length, true);
    view.setUint32(16, rings.length, true);
    view.setUint32(20, points, true);
    view.setUint32(24, props.length, true);
    let o = HEADER;
    for (const t of types) { view.setUint32(o, t, true); o += 4; }
    for (const n of polysPer) { view.setUint32(o, n, true); o += 4; }
    for (const n of ringsPer) { view.setUint32(o, n, true); o += 4; }
    for (const r of rings) { view.setUint32(o, r.length, true); o += 4; }
    for (const r of rings) {
        for (const p of r) {
            view.setInt32(o, Math.round(p[0] * SCALE), true);
            view.setInt32(o + 4, Math.round(p[1] * SCALE), true);
            o += 8;
        }
    }
    new Uint8Array(buf).set(props, o);
    return buf;
}

const poly = (coords, properties = {}) => ({
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties,
});

test('a tile round-trips to the same shape GeoJSON would have given', () => {
    const src = [
        poly([[15.9887333, 45.7921841], [15.9887304, 45.7921848], [15.9887278, 45.7921859]],
            { osm_id: 42, highway_type: 'residential' }),
        poly([[15.99, 45.79], [15.9901, 45.7901], [15.9902, 45.7902], [15.99, 45.79]],
            { osm_id: 43, width_meters: 6.5 }),
    ];
    const out = decodeRoadTile(encode(src));
    assert.equal(out.type, 'FeatureCollection');
    assert.equal(out.features.length, 2);
    assert.equal(out.features[0].geometry.type, 'Polygon');
    assert.deepEqual(out.features[0].properties, { osm_id: 42, highway_type: 'residential' });
    assert.equal(out.features[1].properties.width_meters, 6.5);
});

test('coordinates survive to within a centimetre', () => {
    // 1e-7 degrees is ~1.1 cm of latitude. A road edge does not care; a
    // coordinate that moved a metre would show as a visible seam.
    const src = [poly([[15.9887333, 45.7921841], [16.1234567, 45.8765432]])];
    const out = decodeRoadTile(encode(src)).features[0].geometry.coordinates[0];
    for (const [i, [lon, lat]] of out.entries()) {
        assert.ok(Math.abs(lon - src[0].geometry.coordinates[0][i][0]) < 1e-7, `lon ${i}`);
        assert.ok(Math.abs(lat - src[0].geometry.coordinates[0][i][1]) < 1e-7, `lat ${i}`);
    }
});

test('negative and zero coordinates are not mangled', () => {
    // int32 is signed; a truncating encoder or an unsigned read breaks the
    // western hemisphere and the equator specifically.
    const src = [poly([[-15.5, -45.5], [0, 0], [-0.0000001, 0.0000001]])];
    const out = decodeRoadTile(encode(src)).features[0].geometry.coordinates[0];
    assert.ok(Math.abs(out[0][0] + 15.5) < 1e-7);
    assert.ok(Math.abs(out[0][1] + 45.5) < 1e-7);
    assert.deepEqual(out[1], [0, 0]);
});

test('multi-ring features keep their rings in order', () => {
    const f = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [
            [[15.9, 45.7], [15.91, 45.7], [15.91, 45.71]],
            [[15.905, 45.705], [15.906, 45.705]],
        ] },
        properties: {},
    };
    const out = decodeRoadTile(encode([f])).features[0].geometry.coordinates;
    assert.equal(out.length, 2);
    assert.equal(out[0].length, 3);
    assert.equal(out[1].length, 2);
});

test('a feature with no rings decodes to a NULL geometry, not an empty polygon', () => {
    // The road builder checks for a missing geometry and skips. An empty
    // coordinate list would reach the triangulator instead.
    const src = [{ type: 'Feature', geometry: null, properties: { osm_id: 7 } }];
    const out = decodeRoadTile(encode(src)).features[0];
    assert.equal(out.geometry, null);
    assert.equal(out.properties.osm_id, 7);
});

test('an empty tile is valid', () => {
    const out = decodeRoadTile(encode([]));
    assert.deepEqual(out.features, []);
});

test('a wrong version is refused rather than decoded as garbage', () => {
    // Decoding a future format to plausible-looking coordinates would draw a
    // wrong city rather than fail — far worse than an error.
    assert.throws(() => decodeRoadTile(encode([poly([[15.9, 45.7]])], { version: 2 })),
        /version 2 is not supported/);
});

test('a non-road buffer is refused', () => {
    assert.throws(() => decodeRoadTile(encode([poly([[15.9, 45.7]])], { magic: 0xdeadbeef })),
        /not a road tile/);
    assert.throws(() => decodeRoadTile(new ArrayBuffer(4)), /too small/);
    assert.throws(() => decodeRoadTile(null), /too small/);
});

test('a truncated buffer is refused rather than read past its end', () => {
    const full = encode([poly([[15.9, 45.7], [15.91, 45.71], [15.92, 45.72]])]);
    assert.throws(() => decodeRoadTile(full.slice(0, full.byteLength - 8)),
        /header describes/);
});

test('isRoadTileBinary sniffs without throwing', () => {
    assert.equal(isRoadTileBinary(encode([])), true);
    assert.equal(isRoadTileBinary(new ArrayBuffer(4)), false);
    assert.equal(isRoadTileBinary(null), false);
    // A JSON body must never sniff as binary — that is the fallback path.
    const json = new TextEncoder().encode('{"type":"FeatureCollection"}').buffer;
    assert.equal(isRoadTileBinary(json), false);
});

test('a MultiPolygon keeps every polygon, not just the first', () => {
    // The bug the parity check caught. Flattened into one Polygon, the road
    // builder reads coordinates[0] and every other polygon disappears — four
    // roads per real tile, silently, with no error anywhere.
    const f = {
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: [
            [[[15.90, 45.70], [15.91, 45.70], [15.91, 45.71]]],
            [[[15.95, 45.75], [15.96, 45.75], [15.96, 45.76], [15.95, 45.76]]],
        ] },
        properties: { osm_id: 99 },
    };
    const out = decodeRoadTile(encode([f])).features[0];
    assert.equal(out.geometry.type, 'MultiPolygon', 'the type must survive, not be inferred');
    assert.equal(out.geometry.coordinates.length, 2, 'both polygons present');
    assert.equal(out.geometry.coordinates[1][0].length, 4, 'second polygon keeps its points');
});

test('a Polygon does not become a MultiPolygon', () => {
    // The reverse confusion is just as bad: the builder branches on the type.
    const out = decodeRoadTile(encode([poly([[15.9, 45.7], [15.91, 45.7], [15.91, 45.71]])]));
    assert.equal(out.features[0].geometry.type, 'Polygon');
});
