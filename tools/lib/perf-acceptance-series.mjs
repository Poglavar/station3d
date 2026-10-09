// Orchestrate a fixed, predeclared series of loaded-host acceptance captures.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluatePerfAcceptanceRun, assertComparablePreflight } from './perf-acceptance-policy.mjs';
import { loadedRoutePolicyForScenario } from './perf-acceptance-loaded.mjs';

export const SERIES_SCHEMA = 'station3d-perf-loaded-series-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
const HASH_RE = /^[a-f0-9]{64}$/i;
let loadedApi;
async function getLoadedApi() { return loadedApi ||= await import('./perf-acceptance-loaded.mjs'); }

export function perfAcceptanceSeriesPassed(kind, verdict) {
    if (kind === 'control') return verdict?.comparable === true
        && ['control-consistent', 'control-descriptive'].includes(verdict.decision);
    return verdict?.accepted === true;
}

function assertPlan(plan, validatePlan) {
    const reasons = validatePlan(plan);
    if (reasons.length) throw new Error(`Invalid comparison plan: ${reasons.join('; ')}`);
}

function validateWrapperShape(wrapper) {
    if (!HASH_RE.test(wrapper?.plan?.hash || '')) throw new Error('Loaded-series wrapper plan hash is invalid');
    const execution = wrapper?.execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) throw new Error('Loaded-series wrapper execution is missing');
    if (typeof execution.configPath !== 'string' || !isAbsolute(execution.configPath)) {
        throw new Error('Loaded-series wrapper execution.configPath must be an absolute path');
    }
    if (!HASH_RE.test(execution.configSha256 || '')) throw new Error('Loaded-series wrapper execution.configSha256 is invalid');
    if (typeof execution.outputDir !== 'string' || !isAbsolute(execution.outputDir)) {
        throw new Error('Loaded-series wrapper execution.outputDir must be an absolute path');
    }
    const required = new Set((wrapper.plan.slots || []).map(slot => slot.variant));
    if (!execution.preflights || typeof execution.preflights !== 'object' || Array.isArray(execution.preflights)) {
        throw new Error('Loaded-series wrapper execution.preflights is missing');
    }
    for (const variant of required) {
        const record = execution.preflights[variant];
        if (!record || typeof record.path !== 'string' || !isAbsolute(record.path) || !HASH_RE.test(record.sha256 || '')) {
            throw new Error(`Loaded-series wrapper preflight ${variant} is malformed`);
        }
    }
}

function assertConfiguredOutputDir(configBytes, wrapper) {
    let config;
    try { config = JSON.parse(configBytes.toString('utf8')); }
    catch (error) { throw new Error(`Could not parse pinned acceptance config: ${error.message}`); }
    if (typeof config.outputDir !== 'string' || !config.outputDir) throw new Error('Pinned acceptance config outputDir is missing');
    const expected = resolve(dirname(wrapper.execution.configPath), config.outputDir);
    if (resolve(wrapper.execution.outputDir) !== expected) {
        throw new Error('Loaded-series wrapper outputDir does not match config.outputDir');
    }
    return config;
}

function assertReady(preflight, label, expectedIdentity = null, comparePreflight = assertComparablePreflight,
    evaluatePreflight = evaluatePerfAcceptanceRun) {
    const verdict = evaluatePreflight(preflight);
    if (!verdict.readyForTiming) throw new Error(`${label} preflight is not ready for timing: ${verdict.reasons.join('; ')}`);
    if (expectedIdentity) {
        const mismatch = comparePreflight(preflight, expectedIdentity);
        if (mismatch.length) throw new Error(`${label} preflight does not match current files: ${mismatch.join('; ')}`);
    }
}

export async function createPerfAcceptanceSeries({
    configPath, planPath, id, kind = 'comparison', pairs = 12, seed,
    baselinePreflightPath, candidatePreflightPath, maxPairGapMs = 300000,
    distanceTolerance = 0.05, pathToleranceM = 5,
}, dependencies = {}) {
    const read = dependencies.readFile || readFile;
    const write = dependencies.writeFile || writeFile;
    const api = dependencies.createPlan && dependencies.validatePlan ? dependencies : await getLoadedApi();
    const makePlan = dependencies.createPlan || api.createLoadedComparisonPlan;
    const validatePlan = dependencies.validatePlan || api.validateLoadedComparisonPlan;
    const evaluatePreflight = dependencies.evaluatePreflight || evaluatePerfAcceptanceRun;
    const comparePreflight = dependencies.assertComparablePreflight || assertComparablePreflight;
    const configAbs = resolve(configPath), planAbs = resolve(planPath);
    const configBytes = await read(configAbs);
    const config = JSON.parse(configBytes.toString('utf8'));
    if (!safeId(id)) throw new Error('--id must be filename-safe lowercase letters, digits, and hyphens');
    if (kind !== 'comparison' && kind !== 'control') throw new Error('--kind must be comparison or control');
    if (!baselinePreflightPath) throw new Error('--baseline-preflight is required');
    if (kind === 'comparison' && !candidatePreflightPath) throw new Error('--candidate-preflight is required for comparison');

    const baselinePath = resolve(baselinePreflightPath);
    const candidatePath = kind === 'control' ? baselinePath : resolve(candidatePreflightPath);
    const [baselineBytes, candidateBytes] = await Promise.all([read(baselinePath), kind === 'control' ? read(baselinePath) : read(candidatePath)]);
    const [baseline, candidate] = [JSON.parse(baselineBytes.toString('utf8')), JSON.parse(candidateBytes.toString('utf8'))];
    assertReady(baseline, 'baseline', null, comparePreflight, evaluatePreflight);
    if (kind === 'comparison') assertReady(candidate, 'candidate', null, comparePreflight, evaluatePreflight);

    const inspect = dependencies.inspectVariant;
    if (typeof inspect !== 'function') throw new TypeError('inspectVariant dependency is required');
    const identities = {};
    for (const variant of ['baseline', ...(kind === 'comparison' ? ['candidate'] : [])]) {
        const preflight = variant === 'baseline' ? baseline : candidate;
        const inspected = await inspect({ configPath: configAbs, variant });
        const identity = inspected?.identity;
        if (!identity) throw new Error(`${variant} inspect did not return an identity`);
        const expected = { ...identity, renderContext: preflight.identity?.renderContext,
            browser: preflight.identity?.browser, gpu: preflight.identity?.gpu };
        assertReady(preflight, variant, expected, comparePreflight, evaluatePreflight);
        identities[variant] = preflight.identity;
    }
    if (kind === 'control') identities.candidate = identities.baseline;

    const createdAt = dependencies.createdAt || new Date().toISOString();
    const routePolicy = loadedRoutePolicyForScenario(config.scenario, baseline.phases?.movement);
    const plan = makePlan({ id, kind, pairs, seed, identities, createdAt, maxPairGapMs, distanceTolerance, pathToleranceM, routePolicy });
    assertPlan(plan, validatePlan);
    const outputKey = config.outputDir;
    if (typeof outputKey !== 'string' || !outputKey) throw new Error('config.outputDir must be explicit');
    const outputDir = resolve(dirname(configAbs), outputKey);
    const wrapper = {
        schema: SERIES_SCHEMA,
        plan,
        execution: {
            configPath: configAbs,
            configSha256: hash(configBytes),
            preflights: {
                baseline: { path: baselinePath, sha256: hash(baselineBytes) },
                ...(kind === 'comparison' ? { candidate: { path: candidatePath, sha256: hash(candidateBytes) } } : {}),
            },
            outputDir,
        },
    };
    await mkdir(dirname(planAbs), { recursive: true });
    await write(planAbs, `${JSON.stringify(wrapper, null, 2)}\n`, { flag: 'wx' });
    return wrapper;
}

export async function readPerfAcceptanceSeries(planPath, dependencies = {}) {
    const read = dependencies.readFile || readFile;
    const api = dependencies.validatePlan ? dependencies : await getLoadedApi();
    const validatePlan = dependencies.validatePlan || api.validateLoadedComparisonPlan;
    const wrapperPath = resolve(planPath);
    const wrapper = JSON.parse((await read(wrapperPath, 'utf8')).toString());
    if (wrapper?.schema !== SERIES_SCHEMA || !wrapper.plan || !wrapper.execution) throw new Error('Invalid loaded-series wrapper');
    validateWrapperShape(wrapper);
    assertPlan(wrapper.plan, validatePlan);
    return { wrapper, wrapperPath };
}

export async function verifySeriesInputs(wrapper, dependencies = {}) {
    const read = dependencies.readFile || readFile;
    const execution = wrapper.execution;
    const configBytes = await read(execution.configPath);
    if (hash(configBytes) !== execution.configSha256) throw new Error('Config bytes changed after the series was planned');
    const config = assertConfiguredOutputDir(configBytes, wrapper);
    const preflights = {};
    for (const [variant, record] of Object.entries(execution.preflights || {})) {
        const bytes = await read(record.path);
        if (hash(bytes) !== record.sha256) throw new Error(`${variant} preflight bytes changed after the series was planned`);
        preflights[variant] = JSON.parse(bytes.toString('utf8'));
    }
    const comparePreflight = dependencies.assertComparablePreflight || assertComparablePreflight;
    const evaluatePreflight = dependencies.evaluatePreflight || evaluatePerfAcceptanceRun;
    for (const variant of new Set(wrapper.plan.slots.map(slot => slot.variant))) {
        const preflight = preflights[variant];
        const planned = wrapper.plan.identities?.[variant];
        assertReady(preflight, variant, planned, comparePreflight, evaluatePreflight);
    }
    const routePolicy = loadedRoutePolicyForScenario(config.scenario, preflights.baseline?.phases?.movement);
    if (!isDeepStrictEqual(wrapper.plan.routePolicy, routePolicy)) {
        throw new Error('Planned route policy does not match the pinned scenario and baseline preflight');
    }
    return { configBytes, preflights };
}

function runFile(outputDir, slot) { return resolve(outputDir, `${slot.label}.json`); }

function plannedIdentityMatches(run, planned, variant) {
    const actual = run?.identity;
    if (!actual || !planned || actual.variant !== variant) return false;
    for (const field of ['scenarioHash', 'sourceHash', 'hostHash', 'observerHash', 'engineHash', 'browser', 'gpu']) {
        if (actual[field] !== planned[field]) return false;
    }
    for (const field of ['width', 'height', 'deviceScaleFactor']) {
        if (actual.viewport?.[field] !== planned.viewport?.[field]) return false;
    }
    for (const field of ['dpr', 'width', 'height', 'antialias', 'shadows', 'quality', 'terrainActive']) {
        if (actual.renderContext?.[field] !== planned.renderContext?.[field]) return false;
    }
    return true;
}

function receiptTime(receipt, field, slot) {
    const value = Date.parse(receipt?.[field]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Receipt ${slot.label} has invalid ${field}`);
    return value;
}

function validateSeriesReceipt(plan, slot, receipt, previous = null, dependencies = {}) {
    const checkRun = dependencies.evaluateRun || (run => evaluatePerfAcceptanceRun(run, { hostMode: 'loaded' }));
    const verdict = checkRun(receipt);
    if (!verdict.accepted || receipt.stage !== 'measure') throw new Error(`Receipt ${slot.label} is not an accepted measurement`);
    if (receipt.measurementProfile !== 'loaded') throw new Error(`Receipt ${slot.label} is not from the loaded measurement profile`);
    if (receipt.label !== slot.label) throw new Error(`Receipt label does not match planned slot ${slot.label}`);
    if (receipt.experiment?.planHash !== plan.hash || receipt.experiment?.slot !== slot.index) {
        throw new Error(`Receipt ${slot.label} has the wrong experiment plan or slot identity`);
    }
    const planned = plan.identities?.[slot.variant];
    if (!plannedIdentityMatches(receipt, planned, slot.variant)) throw new Error(`Receipt ${slot.label} identity does not match its planned variant`);
    const startedAt = receiptTime(receipt, 'startedAt', slot);
    const finishedAt = receiptTime(receipt, 'finishedAt', slot);
    if (finishedAt <= startedAt) throw new Error(`Receipt ${slot.label} has a nonpositive duration`);
    const createdAt = Date.parse(plan.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error('Plan createdAt is invalid');
    if (startedAt < createdAt) throw new Error(`Receipt ${slot.label} started before the plan was created`);
    if (previous) {
        const previousFinished = receiptTime(previous.receipt, 'finishedAt', previous.slot);
        if (startedAt < previousFinished) throw new Error(`Receipt ${slot.label} overlaps the previous planned slot`);
        if (slot.pair === previous.slot.pair && startedAt - previousFinished > plan.maxPairGapMs) {
            throw new Error(`Receipt ${slot.label} exceeds the maximum within-pair gap`);
        }
    }
    return { startedAt, finishedAt };
}

function slotArtifacts(outputDir, slot, config) {
    const names = [`${slot.label}.json`, `${slot.label}-stationary-frames.json`, `${slot.label}-movement-frames.json`,
        `${slot.label}-stationary.png`, `${slot.label}-movement.png`, `${slot.label}-final.png`,
        `${slot.label}-requests.json`, `${slot.label}-served.json`];
    if (config.diagnosticCpuProfile === true) names.push(`${slot.label}-diagnostic.cpuprofile`);
    return names.map(name => resolve(outputDir, name));
}

async function assertSlotArtifactsAbsent(outputDir, slot, config, list = readdir) {
    let names;
    try { names = await list(outputDir); }
    catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
    const prefixes = slotArtifacts(outputDir, slot, config).map(file => file.slice(outputDir.length + 1));
    const found = names.find(name => prefixes.includes(name) || name.startsWith(`${slot.label}-`));
    if (found) {
        throw new Error(`Refusing to overwrite existing capture artifact: ${resolve(outputDir, found)}`);
    }
}

export async function runPerfAcceptanceSeries(planPath, { resume = false, run = false } = {}, dependencies = {}) {
    if (!run) throw new Error('Actual captures require explicit --run');
    const { wrapper, wrapperPath } = await readPerfAcceptanceSeries(planPath, dependencies);
    const api = dependencies.validatePlan ? dependencies : await getLoadedApi();
    const validatePlan = dependencies.validatePlan || api.validateLoadedComparisonPlan;
    assertPlan(wrapper.plan, validatePlan);
    const { preflights } = await verifySeriesInputs(wrapper, dependencies);
    const slots = wrapper.plan.slots;
    const read = dependencies.readFile || readFile;
    const fileExists = dependencies.access || access;
    const checkRun = dependencies.evaluateRun || (receipt => evaluatePerfAcceptanceRun(receipt, { hostMode: 'loaded' }));
    const runner = dependencies.runSlot;
    if (typeof runner !== 'function') throw new TypeError('runSlot dependency is required');

    const config = assertConfiguredOutputDir(await read(wrapper.execution.configPath), wrapper);
    let prefix = 0;
    const existing = [];
    let previous = null;
    for (let index = 0; index < slots.length; index++) {
        const slot = slots[index];
        const file = runFile(wrapper.execution.outputDir, slot);
        let present = true;
        try { await fileExists(file); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
        if (!present) break;
        if (!resume) throw new Error(`Refusing to overwrite existing receipt: ${file}`);
        const receipt = JSON.parse((await read(file, 'utf8')).toString());
        try { validateSeriesReceipt(wrapper.plan, slot, receipt, previous, dependencies); }
        catch (error) { throw new Error(`Existing prefix receipt ${slot.label} is invalid: ${error.message}`); }
        existing.push(receipt);
        previous = { receipt, slot };
        prefix++;
    }
    // A later receipt beyond the valid prefix cannot be skipped or replaced.
    if (prefix < slots.length) {
        for (let index = prefix + 1; index < slots.length; index++) {
            try { await fileExists(runFile(wrapper.execution.outputDir, slots[index])); }
            catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
            throw new Error(`Receipt exists after missing slot ${slots[prefix].label}; cannot resume out of order`);
        }
    }

    const now = dependencies.now || Date.now;
    if (prefix > 0 && prefix < slots.length && slots[prefix - 1].pair === slots[prefix].pair) {
        const previousFinished = receiptTime(existing.at(-1), 'finishedAt', slots[prefix - 1]);
        if (now() - previousFinished > wrapper.plan.maxPairGapMs) {
            throw new Error(`Resume gap within pair ${slots[prefix].pair} exceeds maxPairGapMs`);
        }
    }
    dependencies.onResume?.({ count: prefix, nextSlot: slots[prefix] || null });

    const receipts = [...existing];
    for (let index = prefix; index < slots.length; index++) {
        await verifySeriesInputs(wrapper, dependencies);
        const slot = slots[index];
        if (previous && slot.pair === previous.slot.pair) {
            const previousFinished = receiptTime(previous.receipt, 'finishedAt', previous.slot);
            if (now() - previousFinished > wrapper.plan.maxPairGapMs) {
                return { complete: false, resumed: prefix, stoppedAt: slot.index, receipts,
                    reason: `Gap within pair ${slot.pair} exceeds maxPairGapMs` };
            }
        }
        await assertSlotArtifactsAbsent(wrapper.execution.outputDir, slot, config, dependencies.listDir || readdir);
        const preflight = preflights[slot.variant] || preflights.baseline;
        let runResult;
        try {
            runResult = await runner({
                configPath: wrapper.execution.configPath,
                wrapperPath,
                slot: { ...slot, total: slots.length },
                preflightPath: slot.variant === 'candidate' ? wrapper.execution.preflights.candidate.path : wrapper.execution.preflights.baseline.path,
                preflight,
                outputDir: wrapper.execution.outputDir,
            });
        } catch (error) {
            return { complete: false, resumed: prefix, stoppedAt: slot.index, receipts, reason: error.message };
        }
        const receiptPath = typeof runResult === 'string' ? runResult : runResult?.receiptPath || runFile(wrapper.execution.outputDir, slot);
        let receipt = null;
        try { receipt = JSON.parse((await read(receiptPath, 'utf8')).toString()); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!receipt) return { complete: false, resumed: prefix, stoppedAt: slot.index, receipts,
            reason: runResult?.error || `Capture ${slot.label} did not produce a receipt` };
        receipts.push(receipt);
        try {
            validateSeriesReceipt(wrapper.plan, slot, receipt, previous, dependencies);
        } catch (error) {
            return { complete: false, resumed: prefix, stoppedAt: slot.index, receipts,
                reason: runResult?.error || error.message };
        }
        if (runResult?.exitCode !== undefined && runResult.exitCode !== 0) {
            return { complete: false, resumed: prefix, stoppedAt: slot.index, receipts,
                reason: runResult?.error || `Capture ${slot.label} was not accepted as a completed run` };
        }
        previous = { receipt, slot };
    }
    return { complete: true, resumed: prefix, receipts };
}

export async function comparePerfAcceptanceSeries(planPath, dependencies = {}) {
    const { wrapper } = await readPerfAcceptanceSeries(planPath, dependencies);
    const read = dependencies.readFile || readFile;
    const api = dependencies.compareRuns ? dependencies : await getLoadedApi();
    const compare = dependencies.compareRuns || api.compareLoadedPerfRuns;
    const runs = await Promise.all(wrapper.plan.slots.map(async slot => {
        try { return JSON.parse((await read(runFile(wrapper.execution.outputDir, slot), 'utf8')).toString()); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    return compare(wrapper.plan, runs);
}
