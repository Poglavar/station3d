// Verifies canonical road/building identities cannot collide across sources.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildingKey,
    entityKeyForFeature,
    isEntityKey,
    osmElementKey,
    osmWayKey,
    parseEntityKey,
    sourceEntityKey,
} from '../core/entity-key.js';

test('serializes and parses source-explicit entity key forms', () => {
    assert.equal(osmWayKey(123), 'osm:way:123');
    assert.equal(osmElementKey('node', 55), 'osm:node:55');
    assert.equal(buildingKey('gdi', 123), 'gdi:building:123');
    assert.equal(buildingKey('overture', 123), 'overture:building:123');
    assert.equal(sourceEntityKey('overture', 'water', 'lake-7'), 'overture:water:lake-7');
    assert.equal(sourceEntityKey('osm-snapshot', 'tree', 'abc'), 'osm-snapshot:tree:abc');
    assert.deepEqual(parseEntityKey('overture:building:abc-7'), {
        key: 'overture:building:abc-7',
        source: 'overture',
        type: 'building',
        id: 'abc-7',
    });
});

test('rejects malformed or source-ambiguous identities', () => {
    for (const value of [null, '', 'osm:123', 'osm:way:', 'gdi:building:', 'bad source:tree:7']) {
        assert.equal(isEntityKey(value), false);
    }
    assert.equal(osmElementKey('way', -1), null);
    assert.equal(osmElementKey('polygon', 7), null);
});

test('derives keys from API features without claiming GDI is OSM', () => {
    assert.equal(entityKeyForFeature({
        properties: { osm_id: 44, osm_type: 'way' },
    }, 'road'), 'osm:way:44');
    assert.equal(entityKeyForFeature({
        properties: { source: 'gdi', object_id: 44, osm_id: 'w999' },
    }, 'building'), 'gdi:building:44');
});
