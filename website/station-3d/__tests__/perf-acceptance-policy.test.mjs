import test from 'node:test';
import assert from 'node:assert/strict';

import { assertComparablePreflight, comparePerfAcceptanceRuns, evaluatePerfAcceptanceRun } from '../../../tools/lib/perf-acceptance-policy.mjs';

const hash = digit => digit.repeat(64);
let syntheticRunSequence = 0;
const paintBindings = () => ({ available: true, receiver: 'ordinary-ground:1',
    boundMaterials: 3, compiledMaterials: 1, tables: ['paint-table'], mismatches: [] });

function makeRun({ stage = 'measure', variant = 'baseline', engineHash = hash('a'), overrides = {} } = {}) {
    const startedAtMs = Date.UTC(2026, 0, 1) + syntheticRunSequence++ * 501000;
    const run = {
        stage,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(startedAtMs + 500000).toISOString(),
        complete: true,
        scenario: { mode: 'rail' },
        identity: {
            scenarioHash: hash('1'), sourceHash: hash('2'), hostHash: hash('3'), observerHash: hash('4'),
            engineHash, variant, viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
            renderContext: { dpr: 1.5, width: 1440, height: 900, antialias: true, shadows: true, quality: 'high', terrainActive: true },
            browser: 'Chrome 140', gpu: 'WebGL Renderer',
        },
        errors: [],
        files: { changed: false },
        sources: { sealed: true, missing: [], unexpectedResponses: [], changed: false },
        phases: {
            stationary: {
                requestedMs: 30000, durationMs: 30000, frames: { n: 3000, p50Ms: 8, p95Ms: 10, p99Ms: 12, maxMs: 30, over50: 1, over100: 0, over250: 0 },
                observation: { rawFrames: 3000, invalidFrames: 0, coveredMs: 30000 },
                longTasks: { count: 0, over50: 0, over100: 0, over250: 0, maxMs: 0, totalMs: 0 },
                host: { clean: true, reasons: [] }, visible: true, renderContextStable: true,
            },
            movement: {
                requestedMs: 180000, durationMs: 180000, distanceM: 900, frames: { n: 18000, p50Ms: 8, p95Ms: 11, p99Ms: 16, maxMs: 80, over50: 10, over100: 2, over250: 0 },
                observation: { rawFrames: 18000, invalidFrames: 0, coveredMs: 180000 },
                longTasks: { count: 0, over50: 0, over100: 0, over250: 0, maxMs: 0, totalMs: 0 },
                host: { clean: true, reasons: [] }, visible: true, renderContextStable: true,
            },
        },
        ready: { reason: 'ready', blockers: [] },
        initialDrain: { state: 'drained', paintBindings: paintBindings() },
        finalDrain: { state: 'drained', paintBindings: paintBindings() },
        lifecycle: { cycles: 2, errors: [], observations: [
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: paintBindings() },
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: paintBindings() },
        ] },
        required: { stationaryMs: 30000, movementMs: 180000, minDistanceM: 800, lifecycleCycles: 2 },
    };
    return { ...run, ...overrides };
}

function reasonMatches(result, pattern) {
    assert.ok(result.reasons.some(reason => pattern.test(reason)), `no reason matched ${pattern}: ${result.reasons.join('; ')}`);
}

test('only a complete, clean, sufficiently long visible measurement is accepted', () => {
    assert.deepEqual(evaluatePerfAcceptanceRun(makeRun()), { accepted: true, readyForTiming: false, reasons: [] });
    assert.equal(evaluatePerfAcceptanceRun(makeRun({ stage: 'record' })).accepted, false);
    assert.equal(evaluatePerfAcceptanceRun(makeRun({ stage: 'preflight' })).accepted, false);
    assert.equal(evaluatePerfAcceptanceRun(makeRun({ stage: 'preflight' })).readyForTiming, true);
});

test('walking needs repeated corridor turns and a stable render context throughout each phase', () => {
    const run = makeRun();
    run.scenario.mode = 'walk';
    run.required.walkTurns = 2;
    run.phases.movement.turns = 1;
    reasonMatches(evaluatePerfAcceptanceRun(run), /walk corridor turn count/);
    run.phases.movement.turns = 2;
    assert.equal(evaluatePerfAcceptanceRun(run).accepted, true);
    run.phases.movement.renderContextStable = false;
    reasonMatches(evaluatePerfAcceptanceRun(run), /render context changed/);
});

test('preflight needs a full route-duration envelope but ignores host timing evidence', () => {
    const preflight = makeRun({ stage: 'preflight' });
    preflight.phases.stationary.host = null;
    preflight.phases.movement.host = { clean: false, reasons: ['paging'] };
    assert.equal(evaluatePerfAcceptanceRun(preflight).readyForTiming, true);

    const short = makeRun({ stage: 'preflight' });
    short.phases.movement.requestedMs = 179999;
    short.phases.movement.durationMs = 179999;
    const shortResult = evaluatePerfAcceptanceRun(short);
    assert.equal(shortResult.readyForTiming, false);
    reasonMatches(shortResult, /movement requested duration must be at least 180000ms/);

    preflight.sources.sealed = false;
    const blocked = evaluatePerfAcceptanceRun(preflight);
    assert.equal(blocked.readyForTiming, false);
    reasonMatches(blocked, /source set is not sealed/);
});

test('rejects missing fields and invalid frame statistics instead of filling defaults', () => {
    const missing = makeRun();
    delete missing.identity.hostHash;
    delete missing.phases.stationary.frames.p99Ms;
    missing.phases.movement.frames.over100 = 18001;
    const result = evaluatePerfAcceptanceRun(missing);
    assert.equal(result.accepted, false);
    reasonMatches(result, /hostHash/);
    reasonMatches(result, /p99Ms/);
    reasonMatches(result, /over100 exceeds the frame count/);
});

test('rejects unsafe serialized counters even when their arithmetic appears consistent', () => {
    const run = makeRun();
    run.phases.movement.frames.n = 1e100;
    run.phases.movement.observation.rawFrames = 1e100;
    run.phases.movement.longTasks.count = 1e100;
    const result = evaluatePerfAcceptanceRun(run);
    assert.equal(result.accepted, false);
    reasonMatches(result, /movement\.frames\.n must be a safe integer/);
    reasonMatches(result, /movement\.observation\.rawFrames must be a nonnegative safe integer/);
    reasonMatches(result, /movement\.longTasks\.count must be a nonnegative safe integer/);
});

test('rejects incomplete, contaminated, unready, undrained, invisible and lifecycle-error runs', () => {
    const cases = [
        [makeRun({ overrides: { complete: false } }), /incomplete/],
        [makeRun({ overrides: { errors: ['console error'] } }), /run contains errors/],
        [makeRun({ overrides: { files: { changed: true } } }), /files changed during the run/],
        [makeRun({ overrides: { sources: { sealed: true, missing: ['tile'], unexpectedResponses: [], changed: false } } }), /sources.missing is not empty/],
        [makeRun({ overrides: { sources: { sealed: true, missing: [], unexpectedResponses: ['late response'], changed: false } } }), /unexpectedResponses is not empty/],
        [makeRun({ overrides: { sources: { sealed: true, missing: [], unexpectedResponses: [], changed: true } } }), /source set changed/],
        [makeRun({ overrides: { ready: { reason: 'waiting', blockers: ['terrain'] } } }), /readiness reason/],
        [makeRun({ overrides: { initialDrain: { state: 'pending' } } }), /initialDrain is not drained/],
        [makeRun({ overrides: { finalDrain: { state: 'pending' } } }), /finalDrain is not drained/],
        [makeRun({ overrides: { lifecycle: { cycles: 2, errors: ['failed reopen'] } } }), /lifecycle contains errors/],
        [makeRun({ overrides: { lifecycle: { cycles: 2, errors: [], observations: [] } } }), /observation count does not match/],
        [makeRun({ overrides: { lifecycle: { cycles: 2, errors: [], observations: [
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' } },
            { state: 'pending', snapshot: { reason: 'loading', drainState: 'pending' } },
        ] } } }), /lifecycle observation 1 is not drained/],
    ];
    const phases = makeRun().phases;
    const invisible = makeRun();
    invisible.phases.stationary.visible = false;
    cases.push([invisible, /stationary phase was not visible/]);
    for (const [run, expected] of cases) reasonMatches(evaluatePerfAcceptanceRun(run), expected);
});

test('requires renderer paint-binding evidence at both drains and every lifecycle reopen', () => {
    const missing = makeRun();
    delete missing.initialDrain.paintBindings;
    const missingResult = evaluatePerfAcceptanceRun(missing);
    assert.equal(missingResult.accepted, false);
    reasonMatches(missingResult, /initialDrain\.paintBindings evidence is missing/);

    const stale = makeRun();
    stale.finalDrain.paintBindings.mismatches.push({ material: 'shared-edging', actualTable: 'old', expectedTable: 'new' });
    stale.lifecycle.observations[1].paintBindings.mismatches.push({ material: 'fountain-rim' });
    const staleResult = evaluatePerfAcceptanceRun(stale);
    assert.equal(staleResult.accepted, false);
    reasonMatches(staleResult, /finalDrain\.paintBindings has stale uniform mismatches/);
    reasonMatches(staleResult, /lifecycle observation 1\.paintBindings has stale uniform mismatches/);

    const uncompiled = makeRun();
    uncompiled.initialDrain.paintBindings.compiledMaterials = 0;
    reasonMatches(evaluatePerfAcceptanceRun(uncompiled), /compiledMaterials must be a safe integer of at least 1/);
});

test('enforces duration bounds, long movement and required distance', () => {
    const shortRequest = makeRun();
    shortRequest.phases.movement.requestedMs = 179999;
    shortRequest.phases.movement.durationMs = 179999;
    reasonMatches(evaluatePerfAcceptanceRun(shortRequest), /at least 180000ms/);

    const shortObserved = makeRun();
    shortObserved.phases.movement.durationMs = 179999;
    reasonMatches(evaluatePerfAcceptanceRun(shortObserved), /observed duration must be at least 180000ms/);

    const overrun = makeRun();
    overrun.phases.stationary.durationMs = 32000;
    reasonMatches(evaluatePerfAcceptanceRun(overrun), /exceeds the allowed overrun/);

    const shortRoute = makeRun();
    shortRoute.phases.movement.distanceM = 799;
    reasonMatches(evaluatePerfAcceptanceRun(shortRoute), /below 800m/);

    const zeroDistanceThreshold = makeRun();
    zeroDistanceThreshold.required.minDistanceM = 0;
    reasonMatches(evaluatePerfAcceptanceRun(zeroDistanceThreshold), /minDistanceM must be finite and positive/);

    const zeroCycleThreshold = makeRun();
    zeroCycleThreshold.required.lifecycleCycles = 0;
    reasonMatches(evaluatePerfAcceptanceRun(zeroCycleThreshold), /lifecycleCycles must be a positive integer/);

    const sparse = makeRun();
    sparse.phases.movement.observation.coveredMs = 1000;
    reasonMatches(evaluatePerfAcceptanceRun(sparse), /cover less than 98%/);

    const invalidObservation = makeRun();
    invalidObservation.phases.stationary.observation.invalidFrames = 1;
    reasonMatches(evaluatePerfAcceptanceRun(invalidObservation), /contains invalid frame observations/);

    const lowRate = makeRun();
    lowRate.phases.movement.frames.n = 100;
    lowRate.phases.movement.observation.rawFrames = 100;
    reasonMatches(evaluatePerfAcceptanceRun(lowRate), /fewer than one frame interval per second/);
});

test('accepts only an ABBA baseline/candidate/candidate/baseline set with matching capture identity', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.comparable, true);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(result.runs.map(run => run.accepted), [true, true, true, true]);
    assert.equal(result.comparison.phases.stationary.frameTimes.p50Ms.baseline, 8);
    assert.match(result.comparison.phases.stationary.longTasks.gate, /aggregate/);
});

test('preflight identity comparison binds hashes, viewport and render context without browser or GPU fields', () => {
    const preflight = makeRun({ stage: 'preflight' });
    delete preflight.identity.browser;
    delete preflight.identity.gpu;
    const planned = structuredClone(preflight.identity);
    assert.deepEqual(assertComparablePreflight(preflight, planned), []);

    planned.renderContext.dpr = 2;
    const reasons = assertComparablePreflight(preflight, planned);
    assert.ok(reasons.some(reason => /renderContext.dpr does not match/.test(reason)));

    planned.renderContext.dpr = 1.5;
    planned.variant = 'candidate';
    assert.ok(assertComparablePreflight(preflight, planned).some(reason => /variant does not match/.test(reason)));

    planned.variant = 'baseline';
    planned.browser = 'Chrome 141';
    planned.gpu = 'Different GPU';
    const environmentMismatch = assertComparablePreflight(preflight, planned);
    assert.ok(environmentMismatch.some(reason => /identity.browser does not match/.test(reason)));
    assert.ok(environmentMismatch.some(reason => /identity.gpu does not match/.test(reason)));
});

test('ABBA rejects equal device scale factor when the actual renderer DPR differs', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    runs[2].identity.renderContext.dpr = 2;
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.comparable, false);
    assert.equal(result.accepted, false);
    assert.ok(result.mismatches.some(mismatch => mismatch.field === 'identity.renderContext.dpr'));
});

test('same-engine A/A controls are allowed, while per-variant engine drift is reported', () => {
    const sameEngine = ['baseline', 'candidate', 'candidate', 'baseline'].map(variant => makeRun({ variant }));
    assert.equal(comparePerfAcceptanceRuns(sameEngine).accepted, true);

    const changed = sameEngine.map(run => structuredClone(run));
    changed[2].identity.engineHash = hash('c');
    const result = comparePerfAcceptanceRuns(changed);
    assert.equal(result.accepted, false);
    assert.ok(result.mismatches.some(mismatch => mismatch.field === 'identity.engineHash.candidate'));
});

test('comparison preserves every invalid run and reports capture identity mismatches', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    runs[1].identity.sourceHash = hash('9');
    runs[2].phases.movement.host.clean = false;
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.accepted, false);
    assert.equal(result.runs.length, 4);
    assert.deepEqual(result.runs.map(run => run.index), [0, 1, 2, 3]);
    assert.deepEqual(result.runs.map(run => run.accepted), [true, true, false, true]);
    assert.ok(result.mismatches.some(mismatch => mismatch.field === 'identity.sourceHash'));
    assert.ok(result.reasons.some(reason => /run 2 is not accepted/.test(reason)));
    assert.equal(result.comparison, null, 'invalid runs do not produce comparison metrics');
});

test('comparable ABBA rejects more than 10% pair-average p50 or p95 regression', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    for (const index of [1, 2]) {
        runs[index].phases.stationary.frames.p50Ms = 9;
        runs[index].phases.stationary.frames.p95Ms = 12;
    }
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.comparable, true);
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.some(reason => /stationary p50 or p95 frame time regressed/.test(reason)));
    assert.equal(result.comparison.phases.stationary.frameTimes.p50Ms.regression, 0.125);
});

test('either frame-time percentile regressing by more than 10% rejects the pair', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    for (const index of [1, 2]) runs[index].phases.movement.frames.p95Ms = 12.2;
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.comparable, true);
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.some(reason => /movement p50 or p95/.test(reason)));
});

test('stable frame times pass while recurring new >50ms tasks in both candidates fail', () => {
    const runs = [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    for (const index of [1, 2]) {
        runs[index].phases.movement.frames.p50Ms = 8.5;
        runs[index].phases.movement.frames.p95Ms = 11.5;
        runs[index].phases.stationary.longTasks = { count: 2, over50: 2, over100: 0, over250: 0, maxMs: 70, totalMs: 120 };
    }
    const result = comparePerfAcceptanceRuns(runs);
    assert.equal(result.comparable, true);
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.some(reason => /new recurring >50ms long tasks/.test(reason)));

    runs[2].phases.stationary.longTasks = { count: 0, over50: 0, over100: 0, over250: 0, maxMs: 0, totalMs: 0 };
    assert.equal(comparePerfAcceptanceRuns(runs).accepted, true, 'one candidate run alone is not recurring');
});

test('requires exactly four runs in ABBA order and reports malformed input', () => {
    assert.equal(comparePerfAcceptanceRuns('not runs').accepted, false);
    const result = comparePerfAcceptanceRuns([makeRun(), makeRun({ variant: 'baseline' })]);
    assert.equal(result.accepted, false);
    assert.ok(result.reasons.includes('comparison requires exactly four runs'));
});

test('ABBA receipts must be distinct chronological runs with bounded gaps', () => {
    const makeAbba = () => [
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'baseline', engineHash: hash('a') }),
    ];
    const assertNoMetrics = result => {
        assert.equal(result.comparable, false);
        assert.equal(result.accepted, false);
        assert.equal(result.comparison, null);
    };

    const duplicate = makeAbba();
    duplicate[3] = duplicate[0]; // Same retained baseline receipt reused in slot four.
    const duplicateResult = comparePerfAcceptanceRuns(duplicate);
    assertNoMetrics(duplicateResult);
    reasonMatches(duplicateResult, /overlaps or is out of chronological order/);

    const reversed = makeAbba();
    reversed[2].startedAt = reversed[0].startedAt;
    reversed[2].finishedAt = reversed[0].finishedAt;
    const reversedResult = comparePerfAcceptanceRuns(reversed);
    assertNoMetrics(reversedResult);
    reasonMatches(reversedResult, /overlaps or is out of chronological order/);

    const overlap = makeAbba();
    overlap[1].startedAt = new Date(Date.parse(overlap[0].finishedAt) - 1).toISOString();
    const overlapResult = comparePerfAcceptanceRuns(overlap);
    assertNoMetrics(overlapResult);
    reasonMatches(overlapResult, /overlaps or is out of chronological order/);

    const gap = makeAbba();
    gap[1].startedAt = new Date(Date.parse(gap[0].finishedAt) + 300001).toISOString();
    const gapResult = comparePerfAcceptanceRuns(gap);
    assertNoMetrics(gapResult);
    reasonMatches(gapResult, /gap before run 1 exceeds 300000ms/);
});

test('ABBA requires parseable timestamps and positive receipt durations', () => {
    const malformed = [
        makeRun({ variant: 'baseline' }), makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }), makeRun({ variant: 'baseline' }),
    ];
    malformed[1].startedAt = 'not a timestamp';
    const parseResult = comparePerfAcceptanceRuns(malformed);
    assert.equal(parseResult.comparable, false);
    assert.equal(parseResult.comparison, null);
    reasonMatches(parseResult, /parseable startedAt and finishedAt/);

    const zeroDuration = [
        makeRun({ variant: 'baseline' }), makeRun({ variant: 'candidate', engineHash: hash('b') }),
        makeRun({ variant: 'candidate', engineHash: hash('b') }), makeRun({ variant: 'baseline' }),
    ];
    zeroDuration[1].finishedAt = zeroDuration[1].startedAt;
    const durationResult = comparePerfAcceptanceRuns(zeroDuration);
    assert.equal(durationResult.comparable, false);
    assert.equal(durationResult.comparison, null);
    reasonMatches(durationResult, /run 1 duration must be positive/);
});
