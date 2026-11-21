// A standing guard against the most expensive bug family in this codebase:
// a missing measurement that arithmetic turns into a real, plausible number.
//
// `Number(null)` is 0 and `Number.isFinite(0)` is true, so the guard that looks
// exactly right —
//
//     Number.isFinite(Number(x)) ? Number(x) : fallback
//
// — accepts a MISSING value as a valid reading of zero and never takes the
// fallback. On 2026-07-27 that one coercion in RailFormationModel._baseY turned
// "no terrain sample here" into "the ground is at sea level", so
// `maxFillM = railY - 0` reported the rail's whole height above sea level as
// fill. Split sits ~30 m ASL against a 3.5 m viaduct threshold, so every sample
// over a hole in the DEM classified as viaduct and the gap-bridging welded them
// into one floating deck on pillars. The same coercion sat in road-formation's
// _baseY (defeating fallbacks that were already written correctly), in
// photo-civil-works' DGU cover, and in the grade solver's terrainAslM/elevAslM.
//
// Use finiteOrNull() from core/math.js instead — it tests `== null` BEFORE the
// cast. This file makes the elevation-critical modules stay clean, and stops the
// rest of the tree from getting worse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finiteOrNull } from '../core/math.js';

const WEBSITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_ROOTS = ['station-3d', 'shared'];
// The exact shape that swallows null. Deliberately narrow: this is not a style
// rule, it is one specific coercion with one specific failure mode.
const TRAP = /Number\.isFinite\(Number\(/g;

// WHAT THIS FILE DOES NOT CATCH, and why that is deliberate.
//
// The original _baseY used the two-line form, which this pattern misses:
//     const value = Number(sample(x, z));
//     return Number.isFinite(value) ? value : 0;
// Broadening to `Number.isFinite(x) ? x : 0` was tried and reverted: it matches
// 131 sites, nearly all of them legitimate (a counter, an offset, a length —
// places where zero genuinely IS the default). A guard that cannot tell a height
// from a count produces noise, and a noisy guard gets deleted.
//
// So this file is the SECOND line of defence — a ratchet on one specific
// coercion. The FIRST is behavioural, and those are the tests that actually
// prove the bug is gone:
//   * rail-formation.test.mjs — "a hole in the terrain does not grow a viaduct
//     out of nothing" (verified red when _baseY returns 0)
//   * road-formation.test.mjs — "an unknown ground sample falls back to the
//     road, not to sea level" (verified red when the coercion returns)
// Do not let this scanner stand in for those. When you add a new terrain or
// elevation sampler, write the behavioural test.

// Where an absent value would be a HEIGHT, and zero is therefore a plausible,
// wrong, and invisible answer. These must stay at zero occurrences forever.
const ELEVATION_CRITICAL = [
    'station-3d/core/rail-formation.js',
    'station-3d/core/road-formation.js',
    'station-3d/core/terrain-grid.js',
    'station-3d/core/photo-civil-works.js',
];

// Everything else, frozen. This number may only ever go DOWN. It is not a
// blessing of the remaining sites — it is a ratchet, so the next one has to be
// deliberate rather than accidental.
// (Measured by this scanner, not by grep -c — grep counts LINES, and several of
// these sites sit two to a line.)
const REST_OF_TREE_BASELINE = 66;
// 74 -> 66 at the extraction: the planner (planner-grade/, 10 sites) stayed in zagreb-isochrone,
// which keeps its own ratchet for it; the engine's own count is unchanged since.
// 86 -> 85 on 2026-08-06 by fixing world/planner-elevation.js: a station with no
// elevM was cast through Number(), so a MISSING station height read as a measured
// 0 m and the -PLANNER_LEVEL_HEIGHT_M fallback beside it could never run.
// 85 -> 83 on 2026-08-10 by fixing world/track-corridors.js buildLowElevatedRampVolumes:
// a coordinate with no third element read as a track lying exactly on the ground,
// so a 2D line grew a low-clearance ramp volume out of nothing. Its sibling fault —
// an ABSOLUTE sea-level height read as a height above the ground — is what cut every
// building over the Sibenik bore to the sky; see track-corridor-levels.test.mjs.

function sourceFiles() {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith('.js')) found.push(full);
        }
    };
    for (const root of SCAN_ROOTS) {
        const full = join(WEBSITE_ROOT, root);
        try { walk(full); } catch (_error) { /* optional tree */ }
    }
    return found;
}

// Comments explaining the trap must not count as the trap — this very rule is
// documented in the files it guards, and a scanner that cannot tell code from
// prose would forbid describing the bug it exists to prevent.
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function trapCount(text) {
    return (stripComments(text).match(TRAP) || []).length;
}

test('finiteOrNull refuses the values Number() would silently make zero', () => {
    // Each of these is finite-looking after a bare Number() cast.
    assert.equal(finiteOrNull(null), null, 'Number(null) is 0 — this is the whole bug');
    assert.equal(finiteOrNull(undefined), null);
    assert.equal(finiteOrNull(''), null, "Number('') is 0 too");
    assert.equal(finiteOrNull([]), null, 'Number([]) is 0');
    assert.equal(finiteOrNull(NaN), null);
    assert.equal(finiteOrNull(Infinity), null);
    // And it still passes real readings through untouched, including a true zero.
    assert.equal(finiteOrNull(0), 0, 'a MEASURED sea-level reading is still valid');
    assert.equal(finiteOrNull(-31.5), -31.5);
    assert.equal(finiteOrNull('42.5'), 42.5);
});

test('the naive guard really does accept null — this is why the rule exists', () => {
    // If this ever fails, JavaScript changed and the rest of this file is moot.
    assert.equal(Number(null), 0);
    assert.equal(Number.isFinite(Number(null)), true,
        'Number.isFinite(Number(null)) is TRUE: the guard that looks right lets null through');
});

test('elevation-critical modules never coerce a missing height to zero', () => {
    const offenders = [];
    for (const path of ELEVATION_CRITICAL) {
        let text;
        try { text = readFileSync(join(WEBSITE_ROOT, path), 'utf8'); }
        catch (_error) { continue; }   // file moved: the rest of the guard still applies
        const count = trapCount(text);
        if (count > 0) offenders.push(`${path} (${count})`);
    }
    assert.deepEqual(offenders, [],
        'Number.isFinite(Number(x)) accepts null as 0. In these modules that is a '
        + 'height, so it reads as sea level. Use finiteOrNull(x) from core/math.js.');
});

test('the rest of the tree does not get worse', () => {
    const critical = new Set(ELEVATION_CRITICAL);
    let total = 0;
    const byFile = [];
    for (const file of sourceFiles()) {
        const path = relative(WEBSITE_ROOT, file);
        if (critical.has(path)) continue;
        const count = trapCount(readFileSync(file, 'utf8'));
        if (count > 0) { total += count; byFile.push(`${path}:${count}`); }
    }
    assert.ok(total <= REST_OF_TREE_BASELINE,
        `Number.isFinite(Number(...)) rose from ${REST_OF_TREE_BASELINE} to ${total}. `
        + 'Use finiteOrNull() from core/math.js for anything that can be absent.\n'
        + byFile.join('\n'));
    // Ratchet: when the count drops, lower the baseline in the same commit so it
    // can never drift back up.
    assert.equal(total, REST_OF_TREE_BASELINE,
        `Down to ${total} from ${REST_OF_TREE_BASELINE} — lower REST_OF_TREE_BASELINE `
        + 'to lock the improvement in.');
});
