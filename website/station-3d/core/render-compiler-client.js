// One module-Worker client for all packet compilers in a Station3D session.
// It owns stale-result rejection, cancellation, one crash restart, packet
// validation, and exactly-once disposal. There is intentionally no sync path.

import { createRenderPacketValidationTask } from './render-packet.js';
import { createFrameChunkQueue, FRAME_CHUNK_REPEAT_ITEM } from './frame-chunk-queue.js';

export class RenderCompilerClientError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'RenderCompilerClientError';
        this.code = code;
        this.details = details;
    }
}

function workerError(error, fallback = 'Render compiler Worker failed') {
    const message = error?.message || error?.error?.message || fallback;
    return new RenderCompilerClientError('worker-crashed', message);
}

function tileRequestKey(request) {
    const tile = request?.tile || {};
    return request?.requestKey || [
        request?.compilerId,
        tile.matrix,
        tile.z,
        tile.x,
        tile.y,
    ].join(':');
}

function defaultWorkerFactory(url) {
    if (typeof Worker !== 'function') {
        throw new RenderCompilerClientError(
            'worker-unavailable',
            'Module Workers are unavailable; render compilation cannot continue',
        );
    }
    return new Worker(url, { type: 'module', name: 'station3d-render-compiler' });
}

function listen(worker, type, listener) {
    if (typeof worker.addEventListener === 'function') {
        worker.addEventListener(type, listener);
        return () => worker.removeEventListener?.(type, listener);
    }
    worker[`on${type}`] = listener;
    return () => {
        if (worker[`on${type}`] === listener) worker[`on${type}`] = null;
    };
}

export function createRenderCompilerClient({
    workerUrl,
    workerFactory = defaultWorkerFactory,
    maxRestarts = 1,
    maxInFlight = 1,
    onFailure = null,
} = {}) {
    if (!workerUrl) throw new TypeError('Render compiler Worker URL is required');
    const stateMessages = new Map();
    const pending = new Map();
    const activeJobIds = new Set();
    const latestGenerationByKey = new Map();
    const concurrency = Math.max(1, Math.trunc(Number(maxInFlight)) || 1);
    let worker = null;
    let workerListenerDisposers = [];
    let nextJobId = 1;
    let nextStateGeneration = 1;
    let restartCount = 0;
    let disposed = false;
    let terminateCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let staleCount = 0;
    let malformedCount = 0;
    let crashCount = 0;
    let failureCount = 0;
    let lastFailure = null;
    let validationQueue = null;

    const cancelValidation = (job) => {
        validationQueue?.cancel(job.validationJob);
        job.validationJob = null;
        job.validationTask?.dispose();
        job.validationTask = null;
    };

    const reportFailure = (error) => {
        failureCount += 1;
        lastFailure = {
            code: error?.code || 'render-compiler-failed',
            message: String(error?.message || error || 'Render compiler failed'),
        };
        onFailure?.(error);
    };

    const rejectJob = (job, error, { pump = true } = {}) => {
        if (!job || job.settled) return;
        job.settled = true;
        cancelValidation(job);
        pending.delete(job.id);
        activeJobIds.delete(job.id);
        job.reject(error);
        if (pump && !disposed) pumpJobs();
    };

    const cancelStatePreparation = (entry) => {
        const attempt = entry?.attempt;
        if (entry) entry.attempt = null;
        attempt?.controller.abort();
    };

    const settleState = (entry, error = null) => {
        if (!entry || entry.settled) return;
        entry.settled = true;
        if (error) entry.reject(error);
        else entry.resolve(entry.ready);
        entry.resolve = entry.reject = null;
    };

    const rejectStateJobs = (stateId, error, predicate = () => true) => {
        for (const job of [...pending.values()]) {
            if (job.resultReceived || !Object.hasOwn(job.requiredStates, stateId)
                || !predicate(job.requiredStates[stateId])) continue;
            // The Worker may already be compiling it; its eventual transferred
            // result is ignored. A queued request never reaches the wrong state.
            rejectJob(job, error, { pump: false });
        }
    };

    const failState = (stateId, entry, error) => {
        cancelStatePreparation(entry);
        entry.ready = false;
        entry.error = error;
        settleState(entry, error);
        rejectStateJobs(stateId, error);
        reportFailure(error);
        pumpJobs();
    };

    const postState = (stateId, entry) => {
        if (disposed || !worker || stateMessages.get(stateId) !== entry) return;
        cancelStatePreparation(entry);
        entry.error = null;
        entry.ready = false;
        // Large state owns a replayable preparation function, not a second
        // retained copy of buffers that postMessage transfers away. Its caller
        // schedules the preparation through the layer's existing frame queue.
        const sourceWorker = worker;
        const attempt = { controller: new AbortController(), generation: nextStateGeneration++ };
        entry.attempt = attempt;
        const isCurrent = () => !disposed && worker === sourceWorker
            && stateMessages.get(stateId) === entry && entry.attempt === attempt;
        const failed = (error) => {
            if (!isCurrent()) return;
            failState(stateId, entry, new RenderCompilerClientError(
                'state-preparation-failed',
                `Worker state ${stateId}: ${error?.message || error}`,
            ));
        };
        const send = (message) => {
            if (!isCurrent()) return;
            sourceWorker.postMessage({ type: 'state', stateId,
                stateGeneration: attempt.generation, stateRevision: entry.revision,
                payload: message.payload }, message.transferables || []);
            // Readiness follows the Worker's matching acknowledgement, not
            // merely a successful send or completion of an obsolete attempt.
        };
        try {
            if (typeof entry.source === 'function') {
                Promise.resolve(entry.source({ signal: attempt.controller.signal })).then(send).catch(failed);
            } else send({ payload: entry.source });
        } catch (error) { failed(error); }
    };

    const postJob = (job) => {
        worker.postMessage({ type: 'compile', jobId: job.id, request: job.request });
        job.posted = true;
        job.resultReceived = false;
        activeJobIds.add(job.id);
    };

    function pumpJobs() {
        if (disposed || !worker) return;
        while (activeJobIds.size < concurrency) {
            const next = [...pending.values()]
                .filter(job => !job.settled && !job.posted
                    && Object.entries(job.requiredStates).every(([stateId, revision]) => {
                        const state = stateMessages.get(stateId);
                        return state?.ready && state.revision === revision && !state.error;
                    }))
                .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
            if (!next) return;
            try {
                postJob(next);
            } catch (error) {
                reportFailure(error);
                rejectJob(next, error, { pump: false });
            }
        }
    }

    const terminateWorker = () => {
        for (const entry of stateMessages.values()) {
            entry.ready = false;
            cancelStatePreparation(entry);
        }
        if (!worker) return;
        const terminatingWorker = worker;
        const listenerDisposers = workerListenerDisposers;
        workerListenerDisposers = [];
        for (const disposeListener of listenerDisposers) disposeListener();
        try { terminatingWorker.terminate?.(); } finally {
            worker = null;
            terminateCount += 1;
        }
    };

    const handleMessage = (event, sourceWorker) => {
        if (sourceWorker !== worker) return;
        const message = event?.data || event;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'state-error' || message.type === 'state-ready') {
            const entry = stateMessages.get(message.stateId);
            if (!entry?.attempt || entry.attempt.generation !== message.stateGeneration) return;
            if (message.type === 'state-error' || message.stateRevision !== entry.revision) {
                failState(message.stateId, entry, new RenderCompilerClientError(
                    'state-rejected',
                    message.error?.message || `Worker accepted an unexpected revision of ${message.stateId}`,
                    message.error || null,
                ));
            } else {
                entry.attempt = null;
                entry.ready = true;
                settleState(entry);
                pumpJobs();
            }
            return;
        }
        const job = pending.get(message.jobId);
        if (!job || job.settled) return;
        if (message.type === 'error') {
            const error = new RenderCompilerClientError(
                'compiler-failed',
                message.error?.message || 'Render packet compiler failed',
                message.error || null,
            );
            reportFailure(error);
            rejectJob(job, error);
            return;
        }
        if (message.type !== 'result') return;
        job.resultReceived = true;
        // The Worker has finished this job. Packet validation is deliberately
        // cooperative main-thread work and must not keep the single Worker
        // slot occupied; otherwise a serial terrain generation leaves the
        // Worker idle for every validation slice between adjacent tiles.
        activeJobIds.delete(job.id);
        const latest = latestGenerationByKey.get(job.requestKey);
        if (latest !== job.request.generation) {
            staleCount += 1;
            rejectJob(job, new RenderCompilerClientError(
                'stale-result',
                `Rejected stale render packet generation ${job.request.generation}`,
            ));
            return;
        }
        if (job.validationTask) return; // Duplicate Worker result, not another scan.
        const malformedPacket = (error) => {
            if (job.settled) return;
            malformedCount += 1;
            const malformed = new RenderCompilerClientError(
                'malformed-packet',
                error?.message || 'Render compiler returned a malformed packet',
                { causeCode: error?.code || null },
            );
            reportFailure(malformed);
            rejectJob(job, malformed);
        };
        try {
            const validation = createRenderPacketValidationTask(message.packet, {
                compilerId: job.request.compilerId,
                compilerVersion: job.request.compilerVersion,
                sourceRevision: job.request.sourceRevision,
                generation: job.request.generation,
                tile: job.request.tile,
            });
            job.validationTask = validation;
            job.validationJob = validationQueue.enqueue([job.id], () => {
                try {
                    return validation.step() ? undefined : FRAME_CHUNK_REPEAT_ITEM;
                } catch (error) {
                    malformedPacket(error);
                    return undefined;
                }
            }, {
                priority: job.priority,
                describeItem: () => `${job.requestKey}:validate:${validation.progress().checkedRecords}`,
                onComplete: () => {
                    if (job.settled || job.validationTask !== validation) return;
                    const packet = validation.result();
                    validation.dispose();
                    job.validationTask = null;
                    job.validationJob = null;
                    job.settled = true;
                    pending.delete(job.id);
                    activeJobIds.delete(job.id);
                    completedCount += 1;
                    job.resolve(packet);
                    pumpJobs();
                },
            });
            pumpJobs();
        } catch (error) {
            malformedPacket(error);
        }
    };

    const handleCrash = (event, sourceWorker) => {
        if (disposed || sourceWorker !== worker) return;
        crashCount += 1;
        const error = workerError(event);
        // Transferred results belong to the main-thread validator now. A later
        // Worker crash must neither discard them nor compile them a second time.
        const workerJobs = [...pending.values()].filter(job => !job.resultReceived);
        const activeBeforeCrash = new Set(workerJobs.filter(job => job.posted).map(job => job.id));
        for (const job of workerJobs) {
            activeJobIds.delete(job.id);
            job.posted = false;
        }
        terminateWorker();
        if (restartCount >= Math.max(0, Number(maxRestarts) || 0)) {
            for (const entry of stateMessages.values()) settleState(entry, error);
            for (const job of workerJobs) rejectJob(job, error, { pump: false });
            reportFailure(error);
            return;
        }
        restartCount += 1;
        try {
            startWorker();
            for (const job of pending.values()) {
                if (!activeBeforeCrash.has(job.id)) continue;
                if (job.retries >= 1) {
                    rejectJob(job, new RenderCompilerClientError(
                        'retry-exhausted',
                        `Render compiler retry exhausted for ${job.requestKey}`,
                    ), { pump: false });
                    continue;
                }
                job.retries += 1;
            }
            for (const [stateId, entry] of stateMessages) postState(stateId, entry);
            pumpJobs();
        } catch (restartError) {
            for (const entry of stateMessages.values()) settleState(entry, restartError);
            for (const job of workerJobs) {
                rejectJob(job, restartError, { pump: false });
            }
            reportFailure(restartError);
        }
    };

    function startWorker() {
        if (disposed) {
            throw new RenderCompilerClientError('client-disposed', 'Render compiler client is disposed');
        }
        const startedWorker = workerFactory(workerUrl);
        if (!startedWorker || typeof startedWorker.postMessage !== 'function') {
            worker = null;
            throw new RenderCompilerClientError('invalid-worker', 'Worker factory returned no Worker');
        }
        worker = startedWorker;
        workerListenerDisposers = [
            listen(startedWorker, 'message', event => handleMessage(event, startedWorker)),
            listen(startedWorker, 'error', event => handleCrash(event, startedWorker)),
            listen(startedWorker, 'messageerror', event => handleCrash(event, startedWorker)),
        ];
    }

    startWorker();
    validationQueue = createFrameChunkQueue({
        label: 'render-packet-validation',
        frameBudgetMs: 2,
        stationaryReservationMs: 2,
        pauseDuringMovement: false,
        preferAnimationFrame: true,
        workClass: 'delivery',
    });

    function setState(stateIdValue, source, { revision = null } = {}) {
        if (disposed) {
            throw new RenderCompilerClientError('client-disposed', 'Render compiler client is disposed');
        }
        const stateId = String(stateIdValue || '').trim();
        if (!stateId) throw new TypeError('Worker state id is required');
        if (!worker) throw workerError(lastFailure);
        const previous = stateMessages.get(stateId);
        cancelStatePreparation(previous);
        if (previous) { previous.ready = false; settleState(previous); }
        const entry = { source, revision, attempt: null, error: null, ready: false, settled: false };
        entry.completion = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        stateMessages.set(stateId, entry);
        rejectStateJobs(stateId, new RenderCompilerClientError(
            'state-superseded', `Worker state ${stateId} changed revision`,
        ), requiredRevision => requiredRevision !== revision);
        postState(stateId, entry);
        pumpJobs();
        return entry.completion;
    }

    function clearState(stateIdValue) {
        const stateId = String(stateIdValue || '').trim();
        const entry = stateMessages.get(stateId);
        if (!stateMessages.delete(stateId)) return false;
        cancelStatePreparation(entry);
        entry.ready = false;
        settleState(entry);
        rejectStateJobs(stateId, new RenderCompilerClientError('state-cleared', `Worker state ${stateId} was cleared`));
        worker?.postMessage({ type: 'clear-state', stateId });
        pumpJobs();
        return true;
    }

    function compile(request) {
        if (disposed) {
            throw new RenderCompilerClientError('client-disposed', 'Render compiler client is disposed');
        }
        if (!worker) throw workerError(lastFailure);
        if (!request || typeof request !== 'object') throw new TypeError('Compiler request is required');
        const requiredStates = { ...request.requiredStates };
        for (const [stateId, revision] of Object.entries(requiredStates)) {
            const state = stateMessages.get(stateId);
            if (!state) throw new RenderCompilerClientError('state-unavailable', `Worker state ${stateId} is unavailable`);
            if (state.revision !== revision) {
                throw new RenderCompilerClientError('state-superseded', `Worker state ${stateId} changed revision`);
            }
            if (state.error) throw state.error;
        }
        const generation = Number(request.generation);
        if (!Number.isInteger(generation) || generation < 0) {
            throw new TypeError('Compiler request generation must be a non-negative integer');
        }
        const requestKey = tileRequestKey(request);
        const latest = latestGenerationByKey.get(requestKey);
        if (latest != null && generation < latest) {
            throw new RenderCompilerClientError(
                'stale-request',
                `Compiler request ${generation} is older than ${latest}`,
            );
        }
        latestGenerationByKey.set(requestKey, generation);
        for (const older of [...pending.values()]) {
            if (older.requestKey !== requestKey || older.request.generation > generation) continue;
            cancelledCount += 1;
            if (older.posted && !older.resultReceived) worker?.postMessage?.({ type: 'cancel', jobId: older.id });
            rejectJob(older, new RenderCompilerClientError(
                'superseded',
                `Render compiler job ${older.id} was superseded`,
            ), { pump: false });
        }

        const id = nextJobId++;
        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const job = {
            id,
            request: { ...request, generation, requiredStates },
            requiredStates,
            requestKey,
            priority: Number(request.priority) || 0,
            retries: 0,
            posted: false,
            settled: false,
            resolve: resolvePromise,
            reject: rejectPromise,
        };
        pending.set(id, job);
        pumpJobs();
        return Object.freeze({
            jobId: id,
            promise,
            cancel(reason = 'cancelled') {
                if (job.settled) return false;
                cancelledCount += 1;
                if (job.posted && !job.resultReceived) worker?.postMessage?.({ type: 'cancel', jobId: id });
                rejectJob(job, new RenderCompilerClientError('cancelled', String(reason)));
                return true;
            },
        });
    }

    function snapshot() {
        return Object.freeze({
            disposed,
            pendingJobs: pending.size,
            validatingJobs: [...pending.values()].filter(job => !!job.validationTask).length,
            activeJobs: activeJobIds.size,
            queuedJobs: Math.max(0, pending.size - activeJobIds.size),
            maxInFlight: concurrency,
            stateCount: stateMessages.size,
            preparingStates: [...stateMessages.values()].filter(entry => !!entry.attempt).length,
            restartCount,
            crashCount,
            terminateCount,
            completedCount,
            cancelledCount,
            staleCount,
            malformedCount,
            failureCount,
            lastFailure,
        });
    }

    function dispose(reason = 'session-ended') {
        if (disposed) return false;
        disposed = true;
        for (const job of [...pending.values()]) {
            rejectJob(
                job,
                new RenderCompilerClientError('client-disposed', String(reason)),
                { pump: false },
            );
        }
        activeJobIds.clear();
        for (const entry of stateMessages.values()) {
            cancelStatePreparation(entry);
            entry.ready = false;
            settleState(entry);
        }
        stateMessages.clear();
        latestGenerationByKey.clear();
        validationQueue.dispose();
        terminateWorker();
        return true;
    }

    return Object.freeze({ setState, clearState, compile, snapshot, dispose });
}
