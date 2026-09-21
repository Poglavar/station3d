// Bounded render-clock delay for a failure card, independent of paused physics.

import { campaignPresentationDeltaSeconds } from './campaign-speaking.js';

export const MAX_FAILURE_PRESENTATION_DELAY_MS = 3000;

// Render-clock delay only: canceling it never touches campaign state or pause.
export function createFailurePresentationDelay({ delayMs = 0, setFrameHandler, reveal, now = () => performance.now() } = {}) {
    const delay = Math.max(0, Math.min(MAX_FAILURE_PRESENTATION_DELAY_MS, Number(delayMs) || 0));
    if (delay === 0) return null;
    let active = true;
    let previousNowMs = now();
    let elapsedMs = 0;
    const finish = () => {
        if (!active) return;
        active = false;
        setFrameHandler?.(null);
        reveal?.();
    };
    const update = ({ nowMs = now() } = {}) => {
        if (!active) return null;
        elapsedMs += campaignPresentationDeltaSeconds({ simulationDt: 0, nowMs, previousNowMs }) * 1000;
        previousNowMs = nowMs;
        if (elapsedMs >= delay) finish();
        return null;
    };
    if (typeof setFrameHandler !== 'function' || !setFrameHandler(update)) {
        active = false;
        setFrameHandler?.(null);
        reveal?.();
        return null;
    }
    return Object.freeze({
        cancel() {
            if (!active) return;
            active = false;
            setFrameHandler(null);
        },
    });
}
