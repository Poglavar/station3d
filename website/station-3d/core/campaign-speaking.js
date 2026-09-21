// Contract between the campaign dialogue UI and the world's actor layer: which
// actor is speaking, for how long, and in what mood. Pure, so both sides and
// the estimate itself are testable without a browser.

export const CAMPAIGN_ACTOR_SPEAKING_EVENT = 'station3d:campaign-actor-speaking';

// A voiced beat is ended by its audio; this cap only bounds a lost end event.
export const MAX_SPEAKING_S = 30;

/** Seconds a text-only beat is mouthed: ~14 characters a second, between a short beat and a long one. */
export function speakingSeconds(text) {
    const length = typeof text === 'string' ? text.trim().length : 0;
    if (length === 0) return 0;
    return Math.max(1.5, Math.min(12, length / 14));
}

export function speakingEventDetail({ actorId, seconds, mood = null } = {}) {
    if (typeof actorId !== 'string' || actorId.length === 0) return null;
    return {
        actorId,
        seconds: Number.isFinite(seconds) ? Math.max(0, Math.min(MAX_SPEAKING_S, seconds)) : 0,
        mood: typeof mood === 'string' && mood.length > 0 ? mood : null,
    };
}

// Simulation time is intentionally zero while a dialogue holds the player,
// but faces are presentation: they keep blinking, mouthing and nodding on the
// renderer clock. Clamp wall-clock gaps so returning from the background never
// jumps an animation by seconds.
export function campaignPresentationDeltaSeconds({
    simulationDt,
    nowMs,
    previousNowMs,
} = {}) {
    if (typeof simulationDt === 'number' && Number.isFinite(simulationDt) && simulationDt > 0) {
        return Math.min(0.05, simulationDt);
    }
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)
        || typeof previousNowMs !== 'number' || !Number.isFinite(previousNowMs)) return 0;
    return Math.max(0, Math.min(0.05, (nowMs - previousNowMs) / 1000));
}

// Sent once for a staged dialogue shot, rather than tracking the camera per frame.
export const CAMPAIGN_ACTOR_ATTENTION_EVENT = 'station3d:campaign-dialogue-attention';
