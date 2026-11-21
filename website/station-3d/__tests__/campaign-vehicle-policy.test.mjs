// The pure per-scene vehicle rules: where a boat may be left, and how a lost
// vehicle ends a scene.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    boatExitAllowedAt,
    campaignBoatExitBerth,
    campaignVehicleLossOutcome,
} from '../core/campaign-vehicle-policy.js';

const berthScene = () => ({
    authored: {
        boatExitZoneId: 'berth',
        zones: [
            { id: 'harbor', center: { lat: 43.5, lon: 16.4 }, radiusM: 40 },
            { id: 'berth', center: { lat: 43.505, lon: 16.4414 }, radiusM: 7 },
        ],
    },
});

test('a scene names one of its zones as the only boat exit', () => {
    assert.deepEqual(campaignBoatExitBerth(berthScene()), { id: 'berth', lat: 43.505, lon: 16.4414, radiusM: 7 });
    assert.equal(campaignBoatExitBerth({ authored: { zones: berthScene().authored.zones } }), null, 'no field, no restriction');
    assert.equal(campaignBoatExitBerth({ authored: { boatExitZoneId: 'missing', zones: [] } }), null, 'an unknown zone id restricts nothing');
    assert.equal(campaignBoatExitBerth({ authored: { boatExitZoneId: 'berth', zones: [{ id: 'berth', lat: 1, lon: 2, radiusM: 0 }] } }), null, 'a zero radius is not a berth');
    assert.deepEqual(campaignBoatExitBerth({ authored: { boatExitZoneId: 'b', zones: [{ id: 'b', lat: 1, lon: 2, radiusM: 3 }] } }), { id: 'b', lat: 1, lon: 2, radiusM: 3 }, 'a flat lat/lon pair also resolves');
    assert.equal(campaignBoatExitBerth(null), null);
});

test('the exit is allowed inside the berth circle and everywhere when there is none', () => {
    const berth = { x: 10, z: -20, radiusM: 7 };
    assert.equal(boatExitAllowedAt(12, -24, berth), true);
    assert.equal(boatExitAllowedAt(17, -20, berth), true, 'the rim counts');
    assert.equal(boatExitAllowedAt(18, -20, berth), false);
    assert.equal(boatExitAllowedAt(200, 300, null), true);
});

test('only a scene that says so ejects the player when the vehicle is lost', () => {
    assert.equal(campaignVehicleLossOutcome({ authored: { onVehicleLost: 'eject' } }), 'eject');
    assert.equal(campaignVehicleLossOutcome({ authored: {} }), 'fail');
});
