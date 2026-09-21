// What the campaign pack bake is doing right now, for the on-screen indicator.
// A bake spends most of its life waiting — for the corridor to build, then for
// every streaming queue to settle — and a wait with no clock and no reason is
// indistinguishable from a stall. Every phase names itself, the elapsed clock
// ticks, and whatever still blocks settlement is listed with its count.

import { finiteOrNull } from './math.js';

export const CAMPAIGN_BAKE_PHASES = Object.freeze([
    'corridor',
    'ready',
    'settling',
    'fixed-point',
    'capturing',
    'encoding',
    'done',
    'failed',
]);

export function formatBakeElapsed(elapsedMs) {
    const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

// The pill lists the heaviest blockers, not every queue with one item left:
// six names is a glance, twenty is a log line.
const BLOCKING_SUMMARY_LIMIT = 6;

function blockingSummary(blocking) {
    if (!Array.isArray(blocking)) return '';
    const parts = blocking
        .map((entry) => {
            const label = String(entry?.label || entry?.id || entry?.name || '').trim();
            const count = finiteOrNull(entry?.pending ?? entry?.count ?? entry?.active);
            if (!label) return '';
            // A queue whose current item has stopped progressing names it: that
            // is the one line that tells a wedge from a slow drain.
            const stalled = typeof entry?.stalled === 'string' && entry.stalled ? ` ⚠ ${entry.stalled}` : '';
            return (count === null ? label : `${label} ${count}`) + stalled;
        })
        .filter(Boolean);
    const shown = parts.slice(0, BLOCKING_SUMMARY_LIMIT);
    const hidden = parts.length - shown.length;
    return hidden > 0 ? `${shown.join(' · ')} · +${hidden}` : shown.join(' · ');
}

export function campaignBakeStatus({ phase, elapsedMs, blocking, detail } = {}) {
    const known = CAMPAIGN_BAKE_PHASES.includes(phase) ? phase : CAMPAIGN_BAKE_PHASES[0];
    const text = typeof detail === 'string' && detail.trim() ? detail.trim() : blockingSummary(blocking);
    return Object.freeze({
        phase: known,
        elapsed: formatBakeElapsed(elapsedMs),
        detail: text,
    });
}
