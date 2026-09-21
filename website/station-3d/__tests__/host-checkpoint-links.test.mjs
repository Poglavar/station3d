import test from 'node:test';
import assert from 'node:assert/strict';

import {
    campaignCheckpointRequest,
    checkpointAddressRoute,
} from '../debug/campaign-checkpoint-runner.js';

const path = '/sloboda/kampanja/toranj/adriatic-flight-start/';

test('checkpoint links jump locally and reopen the campaign on deployed hosts', () => {
    const local = campaignCheckpointRequest('', 'localhost', path, { basePath: '/sloboda/' });
    assert.deepEqual(local, {
        ok: true,
        campaignId: 'toranj-ljepote-snage-slobode',
        checkpointId: 'adriatic-flight-start',
    });
    assert.equal(checkpointAddressRoute(local), null);

    const deployed = campaignCheckpointRequest('?lang=hr', 'zagreb.lol', path, {
        basePath: '/sloboda/',
    });
    assert.equal(deployed.reason, 'host-not-local');
    assert.deepEqual(checkpointAddressRoute(deployed), {
        kind: 'campaign',
        checkpointId: null,
    });
});
