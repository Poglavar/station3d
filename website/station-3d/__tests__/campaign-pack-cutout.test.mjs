import assert from 'node:assert/strict';
import test from 'node:test';

import {
    campaignPackCutoutContains,
    campaignPackCutoutPlaneSpecs,
    resolveCampaignPackCutout,
} from '../core/campaign-pack-cutout.js';

test('campaign pack cutout resolves relative to the authored set origin', () => {
    const cutout = resolveCampaignPackCutout({
        offsetX: -4,
        offsetZ: 1,
        widthM: 12,
        depthM: 6,
    }, {
        originX: 10,
        originZ: -2,
    });
    assert.deepEqual(
        [cutout.minX, cutout.maxX, cutout.minZ, cutout.maxZ],
        [0, 12, -4, 2],
    );
    assert.equal(campaignPackCutoutContains(cutout, 6, 0), true);
    assert.equal(campaignPackCutoutContains(cutout, -0.01, 0), false);
});

test('campaign pack cutout planes describe an inside-only clipping intersection', () => {
    const cutout = resolveCampaignPackCutout({ widthM: 10, depthM: 4 });
    assert.deepEqual(campaignPackCutoutPlaneSpecs(cutout), [
        { normal: [-1, 0, 0], constant: -5 },
        { normal: [1, 0, 0], constant: -5 },
        { normal: [0, 0, -1], constant: -2 },
        { normal: [0, 0, 1], constant: -2 },
    ]);
});
