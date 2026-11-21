// Confirms shared track smoothing preserves Z and per-segment track ownership.

import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothTrackFeatures } from '../core/track-smooth.js';

test('smooths a consensus proposal bend and keeps vertex/segment metadata aligned', () => {
    const feature = {
        type: 'Feature',
        properties: {
            source: 'cb-proposal',
            elevationMode: 'absolute',
            segmentTrackIds: [101, 101, 101, 202, 202, 202],
            railSourceChainagesM: [100, 110, 120, 130, 140, 150, 160],
        },
        geometry: {
            type: 'LineString',
            coordinates: [
                [16.0000, 43.0000, 10],
                [16.0001, 43.0000, 11],
                [16.0002, 43.00002, 12],
                [16.0003, 43.00008, 13],
                [16.0004, 43.00014, 14],
                [16.0005, 43.00020, 15],
                [16.0006, 43.00026, 16],
            ],
        },
    };
    const [smoothed] = smoothTrackFeatures([feature]);
    assert.equal(smoothed.properties.source, 'cb-proposal');
    assert.ok(smoothed.geometry.coordinates.length > feature.geometry.coordinates.length);
    assert.deepEqual(smoothed.geometry.coordinates[0], feature.geometry.coordinates[0]);
    assert.deepEqual(smoothed.geometry.coordinates.at(-1), feature.geometry.coordinates.at(-1));
    assert.ok(smoothed.geometry.coordinates.every((coordinate) => (
        coordinate.length === 3 && Number.isFinite(coordinate[2])
    )));
    assert.ok(smoothed.geometry.coordinates.every((coordinate) => (
        coordinate[2] >= 10 && coordinate[2] <= 16
    )));
    assert.equal(
        smoothed.properties.segmentTrackIds.length,
        smoothed.geometry.coordinates.length - 1,
    );
    assert.equal(smoothed.properties.segmentTrackIds[0], 101);
    assert.equal(smoothed.properties.segmentTrackIds.at(-1), 202);
    assert.equal(
        smoothed.properties.railSourceChainagesM.length,
        smoothed.geometry.coordinates.length,
    );
    assert.equal(smoothed.properties.railSourceChainagesM[0], 100);
    assert.equal(smoothed.properties.railSourceChainagesM.at(-1), 160);
    assert.ok(smoothed.properties.railSourceChainagesM.every(Number.isFinite));
    assert.ok(smoothed.properties.railSourceChainagesM.every((value, index, values) => (
        index === 0 || value >= values[index - 1]
    )), 'smoothed source chainage remains monotonic');
});

test('a heavy-rail threshold rounds gentle 20 m survey chords without changing tram defaults', () => {
    const feature = {
        type: 'Feature',
        properties: { source: 'exact-profile-heavy-rail' },
        geometry: {
            type: 'LineString',
            coordinates: [
                [15.00000, 44.00000, 500],
                [15.00025, 44.00000, 500],
                [15.00050, 44.00000, 500],
                [15.00075, 44.00000, 500],
                [15.00100, 44.00001, 500],
                [15.00125, 44.00002, 500],
                [15.00150, 44.00003, 500],
            ],
        },
    };

    const [tramDefault] = smoothTrackFeatures([feature]);
    assert.equal(tramDefault, feature, 'sub-4° survey bend stays untouched by tram defaults');

    const [heavyRail] = smoothTrackFeatures([feature], {
        minTurnDeg: 0.05,
        maxTurnDeg: 12,
        maxFilletM: 9.5,
    });
    assert.ok(heavyRail.geometry.coordinates.length > feature.geometry.coordinates.length);
    assert.deepEqual(heavyRail.geometry.coordinates[0], feature.geometry.coordinates[0]);
    assert.deepEqual(heavyRail.geometry.coordinates.at(-1), feature.geometry.coordinates.at(-1));
});
