// Who may open a checkpoint link. A player may re-enter any checkpoint their
// saved run has already reached; jumping ahead is a debugging act, allowed on
// a local host or with ?campaignDebug=1. Pure: the bootstrap turns the answer
// into a director call and a toast.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function checkpointSkipAllowed({ hostname = '', search = '' } = {}) {
    if (LOCAL_HOSTS.has(String(hostname || '').toLowerCase())) return true;
    return new URLSearchParams(String(search || '')).get('campaignDebug') === '1';
}

// `order` is the story order of linkable checkpoint ids. Returns what to do:
// - checkpoint: open the requested checkpoint (resume or reseed);
// - continue: the run has not reached it, keep the player where they are;
// - start: no run yet, and the link points past the beginning.
export function resolveCheckpointStart({ requestedId, order = [], savedCheckpointId = null, savedCompleted = false, allowSkip = false } = {}) {
    const requested = order.indexOf(requestedId);
    if (requested === -1) return { action: 'checkpoint', reason: 'unknown-order' };
    if (allowSkip || savedCompleted) return { action: 'checkpoint', reason: allowSkip ? 'debug' : 'completed' };
    const reached = order.indexOf(savedCheckpointId);
    if (reached === -1) {
        return requested === 0
            ? { action: 'checkpoint', reason: 'beginning' }
            : { action: 'start', reason: 'not-reached' };
    }
    if (requested <= reached) return { action: 'checkpoint', reason: 'reached' };
    return { action: 'continue', reason: 'not-reached' };
}
