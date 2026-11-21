import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    campaignPackBlockingActivity,
    waitForCampaignPackSettlement,
} from '../core/campaign-pack-settlement.js';

test('campaign bake waits for static work but ignores dynamic traffic', async () => {
    let time = 0;
    const snapshots = [
        [{ label: 'roads', pending: 4 }, { label: 'cars', pending: 99 }],
        [{ label: 'buildings', building: 1 }],
        [{ label: 'cars', pending: 99 }],
        [{ label: 'cars', pending: 99 }],
    ];
    let index = 0;
    const settled = await waitForCampaignPackSettlement({
        readActivity: () => snapshots[Math.min(index++, snapshots.length - 1)],
        now: () => time,
        sleep: async (ms) => { time += ms; },
        stableMs: 250,
        pollMs: 250,
    });
    assert.equal(settled, true);
    assert.deepEqual(campaignPackBlockingActivity(snapshots[0]).map(entry => entry.label), ['roads']);
});

test('campaign bake fails closed on static publication errors', async () => {
    await assert.rejects(
        waitForCampaignPackSettlement({
            readActivity: () => [{ label: 'surface publications', invalidClaims: 1 }],
            sleep: async () => {},
        }),
        /surface publications/,
    );
});

test('campaign bake permits a source retry to recover before release', async () => {
    let time = 0;
    const snapshots = [
        [{ label: 'buildings', pending: 1, retrying: 1, fetchFailed: 1 }],
        [],
        [],
    ];
    let index = 0;
    assert.equal(await waitForCampaignPackSettlement({
        readActivity: () => snapshots[Math.min(index++, snapshots.length - 1)],
        now: () => time,
        sleep: async (ms) => { time += ms; },
        stableMs: 250,
        pollMs: 250,
    }), true);
});
