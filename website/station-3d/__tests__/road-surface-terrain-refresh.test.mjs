// Locks the bounded terrain-revision replay set for already-published road and path meshes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    terrainRevisionRoadOsmIds,
} from '../core/road-surface-terrain-refresh.js';

function feature(osmId, highwayType, tags = {}, railwayType = null) {
    return {
        properties: {
            osm_id: osmId,
            highway_type: highwayType,
            railway_type: railwayType,
            tags,
        },
    };
}

test('ordinary Botanički vrt footways replay when supplied terrain changes', () => {
    const ids = terrainRevisionRoadOsmIds([
        feature(688625965, 'footway', {
            highway: 'footway',
            surface: 'fine_gravel',
        }),
    ]);

    assert.deepEqual([...ids], ['688625965']);
});

test('terrain replay stays bounded to rendered unengineered and unaligned surfaces', () => {
    const ids = terrainRevisionRoadOsmIds([
        feature(1, 'service', { highway: 'service' }),
        feature(2, 'service', { highway: 'service', service: 'parking_aisle' }),
        feature(3, 'footway', { highway: 'footway' }),
        feature(4, null, { railway: 'rail' }, 'rail'),
        feature(5, null, { railway: 'tram' }, 'tram'),
        feature(6, 'footway', { highway: 'footway', footway: 'sidewalk' }),
        feature(6, 'footway', { highway: 'footway', footway: 'sidewalk' }),
        feature(null, 'path', { highway: 'path' }),
    ], {
        hasVerticalAlignmentForOsmId: osmId => String(osmId) === '3',
    });

    assert.deepEqual([...ids], ['2', '6']);
});

test('an aligned tunnel path is re-judged against the ground on every terrain revision', () => {
    const ids = terrainRevisionRoadOsmIds([
        // the Tomićeva passage under the funicular viaduct: solved, but its floor is
        // judged against the rendered terrain, which the LiDAR detail lowers later
        feature(482988746, 'footway', { highway: 'footway', tunnel: 'yes', layer: '-1' }),
        // an aligned footbridge keeps its alignment heights and is not replayed
        feature(7, 'footway', { highway: 'footway', bridge: 'yes', layer: '1' }),
        // an aligned carriageway tunnel is the solver's business, not the terrain's
        feature(8, 'primary', { highway: 'primary', tunnel: 'yes', layer: '-1' }),
    ], {
        hasVerticalAlignmentForOsmId: () => true,
    });

    assert.deepEqual([...ids], ['482988746']);
});
