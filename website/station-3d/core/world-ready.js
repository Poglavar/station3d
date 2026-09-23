// Coordinates the "hold a loading screen until the near-field is built" gate for
// the model world. The cab used to drop the camera into a half-built scene and
// stream roads/buildings in over several seconds at 1–2 fps; instead we hold an
// opaque overlay (with the sim frozen so the tram doesn't advance and only the
// near-field streams) until the terrain, all layer beginSessions, and every
// required near-field streaming queue that has started has settled once — then
// reveal in one step. Horizon-only work may continue behind the ready world.
//
// Pure state machine: no DOM, no THREE. The overlay/freeze wiring lives in cab.js;
// this module only decides when "ready" is reached.

import { startupTrace } from './startup-trace.js';

const REQUIRED_PHASE = 'deferred-built';   // every layer's beginSession has run
// Failsafe: the hold releases after this long WITHOUT PROGRESS — a stalled or
// empty world can never trap the loading screen, but an honestly progressing
// one (the 1 m route-band download runs tens of seconds) is not dumped into a
// half-built scene at a fixed deadline. Progress = bytes arriving on a
// terrain fetch, a phase completing, or a streaming queue draining. The
// absolute ceiling still bounds a pathological trickle.
const MAX_STALL_MS = 12000;
const MAX_BUILD_ABSOLUTE_MS = 120000;
// A campaign chapter owns a longer contract than free roam: its curtain says
// what is being built and its own watchdog fails a scene that stops
// progressing, so the generic ceiling must not pre-empt it on a slow host
// (chapter 1 failed at 120 s on a laptop at load 37 while still building).
// The caller passes the ceiling per build; the default is free roam's.
let buildCeilingMs = MAX_BUILD_ABSOLUTE_MS;
const PHASE_COMPONENTS = [
    { key: 'terrain-data', phase: 'terrain-data-ready' },
    { key: 'terrain-decode', phase: 'terrain-decode-ready' },
    { key: 'terrain-mesh', phase: 'blocking-ready' },
    { key: 'base', phase: 'immediate-built' },
    { key: 'layers', phase: 'deferred-built' },
];
// The model-world streaming queues, in loading-bar order. Shown as segments from
// the start (all present, greyed) and greened as each drains — matching frame-
// chunk-queue labels in world/{roads,curbs,rails,cars,buildings,buildings-far}.js.
const KNOWN_QUEUES = [
    'roads', 'curbs', 'lane-markings.rebuild', 'rail-cells',
    'cars', 'buildings', 'far-buildings',
];
// Far LOD1 fills the fog horizon after the detailed near field. Waiting for it
// would invert that priority and force every model session to hit the 12 s
// failsafe even when the observer's detailed surroundings are already ready.
const NON_BLOCKING_QUEUES = new Set(['far-buildings']);

function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

let building = false;
let buildStartMs = 0;
let lastProgressMs = 0;
let outageLabels = [];
let readyCallbacks = [];
const seenQueues = new Set();   // streaming queues that have done real work
const idleQueues = new Set();   // …that are currently drained
// Presentation state is monotonic even though readiness must remain live. A
// queue can drain and then receive a late batch while another component keeps
// the hold open; it should stay visibly completed while `active` shows that it
// is doing follow-up work, rather than regressing from bright to dark green.
const settledQueues = new Set();
// Surface-only queues may be temporarily outside the startup contract while
// the observer is sealed inside a tunnel. This remains one readiness machine:
// callers change which existing queues are visible, and removing an exemption
// before reveal makes an unfinished queue blocking again.
const optionalQueues = new Set();
const phases = new Set();
const fetchProgress = new Map();   // fetch key → { receivedBytes, totalBytes }
// A streaming queue's own completed/total ratio (the campaign drive corridor
// reports its ready points here), so the loading bar and the readiness
// watchdog see a level that is still coming together, not a frozen percentage.
const queueProgress = new Map();   // queue label → fraction 0..1
// Bumped whenever the build does anything observable (a queue processed
// items this frame, drained, a phase completed, bytes arrived, a requirement
// changed). Monotonic across builds. The campaign readiness watchdog polls it,
// because the chapter bar can sit on one label for a minute while a queue is
// honestly working through a long drain.
let activitySerial = 0;
let transferBytes = 0;             // bytes on the wire since the build began
let completedMs = null;
let completedReason = null;
// Named reasons the world cannot become ready (a capacity failure, a missing
// evidence source). They do not hold the curtain themselves; they say why a
// timeout release happened instead of leaving an anonymous 'timeout'.
const buildBlockers = new Map();   // key → { code, message }
let completedBlockers = [];
const activeDataRequests = new Map(); // request key → overlapping request count
// Some authored scenes have a stronger contract than the generic near-field
// reveal: gameplay is invalid until a named world requirement is complete.
// Unlike a slow fetch, a requirement may span many fetch/decode/build queues,
// so neither the 12 s stall detector nor the absolute failsafe may silently
// reveal through it. The user can still leave the scene (`forceWorldReady`).
const requiredBuilds = new Set();
const componentOrder = [];      // queue labels in first-seen order (for the loading bar)
const firstActiveMs = new Map();// label → first-active time (component duration measurement)
const firstIdleMs = new Map();  // label → first settlement time
const phaseDoneMs = new Map();  // phase name → completion time
const milestoneDoneMs = new Map(); // milestone name → elapsed milliseconds from build start
const PHASE_MILESTONES = Object.freeze({
    'blocking-ready': 'terrain-ready',
});
const QUEUE_MILESTONES = Object.freeze({
    buildings: 'support-buildings-ready',
});

function trackComponent(label) {
    if (!componentOrder.includes(label)) componentOrder.push(label);
    if (!firstActiveMs.has(label)) firstActiveMs.set(label, nowMs());
}

export function beginWorldBuild({ ceilingMs = null } = {}) {
    building = true;
    buildStartMs = nowMs();
    const ceiling = Number(ceilingMs);
    buildCeilingMs = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : MAX_BUILD_ABSOLUTE_MS;
    lastProgressMs = buildStartMs;
    readyCallbacks = [];
    seenQueues.clear();
    idleQueues.clear();
    settledQueues.clear();
    optionalQueues.clear();
    phases.clear();
    fetchProgress.clear();
    queueProgress.clear();
    transferBytes = 0;
    completedMs = null;
    completedReason = null;
    buildBlockers.clear();
    completedBlockers = [];
    activeDataRequests.clear();
    requiredBuilds.clear();
    componentOrder.length = 0;
    firstActiveMs.clear();
    firstIdleMs.clear();
    phaseDoneMs.clear();
    milestoneDoneMs.clear();
}

// Record or clear (detail = null) a diagnosed reason this build cannot finish.
export function setWorldBuildBlocker(key, detail) {
    if (!key) return;
    if (!detail) { buildBlockers.delete(String(key)); return; }
    buildBlockers.set(String(key), Object.freeze({ key: String(key),
        code: String(detail.code || 'blocked'), message: String(detail.message || '') }));
}

// Current blockers while building; the ones present at completion afterwards.
export function getWorldBuildBlockers() {
    return building ? [...buildBlockers.values()] : completedBlockers.slice();
}

export function isWorldBuilding() {
    return building;
}

export function noteWorldPhase(name) {
    if (!building) return;
    lastProgressMs = nowMs();
    activitySerial += 1;
    phases.add(name);
    if (!phaseDoneMs.has(name)) phaseDoneMs.set(name, nowMs());
    if (PHASE_MILESTONES[name]) noteWorldMilestone(PHASE_MILESTONES[name]);
    check();
}

// Exact startup boundaries used by production diagnostics. Unlike queue
// durations, milestones remain available after readiness so the actual curtain
// removal can be recorded by the UI on the following callback/frame.
export function noteWorldMilestone(name) {
    const key = String(name || '').trim();
    if (!key || (!building && completedReason === null) || milestoneDoneMs.has(key)) return false;
    const elapsedMs = Math.max(0, nowMs() - buildStartMs);
    milestoneDoneMs.set(key, elapsedMs);
    startupTrace.milestone(key);
    return true;
}

export function getWorldLoadMilestones() {
    return [...milestoneDoneMs].map(([name, ms]) => ({ name, ms }));
}

// A streaming queue processed items this frame (so it must be awaited before we
// call the near-field ready). That is progress: a terrain decode or a road build
// working through a long queue on a slow host must not trip the stall failsafe
// below at 12 s with no bytes arriving and no phase completing — it did, and a
// chapter failed with "did not finish loading" while the level was being built.
// A queue that never finishes is still bounded by the absolute ceiling.
export function noteWorldQueueActive(label) {
    if (!building) return;
    lastProgressMs = nowMs();
    activitySerial += 1;
    seenQueues.add(label);
    trackComponent(label);
    idleQueues.delete(label);
}

// A streaming queue reports how much of its own bounded work is finished (the
// drive corridor: ready points over corridor points). Only an increase counts.
export function noteWorldQueueProgress(label, completed, total) {
    if (!building || label == null) return;
    const totalCount = Number(total);
    const completedCount = Number(completed);
    if (!Number.isFinite(totalCount) || totalCount <= 0 || !Number.isFinite(completedCount)) return;
    const key = String(label);
    const fraction = Math.max(0, Math.min(1, completedCount / totalCount));
    const previous = queueProgress.get(key);
    if (previous !== undefined && fraction <= previous) return;
    queueProgress.set(key, fraction);
    lastProgressMs = nowMs();
    activitySerial += 1;
}

// A streaming queue drained. Queues re-fill as the camera moves, but their first
// settlement completes the ordinary startup obligation. Explicit gameplay
// requirements still use current idle state to require one quiescent generation.
export function noteWorldQueueIdle(label) {
    if (!building) return;
    lastProgressMs = nowMs();
    activitySerial += 1;
    seenQueues.add(label);
    trackComponent(label);
    if (!firstIdleMs.has(label)) firstIdleMs.set(label, nowMs());
    idleQueues.add(label);
    settledQueues.add(label);
    if (QUEUE_MILESTONES[label]) noteWorldMilestone(QUEUE_MILESTONES[label]);
    check();
}

export function setWorldBuildOptionalQueues(labels = []) {
    if (!building) return;
    const next = new Set(Array.isArray(labels) ? labels.map(String) : []);
    const changed = next.size !== optionalQueues.size
        || [...next].some(label => !optionalQueues.has(label));
    if (!changed) return;
    optionalQueues.clear();
    for (const label of next) optionalQueues.add(label);
    lastProgressMs = nowMs();
    activitySerial += 1;
    check();
}

// Measured durations (ms) of the just-finished build, per component: the scene
// phase from build start, each queue from first-active to first settlement.
// Read after onWorldReady fires (state persists until the next beginWorldBuild)
// so a caller can feed experienced-time weights to the loading bar.
export function getWorldLoadDurations() {
    const out = {};
    let previousMs = buildStartMs;
    for (const component of PHASE_COMPONENTS) {
        const completedMs = phaseDoneMs.get(component.phase);
        if (!Number.isFinite(completedMs)) break;
        out[component.key] = Math.max(0, completedMs - previousMs);
        previousMs = completedMs;
    }
    for (const label of componentOrder) {
        const start = firstActiveMs.get(label);
        const end = firstIdleMs.get(label);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            out[label] = end - start;
        }
    }
    return out;
}

// Loading components for the model-world bar: the scene phase, then ALL known
// streaming queues (present from the start, so the segments don't pop in one by
// one), each with its settled (done) state — plus any unexpected seen queue.
// Empty once not building.
export function getWorldLoadComponents() {
    if (!building) return [];
    const firstPendingPhase = PHASE_COMPONENTS.find(component => !phases.has(component.phase));
    const out = PHASE_COMPONENTS.map(component => ({
        key: component.key,
        done: phases.has(component.phase),
        active: component === firstPendingPhase,
        ...(component.key === 'terrain-data' && !phases.has(component.phase)
            ? { progress: getWorldDataProgress() }
            : {}),
    }));
    const extras = componentOrder.filter((l) => !KNOWN_QUEUES.includes(l));
    for (const label of [...KNOWN_QUEUES, ...extras]) {
        out.push({
            key: label,
            done: settledQueues.has(label) || optionalQueues.has(label),
            active: !optionalQueues.has(label) && seenQueues.has(label) && !idleQueues.has(label),
            ...(optionalQueues.has(label) ? { optional: true } : {}),
            ...(queueProgress.has(label) && !settledQueues.has(label)
                ? { progress: queueProgress.get(label) }
                : {}),
        });
    }
    return out;
}

// Register a callback for when the world is ready. Fires immediately if we are
// not (or no longer) building. Receives the reason: 'ready' | 'timeout' | 'forced'.
export function onWorldReady(callback) {
    if (typeof callback !== 'function') return;
    if (!building) { callback('immediate'); return; }
    readyCallbacks.push(callback);
}

// Download bytes arrived (terrain grid fetches report through here), so the
// build is alive: push the stall deadline out. With a key and sizes, the
// bytes also feed the aggregate Data percentage on the loading bar.
export function noteWorldBuildProgress(key, receivedBytes, totalBytes) {
    if (!building) return;
    lastProgressMs = nowMs();
    activitySerial += 1;
    if (key != null && Number.isFinite(totalBytes) && totalBytes > 0) {
        const progressKey = String(key);
        const previous = fetchProgress.get(progressKey);
        const nextTotal = Math.max(previous?.totalBytes || 0, totalBytes);
        const nextReceived = Math.max(
            previous?.receivedBytes || 0,
            Math.max(0, Math.min(Number(receivedBytes) || 0, totalBytes)),
        );
        fetchProgress.set(progressKey, {
            receivedBytes: Math.min(nextReceived, nextTotal),
            totalBytes: nextTotal,
        });
    }
}

// A terrain query can spend tens of seconds computing server-side before the
// first response byte exists. That is still an active load, not a stalled
// world. Track its lifetime explicitly so the short stall failsafe only covers
// a world with neither data activity nor diagnosed outage. The absolute build
// ceiling remains authoritative even while a request is active.
export function noteWorldBuildRequestActive(key) {
    if (!building || key == null) return;
    const requestKey = String(key);
    activeDataRequests.set(requestKey, (activeDataRequests.get(requestKey) || 0) + 1);
    lastProgressMs = nowMs();
    activitySerial += 1;
}

export function noteWorldBuildRequestIdle(key) {
    if (!building || key == null) return;
    const requestKey = String(key);
    const remaining = (activeDataRequests.get(requestKey) || 0) - 1;
    if (remaining > 0) activeDataRequests.set(requestKey, remaining);
    else activeDataRequests.delete(requestKey);
    lastProgressMs = nowMs();
    activitySerial += 1;
}

// Register a gameplay-critical loading contract. This is deliberately distinct
// from a request: one drive corridor can encompass terrain workers, road source
// delivery, formation builds and final GPU publication. A generic timeout must
// never turn that unfinished contract into a playable scene.
export function noteWorldBuildRequirementActive(key) {
    if (!building || key == null) return;
    requiredBuilds.add(String(key));
    lastProgressMs = nowMs();
    activitySerial += 1;
}

export function noteWorldBuildRequirementIdle(key) {
    if (!building || key == null) return;
    requiredBuilds.delete(String(key));
    lastProgressMs = nowMs();
    activitySerial += 1;
    check();
}

// A gameplay-critical requirement must not unregister itself while an ordinary
// layer queue is still open. Otherwise `check()` can remain held by that queue,
// the requirement stops being observed, and a later road/rail replacement can
// arrive in the gap before the ordinary queue finally drains. Callers use this
// as the last synchronous predicate before marking their own requirement idle.
export function canReleaseWorldBuildRequirement(key) {
    if (!building || key == null || !phases.has(REQUIRED_PHASE)) return false;
    const ignored = String(key);
    for (const requirement of requiredBuilds) {
        if (requirement !== ignored) return false;
    }
    for (const queue of seenQueues) {
        if (queue === ignored || NON_BLOCKING_QUEUES.has(queue) || optionalQueues.has(queue)) continue;
        if (!idleQueues.has(queue)) return false;
    }
    return true;
}

// Aggregate download fraction across every reporting fetch, or null before
// any fetch has announced its size. Denominators appear as requests deliver
// their first bytes (they all start together), so the figure is honest within
// the first round trip.
export function getWorldDataProgress() {
    if (fetchProgress.size === 0) return null;
    let receivedBytes = 0;
    let totalBytes = 0;
    for (const entry of fetchProgress.values()) {
        receivedBytes += entry.receivedBytes;
        totalBytes += entry.totalBytes;
    }
    return totalBytes > 0 ? receivedBytes / totalBytes : null;
}

// A response finished arriving over the network (Resource Timing transfer
// size, reported by the cab while the hold is up). This is what the player
// actually downloaded; the decoded figure below is several times larger.
export function noteWorldTransferBytes(bytes) {
    if (!building) return;
    const value = Number(bytes);
    if (Number.isFinite(value) && value > 0) transferBytes += value;
}

// Live figures for the opaque model-world loading overlay. Terrain grids report
// decompressed bytes while streaming; the shared tile session records decoded
// road, building, traffic, and other response bodies through the same function.
// `receivedBytes` is that monotonic per-request high-water estimate, not bytes
// on the wire; `transferBytes` is the wire figure when the host reports one.
export function getWorldLoadTelemetry() {
    let receivedBytes = 0;
    for (const entry of fetchProgress.values()) receivedBytes += entry.receivedBytes;
    return {
        elapsedMs: building
            ? Math.max(0, nowMs() - buildStartMs)
            : Math.max(0, Number(completedMs) || 0),
        completedMs,
        readyReason: completedReason,
        blockers: getWorldBuildBlockers(),
        receivedBytes,
        transferBytes,
        activitySerial,
        milestones: getWorldLoadMilestones(),
    };
}

// A DIAGNOSED data outage — every fetch to a source failing, announced by the
// tile stream's health tracker after consecutive failures. While one is on,
// the stall failsafe is suspended: dropping the hold would reveal an empty
// plane with no explanation, while the sources are already retrying with
// backoff and stream the world in the moment the server answers. The overlay
// says why it is waiting (ui/dashboard.js), and the absolute ceiling below
// still bounds the hold — nothing waits forever.
export function setWorldDataOutage(labels) {
    const next = Array.isArray(labels) ? labels.filter(Boolean) : [];
    const changed = next.length !== outageLabels.length
        || next.some((label, index) => label !== outageLabels[index]);
    outageLabels = next;
    // An outage transition IS the build's progress story — in particular on
    // RECOVERY the stall clock is an outage long overdue, and without this
    // reset the failsafe would dump the hold in the same tick the data starts
    // flowing again.
    if (building && changed) lastProgressMs = nowMs();
}

export function getWorldDataOutage() {
    return outageLabels.slice();
}

// Called every frame while building; releases the hold if the failsafe elapses so
// a stalled or empty world can never trap the loading screen.
export function tickWorldReady() {
    if (!building) return;
    // A required build is a level-load boundary, not best-effort scenery. If it
    // stalls, retaining the curtain is safer than spawning a vehicle onto an
    // unfinished physical/visual surface. Scene teardown still calls the
    // explicit force path, so this cannot trap navigation away from the level.
    if (requiredBuilds.size > 0) return;
    const now = nowMs();
    if ((outageLabels.length === 0 && activeDataRequests.size === 0
            && now - lastProgressMs > MAX_STALL_MS)
        || now - buildStartMs > buildCeilingMs) {
        finish('timeout');
    }
}

// Abandon the hold immediately (cab closed, or an explicit skip).
export function forceWorldReady() {
    if (building) finish('forced');
}

function check() {
    if (!building) return;
    if (requiredBuilds.size > 0) return;
    if (!phases.has(REQUIRED_PHASE)) return;
    const requiredQueues = [...seenQueues].filter(queue => (
        !NON_BLOCKING_QUEUES.has(queue) && !optionalQueues.has(queue)
    ));
    if (requiredQueues.length === 0) return;           // no near-field stream has started yet
    for (const queue of requiredQueues) {
        if (!settledQueues.has(queue)) return;         // has not completed startup work yet
    }
    finish('ready');
}

function finish(reason) {
    completedMs = Math.max(0, nowMs() - buildStartMs);
    completedReason = reason;
    completedBlockers = [...buildBlockers.values()];
    building = false;
    const callbacks = readyCallbacks;
    readyCallbacks = [];
    for (const callback of callbacks) {
        try { callback(reason); } catch (err) { console.warn('[world-ready] callback failed', err); }
    }
    // Byte keys contain complete request URLs and are useful only while the
    // overlay is visible. Release them as soon as callbacks have observed the
    // completed build so a long moving session retains no startup accounting.
    fetchProgress.clear();
    queueProgress.clear();
    activeDataRequests.clear();
    requiredBuilds.clear();
}

// Test hook: reset all state.
export function _resetWorldReady() {
    building = false;
    buildStartMs = 0;
    lastProgressMs = 0;
    outageLabels = [];
    readyCallbacks = [];
    seenQueues.clear();
    idleQueues.clear();
    settledQueues.clear();
    optionalQueues.clear();
    phases.clear();
    fetchProgress.clear();
    queueProgress.clear();
    transferBytes = 0;
    completedMs = null;
    completedReason = null;
    buildBlockers.clear();
    completedBlockers = [];
    activeDataRequests.clear();
    requiredBuilds.clear();
    componentOrder.length = 0;
    firstActiveMs.clear();
    firstIdleMs.clear();
    phaseDoneMs.clear();
    milestoneDoneMs.clear();
}
