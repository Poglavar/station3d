// Locks authored waiting trains to their named solved source and inside the
// selected endpoint of that source.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignRailVehicleCarStations,
    findCampaignRailVehicleFeature,
} from '../core/campaign-rail-vehicle.js';

test('campaign rail vehicles select the exact solved source', () => {
    const other = {
        type: 'Feature',
        properties: { sourceId: 'other' },
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    };
    const split = {
        type: 'Feature',
        properties: { sourceId: 'legacy-rail-perkovic-split-v1' },
        geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] },
    };
    assert.equal(findCampaignRailVehicleFeature(
        [other, split],
        { sourceId: 'legacy-rail-perkovic-split-v1' },
    ), split);
});

test('the waiting HŽ 7022 stays six metres inside the Split endpoint', () => {
    const carLengthM = 22.98;
    const stations = campaignRailVehicleCarStations({
        totalLengthM: 1000,
        specification: { endpoint: 'last', direction: -1, endClearanceM: 6 },
        carCount: 3,
        carSpacingM: 23.735,
        halfLengthM: 35.225,
    });
    assert.equal(stations.length, 3);
    assert.ok(Math.abs(Math.max(...stations) + carLengthM * 0.5 - 994) < 1e-9);
    assert.ok(stations.every(station => station > 0 && station < 1000));
});
