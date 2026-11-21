// ?plan= deeplink parsing: the slug that reaches GET /plans/<slug>, and the
// merge with explicitly enumerated ?proposals= ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensPlanSlug, mergeProposalIds, parseEnsPlanParam } from '../core/ens-plan.js';

test('bare slug passes through, full ENS name reduces to its first label', () => {
    assert.equal(ensPlanSlug('sibenik-2066-1'), 'sibenik-2066-1');
    assert.equal(ensPlanSlug('sibenik-2066-1.proposals.urbangametheory.eth'), 'sibenik-2066-1');
    // ENS is case-insensitive lowercase; whitespace is user error, not data.
    assert.equal(ensPlanSlug('  Sibenik-2066-1.Proposals.UrbanGameTheory.ETH '), 'sibenik-2066-1');
    // Whatever domain a future plan hangs under, the first label is the slug.
    assert.equal(ensPlanSlug('plan-x.somewhere.else.xyz'), 'plan-x');
});

test('empty and junk values mean no plan', () => {
    assert.equal(ensPlanSlug(''), null);
    assert.equal(ensPlanSlug('   '), null);
    assert.equal(ensPlanSlug(null), null);
    assert.equal(ensPlanSlug(undefined), null);
    assert.equal(ensPlanSlug('.eth'), null);
});

test('parseEnsPlanParam reads ?plan= from a search string', () => {
    assert.equal(parseEnsPlanParam('?plan=sibenik-2066-1.proposals.urbangametheory.eth'), 'sibenik-2066-1');
    assert.equal(parseEnsPlanParam('?proposals=1,2'), null);
    assert.equal(parseEnsPlanParam(''), null);
});

test('merge: explicit ids first, plan ids appended, duplicates collapse', () => {
    assert.deepEqual(mergeProposalIds(['9', '701'], [701, 708, 9]), ['9', '701', '708']);
    assert.deepEqual(mergeProposalIds(null, [1, 2]), ['1', '2']);
    assert.deepEqual(mergeProposalIds(['5'], null), ['5']);
    assert.deepEqual(mergeProposalIds(null, null), []);
    // Blank entries never survive.
    assert.deepEqual(mergeProposalIds(['', ' '], ['3']), ['3']);
});
