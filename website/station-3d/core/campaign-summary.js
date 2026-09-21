// What the end card can honestly say about a finished run. Pure: the UI renders
// these numbers, the director owns the run, and a test can pin the arithmetic
// without a browser.

// Duration is only reported for a run that plausibly WAS the playthrough. A
// checkpoint deep link seeds a fresh run seconds before the ending, and printing
// "finished in 40 seconds" over a 60–90 minute campaign would be a lie told by
// arithmetic. Below the floor the card simply omits the time.
const MIN_REPORTABLE_DURATION_MS = 5 * 60 * 1000;

// Chapters and time only. Objective and scene ratios were dropped: the
// definition holds failure films and optional objectives no successful run can
// earn, and a checkpoint-seeded run inherits partial credit, so a finished
// campaign read "31/37" and "6/11" — numbers that looked like an unfinished
// game and meant nothing to the player (2026-09-10 audit).
export function campaignRunSummary(definition, run) {
    const chapters = new Set();
    for (const scene of definition?.scenes || []) {
        const chapter = Number(scene?.chapter);
        if (Number.isFinite(chapter)) chapters.add(chapter);
    }
    const startedAt = Number(run?.startedAt);
    const completedAt = Number(run?.completedAt);
    const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
        && completedAt > startedAt
        ? completedAt - startedAt
        : null;
    return {
        chapters: chapters.size,
        // Null rather than a small number: see MIN_REPORTABLE_DURATION_MS.
        durationMs: elapsedMs !== null && elapsedMs >= MIN_REPORTABLE_DURATION_MS
            ? elapsedMs
            : null,
    };
}

// "1 h 24 min" / "38 min". Croatian and English share the shape, so the caller
// passes the two unit words rather than this module reaching for i18n.
export function formatCampaignDuration(durationMs, { hour = 'h', minute = 'min' } = {}) {
    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes} ${minute}`;
    if (!minutes) return `${hours} ${hour}`;
    return `${hours} ${hour} ${minutes} ${minute}`;
}
