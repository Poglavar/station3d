// A road dropped by the proposal footprint mask must not keep terrain ownership
// in the shared road formation: its cut had no receiver and failed the whole
// ground generation, taking the rail tunnel structures down with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadFormationModel } from '../core/road-formation.js';
import { roadFormationSurfaceFeatures } from '../core/road-formation-surface-sources.js';
import { DEG_TO_RAD, EARTH_RADIUS_M } from '../core/math.js';

const metre = DEG_TO_RAD * EARTH_RADIUS_M;
const coordinate = (x, z) => [x / metre, -z / metre];
const centerline = (osmId, z) => ({
    type: 'Feature',
    properties: { osm_id: osmId, highway: 'residential' },
    geometry: { type: 'LineString', coordinates: [coordinate(-30, z), coordinate(30, z)] },
});
const surface = (osmId, z) => ({
    type: 'Feature',
    properties: { osm_id: osmId, highway_type: 'residential', tags: { highway: 'residential' } },
    geometry: {
        type: 'Polygon',
        coordinates: [[
            coordinate(-30, z - 4), coordinate(30, z - 4), coordinate(30, z + 4),
            coordinate(-30, z + 4), coordinate(-30, z - 4),
        ]],
    },
});

test('proposal-masked road surfaces are withheld from the formation', () => {
    const features = [surface(101, 0), surface(202, 40)];
    const masked = new Set([101]);
    const kept = roadFormationSurfaceFeatures(features, {
        isFeatureMasked: feature => masked.has(feature.properties.osm_id),
    });
    assert.deepEqual(kept.map(feature => feature.properties.osm_id), [202]);
});

test('a masked road owns no formation profile, so it publishes no terrain cut', () => {
    // Terrain rises across both roads, so each formation would cut a bench.
    const terrainY = (x, z) => 10 + z * 0.3;
    const model = new RoadFormationModel({
        anchorLat: 0,
        anchorLon: 0,
        baseSceneYAtLocal: terrainY,
        terrainEvidenceSceneYAtLocal: terrainY,
        sourceTerrainInputSceneYAtLocal: terrainY,
        sourceTerrainOwnsInputAtLocal: () => true,
    });
    model.setCenterlineTile('tile', [centerline(101, 0), centerline(202, 40)]);
    model.setSurfaceTile('tile', roadFormationSurfaceFeatures(
        [surface(101, 0), surface(202, 40)],
        { isFeatureMasked: feature => feature.properties.osm_id === 101 },
    ));
    const owners = new Set(model.getSurfaceProfiles().map(profile => Number(profile.osmId)));
    assert.equal(owners.has(202), true, 'the unmasked road keeps its formation');
    assert.equal(owners.has(101), false, 'the masked road must not own terrain');
});

test('alignment-replaced surfaces stay out unless the alignment retains the formation', () => {
    const alignment = {
        replacesRoadSurfaceForOsmId: osmId => osmId === 1 || osmId === 2,
        retainsRoadFormationForOsmId: osmId => osmId === 2,
    };
    const kept = roadFormationSurfaceFeatures(
        [surface(1, 0), surface(2, 20), surface(3, 40)],
        { alignment },
    );
    assert.deepEqual(kept.map(feature => feature.properties.osm_id), [2, 3]);
});
