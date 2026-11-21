// Verifies generic authored campaign rooms remain bounded and always provide
// one walkable floor plus a complete enclosing shell.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignRoomAllowsJetpack,
    campaignRoomBoxes,
    campaignRoomElevationOffsetM,
    campaignRoomOwnsFloor,
    campaignSceneAllowsJetpack,
    resolveCampaignRoom,
} from '../core/campaign-room.js';

test('campaign rooms clamp authored dimensions and produce a closed six-box shell', () => {
    const environment = {
        kind: 'room',
        widthM: 500,
        depthM: 2,
        heightM: 7,
        wallThicknessM: 0.4,
    };
    const room = resolveCampaignRoom(environment);
    const boxes = campaignRoomBoxes(environment);
    assert.equal(room.widthM, 80);
    assert.equal(room.depthM, 8);
    assert.equal(room.heightM, 7);
    assert.equal(boxes.length, 6);
    assert.deepEqual(
        boxes.filter(box => box.walkableSurface).map(box => box.id),
        ['floor'],
    );
    assert.deepEqual(
        new Set(boxes.map(box => box.id)),
        new Set(['floor', 'ceiling', 'west-wall', 'east-wall', 'north-wall', 'south-wall']),
    );
});

test('unknown campaign environments do not fabricate geometry', () => {
    assert.equal(resolveCampaignRoom({ kind: 'castle' }), null);
    assert.deepEqual(campaignRoomBoxes(null), []);
});

test('campaign room elevation cells are bounded and room-only', () => {
    assert.equal(campaignRoomElevationOffsetM({ kind: 'room', elevationOffsetM: 80 }), 80);
    assert.equal(campaignRoomElevationOffsetM({ kind: 'room', elevationOffsetM: 500 }), 200);
    assert.equal(campaignRoomElevationOffsetM({ kind: 'room' }), 0);
    assert.equal(campaignRoomElevationOffsetM({ kind: 'street', elevationOffsetM: 80 }), 0);
});

test('an exterior entrance decorates live ground without claiming a flat room floor', () => {
    assert.equal(campaignRoomOwnsFloor({ kind: 'room' }), true);
    assert.equal(campaignRoomOwnsFloor({ kind: 'room', set: 'gric-resistance' }), true);
    assert.equal(campaignRoomOwnsFloor({ kind: 'room', set: 'gric-entrance' }), false);
    assert.equal(campaignRoomOwnsFloor({ kind: 'street' }), false);
});

test('enclosed campaign rooms suppress flight while exterior set pieces preserve it', () => {
    assert.equal(campaignRoomAllowsJetpack({ kind: 'room' }), false);
    assert.equal(campaignRoomAllowsJetpack({ kind: 'room', set: 'gric-resistance' }), false);
    assert.equal(campaignRoomAllowsJetpack({ kind: 'room', set: 'gric-entrance' }), true);
    assert.equal(campaignRoomAllowsJetpack({ kind: 'street' }), true);
    assert.equal(campaignRoomAllowsJetpack(null), true);
});

test('campaign scenes are grounded unless an exterior scene explicitly enables flight', () => {
    assert.equal(campaignSceneAllowsJetpack(null), false);
    assert.equal(campaignSceneAllowsJetpack({ authored: {} }), false);
    assert.equal(campaignSceneAllowsJetpack({
        authored: { jetpackAllowed: true },
    }), true);
    assert.equal(campaignSceneAllowsJetpack({
        authored: { jetpackAllowed: true, environment: { kind: 'room' } },
    }), false);
});
