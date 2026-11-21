// A forced road rebuild must survive the batch that scheduled it: a flush can
// skip the tile (centreline tile not streamed yet) and a later force-less
// refresh retains published geometry verbatim. Losing the force set froze
// buffered footway surfaces at coarse-terrain heights — the floating sheet
// that read as a see-through slit across the Branimirova rail embankment.
// Run: npm run test:unit (in website/station-3d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForcedRebuildLedger } from '../core/road-forced-rebuild-ledger.js';

test('a stashed obligation reaches the next build of that tile', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', ['1133544550', 313057309]);

    // The later refresh arrives with no force set of its own — exactly the
    // call that used to retain the stale mesh.
    const { forceRebuildOsmIds, consumed } = ledger.consume('-1_0', null);
    assert.deepEqual([...forceRebuildOsmIds].sort(), ['1133544550', '313057309']);
    assert.deepEqual([...consumed].sort(), ['1133544550', '313057309']);
});

test('consume unions the caller ids without dropping either side', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('0_0', ['11']);
    const { forceRebuildOsmIds } = ledger.consume('0_0', new Set(['22']));
    assert.deepEqual([...forceRebuildOsmIds].sort(), ['11', '22']);
});

test('a cancelled build leaves the obligation for its successor', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', ['11']);

    // First build consumes but is superseded before publishing: no
    // notePublished call. The obligation must still be there.
    ledger.consume('-1_0', null);
    const second = ledger.consume('-1_0', null);
    assert.deepEqual([...second.forceRebuildOsmIds], ['11']);
});

test('publishing settles exactly the consumed snapshot', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', ['11']);
    const { consumed } = ledger.consume('-1_0', null);

    // A new revision lands while the build is in flight. Publishing the old
    // build must not swallow the newer obligation.
    ledger.stash('-1_0', ['22']);
    ledger.notePublished('-1_0', consumed);

    const next = ledger.consume('-1_0', null);
    assert.deepEqual([...next.forceRebuildOsmIds], ['22']);
});

test('a settled tile leaves no residue', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', ['11']);
    const { consumed } = ledger.consume('-1_0', null);
    ledger.notePublished('-1_0', consumed);
    assert.equal(ledger.size, 0);
    const empty = ledger.consume('-1_0', null);
    assert.equal(empty.forceRebuildOsmIds, null);
    assert.equal(empty.consumed, null);
});

test('tiles are independent and keys coerce to strings', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', [11]);
    assert.equal(ledger.consume('0_0', null).forceRebuildOsmIds, null);
    // Numeric/string tile keys and osm ids must meet in one namespace: the
    // callers mix them (tile keys parsed from strings, osm ids from features).
    const { forceRebuildOsmIds } = ledger.consume('-1_0', null);
    assert.deepEqual([...forceRebuildOsmIds], ['11']);
});

test('notePublished without a consumed snapshot is a no-op', () => {
    const ledger = createForcedRebuildLedger();
    ledger.stash('-1_0', ['11']);
    // A build that had no pending ids publishes: nothing to settle.
    ledger.notePublished('-1_0', null);
    assert.equal(ledger.size, 1);
});
