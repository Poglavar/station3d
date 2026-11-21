import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CAMPAIGN_RAIL_EXIT_DOOR_RATIO,
    campaignRailDoorState,
    campaignRailHandoffReady,
    shouldRouteRailDoorInteraction,
} from '../core/campaign-rail-handoff.js';

test('campaign door snapshots wait for the physical opening, not the door command', () => {
    assert.deepEqual(campaignRailDoorState({
        doors: { open: true, ratio: 0.06 },
        status: { doorsOpen: true },
    }), {
        doorRatio: 0.06,
        doorsOpen: false,
    });
    assert.deepEqual(campaignRailDoorState({
        doors: { open: true, ratio: CAMPAIGN_RAIL_EXIT_DOOR_RATIO },
    }), {
        doorRatio: CAMPAIGN_RAIL_EXIT_DOOR_RATIO,
        doorsOpen: true,
    });
});

test('E belongs to the train doors while the rail controller owns the player', () => {
    assert.equal(shouldRouteRailDoorInteraction({
        isTrainSession: true,
        walkMode: false,
        controllerId: 'rail',
    }), true);
    assert.equal(shouldRouteRailDoorInteraction({
        isTrainSession: true,
        walkMode: true,
        controllerId: 'foot',
    }), false);
});

test('Zagreb handoff requires a stopped train, an open doorway, and the preloaded world', () => {
    const ready = {
        isTrainSession: true,
        walkMode: false,
        controllerId: 'rail',
        gtaReady: true,
        speedMps: 0,
        doorRatio: CAMPAIGN_RAIL_EXIT_DOOR_RATIO,
    };
    assert.equal(campaignRailHandoffReady(ready), true);
    assert.equal(campaignRailHandoffReady({ ...ready, doorRatio: 0.1 }), false);
    assert.equal(campaignRailHandoffReady({ ...ready, speedMps: 0.2 }), false);
    assert.equal(campaignRailHandoffReady({ ...ready, gtaReady: false }), false);
});
