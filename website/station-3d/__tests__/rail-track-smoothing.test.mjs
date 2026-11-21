// Verifies the common Station3D smoothing policy distinguishes mainline rail
// from tram/light-rail geometry instead of keying off the active vehicle.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { smoothRailTrackFeatures } from '../world/rail-track-smoothing.js';

const cabSource = await readFile(new URL('../modes/cab.js', import.meta.url), 'utf8');
const railsSource = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
const scenarioRunnerSource = await readFile(
    new URL('../debug/scenario-runner.js', import.meta.url),
    'utf8',
);

function gentleBend(properties) {
    return {
        type: 'Feature',
        properties,
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
}

test('gentle heavy-rail survey chords are rounded throughout Station3D', () => {
    const feature = gentleBend({ railway: 'rail', gauge: 1435 });
    const [smoothed] = smoothRailTrackFeatures([feature]);
    assert.ok(smoothed.geometry.coordinates.length > feature.geometry.coordinates.length);
});

test('the same gentle bend remains untouched for tram and light rail', () => {
    for (const properties of [
        { railway: 'tram', gauge: 1435 },
        { railway: 'light_rail', gauge: 1435 },
        { railMode: 'tram', trackType: 'g1000' },
    ]) {
        const feature = gentleBend(properties);
        const [smoothed] = smoothRailTrackFeatures([feature]);
        assert.equal(smoothed, feature);
    }
});

test('the shared policy covers streamed rails, supplied rides and scenarios', () => {
    assert.match(cabSource, /smoothRailTrackFeatures\(\(options && options\.otherTracks\)/);
    assert.match(cabSource, /smoothRailTrackFeatures\(options\.driverTracks\)/);
    assert.match(railsSource, /smoothRailTrackFeatures\(streamed\)/);
    assert.match(scenarioRunnerSource, /smoothRailTrackFeatures\(/);
});
