// Exercise the real rail publication hook: preparation counts are diagnostics,
// not milliseconds, and deferred builds must not report their totals twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('rail publication reports elapsed stages but never feature counts as frame time', () => {
    const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
    const start = source.indexOf('function prepareRailFormationPublication(');
    const end = source.indexOf('\n// terrainChangedBounds:', start);
    assert.ok(start >= 0 && end > start, 'exercise the actual publication function');
    const recorded = [];
    const model = {
        revision: 1,
        buildTimings: {
            prepareMs: 2, preparedReusedCount: 400, preparedDirtyCount: 7,
            totalMs: 20, reusedCount: 400, dirtyCount: 7, reuseCandidates: -1,
        },
    };
    const publish = runInNewContext(`
        let lastRailFormation = null;
        const streamedRailSessionContext = null;
        const lastTerrain = null;
        ${source.slice(start, end)}
        publishRailFormation;
    `, {
        railSessionToken: 0,
        publishedRailCivilGroundSnapshot: {}, publishedRailCivilGroundSnapshotModel: null,
        publishedRailCivilGroundSnapshotRevision: -1, publishedRailCivilGroundSnapshotMutation: -1,
        pendingPublishedRailCivilGroundSnapshot: null, pendingRailVisualRefresh: null,
        pendingRailStructuresRefresh: null, pendingCrossingFormationRefresh: null,
        pendingEmbeddedTramMeshRefresh: null,
        EMPTY_RAIL_CIVIL_GROUND_SNAPSHOT: { entries: [], bounds: [], signature: '' },
        ensurePillarClearanceForFormation() {},
        discardPendingRailVisualRefresh() {},
        discardPendingRailStructuresRefresh() {},
        discardPendingCrossingFormationRefresh() {},
        discardPendingEmbeddedTramMeshRefresh() {},
        recordLayerFrameMs: (name, ms) => recorded.push([name, ms]),
    });
    const options = { revisionPrepared: true, civilGroundSnapshot: {} };
    assert.equal(publish(model, [], options), model);
    assert.deepEqual(recorded, [
        ['rails:formation:prepareMs', 2],
        ['rails:formation:totalMs', 20],
    ]);
    publish(model, [], { ...options, recordBuildTimings: false });
    assert.equal(recorded.length, 2, 'deferred builds already report each real slice');
});

test('rail cell phase timings exclude scheduler waits between cooperative slices', () => {
    const source = readFileSync(new URL('../world/rails.js', import.meta.url), 'utf8');
    const buildStart = source.indexOf('function* prepareRailCellGeometrySteps(');
    const buildEnd = source.indexOf('\n// One rail generation owns', buildStart);
    assert.ok(buildStart >= 0 && buildEnd > buildStart);
    let clockMs = 0;
    let queued;
    const recorded = [];
    const context = runInNewContext(`
        ${source.slice(buildStart, buildEnd)}
        prepareRailCellGeometrySteps;
    `, {
        Map, Set, THREE: { Group: class { constructor() { this.children=[]; } add(x){this.children.push(x);} } },
        performance: { now: () => clockMs },
        recordLayerFrameMs: (name, ms) => recorded.push([name, ms]),
        createRailRenderCellGroup: () => ({ children: [], add(x){this.children.push(x);} }),
        railRenderSegmentBatchesSteps: function* (segments) { yield { phase: 'batch' }; return segments.map(segment => [segment]); },
        addRenderedTrackSegmentMeshes: () => { clockMs += 5; },
        smoothRailHeadNormalsSteps: function* () {
            clockMs += 4; yield { phase: 'index' };
            clockMs += 6; yield { phase: 'weld' };
            clockMs += 1;
        },
        addJunctionPatchMeshes: () => { clockMs += 2; },
        annotateRailInspectionLayers() {}, createRailGpuPrewarm: () => null,
        stepRailGpuPrewarm() { return { done: true }; }, getFrameChunkSequence: () => 1,
        cancelRailCellNormalSmoothing() {}, cancelRailGpuPrewarm() {}, enqueueRailRetirement() {},
    });
    const steps = context(null, { segments: [{}, {}], junctionIncidents: new Map() }, 1, () => true);
    let next; do { next = steps.next(); clockMs += 200; } while (!next.done);
    assert.deepEqual(recorded, [
        ['rails:cells:geometry', 5], ['rails:cells:geometry', 5],
        ['rails:cells:normals', 4], ['rails:cells:normals', 6], ['rails:cells:normals', 1],
        ['rails:cells:junctions', 2], ['rails:cells:junctions', 2], ['rails:cells:junctions', 2],
    ]);
});
