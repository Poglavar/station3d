import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchStreetFacingFacades } from '../world/street-facing.js';

test('street-facing data uses the bounded support lane needed by its parent building tile', async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    globalThis.window = { __ZAGREB_RUNTIME_CONFIG__: {} };
    let scheduled = null;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: { object_id: 1 }, geometry: null }],
        }),
    });
    const requestScheduler = {
        scheduleNetworkRequest(options) {
            scheduled = options;
            return options.run();
        },
    };
    try {
        const features = await fetchStreetFacingFacades({
            west: 15.97,
            south: 45.80,
            east: 15.98,
            north: 45.81,
        }, null, {
            requestScheduler,
            priority: { tier: 'visible', score: 12 },
        });
        assert.equal(features.length, 1);
        assert.equal(scheduled.label, 'street-facing:facades');
        assert.equal(scheduled.groupLimit, 2);
        assert.equal(scheduled.supportLane, true);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});
