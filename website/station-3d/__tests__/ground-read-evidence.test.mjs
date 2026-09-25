// Read evidence and change sets: recording scope, compact form, and the
// dependency tests road receivers use to skip unchanged recompiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createGroundChangeSet, createGroundReadEvidence, freezeGroundReadEvidence, groundBoundsDependOn,
    groundReadEvidenceDependsOn, GROUND_READ_UNBOUNDED, mergeGroundChangeSets, recordGroundReadDisc,
    recordGroundReadId, recordGroundReadKey, withGroundReadEvidence,
} from '../core/ground-read-evidence.js';

const box = (minX, minZ, maxX, maxZ) => ({ minX, minZ, maxX, maxZ });

test('reads are recorded only inside a scope, and nested scopes restore the outer one', () => {
    recordGroundReadDisc(0, 0, 5);
    const outer = createGroundReadEvidence(), inner = createGroundReadEvidence();
    withGroundReadEvidence(outer, () => {
        recordGroundReadId(7);
        withGroundReadEvidence(inner, () => recordGroundReadKey('k'));
        recordGroundReadDisc(100, 100, 3);
    });
    assert.deepEqual([...outer.ids], ['7']);
    assert.equal(outer.cells.size, 1);
    assert.deepEqual([...inner.keys], ['k']);
    assert.equal(inner.cells.size, 0);
    // A thrown compile step must not leave its scope recording.
    assert.throws(() => withGroundReadEvidence(inner, () => { throw new Error('step'); }));
    recordGroundReadId(8);
    assert.equal(inner.ids.has('8'), false);
});

test('a disc depends on a changed box within its reach, and nothing else', () => {
    const evidence = createGroundReadEvidence();
    withGroundReadEvidence(evidence, () => {
        recordGroundReadDisc(10, 10, 0);
        recordGroundReadDisc(12, 11, 6); // same 8 m cell: the larger reach is kept
    });
    const frozen = freezeGroundReadEvidence(evidence);
    assert.equal(frozen.cells.length, 3);
    // Cell [8, 16) grown by 6 m reaches x = 22, not x = 23.
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ boxes: [box(22, 10, 30, 12)] })), true);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ boxes: [box(22.5, 10, 30, 12)] })), false);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ boxes: [box(-500, -500, -400, -400)] })), false);
    // Negative coordinates quantise to the correct cell.
    const west = createGroundReadEvidence();
    withGroundReadEvidence(west, () => recordGroundReadDisc(-3, -3, 0));
    assert.equal(groundReadEvidenceDependsOn(freezeGroundReadEvidence(west), createGroundChangeSet({ boxes: [box(-7, -7, -6, -6)] })), true);
    assert.equal(groundReadEvidenceDependsOn(freezeGroundReadEvidence(west), createGroundChangeSet({ boxes: [box(1, 1, 2, 2)] })), false);
});

test('ids and keys depend wherever the change lies; unbounded and full depend always', () => {
    const evidence = createGroundReadEvidence();
    withGroundReadEvidence(evidence, () => { recordGroundReadId('42'); recordGroundReadKey('cutouts'); });
    const frozen = freezeGroundReadEvidence(evidence);
    const far = box(1e4, 1e4, 1e4 + 1, 1e4 + 1);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ ids: [42], boxes: [far] })), true);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ keys: ['cutouts'], boxes: [far] })), true);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ ids: [43], boxes: [far] })), false);
    const everything = createGroundReadEvidence();
    withGroundReadEvidence(everything, () => recordGroundReadKey(GROUND_READ_UNBOUNDED));
    assert.equal(groundReadEvidenceDependsOn(freezeGroundReadEvidence(everything), createGroundChangeSet({ boxes: [far] })), true);
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet({ full: true })), true);
    assert.equal(groundReadEvidenceDependsOn(null, createGroundChangeSet({ boxes: [far] })), true, 'no evidence is not proof');
    assert.equal(groundReadEvidenceDependsOn(frozen, null), true, 'no change set is not proof');
    assert.equal(groundReadEvidenceDependsOn(frozen, createGroundChangeSet()), false);
});

test('invalid or unbounded change regions make the set full rather than being dropped', () => {
    assert.equal(createGroundChangeSet({ boxes: [box(0, 0, NaN, 1)] }).full, true);
    assert.equal(createGroundChangeSet({ boxes: [box(-1e6, -1e6, 1e6, 1e6)] }).full, true);
    const merged = mergeGroundChangeSets([createGroundChangeSet({ ids: [1], boxes: [box(0, 0, 1, 1)] }),
        createGroundChangeSet({ keys: ['k'], boxes: [box(5, 5, 6, 6)] })]);
    assert.deepEqual([[...merged.ids], [...merged.keys], merged.boxes.length, merged.full], [['1'], ['k'], 2, false]);
});

test('receivers without evidence fall back to their padded source boxes', () => {
    const changes = createGroundChangeSet({ ids: [9], boxes: [box(100, 100, 110, 110)] });
    assert.equal(groundBoundsDependOn([box(0, 0, 50, 50)], changes), false);
    assert.equal(groundBoundsDependOn([box(0, 0, 100, 100)], changes), true);
    assert.equal(groundBoundsDependOn([box(0, 0, 1, 1)], createGroundChangeSet({ full: true })), true);
});
