// Verify durable serial experiments, resume boundaries and the real comparison CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    createPerfAcceptanceSeries, runPerfAcceptanceSeries, comparePerfAcceptanceSeries, perfAcceptanceSeriesPassed, verifySeriesInputs,
} from '../../../tools/lib/perf-acceptance-series.mjs';

const ok = () => ({ readyForTiming: true, accepted: true, reasons: [] });
const validatePlan = plan => Array.isArray(plan.slots) ? [] : ['missing slots'];
const identities = { baseline: { variant: 'baseline' }, candidate: { variant: 'candidate' } };
const createdAt = '2026-10-08T00:00:00.000Z';
const digest = async path => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(await readFile(path)).digest('hex');
};
const readyDeps = {
    evaluatePreflight: ok,
    assertComparablePreflight: (preflight, identity) => preflight.identity.variant === identity.variant ? [] : ['variant mismatch'],
};
function measurement(slot, planHash, good = true, secondOffsetMs = 0) {
    const start = Date.parse(createdAt) + (slot.index * 10000) + secondOffsetMs;
    return {
        stage: 'measure', measurementProfile: 'loaded', label: slot.label,
        identity: { variant: slot.variant },
        experiment: { planHash, slot: slot.index },
        startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 5000).toISOString(),
        good,
    };
}
const makePlan = ({ id, kind, pairs, seed, identities, createdAt, maxPairGapMs, distanceTolerance, pathToleranceM,
    routePolicy = { type: 'distance-aligned-v1' } }) => ({
    schema: 'station3d-perf-loaded-plan-v1', id, kind, pairs, seed: seed || 'a'.repeat(32), createdAt,
    maxPairGapMs, distanceTolerance, pathToleranceM, routePolicy, identities, hash: 'b'.repeat(64),
    slots: Array.from({ length: pairs }, (_, index) => ({ index, pair: Math.floor(index / 2), role: index % 2 ? 'B' : 'A',
        variant: kind === 'control' || index % 2 === 0 ? 'baseline' : 'candidate', label: `${id}-${index + 1}` })),
});

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'perf-series-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configPath = join(root, 'config.json'), outputDir = join(root, 'captures');
    await mkdir(outputDir);
    await writeFile(configPath, JSON.stringify({ outputDir: 'captures' }));
    const baselinePreflightPath = join(root, 'baseline.json'), candidatePreflightPath = join(root, 'candidate.json');
    const baseline = { identity: { variant: 'baseline', renderContext: { dpr: 1 } } };
    const candidate = { identity: { variant: 'candidate', renderContext: { dpr: 1 } } };
    await writeFile(baselinePreflightPath, JSON.stringify(baseline));
    await writeFile(candidatePreflightPath, JSON.stringify(candidate));
    const planPath = join(root, 'series.json');
    const inspectCalls = [];
    const dependencies = {
        inspectVariant: async ({ variant }) => { inspectCalls.push(variant); return { identity: { variant, scenarioHash: `${variant}-scenario` } }; },
        createPlan: makePlan,
        validatePlan,
        evaluatePreflight: ok,
        assertComparablePreflight: (preflight, identity) => preflight.identity.variant === identity.variant ? [] : ['variant mismatch'],
    createdAt,
    };
    return { root, configPath, outputDir, baselinePreflightPath, candidatePreflightPath, planPath, inspectCalls, dependencies };
}

async function writeWrapper(f, plan) {
    plan.hash ||= 'e'.repeat(64);
    plan.maxPairGapMs ||= 300000;
    const wrapper = {
        schema: 'station3d-perf-loaded-series-v1', plan,
        execution: {
            configPath: f.configPath,
            configSha256: await digest(f.configPath),
            preflights: {
                baseline: { path: f.baselinePreflightPath, sha256: await digest(f.baselinePreflightPath) },
                ...(plan.kind === 'comparison' ? { candidate: { path: f.candidatePreflightPath, sha256: await digest(f.candidatePreflightPath) } } : {}),
            },
            outputDir: f.outputDir,
        },
    };
    await writeFile(f.planPath, JSON.stringify(wrapper));
    return wrapper;
}

test('planning records immutable input hashes and inspects both variants without capture', async t => {
    const f = await fixture(t);
    const wrapper = await createPerfAcceptanceSeries({ configPath: f.configPath, planPath: f.planPath, id: 'loaded-ab', pairs: 2,
        baselinePreflightPath: f.baselinePreflightPath, candidatePreflightPath: f.candidatePreflightPath }, f.dependencies);
    assert.deepEqual(f.inspectCalls, ['baseline', 'candidate']);
    assert.equal(wrapper.schema, 'station3d-perf-loaded-series-v1');
    assert.equal(wrapper.execution.configSha256.length, 64);
    assert.equal(wrapper.execution.preflights.baseline.sha256.length, 64);
    assert.equal(wrapper.execution.preflights.candidate.sha256.length, 64);
    assert.equal(JSON.parse(await readFile(f.planPath, 'utf8')).plan.hash, 'b'.repeat(64));
    await assert.rejects(createPerfAcceptanceSeries({ configPath: f.configPath, planPath: f.planPath, id: 'loaded-ab', pairs: 2,
        baselinePreflightPath: f.baselinePreflightPath, candidatePreflightPath: f.candidatePreflightPath }, f.dependencies), /EEXIST/);
});

test('walk plans bind the corridor to the scenario and measured preflight origin', async t => {
    const f = await fixture(t);
    await writeFile(f.configPath, JSON.stringify({ outputDir: 'captures',
        scenario: { mode: 'walk', headingDeg: 7.78, corridorM: 55 } }));
    const baseline = JSON.parse(await readFile(f.baselinePreflightPath, 'utf8'));
    baseline.phases = { movement: { route: [{ distanceM: 0, lat: 45.81, lon: 15.97 }] } };
    await writeFile(f.baselinePreflightPath, JSON.stringify(baseline));
    const wrapper = await createPerfAcceptanceSeries({ configPath: f.configPath, planPath: f.planPath,
        id: 'walk-plan', pairs: 2, baselinePreflightPath: f.baselinePreflightPath,
        candidatePreflightPath: f.candidatePreflightPath }, f.dependencies);
    assert.deepEqual(wrapper.plan.routePolicy, { type: 'native-walk-corridor-v1', headingDeg: 7.78,
        lengthM: 55, origin: { lat: 45.81, lon: 15.97 } });
    await verifySeriesInputs(wrapper, f.dependencies);
    for (const change of [policy => { policy.headingDeg = 90; }, policy => { policy.lengthM = 50; },
        policy => { policy.origin.lon += 0.001; }, policy => { policy.type = 'distance-aligned-v1'; }]) {
        const altered = structuredClone(wrapper);
        change(altered.plan.routePolicy);
        await assert.rejects(verifySeriesInputs(altered, f.dependencies), /Planned route policy does not match/);
    }
});

test('runner executes fixed slots serially and stops while retaining a failed receipt', async t => {
    const f = await fixture(t);
    const wrapper = { schema: 'station3d-perf-loaded-series-v1', plan: makePlan({ id: 'loaded-ab', kind: 'comparison', pairs: 4,
        identities, createdAt }), execution: { configPath: f.configPath,
        configSha256: '', preflights: { baseline: { path: f.baselinePreflightPath, sha256: '' },
            candidate: { path: f.candidatePreflightPath, sha256: '' } }, outputDir: f.outputDir } };
    wrapper.plan.hash = 'c'.repeat(64); wrapper.plan.maxPairGapMs = 300000;
    // Use the actual source hashes for the input pinning check.
    wrapper.execution.configSha256 = await digest(f.configPath);
    wrapper.execution.preflights.baseline.sha256 = await digest(f.baselinePreflightPath);
    wrapper.execution.preflights.candidate.sha256 = await digest(f.candidatePreflightPath);
    await writeFile(f.planPath, JSON.stringify(wrapper));
    const calls = [];
    const deps = { validatePlan, evaluateRun: run => run.good ? { accepted: true } : { accepted: false },
        runSlot: async ({ slot }) => {
            calls.push(slot.index);
            const path = join(f.outputDir, `${slot.label}.json`);
            await writeFile(path, JSON.stringify(measurement(slot, wrapper.plan.hash, slot.index < 1)));
            return { receiptPath: path, exitCode: slot.index < 1 ? 0 : 1 };
        }, ...readyDeps, now: () => Date.parse(createdAt) + 100000 };
    const result = await runPerfAcceptanceSeries(f.planPath, { run: true }, deps);
    assert.deepEqual(calls, [0, 1]);
    assert.equal(result.complete, false);
    assert.equal(result.stoppedAt, 1);
    assert.equal(result.receipts.length, 2);
    await assert.rejects(runPerfAcceptanceSeries(f.planPath, {}, deps), /explicit --run/);
});

test('resume accepts only an accepted completed prefix and never skips a hole', async t => {
    const f = await fixture(t);
    const wrapper = { schema: 'station3d-perf-loaded-series-v1', plan: makePlan({ id: 'loaded-resume', kind: 'comparison', pairs: 4,
        identities, createdAt }), execution: { configPath: f.configPath,
        configSha256: '', preflights: { baseline: { path: f.baselinePreflightPath, sha256: '' },
            candidate: { path: f.candidatePreflightPath, sha256: '' } }, outputDir: f.outputDir } };
    wrapper.plan.hash = 'd'.repeat(64); wrapper.plan.maxPairGapMs = 300000;
    wrapper.execution.configSha256 = await digest(f.configPath);
    wrapper.execution.preflights.baseline.sha256 = await digest(f.baselinePreflightPath);
    wrapper.execution.preflights.candidate.sha256 = await digest(f.candidatePreflightPath);
    await writeFile(f.planPath, JSON.stringify(wrapper));
    const first = wrapper.plan.slots[0];
    await writeFile(join(f.outputDir, `${first.label}.json`), JSON.stringify(measurement(first, wrapper.plan.hash)));
    let executed = 0;
    let resumeNotice;
    const deps = { validatePlan, evaluateRun: run => run.good ? { accepted: true } : { accepted: false },
        runSlot: async ({ slot }) => {
            executed++;
            const path = join(f.outputDir, `${slot.label}.json`);
            await writeFile(path, JSON.stringify(measurement(slot, wrapper.plan.hash)));
            return path;
        }, ...readyDeps, now: () => Date.parse(createdAt) + 100000,
        onResume: notice => { resumeNotice = notice; } };
    const result = await runPerfAcceptanceSeries(f.planPath, { run: true, resume: true }, deps);
    assert.equal(result.complete, true);
    assert.equal(result.resumed, 1);
    assert.deepEqual(resumeNotice, { count: 1, nextSlot: wrapper.plan.slots[1] });
    assert.equal(executed, 3);

    const other = await fixture(t);
    const otherWrapper = { ...wrapper, execution: { ...wrapper.execution, configPath: other.configPath,
        configSha256: await digest(other.configPath), outputDir: other.outputDir,
        preflights: { baseline: { path: other.baselinePreflightPath, sha256: await digest(other.baselinePreflightPath) },
            candidate: { path: other.candidatePreflightPath, sha256: await digest(other.candidatePreflightPath) } } } };
    await writeFile(other.planPath, JSON.stringify(otherWrapper));
    await writeFile(join(other.outputDir, `${wrapper.plan.slots[1].label}.json`), '{}');
    await assert.rejects(runPerfAcceptanceSeries(other.planPath, { run: true, resume: true }, { ...deps, ...readyDeps }), /exists after missing slot/);
});

test('compare preserves missing planned slots as null inputs', async t => {
    const f = await fixture(t);
    const plan = makePlan({ id: 'loaded-compare', kind: 'control', pairs: 2, identities: { baseline: { variant: 'baseline' } }, createdAt });
    const wrapper = { schema: 'station3d-perf-loaded-series-v1', plan,
        execution: { configPath: f.configPath, configSha256: await digest(f.configPath), preflights: {
            baseline: { path: f.baselinePreflightPath, sha256: await digest(f.baselinePreflightPath) } }, outputDir: f.outputDir } };
    await writeFile(f.planPath, JSON.stringify(wrapper));
    await writeFile(join(f.outputDir, `${plan.slots[0].label}.json`), JSON.stringify({ slot: 0 }));
    let observed;
    const verdict = await comparePerfAcceptanceSeries(f.planPath, { validatePlan, compareRuns: (_plan, runs) => {
        observed = runs;
        return { comparable: false, accepted: false, reasons: ['incomplete'] };
    } });
    assert.deepEqual(observed, [{ slot: 0 }, null]);
    assert.equal(verdict.comparable, false);
});

test('A/A control comparison passes only when comparable and descriptive or consistent', () => {
    assert.equal(perfAcceptanceSeriesPassed('control', { comparable: true, accepted: false, decision: 'control-consistent' }), true);
    assert.equal(perfAcceptanceSeriesPassed('control', { comparable: true, accepted: false, decision: 'control-descriptive' }), true);
    assert.equal(perfAcceptanceSeriesPassed('control', { comparable: true, accepted: false, decision: 'control-bias' }), false);
    assert.equal(perfAcceptanceSeriesPassed('control', { comparable: false, decision: 'invalid' }), false);
    assert.equal(perfAcceptanceSeriesPassed('comparison', { accepted: true }), true);
});

test('new captures require loaded profile, exact plan slot, label, and identity metadata', async t => {
    const f = await fixture(t);
    const plan = makePlan({ id: 'loaded-metadata', kind: 'comparison', pairs: 2, identities, createdAt });
    const wrapper = await writeWrapper(f, plan);
    let calls = 0;
    const deps = { validatePlan, ...readyDeps, evaluateRun: () => ({ accepted: true }),
        now: () => Date.parse(createdAt) + 6000,
        runSlot: async ({ slot }) => {
            calls++;
            const path = join(f.outputDir, `${slot.label}.json`);
            const receipt = measurement(slot, wrapper.plan.hash);
            delete receipt.experiment;
            await writeFile(path, JSON.stringify(receipt));
            return { receiptPath: path, exitCode: 0 };
        } };
    const result = await runPerfAcceptanceSeries(f.planPath, { run: true }, deps);
    assert.equal(calls, 1);
    assert.equal(result.complete, false);
    assert.match(result.reason, /wrong experiment plan or slot identity/);
    assert.equal(JSON.parse(await readFile(join(f.outputDir, `${plan.slots[0].label}.json`), 'utf8')).stage, 'measure');
});

test('stale within-pair resume is rejected before invoking the next capture', async t => {
    const f = await fixture(t);
    const plan = makePlan({ id: 'loaded-stale-resume', kind: 'comparison', pairs: 4, identities, createdAt });
    const wrapper = await writeWrapper(f, plan);
    const first = plan.slots[0];
    await writeFile(join(f.outputDir, `${first.label}.json`), JSON.stringify(measurement(first, wrapper.plan.hash)));
    let calls = 0;
    await assert.rejects(runPerfAcceptanceSeries(f.planPath, { run: true, resume: true }, {
        validatePlan, ...readyDeps, evaluateRun: () => ({ accepted: true }),
        now: () => Date.parse(createdAt) + plan.maxPairGapMs + 6000,
        runSlot: async () => { calls++; },
    }), /Resume gap within pair/);
    assert.equal(calls, 0);
});

test('runtime input checks reject outputDir mismatch, stale preflight identity, and partial artifacts', async t => {
    const f = await fixture(t);
    const plan = makePlan({ id: 'loaded-artifacts', kind: 'comparison', pairs: 2, identities, createdAt });
    const wrapper = await writeWrapper(f, plan);
    let calls = 0;
    const deps = { validatePlan, ...readyDeps, evaluateRun: () => ({ accepted: true }),
        now: () => Date.parse(createdAt) + 1000, runSlot: async () => { calls++; } };
    const wrongOutput = { ...wrapper, execution: { ...wrapper.execution, outputDir: join(f.root, 'elsewhere') } };
    const wrongOutputPath = join(f.root, 'wrong-output.json');
    await writeFile(wrongOutputPath, JSON.stringify(wrongOutput));
    await assert.rejects(runPerfAcceptanceSeries(wrongOutputPath, { run: true }, deps), /outputDir does not match/);

    await writeFile(f.baselinePreflightPath, JSON.stringify({ identity: { variant: 'candidate' } }));
    const wrongPreflight = { ...wrapper, execution: { ...wrapper.execution,
        preflights: { ...wrapper.execution.preflights, baseline: { ...wrapper.execution.preflights.baseline,
            sha256: await digest(f.baselinePreflightPath) } } } };
    const wrongPreflightPath = join(f.root, 'wrong-preflight.json');
    await writeFile(wrongPreflightPath, JSON.stringify(wrongPreflight));
    await assert.rejects(runPerfAcceptanceSeries(wrongPreflightPath, { run: true }, deps), /baseline preflight does not match current files/);

    const { evaluatePerfAcceptanceRun } = await import('../../../tools/lib/perf-acceptance-policy.mjs');
    const unreadyPath = join(f.root, 'unready-preflight.json');
    await writeFile(unreadyPath, JSON.stringify({ ...wrongPreflight, execution: { ...wrongPreflight.execution,
        preflights: { ...wrongPreflight.execution.preflights,
            baseline: { ...wrongPreflight.execution.preflights.baseline, sha256: await digest(f.baselinePreflightPath) } } } }));
    await assert.rejects(runPerfAcceptanceSeries(unreadyPath, { run: true }, {
        validatePlan, evaluatePreflight: evaluatePerfAcceptanceRun, assertComparablePreflight: () => [],
        evaluateRun: () => ({ accepted: true }), now: () => Date.parse(createdAt) + 1000,
        runSlot: async () => { calls++; },
    }), /baseline preflight is not ready for timing/);

    await writeFile(f.baselinePreflightPath, JSON.stringify({ identity: { variant: 'baseline', renderContext: { dpr: 1 } } }));
    await writeFile(join(f.outputDir, `${plan.slots[0].label}-final.png`), 'partial');
    await assert.rejects(runPerfAcceptanceSeries(f.planPath, { run: true }, deps), /existing capture artifact/);
    assert.equal(calls, 0);
});

test('CLI help runs as a real subprocess without starting capture work', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = resolve(here, '../../../tools/perf-acceptance-series.mjs');
    const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /plan --config FILE/);
    assert.match(result.stdout, /run --plan FILE --run/);
    assert.equal(result.stderr, '');
});

test('real CLI run rejects a correctly hashed but unready preflight before capture', async t => {
    const f = await fixture(t);
    const { createLoadedComparisonPlan } = await import('../../../tools/lib/perf-acceptance-loaded.mjs');
    const identity = variant => ({ variant, scenarioHash: '1'.repeat(64), sourceHash: '2'.repeat(64),
        hostHash: '3'.repeat(64), observerHash: '4'.repeat(64), engineHash: (variant === 'baseline' ? '5' : '6').repeat(64),
        browser: 'Chrome test', gpu: 'ANGLE Metal test', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
        renderContext: { dpr: 1, width: 1600, height: 946, antialias: true, shadows: true, quality: 'high', terrainActive: true } });
    const plan = createLoadedComparisonPlan({ id: 'cli-preflight-gate', pairs: 8, seed: 'a'.repeat(32), createdAt,
        identities: { baseline: identity('baseline'), candidate: identity('candidate') } });
    const baseline = { stage: 'preflight', identity: identity('baseline') };
    const candidate = { stage: 'preflight', identity: identity('candidate') };
    await writeFile(f.baselinePreflightPath, JSON.stringify(baseline));
    await writeFile(f.candidatePreflightPath, JSON.stringify(candidate));
    const wrapper = { schema: 'station3d-perf-loaded-series-v1', plan, execution: {
        configPath: f.configPath, configSha256: await digest(f.configPath), outputDir: f.outputDir,
        preflights: {
            baseline: { path: f.baselinePreflightPath, sha256: await digest(f.baselinePreflightPath) },
            candidate: { path: f.candidatePreflightPath, sha256: await digest(f.candidatePreflightPath) },
        },
    } };
    await writeFile(f.planPath, JSON.stringify(wrapper));
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/perf-acceptance-series.mjs');
    const result = spawnSync(process.execPath, [cli, 'run', '--plan', f.planPath, '--run'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:baseline|candidate) preflight is not ready for timing/);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(f.outputDir), []);
});

test('series plan construction interoperates with the actual randomized loaded-plan contract', async () => {
    const { createLoadedComparisonPlan, validateLoadedComparisonPlan } = await import('../../../tools/lib/perf-acceptance-loaded.mjs');
    const identity = variant => ({ variant, scenarioHash: '1'.repeat(64), sourceHash: '2'.repeat(64),
        hostHash: '3'.repeat(64), observerHash: '4'.repeat(64), engineHash: (variant === 'baseline' ? '5' : '6').repeat(64),
        browser: 'Chrome test', gpu: 'ANGLE Metal test', viewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
        renderContext: { dpr: 1, width: 1600, height: 946, antialias: true, shadows: true, quality: 'high', terrainActive: true } });
    const plan = createLoadedComparisonPlan({ id: 'actual-plan-contract', kind: 'comparison', pairs: 8,
        seed: 'a'.repeat(32), createdAt, identities: { baseline: identity('baseline'), candidate: identity('candidate') } });
    assert.deepEqual(validateLoadedComparisonPlan(plan), []);
    assert.equal(plan.slots.length, 16);
    assert.equal(plan.hash.length, 64);
    assert.equal(plan.slots.filter(slot => slot.role === 'baseline').length, 8);
    assert.equal(plan.slots.filter(slot => slot.role === 'candidate').length, 8);
});

test('real control series plans, captures, compares, and exits successfully through the CLI', async t => {
    const f = await fixture(t);
    const hash = character => character.repeat(64);
    const identity = {
        variant: 'baseline', scenarioHash: hash('1'), sourceHash: hash('2'), hostHash: hash('3'),
        observerHash: hash('4'), engineHash: hash('5'), browser: 'Chrome synthetic', gpu: 'ANGLE synthetic',
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        renderContext: { dpr: 1, width: 1440, height: 900, antialias: true, shadows: true,
            terrainActive: true, quality: 'high' },
    };
    const binding = () => ({ available: true, receiver: 'ground:1', boundMaterials: 2,
        compiledMaterials: 1, tables: ['paint-table'], mismatches: [] });
    const route = [
        { distanceM: 0, lat: 45, lon: 15 },
        { distanceM: 450, lat: 45, lon: 15.0057 },
        { distanceM: 900, lat: 45, lon: 15.0114 },
    ];
    const makePhase = (phase, ratio = 1) => {
        const stationary = phase === 'stationary';
        const durationMs = stationary ? 30000 : 180000;
        const p50Ms = (stationary ? 8 : 9) * ratio;
        const p95Ms = (stationary ? 10 : 12) * ratio;
        return {
            requestedMs: durationMs, durationMs,
            ...(stationary ? {} : { distanceM: 900, route }),
            frames: { n: durationMs / 10, p50Ms, p95Ms, p99Ms: p95Ms * 1.3, maxMs: p95Ms * 2,
                over50: 0, over100: 0, over250: 0 },
            observation: { rawFrames: durationMs / 10, invalidFrames: 0, coveredMs: durationMs },
            longTasks: { count: 0, over50: 0, over100: 0, over250: 0, maxMs: 0, totalMs: 0 },
            host: { clean: false, reasons: ['synthetic loaded host'], evidenceValid: true,
                evidenceReasons: [], samples: 20, elapsedMs: durationMs, platform: 'darwin', cpus: 8 },
            visible: true, renderContextStable: true,
        };
    };
    const baseRun = { complete: true, scenario: { mode: 'rail' }, identity, errors: [], files: { changed: false },
        sources: { sealed: true, missing: [], unexpectedResponses: [], changed: false },
        ready: { reason: 'ready', blockers: [] },
        initialDrain: { state: 'drained', paintBindings: binding() },
        finalDrain: { state: 'drained', paintBindings: binding() },
        lifecycle: { cycles: 2, errors: [], observations: [
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: binding() },
            { state: 'drained', snapshot: { reason: 'ready', drainState: 'drained' }, paintBindings: binding() },
        ] },
        required: { stationaryMs: 30000, movementMs: 180000, minDistanceM: 800, lifecycleCycles: 2 },
        phases: { stationary: makePhase('stationary'), movement: makePhase('movement') },
    };
    const baselinePreflight = { ...structuredClone(baseRun), stage: 'preflight' };
    await writeFile(f.baselinePreflightPath, JSON.stringify(baselinePreflight));
    const createdAt = '2026-10-08T00:00:00.000Z';
    const wrapper = await createPerfAcceptanceSeries({ configPath: f.configPath, planPath: f.planPath,
        id: 'real-control-series', kind: 'control', pairs: 2, seed: 'b'.repeat(32), createdAt,
        baselinePreflightPath: f.baselinePreflightPath }, { createdAt,
        inspectVariant: async ({ variant }) => ({ identity: { ...identity, variant } }),
    });
    assert.deepEqual(wrapper.plan.slots.map(slot => slot.variant), ['baseline', 'baseline', 'baseline', 'baseline']);

    let cursor = Date.parse(createdAt) + 60000;
    const run = await runPerfAcceptanceSeries(f.planPath, { run: true }, {
        now: () => cursor,
        runSlot: async ({ slot }) => {
            if (slot.index > 0) cursor += slot.index % 2 === 1 ? 1000 : 10000;
            const startedAt = cursor;
            const finishedAt = startedAt + 220000;
            const receipt = { ...structuredClone(baseRun), stage: 'measure', measurementProfile: 'loaded',
                label: slot.label, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
                experiment: { planHash: wrapper.plan.hash, slot: slot.index } };
            const receiptPath = join(f.outputDir, `${slot.label}.json`);
            await writeFile(receiptPath, JSON.stringify(receipt));
            cursor = finishedAt;
            return { receiptPath, exitCode: 0 };
        },
    });
    assert.equal(run.complete, true, JSON.stringify({ reason: run.reason, stoppedAt: run.stoppedAt }));
    assert.equal(run.receipts.length, 4);
    assert.ok(run.receipts.every(receipt => receipt.identity.variant === 'baseline'));

    const verdict = await comparePerfAcceptanceSeries(f.planPath);
    assert.equal(verdict.comparable, true);
    assert.equal(verdict.decision, 'control-descriptive');
    assert.equal(verdict.accepted, false);

    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/perf-acceptance-series.mjs');
    const compared = spawnSync(process.execPath, [cli, 'compare', '--plan', f.planPath], { encoding: 'utf8' });
    assert.equal(compared.status, 0, compared.stderr);
    const cliVerdict = JSON.parse(compared.stdout);
    assert.equal(cliVerdict.decision, 'control-descriptive');
    assert.equal(cliVerdict.comparable, true);
    assert.equal(cliVerdict.accepted, false);
});
