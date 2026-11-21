import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMPAIGN_SIDEARM_ITEM_ID, campaignSidearmAvailable, weaponToggleEnabled, weaponToggleIntent } from '../core/campaign-sidearm.js';
import { ambientHostilesEnabled } from '../core/hostility-scope.js';

test('the sidearm is an inventory item', () => {
    assert.equal(CAMPAIGN_SIDEARM_ITEM_ID, 'sidearm');
    assert.equal(campaignSidearmAvailable({ inventory: { sidearm: 1 } }), true);
    assert.equal(campaignSidearmAvailable({ inventory: { sidearm: 0 } }), false);
    assert.equal(campaignSidearmAvailable({ inventory: {} }), false);
    assert.equal(campaignSidearmAvailable(null), false);
});

test('on foot the weapon toggle draws and holsters only with a sidearm; in a vehicle it arms and disarms', () => {
    assert.equal(weaponToggleIntent({ onFoot: true, sidearmAvailable: false }), null);
    assert.equal(weaponToggleIntent({ onFoot: true, sidearmAvailable: true }), 'draw');
    assert.equal(weaponToggleIntent({ onFoot: true, sidearmAvailable: true, weaponAttached: true }), 'holster');
    assert.equal(weaponToggleIntent({ onFoot: false }), 'arm');
    assert.equal(weaponToggleIntent({ onFoot: false, weaponAttached: true }), 'disarm');
    assert.equal(weaponToggleIntent({ onFoot: false, underground: true }), null);
    assert.equal(weaponToggleEnabled({ showWalk: true, onFoot: true, sidearmAvailable: false }), false);
    assert.equal(weaponToggleEnabled({ showWalk: true, onFoot: true, sidearmAvailable: true }), true);
    assert.equal(weaponToggleEnabled({ showWalk: true, onFoot: false }), true);
    assert.equal(weaponToggleEnabled({ showWalk: false, onFoot: false }), false);
});

test('drawing the sidearm in a campaign never switches the free-roam hostile sandbox on', () => {
    assert.equal(ambientHostilesEnabled({ gameMode: 'game' }), true);
    assert.equal(ambientHostilesEnabled({ gameMode: 'game', campaignEncounterActive: true }), false);
    assert.equal(ambientHostilesEnabled({ gameMode: 'game', campaignSession: true }), false);
});
