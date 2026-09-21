// Session-wide network arbiter for streamed Station3D data. It applies one
// concurrency ceiling across sources while preserving each source's own cap.

import { finiteOrNull } from './math.js';

// The local/API data origin is HTTP/1.1, for which Chromium exposes six
// connections per origin. Scheduling more here starts their timeout clocks
// while they are still hidden in the browser's socket queue, and large terrain
// or building bodies can make otherwise healthy requests expire there. Match
// the transport ceiling so our visible/support priority order owns the queue.
const DEFAULT_MAX_CONCURRENT = 6;

const PRIORITY_TIER_RANKS = Object.freeze({
    critical: 5,
    support: 4,
    visible: 3,
    peripheral: 2,
    hidden: 1,
    background: 0,
    unknown: 0,
});

const TIER_SCORE_STRIDE = 1e12;
const MAX_AGE_SCORE = TIER_SCORE_STRIDE * 0.45;
const AGE_SCORE_PER_MS = MAX_AGE_SCORE / 15000;

function abortError(reason = null) {
    if (reason instanceof Error) return reason;
    return new DOMException('Network request cancelled', 'AbortError');
}

function finiteNumber(value, fallback = 0) {
    return finiteOrNull(value) ?? fallback;
}

function normalizePriority(value) {
    const priority = value && typeof value === 'object' ? value : {};
    const tier = Object.hasOwn(PRIORITY_TIER_RANKS, priority.tier)
        ? priority.tier
        : 'unknown';
    const explicitTierRank = finiteOrNull(priority.tierRank);
    const tierRank = explicitTierRank ?? PRIORITY_TIER_RANKS[tier];
    const explicitScore = finiteOrNull(priority.score);
    const score = explicitScore
        ?? tierRank * TIER_SCORE_STRIDE - finiteNumber(priority.distanceSq, 0);
    return {
        ...priority,
        tier,
        tierRank,
        score,
    };
}

export function createNetworkRequestScheduler({
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT,
    now = () => Date.now(),
    schedulePump = (run) => queueMicrotask(run),
} = {}) {
    const maxConcurrent = Math.max(
        1,
        Math.floor(finiteNumber(maxConcurrentRequests, DEFAULT_MAX_CONCURRENT)),
    );
    const pending = [];
    const activeByGroup = new Map();
    let activeCount = 0;
    let supportOverflowActive = 0;
    let nextSequence = 0;
    let pumpScheduled = false;
    let disposed = false;

    function groupActiveCount(groupKey) {
        return activeByGroup.get(groupKey) || 0;
    }

    function groupHasCapacity(job) {
        return groupActiveCount(job.groupKey) < job.groupLimit;
    }

    function globalHasCapacity(job) {
        if (activeCount < maxConcurrent) return true;
        // One support request may exceed the ordinary cap. This is a bounded
        // dependency lane, not general priority: a terrain cell must be able
        // to resolve road/building compilers that currently own every normal
        // slot, while a second support request still waits.
        return job.supportLane && supportOverflowActive < 1;
    }

    function removePending(job) {
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
    }

    function releaseAbortListener(job) {
        job.signal?.removeEventListener?.('abort', job.onAbort);
    }

    function effectiveScore(job, timestamp) {
        let priority;
        try {
            priority = normalizePriority(
                typeof job.priority === 'function' ? job.priority() : job.priority,
            );
        } catch (_error) {
            priority = normalizePriority(null);
        }
        const ageMs = Math.max(0, timestamp - job.queuedAtMs);
        return {
            priority,
            score: priority.score + Math.min(MAX_AGE_SCORE, ageMs * AGE_SCORE_PER_MS),
        };
    }

    function nextRunnableJob() {
        const timestamp = now();
        let best = null;
        for (const job of pending) {
            if (job.state !== 'queued'
                || !groupHasCapacity(job)
                || !globalHasCapacity(job)
                || (job.canStart && !job.canStart())) continue;
            const ranked = effectiveScore(job, timestamp);
            if (!best
                || ranked.score > best.score
                || (ranked.score === best.score && job.sequence < best.job.sequence)) {
                best = { job, ...ranked };
            }
        }
        return best?.job || null;
    }

    function scheduleNextPump() {
        if (pumpScheduled || disposed) return;
        pumpScheduled = true;
        schedulePump(() => {
            pumpScheduled = false;
            pump();
        });
    }

    function finish(job) {
        releaseAbortListener(job);
        activeCount = Math.max(0, activeCount - 1);
        if (job.usingSupportOverflow) {
            supportOverflowActive = Math.max(0, supportOverflowActive - 1);
        }
        const groupCount = Math.max(0, groupActiveCount(job.groupKey) - 1);
        if (groupCount === 0) activeByGroup.delete(job.groupKey);
        else activeByGroup.set(job.groupKey, groupCount);
        scheduleNextPump();
    }

    function start(job) {
        removePending(job);
        if (job.signal?.aborted) {
            job.state = 'cancelled';
            releaseAbortListener(job);
            job.reject(abortError(job.signal.reason));
            return;
        }
        job.state = 'running';
        job.usingSupportOverflow = activeCount >= maxConcurrent && job.supportLane;
        if (job.usingSupportOverflow) supportOverflowActive += 1;
        activeCount += 1;
        activeByGroup.set(job.groupKey, groupActiveCount(job.groupKey) + 1);
        let result;
        try {
            // Start the chosen job synchronously inside this pump. Its returned
            // promise governs when the slot is released, so callers must keep
            // response-body consumption inside run(), not only fetch headers.
            result = job.run();
        } catch (error) {
            result = Promise.reject(error);
        }
        Promise.resolve(result)
            .then(job.resolve, job.reject)
            .finally(() => {
                job.state = 'finished';
                finish(job);
            });
    }

    function pump() {
        if (disposed) return;
        while (true) {
            const job = nextRunnableJob();
            if (!job) break;
            start(job);
        }
    }

    function schedule({
        label = 'network-request',
        groupKey = 'default',
        groupLimit = Infinity,
        supportLane = false,
        priority = null,
        signal = null,
        canStart = null,
        run,
    } = {}) {
        if (typeof run !== 'function') {
            return Promise.reject(new TypeError('network request scheduler requires run()'));
        }
        if (canStart !== null && typeof canStart !== 'function') {
            return Promise.reject(new TypeError('Network admission must be a synchronous predicate'));
        }
        if (disposed || signal?.aborted) {
            return Promise.reject(abortError(signal?.reason));
        }
        const explicitGroupLimit = finiteOrNull(groupLimit);
        const safeGroupLimit = explicitGroupLimit != null
            ? Math.max(1, Math.floor(explicitGroupLimit))
            : Infinity;
        const job = {
            label: String(label || 'network-request'),
            groupKey,
            groupLimit: safeGroupLimit,
            supportLane: supportLane === true,
            usingSupportOverflow: false,
            priority,
            signal,
            canStart,
            run,
            sequence: nextSequence++,
            queuedAtMs: now(),
            state: 'queued',
            onAbort: null,
            resolve: null,
            reject: null,
        };
        const promise = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        job.onAbort = () => {
            if (job.state !== 'queued') return;
            job.state = 'cancelled';
            removePending(job);
            releaseAbortListener(job);
            job.reject(abortError(signal?.reason));
            scheduleNextPump();
        };
        signal?.addEventListener?.('abort', job.onAbort, { once: true });
        pending.push(job);
        // Defer the first pump by one microtask. Layer startup registers several
        // sources synchronously; choosing after that fan-out lets the arbiter
        // compare them instead of letting the first source fill every slot.
        scheduleNextPump();
        return promise;
    }

    function getDebugState() {
        const timestamp = now();
        const queuedByTier = {};
        let oldestQueuedMs = 0;
        for (const job of pending) {
            if (job.state !== 'queued') continue;
            const { priority } = effectiveScore(job, timestamp);
            queuedByTier[priority.tier] = (queuedByTier[priority.tier] || 0) + 1;
            oldestQueuedMs = Math.max(oldestQueuedMs, timestamp - job.queuedAtMs);
        }
        return {
            active: activeCount,
            supportOverflowActive,
            queued: pending.filter(job => job.state === 'queued').length,
            maxConcurrentRequests: maxConcurrent,
            queuedByTier,
            oldestQueuedMs: Math.max(0, oldestQueuedMs),
        };
    }

    function dispose(reason = null) {
        if (disposed) return;
        disposed = true;
        const error = abortError(reason);
        for (const job of pending.splice(0)) {
            if (job.state !== 'queued') continue;
            job.state = 'cancelled';
            releaseAbortListener(job);
            job.reject(error);
        }
    }

    return Object.freeze({
        schedule,
        // A consumer's bounded delivery buffer can free capacity without a
        // network request finishing. Reconsider it in the ordinary priority
        // pump; never reserve a socket while waiting for consumer capacity.
        wake: scheduleNextPump,
        flush: pump,
        getDebugState,
        dispose,
    });
}

export const NETWORK_REQUEST_DEFAULT_MAX_CONCURRENT = DEFAULT_MAX_CONCURRENT;
export const NETWORK_REQUEST_PRIORITY_TIER_RANKS = PRIORITY_TIER_RANKS;
