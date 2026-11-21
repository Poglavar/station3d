import assert from 'node:assert/strict';
import { test } from 'node:test';

import { campaignPlayAreaContainsPose } from '../core/campaign-play-area.js';

test('campaign corridor follows the authored route instead of a huge circular sandbox', () => {
    const bounds = {
        kind: 'corridor',
        path: [
            { lat: 45.80, lon: 15.97 },
            { lat: 45.81, lon: 15.98 },
            { lat: 45.82, lon: 15.97 },
        ],
        halfWidthM: 250,
    };
    assert.equal(campaignPlayAreaContainsPose(bounds, { lat: 45.81, lon: 15.98 }), true);
    assert.equal(campaignPlayAreaContainsPose(bounds, { lat: 45.81, lon: 15.983 }), true);
    assert.equal(campaignPlayAreaContainsPose(bounds, { lat: 45.81, lon: 16.00 }), false);
});
test('campaign play area retains the circular contract for other chapters', () => {
    const bounds = { center: { lat: 45.8, lon: 15.9 }, radiusM: 100 };
    assert.equal(campaignPlayAreaContainsPose(bounds, { lat: 45.8, lon: 15.9 }), true);
    assert.equal(campaignPlayAreaContainsPose(bounds, { lat: 45.81, lon: 15.9 }), false);
});
