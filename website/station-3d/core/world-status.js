// Reduces the FPS overlay's background-activity entries — the fetching and building of the
// objects the 3D world is made of — to a single traffic-light state for the cab HUD.
//
// Pure on purpose: the overlay prints these counters as text, and the dot has to agree with it,
// so the rule that decides "still loading" lives here and is unit-tested rather than being
// re-derived inside a render loop.
//
// Note a snapshot being NON-EMPTY does not mean work is outstanding: getBackgroundActivitySnapshot
// keeps 'stream' and 'layer' entries around while they merely report `loaded` counts. Only the
// in-progress and failure counters decide the state.

const count = (value) => Math.max(0, Number(value) || 0);

export const WORLD_STATUS_COLORS = {
    loading: '#f59f00',   // amber — objects still being fetched or built
    ready:   '#37b24d',   // green — background caught up
    failed:  '#e03131',   // red — nothing outstanding, but something never arrived
};

export function computeWorldStatus(entries) {
    let pending = 0;
    let retrying = 0;
    let failed = 0;

    for (const entry of entries || []) {
        pending += count(entry?.pending) + count(entry?.fetching) + count(entry?.building);
        retrying += count(entry?.retrying);
        failed += count(entry?.failed) + count(entry?.fetchFailed) + count(entry?.buildFailed);
    }

    const state = (pending > 0 || retrying > 0)
        ? 'loading'
        : (failed > 0 ? 'failed' : 'ready');

    return { state, pending, retrying, failed };
}

// Tooltip text. Says what is outstanding rather than just that something is — the overlay is the
// place for the full breakdown, this is the one-line version.
//
// The translator is injected rather than imported so this module stays pure and
// free of the i18n module's window listener: callers in the browser pass t()
// from core/i18n.js, tests pass a stub and assert on keys and counts.
export function worldStatusLabel(status, translate) {
    if (!status) return '';
    const t = typeof translate === 'function' ? translate : ((key) => key);
    if (status.state === 'loading') {
        const parts = [];
        if (status.pending > 0) parts.push(t('status.loadingPending', { n: status.pending }));
        if (status.retrying > 0) parts.push(t('status.loadingRetrying', { n: status.retrying }));
        if (status.failed > 0) parts.push(t('status.loadingFailed', { n: status.failed }));
        return t('status.loading', { parts: parts.join(', ') });
    }
    if (status.state === 'failed') {
        return t('status.partial', { n: status.failed });
    }
    return t('status.ready');
}
