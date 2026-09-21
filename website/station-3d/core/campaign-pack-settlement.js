// Release-authoring gate. The ordinary world-ready signal is intentionally a
// player-facing soft boundary; an immutable campaign pack must instead wait
// until every static producer has stopped fetching, decoding and publishing.

const NON_BLOCKING_LABELS = new Set([
    'ambient-trains',
    'boarding',
    'campaign-actors',
    'campaign-markers',
    'campaign-rail-vehicles',
    'cars',
    'gta-special-vehicles',
    'mg-nests',
    'other-trams',
    'pedestrians',
    'traffic',
]);

const ACTIVE_FIELDS = Object.freeze([
    'pending',
    'jobs',
    'fetching',
    'building',
    'retrying',
]);

const FAILURE_FIELDS = Object.freeze([
    'fetchFailed',
    'buildFailed',
    'failed',
    'conflicts',
    'missingClaims',
    'invalidClaims',
    'staleRejected',
]);

function positive(entry, fields) {
    return fields.some(field => Number(entry?.[field]) > 0);
}

export function campaignPackBlockingActivity(entries = []) {
    return (Array.isArray(entries) ? entries : []).filter(entry => (
        entry?.label
        && !NON_BLOCKING_LABELS.has(String(entry.label))
        && (positive(entry, ACTIVE_FIELDS) || positive(entry, FAILURE_FIELDS))
    ));
}

function activitySummary(entries) {
    return entries.slice(0, 6).map((entry) => {
        const work = ACTIVE_FIELDS.reduce(
            (sum, field) => sum + Math.max(0, Number(entry?.[field]) || 0),
            0,
        );
        return `${entry.label}:${work}`;
    }).join(', ');
}

export async function waitForCampaignPackSettlement({
    readActivity,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs = 20 * 60_000,
    stableMs = 2_000,
    pollMs = 250,
    onProgress = null,
} = {}) {
    if (typeof readActivity !== 'function') {
        throw new TypeError('Campaign pack settlement requires an activity reader');
    }
    const startedAt = now();
    let idleSince = null;
    while (true) {
        const blocking = campaignPackBlockingActivity(readActivity());
        const failures = blocking.filter(entry => positive(entry, FAILURE_FIELDS));
        const active = blocking.filter(entry => positive(entry, ACTIVE_FIELDS));
        onProgress?.(blocking);
        // Stream readers can expose a failed attempt while the same item is
        // queued for retry. Treat it as fatal only after all recoverable work
        // has stopped; a successful retry clears it before this point.
        if (failures.length && active.length === 0) {
            throw new Error(`Campaign pack sources failed: ${activitySummary(failures)}`);
        }
        const currentTime = now();
        if (blocking.length === 0) {
            idleSince ??= currentTime;
            if (currentTime - idleSince >= stableMs) return true;
        } else {
            idleSince = null;
        }
        if (currentTime - startedAt >= timeoutMs) {
            throw new Error(
                `Campaign pack authoring did not settle after ${Math.round(timeoutMs / 1000)}s`
                + (blocking.length ? ` (${activitySummary(blocking)})` : ''),
            );
        }
        await sleep(pollMs);
    }
}
