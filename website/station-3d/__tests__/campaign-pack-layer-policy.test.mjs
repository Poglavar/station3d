// Keeps live authored campaign geometry active above an immutable baked world
// while removing only the streamed static layers represented by that pack.

import assert from 'node:assert/strict';
import test from 'node:test';

import { campaignPackReplacesLayer } from '../core/campaign-pack-layer-policy.js';

test('a campaign pack replaces static streams but not the staged campaign tower', () => {
    for (const layerName of ['terrain', 'roads', 'buildings', 'decor']) {
        assert.equal(campaignPackReplacesLayer(layerName), true, layerName);
    }
    for (const layerName of [
        'campaignTower',
        'campaignEnvironment',
        'campaignActors',
        'campaignMarkers',
        'gtaSpecialVehicles',
    ]) {
        assert.equal(campaignPackReplacesLayer(layerName), false, layerName);
    }
});
