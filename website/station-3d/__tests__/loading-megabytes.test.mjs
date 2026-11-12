// The loading screen's growing "MB loaded" figure: wire bytes when the browser
// reports them, else the decoded estimate, in the page language's decimals.
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLoadedMegabytes } from '../core/dashboard-metrics.js';

test('nothing loaded yet shows no figure rather than 0.0 MB', () => {
    assert.equal(formatLoadedMegabytes({}), null);
    assert.equal(formatLoadedMegabytes({ receivedBytes: 0, transferBytes: 0 }), null);
    assert.equal(formatLoadedMegabytes(undefined), null);
});

test('the wire figure wins over the larger decoded estimate', () => {
    assert.equal(formatLoadedMegabytes({ receivedBytes: 169_000_000, transferBytes: 7_240_000 }, 'en'), '7.2');
});

test('without a wire figure the decoded estimate stands in', () => {
    assert.equal(formatLoadedMegabytes({ receivedBytes: 12_350_000 }, 'en'), '12.4');
});

test('Croatian uses a decimal comma', () => {
    assert.equal(formatLoadedMegabytes({ transferBytes: 12_400_000 }, 'hr'), '12,4');
    assert.equal(formatLoadedMegabytes({ transferBytes: 1_234_500_000 }, 'hr'), '1.234,5');
});
