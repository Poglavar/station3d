// Every Station3D consumer must identify the detailed building response with
// the same key, including Zagreb's server-side Overture coverage fill.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildingTileSourceForLocation } from '../core/locations.js';

test('Zagreb GDI consumers share the filled detailed-building response', () => {
    assert.deepEqual(buildingTileSourceForLocation({ buildings: 'gdi' }), {
        endpoint: 'buildings-3d',
        key: 'buildings:buildings-3d&fill=overture',
        querySuffix: '&fill=overture',
    });
});

test('non-GDI sources keep their plain endpoint and key', () => {
    assert.deepEqual(buildingTileSourceForLocation({ buildings: 'overture' }), {
        endpoint: 'buildings-overture',
        key: 'buildings:buildings-overture',
        querySuffix: '',
    });
    assert.deepEqual(buildingTileSourceForLocation({ buildings: 'bus' }), {
        endpoint: 'buildings-bus',
        key: 'buildings:buildings-bus',
        querySuffix: '',
    });
});
