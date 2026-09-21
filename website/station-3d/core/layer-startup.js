// Retry coordinator for independent Station3D session layers. It keeps one
// failed layer from aborting later starts and retries without timer-based waits.

const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 20000;

function retryDelayMs(attempts, baseMs, maxMs) {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

export function createLayerStartupCoordinator({
    begin,
    cleanup = null,
    isCurrent = () => true,
    onActive = null,
    onFailure = null,
    onRecovery = null,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
} = {}) {
    if (typeof begin !== 'function') {
        throw new Error('Layer startup coordinator requires a begin(entry) function');
    }
    const states = new Map();
    let disposed = false;

    function stateFor(entry) {
        let state = states.get(entry);
        if (!state) {
            state = {
                status: 'idle',
                attempts: 0,
                nextTryAt: Infinity,
                error: null,
                promise: null,
            };
            states.set(entry, state);
        }
        return state;
    }

    async function start(entry) {
        if (disposed || !entry || !isCurrent()) return false;
        const state = stateFor(entry);
        if (state.status === 'active') return true;
        if (state.status === 'starting' && state.promise) return state.promise;

        const recovering = state.status === 'failed';
        state.status = 'starting';
        state.attempts += 1;
        state.error = null;
        state.nextTryAt = Infinity;
        state.promise = (async () => {
            try {
                await begin(entry);
                if (disposed || !isCurrent()) {
                    if (typeof cleanup === 'function') {
                        try {
                            await cleanup(entry);
                        } catch (cleanupError) {
                            console.error(
                                '[LayerStartup] late-layer cleanup failed:',
                                cleanupError,
                            );
                        }
                    }
                    return false;
                }
                state.status = 'active';
                state.error = null;
                state.nextTryAt = Infinity;
                if (typeof onActive === 'function') onActive(entry, state);
                if (recovering && typeof onRecovery === 'function') {
                    onRecovery(entry, state);
                }
                return true;
            } catch (error) {
                if (typeof cleanup === 'function') {
                    try {
                        await cleanup(entry, error);
                    } catch (cleanupError) {
                        console.error(
                            '[LayerStartup] failed-layer cleanup failed:',
                            cleanupError,
                        );
                    }
                }
                if (disposed || !isCurrent()) return false;
                state.status = 'failed';
                state.error = error;
                state.nextTryAt = now() + retryDelayMs(
                    state.attempts,
                    Math.max(1, Number(retryBaseMs) || DEFAULT_RETRY_BASE_MS),
                    Math.max(1, Number(retryMaxMs) || DEFAULT_RETRY_MAX_MS),
                );
                if (typeof onFailure === 'function') onFailure(entry, error, state);
                return false;
            } finally {
                state.promise = null;
            }
        })();
        return state.promise;
    }

    function tick() {
        if (disposed || !isCurrent()) return;
        const currentTime = now();
        for (const [entry, state] of states) {
            if (state.status !== 'failed' || currentTime < state.nextTryAt) continue;
            void start(entry);
        }
    }

    function getSnapshot() {
        const snapshot = {
            loaded: 0,
            pending: 0,
            retrying: 0,
            failed: 0,
        };
        for (const state of states.values()) {
            if (state.status === 'active') snapshot.loaded += 1;
            else if (state.status === 'starting') snapshot.pending += 1;
            else if (state.status === 'failed') {
                snapshot.retrying += 1;
                snapshot.failed += 1;
            }
        }
        return snapshot;
    }

    function getState(entry) {
        const state = states.get(entry);
        return state ? { ...state, promise: undefined } : null;
    }

    function dispose() {
        disposed = true;
        states.clear();
    }

    return {
        start,
        tick,
        getSnapshot,
        getState,
        dispose,
    };
}
