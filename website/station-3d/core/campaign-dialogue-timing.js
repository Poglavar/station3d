// Pure timing decisions for authored dialogue holds.
export function campaignDialoguePauseElapsed({ startedAtMs, nowMs, pauseBeforeMs = 0 } = {}) {
    const start = Number(startedAtMs);
    const now = Number(nowMs);
    const pause = Number(pauseBeforeMs);
    if (!Number.isFinite(start) || !Number.isFinite(now) || !Number.isFinite(pause)) return true;
    return now - start >= Math.max(0, pause);
}
