// Serializes session teardown and cancels stale async opens. Browser history
// and DOM are injected by the host so navigation races are testable in Node.
export function createExplorerSessionController({
    loadEngine, prepareOptions, showMap, showLoading, showError, campaignEnabled,
}) {
    let generation = 0;
    let engine = null;
    let campaignOpen = false;
    let abortController = null;
    let closing = Promise.resolve();

    async function closeSession() {
        if (!engine) return;
        try {
            if (campaignOpen) {
                campaignOpen = false;
                await engine.campaigns.exit();
            }
        } finally {
            engine.close();
        }
    }

    async function transition(request) {
        const current = ++generation;
        const isCurrent = () => current === generation;
        abortController?.abort();
        const abort = new AbortController();
        abortController = abort;
        showLoading(request.kind !== 'map' && request.kind !== 'invalid');
        closing = closing.catch(() => {}).then(closeSession);
        try {
            await closing;
            if (!isCurrent()) return false;
            if (request.kind === 'map' || request.kind === 'invalid') {
                await showMap({ isCurrent });
                if (request.kind === 'invalid' && isCurrent()) showError(new Error(request.error), 'route');
                return isCurrent();
            }
            if (request.kind !== 'gta' && !campaignEnabled()) throw new Error('campaign-unavailable');
            const loaded = await loadEngine();
            if (!isCurrent()) return false;
            engine = loaded;
            if (request.kind === 'gta') {
                const options = await prepareOptions(request, { signal: abort.signal });
                if (!isCurrent()) return false;
                if (!engine.openGta(request.lat, request.lon, options)) throw new Error('open-refused');
            } else {
                campaignOpen = true;
                const opening = Promise.resolve().then(() => request.kind === 'checkpoint'
                    ? engine.campaigns.startCheckpoint(request.campaignId, request.checkpointId)
                    : engine.campaigns.openMenu());
                // Campaign startup owns asynchronous scene changes. The next
                // navigation must let it settle before tearing that scene down.
                closing = opening.catch(() => {});
                await opening;
            }
            // A free-roam world keeps the loading screen until it is built; the
            // engine drops it then (modes/cab.js). A campaign route has finished
            // opening here: the chapter is ready or the menu is up.
            if (isCurrent() && request.kind !== 'gta') showLoading(false);
            return isCurrent();
        } catch (error) {
            // A rejected cleanup must not poison the next navigation attempt.
            if (!isCurrent() || error.name === 'AbortError') return false;
            closing = closing.catch(() => {}).then(closeSession);
            await closing.catch(() => {});
            if (!isCurrent()) return false;
            showLoading(false);
            await showMap({ isCurrent });
            if (isCurrent()) showError(error, 'session');
            return false;
        }
    }

    return { transition, isCampaignOpen: () => campaignOpen };
}
