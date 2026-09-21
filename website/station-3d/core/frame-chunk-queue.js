// Small idle-priority chunk queue for main-thread scene work.
// Heavy feature processing only consumes browser idle time when available.

import { startupTrace } from './startup-trace.js';
import {
    isWorldBuilding,
    noteWorldBuildProgress,
    noteWorldQueueActive,
    noteWorldQueueIdle,
} from './world-ready.js';
import { registerBackgroundActivityReader } from './background-activity.js';
import { reportOutOfLoopWork } from './out-of-loop-work.js';
import {
    adaptiveFrameWorkBudget,
    createObserverMotionTracker,
    FRAME_WORK_CLASSES,
    resolveFrameWorkSchedulerMode,
} from './frame-work-policy.js';
import { finiteOrNull } from './math.js';

function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

let observerX = Number.NaN;
let observerZ = Number.NaN;
let observerViewHeadingDeg = Number.NaN;
let observerLastMovedMs = -Infinity;
let observerLastViewMovedMs = -Infinity;
let observerMovementGateEnabled = true;
const observerMotion = createObserverMotionTracker({ now: nowMs });
const registeredQueues = new Set();
let schedulerModeOverride = null;
let frameSequence = 0;
let adaptiveBudget = adaptiveFrameWorkBudget();
let adaptiveSpentTotalMs = 0;
let adaptiveSpentByClass = new Map();
// Monotonic, NEVER reset per frame. The per-frame counters above are cleared by
// resetAdaptiveFrame, so anything sampling the snapshot on a timer reads one
// arbitrary frame — and most frames legitimately run no queue work at all. The
// perf overlay was doing exactly that and reporting "0.0 spent, 82 waiting" as
// starvation once a second. A consumer differences these across its own window
// instead, which is the only way to get a spend that means anything.
let lifetimeSpentTotalMs = 0;
const lifetimeSpentByClass = new Map();
let lifetimeFrames = 0;
let adaptiveChargedTotalMs = 0;
let lastFrameChargedTotalMs = 0;
let lastFrameBudgetTotalMs = 0;
let adaptiveChargedByClass = new Map();
let adaptiveChargedByQueue = new Map();
let lastFarProgressMs = -Infinity;
let lastObserverNoteMs = -Infinity;
let sceneWorkMs = null;
let sceneWorkAtMs = -Infinity;
let lastAdaptiveResetMs = nowMs();
const OBSERVER_SETTLE_MS = 450;
const OBSERVER_MOVE_EPSILON_SQ = 0.01;
const OBSERVER_VIEW_MOVE_EPSILON_DEG = 0.25;
const FAST_DISPLAY_FRAME_MS = 1000 / 120;
const MAX_CADENCE_ITEM_CAP_SCALE = 4;
// Far work yields to delivery and near — but "lowest priority" must not mean
// "never". While the world is streaming, one of those classes is essentially
// always pending, so the yield below starved far work completely: every trace
// showed `far 0/0(761 waiting!)`, a backlog that only ever grew, and the
// horizon buildings it feeds never appeared. Let one item through this often so
// the queue drains slowly instead of never.
const FAR_PROGRESS_INTERVAL_MS = 500;
// Far may borrow from a frame the near world demonstrably did not fill. Measured
// walking Split: near spent 99 of 728 ms allocated and far spent 0 of 112, while
// 708 far items sat waiting — the frame had headroom and the horizon starved
// anyway, taking ~6 minutes to fill at one item per interval. Borrowing is
// capped at HALF the unclaimed time and never exceeds the queue's own budget, so
// near keeps first call on every frame and far can only use what was going idle.
const FAR_BORROW_MIN_HEADROOM_MS = 4;
const FAR_BORROW_SHARE = 0.5;
// Chromium can starve requestIdleCallback indefinitely in a continuously
// animated WebGL scene. A short timeout guarantees progress; the flush itself
// remains bounded to a one-millisecond slice, so this cannot turn into an
// unbounded main-thread build.
const IDLE_CATCH_UP_TIMEOUT_MS = 250;
const IDLE_CATCH_UP_BUDGET_MS = 1;
const DEPENDENCY_WAIT_PROBE_BUDGET_MS = 0.25;
const SURFACE_NEAR_RESERVATION_SHARE = 0.75;

// An item callback can return this after one cooperative stage. The queue
// charges and reports that stage normally, but keeps the item at the head of
// its job so the next stage resumes only if this frame still has budget.
export const FRAME_CHUNK_REPEAT_ITEM = Symbol('frame-chunk-repeat-item');
// An external producer must finish before this item can make progress. Unlike
// a next-frame yield, this releases its work share while retaining a retry probe.
export const FRAME_CHUNK_WAIT_ITEM = Symbol('frame-chunk-wait-item');
// Resume no earlier than the next frame, retaining the ordinary runnable share.
export const FRAME_CHUNK_DEFER_ITEM = Symbol('frame-chunk-defer-item');

function schedulerMode() {
    return schedulerModeOverride || resolveFrameWorkSchedulerMode();
}

// Offline compile (the campaign pack bake): every queue drains at full
// throttle and nothing yields to the player, because there is none. Set by
// the cab for a bake session and cleared with it (core/frame-work-policy.js).
let schedulerThroughputOverride = false;

export function setFrameChunkSchedulerThroughput(enabled) {
    schedulerThroughputOverride = enabled === true;
    resetAdaptiveFrame();
}

function currentAdaptiveBudget() {
    const motion = observerMotion.snapshot();
    return adaptiveFrameWorkBudget({
        motionState: motion.state,
        previousFrameMs: motion.previousFrameMs,
        sceneWorkMs: currentSceneWorkMs(),
        viewMoving: nowMs() - observerLastViewMovedMs < OBSERVER_SETTLE_MS,
        loading: isWorldBuilding(),
        offlineCompile: schedulerThroughputOverride,
    });
}

function currentSceneWorkMs() {
    return nowMs() - sceneWorkAtMs <= 1000 ? sceneWorkMs : null;
}

// Called at the end of the real render loop, including its hooks and
// diagnostics. This refines this frame's allowance without refunding work
// already charged by queue callbacks. Display cadence still sizes explicit
// item-count guards, but is not a measurement of occupied CPU time.
export function noteFrameChunkSceneWork(durationMs) {
    sceneWorkMs = typeof durationMs === 'number' && Number.isFinite(durationMs)
        && durationMs >= 0 ? durationMs : null;
    sceneWorkAtMs = nowMs();
    adaptiveBudget = currentAdaptiveBudget();
}

function resetAdaptiveFrame() {
    // Remember what the PREVIOUS frame actually used. The far branch borrows on
    // this rather than on the frame in progress, because queues are not flushed
    // in a guaranteed order: judging "is there headroom" mid-frame would let far
    // claim the budget before near had asked for it, inverting the priority
    // this scheduler exists to enforce.
    lastFrameChargedTotalMs = adaptiveChargedTotalMs;
    lastFrameBudgetTotalMs = adaptiveBudget.totalBudgetMs || 0;
    frameSequence += 1;
    lifetimeFrames += 1;
    adaptiveSpentTotalMs = 0;
    adaptiveSpentByClass = new Map();
    adaptiveChargedTotalMs = 0;
    adaptiveChargedByClass = new Map();
    adaptiveChargedByQueue = new Map();
    adaptiveBudget = currentAdaptiveBudget();
    lastAdaptiveResetMs = nowMs();
}

export function setFrameChunkSchedulerMode(mode = null) {
    schedulerModeOverride = mode === 'legacy' || mode === 'adaptive' ? mode : null;
    resetAdaptiveFrame();
}

export function resetFrameChunkObserver() {
    observerX = Number.NaN;
    observerZ = Number.NaN;
    observerViewHeadingDeg = Number.NaN;
    observerLastMovedMs = -Infinity;
    observerLastViewMovedMs = -Infinity;
    observerMovementGateEnabled = true;
    observerMotion.reset();
    lastFarProgressMs = -Infinity;
    lastObserverNoteMs = -Infinity;
    sceneWorkMs = null;
    sceneWorkAtMs = -Infinity;
    resetAdaptiveFrame();
}

export function resetFrameChunkSessionStatistics() {
    lifetimeSpentTotalMs = 0;
    lifetimeSpentByClass.clear();
    lifetimeFrames = 0;
    for (const queue of registeredQueues) queue.resetStatistics?.();
}

export function getFrameChunkSchedulerSnapshot() {
    const motion = observerMotion.snapshot();
    return {
        mode: schedulerMode(),
        phase: adaptiveBudget.phase,
        frameSequence,
        motionState: motion.state,
        workMotionState: adaptiveBudget.motionState,
        speedMps: motion.speedMps,
        observerX: motion.x,
        observerZ: motion.z,
        observerViewHeadingDeg,
        observerViewMoving: nowMs() - observerLastViewMovedMs < OBSERVER_SETTLE_MS,
        previousFrameMs: motion.previousFrameMs,
        sceneWorkMs: currentSceneWorkMs(),
        totalBudgetMs: adaptiveBudget.totalBudgetMs,
        classBudgets: { ...adaptiveBudget.classBudgets },
        spentTotalMs: adaptiveSpentTotalMs,
        // Monotonic totals for a consumer to difference over its own window; see
        // lifetimeSpentTotalMs. `spentTotalMs` above is THIS FRAME only.
        lifetimeSpentTotalMs,
        lifetimeSpentByClass: Object.fromEntries(FRAME_WORK_CLASSES.map(workClass => (
            [workClass, lifetimeSpentByClass.get(workClass) || 0]
        ))),
        lifetimeFrames,
        spentByClass: Object.fromEntries(FRAME_WORK_CLASSES.map(workClass => (
            [workClass, adaptiveSpentByClass.get(workClass) || 0]
        ))),
        chargedTotalMs: adaptiveChargedTotalMs,
        chargedByClass: Object.fromEntries(FRAME_WORK_CLASSES.map(workClass => (
            [workClass, adaptiveChargedByClass.get(workClass) || 0]
        ))),
        queues: [...registeredQueues].map(queue => ({
            label: queue.label,
            workClass: queue.workClass,
            workTier: queue.workTier,
            workWeight: queue.interactiveWeight(),
            criticalPath: queue.criticalPath,
            reservationMs: queue.stationaryReservationMs(),
            pendingItems: queue.pendingItems(),
            pendingJobs: queue.pendingJobs(),
            deferring: queue.deferSummaries(),
            processedItems: queue.processedItems,
            cpuMs: queue.cpuMs,
            longestItemMs: queue.longestItemMs,
            longestItemLabel: queue.longestItemLabel,
            over4msItems: queue.over4msItems,
            over16msItems: queue.over16msItems,
            over50msItems: queue.over50msItems,
            cancellations: queue.cancellations,
            flushes: queue.flushes,
            starvedFlushes: queue.starvedFlushes,
            grantedMs: queue.grantedMs,
        })),
    };
}

// Hot-path consumers that need only the already-computed motion class should
// not allocate the scheduler's complete queue diagnostics every frame.
export function getFrameChunkSequence() {
    return frameSequence;
}

export function getFrameChunkMotionState() {
    return observerMotion.motionState();
}

// Work policy includes a turning camera; translation/speed diagnostics above
// deliberately remain truthful (turning must not invent metres per second).
export function getFrameChunkWorkMotionState() {
    return adaptiveBudget.motionState;
}

// Called once per rendered frame. Legacy mode retains the old walker gate;
// adaptive mode converts the same samples into time-normalized speed classes.
export function noteFrameChunkObserver(x, z, {
    pauseWhileMoving = true,
    viewHeadingDeg = Number.NaN,
} = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    observerMovementGateEnabled = !!pauseWhileMoving;
    // Record motion whatever the gate says. Zeroing this when the gate was off
    // made the legacy path's answer to "is the observer moving" wrong rather than
    // merely unenforced, which is the same conflation the two exported predicates
    // below exist to undo.
    if (Number.isFinite(observerX) && Number.isFinite(observerZ)) {
        const dx = x - observerX;
        const dz = z - observerZ;
        if (dx * dx + dz * dz >= OBSERVER_MOVE_EPSILON_SQ) {
            observerLastMovedMs = nowMs();
        }
    }
    observerX = x;
    observerZ = z;
    const numericViewHeadingDeg = finiteOrNull(viewHeadingDeg);
    const normalizedViewHeadingDeg = numericViewHeadingDeg !== null
        ? ((numericViewHeadingDeg % 360) + 360) % 360
        : Number.NaN;
    if (Number.isFinite(normalizedViewHeadingDeg)) {
        if (Number.isFinite(observerViewHeadingDeg)) {
            const deltaDeg = ((normalizedViewHeadingDeg - observerViewHeadingDeg + 540) % 360) - 180;
            if (Math.abs(deltaDeg) >= OBSERVER_VIEW_MOVE_EPSILON_DEG) {
                observerLastViewMovedMs = nowMs();
            }
        }
        observerViewHeadingDeg = normalizedViewHeadingDeg;
    }
    observerMotion.note(x, z);
    lastObserverNoteMs = nowMs();
    resetAdaptiveFrame();
}

// Is the observer actually moving? A FACT about motion, with no policy in it.
//
// Callers that need the fact rather than the policy use this for telemetry and
// view-priority decisions. Tile eviction no longer gates on it: country-scale
// driving may never produce a stationary frame, so disposal is time-sliced
// continuously instead.
export function frameChunkObserverIsMoving() {
    if (schedulerMode() === 'adaptive') {
        return observerMotion.snapshot().state !== 'stationary';
    }
    return nowMs() - observerLastMovedMs < OBSERVER_SETTLE_MS;
}

// Cheap cooperative stages may safely catch up only after both translation
// and camera rotation have settled. Position alone is insufficient: a walker
// turning in place is still interacting with the world and must retain the
// active-frame visit cap.
export function frameChunkObserverIsSettled() {
    return !frameChunkObserverIsMoving()
        && nowMs() - observerLastViewMovedMs >= OBSERVER_SETTLE_MS;
}

function resolveItemLimit(limit) {
    const value = typeof limit === 'function' ? limit() : limit;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : Infinity;
}

function maxItemsForCurrentFrame(job) {
    if (frameChunkObserverIsSettled()) return resolveItemLimit(job.maxItemsPerSettledFrame);
    const maxItems = resolveItemLimit(job.maxItemsPerFrame);
    if (!job.scaleMaxItemsWithFrameTime || !Number.isFinite(maxItems)) {
        return maxItems;
    }
    // A count per frame is four times less throughput at 30 Hz than 120 Hz.
    // Scale only this explicit cheap-stage guard with elapsed display time;
    // the queue's millisecond deadline remains the hard CPU bound. Clamp the
    // scale so a suspended tab cannot return with an enormous one-frame burst.
    const previousFrameMs = observerMotion.snapshot().previousFrameMs;
    const cadenceScale = Math.max(1, Math.min(
        MAX_CADENCE_ITEM_CAP_SCALE,
        previousFrameMs / FAST_DISPLAY_FRAME_MS,
    ));
    return Math.max(1, Math.ceil(maxItems * cadenceScale));
}

// Should movement-first background construction hold off right now? The POLICY:
// moving AND this session asked for the gate. Walker mode does; a cab ride does
// not, because a cab is always moving and would otherwise never build anything.
//
// The two were one function, and that is what made "Limit movement-first
// streaming gate to walker mode" leak. Disabling the gate made the fact itself
// report "not moving", so a cab silently lost deferred eviction and the
// orientation-road hints along with the pause it meant to lift. Keeping the fact
// honest and the policy separate gives every caller the question it is asking.
export function frameChunkWorkShouldPauseForMovement() {
    if (schedulerThroughputOverride) return false;
    return observerMovementGateEnabled && frameChunkObserverIsMoving();
}

function interactiveQueueBudget(queue, classRemainingMs) {
    const restrictToCriticalPath = queue.workClass === 'near' && hasRunnableNearCriticalPath();
    if (restrictToCriticalPath && !queue.criticalPath) return 0;
    const nearSurfaceTier = queue.workClass === 'near' && queue.workTier === 'surface';
    let hasRunnableSurface = false;
    let hasRunnableOrdinary = false;
    if (queue.workClass === 'near') {
        for (const candidate of registeredQueues) {
            if (candidate.workClass !== 'near'
                || candidate.pendingJobs() <= 0
                || !candidate.hasRunnableJobs()) continue;
            if (restrictToCriticalPath && !candidate.criticalPath) continue;
            if (candidate.workTier === 'surface') hasRunnableSurface = true;
            else hasRunnableOrdinary = true;
        }
    }
    const splitNearBudget = hasRunnableSurface && hasRunnableOrdinary;
    const sameTier = candidate => (!restrictToCriticalPath || candidate.criticalPath)
        && (!splitNearBudget || (candidate.workTier === 'surface') === nearSurfaceTier);
    let runnable = 0, runnableWeight = 0, deferred = 0;
    for (const candidate of registeredQueues) {
        if (candidate.workClass !== queue.workClass
            || candidate.pendingJobs() <= 0
            || !sameTier(candidate)) continue;
        const ready = candidate.hasRunnableJobs();
        if (ready) { runnable++; runnableWeight += candidate.interactiveWeight(); }
        else if (candidate.lastProgressFrame < frameSequence) deferred++;
    }
    // Keep a small probe for dependencies that may have become ready since
    // their last visit. Reserving their full work slice strands the producer;
    // reserving nothing makes callback order postpone its next whole frame.
    const fullClassBudgetMs = adaptiveBudget.classBudgets[queue.workClass] || 0;
    const classBudgetMs = splitNearBudget
        ? fullClassBudgetMs * (nearSurfaceTier
            ? SURFACE_NEAR_RESERVATION_SHARE
            : 1 - SURFACE_NEAR_RESERVATION_SHARE)
        : fullClassBudgetMs;
    let tierChargedMs = 0;
    if (splitNearBudget) {
        for (const candidate of registeredQueues) {
            if (candidate.workClass !== queue.workClass || !sameTier(candidate)) continue;
            tierChargedMs += adaptiveChargedByQueue.get(candidate) || 0;
        }
    }
    const tierRemainingMs = Math.max(0, classBudgetMs - tierChargedMs);
    const probeMs = Math.min(DEPENDENCY_WAIT_PROBE_BUDGET_MS,
        classBudgetMs / Math.max(1, runnable + deferred));
    // Derive shares from the whole class allowance, then charge each queue's
    // actual work. Dividing the remainder again on every callback gave two
    // 6 ms queues 3 ms then 1.5 ms, stranding useful construction time.
    const sharePoolMs = Math.max(0, classBudgetMs - probeMs * deferred);
    let ownReservationMs = 0, otherReservationsMs = 0;
    for (const candidate of registeredQueues) {
        if (candidate.workClass !== queue.workClass
            || candidate.pendingJobs() <= 0
            || !sameTier(candidate)) continue;
        const ready = candidate.hasRunnableJobs();
        const weightedShareMs = sharePoolMs * candidate.interactiveWeight() / Math.max(1, runnableWeight);
        const reservationMs = ready ? Math.min(candidate.frameBudgetMs, weightedShareMs)
            : candidate.lastProgressFrame < frameSequence ? probeMs : 0;
        const remainingMs = Math.max(0, reservationMs - (adaptiveChargedByQueue.get(candidate) || 0));
        if (candidate === queue) ownReservationMs = remainingMs;
        else otherReservationsMs += remainingMs;
    }
    const availableMs = Math.min(classRemainingMs, tierRemainingMs);
    if (!queue.hasRunnableJobs()) return Math.min(availableMs, ownReservationMs);
    const ownLimitMs = Math.max(0, queue.frameBudgetMs - (adaptiveChargedByQueue.get(queue) || 0));
    return Math.min(ownLimitMs, availableMs,
        Math.max(ownReservationMs, availableMs - otherReservationsMs));
}

function hasPendingClass(workClass) {
    for (const queue of registeredQueues) {
        if (queue.workClass === workClass && queue.pendingJobs() > 0) return true;
    }
    return false;
}

function hasRunnableNearSurfaceTier() {
    for (const queue of registeredQueues) {
        if (queue.workClass === 'near'
            && queue.workTier === 'surface'
            && queue.pendingJobs() > 0
            && queue.hasRunnableJobs()) return true;
    }
    return false;
}

function hasRunnableNearCriticalPath() {
    for (const queue of registeredQueues) {
        if (queue.workClass === 'near'
            && queue.criticalPath
            && queue.pendingJobs() > 0
            && queue.hasRunnableJobs()) return true;
    }
    return false;
}

function stationaryQueueBudget(queue, classRemainingMs) {
    const ownChargedMs = adaptiveChargedByQueue.get(queue) || 0;
    const ownReservationMs = Math.max(0, queue.stationaryReservationMs() - ownChargedMs);
    let otherReservationsMs = 0;
    for (const candidate of registeredQueues) {
        if (candidate === queue
            || candidate.workClass !== queue.workClass
            || candidate.pendingJobs() <= 0) continue;
        otherReservationsMs += Math.max(
            0,
            candidate.stationaryReservationMs()
                - (adaptiveChargedByQueue.get(candidate) || 0),
        );
    }
    // Keep every pending sibling's configured slice intact, then let this
    // queue borrow any class budget whose owner is already idle. Detailed
    // buildings can therefore use the full near-world budget after roads and
    // curbs settle without changing their guarantees while they are active.
    const borrowableMs = Math.max(0, classRemainingMs - otherReservationsMs);
    return Math.min(
        classRemainingMs,
        Math.max(ownReservationMs, borrowableMs),
    );
}

function farNeedsProgressValve(queue) {
    return queue.workClass === 'far' && (
        hasPendingClass('delivery') || hasPendingClass('near')
        || !(adaptiveBudget.classBudgets.far > 0)
    );
}

// A real aggregate limit must not turn fixed browser callback order into
// starvation: after a first queue overruns, an unserved sibling gets first
// admission next frame. Reserve that turn only after an actual budget denial:
// merely being later in browser callback order must not make a runnable queue
// skip a frame whose budget is still unused. Within the frame, class shares
// still apply. Far's rare liveness turn is reserved BEFORE work, never appended to
// an already overdrawn frame. This changes admission, not job/feature priority.
function firstProgressQueue(atMs) {
    let oldest = null;
    const criticalPathRunnable = hasRunnableNearCriticalPath();
    const surfaceTierRunnable = hasRunnableNearSurfaceTier();
    for (const candidate of registeredQueues) {
        if (candidate.pendingJobs() <= 0) continue;
        if (criticalPathRunnable
            && candidate.workClass === 'near'
            && !candidate.criticalPath) continue;
        if (surfaceTierRunnable
            && candidate.workClass === 'near'
            && candidate.workTier !== 'surface') continue;
        if (farNeedsProgressValve(candidate)) {
            if (Number.isFinite(lastFarProgressMs)
                && atMs - lastFarProgressMs >= FAR_PROGRESS_INTERVAL_MS) return candidate;
            continue;
        }
        if (!(adaptiveBudget.classBudgets[candidate.workClass] > 0)) continue;
        if (!candidate.budgetBlocked || !candidate.hasRunnableJobs()) continue;
        if (!oldest || candidate.lastProgressFrame < oldest.lastProgressFrame
            || (candidate.lastProgressFrame === oldest.lastProgressFrame
                && FRAME_WORK_CLASSES.indexOf(candidate.workClass) < FRAME_WORK_CLASSES.indexOf(oldest.workClass))) {
            oldest = candidate;
        }
    }
    return oldest;
}

// How much of the previous frame's unused work budget far may borrow. Pure so
// the policy can be tested without a scheduler or a browser.
export function farBorrowableMs(chargedMs, budgetMs, {
    minHeadroomMs = FAR_BORROW_MIN_HEADROOM_MS,
    share = FAR_BORROW_SHARE,
} = {}) {
    const charged = Number(chargedMs);
    const budget = Number(budgetMs);
    if (!Number.isFinite(charged) || !Number.isFinite(budget) || budget <= 0) return 0;
    // charged === 0 does NOT mean "the frame was idle" — it also means "no frame
    // has run yet" (session start, or a synthetic test frame). Borrowing on that
    // would let far take the budget before the near world had ever asked for it,
    // which is the inversion this branch exists to prevent. Only a frame that
    // demonstrably did work AND still left slack can lend.
    if (charged <= 0) return 0;
    const unclaimed = budget - charged;
    if (!(unclaimed >= minHeadroomMs)) return 0;
    return unclaimed * share;
}

function adaptiveAllowance(queue, idleBudgetMs, atMs) {
    // Unit tests, pre-session JSON delivery, and teardown can run without the
    // cab's once-per-frame observer sample. Give those paths a bounded fallback
    // frame window instead of exhausting one lifetime budget forever.
    if (atMs - lastObserverNoteMs > 100 && atMs - lastAdaptiveResetMs >= 16) {
        resetAdaptiveFrame();
    }
    // Readiness can release inside a queue's completion callback. Recompute
    // its policy without resetting the CPU already spent in this frame.
    if (!schedulerThroughputOverride
        && (adaptiveBudget.phase === 'loading') !== isWorldBuilding()) {
        adaptiveBudget = currentAdaptiveBudget();
    }
    const totalRemainingMs = Math.max(0, adaptiveBudget.totalBudgetMs - adaptiveChargedTotalMs);
    const noWork = { budgetMs: 0, forceOneItem: false };
    // Start the far starvation clock even if another queue exhausted this
    // frame. The later valve reserves a fresh frame; it cannot bypass this cap.
    if (farNeedsProgressValve(queue) && !Number.isFinite(lastFarProgressMs)) {
        lastFarProgressMs = atMs;
    }
    // Only a queue with runnable work is starved by a refusal. A queue whose
    // jobs all wait on a dependency wanted a probe; marking it blocked handed it
    // first admission next frame, which refused the runnable sibling instead:
    // a ground generation lost 47% of its frames to the buildings queue's probes
    // after a 900 m move (Split, 2026-09-17), doubling its wall time.
    const starvable = queue.hasRunnableJobs();
    if (totalRemainingMs < 0.05) {
        if (starvable && queue.lastProgressFrame < frameSequence) queue.budgetBlocked = true;
        return noWork;
    }
    if (adaptiveChargedTotalMs === 0) {
        const first = firstProgressQueue(atMs);
        if (first && first !== queue) return noWork;
    }
    // Throughput mode has no near world to protect: far drains alongside it.
    const farHasPriorityContention = queue.workClass === 'far'
        && adaptiveBudget.phase !== 'throughput'
        && (hasPendingClass('delivery') || hasPendingClass('near'));
    const farHasNormalBudget = (adaptiveBudget.classBudgets.far || 0) > 0;
    if (queue.workClass === 'far'
        && (farHasPriorityContention || !farHasNormalBudget)) {
        // Yield to the near world, but never completely — see
        // FAR_PROGRESS_INTERVAL_MS. Moving policies also give far a deliberate
        // zero class budget; apply the same liveness valve when far is the only
        // backlog, or a continuous cruise through an already-built near world
        // can strand the skyline forever. A zero deadline plus forceOneItem is
        // exactly one item, so progress stays bounded to one item per interval.
        if (farHasPriorityContention) {
            const headroomMs = farBorrowableMs(lastFrameChargedTotalMs, lastFrameBudgetTotalMs);
            if (headroomMs > 0) {
                return {
                    budgetMs: Math.min(queue.frameBudgetMs, headroomMs, totalRemainingMs, idleBudgetMs),
                    forceOneItem: false,
                };
            }
        }
        if (atMs - lastFarProgressMs >= FAR_PROGRESS_INTERVAL_MS) {
            return { budgetMs: 0, forceOneItem: true };
        }
        return { budgetMs: 0, forceOneItem: false };
    }
    const classBudgetMs = adaptiveBudget.classBudgets[queue.workClass] || 0;
    const classChargedMs = adaptiveChargedByClass.get(queue.workClass) || 0;
    const classRemainingMs = Math.max(0, classBudgetMs - classChargedMs);
    if (starvable && classBudgetMs > 0 && classRemainingMs < 0.05
        && queue.lastProgressFrame < frameSequence) queue.budgetBlocked = true;
    // Legacy-sized reservations belong to the loading curtain only. All
    // interactive states share the class allowance, including ordinary stops.
    const queueBudgetMs = adaptiveBudget.phase === 'throughput'
        // No per-queue slice either: whichever queue asks takes the class.
        ? classRemainingMs
        : adaptiveBudget.phase === 'loading'
            ? stationaryQueueBudget(queue, classRemainingMs)
            : interactiveQueueBudget(queue, classRemainingMs);
    return {
        budgetMs: Math.min(
            Math.max(0, idleBudgetMs),
            totalRemainingMs,
            queueBudgetMs,
        ),
        forceOneItem: false,
    };
}

function recordAdaptiveWork(queue, elapsedMs, items) {
    const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
    // An indivisible item may overrun; no scheduler can preempt JavaScript.
    // Count that cost in full so siblings do not compound the same hitch.
    const chargedMs = safeElapsedMs;
    if (items > 0) {
        queue.lastProgressFrame = frameSequence;
        queue.budgetBlocked = false;
    }
    adaptiveSpentTotalMs += safeElapsedMs;
    adaptiveSpentByClass.set(
        queue.workClass,
        (adaptiveSpentByClass.get(queue.workClass) || 0) + safeElapsedMs,
    );
    lifetimeSpentTotalMs += safeElapsedMs;
    lifetimeSpentByClass.set(
        queue.workClass,
        (lifetimeSpentByClass.get(queue.workClass) || 0) + safeElapsedMs,
    );
    adaptiveChargedTotalMs += chargedMs;
    adaptiveChargedByClass.set(
        queue.workClass,
        (adaptiveChargedByClass.get(queue.workClass) || 0) + chargedMs,
    );
    adaptiveChargedByQueue.set(
        queue,
        (adaptiveChargedByQueue.get(queue) || 0) + chargedMs,
    );
    // Only stamp when far actually got an item through, so the interval measures
    // time since real progress rather than time since it was last considered.
    if (queue.workClass === 'far' && items > 0) {
        lastFarProgressMs = nowMs();
    }
}


// A job may name its own items. Guarded because a describeItem that throws
// must not take down the build it was only supposed to describe — a diagnostic
// that can break the thing it measures is worse than no diagnostic.
function describeQueueItem(job, item, index) {
    if (typeof job?.describeItem !== 'function') return '';
    try {
        const label = job.describeItem(item, index);
        return typeof label === 'string' ? label : '';
    } catch {
        return '';
    }
}

export function createFrameChunkQueue({
    label = 'work',
    frameBudgetMs = 4,
    pauseDuringMovement = true,
    preferAnimationFrame = false,
    trackWorldReady = true,
    reportWorldProgress = false,
    workClass = 'near',
    workTier = 'default',
    workWeight = 1,
    criticalPath = false,
    activityDetails = null,
    stationaryReservationMs = null,
} = {}) {
    let jobs = [];
    let scheduleId = 0;
    let scheduleKind = '';
    let nextSequence = 0;
    const safeWorkClass = FRAME_WORK_CLASSES.includes(workClass) ? workClass : 'near';
    const resolveWorkWeight = () => {
        const raw = typeof workWeight === 'function' ? Number(workWeight()) : Number(workWeight);
        return Number.isFinite(raw) && raw > 0 ? raw : 1;
    };
    // frameBudgetMs may be a FUNCTION, so a queue can change its own allowance
    // over a session. The far-building ring uses this to take a real slice while
    // it builds its first horizon and then fall back to a trickle: a coarse
    // context layer is worth having early, but not worth stealing frames from
    // the buildings you are walking past forever after.
    const resolveFrameBudgetMs = () => {
        const raw = typeof frameBudgetMs === 'function' ? Number(frameBudgetMs()) : Number(frameBudgetMs);
        return Math.max(0.05, Number.isFinite(raw) && raw > 0 ? raw : 4);
    };
    const queueState = {
        label,
        workClass: safeWorkClass,
        workTier: workTier === 'surface' ? 'surface' : 'default',
        criticalPath: criticalPath === true,
        interactiveWeight: resolveWorkWeight,
        lastProgressFrame: -Infinity,
        budgetBlocked: false,
        // A getter, so every existing `queue.frameBudgetMs` read still gets a
        // plain number and re-reads it each frame.
        get frameBudgetMs() { return resolveFrameBudgetMs(); },
        stationaryReservationMs: () => {
            const configured = typeof stationaryReservationMs === 'function'
                ? Number(stationaryReservationMs())
                : Number(stationaryReservationMs);
            return Math.max(
                resolveFrameBudgetMs(),
                Number.isFinite(configured) ? configured : 0,
            );
        },
        pendingItems: () => jobs.reduce(
            (total, job) => total + Math.max(0, job.items.length - job.index),
            0,
        ),
        pendingJobs: () => jobs.filter(job => job && !job.cancelled).length,
        // Only explicit dependency waits release the normal work share. DEFER
        // also serves GPU/frame pacing and remains runnable on the next frame.
        // New jobs and a WAIT-to-REPEAT transition restore the share. Every probe/resumption
        // remains charged against the same aggregate and class deadlines.
        hasRunnableJobs: () => jobs.some(job => job && !job.cancelled
            && job.index < job.items.length && !job.waitingForDependency),
        // Jobs whose CURRENT item is dependency-deferred, with the retry count.
        // A wedged pipeline (every job deferring, ~0 ms spent, backlog frozen)
        // is diagnosable only by naming these items — aggregates cannot see it.
        deferSummaries: () => jobs
            .filter(job => job && !job.cancelled
                && (job.deferCount || 0) > 0
                && job.index < job.items.length)
            .map(job => ({
                label: job.lastDeferLabel || '',
                count: job.deferCount || 0,
            })),
        processedItems: 0,
        cpuMs: 0,
        longestItemMs: 0,
        // WHICH item was the longest, when the job can say. "curbs 98ms" names
        // the queue but not the work: a queue whose stages do completely
        // different jobs (prepare masks / one road feature / one parking ring)
        // reports one number for all three, and the fat-item line then points at
        // a whole layer rather than at the thing to fix.
        longestItemLabel: '',
        over4msItems: 0,
        over16msItems: 0,
        over50msItems: 0,
        cancellations: 0,
        // Admission, not work: how often this queue asked for a turn, how
        // often it was refused one (no allowance while it had jobs), and how
        // much allowance it was granted in total. A queue that is granted
        // little but spends nothing is deferring; one refused every frame is
        // starved by its class share — the two look identical in cpuMs.
        flushes: 0,
        starvedFlushes: 0,
        grantedMs: 0,
        resetStatistics() {
            this.flushes = 0;
            this.starvedFlushes = 0;
            this.grantedMs = 0;
            this.processedItems = 0;
            this.cpuMs = 0;
            this.longestItemMs = 0;
            this.longestItemLabel = '';
            this.over4msItems = 0;
            this.over16msItems = 0;
            this.over50msItems = 0;
            this.cancellations = 0;
        },
    };
    registeredQueues.add(queueState);
    const unregisterActivity = registerBackgroundActivityReader(() => {
        const details = typeof activityDetails === 'function' ? activityDetails() : null;
        // Name the worst dependency-deferred item once it has clearly stopped
        // progressing (~10 s of frame retries; healthy loads have been seen
        // deferring ×228 transiently, so the bar sits above that). A wedged
        // pipeline spends ~0 ms, so the overlay text people copy must carry
        // the item's name — timing stats cannot show it.
        let stalledLabel = '';
        let stalledCount = 0;
        for (const job of jobs) {
            if (!job || job.cancelled) continue;
            const count = job.deferCount || 0;
            if (count > stalledCount) {
                stalledCount = count;
                stalledLabel = job.lastDeferLabel || '';
            }
        }
        return {
            kind: 'build',
            label,
            pending: queueState.pendingItems(),
            jobs: queueState.pendingJobs(),
            ...(stalledCount >= 900
                ? { stalled: `${stalledLabel} ×${stalledCount}` }
                : {}),
            ...(details && typeof details === 'object' ? details : {}),
        };
    });

    function sortJobs(deferredJobs = null) {
        jobs.sort((a, b) => {
            const aDeferred = deferredJobs?.has(a) ? 1 : 0;
            const bDeferred = deferredJobs?.has(b) ? 1 : 0;
            if (aDeferred !== bDeferred) return aDeferred - bDeferred;
            const aPriority = typeof a.priority === 'function' ? a.priority() : a.priority;
            const bPriority = typeof b.priority === 'function' ? b.priority() : b.priority;
            if (bPriority !== aPriority) return bPriority - aPriority;
            return a.sequence - b.sequence;
        });
    }

    function selectHighestPriorityItem(job) {
        if (!job
            || job.repeatingItem
            || typeof job.itemPriority !== 'function'
            || job.index >= job.items.length - 1) return;
        let bestIndex = job.index;
        let bestPriority = Number(job.itemPriority(job.items[bestIndex], bestIndex)) || 0;
        for (let index = job.index + 1; index < job.items.length; index++) {
            const priority = Number(job.itemPriority(job.items[index], index)) || 0;
            if (priority > bestPriority) {
                bestPriority = priority;
                bestIndex = index;
            }
        }
        if (bestIndex === job.index) return;
        const current = job.items[job.index];
        job.items[job.index] = job.items[bestIndex];
        job.items[bestIndex] = current;
    }

    function schedule() {
        if (scheduleId || jobs.length === 0) return;
        if (!preferAnimationFrame && typeof requestIdleCallback === 'function') {
            scheduleKind = 'idle';
            // A continuously animated scene whose base render exceeds one
            // refresh interval may never receive ordinary idle time. Permit a
            // tiny time-bounded catch-up slice four times a second, without
            // competing with normal frames whenever genuine idle time exists.
            scheduleId = requestIdleCallback(flush, { timeout: IDLE_CATCH_UP_TIMEOUT_MS });
            return;
        }
        scheduleKind = 'frame';
        if (typeof requestAnimationFrame === 'function') {
            scheduleId = requestAnimationFrame(() => flush(null));
        } else {
            scheduleKind = 'timer';
            scheduleId = setTimeout(() => flush(null), 0);
        }
    }

    function finishJob(job, cancelled = false) {
        if (!job) return;
        job.cancelled = true;
        const callback = cancelled ? job.onCancel : job.onComplete;
        if (typeof callback === 'function') {
            try {
                callback();
            } catch (err) {
                console.error(`[FrameChunkQueue:${label}] job callback failed:`, err);
                if (!cancelled && typeof job.onError === 'function') {
                    try {
                        job.onError(err, null, job.index);
                    } catch (callbackError) {
                        console.error(
                            `[FrameChunkQueue:${label}] error callback failed:`,
                            callbackError,
                        );
                    }
                }
                job.reject(err);
                return;
            }
        }
        job.resolve({ cancelled });
    }

    function failJob(job, error, item, itemIndex) {
        if (!job || job.cancelled) return;
        job.cancelled = true;
        if (typeof job.onError === 'function') {
            try {
                job.onError(error, item, itemIndex);
            } catch (callbackError) {
                console.error(`[FrameChunkQueue:${label}] error callback failed:`, callbackError);
            }
        }
        console.error(`[FrameChunkQueue:${label}] item failed:`, error);
        job.reject(error);
    }

    function flush(idleDeadline) {
        scheduleId = 0;
        scheduleKind = '';
        sortJobs();
        const flushStart = nowMs();
        const forcedCatchUp = !!idleDeadline?.didTimeout;
        const adaptive = schedulerMode() === 'adaptive';
        const idleBudgetMs = forcedCatchUp
            ? IDLE_CATCH_UP_BUDGET_MS
            : idleDeadline && typeof idleDeadline.timeRemaining === 'function'
                ? Math.max(0, idleDeadline.timeRemaining() - 1)
                // Adaptive animation-frame work is bounded by the shared
                // class/total allowance below. Starting from the queue's base
                // reservation here would prevent it from borrowing an idle
                // sibling's unused stationary budget.
                : adaptive ? Infinity : resolveFrameBudgetMs();
        const allowance = adaptive
            ? adaptiveAllowance(queueState, idleBudgetMs, flushStart)
            : {
                budgetMs: Math.min(queueState.frameBudgetMs, idleBudgetMs),
                forceOneItem: forcedCatchUp,
            };
        const deadline = flushStart + allowance.budgetMs;
        let itemsThisFlush = 0;
        const deferredJobs = new Set();
        queueState.flushes += 1;
        if (!adaptive && pauseDuringMovement && frameChunkWorkShouldPauseForMovement()) {
            schedule();
            return;
        }
        if ((!adaptive && idleBudgetMs < 1)
            || (adaptive && allowance.budgetMs < 0.05 && !allowance.forceOneItem)) {
            queueState.starvedFlushes += 1;
            schedule();
            return;
        }
        queueState.grantedMs += Number.isFinite(allowance.budgetMs) ? allowance.budgetMs : 0;
        while (jobs.length > 0) {
            const job = jobs[0];
            if (!job || job.cancelled) {
                jobs.shift();
                continue;
            }
            let processedThisFrame = 0;
            const maxItemsThisFrame = maxItemsForCurrentFrame(job);
            let hitFrameCap = false;
            let deferredItem = false;
            let reorderAfterItem = false;
            while (job.index < job.items.length) {
                if (nowMs() >= deadline
                    && !(allowance.forceOneItem && itemsThisFlush === 0)) break;
                // Re-evaluate only between semantic items. A cooperative item
                // that already staged part of one building remains pinned
                // until it publishes or defers on a dependency.
                selectHighestPriorityItem(job);
                const item = job.items[job.index];
                const itemStartMs = nowMs();
                let itemResult;
                try {
                    itemResult = job.onItem(item, job.index);
                } catch (err) {
                    jobs.shift();
                    failJob(job, err, item, job.index);
                    break;
                }
                const completedItem = itemResult !== FRAME_CHUNK_REPEAT_ITEM
                    && itemResult !== FRAME_CHUNK_DEFER_ITEM
                    && itemResult !== FRAME_CHUNK_WAIT_ITEM;
                job.waitingForDependency = itemResult === FRAME_CHUNK_WAIT_ITEM;
                if (completedItem) {
                    job.index += 1;
                    job.repeatingItem = false;
                    job.deferCount = 0;
                } else {
                    job.repeatingItem = itemResult === FRAME_CHUNK_REPEAT_ITEM;
                    if (job.repeatingItem) job.deferCount = 0;
                }
                processedThisFrame += 1;
                itemsThisFlush += 1;
                const itemMs = Math.max(0, nowMs() - itemStartMs);
                queueState.processedItems += 1;
                queueState.cpuMs += itemMs;
                if (itemMs > queueState.longestItemMs) {
                    queueState.longestItemMs = itemMs;
                    queueState.longestItemLabel = describeQueueItem(job, item, job.index);
                }
                if (itemMs > 4) queueState.over4msItems += 1;
                if (itemMs > 16) queueState.over16msItems += 1;
                if (itemMs > 50) queueState.over50msItems += 1;
                if (job.index >= job.items.length) break;
                if (itemResult === FRAME_CHUNK_DEFER_ITEM || itemResult === FRAME_CHUNK_WAIT_ITEM) {
                    // A dependency-bound item that never completes is invisible
                    // in aggregate stats (it costs ~0 ms), so name it: the
                    // streaming report surfaces which item is stuck and how
                    // long it has been retrying.
                    job.deferCount = (job.deferCount || 0) + 1;
                    job.lastDeferLabel = describeQueueItem(job, item, job.index);
                    deferredItem = true;
                    break;
                }
                if (processedThisFrame >= maxItemsThisFrame) {
                    hitFrameCap = true;
                    break;
                }
                if (completedItem && job.reorderBetweenItems) {
                    reorderAfterItem = true;
                    break;
                }
            }
            if (job.cancelled) continue;
            if (job.index >= job.items.length) {
                jobs.shift();
                finishJob(job, false);
                continue;
            }
            if (deferredItem) {
                // A dependency-bound item (for example a duplicate building
                // waiting for the task that owns its object-id reservation)
                // must not spin for the rest of this slice or starve its owner,
                // even when the waiter currently has higher spatial priority.
                job.sequence = nextSequence++;
                deferredJobs.add(job);
                sortJobs(deferredJobs);
                const runnableJobs = jobs.filter(candidate => (
                    candidate && !candidate.cancelled && !deferredJobs.has(candidate)
                ));
                if (runnableJobs.length === 0) break;
                continue;
            }
            if (reorderAfterItem) {
                // The completed item may have changed this job's dynamic
                // priority. Reinsert it immediately so the best remaining
                // item across every job owns the rest of the same time slice.
                job.sequence = nextSequence++;
                sortJobs(deferredJobs);
                continue;
            }
            // Jobs at the same spatial priority must take turns. Without this
            // rotation, the first tile monopolizes every later flush until all
            // of its features are built, even when another tile touches the
            // observer and contains a closer next feature.
            if (processedThisFrame > 0) job.sequence = nextSequence++;
            if (hitFrameCap) break;
            if (nowMs() >= deadline) break;
        }
        const elapsedMs = Math.max(0, nowMs() - flushStart);
        if (adaptive) {
            recordAdaptiveWork(
                queueState,
                elapsedMs,
                itemsThisFlush,
            );
        }
        // This flush ran in the queue's OWN animation frame or idle callback, so
        // none of it is inside the render loop's hooks. Unreported, it showed as
        // `outside-loop` — the queue's whole cost, attributed to nobody.
        reportOutOfLoopWork(`q:${label}`, elapsedMs);
        if (startupTrace.enabled) startupTrace.queueFlush(label, itemsThisFlush, elapsedMs);
        // Some near-field queues have a narrower manual readiness gate (the
        // four tiles touching the spawn) while their worker keeps processing a
        // larger streaming ring. Those queues cannot use trackWorldReady, but
        // successfully advancing their gated work is still honest progress for
        // the loading hold's stall detector.
        if (reportWorldProgress && itemsThisFlush > 0) noteWorldBuildProgress();
        if (trackWorldReady && itemsThisFlush > 0) noteWorldQueueActive(label);
        if (jobs.length > 0) {
            schedule();
        } else {
            if (trackWorldReady) noteWorldQueueIdle(label);
            if (startupTrace.enabled) startupTrace.queueIdle(label);
        }
    }

    function enqueue(items, onItem, {
        onComplete = null,
        onCancel = null,
        onError = null,
        maxItemsPerFrame = Infinity,
        maxItemsPerSettledFrame = maxItemsPerFrame,
        scaleMaxItemsWithFrameTime = false,
        priority = 0,
        itemPriority = null,
        reorderBetweenItems = false,
        // Optional: name this job's items so the fat-item report can say WHICH
        // stage was slow, not merely which queue it belonged to.
        describeItem = null,
    } = {}) {
        const safeItems = Array.isArray(items) ? items : [];
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        // Queue users that do not need acknowledgement still get loud console
        // errors without producing an unhandled-rejection side channel.
        promise.catch(() => {});
        const job = {
            items: safeItems,
            onItem: typeof onItem === 'function' ? onItem : () => {},
            describeItem,
            onComplete,
            onCancel,
            onError,
            maxItemsPerFrame,
            maxItemsPerSettledFrame,
            scaleMaxItemsWithFrameTime: !!scaleMaxItemsWithFrameTime,
            priority: typeof priority === 'function'
                ? priority
                : Number.isFinite(priority) ? priority : 0,
            itemPriority: typeof itemPriority === 'function' ? itemPriority : null,
            reorderBetweenItems: !!reorderBetweenItems,
            sequence: nextSequence++,
            index: 0,
            repeatingItem: false,
            cancelled: false,
            promise,
            resolve,
            reject,
        };
        if (safeItems.length === 0) {
            finishJob(job, false);
            return job;
        }
        jobs.push(job);
        sortJobs();
        schedule();
        return job;
    }

    function cancel(job) {
        if (!job || job.cancelled) return;
        job.cancelled = true;
        jobs = jobs.filter((candidate) => candidate !== job);
        queueState.cancellations += 1;
        finishJob(job, true);
    }

    function clear() {
        const pending = jobs;
        jobs = [];
        if (scheduleId) {
            if (scheduleKind === 'idle' && typeof cancelIdleCallback === 'function') {
                cancelIdleCallback(scheduleId);
            } else if (scheduleKind === 'timer') {
                clearTimeout(scheduleId);
            } else {
                cancelAnimationFrame(scheduleId);
            }
            scheduleId = 0;
            scheduleKind = '';
        }
        for (const job of pending) {
            if (!job || job.cancelled) continue;
            finishJob(job, true);
        }
    }

    function dispose() {
        clear();
        unregisterActivity();
        registeredQueues.delete(queueState);
    }

    return {
        enqueue,
        cancel,
        clear,
        dispose,
    };
}

if (typeof window !== 'undefined') {
    window.__s3dStreamingReport = () => ({
        scheduler: getFrameChunkSchedulerSnapshot(),
        startup: startupTrace.snapshot(),
    });
}
