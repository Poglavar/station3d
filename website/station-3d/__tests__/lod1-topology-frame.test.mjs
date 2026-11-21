// Real near-collinear footprint: roof topology must not depend on the session projection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLod1BuildingPrisms } from '../core/lod1-prism-geometry.js';
import { buildBuildingPrisms } from '../world/lod1-geometry.js';
import { compileFarBuildingRenderPacket } from '../core/compilers/far-building-render-packet.js';
import { geoToLocal } from '../core/math.js';

const geometry = { type: 'Polygon', coordinates: [[
    [15.96554, 45.810566], [15.965556, 45.810694], [15.96576, 45.810681],
    [15.965752, 45.810617], [15.965744, 45.810553], [15.96554, 45.810566],
]] };

test('one footprint has identical roof triangles under local, distant and tile anchors', () => {
    const reference = compileLod1BuildingPrisms(geometry, 11.02, 15.963134765625, 45.81348649679972);
    for (const [lon, lat] of [[15.963134765625, 45.8], [15.9706, 45.8104], [16.05, 46.15], [18, 44]]) {
        const actual = compileLod1BuildingPrisms(geometry, 11.02, lon, lat);
        assert.deepEqual(actual.indices, reference.indices);
        assert.deepEqual(buildBuildingPrisms(geometry, 11.02, lon, lat), actual);
    }
});

test('far packets localize before Float32 conversion, including distant session anchors', () => {
    const anchor = { lon: 16.05, lat: 46.15 };
    const tile = { matrix: 'EPSG:3857', z: 15, x: 17837, y: 11682, originLon: 15.963134765625, originLat: 45.81348649679972 };
    const origin = geoToLocal(15.963134765625, 45.81348649679972, anchor.lon, anchor.lat);
    const packet = compileFarBuildingRenderPacket({ tile, generation: 0, sourceRevision: 'fixture', inputs: {
        anchorLon: anchor.lon, anchorLat: anchor.lat, tileOriginX: origin.x, tileOriginZ: origin.z,
        features: [{ entityId: 'gdi:60185', objectId: '60185', geometry, heightM: 11.02, baseY: 0 }],
    } });
    const positions = packet.primitives[0].positions;
    for (const point of geometry.coordinates[0].slice(0, -1)) {
        const expected = geoToLocal(point[0], point[1], anchor.lon, anchor.lat);
        let distance = Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            distance = Math.min(distance, Math.hypot(positions[i] - (expected.x - origin.x), positions[i+2] - (expected.z - origin.z)));
        }
        assert.ok(distance < 0.00003, `Lost tile-local precision: ${distance} m`);
    }
});
