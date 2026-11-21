// Verifies every imported checker payload normalizes to stable cross-pane entities.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    alignedDecorTiles,
    dedupeEntityRecords,
    normalizeDecorPayload,
    normalizeStops,
    normalizeTrackCollection,
    normalizeWaterCollection,
    stableSnapshotId,
} from '../core/source-entity-data.js';

test('snapshot ids are deterministic and coordinate-sensitive', () => {
    assert.equal(
        stableSnapshotId(['tree', 15.98, 45.81]),
        stableSnapshotId(['tree', 15.98, 45.81]),
    );
    assert.notEqual(
        stableSnapshotId(['tree', 15.98, 45.81]),
        stableSnapshotId(['tree', 15.981, 45.81]),
    );
});

test('all compact point and line decor kinds become selectable records', () => {
    const samples = {
        trees: [[45.81, 15.98, 11]],
        hedges: [[[15.98, 45.81], [15.981, 45.811]]],
        crossings: [[45.81, 15.98, 90]],
        footpaths: [[15.98, 45.81, 15.981, 45.811, 1.2]],
        benches: [[45.81, 15.98, 180]],
        fountains: [[45.81, 15.98, 2.5]],
        traffic_lights: [[45.81, 15.98, 87]],
    };
    for (const [kind, payload] of Object.entries(samples)) {
        const records = normalizeDecorPayload(kind, payload);
        assert.equal(records.length, 1, kind);
        assert.match(records[0].key, /^osm-snapshot:/, kind);
        assert.equal(records[0].metadata.source, 'osm', kind);
        assert.equal(records[0].metadata.sourceLabel, 'OSM snimka', kind);
        assert.ok(records[0].metadata.hit, kind);
    }
});

test('a retained source OSM id replaces the snapshot fallback', () => {
    const [tree] = normalizeDecorPayload('trees', [
        [45.81, 15.98, 11, { osmType: 'node', osmId: 123 }],
    ]);
    assert.equal(tree.key, 'osm:node:123');
    assert.equal(tree.metadata.osmType, 'node');
});

test('tree visual type remains available to the inspector', () => {
    const [tree] = normalizeDecorPayload('trees', [
        [43.507224, 16.439456, null, 'n1370997552:trees', 'palm'],
    ]);
    assert.equal(tree.metadata.treeType, 'palm');
});

test('aligned greenery fragments have the same identity in both panes', () => {
    const payload = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: { t: 'park' },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [15.98, 45.81],
                    [15.981, 45.81],
                    [15.981, 45.811],
                    [15.98, 45.81],
                ]],
            },
        }],
    };
    const first = normalizeDecorPayload('greenery', payload, { tileKey: '799:2290' });
    const second = normalizeDecorPayload('greenery', payload, { tileKey: '799:2290' });
    const otherTile = normalizeDecorPayload('greenery', payload, { tileKey: '800:2290' });
    assert.equal(first[0].key, second[0].key);
    assert.notEqual(first[0].key, otherTile[0].key);
    assert.equal(first[0].metadata.surfaceType, 'park');
});

test('exact fountain surfaces remain fountains with their source OSM identity', () => {
    const [fountain] = normalizeDecorPayload('greenery', {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {
                t: 'water',
                semantic: 'fountain',
                sourceId: 'w587750378:fountain-surface',
                osm_type: 'way',
                osm_id: 587750378,
            },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [15.979163, 45.796255],
                    [15.979164, 45.796245],
                    [15.979338, 45.796249],
                    [15.979337, 45.796259],
                    [15.979163, 45.796255],
                ]],
            },
        }],
    });
    assert.equal(fountain.key, 'osm:way:587750378');
    assert.equal(fountain.metadata.entityType, 'fountain');
    assert.equal(fountain.metadata.decorKind, 'greenery');
    assert.equal(fountain.metadata.surfaceType, 'water');
    assert.equal(fountain.metadata.name, 'OSM fontana');
});

test('water, railways, and stops keep their real source identities', () => {
    const [water] = normalizeWaterCollection({
        features: [{
            properties: { id: 'water-7', subtype: 'river' },
            geometry: {
                type: 'Polygon',
                coordinates: [[[15.98, 45.81], [15.99, 45.81], [15.98, 45.81]]],
            },
        }],
    });
    const [track] = normalizeTrackCollection({
        features: [{
            properties: { osmId: 88, railway_type: 'tram' },
            geometry: {
                type: 'LineString',
                coordinates: [[15.98, 45.81], [15.99, 45.81]],
            },
        }],
    });
    const stops = normalizeStops([
        { id: 'zet-1', name: 'Test', lat: 45.81, lng: 15.98 },
        { id: 'zet-2', osmId: 99, name: 'OSM Test', lat: 45.82, lng: 15.99 },
    ]);
    assert.equal(water.key, 'overture:water:water-7');
    assert.equal(track.key, 'osm:way:88');
    assert.equal(stops[0].key, 'zet:stop:zet-1');
    assert.equal(stops[1].key, 'osm:node:99');
});

test('aligned tile coverage and deduplication are stable', () => {
    const tiles = alignedDecorTiles({
        west: 15.979,
        south: 45.819,
        east: 16.001,
        north: 45.841,
    });
    assert.deepEqual(tiles.map((tile) => tile.key), [
        '798:2290',
        '799:2290',
        '800:2290',
        '798:2291',
        '799:2291',
        '800:2291',
        '798:2292',
        '799:2292',
        '800:2292',
    ]);
    assert.equal(dedupeEntityRecords([
        { key: 'osm:node:1' },
        { key: 'osm:node:1' },
    ]).length, 1);
});
