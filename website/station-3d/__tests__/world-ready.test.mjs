// Unit tests for the model-world loading-hold readiness state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Controllable clock so the failsafe timeout is deterministic. Must be installed
// before importing the module under test (it reads performance.now() at runtime).
let clock = 0;
globalThis.performance = { now: () => clock };

const {
    beginWorldBuild, isWorldBuilding, noteWorldPhase,
    noteWorldQueueActive, noteWorldQueueIdle, onWorldReady,
    tickWorldReady, forceWorldReady, _resetWorldReady,
    getWorldLoadComponents, getWorldLoadDurations,
    getWorldLoadTelemetry, noteWorldTransferBytes,
    getWorldLoadMilestones, noteWorldMilestone,
    noteWorldBuildProgress, getWorldDataProgress, noteWorldQueueProgress,
    noteWorldBuildRequestActive, noteWorldBuildRequestIdle,
    noteWorldBuildRequirementActive, noteWorldBuildRequirementIdle,
    canReleaseWorldBuildRequirement,
    setWorldBuildOptionalQueues,
    setWorldDataOutage, getWorldDataOutage,
    setWorldBuildBlocker, getWorldBuildBlockers,
} = await import('../core/world-ready.js');

function fresh() { _resetWorldReady(); clock = 0; }

test('records exact publication milestones once and keeps curtain-open after readiness', () => {
    fresh();
    beginWorldBuild();
    clock = 10; noteWorldPhase('blocking-ready');
    clock = 20; noteWorldMilestone('first-ground-publication');
    noteWorldMilestone('track-ready');
    noteWorldMilestone('roads-ready');
    noteWorldQueueActive('rail-cells');
    clock = 30; noteWorldQueueIdle('rail-cells');
    noteWorldQueueActive('roads');
    clock = 40; noteWorldQueueIdle('roads');
    noteWorldQueueActive('buildings');
    clock = 50; noteWorldQueueIdle('buildings');
    clock = 60; noteWorldPhase('deferred-built');
    assert.equal(isWorldBuilding(), false);
    clock = 65; noteWorldMilestone('curtain-open');
    clock = 70; noteWorldMilestone('roads-ready');
    assert.deepEqual(getWorldLoadMilestones(), [
        { name: 'terrain-ready', ms: 10 },
        { name: 'first-ground-publication', ms: 20 },
        { name: 'track-ready', ms: 20 },
        { name: 'roads-ready', ms: 20 },
        { name: 'support-buildings-ready', ms: 50 },
        { name: 'curtain-open', ms: 65 },
    ]);
    assert.deepEqual(getWorldLoadTelemetry().milestones, getWorldLoadMilestones());
});

test('transfer bytes count only while building and reset per build', () => {
    fresh();
    noteWorldTransferBytes(500);
    assert.equal(getWorldLoadTelemetry().transferBytes, 0, 'nothing counts before a build');
    beginWorldBuild();
    noteWorldTransferBytes(1200);
    noteWorldTransferBytes(800);
    noteWorldTransferBytes(NaN);
    noteWorldTransferBytes(-5);
    assert.equal(getWorldLoadTelemetry().transferBytes, 2000);
    beginWorldBuild();
    assert.equal(getWorldLoadTelemetry().transferBytes, 0, 'a new build starts from zero');
});

test('not building initially → onWorldReady fires immediately', () => {
    fresh();
    assert.equal(isWorldBuilding(), false);
    let reason = null;
    onWorldReady((r) => { reason = r; });
    assert.equal(reason, 'immediate');
});

test('load components: all known segments present from the start, greened as they settle', () => {
    fresh();
    assert.deepEqual(getWorldLoadComponents(), [], 'empty when not building');
    beginWorldBuild();
    // The full fixed set is present immediately (scene + every known queue),
    // all pending — segments must not pop in one at a time.
    assert.deepEqual(getWorldLoadComponents().map((c) => c.key),
        ['terrain-data', 'terrain-decode', 'terrain-mesh', 'base', 'layers',
            'roads', 'curbs', 'lane-markings.rebuild', 'rail-cells',
            'cars', 'buildings', 'far-buildings']);
    assert.ok(getWorldLoadComponents().every((c) => c.done === false));
    assert.deepEqual(
        getWorldLoadComponents().filter((c) => c.active).map((c) => c.key),
        ['terrain-data'],
    );

    noteWorldPhase('terrain-data-ready');
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'terrain-data').done, true);
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'terrain-decode').active, true);
    noteWorldPhase('terrain-decode-ready');
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'terrain-decode').done, true);
    noteWorldPhase('blocking-ready');
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'terrain-mesh').done, true);
    noteWorldPhase('immediate-built');
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'base').done, true);
    noteWorldPhase('deferred-built');
    assert.equal(getWorldLoadComponents().find((c) => c.key === 'layers').done, true);

    // Two queues active so settling one doesn't trip 'ready' (which empties the list).
    noteWorldQueueActive('roads');
    noteWorldQueueActive('buildings');
    assert.deepEqual(
        getWorldLoadComponents().filter((c) => c.active).map((c) => c.key),
        ['roads', 'buildings'],
    );
    noteWorldQueueIdle('roads');            // roads settles → greens; buildings stays pending
    assert.equal(isWorldBuilding(), true);
    const byKey = Object.fromEntries(getWorldLoadComponents().map((c) => [c.key, c.done]));
    assert.equal(byKey.roads, true);
    assert.equal(byKey.buildings, false);

    // An unexpected queue is appended after the known ones.
    noteWorldQueueActive('mystery');
    assert.equal(getWorldLoadComponents().at(-1).key, 'mystery');
});

test('a settled queue stays visibly complete when late work reopens it', () => {
    fresh();
    beginWorldBuild();
    noteWorldQueueActive('roads');
    noteWorldQueueActive('buildings');
    noteWorldQueueIdle('roads');
    assert.deepEqual(
        getWorldLoadComponents().find(component => component.key === 'roads'),
        { key: 'roads', done: true, active: false },
    );

    noteWorldQueueActive('roads');
    assert.deepEqual(
        getWorldLoadComponents().find(component => component.key === 'roads'),
        { key: 'roads', done: true, active: true },
        'readiness remains live, but presentation completion never regresses',
    );
});

test('late background work cannot reopen an ordinary startup obligation', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((reason) => { fired = reason; });
    noteWorldQueueActive('ground-generation');
    noteWorldQueueActive('buildings');
    noteWorldQueueIdle('ground-generation');
    noteWorldQueueActive('ground-generation');
    noteWorldPhase('deferred-built');
    noteWorldQueueIdle('buildings');
    assert.equal(fired, 'ready');
});

test('load durations: startup phases are incremental and queues use active-to-idle time', () => {
    fresh();
    beginWorldBuild();                 // clock = 0
    clock = 100; noteWorldQueueActive('roads');
    clock = 150; noteWorldPhase('terrain-data-ready');
    clock = 180; noteWorldPhase('terrain-decode-ready');
    clock = 200; noteWorldPhase('blocking-ready');
    clock = 300; noteWorldPhase('immediate-built');
    clock = 450; noteWorldPhase('deferred-built');
    clock = 500; noteWorldQueueActive('roads');       // re-active: first-active stays 100
    clock = 900; noteWorldQueueIdle('roads');         // last-idle 900 → 900-100 = 800
    const d = getWorldLoadDurations();
    assert.deepEqual(
        { terrain: d.terrain, base: d.base, layers: d.layers },
        { terrain: undefined, base: 100, layers: 150 },
    );
    assert.deepEqual(
        { data: d['terrain-data'], decode: d['terrain-decode'], mesh: d['terrain-mesh'] },
        { data: 150, decode: 30, mesh: 20 },
    );
    assert.equal(d.roads, 800);
});

test('load duration ends at first settlement, not at a later reopened batch', () => {
    fresh();
    beginWorldBuild();
    clock = 100; noteWorldQueueActive('cars');
    clock = 400; noteWorldQueueIdle('cars');
    clock = 700; noteWorldQueueActive('cars');
    clock = 1200; noteWorldQueueIdle('cars');
    assert.equal(getWorldLoadDurations().cars, 300);
});

test('ready needs deferred-built AND every started queue idle', () => {
    fresh();
    beginWorldBuild();
    assert.equal(isWorldBuilding(), true);
    let fired = null;
    onWorldReady((r) => { fired = r; });

    noteWorldQueueActive('roads');
    noteWorldPhase('deferred-built');
    assert.equal(fired, null, 'roads still active → not ready');

    noteWorldQueueIdle('roads');
    assert.equal(fired, 'ready');
    assert.equal(isWorldBuilding(), false);
});

test('waits for the slowest of several queues', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });

    noteWorldPhase('deferred-built');
    noteWorldQueueActive('roads');
    noteWorldQueueActive('buildings');
    noteWorldQueueIdle('roads');
    assert.equal(fired, null, 'buildings still building');
    noteWorldQueueIdle('buildings');
    assert.equal(fired, 'ready');
});

test('horizon LOD1 may continue after the required near-field queues settle', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });

    noteWorldPhase('deferred-built');
    noteWorldQueueActive('buildings');
    noteWorldQueueActive('far-buildings');
    noteWorldQueueIdle('buildings');

    assert.equal(fired, 'ready');
    assert.equal(isWorldBuilding(), false);
});

test('tunnel occlusion temporarily removes surface queues from the startup contract', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady(reason => { fired = reason; });
    noteWorldQueueActive('world-data');
    noteWorldQueueActive('buildings');
    noteWorldQueueActive('rail-cells');
    noteWorldPhase('deferred-built');
    setWorldBuildOptionalQueues(['world-data', 'buildings']);
    const buildings = getWorldLoadComponents().find(component => component.key === 'buildings');
    assert.deepEqual(buildings, { key: 'buildings', done: true, active: false, optional: true });
    assert.equal(fired, null, 'visible rail publication remains mandatory');
    noteWorldQueueIdle('rail-cells');
    assert.equal(fired, 'ready');
});

test('leaving a tunnel before reveal restores unfinished surface obligations', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady(reason => { fired = reason; });
    noteWorldQueueActive('buildings');
    noteWorldQueueActive('rail-cells');
    noteWorldPhase('deferred-built');
    setWorldBuildOptionalQueues(['buildings']);
    setWorldBuildOptionalQueues([]);
    noteWorldQueueIdle('rail-cells');
    assert.equal(fired, null, 'buildings became visible again and are still pending');
    noteWorldQueueIdle('buildings');
    assert.equal(fired, 'ready');
});

test('completion telemetry preserves the exact ready time and reason', () => {
    fresh();
    beginWorldBuild();
    noteWorldQueueActive('roads');
    noteWorldPhase('deferred-built');
    clock = 4321;
    noteWorldQueueIdle('roads');
    assert.deepEqual(
        {
            elapsedMs: getWorldLoadTelemetry().elapsedMs,
            completedMs: getWorldLoadTelemetry().completedMs,
            readyReason: getWorldLoadTelemetry().readyReason,
        },
        { elapsedMs: 4321, completedMs: 4321, readyReason: 'ready' },
    );
});

test('does not release before deferred-built even if a queue idled', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldQueueActive('roads');
    noteWorldQueueIdle('roads');
    assert.equal(fired, null, 'layers not built yet');
    noteWorldPhase('deferred-built');
    assert.equal(fired, 'ready');
});

test('does not release when no queue has started (waits for failsafe)', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldPhase('deferred-built');
    tickWorldReady();
    assert.equal(fired, null, 'no queues seen and within timeout → hold');
});

test('failsafe timeout releases the hold', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldPhase('deferred-built');
    clock = 5000;
    tickWorldReady();
    assert.equal(fired, null, 'within 12s → still holding');
    clock = 12001;
    tickWorldReady();
    assert.equal(fired, 'timeout');
    assert.equal(isWorldBuilding(), false);
});

test('a diagnosed data outage suspends the stall failsafe — the world down there is EMPTY', () => {
    // The wedged-boot shape: API down, no queue ever starts, and at 12 s the
    // stall failsafe used to dump the walker onto a blank plane with no message.
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldPhase('deferred-built');
    setWorldDataOutage(['roads', 'buildings']);
    assert.deepEqual(getWorldDataOutage(), ['roads', 'buildings']);
    clock = 30000;
    tickWorldReady();
    assert.equal(fired, null, 'outage announced → keep holding, the overlay says why');
    // Recovery: the transition itself must reset the stall clock, or the hold
    // would time out in the same tick the data starts flowing again.
    setWorldDataOutage([]);
    tickWorldReady();
    assert.equal(fired, null, 'just recovered → give the streams their stall window');
    clock = 30000 + 12001;
    tickWorldReady();
    assert.equal(fired, 'timeout', 'recovered but nothing streamed → ordinary stall rules');
});

test('the absolute ceiling bounds even a permanent outage', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    setWorldDataOutage(['roads']);
    clock = 120001;
    tickWorldReady();
    assert.equal(fired, 'timeout', 'a dead server cannot trap the loading screen forever');
});

test('an active terrain request suspends the stall failsafe before first byte', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldBuildRequestActive('terrain-grid-base');
    clock = 30000;
    tickWorldReady();
    assert.equal(fired, null, 'server-side query is active even before response bytes arrive');

    noteWorldBuildRequestIdle('terrain-grid-base');
    clock = 30000 + 12000;
    tickWorldReady();
    assert.equal(fired, null, 'request completion resets the stall window');
    clock += 1;
    tickWorldReady();
    assert.equal(fired, 'timeout', 'ordinary stall protection resumes after the request finishes');
});

test('the absolute ceiling still bounds an active terrain request', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldBuildRequestActive('terrain-grid-base');
    clock = 120001;
    tickWorldReady();
    assert.equal(fired, 'timeout');
});

test('a gameplay-critical build cannot be revealed by a generic timeout', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    noteWorldPhase('deferred-built');
    noteWorldQueueActive('drive-surface');
    noteWorldBuildRequirementActive('drive-surface');

    clock = 600000;
    tickWorldReady();
    assert.equal(fired, null, 'an unfinished drive surface remains behind the curtain');

    noteWorldBuildRequirementIdle('drive-surface');
    assert.equal(fired, null, 'the live queue still owns ordinary readiness');
    noteWorldQueueIdle('drive-surface');
    assert.equal(fired, 'ready');
});

test('a gameplay requirement releases only in the same quiescent queue generation', () => {
    fresh();
    beginWorldBuild();
    noteWorldPhase('deferred-built');
    noteWorldBuildRequirementActive('drive-surface');
    noteWorldQueueActive('drive-surface');
    noteWorldQueueActive('roads');

    assert.equal(canReleaseWorldBuildRequirement('drive-surface'), false);
    noteWorldQueueIdle('roads');
    assert.equal(canReleaseWorldBuildRequirement('drive-surface'), true);

    noteWorldQueueActive('rail-cells');
    assert.equal(
        canReleaseWorldBuildRequirement('drive-surface'),
        false,
        'a late rail successor closes the release predicate again',
    );
    noteWorldQueueIdle('rail-cells');
    assert.equal(canReleaseWorldBuildRequirement('drive-surface'), true);

    noteWorldBuildRequirementActive('another-critical-build');
    assert.equal(canReleaseWorldBuildRequirement('drive-surface'), false);
});

test('the failsafe is a STALL detector: honest download progress holds the screen', () => {
    // The 1 m route band legitimately downloads for tens of seconds. The old
    // fixed 12 s deadline dumped the player into a mostly-empty world with
    // the Data segment still loading.
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    for (clock = 4000; clock <= 40000; clock += 4000) {
        noteWorldBuildProgress();          // bytes arriving on a terrain fetch
        tickWorldReady();
        assert.equal(fired, null, `progress at ${clock} ms keeps holding`);
    }
    // Progress stops: the stall window applies from the LAST progress.
    clock += 12001;
    tickWorldReady();
    assert.equal(fired, 'timeout');
});

test('the absolute ceiling bounds even a permanent trickle', () => {
    fresh();
    beginWorldBuild();
    let fired = null;
    onWorldReady((r) => { fired = r; });
    for (clock = 5000; clock <= 119000; clock += 5000) {
        noteWorldBuildProgress();
        tickWorldReady();
    }
    assert.equal(fired, null, 'under the ceiling with steady progress');
    clock = 120001;
    noteWorldBuildProgress();
    tickWorldReady();
    assert.equal(fired, 'timeout', 'the 120 s ceiling fires regardless of progress');
});

test('data progress aggregates bytes across parallel terrain fetches', () => {
    fresh();
    beginWorldBuild();
    assert.equal(getWorldDataProgress(), null, 'nothing measured yet');
    noteWorldBuildProgress('base', 1000, 4000);
    noteWorldBuildProgress('chunk-0', 0, 2000);
    assert.ok(Math.abs(getWorldDataProgress() - 1000 / 6000) < 1e-9);
    noteWorldBuildProgress('base', 4000, 4000);
    noteWorldBuildProgress('chunk-0', 2000, 2000);
    assert.equal(getWorldDataProgress(), 1);
    const dataComponent = getWorldLoadComponents().find((c) => c.key === 'terrain-data');
    assert.equal(dataComponent.progress, 1, 'exposed on the Data segment');
    clock = 2750;
    assert.deepEqual((({ elapsedMs, receivedBytes, transferBytes }) => ({ elapsedMs, receivedBytes, transferBytes }))(getWorldLoadTelemetry()), {
        elapsedMs: 2750,
        receivedBytes: 6000,
        transferBytes: 0,
    });
    // Keyless calls (pure stall-clock bumps) must not poison the aggregate.
    noteWorldBuildProgress();
    assert.equal(getWorldDataProgress(), 1);
});

test('same-key retries cannot make displayed decoded bytes run backward', () => {
    fresh();
    beginWorldBuild();
    noteWorldBuildProgress('terrain-grid-base', 4000, 8000);
    assert.equal(getWorldLoadTelemetry().receivedBytes, 4000);

    // A retry restarts the same response stream at zero. Keep the unique-body
    // high-water mark rather than showing 4 MB → 1 MB on the overlay.
    noteWorldBuildProgress('terrain-grid-base', 1000, 8000);
    assert.equal(getWorldLoadTelemetry().receivedBytes, 4000);
    assert.equal(getWorldDataProgress(), 0.5);

    noteWorldBuildProgress('terrain-grid-base', 9000, 10000);
    assert.equal(getWorldLoadTelemetry().receivedBytes, 9000);
    assert.equal(getWorldDataProgress(), 0.9);
});

test('forceWorldReady releases immediately', () => {
    fresh();
    beginWorldBuild();
    noteWorldBuildProgress('roads', 1000, 1000);
    let fired = null;
    onWorldReady((r) => { fired = r; });
    forceWorldReady();
    assert.equal(fired, 'forced');
    assert.equal(isWorldBuilding(), false);
    assert.equal(getWorldLoadTelemetry().receivedBytes, 0, 'startup byte accounting is released');
});

test('notes after ready are ignored (no double fire)', () => {
    fresh();
    beginWorldBuild();
    let count = 0;
    onWorldReady(() => { count += 1; });
    noteWorldPhase('deferred-built');
    noteWorldQueueActive('roads');
    noteWorldQueueIdle('roads');
    assert.equal(count, 1);
    noteWorldQueueActive('roads');
    noteWorldQueueIdle('roads');
    forceWorldReady();
    assert.equal(count, 1, 'callback fires exactly once');
});

test('a bounded queue reports its own progress on the loading bar and resets per build', () => {
    _resetWorldReady();
    beginWorldBuild();
    noteWorldQueueActive('drive-surface');
    let component = getWorldLoadComponents().find(entry => entry.key === 'drive-surface');
    assert.equal(component.progress, undefined);
    clock = 5000;
    noteWorldQueueProgress('drive-surface', 30, 144);
    component = getWorldLoadComponents().find(entry => entry.key === 'drive-surface');
    assert.ok(Math.abs(component.progress - 30 / 144) < 1e-9);
    // Going backwards or reporting nonsense changes nothing; going forward counts as build progress.
    noteWorldQueueProgress('drive-surface', 20, 144);
    noteWorldQueueProgress('drive-surface', 'x', 144);
    noteWorldQueueProgress('drive-surface', 40, 0);
    assert.ok(Math.abs(getWorldLoadComponents().find(entry => entry.key === 'drive-surface').progress - 30 / 144) < 1e-9);
    noteWorldQueueProgress('drive-surface', 144, 144);
    assert.equal(getWorldLoadComponents().find(entry => entry.key === 'drive-surface').progress, 1);
    // Settled queues carry no progress figure: done says it all.
    noteWorldQueueIdle('drive-surface');
    assert.equal(getWorldLoadComponents().find(entry => entry.key === 'drive-surface').progress, undefined);
    beginWorldBuild();
    noteWorldQueueActive('drive-surface');
    assert.equal(getWorldLoadComponents().find(entry => entry.key === 'drive-surface').progress, undefined);
    _resetWorldReady();
});

test('the activity serial moves whenever the build does observable work', () => {
    _resetWorldReady();
    beginWorldBuild();
    const first = getWorldLoadTelemetry().activitySerial;
    noteWorldQueueActive('curbs');
    const afterActive = getWorldLoadTelemetry().activitySerial;
    assert.ok(afterActive > first, 'a queue processing items this frame counts');
    noteWorldQueueActive('curbs');
    assert.ok(getWorldLoadTelemetry().activitySerial > afterActive, 'and again next frame');
    const beforeIdle = getWorldLoadTelemetry().activitySerial;
    noteWorldQueueIdle('curbs');
    assert.ok(getWorldLoadTelemetry().activitySerial > beforeIdle);
    const beforeProgress = getWorldLoadTelemetry().activitySerial;
    noteWorldQueueProgress('drive-surface', 1, 56);
    assert.ok(getWorldLoadTelemetry().activitySerial > beforeProgress);
    _resetWorldReady();
});

test('a queue working every frame holds the stall failsafe off; only the absolute ceiling ends it', () => {
    _resetWorldReady();
    clock = 0;
    beginWorldBuild();
    const reasons = [];
    onWorldReady(reason => reasons.push(reason));
    // A long decode: items processed every frame, no bytes, no phase for 40 s.
    for (clock = 0; clock <= 40_000; clock += 100) {
        noteWorldQueueActive('terrain-grid-prep');
        tickWorldReady();
    }
    assert.deepEqual(reasons, [], 'an actively working queue is not a stall');
    // The queue stops without draining: the 12 s stall fires.
    clock += 12_001;
    tickWorldReady();
    assert.deepEqual(reasons, ['timeout']);
    _resetWorldReady();
});

test('a build may carry its own absolute ceiling; the default stays at 120 s', () => {
    _resetWorldReady();
    clock = 0;
    beginWorldBuild({ ceilingMs: 300_000 });
    const reasons = [];
    onWorldReady(reason => reasons.push(reason));
    for (clock = 0; clock <= 200_000; clock += 100) { noteWorldQueueActive('roads'); tickWorldReady(); }
    assert.deepEqual(reasons, [], 'a campaign build working at 200 s is not timed out by the free-roam ceiling');
    clock = 300_001; noteWorldQueueActive('roads'); tickWorldReady();
    assert.deepEqual(reasons, ['timeout'], 'its own ceiling still ends it');
    _resetWorldReady();
    clock = 0;
    beginWorldBuild();
    const plain = [];
    onWorldReady(reason => plain.push(reason));
    for (clock = 0; clock <= 120_100; clock += 100) { noteWorldQueueActive('roads'); tickWorldReady(); }
    assert.deepEqual(plain, ['timeout'], 'free roam keeps the 120 s ceiling');
    _resetWorldReady();
});

test('a timeout release reports the blockers that were diagnosed during the build', () => {
    fresh();
    beginWorldBuild({ ceilingMs: 60_000 });
    setWorldBuildBlocker('gta-ground-support', { code: 'surface-collider-coverage-capacity',
        message: 'rail-formation-dressings collider exceeds its complete coverage budget' });
    setWorldBuildBlocker('other', { code: 'transient' });
    setWorldBuildBlocker('other', null);
    assert.deepEqual(getWorldBuildBlockers().map(b => b.code), ['surface-collider-coverage-capacity']);
    let reason = null;
    onWorldReady(value => { reason = value; });
    clock = 61_000;
    tickWorldReady();
    assert.equal(reason, 'timeout');
    assert.deepEqual(getWorldBuildBlockers().map(b => b.key), ['gta-ground-support']);
    assert.equal(getWorldLoadTelemetry().blockers[0].code, 'surface-collider-coverage-capacity');
    beginWorldBuild();
    assert.deepEqual(getWorldBuildBlockers(), [], 'a new build starts without inherited blockers');
    fresh();
});
