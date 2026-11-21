// The in-flight rail formation build survives terrain revisions that cannot
// have reached it, and the streamed refresh waits for an unconsumed terrain
// flag — the two halves of the fix for the Zagreb livelock where the streamed
// build was dropped and re-created every frame and the main line never drew.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    RAIL_BUILD_DISPOSITION,
    RAIL_VISUAL_REFRESH_DISPOSITION,
    pendingRailFormationBuildDisposition,
    pendingRailVisualRefreshDisposition,
    railFeatureChords,
    streamedRailRefreshAllowed,
} from '../core/rail-formation-build-policy.js';
import { boundsIntersectAnyRailSegment } from '../core/rail-render-cells.js';

const { DROP_TERRAIN, CONSUME_TERRAIN, STEP } = RAIL_BUILD_DISPOSITION;

test('an in-flight build only loses its progress to a terrain change that can have reached it', () => {
    assert.equal(pendingRailFormationBuildDisposition({}), STEP);
    assert.equal(pendingRailFormationBuildDisposition({ terrainRevisionDirty: true }), CONSUME_TERRAIN);
    assert.equal(pendingRailFormationBuildDisposition({ terrainRevisionDirty: true, terrainTouchesRail: true }), DROP_TERRAIN);
    assert.equal(pendingRailFormationBuildDisposition({ terrainRevisionDirty: true, terrainFullRefresh: true }), DROP_TERRAIN);
    // A superseded streamed input set is never a reason to drop: the build
    // publishes as a snapshot and the refresh catches up.
    assert.equal(Object.values(RAIL_BUILD_DISPOSITION).includes('drop:stale'), false);
    // A change that touched rail geometry while the flag is already consumed
    // is a later frame's problem, not a reason to discard now.
    assert.equal(pendingRailFormationBuildDisposition({ terrainTouchesRail: true }), STEP);
});

test('the streamed refresh waits for an unconsumed terrain revision', () => {
    assert.equal(streamedRailRefreshAllowed({ streamedRailDirty: true }), true);
    assert.equal(streamedRailRefreshAllowed({ streamedRailDirty: true, terrainRevisionDirty: true }), false);
    assert.equal(streamedRailRefreshAllowed({ streamedRailDirty: false }), false);
    assert.equal(streamedRailRefreshAllowed(), false);
});

// A one-terrain-event frame loop under both rules. The old rule discarded the
// build on any dirty terrain and let the streamed refresh re-create it on the
// same frame, so the flag was never consumed; the new rule consumes it and the
// build finishes.
function simulate({ consumeUnrelatedTerrain, gateStreamedRefresh, stepsToFinish = 40, frames = 500 }) {
    let terrainDirty = false;
    let build = null;
    let created = 0;
    let published = 0;
    for (let frame = 0; frame < frames; frame += 1) {
        if (frame === 5) terrainDirty = true;
        if (build) {
            const disposition = consumeUnrelatedTerrain
                ? pendingRailFormationBuildDisposition({ terrainRevisionDirty: terrainDirty, terrainTouchesRail: false })
                : (terrainDirty ? DROP_TERRAIN : STEP);
            if (disposition === CONSUME_TERRAIN) terrainDirty = false;
            if (disposition === DROP_TERRAIN) {
                build = null;
            } else {
                build.steps += 1;
                if (build.steps >= stepsToFinish) { published += 1; build = null; }
                continue;
            }
        }
        const refreshAllowed = gateStreamedRefresh
            ? streamedRailRefreshAllowed({ streamedRailDirty: published === 0, terrainRevisionDirty: terrainDirty })
            : published === 0;
        if (refreshAllowed) {
            created += 1;
            build = { steps: 0 };
            continue;
        }
        // The terrain consumer that follows the streamed branch in the frame.
        if (terrainDirty) terrainDirty = false;
    }
    return { created, published };
}

test('one unrelated terrain revision no longer livelocks the streamed formation build', () => {
    const before = simulate({ consumeUnrelatedTerrain: false, gateStreamedRefresh: false });
    assert.equal(before.published, 0, 'the old ordering never publishes');
    assert.ok(before.created > 400, `the old ordering re-created the build every frame (${before.created})`);
    const after = simulate({ consumeUnrelatedTerrain: true, gateStreamedRefresh: true });
    assert.equal(after.published, 1);
    assert.equal(after.created, 1, 'the build kept its progress through the unrelated revision');
    // The gate alone also ends the livelock, at the cost of one restart.
    const gateOnly = simulate({ consumeUnrelatedTerrain: false, gateStreamedRefresh: true });
    assert.equal(gateOnly.published, 1);
    assert.equal(gateOnly.created, 2);
});

test('unpublished feature chords are tested against the terrain change rects', () => {
    const toLocal = (lon, lat) => ({ x: Math.round((lon - 16) * 1000), z: -Math.round((lat - 45) * 1000) });
    const features = [
        { geometry: { type: 'LineString', coordinates: [[16.0, 45.0], [16.1, 45.0], [16.2, 45.0]] } },
        { geometry: { type: 'MultiLineString', coordinates: [[[16.5, 45.5], [16.6, 45.5]], [[17, 46]]] } },
        { geometry: { type: 'Point', coordinates: [16, 45] } },
        { geometry: { type: 'LineString', coordinates: [[16.3, 45.3], ['x', 45.3], [16.4, 45.3]] } },
        null,
    ];
    const chords = railFeatureChords(features, toLocal);
    assert.deepEqual(chords, [
        { x1: 0, z1: -0, x2: 100, z2: -0 },
        { x1: 100, z1: -0, x2: 200, z2: -0 },
        { x1: 500, z1: -500, x2: 600, z2: -500 },
    ]);
    assert.equal(boundsIntersectAnyRailSegment(chords, [{ minX: 140, maxX: 160, minZ: -10, maxZ: 10 }]), true);
    assert.equal(boundsIntersectAnyRailSegment(chords, [{ minX: 300, maxX: 400, minZ: -10, maxZ: 10 }]), false);
    assert.deepEqual(railFeatureChords(features, null), []);
});

test('rails.js applies the policy where the livelock lived', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    const pendingBlock = source.slice(source.indexOf('if (pendingRailFormationBuild) {'), source.indexOf('publishRailFormation(build.model, build.features, {'));
    assert.match(pendingBlock, /const disposition = pendingRailFormationBuildDisposition\(\{/);
    assert.match(pendingBlock, /terrainTouchesRail: terrainRevisionDirty\s*&& !terrainDirtyFullRefresh\s*&& terrainBoundsTouchPendingRailBuild\(terrainDirtyBounds\)/);
    assert.ok(pendingBlock.indexOf('RAIL_BUILD_DISPOSITION.CONSUME_TERRAIN') < pendingBlock.indexOf('RAIL_BUILD_DISPOSITION.DROP_TERRAIN'), 'an unrelated revision is consumed before the drop is considered');
    assert.match(pendingBlock, /terrainDirtyBounds = \[\];\s*terrainRevisionDirty = false;/);
    assert.match(source, /if \(streamedRailRefreshAllowed\(\{ streamedRailDirty, terrainRevisionDirty \}\)\) \{/, 'the streamed refresh is gated on the terrain flag');
    assert.doesNotMatch(source, /if \(streamedRailDirty\) \{/, 'no ungated streamed refresh remains');
    assert.match(source, /function terrainBoundsTouchPendingRailBuild\(changeBounds\) \{\s*if \(railTerrainChangeImpact\(changeBounds\)\.any\) return true;/);
});

test('rails.js finishes a superseded build, keeps the model moving under the road gate, and budgets its slices', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    const frame = source.slice(source.indexOf('onFrame(pose, local) {'), source.indexOf('    endSession() {'));
    assert.doesNotMatch(frame, /inputRevision !== streamedRailInputRevision[\s\S]{0,400}pendingRailFormationBuild = null/,
        'a newer tile delivery no longer discards the in-flight formation build');
    assert.match(frame, /if \(lastRoadFormation\?\.hasPendingBuild\?\.\(\) === true\) \{\s*stepPendingRailFormationModel\(\);\s*return;\s*\}/,
        'the road-formation gate still advances the pure model build');
    assert.match(frame, /if \(!stepPendingRailFormationModel\(\)\) return;/);
    const helper = source.slice(source.indexOf('function stepPendingRailFormationModel()'), source.indexOf('export const railsLayer = {'));
    assert.match(helper, /do \{[\s\S]*stepPendingBuild\?\.\(\)[\s\S]*\} while \(!outcome\.done\s*&& railStreamNowMs\(\) - stepStarted < RAIL_FORMATION_MODEL_STEP_BUDGET_MS\)/,
        'several bounded slices run per frame, within a time budget');
    assert.match(source, /^const RAIL_FORMATION_MODEL_STEP_BUDGET_MS = 3;$/m);
    // A rendered snapshot counts as rendered even when a newer tile has arrived,
    // so the refresh policy coalesces the catch-up instead of chasing tiles.
    const visual = frame.slice(frame.indexOf('const current = refresh.streamedInputRevision === streamedRailInputRevision;'));
    assert.ok(visual.indexOf('if (rebuilt) {') < visual.indexOf('if (rebuilt && current) {'));
    assert.match(visual.slice(0, visual.indexOf('if (rebuilt && current) {')), /streamedRailHasAppliedSet = true;/);
});

test('initial rail formation is delegated to the cooperative shared ground generation', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    const begin = source.slice(source.indexOf('    beginSession(ctx) {'), source.indexOf('    onFrame(pose, local) {'));
    // Without a ground coordinator (photo world) the rails layer stages its own startup formation (09416fc).
    assert.match(begin, /if \(!ctx\.groundCoordinator && lastFeatures\?\.length\) \{\s*createPendingRailFormationBuild\(lastFeatures/);
    assert.doesNotMatch(begin, /createRailFormationModel\(lastFeatures/);
    assert.doesNotMatch(begin, /rebuildVisibleRails\(0, 0\)/);
    assert.match(begin, /ctx\.railFormation = null/);
    const frame = source.slice(source.indexOf('    onFrame(pose, local) {'), source.indexOf('    endSession() {'));
    assert.match(frame, /if \(groundManaged \|\| railGroundGenerationLease\) return/);
    const admission = source.slice(source.indexOf('function* admitRailGroundGenerationSteps'), source.indexOf('function admitRailWindowGroundGeneration'));
    assert.doesNotMatch(admission, /if \(!group \|\|/);
    assert.match(source, /groundReady: \(\) => !railGroundGenerationLease/);
});

test('a staged rail visual is discarded for a terrain revision, never for a newer streamed tile', () => {
    assert.equal(pendingRailVisualRefreshDisposition({}), RAIL_VISUAL_REFRESH_DISPOSITION.CONTINUE);
    assert.equal(pendingRailVisualRefreshDisposition({ terrainRevisionDirty: true }), RAIL_VISUAL_REFRESH_DISPOSITION.DISCARD_TERRAIN);
    assert.equal(Object.values(RAIL_VISUAL_REFRESH_DISPOSITION).includes('discard:stale'), false);
});

// A streaming start on a slow API: a tile lands every 20 frames for the first
// 2,000 frames, a formation build takes 150 frames and its visual refresh 100.
function simulateStreamingStart({ discardStaleVisual, deliveryEvery = 20, deliveryUntil = 2000, buildFrames = 150, visualFrames = 100, frames = 4000 }) {
    let inputRevision = 0;
    let dirty = true;
    let build = null;
    let visual = null;
    let firstPublishedFrame = null;
    let publications = 0;
    let lastPublishedRevision = null;
    for (let frame = 0; frame < frames; frame += 1) {
        if (frame > 0 && frame < deliveryUntil && frame % deliveryEvery === 0) { inputRevision += 1; dirty = true; }
        if (build) {
            build.steps += 1;
            if (build.steps >= buildFrames) { visual = { steps: 0, revision: build.revision }; build = null; }
            continue;
        }
        if (visual) {
            const disposition = discardStaleVisual && visual.revision !== inputRevision
                ? 'discard:stale'
                : pendingRailVisualRefreshDisposition({ terrainRevisionDirty: false });
            if (disposition === RAIL_VISUAL_REFRESH_DISPOSITION.CONTINUE) {
                visual.steps += 1;
                if (visual.steps >= visualFrames) {
                    publications += 1;
                    lastPublishedRevision = visual.revision;
                    if (firstPublishedFrame === null) firstPublishedFrame = frame;
                    visual = null;
                }
                continue;
            }
            visual = null;
        }
        if (dirty) { build = { steps: 0, revision: inputRevision }; dirty = false; }
    }
    return { firstPublishedFrame, publications, lastPublishedRevision, inputRevision };
}

test('street rails appear after the first formation instead of after the last streamed tile', () => {
    const before = simulateStreamingStart({ discardStaleVisual: true });
    assert.ok(before.firstPublishedFrame > 2000, `the old rule drew nothing while tiles kept arriving (${before.firstPublishedFrame})`);
    const after = simulateStreamingStart({ discardStaleVisual: false });
    assert.equal(after.firstPublishedFrame, 250, 'the first complete snapshot is drawn as soon as it is built');
    assert.ok(after.publications > 1, 'later deliveries catch up in further snapshots');
    assert.equal(after.lastPublishedRevision, after.inputRevision, 'the final snapshot carries every delivered tile');
});

test('rails.js keeps drawing a staged streamed visual when newer tiles arrive', async () => {
    const source = await readFile(new URL('../world/rails.js', import.meta.url), 'utf8');
    const start = source.indexOf('        if (pendingRailVisualRefresh) {\n            // Only a terrain revision discards');
    assert.ok(start > 0, 'the staged visual block is where the policy is applied');
    const block = source.slice(start, source.indexOf('const refresh = pendingRailVisualRefresh;', start));
    assert.match(block, /pendingRailVisualRefreshDisposition\(\{ terrainRevisionDirty \}\)/);
    assert.match(block, /RAIL_VISUAL_REFRESH_DISPOSITION\.DISCARD_TERRAIN/);
    assert.doesNotMatch(block, /streamedInputRevision/, 'a newer streamed tile no longer discards the staged visual');
});
