import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldHideCatchAllGround } from '../core/session-ground-visibility.js';

test('ordinary surface sessions retain the catch-all ground plane', () => {
    assert.equal(shouldHideCatchAllGround(), false);
});

test('underground sessions hide the catch-all ground plane', () => {
    assert.equal(shouldHideCatchAllGround({ isUndergroundSession: true }), true);
});

test('a baked campaign pack exclusively owns visible ground', () => {
    assert.equal(shouldHideCatchAllGround({
        campaignWorldPack: { contract: 'station3d-loaded-campaign-pack-v1' },
    }), true);
});

test('an open-sea set piece has no concrete stand-in for water', () => {
    assert.equal(shouldHideCatchAllGround({ openSea: true }), true);
    assert.equal(shouldHideCatchAllGround({ openSea: false }), false);
});

test('an aerial scene draws its own far terrain and sea, so the concrete plane goes', () => {
    assert.equal(shouldHideCatchAllGround({ aerialView: true }), true);
    assert.equal(shouldHideCatchAllGround({ aerialView: false }), false);
});
