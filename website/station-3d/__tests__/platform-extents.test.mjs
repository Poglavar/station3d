// Verifies geographic heavy-rail platform records resolve to bounded, true
// local footprints for the shared platform renderer.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePrimaryPlatformExtent } from '../core/platform-extents.js';

test('authored platform endpoints produce their true local length, width, and centre', () => {
    const extent = resolvePrimaryPlatformExtent({
        lat: 45.80444,
        lng: 15.97883,
        platformExtents: [{
            id: 'zagreb-platform',
            start: { lat: 45.804395, lon: 15.97748 },
            end: { lat: 45.804485, lon: 15.97976 },
            widthM: 8.5,
        }],
    }, { anchorLat: 45.80444, anchorLon: 15.97883 });

    assert.equal(extent.id, 'zagreb-platform');
    assert.equal(extent.widthM, 8.5);
    assert.ok(extent.lengthM > 175 && extent.lengthM < 185);
    assert.ok(Math.abs(extent.centerX) < 20);
    assert.ok(Math.abs(extent.centerZ) < 2);
});

test('invalid authored extents fall back to the ordinary platform renderer', () => {
    assert.equal(resolvePrimaryPlatformExtent({
        lat: 45,
        lng: 16,
        platformExtents: [{ start: { lat: 45 }, end: { lat: 45, lon: 16 } }],
    }, { anchorLat: 45, anchorLon: 16 }), null);
});
