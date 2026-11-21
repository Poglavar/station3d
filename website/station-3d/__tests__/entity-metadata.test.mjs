// Verifies renderer meshes receive complete, source-safe road/building metadata.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildingEntityMetadata,
    roadEntityMetadata,
    stampEntityTree,
} from '../core/entity-metadata.js';

test('road metadata retains complete OSM tags', () => {
    const metadata = roadEntityMetadata({
        properties: {
            osm_id: 77,
            highway_type: 'residential',
            tags: { name: 'Test street', surface: 'asphalt', lanes: '2' },
        },
    });
    assert.equal(metadata.key, 'osm:way:77');
    assert.equal(metadata.tags.surface, 'asphalt');
    assert.equal(metadata.name, 'Test street');
});

test('GDI and Overture object ids stay in disjoint canonical spaces', () => {
    const gdi = buildingEntityMetadata({ properties: { object_id: 5, source: 'gdi' } });
    const overture = buildingEntityMetadata({
        properties: { object_id: 5, source: 'overture', osm_id: 'w11' },
    });
    assert.equal(gdi.key, 'gdi:building:5');
    assert.equal(overture.key, 'overture:building:5');
    assert.equal(overture.osmId, 'w11');
});

test('metadata propagation reaches every selectable mesh in a building tree', () => {
    const wall = { isMesh: true, userData: {} };
    const roof = { isMesh: true, userData: {} };
    const root = {
        traverse(visitor) {
            visitor(this);
            visitor(wall);
            visitor(roof);
        },
    };
    const metadata = buildingEntityMetadata({
        properties: { object_id: 9, source: 'gdi', use_class: 'School' },
    });
    assert.equal(stampEntityTree(root, metadata).length, 2);
    assert.equal(wall.userData.entityKey, 'gdi:building:9');
    assert.equal(wall.userData.objectId, 9);
    assert.equal(roof.userData.entityMetadata.useClass, 'School');
});
