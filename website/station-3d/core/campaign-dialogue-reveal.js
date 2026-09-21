// How much of a spoken line is on screen. A dialogue line arrives at the pace
// it is heard instead of landing whole while the actor is still on their first
// sentence, and the player may answer at any moment — answering completes the
// reveal at once. Pure: ui/campaign-ui.js feeds it a clock and draws the
// prefix it returns.

import { speakingSeconds } from './campaign-speaking.js';

// Below this a reveal is a flicker, not a reading pace.
const MIN_REVEAL_MS = 400;
// The last syllables still sound as the final word lands: text that finishes
// exactly with the audio reads as lagging behind the voice.
const PACE = 0.92;

// How long the whole line should take: a recorded clip's own length when the
// player knows it, the reading estimate otherwise.
export function dialogueRevealDurationMs({ clipSeconds = null, text = '' } = {}) {
    const clip = Number(clipSeconds);
    const seconds = Number.isFinite(clip) && clip > 0 ? clip : speakingSeconds(text);
    return Math.max(MIN_REVEAL_MS, seconds * 1000 * PACE);
}

// The visible prefix at `elapsedMs`. Whole words only: a prefix cut mid-word
// reads as a typo rather than as speech, so the word currently being spoken is
// shown complete.
export function revealedDialogueText(text, elapsedMs, totalMs) {
    const full = typeof text === 'string' ? text : '';
    if (full.length === 0) return Object.freeze({ text: '', fraction: 1, done: true });
    const total = Number.isFinite(totalMs) && totalMs > MIN_REVEAL_MS ? totalMs : MIN_REVEAL_MS;
    const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    const fraction = Math.min(1, elapsed / total);
    if (fraction >= 1) return Object.freeze({ text: full, fraction: 1, done: true });
    let end = Math.floor(full.length * fraction);
    if (end <= 0) return Object.freeze({ text: '', fraction, done: false });
    while (end < full.length && !/\s/.test(full[end])) end += 1;
    return Object.freeze({ text: full.slice(0, end), fraction, done: end >= full.length });
}
