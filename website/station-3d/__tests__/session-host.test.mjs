// Covers the engine-owned host configuration without importing a downstream application.
import assert from 'node:assert/strict';
import test from 'node:test';

import { configureSessionHost, getSessionHost } from '../core/session-host.js';

test('host configuration is immutable and preserves only supported callbacks', () => {
    const onExit = () => {};
    const host = configureSessionHost({
        basePath: '/world',
        name: 'Demo host',
        onExit,
        devOverlays: false,
        campaigns: false,
        ignored: 'host-private',
    });
    assert.deepEqual(host, {
        basePath: '/world',
        name: 'Demo host',
        onExit,
        devOverlays: false,
        campaigns: false,
    });
    assert.equal(Object.isFrozen(host), true);
    assert.equal(getSessionHost(), host);
});

test('host diagnostics default on unless the embedding application opts out', () => {
    assert.equal(configureSessionHost({}).devOverlays, true);
    assert.equal(configureSessionHost({ devOverlays: false }).devOverlays, false);
});

test('campaigns remain available by default and a product host can opt out', () => {
    assert.equal(configureSessionHost({}).campaigns, true);
    assert.equal(configureSessionHost({ campaigns: false }).campaigns, false);
});
