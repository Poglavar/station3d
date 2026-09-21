// Lightweight registry for the dev FPS overlay to report asynchronous world
// loading/build work without coupling the renderer to individual layers.

const readers = new Set();

export function registerBackgroundActivityReader(reader) {
    if (typeof reader !== 'function') return () => {};
    readers.add(reader);
    return () => readers.delete(reader);
}

export function getBackgroundActivitySnapshot({ includeIdle = false } = {}) {
    const aggregated = new Map();
    for (const reader of readers) {
        let entry;
        try {
            entry = reader();
        } catch (_error) {
            continue;
        }
        if (!entry?.label) continue;
        const kind = ['load', 'build', 'stream', 'layer'].includes(entry.kind)
            ? entry.kind
            : 'build';
        const key = `${kind}:${entry.label}`;
        const previous = aggregated.get(key) || { kind, label: String(entry.label) };
        for (const field of [
            'pending',
            'jobs',
            'loaded',
            'fetching',
            'building',
            'retrying',
            'fetchFailed',
            'buildFailed',
            'failed',
        ]) {
            previous[field] = (previous[field] || 0)
                + Math.max(0, Number(entry?.[field]) || 0);
        }
        for (const field of ['support', 'visible', 'peripheral', 'hidden', 'unknown']) {
            if (entry?.[field] == null) continue;
            previous[field] = (previous[field] || 0)
                + Math.max(0, Number(entry[field]) || 0);
        }
        for (const field of [
            'activeOwners',
            'staleRejected',
            'conflicts',
            'missingClaims',
            'invalidClaims',
        ]) {
            if (entry?.[field] == null) continue;
            previous[field] = (previous[field] || 0)
                + Math.max(0, Number(entry[field]) || 0);
        }
        if (entry?.oldestVisibleWaitMs != null) {
            previous.oldestVisibleWaitMs = Math.max(
                previous.oldestVisibleWaitMs || 0,
                Math.max(0, Number(entry.oldestVisibleWaitMs) || 0),
            );
        }
        aggregated.set(key, previous);
    }
    return [...aggregated.values()]
        .filter(entry => (
            entry.pending > 0
            || entry.retrying > 0
            || entry.fetchFailed > 0
            || entry.buildFailed > 0
            || entry.failed > 0
            || (entry.conflicts || 0) > 0
            || (entry.missingClaims || 0) > 0
            || (entry.invalidClaims || 0) > 0
            || (entry.staleRejected || 0) > 0
            || (entry.activeOwners || 0) > 0
            || (includeIdle && entry.kind === 'stream' && entry.loaded > 0)
            || (includeIdle && entry.kind === 'layer' && entry.loaded > 0)
        ))
        .sort((a, b) => {
            const aProblems = a.failed + a.fetchFailed + a.buildFailed + a.retrying
                + (a.conflicts || 0) + (a.missingClaims || 0) + (a.invalidClaims || 0);
            const bProblems = b.failed + b.fetchFailed + b.buildFailed + b.retrying
                + (b.conflicts || 0) + (b.missingClaims || 0) + (b.invalidClaims || 0);
            return bProblems - aProblems
                || b.pending - a.pending
                || a.label.localeCompare(b.label);
        });
}
