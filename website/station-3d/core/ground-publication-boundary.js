// One complete prepared ground group waits for the shared controller boundary.
// Builders own their preparation budgets; this slot prevents ready groups from
// piling up and publishes at most one per frame. It performs no geometry work.
export function createGroundPublicationBoundary({ now = () => performance.now() } = {}) {
    let pending = null;
    let closed = false;
    let publishing = false;
    let published = 0, failed = 0, cancelled = 0;
    let lastCommitMs = 0, maxCommitMs = 0, lastError = null;

    function enqueue(batch, { onPublished = null } = {}) {
        if (closed || pending || publishing) return null;
        if (batch?.state !== 'staged' || typeof batch.publish !== 'function'
            || typeof batch.discard !== 'function') {
            throw new TypeError('Ground publication requires a staged surface batch');
        }
        if (onPublished !== null && typeof onPublished !== 'function') {
            throw new TypeError('Ground publication finalizer must be a function');
        }
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const item = { batch, resolve, reject, onPublished };
        pending = item;
        return Object.freeze({
            promise,
            cancel(reason = 'cancelled') {
                if (pending !== item) return false;
                pending = null;
                try {
                    if (batch.state === 'staged') batch.discard(reason);
                    cancelled++;
                    resolve(Object.freeze({ status: reason }));
                } catch (error) {
                    failed++;
                    lastError = String(error?.message || error);
                    reject(error);
                }
                return true;
            },
        });
    }

    function publishReady() {
        if (closed || publishing || !pending) return false;
        const item = pending;
        pending = null;
        publishing = true;
        const started = now();
        try {
            // A session close or producer cancellation can settle a ticket
            // before this frame. Never invoke a settled batch a second time.
            let result = item.batch.state === 'staged'
                ? item.batch.publish() : Object.freeze({ status: item.batch.state });
            if (result.status === 'published' || result.status === 'published-with-retirement-error') {
                published++;
                // Physics acknowledgements/retirement must finish before this
                // call returns to cabStep, not in a later Promise microtask.
                try {
                    const value = item.onPublished?.(result);
                    if (value?.then) throw new TypeError('Ground publication finalization must be synchronous');
                } catch (error) {
                    // Publication already succeeded. Rejecting this Promise
                    // would invite callers to discard the now-active resources.
                    failed++; lastError = String(error?.message || error);
                    console.error('[ground:publish] Published group finalization failed', error);
                    result = Object.freeze({ ...result, status: 'published-with-finalization-error',
                        finalizationError: lastError });
                }
            } else cancelled++;
            item.resolve(result);
        } catch (error) {
            failed++;
            lastError = String(error?.message || error);
            item.reject(error);
        } finally {
            lastCommitMs = Math.max(0, now() - started);
            maxCommitMs = Math.max(maxCommitMs, lastCommitMs);
            publishing = false;
        }
        return true;
    }

    return Object.freeze({
        // Allocation-free stamp for controller caches. It advances inside
        // publishReady, before any support query can run in the same frame.
        get revision() { return published; },
        enqueue,
        publishReady,
        close() {
            if (closed) return;
            closed = true;
            const item = pending;
            pending = null;
            if (!item) return;
            try {
                if (item.batch.state === 'staged') item.batch.discard('ground-session-closed');
                cancelled++;
                item.resolve(Object.freeze({ status: 'ground-session-closed' }));
            } catch (error) { failed++; lastError = String(error?.message || error); item.reject(error); }
        },
        snapshot: () => Object.freeze({ pending: pending ? 1 : 0, publishing, closed,
            published, failed, cancelled, lastCommitMs, maxCommitMs, lastError }),
    });
}
