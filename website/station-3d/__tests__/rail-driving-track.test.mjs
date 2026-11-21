// The player vehicle must follow one rendered physical rail centre, never the
// median axis used to describe a multi-track civil corridor.

import assert from 'node:assert/strict';
import test from 'node:test';

import { haversineMeters } from '../core/math.js';
import {
    offsetRailLineStringFeature,
    selectPhysicalTrackOffsetM,
} from '../core/rail-driving-track.js';
import { getTrackCenterOffsetsMeters } from '../world/tram-trackbed-dimensions.js';
import { resolveRailProfileFeatures } from '../core/rail-profile-source.js';

test('single-track alignments keep the solved centreline', () => {
    const feature = {
        type: 'Feature',
        properties: { trackType: 'g1435', trackCount: 1 },
        geometry: {
            type: 'LineString',
            coordinates: [[15.97, 45.8, 120], [15.98, 45.8, 121]],
        },
    };
    const offsetM = selectPhysicalTrackOffsetM(
        getTrackCenterOffsetsMeters(feature.properties),
        { initialEndpoint: 'last', runningSide: 'right' },
    );
    assert.equal(offsetM, 0);
    assert.equal(offsetRailLineStringFeature(feature, offsetM), feature);
});

test('reverse-running trains use the right-hand rail of a rendered double track', () => {
    const feature = {
        type: 'Feature',
        properties: { trackType: 'g1435', trackCount: 2, trackArrangement: 'double' },
        geometry: {
            type: 'LineString',
            coordinates: [[15.98, 45.8, 120], [15.97, 45.8, 121]],
        },
    };
    const offsets = getTrackCenterOffsetsMeters(feature.properties);
    const offsetM = selectPhysicalTrackOffsetM(offsets, {
        initialEndpoint: 'last',
        runningSide: 'right',
    });
    assert.equal(offsetM, 1.7);

    const physical = offsetRailLineStringFeature(feature, offsetM);
    assert.equal(physical.properties.trackCount, 1);
    assert.equal(physical.properties.physicalTrackOffsetM, 1.7);
    assert.deepEqual(
        physical.geometry.coordinates.map(coordinate => coordinate[2]),
        [120, 121],
    );
    const separationM = haversineMeters(
        feature.geometry.coordinates[0][1],
        feature.geometry.coordinates[0][0],
        physical.geometry.coordinates[0][1],
        physical.geometry.coordinates[0][0],
    );
    assert.ok(Math.abs(separationM - 1.7) < 0.01, `offset was ${separationM} m`);
});

test('travel direction and running side select opposite physical rails', () => {
    const offsets = [-1.7, 1.7];
    assert.equal(selectPhysicalTrackOffsetM(offsets, {
        initialEndpoint: 'first',
        runningSide: 'right',
    }), -1.7);
    assert.equal(selectPhysicalTrackOffsetM(offsets, {
        initialEndpoint: 'last',
        runningSide: 'right',
    }), 1.7);
    assert.equal(selectPhysicalTrackOffsetM(offsets, {
        initialEndpoint: 'last',
        runningSide: 'left',
    }), -1.7);
});

test('the Split driving track and renderer share the corrected station approach', () => {
    const source = {
        type: 'Feature',
        properties: {
            source: 'reference-project',
            referenceSourceId: 'legacy-rail-perkovic-split-v1',
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
            trackCount: 1,
            railSourceChainagesM: [48650, 48700, 48750],
        },
        geometry: {
            type: 'LineString',
            coordinates: [[16.4422, 43.5068, 4], [16.4425, 43.5064, 4], [16.4428, 43.506, 4]],
        },
    };
    const rendered = resolveRailProfileFeatures({ solvedFeatures: [source], mode: 'solved' })[0];
    const driven = offsetRailLineStringFeature(source, 0);
    assert.deepEqual(driven.geometry.coordinates, rendered.geometry.coordinates);
    const offsetM = haversineMeters(
        source.geometry.coordinates[1][1], source.geometry.coordinates[1][0],
        driven.geometry.coordinates[1][1], driven.geometry.coordinates[1][0],
    );
    assert.ok(Math.abs(offsetM - 1.25) < 0.01, `correction was ${offsetM} m`);
    assert.deepEqual(source.geometry.coordinates[1], [16.4425, 43.5064, 4]);
    assert.deepEqual(
        offsetRailLineStringFeature(rendered, 0).geometry.coordinates,
        rendered.geometry.coordinates,
        'parked trains must not apply the source correction twice',
    );
});
