// A single preparation slot and a durable successor obligation. Incoming
// evidence never cancels useful captured work; it is consumed by the next pass.
// The injected scheduler advances one compiler step at a time. Only the shared
// pre-controller boundary may change the visible/query/physics generation.
import { createSurfaceRebuildLedger } from './surface-rebuild-ledger.js';
import { logStamp } from './log-stamp.js';

const validBounds = b => b && ['minX', 'minZ', 'maxX', 'maxZ'].every(k => Number.isFinite(b[k]))
    && b.minX < b.maxX && b.minZ < b.maxZ;
const errorCode = error => String(error?.details?.details?.code || error?.details?.code || error?.code || '');
const errorCodes = error => [error?.code, error?.details?.code, error?.details?.details?.code]
    .filter(Boolean).map(String).join(' ');
const capacityFailure = error => /capacity|budget|limit/.test(errorCodes(error));
const transientFailure = error => /busy|stale/.test(errorCode(error));
// A source that is still streaming: retry only when a source revision arrives,
// like an unavailable one, but count and report nothing — every permanent gap
// is already a skip in its own layer (core/terrain-evidence-gap.js), so what
// remains "incomplete" is terrain the next revision brings. Split's port
// (2026-09-16): the bridge ramp 469508851 was logged as a failed generation
// on every teleport until its 20 m cells loaded a second later.
const sourceFailure = error => /unavailable/.test(errorCode(error));
const streamingFailure = error => /incomplete/.test(errorCode(error));
const MAX_PREPARATION_PHASES = 256;

// The timing table's key for a compiler label. Labels carry progress counters
// (`sample 12/300`), tile keys (`-1_3`, `0_-2`), OSM and object ids
// (`osm-29704919`, `osm:way:12`, `object 65021`) and other per-item detail;
// keyed raw, a generation overflowed the table and 30,000 steps (3 of 6 s)
// vanished into `other` (Split, 2026-09-17). Strip counters and ids, keep the
// first two `:` segments. Pure so the normalisation can be tested.
export function preparationPhaseKey(phase) {
    return String(phase || 'prepare')
        .replace(/\s.*$/, '')
        .replace(/:(?:-?\d+_-?\d+|osm[:-]?(?:way|node|rel)?[:-]?\d+|\d+)(?=:|$)/g, '')
        .replace(/-?\d+_-?\d+/g, '#')
        .replace(/osm[:-]?(?:way|node|rel)?[:-]?\d+/g, 'osm#')
        .replace(/:\d.*$/, '')
        .split(':').slice(0, 2).join(':').slice(0, 160) || 'prepare';
}

function preparationRow(item, phase) {
    // Compiler labels may contain progress counters. Keep a fixed-size timing
    // table, not one retained record per source vertex or generation visit.
    let key = preparationPhaseKey(phase);
    if (!item.phaseTimings.has(key) && item.phaseTimings.size >= MAX_PREPARATION_PHASES) key = 'other';
    let row = item.phaseTimings.get(key);
    if (!row) item.phaseTimings.set(key, row = { phase: key, steps: 0, cpuMs: 0, maxStepMs: 0, waitMs: 0, schedulerMs: 0 });
    return row;
}

function recordPreparationVisit(item, phase, elapsedMs) {
    const row = preparationRow(item, phase);
    const ms = Math.max(0, elapsedMs);
    row.steps++; row.cpuMs += ms; row.maxStepMs = Math.max(row.maxStepMs, ms);
    item.preparationCpuMs += ms; item.preparationSteps++;
}

// A generation's wall time is mostly waiting (gen 6 after a 900 m move at
// Split: 2.8 s CPU, 3.7 s readiness, 5.5 s scheduler, 2026-09-17), so each
// wait is charged to the phase that yielded it, not only to the totals.
function recordSchedulerGap(item, now) {
    if (item.waiting || item.visitEndedAt == null) return;
    preparationRow(item, item.phase).schedulerMs += Math.max(0, now() - item.visitEndedAt);
}

function preparationTiming(item) {
    return Object.freeze({ cpuMs: item.preparationCpuMs, steps: item.preparationSteps,
        readinessWaitMs: item.readinessWaitMs,
        schedulerWaitMs: item.preparedAt == null ? null
            : Math.max(0, item.preparedAt - item.startedAt - item.preparationCpuMs - item.readinessWaitMs),
        phases: Object.freeze([...item.phaseTimings.values()].sort((a, b) => b.cpuMs - a.cpuMs)
            .map(row => Object.freeze({ ...row }))) });
}

export function createGroundGenerationCoordinator({ queue, repeat, defer, wait = defer, registry, boundary,
    prepareSteps, admit = () => ({}), isCurrent = () => true, now = () => performance.now(), retryMs = 500,
    maxChanges = 4096, windowMoveM = 0, priorityFamilies = [], preemptForPriority = false,
    deferNonPriority = () => false,
    onPublished = () => {},
    onError = error => console.error(logStamp(), '[ground:generation]', error) }) {
    if (!queue?.enqueue || !queue?.cancel || !registry?.prepareBatch || !boundary?.enqueue
        || typeof prepareSteps !== 'function' || typeof admit !== 'function' || !Number.isSafeInteger(maxChanges) || maxChanges < 1
        || !Number.isFinite(retryMs) || retryMs <= 0
        || !Number.isFinite(windowMoveM) || windowMoveM < 0
        || !Array.isArray(priorityFamilies) || priorityFamilies.some(value => typeof value !== 'string' || !value)
        || typeof deferNonPriority !== 'function' || typeof onPublished !== 'function') {
        throw new TypeError('Invalid ground coordinator');
    }
    const ledger = createSurfaceRebuildLedger(), changes = new Map();
    const priority = new Set(priorityFamilies);
    let revision = 0, generation = 0, active = null, closed = false, retryAt = 0;
    let published = 0, rejected = 0, preempted = 0, failed = 0, lastError = null, failedRevision = null;
    let blockedKind = null, lastPublication = null, lastFailure = null, lastRejection = null;
    let local = Object.freeze({ x: 0, z: 0 });
    let requestedWindow = null;
    function finishReadinessWait(item) {
        if (item.waitStartedAt == null) return;
        const waitedMs = Math.max(0, now() - item.waitStartedAt);
        item.readinessWaitMs += waitedMs;
        preparationRow(item, item.phase).waitMs += waitedMs;
        item.waitStartedAt = null; item.waiting = false; item.visitEndedAt = now();
    }
    function report(error) {
        try { onError(error); }
        catch (failure) {
            lastError = { ...lastError, reportingError: String(failure?.message || failure) };
        }
    }

    function rememberFailure(item) {
        lastFailure = Object.freeze({ ...lastError, generation: item.generation,
            phase: lastError?.phase || item.phase,
            preparation: preparationTiming(item),
            families: Object.freeze(item.changes.map(change => change.family)) });
    }

    function invalidate(family, { bounds = [], keys = [], full = false, reason = family } = {}) {
        if (closed) return false;
        if (typeof family !== 'string' || !family || !Array.isArray(bounds) || !Array.isArray(keys)
            || bounds.some(b => !validBounds(b)) || keys.some(key => typeof key !== 'string')) {
            throw new TypeError('Ground invalidation requires explicit source keys/bounds');
        }
        const previous = changes.get(family);
        const next = { full: full || previous?.full || false, reason: String(reason),
            bounds: new Map(previous?.bounds), keys: new Set(previous?.keys) };
        for (const b of bounds) next.bounds.set(`${b.minX},${b.minZ},${b.maxX},${b.maxZ}`, Object.freeze({ ...b }));
        for (const key of keys) next.keys.add(key);
        // A finite full-source obligation replaces an excessive change list;
        // preparation still has to admit the complete closure within its caps.
        if (next.full || next.bounds.size + next.keys.size > maxChanges) {
            next.full = true; next.bounds.clear(); next.keys.clear();
        }
        changes.set(family, next);
        ledger.mark(family, ++revision);
        retryAt = 0;
        return true;
    }

    function restore(item) {
        for (const change of item.changes) {
            const pending = changes.get(change.family);
            if (!pending) changes.set(change.family, { full: change.full, reason: change.reason,
                bounds: new Map(change.bounds.map(b => [`${b.minX},${b.minZ},${b.maxX},${b.maxZ}`, b])),
                keys: new Set(change.keys) });
            else {
                for (const b of change.bounds) pending.bounds.set(`${b.minX},${b.minZ},${b.maxX},${b.maxZ}`, b);
                for (const key of change.keys) pending.keys.add(key);
                pending.full ||= change.full;
                if (pending.full || pending.bounds.size + pending.keys.size > maxChanges) {
                    pending.full = true; pending.bounds.clear(); pending.keys.clear();
                }
            }
            ledger.settled(change.family, change.revision);
        }
    }

    function settle(item, error = null, result = null, rejectionReason = null) {
        if (item.settled) return;
        item.settled = true;
        finishReadinessWait(item);
        const success = result?.status?.startsWith('published');
        try {
            const cleanupErrors = [];
            const attempt = callback => { try { callback?.(); } catch (failure) { cleanupErrors.push(failure); } };
            attempt(() => item.steps?.return?.()); item.steps = null;
            if (success) {
                published++;
                lastPublication = Object.freeze({ generation: item.generation,
                    families: Object.freeze(item.changes.map(change => change.family)),
                    preparationMs: item.preparedAt - item.startedAt,
                    publicationWaitMs: now() - item.preparedAt,
                    preparation: preparationTiming(item),
                    elapsedMs: now() - item.startedAt, status: result.status,
                    usage: item.candidate.usage || null });
                try { onPublished(lastPublication); }
                catch (error) { report(error); }
                for (const change of item.changes) ledger.publish(change.family, change.revision);
                lastError = null; failedRevision = null; blockedKind = null;
                if (result.finalizationError || result.status === 'published-with-retirement-error') {
                    failed++;
                    lastError = { code: 'ground-generation-finalization',
                        message: String(result.finalizationError || 'Published ground resources failed to retire') };
                    rememberFailure(item);
                }
            } else {
                attempt(() => item.ticket?.cancel('ground-generation-cancelled'));
                attempt(() => { if (item.batch?.state === 'staged') item.batch.discard('ground-generation-cancelled'); });
                attempt(() => item.candidate?.discard());
                restore(item);
                if (item.preempting) preempted++;
                else {
                    rejected++; retryAt = now() + retryMs;
                    lastRejection = Object.freeze({ generation: item.generation,
                        reason: rejectionReason || (error ? 'error' : 'cancelled'),
                        phase: item.phase,
                        families: Object.freeze(item.changes.map(change => change.family)),
                        preparation: preparationTiming(item) });
                }
                if (error) {
                    lastError = { code: errorCode(error) || 'ground-generation-error', message: String(error.message || error), phase: item.phase };
                    if (error?.details && typeof error.details === 'object') lastError.details = error.details;
                    const terrainStorage = error?.details?.terrainStorage || error?.details?.details?.terrainStorage;
                    if (terrainStorage) lastError.terrainStorage = terrainStorage;
                    const terrainCutout = error?.details?.terrainCutout || error?.details?.details?.terrainCutout;
                    if (terrainCutout) lastError.terrainCutout = terrainCutout;
                    if (capacityFailure(error) || sourceFailure(error) || streamingFailure(error)) {
                        failedRevision = Math.max(...item.changes.map(change => change.revision));
                        blockedKind = capacityFailure(error) ? 'capacity' : 'source';
                    }
                    if (!transientFailure(error) && !streamingFailure(error)) {
                        if (!capacityFailure(error) && !sourceFailure(error)) {
                            failedRevision = Math.max(...item.changes.map(change => change.revision));
                            blockedKind = 'failure';
                        }
                        failed++;
                        rememberFailure(item);
                        report(error);
                    }
                }
            }
            attempt(() => item.admission?.release?.());
            if (cleanupErrors.length) {
                failed++;
                lastError = { code: 'ground-generation-cleanup', message: cleanupErrors.map(value => String(value?.message || value)).join('; ') };
                rememberFailure(item);
                if (!success) {
                    failedRevision = Math.max(...item.changes.map(change => change.revision));
                    blockedKind = 'failure';
                }
                report(new AggregateError(cleanupErrors, lastError.message));
            }
        } finally { if (active === item) active = null; }
    }

    function advance(item) {
        if (item.settled) return;
        if (closed || !isCurrent()) { settle(item); return; }
        if (item.waiting) return wait;
        if (!item.candidate) {
            recordSchedulerGap(item, now);
            const visitStartedAt = now();
            let next;
            try { next = item.steps.next(); }
            finally {
                // This is main-thread compiler time. Shader/network waits and
                // time spent waiting for a frame budget are excluded.
                recordPreparationVisit(item, next?.done ? 'candidate-ready' : next?.value?.phase || item.phase,
                    now() - visitStartedAt);
                item.visitEndedAt = now();
            }
            if (!next.done) {
                item.phase = next.value?.phase || 'prepare';
                if (next.value?.ready) {
                    item.waiting = true; item.waitStartedAt = now();
                    Promise.resolve(next.value.ready).then(() => { finishReadinessWait(item); }, error => {
                        finishReadinessWait(item); if (!item.settled) settle(item, error);
                    });
                }
                return item.waiting || next.value?.waitingForDependency === true
                    ? wait : next.value?.deferFrame ? defer : repeat;
            }
            item.steps = null; item.candidate = next.value; item.preparedAt = now();
            if (!item.candidate) { settle(item, null, null, 'candidate-missing'); return; }
            if (!item.candidate.isCurrent()) { settle(item, null, null, 'candidate-stale'); return; }
            item.batch = registry.prepareBatch(item.candidate.entries, {
                isCurrent: item.candidate.isCurrent,
                withValidationScope: item.candidate.withValidationScope,
            });
            if (item.batch.state !== 'staged') { settle(item, null, null, `batch-${item.batch.state}`); return; }
        }
        item.phase = 'publication-slot';
        item.ticket = boundary.enqueue(item.batch, { onPublished: () => {
            if (item.candidate.finalize() === false) throw new Error('Published ground generation did not finalize');
        } });
        if (!item.ticket) return defer;
        item.ticket.promise.then(result => settle(item, null, result,
            result?.status?.startsWith('published') ? null : `boundary-${result?.status || 'unknown'}`),
        error => settle(item, error));
    }

    function step(item) {
        // Busy/stale admission is normal backpressure. Settle it here so the
        // queue does not log a second error for every expected retry. The
        // coordinator reports deterministic failures and retains their cause.
        try { return advance(item); }
        catch (error) { settle(item, error); }
    }

    return Object.freeze({
        invalidate,
        // Source admission, queued publication and retained successor work all
        // belong to initial loading, even between scheduled compiler jobs.
        isSettled: () => !closed && published > 0 && !active && !changes.size && !ledger.size,
        onFrame(position) {
            if (closed) return;
            if (Number.isFinite(position?.x) && Number.isFinite(position?.z)) {
                local = Object.freeze({ x: position.x, z: position.z });
                if (windowMoveM > 0 && (!requestedWindow
                    || Math.hypot(local.x - requestedWindow.x, local.z - requestedWindow.z) >= windowMoveM)) {
                    // A changed window is new input, even when an earlier one
                    // failed. Anchor to the last request, not publication, so a
                    // stationary failed job cannot generate a retry every frame.
                    if (requestedWindow) invalidate('ground-window');
                    requestedWindow = local;
                }
            }
            const priorityPending = published > 0 && [...changes.keys()].some(family => priority.has(family));
            // A long physical closure may safely retain the currently published
            // world, but it must not prevent the small successor that keeps the
            // terrain residency window under a moving player. Cancel only while
            // preparation is private; a staged boundary publication is allowed
            // to finish atomically.
            if (preemptForPriority && priorityPending && active && !active.ticket
                && active.changes.some(change => !priority.has(change.family))) {
                active.preempting = true;
                try { queue.cancel(active.job); } catch (error) { report(error); }
            }
            if (closed || active || !changes.size || now() < retryAt || failedRevision === revision || !isCurrent()) return;
            const selectedFamilies = published > 0
                ? [...changes.keys()].filter(family => priority.has(family)) : [];
            if (!selectedFamilies.length && deferNonPriority(position)) return;
            // A source owner may first drain a fixed set of queued callbacks.
            // Capture the change ledger only after that admission seals: those
            // callbacks belong to this generation, not a redundant successor.
            let admission = null, admissionError = null;
            const selectedChanges = selectedFamilies.map(family => [family, changes.get(family)]);
            try { admission = admit({ local, isCurrent: () => !closed && isCurrent(),
                changes: selectedChanges.map(([family, change]) => ({ family, ...change })) }); }
            catch (error) { admissionError = error; }
            if (!admission && !admissionError) return;
            const capturedEntries = selectedFamilies.length ? selectedChanges : [...changes];
            const captured = Object.freeze(capturedEntries.map(([family, change]) => Object.freeze({ family,
                revision: ledger.requested(family), full: change.full, reason: change.reason,
                bounds: Object.freeze([...change.bounds.values()]), keys: Object.freeze([...change.keys]) })));
            if (selectedFamilies.length) for (const family of selectedFamilies) changes.delete(family);
            else changes.clear();
            const item = { changes: captured, generation: ++generation, settled: false, phase: 'admission',
                admission,
                startedAt: now(), preparedAt: null,
                preparationCpuMs: 0, preparationSteps: 0, phaseTimings: new Map(),
                readinessWaitMs: 0, waitStartedAt: null, visitEndedAt: null,
                candidate: null, batch: null, ticket: null, steps: null, waiting: false };
            active = item;
            try {
                if (admissionError) throw admissionError;
                item.steps = prepareSteps({ admission, changes: captured, local, generation: item.generation,
                    isCurrent: () => !closed && active === item && !item.settled && isCurrent() });
                item.job = queue.enqueue([item], step, {
                    onCancel: () => settle(item), onError: error => settle(item, error),
                    // Compiler yields range from one index to one time-sliced
                    // geometry operation. Use the queue's millisecond deadline;
                    // a 64-visit cap wasted the budget on trivial index work.
                    describeItem: () => item.phase, priority: 1e12,
                });
            } catch (error) { settle(item, error); }
        },
        close() {
            if (closed) return;
            closed = true;
            const item = active;
            try {
                if (item) { try { queue.cancel(item.job); } catch (error) { report(error); } finally { settle(item); } }
            } finally { changes.clear(); ledger.clear(); }
        },
        snapshot: () => ({ closed, pending: ledger.size, preparing: active && !active.ticket ? 1 : 0,
            waitingPublication: active?.ticket ? 1 : 0, generation, published, rejected, failed,
            phase: active?.phase || null,
            activeFamilies: active ? active.changes.map(change => change.family) : [],
            lastError, lastFailure, lastPublication, lastRejection, preempted,
            preparationCpuMs: active?.preparationCpuMs || 0, preparationSteps: active?.preparationSteps || 0,
            priorityPending: [...changes.keys()].some(family => priority.has(family)),
            capacityBlocked: failedRevision === revision && blockedKind === 'capacity',
            sourceBlocked: failedRevision === revision && blockedKind === 'source',
            failureBlocked: failedRevision === revision && blockedKind === 'failure' }),
    });
}
