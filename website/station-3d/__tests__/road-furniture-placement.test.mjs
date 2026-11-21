import test from 'node:test';
import assert from 'node:assert/strict';
import { roadFurnitureBlockedByOverpass } from '../core/road-furniture-placement.js';

test('removes lower-road furniture beneath an overpass but keeps bridge furniture', () => {
    const overpass = {
        kind: 'overpass',
        osmIds: [52916558],
    };

    assert.equal(roadFurnitureBlockedByOverpass(overpass, 35073054), true);
    assert.equal(roadFurnitureBlockedByOverpass(overpass, null), true);
    assert.equal(roadFurnitureBlockedByOverpass(overpass, 52916558), false);
});

test('ordinary roads and underpasses do not suppress their furniture', () => {
    assert.equal(roadFurnitureBlockedByOverpass(null, 1), false);
    assert.equal(roadFurnitureBlockedByOverpass({ kind: 'underpass', osmIds: [1] }, 2), false);
});
