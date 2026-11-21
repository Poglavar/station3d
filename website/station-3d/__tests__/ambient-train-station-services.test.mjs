import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AMBIENT_TRAIN_STATION_SERVICES,
    ambientTrainStationServiceForAnchor,
} from '../core/ambient-train-station-services.js';

test('Split free roam resolves the authored kolodvor station service in local coordinates', () => {
    const service = ambientTrainStationServiceForAnchor(43.508465, 16.440181);
    assert.equal(service.id, 'split-kolodvor');
    assert.ok(service.distanceM > 300 && service.distanceM < 500);
    assert.ok(Number.isFinite(service.stationX));
    assert.ok(Number.isFinite(service.stationZ));
    assert.ok(service.approachDistanceM < service.clearDistanceM);
});

test('station service does not leak into a distant city session', () => {
    assert.equal(ambientTrainStationServiceForAnchor(45.812866, 15.978063), null);
    assert.equal(AMBIENT_TRAIN_STATION_SERVICES.length, 1);
});
