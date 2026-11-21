// The whole-city lane-marking rebuild is time-sliced across frames: the drape
// (81% of the cost, and the part that re-runs when the road formation revises
// under the paint) is spread by beginRebuild/stepRebuild instead of paid in one
// ~70ms hook stall while driving. Text-level, because lane-markings.js imports
// THREE and cannot run headlessly — like roads-aggregate-contract, this pins the
// wiring so a refactor can't silently detach the budget, the no-blink swap, or
// route a driving-frequent trigger back onto the synchronous path. Update the
// test WITH the code if a shape changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
    fileURLToPath(new URL('../world/lane-markings.js', import.meta.url)),
    'utf8',
);

test('the cross-feature solve and drape are time-sliced across frames', () => {
    assert.match(SRC, /const LANE_BUILD_FRAME_BUDGET_MS = \d+/,
        'a per-frame build budget exists');
    assert.match(SRC, /function stepRebuild\(frameBudgetMs\)/,
        'stepRebuild takes a budget');
    assert.match(SRC, /buildLaneMarkingPathsResumable\(paintFeatures, toLocalPoint\)/,
        'the global topology solve is opened as a cooperative iterator');
    assert.match(SRC, /const outcome = activeBuild\.pathBuild\.next\(\)/,
        'the path iterator advances inside the budgeted frame step');
    assert.match(SRC, /recordLayerFrameMs\('laneMk:paths'/,
        'path slices remain visible in performance diagnostics');
    // The slice breaks on the clock and stashes its cursor for the next frame.
    assert.match(SRC, /performance\.now\(\) - startedMs > frameBudgetMs/,
        'the drape loop breaks when the frame budget is spent');
    assert.match(SRC, /activeBuild\.entryIndex/,
        'progress is a resumable cursor into the pending entries');
    assert.match(SRC, /const LANE_BUILD_MAX_SEGMENTS_PER_JOB = 1/,
        'a cache-miss job cannot run several expensive formation-drape segments');
    assert.match(SRC, /chunkStripPath\(path\.points, \{\s*maxSegments: LANE_BUILD_MAX_SEGMENTS_PER_JOB,/,
        'the one-segment bound is passed into the chunker');
    assert.doesNotMatch(SRC, /recordLayerFrameMs\('laneMk:strips', activeBuild\.drapeMs\)/,
        'the overlay records this frame slice, not cumulative work from earlier frames');
});

test('the old mesh is only swapped once the new geometry is assembled', () => {
    // disposeAggregateMesh must come AFTER assembleStripGeometry in stepRebuild,
    // or a multi-frame build blinks the markings off while it works.
    const step = SRC.slice(SRC.indexOf('function stepRebuild'), SRC.indexOf('function rebuildActiveLaneMarkingsSync'));
    const assembleAt = step.indexOf('assembleStripGeometrySteps(cached)');
    const disposeAt = step.indexOf('disposeAggregateMesh()');
    assert.ok(assembleAt >= 0 && disposeAt >= 0, 'both steps present in stepRebuild');
    assert.ok(assembleAt < disposeAt,
        'assemble the new geometry before disposing the old mesh (no blink)');
});

test('both driving-frequent triggers route through the resumable build', () => {
    // Formation revision requests a spread rebuild instead of forcing a sync one.
    assert.match(SRC, /formationRebuildRequested = true/,
        'a formation revision only REQUESTS a rebuild');
    // onFrame finishes an in-flight slice before starting another, and starts
    // new builds from either trigger through beginRebuild + a budgeted step.
    assert.match(SRC, /if \(activeBuild && !roadFormationPending\) \{\s*stepRebuild\(LANE_BUILD_FRAME_BUDGET_MS\);/,
        'an in-flight build is stepped before any new one starts');
    assert.match(SRC, /formationRebuildRequested\) \{[\s\S]*?beginRebuild\(\);\s*stepRebuild\(LANE_BUILD_FRAME_BUDGET_MS\)/,
        'the formation trigger starts a budgeted resumable build');
    assert.match(SRC, /shouldRunOnSettle\(rebuildGate, tileRevision\)\) \{\s*beginRebuild\(\);\s*stepRebuild\(LANE_BUILD_FRAME_BUDGET_MS\)/,
        'the tile-settle trigger starts a budgeted resumable build');
});

test('draping waits for the authoritative road-formation generation', () => {
    assert.match(SRC, /const roadFormationPending = roadFormationModel\?\.hasPendingBuild\?\.\(\) === true/,
        'the derived paint layer observes whether road indexes are still dirty');
    assert.match(SRC, /if \(activeBuild && !roadFormationPending\) \{\s*stepRebuild/,
        'an in-flight drape pauses instead of forcing a synchronous road build');
    assert.match(SRC, /!activeBuild && !roadFormationPending && formationRebuildRequested/,
        'a requested rebuild starts only against an atomically published formation');
    assert.match(SRC, /!activeBuild && !roadFormationPending\s*&& group && shouldRunOnSettle/,
        'tile-settle rebuilds obey the same authority gate');
});

test('tile revisions ignore empty and identical redeliveries before rebuild fan-out', () => {
    assert.match(SRC, /createLaneMarkingTileRegistry = \(\) => createTileFeatureRegistry/,
        'lane tiles use the content-aware incremental registry');
    assert.match(SRC, /if \(tileFeatures\.setTile\(tileKey, features \|\| \[\]\)\) tileRevision \+= 1/,
        'a delivery advances the settle revision only when registry content changes');
    assert.match(SRC, /if \(tileFeatures\.removeTile\(tileKey\)\) tileRevision \+= 1/,
        'an eviction advances the settle revision only when unique content changes');
});

test('terrain-only rebuilds reuse the immutable OSM path topology', () => {
    assert.match(SRC,
        /const verticalRevision = finiteOrNull\(roadVerticalAlignmentModel\?\.revision\);[\s\S]*return `\$\{tileRevision\}\|\$\{verticalRevision \?\? -1\}`\s*\+ `\|\$\{proposalMaskRevision\}`/,
        'the topology key changes only with OSM, authored alignment, or proposal ownership');
    assert.match(SRC, /if \(solvedPathTopology\?\.key === topologyKey\) \{/,
        'a formation-only rebuild has an explicit immutable-topology reuse path');
    assert.match(SRC,
        /entries:\s*solvedPathTopology\.entries[\s\S]*cachePassStarted:\s*false/,
        'reused topology still owes a fresh, spatially invalidated drape pass');
    assert.match(SRC,
        /stripCache\.invalidateIntersectingSteps\([\s\S]*recordLayerFrameMs\('laneMk:invalidate'/,
        'large bounded invalidations are consumed as measurable cooperative slices');
    assert.match(SRC,
        /if \(!stepFormationInvalidation\(activeBuild, startedMs, frameBudgetMs\)\) return;/,
        'strip draping cannot start until bounded invalidation has finished');
    assert.match(SRC,
        /solvedPathTopology = \{\s*key: activeBuild\.topologyKey,\s*entries: outcome\.value,/,
        'a completed global solve is retained for later terrain revisions');
    assert.match(SRC,
        /proposalMaskRevision \+= 1;\s*rebuildActiveLaneMarkingsSync\(\)/,
        'an interactive proposal edit cannot reuse paths from the previous ownership mask');
});

test('the user proposal mask still rebuilds synchronously in one frame', () => {
    // A user edit must show immediately: Infinity budget finishes in one call.
    assert.match(SRC, /function rebuildActiveLaneMarkingsSync\(\)\s*\{\s*beginRebuild\(\);\s*stepRebuild\(Infinity\);/,
        'the sync path drives a full build with an infinite budget');
    assert.match(SRC, /export function rebuildLaneMarkingsForProposalMask[\s\S]*?rebuildActiveLaneMarkingsSync\(\)/,
        'the proposal-mask export uses the synchronous path');
});
