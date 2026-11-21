// Protects wet locations from surface-track cuts that reveal the global sea.

import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerGroundMaskCuts } from '../core/planner-cut-policy.js';

const cuts = [
    { kind: 'surface-track', id: 'surface' },
    { kind: 'ramp', id: 'ramp' },
    { kind: 'tunnel', id: 'tunnel' },
];

test('keeps every planner cut in a dry location', () => {
    assert.equal(plannerGroundMaskCuts(cuts, { water: false }), cuts);
});

test('keeps solid ground under at-grade track in a sea location', () => {
    assert.deepEqual(plannerGroundMaskCuts(cuts, { water: true }), [cuts[1], cuts[2]]);
});
