// Verifies the campaign release gate independently of DOM and runtime wiring.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CAMPAIGN_PRODUCTION_ENABLED,
    isCampaignFeatureEnabled,
} from '../core/campaign-feature.js';

test('the campaign is released on deployed hosts', () => {
    assert.equal(CAMPAIGN_PRODUCTION_ENABLED, true);
    assert.equal(isCampaignFeatureEnabled({ hostname: 'zagreb.lol' }), true);
    assert.equal(isCampaignFeatureEnabled({ hostname: 'preview.example' }), true);
});

test('campaign remains available for loopback development', () => {
    for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
        assert.equal(isCampaignFeatureEnabled({ hostname }), true, hostname);
    }
});

test('withholding the release closes deployed hosts, and the local override is explicit', () => {
    assert.equal(isCampaignFeatureEnabled({ hostname: 'zagreb.lol', productionEnabled: false }), false);
    assert.equal(isCampaignFeatureEnabled({ hostname: 'localhost', productionEnabled: false }), true);
    assert.equal(isCampaignFeatureEnabled({
        hostname: 'localhost',
        productionEnabled: false,
        localDevelopmentEnabled: false,
    }), false);
});
