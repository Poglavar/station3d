// The display-state model for proposal buildings (solid | ghost | off).
// The default is the whole point of the feature — massing shown in the local
// style — so it is pinned here, as is the rule that masking never varies by
// state (policy only ever decides VISIBILITY of proposal volumes).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PROPOSAL_BUILDING_DISPLAY,
    PROPOSAL_BUILDING_DISPLAY_STATES,
    nextProposalBuildingDisplay,
    parseProposalBuildingDisplay,
    proposalBuildingDisplayPolicy,
} from '../core/proposal-building-display.js';

test('states are exactly solid|ghost|off and solid is the default', () => {
    assert.deepEqual(PROPOSAL_BUILDING_DISPLAY_STATES, ['solid', 'ghost', 'off']);
    assert.equal(DEFAULT_PROPOSAL_BUILDING_DISPLAY, 'solid');
});

test('parse: missing, junk, and empty all mean solid', () => {
    assert.equal(parseProposalBuildingDisplay(''), 'solid');
    assert.equal(parseProposalBuildingDisplay('?foo=1'), 'solid');
    assert.equal(parseProposalBuildingDisplay('?proposalsView='), 'solid');
    assert.equal(parseProposalBuildingDisplay('?proposalsView=banana'), 'solid');
    assert.equal(parseProposalBuildingDisplay(null), 'solid');
});

test('parse: each state comes through, case-insensitively', () => {
    assert.equal(parseProposalBuildingDisplay('?proposalsView=ghost'), 'ghost');
    assert.equal(parseProposalBuildingDisplay('?proposalsView=OFF'), 'off');
    assert.equal(parseProposalBuildingDisplay('?a=1&proposalsView=Solid&b=2'), 'solid');
});

test('N cycles solid → ghost → off → solid', () => {
    assert.equal(nextProposalBuildingDisplay('solid'), 'ghost');
    assert.equal(nextProposalBuildingDisplay('ghost'), 'off');
    assert.equal(nextProposalBuildingDisplay('off'), 'solid');
    // An unknown state re-enters the cycle rather than throwing.
    assert.equal(nextProposalBuildingDisplay('banana'), 'solid');
});

test('policy: exactly one of solid/ghost is on outside off, models hide only in off', () => {
    assert.deepEqual(proposalBuildingDisplayPolicy('solid'), { solid: true, ghost: false, models: true });
    assert.deepEqual(proposalBuildingDisplayPolicy('ghost'), { solid: false, ghost: true, models: true });
    assert.deepEqual(proposalBuildingDisplayPolicy('off'), { solid: false, ghost: false, models: false });
    // Unknown behaves as the default.
    assert.deepEqual(proposalBuildingDisplayPolicy('banana'), proposalBuildingDisplayPolicy('solid'));
});
