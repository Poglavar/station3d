// Shared per-session tile fetchers for Station3D. Multiple layers can
// subscribe to the same endpoint/ring so we fetch each tile once, replay
// already-loaded tiles to late subscribers, and evict consistently.

import {
    CAB_RING,
    TILE_M,
    tileBbox,
    tileDistanceSqToPoint,
    tileIndex,
} from './tile-stream.js';
import {
    createFrameChunkQueue,
    FRAME_CHUNK_REPEAT_ITEM,
    FRAME_CHUNK_DEFER_ITEM,
} from './frame-chunk-queue.js';
import { registerBackgroundActivityReader } from './background-activity.js';
import { finiteOrNull } from './math.js';
import { auditSourceCoverage } from './surface-audit-readiness.js';
import { startupTrace } from './startup-trace.js';
import {
    classifyViewPriority,
    tileLocalBounds,
    VIEW_PRIORITY_TIERS,
} from './view-priority.js';
import { initialWorldSupportTileKeys } from './initial-world-support.js';
import { isWorldBuilding, noteWorldBuildProgress } from './world-ready.js';
import {
    createNetworkRequestScheduler,
    NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT,
} from './network-request-scheduler.js';

// A tile whose fetch failed used to be quietly forgotten: the key was deleted
// and nothing ever asked for it again. ensureAround() only does work when the
// camera crosses a tile boundary, so if the API died while you stood still — or
// you simply walked around inside one source tile — the hole never healed, not
// even after the API came back. Failed tiles are now retried on their own
// schedule, backing off so a flapping API is not hammered by every layer at
// once, and the world repairs itself without leaving the session.
const RETRY_BASE_MS = 900;
const RETRY_MAX_MS = 20000;
export const TILE_REQUEST_TIMEOUT_MS = 12000;
// A camera turn is not forward travel. Repointing the 1.4 km prefetch
// corridor every 10 degrees made a stationary 360-degree look fetch, build,
// evict, then refetch most of the surrounding city. Keep the current corridor
// while heading buckets are changing and adopt the new direction once it has
// remained stable briefly. Crossing into another source tile still refreshes
// immediately so a moving vehicle never outruns the stream.
const AHEAD_HEADING_SETTLE_MS = 300;
// Consecutive failures before a source is called degraded — enough to ride out
// a blip, few enough that a real outage is announced rather than rendered as an
// empty city.
const DEGRADED_AFTER_FAILURES = 3;
const INITIAL_WORLD_SUPPORT_TILE_KEYS = initialWorldSupportTileKeys();
// Must match the tier stride used by the shared request scheduler and view
// scorer. Source startup priority is expressed in whole visibility tiers.
const SOURCE_STARTUP_PRIORITY_STRIDE = 1e12;

// How long ALL sources together may spend tearing down stale tiles in one frame.
//
// Shared, not per-source, and that distinction is the whole point. A per-source
// slice looked bounded and was not: roads-surface, roads-centreline, curbs,
// buildings, far-buildings and the rest all evict in the same frame, so N
// sources x 2 ms landed as 50 ms frames — one 620 ms hitch traded for a burst of
// twenty 50 ms ones. One budget, refilled per frame window, is an actual bound.
const EVICT_SLICE_MS = 2;
const EVICT_WINDOW_MS = 16;   // ~one frame
let evictWindowStartMs = -Infinity;
let evictSpentMs = 0;

const evictNowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Remaining eviction time in the current frame window, opening a new window when
// the last one has expired.
function evictBudgetRemainingMs(now) {
    if (now - evictWindowStartMs >= EVICT_WINDOW_MS) {
        evictWindowStartMs = now;
        evictSpentMs = 0;
    }
    return Math.max(0, EVICT_SLICE_MS - evictSpentMs);
}

// Tests share module state; without this the first test's spend leaks into the
// next one and the suite goes flaky in a way that looks like a real regression.
export function __resetEvictionBudgetForTests() {
    evictWindowStartMs = -Infinity;
    evictSpentMs = 0;
}

function retryDelayMs(attempts, baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS) {
    const backoff = Math.min(maxMs, baseMs * 2 ** (attempts - 1));
    // Every layer fails in the same instant when the API goes down; they must
    // not all come back in the same millisecond either.
    return backoff * (0.7 + Math.random() * 0.6);
}

const healthListeners = new Set();
const degradedSources = new Map();

function degradedSourceLabels() {
    return [...new Set(degradedSources.values())];
}

// Fires whenever the set of degraded sources changes: (labels[]) => void.
export function onTileStreamHealth(listener) {
    healthListeners.add(listener);
    listener(degradedSourceLabels());
    return () => healthListeners.delete(listener);
}

function setSourceDegraded(sourceToken, label, degraded) {
    if (degraded === degradedSources.has(sourceToken)) return;
    if (degraded) degradedSources.set(sourceToken, label);
    else degradedSources.delete(sourceToken);
    const labels = degradedSourceLabels();
    for (const listener of healthListeners) {
        try {
            listener(labels);
        } catch (err) {
            console.warn('[SharedTileSession] health listener failed:', err);
        }
    }
}

export function getTileRingOffsets(ring) {
    const offsets = [];
    for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
            offsets.push({ dx, dz });
        }
    }
    offsets.sort((a, b) => {
        const aChebyshev = Math.max(Math.abs(a.dx), Math.abs(a.dz));
        const bChebyshev = Math.max(Math.abs(b.dx), Math.abs(b.dz));
        if (aChebyshev !== bChebyshev) return aChebyshev - bChebyshev;
        const aDistSq = a.dx * a.dx + a.dz * a.dz;
        const bDistSq = b.dx * b.dx + b.dz * b.dz;
        if (aDistSq !== bDistSq) return aDistSq - bDistSq;
        const aAxis = Math.abs(a.dx) + Math.abs(a.dz);
        const bAxis = Math.abs(b.dx) + Math.abs(b.dz);
        if (aAxis !== bAxis) return aAxis - bAxis;
        if (Math.abs(a.dz) !== Math.abs(b.dz)) return Math.abs(a.dz) - Math.abs(b.dz);
        if (Math.abs(a.dx) !== Math.abs(b.dx)) return Math.abs(a.dx) - Math.abs(b.dx);
        if (a.dz !== b.dz) return a.dz - b.dz;
        return a.dx - b.dx;
    });
    return offsets;
}

function notifySubscriber(subscriber, method, ...args) {
    const fn = subscriber && subscriber[method];
    if (typeof fn !== 'function') return;
    try {
        return fn(...args);
    } catch (err) {
        if (method === 'onFetch') throw err;
        console.warn(`[SharedTileSession] subscriber ${method} failed:`, err);
    }
}

function requestTimeoutError(url, timeoutMs) {
    const error = new Error(`Request timed out after ${timeoutMs} ms: ${url}`);
    error.name = 'TimeoutError';
    return error;
}


// Should a tile that has left the view corridor still be kept?
//
// Retention beyond keepRing is corridor-shaped, so turning on the spot sweeps
// tiles out of it. Without a grace period they are torn down immediately and
// rebuilt the instant you turn back — paying twice for geometry that was
// already built, which is the worst case for standing still and looking round.
//
// Bounded on purpose: detailed buildings are the heaviest streamed payload, so
// the grace is BOTH time-limited and capped by count. Past the cap no tile gets
// grace at all, which drains the backlog rather than letting a full 360 degree
// sweep pin every tile in the annulus.
export function withinAheadGrace(leftAtMs, nowMs, { graceMs, heldCount, maxHeld } = {}) {
    if (!Number.isFinite(leftAtMs)) return false;      // never in the corridor
    if (Number.isFinite(maxHeld) && heldCount > maxHeld) return false;
    const limit = Number(graceMs);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return (nowMs - leftAtMs) < limit;
}

class SharedTileSource {
    constructor({ anchorLat, anchorLon, fetchController, label, url, parseFeatures,
                  validatePayload, requestJson, deferWork, allowDuringMovement = false,
                  decodeBody = null, createTextDecodeTask = null, loadPayload = null,
                  retryBaseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS,
                  tileM = TILE_M, ring = CAB_RING, keepRing,
                  maxConcurrentRequests = Infinity, prioritizeByView = false,
                  startupPendingTileLimit = 32, startupPriority = 0,
                  requestScheduler }) {
        this.anchorLat = anchorLat;
        this.anchorLon = anchorLon;
        this.fetchController = fetchController;
        this.label = label || 'tile';
        this.healthToken = Symbol(this.label);
        this.url = url;
        this.requestJson = requestJson;
        // Optional precompiled/cache source adapter. It runs inside this source's
        // normal network slot and keeps the same cancellation/delivery lifecycle.
        this.loadPayload = loadPayload;
        this.requestScheduler = requestScheduler;
        // Optional ArrayBuffer -> payload decoder. A source that sets this is
        // fetched as bytes and decoded instead of parsed as JSON — see
        // core/road-tile-binary.js for why road tiles do.
        this.decodeBody = typeof decodeBody === 'function' ? decodeBody : null;
        // Optional string -> resumable task factory. Unlike decodeBody, this
        // keeps the ordinary JSON response contract while spreading the parse
        // over bounded animation-frame slices.
        this.createTextDecodeTask = typeof createTextDecodeTask === 'function'
            ? createTextDecodeTask
            : null;
        this.deferWork = deferWork;
        this.allowDuringMovement = !!allowDuringMovement;
        this.parseFeatures = parseFeatures || ((data) => data.features);
        this.validatePayload = validatePayload || (
            parseFeatures
                ? null
                : (data) => Array.isArray(data?.features)
        );
        this.retryBaseMs = retryBaseMs;
        this.retryMaxMs = retryMaxMs;
        // Per-source grid: a coarser tileM/ring lets the far LOD1 building layer
        // stream big tiles without disturbing the default 200 m ring every other
        // layer uses. keepRing (eviction radius) defaults to one ring beyond the
        // fetch ring, matching the original module-level KEEP_RING = CAB_RING + 1.
        this.tileM = tileM;
        this.ringOffsets = getTileRingOffsets(ring);
        this.keepRing = keepRing != null ? keepRing : ring + 1;
        // 15 s comfortably covers a look-round and a look-back; 64 tiles caps
        // what a full sweep can pin (at the detailed layer's 100 m grid that is
        // ~0.64 km2 of extra retained geometry).
        this.aheadGraceMs = 15000;
        this.aheadGraceMaxTiles = 64;
        this.maxConcurrentRequests = Number.isFinite(maxConcurrentRequests)
            ? Math.max(1, Math.floor(maxConcurrentRequests))
            : Infinity;
        this.prioritizeByView = !!prioritizeByView;
        // Bound downloaded-but-unconsumed payloads independently of socket
        // capacity. A ground source hold must not occupy every network slot
        // while the consumer prepares its next visible generation.
        this.pendingTileCount = 0;
        this.maxPendingTiles = Number.isFinite(this.maxConcurrentRequests)
            ? this.maxConcurrentRequests : NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT;
        const configuredStartupPendingTileLimit = finiteOrNull(startupPendingTileLimit);
        this.startupPendingTileLimit = Math.max(
            this.maxPendingTiles,
            configuredStartupPendingTileLimit !== null
                ? Math.floor(configuredStartupPendingTileLimit)
                : 32,
        );
        this.startupPriority = finiteOrNull(startupPriority) ?? 0;
        this.activeRequestCount = 0;
        this.nextFetchSequence = 0;
        this.focusX = 0;
        this.focusZ = 0;
        this.supportX = 0;
        this.supportZ = 0;
        this.hasSupportFocus = false;
        this.viewHeadingDeg = Number.NaN;
        this.viewFovDeg = 90;
        this.lastPrioritySignature = null;
        // A fetched payload is retained while individual subscribers build it.
        // Successful consumers are never replayed just because a sibling
        // consumer failed; only failed deliveries retry.
        this.tiles = new Map();      // tileKey -> { status, features, deliveries }
        this.failed = new Map();     // tileKey -> { attempts, nextTryAt, stage, error }
        this.nextRetryAt = Infinity;
        // Health means network/data-source reachability, not whether a browser
        // subscriber managed to turn a valid payload into GPU geometry.
        this.consecutiveFetchFailures = 0;
        this.subscribers = new Set();
        this.lastTx = null;
        this.lastTz = null;
        this.aheadTileKeys = new Set();
        // Authored gameplay corridors are loaded once behind a chapter curtain
        // and retained until the session ends. They are deliberately separate
        // from the moving ahead corridor, which changes whenever the car turns.
        this.pinnedTileKeys = new Set();
        this.lastPinnedSignature = null;
        // tileKey -> ms when it left the corridor (grace before eviction)
        this.aheadLeftAtMs = new Map();
        this.lastAheadSignature = null;
        this.lastAheadCenterTx = null;
        this.lastAheadCenterTz = null;
        this.pendingAheadSignature = null;
        this.pendingAheadSince = 0;
        this.pendingAheadRequest = null;
        this.pendingEvictionCenter = null;
        this.nextEvictionAtMs = Infinity;
        this.sourceHolds = 0;
        this.deliveryHolds = new Set();
        this.pendingCallbacks = new Map();
        this.nextCallbackSequence = 0;
        this.dependencyTileKeys = new Map();
        this.aborted = false;
        this.unregisterActivity = registerBackgroundActivityReader(() => ({
            kind: 'stream',
            label: this.label,
            ...this.getDebugCounts(),
        }));
    }

    getDebugCounts() {
        const counts = {
            loaded: 0,
            pending: 0,
            queued: 0,
            fetching: 0,
            building: 0,
            retrying: this.failed.size,
            fetchFailed: 0,
            buildFailed: 0,
            fetchFailureStreak: this.consecutiveFetchFailures,
        };
        for (const entry of this.tiles.values()) {
            if (entry?.status === 'loaded') counts.loaded += 1;
            else if (entry?.status === 'queued') {
                counts.queued += 1;
                counts.pending += 1;
            }
            else if (entry?.status === 'fetching') {
                counts.fetching += 1;
                counts.pending += 1;
            } else if (entry?.status === 'building') {
                counts.building += 1;
                counts.pending += 1;
            }
        }
        for (const failure of this.failed.values()) {
            if (failure?.stage === 'build') counts.buildFailed += 1;
            else counts.fetchFailed += 1;
        }
        return counts;
    }

    getInitialLoadCounts() {
        let pending = 0;
        let failed = 0;
        let tracked = 0;
        // The source may also own a 5 x 5 detail ring or a kilometre-long
        // route-ahead corridor. Startup data readiness covers only the four
        // source tiles touching local (0, 0); explicit layer gates verify that
        // their subscriber geometry has published before reveal.
        for (const tileKey of INITIAL_WORLD_SUPPORT_TILE_KEYS) {
            const entry = this.tiles.get(tileKey);
            const failure = this.failed.get(tileKey);
            if (!entry && !failure) continue;
            tracked += 1;
            if (entry && ['queued', 'fetching', 'building'].includes(entry.status)) {
                pending += 1;
            }
            if (failure) failed += 1;
        }
        return { pending, failed, tracked };
    }

    isLoadedAtLocal(localX, localZ) {
        const x = Number(localX);
        const z = Number(localZ);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
        const key = `${tileIndex(x, this.tileM)}_${tileIndex(z, this.tileM)}`;
        return this.tiles.get(key)?.status === 'loaded';
    }

    getDebugState() {
        const queuedByVisibility = {
            support: 0,
            visible: 0,
            peripheral: 0,
            hidden: 0,
            unknown: 0,
        };
        let oldestVisibleQueuedMs = 0;
        if (this.prioritizeByView) {
            const now = Date.now();
            for (const entry of this.tiles.values()) {
                if (!entry || entry.status !== 'queued') continue;
                const priority = this.tileViewPriority(entry);
                queuedByVisibility[priority.tier] += 1;
                if (priority.tier === 'support' || priority.tier === 'visible') {
                    oldestVisibleQueuedMs = Math.max(
                        oldestVisibleQueuedMs,
                        Math.max(0, now - (entry.queuedAtMs || now)),
                    );
                }
            }
        }
        return {
            label: this.label,
            ...this.getDebugCounts(),
            activeRequests: this.activeRequestCount,
            pendingTiles: this.pendingTileCount,
            maxPendingTiles: this.maxPendingTiles,
            startupPendingTileLimit: this.startupPendingTileLimit,
            startupPriority: this.startupPriority,
            maxConcurrentRequests: this.maxConcurrentRequests,
            prioritizeByView: this.prioritizeByView,
            queuedByVisibility,
            oldestVisibleQueuedMs,
            pinnedTiles: this.pinnedTileKeys.size,
            sourceHolds: this.sourceHolds,
            admissionBarrier: this.admissionBarrier != null,
            pendingCallbacks: this.pendingCallbacks.size,
            deliveryHolds: [...this.deliveryHolds].map(hold => ({
                barrier: !!hold.barrier,
                sealed: !!hold.sealed,
                pending: hold.pending || 0,
                pendingTiles: hold.pendingTiles?.size || 0,
                requestedTiles: hold.requestedTiles?.size || 0,
                retainedTiles: hold.retainedTiles?.size || 0,
                handoffDelivery: !!hold.handoffDelivery,
            })),
            priorityFocus: { x: this.focusX, z: this.focusZ },
            supportFocus: this.hasSupportFocus
                ? { x: this.supportX, z: this.supportZ }
                : null,
            failures: [...this.failed.entries()].map(([tileKey, failure]) => ({
                tileKey,
                attempts: failure.attempts,
                nextTryAt: failure.nextTryAt,
                stage: failure.stage,
                message: failure.error?.message || String(failure.error || ''),
            })),
        };
    }

    // Callbacks parked behind the closed generation's admission barrier. They
    // are delivered only by the next admission, and nothing but an admission
    // removes the barrier, so a stationary owner must be told they exist or
    // the downloaded tiles wait forever (docs/performance/next-steps.md, S1).
    heldDeliveryCount() {
        return this.admissionBarrier ? this.pendingCallbacks.size : 0;
    }

    capturePriorityTileKeys({ maxTiles, includeTileKeys = [] } = {}) {
        if (!Number.isSafeInteger(maxTiles) || maxTiles < 1 || !Array.isArray(includeTileKeys)
            || new Set(includeTileKeys).size !== includeTileKeys.length) {
            throw new TypeError('Priority tile capture requires a bounded unique seed');
        }
        const selected = [], seen = new Set();
        const add = key => {
            if (selected.length >= maxTiles || seen.has(key) || !this.tiles.has(key)) return;
            seen.add(key); selected.push(key);
        };
        includeTileKeys.forEach(add);
        const pending = [...this.tiles.entries()].filter(([key, entry]) => !seen.has(key)
            && entry && entry.status !== 'loaded');
        pending.sort(([, a], [, b]) => {
            const pa = this.tileViewPriority(a), pb = this.tileViewPriority(b);
            return (Number(pb.score) || 0) - (Number(pa.score) || 0)
                || (a.sequence || 0) - (b.sequence || 0);
        });
        for (const [key] of pending) add(key);
        return selected;
    }

    notePriorityView(localX, localZ, view = null) {
        this.focusX = Number.isFinite(localX) ? localX : 0;
        this.focusZ = Number.isFinite(localZ) ? localZ : 0;
        if (!this.prioritizeByView) return false;
        const headingDeg = Number(view?.headingDeg);
        const fovDeg = Number(view?.fovDeg);
        // A caller that only updates position must not erase the most recent
        // camera direction supplied by ensureAhead (roads/curbs/paint call the
        // two methods back-to-back). Explicit finite view values replace it.
        if (Number.isFinite(headingDeg)) this.viewHeadingDeg = headingDeg;
        if (Number.isFinite(fovDeg)) this.viewFovDeg = fovDeg;
        else if (!Number.isFinite(this.viewFovDeg)) this.viewFovDeg = 90;
        const signature = [
            Math.round(this.focusX / 10),
            Math.round(this.focusZ / 10),
            this.hasSupportFocus ? Math.round(this.supportX / 10) : 'none',
            this.hasSupportFocus ? Math.round(this.supportZ / 10) : 'none',
            Number.isFinite(this.viewHeadingDeg) ? Math.round(this.viewHeadingDeg / 2) : 'none',
            Math.round(this.viewFovDeg / 2),
        ].join(':');
        const changed = signature !== this.lastPrioritySignature;
        this.lastPrioritySignature = signature;
        return changed;
    }

    tileViewPriority(entry) {
        const withSourcePriority = (priority) => {
            if (!isWorldBuilding() || this.startupPriority === 0) return priority;
            const score = Number(priority?.score);
            return {
                ...priority,
                tierRank: (Number(priority?.tierRank)
                    || VIEW_PRIORITY_TIERS[priority?.tier]
                    || 0) + this.startupPriority,
                ...(Number.isFinite(score) ? {
                    score: score + this.startupPriority * SOURCE_STARTUP_PRIORITY_STRIDE,
                } : {}),
            };
        };
        if (this.dependencyTileKeys.has(`${entry.tx}_${entry.tz}`)) {
            return withSourcePriority({ tier: 'support', distanceSq: 0 });
        }
        const bounds = tileLocalBounds(entry.tx, entry.tz, this.tileM);
        if (this.hasSupportFocus && tileDistanceSqToPoint(
            entry.tx,
            entry.tz,
            this.supportX,
            this.supportZ,
            this.tileM,
        ) === 0) {
            return withSourcePriority(classifyViewPriority(bounds, {
                observerX: this.supportX,
                observerZ: this.supportZ,
                headingDeg: Number.isFinite(this.viewHeadingDeg)
                    ? this.viewHeadingDeg
                    : 0,
                fovDeg: this.viewFovDeg,
            }));
        }
        const distanceSq = tileDistanceSqToPoint(
            entry.tx,
            entry.tz,
            this.focusX,
            this.focusZ,
            this.tileM,
        );
        if (!this.prioritizeByView) {
            // A distance-only source still participates fairly in the global
            // camera budget. Observer-touching tiles are immediate support;
            // the rest of its small ring is peripheral rather than "unknown",
            // which could otherwise starve forever behind directional streams.
            return withSourcePriority({
                tier: distanceSq === 0 ? 'support' : 'peripheral',
                distanceSq,
            });
        }
        return withSourcePriority(classifyViewPriority(
            bounds,
            {
                observerX: this.focusX,
                observerZ: this.focusZ,
                headingDeg: this.viewHeadingDeg,
                fovDeg: this.viewFovDeg,
            },
        ));
    }

    retriesDue() {
        return this.failed.size > 0 && Date.now() >= this.nextRetryAt;
    }

    recomputeNextRetry() {
        let soonest = Infinity;
        for (const failure of this.failed.values()) {
            if (failure.nextTryAt < soonest) soonest = failure.nextTryAt;
        }
        this.nextRetryAt = soonest;
    }

    subscribe(subscriber) {
        if (this.aborted) return () => {};
        const safeSubscriber = {
            onFetch: subscriber && subscriber.onFetch,
            onEvict: subscriber && subscriber.onEvict,
            onBuildFailure: subscriber && subscriber.onBuildFailure,
            isExpectedBuildCancellation: subscriber && subscriber.isExpectedBuildCancellation,
            deliveryLabel: String(subscriber?.deliveryLabel || this.label || 'tile'),
        };
        this.subscribers.add(safeSubscriber);
        for (const [tileKey, entry] of this.tiles.entries()) {
            if (!entry || !Array.isArray(entry.features)) continue;
            entry.deliveries.set(safeSubscriber, 'pending');
            this.deliverTile(tileKey, entry, [safeSubscriber]);
        }
        return () => {
            this.subscribers.delete(safeSubscriber);
            for (const callback of this.pendingCallbacks.values()) {
                if (callback.subscriber === safeSubscriber) callback.finish();
            }
            for (const entry of this.tiles.values()) {
                entry?.deliveries?.delete(safeSubscriber);
            }
            this.finishTileIfBuilt();
        };
    }

    finishTileIfBuilt(tileKey = null) {
        const entries = tileKey == null
            ? this.tiles.entries()
            : [[tileKey, this.tiles.get(tileKey)]];
        for (const [key, entry] of entries) {
            if (!entry || !Array.isArray(entry.features)) continue;
            const states = [...entry.deliveries.values()];
            if (states.some(state => state === 'pending' || state === 'building')) {
                entry.status = 'building';
                continue;
            }
            if (states.some(state => state === 'failed')) {
                entry.status = 'retrying';
                continue;
            }
            entry.status = 'loaded';
            if (this.failed.delete(key)) {
                this.recomputeNextRetry();
                if (this.failed.size === 0) {
                    setSourceDegraded(this.healthToken, this.label, false);
                }
            }
        }
    }

    async deliverTile(tileKey, entry, subscribers) {
        if (this.aborted || !entry || this.tiles.get(tileKey) !== entry) return;
        for (const hold of this.deliveryHolds) hold.pendingTiles?.delete(tileKey);
        const targets = (subscribers || []).filter(subscriber => (
            this.subscribers.has(subscriber)
            && entry.deliveries.get(subscriber) !== 'loaded'
        ));
        if (targets.length === 0) {
            this.finishTileIfBuilt(tileKey);
            return;
        }
        entry.status = 'building';
        const results = await Promise.allSettled(targets.map(async (subscriber) => {
            entry.deliveries.set(subscriber, 'building');
            const sequence = this.nextCallbackSequence++;
            for (const hold of this.deliveryHolds) {
                if (sequence > hold.through && hold.admits(sequence, tileKey)) hold.pending++;
            }
            const callback = { subscriber, tileKey, finish: () => {
                if (!this.pendingCallbacks.delete(sequence)) return;
                for (const hold of this.deliveryHolds) if (hold.admits(sequence, tileKey)) hold.pending--;
            } };
            this.pendingCallbacks.set(sequence, callback);
            try {
                // A shared source can have several consumers. Running every
                // subscriber inline made one delivery item inherit their
                // combined synchronous cost (and the source owner's label),
                // so road-graph tiles appeared as large `road-formations`
                // spikes even when the formation handler itself was cheap.
                // Give each subscriber its own scheduler item: an overrun is
                // isolated to its owner and the remaining consumers resume on
                // a later frame once this queue's budget is exhausted.
                await this.deferWork(
                    () => {
                        // The camera may have moved while this delivery waited
                        // for its frame slice. An evicted tile is no longer an
                        // instruction to build; its onEvict hook has already
                        // cancelled any layer-owned work for this key.
                        if (this.aborted
                            || this.tiles.get(tileKey) !== entry
                            || !this.subscribers.has(subscriber)) { callback.finish(); return undefined; }
                        for (const hold of this.deliveryHolds) {
                            if (!hold.admits(sequence, tileKey)) return FRAME_CHUNK_DEFER_ITEM;
                        }
                        try {
                            return notifySubscriber(subscriber, 'onFetch', entry.features, tileKey);
                        } finally {
                            // Source admission waits for the bounded callback,
                            // never its downstream geometry/publication promise.
                            // Asynchronous source registration has its own layer
                            // readiness guard before the source snapshot seals.
                            callback.finish();
                        }
                    },
                    this.allowDuringMovement,
                    `${subscriber.deliveryLabel} ${tileKey}`,
                );
                if (this.tiles.get(tileKey) === entry && this.subscribers.has(subscriber)) {
                    entry.deliveries.set(subscriber, 'loaded');
                }
            } catch (error) {
                const expectedCancellation = typeof subscriber.isExpectedBuildCancellation === 'function'
                    && subscriber.isExpectedBuildCancellation(error) === true;
                if (expectedCancellation) {
                    // Some subscribers own a retained-generation replacement
                    // pipeline. Superseding that private build is successful
                    // lifecycle control, not a failed source delivery: the
                    // subscriber has already queued its authoritative successor.
                    // Marking it failed here caused a duplicate retry and a
                    // scary console warning for an expected Worker cancel.
                    if (this.tiles.get(tileKey) === entry && this.subscribers.has(subscriber)) {
                        entry.deliveries.set(subscriber, 'loaded');
                    }
                    return;
                }
                if (this.tiles.get(tileKey) === entry && this.subscribers.has(subscriber)) {
                    entry.deliveries.set(subscriber, 'failed');
                    try {
                        const cleanup = subscriber.onBuildFailure || subscriber.onEvict;
                        if (typeof cleanup === 'function') await cleanup(tileKey, error);
                    } catch (cleanupError) {
                        console.warn(
                            `[SharedTileSession:${this.label}] failed-delivery cleanup failed`,
                            tileKey,
                            cleanupError,
                        );
                    }
                }
                throw error;
            } finally { callback.finish(); }
        }));
        if (this.aborted || this.tiles.get(tileKey) !== entry) return;
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected) {
            this.recordFailure(tileKey, 'build', rejected.reason);
        } else {
            this.finishTileIfBuilt(tileKey);
        }
    }

    recordFailure(tileKey, stage, error) {
        if (this.aborted) return;
        const attempts = (this.failed.get(tileKey)?.attempts || 0) + 1;
        this.failed.set(tileKey, {
            attempts,
            nextTryAt: Date.now() + retryDelayMs(
                attempts,
                this.retryBaseMs,
                this.retryMaxMs,
            ),
            stage,
            error,
        });
        const entry = this.tiles.get(tileKey);
        if (entry) entry.status = 'retrying';
        this.recomputeNextRetry();
        if (stage === 'fetch') {
            this.consecutiveFetchFailures += 1;
            if (this.consecutiveFetchFailures >= DEGRADED_AFTER_FAILURES) {
                setSourceDegraded(this.healthToken, this.label, true);
            }
        }
        if (attempts === 1 || attempts % 8 === 0) {
            console.warn(
                `[SharedTileSession:${this.label}] ${stage} failed`
                + ` (attempt ${attempts}, will retry)`,
                tileKey,
                (error && error.message) || error,
            );
        }
    }

    noteFetchSucceeded() {
        this.consecutiveFetchFailures = 0;
        setSourceDegraded(this.healthToken, this.label, false);
    }

    retryFailedBuild(tileKey, entry) {
        const failedSubscribers = [...entry.deliveries.entries()]
            .filter(([, status]) => status === 'failed')
            .map(([subscriber]) => subscriber);
        if (failedSubscribers.length === 0) {
            this.finishTileIfBuilt(tileKey);
            return;
        }
        this.deliverTile(tileKey, entry, failedSubscribers);
    }

    ensureAround(localX, localZ, view = null) {
        if (this.aborted) return;
        if (!this.fetchController || this.fetchController.signal.aborted) return;
        const previousSupportX = this.supportX;
        const previousSupportZ = this.supportZ;
        const hadSupportFocus = this.hasSupportFocus;
        this.supportX = Number.isFinite(localX) ? localX : 0;
        this.supportZ = Number.isFinite(localZ) ? localZ : 0;
        this.hasSupportFocus = true;
        const supportChanged = !hadSupportFocus
            || Math.round(previousSupportX / 10) !== Math.round(this.supportX / 10)
            || Math.round(previousSupportZ / 10) !== Math.round(this.supportZ / 10);
        // Several layers subscribe to roads:cab. Once any owner has opened an
        // ahead corridor, a later sibling's ensureAround() must update support
        // without erasing that predictive priority point. The corridor owner
        // refreshes it through ensureAhead() every frame.
        const preserveAheadPriority = this.lastAheadSignature != null;
        const priorityChanged = preserveAheadPriority
            ? supportChanged
            : this.notePriorityView(localX, localZ, view);
        const cx = tileIndex(localX, this.tileM);
        const cz = tileIndex(localZ, this.tileM);
        if (this.pendingEvictionCenter
            || (this.nextEvictionAtMs !== Infinity && evictNowMs() >= this.nextEvictionAtMs)) {
            this.evictOutsideRing(cx, cz);
        }
        const moved = this.lastTx !== cx || this.lastTz !== cz;
        if (!moved && !this.retriesDue()) {
            if (priorityChanged) this.pumpFetchQueue();
            return;
        }
        this.lastTx = cx;
        this.lastTz = cz;
        // Register the complete desired ring before pumping. The bounded source
        // queue then compares true point-to-tile distance, so a spawn on a grid
        // corner starts all four touching tiles before any farther block.
        for (const { dx, dz } of this.ringOffsets) {
            this.fetchTile(cx + dx, cz + dz);
        }
        this.pumpFetchQueue();
        if (moved) this.evictOutsideRing(cx, cz);
    }

    // Preload an authored set of local points and keep their source tiles for
    // the life of this world. The points come from a bounded campaign corridor;
    // normal free-roam still uses the replaceable ensureAhead window below.
    ensurePinnedPoints(points, {
        signature = '',
        priorityX = null,
        priorityZ = null,
        headingDeg = null,
    } = {}) {
        if (this.aborted || !this.fetchController
            || this.fetchController.signal.aborted || !Array.isArray(points)) return;
        const requestedSignature = String(signature || '');
        const retryDue = this.retriesDue();
        if (requestedSignature
            && requestedSignature === this.lastPinnedSignature
            && !retryDue) return;
        const safePoints = points.filter(point => (
            Number.isFinite(point?.x) && Number.isFinite(point?.z)
        ));
        if (safePoints.length === 0) return;
        const focusX = Number.isFinite(priorityX) ? priorityX : safePoints[0].x;
        const focusZ = Number.isFinite(priorityZ) ? priorityZ : safePoints[0].z;
        const priorityChanged = this.notePriorityView(focusX, focusZ, { headingDeg });
        const safeSignature = String(requestedSignature || safePoints.map(point => (
            `${tileIndex(point.x, this.tileM)}_${tileIndex(point.z, this.tileM)}`
        )).join(':'));
        const signatureChanged = safeSignature !== this.lastPinnedSignature;
        if (signatureChanged) {
            this.lastPinnedSignature = safeSignature;
            this.pinnedTileKeys = new Set(safePoints.map(point => (
                `${tileIndex(point.x, this.tileM)}_${tileIndex(point.z, this.tileM)}`
            )));
        }
        if (signatureChanged || retryDue) {
            for (const tileKey of this.pinnedTileKeys) {
                const [tx, tz] = tileKey.split('_').map(Number);
                this.fetchTile(tx, tz);
            }
        }
        if (signatureChanged || priorityChanged || retryDue) {
            this.pumpFetchQueue();
        }
        if (signatureChanged && this.lastTx !== null && this.lastTz !== null) {
            this.evictOutsideRing(this.lastTx, this.lastTz);
        }
    }

    // Surface layers can see much farther down a straight street than the
    // normal 3x3 simulation ring. Fetch a narrow corridor in the direction of
    // travel so the complete road surface is present before fog can reveal a
    // tile boundary, without expanding every streamed layer in all directions.
    ensureAhead(localX, localZ, headingDeg, {
        distanceM = 1400,
        halfWidthM = 120,
        stepM = 100,
    } = {}) {
        if (this.aborted) return;
        if (!this.fetchController || this.fetchController.signal.aborted) return;
        // Build the same finite initial view corridor behind the loading
        // curtain. Deferring it until reveal moved most startup construction
        // into the interactive frame budget. View priority still fetches the
        // observer's support tiles first, and movement keeps the same window.
        const numericHeading = Number(headingDeg);
        if (!Number.isFinite(numericHeading)) return;
        const priorityChanged = this.notePriorityView(localX, localZ, {
            headingDeg: numericHeading,
        });
        const cx = tileIndex(localX, this.tileM);
        const cz = tileIndex(localZ, this.tileM);
        const headingBucket = Math.round(numericHeading / 10) * 10;
        const safeStepM = Math.max(25, Number(stepM) || 100);
        const safeDistanceM = Math.max(0, Number(distanceM) || 0);
        const safeHalfWidthM = Math.max(0, Number(halfWidthM) || 0);
        const signature = `${cx}:${cz}:${headingBucket}:${safeDistanceM}:${safeHalfWidthM}:${safeStepM}`;
        const request = {
            localX,
            localZ,
            cx,
            cz,
            headingBucket,
            safeDistanceM,
            safeHalfWidthM,
            safeStepM,
            signature,
        };
        const centerTileChanged = cx !== this.lastAheadCenterTx
            || cz !== this.lastAheadCenterTz;
        if (this.lastAheadSignature == null || centerTileChanged) {
            this.applyAheadRequest(request);
            return;
        }
        if (signature === this.lastAheadSignature) {
            this.pendingAheadSignature = null;
            this.pendingAheadRequest = null;
            if (this.retriesDue()) {
                for (const tileKey of this.aheadTileKeys) {
                    const [tx, tz] = tileKey.split('_').map(Number);
                    this.fetchTile(tx, tz);
                }
                this.pumpFetchQueue();
            } else if (priorityChanged) {
                // Re-rank already queued corridor tiles immediately when the
                // camera turns, even if the corridor geometry is unchanged.
                this.pumpFetchQueue();
            }
            return;
        }
        const now = Date.now();
        if (signature !== this.pendingAheadSignature) {
            this.pendingAheadSignature = signature;
            this.pendingAheadSince = now;
            this.pendingAheadRequest = request;
            if (priorityChanged) this.pumpFetchQueue();
            return;
        }
        if (now - this.pendingAheadSince < AHEAD_HEADING_SETTLE_MS) {
            if (priorityChanged) this.pumpFetchQueue();
            return;
        }
        this.applyAheadRequest(this.pendingAheadRequest || request);
    }

    applyAheadRequest(request) {
        const {
            localX,
            localZ,
            cx,
            cz,
            headingBucket,
            safeDistanceM,
            safeHalfWidthM,
            safeStepM,
            signature,
        } = request;
        this.lastAheadSignature = signature;
        this.lastAheadCenterTx = cx;
        this.lastAheadCenterTz = cz;
        this.pendingAheadSignature = null;
        this.pendingAheadRequest = null;

        const h = headingBucket * Math.PI / 180;
        const forwardX = Math.sin(h);
        const forwardZ = -Math.cos(h);
        const rightX = Math.cos(h);
        const rightZ = Math.sin(h);
        const nextAheadTileKeys = new Set();
        const lateralOffsets = safeHalfWidthM > 0
            ? [-safeHalfWidthM, 0, safeHalfWidthM]
            : [0];

        for (let forwardM = 0; forwardM <= safeDistanceM; forwardM += safeStepM) {
            for (const lateralM of lateralOffsets) {
                const x = localX + forwardX * forwardM + rightX * lateralM;
                const z = localZ + forwardZ * forwardM + rightZ * lateralM;
                nextAheadTileKeys.add(`${tileIndex(x, this.tileM)}_${tileIndex(z, this.tileM)}`);
            }
        }
        // Stamp tiles that just LEFT the corridor. Retention beyond keepRing is
        // corridor-shaped, so simply turning on the spot sweeps tiles out of it
        // and they were evicted instantly — then rebuilt the moment you turned
        // back. The geometry is already built; a grace period makes a look-round
        // free instead of paying for it twice.
        const leftNowMs = evictNowMs();
        for (const tileKey of this.aheadTileKeys) {
            if (!nextAheadTileKeys.has(tileKey)) this.aheadLeftAtMs.set(tileKey, leftNowMs);
        }
        for (const tileKey of nextAheadTileKeys) this.aheadLeftAtMs.delete(tileKey);
        this.aheadTileKeys = nextAheadTileKeys;
        for (const tileKey of nextAheadTileKeys) {
            const [tx, tz] = tileKey.split('_').map(Number);
            this.fetchTile(tx, tz);
        }
        this.pumpFetchQueue();
        this.evictOutsideRing(cx, cz);
    }

    fetchTile(tx, tz) {
        const tileKey = `${tx}_${tz}`;
        const existing = this.tiles.get(tileKey);
        const failure = this.failed.get(tileKey);
        if (existing) {
            if (!failure || Date.now() < failure.nextTryAt) return;
            if (failure.stage === 'build' && Array.isArray(existing.features)) {
                this.retryFailedBuild(tileKey, existing);
            }
            return;
        }
        if (failure && Date.now() < failure.nextTryAt) return;   // still backing off
        const entry = {
            status: 'queued',
            features: null,
            deliveries: new Map(),
            requestController: new AbortController(),
            tx,
            tz,
            sequence: this.nextFetchSequence++,
            queuedAtMs: Date.now(),
        };
        this.tiles.set(tileKey, entry);
    }

    pumpFetchQueue() {
        if (this.aborted || this.fetchController?.signal?.aborted) return;
        for (const [tileKey, entry] of this.tiles.entries()) {
            if (!entry || entry.status !== 'queued' || entry.requestScheduled) continue;
            entry.requestScheduled = true;
            const scheduled = this.requestScheduler.schedule({
                label: `${this.label}:${tileKey}`,
                groupKey: this.healthToken,
                groupLimit: this.maxConcurrentRequests,
                priority: () => this.tileViewPriority(entry),
                signal: entry.requestController.signal,
                // During initial construction, a sealed ground generation
                // holds delivery while its successor can download. Four
                // buffered tiles serialized that loading into many tiny
                // generations with an idle network between them. Keep a
                // finite 32-tile ceiling only while both conditions hold;
                // ordinary streaming retains its original backpressure.
                canStart: () => [...this.deliveryHolds].every(hold => !hold.requestedTiles
                    || hold.sealed || hold.requestedTiles.has(tileKey))
                    && ([...this.deliveryHolds].some(hold => hold.boundedRequested && !hold.sealed
                        && hold.requestedTiles?.has(tileKey))
                        // A bounded admission tile must be able to cross an
                        // older full decoded buffer. The hold blocks those
                        // unselected callbacks, so applying the ordinary cap
                        // here creates a cycle: the selected tile cannot fetch
                        // and the buffered tiles cannot deliver. The requested
                        // set is capacity-checked by hold(), keeping this finite.
                        || this.pendingTileCount < (isWorldBuilding() && this.deliveryHolds.size
                            ? this.startupPendingTileLimit : this.maxPendingTiles)),
                run: () => this.startQueuedTile(tileKey, entry),
            });
            scheduled.then(
                () => {
                    if (this.tiles.get(tileKey) === entry) entry.requestScheduled = false;
                },
                (error) => {
                    if (this.tiles.get(tileKey) === entry) entry.requestScheduled = false;
                    if (error?.name === 'AbortError'
                        || entry.requestController?.signal?.aborted
                        || this.aborted) return;
                    if (this.tiles.get(tileKey) !== entry || entry.status !== 'queued') return;
                    this.tiles.delete(tileKey);
                    this.recordFailure(tileKey, 'fetch', error);
                },
            );
        }
        // The scheduler deliberately pumps in a microtask after every layer
        // has registered its batch. Starting here would let the first source
        // consume the global ceiling before roads, terrain, and buildings can
        // be compared by camera priority.
    }

    startQueuedTile(tileKey, entry) {
        if (this.aborted || this.tiles.get(tileKey) !== entry || entry.status !== 'queued') return;
        entry.status = 'fetching';
        if (startupTrace.enabled) startupTrace.tileEvent('request-start', this.label, tileKey);
        this.activeRequestCount += 1;
        this.pendingTileCount += 1;
        const { tx, tz } = entry;
        const bbox = tileBbox(tx, tz, this.anchorLat, this.anchorLon, this.tileM);
        const loadLive = () => this.requestJson(
            this.url(bbox),
            this.allowDuringMovement,
            this.decodeBody,
            this.createTextDecodeTask,
            entry.requestController.signal,
        );
        const finishDelivery = () => {
            if (this.tiles.get(tileKey) === entry) entry.requestController = null;
            this.pendingTileCount = Math.max(0, this.pendingTileCount - 1);
            this.requestScheduler.wake();
        };
        const failDelivery = (err) => {
            if (err?.name === 'AbortError'
                && (this.aborted || this.fetchController.signal.aborted)) return;
            if (this.tiles.get(tileKey) !== entry) return;
            // Subscriber/build failures are recorded by deliverTile and
            // retain their fetched payload for a build-only retry.
            if (entry.status === 'retrying' && Array.isArray(entry.features)) return;
            this.tiles.delete(tileKey);
            if (!this.aborted) this.recordFailure(tileKey, 'fetch', err);
        };
        return Promise.resolve().then(() => {
            if (this.aborted || this.fetchController.signal.aborted
                || this.tiles.get(tileKey) !== entry || entry.requestController.signal.aborted) {
                throw new DOMException('Tile request cancelled before loading', 'AbortError');
            }
            return this.loadPayload
                ? this.loadPayload({ bbox, tileKey, signal: entry.requestController.signal, loadLive })
                : loadLive();
        })
            .then((data) => {
                // Body consumption/decoding is complete. Delivery retains a
                // finite per-source slot, but returns the global network slot
                // now, even if a subscriber waits for geometry publication.
                entry.status = 'building';
                entry.deliveryPromise = this.deferWork(async () => {
                    // This item validates and publishes the fetched payload. Each
                    // subscriber is scheduled separately by deliverTile(), so its
                    // layer work cannot be aggregated into this envelope item.
                    if (this.aborted || this.fetchController.signal.aborted) return;
                    if (this.tiles.get(tileKey) !== entry) return;
                    if (data && data.error) throw new Error(`API error: ${data.error}`);
                    if (this.validatePayload && this.validatePayload(data) !== true) {
                        throw new Error('Invalid tile payload');
                    }
                    const features = this.parseFeatures(data);
                    if (!Array.isArray(features)) {
                        throw new Error('Invalid tile payload: expected an array of features');
                    }
                    // The server delivered a valid payload. Clear network health
                    // now; a later subscriber/build error is a separate client bug.
                    this.noteFetchSucceeded();
                    entry.features = features;
                    if (startupTrace.enabled) {
                        startupTrace.tileEvent('payload-ready', this.label, tileKey);
                    }
                    entry.status = 'building';
                    for (const subscriber of this.subscribers) {
                        entry.deliveries.set(subscriber, 'pending');
                    }
                    await this.deliverTile(tileKey, entry, [...this.subscribers]);
                    this.finishTileIfBuilt(tileKey);
                    if (startupTrace.enabled && entry.status === 'loaded') {
                        startupTrace.tileEvent('build-complete', this.label, tileKey);
                    }
                }, this.allowDuringMovement, `prepare ${this.label} ${tileKey}`)
                    .catch(failDelivery).finally(finishDelivery);
            }, (err) => {
                try { failDelivery(err); } finally { finishDelivery(); }
            })
            .finally(() => {
                this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
            });
    }

    evictOutsideRing(cx, cz) {
        // Removing a tile tells every subscriber to tear down its meshes and
        // GPU resources synchronously. Long country-scale drives cannot wait
        // for a stationary frame that may never arrive, so eviction runs while
        // moving and is bounded by the shared per-frame slice below.
        this.pendingEvictionCenter = null;
        this.nextEvictionAtMs = Infinity;
        const graceNowMs = evictNowMs();
        const shouldEvict = (tileKey) => {
            const [tx, tz] = tileKey.split('_').map(Number);
            const outsideRing = Math.abs(tx - cx) > this.keepRing
                || Math.abs(tz - cz) > this.keepRing;
            if (!outsideRing || this.aheadTileKeys.has(tileKey)
                || this.pinnedTileKeys.has(tileKey)) return false;
            if (this.dependencyTileKeys.has(tileKey)
                || [...this.deliveryHolds].some(hold => hold.retainedTiles.has(tileKey))) {
                this.pendingEvictionCenter = { cx, cz };
                return false;
            }
            const entry = this.tiles.get(tileKey);
            // Grace is for already-visible geometry when the user glances
            // away and back. It must not preserve work that has never reached
            // the screen: queued work is cancelled, and obsolete in-flight or
            // delivery results are detached so their eventual result is
            // discarded instead of consuming build/publication time.
            if (entry && entry.status !== 'loaded') return true;
            const leftAtMs = this.aheadLeftAtMs.get(tileKey);
            if (withinAheadGrace(leftAtMs, graceNowMs, {
                graceMs: this.aheadGraceMs,
                heldCount: this.aheadLeftAtMs.size,
                maxHeld: this.aheadGraceMaxTiles,
            })) {
                // A stationary observer must still release expired grace tiles.
                // Wake at the earliest expiry, without scanning the tile table
                // on every frame while the grace period is still running.
                this.nextEvictionAtMs = Math.min(this.nextEvictionAtMs,
                    leftAtMs + this.aheadGraceMs);
                return false;
            }
            return true;
        };
        const evict = [];
        for (const tileKey of this.tiles.keys()) {
            if (shouldEvict(tileKey)) evict.push(tileKey);
        }
        // BOUNDED. A teardown at every tile boundary at boost speed is a hitch
        // you can see, but deferring until the observer stops has no ceiling:
        // a long ride accumulates hundreds of stale tiles. Drain continuously
        // within one shared frame slice instead.
        // Measured on prod, four minutes into project 77: ensureAround took
        // 562 ms of a 620 ms frame, and this loop is what it was doing.
        //
        // Spend a slice per call instead and leave the rest pending. The clock
        // is read every tile because a teardown is not a fixed cost: it notifies
        // every subscriber, and a dense tile disposes far more than an empty one.
        const startedMs = evictNowMs();
        const deadline = startedMs + evictBudgetRemainingMs(startedMs);
        let evicted = 0;
        for (const tileKey of evict) {
            // Always make progress — one tile per call minimum. Otherwise a
            // single slow teardown, or a frame whose budget is already spent by
            // a sibling source, could stall eviction forever and the backlog
            // this exists to drain would grow instead.
            if (evicted > 0 && evictNowMs() >= deadline) break;
            const entry = this.tiles.get(tileKey);
            entry?.requestController?.abort?.(
                new DOMException('Tile left the active view', 'AbortError'),
            );
            this.tiles.delete(tileKey);
            this.failed.delete(tileKey);
            this.aheadLeftAtMs.delete(tileKey);   // gone: stop holding its grace stamp
            for (const subscriber of this.subscribers) {
                notifySubscriber(subscriber, 'onEvict', tileKey);
            }
            evicted += 1;
        }
        // Charge the shared window, so sibling sources evicting in this same
        // frame see a smaller budget rather than each getting a fresh one.
        evictSpentMs += evictNowMs() - startedMs;
        if (evicted < evict.length) {
            // Still stale tiles to drop: keep the request alive so the next
            // ensureAround resumes it instead of waiting for the observer to
            // move and settle again.
            this.pendingEvictionCenter = { cx, cz };
        }
        for (const tileKey of [...this.failed.keys()]) {
            if (shouldEvict(tileKey)) this.failed.delete(tileKey);
        }
        this.recomputeNextRetry();
        if (this.failed.size === 0) {
            setSourceDegraded(this.healthToken, this.label, false);
        }
        return evicted === evict.length;
    }

    hold({ drainQueued = false, drainRequested = false, requestedTileKeys = null,
        handoffDelivery = false, maxTiles } = {}) {
        if (requestedTileKeys !== null && (!Array.isArray(requestedTileKeys)
            || new Set(requestedTileKeys).size !== requestedTileKeys.length
            || requestedTileKeys.some(key => typeof key !== 'string'
                || !/^-?\d+_-?\d+$/.test(key)))) {
            throw new TypeError('Requested source admission requires unique integer tile keys');
        }
        const requestedTiles = drainRequested
            ? new Set(requestedTileKeys || this.tiles.keys())
            : null;
        if (drainRequested && (!Number.isSafeInteger(maxTiles) || maxTiles < 1
            || requestedTiles.size > maxTiles)) {
            throw Object.assign(new RangeError('Requested source admission exceeds its tile capacity'),
                { code: 'ground-generation-capacity' });
        }
        // A named requested set is a bounded batch. Older callbacks for other
        // tiles stay behind the hold and become the next generation.
        const boundedRequested = requestedTileKeys !== null;
        const boundedPending = boundedRequested
            ? [...this.pendingCallbacks.values()].filter(callback => requestedTiles?.has(callback.tileKey)).length
            : 0;
        const hold = { through: drainQueued && !boundedRequested ? this.nextCallbackSequence - 1 : -1,
            boundedRequested,
            pending: boundedRequested ? boundedPending
                : drainQueued ? this.pendingCallbacks.size : 0,
            requestedTiles,
            pendingTiles: drainRequested ? new Set([...requestedTiles]
                .filter(key => !Array.isArray(this.tiles.get(key)?.features))) : null,
            sealed: false,
            // Retain the finite captured membership. New, unadmitted requests
            // must still be evictable while the observer moves during a build.
            // Delivery is bounded to requestedTiles, but the candidate model
            // also contains every tile admitted before this hold. Retain that
            // complete existing membership until publication; evicting an old
            // road tile midway through a six-tile successor changes the model
            // revision and makes the otherwise valid candidate impossible to
            // commit. reconcileSourceWindows runs before each admission, so
            // expired membership is still removed between generations.
            retainedTiles: new Set([...this.tiles.keys(), ...(requestedTiles || [])]) };
        hold.admits = (sequence, tileKey) => sequence <= hold.through
            || (!hold.sealed && hold.requestedTiles?.has(tileKey));
        const canHandoffDelivery = handoffDelivery === true;
        hold.handoffDelivery = false;
        if (!this.aborted) {
            // Install the successor before removing the closed generation's
            // barrier. Buffered route tiles may finish downloading while a
            // ground publication compiles, but their callbacks must always
            // belong to one finite generation. Without this atomic handoff,
            // the frame between release and the next admission delivered the
            // whole route-ahead buffer and repeatedly invalidated road design.
            this.deliveryHolds.add(hold);
            if (this.admissionBarrier) {
                this.deliveryHolds.delete(this.admissionBarrier);
                this.admissionBarrier = null;
            }
        }
        this.sourceHolds = [...this.deliveryHolds].filter(value => !value.barrier).length;
        let released = false;
        return { isReady: () => {
            const ready = this.aborted || (hold.pending === 0 && !hold.pendingTiles?.size);
            if (ready && !hold.sealed) {
                hold.sealed = true;
                this.requestScheduler.wake();
            }
            return ready;
        },
        request: () => {
            if (released || this.aborted || hold.sealed || !hold.pendingTiles?.size) return;
            for (const key of hold.pendingTiles) this.fetchTile(...key.split('_').map(Number));
            this.pumpFetchQueue();
        },
        armHandoff: () => {
            if (released || !canHandoffDelivery) return false;
            hold.handoffDelivery = true;
            return true;
        },
        release: () => {
            if (released) return false;
            released = true;
            this.deliveryHolds.delete(hold);
            if (!this.aborted && hold.handoffDelivery
                && ![...this.deliveryHolds].some(value => value.handoffDelivery)) {
                const barrier = {
                    barrier: true,
                    sealed: true,
                    requestedTiles: new Set(),
                    retainedTiles: new Set(),
                    admits: () => false,
                };
                this.admissionBarrier = barrier;
                this.deliveryHolds.add(barrier);
            }
            this.sourceHolds = [...this.deliveryHolds].filter(value => !value.barrier).length;
            this.requestScheduler.wake();
            return true;
        } };
    }

    retainTiles(tileKeys, { maxTiles } = {}) {
        if (this.aborted) throw new Error('Tile source is closed');
        if (!Array.isArray(tileKeys) || !Number.isSafeInteger(maxTiles) || maxTiles < 1
            || tileKeys.length > maxTiles || new Set(tileKeys).size !== tileKeys.length
            || tileKeys.some(key => typeof key !== 'string' || !/^-?\d+_-?\d+$/.test(key)
                || key.split('_').some(value => !Number.isSafeInteger(Number(value)))
                || key.split('_').map(Number).join('_') !== key)) {
            throw new TypeError('Tile dependencies require unique bounded integer keys');
        }
        const keys = [...tileKeys];
        let released = false;
        for (const key of keys) this.dependencyTileKeys.set(key, (this.dependencyTileKeys.get(key) || 0) + 1);
        const request = () => {
            if (released || this.aborted) return;
            for (const key of keys) this.fetchTile(...key.split('_').map(Number));
            this.pumpFetchQueue();
        };
        request();
        return { request, isCurrent: () => !released && !this.aborted,
            release: () => {
                if (released) return false;
                released = true;
                let releasedLastDependency = false;
                for (const key of keys) {
                    const count = this.dependencyTileKeys.get(key) || 0;
                    if (count > 1) this.dependencyTileKeys.set(key, count - 1);
                    else {
                        this.dependencyTileKeys.delete(key);
                        releasedLastDependency = true;
                    }
                }
                // A dependency can request tiles after the observer's last
                // eviction pass. Releasing it must wake cleanup even if the
                // observer then stays in the same tile indefinitely.
                if (releasedLastDependency && !this.aborted
                    && this.lastTx !== null && this.lastTz !== null) {
                    this.pendingEvictionCenter = { cx: this.lastTx, cz: this.lastTz };
                }
                return true;
            } };
    }

    abort() {
        this.aborted = true;
        this.sourceHolds = 0;
        this.deliveryHolds.clear(); this.admissionBarrier = null; this.pendingCallbacks.clear();
        this.dependencyTileKeys.clear();
        for (const entry of this.tiles.values()) {
            entry?.requestController?.abort?.(
                new DOMException('Tile source closed', 'AbortError'),
            );
        }
        this.tiles.clear();
        this.failed.clear();
        this.nextRetryAt = Infinity;
        this.consecutiveFetchFailures = 0;
        setSourceDegraded(this.healthToken, this.label, false);
        this.subscribers.clear();
        this.lastTx = null;
        this.lastTz = null;
        this.aheadTileKeys.clear();
        this.pinnedTileKeys.clear();
        this.lastPinnedSignature = null;
        this.aheadLeftAtMs.clear();
        this.lastAheadSignature = null;
        this.lastAheadCenterTx = null;
        this.lastAheadCenterTz = null;
        this.pendingAheadSignature = null;
        this.pendingAheadSince = 0;
        this.pendingAheadRequest = null;
        this.pendingEvictionCenter = null;
        this.nextEvictionAtMs = Infinity;
        this.lastPrioritySignature = null;
        this.unregisterActivity?.();
        this.unregisterActivity = null;
    }
}

export function createSharedTileSession({
    anchorLat,
    anchorLon,
    fetchController,
    requestTimeoutMs = TILE_REQUEST_TIMEOUT_MS,
    retryBaseMs = RETRY_BASE_MS,
    retryMaxMs = RETRY_MAX_MS,
    maxConcurrentRequests = NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT,
}) {
    const sources = new Map();
    const requestScheduler = createNetworkRequestScheduler({
        maxConcurrentRequests,
    });
    // Different consumers sometimes need independent tile retention (lane
    // paint reaches farther ahead than traffic), so they intentionally keep
    // separate source keys. They can still request the same URL during
    // startup. Share the in-flight fetch and JSON parse without coupling the
    // consumers' visible windows or eviction policy.
    const inflightRequests = new Map();
    const deliveryQueue = createFrameChunkQueue({
        label: 'tile-delivery',
        frameBudgetMs: 1,
        preferAnimationFrame: true,
        workClass: 'delivery',
        // This queue only parses and hands payloads to their owning layer.
        // Actual near-field readiness is owned by the road/build queues; outer
        // tile parsing must not keep the startup overlay open.
        trackWorldReady: false,
    });
    const orientationDeliveryQueue = createFrameChunkQueue({
        label: 'orientation-delivery',
        frameBudgetMs: 0.5,
        pauseDuringMovement: false,
        workClass: 'orientation',
        trackWorldReady: false,
    });
    const textDecodeQueue = createFrameChunkQueue({
        label: 'tile-json-decode',
        frameBudgetMs: 1,
        preferAnimationFrame: true,
        pauseDuringMovement: false,
        workClass: 'delivery',
        trackWorldReady: false,
    });
    const decoderIds = new WeakMap();
    let nextDecoderId = 1;
    const decoderIdentity = (decoder, prefix) => {
        if (typeof decoder !== 'function') return 'json';
        let id = decoderIds.get(decoder);
        if (!id) {
            id = nextDecoderId;
            nextDecoderId += 1;
            decoderIds.set(decoder, id);
        }
        return `${prefix}-${id}`;
    };
    const decodeTextCooperatively = (
        serialized,
        createTextDecodeTask,
        describe,
        request,
    ) => {
        const task = createTextDecodeTask(serialized);
        if (!task || typeof task.step !== 'function') {
            throw new TypeError('Cooperative text decoder must return a task with step()');
        }
        let decoded;
        const job = textDecodeQueue.enqueue([task], (activeTask) => {
            const outcome = activeTask.step();
            if (outcome?.done) {
                decoded = outcome.result;
                return undefined;
            }
            return FRAME_CHUNK_REPEAT_ITEM;
        }, {
            maxItemsPerFrame: 1,
            describeItem: describe ? () => describe : null,
        });
        request.decodeJob = job;
        return job.promise.then(({ cancelled }) => {
            if (cancelled) {
                throw new DOMException('Tile JSON decode cancelled', 'AbortError');
            }
            return decoded;
        }).finally(() => {
            if (request.decodeJob === job) request.decodeJob = null;
        });
    };
    // `describe` names the item in the fat-item report. The prod trace showed
    // `tile-delivery 288ms×86>50` — the WORST queue in the world by item count,
    // and completely anonymous: nothing said which source or which stage
    // (parse vs deliver) the 288 ms went on, so it was unactionable by
    // construction. Every deferWork caller knows both; make it say so.
    const deferWork = (work, allowDuringMovement = false, describe = '') => new Promise((resolve, reject) => {
        const queue = allowDuringMovement ? orientationDeliveryQueue : deliveryQueue;
        queue.enqueue([work], (run) => {
            try {
                const result = run();
                if (result === FRAME_CHUNK_DEFER_ITEM) return FRAME_CHUNK_DEFER_ITEM;
                Promise.resolve(result).then(resolve, reject);
            } catch (error) {
                reject(error);
            }
        }, {
            maxItemsPerFrame: 1,
            describeItem: describe ? () => describe : null,
            onCancel: () => reject(new DOMException('Tile delivery cancelled', 'AbortError')),
        });
    });
    const requestJson = (
        url,
        allowDuringMovement = false,
        decodeBody = null,
        createTextDecodeTask = null,
        consumerSignal = null,
    ) => {
        // The decoder is part of the identity: two sources asking for the same
        // URL with different decoders must not share one in-flight response.
        const decodeKey = decodeBody
            ? decoderIdentity(decodeBody, 'bin')
            : createTextDecodeTask
                ? decoderIdentity(createTextDecodeTask, 'chunked-json')
                : 'json';
        const requestKey = `${allowDuringMovement ? 'orientation' : 'full'}:${decodeKey}:${url}`;
        let request = inflightRequests.get(requestKey);
        if (request?.cancelled) {
            if (inflightRequests.get(requestKey) === request) inflightRequests.delete(requestKey);
            request = null;
        }
        if (!request) {
            const timeoutMs = Math.max(1, Number(requestTimeoutMs) || TILE_REQUEST_TIMEOUT_MS);
            const requestController = new AbortController();
            request = {
                controller: requestController,
                consumers: new Set(),
                settled: false,
                cancelled: false,
                decodeJob: null,
                promise: null,
            };
            let timedOut = false;
            const abortFromSession = () => requestController.abort(fetchController.signal.reason);
            if (fetchController.signal.aborted) abortFromSession();
            else fetchController.signal.addEventListener('abort', abortFromSession, { once: true });
            const timeoutId = setTimeout(() => {
                timedOut = true;
                requestController.abort(requestTimeoutError(url, timeoutMs));
            }, timeoutMs);
            // The timeout owns network transfer only. Once the complete body is
            // in memory, release its AbortController before the JSON parse waits
            // for a safe main-thread slice; otherwise a healthy large tile can
            // be aborted merely because nearer work was correctly allowed to
            // parse first.
            const bodyRequest = fetch(url, { signal: requestController.signal })
                .then(async (response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    if (decodeBody && typeof response.arrayBuffer === 'function') {
                        const bytes = await response.arrayBuffer();
                        noteWorldBuildProgress(`tile:${requestKey}`, bytes.byteLength, bytes.byteLength);
                        return { bytes };
                    }
                    if (typeof response.text === 'function') {
                        const serialized = await response.text();
                        // API tile JSON is overwhelmingly ASCII. String length
                        // is a zero-allocation decoded-size counter; encoding
                        // every large tile a second time just to count it would
                        // add startup allocation for sub-percent accuracy.
                        const byteLength = serialized.length;
                        noteWorldBuildProgress(`tile:${requestKey}`, byteLength, byteLength);
                        return { serialized };
                    }
                    // Node tests and small custom adapters may expose only json().
                    return { parsed: await response.json() };
                })
                .catch((error) => {
                    if (timedOut) throw requestTimeoutError(url, timeoutMs);
                    throw error;
                })
                .finally(() => {
                    clearTimeout(timeoutId);
                    fetchController.signal.removeEventListener('abort', abortFromSession);
                });
            request.promise = bodyRequest
                .then((body) => deferWork(
                    () => {
                        // All view windows that wanted this coalesced request
                        // moved away while its body/parse was pending. Do not
                        // spend a delivery slice decoding data nobody can see.
                        if (request.cancelled) {
                            throw new DOMException('Tile request no longer needed', 'AbortError');
                        }
                        if (Object.hasOwn(body, 'bytes')) return decodeBody(body.bytes);
                        if (!Object.hasOwn(body, 'serialized')) return body.parsed;
                        if (createTextDecodeTask) {
                            return decodeTextCooperatively(
                                body.serialized,
                                createTextDecodeTask,
                                `parse ${String(url).replace(/^[a-z]+:\/\/[^/]*/i, '').split('?')[0]}`,
                                request,
                            );
                        }
                        return JSON.parse(body.serialized);
                    },
                    allowDuringMovement,
                    // The path, not the whole URL: bbox coordinates would make
                    // every label unique and the report unreadable.
                    `parse ${String(url).replace(/^[a-z]+:\/\/[^/]*/i, '').split('?')[0]}`,
                ))
                .finally(() => {
                    request.settled = true;
                    if (inflightRequests.get(requestKey) === request) {
                        inflightRequests.delete(requestKey);
                    }
                });
            inflightRequests.set(requestKey, request);
        }
        if (!consumerSignal) return request.promise;

        // A source/tile holds one lease on a coalesced request. Moving away
        // rejects that source immediately (freeing its bounded request slot),
        // while the network transfer survives only if another visible source
        // still owns a lease for the same URL.
        return new Promise((resolve, reject) => {
            const consumer = {};
            let finished = false;
            const release = () => {
                consumerSignal.removeEventListener('abort', onAbort);
                request.consumers.delete(consumer);
                if (!request.settled && request.consumers.size === 0) {
                    request.cancelled = true;
                    if (inflightRequests.get(requestKey) === request) {
                        inflightRequests.delete(requestKey);
                    }
                    request.controller.abort(
                        new DOMException('Tile request no longer needed', 'AbortError'),
                    );
                    if (request.decodeJob) textDecodeQueue.cancel(request.decodeJob);
                }
            };
            const onAbort = () => {
                if (finished) return;
                finished = true;
                const reason = consumerSignal.reason instanceof Error
                    ? consumerSignal.reason
                    : new DOMException('Tile request cancelled', 'AbortError');
                release();
                reject(reason);
            };
            request.consumers.add(consumer);
            if (consumerSignal.aborted) {
                onAbort();
                return;
            }
            consumerSignal.addEventListener('abort', onAbort, { once: true });
            request.promise.then(
                (value) => {
                    if (finished) return;
                    finished = true;
                    release();
                    resolve(value);
                },
                (error) => {
                    if (finished) return;
                    finished = true;
                    release();
                    reject(error);
                },
            );
        });
    };
    return {
        getSource({
            key,
            label,
            url,
            parseFeatures,
            validatePayload,
            tileM,
            ring,
            keepRing,
            maxConcurrentRequests,
            startupPendingTileLimit,
            startupPriority,
            prioritizeByView = false,
            allowDuringMovement = false,
            decodeBody = null,
            createTextDecodeTask = null,
            loadPayload = null,
        }) {
            if (!key) throw new Error('SharedTileSession source key is required');
            let source = sources.get(key);
            if (!source) {
                source = new SharedTileSource({
                    anchorLat,
                    anchorLon,
                    fetchController,
                    label,
                    url,
                    requestJson,
                    deferWork,
                    decodeBody,
                    createTextDecodeTask,
                    loadPayload,
                    allowDuringMovement,
                    parseFeatures,
                    validatePayload,
                    retryBaseMs,
                    retryMaxMs,
                    tileM,
                    ring,
                    keepRing,
                    maxConcurrentRequests,
                    prioritizeByView,
                    startupPendingTileLimit,
                    startupPriority,
                    requestScheduler,
                });
                sources.set(key, source);
            }
            return source;
        },
        reconcileSourceWindows(keys) {
            if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) {
                throw new TypeError('Source reconciliation requires unique source keys');
            }
            const selected = keys.map(key => sources.get(key));
            if (selected.some(source => !source)) throw new TypeError('Source reconciliation requires existing sources');
            let ready = true;
            for (const source of selected) {
                if (source.lastTx === null || source.lastTz === null) continue;
                if (!source.evictOutsideRing(source.lastTx, source.lastTz)) ready = false;
            }
            return ready;
        },
        holdSources(keys, { drainQueued = false, drainRequested = false,
            requestedTileKeys = null, handoffDelivery = false, maxTiles } = {}) {
            if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) {
                throw new TypeError('Source holds require unique source keys');
            }
            const held = keys.map(key => sources.get(key));
            if (held.some(source => !source)) throw new TypeError('Source hold requires existing source keys');
            const leases = [];
            try {
                for (const source of held) leases.push(source.hold({
                    drainQueued, drainRequested, requestedTileKeys, handoffDelivery, maxTiles,
                }));
            } catch (error) { leases.forEach(lease => lease.release()); throw error; }
            let released = false;
            return { isReady: () => leases.every(lease => lease.isReady()),
                request: () => { if (!released) leases.forEach(lease => lease.request()); },
                armHandoff: () => { if (!released) leases.forEach(lease => lease.armHandoff?.()); },
                isCurrent: () => !released && held.every(source => !source.aborted),
                release() { if (released) return false; released = true; leases.forEach(lease => lease.release()); return true; } };
        },
        sourceKeys() {
            return sources.keys();
        },
        heldSourceDeliveries(keys) {
            if (!Array.isArray(keys)) throw new TypeError('Held delivery count requires source keys');
            let held = 0;
            for (const key of keys) held += sources.get(key)?.heldDeliveryCount() || 0;
            return held;
        },
        capturePrioritySourceTileKeys(sourceKey, options) {
            const source = sources.get(sourceKey);
            if (!source) throw new TypeError('Priority tile capture requires an existing source');
            return source.capturePriorityTileKeys(options);
        },
        retainSourceTiles(sourceKey, tileKeys, options) {
            const source = sources.get(sourceKey);
            if (!source) throw new TypeError('Tile dependencies require an existing source');
            return source.retainTiles(tileKeys, options);
        },
        getAuditCoverage(bounds, sourceKeys) {
            const coverage = [...sources].filter(([key]) => sourceKeys.includes(key))
                .map(([key, source]) => ({ key, ...auditSourceCoverage(source, bounds) }));
            return { sources: coverage,
                pending: coverage.reduce((sum, source) => sum + source.pending, 0),
                failed: coverage.reduce((sum, source) => sum + source.failed, 0) };
        },
        getDebugState() {
            return [...sources.entries()].map(([key, source]) => ({
                key,
                ...source.getDebugState(),
            }));
        },
        getInitialLoadState({ excludeLabels = [] } = {}) {
            let pending = 0, failed = 0, sourceCount = 0;
            const pendingSources = [];
            const excluded = new Set(Array.isArray(excludeLabels) ? excludeLabels.map(String) : []);
            for (const [key, source] of sources) {
                // The low-detail fog horizon remains optional for reveal.
                if (source.label === 'far-buildings' || excluded.has(source.label)) continue;
                const counts = source.getInitialLoadCounts();
                if (counts.tracked === 0) continue;
                sourceCount++; pending += counts.pending; failed += counts.failed;
                if (counts.pending > 0 || counts.failed > 0) pendingSources.push({
                    key,
                    label: source.label,
                    pending: counts.pending,
                    failed: counts.failed,
                });
            }
            return {
                ready: pending === 0 && failed === 0,
                pending,
                failed,
                sourceCount,
                pendingSources,
            };
        },
        getNetworkDebugState() {
            return requestScheduler.getDebugState();
        },
        scheduleNetworkRequest({
            label,
            groupKey,
            groupLimit,
            supportLane,
            priority,
            signal,
            run,
        } = {}) {
            return requestScheduler.schedule({
                label,
                groupKey,
                groupLimit,
                supportLane,
                priority,
                signal,
                run,
            });
        },
        abort() {
            for (const source of sources.values()) source.sourceHolds = 0;
            deliveryQueue.dispose();
            orientationDeliveryQueue.dispose();
            textDecodeQueue.dispose();
            for (const source of sources.values()) source.abort();
            sources.clear();
            requestScheduler.dispose(
                new DOMException('Shared tile session closed', 'AbortError'),
            );
            inflightRequests.clear();
        },
    };
}
