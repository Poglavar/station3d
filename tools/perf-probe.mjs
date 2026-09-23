// Engine-local, host-agnostic performance probe for any page that opens a Station3D session.
// Records frame intervals, GPU time (EXT_disjoint_timer_query_webgl2), GL draw/program/upload
// counts per framebuffer, a scene census and host paging for each window, so CPU-bound,
// GPU-bound and host-contended frames can be told apart. Diagnostic evidence, not a benchmark.
//
// Usage:
//   node tools/perf-probe.mjs --run --url 'http://localhost:8095/transit.html?st3d=walk&...'
//   node tools/perf-probe.mjs --run --url URL --window 10 --walk 30 --cpu-profile --label walk
//   node tools/perf-probe.mjs --run --url URL --dsf 2 --init-script host-config.js
//
// Playwright is not an engine dependency: it is resolved from the working directory (a consumer
// checkout or any directory with `playwright`/`@playwright/test` installed) or from --playwright.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import {
    displayPeriodMs, hostWindowVerdict, parseProcVmstat, parseVmStat, summarizeGpuMs, summarizeIntervals,
} from './lib/perf-probe-summary.mjs';

const argv = process.argv.slice(2);
const has = name => argv.includes(name);
const arg = (name, fallback) => (argv.includes(name) && argv[argv.indexOf(name) + 1] !== undefined
    ? argv[argv.indexOf(name) + 1] : fallback);
const USAGE = `Usage: node tools/perf-probe.mjs --run --url URL [options]
  --label NAME          output name (default probe)
  --out DIR             output directory (default ./perf-probe-results)
  --window N            stationary measurement window, seconds (default 10)
  --walk N              then walk out/back (W/S) for N seconds and measure that window
  --drain-wait N        wait up to N s for queues/ground to drain before measuring (default 0)
  --ready-timeout N     seconds to wait for the loading curtain (default 180)
  --dsf N               device scale factor (default 1)
  --quality high|medium|low   localStorage station3dQuality (default: page default)
  --init-script FILE    script injected before page load (host/provider configuration)
  --cpu-profile         write a V8 CPU profile per window
  --screenshot          save a PNG after each window
  --playwright PATH     module to load Playwright from`;
if (has('--help') || !has('--run')) { console.log(USAGE); process.exit(has('--help') ? 0 : 2); }
const url = arg('--url');
if (!url) { console.error('--url is required'); process.exit(2); }
const numberArg = (name, fallback) => {
    const value = Number(arg(name, fallback));
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
    return value;
};
const config = { url, label: arg('--label', 'probe'), windowS: numberArg('--window', 10),
    walkS: numberArg('--walk', 0), drainWaitS: numberArg('--drain-wait', 0),
    readyTimeoutS: numberArg('--ready-timeout', 180), dsf: numberArg('--dsf', 1),
    quality: arg('--quality', null), cpuProfile: has('--cpu-profile'), screenshot: has('--screenshot') };
if (!/^[A-Za-z0-9._-]+$/.test(config.label)) throw new Error('Label must be path-safe');
const outDir = resolve(arg('--out', 'perf-probe-results'));
mkdirSync(outDir, { recursive: true });
const initScript = arg('--init-script') ? readFileSync(resolve(arg('--init-script')), 'utf8') : null;

function loadPlaywright() {
    const explicit = arg('--playwright');
    const require = createRequire(resolve(process.cwd(), 'noop.js'));
    for (const name of explicit ? [explicit] : ['playwright', '@playwright/test', './tests/node_modules/@playwright/test']) {
        try { return require(name.startsWith('.') ? resolve(process.cwd(), name) : name); } catch { /* next */ }
    }
    throw new Error('Playwright not found: run from a directory where it is installed or pass --playwright');
}

function readPaging() {
    try {
        if (process.platform === 'darwin') return parseVmStat(execFileSync('vm_stat', [], { encoding: 'utf8' }));
        if (process.platform === 'linux') return parseProcVmstat(readFileSync('/proc/vmstat', 'utf8'));
    } catch { /* unreadable counters are reported as such */ }
    return { pageins: null, swapins: null, swapouts: null };
}

const log = (...parts) => console.log(new Date().toISOString(), config.label, ...parts);
const result = { schemaVersion: 1, config, startedAt: new Date().toISOString(),
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model,
        memoryBytes: os.totalmem() }, windows: {}, errors: [], validity: { valid: false, reasons: [] } };
const save = () => writeFileSync(resolve(outDir, `${config.label}.json`), JSON.stringify(result, null, 2) + '\n');

// ── Page side ──────────────────────────────────────────────────────────────
function pageInstrumentation(quality) {
    if (quality) { try { localStorage.setItem('station3dQuality', quality); } catch { /* storage may be blocked */ } }
    const frames = []; let last = 0;
    const tick = t => { if (last) frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const gl = { on: false, fb: 'screen', perFb: {}, uploadBytes: 0, uploads: 0, texUploads: 0, programs: 0 };
    const proto = WebGL2RenderingContext.prototype;
    const wrap = (name, note) => {
        const original = proto[name];
        proto[name] = function (...args) { if (gl.on) note(...args); return original.apply(this, args); };
    };
    const target = () => (gl.perFb[gl.fb] ||= { draws: 0, instancedDraws: 0, indices: 0 });
    let fbIds = 0; const fbNames = new WeakMap();
    wrap('bindFramebuffer', (_t, fb) => {
        if (!fb) { gl.fb = 'screen'; return; }
        if (!fbNames.has(fb)) fbNames.set(fb, `fb${++fbIds}`);
        gl.fb = fbNames.get(fb);
    });
    wrap('drawElements', (_m, count) => { const t = target(); t.draws++; t.indices += count; });
    wrap('drawArrays', (_m, _f, count) => { const t = target(); t.draws++; t.indices += count; });
    wrap('drawElementsInstanced', (_m, count, _t, _o, n) => { const t = target(); t.draws++; t.instancedDraws++; t.indices += count * n; });
    wrap('drawArraysInstanced', (_m, _f, count, n) => { const t = target(); t.draws++; t.instancedDraws++; t.indices += count * n; });
    wrap('bufferData', (_t, data) => { gl.uploads++; gl.uploadBytes += data?.byteLength || (typeof data === 'number' ? data : 0); });
    wrap('bufferSubData', (_t, _o, data, _s, len) => { gl.uploads++; gl.uploadBytes += len ? len * (data?.BYTES_PER_ELEMENT || 1) : data?.byteLength || 0; });
    for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) wrap(name, () => { gl.texUploads++; });
    wrap('useProgram', () => { gl.programs++; });
    window.__station3dProbeInstrumentation = { frames, gl };
}

async function measureWindow(page, name, seconds, cdp) {
    const before = readPaging(), loadBefore = os.loadavg()[0];
    if (config.cpuProfile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    const data = await page.evaluate(async ms => {
        const probe = window.__station3dProbeInstrumentation, gl = probe.gl;
        Object.assign(gl, { perFb: {}, uploadBytes: 0, uploads: 0, texUploads: 0, programs: 0 });
        probe.frames.length = 0;
        const renderer = window.__st3dDebug?.renderer;
        const ctx = renderer?.getContext?.();
        const ext = ctx?.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
        const queries = []; let rafs = 0;
        // Only one timer query may be open per context: pause the engine's auto-DPR timer.
        if (ext) window.__st3dDebug?.setGpuFrameTimerEnabled?.(false);
        gl.on = true;
        const started = performance.now();
        await new Promise(resolveWindow => {
            const frame = () => {
                if (ext) {
                    if (queries.length && queries.at(-1).open) { ctx.endQuery(ext.TIME_ELAPSED_EXT); queries.at(-1).open = false; }
                    if (performance.now() - started < ms) {
                        const query = ctx.createQuery(); ctx.beginQuery(ext.TIME_ELAPSED_EXT, query);
                        queries.push({ query, open: true });
                    }
                }
                rafs++;
                if (performance.now() - started < ms) requestAnimationFrame(frame); else resolveWindow();
            };
            requestAnimationFrame(frame);
        });
        gl.on = false;
        window.__st3dDebug?.setGpuFrameTimerEnabled?.(true);
        const intervals = probe.frames.slice();
        await new Promise(r => setTimeout(r, 250));
        const gpuMs = [];
        if (ext) {
            const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT);
            for (const { query } of queries) {
                if (!disjoint && ctx.getQueryParameter(query, ctx.QUERY_RESULT_AVAILABLE)) gpuMs.push(ctx.getQueryParameter(query, ctx.QUERY_RESULT) / 1e6);
                ctx.deleteQuery(query);
            }
        }
        const perFrame = value => value / Math.max(1, rafs);
        const scene = window.__st3dDebug?.scene;
        let meshes = 0, visibleMeshes = 0, castShadow = 0; const materials = new Set(), geometries = new Set();
        scene?.traverseVisible(o => { if (!(o.isMesh || o.isLine || o.isPoints)) return; visibleMeshes++;
            if (o.castShadow) castShadow++; geometries.add(o.geometry); for (const m of [].concat(o.material || [])) materials.add(m); });
        scene?.traverse(o => { if (o.isMesh) meshes++; });
        return { intervals, gpuMs: ext ? gpuMs : null,
            gl: { perFramebufferPerFrame: Object.fromEntries(Object.entries(gl.perFb).map(([k, v]) => [k,
                Object.fromEntries(Object.entries(v).map(([f, n]) => [f, Math.round(perFrame(n))]))])),
            programSwitchesPerFrame: perFrame(gl.programs), uploadKBPerFrame: perFrame(gl.uploadBytes) / 1024,
            uploadsPerFrame: perFrame(gl.uploads), textureUploadsPerFrame: perFrame(gl.texUploads) },
            scene: { meshes, visibleMeshes, castShadow, visibleMaterials: materials.size, visibleGeometries: geometries.size },
            renderer: renderer ? { dpr: renderer.getPixelRatio(), width: renderer.domElement.width, height: renderer.domElement.height,
                shadows: renderer.shadowMap.enabled, programs: renderer.info.programs?.length ?? null } : null,
            heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
            // Localhost-only engine debug handle; null on hosts without it.
            shadowCache: window.__st3dDebug?.shadowCache ?? null,
            // Resolved quality profile and the auto-DPR governor's state, when the host exposes them.
            quality: (({ profileId, requestedMode, dpr, autoGovernor } = {}) => ({ profileId, requestedMode, dpr, autoGovernor }))(
                window.Station3D?.getPerformanceContext?.()?.quality) };
    }, seconds * 1000);
    if (config.cpuProfile) {
        const { profile } = await cdp.send('Profiler.stop');
        writeFileSync(resolve(outDir, `${config.label}-${name}.cpuprofile`), JSON.stringify(profile));
    }
    const host = hostWindowVerdict({ before, after: readPaging(), seconds, loadAvg: Math.max(loadBefore, os.loadavg()[0]), cpus: os.cpus().length });
    const summary = { frames: summarizeIntervals(data.intervals), gpu: summarizeGpuMs(data.gpuMs), gl: data.gl,
        scene: data.scene, renderer: data.renderer, heapMB: data.heapMB, shadowCache: data.shadowCache, quality: data.quality, host };
    if (config.screenshot) await page.screenshot({ path: resolve(outDir, `${config.label}-${name}.png`) });
    result.windows[name] = summary;
    log(name, JSON.stringify({ p50: summary.frames.p50Ms, p95: summary.frames.p95Ms, gpu: summary.gpu?.meanMs ?? null, host: host.clean }));
    save();
    return summary;
}

async function drained(page) {
    return page.evaluate(() => {
        const cab = window.__st3dDebug?.state?.cabState, ground = cab?.groundGenerations?.snapshot?.();
        const queues = window.__s3dStreamingReport?.()?.scheduler?.queues || [];
        const background = window.Station3D?.getPerformanceContext?.()?.background || [];
        return !!ground && !ground.pending && !ground.preparing && queues.every(q => !(q.pendingItems > 0))
            && background.every(b => !['pending', 'fetching', 'building', 'retrying'].some(k => b[k] > 0));
    });
}

let browser;
try {
    const { chromium } = loadPlaywright();
    // Headed on purpose: headless falls back to software rasterisation and starves WebGL.
    browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--window-size=1600,1000'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: config.dsf });
    await page.bringToFront();
    const cdp = await page.context().newCDPSession(page);
    page.on('pageerror', error => result.errors.push({ type: 'page', message: error.message }));
    if (initScript) await page.addInitScript(initScript);
    await page.addInitScript(pageInstrumentation, config.quality);
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => document.getElementById('station3DModal')?.dataset.worldBuildState === 'ready',
        undefined, { timeout: config.readyTimeoutS * 1000, polling: 250 });
    result.ready = await page.evaluate(() => { const modal = document.getElementById('station3DModal');
        return { reason: modal?.dataset.worldBuildReason || null, blockers: modal?.dataset.worldBuildBlockers || null }; });
    result.ready.seconds = (Date.now() - started) / 1000;
    result.browser = browser.version();
    result.displayPeriodMs = await page.evaluate(() => new Promise(done => { const rows = []; let last;
        const tick = t => { if (last !== undefined) rows.push(t - last); last = t; if (rows.length === 60) done(rows); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick); })).then(displayPeriodMs);
    log('ready', JSON.stringify(result.ready));
    if (config.drainWaitS > 0) {
        const deadline = Date.now() + config.drainWaitS * 1000; let quiet = 0;
        while (Date.now() < deadline && quiet < 2) { quiet = (await drained(page)) ? quiet + 1 : 0; await page.waitForTimeout(1000); }
        result.drained = quiet >= 2;
    }
    if (config.windowS > 0) await measureWindow(page, 'stationary', config.windowS, cdp);
    if (config.walkS > 0) {
        await page.evaluate(seconds => {
            const origin = window.Station3D.getPose(), startedAt = performance.now(); let back = false;
            const press = (key, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true }));
            const step = () => {
                const pose = window.Station3D.getPose(), north = (pose.lat - origin.lat) * 111_320;
                if (performance.now() - startedAt > seconds * 1000) { press('w', false); press('s', false); return; }
                if (!back && north > 55) back = true; else if (back && north < 2) back = false;
                press('w', !back); press('s', back); setTimeout(step, 100);
            };
            step();
        }, config.walkS);
        await measureWindow(page, 'walk', config.walkS, cdp);
    }
    if (result.ready.reason !== 'ready') result.validity.reasons.push(`loading released by ${result.ready.reason}`);
    for (const [name, summary] of Object.entries(result.windows)) {
        if (!summary.host.clean) result.validity.reasons.push(`${name}: ${summary.host.reasons.join(', ')}`);
    }
    if (result.errors.length) result.validity.reasons.push(`${result.errors.length} page errors`);
    result.validity.valid = result.validity.reasons.length === 0;
} catch (error) {
    result.failure = { message: error.message, stack: error.stack };
    result.validity.reasons.push(error.message);
    log('FAILED', error.message);
} finally {
    result.finishedAt = new Date().toISOString();
    save();
    await browser?.close();
    log('saved', resolve(outDir, `${config.label}.json`), result.validity.valid ? 'valid' : `invalid: ${result.validity.reasons.join('; ')}`);
    if (!result.validity.valid) process.exitCode = 1;
}
