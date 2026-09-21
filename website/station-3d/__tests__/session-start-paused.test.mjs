import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStartCabPaused } from '../core/session-flags.js';

test('cab start pause is explicit and accepts the benchmark URL flag', () => {
    assert.equal(shouldStartCabPaused({}, ''), false);
    assert.equal(shouldStartCabPaused({ startPaused: true }, ''), true);
    assert.equal(shouldStartCabPaused({}, '?st3dStartPaused=1'), true);
    assert.equal(shouldStartCabPaused({}, '?st3dStartPaused=0'), false);
});
