// The campaign scene readiness watchdog. A chapter whose level is measurably
// still being built — the engine's activity counter moving, pack bytes
// arriving, packets uploading — is never failed at a fixed deadline: the
// finale's drive corridor took over two minutes on a loaded laptop and was
// still climbing when a 125 s timer cut it off (four times in a row,
// 2026-09-10). A scene that stops reporting fails after `stallMs`, and a
// pathological trickle after `capMs`, so a broken release still surfaces.
// Pure: the adapter supplies the clock, the timers, the poll and the events.

export const CAMPAIGN_READY_STALL_MS = 60_000;
export const CAMPAIGN_READY_CAP_MS = 300_000;
export const CAMPAIGN_READY_POLL_MS = 2_000;

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function ratio(part, whole) {
    const total = finiteOrNull(whole);
    const done = finiteOrNull(part);
    if (total === null || total <= 0 || done === null) return null;
    return Math.max(0, Math.min(1, done / total));
}

// One monotonic progress value per event stream a loading chapter emits. The
// world hold's bar is a fraction in [0, 1]. A pack download is its own
// fraction, and the build that follows it is shifted to [1, 2] so the hand-over
// from download to build never reads as progress lost. Unknown shapes are null
// and count as no progress.
export function campaignReadyProgressValue(type, detail = {}) {
    if (type === 'station3d:world-load-progress') return ratio(detail?.fraction, 1);
    if (type !== 'station3d:campaign-pack-progress') return null;
    if (detail?.phase === 'build') {
        const built = ratio(detail.uploadedPackets, detail.totalPackets);
        return built === null ? null : 1 + built;
    }
    const bytes = ratio(detail?.loadedBytes, detail?.totalBytes);
    if (bytes !== null) return bytes;
    return ratio(detail?.loadedChunks, detail?.totalChunks);
}

// When does a waiting scene give up? Never while progress keeps arriving
// within `stallMs`, and never past `capMs` from the start.
export function planCampaignReadyDeadline({
    startedAtMs,
    lastProgressAtMs,
    nowMs,
    stallMs = CAMPAIGN_READY_STALL_MS,
    capMs = CAMPAIGN_READY_CAP_MS,
} = {}) {
    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    const sinceProgressMs = Math.max(0, nowMs - lastProgressAtMs);
    if (elapsedMs >= capMs) return { expired: true, reason: 'cap', elapsedMs, nextCheckMs: 0 };
    if (sinceProgressMs >= stallMs) return { expired: true, reason: 'stall', elapsedMs, nextCheckMs: 0 };
    return {
        expired: false,
        reason: null,
        elapsedMs,
        nextCheckMs: Math.max(1, Math.min(stallMs - sinceProgressMs, capMs - elapsedMs)),
    };
}

// A running watchdog. `progress(key, value)` counts only an increase within
// its own stream; `poll()` is read on every tick and fed as the 'poll' stream
// (the engine's activity counter); `dispose()` stops it. `onExpire(reason,
// elapsedMs)` fires at most once.
export function createCampaignReadyWatchdog({
    stallMs = CAMPAIGN_READY_STALL_MS,
    capMs = CAMPAIGN_READY_CAP_MS,
    pollMs = CAMPAIGN_READY_POLL_MS,
    poll = null,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id),
    onExpire = () => {},
} = {}) {
    const startedAtMs = now();
    let lastProgressAtMs = startedAtMs;
    const lastValues = new Map();
    let timer = null;
    let done = false;

    const noteProgress = (key, value) => {
        if (done) return false;
        const number = finiteOrNull(value);
        if (number === null) return false;
        const previous = lastValues.get(key);
        if (previous !== undefined && number <= previous) return false;
        lastValues.set(key, number);
        lastProgressAtMs = now();
        return true;
    };

    const arm = () => {
        if (done) return;
        if (timer !== null) clearTimer(timer);
        timer = null;
        if (typeof poll === 'function') {
            let value = null;
            try { value = poll(); } catch { value = null; }
            noteProgress('poll', value);
        }
        const plan = planCampaignReadyDeadline({ startedAtMs, lastProgressAtMs, nowMs: now(), stallMs, capMs });
        if (plan.expired) {
            done = true;
            onExpire(plan.reason, plan.elapsedMs);
            return;
        }
        const delayMs = typeof poll === 'function'
            ? Math.max(1, Math.min(plan.nextCheckMs, pollMs))
            : plan.nextCheckMs;
        timer = setTimer(arm, delayMs);
    };

    arm();
    return {
        progress(key, value) {
            if (!noteProgress(key, value)) return false;
            arm();
            return true;
        },
        dispose() {
            done = true;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
        get expired() { return done && timer === null; },
    };
}
