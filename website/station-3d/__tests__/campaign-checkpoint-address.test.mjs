// A checkpoint address opens the checkpoint on loopback hosts and the campaign
// everywhere else, so a reload mid-run on a deployed host never ends in an error.
import assert from 'node:assert/strict';
import test from 'node:test';

import { campaignCheckpointRequest, checkpointAddressRoute } from '../debug/campaign-checkpoint-runner.js';

const pathname = '/sloboda/kampanja/toranj/adriatic-flight-start/';

test('a loopback host keeps the checkpoint; a deployed host reopens the campaign', () => {
    const local = campaignCheckpointRequest('', 'localhost', pathname, { basePath: '/sloboda/' });
    assert.equal(local.ok, true);
    assert.equal(checkpointAddressRoute(local), null);
    const deployed = campaignCheckpointRequest('?lang=hr', 'zagreb.lol', pathname, { basePath: '/sloboda/' });
    assert.equal(deployed.reason, 'host-not-local');
    assert.deepEqual(checkpointAddressRoute(deployed), { kind: 'campaign', checkpointId: null });
});

test('a malformed checkpoint address is still an invalid route', () => {
    assert.deepEqual(checkpointAddressRoute({ ok: false, reason: 'checkpoint-missing' }), { kind: 'invalid', error: 'checkpoint-missing' });
    assert.deepEqual(checkpointAddressRoute({ ok: false, reason: 'feature-disabled' }), { kind: 'invalid', error: 'feature-disabled' });
});
