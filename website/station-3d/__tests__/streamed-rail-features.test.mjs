import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    mergeStreamedRailFeatureTiles,
    railFeatureFromRoadSurface,
    railFeaturesFromRoadSurfaces,
    streamedRailFeatureSetSignature,
} from '../core/streamed-rail-features.js';

function surface(osmId, railwayType = 'tram', coordinates = [[15.98, 45.81], [15.99, 45.81]]) {
    return {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[[15.98, 45.80], [15.99, 45.80], [15.98, 45.80]]],
        },
        properties: {
            osm_id: osmId,
            railway_type: railwayType,
            tags: { railway: railwayType, gauge: railwayType === 'tram' ? '1000' : '1435' },
            centerline_geometry: { type: 'LineString', coordinates },
        },
    };
}

test('turns the railway payload in a road surface tile back into its source LineString', () => {
    const feature = railFeatureFromRoadSurface(surface(142195308));
    assert.equal(feature.geometry.type, 'LineString');
    assert.deepEqual(feature.geometry.coordinates, [[15.98, 45.81], [15.99, 45.81]]);
    assert.equal(feature.properties.osm_id, 142195308);
    assert.equal(feature.properties.osmId, 142195308);
    assert.equal(feature.properties.railway_type, 'tram');
    assert.equal(feature.properties.tags.gauge, '1000');
    assert.equal(feature.properties.centerline_geometry, undefined);
});

test('rejects ordinary roads and railway surfaces without a source centreline', () => {
    const road = surface(1, 'tram');
    road.properties.railway_type = null;
    road.properties.tags = { highway: 'secondary' };
    assert.equal(railFeatureFromRoadSurface(road), null);

    const missing = surface(2, 'tram');
    delete missing.properties.centerline_geometry;
    assert.equal(railFeatureFromRoadSurface(missing), null);
});

test('keeps every imported renderable railway class and excludes unsupported classes', () => {
    const input = [
        surface(1, 'tram'),
        surface(2, 'rail'),
        surface(3, 'light_rail'),
        surface(4, 'narrow_gauge'),
        surface(5, 'subway'),
    ];
    assert.deepEqual(
        railFeaturesFromRoadSurfaces(input).map(feature => feature.properties.railway_type),
        ['tram', 'rail', 'light_rail', 'narrow_gauge'],
    );
});

test('deduplicates a long OSM way repeated by adjacent road tiles', () => {
    const first = railFeatureFromRoadSurface(surface(142195308));
    const duplicate = railFeatureFromRoadSurface(surface(142195308));
    const second = railFeatureFromRoadSurface(surface(196119369));
    const tiles = new Map([
        ['0_0', [first, second]],
        ['1_0', [duplicate]],
    ]);

    const merged = mergeStreamedRailFeatureTiles(tiles);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map(feature => feature.properties.osm_id), [142195308, 196119369]);
    assert.equal(
        streamedRailFeatureSetSignature(merged),
        'osm:142195308|osm:196119369',
    );
});

test('feature signatures are stable across tile order and change on final eviction', () => {
    const first = railFeatureFromRoadSurface(surface(10));
    const second = railFeatureFromRoadSurface(surface(20));
    assert.equal(
        streamedRailFeatureSetSignature([first, second]),
        streamedRailFeatureSetSignature([second, first, first]),
    );
    assert.notEqual(
        streamedRailFeatureSetSignature([first, second]),
        streamedRailFeatureSetSignature([first]),
    );
});

test('profile-clipped fragments of one OSM way retain distinct identities', () => {
    const first = railFeatureFromRoadSurface(surface(10));
    const second = structuredClone(first);
    first.properties.railProfileFragment = 'osm:10:0';
    second.properties.railProfileFragment = 'osm:10:1';
    assert.notEqual(
        streamedRailFeatureSetSignature([first]),
        streamedRailFeatureSetSignature([second]),
    );
});

test('GTA rails subscribe to the shared binary road source instead of a Zagreb-only asset', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    assert.match(
        source,
        /sessionCapabilityEnabled\([\s\S]{0,160}SESSION_CAPABILITY\.CROATIA_RAIL_STREAMING/,
    );
    assert.match(source, /key:\s*'roads:cab'/);
    assert.match(source, /decodeBody:\s*decodeRoadTile/);
    assert.match(source, /railFeaturesFromRoadSurfaces\(features \|\| \[\]\)/);
    assert.match(source, /replaceStreamedRailFeatures\(x, z\)/);
    assert.match(source, /getDebugCounts\?\.\(\)\.pending|sourceCounts\.pending/);
    assert.match(source, /hasRenderedFeatures:\s*streamedRailHasAppliedSet/);
    assert.match(source, /initialPreviewReady:\s*changedNearObserver\s*&&\s*observerTileDelivered/);
    assert.match(source, /observerMovedEnough/);
    assert.match(source, /resolveRailProfileFeaturesSteps\(\{/);
    assert.match(source, /resolveStreamedRailSessionFeaturesSteps\(\{[\s\S]*?suppliedFeatures:\s*streamedRailBaseFeatures[\s\S]*?streamedOsmFeatures:\s*smoothedStreamed/,
        'tile refreshes must compose streamed OSM with persistent authored session tracks');
    assert.match(source, /resolveStreamedRailSessionFeatures\(\{[\s\S]*?suppliedFeatures:\s*suppliedTracks[\s\S]*?streamedOsmFeatures:\s*\[\]/,
        'session start must retain authored tracks before the first OSM tile arrives');
    assert.match(source, /baseSceneYAtLocal:\s*\(x, z\) => terrain\.evidenceSceneYAtLocal\(x, z\)/,
        'moving-window fallback ground must not steer a long rail way toward sea level');
    // Streamed and terrain refreshes both preserve their prior complete
    // generation while the same model advances cooperatively, so one
    // national-scale formation cannot own a frame.
    assert.match(source,
        /function replaceStreamedRailFeatures[\s\S]*createPendingRailFormationBuild\(features, \{[\s\S]*?fullRefresh: false[\s\S]*?changeBounds: \[\],[\s\S]*?reason: 'streamed'/);
    assert.match(source, /reason:\s*'streamed'/);
    assert.match(source, /streamedInputRevision/);
    assert.match(source,
        /if \(terrainRevisionDirty\) \{[\s\S]*createPendingRailFormationBuild\(lastFeatures, \{[\s\S]*?fullRefresh,[\s\S]*?changeBounds/);
    assert.match(source,
        /if \(pendingRailFormationBuild\) \{[\s\S]{0,3200}if \(!stepPendingRailFormationModel\(\)\) return;/);
    assert.match(source, /function stepPendingRailFormationModel\(\)[\s\S]*?stepPendingBuild\?\.\(\)/);
    assert.doesNotMatch(source, /zagreb_tram_tracks_osm\.geojson/);
});
