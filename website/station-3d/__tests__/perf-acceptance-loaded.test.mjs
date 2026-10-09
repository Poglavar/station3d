// Exercise planned ordering, whole-pair inference and fail-closed loaded comparisons.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compareLoadedPerfRuns,
    createLoadedComparisonPlan,
    loadedPlanHash,
    pairedRatioInterval,
    compareLoadedRoutes,
    validateLoadedComparisonPlan,
} from '../../../tools/lib/perf-acceptance-loaded.mjs';

const hash = character => character.repeat(64);
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const paintBindings = () => ({ available: true, receiver: 'ground:1', boundMaterials: 3,
    compiledMaterials: 1, tables: ['paint-table'], mismatches: [] });

function makeIdentities({ control = false } = {}) {
    const baseline = {
        variant: 'baseline', scenarioHash: hash('1'), sourceHash: hash('2'), hostHash: hash('3'),
        observerHash: hash('4'), engineHash: hash('a'), browser: 'Chrome 140', gpu: 'Metal renderer',
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        renderContext: { dpr: 2, width: 1440, height: 900, antialias: true, shadows: true,
            terrainActive: true, quality: 'high' },
    };
    const candidate = { ...baseline, variant: control ? 'baseline' : 'candidate', engineHash: control ? hash('a') : hash('b') };
    return { baseline, candidate };
}

function makePlan({ id = 'loaded-behavior', kind = 'comparison', pairs = 8,
    createdAt = new Date(BASE_TIME).toISOString(), identities = makeIdentities(), routePolicy } = {}) {
    return createLoadedComparisonPlan({ id, kind, pairs, seed: '0123456789abcdef0123456789abcdef',
        createdAt, identities, maxPairGapMs: 300000, distanceTolerance: 0.05, pathToleranceM: 5,
        ...(routePolicy ? { routePolicy } : {}) });
}

function route(distanceM = 900, offsetLat = 0) {
    const longitudeFor900m = 900 / (111320 * Math.cos(45 * Math.PI / 180));
    return [
        { distanceM: 0, lat: 45 + offsetLat, lon: 15 },
        { distanceM: distanceM / 2, lat: 45 + offsetLat, lon: 15 + longitudeFor900m * (distanceM / 1800) },
        { distanceM, lat: 45 + offsetLat, lon: 15 + longitudeFor900m * (distanceM / 900) },
    ];
}

const WALK_ORIGIN = { lat: 45.8105, lon: 15.96916 };
const WALK_HEADING_DEG = 7.78;
const walkCorridorPolicy = (overrides = {}) => ({ type: 'native-walk-corridor-v1',
    headingDeg: WALK_HEADING_DEG, lengthM: 55, origin: { ...WALK_ORIGIN }, ...overrides });

// Build a physically continuous out-and-back walk in local metres, then sample it
// by travelled distance. A sample interval may straddle a reversal, as it can in
// the browser observer, so waypoint chord lengths need not equal travelled distance.
function nativeWalkPhase({ turns, upperM, lowerM, endM, cadenceM = 2.2,
    firstUpperExtraM = 0, startCrossTrackM = 0, firstLegDetour = false }) {
    const theta = WALK_HEADING_DEG * Math.PI / 180;
    const latitudeScale = 111320 * Math.cos(WALK_ORIGIN.lat * Math.PI / 180);
    const knots = [{ travelledM: 0, alongM: 0, crossTrackM: startCrossTrackM }];
    let travelledM = 0, alongM = 0, crossTrackM = startCrossTrackM;
    const append = (nextAlong, nextCross) => {
        const length = Math.hypot(nextAlong - alongM, nextCross - crossTrackM);
        if (length <= 0) return;
        travelledM += length;
        alongM = nextAlong;
        crossTrackM = nextCross;
        knots.push({ travelledM, alongM, crossTrackM });
    };
    if (startCrossTrackM !== 0) append(0, 0);
    for (let turn = 1; turn <= turns; turn++) {
        if (firstLegDetour && turn === 1) {
            append(20, 0); append(22, 8); append(40, 8); append(42, 0);
        }
        const targetAlong = turn % 2
            ? upperM + (turn === 1 ? firstUpperExtraM : 0) : lowerM;
        append(targetAlong, 0);
    }
    append(endM, 0);

    const atTravelledDistance = distanceM => {
        let low = 1, high = knots.length - 1;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (knots[middle].travelledM < distanceM) low = middle + 1;
            else high = middle;
        }
        const a = knots[low - 1], b = knots[low];
        const fraction = (distanceM - a.travelledM) / (b.travelledM - a.travelledM);
        return { alongM: a.alongM + (b.alongM - a.alongM) * fraction,
            crossTrackM: a.crossTrackM + (b.crossTrackM - a.crossTrackM) * fraction };
    };
    const sample = distanceM => {
        const { alongM: along, crossTrackM: across } = atTravelledDistance(distanceM);
        const north = along * Math.cos(theta) - across * Math.sin(theta);
        const east = along * Math.sin(theta) + across * Math.cos(theta);
        return { distanceM, lat: WALK_ORIGIN.lat + north / 111320,
            lon: WALK_ORIGIN.lon + east / latitudeScale };
    };
    const points = [];
    for (let distanceM = 0; distanceM < travelledM; distanceM += cadenceM) points.push(sample(distanceM));
    points.push(sample(travelledM));
    return { distanceM: travelledM, turns, route: points };
}

function actualStyleWalkPair() {
    const baselineDistanceM = 4423.357353925886, candidateDistanceM = 4477.040169197233;
    const baselineUpperM = 55.63501304936428, baselineEndM = 48.87241125647011;
    const candidateUpperM = 56.58608120237905, candidateEndM = 50.7520205852817;
    const baselineLowerM = (82 * baselineUpperM + baselineEndM - baselineDistanceM) / 82;
    const candidateLowerM = (84 * candidateUpperM - candidateEndM - candidateDistanceM) / 82;
    return {
        baseline: nativeWalkPhase({ turns: 82, upperM: baselineUpperM, lowerM: baselineLowerM,
            endM: baselineEndM, cadenceM: 2.2 }),
        candidate: nativeWalkPhase({ turns: 83, upperM: candidateUpperM, lowerM: candidateLowerM,
            endM: candidateEndM, cadenceM: 2.5 }),
    };
}

function makeRun(plan, slot, { startedAt, finishedAt, ratio = 1, pressure = true } = {}) {
    const identity = plan.identities[slot.variant];
    const walking = plan.routePolicy.type === 'native-walk-corridor-v1';
    const framePhase = (phase, baseP50, baseP95) => ({
        requestedMs: phase === 'stationary' ? 30000 : 180000,
        durationMs: phase === 'stationary' ? 30000 : 180000,
        ...(phase === 'movement' ? { distanceM: 900, route: route(), ...(walking ? { turns: 2 } : {}) } : {}),
        frames: { n: phase === 'stationary' ? 3000 : 18000, p50Ms: baseP50, p95Ms: baseP95,
            p99Ms: baseP95 * 1.3, maxMs: baseP95 * 2, over50: 0, over100: 0, over250: 0 },
        observation: { rawFrames: phase === 'stationary' ? 3000 : 18000, invalidFrames: 0,
            coveredMs: phase === 'stationary' ? 30000 : 180000 },
        longTasks: { count: 0, over50: 0, over100: 0, over250: 0, maxMs: 0, totalMs: 0 },
        host: { clean: !pressure, reasons: pressure ? ['host CPU pressure observed'] : [],
            evidenceValid: true, evidenceReasons: [], samples: 91, elapsedMs: 180000,
            platform: 'darwin', cpus: 8 },
        visible: true, renderContextStable: true,
    });
    const baseline = slot.role === 'baseline';
    const factor = baseline ? 1 : ratio;
    const runIdentity = { ...identity };
    return {
        stage: 'measure', measurementProfile: 'loaded', label: slot.label,
        startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
        complete: true, scenario: walking ? { mode: 'walk', headingDeg: plan.routePolicy.headingDeg,
            corridorM: plan.routePolicy.lengthM } : { mode: 'rail' }, identity: { ...runIdentity }, errors: [],
        files: { changed: false },
        sources: { sealed: true, missing: [], unexpectedResponses: [], changed: false },
        phases: {
            stationary: framePhase('stationary', 8 * factor, 10 * factor),
            movement: framePhase('movement', 9 * factor, 12 * factor),
        },
        ready: { reason: 'ready', blockers: [] },
        initialDrain: { state: 'drained', paintBindings: paintBindings() },
        finalDrain: { state: 'drained', paintBindings: paintBindings() },
        lifecycle: { cycles: 2, errors: [], observations: [
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: paintBindings() },
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: paintBindings() },
        ] },
        required: { stationaryMs: 30000, movementMs: 180000, minDistanceM: 800, lifecycleCycles: 2,
            ...(walking ? { walkTurns: 2 } : {}) },
        experiment: { planHash: plan.hash, slot: slot.index },
    };
}

function makeRuns(plan, { ratio = 1, ratios = null, withinPairGapMs = 1000, betweenPairGapMs = 10000 } = {}) {
    const runs = new Array(plan.slots.length);
    let cursor = Date.parse(plan.createdAt) + 60000;
    for (const slot of plan.slots) {
        if (slot.index > 0) cursor += slot.index % 2 === 1 ? withinPairGapMs : betweenPairGapMs;
        const startedAt = cursor;
        const finishedAt = startedAt + 500000;
        const pairRatio = ratios?.[slot.pair] ?? ratio;
        runs[slot.index] = makeRun(plan, slot, { startedAt, finishedAt, ratio: pairRatio });
        cursor = finishedAt;
    }
    return runs;
}

function setRatioForPair(plan, runs, pairIndex, ratio) {
    const slots = plan.slots.slice(pairIndex * 2, pairIndex * 2 + 2);
    const candidateSlot = slots.find(slot => slot.role === 'candidate');
    const run = runs[candidateSlot.index];
    for (const phase of ['stationary', 'movement']) {
        const baseP50 = phase === 'stationary' ? 8 : 9;
        const baseP95 = phase === 'stationary' ? 10 : 12;
        run.phases[phase].frames.p50Ms = baseP50 * ratio;
        run.phases[phase].frames.p95Ms = baseP95 * ratio;
        run.phases[phase].frames.p99Ms = baseP95 * ratio * 1.3;
        run.phases[phase].frames.maxMs = baseP95 * ratio * 2;
    }
}

function statuses(result) {
    assert.equal(result.runs.length, result.runs.filter(row => row.accepted).length,
        result.runs.flatMap(row => row.reasons).join('; '));
}

test('plans predeclare a deterministic randomized balanced AB/BA schedule', () => {
    const first = makePlan({ pairs: 8 });
    const second = makePlan({ pairs: 8 });
    assert.deepEqual(first, second);
    assert.deepEqual(validateLoadedComparisonPlan(first), []);
    const orders = Array.from({ length: first.pairs }, (_, pairIndex) =>
        first.slots.slice(pairIndex * 2, pairIndex * 2 + 2).map(slot => slot.role).join('/'));
    assert.equal(orders.filter(order => order === 'baseline/candidate').length, 4);
    assert.equal(orders.filter(order => order === 'candidate/baseline').length, 4);
    assert.equal(new Set(first.slots.map(slot => slot.label)).size, first.slots.length);

    const changedHash = structuredClone(first);
    changedHash.hash = hash('f');
    assert.ok(validateLoadedComparisonPlan(changedHash).includes('comparison plan hash does not match its contents'));

    const reordered = structuredClone(first);
    [reordered.slots[0], reordered.slots[1]] = [reordered.slots[1], reordered.slots[0]];
    reordered.hash = loadedPlanHash(reordered);
    assert.ok(validateLoadedComparisonPlan(reordered).includes('slots do not match the predeclared balanced randomized order'));
});

test('identical-build controls are valid and tiny control series remain explicitly unbounded', () => {
    const plan = makePlan({ id: 'loaded-identical-control', kind: 'control', pairs: 2,
        identities: makeIdentities({ control: true }) });
    assert.equal(plan.identities.baseline.engineHash, plan.identities.candidate.engineHash);
    assert.deepEqual(validateLoadedComparisonPlan(plan), []);
    const result = compareLoadedPerfRuns(plan, makeRuns(plan));
    assert.equal(result.comparable, true);
    assert.equal(result.decision, 'control-descriptive');
    assert.equal(result.accepted, false);
    assert.equal(result.comparison.metrics['movement.p50Ms'].bounded, false);
    statuses(result);
});

test('whole-pair exact intervals use eight or twelve independent pairs and classify outcomes', () => {
    const eight = pairedRatioInterval(Array(8).fill(1), { confidence: 0.95, familySize: 4 });
    assert.equal(eight.pairs, 8);
    assert.equal(eight.orderStatistic, 1);
    assert.equal(eight.guaranteedCoverage, 0.9921875);
    assert.equal(eight.bounded, true);

    const twelve = pairedRatioInterval(Array(12).fill(1), { confidence: 0.95, familySize: 4 });
    assert.equal(twelve.pairs, 12);
    assert.equal(twelve.orderStatistic, 2);
    assert.equal(twelve.guaranteedCoverage, 0.99365234375);
    assert.equal(twelve.bounded, true);

    const improvedPlan = makePlan({ id: 'loaded-improved', pairs: 12 });
    const improved = compareLoadedPerfRuns(improvedPlan, makeRuns(improvedPlan, { ratio: 0.8 }));
    assert.equal(improved.comparable, true);
    assert.equal(improved.decision, 'within-budget');
    assert.equal(improved.accepted, true);
    assert.equal(improved.comparison.metrics['stationary.p50Ms'].decision, 'improved');
    statuses(improved);

    const regressedPlan = makePlan({ id: 'loaded-regressed', pairs: 12 });
    const regressed = compareLoadedPerfRuns(regressedPlan, makeRuns(regressedPlan, { ratio: 1.2 }));
    assert.equal(regressed.comparable, true);
    assert.equal(regressed.decision, 'regressed');
    assert.equal(regressed.accepted, false);
    assert.equal(regressed.comparison.metrics['movement.p95Ms'].decision, 'regressed');
    statuses(regressed);

    const mixedPlan = makePlan({ id: 'loaded-uncertain', pairs: 12 });
    const mixedRatios = Array(12).fill(1.09);
    for (let i = 6; i < 12; i++) mixedRatios[i] = 1.11;
    const mixedRuns = makeRuns(mixedPlan);
    mixedRatios.forEach((value, pairIndex) => setRatioForPair(mixedPlan, mixedRuns, pairIndex, value));
    const mixed = compareLoadedPerfRuns(mixedPlan, mixedRuns);
    assert.equal(mixed.comparable, true);
    assert.equal(mixed.decision, 'inconclusive');
    assert.equal(mixed.accepted, false);
    assert.ok(mixed.reasons.some(reason => /does not resolve the 10% frame-time regression boundary/.test(reason)));
    statuses(mixed);
});

test('rejects old, missing or misassigned receipts, identity drift, overlap and long within-pair gaps', () => {
    const plan = makePlan({ id: 'loaded-receipt-validity', pairs: 8 });
    const baseline = makeRuns(plan);
    const accepted = compareLoadedPerfRuns(plan, baseline);
    assert.equal(accepted.accepted, true);
    statuses(accepted);

    const old = makeRuns(plan);
    const oldStart = Date.parse(plan.createdAt) - 1;
    old[0].startedAt = new Date(oldStart).toISOString();
    old[0].finishedAt = new Date(oldStart + 500000).toISOString();
    const oldResult = compareLoadedPerfRuns(plan, old);
    assert.equal(oldResult.comparable, false);
    assert.ok(oldResult.reasons.some(reason => /run predates the comparison plan/.test(reason)));

    const missing = compareLoadedPerfRuns(plan, baseline.slice(1));
    assert.equal(missing.comparable, false);
    assert.ok(missing.reasons.some(reason => /all planned slots are required/.test(reason)));

    const wrongSlot = makeRuns(plan);
    wrongSlot[0].experiment.slot = 7;
    const wrongSlotResult = compareLoadedPerfRuns(plan, wrongSlot);
    assert.equal(wrongSlotResult.comparable, false);
    assert.ok(wrongSlotResult.reasons.some(reason => /not captured for this loaded plan slot/.test(reason)));

    const wrongIdentity = makeRuns(plan);
    wrongIdentity[0].identity.browser = 'Chrome 141';
    const wrongIdentityResult = compareLoadedPerfRuns(plan, wrongIdentity);
    assert.equal(wrongIdentityResult.comparable, false);
    assert.ok(wrongIdentityResult.reasons.some(reason => /identity\.browser differs from the plan/.test(reason)));

    const overlap = makeRuns(plan);
    overlap[1].startedAt = new Date(Date.parse(overlap[0].finishedAt) - 1).toISOString();
    const overlapResult = compareLoadedPerfRuns(plan, overlap);
    assert.equal(overlapResult.comparable, false);
    assert.ok(overlapResult.reasons.some(reason => /overlaps or is out of planned chronological order/.test(reason)));

    const longPairGapPlan = makePlan({ id: 'loaded-long-pair-gap', pairs: 8 });
    const longPairGap = compareLoadedPerfRuns(longPairGapPlan, makeRuns(longPairGapPlan, { withinPairGapMs: 300001 }));
    assert.equal(longPairGap.comparable, false);
    assert.ok(longPairGap.reasons.some(reason => /gap within the pair exceeds the planned limit/.test(reason)));

    const paused = makePlan({ id: 'loaded-between-pair-pause', pairs: 8 });
    const pauseResult = compareLoadedPerfRuns(paused, makeRuns(paused, { betweenPairGapMs: 900000 }));
    assert.equal(pauseResult.accepted, true);
    statuses(pauseResult);
});

test('retains loaded source-integrity gates and rejects invalid movement route evidence', () => {
    const plan = makePlan({ id: 'loaded-route-evidence', pairs: 8 });

    const sourceChanged = makeRuns(plan);
    sourceChanged[0].sources.sealed = false;
    const sourceResult = compareLoadedPerfRuns(plan, sourceChanged);
    assert.equal(sourceResult.comparable, false);
    assert.ok(sourceResult.reasons.some(reason => /source set is not sealed/.test(reason)));

    const missingRoute = makeRuns(plan);
    delete missingRoute[1].phases.movement.route;
    const missingResult = compareLoadedPerfRuns(plan, missingRoute);
    assert.equal(missingResult.comparable, false);
    assert.ok(missingResult.reasons.some(reason => /movement route evidence is missing or invalid/.test(reason)));

    const shortRoute = makeRuns(plan);
    for (const run of shortRoute) {
        run.phases.movement.distanceM = 600;
        run.phases.movement.route = route(600);
    }
    const shortResult = compareLoadedPerfRuns(plan, shortRoute);
    assert.equal(shortResult.comparable, false);
    assert.ok(shortResult.reasons.some(reason => /movement distance .* is below 800m/.test(reason)));

    const differentStreet = makeRuns(plan);
    const candidateIndex = plan.slots.find(slot => slot.pair === 0 && slot.role === 'candidate').index;
    differentStreet[candidateIndex].phases.movement.route = route(900, 0.001);
    const streetResult = compareLoadedPerfRuns(plan, differentStreet);
    assert.equal(streetResult.comparable, false);
    assert.ok(streetResult.reasons.some(reason => /movement distance or path differs beyond the planned tolerance/.test(reason)));
});

test('checks native capacity, workload identity and recurring long tasks without filtering slow runs', () => {
    const plan = makePlan({ id: 'loaded-native-capacity', pairs: 8 });
    for (const mutate of [
        runs => { runs[1].phases.movement.host.cpus = 4; },
        runs => { delete runs[1].phases.stationary.host.platform; },
        runs => {
            for (const run of runs) for (const phase of Object.values(run.phases)) {
                Object.assign(phase.host, { platform: 'linux', effectiveCpuCapacity: 2 });
            }
            runs[1].phases.movement.host.effectiveCpuCapacity = 1;
        },
        runs => {
            runs[1].phases.stationary.requestedMs += 100;
            runs[1].phases.stationary.durationMs += 100;
        },
    ]) {
        const runs = makeRuns(plan);
        mutate(runs);
        assert.equal(compareLoadedPerfRuns(plan, runs).comparable, false);
    }
    const busy = makeRuns(plan);
    for (const slot of plan.slots.filter(slot => slot.role === 'candidate')) {
        busy[slot.index].phases.stationary.longTasks = {
            count: 2, over50: 2, over100: 0, over250: 0, maxMs: 60, totalMs: 120,
        };
    }
    const result = compareLoadedPerfRuns(plan, busy);
    assert.equal(result.comparable, true);
    assert.equal(result.decision, 'regressed');
    assert.equal(result.accepted, false);
    assert.deepEqual(result.comparison.longTasks.stationary.candidateOver50, Array(8).fill(2));
    assert.equal(result.pairs.length, 8);
});

test('route matching uses travelled distance, catches interior turns and tolerates waypoint cadence', () => {
    const a = { distanceM: 100, route: [
        { distanceM: 0, lat: 45, lon: 15 },
        { distanceM: 100, lat: 45 + 100 / 111320, lon: 15 },
    ] };
    const b = structuredClone(a);
    b.route.splice(1, 0, { distanceM: 50, lat: 45 + 50 / 111320, lon: 15 });
    assert.equal(compareLoadedRoutes(a, b).matched, true);
    b.route[1].lon += 0.001;
    assert.equal(compareLoadedRoutes(a, b).matched, false, 'same endpoints do not hide a detour');
    b.route[1].lon = 15;
    b.distanceM = 106;
    b.route.at(-1).distanceM = 106;
    assert.equal(compareLoadedRoutes(a, b).matched, false, 'six percent less work is not comparable');
    b.route[1].distanceM = -1;
    assert.match(compareLoadedRoutes(a, b).reason, /invalid/);
    assert.throws(() => pairedRatioInterval([1, NaN]), /Finite positive/);
});

test('native walk corridor matching accepts actual-style long out-and-back routes with cadence drift', () => {
    const pair = actualStyleWalkPair();
    const policy = walkCorridorPolicy();
    const legacy = compareLoadedRoutes(pair.baseline, pair.candidate);
    assert.equal(legacy.matched, false);
    assert.ok(legacy.maxDeviationM > 5, 'absolute-distance alignment should be out of phase after many reversals');

    const candidate = compareLoadedRoutes(pair.baseline, pair.candidate, { routePolicy: policy });
    assert.equal(candidate.matched, true, candidate.reason);
    assert.equal(candidate.method, 'native-walk-corridor-v1');
    assert.ok(candidate.distanceDifference > 0.01 && candidate.distanceDifference < 0.02);
    assert.equal(pair.baseline.turns, 82);
    assert.equal(pair.candidate.turns, 83);
    assert.notEqual(pair.baseline.route.length, pair.candidate.route.length,
        'different sampling cadence should produce different waypoint counts');
    assert.ok(candidate.corridors.every(corridor => corridor.endWitnesses >= 80));
    assert.ok(candidate.maxDeviationM < 2, 'frame-sized endpoint overshoot stays inside the planned 5m bound');
    assert.ok(Math.abs(pair.baseline.distanceM - 4423.357353925886) < 0.01);
    assert.ok(Math.abs(pair.candidate.distanceM - 4477.040169197233) < 0.01);
});

test('native walk corridor policy rejects cross-track detours, excessive overshoot, and displaced starts', () => {
    const pair = actualStyleWalkPair();
    const policy = walkCorridorPolicy();

    const crossTrack = nativeWalkPhase({ turns: 83, upperM: 56.58608120237905,
        lowerM: (84 * 56.58608120237905 - 50.7520205852817 - 4477.040169197233) / 82,
        endM: 50.7520205852817, cadenceM: 2.5, firstLegDetour: true });
    const crossTrackResult = compareLoadedRoutes(pair.baseline, crossTrack, { routePolicy: policy });
    assert.ok(crossTrackResult.maxDeviationM > 5);
    assert.equal(crossTrackResult.matched, false, 'a lateral excursion beyond 5m is a different route');

    const beyondEnd = nativeWalkPhase({ turns: 83, upperM: 56.58608120237905,
        lowerM: (84 * 56.58608120237905 - 50.7520205852817 - 4477.040169197233) / 82,
        endM: 50.7520205852817, cadenceM: 2.5, firstUpperExtraM: 6 });
    const beyondEndResult = compareLoadedRoutes(pair.baseline, beyondEnd, { routePolicy: policy });
    assert.ok(beyondEndResult.distanceDifference <= 0.05, 'single overshoot remains within the work tolerance');
    assert.ok(beyondEndResult.maxDeviationM > 5);
    assert.equal(beyondEndResult.matched, false, 'a route extending over 5m past the corridor endpoint is rejected');

    const displacedStart = nativeWalkPhase({ turns: 83, upperM: 56.58608120237905,
        lowerM: (84 * 56.58608120237905 - 50.7520205852817 - 4477.040169197233) / 82,
        endM: 50.7520205852817, cadenceM: 2.5, startCrossTrackM: 6 });
    const displacedResult = compareLoadedRoutes(pair.baseline, displacedStart, { routePolicy: policy });
    assert.ok(Math.abs(displacedResult.corridors[1].startDeviationM - 6) < 0.01);
    assert.equal(displacedResult.matched, false, 'the route must begin within 5m of its planned origin');
});

test('native walk corridor policy rejects short work, unwitnessed turns and materially different turn counts', () => {
    const policy = walkCorridorPolicy();
    const baseline = nativeWalkPhase({ turns: 82, upperM: 59.9, lowerM: -4.8, endM: 49, cadenceM: 2 });
    const shorter = nativeWalkPhase({ turns: 82, upperM: 55.1, lowerM: 2, endM: 49, cadenceM: 2 });
    const shortResult = compareLoadedRoutes(baseline, shorter, { routePolicy: policy });
    assert.ok(shortResult.distanceDifference > 0.05);
    assert.ok(shortResult.corridors.every(corridor => corridor.matched), 'both routes remain inside the 5m geometric bound');
    assert.equal(shortResult.matched, false, 'a physically shorter route beyond 5% is not comparable');

    const actual = actualStyleWalkPair();
    const forgedTurns = structuredClone(actual.candidate);
    forgedTurns.turns += 6;
    const forgedResult = compareLoadedRoutes(actual.baseline, forgedTurns, { routePolicy: policy });
    assert.equal(forgedResult.corridors[1].endWitnesses, actual.candidate.turns,
        'the sampled path witnesses the original turn count, not the forged field');
    assert.equal(forgedResult.corridors[1].matched, false);
    assert.equal(forgedResult.matched, false, 'turn totals must agree with corridor-end witnesses');

    const manyTurns = nativeWalkPhase({ turns: 90, upperM: 58.5, lowerM: -0.77, endM: 49, cadenceM: 2 });
    const turnResult = compareLoadedRoutes(baseline, manyTurns, { routePolicy: policy });
    assert.ok(turnResult.distanceDifference <= 0.05, 'the routes have comparable physical distance');
    assert.ok(turnResult.corridors.every(corridor => corridor.matched), 'both routes have witnessed corridor turns');
    assert.ok(turnResult.turnDifference > 0.05);
    assert.equal(turnResult.matched, false, 'materially different witnessed turn counts are not comparable');
});

test('walk route policy is validated and loaded runs must match its mode and corridor', () => {
    const pair = actualStyleWalkPair();
    const invalidPolicy = compareLoadedRoutes(pair.baseline, pair.candidate, { routePolicy: { type: 'unknown' } });
    assert.equal(invalidPolicy.matched, false);
    assert.match(invalidPolicy.reason, /route policy is invalid/);
    assert.throws(() => makePlan({ routePolicy: { type: 'native-walk-corridor-v1',
        headingDeg: WALK_HEADING_DEG, lengthM: 5, origin: WALK_ORIGIN } }), /corridor length must be at least 12/);

    const plan = makePlan({ id: 'loaded-walk-corridor-contract', routePolicy: walkCorridorPolicy() });
    const makeWalkRuns = () => {
        const runs = makeRuns(plan);
        for (const run of runs) Object.assign(run.phases.movement,
            run.identity.variant === 'baseline' ? pair.baseline : pair.candidate);
        return runs;
    };
    const valid = compareLoadedPerfRuns(plan, makeWalkRuns());
    assert.equal(valid.comparable, true, valid.reasons.join('; '));

    const wrongMode = makeWalkRuns();
    wrongMode[0].scenario.mode = 'rail';
    const wrongModeResult = compareLoadedPerfRuns(plan, wrongMode);
    assert.equal(wrongModeResult.comparable, false);
    assert.ok(wrongModeResult.reasons.some(reason => /movement mode differs from the planned route policy/.test(reason)));

    for (const override of [{ headingDeg: WALK_HEADING_DEG + 1 }, { corridorM: 54 }]) {
        const wrongCorridor = makeWalkRuns();
        Object.assign(wrongCorridor[0].scenario, override);
        const result = compareLoadedPerfRuns(plan, wrongCorridor);
        assert.equal(result.comparable, false);
        assert.ok(result.reasons.some(reason => /walk corridor differs from the planned route policy/.test(reason)));
    }
});
