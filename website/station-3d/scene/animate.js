// Main render loop. Exposes a small before-render hook registry so modes can
// participate per-frame without this file reaching into them. Sky + sun
// dynamics live in scene/sky.js; we just invoke updateSky() each frame.
//
// FPS overlay: ON by default when serving locally (localhost / 127.0.0.1
// / [::1] / *.local), so dev work always sees frame timing. On any other
// host (i.e. prod), it starts off and is only created after an explicit
// opt-in: plain F, `?stats=1`, or `localStorage.station3dStats = '1'`.

import Stats from 'three/addons/libs/stats.module.js';
import { logStamp } from '../core/log-stamp.js';
import {
    scene,
    camera,
    renderer,
    observeRenderQualitySample,
    isAutoRenderQualityActive,
} from './setup.js';
import { updateSky } from './sky.js';
import { updateRain } from './rain.js';
import { getBackgroundActivitySnapshot } from '../core/background-activity.js';
import {
    getFrameChunkMotionState,
    getFrameChunkSchedulerSnapshot,
    noteFrameChunkSceneWork,
} from '../core/frame-chunk-queue.js';
import {
    MINIMAP_LAYOUT_EVENT,
    resolvePerformanceHudLayout,
} from '../core/hud-overlay-layout.js';
import {
    pruneStutterLog,
    recordStutter,
    STUTTER_MS,
    STUTTER_WINDOW_MS,
    unattributedHooksMs,
    unclaimedStallMs,
    performanceOverlayKeyAllowed,
} from '../core/perf-overlay-model.js';
import { setOutOfLoopWorkSink } from '../core/out-of-loop-work.js';
import { getSessionHost } from '../core/session-host.js';
import { createRenderCallAttributor } from '../core/render-call-attribution.js';
import { createRenderQualityWindow } from '../core/quality-profile.js';
import { createGpuFrameTimer } from '../core/gpu-frame-timer.js';
import { shouldRenderWorldFrame } from '../core/loading-render-policy.js';
import { restoreAbsoluteRenderCoordinates } from '../core/render-origin.js';
import { isWorldBuilding } from '../core/world-ready.js';
import {
    drawCallAttributionEnabled,
    resolvePerfProfilerMode,
} from '../core/perf-run-contract.js';
import { enforceTerrainInspection } from './terrain-inspection.js';
import { enforceInspectionLayerVisibility } from '../core/scene-inspection.js';
import { createPerfOverlayView } from '../ui/perf-overlay-view.js';
import {
    createHostLoadState,
    describeHostBlame,
    describeHostLoad,
    HOST_BLAME_MIN_INTERVAL_MS,
    HOST_BLAME_URL,
    hostLoadVerdict,
    recordProbeSample,
    runContentionProbe,
} from '../core/host-load.js';

let animationHandle = null;
const beforeRenderHooks = new Set();
const afterRenderHooks = new Set();

let stats = null;

// ── Per-frame timing diagnostic ────────────────────────────────────────────
// Stats (the existing FPS panel) only times renderer.render. The bulk of
// per-frame work happens inside the registered before-render hooks (cab
// mode iterates ~16 layer onFrame callbacks each frame). We track:
//   • hooksMs   — cumulative time spent in beforeRenderHooks
//   • renderMs  — time inside renderer.render
//   • per-layer ms — reported by cab.js via recordLayerFrameMs()
// Aggregated over a 1 s window and printed to a fixed-size overlay docked
// under Stats. Same on/off gating as Stats so prod stays clean.
//
// The box has two panes and a fixed footprint, so it never resizes under your
// eye as the background list grows: live topic sections on top, and below them a
// scrolling LOG of every stutter. The log is why it is worth the height — a
// spike you did not happen to click on used to be gone the moment the next
// window started, so finding one meant sitting and waiting for another.
const PERF_WINDOW_MS = 1000;
let perfOverlay = null;      // the view from ui/perf-overlay-view.js, or null
let perfHooksAccumMs = 0;
let perfRenderAccumMs = 0;
let perfSkyAccumMs = 0;        // time in updateSky() — unmeasured until now
let perfFrameAccumMs = 0;      // full loop period (catches GPU wait / external work)
let lastLoopStartMs = 0;
let perfFrameCount = 0;
let perfWindowStartMs = 0;
// Auto quality must keep working with the developer PERF overlay closed.
// Only timing totals are collected; diagnostic strings/DOM stay gated below.
const qualityWindow = createRenderQualityWindow();
let lastQualitySample = null;
// GPU time of the main render, the auto-DPR governor's evidence. Created only
// while auto quality is active; profilers pause it (one timer query per context).
let gpuFrameTimer = null;
let gpuFrameTimerEnabled = true;

export function setGpuFrameTimerEnabled(enabled) {
    gpuFrameTimerEnabled = enabled !== false;
    gpuFrameTimer?.setEnabled(gpuFrameTimerEnabled);
}
// Worst frame of the current window, kept whole rather than averaged away.
const EMPTY_WORST_FRAME = Object.freeze({
    frameMs: 0, skyMs: 0, hooksMs: 0, renderMs: 0, atMs: 0, background: '', layers: '',
});
// The breakdown of the frame currently being measured. It can only be compared
// against the worst frame ONCE the following loop start reveals how long that
// frame actually took, so it is held here for exactly one iteration.
let pendingFrame = null;
let perfWorstFrame = EMPTY_WORST_FRAME;
// Every stutter, newest first, SURVIVING the window reset. The worst frame is
// cleared every second, so without this a spike is gone before you can look at
// the screen — which is most of why the last one was hard to catch.
let perfStutterHistory = [];
// Counted separately from the log, which is capped: "23 stutters since 12:04:11"
// is a rate you can feel, and it must not stop climbing at the cap.
let perfStutterTotal = 0;
let perfLogStartedAtMs = 0;
// Is the MACHINE giving us a core? Sampled once per window, ~0.05-0.3 ms of
// arithmetic — 0.02% overhead to know whether any of the other numbers mean
// anything. Two slowdowns were investigated as code regressions before this
// existed and turned out to be background load on the laptop.
let hostLoadState = createHostLoadState();
let hostVerdict = { level: 'unknown', ratio: null, contended: false };
// Names of the processes eating the machine, from energy-manager if it is
// running. Only requested while the probe says we are contended.
let hostBlame = null;
let hostBlameAskedAtMs = 0;
// Previous window's monotonic scheduler totals, so this window's spend is a
// DELTA rather than one frame's sample. See describeWorkClasses.
// The last window's readout, as DATA. The overlay renders it; a harness reads
// it. Without this the only way to get a trace out was for a human to click
// `copy` and paste it, which is why diagnosing anything took a round trip per
// question — see tools/perf-trace.mjs.
let lastPerfSnapshot = null;
if (typeof window !== 'undefined') {
    window.__perfTrace = () => (lastPerfSnapshot
        ? JSON.parse(JSON.stringify(lastPerfSnapshot))
        : null);
    // The automated harness measures startup and movement as separate phases.
    // A full reset prevents the last startup frame, queue delta, or one-second
    // average from leaking into the movement capture.
    window.__perfTraceReset = () => resetPerfMeasurement();
}
let lastLifetimeSpentByClass = null;
let lastLifetimeFrames = 0;

// How much each work class actually got during the window just ended.
function windowWorkSpend(scheduler) {
    const now = scheduler?.lifetimeSpentByClass || null;
    const frames = Math.max(1, (Number(scheduler?.lifetimeFrames) || 0) - lastLifetimeFrames);
    if (!now) return { spentByClass: null, frames };
    const previous = lastLifetimeSpentByClass;
    lastLifetimeSpentByClass = { ...now };
    lastLifetimeFrames = Number(scheduler.lifetimeFrames) || 0;
    // First window has no baseline to difference against; report nothing rather
    // than a lifetime total masquerading as one second of work.
    if (!previous) return { spentByClass: null, frames };
    const delta = {};
    for (const [name, ms] of Object.entries(now)) {
        delta[name] = Math.max(0, (Number(ms) || 0) - (Number(previous[name]) || 0));
    }
    return { spentByClass: delta, frames };
}

function maybeAskWhoIsBusy(nowMs) {
    if (!hostVerdict.contended) { hostBlame = null; return; }
    if (nowMs - hostBlameAskedAtMs < HOST_BLAME_MIN_INTERVAL_MS) return;
    if (typeof fetch !== 'function' || !isLocalHost()) return;
    hostBlameAskedAtMs = nowMs;
    // Entirely best-effort: energy-manager may not be running, and the overlay
    // must not care. The contention ratio is the finding; this is only the name.
    fetch(HOST_BLAME_URL, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .then((payload) => { hostBlame = payload ? describeHostBlame(payload) : null; })
        .catch(() => { hostBlame = null; });
}
// Imported, not redeclared: this used to be a second copy of STUTTER_MS kept in
// step by a comment on each side, which is a drift waiting to happen — the
// overlay would have labelled the log "≥33ms" while the loop recorded at some
// other threshold, and nothing would have said so.
const PERF_STUTTER_MS = STUTTER_MS;

// What was building when the stutter happened. Names the pending work only —
// a stream sitting at "loaded" costs nothing, so it would only add noise.
function describeBackgroundPressure() {
    const busy = getBackgroundActivitySnapshot()
        .filter(entry => (entry.pending || 0) > 0 || (entry.retrying || 0) > 0)
        .map(entry => `${entry.label}:${entry.pending || 0}`);
    return busy.length ? busy.join(' ') : 'idle';
}

function describeResourceUploadState() {
    const queues = getFrameChunkSchedulerSnapshot().queues || [];
    const uploads = queues.filter(queue => (
        queue.workClass === 'delivery'
        || /upload|delivery|packet/i.test(String(queue.label || ''))
    ) && Number(queue.pendingItems) > 0);
    return uploads.length
        ? uploads.map(queue => `${queue.label}:${queue.pendingItems}`).join(' ')
        : 'idle';
}
const perfLayerAccum = new Map();   // name → cumulative ms in window
const perfLayerCounts = new Map();  // name → call count in window
const perfLayerThisFrame = new Map();   // name → ms in the frame being measured
const perfProfilerParams = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search || '')
    : new URLSearchParams();
const perfProfilerMode = resolvePerfProfilerMode(perfProfilerParams);
// Per-object callbacks and a scene traversal on every measured frame are useful
// for a draw-call diagnostic, but they materially perturb a timing run. Keep
// the observer absent unless the harness explicitly asks for that separate pass.
const renderCallAttribution = drawCallAttributionEnabled(perfProfilerParams)
    ? createRenderCallAttributor()
    : null;

// Any expanded minimap, walk or cab: both live in the top-left corner, so the
// stats box has to clear whichever one is up. Matching only the walk variant
// left the cab's FPS panel drawn straight over the map.
function expandedMinimapBottom() {
    if (typeof document === 'undefined') return null;
    const wrap = document.querySelector('.station-3d-minimap-wrap');
    const panel = wrap?.querySelector('.station-3d-minimap-panel');
    if (!wrap || !panel
        || wrap.style.display === 'none'
        || panel.style.display === 'none') return null;
    const rect = panel.getBoundingClientRect();
    return rect.height > 0 ? rect.bottom : null;
}

function layoutPerformanceHud() {
    const statsHeight = stats?.dom?.getBoundingClientRect?.().height;
    const layout = resolvePerformanceHudLayout({
        expandedMinimapBottomPx: expandedMinimapBottom(),
        statsHeightPx: statsHeight,
        viewportHeightPx: typeof window !== 'undefined' ? window.innerHeight : null,
    });
    if (stats?.dom) stats.dom.style.top = `${layout.statsTopPx}px`;
    if (perfOverlay) perfOverlay.setTop(layout.perfTopPx);
}

export function recordLayerFrameMs(name, ms) {
    if (!perfOverlay || !Number.isFinite(ms)) return;
    perfLayerAccum.set(name, (perfLayerAccum.get(name) || 0) + ms);
    perfLayerCounts.set(name, (perfLayerCounts.get(name) || 0) + 1);
    // Also THIS frame alone. The window average cannot name a stutter: one 500 ms
    // frame among a hundred good ones barely moves a per-second mean, which is the
    // whole reason the worst frame is kept whole.
    perfLayerThisFrame.set(name, (perfLayerThisFrame.get(name) || 0) + ms);
}

// Detailed hot-path timers are enabled only when their destination exists, so
// ordinary sessions do not pay for extra performance.now() calls.
export function isPerformanceProfilingActive() {
    return perfOverlay !== null;
}

// Our own work that ran BETWEEN two loop starts, keyed by reporter name. Not
// merged into perfLayerThisFrame because the two are charged to different
// frames: a layer hook belongs to the frame whose callbacks ran it, whereas a
// queue flush belongs to the frame PERIOD it filled — which is the period
// measured at the NEXT loop start. Folding it in with the layers would shift
// every queue cost one frame away from the stutter it caused, which is the same
// off-by-one that once reported every stall as unattributed.
let perfOutOfLoop = new Map();
// Main-thread tasks over ~50 ms observed in the current period, from
// PerformanceObserver. Says whether an unclaimed gap was the page running code
// at all, or time the page never got.
let perfLongTaskMs = 0;
let longTaskObserver = null;

function startLongTaskObserver() {
    if (longTaskObserver || typeof PerformanceObserver !== 'function') return;
    try {
        longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) perfLongTaskMs += entry.duration || 0;
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
        // Not supported here (Safari, older Chrome). The unclaimed figure still
        // works; only the "was it a task?" hint is missing, and a diagnostic
        // that throws on an unsupported browser is worse than one that degrades.
        longTaskObserver = null;
    }
}

function stopLongTaskObserver() {
    longTaskObserver?.disconnect?.();
    longTaskObserver = null;
    perfLongTaskMs = 0;
}

function observeQualityIfDue(nowMs) {
    const timing = qualityWindow.takeSample(nowMs);
    if (!timing) return null;
    // These inventories are already maintained by the scheduler/producers.
    // Snapshot them once per second; never construct per-frame descriptions in
    // production just to drive adaptive DPR.
    const scheduler = getFrameChunkSchedulerSnapshot();
    const background = getBackgroundActivitySnapshot();
    const backgroundPending = (scheduler.queues || []).some(queue => (
        (queue.workClass === 'near' || queue.workClass === 'delivery')
        && Number(queue.pendingItems) > 0
    ));
    const compilerPending = background.some(entry => (
        /compiler|worker/i.test(String(entry?.label || entry?.kind || ''))
        && Number(entry?.pending) > 0
    ));
    const uploadPending = (scheduler.queues || []).some(queue => (
        (queue.workClass === 'delivery'
            || /upload|delivery|packet/i.test(String(queue.label || '')))
        && Number(queue.pendingItems) > 0
    ));
    const sample = {
        ...timing,
        backgroundPending,
        compilerPending,
        uploadPending,
    };
    const gpu = gpuFrameTimer?.takeWindow() || null;
    sample.gpuMs = gpu?.medianMs ?? null;
    sample.gpuFrames = gpu?.frames ?? 0;
    const result = observeRenderQualitySample(sample);
    lastQualitySample = { ...sample, result };
    return lastQualitySample;
}

// The layers that filled one frame, biggest first — only those worth naming.
function describeFrameLayers(layerMs) {
    const parts = [];
    for (const [name, ms] of [...layerMs.entries()].sort((a, b) => b[1] - a[1])) {
        if (ms < 1) break;
        parts.push(`${name}:${ms.toFixed(0)}`);
        // Keep enough nested ownership to explain a composite transaction.
        // Five labels hid every rail build phase behind the layer total, the
        // refresh total, and its formation queries on the actual extreme frame.
        if (parts.length >= 12) break;
    }
    return parts.join(' ');
}

function clearStutterLog() {
    perfStutterHistory = [];
    perfStutterTotal = 0;
    perfLogStartedAtMs = performance.now();
}

function resetPerfMeasurement() {
    clearStutterLog();
    perfOverlay?.clear?.();
    perfHooksAccumMs = 0;
    perfRenderAccumMs = 0;
    perfSkyAccumMs = 0;
    perfFrameAccumMs = 0;
    perfFrameCount = 0;
    perfWindowStartMs = performance.now();
    lastLoopStartMs = 0;
    pendingFrame = null;
    perfWorstFrame = EMPTY_WORST_FRAME;
    perfLayerAccum.clear();
    perfLayerCounts.clear();
    perfLayerThisFrame.clear();
    perfOutOfLoop.clear();
    renderCallAttribution?.reset();
    perfLongTaskMs = 0;
    lastLifetimeSpentByClass = null;
    lastLifetimeFrames = 0;
    lastPerfSnapshot = null;
    return { startedAtMs: perfLogStartedAtMs };
}

function maybeInitPerfOverlay() {
    if (perfOverlay) return;
    if (!stats) return;            // piggy-back Stats gating
    if (typeof document === 'undefined') return;
    perfOverlay = createPerfOverlayView({ onClear: clearStutterLog });
    // Only now does reporting cost anything: before this the sink is unset and
    // every reportOutOfLoopWork call returns immediately, so instrumenting a
    // module does not make it slower for users who never open the overlay.
    setOutOfLoopWorkSink((name, ms) => {
        perfOutOfLoop.set(name, (perfOutOfLoop.get(name) || 0) + ms);
    });
    startLongTaskObserver();
    perfLogStartedAtMs = performance.now();
    if (overlaysHidden) perfOverlay.setVisible(false);   // respect an earlier F toggle
    document.body.appendChild(perfOverlay.el);
    layoutPerformanceHud();
    perfWindowStartMs = performance.now();
}

function dumpPerfIfDue(nowMs) {
    if (!perfOverlay) return;
    const elapsed = nowMs - perfWindowStartMs;
    if (elapsed < PERF_WINDOW_MS) return;
    const n = perfFrameCount || 1;
    const fps = (perfFrameCount * 1000) / Math.max(1, elapsed);
    const hooksAvg = perfHooksAccumMs / n;
    const renderAvg = perfRenderAccumMs / n;

    // Pull GPU-side stats from three.js. `renderer.info.render` is a live
    // object reset internally each frame; we sample it after the most
    // recent render so the numbers reflect a real frame. Pixel ratio and
    // megapixels used to print here too, but they are fixed for a session —
    // a per-second refresh of a constant. `__perfProbe.res()` still reports them.
    // Three keeps the last render counters alive until another render. Do not
    // report those stale calls for frames intentionally skipped behind the
    // opaque loading curtain.
    const info = pendingFrame?.rendered === false
        ? null
        : (renderer && renderer.info && renderer.info.render) || null;
    const gpuAttribution = renderCallAttribution?.takeWindow() || null;

    // Deliberately here, AFTER the frame's render and once per second: its cost
    // lands outside the measured hooks/render and is small enough not to be a
    // stutter itself.
    hostLoadState = recordProbeSample(hostLoadState, runContentionProbe().elapsedMs);
    hostVerdict = hostLoadVerdict(hostLoadState);
    maybeAskWhoIsBusy(nowMs);
    // Also prune on the clock, not only on insert: without this a quiet minute
    // leaves aged-out entries on screen still claiming to be within the window.
    perfStutterHistory = pruneStutterLog(perfStutterHistory, nowMs);

    const layers = [...perfLayerAccum.entries()]
        .map(([name, ms]) => ({ name, avgMs: ms / (perfLayerCounts.get(name) || 1) }))
        .sort((a, b) => b.avgMs - a.avgMs)
        .slice(0, 8);

    const skyAvg = perfSkyAccumMs / n;
    const frameAvg = perfFrameAccumMs / Math.max(1, n);
    // stall = frame time NOT spent in sky/hooks/render CPU. Big stall = GPU-bound
    // or work outside this loop (another rAF, event handler, streaming, GC). It
    // is the same quantity the stutter log calls `stall`; this line used to call
    // it `gap`, so one overlay had two names for the number that decides whether
    // the cost was ours at all.
    const stallAvg = Math.max(0, frameAvg - skyAvg - hooksAvg - renderAvg);
    // Hooks time no layer claimed. A layer only appears in the per-layer list if it
    // calls recordLayerFrameMs, so an uninstrumented one is invisible: its cost
    // just makes `hooks` bigger. That blind spot hid a 507 ms rebuild.
    const claimedPerFrame = new Map(
        [...perfLayerAccum.entries()].map(([name, ms]) => [name, ms / n]),
    );
    let gta = null;
    try {
        gta = typeof window !== 'undefined' && typeof window.__gtaCroatiaDebug === 'function'
            ? window.__gtaCroatiaDebug()
            : null;
    } catch (_error) { /* GTA diagnostics must never perturb the render loop */ }

    const snapshot = {
        fps,
        frameAvgMs: frameAvg,
        skyMs: skyAvg,
        hooksMs: hooksAvg,
        unnamedMs: unattributedHooksMs(hooksAvg, claimedPerFrame),
        renderMs: renderAvg,
        stallMs: stallAvg,
        // The window's worst frame, kept as a bare number: a spike big enough to
        // matter now has its own row in the log below, with the full breakdown.
        peakFrameMs: perfWorstFrame.frameMs,
        gpuCalls: info ? info.calls : 0,
        gpuTriangles: info ? info.triangles : 0,
        gpuPrograms: renderer?.info?.programs?.length || 0,
        gpuAttribution,
        profilerMode: perfProfilerMode,
        gta,
        layers,
        ...(() => {
            const scheduler = getFrameChunkSchedulerSnapshot();
            const work = windowWorkSpend(scheduler);
            return {
                scheduler,
                workSpentByClass: work.spentByClass,
                workFrames: work.frames,
            };
        })(),
        background: getBackgroundActivitySnapshot(),
        hostLoad: describeHostLoad(hostVerdict),
        hostBlame,
        cpuCores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0,
        stutters: perfStutterHistory,
        stutterTotal: perfStutterTotal,
        stutterThresholdMs: PERF_STUTTER_MS,
        stutterWindowMs: STUTTER_WINDOW_MS,
        logStartedAtMs: perfLogStartedAtMs,
    };
    // Same data the overlay is about to draw, kept for window.__perfTrace().
    lastPerfSnapshot = {
        at: Date.now(),
        fps: snapshot.fps,
        frameAvgMs: snapshot.frameAvgMs,
        hooksMs: snapshot.hooksMs,
        unnamedMs: snapshot.unnamedMs,
        renderMs: snapshot.renderMs,
        skyMs: snapshot.skyMs,
        stallMs: snapshot.stallMs,
        peakFrameMs: snapshot.peakFrameMs,
        qualityAdjustment: lastQualitySample?.result || null,
        gpuCalls: snapshot.gpuCalls,
        gpuTriangles: snapshot.gpuTriangles,
        gpuPrograms: snapshot.gpuPrograms,
        gpuAttribution: snapshot.gpuAttribution,
        profilerMode: snapshot.profilerMode,
        gta: snapshot.gta,
        host: { ...hostVerdict },
        hostBlame,
        layers: snapshot.layers,
        workSpentByClass: snapshot.workSpentByClass,
        workFrames: snapshot.workFrames,
        classBudgets: snapshot.scheduler?.classBudgets || {},
        motionState: snapshot.scheduler?.motionState,
        workMotionState: snapshot.scheduler?.workMotionState,
        observerViewMoving: snapshot.scheduler?.observerViewMoving,
        speedMps: snapshot.scheduler?.speedMps,
        queues: (snapshot.scheduler?.queues || []).map(q => ({
            label: q.label, workClass: q.workClass, pendingItems: q.pendingItems,
            // The LABEL, not just the duration: "curbs took 98 ms" starts an
            // investigation, "curbs:parking took 98 ms" ends one. The overlay
            // has shown it since the stage split; a harness reading this
            // projection could not see it, so every attribution still cost a
            // human round trip.
            longestItemMs: q.longestItemMs, longestItemLabel: q.longestItemLabel,
            over50msItems: q.over50msItems,
        })),
        background: snapshot.background,
        stutterTotal: snapshot.stutterTotal,
        // The public __perfTrace accessor deep-clones on demand. Retain this
        // copy-on-write history here instead of cloning every entry once per
        // overlay update, which made diagnostics distort their own window.
        stutters: perfStutterHistory,
        measurementStartedAtMs: snapshot.logStartedAtMs,
        stutterThresholdMs: snapshot.stutterThresholdMs,
        stutterWindowMs: snapshot.stutterWindowMs,
        cpuCores: snapshot.cpuCores,
    };
    perfOverlay.update(snapshot);

    const worst = perfWorstFrame;
    const worstStallMs = Math.max(0, worst.frameMs - worst.skyMs - worst.hooksMs - worst.renderMs);
    // A stutter is also logged to the console, which survives a page the overlay
    // does not — and is greppable, which the overlay is not.
    if (worst.frameMs >= PERF_STUTTER_MS) {
        console.warn(logStamp(), `[perf] stutter ${worst.frameMs.toFixed(0)}ms `
            + `(hooks ${worst.hooksMs.toFixed(1)} render ${worst.renderMs.toFixed(1)} `
            + `stall ${worstStallMs.toFixed(0)}) while building: ${worst.background}`);
    }
    perfWorstFrame = EMPTY_WORST_FRAME;
    perfHooksAccumMs = 0;
    perfRenderAccumMs = 0;
    perfSkyAccumMs = 0;
    perfFrameAccumMs = 0;
    perfFrameCount = 0;
    perfLayerAccum.clear();
    perfLayerCounts.clear();
    perfWindowStartMs = nowMs;
}
function isLocalHost() {
    if (typeof window === 'undefined') return false;
    const h = window.location.hostname;
    return h === 'localhost'
        || h === '127.0.0.1'
        || h === '[::1]'
        || h === '::1'
        || h === ''           // file://
        || h.endsWith('.local');
}
function maybeInitStats({ force = false } = {}) {
    if (typeof window === 'undefined') return;
    const wantedByUrl = new URLSearchParams(window.location.search).has('stats');
    let wantedByStorage = false;
    try { wantedByStorage = window.localStorage.getItem('station3dStats') === '1'; }
    catch (_) { /* private mode */ }
    const wantedByDev = isLocalHost() && getSessionHost().devOverlays !== false;
    // Allow explicit opt-out on localhost too: `?stats=0` overrides the
    // dev default so you can grab a clean screenshot without the overlay.
    const optedOut = new URLSearchParams(window.location.search).get('stats') === '0';
    if (!force && optedOut) return;
    if (!force && !wantedByUrl && !wantedByStorage && !wantedByDev) return;
    if (stats) {
        // stats.module.js owns an anonymous click handler and exposes no
        // disposer. Keep its one panel as a page-lifetime diagnostic singleton
        // instead of leaking a new detached listener on every Station3D open.
        stats.dom.style.display = overlaysHidden ? 'none' : '';
        if (!stats.dom.isConnected) document.body.appendChild(stats.dom);
        layoutPerformanceHud();
        return;
    }
    stats = new Stats();
    // Exempt from the modal-isolation hide rule (transit.css) — see perfOverlay.
    stats.dom.classList.add('station3d-dev-overlay');
    stats.dom.style.position = 'fixed';
    stats.dom.style.left = '20px';
    // Under the health bar + top HUD row in the left column.
    stats.dom.style.top = '109px';
    stats.dom.style.zIndex = '9999';
    document.body.appendChild(stats.dom);
    layoutPerformanceHud();
}

// Press F to reveal/hide the FPS + perf overlays (for diagnostics or clean
// screenshots). Ignored while typing in a field so it doesn't fight text input.
let overlaysHidden = false;
function toggleStatsOverlays() {
    // Production starts clean, but plain F must still be a complete runtime
    // opt-in. Lazily create both panels on the first press instead of toggling
    // two elements that do not exist.
    if (!stats) {
        overlaysHidden = false;
        maybeInitStats({ force: true });
        maybeInitPerfOverlay();
        layoutPerformanceHud();
        return;
    }
    overlaysHidden = !overlaysHidden;
    const disp = overlaysHidden ? 'none' : '';
    if (stats && stats.dom) stats.dom.style.display = disp;
    if (perfOverlay) perfOverlay.setVisible(!overlaysHidden);
    if (!overlaysHidden) layoutPerformanceHud();
}
let performanceListenersBound = false;
function handlePerformanceKeydown(e) {
    // Plain F only — Shift+F belongs to the facade-spec toggle (buildings.js).
    if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
    if (animationHandle === null) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // Deployed hosts: F only toggles overlays that `?stats=1` already opted
    // into; it never mounts them for a player who brushed the key.
    if (!performanceOverlayKeyAllowed({ mounted: !!stats, localHost: isLocalHost(), search: window.location.search })) return;
    toggleStatsOverlays();
}

function bindPerformanceListeners() {
    if (performanceListenersBound || typeof window === 'undefined') return;
    performanceListenersBound = true;
    window.addEventListener(MINIMAP_LAYOUT_EVENT, layoutPerformanceHud);
    window.addEventListener('resize', layoutPerformanceHud);
    window.addEventListener('keydown', handlePerformanceKeydown);
}

function unbindPerformanceListeners() {
    if (!performanceListenersBound || typeof window === 'undefined') return;
    performanceListenersBound = false;
    window.removeEventListener(MINIMAP_LAYOUT_EVENT, layoutPerformanceHud);
    window.removeEventListener('resize', layoutPerformanceHud);
    window.removeEventListener('keydown', handlePerformanceKeydown);
}

// Dev triangle audit: `__sceneTriAudit()` in the console sums triangles per
// top-level scene group (visible geometry only), sorted, so the GPU tri-hog
// behind a low fps is named. The per-frame perf overlay can't see build-once
// geometry (decor, terrain, viaduct); this can. Counts all in-scene geometry,
// pre-frustum-cull, so a group's number is its worst case in view.
if (typeof window !== 'undefined') {
    window.__sceneTriAudit = function sceneTriAudit() {
        const triCount = (o) => {
            const g = o.geometry;
            if (!g) return 0;
            const idx = g.index ? g.index.count
                : (g.attributes && g.attributes.position ? g.attributes.position.count : 0);
            let t = idx / 3;
            if (o.isInstancedMesh && Number.isFinite(o.count)) t *= o.count;
            return t;
        };
        const isDrawable = (o) => o.isMesh || o.isInstancedMesh || o.isBatchedMesh;
        const visible = (o) => { let p = o; while (p) { if (p.visible === false) return false; p = p.parent; } return true; };
        // Collapse a mesh's name to a family key (strip trailing ids like
        // "Building:12345" → "Building") so 83 buildings roll up to one line.
        const family = (o) => {
            const raw = o.name || o.type;
            const base = raw.replace(/[:#].*$/, '').replace(/\d+$/, '');
            return base + (o.isInstancedMesh ? `[×${o.count}]` : o.isBatchedMesh ? '[batched]' : '');
        };
        const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n | 0);
        const rows = [];
        for (const child of scene.children) {
            let sum = 0; let meshes = 0;
            const byFamily = new Map();
            child.traverse((o) => {
                if (!isDrawable(o) || !visible(o)) return;
                const t = triCount(o); sum += t; meshes++;
                const k = family(o);
                const e = byFamily.get(k) || { tris: 0, n: 0 };
                e.tris += t; e.n += 1; byFamily.set(k, e);
            });
            if (sum > 0) rows.push({ name: child.name || child.type, tris: sum, meshes, byFamily });
        }
        rows.sort((a, b) => b.tris - a.tris);
        const total = rows.reduce((s, r) => s + r.tris, 0);
        const lines = [`SCENE TRI AUDIT — total ${fmt(total)} (visible, pre-cull)`];
        for (const r of rows) {
            lines.push(`${fmt(r.tris).padStart(9)}  ${String(r.meshes).padStart(5)} obj  ${r.name}`);
            const kids = [...r.byFamily.entries()].sort((a, b) => b[1].tris - a[1].tris).slice(0, 4);
            if (r.byFamily.size > 1 || (kids[0] && kids[0][0] !== r.name)) {
                for (const [k, e] of kids) lines.push(`            ${fmt(e.tris).padStart(9)}  ${String(e.n).padStart(4)}×  ${k}`);
            }
        }
        const out = lines.join('\n');
        console.log(out);
        return out;
    };
}

// Dev fill-rate probe: when fps is low but tris/draw-calls are small, the cost
// is fragment/overdraw. Toggle candidates live and watch the perf overlay:
//   __perfProbe.shadows(false)   → is it the shadow pass?
//   __perfProbe.groups()         → list top-level groups (index, visible, tris)
//   __perfProbe.toggle(3)        → hide/show group #3, see if fps jumps
//   __perfProbe.only(3)          → show ONLY group #3 (isolate a culprit)
//   __perfProbe.all()            → restore every group visible
if (typeof window !== 'undefined') {
    const triOf = (o) => {
        const g = o.geometry; if (!g) return 0;
        const idx = g.index ? g.index.count : (g.attributes && g.attributes.position ? g.attributes.position.count : 0);
        return (idx / 3) * (o.isInstancedMesh && Number.isFinite(o.count) ? o.count : 1);
    };
    const groupTris = (c) => { let t = 0; c.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) t += triOf(o); }); return t; };
    const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n | 0);
    window.__perfProbe = {
        shadows(on) {
            renderer.shadowMap.enabled = on === undefined ? !renderer.shadowMap.enabled : !!on;
            scene.traverse((o) => { if (o.material) { const m = o.material; (Array.isArray(m) ? m : [m]).forEach((mm) => { mm.needsUpdate = true; }); } });
            return `shadowMap.enabled = ${renderer.shadowMap.enabled}`;
        },
        // Turn every transmissive material on/off live. three.js re-renders the
        // WHOLE SCENE into a transmission target, with mipmaps, once per frame
        // for any object with transmission > 0 — a second full render that the
        // draw-call count does not show. If fps jumps when you call this, the
        // cost is transmission, not geometry.
        //   __perfProbe.transmission(false)  → strip it, watch the perf overlay
        //   __perfProbe.transmission(true)   → put it back
        transmission(on) {
            let touched = 0;
            scene.traverse((o) => {
                const materials = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of materials) {
                    if (!m || !('transmission' in m)) continue;
                    if (on === false) {
                        if (m.transmission > 0) { m.__savedTransmission = m.transmission; m.transmission = 0; m.needsUpdate = true; touched++; }
                    } else if (m.__savedTransmission > 0) {
                        m.transmission = m.__savedTransmission; m.needsUpdate = true; touched++;
                    }
                }
            });
            return `${on === false ? 'stripped' : 'restored'} transmission on ${touched} material(s)`;
        },
        groups() {
            return scene.children
                .map((c, i) => ({ i, on: c.visible, name: c.name || c.type, tris: groupTris(c) }))
                .sort((a, b) => b.tris - a.tris)
                .map((r) => `${String(r.i).padStart(3)}  ${r.on ? 'ON ' : 'off'}  ${fmt(r.tris).padStart(8)}  ${r.name}`)
                .join('\n');
        },
        toggle(i) { const c = scene.children[i]; if (!c) return `no child ${i}`; c.visible = !c.visible; return `${i} ${c.name || c.type} → ${c.visible}`; },
        only(i) { scene.children.forEach((c, k) => { c.visible = k === i; }); return `only ${i} = ${scene.children[i] && (scene.children[i].name || scene.children[i].type)}`; },
        all() { scene.children.forEach((c) => { c.visible = true; }); return 'all visible'; },
        // Hands-free turn so the gap reproduces without holding a key. spin(false) stops.
        spin(on) {
            window.dispatchEvent(new KeyboardEvent(on === false ? 'keyup' : 'keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }));
            return on === false ? 'stopped turning' : 'turning — read the perf box';
        },
        // Shrink the render buffer to ~nothing. If the frame is STILL slow while
        // turning, the cost is NOT GPU fill-rate — it's CPU / outside the loop.
        // res(1) restores full resolution.
        res(scale = 0.12) {
            const c = renderer.domElement;
            const w = c.clientWidth || c.width;
            const h = c.clientHeight || c.height;
            const s = scale >= 1 ? (window.devicePixelRatio || 1) : scale;
            renderer.setPixelRatio(s);
            renderer.setSize(w, h, true);
            return `render buffer → ${Math.round(w * (scale >= 1 ? 1 : scale))}×${Math.round(h * (scale >= 1 ? 1 : scale))} — turn and check fps`;
        },
        // Trace main-thread cost OUTSIDE the render loop. Counts rAF/timer
        // callbacks (a 2nd rAF loop shows as ~2× the expected rate) and records
        // the biggest long tasks with their source script. Run while turning:
        //   __perfProbe.spin(true); await __perfProbe.trace(2000); __perfProbe.spin(false)
        async trace(ms = 2000) {
            const origRAF = window.requestAnimationFrame.bind(window);
            const origTO = window.setTimeout.bind(window);
            const origIV = window.setInterval.bind(window);
            let rafN = 0; let toN = 0; let ivN = 0;
            const lt = [];
            let po = null;
            try {
                po = new PerformanceObserver((list) => {
                    for (const e of list.getEntries()) {
                        const at = e.attribution && e.attribution[0];
                        lt.push({ d: e.duration, a: (at && (at.containerSrc || at.containerName || at.containerType)) || e.name });
                    }
                });
                po.observe({ entryTypes: ['longtask'] });
            } catch (_e) { /* longtask API unavailable */ }
            window.requestAnimationFrame = (cb) => { rafN++; return origRAF(cb); };
            window.setTimeout = (fn, t, ...r) => { toN++; return origTO(fn, t, ...r); };
            window.setInterval = (fn, t, ...r) => { ivN++; return origIV(fn, t, ...r); };
            await new Promise((res) => origTO(res, ms));
            window.requestAnimationFrame = origRAF;
            window.setTimeout = origTO;
            window.setInterval = origIV;
            if (po) po.disconnect();
            const secs = ms / 1000;
            lt.sort((a, b) => b.d - a.d);
            const out = {
                rafPerSec: Math.round(rafN / secs),
                setTimeoutPerSec: Math.round(toN / secs),
                setIntervalRegistered: ivN,
                topLongTasks: lt.slice(0, 8).map((t) => `${t.d.toFixed(0)}ms  ${t.a}`),
            };
            console.log('PERF TRACE', JSON.stringify(out, null, 2));
            return out;
        },
    };
    // Automated fill-rate benchmark: HOLD THE CAMERA STILL facing the slow view,
    // run `await __perfBench()`. It measures baseline fps, then hides each heavy
    // group in turn and re-measures. Biggest Δfps = biggest fill cost in this
    // view — that's the group to optimise. Restores everything when done.
    window.__perfBench = async function perfBench({ frames = 12, minTris = 15000 } = {}) {
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const median = async () => {
            for (let i = 0; i < 3; i++) await raf();          // warmup
            const t = []; let last = performance.now();
            for (let i = 0; i < frames; i++) { await raf(); const now = performance.now(); t.push(now - last); last = now; }
            t.sort((a, b) => a - b); const ms = t[t.length >> 1]; return { ms, fps: 1000 / ms };
        };
        const snap = scene.children.map((c) => c.visible);
        const targets = scene.children
            .map((c, i) => ({ i, c, name: c.name || c.type, tris: groupTris(c) }))
            .filter((r) => r.tris >= minTris && snap[r.i])
            .sort((a, b) => b.tris - a.tris);
        const base = await median();
        const lines = [`baseline (all on): ${base.fps.toFixed(1)} fps  (${base.ms.toFixed(0)}ms/frame)`];
        for (const r of targets) {
            r.c.visible = false;
            const m = await median();
            r.c.visible = true;
            const d = m.fps - base.fps;
            lines.push(`hide ${r.name.padEnd(16)} → ${m.fps.toFixed(1).padStart(6)} fps  (Δ ${d >= 0 ? '+' : ''}${d.toFixed(1)})  [${fmt(r.tris)} tris]`);
        }
        scene.children.forEach((c, i) => { c.visible = snap[i]; });
        const report = 'PERF BENCH — biggest Δfps = biggest fill cost in this view\n' + lines.join('\n');
        console.log(report);
        return report;
    };
}

// Register a function to run every frame before renderer.render.
// Returns an unregister function.
export function onBeforeRender(fn) {
    beforeRenderHooks.add(fn);
    return () => beforeRenderHooks.delete(fn);
}

// Observers here see an actual nonzero canvas render, after camera updates and
// Three's render-origin restoration. A scheduling RAF alone is not that proof.
export function onAfterRender(fn) {
    afterRenderHooks.add(fn);
    return () => afterRenderHooks.delete(fn);
}

export function startLoop() {
    if (animationHandle !== null) return;
    bindPerformanceListeners();
    lastLoopStartMs = 0;
    pendingFrame = null;
    qualityWindow.reset(performance.now());
    maybeInitStats();
    // Mount diagnostics before the first world frame. A slow/throwing startup
    // hook must not leave the PERF window absent precisely while loading is
    // stalled; its initial DOM carries an explicit warming state.
    maybeInitPerfOverlay();
    const loop = () => {
        animationHandle = requestAnimationFrame(loop);
        const tLoop0 = performance.now();
        // Full frame period: gap between successive loop starts. Catches time
        // the CPU spends OUTSIDE this loop (GPU stall waiting for the next rAF,
        // other rAF loops, event handlers, streaming rebuilds, GC).
        const framePeriodMs = lastLoopStartMs ? tLoop0 - lastLoopStartMs : 0;
        if (lastLoopStartMs) perfFrameAccumMs += framePeriodMs;
        lastLoopStartMs = tLoop0;
        // The period that just elapsed was filled by the PREVIOUS frame's work,
        // so that is the breakdown it must be judged with. Pairing it with the
        // frame about to run — which is what this did — reported every stall as
        // unattributed: a 660 ms period printed beside the next frame's 0.7 ms of
        // hooks, so the cost looked like it had happened outside the loop when it
        // had happened inside the previous pass through it.
        if (pendingFrame) {
            const stallMs = Math.max(0, framePeriodMs
                - pendingFrame.skyMs - pendingFrame.hooksMs - pendingFrame.renderMs);
            const nextHistory = recordStutter(
                perfStutterHistory,
                {
                    ...pendingFrame,
                    frameMs: framePeriodMs,
                    // Reported between the previous loop start and this one, so
                    // this is exactly the work that filled the period being
                    // judged. See perfOutOfLoop.
                    outside: describeFrameLayers(perfOutOfLoop),
                    unclaimedStallMs: unclaimedStallMs(stallMs, perfOutOfLoop),
                    longTaskMs: perfLongTaskMs,
                    // What render NORMALLY costs here (last completed window),
                    // so the log can tell a render SPIKE from render being the
                    // session's floor. Without it, a 114 ms frame whose render
                    // was 104 ms got headlined by a 2 ms decor slice — the
                    // biggest NAMED part — which sent the reader after decor.
                    renderBaselineMs: lastPerfSnapshot ? lastPerfSnapshot.renderMs : 0,
                },
            );
            // recordStutter returns the SAME array when the frame was ordinary or
            // was a repeat, so identity is what says a stutter really landed. The
            // running total has to outlive the capped log: "23 since 12:04:11" is
            // a rate, and it must not stop climbing at sixty.
            if (nextHistory !== perfStutterHistory) perfStutterTotal += 1;
            perfStutterHistory = nextHistory;
        }
        if (pendingFrame && framePeriodMs > perfWorstFrame.frameMs) {
            perfWorstFrame = {
                ...pendingFrame,
                frameMs: framePeriodMs,
            };
        }
        if (pendingFrame) {
            qualityWindow.addFrame(pendingFrame, framePeriodMs, perfLongTaskMs);
        }
        // Cleared only after the period they filled has been judged above.
        perfOutOfLoop.clear();
        perfLongTaskMs = 0;
        if (stats) stats.begin();
        updateSky();
        const tHooks0 = performance.now();
        perfSkyAccumMs += tHooks0 - tLoop0;   // updateSky (+ stats.begin, negligible)
        // Rain motion is invisible behind the opaque world-build curtain and
        // has no bearing on construction. The first revealed frame resumes it.
        if (!isWorldBuilding()) updateRain(tLoop0);
        for (const fn of beforeRenderHooks) fn();
        enforceTerrainInspection();
        enforceInspectionLayerVisibility();
        const canvas = renderer.domElement;
        // Read readiness after the hooks: cabStep can complete world building
        // in this very turn, in which case this becomes the required first
        // real frame and its after-render hook releases the session.
        const renderFrame = shouldRenderWorldFrame({
            worldBuilding: isWorldBuilding(),
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
        });
        if (renderFrame && perfOverlay && renderCallAttribution) {
            const attributionStartedAt = performance.now();
            const scanned = renderCallAttribution.refresh(scene, attributionStartedAt);
            if (scanned > 0) {
                recordLayerFrameMs(
                    'perf:draw-scan',
                    performance.now() - attributionStartedAt,
                );
            }
        }
        const tHooks1 = performance.now();
        if (renderFrame && perfOverlay && renderCallAttribution) renderCallAttribution.beginFrame();
        if (renderFrame) {
            const timeGpu = isAutoRenderQualityActive();
            if (timeGpu && !gpuFrameTimer) {
                gpuFrameTimer = createGpuFrameTimer(renderer.getContext());
                gpuFrameTimer.setEnabled(gpuFrameTimerEnabled);
            }
            if (timeGpu) gpuFrameTimer.begin();
            renderer.render(scene, camera);
            if (timeGpu) gpuFrameTimer.end();
            for (const fn of afterRenderHooks) fn();
        } else {
            // cabStep prepares floating-origin coordinates as its final CPU
            // operation. Scene.onAfterRender normally restores them; without a
            // draw we must do so now before queue RAFs observe the scene.
            restoreAbsoluteRenderCoordinates();
        }
        const frameGpuAttribution = renderFrame && perfOverlay && renderCallAttribution
            ? renderCallAttribution.endFrame(renderer?.info?.render?.calls || 0)
            : null;
        const tRender1 = performance.now();
        if (stats) stats.end();
        // Diagnostic accounting.
        perfHooksAccumMs += tHooks1 - tHooks0;
        perfRenderAccumMs += tRender1 - tHooks1;
        perfFrameCount += 1;
        // A hitch every few seconds is INVISIBLE in the averages above — one 120 ms
        // frame among sixty good ones moves a 1 s mean by 2 ms. So the worst frame
        // of the window is kept whole, with the breakdown of THAT frame, which is
        // what says whether a stall was our CPU (hooks/render) or something
        // outside the loop (a streamed build, a GPU upload, GC).
        // Hold this frame's own breakdown for the next iteration to judge, once
        // the following loop start reveals how long this frame really took.
        const frameEvidenceStartedAt = performance.now();
        const frameBackground = perfOverlay ? describeBackgroundPressure() : '';
        const frameResourceUploadState = perfOverlay ? describeResourceUploadState() : '';
        const frameEvidenceMs = performance.now() - frameEvidenceStartedAt;
        if (perfOverlay && frameEvidenceMs >= 1) {
            perfOutOfLoop.set(
                'perf:frameEvidence',
                (perfOutOfLoop.get('perf:frameEvidence') || 0) + frameEvidenceMs,
            );
        }
        pendingFrame = {
            skyMs: tHooks0 - tLoop0,
            hooksMs: tHooks1 - tHooks0,
            renderMs: tRender1 - tHooks1,
            atMs: tLoop0,
            // These diagnostics allocate proportional to the number of active
            // producers/layers. Keep them entirely off the production hot path
            // until the performance overlay is actually enabled.
            background: frameBackground,
            layers: perfOverlay ? describeFrameLayers(perfLayerThisFrame) : '',
            rendered: renderFrame,
            gpuCalls: renderFrame && perfOverlay ? Number(renderer?.info?.render?.calls) || 0 : 0,
            gpuTriangles: renderFrame && perfOverlay ? Number(renderer?.info?.render?.triangles) || 0 : 0,
            gpuPrograms: perfOverlay ? renderer?.info?.programs?.length || 0 : 0,
            gpuGeometries: perfOverlay ? Number(renderer?.info?.memory?.geometries) || 0 : 0,
            gpuTextures: perfOverlay ? Number(renderer?.info?.memory?.textures) || 0 : 0,
            gpuAttribution: frameGpuAttribution,
            resourceUploadState: frameResourceUploadState,
            hostBusy: hostVerdict.contended,
            // From the scheduler, which already tracks it to size the work
            // budget — the same signal that CAUSES the catch-up burst is what
            // labels it, so the two can never disagree.
            stationary: getFrameChunkMotionState() === 'stationary',
        };
        perfLayerThisFrame.clear();
        const perfWindowUpdateStartedAt = performance.now();
        observeQualityIfDue(tRender1);
        dumpPerfIfDue(tRender1);
        const perfWindowUpdateMs = performance.now() - perfWindowUpdateStartedAt;
        if (perfOverlay && perfWindowUpdateMs >= 1) {
            perfOutOfLoop.set(
                'perf:windowUpdate',
                (perfOutOfLoop.get('perf:windowUpdate') || 0) + perfWindowUpdateMs,
            );
        }
        noteFrameChunkSceneWork(performance.now() - tLoop0);
    };
    loop();
}

export function stopLoop() {
    if (animationHandle !== null) {
        cancelAnimationFrame(animationHandle);
        animationHandle = null;
    }
    if (stats) {
        stats.dom.style.display = 'none';
    }
    if (perfOverlay) {
        perfOverlay.destroy();
        perfOverlay = null;
    }
    unbindPerformanceListeners();
    stopLongTaskObserver();
    setOutOfLoopWorkSink(null);
    perfHooksAccumMs = 0;
    perfRenderAccumMs = 0;
    perfFrameCount = 0;
    perfWindowStartMs = 0;
    lastLoopStartMs = 0;
    pendingFrame = null;
    lastQualitySample = null;
    gpuFrameTimer?.dispose();
    gpuFrameTimer = null;
    qualityWindow.reset();
    perfWorstFrame = EMPTY_WORST_FRAME;
    perfLayerAccum.clear();
    perfLayerCounts.clear();
    perfLayerThisFrame.clear();
    perfOutOfLoop.clear();
    renderCallAttribution?.reset();
    // The log belongs to the session that produced it: leaving it would show the
    // previous ride's spikes against the next ride's clock.
    perfStutterHistory = [];
    perfStutterTotal = 0;
    hostLoadState = createHostLoadState();
    hostVerdict = { level: 'unknown', ratio: null, contended: false };
    hostBlame = null;
    hostBlameAskedAtMs = 0;
    lastLifetimeSpentByClass = null;
    lastLifetimeFrames = 0;
    // F is a page-lifetime presentation choice. Campaign scene changes close
    // and reopen Station3D sessions; resetting here made the dev HUD cover the
    // next scene even after the player explicitly hid it.
}

export function isLoopRunning() {
    return animationHandle !== null;
}
