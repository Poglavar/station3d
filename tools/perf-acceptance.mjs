// Record, preflight and measure a native walk/rail route against complete packaged engine builds.
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { openPerfSourceArchive, importPerfSourceArchive } from './lib/perf-source-archive.mjs';
import { openPerfVectorSources, perfReplaySourceHash } from './lib/perf-source-vectors.mjs';
import { fingerprintDirectory, sha256, startPerfReplayServer, hasPerfReplayFailure } from './lib/perf-replay-server.mjs';
import { acceptanceObserverSource } from './lib/perf-acceptance-browser.mjs';
import { captureAcceptanceDiagnostic, acceptanceDiagnosticSourceHash, captureGroundPaintBindings } from './lib/perf-acceptance-diagnostic.mjs';
import { readNativeHostSample, summarizeNativeHostWindow } from './lib/perf-native-host.mjs';
import { summarizeIntervals } from './lib/perf-probe-summary.mjs';
import { evaluatePerfAcceptanceRun, comparePerfAcceptanceRuns, assertComparablePreflight } from './lib/perf-acceptance-policy.mjs';

const usage = `Usage: node tools/perf-acceptance.mjs --config FILE --stage STAGE [options]
  --stage import --seed DIR             clone an existing source archive; original is unchanged
  --stage seal                          freeze the configured archive (does not certify route coverage)
  --stage inspect                       verify source blobs and host/engine identities, no browser
  --stage record --run                  collect missing GET responses during the complete route
  --stage preflight --run               replay the complete route with zero live provider access
  --stage measure --run --preflight FILE  time the exact preflight identity on a quiet host
  --variant baseline|candidate          selected complete packaged distribution (default candidate)
  --label NAME                          unique output name (no overwriting previous runs)
  --compare FILE FILE FILE FILE         evaluate retained ABBA run receipts; no browser
Config requires hostRoot, engines.{baseline,candidate}.dist, sourceArchive, outputDir,
scenario.{id,url,mode,initialPose?,headingDeg?,corridorM?,stationarySeconds,movementSeconds,
readyTimeoutSeconds,drainTimeoutSeconds,minDistanceM,lifecycleCycles}, viewport, quality,
and an optional initScript, playwrightModule, providerBaseUrl, sourceKeyRules and vectorSources.
Provider responses and raw captures remain local. Diagnostics go to stderr; final receipt to stdout.`;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, stage: { type: 'string' }, variant: { type: 'string', default: 'candidate' },
    label: { type: 'string' }, preflight: { type: 'string' }, seed: { type: 'string' },
    run: { type: 'boolean' }, help: { type: 'boolean' }, compare: { type: 'boolean' },
} });
if (values.help || !values.config && !values.compare) { console.log(usage); process.exit(values.help ? 0 : 2); }
if (values.compare) {
    const runs = await Promise.all(positionals.map(file => readFile(resolve(file), 'utf8').then(JSON.parse)));
    const verdict = comparePerfAcceptanceRuns(runs);
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.accepted ? 0 : 1);
}
const configPath = resolve(values.config), configRoot = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const stage = values.stage, variant = values.variant;
if (!['import', 'seal', 'inspect', 'record', 'preflight', 'measure'].includes(stage)) throw new Error('Unknown --stage');
if (!['baseline', 'candidate'].includes(variant)) throw new Error('Unknown --variant');
const pathOf = key => {
    if (typeof key !== 'string' || !key) throw new Error('An explicit filesystem path is required');
    return resolve(configRoot, key);
};
const sourceArchive = pathOf(config.sourceArchive);
const archiveOptions = { rules: config.sourceKeyRules || [], allowedResponses: config.expectedResponses || [] };
if (stage === 'import') {
    if (!values.seed) throw new Error('--seed is required');
    const hash = importPerfSourceArchive(resolve(values.seed), sourceArchive, archiveOptions);
    console.log(JSON.stringify({ stage, sourceHash: hash, sealed: false })); process.exit(0);
}
const archive = openPerfSourceArchive(sourceArchive, { ...archiveOptions, mode: ['record', 'seal'].includes(stage) ? 'record' : 'replay' });
if (stage === 'seal') { console.log(JSON.stringify({ stage, sourceHash: archive.seal(), entries: archive.size, sealed: true })); process.exit(0); }
const vectorSources = await openPerfVectorSources(config.vectorSources || [], { root: configRoot });
const scenario = config.scenario;
if (!scenario || !/^[a-z0-9][a-z0-9-]*$/.test(scenario.id) || !['walk', 'rail'].includes(scenario.mode)
    || typeof scenario.url !== 'string' || !scenario.url.startsWith('/') || scenario.url.startsWith('//')) {
    throw new Error('Scenario needs a safe id, walk/rail mode and root-relative URL');
}
for (const key of ['stationarySeconds', 'movementSeconds', 'readyTimeoutSeconds', 'drainTimeoutSeconds', 'minDistanceM', 'lifecycleCycles']) {
    if (typeof scenario[key] !== 'number' || !Number.isFinite(scenario[key]) || scenario[key] <= 0) throw new Error(`Invalid scenario.${key}`);
}
if (scenario.movementSeconds < 180 || !Number.isInteger(scenario.lifecycleCycles)) throw new Error('Use >=180 seconds of movement and an integer lifecycle count');
if (scenario.mode === 'rail' && !['lat', 'lon', 'headingDeg'].every(key => Number.isFinite(scenario.initialPose?.[key]))) {
    throw new Error('Rail needs an explicit initial pose to stabilize the world anchor');
}
const viewport = config.viewport;
if (!viewport || !['width', 'height', 'deviceScaleFactor'].every(key => Number.isFinite(viewport[key]) && viewport[key] > 0)) throw new Error('Explicit viewport required');
if (!['high', 'medium', 'low'].includes(config.quality)) throw new Error('Use a fixed quality for a paired comparison');
const engine = config.engines?.[variant];
const engineDist = pathOf(engine?.dist), hostRoot = pathOf(config.hostRoot), outputDir = pathOf(config.outputDir);
const hostExcludes = [(config.engineUrlPrefix || '/vendor/station3d/').replace(/^\/+|\/+$/g, '')];
const externalOrigins = config.externalOrigins || [];
const diagnosticSeconds = config.diagnosticSeconds ?? 10;
if (!Number.isFinite(diagnosticSeconds) || diagnosticSeconds <= 0 || diagnosticSeconds > 60) throw new Error('diagnosticSeconds must be between 0 and 60');
const manifest = JSON.parse(await readFile(resolve(engineDist, 'build-manifest.json'), 'utf8'));
if (!Array.isArray(manifest.reviewRequiredInputs) || manifest.reviewRequiredInputs.length) throw new Error('Distribution has review-required or unknown inputs');
await access(resolve(engineDist, 'loader.js'));
const fingerprints = {
    host: await fingerprintDirectory(hostRoot, { exclude: hostExcludes }),
    engine: await fingerprintDirectory(engineDist),
};
const init = config.initScript ? await readFile(pathOf(config.initScript), 'utf8') : '';
const observerConfig = { mode: scenario.mode, initialPose: scenario.initialPose || null, quality: config.quality,
    headingDeg: scenario.headingDeg ?? 0, corridorM: scenario.corridorM ?? 55 };
const observer = acceptanceObserverSource(observerConfig);
const toolRoot = dirname(fileURLToPath(import.meta.url));
// Include the collector and all acceptance helpers, not just the page observer.
const toolingFiles = ['perf-acceptance.mjs', ...readdirSync(resolve(toolRoot, 'lib'))
    .filter(name => /^perf-(acceptance|source-|replay-server|native-host|world-drain|probe-summary)/.test(name))
    .sort().map(name => `lib/${name}`)];
const toolingHash = sha256(JSON.stringify(toolingFiles.map(file => [file, sha256(readFileSync(resolve(toolRoot, file)))])));
const identity = { variant, engineHash: fingerprints.engine.hash, hostHash: fingerprints.host.hash,
    sourceHash: perfReplaySourceHash(archive.hash(), vectorSources), observerHash: sha256(toolingHash + observer + init + acceptanceDiagnosticSourceHash(diagnosticSeconds)),
    scenarioHash: sha256(JSON.stringify({ scenario, quality: config.quality, viewport,
        engineUrlPrefix: config.engineUrlPrefix || '/vendor/station3d/', apiPrefix: config.apiPrefix || '/api/',
        expectedResponses: config.expectedResponses || [], externalOrigins,
        diagnosticSeconds, diagnosticCpuProfile: config.diagnosticCpuProfile === true })), viewport };
if (stage === 'inspect') {
    console.log(JSON.stringify({ stage, identity, sourceEntries: archive.size, sealed: archive.sealed,
        vectorSources: vectorSources.identities,
        files: { host: fingerprints.host.entries.length, engine: fingerprints.engine.entries.length } }, null, 2)); process.exit(0);
}
if (!values.run) throw new Error('Browser capture requires --run');
if (stage !== 'record' && !archive.sealed) throw new Error('Preflight and measurement require sealed sources');
const label = values.label;
if (!label || !/^[a-z0-9][a-z0-9-]*$/.test(label)) throw new Error('Unique filename-safe --label required');
await mkdir(outputDir, { recursive: true });
const resultPath = resolve(outputDir, `${label}.json`);
await writeFile(resultPath, '{}\n', { flag: 'wx' });
const log = (...parts) => console.error(new Date().toISOString(), label, ...parts);
const required = { stationaryMs: scenario.stationarySeconds * 1000, movementMs: scenario.movementSeconds * 1000,
    minDistanceM: scenario.minDistanceM, lifecycleCycles: scenario.lifecycleCycles,
    ...(scenario.mode === 'walk' ? { walkTurns: 2 } : {}) };
const result = { schema: 'station3d-perf-acceptance-run-v1', stage, label, startedAt: new Date().toISOString(),
    complete: false, identity, required, errors: [], phases: {}, lifecycle: { cycles: 0, errors: [], observations: [] },
    sources: { sealed: archive.sealed, missing: [], unexpectedResponses: [], changed: false,
        archiveHash: archive.hash(), vectorSources: vectorSources.identities },
    files: { changed: false },
    engine: { revision: engine.revision || null, packageSha256: engine.packageSha256 || null,
        runtimePatchSha256: engine.runtimePatchSha256 || null },
    toolingHash, hostSamples: [], snapshots: [], scenario };
let browser, server, page, hostTimer;
let interrupted = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
const collectHost = () => result.hostSamples.push(readNativeHostSample());
const expectedResponse = (url, status) => (config.expectedResponses || []).some(rule =>
    new RegExp(rule.pathnamePattern).test(new URL(url).pathname) && rule.statuses.includes(status));
function sourceFailures() {
    if (interrupted) throw new Error(`Capture interrupted by ${interrupted}`);
    if (stage !== 'record' && hasPerfReplayFailure(server.requests)) throw new Error('Frozen-source coverage failed; measurement is invalid');
}
async function checkPaintBindings(observation) {
    observation.paintBindings = await captureGroundPaintBindings(page);
    const binding = observation.paintBindings;
    if (!binding.available || binding.compiledMaterials < 1 || binding.mismatches.length) {
        await save();
        throw new Error('Ground-paint materials retain missing or stale renderer uniforms');
    }
}
async function waitState(predicate, timeoutSeconds, purpose) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastSampleAt = -1, stableAt = null, previousLog = '';
    for (;;) {
        sourceFailures();
        const snapshot = await page.evaluate(() => window.__station3dAcceptance?.sample?.() || null);
        if (snapshot) {
            result.snapshots.push({ purpose, ...snapshot });
            const text = JSON.stringify({ reason: snapshot.reason, drain: snapshot.drainState,
                generation: snapshot.drain.ground?.generation, pending: snapshot.drain.ground?.pending,
                queues: snapshot.drain.queues?.map(row => [row.label, row.pendingItems]) });
            if (text !== previousLog) { log(purpose, text); previousLog = text; await save(); }
            if (snapshot.reason === 'timeout' || snapshot.drainState === 'failed') throw new Error('World preparation failed or timed out');
            if (predicate(snapshot)) stableAt ??= Date.now(); else stableAt = null;
            if (stableAt !== null && Date.now() - stableAt >= 2000) return { state: 'drained', elapsedMs: timeoutSeconds * 1000 - (deadline - Date.now()), snapshot };
            lastSampleAt = snapshot.at;
        }
        if (Date.now() >= deadline) throw new Error(`${purpose} did not finish before its deadline`);
        // Wait on a new observer sample; do not infer readiness from a fixed sleep.
        await page.waitForFunction(previous => (window.__station3dAcceptance?.samples?.at(-1)?.at ?? -1) > previous,
            lastSampleAt, { timeout: Math.min(30000, Math.max(1, deadline - Date.now())), polling: 'raf' });
    }
}
async function runPhase(name, durationMs) {
    collectHost();
    const nativeStart = result.hostSamples.length - 1;
    await page.evaluate(({ name, durationMs }) => window.__station3dAcceptance.start(name, durationMs), { name, durationMs });
    const wallStart = Date.now(), deadline = wallStart + durationMs + 30000;
    let previous = -1;
    while (Date.now() < deadline) {
        sourceFailures();
        await page.waitForFunction(({ name, previous }) => {
            const phase = window.__station3dAcceptance?.phases?.[name];
            return phase?.done || (phase?.states?.at(-1)?.at ?? -1) > previous;
        }, { name, previous }, { timeout: 30000, polling: 'raf' });
        const state = await page.evaluate(name => {
            const phase = window.__station3dAcceptance.phases[name];
            return { done: phase.done, sample: phase.states.at(-1), distanceM: phase.distanceM };
        }, name);
        previous = state.sample?.at ?? previous;
        if (state.done) break;
        if (state.sample && Math.floor((Date.now() - wallStart) / 1000) % 15 === 0) {
            log(name, `${Math.round((Date.now() - wallStart) / 1000)}s`, `distance ${state.distanceM.toFixed(1)}m`, `ground ${state.sample.drainState}`);
        }
    }
    collectHost();
    const raw = await page.evaluate(name => {
        const capture = window.__station3dAcceptance, phase = capture.phases[name];
        return { ...phase, longTasks: capture.read().longTasks.filter(row =>
            row.at >= phase.startedAt && row.at < phase.finishedAt) };
    }, name);
    if (!raw.done) throw new Error(`${name} observer did not complete`);
    const host = summarizeNativeHostWindow(result.hostSamples.slice(nativeStart));
    const intervals = raw.frames.map(row => row.dt), valid = intervals.filter(value => Number.isFinite(value) && value > 0);
    const phase = { ...raw, frames: summarizeIntervals(valid), host,
        renderContextStable: [raw.initial, ...raw.states, raw.final].every(row =>
            Object.entries(result.identity.renderContext).every(([key, value]) => row.render?.[key] === value)),
        observation: { rawFrames: intervals.length, invalidFrames: intervals.length - valid.length,
            coveredMs: valid.reduce((total, value) => total + value, 0) },
        longTasks: { count: raw.longTasks.length, over50: raw.longTasks.filter(row => row.duration >= 50).length,
            over100: raw.longTasks.filter(row => row.duration >= 100).length,
            over250: raw.longTasks.filter(row => row.duration >= 250).length,
            maxMs: Math.max(0, ...raw.longTasks.map(row => row.duration)),
            totalMs: raw.longTasks.reduce((sum, row) => sum + row.duration, 0) } };
    result.phases[name] = phase;
    await writeFile(resolve(outputDir, `${label}-${name}-frames.json`), JSON.stringify(raw.frames));
    log(name, JSON.stringify({ p95: phase.frames.p95Ms, max: phase.frames.maxMs,
        distanceM: phase.distanceM, hostClean: host.clean, pagingMiBps: host.peakSwapMiBPerSecond }));
    await save();
    await page.screenshot({ path: resolve(outputDir, `${label}-${name}.png`) });
}
try {
    const preflight = stage === 'measure'
        ? JSON.parse(await readFile(pathOf(values.preflight), 'utf8')) : null;
    if (preflight) {
        // Full render-context match follows browser startup; reject stale hashes before launching.
        const mismatch = assertComparablePreflight(preflight, { ...identity, renderContext: preflight.identity?.renderContext });
        if (mismatch.length) throw new Error(`Preflight identity rejected: ${mismatch.join('; ')}`);
    }
    const require = createRequire(configPath);
    const { chromium } = require(config.playwrightModule ? pathOf(config.playwrightModule) : 'playwright');
    server = await startPerfReplayServer({ hostRoot, engineDist, archive, recording: stage === 'record',
        providerBaseUrl: config.providerBaseUrl, apiPrefix: config.apiPrefix || '/api/',
        engineUrlPrefix: config.engineUrlPrefix || '/vendor/station3d/', expectedResponses: config.expectedResponses,
        externalOrigins, vectorSources, fingerprints, log });
    collectHost(); hostTimer = setInterval(collectHost, 2000);
    browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
        '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--window-position=40,40', `--window-size=${viewport.width},${viewport.height}`,
    ] });
    result.identity.browser = browser.version();
    page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor, serviceWorkers: 'block' });
    await page.bringToFront();
    page.on('pageerror', error => result.errors.push({ type: 'page', message: error.message, stack: error.stack }));
    page.on('response', response => {
        if (response.status() >= 400 && !expectedResponse(response.url(), response.status())) {
            result.sources.unexpectedResponses.push({ url: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() });
        }
    });
    page.on('requestfailed', request => {
        if (!/ERR_ABORTED/.test(request.failure()?.errorText || '')) result.errors.push({ type: 'network', url: request.url(), message: request.failure()?.errorText });
    });
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== server.origin) {
            if (externalOrigins.includes(url.origin)) {
                const response = await route.fetch({
                    url: `${server.origin}${config.apiPrefix || '/api/'}__external?url=${encodeURIComponent(url.href)}`,
                    maxRedirects: 0, timeout: 100000,
                });
                await route.fulfill({ response });
            } else {
                result.errors.push({ type: 'external-request', url: url.href });
                await route.abort('blockedbyclient');
            }
        } else await route.continue();
    });
    await page.addInitScript({ content: observer });
    await page.addInitScript(({ quality }) => { localStorage.setItem('station3dQuality', quality); }, { quality: config.quality });
    if (init) await page.addInitScript({ content: init });
    await page.goto(new URL(scenario.url, server.origin).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    result.initialDrain = await waitState(row => row.reason === 'ready' && row.drainState === 'drained', scenario.readyTimeoutSeconds, 'initial drain');
    await checkPaintBindings(result.initialDrain);
    const initial = result.initialDrain.snapshot;
    const observedReady = await page.evaluate(() => window.__station3dAcceptance.ready);
    result.ready = { reason: initial.reason, blockers: initial.blockers,
        elapsedMs: observedReady?.at ?? null, observation: 'first normal-ready browser sample' };
    result.identity.renderContext = Object.fromEntries(['dpr', 'width', 'height', 'antialias', 'shadows', 'quality', 'terrainActive']
        .map(key => [key, initial.render?.[key]]));
    result.identity.gpu = await page.evaluate(() => {
        const gl = window.__st3dDebug.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
    });
    if (/swiftshader|llvmpipe|software/i.test(result.identity.gpu || '')) throw new Error('Software rendering is not a timing target');
    if (preflight) {
        const mismatch = assertComparablePreflight(preflight, result.identity);
        if (mismatch.length) throw new Error(`Runtime differs from preflight: ${mismatch.join('; ')}`);
        result.hostAdmission = summarizeNativeHostWindow(result.hostSamples.slice(-4));
        if (!result.hostAdmission.clean) throw new Error(`Host admission rejected: ${result.hostAdmission.reasons.join('; ')}`);
    }
    await runPhase('stationary', required.stationaryMs);
    await waitState(row => row.drainState === 'drained', scenario.drainTimeoutSeconds, 'before movement');
    await runPhase('movement', required.movementMs);
    result.finalDrain = await waitState(row => row.drainState === 'drained', scenario.drainTimeoutSeconds, 'post-stop drain');
    await checkPaintBindings(result.finalDrain);
    collectHost();
    const diagnosticHostStart = result.hostSamples.length - 1;
    result.diagnostic = await captureAcceptanceDiagnostic(page, { seconds: diagnosticSeconds,
        outputProfile: config.diagnosticCpuProfile === true ? resolve(outputDir, `${label}-diagnostic.cpuprofile`) : null });
    collectHost();
    result.diagnostic.host = summarizeNativeHostWindow(result.hostSamples.slice(diagnosticHostStart));
    sourceFailures();
    await save();
    for (let cycle = 0; cycle < scenario.lifecycleCycles; cycle++) {
        const beforeErrors = result.errors.length;
        await page.evaluate(() => window.__station3dAcceptance.close());
        await page.waitForFunction(() => !window.__st3dDebug?.state?.cabState, undefined, { timeout: 30000 });
        await page.evaluate(() => window.__station3dAcceptance.reopen());
        const reopened = await waitState(row => row.reason === 'ready' && row.drainState === 'drained', scenario.readyTimeoutSeconds, `reopen ${cycle + 1}`);
        result.lifecycle.observations.push(reopened);
        await checkPaintBindings(reopened);
        result.lifecycle.errors.push(...result.errors.slice(beforeErrors));
        result.lifecycle.cycles++;
        await save();
    }
    result.complete = true;
} catch (error) {
    result.errors.push({ type: 'capture', message: error.message, stack: error.stack });
    log('rejected', error.message);
} finally {
    if (hostTimer) clearInterval(hostTimer);
    if (page) {
        try {
            result.observer = await page.evaluate(() => window.__station3dAcceptance?.read?.() || null);
            result.errors.push(...(result.observer?.errors || []).map(error => ({ type: 'observer', ...error })));
            await page.screenshot({ path: resolve(outputDir, `${label}-final.png`) });
        } catch (error) { result.errors.push({ type: 'final-observer', message: error.message }); }
    }
    for (const [type, resource] of [['browser-cleanup', browser], ['server-cleanup', server]]) {
        try { await resource?.close(); }
        catch (error) { result.errors.push({ type, message: error.message, stack: error.stack }); }
    }
    if (server) {
        result.sources.missing = [...new Set(server.requests.filter(row => row.hash === null).map(row => row.key))];
        result.errors.push(...server.errors.map(error => ({ type: 'server', ...error })));
        result.sources.requestCount = server.requests.length;
        await writeFile(resolve(outputDir, `${label}-requests.json`), JSON.stringify(server.requests, null, 2));
        await writeFile(resolve(outputDir, `${label}-served.json`), JSON.stringify([...server.served.values()], null, 2));
    }
    try {
        // Re-read disk bytes after the browser exits, so a changed blob or manifest cannot
        // pass merely because the original in-memory manifest still has the same hash.
        const verifiedArchive = openPerfSourceArchive(sourceArchive, { ...archiveOptions, mode: 'replay' });
        const verifiedVectors = await openPerfVectorSources(config.vectorSources || [], { root: configRoot });
        result.sources.finalHash = perfReplaySourceHash(verifiedArchive.hash(), verifiedVectors);
        result.sources.changed = result.sources.finalHash !== identity.sourceHash || verifiedArchive.sealed !== result.sources.sealed;
    } catch (error) {
        result.sources.changed = true;
        result.errors.push({ type: 'source-identity', message: error.message });
    }
    try {
        const finalHost = await fingerprintDirectory(hostRoot, { exclude: hostExcludes });
        const finalEngine = await fingerprintDirectory(engineDist);
        result.files = { changed: finalHost.hash !== identity.hostHash || finalEngine.hash !== identity.engineHash,
            hostHash: finalHost.hash, engineHash: finalEngine.hash };
    } catch (error) {
        result.files.changed = true;
        result.errors.push({ type: 'file-identity', message: error.message });
    }
    result.finishedAt = new Date().toISOString();
    result.verdict = evaluatePerfAcceptanceRun(result);
    await save();
    console.log(JSON.stringify({ receipt: resultPath, ...result.verdict }, null, 2));
    if (!(stage === 'record' ? result.complete && !result.errors.length : stage === 'preflight' ? result.verdict.readyForTiming : result.verdict.accepted)) process.exitCode = 1;
}
