// Verifies one station cannot flare a perpendicular segment with another owner.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getOwnedEndpointTrackSpacingM,
    plannerSegmentOwnerProperties,
} from '../core/planner-station-flare.js';
import {
    getTrackCenterSpacingMeters,
    PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M,
} from '../world/tram-trackbed-dimensions.js';

test('segment owners survive a combined feature and isolate crossing flares', () => {
    const combined = {
        trackId: null,
        trackIds: [7, 8],
        segmentTrackIds: [7, 8],
        trackCount: 2,
        trackType: 'g1435',
    };
    const horizontal = plannerSegmentOwnerProperties(combined, 0);
    const perpendicular = plannerSegmentOwnerProperties(combined, 1);
    const stationFlares = [{ x: 0, z: 0, trackId: 7 }];

    assert.equal(
        getOwnedEndpointTrackSpacingM(horizontal, 0, 0, null, stationFlares),
        PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M,
    );
    assert.equal(
        getOwnedEndpointTrackSpacingM(perpendicular, 0, 0, null, stationFlares),
        getTrackCenterSpacingMeters(perpendicular),
    );
});

test('owned station flare ignores absolute model-world elevation', () => {
    const properties = {
        trackId: 7,
        trackCount: 2,
        trackType: 'g1435',
    };
    const stationFlares = [{ x: 0, z: 0, trackId: 7 }];
    assert.equal(
        getOwnedEndpointTrackSpacingM(properties, 0, 0, 96, stationFlares),
        PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M,
    );
});
