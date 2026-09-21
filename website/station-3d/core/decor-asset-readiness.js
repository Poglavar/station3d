// Pure lifecycle bookkeeping for asynchronously loaded decor assets.
export function createDecorAssetReadiness(allowedKinds) {
    if (!Array.isArray(allowedKinds) || !allowedKinds.length
        || allowedKinds.some(kind => typeof kind !== 'string' || !kind)) {
        throw new TypeError('Decor asset kinds must be a finite list');
    }
    const kinds = new Set(allowedKinds);
    if (kinds.size !== allowedKinds.length) throw new TypeError('Decor asset kinds must be unique');

    const states = new Map();
    let epoch = 0;
    let sequence = 0;
    const checkKind = kind => {
        if (!kinds.has(kind)) throw new RangeError(`Unknown decor asset kind: ${kind}`);
    };
    const currentPending = ticket => ticket
        && ticket.epoch === epoch
        && states.get(ticket.kind)?.ticket === ticket
        && states.get(ticket.kind)?.status === 'pending';
    const begin = kind => {
        checkKind(kind);
        const ticket = Object.freeze({ kind, epoch, sequence: ++sequence });
        states.set(kind, { ticket, status: 'pending', error: null });
        return ticket;
    };
    const complete = (ticket, { empty = false } = {}) => {
        if (!currentPending(ticket)) return false;
        if (typeof empty !== 'boolean') throw new TypeError('empty must be boolean');
        states.set(ticket.kind, { ticket, status: empty ? 'empty' : 'published', error: null });
        return true;
    };
    const fail = (ticket, error) => {
        if (!currentPending(ticket)) return false;
        states.set(ticket.kind, {
            ticket,
            status: 'failed',
            error: error == null ? 'unknown failure' : String(error),
        });
        return true;
    };
    const snapshot = () => {
        const assets = [...states.entries()].map(([kind, state]) => Object.freeze({
            kind,
            status: state.status,
            ...(state.status === 'failed' ? { error: state.error } : {}),
        }));
        const count = status => assets.filter(asset => asset.status === status).length;
        return Object.freeze({
            expected: states.size,
            pending: count('pending'),
            published: count('published'),
            empty: count('empty'),
            failed: count('failed'),
            assets: Object.freeze(assets),
        });
    };
    const reset = () => {
        epoch += 1;
        states.clear();
        return true;
    };
    return Object.freeze({ begin, complete, fail, snapshot, reset });
}
