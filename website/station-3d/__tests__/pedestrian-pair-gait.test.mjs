// A paired walker is ONE entity holding two figures, and every figure used to be
// animated from the group's single `stride`. Same position offset, same heading,
// same leg forward on the same frame, 0.72 m apart across figures ~0.47 m wide:
// the pair fused into a single doubled silhouette instead of reading as two
// people walking together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    PAIR_SPACING_M,
    sideBySideOffsets,
    walkPhaseOffsets,
} from '../core/pedestrian-motion.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// How far apart two phases are around the gait cycle, which wraps at 2π.
function cyclicSeparation(a, b) {
    const raw = Math.abs(a - b) % (Math.PI * 2);
    return Math.min(raw, Math.PI * 2 - raw);
}

test('a lone walker has no offset and no phase shift', () => {
    assert.deepEqual(sideBySideOffsets(1), [0]);
    assert.deepEqual(walkPhaseOffsets(1), [0]);
    // Junk sizes collapse to a single figure rather than producing NaN.
    for (const bad of [0, -3, Number.NaN, null, undefined, 'two']) {
        assert.deepEqual(walkPhaseOffsets(bad), [0]);
        assert.deepEqual(sideBySideOffsets(bad), [0]);
    }
});

test('a pair walks far enough apart to read as two people', () => {
    const [left, right] = sideBySideOffsets(2);
    assert.equal(right - left, PAIR_SPACING_M);
    // A figure is ~0.47 m wide across the arms; the gap between them has to be
    // visible from a distance, which 0.72 m was not.
    assert.ok(PAIR_SPACING_M - 0.47 > 0.3, `gap is only ${PAIR_SPACING_M - 0.47} m`);
    // Still centred on the walker, so the group's own position is unchanged.
    assert.equal(left + right, 0);
});

test('members of a pair can never share a gait phase, whatever the dice say', () => {
    // The bound has to hold for every possible random draw, not just a lucky one.
    for (const value of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
        const [a, b] = walkPhaseOffsets(2, () => value);
        assert.ok(
            cyclicSeparation(a, b) > 1.5,
            `phases ${a} and ${b} are only ${cyclicSeparation(a, b)} rad apart`,
        );
    }
    // Mixed draws, including the worst case where the two jitters converge.
    const draws = [1, 0];
    const [a, b] = walkPhaseOffsets(2, () => draws.shift());
    assert.ok(cyclicSeparation(a, b) > 1.5, `${cyclicSeparation(a, b)} rad`);
});

test('a bad random source degrades to a fixed spread, never to NaN', () => {
    for (const source of [() => Number.NaN, () => undefined, () => 'x', () => 5, () => -5]) {
        const phases = walkPhaseOffsets(2, source);
        assert.ok(phases.every(Number.isFinite), JSON.stringify(phases));
        assert.ok(cyclicSeparation(phases[0], phases[1]) > 1.5);
    }
});

test('larger groups spread around the whole cycle', () => {
    const phases = walkPhaseOffsets(4, () => 0.5);
    assert.equal(phases.length, 4);
    for (let i = 0; i < phases.length; i += 1) {
        for (let j = i + 1; j < phases.length; j += 1) {
            assert.ok(
                cyclicSeparation(phases[i], phases[j]) > 1.0,
                `${i} and ${j} are ${cyclicSeparation(phases[i], phases[j])} rad apart`,
            );
        }
    }
});

// The phase is only worth assigning if the animation actually reads it back.
test('each figure is animated from its own phase, not the group stride', () => {
    const source = read('../world/pedestrians.js');
    assert.match(source, /person\.userData\.walkPhaseOffset = phases\[index\] \|\| 0;/);
    assert.match(
        source,
        /animatePersonWalk\(\s*\n\s*person,\s*\n\s*walker\.stride \+ \(person\.userData\.walkPhaseOffset \|\| 0\),/,
    );
    assert.match(
        source,
        /walker\.mesh\.visible = true;[\s\S]*applyWalkerGait\(walker, 0\);[\s\S]*if \(walker\.targetKind === 'wait'\)/,
        'every visible non-moving return must leave limbs in a neutral stance',
    );
    assert.doesNotMatch(
        source,
        /animatePersonWalk\(person, walker\.stride,/,
        'the shared-stride lockstep is back',
    );
});
