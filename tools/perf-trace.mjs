// Drives the 3D world and records phase-isolated performance evidence without
// requiring a human to copy the F overlay. Timings require headed real-GPU Chrome.
//
// It reads window.__perfTrace() from scene/animate.js, waits for the model-world
// readiness gate, verifies a clean host, resets all counters, and only then
// measures movement. Startup and an optional settled phase are retained
// separately so neither can masquerade as movement.
//
// Usage:
//   node tools/perf-trace.mjs
//   node tools/perf-trace.mjs --seconds 90 --json split-cab.json
//   node tools/perf-trace.mjs --url 'http://localhost:8091/transit.html?...'
//   node tools/perf-trace.mjs --walk 'w:20,arrowleft:12,w:15' --json walk.json
//   node tools/perf-trace.mjs --walk 'w:45' --settle-seconds 15
//   node tools/perf-trace.mjs --expect-gta-occupant controlling
//   node tools/perf-trace.mjs --draw-attribution --json draw-calls.json
//   node tools/perf-trace.mjs --chrome-trace /tmp/station3d-trace.json
//   node tools/perf-trace.mjs --cpu-profile /tmp/station3d.cpuprofile
//   node tools/perf-trace.mjs --heap-profile /tmp/station3d.heapprofile.json
//   node tools/perf-trace.mjs --compare-with baseline.json --json candidate.json
//   node tools/perf-trace.mjs --allow-busy-host        # diagnostic only; marked invalid
//   node tools/perf-trace.mjs --headless               # layout only; marked invalid

import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import {
    isolatePerfTraceMeasurement,
    summarizePerfSamples,
    summarizePerfTrace,
} from '../website/station-3d/core/perf-trace-summary.js';
import { assessPerfHostCoverage } from '../website/station-3d/core/perf-host-coverage.js';
import { summarizePerfDisplayCadence } from '../website/station-3d/core/perf-display-cadence.js';
import {
    formatPerfRunMismatch,
    perfRunCompatibilityMismatches,
    resolvePerfProfilerMode,
} from '../website/station-3d/core/perf-run-contract.js';
import {
    createCdpNetworkRecorder,
    isExpectedCanceledNetworkError,
} from './perf-network.mjs';
import { chromium } from './playwright-runtime.mjs';
import { assertWalkingCorridorMode, assertWalkingCorridorRepeats, corridorPosition } from './perf-walk-corridor.mjs';
import { installPausedStartObserver, preparePerfMovementStart } from './perf-paused-start.mjs';
import { installLegacyReadinessObserver } from './perf-legacy-readiness.mjs';
import { installGroundDriveScenario, groundDriveFailures } from './lib/perf-ground-scenario.mjs';
import { createAuditSourceFixtures } from './lib/surface-audit-fixtures.mjs';
import { createPerfSourceCapture } from './lib/perf-source-capture.mjs';
import { verifyServedCodeResponse, auditCodeFingerprint, prepareGeneratedNativeCode } from './lib/perf-served-code.mjs';
import { installPerfFrameCadence, summarizePerfFrameCadence } from './lib/perf-frame-cadence.mjs';
import { buildingDrainState, captureGroundDrainSample, groundDrainState, waitForGroundDrain } from './lib/perf-ground-drain.mjs';
import { planPinnedTramRoute, installPinnedTramRoute } from './lib/perf-tram-route.mjs';

const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = name => process.argv.includes(name);
const numericArg = (name, fallback, { min = 0 } = {}) => {
    const value = Number(arg(name, String(fallback)));
    if (!Number.isFinite(value) || value < min) {
        throw new Error(name + ' must be a finite number >= ' + min);
    }
    return value;
};

if (flag('--help') || flag('-h')) {
    console.log(`Usage: node tools/perf-trace.mjs [options]

  --url URL                 Scenario URL (default: Split planner cab)
  --seconds N               Autonomous measurement duration (default: 45)
  --walk SCRIPT             Key script, e.g. w:20,arrowleft:12,w:15
  --walk-corridor-m N        Distance-controlled out-and-back walks of N metres
  --walk-corridor-repeats N  Number of out-and-back repetitions (default: 2, maximum: 100)
  --settle-seconds N        Separate stationary phase after movement
  --ground-drain-timeout N  After timing, wait up to N seconds for finite ground work to drain
  --json FILE               Write the complete trace artifact
  --browser-ws URL          Use an owned Playwright browser server with a fresh context
  --keep-browser-on-failure Retain a failed diagnostic page until explicitly closed
  --compare-with FILE       Reject if FILE's scenario/runtime dimensions differ
  --source-fixtures DIR     Replay an existing complete sealed API cassette
  --record-source-fixtures DIR  Record an incomplete API cassette for diagnostics
  --code-dir WEBSITE_ROOT   Verify served native Station3D source bytes
  --draw-attribution        Separate diagnostic pass with per-object draw attribution
  --render-stalls           Separate diagnostic pass naming slow draw/shader calls
  --chrome-trace FILE       Raw Chrome timeline for the movement phase
  --chrome-trace-light      Main-thread timeline without per-command GPU/compositor events
  --cpu-profile FILE        Sampling CPU profile for the movement phase
  --heap-profile FILE       Sampling heap profile for the movement phase (diagnostic)
  --terrain on|off|url      Force elevation on (default), off, or preserve URL policy
  --quality MODE            Pin auto|high|medium|low before boot (default: app default)
  --disable-quic            Use TCP transport on both sides of a controlled A/B
  --ready-timeout N         Startup/world-ready timeout in seconds (default: 120)
  --settled-start           Wait for the initial world queues to drain before movement
  --ground-settled-start    Wait for stable published ground in the 120 m inspection window
  --drive-vehicle car       Start controlling an authored car through the shared engine
  --allow-stationary        Permit a stationary measurement (readiness/host gates still apply)
  --paused-start            Press P at initial cab creation, then resume after --settled-start
  --legacy-native-ready    Observe the pre-telemetry native module's actual ready callback
  --headless                Layout diagnostic only; invalid for timing
  --allow-busy-host         Continue on a busy host; result remains invalid
  --help                    Print this usage and exit`);
    process.exit(0);
}

// The plain planner URL does not start a render loop. planner-cab enters the
// autonomous cab directly, which makes the default run unattended and moving.
const REQUESTED_URL = arg('--url', 'http://localhost:8091/transit.html'
    + '?project=64&loc=split&elevation=1&st3d=planner-cab&line=1&offset=0&dir=1');
const DRAW_ATTRIBUTION = flag('--draw-attribution');
const QUALITY = String(arg('--quality', '')).trim().toLowerCase();
if (QUALITY && !['auto', 'high', 'medium', 'low'].includes(QUALITY)) {
    throw new Error('--quality must be auto, high, medium, or low');
}
const TERRAIN_MODE = String(arg('--terrain', 'on')).trim().toLowerCase();
if (!['on', 'off', 'url'].includes(TERRAIN_MODE)) {
    throw new Error('--terrain must be on, off, or url');
}
const parsedUrl = new globalThis.URL(REQUESTED_URL);
// The timing overlay is always present, while expensive per-object callbacks
// are a separate opt-in pass. Force both flags so copied URLs cannot silently
// change the observer between branches.
parsedUrl.searchParams.set('stats', '1');
parsedUrl.searchParams.set('perfAttribution', DRAW_ATTRIBUTION ? '1' : '0');
parsedUrl.searchParams.set('telemetry', '0');
if (TERRAIN_MODE === 'on') parsedUrl.searchParams.set('elevation', '1');
if (TERRAIN_MODE === 'off') parsedUrl.searchParams.set('elevation', '0');
const URL = parsedUrl.toString();
const PROFILER_MODE = resolvePerfProfilerMode(parsedUrl.searchParams);
const WALK = arg('--walk', '');
const WALK_CORRIDOR_M = numericArg('--walk-corridor-m', 0);
const WALK_CORRIDOR_REPEATS = numericArg('--walk-corridor-repeats', 2, { min: 1 });
assertWalkingCorridorRepeats(WALK_CORRIDOR_REPEATS);
if (flag('--walk-corridor-repeats') && !WALK_CORRIDOR_M) {
    throw new Error('--walk-corridor-repeats requires --walk-corridor-m');
}
if (WALK && WALK_CORRIDOR_M) throw new Error('Choose timed keys or a distance-controlled corridor');
const SECONDS = numericArg('--seconds', 45, { min: 0.1 });
const SETTLE_SECONDS = numericArg('--settle-seconds', 0);
const GROUND_DRAIN_SECONDS = numericArg('--ground-drain-timeout', 0);
if (GROUND_DRAIN_SECONDS > 600) throw new Error('--ground-drain-timeout must not exceed 600 seconds');
const JSON_OUT = arg('--json', '');
const BROWSER_WS = arg('--browser-ws', '');
const KEEP_BROWSER_ON_FAILURE = flag('--keep-browser-on-failure');
if (KEEP_BROWSER_ON_FAILURE && (!BROWSER_WS || !JSON_OUT)) {
    throw new Error('--keep-browser-on-failure requires --browser-ws and --json');
}
const SOURCE_FIXTURES = arg('--source-fixtures', '');
const RECORD_SOURCE_FIXTURES = arg('--record-source-fixtures', '');
if (SOURCE_FIXTURES && RECORD_SOURCE_FIXTURES) throw new Error('--source-fixtures and --record-source-fixtures are mutually exclusive');
const CODE_DIR = arg('--code-dir', '');
const codeFingerprintBefore = CODE_DIR ? auditCodeFingerprint(CODE_DIR) : null;
const generatedNativeCode = CODE_DIR ? await prepareGeneratedNativeCode(path.resolve(CODE_DIR)) : new Map();
const sourceFixtures = SOURCE_FIXTURES ? createAuditSourceFixtures(path.resolve(SOURCE_FIXTURES)) : null;
if (sourceFixtures && (!sourceFixtures.replay || sourceFixtures.size === 0)) {
    throw new Error('--source-fixtures requires a complete nonempty sealed cassette');
}
let pinnedTramPlan = null;
let pinnedTramRoute = null;
if (sourceFixtures && parsedUrl.searchParams.get('st3d') === 'tram') {
    const replay = sourceFixtures.lookup('http://localhost:3001/api/zet/tram-replay');
    if (!replay || replay.entry.status !== 200) throw new Error('Pinned tram replay is unavailable');
    pinnedTramPlan = planPinnedTramRoute(JSON.parse(replay.body), {
        line: parsedUrl.searchParams.get('line'), stop: parsedUrl.searchParams.get('stop'),
        shape: parsedUrl.searchParams.get('shape'), direction: Number(parsedUrl.searchParams.get('dir') || 0),
    });
}
const recordingFixtures = RECORD_SOURCE_FIXTURES ? createAuditSourceFixtures(path.resolve(RECORD_SOURCE_FIXTURES)) : null;
const sourceCapture = recordingFixtures ? createPerfSourceCapture({
    fixtures: recordingFixtures,
    fetchResponse: async (url, route) => {
        const response = await route.fetch();
        return { status: () => response.status(), headers: () => response.headers(), body: () => response.body() };
    },
}) : null;
const CHROME_TRACE_OUT = arg('--chrome-trace', '');
const CHROME_TRACE_LIGHT = flag('--chrome-trace-light');
if (CHROME_TRACE_LIGHT && !CHROME_TRACE_OUT) throw new Error('--chrome-trace-light requires --chrome-trace');
const CPU_PROFILE_OUT = arg('--cpu-profile', '');
const HEAP_PROFILE_OUT = arg('--heap-profile', '');
const OBSERVER = {
    frameCadence: 'station3d-frame-cadence-v1',
    telemetry: 'disabled',
    chromeTimeline: !!CHROME_TRACE_OUT,
    chromeTimelineMode: CHROME_TRACE_OUT ? (CHROME_TRACE_LIGHT ? 'main-thread' : 'full') : null,
    cpuProfile: !!CPU_PROFILE_OUT,
    heapProfile: !!HEAP_PROFILE_OUT,
    disableQuic: flag('--disable-quic'),
    renderStalls: flag('--render-stalls'),
};
const SHOT = arg('--shot', '');
const LOADING_SHOT = arg('--loading-shot', '');
const LABEL = arg('--label', '');
const COMPARE_WITH = arg('--compare-with', '');
const EXPECT_GTA_OCCUPANT = arg('--expect-gta-occupant', '');
const DRIVE_VEHICLE = arg('--drive-vehicle', '');
if (DRIVE_VEHICLE && (DRIVE_VEHICLE !== 'car' || parsedUrl.searchParams.get('st3d') !== 'gta'
    || EXPECT_GTA_OCCUPANT !== 'controlling')) throw new Error('--drive-vehicle car requires st3d=gta and --expect-gta-occupant controlling');
const GROUND_SETTLED_START = flag('--ground-settled-start');
const READY_TIMEOUT_S = numericArg('--ready-timeout', 120, { min: 1 });
const SETTLED_START = flag('--settled-start');
const PAUSED_START = flag('--paused-start');
if (PAUSED_START && !SETTLED_START) throw new Error('--paused-start requires --settled-start');
const LEGACY_NATIVE_READY = flag('--legacy-native-ready');
if (LEGACY_NATIVE_READY && parsedUrl.searchParams.get('bundle3d') === '1') {
    throw new Error('--legacy-native-ready cannot import source into a bundled session');
}
const CLEAN_WAIT_S = numericArg('--clean-wait', 30, { min: 1 });
const CLEAN_SAMPLES = Math.ceil(numericArg('--clean-samples', 2, { min: 1 }));
const HEADLESS = flag('--headless');
const ALLOW_BUSY_HOST = flag('--allow-busy-host');
const SKIP_WORLD_READY = flag('--skip-world-ready');
const ALLOW_STATIONARY = flag('--allow-stationary');
const VIEWPORT = Object.freeze({ width: 1600, height: 1000 });
const DISPLAY_CADENCE_FRAMES = 60;

function parseWalkScript(value) {
    if (!value) return [];
    return value.split(',').map((rawStep) => {
        const separator = rawStep.lastIndexOf(':');
        const token = separator >= 0 ? rawStep.slice(0, separator).trim() : '';
        const seconds = separator >= 0 ? Number(rawStep.slice(separator + 1)) : Number.NaN;
        if (!token || !Number.isFinite(seconds) || seconds <= 0) {
            throw new Error('invalid --walk step: ' + rawStep);
        }
        const key = /^arrow/i.test(token)
            ? 'Arrow' + token.slice(5, 6).toUpperCase() + token.slice(6)
            : token;
        return { key, seconds };
    });
}

const WALK_STEPS = parseWalkScript(WALK);
const MODE = parsedUrl.searchParams.get('st3d') || '';
if (WALK_CORRIDOR_M) assertWalkingCorridorMode(MODE, EXPECT_GTA_OCCUPANT, DRIVE_VEHICLE);
const EXPECT_MOVEMENT = !ALLOW_STATIONARY && (
    WALK_STEPS.length > 0 || WALK_CORRIDOR_M > 0 || MODE === 'planner-cab' || MODE === 'tram'
);
if (EXPECT_GTA_OCCUPANT
    && !['on-foot', 'boarding-requested', 'controlling', 'exiting'].includes(EXPECT_GTA_OCCUPANT)) {
    throw new Error('--expect-gta-occupant must be a valid occupant state');
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...values) => console.log('[' + stamp() + ']', ...values);
const sleep = (page, ms) => page.waitForTimeout(ms);
const finite = (value, fallback = 0) => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
);
const hostText = (host = {}) => (
    String(host.level || 'unknown')
    + (Number.isFinite(host.ratio) ? ' ×' + host.ratio.toFixed(1) : '')
);

function compactSample(snapshot, phase) {
    return {
        phase,
        at: snapshot.at,
        fps: snapshot.fps,
        frameAvgMs: snapshot.frameAvgMs,
        hooksMs: snapshot.hooksMs,
        renderMs: snapshot.renderMs,
        stallMs: snapshot.stallMs,
        host: { ...(snapshot.host || {}) },
        motionState: snapshot.motionState,
        speedMps: snapshot.speedMps,
        gpuCalls: snapshot.gpuCalls,
        gpuTriangles: snapshot.gpuTriangles,
        gpuAttribution: snapshot.gpuAttribution || null,
        profilerMode: snapshot.profilerMode || PROFILER_MODE,
        pendingItems: (snapshot.queues || []).reduce(
            (sum, queue) => sum + Math.max(0, finite(queue.pendingItems)),
            0,
        ),
        gtaOccupantState: snapshot.gta?.physics?.occupant?.state || null,
        pose: snapshot.observedPose || null,
    };
}

function rememberSample(samples, snapshot, phase) {
    if (!snapshot || samples.some(sample => sample.at === snapshot.at)) return false;
    samples.push(compactSample(snapshot, phase));
    return true;
}

async function readTrace(page) {
    return page.evaluate(() => {
        const trace = window.__perfTrace?.() || null;
        return trace ? { ...trace, observedPose: window.Station3D?.getPose?.() || null } : null;
    });
}

async function runCorridorMovement(page, samples) {
    const origin = await page.evaluate(() => window.Station3D.getPose());
    if (!corridorPosition(origin, origin)) throw new Error('A measured walking pose is required');
    await page.evaluate(source => {
        window.__perfCorridorPosition = (0, eval)('(' + source + ')');
    }, corridorPosition.toString());
    const result = { protocol: 'distance-out-and-back-v1', origin, distanceM: WALK_CORRIDOR_M,
        repeats: WALK_CORRIDOR_REPEATS, legs: [] };
    let previousAt = 0, lastLogAt = 0;
    for (let repeat = 0; repeat < WALK_CORRIDOR_REPEATS; repeat++) for (const key of ['w', 's']) {
        const targetM = key === 'w' ? WALK_CORRIDOR_M : 0;
        log(`corridor ${repeat + 1}/${WALK_CORRIDOR_REPEATS}: ${key} to ${targetM}m from the origin`);
        const startedAt = Date.now();
        await page.keyboard.down(key);
        try {
            const reached = page.waitForFunction(({ origin, targetM, forwards }) => {
                const p = window.__perfCorridorPosition(origin, window.Station3D.getPose());
                return p && (forwards ? p.alongM >= targetM : p.alongM <= targetM);
            }, { origin, targetM, forwards: key === 'w' }, { timeout: 90000, polling: 'raf' })
                .then(async handle => { await page.keyboard.up(key); await handle.dispose(); return { done: true }; });
            for (;;) {
                const next = await Promise.race([reached,
                    waitForNextTrace(page, previousAt).then(trace => ({ trace }))]);
                if (next.done) break;
                previousAt = next.trace.at;
                rememberSample(samples, next.trace, 'measurement');
                if (Date.now() - lastLogAt >= 5000) { logSample(next.trace, 'corridor'); lastLogAt = Date.now(); }
            }
        } finally { await page.keyboard.up(key); }
        const pose = await page.evaluate(() => window.Station3D.getPose());
        const position = corridorPosition(origin, pose);
        if (!position || Math.abs(position.crossM) > 5 || Math.abs(position.alongM - targetM) > 5) {
            throw new Error('Walk missed its measured corridor waypoint: ' + JSON.stringify({ pose, position, targetM }));
        }
        result.legs.push({ repeat, key, targetM, startedAt, completedAt: Date.now(), pose, ...position });
        log(`waypoint reached: ${position.alongM.toFixed(2)}m along, ${position.crossM.toFixed(2)}m across`);
    }
    return result;
}

async function waitForSettledStart(page) {
    const deadline = Date.now() + READY_TIMEOUT_S * 1000, observations = [];
    let consecutive = 0, previousAt = 0, lastLogAt = 0;
    while (Date.now() < deadline) {
        const trace = await waitForNextTrace(page, previousAt);
        previousAt = trace.at;
        const building = await page.evaluate(() => {
            const state = window.__s3dBuildingBuildState?.();
            if (!state) return null;
            // Older current-main releases expose assembly state through the
            // draw inspector. This fallback runs before timing, never in play.
            return { ...state, aggregatePipeline: state.aggregatePipeline
                || window.__s3dBuildingDraw?.()?.aggregatePipeline || null };
        });
        const pending = (trace.background || []).filter(entry =>
            ['pending', 'fetching', 'building', 'retrying'].some(key => finite(entry[key]) > 0));
        const failed = (trace.background || []).filter(entry =>
            ['failed', 'fetchFailed', 'buildFailed'].some(key => finite(entry[key]) > 0));
        const queueItems = (trace.queues || []).reduce((sum, q) => sum + finite(q.pendingItems), 0);
        const buildingJobs = building ? finite(building.activeTileBuildCount)
            + finite(building.activeVisualReplacementTiles) + finite(building.reservedBuildingCount)
            + finite(building.pendingTerrainRebuildTiles) + finite(building.pendingRegionalRebuildTiles) : null;
        const ready = Array.isArray(trace.background) && Array.isArray(trace.queues)
            && buildingDrainState(building) === 'drained'
            && !pending.length && !failed.length && queueItems === 0;
        consecutive = ready ? consecutive + 1 : 0;
        observations.push({ at: trace.at, host: trace.host, queueItems, buildingJobs,
            loadedBuildingCount: building?.loadedBuildingCount ?? null,
            aggregatePipeline: building?.aggregatePipeline ?? null,
            pending: pending.map(entry => ({ label: entry.label, kind: entry.kind, pending: entry.pending })), failed });
        if (Date.now() - lastLogAt >= 10000 || ready) {
            log(`initial scenery: ${building?.loadedBuildingCount ?? '?'} buildings · ${queueItems} queue items · ${pending.length} active producers · ${consecutive}/2 drained windows`
                + (failed.length ? ` · failed: ${failed.map(entry => entry.label).join(', ')}` : ''));
            lastLogAt = Date.now();
        }
        if (consecutive >= 2) return { ready: true, observations, buildingState: building };
        if (KEEP_BROWSER_ON_FAILURE && !pending.length && queueItems === 0
            && buildingDrainState(building) === 'drained'
            && failed.some(entry => entry.label === 'decor' && entry.failed > 0)) {
            throw new Error('Initial decor construction failed: ' + JSON.stringify(failed));
        }
    }
    throw new Error('Initial scenery did not fully settle: ' + JSON.stringify(observations.at(-1)));
}

async function readRuntimeContext(page) {
    return page.evaluate(async ({ profilerMode, mode }) => {
        if (typeof window.Station3D?.getPerformanceContext === 'function') {
            return window.Station3D.getPerformanceContext();
        }

        // Compatibility context for an unchanged baseline from before the
        // public runtime handshake existed. Everything here is read AFTER the
        // measurement, so the imports and scene inspection cannot perturb it.
        let location = null;
        let renderGrade = null;
        try {
            const locations = await import('/station-3d/core/locations.js');
            location = locations.getLocation?.() || null;
        } catch (_error) { /* remains explicitly unverified below */ }
        try {
            const setup = await import('/station-3d/scene/setup.js');
            renderGrade = setup.renderGrade || null;
        } catch (_error) { /* remains explicitly unverified below */ }
        const canvas = document.querySelector('.station-3d-modal canvas')
            || document.querySelector('canvas');
        const rect = canvas?.getBoundingClientRect?.();
        const observedDpr = rect?.width > 0 ? canvas.width / rect.width : null;
        const terrain = location?.terrain || null;
        let terrainActive = null;
        try {
            terrainActive = window.Station3D?.isModelTerrainActive?.() === true;
        } catch (_error) { /* remains explicitly unverified below */ }
        return {
            profilerMode,
            terrainActive,
            terrainPolicy: null,
            sourceProfile: location ? {
                locationId: location.id || null,
                regionalLocationId: location.regionalLocationId || null,
                styleCityId: location.styleCityId || null,
                country: location.country || null,
                buildings: location.buildings || null,
                buildingEndpoint: location.buildingEndpoint || null,
                farBuildingEndpoint: location.farBuildingEndpoint || null,
                terrainSource: terrain?.source || (terrain?.dataUrl ? 'static' : null),
                terrainDetailSource: terrain?.detail?.source || null,
                movingTerrain: terrain?.movingWindow === true,
            } : null,
            dpr: Number.isFinite(observedDpr) ? observedDpr : null,
            drawingBuffer: canvas ? { width: canvas.width, height: canvas.height } : null,
            activeLayers: null,
            pendingLayers: null,
            worldMode: window.__worldMode?.isPhotoWorld?.() === true ? 'photo' : 'model',
            renderGrade,
            sessionPresetId: null,
            compatibilityFallback: true,
            unverifiedFields: [
                'terrainPolicy',
                'activeLayers',
                'pendingLayers',
                'sessionPresetId',
            ],
            requestedMode: mode || null,
        };
    }, { profilerMode: PROFILER_MODE, mode: MODE });
}

async function measureDisplayCadence(page) {
    const intervals = await page.evaluate((frameCount) => new Promise((resolve) => {
        const values = [];
        let previous = null;
        const onFrame = (timestamp) => {
            if (previous !== null) values.push(timestamp - previous);
            previous = timestamp;
            if (values.length >= frameCount) resolve(values);
            else requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
    }), DISPLAY_CADENCE_FRAMES);
    return summarizePerfDisplayCadence(intervals);
}

async function waitForNextTrace(page, previousAt, timeoutMs = 6000) {
    await page.waitForFunction(
        lastAt => {
            const snapshot = window.__perfTrace?.();
            return snapshot && snapshot.at !== lastAt;
        },
        previousAt || 0,
        { timeout: timeoutMs },
    );
    return readTrace(page);
}

async function readWorldLoadState(page) {
    return page.evaluate(() => {
        const live = typeof window.__s3dWorldLoadState === 'function'
            ? window.__s3dWorldLoadState()
            : window.__perfLegacyWorldLoadState?.() || null;
        const modal = document.getElementById('station3DModal');
        const curtain = document.querySelector('.station-3d-campaign-curtain');
        const container = curtain?.querySelector('.station-3d-loading-segments');
        const segmentElements = [...(container?.children || [])];
        const rowTops = [...new Set(segmentElements.map((element) => (
            Math.round(element.getBoundingClientRect().top)
        )))].sort((a, b) => a - b);
        const domState = modal?.dataset.worldBuildState || '';
        const moduleBuilding = typeof live?.building === 'boolean'
            ? live.building
            : null;
        const startupSnapshot = live?.startupTrace || null;
        const legacyBuildStarted = startupSnapshot?.milestones?.some(
            milestone => milestone.name === 'build-start',
        ) === true;
        const useDomTelemetry = domState === 'building' || domState === 'ready';
        const useModuleFallback = !useDomTelemetry && (
            moduleBuilding === true || (moduleBuilding === false && legacyBuildStarted)
        );
        const state = useDomTelemetry
            ? domState
            : (useModuleFallback ? (moduleBuilding ? 'building' : 'ready') : 'missing');
        return {
            state,
            // The older gate does not retain whether it released normally or
            // by failsafe. Keep the comparable visible-ready state, and mark
            // the unavailable outcome separately instead of inventing it.
            reason: modal?.dataset.worldBuildReason
                || live?.observedReadyReason
                || (useModuleFallback && state === 'ready' ? 'ready' : ''),
            readinessSource: useDomTelemetry ? 'dom-telemetry'
                : (live?.observedReadyReason ? 'native-ready-callback'
                    : (useModuleFallback ? 'world-ready-module' : 'unavailable')),
            compatibilityFallback: useModuleFallback,
            outcomeVerified: useDomTelemetry || !!live?.observedReadyReason,
            telemetryText: curtain?.querySelector('.station-3d-campaign-curtain-telemetry')
                ?.textContent || '',
            telemetry: live?.telemetry || null,
            components: Array.isArray(live?.components) ? live.components : [],
            startupTrace: startupSnapshot,
            layout: {
                width: container?.getBoundingClientRect().width || 0,
                rows: rowTops.length,
                segments: segmentElements.map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        key: element.dataset.component || '',
                        label: element.querySelector('.station-3d-loading-seg-label')
                            ?.textContent || '',
                        row: Math.max(0, rowTops.indexOf(Math.round(rect.top))),
                        width: rect.width,
                        span: element.style.getPropertyValue('--load-span'),
                        mobileSpan: element.style.getPropertyValue('--load-mobile-span'),
                        done: element.classList.contains('done'),
                        active: element.classList.contains('active'),
                    };
                }),
            },
        };
    });
}

async function waitForWorldReady(page) {
    if (SKIP_WORLD_READY) {
        log('world-ready gate skipped explicitly');
        return { skipped: true, elapsedMs: 0 };
    }
    const startedAt = Date.now();
    // The curtain exists as hidden static markup before any build starts, so
    // "attached" would resolve instantly; wait for it to actually show instead.
    const hold = page.locator('.station-3d-campaign-curtain').first();
    await hold.waitFor({ state: 'visible', timeout: 30_000 });
    const deadline = startedAt + READY_TIMEOUT_S * 1000;
    const telemetrySamples = [];
    const byteRegressions = [];
    const componentRegressions = [];
    const componentReopenings = [];
    let previousBytes = null;
    let previousComponents = new Map();
    let nextTelemetrySampleAt = 0;
    let lastBuildingState = null;
    let loadingShotTaken = false;
    while (Date.now() <= deadline) {
        const current = await readWorldLoadState(page);
        const elapsedMs = Date.now() - startedAt;
        if (current.state === 'building') {
            lastBuildingState = current;
            const receivedBytes = finite(current.telemetry?.receivedBytes);
            if (previousBytes != null && receivedBytes < previousBytes) {
                byteRegressions.push({ elapsedMs, from: previousBytes, to: receivedBytes });
            }
            previousBytes = receivedBytes;
            const byKey = new Map(current.components.map(component => [component.key, component]));
            for (const [key, component] of byKey) {
                const previous = previousComponents.get(key);
                if (previous?.done && !component.done) {
                    componentRegressions.push({ elapsedMs, key });
                }
                if (previous?.done && !previous.active && component.active) {
                    componentReopenings.push({ elapsedMs, key });
                }
            }
            previousComponents = byKey;
            if (elapsedMs >= nextTelemetrySampleAt) {
                telemetrySamples.push({
                    elapsedMs,
                    receivedBytes,
                    dataProgress: current.components.find(
                        component => component.key === 'terrain-data',
                    )?.progress ?? null,
                });
                nextTelemetrySampleAt = elapsedMs + 1000;
            }
            if (LOADING_SHOT && !loadingShotTaken && elapsedMs >= 2000) {
                await page.screenshot({ path: LOADING_SHOT });
                loadingShotTaken = true;
                log('loading screenshot → ' + LOADING_SHOT);
            }
        }
        if (current.state === 'ready') {
            const elapsedMs = Date.now() - startedAt;
            log('world hold completed after ' + (elapsedMs / 1000).toFixed(1) + 's'
                + (current.reason ? ' · ' + current.reason : '')
                + ' · ' + current.readinessSource);
            return {
                skipped: false,
                elapsedMs,
                reason: current.reason || null,
                readinessSource: current.readinessSource,
                compatibilityFallback: current.compatibilityFallback === true,
                outcomeVerified: current.outcomeVerified !== false,
                telemetrySamples,
                byteRegressions,
                componentRegressions,
                componentReopenings,
                lastBuildingState,
                startupTrace: current.startupTrace || null,
            };
        }
        await sleep(page, 250);
    }
    throw new Error('world-ready gate did not complete within ' + READY_TIMEOUT_S
        + 's; last state ' + (lastBuildingState?.state || 'unknown'));
}

async function waitForCleanHost(page) {
    const observations = [];
    let consecutiveClean = 0;
    let previousAt = 0;
    const deadline = Date.now() + CLEAN_WAIT_S * 1000;
    while (Date.now() < deadline) {
        const remainingMs = Math.max(1000, deadline - Date.now());
        let snapshot;
        try {
            snapshot = await waitForNextTrace(page, previousAt, Math.min(6000, remainingMs));
        } catch {
            break;
        }
        previousAt = snapshot.at;
        observations.push({ at: snapshot.at, host: { ...(snapshot.host || {}) } });
        const clean = snapshot.host?.level === 'clean' && snapshot.host?.contended !== true;
        consecutiveClean = clean ? consecutiveClean + 1 : 0;
        log('host preflight ' + hostText(snapshot.host)
            + ' · clean sample ' + consecutiveClean + '/' + CLEAN_SAMPLES);
        if (consecutiveClean >= CLEAN_SAMPLES) {
            return { clean: true, observations };
        }
    }
    return { clean: false, observations };
}

async function resetMeasurement(page) {
    const result = await page.evaluate(() => {
        window.__perfFrameCadence.start();
        if (typeof window.__perfTraceReset === 'function') {
            return {
                ...window.__perfTraceReset(),
                isolation: 'native-reset',
            };
        }
        return {
            startedAtMs: performance.now(),
            isolation: 'timestamp-boundary',
        };
    });
    log('measurement counters reset at page T+'
        + (finite(result?.startedAtMs) / 1000).toFixed(1) + 's'
        + ' · ' + String(result?.isolation || 'unknown'));
    return result;
}

async function startChromeTimeline(cdp) {
    await cdp.send('Tracing.start', {
        categories: (CHROME_TRACE_LIGHT ? [
            'blink.user_timing', 'devtools.timeline', 'toplevel',
        ] : [
            'blink.user_timing',
            'cc',
            'devtools.timeline',
            'disabled-by-default-devtools.timeline.frame',
            'gpu',
            'renderer.scheduler',
            'toplevel',
        ]).join(','),
        options: 'record-until-full',
        transferMode: 'ReturnAsStream',
    });
    log('Chrome timeline recording → ' + CHROME_TRACE_OUT);
}

async function installRenderStallProbe(page) {
    await page.evaluate(() => {
        const renderer = window.__st3dDebug?.renderer;
        if (!renderer?.renderBufferDirect) throw new Error('Render stall probe needs the live local renderer');
        const gl = renderer.getContext();
        const records = [];
        let active = null;
        const record = (kind, startedAt, detail) => {
            const ms = performance.now() - startedAt;
            if (ms < 3) return;
            const names = [];
            for (let node = detail?.object; node && names.length < 6; node = node.parent) {
                if (node.name) names.push(node.name);
            }
            records.push({ atMs: startedAt, kind, ms,
                object: names.join(' ← '), type: detail?.object?.type,
                material: detail?.material?.name || detail?.material?.type,
                materialId: detail?.material?.id,
                objectId: detail?.object?.id,
                entityKey: detail?.object?.userData?.entityKey,
                buildingId: detail?.object?.userData?.objectId,
                flags: Object.keys(detail?.object?.userData || {}).filter(key => detail.object.userData[key] === true),
                materialState: detail?.material ? {
                    type: detail.material.type, version: detail.material.version,
                    side: detail.material.side, transparent: detail.material.transparent,
                    vertexColors: detail.material.vertexColors,
                    map: !!detail.material.map, normalMap: !!detail.material.normalMap,
                    bumpMap: !!detail.material.bumpMap, emissiveMap: !!detail.material.emissiveMap,
                } : null,
                vertices: detail?.geometry?.attributes?.position?.count || 0,
                batched: detail?.object?.isBatchedMesh === true,
                instanced: detail?.object?.isInstancedMesh === true,
                offscreen: !!renderer.getRenderTarget(),
            });
            if (records.length > 500) records.shift();
        };
        const draw = renderer.renderBufferDirect;
        // The probe must not allocate names/descriptor trees for every ordinary
        // draw. A dense tram frame has hundreds; build evidence only for stalls.
        const drawContext = { object: null, geometry: null, material: null };
        renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
            const parent = active;
            const context = parent ? { object, geometry, material } : drawContext;
            context.object = object; context.geometry = geometry; context.material = material;
            active = context;
            const start = performance.now();
            try { return draw.apply(this, arguments); }
            finally { record('draw', start, active); active = parent; }
        };
        for (const method of ['getProgramInfoLog', 'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D']) {
            const original = gl[method];
            if (typeof original !== 'function') continue;
            gl[method] = function () {
                const start = performance.now();
                try { return original.apply(this, arguments); }
                finally { record(method, start, active); }
            };
        }
        window.__renderStallProbe = () => records.slice();
    });
    log('slow draw/shader call diagnostic installed (not a timing baseline)');
}

async function stopChromeTimeline(cdp) {
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    if (!stream) throw new Error('Chrome timeline ended without a trace stream');
    const output = createWriteStream(CHROME_TRACE_OUT);
    try {
        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream });
            const data = chunk.base64Encoded
                ? Buffer.from(chunk.data || '', 'base64')
                : chunk.data || '';
            if (data.length > 0 && !output.write(data)) await once(output, 'drain');
            if (chunk.eof) break;
        }
        output.end();
        await once(output, 'finish');
    } finally {
        await cdp.send('IO.close', { handle: stream }).catch(() => {});
    }
    log('Chrome timeline complete → ' + CHROME_TRACE_OUT);
}

async function startCpuProfile(cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    log('CPU sampling profile recording → ' + CPU_PROFILE_OUT);
}

async function stopCpuProfile(cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(CPU_PROFILE_OUT, JSON.stringify(profile));
    await cdp.send('Profiler.disable');
    log('CPU sampling profile complete → ' + CPU_PROFILE_OUT);
}

async function startHeapProfile(cdp) {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
    });
    log('heap sampling profile recording → ' + HEAP_PROFILE_OUT);
}

async function stopHeapProfile(cdp) {
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    writeFileSync(HEAP_PROFILE_OUT, JSON.stringify(profile));
    await cdp.send('HeapProfiler.disable');
    log('heap sampling profile complete → ' + HEAP_PROFILE_OUT);
}

async function pauseForSettle(page) {
    const before = await readTrace(page);
    await page.keyboard.press('p');
    await page.waitForFunction(() => {
        // Bundle captures own a different module graph from native source.
        // Importing state.js here observes a fresh, empty cabState and does not
        // prove that the runtime receiving the keypress actually paused.
        return window.__st3dDebug?.state?.cabState?.simPaused === true;
    }, undefined, { timeout: 5000 });
    await page.waitForFunction((previousAt) => {
        const snapshot = window.__perfTrace?.();
        return snapshot && snapshot.at !== previousAt
            && (snapshot.motionState === 'stationary'
                || (Number.isFinite(snapshot.speedMps) && snapshot.speedMps < 0.5));
    }, before?.at || 0, { timeout: 6000 });
    const observed = await readTrace(page);
    const result = {
        control: 'keyboard:p',
        paused: true,
        observedAt: observed.at,
        motionState: observed.motionState || null,
        speedMps: Number.isFinite(observed.speedMps) ? observed.speedMps : null,
    };
    log('simulation paused for settled phase · '
        + String(result.motionState || 'unknown') + ' '
        + finite(result.speedMps).toFixed(1) + 'm/s');
    return result;
}

function logSample(snapshot, prefix) {
    if (!snapshot) return;
    log(prefix + ' ' + snapshot.fps.toFixed(0) + 'fps · '
        + snapshot.frameAvgMs.toFixed(1) + 'ms'
        + ' · hooks ' + snapshot.hooksMs.toFixed(1)
        + ' · render ' + snapshot.renderMs.toFixed(1)
        + ' · host ' + hostText(snapshot.host)
        + ' · ' + String(snapshot.motionState || 'unknown')
        + ' ' + finite(snapshot.speedMps).toFixed(1) + 'm/s'
        + ' · stutters ' + snapshot.stutterTotal);
}

async function collectForDuration(page, seconds, {
    phase,
    samples,
    prefix,
} = {}) {
    const deadline = Date.now() + seconds * 1000;
    let nextLogAt = Date.now() + 5000;
    while (Date.now() < deadline) {
        await sleep(page, Math.min(1000, Math.max(1, deadline - Date.now())));
        const snapshot = await readTrace(page);
        rememberSample(samples, snapshot, phase);
        if (snapshot && Date.now() >= nextLogAt) {
            logSample(snapshot, prefix);
            nextLogAt += 5000;
        }
    }
}

async function runScriptedMovement(page, samples) {
    for (const step of WALK_STEPS) {
        log('movement: hold ' + step.key + ' for ' + step.seconds + 's');
        await page.keyboard.down(step.key);
        try {
            await collectForDuration(page, step.seconds, {
                phase: 'measurement',
                samples,
                prefix: step.key,
            });
        } finally {
            await page.keyboard.up(step.key);
        }
    }
}

function motionEvidence(samples, snapshot) {
    const candidates = [
        ...samples,
        snapshot ? compactSample(snapshot, 'measurement') : null,
    ].filter(Boolean);
    return {
        observed: candidates.some(sample => (
            finite(sample.speedMps) >= 0.5
            || (sample.motionState && sample.motionState !== 'stationary')
        )),
        maxSpeedMps: candidates.reduce(
            (maximum, sample) => Math.max(maximum, finite(sample.speedMps)),
            0,
        ),
        states: [...new Set(candidates.map(sample => sample.motionState).filter(Boolean))],
    };
}

function validateMeasurement(snapshot, summary, samples, errors) {
    const reasons = [];
    const warnings = [];
    const hostCoverage = assessPerfHostCoverage(samples);
    const motion = motionEvidence(samples, snapshot);
    if (HEADLESS) reasons.push('headless/software rendering is not a timing measurement');
    if (hostCoverage.knownHostSamples === 0) {
        reasons.push('host load never calibrated during measurement');
    } else if (!hostCoverage.valid) {
        reasons.push(hostCoverage.busyHostSamples + '/' + hostCoverage.knownHostSamples
            + ' measurement windows were host-contended; only '
            + (hostCoverage.cleanFraction * 100).toFixed(1) + '% clean (requires '
            + (hostCoverage.minCleanFraction * 100).toFixed(0) + '%)');
    } else if (hostCoverage.busyHostSamples > 0) {
        warnings.push(hostCoverage.busyHostSamples + '/' + hostCoverage.knownHostSamples
            + ' measurement windows were host-contended; all frames remain in the metrics');
    }
    if (summary.hostBusyStutters > 0) {
        warnings.push(summary.hostBusyStutters
            + ' retained stutters carried a host-busy annotation and remain counted');
    }
    if (EXPECT_MOVEMENT && !motion.observed) {
        reasons.push('movement was expected but no moving sample was observed');
    }
    if (EXPECT_GTA_OCCUPANT) {
        const observedStates = new Set(samples.map(sample => sample.gtaOccupantState).filter(Boolean));
        const finalState = snapshot?.gta?.physics?.occupant?.state;
        if (finalState) observedStates.add(finalState);
        if (!observedStates.has(EXPECT_GTA_OCCUPANT)) {
            reasons.push('expected GTA occupant ' + EXPECT_GTA_OCCUPANT
                + ', observed ' + ([...observedStates].join(', ') || 'none'));
        }
    }
    if (errors.size > 0) reasons.push(errors.size + ' distinct console/page errors occurred');
    if (DRIVE_VEHICLE) reasons.push(...groundDriveFailures(snapshot, samples));
    return {
        valid: reasons.length === 0,
        reasons,
        warnings,
        motion,
        knownHostSamples: hostCoverage.knownHostSamples,
        cleanHostSamples: hostCoverage.cleanHostSamples,
        busyHostSamples: hostCoverage.busyHostSamples,
        cleanHostFraction: hostCoverage.cleanFraction,
        minCleanHostFraction: hostCoverage.minCleanFraction,
    };
}

const pad = (value, width) => String(value).padEnd(width);

function summarizeGpuAttribution(samples = []) {
    const windows = samples
        .map(sample => sample?.gpuAttribution)
        .filter(entry => Number(entry?.frames) > 0);
    if (windows.length === 0) return null;
    const groups = new Map();
    let mainCalls = 0;
    let shadowCalls = 0;
    let unattributedCalls = 0;
    for (const window of windows) {
        mainCalls += finite(window.mainCalls);
        shadowCalls += finite(window.shadowCalls);
        unattributedCalls += finite(window.unattributedCalls);
        for (const group of window.groups || []) {
            const name = String(group?.name || 'unclassified');
            const current = groups.get(name) || { name, mainCalls: 0, shadowCalls: 0 };
            current.mainCalls += finite(group.mainCalls);
            current.shadowCalls += finite(group.shadowCalls);
            groups.set(name, current);
        }
    }
    const divisor = windows.length;
    const rankedGroups = [...groups.values()].map(group => ({
        name: group.name,
        mainCalls: group.mainCalls / divisor,
        shadowCalls: group.shadowCalls / divisor,
        calls: (group.mainCalls + group.shadowCalls) / divisor,
    })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    return {
        windows: divisor,
        mainCalls: mainCalls / divisor,
        shadowCalls: shadowCalls / divisor,
        unattributedCalls: unattributedCalls / divisor,
        groups: rankedGroups,
    };
}

function printStats(title, stats) {
    if (!stats.length) return;
    console.log('\n' + title);
    for (const entry of stats.slice(0, 15)) {
        console.log('  ' + pad(entry.name, 34)
            + String(entry.count).padStart(4) + '×'
            + String(Math.round(entry.totalMs)).padStart(7) + 'ms actual'
            + String(Math.round(entry.worstMs)).padStart(6) + 'ms worst'
            + (entry.over50ms ? '  ' + entry.over50ms + '×≥50' : ''));
    }
}

function printNetwork(title, network) {
    if (!network) return;
    console.log('\n' + title + ': '
        + (finite(network.encodedBytes) / 1_000_000).toFixed(1) + ' MB encoded · '
        + (finite(network.decodedBytes) / 1_000_000).toFixed(1) + ' MB decoded · '
        + finite(network.requests) + ' requests · '
        + finite(network.failed) + ' failed · '
        + finite(network.canceled) + ' canceled · '
        + finite(network.inflight) + ' in flight · '
        + (network.duplicateUrls?.length || 0) + ' repeated URLs');
    console.log('  Station3D code '
        + finite(network.station3dCode?.requests) + ' requests · '
        + finite(network.station3dCode?.uniqueUrls) + ' unique · '
        + (finite(network.station3dCode?.encodedBytes) / 1_000_000).toFixed(1)
        + ' MB wire · Station3D dependency CDN '
        + finite(network.station3dDependencyCdn?.requests)
        + ' · page CDN ' + finite(network.thirdPartyCdn?.requests));
    for (const request of network.inflightRequests || []) {
        console.log('  IN FLIGHT ' + (request.method || 'GET') + ' ' + request.url);
    }
    for (const entry of (network.byPath || []).slice(0, 12)) {
        console.log('  ' + pad(entry.key, 62)
            + String(entry.requests).padStart(4) + '×  '
            + (finite(entry.encodedBytes) / 1_000_000).toFixed(1).padStart(7) + ' MB wire  '
            + (finite(entry.decodedBytes) / 1_000_000).toFixed(1).padStart(7) + ' MB decoded');
    }
}

function printSnapshot(snapshot, summary, sampleSummary, validation, samples = []) {
    console.log('\n══════ PERF · MEASUREMENT ══════');
    console.log('verdict ' + (validation.valid ? 'VALID' : 'INVALID')
        + ' · mode ' + (MODE || 'unknown')
        + ' · profiler ' + (snapshot.profilerMode || PROFILER_MODE)
        + ' · movement max ' + validation.motion.maxSpeedMps.toFixed(1) + 'm/s');
    console.log('fps ' + snapshot.fps.toFixed(0)
        + ' · frame ' + snapshot.frameAvgMs.toFixed(1) + 'ms'
        + ' · host ' + hostText(snapshot.host)
        + (snapshot.hostBlame ? '  (' + snapshot.hostBlame + ')' : ''));
    console.log('hooks ' + snapshot.hooksMs.toFixed(2)
        + '  render ' + snapshot.renderMs.toFixed(2)
        + '  sky ' + snapshot.skyMs.toFixed(2)
        + '  stall ' + snapshot.stallMs.toFixed(2));
    console.log('gpu calls ' + snapshot.gpuCalls
        + '  tris ' + (snapshot.gpuTriangles / 1000).toFixed(0) + 'k'
        + '  programs ' + snapshot.gpuPrograms);
    const gpuAttribution = summarizeGpuAttribution(samples)
        || (snapshot.gpuAttribution?.frames > 0 ? snapshot.gpuAttribution : null);
    if (gpuAttribution) {
        console.log('gpu calls by pass (avg): colour '
            + finite(gpuAttribution.mainCalls).toFixed(0)
            + ' · shadow ' + finite(gpuAttribution.shadowCalls).toFixed(0)
            + ' · other ' + finite(gpuAttribution.unattributedCalls).toFixed(0));
        console.log('gpu calls by scene group (avg colour/shadow):');
        for (const group of (gpuAttribution.groups || []).slice(0, 12)) {
            console.log('  ' + pad(group.name, 34)
                + String(Math.round(finite(group.calls))).padStart(5)
                + '  (' + Math.round(finite(group.mainCalls))
                + '/' + Math.round(finite(group.shadowCalls)) + ')');
        }
    }
    const sampledFrame = sampleSummary.metrics.frameAvgMs;
    const sampledHooks = sampleSummary.metrics.hooksMs;
    const sampledRender = sampleSummary.metrics.renderMs;
    const sampledStall = sampleSummary.metrics.stallMs;
    if (sampleSummary.windows > 0) {
        console.log('movement windows ' + sampleSummary.windows
            + ' · frame median ' + finite(sampledFrame.median).toFixed(1)
            + ' p95 ' + finite(sampledFrame.p95).toFixed(1)
            + ' · median hooks ' + finite(sampledHooks.median).toFixed(1)
            + ' render ' + finite(sampledRender.median).toFixed(1)
            + ' stall ' + finite(sampledStall.median).toFixed(1));
    }
    console.log('stutters ≥' + finite(snapshot.stutterThresholdMs, 33) + 'ms: '
        + summary.stutterTotal + ' (' + summary.heldStutters + ' held)'
        + ' · moving ' + summary.movingStutters
        + ' · host-busy ' + summary.hostBusyStutters
        + ' · startup leakage ' + summary.startupStutters);

    printStats('by top-level frame owner (actual owner time):', summary.owners);
    printStats('by diagnosed cause (actual cause time):', summary.causes);
    printStats('by named hook phase (actual phase time):', summary.phases);
    printStats('by out-of-loop work (actual reported time):', summary.outsideWork);

    if (summary.worstFrames.length) {
        console.log('\nworst frames:');
        for (const frame of summary.worstFrames.slice(0, 12)) {
            console.log('  ' + String(Math.round(frame.frameMs)).padStart(5) + 'ms'
                + '  hooks ' + String(Math.round(frame.hooksMs)).padStart(4)
                + ' render ' + String(Math.round(frame.renderMs)).padStart(4)
                + ' stall ' + String(Math.round(frame.stallMs)).padStart(4)
                + '  ' + pad(frame.cause, 28)
                + (frame.hostBusy ? ' host-busy' : ' host-clean')
                + (frame.stationary ? ' stationary' : ' moving'));
        }
    }

    const pendingQueues = (snapshot.queues || [])
        .filter(queue => finite(queue.pendingItems) > 0)
        .sort((a, b) => finite(b.pendingItems) - finite(a.pendingItems));
    if (pendingQueues.length) {
        console.log('\npending queues:');
        for (const queue of pendingQueues) {
            console.log('  ' + pad(queue.label, 24)
                + String(queue.pendingItems).padStart(6) + ' pending'
                + '  class ' + pad(queue.workClass, 11)
                + ' longest ' + finite(queue.longestItemMs).toFixed(1) + 'ms'
                + (queue.over50msItems ? '  ' + queue.over50msItems + '×≥50' : ''));
        }
    }

    const pendingByClass = new Map();
    for (const queue of pendingQueues) {
        pendingByClass.set(
            queue.workClass,
            (pendingByClass.get(queue.workClass) || 0) + finite(queue.pendingItems),
        );
    }
    const starved = [...pendingByClass.entries()].filter(([workClass, pending]) => (
        pending > 0 && finite(snapshot.workSpentByClass?.[workClass]) === 0
    ));
    if (starved.length) {
        console.log('\nwork classes with backlog and zero spend: '
            + starved.map(([name, pending]) => name + ' (' + pending + ')').join(', '));
    }
    if (!validation.valid) {
        console.log('\ninvalid measurement:');
        for (const reason of validation.reasons) console.log('  - ' + reason);
    }
    if (validation.warnings?.length) {
        console.log('\nmeasurement warnings:');
        for (const warning of validation.warnings) console.log('  - ' + warning);
    }
}

let browser = null;
let page = null;
let cdp = null;
let chromeTimelineStarted = false;
let cpuProfileStarted = false;
let heapProfileStarted = false;
let startupSnapshot = null;
let measurementSnapshot = null;
let settleSnapshot = null;
let worldReady = null;
let settledStart = null;
let pausedStart = null;
let hostPreflight = null;
let networkRecorder = null;
let startupNetwork = null;
let playableNetwork = null;
let fullNetwork = null;
let runtimeDiagnostics = null;
let runtimeContext = null;
let runtimeTiming = null;
let displayCadence = null;
let measurementReset = null;
let settleReset = null;
let settlePause = null;
let movementRoute = null;
let movementStartPose = null;
let measurementCadence = null;
let settleCadence = null;
const measurementSamples = [];
const settleSamples = [];
const errors = new Map();
const pendingCodeTasks = new Set();
const runStartedAt = new Date().toISOString();
const comparisonBaseline = COMPARE_WITH
    ? JSON.parse(readFileSync(COMPARE_WITH, 'utf8'))
    : null;

function rememberError(value) {
    const key = String(value || 'unknown error').slice(0, 600);
    errors.set(key, (errors.get(key) || 0) + 1);
}

function isExpectedMissingResource(response) {
    if (response.status() !== 404) return false;
    const pathname = new globalThis.URL(response.url()).pathname;
    // A facade photo is optional by contract: facade-windows.js resolves null
    // from Image.onerror and keeps the procedural facade. Missing geometry or
    // any other failed resource must still invalidate the measurement.
    return /^\/api\/building-facade\/[^/]+$/.test(pathname);
}

try {
    browser = BROWSER_WS ? await chromium.connect(BROWSER_WS) : await chromium.launch({
        channel: 'chrome',
        headless: HEADLESS,
        args: [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            ...(OBSERVER.disableQuic ? ['--disable-quic'] : []),
            // Pin to the primary display. Restored windows on another monitor
            // can silently compare a 120 Hz run against a 60 Hz run.
            '--window-position=40,40',
            '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
            ...(HEADLESS ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
        ],
    });
    page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(120_000);
    displayCadence = await measureDisplayCadence(page);
    log('display cadence ' + finite(displayCadence.medianHz).toFixed(1) + ' Hz'
        + ' · p95 interval ' + finite(displayCadence.p95IntervalMs).toFixed(1) + 'ms');
    if (!HEADLESS && !displayCadence.valid) {
        throw new Error('display cadence is only '
            + finite(displayCadence.medianHz).toFixed(1) + ' Hz; timing runs require at least '
            + displayCadence.minHz.toFixed(0) + ' Hz (wake or attach the display)');
    }
    // Project loading rewrites the planner URL before the lazily imported
    // Station3D modules evaluate. Keep the two harness-owned observer flags
    // across those rewrites so a planner-cab attribution pass cannot silently
    // fall back to the timing observer. This changes only the browser harness;
    // the measured application remains the requested revision.
    await page.addInitScript(({ stats, perfAttribution, telemetry, quality }) => {
        if (quality) localStorage.setItem('station3dQuality', quality);
        const preserveHarnessParams = (value) => {
            if (value == null) return value;
            try {
                const next = new URL(String(value), window.location.href);
                next.searchParams.set('stats', stats);
                next.searchParams.set('perfAttribution', perfAttribution);
                next.searchParams.set('telemetry', telemetry);
                return next.toString();
            } catch (_error) {
                return value;
            }
        };
        for (const methodName of ['pushState', 'replaceState']) {
            const original = history[methodName].bind(history);
            history[methodName] = (state, unused, url) => (
                original(state, unused, preserveHarnessParams(url))
            );
        }
    }, {
        stats: parsedUrl.searchParams.get('stats') || '1',
        perfAttribution: parsedUrl.searchParams.get('perfAttribution') || '0',
        telemetry: '0',
        quality: QUALITY,
    });
    await page.addInitScript(installGroundDriveScenario, {
        vehicle: DRIVE_VEHICLE, headingDeg: Number(parsedUrl.searchParams.get('heading')) || 0,
    });
    cdp = await page.context().newCDPSession(page);
    networkRecorder = createCdpNetworkRecorder(cdp);
    await networkRecorder.start();
    if (sourceFixtures || recordingFixtures) {
        await page.route('**/api/**', async route => {
            if (route.request().method() === 'OPTIONS') {
                return route.fulfill({ status: 204, headers: {
                    'access-control-allow-origin': '*',
                    'access-control-allow-methods': 'GET, OPTIONS',
                    'access-control-allow-headers': '*',
                } });
            }
            if (route.request().method() !== 'GET') {
                rememberError('unexpected source method: ' + route.request().method() + ' ' + route.request().url());
                return route.abort();
            }
            let fixture;
            try {
                fixture = sourceFixtures?.lookup(route.request().url())
                    || await sourceCapture?.resolve(route.request().url(), route);
            } catch (error) {
                rememberError(`source capture failed: ${route.request().url()} ${error?.message || error}`);
                return route.abort();
            }
            if (!fixture) {
                rememberError('missing source fixture: ' + route.request().url());
                return route.abort();
            }
            return route.fulfill({ status: fixture.entry.status, body: fixture.body,
                headers: { 'content-type': fixture.entry.contentType,
                    'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
        });
    }

    // Build failures and free identifiers are correctness failures, not merely
    // noise: a missing layer is faster and invalidates the measurement.
    page.on('console', (message) => {
        const value = message.text();
        if (!/error|failed|ReferenceError|TypeError/i.test(value)) return;
        // Resource failures are recorded below with their actual URL. Chrome's
        // generic console line contains neither the resource nor the status.
        if (/^Failed to load resource:/i.test(value)) return;
        const location = message.location();
        const at = location?.url
            ? ` @ ${location.url}:${finite(location.lineNumber) + 1}`
            : '';
        rememberError('console: ' + value + at);
    });
    page.on('pageerror', (error) => {
        rememberError('pageerror: ' + (error.stack || error.message));
    });
    page.on('response', (response) => {
        const responseUrl = new globalThis.URL(response.url());
        if (CODE_DIR && responseUrl.origin === parsedUrl.origin
            && /\/station-3d\/.*\.(?:m?js|css)$/.test(responseUrl.pathname)) {
            const task = response.body().then(body => {
                const checked = verifyServedCodeResponse({ url: response.url(), status: response.status(),
                    cacheControl: response.headers()['cache-control'], body, websiteRoot: CODE_DIR,
                    workerBundleSha256: response.headers()['x-station3d-worker-sha256'], generatedCode: generatedNativeCode });
                if (!checked.ok) rememberError(checked.reason || `served native code mismatch: ${response.url()}`);
            }).catch(error => rememberError(`served native code read failed: ${response.url()}: ${error.message}`));
            pendingCodeTasks.add(task);
            task.finally(() => pendingCodeTasks.delete(task));
        }
        if (response.status() < 400 || isExpectedMissingResource(response)) return;
        rememberError(`http ${response.status()}: ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
        // Moving terrain/road windows deliberately abort superseded fetches.
        // CDP retains those as canceled network records; do not duplicate them
        // as page errors. Every other request, response, console, and page
        // failure remains fatal through the surrounding handlers.
        if (isExpectedCanceledNetworkError(request.failure()?.errorText)) return;
        rememberError('request failed: ' + request.url()
            + ' · ' + (request.failure()?.errorText || 'unknown network failure'));
    });

    if (PAUSED_START) await page.addInitScript(installPausedStartObserver, READY_TIMEOUT_S * 1000);
    if (pinnedTramPlan) await page.addInitScript(installPinnedTramRoute, pinnedTramPlan);
    log('opening ' + URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    if (LEGACY_NATIVE_READY) {
        // Observe the unchanged legacy module instance; never force a ready
        // state or replace its timeout. The callback preserves failure reasons.
        await page.evaluate(installLegacyReadinessObserver, READY_TIMEOUT_S * 1000);
    }
    log('waiting for render instrumentation and the model world…');
    await page.waitForFunction(
        () => typeof window.__perfTrace === 'function',
        undefined,
        { timeout: READY_TIMEOUT_S * 1_000 },
    );
    await page.waitForFunction(() => window.__perfTrace() !== null, undefined, {
        timeout: READY_TIMEOUT_S * 1_000,
    });
    worldReady = await waitForWorldReady(page);
    if (pinnedTramPlan) {
        pinnedTramRoute = await page.evaluate(() => window.__perfPinnedTramRoute || null);
        if (pinnedTramRoute?.count !== 1
            || JSON.stringify(pinnedTramRoute.plan) !== JSON.stringify(pinnedTramPlan)) {
            throw new Error('The actual pinned tram route was not verified');
        }
        log(`verified pinned tram: ${pinnedTramRoute.observed.stops.length} stops, `
            + `${pinnedTramRoute.observed.segments.length} compiled segments`);
    }
    if (PAUSED_START) {
        pausedStart = await page.evaluate(() => window.__perfPausedStart || null);
        if (!pausedStart?.paused) throw new Error('Initial cab pause was not verified: ' + JSON.stringify(pausedStart));
        log('initial cab held with P before the first movement');
    }
    playableNetwork = { ...networkRecorder.snapshot(),
        pageElapsedMs: await page.evaluate(() => performance.now()),
        readyReason: worldReady?.reason || null };
    if (SETTLED_START) settledStart = await waitForSettledStart(page);
    if (HEAP_PROFILE_OUT && SETTLED_START) {
        const buildingState = await page.evaluate(() => window.__s3dBuildingBuildState?.({ includeEntries: true }) || null);
        settledStart = { ...settledStart, buildingState };
    }
    if (GROUND_SETTLED_START) {
        const deadline = Date.now() + 300000;
        let previous = null, stable = 0;
        do {
            settledStart = await page.evaluate(() => window.__s3dSurfaceAudit?.({ radiusM: 60, stepM: 8, showOverlay: false, log: false }) || null);
            const completion = await page.evaluate(captureGroundDrainSample);
            const completionState = groundDrainState(completion);
            settledStart = { ...settledStart, completion, completionState };
            if (completionState === 'failed') throw new Error('Ground/decor failed before measurement');
            const signature = settledStart?.publicationSignature;
            stable = settledStart?.readiness?.ready && completionState === 'drained' && signature === previous ? stable + 1 : 0;
            previous = signature;
            if (stable >= 2) break;
            await sleep(page, 8000);
        } while (Date.now() < deadline);
        if (stable < 2) throw new Error('Ground did not settle before the measurement deadline');
    }
    runtimeTiming = await page.evaluate(() => window.__station3DRuntimeTiming || null);
    startupNetwork = networkRecorder.snapshot();
    log('startup network '
        + (startupNetwork.encodedBytes / 1_000_000).toFixed(1) + ' MB encoded · '
        + (startupNetwork.decodedBytes / 1_000_000).toFixed(1) + ' MB decoded · '
        + startupNetwork.requests + ' requests · '
        + startupNetwork.failed + ' failed · '
        + startupNetwork.duplicateUrls.length + ' repeated URLs · '
        + startupNetwork.station3dCode.requests + ' Station3D code · '
        + startupNetwork.station3dDependencyCdn.requests
        + ' Station3D dependency CDN · runtime '
        + finite(runtimeTiming?.durationMs).toFixed(0) + 'ms');
    startupSnapshot = await readTrace(page);

    hostPreflight = await waitForCleanHost(page);
    if (!hostPreflight.clean) {
        const latestHost = hostPreflight.observations.at(-1)?.host || {};
        const message = 'host did not produce ' + CLEAN_SAMPLES
            + ' consecutive clean samples within ' + CLEAN_WAIT_S + 's; last '
            + hostText(latestHost);
        if (!ALLOW_BUSY_HOST) {
            throw new Error(message + ' (use --allow-busy-host for diagnostics only)');
        }
        log('WARNING ' + message);
    }

    pausedStart = await preparePerfMovementStart(page, { pausedStart, driveVehicle: !!DRIVE_VEHICLE });
    if (PAUSED_START) log('fully built cab resumed at ' + JSON.stringify(pausedStart.resumePose));

    if (OBSERVER.renderStalls) await installRenderStallProbe(page);
    if (CHROME_TRACE_OUT) {
        await startChromeTimeline(cdp);
        chromeTimelineStarted = true;
    }
    if (CPU_PROFILE_OUT) {
        await startCpuProfile(cdp);
        cpuProfileStarted = true;
    }
    if (HEAP_PROFILE_OUT) {
        await startHeapProfile(cdp);
        heapProfileStarted = true;
    }
    // Starting the V8 profiler itself took 414 ms in the 2026-09-05 trace.
    // Keep instrument startup outside the application's movement counters.
    movementStartPose = await page.evaluate(() => window.Station3D?.getPose?.() || null);
    await page.evaluate(installPerfFrameCadence);
    measurementReset = await resetMeasurement(page);
    if (WALK_CORRIDOR_M) {
        movementRoute = await runCorridorMovement(page, measurementSamples);
    } else if (WALK_STEPS.length > 0) {
        await runScriptedMovement(page, measurementSamples);
    } else {
        log('autonomous measurement for ' + SECONDS + 's');
        await collectForDuration(page, SECONDS, {
            phase: 'measurement',
            samples: measurementSamples,
            prefix: 'ride',
        });
    }
    measurementCadence = await page.evaluate(() => window.__perfFrameCadence.stop());
    measurementSnapshot = await readTrace(page);
    if (!measurementSnapshot) {
        measurementSnapshot = await waitForNextTrace(page, 0);
        rememberSample(measurementSamples, measurementSnapshot, 'measurement');
    }
    if (OBSERVER.renderStalls) {
        measurementSnapshot.renderStalls = await page.evaluate(() => window.__renderStallProbe());
    }
    if (measurementReset?.isolation === 'timestamp-boundary') {
        measurementSnapshot = isolatePerfTraceMeasurement(
            measurementSnapshot,
            measurementReset.startedAtMs,
        );
    }
    if (cpuProfileStarted) {
        await stopCpuProfile(cdp);
        cpuProfileStarted = false;
    }
    if (heapProfileStarted) {
        await stopHeapProfile(cdp);
        heapProfileStarted = false;
    }
    if (chromeTimelineStarted) {
        await stopChromeTimeline(cdp);
        chromeTimelineStarted = false;
    }

    if (SETTLE_SECONDS > 0) {
        settlePause = await pauseForSettle(page);
        settleReset = await resetMeasurement(page);
        log('settled phase for ' + SETTLE_SECONDS + 's');
        await collectForDuration(page, SETTLE_SECONDS, {
            phase: 'settle',
            samples: settleSamples,
            prefix: 'settle',
        });
        settleCadence = await page.evaluate(() => window.__perfFrameCadence.stop());
        settleSnapshot = await readTrace(page);
        if (OBSERVER.renderStalls) {
            settleSnapshot.renderStalls = await page.evaluate(start =>
                window.__renderStallProbe().filter(record => record.atMs >= start), settleReset.startedAtMs);
        }
        if (settleReset?.isolation === 'timestamp-boundary') {
            settleSnapshot = isolatePerfTraceMeasurement(
                settleSnapshot,
                settleReset.startedAtMs,
            );
        }
    }

    const groundDrain = GROUND_DRAIN_SECONDS > 0
        ? await waitForGroundDrain(page, GROUND_DRAIN_SECONDS, log) : null;
    if (groundDrain && !groundDrain.drained) rememberError(`post-timing ground did not drain: ${groundDrain.reason}`);

    // Several expensive builders expose exact phase/object diagnostics that
    // are intentionally too detailed for the per-frame overlay. Preserve them
    // in the artifact before closing the page; a queue label alone cannot tell
    // whether the next fix belongs in topology, texture readback, or assembly.
    runtimeDiagnostics = await page.evaluate(async () => {
        // Bundle runs and native-ESM runs must read the SAME live module graph.
        // Importing the source rail graph here during a bundle capture created
        // a second scene/buildings singleton and replaced its window diagnostics
        // with empty state just before collection.
        const hasLiveRailReport = typeof window.__s3dRailFormationBuildReport === 'function';
        let railFormation = hasLiveRailReport
            ? window.__s3dRailFormationBuildReport()
            : null;
        if (!hasLiveRailReport) {
            const rails = await import('/station-3d/world/rails.js');
            railFormation = typeof rails.getRailFormationBuildReport === 'function'
                ? rails.getRailFormationBuildReport()
                : null;
        }
        // Read the already-live renderer after both measurement phases. Never
        // import a second scene graph just to inspect its programs or caches.
        const debug = window.__st3dDebug;
        const groundPaint = debug?.state?.cabState?.groundPaint?.snapshot?.() || null;
        let groundPaintPrograms = null;
        if (groundPaint && debug?.renderer) {
            const renderer = debug.renderer, gl = renderer.getContext();
            const samplerTypes = new Set([
                gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW,
                gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW,
                gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D, gl.INT_SAMPLER_CUBE, gl.INT_SAMPLER_2D_ARRAY,
                gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D,
                gl.UNSIGNED_INT_SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY,
            ]);
            const programs = (renderer.info.programs || []).map(program => {
                const samplers = [];
                for (let i = 0; i < gl.getProgramParameter(program.program, gl.ACTIVE_UNIFORMS); i++) {
                    const uniform = gl.getActiveUniform(program.program, i);
                    if (samplerTypes.has(uniform?.type)) samplers.push({ name: uniform.name, size: uniform.size, type: uniform.type });
                }
                return { name: program.name, id: program.id, samplers,
                    samplerUnits: samplers.reduce((sum, uniform) => sum + uniform.size, 0) };
            }).filter(program => program.samplers.some(uniform => uniform.name === 'uReceiverPaintIds'));
            groundPaintPrograms = { programs,
                maxFragmentSamplerUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
                maxCombinedSamplerUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
                scope: 'active samplers for the entire linked program; conservative upper bound for its fragment stage' };
        }
        return {
            groundPaint,
            groundPaintPrograms,
            groundGeneration: window.__st3dDebug?.state?.cabState?.groundGenerations?.snapshot?.() || null,
            worldBake: typeof window.__worldBakeShadow === 'function'
                ? window.__worldBakeShadow()
                : null,
            roadsBuild: typeof window.__roadsBuildReport === 'function'
                ? window.__roadsBuildReport()
                : null,
            roadStreaming: typeof window.__s3dRoadStreamingState === 'function'
                ? window.__s3dRoadStreamingState()
                : null,
            railFormation,
            buildingBuildPhases: typeof window.__s3dBuildingBuildReport === 'function'
                ? window.__s3dBuildingBuildReport()
                : null,
            buildingBuildState: typeof window.__s3dBuildingBuildState === 'function'
                ? window.__s3dBuildingBuildState()
                : null,
            facadeAtlasOccupancy: typeof window.__s3dFacadeAtlasOccupancy === 'function'
                ? window.__s3dFacadeAtlasOccupancy()
                : null,
            decorStepMax: typeof window.__decorStepMax === 'function'
                ? window.__decorStepMax()
                : null,
            laneMarkingCache: typeof window.__laneMkCacheStats === 'function'
                ? window.__laneMkCacheStats()
                : null,
        };
    });
    if (groundDrain) runtimeDiagnostics.groundDrain = groundDrain;
    runtimeContext = await readRuntimeContext(page);

    if (SHOT) {
        // Hide dev overlays so the screenshot proves world correctness rather
        // than merely proving that the instrumentation rendered.
        await page.evaluate(() => {
            document.querySelectorAll('.station3d-dev-overlay')
                .forEach((element) => { element.style.display = 'none'; });
        });
        await sleep(page, 300);
        await page.screenshot({ path: SHOT });
        log('screenshot → ' + SHOT);
    }
} catch (error) {
    // Preserve the cause even if startup fails before a timing snapshot exists.
    // Previously the exception bypassed the console-error report below.
    const failure = { at: new Date().toISOString(), url: URL, error: String(error?.stack || error),
        consoleErrors: [...errors.entries()].slice(0, 100),
        background: await page?.evaluate(() => window.__perfTrace?.()?.background || null).catch(() => null) };
    if (JSON_OUT) writeFileSync(JSON_OUT + '.failure.json', JSON.stringify(failure, null, 2) + '\n');
    for (const [message, count] of failure.consoleErrors) log(`runtime error ${count}×: ${message}`);
    if (KEEP_BROWSER_ON_FAILURE && browser?.isConnected() && page && !page.isClosed()) {
        log('Diagnostic page retained; close this page to finish the failed capture.');
        await Promise.race([once(page, 'close'), once(browser, 'disconnected')]);
    }
    throw error;
} finally {
    if (cpuProfileStarted && cdp) {
        await stopCpuProfile(cdp).catch(error => {
            log('CPU profile cleanup failed: ' + String(error?.message || error));
        });
        cpuProfileStarted = false;
    }
    if (heapProfileStarted && cdp) {
        await stopHeapProfile(cdp).catch(error => {
            log('heap profile cleanup failed: ' + String(error?.message || error));
        });
        heapProfileStarted = false;
    }
    if (chromeTimelineStarted && cdp) {
        await stopChromeTimeline(cdp).catch(error => {
            log('Chrome timeline cleanup failed: ' + String(error?.message || error));
        });
        chromeTimelineStarted = false;
    }
    if (networkRecorder) fullNetwork = networkRecorder.snapshot();
    if (sourceCapture) await sourceCapture.close().catch(error => { rememberError(`source capture shutdown failed: ${error.message}`); log('source capture shutdown failed: ' + error.message); });
    if (browser) await browser.close();
}

if (!measurementSnapshot) throw new Error('no measurement snapshot was captured');
if (sourceCapture?.errors.length) for (const error of sourceCapture.errors) rememberError(`source capture: ${error.message || error}`);

const summary = summarizePerfTrace(measurementSnapshot);
const frameCadence = { ...measurementCadence, summary: summarizePerfFrameCadence(measurementCadence) };
const settleFrameCadence = settleCadence ? { ...settleCadence, summary: summarizePerfFrameCadence(settleCadence) } : null;
const sampleSummary = summarizePerfSamples(measurementSamples);
const gpuAttributionSummary = summarizeGpuAttribution(measurementSamples);
const validation = validateMeasurement(
    measurementSnapshot,
    summary,
    measurementSamples,
    errors,
);
if (!frameCadence.summary.valid || (SETTLE_SECONDS > 0 && !settleFrameCadence?.summary.valid)) {
    validation.valid = false;
    validation.reasons.push('frame cadence missing, invalid or over capacity');
}
if (recordingFixtures) {
    validation.valid = false;
    validation.reasons.push('source-fixture recording is diagnostic-only and invalid for timing');
}
const addValidationWarning = (message) => {
    validation.warnings = [...(validation.warnings || []), message];
};
if (!runtimeContext) {
    validation.valid = false;
    validation.reasons.push('runtime performance context was unavailable');
} else if (runtimeContext.profilerMode !== PROFILER_MODE) {
    validation.valid = false;
    validation.reasons.push('runtime profiler mode did not match the harness request');
}
if (runtimeContext?.compatibilityFallback === true) {
    addValidationWarning('legacy runtime context fallback; unverified: '
        + runtimeContext.unverifiedFields.join(', '));
}
if (worldReady?.compatibilityFallback === true && !worldReady.outcomeVerified) {
    addValidationWarning('legacy world-ready adapter; normal-vs-failsafe release is unverified');
}
const photoLikeWorld = ['photo', 'rw', 'real', 'photoreal']
    .some(key => parsedUrl.searchParams.has(key));
if (runtimeContext && !photoLikeWorld && TERRAIN_MODE === 'on'
    && runtimeContext.terrainActive !== true) {
    validation.valid = false;
    validation.reasons.push('elevation-on benchmark did not activate model terrain');
}
if (worldReady && !worldReady.skipped && worldReady.reason !== 'ready') {
    validation.valid = false;
    validation.reasons.push(
        `model world did not become ready (world-ready reason: ${worldReady.reason || 'missing'})`,
    );
}
await Promise.allSettled([...pendingCodeTasks]);
const codeFingerprintAfter = CODE_DIR ? auditCodeFingerprint(CODE_DIR) : null;
if (CODE_DIR && codeFingerprintBefore !== codeFingerprintAfter) rememberError('native code directory changed during capture');
const errorList = [...errors.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([message, count]) => ({ message, count }));
const route = {
    pathname: parsedUrl.pathname,
    params: Object.fromEntries([...parsedUrl.searchParams.entries()].sort()),
    walk: WALK_STEPS,
    walkCorridor: WALK_CORRIDOR_M ? { distanceM: WALK_CORRIDOR_M, repeats: WALK_CORRIDOR_REPEATS, protocol: 'distance-out-and-back-v1' } : null,
    autonomousSeconds: WALK_STEPS.length > 0 || WALK_CORRIDOR_M ? 0 : SECONDS,
    settleSeconds: SETTLE_SECONDS,
    viewport: VIEWPORT,
    startPolicy: PAUSED_START ? 'paused-fully-built' : (SETTLED_START ? 'fully-built' : 'ready'),
    groundSettledStart: GROUND_SETTLED_START,
    driveVehicle: DRIVE_VEHICLE || null,
    tramRoute: pinnedTramRoute,
};
const sourceFixtureMetadata = (sourceFixtures || recordingFixtures) ? {
    directory: path.resolve(SOURCE_FIXTURES || RECORD_SOURCE_FIXTURES),
    schema: 'station3d-audit-source-fixtures-v2',
    replay: !!sourceFixtures,
    complete: !!sourceFixtures,
    diagnosticsOnly: !!recordingFixtures,
    reason: recordingFixtures ? 'source-fixture-recording-is-not-a-timing-measurement' : null,
    entries: (sourceFixtures || recordingFixtures).size,
    manifestHash: (sourceFixtures || recordingFixtures).hash(),
} : null;
const comparison = comparisonBaseline ? {
    baselinePath: COMPARE_WITH,
    mismatches: perfRunCompatibilityMismatches(comparisonBaseline, {
        harness: {
            headless: HEADLESS,
            observer: OBSERVER,
            route,
            runtimeContext,
            sourceFixtures: sourceFixtureMetadata,
        },
    }),
} : null;
if (comparison?.mismatches.length > 0) {
    validation.valid = false;
    validation.reasons.push(
        `A/B contract mismatch (${comparison.mismatches.length} dimension(s))`,
    );
}
const output = {
    ...measurementSnapshot,
    summary,
    sampleSummary,
    gpuAttributionSummary,
    harness: {
        schemaVersion: 6,
        observer: OBSERVER,
        label: LABEL || null,
        url: URL,
        mode: MODE || null,
        route,
        runtimeContext,
        runtimeTiming,
        measurementReset,
        settleReset,
        settlePause,
        movementRoute,
        movementStartPose,
        frameCadence,
        settleFrameCadence,
        comparison,
        startedAt: runStartedAt,
        completedAt: new Date().toISOString(),
        headless: HEADLESS,
        displayCadence,
        terrainMode: TERRAIN_MODE,
        sourceFixtures: sourceFixtureMetadata,
        servedCode: CODE_DIR ? { codeDir: CODE_DIR, fingerprintBefore: codeFingerprintBefore, fingerprintAfter: codeFingerprintAfter } : null,
        worldReady,
        settledStart,
        pausedStart,
        hostPreflight,
        expectedMovement: EXPECT_MOVEMENT,
        expectedGtaOccupant: EXPECT_GTA_OCCUPANT || null,
        measurementSamples,
        settleSamples,
        validation,
        errors: errorList,
        network: {
            playable: playableNetwork,
            startup: startupNetwork,
            fullRun: fullNetwork,
        },
    },
    phaseSnapshots: {
        startup: startupSnapshot,
        settle: settleSnapshot,
    },
    runtimeDiagnostics,
};

printSnapshot(measurementSnapshot, summary, sampleSummary, validation, measurementSamples);
console.log('\nframe cadence: ' + frameCadence.summary.count + ' intervals · mean '
    + frameCadence.summary.meanFrameMs?.toFixed(2) + 'ms · p95 '
    + frameCadence.summary.p95FrameMs?.toFixed(2) + 'ms · p99 '
    + frameCadence.summary.p99FrameMs?.toFixed(2) + 'ms');
if (startupSnapshot) {
    const startupSummary = summarizePerfTrace(startupSnapshot);
    console.log('\nstartup kept separately: ' + startupSummary.stutterTotal
        + ' stutters · worst '
        + finite(startupSummary.worstFrames[0]?.frameMs).toFixed(0) + 'ms');
}
if (worldReady) {
    console.log('world load: ' + (finite(worldReady.elapsedMs) / 1000).toFixed(1) + 's'
        + (worldReady.reason ? ' · ' + worldReady.reason : '')
        + ' · byte regressions ' + (worldReady.byteRegressions?.length || 0)
        + ' · component regressions ' + (worldReady.componentRegressions?.length || 0)
        + ' · reopened queues ' + (worldReady.componentReopenings?.length || 0));
}
printNetwork('startup network', startupNetwork);
if (settleSnapshot) {
    const settleSummary = summarizePerfTrace(settleSnapshot);
    console.log('settle kept separately: ' + settleSummary.stutterTotal
        + ' stutters · frame ' + settleSnapshot.frameAvgMs.toFixed(1) + 'ms'
        + ' · host ' + hostText(settleSnapshot.host));
}
if (errorList.length) {
    console.log('\nconsole/page errors:');
    for (const entry of errorList.slice(0, 10)) {
        console.log('  ' + String(entry.count).padStart(4) + '×  ' + entry.message);
    }
} else {
    console.log('\nconsole/page errors: none');
}
if (comparison) {
    if (comparison.mismatches.length === 0) {
        console.log('\nA/B contract: compatible with ' + comparison.baselinePath);
    } else {
        console.log('\nA/B contract: REJECTED against ' + comparison.baselinePath);
        for (const mismatch of comparison.mismatches.slice(0, 20)) {
            console.log('  - ' + formatPerfRunMismatch(mismatch));
        }
    }
}
if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(output, null, 2));
    console.log('\nfull phase-isolated snapshot → ' + JSON_OUT);
}
if (!validation.valid) process.exitCode = 2;
