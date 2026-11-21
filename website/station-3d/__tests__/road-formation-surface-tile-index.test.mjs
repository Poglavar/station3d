// Verifies the bounded reverse lookup used when road graph tiles reach loaded surfaces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRoadFormationSurfaceTileIndex } from '../core/road-formation-surface-tile-index.js';

const surface = (osmId, highwayType = 'primary', tags = {}) => ({
    properties: {
        osm_id: osmId,
        highway_type: highwayType,
        tags,
    },
    geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    },
});

const sorted = values => Array.from(values).sort();

test('indexes only engineered road surfaces by normalized OSM id', () => {
    const index = createRoadFormationSurfaceTileIndex();
    index.setTile('surface-a', [
        surface(12),
        surface(13, 'footway'),
        surface(14, 'service', { service: 'parking_aisle' }),
        surface(null),
    ]);

    assert.deepEqual(sorted(index.tileKeysForOsmIds(['12'])), ['surface-a']);
    assert.deepEqual(sorted(index.tileKeysForOsmIds([13, 14])), []);
});

test('replacing and evicting a tile removes its stale reverse-index entries', () => {
    const index = createRoadFormationSurfaceTileIndex();
    index.setTile('surface-a', [surface(1), surface(2)]);
    index.setTile('surface-a', [surface(2), surface(3)]);

    assert.deepEqual(sorted(index.tileKeysForOsmIds([1])), []);
    assert.deepEqual(sorted(index.tileKeysForOsmIds([2, 3])), ['surface-a']);

    index.removeTile('surface-a');
    assert.deepEqual(sorted(index.tileKeysForOsmIds([2, 3])), []);
});

test('an overlapping surface survives until its final contributing tile evicts', () => {
    const index = createRoadFormationSurfaceTileIndex();
    index.setTile('surface-a', [surface(7)]);
    index.setTile('surface-b', [surface(7), surface(8)]);

    assert.deepEqual(
        sorted(index.tileKeysForOsmIds([7])),
        ['surface-a', 'surface-b'],
    );
    index.removeTile('surface-a');
    assert.deepEqual(sorted(index.tileKeysForOsmIds([7])), ['surface-b']);
});

test('accepts precomputed engineered ids from resumable tile registration', () => {
    const index = createRoadFormationSurfaceTileIndex();
    index.setTileOsmIds('surface-a', new Set([7, '8', null]));

    assert.deepEqual(sorted(index.tileKeysForOsmIds([7, 8])), ['surface-a']);
});

test('road graph delivery uses the reverse index instead of scanning loaded surfaces', () => {
    const source = readFileSync(new URL('../world/roads.js', import.meta.url), 'utf8');
    const start = source.indexOf("label: 'road-formations'");
    const end = source.indexOf('centerlineSource.ensureAround(0, 0)', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const delivery = source.slice(start, end);

    assert.match(source, /roadFormationSurfaceTiles\.setTileOsmIds\(tileKey,\s*result\.engineeredOsmIds\)/);
    assert.match(source, /roadFormationSurfaceTiles\.removeTile\(tileKey\)/);
    assert.match(delivery, /roadFormationSurfaceTiles[\s\S]*\.tileKeysForOsmIds\(/);
    assert.match(
        delivery,
        /enqueueTileRoads\(surfaceTileKey,\s*surfaces\)\.catch\(/,
        'surface build failures remain attributed without retaining graph delivery',
    );
    assert.doesNotMatch(delivery, /return Promise\.all\(/);
    assert.doesNotMatch(
        delivery,
        /for \(const \[surfaceTileKey,\s*surfaces\] of tileFeatures\.entries\(\)\)/,
    );
});
