// First-party, fire-and-forget game telemetry. Answers "did anyone actually play"
// with a handful of funnel events (session → mode opened → campaign started →
// scenes → completed), not page views.
//
// Cost and failure contract, in this order of importance:
//   - track() is an array push. No network, no serialization, no timer churn on the
//     hot path; flushes happen off the frame on a timer and on page hide.
//   - Delivery uses navigator.sendBeacon (queued by the browser, survives unload,
//     never awaited) with a keepalive fetch fallback whose promise is dropped.
//   - Nothing here can throw into the game: every entry point is wrapped, the queue
//     is bounded (oldest dropped), and a failed send is simply lost.
//   - Cookieless and PII-free: the session id is random per page load and never
//     persisted, so no consent banner is implied. ?telemetry=0 opts out.
//
// The queue and the campaign-state diff are pure and unit-tested; the browser
// wiring (installTelemetry) only subscribes to events the app already dispatches
// (station3d:visibility, station3d:campaign-state, station3d:mode-load-error), so
// it needs no hooks inside the campaign or mode code.

import { getApiBase } from './api.js';

export const TELEMETRY_MAX_QUEUE = 200;
export const TELEMETRY_MAX_BATCH = 50;
export const TELEMETRY_FLUSH_MS = 10_000;

/**
 * Bounded event queue with timer-driven batching. `send(events)` is the only
 * side effect and is called inside try/catch; its return value is ignored.
 */
export function createTelemetryQueue({
    send,
    now = () => Date.now(),
    maxQueue = TELEMETRY_MAX_QUEUE,
    maxBatch = TELEMETRY_MAX_BATCH,
    flushEvery = TELEMETRY_FLUSH_MS,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
} = {}) {
    const queue = [];
    let timer = null;
    let dropped = 0;

    function arm() {
        if (timer !== null) return;
        try {
            timer = schedule(() => { timer = null; flush('timer'); }, flushEvery);
        } catch { timer = null; }
    }

    function track(e, p) {
        try {
            if (!e) return;
            queue.push(p == null ? { e: String(e), t: now() } : { e: String(e), t: now(), p });
            if (queue.length > maxQueue) { queue.shift(); dropped += 1; }
            arm();
        } catch { /* never surface */ }
    }

    // Drains up to maxBatch per send; re-arms when a backlog remains. `reason` is
    // informational for debugging and is not transmitted.
    function flush(reason = 'manual') {
        try {
            if (timer !== null) { try { cancel(timer); } catch { /* ignore */ } timer = null; }
            if (queue.length === 0) return 0;
            const batch = queue.splice(0, maxBatch);
            try { send(batch, reason); } catch { /* lost, by design */ }
            if (queue.length > 0) arm();
            return batch.length;
        } catch { return 0; }
    }

    return {
        track,
        flush,
        size: () => queue.length,
        droppedCount: () => dropped,
    };
}

/**
 * Pure: derive funnel events from two consecutive campaign-state payloads
 * (the `detail` of station3d:campaign-state — the serializable run, or null).
 */
export function deriveCampaignEvents(prev, next) {
    const out = [];
    const id = (s) => (s && s.campaignId) || null;
    if (!prev && next) {
        out.push({ e: 'campaign_start', p: {
            campaignId: id(next),
            sceneId: next.currentSceneId || null,
            checkpointId: next.checkpointId || null,
            resumed: Array.isArray(next.completedScenes) && next.completedScenes.length > 0,
        } });
        return out;
    }
    if (prev && !next) {
        out.push({ e: 'campaign_exit', p: { campaignId: id(prev), sceneId: prev.currentSceneId || null } });
        return out;
    }
    if (prev && next) {
        if (next.currentSceneId && next.currentSceneId !== prev.currentSceneId) {
            out.push({ e: 'scene_enter', p: { campaignId: id(next), sceneId: next.currentSceneId } });
        }
        if (next.completed === true && prev.completed !== true) {
            out.push({ e: 'campaign_complete', p: { campaignId: id(next) } });
        }
    }
    return out;
}

function randomSessionId() {
    try {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return `s${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
    }
}

/**
 * Browser wiring. Idempotent; returns the handle (also on window.__s3dTelemetry
 * for debugging). Safe to call where `window` is absent — it returns null.
 */
export function installTelemetry({
    url = null,                  // string or () => string; defaults to <apiBase>/telemetry
    win = typeof window !== 'undefined' ? window : null,
    sessionId = null,
} = {}) {
    try {
        if (!win || !win.addEventListener) return null;
        if (win.__s3dTelemetry) return win.__s3dTelemetry;
        const search = String((win.location && win.location.search) || '');
        if (/[?&]telemetry=0(?:&|$)/.test(search)) return null;

        const session = sessionId || randomSessionId();
        const resolveUrl = () => {
            try {
                if (typeof url === 'function') return url();
                if (typeof url === 'string' && url) return url;
                return `${getApiBase()}/telemetry`;
            } catch { return '/api/telemetry'; }
        };

        const send = (events) => {
            const target = resolveUrl();
            const body = JSON.stringify({ session, events });
            // text/plain is CORS-safelisted, so a beacon (or the fallback) never
            // needs a preflight even when the API is on another origin in dev.
            const nav = win.navigator;
            if (nav && typeof nav.sendBeacon === 'function') {
                try {
                    if (nav.sendBeacon(target, new Blob([body], { type: 'text/plain' }))) return;
                } catch { /* fall through */ }
            }
            try {
                const f = win.fetch && win.fetch(target, {
                    method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' },
                });
                if (f && typeof f.catch === 'function') f.catch(() => {});
            } catch { /* lost */ }
        };

        const queue = createTelemetryQueue({ send });
        const handle = Object.freeze({
            sessionId: session,
            track: queue.track,
            flush: queue.flush,
            size: queue.size,
        });
        win.__s3dTelemetry = handle;

        queue.track('session_start', { page: String((win.location && win.location.pathname) || '') });

        win.addEventListener('station3d:visibility', (ev) => {
            try {
                const d = (ev && ev.detail) || {};
                queue.track(d.active ? 'mode_open' : 'mode_close', { mode: d.mode || 'static' });
            } catch { /* ignore */ }
        });

        win.addEventListener('station3d:mode-load-error', (ev) => {
            try { queue.track('mode_load_error', { mode: (ev && ev.detail && ev.detail.mode) || null }); } catch { /* ignore */ }
        });

        let lastCampaignState = null;
        win.addEventListener('station3d:campaign-state', (ev) => {
            try {
                const next = (ev && ev.detail) || null;
                for (const item of deriveCampaignEvents(lastCampaignState, next)) queue.track(item.e, item.p);
                lastCampaignState = next ? {
                    campaignId: next.campaignId,
                    currentSceneId: next.currentSceneId,
                    completed: next.completed,
                    checkpointId: next.checkpointId,
                    completedScenes: next.completedScenes,
                } : null;
            } catch { /* ignore */ }
        });

        // Hidden tab: get what we have out now (a beacon survives the tab closing).
        // pagehide: the session is over; say so and flush.
        if (win.document && win.document.addEventListener) {
            win.document.addEventListener('visibilitychange', () => {
                try { if (win.document.visibilityState === 'hidden') queue.flush('hidden'); } catch { /* ignore */ }
            });
        }
        win.addEventListener('pagehide', () => {
            try { queue.track('session_end'); queue.flush('pagehide'); } catch { /* ignore */ }
        });

        return handle;
    } catch {
        return null;
    }
}
