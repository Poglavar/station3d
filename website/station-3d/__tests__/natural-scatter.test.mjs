// Verifies stable procedural ground-detail placement across moving windows.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLimestoneOutcropPieces,
    buildNaturalScatterCandidates,
    naturalGroundMaterialStyle,
} from '../core/natural-scatter.js';

test('natural-ground materials cannot fall back to black instance colours', () => {
    assert.deepEqual(naturalGroundMaterialStyle('limestone'), {
        colorHex: 0xe6e3da,
        emissiveHex: 0x77746b,
        emissiveIntensity: 0.20,
        roughness: 0.98,
    });
    assert.equal(naturalGroundMaterialStyle('shrub', 'near').colorHex, 0x647b3e);
    assert.equal(naturalGroundMaterialStyle('shrub', 'far').colorHex, 0x536b35);
});

test('natural scatter is deterministic for one render window', () => {
    const first = buildNaturalScatterCandidates(120, -80, { radiusM: 240, seed: 42 });
    const second = buildNaturalScatterCandidates(120, -80, { radiusM: 240, seed: 42 });
    const different = buildNaturalScatterCandidates(120, -80, { radiusM: 240, seed: 43 });
    assert.ok(first.length > 30);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, different);
    assert.ok(first.every((candidate) => candidate.distanceM <= 240));
    assert.ok(first.some((candidate) => candidate.kind === 'shrub'));
    assert.ok(first.some((candidate) => candidate.kind === 'outcrop'));
    assert.ok(first.every((candidate) => candidate.kind !== 'rock'));
});

test('overlapping moving windows preserve the same world-cell candidate', () => {
    const first = buildNaturalScatterCandidates(0, 0, { radiusM: 300, seed: 91 });
    const moved = buildNaturalScatterCandidates(90, 40, { radiusM: 300, seed: 91 });
    const movedById = new Map(moved.map((candidate) => [candidate.id, candidate]));
    const overlap = first.filter((candidate) => movedById.has(candidate.id));
    assert.ok(overlap.length > 20);
    for (const candidate of overlap) {
        const same = movedById.get(candidate.id);
        assert.equal(same.x, candidate.x);
        assert.equal(same.z, candidate.z);
        assert.equal(same.kind, candidate.kind);
        assert.equal(same.scale, candidate.scale);
        assert.equal(same.rotationY, candidate.rotationY);
    }
});

test('limestone outcrops are deterministic embedded clusters, not standalone rocks', () => {
    const candidate = buildNaturalScatterCandidates(0, 0, { radiusM: 220, seed: 71 })
        .find((entry) => entry.kind === 'outcrop');
    assert.ok(candidate);
    const first = buildLimestoneOutcropPieces(candidate);
    const second = buildLimestoneOutcropPieces(candidate);
    assert.deepEqual(first, second);
    const boulders = first.filter((piece) => piece.pieceKind === 'boulder');
    const stones = first.filter((piece) => piece.pieceKind === 'stone');
    assert.ok(boulders.length >= 2);
    assert.ok(stones.length >= 6);
    assert.ok(first.every((piece) => piece.embedRatio >= 0.48));
    assert.ok(first.every((piece) => (
        piece.scaleY <= Math.min(piece.scaleX, piece.scaleZ) * 0.45
    )));
    assert.ok(boulders.every((piece) => (
        Math.hypot(piece.x - candidate.x, piece.z - candidate.z) <= 0.9
    )));
    assert.ok(first.every((piece) => Math.hypot(piece.x - candidate.x, piece.z - candidate.z) <= 2.6));
});
