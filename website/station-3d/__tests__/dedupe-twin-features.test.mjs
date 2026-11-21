// Twin-dedupe must collapse GDI double entry and must NEVER touch the parts of
// a hand-modelled building. Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeTwinFeatures } from '../core/dedupe-twin-features.js';

// A square ring at (lon, lat) of the given side, all vertices at height z.
function ringFeature({ id, lon = 15.9634, lat = 45.8030, side = 0.0002, z = 186, faces = 40, material = null }) {
    const coordinates = [];
    for (let i = 0; i < faces; i++) {
        const t = i / faces;
        coordinates.push([[
            [lon + t * side, lat, z],
            [lon + t * side, lat + side, z],
            [lon + t * side, lat + side, z - 4],
            [lon + t * side, lat, z - 4],
        ]]);
    }
    return {
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates },
        properties: { object_id: id, ...(material ? { material } : {}) },
    };
}

test('GDI double entry still collapses to the smallest object_id', () => {
    // The rule this function exists for: one physical building under two ids.
    // Both drawn stacks every wall twice and the plaster z-fights as mottling.
    const a = ringFeature({ id: 61639 });
    const b = ringFeature({ id: 61706 });
    const out = dedupeTwinFeatures([b, a]);
    assert.equal(out.length, 1);
    assert.equal(out[0].properties.object_id, 61639, 'the smaller id survives');
});

test('complementary triangles with equal bounds are not twins', () => {
    const feature = (id, ring) => ({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: [[[...ring, ring[0]]]] },
        properties: { object_id: id },
    });
    const bottomLeft = [15.9699, 45.8099, 100];
    const topLeft = [15.9699, 45.8099, 112];
    const topRight = [15.9699, 45.8102, 112];
    const bottomRight = [15.9699, 45.8102, 100];
    const a = feature(101, [bottomLeft, topLeft, topRight]);
    const b = feature(102, [bottomLeft, topRight, bottomRight]);

    assert.deepEqual(dedupeTwinFeatures([a, b]), [a, b]);
});

test('a modelled landmark keeps every co-located part', () => {
    // Cibona: concrete parapet, LED strips and glass all wrap the SAME cylinder
    // at the same height with the same vertex count. Geometrically they are
    // indistinguishable from double entry — which is exactly why the crown
    // lighting silently vanished: the edgeLight part was eaten as a twin of the
    // concrete one, and 8 of 9 parts arriving looked like a complete tower.
    const parts = [
        ringFeature({ id: 441, z: 186.3, material: { kind: 'concrete', color: '3a3d42' } }),
        ringFeature({ id: 448, z: 185.9, material: { kind: 'edgeLight', color: '2a2d33', emissive: 'fff4e2' } }),
        ringFeature({ id: 442, z: 186.1, material: { kind: 'glass', color: '859ab2' } }),
    ];
    const out = dedupeTwinFeatures(parts);
    assert.equal(out.length, 3, 'no part of a modelled building may be dropped');
    assert.deepEqual(out.map((f) => f.properties.object_id).sort(), [441, 442, 448]);
});

test('a stated part is not eaten by a survey twin either', () => {
    // Mixed tile: the survey shell and the landmark occupy the same footprint
    // during the window before the server-side suppression is rebuilt. The
    // landmark must survive whichever order they arrive in, and whichever id
    // happens to be smaller.
    const survey = ringFeature({ id: 3, z: 186 });
    const landmark = ringFeature({ id: 900, z: 186, material: { kind: 'glass', color: 'aabbcc' } });
    for (const order of [[survey, landmark], [landmark, survey]]) {
        const out = dedupeTwinFeatures(order);
        assert.ok(out.includes(landmark), 'the stated part must survive');
        assert.equal(out.length, 2);
    }
});

test('the drop callback reports only real drops', () => {
    let dropped = 0;
    const onDropped = (n) => { dropped += n; };
    dedupeTwinFeatures([ringFeature({ id: 1 }), ringFeature({ id: 2 })], onDropped);
    assert.equal(dropped, 1);

    dropped = 0;
    dedupeTwinFeatures([
        ringFeature({ id: 1, material: { kind: 'glass' } }),
        ringFeature({ id: 2, material: { kind: 'edgeLight' } }),
    ], onDropped);
    assert.equal(dropped, 0, 'a silent drop is how this bug hid — report nothing when nothing went');
});
