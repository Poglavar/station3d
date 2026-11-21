import test from 'node:test';
import assert from 'node:assert/strict';

import { railFeatureEndpointFragment } from '../core/rail-feature-fragment.js';
import { RailFormationModel } from '../core/rail-formation.js';

test('endpoint fragments preserve vertex and edge authority through a civil boundary', () => {
    const coordinates = Array.from({ length: 6 }, (_, index) => [
        16.4430958,
        43.5048301 + index * 0.01,
        2.14 + index,
    ]);
    const feature = {
        type: 'Feature',
        properties: {
            railSourceChainagesM: [0, 1000, 2000, 3000, 4000, 5000],
            segmentTrackIds: ['s0', 's1', 's2', 's3', 's4'],
            railCivilRuns: [{ startM: 2500, endM: 4500, regime: 'tunnel' }],
        },
        geometry: { type: 'LineString', coordinates },
    };

    const fragment = railFeatureEndpointFragment(feature, {
        endpoint: 'last',
        maxDistanceM: 1200,
    });

    assert.deepEqual(fragment.properties.railSourceChainagesM, [2500, 3000, 4000, 5000]);
    assert.deepEqual(fragment.properties.segmentTrackIds, ['s2', 's3', 's4']);
    assert.equal(
        fragment.properties.railSourceChainagesM.length,
        fragment.geometry.coordinates.length,
    );
    assert.equal(
        fragment.properties.segmentTrackIds.length,
        fragment.geometry.coordinates.length - 1,
    );
    assert.equal(fragment.geometry.coordinates[0][1], 43.5298301);
    assert.deepEqual(fragment.geometry.coordinates.at(-1), coordinates.at(-1));
    assert.deepEqual(feature.geometry.coordinates, coordinates, 'source geometry is immutable');
});

test('a bounded rail fragment keeps the authored portal instead of re-inferring a cut', () => {
    const coordinates = Array.from({ length: 6 }, (_, index) => [
        16,
        45.8 + index * 0.001,
        0,
    ]);
    const feature = {
        type: 'Feature',
        properties: {
            source: 'reference-project',
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
            railSourceChainagesM: [0, 100, 200, 300, 400, 500],
            segmentTrackIds: ['s0', 's1', 's2', 's3', 's4'],
            railCivilRuns: [
                { startM: 250, endM: 450, regime: 'tunnel' },
                { startM: 450, endM: 500, regime: 'fill' },
            ],
        },
        geometry: { type: 'LineString', coordinates },
    };
    const fragment = railFeatureEndpointFragment(feature, {
        endpoint: 'last',
        maxDistanceM: 120,
    });
    const model = new RailFormationModel({
        anchorLat: 45.8,
        anchorLon: 16,
        features: [fragment],
        // Hostile terrain would classify the complete fragment as tunnel if
        // aligned source metadata were lost at the renderer window boundary.
        baseSceneYAtLocal: () => 30,
        absoluteSceneYAtHeight: heightM => heightM,
        halfWidthForFeature: () => 2,
    });

    const [tunnel] = model.getTunnelRuns();
    assert.ok(tunnel, 'published tunnel survives the bounded render window');
    assert.equal(tunnel.samples[0].sourceStationM, 250);
    assert.equal(tunnel.samples.at(-1).sourceStationM, 450);
    assert.equal(model.getSurfaceProfiles().length, 1, 'fill approach survives after the mouth');
    assert.equal(
        model.getTunnelPortalTerrainOpenings().length,
        1,
        'the exact tunnel-to-formation boundary owns one portal aperture',
    );
});

test('endpoint fragments reject misaligned civil authority instead of silently losing it', () => {
    const feature = {
        type: 'Feature',
        properties: {
            railSourceChainagesM: [0, 100, 200],
            railCivilRuns: [{ startM: 50, endM: 150, regime: 'tunnel' }],
        },
        geometry: {
            type: 'LineString',
            coordinates: [[16, 45.8, 0], [16, 45.801, 0]],
        },
    };

    assert.throws(
        () => railFeatureEndpointFragment(feature, { maxDistanceM: 50 }),
        /railSourceChainagesM must contain one finite value per rail vertex/,
    );
});
