// Drives a resumable build iterator one semantic stage at a time and keeps
// publication atomic: staged output is either published once or discarded.

function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function phaseDescriptor(value) {
    if (typeof value === 'string') return { phase: value, metadata: null };
    if (value && typeof value === 'object') {
        return {
            phase: String(value.phase || 'stage'),
            metadata: value,
        };
    }
    return { phase: 'stage', metadata: null };
}

export function createCooperativeBuildTask({
    iterator,
    publish = value => value,
    discard = () => {},
    onPhase = null,
    now = defaultNow,
} = {}) {
    let source = null;
    let stagedValue;
    let readyToPublish = false;
    let done = false;
    let cancelled = false;
    let discarded = false;
    let result;

    function ensureIterator() {
        if (source) return source;
        source = typeof iterator === 'function' ? iterator() : iterator;
        if (!source || typeof source.next !== 'function') {
            throw new TypeError('Cooperative build task requires an iterator');
        }
        return source;
    }

    function reportPhase(phase, startedAtMs, metadata = null) {
        const ms = Math.max(0, Number(now()) - startedAtMs);
        if (typeof onPhase === 'function') onPhase({ phase, ms, metadata });
    }

    function discardOnce(reason = null) {
        if (discarded) return;
        discarded = true;
        discard(stagedValue, reason);
    }

    function step() {
        if (done) return { done: true, cancelled, result };
        if (readyToPublish) {
            const startedAtMs = Number(now());
            try {
                result = publish(stagedValue);
            } catch (error) {
                done = true;
                discardOnce(error);
                reportPhase('publish', startedAtMs);
                throw error;
            }
            done = true;
            reportPhase('publish', startedAtMs);
            return { done: true, cancelled: false, result, phase: 'publish' };
        }

        const startedAtMs = Number(now());
        let next;
        try {
            next = ensureIterator().next();
        } catch (error) {
            done = true;
            discardOnce(error);
            reportPhase('failed-stage', startedAtMs);
            throw error;
        }
        if (next.done) {
            stagedValue = next.value;
            readyToPublish = true;
            reportPhase('ready-to-publish', startedAtMs);
            return {
                done: false,
                readyToPublish: true,
                phase: 'ready-to-publish',
                metadata: null,
            };
        }
        const descriptor = phaseDescriptor(next.value);
        reportPhase(descriptor.phase, startedAtMs, descriptor.metadata);
        return {
            done: false,
            readyToPublish: false,
            phase: descriptor.phase,
            metadata: descriptor.metadata,
        };
    }

    function cancel(reason = null) {
        if (done) return;
        cancelled = true;
        done = true;
        try {
            if (source && typeof source.return === 'function') source.return();
        } finally {
            discardOnce(reason);
        }
    }

    function snapshot() {
        return {
            done,
            cancelled,
            readyToPublish,
            discarded,
            result,
        };
    }

    return {
        step,
        cancel,
        snapshot,
    };
}
