import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { GTA_PHYSICS } from '../core/gta-config.js';
import { colliderBubbleNeedsRefresh, colliderBubbleTouchesChanges, fixedSurfaceRetryReady } from '../core/gta-collider-bubble.js';

const GTA_SOURCE = readFileSync(new URL('../modes/gta.js', import.meta.url), 'utf8');
const CAB_SOURCE = readFileSync(new URL('../modes/cab.js', import.meta.url), 'utf8');

function functionSource(source, name, nextName) {
    const start = source.indexOf(`function ${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = nextName ? source.indexOf(`\n    function ${nextName}`, start + 1) : -1;
    return source.slice(start, end > start ? end : undefined);
}

test('the live road step preserves velocity during background preparation and stops at unavailable coverage', () => {
    const start = GTA_SOURCE.indexOf('            const beforeStep = currentVehiclePose();');
    const end = GTA_SOURCE.indexOf('            droppedPhysicsSeconds += result.discardedSeconds;', start);
    let advances = 0, holds = 0, schedules = 0, coverage = true;
    const pose = { x: 0, z: 0, y: 0, velocityX: 10, velocityZ: 0 };
    const authored = Object.freeze({ revision: 0, surfacesNear: () => [] });
    const c = vm.createContext({
        GTA_PHYSICS, colliderBubbleNeedsRefresh, colliderBubbleTouchesChanges, fixedSurfaceRetryReady,
        currentVehiclePose: () => pose, physicsSupportY: () => 0, maybeRebase() {},
        groundCoverageAllowsStep: () => coverage,
        holdRoadVehicleForSurface() { holds++; pose.velocityX = 0; return pose; },
        pendingBubbleBuild: {}, groundPublicationLease: null, frameDt: 1 / 60, colliderContentRefreshElapsed: 2,
        terrainReference: () => null, lastTerrainReference: null, lastTerrainRevision: 0,
        roadFormationReference: () => null, lastRoadFormationReference: null, lastRoadFormationRevision: 0,
        roadVerticalAlignmentReference: () => null, lastRoadVerticalAlignmentReference: null,
        lastRoadVerticalAlignmentRevision: 0, renderedRoadSurfaceRevision: () => 0,
        lastRenderedRoadSurfaceRevision: 0, lastRailFormationReference: null, lastRailFormationRevision: 0,
        getSampledRailTrackbedSegments: () => ({ revision: 0 }), lastRailTrackbedRevision: 0,
        getCurbCollisionRevision: () => 0, lastCurbCollisionRevision: 0,
        authoredSurfaceReference: () => authored, lastAuthoredSurfaceRevision: 0,
        lastAuthoredSurfaceRevisionReference: authored,
        colliderCenter: { x: 0, z: 0 }, fixedBuildQueue: [], fixedRetireQueue: [],
        failedSurfaceRequest: null, monotonicNowMs: () => 1000,
        scheduleFixedBubble(_x, _z, _y, _options, inputs) {
            schedules++; c.pendingBubbleBuild = {}; c.requestInputs = inputs; return false;
        },
        drainFixedBubbleWork() {}, syncTraffic() {},
        fixedStep: { advance() { advances++; return { discardedSeconds: 0 }; } }, fixedPhysicsStep() {},
    });
    vm.runInContext(`function driveFrame() { ${GTA_SOURCE.slice(start, end)} }`, c);
    c.driveFrame();
    assert.equal(advances, 1, 'a private replacement cannot stop supported physics');
    assert.equal(pose.velocityX, 10);
    assert.equal(holds, 0);
    assert.equal(schedules, 0, 'pending work remains deduplicated');
    c.pendingBubbleBuild = null;
    c.driveFrame();
    assert.equal(schedules, 1, 'ordinary refresh starts in the background');
    assert.equal(advances, 2);
    assert.equal(pose.velocityX, 10);
    coverage = false;
    c.driveFrame();
    assert.equal(advances, 2);
    assert.equal(holds, 1, 'the car cannot leave its complete committed coverage');
    assert.equal(pose.velocityX, 0);
    c.pendingBubbleBuild = null;
    c.failedSurfaceRequest = { inputs: c.requestInputs, attempts: 3, atMs: 1000 };
    coverage = true;
    let released = 0;
    c.groundPublicationLease = { release() { released++; c.groundPublicationLease = null; } };
    pose.x = 15;
    c.driveFrame();
    assert.equal(released, 0, 'movement within current coverage retains the admitted generation');
    assert.equal(schedules, 1, 'movement inside the same refresh cell cannot defeat the retry limit');
    assert.equal(advances, 3, 'a rejected replacement does not erase complete active coverage');
    pose.x = 31;
    c.driveFrame();
    assert.equal(released, 1, 'recentring releases admission before the old coverage can be exhausted');
    assert.equal(schedules, 2, 'another refresh cell can request its own coverage');
    // A streamed member can acknowledge the latest sources while an older
    // bubble attempt is being cancelled. Pause stops the content clock but
    // must not strand that obligation after all source differences disappear.
    pose.x = 0; c.colliderContentRefreshElapsed = 0; c.frameDt = 0;
    c.pendingBubbleBuild = null;
    const inputs = [0, 0, null, 0, null, 0, null, 0, 0, null, 0, 0, 0, authored, 0];
    c.failedSurfaceRequest = { inputs, attempts: 1, atMs: 1000 };
    c.monotonicNowMs = () => 2999;
    c.driveFrame(); assert.equal(schedules, 2, 'paused retry still observes its backoff');
    c.monotonicNowMs = () => 3000;
    c.driveFrame(); assert.equal(schedules, 3, 'paused retry progresses without a source change or simulation time');
    c.pendingBubbleBuild = null; c.failedSurfaceRequest.attempts = 3;
    c.monotonicNowMs = () => 1e9;
    c.driveFrame(); assert.equal(schedules, 3, 'the same failed request remains capped at three attempts');
});

test('bulk GTA terrain and wall construction use the analytic physics sampler', () => {
    const terrain = functionSource(GTA_SOURCE, 'buildTerrainCollider', 'obstacleSpec');
    const bubble = functionSource(GTA_SOURCE, 'scheduleFixedBubble', 'drainFixedBubbleWork');
    assert.match(terrain, /read\.evidenceSceneYAtLocal/);
    assert.doesNotMatch(terrain, /[^A-Za-z]supportY\(x, z, referenceY\)/);
    assert.doesNotMatch(terrain, /terrain\?\.sceneYAtLocal/);
    // Geometry and evidence behavior are exercised with the real compiler and
    // Rapier in gta-ground-publication / terrain-collider-preparation tests.
    assert.match(terrain, /buildTerrainColliderMeshSteps/);
    assert.match(bubble, /yield\* measurePlanSteps\('terrain', buildTerrainColliderSteps/);
    assert.doesNotMatch(terrain, /removeFixedBody\(/,
        'ground builders stage successors; the shared batch owns replacement');
    assert.doesNotMatch(bubble, /publishFixedSurfaces\(replacements, measurePlanStage\)/,
        'movement schedules cooperative preparation and the shared boundary, never a synchronous support rebuild');
    assert.doesNotMatch(terrain, /sourceSceneYAtLocal/);
    assert.doesNotMatch(terrain, /formationAtLocal/);
    assert.match(terrain, /buildFormationTerrainCutoutQuerySteps/);
    assert.match(bubble, /heightAt: \(wallX, wallZ\) => physicsSupportY/);
    assert.match(
        CAB_SOURCE,
        /physicsGroundYAt: \(x, z, hintY\) => getGtaPhysicsGroundY\(x, z, hintY\)/,
    );
    assert.match(CAB_SOURCE, /requireSurface: true, allowStale: true/);
    assert.match(terrain, /allowStale: true/);
    assert.match(GTA_SOURCE, /colliderBubbleTouchesChanges/);
    assert.match(GTA_SOURCE, /roadFormationPending/);
    assert.match(GTA_SOURCE, /formation\?\.hasPendingBuild\?\.\(\) !== true/);
});

test('fixed collider ingestion has count and wall-clock bounds', () => {
    assert.ok(GTA_PHYSICS.colliderOpsPerFrame > 0);
    assert.ok(GTA_PHYSICS.colliderOpsPerFrame <= 20);
    assert.ok(GTA_PHYSICS.colliderWorkBudgetMs > 0);
    assert.ok(GTA_PHYSICS.colliderWorkBudgetMs <= 2);
    assert.ok(GTA_PHYSICS.maxFixedColliders <= 1200);
    assert.ok(GTA_PHYSICS.maxRailTrackbedTriangles <= 6000);
    assert.ok(GTA_PHYSICS.maxRailFormationDressingTriangles <= 8000);
    const drain = functionSource(GTA_SOURCE, 'drainFixedBubbleWork', 'maybeRebase');
    assert.match(drain, /monotonicNowMs\(\) - drainStartedAt < workBudgetMs/);
    assert.match(drain, /shouldDeferColliderBuild\(/,
        'streamed colliders must not materialize inside a live chassis');
});

test('terrain cut beneath rails has exact bounded replacement support', () => {
    const trackbed = functionSource(
        GTA_SOURCE,
        'buildRailTrackbedCollider',
        'buildRailFormationDressingCollider',
    );
    const dressing = functionSource(
        GTA_SOURCE,
        'buildRailFormationDressingCollider',
        'buildCurbSurfaceCollider',
    );
    assert.match(trackbed, /getSampledRailTrackbedSegments\(\)/);
    assert.match(trackbed, /maxTriangles: GTA_PHYSICS\.maxRailTrackbedTriangles/);
    assert.match(dressing, /terrainReference\(\)\?\.railFormation/);
    assert.match(dressing, /maxTriangles: GTA_PHYSICS\.maxRailFormationDressingTriangles/);
});

test('GTA work is named in per-layer performance attribution', () => {
    assert.match(CAB_SOURCE, /recordLayerFrameMs\('gta-physics'/);
});
