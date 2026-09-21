// The world candidate owns geometry/source leases; a consumer owns only its
// current bounded window. Recentring retries that window without destroying
// the prepared world. At most one window/read/allocation is retained at once.
export function* prepareGroundConsumerSteps({ capture, prepareReadSteps, isCurrent }) {
    if (![capture, prepareReadSteps, isCurrent].every(value => typeof value === 'function')) {
        throw new TypeError('Ground consumer preparation requires explicit capture and validity');
    }
    while (isCurrent()) {
        const region = capture();
        if (!region) { yield { phase: 'ground-consumer-admission', deferFrame: true }; continue; }
        let read = null, prepared = null, handedOff = false, settled = false;
        const regionCurrent = () => !settled && isCurrent() && region.isCurrent();
        const current = () => regionCurrent() && (!read || read.isCurrent());
        const release = () => {
            const errors = [];
            for (const value of [read, region]) {
                try { value?.release?.(); } catch (error) { errors.push(error); }
            }
            if (errors.length) throw new AggregateError(errors, 'Ground consumer release failed');
        };
        const discard = () => {
            if (settled) return false;
            settled = true;
            try { prepared?.entry.discard(); } finally { release(); }
            return true;
        };
        try {
            if (!region.empty) {
                read = yield* prepareReadSteps(region, regionCurrent);
                if (regionCurrent() && !read) throw Object.assign(new Error('Ground consumer read could not be prepared'),
                    { code: 'ground-consumer-unavailable' });
                if (current()) {
                    prepared = yield* region.prepareSteps(read.reads, current);
                    if (current() && !prepared) throw Object.assign(new Error('Ground consumer support could not be prepared'),
                        { code: 'ground-consumer-unavailable' });
                }
            }
            if (current()) {
                handedOff = true;
                return Object.freeze({ entry: prepared?.entry || null,
                    isCurrent: () => current() && (!prepared || prepared.entry.isCurrent()), discard,
                    finalize() {
                        if (settled) return false;
                        settled = true;
                        try { return prepared ? prepared.finalize() : true; }
                        finally { release(); }
                    },
                });
            }
        } finally {
            if (!handedOff) discard();
        }
        // No spin between expired consumer attempts; ordinary recentering
        // gets the next frame before this candidate tries to join it again.
        yield { phase: 'ground-consumer-recapture', deferFrame: true };
    }
    return null;
}
