// Coalesces repeated streamed-tile invalidations into one active build and one
// latest-generation follow-up, while preserving per-request acknowledgements.

export function createTileBuildGenerationController({ startBuild } = {}) {
    const states = new Map();

    function finishWaiters(state, generation, error = null, cancelled = false) {
        const settled = state.waiters.filter(waiter => waiter.generation <= generation);
        state.waiters = state.waiters.filter(waiter => waiter.generation > generation);
        for (const waiter of settled) {
            if (error) waiter.reject(error);
            else waiter.resolve({ cancelled, generation });
        }
    }

    function launch(state) {
        if (state.running || state.cancelled) return;
        state.running = true;
        const generation = state.desiredGeneration;
        state.runningGeneration = generation;
        let handle;
        try {
            handle = typeof startBuild === 'function'
                ? startBuild(
                    state.tileKey,
                    generation,
                    () => !state.cancelled && state.desiredGeneration === generation,
                )
                : null;
        } catch (error) {
            state.running = false;
            finishWaiters(state, generation, error);
            if (state.desiredGeneration > generation) launch(state);
            else states.delete(state.tileKey);
            return;
        }
        const promise = handle?.promise || handle || Promise.resolve();
        state.handle = handle;
        Promise.resolve(promise).then(
            () => {
                if (state.cancelled) return;
                state.running = false;
                state.handle = null;
                finishWaiters(state, generation);
                if (state.desiredGeneration > generation) launch(state);
                else states.delete(state.tileKey);
            },
            (error) => {
                if (state.cancelled) return;
                state.running = false;
                state.handle = null;
                finishWaiters(state, generation, error);
                if (state.desiredGeneration > generation) launch(state);
                else states.delete(state.tileKey);
            },
        );
    }

    function request(tileKey) {
        const key = String(tileKey);
        let state = states.get(key);
        if (!state) {
            state = {
                tileKey: key,
                desiredGeneration: 0,
                runningGeneration: 0,
                running: false,
                cancelled: false,
                handle: null,
                waiters: [],
            };
            states.set(key, state);
        }
        state.desiredGeneration += 1;
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        promise.catch(() => {});
        state.waiters.push({
            generation: state.desiredGeneration,
            resolve,
            reject,
        });
        launch(state);
        return promise;
    }

    function cancel(tileKey) {
        const key = String(tileKey);
        const state = states.get(key);
        if (!state) return;
        state.cancelled = true;
        if (typeof state.handle?.cancel === 'function') state.handle.cancel();
        finishWaiters(state, Infinity, null, true);
        states.delete(key);
    }

    function clear() {
        for (const tileKey of [...states.keys()]) cancel(tileKey);
    }

    function snapshot() {
        return [...states.values()].map(state => ({
            tileKey: state.tileKey,
            desiredGeneration: state.desiredGeneration,
            runningGeneration: state.runningGeneration,
            running: state.running,
            followUpPending: state.desiredGeneration > state.runningGeneration,
            waitingRequests: state.waiters.length,
        }));
    }

    return {
        request,
        cancel,
        clear,
        snapshot,
    };
}
